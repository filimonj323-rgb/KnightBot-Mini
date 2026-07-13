/**
 * Global Configuration for WhatsApp MD Bot
 */

module.exports = {
    // Bot Owner Configuration
    ownerNumber: ['255623647378'],
    ownerName: ['MR.IT MEDIATOR'],

    // Bot Configuration
    botName: 'MR.IT MEDIATOR',
    prefix: '!',
    sessionName: 'session',
    sessionID: process.env.SESSION_ID || '',
    newsletterJid: '',
    updateZipUrl: '',

    // Sticker Configuration
    packname: 'MR.IT MEDIATOR',

    // Bot Behavior
    selfMode: false,
    autoRead: false,
    autoTyping: false,
    autoReplyStatus: true,
    autoBio: false,
    autoSticker: false,
    autoReact: false,
    autoReactMode: 'bot',
    autoDownload: false,

    // Group Settings Defaults
    defaultGroupSettings: {
      antilink: false,
      antilinkAction: 'delete',
      antitag: false,
      antitagAction: 'delete',
      antiall: false,
      antiviewonce: false,
      antibot: false,
      anticall: false,
      antigroupmention: false,
      antigroupmentionAction: 'delete',
      antipromo: false,
      antipromoAction: 'warn',
      welcome: false,
      welcomeMessage: '╭╼━≪•𝙽𝙴𝚆 𝙼𝙴𝙼𝙱𝙴𝚁•≫━╾╮\n┃𝚆𝙴𝙻𝙲𝙾𝙼𝙴: @user 👋\n┃Member count: #memberCount\n┃𝚃𝙸𝙼𝙴: time⏰\n╰━━━━━━━━━━━━━━━╯\n\n*@user* Welcome to *@group*! 🎉\n\n> *ᴘᴏᴡᴇʀᴇᴅ ʙʏ MR. MEDIATOR*',
      goodbye: false,
      goodbyeMessage: 'Goodbye @user 👋 We will never miss you!',
      antiSpam: false,
      antidelete: false,
      nsfw: false,
      detect: false,
      chatbot: false,
      autosticker: false
    },

    // API Keys
    apiKeys: {
      openai: '',
      deepai: '',
      remove_bg: ''
    },

    // Message Configuration
    messages: {
      wait: '⏳ Please wait...',
      success: '✅ Success!',
      error: '❌ Error occurred!',
      ownerOnly: '👑 This command is only for bot owner!',
      adminOnly: '🛡️ This command is only for group admins!',
      groupOnly: '👥 This command can only be used in groups!',
      privateOnly: '💬 This command can only be used in private chat!',
      botAdminNeeded: '🤖 Bot needs to be admin to execute this command!',
      invalidCommand: '❓ Invalid command! Type .menu for help'
    },

    // Timezone
    timezone: 'Africa/Dar_es_Salaam',

    // Limits
    maxWarnings: 3,

    // Social Links
    social: {
      group: 'https://chat.whatsapp.com/LHMMYiaxQhdDLfIfOhF4CV',
      github: '',
      instagram: '',
      youtube: ''
    }
};
