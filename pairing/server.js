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
const crypto = require('crypto');
const {
  createOrPairInstance,
  getInstanceStatus,
  listGroups,
  postGroupStatusForToken,
  sendMessageToGroups,
  previewMediaForToken,
  resolveMediaDownloadForToken,
  getSettingsForToken,
  updateSettingsForToken,
  resendDashboardLink,
  getPhoneNumberByToken,
  adminListUsers,
  adminMarkPaid,
  adminExtendTrial,
  adminSetBlocked,
  getBillingForToken,
} = require('./instanceManager');
const adminAuth = require('./adminAuth');
const clickpesa = require('./clickpesa');
const cfg = require('./pairingConfig');

// ── Pending payment orders ──────────────────────────────────────────────
// orderReference -> { phoneNumber, days, amount, createdAt }
// Persisted to disk so a webhook arriving after a redeploy can still be
// matched back to the right customer.
const PENDING_ORDERS_FILE = path.join(__dirname, 'sessions', '_pending_orders.json');
let pendingOrders = {};
try { pendingOrders = JSON.parse(fs.readFileSync(PENDING_ORDERS_FILE, 'utf8')); } catch (e) { pendingOrders = {}; }
function savePendingOrders() {
  fs.writeFileSync(PENDING_ORDERS_FILE, JSON.stringify(pendingOrders, null, 2));
}

// Price for a 30-day subscription, in TZS — edit PRICE_PER_30_DAYS in
// pairing/pairingConfig.js to change.
const PRICE_PER_30_DAYS = cfg.PRICE_PER_30_DAYS;

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
    // "Pakua" — resolve a real, VERIFIED direct link, then 302-redirect the
    // browser straight to it. This is deliberately NOT proxied through our
    // own server: proxying means every byte travels source -> Railway ->
    // browser (double the network hop, capped by our server's bandwidth,
    // which is what caused the slow "stuck in Chrome downloads" behaviour).
    // A redirect lets Chrome fetch directly from the source at full speed,
    // with the original, unaltered quality.
    if (req.method === 'GET' && req.url.startsWith('/api/dashboard/') && req.url.includes('/media-download')) {
      const [tokenPart, queryPart] = req.url.split('/media-download');
      const token = decodeURIComponent(tokenPart.split('/api/dashboard/')[1]);
      const query = new URLSearchParams(queryPart || '');
      const youtubeUrl = query.get('url');
      const type = query.get('type') === 'mp4' ? 'mp4' : 'mp3';

      const resolved = await resolveMediaDownloadForToken(token, youtubeUrl, type);
      res.writeHead(302, { Location: resolved.download });
      return res.end();
    }

    // Settings: read a customer's current (optional) prefix/bot name.
    if (req.method === 'GET' && req.url.startsWith('/api/dashboard/') && req.url.endsWith('/settings')) {
      const token = decodeURIComponent(req.url.split('/api/dashboard/')[1].replace('/settings', ''));
      const settings = getSettingsForToken(token);
      return sendJson(res, 200, { ok: true, ...settings });
    }

    // Settings: save a customer's optional prefix/bot name (blank clears it).
    if (req.method === 'POST' && req.url.startsWith('/api/dashboard/') && req.url.endsWith('/settings')) {
      const token = decodeURIComponent(req.url.split('/api/dashboard/')[1].replace('/settings', ''));
      const body = await readJsonBody(req);
      const settings = updateSettingsForToken(token, body);
      return sendJson(res, 200, { ok: true, ...settings });
    }

    // ── Admin auth ─────────────────────────────────────────────────────
    if (req.method === 'POST' && req.url === '/api/admin/login') {
      const body = await readJsonBody(req);
      const token = adminAuth.login(body.username, body.password);
      if (!token) return sendJson(res, 401, { ok: false, error: 'Username au password si sahihi.' });
      return sendJson(res, 200, { ok: true, token });
    }

    // Every other /api/admin/* route requires a valid admin session token
    // in the Authorization header: "Authorization: Bearer <token>".
    if (req.url.startsWith('/api/admin/') && req.url !== '/api/admin/login') {
      const authHeader = req.headers['authorization'] || '';
      const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
      if (!adminAuth.verify(token)) {
        return sendJson(res, 401, { ok: false, error: 'Session imeisha au si sahihi. Login tena.' });
      }

      if (req.method === 'GET' && req.url === '/api/admin/users') {
        return sendJson(res, 200, { ok: true, users: adminListUsers(), trialDays: require('./userStore').TRIAL_DAYS });
      }

      // /api/admin/users/<phone>/mark-paid | extend-trial | block
      const match = req.url.match(/^\/api\/admin\/users\/([^/]+)\/(mark-paid|extend-trial|block)$/);
      if (req.method === 'POST' && match) {
        const [, phone, action] = match;
        const body = await readJsonBody(req);
        let user;
        if (action === 'mark-paid') {
          user = adminMarkPaid(phone, Number(body.days) || 30, { method: 'manual', note: body.note || '' });
        } else if (action === 'extend-trial') {
          user = adminExtendTrial(phone, Number(body.days) || 1);
        } else if (action === 'block') {
          user = adminSetBlocked(phone, !!body.blocked);
        }
        return sendJson(res, 200, { ok: true, user });
      }
    }

    // ── Customer billing (dashboard) ──────────────────────────────────
    if (req.method === 'GET' && req.url.startsWith('/api/dashboard/') && req.url.endsWith('/billing')) {
      const token = decodeURIComponent(req.url.split('/api/dashboard/')[1].replace('/billing', ''));
      const billing = getBillingForToken(token);
      return sendJson(res, 200, { ok: true, ...billing, pricePer30Days: PRICE_PER_30_DAYS });
    }

    if (req.method === 'POST' && req.url.startsWith('/api/dashboard/') && req.url.endsWith('/pay')) {
      const token = decodeURIComponent(req.url.split('/api/dashboard/')[1].replace('/pay', ''));
      const phoneNumber = getPhoneNumberByToken(token);
      if (!phoneNumber) return sendJson(res, 404, { ok: false, error: 'Dashboard link si sahihi.' });

      const body = await readJsonBody(req);
      const days = Number(body.days) || 30;
      const amount = Math.round((days / 30) * PRICE_PER_30_DAYS);
      const orderReference = `SUB-${phoneNumber}-${Date.now()}`;

      pendingOrders[orderReference] = { phoneNumber, days, amount, createdAt: Date.now() };
      savePendingOrders();

      await clickpesa.initiateUssdPush({ amount, phoneNumber, orderReference });
      return sendJson(res, 200, {
        ok: true,
        message: 'Angalia simu yako — utaombwa kuweka PIN ya M-Pesa/Tigo Pesa/Airtel Money kukamilisha malipo.',
        orderReference,
      });
    }

    // ── ClickPesa webhook — called by ClickPesa, not the browser ───────
    if (req.method === 'POST' && req.url === '/api/payment/webhook') {
      const body = await readJsonBody(req);

      if (!clickpesa.verifyWebhookChecksum(body)) {
        console.error('[payment/webhook] checksum haikuthibitika:', JSON.stringify(body));
        return sendJson(res, 400, { ok: false, error: 'Invalid checksum' });
      }

      const orderReference = body.orderReference;
      const order = pendingOrders[orderReference];
      const status = String(body.status || '').toUpperCase();
      const isSuccess = ['SUCCESS', 'COMPLETED', 'PAID'].includes(status);

      if (order && isSuccess) {
        adminMarkPaid(order.phoneNumber, order.days, {
          method: 'clickpesa',
          orderReference,
          amount: order.amount,
          paymentReference: body.paymentReference || null,
        });
        delete pendingOrders[orderReference];
        savePendingOrders();
      } else if (order && !isSuccess) {
        console.log(`[payment/webhook] malipo ${orderReference} hayakufanikiwa: ${status}`);
      } else {
        console.warn(`[payment/webhook] orderReference isiyojulikana: ${orderReference}`);
      }

      return sendJson(res, 200, { ok: true });
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
