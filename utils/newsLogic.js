/**
 * newsLogic.js — mantiki safi (bila DB/mtandao) inayotumiwa na News Trading ya live (newsTrader.js)
 * NA backtest (newsBacktest.js), ili zote ziamue kwa kanuni zile zile.
 */
const economicCalendar = require('./economicCalendar');

// Currency → jozi inayotumika kuifanyia trade (zote ziko kwenye PAIRS za auto-trader / FX_SYMBOL_MAP).
const CURRENCY_PAIR = {
  USD: 'EURUSD',
  EUR: 'EURUSD',
  GBP: 'GBPUSD',
  JPY: 'USDJPY',
  AUD: 'AUDUSD',
  CAD: 'USDCAD',
  CHF: 'USDCHF',
  NZD: 'NZDUSD',
};

const r2 = (n) => Math.round(Number(n) * 100) / 100;

/** Currency ikiimarika (bullish) → BUY jozi ambayo ni base yake / SELL ambayo ni quote (na kinyume chake). */
function pairDirection(currency, bullish) {
  const code = CURRENCY_PAIR[currency];
  if (!code) return null;
  const isBase = code.slice(0, 3) === currency;
  return { pair: code, direction: bullish === isBase ? 'BUY' : 'SELL' };
}

/**
 * Pigia kura matukio (yenye forecast + actual za namba) ya currency moja/dakika moja.
 * Kila tukio: actual > forecast = +1 (viashiria vya "chini ni bora" vinageuzwa); surprise chini ya kizingiti = 0.
 * @returns {{net:number, maxPct:number, summary:string}}
 */
function scoreEvents(usable, minSurprisePct) {
  let net = 0;
  let maxPct = 0;
  const lines = [];
  for (const e of usable) {
    const actual = economicCalendar.parseNumeric(e.actual);
    const forecast = economicCalendar.parseNumeric(e.forecast);
    const diff = actual - forecast;
    const pct = (Math.abs(diff) / Math.max(Math.abs(forecast), 0.1)) * 100;
    let vote = diff > 0 ? 1 : diff < 0 ? -1 : 0;
    if (economicCalendar.isInverseIndicator(e.title)) vote = -vote;
    if (pct < minSurprisePct) vote = 0;
    net += vote;
    if (vote !== 0) maxPct = Math.max(maxPct, pct);
    lines.push(`${e.title}: ${e.actual} vs ${e.forecast} (${r2(pct)}%${vote === 0 ? ', haitoshi' : vote > 0 ? ', ↑' : ', ↓'})`);
  }
  return { net, maxPct, summary: lines.join(' | ') };
}

module.exports = { CURRENCY_PAIR, pairDirection, scoreEvents };
