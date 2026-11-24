/**
 * scalpTrader.js — Scalping / News trading ya MUDA MFUPI (M1/M5/M15) kwa Deriv Multipliers.
 *
 * INAJITEGEMEA: ina settings zake, jedwali lake (scalp_trades / scalp_settings), na inafuatilia trades ZAKE TU.
 * Haitumii autoTrader.js (hakuna kuingiliana na auto-trade ya kawaida). Inatumia derivTrader.js kwa Deriv
 * (candles, kufungua/kufunga) na economicCalendar.js kwa habari.
 *
 * Mkakati (kwa kila pair kwenye watchlist, pamoja na XAUUSD):
 *   • M15 = upendeleo (EMA20/EMA50 + mteremko)   • M5 = mwelekeo (EMA9/EMA21)
 *   • M1  = kichocheo: "pullback" (rudi kwenye EMA21 + RSI7) au "breakout" (kuvunja high/low ya mishumaa 15 yenye nguvu)
 *   • SL/TP kwa ATR ya M5 (SL = slAtr×ATR, TP = SL×rr), zinabadilishwa kuwa $ kulingana na stake×multiplier.
 *   • News: dirisha la kuzuia (kabla/baada ya tukio la impact kubwa) na dirisha la "post-news" lenye bonus ya breakout.
 *
 * Usalama: auto-trade imezimwa kwa default; kwenye akaunti ya REAL inahitaji ruhusa ya wazi (allowRealAuto);
 * kikomo cha hasara ya siku, hasara mfululizo, max trades wazi, cooldown kwa pair, na time-stop.
 */

const db = require('../pairing/db');
const derivTrader = require('./derivTrader');
const economicCalendar = require('./economicCalendar');
const scalpRegistry = require('./scalpRegistry');

// ── Katalogi ya instruments zinazoruhusiwa ─────────────────────────────────────────────
// Scalp inaruhusu pairs zenye MOVEMENT KUBWA tu (ATR/range kubwa — scalp ina nafasi ya kufikia TP kabla ya spread kula faida).
// Pairs za movement ndogo (EURUSD, USDCAD, USDCHF, AUDUSD, NZDUSD, EURGBP, USDJPY) zimeondolewa hapa na zinabaki kwenye FX (fxtrading) pekee.
const CATALOG = {
  XAUUSD: { label: 'Gold (XAU/USD)', ccy: ['USD'], kind: 'metal', hot: true },
  GBPJPY: { label: 'GBP/JPY', ccy: ['GBP', 'JPY'], kind: 'volatile', hot: true },
  GBPUSD: { label: 'GBP/USD', ccy: ['GBP', 'USD'], kind: 'major', hot: true },
  EURJPY: { label: 'EUR/JPY', ccy: ['EUR', 'JPY'], kind: 'cross', hot: true },
  AUDJPY: { label: 'AUD/JPY', ccy: ['AUD', 'JPY'], kind: 'cross', hot: true },
  NZDJPY: { label: 'NZD/JPY', ccy: ['NZD', 'JPY'], kind: 'cross', hot: true },
  CADJPY: { label: 'CAD/JPY', ccy: ['CAD', 'JPY'], kind: 'cross', hot: true },
  GBPCHF: { label: 'GBP/CHF', ccy: ['GBP', 'CHF'], kind: 'volatile', hot: true },
};
const DEFAULT_PAIRS = ['XAUUSD', 'GBPJPY', 'GBPUSD', 'EURJPY', 'AUDJPY'];

const DEFAULTS = {
  pairs: DEFAULT_PAIRS,
  autoEnabled: false,
  allowRealAuto: false,
  stake: 2,
  multiplier: 100,
  slMode: 'atr',     // 'atr' = SL/TP kutoka ATR(M5); 'fixed' = kiasi cha $ unachoweka mwenyewe
  slAtr: 0.8,        // (atr) SL = slAtr × ATR(M5)
  rr: 1.5,           // (atr) TP = SL × rr
  slFixed: 0.5,      // (fixed) SL kwa $
  tpFixed: 0.75,     // (fixed) TP kwa $
  minStrength: 75,   // nguvu ya chini ya signal kwa auto
  maxOpen: 3,
  maxDailyLoss: 6,   // $ — hasara ya jumla ya siku (UTC) ikifika, auto inasimama hadi kesho
  maxConsecLosses: 3,
  cooldownMin: 10,   // dk kwa pair baada ya kufunga
  timeStopMin: 20,   // auto: funga trade ikizidi dk hizi (0 = zima)
  newsPreMin: 10,    // dk kabla ya tukio la impact kubwa: usifungue
  newsPostMin: 3,    // dk baada ya tukio: usifungue (spike/spread)
  newsImpact: 'High', // 'High' | 'Medium' (Medium inajumuisha High)
  sessionOnly: true,
  sessionStartUtc: 6,
  sessionEndUtc: 21,
  minAtrPct: 0.025,  // ATR(M5) ya chini kama % ya bei: pair ikiwa "imelala" (chini ya hii) auto haifungui (movement ndogo)
  maxAutoPerHour: 6, // kikomo cha trades za AUTO kwa saa (kinga dhidi ya kufungua kupita kiasi)
  realStakeCap: 5,   // REAL: stake ya juu kwa trade ya scalp ($) — juu ya hapo inapunguzwa
};
const LIMITS = {
  stake: [1, 50], multiplier: [100, 800], slAtr: [0.3, 3], rr: [0.8, 4], slFixed: [0.1, 100], tpFixed: [0.1, 500], minStrength: [50, 100],
  maxOpen: [1, 6], maxDailyLoss: [1, 200], maxConsecLosses: [1, 10], cooldownMin: [0, 240],
  timeStopMin: [0, 240], newsPreMin: [0, 60], newsPostMin: [0, 30], sessionStartUtc: [0, 23], sessionEndUtc: [1, 24],
  minAtrPct: [0, 0.5], maxAutoPerHour: [1, 30], realStakeCap: [1, 50],
};

let settings = { ...DEFAULTS };
let settingsLoaded = false;
let schemaReady = false;
let notifier = null;
let timer = null;
let ticking = false;
let lastViewAt = 0;
let lastScanAt = 0;
let lastTickAt = 0;
let lastAutoNote = '—';
let pausedUntil = 0;
let pauseReason = null;
let scanning = null;
const signals = new Map();   // pair -> analysis
const cooldowns = new Map(); // pair -> ms mpaka
const missingSince = new Map(); // contractId -> ms (haipo kwenye portfolio)
const candleCache = new Map();  // `${pair}|${tf}` -> { at, data }
const CANDLE_TTL = { '1min': 12000, '5min': 55000, '15min': 170000 };

const num = (x, d = NaN) => { const n = Number(x); return Number.isFinite(n) ? n : d; };
const r2 = (x) => Math.round(x * 100) / 100;
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const startOfUtcDay = (ts = Date.now()) => Math.floor(ts / 86400000) * 86400000;
const say = (text) => { try { if (typeof notifier === 'function') Promise.resolve(notifier(text)).catch(() => {}); } catch (_) { /* ignore */ } };

// ── DB ─────────────────────────────────────────────────────────────────────────────────
async function ensureSchema() {
  if (schemaReady) return;
  await db.query(`CREATE TABLE IF NOT EXISTS scalp_settings (k TEXT PRIMARY KEY, v TEXT)`, []);
  await db.query(`CREATE TABLE IF NOT EXISTS scalp_trades (
    contractId TEXT PRIMARY KEY, pair TEXT, direction TEXT, stake REAL, multiplier INTEGER, slUsd REAL, tpUsd REAL,
    buyPrice REAL, openedAt INTEGER, closedAt INTEGER, sellPrice REAL, profit REAL, source TEXT, mode TEXT,
    strength REAL, accountMode TEXT, reason TEXT)`, []);
  schemaReady = true;
  await scalpRegistry.ensureLoaded();
}

async function loadSettings() {
  if (settingsLoaded) return settings;
  try {
    await ensureSchema();
    const r = await db.query(`SELECT v FROM scalp_settings WHERE k = 'settings'`, []);
    if (r.rows && r.rows[0]) settings = sanitize({ ...DEFAULTS, ...JSON.parse(r.rows[0].v) });
  } catch (err) {
    console.error('[scalp] imeshindwa kusoma settings (inatumia default):', err.message);
  }
  settingsLoaded = true;
  return settings;
}

async function saveSettings() {
  try {
    await ensureSchema();
    await db.query(`INSERT OR REPLACE INTO scalp_settings (k, v) VALUES ('settings', ?)`, [JSON.stringify(settings)]);
  } catch (err) { console.error('[scalp] imeshindwa kuhifadhi settings:', err.message); }
}

function sanitize(s) {
  const out = { ...DEFAULTS, ...s };
  for (const [k, [lo, hi]] of Object.entries(LIMITS)) out[k] = clamp(num(out[k], DEFAULTS[k]), lo, hi);
  out.maxOpen = Math.round(out.maxOpen); out.maxConsecLosses = Math.round(out.maxConsecLosses); out.maxAutoPerHour = Math.round(out.maxAutoPerHour);
  out.multiplier = [100, 200, 300, 500, 800].reduce((a, b) => (Math.abs(b - out.multiplier) < Math.abs(a - out.multiplier) ? b : a));
  out.pairs = [...new Set((Array.isArray(out.pairs) ? out.pairs : DEFAULT_PAIRS).map((p) => String(p).toUpperCase()).filter((p) => CATALOG[p]))];
  if (!out.pairs.length) out.pairs = DEFAULT_PAIRS.slice();
  for (const k of ['autoEnabled', 'allowRealAuto', 'sessionOnly']) out[k] = !!out[k];
  out.newsImpact = out.newsImpact === 'Medium' ? 'Medium' : 'High';
  out.slMode = out.slMode === 'fixed' ? 'fixed' : 'atr';
  return out;
}

async function setSettings(patch = {}) {
  await loadSettings();
  const clean = {}; // ruhusu funguo zinazojulikana tu (hakuna data isiyotarajiwa kwenye settings)
  for (const k of Object.keys(DEFAULTS)) if (Object.prototype.hasOwnProperty.call(patch || {}, k)) clean[k] = patch[k];
  const next = sanitize({ ...settings, ...clean });
  const turnedOn = next.autoEnabled && !settings.autoEnabled;
  settings = next;
  if (turnedOn) { pausedUntil = 0; pauseReason = null; }
  await saveSettings();
  return settings;
}

// ── Indicators ─────────────────────────────────────────────────────────────────────────
function ema(vals, p) {
  const k = 2 / (p + 1); const out = []; let prev;
  vals.forEach((v, i) => { prev = i === 0 ? v : v * k + prev * (1 - k); out.push(prev); });
  return out;
}
function atr(c, p = 14) {
  if (c.length < 2) return NaN;
  const tr = c.map((x, i) => (i === 0 ? x.high - x.low : Math.max(x.high - x.low, Math.abs(x.high - c[i - 1].close), Math.abs(x.low - c[i - 1].close))));
  let a = tr.slice(0, p).reduce((s, v) => s + v, 0) / Math.min(p, tr.length);
  for (let i = p; i < tr.length; i++) a = (a * (p - 1) + tr[i]) / p;
  return a;
}
function rsi(closes, p = 7) {
  if (closes.length <= p) return closes.map(() => 50);
  const out = Array(closes.length).fill(50); let g = 0; let l = 0;
  for (let i = 1; i <= p; i++) { const d = closes[i] - closes[i - 1]; if (d >= 0) g += d; else l -= d; }
  g /= p; l /= p; out[p] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  for (let i = p + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    g = (g * (p - 1) + Math.max(d, 0)) / p; l = (l * (p - 1) + Math.max(-d, 0)) / p;
    out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  return out;
}

async function candles(pair, tf, n) {
  const key = `${pair}|${tf}`; const hit = candleCache.get(key);
  if (hit && Date.now() - hit.at < (CANDLE_TTL[tf] || 30000)) return hit.data;
  const data = await derivTrader.getCandles(pair, tf, n);
  candleCache.set(key, { at: Date.now(), data });
  return data;
}

// ── Habari ─────────────────────────────────────────────────────────────────────────────
function currenciesOf(pair) { return (CATALOG[pair] && CATALOG[pair].ccy) || []; }
const impactOk = (impact, level) => (level === 'Medium' ? /high|medium/i.test(impact || '') : /high/i.test(impact || ''));

function newsStateFrom(events, pair, now = Date.now()) {
  const ccys = currenciesOf(pair); const pre = settings.newsPreMin * 60000; const post = settings.newsPostMin * 60000;
  const mine = events
    .filter((e) => ccys.includes(e.country) && impactOk(e.impact, settings.newsImpact) && e.date)
    .map((e) => ({ ...e, t: new Date(e.date).getTime() })).filter((e) => Number.isFinite(e.t)).sort((a, b) => a.t - b.t);
  let state = 'clear'; let focus = null;
  for (const e of mine) {
    if (now >= e.t - pre && now <= e.t + post) { state = 'blackout'; focus = e; break; }
    if (now > e.t + post && now <= e.t + post + 20 * 60000) { state = 'post'; focus = e; }
  }
  const next = mine.find((e) => e.t > now && !(state === 'blackout' && focus && e.t === focus.t));
  const pick = (e) => (e ? { title: e.title, country: e.country, impact: e.impact, date: e.date, inMin: Math.round((e.t - now) / 60000), forecast: e.forecast, previous: e.previous, actual: e.actual } : null);
  return { state, event: pick(focus), next: pick(next) };
}

async function loadEvents() {
  try {
    const wk = await economicCalendar.getWeekView(['USD', 'EUR', 'GBP', 'JPY', 'AUD', 'CAD', 'CHF', 'NZD']);
    return wk && wk.available ? wk.events : [];
  } catch (_) { return []; }
}

// ── Uchambuzi wa pair moja ─────────────────────────────────────────────────────────────
function liquid(pair, hourUtc) {
  const c = currenciesOf(pair);
  const asia = hourUtc >= 0 && hourUtc < 8; const eu = hourUtc >= 7 && hourUtc < 16; const us = hourUtc >= 12 && hourUtc < 21;
  if (c.includes('JPY') || c.includes('AUD') || c.includes('NZD')) return asia || eu || us;
  return eu || us;
}

async function analyze(pair, events) {
  const [m1, m5, m15] = await Promise.all([candles(pair, '1min', 150), candles(pair, '5min', 120), candles(pair, '15min', 100)]);
  if (m1.length < 40 || m5.length < 40 || m15.length < 40) throw new Error('Candles hazitoshi');
  const c1 = m1.map((x) => x.close); const c5 = m5.map((x) => x.close); const c15 = m15.map((x) => x.close);
  const price = c1[c1.length - 1]; const L = c1.length - 1;

  const e20 = ema(c15, 20); const e50 = ema(c15, 50); const sl15 = e20[e20.length - 1] - e20[e20.length - 4];
  const bias15 = e20[e20.length - 1] > e50[e50.length - 1] && sl15 > 0 ? 1 : e20[e20.length - 1] < e50[e50.length - 1] && sl15 < 0 ? -1 : 0;
  const e9_5 = ema(c5, 9); const e21_5 = ema(c5, 21); const last5 = c5[c5.length - 1];
  const t5 = e9_5[e9_5.length - 1] > e21_5[e21_5.length - 1] && last5 > e21_5[e21_5.length - 1] ? 1
    : e9_5[e9_5.length - 1] < e21_5[e21_5.length - 1] && last5 < e21_5[e21_5.length - 1] ? -1 : 0;

  const e9 = ema(c1, 9); const e21 = ema(c1, 21); const rs = rsi(c1, 7); const atr1 = atr(m1, 14); const atr5 = atr(m5, 14);
  const lastRsi = rs[L];

  // Kichocheo cha M1
  let dir = 0; let mode = null; const notes = [];
  const rec = m1.slice(-7, -1); const recRsi = rs.slice(-7, -1);
  if (t5 !== 0) {
    const pullback = t5 === 1
      ? (rec.some((x) => x.low <= e21[L]) || Math.min(...recRsi) < 40) && price > e9[L] && price > c1[L - 1] && lastRsi > 45
      : (rec.some((x) => x.high >= e21[L]) || Math.max(...recRsi) > 60) && price < e9[L] && price < c1[L - 1] && lastRsi < 55;
    if (pullback) { dir = t5; mode = 'pullback'; notes.push('Pullback kwenye EMA21 (M1) kuelekea mwelekeo wa M5'); }
  }
  const prior = m1.slice(-16, -1); const hh = Math.max(...prior.map((x) => x.high)); const ll = Math.min(...prior.map((x) => x.low));
  const rng = m1[L].high - m1[L].low;
  if (!mode && rng > 1.2 * atr1) {
    if (price > hh + 0.1 * atr1 && t5 !== -1) { dir = 1; mode = 'breakout'; notes.push('Breakout juu ya high ya mishumaa 15 (momentum)'); }
    else if (price < ll - 0.1 * atr1 && t5 !== 1) { dir = -1; mode = 'breakout'; notes.push('Breakout chini ya low ya mishumaa 15 (momentum)'); }
  }

  const news = newsStateFrom(events || [], pair);
  let strength = 0;
  if (dir !== 0) {
    strength += mode ? 30 : 0;
    strength += t5 === dir ? 25 : 0;
    strength += bias15 === dir ? 25 : bias15 === -dir ? -15 : 0;
    strength += (dir === 1 ? lastRsi < 80 : lastRsi > 20) ? 5 : -10;
    strength += liquid(pair, new Date().getUTCHours()) ? 10 : 0;
    if (mode === 'breakout' && t5 === dir && bias15 === dir) strength += 5;
    if (news.state === 'post' && mode === 'breakout') { strength += 10; notes.push('Dirisha la post-news: momentum inaruhusiwa'); }
  } else {
    strength = (t5 !== 0 ? 20 : 0) + (bias15 === t5 && t5 !== 0 ? 20 : 0);
  }
  strength = clamp(Math.round(strength), 0, 100);
  if (news.state === 'blackout') notes.push(`⛔ Habari kubwa (${news.event && news.event.title}) — usifungue sasa`);
  if (bias15 === -dir && dir !== 0) notes.push('M15 inapingana — hatari kubwa');

  return {
    pair, label: CATALOG[pair].label, kind: CATALOG[pair].kind, price,
    direction: dir === 1 ? 'BUY' : dir === -1 ? 'SELL' : 'NEUTRAL', lean: t5 === 1 ? 'BUY' : t5 === -1 ? 'SELL' : null,
    strength, mode, notes,
    tf: { m15: bias15, m5: t5, m1: dir }, rsi: Number(lastRsi.toFixed(1)),
    atr1, atr5, atrPct5: Number(((atr5 / price) * 100).toFixed(3)),
    news, checkedAt: Date.now(),
  };
}

/** Kokotoa SL/TP ($) kutoka ATR ya M5 kwa stake/multiplier. */
function sizing(sig, stake, multiplier, o = {}) {
  const k0 = (stake * multiplier) / sig.price; // $ kwa kila 1 ya bei
  if ((o.slMode || settings.slMode) === 'fixed') {
    const slUsd = r2(clamp(num(o.slFixed, settings.slFixed), 0.1, stake * 0.9)); const tpUsd = r2(Math.max(0.1, num(o.tpFixed, settings.tpFixed)));
    return { slUsd, tpUsd, slDist: slUsd / k0, tpDist: tpUsd / k0, riskUsd: slUsd, rewardUsd: tpUsd, rr: Number((tpUsd / slUsd).toFixed(2)), mode: 'fixed' };
  }
  const slAtr = num(o.slAtr, settings.slAtr); const rr = num(o.rr, settings.rr);
  const slDist = Math.max(slAtr * sig.atr5, sig.price * 0.0002);
  const k = (stake * multiplier) / sig.price; // $ kwa kila 1 ya bei
  let slUsd = clamp(slDist * k, 0.1, stake * 0.9);
  const slDistEff = slUsd / k; const tpUsd = Math.max(0.1, slUsd * rr);
  return { slUsd: r2(slUsd), tpUsd: r2(tpUsd), slDist: slDistEff, tpDist: slDistEff * rr, riskUsd: r2(slUsd), rewardUsd: r2(tpUsd), rr, mode: 'atr' };
}

// ── Scan ya watchlist ──────────────────────────────────────────────────────────────────
async function scan() {
  if (scanning) return scanning;
  scanning = (async () => {
    await loadSettings();
    const events = await loadEvents();
    for (const pair of settings.pairs) {
      try {
        const a = await analyze(pair, events);
        signals.set(pair, a);
      } catch (err) {
        const prev = signals.get(pair) || { pair, label: CATALOG[pair].label, kind: CATALOG[pair].kind, direction: 'NEUTRAL', strength: 0 };
        signals.set(pair, { ...prev, error: err.message, checkedAt: Date.now() });
      }
    }
    for (const p of [...signals.keys()]) if (!settings.pairs.includes(p)) signals.delete(p);
    lastScanAt = Date.now();
    return [...signals.values()];
  })().finally(() => { scanning = null; });
  return scanning;
}

// ── Rekodi za trades ───────────────────────────────────────────────────────────────────
async function openRows() {
  await ensureSchema();
  return (await db.query('SELECT * FROM scalp_trades WHERE closedAt IS NULL ORDER BY openedAt ASC', [])).rows || [];
}
async function history(limit = 50) {
  await ensureSchema();
  const n = clamp(Math.round(num(limit, 50)), 1, 300);
  return (await db.query('SELECT * FROM scalp_trades WHERE closedAt IS NOT NULL ORDER BY closedAt DESC LIMIT ?', [n])).rows || [];
}
async function stats() {
  await ensureSchema();
  const agg = async (from) => {
    const r = await db.query(
      `SELECT COUNT(*) AS n, SUM(CASE WHEN profit > 0 THEN 1 ELSE 0 END) AS w, SUM(CASE WHEN profit < 0 THEN 1 ELSE 0 END) AS l,
              COALESCE(SUM(profit),0) AS net, COALESCE(SUM(CASE WHEN profit > 0 THEN profit END),0) AS gp, COALESCE(SUM(CASE WHEN profit < 0 THEN profit END),0) AS gl
       FROM scalp_trades WHERE closedAt IS NOT NULL AND profit IS NOT NULL AND closedAt >= ?`, [from]);
    const x = (r.rows && r.rows[0]) || {}; const w = num(x.w, 0); const l = num(x.l, 0);
    return { trades: num(x.n, 0), wins: w, losses: l, winRate: w + l ? Number(((w / (w + l)) * 100).toFixed(1)) : null, net: r2(num(x.net, 0)), grossProfit: r2(num(x.gp, 0)), grossLoss: r2(num(x.gl, 0)) };
  };
  const byPair = (await db.query(
    `SELECT pair, COUNT(*) AS n, COALESCE(SUM(profit),0) AS net FROM scalp_trades WHERE closedAt IS NOT NULL AND profit IS NOT NULL GROUP BY pair ORDER BY net DESC`, [])).rows || [];
  return { today: await agg(startOfUtcDay()), all: await agg(0), byPair: byPair.map((x) => ({ pair: x.pair, trades: num(x.n, 0), net: r2(num(x.net, 0)) })) };
}

async function recordClosed(row, profit, sellPrice) {
  await db.query('UPDATE scalp_trades SET closedAt = ?, profit = ?, sellPrice = ? WHERE contractId = ? AND closedAt IS NULL',
    [Date.now(), Number.isFinite(profit) ? profit : null, Number.isFinite(sellPrice) ? sellPrice : null, String(row.contractId)]);
  cooldowns.set(row.pair, Date.now() + settings.cooldownMin * 60000);
  missingSince.delete(String(row.contractId));
  say(`${Number.isFinite(profit) ? (profit >= 0 ? '✅' : '🔴') : '⚪'} *SCALP IMEFUNGWA — ${row.pair}* (${row.direction})\n` +
    (Number.isFinite(profit) ? `Matokeo: ${profit >= 0 ? '+' : '-'}$${Math.abs(profit).toFixed(2)}` : 'Matokeo hayajulikani — angalia Deriv') + `\n🆔 ${row.contractId}`);
}

/** Linganisha trades zetu zilizo wazi na Deriv; zilizofungwa zinarekodiwa na faida halisi. */
async function reconcile() {
  const rows = await openRows();
  if (!rows.length) return { open: 0 };
  let live;
  try { live = await derivTrader.getOpenPositions(); } catch (err) { return { open: rows.length, error: err.message }; }
  const liveIds = new Set(live.map((p) => String(p.contract_id)));
  for (const row of rows) {
    const id = String(row.contractId);
    if (liveIds.has(id)) { missingSince.delete(id); continue; }
    let d = null; try { d = await derivTrader.getContractDetails(id); } catch (_) { /* endelea */ }
    let profit = NaN; let sell = NaN;
    if (d && derivTrader.isClosedState(d)) { profit = num(d.profit); sell = num(d.sell_price); }
    if (!Number.isFinite(profit)) {
      try {
        const h = await derivTrader.getClosedContractFromHistory(id);
        if (h) { sell = num(h.sell_price); profit = num(h.profit, sell - num(h.buy_price)); }
      } catch (_) { /* endelea */ }
    }
    if (Number.isFinite(profit)) { await recordClosed(row, profit, sell); continue; }
    if (d && derivTrader.isExpiredUnsold(d)) { try { await derivTrader.trySettleExpired(id); } catch (_) { /* itajaribiwa tena */ } }
    else if (d && !derivTrader.isClosedState(d)) continue; // portfolio inachelewa — bado wazi
    const since = missingSince.get(id) || Date.now(); missingSince.set(id, since);
    if (Date.now() - since > 10 * 60000) await recordClosed(row, NaN, NaN); // imekwama: funga rekodi bila faida inayojulikana
  }
  return { open: rows.length };
}

async function pnlToday() {
  await ensureSchema();
  const r = await db.query('SELECT COALESCE(SUM(profit),0) AS p FROM scalp_trades WHERE closedAt >= ? AND profit IS NOT NULL', [startOfUtcDay()]);
  return num(r.rows && r.rows[0] && r.rows[0].p, 0);
}
async function consecutiveAutoLosses() {
  const r = await db.query(`SELECT profit FROM scalp_trades WHERE source = 'auto' AND closedAt IS NOT NULL AND profit IS NOT NULL ORDER BY closedAt DESC LIMIT ?`, [settings.maxConsecLosses]);
  const p = (r.rows || []).map((x) => num(x.profit)); return p.length >= settings.maxConsecLosses && p.every((x) => x < 0);
}

// ── Kufungua / kufunga ─────────────────────────────────────────────────────────────────
const inBlackout = (sig) => sig && sig.news && sig.news.state === 'blackout';
/** Soko "limelala": ATR(M5) kama % ya bei iko chini ya kiwango — scalp haina maana (spread inakula TP). */
const lowMovement = (sig) => Number.isFinite(sig && sig.atrPct5) && sig.atrPct5 < settings.minAtrPct;
async function autoOpenedLastHour() {
  const r = await db.query(`SELECT COUNT(*) AS n FROM scalp_trades WHERE source = 'auto' AND openedAt >= ?`, [Date.now() - 3600000]);
  return num(r.rows && r.rows[0] && r.rows[0].n, 0);
}

async function previewTrade({ pair, direction, stake, multiplier }) {
  await loadSettings();
  pair = String(pair || '').toUpperCase();
  if (!CATALOG[pair]) throw new Error(`Pair "${pair}" haitambuliki.`);
  const sig = signals.get(pair) && !signals.get(pair).error ? signals.get(pair) : (await scan(), signals.get(pair));
  if (!sig || sig.error || !sig.atr5) throw new Error(`Data ya ${pair} haipatikani sasa: ${(sig && sig.error) || 'jaribu tena'}`);
  const st = clamp(num(stake, settings.stake), 1, 50); const mu = num(multiplier, settings.multiplier);
  return { pair, direction: direction === 'SELL' ? 'SELL' : 'BUY', stake: st, multiplier: mu, price: sig.price, atr5: sig.atr5, news: sig.news, ...sizing(sig, st, mu) };
}

async function openTrade({ pair, direction, stake, multiplier, slUsd, tpUsd, source = 'manual', force = false, strength = null, mode = null, confirmReal = false }) {
  await loadSettings(); await ensureSchema();
  pair = String(pair || '').toUpperCase();
  if (!CATALOG[pair]) throw new Error(`Pair "${pair}" haitambuliki kwenye Scalp (ni pairs zenye movement kubwa tu; nyingine zinabaki FX).`);
  if (direction !== 'BUY' && direction !== 'SELL') throw new Error('Direction lazima iwe BUY au SELL.');
  const accMode = derivTrader.getAccountMode ? derivTrader.getAccountMode() : null;
  // Usalama: trade ya MKONO kwenye akaunti ya REAL inahitaji uthibitisho wa wazi (ukurasa unauliza; server inadai PIN ikiwa FX_REAL_PIN ipo).
  if (source === 'manual' && accMode === 'real' && !confirmReal) {
    const e = new Error('Akaunti ni REAL (pesa halisi) — thibitisha kufungua trade hii.'); e.code = 'REAL_CONFIRM'; throw e;
  }
  const sig = signals.get(pair);
  if (source === 'auto' && inBlackout(sig)) throw new Error('Dirisha la habari kubwa.');
  if (source === 'manual' && inBlackout(sig) && !force) { const e = new Error(`Habari kubwa (${sig.news.event && sig.news.event.title}) — thibitisha kuendelea.`); e.code = 'NEWS_BLACKOUT'; throw e; }
  // Kikomo cha trades wazi cha Scalp (kinahesabu trades za scalp TU, si za fx).
  const openNow = await openRows();
  if (openNow.length >= settings.maxOpen + (source === 'manual' ? 2 : 0)) throw new Error(`Trades za Scalp zilizo wazi zimefika kikomo (${openNow.length}).`);
  if (openNow.some((r) => r.pair === pair)) { const e = new Error(`${pair} tayari ina trade ya Scalp iliyo wazi.`); e.code = 'DUPLICATE_OPEN'; throw e; }
  let useStake = stake;
  if (accMode === 'real') useStake = Math.min(num(stake, settings.stake), settings.realStakeCap); // kikomo cha stake kwenye REAL
  const p = await previewTrade({ pair, direction, stake: useStake, multiplier });
  const sl = num(slUsd) > 0 ? Math.min(num(slUsd), p.stake * 0.9) : p.slUsd; const tp = num(tpUsd) > 0 ? num(tpUsd) : p.tpUsd;
  // scope:'scalp' → ulinzi wa "pair moja" unaangalia trades za scalp TU; trade ya fx kwenye pair ileile HAIZUII (na kinyume chake).
  const result = await derivTrader.placeMultiplier({ pair, direction, stake: p.stake, stopLoss: sl, takeProfit: tp, multiplier: p.multiplier, scope: 'scalp' });
  scalpRegistry.addScalpContract(result.contract_id); // tia alama MARA MOJA — autoTrader isinase kama yake
  const accountMode = accMode;
  await db.query(
    `INSERT OR REPLACE INTO scalp_trades (contractId, pair, direction, stake, multiplier, slUsd, tpUsd, buyPrice, openedAt, source, mode, strength, accountMode)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [String(result.contract_id), pair, direction, p.stake, p.multiplier, num(result.stop_loss, sl), num(result.take_profit, tp), num(result.buy_price, null), Date.now(), source, mode, strength, accountMode]);
  say(`⚡ *SCALP ${source === 'auto' ? '(AUTO) ' : ''}IMEFUNGULIWA*\n${direction === 'BUY' ? '🟢 BUY' : '🔴 SELL'} *${pair}* — stake $${p.stake} x${p.multiplier}\nSL $${num(result.stop_loss, sl)} • TP $${num(result.take_profit, tp)}\n🆔 ${result.contract_id}`);
  return { contractId: String(result.contract_id), pair, direction, stake: p.stake, multiplier: p.multiplier, stopLoss: result.stop_loss, takeProfit: result.take_profit, buyPrice: result.buy_price, commission: result.commission };
}

async function closeTrade(contractId) {
  await ensureSchema();
  const id = String(contractId).trim();
  if (!/^\d{5,20}$/.test(id)) throw new Error('contract_id si sahihi.');
  const row = ((await db.query('SELECT * FROM scalp_trades WHERE contractId = ?', [id])).rows || [])[0];
  if (!row) throw new Error('Trade hii si ya Scalp (funga kupitia fxtrading).');
  const r = await derivTrader.closeContractWithPnL(id);
  const profit = num(r && r.profit); const sell = num(r && r.sold_for);
  if (row.closedAt == null) await recordClosed(row, profit, sell);
  return { contractId: id, profit: Number.isFinite(profit) ? profit : null };
}

async function closeAllScalp() {
  const rows = await openRows(); const out = [];
  for (const row of rows) {
    try { out.push({ contractId: row.contractId, ok: true, ...(await closeTrade(row.contractId)) }); }
    catch (err) { out.push({ contractId: row.contractId, ok: false, error: err.message }); }
  }
  return out;
}

// ── Injini ya auto ─────────────────────────────────────────────────────────────────────
function allowedNow() {
  if (!settings.sessionOnly) return true;
  const h = new Date().getUTCHours(); const a = settings.sessionStartUtc; const b = settings.sessionEndUtc;
  return a <= b ? h >= a && h < b : h >= a || h < b;
}

async function autoStep() {
  if (!settings.autoEnabled) { lastAutoNote = 'Auto imezimwa'; return; }
  const mode = derivTrader.getAccountMode ? derivTrader.getAccountMode() : null;
  if (mode === 'real' && !settings.allowRealAuto) { lastAutoNote = 'Akaunti ni REAL — auto imezuiwa (washa "Ruhusu auto kwenye REAL")'; return; }
  if (Date.now() < pausedUntil) { lastAutoNote = `Imesimamishwa: ${pauseReason}`; return; }
  if (!allowedNow()) { lastAutoNote = `Nje ya muda wa kufanya kazi (${settings.sessionStartUtc}:00–${settings.sessionEndUtc}:00 UTC)`; return; }
  const pnl = await pnlToday();
  if (pnl <= -settings.maxDailyLoss) { pausedUntil = startOfUtcDay() + 86400000; pauseReason = `Hasara ya siku $${Math.abs(pnl).toFixed(2)} (kikomo $${settings.maxDailyLoss})`; say(`🛑 *SCALP IMESIMAMISHWA LEO*\n${pauseReason}`); return; }
  if (await consecutiveAutoLosses()) { pausedUntil = Date.now() + 60 * 60000; pauseReason = `Hasara ${settings.maxConsecLosses} mfululizo — pumziko saa 1`; say(`🛑 *SCALP IMESIMAMISHWA*\n${pauseReason}`); return; }
  const rows = await openRows();
  // time-stop (auto pekee)
  if (settings.timeStopMin > 0) {
    for (const row of rows) {
      if (row.source === 'auto' && Date.now() - num(row.openedAt, Date.now()) > settings.timeStopMin * 60000) {
        try { await closeTrade(row.contractId); say(`⏱️ Time-stop: ${row.pair} imefungwa baada ya dk ${settings.timeStopMin}.`); } catch (err) { console.error('[scalp] time-stop imeshindwa:', err.message); }
      }
    }
  }
  const hourAuto = await autoOpenedLastHour();
  if (hourAuto >= settings.maxAutoPerHour) { lastAutoNote = `Kikomo cha auto kwa saa (${hourAuto}/${settings.maxAutoPerHour}) — subiri`; return; }
  const open = await openRows();
  if (open.length >= settings.maxOpen) { lastAutoNote = `Trades wazi ${open.length}/${settings.maxOpen}`; return; }
  const openPairs = new Set(open.map((r) => r.pair));
  const cands = [...signals.values()]
    .filter((s) => !s.error && CATALOG[s.pair] && s.direction !== 'NEUTRAL' && s.strength >= settings.minStrength && !lowMovement(s) && !inBlackout(s) && !openPairs.has(s.pair) && Date.now() >= (cooldowns.get(s.pair) || 0) && Date.now() - s.checkedAt < 90000)
    .sort((a, b) => b.strength - a.strength);
  if (!cands.length) {
    const asleep = [...signals.values()].filter((x) => !x.error && x.direction !== 'NEUTRAL' && x.strength >= settings.minStrength && lowMovement(x)).map((x) => x.pair);
    lastAutoNote = asleep.length ? `Movement ndogo sasa (${asleep.join(', ')}) — imeruka` : `Hakuna signal ≥ ${settings.minStrength}% inayoruhusiwa`;
    return;
  }
  const c = cands[0];
  try {
    const r = await openTrade({ pair: c.pair, direction: c.direction, source: 'auto', strength: c.strength, mode: c.mode });
    lastAutoNote = `Imefungua ${c.direction} ${c.pair} (${c.strength}%)`;
    return r;
  } catch (err) { lastAutoNote = `Imeshindwa ${c.pair}: ${err.message}`; console.error('[scalp] auto-open imeshindwa:', err.message); }
}

async function tick() {
  if (ticking) return; ticking = true;
  try {
    await loadSettings(); lastTickAt = Date.now();
    const watching = settings.autoEnabled || Date.now() - lastViewAt < 120000;
    const hasOpen = (await openRows()).length > 0;
    if (watching && Date.now() - lastScanAt > 25000) await scan();
    if (hasOpen || watching) await reconcile();
    if (settings.autoEnabled) await autoStep();
  } catch (err) { console.error('[scalp] tick:', err.message); }
  finally { ticking = false; }
}

function start({ notify } = {}) {
  if (typeof notify === 'function') notifier = notify;
  if (timer) return true;
  timer = setInterval(() => tick().catch(() => {}), 20000); if (timer.unref) timer.unref();
  // Usalama: akaunti ikibadilishwa (DEMO ↔ REAL) auto ya scalp inazimwa kabisa na ruhusa ya REAL inaondolewa —
  // isiendelee kufanya trades kimya kimya kwenye akaunti mpya; lazima uiwashe tena kwa makusudi.
  try {
    if (typeof derivTrader.onAccountSwitched === 'function') {
      derivTrader.onAccountSwitched(async (mode, prev) => {
        await loadSettings();
        if (settings.autoEnabled || settings.allowRealAuto) {
          settings = sanitize({ ...settings, autoEnabled: false, allowRealAuto: false });
          await saveSettings();
          say(`🛑 *SCALP AUTO IMEZIMWA*\nAkaunti imebadilishwa (${prev || '?'} → ${mode}). Washa tena kwenye scalping.html ukihitaji.`);
        }
        candleCache.clear(); signals.clear(); cooldowns.clear();
      });
    }
  } catch (_) { /* endelea */ }
  console.log('[scalp] ✅ Injini ya scalping imeanza (auto imezimwa mpaka uiwashe kwenye scalping.html).');
  return true;
}
function stop() { if (timer) clearInterval(timer); timer = null; }

async function getNewsBoard() {
  await loadSettings();
  const events = await loadEvents(); const now = Date.now();
  const ccys = new Set(settings.pairs.flatMap(currenciesOf));
  const list = events.filter((e) => ccys.has(e.country) && impactOk(e.impact, 'Medium')).map((e) => ({ ...e, t: new Date(e.date).getTime() }))
    .filter((e) => Number.isFinite(e.t) && e.t > now - 3 * 3600000 && e.t < now + 36 * 3600000).sort((a, b) => a.t - b.t)
    .map((e) => ({
      title: e.title, country: e.country, impact: e.impact, date: e.date, forecast: e.forecast, previous: e.previous, actual: e.actual,
      inMin: Math.round((e.t - now) / 60000), isPast: e.t < now,
      pairs: settings.pairs.filter((p) => currenciesOf(p).includes(e.country)),
    }));
  return { events: list, risk: settings.pairs.map((p) => ({ pair: p, ...newsStateFrom(events, p) })) };
}

async function getStatus() {
  await loadSettings(); lastViewAt = Date.now();
  return {
    settings, catalog: Object.entries(CATALOG).map(([code, m]) => ({ code, label: m.label, kind: m.kind, hot: !!m.hot })),
    accountMode: derivTrader.getAccountMode ? derivTrader.getAccountMode() : null,
    engine: { running: !!timer, lastTickAt, lastScanAt, lastAutoNote, pausedUntil: Date.now() < pausedUntil ? pausedUntil : 0, pauseReason: Date.now() < pausedUntil ? pauseReason : null, inSession: allowedNow() },
    signals: settings.pairs.map((p) => signals.get(p)).filter(Boolean),
  };
}

module.exports = {
  start, stop, tick, scan, getStatus, getNewsBoard, setSettings, previewTrade, openTrade, closeTrade, closeAllScalp,
  openRows, history, stats, reconcile, CATALOG, DEFAULTS, getSettings: async () => { await loadSettings(); return settings; },
  // majaribio
  _ema: ema, _atr: atr, _rsi: rsi, _sizing: sizing, _newsStateFrom: newsStateFrom,
  _lowMovement: lowMovement,
  _setSettingsForTest: (s) => { settings = sanitize({ ...settings, ...s }); settingsLoaded = true; },
};
