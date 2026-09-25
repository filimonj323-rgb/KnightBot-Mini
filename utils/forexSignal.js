/**
 * forexSignal.js — Msingi wa data na ishara (signals) za forex.
 *
 * Chanzo cha data: Twelve Data API (bure — https://twelvedata.com/pricing).
 * Tier ya bure (Basic): maombi 800/siku, 8/dakika.
 *
 * TWELVE_DATA_API_KEY (LAZIMA iwepo kwenye env):
 *   1. Sajili bure: https://twelvedata.com/pricing (chagua "Basic — $0/mo")
 *   2. Thibitisha email yako (mipaka inaongezeka kutoka default hadi 8/dakika)
 *   3. Nakili API Key kutoka dashboard yako, weka kwenye Railway env vars
 *      kama TWELVE_DATA_API_KEY
 *
 * ⚠️ MUHIMU KUHUSU CREDITS: Twelve Data ina endpoint TOFAUTI kwa kila
 * indicator (rsi, macd, ema, atr, adx, bbands, stochrsi...) — kila moja
 * ingegharimu credit 1 kwa ombi (jumla ya credits ~11 kwa signal moja
 * ingekuwa zaidi ya mpaka wa free tier wa 8/dakika!). Badala yake, hapa
 * tunavuta RAW CANDLES (`/time_series` — open/high/low/close) mara MOJA
 * kwa kila interval (1h na HTF) — credit 1 TU kwa ombi bila kujali
 * `outputsize` (bars ngapi) — na kuhesabu vigezo VYOTE wenyewe kwa JS
 * (angalia utils/indicators.js: EMA, RSI, MACD, ATR, ADX, Bollinger Bands,
 * StochRSI — formula za kawaida za Wilder/standard). Jumla: CREDITS 2 TU
 * kwa signal moja (1h + 4h) — mbali chini ya kikomo cha 8/dakika.
 *
 * Vigezo vinavyotumika (vyote vimehesabiwa kutoka candles za Twelve Data):
 *   - Bei ya sasa (close ya candle ya mwisho, interval ya `interval`)
 *   - EMA9 dhidi ya EMA21 (mwelekeo/trend) — kwenye `interval` (default 1h)
 *   - RSI(14) (overbought >70 / oversold <30)
 *   - MACD(12,26,9) dhidi ya Signal line (momentum)
 *   - ATR(14) (Average True Range — volatility, inatumika kuhesabu SL/TP
 *     ya auto-trade kiotomatiki kulingana na trend — angalia utils/autoTrader.js)
 *   - Multi-timeframe confirmation: EMA9 dhidi ya EMA21 kwenye `htfInterval`
 *     (default 4h) — mwelekeo wa muda mrefu zaidi. Signal ya 1h peke yake
 *     mara nyingi ni "noise" ya muda mfupi (false breakout); kuhitaji 4h
 *     nayo ikubaliane kunapunguza sana signal za uongo. Angalia
 *     FOREX_HTF_INTERVAL kwenye env kubadilisha (mfano '1day').
 *   - ADX(14) — "nguvu ya trend" (si mwelekeo). ADX < 20 = soko tulivu/
 *     sideways → strength inapunguzwa (cap), kwa sababu EMA/MACD crossovers
 *     kwenye soko tulivu mara nyingi ni "noise" (false breakout). Hii SI
 *     vote — ni "confidence ceiling" inayowekwa BAADA ya votes kuhesabiwa.
 *   - Bollinger Bands(20,2) — bei ikigusa/kupita band ya chini/juu
 *     inachukuliwa kama mean-reversion vote (kama RSI).
 *   - Stochastic RSI(14) — overbought (>80) / oversold (<20) — vote ya
 *     ziada ya mean-reversion, tofauti na RSI ya kawaida (ni "faster").
 *   - Session ya soko (Asia/London/New York, kwa saa za UTC — hesabu ya
 *     ndani, si Twelve Data) — jozi ikiwa nje ya session yake kuu (mfano
 *     EURUSD wakati wa session ya Asia pekee) liquidity/volatility huwa
 *     chini → strength inapunguzwa (cap), kama ADX.
 *   - Economic calendar (utils/economicCalendar.js, feed ya bure ya
 *     ForexFactory): (a) "surprise" vote ikiwa tukio la High/Medium impact
 *     limeshatokea hivi karibuni kwa mojawapo ya currency za jozi, na
 *     (b) bendera ya "newsRisk" ikiwa tukio la High impact liko karibu —
 *     hii HAIONGEZI vote bali inazuia auto-trade (angalia utils/autoTrader.js).
 *
 * Cache: dakika 3 kwa kila jozi+interval — kwa vile credits ni 2 tu kwa
 * signal (badala ya 11), rate limiting si tatizo tena kwa matumizi ya
 * kawaida, lakini kuna rate limiter nyepesi ya usalama (reserveRateSlot)
 * ikiwa jozi nyingi zinaombwa kwa wakati mmoja (mfano autoTrader ikiangalia
 * jozi 3 + mtu akitumia .forex wakati huo huo).
 */

const axios = require('axios');
const { getCalendarContext, computeCalendarVote } = require('./economicCalendar');
const { computeAllIndicators, MIN_CANDLES_RECOMMENDED } = require('./indicators');

const API_KEY = process.env.TWELVE_DATA_API_KEY || null;
const BASE_URL = 'https://api.twelvedata.com';
const TIMEOUT_MS = 12000;
const CACHE_MS = parseInt(process.env.FOREX_CACHE_MS || '', 10) || 3 * 60 * 1000; // dakika 3
const DEFAULT_INTERVAL = '1h';
// Timeframe ya juu zaidi kwa uthibitisho wa mwelekeo (higher-timeframe
// confirmation) — 4h ni chaguo la kawaida kati ya kuwa na maana (si noise
// ya dakika chache) na kutoa signal za kutosha kwa siku (si polepole mno
// kama daily).
const HTF_INTERVAL = process.env.FOREX_HTF_INTERVAL || '4h';

// Bars ngapi za kuomba kwa kila interval — zinahitajika za kutosha kwa
// EMA26/MACD/ADX14/BBands20/StochRSI(14+14+3+3) kutulia (angalia
// utils/indicators.js: MIN_CANDLES_RECOMMENDED). `/time_series` inagharimu
// credit 1 TU bila kujali outputsize, kwa hiyo hakuna hasara kuomba nyingi.
const BASE_OUTPUTSIZE = 150;
const HTF_OUTPUTSIZE = 100;

const cache = new Map(); // "PAIR|interval" -> { data, at }

// ─────────────────────────────────────────────
// Rate limiter nyepesi ya usalama — sasa signal moja ni credits 2 tu
// (badala ya ~11 hapo awali), kwa hiyo hii ni "safety net" tu kwa
// matumizi ya kawaida (mfano pairs kadhaa zikiombwa kwa wakati mmoja),
// si lazima tena kwa uendeshaji wa kawaida.
// ─────────────────────────────────────────────
const TD_RATE_LIMIT = parseInt(process.env.TWELVE_DATA_RATE_LIMIT_PER_MIN || '7', 10);
const RATE_WINDOW_MS = 60 * 1000;
let requestTimestamps = [];
let rateLimitChain = Promise.resolve();

function reserveRateSlot() {
  const step = rateLimitChain.then(async () => {
    const now = Date.now();
    requestTimestamps = requestTimestamps.filter((t) => now - t < RATE_WINDOW_MS);
    if (requestTimestamps.length >= TD_RATE_LIMIT) {
      const oldest = requestTimestamps[0];
      const waitMs = RATE_WINDOW_MS - (now - oldest) + 100; // +100ms usalama
      await new Promise((resolve) => setTimeout(resolve, Math.max(waitMs, 0)));
    }
    requestTimestamps.push(Date.now());
  });
  rateLimitChain = step.catch(() => {}); // usizuie foleni ikiwa hatua moja itashindwa
  return step;
}

async function td(endpoint, params) {
  await reserveRateSlot();
  const { data } = await axios.get(`${BASE_URL}/${endpoint}`, {
    params: { ...params, apikey: API_KEY },
    timeout: TIMEOUT_MS,
  });
  // Twelve Data hurudisha HTTP 200 hata kwa makosa mengi — error halisi
  // iko ndani ya body: { status: "error", code, message }.
  if (data?.status === 'error') {
    const err = new Error(data.message || 'Twelve Data error');
    err.tdCode = data.code;
    throw err;
  }
  return data;
}

// Vuta raw candles (OHLC) kwa interval fulani — credit 1 TU. `order: 'ASC'`
// ili candles ziwe kongwe→mpya moja kwa moja (rahisi kwa indicators.js
// bila kuhitaji kugeuza array).
async function fetchCandles(pairSymbol, interval, outputsize) {
  const res = await td('time_series', {
    symbol: pairSymbol,
    interval,
    outputsize,
    order: 'ASC',
  });
  const values = res?.values;
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error(`Hakuna candles zilizorudi kwa ${pairSymbol} (${interval})`);
  }
  if (values.length < MIN_CANDLES_RECOMMENDED) {
    console.warn(
      `[forexSignal] ${pairSymbol} (${interval}): candles ${values.length} ni chache ` +
      `kuliko zinazopendekezwa (${MIN_CANDLES_RECOMMENDED}) — indicators zingine (ADX/MACD/StochRSI) zinaweza kuwa null.`
    );
  }
  return values;
}

function fmtNum(n) {
  return n == null ? 'N/A' : Number(n).toFixed(5);
}

// ─────────────────────────────────────────────
// Session ya soko (Asia/London/New York) — hesabu ya ndani (saa za UTC),
// SI kutoka Twelve Data. Ramani rahisi ya "session kuu" kwa kila currency
// (wapi liquidity/volatility yake ni kubwa zaidi kwa kawaida) — si sahihi
// 100% (masoko ni ya kimataifa) lakini ni heuristic ya kawaida.
// ─────────────────────────────────────────────
const CCY_PRIMARY_SESSION = {
  JPY: 'ASIA', AUD: 'ASIA', NZD: 'ASIA', CNY: 'ASIA',
  EUR: 'LONDON', GBP: 'LONDON', CHF: 'LONDON',
  USD: 'NEWYORK', CAD: 'NEWYORK',
};

function getActiveSessions(utcHour) {
  const active = [];
  if (utcHour >= 0 && utcHour < 9) active.push('ASIA');
  if (utcHour >= 7 && utcHour < 16) active.push('LONDON');
  if (utcHour >= 12 && utcHour < 21) active.push('NEWYORK');
  return active;
}

function getSessionInfo(baseCcy, quoteCcy) {
  const utcHour = new Date().getUTCHours();
  const active = getActiveSessions(utcHour);
  const primary = [...new Set([CCY_PRIMARY_SESSION[baseCcy], CCY_PRIMARY_SESSION[quoteCcy]].filter(Boolean))];
  const quiet = primary.length > 0 && !primary.some((p) => active.includes(p));
  return { utcHour, active, primary, quiet };
}

async function fetchForexSnapshot(pairSymbol, interval = DEFAULT_INTERVAL) {
  if (!API_KEY) {
    throw new Error('TWELVE_DATA_API_KEY haipo kwenye env');
  }

  const key = `${pairSymbol}|${interval}|${HTF_INTERVAL}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_MS) {
    return cached.data;
  }

  const [baseCcy, quoteCcy] = pairSymbol.split('/');

  // Credits 2 TU: candles za `interval` (1h) + candles za HTF_INTERVAL (4h).
  // Calendar (feed tofauti, isiyotumia Twelve Data credits) inaenda pamoja
  // kwa paralleli — haizuii signal kama itashindwa.
  const [candles, htfCandles, calendar] = await Promise.all([
    fetchCandles(pairSymbol, interval, BASE_OUTPUTSIZE),
    fetchCandles(pairSymbol, HTF_INTERVAL, HTF_OUTPUTSIZE),
    getCalendarContext(baseCcy, quoteCcy),
  ]);

  const ind = computeAllIndicators(candles);
  const htfInd = computeAllIndicators(htfCandles);

  const htf9 = htfInd.ema9;
  const htf21 = htfInd.ema21;
  const htfTrend = htf9 != null && htf21 != null ? (htf9 > htf21 ? 'BUY' : 'SELL') : null;

  const snapshot = {
    pair: pairSymbol,
    interval,
    price: ind.price,
    rsi: ind.rsi,
    macd: ind.macd,
    macdSignal: ind.macdSignal,
    macdHist: ind.macdHist,
    ema9: ind.ema9,
    ema21: ind.ema21,
    atr: ind.atr,
    adx: ind.adx,
    bbUpper: ind.bbUpper,
    bbMiddle: ind.bbMiddle,
    bbLower: ind.bbLower,
    stochK: ind.stochK,
    stochD: ind.stochD,
    htfInterval: HTF_INTERVAL,
    htfEma9: htf9,
    htfEma21: htf21,
    htfTrend,
    baseCcy,
    quoteCcy,
    calendar,
    session: getSessionInfo(baseCcy, quoteCcy),
    at: Date.now(),
  };

  cache.set(key, { data: snapshot, at: Date.now() });
  return snapshot;
}

// ─────────────────────────────────────────────
// Signal ya haraka (kanuni rahisi za kiufundi — si Groq/AI). Kanuni ni
// wazi/dhahiri kwa makusudi ili ijulikane KWA NINI signal fulani imetokea
// (kila kigezo kina "kura" moja) — si "black box".
// ─────────────────────────────────────────────
function computeSignal(s) {
  const notes = [];
  let bullish = 0;
  let bearish = 0;

  // Mwelekeo (EMA crossover) — timeframe ya signal yenyewe (1h)
  if (s.ema9 != null && s.ema21 != null) {
    if (s.ema9 > s.ema21) {
      bullish += 1;
      notes.push('EMA9 iko juu ya EMA21 (mwelekeo wa kupanda)');
    } else {
      bearish += 1;
      notes.push('EMA9 iko chini ya EMA21 (mwelekeo wa kushuka)');
    }
  }

  // RSI — overbought/oversold huchukuliwa kama "ishara ya kugeuka upande
  // mwingine" (mean-reversion), si uthibitisho wa mwelekeo uliopo.
  if (s.rsi != null) {
    if (s.rsi >= 70) {
      bearish += 1;
      notes.push(`RSI ${s.rsi.toFixed(1)} — overbought (inaweza kugeuka kushuka)`);
    } else if (s.rsi <= 30) {
      bullish += 1;
      notes.push(`RSI ${s.rsi.toFixed(1)} — oversold (inaweza kugeuka kupanda)`);
    } else {
      notes.push(`RSI ${s.rsi.toFixed(1)} — eneo la kati (neutral)`);
    }
  }

  // MACD momentum
  if (s.macd != null && s.macdSignal != null) {
    if (s.macd > s.macdSignal) {
      bullish += 1;
      notes.push('MACD iko juu ya Signal line (momentum chanya)');
    } else {
      bearish += 1;
      notes.push('MACD iko chini ya Signal line (momentum hasi)');
    }
  }

  // Multi-timeframe confirmation (mwelekeo wa 4h kwa default) — kura ya 4,
  // uzito sawa na nyingine (si "gate" ngumu, bado ni sehemu ya muundo
  // uleule wa "votes" unaoeleweka). Athari yake halisi: kwa threshold ya
  // default (67%), sasa LAZIMA angalau 3/4 (75%) zikubaliane badala ya
  // 2/3 (67%) za awali — signal lazima ithibitishwe na TIMEFRAME MBILI
  // (1h na 4h), si moja tu, kabla auto-trade haijafunguliwa.
  if (s.htfTrend === 'BUY') {
    bullish += 1;
    notes.push(`Mwelekeo wa ${s.htfInterval || '4h'}: BUY (uthibitisho wa muda mrefu)`);
  } else if (s.htfTrend === 'SELL') {
    bearish += 1;
    notes.push(`Mwelekeo wa ${s.htfInterval || '4h'}: SELL (uthibitisho wa muda mrefu)`);
  }

  // Bollinger Bands(20,2) — bei ikigusa/kupita band ya chini/juu =
  // mean-reversion vote (muundo uleule na RSI hapo juu).
  if (s.price != null && s.bbUpper != null && s.bbLower != null) {
    if (s.price <= s.bbLower) {
      bullish += 1;
      notes.push(`Bei iko kwenye/chini ya Bollinger Band ya chini (${fmtNum(s.bbLower)}) — inaweza kugeuka kupanda`);
    } else if (s.price >= s.bbUpper) {
      bearish += 1;
      notes.push(`Bei iko kwenye/juu ya Bollinger Band ya juu (${fmtNum(s.bbUpper)}) — inaweza kugeuka kushuka`);
    } else {
      notes.push(`Bei iko ndani ya Bollinger Bands (${fmtNum(s.bbLower)}–${fmtNum(s.bbUpper)}) — neutral`);
    }
  }

  // Stochastic RSI(14) — overbought (>80) / oversold (<20), "faster" kuliko
  // RSI ya kawaida — vote ya ziada ya mean-reversion.
  if (s.stochK != null) {
    if (s.stochK >= 80) {
      bearish += 1;
      notes.push(`StochRSI %K ${s.stochK.toFixed(1)} — overbought (inaweza kugeuka kushuka)`);
    } else if (s.stochK <= 20) {
      bullish += 1;
      notes.push(`StochRSI %K ${s.stochK.toFixed(1)} — oversold (inaweza kugeuka kupanda)`);
    } else {
      notes.push(`StochRSI %K ${s.stochK.toFixed(1)} — eneo la kati (neutral)`);
    }
  }

  // Economic calendar — "surprise" vote (kutoka matukio ya hivi karibuni
  // yenye "actual" dhidi ya "forecast") kwa mojawapo ya currency za jozi.
  // Ni kura ya ZIADA (si "gate") — uzito sawa na vigezo vingine vya
  // kiufundi hapo juu, ili strength% ibaki muundo uleule wa "votes".
  let newsRisk = false;
  if (s.calendar && s.baseCcy && s.quoteCcy) {
    const calVote = computeCalendarVote(s.calendar, s.baseCcy, s.quoteCcy);
    bullish += calVote.bullish;
    bearish += calVote.bearish;
    notes.push(...calVote.notes);
    newsRisk = calVote.newsRisk;
  }

  let direction = 'NEUTRAL';
  if (bullish > bearish) direction = 'BUY';
  else if (bearish > bullish) direction = 'SELL';

  const total = bullish + bearish;
  let strength = total > 0 ? Math.round((Math.max(bullish, bearish) / total) * 100) : 0;

  // ─────────────────────────────────────────────
  // "Confidence ceiling" — TOFAUTI na muundo wa votes hapo juu. Hivi
  // havibadilishi DIRECTION wala idadi ya bullish/bearish — vinapunguza
  // tu strength% ya mwisho kama context inaonyesha soko halina "nguvu"
  // ya kutosha kuamini crossover/momentum votes kwa wakati huu.
  // ─────────────────────────────────────────────
  let cap = 100;

  // ADX(14) — trend dhaifu/sideways (ADX<20) hupunguza uzito wa mwelekeo.
  if (s.adx != null) {
    if (s.adx < 20) {
      cap = Math.min(cap, 60);
      notes.push(`ADX ${s.adx.toFixed(1)} — trend dhaifu/sideways (strength imepunguzwa)`);
    } else if (s.adx >= 25) {
      notes.push(`ADX ${s.adx.toFixed(1)} — trend ina nguvu (uthibitisho wa ziada)`);
    } else {
      notes.push(`ADX ${s.adx.toFixed(1)} — trend ya kati`);
    }
  }

  // Session ya soko — jozi ikiwa nje ya session yake kuu, liquidity/
  // volatility huwa chini (moves zisizo za kuaminika sana).
  if (s.session && s.session.quiet) {
    notes.push(
      `Session ya sasa (${s.session.active.join('/') || 'hakuna kuu'}) si session kuu ya jozi hii ` +
      `(${s.session.primary.join('/')}) — liquidity ya chini, strength imepunguzwa`
    );
    cap = Math.min(cap, 70);
  }

  strength = Math.min(strength, cap);

  return { direction, strength, bullish, bearish, notes, newsRisk };
}

module.exports = { fetchForexSnapshot, computeSignal, DEFAULT_INTERVAL, HTF_INTERVAL };
