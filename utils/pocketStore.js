/**
 * pocketStore.js — Hifadhi ya Turso kwa Pocket Option (trades + settings).
 *
 * Jedwali: po_trades, po_settings (angalia pairing/db.js). Kila function ni
 * "best-effort": database ikishindwa, trading/commands HAZIVUNJIKI — error
 * inaandikwa kwenye log tu (muundo uleule na autoTrader.js).
 */

const db = require('../pairing/db');

async function ready() {
  await db.initSchema();
}

// ── Trades ──────────────────────────────────────────────────────────────

async function recordOpenTrade({ orderId, pair, direction, stake, expirySeconds, source = null, strength = null }) {
  try {
    await ready();
    const now = Date.now();
    const str = strength != null && Number.isFinite(Number(strength)) ? Math.round(Number(strength)) : null;
    await db.query(
      `INSERT INTO po_trades (orderId, pair, direction, stake, expirySeconds, openedAt, expiresAt, source, signalStrength)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(orderId) DO NOTHING`,
      [String(orderId), pair, direction, stake, expirySeconds, now, now + expirySeconds * 1000, source, str]
    );
  } catch (err) {
    console.error('[pocketStore] Imeshindwa kuhifadhi trade iliyofunguliwa:', err.message);
  }
}

// Inaandika matokeo mara moja tu (closedAt IS NULL) — salama kuitwa mara mbili.
// Trade ya 'unknown' inaweza kusahihishwa baadaye matokeo halisi yakipatikana (mfano kitufe cha "Angalia").
async function recordClosedTrade(orderId, { win, profit, status, result } = {}) {
  try {
    await ready();
    await db.query(
      `UPDATE po_trades
          SET closedAt = ?, win = ?, profit = ?, status = ?, resultJson = ?
        WHERE orderId = ? AND (closedAt IS NULL OR status = 'unknown')`,
      [
        Date.now(),
        win === true ? 1 : win === false ? 0 : null,
        profit != null && !Number.isNaN(Number(profit)) ? Number(profit) : null,
        status || (win === true ? 'win' : win === false ? 'loss' : 'unknown'),
        result ? JSON.stringify(result) : null,
        String(orderId),
      ]
    );
  } catch (err) {
    console.error('[pocketStore] Imeshindwa kuhifadhi matokeo ya trade:', err.message);
  }
}

async function getOpenTrades() {
  try {
    await ready();
    const r = await db.query(
      `SELECT orderId, pair, direction, stake, expirySeconds, openedAt, expiresAt
         FROM po_trades WHERE closedAt IS NULL ORDER BY openedAt ASC`
    );
    return r.rows || [];
  } catch (err) {
    console.error('[pocketStore] Imeshindwa kusoma trades zilizo wazi:', err.message);
    return [];
  }
}

// Matokeo yaliyohifadhiwa ya trade iliyokwisha kufungwa (au null).
async function getClosedResult(orderId) {
  try {
    await ready();
    const r = await db.query(
      'SELECT resultJson FROM po_trades WHERE orderId = ? AND closedAt IS NOT NULL AND resultJson IS NOT NULL',
      [String(orderId)]
    );
    const row = (r.rows || [])[0];
    return row ? JSON.parse(row.resultJson) : null;
  } catch (err) {
    return null;
  }
}

// Historia ya trades (zilizofungwa + zilizo wazi), mpya kwanza — kwa dashboard.
// Jaza strength ya trades za auto za ZAMANI (kabla ya column kuwepo) kutoka po_signals
// (signalTracker iliandika signal sekunde chache kabla ya order). Best-effort: ikikosa
// mechi (au jedwali halipo) trade inabaki NULL. Inaendeshwa mara moja kwa kila process.
let backfilled = false;
async function backfillStrength() {
  if (backfilled) return;
  backfilled = true;
  try {
    await db.query(
      `UPDATE po_trades SET signalStrength = (
         SELECT s.strength FROM po_signals s
          WHERE s.pair = po_trades.pair AND s.direction = po_trades.direction AND s.source = 'autotrade'
            AND ABS(s.createdAt - po_trades.openedAt) < 120000
          ORDER BY ABS(s.createdAt - po_trades.openedAt) ASC LIMIT 1)
       WHERE source = 'auto' AND signalStrength IS NULL`
    );
  } catch (_) { /* po_signals haipo bado au muundo tofauti — sawa */ }
}

// full:true = kwa export/uchambuzi (hadi trades 20000); vinginevyo cap ni 1000 kama zamani.
const HISTORY_CAP = 1000;
const HISTORY_FULL_CAP = 20000;
async function getTradeHistory(limit = 200, { full = false } = {}) {
  try {
    await ready();
    await backfillStrength();
    const n = Math.min(full ? HISTORY_FULL_CAP : HISTORY_CAP, Math.max(1, parseInt(limit, 10) || 200));
    const r = await db.query(
      `SELECT orderId, pair, direction, stake, expirySeconds, openedAt, expiresAt,
              closedAt, win, profit, status, source, signalStrength
         FROM po_trades ORDER BY openedAt DESC LIMIT ?`,
      [n]
    );
    return r.rows || [];
  } catch (err) {
    console.error('[pocketStore] Imeshindwa kusoma historia:', err.message);
    return [];
  }
}

// Takwimu kwa kila jozi (kwa dashboard ya Blacklist). Trades zilizokamilika tu (WIN/LOSS);
// "tie" (profit 0, win 0 = stake imerudishwa) haihesabiwi. payout = wastani wa (profit/stake) ya ushindi (median).
async function getPairStats({ tf = null, source = 'auto' } = {}) {
  const rows = await getTradeHistory(HISTORY_FULL_CAP, { full: true });
  const map = new Map();
  for (const t of rows) {
    if (t.win !== 1 && t.win !== 0) continue;
    if (source && t.source !== source) continue;
    if (tf && Number(t.expirySeconds) !== Number(tf)) continue;
    const profit = Number(t.profit || 0);
    if (t.win === 0 && profit === 0) continue; // tie
    let s = map.get(t.pair);
    if (!s) map.set(t.pair, (s = { pair: t.pair, trades: 0, wins: 0, losses: 0, net: 0, pay: [] }));
    s.trades++;
    s.net += profit;
    if (t.win === 1) {
      s.wins++;
      if (Number(t.stake) > 0) s.pay.push((profit / Number(t.stake)) * 100);
    } else s.losses++;
  }
  return [...map.values()]
    .map((s) => {
      const pay = s.pay.sort((a, b) => a - b);
      const payout = pay.length ? Math.round(pay[Math.floor(pay.length / 2)]) : null;
      return {
        pair: s.pair,
        trades: s.trades,
        wins: s.wins,
        losses: s.losses,
        winRate: s.trades ? Math.round((s.wins / s.trades) * 1000) / 10 : null,
        net: Math.round(s.net * 100) / 100,
        payout,
        breakeven: payout ? Math.round((10000 / (100 + payout)) * 10) / 10 : null,
      };
    })
    .sort((a, b) => a.net - b.net);
}

// ── Saa za siku. EAT = UTC+3 (Tanzania, hakuna DST). Badilisha kwa env POCKET_TZ_OFFSET. ──
const _tz = Number(process.env.POCKET_TZ_OFFSET);
const TZ_OFFSET_H = process.env.POCKET_TZ_OFFSET && Number.isFinite(_tz) ? _tz : 3;
const localHour = (ms = Date.now()) => new Date(Number(ms) + TZ_OFFSET_H * 3600000).getUTCHours();

// Trades za auto zilizokamilika (WIN/LOSS; tie haihesabiwi). exclude(pair) -> true = ruka jozi hiyo.
async function closedAutoTrades({ tf = null, source = 'auto', exclude = null } = {}) {
  const rows = await getTradeHistory(HISTORY_FULL_CAP, { full: true });
  return rows.filter((t) => {
    if (t.win !== 1 && t.win !== 0) return false;
    if (source && t.source !== source) return false;
    if (tf && Number(t.expirySeconds) !== Number(tf)) return false;
    if (t.win === 0 && Number(t.profit || 0) === 0) return false; // tie
    if (exclude && exclude(t.pair)) return false;
    return true;
  });
}

// Takwimu kwa kila saa ya siku (0-23, saa za EAT) — saa ya KUFUNGULIWA kwa trade.
async function getHourStats(opts = {}) {
  const rows = await closedAutoTrades(opts);
  const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, trades: 0, wins: 0, losses: 0, net: 0, pay: [] }));
  for (const t of rows) {
    const s = hours[localHour(t.openedAt)];
    const profit = Number(t.profit || 0);
    s.trades++;
    s.net += profit;
    if (t.win === 1) {
      s.wins++;
      if (Number(t.stake) > 0) s.pay.push((profit / Number(t.stake)) * 100);
    } else s.losses++;
  }
  return hours.map((s) => {
    const pay = s.pay.sort((a, b) => a - b);
    const payout = pay.length ? Math.round(pay[Math.floor(pay.length / 2)]) : null;
    return {
      hour: s.hour,
      trades: s.trades,
      wins: s.wins,
      losses: s.losses,
      winRate: s.trades ? Math.round((s.wins / s.trades) * 1000) / 10 : null,
      net: Math.round(s.net * 100) / 100,
      payout,
      breakeven: payout ? Math.round((10000 / (100 + payout)) * 10) / 10 : null,
    };
  });
}

// Trades zilizokamilika za saa moja (mpya kwanza). result: all | win | loss.
async function getHourTrades({ hour, limit = 100, result = 'all', ...opts } = {}) {
  const rows = await closedAutoTrades(opts);
  const h = Number(hour);
  const trades = [];
  let total = 0;
  for (const t of rows) {
    if (localHour(t.openedAt) !== h) continue;
    if (result === 'win' && t.win !== 1) continue;
    if (result === 'loss' && t.win !== 0) continue;
    total++;
    if (trades.length < limit) {
      const profit = Number(t.profit || 0);
      trades.push({
        orderId: t.orderId, pair: t.pair, direction: t.direction, stake: t.stake, expirySeconds: t.expirySeconds,
        openedAt: t.openedAt, win: t.win, profit,
        payout: t.win === 1 && Number(t.stake) > 0 ? Math.round((profit / Number(t.stake)) * 100) : null,
      });
    }
  }
  return { total, trades };
}

// ── Kufuta historia ya trades (reset ya rekodi) ─────────────────────────
// Trades ZILIZO WAZI (closedAt IS NULL) HAZIFUTWI kamwe — bot bado inazifuatilia hadi
// matokeo; zikifutwa matokeo yake yangepotea. Zikifungwa zitahesabiwa kwenye rekodi mpya.
// Modes:
//   { mode:'all' }                        -> trades zote zilizofungwa
//   { mode:'date', from:'YYYY-MM-DD', to? } -> kwa tarehe ya KUFUNGULIWA (saa za EAT, au POCKET_TZ_OFFSET)
//   { mode:'last',  count:N }             -> N za MWISHO (mpya zaidi)
//   { mode:'first', count:N }             -> N za KWANZA (za zamani zaidi)
//   { mode:'range', from:a, to:b }        -> nafasi a..b (1 = mpya zaidi) kati ya zilizofungwa
const DAY_MS = 86400000;

function dayStartMs(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || '').trim());
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) return null;
  return probe.getTime() - TZ_OFFSET_H * 3600000;
}

function buildDeleteFilter(opts = {}) {
  const mode = String(opts.mode || '');
  const CLOSED = 'closedAt IS NOT NULL';
  const MAX = 1000000;
  if (mode === 'all') return { where: CLOSED, params: [], label: 'trades zote zilizofungwa' };

  if (mode === 'date') {
    const a = dayStartMs(opts.from);
    const b = dayStartMs(opts.to || opts.from);
    if (a == null) return { error: 'Tarehe ya kuanzia si sahihi. Tumia muundo YYYY-MM-DD (mfano 2026-10-01).' };
    if (b == null) return { error: 'Tarehe ya mwisho si sahihi. Tumia muundo YYYY-MM-DD.' };
    if (b < a) return { error: 'Tarehe ya mwisho iko kabla ya ya kuanzia.' };
    return {
      where: `${CLOSED} AND openedAt >= ? AND openedAt < ?`,
      params: [a, b + DAY_MS],
      createdRange: [a, b + DAY_MS],
      label: opts.to && opts.to !== opts.from ? `trades za ${opts.from} hadi ${opts.to}` : `trades za ${opts.from}`,
    };
  }

  if (mode === 'last' || mode === 'first') {
    const n = parseInt(opts.count, 10);
    if (!Number.isInteger(n) || n < 1 || n > MAX) return { error: 'Idadi lazima iwe namba kuanzia 1.' };
    const dir = mode === 'last' ? 'DESC' : 'ASC';
    return {
      where: `orderId IN (SELECT orderId FROM po_trades WHERE ${CLOSED} ORDER BY openedAt ${dir} LIMIT ?)`,
      params: [n],
      label: mode === 'last' ? `trades ${n} za mwisho` : `trades ${n} za kwanza`,
    };
  }

  if (mode === 'range') {
    const a = parseInt(opts.from, 10);
    const b = parseInt(opts.to, 10);
    if (!Number.isInteger(a) || !Number.isInteger(b) || a < 1 || b < a || b > MAX) {
      return { error: 'Range si sahihi. Mfano: 10-50 (nafasi ya 1 = trade ya hivi karibuni zaidi).' };
    }
    return {
      where: `orderId IN (SELECT orderId FROM po_trades WHERE ${CLOSED} ORDER BY openedAt DESC LIMIT ? OFFSET ?)`,
      params: [b - a + 1, a - 1],
      label: `trades nafasi ${a}-${b} (kutoka mpya zaidi)`,
    };
  }

  return { error: 'Aina ya kufuta si sahihi (all | date | last | first | range).' };
}

// Onyesho la awali: ni nini KINGEFUTWA (hakuna kinachofutwa hapa).
async function previewDeleteTrades(opts = {}) {
  const f = buildDeleteFilter(opts);
  if (f.error) return { ok: false, error: f.error };
  try {
    await ready();
    const r = await db.query(
      `SELECT COUNT(*) AS n,
              COALESCE(SUM(CASE WHEN win = 1 THEN 1 ELSE 0 END), 0) AS wins,
              COALESCE(SUM(CASE WHEN win = 0 THEN 1 ELSE 0 END), 0) AS losses,
              COALESCE(SUM(COALESCE(profit, 0)), 0) AS net,
              MIN(openedAt) AS oldest, MAX(openedAt) AS newest
         FROM po_trades WHERE ${f.where}`,
      f.params
    );
    const row = (r.rows || [])[0] || {};
    const open = await db.query('SELECT COUNT(*) AS n FROM po_trades WHERE closedAt IS NULL');
    const total = await db.query('SELECT COUNT(*) AS n FROM po_trades');
    return {
      ok: true,
      label: f.label,
      count: Number(row.n) || 0,
      wins: Number(row.wins) || 0,
      losses: Number(row.losses) || 0,
      net: Math.round((Number(row.net) || 0) * 100) / 100,
      oldest: row.oldest != null ? Number(row.oldest) : null,
      newest: row.newest != null ? Number(row.newest) : null,
      openProtected: Number(((open.rows || [])[0] || {}).n) || 0,
      totalInDb: Number(((total.rows || [])[0] || {}).n) || 0,
    };
  } catch (err) {
    console.error('[pocketStore] Imeshindwa kukagua trades za kufuta:', err.message);
    return { ok: false, error: `Database imeshindwa: ${err.message}` };
  }
}

// Kufuta kweli kutoka database. `includeSignals`: pia futa rekodi za signals (po_signals) zilizokamilika —
// inatumika kwa mode 'all' (zote) na 'date' (kwa tarehe ya createdAt); mode nyingine haziguzi signals.
async function deleteTrades(opts = {}) {
  const f = buildDeleteFilter(opts);
  if (f.error) return { ok: false, error: f.error };
  try {
    await ready();
    const before = await previewDeleteTrades(opts);
    if (!before.ok) return before;
    const r = await db.query(`DELETE FROM po_trades WHERE ${f.where}`, f.params);
    const deleted = Number(r.rowsAffected);
    const out = { ok: true, label: f.label, deleted: Number.isFinite(deleted) ? deleted : before.count, wins: before.wins, losses: before.losses, net: before.net, signalsDeleted: null };

    if (opts.includeSignals && (opts.mode === 'all' || opts.mode === 'date')) {
      try {
        const sig = opts.mode === 'date'
          ? await db.query("DELETE FROM po_signals WHERE status IS NOT 'pending' AND createdAt >= ? AND createdAt < ?", f.createdRange)
          : await db.query("DELETE FROM po_signals WHERE status IS NOT 'pending'");
        out.signalsDeleted = Number(sig.rowsAffected) || 0;
      } catch (err) {
        // Jedwali la signals linaweza kuwa halipo bado — trades zimeshafutwa, endelea.
        out.signalsError = err.message;
      }
    }
    return out;
  } catch (err) {
    console.error('[pocketStore] Imeshindwa kufuta trades:', err.message);
    return { ok: false, error: `Database imeshindwa: ${err.message}` };
  }
}

// ── Auto-trade (source = 'auto') ────────────────────────────────────────

// Trades za auto ambazo bado ziko wazi (kwa kurejesha hali baada ya restart).
async function getOpenAutoTrades() {
  try {
    await ready();
    const r = await db.query(
      `SELECT orderId, pair, direction, stake, expirySeconds, openedAt, expiresAt
         FROM po_trades WHERE closedAt IS NULL AND source = 'auto' ORDER BY openedAt ASC`
    );
    return r.rows || [];
  } catch (err) {
    console.error('[pocketStore] Imeshindwa kusoma auto-trades zilizo wazi:', err.message);
    return null; // null = DB imeshindwa (tofauti na [] = hakuna)
  }
}

// Hali ya hatari ya auto-trade tangu `sinceMs` (mwanzo wa siku ya UTC):
//   dailyPnl (hasara = -stake; faida = profit chanya), tradesToday, na hasara mfululizo
//   za mwisho (bila ushindi katikati). Rudisha null DB ikishindwa.
async function getAutoRiskState(sinceMs) {
  try {
    await ready();
    const day = await db.query(
      `SELECT COUNT(*) AS n,
              COALESCE(SUM(CASE WHEN win = 1 THEN MAX(COALESCE(profit, 0), 0)
                                WHEN win = 0 THEN -stake ELSE 0 END), 0) AS pnl
         FROM po_trades WHERE source = 'auto' AND openedAt >= ?`,
      [sinceMs]
    );
    const row = (day.rows || [])[0] || {};
    const last = await db.query(
      `SELECT win, closedAt FROM po_trades
        WHERE source = 'auto' AND closedAt IS NOT NULL AND win IS NOT NULL
        ORDER BY closedAt DESC LIMIT 20`
    );
    let consecutiveLosses = 0;
    let lastLossAt = null;
    for (const t of last.rows || []) {
      if (Number(t.win) === 1) break;
      consecutiveLosses++;
      if (lastLossAt == null) lastLossAt = Number(t.closedAt);
    }
    return {
      tradesToday: Number(row.n) || 0,
      dailyPnl: Number(row.pnl) || 0,
      consecutiveLosses,
      lastLossAt,
    };
  } catch (err) {
    console.error('[pocketStore] Imeshindwa kusoma hali ya hatari ya auto-trade:', err.message);
    return null;
  }
}

// Takwimu za jumla za auto-trades zilizofungwa (kwa .poauto stats).
async function getAutoStats(limit = 500) {
  try {
    await ready();
    const r = await db.query(
      `SELECT pair, stake, win, profit FROM po_trades
        WHERE source = 'auto' AND closedAt IS NOT NULL AND win IS NOT NULL
        ORDER BY closedAt DESC LIMIT ?`,
      [limit]
    );
    const rows = r.rows || [];
    let wins = 0, losses = 0, pnl = 0;
    for (const t of rows) {
      if (Number(t.win) === 1) { wins++; pnl += Math.max(Number(t.profit) || 0, 0); }
      else { losses++; pnl -= Number(t.stake) || 0; }
    }
    return { trades: rows.length, wins, losses, pnl };
  } catch (err) {
    console.error('[pocketStore] Imeshindwa kusoma takwimu za auto-trade:', err.message);
    return null;
  }
}

// ── Settings ────────────────────────────────────────────────────────────

async function saveSetting(key, value) {
  try {
    await ready();
    await db.query(
      `INSERT INTO po_settings (settingKey, settingValue, updatedAt) VALUES (?, ?, ?)
       ON CONFLICT(settingKey) DO UPDATE SET settingValue = excluded.settingValue, updatedAt = excluded.updatedAt`,
      [key, typeof value === 'string' ? value : JSON.stringify(value), Date.now()]
    );
  } catch (err) {
    console.error('[pocketStore] Imeshindwa kuhifadhi setting (itafanya kazi hadi restart ijayo):', err.message);
  }
}

async function deleteSetting(key) {
  try {
    await ready();
    await db.query('DELETE FROM po_settings WHERE settingKey = ?', [key]);
  } catch (err) {
    console.error('[pocketStore] Imeshindwa kufuta setting:', err.message);
  }
}

// Rudisha [{ key, value }] kwa settings zote zinazoanza na `prefix`.
async function loadSettings(prefix) {
  try {
    await ready();
    const r = await db.query(
      'SELECT settingKey, settingValue FROM po_settings WHERE settingKey LIKE ?',
      [`${prefix}%`]
    );
    return (r.rows || []).map((row) => ({ key: row.settingKey, value: row.settingValue }));
  } catch (err) {
    console.error('[pocketStore] Imeshindwa kusoma settings:', err.message);
    return [];
  }
}

module.exports = {
  recordOpenTrade,
  recordClosedTrade,
  getOpenTrades,
  getOpenAutoTrades,
  getAutoRiskState,
  getAutoStats,
  getTradeHistory,
  getPairStats,
  getHourStats,
  getHourTrades,
  localHour,
  TZ_OFFSET_H,
  getClosedResult,
  previewDeleteTrades,
  deleteTrades,
  saveSetting,
  deleteSetting,
  loadSettings,
};
