/**
 * utils/supportResistance.js — Support/Resistance (S/R) kutoka swing highs/lows.
 *
 * Kazi safi (hakuna mtandao/DB) ili itumike LIVE (forexSignal snapshot → autoTrader)
 * na kwenye BACKTEST kwa kanuni ileile. Kanuni:
 *   1. Swing high = high ya candle iliyo juu kuliko `left` candles kushoto na `right` kulia
 *      (swing low kinyume chake). Pivot inathibitishwa tu baada ya `right` candles kupita,
 *      kwa hiyo hesabu kwenye index `i` HAITUMII data ya baadaye (hakuna lookahead).
 *   2. Pivots zilizo karibu (ndani ya `mergeAtr` × ATR) zinaunganishwa kuwa ZONE moja.
 *      Zone yenye pivots nyingi (touches) ni imara zaidi.
 *   3. Zone chini ya bei = support, juu ya bei = resistance (zone ikivukwa hubadilisha kazi).
 *   4. `checkRoom()` inapima nafasi (room) kati ya bei na zone iliyo mbele ya trade:
 *      BUY → resistance ya karibu juu, SELL → support ya karibu chini.
 */

const DEFAULTS = {
  left: 5,
  right: 5,
  lookback: 300, // candles za mwisho za kuchunguza
  mergeAtr: 0.5, // pivots ndani ya 0.5×ATR → zone moja
  minTouches: 2, // zone yenye pivots chache kuliko hii haihesabiwi
};

/** Ukubwa wa pip: JPY = 0.01, nyingine = 0.0001. Inakubali 'EURUSD' au 'EUR/USD'. */
function pipSize(pair) {
  const s = String(pair || '').toUpperCase().replace(/[^A-Z]/g, '');
  return s.includes('JPY') ? 0.01 : 0.0001;
}

function toPips(pair, priceDiff) {
  return priceDiff / pipSize(pair);
}

/**
 * Swing pivots zilizothibitishwa hadi `upTo` (inclusive). Pivot kwenye index p
 * inahitaji p + right <= upTo.
 * @returns {{highs:{i:number,price:number}[], lows:{i:number,price:number}[]}}
 */
function findPivots(candles, upTo, opts = {}) {
  const left = opts.left ?? DEFAULTS.left;
  const right = opts.right ?? DEFAULTS.right;
  const lookback = opts.lookback ?? DEFAULTS.lookback;
  const last = Math.min(upTo ?? candles.length - 1, candles.length - 1);
  const start = Math.max(left, last - lookback);
  const highs = [];
  const lows = [];
  for (let p = start; p + right <= last; p++) {
    const hi = Number(candles[p].high);
    const lo = Number(candles[p].low);
    let isHigh = true;
    let isLow = true;
    for (let k = 1; k <= left && (isHigh || isLow); k++) {
      if (Number(candles[p - k].high) >= hi) isHigh = false;
      if (Number(candles[p - k].low) <= lo) isLow = false;
    }
    for (let k = 1; k <= right && (isHigh || isLow); k++) {
      if (Number(candles[p + k].high) > hi) isHigh = false;
      if (Number(candles[p + k].low) < lo) isLow = false;
    }
    if (isHigh) highs.push({ i: p, price: hi });
    if (isLow) lows.push({ i: p, price: lo });
  }
  return { highs, lows };
}

/**
 * Unganisha pivots kuwa zones. `atr` (bei, si pips) inatoa upana wa kuunganisha.
 * @returns {{price:number, low:number, high:number, touches:number, lastI:number}[]} imepangwa kwa bei ASC
 */
function buildZones(candles, upTo, atr, opts = {}) {
  const mergeAtr = opts.mergeAtr ?? DEFAULTS.mergeAtr;
  const minTouches = opts.minTouches ?? DEFAULTS.minTouches;
  if (!(atr > 0)) return [];
  const { highs, lows } = findPivots(candles, upTo, opts);
  const pts = [...highs, ...lows].sort((a, b) => a.price - b.price);
  const tol = mergeAtr * atr;
  const zones = [];
  let cur = null;
  for (const p of pts) {
    if (cur && p.price - cur.high <= tol) {
      cur.sum += p.price;
      cur.touches += 1;
      cur.high = p.price;
      cur.lastI = Math.max(cur.lastI, p.i);
    } else {
      if (cur) zones.push(cur);
      cur = { low: p.price, high: p.price, sum: p.price, touches: 1, lastI: p.i };
    }
  }
  if (cur) zones.push(cur);
  return zones
    .filter((z) => z.touches >= minTouches)
    .map((z) => ({ price: z.sum / z.touches, low: z.low, high: z.high, touches: z.touches, lastI: z.lastI }));
}

/** Zone ya karibu chini (support) na juu (resistance) ya `price`. */
function nearestLevels(zones, price) {
  let support = null;
  let resistance = null;
  for (const z of zones || []) {
    if (z.high < price) {
      if (!support || z.price > support.price) support = z;
    } else if (z.low > price) {
      if (!resistance || z.price < resistance.price) resistance = z;
    }
    // bei iko NDANI ya zone — si support wala resistance safi; inapuuzwa hapa.
  }
  return { support, resistance };
}

/**
 * Nafasi kati ya bei na zone iliyo mbele ya trade.
 * BUY → resistance juu; SELL → support chini. Hakuna zone mbele = nafasi isiyo na kikomo (ok).
 * @returns {{ok:boolean, level:object|null, roomPrice:number|null, roomAtr:number|null, reason:string}}
 */
function checkRoom({ direction, price, atr, zones, minRoomAtr = 1.5 }) {
  const { support, resistance } = nearestLevels(zones, price);
  const level = direction === 'BUY' ? resistance : direction === 'SELL' ? support : null;
  if (!level) return { ok: true, level: null, roomPrice: null, roomAtr: null, reason: 'hakuna S/R mbele' };
  // Umbali hadi mwanzo wa zone (ukingo wa karibu wa zone), si katikati yake.
  const roomPrice = direction === 'BUY' ? level.low - price : price - level.high;
  const roomAtr = atr > 0 ? roomPrice / atr : null;
  const ok = roomAtr == null || roomAtr >= minRoomAtr;
  return {
    ok,
    level,
    roomPrice,
    roomAtr,
    reason: ok
      ? `nafasi ${roomAtr?.toFixed(1)}×ATR hadi ${direction === 'BUY' ? 'resistance' : 'support'}`
      : `${direction === 'BUY' ? 'resistance' : 'support'} iko karibu (${roomAtr?.toFixed(1)}×ATR < ${minRoomAtr}×ATR)`,
  };
}

/**
 * Zones za mfululizo wa candles za timeframe moja → muundo mwepesi wa kuhifadhi kwenye snapshot.
 * `tf` inaandikwa ili ionekane zone ilitoka timeframe ipi (4h = imara zaidi).
 */
function zonesForSnapshot(candles, atr, tf, opts = {}) {
  if (!Array.isArray(candles) || candles.length < 30) return [];
  return buildZones(candles, candles.length - 2, atr, opts).map((z) => ({
    price: z.price, low: z.low, high: z.high, touches: z.touches, tf,
  }));
}

module.exports = {
  DEFAULTS,
  pipSize,
  toPips,
  findPivots,
  buildZones,
  nearestLevels,
  checkRoom,
  zonesForSnapshot,
};
