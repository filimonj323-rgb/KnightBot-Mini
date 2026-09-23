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
 *   - EMA9 dhidi ya EMA21 (mwelekeo/trend)
 *   - RSI(14) (overbought >70 / oversold <30)
 *   - MACD dhidi ya Signal line (momentum)
 *
 * Cache: dakika 3 kwa kila jozi+interval — inapunguza matumizi ya credits
 * (tier bure ina mpaka wa 8 maombi/dakika, na ombi 1 la signal linatumia
 * credits 5 — price+rsi+macd+ema9+ema21) na kuepuka 429.
 */

const axios = require('axios');

const API_KEY = process.env.TWELVE_DATA_API_KEY || null;
const BASE_URL = 'https://api.twelvedata.com';
const TIMEOUT_MS = 12000;
const CACHE_MS = 3 * 60 * 1000; // dakika 3
const DEFAULT_INTERVAL = '1h';

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

  const key = `${pairSymbol}|${interval}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_MS) {
    return cached.data;
  }

  const [price, rsi, macd, ema9, ema21] = await Promise.all([
    td('price', { symbol: pairSymbol }),
    td('rsi', { symbol: pairSymbol, interval, time_period: 14 }),
    td('macd', { symbol: pairSymbol, interval }),
    td('ema', { symbol: pairSymbol, interval, time_period: 9 }),
    td('ema', { symbol: pairSymbol, interval, time_period: 21 }),
  ]);

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

  // Mwelekeo (EMA crossover)
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

  let direction = 'NEUTRAL';
  if (bullish > bearish) direction = 'BUY';
  else if (bearish > bullish) direction = 'SELL';

  const total = bullish + bearish;
  const strength = total > 0 ? Math.round((Math.max(bullish, bearish) / total) * 100) : 0;

  return { direction, strength, bullish, bearish, notes };
}

module.exports = { fetchForexSnapshot, computeSignal, DEFAULT_INTERVAL };
