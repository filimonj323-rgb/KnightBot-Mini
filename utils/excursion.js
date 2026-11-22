/**
 * utils/excursion.js — "Bei imesogea pips ngapi baada ya entry?"
 *
 * Kwa kila entry tunaangalia candles `horizon` zinazofuata (bila kujali SL/TP ya bot) na kupima:
 *   MFE (Max Favorable Excursion)  = umbali mkubwa zaidi bei ilienda KWA FAIDA yako (pips)
 *   MAE (Max Adverse Excursion)    = umbali mkubwa zaidi bei ilienda KINYUME nawe (pips)
 * Kisha: kwa kila kiwango T (mf. 5/10/15/20 pips) — bei ilifika +T kabla ya −T? (first-touch).
 *
 * Hii inaonyesha KWA UKWELI kama entry ina "nafasi" ya faida ndogo-ndogo (scalping/low timeframe):
 * kama MFE ya kawaida (median) ni pips 6 lakini MAE ni pips 9, SL ndogo itaguswa mara nyingi.
 *
 * Dhana ya kihafidhina: candle moja ikigusa +T na −T zote mbili, tunahesabu −T (hasara) kwanza.
 * Entry inadhaniwa kwenye CLOSE ya candle ya signal; kuhesabu kunaanza candle INAYOFUATA.
 */

const { toPips } = require('./supportResistance');

const DEFAULT_THRESHOLDS = [5, 10, 15, 20, 30];

function forwardExcursion({ candles, entryIndex, direction, entryPrice, horizon = 24, pair, thresholds = DEFAULT_THRESHOLDS }) {
  const end = Math.min(candles.length - 1, entryIndex + horizon);
  const bars = end - entryIndex;
  let mfe = 0;
  let mae = 0;
  const firstTouch = {}; // T -> 'WIN' | 'LOSS' | null
  const barsToFav = {}; // T -> idadi ya candles hadi +T (au null)
  for (const t of thresholds) { firstTouch[t] = null; barsToFav[t] = null; }
  let mfeBar = 0;

  for (let k = 1; k <= bars; k++) {
    const c = candles[entryIndex + k];
    const hi = Number(c.high);
    const lo = Number(c.low);
    const fav = toPips(pair, direction === 'BUY' ? hi - entryPrice : entryPrice - lo);
    const adv = toPips(pair, direction === 'BUY' ? entryPrice - lo : hi - entryPrice);
    // Kwenye candle moja: hasara kwanza (kihafidhina) — angalia adverse kabla ya favorable.
    for (const t of thresholds) {
      if (firstTouch[t] !== null) continue;
      if (adv >= t) firstTouch[t] = 'LOSS';
      else if (fav >= t) firstTouch[t] = 'WIN';
    }
    for (const t of thresholds) {
      if (barsToFav[t] === null && fav >= t) barsToFav[t] = k;
    }
    if (fav > mfe) { mfe = fav; mfeBar = k; }
    if (adv > mae) mae = adv;
  }
  return {
    mfe: Number(mfe.toFixed(1)),
    mae: Number(mae.toFixed(1)),
    mfeBar,
    bars,
    complete: bars >= horizon, // false = data iliisha kabla ya horizon kuisha
    firstTouch,
    barsToFav,
  };
}

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

const round1 = (n) => (n == null ? null : Number(n.toFixed(1)));

/** Muhtasari wa excursions nyingi. Zisizokamilika (data iliisha) hazihesabiwi. */
function summarizeExcursions(list, thresholds = DEFAULT_THRESHOLDS) {
  const done = (list || []).filter((e) => e && e.complete);
  const n = done.length;
  if (!n) return { n: 0, skippedIncomplete: (list || []).length };
  const mfe = done.map((e) => e.mfe).sort((a, b) => a - b);
  const mae = done.map((e) => e.mae).sort((a, b) => a - b);
  const avg = (a) => a.reduce((s, x) => s + x, 0) / a.length;
  const byThreshold = {};
  for (const t of thresholds) {
    const reached = done.filter((e) => e.mfe >= t).length;
    const wins = done.filter((e) => e.firstTouch[t] === 'WIN').length;
    const losses = done.filter((e) => e.firstTouch[t] === 'LOSS').length;
    const ttf = done.map((e) => e.barsToFav[t]).filter((x) => x != null).sort((a, b) => a - b);
    byThreshold[t] = {
      reachedPct: round1((reached / n) * 100), // ilifika +T wakati wowote (bila kujali MAE)
      winFirstPct: round1((wins / n) * 100), // +T kabla ya −T
      lossFirstPct: round1((losses / n) * 100),
      medianBars: ttf.length ? quantile(ttf, 0.5) : null, // candles hadi +T (waliofika)
    };
  }
  return {
    n,
    skippedIncomplete: (list || []).length - n,
    mfe: { avg: round1(avg(mfe)), p25: round1(quantile(mfe, 0.25)), median: round1(quantile(mfe, 0.5)), p75: round1(quantile(mfe, 0.75)) },
    mae: { avg: round1(avg(mae)), p25: round1(quantile(mae, 0.25)), median: round1(quantile(mae, 0.5)), p75: round1(quantile(mae, 0.75)) },
    byThreshold,
  };
}

module.exports = { DEFAULT_THRESHOLDS, forwardExcursion, summarizeExcursions };
