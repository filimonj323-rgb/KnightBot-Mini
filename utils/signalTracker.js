/**
 * utils/signalTracker.js — Rekodi ya matokeo halisi ya signals za Pocket Option.
 *
 * Kila signal inayotumwa/kutumika (auto-signal, scan, amri ya mkono, auto-trader) inahifadhiwa
 * kwenye jedwali `po_signals` (Turso). Baada ya expiry kupita, matokeo yanapimwa kwa bei ya
 * candle ya 1m iliyofunga wakati wa expiry: win / loss / draw. `.postats` inaonyesha win rate
 * halisi kwa timeframe, hali ya soko, nguvu, n.k. — hii ndiyo njia pekee ya kujua kama
 * mantiki ya signals inafanya kazi.
 *
 * Kila function ni "best-effort": database ikishindwa, signals/trading HAVIVUNJIKI.
 *
 * Env (hiari): POCKET_TRACK_MIN_STRENGTH (default 50), POCKET_TRACK_MAX_DAILY (default 400,
 * kulinda kikomo cha writes cha Turso), POCKET_PAYOUT (default 85, kwa mstari wa kuvunja sawa),
 * POCKET_TRACK=false kuzima kabisa.
 */

const db = require('../pairing/db');
const { getCandles, isBridgeUp } = require('./pocketOptionTrader');

const TRACK_ON = () => String(process.env.POCKET_TRACK || 'true').toLowerCase() !== 'false';
const MIN_STRENGTH = () => Number(process.env.POCKET_TRACK_MIN_STRENGTH || 50);
const MAX_DAILY = () => Number(process.env.POCKET_TRACK_MAX_DAILY || 400);
const PAYOUT = () => Number(process.env.POCKET_PAYOUT || 85);
const VOID_AFTER_MS = 3 * 60 * 60 * 1000; // isiyopimika ndani ya saa 3 baada ya expiry -> void
const RESOLVE_EVERY_MS = 30 * 1000;
const CLOSE_BUFFER_MS = 5000; // subiri candle ya expiry ifungwe kabisa

function toMs(t) {
  if (typeof t === 'number') return t < 1e12 ? t * 1000 : t;
  const v = Date.parse(t);
  return Number.isNaN(v) ? null : v;
}

// ── Jedwali ────────────────────────────────────────────────────────────
let tableReady = null;
function ensureTable() {
  if (!tableReady) {
    tableReady = (async () => {
      await db.query(
        `CREATE TABLE IF NOT EXISTS po_signals (
           id          INTEGER PRIMARY KEY AUTOINCREMENT,
           pair        TEXT    NOT NULL,
           tf          INTEGER NOT NULL,
           expirySec   INTEGER NOT NULL,
           direction   TEXT    NOT NULL,
           strength    INTEGER NOT NULL,
           regime      TEXT,
           htf         TEXT,
           adx         REAL,
           rsi         REAL,
           entryPrice  REAL    NOT NULL,
           entryTs     INTEGER NOT NULL,
           exitTs      INTEGER NOT NULL,
           source      TEXT,
           status      TEXT    NOT NULL DEFAULT 'pending',
           exitPrice   REAL,
           resolvedAt  INTEGER,
           createdAt   INTEGER NOT NULL,
           UNIQUE(pair, tf, entryTs)
         )`
      );
      await db.query('CREATE INDEX IF NOT EXISTS idx_po_signals_pending ON po_signals(status, exitTs)');
    })().catch((e) => { tableReady = null; throw e; });
  }
  return tableReady;
}

// ── Kurekodi ───────────────────────────────────────────────────────────
let daily = { day: '', n: 0, warned: false };

/** @returns {Promise<boolean>} true = signal mpya imehifadhiwa */
async function record(r, source = 'manual') {
  try {
    if (!TRACK_ON() || !r || r.direction === 'NEUTRAL') return false;
    if (!(Number(r.strength) >= MIN_STRENGTH())) return false;

    const tf = Number(r.timeframeSec);
    const expirySec = Number(r.expirySec || tf);
    // 30s na chini hazipimiki kwa candles za 1m — ruka.
    if (!(tf >= 60) || tf % 60 !== 0 || expirySec % 60 !== 0) return false;

    const entryPrice = Number(r.price);
    const candleMs = toMs(r.candleTime);
    if (!Number.isFinite(entryPrice) || candleMs == null) return false;

    const entryTs = candleMs + tf * 1000; // candle ya signal ilifunga hapa
    const now = Date.now();
    // Signal ya zamani (mfano data ya cache) haihesabiki kama "ya sasa".
    if (now - entryTs > tf * 1000 * 2 + 30000 || entryTs - now > 60000) return false;

    const today = new Date().toISOString().slice(0, 10);
    if (daily.day !== today) daily = { day: today, n: 0, warned: false };
    if (daily.n >= MAX_DAILY()) {
      if (!daily.warned) {
        daily.warned = true;
        console.warn(`[signalTracker] kikomo cha siku (${MAX_DAILY()}) kimefika — nasimama kurekodi hadi kesho.`);
      }
      return false;
    }

    await ensureTable();
    const res = await db.query(
      `INSERT INTO po_signals
         (pair, tf, expirySec, direction, strength, regime, htf, adx, rsi, entryPrice, entryTs, exitTs, source, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(pair, tf, entryTs) DO NOTHING`,
      [
        r.pair, tf, expirySec, r.direction, Math.round(Number(r.strength)),
        r.regime || null, r.htf || null,
        Number.isFinite(Number(r.adx)) ? Number(r.adx) : null,
        Number.isFinite(Number(r.rsi)) ? Number(r.rsi) : null,
        entryPrice, entryTs, entryTs + expirySec * 1000, source, now,
      ]
    );
    const inserted = (res.rowsAffected || 0) > 0;
    if (inserted) daily.n += 1;
    return inserted;
  } catch (e) {
    console.error('[signalTracker] record:', e.message);
    return false;
  }
}

async function recordMany(list, source) {
  let n = 0;
  for (const r of list || []) if (await record(r, source)) n++;
  return n;
}

// ── Kupima matokeo ─────────────────────────────────────────────────────
let resolving = false;

async function markVoid(id) {
  await db.query("UPDATE po_signals SET status='void', resolvedAt=? WHERE id=? AND status='pending'", [Date.now(), id]);
}

async function resolveDue() {
  if (resolving || !TRACK_ON()) return 0;
  resolving = true;
  let resolved = 0;
  try {
    await ensureTable();
    const now = Date.now();
    const due = (await db.query(
      "SELECT * FROM po_signals WHERE status='pending' AND exitTs <= ? ORDER BY exitTs ASC LIMIT 60",
      [now - CLOSE_BUFFER_MS]
    )).rows;
    if (!due.length) return 0;
    if (!(await isBridgeUp())) return 0;

    const byPair = new Map();
    for (const s of due) {
      if (!byPair.has(s.pair)) byPair.set(s.pair, []);
      byPair.get(s.pair).push(s);
    }

    for (const [pair, sigs] of byPair) {
      let candles = null;
      try {
        candles = await getCandles(pair, 60, 120);
      } catch (e) {
        console.error(`[signalTracker] candles za ${pair} zimeshindwa: ${e.message}`);
      }
      const byOpen = new Map();
      for (const c of candles || []) {
        const ms = toMs(c.time);
        if (ms != null) byOpen.set(Math.floor(ms / 1000), c);
      }
      for (const s of sigs) {
        const exitOpenSec = Math.round(Number(s.exitTs) / 1000) - 60; // candle ya 1m iliyofunga kwenye expiry
        const c = byOpen.get(exitOpenSec);
        if (!c) {
          if (now - Number(s.exitTs) > VOID_AFTER_MS) await markVoid(s.id);
          continue;
        }
        const exitPrice = Number(c.close);
        const entry = Number(s.entryPrice);
        const status = exitPrice === entry ? 'draw' : ((s.direction === 'BUY') === (exitPrice > entry) ? 'win' : 'loss');
        await db.query(
          "UPDATE po_signals SET status=?, exitPrice=?, resolvedAt=? WHERE id=? AND status='pending'",
          [status, exitPrice, Date.now(), s.id]
        );
        resolved++;
      }
    }
  } catch (e) {
    console.error('[signalTracker] resolve:', e.message);
  } finally {
    resolving = false;
  }
  return resolved;
}

let resolverStarted = false;
function startResolver() {
  if (resolverStarted) return;
  resolverStarted = true;
  const t = setInterval(() => { resolveDue().catch(() => {}); }, RESOLVE_EVERY_MS);
  if (t.unref) t.unref();
}

// ── Takwimu ────────────────────────────────────────────────────────────
function wilson(w, n, z = 1.96) {
  if (!n) return null;
  const p = w / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [(c - m) / d, (c + m) / d];
}

function tally(rows, keyFn) {
  const g = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (k == null) continue;
    if (!g.has(k)) g.set(k, { w: 0, l: 0, d: 0 });
    const t = g.get(k);
    if (r.status === 'win') t.w++;
    else if (r.status === 'loss') t.l++;
    else if (r.status === 'draw') t.d++;
  }
  return g;
}

function htfBucket(r) {
  if (!r.htf) return 'bila 5m';
  if (r.htf === 'FLAT') return '5m tulivu';
  const aligned = (r.htf === 'UP' && r.direction === 'BUY') || (r.htf === 'DOWN' && r.direction === 'SELL');
  return aligned ? '5m inaunga mkono' : '5m inapinga';
}

function strengthBucket(r) {
  return r.strength >= 85 ? '85%+' : r.strength >= 67 ? '67–84%' : '50–66%';
}

async function getStats(days = 7) {
  await ensureTable();
  const since = Date.now() - days * 86400000;
  const all = (await db.query('SELECT * FROM po_signals WHERE createdAt >= ?', [since])).rows;
  const done = all.filter((r) => ['win', 'loss', 'draw'].includes(r.status));
  const pending = all.filter((r) => r.status === 'pending').length;
  const voided = all.filter((r) => r.status === 'void').length;
  return { days, rows: done, pending, voided, total: all.length };
}

function fmtRate(t) {
  const n = t.w + t.l;
  if (!n) return `0W-0L (—)${t.d ? ` +${t.d}D` : ''}`;
  const pct = ((t.w / n) * 100).toFixed(1);
  return `${t.w}W-${t.l}L ${pct}% (n=${n})${n < 20 ? ' ⚠️' : ''}`;
}

function section(title, map, order) {
  if (!map.size) return '';
  const keys = order ? order.filter((k) => map.has(k)) : [...map.keys()];
  return `\n*${title}*\n` + keys.map((k) => `• ${k}: ${fmtRate(map.get(k))}`).join('\n') + '\n';
}

function formatStats(st) {
  const rows = st.rows;
  const total = tally(rows, () => 'all').get('all') || { w: 0, l: 0, d: 0 };
  const n = total.w + total.l;
  const be = 100 / (100 + PAYOUT()); // mfano payout 85% -> 54.05%
  let out = `📊 *Takwimu za Signals* (siku ${st.days})\n`;
  out += `Zilizopimwa: ${rows.length} (🏆 ${total.w} • ❌ ${total.l} • ➖ ${total.d} sare)`;
  out += ` • ⏳ zinasubiri: ${st.pending}${st.voided ? ` • 🚫 batili: ${st.voided}` : ''}\n`;

  if (!n) {
    return out + '\nBado hakuna matokeo ya kutosha. Subiri signals zipimwe baada ya expiry yake.';
  }
  const rate = total.w / n;
  const ci = wilson(total.w, n);
  out += `\n🎯 *Win rate: ${(rate * 100).toFixed(1)}%* (n=${n}; 95%: ${(ci[0] * 100).toFixed(0)}–${(ci[1] * 100).toFixed(0)}%)\n`;
  out += `⚖️ Kuvunja sawa (payout ${PAYOUT()}%): ${(be * 100).toFixed(1)}%\n`;
  if (ci[0] > be) out += '✅ Juu ya kuvunja sawa kitakwimu.\n';
  else if (ci[1] < be) out += '🔴 Chini ya kuvunja sawa kitakwimu — mantiki hii inapoteza.\n';
  else out += `🟡 Bado haijulikani${n < 100 ? ' (sampuli ndogo — subiri n≥100)' : ''}.\n`;

  out += section('Kwa timeframe/expiry', tally(rows, (r) => `${Math.round(r.expirySec / 60)}m`), ['1m', '2m', '3m', '5m', '10m', '15m', '30m']);
  out += section('Kwa hali ya soko', tally(rows, (r) => r.regime || 'haijulikani'), ['TREND', 'RANGE', 'MIXED', 'UNKNOWN', 'haijulikani']);
  out += section('Kwa nguvu ya signal', tally(rows, strengthBucket), ['50–66%', '67–84%', '85%+']);
  out += section('Kwa trend ya 5m', tally(rows, htfBucket), ['5m inaunga mkono', '5m tulivu', '5m inapinga', 'bila 5m']);
  out += section('Kwa mwelekeo', tally(rows, (r) => (r.direction === 'BUY' ? 'BUY (UP)' : 'SELL (DOWN)')), ['BUY (UP)', 'SELL (DOWN)']);

  const pairs = [...tally(rows, (r) => r.pair).entries()]
    .map(([k, t]) => ({ k, t, n: t.w + t.l }))
    .filter((x) => x.n >= 10)
    .sort((a, b) => b.t.w / b.n - a.t.w / a.n);
  if (pairs.length >= 2) {
    out += '\n*Jozi (n≥10)*\n';
    const show = pairs.length > 6 ? [...pairs.slice(0, 3), ...pairs.slice(-3)] : pairs;
    out += show.map((x) => `• ${x.k}: ${fmtRate(x.t)}`).join('\n') + '\n';
  }
  out += '\n_⚠️ = sampuli ndogo (n<20), usiamini namba hiyo bado._';
  return out;
}

function groupList(map, order) {
  const keys = order ? order.filter((k) => map.has(k)) : [...map.keys()];
  return keys.map((k) => {
    const t = map.get(k);
    const n = t.w + t.l;
    return { label: k, w: t.w, l: t.l, d: t.d, n, rate: n ? t.w / n : null };
  });
}

/** Data ya dashboard (JSON): muhtasari + migawanyo + signals za hivi karibuni. */
async function getDashboard(days = 7, recentLimit = 25) {
  const st = await getStats(days);
  const rows = st.rows;
  const total = tally(rows, () => 'all').get('all') || { w: 0, l: 0, d: 0 };
  const n = total.w + total.l;
  const be = 100 / (100 + PAYOUT()); // sehemu (0.54), si asilimia
  const ci = wilson(total.w, n);
  let verdict = 'unknown';
  if (ci && ci[0] > be) verdict = 'above';
  else if (ci && ci[1] < be) verdict = 'below';

  const pairMap = tally(rows, (r) => r.pair);
  const pairs = groupList(pairMap).filter((x) => x.n >= 5).sort((a, b) => b.rate - a.rate);

  const recent = (await db.query(
    'SELECT id, pair, direction, strength, regime, htf, expirySec, status, entryPrice, exitPrice, createdAt, resolvedAt, source ' +
    'FROM po_signals ORDER BY createdAt DESC LIMIT ?', [recentLimit]
  )).rows;

  return {
    days, pending: st.pending, voided: st.voided,
    overall: { w: total.w, l: total.l, d: total.d, n, rate: n ? total.w / n : null, ci, breakEven: be, payout: PAYOUT(), verdict, small: n < 100 },
    groups: {
      expiry: groupList(tally(rows, (r) => `${Math.round(r.expirySec / 60)}m`), ['1m', '2m', '3m', '5m', '10m', '15m', '30m']),
      regime: groupList(tally(rows, (r) => r.regime || 'haijulikani'), ['TREND', 'RANGE', 'MIXED', 'UNKNOWN', 'haijulikani']),
      strength: groupList(tally(rows, strengthBucket), ['50–66%', '67–84%', '85%+']),
      htf: groupList(tally(rows, htfBucket), ['5m inaunga mkono', '5m tulivu', '5m inapinga', 'bila 5m']),
      direction: groupList(tally(rows, (r) => (r.direction === 'BUY' ? 'BUY (UP)' : 'SELL (DOWN)')), ['BUY (UP)', 'SELL (DOWN)']),
      pairs: pairs.length > 8 ? [...pairs.slice(0, 4), ...pairs.slice(-4)] : pairs,
    },
    recent,
  };
}

startResolver();

module.exports = { record, recordMany, resolveDue, getStats, getDashboard, formatStats, startResolver, wilson };
