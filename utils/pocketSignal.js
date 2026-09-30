/**
 * pocketSignal.js — Injini ya signals za Pocket Option.
 *
 * Inatumia candles za Pocket Option MWENYEWE (kupitia pocket_bridge) na
 * indicators zilizopo kwenye utils/indicators.js. Inafanya:
 *   1. Confluence scoring (EMA trend, MACD, RSI, Bollinger, StochRSI) + kichujio cha ADX.
 *   2. Backtest ya haraka kwenye candles hizo hizo — inaonyesha hit-rate HALISI ya
 *      mantiki hii kwa jozi/timeframe husika, ili signal isiaminiwe kibubusa.
 *   3. Scanner ya jozi nyingi na formatter ya ujumbe wa WhatsApp.
 *
 * ⚠️ Hakuna signal inayohakikisha faida. Binary option inahitaji hit-rate juu ya
 * break-even (~54% kwa payout 85%). Backtest ndiyo inayokuambia kama mantiki
 * hii ina faida kwa jozi husika — sio "strength" pekee.
 */

const { getCandles, getAssets } = require('./pocketOptionTrader');
const { computeAllIndicatorSeries } = require('./indicators');

const MAX_SCORE = 7; // trend 2 + macd 2 + rsi 1 + bb 1 + stoch 1
const MIN_NET_VOTES = 2; // chini ya hii = NEUTRAL
// Bars za kwanza zinazorukwa (indicators hazijatulia). Pocket Option inarudisha ~96
// candles tu kwa ombi (maktaba haina parameter ya kuongeza), kwa hiyo WARMUP ni ndogo
// iwezekanavyo: MACD(26+9) na StochRSI zinatulia ~bar 35-40.
const WARMUP = 40;
const MIN_BACKTEST_TRADES = 30; // chini ya hii = sampuli ndogo mno
const ADX_WEAK = 20; // ADX chini ya hii = soko tulivu -> strength inapunguzwa

// Jozi za soko halisi zinazotambulika na Pocket Option (maktaba ya bridge). Nyingine
// zote (mfano EURJPY) zipo kama "_otc" tu — normalizePair() inazibadilisha kiotomatiki.
const REAL_MARKET_PAIRS = new Set(['EURUSD', 'GBPUSD', 'USDJPY', 'USDCHF', 'USDCAD', 'AUDUSD', 'NZDUSD']);

const DEFAULT_PAIRS = (process.env.POCKET_SIGNAL_PAIRS || 'EURUSD,GBPUSD,USDJPY,AUDUSD,USDCAD,USDCHF')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// "1m" -> 60, "5m" -> 300, "30s" -> 30, "1h" -> 3600
function parseTimeframe(input, fallback = 60) {
  if (!input) return fallback;
  const m = /^(\d+)\s*(s|m|h)?$/i.exec(String(input).trim());
  if (!m) return null;
  const n = parseInt(m[1], 10);
  const unit = (m[2] || 'm').toLowerCase();
  const sec = unit === 's' ? n : unit === 'h' ? n * 3600 : n * 60;
  return sec >= 5 ? sec : null;
}

function tfLabel(sec) {
  if (sec % 3600 === 0) return `${sec / 3600}h`;
  if (sec % 60 === 0) return `${sec / 60}m`;
  return `${sec}s`;
}

// Index ya assets (lowercase -> jina halisi, mfano "ukbrent" -> "UKBrent"). Orodha inatoka
// bridge (/assets); ikishindwa tunarudi kwenye mantiki ya static hapa chini.
let assetIndexCache = { at: 0, index: null };
async function getAssetIndex() {
  if (assetIndexCache.index && Date.now() - assetIndexCache.at < 60 * 60 * 1000) return assetIndexCache.index;
  try {
    const list = await getAssets();
    const index = new Map(list.map((a) => [a.toLowerCase(), a]));
    assetIndexCache = { at: Date.now(), index };
    return index;
  } catch (_) {
    return null;
  }
}

/**
 * Tatua jina la jozi kuwa asset halisi ya Pocket Option.
 * - Ikiwa `index` ipo: tumia jina halisi (EURUSD, BTCUSD, #AAPL, UKBrent...); ikiwa halipo
 *   kwenye soko halisi lakini lipo OTC (mfano EURJPY) -> EURJPY_otc.
 * - Wikendi, forex majors hubadilishwa kuwa _otc (soko halisi limefungwa).
 */
function normalizePair(pair, now = new Date(), index = null) {
  const raw = String(pair || '').trim().replace('/', '');
  if (!raw) return raw;
  const isOtc = /_otc$/i.test(raw);
  const base = raw.replace(/_otc$/i, '');
  const up = base.toUpperCase();
  const day = now.getUTCDay(); // 0 = Jumapili, 6 = Jumamosi
  const weekend = day === 0 || day === 6;

  if (index) {
    const real = index.get(base.toLowerCase());
    const otc = index.get(`${base.toLowerCase()}_otc`);
    if (isOtc) return otc || `${up}_otc`;
    if (weekend && REAL_MARKET_PAIRS.has(up) && otc) return otc;
    return real || otc || `${up}_otc`;
  }
  return isOtc || weekend || !REAL_MARKET_PAIRS.has(up) ? `${up}_otc` : up;
}

// Jozi za kuchanganua kulingana na "mode":
//   forex (default: DEFAULT_PAIRS) | otc (zote za _otc) | real (zote zisizo OTC) | all (zote)
const SCAN_MODES = ['forex', 'otc', 'real', 'all'];
async function getUniverse(mode = 'forex') {
  if (mode === 'forex') return DEFAULT_PAIRS;
  const list = await getAssets().catch(() => null);
  if (!list) throw new Error('Siwezi kupata orodha ya jozi kutoka bridge. Jaribu tena.');
  if (mode === 'otc') return list.filter((a) => /_otc$/i.test(a));
  if (mode === 'real') return list.filter((a) => !/_otc$/i.test(a));
  return list;
}

function toMs(t) {
  if (typeof t === 'number') return t < 1e12 ? t * 1000 : t;
  const v = Date.parse(t);
  return Number.isNaN(v) ? null : v;
}

// Candle ya mwisho kwa kawaida bado inatengenezwa — ikiwa ni hivyo, iondoe
// ili signal itokane na candles zilizofungwa tu.
function dropFormingCandle(candles, tfSec, nowMs = Date.now()) {
  if (!candles.length) return candles;
  const last = candles[candles.length - 1];
  const t = toMs(last.time);
  if (t != null && t + tfSec * 1000 > nowMs) return candles.slice(0, -1);
  return candles;
}

/**
 * Kura (votes) kwenye bar `i` ya series. Inatumika na signal ya moja kwa moja
 * na backtest — mantiki moja, kwa hiyo backtest inapima kile kile kinachotumwa.
 */
function voteAt(s, i) {
  const get = (arr) => (arr[i] == null ? null : arr[i]);
  const ema9 = get(s.ema9), ema21 = get(s.ema21);
  const hist = get(s.macdHist), histPrev = i > 0 ? s.macdHist[i - 1] : null;
  const rsi = get(s.rsi);
  const close = s.price[i];
  const bbU = get(s.bbUpper), bbL = get(s.bbLower);
  const k = get(s.stochK), d = get(s.stochD);
  const adx = get(s.adx);

  let buy = 0, sell = 0;
  const notes = [];

  if (ema9 != null && ema21 != null) {
    if (ema9 > ema21) { buy += 2; notes.push('EMA9 > EMA21 (trend juu)'); }
    else if (ema9 < ema21) { sell += 2; notes.push('EMA9 < EMA21 (trend chini)'); }
  }
  if (hist != null) {
    if (hist > 0) { buy += 1; notes.push('MACD histogram chanya'); }
    else if (hist < 0) { sell += 1; notes.push('MACD histogram hasi'); }
    if (histPrev != null) {
      if (hist > histPrev) { buy += 1; notes.push('Momentum ya MACD inaongezeka'); }
      else if (hist < histPrev) { sell += 1; notes.push('Momentum ya MACD inapungua'); }
    }
  }
  if (rsi != null) {
    if (rsi < 30) { buy += 1; notes.push(`RSI ${rsi.toFixed(1)} — oversold`); }
    else if (rsi > 70) { sell += 1; notes.push(`RSI ${rsi.toFixed(1)} — overbought`); }
  }
  if (bbU != null && bbL != null) {
    if (close <= bbL) { buy += 1; notes.push('Bei imegusa Bollinger ya chini'); }
    else if (close >= bbU) { sell += 1; notes.push('Bei imegusa Bollinger ya juu'); }
  }
  if (k != null && d != null) {
    if (k < 20 && k > d) { buy += 1; notes.push(`StochRSI ${k.toFixed(0)} — inageuka juu`); }
    else if (k > 80 && k < d) { sell += 1; notes.push(`StochRSI ${k.toFixed(0)} — inageuka chini`); }
  }

  const net = buy - sell;
  let direction = 'NEUTRAL';
  let strength = 0;
  if (Math.abs(net) >= MIN_NET_VOTES) {
    direction = net > 0 ? 'BUY' : 'SELL';
    strength = Math.round((Math.abs(net) / MAX_SCORE) * 100);
  }
  let weakMarket = false;
  if (adx != null && adx < ADX_WEAK && direction !== 'NEUTRAL') {
    weakMarket = true;
    strength = Math.min(strength, 50);
  }
  return { direction, strength, notes, weakMarket, adx, rsi, price: close };
}

// Hit-rate ya mantiki hii kwenye candles zilizopo: signal ya bar i -> matokeo ya bar i+1.
function backtest(s, minStrength) {
  const n = s.price.length;
  const tally = { all: { w: 0, l: 0 }, strong: { w: 0, l: 0 } };
  for (let i = WARMUP; i < n - 1; i++) {
    const v = voteAt(s, i);
    if (v.direction === 'NEUTRAL') continue;
    const diff = s.price[i + 1] - s.price[i];
    if (diff === 0) continue;
    const win = (v.direction === 'BUY') === diff > 0;
    const bucket = win ? 'w' : 'l';
    tally.all[bucket]++;
    if (v.strength >= minStrength) tally.strong[bucket]++;
  }
  const rate = (t) => {
    const total = t.w + t.l;
    return { trades: total, winRate: total ? Math.round((t.w / total) * 1000) / 10 : null };
  };
  return { all: rate(tally.all), strong: rate(tally.strong) };
}

function gradeOf(strength) {
  if (strength >= 70) return 'STRONG';
  if (strength >= 50) return 'MODERATE';
  return 'WEAK';
}

/**
 * Changanua jozi moja.
 * @returns {Promise<object>} { pair, timeframeSec, direction, strength, grade, price, rsi, adx,
 *                              notes, weakMarket, candleTime, backtest, expirySec }
 */
async function analyzePair(pair, timeframeSec = 60, opts = {}) {
  const minStrength = opts.minStrength ?? 50;
  const p = normalizePair(pair, new Date(), await getAssetIndex());
  let raw;
  try {
    raw = await getCandles(p, timeframeSec, 220);
  } catch (err) {
    if (/invalid asset/i.test(err.message)) {
      throw new Error(`Jozi "${p}" haipo kwenye Pocket Option. Jaribu mfano: EURUSD, GBPUSD, USDJPY au ongeza _otc.`);
    }
    throw err;
  }
  if (!raw || raw.length === 0) {
    throw new Error(`Pocket Option haikujibu kwa ${p} (timeout) — jozi inaweza kuwa imefungwa sasa. Jaribu _otc.`);
  }
  const candles = dropFormingCandle(raw, timeframeSec);
  if (candles.length < WARMUP + 10) {
    throw new Error(`Candles hazitoshi kwa ${p} (${candles.length}/${WARMUP + 10}).`);
  }
  const s = computeAllIndicatorSeries(candles);
  const last = candles.length - 1;
  const v = voteAt(s, last);
  return {
    pair: p,
    timeframeSec,
    expirySec: timeframeSec,
    direction: v.direction,
    strength: v.strength,
    grade: gradeOf(v.strength),
    price: v.price,
    rsi: v.rsi,
    adx: v.adx,
    notes: v.notes,
    weakMarket: v.weakMarket,
    candleTime: candles[last].time,
    backtest: backtest(s, minStrength),
  };
}

// Jozi zilizoshindwa (timeout / haipo) zinarukwa kwa muda, ili jozi zilizofungwa
// zisipoteze sekunde 10 kila scan.
const deadPairs = new Map(); // pair -> until(ms)
const DEAD_MS = 10 * 60 * 1000;
const SCAN_CONCURRENCY = Math.max(1, parseInt(process.env.POCKET_SCAN_CONCURRENCY || '', 10) || 3);

// Changanua jozi nyingi. `concurrency` maombi kwa wakati mmoja (default 3; weka
// POCKET_SCAN_CONCURRENCY=1 ukiona makosa/timeouts nyingi).
async function scanPairs(pairs = DEFAULT_PAIRS, timeframeSec = 60, opts = {}) {
  const concurrency = opts.concurrency ?? SCAN_CONCURRENCY;
  const results = [];
  const errors = [];
  let skipped = 0;
  const queue = pairs.filter((pair) => {
    if ((deadPairs.get(pair) || 0) > Date.now()) { skipped++; return false; }
    return true;
  });
  let next = 0;
  const worker = async () => {
    while (next < queue.length) {
      const pair = queue[next++];
      try {
        results.push(await analyzePair(pair, timeframeSec, opts));
      } catch (err) {
        errors.push({ pair, error: err.message });
        if (/timeout|haikujibu|haipo kwenye/i.test(err.message)) deadPairs.set(pair, Date.now() + DEAD_MS);
      }
      await new Promise((r) => setTimeout(r, 150));
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  results.sort((a, b) => b.strength - a.strength);
  return { results, errors, skipped, total: pairs.length };
}

const EMOJI = { BUY: '🟢', SELL: '🔴', NEUTRAL: '⚪' };
const LABEL = { BUY: 'UP (BUY) ⬆️', SELL: 'DOWN (SELL) ⬇️', NEUTRAL: 'HAKUNA SIGNAL' };

function formatBacktest(bt) {
  const fmt = (x) => (x.trades ? `${x.winRate}% (${x.trades} signals)` : 'hakuna data');
  const small = bt.all.trades < MIN_BACKTEST_TRADES ? '\n⚠️ Sampuli ndogo (candles ~96 tu) — usiitegemee kama uthibitisho.' : '';
  return `📊 Backtest ya candles hizi: yote ${fmt(bt.all)} • strong ${fmt(bt.strong)}${small}`;
}

function formatSignal(r, { compact = false } = {}) {
  if (r.direction === 'NEUTRAL') {
    return `⚪ *${r.pair}* (${tfLabel(r.timeframeSec)}) — hakuna signal wazi sasa. Subiri.`;
  }
  if (compact) {
    return `${EMOJI[r.direction]} *${r.pair}* ${r.direction} • ${r.grade} ${r.strength}% • expiry ${tfLabel(r.expirySec)}`;
  }
  const lines = [
    `${EMOJI[r.direction]} *SIGNAL — ${r.pair}*`,
    '',
    `➡️ Mwelekeo: *${LABEL[r.direction]}*`,
    `💪 Nguvu: *${r.grade}* (${r.strength}%)`,
    `⏱️ Expiry: ${tfLabel(r.expirySec)} (ingia kwenye candle inayofuata)`,
    `💱 Bei: ${Number(r.price).toFixed(5)}`,
  ];
  if (r.rsi != null) lines.push(`📈 RSI: ${r.rsi.toFixed(1)}${r.adx != null ? ` • ADX: ${r.adx.toFixed(1)}` : ''}`);
  if (r.weakMarket) lines.push('⚠️ Soko tulivu (ADX ndogo) — nguvu imepunguzwa.');
  lines.push('', '*Sababu:*', ...r.notes.map((n) => `• ${n}`), '', formatBacktest(r.backtest));
  lines.push('', '_Hii si ushauri wa kifedha. Break-even ≈ 54% kwa payout 85%. Tumia stake ndogo, anza na DEMO._');
  return lines.join('\n');
}

function formatScan({ results, errors, skipped = 0, total }, timeframeSec, minStrength = 50, maxShow = 10) {
  const hits = results.filter((r) => r.direction !== 'NEUTRAL' && r.strength >= minStrength);
  const lines = [`🔎 *Scan ya Pocket Option (${tfLabel(timeframeSec)})*`, ''];
  if (!hits.length) lines.push('Hakuna signal yenye nguvu ya kutosha sasa hivi. Jaribu tena baada ya candle inayofuata.');
  else {
    hits.slice(0, maxShow).forEach((r) => lines.push(formatSignal(r, { compact: true })));
    if (hits.length > maxShow) lines.push(`…na signals ${hits.length - maxShow} nyingine.`);
  }
  const unavailable = errors.length + skipped;
  lines.push('', `📋 Jozi ${total ?? results.length + unavailable}: zilizochanganuliwa ${results.length}, zenye signal ${hits.length}, hazipatikani/zimefungwa ${unavailable}.`);
  if (errors.length && errors.length <= 5) lines.push(`⚠️ Zimeshindwa: ${errors.map((e) => e.pair).join(', ')}`);
  lines.push('', '_Tumia .posignal <JOZI> kuona sababu + backtest kamili._');
  return lines.join('\n');
}

module.exports = {
  DEFAULT_PAIRS,
  SCAN_MODES,
  getUniverse,
  parseTimeframe,
  tfLabel,
  normalizePair,
  voteAt,
  backtest,
  analyzePair,
  scanPairs,
  formatSignal,
  formatScan,
};
