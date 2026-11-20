/**
 * FX News Alert Command — arifa za habari kubwa (High impact): KABLA ya habari + ACTUAL ikitoka (mwelekeo, pairs, ipi ya kutrade).
 * Arifa zinatumwa kiotomatiki kwa DM ya owner (angalia utils/newsAlerts.js), bila kujali News Trading imewashwa au la.
 *
 * Matumizi:
 *   .fxnewsalert                 -> hali + habari kubwa zijazo (masaa 24)
 *   .fxnewsalert on|off          -> washa/zima
 *   .fxnewsalert lead 30,5       -> dakika kabla ya habari za kutuma arifa (1–240, hadi 4)
 *   .fxnewsalert medium on|off   -> jumuisha Medium impact
 *   .fxnewsalert group on|off    -> tuma pia kwenye group la Deriv
 *   .fxnewsalert test            -> mfano wa arifa ya kabla na ya actual
 */

const na = require('../../utils/newsAlerts');

const onOff = (v) => (v === 'on' ? true : v === 'off' ? false : null);

module.exports = {
  name: 'fxnewsalert',
  aliases: ['newsalert', 'fxnewsalerts'],
  category: 'owner',
  description: 'Arifa za habari kubwa: kabla ya habari na actual ikitoka (mwelekeo, pairs, ipi ya kutrade)',
  usage: '.fxnewsalert [on|off|lead 30,5|medium on|off|group on|off|test]',
  ownerOnly: true,

  async execute(sock, msg, args, extra) {
    const a = (args[0] || '').toLowerCase();
    const b = (args[1] || '').toLowerCase();
    try {
      if (a === 'on' || a === 'off') {
        const r = await na.update({ enabled: a === 'on' });
        if (a === 'on' && !r.enabled) return extra.reply('⚠️ Imezimwa kwenye env (NEWS_ALERTS_ENABLED=false) — badilisha env kwanza.');
        return extra.reply(`🔔 Arifa za habari: *${r.enabled ? 'ON' : 'OFF'}*`);
      }
      if (a === 'lead') {
        if (!args[1]) return extra.reply('Tumia: *.fxnewsalert lead 30,5* (dakika kabla ya habari)');
        const r = await na.update({ leads: args.slice(1).join(',') });
        return extra.reply(`⏰ Arifa zitatumwa dk *${r.leads.join(' na ')}* kabla ya habari.`);
      }
      if (a === 'medium' || a === 'group') {
        const v = onOff(b);
        if (v === null) return extra.reply(`Tumia: *.fxnewsalert ${a} on* au *.fxnewsalert ${a} off*`);
        const r = await na.update(a === 'medium' ? { medium: v } : { toGroup: v });
        return extra.reply(a === 'medium' ? `📊 Medium impact: *${r.medium ? 'ON' : 'OFF'}*` : `👥 Kutuma kwenye group la Deriv: *${r.toGroup ? 'ON' : 'OFF'}*`);
      }
      if (a === 'test') {
        const m = await na.sampleMessages();
        await extra.reply(`🧪 *Mfano 1 — kabla ya habari*\n\n${m.pre}`);
        return extra.reply(`🧪 *Mfano 2 — actual imetoka*\n\n${m.actual}`);
      }
      return extra.reply(await na.formatStatus());
    } catch (err) {
      return extra.reply(`❌ ${err.message}`);
    }
  },
};
