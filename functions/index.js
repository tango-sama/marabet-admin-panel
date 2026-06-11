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
        to_wilaya_name: after.wilaya || "",
        product_list: [after.product, after.brand, after.color, after.size]
            .filter(Boolean).join(" / ") + (after.qty ? ` x${after.qty}` : ""),
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
  if (!tracking) throw new HttpsError("invalid-argument", "tracking is required");

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

  await db.doc("geo/wilayas").set({list: wList, updatedAt: FieldValue.serverTimestamp()});
  await db.doc("geo/communes").set({byWilaya: byWilaya, updatedAt: FieldValue.serverTimestamp()});
  logger.info(`Geo synced: ${wList.length} wilayas, ${communes.length} communes`);
  return {wilayas: wList.length, communes: communes.length};
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
