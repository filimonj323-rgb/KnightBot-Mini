/**
 * Remote Group Manager
 * Manage groups zote kutoka inbox bila kuingia kwenye group
 */

const config = require('../../config');

module.exports = {
  name: 'gm',
  aliases: ['groupmanager', 'remote'],
  category: 'owner',
  description: 'Manage groups kutoka inbox',
  usage: '.gm <command> <groupId> [options]',
  ownerOnly: true,

  async execute(sock, msg, args, extra) {
    try {
      const opt = args[0]?.toLowerCase();
      const chatId = msg.key.remoteJid;

      // ── Help ──
      if (!opt || opt === 'help') {
        return extra.reply(
          `🎮 *REMOTE GROUP MANAGER*\n\n` +
          `Manage groups kutoka inbox!\n\n` +
          `📋 *Commands:*\n\n` +
          `*Info*\n` +
          `• .gm list — Orodha ya groups zote\n` +
          `• .gm info <groupId> — Maelezo ya group\n` +
          `• .gm admins <groupId> — Admins wa group\n` +
          `• .gm members <groupId> — Members wa group\n\n` +
          `*Security*\n` +
          `• .gm antilink <groupId> on/off\n` +
          `• .gm antispam <groupId> on/off\n` +
          `• .gm mute <groupId> on/off\n\n` +
          `*Members*\n` +
          `• .gm kick <groupId> <namba>\n` +
          `• .gm promote <groupId> <namba>\n` +
          `• .gm demote <groupId> <namba>\n\n` +
          `*Group*\n` +
          `• .gm link <groupId> — Pata invite link\n` +
          `• .gm resetlink <groupId> — Reset invite link\n` +
          `• .gm send <groupId> <message> — Tuma message\n` +
          `• .gm autoreact <groupId|all> on/off [bot|all] — Auto react\n` +
          `• .gm restore <groupId|all> [namba] — Rudisha walioondoka\n` +
          `• .gm leave <groupId> — Bot itoke group\n\n` +
          `💡 GroupId mfano: *120363xxxxxxxx@g.us*\n` +
          `Pata IDs zote kwa: *.gm list*`
        );
      }

      // ══════════════════════════════════════
      // LIST - Orodha ya groups zote
      // ══════════════════════════════════════
      if (opt === 'list') {
        await extra.reply('⏳ Inapata orodha ya groups...');
        const chats = await sock.groupFetchAllParticipating();
        const groups = Object.values(chats);

        if (!groups.length) return extra.reply('📭 Bot haipo kwenye group yoyote!');

        let text = `📋 *GROUPS ZOTE (${groups.length})*\n\n`;
        groups.forEach((g, i) => {
          text += `${i + 1}. *${g.subject}*\n`;
          text += `   👥 ${g.participants.length} members\n`;
          text += `   🆔 \`${g.id}\`\n\n`;
        });

        return extra.reply(text);
      }

      // ══════════════════════════════════════
      // INFO - Maelezo ya group
      // ══════════════════════════════════════
      if (opt === 'info') {
        const groupId = args[1];
        if (!groupId) return extra.reply('❌ Taja group ID: .gm info <groupId>');

        const meta = await sock.groupMetadata(groupId);
        const admins = meta.participants.filter(p => p.admin);
        const botId = sock.user?.id?.replace(/:\d+/, '') + '@s.whatsapp.net';
        const botInGroup = meta.participants.find(p => p.id.includes(botId.split('@')[0]));

        return extra.reply(
          `📋 *${meta.subject}*\n\n` +
          `👥 Members: ${meta.participants.length}\n` +
          `👑 Admins: ${admins.length}\n` +
          `🤖 Bot Role: ${botInGroup?.admin || 'member'}\n` +
          `📝 Description: ${meta.desc || 'Hakuna'}\n` +
          `🆔 ID: ${meta.id}\n` +
          `📅 Created: ${new Date(meta.creation * 1000).toLocaleDateString('sw-TZ')}`
        );
      }

      // ══════════════════════════════════════
      // ADMINS - Admins wa group
      // ══════════════════════════════════════
      if (opt === 'admins') {
        const groupId = args[1];
        if (!groupId) return extra.reply('❌ Taja group ID: .gm admins <groupId>');

        const meta = await sock.groupMetadata(groupId);
        const admins = meta.participants.filter(p => p.admin);

        let text = `👑 *Admins wa ${meta.subject} (${admins.length})*\n\n`;
        admins.forEach((a, i) => {
          const role = a.admin === 'superadmin' ? '⭐ SUPER' : '👑 ADMIN';
          text += `${i + 1}. ${role}\n`;
          text += `   📱 ${a.id.split('@')[0]}\n\n`;
        });

        return extra.reply(text);
      }

      // ══════════════════════════════════════
      // MEMBERS - Members wa group
      // ══════════════════════════════════════
      if (opt === 'members') {
        const groupId = args[1];
        if (!groupId) return extra.reply('❌ Taja group ID: .gm members <groupId>');

        const meta = await sock.groupMetadata(groupId);
        let text = `👥 *Members wa ${meta.subject} (${meta.participants.length})*\n\n`;

        meta.participants.forEach((p, i) => {
          const role = p.admin === 'superadmin' ? '⭐' : p.admin ? '👑' : '👤';
          text += `${i + 1}. ${role} ${p.id.split('@')[0]}\n`;
        });

        return extra.reply(text);
      }

      // ══════════════════════════════════════
      // ANTILINK - Washa/Zima antilink
      // ══════════════════════════════════════
      if (opt === 'antilink') {
        const groupId = args[1];
        const val = args[2]?.toLowerCase();
        if (!groupId || !val) {
          return extra.reply('❌ Tumia: .gm antilink <groupId> on/off');
        }

        if (!config.groupSettings) config.groupSettings = {};
        if (!config.groupSettings[groupId]) config.groupSettings[groupId] = {};
        config.groupSettings[groupId].antilink = val === 'on';

        const meta = await sock.groupMetadata(groupId);
        return extra.reply(
          `🔗 *Antilink - ${meta.subject}*\n\n` +
          `Status: *${val === 'on' ? 'ON ✅' : 'OFF ❌'}*`
        );
      }

      // ══════════════════════════════════════
      // MUTE - Funga/Fungua group
      // ══════════════════════════════════════
      if (opt === 'mute') {
        const groupId = args[1];
        const val = args[2]?.toLowerCase();
        if (!groupId || !val) {
          return extra.reply('❌ Tumia: .gm mute <groupId> on/off');
        }

        await sock.groupSettingUpdate(groupId, val === 'on' ? 'announcement' : 'not_announcement');
        const meta = await sock.groupMetadata(groupId);
        return extra.reply(
          `🔇 *${meta.subject}*\n\n` +
          `Mute: *${val === 'on' ? 'ON ✅ (Admins tu waweza kutuma)' : 'OFF ❌ (Wote waweza kutuma)'}*`
        );
      }

      // ══════════════════════════════════════
      // KICK - Toa member
      // ══════════════════════════════════════
      if (opt === 'kick') {
        const groupId = args[1];
        const number = args[2]?.replace(/[^0-9]/g, '');
        if (!groupId || !number) {
          return extra.reply('❌ Tumia: .gm kick <groupId> <namba>');
        }

        const jid = number + '@s.whatsapp.net';
        await sock.groupParticipantsUpdate(groupId, [jid], 'remove');
        const meta = await sock.groupMetadata(groupId);
        return extra.reply(`✅ *${number}* ametolewa kwenye *${meta.subject}*!`);
      }

      // ══════════════════════════════════════
      // PROMOTE - Fanya admin
      // ══════════════════════════════════════
      if (opt === 'promote') {
        const groupId = args[1];
        const number = args[2]?.replace(/[^0-9]/g, '');
        if (!groupId || !number) {
          return extra.reply('❌ Tumia: .gm promote <groupId> <namba>');
        }

        const jid = number + '@s.whatsapp.net';
        await sock.groupParticipantsUpdate(groupId, [jid], 'promote');
        const meta = await sock.groupMetadata(groupId);
        return extra.reply(`✅ *${number}* amefanywa admin wa *${meta.subject}*! 👑`);
      }

      // ══════════════════════════════════════
      // DEMOTE - Ondoa admin
      // ══════════════════════════════════════
      if (opt === 'demote') {
        const groupId = args[1];
        const number = args[2]?.replace(/[^0-9]/g, '');
        if (!groupId || !val) {
          return extra.reply('❌ Tumia: .gm demote <groupId> <namba>');
        }

        const jid = number + '@s.whatsapp.net';
        await sock.groupParticipantsUpdate(groupId, [jid], 'demote');
        const meta = await sock.groupMetadata(groupId);
        return extra.reply(`✅ *${number}* ameondolewa admin wa *${meta.subject}*!`);
      }

      // ══════════════════════════════════════
      // LINK - Pata invite link
      // ══════════════════════════════════════
      if (opt === 'link') {
        const groupId = args[1];
        if (!groupId) return extra.reply('❌ Tumia: .gm link <groupId>');

        const code = await sock.groupInviteCode(groupId);
        const meta = await sock.groupMetadata(groupId);
        return extra.reply(
          `🔗 *Invite Link - ${meta.subject}*\n\n` +
          `https://chat.whatsapp.com/${code}`
        );
      }

      // ══════════════════════════════════════
      // RESETLINK - Reset invite link
      // ══════════════════════════════════════
      if (opt === 'resetlink') {
        const groupId = args[1];
        if (!groupId) return extra.reply('❌ Tumia: .gm resetlink <groupId>');

        await sock.groupRevokeInvite(groupId);
        const newCode = await sock.groupInviteCode(groupId);
        const meta = await sock.groupMetadata(groupId);
        return extra.reply(
          `✅ *Link Imebadilishwa - ${meta.subject}*\n\n` +
          `🔗 Mpya: https://chat.whatsapp.com/${newCode}`
        );
      }

      // ══════════════════════════════════════
      // SEND - Tuma message kwa group
      // ══════════════════════════════════════
      if (opt === 'send') {
        const groupId = args[1];
        const message = args.slice(2).join(' ');
        if (!groupId || !message) {
          return extra.reply('❌ Tumia: .gm send <groupId> <message>');
        }

        await sock.sendMessage(groupId, { text: message });
        const meta = await sock.groupMetadata(groupId);
        return extra.reply(`✅ Message imetumwa kwenye *${meta.subject}*!`);
      }

      // ══════════════════════════════════════
      // AUTOREACT - Washa/Zima autoreact per-group
      // ══════════════════════════════════════
      if (opt === 'autoreact') {
        const groupId = args[1];
        const val = args[2]?.toLowerCase();
        const modeArg = args[3]?.toLowerCase(); // 'bot' au 'all' (hiari)

        if (!groupId || !val) {
          return extra.reply(
            '❌ Tumia:\n' +
            '.gm autoreact <groupId|all> on/off [bot|all]\n\n' +
            '• *bot* — react ⏳ kwa commands tu (default)\n' +
            '• *all* — react emoji random kwa kila ujumbe'
          );
        }

        const database = require('../../database');
        const isOn = val === 'on';
        const mode = ['bot', 'all'].includes(modeArg) ? modeArg : 'bot';

        if (groupId.toLowerCase() === 'all') {
          const allGroups = await sock.groupFetchAllParticipating();
          const groupIds = Object.keys(allGroups);
          for (const gid of groupIds) {
            database.updateGroupSettings(gid, {
              autoreact: isOn,
              autoreactMode: mode
            });
          }
          return extra.reply(
            `⚡ *AutoReact - GROUPS ZOTE*\n\n` +
            `Status: *${isOn ? 'ON ✅' : 'OFF ❌'}*\n` +
            (isOn ? `Mode: *${mode}*\n` : '') +
            `📊 Groups: ${groupIds.length}`
          );
        }

        database.updateGroupSettings(groupId, {
          autoreact: isOn,
          autoreactMode: mode
        });

        const meta = await sock.groupMetadata(groupId);
        return extra.reply(
          `⚡ *AutoReact - ${meta.subject}*\n\n` +
          `Status: *${isOn ? 'ON ✅' : 'OFF ❌'}*\n` +
          (isOn ? `Mode: *${mode}*` : '')
        );
      }

      // ══════════════════════════════════════
      // LEAVE - Bot itoke group
      // ══════════════════════════════════════
      if (opt === 'leave') {
        const groupId = args[1];
        if (!groupId) return extra.reply('❌ Tumia: .gm leave <groupId>');

        const meta = await sock.groupMetadata(groupId);
        await sock.sendMessage(groupId, { text: '👋 Bot inaondoka. Kwa heri!' });
        await sock.groupLeave(groupId);
        return extra.reply(`✅ Bot imetoka kwenye *${meta.subject}*!`);
      }

      extra.reply('❌ Command haijulikani. Tumia: .gm help');

    } catch (err) {
      extra.reply(`❌ Error: ${err.message}\n\nHakikisha:\n• Group ID ni sahihi\n• Bot ni admin wa group hiyo`);
    }
  }
};
