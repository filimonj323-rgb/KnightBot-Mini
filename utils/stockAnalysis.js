/**
 * Stock Analysis Engine — Uchambuzi wa Msingi wa Hisa (Fundamental Analysis)
 *
 * Hii ni "engine" tofauti na command yenyewe ili iweze kutumika na command
 * zaidi ya moja (mfano .analyze na baadaye .dse <symbol> analyze).
 *
 * MAWAZO MUHIMU (soma kabla ya kubadilisha vigezo):
 * - Vigezo vya msingi (EPS, BVPS, DPS) HAVIPATIKANI kwenye HTML/JSON ya
 *   dse.co.tz (Market Summary na gainers/losers zinatoa bei tu, si taarifa
 *   za kihasibu). Kwa hiyo vinatunzwa kwa mkono kwenye data/fundamentals.json
 *   na yanahitaji kusasishwa (update) kila baada ya ripoti mpya ya kampuni
 *   (robo mwaka / mwaka) kutoka dse.co.tz/listed/company au tovuti ya
 *   kampuni husika.
 * - Uwiano (P/E, P/B, ROE, Dividend Yield) hapa unatumia bei ya SASA
 *   (live/close kutoka dse.js) pamoja na EPS/BVPS/DPS zilizohifadhiwa.
 * - "Verdict" ni MWONGOZO wa haraka (heuristic score), SI ushauri wa
 *   kitaalamu wa uwekezaji. Daima onyesha disclaimer kwa mtumiaji.
 */

// Vigezo vya "benchmark" kwa soko la DSE (hasa sekta ya benki, ambayo ndiyo
// yenye hisa nyingi zenye taarifa za fundamentals kwa sasa). Hivi ni makadirio
// ya jumla, si sheria — masoko madogo kama DSE mara nyingi yana P/E na P/B
// tofauti kidogo na masoko makubwa (Nairobi, Johannesburg, n.k).
const BENCHMARKS = {
  pe: { cheap: 8, fair: 12, full: 16 }, // < cheap = nafuu, > full = ghali
  pb: { cheap: 1.0, fair: 1.8, full: 2.5 },
  roe: { weak: 10, ok: 15, strong: 20 }, // asilimia
  divYield: { none: 0, low: 1, good: 4 }, // asilimia
};

/**
 * Hesabu uwiano wa msingi wa uwekezaji kutoka bei ya sasa + fundamentals.
 * @param {Object} p
 * @param {number} p.price - Bei ya sasa (close/live) TZS
 * @param {number} p.eps - Earnings Per Share (TZS)
 * @param {number} p.bvps - Book Value Per Share (TZS)
 * @param {number} [p.dps] - Dividend Per Share (TZS), hiari
 * @param {number} [p.roe] - Return on Equity (%), hiari — ikikosekana
 *        inahesabiwa kama (EPS / BVPS) * 100
 */
function computeRatios({ price, eps, bvps, dps = 0, roe }) {
  const pe = eps > 0 ? price / eps : null;
  const pb = bvps > 0 ? price / bvps : null;
  const divYield = price > 0 ? (dps / price) * 100 : 0;
  const roeCalc = roe != null ? roe : bvps > 0 ? (eps / bvps) * 100 : null;

  return { pe, pb, divYield, roe: roeCalc };
}

// Hukagua kigezo kimoja dhidi ya benchmark na kurudisha alama (-1 hadi +2)
// pamoja na sababu fupi kwa Kiswahili — hii ndiyo "structure" ya uchambuzi.
function scorePE(pe) {
  if (pe == null) return { points: 0, note: 'P/E haipatikani (EPS haijulikani au ni hasi)' };
  if (pe < BENCHMARKS.pe.cheap) return { points: 2, note: `P/E ${pe.toFixed(2)}x — chini ya wastani, inaonekana nafuu` };
  if (pe < BENCHMARKS.pe.fair) return { points: 1, note: `P/E ${pe.toFixed(2)}x — iko sawa/nzuri` };
  if (pe < BENCHMARKS.pe.full) return { points: 0, note: `P/E ${pe.toFixed(2)}x — bei "fair" lakini si nafuu tena` };
  return { points: -1, note: `P/E ${pe.toFixed(2)}x — juu kuliko wastani, soko limeshaipandisha bei` };
}

function scorePB(pb) {
  if (pb == null) return { points: 0, note: 'P/B haipatikani (BVPS haijulikani)' };
  if (pb < BENCHMARKS.pb.cheap) return { points: 2, note: `P/B ${pb.toFixed(2)}x — chini ya thamani ya vitabu (undervalued kwa mizania)` };
  if (pb < BENCHMARKS.pb.fair) return { points: 1, note: `P/B ${pb.toFixed(2)}x — karibu na thamani ya vitabu` };
  if (pb < BENCHMARKS.pb.full) return { points: 0, note: `P/B ${pb.toFixed(2)}x — soko linalipia premium ya wastani juu ya vitabu` };
  return { points: -1, note: `P/B ${pb.toFixed(2)}x — premium kubwa juu ya thamani ya vitabu` };
}

function scoreROE(roe) {
  if (roe == null) return { points: 0, note: 'ROE haipatikani' };
  if (roe >= BENCHMARKS.roe.strong) return { points: 2, note: `ROE ${roe.toFixed(1)}% — faida nzuri sana kwa mtaji wa wanahisa` };
  if (roe >= BENCHMARKS.roe.ok) return { points: 1, note: `ROE ${roe.toFixed(1)}% — faida nzuri` };
  if (roe >= BENCHMARKS.roe.weak) return { points: 0, note: `ROE ${roe.toFixed(1)}% — ya wastani` };
  return { points: -1, note: `ROE ${roe.toFixed(1)}% — dhaifu, kampuni haitumii mtaji vizuri` };
}

function scoreDivYield(divYield) {
  if (!divYield || divYield <= BENCHMARKS.divYield.none) {
    return { points: -1, note: 'Hakuna gawio (dividend) kwa sasa — faida yote inabaki kampuni (growth stock)' };
  }
  if (divYield < BENCHMARKS.divYield.low) return { points: 0, note: `Dividend yield ${divYield.toFixed(2)}% — ndogo` };
  if (divYield < BENCHMARKS.divYield.good) return { points: 1, note: `Dividend yield ${divYield.toFixed(2)}% — ya wastani` };
  return { points: 2, note: `Dividend yield ${divYield.toFixed(2)}% — nzuri kwa kipato cha muda mrefu` };
}

// Muhtasari wa mwisho — jumlisha alama na uamue "verdict" ya jumla.
function verdictFromScore(score) {
  if (score >= 4) return '🟢 Inavutia kwa uwekezaji wa muda mrefu (kwa mtazamo wa fundamentals)';
  if (score >= 1) return '🟡 Inakubalika, lakini si "bargain" wazi — fanya utafiti zaidi';
  if (score >= -1) return '🟠 Bei ipo juu kidogo kuliko inavyoonyesha misingi yake ya kifedha';
  return '🔴 Kwa sasa haionekani nafuu kwa mtazamo wa fundamentals pekee';
}

/**
 * Fanya uchambuzi kamili wa hisa moja.
 * @param {Object} input - { symbol, price, eps, bvps, dps, roe, name, sector, asOf, source }
 * @returns {Object} muundo kamili wa uchambuzi (ratios, checks, score, verdict)
 */
function analyzeStock(input) {
  const { price, eps, bvps, dps = 0, roe } = input;
  const ratios = computeRatios({ price, eps, bvps, dps, roe });

  const checks = [
    { key: 'pe', ...scorePE(ratios.pe) },
    { key: 'pb', ...scorePB(ratios.pb) },
    { key: 'roe', ...scoreROE(ratios.roe) },
    { key: 'divYield', ...scoreDivYield(ratios.divYield) },
  ];

  const score = checks.reduce((sum, c) => sum + c.points, 0);
  const verdict = verdictFromScore(score);

  return { ...input, ratios, checks, score, verdict };
}

module.exports = { computeRatios, analyzeStock, BENCHMARKS };
