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
