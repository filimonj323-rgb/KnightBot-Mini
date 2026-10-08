/**
 * Ruhusa ya commands za Forex/Trading kwa PAIRING BOTS — OWNER WA BOT KUU TU.
 *
 *   .fxaccess                    -> hali + orodha ya walioruhusiwa
 *   .fxaccess grant 2557XXXXXXXX -> mruhusu mteja mmoja
 *   .fxaccess revoke 2557XXXXXXXX-> mnyime tena
 *   .fxaccess grant all          -> waruhusu WOTE
 *   .fxaccess revoke all         -> ondoa ruhusa ya "wote" (waliopewa mmoja mmoja wanabaki)
 *   .fxaccess check 2557XXXXXXXX -> angalia namba moja
 *   .fxaccess commands           -> orodha ya commands zinazofungwa
 *
 * Ruhusa hii inafungua *forex signals* tu (.forex, .eurusd, ...). Commands za TRADING/akaunti (kufungua/kufunga
 * order, auto-trade, balance, positions, Pocket Option...) zimefungwa KABISA kwa pairing bots — ruhusa haizifungui.
 * Bot kuu haiathiriwi.
 */

const access = require('../../utils/forexAccess');

const fmt = (ms) => new Date(ms + 3 * 3600000).toISOString().slice(0, 16).replace('T', ' ');

module.exports = {
  name: 'fxaccess',
  aliases: ['forexaccess', 'fxruhusa'],
  category: 'owner',
  description: 'Toa/ondoa ruhusa ya commands za forex kwa pairing bots',
  usage: '.fxaccess [grant|revoke|check <namba|all>] | .fxaccess commands',
  ownerOnly: true,

  async execute(sock, msg, args, extra) {
    const reply = extra.reply;
    // Pairing bot ya mteja haiwezi kujipa/kutoa ruhusa.
    if (sock?.pairingOwnerId) return reply('🔒 Command hii ni ya *bot kuu* pekee.');

    const sub = String(args[0] || 'status').toLowerCase();
    const target = String(args[1] || '').toLowerCase();

    if (sub === 'commands') {
      const fmtList = (set) => [...set].map((x) => '.' + x).join(' ');
      return reply(
        `✅ *Zinafunguliwa kwa ruhusa (signals tu)*\n${fmtList(access.SIGNAL_ONLY)}\n\n` +
          `⛔ *Zimefungwa kabisa kwa pairing bots (trading/akaunti)*\n${fmtList(access.ACCOUNT_BOUND)}\n\n` +
          `_Hadi kila pairing bot iwe na akaunti yake ya trading._`
      );
    }

    if (sub === 'grant' || sub === 'revoke') {
      if (!target) return reply(`❓ Tumia: *.fxaccess ${sub} 2557XXXXXXXX* au *.fxaccess ${sub} all*`);
      if (target === 'all') {
        const r = sub === 'grant' ? await access.grantAll() : await access.revokeAll();
        if (!r.ok) return reply(`❌ ${r.error}`);
        return reply(sub === 'grant'
          ? '✅ Pairing bots *ZOTE* sasa zinaruhusiwa *forex signals*. Commands za trading zinabaki zimefungwa.\n_Zima: .fxaccess revoke all_'
          : '🔒 Ruhusa ya "wote" imeondolewa. Walioruhusiwa mmoja mmoja wanabaki (angalia *.fxaccess*).');
      }
      const r = sub === 'grant' ? await access.grant(target) : await access.revoke(target);
      if (!r.ok) return reply(`❌ ${r.error}`);
      return reply(sub === 'grant'
        ? `✅ *${r.phone}* ameruhusiwa *forex signals* (inatumika mara moja). Commands za trading zinabaki zimefungwa.`
        : (r.removed ? `🔒 *${r.phone}* amenyimwa tena forex signals.` : `ℹ️ *${r.phone}* hakuwa kwenye orodha ya walioruhusiwa.`));
    }

    if (sub === 'check') {
      if (!target) return reply('❓ Tumia: *.fxaccess check 2557XXXXXXXX*');
      return reply((await access.isAllowed(target)) ? `✅ ${access.normPhone(target)} anaruhusiwa.` : `🔒 ${access.normPhone(target)} amefungwa.`);
    }

    // status
    const l = await access.list();
    if (!l.ok) return reply(`❌ ${l.error}`);
    const lines = [
      `💹 *Ruhusa ya Forex Signals kwa Pairing Bots*`,
      `_(Commands za trading zimefungwa kabisa kwa pairing bots)_`,
      ``,
      l.all ? `🟢 Wote wameruhusiwa (*.fxaccess revoke all* kuzima)` : `🔒 Pairing bots zimefungwa (default)`,
      `👥 Walioruhusiwa mmoja mmoja: *${l.grants.length}*`,
    ];
    l.grants.slice(0, 40).forEach((g) => lines.push(`• ${g.phoneNumber} — ${fmt(g.grantedAt)}`));
    if (l.grants.length > 40) lines.push(`… na ${l.grants.length - 40} wengine`);
    lines.push('', '_.fxaccess grant <namba> • revoke <namba> • grant all • revoke all • commands_');
    return reply(lines.join('\n'));
  },
};
