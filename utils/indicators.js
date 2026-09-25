/**
 * indicators.js — Kuhesabu technical indicators wenyewe (RSI, EMA, MACD,
 * ATR, ADX, Bollinger Bands, StochRSI) kutoka raw OHLC candles.
 *
 * KWA NINI: Twelve Data ina endpoint tofauti kwa kila indicator (rsi, macd,
 * ema, atr, adx, bbands, stochrsi...) — kila moja inagharimu credit 1 kwa
 * ombi. Lakini `/time_series` (raw candles: open/high/low/close) inagharimu
 * credit 1 TU kwa ombi, bila kujali `outputsize` (bars ngapi tunaomba).
 * Kwa hiyo: badala ya credits ~7-8 kwa interval moja (indicator 1 kwa 1),
 * tunavuta candles MARA MOJA (credit 1) na kuhesabu vigezo VYOTE wenyewe
 * hapa — bure kabisa baada ya ombi hilo 1.
 *
 * Formula zote zinafuata mbinu za kawaida za Wilder (RSI/ATR/ADX) na
 * standard EMA/SMA — matokeo yanapaswa kuendana na Twelve Data/TradingView
 * kwa asilimia kubwa (tofauti ndogo zinawezekana kutokana na warm-up
 * length/seeding, kama ilivyo kawaida kati ya vyanzo tofauti vya indicators).
 *
 * Candles zinatarajiwa kwa mpangilio wa MUDA (chronological — kongwe kwanza,
 * mpya mwisho): [{open, high, low, close}, ...]. Zinahitajika angalau bars
 * ~60-100 kwa matokeo thabiti ya EMA26/MACD/ADX/StochRSI (angalia
 * MIN_CANDLES_RECOMMENDED hapa chini).
 */

const MIN_CANDLES_RECOMMENDED = 60;

function toNum(v) {
  const n = parseFloat(v);
  return Number.isNaN(n) ? null : n;
}

function closesOf(candles) {
  return candles.map((c) => toNum(c.close));
}

// ─────────────────────────────────────────────
// EMA — Exponential Moving Average. Inarudisha SERIES nzima (array, null
// kabla ya kuwa na bars za kutosha) ili iweze kutumika kama msingi wa MACD.
// ─────────────────────────────────────────────
function emaSeries(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;

  const k = 2 / (period + 1);
  // Seed: SMA ya bars `period` za kwanza.
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  let prev = sum / period;
  out[period - 1] = prev;

  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

function lastNonNull(arr) {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i] != null) return arr[i];
  }
  return null;
}

// ─────────────────────────────────────────────
// RSI (Wilder) — series nzima (inahitajika na StochRSI kwa rolling window).
// ─────────────────────────────────────────────
function rsiSeries(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return out;

  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) gainSum += change;
    else lossSum += -change;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    // Wilder smoothing (sawa na "moving average" ya alpha=1/period).
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

// ─────────────────────────────────────────────
// MACD(12,26,9) — kutoka EMA series mbili.
// ─────────────────────────────────────────────
function macdLatest(closes, fast = 12, slow = 26, signalPeriod = 9) {
  const emaFast = emaSeries(closes, fast);
  const emaSlow = emaSeries(closes, slow);
  const macdSeries = closes.map((_, i) =>
    emaFast[i] != null && emaSlow[i] != null ? emaFast[i] - emaSlow[i] : null
  );
  const macdValuesOnly = macdSeries.filter((v) => v != null);
  if (macdValuesOnly.length < signalPeriod) {
    return { macd: lastNonNull(macdSeries), signal: null, hist: null };
  }
  const signalSeries = emaSeries(macdValuesOnly, signalPeriod);
  const macd = macdValuesOnly[macdValuesOnly.length - 1];
  const signal = lastNonNull(signalSeries);
  return { macd, signal, hist: signal != null ? macd - signal : null };
}

// ─────────────────────────────────────────────
// True Range + ATR (Wilder).
// ─────────────────────────────────────────────
function trueRangeSeries(candles) {
  const tr = new Array(candles.length).fill(null);
  for (let i = 1; i < candles.length; i++) {
    const high = toNum(candles[i].high);
    const low = toNum(candles[i].low);
    const prevClose = toNum(candles[i - 1].close);
    if (high == null || low == null || prevClose == null) continue;
    tr[i] = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
  }
  return tr;
}

function atrLatest(candles, period = 14) {
  const tr = trueRangeSeries(candles);
  const trValues = tr.filter((v) => v != null);
  if (trValues.length < period) return null;

  let sum = 0;
  for (let i = 0; i < period; i++) sum += trValues[i];
  let atr = sum / period;
  for (let i = period; i < trValues.length; i++) {
    atr = (atr * (period - 1) + trValues[i]) / period;
  }
  return atr;
}

// ─────────────────────────────────────────────
// ADX(14) (Wilder) — +DM/-DM/+DI/-DI/DX zote zinahesabiwa kabla ya
// kufikia ADX ya mwisho (Wilder-smoothed average ya DX).
// ─────────────────────────────────────────────
function adxLatest(candles, period = 14) {
  const n = candles.length;
  if (n < period * 2 + 1) return null;

  const highs = candles.map((c) => toNum(c.high));
  const lows = candles.map((c) => toNum(c.low));
  const tr = trueRangeSeries(candles);

  const plusDM = new Array(n).fill(null);
  const minusDM = new Array(n).fill(null);
  for (let i = 1; i < n; i++) {
    const upMove = highs[i] - highs[i - 1];
    const downMove = lows[i - 1] - lows[i];
    plusDM[i] = upMove > downMove && upMove > 0 ? upMove : 0;
    minusDM[i] = downMove > upMove && downMove > 0 ? downMove : 0;
  }

  // Wilder smoothing ya TR/+DM/-DM, kuanzia bar `period` (index 1..period
  // zinatumika kwa "seed" sum, kisha smoothing kutoka hapo).
  let smTR = 0;
  let smPlusDM = 0;
  let smMinusDM = 0;
  for (let i = 1; i <= period; i++) {
    smTR += tr[i] || 0;
    smPlusDM += plusDM[i] || 0;
    smMinusDM += minusDM[i] || 0;
  }

  const dxSeries = [];
  for (let i = period + 1; i < n; i++) {
    smTR = smTR - smTR / period + (tr[i] || 0);
    smPlusDM = smPlusDM - smPlusDM / period + (plusDM[i] || 0);
    smMinusDM = smMinusDM - smMinusDM / period + (minusDM[i] || 0);

    const plusDI = smTR === 0 ? 0 : (100 * smPlusDM) / smTR;
    const minusDI = smTR === 0 ? 0 : (100 * smMinusDM) / smTR;
    const diSum = plusDI + minusDI;
    const dx = diSum === 0 ? 0 : (100 * Math.abs(plusDI - minusDI)) / diSum;
    dxSeries.push(dx);
  }

  if (dxSeries.length < period) return dxSeries.length ? dxSeries[dxSeries.length - 1] : null;

  // ADX ya kwanza = wastani rahisi wa DX za `period` za kwanza, kisha
  // Wilder smoothing kwa zilizobaki.
  let adx = dxSeries.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < dxSeries.length; i++) {
    adx = (adx * (period - 1) + dxSeries[i]) / period;
  }
  return adx;
}

// ─────────────────────────────────────────────
// Bollinger Bands(20,2) — SMA + population std dev.
// ─────────────────────────────────────────────
function bbandsLatest(closes, period = 20, mult = 2) {
  if (closes.length < period) return { upper: null, middle: null, lower: null };
  const window = closes.slice(closes.length - period);
  const mean = window.reduce((a, b) => a + b, 0) / period;
  const variance = window.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
  const sd = Math.sqrt(variance);
  return { upper: mean + mult * sd, middle: mean, lower: mean - mult * sd };
}

// ─────────────────────────────────────────────
// Stochastic RSI(14, stoch 14, %K smooth 3, %D smooth 3).
// ─────────────────────────────────────────────
function stochRsiLatest(closes, rsiPeriod = 14, stochPeriod = 14, kSmooth = 3, dSmooth = 3) {
  const rsi = rsiSeries(closes, rsiPeriod).filter((v) => v != null);
  if (rsi.length < stochPeriod + kSmooth + dSmooth) return { k: null, d: null };

  const rawK = [];
  for (let i = stochPeriod - 1; i < rsi.length; i++) {
    const window = rsi.slice(i - stochPeriod + 1, i + 1);
    const lo = Math.min(...window);
    const hi = Math.max(...window);
    rawK.push(hi === lo ? 0 : ((rsi[i] - lo) / (hi - lo)) * 100);
  }

  const sma = (arr, period) => {
    if (arr.length < period) return [];
    const out = [];
    for (let i = period - 1; i < arr.length; i++) {
      const w = arr.slice(i - period + 1, i + 1);
      out.push(w.reduce((a, b) => a + b, 0) / period);
    }
    return out;
  };

  const kSeries = sma(rawK, kSmooth);
  const dSeries = sma(kSeries, dSmooth);

  return {
    k: kSeries.length ? kSeries[kSeries.length - 1] : null,
    d: dSeries.length ? dSeries[dSeries.length - 1] : null,
  };
}

/**
 * Hesabu vigezo VYOTE kwa candles moja (chronological order) kwa pamoja —
 * hii ndiyo kazi kuu inayoitwa na forexSignal.js.
 */
function computeAllIndicators(candles) {
  const closes = closesOf(candles).filter((v) => v != null);
  const ema9 = lastNonNull(emaSeries(closes, 9));
  const ema21 = lastNonNull(emaSeries(closes, 21));
  const rsi = lastNonNull(rsiSeries(closes, 14));
  const { macd, signal: macdSignal, hist: macdHist } = macdLatest(closes, 12, 26, 9);
  const atr = atrLatest(candles, 14);
  const adx = adxLatest(candles, 14);
  const bb = bbandsLatest(closes, 20, 2);
  const stoch = stochRsiLatest(closes, 14, 14, 3, 3);

  return {
    price: closes.length ? closes[closes.length - 1] : null,
    ema9,
    ema21,
    rsi,
    macd,
    macdSignal,
    macdHist,
    atr,
    adx,
    bbUpper: bb.upper,
    bbMiddle: bb.middle,
    bbLower: bb.lower,
    stochK: stoch.k,
    stochD: stoch.d,
  };
}

module.exports = {
  computeAllIndicators,
  emaSeries,
  rsiSeries,
  macdLatest,
  atrLatest,
  adxLatest,
  bbandsLatest,
  stochRsiLatest,
  MIN_CANDLES_RECOMMENDED,
};
