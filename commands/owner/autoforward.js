/**
 * Auto-Forward Command
 * Forward messages from a source group to another group/channel.
 * Trigger: specific numbers, or any group admin.
 */

const af = require('../../utils/autoforward');

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
          `• .autoforward set <sourceGroupId|here> <destinationId>\n` +
          `   — Weka group ya chanzo na pa kupeleka\n\n` +
          `• .autoforward numbers <sourceGroupId|here> <namba1,namba2,...>\n` +
          `   — Namba zipi zikituma, message iforward (mfano: 255712345678,255789111222)\n\n` +
          `• .autoforward alladmin <sourceGroupId|here> on/off\n` +
          `   — Admin YEYOTE akituma message, iforward\n\n` +
          `• .autoforward on <sourceGroupId|here>\n` +
          `• .autoforward off <sourceGroupId|here>\n` +
          `   — Washa/Zima rule\n\n` +
          `• .autoforward remove <sourceGroupId|here>\n` +
          `   — Futa rule kabisa\n\n` +
          `• .autoforward list — Orodha ya rules zote\n` +
          `• .autoforward here — Pata ID ya group hii\n\n` +
          `💡 Unaweza kuchanganya: weka \`numbers\` na \`alladmin on\` kwa wakati mmoja —\n` +
          `itaforward ikiwa namba ipo kwenye list AU sender ni admin.`
        );
      }

      if (opt === 'here') {
        if (!chatId.endsWith('@g.us')) return extra.reply('❌ Hii si group.');
        return extra.reply(`🆔 Group ID: \`${chatId}\``);
      }

      const resolveGroupId = (raw) => {
        if (!raw) return null;
        if (raw.toLowerCase() === 'here') return chatId;
        return raw;
      };

      if (opt === 'set') {
        const sourceGroupId = resolveGroupId(args[1]);
        const destinationJid = args[2];
        if (!sourceGroupId || !destinationJid) {
          return extra.reply('❌ Tumia: .autoforward set <sourceGroupId|here> <destinationId>');
        }
        if (!sourceGroupId.endsWith('@g.us')) {
          return extra.reply('❌ sourceGroupId lazima iishie na @g.us');
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
        const sourceGroupId = resolveGroupId(args[1]);
        const numbersRaw = args[2];
        if (!sourceGroupId || !numbersRaw) {
          return extra.reply('❌ Tumia: .autoforward numbers <sourceGroupId|here> <namba1,namba2,...>');
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
        const sourceGroupId = resolveGroupId(args[1]);
        const val = args[2]?.toLowerCase();
        if (!sourceGroupId || (val !== 'on' && val !== 'off')) {
          return extra.reply('❌ Tumia: .autoforward alladmin <sourceGroupId|here> on/off');
        }
        const rule = af.findRule(sourceGroupId);
        if (!rule) return extra.reply('❌ Hakuna rule kwa group hii. Tumia `.autoforward set` kwanza.');

        af.upsertRule(sourceGroupId, { alladmin: val === 'on' });
        return extra.reply(`✅ Forward kwa admin yeyote: *${val === 'on' ? 'ON' : 'OFF'}*`);
      }

      if (opt === 'on' || opt === 'off') {
        const sourceGroupId = resolveGroupId(args[1]);
        if (!sourceGroupId) return extra.reply(`❌ Tumia: .autoforward ${opt} <sourceGroupId|here>`);
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
        const sourceGroupId = resolveGroupId(args[1]);
        if (!sourceGroupId) return extra.reply('❌ Tumia: .autoforward remove <sourceGroupId|here>');
        const removed = af.removeRule(sourceGroupId);
        return extra.reply(removed ? '🗑️ Rule imefutwa.' : '❌ Hakuna rule ya kufuta.');
      }

      if (opt === 'list') {
        const rules = af.getRules();
        if (!rules.length) return extra.reply('📭 Hakuna rules zilizowekwa.');

        let text = `📋 *AUTO FORWARD RULES (${rules.length})*\n\n`;
        rules.forEach((r, i) => {
          text += `${i + 1}. ${r.enabled ? '✅ ON' : '❌ OFF'}\n`;
          text += `   📥 Kutoka: \`${r.sourceGroupId}\`\n`;
          text += `   📤 Kwenda: \`${r.destinationJid || '-'}\`\n`;
          text += `   👑 All admin: ${r.alladmin ? 'ON' : 'OFF'}\n`;
          text += `   🔢 Namba: ${r.numbers?.length ? r.numbers.map(n => '+' + n).join(', ') : '-'}\n\n`;
        });
        return extra.reply(text);
      }

      return extra.reply('❌ Chaguo batili. Tumia `.autoforward help`');
    } catch (err) {
      extra.reply(`❌ Error: ${err.message}`);
    }
  }
};
