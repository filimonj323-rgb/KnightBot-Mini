/**
 * Set Prefix Command - Change bot command prefix
 */

const config = require('../../config');
const fs = require('fs');
const path = require('path');

module.exports = {
  name: 'setprefix',
  aliases: ['prefix'],
  category: 'owner',
  description: 'Change bot command prefix',
  usage: '.setprefix <new prefix>',
  ownerOnly: true,

  async execute(sock, msg, args, extra) {
    try {
      // Current prefix for THIS bot only: a paired customer's own
      // sock.instanceSettings.prefix if they've set one, else the shared
      // default from config.js. Never read config.prefix alone here, or a
      // paired customer would be shown (and would be editing) the main
      // bot's prefix instead of their own.
      const currentPrefix = (sock.instanceSettings && sock.instanceSettings.prefix) || config.prefix;

      if (args.length === 0) {
        return extra.reply(`📌 Current prefix: ${currentPrefix}\n\nUsage: .setprefix <new prefix>`);
      }

      const newPrefix = args[0];

      if (newPrefix.length > 3) {
        return extra.reply('❌ Prefix must be 1-3 characters long!');
      }

      if (sock.pairingOwnerId) {
        // A paired customer's bot — persist and apply the change to THIS
        // instance only (its own DB row + sock.instanceSettings). Must
        // NEVER touch the shared `config` object or config.js: that object
        // is a single Node module-cache singleton reused as the base for
        // EVERY instance's effectiveConfig, so mutating it here would
        // silently change the prefix for the main bot and every other
        // paired customer that hasn't set their own override.
        const { setPrefixForOwnInstance } = require('../../pairing/instanceManager');
        await setPrefixForOwnInstance(sock.pairingOwnerId, newPrefix);
      } else {
        // The main bot — only one process-wide instance of it exists, so
        // updating the shared config (in memory + on disk, for persistence
        // across restarts) only ever affects the main bot itself. Any
        // paired customer with their own explicit prefix is unaffected
        // because their sock.instanceSettings.prefix takes precedence over
        // this shared value in effectiveConfig.
        config.prefix = newPrefix;

        const configPath = path.join(__dirname, '../../config.js');
        let configContent = fs.readFileSync(configPath, 'utf-8');
        configContent = configContent.replace(/prefix: '.*'/, `prefix: '${newPrefix}'`);
        fs.writeFileSync(configPath, configContent);
      }

      await extra.reply(`✅ Prefix changed to: ${newPrefix}\n\nNew command format: ${newPrefix}command`);

    } catch (error) {
      await extra.reply(`❌ Error: ${error.message}`);
    }
  }
};
