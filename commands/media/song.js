/**
 * Song Downloader - Download audio from YouTube
 * Multiple fallback methods
 */

const yts = require('yt-search');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { toAudio } = require('../../utils/converter');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY || '6302dd380amsh9115a6be5092cf2p1ca0e9jsn757c120ac58a';

function extractVideoId(url) {
  const patterns = [
    /(?:youtube\.com\/watch\?v=)([^&\s]{11})/,
    /(?:youtu\.be\/)([^?\s]{11})/,
    /(?:youtube\.com\/shorts\/)([^?\s]{11})/,
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}

async function fetchBuffer(url, extraHeaders = {}) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': '*/*',
    'Accept-Encoding': 'identity',
    ...extraHeaders
  };
  try {
    const r = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 90000,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      validateStatus: s => s >= 200 && s < 400,
      headers
    });
    const buf = Buffer.from(r.data);
    if (buf.length > 100) return buf;
  } catch (e) {}

  // Stream fallback
  const r2 = await axios.get(url, {
    responseType: 'stream',
    timeout: 90000,
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
    validateStatus: s => s >= 200 && s < 400,
    headers
  });
  const chunks = [];
  await new Promise((resolve, reject) => {
    r2.data.on('data', c => chunks.push(c));
    r2.data.on('end', resolve);
    r2.data.on('error', reject);
  });
  const buf = Buffer.concat(chunks);
  if (buf.length > 100) return buf;
  return null;
}

module.exports = {
  name: 'song',
  aliases: ['play', 'music', 'yta'],
  category: 'media',
  description: 'Download audio from YouTube',
  usage: '.song <song name or YouTube link>',

  async execute(sock, msg, args) {
    try {
      const text = args.join(' ');
      const chatId = msg.key.remoteJid;

      if (!text) {
        return await sock.sendMessage(chatId, {
          text: 'Usage: .song <song name or YouTube link>'
        }, { quoted: msg });
      }

      let video;
      if (text.includes('youtube.com') || text.includes('youtu.be')) {
        video = { url: text, title: text, timestamp: '' };
      } else {
        const search = await yts(text);
        if (!search?.videos?.length) {
          return await sock.sendMessage(chatId, { text: '❌ No results found.' }, { quoted: msg });
        }
        video = search.videos[0];
      }

      const videoId = extractVideoId(video.url);
      if (!videoId) {
        return await sock.sendMessage(chatId, { text: '❌ Invalid YouTube URL.' }, { quoted: msg });
      }
      const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

      await sock.sendMessage(chatId, {
        image: { url: video.thumbnail || `https://img.youtube.com/vi/${videoId}/hqdefault.jpg` },
        caption: `🎵 Downloading: *${video.title}*\n⏱ Duration: ${video.timestamp || ''}`
      }, { quoted: msg });

      let audioBuffer = null;
      let downloadSuccess = false;

      // ══════════════════════════════════════════════
      // METHOD 1: wasitech / ytdl-core (from package.json)
      // Direct stream from YouTube - reliable
      // ══════════════════════════════════════════════
      async function downloadWithYtdl() {
        const ytdl = require('wasitech');
        const chunks = [];
        await new Promise((resolve, reject) => {
          const stream = ytdl(videoUrl, {
            filter: 'audioonly',
            quality: 'highestaudio',
            requestOptions: {
              headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
              }
            }
          });
          stream.on('data', chunk => chunks.push(chunk));
          stream.on('end', resolve);
          stream.on('error', reject);
          setTimeout(() => reject(new Error('ytdl timeout')), 120000);
        });
        const buf = Buffer.concat(chunks);
        if (!buf || buf.length < 1000) throw new Error(`Too small: ${buf?.length} bytes`);
        return buf;
      }

      // ══════════════════════════════════════════════
      // METHOD 2: gifted-dls (from package.json)
      // Free YouTube downloader package
      // ══════════════════════════════════════════════
      async function downloadWithGiftedDls() {
        const { ytmp3 } = require('gifted-dls');
        const result = await ytmp3(videoUrl);
        if (!result?.url && !result?.download) throw new Error('No URL from gifted-dls');
        const dlUrl = result.url || result.download || result.link;
        const buf = await fetchBuffer(dlUrl);
        if (!buf || buf.length < 1000) throw new Error(`Too small: ${buf?.length} bytes`);
        return buf;
      }

      // ══════════════════════════════════════════════
      // METHOD 3: yt-dlp via API (y2mate)
      // ══════════════════════════════════════════════
      async function downloadWithY2Mate() {
        const res1 = await axios.post(
          'https://www.y2mate.com/mates/analyzeV2/ajax',
          new URLSearchParams({ k_query: videoUrl, k_page: 'home', hl: 'en', q_auto: '0' }),
          {
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            },
            timeout: 30000
          }
        );
        const vid = res1.data?.vid;
        if (!vid) throw new Error('No vid from y2mate analyze');

        const res2 = await axios.post(
          'https://www.y2mate.com/mates/convertV2/index',
          new URLSearchParams({ vid, k: res1.data?.links?.mp3?.mp3128?.k || '', ftype: 'mp3', fquality: '128' }),
          {
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              'User-Agent': 'Mozilla/5.0'
            },
            timeout: 30000
          }
        );
        const dlUrl = res2.data?.dlink;
        if (!dlUrl) throw new Error('No dlink from y2mate convert');
        const buf = await fetchBuffer(dlUrl);
        if (!buf || buf.length < 1000) throw new Error(`Too small: ${buf?.length} bytes`);
        return buf;
      }

      // ══════════════════════════════════════════════
      // METHOD 4: OceanSaver (Free)
      // ══════════════════════════════════════════════
      async function downloadWithOceanSaver() {
        const res = await axios.get(
          `https://p.oceansaver.in/ajax/download.php?format=mp3&url=${encodeURIComponent(videoUrl)}&api=dfcb6d76f2f6a9894gjkege8a4ab232222`,
          { timeout: 30000 }
        );
        if (!res.data?.dlink) throw new Error('No link from oceansaver');
        const buf = await fetchBuffer(res.data.dlink);
        if (!buf || buf.length < 1000) throw new Error('Too small from oceansaver');
        return buf;
      }

      // ══════════════════════════════════════════════
      // METHOD 5: cobalt.tools (Free)
      // ══════════════════════════════════════════════
      async function downloadWithCobalt() {
        const res = await axios.post(
          'https://cobalt.api.timelessnesses.me/api/json',
          { url: videoUrl, aFormat: 'mp3', isAudioOnly: true },
          {
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            timeout: 30000
          }
        );
        const dlUrl = res.data?.url;
        if (!dlUrl) throw new Error('No URL from cobalt');
        const buf = await fetchBuffer(dlUrl);
        if (!buf || buf.length < 1000) throw new Error('Too small from cobalt');
        return buf;
      }

      // ══════════════════════════════════════════════
      // METHOD 6: youtube-mp36 RapidAPI (with polling)
      // ══════════════════════════════════════════════
      async function downloadWithMP36Direct() {
        const res = await axios.get('https://youtube-mp36.p.rapidapi.com/dl', {
          params: { id: videoId },
          headers: {
            'x-rapidapi-key': RAPIDAPI_KEY,
            'x-rapidapi-host': 'youtube-mp36.p.rapidapi.com'
          },
          timeout: 30000
        });

        let dlUrl = res.data?.link;

        if (!dlUrl && res.data?.status === 'processing') {
          for (let i = 0; i < 8; i++) {
            await new Promise(r => setTimeout(r, 5000));
            const poll = await axios.get('https://youtube-mp36.p.rapidapi.com/dl', {
              params: { id: videoId },
              headers: {
                'x-rapidapi-key': RAPIDAPI_KEY,
                'x-rapidapi-host': 'youtube-mp36.p.rapidapi.com'
              },
              timeout: 30000
            });
            if (poll.data?.link) { dlUrl = poll.data.link; break; }
          }
        }

        if (!dlUrl) throw new Error('No link from MP36');
        const buf = await fetchBuffer(dlUrl);
        if (!buf || buf.length < 1000) throw new Error(`Too small: ${buf?.length} bytes`);
        return buf;
      }

      // ══════════════════════════════════════════════
      // METHOD 7: vevioz (Free)
      // ══════════════════════════════════════════════
      async function downloadWithVevioz() {
        const res = await axios.get(
          `https://api.vevioz.com/ytdown?url=${encodeURIComponent(videoUrl)}&type=audio`,
          { timeout: 30000 }
        );
        if (!res.data?.download_url) throw new Error('No URL from vevioz');
        const buf = await fetchBuffer(res.data.download_url);
        if (!buf || buf.length < 1000) throw new Error('Too small from vevioz');
        return buf;
      }

      // ══════════════════════════════════════════════
      // METHOD 8: api-dylux (from package.json)
      // ══════════════════════════════════════════════
      async function downloadWithApiDylux() {
        const api = require('api-dylux');
        const result = await api.ytmp3(videoUrl);
        if (!result?.url && !result?.download) throw new Error('No URL from api-dylux');
        const dlUrl = result.url || result.download || result.link;
        const buf = await fetchBuffer(dlUrl);
        if (!buf || buf.length < 1000) throw new Error(`Too small: ${buf?.length} bytes`);
        return buf;
      }

      // ══════════════════════════════════════════════
      // FALLBACK CHAIN
      // ══════════════════════════════════════════════
      const downloadMethods = [
        { name: 'wasitech/ytdl-core', fn: downloadWithYtdl },
        { name: 'gifted-dls', fn: downloadWithGiftedDls },
        { name: 'api-dylux', fn: downloadWithApiDylux },
        { name: 'Y2Mate', fn: downloadWithY2Mate },
        { name: 'OceanSaver API', fn: downloadWithOceanSaver },
        { name: 'Cobalt.tools', fn: downloadWithCobalt },
        { name: 'youtube-mp36 (RapidAPI)', fn: downloadWithMP36Direct },
        { name: 'Vevioz API', fn: downloadWithVevioz },
      ];

      for (const method of downloadMethods) {
        try {
          console.log(`Trying: ${method.name}`);
          audioBuffer = await method.fn();
          if (audioBuffer?.length > 1000) {
            downloadSuccess = true;
            console.log(`✅ Success: ${method.name} (${audioBuffer.length} bytes)`);
            break;
          }
        } catch (err) {
          console.log(`❌ ${method.name} failed:`, err.message);
        }
      }

      if (!downloadSuccess || !audioBuffer) {
        throw new Error('All download sources failed. The content may be unavailable or blocked in your region.');
      }

      // ══════════════════════════════════════════════
      // Detect format
      // ══════════════════════════════════════════════
      const firstBytes = audioBuffer.slice(0, 12);
      const hexSignature = firstBytes.toString('hex');
      const asciiSignature = firstBytes.toString('ascii', 4, 8);

      let fileExtension = 'mp3';
      let finalMimetype = 'audio/mpeg';
      let detectedFormat = 'MP3';

      if (asciiSignature === 'ftyp' || hexSignature.startsWith('000000')) {
        const ftypBox = audioBuffer.slice(4, 8).toString('ascii');
        if (ftypBox === 'ftyp') {
          detectedFormat = 'M4A/MP4';
          finalMimetype = 'audio/mp4';
          fileExtension = 'm4a';
        }
      } else if (
        audioBuffer.toString('ascii', 0, 3) === 'ID3' ||
        (audioBuffer[0] === 0xFF && (audioBuffer[1] & 0xE0) === 0xE0)
      ) {
        detectedFormat = 'MP3';
        finalMimetype = 'audio/mpeg';
        fileExtension = 'mp3';
      } else if (audioBuffer.toString('ascii', 0, 4) === 'OggS') {
        detectedFormat = 'OGG';
        finalMimetype = 'audio/ogg; codecs=opus';
        fileExtension = 'ogg';
      } else if (audioBuffer.toString('ascii', 0, 4) === 'RIFF') {
        detectedFormat = 'WAV';
        finalMimetype = 'audio/wav';
        fileExtension = 'wav';
      } else {
        // Unknown - assume M4A na convert
        detectedFormat = 'M4A';
        finalMimetype = 'audio/mp4';
        fileExtension = 'm4a';
      }

      console.log(`Detected format: ${detectedFormat} (${audioBuffer.length} bytes)`);

      // ══════════════════════════════════════════════
      // Convert to MP3 kama si MP3
      // ══════════════════════════════════════════════
      let finalBuffer = audioBuffer;
      let finalExtension = 'mp3';

      if (fileExtension !== 'mp3') {
        try {
          finalBuffer = await toAudio(audioBuffer, fileExtension);
          if (!finalBuffer || finalBuffer.length === 0) {
            throw new Error('Conversion returned empty buffer');
          }
          finalMimetype = 'audio/mpeg';
          finalExtension = 'mp3';
          console.log(`Converted ${detectedFormat} → MP3 (${finalBuffer.length} bytes)`);
        } catch (convErr) {
          throw new Error(`Failed to convert ${detectedFormat} to MP3: ${convErr.message}`);
        }
      }

      // ══════════════════════════════════════════════
      // Tuma audio
      // ══════════════════════════════════════════════
      await sock.sendMessage(chatId, {
        audio: finalBuffer,
        mimetype: finalMimetype,
        fileName: `${(video.title || 'song').replace(/[^\w\s-]/g, '')}.${finalExtension}`,
        ptt: false
      }, { quoted: msg });

      // Cleanup
      try {
        const tempDir = path.join(__dirname, '../../temp');
        if (fs.existsSync(tempDir)) {
          const files = fs.readdirSync(tempDir);
          const now = Date.now();
          files.forEach(file => {
            const filePath = path.join(tempDir, file);
            try {
              const stats = fs.statSync(filePath);
              if (now - stats.mtimeMs > 10000) {
                if (file.endsWith('.mp3') || file.endsWith('.m4a') || /^\d+\.(mp3|m4a)$/.test(file)) {
                  fs.unlinkSync(filePath);
                }
              }
            } catch (e) {}
          });
        }
      } catch (cleanupErr) {}

    } catch (err) {
      console.error('Song command error:', err);
      let errorMessage = '❌ Failed to download song.';
      if (err.message?.includes('blocked')) {
        errorMessage = '❌ Download blocked. The content may be unavailable in your region or due to legal restrictions.';
      } else if (err.response?.status === 451 || err.status === 451) {
        errorMessage = '❌ Content unavailable (451). This may be due to legal restrictions or regional blocking.';
      } else if (err.message?.includes('All download sources failed')) {
        errorMessage = '❌ All download sources failed. The content may be unavailable or blocked.';
      }
      await sock.sendMessage(msg.key.remoteJid, { text: errorMessage }, { quoted: msg });
    }
  }
};
