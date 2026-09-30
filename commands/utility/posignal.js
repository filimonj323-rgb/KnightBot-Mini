/**
 * Pocket Option — Signal Command.
 *
 *   .posignal EURUSD            -> signal ya EURUSD (timeframe 1m)
 *   .posignal EURUSD 5m         -> signal ya EURUSD kwenye 5m
 *   .posignal scan [tf]         -> changanua jozi zote za default, onyesha zenye nguvu
 *   .posignal auto on [tf] [minStrength]  -> (owner) tuma signals kiotomatiki kwenye chat hii
 *   .posignal auto off | status
 *
 * Wikendi jozi za kawaida hazifanyi kazi — "_otc" inaongezwa kiotomatiki.
 */

const { isBridgeUp } = require('../../utils/pocketOptionTrader');
const {
  DEFAULT_PAIRS,
  parseTimeframe,
  tfLabel,
  analyzePair,
  scanPairs,
  formatSignal,
  formatScan,
} = require('../../utils/pocketSignal');

// jid -> { timer, tf, minStrength, sent:Set }
const autoJobs = new Map();
const MAX_SENT_CACHE = 200;

function msUntilNextCandle(tfSec) {
  const tfMs = tfSec * 1000;
  // +3s ili candle iwe imefungwa kabisa kwenye server ya Pocket Option
  return tfMs - (Date.now() % tfMs) + 3000;
}

function stopAuto(jid) {
  const job = autoJobs.get(jid);
  if (!job) return false;
  clearTimeout(job.timer);
  autoJobs.delete(jid);
  return true;
}

function scheduleAuto(sock, jid, job) {
  job.timer = setTimeout(async () => {
    if (!autoJobs.has(jid)) return;
    try {
      if (await isBridgeUp()) {
        const { results } = await scanPairs(DEFAULT_PAIRS, job.tf, { minStrength: job.minStrength });
        for (const r of results) {
          if (r.direction === 'NEUTRAL' || r.strength < job.minStrength) continue;
          const key = `${r.pair}|${r.direction}|${r.candleTime}`;
          if (job.sent.has(key)) continue;
          job.sent.add(key);
          if (job.sent.size > MAX_SENT_CACHE) job.sent.delete(job.sent.values().next().value);
          await sock.sendMessage(jid, { text: formatSignal(r) });
        }
      }
    } catch (err) {
      console.error('[posignal auto] error:', err.message);
    } finally {
      if (autoJobs.has(jid)) scheduleAuto(sock, jid, job);
    }
  }, msUntilNextCandle(job.tf));
}

async function handleAuto(sock, jid, args, extra) {
  if (!extra.isOwner) return extra.reply('⛔ Auto-signal ni ya owner tu.');
  const action = (args[0] || 'status').toLowerCase();

  if (action === 'off') {
    return extra.reply(stopAuto(jid) ? '🛑 Auto-signal imezimwa kwenye chat hii.' : 'ℹ️ Auto-signal haikuwa imewashwa hapa.');
  }

  if (action === 'status') {
    const job = autoJobs.get(jid);
    return extra.reply(
      job
        ? `✅ Auto-signal IMEWASHWA — timeframe ${tfLabel(job.tf)}, nguvu ya chini ${job.minStrength}%`
        : 'ℹ️ Auto-signal imezimwa. Washa: *.posignal auto on 1m 70*'
    );
  }

  if (action === 'on') {
    const tf = parseTimeframe(args[1], 60);
    if (!tf) return extra.reply('❌ Timeframe si sahihi. Mfano: 1m, 5m, 30s.');
    const minStrength = Math.min(100, Math.max(30, parseInt(args[2], 10) || 70));
    stopAuto(jid);
    const job = { tf, minStrength, sent: new Set(), timer: null };
    autoJobs.set(jid, job);
    scheduleAuto(sock, jid, job);
    return extra.reply(
      `✅ *Auto-signal imewashwa*\n` +
        `⏱️ Timeframe: ${tfLabel(tf)}\n` +
        `💪 Nguvu ya chini: ${minStrength}%\n` +
        `💱 Jozi: ${DEFAULT_PAIRS.join(', ')}\n\n` +
        `_Itachanganua kila candle ikifungwa. Zima: .posignal auto off_\n` +
        `_Kumbuka: ikiwa bot itarestart, lazima uiwashe tena._`
    );
  }

  return extra.reply('❓ Tumia: .posignal auto on|off|status');
}

module.exports = {
  name: 'posignal',
  aliases: ['posig', 'posignals'],
  category: 'utility',
  description: 'Signals za Pocket Option (UP/DOWN) kwa kutumia candles za Pocket Option + backtest',
  usage:
    '.posignal <JOZI> [tf]  — mfano: .posignal EURUSD 1m\n' +
    '.posignal scan [tf]\n' +
    '.posignal auto on|off|status (owner)',

  async execute(sock, msg, args, extra) {
    const jid = msg.key.remoteJid;
    const reply = extra?.reply || ((text) => sock.sendMessage(jid, { text }, { quoted: msg }));
    const ex = { ...extra, reply };

    if (!args[0]) {
      return reply(
        `❓ *Matumizi:*\n` +
          `• .posignal EURUSD — signal ya jozi moja\n` +
          `• .posignal EURUSD 5m — timeframe 5 dakika\n` +
          `• .posignal scan — changanua jozi zote\n` +
          `• .posignal auto on 1m 70 — (owner) signals kiotomatiki`
      );
    }

    if (args[0].toLowerCase() === 'auto') return handleAuto(sock, jid, args.slice(1), ex);

    if (!(await isBridgeUp())) {
      return reply('❌ Pocket Option bridge haijaunganishwa kwa sasa. Angalia logs za bot / SSID.');
    }

    try {
      if (args[0].toLowerCase() === 'scan') {
        const tf = parseTimeframe(args[1], 60);
        if (!tf) return reply('❌ Timeframe si sahihi. Mfano: 1m, 5m.');
        await reply(`🔎 Nachanganua jozi ${DEFAULT_PAIRS.length} (${tfLabel(tf)})...`);
        const scan = await scanPairs(DEFAULT_PAIRS, tf);
        return reply(formatScan(scan, tf));
      }

      const tf = parseTimeframe(args[1], 60);
      if (!tf) return reply('❌ Timeframe si sahihi. Mfano: 1m, 5m, 30s.');
      const result = await analyzePair(args[0], tf);
      return reply(formatSignal(result));
    } catch (err) {
      console.error('posignal error:', err.message);
      return reply(`❌ Imeshindwa kupata signal: ${err.message}`);
    }
  },
};
