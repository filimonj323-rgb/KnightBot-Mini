/**
 * .fxsralerts [on|off] — washa/zima arifa za S/R (S/R ikizuia/ikiachia, bei ikikaribia zone, zone ikivunjwa)
 * na onyo la trade kukaribia Stop Loss (70% ⚠️ / 90% 🚨 ya SL, pamoja na S/R iliyo karibu).
 */
const { getStatus, setSrAlerts } = require('../../utils/autoTrader');

module.exports = {
  name: 'fxsralerts',
  aliases: ['sralerts', 'slalert'],
  category: 'owner',
  description: 'Washa/zima arifa za S/R na onyo la trade kukaribia SL',
  usage: '.fxsralerts [on|off]',
  ownerOnly: true,

  async execute(sock, msg, args, extra) {
    const s = getStatus();
    if (!args[0]) {
      return extra.reply(
        `🔔 Arifa za S/R & SL: *${s.srAlerts ? 'ON ✅' : 'OFF ⛔'}*\n` +
          `   • Matukio ya S/R (kukaribia zone, kuvunjwa kwa zone): kwa jozi zenye trade WAZI tu\n` +
          `   • Trade ikifika ${s.slWarnPct}% ya SL ⚠️ na ${s.slDangerPct}% 🚨\n\n` +
          `Kubadilisha: *.fxsralerts on* au *.fxsralerts off*`
      );
    }
    const arg = String(args[0]).toLowerCase();
    if (!['on', 'off'].includes(arg)) return extra.reply('❌ Weka *on* au *off* pekee — mfano: *.fxsralerts off*');
    const r = await setSrAlerts(arg === 'on', { source: 'WhatsApp', notifyOwner: false });
    return extra.reply(
      `🔔 *ARIFA ZA S/R & SL ${r.srAlerts ? '🟢 ZIMEWASHWA' : '🔴 ZIMEZIMWA'}*` + (r.changed ? '' : ' (hakukuwa na mabadiliko)') +
        `\n_Imehifadhiwa kwenye database._`
    );
  },
};
