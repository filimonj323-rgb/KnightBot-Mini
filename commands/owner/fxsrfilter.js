/**
 * .fxsrfilter [on|off] — washa/zima kichujio cha Support/Resistance cha auto-trader "live" (bila restart).
 * ON  → bot haifungui trade ikiwa resistance (BUY) / support (SELL) iko karibu mbele ya entry.
 * Uamuzi unahifadhiwa kwenye database; arifa ya mabadiliko inaonekana kwenye chat hii.
 */
const { getStatus, setSrFilter } = require('../../utils/autoTrader');

module.exports = {
  name: 'fxsrfilter',
  aliases: ['srfilter'],
  category: 'owner',
  description: 'Washa/zima kichujio cha S/R cha auto-trader',
  usage: '.fxsrfilter [on|off]',
  ownerOnly: true,

  async execute(sock, msg, args, extra) {
    const s = getStatus();
    if (!args[0]) {
      return extra.reply(
        `🧱 Kichujio cha S/R: *${s.srFilter ? 'ON ✅' : 'OFF ⛔'}*\n` +
          `   • Inazuia entry S/R ikiwa chini ya ${s.srMinRoomAtr}×ATR mbele\n\n` +
          `Kubadilisha: *.fxsrfilter on* au *.fxsrfilter off*\nOnyesha zones: *.fxsr EURUSD*`
      );
    }
    const arg = String(args[0]).toLowerCase();
    if (!['on', 'off'].includes(arg)) return extra.reply('❌ Weka *on* au *off* pekee — mfano: *.fxsrfilter on*');
    const r = await setSrFilter(arg === 'on', { source: 'WhatsApp', notifyOwner: false });
    return extra.reply(
      `🧱 *KICHUJIO CHA S/R ${r.srFilter ? '🟢 IMEWASHWA' : '🔴 IMEZIMWA'}*` +
        (r.changed ? '' : ' (hakikuwa na mabadiliko)') +
        `\n\n${r.srFilter ? `Bot itaruka entry ikiwa S/R iko chini ya ${s.srMinRoomAtr}×ATR mbele.` : 'Bot haitazuia entry kwa S/R; taarifa za S/R bado zinaonekana.'}\n` +
        `_Imehifadhiwa kwenye database. Trades zilizo wazi hazibadiliki._`
    );
  },
};
