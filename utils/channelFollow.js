/**
 * Channel Follow: bot (kuu au ya mteja) inajifuatisha yenyewe kwenye WhatsApp Channel
 * iliyowekwa kwenye config.newsletterInvite (code ya link) au config.newsletterJid ('120363...@newsletter').
 *
 * - newsletterJid na newsletterInvite zikiwa tupu => haifanyi chochote (salama kuwa kwenye code kabla channel haijatengenezwa).
 * - Inajaribu MARA MOJA kwa kila akaunti kwa kila channel: ikifanikiwa inahifadhi 'channelFollowedJid'
 *   kwenye botsettings (owner-scoped), hivyo reconnect hazirudii.
 * - Ikishindwa haihifadhi, kwa hiyo itajaribu tena bot itakapofunguka mara nyingine.
 * - Haina swichi kwenye dashboard: ili kuzima, acha newsletterJid na newsletterInvite tupu.
 */

const database = require('../database');
const config = require('../config');

const FOLLOW_DELAY_MS = 15 * 1000; // subiri connection itulie kabla ya kufuata

const inFlight = new Set();

// Pata jid: newsletterJid ikiwepo tumia hiyo; la sivyo tafuta kutoka newsletterInvite (code ya link)
async function resolveJid(sock) {
  const direct = String(config.newsletterJid || '').trim();
  if (direct.endsWith('@newsletter')) return direct;
  const code = String(config.newsletterInvite || '').trim().split('?')[0].split('/').filter(Boolean).pop();
  if (!code) return null;
  if (resolvedCache.has(code)) return resolvedCache.get(code);
  if (typeof sock.newsletterMetadata !== 'function') return null;
  const meta = await sock.newsletterMetadata('invite', code);
  const jid = meta && meta.id;
  if (!jid || !String(jid).endsWith('@newsletter')) throw new Error('Channel haikupatikana kwa invite code hii');
  resolvedCache.set(code, jid);
  return jid;
}
const resolvedCache = new Map();

async function ensureFollowing(sock, owner = null) {
  if (!String(config.newsletterJid || '').trim() && !String(config.newsletterInvite || '').trim()) return { skipped: true };
  if (!sock || typeof sock.newsletterFollow !== 'function') return { skipped: true, reason: 'newsletterFollow haipo kwenye toleo hili la Baileys' };

  const lock = `${owner || '__main__'}`;
  if (inFlight.has(lock)) return { skipped: true };
  inFlight.add(lock);

  const scoped = (fn) => (owner ? database.runWithOwnerScope(owner, fn) : fn());
  let jid = null;
  try {
    jid = await resolveJid(sock);
    if (!jid) return { skipped: true };
    if (scoped(() => database.getBotSettings().channelFollowedJid) === jid) return { skipped: true, already: true };

    await sock.newsletterFollow(jid);
    scoped(() => database.updateBotSettings({ channelFollowedJid: jid }));
    console.log(`[channelFollow${owner ? ':' + owner : ''}] ✅ imefuata channel ${jid}`);
    return { ok: true };
  } catch (e) {
    const msg = String((e && e.message) || e);
    // "already following" => hesabu kama imefanikiwa ili tusijaribu tena
    if (jid && /already|subscribed/i.test(msg)) {
      try { scoped(() => database.updateBotSettings({ channelFollowedJid: jid })); } catch {}
      return { ok: true, already: true };
    }
    console.error(`[channelFollow${owner ? ':' + owner : ''}] imeshindwa: ${msg}`);
    return { ok: false, msg };
  } finally {
    inFlight.delete(lock);
  }
}

// Ratiba ya kuchelewa kidogo baada ya connection kufunguka (haizuii startup)
function schedule(sock, owner = null) {
  const t = setTimeout(() => { ensureFollowing(sock, owner).catch(() => {}); }, FOLLOW_DELAY_MS);
  if (t.unref) t.unref();
}

module.exports = { ensureFollowing, schedule };
