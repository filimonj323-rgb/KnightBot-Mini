/**
 * promoRejoin.js — mtu aliyetolewa kwa Antipromo anapumzishwa saa 24, kisha bot
 * inamrudisha kwenye group kiotomatiki.
 *
 * - Rekodi zinahifadhiwa kwenye database (Turso-backed) kwa hiyo zinaokoka redeploy.
 * - Timer moja kwa bot kuu (start) na moja kwa kila mteja wa pairing (startForOwner).
 */
const database = require('../database');
const style = require('./promoStyle');

const TICK_MS = 60 * 1000;          // angalia kila dakika
const RETRY_MS = 60 * 60 * 1000;    // jaribu tena kila saa ikishindwa
const MAX_TRIES = 6;

async function processEntry(sock, key, e) {
  const group = e.groupId;
  const jid = e.jid;
  const mention = [jid];
  const tag = `@${jid.split('@')[0]}`;
  let status = null;
  try {
    const meta = await sock.groupMetadata(group);
    const inGroup = (meta.participants || []).some((p) => p.id === jid || p.phoneNumber === jid);
    if (inGroup) { database.removePromoBan(key); return; }
    const r = await sock.groupParticipantsUpdate(group, [jid], 'add');
    status = String(r?.[0]?.status);
  } catch (err) {
    console.error(`[promoRejoin] add imeshindwa (${jid} @ ${group}):`, err.message);
    status = 'error';
  }

  if (status === '200' || status === '409') {
    database.removePromoBan(key);
    database.removeLeftMember && database.removeLeftMember(group, jid);
    if (status === '200') {
      try {
        await sock.sendMessage(group, { text: style.rejoinMessage(tag), mentions: mention });
      } catch (_) {}
    }
    return;
  }

  if (status === '403') {
    // Privacy hairuhusu kuongezwa moja kwa moja — mtumie invite link kwa DM.
    try {
      const code = await sock.groupInviteCode(group);
      await sock.sendMessage(jid, { text: style.inviteMessage(`https://chat.whatsapp.com/${code}`) });
    } catch (err) {
      console.error('[promoRejoin] imeshindwa kutuma invite link:', err.message);
    }
    database.removePromoBan(key);
    return;
  }

  // 408 (ameondoka hivi karibuni), 500, error nyingine → jaribu tena baadaye
  e.tries = (e.tries || 0) + 1;
  if (e.tries >= MAX_TRIES) { database.removePromoBan(key); return; }
  e.until = Date.now() + RETRY_MS;
  database.savePromoBan(key, e);
}

async function tick(getSock, owner) {
  let sock;
  try { sock = getSock(); } catch (_) { sock = null; }
  if (!sock) return;
  const due = database.getPromoBansDue(owner);
  for (const [key, e] of due) {
    await database.runWithOwnerScope(owner, () => processEntry(sock, key, e));
    await new Promise((r) => setTimeout(r, 2000));
  }
}

let mainTimer = null;
function start(getSock) {
  if (mainTimer) return;
  mainTimer = setInterval(() => tick(getSock, null).catch((e) => console.error('[promoRejoin]', e.message)), TICK_MS);
  if (mainTimer.unref) mainTimer.unref();
}

const ownerTimers = new Map();
function startForOwner(owner, getSock) {
  if (!owner || ownerTimers.has(owner)) return;
  const t = setInterval(() => tick(getSock, owner).catch((e) => console.error('[promoRejoin]', e.message)), TICK_MS);
  if (t.unref) t.unref();
  ownerTimers.set(owner, t);
}
function stopForOwner(owner) {
  const t = ownerTimers.get(owner);
  if (t) { clearInterval(t); ownerTimers.delete(owner); }
}

module.exports = { start, startForOwner, stopForOwner };
