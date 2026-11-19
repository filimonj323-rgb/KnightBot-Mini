/**
 * utils/candlePatterns.js — Utambuzi wa candlestick patterns kwa kutumia
 * candles ZILIZOFUNGWA tu: Hammer, Shooting Star, Bullish/Bearish Engulfing,
 * Morning Star, Evening Star.
 *
 * Imeundwa kuwa IMARA, si ya kubahatisha — pattern inahesabiwa TU ikiwa:
 *   1. Candle ya mwisho ina range kubwa vya kutosha (>= 0.6 ATR) — inaondoa kelele.
 *   2. Kulikuwa na mwenendo uliotangulia upande wa kinyume (>= 0.8 ATR kwa candles 3)
 *      — hammer bila kushuka kwanza si hammer.
 *   3. Ipo kwenye ENEO MUHIMU: RSI ya chini/juu (<=45 / >=55) AU bei imegusa eneo la
 *      Bollinger band ya chini/juu (ndani ya 0.3 ATR).
 *
 * Function ni safi (pure) na O(1): inasoma candles 6 za mwisho tu. Live (forexSignal)
 * na backtest zinaitumia ILE ILE, kwa hiyo matokeo ya backtest yanawakilisha live.
 */

const MIN_RANGE_ATR = 0.6;
const PRIOR_MOVE_ATR = 0.8;
const ZONE_ATR = 0.3;
const RSI_LOW = 45;
const RSI_HIGH = 55;

const num = (c) => ({ open: Number(c.open), high: Number(c.high), low: Number(c.low), close: Number(c.close) });

function parts(c) {
  const top = Math.max(c.open, c.close);
  const bot = Math.min(c.open, c.close);
  return {
    body: top - bot,
    range: c.high - c.low,
    up: c.high - top, // wick ya juu
    low: bot - c.low, // wick ya chini
    top,
    bot,
    bull: c.close > c.open,
    bear: c.close < c.open,
  };
}

/**
 * @param {Array} candles  candles (zamani → mpya), kila moja ina open/high/low/close
 * @param {number} end     index ya candle ya MWISHO ILIYOFUNGWA (inclusive)
 * @param {{atr:number, rsi?:number, bbLower?:number, bbUpper?:number}} ctx
 * @returns {{direction:'BUY'|'SELL', name:string}|null}
 */
function detectCandlePattern(candles, end, ctx = {}) {
  const atr = Number(ctx.atr);
  if (!Array.isArray(candles) || !Number.isFinite(atr) || atr <= 0 || end < 5 || end >= candles.length) return null;

  const c0 = num(candles[end]);
  const c1 = num(candles[end - 1]);
  const c2 = num(candles[end - 2]);
  const base1 = Number(candles[end - 4].close); // kabla ya c0 (single/engulfing)
  const base2 = Number(candles[end - 5].close); // kabla ya c2 (stars)
  for (const v of [c0.open, c0.high, c0.low, c0.close, c1.open, c1.high, c1.low, c1.close, c2.open, c2.high, c2.low, c2.close, base1, base2]) {
    if (!Number.isFinite(v)) return null;
  }

  const p0 = parts(c0);
  if (p0.range < MIN_RANGE_ATR * atr) return null;
  const p1 = parts(c1);
  const p2 = parts(c2);

  const need = PRIOR_MOVE_ATR * atr;
  const down1 = c1.close - base1 <= -need;
  const up1 = c1.close - base1 >= need;
  const down2 = c2.close - base2 <= -need;
  const up2 = c2.close - base2 >= need;

  const rsi = Number.isFinite(Number(ctx.rsi)) ? Number(ctx.rsi) : null;
  const bbL = Number.isFinite(Number(ctx.bbLower)) ? Number(ctx.bbLower) : null;
  const bbU = Number.isFinite(Number(ctx.bbUpper)) ? Number(ctx.bbUpper) : null;
  const nearLow = (lowest) => (rsi !== null && rsi <= RSI_LOW) || (bbL !== null && lowest <= bbL + ZONE_ATR * atr);
  const nearHigh = (highest) => (rsi !== null && rsi >= RSI_HIGH) || (bbU !== null && highest >= bbU - ZONE_ATR * atr);

  // ── Patterns za candles 3 (nguvu zaidi) ──────────────────────────────
  const longBody2 = p2.body >= 0.5 * atr && p2.body >= 0.6 * p2.range;
  const smallStar = p1.body <= 0.35 * p2.body;
  const mid2 = (c2.open + c2.close) / 2;
  const mid1 = (c1.open + c1.close) / 2;

  if (down2 && longBody2 && p2.bear && smallStar && mid1 <= c2.close + 0.1 * atr &&
      p0.bull && p0.body >= 0.5 * p2.body && c0.close > mid2 &&
      nearLow(Math.min(c0.low, c1.low, c2.low))) {
    return { direction: 'BUY', name: 'Morning Star' };
  }
  if (up2 && longBody2 && p2.bull && smallStar && mid1 >= c2.close - 0.1 * atr &&
      p0.bear && p0.body >= 0.5 * p2.body && c0.close < mid2 &&
      nearHigh(Math.max(c0.high, c1.high, c2.high))) {
    return { direction: 'SELL', name: 'Evening Star' };
  }

  // ── Engulfing (candles 2) ────────────────────────────────────────────
  if (down1 && p1.bear && p0.bull && p1.body >= 0.25 * atr && p0.body > p1.body &&
      c0.open <= c1.close && c0.close >= c1.open && nearLow(Math.min(c0.low, c1.low))) {
    return { direction: 'BUY', name: 'Bullish Engulfing' };
  }
  if (up1 && p1.bull && p0.bear && p1.body >= 0.25 * atr && p0.body > p1.body &&
      c0.open >= c1.close && c0.close <= c1.open && nearHigh(Math.max(c0.high, c1.high))) {
    return { direction: 'SELL', name: 'Bearish Engulfing' };
  }

  // ── Single candle: Hammer / Shooting Star ────────────────────────────
  if (down1 && p0.low >= 0.6 * p0.range && p0.up <= 0.15 * p0.range && p0.body <= 0.35 * p0.range && nearLow(c0.low)) {
    return { direction: 'BUY', name: 'Hammer' };
  }
  if (up1 && p0.up >= 0.6 * p0.range && p0.low <= 0.15 * p0.range && p0.body <= 0.35 * p0.range && nearHigh(c0.high)) {
    return { direction: 'SELL', name: 'Shooting Star' };
  }

  return null;
}

module.exports = { detectCandlePattern };
