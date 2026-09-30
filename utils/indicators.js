/**
 * indicators.js — Kuhesabu EMA, RSI, MACD wenyewe kutoka candles ghafi
 * (bila kutegemea Twelve Data). Fomula hizi ni za kawaida/public domain,
 * zinatumika kwa jozi ZOZOTE (pamoja na OTC za Pocket Option ambazo
 * Twelve Data haina data yake), na kwa timeframe YOYOTE (dakika 1, 5, n.k.)
 * — kulingana na candles unazozipitisha.
 *
 * Kila function inachukua array ya bei za kufunga (close prices), kuu kwa
 * mpangilio wa WAKATI (ya zamani kwanza, mpya mwisho).
 */

/**
 * EMA (Exponential Moving Average).
 * @param {number[]} closes - bei za kufunga, za zamani kwanza
 * @param {number} period - mfano 9 au 21
 * @returns {number[]} - array ya EMA yenye urefu sawa na closes (nafasi za
 *   kwanza (period-1) zinabaki `null` kwa sababu hazina data ya kutosha)
 */
function ema(closes, period) {
  const out = new Array(closes.length).fill(null);
  if (closes.length < period) return out;

  const k = 2 / (period + 1);
  // Anzia na SMA ya kwanza kama "seed"
  let sma = 0;
  for (let i = 0; i < period; i++) sma += closes[i];
  sma /= period;
  out[period - 1] = sma;

  let prev = sma;
  for (let i = period; i < closes.length; i++) {
    const val = closes[i] * k + prev * (1 - k);
    out[i] = val;
    prev = val;
  }
  return out;
}

/**
 * RSI (Relative Strength Index), Wilder's smoothing (fomula ya asili).
 * @param {number[]} closes
 * @param {number} period - kawaida 14
 * @returns {number[]} - RSI (0-100), null kwa nafasi zisizo na data ya kutosha
 */
function rsi(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;

  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gainSum += diff;
    else lossSum -= diff;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;

  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

/**
 * MACD (12,26,9 kwa default).
 * @returns {{ macd: number[], signal: number[], hist: number[] }}
 */
function macd(closes, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
  const emaFast = ema(closes, fastPeriod);
  const emaSlow = ema(closes, slowPeriod);

  const macdLine = closes.map((_, i) =>
    emaFast[i] != null && emaSlow[i] != null ? emaFast[i] - emaSlow[i] : null
  );

  // Signal line ni EMA ya macdLine, lakini tu kwa sehemu isiyo na null.
  const firstValid = macdLine.findIndex((v) => v != null);
  const validMacd = firstValid === -1 ? [] : macdLine.slice(firstValid);
  const signalValid = ema(validMacd, signalPeriod);

  const signalLine = new Array(closes.length).fill(null);
  const histLine = new Array(closes.length).fill(null);
  for (let i = 0; i < signalValid.length; i++) {
    const idx = firstValid + i;
    signalLine[idx] = signalValid[i];
    if (signalValid[i] != null && macdLine[idx] != null) {
      histLine[idx] = macdLine[idx] - signalValid[i];
    }
  }

  return { macd: macdLine, signal: signalLine, hist: histLine };
}

/** Thamani ya mwisho isiyo null kwenye array (au null ikiwa haipo). */
function lastValid(arr) {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i] != null) return arr[i];
  }
  return null;
}

/**
 * ATR (Average True Range) — inahitaji high/low/close, si close pekee.
 * @param {{high:number, low:number, close:number}[]} candles - za zamani kwanza
 * @param {number} period
 * @returns {number[]}
 */
function atr(candles, period = 14) {
  const out = new Array(candles.length).fill(null);
  if (candles.length <= period) return out;

  const trueRanges = candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    const prevClose = candles[i - 1].close;
    return Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
  });

  let sum = 0;
  for (let i = 1; i <= period; i++) sum += trueRanges[i];
  let prevAtr = sum / period;
  out[period] = prevAtr;

  for (let i = period + 1; i < candles.length; i++) {
    prevAtr = (prevAtr * (period - 1) + trueRanges[i]) / period;
    out[i] = prevAtr;
  }
  return out;
}

/**
 * Signal ya BUY/SELL/NEUTRAL + strength (%), sawa na mantiki ya
 * utils/forexSignal.js lakini kutoka candles ghafi za broker (Pocket
 * Option) badala ya Twelve Data. candles: za zamani kwanza, kila moja
 * {open, high, low, close, time}.
 */
function computeSignalFromCandles(candles) {
  const closes = candles.map((c) => c.close);
  const emaFastArr = ema(closes, 9);
  const emaSlowArr = ema(closes, 21);
  const rsiArr = rsi(closes, 14);
  const { hist: macdHistArr } = macd(closes);
  const atrArr = atr(candles, 14);

  const emaFast = lastValid(emaFastArr);
  const emaSlow = lastValid(emaSlowArr);
  const rsiVal = lastValid(rsiArr);
  const macdHist = lastValid(macdHistArr);
  const atrVal = lastValid(atrArr);
  const price = closes[closes.length - 1];

  const notes = [];
  let buyVotes = 0;
  let sellVotes = 0;

  if (emaFast != null && emaSlow != null) {
    if (emaFast > emaSlow) { buyVotes++; notes.push('EMA9 iko juu ya EMA21 (trend ya kupanda)'); }
    else if (emaFast < emaSlow) { sellVotes++; notes.push('EMA9 iko chini ya EMA21 (trend ya kushuka)'); }
  }
  if (rsiVal != null) {
    if (rsiVal < 30) { buyVotes++; notes.push(`RSI ${rsiVal.toFixed(1)} — oversold`); }
    else if (rsiVal > 70) { sellVotes++; notes.push(`RSI ${rsiVal.toFixed(1)} — overbought`); }
  }
  if (macdHist != null) {
    if (macdHist > 0) { buyVotes++; notes.push('MACD histogram chanya (momentum ya kupanda)'); }
    else if (macdHist < 0) { sellVotes++; notes.push('MACD histogram hasi (momentum ya kushuka)'); }
  }

  const totalVotes = 3;
  let direction = 'NEUTRAL';
  let strength = 0;
  if (buyVotes > sellVotes) {
    direction = 'BUY';
    strength = Math.round((buyVotes / totalVotes) * 100);
  } else if (sellVotes > buyVotes) {
    direction = 'SELL';
    strength = Math.round((sellVotes / totalVotes) * 100);
  }

  return { direction, strength, notes, price, atr: atrVal, rsi: rsiVal, emaFast, emaSlow, macdHist };
}

module.exports = { ema, rsi, macd, atr, lastValid, computeSignalFromCandles };
