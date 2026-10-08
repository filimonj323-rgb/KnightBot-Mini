/**
 * Pocket Option — Futa historia ya trades (reset ya rekodi). OWNER WA BOT KUU TU.
 *
 *   .podelete all                  -> futa trades zote zilizofungwa
 *   .podelete last 50              -> futa trades 50 za mwisho (mpya zaidi)
 *   .podelete first 50             -> futa trades 50 za kwanza (za zamani zaidi)
 *   .podelete range 10-50          -> futa nafasi 10 hadi 50 (1 = mpya zaidi)
 *   .podelete date 2026-10-01      -> futa trades za siku hiyo (saa za EAT)
 *   .podelete date 2026-10-01 2026-10-05  -> futa kuanzia tarehe hadi tarehe
 *   .podelete date today|yesterday
 *   Ongeza neno `signals` kufuta pia rekodi za signals (all/date tu): .podelete all signals
 *   .podelete confirm              -> thibitisha (ndani ya dakika 2 baada ya onyesho la awali)
 *   .podelete cancel               -> ghairi
 *
 * Hufuta kutoka database (Turso), kwa hiyo win rate, P/L na takwimu zote (dashboard, .poauto stats,
 * AI uchambuzi) zinahesabiwa upya kutoka trades zilizobaki. Trades ZILIZO WAZI hazifutwi kamwe.
 */

const store = require('../../utils/pocketStore');
const auto = require('../../utils/pocketAutoTrader');

const PENDING_MS = 2 * 60 * 1000;
const pending = new Map(); // sender -> { opts, count, at }

const money = (n) => `${Number(n) < 0 ? '-' : '+'}$${Math.abs(Number(n) || 0).toFixed(2)}`;
const fmtDay = (ms) => (ms ? new Date(ms + store.TZ_OFFSET_H * 3600000).toISOString().slice(0, 16).replace('T', ' ') : '—');

// Tarehe ya leo/jana kwa saa za EAT (YYYY-MM-DD)
function eatDay(daysAgo = 0) {
  return new Date(Date.now() + store.TZ_OFFSET_H * 3600000 - daysAgo * 86400000).toISOString().slice(0, 10);
}

function helpText() {
  return (
    `🗑️ *Futa Historia ya Pocket Option* (owner wa bot kuu tu)\n\n` +
    `*.podelete all* — trades zote zilizofungwa\n` +
    `*.podelete last 50* — 50 za mwisho\n` +
    `*.podelete first 50* — 50 za kwanza\n` +
    `*.podelete range 10-50* — nafasi 10 hadi 50 (1 = mpya zaidi)\n` +
    `*.podelete date 2026-10-01* — siku moja\n` +
    `*.podelete date 2026-10-01 2026-10-05* — kuanzia hadi tarehe\n` +
    `*.podelete date today* / *yesterday*\n\n` +
    `Ongeza *signals* kufuta pia rekodi za signals (all/date tu), mfano: *.podelete all signals*\n\n` +
    `Utaona onyesho la awali kwanza, kisha thibitisha kwa *.podelete confirm* (ndani ya dakika 2).\n` +
    `ℹ️ Trades zilizo wazi hazifutwi. Kufuta ni PERMANENT kwenye database — win rate na P/L vinaanza upya kutoka zilizobaki.`
  );
}

function parseArgs(args) {
  const a = args.map((x) => String(x || '').toLowerCase()).filter(Boolean);
  const includeSignals = a.includes('signals') || a.includes('signal');
  const rest = a.filter((x) => x !== 'signals' && x !== 'signal');
  const mode = rest[0];
  if (mode === 'all') return { opts: { mode: 'all', includeSignals } };
  if (mode === 'last' || mode === 'first') {
    return { opts: { mode, count: rest[1], includeSignals: false } };
  }
  if (mode === 'range') {
    const m = /^(\d+)\s*[-–:]\s*(\d+)$/.exec(rest.slice(1).join(''));
    if (!m) return { error: 'Range si sahihi. Mfano: *.podelete range 10-50*' };
    return { opts: { mode: 'range', from: m[1], to: m[2], includeSignals: false } };
  }
  if (mode === 'date') {
    const norm = (v) => (v === 'today' || v === 'leo' ? eatDay(0) : v === 'yesterday' || v === 'jana' ? eatDay(1) : v);
    const from = norm(rest[1]);
    const to = rest[2] ? norm(rest[2]) : undefined;
    if (!from) return { error: 'Taja tarehe. Mfano: *.podelete date 2026-10-01*' };
    return { opts: { mode: 'date', from, to, includeSignals } };
  }
  return { error: null };
}

module.exports = {
  name: 'podelete',
  aliases: ['pofuta', 'pohistorydelete', 'poreset'],
  category: 'owner',
  description: 'Futa historia ya trades za Pocket Option (zote, kwa tarehe, idadi au range) na uanze rekodi mpya',
  usage: '.podelete <all|last N|first N|range A-B|date YYYY-MM-DD [mwisho]> [signals] • .podelete confirm',
  ownerOnly: true,

  async execute(sock, msg, args, extra) {
    const reply = extra.reply;

    // Database ya trades ni MOJA kwa bot nzima — mteja wa pairing hapaswi kuifuta kamwe.
    if (sock?.pairingOwnerId) {
      return reply('🔒 Command hii ni ya *bot kuu* pekee — haipatikani kwenye pairing bots.');
    }

    const who = String(extra.sender || msg?.key?.participant || msg?.key?.remoteJid || 'owner');
    const first = String(args[0] || '').toLowerCase();

    if (!first || first === 'help') return reply(helpText());

    if (first === 'cancel') {
      const had = pending.delete(who);
      return reply(had ? '❎ Kufuta kumeghairiwa. Hakuna kilichofutwa.' : 'ℹ️ Hakuna ombi la kufuta linalosubiri.');
    }

    if (first === 'confirm') {
      const p = pending.get(who);
      if (!p || Date.now() - p.at > PENDING_MS) {
        pending.delete(who);
        return reply('⌛ Hakuna ombi linalosubiri (au muda umeisha). Anza tena, mfano: *.podelete all*');
      }
      pending.delete(who);

      // Thibitisha kuwa kinachofutwa bado ni kile kile ulichoonyeshwa.
      const now = await store.previewDeleteTrades(p.opts);
      if (!now.ok) return reply(`❌ ${now.error}`);
      if (now.count !== p.count) {
        return reply(`⚠️ Data imebadilika tangu onyesho la awali (ilikuwa trades ${p.count}, sasa ${now.count}). Hakuna kilichofutwa — anza tena.`);
      }

      const r = await store.deleteTrades(p.opts);
      if (!r.ok) return reply(`❌ Imeshindwa kufuta: ${r.error}`);

      let risk = null;
      try { risk = await auto.resyncRiskState(); } catch (_) { /* bot inaweza kuwa bado haijaanza */ }

      const lines = [
        `✅ *Historia imefutwa kwenye database*`,
        ``,
        `🗑️ ${r.label}: *${r.deleted}* (✅ ${r.wins} win • 🔴 ${r.losses} loss • P/L ${money(r.net)})`,
      ];
      if (r.signalsDeleted != null) lines.push(`📡 Signals zilizofutwa: ${r.signalsDeleted}`);
      if (r.signalsError) lines.push(`⚠️ Signals hazikufutwa: ${r.signalsError}`);
      if (now.openProtected) lines.push(`⏳ Trades ${now.openProtected} zilizo wazi hazikuguswa — zikifungwa zitaingia kwenye rekodi mpya.`);
      if (risk && risk.ok) {
        lines.push(``, `📊 Hali ya auto-trade (leo, UTC): P/L ${money(risk.dailyPnl)} • trades ${risk.tradesToday} • hasara mfululizo ${risk.consecutiveLosses}`);
        if (risk.resumed) lines.push(`▶️ Pause ya hasara imeondolewa kwa kuwa kikomo hakijafikiwa tena.`);
        else if (risk.stillPaused) lines.push(`⏸️ Auto-trade bado imesimama (pause haihusiani na historia iliyofutwa).`);
      }
      lines.push(``, `_Win rate, P/L na takwimu za dashboard / .poauto stats zinaanza upya kutoka trades zilizobaki. Angalia: .poauto stats_`);
      return reply(lines.join('\n'));
    }

    const parsed = parseArgs(args);
    if (parsed.error === null) return reply(helpText());
    if (parsed.error) return reply(`❌ ${parsed.error}`);

    const pv = await store.previewDeleteTrades(parsed.opts);
    if (!pv.ok) return reply(`❌ ${pv.error}`);
    if (!pv.count) {
      return reply(`ℹ️ Hakuna trades zilizofungwa zinazolingana (${pv.label}).${pv.openProtected ? `\nTrades ${pv.openProtected} zilizo wazi hazifutwi.` : ''}`);
    }

    pending.set(who, { opts: parsed.opts, count: pv.count, at: Date.now() });
    const wr = pv.wins + pv.losses ? ((pv.wins / (pv.wins + pv.losses)) * 100).toFixed(1) : '—';
    return reply(
      `⚠️ *Utafuta ${pv.label}*\n\n` +
        `🗑️ Trades: *${pv.count}* (kati ya ${pv.totalInDb} kwenye database)\n` +
        `✅ ${pv.wins} win • 🔴 ${pv.losses} loss • win rate ${wr}${wr === '—' ? '' : '%'} • P/L ${money(pv.net)}\n` +
        `📅 ${fmtDay(pv.oldest)} → ${fmtDay(pv.newest)} (EAT)\n` +
        (parsed.opts.includeSignals && (parsed.opts.mode === 'all' || parsed.opts.mode === 'date') ? `📡 Rekodi za signals zitafutwa pia.\n` : '') +
        (pv.openProtected ? `⏳ Trades ${pv.openProtected} zilizo wazi hazitafutwa.\n` : '') +
        `\n*Hii ni PERMANENT kwenye database.*\n` +
        `Thibitisha: *.podelete confirm* (dakika 2) • Ghairi: *.podelete cancel*`
    );
  },
};
