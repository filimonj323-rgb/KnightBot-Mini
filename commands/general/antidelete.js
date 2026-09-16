/**
 * Anti-Delete Command
 *
 * Modes:
 *  1) GLOBAL (owner DM) — `.antidelete on/off`, `.antidelete group on/off`,
 *     `.antidelete private on/off`. Ujumbe uliofutwa (group yoyote isiyo na
 *     per-group override, au private) hutumwa kwa OWNER binafsi (DM/self-chat).
 *     Inatunzwa kwenye database.getBotSettings()/updateBotSettings()
 *     (owner-scoped + Turso-backed — tazama database.js) badala ya config.js
 *     moja kwa moja, kwa sababu config.js ni module MOJA inayoshirikiwa na
 *     kila instance (bot kuu + kila mteja wa pairing dashboard) — ingebadilishwa
 *     moja kwa moja, kuwasha/kuzima kwa mteja mmoja kungeathiri kila mtu mwingine.
 *
 *  2) PER-GROUP (self-recovery) — `.antidelete here on/off` (ukiwa ndani ya
 *     group) au `.antidelete gid <groupId> on/off` (kutoka popote, ukitumia
 *     namba/ID ya group). Ukiwasha hii kwa group fulani, ujumbe utakaofutwa
 *     KATIKA GROUP HILO hutumwa TENA HAPO HAPO kwenye group hilo, si kwa
 *     owner. Inatunzwa kwenye database.getGroupSettings()/updateGroupSettings()
 *     (field `antidelete` — ile ile field iliyokuwepo tayari kwenye
 *     config.js's defaultGroupSettings, sasa inatumika), Turso-backed vile vile.
 *
 * Utambuzi halisi (cache + kuugundua "revoke" + kuamua wapi kutuma) upo
 * ndani ya handler.js -> handleAntideleteImpl(), inayoendeshwa kwa kila
 * ujumbe unaoingia kwenye BOT ZOTE (index.js na pairing/instanceManager.js)
 * bila kuhitaji mabadiliko yoyote kwenye faili hizo.
 */
const database = require('../../database');
// resolveGroupId ni ile ile function inayotumiwa na `.gm` (Remote Group
// Manager) — inakubali namba fupi (1, 2, 3... kama zinavyoonekana kwenye
// `.gm list`/`.antidelete gid list`) na kuzitafsiri kuwa groupId halisi
// kwa kutumia sock.groupFetchAllParticipating(). Kwa kuitumia hapa pia,
// `.antidelete gid` (kutoka inbox) sasa inakubali namba ya group kama
// inavyofanya group manager, badala ya kuhitaji groupId ndefu kila wakati.
const { resolveGroupId } = require('../owner/groupmanager');

const normalizeGroupId = (id) => {
  if (!id) return null;
  id = id.trim().replace(/[^0-9@.\-]/g, '');
  if (!id) return null;
  return id.endsWith('@g.us') ? id : `${id}@g.us`;
};

module.exports = {
  name: 'antidelete',
  aliases: ['antidel'],
  category: 'general',
  description: 'Rejesha na tuma ujumbe uliofutwa (delete for everyone) — kwako au hapo hapo groupni',
  usage: '.antidelete <on/off/group/private/here/gid>',
  ownerOnly: true,

  async execute(sock, msg, args, extra) {
    try {
      const action = (args[0] || '').toLowerCase();
      const settings = database.getBotSettings();

      if (!action) {
        const groupStatus = settings.antideleteGroup ? 'ON ✅' : 'OFF ❌';
        const privateStatus = settings.antideletePrivate ? 'ON ✅' : 'OFF ❌';

        // Hesabu ni group ngapi zenye per-group self-recovery imewashwa
        let perGroupCount = 0;
        try {
          const groups = database.listAllGroupSettings ? database.listAllGroupSettings() : null;
          if (groups) {
            perGroupCount = Object.values(groups).filter(g => g && g.antidelete).length;
          }
        } catch (e) {}

        return extra.reply(
          `🛡️ *Anti-Delete Status*\n\n` +
          `📌 Groups (kwa owner DM): ${groupStatus}\n` +
          `📌 Private (kwa owner DM): ${privateStatus}\n` +
          (perGroupCount ? `📌 Groups zenye self-recovery: ${perGroupCount}\n` : '') +
          `\n*Matumizi:*\n` +
          `• .antidelete on / off — global (owner DM)\n` +
          `• .antidelete group on/off\n` +
          `• .antidelete private on/off\n` +
          `• .antidelete here on/off — group hii hii (rejesha ndani ya group)\n` +
          `• .antidelete gid <namba|groupId> on/off — group nyingine, kwa namba (kama \`.gm list\`) au ID kamili`
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

      // ── PER-GROUP (self-recovery) ─────────────────────────────────────
      if (action === 'here') {
        if (!extra.isGroup) {
          return extra.reply('❌ `.antidelete here` inatumika ndani ya GROUP tu. Kwa group nyingine tumia `.antidelete gid <groupId> on/off`.');
        }
        const sub = (args[1] || '').toLowerCase();
        if (!['on', 'off'].includes(sub)) {
          return extra.reply('❌ Tumia: `.antidelete here on` au `.antidelete here off`');
        }
        database.updateGroupSettings(extra.from, { antidelete: sub === 'on' });
        return extra.reply(
          sub === 'on'
            ? '🛡️ *Anti-Delete (group hii): ON ✅*\n\nUjumbe utakaofutwa hapa utarejeshwa HAPA HAPA kwenye group.'
            : '🛡️ *Anti-Delete (group hii): OFF ❌*'
        );
      }

      if (action === 'gid') {
        const rawArg = args[1];
        const sub = (args[2] || '').toLowerCase();
        if (!rawArg || !['on', 'off'].includes(sub)) {
          return extra.reply(
            '❌ Tumia: `.antidelete gid <namba|groupId> on/off`\n' +
            'Mfano: `.antidelete gid 1 on` (namba kama kwenye `.gm list`)\n' +
            'au: `.antidelete gid 120363042078595907 on` (groupId kamili)\n\n' +
            '💡 Pata namba/ID za groups zote kwa: `.gm list`'
          );
        }

        // Namba fupi (mfano "1", "2") -> groupId halisi, kwa kutumia utaratibu
        // ule ule wa `.gm` (Remote Group Manager). GroupId kamili (ina @g.us)
        // au namba ndefu inapita bila kubadilika.
        let groupId;
        try {
          groupId = await resolveGroupId(sock, rawArg);
        } catch (e) {
          return extra.reply(`❌ ${e.message}`);
        }
        groupId = normalizeGroupId(groupId);
        if (!groupId) {
          return extra.reply('❌ Group namba/ID sio sahihi.');
        }

        database.updateGroupSettings(groupId, { antidelete: sub === 'on' });

        let groupLabel = groupId;
        try {
          const meta = await sock.groupMetadata(groupId);
          if (meta?.subject) groupLabel = `${meta.subject} (\`${groupId}\`)`;
        } catch (e) {
          // Bot huenda haipo kwenye group hiyo — endelea na groupId tu.
        }

        return extra.reply(
          `🛡️ *Anti-Delete kwa group* ${groupLabel}: ${sub === 'on' ? 'ON ✅' : 'OFF ❌'}\n\n` +
          (sub === 'on' ? 'Ujumbe utakaofutwa huko utarejeshwa hapo hapo kwenye group hilo.' : '')
        );
      }

      return extra.reply('❌ Tumia: `.antidelete on / off / group on|off / private on|off / here on|off / gid <id> on|off`');
    } catch (err) {
      extra.reply(`❌ Error: ${err.message}`);
    }
  }
};
