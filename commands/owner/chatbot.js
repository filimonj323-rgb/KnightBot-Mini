/**
 * Chatbot Command - On/Off AI chatbot
 */
const config = require('../../config');
const { updateBotSettings } = require('../../database');

module.exports = {
  name: 'chatbot',
  aliases: ['ai', 'bot'],
  category: 'owner',
  description: 'Washa/Zima AI chatbot (inajibu kama binadamu)',
  usage: '.chatbot <on/off/group/inbox>',
  ownerOnly: true,

  async execute(sock, msg, args, extra) {
    try {
      if (!args[0]) {
        const inbox = config.chatbotInbox ? 'ON ✅' : 'OFF ❌';
        const group = config.chatbotGroup ? 'ON ✅' : 'OFF ❌';
        return extra.reply(
          `🤖 *AI Chatbot Status*\n\n` +
          `📩 Inbox: *${inbox}*\n` +
          `👥 Groups: *${group}*\n\n` +
          `Usage:\n` +
          `• .chatbot on → washa zote\n` +
          `• .chatbot off → zima zote\n` +
          `• .chatbot inbox → inbox tu\n` +
          `• .chatbot group → groups tu`
        );
      }

      const opt = args[0].toLowerCase();

      if (opt === 'on') {
        config.chatbotInbox = true;
        config.chatbotGroup = true;
        updateBotSettings({ chatbotInbox: true, chatbotGroup: true });
        return extra.reply('✅ AI Chatbot: *ON*\nBot itajibu inbox na groups zote kama binadamu!');
      }
      if (opt === 'off') {
        config.chatbotInbox = false;
        config.chatbotGroup = false;
        updateBotSettings({ chatbotInbox: false, chatbotGroup: false });
        return extra.reply('❌ AI Chatbot: *OFF*');
      }
      if (opt === 'inbox') {
        config.chatbotInbox = !config.chatbotInbox;
        config.chatbotGroup = false;
        updateBotSettings({ chatbotInbox: config.chatbotInbox, chatbotGroup: false });
        return extra.reply(`📩 Chatbot Inbox: *${config.chatbotInbox ? 'ON ✅' : 'OFF ❌'}*`);
      }
      if (opt === 'group') {
        config.chatbotGroup = !config.chatbotGroup;
        config.chatbotInbox = false;
        updateBotSettings({ chatbotGroup: config.chatbotGroup, chatbotInbox: false });
        return extra.reply(`👥 Chatbot Groups: *${config.chatbotGroup ? 'ON ✅' : 'OFF ❌'}*`);
      }

      extra.reply('❌ Tumia: .chatbot on / off / inbox / group');
    } catch (err) {
      extra.reply(`❌ Error: ${err.message}`);
    }
  }
};
