/**
 * Pocket Option — Order Result Command. Inasubiri mpaka expiry ikamilike
 * (check_order_result upande wa bridge) na kutoa matokeo (win/loss + P/L).
 */

const { getOrderResult, isBridgeUp } = require('../../utils/pocketOptionTrader');

module.exports = {
  name: 'poresult',
  aliases: ['pocheck'],
  category: 'utility',
  description: 'Angalia matokeo ya order ya Pocket Option (win/loss)',
  usage: '.poresult <ORDER_ID>',

  async execute(sock, msg, args) {
    const jid = msg.key.remoteJid;
    const [orderId] = args;

    if (!orderId) {
      return sock.sendMessage(jid, { text: `❓ Tumia: .poresult <ORDER_ID>` }, { quoted: msg });
    }

    const up = await isBridgeUp();
    if (!up) {
      return sock.sendMessage(
        jid,
        { text: `❌ Pocket Option bridge haijaunganishwa kwa sasa. Angalia logs za bot / POCKET_OPTION_ENABLED.` },
        { quoted: msg }
      );
    }

    try {
      await sock.sendMessage(jid, { text: `⏳ Inasubiri matokeo ya order ${orderId}...` }, { quoted: msg });
      const result = await getOrderResult(orderId);

      // Muundo halisi wa "result" unategemea toleo la maktaba — tunajaribu
      // kuchukua fields za kawaida (profit/win), na kuonyesha raw JSON pia
      // kama fallback ili usikose taarifa.
      const profit = result?.profit ?? result?.pnl ?? null;
      const win = result?.win ?? (profit != null ? profit >= 0 : null);
      const label = win === true ? '✅ WIN' : win === false ? '🔴 LOSS' : 'ℹ️ Haijulikani bado';

      return sock.sendMessage(
        jid,
        {
          text:
            `📊 *Matokeo — Order ${orderId}*\n\n` +
            `${label}` +
            (profit != null ? `\n💵 P/L: $${profit}` : '') +
            `\n\n\`\`\`${JSON.stringify(result, null, 2)}\`\`\``,
        },
        { quoted: msg }
      );
    } catch (err) {
      await sock.sendMessage(jid, { text: `❌ Imeshindwa kupata matokeo: ${err.message}` }, { quoted: msg });
    }
  },
};
