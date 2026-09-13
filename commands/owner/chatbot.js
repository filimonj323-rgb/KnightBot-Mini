/**
 * Chatbot Command - On/Off AI chatbot
 *
 * Inatumia getBotSettings/updateBotSettings (database.js) badala ya
 * kubadilisha config.chatbotInbox/config.chatbotGroup moja kwa moja —
 * hizo ni object MOJA ya global inayoshirikiwa na bot kuu NA kila mteja
 * wa pairing dashboard (wote wanaendesha kwenye process moja). Kubadilisha
 * config moja kwa moja kunge-leak toggle ya mteja mmoja kwa kila mtu.
 * getBotSettings/updateBotSettings zime-scope kwa owner kiotomatiki
 * (sawa na antilink/antipromo), hivyo kila bot inaona hali yake pekee.
 */
const { getBotSettings, updateBotSettings } = require('../../database');

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
        const current = getBotSettings();
        const inbox = current.chatbotInbox ? 'ON ✅' : 'OFF ❌';
        const group = current.chatbotGroup ? 'ON ✅' : 'OFF ❌';
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
        updateBotSettings({ chatbotInbox: true, chatbotGroup: true });
        return extra.reply('✅ AI Chatbot: *ON*\nBot itajibu inbox na groups zote kama binadamu!');
      }
      if (opt === 'off') {
        updateBotSettings({ chatbotInbox: false, chatbotGroup: false });
        return extra.reply('❌ AI Chatbot: *OFF*');
      }
      if (opt === 'inbox') {
        const current = getBotSettings();
        const next = updateBotSettings({ chatbotInbox: !current.chatbotInbox, chatbotGroup: false });
        return extra.reply(`📩 Chatbot Inbox: *${next.chatbotInbox ? 'ON ✅' : 'OFF ❌'}*`);
      }
      if (opt === 'group') {
        const current = getBotSettings();
        const next = updateBotSettings({ chatbotGroup: !current.chatbotGroup, chatbotInbox: false });
        return extra.reply(`👥 Chatbot Groups: *${next.chatbotGroup ? 'ON ✅' : 'OFF ❌'}*`);
      }

      extra.reply('❌ Tumia: .chatbot on / off / inbox / group');
    } catch (err) {
      extra.reply(`❌ Error: ${err.message}`);
    }
  }
};
