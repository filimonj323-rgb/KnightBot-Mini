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
 *   AUTO_TRADE_SL_USD               — Stop Loss ya kila auto-trade (default: 3)
 *   AUTO_TRADE_TP_USD               — Take Profit ya kila auto-trade (default: 6)
 *   AUTO_TRADE_MULTIPLIER           — moja ya 100/200/300/500/800 (default: 100)
 */

const { fetchForexSnapshot, computeSignal, DEFAULT_INTERVAL } = require('./forexSignal');
const {
  placeMultiplier,
  getOpenPositions,
  getContractDetails,
  ALLOWED_MULTIPLIERS,
} = require('./derivTrader');

const ENABLED = String(process.env.AUTO_TRADE_ENABLED || 'false').toLowerCase() === 'true';
const CHECK_INTERVAL_MS = Number(process.env.AUTO_TRADE_CHECK_INTERVAL_MS || 60 * 60 * 1000); // saa 1
const POLL_CLOSED_MS = Number(process.env.AUTO_TRADE_POLL_MS || 5 * 60 * 1000); // dakika 5
const STRENGTH_THRESHOLD = Number(process.env.AUTO_TRADE_STRENGTH_THRESHOLD || 67);

const STAKE_USD = Number(process.env.AUTO_TRADE_STAKE_USD || 5);
const SL_USD = Number(process.env.AUTO_TRADE_SL_USD || 3);
const TP_USD = Number(process.env.AUTO_TRADE_TP_USD || 6);
const rawMultiplier = Number(process.env.AUTO_TRADE_MULTIPLIER || 100);
const MULTIPLIER = ALLOWED_MULTIPLIERS.includes(rawMultiplier) ? rawMultiplier : 100;

// Jozi tatu maarufu/maarufu zaidi duniani kwenye forex trading.
const PAIRS = [
  { code: 'EURUSD', symbol: 'EUR/USD' },
  { code: 'GBPUSD', symbol: 'GBP/USD' },
  { code: 'USDJPY', symbol: 'USD/JPY' },
];

let ownerJid = null;
let waSock = null;

// contract_id -> { code, symbol, direction, stake, buyPrice, openedAt }
const openAutoTrades = new Map();

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
    return;
  }

  if (sig.direction === 'NEUTRAL' || sig.strength < STRENGTH_THRESHOLD) return;

  try {
    const result = await placeMultiplier({
      pair: code,
      direction: sig.direction,
      stake: STAKE_USD,
      stopLoss: SL_USD,
      takeProfit: TP_USD,
      multiplier: MULTIPLIER,
    });

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
        `Stake: $${fmt(STAKE_USD)}  |  SL: $${fmt(SL_USD)}  |  TP: $${fmt(TP_USD)}\n` +
        `Multiplier: x${MULTIPLIER}\n` +
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
  for (const pairInfo of PAIRS) {
    await checkPairAndTrade(pairInfo);
  }
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
    try {
      const details = await getContractDetails(contractId);
      const profit = Number(details?.profit ?? 0);
      const won = profit >= 0;
      await notify(
        `${won ? '✅' : '🔴'} *AUTO-TRADE IMEFUNGWA — ${info.code}*\n\n` +
          `Mwelekeo: ${info.direction}\n` +
          `Matokeo: ${won ? 'FAIDA 📈' : 'HASARA 📉'}  $${fmt(Math.abs(profit))}\n` +
          `Bei ya kufunga: $${fmt(details?.sell_price ?? 0)}\n` +
          `🆔 Contract ID: ${contractId}`
      );
    } catch (err) {
      console.error(`[autoTrader] Imeshindwa kupata matokeo ya ${contractId}:`, err.message);
      await notify(
        `ℹ️ *AUTO-TRADE IMEFUNGWA — ${info.code}*\n(Imeshindwa kupata faida/hasara halisi — angalia .positions au Deriv moja kwa moja.)`
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

  console.log(
    `[autoTrader] ✅ Auto-trading IMEWASHWA — jozi: ${PAIRS.map((p) => p.code).join(', ')}, ` +
      `kila dakika ${Math.round(CHECK_INTERVAL_MS / 60000)}, threshold: ${STRENGTH_THRESHOLD}%, ` +
      `stake: $${STAKE_USD}, SL: $${SL_USD}, TP: $${TP_USD}, multiplier: x${MULTIPLIER}.`
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

module.exports = { start, stop, PAIRS, STRENGTH_THRESHOLD, openAutoTrades };
