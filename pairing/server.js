/**
 * pairing/server.js
 *
 * Standalone entry point — run this SEPARATELY from index.js (the main bot).
 *   node pairing/server.js
 *
 * Serves a small website where a customer types their phone number, gets a
 * WhatsApp pairing code, and — once they enter it in WhatsApp
 * (Linked Devices > Link with phone number) — has a fully working bot
 * instance with every command from ./commands/*, automatically.
 *
 * This file does not import or modify index.js in any way.
 */

const http = require('http');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const {
  createOrPairInstance,
  getInstanceStatus,
  listGroups,
  postGroupStatusForToken,
  sendMessageToGroups,
  previewMediaForToken,
  resolveMediaDownloadForToken,
  resendDashboardLink,
} = require('./instanceManager');

const PORT = process.env.PORT || process.env.PAIRING_PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

function sendJson(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

// maxBytes defaults small (pairing form is tiny JSON) but the dashboard's
// group-status upload needs room for a base64-encoded image/video — callers
// pass a bigger limit for that route.
function readJsonBody(req, maxBytes = 1e6) {
  return new Promise((resolve, reject) => {
    let data = '';
    let tooLarge = false;
    req.on('data', (chunk) => {
      if (tooLarge) return;
      data += chunk;
      if (data.length > maxBytes) {
        tooLarge = true;
        reject(new Error('Faili ni kubwa mno.'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (tooLarge) return;
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

function serveStatic(req, res, urlPath) {
  // Strip query string (e.g. "?token=abc123") — without this, a request for
  // "/dashboard.html?token=xxx" was resolved as a literal filename
  // "dashboard.html?token=xxx" on disk, which never exists, causing every
  // dashboard link to 404 ("Not Found") even though dashboard.html itself
  // is present.
  const pathOnly = urlPath.split('?')[0];
  const filePath = pathOnly === '/' ? '/index.html' : pathOnly;
  const resolved = path.join(PUBLIC_DIR, filePath);

  // Prevent path traversal outside the public/ directory.
  if (!resolved.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.readFile(resolved, (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    const ext = path.extname(resolved);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(content);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'POST' && req.url === '/api/pair') {
      const body = await readJsonBody(req);
      const result = await createOrPairInstance(body.phoneNumber);
      return sendJson(res, 200, { ok: true, ...result });
    }

    if (req.method === 'POST' && req.url === '/api/resend-link') {
      const body = await readJsonBody(req);
      const result = await resendDashboardLink(body.phoneNumber);
      return sendJson(res, 200, { ok: true, ...result });
    }

    if (req.method === 'GET' && req.url.startsWith('/api/status/')) {
      const phoneNumber = decodeURIComponent(req.url.split('/api/status/')[1] || '');
      const status = getInstanceStatus(phoneNumber);
      if (!status) return sendJson(res, 404, { ok: false, error: 'Haipo instance kwa namba hii bado.' });
      return sendJson(res, 200, { ok: true, ...status });
    }

    if (req.method === 'GET' && req.url.startsWith('/api/dashboard/') && req.url.endsWith('/groups')) {
      const token = decodeURIComponent(req.url.split('/api/dashboard/')[1].replace('/groups', ''));
      const groups = await listGroups(token);
      return sendJson(res, 200, { ok: true, groups });
    }

    if (req.method === 'POST' && req.url.startsWith('/api/dashboard/') && req.url.endsWith('/groupstatus')) {
      const token = decodeURIComponent(req.url.split('/api/dashboard/')[1].replace('/groupstatus', ''));
      // 30MB cap — enough for a typical status image/video as base64.
      const body = await readJsonBody(req, 30 * 1e6);
      const result = await postGroupStatusForToken(token, body);
      return sendJson(res, 200, { ok: true, ...result });
    }

    // Send a normal message (text/image/video) to one or several chosen
    // groups at once — the dashboard's "Tuma Ujumbe kwa Groups" picker.
    if (req.method === 'POST' && req.url.startsWith('/api/dashboard/') && req.url.endsWith('/broadcast')) {
      const token = decodeURIComponent(req.url.split('/api/dashboard/')[1].replace('/broadcast', ''));
      // 30MB cap — same headroom as groupstatus, for base64 image/video.
      const body = await readJsonBody(req, 30 * 1e6);
      const result = await sendMessageToGroups(token, body);
      return sendJson(res, 200, { ok: true, ...result });
    }

    // Downloads step 1: resolve a typed song/video name or pasted YouTube
    // link into preview info (title/thumbnail/duration) — no download yet.
    if (req.method === 'POST' && req.url.startsWith('/api/dashboard/') && req.url.endsWith('/media-preview')) {
      const token = decodeURIComponent(req.url.split('/api/dashboard/')[1].replace('/media-preview', ''));
      const body = await readJsonBody(req);
      const preview = await previewMediaForToken(token, body.input);
      return sendJson(res, 200, { ok: true, ...preview });
    }

    // Downloads step 2: the customer confirmed the preview and pressed
    // "Pakua" — resolve a real direct link, then stream the file straight
    // through to the browser as an attachment (mp3 or mp4).
    if (req.method === 'GET' && req.url.startsWith('/api/dashboard/') && req.url.includes('/media-download')) {
      const [tokenPart, queryPart] = req.url.split('/media-download');
      const token = decodeURIComponent(tokenPart.split('/api/dashboard/')[1]);
      const query = new URLSearchParams(queryPart || '');
      const youtubeUrl = query.get('url');
      const type = query.get('type') === 'mp4' ? 'mp4' : 'mp3';
      const requestedTitle = query.get('title') || 'download';

      const resolved = await resolveMediaDownloadForToken(token, youtubeUrl, type);
      const safeTitle = String(resolved.title || requestedTitle)
        .replace(/[^\w\s.-]/g, '')
        .trim()
        .slice(0, 80) || 'download';
      const ext = type === 'mp4' ? 'mp4' : 'mp3';
      const mimetype = type === 'mp4' ? 'video/mp4' : 'audio/mpeg';

      const upstream = await axios.get(resolved.download, {
        responseType: 'stream',
        timeout: 120000,
        maxRedirects: 5,
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      });

      res.writeHead(200, {
        'Content-Type': mimetype,
        'Content-Disposition': `attachment; filename="${safeTitle}.${ext}"`,
      });
      upstream.data.on('error', () => res.destroy());
      upstream.data.pipe(res);
      return;
    }

    if (req.method === 'GET') {
      return serveStatic(req, res, req.url);
    }

    res.writeHead(404);
    res.end('Not found');
  } catch (e) {
    console.error('[pairing/server] error:', e.message);
    sendJson(res, 400, { ok: false, error: e.message });
  }
});

server.listen(PORT, () => {
  console.log(`🌐 Pairing website inaendesha kwenye port ${PORT}`);
});
