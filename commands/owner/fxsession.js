/**
 * FX Session Command — arifa za sessions za soko (Sydney/Tokyo/London/New York) na soko kufungwa/kufunguliwa (weekend).
 * Arifa zinatumwa kiotomatiki kwa DM ya owner (angalia utils/marketSessions.js).
 *
 * Matumizi:
 *   .fxsession            -> hali ya sasa: soko, sessions, pairs zinazopendekezwa
 *   .fxsession on|off     -> washa/zima arifa za kiotomatiki
 *   .fxsession group on|off -> tuma pia kwenye group la Deriv (lile la signals kwenye dashboard)
 *   .fxsession test       -> tuma mfano wa arifa ya session iliyo wazi sasa
 */

const ms = require('../../utils/marketSessions');

module.exports = {
  name: 'fxsession',
  aliases: ['session', 'sessions', 'fxsessions'],
  category: 'owner',
  description: 'Sessions za soko (Tokyo/London/New York), pairs za kutrade, na arifa za soko kufungwa/kufunguliwa',
  usage: '.fxsession [on|off|group on|group off|test]',
  ownerOnly: true,

  async execute(sock, msg, args, extra) {
    const a = (args[0] || '').toLowerCase();
    const b = (args[1] || '').toLowerCase();

    if (a === 'on' || a === 'off') {
      const r = await ms.setEnabled(a === 'on');
      if (a === 'on' && !r.enabled) return extra.reply('⚠️ Imezimwa kwenye env (SESSION_ALERTS_ENABLED=false) — badilisha env kwanza.');
      return extra.reply(`🔔 Arifa za sessions: *${r.enabled ? 'ON' : 'OFF'}*`);
    }
    if (a === 'group') {
      if (b !== 'on' && b !== 'off') return extra.reply('Tumia: *.fxsession group on* au *.fxsession group off*');
      const r = await ms.setToGroup(b === 'on');
      return extra.reply(
        `👥 Kutuma kwenye group la Deriv: *${r.toGroup ? 'ON' : 'OFF'}*` +
          (r.toGroup ? '\n_Group linachaguliwa kwenye dashboard (Deriv → signals/results)._' : '')
      );
    }
    if (a === 'test') {
      const now = Date.now();
      const active = ms.activeSessions(now);
      const text = active.length
        ? ms.msgSessionOpen(active[active.length - 1], active, now)
        : ms.isMarketOpen(now) ? ms.msgSessionClose('TOKYO', active, now) : ms.msgMarketClosed(now);
      return extra.reply(`🧪 *Mfano wa arifa*\n\n${text}`);
    }
    return extra.reply(ms.formatStatus());
  },
};
