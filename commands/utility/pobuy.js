/**
 * Pocket Option — Buy Command (UP / CALL). Binary/Turbo Option, siyo
 * Multipliers — hakuna SL/TP, badala yake una EXPIRY (muda wa kuisha).
 */

const { placeOrder, isBridgeUp } = require('../../utils/pocketOptionTrader');

module.exports = {
  name: 'pobuy',
  aliases: ['pocall'],
  category: 'utility',
  description: 'Fungua Binary/Turbo Option UP (Pocket Option)',
  usage:
    '.pobuy <JOZI> <STAKE_USD> <EXPIRY_SEKUNDE>\n' +
    'Mfano: .pobuy EURUSD_otc 5 60',

  async execute(sock, msg, args) {
    const jid = msg.key.remoteJid;
    const [pairRaw, stakeRaw, expiryRaw] = args;

    if (!pairRaw || !stakeRaw || !expiryRaw) {
      return sock.sendMessage(
        jid,
        {
          text:
            `❓ Tumia: .pobuy <JOZI> <STAKE_USD> <EXPIRY_SEKUNDE>\n` +
            `Mfano: .pobuy EURUSD_otc 5 60\n\n` +
            `_Ongeza "_otc" mwishoni kwa jozi za OTC (zinazofanya kazi wikendi)._`,
        },
        { quoted: msg }
      );
    }

    const pair = pairRaw.trim();

    const up = await isBridgeUp();
    if (!up) {
      return sock.sendMessage(
        jid,
        { text: `❌ Pocket Option bridge haijaunganishwa kwa sasa. Angalia logs za bot / POCKET_OPTION_ENABLED.` },
        { quoted: msg }
      );
    }

    try {
      const result = await placeOrder({
        pair,
        direction: 'BUY',
        amount: parseFloat(stakeRaw),
        expirySeconds: parseInt(expiryRaw, 10),
      });

      return sock.sendMessage(
        jid,
        {
          text:
            `✅ *UP (BUY) imefunguliwa — ${pair}*\n\n` +
            `🆔 Order ID: ${result.orderId}\n` +
            `💵 Stake: $${stakeRaw}\n` +
            `⏱️ Expiry: sekunde ${expiryRaw}\n\n` +
            `_Tumia .poresult ${result.orderId} baada ya expiry kuona matokeo._`,
        },
        { quoted: msg }
      );
    } catch (err) {
      console.error('pobuy error:', pair, err.message);
      await sock.sendMessage(
        jid,
        { text: `❌ Imeshindwa kufungua UP ya ${pair}: ${err.message}` },
        { quoted: msg }
      );
    }
  },
};
