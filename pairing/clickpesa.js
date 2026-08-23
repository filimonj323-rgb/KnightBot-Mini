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
  if (cachedToken && Date.now() < cachedTokenExpiresAt) return cachedToken;

  const res = await fetch(`${BASE_URL}/third-parties/generate-token`, {
    method: 'POST',
    headers: {
      'client-id': CLIENT_ID,
      'api-key': API_KEY,
    },
  });

  const rawText = await res.text();
  let data = {};
  try { data = JSON.parse(rawText); } catch (e) { /* leave as {} */ }

  if (!res.ok) {
    console.error(`[clickpesa] AUTH imeshindwa (${res.status}):`, rawText);
    throw new Error(`ClickPesa AUTH imeshindwa (${res.status}): ${data.message || rawText || 'hakuna maelezo'}`);
  }
  const token = data.token || data.accessToken || (data.data && data.data.token);
  if (!token) {
    console.error('[clickpesa] AUTH ilirudisha 200 lakini bila token:', rawText);
    throw new Error('ClickPesa haikurudisha token — angalia CLICKPESA_CLIENT_ID / CLICKPESA_API_KEY ndani ya pairingConfig.js.');
  }

  cachedToken = token;
  // Refresh well before typical short-lived-JWT expiry.
  cachedTokenExpiresAt = Date.now() + 4 * 60 * 1000;
  return cachedToken;
}

/**
 * Sends a USSD-PUSH request to the customer's phone — they get a prompt to
 * enter their mobile money PIN to approve. amount in whole TZS, phoneNumber
 * in 2557XXXXXXXX format (no +), orderReference must be unique per attempt.
 */
async function initiateUssdPush({ amount, phoneNumber, orderReference }) {
  const token = await getAuthToken();

  const payload = {
    amount: String(amount),
    currency: 'TZS',
    orderReference,
    phoneNumber,
  };
  payload.checksum = createChecksum(payload);

  const res = await fetch(`${BASE_URL}/third-parties/payments/initiate-ussd-push-request`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const rawText = await res.text();
  let data = {};
  try { data = JSON.parse(rawText); } catch (e) { /* leave as {} */ }

  if (!res.ok) {
    // Full raw response goes to server logs (Railway) so the real reason
    // ("invalid phone number", "channel unavailable", bad checksum, etc.)
    // is visible even though the customer only sees a short message.
    console.error(`[clickpesa] PUSH imekataliwa (${res.status}) kwa orderReference=${orderReference}:`, rawText);
    throw new Error(data.message || `ClickPesa imekataa ombi la malipo (${res.status}).`);
  }
  return data;
}

module.exports = {
  initiateUssdPush,
  verifyWebhookChecksum,
  createChecksum,
};
