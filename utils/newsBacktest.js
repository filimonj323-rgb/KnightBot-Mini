/**
 * newsBacktest.js — Backtest ya News Trading: matukio ya kihistoria (forecast + actual) + candles za dakika 1 za Deriv.
 *
 * Inatumia kanuni ZILE ZILE za live (newsLogic.scoreEvents/pairDirection): kura ya surprise, mwelekeo, jozi, SL/TP kama
 * asilimia ya stake, kufunga kwa muda, kinga za lag na mwendo wa bei.
 *
 * KUPIMA ATHARI YA KUCHELEWA: kila tukio linaigizwa kwa "delays" kadhaa (mfano 0s, 60s, 120s, 180s, 300s baada ya release).
 * Linganisha matokeo kuona edge inapungua kiasi gani bot ikiingia kuchelewa.
 *
 * MIPAKA (kuwa mwangalifu na matokeo):
 *   - Ni makadirio: candles za dakika 1 → kwenye candle moja SL ikigongwa na TP zote mbili, tunadhani SL ilitangulia (kihafidhina).
 *   - Entry ni bei ya OPEN ya candle husika (hakuna slippage/spread ya wakati wa habari); gharama = commission makadirio
 *     (stake × multiplier × commissionRate).
 *   - Matokeo ni mazuri tu kama data ya matukio; sampuli ndogo (< ~50 trades) haina maana ya kitakwimu.
 *   - Haionyeshi utendaji wa baadaye.
 */
const db = require('../pairing/db');
const observer = require('./newsObserver');
const { pairDirection, scoreEvents } = require('./newsLogic');
const economicCalendar = require('./economicCalendar');
const derivTrader = require('./derivTrader');

const DEFAULTS = {
  stake: 1, multiplier: 100, slPct: 50, tpPct: 100, maxHoldMin: 15,
  minSurprisePct: 10, maxLagMin: 30, maxMovePct: 0, // default: kinga ZIMEZIMWA ili kulinganisha delays; weka true kwenye useGuards kuzitumia
  includeMedium: false, commissionRate: 0.0002,
  delays: [0, 60, 120, 180, 300],
  daysBack: 90, maxGroups: 400, throttleMs: 250,
};
const MAX_TRADES_RETURNED = 200;
const r2 = (n) => Math.round(Number(n) * 100) / 100;
const r3 = (n) => Math.round(Number(n) * 1000) / 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function firstAtOrAfter(candles, sec, maxGapSec) {
  for (let i = 0; i < candles.length; i++) {
    if (candles[i].epoch >= sec) return candles[i].epoch - sec <= maxGapSec ? i : -1;
  }
  return -1;
}

/**
 * Igiza trade moja. candles: [{epoch(sek), open, high, low, close}] zilizopangwa. Inarudisha {skipped} au matokeo ya trade.
 */
function simulateTrade({ candles, releaseMs, direction, delaySec, p }) {
  const relSec = Math.floor(releaseMs / 60000) * 60;
  const i0 = firstAtOrAfter(candles, relSec, 120);
  if (i0 < 0) return { skipped: 'no_candles' };
  if (delaySec > p.maxLagMin * 60) return { skipped: 'late_lag' };
  const iE = firstAtOrAfter(candles, relSec + Math.ceil(delaySec / 60) * 60, 120);
  if (iE < 0) return { skipped: 'no_candles' };

  const dir = direction === 'BUY' ? 1 : -1;
  const p0 = candles[i0].open;
  const pE = candles[iE].open;
  const entryMovePct = r3(((pE - p0) / p0) * 100 * dir);
  if (p.maxMovePct > 0 && entryMovePct >= p.maxMovePct) return { skipped: 'late_move', entryMovePct };

  const notional = p.stake * p.multiplier;
  const slUsd = (p.stake * p.slPct) / 100;
  const tpUsd = (p.stake * p.tpPct) / 100;
  const cost = notional * p.commissionRate;
  const endSec = candles[iE].epoch + p.maxHoldMin * 60;
  const pnl = (price) => notional * ((price - pE) / pE) * dir;

  let exit = null;
  for (let j = iE; j < candles.length; j++) {
    const c = candles[j];
    if (c.epoch >= endSec && j > iE) { exit = { type: 'time', gross: pnl(candles[j - 1].close), idx: j - 1 }; break; }
    const worst = dir > 0 ? c.low : c.high;
    const best = dir > 0 ? c.high : c.low;
    if (pnl(worst) <= -slUsd) { exit = { type: 'sl', gross: -slUsd, idx: j }; break; } // SL kwanza (kihafidhina)
    if (pnl(best) >= tpUsd) { exit = { type: 'tp', gross: tpUsd, idx: j }; break; }
    if (c.epoch + 60 >= endSec) { exit = { type: 'time', gross: pnl(c.close), idx: j }; break; }
  }
  if (!exit) { const last = candles.length - 1; exit = { type: 'time', gross: pnl(candles[last].close), idx: last }; }

  return {
    entryMovePct, exitType: exit.type, gross: r2(exit.gross), cost: r2(cost), net: r2(exit.gross - cost),
    heldMin: r2(((candles[exit.idx].epoch + 60) - candles[iE].epoch) / 60),
  };
}

function summarize(trades) {
  const sorted = [...trades].sort((a, b) => a.at - b.at);
  let wins = 0, losses = 0, sumW = 0, sumL = 0, net = 0, peak = 0, eq = 0, maxDd = 0;
  const exits = { tp: 0, sl: 0, time: 0 };
  for (const t of sorted) {
    net += t.net;
    eq += t.net;
    peak = Math.max(peak, eq);
    maxDd = Math.max(maxDd, peak - eq);
    if (t.net > 0) { wins++; sumW += t.net; } else if (t.net < 0) { losses++; sumL += -t.net; }
    exits[t.exitType] = (exits[t.exitType] || 0) + 1;
  }
  return {
    n: sorted.length, wins, losses,
    winRate: wins + losses ? r2((wins / (wins + losses)) * 100) : 0,
    netTotal: r2(net), avgNet: sorted.length ? r3(net / sorted.length) : 0,
    profitFactor: sumL > 0 ? r2(sumW / sumL) : (sumW > 0 ? null : 0), // null = hakuna hasara (isiyo na mwisho)
    maxDrawdown: r2(maxDd), exits,
  };
}

function groupEvents(events, minSurprisePct) {
  const groups = new Map();
  for (const e of events) {
    const key = `${e.country}|${new Date(e.scheduledAt).toISOString().slice(0, 16)}`;
    if (!groups.has(key)) groups.set(key, { key, currency: e.country, t: Math.floor(e.scheduledAt / 60000) * 60000, events: [] });
    groups.get(key).events.push(e);
  }
  const out = { all: groups.size, noNumbers: 0, noEdge: 0, signals: [] };
  for (const g of groups.values()) {
    const usable = g.events.filter((e) => economicCalendar.parseNumeric(e.forecast) != null && economicCalendar.parseNumeric(e.actual) != null);
    if (!usable.length) { out.noNumbers++; continue; }
    const sc = scoreEvents(usable, minSurprisePct);
    if (sc.net === 0) { out.noEdge++; continue; }
    const pd = pairDirection(g.currency, sc.net > 0);
    out.signals.push({ ...g, pair: pd.pair, direction: pd.direction, surprisePct: r2(sc.maxPct), titles: usable.map((e) => e.title).join('; ') });
  }
  out.signals.sort((a, b) => a.t - b.t);
  return out;
}

function validateParams(input = {}) {
  const p = { ...DEFAULTS, ...input };
  const num = (v, name, min, max) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${name} lazima iwe kati ya ${min} na ${max}.`);
    return n;
  };
  const out = {
    stake: num(p.stake, 'Stake', 0.35, 1000),
    multiplier: num(p.multiplier, 'Multiplier', 1, 1000),
    slPct: num(p.slPct, 'Stop Loss (%)', 10, 100),
    tpPct: num(p.tpPct, 'Take Profit (%)', 10, 500),
    maxHoldMin: Math.round(num(p.maxHoldMin, 'Muda wa juu (dakika)', 1, 120)),
    minSurprisePct: num(p.minSurprisePct, 'Surprise ya chini (%)', 1, 500),
    maxLagMin: num(p.maxLagMin, 'Lag ya juu (dakika)', 1, 30),
    maxMovePct: num(p.maxMovePct, 'Mwendo wa juu (%)', 0, 5),
    includeMedium: p.includeMedium === true,
    commissionRate: num(p.commissionRate, 'Kiwango cha commission', 0, 0.01),
    daysBack: Math.round(num(p.daysBack, 'Siku nyuma', 1, 3650)),
    maxGroups: Math.round(num(p.maxGroups, 'Matukio ya juu', 1, 1000)),
    throttleMs: Math.round(num(p.throttleMs, 'throttleMs', 0, 5000)),
  };
  const delays = (Array.isArray(p.delays) ? p.delays : String(p.delays).split(/[,\s]+/)).map(Number);
  if (!delays.length || delays.length > 8 || delays.some((d) => !Number.isFinite(d) || d < 0 || d > 1800)) {
    throw new Error('Delays: orodha ya hadi namba 8 (sekunde 0-1800), mfano 0,60,120,180,300.');
  }
  out.delays = [...new Set(delays.map((d) => Math.round(d)))].sort((a, b) => a - b);
  out.fromMs = p.fromMs != null ? Number(p.fromMs) : null;
  out.toMs = p.toMs != null ? Number(p.toMs) : null;
  return out;
}

// ── Kazi ya nyuma (background job) ────────────────────────────────────────────────────────────
let job = null;

function publicJob(j, withResult) {
  if (!j) return null;
  return { id: j.id, status: j.status, progress: j.progress, startedAt: j.startedAt, finishedAt: j.finishedAt || null, error: j.error || null, ...(withResult && j.result ? { result: j.result } : {}) };
}

async function execute(j, p, fetchCandles) {
  const to = p.toMs != null ? p.toMs : Date.now();
  const from = p.fromMs != null ? p.fromMs : to - p.daysBack * 86400000;
  j.progress = { phase: 'matukio', done: 0, total: 0 };
  const events = await observer.getEventsBetween({ fromMs: from, toMs: to, impacts: p.includeMedium ? ['High', 'Medium'] : ['High'] });
  const g = groupEvents(events, p.minSurprisePct);
  const signals = g.signals.slice(-p.maxGroups);
  j.progress = { phase: 'candles', done: 0, total: signals.length };

  const trades = Object.fromEntries(p.delays.map((d) => [d, []]));
  const skipped = Object.fromEntries(p.delays.map((d) => [d, { late_lag: 0, late_move: 0, no_candles: 0 }]));
  const maxDelay = Math.max(...p.delays);
  let noCandlesGroups = 0;

  for (const s of signals) {
    if (j.cancel) { j.status = 'cancelled'; return; }
    const relSec = Math.floor(s.t / 1000);
    let candles = null;
    try {
      candles = await fetchCandles(s.pair, '1min', relSec - 60, relSec + (Math.ceil(maxDelay / 60) + p.maxHoldMin + 3) * 60);
    } catch (err) { candles = null; }
    if (!Array.isArray(candles) || candles.length < 2) {
      noCandlesGroups++;
      for (const d of p.delays) skipped[d].no_candles++;
    } else {
      for (const d of p.delays) {
        const r = simulateTrade({ candles, releaseMs: s.t, direction: s.direction, delaySec: d, p });
        if (r.skipped) { skipped[d][r.skipped]++; continue; }
        trades[d].push({
          at: s.t, currency: s.currency, pair: s.pair, direction: s.direction, titles: s.titles.slice(0, 70), surprisePct: s.surprisePct,
          entryMovePct: r.entryMovePct, exitType: r.exitType, gross: r.gross, cost: r.cost, net: r.net, heldMin: r.heldMin,
        });
      }
    }
    j.progress.done++;
    if (p.throttleMs) await sleep(p.throttleMs);
  }

  const byDelay = p.delays.map((d) => ({ delaySec: d, ...summarize(trades[d]), skipped: skipped[d] }));
  const base = p.delays[0];
  const byCurrency = {};
  for (const t of trades[base]) {
    const c = (byCurrency[t.currency] = byCurrency[t.currency] || []);
    c.push(t);
  }
  j.result = {
    createdAt: Date.now(),
    params: { ...p, fromMs: from, toMs: to },
    events: { loaded: events.length, groups: g.all, noNumbers: g.noNumbers, noEdge: g.noEdge, signals: g.signals.length, simulated: signals.length - noCandlesGroups, noCandles: noCandlesGroups },
    byDelay,
    baseDelaySec: base,
    byCurrency: Object.fromEntries(Object.entries(byCurrency).map(([k, v]) => [k, summarize(v)])),
    trades: Object.fromEntries(p.delays.map((d) => [d, [...trades[d]].sort((a, b) => b.at - a.at).slice(0, MAX_TRADES_RETURNED)])),
  };
  j.status = 'done';
  try {
    await db.query(
      `INSERT INTO fx_auto_settings (settingKey, settingValue, updatedAt) VALUES (?, ?, ?)
       ON CONFLICT(settingKey) DO UPDATE SET settingValue = excluded.settingValue, updatedAt = excluded.updatedAt`,
      ['news_backtest_last', JSON.stringify(j.result), Date.now()]
    );
  } catch (_) { /* matokeo yanabaki kwenye RAM */ }
}

/** Anzisha backtest (kazi ya nyuma). Moja tu kwa wakati. */
async function start(input = {}, { fetchCandles } = {}) {
  if (job && job.status === 'running') throw new Error('Backtest nyingine inaendelea — subiri au ighairi.');
  const p = validateParams(input);
  await db.initSchema();
  const fc = fetchCandles || ((pair, interval, a, b) => derivTrader.getCandlesBetween(pair, interval, a, b));
  const j = { id: `bt_${Date.now().toString(36)}`, status: 'running', startedAt: Date.now(), progress: { phase: 'anza', done: 0, total: 0 }, cancel: false };
  job = j;
  execute(j, p, fc)
    .catch((err) => { j.status = 'error'; j.error = err.message; })
    .finally(() => { j.finishedAt = Date.now(); });
  return publicJob(j, false);
}

function cancel() {
  if (job && job.status === 'running') { job.cancel = true; return true; }
  return false;
}

async function getStatus() {
  if (job) return publicJob(job, true);
  // Baada ya restart: rudisha matokeo ya mwisho yaliyohifadhiwa (kama yapo).
  try {
    await db.initSchema();
    const r = await db.query('SELECT settingValue, updatedAt FROM fx_auto_settings WHERE settingKey = ?', ['news_backtest_last']);
    const row = r.rows && r.rows[0];
    if (row) return { id: 'saved', status: 'done', progress: { phase: 'imehifadhiwa', done: 1, total: 1 }, startedAt: Number(row.updatedAt), finishedAt: Number(row.updatedAt), error: null, result: JSON.parse(row.settingValue) };
  } catch (_) { /* hakuna */ }
  return null;
}

module.exports = {
  start, cancel, getStatus, validateParams, DEFAULTS,
  _simulateTrade: simulateTrade, _summarize: summarize, _groupEvents: groupEvents,
};
