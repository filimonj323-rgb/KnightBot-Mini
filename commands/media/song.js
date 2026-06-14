/**
 * Song Downloader - Download audio from YouTube
 * Updated with working public APIs (no ytdl-core to avoid 429)
 */

const yts = require('yt-search');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { toAudio } = require('../../utils/converter');

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
      
      // --------------------- MULTIPLE WORKING PUBLIC APIS (FALLBACK CHAIN) ---------------------
      let audioBuffer = null;
      let downloadSuccess = false;
      
      // Helper: download from URL as buffer
      async function fetchBuffer(url, timeout = 60000) {
        const response = await axios.get(url, {
          responseType: 'arraybuffer',
          timeout: timeout,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          }
        });
        return Buffer.from(response.data);
      }
      
      // Method 1: Vevioz API (free, no key)
      async function downloadVevioz() {
        const apiUrl = `https://api.vevioz.com/ytdown?url=${encodeURIComponent(video.url)}&type=audio`;
        const resp = await axios.get(apiUrl, { timeout: 20000 });
        if (!resp.data || !resp.data.download_url) throw new Error('No download URL');
        const buffer = await fetchBuffer(resp.data.download_url, 90000);
        if (buffer.length < 102400) throw new Error(`Buffer too small: ${buffer.length} bytes`);
        return buffer;
      }
      
      // Method 2: Oceansaver (y2mate style) - works for most videos
      async function downloadOceansaver() {
        // Extract video ID
        const videoId = video.url.includes('v=') ? video.url.split('v=')[1].split('&')[0] : video.url.split('/').pop();
        const api = `https://p.oceansaver.in/ajax/download.php?format=mp3&url=https://www.youtube.com/watch?v=${videoId}&api=dfcb6d76f2f6a9894gjkege8a4ab232222`;
        const resp = await axios.get(api, { timeout: 15000 });
        if (!resp.data || !resp.data.dlink) throw new Error('No download link from oceansaver');
        // Sometimes dlink is relative
        let dlUrl = resp.data.dlink;
        if (dlUrl.startsWith('/')) dlUrl = 'https://p.oceansaver.in' + dlUrl;
        const buffer = await fetchBuffer(dlUrl, 90000);
        if (buffer.length < 102400) throw new Error(`Buffer too small: ${buffer.length} bytes`);
        return buffer;
      }
      
      // Method 3: YTMP3.cc style via api.yt1s.com (alternative)
      async function downloadYt1s() {
        const videoId = video.url.includes('v=') ? video.url.split('v=')[1].split('&')[0] : video.url.split('/').pop();
        // Step 1: get download key
        const initUrl = 'https://api.yt1s.com/api/ajax/search/audio';
        const initData = new URLSearchParams({
          q: videoId,
          vt: 'mp3'
        });
        const initResp = await axios.post(initUrl, initData, {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });
        if (!initResp.data || !initResp.data.links || !initResp.data.links.mp3) throw new Error('No audio link');
        const linkKey = initResp.data.links.mp3.mp3128?.k || initResp.data.links.mp3.mp364?.k;
        if (!linkKey) throw new Error('No key');
        // Step 2: get download URL
        const convUrl = 'https://api.yt1s.com/api/ajax/convert';
        const convData = new URLSearchParams({
          vid: videoId,
          k: linkKey
        });
        const convResp = await axios.post(convUrl, convData);
        if (!convResp.data || !convResp.data.dlink) throw new Error('No download link from yt1s');
        const buffer = await fetchBuffer(convResp.data.dlink, 90000);
        if (buffer.length < 102400) throw new Error(`Buffer too small: ${buffer.length} bytes`);
        return buffer;
      }
      
      const downloadMethods = [
        { name: 'Vevioz API', fn: downloadVevioz },
        { name: 'Oceansaver (y2mate)', fn: downloadOceansaver },
        { name: 'Yt1s.com API', fn: downloadYt1s }
      ];
      
      for (const method of downloadMethods) {
        try {
          console.log(`Trying: ${method.name}`);
          audioBuffer = await method.fn();
          if (audioBuffer && audioBuffer.length > 102400) { // at least 100KB
            downloadSuccess = true;
            console.log(`✅ Success: ${method.name} (${audioBuffer.length} bytes)`);
            break;
          } else {
            console.log(`❌ ${method.name} returned small/invalid buffer: ${audioBuffer?.length || 0} bytes`);
          }
        } catch (err) {
          console.log(`❌ ${method.name} failed: ${err.message}`);
        }
      }
      
      if (!downloadSuccess || !audioBuffer) {
        throw new Error('All download methods failed. Video may be unavailable or blocked.');
      }
      
      // ---------- DETECT FORMAT & CONVERT TO MP3 (SAFELY) ----------
      let finalBuffer = audioBuffer;
      let finalMimetype = 'audio/mpeg';
      let finalExtension = 'mp3';
      
      // Try to convert to MP3 using toAudio, but if it fails, send as is
      try {
        // Check if toAudio exists and works
        if (typeof toAudio === 'function') {
          // Determine original extension from buffer signature (optional)
          let origExt = 'm4a'; // default assumption
          const firstFew = audioBuffer.slice(0, 12);
          if (firstFew.toString('ascii', 0, 3) === 'ID3' || (firstFew[0] === 0xFF && (firstFew[1] & 0xE0) === 0xE0)) {
            origExt = 'mp3';
          } else if (firstFew.toString('ascii', 0, 4) === 'OggS') {
            origExt = 'ogg';
          } else if (firstFew.toString('ascii', 4, 8) === 'ftyp') {
            origExt = 'm4a';
          }
          
          const converted = await toAudio(audioBuffer, origExt);
          if (converted && converted.length > 0) {
            finalBuffer = converted;
            finalMimetype = 'audio/mpeg';
            finalExtension = 'mp3';
          } else {
            throw new Error('Conversion returned empty');
          }
        } else {
          throw new Error('toAudio function not available');
        }
      } catch (convErr) {
        console.log('Conversion to MP3 failed, sending original audio as M4A:', convErr.message);
        // Fallback: send original as M4A/MP4
        finalBuffer = audioBuffer;
        finalMimetype = 'audio/mp4';
        finalExtension = 'm4a';
      }
      
      // Send the audio
      await sock.sendMessage(chatId, {
        audio: finalBuffer,
        mimetype: finalMimetype,
        fileName: `${(video.title || 'song').replace(/[^\w\s-]/g, '')}.${finalExtension}`,
        ptt: false
      }, { quoted: msg });
      
      // Cleanup temp files (keep original cleanup code)
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
      let errorMessage = '❌ Failed to download song. All sources failed.';
      if (err.message && err.message.includes('blocked')) {
        errorMessage = '❌ Download blocked. Content may be restricted.';
      } else if (err.message && err.message.includes('All download methods failed')) {
        errorMessage = '❌ All download sources failed. Video may be age-restricted or region-blocked.';
      }
      await sock.sendMessage(msg.key.remoteJid, { text: errorMessage }, { quoted: msg });
    }
  }
};
