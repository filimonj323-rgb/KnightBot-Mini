/**
 * utils/tradeEstimate.js — Maelezo rahisi ya S/R kwa signal + makadirio ya faida/hasara ya trade (Deriv Multipliers).
 *
 * Kazi safi (hakuna mtandao/DB). Inatumika na:
 *   • .forex (signal ya WhatsApp) na signal ya auto-trade  → describeSr()
 *   • arifa baada ya kufungua trade (auto + mkono)           → estimateTrade() + formatEstimate()
 *   • onyesho KABLA ya kufungua trade ya mkono (dashboard)   → estimateTrade()
 *
 * Fomula ya Multipliers: faida/hasara ($) = stake × multiplier × (mabadiliko ya bei ÷ bei ya entry).
 * Kwa hiyo umbali wa bei hadi TP/SL = ($ ÷ (stake × multiplier)) × entry. Ni MAKADIRIO — commission,
 * spread na slippage hazihesabiwi. Hii SI ushauri wa kifedha.
 */

const { toPips, pipSize } = require('./supportResistance');

const decimals = (code) => (pipSize(code) === 0.01 ? 3 : 5);
const f2 = (n) => Number(n).toFixed(2);
const pipsBetween = (code, a, b) => Math.abs(toPips(code, a - b));

/** Nguvu ya zone kwa maneno: touches nyingi / timeframe kubwa = imara zaidi. */
function zoneStrength(z) {
  const t = Number(z.touches) || 0;
  const big = z.tf === '4h' || z.tf === '1d';
  if (t >= 4 || (big && t >= 3)) return { label: 'imara', stars: '★★★' };
  if (t >= 3 || big) return { label: 'wastani', stars: '★★' };
  return { label: 'dhaifu', stars: '★' };
}

/**
 * Maelezo ya S/R kwa lugha rahisi.
 * @returns {{lines:string[], verdict:string, ok:boolean|null, above:object[], below:object[]}}
 *   above/below: [{price, pips, touches, tf, label, stars}] (karibu kwanza)
 */
function describeSr({ code, direction, price, atr, zones, minRoomAtr = 1.5, maxPerSide = 2 }) {
  const dp = decimals(code);
  const zs = Array.isArray(zones) ? zones : [];
  // pips = umbali hadi UKINGO wa karibu wa zone (sawa na kichujio cha S/R)
  const mk = (z) => ({ price: z.price, pips: Number(pipsBetween(code, z.low > price ? z.low : z.high, price).toFixed(1)), touches: z.touches, tf: z.tf, ...zoneStrength(z) });
  const above = zs.filter((z) => z.low > price).sort((a, b) => a.price - b.price).slice(0, maxPerSide).map(mk);
  const below = zs.filter((z) => z.high < price).sort((a, b) => b.price - a.price).slice(0, maxPerSide).map(mk);
  const inside = zs.find((z) => price >= z.low && price <= z.high);

  const row = (z) => `   • ${Number(z.price).toFixed(dp)} — pips ${z.pips} kutoka bei • ${z.label} ${z.stars} (${z.tf || '?'}, imegusa mara ${z.touches})`;
  const lines = ['🧱 *Support / Resistance*'];
  lines.push(`🔴 *Resistance* (ukuta wa juu — bei hukwama/hugeuka chini):`);
  lines.push(...(above.length ? above.map(row) : ['   • hakuna iliyo karibu']));
  lines.push(`🟢 *Support* (sakafu ya chini — bei hushikiliwa/hugeuka juu):`);
  lines.push(...(below.length ? below.map(row) : ['   • hakuna iliyo karibu']));

  let verdict;
  let ok = null;
  if (inside) {
    verdict = `⚠️ Bei iko NDANI ya zone ya S/R (${Number(inside.price).toFixed(dp)}) — eneo la mashaka, subiri bei itoke upande mmoja.`;
  } else if (direction === 'BUY' || direction === 'SELL') {
    const target = direction === 'BUY' ? above[0] : below[0];
    const word = direction === 'BUY' ? 'resistance' : 'support';
    if (!target) {
      verdict = `✅ ${direction}: hakuna ${word} iliyo karibu mbele — njia iko wazi.`;
      ok = true;
    } else {
      const roomAtr = atr > 0 ? (target.pips * pipSize(code)) / atr : null;
      ok = roomAtr == null || roomAtr >= minRoomAtr;
      verdict = ok
        ? `✅ ${direction}: nafasi ya pips ${target.pips}${roomAtr != null ? ` (${roomAtr.toFixed(1)}×ATR)` : ''} kabla ya ${word} (${target.label}) — S/R haizuii.`
        : `🚧 ${direction}: ${word} iko karibu mno (pips ${target.pips}, ${roomAtr.toFixed(1)}×ATR) — bei inaweza kugonga ukuta mapema. Tahadhari.`;
    }
  } else {
    const r = above[0]; const s = below[0];
    verdict = `⚪ Hakuna signal ya kuingia sasa. Bei iko kati ya ${s ? `support ${Number(s.price).toFixed(dp)}` : 'hakuna support'} na ${r ? `resistance ${Number(r.price).toFixed(dp)}` : 'hakuna resistance'}.`;
  }
  lines.push(`👉 *Maana:* ${verdict}`);
  return { lines, verdict, ok, above, below };
}

/**
 * Makadirio ya trade kulingana na entry.
 * @param {object} o  { code, direction, entry, stake, multiplier, slUsd, tpUsd, atr, zones, commission }
 *   slUsd = hasara ya juu ($, chanya); tpUsd = faida lengwa ($, chanya).
 */
function estimateTrade(o) {
  const code = String(o.code || '').toUpperCase();
  const buy = o.direction !== 'SELL';
  const stake = Number(o.stake); const mult = Number(o.multiplier);
  const sl = Number(o.slUsd); const tp = Number(o.tpUsd);
  const notional = stake * mult;
  const est = {
    code, direction: buy ? 'BUY' : 'SELL', stake, multiplier: mult, notional: notional > 0 ? notional : null,
    maxLoss: Number.isFinite(sl) && sl > 0 ? sl : null,
    target: Number.isFinite(tp) && tp > 0 ? tp : null,
    commission: Number.isFinite(Number(o.commission)) ? Number(o.commission) : null,
    entry: null, slPrice: null, tpPrice: null, slPips: null, tpPips: null,
    rr: null, lossPctOfStake: null, profitPctOfStake: null, srTp: null, srSl: null,
  };
  if (est.maxLoss && est.target) est.rr = Number((est.target / est.maxLoss).toFixed(2));
  if (stake > 0) {
    if (est.maxLoss) est.lossPctOfStake = Number(((est.maxLoss / stake) * 100).toFixed(0));
    if (est.target) est.profitPctOfStake = Number(((est.target / stake) * 100).toFixed(0));
  }
  const entry = Number(o.entry);
  if (!(entry > 0) || !(notional > 0)) return est;
  est.entry = entry;
  const dist = (usd) => (usd / notional) * entry;
  if (est.maxLoss) {
    const d = dist(est.maxLoss);
    est.slPrice = buy ? entry - d : entry + d;
    est.slPips = Number(pipsBetween(code, entry, est.slPrice).toFixed(1));
  }
  if (est.target) {
    const d = dist(est.target);
    est.tpPrice = buy ? entry + d : entry - d;
    est.tpPips = Number(pipsBetween(code, entry, est.tpPrice).toFixed(1));
  }

  // S/R kati ya entry na TP / SL
  const zs = Array.isArray(o.zones) ? o.zones : [];
  const dp = decimals(code);
  if (est.tpPrice != null && zs.length) {
    const wall = zs
      .filter((z) => (buy ? z.low > entry && z.low < est.tpPrice : z.high < entry && z.high > est.tpPrice))
      .sort((a, b) => (buy ? a.low - b.low : b.high - a.high))[0];
    est.srTp = wall
      ? { blocked: true, price: wall.price, pips: Number(pipsBetween(code, entry, buy ? wall.low : wall.high).toFixed(1)), ...zoneStrength(wall), tf: wall.tf }
      : { blocked: false };
  }
  if (est.slPrice != null && zs.length) {
    const floor = zs
      .filter((z) => (buy ? z.high < entry && z.high > est.slPrice : z.low > entry && z.low < est.slPrice))
      .sort((a, b) => (buy ? b.high - a.high : a.low - b.low))[0];
    est.srSl = floor
      ? { protected: true, price: floor.price, pips: Number(pipsBetween(code, entry, buy ? floor.high : floor.low).toFixed(1)), ...zoneStrength(floor), tf: floor.tf }
      : { protected: false };
  }
  est.dp = dp;
  return est;
}

/** Mistari ya makadirio kwa ujumbe (WhatsApp) — `title` hiari. */
function formatEstimate(est, { title = '📐 *Makadirio kulingana na entry*' } = {}) {
  const dp = est.dp || decimals(est.code);
  const L = [];
  if (title) L.push(title);
  if (est.entry != null) L.push(`📍 Entry ≈ ${est.entry.toFixed(dp)}`);
  if (est.target != null) {
    L.push(`🎯 Faida (TP): *+$${f2(est.target)}*${est.profitPctOfStake != null ? ` (${est.profitPctOfStake}% ya stake)` : ''}` +
      (est.tpPrice != null ? ` — bei ≈ ${est.tpPrice.toFixed(dp)} (${est.tpPips} pips ${est.direction === 'BUY' ? '⬆️' : '⬇️'})` : ''));
  }
  if (est.maxLoss != null) {
    L.push(`🛑 Hasara (SL): *-$${f2(est.maxLoss)}*${est.lossPctOfStake != null ? ` (${est.lossPctOfStake}% ya stake)` : ''}` +
      (est.slPrice != null ? ` — bei ≈ ${est.slPrice.toFixed(dp)} (${est.slPips} pips ${est.direction === 'BUY' ? '⬇️' : '⬆️'})` : ''));
  }
  if (est.rr != null) L.push(`⚖️ Risk:Reward = 1 : ${est.rr}${est.rr < 1 ? ' ⚠️ (faida lengwa ndogo kuliko hatari)' : ''}`);
  if (est.commission != null && est.commission > 0) L.push(`💳 Commission: $${f2(est.commission)}`);
  if (est.srTp) {
    L.push(est.srTp.blocked
      ? `🚧 ${est.direction === 'BUY' ? 'Resistance' : 'Support'} ${Number(est.srTp.price).toFixed(dp)} (${est.srTp.label} ${est.srTp.stars}) iko *kabla ya TP* — pips ${est.srTp.pips} kutoka entry; bei inaweza kugeuka kabla ya kufika TP.`
      : `✅ Hakuna ${est.direction === 'BUY' ? 'resistance' : 'support'} kati ya entry na TP.`);
  }
  if (est.srSl) {
    L.push(est.srSl.protected
      ? `🛡️ ${est.direction === 'BUY' ? 'Support' : 'Resistance'} ${Number(est.srSl.price).toFixed(dp)} (${est.srSl.label} ${est.srSl.stars}) iko *kabla ya SL* — inaweza kulinda trade.`
      : `ℹ️ Hakuna ${est.direction === 'BUY' ? 'support' : 'resistance'} kabla ya SL — SL ndiyo ulinzi pekee.`);
  }
  L.push('_Makadirio tu (hayajumuishi spread/slippage). Hii SI ushauri wa kifedha._');
  return L.join('\n');
}

module.exports = { zoneStrength, describeSr, estimateTrade, formatEstimate };
