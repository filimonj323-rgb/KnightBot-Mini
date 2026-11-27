/**
 * mediaApis.js — njia za API za mtu wa tatu za kupakua media (YouTube video, Facebook, TikTok).
 *
 * Inatumiwa na: commands/media/video.js, facebook.js, tiktok.js
 *   resolveYouTubeVideo(url) → { download, title, source }
 *   resolveFacebook(url)     → { download, title, source }
 *   knightTikTokDownload(url)→ { download, title, source }
 *
 * Mfumo: kila kazi ina orodha ya providers. Zinajaribiwa moja baada ya nyingine (timeout fupi). Ya kwanza inayorudisha
 * link halali ya video inashinda; zikishindwa zote, kosa moja linarudi likionyesha kila provider ilishindwa kwa nini
 * (ili caller aendelee na njia zake za zamani).
 *
 * ⚠️ Endpoints za providers ni za huduma za bure za watu wengine — zinaweza kubadilika/kufa wakati wowote. Hazikujaribiwa
 * wakati faili hili linaandikwa. Ukitaka kuongeza/kubadilisha bila kuhariri code, tumia env (templates zenye {url},
 * zinatenganishwa kwa "|"):
 *   MEDIA_YT_APIS, MEDIA_FB_APIS, MEDIA_TT_APIS   — hizi zinajaribiwa KWANZA, kabla ya za msingi.
 * Mfano: MEDIA_YT_APIS="https://mimi.example/yt?link={url}|https://nyingine.example/dl?u={url}"
 */
const axios = require('axios');

const TIMEOUT_MS = Number(process.env.MEDIA_API_TIMEOUT_MS || 25000);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// ── Providers za msingi (template {url} inabadilishwa na link iliyosimbwa) ───────────────
const YT_PROVIDERS = [
  { name: 'Izumi', tpl: 'https://izumiiiiiiii.dpdns.org/downloader/youtube?url={url}&format=720' },
  { name: 'Prince', tpl: 'https://api.princetechn.com/api/download/ytmp4?apikey=prince&url={url}' },
  { name: 'Hector', tpl: 'https://yt-dl.officialhectormanuel.workers.dev/?url={url}' },
  { name: 'Okatsu', tpl: 'https://okatsu-rolezapiiz.vercel.app/downloader/ytmp4?url={url}' },
];
const FB_PROVIDERS = [
  { name: 'Prince', tpl: 'https://api.princetechn.com/api/download/facebook?apikey=prince&url={url}' },
  { name: 'Hanggts', tpl: 'https://api.hanggts.xyz/download/facebook?url={url}' },
];
const TT_PROVIDERS = [
  { name: 'Prince', tpl: 'https://api.princetechn.com/api/download/tiktok?apikey=prince&url={url}' },
  { name: 'Dreaded', tpl: 'https://api.dreaded.site/api/tiktok?url={url}' },
];

function withEnv(envName, base) {
  const extra = String(process.env[envName] || '').split('|').map((s) => s.trim()).filter((s) => /^https?:\/\/.+\{url\}/i.test(s))
    .map((tpl, i) => ({ name: `Env${i + 1}`, tpl }));
  return [...extra, ...base];
}

// ── Utilities za kusoma majibu ya JSON yenye maumbo tofauti ──────────────────────────────
const BAD_KEY = /thumb|cover|image|img|poster|avatar|music|audio|icon|preview|logo|author|profile/i;
const IMG_EXT = /\.(jpe?g|png|webp|gif|svg)(\?|$)/i;
const GOOD_KEY_RANK = [/hd/i, /^download(url)?$/i, /mp4/i, /video/i, /download/i, /^url$/i, /link/i, /sd/i];
const isHttp = (s) => typeof s === 'string' && /^https?:\/\/\S+$/i.test(s.trim());

/** Pita ndani ya JSON yote, kusanya (key, url) za video zinazowezekana, kisha chagua bora kwa cheo cha jina la key. */
function pickVideoUrl(data) {
  const found = [];
  const walk = (node, key, depth) => {
    if (depth > 6 || node == null) return;
    if (typeof node === 'string') {
      if (isHttp(node) && !BAD_KEY.test(key || '') && !IMG_EXT.test(node)) found.push({ key: key || '', url: node.trim() });
      return;
    }
    if (Array.isArray(node)) { node.forEach((v) => walk(v, key, depth + 1)); return; }
    if (typeof node === 'object') for (const [k, v] of Object.entries(node)) walk(v, k, depth + 1);
  };
  walk(data, '', 0);
  if (!found.length) return null;
  for (const re of GOOD_KEY_RANK) { const hit = found.find((f) => re.test(f.key)); if (hit) return hit.url; }
  return found[0].url;
}

function pickTitle(data) {
  let title = '';
  const walk = (node, depth) => {
    if (title || depth > 5 || node == null || typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node)) {
      if (typeof v === 'string' && /^(title|name|caption|desc(ription)?)$/i.test(k) && v.trim() && !isHttp(v)) { title = v.trim().slice(0, 200); return; }
    }
    for (const v of Object.values(node)) walk(v, depth + 1);
  };
  walk(data, 0);
  return title;
}

async function callProvider(p, url) {
  const endpoint = p.tpl.replace('{url}', encodeURIComponent(url));
  const res = await axios.get(endpoint, { timeout: TIMEOUT_MS, headers: { 'User-Agent': UA, Accept: 'application/json' }, validateStatus: () => true });
  if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}`);
  let data = res.data;
  if (typeof data === 'string') { try { data = JSON.parse(data); } catch (_) { throw new Error('jibu si JSON'); } }
  if (data && (data.success === false || data.status === false || data.error) && !pickVideoUrl(data)) {
    throw new Error(String(data.message || data.error || 'API imekataa').slice(0, 120));
  }
  const download = pickVideoUrl(data);
  if (!download) throw new Error('hakuna link ya video kwenye jibu');
  // Link iliyokufa (404/410) haifai — tuliza provider hii na tuendelee. Makosa mengine ya HEAD (405, timeout) tunayapuuza.
  try {
    const h = await axios.head(download, { timeout: 8000, headers: { 'User-Agent': UA }, validateStatus: () => true, maxRedirects: 5 });
    if (h.status === 404 || h.status === 410) throw new Error(`link ya video imekufa (HTTP ${h.status})`);
  } catch (e) { if (/imekufa/.test(e.message)) throw e; }
  return { download, title: pickTitle(data), source: p.name };
}

async function resolveWith(providers, url, label) {
  if (!isHttp(url)) throw new Error('Link si sahihi');
  const errors = [];
  for (const p of providers) {
    try { return await callProvider(p, url); }
    catch (e) { errors.push(`${p.name}: ${e && e.message ? e.message : e}`); }
  }
  throw new Error(`${label} — providers zote zimeshindwa (${errors.join('; ')})`);
}

const resolveYouTubeVideo = (url) => resolveWith(withEnv('MEDIA_YT_APIS', YT_PROVIDERS), url, 'YouTube');
const resolveFacebook = (url) => resolveWith(withEnv('MEDIA_FB_APIS', FB_PROVIDERS), url, 'Facebook');
const knightTikTokDownload = (url) => resolveWith(withEnv('MEDIA_TT_APIS', TT_PROVIDERS), url, 'TikTok');

module.exports = { resolveYouTubeVideo, resolveFacebook, knightTikTokDownload, _pickVideoUrl: pickVideoUrl, _pickTitle: pickTitle };
