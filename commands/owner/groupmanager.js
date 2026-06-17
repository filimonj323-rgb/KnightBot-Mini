/**
 * Remote Group Manager
 * Manage groups zote kutoka inbox bila kuingia kwenye group
 */

const config = require('../../config');
const crypto = require('crypto');
const {
  generateWAMessageContent,
  generateWAMessageFromContent,
} = require('@whiskeysockets/baileys');

const PURPLE_COLOR = '#9C27B0';

// Helper: tuma group status (text/image) kwa group fulani - inafuata muundo wa groupstatus.js
async function postGroupStatus(sock, jid, content) {
  const { backgroundColor } = content;
  delete content.backgroundColor;

  const inside = await generateWAMessageContent(content, {
    upload: sock.waUploadToServer,
    backgroundColor: backgroundColor || PURPLE_COLOR,
  });

  const secret = crypto.randomBytes(32);

  const statusMsg = generateWAMessageFromContent(
    jid,
    {
      messageContextInfo: { messageSecret: secret },
      groupStatusMessageV2: {
        message: {
          ...inside,
          messageContextInfo: { messageSecret: secret },
        },
      },
    },
    {}
  );

  await sock.relayMessage(jid, statusMsg.message, { messageId: statusMsg.key.id });
  return statusMsg;
}

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
          `• .gm antilink <groupId|all> on/off\n` +
          `• .gm antipromo <groupId|all> on/off\n` +
          `• .gm antigroupmention <groupId|all> on/off\n` +
          `• .gm antigroupmention <groupId> set delete|kick\n` +
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
          `• .gm broadcast <message> — Tuma kwa GROUPS ZOTE\n` +
          `• .gm groupstatus <groupId|all> <text> — Tuma group status\n` +
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
          return extra.reply('❌ Tumia: .gm antilink <groupId|all> on/off');
        }

        const database = require('../../database');

        if (groupId.toLowerCase() === 'all') {
          const allGroups = await sock.groupFetchAllParticipating();
          const groupIds = Object.keys(allGroups);
          for (const gid of groupIds) {
            database.updateGroupSettings(gid, { antilink: val === 'on' });
          }
          return extra.reply(
            `🔗 *Antilink - GROUPS ZOTE*\n\n` +
            `Status: *${val === 'on' ? 'ON ✅' : 'OFF ❌'}*\n` +
            `📊 Groups zilizobadilishwa: ${groupIds.length}`
          );
        }

        database.updateGroupSettings(groupId, { antilink: val === 'on' });

        const meta = await sock.groupMetadata(groupId);
        return extra.reply(
          `🔗 *Antilink - ${meta.subject}*\n\n` +
          `Status: *${val === 'on' ? 'ON ✅' : 'OFF ❌'}*`
        );
      }

      // ══════════════════════════════════════
      // ANTIPROMO - Washa/Zima antipromo
      // ══════════════════════════════════════
      if (opt === 'antipromo') {
        const groupId = args[1];
        const val = args[2]?.toLowerCase();
        if (!groupId || !val) {
          return extra.reply('❌ Tumia: .gm antipromo <groupId|all> on/off');
        }

        const database = require('../../database');

        if (groupId.toLowerCase() === 'all') {
          const allGroups = await sock.groupFetchAllParticipating();
          const groupIds = Object.keys(allGroups);
          for (const gid of groupIds) {
            database.updateGroupSettings(gid, { antipromo: val === 'on' });
          }
          return extra.reply(
            `📢 *Antipromo - GROUPS ZOTE*\n\n` +
            `Status: *${val === 'on' ? 'ON ✅' : 'OFF ❌'}*\n` +
            `📊 Groups zilizobadilishwa: ${groupIds.length}`
          );
        }

        database.updateGroupSettings(groupId, { antipromo: val === 'on' });

        const meta = await sock.groupMetadata(groupId);
        return extra.reply(
          `📢 *Antipromo - ${meta.subject}*\n\n` +
          `Status: *${val === 'on' ? 'ON ✅ (Picha/video/ujumbe mrefu utafutwa)' : 'OFF ❌'}*`
        );
      }

      // ══════════════════════════════════════
      // ANTIGROUPMENTION - Washa/Zima antigroupmention
      // ══════════════════════════════════════
      if (opt === 'antigroupmention' || opt === 'agm') {
        const groupId = args[1];
        const val = args[2]?.toLowerCase();

        if (!groupId) {
          return extra.reply(
            '❌ Tumia:\n' +
            '.gm antigroupmention <groupId|all> on/off\n' +
            '.gm antigroupmention <groupId> set delete|kick'
          );
        }

        const database = require('../../database');

        // .gm antigroupmention <groupId> set delete|kick
        if (val === 'set') {
          const setAction = args[3]?.toLowerCase();
          if (!['delete', 'kick'].includes(setAction)) {
            return extra.reply('❌ Tumia: .gm antigroupmention <groupId> set delete|kick');
          }
          database.updateGroupSettings(groupId, {
            antigroupmentionAction: setAction,
            antigroupmention: true
          });
          const meta = await sock.groupMetadata(groupId);
          return extra.reply(`✅ *${meta.subject}*\nAntigroupmention action: *${setAction}*`);
        }

        if (val !== 'on' && val !== 'off') {
          return extra.reply('❌ Tumia: .gm antigroupmention <groupId|all> on/off');
        }

        if (groupId.toLowerCase() === 'all') {
          const allGroups = await sock.groupFetchAllParticipating();
          const groupIds = Object.keys(allGroups);
          for (const gid of groupIds) {
            database.updateGroupSettings(gid, { antigroupmention: val === 'on' });
          }
          return extra.reply(
            `📌 *Antigroupmention - GROUPS ZOTE*\n\n` +
            `Status: *${val === 'on' ? 'ON ✅' : 'OFF ❌'}*\n` +
            `📊 Groups zilizobadilishwa: ${groupIds.length}`
          );
        }

        database.updateGroupSettings(groupId, { antigroupmention: val === 'on' });

        const meta = await sock.groupMetadata(groupId);
        const settings = database.getGroupSettings(groupId);
        return extra.reply(
          `📌 *Antigroupmention - ${meta.subject}*\n\n` +
          `Status: *${val === 'on' ? 'ON ✅' : 'OFF ❌'}*\n` +
          `Action: *${settings.antigroupmentionAction || 'delete'}*`
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
        if (!groupId || !number) {
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
      // BROADCAST - Tuma message kwa GROUPS ZOTE
      // ══════════════════════════════════════
      if (opt === 'broadcast' || opt === 'bc') {
        const message = args.slice(1).join(' ');
        if (!message) {
          return extra.reply('❌ Tumia: .gm broadcast <ujumbe>');
        }

        const allGroups = await sock.groupFetchAllParticipating();
        const groupIds = Object.keys(allGroups);

        if (groupIds.length === 0) {
          return extra.reply('❌ Bot haipo kwenye group lolote.');
        }

        await extra.reply(`📤 Inatuma kwa groups *${groupIds.length}*... Subiri.`);

        let success = 0;
        let failed = 0;

        for (const gid of groupIds) {
          try {
            await sock.sendMessage(gid, { text: message });
            success++;
            // Delay ndogo kuepuka rate-limit
            await new Promise(r => setTimeout(r, 1500));
          } catch (e) {
            failed++;
          }
        }

        return extra.reply(
          `✅ *Broadcast Imekamilika!*\n\n` +
          `📨 Imefanikiwa: ${success}\n` +
          `❌ Imeshindwa: ${failed}\n` +
          `📊 Jumla: ${groupIds.length}`
        );
      }

      // ══════════════════════════════════════
      // GROUPSTATUS - Tuma group status (text) kwa group|groups zote
      // (Kwa image/video, tumia .groupstatus ndani ya group kwa "reply")
      // ══════════════════════════════════════
      if (opt === 'groupstatus' || opt === 'gstatus') {
        const groupId = args[1];
        const text = args.slice(2).join(' ');

        if (!groupId || !text) {
          return extra.reply(
            '❌ Tumia: .gm groupstatus <groupId|all> <text>\n\n' +
            '💡 Hii inatuma TEXT status pekee.\n' +
            'Kwa image/video status, tumia *.groupstatus* ukiwa ndani ya group (reply kwa media).'
          );
        }

        if (groupId.toLowerCase() === 'all') {
          const allGroups = await sock.groupFetchAllParticipating();
          const groupIds = Object.keys(allGroups);

          await extra.reply(`📤 Inatuma group status kwa groups *${groupIds.length}*... Subiri.`);

          let success = 0;
          let failed = 0;

          for (const gid of groupIds) {
            try {
              await postGroupStatus(sock, gid, {
                text,
                backgroundColor: PURPLE_COLOR,
              });
              success++;
              await new Promise(r => setTimeout(r, 1500));
            } catch (e) {
              failed++;
            }
          }

          return extra.reply(
            `✅ *Group Status Imekamilika!*\n\n` +
            `📨 Imefanikiwa: ${success}\n` +
            `❌ Imeshindwa: ${failed}\n` +
            `📊 Jumla: ${groupIds.length}`
          );
        }

        try {
          await postGroupStatus(sock, groupId, {
            text,
            backgroundColor: PURPLE_COLOR,
          });
          const meta = await sock.groupMetadata(groupId);
          return extra.reply(`✅ Group status imetumwa kwenye *${meta.subject}*!`);
        } catch (e) {
          return extra.reply(`❌ Imeshindwa kutuma group status: ${e.message}`);
        }
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
