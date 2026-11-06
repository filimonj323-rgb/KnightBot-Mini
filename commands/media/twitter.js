/**
 * Twitter / X Downloader - Download videos, images or audio from X posts
 * Primary API: Elite, fallback: Prince. Self-contained (haigusi utils/api.js).
 */

const axios = require('axios');
const config = require('../../config');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Prevent duplicate processing
const processedMessages = new Set();

const TWITTER_PATTERNS = [
  /https?:\/\/(?:www\.)?(?:twitter|x)\.com\//i,
  /https?:\/\/(?:mobile\.)?twitter\.com\//i
];

function caption(quality) {
  const bot = (config.botName || 'Bot').toUpperCase();
  let text = `*DOWNLOADED BY ${bot}*`;
  if (quality) text += `\n\n📹 Quality: ${quality}`;
  return text;
}

function isMediaUrl(url) {
  return typeof url === 'string' && /^https?:\/\//i.test(url) && !/error|cannot be null/i.test(url);
}

async function getTwitterElite(url) {
  const { data } = await axios.get('https://eliteprotech-apis.zone.id/x', {
    params: { url },
    timeout: 30000,
    headers: { 'User-Agent': UA, Accept: 'application/json' }
  });
  if (data?.status !== 'success') throw new Error('Elite X API failed');
  const videos = (data.videos || []).filter((v) => isMediaUrl(v?.url));
  const mp3Url = isMediaUrl(data.mp3?.url) ? data.mp3.url : null;
  const thumbnail = isMediaUrl(data.thumbnail) ? data.thumbnail : null;
  if (!videos.length && !thumbnail && !mp3Url) throw new Error('No media in Elite response');
  return { videos, mp3Url, thumbnail };
}

async function getTwitterPrince(url) {
  const base = String(process.env.PRINCE_API_URL || 'https://api.princetechn.com').replace(/\/$/, '');
  const { data } = await axios.get(`${base}/api/download/twitter`, {
    params: { apikey: process.env.PRINCE_API_KEY || 'prince', url },
    timeout: 30000,
    headers: { 'User-Agent': UA, Accept: 'application/json' }
  });
  if (!data?.success) throw new Error('Prince Twitter API failed');
  const result = data.result || {};
  const videos = (result.videoUrls || []).filter((v) => isMediaUrl(v?.url));
  const thumbnail = isMediaUrl(result.thumbnail) ? result.thumbnail : null;
  if (!videos.length && !thumbnail) throw new Error('No media in Prince response');
  return { videos, mp3Url: null, thumbnail };
}

async function resolveMedia(url) {
  try {
    return await getTwitterElite(url);
  } catch (err) {
    console.log('[twitter] Elite failed:', err.message);
  }
  return getTwitterPrince(url);
}

function pickBestVideo(videos) {
  if (!videos?.length) return null;
  const scored = videos.map((v) => {
    const label = String(v.quality || v.label || '');
    const match = label.match(/(\d{3,4})p/i);
    return { url: v.url, quality: label || 'best', score: match ? parseInt(match[1], 10) : 0 };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0];
}

async function sendVideo(sock, chatId, msg, videoUrl, quality) {
  const cap = caption(quality);
  try {
    await sock.sendMessage(chatId, { video: { url: videoUrl }, mimetype: 'video/mp4', caption: cap }, { quoted: msg });
  } catch {
    const res = await axios.get(videoUrl, {
      responseType: 'arraybuffer',
      timeout: 60000,
      maxContentLength: 100 * 1024 * 1024,
      headers: { 'User-Agent': UA, Referer: 'https://x.com/' }
    });
    await sock.sendMessage(chatId, { video: Buffer.from(res.data), mimetype: 'video/mp4', caption: cap }, { quoted: msg });
  }
}

async function sendImage(sock, chatId, msg, imageUrl) {
  const cap = caption();
  try {
    await sock.sendMessage(chatId, { image: { url: imageUrl }, caption: cap }, { quoted: msg });
  } catch {
    const res = await axios.get(imageUrl, {
      responseType: 'arraybuffer',
      timeout: 30000,
      headers: { 'User-Agent': UA, Referer: 'https://x.com/' }
    });
    await sock.sendMessage(chatId, { image: Buffer.from(res.data), caption: cap }, { quoted: msg });
  }
}

async function sendAudio(sock, chatId, msg, audioUrl) {
  const cap = caption('128kbps MP3');
  try {
    await sock.sendMessage(chatId, { audio: { url: audioUrl }, mimetype: 'audio/mpeg' }, { quoted: msg });
  } catch {
    const res = await axios.get(audioUrl, {
      responseType: 'arraybuffer',
      timeout: 60000,
      maxContentLength: 50 * 1024 * 1024,
      headers: { 'User-Agent': UA }
    });
    await sock.sendMessage(chatId, {
      document: Buffer.from(res.data),
      mimetype: 'audio/mpeg',
      fileName: 'twitter_audio.mp3',
      caption: cap
    }, { quoted: msg });
  }
}

module.exports = {
  name: 'twitter',
  aliases: ['tw', 'x', 'twdl', 'xdl'],
  category: 'media',
  description: 'Download videos/images from Twitter (X) posts',
  usage: '.twitter <Twitter/X URL>',

  async execute(sock, msg, args, extra) {
    try {
      if (processedMessages.has(msg.key.id)) return;
      processedMessages.add(msg.key.id);
      setTimeout(() => processedMessages.delete(msg.key.id), 5 * 60 * 1000);

      const text = msg.message?.conversation ||
                   msg.message?.extendedTextMessage?.text ||
                   args.join(' ') || '';
      const urlMatch = text.match(/https?:\/\/[^\s]+/i);
      const url = urlMatch ? urlMatch[0] : '';

      if (!url) {
        return await extra.reply('Please provide a Twitter / X link.\nUsage: .twitter <url>');
      }
      if (!TWITTER_PATTERNS.some((p) => p.test(url))) {
        return await extra.reply('❌ Invalid link. Use an x.com or twitter.com post URL.');
      }

      await sock.sendMessage(extra.from, { react: { text: '🔄', key: msg.key } });

      const media = await resolveMedia(url);
      const best = pickBestVideo(media.videos);

      if (best) return await sendVideo(sock, extra.from, msg, best.url, best.quality);
      if (media.thumbnail) return await sendImage(sock, extra.from, msg, media.thumbnail);
      if (media.mp3Url) return await sendAudio(sock, extra.from, msg, media.mp3Url);

      await extra.reply('❌ No downloadable media found for this post.');
    } catch (error) {
      console.error('[twitter]', error?.message || error);
      await extra.reply('❌ Failed to download from Twitter / X. Try another link.');
    }
  }
};
