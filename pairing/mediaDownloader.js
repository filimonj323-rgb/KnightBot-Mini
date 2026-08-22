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
 * Tries each free provider in turn until one returns a working direct
 * download URL. Same fallback philosophy as commands/media/song.js /
 * video.js, just returning the URL instead of buffering + sending via
 * WhatsApp — the dashboard streams it straight to the browser.
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
      if (result?.download) return result;
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
