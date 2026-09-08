/**
 * GitHub Command - Show bot community/group info
 */

const config = require('../../config');

module.exports = {
    name: 'github',
    aliases: ['repo', 'git', 'source', 'sc', 'script'],
    category: 'general',
    description: 'Show IT MEDIATOR community group',
    usage: '.github',
    ownerOnly: false,

    async execute(sock, msg, args, extra) {
        try {
            const groupLink = 'https://chat.whatsapp.com/LHMMYiaxQhdDLfIfOhF4CV';

            let message = `╭━━『 *IT MEDIATOR* 』━━╮\n\n`;
            message += `🤖 *Bot Name:* ${config.botName}\n`;
            message += `👨‍💻 *Developer:* Mr. IT MEDIATOR\n\n`;
            message += `🚀 *Karibu kwenye jamii ya IT MEDIATOR!*\n`;
            message += `Jiunge nasi upate: 💡 msaada wa haraka, 🔥 update mpya za bot, `;
            message += `🎁 vipengele vipya kabla ya wengine, na 🤝 wadau wenzako wa tech.\n\n`;
            message += `👇 *Bonyeza link hapa chini ujiunge sasa:*\n`;
            message += `${groupLink}\n\n`;
            message += `╰━━━━━━━━━━━━━━━╯\n\n`;
            message += `> *ᴘᴏᴡᴇʀᴇᴅ ʙʏ ${config.botName}*`;

            await extra.reply(message);

        } catch (error) {
            console.error('GitHub command error:', error);
            await extra.reply(`❌ Error: ${error.message}`);
        }
    }
};
