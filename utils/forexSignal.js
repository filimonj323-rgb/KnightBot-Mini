/**
 * forexSignal.js — Msingi wa data na ishara (signals) za forex.
 *
 * Chanzo cha data: Twelve Data API (bure — https://twelvedata.com/pricing).
 * Tier ya bure (Basic): maombi 800/siku, 8/dakika, ina forex + technical
 * indicators tayari zimehesabuliwa (hatuhesabu RSI/MACD/EMA wenyewe).
 *
 * TWELVE_DATA_API_KEY (LAZIMA iwepo kwenye env):
 *   1. Sajili bure: https://twelvedata.com/pricing (chagua "Basic — $0/mo")
 *   2. Thibitisha email yako (mipaka inaongezeka kutoka default hadi 8/dakika)
 *   3. Nakili API Key kutoka dashboard yako, weka kwenye Railway env vars
 *      kama TWELVE_DATA_API_KEY
 *
 * Vigezo vinavyotumika (vyote kutoka Twelve Data moja kwa moja):
 *   - Bei ya sasa
 *   - EMA9 dhidi ya EMA21 (mwelekeo/trend) — kwenye `interval` (default 1h)
 *   - RSI(14) (overbought >70 / oversold <30)
 *   - MACD dhidi ya Signal line (momentum)
 *   - ATR(14) (Average True Range — volatility, inatumika kuhesabu SL/TP
 *     ya auto-trade kiotomatiki kulingana na trend — angalia utils/autoTrader.js)
 *   - Multi-timeframe confirmation: EMA9 dhidi ya EMA21 kwenye `htfInterval`
 *     (default 4h) — mwelekeo wa muda mrefu zaidi. Signal ya 1h peke yake
 *     mara nyingi ni "noise" ya muda mfupi (false breakout); kuhitaji 4h
 *     nayo ikubaliane kunapunguza sana signal za uongo. Angalia
 *     FOREX_HTF_INTERVAL kwenye env kubadilisha (mfano '1day').
 *   - Economic calendar (utils/economicCalendar.js, feed ya bure ya
 *     ForexFactory): (a) "surprise" vote ikiwa tukio la High/Medium impact
 *     limeshatokea hivi karibuni kwa mojawapo ya currency za jozi, na
 *     (b) bendera ya "newsRisk" ikiwa tukio la High impact liko karibu —
 *     hii HAIONGEZI vote bali inazuia auto-trade (angalia utils/autoTrader.js).
 *
 * Cache: dakika 3 kwa kila jozi+interval — inapunguza matumizi ya credits
 * (tier bure ina mpaka wa 8 maombi/dakika, na ombi 1 la signal linatumia
 * credits 8 — price+rsi+macd+ema9+ema21+atr (1h) + ema9+ema21 (4h)) na
 * kuepuka 429. Kwa vile hii iko KARIBU sana na kikomo cha 8/dakika,
 * AUTO_TRADE_PAIR_STAGGER_MS (utils/autoTrader.js) LAZIMA ibaki angalau
 * sekunde 60-70 kati ya jozi moja na nyingine.
 */

const axios = require('axios');
const { getCalendarContext, computeCalendarVote } = require('./economicCalendar');

const API_KEY = process.env.TWELVE_DATA_API_KEY || null;
const BASE_URL = 'https://api.twelvedata.com';
const TIMEOUT_MS = 12000;
const CACHE_MS = 3 * 60 * 1000; // dakika 3
const DEFAULT_INTERVAL = '1h';
// Timeframe ya juu zaidi kwa uthibitisho wa mwelekeo (higher-timeframe
// confirmation) — 4h ni chaguo la kawaida kati ya kuwa na maana (si noise
// ya dakika chache) na kutoa signal za kutosha kwa siku (si polepole mno
// kama daily).
const HTF_INTERVAL = process.env.FOREX_HTF_INTERVAL || '4h';

const cache = new Map(); // "PAIR|interval" -> { data, at }

async function td(endpoint, params) {
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

function lastVal(series, field) {
  // Indicator endpoints za Twelve Data hurudisha { values: [{datetime, <field>}, ...] }
  // zikianzia mpya kwenda zamani — [0] ndiyo thamani ya hivi karibuni.
  const v = series?.values?.[0];
  if (!v || v[field] == null) return null;
  const n = parseFloat(v[field]);
  return Number.isNaN(n) ? null : n;
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

  const [price, rsi, macd, ema9, ema21, atr, htfEma9, htfEma21, calendar] = await Promise.all([
    td('price', { symbol: pairSymbol }),
    td('rsi', { symbol: pairSymbol, interval, time_period: 14 }),
    td('macd', { symbol: pairSymbol, interval }),
    td('ema', { symbol: pairSymbol, interval, time_period: 9 }),
    td('ema', { symbol: pairSymbol, interval, time_period: 21 }),
    td('atr', { symbol: pairSymbol, interval, time_period: 14 }),
    // Multi-timeframe confirmation — EMA9/EMA21 kwenye HTF_INTERVAL (4h).
    td('ema', { symbol: pairSymbol, interval: HTF_INTERVAL, time_period: 9 }),
    td('ema', { symbol: pairSymbol, interval: HTF_INTERVAL, time_period: 21 }),
    // Economic calendar (feed tofauti, isiyotumia Twelve Data credits) —
    // haizuii signal kama itashindwa (getCalendarContext haitupi error).
    getCalendarContext(baseCcy, quoteCcy),
  ]);

  const htf9 = lastVal(htfEma9, 'ema');
  const htf21 = lastVal(htfEma21, 'ema');
  const htfTrend = htf9 != null && htf21 != null ? (htf9 > htf21 ? 'BUY' : 'SELL') : null;

  const snapshot = {
    pair: pairSymbol,
    interval,
    price: price?.price != null ? parseFloat(price.price) : null,
    rsi: lastVal(rsi, 'rsi'),
    macd: lastVal(macd, 'macd'),
    macdSignal: lastVal(macd, 'macd_signal'),
    macdHist: lastVal(macd, 'macd_hist'),
    ema9: lastVal(ema9, 'ema'),
    ema21: lastVal(ema21, 'ema'),
    atr: lastVal(atr, 'atr'),
    htfInterval: HTF_INTERVAL,
    htfEma9: htf9,
    htfEma21: htf21,
    htfTrend,
    baseCcy,
    quoteCcy,
    calendar,
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
  const strength = total > 0 ? Math.round((Math.max(bullish, bearish) / total) * 100) : 0;

  return { direction, strength, bullish, bearish, notes, newsRisk };
}

module.exports = { fetchForexSnapshot, computeSignal, DEFAULT_INTERVAL, HTF_INTERVAL };
