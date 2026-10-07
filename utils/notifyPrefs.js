/**
 * notifyPrefs.js — Udhibiti wa notifications za Pocket Option (DM + group)
 *
 * Tatizo: bot ikituma signals/matokeo mfululizo kwa haraka, WhatsApp inaweza
 * kuona tabia ya spam na kuvunja session (logout). Moduli hii inatoa:
 *
 *   1) SWICHI: master (dmEnabled) + kila aina ya notification kivyake
 *        signals   → auto-signal (.posignal auto) kwenda DM
 *        opened    → auto-trade imefunguliwa
 *        results   → WIN / LOSS
 *        dryRun    → ujumbe wa dry-run
 *        warnings  → order imeshindwa / haikuthibitishwa / matokeo hayajapatikana
 *        breakers  → auto-trade imesimama (hasara ya siku, cooldown, imezimwa)
 *        dashboard → uthibitisho wa vitendo ulivyofanya kwenye dashboard
 *   2) FOLENI (anti-flood): ujumbe wote (DM na group) unatoka mmoja mmoja,
 *      kukiwa na pengo la minGapSec sekunde kati yake.
 *   3) MUHTASARI (digestMin > 0): opened/results/dryRun zinakusanywa na
 *      kutumwa kama ujumbe MMOJA kila dakika N, badala ya kila moja peke yake.
 *
 * Mpangilio unahifadhiwa Turso (pocketStore) — unadumu baada ya restart.
 * Kila function ni "best-effort": isivunje trading kamwe.
 */

const pocketStore = require('./pocketStore');

const KEY = 'notifyprefs:po';
const CATEGORIES = ['signals', 'opened', 'results', 'dryRun', 'warnings', 'breakers', 'dashboard'];
const DIGESTABLE = new Set(['opened', 'results', 'dryRun']);

const DEFAULTS = Object.freeze({
  dmEnabled: true,
  signals: true, opened: true, results: true, dryRun: true, warnings: true, breakers: true, dashboard: true,
  minGapSec: 4,   // pengo la chini kati ya ujumbe 2 (sekunde) — 0..60
  digestMin: 0,   // 0 = kila moja peke yake; >0 = muhtasari kila dakika N (1..60)
});

let prefs = { ...DEFAULTS };
let loaded = false;
let loading = null;

function sanitize(raw = {}) {
  const out = { ...DEFAULTS };
  out.dmEnabled = raw.dmEnabled !== false;
  for (const c of CATEGORIES) out[c] = raw[c] !== false;
  const gap = Number(raw.minGapSec);
  out.minGapSec = Number.isFinite(gap) ? Math.min(60, Math.max(0, Math.round(gap))) : DEFAULTS.minGapSec;
  const dg = Number(raw.digestMin);
  out.digestMin = Number.isFinite(dg) ? Math.min(60, Math.max(0, Math.round(dg))) : 0;
  return out;
}

async function load() {
  try {
    const rows = await pocketStore.loadSettings(KEY);
    const row = rows.find((r) => r.key === KEY);
    if (row) prefs = sanitize(JSON.parse(row.value));
  } catch (err) {
    console.error('[notifyPrefs] Imeshindwa kusoma mpangilio, natumia default:', err.message);
  }
  loaded = true;
}

function ensureLoaded() {
  if (loaded) return Promise.resolve();
  if (!loading) loading = load().finally(() => { loading = null; });
  return loading;
}

async function get() {
  await ensureLoaded();
  return { ...prefs };
}

async function set(raw) {
  await ensureLoaded();
  const next = sanitize({ ...prefs, ...raw });
  const hadDigest = prefs.digestMin > 0;
  prefs = next;
  await pocketStore.saveSetting(KEY, next);
  if (hadDigest && next.digestMin === 0) await flushDigest(); // zima muhtasari → tuma kilichokusanywa sasa
  return { ...next };
}

// Je, aina hii ya DM inaruhusiwa?
async function allow(category) {
  await ensureLoaded();
  return prefs.dmEnabled && prefs[category] !== false;
}

// ── Foleni ya kutuma (anti-flood) ─────────────────────────────────────────
let chain = Promise.resolve();
let lastSendAt = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function enqueue(fn) {
  const run = chain.then(async () => {
    const wait = lastSendAt + prefs.minGapSec * 1000 - Date.now();
    if (wait > 0) await sleep(wait);
    try { return await fn(); } finally { lastSendAt = Date.now(); }
  });
  chain = run.catch(() => {});
  return run;
}

// ── Muhtasari (digest) ────────────────────────────────────────────────────
let digestItems = [];
let digestTimer = null;
let digestTarget = null;

const oneLine = (text) => String(text).split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 2).join(' — ').slice(0, 220);

async function flushDigest() {
  if (digestTimer) { clearTimeout(digestTimer); digestTimer = null; }
  if (!digestItems.length || !digestTarget) { digestItems = []; return; }
  const items = digestItems; digestItems = [];
  const { sock, jid } = digestTarget;
  const s = global.currentSock || sock;
  if (!s || !jid) return;
  const text = `📋 *Muhtasari wa notifications* (${items.length})\n\n` + items.map((x) => `• ${x}`).join('\n');
  try {
    await enqueue(() => s.sendMessage(jid, { text }));
  } catch (err) {
    console.error('[notifyPrefs] Muhtasari umeshindwa kutumwa:', err.message);
  }
}

/**
 * Tuma DM yenye aina (category). Inarudisha true ikiwa imetumwa/imekusanywa,
 * false ikiwa imezuiwa na mpangilio au haiwezi kutumwa.
 */
async function dm(category, text, { sock, jid } = {}) {
  await ensureLoaded();
  if (!prefs.dmEnabled || prefs[category] === false) return false;
  const s = global.currentSock || sock;
  if (!s || !jid) return false;

  if (prefs.digestMin > 0 && DIGESTABLE.has(category)) {
    digestItems.push(oneLine(text));
    digestTarget = { sock: s, jid };
    if (digestItems.length >= 15) { flushDigest(); return true; } // usiache lundo kubwa mno
    if (!digestTimer) digestTimer = setTimeout(() => flushDigest(), prefs.digestMin * 60000);
    return true;
  }
  try {
    await enqueue(() => s.sendMessage(jid, { text }));
    return true;
  } catch (err) {
    console.error(`[notifyPrefs] DM (${category}) imeshindwa:`, err.message);
    return false;
  }
}

module.exports = { CATEGORIES, DEFAULTS, get, set, allow, dm, enqueue, flushDigest, load };
