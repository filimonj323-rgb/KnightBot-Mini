/**
 * Song Downloader - Download audio from YouTube
 * Updated with multiple fallback methods
 */

const yts = require('yt-search');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const ytdl = require('@distube/ytdl-core');
const { toAudio } = require('../../utils/converter');

// Optional: ffmpeg for conversion (already used by toAudio)
const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const AXIOS_DEFAULTS = {
  timeout: 60000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*'
  }
};

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
        video = { url: text };
      } else {
        const search = await yts(text);
        if (!search || !search.videos.length) {
          return await sock.sendMessage(chatId, { 
            text: 'No results found.' 
          }, { quoted: msg });
        }
        video = search.videos[0];
      }
      
      // Inform user
      await sock.sendMessage(chatId, {
        image: { url: video.thumbnail },
        caption: `🎵 Downloading: *${video.title}*\n⏱ Duration: ${video.timestamp}`
      }, { quoted: msg });
      
      // --------------------- MULTIPLE DOWNLOAD METHODS (FALLBACK CHAIN) ---------------------
      let audioBuffer = null;
      let downloadSuccess = false;
      
      // Method 1: @distube/ytdl-core (highest audio quality)
      async function downloadWithYtdl() {
        return new Promise(async (resolve, reject) => {
          try {
            const stream = ytdl(video.url, {
              quality: 'highestaudio',
              filter: 'audioonly',
              requestOptions: {
                headers: {
                  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                  'Accept-Language': 'en-US,en;q=0.9',
                }
              }
            });
            const chunks = [];
            stream.on('data', chunk => chunks.push(chunk));
            stream.on('end', () => resolve(Buffer.concat(chunks)));
            stream.on('error', reject);
          } catch (err) {
            reject(err);
          }
        });
      }
      
      // Method 2: ytdl-core with different quality (lowest audio but more compatible)
      async function downloadWithYtdlLow() {
        return new Promise(async (resolve, reject) => {
          try {
            const stream = ytdl(video.url, {
              quality: 'lowestaudio',
              filter: 'audioonly',
              requestOptions: {
                headers: {
                  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                }
              }
            });
            const chunks = [];
            stream.on('data', chunk => chunks.push(chunk));
            stream.on('end', () => resolve(Buffer.concat(chunks)));
            stream.on('error', reject);
          } catch (err) {
            reject(err);
          }
        });
      }
      
      // Method 3: Public API (vevioz - free YouTube audio downloader)
      async function downloadWithPublicAPI() {
        const apiUrl = `https://api.vevioz.com/ytdown?url=${encodeURIComponent(video.url)}&type=audio`;
        const response = await axios.get(apiUrl, { timeout: 30000 });
        if (!response.data || !response.data.download_url) throw new Error('No download URL from API');
        const audioResponse = await axios.get(response.data.download_url, {
          responseType: 'arraybuffer',
          timeout: 60000
        });
        return Buffer.from(audioResponse.data);
      }
      
      // Method 4: Using y2mate style (alternative API)
      async function downloadWithY2mateStyle() {
        // Extract video ID
        const videoId = ytdl.getVideoID(video.url);
        const api = `https://p.oceansaver.in/ajax/download.php?format=mp3&url=https://www.youtube.com/watch?v=${videoId}&api=dfcb6d76f2f6a9894gjkege8a4ab232222`;
        const resp = await axios.get(api);
        if (!resp.data || !resp.data.dlink) throw new Error('No download link');
        const audioResp = await axios.get(resp.data.dlink, { responseType: 'arraybuffer' });
        return Buffer.from(audioResp.data);
      }
      
      // List of download methods (in order of preference)
      const downloadMethods = [
        { name: 'ytdl-core (high quality)', fn: downloadWithYtdl },
        { name: 'ytdl-core (low quality)', fn: downloadWithYtdlLow },
        { name: 'Public API (vevioz)', fn: downloadWithPublicAPI },
        { name: 'Y2mate style API', fn: downloadWithY2mateStyle }
      ];
      
      for (const method of downloadMethods) {
        try {
          console.log(`Trying download method: ${method.name}`);
          audioBuffer = await method.fn();
          if (audioBuffer && audioBuffer.length > 0) {
            downloadSuccess = true;
            console.log(`Success with method: ${method.name}`);
            break;
          }
        } catch (err) {
          console.log(`Method ${method.name} failed:`, err.message);
        }
      }
      
      if (!downloadSuccess || !audioBuffer) {
        throw new Error('All download methods failed. Video may be unavailable or blocked.');
      }
      
      // Validate buffer
      if (!audioBuffer || audioBuffer.length === 0) {
        throw new Error('Downloaded audio buffer is empty');
      }
      
      // Detect actual file format from signature (keep original detection logic)
      const firstBytes = audioBuffer.slice(0, 12);
      const hexSignature = firstBytes.toString('hex');
      const asciiSignature = firstBytes.toString('ascii', 4, 8);
      
      let actualMimetype = 'audio/mpeg';
      let fileExtension = 'mp3';
      let detectedFormat = 'unknown';
      
      if (asciiSignature === 'ftyp' || hexSignature.startsWith('000000')) {
        const ftypBox = audioBuffer.slice(4, 8).toString('ascii');
        if (ftypBox === 'ftyp') {
          detectedFormat = 'M4A/MP4';
          actualMimetype = 'audio/mp4';
          fileExtension = 'm4a';
        }
      }
      else if (audioBuffer.toString('ascii', 0, 3) === 'ID3' || 
               (audioBuffer[0] === 0xFF && (audioBuffer[1] & 0xE0) === 0xE0)) {
        detectedFormat = 'MP3';
        actualMimetype = 'audio/mpeg';
        fileExtension = 'mp3';
      }
      else if (audioBuffer.toString('ascii', 0, 4) === 'OggS') {
        detectedFormat = 'OGG/Opus';
        actualMimetype = 'audio/ogg; codecs=opus';
        fileExtension = 'ogg';
      }
      else if (audioBuffer.toString('ascii', 0, 4) === 'RIFF') {
        detectedFormat = 'WAV';
        actualMimetype = 'audio/wav';
        fileExtension = 'wav';
      }
      else {
        actualMimetype = 'audio/mp4';
        fileExtension = 'm4a';
        detectedFormat = 'Unknown (defaulting to M4A)';
      }
      
      // Convert to MP3 if not already MP3
      let finalBuffer = audioBuffer;
      let finalMimetype = 'audio/mpeg';
      let finalExtension = 'mp3';
      
      if (fileExtension !== 'mp3') {
        try {
          finalBuffer = await toAudio(audioBuffer, fileExtension);
          if (!finalBuffer || finalBuffer.length === 0) {
            throw new Error('Conversion returned empty buffer');
          }
          finalMimetype = 'audio/mpeg';
          finalExtension = 'mp3';
        } catch (convErr) {
          throw new Error(`Failed to convert ${detectedFormat} to MP3: ${convErr.message}`);
        }
      }
      
      // Send buffer as MP3
      await sock.sendMessage(chatId, {
        audio: finalBuffer,
        mimetype: finalMimetype,
        fileName: `${(video.title || 'song').replace(/[^\w\s-]/g, '')}.${finalExtension}`,
        ptt: false
      }, { quoted: msg });
      
      // Cleanup temp files (keep same as original)
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
      if (err.message && err.message.includes('blocked')) {
        errorMessage = '❌ Download blocked. The content may be unavailable in your region or due to legal restrictions.';
      } else if (err.response?.status === 451 || err.status === 451) {
        errorMessage = '❌ Content unavailable (451). This may be due to legal restrictions or regional blocking.';
      } else if (err.message && err.message.includes('All download methods failed')) {
        errorMessage = '❌ All download sources failed. The content may be unavailable or blocked.';
      }
      
      await sock.sendMessage(msg.key.remoteJid, { 
        text: errorMessage 
      }, { quoted: msg });
    }
  }
};
