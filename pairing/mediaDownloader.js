/**
 * pairing/mediaDownloader.js
 *
 * Powers the dashboard's "Pakua MP3/MP4" section:
 *   1. previewMedia()  -> user types a song/video name OR pastes a YouTube
 *      link, this returns title/thumbnail/duration WITHOUT downloading
 *      anything yet (cheap — just a yt-search lookup).
 *   2. resolveDownload() -> called only when the user actually presses
 *      "Pakua" — resolves a real, direct download URL by trying several
 *      free APIs in order (same providers already used by
 *      commands/media/song.js and commands/media/video.js), so nothing is
 *      duplicated: it just reuses ./utils/api.js.
 *
 * Standalone — does not touch index.js / the main bot.
 */

const yts = require('yt-search');
const axios = require('axios');
const APIs = require('../utils/api');

function extractVideoId(input) {
  const patterns = [
    /(?:youtube\.com\/watch\?v=)([^&\s]{11})/,
    /(?:youtu\.be\/)([^?\s]{11})/,
    /(?:youtube\.com\/shorts\/)([^?\s]{11})/,
  ];
  for (const p of patterns) {
    const m = String(input).match(p);
    if (m) return m[1];
  }
  return null;
}

function isYouTubeUrl(input) {
  return /youtube\.com|youtu\.be/i.test(String(input));
}

/**
 * Resolves a user-typed name or a pasted YouTube link into preview info
 * (title, thumbnail, duration, canonical url) without downloading anything.
 */
async function previewMedia(rawInput) {
  const input = String(rawInput || '').trim();
  if (!input) throw new Error('Andika jina la wimbo/video au bandika link ya YouTube.');

  const videoId = extractVideoId(input);

  if (videoId) {
    const info = await yts({ videoId });
    if (!info) throw new Error('Video haikupatikana. Hakikisha link ni sahihi.');
    return {
      title: info.title,
      url: `https://www.youtube.com/watch?v=${videoId}`,
      videoId,
      thumbnail: info.thumbnail || `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
      duration: info.timestamp || info.seconds || '',
      author: info.author?.name || '',
    };
  }

  if (isYouTubeUrl(input)) {
    throw new Error('Link ya YouTube si sahihi.');
  }

  const search = await yts(input);
  if (!search?.videos?.length) {
    throw new Error('Haikupatikana. Jaribu jina tofauti.');
  }
  const v = search.videos[0];
  const vid = extractVideoId(v.url) || v.videoId;
  return {
    title: v.title,
    url: v.url,
    videoId: vid,
    thumbnail: v.thumbnail,
    duration: v.timestamp || '',
    author: v.author?.name || '',
  };
}

/**
 * Quickly checks that a resolved download URL actually responds before we
 * hand it to the browser — without downloading the whole file. Tries a
 * HEAD request first; some CDNs block HEAD, so falls back to a tiny ranged
 * GET (first 2 bytes only) if HEAD fails. This is what lets us safely
 * 302-redirect the browser straight to the source (full download speed,
 * original quality — no proxying through our own server) while still
 * falling back to the next provider if a link turns out to be dead.
 */
async function verifyLink(url) {
  const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' };
  try {
    const res = await axios.head(url, { timeout: 8000, headers, maxRedirects: 5, validateStatus: s => s >= 200 && s < 400 });
    return res.status >= 200 && res.status < 400;
  } catch (e) {
    try {
      const res = await axios.get(url, {
        timeout: 8000,
        headers: { ...headers, Range: 'bytes=0-1' },
        maxRedirects: 5,
        responseType: 'arraybuffer',
        validateStatus: s => s >= 200 && s < 400,
      });
      return res.status >= 200 && res.status < 400;
    } catch (e2) {
      return false;
    }
  }
}

/**
 * Tries each free provider in turn until one returns a working direct
 * download URL, VERIFYING each candidate link actually responds before
 * returning it. Same fallback philosophy as commands/media/song.js /
 * video.js, but returns a verified direct URL instead of buffering +
 * sending via WhatsApp — pairing/server.js 302-redirects the browser
 * straight to it for maximum download speed and unaltered quality.
 */
async function resolveDownload(youtubeUrl, type) {
  if (!youtubeUrl) throw new Error('URL ya video haipo.');

  const audioProviders = [
    () => APIs.getIzumiDownloadByUrl(youtubeUrl),
    () => APIs.getYupraDownloadByUrl(youtubeUrl),
    () => APIs.getOkatsuDownloadByUrl(youtubeUrl),
    () => APIs.getEliteProTechDownloadByUrl(youtubeUrl),
  ];
  const videoProviders = [
    () => APIs.getEliteProTechVideoByUrl(youtubeUrl),
    () => APIs.getYupraVideoByUrl(youtubeUrl),
    () => APIs.getOkatsuVideoByUrl(youtubeUrl),
  ];

  const providers = type === 'mp4' ? videoProviders : audioProviders;

  let lastErr;
  for (const provider of providers) {
    try {
      const result = await provider();
      if (result?.download && await verifyLink(result.download)) {
        return result;
      }
    } catch (e) {
      lastErr = e;
    }
  }

  throw new Error(
    (lastErr && lastErr.message) ||
    'Imeshindwa kupata link ya kupakua. Jaribu tena baadaye au chagua wimbo/video mwingine.'
  );
}

module.exports = {
  extractVideoId,
  isYouTubeUrl,
  previewMedia,
  resolveDownload,
};
