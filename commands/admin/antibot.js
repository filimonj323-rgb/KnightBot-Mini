/**
 * Antibot - Inazuia na kufuta COMMANDS za bots nyingine na MAJIBU yao ya commands
 * (bot inagunduliwa kwa message-ID ya Baileys). Maongezi mengine ya bot hayaguswi.
 * Admins, owner na bot yenyewe hawaguswi.
 *
 * Mipangilio huhifadhiwa kwenye group settings (database):
 *   antibotEnabled (default ON — inazimwa tu kama ni false wazi) na
 *   antibotAction ('warn' | 'delete' | 'kick', default 'warn').
 *   Zinahifadhiwa kwenye database ya group (groups.json + Turso), na dashboard ya
 *   mteja (Ulinzi wa Groups → Anti Bot) inaandika field hizi hizi.
 */

const database = require('../../database');
const config = require('../../config');
const { findParticipant, buildComparableIds } = require('../../utils/jidHelper');

const recent = new Map(); // msgId -> timestamp (dedupe)
const lastCommand = new Map(); // chatId -> { ts, sender } — command ya mwisho kwenye group
const RESPONSE_WINDOW_MS = 15000; // bot ikijibu ndani ya sekunde 15 baada ya command = jibu la command

// Weka ANTIBOT_DEBUG=1 kwenye Railway kuona kwa nini ujumbe unagunduliwa au haugunduliwi
const debugOn = () => /^(1|true|yes)$/i.test(String(process.env.ANTIBOT_DEBUG || ''));
const dbg = (...a) => { if (debugOn()) console.log('[antibot]', ...a); };

// Jina la bot (branding) — linatoka config.botName
const brand = () => String(config.botName || 'Bot').toUpperCase();
const header = () => `🛡️ *${brand()} • ULINZI DHIDI YA BOTS*`;
const footer = () => `\n\n> _${brand()}_`;

// Alama za kawaida za message ID za bots za Baileys
function isBaileysBotId(id) {
  if (!id || typeof id !== 'string') return false;
  if (id.startsWith('BAE5') && id.length === 16) return true;
  if (id.startsWith('3EB0') && (id.length === 12 || id.length === 20 || id.length === 22 || id.length === 40)) {
    return true;
  }
  if (id.startsWith('B24E') && id.length === 20) return true;
  // Prefix za ziada za bots zenu (env ANTIBOT_ID_PREFIXES="ABC,XYZ")
  const extra = String(process.env.ANTIBOT_ID_PREFIXES || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (extra.some((p) => id.startsWith(p))) return true;
  if (id.startsWith('NJX-')) return true;
  // Forks nyingi: PREFIX-hex yenye dash
  if (/^[A-Z0-9]{2,8}-[A-F0-9]{8,}$/i.test(id)) return true;
  return false;
}

// Ondoa vifuniko (ephemeral/viewOnce/documentWithCaption) ili kufikia ujumbe halisi
function unwrapMessage(m) {
  let cur = m || {};
  for (let i = 0; i < 4; i++) {
    const inner =
      cur.ephemeralMessage?.message ||
      cur.viewOnceMessage?.message ||
      cur.viewOnceMessageV2?.message ||
      cur.documentWithCaptionMessage?.message ||
      null;
    if (!inner) break;
    cur = inner;
  }
  return cur;
}

function textOf(m) {
  m = unwrapMessage(m);
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    m.buttonsMessage?.contentText ||
    m.interactiveMessage?.body?.text ||
    ''
  );
}

// Maandishi ya ujumbe (text, caption ya picha/video)
function getMessageText(msg) {
  return textOf(msg?.message);
}

// Maandishi ya ujumbe uliobandikwa (reply/quote), kama upo
function getQuotedText(msg) {
  const m = unwrapMessage(msg?.message);
  for (const v of Object.values(m)) {
    const q = v && typeof v === 'object' ? v.contextInfo?.quotedMessage : null;
    if (q) return textOf(q);
  }
  return '';
}

// Command = ujumbe unaoanza na alama ya prefix (. ! # / $ n.k) ikifuatiwa na herufi,
// au prefix ya bot hii yenyewe (config.prefix)
function isCommandText(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  // (* _ ~ : ; hazimo: ni alama za bold/italic/emoji, zingefanya majibu ya kawaida yaonekane kama commands)
  if (/^[!#$%&+,.\/<=>?^|\\-][a-z]/i.test(t)) return true;
  const own = Array.isArray(config.prefix) ? config.prefix : [config.prefix];
  return own.filter(Boolean).some((p) => t.startsWith(p) && /[a-z]/i.test(t.charAt(p.length)));
}

/**
 * Inaitwa kwa kila ujumbe wa group (kutoka handler.js).
 * Inarudisha true kama ujumbe ni command ya bot nyingine au jibu lake (imezuiwa) —
 * handler haitaiendesha. Inarudisha false kwa kila kitu kingine.
 */
async function handleAntibotDetection(sock, msg, groupMetadata) {
  try {
    const chatId = msg?.key?.remoteJid;
    if (!chatId || !chatId.endsWith('@g.us')) return false;
    if (msg.key.fromMe) return false;

    const settings = database.getGroupSettings(chatId);
    if (settings.antibotEnabled === false) return false; // default ni ON

    const msgId = msg.key.id;
    const now = Date.now();
    const senderRaw = msg.key.participant || msg.participant || chatId;
    const senderAlt = msg.key.participantAlt;
    const senderKey = buildComparableIds(senderRaw)[0] || senderRaw;

    const text = getMessageText(msg);
    const isCmd = isCommandText(text);

    // Rekodi command ya mwisho ya group (kwa kugundua majibu ya bots)
    if (isCmd) {
      lastCommand.set(chatId, { ts: now, sender: senderKey });
      if (lastCommand.size > 200) {
        for (const [id, v] of lastCommand) if (now - v.ts > 60000) lastCommand.delete(id);
      }
    }

    // "Command ya bot" = ujumbe wenye ID ya bot ambao ni command, unaojibu command,
    // au umekuja ndani ya sekunde chache baada ya command ya mtu mwingine
    const botId = isBaileysBotId(msgId);
    const quotesCmd = isCommandText(getQuotedText(msg));
    const last = lastCommand.get(chatId);
    const inWindow = !!last && now - last.ts < RESPONSE_WINDOW_MS && last.sender !== senderKey;
    dbg(`id=${msgId} len=${String(msgId).length} botId=${botId} cmd=${isCmd} quotesCmd=${quotesCmd} inWindow=${inWindow} text=${JSON.stringify(String(text).slice(0, 30))}`);
    if (!(botId && (isCmd || quotesCmd || inWindow))) return false; // ujumbe mwingine wa bot hauguswi

    // Dedupe (notify + append)
    if (recent.has(msgId) && now - recent.get(msgId) < 20000) return true;
    recent.set(msgId, now);
    if (recent.size > 300) {
      for (const [id, ts] of recent) {
        if (now - ts > 60000) recent.delete(id);
      }
    }

    // Lazy require ili kuepuka circular dependency na handler.js
    const handler = require('../../handler');

    if (!(await handler.isBotAdmin(sock, chatId, groupMetadata))) { dbg('ruka: bot si admin kwenye group hii'); return false; }
    if (await handler.isAdmin(sock, senderRaw, chatId, groupMetadata)) { dbg('ruka: mtumaji ni admin'); return false; }
    if (handler.isOwner(senderRaw, sock)) { dbg('ruka: mtumaji ni owner'); return false; }

    // Usimguse bot yenyewe
    const botIds = [sock.user?.id, sock.user?.lid].filter(Boolean);
    const targetIds = new Set([senderRaw, senderAlt].filter(Boolean).flatMap((j) => buildComparableIds(j)));
    if (botIds.some((b) => buildComparableIds(b).some((id) => targetIds.has(id)))) { dbg('ruka: ni bot hii yenyewe'); return false; }

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

    // Futa command ya bot kwanza
    try {
      await sock.sendMessage(chatId, { delete: msg.key });
    } catch {}

    if (action === 'delete') return true; // futa tu, hakuna onyo wala kick

    if (action === 'kick') {
      try {
        await sock.groupParticipantsUpdate(chatId, [kickJid], 'remove');
        await sock.sendMessage(chatId, {
          text: `${header()}\n\n🚫 *@${tag}* ameondolewa kwenye group.\nBots nyingine haziruhusiwi hapa.${footer()}`,
          mentions
        });
      } catch (e) {
        console.error('[antibot] kick:', e?.message || e);
        await sock.sendMessage(chatId, {
          text: `${header()}\n\n⚠️ Nimegundua bot *@${tag}* ikituma command, lakini nimeshindwa kuiondoa.\nHakikisha bot yangu ni admin wa group.${footer()}`,
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
          text: `${header()}\n\n🚫 *@${tag}* ameondolewa baada ya kufikisha maonyo ${maxWarnings}.\nBots nyingine haziruhusiwi hapa.${footer()}`,
          mentions
        });
      } catch (e) {
        console.error('[antibot] warn-kick:', e?.message || e);
      }
    } else {
      await sock.sendMessage(chatId, {
        text: `${header()}\n\n⚠️ *ONYO ${count}/${maxWarnings}* kwa *@${tag}*\nCommands za bots nyingine haziruhusiwi kwenye group hii. Ukifikisha maonyo ${maxWarnings} utaondolewa.${footer()}`,
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
  description: 'Zuia na ufute commands za bots nyingine',
  usage: '.antibot <on/off/set/get>',
  groupOnly: true,
  adminOnly: true,
  botAdminNeeded: true,

  async execute(sock, msg, args, extra) {
    try {
      const settings = database.getGroupSettings(extra.from);
      const isOn = settings.antibotEnabled !== false; // default ON
      const currentAction = settings.antibotAction || 'warn';

      if (!args[0]) {
        return extra.reply(
          `${header()}\n\n` +
          `Hali: *${isOn ? 'IMEWASHWA' : 'IMEZIMWA'}*\n` +
          `Hatua: *${currentAction}*\n\n` +
          `Inazuia na kufuta commands za bots nyingine na majibu yao.\n` +
          `Admins, owner na bot hii hawaguswi.\n\n` +
          `*Matumizi:*\n` +
          `  .antibot on  — washa\n` +
          `  .antibot off  — zima\n` +
          `  .antibot set warn  — futa + onyo (3 = kuondolewa) [default]\n` +
          `  .antibot set delete  — futa tu\n` +
          `  .antibot set kick  — futa + kuondoa mara moja\n` +
          `  .antibot get  — angalia mipangilio` + footer()
        );
      }

      const opt = args[0].toLowerCase();

      if (opt === 'on') {
        if (isOn) return extra.reply('*Antibot tayari imewashwa*');
        database.updateGroupSettings(extra.from, { antibotEnabled: true });
        return extra.reply(`${header()}\n\n✅ Antibot *IMEWASHWA*. Commands za bots nyingine zitafutwa.${footer()}`);
      }

      if (opt === 'off') {
        database.updateGroupSettings(extra.from, { antibotEnabled: false });
        return extra.reply(`${header()}\n\n❌ Antibot *IMEZIMWA*.${footer()}`);
      }

      if (opt === 'set') {
        const setAction = (args[1] || '').toLowerCase();
        if (!['delete', 'warn', 'kick'].includes(setAction)) {
          return extra.reply('*Hatua si sahihi.* Chagua delete, warn au kick.\n.antibot set delete | warn | kick');
        }
        database.updateGroupSettings(extra.from, { antibotEnabled: true, antibotAction: setAction });
        return extra.reply(`${header()}\n\n✅ Hatua imewekwa: *${setAction}*\nAntibot imewashwa.${footer()}`);
      }

      if (opt === 'get') {
        return extra.reply(
          `${header()}\n\nHali: *${isOn ? 'IMEWASHWA' : 'IMEZIMWA'}*\nHatua: *${currentAction}*${footer()}`
        );
      }

      return extra.reply('*Tumia .antibot kuona matumizi.*');
    } catch (error) {
      await extra.reply(`❌ Hitilafu: ${error.message}`);
    }
  },

  handleAntibotDetection,
  isBaileysBotId,
  isCommandText,
  getQuotedText
};
