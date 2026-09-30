/**
 * Pocket Option — Balance Command.
 */

const { getBalance, isBridgeUp } = require('../../utils/pocketOptionTrader');

module.exports = {
  name: 'pobalance',
  aliases: ['pobal'],
  category: 'utility',
  description: 'Angalia balance ya Pocket Option',
  usage: '.pobalance',

  async execute(sock, msg) {
    const jid = msg.key.remoteJid;

    const up = await isBridgeUp();
    if (!up) {
      return sock.sendMessage(
        jid,
        { text: `❌ Pocket Option bridge haijaunganishwa kwa sasa. Angalia logs za bot / POCKET_OPTION_ENABLED.` },
        { quoted: msg }
      );
    }

    try {
      const bal = await getBalance();
      return sock.sendMessage(
        jid,
        { text: `💰 *Pocket Option Balance*\n\n$${bal.balance} ${bal.currency || ''}` },
        { quoted: msg }
      );
    } catch (err) {
      await sock.sendMessage(jid, { text: `❌ Imeshindwa kupata balance: ${err.message}` }, { quoted: msg });
    }
  },
};
