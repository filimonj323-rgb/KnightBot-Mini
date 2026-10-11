/**
 * pairing/abliner.js
 *
 * Abliner API client (https://abliner.net/docs) — inachukua nafasi ya
 * clickpesa.js. Inakusanya malipo ya subscription kwa USSD-push
 * (M-Pesa / Tigo Pesa / Airtel Money / HaloPesa).
 *
 * Credentials (pairing/pairingConfig.js, au env var yenye jina lile lile):
 *   ABLINER_API_KEY         - "tsl_live_..." (inaonyeshwa MARA MOJA ukiiunda)
 *   ABLINER_WEBHOOK_SECRET  - "whsec_..." (tofauti na API key) — inasaini
 *                             maombi ya deposit na kuthibitisha webhook
 *   ABLINER_BASE_URL        - default https://abliner.net/api/v1
 *
 * Interface ni ile ile ya clickpesa.js (initiateUssdPush, getPaymentStatus,
 * isBlocked) + verifyWebhook(rawBody, headers).
 */

const crypto = require('crypto');
const cfg = require('./pairingConfig');

const pick = (k, d) => process.env[k] || cfg[k] || d;

const API_KEY = () => pick('ABLINER_API_KEY', '');
const WEBHOOK_SECRET = () => pick('ABLINER_WEBHOOK_SECRET', '');
const BASE_URL = () => String(pick('ABLINER_BASE_URL', 'https://abliner.net/api/v1')).replace(/\/+$/, '');

const WEBHOOK_TOLERANCE_SEC = 300;

function isPlaceholder(v) {
  return !v || String(v).startsWith('WEKA_');
}

function assertConfigured() {
  if (isPlaceholder(API_KEY()) || isPlaceholder(WEBHOOK_SECRET())) {
    throw new Error(
      'Abliner haijawekwa. Weka ABLINER_API_KEY na ABLINER_WEBHOOK_SECRET ndani ya pairing/pairingConfig.js'
    );
  }
}

let blockedUntil = 0; // baada ya 429, usipige Abliner hadi muda huu
/** true = Abliner imetuzuia kwa rate limit — usipige API kwa sasa. */
function isBlocked() {
  return Date.now() < blockedUntil;
}

function noteRateLimit(res) {
  if (res.status !== 429) return;
  const ra = Number(res.headers.get('retry-after'));
  blockedUntil = Date.now() + (ra > 0 ? ra * 1000 : 60 * 1000);
  console.error(`[abliner] rate limit (429) — nasimama kupiga API kwa sekunde ${Math.round((blockedUntil - Date.now()) / 1000)}.`);
}

function hmacHex(secret, text) {
  return crypto.createHmac('sha256', secret).update(text).digest('hex');
}

/** Namba → "2557XXXXXXXX" (Abliner pia inakubali 07XXXXXXXX, lakini tunasafisha). */
function normalizePhoneNumber(raw) {
  const d = String(raw || '').replace(/[^0-9]/g, '');
  if (d.startsWith('255')) return d;
  if (d.startsWith('0')) return '255' + d.slice(1);
  if (d.length === 9) return '255' + d;
  return d;
}

/**
 * Inatuma USSD-push kwenye simu ya mteja (anaweka PIN kuidhinisha).
 * amount = TZS nzima, orderReference = ya kipekee kwa kila jaribio.
 * Idempotency-Key = orderReference, hivyo kurudia ombi hakutume push mpya.
 */
async function initiateUssdPush({ amount, phoneNumber, orderReference }) {
  assertConfigured();

  const phone = normalizePhoneNumber(phoneNumber);
  if (!/^255[0-9]{9}$/.test(phone)) {
    throw new Error(`Namba ya malipo si sahihi: "${phone}" (inatakiwa 2557XXXXXXXX).`);
  }
  const reference = String(orderReference || '').replace(/[^a-zA-Z0-9-]/g, '');
  if (!reference) throw new Error('orderReference si sahihi.');

  const body = {
    amount: Number(amount),
    method: 'mobile',
    currency: 'TZS',
    phone,
    reference,
  };
  const base = String(cfg.PAIRING_BASE_URL || '').replace(/\/+$/, '');
  if (/^https:\/\//.test(base)) body.callback_url = `${base}/api/payment/webhook`;

  const rawBody = JSON.stringify(body);
  const timestamp = Math.floor(Date.now() / 1000).toString();

  const res = await fetch(`${BASE_URL()}/deposits`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${API_KEY()}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': reference,
      'x-abliner-timestamp': timestamp,
      'x-abliner-signature': signDeposit(rawBody, timestamp),
    },
    body: rawBody,
  });
  noteRateLimit(res);

  const data = await res.json().catch(() => ({}));
  console.log(`[abliner] deposit ref=${reference} status=${res.status} code=${data.code || data.status || ''}`);

  if (!res.ok) {
    const err = new Error(friendlyError(res.status, data));
    err.details = data; // jibu kamili — server.js hurudisha kwa UI
    throw err;
  }
  return data;
}

function signDeposit(rawBody, timestamp) {
  return hmacHex(WEBHOOK_SECRET(), `${timestamp}.${rawBody}`);
}

function friendlyError(status, data) {
  switch (data && data.code) {
    case 'invalid_phone': return 'Namba ya simu si sahihi kwa mtandao huu.';
    case 'amount_out_of_range': return 'Kiasi kiko nje ya kikomo kinachoruhusiwa.';
    case 'unsupported_request': return 'Mtandao huu wa simu hauruhusiwi kwa sasa.';
    case 'provider_error': return 'Mtandao wa simu haukujibu. Jaribu tena baada ya muda mfupi.';
    case 'gateway_not_configured': return 'Malipo yamezimwa kwa muda. Jaribu tena baadaye.';
    case 'request_in_progress': return 'Ombi la malipo linaendelea tayari. Subiri kidogo.';
    default: break;
  }
  if (status === 429) return 'Maombi mengi mno. Jaribu tena baada ya dakika moja.';
  return (data && data.message) || `Abliner imekataa ombi la malipo (${status}).`;
}

/**
 * Inauliza Abliner hali ya malipo kwa orderReference (customer_reference).
 * Inarudisha { status, paymentReference, collectedAmount } au null kama
 * hakuna rekodi bado. status: PENDING | COMPLETED | FAILED
 */
async function getPaymentStatus(orderReference) {
  assertConfigured();
  if (isBlocked()) return null;
  const ref = String(orderReference || '').replace(/[^a-zA-Z0-9-]/g, '');
  if (!ref) return null;

  const res = await fetch(`${BASE_URL()}/transactions?customer_reference=${encodeURIComponent(ref)}&limit=10`, {
    headers: { Authorization: `Bearer ${API_KEY()}` },
  });
  noteRateLimit(res);
  if (res.status === 404) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`Abliner status query imeshindwa (${res.status}): ${(data && data.message) || ''}`);
  }
  const list = Array.isArray(data) ? data : (data && Array.isArray(data.data) ? data.data : []);

  // USALAMA: kubali TU rekodi yenye customer_reference inayolingana HASA.
  const mine = list.filter((t) => t && t.type !== 'withdrawal' && String(t.customer_reference || '') === ref);
  if (!mine.length) return null;

  const paid = mine.find((t) => String(t.status).toLowerCase() === 'completed');
  const pickOne = paid || mine[mine.length - 1];
  return {
    status: String(pickOne.status || '').toUpperCase(),
    paymentReference: pickOne.provider_reference || pickOne.reference || pickOne.id || null,
    collectedAmount: pickOne.amount != null ? Number(pickOne.amount) : null,
  };
}

/**
 * Inathibitisha webhook inayoingia: timestamp ndani ya sekunde 300 na
 * HMAC-SHA256(`${timestamp}.${rawBody}`) kwa webhook secret.
 * rawBody LAZIMA iwe string ghafi kama ilivyopokelewa (si JSON iliyopitishwa tena).
 */
function verifyWebhook(rawBody, headers) {
  const secret = WEBHOOK_SECRET();
  if (isPlaceholder(secret)) return false;
  const sig = headers['x-webhook-signature'];
  const ts = headers['x-webhook-timestamp'];
  if (!sig || !ts) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - Number(ts)) > WEBHOOK_TOLERANCE_SEC) return false;

  const expected = Buffer.from(hmacHex(secret, `${ts}.${rawBody}`));
  const received = Buffer.from(String(sig));
  return expected.length === received.length && crypto.timingSafeEqual(expected, received);
}

module.exports = {
  initiateUssdPush,
  getPaymentStatus,
  isBlocked,
  verifyWebhook,
  normalizePhoneNumber,
};
