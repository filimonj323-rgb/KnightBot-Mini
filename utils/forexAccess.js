/**
 * forexAccess.js — Ruhusa ya commands za forex/trading kwa PAIRING BOTS.
 *
 * Pairing bots (wateja): commands za TRADING/akaunti zimefungwa KABISA (hakuna ruhusa inayozifungua);
 * commands za forex SIGNALS (uchambuzi tu) zimefungwa hadi admin atoe ruhusa (dashboard: admin.html,
 * au `.fxaccess` kwenye bot kuu). Bot kuu na global owner hawaguswi.
 * Ruhusa zinahifadhiwa Turso (jedwali forex_access) — zinadumu baada ya restart.
 *   phoneNumber = namba ya mteja  -> mteja huyo ameruhusiwa
 *   phoneNumber = '*'             -> wateja WOTE wameruhusiwa
 * Ikiwa database imeshindwa, jibu ni "HAIRUHUSIWI" (fail-closed).
 */

const db = require('../pairing/db');

// Majina rasmi ya commands (command.name — aliases zinafunikwa kiotomatiki kwa sababu handler
// inapata object ile ile). Ongeza hapa command mpya ya forex/trading ikiwekwa baadaye.
//
// NGAZI MBILI (kwa PAIRING BOTS tu; bot kuu na global owner hawazuiwi):
//  1) ACCOUNT_BOUND — zinagusa akaunti/trades/bridge ya trading ya owner (kufungua/kufunga order,
//     auto-trade, balance, positions, historia, signals za Pocket Option zinazotumia bridge ya owner).
//     ZIMEFUNGWA KABISA — hata ruhusa ikitolewa haziwezi kutumika, hadi kila pairing bot iwe na
//     akaunti yake ya trading. Ili kufungua mojawapo siku zijazo, ihamishe kwenda SIGNAL_ONLY.
//  2) SIGNAL_ONLY — uchambuzi tu (Twelve Data), hazigusi akaunti yoyote. Zinahitaji ruhusa ya admin
//     (.fxaccess / dashboard).
const SIGNAL_ONLY = new Set([
  'forex', 'eurusd', 'gbpusd', 'usdjpy', 'usdchf', 'usdcad', 'audusd', 'nzdusd',
]);
const ACCOUNT_BOUND = new Set([
  // Deriv (forex): kufungua/kufunga/auto-trade + kuona akaunti
  'fxbuy', 'fxsell', 'fxautostake', 'fxtrailing', 'panic', 'fxautostatus', 'autostats', 'fxcheck', 'fxbacktest', 'positions',
  // Pocket Option: orders, auto-trade, historia, balance, signals (zinatumia bridge/akaunti ya owner)
  'pobuy', 'posell', 'poresult', 'pobalance', 'poauto', 'podelete', 'postats', 'posignal',
]);
const FOREX_COMMANDS = new Set([...SIGNAL_ONLY, ...ACCOUNT_BOUND]);

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

/** 'account' = imefungwa kabisa kwa pairing bots • 'signal' = inahitaji ruhusa • null = si ya forex */
function classify(command) {
  const n = String((command && command.name) || '').toLowerCase();
  if (ACCOUNT_BOUND.has(n)) return 'account';
  if (SIGNAL_ONLY.has(n)) return 'signal';
  return null;
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
  '🔒 *Commands za Forex hazijawashwa kwenye bot yako.*\n\n' +
  'Zinahitaji ruhusa ya admin. Wasiliana na admin kuomba ruhusa, ukishaiwezeshiwa zitaanza kufanya kazi mara moja.';

const ACCOUNT_LOCKED_TEXT =
  '🔒 *Command hii haipatikani kwenye pairing bots.*\n\n' +
  'Commands za trading (kufungua/kufunga order, auto-trade, balance, positions n.k.) zinahitaji akaunti ya trading ya kila bot — ' +
  'huduma hiyo bado haijawashwa. Utajulishwa ikipatikana.';

module.exports = { FOREX_COMMANDS, SIGNAL_ONLY, ACCOUNT_BOUND, isForexCommand, classify, isAllowed, grant, revoke, grantAll, revokeAll, list, normPhone, LOCKED_TEXT, ACCOUNT_LOCKED_TEXT };
