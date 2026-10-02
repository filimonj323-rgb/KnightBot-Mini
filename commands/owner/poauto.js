/**
 * Pocket Option Auto-Trade — washa/zima na dhibiti auto-trading (owner tu).
 *
 *   .poauto                  -> hali ya sasa
 *   .poauto on               -> washa (akaunti REAL: .poauto on confirm)
 *   .poauto off              -> zima (trades zilizo wazi zinaendelea kufuatiliwa)
 *   .poauto stats            -> takwimu za auto-trades zilizofungwa
 *   .poauto stake 2          -> stake kwa kila trade (USD)
 *   .poauto strength 75      -> nguvu ya chini ya signal (50-100, default 70)
 *   .poauto tf 1m            -> timeframe = expiry (30s-5m)
 *   .poauto mode forex       -> forex | smart | otc | real | all
 *   .poauto max 2            -> trades wazi za juu kwa wakati mmoja
 *   .poauto maxloss 10       -> kikomo cha hasara ya siku (USD, UTC)
 *   .poauto losses 3         -> hasara mfululizo kabla ya cooldown
 *   .poauto cooldown 60      -> dakika za cooldown
 *   .poauto perday 30        -> trades za juu kwa siku
 *   .poauto exposure 1       -> net exposure ya currency moja (mfano USD)
 *   .poauto news on|off      -> kichujio cha habari kubwa
 *   .poauto backtest 55      -> backtest ya chini (%) — 0 = zima
 *   .poauto dry on|off       -> dry-run: ujumbe tu, hakuna trade
 */

const auto = require('../../utils/pocketAutoTrader');
const { tfLabel } = require('../../utils/pocketSignal');

const SETTING_KEYS = ['stake', 'strength', 'tf', 'mode', 'max', 'maxloss', 'losses', 'cooldown', 'perday', 'exposure', 'news', 'backtest', 'dry'];

const money = (n) => `${Number(n) < 0 ? '-' : ''}$${Math.abs(Number(n) || 0).toFixed(2)}`;

function until(ts) {
  if (!ts) return '—';
  const s = Math.max(0, Math.round((ts - Date.now()) / 1000));
  if (s < 60) return `sekunde ${s}`;
  const m = Math.round(s / 60);
  return m < 60 ? `dakika ${m}` : `saa ${Math.floor(m / 60)} dk ${m % 60}`;
}
function ago(ts) {
  if (!ts) return 'bado';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `sekunde ${s} zilizopita`;
  const m = Math.round(s / 60);
  return m < 60 ? `dakika ${m} zilizopita` : `saa ${Math.floor(m / 60)} zilizopita`;
}

function helpText() {
  return (
    `🤖 *Pocket Option Auto-Trade*\n\n` +
    `*.poauto on* — washa (REAL: *.poauto on confirm*)\n` +
    `*.poauto off* — zima\n` +
    `*.poauto* — hali ya sasa • *.poauto stats* — takwimu\n\n` +
    `*Mipangilio:*\n` +
    `• stake <USD> • strength <50-100> • tf <1m|5m|30s>\n` +
    `• mode <forex|smart|otc|real|all> • max <trades wazi>\n` +
    `• maxloss <USD/siku> • losses <n> • cooldown <dk>\n` +
    `• perday <n> • exposure <1-5> • news <on|off>\n` +
    `• backtest <%> • dry <on|off>\n\n` +
    `Mfano: *.poauto stake 2*\n_Anza na DEMO + *.poauto dry on* kuona signals bila kufungua trade._`
  );
}

function statusText(s) {
  const acct = !s.bridge || s.bridge.demo == null ? '❓ haijulikani bado' : s.bridge.demo ? '🧪 DEMO' : '💰 REAL';
  const lines = [];
  lines.push(`⎯⎯⎯ 『 *POCKET AUTO-TRADE* 』 ⎯⎯⎯`, '');
  lines.push(s.enabled ? `🟢 *ON*${s.dryRun ? ' — 🧪 DRY-RUN (hakuna trade halisi)' : ''}` : `🔴 *OFF*`);
  lines.push(`👤 Akaunti: ${acct}`);
  if (s.enabled) {
    lines.push(`🔁 Mzunguko ujao: ${until(s.nextCycleAt)} • wa mwisho: ${ago(s.lastCycleAt)}`);
  }
  lines.push('');
  lines.push(`⚙️ *Mipangilio*`);
  lines.push(`   • Timeframe/expiry: ${tfLabel(s.tf)} • Mode: ${s.mode}`);
  lines.push(`   • Nguvu ya chini: ≥${s.minStrength}% • Stake: $${s.stake}`);
  lines.push(`   • Backtest gate: ${s.minBacktest > 0 ? `≥${s.minBacktest}%` : 'OFF'} • News filter: ${s.newsFilter ? 'ON' : 'OFF'}`);
  lines.push('');
  lines.push(`🧯 *Circuit Breaker*`);
  lines.push(`   • P/L ya leo (UTC): ${s.dailyPnl >= 0 ? '✅ ' : '🔴 '}${money(s.dailyPnl)} (kikomo hasara: $${s.maxDailyLoss})`);
  lines.push(`   • Hasara mfululizo: ${s.consecutiveLosses}/${s.maxConsecLosses} • Trades leo: ${s.tradesToday}/${s.maxTradesPerDay}`);
  lines.push(`   • Trades wazi: ${s.openTrades.length}/${s.maxConcurrent} • Exposure max: ${s.maxCurrencyExposure}`);
  if (s.isPaused) {
    lines.push(`   • ⏸️ *IMESIMAMA* — ${auto.PAUSE_TEXT[s.pauseReason] || 'kwa muda'} (inaisha: ${until(s.pausedUntil)})`);
  }
  if (s.openTrades.length) {
    lines.push('', `📂 *Trades wazi*`);
    for (const t of s.openTrades) {
      lines.push(`   • ${t.direction === 'BUY' ? '🟢 UP' : '🔴 DOWN'} ${t.pair} $${t.stake}${t.strength ? ` (${t.strength}%)` : ''}`);
    }
  }
  const st = s.stats;
  lines.push('', `📈 Tangu bot ianze: mizunguko ${st.cycles} • signals strong ${st.signals} • zilizofunguliwa ${st.opened}` +
    `${st.dry ? ` • dry ${st.dry}` : ''} • zilizochelewa ${st.late} • zilizozuiwa ${st.blocked} • zilizoshindwa ${st.failed}`);
  if (s.lastSkipReason) lines.push(`ℹ️ Mwisho kurukwa: ${s.lastSkipReason}`);
  return lines.join('\n');
}

module.exports = {
  name: 'poauto',
  aliases: ['poautotrade', 'poat'],
  category: 'owner',
  description: 'Washa/zima na dhibiti auto-trading ya Pocket Option (signal strong -> trade kiotomatiki)',
  usage: '.poauto [on|off|stats|help|<setting> <thamani>]',
  ownerOnly: true,

  async execute(sock, msg, args, extra) {
    const reply = extra.reply;
    const action = String(args[0] || 'status').toLowerCase();

    if (action === 'help') return reply(helpText());
    if (action === 'status') return reply(statusText(auto.getStatus()));

    if (action === 'on') {
      const confirm = String(args[1] || '').toLowerCase() === 'confirm';
      const r = await auto.enable({ confirmReal: confirm });
      if (r.needsConfirm) {
        return reply(
          `⚠️ *Akaunti ni ${r.demo === false ? 'REAL (pesa halisi)' : 'isiyojulikani'}*\n\n` +
            `Auto-trade itafungua trade BILA kukuuliza kila mara. Binary option ina break-even ≈ 54% (payout 85%) — ` +
            `hakuna signal inayohakikisha faida, na unaweza kupoteza stake zote.\n\n` +
            `Pendekezo: jaribu DEMO + *.poauto dry on* kwanza.\n` +
            `Ukiamua kuendelea: *.poauto on confirm*`
        );
      }
      if (!r.ok) return reply(`❌ ${r.error}`);
      const s = auto.getStatus();
      return reply(
        `✅ *Auto-trade IMEWASHWA* — ${r.demo ? '🧪 DEMO' : '💰 REAL'}${s.dryRun ? ' (DRY-RUN)' : ''}\n\n` +
          `⏱️ ${tfLabel(s.tf)} • 💪 ≥${s.minStrength}% • 💵 $${s.stake} • mode ${s.mode}\n` +
          `🧯 Max wazi ${s.maxConcurrent} • hasara/siku $${s.maxDailyLoss} • cooldown baada ya hasara ${s.maxConsecLosses}\n\n` +
          `Mzunguko wa kwanza: ${until(r.nextCycleAt)} (candle ijayo).\n` +
          `_Mipangilio imehifadhiwa — bot ikirestart itaendelea. Zima: .poauto off_`
      );
    }

    if (action === 'off') {
      const r = await auto.disable();
      return reply(
        `🛑 *Auto-trade IMEZIMWA*` +
          (r.openTrades ? `\n\nTrades ${r.openTrades} zilizo wazi zitaendelea kufuatiliwa hadi matokeo.` : '')
      );
    }

    if (action === 'stats') {
      const st = await auto.getStats();
      if (!st) return reply('❌ Database haipatikani — siwezi kusoma takwimu.');
      if (!st.trades) return reply('ℹ️ Bado hakuna auto-trade iliyofungwa.');
      const rate = ((st.wins / st.trades) * 100).toFixed(1);
      return reply(
        `📊 *Takwimu za Auto-Trade* (trades ${st.trades} za mwisho)\n\n` +
          `✅ Wins: ${st.wins} • 🔴 Losses: ${st.losses}\n` +
          `🎯 Win rate: *${rate}%* (break-even ≈ 54% kwa payout 85%)\n` +
          `💵 P/L: ${money(st.pnl)}\n\n` +
          `_Sampuli ndogo (chini ya trades ~100) haithibitishi chochote — usitegemee win rate ya trades chache._`
      );
    }

    // Setting: ".poauto stake 2" au ".poauto set stake 2"
    const key = action === 'set' ? String(args[1] || '').toLowerCase() : action;
    const value = action === 'set' ? args[2] : args[1];
    if (SETTING_KEYS.includes(key)) {
      if (value === undefined) return reply(`❓ Tumia: *.poauto ${key} <thamani>* — angalia *.poauto help*`);
      const r = await auto.setSetting(key, value);
      if (!r.ok) return reply(`❌ ${r.error}`);
      const show = key === 'tf' ? tfLabel(r.value) : String(r.value);
      const prev = key === 'tf' ? tfLabel(r.previous) : String(r.previous);
      return reply(`✅ *${key}*: ${prev} → *${show}*\n_Inatumika kwa trades mpya; imehifadhiwa kwenye database._`);
    }

    return reply(helpText());
  },
};
