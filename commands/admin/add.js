/**
 * Add Command - Ongeza member(s) kwenye group
 */

const { addMembers, parseNumbers, formatResult, MAX_PER_COMMAND } = require('../../utils/addMembers');

module.exports = {
  name: 'add',
  aliases: ['addmember', 'ongeza'],
  category: 'admin',
  description: 'Ongeza member kwenye group kwa namba',
  usage: '.add <namba> [namba2 ...]',
  groupOnly: true,
  adminOnly: true,
  botAdminNeeded: true,

  async execute(sock, msg, args, extra) {
    try {
      const { valid, invalid } = parseNumbers(args);
      if (valid.length === 0) {
        return extra.reply(
          '❌ Weka namba ya kuongeza!\n\n' +
          'Mfano:\n• .add 255712345678\n• .add 0712345678 0655123456\n\n' +
          `ℹ️ Hadi namba ${MAX_PER_COMMAND} kwa mara moja. Namba za Tanzania zinaweza kuanza na 0.`
        );
      }

      if (valid.length > 1) await extra.reply(`⏳ Inaongeza ${valid.length} members... Subiri.`);
      const res = await addMembers(sock, extra.from, valid);
      return extra.reply(formatResult(res, invalid));
    } catch (error) {
      await extra.reply(`❌ Error: ${error.message}`);
    }
  }
};
