/**
 * autoTrader.js — Auto-trading kiotomatiki kwa jozi tatu maarufu zaidi za
 * forex (EUR/USD, GBP/USD, USD/JPY), kila saa moja, kwa kutumia signal
 * ile ile ya utils/forexSignal.js (EMA9/EMA21, RSI14, MACD).
 *
 * Kanuni: kila saa (AUTO_TRADE_CHECK_INTERVAL_MS), bot inaangalia signal
 * ya kila jozi. Ikiwa signal INA MWELEKEO (BUY/SELL) na nguvu (strength)
 * >= AUTO_TRADE_STRENGTH_THRESHOLD (default 67%, yaani angalau vigezo 2
 * kati ya 3: EMA crossover, RSI, MACD vinakubaliana), bot inafungua trade
 * KIOTOMATIKO (Deriv Multipliers) na kutuma notification WhatsApp kwa DM
 * ya owner. Bot pia inaangalia kila baada ya dakika chache (POLL_MS) kama
 * trade yoyote iliyofunguliwa kiotomatiki imefungwa (SL/TP imegusa) na
 * kutuma notification ya matokeo (faida/hasara).
 *
 * ⚠️⚠️ HII INAFANYA TRADE ZA PESA HALISI KWA KUTUMIA LEVERAGE (Multipliers)
 * BILA UTHIBITISHO WA MTU KWA KILA TRADE — HATARI KUBWA YA KIFEDHA. Hii SI
 * ushauri wa kifedha wala wa uwekezaji. Zima wakati wowote kwa kuweka
 * AUTO_TRADE_ENABLED=false kwenye env (Railway variables) na ku-restart.
 *
 * Env vars (zote hiari isipokuwa AUTO_TRADE_ENABLED):
 *   AUTO_TRADE_ENABLED              — "true" kuwasha (default: "false" = imezimwa)
 *   AUTO_TRADE_CHECK_INTERVAL_MS    — muda kati ya ukaguzi wa signal (default: saa 1)
 *   AUTO_TRADE_POLL_MS              — muda kati ya ukaguzi wa trade zilizofungwa (default: dakika 5)
 *   AUTO_TRADE_STRENGTH_THRESHOLD   — asilimia ya chini ya signal (default: 67)
 *   AUTO_TRADE_STAKE_USD            — stake ya kila auto-trade (default: 5)
 *   AUTO_TRADE_MULTIPLIER           — moja ya 100/200/300/500/800 (default: 100)
 *   AUTO_TRADE_SL_ATR_MULT          — SL = mara ngapi za ATR(14) (default: 1)
 *   AUTO_TRADE_TP_ATR_MULT          — TP = mara ngapi za ATR(14) (default: 2 — risk:reward 1:2)
 *   AUTO_TRADE_SL_USD / AUTO_TRADE_TP_USD — dola fasta, hutumika TU kama
 *     ATR haipatikani kwa jozi husika (fallback)
 *   AUTO_TRADE_PAIR_STAGGER_MS       — muda wa kusubiri kati ya jozi moja
 *     na nyingine ili kuepuka 429 ya Twelve Data (default: sekunde 70)
 */

const { fetchForexSnapshot, computeSignal, DEFAULT_INTERVAL } = require('./forexSignal');
const {
  placeMultiplier,
  getOpenPositions,
  getContractDetails,
  getClosedContractFromHistory,
  ALLOWED_MULTIPLIERS,
} = require('./derivTrader');

const ENABLED = String(process.env.AUTO_TRADE_ENABLED || 'false').toLowerCase() === 'true';
const CHECK_INTERVAL_MS = Number(process.env.AUTO_TRADE_CHECK_INTERVAL_MS || 60 * 60 * 1000); // saa 1
const POLL_CLOSED_MS = Number(process.env.AUTO_TRADE_POLL_MS || 5 * 60 * 1000); // dakika 5
const STRENGTH_THRESHOLD = Number(process.env.AUTO_TRADE_STRENGTH_THRESHOLD || 67);

const STAKE_USD = Number(process.env.AUTO_TRADE_STAKE_USD || 5);
const rawMultiplier = Number(process.env.AUTO_TRADE_MULTIPLIER || 100);
const MULTIPLIER = ALLOWED_MULTIPLIERS.includes(rawMultiplier) ? rawMultiplier : 100;

// Twelve Data (tier bure): 8 credits/dakika. Kila jozi inatumia credits 6
// (price+rsi+macd+ema9+ema21+atr) — kuangalia jozi zote mara moja
// kunavuka kikomo (18 credits > 8/dakika) na kusababisha "429". Kwa hiyo
// tunasubiri kidogo kati ya jozi moja na nyingine (stagger).
const PAIR_STAGGER_MS = Number(process.env.AUTO_TRADE_PAIR_STAGGER_MS || 70 * 1000); // sekunde 70

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// SL/TP kwa kutumia ATR (Average True Range) — hukua/hupungua kulingana na
// volatility halisi ya jozi wakati huo, badala ya dola fasta isiyobadilika.
const SL_ATR_MULT = Number(process.env.AUTO_TRADE_SL_ATR_MULT || 1);
const TP_ATR_MULT = Number(process.env.AUTO_TRADE_TP_ATR_MULT || 2); // risk:reward 1:2

// Dola fasta — hutumika TU kama ATR haipatikani (fallback ya usalama).
const FALLBACK_SL_USD = Number(process.env.AUTO_TRADE_SL_USD || 3);
const FALLBACK_TP_USD = Number(process.env.AUTO_TRADE_TP_USD || 6);

/**
 * Badilisha ATR (katika bei, mfano 0.00120 kwa EURUSD) kuwa SL/TP kwa dola
 * — kulingana na fomula rasmi ya Deriv Multipliers:
 *   Profit/Loss ($) = Stake × Multiplier × (mabadiliko ya bei ÷ bei ya kuingia)
 * Kwa hiyo: SL/TP ($) = Stake × Multiplier × (ATR × mult) ÷ bei ya sasa
 */
function computeAtrBasedRisk({ atr, price, stake, multiplier }) {
  if (!(atr > 0) || !(price > 0)) return null;
  const pctPerAtr = atr / price;
  const sl = stake * multiplier * pctPerAtr * SL_ATR_MULT;
  const tp = stake * multiplier * pctPerAtr * TP_ATR_MULT;
  // SL haiwezi kuzidi stake yenyewe (Deriv Multipliers: hasara ya juu zaidi
  // inayowezekana ni stake yote — no negative balance).
  return {
    sl: Math.min(Number(sl.toFixed(2)), stake),
    tp: Number(tp.toFixed(2)),
  };
}

// Jozi tatu maarufu/maarufu zaidi duniani kwenye forex trading.
const PAIRS = [
  { code: 'EURUSD', symbol: 'EUR/USD' },
  { code: 'GBPUSD', symbol: 'GBP/USD' },
  { code: 'USDJPY', symbol: 'USD/JPY' },
];

let ownerJid = null;
let waSock = null;
let startedAt = null;
let lastCycleAt = null;

// contract_id -> { code, symbol, direction, stake, buyPrice, openedAt }
const openAutoTrades = new Map();
// code -> { direction, strength, price, atr, notes, checkedAt }
const lastSignals = new Map();

function fmt(n, d = 2) {
  return Number(n).toFixed(d);
}

async function notify(text) {
  if (!waSock || !ownerJid) return;
  try {
    await waSock.sendMessage(ownerJid, { text });
  } catch (err) {
    console.error('[autoTrader] Imeshindwa kutuma notification:', err.message);
  }
}

async function checkPairAndTrade(pairInfo) {
  const { code, symbol } = pairInfo;

  // Zuia kufungua trade nyingine kwa jozi ile ile wakati moja tayari iko wazi.
  const alreadyOpen = [...openAutoTrades.values()].some((t) => t.code === code);
  if (alreadyOpen) return;

  let snapshot, sig;
  try {
    snapshot = await fetchForexSnapshot(symbol, DEFAULT_INTERVAL);
    sig = computeSignal(snapshot);
  } catch (err) {
    console.error(`[autoTrader] Imeshindwa kupata signal ya ${code}:`, err.message);
    lastSignals.set(code, { error: err.message, checkedAt: Date.now() });
    return;
  }

  lastSignals.set(code, {
    direction: sig.direction,
    strength: sig.strength,
    price: snapshot.price,
    atr: snapshot.atr,
    notes: sig.notes,
    checkedAt: Date.now(),
  });

  if (sig.direction === 'NEUTRAL' || sig.strength < STRENGTH_THRESHOLD) return;

  // Hesabu SL/TP kulingana na ATR (volatility halisi ya jozi wakati huo).
  const risk = computeAtrBasedRisk({
    atr: snapshot.atr,
    price: snapshot.price,
    stake: STAKE_USD,
    multiplier: MULTIPLIER,
  });

  let slUsd, tpUsd, riskSource;
  if (risk && risk.sl > 0 && risk.tp > 0) {
    slUsd = risk.sl;
    tpUsd = risk.tp;
    riskSource = `ATR(14): ${fmt(snapshot.atr, 5)}`;
  } else {
    // ATR haipatikani kwa jozi hii wakati huu — tumia dola fasta (fallback).
    slUsd = FALLBACK_SL_USD;
    tpUsd = FALLBACK_TP_USD;
    riskSource = 'dola fasta (ATR haikupatikana)';
  }

  try {
    const result = await placeMultiplier({
      pair: code,
      direction: sig.direction,
      stake: STAKE_USD,
      stopLoss: slUsd,
      takeProfit: tpUsd,
      multiplier: MULTIPLIER,
    });

    // result.stop_loss/take_profit ni SL/TP HALISI zilizotumika — derivTrader
    // inaweza kuwa imezirekebisha kiotomatiki juu ya slUsd/tpUsd tulizoomba
    // hapo juu, ikiwa Deriv ilikataa kama ndogo mno kwa jozi hii wakati huo.
    const slFinal = Number.isFinite(result.stop_loss) ? result.stop_loss : slUsd;
    const tpFinal = Number.isFinite(result.take_profit) ? result.take_profit : tpUsd;
    const adjustedNote = (slFinal !== slUsd || tpFinal !== tpUsd)
      ? `\n_(Imerekebishwa kiotomatiki kutoka SL $${fmt(slUsd)}/TP $${fmt(tpUsd)} — Deriv ilihitaji kiwango cha juu zaidi kwa jozi hii wakati huo.)_\n`
      : '';

    openAutoTrades.set(result.contract_id, {
      code,
      symbol,
      direction: sig.direction,
      stake: STAKE_USD,
      buyPrice: result.buy_price,
      openedAt: Date.now(),
    });

    await notify(
      `🤖 *AUTO-TRADE IMEFUNGULIWA*\n\n` +
        `Jozi: *${code}*\n` +
        `Mwelekeo: ${sig.direction === 'BUY' ? '🟢 BUY' : '🔴 SELL'}\n` +
        `Nguvu ya Signal: ${sig.strength}%\n` +
        `Stake: $${fmt(STAKE_USD)}  |  SL: $${fmt(slFinal)}  |  TP: $${fmt(tpFinal)}\n` +
        adjustedNote +
        `Multiplier: x${MULTIPLIER}\n` +
        `Msingi wa SL/TP: ${riskSource}\n` +
        `Bei ya ununuzi: $${fmt(result.buy_price)}\n` +
        `🆔 Contract ID: ${result.contract_id}\n\n` +
        (sig.notes.length ? `🧠 Sababu:\n${sig.notes.map((n) => `   • ${n}`).join('\n')}\n\n` : '') +
        `⚠️ Trade hii ilifunguliwa KIOTOMATIKO kutokana na signal. Hii SI ushauri wa kifedha.`
    );
  } catch (err) {
    console.error(`[autoTrader] Imeshindwa kufungua trade ${code}:`, err.message);
    await notify(`❌ Bot imeshindwa kufungua auto-trade ya ${code}: ${err.message}`);
  }
}

async function runCycle() {
  for (let i = 0; i < PAIRS.length; i++) {
    if (i > 0) await sleep(PAIR_STAGGER_MS); // epuka 429 (kikomo cha Twelve Data)
    await checkPairAndTrade(PAIRS[i]);
  }
  lastCycleAt = Date.now();
}

async function pollClosedTrades() {
  if (openAutoTrades.size === 0) return;

  let openIds;
  try {
    const positions = await getOpenPositions();
    openIds = new Set(positions.map((p) => p.contract_id));
  } catch (err) {
    console.error('[autoTrader] Imeshindwa kuangalia positions:', err.message);
    return;
  }

  for (const [contractId, info] of [...openAutoTrades.entries()]) {
    if (openIds.has(contractId)) continue; // bado wazi

    openAutoTrades.delete(contractId);

    // Hatua 1: proposal_open_contract — kazi vizuri contract ikitoka tu
    // kwenye portfolio, lakini mara nyingi haitoi tena sell_price/profit
    // sahihi contract ikishafungwa kikamilifu.
    let sellPrice, profit;
    try {
      const details = await getContractDetails(contractId);
      sellPrice = Number(details?.sell_price);
      profit = Number(details?.profit);
    } catch (err) {
      console.error(`[autoTrader] proposal_open_contract imeshindwa (${contractId}):`, err.message);
    }

    // Hatua 2: profit_table (historia ya transactions zilizofungwa) — chanzo
    // cha kuaminika zaidi kwa contract iliyoshafungwa kabisa.
    if (!Number.isFinite(profit) || !Number.isFinite(sellPrice)) {
      try {
        const closed = await getClosedContractFromHistory(contractId);
        if (closed) {
          sellPrice = Number.isFinite(sellPrice) ? sellPrice : Number(closed.sell_price);
          profit = Number.isFinite(Number(closed.profit))
            ? Number(closed.profit)
            : sellPrice - Number(closed.buy_price);
        }
      } catch (err) {
        console.error(`[autoTrader] profit_table imeshindwa (${contractId}):`, err.message);
      }
    }

    // Hatua 3: fallback ya mwisho — kama tuna bei ya kufunga (sellPrice) tu,
    // hesabu faida/hasara halisi wenyewe kutoka bei ya ununuzi tuliyohifadhi
    // wakati trade ilipofunguliwa (info.buyPrice). Kwa Multipliers, profit
    // halisi = sellPrice - buyPrice (thamani tayari ina multiplier ndani).
    if (!Number.isFinite(profit) && Number.isFinite(sellPrice) && Number.isFinite(info.buyPrice)) {
      profit = sellPrice - info.buyPrice;
    }

    if (Number.isFinite(profit)) {
      const won = profit >= 0;
      await notify(
        `${won ? '✅' : '🔴'} *AUTO-TRADE IMEFUNGWA — ${info.code}*\n\n` +
          `Mwelekeo: ${info.direction}\n` +
          `Matokeo: ${won ? 'FAIDA 📈' : 'HASARA 📉'}  $${fmt(Math.abs(profit))}\n` +
          `Bei ya ununuzi: $${fmt(info.buyPrice)}\n` +
          `Bei ya kufunga: $${Number.isFinite(sellPrice) ? fmt(sellPrice) : 'N/A'}\n` +
          `🆔 Contract ID: ${contractId}`
      );
    } else {
      await notify(
        `ℹ️ *AUTO-TRADE IMEFUNGWA — ${info.code}*\n(Imeshindwa kupata faida/hasara halisi hata baada ya kuangalia historia ya transactions — angalia .positions au Deriv moja kwa moja.)\n🆔 Contract ID: ${contractId}`
      );
    }
  }
}

let cycleInterval = null;
let pollInterval = null;

/**
 * Anzisha auto-trading. Itwe MARA MOJA tu, connection ya WhatsApp ikiwa
 * tayari "open" (mfano index.js, ndani ya connection.update === 'open').
 */
function start({ sock, notifyJid }) {
  if (!ENABLED) {
    console.log('[autoTrader] AUTO_TRADE_ENABLED si "true" — auto-trading imezimwa.');
    return;
  }
  if (cycleInterval) return; // tayari imeanzishwa (mfano baada ya reconnect)

  waSock = sock;
  ownerJid = notifyJid;
  startedAt = Date.now();

  console.log(
    `[autoTrader] ✅ Auto-trading IMEWASHWA — jozi: ${PAIRS.map((p) => p.code).join(', ')}, ` +
      `kila dakika ${Math.round(CHECK_INTERVAL_MS / 60000)}, threshold: ${STRENGTH_THRESHOLD}%, ` +
      `stake: $${STAKE_USD}, multiplier: x${MULTIPLIER}, SL/TP: ATR×${SL_ATR_MULT}/ATR×${TP_ATR_MULT} ` +
      `(fallback ya dola fasta: $${FALLBACK_SL_USD}/$${FALLBACK_TP_USD}).`
  );

  runCycle().catch((err) => console.error('[autoTrader] runCycle error:', err.message));
  cycleInterval = setInterval(() => {
    runCycle().catch((err) => console.error('[autoTrader] runCycle error:', err.message));
  }, CHECK_INTERVAL_MS);

  pollInterval = setInterval(() => {
    pollClosedTrades().catch((err) => console.error('[autoTrader] pollClosedTrades error:', err.message));
  }, POLL_CLOSED_MS);
}

function stop() {
  if (cycleInterval) clearInterval(cycleInterval);
  if (pollInterval) clearInterval(pollInterval);
  cycleInterval = null;
  pollInterval = null;
}

/**
 * Muhtasari kamili wa hali ya sasa ya auto-trading — inatumika na
 * commands/utility/fxautostatus.js kuonyesha kama iko ON/OFF, jozi
 * zinazofuatiliwa, signal ya mwisho ya kila jozi, na trades wazi.
 */
function getStatus() {
  return {
    enabled: ENABLED,
    running: cycleInterval !== null,
    startedAt,
    lastCycleAt,
    checkIntervalMs: CHECK_INTERVAL_MS,
    pollMs: POLL_CLOSED_MS,
    strengthThreshold: STRENGTH_THRESHOLD,
    stake: STAKE_USD,
    multiplier: MULTIPLIER,
    slAtrMult: SL_ATR_MULT,
    tpAtrMult: TP_ATR_MULT,
    fallbackSl: FALLBACK_SL_USD,
    fallbackTp: FALLBACK_TP_USD,
    pairs: PAIRS.map((p) => p.code),
    signals: PAIRS.map((p) => ({ code: p.code, ...(lastSignals.get(p.code) || {}) })),
    openTrades: [...openAutoTrades.entries()].map(([contractId, info]) => ({ contractId, ...info })),
  };
}

module.exports = { start, stop, getStatus, PAIRS, STRENGTH_THRESHOLD, openAutoTrades };
