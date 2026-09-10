/**
 * Anti-ViewOnce Command - Enable or disable automatic view-once reveal
 * (controls the same config.autoViewOnce flag read by handler.js's
 * handleAutoViewOnce() — see config.js's autoViewOnce comment).
 */

module.exports = {
  name: 'antivv',
  aliases: ['avv'],
  category: 'owner',
  ownerOnly: true,
  description: 'Washa/zima automatic view-once reveal',
  usage: '.antivv on/off',

  async execute(sock, msg, args, extra) {
    const fs = require('fs');
    const path = require('path');
    const configPath = path.join(__dirname, '../../config.js');

    const sub = (args[0] || '').toLowerCase();
    let enabled;

    if (sub === 'on') {
      enabled = true;
    } else if (sub === 'off') {
      enabled = false;
    } else if (!sub) {
      // Hakuna hoja → geuza hali ya sasa
      const config = require('../../config');
      enabled = !config.autoViewOnce;
    } else {
      return extra.reply('Matumizi: .antivv on/off');
    }

    try {
      let configFile = fs.readFileSync(configPath, 'utf8');

      if (enabled) {
        configFile = configFile.replace(/autoViewOnce:\s*(true|false)/, 'autoViewOnce: true');
      } else {
        configFile = configFile.replace(/autoViewOnce:\s*(true|false)/, 'autoViewOnce: false');
      }

      fs.writeFileSync(configPath, configFile);

      // Safisha cache ili require ijayo ipate config mpya
      delete require.cache[require.resolve('../../config')];

      await extra.react(enabled ? '👁️' : '🙈');
      await extra.reply(
        enabled
          ? '✅ *Anti-ViewOnce IMEWASHWA*\n\n👁️ Ujumbe wote wa view-once utafunuliwa kiotomatiki na kutumwa kwa owner.'
          : '❌ *Anti-ViewOnce IMEZIMWA*\n\n🙈 Automatic view-once reveal imezimwa.'
      );
    } catch (err) {
      console.error('[antivv cmd] error:', err);
      extra.reply('❌ Hitilafu wakati wa kubadilisha mpangilio wa antivv.');
    }
  }
};
