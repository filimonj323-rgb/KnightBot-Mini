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
const fs = require('fs');
const path = require('path');
const {
  createOrPairInstance,
  getInstanceStatus,
  listGroups,
  postGroupStatusForToken,
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
  const filePath = urlPath === '/' ? '/index.html' : urlPath;
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
