/**
 * Pocket Option — Takwimu za signals (win rate halisi).
 *   .postats        -> siku 7 zilizopita
 *   .postats 30     -> siku 30 zilizopita
 * Data inatoka kwenye utils/signalTracker.js (kila signal inapimwa baada ya expiry).
 */
const { getStats, formatStats } = require('../../utils/signalTracker');

module.exports = {
  name: 'postats',
  aliases: ['posignalstats', 'postat'],
  category: 'owner',
  ownerOnly: true,
  description: 'Win rate halisi ya signals za Pocket Option (kwa timeframe, hali ya soko, nguvu)',
  usage: '.postats [siku]  — mfano: .postats 30',

  async execute(sock, msg, args, extra) {
    const jid = msg.key.remoteJid;
    const reply = extra?.reply || ((text) => sock.sendMessage(jid, { text }, { quoted: msg }));
    const days = Math.max(1, Math.min(parseInt(String(args[0] || '7').replace(/\D/g, ''), 10) || 7, 90));
    try {
      return reply(formatStats(await getStats(days)));
    } catch (err) {
      console.error('postats error:', err.message);
      return reply(`❌ Imeshindwa kupata takwimu: ${err.message}`);
    }
  },
};
