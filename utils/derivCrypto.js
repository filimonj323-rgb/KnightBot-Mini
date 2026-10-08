/**
 * derivCrypto.js — Usimbaji wa API token za Deriv za wateja (AES-256-GCM).
 *
 * UFUNGUO: env var `TOKENVAULT_KEY` — baiti 32 (hex ya herufi 64, AU base64 ya baiti 32).
 *   Tengeneza:  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 *
 * ⚠️ JINA LA ENV VAR NI MUHIMU: SI "DERIV_..." wala "AUTO_TRADE_...". pairing/envSync.js
 * inahifadhi kila env inayoanza na DERIV_ ndani ya Turso (imesimbwa kwa ufunguo
 * unaotokana na ADMIN_SESSION_SECRET ya pairingConfig.js). Ufunguo huu ukihifadhiwa Turso
 * pamoja na token zenyewe, usimbaji hauna maana. Kwa hiyo jina hili LIMEEPUKA prefix zote
 * za envSync kwa makusudi. Weka kwenye Railway env PEKEE, na uhifadhi nakala mahali salama:
 * ukipotea, wateja watalazimika kuweka token zao upya (hakuna njia ya kuzirejesha).
 *
 * Kila token imefungwa (AAD) kwa namba ya mteja: ciphertext ya mteja A haiwezi kunakiliwa
 * kwenye safu ya mteja B na ikasomeka.
 *
 * Fail-closed: ufunguo ukikosekana au ukiwa batili, kila kazi inatupa error — hakuna
 * "fallback" ya ufunguo wa kubuni.
 */

const crypto = require('crypto');

const ENV_NAME = 'TOKENVAULT_KEY';
const VERSION = 'v1';

class VaultError extends Error {}

function getKey() {
  const raw = String(process.env[ENV_NAME] || '').trim();
  if (!raw) throw new VaultError(`${ENV_NAME} haijawekwa — kuhifadhi token za wateja kumezuiwa (fail-closed).`);
  let buf = null;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) buf = Buffer.from(raw, 'hex');
  else if (/^[A-Za-z0-9+/=_-]{43,64}$/.test(raw)) buf = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  if (!buf || buf.length !== 32) {
    throw new VaultError(`${ENV_NAME} si sahihi — lazima iwe baiti 32 (hex ya herufi 64 au base64).`);
  }
  return buf;
}

function isConfigured() {
  try {
    getKey();
    return true;
  } catch {
    return false;
  }
}

const b64u = (b) => b.toString('base64url');
const unb64u = (s) => Buffer.from(String(s), 'base64url');

/** Inasimba `plain` ikiwa imefungwa kwa `aad` (namba ya mteja). Inarudisha "v1.iv.tag.ct". */
function encrypt(plain, aad) {
  if (!aad) throw new VaultError('aad (namba ya mteja) inahitajika.');
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(String(aad), 'utf8'));
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return [VERSION, b64u(iv), b64u(cipher.getAuthTag()), b64u(ct)].join('.');
}

function decrypt(blob, aad) {
  if (!aad) throw new VaultError('aad (namba ya mteja) inahitajika.');
  const key = getKey();
  const parts = String(blob || '').split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) throw new VaultError('Muundo wa token iliyohifadhiwa si sahihi.');
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, unb64u(parts[1]));
    decipher.setAAD(Buffer.from(String(aad), 'utf8'));
    decipher.setAuthTag(unb64u(parts[2]));
    return Buffer.concat([decipher.update(unb64u(parts[3])), decipher.final()]).toString('utf8');
  } catch {
    // Ujumbe wa jumla — usionyeshe undani wa crypto.
    throw new VaultError('Imeshindwa kufungua token iliyohifadhiwa (ufunguo umebadilika au data imeharibika).');
  }
}

/** "…ab12" — herufi 4 za mwisho tu, kwa kuonyesha mteja/admin. Kamwe token nzima. */
function hint(token) {
  const t = String(token || '');
  return t.length >= 8 ? `…${t.slice(-4)}` : '…';
}

/** Ufunguo wa pili (pepper) wa PIN, unaotokana na ufunguo mkuu — DB peke yake haitoshi kubashiri PIN. */
function pinPepper() {
  return crypto.createHmac('sha256', getKey()).update('deriv-pin-pepper-v1').digest();
}

module.exports = { encrypt, decrypt, hint, isConfigured, pinPepper, VaultError, ENV_NAME };
