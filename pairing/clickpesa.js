/**
 * pairing/clickpesa.js
 *
 * Minimal ClickPesa API client for collecting subscription payments via
 * USSD-PUSH (M-Pesa / Tigo Pesa / Airtel Money / HaloPesa — all networks
 * ClickPesa supports, in one call).
 *
 * Credentials live in pairing/pairingConfig.js — EDIT THEM THERE:
 *   CLICKPESA_CLIENT_ID   - from ClickPesa Dashboard -> Settings -> Developers
 *   CLICKPESA_API_KEY     - shown ONCE when you create the Application; also
 *                            doubles as the checksum signing key
 *   CLICKPESA_BASE_URL    - defaults to production. Use
 *                            https://sandbox.clickpesa.com for testing if
 *                            your account has sandbox access.
 *
 * IMPORTANT: verify the auth endpoint/header names against your own
 * ClickPesa dashboard docs (Developers -> API Reference -> Authorization)
 * before going live — ClickPesa's exact header casing has changed between
 * doc revisions in the past. Everything else below (checksum algorithm,
 * USSD-push endpoint + payload) is taken directly from their current
 * published API reference (docs.clickpesa.com).
 */

const crypto = require('crypto');
const cfg = require('./pairingConfig');

const CLIENT_ID = cfg.CLICKPESA_CLIENT_ID;
const API_KEY = cfg.CLICKPESA_API_KEY;
const BASE_URL = (cfg.CLICKPESA_BASE_URL || 'https://api.clickpesa.com').replace(/\/+$/, '');

function assertConfigured() {
  if (!CLIENT_ID || CLIENT_ID.startsWith('WEKA_') || !API_KEY || API_KEY.startsWith('WEKA_')) {
    throw new Error(
      'ClickPesa haijawekwa. Weka CLICKPESA_CLIENT_ID na CLICKPESA_API_KEY ndani ya pairing/pairingConfig.js'
    );
  }
}

// Recursively sort object keys so the same payload always hashes the same,
// regardless of key order — required by ClickPesa's checksum spec.
function canonicalize(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(canonicalize);
  return Object.keys(obj).sort().reduce((acc, key) => {
    acc[key] = canonicalize(obj[key]);
    return acc;
  }, {});
}

function createChecksum(payload) {
  const canonical = canonicalize(payload);
  const payloadString = JSON.stringify(canonical);
  return crypto.createHmac('sha256', API_KEY).update(payloadString).digest('hex');
}

/**
 * Verifies an inbound webhook's checksum against our API key, per
 * ClickPesa's "Validating Payload Checksum" spec: strip `checksum` and
 * `checksumMethod` before recomputing.
 */
function verifyWebhookChecksum(payload) {
  if (!payload || !payload.checksum) return false;
  const { checksum, checksumMethod, ...rest } = payload;
  return createChecksum(rest) === checksum;
}

let cachedToken = null;
let cachedTokenExpiresAt = 0;

async function getAuthToken() {
  assertConfigured();
  if (cachedToken && Date.now() < cachedTokenExpiresAt) {
    console.log(
      `[clickpesa][debug] tumia token iliyohifadhiwa (cached), itaisha muda baada ya ${Math.round((cachedTokenExpiresAt - Date.now()) / 1000)}s`
    );
    return cachedToken;
  }

  console.log(
    `[clickpesa][debug] naomba token mpya kutoka ${BASE_URL}/third-parties/generate-token | client-id: ${CLIENT_ID.slice(0, 6)}... | api-key: ${API_KEY.slice(0, 6)}...`
  );

  const res = await fetch(`${BASE_URL}/third-parties/generate-token`, {
    method: 'POST',
    headers: {
      'client-id': CLIENT_ID,
      'api-key': API_KEY,
    },
  });

  const data = await res.json().catch(() => ({}));
  console.log(`[clickpesa][debug] generate-token jibu: status=${res.status} body=${JSON.stringify(data)}`);

  if (!res.ok) {
    console.error('[clickpesa] auth imekataliwa:', res.status, JSON.stringify(data));
    throw new Error(`ClickPesa auth imeshindwa (${res.status}): ${data.message || JSON.stringify(data)}`);
  }
  let token = data.token || data.accessToken || (data.data && data.data.token);
  if (!token) throw new Error('ClickPesa haikurudisha token — angalia CLICKPESA_CLIENT_ID / CLICKPESA_API_KEY.');

  // ClickPesa mara nyingine hurudisha token ikiwa na "Bearer " tayari mbele yake
  // (mf. "Bearer eyJhbGci..."). Tunaiondoa hapa ili tusiongeze "Bearer " mara
  // mbili tunapotengeneza header ya Authorization chini — hii ndiyo iliyokuwa
  // ikisababisha 401 kwenye hatua ya malipo hata token ikiwa sahihi.
  if (token.startsWith('Bearer ')) {
    token = token.slice('Bearer '.length);
  }

  cachedToken = token;
  // Refresh well before typical short-lived-JWT expiry.
  cachedTokenExpiresAt = Date.now() + 4 * 60 * 1000;
  console.log(
    `[clickpesa][debug] token mpya imepatikana (urefu=${token.length} chars), itatumika hadi ${new Date(cachedTokenExpiresAt).toISOString()}`
  );
  return cachedToken;
}

/**
 * Sends a USSD-PUSH request to the customer's phone — they get a prompt to
 * enter their mobile money PIN to approve. amount in whole TZS, phoneNumber
 * in 2557XXXXXXXX format (no +), orderReference must be unique per attempt.
 */
/**
 * Inasafisha na kubadilisha phoneNumber kuwa fomati anayotaka ClickPesa:
 * "2557XXXXXXXX" (country code 255, bila '+', bila nafasi/alama).
 *
 * Inakubali namba za aina zifuatazo kutoka kwa mtumiaji/server.js:
 *   - "0789013686"      -> "255789013686"   (huanza na 0 - namba ya kawaida ya TZ)
 *   - "255789013686"    -> "255789013686"   (tayari ina country code)
 *   - "+255789013686"   -> "255789013686"   (ina + mbele)
 *   - "789013686"       -> "255789013686"   (bila 0 wala country code)
 */
function normalizePhoneNumber(rawPhoneNumber) {
  const digitsOnly = String(rawPhoneNumber || '').replace(/[^0-9]/g, '');

  if (digitsOnly.startsWith('255')) {
    return digitsOnly;
  }
  if (digitsOnly.startsWith('0')) {
    return '255' + digitsOnly.slice(1);
  }
  // namba ya tarakimu 9 bila 0 wala 255 mbele (mf. "789013686")
  if (digitsOnly.length === 9) {
    return '255' + digitsOnly;
  }
  // haijulikani muundo wake - rudisha kama ilivyo, ClickPesa itakataa kama si sahihi
  return digitsOnly;
}

async function initiateUssdPush({ amount, phoneNumber, orderReference }) {
  const token = await getAuthToken();
  console.log(
    `[clickpesa][debug] natumia token (urefu=${token ? token.length : 0} chars) kutuma ombi la malipo | orderReference=${orderReference}`
  );

  const cleanPhoneNumber = normalizePhoneNumber(phoneNumber);
  if (cleanPhoneNumber !== phoneNumber) {
    console.log(`[clickpesa][debug] phoneNumber imesafishwa: "${phoneNumber}" -> "${cleanPhoneNumber}"`);
  }
  if (!/^255[0-9]{9}$/.test(cleanPhoneNumber)) {
    throw new Error(
      `phoneNumber si sahihi baada ya kusafisha: "${cleanPhoneNumber}" (inatakiwa iwe 2557XXXXXXXX - tarakimu 12 zikianza na 255)`
    );
  }

  // ClickPesa inataka orderReference iwe herufi/namba TU (bila '-', '_', n.k.).
  // Tunaisafisha hapa ili orderReference yoyote (hata ikiwa na dashes kutoka
  // kwa server.js) ipite salama.
  const cleanOrderReference = String(orderReference || '').replace(/[^a-zA-Z0-9]/g, '');
  if (!cleanOrderReference) {
    throw new Error('orderReference haipo sahihi (tupu baada ya kusafisha alama).');
  }
  if (cleanOrderReference !== orderReference) {
    console.log(
      `[clickpesa][debug] orderReference imesafishwa: "${orderReference}" -> "${cleanOrderReference}"`
    );
  }

  const payload = {
    amount: String(amount),
    currency: 'TZS',
    orderReference: cleanOrderReference,
    phoneNumber: cleanPhoneNumber,
  };
  payload.checksum = createChecksum(payload);

  const url = `${BASE_URL}/third-parties/payments/initiate-ussd-push-request`;
  console.log(`[clickpesa][debug] POST ${url} | payload=${JSON.stringify({ ...payload, checksum: payload.checksum.slice(0, 8) + '...' })}`);

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const data = await res.json().catch(() => ({}));
  console.log(`[clickpesa][debug] initiate-ussd-push jibu: status=${res.status} headers.www-authenticate=${res.headers.get('www-authenticate') || 'N/A'} body=${JSON.stringify(data)}`);

  if (!res.ok) {
    console.error('[clickpesa] ombi limekataliwa:', res.status, JSON.stringify(data));
    const err = new Error(data.message || (data.error && data.error.message) || `ClickPesa imekataa ombi la malipo (${res.status}).`);
    err.details = data; // jibu kamili la ClickPesa — server.js hurudisha hii kwa UI
    throw err;
  }
  return data;
}

module.exports = {
  initiateUssdPush,
  verifyWebhookChecksum,
  createChecksum,
};
