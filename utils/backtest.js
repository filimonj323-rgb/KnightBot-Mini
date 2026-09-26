/**
 * utils/backtest.js — Backtesting ya mkakati wa forexSignal.js/autoTrader.js
 * dhidi ya candles za KIHISTORIA, ili kupima win-rate/profit factor/max
 * drawdown KABLA ya kuamini mkakati na pesa halisi zaidi.
 *
 * KANUNI KUU: tunatumia computeSignal() ILE ILE inayotumika LIVE (kutoka
 * forexSignal.js) na computeAtrBasedRisk() ILE ILE ya autoTrader.js — si
 * nakala/marudio ya logic. Kwa hiyo matokeo ya backtest yanaonyesha KWELI
 * jinsi mkakati ungefanya kazi, si mkakati "mwingine" unaofanana tu.
 *
 * MAPUNGUFU YA KWELI (soma kabla ya kuamini matokeo):
 *   1. HAKUNA economic-calendar vote/newsRisk (data ya kihistoria ya matukio
 *      + "actual vs forecast" haipatikani kwa urahisi bure) — signal za
 *      backtest zinaweza kuwa NYINGI KIDOGO kuliko live (live inazuia
 *      baadhi ya trades karibu na habari kubwa).
 *   2. Session-quiet cap INAHESABIWA kutoka saa ya UTC ya candle yenyewe —
 *      hii inadhania Twelve Data inarudisha muda kwa UTC (kawaida kwa
 *      forex time_series bila param ya timezone, lakini si hakika 100%).
 *   3. SPREAD/SLIPPAGE HAZIHESABIWI — entry/exit ni bei ya candle moja kwa
 *      moja. Live trading ina spread ya Deriv ambayo backtest hii haioni,
 *      kwa hiyo matokeo halisi ya live yanaweza kuwa MABAYA KIDOGO kuliko
 *      hapa (kama ilivyotajwa awali: utendaji halisi mara nyingi ni chini
 *      ya backtest).
 *   4. Ikiwa SL na TP zote mbili "zinaguswa" ndani ya candle MOJA (high/low
 *      range yake inafunika bei zote mbili), tunadhania SL iliguswa KWANZA
 *      (dhana ya kihafidhina/makini — si kweli 100% ya wakati, lakini
 *      inaepuka kuonyesha matokeo mazuri mno kwa bahati).
 *   5. Trade MOJA TU kwa jozi kwa wakati mmoja (kama live), na haizingatii
 *      circuit breakers (daily loss/consecutive losses) — hizi zinaweza
 *      kuzuia baadhi ya trades live ambazo backtest bado inazihesabu.
 */

const {
  fetchCandles,
  computeSignal,
  DEFAULT_INTERVAL,
  HTF_INTERVAL,
  getActiveSessions,
  CCY_PRIMARY_SESSION,
} = require('./forexSignal');
const { computeAllIndicatorSeries, MIN_CANDLES_RECOMMENDED } = require('./indicators');
const { getStatus, computeAtrBasedRisk } = require('./autoTrader');

const BASE_OUTPUTSIZE_DEFAULT = 1500; // ~62 siku za candles za 1h
const MAX_OUTPUTSIZE = 5000; // kikomo cha kawaida cha Twelve Data time_series

function sessionInfoAtHour(baseCcy, quoteCcy, utcHour) {
  const active = getActiveSessions(utcHour);
  const primary = [...new Set([CCY_PRIMARY_SESSION[baseCcy], CCY_PRIMARY_SESSION[quoteCcy]].filter(Boolean))];
  const quiet = primary.length > 0 && !primary.some((p) => active.includes(p));
  return { utcHour, active, primary, quiet };
}

function utcHourOf(datetimeStr) {
  // Twelve Data: "YYYY-MM-DD HH:MM:SS" — tunadhania UTC (angalia kikwazo #2
  // juu). Kubadilisha nafasi kuwa 'T' + 'Z' kunalazimisha JS kusoma kama UTC.
  const iso = `${datetimeStr.replace(' ', 'T')}Z`;
  const d = new Date(iso);
  return d.getUTCHours();
}

/**
 * Kwa kila 1h candle index, tafuta HTF (4h) candle ya MWISHO ambayo
 * IMESHAFUNGWA kabla/sawa na wakati wa 1h candle hiyo (two-pointer, zote
 * mbili zimepangwa ASC) — inazuia "lookahead" (kutumia HTF candle ambayo
 * bado haijatokea wakati huo).
 */
function alignHtfIndex(candles1h, candlesHtf) {
  const out = new Array(candles1h.length).fill(-1);
  let j = -1;
  for (let i = 0; i < candles1h.length; i++) {
    const t1h = new Date(`${candles1h[i].datetime.replace(' ', 'T')}Z`).getTime();
    while (j + 1 < candlesHtf.length) {
      const tHtf = new Date(`${candlesHtf[j + 1].datetime.replace(' ', 'T')}Z`).getTime();
      if (tHtf <= t1h) j++;
      else break;
    }
    out[i] = j;
  }
  return out;
}

/**
 * Inaendesha backtest MOJA kwa jozi moja.
 * @param {{code:string, symbol:string, bars?:number, strengthThreshold?:number}} opts
 */
async function runBacktest(opts) {
  const { code, symbol } = opts;
  const bars = Math.max(200, Math.min(Number(opts.bars) || BASE_OUTPUTSIZE_DEFAULT, MAX_OUTPUTSIZE));
  const status = getStatus();
  const stake = Number(opts.stake) || status.stake;
  const multiplier = Number(opts.multiplier) || status.multiplier;
  const strengthThreshold = Number(opts.strengthThreshold) || status.strengthThreshold;
  const slAtrMult = status.slAtrMult;
  const tpAtrMult = status.tpAtrMult;
  const fallbackSl = status.fallbackSl;
  const fallbackTp = status.fallbackTp;

  const [baseCcy, quoteCcy] = symbol.split('/');

  // Credits 2 TU (kama live) — bila kujali `bars` (outputsize haiathiri
  // gharama ya Twelve Data kwa /time_series).
  const [candles1h, candlesHtf] = await Promise.all([
    fetchCandles(symbol, DEFAULT_INTERVAL, bars),
    fetchCandles(symbol, HTF_INTERVAL, Math.min(MAX_OUTPUTSIZE, Math.ceil(bars / 4) + 60)),
  ]);

  if (candles1h.length < MIN_CANDLES_RECOMMENDED * 2) {
    throw new Error(
      `Candles ${candles1h.length} ni chache mno kwa backtest ya kuaminika (angalau ${MIN_CANDLES_RECOMMENDED * 2} zinapendekezwa).`
    );
  }

  const series1h = computeAllIndicatorSeries(candles1h);
  const seriesHtf = computeAllIndicatorSeries(candlesHtf);
  const htfIndexFor1h = alignHtfIndex(candles1h, candlesHtf);

  const trades = [];
  let openTrade = null; // { direction, entryIndex, entryPrice, slPrice, tpPrice }
  const warmup = MIN_CANDLES_RECOMMENDED; // epuka bars za mwanzo zenye null nyingi

  for (let i = warmup; i < candles1h.length; i++) {
    // ── Kwanza angalia kama trade iliyo wazi imefungwa kwenye bar hii ──
    if (openTrade) {
      const c = candles1h[i];
      const high = Number(c.high);
      const low = Number(c.low);
      let closedPrice = null;
      let outcome = null;

      const hitSl = openTrade.direction === 'BUY' ? low <= openTrade.slPrice : high >= openTrade.slPrice;
      const hitTp = openTrade.direction === 'BUY' ? high >= openTrade.tpPrice : low <= openTrade.tpPrice;

      if (hitSl) {
        closedPrice = openTrade.slPrice;
        outcome = 'LOSS';
      } else if (hitTp) {
        closedPrice = openTrade.tpPrice;
        outcome = 'WIN';
      }

      if (outcome) {
        const priceChange =
          openTrade.direction === 'BUY' ? closedPrice - openTrade.entryPrice : openTrade.entryPrice - closedPrice;
        const pnlUsd = (stake * multiplier * priceChange) / openTrade.entryPrice;
        trades.push({
          code,
          direction: openTrade.direction,
          entryAt: candles1h[openTrade.entryIndex].datetime,
          exitAt: c.datetime,
          entryPrice: openTrade.entryPrice,
          exitPrice: closedPrice,
          outcome,
          pnlUsd: Number(pnlUsd.toFixed(2)),
          barsHeld: i - openTrade.entryIndex,
        });
        openTrade = null;
      }
    }

    // ── Kama bado hakuna trade wazi, angalia kama signal mpya inatokea ──
    if (!openTrade) {
      const htfIdx = htfIndexFor1h[i];
      const htf9 = htfIdx >= 0 ? seriesHtf.ema9[htfIdx] : null;
      const htf21 = htfIdx >= 0 ? seriesHtf.ema21[htfIdx] : null;
      const htfTrend = htf9 != null && htf21 != null ? (htf9 > htf21 ? 'BUY' : 'SELL') : null;

      const snapshot = {
        pair: symbol,
        price: series1h.price[i],
        rsi: series1h.rsi[i],
        macd: series1h.macd[i],
        macdSignal: series1h.macdSignal[i],
        ema9: series1h.ema9[i],
        ema21: series1h.ema21[i],
        atr: series1h.atr[i],
        adx: series1h.adx[i],
        bbUpper: series1h.bbUpper[i],
        bbLower: series1h.bbLower[i],
        stochK: series1h.stochK[i],
        htfInterval: HTF_INTERVAL,
        htfTrend,
        baseCcy,
        quoteCcy,
        calendar: null, // haipatikani kihistoria — angalia kikwazo #1 juu
        session: sessionInfoAtHour(baseCcy, quoteCcy, utcHourOf(candles1h[i].datetime)),
      };

      const sig = computeSignal(snapshot);
      if (sig.direction !== 'NEUTRAL' && sig.strength >= strengthThreshold) {
        const entryPrice = series1h.price[i];
        const risk = computeAtrBasedRisk({ atr: series1h.atr[i], price: entryPrice, stake, multiplier });
        let slUsd, tpUsd;
        if (risk && risk.sl > 0 && risk.tp > 0) {
          slUsd = risk.sl;
          tpUsd = risk.tp;
        } else {
          slUsd = fallbackSl;
          tpUsd = fallbackTp;
        }
        const slDist = (slUsd * entryPrice) / (stake * multiplier);
        const tpDist = (tpUsd * entryPrice) / (stake * multiplier);
        openTrade = {
          direction: sig.direction,
          entryIndex: i,
          entryPrice,
          slPrice: sig.direction === 'BUY' ? entryPrice - slDist : entryPrice + slDist,
          tpPrice: sig.direction === 'BUY' ? entryPrice + tpDist : entryPrice - tpDist,
        };
      }
    }
  }

  // Trade ambayo bado ni "wazi" mwishoni mwa data — HAIHESABIWI kwenye
  // win-rate (haijulikani mwisho wake), lakini tunaitaja kwenye ripoti.
  const stillOpenAtEnd = !!openTrade;

  // ── Takwimu ──────────────────────────────────────────────────────────
  const wins = trades.filter((t) => t.outcome === 'WIN');
  const losses = trades.filter((t) => t.outcome === 'LOSS');
  const totalPnl = trades.reduce((sum, t) => sum + t.pnlUsd, 0);
  const grossWin = wins.reduce((sum, t) => sum + t.pnlUsd, 0);
  const grossLoss = Math.abs(losses.reduce((sum, t) => sum + t.pnlUsd, 0));
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : wins.length > 0 ? Infinity : 0;

  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  let consecutiveLosses = 0;
  let maxConsecutiveLosses = 0;
  for (const t of trades) {
    equity += t.pnlUsd;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
    if (t.outcome === 'LOSS') {
      consecutiveLosses += 1;
      maxConsecutiveLosses = Math.max(maxConsecutiveLosses, consecutiveLosses);
    } else {
      consecutiveLosses = 0;
    }
  }

  return {
    code,
    symbol,
    bars: candles1h.length,
    from: candles1h[warmup]?.datetime,
    to: candles1h[candles1h.length - 1]?.datetime,
    stake,
    multiplier,
    strengthThreshold,
    totalTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length ? Number(((wins.length / trades.length) * 100).toFixed(1)) : 0,
    totalPnl: Number(totalPnl.toFixed(2)),
    profitFactor: Number.isFinite(profitFactor) ? Number(profitFactor.toFixed(2)) : null,
    maxDrawdown: Number(maxDrawdown.toFixed(2)),
    maxConsecutiveLosses,
    stillOpenAtEnd,
    trades, // orodha kamili — command inaweza kuonyesha za mwisho tu
  };
}

module.exports = { runBacktest };
