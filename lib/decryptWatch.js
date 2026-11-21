/**
 * decryptWatch.js — kufuatilia "bot imeunganishwa lakini haijibu" inayosababishwa na ujumbe kushindwa kufunguliwa (decrypt).
 *
 * Dalili: WhatsApp inaonyesha bot "connected", ujumbe unafika (notify) lakini bila yaliyomo (stub CIPHERTEXT / Bad MAC /
 * No session) — kwa hiyo handler hauoni command yoyote. Kufuta funguo za Signal "session"/"sender-key" (si creds) kunaruhusu
 * WhatsApp kuanzisha upya session za mazungumzo (retry receipt) bila kui-unlink bot.
 *
 * Kanuni (kihafidhina): "jiponye" TU ikiwa ndani ya `windowMs` kumetokea angalau `minFails` kushindwa NA hakuna ujumbe
 * hata mmoja uliosomeka vizuri, na `cooldownMs` imepita tangu uponyaji wa mwisho.
 */
function createDecryptWatch({ windowMs = 10 * 60 * 1000, minFails = 8, cooldownMs = 6 * 60 * 60 * 1000 } = {}) {
  let fails = [];
  let oks = [];
  let lastHealAt = 0;
  const prune = (now) => {
    fails = fails.filter((t) => now - t <= windowMs);
    oks = oks.filter((t) => now - t <= windowMs);
  };
  return {
    fail(now = Date.now()) { fails.push(now); prune(now); },
    ok(now = Date.now()) { oks.push(now); prune(now); },
    counts(now = Date.now()) { prune(now); return { fails: fails.length, oks: oks.length }; },
    shouldHeal(now = Date.now()) {
      prune(now);
      return fails.length >= minFails && oks.length === 0 && now - lastHealAt >= cooldownMs;
    },
    healed(now = Date.now()) { lastHealAt = now; fails = []; oks = []; },
  };
}

/** Ujumbe wa "notify" usio na yaliyomo kwa sababu ya kushindwa kufunguliwa (si status/receipt/protocol za kawaida). */
function isUndecryptable(msg) {
  if (!msg || msg.message) return false;
  if (msg.key && msg.key.remoteJid === 'status@broadcast') return false;
  const st = msg.messageStubType;
  return st === 2 || st === 'CIPHERTEXT';
}

module.exports = { createDecryptWatch, isUndecryptable };
