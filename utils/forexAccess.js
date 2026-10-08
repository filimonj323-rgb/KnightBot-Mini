/**
 * forexAccess.js — Ruhusa ya commands za forex/trading kwa PAIRING BOTS.
 *
 * Pairing bots (wateja) zimefungwa kwenye commands zote za forex/trading hadi admin wa bot kuu
 * atoe ruhusa (dashboard: admin.html, au command `.fxaccess` kwenye bot kuu). Bot kuu haiguswi.
 * Ruhusa zinahifadhiwa Turso (jedwali forex_access) — zinadumu baada ya restart.
 *   phoneNumber = namba ya mteja  -> mteja huyo ameruhusiwa
 *   phoneNumber = '*'             -> wateja WOTE wameruhusiwa
 * Ikiwa database imeshindwa, jibu ni "HAIRUHUSIWI" (fail-closed).
 */

const db = require('../pairing/db');

// Majina rasmi ya commands (command.name — aliases zinafunikwa kiotomatiki kwa sababu handler
// inapata object ile ile). Ongeza hapa command mpya ya forex ikiwekwa baadaye.
const FOREX_COMMANDS = new Set([
  // Forex signals
  'forex', 'eurusd', 'gbpusd', 'usdjpy', 'usdchf', 'usdcad', 'audusd', 'nzdusd',
  // Deriv (forex auto/manual trading)
  'fxbuy', 'fxsell', 'fxautostatus', 'fxbacktest', 'fxcheck', 'fxtrailing', 'fxautostake', 'autostats', 'panic',
  // Pocket Option
  'pobalance', 'pobuy', 'posell', 'poresult', 'posignal', 'positions', 'poauto', 'postats', 'podelete',
]);

const ALL = '*';
const CACHE_MS = 15000;
let cache = null; // { at, all:boolean, phones:Set }

let ready = null;
function ensure() {
  if (!ready) ready = db.initSchema().catch((e) => { ready = null; throw e; });
  return ready;
}

const normPhone = (raw) => String(raw || '').replace(/\D/g, '');

function isForexCommand(command) {
  return !!command && FOREX_COMMANDS.has(String(command.name || '').toLowerCase());
}

async function load(force = false) {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache;
  await ensure();
  const r = await db.query('SELECT phoneNumber, grantedAt, note FROM forex_access ORDER BY grantedAt DESC');
  const rows = r.rows || [];
  cache = {
    at: Date.now(),
    all: rows.some((x) => x.phoneNumber === ALL),
    phones: new Set(rows.filter((x) => x.phoneNumber !== ALL).map((x) => String(x.phoneNumber))),
    rows,
  };
  return cache;
}

/** Je, pairing bot ya `phone` inaruhusiwa commands za forex? (fail-closed) */
async function isAllowed(phone) {
  try {
    const c = await load();
    return c.all || c.phones.has(normPhone(phone));
  } catch (err) {
    console.error('[forexAccess] Imeshindwa kusoma ruhusa (inazuia):', err.message);
    return false;
  }
}

async function grant(phone, note = null) {
  const p = normPhone(phone);
  if (p.length < 7) return { ok: false, error: 'Namba si sahihi (tumia namba kamili na code ya nchi, mfano 2557XXXXXXXX).' };
  try {
    await ensure();
    await db.query(
      `INSERT INTO forex_access (phoneNumber, grantedAt, note) VALUES (?, ?, ?)
       ON CONFLICT(phoneNumber) DO UPDATE SET grantedAt = excluded.grantedAt, note = excluded.note`,
      [p, Date.now(), note]
    );
    cache = null;
    return { ok: true, phone: p };
  } catch (err) {
    return { ok: false, error: `Database imeshindwa: ${err.message}` };
  }
}

async function revoke(phone) {
  const p = normPhone(phone);
  if (!p) return { ok: false, error: 'Namba si sahihi.' };
  try {
    await ensure();
    const r = await db.query('DELETE FROM forex_access WHERE phoneNumber = ?', [p]);
    cache = null;
    return { ok: true, phone: p, removed: Number(r.rowsAffected) || 0 };
  } catch (err) {
    return { ok: false, error: `Database imeshindwa: ${err.message}` };
  }
}

async function grantAll() {
  try {
    await ensure();
    await db.query(
      `INSERT INTO forex_access (phoneNumber, grantedAt, note) VALUES ('*', ?, 'wote')
       ON CONFLICT(phoneNumber) DO UPDATE SET grantedAt = excluded.grantedAt`,
      [Date.now()]
    );
    cache = null;
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `Database imeshindwa: ${err.message}` };
  }
}

/** Inaondoa ruhusa ya "wote" tu; ruhusa za mteja mmoja mmoja zinabaki. */
async function revokeAll() {
  try {
    await ensure();
    await db.query("DELETE FROM forex_access WHERE phoneNumber = '*'");
    cache = null;
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `Database imeshindwa: ${err.message}` };
  }
}

async function list() {
  try {
    const c = await load(true);
    return {
      ok: true,
      all: c.all,
      grants: c.rows.filter((x) => x.phoneNumber !== ALL).map((x) => ({ phoneNumber: String(x.phoneNumber), grantedAt: Number(x.grantedAt), note: x.note || null })),
    };
  } catch (err) {
    return { ok: false, error: `Database imeshindwa: ${err.message}` };
  }
}

const LOCKED_TEXT =
  '🔒 *Commands za Forex/Trading hazijawashwa kwenye bot yako.*\n\n' +
  'Zinahitaji ruhusa ya admin. Wasiliana na admin kuomba ruhusa, ukishaiwezeshiwa zitaanza kufanya kazi mara moja.';

module.exports = { FOREX_COMMANDS, isForexCommand, isAllowed, grant, revoke, grantAll, revokeAll, list, normPhone, LOCKED_TEXT };
