/**
 * Buy Command — Fungua trade ya BUY (Deriv Multipliers).
 * Stop Loss na Take Profit ni LAZIMA — haziwezi kuachwa.
 */

const { placeMultiplier, MAX_STAKE_USD, MAX_MULTIPLIER } = require('../../utils/derivTrader');

module.exports = {
  name: 'buy',
  aliases: [],
  category: 'utility',
  description: 'Fungua trade ya BUY (Deriv Multipliers) — SL/TP ni LAZIMA',
  usage:
    '.buy <JOZI> <STAKE_USD> <SL_USD> <TP_USD> [MULTIPLIER]\n' +
    'Mfano: .buy EURUSD 10 5 10 50',

  async execute(sock, msg, args) {
    const jid = msg.key.remoteJid;
    const [pairRaw, stakeRaw, slRaw, tpRaw, multRaw] = args;

    if (!pairRaw || !stakeRaw || !slRaw || !tpRaw) {
      return sock.sendMessage(
        jid,
        {
          text:
            `❓ Tumia: .buy <JOZI> <STAKE_USD> <SL_USD> <TP_USD> [MULTIPLIER]\n` +
            `Mfano: .buy EURUSD 10 5 10 50\n\n` +
            `⚠️ Stop Loss na Take Profit ni LAZIMA — haziwezi kuachwa.\n` +
            `Kikomo: stake ≤ $${MAX_STAKE_USD}, multiplier ≤ ${MAX_MULTIPLIER}.`,
        },
        { quoted: msg }
      );
    }

    const pair = pairRaw.toUpperCase().replace(/[^A-Z]/g, '');

    try {
      const result = await placeMultiplier({
        pair,
        direction: 'BUY',
        stake: parseFloat(stakeRaw),
        stopLoss: parseFloat(slRaw),
        takeProfit: parseFloat(tpRaw),
        multiplier: multRaw ? parseFloat(multRaw) : undefined,
      });

      return sock.sendMessage(
        jid,
        {
          text:
            `✅ *BUY imefunguliwa — ${pair}*\n\n` +
            `🆔 Contract ID: ${result.contract_id}\n` +
            `💵 Bei ya ununuzi: $${result.buy_price}\n` +
            (result.longcode ? `📄 ${result.longcode}\n` : '') +
            `\n_Tumia .positions kuona trades wazi, .panic kufunga zote dharura._`,
        },
        { quoted: msg }
      );
    } catch (err) {
      console.error('buy error:', pair, err.message);
      await sock.sendMessage(
        jid,
        { text: `❌ Imeshindwa kufungua BUY ya ${pair}: ${err.message}` },
        { quoted: msg }
      );
    }
  },
};
