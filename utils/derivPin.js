/**
 * derivPin.js — PIN ya trading ya mteja (tarakimu 4–8).
 *
 * PIN hahifadhiwi wazi kamwe wala haiwezi kurudishwa: ni hash (HMAC na pepper ya server →
 * scrypt na salt). Kwa hiyo admin HAWEZI kumwambia mteja "PIN yake ya zamani" — anaweza
 * tu ku-reset (inatengeneza PIN ya muda ambayo mteja analazimika kuibadilisha).
 *
 * Tarakimu 4–8 ni nafasi ndogo: ulinzi halisi ni (1) pepper ya server (DB ikivuja peke
 * yake haitoshi kubashiri offline) na (2) lockout ya majaribio (angalia derivAccounts.js).
 */

const crypto = require('crypto');
const { promisify } = require('util');
const { pinPepper } = require('./derivCrypto');

const scrypt = promisify(crypto.scrypt);
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function isWeak(pin) {
  if (/^(\d)\1+$/.test(pin)) return true; // 0000, 111111
  const asc = '01234567890123456789';
  const desc = '98765432109876543210';
  return asc.includes(pin) || desc.includes(pin); // 1234, 4321, 6789
}

/** Inarudisha ujumbe wa kosa (string) au null ikiwa PIN inakubalika. */
function formatError(pin) {
  const p = String(pin ?? '');
  if (!/^\d{4,8}$/.test(p)) return 'PIN lazima iwe tarakimu 4 hadi 8 tu.';
  if (isWeak(p)) return 'PIN ni rahisi mno (mfano 1234 au 0000). Chagua nyingine.';
  return null;
}

async function derive(pin, salt) {
  const peppered = crypto.createHmac('sha256', pinPepper()).update(String(pin)).digest();
  return scrypt(peppered, salt, 32, SCRYPT);
}

async function hashPin(pin) {
  const salt = crypto.randomBytes(16);
  const dk = await derive(pin, salt);
  return `s1$${salt.toString('base64url')}$${dk.toString('base64url')}`;
}

async function verifyPinHash(pin, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 3 || parts[0] !== 's1') return false;
  try {
    const salt = Buffer.from(parts[1], 'base64url');
    const expected = Buffer.from(parts[2], 'base64url');
    const dk = await derive(String(pin ?? ''), salt);
    return dk.length === expected.length && crypto.timingSafeEqual(dk, expected);
  } catch {
    return false;
  }
}

/** PIN ya muda ya tarakimu 6 (admin reset). Haiwezi kuwa dhaifu. */
function generateTempPin() {
  for (;;) {
    const p = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    if (!formatError(p)) return p;
  }
}

module.exports = { formatError, hashPin, verifyPinHash, generateTempPin };
