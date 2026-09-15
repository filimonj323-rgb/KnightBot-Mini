/**
 * Anti-Delete Command
 *
 * Hurejesha na kukutumia ujumbe uliofutwa ("delete for everyone") pamoja na
 * ujumbe ulioufuta nani na wapi. Inatumia database.getBotSettings()/
 * updateBotSettings() (owner-scoped) badala ya kubadilisha config.js moja
 * kwa moja, kwa sababu config.js ni module MOJA inayoshirikiwa na kila
 * instance (bot kuu + kila mteja wa pairing dashboard) kwenye process hii —
 * ingebadilishwa moja kwa moja, kuwasha/kuzima antidelete kwa mteja mmoja
 * kungeathiri kila mtu mwingine. getBotSettings/updateBotSettings tayari
 * huweka usanifu huu kwa AsyncLocalStorage (database.js), kwa hiyo kila
 * bot (kuu au ya pairing) ina hali yake YENYEWE.
 *
 * Utambuzi halisi wa ujumbe uliofutwa (cache + kuugundua "revoke") upo
 * ndani ya handler.js -> handleAntideleteImpl(), inayoendeshwa kwa kila
 * ujumbe unaoingia kwenye BOT ZOTE (index.js na pairing/instanceManager.js)
 * bila kuhitaji mabadiliko yoyote kwenye faili hizo.
 */
const database = require('../../database');

module.exports = {
  name: 'antidelete',
  aliases: ['antidel'],
  category: 'general',
  description: 'Rejesha na tuma ujumbe uliofutwa (delete for everyone) kwako',
  usage: '.antidelete <on/off/group/private>',
  ownerOnly: true,

  async execute(sock, msg, args, extra) {
    try {
      const action = (args[0] || '').toLowerCase();
      const settings = database.getBotSettings();

      if (!action) {
        const groupStatus = settings.antideleteGroup ? 'ON ✅' : 'OFF ❌';
        const privateStatus = settings.antideletePrivate ? 'ON ✅' : 'OFF ❌';
        return extra.reply(
          `🛡️ *Anti-Delete Status*\n\n` +
          `📌 Groups: ${groupStatus}\n` +
          `📌 Private: ${privateStatus}\n\n` +
          `*Matumizi:*\n` +
          `• .antidelete on — washa zote mbili\n` +
          `• .antidelete off — zima zote mbili\n` +
          `• .antidelete group on/off\n` +
          `• .antidelete private on/off`
        );
      }

      if (action === 'on') {
        database.updateBotSettings({ antideleteGroup: true, antideletePrivate: true });
        return extra.reply('🛡️ *Anti-Delete: ON* ✅\n\nUjumbe utakaofutwa (group na private) utarejeshwa na kutumwa kwako.');
      }

      if (action === 'off') {
        database.updateBotSettings({ antideleteGroup: false, antideletePrivate: false });
        return extra.reply('🛡️ *Anti-Delete: OFF* ❌');
      }

      if (['group', 'private', 'inbox'].includes(action)) {
        const sub = (args[1] || '').toLowerCase();
        if (!['on', 'off'].includes(sub)) {
          return extra.reply('❌ Tumia: `.antidelete group on/off` au `.antidelete private on/off`');
        }
        const key = action === 'group' ? 'antideleteGroup' : 'antideletePrivate';
        database.updateBotSettings({ [key]: sub === 'on' });
        const label = key === 'antideleteGroup' ? 'Group' : 'Private';
        return extra.reply(`🛡️ *Anti-Delete (${label}): ${sub === 'on' ? 'ON ✅' : 'OFF ❌'}*`);
      }

      return extra.reply('❌ Tumia: `.antidelete on / off / group on|off / private on|off`');
    } catch (err) {
      extra.reply(`❌ Error: ${err.message}`);
    }
  }
};
