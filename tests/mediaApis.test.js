/* Jaribio la mediaApis (axios bandia). Run: node tests/mediaApis.test.js */
const assert = require('assert');
const path = require('path');
const axiosPath = (() => { try { return require.resolve('axios'); } catch (_) { return path.join(__dirname, '__axios_stub__.js'); } })();
const calls = [];
let script = [];
const fake = {
  get: async (u) => { calls.push(u); const r = script.shift(); if (r instanceof Error) throw r; return r; },
  head: async () => ({ status: 200 }),
};
require.cache[axiosPath] = { id: axiosPath, filename: axiosPath, loaded: true, exports: fake };
const Module = require('module'); const orig = Module._load;
Module._load = function (req, ...a) { return req === 'axios' ? fake : orig.call(this, req, ...a); };
const m = require('../utils/mediaApis');

(async () => {
  // 1) provider ya kwanza inashindwa (HTTP 500), ya pili inatoa link — inashinda
  script = [{ status: 500, data: '' }, { status: 200, data: { status: true, result: { title: 'Wimbo', thumbnail: 'https://x/t.jpg', download: 'https://cdn/v.mp4' } } }];
  let r = await m.resolveYouTubeVideo('https://youtu.be/abc');
  assert.strictEqual(r.download, 'https://cdn/v.mp4'); assert.strictEqual(r.title, 'Wimbo'); assert.strictEqual(r.source, 'Prince');
  // 2) thumbnail haichaguliwi kama video; hd inapendelewa kwa FB
  script = [{ status: 200, data: { result: { thumbnail: 'https://x/a.jpg', media: { video_sd: 'https://cdn/sd.mp4', video_hd: 'https://cdn/hd.mp4' } } } }];
  r = await m.resolveFacebook('https://fb.watch/xyz'); assert.strictEqual(r.download, 'https://cdn/hd.mp4');
  // 3) zote zinashindwa → kosa lenye sababu
  script = [new Error('timeout'), { status: 200, data: { success: false, message: 'limit' } }];
  await assert.rejects(() => m.knightTikTokDownload('https://vm.tiktok.com/x'), /providers zote zimeshindwa.*Prince: timeout.*Dreaded: limit/);
  // 4) link batili
  await assert.rejects(() => m.resolveYouTubeVideo('abc'), /Link si sahihi/);
  // 5) env providers zinajaribiwa kwanza
  process.env.MEDIA_YT_APIS = 'https://mine.example/yt?u={url}'; calls.length = 0;
  script = [{ status: 200, data: { url: 'https://cdn/m.mp4' } }];
  r = await m.resolveYouTubeVideo('https://youtu.be/abc'); assert(calls[0].startsWith('https://mine.example/yt?u=')); assert.strictEqual(r.source, 'Env1');
  console.log('✅ mediaApis: yote yamepita'); process.exit(0);
})().catch((e) => { console.error('❌', e); process.exit(1); });
