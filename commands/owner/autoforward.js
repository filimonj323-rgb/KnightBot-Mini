/**
 * Auto-Forward Command
 * Forward messages from a source group to another group/channel.
 * Trigger: specific numbers, or any group admin.
 */

const af = require('../../utils/autoforward');

// Cache ya "namba → group ID" iliyojengwa na `.autoforward groups`
// (inabaki hai maadamu bot haijarestart, ni ya kurahisisha tu kutumia namba
// badala ya Group ID ndefu kwenye set/numbers/alladmin/on/off/remove).
let groupIndexCache = [];

async function buildGroupIndex(sock) {
  const chats = await sock.groupFetchAllParticipating();
  const list = Object.values(chats)
    .map(g => ({ id: g.id, subject: g.subject || g.id }))
    .sort((a, b) => a.subject.localeCompare(b.subject));
  groupIndexCache = list;
  return list;
}

module.exports = {
  name: 'autoforward',
  aliases: ['af', 'forward'],
  category: 'owner',
  description: 'Auto-forward messages kutoka group moja kwenda nyingine/channel',
  usage: '.autoforward help',
  ownerOnly: true,

  async execute(sock, msg, args, extra) {
    try {
      const chatId = msg.key.remoteJid;
      const opt = args[0]?.toLowerCase();

      if (!opt || opt === 'help') {
        return extra.reply(
          `📤 *AUTO FORWARD*\n\n` +
          `Peleka messages kutoka group moja kwenda group/channel nyingine.\n\n` +
          `📋 *Commands:*\n` +
          `• .autoforward groups\n` +
          `   — Orodha ya groups zote (na NAMBA) — tumia namba badala ya Group ID\n\n` +
          `• .autoforward set <sourceGroupId|here|namba> <destinationId|namba>\n` +
          `   — Weka group ya chanzo na pa kupeleka\n\n` +
          `• .autoforward numbers <sourceGroupId|here|namba> <namba1,namba2,...>\n` +
          `   — Namba zipi zikituma, message iforward (mfano: 255712345678,255789111222)\n\n` +
          `• .autoforward alladmin <sourceGroupId|here|namba> on/off\n` +
          `   — Admin YEYOTE akituma message, iforward\n\n` +
          `• .autoforward on <sourceGroupId|here|namba>\n` +
          `• .autoforward off <sourceGroupId|here|namba>\n` +
          `   — Washa/Zima rule MOJA\n\n` +
          `• .autoforward onall\n` +
          `• .autoforward offall\n` +
          `   — Washa/Zima RULES ZOTE kwa mara moja\n\n` +
          `• .autoforward remove <sourceGroupId|here|namba>\n` +
          `   — Futa rule kabisa\n\n` +
          `• .autoforward list — Orodha ya rules zote\n` +
          `• .autoforward here — Pata ID ya group hii\n\n` +
          `💡 Njia rahisi: tuma \`.autoforward groups\` kwanza kupata namba za kila group,\n` +
          `kisha tumia hizo namba badala ya Group ID ndefu, mfano:\n` +
          `\`.autoforward set 1 4\` (group #1 → group #4)\n\n` +
          `💡 Unaweza pia kuchanganya: weka \`numbers\` na \`alladmin on\` kwa wakati mmoja —\n` +
          `itaforward ikiwa namba ipo kwenye list AU sender ni admin.`
        );
      }

      if (opt === 'here') {
        if (!chatId.endsWith('@g.us')) return extra.reply('❌ Hii si group.');
        return extra.reply(`🆔 Group ID: \`${chatId}\``);
      }

      if (opt === 'groups') {
        const list = await buildGroupIndex(sock);
        if (!list.length) return extra.reply('📭 Bot haipo kwenye group yoyote.');

        let text = `📋 *GROUPS ZA BOT (${list.length})*\n\n`;
        list.forEach((g, i) => {
          text += `${i + 1}. ${g.subject}\n`;
        });
        text += `\n💡 Tumia namba hizi badala ya Group ID, mfano:\n\`.autoforward set 1 4\``;
        return extra.reply(text);
      }

      // Inageuza "here", namba ya index (kutoka .autoforward groups), au Group ID/channel
      // kamili - kuwa Group ID halisi ya kutumika kwenye rules.
      const resolveGroupId = async (raw) => {
        if (!raw) return null;
        if (raw.toLowerCase() === 'here') return chatId;
        if (raw.includes('@')) return raw; // tayari ni JID kamili (group/channel)

        if (/^\d+$/.test(raw)) {
          // Ni namba ya index (mfano "1", "4") - tumia orodha ya .autoforward groups
          if (!groupIndexCache.length) {
            throw new Error('Tumia `.autoforward groups` kwanza kupata namba za group.');
          }
          const idx = parseInt(raw, 10) - 1;
          if (idx < 0 || idx >= groupIndexCache.length) {
            throw new Error(`Namba ${raw} haipo kwenye orodha. Tumia \`.autoforward groups\` kuangalia.`);
          }
          return groupIndexCache[idx].id;
        }

        return raw;
      };

      if (opt === 'set') {
        const sourceGroupId = await resolveGroupId(args[1]);
        const destinationJid = await resolveGroupId(args[2]);
        if (!sourceGroupId || !destinationJid) {
          return extra.reply('❌ Tumia: .autoforward set <sourceGroupId|here|namba> <destinationId|namba>');
        }
        if (!sourceGroupId.endsWith('@g.us')) {
          return extra.reply('❌ sourceGroupId lazima iwe group (au namba ya group kutoka `.autoforward groups`)');
        }
        af.upsertRule(sourceGroupId, { destinationJid });
        return extra.reply(
          `✅ Rule imewekwa:\n` +
          `📥 Kutoka: \`${sourceGroupId}\`\n` +
          `📤 Kwenda: \`${destinationJid}\`\n\n` +
          `⚠️ Bado haijawashwa. Tumia \`.autoforward on ${args[1]}\` na weka \`numbers\` au \`alladmin on\`.`
        );
      }

      if (opt === 'numbers') {
        const sourceGroupId = await resolveGroupId(args[1]);
        const numbersRaw = args[2];
        if (!sourceGroupId || !numbersRaw) {
          return extra.reply('❌ Tumia: .autoforward numbers <sourceGroupId|here|namba> <namba1,namba2,...>');
        }
        const rule = af.findRule(sourceGroupId);
        if (!rule) return extra.reply('❌ Hakuna rule kwa group hii. Tumia `.autoforward set` kwanza.');

        const numbers = numbersRaw
          .split(',')
          .map(n => n.trim().replace(/[^0-9]/g, ''))
          .filter(Boolean);

        af.upsertRule(sourceGroupId, { numbers });
        return extra.reply(`✅ Namba zitakazoforward: ${numbers.map(n => '+' + n).join(', ')}`);
      }

      if (opt === 'alladmin') {
        const sourceGroupId = await resolveGroupId(args[1]);
        const val = args[2]?.toLowerCase();
        if (!sourceGroupId || (val !== 'on' && val !== 'off')) {
          return extra.reply('❌ Tumia: .autoforward alladmin <sourceGroupId|here|namba> on/off');
        }
        const rule = af.findRule(sourceGroupId);
        if (!rule) return extra.reply('❌ Hakuna rule kwa group hii. Tumia `.autoforward set` kwanza.');

        af.upsertRule(sourceGroupId, { alladmin: val === 'on' });
        return extra.reply(`✅ Forward kwa admin yeyote: *${val === 'on' ? 'ON' : 'OFF'}*`);
      }

      if (opt === 'onall' || opt === 'offall') {
        const rules = af.getRules();
        if (!rules.length) return extra.reply('📭 Hakuna rules zilizowekwa.');
        const enabled = opt === 'onall';
        const invalid = enabled
          ? rules.filter(r => !r.destinationJid || (!r.alladmin && !(r.numbers || []).length))
          : [];
        if (invalid.length) {
          return extra.reply(
            `❌ Rules ${invalid.length} hazina destination/trigger kamili, haziwezi kuwashwa zote.\n` +
            `Tumia \`.autoforward list\` kuona ni zipi.`
          );
        }
        const count = af.setAllEnabled(enabled);
        return extra.reply(`✅ Rules zote (${count}) zime-*${enabled ? 'WASHWA' : 'ZIMWA'}*`);
      }

      if (opt === 'on' || opt === 'off') {
        const sourceGroupId = await resolveGroupId(args[1]);
        if (!sourceGroupId) return extra.reply(`❌ Tumia: .autoforward ${opt} <sourceGroupId|here|namba>`);
        const rule = af.findRule(sourceGroupId);
        if (!rule || !rule.destinationJid) {
          return extra.reply('❌ Weka destination kwanza kwa `.autoforward set`.');
        }
        if (opt === 'on' && !rule.alladmin && (!rule.numbers || !rule.numbers.length)) {
          return extra.reply('❌ Weka `numbers` au `alladmin on` kabla ya kuwasha.');
        }
        af.upsertRule(sourceGroupId, { enabled: opt === 'on' });
        return extra.reply(`✅ Auto-Forward *${opt === 'on' ? 'ON' : 'OFF'}* kwa \`${sourceGroupId}\``);
      }

      if (opt === 'remove') {
        const sourceGroupId = await resolveGroupId(args[1]);
        if (!sourceGroupId) return extra.reply('❌ Tumia: .autoforward remove <sourceGroupId|here|namba>');
        const removed = af.removeRule(sourceGroupId);
        return extra.reply(removed ? '🗑️ Rule imefutwa.' : '❌ Hakuna rule ya kufuta.');
      }

      if (opt === 'list') {
        const rules = af.getRules();
        if (!rules.length) return extra.reply('📭 Hakuna rules zilizowekwa.');

        // Pata jina la group kutoka group ID (bot lazima iwe member wa hiyo group).
        // Ikishindikana (channel, bot haipo humo, n.k), tunarudi kwenye ID yenyewe.
        const getGroupName = async (jid) => {
          if (!jid) return '-';
          if (!jid.endsWith('@g.us')) return jid; // channel/namba - si group, onyesha kama ilivyo
          try {
            const meta = await sock.groupMetadata(jid);
            return meta?.subject || jid;
          } catch (e) {
            return jid; // bot haipo humo au imeshindikana kupata jina
          }
        };

        let text = `📋 *AUTO FORWARD RULES (${rules.length})*\n\n`;
        for (let i = 0; i < rules.length; i++) {
          const r = rules[i];
          const sourceName = await getGroupName(r.sourceGroupId);
          const destName = await getGroupName(r.destinationJid);

          text += `${i + 1}. ${r.enabled ? '✅ ON' : '❌ OFF'}\n`;
          text += `   📥 Kutoka: *${sourceName}*\n`;
          text += `   📤 Kwenda: *${destName}*\n`;
          text += `   👑 All admin: ${r.alladmin ? 'ON' : 'OFF'}\n`;
          text += `   🔢 Namba: ${r.numbers?.length ? r.numbers.map(n => '+' + n).join(', ') : '-'}\n\n`;
        }
        return extra.reply(text);
      }

      return extra.reply('❌ Chaguo batili. Tumia `.autoforward help`');
    } catch (err) {
      extra.reply(`❌ Error: ${err.message}`);
    }
  }
};
