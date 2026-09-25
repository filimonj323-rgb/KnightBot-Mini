/**
 * FX Auto-Trade Status Command — Ona kama auto-trading (jozi za forex,
 * Deriv Multipliers) iko ON/OFF, signal ya mwisho ya kila jozi, na trades
 * za auto zilizo wazi kwa sasa.
 */

const { getStatus } = require('../../utils/autoTrader');

function timeAgo(ts) {
  if (!ts) return 'bado hujaanza';
  const secs = Math.floor((Date.now() - ts) / 1000);
  if (secs < 60) return `sekunde ${secs} zilizopita`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `dakika ${mins} zilizopita`;
  const hrs = Math.floor(mins / 60);
  return `saa ${hrs} zilizopita`;
}

function directionEmoji(d) {
  if (d === 'BUY') return '🟢 BUY';
  if (d === 'SELL') return '🔴 SELL';
  if (d === 'NEUTRAL') return '⚪ NEUTRAL';
  return '❓ N/A';
}

module.exports = {
  name: 'fxautostatus',
  aliases: ['autotradestatus', 'fxauto'],
  category: 'utility',
  description: 'Angalia kama auto-trading ya forex iko ON/OFF + signal ya mwisho ya kila jozi',
  usage: '.fxautostatus',

  async execute(sock, msg) {
    const jid = msg.key.remoteJid;
    const s = getStatus();

    const lines = [];
    lines.push(`⎯⎯⎯ 『 *AUTO-TRADE STATUS* 』 ⎯⎯⎯`);
    lines.push('');

    if (!s.enabled) {
      lines.push(`🔴 *IMEZIMWA* (AUTO_TRADE_ENABLED si "true" kwenye env)`);
      lines.push('');
      lines.push(`_Weka AUTO_TRADE_ENABLED=true kwenye Railway variables kuiwasha._`);
      return sock.sendMessage(jid, { text: lines.join('\n') }, { quoted: msg });
    }

    lines.push(`🟢 *ON* — imeanza: ${timeAgo(s.startedAt)}`);
    lines.push(`🔁 Ukaguzi wa mwisho: ${timeAgo(s.lastCycleAt)}`);
    lines.push(`⏱️ Interval: kila dakika ${Math.round(s.checkIntervalMs / 60000)}`);
    lines.push(`🎯 Kikomo cha signal: ≥${s.strengthThreshold}%`);
    lines.push(`💵 Stake: $${s.stake}  •  Multiplier: x${s.multiplier}`);
    lines.push(`🛡️ SL/TP: ATR×${s.slAtrMult} / ATR×${s.tpAtrMult} (fallback $${s.fallbackSl}/$${s.fallbackTp})`);
    lines.push('');

    lines.push(`📡 *Signal ya Mwisho kwa Jozi*`);
    s.signals.forEach((sig) => {
      if (sig.error) {
        lines.push(`   • ${sig.code}: ❌ ${sig.error}`);
      } else if (!sig.checkedAt) {
        lines.push(`   • ${sig.code}: bado hujaangaliwa`);
      } else {
        const meetsThreshold = sig.strength >= s.strengthThreshold && sig.direction !== 'NEUTRAL';
        lines.push(
          `   • ${sig.code}: ${directionEmoji(sig.direction)} (${sig.strength}%)` +
            `${meetsThreshold ? ' ✅ ingekubalika' : ''} — ${timeAgo(sig.checkedAt)}`
        );
      }
    });
    lines.push('');

    if (s.openTrades.length) {
      lines.push(`📊 *Auto-Trades Wazi (${s.openTrades.length})*`);
      s.openTrades.forEach((t) => {
        lines.push(
          `   • ${t.code} ${directionEmoji(t.direction)} — stake $${t.stake} — 🆔 ${t.contractId}\n` +
            `     Ilifunguliwa: ${timeAgo(t.openedAt)}`
        );
      });
    } else {
      lines.push(`📭 Hakuna auto-trade iliyo wazi kwa sasa.`);
    }

    return sock.sendMessage(jid, { text: lines.join('\n') }, { quoted: msg });
  },
};
