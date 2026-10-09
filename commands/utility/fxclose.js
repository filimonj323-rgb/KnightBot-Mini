/**
 * FxClose Command — Funga trade MOJA ya Deriv kwa contract id.
 * Pairing bot (mteja): akaunti ya mteja mwenyewe. Bot kuu: akaunti ya owner (kama .panic, lakini trade moja).
 */

const { closeContractWithPnL } = require('../../utils/derivTrader');

module.exports = {
  name: 'fxclose',
  aliases: ['closefx'],
  category: 'utility',
  description: 'Funga trade moja ya Deriv kwa contract id (pata id kwa .positions)',
  usage: '.fxclose <contract_id>',

  async execute(sock, msg, args) {
    if (sock.pairingOwnerId) return require('../../utils/derivCustomerCommands').close(sock, msg, args);
    // Bot kuu: ownerOnly kwa makusudi (hii ni command MPYA — haibadilishi tabia ya zilizopo).
    const jid = msg.key.remoteJid;
    const id = String(args[0] || '').replace(/\D/g, '');
    if (!id) return sock.sendMessage(jid, { text: '❓ Tumia: .fxclose <contract_id>' }, { quoted: msg });
    try {
      const r = await closeContractWithPnL(id);
      return sock.sendMessage(jid, { text: `✅ Trade ${id} imefungwa. P/L: ${r.profit != null && Number.isFinite(r.profit) ? r.profit.toFixed(2) : 'N/A'}` }, { quoted: msg });
    } catch (err) {
      return sock.sendMessage(jid, { text: `❌ Imeshindwa: ${err.message}` }, { quoted: msg });
    }
  },
  ownerOnly: true,
};
