/**
 * Sell Command — Fungua trade ya SELL (Deriv Multipliers).
 * Stop Loss na Take Profit ni LAZIMA — haziwezi kuachwa.
 */

const { placeManualTrade } = require('../../utils/autoTrader');
const { placeMultiplier, MAX_STAKE_USD, MAX_MULTIPLIER, MIN_STAKE_USD, ALLOWED_MULTIPLIERS } = require('../../utils/derivTrader');

// SL/TP: namba ya kawaida = dola ($); ukiongeza "p" (mfano 10p) = pips.
const parseLimit = (raw) => {
  const t = String(raw).trim().toLowerCase();
  const isPips = /p(ips?)?$/.test(t);
  return { value: parseFloat(t.replace(/p(ips?)?$/, '')), isPips };
};

module.exports = {
  name: 'fxsell',
  aliases: ['sellfx'],
  category: 'utility',
  description: 'Fungua trade ya SELL (Deriv Multipliers) — SL/TP ni LAZIMA',
  usage:
    '.fxsell <JOZI> <STAKE_USD> <SL> <TP> [MULTIPLIER]\n' +
    'SL/TP kwa dola: .fxsell EURUSD 10 5 10 50\n' +
    'SL/TP kwa pips (ongeza p): .fxsell EURUSD 10 10p 20p 100',

  async execute(sock, msg, args) {
    if (sock.pairingOwnerId) return require('../../utils/derivCustomerCommands').sell(sock, msg, args);
    const jid = msg.key.remoteJid;
    const [pairRaw, stakeRaw, slRaw, tpRaw, multRaw] = args;

    if (!pairRaw || !stakeRaw || !slRaw || !tpRaw) {
      return sock.sendMessage(
        jid,
        {
          text:
            `❓ Tumia: .fxsell <JOZI> <STAKE_USD> <SL> <TP> [MULTIPLIER]\n` +
            `Dola: .fxsell EURUSD 10 5 10 50\n` +
            `Pips (ongeza p): .fxsell EURUSD 10 10p 20p 100\n\n` +
            `⚠️ Stop Loss na Take Profit ni LAZIMA — haziwezi kuachwa.\n` +
            `Kikomo: stake $${MIN_STAKE_USD}–$${MAX_STAKE_USD}.\n` +
            `Multiplier zinazokubalika: ${ALLOWED_MULTIPLIERS.join(', ')} (kikomo ${MAX_MULTIPLIER}).`,
        },
        { quoted: msg }
      );
    }

    const pair = pairRaw.toUpperCase().replace(/[^A-Z]/g, '');

    try {
      const sl = parseLimit(slRaw); const tp = parseLimit(tpRaw);
      const result = await placeManualTrade({
        pair,
        direction: 'SELL',
        stake: parseFloat(stakeRaw),
        stopLoss: sl.isPips ? 0 : sl.value,
        takeProfit: tp.isPips ? 0 : tp.value,
        slPips: sl.isPips ? sl.value : undefined,
        tpPips: tp.isPips ? tp.value : undefined,
        multiplier: multRaw ? parseFloat(multRaw) : undefined,
      });

      return sock.sendMessage(
        jid,
        {
          text:
            `✅ *SELL imefunguliwa — ${pair}*\n\n` +
            `🆔 Contract ID: ${result.contract_id}\n` +
            `💵 Bei ya ununuzi: $${result.buy_price}\n` +
            (result.longcode ? `📄 ${result.longcode}\n` : '') +
            (result.estimateText ? `\n${result.estimateText}\n` : '') +
            `\n_Tumia .positions kuona trades wazi, .panic kufunga zote dharura._`,
        },
        { quoted: msg }
      );
    } catch (err) {
      console.error('sell error:', pair, err.message);
      await sock.sendMessage(
        jid,
        { text: `❌ Imeshindwa kufungua SELL ya ${pair}: ${err.message}` },
        { quoted: msg }
      );
    }
  },
};
