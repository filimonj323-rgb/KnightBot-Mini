/**
 * Positions Command — Ona trades zote za Deriv zilizo wazi + balance.
 */

const { getOpenPositions, getBalance } = require('../../utils/derivTrader');

module.exports = {
  name: 'positions',
  aliases: ['portfolio'],
  category: 'utility',
  description: 'Ona trades za Deriv zilizo wazi kwa sasa + balance ya akaunti',
  usage: '.positions',

  async execute(sock, msg) {
    const jid = msg.key.remoteJid;
    try {
      const [positions, balance] = await Promise.all([getOpenPositions(), getBalance()]);

      if (!positions.length) {
        return sock.sendMessage(
          jid,
          { text: `📭 Hakuna trade iliyo wazi kwa sasa.\n\n💰 Balance: ${balance.currency} ${balance.balance}` },
          { quoted: msg }
        );
      }

      const lines = [`📊 *Trades Wazi (${positions.length})*`, ''];
      positions.forEach((p) => {
        const pl = p.profit != null ? `${p.profit >= 0 ? '+' : ''}${p.profit}` : 'N/A';
        lines.push(
          `🆔 ${p.contract_id} — ${p.shortcode || p.symbol || ''}\n` +
          `   Buy: $${p.buy_price}  •  Sasa: $${p.bid_price ?? 'N/A'}  •  P/L: ${pl}`
        );
      });
      lines.push('');
      lines.push(`💰 Balance: ${balance.currency} ${balance.balance}`);

      return sock.sendMessage(jid, { text: lines.join('\n') }, { quoted: msg });
    } catch (err) {
      console.error('positions error:', err.message);
      await sock.sendMessage(jid, { text: `❌ Imeshindwa kupata positions: ${err.message}` }, { quoted: msg });
    }
  },
};
