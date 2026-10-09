/**
 * pairing/server.js
 *
 * Sasa inaweza kutumika kwa njia MBILI:
 *
 *   1) NDANI ya bot kuu (mfumo mpya, project MOJA Railway):
 *        const { handlePairingRequest, initPairingServer } = require('./pairing/server');
 *      index.js ndiyo inayofungua HTTP port moja na kuita handlePairingRequest(req,res)
 *      kwa ombi zote zisizo za bot kuu (backup/reminder), na initPairingServer() mara
 *      moja wakati wa boot.
 *
 *   2) STANDALONE (kama zamani, project TOFAUTI Railway):
 *        node pairing/server.js
 *      Bado inafanya kazi peke yake bila index.js — angalia mwisho wa faili hii
 *      (require.main === module).
 *
 * Kila mteja (session_id yake mwenyewe kwenye Turso) hana uhusiano na mteja
 * mwingine wala na bot kuu — instanceManager.js inatenganisha kila mmoja kwa
 * sessionId ya kipekee, kwa hiyo settings za mteja mmoja haziwezi kuathiri
 * mwingine wala bot kuu.
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
  updateAutomationForToken,
  updateProtectionForToken,
  getAutoForwardRulesForToken,
  saveAutoForwardRuleForToken,
  toggleAutoForwardRuleForToken,
  removeAutoForwardRuleForToken,
  resendDashboardLink,
  getPhoneNumberByToken,
  assertActiveForToken,
  sendToSelfChat,
  normalizePhoneNumber,
  adminListUsers,
  adminMarkPaid,
  adminExtendTrial,
  adminSetBlocked,
  adminSetDisplayName,
  getBillingForToken,
  startReminderScheduler,
  adminGetInstanceDetail,
  adminUpdateInstanceSettings,
  adminSendToGroups,
  adminPostGroupStatus,
  adminResetUserSession,
  adminDeleteUserCompletely,
  adminGetGroupInviteLink,
  adminLookupNumberAcrossAllInstances,
  restoreAllInstances,
  adminAdjustDays,
  notifyPaymentReceived,
} = require('./instanceManager');
const adminAuth = require('./adminAuth');
const clickpesa = require('./clickpesa');
const cfg = require('./pairingConfig');
const db = require('./db');
const derivTrader = require('../utils/derivTrader');
const autoTrader = require('../utils/autoTrader');
const { fetchForexSnapshot, computeSignal, DEFAULT_INTERVAL, getTrends } = require('../utils/forexSignal');
const { runBacktest } = require('../utils/backtest');
const economicCalendar = require('../utils/economicCalendar');
const fxPredictions = require('../utils/fxPredictions');
const tradeAnalysis = require('../utils/tradeAnalysis');
const notifyPrefs = require('../utils/notifyPrefs');
const mainConfig = require('../config');
const pocketTrader = require('../utils/pocketOptionTrader');
const pocketStore = require('../utils/pocketStore');
const forexAccess = require('../utils/forexAccess');
const derivAccounts = require('../utils/derivAccounts');
const derivTrader2 = require('../utils/derivCustomerTrader');
const derivCustomerAuto = require('../utils/derivCustomerAuto');
const pocketSignal = require('../utils/pocketSignal');
const signalTracker = require('../utils/signalTracker');
const pocketAuto = require('../utils/pocketAutoTrader');
const posignalCmd = require('../commands/utility/posignal');
const signalTargets = require('../utils/signalTargets');

// Jozi kuu 7 zinazoweza kuangaliwa kwenye dashboard (.fxtrading.html) —
// EURUSD/GBPUSD/USDJPY/EURGBP/EURJPY/GBPJPY/AUDJPY ndizo zinazofuatiliwa na
// auto-trader kiotomatiki (crosses zimeongezwa MAKUSUDI kupunguza
// correlation risk, hazina USD); nyingine 3 zinaangaliwa TU mtu akibonyeza
// "Angalia" (kuepuka 429).
const FX_SYMBOL_MAP = {
  EURUSD: 'EUR/USD',
  GBPUSD: 'GBP/USD',
  USDJPY: 'USD/JPY',
  EURGBP: 'EUR/GBP',
  EURJPY: 'EUR/JPY',
  GBPJPY: 'GBP/JPY',
  AUDJPY: 'AUD/JPY',
  AUDUSD: 'AUD/USD',
  USDCHF: 'USD/CHF',
  USDCAD: 'USD/CAD',
  NZDUSD: 'NZD/USD',
};

// Bot kuu (WhatsApp namba ya owner, config.js) — hii ndiyo inayotumika
// kutuma notifications za trade zilizofunguliwa/kufungwa kupitia dashboard,
// sawa na zile za auto-trader.
function getOwnerJid() {
  const raw = Array.isArray(mainConfig.ownerNumber) ? mainConfig.ownerNumber[0] : mainConfig.ownerNumber;
  return raw?.includes('@') ? raw : `${raw}@s.whatsapp.net`;
}

async function notifyOwnerWA(text, category) {
  try {
    // Ikipewa category (Pocket Option) → heshimu swichi/foleni za notifyPrefs.
    if (category) {
      if (!global.currentSock) return;
      await notifyPrefs.dm(category, text, { sock: global.currentSock, jid: getOwnerJid() });
      return;
    }
    if (!global.currentSock) {
      console.error('[fx dashboard] Bot kuu haijaunganishwa na WhatsApp - notification imepotea.');
      return;
    }
    await global.currentSock.sendMessage(getOwnerJid(), { text });
  } catch (err) {
    console.error('[fx dashboard] Imeshindwa kutuma notification:', err.message);
  }
}

// ── Pending payment orders (SQLite — survives redeploys via the Volume) ──
// ── Pending payment orders (Turso — outside Railway, survives webhook
// arriving after a redeploy or host migration) ──────────────────────────
async function insertPendingOrder(orderReference, phoneNumber, days, amount) {
  await db.query(
    'INSERT INTO pending_orders (orderReference, phoneNumber, days, amount, createdAt) VALUES (?, ?, ?, ?, ?)',
    [orderReference, phoneNumber, days, amount, Date.now()]
  );
}
async function getPendingOrder(orderReference) {
  const res = await db.query('SELECT * FROM pending_orders WHERE orderReference = ?', [orderReference]);
  return res.rows[0] || null;
}
async function removePendingOrder(orderReference) {
  await db.query('DELETE FROM pending_orders WHERE orderReference = ?', [orderReference]);
}

// ── Kuthibitisha malipo moja kwa moja (bila admin) ─────────────────────
// Njia TATU zinaweza kugundua malipo yamekamilika: (1) webhook ya ClickPesa,
// (2) dashboard.html inayouliza /pay-status mteja akisubiri, (3) reconciler
// ya nyuma (kila sekunde 30) kwa wateja waliofunga ukurasa. Zote zinapitia
// settlePaidOrder(), ambayo "inakamata" order kwa DELETE — ni moja tu
// itakayofanikiwa, hivyo siku haziongezwi mara mbili.
async function settlePaidOrder(orderReference, info = {}) {
  const order = await getPendingOrder(orderReference);
  if (!order) return null;

  // Kiasi kilichokusanywa kikiwa 0 au chini, hakuna malipo halisi.
  if (info.collectedAmount != null && Number(info.collectedAmount) <= 0) {
    console.warn(`[payment] ${orderReference}: collectedAmount=${info.collectedAmount} — sitoi huduma.`);
    return null;
  }

  const claim = await db.query('DELETE FROM pending_orders WHERE orderReference = ?', [orderReference]);
  if (!claim.rowsAffected) return null; // njia nyingine imeshaishughulikia

  if (info.collectedAmount != null && Number(info.collectedAmount) < Number(order.amount)) {
    console.warn(`[payment] ${orderReference}: kiasi kilichokusanywa (${info.collectedAmount}) < bei ya package (${order.amount}) — nimeendelea kutoa huduma, angalia ClickPesa dashboard.`);
  }

  try {
    const user = await adminMarkPaid(order.phoneNumber, order.days, {
      method: 'clickpesa',
      orderReference,
      amount: order.amount,
      paymentReference: info.paymentReference || null,
    });
    console.log(`[payment] ✅ ${orderReference}: ${order.phoneNumber} ameongezewa siku ${order.days}`);
    notifyPaymentReceived(order.phoneNumber, order.days, user && user.paidUntil).catch(() => {});
    return { order, user };
  } catch (e) {
    // Rudisha order ili reconciler ijaribu tena — mteja asipoteze malipo.
    await insertPendingOrder(orderReference, order.phoneNumber, order.days, order.amount).catch(() => {});
    throw e;
  }
}

const PAID_STATUSES = ['SUCCESS', 'SETTLED', 'COMPLETED', 'PAID'];
const ORDER_MAX_AGE_MS = 2 * 60 * 60 * 1000; // order isiyolipwa baada ya saa 2 inafutwa (bila kupiga ClickPesa)

// ClickPesa ina kikomo cha simu 100 kwa siku (hadi KYC ikamilike), kwa hiyo
// webhook ndiyo njia KUU ya kuthibitisha malipo. Kuuliza ClickPesa moja kwa
// moja ni akiba tu, na kunadhibitiwa kwa makali:
//   - si kabla ya sekunde 90 tangu order iundwe (webhook kwanza)
//   - upeo wa majaribio 3 kwa order, kila baada ya dakika 2 angalau
//   - bajeti ya siku ya maswali 30 kwa jumla
//   - hakuna swali lolote wakati ClickPesa imetuzuia (429)
const STATUS_MIN_AGE_MS = 90 * 1000;
const STATUS_MIN_GAP_MS = 2 * 60 * 1000;
const STATUS_MAX_TRIES = 3;
const STATUS_DAILY_BUDGET = 30;
const statusTries = new Map(); // orderReference -> { n, last }
let statusDay = { day: '', n: 0 };

function mayQueryStatus(order) {
  if (clickpesa.isBlocked()) return false;
  const now = Date.now();
  if (now - Number(order.createdAt) < STATUS_MIN_AGE_MS) return false;

  const today = new Date().toISOString().slice(0, 10);
  if (statusDay.day !== today) statusDay = { day: today, n: 0 };
  if (statusDay.n >= STATUS_DAILY_BUDGET) return false;

  const t = statusTries.get(order.orderReference) || { n: 0, last: 0 };
  if (t.n >= STATUS_MAX_TRIES || now - t.last < STATUS_MIN_GAP_MS) return false;

  t.n += 1; t.last = now;
  statusTries.set(order.orderReference, t);
  statusDay.n += 1;
  return true;
}

async function dropOrder(orderReference) {
  statusTries.delete(orderReference);
  await removePendingOrder(orderReference);
}

async function reconcilePendingOrders() {
  const res = await db.query('SELECT * FROM pending_orders');
  for (const order of res.rows) {
    try {
      // 1) Orders za zamani/zilizoachwa — futa bila kugusa ClickPesa.
      if (Date.now() - Number(order.createdAt) > ORDER_MAX_AGE_MS) {
        await dropOrder(order.orderReference);
        continue;
      }
      // 2) Uliza ClickPesa kwa kiasi tu (angalia mayQueryStatus).
      if (!mayQueryStatus(order)) continue;

      const st = await clickpesa.getPaymentStatus(order.orderReference);
      if (st && PAID_STATUSES.includes(st.status)) {
        statusTries.delete(order.orderReference);
        await settlePaidOrder(order.orderReference, st);
      } else if (st && st.status === 'FAILED') {
        await dropOrder(order.orderReference);
      }
    } catch (e) {
      console.error(`[payment/reconcile] ${order.orderReference}:`, e.message);
    }
  }
}

let _reconcilerStarted = false;
function startPaymentReconciler() {
  if (_reconcilerStarted) return;
  _reconcilerStarted = true;
  let running = false;
  setInterval(async () => {
    if (running) return;
    running = true;
    try { await reconcilePendingOrders(); } catch (e) { console.error('[payment/reconcile]', e.message); }
    running = false;
  }, 30 * 1000);
}

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

// Frontend sasa iko kwenye origin tofauti (GitHub Pages), siyo server hii
// tena — browser inahitaji ruhusa ya CORS kabla ya kukubali majibu.
// Weka ALLOWED_ORIGIN kwenye Railway env vars kuwa URL kamili ya GitHub
// Pages yako, mfano: https://jina-lako.github.io — '*' ni default salama
// kwa sababu hatutumii cookies/credentials, request zote zinatumia
// Authorization: Bearer token badala yake.
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

function applyCors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

async function handlePairingRequest(req, res) {
  applyCors(req, res);

  // Preflight: browser inatuma OPTIONS kabla ya POST/GET yenye Authorization
  // header, hasa kwa admin.html na dashboard.html. Lazima ijibiwe 204 pekee,
  // bila kuendelea kwenye routing ya kawaida chini.
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

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

    // ── Deriv ya mteja mwenyewe (DEMO tu): /api/dashboard/<token>/deriv[/pin|/connect|/disconnect|/toggle] ──
    // Token ya dashboard inamtambulisha mteja; hatua nyeti (kuweka token, kuwasha) zinahitaji PIN ya trading.
    // Body (PIN/token ya Deriv) HAIANDIKWI kwenye log kamwe.
    const mDeriv = /^\/api\/dashboard\/([^/?]+)\/deriv(?:\/([a-z]+))?(?:\?.*)?$/.exec(req.url);
    if (mDeriv) {
      const dashToken = decodeURIComponent(mDeriv[1]);
      const sub = mDeriv[2] || '';
      try {
        const phone = await assertActiveForToken(dashToken);
        if (req.method === 'GET' && sub === '') {
          return sendJson(res, 200, { ok: true, account: await derivAccounts.getPublic(phone) });
        }
        // Balance + positions + takwimu za leo + historia fupi (inasoma Deriv kupitia muunganisho wa mteja huyu).
        if (req.method === 'GET' && sub === 'overview') {
          derivAccounts.rateLimit(`deriv-ov:${dashToken}`, 30, 60 * 1000);
          return sendJson(res, 200, { ok: true, ...(await derivTrader2.overview(phone)) });
        }
        if (req.method === 'POST' && ['pin', 'connect', 'disconnect', 'toggle', 'trade', 'close', 'closeall'].includes(sub)) {
          const body = await readJsonBody(req);
          // Rate limit TU kwa hatua zinazohitaji PIN/token (kuzuia kubashiri PIN). Kuzima trading/auto na
          // kuondoa akaunti HAZIZUIWI kamwe — mteja lazima aweze kusimamisha trading yake wakati wowote.
          const isCloseAction = sub === 'close' || sub === 'closeall';
          const isSafeStop = sub === 'disconnect' || isCloseAction || (sub === 'toggle' && body.userEnabled !== true && body.autoEnabled !== true);
          if (isCloseAction) derivAccounts.rateLimit(`deriv-close:${dashToken}`, 30, 60 * 1000); // kufunga hakuhitaji PIN; kikomo kipana tu
          else if (!isSafeStop) derivAccounts.rateLimit(`deriv:${dashToken}`, 12, 60 * 1000);
          if (sub === 'trade') {
            // Kufungua trade kutoka dashboard KUNAHITAJI PIN kila mara (link ya dashboard peke yake haitoshi kutrade).
            await derivAccounts.requirePin(phone, body.pin);
            const r = await derivTrader2.openTrade(phone, {
              pair: body.pair, direction: body.direction, stake: body.stake,
              stopLoss: body.stopLoss, takeProfit: body.takeProfit, multiplier: body.multiplier,
            });
            return sendJson(res, 200, { ok: true, trade: r });
          }
          if (sub === 'close') {
            const r = await derivTrader2.closeTrade(phone, String(body.contractId || '').replace(/\D/g, ''));
            return sendJson(res, 200, { ok: true, result: r });
          }
          if (sub === 'closeall') {
            return sendJson(res, 200, { ok: true, results: await derivTrader2.closeAll(phone) });
          }
          if (sub === 'pin') {
            const account = await derivAccounts.setPin(phone, body.newPin, body.oldPin);
            return sendJson(res, 200, { ok: true, account });
          }
          if (sub === 'connect') {
            const r = await derivAccounts.connect(phone, body.token, body.pin);
            return sendJson(res, 200, { ok: true, ...r });
          }
          if (sub === 'disconnect') {
            return sendJson(res, 200, { ok: true, account: await derivAccounts.disconnect(phone) });
          }
          const account = await derivAccounts.setSwitches(phone, {
            userEnabled: typeof body.userEnabled === 'boolean' ? body.userEnabled : undefined,
            autoEnabled: typeof body.autoEnabled === 'boolean' ? body.autoEnabled : undefined,
            pin: body.pin,
          });
          return sendJson(res, 200, { ok: true, account });
        }
      } catch (err) {
        if (err instanceof derivAccounts.DerivAccountError || (err && err.userMessage)) { // pia TradeError/SessionError
          return sendJson(res, err.code === 'RATE_LIMIT' ? 429 : 400, { ok: false, error: err.userMessage, code: err.code });
        }
        if (/Dashboard link|imezuiwa|Muda wako/.test(err.message)) return sendJson(res, 400, { ok: false, error: err.message });
        console.error('[deriv dashboard] hitilafu:', err.message);
        return sendJson(res, 500, { ok: false, error: 'Hitilafu ya ndani. Jaribu tena baadaye.' });
      }
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
      const settings = await getSettingsForToken(token);
      return sendJson(res, 200, { ok: true, ...settings });
    }

    // Settings: save a customer's optional prefix/bot name (blank clears it).
    // NOTE: must be checked BEFORE the /settings/automation and
    // /settings/protection routes below would otherwise never be reached,
    // since '/settings/automation'.endsWith('/settings') is false anyway —
    // kept in this order for readability, not correctness.
    if (req.method === 'POST' && req.url.startsWith('/api/dashboard/') && req.url.endsWith('/settings')) {
      const token = decodeURIComponent(req.url.split('/api/dashboard/')[1].replace('/settings', ''));
      const body = await readJsonBody(req);
      const settings = await updateSettingsForToken(token, body);
      return sendJson(res, 200, { ok: true, ...settings });
    }

    // Settings: save a customer's automation toggles (autoTyping,
    // autoRecording, autoViewStatus, autoReactStatus, autoReactMessages).
    if (req.method === 'POST' && req.url.startsWith('/api/dashboard/') && req.url.endsWith('/settings/automation')) {
      const token = decodeURIComponent(req.url.split('/api/dashboard/')[1].replace('/settings/automation', ''));
      const body = await readJsonBody(req);
      const automation = await updateAutomationForToken(token, body);
      return sendJson(res, 200, { ok: true, automation });
    }

    // Settings: save group-wise protection (antiGroupMention/antiPromo/antiLink).
    if (req.method === 'POST' && req.url.startsWith('/api/dashboard/') && req.url.endsWith('/settings/protection')) {
      const token = decodeURIComponent(req.url.split('/api/dashboard/')[1].replace('/settings/protection', ''));
      const body = await readJsonBody(req);
      const protection = await updateProtectionForToken(token, body.features);
      return sendJson(res, 200, { ok: true, protection });
    }

    // Auto-Forward: list this customer's rules (source/destination/trigger),
    // scoped automatically to just the groups their own bot belongs to.
    if (req.method === 'GET' && req.url.startsWith('/api/dashboard/') && req.url.endsWith('/autoforward')) {
      const token = decodeURIComponent(req.url.split('/api/dashboard/')[1].replace('/autoforward', ''));
      const data = await getAutoForwardRulesForToken(token);
      return sendJson(res, 200, { ok: true, ...data });
    }

    // Auto-Forward: create/update a rule — source group, destination
    // (another group/channel/ID), and trigger mode (alladmin OR numbers).
    if (req.method === 'POST' && req.url.startsWith('/api/dashboard/') && req.url.endsWith('/autoforward')) {
      const token = decodeURIComponent(req.url.split('/api/dashboard/')[1].replace('/autoforward', ''));
      const body = await readJsonBody(req);
      const data = await saveAutoForwardRuleForToken(token, body);
      return sendJson(res, 200, { ok: true, ...data });
    }

    // Auto-Forward: enable/disable one rule without changing its settings.
    if (req.method === 'POST' && req.url.startsWith('/api/dashboard/') && req.url.endsWith('/autoforward/toggle')) {
      const token = decodeURIComponent(req.url.split('/api/dashboard/')[1].replace('/autoforward/toggle', ''));
      const body = await readJsonBody(req);
      const data = await toggleAutoForwardRuleForToken(token, body.sourceGroupId, !!body.enabled);
      return sendJson(res, 200, { ok: true, ...data });
    }

    // Auto-Forward: permanently delete a rule.
    if (req.method === 'POST' && req.url.startsWith('/api/dashboard/') && req.url.endsWith('/autoforward/remove')) {
      const token = decodeURIComponent(req.url.split('/api/dashboard/')[1].replace('/autoforward/remove', ''));
      const body = await readJsonBody(req);
      const data = await removeAutoForwardRuleForToken(token, body.sourceGroupId);
      return sendJson(res, 200, { ok: true, ...data });
    }

    // ── Uchunguzi wa MUDA wa maktaba ya Pocket Option (browser) ─────────────
    // Fungua: /api/pocket/debug-lib?key=<POCKET_BRIDGE_SECRET>
    // Inaonyesha toleo + msimbo wa get_candles/history kutoka bridge ya Python.
    // Zima kwa POCKET_DEBUG_LIB=false (Railway). Inalindwa na secret ya bridge.
    if (req.method === 'GET' && req.url.split('?')[0] === '/api/pocket/debug-lib') {
      const textReply = (code, msg) => {
        res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(msg);
      };
      if (String(process.env.POCKET_DEBUG_LIB || 'true').toLowerCase() === 'false') {
        return textReply(404, 'Imezimwa.');
      }
      const bridgeSecret = process.env.POCKET_BRIDGE_SECRET || 'badilisha_hii_iwe_secret_ndefu';
      const key = new URL(req.url, 'http://x').searchParams.get('key') || '';
      const a = Buffer.from(key);
      const b = Buffer.from(bridgeSecret);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        return textReply(403, 'Key si sahihi.');
      }
      try {
        // what=history -> ombi la loadHistoryPeriod (pair, period, offset, time hiari)
        const q = new URL(req.url, 'http://x').searchParams;
        let target = `${pocketTrader.BRIDGE_URL}/debug/lib`;
        if (q.get('what') === 'history') {
          const fwd = new URLSearchParams();
          for (const k of ['pair', 'period', 'offset', 'time']) if (q.get(k)) fwd.set(k, q.get(k));
          target = `${pocketTrader.BRIDGE_URL}/debug/history?${fwd.toString()}`;
        }
        const r = await fetch(target, {
          headers: { 'X-Bridge-Secret': bridgeSecret },
          signal: AbortSignal.timeout(30000),
        });
        return textReply(r.status, await r.text());
      } catch (e) {
        return textReply(502, `Bridge haipatikani: ${e.message}`);
      }
    }

    // ── Admin: full backup download (sessions + SQLite db as one .tar.gz) ──
    // Use this before migrating to a new Railway account / host: download
    // this file, then on the new host extract it into pairing/ so it
    // recreates pairing/sessions/* (all customer WhatsApp sessions +
    // pairing.db) before starting the app there.
    if (req.method === 'GET' && req.url === '/api/admin/backup') {
      const authHeader = req.headers['authorization'] || '';
      const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
      if (!adminAuth.verify(token)) {
        return sendJson(res, 401, { ok: false, error: 'Session imeisha au si sahihi. Login tena.' });
      }

      const { spawn } = require('child_process');
      const filename = `pairing-backup-${new Date().toISOString().slice(0, 10)}.tar.gz`;
      res.writeHead(200, {
        'Content-Type': 'application/gzip',
        'Content-Disposition': `attachment; filename="${filename}"`,
      });

      const tar = spawn('tar', ['-czf', '-', '-C', __dirname, 'sessions']);
      tar.stdout.pipe(res);
      tar.stderr.on('data', (d) => console.error('[backup] tar:', d.toString()));
      tar.on('error', (e) => {
        console.error('[backup] tar imeshindwa kuanza:', e.message);
        if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'Backup imeshindikana: ' + e.message });
      });
      return;
    }

    // ── Admin: futa session zote chakavu (pairing/sessions/*) ──────────
    // Tumia hii mara moja baada ya majaribio ya pairing yaliyoshindwa
    // kuacha auth-state chakavu nyuma yake (ndiyo chanzo cha "connection
    // closed" kuendelea kutokea hata baada ya kubadilisha config). Haigusi
    // .gitkeep. Baada ya kuitumia, kila namba italazimika ku-pair upya.
    if (req.method === 'POST' && req.url === '/api/admin/reset-sessions') {
      const authHeader = req.headers['authorization'] || '';
      const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
      if (!adminAuth.verify(token)) {
        return sendJson(res, 401, { ok: false, error: 'Session imeisha au si sahihi. Login tena.' });
      }

      const sessionsDir = path.join(__dirname, 'sessions');
      const entries = fs.readdirSync(sessionsDir).filter((f) => f !== '.gitkeep');
      for (const entry of entries) {
        fs.rmSync(path.join(sessionsDir, entry), { recursive: true, force: true });
      }
      return sendJson(res, 200, { ok: true, removed: entries.length });
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
        return sendJson(res, 200, { ok: true, users: await adminListUsers(), trialDays: require('./userStore').TRIAL_DAYS });
      }

      // ── Admin: ruhusa ya commands za forex kwa pairing bots ────────────────
      // GET = hali (all + grants + commands). POST { action: 'grant'|'revoke'|'grant_all'|'revoke_all', phone? }
      if (req.url.split('?')[0] === '/api/admin/forex-access') {
        if (req.method === 'GET') {
          const l = await forexAccess.list();
          if (!l.ok) return sendJson(res, 500, l);
          return sendJson(res, 200, { ...l, commands: [...forexAccess.FOREX_COMMANDS] });
        }
        if (req.method === 'POST') {
          const body = await readJsonBody(req);
          const action = String(body.action || '');
          let r;
          if (action === 'grant') r = await forexAccess.grant(body.phone);
          else if (action === 'revoke') r = await forexAccess.revoke(body.phone);
          else if (action === 'grant_all') r = await forexAccess.grantAll();
          else if (action === 'revoke_all') r = await forexAccess.revokeAll();
          else return sendJson(res, 400, { ok: false, error: 'action lazima iwe grant, revoke, grant_all au revoke_all.' });
          if (!r.ok) return sendJson(res, 400, r);
          return sendJson(res, 200, { ...(await forexAccess.list()), changed: r });
        }
      }

      // ── Admin: akaunti za Deriv za wateja (DEMO tu) ──────────────────────────────
      // GET = orodha + kill switch. POST { action, phone?, limits?, dm? }:
      //  approve|revoke|approve_auto|revoke_auto|allow_real|deny_real|set_limits|reset_pin|remove|kill_all|resume_all
      if (req.url.split('?')[0] === '/api/admin/deriv') {
        try {
          if (req.method === 'GET') return sendJson(res, 200, { ok: true, ...(await derivAccounts.adminList()), autoEngine: derivCustomerAuto.getStatus() });
          if (req.method === 'POST') {
            const body = await readJsonBody(req);
            const phone = body.phone ? String(body.phone).replace(/\D/g, '') : '';
            const r = await derivAccounts.adminAction(phone, String(body.action || ''), { limits: body.limits });
            if (body.action === 'reset_pin') {
              let dmSent = false;
              if (body.dm) {
                dmSent = await sendToSelfChat(
                  phone,
                  `🔐 *PIN ya muda ya Trading:* ${r.tempPin}\n\nIngia kwenye dashboard → Deriv, kisha uibadilishe kuwa PIN yako mwenyewe mara moja. Usimpe mtu yeyote.`
                );
              }
              return sendJson(res, 200, { ok: true, ...r, dmSent });
            }
            return sendJson(res, 200, { ok: true, ...r });
          }
        } catch (err) {
          if (err instanceof derivAccounts.DerivAccountError) return sendJson(res, 400, { ok: false, error: err.userMessage, code: err.code });
          console.error('[admin deriv] hitilafu:', err.message);
          return sendJson(res, 500, { ok: false, error: 'Hitilafu ya ndani.' });
        }
      }

      // ── Admin: QR ya BOT KUU (si ya pairing bots za wateja — wale
      // wanatumia pairing code pekee). global.mainQR/global.currentSock
      // vinawekwa na index.js (connection.update handler ya socket kuu).
      // Hii inaruhusu admin.html kuionyesha QR kama picha kubwa badala ya
      // ile ya Railway logs (ngumu ku-scan kwenye log viewer).
      if (req.method === 'GET' && req.url === '/api/admin/main-qr') {
        return sendJson(res, 200, {
          ok: true,
          connected: !!global.currentSock,
          botNumber: global.currentSock?.user?.id ? global.currentSock.user.id.split(':')[0] : null,
          qr: global.mainQR?.dataUrl || null,
          generatedAt: global.mainQR?.generatedAt || null,
        });
      }

      // Number Lookup (global — si ya bot moja): tafuta namba yoyote KATIKA
      // GROUPS ZA BOT ZOTE zinazoendesha kwa sasa, si za instance moja tu —
      // kwa sababu namba fulani inaweza kuwa kwenye group ya mteja A wakati
      // unaangalia mteja B. Inarudisha jina, picha ya profile, na kila group
      // inayopatikana ikiwa na link yake tayari (imefuatana papo hapo).
      if (req.method === 'POST' && req.url === '/api/admin/lookup-number') {
        const body = await readJsonBody(req);
        const result = await adminLookupNumberAcrossAllInstances(body.number);
        return sendJson(res, 200, { ok: true, ...result });
      }

      // /api/admin/users/<phone>/mark-paid | extend-trial | block
      const match = req.url.match(/^\/api\/admin\/users\/([^/]+)\/(mark-paid|extend-trial|block)$/);
      if (req.method === 'POST' && match) {
        const [, phone, action] = match;
        const body = await readJsonBody(req);
        let user;
        if (action === 'mark-paid') {
          user = await adminMarkPaid(phone, Number(body.days) || 30, { method: 'manual', note: body.note || '' });
        } else if (action === 'extend-trial') {
          user = await adminExtendTrial(phone, Number(body.days) || 1);
        } else if (action === 'block') {
          user = await adminSetBlocked(phone, !!body.blocked);
        }
        return sendJson(res, 200, { ok: true, user });
      }

      // Full-access bot control (per-customer) — status, groups, settings,
      // messaging, force session reset. All still behind the same admin
      // Authorization check above.
      const phoneMatch = req.url.match(/^\/api\/admin\/users\/([^/]+)\/(detail|settings|message|group-status|reset-session|adjust-days|name|delete)$/);
      if (phoneMatch) {
        const [, phone, action] = phoneMatch;

        if (action === 'detail' && req.method === 'GET') {
          const detail = await adminGetInstanceDetail(phone);
          return sendJson(res, 200, { ok: true, ...detail });
        }

        if (action === 'settings' && req.method === 'POST') {
          const body = await readJsonBody(req);
          const detail = await adminUpdateInstanceSettings(phone, body);
          return sendJson(res, 200, { ok: true, ...detail });
        }

        if (action === 'message' && req.method === 'POST') {
          // 30MB cap for base64 image/video/audio, same as the customer dashboard route.
          const body = await readJsonBody(req, 30 * 1e6);
          const result = await adminSendToGroups(phone, body);
          return sendJson(res, 200, { ok: true, ...result });
        }

        if (action === 'group-status' && req.method === 'POST') {
          // 30MB cap for base64 image/video/audio, same as the customer dashboard route.
          const body = await readJsonBody(req, 30 * 1e6);
          const result = await adminPostGroupStatus(phone, body);
          return sendJson(res, 200, { ok: true, ...result });
        }

        if (action === 'reset-session' && req.method === 'POST') {
          const result = await adminResetUserSession(phone);
          return sendJson(res, 200, { ok: true, ...result });
        }

        // Futa mteja KABISA (session + rekodi zote za DB) — tofauti na
        // reset-session, huyu haonekani tena kwenye orodha ya admin.
        if (action === 'delete' && req.method === 'POST') {
          const result = await adminDeleteUserCompletely(phone);
          return sendJson(res, 200, { ok: true, ...result });
        }

        // Badilisha jina la mtumiaji linaloonekana kwenye admin dashboard.
        if (action === 'name' && req.method === 'POST') {
          const body = await readJsonBody(req);
          const user = await adminSetDisplayName(phone, body.name);
          return sendJson(res, 200, { ok: true, user });
        }

        if (action === 'adjust-days' && req.method === 'POST') {
          const body = await readJsonBody(req);
          const user = await adminAdjustDays(phone, body.days);
          return sendJson(res, 200, { ok: true, user });
        }
      }

      // Group Links (Mipangilio): link ya group MOJA, kwa jina la group id
      // kilichopitishwa kwenye query string — /group-link?groupId=...
      // Query string hutumika (badala ya path segment) kwa sababu group id
      // za WhatsApp zina "@" na "-" ndani yake.
      if (req.method === 'GET' && req.url.startsWith('/api/admin/users/') && req.url.includes('/group-link')) {
        const [pathPart, queryPart] = req.url.split('/group-link');
        const phone = decodeURIComponent(pathPart.replace('/api/admin/users/', ''));
        const query = new URLSearchParams(queryPart || '');
        const result = await adminGetGroupInviteLink(phone, query.get('groupId') || '');
        return sendJson(res, 200, { ok: true, ...result });
      }

      // ── FX Auto-Trader (Deriv Multipliers) — dashboard ya trading ──────
      // Angalia pairing/public/fxtrading.html kwa UI. Zote hapa chini
      // zinatumia derivTrader.js (Deriv moja kwa moja) na autoTrader.js
      // (hali ya auto-trading ya saa moja).

      // Muhtasari kamili: balance + positions wazi + hali ya auto-trader.
      if (req.method === 'GET' && req.url === '/api/admin/fx/overview') {
        const [positions, balance] = await Promise.all([
          derivTrader.getOpenPositionsLive(),
          derivTrader.getBalance(),
        ]);
        return sendJson(res, 200, {
          ok: true,
          balance,
          positions,
          autoTrade: autoTrader.getStatus(),
        });
      }

      // Win-rate ya auto-trader kwa "bucket" ya signal strength — angalia

      // Win-rate ya auto-trader kwa "bucket" ya signal strength — angalia
      // utils/autoTrader.js -> getWinRateStats() na commands/utility/autostats.js
      // (command ya WhatsApp yenye taarifa ile ile).
      if (req.method === 'GET' && req.url === '/api/admin/fx/stats') {
        const stats = await autoTrader.getWinRateStats();
        return sendJson(res, 200, { ok: true, stats });
      }

      // Historia ya trade zilizofungwa (auto-trader) — tab ya History.
      if (req.method === 'GET' && req.url.split('?')[0] === '/api/admin/fx/history') {
        const q = new URL(req.url, 'http://x').searchParams;
        const trades = await autoTrader.getTradeHistory(q.get('limit') || 200);
        return sendJson(res, 200, { ok: true, trades });
      }

      // Uchambuzi wa AI (Groq) wa historia ya trades: jozi imara + strength bora.
      // ?force=1 inapita cache ya dakika 10. Takwimu zinahesabiwa server — AI inaeleza tu.
      if (req.method === 'GET' && req.url.split('?')[0] === '/api/admin/fx/analyze') {
        try {
          const force = new URL(req.url, 'http://x').searchParams.get('force') === '1';
          return sendJson(res, 200, await tradeAnalysis.analyze('fx', { force }));
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: err.message });
        }
      }

      // Washa/zima trailing stop (breakeven-lock + profit-lock) — sawa na
      // command ya WhatsApp .fxtrailing (commands/owner/fxtrailing.js).
      if (req.method === 'POST' && req.url === '/api/admin/fx/trailing') {
        const body = await readJsonBody(req);
        const result = await autoTrader.setTrailingEnabled(!!body.enabled);
        return sendJson(res, 200, { ok: true, ...result });
      }

      // Fungua trade mpya kwa mkono kutoka dashboard (sawa na .fxbuy/.fxsell).
      if (req.method === 'POST' && req.url === '/api/admin/fx/open') {
        const body = await readJsonBody(req);
        const pair = String(body.pair || '').toUpperCase().replace(/[^A-Z]/g, '');
        if (!pair) return sendJson(res, 400, { ok: false, error: 'Jozi (pair) inahitajika.' });

        const direction = body.direction === 'SELL' ? 'SELL' : 'BUY';
        let result;
        try {
          // Njia salama: inazuia trade ya pili kwa jozi iliyo wazi + inaandikisha kwenye DB (autoTrader.placeManualTrade).
          result = await autoTrader.placeManualTrade({
            pair,
            direction,
            stake: Number(body.stake),
            stopLoss: Number(body.stopLoss),
            takeProfit: Number(body.takeProfit),
            multiplier: body.multiplier ? Number(body.multiplier) : undefined,
          });
        } catch (err) {
          if (err.code === 'DUPLICATE_OPEN') return sendJson(res, 409, { ok: false, duplicate: true, error: err.message });
          throw err;
        }

        notifyOwnerWA(
          `🖥️ *TRADE IMEFUNGULIWA (Dashboard)*\n\n` +
            `Jozi: *${pair}*\n` +
            `Mwelekeo: ${direction === 'BUY' ? '🟢 BUY' : '🔴 SELL'}\n` +
            `Stake: $${body.stake}  |  SL: $${body.stopLoss}  |  TP: $${body.takeProfit}\n` +
            `Multiplier: x${body.multiplier || 100}\n` +
            `Bei ya ununuzi: $${result.buy_price}\n` +
            `🆔 Contract ID: ${result.contract_id}\n\n` +
            `⚠️ Trade hii ilifunguliwa KWA MKONO kupitia admin dashboard.`
        );

        return sendJson(res, 200, { ok: true, result });
      }

      // Badilisha Stop Loss/Take Profit ya trade iliyo WAZI TAYARI (bila
      // kuifunga) — tumia sehemu ya "Hariri" kwenye jedwali la Trades.
      if (req.method === 'POST' && req.url === '/api/admin/fx/update-limits') {
        const body = await readJsonBody(req);
        if (!body.contract_id) return sendJson(res, 400, { ok: false, error: 'contract_id inahitajika.' });

        const result = await derivTrader.updateContractLimits(body.contract_id, {
          stopLoss: body.stop_loss,
          takeProfit: body.take_profit,
        });

        notifyOwnerWA(
          `🖥️ *SL/TP IMEBADILISHWA (Dashboard)*\n\n` +
            `🆔 Contract ID: ${body.contract_id}\n` +
            (body.stop_loss ? `SL mpya: $${body.stop_loss}\n` : '') +
            (body.take_profit ? `TP mpya: $${body.take_profit}\n` : '')
        );

        return sendJson(res, 200, { ok: true, result });
      }

      // Funga trade MOJA (kwa contract_id).
      if (req.method === 'POST' && req.url === '/api/admin/fx/close') {
        const body = await readJsonBody(req);
        if (!body.contract_id) return sendJson(res, 400, { ok: false, error: 'contract_id inahitajika.' });
        const result = await derivTrader.closeContractWithPnL(body.contract_id);

        const profit = Number(result?.profit);
        notifyOwnerWA(
          `🖥️ *TRADE IMEFUNGWA (Dashboard)*\n\n` +
            (Number.isFinite(profit)
              ? `${profit >= 0 ? '✅ FAIDA' : '🔴 HASARA'}: $${Math.abs(profit).toFixed(2)}\n`
              : `ℹ️ Imeshindwa kupata faida/hasara halisi — angalia .positions au Deriv moja kwa moja.\n`) +
            `🆔 Contract ID: ${body.contract_id}`
        );

        return sendJson(res, 200, { ok: true, result });
      }

      // Funga TRADES ZOTE zilizo wazi mara moja ("panic button").
      if (req.method === 'POST' && req.url === '/api/admin/fx/close-all') {
        const results = await derivTrader.closeAll();
        const totalProfit = results
          .filter((r) => r.ok && Number.isFinite(r.profit))
          .reduce((sum, r) => sum + r.profit, 0);
        const missingCount = results.filter((r) => r.ok && !Number.isFinite(r.profit)).length;
        notifyOwnerWA(
          `🖥️ *TRADES ZOTE ZIMEFUNGWA (Dashboard)*\n\nJumla: ${results.length}\n` +
            `Zilizofanikiwa: ${results.filter((r) => r.ok).length}\n` +
            `${totalProfit >= 0 ? '✅ FAIDA' : '🔴 HASARA'} (jumla): $${Math.abs(totalProfit).toFixed(2)}` +
            (missingCount ? `\n_(${missingCount} bila faida/hasara halisi)_` : '')
        );
        return sendJson(res, 200, { ok: true, results });
      }

      // Signal ya jozi MOJA kwa hiari (bonyeza "Angalia" kwenye dashboard) —
      // haihusiani na auto-trader, inatumika kuangalia jozi yoyote papo hapo.
      if (req.method === 'GET' && req.url.split('?')[0] === '/api/admin/fx/signal') {
        const query = new URLSearchParams(req.url.split('?')[1] || '');
        const code = (query.get('pair') || '').toUpperCase();
        const symbol = FX_SYMBOL_MAP[code];
        if (!symbol) return sendJson(res, 400, { ok: false, error: `Jozi "${code}" haitambuliki.` });

        // daily:true => dashboard inaonyesha signal ileile ambayo auto-trader
        // ingeitumia (gate ya 4h + 1day), ili uamue trade ya mkono kwa data sawa.
        const snapshot = await fetchForexSnapshot(symbol, DEFAULT_INTERVAL, { daily: true });
        const sig = computeSignal(snapshot);
        return sendJson(res, 200, {
          ok: true,
          code,
          direction: sig.direction,
          strength: sig.strength,
          rawDirection: sig.rawDirection,
          rawStrength: sig.rawStrength,
          gated: sig.gated || null,
          trends: getTrends(snapshot),
          notes: sig.notes,
          price: snapshot.price,
          atr: snapshot.atr,
          checkedAt: Date.now(),
        });
      }

      // ── Group la signals + matokeo (profit/loss) — Deriv & Pocket Option ──
      // UI: kadi ya "Group ya Signals" kwenye fxtrading.html na pocketoption.html.
      // Mpangilio: utils/signalTargets.js (unahifadhiwa Turso).
      if (req.url.split('?')[0] === '/api/admin/groups' && req.method === 'GET') {
        try {
          return sendJson(res, 200, { ok: true, groups: await signalTargets.listGroups() });
        } catch (err) {
          return sendJson(res, 503, { ok: false, error: err.message });
        }
      }
      if (req.url.split('?')[0] === '/api/admin/targets' && req.method === 'GET') {
        if (!signalTargets.isLoaded()) await signalTargets.load();
        return sendJson(res, 200, { ok: true, targets: signalTargets.getAll() });
      }
      if (req.url.split('?')[0] === '/api/admin/targets' && req.method === 'POST') {
        try {
          const body = await readJsonBody(req);
          const platform = String(body.platform || '');
          const saved = await signalTargets.set(platform, body);
          return sendJson(res, 200, { ok: true, platform, target: saved });
        } catch (err) {
          return sendJson(res, 400, { ok: false, error: err.message });
        }
      }
      if (req.url.split('?')[0] === '/api/admin/targets/test' && req.method === 'POST') {
        try {
          const body = await readJsonBody(req);
          await signalTargets.sendTest(String(body.platform || ''));
          return sendJson(res, 200, { ok: true });
        } catch (err) {
          return sendJson(res, 400, { ok: false, error: err.message });
        }
      }

      // ── Pocket Option (Binary/Turbo) — dashboard ──────────────────────
      // UI: pairing/public/pocketoption.html. Inatumia utils/pocketOptionTrader.js
      // (bridge), pocketSignal.js (signals), pocketStore.js (historia) na
      // commands/utility/posignal.js (auto-signal) — kila kitu bila command za WhatsApp.
      if (req.url.startsWith('/api/admin/po/')) {
        const poPath = req.url.split('?')[0];
        const poQuery = new URL(req.url, 'http://x').searchParams;
        try {
          // Muhtasari: hali ya bridge + balance + trades + auto-signal.
          if (req.method === 'GET' && poPath === '/api/admin/po/overview') {
            const bridge = await pocketTrader.getBridgeStatus();
            let balance = null;
            if (bridge.ok && bridge.connected) {
              try { balance = await pocketTrader.getBalance(); } catch (_) { /* bridge bado inaunganisha */ }
            }
            const trades = await pocketStore.getTradeHistory(300);
            return sendJson(res, 200, {
              ok: true,
              bridge,
              balance,
              trades,
              auto: posignalCmd.getAutoStatus(),
              autotrade: pocketAuto.getStatus(),
              autotradeStats: await pocketAuto.getStats(),
              pairs: pocketSignal.DEFAULT_PAIRS,
              scanModes: pocketSignal.SCAN_MODES,
              ownerJid: getOwnerJid(),
            });
          }

          // Historia KAMILI ya trades (kwa export): ?limit=N (default 20000, max 20000). Overview inabaki ndogo (300).
          if (req.method === 'GET' && poPath === '/api/admin/po/history') {
            const limit = Math.max(1, Math.min(parseInt(poQuery.get('limit') || '20000', 10) || 20000, 20000));
            const trades = await pocketStore.getTradeHistory(limit, { full: true });
            return sendJson(res, 200, { ok: true, count: trades.length, trades });
          }

          // Futa historia ya trades (reset ya rekodi). Hatua 2: preview (hakuna kinachofutwa) kisha delete (confirm:true).
          // Body: { mode:'all'|'date'|'last'|'first'|'range', from?, to?, count?, includeSignals?, confirm? }
          // Trades zilizo wazi hazifutwi. Baada ya kufuta, auto-trader inalinganisha P/L ya leo/hasara mfululizo na DB.
          if (req.method === 'POST' && (poPath === '/api/admin/po/history/preview' || poPath === '/api/admin/po/history/delete')) {
            const body = await readJsonBody(req);
            const opts = {
              mode: String(body.mode || ''),
              from: body.from,
              to: body.to,
              count: body.count,
              includeSignals: body.includeSignals === true,
            };
            if (poPath.endsWith('/preview')) {
              const pv = await pocketStore.previewDeleteTrades(opts);
              return sendJson(res, pv.ok ? 200 : 400, pv);
            }
            if (body.confirm !== true) return sendJson(res, 400, { ok: false, error: 'Uthibitisho unahitajika (confirm).' });
            // Kinga: kinachofutwa lazima kiwe kile kile ulichoonyeshwa kwenye preview (data haijabadilika).
            if (body.expectCount != null) {
              const now = await pocketStore.previewDeleteTrades(opts);
              if (!now.ok) return sendJson(res, 400, now);
              if (now.count !== Number(body.expectCount)) {
                return sendJson(res, 409, { ok: false, error: `Data imebadilika tangu preview (ilikuwa ${body.expectCount}, sasa ${now.count}). Bonyeza "Angalia" tena.` });
              }
            }
            const del = await pocketStore.deleteTrades(opts);
            if (!del.ok) return sendJson(res, 400, del);
            const risk = await pocketAuto.resyncRiskState().catch(() => null);
            notifyOwnerWA(
              `🖥️ *Historia ya Pocket Option imefutwa (Dashboard)*\n` +
                `🗑️ ${del.label}: *${del.deleted}* (W${del.wins}/L${del.losses}, P/L ${del.net >= 0 ? '+' : '-'}$${Math.abs(del.net).toFixed(2)})` +
                (del.signalsDeleted != null ? `\n📡 Signals zilizofutwa: ${del.signalsDeleted}` : ''),
              'dashboard'
            );
            return sendJson(res, 200, { ok: true, ...del, risk });
          }

          // Notifications za Pocket Option: swichi za DM kwa kila aina + anti-flood. GET = hali, POST = hifadhi.
          if (poPath === '/api/admin/po/notify-prefs') {
            if (req.method === 'GET') return sendJson(res, 200, { ok: true, prefs: await notifyPrefs.get(), categories: notifyPrefs.CATEGORIES });
            if (req.method === 'POST') {
              const body = await readJsonBody(req);
              return sendJson(res, 200, { ok: true, prefs: await notifyPrefs.set(body) });
            }
          }

          // Uchambuzi wa AI (Groq) wa historia ya Pocket Option: ?force=1 inapita cache.
          if (req.method === 'GET' && poPath === '/api/admin/po/analyze') {
            return sendJson(res, 200, await tradeAnalysis.analyze('po', { force: poQuery.get('force') === '1' }));
          }

          // Takwimu za win rate halisi za signals (kutoka signalTracker): ?days=7|30|90
          if (req.method === 'GET' && poPath === '/api/admin/po/signal-stats') {
            const days = Math.max(1, Math.min(parseInt(poQuery.get('days') || '7', 10) || 7, 90));
            return sendJson(res, 200, { ok: true, ...(await signalTracker.getDashboard(days)) });
          }

          // Signals za hivi karibuni zilizotumwa na auto-signal.
          if (req.method === 'GET' && poPath === '/api/admin/po/feed') {
            return sendJson(res, 200, { ok: true, signals: posignalCmd.getRecentSignals(), auto: posignalCmd.getAutoStatus() });
          }

          // Signal ya jozi MOJA (sawa na .posignal EURUSD 1m).
          if (req.method === 'GET' && poPath === '/api/admin/po/signal') {
            const pair = (poQuery.get('pair') || '').trim();
            const tf = pocketSignal.parseTimeframe(poQuery.get('tf'), 60);
            if (!pair) return sendJson(res, 400, { ok: false, error: 'Jozi (pair) inahitajika.' });
            if (!tf) return sendJson(res, 400, { ok: false, error: 'Timeframe si sahihi. Mfano: 1m, 5m.' });
            if (!(await pocketTrader.isBridgeUp())) return sendJson(res, 503, { ok: false, error: 'Pocket Option bridge haijaunganishwa.' });
            const result = await pocketSignal.analyzePair(pair, tf);
            return sendJson(res, 200, { ok: true, result, checkedAt: Date.now() });
          }

          // Scan ya jozi nyingi (sawa na .posignal scan [mode] [tf]) — inaweza kuchukua dakika 1-2.
          if (req.method === 'POST' && poPath === '/api/admin/po/scan') {
            const body = await readJsonBody(req);
            const tf = pocketSignal.parseTimeframe(body.tf, 60);
            const mode = pocketSignal.SCAN_MODES.includes(String(body.mode)) ? String(body.mode) : 'smart';
            const minStrength = Math.min(100, Math.max(30, parseInt(body.minStrength, 10) || 50));
            if (!tf) return sendJson(res, 400, { ok: false, error: 'Timeframe si sahihi. Mfano: 1m, 5m.' });
            if (!(await pocketTrader.isBridgeUp())) return sendJson(res, 503, { ok: false, error: 'Pocket Option bridge haijaunganishwa.' });
            const scan = mode === 'smart'
              ? await pocketSignal.scanPrioritized(tf, { minStrength })
              : await pocketSignal.scanPairs(await pocketSignal.getUniverse(mode), tf, { minStrength });
            return sendJson(res, 200, { ok: true, ...scan, tf, mode, minStrength, scannedAt: Date.now() });
          }

          // Fungua order (sawa na .pobuy / .posell).
          if (req.method === 'POST' && poPath === '/api/admin/po/open') {
            const body = await readJsonBody(req);
            const pair = String(body.pair || '').trim();
            const direction = body.direction === 'SELL' ? 'SELL' : 'BUY';
            const stake = Number(body.stake);
            const expiry = parseInt(body.expirySeconds, 10);
            if (!pair) return sendJson(res, 400, { ok: false, error: 'Jozi (pair) inahitajika.' });
            if (!(stake > 0)) return sendJson(res, 400, { ok: false, error: 'Stake lazima iwe zaidi ya 0.' });
            if (!(expiry >= 5)) return sendJson(res, 400, { ok: false, error: 'Expiry lazima iwe angalau sekunde 5.' });
            if (!(await pocketTrader.isBridgeUp())) return sendJson(res, 503, { ok: false, error: 'Pocket Option bridge haijaunganishwa.' });

            // Kinga ya marudio (double-click / lag): order moja kwa wakati, na order inayofanana
            // (jozi+mwelekeo+stake+expiry) haikubaliwi tena ndani ya sekunde 8.
            const poLock = global.__poOpenLock || (global.__poOpenLock = { busy: false, recent: new Map() });
            const dupKey = `${pair}|${direction}|${stake}|${expiry}`;
            if (poLock.busy) return sendJson(res, 429, { ok: false, error: 'Order nyingine inafunguliwa sasa — subiri ikamilike.' });
            if (Date.now() - (poLock.recent.get(dupKey) || 0) < 8000) {
              return sendJson(res, 429, { ok: false, error: 'Order inayofanana ilifunguliwa sekunde chache zilizopita — imezuiwa kuzuia marudio.' });
            }
            poLock.busy = true;
            poLock.recent.set(dupKey, Date.now());
            let result;
            try {
              result = await pocketTrader.placeOrder({ pair, direction, amount: stake, expirySeconds: expiry });
            } finally {
              poLock.busy = false;
            }
            notifyOwnerWA(
              `🖥️ *PO ORDER IMEFUNGULIWA (Dashboard)*\n\n` +
                `Jozi: *${pair}*\n` +
                `Mwelekeo: ${direction === 'BUY' ? '🟢 UP (BUY)' : '🔴 DOWN (SELL)'}\n` +
                `Stake: $${stake}  |  Expiry: ${expiry}s\n` +
                `🆔 Order ID: ${result.orderId}\n\n` +
                `⚠️ Order hii ilifunguliwa KWA MKONO kupitia admin dashboard.`,
              'dashboard'
            );
            return sendJson(res, 200, { ok: true, orderId: result.orderId });
          }

          // Matokeo ya order moja (sawa na .poresult) — inasubiri hadi expiry.
          if (req.method === 'GET' && poPath === '/api/admin/po/result') {
            const orderId = poQuery.get('orderId');
            if (!orderId) return sendJson(res, 400, { ok: false, error: 'orderId inahitajika.' });
            const result = await pocketTrader.getOrderResult(orderId);
            return sendJson(res, 200, { ok: true, result });
          }

          // Washa/zima auto-signal kwa WhatsApp ya owner (sawa na .posignal auto on|off).
          if (req.method === 'POST' && poPath === '/api/admin/po/auto') {
            const body = await readJsonBody(req);
            const jid = getOwnerJid();
            if (body.action === 'off') {
              const stopped = await posignalCmd.stopAutoFromDashboard(jid);
              return sendJson(res, 200, { ok: true, stopped, auto: posignalCmd.getAutoStatus() });
            }
            if (body.action !== 'on') return sendJson(res, 400, { ok: false, error: 'action lazima iwe on au off.' });
            const tf = pocketSignal.parseTimeframe(body.tf, 60);
            if (!tf || tf < 5) return sendJson(res, 400, { ok: false, error: 'Timeframe si sahihi. Mfano: 1m, 5m.' });
            const minStrength = Math.min(100, Math.max(30, parseInt(body.minStrength, 10) || 70));
            const mode = pocketSignal.SCAN_MODES.includes(String(body.mode)) ? String(body.mode) : 'smart';
            if (!global.currentSock) return sendJson(res, 503, { ok: false, error: 'Bot kuu haijaunganishwa na WhatsApp — auto-signal haiwezi kutuma.' });
            await posignalCmd.startAutoFromDashboard(global.currentSock, jid, { tf, minStrength, mode });
            return sendJson(res, 200, { ok: true, auto: posignalCmd.getAutoStatus() });
          }
          // ── BLACKLIST ya jozi za auto-trade ───────────────────────────────────
          // GET pair-stats?scope=tf|all: win rate + idadi ya trades kwa kila jozi (+ hali ya blacklist).
          // POST blocked { action: 'add'|'remove'|'clear'|'reset', pairs: [...] } — sawa na `.poauto block ...`
          if (req.method === 'GET' && poPath === '/api/admin/po/pair-stats') {
            const scope = poQuery.get('scope') === 'all' ? 'all' : 'tf';
            const st = pocketAuto.getStatus();
            const list = await pocketStore.getPairStats({ tf: scope === 'tf' ? st.tf : null });
            const pairs = list.map((p) => ({ ...p, blocked: pocketAuto.isBlockedPair(p.pair) }));
            const have = new Set(pairs.map((p) => pocketAuto.normPair(p.pair)));
            for (const b of st.blockedPairs || []) {
              if (!have.has(pocketAuto.normPair(b))) pairs.push({ pair: b, trades: 0, wins: 0, losses: 0, winRate: null, net: 0, payout: null, breakeven: null, blocked: true });
            }
            return sendJson(res, 200, { ok: true, scope, tf: st.tf, blockedCount: (st.blockedPairs || []).length, pairs });
          }
          if (req.method === 'POST' && poPath === '/api/admin/po/blocked') {
            const body = await readJsonBody(req);
            const action = String(body.action || '');
            if (!['add', 'remove', 'clear', 'reset'].includes(action)) {
              return sendJson(res, 400, { ok: false, error: 'action lazima iwe add, remove, clear au reset.' });
            }
            const r = await pocketAuto.editBlocked(action, Array.isArray(body.pairs) ? body.pairs : []);
            if (!r.ok) return sendJson(res, 400, { ok: false, error: r.error });
            const show = (a) => (a.length > 8 ? `jozi ${a.length}` : a.join(', '));
            const bits = [];
            if (r.added.length) bits.push(`➕ ${show(r.added)}`);
            if (r.removed.length) bits.push(`➖ ${show(r.removed)}`);
            if (bits.length) notifyOwnerWA(`🖥️ *Auto-trade blacklist (Dashboard)*\n${bits.join('\n')}\n🚫 Jumla zilizoondolewa: ${r.blocked.length}`, 'dashboard');
            return sendJson(res, 200, { ok: true, blocked: r.blocked });
          }
          // ── SAA za kutrade (EAT): takwimu kwa saa + zima/washa saa ─────────────
          // GET hour-stats?scope=tf|all&pairs=active|all • GET hour-trades?hour=H&result=all|win|loss&limit=N
          // POST hours { hours: [0-23,...] } — orodha kamili ya saa ambazo bot haifungui trade mpya.
          if (req.method === 'GET' && (poPath === '/api/admin/po/hour-stats' || poPath === '/api/admin/po/hour-trades')) {
            const st = pocketAuto.getStatus();
            const opts = {
              tf: poQuery.get('scope') === 'all' ? null : st.tf,
              exclude: poQuery.get('pairs') === 'all' ? null : (p) => pocketAuto.isBlockedPair(p),
            };
            if (poPath === '/api/admin/po/hour-stats') {
              const hours = await pocketStore.getHourStats(opts);
              return sendJson(res, 200, { ok: true, tzOffset: pocketStore.TZ_OFFSET_H, tf: st.tf, blockedHours: st.blockedHours || [], hours });
            }
            const hour = parseInt(poQuery.get('hour'), 10);
            if (!Number.isInteger(hour) || hour < 0 || hour > 23) return sendJson(res, 400, { ok: false, error: 'hour lazima iwe 0-23.' });
            const result = ['win', 'loss'].includes(poQuery.get('result')) ? poQuery.get('result') : 'all';
            const limit = Math.max(1, Math.min(parseInt(poQuery.get('limit') || '80', 10) || 80, 300));
            const d = await pocketStore.getHourTrades({ ...opts, hour, result, limit });
            return sendJson(res, 200, { ok: true, hour, total: d.total, trades: d.trades });
          }
          if (req.method === 'POST' && poPath === '/api/admin/po/hours') {
            const body = await readJsonBody(req);
            const r = await pocketAuto.setBlockedHours(body.hours);
            if (!r.ok) return sendJson(res, 400, { ok: false, error: r.error });
            const hh = (a) => a.map((h) => `${String(h).padStart(2, '0')}:00`).join(', ');
            const bits = [];
            if (r.added.length) bits.push(`⏸ Zimezimwa: ${hh(r.added)}`);
            if (r.removed.length) bits.push(`▶️ Zimewashwa: ${hh(r.removed)}`);
            if (bits.length) notifyOwnerWA(`🖥️ *Auto-trade saa (Dashboard)*\n${bits.join('\n')}\n⏰ Saa zilizozimwa sasa: ${r.hours.length ? hh(r.hours) : 'hakuna'}`, 'dashboard');
            return sendJson(res, 200, { ok: true, hours: r.hours });
          }
          // ── AUTO-TRADE (trade za kiotomatiki) — sawa na `.poauto ...` ──────────
          // GET: hali kamili. POST { action: 'on'|'off'|'resume'|'set', confirmReal?, settings? }
          if (poPath === '/api/admin/po/autotrade') {
            if (req.method === 'GET') {
              return sendJson(res, 200, { ok: true, autotrade: pocketAuto.getStatus(), stats: await pocketAuto.getStats() });
            }
            if (req.method === 'POST') {
              const body = await readJsonBody(req);
              const action = String(body.action || '');
              let note = null;
              if (action === 'on') {
                const r = await pocketAuto.enable({ confirmReal: body.confirmReal === true });
                if (r.needsConfirm) {
                  return sendJson(res, 409, { ok: false, needsConfirm: true, demo: r.demo, error: 'Akaunti ni REAL — uthibitisho unahitajika.' });
                }
                if (!r.ok) return sendJson(res, 400, { ok: false, error: r.error });
                note = `🖥️ *AUTO-TRADE IMEWASHWA (Dashboard)* — ${r.demo ? '🧪 DEMO' : '💰 REAL'}`;
              } else if (action === 'off') {
                await pocketAuto.disable();
                note = '🖥️ *AUTO-TRADE IMEZIMWA (Dashboard)*';
              } else if (action === 'resume') {
                pocketAuto.resume();
                note = '🖥️ Auto-trade: pause imeondolewa kupitia Dashboard.';
              } else if (action === 'set') {
                const r = await pocketAuto.setSettings(body.settings || {});
                if (!r.ok) return sendJson(res, 400, { ok: false, error: r.error });
                if (r.changed.length) {
                  note = `🖥️ *Auto-trade: mipangilio imebadilishwa (Dashboard)*\n` +
                    r.changed.map((c) => `• ${c.key}: ${c.previous} → ${c.value}`).join('\n');
                }
              } else {
                return sendJson(res, 400, { ok: false, error: 'action lazima iwe on, off, resume au set.' });
              }
              if (note) notifyOwnerWA(note, 'dashboard');
              return sendJson(res, 200, { ok: true, autotrade: pocketAuto.getStatus(), stats: await pocketAuto.getStats() });
            }
          }
        } catch (err) {
          console.error('[po dashboard] error:', err.message);
          return sendJson(res, 400, { ok: false, error: err.message });
        }
      }

      // Economic calendar (wiki hii) kwa currencies kuu 8 — inatumika
      // kwenye fxtrading.html kuonyesha matukio yajayo/yaliyopita kwa
      // wote (si jozi moja tu). Cache ya dakika 15 iko ndani ya
      // economicCalendar.js yenyewe (feed haibadiliki mara kwa mara).
      if (req.method === 'GET' && req.url === '/api/admin/fx/calendar') {
        const calendar = await economicCalendar.getWeekView();
        return sendJson(res, 200, { ok: true, ...calendar });
      }

      // AI predictions (calendar + technical signal kwa Groq) kwa jozi
      // zote 7 — cached upande wa server (dakika ~20, angalia
      // utils/fxPredictions.js) ili kuepuka gharama/rate-limit ya Groq.
      if (req.method === 'GET' && req.url === '/api/admin/fx/predictions') {
        const status = autoTrader.getStatus();
        const data = await fxPredictions.getPredictions(status.signals);
        return sendJson(res, 200, { ok: true, ...data });
      }

      // Backtest ya mkakati dhidi ya historia (utils/backtest.js) — inatumia
      // computeSignal/computeAtrBasedRisk ILE ILE ya live, tazama tab
      // "Backtest" kwenye fxtrading.html. Inaweza kuchukua sekunde kadhaa
      // (fetch candles + loop bar-by-bar), si "instant" kama routes nyingine.
      if (req.method === 'POST' && req.url === '/api/admin/fx/backtest') {
        const body = await readJsonBody(req);
        const code = String(body.pair || '').toUpperCase().replace(/[^A-Z]/g, '');
        const symbol = FX_SYMBOL_MAP[code] || (code.length === 6 ? `${code.slice(0, 3)}/${code.slice(3)}` : null);
        if (!symbol) return sendJson(res, 400, { ok: false, error: `Jozi "${body.pair || ''}" haitambuliki.` });

        try {
          const result = await runBacktest({
            code,
            symbol,
            bars: body.bars ? Number(body.bars) : undefined,
            stake: body.stake ? Number(body.stake) : undefined,
            multiplier: body.multiplier ? Number(body.multiplier) : undefined,
            strengthThreshold: body.strengthThreshold ? Number(body.strengthThreshold) : undefined,
          });
          return sendJson(res, 200, { ok: true, result });
        } catch (err) {
          return sendJson(res, 400, { ok: false, error: err.message });
        }
      }
    }

    // ── Customer billing (dashboard) ──────────────────────────────────
    if (req.method === 'GET' && req.url.startsWith('/api/dashboard/') && req.url.endsWith('/billing')) {
      const token = decodeURIComponent(req.url.split('/api/dashboard/')[1].replace('/billing', ''));
      const billing = await getBillingForToken(token);
      return sendJson(res, 200, { ok: true, ...billing, plans: cfg.PLANS });
    }

    if (req.method === 'POST' && req.url.startsWith('/api/dashboard/') && req.url.endsWith('/pay')) {
      const token = decodeURIComponent(req.url.split('/api/dashboard/')[1].replace('/pay', ''));
      const accountPhoneNumber = await getPhoneNumberByToken(token);
      if (!accountPhoneNumber) return sendJson(res, 404, { ok: false, error: 'Dashboard link si sahihi.' });

      const body = await readJsonBody(req);
      const plan = cfg.PLANS.find(p => p.days === Number(body.days));
      if (!plan) return sendJson(res, 400, { ok: false, error: 'Package hii haipo.' });

      // Namba ya kutuma USSD-push (mteja anaweza kulipia kwa namba TOFAUTI
      // na ile ya bot yake, mfano ya ndugu/rafiki) — default ni namba yake
      // ya bot iliyounganishwa. Akaunti inayopewa siku daima ni
      // accountPhoneNumber, bila kujali ni namba gani ililipia.
      const rawPaymentPhone = typeof body.paymentPhoneNumber === 'string' ? body.paymentPhoneNumber : '';
      const paymentPhoneNumber = normalizePhoneNumber(rawPaymentPhone) || accountPhoneNumber;
      if (paymentPhoneNumber.length < 9) {
        return sendJson(res, 400, { ok: false, error: 'Namba ya malipo si sahihi. Weka namba kamili yenye country code (mfano 2557XXXXXXXX).' });
      }

      // MUHIMU: orderReference LAZIMA ibaki herufi 20 au chini tangu hapa —
      // clickpesa.js inakata (bila taarifa) reference ndefu zaidi ya 20 kabla
      // ya kuituma ClickPesa, na ClickPesa inarudisha ile iliyokatwa kwenye
      // webhook. Kama tuliyohifadhi kwenye pending_orders ni ndefu zaidi,
      // getPendingOrder() haitaikuta reference ya webhook -> malipo
      // hayasajiliwi hata baada ya mteja kulipa kikamilifu (status inabaki
      // "unpaid"). Fomu hii ni herufi 20 kwa mbali sana (S + siku 6 za mwisho
      // za namba + timestamp base36), hivyo haigusiwi na ukataji huo kamwe.
      const orderReference = `S${accountPhoneNumber.slice(-6)}${Date.now().toString(36)}`;
      await insertPendingOrder(orderReference, accountPhoneNumber, plan.days, plan.price);

      try {
        await clickpesa.initiateUssdPush({ amount: plan.price, phoneNumber: paymentPhoneNumber, orderReference });
      } catch (e) {
        // Onyesha SABABU HALISI moja kwa moja kwenye UI (si logs tu) —
        // e.details ina jibu kamili la ClickPesa lililowekwa na
        // clickpesa.js, ili mteja/admin waone tatizo bila kufungua Railway.
        return sendJson(res, 400, { ok: false, error: e.message, details: e.details || null });
      }

      return sendJson(res, 200, {
        ok: true,
        message: 'Angalia simu ya ' + paymentPhoneNumber + ' — utaombwa kuweka PIN ya M-Pesa/Tigo Pesa/Airtel Money kukamilisha malipo.',
        orderReference,
      });
    }

    // ── Mteja anauliza hali ya malipo yake (dashboard.html inapiga hii kila sekunde chache) ──
    const payStatusMatch = req.method === 'GET' && /^\/api\/dashboard\/([^/?]+)\/pay-status\?ref=([A-Za-z0-9]+)/.exec(req.url);
    if (payStatusMatch) {
      const token = decodeURIComponent(payStatusMatch[1]);
      const ref = payStatusMatch[2];
      const phone = await getPhoneNumberByToken(token);
      if (!phone) return sendJson(res, 404, { ok: false, error: 'Dashboard link si sahihi.' });

      let status = 'NOT_FOUND'; // tayari imeshughulikiwa (webhook/reconciler) au haipo
      const order = await getPendingOrder(ref);
      if (order && order.phoneNumber === phone) {
        // Ukurasa unauliza kila sekunde chache — hii inasoma Turso tu. ClickPesa
        // inaulizwa mara chache tu (mayQueryStatus), webhook ndiyo inayothibitisha.
        const st = mayQueryStatus(order)
          ? await clickpesa.getPaymentStatus(ref).catch((e) => {
              console.error('[pay-status]', e.message);
              return null;
            })
          : null;
        if (st && PAID_STATUSES.includes(st.status)) {
          await settlePaidOrder(ref, st);
          status = 'PAID';
        } else if (st && st.status === 'FAILED') {
          await removePendingOrder(ref);
          status = 'FAILED';
        } else {
          status = 'PENDING';
        }
      }
      const billing = await getBillingForToken(token);
      return sendJson(res, 200, { ok: true, status, ...billing });
    }

    // ── ClickPesa webhook — called by ClickPesa, not the browser ───────
    // Muundo halisi wa ClickPesa: { event: 'PAYMENT RECEIVED', data: { status,
    // orderReference, paymentReference, collectedAmount, ... }, checksum,
    // checksumMethod } — taarifa za malipo ziko ndani ya `data`.
    if (req.method === 'POST' && req.url === '/api/payment/webhook') {
      const body = await readJsonBody(req);
      const data = (body && body.data) || body || {};
      const orderReference = data.orderReference;
      const event = String(body.event || '').toUpperCase();

      let status = String(data.status || '').toUpperCase();
      let paymentInfo = { paymentReference: data.paymentReference || null, collectedAmount: data.collectedAmount };

      if (body.checksum) {
        if (!clickpesa.verifyWebhookChecksum(body)) {
          console.error('[payment/webhook] checksum haikuthibitika:', JSON.stringify(body));
          return sendJson(res, 400, { ok: false, error: 'Invalid checksum' });
        }
      } else {
        // Checksum haijawashwa kwenye ClickPesa — hatuamini body; tunauliza
        // ClickPesa moja kwa moja hali halisi ya reference hii.
        console.warn('[payment/webhook] hakuna checksum — natumia status query ya ClickPesa badala yake.');
        const known = orderReference ? await getPendingOrder(orderReference) : null;
        const st = (known && !clickpesa.isBlocked())
          ? await clickpesa.getPaymentStatus(orderReference).catch(() => null)
          : null;
        status = st ? st.status : '';
        paymentInfo = st || paymentInfo;
      }

      const order = orderReference ? await getPendingOrder(orderReference) : null;
      const isSuccess = PAID_STATUSES.includes(status) && event !== 'PAYMENT FAILED';

      if (order && isSuccess) {
        await settlePaidOrder(orderReference, paymentInfo);
      } else if (order && !isSuccess) {
        console.log(`[payment/webhook] malipo ${orderReference} hayakufanikiwa: ${status || event}`);
        if (status === 'FAILED' || event === 'PAYMENT FAILED') await removePendingOrder(orderReference);
      } else {
        console.warn(`[payment/webhook] orderReference isiyojulikana au imeshashughulikiwa: ${orderReference}`);
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
    sendJson(res, 400, { ok: false, error: e.message, details: e.details || null });
  }
}

// Kazi za mara-moja tu wakati wa boot: schema ya Turso, ratiba ya reminder,
// na kurudisha bots zote za wateja walioshapaired kabla (baada ya restart).
// Piga hii mara MOJA tu (index.js au standalone start() chini), kamwe kwa
// kila ombi la HTTP.
let _pairingInitialized = false;
async function initPairingServer() {
  if (_pairingInitialized) return;
  _pairingInitialized = true;
  await db.initSchema(); // must finish before we accept any requests
  // Inarejesha database/groups.json, users.json, warnings.json, mods.json
  // kutoka Turso — muhimu hasa ikiwa faili hii inaendeshwa STANDALONE (deploy
  // tofauti na index.js — angalia comment ya "STANDALONE MODE" chini): bila
  // hii, mchakato huu (na kila instance ya pairing inayoendesha ndani yake)
  // usingepata mipangilio ya group iliyohifadhiwa kabla ya redeploy ya mwisho.
  // Salama kuita hata ikiwa index.js tayari imeiita (haifanyi kazi mara ya
  // pili bure — CREATE TABLE IF NOT EXISTS + soma tu).
  const groupDb = require('../database');
  await groupDb.initializeDatabase();
  startReminderScheduler();
  startPaymentReconciler();
  // Bring back every previously-paired customer's bot automatically —
  // sessions live in Turso, so this works even without a Railway Volume
  // (see restoreAllInstances()'s comment for details).
  await restoreAllInstances();

  // Auto-trade ya wateja (Deriv DEMO) — kila mteja kwenye akaunti yake; arifa zinaenda self-chat ya mteja husika.
  // Inahitaji idhini ya admin + mteja kwa kila akaunti; DERIV_CUSTOMER_AUTO_ENABLED=false inaizima yote.
  try {
    derivCustomerAuto.start({ notify: (phone, text) => sendToSelfChat(phone, text) });
  } catch (err) {
    console.error('❌ Imeshindwa kuanzisha auto-trade ya wateja:', err.message);
  }
}

module.exports = { handlePairingRequest, initPairingServer };

// ── STANDALONE MODE ──────────────────────────────────────────────────────
// Ikiwa faili hii inaendeshwa moja kwa moja (`node pairing/server.js`,
// project TOFAUTI ya Railway), fungua server yake mwenyewe kama zamani.
// Ikiwa imepachikwa (required) na index.js badala yake, sehemu hii chini
// haiendeshwi kabisa — index.js ndiyo inayoshikilia port na kuita
// handlePairingRequest/initPairingServer yenyewe.
if (require.main === module) {
  const server = http.createServer((req, res) => {
    handlePairingRequest(req, res);
  });

  initPairingServer()
    .then(() => {
      server.listen(PORT, () => {
        console.log(`🌐 Pairing website inaendesha kwenye port ${PORT} (standalone)`);
      });
    })
    .catch((err) => {
      console.error('❌ Imeshindwa kuanzisha server (angalia Turso credentials kwenye pairingConfig.js):', err.message);
      process.exit(1);
    });
}
