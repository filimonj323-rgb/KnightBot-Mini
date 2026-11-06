/**
 * Antibot - Detect other Baileys bots via message-ID fingerprints, then warn/kick.
 * Admins, owner na bot yenyewe hawaguswi.
 *
 * Mipangilio huhifadhiwa kwenye group settings (database):
 *   antibot (true/false) na antibotAction ('warn' | 'kick', default 'warn')
 */

const database = require('../../database');
const config = require('../../config');
const { findParticipant, buildComparableIds } = require('../../utils/jidHelper');

const recent = new Map(); // msgId -> timestamp (dedupe)

// Alama za kawaida za message ID za bots za Baileys
function isBaileysBotId(id) {
  if (!id || typeof id !== 'string') return false;
  if (id.startsWith('BAE5') && id.length === 16) return true;
  if (id.startsWith('3EB0') && (id.length === 12 || id.length === 20 || id.length === 22 || id.length === 40)) {
    return true;
  }
  if (id.startsWith('B24E') && id.length === 20) return true;
  if (id.startsWith('NJX-')) return true;
  // Forks nyingi: PREFIX-hex yenye dash
  if (/^[A-Z0-9]{2,8}-[A-F0-9]{8,}$/i.test(id)) return true;
  return false;
}

/**
 * Inaitwa kwa kila ujumbe wa group (kutoka handler.js).
 * Inarudisha true kama imechukua hatua.
 */
async function handleAntibotDetection(sock, msg, groupMetadata) {
  try {
    const chatId = msg?.key?.remoteJid;
    if (!chatId || !chatId.endsWith('@g.us')) return false;
    if (msg.key.fromMe) return false;

    const settings = database.getGroupSettings(chatId);
    if (!settings.antibot) return false;

    const msgId = msg.key.id;
    if (!isBaileysBotId(msgId)) return false;

    // Dedupe (notify + append)
    const now = Date.now();
    if (recent.has(msgId) && now - recent.get(msgId) < 20000) return false;
    recent.set(msgId, now);
    if (recent.size > 300) {
      for (const [id, ts] of recent) {
        if (now - ts > 60000) recent.delete(id);
      }
    }

    // Lazy require ili kuepuka circular dependency na handler.js
    const handler = require('../../handler');

    const senderRaw = msg.key.participant || msg.participant || chatId;
    const senderAlt = msg.key.participantAlt;

    if (!(await handler.isBotAdmin(sock, chatId, groupMetadata))) return false;
    if (await handler.isAdmin(sock, senderRaw, chatId, groupMetadata)) return false;
    if (handler.isOwner(senderRaw, sock)) return false;

    // Usimguse bot yenyewe
    const botIds = [sock.user?.id, sock.user?.lid].filter(Boolean);
    const targetIds = new Set([senderRaw, senderAlt].filter(Boolean).flatMap((j) => buildComparableIds(j)));
    if (botIds.some((b) => buildComparableIds(b).some((id) => targetIds.has(id)))) return false;

    // JID itakayotumika kwa kick (ile iliyopo kwenye group metadata)
    let kickJid = senderRaw;
    let tagJid = senderRaw;
    try {
      const meta = groupMetadata?.participants ? groupMetadata : await sock.groupMetadata(chatId);
      const found = findParticipant(meta.participants, [senderAlt, senderRaw]);
      if (found?.id) kickJid = found.id;
      tagJid = found?.phoneNumber || found?.id || senderRaw;
    } catch {}

    const tag = String(tagJid).split('@')[0].split(':')[0];
    const mentions = [kickJid];
    const action = (settings.antibotAction || 'warn').toLowerCase();

    // Futa ujumbe wa bot kwanza
    try {
      await sock.sendMessage(chatId, { delete: msg.key });
    } catch {}

    if (action === 'kick') {
      try {
        await sock.groupParticipantsUpdate(chatId, [kickJid], 'remove');
        await sock.sendMessage(chatId, {
          text: `🤖 *@${tag}* was kicked — other bots are not allowed here.`,
          mentions
        });
      } catch (e) {
        console.error('[antibot] kick:', e?.message || e);
        await sock.sendMessage(chatId, {
          text: `🤖 Bot activity detected from *@${tag}* (kick failed — check bot admin rights).`,
          mentions
        });
      }
      return true;
    }

    // warn (default)
    const maxWarnings = config.maxWarnings || 3;
    const warningData = database.addWarning(chatId, kickJid, 'Antibot: bot activity detected');
    const count = warningData.count;

    if (count >= maxWarnings) {
      try {
        await sock.groupParticipantsUpdate(chatId, [kickJid], 'remove');
        database.clearWarnings(chatId, kickJid);
        await sock.sendMessage(chatId, {
          text: `🤖 *@${tag}* kicked after ${maxWarnings} antibot warnings.`,
          mentions
        });
      } catch (e) {
        console.error('[antibot] warn-kick:', e?.message || e);
      }
    } else {
      await sock.sendMessage(chatId, {
        text: `🤖 *@${tag}* warning ${count}/${maxWarnings} — other bots are not allowed.`,
        mentions
      });
    }
    return true;
  } catch (e) {
    console.error('[antibot]', e?.message || e);
    return false;
  }
}

module.exports = {
  name: 'antibot',
  aliases: ['nobot'],
  category: 'admin',
  description: 'Detect and warn/kick other bots in the group',
  usage: '.antibot <on/off/set/get>',
  groupOnly: true,
  adminOnly: true,
  botAdminNeeded: true,

  async execute(sock, msg, args, extra) {
    try {
      const settings = database.getGroupSettings(extra.from);

      if (!args[0]) {
        return extra.reply(
          `🤖 *Antibot Status*\n\n` +
          `Status: *${settings.antibot ? 'ON' : 'OFF'}*\n` +
          `Action: *${settings.antibotAction || 'warn'}*\n\n` +
          `Admins, owner, and this bot are exempt.\n` +
          `Detects other bots by message-ID pattern.\n\n` +
          `Usage:\n` +
          `  .antibot on\n` +
          `  .antibot off\n` +
          `  .antibot set warn | kick\n` +
          `  .antibot get`
        );
      }

      const opt = args[0].toLowerCase();

      if (opt === 'on') {
        if (settings.antibot) return extra.reply('*Antibot is already on*');
        database.updateGroupSettings(extra.from, { antibot: true });
        return extra.reply('*Antibot has been turned ON*');
      }

      if (opt === 'off') {
        database.updateGroupSettings(extra.from, { antibot: false });
        return extra.reply('*Antibot has been turned OFF*');
      }

      if (opt === 'set') {
        const setAction = (args[1] || '').toLowerCase();
        if (!['warn', 'kick'].includes(setAction)) {
          return extra.reply('*Invalid action. Choose warn or kick.*\n.antibot set warn | kick');
        }
        database.updateGroupSettings(extra.from, { antibot: true, antibotAction: setAction });
        return extra.reply(`*Antibot action set to ${setAction}*`);
      }

      if (opt === 'get') {
        return extra.reply(
          `*Antibot Configuration:*\nStatus: ${settings.antibot ? 'ON' : 'OFF'}\nAction: ${settings.antibotAction || 'warn'}`
        );
      }

      return extra.reply('*Use .antibot for usage.*');
    } catch (error) {
      await extra.reply(`❌ Error: ${error.message}`);
    }
  },

  handleAntibotDetection,
  isBaileysBotId
};
