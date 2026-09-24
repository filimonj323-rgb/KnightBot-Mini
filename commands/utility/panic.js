/**
 * Panic Command — DHARURA: funga trades ZOTE za Deriv papo hapo.
 */

const { closeAll } = require('../../utils/derivTrader');

module.exports = {
  name: 'panic',
  aliases: ['closeall'],
  category: 'utility',
  description: 'DHARURA: funga trades ZOTE za Deriv papo hapo (kill switch)',
  usage: '.panic',

  async execute(sock, msg) {
    const jid = msg.key.remoteJid;
    try {
      const results = await closeAll();
      if (!results.length) {
        return sock.sendMessage(jid, { text: `📭 Hakuna trade iliyokuwa wazi.` }, { quoted: msg });
      }
      const lines = [`🛑 *Kufunga Trades Zote*`, ''];
      results.forEach((r) => {
        lines.push(r.ok ? `✅ ${r.contract_id} — imefungwa` : `❌ ${r.contract_id} — imeshindwa (${r.error})`);
      });
      return sock.sendMessage(jid, { text: lines.join('\n') }, { quoted: msg });
    } catch (err) {
      console.error('panic error:', err.message);
      await sock.sendMessage(jid, { text: `❌ Imeshindwa: ${err.message}` }, { quoted: msg });
    }
  },
};
