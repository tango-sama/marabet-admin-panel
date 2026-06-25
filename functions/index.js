/**
 * Bazar Merabet — Cloud Functions
 *
 * createDeliveryOnFulfill:
 *   Firestore trigger on orders/{orderId}. When an order flips to fulfilled:true
 *   (the 🚚 button in the admin panel), it creates a parcel in Yalidine and writes
 *   the tracking number / label URL back onto the order document.
 *
 *   The Yalidine API ID + token are entered in the admin panel (Settings → Delivery)
 *   and stored in the Firestore doc settings/delivery. Firestore rules make that doc
 *   write-only for clients, so only this function (Admin SDK) can read the token.
 *
 * Setup (run once, from the project root):
 *   firebase deploy --only functions
 *   Then in the admin panel: Settings → Delivery — Yalidine → paste API ID + Token → Save.
 */

const {onDocumentUpdated} = require("firebase-functions/v2/firestore");
const {onSchedule} = require("firebase-functions/v2/scheduler");
const {onCall, HttpsError} = require("firebase-functions/v2/https");
const {setGlobalOptions} = require("firebase-functions/v2");
const logger = require("firebase-functions/logger");
const {initializeApp} = require("firebase-admin/app");
const {getFirestore, FieldValue} = require("firebase-admin/firestore");

initializeApp();
const db = getFirestore();

// A Firestore (v2) trigger must run in the SAME region as your Firestore database.
// us-central1 matches the common "nam5" default. If `firebase deploy` complains about a
// region/location mismatch, change this to match Firestore (Console → Firestore → ⚙ Location):
//   nam5/us  → "us-central1"   |   eur3/europe → "europe-west1"
setGlobalOptions({region: "us-central1", maxInstances: 5});

const YALIDINE_URL = "https://api.yalidine.app/v1/parcels/";

// price / declared_value must be integers between 0 and 150000 (Yalidine constraint)
function clampAmount(n) {
  const v = Math.round(Number(n) || 0);
  return Math.max(0, Math.min(150000, v));
}

// "Mohamed Amine" -> {firstname:"Mohamed", familyname:"Amine"}; single word duplicates.
function splitName(full) {
  const name = String(full || "").trim();
  const i = name.indexOf(" ");
  if (i < 0) return {firstname: name || "Client", familyname: name || "Client"};
  return {firstname: name.slice(0, i), familyname: name.slice(i + 1)};
}

exports.createDeliveryOnFulfill = onDocumentUpdated(
    {document: "orders/{orderId}"},
    async (event) => {
      const before = event.data.before.data() || {};
      const after = event.data.after.data() || {};
      const ref = event.data.after.ref;

      // Only act on the false -> true transition, and never ship twice.
      const justFulfilled = after.fulfilled === true && before.fulfilled !== true;
      if (!justFulfilled) return;
      if (after.deliveryTracking) return;

      // Route to the carrier the customer chose on the order form (default Yalidine).
      if (String(after.deliveryCompany || "yalidine") === "noest") {
        return createNoestDelivery(after, ref, event.params.orderId);
      }
      if (String(after.deliveryCompany || "yalidine") === "zrexpress") {
        return createZrExpressDelivery(after, ref, event.params.orderId);
      }

      // Credentials come from settings/delivery (set in admin → Settings → Delivery).
      const credSnap = await db.doc("settings/delivery").get();
      const cred = credSnap.exists ? credSnap.data() : {};
      if (!cred.apiId || !cred.apiToken) {
        await ref.update({deliveryStatus: "Failed", deliveryError: "Yalidine API keys not set in Settings → Delivery"});
        logger.error("Yalidine keys missing in settings/delivery");
        return;
      }

      const {firstname, familyname} = splitName(after.customer);
      // contact_phone must start with 0 (e.g. 0550123456). Strip non-digits; re-add 0 if missing.
      let phone = String(after.phone || "").replace(/[^\d]/g, "");
      if (phone && phone[0] !== "0") phone = "0" + phone;
      // COD = goods value to collect from the receiver. freeshipping:false means the receiver
      // also pays Yalidine's delivery fee on top, so collect the product subtotal here.
      const amount = clampAmount(after.subtotal || after.total || after.price || 0);

      // Yalidine wants an ARRAY of parcels. order_id must be unique per request.
      // All of these fields are REQUIRED by the create endpoint (strict types).
      const parcel = {
        order_id: String(after.num || event.params.orderId),
        from_wilaya_name: cred.fromWilaya || "Touggourt",
        firstname: firstname,
        familyname: familyname,
        contact_phone: phone,
        address: after.address || [after.commune, after.wilaya].filter(Boolean).join(", "),
        to_commune_name: after.commune || "",
        to_wilaya_name: after.wilayaFr || after.wilaya || "",
        product_list: (after.noteName && String(after.noteName).trim()) ||
            ([after.product, after.brand, after.color, after.size]
                .filter(Boolean).join(" / ") + (after.qty ? ` x${after.qty}` : "")),
        price: amount,
        do_insurance: false,
        declared_value: amount,
        length: 30, width: 20, height: 12, weight: 1, // shoebox defaults — tune as needed
        freeshipping: false,
        is_stopdesk: false, // stopdesk needs a stopdesk_id lookup; defaulting to home delivery
        has_exchange: false,
      };

      try {
        const res = await fetch(YALIDINE_URL, {
          method: "POST",
          headers: {
            "X-API-ID": cred.apiId,
            "X-API-TOKEN": cred.apiToken,
            "Content-Type": "application/json",
          },
          body: JSON.stringify([parcel]),
        });
        const data = await res.json();
        // Response is keyed by our order_id.
        const result = data[parcel.order_id] || Object.values(data || {})[0] || {};

        if (res.ok && result && result.success) {
          await ref.update({
            deliveryProvider: "Yalidine",
            deliveryTracking: result.tracking || null,
            deliveryLabel: result.label || result.labels || null,
            deliveryStatus: "Created",
            deliveryError: null,
            deliveryAt: FieldValue.serverTimestamp(),
          });
          logger.info(`Yalidine parcel created for ${parcel.order_id}: ${result.tracking}`);
        } else {
          const msg = (result && (result.message || JSON.stringify(result))) || `HTTP ${res.status}`;
          await ref.update({deliveryStatus: "Failed", deliveryError: msg});
          logger.error(`Yalidine create failed for ${parcel.order_id}: ${msg}`);
        }
      } catch (e) {
        await ref.update({deliveryStatus: "Failed", deliveryError: String(e)});
        logger.error(`Yalidine request error for ${parcel.order_id}:`, e);
      }
    },
);

// Yalidine statuses that mean the parcel's journey is over — stop polling these.
const TERMINAL_STATUSES = [
  "Livré", "Retourné au vendeur", "Annulé", "Echange échoué",
];

/**
 * syncDeliveryStatuses:
 *   Every few hours, fetch the live last_status of every shipped-but-not-finished
 *   order from Yalidine (GET /v1/parcels/?tracking=...,...) and write it back so the
 *   admin Orders tab always shows where each parcel is.
 */
exports.syncDeliveryStatuses = onSchedule("every 3 hours", async () => {
  const cred = (await db.doc("settings/delivery").get()).data() || {};
  if (!cred.apiId || !cred.apiToken) {
    logger.warn("syncDeliveryStatuses: Yalidine keys not set; skipping");
    return;
  }

  // Orders that have a tracking number and aren't in a terminal status yet.
  const snap = await db.collection("orders").where("fulfilled", "==", true).get();
  const active = snap.docs.filter((d) => {
    const o = d.data();
    return o.deliveryTracking && !TERMINAL_STATUSES.includes(o.deliveryLastStatus);
  });
  if (!active.length) return;

  const headers = {"X-API-ID": cred.apiId, "X-API-TOKEN": cred.apiToken};

  // Batch the lookups (Yalidine accepts comma-separated trackings); chunk to keep URLs sane.
  for (let i = 0; i < active.length; i += 50) {
    const chunk = active.slice(i, i + 50);
    const trackings = chunk.map((d) => d.data().deliveryTracking).join(",");
    try {
      const url = `${YALIDINE_URL}?tracking=${encodeURIComponent(trackings)}&fields=tracking,last_status&page_size=50`;
      const res = await fetch(url, {headers});
      const body = await res.json();
      const rows = (body && body.data) || [];
      const statusByTracking = {};
      rows.forEach((p) => {
        statusByTracking[p.tracking] = p.last_status;
      });

      await Promise.all(chunk.map((d) => {
        const o = d.data();
        const st = statusByTracking[o.deliveryTracking];
        if (st && st !== o.deliveryLastStatus) {
          return d.ref.update({
            deliveryLastStatus: st,
            deliveryStatusAt: FieldValue.serverTimestamp(),
          });
        }
        return null;
      }));
    } catch (e) {
      logger.error("syncDeliveryStatuses chunk failed:", e);
    }
  }
});

/**
 * trackParcel (callable):
 *   On-demand status check for a single parcel from the admin's 🔄 button.
 *   Looks up the tracking in Yalidine, writes last_status back to the order, and
 *   returns it. The API token stays server-side.
 */
exports.trackParcel = onCall(async (req) => {
  const tracking = String((req.data && req.data.tracking) || "").trim();
  const orderId = String((req.data && req.data.orderId) || "").trim();
  const company = String((req.data && req.data.company) || "yalidine").trim();
  if (!tracking) throw new HttpsError("invalid-argument", "tracking is required");

  // ZRExpress: look up the parcel by its tracking number and read the current state name.
  if (company === "zrexpress") {
    const zr = (await db.doc("settings/zrexpress").get()).data() || {};
    if (!zr.tenantId || !zr.apiKey) throw new HttpsError("failed-precondition", "ZRExpress keys not set in Settings → Delivery (ZRExpress)");
    const headers = {"X-Tenant": String(zr.tenantId), "X-Api-Key": String(zr.apiKey), "Content-Type": "application/json"};
    let sBody;
    try {
      const sRes = await fetch(ZR_BASE + "/parcels/search", {
        method: "POST", headers,
        body: JSON.stringify({pageNumber: 1, pageSize: 1,
          advancedFilter: {logic: "and", filters: [{field: "trackingNumber", operator: "eq", value: tracking}]}}),
      });
      sBody = await sRes.json();
    } catch (e) {
      throw new HttpsError("unavailable", "Could not reach ZRExpress: " + String(e));
    }
    const row = ((sBody && (sBody.data || sBody.items || sBody.results)) || [])[0] || {};
    const lastStatus = (row.state && (row.state.name || row.state.stateName)) || row.stateName || null;
    if (!lastStatus) throw new HttpsError("not-found", "Parcel not found at ZRExpress");
    if (orderId) {
      await db.doc(`orders/${orderId}`).update({
        deliveryLastStatus: lastStatus, deliveryStatusAt: FieldValue.serverTimestamp(),
      }).catch(() => {});
    }
    return {tracking, lastStatus};
  }

  const cred = (await db.doc("settings/delivery").get()).data() || {};
  if (!cred.apiId || !cred.apiToken) {
    throw new HttpsError("failed-precondition", "Yalidine API keys not set in Settings → Delivery");
  }

  let body;
  try {
    const url = `${YALIDINE_URL}?tracking=${encodeURIComponent(tracking)}&fields=tracking,last_status`;
    const res = await fetch(url, {headers: {"X-API-ID": cred.apiId, "X-API-TOKEN": cred.apiToken}});
    body = await res.json();
  } catch (e) {
    throw new HttpsError("unavailable", "Could not reach Yalidine: " + String(e));
  }

  const parcel = (body && body.data && body.data[0]) || {};
  const lastStatus = parcel.last_status || null;
  if (!lastStatus) throw new HttpsError("not-found", "Parcel not found at Yalidine");

  if (orderId) {
    await db.doc(`orders/${orderId}`).update({
      deliveryLastStatus: lastStatus,
      deliveryStatusAt: FieldValue.serverTimestamp(),
    }).catch(() => {});
  }
  return {tracking, lastStatus};
});

// ───────────────────────── Yalidine geo (wilayas + communes) ─────────────────────────
const YALIDINE_BASE = "https://api.yalidine.app/v1/";

// Per-wilaya Yalidine delivery fees, keyed by wilaya id: [home, stopdesk] in DZD.
// Maintained tariff table (same as the Desert Shop), cached into Firestore (geo/fees)
// next to the wilaya/commune lists so the order form can price each wilaya correctly.
const YAL_FEES = {"1": [1400, 1200], "2": [900, 400], "3": [1050, 600], "4": [900, 400], "5": [900, 400], "6": [900, 400], "7": [1050, 600], "8": [1400, 800], "9": [750, 350], "10": [900, 400], "11": [1600, 1200], "12": [1050, 600], "13": [900, 400], "14": [900, 400], "15": [900, 400], "16": [500, 300], "17": [1050, 600], "18": [900, 400], "19": [900, 400], "20": [900, 400], "21": [900, 400], "22": [900, 400], "23": [900, 400], "24": [900, 400], "25": [900, 400], "26": [900, 400], "27": [900, 400], "28": [900, 400], "29": [900, 400], "30": [1050, 600], "31": [900, 400], "32": [1050, 600], "33": [1800, 1200], "34": [900, 400], "35": [750, 350], "36": [900, 400], "37": [900, 400], "38": [1050, 600], "39": [1800, 1200], "40": [900, 400], "41": [900, 400], "42": [750, 350], "43": [900, 400], "44": [900, 400], "45": [1050, 600], "46": [900, 400], "47": [1050, 600], "48": [900, 400], "49": [1400, 800], "50": [1800, 1200], "51": [1050, 600], "52": [1400, 800], "53": [1600, 1200], "54": [1800, 1200], "55": [1050, 600], "56": [1800, 1200], "57": [1050, 600], "58": [1050, 600]};

// Follow Yalidine's pagination (has_more + links.next) and collect every row.
async function fetchAllPages(url, headers) {
  const all = [];
  let next = url;
  for (let guard = 0; guard < 100 && next; guard++) {
    const res = await fetch(next, {headers});
    const body = await res.json();
    (body && body.data ? body.data : []).forEach((x) => all.push(x));
    next = body && body.has_more && body.links && body.links.next ? body.links.next : null;
  }
  return all;
}

// Pull wilayas + communes from Yalidine and cache them in Firestore (geo/wilayas, geo/communes)
// using Yalidine's exact names, so order-form selections always match the parcel API.
async function syncGeo() {
  const cred = (await db.doc("settings/delivery").get()).data() || {};
  if (!cred.apiId || !cred.apiToken) throw new Error("Yalidine API keys not set in Settings → Delivery");
  const headers = {"X-API-ID": cred.apiId, "X-API-TOKEN": cred.apiToken};

  const wilayas = await fetchAllPages(YALIDINE_BASE + "wilayas/?page_size=100", headers);
  const communes = await fetchAllPages(YALIDINE_BASE + "communes/?page_size=1000", headers);

  const wList = wilayas
      .filter((w) => w.is_deliverable === undefined || w.is_deliverable)
      .map((w) => ({id: w.id, name: w.name}));

  // Group deliverable commune names by wilaya_id (compact — names only).
  const byWilaya = {};
  communes.forEach((c) => {
    if (c.is_deliverable === 0 || c.is_deliverable === false) return;
    const k = String(c.wilaya_id);
    (byWilaya[k] = byWilaya[k] || []).push(c.name);
  });

  // Per-wilaya home/stopdesk fees (only for the deliverable wilayas we kept).
  const fees = {};
  wList.forEach((w) => {
    const f = YAL_FEES[String(w.id)];
    if (f) fees[String(w.id)] = {home: f[0], desk: f[1]};
  });

  await db.doc("geo/wilayas").set({list: wList, updatedAt: FieldValue.serverTimestamp()});
  await db.doc("geo/communes").set({byWilaya: byWilaya, updatedAt: FieldValue.serverTimestamp()});
  await db.doc("geo/fees").set({byId: fees, updatedAt: FieldValue.serverTimestamp()});
  logger.info(`Geo synced: ${wList.length} wilayas, ${communes.length} communes, ${Object.keys(fees).length} fee rows`);
  return {wilayas: wList.length, communes: communes.length, fees: Object.keys(fees).length};
}

// Daily refresh so the lists stay current.
exports.syncYalidineGeo = onSchedule("every 24 hours", async () => {
  try {
    await syncGeo();
  } catch (e) {
    logger.error("syncYalidineGeo failed:", e);
  }
});

// Manual trigger from the admin Settings page (first-time population / on demand).
exports.refreshYalidineGeo = onCall(async () => {
  try {
    return await syncGeo();
  } catch (e) {
    throw new HttpsError("internal", String((e && e.message) || e));
  }
});

// ═══════════════════════════ Noest carrier (app.noest-dz.com) ═══════════════════════════
const NOEST_BASE = "https://app.noest-dz.com";

/**
 * createNoestDelivery: called from the createDeliveryOnFulfill trigger when the
 * customer chose Noest. Credentials live in settings/noest = { apiToken, userGuid }
 * (write-only for clients, like settings/delivery). Noest's account already knows the
 * origin wilaya, so none is needed. Needs the numeric wilayaId saved on the order.
 */
async function createNoestDelivery(after, ref, orderId) {
  const cred = (await db.doc("settings/noest").get()).data() || {};
  const token = String(cred.apiToken || "").trim();
  const guid = String(cred.userGuid || "").trim();
  if (!token || !guid) {
    await ref.update({deliveryStatus: "Failed", deliveryError: "Noest API keys not set in Settings → Delivery (Noest)"});
    logger.error("Noest keys missing in settings/noest");
    return;
  }
  if (!after.wilayaId) {
    await ref.update({deliveryStatus: "Failed", deliveryError: "Order has no numeric wilayaId (Noest needs it)"});
    return;
  }

  const headers = {"Authorization": "Bearer " + token, "Content-Type": "application/json"};

  // Stopdesk: find a Noest station whose code starts with the destination wilaya id.
  const isDesk = String(after.deliveryType || "") === "desk";
  let stationCode = null;
  if (isDesk) {
    try {
      const dRes = await fetch(NOEST_BASE + "/api/public/desks", {headers});
      if (dRes.ok) {
        const desks = await dRes.json();
        for (const k in desks) {
          const code = String((desks[k] && desks[k].code) || "");
          const m = code.match(/^(\d+)/);
          if (m && parseInt(m[1], 10) === Number(after.wilayaId)) {
            stationCode = code;
            break;
          }
        }
      }
    } catch (e) { /* fall back to home delivery */ }
  }
  const useDesk = isDesk && !!stationCode;

  let phone = String(after.phone || "").replace(/[^\d]/g, "");
  if (phone && phone[0] !== "0") phone = "0" + phone;
  const amount = clampAmount(after.subtotal || after.total || after.price || 0);
  const productList = (after.noteName && String(after.noteName).trim()) ||
      (([after.product, after.brand, after.color, after.size]
          .filter(Boolean).join(" / ") + (after.qty ? ` x${after.qty}` : "")) || "منتجات");

  const payload = {
    user_guid: guid,
    reference: String(after.num || orderId),
    client: (String(after.customer || "").trim() || "Client").slice(0, 255),
    phone: phone,
    adresse: ([after.commune, after.wilaya].filter(Boolean).join(" - ")).slice(0, 255) || String(after.wilaya || "—"),
    wilaya_id: Number(after.wilayaId),
    commune: after.commune || "",
    montant: amount,
    produit: String(productList).slice(0, 250),
    type_id: 1,
    poids: 1,
    stop_desk: useDesk ? 1 : 0,
  };
  if (useDesk) payload.station_code = stationCode;

  try {
    const res = await fetch(NOEST_BASE + "/api/public/create/order", {method: "POST", headers, body: JSON.stringify(payload)});
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch (e) {
      body = text;
    }
    if (res.ok && body && body.success === true && body.tracking) {
      // Try to fetch a printable label URL from Noest.
      let labelUrl = null;
      try {
        const lRes = await fetch(NOEST_BASE + "/api/public/get/label/" + body.tracking, {headers});
        if (lRes.ok) {
          const lData = await lRes.json();
          labelUrl = (lData && (lData.label || lData.url || lData.link || lData.print_url)) || null;
          if (!labelUrl && typeof lData === "string") labelUrl = lData;
        }
      } catch (e) { /* label is optional — don't fail the whole delivery */ }
      await ref.update({
        deliveryProvider: "Noest",
        deliveryTracking: body.tracking,
        deliveryLabel: labelUrl,
        deliveryStatus: "Created",
        deliveryError: null,
        deliveryAt: FieldValue.serverTimestamp(),
      });
      logger.info(`Noest parcel created for ${orderId}: ${body.tracking}${labelUrl ? " (label fetched)" : ""}`);
    } else {
      const msg = (body && (body.message || JSON.stringify(body))) || `HTTP ${res.status}`;
      await ref.update({deliveryStatus: "Failed", deliveryError: msg});
      logger.error(`Noest create failed for ${orderId}: ${msg}`);
    }
  } catch (e) {
    await ref.update({deliveryStatus: "Failed", deliveryError: String(e)});
    logger.error(`Noest request error for ${orderId}:`, e);
  }
}

// ═══════════════════════════ ZRExpress carrier (api.zrexpress.app) ═══════════════════════════
const ZR_BASE = "https://api.zrexpress.app/api/v1";

// 0XXXXXXXXX → +213XXXXXXXXX (ZRExpress wants international format).
function zrPhone(p) {
  let d = String(p || "").replace(/[^\d]/g, "");
  if (d.startsWith("213")) return "+" + d;
  if (d.startsWith("0")) d = d.slice(1);
  return "+213" + d;
}

// A throwaway-but-valid UUID v4 (the parcel API requires a customerId even when we don't
// link to a stored ZRExpress customer — the spec explicitly allows a random one).
function randomUuid() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0; const v = c === "x" ? r : ((r & 0x3) | 0x8);
    return v.toString(16);
  });
}

// ─── ZRExpress shared helpers (used by createZrExpressDelivery + the zr* callables) ───
// Credentials live in settings/zrexpress (write-only for clients) → only the Admin SDK reads them.
async function zrCreds() {
  const cred = (await db.doc("settings/zrexpress").get()).data() || {};
  const tenantId = String(cred.tenantId || "").trim();
  const apiKey = String(cred.apiKey || "").trim();
  if (!tenantId || !apiKey) {
    throw new HttpsError("failed-precondition", "ZRExpress keys not set in Settings → Delivery (ZRExpress)");
  }
  return {tenantId, apiKey};
}
// Standard endpoints authenticate with X-Api-Key.
function zrHeaders(c) {
  return {"X-Tenant": c.tenantId, "X-Api-Key": c.apiKey, "Content-Type": "application/json"};
}
// Label endpoints authenticate with Authorization: Bearer — NOT X-Api-Key (per ZR spec).
function zrLabelHeaders(c) {
  return {"X-Tenant": c.tenantId, "Authorization": "Bearer " + c.apiKey, "Content-Type": "application/json"};
}
// Parse a ZR error body into a readable message (error.detail / error.errors[] / title / raw).
function zrErrMsg(body, status) {
  if (!body) return `HTTP ${status}`;
  if (typeof body === "string") return body || `HTTP ${status}`;
  if (body.detail) return String(body.detail);
  if (body.errors) {
    if (Array.isArray(body.errors)) {
      return body.errors.map((e) => (e && (e.message || e.description)) || JSON.stringify(e)).join("; ");
    }
    try { return Object.values(body.errors).reduce((a, b) => a.concat(b), []).join("; "); } catch (e) { /* fall through */ }
    return JSON.stringify(body.errors);
  }
  return String(body.title || `HTTP ${status}`);
}
// fetch + parse JSON-or-text in one go.
async function zrFetch(url, opts) {
  const res = await fetch(url, opts);
  const text = await res.text();
  let body; try { body = text ? JSON.parse(text) : null; } catch (e) { body = text; }
  return {res, body};
}
// Normalise a clientstockType to the only values ZR accepts.
function zrStock(s) {
  return (s === "local" || s === "warehouse" || s === "none") ? s : "none";
}
// Pull a single parcel row by id (or trackingNumber) from /parcels/search.
async function zrFindParcel(c, {parcelId, tracking}) {
  const filters = [];
  if (parcelId) filters.push({field: "id", operator: "eq", value: parcelId});
  else if (tracking) filters.push({field: "trackingNumber", operator: "eq", value: tracking});
  const {res, body} = await zrFetch(ZR_BASE + "/parcels/search", {
    method: "POST", headers: zrHeaders(c),
    body: JSON.stringify({pageNumber: 1, pageSize: 1, includeProducts: true,
      advancedFilter: {logic: "and", filters}}),
  });
  if (!res.ok) throw new HttpsError("unavailable", "ZRExpress search: " + zrErrMsg(body, res.status));
  return ((body && (body.items || body.data || body.results)) || [])[0] || null;
}

/**
 * createZrExpressDelivery: called from the createDeliveryOnFulfill trigger when the
 * customer chose ZRExpress. Credentials live in settings/zrexpress = { tenantId, apiKey }
 * (write-only for clients). The order must carry the ZRExpress territory UUIDs that the
 * checkout saved: cityTerritoryId (wilaya) and districtTerritoryId (commune).
 */
async function createZrExpressDelivery(after, ref, orderId) {
  const cred = (await db.doc("settings/zrexpress").get()).data() || {};
  const tenantId = String(cred.tenantId || "").trim();
  const apiKey = String(cred.apiKey || "").trim();
  if (!tenantId || !apiKey) {
    await ref.update({deliveryStatus: "Failed", deliveryError: "ZRExpress keys not set in Settings → Delivery (ZRExpress)"});
    logger.error("ZRExpress keys missing in settings/zrexpress");
    return;
  }
  const cityTerritoryId = String(after.cityTerritoryId || "").trim();
  const districtTerritoryId = String(after.districtTerritoryId || "").trim();
  if (!cityTerritoryId || !districtTerritoryId) {
    await ref.update({deliveryStatus: "Failed", deliveryError: "Order is missing ZRExpress territory UUIDs (re-run territory sync, then re-order)"});
    return;
  }

  const headers = {"X-Tenant": tenantId, "X-Api-Key": apiKey, "Content-Type": "application/json"};
  const isPickup = String(after.deliveryType || "") === "desk";

  // Pickup-point parcels need a hubId. Find a pickup hub in the destination city (same
  // idea as Noest's stop-desk lookup); if none exists, fall back to home delivery.
  let deliveryType = isPickup ? "pickup-point" : "home";
  let hubId = null;
  if (isPickup) {
    try {
      const hRes = await fetch(ZR_BASE + "/hubs/search", {
        method: "POST", headers, body: JSON.stringify({pageNumber: 1, pageSize: 200}),
      });
      const hBody = await hRes.json();
      const hubs = (hBody && (hBody.data || hBody.items || hBody.results)) || [];
      const hit = hubs.find((h) => h && h.IsPickupPoint &&
          h.address && String(h.address.cityTerritoryId) === cityTerritoryId);
      if (hit) hubId = hit.id; else deliveryType = "home";
    } catch (e) {
      deliveryType = "home"; // network/desk lookup failed → ship home so the order still goes out
    }
  }

  // Privacy note name (same behaviour as Yalidine/Noest) → falls back to the real product.
  const description = ((after.noteName && String(after.noteName).trim()) ||
      ([after.product, after.brand, after.color, after.size].filter(Boolean).join(" / ") +
          (after.qty ? ` x${after.qty}` : "")) || "منتجات").slice(0, 250);
  const amount = clampAmount(after.total || after.subtotal || after.price || 0);
  const qty = Number(after.qty) || 1;
  const unit = clampAmount((after.subtotal || amount) / qty);

  const payload = {
    customer: {
      customerId: randomUuid(),
      name: (String(after.customer || "").trim() || "Client").slice(0, 200),
      phone: {number1: zrPhone(after.phone)},
    },
    deliveryAddress: {
      cityTerritoryId,
      districtTerritoryId,
      street: String(after.address || "").slice(0, 200),
    },
    orderedProducts: [{
      productName: (String(after.product || "منتج").trim()).slice(0, 200),
      unitPrice: unit,
      quantity: qty,
      stockType: "none",
      length: 20, width: 10, height: 1, weight: 1,
    }],
    amount,
    description: description.length < 2 ? "منتجات" : description,
    deliveryType,
    externalId: String(after.num || orderId),
  };
  if (deliveryType === "pickup-point" && hubId) payload.hubId = hubId;

  try {
    const res = await fetch(ZR_BASE + "/parcels", {method: "POST", headers, body: JSON.stringify(payload)});
    const text = await res.text();
    let body; try { body = JSON.parse(text); } catch (e) { body = text; }
    if ((res.status === 201 || res.ok) && body && body.id) {
      const parcelId = body.id;
      // The create response only returns the parcel id; fetch the tracking number via search.
      let tracking = null;
      try {
        const sRes = await fetch(ZR_BASE + "/parcels/search", {
          method: "POST", headers,
          body: JSON.stringify({pageNumber: 1, pageSize: 1,
            advancedFilter: {logic: "and", filters: [{field: "externalId", operator: "eq", value: payload.externalId}]}}),
        });
        const sBody = await sRes.json();
        const row = ((sBody && (sBody.data || sBody.items || sBody.results)) || [])[0] || {};
        tracking = row.trackingNumber || null;
      } catch (e) { /* tracking will fill in via webhook/sync later */ }
      // Labels are NOT fetched/stored here: ZR label URLs are short-lived (expiring Azure
      // SAS links) and require Authorization: Bearer auth — the admin generates a FRESH one
      // on demand via the zrPrintLabel callable.
      await ref.update({
        deliveryProvider: "ZRExpress",
        deliveryParcelId: parcelId,
        deliveryTracking: tracking || parcelId,
        deliveryLabel: null,
        deliveryLocked: false,
        deliveryStatus: "Created",
        deliveryError: null,
        deliveryAt: FieldValue.serverTimestamp(),
      });
      logger.info(`ZRExpress parcel created for ${payload.externalId}: ${tracking || parcelId}`);
    } else {
      const msg = (body && (body.detail || (body.errors && JSON.stringify(body.errors)) || body.title)) ||
          (typeof body === "string" ? body : `HTTP ${res.status}`);
      await ref.update({deliveryStatus: "Failed", deliveryError: String(msg)});
      logger.error(`ZRExpress create failed for ${payload.externalId}: ${msg}`);
    }
  } catch (e) {
    await ref.update({deliveryStatus: "Failed", deliveryError: String(e)});
    logger.error(`ZRExpress request error for ${payload.externalId}:`, e);
  }
}

// Cache ZRExpress territories (wilayas + communes, with their UUIDs) into delivery_data/zrexpress.
// Shape is richer than Yalidine/Noest because parcels need the commune's UUID, not just its name:
//   { wilayas:[{id,code,ar,fr,home,pickup}], communes:{<wilayaUuid>:[{id,name,home,pickup}]}, fees:{<wilayaUuid>:{home,desk}} }
// ZRExpress exposes no fee grid, so we price by the standard Algeria wilaya `code` using YAL_FEES.
async function syncZrTerritories(cred) {
  const tenantId = String(cred.tenantId || "").trim();
  const apiKey = String(cred.apiKey || "").trim();
  if (!tenantId || !apiKey) return null;
  const headers = {"X-Tenant": tenantId, "X-Api-Key": apiKey, "Content-Type": "application/json"};
  const res = await fetch(ZR_BASE + "/territories/search", {
    method: "POST", headers,
    body: JSON.stringify({pageNumber: 1, pageSize: 5000, orderBy: ["code asc"]}),
  });
  const body = await res.json();
  const rows = (body && (body.data || body.items || body.results)) || [];

  const wilayas = [];
  const communesByW = {};
  rows.forEach((t) => {
    const del = t.delivery || {};
    if (t.level === "wilaya") {
      wilayas.push({id: t.id, code: Number(t.code) || null, ar: t.name, fr: t.name,
        home: del.hasHomeDelivery !== false, pickup: !!del.hasPickupPoint});
    } else if (t.level === "commune" && t.parentId) {
      (communesByW[t.parentId] = communesByW[t.parentId] || []).push({
        id: t.id, name: t.name, home: del.hasHomeDelivery !== false, pickup: !!del.hasPickupPoint,
      });
    }
  });
  // Keep only wilayas that can actually receive a delivery, and price them by their code.
  const fees = {};
  const usable = wilayas.filter((w) => w.home || w.pickup);
  usable.forEach((w) => {
    const f = YAL_FEES[String(w.code)];
    if (f) fees[w.id] = {home: f[0], desk: f[1]};
  });
  const communes = {};
  usable.forEach((w) => { communes[w.id] = communesByW[w.id] || []; });

  await db.doc("delivery_data/zrexpress").set({wilayas: usable, communes, fees, updatedAt: FieldValue.serverTimestamp()});
  return {wilayas: usable.length, communes: Object.values(communes).reduce((a, b) => a + b.length, 0)};
}

// ───────────── Per-carrier wilaya/commune/fee lists (delivery_data/<carrier>) ─────────────
// Arabic + French wilaya names by id; the order form shows "id - ar", parcels use fr.
const WILAYA_NAMES = {"1":["أدرار","Adrar"],"2":["الشلف","Chlef"],"3":["الأغواط","Laghouat"],"4":["أم البواقي","Oum El Bouaghi"],"5":["باتنة","Batna"],"6":["بجاية","Béjaïa"],"7":["بسكرة","Biskra"],"8":["بشار","Béchar"],"9":["البليدة","Blida"],"10":["البويرة","Bouira"],"11":["تمنراست","Tamanrasset"],"12":["تبسة","Tébessa"],"13":["تلمسان","Tlemcen"],"14":["تيارت","Tiaret"],"15":["تيزي وزو","Tizi Ouzou"],"16":["الجزائر","Alger"],"17":["الجلفة","Djelfa"],"18":["جيجل","Jijel"],"19":["سطيف","Sétif"],"20":["سعيدة","Saïda"],"21":["سكيكدة","Skikda"],"22":["سيدي بلعباس","Sidi Bel Abbès"],"23":["عنابة","Annaba"],"24":["قالمة","Guelma"],"25":["قسنطينة","Constantine"],"26":["المدية","Médéa"],"27":["مستغانم","Mostaganem"],"28":["المسيلة","M'Sila"],"29":["معسكر","Mascara"],"30":["ورقلة","Ouargla"],"31":["وهران","Oran"],"32":["البيض","El Bayadh"],"33":["إليزي","Illizi"],"34":["برج بوعريريج","Bordj Bou Arréridj"],"35":["بومرداس","Boumerdès"],"36":["الطارف","El Tarf"],"37":["تيسمسيلت","Tissemsilt"],"38":["الوادي","El Oued"],"39":["تندوف","Tindouf"],"40":["خنشلة","Khenchela"],"41":["سوق أهراس","Souk Ahras"],"42":["تيبازة","Tipaza"],"43":["ميلة","Mila"],"44":["عين الدفلى","Aïn Defla"],"45":["النعامة","Naâma"],"46":["عين تموشنت","Aïn Témouchent"],"47":["غرداية","Ghardaïa"],"48":["غليزان","Relizane"],"49":["تيميمون","Timimoun"],"50":["برج باجي مختار","Bordj Badji Mokhtar"],"51":["أولاد جلال","Ouled Djellal"],"52":["بني عباس","Béni Abbès"],"53":["عين صالح","In Salah"],"54":["عين قزام","In Guezzam"],"55":["تقرت","Touggourt"],"56":["جانت","Djanet"],"57":["المغير","El M'Ghair"],"58":["المنيعة","El Meniaa"]};
const NOEST_FEES = {"1":[1500,700],"2":[950,450],"3":[850,400],"4":[850,400],"5":[850,400],"6":[900,400],"7":[950,450],"8":[1300,650],"9":[800,350],"10":[800,350],"11":[2000,1000],"12":[850,400],"13":[950,450],"14":[950,450],"15":[800,350],"16":[800,350],"17":[950,450],"18":[900,400],"19":[850,400],"20":[950,450],"21":[900,400],"22":[950,450],"23":[800,350],"24":[900,400],"25":[900,400],"26":[800,350],"27":[950,450],"28":[850,400],"29":[950,450],"30":[800,350],"31":[800,350],"32":[1000,500],"33":[1950,950],"34":[850,400],"35":[800,350],"36":[950,450],"37":[1750,850],"38":[950,450],"39":[800,350],"40":[850,400],"41":[900,400],"42":[800,350],"43":[900,400],"44":[950,450],"45":[1100,550],"46":[950,450],"47":[950,450],"48":[950,450],"49":[1200,600],"50":[1800,1200],"51":[950,450],"52":[1450,650],"53":[1650,850],"54":[1800,1200],"55":[700,300],"56":[2200,1600],"57":[850,300],"58":[1000,500]};

async function writeCarrierData(name, wilayaIds, communesByW, feeTable) {
  const ids = wilayaIds.map(Number).filter((id) => WILAYA_NAMES[id]).sort((a, b) => a - b);
  const wilayas = ids.map((id) => ({id, ar: WILAYA_NAMES[id][0], fr: WILAYA_NAMES[id][1]}));
  const communes = {};
  Object.keys(communesByW).forEach((wid) => {
    const seen = new Set();
    const out = [];
    (communesByW[wid] || []).forEach((n) => {
      const t = String(n || "").trim();
      if (t && !seen.has(t)) {
        seen.add(t);
        out.push(t);
      }
    });
    out.sort((a, b) => a.localeCompare(b));
    communes[String(wid)] = out;
  });
  const fees = {};
  ids.forEach((id) => {
    const f = feeTable[id];
    if (f) fees[String(id)] = {home: f[0], desk: f[1]};
  });
  await db.doc(`delivery_data/${name}`).set({wilayas, communes, fees, updatedAt: FieldValue.serverTimestamp()});
  return {wilayas: wilayas.length, communes: Object.values(communes).reduce((a, b) => a + b.length, 0)};
}

/**
 * syncCarriers (callable): pulls each carrier's real wilaya + commune lists from its API
 * (using whichever keys are configured) and caches them — with per-wilaya home/desk fees —
 * to delivery_data/yalidine and delivery_data/noest, which the order form reads to populate
 * the right list per carrier. Run from admin → Settings after saving keys.
 */
exports.syncCarriers = onCall({timeoutSeconds: 120}, async () => {
  const yal = (await db.doc("settings/delivery").get()).data() || {};
  const no = (await db.doc("settings/noest").get()).data() || {};
  const zr = (await db.doc("settings/zrexpress").get()).data() || {};
  const out = {};
  try {
    // YALIDINE
    if (yal.apiId && yal.apiToken) {
      const h = {"X-API-ID": String(yal.apiId), "X-API-TOKEN": String(yal.apiToken)};
      const wj = await (await fetch("https://api.yalidine.app/v1/wilayas/?page_size=100", {headers: h})).json();
      const wIds = (wj.data || []).map((w) => w.id);
      const byW = {};
      let page = 1; let more = true;
      while (more && page <= 4) {
        const cj = await (await fetch("https://api.yalidine.app/v1/communes/?page_size=1000&page=" + page, {headers: h})).json();
        (cj.data || []).forEach((c) => {
          if (c.is_deliverable) (byW[c.wilaya_id] = byW[c.wilaya_id] || []).push(c.name);
        });
        more = !!cj.has_more; page++;
      }
      out.yalidine = await writeCarrierData("yalidine", wIds, byW, YAL_FEES);
    }
    // NOEST
    if (no.apiToken) {
      const h = {"Authorization": "Bearer " + String(no.apiToken)};
      const wRaw = await (await fetch(NOEST_BASE + "/api/public/get/wilayas", {headers: h})).json();
      const wArr = (Array.isArray(wRaw) ? wRaw : Object.values(wRaw)).filter((w) => w.is_active != 0);
      const cRaw = await (await fetch(NOEST_BASE + "/api/public/get/communes", {headers: h})).json();
      const cArr = Array.isArray(cRaw) ? cRaw : Object.values(cRaw);
      const byW = {};
      cArr.forEach((c) => {
        if (c.is_active != 0) (byW[c.wilaya_id] = byW[c.wilaya_id] || []).push(c.nom);
      });
      out.noest = await writeCarrierData("noest", wArr.map((w) => w.code), byW, NOEST_FEES);
    }
    // ZREXPRESS — territories carry their own UUIDs, so this writes the richer shape itself.
    if (zr.tenantId && zr.apiKey) {
      out.zrexpress = await syncZrTerritories(zr);
    }
  } catch (e) {
    throw new HttpsError("internal", String((e && e.message) || e));
  }
  return {ok: true, result: out};
});

// ═══════════════════════════ ZRExpress parcel operations (callable) ═══════════════════════════
// All of these run server-side because the ZR credentials are write-only for clients. The admin
// UI calls them with httpsCallable(). Each reads error.detail / error.errors[] for a clear message.

/**
 * zrPrintLabel: generate a FRESH printable label. Label URLs are short-lived, so we never store
 * them — the admin calls this each time it prints. One tracking number → individual label;
 * many → a single bulk PDF/HTML. Uses Authorization: Bearer (NOT X-Api-Key).
 * Returns the raw ZR body: individual → {parcelLabelFiles:[{trackingNumber,fileUrl}], failedTrackingNumbers},
 * bulk → {fileUrl, failedTrackingNumbers}.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
exports.zrPrintLabel = onCall(async (req) => {
  const c = await zrCreds();
  let tns = (req.data && req.data.trackingNumbers) || [];
  if (!Array.isArray(tns)) tns = [tns];
  tns = tns.map((t) => String(t || "").trim()).filter(Boolean);
  const parcelId = String((req.data && req.data.parcelId) || "").trim();
  const orderId = String((req.data && req.data.orderId) || "").trim();

  // A label needs the ZR tracking number (e.g. "ZR-ALG-..."), NOT the parcel UUID. If all we
  // were given is a UUID (or nothing), resolve the real tracking number from the parcel first —
  // this is the usual cause of "label failed" right after a parcel is created.
  if ((!tns.length || tns.every((t) => UUID_RE.test(t))) && parcelId) {
    const row = await zrFindParcel(c, {parcelId});
    if (row && row.trackingNumber) {
      tns = [row.trackingNumber];
      if (orderId) await db.doc("orders/" + orderId).update({deliveryTracking: row.trackingNumber}).catch(() => {});
    }
  }
  tns = tns.filter((t) => t && !UUID_RE.test(t));
  if (!tns.length) {
    throw new HttpsError("failed-precondition", "لا يوجد رقم تتبّع ZRExpress لهذا الطرد بعد — حدّث الحالة (🔄) ثم أعد المحاولة.");
  }

  // A4 = the multiple-labels endpoint, which returns ONE A4 sheet (individual = thermal labels).
  const wantA4 = String((req.data && req.data.format) || "A4").toUpperCase() === "A4";
  const bulk = tns.length > 1 || wantA4 || (req.data && req.data.bulk === true);
  const path = bulk ? "/parcels/labels/multiple" : "/parcels/labels/individual";
  const {res, body} = await zrFetch(ZR_BASE + path, {
    method: "POST", headers: zrLabelHeaders(c),
    body: JSON.stringify({trackingNumbers: tns.slice(0, bulk ? 250 : 50)}),
  });
  if (!res.ok) throw new HttpsError("unavailable", "ZRExpress label: " + zrErrMsg(body, res.status));
  const out = body || {};
  out.trackingUsed = tns;
  // Fetch the label HTML server-side (no browser CORS) so the admin can print it reliably as A4.
  const url = (out.parcelLabelFiles && out.parcelLabelFiles[0] && out.parcelLabelFiles[0].fileUrl) || out.fileUrl || null;
  if (url) { try { const r = await fetch(url); if (r.ok) out.html = await r.text(); } catch (e) { /* client falls back to opening the url */ } }
  return out;
});

/**
 * zrDeleteParcel: delete a parcel at ZR (only allowed while it isn't locked). On success the order
 * is reset to "New" + unfulfilled so it can be re-dispatched.
 */
exports.zrDeleteParcel = onCall(async (req) => {
  const c = await zrCreds();
  const parcelId = String((req.data && req.data.parcelId) || "").trim();
  const orderId = String((req.data && req.data.orderId) || "").trim();
  if (!parcelId) throw new HttpsError("invalid-argument", "parcelId is required");
  const {res, body} = await zrFetch(ZR_BASE + "/parcels/" + parcelId, {method: "DELETE", headers: zrHeaders(c)});
  if (res.status !== 204 && !res.ok) throw new HttpsError("failed-precondition", "ZRExpress delete: " + zrErrMsg(body, res.status));
  if (orderId) {
    await db.doc("orders/" + orderId).update({
      deliveryStatus: "Deleted",
      deliveryParcelId: FieldValue.delete(),
      deliveryTracking: FieldValue.delete(),
      deliveryLabel: FieldValue.delete(),
      deliveryProvider: FieldValue.delete(),
      deliveryLocked: FieldValue.delete(),
      deliveryError: null,
      fulfilled: false,
      status: "New",
    }).catch(() => {});
  }
  return {ok: true};
});

/** zrUpdateAmount: PATCH /parcels/{id}/amount — COD amount, clamped to 0..150000. */
exports.zrUpdateAmount = onCall(async (req) => {
  const c = await zrCreds();
  const parcelId = String((req.data && req.data.parcelId) || "").trim();
  if (!parcelId) throw new HttpsError("invalid-argument", "parcelId is required");
  const amount = clampAmount(req.data && req.data.amount);
  const {res, body} = await zrFetch(ZR_BASE + "/parcels/" + parcelId + "/amount", {
    method: "PATCH", headers: zrHeaders(c), body: JSON.stringify({parcelId, amount}),
  });
  if (!res.ok) throw new HttpsError("failed-precondition", "ZRExpress amount: " + zrErrMsg(body, res.status));
  const orderId = String((req.data && req.data.orderId) || "").trim();
  if (orderId) await db.doc("orders/" + orderId).update({total: amount}).catch(() => {});
  return body || {ok: true};
});

/** zrUpdateCustomer: PATCH /parcels/{id}/customer — name + phone (international format). */
exports.zrUpdateCustomer = onCall(async (req) => {
  const c = await zrCreds();
  const parcelId = String((req.data && req.data.parcelId) || "").trim();
  const name = String((req.data && req.data.name) || "").trim();
  if (!parcelId) throw new HttpsError("invalid-argument", "parcelId is required");
  if (!name) throw new HttpsError("invalid-argument", "name is required");
  const phone = zrPhone((req.data && req.data.phone) || "");
  const {res, body} = await zrFetch(ZR_BASE + "/parcels/" + parcelId + "/customer", {
    method: "PATCH", headers: zrHeaders(c), body: JSON.stringify({parcelId, name, phone}),
  });
  if (!res.ok) throw new HttpsError("failed-precondition", "ZRExpress customer: " + zrErrMsg(body, res.status));
  const orderId = String((req.data && req.data.orderId) || "").trim();
  if (orderId) await db.doc("orders/" + orderId).update({customer: name, phone: String((req.data && req.data.phone) || "").trim()}).catch(() => {});
  return body || {ok: true};
});

/** zrUpdateAddress: PATCH /parcels/{id}/deliveryAddress — note the capitalised DeliveryAddress key. */
exports.zrUpdateAddress = onCall(async (req) => {
  const c = await zrCreds();
  const d = req.data || {};
  const parcelId = String(d.parcelId || "").trim();
  const cityTerritoryId = String(d.cityTerritoryId || "").trim();
  const districtTerritoryId = String(d.districtTerritoryId || "").trim();
  if (!parcelId) throw new HttpsError("invalid-argument", "parcelId is required");
  if (!cityTerritoryId || !districtTerritoryId) throw new HttpsError("invalid-argument", "cityTerritoryId and districtTerritoryId are required");
  const {res, body} = await zrFetch(ZR_BASE + "/parcels/" + parcelId + "/deliveryAddress", {
    method: "PATCH", headers: zrHeaders(c),
    body: JSON.stringify({parcelId, DeliveryAddress: {cityTerritoryId, districtTerritoryId, street: String(d.street || "").slice(0, 200)}}),
  });
  if (!res.ok) throw new HttpsError("failed-precondition", "ZRExpress address: " + zrErrMsg(body, res.status));
  const orderId = String(d.orderId || "").trim();
  if (orderId) {
    await db.doc("orders/" + orderId).update({
      cityTerritoryId, districtTerritoryId,
      wilaya: d.wilayaName || undefined, commune: d.communeName || undefined,
      address: String(d.street || "").slice(0, 200),
    }).catch(() => {});
  }
  return body || {ok: true};
});

/**
 * zrUpdateProducts: PATCH /parcels/{id}/products — full product list + description + amount.
 * The whole list is sent because ZR DELETES any product not included.
 */
exports.zrUpdateProducts = onCall(async (req) => {
  const c = await zrCreds();
  const d = req.data || {};
  const parcelId = String(d.parcelId || "").trim();
  if (!parcelId) throw new HttpsError("invalid-argument", "parcelId is required");
  const orderedProducts = (Array.isArray(d.orderedProducts) ? d.orderedProducts : []).map((p) => {
    const row = {
      productName: (String((p && p.productName) || "").trim() || "منتج").slice(0, 200),
      unitPrice: clampAmount(p && p.unitPrice),
      quantity: Math.max(1, Number(p && p.quantity) || 1),
      stockType: zrStock(p && p.stockType),
    };
    if (p && p.length != null) row.length = Number(p.length) || 0;
    if (p && p.width != null) row.width = Number(p.width) || 0;
    if (p && p.height != null) row.height = Number(p.height) || 0;
    return row;
  });
  if (!orderedProducts.length) throw new HttpsError("invalid-argument", "at least one product is required");
  let description = String(d.description || "").slice(0, 250);
  if (description.length < 2) description = "منتجات";
  const amount = clampAmount(d.amount);
  const {res, body} = await zrFetch(ZR_BASE + "/parcels/" + parcelId + "/products", {
    method: "PATCH", headers: zrHeaders(c),
    body: JSON.stringify({parcelId, description, amount, orderedProducts}),
  });
  if (!res.ok) throw new HttpsError("failed-precondition", "ZRExpress products: " + zrErrMsg(body, res.status));
  return body || {ok: true};
});

/** zrUpdateState: PATCH /parcels/{id}/state — returns the trackingNumber; we persist it. */
exports.zrUpdateState = onCall(async (req) => {
  const c = await zrCreds();
  const d = req.data || {};
  const parcelId = String(d.parcelId || "").trim();
  const newStateId = String(d.newStateId || "").trim();
  if (!parcelId || !newStateId) throw new HttpsError("invalid-argument", "parcelId and newStateId are required");
  const {res, body} = await zrFetch(ZR_BASE + "/parcels/" + parcelId + "/state", {
    method: "PATCH", headers: zrHeaders(c),
    body: JSON.stringify({parcelId, newStateId, comment: String(d.comment || "")}),
  });
  if (!res.ok) throw new HttpsError("failed-precondition", "ZRExpress state: " + zrErrMsg(body, res.status));
  const orderId = String(d.orderId || "").trim();
  if (orderId && body) {
    const patch = {};
    if (body.trackingNumber) patch.deliveryTracking = body.trackingNumber;
    if (body.newStateName) patch.deliveryLastStatus = body.newStateName;
    if (Object.keys(patch).length) await db.doc("orders/" + orderId).update(patch).catch(() => {});
  }
  return body || {ok: true};
});

/**
 * zrGetParcel: read one parcel (by parcelId or tracking) so the admin can show current values and,
 * crucially, state.isLocked — which gates editing/deleting. Caches the lock flag on the order.
 */
exports.zrGetParcel = onCall(async (req) => {
  const c = await zrCreds();
  const d = req.data || {};
  const parcelId = String(d.parcelId || "").trim();
  const tracking = String(d.tracking || "").trim();
  if (!parcelId && !tracking) throw new HttpsError("invalid-argument", "parcelId or tracking is required");
  const row = await zrFindParcel(c, {parcelId, tracking});
  if (!row) throw new HttpsError("not-found", "Parcel not found at ZRExpress");
  const orderId = String(d.orderId || "").trim();
  if (orderId) {
    await db.doc("orders/" + orderId).update({
      deliveryLocked: !!(row.state && row.state.isLocked),
      deliveryLastStatus: (row.state && row.state.name) || null,
    }).catch(() => {});
  }
  return row;
});
