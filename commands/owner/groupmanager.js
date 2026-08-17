/**
 * Remote Group Manager
 * Manage groups zote kutoka inbox bila kuingia kwenye group
 */

const config = require('../../config');
const { downloadContentFromMessage } = global.__baileys;

const PURPLE_COLOR = '#9C27B0';

// Helper: tuma group status (text/image/video) kwa group fulani.
// Uses @itsliaaa/baileys' native groupStatus:true support (same mechanism as
// commands/admin/groupstatus.js) instead of hand-built groupStatusMessageV2 —
// the hand-built version used to relay without error but never actually show
// up as a status for group members.
async function postGroupStatus(sock, jid, content) {
  const payload = { ...content, groupStatus: true };
  if (payload.text && !payload.backgroundColor) {
    payload.backgroundColor = PURPLE_COLOR;
  }
  return sock.sendMessage(jid, payload);
}

// Helper: pakua media iliyo-quote (reply) kwenye DM — image au video —
// ili itumike kama group status. Muundo sawa na downloadMedia() ndani ya
// commands/admin/groupstatus.js.
async function downloadQuotedMedia(quotedMsg, type) {
  const mediaMsg = quotedMsg[`${type}Message`] || quotedMsg;
  const stream = await downloadContentFromMessage(mediaMsg, type);
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// Helper: geuza "namba" (mfano 1, 2, 3 - kama zinavyoonekana kwenye .gm list)
// kuwa groupId halisi. Kama tayari ni groupId kamili (ina @g.us) au ni "all",
// inarudishwa kama ilivyo bila kubadilishwa.
// Mpangilio wa namba unafuata mpangilio wa sock.groupFetchAllParticipating(),
// sawasawa na jinsi .gm list inavyoorodhesha groups (1, 2, 3, ...).
async function resolveGroupId(sock, raw) {
  if (!raw) return raw;
  const val = raw.toString().trim();

  if (val.toLowerCase() === 'all') return val;
  if (val.endsWith('@g.us')) return val;

  // Namba fupi (mfano "1", "2", "23") -> tafsiri kwa mpangilio wa .gm list
  if (/^\d{1,4}$/.test(val)) {
    const idx = parseInt(val, 10);
    const allGroups = await sock.groupFetchAllParticipating();
    const groups = Object.values(allGroups);
    const chosen = groups[idx - 1];
    if (!chosen) {
      throw new Error(
        `Group namba ${idx} haipo. Tumia .gm list kuona namba sahihi (1-${groups.length}).`
      );
    }
    return chosen.id;
  }

  // Kitu kingine chochote (mfano groupId ndefu bila @g.us) - rudisha kama ilivyo
  return val;
}

// Helper: angalia kama ujumbe una quoted image/video, na kama ndiyo, rudisha
// { type: 'image'|'video', buffer } tayari kutumika kama status.
async function getQuotedStatusMedia(msg) {
  const ctxInfo = msg.message?.extendedTextMessage?.contextInfo;
  const quoted = ctxInfo?.quotedMessage;
  if (!quoted) return null;

  const mtype = Object.keys(quoted)[0] || '';
  if (/image/i.test(mtype)) {
    return { type: 'image', buffer: await downloadQuotedMedia(quoted, 'image') };
  }
  if (/video/i.test(mtype)) {
    return { type: 'video', buffer: await downloadQuotedMedia(quoted, 'video') };
  }
  return null;
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
          `• .gm groupstatus <namba|groupId|all> <text> — Tuma text status\n` +
          `• (reply picha/video) .gm groupstatus <namba|groupId|all> [caption] — Tuma image/video status\n` +
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
        text += `💡 Tumia namba (mfano *${groups.length > 0 ? 1 : ''}*) badala ya groupId kwenye *.gm groupstatus*, mfano: *.gm groupstatus 1 Habari*`;

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
      // GROUPSTATUS - Tuma group status (text AU image/video) kwa
      // group|groups zote, moja kwa moja kutoka DM.
      // Kwa image/video: reply (jibu) picha/video na uandike command hii
      // ikiwa na caption ya hiari: .gm groupstatus <groupId|all> [caption]
      // ══════════════════════════════════════
      if (opt === 'groupstatus' || opt === 'gstatus') {
        let groupId = args[1];
        const captionOrText = args.slice(2).join(' ');

        const quotedMedia = await getQuotedStatusMedia(msg);

        if (!groupId || (!quotedMedia && !captionOrText)) {
          return extra.reply(
            '❌ Tumia:\n' +
            '.gm groupstatus <namba|groupId|all> <text> — TEXT status\n' +
            '(reply picha/video) .gm groupstatus <namba|groupId|all> [caption] — IMAGE/VIDEO status\n\n' +
            '💡 "Namba" ni namba ya group kama inavyoonekana kwenye *.gm list* (mfano: 1, 2, 3) - rahisi zaidi kuliko kuandika groupId ndefu.\n' +
            '💡 Reply (jibu) picha au video moja kwa moja hapa kwenye DM, kisha andika command hii kama caption/reply.'
          );
        }

        try {
          groupId = await resolveGroupId(sock, groupId);
        } catch (e) {
          return extra.reply(`❌ ${e.message}`);
        }

        const buildPayload = () => {
          if (quotedMedia) {
            return quotedMedia.type === 'image'
              ? { image: quotedMedia.buffer, caption: captionOrText || '' }
              : { video: quotedMedia.buffer, caption: captionOrText || '' };
          }
          return { text: captionOrText, backgroundColor: PURPLE_COLOR };
        };

        if (groupId.toLowerCase() === 'all') {
          const allGroups = await sock.groupFetchAllParticipating();
          const groupIds = Object.keys(allGroups);

          await extra.reply(`📤 Inatuma group status kwa groups *${groupIds.length}*... Subiri.`);

          let success = 0;
          let failed = 0;

          for (const gid of groupIds) {
            try {
              await postGroupStatus(sock, gid, buildPayload());
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
          await postGroupStatus(sock, groupId, buildPayload());
          const meta = await sock.groupMetadata(groupId);
          return extra.reply(`✅ Group status imetumwa kwenye *${meta.subject}*!`);
        } catch (e) {
          return extra.reply(`❌ Imeshindwa kutuma group status: ${e.message}`);
        }
      }

      // ══════════════════════════════════════
      // AUTOREACT - Washa/Zima autoreact per-group
      // ══════════════════════════════════════
      if (opt === 'autoreact') {
        const groupId = args[1];
        const val = args[2]?.toLowerCase();
        const modeArg = args[3]?.toLowerCase();

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
            database.updateGroupSettings(gid, { autoreact: isOn, autoreactMode: mode });
          }
          return extra.reply(
            `⚡ *AutoReact - GROUPS ZOTE*\n\n` +
            `Status: *${isOn ? 'ON ✅' : 'OFF ❌'}*\n` +
            (isOn ? `Mode: *${mode}*\n` : '') +
            `📊 Groups: ${groupIds.length}`
          );
        }

        database.updateGroupSettings(groupId, { autoreact: isOn, autoreactMode: mode });
        const meta = await sock.groupMetadata(groupId);
        return extra.reply(
          `⚡ *AutoReact - ${meta.subject}*\n\n` +
          `Status: *${isOn ? 'ON ✅' : 'OFF ❌'}*\n` +
          (isOn ? `Mode: *${mode}*` : '')
        );
      }

      // ══════════════════════════════════════
      // RESTORE - Rudisha watu walioondoka/kutolewa
      // ══════════════════════════════════════
      if (opt === 'restore') {
        const groupId = args[1];
        const target = args[2];

        if (!groupId) {
          return extra.reply(
            '❌ Tumia:\n' +
            '.gm restore <groupId> — rudisha WOTE walioondoka\n' +
            '.gm restore <groupId> <namba> — rudisha mtu mmoja\n' +
            '.gm restore all — rudisha wote kwenye groups zote\n\n' +
            '⚠️ Inafanya kazi tu kwa watu walioondoka BAADA ya feature hii kuwekwa.'
          );
        }

        const database = require('../../database');

        // ── Restore GROUPS ZOTE ──
        if (groupId.toLowerCase() === 'all') {
          const allGroups = await sock.groupFetchAllParticipating();
          const groupIds = Object.keys(allGroups);
          await extra.reply(`📤 Inajaribu kurudisha watu kwenye groups *${groupIds.length}*... Subiri.`);

          let totalSuccess = 0, totalFailed = 0, totalSkipped = 0;

          for (const gid of groupIds) {
            const leftMembers = database.getLeftMembers(gid);
            const userIds = Object.keys(leftMembers);
            if (userIds.length === 0) { totalSkipped++; continue; }

            for (const userId of userIds) {
              try {
                const result = await sock.groupParticipantsUpdate(gid, [userId], 'add');
                const status = result?.[0]?.status;
                if (status === '200' || status === 200) {
                  totalSuccess++;
                  database.removeLeftMember(gid, userId);
                } else { totalFailed++; }
                await new Promise(r => setTimeout(r, 2000));
              } catch (e) { totalFailed++; }
            }
          }

          return extra.reply(
            `✅ *Restore Imekamilika (Groups Zote)!*\n\n` +
            `📨 Imefanikiwa: ${totalSuccess}\n` +
            `❌ Imeshindwa: ${totalFailed}\n` +
            `⏭️ Groups bila left members: ${totalSkipped}\n\n` +
            `💡 Walioshindwa wanahitaji invite link.`
          );
        }

        const meta = await sock.groupMetadata(groupId);

        // ── Restore mtu MMOJA ──
        if (target) {
          const number = target.replace(/[^0-9]/g, '');
          const userJid = `${number}@s.whatsapp.net`;

          try {
            const result = await sock.groupParticipantsUpdate(groupId, [userJid], 'add');
            const status = result?.[0]?.status;

            if (status === '200' || status === 200) {
              database.removeLeftMember(groupId, userJid);
              return extra.reply(`✅ @${number} amerudishwa kwenye *${meta.subject}*!`);
            } else {
              return extra.reply(
                `❌ Imeshindwa kumrudisha @${number}.\n` +
                `Privacy settings hazikubali. Tumia invite link badala yake.`
              );
            }
          } catch (e) {
            return extra.reply(`❌ Error: ${e.message}`);
          }
        }

        // ── Restore WOTE kwenye group hii ──
        const leftMembers = database.getLeftMembers(groupId);
        const userIds = Object.keys(leftMembers);

        if (userIds.length === 0) {
          return extra.reply(`ℹ️ Hakuna mtu aliyeondoka kwenye *${meta.subject}* (siku 30 zilizopita).`);
        }

        await extra.reply(`📤 Inajaribu kurudisha watu *${userIds.length}* kwenye *${meta.subject}*... Subiri.`);

        let success = 0, failed = 0;
        const failedNumbers = [];

        for (const userId of userIds) {
          try {
            const result = await sock.groupParticipantsUpdate(groupId, [userId], 'add');
            const status = result?.[0]?.status;
            if (status === '200' || status === 200) {
              success++;
              database.removeLeftMember(groupId, userId);
            } else {
              failed++;
              failedNumbers.push(userId.split('@')[0]);
            }
            await new Promise(r => setTimeout(r, 2000));
          } catch (e) {
            failed++;
            failedNumbers.push(userId.split('@')[0]);
          }
        }

        return extra.reply(
          `✅ *Restore - ${meta.subject}*\n\n` +
          `📨 Imefanikiwa: ${success}\n` +
          `❌ Imeshindwa: ${failed}` +
          (failedNumbers.length > 0
            ? `\n\n⚠️ Walioshindwa:\n${failedNumbers.map(n => `• ${n}`).join('\n')}`
            : '')
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
