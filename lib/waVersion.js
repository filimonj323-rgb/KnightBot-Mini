'use strict';
// Shared WA Web version resolver (inatumika na pairing/instanceManager.js na instanceManager.js).
// Sababu: fetchLatestBaileysVersion() peke yake inaweza kurudisha version ya zamani
// iliyobandikwa kwenye maktaba -> WhatsApp inakataa socket kwa 405 (everOpened=false).
// fetchLatestWaWebVersion() inasoma version ya LIVE kutoka web.whatsapp.com.
const TTL_MS = 30 * 60 * 1000; // dakika 30
let cached = null;
let cachedAt = 0;
let inflight = null;

function invalidateWaVersion() {
  cached = null;
  cachedAt = 0;
}

async function getWaVersion() {
  const now = Date.now();
  if (cached && now - cachedAt < TTL_MS) return cached;
  if (inflight) return inflight;

  inflight = (async () => {
    const b = global.__baileys || (await import('@itsliaaa/baileys'));
    try {
      const { version } = await b.fetchLatestWaWebVersion({});
      cached = version; cachedAt = Date.now();
      console.log(`📌 WA Web version (instances): ${version.join('.')} (live)`);
      return version;
    } catch (e1) {
      console.warn(`⚠️ fetchLatestWaWebVersion imeshindwa (${e1.message}) — najaribu fetchLatestBaileysVersion`);
      try {
        const { version } = await b.fetchLatestBaileysVersion();
        cached = version; cachedAt = Date.now() - (TTL_MS - 60 * 1000); // jaribu live tena baada ya dakika 1
        return version;
      } catch (e2) {
        console.error(`❌ Version fetch imeshindwa kabisa: ${e2.message}`);
        return cached || undefined; // makeWASocket itatumia default yake
      }
    }
  })().finally(() => { inflight = null; });
  return inflight;
}

module.exports = { getWaVersion, invalidateWaVersion };
