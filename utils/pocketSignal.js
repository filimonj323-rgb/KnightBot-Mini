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
const ADX_TREND = 25; // ADX >= hii = soko lina trend (kura za trend pekee)
const ADX_DEAD = 1; // ADX chini ya hii = bei haisogei (soko limefungwa / data imekufa)
const TREND_MAX = 4; // EMA 2 + MACD hist 1 + MACD momentum 1
const REVERSAL_MAX = 3; // RSI 1 + Bollinger 1 + StochRSI 1
// Kuchuja kwa hali ya soko (regime) — MAJARIBIO, IMEZIMWA kwa default. Ilionekana kutoa signals
// za "100%" kwa urahisi (kura 4 za trend zinatosha) na hasara nyingi: inapuuza RSI/Bollinger,
// kwa hiyo ilinunua kwenye overbought. Mantiki ya zamani (kura 7 mchanganyiko) inapima trend
// + pullback pamoja, na ndiyo default. Washa kwa POCKET_REGIME_FILTER=true ukitaka kulinganisha.
const regimeOn = () => String(process.env.POCKET_REGIME_FILTER || 'false').toLowerCase() === 'true';

// Jozi za soko halisi zinazotambulika na Pocket Option (maktaba ya bridge). Nyingine
// zote (mfano EURJPY) zipo kama "_otc" tu — normalizePair() inazibadilisha kiotomatiki.
const REAL_MARKET_PAIRS = new Set(['EURUSD', 'GBPUSD', 'USDJPY', 'USDCHF', 'USDCAD', 'AUDUSD', 'NZDUSD']);

// Forex majors (7) + minors/crosses (21) = jozi za KIPAUMBELE. Jozi nyingine zote
// (dhahabu, crypto, indices, hisa, OTC nyingine) ni FALLBACK tu — zinachanganuliwa
// pale ambapo majors/minors hazina signal (angalia scanPrioritized hapa chini).
const MAJORS = ['EURUSD', 'GBPUSD', 'USDJPY', 'USDCHF', 'USDCAD', 'AUDUSD', 'NZDUSD'];
// Jozi zisizopo kwenye orodha ya Pocket Option (zimeondolewa): EURAUD, EURCAD, GBPCHF, GBPCAD, GBPNZD, NZDCAD, NZDCHF.
const MINORS = [
  'EURGBP', 'EURJPY', 'EURCHF', 'EURNZD',
  'GBPJPY', 'GBPAUD',
  'AUDJPY', 'AUDCAD', 'AUDCHF', 'AUDNZD',
  'CADJPY', 'CADCHF', 'CHFJPY',
  'NZDJPY',
];
const DEFAULT_PAIRS = (process.env.POCKET_SIGNAL_PAIRS || [...MAJORS, ...MINORS].join(','))
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
//   smart (default: forex majors+minors kwanza, nyingine kama fallback) | forex (majors+minors tu)
const SCAN_MODES = ['smart', 'forex', 'otc', 'real', 'all'];
async function getUniverse(mode = 'forex') {
  if (mode === 'forex' || mode === 'smart') return DEFAULT_PAIRS;
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

// Candle ya mwisho iliyofungwa ikiwa ni ya zamani mno, soko limefungwa (maktaba
// inarudisha candles za mwisho zilizopo hata soko likiwa limefungwa — mfano hisa
// za US baada ya saa 20:00 UTC) na signal ingetokana na data ya zamani.
function staleMinutes(candles, tfSec, nowMs = Date.now()) {
  if (!candles.length) return null;
  const t = toMs(candles[candles.length - 1].time);
  if (t == null) return null; // hatuwezi kupima — usikatae
  const ageMs = nowMs - (t + tfSec * 1000);
  const limitMs = Math.max(2 * tfSec * 1000, 120 * 1000);
  return ageMs > limitMs ? Math.round(ageMs / 60000) : null;
}

// ── Uthibitisho wa trend ya 5m ───────────────────────────────────────────────
// Maktaba ya Pocket Option haitoi candles za 5m zinazoaminika, kwa hiyo tunajenga
// 5m wenyewe kwa kujumlisha candles za 1m (ambazo ni sahihi). Signal ya 1m
// inayopingana na trend ya 5m inazuiwa (inakuwa NEUTRAL). Zima kwa
// POCKET_HTF_FILTER=false.
const HTF_FILTER = String(process.env.POCKET_HTF_FILTER || 'true').toLowerCase() !== 'false';
const HTF_SEC = 300;
const HTF_MIN_BARS = 14; // EMA13 inahitaji bars ~14; chini ya hapo hatuhukumu

function emaLast(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) ema = values[i] * k + ema * (1 - k);
  return ema;
}

// Jumlisha candles za 1m kuwa closes za 5m (bucket ya mwisho inaweza kuwa bado
// inaundwa — close yake ni bei ya karibuni, ambayo ndiyo tunayotaka).
function resampleCloses(candles, bucketSec = HTF_SEC) {
  const closes = [];
  let curBucket = null;
  for (const c of candles) {
    const t = toMs(c.time);
    const close = Number(c.close);
    if (t == null || !Number.isFinite(close)) continue;
    const b = Math.floor(t / (bucketSec * 1000));
    if (b !== curBucket) { closes.push(close); curBucket = b; }
    else closes[closes.length - 1] = close;
  }
  return closes;
}

/** 'UP' | 'DOWN' | 'FLAT' | null (data haitoshi kuhukumu) */
function htfTrend(candles) {
  const closes = resampleCloses(candles);
  if (closes.length < HTF_MIN_BARS) return null;
  const fast = emaLast(closes, 5);
  const slow = emaLast(closes, 13);
  const last = closes[closes.length - 1];
  if (fast == null || slow == null) return null;
  if (fast > slow && last > slow) return 'UP';
  if (fast < slow && last < slow) return 'DOWN';
  return 'FLAT';
}

// ── Multi-timeframe (MTF) — MAJARIBIO, imezimwa kwa default (POCKET_MTF=true kuwasha) ───────
// Kabla ya signal ya 1m kutolewa, tunaangalia mwelekeo wa 5m na 15m (candles halisi kupitia
// bridge) kisha tunachagua expiry kiotomatiki kwa sheria MOJA isiyobadilika:
//   • 5m au 15m inapinga mwelekeo            -> hakuna signal
//   • 5m haina mwelekeo wazi / haipatikani   -> hakuna signal
//   • 5m inakubali, 15m inakubali            -> expiry 5m
//   • 5m inakubali, 15m tulivu/haipatikani   -> expiry 3m
// Sheria haichaguliwi kwa kuangalia matokeo; dashboard (Kwa expiry / Kwa MTF) ndiyo
// inayoamua kama 3m na 5m zinashinda kweli.
const mtfOn = () => String(process.env.POCKET_MTF || 'false').toLowerCase() === 'true';
const MTF_MIN_STRENGTH = () => Number(process.env.POCKET_MTF_MIN_STRENGTH || 50);
const MTF_CACHE_MS = 45 * 1000;
const mtfCache = new Map(); // `${pair}|${tf}` -> { at, trend }

/** 'UP' | 'DOWN' | 'FLAT' | null — EMA9 dhidi ya EMA21 + bei ya mwisho dhidi ya EMA21. */
function trendFromCloses(closes) {
  if (!closes || closes.length < 25) return null;
  const fast = emaLast(closes, 9);
  const slow = emaLast(closes, 21);
  const last = closes[closes.length - 1];
  if (fast == null || slow == null) return null;
  if (fast > slow && last > slow) return 'UP';
  if (fast < slow && last < slow) return 'DOWN';
  return 'FLAT';
}

/** Trend ya timeframe kubwa kutoka candles halisi. null = haipatikani/ya zamani (haizuii pekee yake). */
async function realTrend(pair, tfSec, count) {
  const key = `${pair}|${tfSec}`;
  const hit = mtfCache.get(key);
  if (hit && Date.now() - hit.at < MTF_CACHE_MS) return hit.trend;
  let trend = null;
  try {
    const raw = await getCandles(pair, tfSec, count);
    const lastMs = raw && raw.length ? toMs(raw[raw.length - 1].time) : null;
    // Data ya zamani (maktaba ikirudisha cache) haiaminiki — usiitumie.
    if (lastMs != null && Date.now() - lastMs <= tfSec * 1000 * 3) {
      trend = trendFromCloses(raw.map((c) => Number(c.close)).filter(Number.isFinite));
    }
  } catch (e) {
    trend = null;
  }
  mtfCache.set(key, { at: Date.now(), trend });
  return trend;
}

/** Sheria ya expiry. m5/m15: 'UP'|'DOWN'|'FLAT'|null. */
function mtfDecision(direction, m5, m15) {
  const want = direction === 'BUY' ? 'UP' : 'DOWN';
  const opp = direction === 'BUY' ? 'DOWN' : 'UP';
  if (m5 === opp) return { ok: false, reason: '5m inapinga' };
  if (m15 === opp) return { ok: false, reason: '15m inapinga' };
  if (m5 !== want) return { ok: false, reason: m5 == null ? '5m haipatikani' : '5m haina mwelekeo wazi' };
  if (m15 === want) return { ok: true, expirySec: 300, level: 'both' };
  return { ok: true, expirySec: 180, level: 'm5only' };
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

  // Makundi mawili ya kura: TREND (kufuata mwelekeo) na REVERSAL (kugeuka). Zinapingana kwa
  // asili, kwa hiyo hazichanganywi tena kwenye kura moja isipokuwa ADX haijulikani.
  let tBuy = 0, tSell = 0, rBuy = 0, rSell = 0;
  const tNotes = [], rNotes = [];

  if (ema9 != null && ema21 != null) {
    if (ema9 > ema21) { tBuy += 2; tNotes.push('EMA9 > EMA21 (trend juu)'); }
    else if (ema9 < ema21) { tSell += 2; tNotes.push('EMA9 < EMA21 (trend chini)'); }
  }
  if (hist != null) {
    if (hist > 0) { tBuy += 1; tNotes.push('MACD histogram chanya'); }
    else if (hist < 0) { tSell += 1; tNotes.push('MACD histogram hasi'); }
    if (histPrev != null) {
      if (hist > histPrev) { tBuy += 1; tNotes.push('Momentum ya MACD inaongezeka'); }
      else if (hist < histPrev) { tSell += 1; tNotes.push('Momentum ya MACD inapungua'); }
    }
  }
  if (rsi != null) {
    if (rsi < 30) { rBuy += 1; rNotes.push(`RSI ${rsi.toFixed(1)} — oversold`); }
    else if (rsi > 70) { rSell += 1; rNotes.push(`RSI ${rsi.toFixed(1)} — overbought`); }
  }
  if (bbU != null && bbL != null) {
    if (close <= bbL) { rBuy += 1; rNotes.push('Bei imegusa Bollinger ya chini'); }
    else if (close >= bbU) { rSell += 1; rNotes.push('Bei imegusa Bollinger ya juu'); }
  }
  if (k != null && d != null) {
    if (k < 20 && k > d) { rBuy += 1; rNotes.push(`StochRSI ${k.toFixed(0)} — inageuka juu`); }
    else if (k > 80 && k < d) { rSell += 1; rNotes.push(`StochRSI ${k.toFixed(0)} — inageuka chini`); }
  }

  // Data iliyokufa: ADX ~0 inamaanisha bei haisogei (mfano indices usiku) — hakuna signal.
  if (adx != null && adx < ADX_DEAD) {
    return { direction: 'NEUTRAL', strength: 0, notes: ['Bei haisogei (soko limefungwa?)'], weakMarket: false,
      regime: 'DEAD', adx, rsi, price: close, buy: 0, sell: 0 };
  }

  let buy, sell, notes, maxScore, regime;
  if (regimeOn() && adx != null) {
    if (adx >= ADX_TREND) {
      regime = 'TREND'; buy = tBuy; sell = tSell; notes = tNotes; maxScore = TREND_MAX;
    } else if (adx < ADX_WEAK) {
      regime = 'RANGE'; buy = rBuy; sell = rSell; notes = rNotes; maxScore = REVERSAL_MAX;
    } else {
      // ADX 20-25: hakuna mwelekeo wala range wazi — subiri.
      return { direction: 'NEUTRAL', strength: 0, notes: [], weakMarket: false, regime: 'TRANSITION',
        adx, rsi, price: close, buy: tBuy + rBuy, sell: tSell + rSell };
    }
  } else {
    regime = regimeOn() ? 'UNKNOWN' : 'MIXED';
    buy = tBuy + rBuy; sell = tSell + rSell; notes = [...tNotes, ...rNotes]; maxScore = MAX_SCORE;
  }

  const net = buy - sell;
  let direction = 'NEUTRAL';
  let strength = 0;
  if (Math.abs(net) >= MIN_NET_VOTES) {
    direction = net > 0 ? 'BUY' : 'SELL';
    strength = Math.round((Math.abs(net) / maxScore) * 100);
  }
  // Mantiki ya zamani tu: kupunguza strength kwenye soko tulivu. Kwenye regime mpya, RANGE
  // ni hali inayokusudiwa (reversal), kwa hiyo hakuna kikomo cha ziada.
  let weakMarket = false;
  if (!regimeOn() || adx == null) {
    if (adx != null && adx < ADX_WEAK && direction !== 'NEUTRAL') {
      weakMarket = true;
      strength = Math.min(strength, 50);
    }
  }
  return { direction, strength, notes, weakMarket, regime, adx, rsi, price: close, buy, sell };
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
    if (!raw || raw.length === 0) {
      // Timeout ya mara moja ni kawaida — jaribu tena mara 1 kabla ya kukata tamaa.
      console.log(`[posignal] ${p} ${tfLabel(timeframeSec)}: candles 0 (timeout) — najaribu tena`);
      await new Promise((r) => setTimeout(r, 1500));
      raw = await getCandles(p, timeframeSec, 220);
    }
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
  const stale = staleMinutes(candles, timeframeSec);
  if (stale != null) {
    const age = stale >= 120 ? `saa ${Math.round(stale / 60)}` : `dakika ${stale}`;
    if (timeframeSec > 60) {
      // Bridge sasa inatumia loadHistoryPeriod kwa timeframe > 1m; ikiwa bado ni ya zamani,
      // soko limefungwa au historia haikupatikana.
      throw new Error(`Candles za ${p} (${tfLabel(timeframeSec)}) ni za zamani (umri wa ${age}) — soko limefungwa au historia haikupatikana. Jaribu 1m.`);
    }
    throw new Error(`Soko la ${p} limefungwa (candle ya mwisho ina umri wa ${age}).`);
  }
  if (candles.length < WARMUP + 10) {
    throw new Error(`Candles hazitoshi kwa ${p} (${candles.length}/${WARMUP + 10}).`);
  }
  const s = computeAllIndicatorSeries(candles);
  const last = candles.length - 1;
  const v = voteAt(s, last);

  // Trend ya 5m (inajengwa kutoka 1m) — inaonyeshwa kwenye kila signal ya 1m.
  // Signal inayopingana nayo inazuiwa (isipokuwa POCKET_HTF_FILTER=false).
  let htf = null;
  let htfBlocked = false;
  let mtf = null;
  let mtfBlocked = false;
  let expirySec = timeframeSec;
  if (timeframeSec === 60) {
    htf = htfTrend(candles);
    if (mtfOn() && v.direction !== 'NEUTRAL' && v.strength >= MTF_MIN_STRENGTH()) {
      const [r5, r15] = await Promise.all([realTrend(p, 300, 60), realTrend(p, 900, 40)]);
      const m5 = r5 ?? htf; // 5m halisi ikikosekana, tumia ya kujumlisha kutoka 1m
      const dec = mtfDecision(v.direction, m5, r15);
      mtf = { m5, m15: r15, m5Source: r5 ? 'real' : 'resampled', level: dec.level || null, reason: dec.reason || null };
      if (!dec.ok) {
        mtfBlocked = true;
        console.log(`[posignal] ${p} 1m: ${v.direction} imezuiwa na MTF — ${dec.reason} (5m=${m5} 15m=${r15})`);
        v.direction = 'NEUTRAL';
        v.strength = 0;
      } else {
        expirySec = dec.expirySec;
      }
    } else {
      const against = (htf === 'UP' && v.direction === 'SELL') || (htf === 'DOWN' && v.direction === 'BUY');
      if (HTF_FILTER && against) {
        htfBlocked = true;
        console.log(`[posignal] ${p} 1m: ${v.direction} imezuiwa — trend ya 5m ni ${htf}`);
        v.direction = 'NEUTRAL';
        v.strength = 0;
      }
    }
  }

  console.log(
    `[posignal] ${p} ${tfLabel(timeframeSec)}: ${v.direction} [${v.regime || '-'}] buy=${v.buy} sell=${v.sell} ` +
    `strength=${v.strength}% adx=${v.adx != null ? v.adx.toFixed(1) : '-'} rsi=${v.rsi != null ? v.rsi.toFixed(1) : '-'} candles=${candles.length}`
  );
  return {
    pair: p,
    timeframeSec,
    expirySec,
    direction: v.direction,
    strength: v.strength,
    grade: gradeOf(v.strength),
    price: v.price,
    rsi: v.rsi,
    adx: v.adx,
    notes: v.notes,
    weakMarket: v.weakMarket,
    regime: v.regime,
    htf,
    htfBlocked,
    mtf,
    mtfBlocked,
    candleTime: candles[last].time,
    backtest: backtest(s, minStrength),
  };
}

// Jozi zilizoshindwa (timeout / haipo) zinarukwa kwa muda, ili jozi zilizofungwa
// zisipoteze sekunde 10 kila scan.
const deadPairs = new Map(); // pair -> until(ms)
const failCounts = new Map(); // pair -> idadi ya kushindwa mfululizo
const DEAD_AFTER_FAILS = 2; // timeout/stale inahesabiwa dead baada ya kushindwa mara hii mfululizo
const DEAD_MS = 10 * 60 * 1000;
const SCAN_CONCURRENCY = Math.max(1, parseInt(process.env.POCKET_SCAN_CONCURRENCY || '', 10) || 3);

// Changanua jozi nyingi. `concurrency` maombi kwa wakati mmoja (default 3; weka
// POCKET_SCAN_CONCURRENCY=1 ukiona makosa/timeouts nyingi). opts.onResult(r) hiari:
// inaitwa kwa kila jozi mara tu inapochanganuliwa.
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
        const analyzed = await analyzePair(pair, timeframeSec, opts);
        results.push(analyzed);
        failCounts.delete(pair);
        // onResult: inaitwa MARA MOJA matokeo ya jozi yanapofika (si baada ya scan nzima) —
        // inatumiwa na auto-trader kuingia haraka kabla candle mpya haijazeeka.
        if (typeof opts.onResult === 'function') {
          try { await opts.onResult(analyzed); }
          catch (cbErr) { console.error(`[posignal] onResult(${pair}) imeshindwa:`, cbErr.message); }
        }
      } catch (err) {
        errors.push({ pair, error: err.message });
        console.log(`[posignal] ${pair} ${tfLabel(timeframeSec)}: KOSA — ${err.message}`);
        if (/haipo kwenye/i.test(err.message)) {
          // Jozi haipo kabisa — hakuna sababu ya kujaribu tena hivi karibuni.
          deadPairs.set(pair, Date.now() + DEAD_MS);
        } else if (/timeout|haikujibu|limefungwa/i.test(err.message)) {
          const n = (failCounts.get(pair) || 0) + 1;
          failCounts.set(pair, n);
          if (n >= DEAD_AFTER_FAILS) {
            deadPairs.set(pair, Date.now() + DEAD_MS);
            failCounts.delete(pair);
          }
        }
      }
      await new Promise((r) => setTimeout(r, 150));
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  results.sort((a, b) => b.strength - a.strength);
  console.log(
    `[posignal] scan ${tfLabel(timeframeSec)}: jozi=${pairs.length} zilizochanganuliwa=${results.length} ` +
    `makosa=${errors.length} zilizorukwa(dead)=${skipped} NEUTRAL=${results.filter((r) => r.direction === 'NEUTRAL').length}`
  );
  return { results, errors, skipped, total: pairs.length };
}

// Jozi za FALLBACK: kila asset isiyo majors/minors (OTC za jozi hizo hizo hazirudiwi
// kwa sababu normalizePair() tayari inazichagua). Hisa (#...) zinawekwa mwisho, na
// idadi inawekewa kikomo (POCKET_FALLBACK_MAX, default 40) ili scan isichukue muda mrefu.
const FALLBACK_MAX = Math.max(0, parseInt(process.env.POCKET_FALLBACK_MAX || '', 10) || 40);
async function getFallbackPairs() {
  const list = await getAssets().catch(() => null);
  if (!list) return [];
  const primary = new Set(DEFAULT_PAIRS.map((p) => p.toUpperCase()));
  return list
    .filter((a) => !primary.has(a.replace(/_otc$/i, '').toUpperCase()))
    .sort((a, b) => Number(a.startsWith('#')) - Number(b.startsWith('#')))
    .slice(0, FALLBACK_MAX);
}

// Changanua forex majors+minors KWANZA. Jozi nyingine zinachanganuliwa tu kama hakuna
// signal yenye nguvu >= minStrength kwenye forex.
async function scanPrioritized(timeframeSec = 60, opts = {}) {
  const minStrength = opts.minStrength ?? 50;
  const primary = await scanPairs(DEFAULT_PAIRS, timeframeSec, opts);
  primary.results.forEach((r) => { r.tier = 'primary'; });
  const isHit = (r) => r.direction !== 'NEUTRAL' && r.strength >= minStrength;
  if (primary.results.some(isHit)) return { ...primary, usedFallback: false };

  const fbPairs = await getFallbackPairs();
  if (!fbPairs.length) return { ...primary, usedFallback: false };
  const fb = await scanPairs(fbPairs, timeframeSec, opts);
  fb.results.forEach((r) => { r.tier = 'fallback'; });
  return {
    results: [...primary.results, ...fb.results].sort((a, b) => b.strength - a.strength),
    errors: [...primary.errors, ...fb.errors],
    skipped: primary.skipped + fb.skipped,
    total: primary.total + fb.total,
    usedFallback: true,
  };
}

const EMOJI = { BUY: '🟢', SELL: '🔴', NEUTRAL: '⚪' };
const HTF_LABEL = { UP: 'JUU ⬆️', DOWN: 'CHINI ⬇️', FLAT: 'TULIVU ➡️' };
const REGIME_LABEL = { TREND: 'Trend (kufuata mwelekeo)', RANGE: 'Range (kugeuka)', TRANSITION: 'Mpito', DEAD: 'Imekufa' };
const LABEL = { BUY: 'UP (BUY) ⬆️', SELL: 'DOWN (SELL) ⬇️', NEUTRAL: 'HAKUNA SIGNAL' };

function formatBacktest(bt) {
  const fmt = (x) => (x.trades ? `${x.winRate}% (${x.trades} signals)` : 'hakuna data');
  const small = bt.all.trades < MIN_BACKTEST_TRADES ? '\n⚠️ Sampuli ndogo (candles ~96 tu) — usiitegemee kama uthibitisho.' : '';
  return `📊 Backtest ya candles hizi: yote ${fmt(bt.all)} • strong ${fmt(bt.strong)}${small}`;
}

function formatSignal(r, { compact = false } = {}) {
  if (r.direction === 'NEUTRAL') {
    const why = r.mtfBlocked ? ` (imezuiwa na multi-timeframe: ${r.mtf && r.mtf.reason})`
      : r.htfBlocked ? ' (signal ya 1m imezuiwa — inapingana na trend ya 5m)' : '';
    return `⚪ *${r.pair}* (${tfLabel(r.timeframeSec)}) — hakuna signal wazi sasa. Subiri.${why}`;
  }
  if (compact) {
    return `${EMOJI[r.direction]} *${r.pair}* ${r.direction} • ${r.grade} ${r.strength}% • expiry ${tfLabel(r.expirySec)}${r.mtf ? ' • MTF' : r.htf ? ` • 5m ${HTF_LABEL[r.htf]}` : ''}${r.tier === 'fallback' ? ' • fallback' : ''}`;
  }
  const lines = [
    `${EMOJI[r.direction]} *SIGNAL — ${r.pair}*`,
    '',
    `➡️ Mwelekeo: *${LABEL[r.direction]}*`,
    `💪 Nguvu: *${r.grade}* (${r.strength}%)`,
    `⏱️ Expiry: ${tfLabel(r.expirySec)} (ingia kwenye candle inayofuata)`,
    `💱 Bei: ${Number(r.price).toFixed(5)}`,
  ];
  if (r.tier === 'fallback') lines.push('🔁 _Fallback — forex majors/minors hazikuwa na signal, hii inatoka jozi nyingine._');
  if (r.rsi != null) lines.push(`📈 RSI: ${r.rsi.toFixed(1)}${r.adx != null ? ` • ADX: ${r.adx.toFixed(1)}` : ''}`);
  if (REGIME_LABEL[r.regime]) lines.push(`📐 Hali ya soko: *${REGIME_LABEL[r.regime]}*`);
  if (r.mtf) {
    lines.push(`🧭 Multi-timeframe: 5m *${HTF_LABEL[r.mtf.m5] || '—'}* • 15m *${HTF_LABEL[r.mtf.m15] || '—'}* → expiry *${tfLabel(r.expirySec)}* (otomatiki)`);
  } else if (r.htf) lines.push(`🧭 Trend ya 5m: *${HTF_LABEL[r.htf]}*`);
  if (r.weakMarket) lines.push('⚠️ Soko tulivu (ADX ndogo) — nguvu imepunguzwa.');
  lines.push('', '*Sababu:*', ...r.notes.map((n) => `• ${n}`), '', formatBacktest(r.backtest));
  lines.push('', '_Hii si ushauri wa kifedha. Break-even ≈ 54% kwa payout 85%. Tumia stake ndogo, anza na DEMO._');
  return lines.join('\n');
}

function formatScan({ results, errors, skipped = 0, total, usedFallback = false }, timeframeSec, minStrength = 50, maxShow = 10) {
  const hits = results.filter((r) => r.direction !== 'NEUTRAL' && r.strength >= minStrength);
  const lines = [`🔎 *Scan ya Pocket Option (${tfLabel(timeframeSec)})*`, ''];
  if (usedFallback) lines.push('ℹ️ Forex majors/minors hazikuwa na signal — nimeongeza jozi nyingine (fallback).', '');
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
  MAJORS,
  MINORS,
  DEFAULT_PAIRS,
  SCAN_MODES,
  getUniverse,
  parseTimeframe,
  tfLabel,
  normalizePair,
  staleMinutes,
  voteAt,
  htfTrend,
  resampleCloses,
  trendFromCloses,
  mtfDecision,
  backtest,
  analyzePair,
  scanPairs,
  scanPrioritized,
  formatSignal,
  formatScan,
};
