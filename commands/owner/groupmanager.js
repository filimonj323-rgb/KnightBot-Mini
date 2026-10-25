/**
 * Remote Group Manager
 * Manage groups zote kutoka inbox bila kuingia kwenye group
 */

const config = require('../../config');
const { downloadContentFromMessage } = global.__baileys;
const { sendButtons } = require('gifted-btns');
const pendingGroupStatus = require('../../utils/pendingGroupStatus');
const { sendGroupStatus } = require('../../utils/groupStatusVideo');
const { addMembers, parseNumbers, formatResult } = require('../../utils/addMembers');

const PURPLE_COLOR = '#9C27B0';
// Kikomo cha rows kwenye orodha ya button - epuka ujumbe mkubwa mno
const MAX_LIST_ROWS = 30;

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
  // Video ndefu inakatwa vipande na kutumwa kwa mfuatano (utils/groupStatusVideo.js)
  return sendGroupStatus(sock, jid, payload);
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
          `• .gm add <groupId> <namba> [namba2 ...] — Ongeza members\n` +
          `• .gm autoadd <groupId> on|off — Bot ijaze group kiotomatiki usiku\n` +
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
          `• .gm groupstatus 1,3,5 <text> — Tuma kwa groups kadhaa (namba zenye comma)\n` +
          `• .gm groupstatus chagua <text> — Bot inaleta vitufe vya kuchagua group\n` +
          `• .gm autoreact <groupId|all> on/off [bot|all] — Auto react\n` +
          `• .gm left <namba|groupId|all> — Orodha ya walioondoka (siku 30)\n` +
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
        let groupId = args[1];
        if (!groupId) return extra.reply('❌ Taja group namba/ID: .gm info <namba|groupId>');
        try { groupId = await resolveGroupId(sock, groupId); } catch (e) { return extra.reply(`❌ ${e.message}`); }

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
        let groupId = args[1];
        if (!groupId) return extra.reply('❌ Taja group namba/ID: .gm admins <namba|groupId>');
        try { groupId = await resolveGroupId(sock, groupId); } catch (e) { return extra.reply(`❌ ${e.message}`); }

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
        let groupId = args[1];
        if (!groupId) return extra.reply('❌ Taja group namba/ID: .gm members <namba|groupId>');
        try { groupId = await resolveGroupId(sock, groupId); } catch (e) { return extra.reply(`❌ ${e.message}`); }

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
        let groupId = args[1];
        const val = args[2]?.toLowerCase();
        if (!groupId || !val) {
          return extra.reply('❌ Tumia: .gm antilink <namba|groupId|all> on/off');
        }
        try { groupId = await resolveGroupId(sock, groupId); } catch (e) { return extra.reply(`❌ ${e.message}`); }

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
        let groupId = args[1];
        const val = args[2]?.toLowerCase();
        if (!groupId || !val) {
          return extra.reply('❌ Tumia: .gm antipromo <namba|groupId|all> on/off');
        }
        try { groupId = await resolveGroupId(sock, groupId); } catch (e) { return extra.reply(`❌ ${e.message}`); }

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
        let groupId = args[1];
        const val = args[2]?.toLowerCase();

        if (!groupId) {
          return extra.reply(
            '❌ Tumia:\n' +
            '.gm antigroupmention <namba|groupId|all> on/off\n' +
            '.gm antigroupmention <namba|groupId> set delete|kick'
          );
        }
        try { groupId = await resolveGroupId(sock, groupId); } catch (e) { return extra.reply(`❌ ${e.message}`); }

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
        let groupId = args[1];
        const val = args[2]?.toLowerCase();
        if (!groupId || !val) {
          return extra.reply('❌ Tumia: .gm mute <namba|groupId> on/off');
        }
        try { groupId = await resolveGroupId(sock, groupId); } catch (e) { return extra.reply(`❌ ${e.message}`); }

        await sock.groupSettingUpdate(groupId, val === 'on' ? 'announcement' : 'not_announcement');
        const meta = await sock.groupMetadata(groupId);
        return extra.reply(
          `🔇 *${meta.subject}*\n\n` +
          `Mute: *${val === 'on' ? 'ON ✅ (Admins tu waweza kutuma)' : 'OFF ❌ (Wote waweza kutuma)'}*`
        );
      }

      // ══════════════════════════════════════
      // AUTOADD - Bot iongeze watu kiotomatiki (usiku)
      // ══════════════════════════════════════
      if (opt === 'autoadd') {
        const database = require('../../database');
        const autoAdd = require('../../utils/autoAdd');
        // Bot ya mteja (pairing/instanceManager) ina sock.pairingOwnerId; bot kuu haina.
        // (Usilinganishe `sock !== global.currentSock` — amri hupokea Proxy ya sock wakati
        // mipangilio ya kufuta amri imewashwa, kwa hiyo rejea hazifanani hata kwa bot kuu.)
        // Bot ya mteja inaweza kutumia feature hii TU ikiwa admin ameiwasha kwenye admin dashboard
        // (Mipangilio ya mteja huyo). Mipangilio yake imehifadhiwa kwa key ya "<namba>::<groupId>".
        const owner = sock.pairingOwnerId || null;
        if (owner) {
          if (!autoAdd.ownerHasAccess(owner)) return extra.reply('🔒 Feature ya *auto-add* haijawashwa kwa akaunti yako. Wasiliana na admin aiwashe.');
        } else if (!global.currentSock) {
          return extra.reply('❌ Bot kuu haijaunganishwa bado — jaribu tena baada ya sekunde chache.');
        }

        const first = args[1]?.toLowerCase();
        if (!first || first === 'help') {
          return extra.reply(
            '👥 *AUTO-ADD* — bot inaongeza watu kutoka groups zake nyingine kwenda group lengwa, polepole usiku.\n\n' +
            '• .gm autoadd <group> on [idadi kwa siku] — washa (default 15)\n' +
            '• .gm autoadd <group> off — zima\n' +
            '• .gm autoadd <group> limit <idadi> — badilisha idadi kwa siku\n' +
            '• .gm autoadd <group> window <kuanzia> <hadi> — masaa 0-23 (EAT). Mfano: *window 23 6* = 23:00–06:00 (saa 5 usiku–saa 12 asubuhi)\n' +
            '• .gm autoadd <group> now — jaribu kuongeza mmoja sasa hivi\n' +
            '• .gm autoadd status — hali ya groups zote\n\n' +
            '🕛 Default: *saa 6 usiku (00:00) hadi 05:00* EAT, mmoja kila dakika 15–35.\n' +
            'ℹ️ Bot iwe admin, AU group liruhusu members wa-add watu. Walioondoka wenyewe hawaongezwi tena.'
          );
        }
        if (first === 'status') return extra.reply(await autoAdd.statusText(sock));

        let groupId;
        try { groupId = await resolveGroupId(sock, args[1]); } catch (e) { return extra.reply(`❌ ${e.message}`); }
        const action = args[2]?.toLowerCase();
        const storeKey = autoAdd.keyFor(owner, groupId);
        const all = database.getAutoAddAll();
        const cfg = all[storeKey] || { ...autoAdd.DEFAULTS, windowV2: true, perDayV2: true };
        const meta = await sock.groupMetadata(groupId);
        const hh = (h) => String(h).padStart(2, '0') + ':00';
        // Soma store upya wakati wa kuhifadhi ili tusifute mabadiliko ya bots/wateja wengine.
        const save = () => { const fresh = database.getAutoAddAll(); fresh[storeKey] = cfg; database.saveAutoAddAll(fresh); };
        const clampPerDay = (v) => Math.max(1, Math.min(autoAdd.MAX_PER_DAY_CAP, Math.floor(Number(v))));

        if (action === 'on') {
          if (args[3] !== undefined) {
            if (!Number.isFinite(Number(args[3])) || Number(args[3]) < 1) return extra.reply('❌ Idadi si sahihi. Mfano: .gm autoadd 3 on 10');
            cfg.perDay = clampPerDay(args[3]); cfg.perDayV2 = true;
          }
          cfg.enabled = true;
          cfg.windowKey = null; // quota ianze upya
          save();
          return extra.reply(
            `✅ Auto-add *IMEWASHWA* kwa *${meta.subject}*\n\n` +
            `👥 Watu ${cfg.perDay} kwa siku, kutoka groups mbalimbali (random)\n` +
            `🕛 ${hh(cfg.startHour)}–${hh(cfg.endHour)} EAT\n\n` +
            `⚠️ Bot iwe admin au group liruhusu members wa-add. Jaribu: *.gm autoadd ${args[1]} now*`
          );
        }
        if (action === 'off') {
          cfg.enabled = false;
          save();
          return extra.reply(`🔴 Auto-add imezimwa kwa *${meta.subject}*.`);
        }
        if (action === 'limit') {
          if (!Number.isFinite(Number(args[3])) || Number(args[3]) < 1) return extra.reply('❌ Tumia: .gm autoadd <group> limit <idadi>');
          cfg.perDay = clampPerDay(args[3]); cfg.perDayV2 = true;
          save();
          return extra.reply(`✅ *${meta.subject}*: watu ${cfg.perDay} kwa siku.`);
        }
        if (action === 'window') {
          const s = Number(args[3]), e = Number(args[4]);
          if (![s, e].every((n) => Number.isInteger(n) && n >= 0 && n <= 23)) {
            return extra.reply('❌ Tumia: .gm autoadd <group> window <kuanzia> <hadi> (masaa 0-23)\nMfano: *window 23 6* = 23:00–06:00 (saa 5 usiku hadi saa 12 asubuhi)');
          }
          cfg.startHour = s; cfg.endHour = e; cfg.windowKey = null; cfg.windowV2 = true;
          save();
          return extra.reply(`✅ *${meta.subject}*: dirisha ni ${hh(s)}–${hh(e)} EAT.`);
        }
        if (action === 'now') {
          await extra.reply('⏳ Inajaribu kuongeza mmoja sasa hivi...');
          const r = await autoAdd.runOnce(sock, groupId, cfg, {});
          cfg.lastRun = Date.now(); cfg.lastResult = r.msg;
          save();
          return extra.reply(r.ok ? `✅ ${r.msg}` : `⚠️ ${r.msg}`);
        }
        return extra.reply('❌ Chagua: on | off | limit | window | now\nAu .gm autoadd status');
      }

      // ══════════════════════════════════════
      // ADD - Ongeza members
      // ══════════════════════════════════════
      if (opt === 'add') {
        let groupId = args[1];
        const { valid, invalid } = parseNumbers(args.slice(2));
        if (!groupId || valid.length === 0) {
          return extra.reply(
            '❌ Tumia: .gm add <namba ya group|groupId> <namba> [namba2 ...]\n\n' +
            'Mfano: .gm add 3 255712345678 0655123456'
          );
        }
        try { groupId = await resolveGroupId(sock, groupId); } catch (e) { return extra.reply(`❌ ${e.message}`); }

        if (valid.length > 1) await extra.reply(`⏳ Inaongeza ${valid.length} members... Subiri.`);
        const res = await addMembers(sock, groupId, valid);
        return extra.reply(formatResult(res, invalid));
      }

      // ══════════════════════════════════════
      // KICK - Toa member
      // ══════════════════════════════════════
      if (opt === 'kick') {
        let groupId = args[1];
        const number = args[2]?.replace(/[^0-9]/g, '');
        if (!groupId || !number) {
          return extra.reply('❌ Tumia: .gm kick <namba ya group|groupId> <namba ya mtu>');
        }
        try { groupId = await resolveGroupId(sock, groupId); } catch (e) { return extra.reply(`❌ ${e.message}`); }

        const jid = number + '@s.whatsapp.net';
        await sock.groupParticipantsUpdate(groupId, [jid], 'remove');
        const meta = await sock.groupMetadata(groupId);
        return extra.reply(`✅ *${number}* ametolewa kwenye *${meta.subject}*!`);
      }

      // ══════════════════════════════════════
      // PROMOTE - Fanya admin
      // ══════════════════════════════════════
      if (opt === 'promote') {
        let groupId = args[1];
        const number = args[2]?.replace(/[^0-9]/g, '');
        if (!groupId || !number) {
          return extra.reply('❌ Tumia: .gm promote <namba ya group|groupId> <namba ya mtu>');
        }
        try { groupId = await resolveGroupId(sock, groupId); } catch (e) { return extra.reply(`❌ ${e.message}`); }

        const jid = number + '@s.whatsapp.net';
        await sock.groupParticipantsUpdate(groupId, [jid], 'promote');
        const meta = await sock.groupMetadata(groupId);
        return extra.reply(`✅ *${number}* amefanywa admin wa *${meta.subject}*! 👑`);
      }

      // ══════════════════════════════════════
      // DEMOTE - Ondoa admin
      // ══════════════════════════════════════
      if (opt === 'demote') {
        let groupId = args[1];
        const number = args[2]?.replace(/[^0-9]/g, '');
        if (!groupId || !number) {
          return extra.reply('❌ Tumia: .gm demote <namba ya group|groupId> <namba ya mtu>');
        }
        try { groupId = await resolveGroupId(sock, groupId); } catch (e) { return extra.reply(`❌ ${e.message}`); }

        const jid = number + '@s.whatsapp.net';
        await sock.groupParticipantsUpdate(groupId, [jid], 'demote');
        const meta = await sock.groupMetadata(groupId);
        return extra.reply(`✅ *${number}* ameondolewa admin wa *${meta.subject}*!`);
      }

      // ══════════════════════════════════════
      // LINK - Pata invite link
      // ══════════════════════════════════════
      if (opt === 'link') {
        let groupId = args[1];
        if (!groupId) return extra.reply('❌ Tumia: .gm link <namba|groupId>');
        try { groupId = await resolveGroupId(sock, groupId); } catch (e) { return extra.reply(`❌ ${e.message}`); }

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
        let groupId = args[1];
        if (!groupId) return extra.reply('❌ Tumia: .gm resetlink <namba|groupId>');
        try { groupId = await resolveGroupId(sock, groupId); } catch (e) { return extra.reply(`❌ ${e.message}`); }

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
        let groupId = args[1];
        const message = args.slice(2).join(' ');
        if (!groupId || !message) {
          return extra.reply('❌ Tumia: .gm send <namba|groupId> <message>');
        }
        try { groupId = await resolveGroupId(sock, groupId); } catch (e) { return extra.reply(`❌ ${e.message}`); }

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
        // Zuia kujipost tena: ruhusu mara moja tu kwa kila ujumbe wa amri
        if (!require('../../utils/groupStatusGuard').claim(msg)) return;
        let groupId = args[1];

        // ══════════════════════════════════════
        // NJIA YA MABONYEZO: .gm groupstatus chagua <text>
        // Badala ya kuandika namba/groupId, bot inaleta orodha ya
        // groups kama vitufe (buttons) - unabonyeza moja tu.
        // ══════════════════════════════════════
        if (groupId?.toLowerCase() === 'chagua') {
          const captionOrText = args.slice(2).join(' ');
          const quotedMedia = await getQuotedStatusMedia(msg);

          if (!quotedMedia && !captionOrText) {
            return extra.reply(
              '❌ Tumia:\n' +
              '.gm groupstatus chagua <text> — TEXT status\n' +
              '(reply picha/video) .gm groupstatus chagua [caption] — IMAGE/VIDEO status\n\n' +
              '💡 Baada ya hii, bot itakuletea orodha ya groups - bonyeza moja kuchagua.'
            );
          }

          const payload = quotedMedia
            ? (quotedMedia.type === 'image'
                ? { image: quotedMedia.buffer, caption: captionOrText || '' }
                : { video: quotedMedia.buffer, caption: captionOrText || '' })
            : { text: captionOrText, backgroundColor: PURPLE_COLOR };

          const allGroups = await sock.groupFetchAllParticipating();
          const groups = Object.values(allGroups);
          if (!groups.length) return extra.reply('📭 Bot haipo kwenye group yoyote!');

          const sender = msg.key.remoteJid;
          pendingGroupStatus.set(sender, payload);

          const limited = groups.slice(0, MAX_LIST_ROWS);
          const rows = limited.map((g) => ({
            title: (g.subject || 'Group').slice(0, 24),
            description: `${g.participants.length} members`,
            id: `gmgs_${g.id}`,
          }));
          rows.unshift({
            title: '📢 GROUPS ZOTE',
            description: `Tuma kwa groups zote (${groups.length})`,
            id: 'gmgs_all',
          });

          try {
            await sendButtons(sock, sender, {
              title: '📋 Chagua Group',
              text:
                'Bonyeza group unayotaka kutuma status:' +
                (groups.length > MAX_LIST_ROWS
                  ? `\n\n⚠️ Zinaonyeshwa groups ${MAX_LIST_ROWS} za kwanza tu (jumla ${groups.length}). Tumia namba/groupId kwa nyingine.`
                  : ''),
              footer: 'Chaguo litaisha baada ya dakika 5',
              buttons: [
                {
                  name: 'single_select',
                  buttonParamsJson: JSON.stringify({
                    title: 'Chagua Group',
                    sections: [{ title: 'Groups', rows }],
                  }),
                },
              ],
            }, { quoted: msg });
          } catch (e) {
            pendingGroupStatus.clear(sender);
            console.error('groupstatus chagua sendButtons error:', e);
            return extra.reply(
              `❌ Imeshindwa kutuma orodha ya vitufe: ${e.message}\n\n` +
              `💡 Tumia njia ya kawaida badala yake: .gm groupstatus <namba|groupId|all> <text>`
            );
          }

          return;
        }

        // ══════════════════════════════════════
        // NJIA YA KAWAIDA: .gm groupstatus <namba|groupId|all> <text>
        // ══════════════════════════════════════
        const captionOrText = args.slice(2).join(' ');

        const quotedMedia = await getQuotedStatusMedia(msg);

        if (!groupId || (!quotedMedia && !captionOrText)) {
          return extra.reply(
            '❌ Tumia:\n' +
            '.gm groupstatus <namba|groupId|all> <text> — TEXT status\n' +
            '(reply picha/video) .gm groupstatus <namba|groupId|all> [caption] — IMAGE/VIDEO status\n\n' +
            '💡 "Namba" ni namba ya group kama inavyoonekana kwenye *.gm list* (mfano: 1, 2, 3).\n' +
            '💡 Groups zaidi ya moja: tenganisha kwa comma, mfano *.gm groupstatus 1,3,5 Habari*.\n' +
            '💡 Au tumia *.gm groupstatus chagua <text>* kupata vitufe vya kubonyeza.\n' +
            '💡 Reply (jibu) picha au video moja kwa moja hapa kwenye DM, kisha andika command hii kama caption/reply.'
          );
        }

        const buildPayload = () => {
          if (quotedMedia) {
            return quotedMedia.type === 'image'
              ? { image: quotedMedia.buffer, caption: captionOrText || '' }
              : { video: quotedMedia.buffer, caption: captionOrText || '' };
          }
          return { text: captionOrText, backgroundColor: PURPLE_COLOR };
        };

        // ══════════════════════════════════════
        // GROUPS ZAIDI YA MOJA: .gm groupstatus 1,3,5 <text>
        // (namba/groupId kadhaa zikitenganishwa na comma)
        // ══════════════════════════════════════
        if (groupId.toLowerCase() !== 'all' && groupId.includes(',')) {
          const rawList = groupId.split(',').map(s => s.trim()).filter(Boolean);
          let groupIds;
          try {
            groupIds = await Promise.all(rawList.map(r => resolveGroupId(sock, r)));
          } catch (e) {
            return extra.reply(`❌ ${e.message}`);
          }

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
          groupId = await resolveGroupId(sock, groupId);
        } catch (e) {
          return extra.reply(`❌ ${e.message}`);
        }

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
          const sent = await postGroupStatus(sock, groupId, buildPayload());
          const meta = await sock.groupMetadata(groupId);
          return extra.reply(`✅ Group status imetumwa kwenye *${meta.subject}*!` +
            (sent?.parts > 1 ? `\n✂️ Video ilikatwa vipande *${sent.parts}*.` : ''));
        } catch (e) {
          return extra.reply(`❌ Imeshindwa kutuma group status: ${e.message}`);
        }
      }

      // ══════════════════════════════════════
      // AUTOREACT - Washa/Zima autoreact per-group
      // ══════════════════════════════════════
      if (opt === 'autoreact') {
        let groupId = args[1];
        const val = args[2]?.toLowerCase();
        const modeArg = args[3]?.toLowerCase();

        if (!groupId || !val) {
          return extra.reply(
            '❌ Tumia:\n' +
            '.gm autoreact <namba|groupId|all> on/off [bot|all]\n\n' +
            '• *bot* — react ⏳ kwa commands tu (default)\n' +
            '• *all* — react emoji random kwa kila ujumbe'
          );
        }
        try { groupId = await resolveGroupId(sock, groupId); } catch (e) { return extra.reply(`❌ ${e.message}`); }

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
        let groupId = args[1];
        const target = args[2];

        if (!groupId) {
          return extra.reply(
            '❌ Tumia:\n' +
            '.gm restore <namba|groupId> — rudisha WOTE walioondoka\n' +
            '.gm restore <namba|groupId> <namba ya mtu> — rudisha mtu mmoja\n' +
            '.gm restore all — rudisha wote kwenye groups zote\n\n' +
            '⚠️ Inafanya kazi tu kwa watu walioondoka BAADA ya feature hii kuwekwa.'
          );
        }
        try { groupId = await resolveGroupId(sock, groupId); } catch (e) { return extra.reply(`❌ ${e.message}`); }

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
      // LEFT - Orodha ya walioondoka/kutolewa (groups ambazo bot ni admin)
      // ══════════════════════════════════════
      if (opt === 'left') {
        let groupId = args[1];
        if (!groupId) {
          return extra.reply(
            '❌ Tumia:\n' +
            '.gm left <namba|groupId> — walioondoka kwenye group moja\n' +
            '.gm left all — muhtasari wa groups zote\n\n' +
            'ℹ️ Inarekodi tu kwenye groups ambazo bot ni admin, na kwa walioondoka baada ya feature hii kuwekwa. Rekodi hukaa siku 30.'
          );
        }
        try { groupId = await resolveGroupId(sock, groupId); } catch (e) { return extra.reply(`❌ ${e.message}`); }

        const database = require('../../database');
        const fmtDate = (ts) => new Date(ts).toLocaleString('en-GB', {
          timeZone: 'Africa/Dar_es_Salaam', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
        });

        // ── Muhtasari wa groups zote ──
        if (groupId.toLowerCase() === 'all') {
          const allGroups = await sock.groupFetchAllParticipating();
          const rows = [];
          let total = 0;
          Object.values(allGroups).forEach((g, i) => {
            const n = Object.keys(database.getLeftMembers(g.id)).length;
            if (n > 0) { rows.push(`${i + 1}. *${g.subject}* — ${n}`); total += n; }
          });
          if (rows.length === 0) return extra.reply('ℹ️ Hakuna aliyeondoka kwenye groups zozote (siku 30 zilizopita).');
          return extra.reply(
            `📋 *Walioondoka — Groups Zote*\n\n${rows.join('\n')}\n\n` +
            `👥 Jumla: *${total}*\n💡 Maelezo: *.gm left <namba>*`
          );
        }

        const meta = await sock.groupMetadata(groupId);
        const left = database.getLeftMembers(groupId);
        const entries = Object.entries(left).sort((a, b) => b[1] - a[1]); // wapya kwanza
        if (entries.length === 0) {
          return extra.reply(`ℹ️ Hakuna aliyeondoka kwenye *${meta.subject}* (siku 30 zilizopita).`);
        }

        const MAX_SHOW = 80;
        const lines = entries.slice(0, MAX_SHOW).map(([jid, ts], i) => `${i + 1}. ${jid.split('@')[0]} — ${fmtDate(ts)}`);
        return extra.reply(
          `📋 *Walioondoka — ${meta.subject}*\n\n${lines.join('\n')}` +
          (entries.length > MAX_SHOW ? `\n\n...na wengine ${entries.length - MAX_SHOW}` : '') +
          `\n\n👥 Jumla: *${entries.length}*\n💡 Kurudisha: *.gm restore ${args[1]}*`
        );
      }

      // ══════════════════════════════════════
      // LEAVE - Bot itoke group
      // ══════════════════════════════════════
      if (opt === 'leave') {
        let groupId = args[1];
        if (!groupId) return extra.reply('❌ Tumia: .gm leave <namba|groupId>');
        try { groupId = await resolveGroupId(sock, groupId); } catch (e) { return extra.reply(`❌ ${e.message}`); }

        const meta = await sock.groupMetadata(groupId);
        await sock.sendMessage(groupId, { text: '👋 Bot inaondoka. Kwa heri!' });
        await sock.groupLeave(groupId);
        return extra.reply(`✅ Bot imetoka kwenye *${meta.subject}*!`);
      }

      extra.reply('❌ Command haijulikani. Tumia: .gm help');

    } catch (err) {
      extra.reply(`❌ Error: ${err.message}\n\nHakikisha:\n• Group ID ni sahihi\n• Bot ni admin wa group hiyo`);
    }
  },

  // Zinatumika na handler.js baada ya owner kubonyeza button ya kuchagua
  // group kwenye njia ya ".gm groupstatus chagua ..."
  postGroupStatus,
  resolveGroupId,
};
