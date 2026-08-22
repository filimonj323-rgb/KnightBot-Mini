/**
 * pairing/instanceManager.js
 *
 * Creates and tracks one independent WhatsApp bot connection per customer
 * phone number, all inside this single Node process. Every instance reuses
 * the SAME command set as the main bot (./handler.js + ./commands/*) — a
 * paired customer gets every command immediately, with no code duplication.
 *
 * This file is standalone and does not touch index.js / the main bot at all.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mediaDownloader = require('./mediaDownloader');
const userStore = require('./userStore');
const cfg = require('./pairingConfig');

const SESSIONS_ROOT = path.join(__dirname, 'sessions');
if (!fs.existsSync(SESSIONS_ROOT)) fs.mkdirSync(SESSIONS_ROOT, { recursive: true });

const TOKENS_FILE = path.join(SESSIONS_ROOT, '_tokens.json');
const SETTINGS_FILE = path.join(SESSIONS_ROOT, '_settings.json');

// Optional custom pairing code — edit CUSTOM_PAIRING_CODE in pairingConfig.js.
// WhatsApp requires EXACTLY 8 uppercase alphanumeric characters, and often
// rejects custom codes anyway (see earlier notes) — leave null to use
// Baileys' normal random codes (recommended).
const RAW_CUSTOM_CODE = (cfg.CUSTOM_PAIRING_CODE || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const CUSTOM_PAIRING_CODE = RAW_CUSTOM_CODE.length === 8 ? RAW_CUSTOM_CODE : null;
if (cfg.CUSTOM_PAIRING_CODE && !CUSTOM_PAIRING_CODE) {
  console.warn(
    `[pairing] CUSTOM_PAIRING_CODE ("${cfg.CUSTOM_PAIRING_CODE}") si sahihi — inahitajika herufi 8 hasa (A-Z, 0-9). ` +
    'Baileys itatengeneza code ya nasibu badala yake.'
  );
}

// phoneNumber -> { sock, status, pairingCode, createdAt, phoneNumber, token, reconnectAttempts }
const instances = new Map();
// token -> phoneNumber
const tokenIndex = new Map();

function loadTokenIndex() {
  try {
    const raw = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
    Object.entries(raw).forEach(([token, phoneNumber]) => tokenIndex.set(token, phoneNumber));
  } catch (e) {
    // No token file yet — fine on first run.
  }
}

function persistTokenIndex() {
  const obj = {};
  tokenIndex.forEach((phoneNumber, token) => { obj[token] = phoneNumber; });
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(obj, null, 2));
}

loadTokenIndex();

function getOrCreateToken(phoneNumber) {
  for (const [token, num] of tokenIndex.entries()) {
    if (num === phoneNumber) return token;
  }
  const token = crypto.randomBytes(24).toString('hex');
  tokenIndex.set(token, phoneNumber);
  persistTokenIndex();
  return token;
}

function getPhoneNumberByToken(token) {
  return tokenIndex.get(token) || null;
}

// ─────────────────────────────────────────────────────────────────────────
// Per-customer settings (prefix, bot display name) — BOTH OPTIONAL.
//
// config.js is a single shared file/module used by every customer instance
// running in this same process (handler.js requires it once). Mutating it
// directly (like commands/owner/setprefix.js does) changes the prefix for
// EVERY customer at once, not just the one who set it — not safe for this
// multi-tenant pairing server. Instead, each customer's override is kept
// here, persisted to its own JSON file, and attached to that customer's
// `sock` object (sock.instanceSettings) when their connection is opened.
// handler.js reads sock.instanceSettings first and only falls back to the
// shared config.js when a customer hasn't set a custom value — that's what
// makes both fields optional.
// ─────────────────────────────────────────────────────────────────────────
const settingsIndex = new Map(); // phoneNumber -> { prefix?, botName? }

function loadSettingsIndex() {
  try {
    const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    Object.entries(raw).forEach(([phoneNumber, settings]) => settingsIndex.set(phoneNumber, settings));
  } catch (e) {
    // No settings file yet — fine on first run.
  }
}

function persistSettingsIndex() {
  const obj = {};
  settingsIndex.forEach((settings, phoneNumber) => { obj[phoneNumber] = settings; });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(obj, null, 2));
}

loadSettingsIndex();

function getInstanceSettings(phoneNumber) {
  return settingsIndex.get(phoneNumber) || {};
}

// Base URL used to build the dashboard link sent to customers over WhatsApp.
// Edit PAIRING_BASE_URL in pairing/pairingConfig.js to your public domain,
// e.g. "https://your-app.up.railway.app".
const PUBLIC_BASE_URL = (cfg.PAIRING_BASE_URL || 'https://pairingpage.up.railway.app').replace(/\/+$/, '');

function dashboardUrl(token) {
  return `${PUBLIC_BASE_URL}/dashboard.html?token=${token}`;
}

function successMessageText(token) {
  return (
    '🎉 *Umefanikiwa kuunganisha Bot!*\n\n' +
    'Bot yako sasa iko tayari kutumika na commands zote.\n\n' +
    '📊 Link yako binafsi ya kudhibiti bot (kutuma group status, n.k.):\n' +
    dashboardUrl(token) + '\n\n' +
    '💡 Hifadhi (bookmark) link hii — ni yako binafsi, usiishiriki na wengine.\n' +
    'Ukiisahau, rudi kwenye website ya pairing na tumia "Umesahau link?" kwa namba yako hii hii.'
  );
}

/**
 * Sends the customer their dashboard link over WhatsApp (to their own
 * inbox, i.e. "Message Yourself"), with a success message. Called right
 * after a successful connection, and also from resendDashboardLink().
 */
async function sendDashboardLinkMessage(sock, phoneNumber, token) {
  try {
    const selfJid = `${phoneNumber}@s.whatsapp.net`;
    await sock.sendMessage(selfJid, { text: successMessageText(token) });
  } catch (e) {
    console.error(`[pairing:${phoneNumber}] imeshindwa kutuma dashboard link:`, e.message);
  }
}

let baileysBridgeLoaded = false;
let makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason;
let handler;

/**
 * Loads @itsliaaa/baileys (ESM-only) into this CommonJS project via dynamic
 * import(), same bridge pattern used in index.js. Safe to call from multiple
 * places — only loads once. If index.js already loaded it into
 * global.__baileys in the SAME process, this reuses that instead of loading
 * a second copy.
 */
async function ensureBaileysBridge() {
  if (baileysBridgeLoaded) return;

  const baileys = global.__baileys || (await import('@itsliaaa/baileys'));
  global.__baileys = baileys;
  ({
    default: makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    DisconnectReason
  } = baileys);

  // handler.js reads `global.__baileys` at require-time, and only needs to
  // be required once — require() caches the module, so calling this again
  // from index.js (if both run in one process) is harmless.
  handler = require('../handler');

  baileysBridgeLoaded = true;
}

function normalizePhoneNumber(raw) {
  return String(raw || '').replace(/[^0-9]/g, '');
}

function sanitizeFolderName(phoneNumber) {
  return phoneNumber.replace(/[^0-9]/g, '');
}

/**
 * Returns the current status of an instance, or null if it has never been
 * created in this process.
 */
function getInstanceStatus(phoneNumber) {
  const key = normalizePhoneNumber(phoneNumber);
  const inst = instances.get(key);
  if (!inst) return null;
  return {
    phoneNumber: inst.phoneNumber,
    status: inst.status, // 'pairing' | 'connecting' | 'connected' | 'disconnected' | 'error'
    pairingCode: inst.pairingCode || null,
    error: inst.error || null,
    dashboardToken: inst.token || null,
  };
}

/**
 * Opens (or re-opens) the actual WhatsApp socket for a phone number and
 * wires up its event handlers. Called once to start pairing, then called
 * AGAIN automatically whenever the connection drops for a reason other than
 * being logged out — this is required by Baileys: after a pairing code is
 * approved on the phone, WhatsApp closes the socket once with a
 * "restart required" reason, and the client must reconnect using the SAME
 * auth state to actually finish linking. Without this reconnect, a pairing
 * code the customer approves on their phone will show a notification but
 * the link will never complete — which is the exact symptom this fixes.
 */
async function connectInstance(phoneNumber, sessionFolder, record, isReconnect) {
  const { state, saveCreds } = await useMultiFileAuthState(sessionFolder);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    logger: require('pino')({ level: 'silent' }),
    printQRInTerminal: false,
    browser: ['Ubuntu', 'Chrome', '20.0.04'],
    auth: state,
    syncFullHistory: false,
    downloadHistory: false,
    markOnlineOnConnect: false,
  });

  record.sock = sock;
  // Attach this customer's optional overrides (prefix / bot name) so
  // handler.js can prefer them over the shared config.js — see the
  // settingsIndex comment above for why this can't just mutate config.js.
  sock.instanceSettings = getInstanceSettings(phoneNumber);

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === 'open') {
      record.status = 'connected';
      record.pairingCode = null;
      record.reconnectAttempts = 0;
      const isFirstConnect = !record.token;
      record.token = getOrCreateToken(phoneNumber);
      if (isFirstConnect) {
        sendDashboardLinkMessage(sock, phoneNumber, record.token);
      }

      // If trial/subscription has already lapsed by the time they reconnect,
      // let them know once (not on every reconnect) with a link to pay.
      const access = userStore.getAccessStatus(phoneNumber);
      if (!access.allowed && !access.user.expiryNotifiedAt) {
        const selfJid = `${phoneNumber}@s.whatsapp.net`;
        const reasonText = access.reason === 'blocked'
          ? 'Akaunti yako imezuiwa na msimamizi.'
          : 'Muda wako wa majaribio (trial) umeisha.';
        sock.sendMessage(selfJid, {
          text: `⏰ *${reasonText}*\n\nBot yako haitajibu ujumbe hadi ulipe.\n\n💳 Lipa kupitia dashboard yako:\n${dashboardUrl(record.token)}`,
        }).catch(() => {});
        userStore.markExpiryNotified(phoneNumber);
      }
      return;
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = DisconnectReason && statusCode === DisconnectReason.loggedOut;

      if (loggedOut) {
        record.status = 'disconnected';
        instances.delete(phoneNumber);
        return;
      }

      record.reconnectAttempts = (record.reconnectAttempts || 0) + 1;

      // Cap retries so a persistently failing link doesn't hammer WhatsApp
      // and trip their rate limit ("connection closed" repeatedly).
      if (record.reconnectAttempts > 6) {
        record.status = 'error';
        record.error = 'Imeshindwa kuunganisha baada ya majaribio kadhaa. Bofya "Pata Pairing Code" tena baada ya dakika chache.';
        instances.delete(phoneNumber);
        return;
      }

      record.status = 'connecting';
      const backoffMs = Math.min(2000 * record.reconnectAttempts, 10000);
      setTimeout(() => {
        connectInstance(phoneNumber, sessionFolder, record, true).catch((e) => {
          record.status = 'error';
          record.error = e.message;
        });
      }, backoffMs);
    }
  });

  // Every message this customer's number receives is routed through the
  // SAME command handler as the main bot — same commands/*, no duplication.
  // BUT first check trial/payment access: once a customer's trial (or paid
  // subscription) has lapsed and an admin hasn't blocked/unblocked them
  // otherwise, the bot goes silent for their instance until they pay —
  // this is the actual enforcement point for the whole trial/billing system.
  sock.ev.on('messages.upsert', (m) => {
    const msg = m.messages?.[0];
    if (!msg?.message) return;

    const access = userStore.getAccessStatus(phoneNumber);
    if (!access.allowed) return;

    handler.handleMessage(sock, msg).catch(err => {
      console.error(`[pairing:${phoneNumber}] handleMessage error:`, err.message);
    });
  });

  // Only ever request a pairing code on the FIRST connection attempt, never
  // on the automatic reconnects above — requesting a fresh code on every
  // reconnect is what causes both "code sometimes doesn't show" and
  // "reaches the closed limit" (WhatsApp treats repeated pairing-code
  // requests as abuse and starts closing/blocking the socket).
  if (!state.creds.registered && !isReconnect) {
    try {
      // Baileys needs the underlying WebSocket handshake with WhatsApp to
      // fully settle before it will accept a pairing-code request. Asking
      // immediately after makeWASocket() throws "Connection Closed" (428
      // Precondition Required) — a well-known Baileys race condition.
      const code = await new Promise((resolve, reject) => {
        setTimeout(() => {
          sock.requestPairingCode(phoneNumber, CUSTOM_PAIRING_CODE || undefined)
            .then(resolve)
            .catch(reject);
        }, 3000);
      });
      record.pairingCode = code;
      record.status = 'pairing';
    } catch (e) {
      record.status = 'error';
      record.error = e.message;
      throw e;
    }
  } else if (!state.creds.registered && isReconnect) {
    // Mid-pairing reconnect (e.g. after the "restart required" close) —
    // keep showing the SAME code the customer already has; just let this
    // new socket continue the handshake in the background.
    record.status = 'pairing';
  } else {
    // Already has valid creds from a previous run — just reconnecting.
    record.status = 'connecting';
  }
}

/**
 * Starts (or resumes) a bot instance for one phone number and requests a
 * pairing code for it. Resolves once the pairing code is ready — the actual
 * WhatsApp connection completes asynchronously afterwards; poll
 * getInstanceStatus() to see when status becomes 'connected'.
 */
async function createOrPairInstance(rawPhoneNumber) {
  await ensureBaileysBridge();

  const phoneNumber = normalizePhoneNumber(rawPhoneNumber);
  if (!phoneNumber || phoneNumber.length < 9) {
    throw new Error('Namba ya simu si sahihi. Weka namba kamili yenye country code (mfano 2557XXXXXXXX).');
  }

  const existing = instances.get(phoneNumber);
  if (existing && existing.status === 'connected') {
    return { phoneNumber, status: 'connected', pairingCode: null };
  }
  if (existing && existing.status === 'pairing' && existing.pairingCode) {
    // Already mid-pairing — return the same code instead of starting over.
    return { phoneNumber, status: 'pairing', pairingCode: existing.pairingCode };
  }

  const sessionFolder = path.join(SESSIONS_ROOT, sanitizeFolderName(phoneNumber));
  if (!fs.existsSync(sessionFolder)) fs.mkdirSync(sessionFolder, { recursive: true });

  const record = {
    phoneNumber,
    sock: null,
    status: 'pairing',
    pairingCode: null,
    error: null,
    createdAt: Date.now(),
    reconnectAttempts: 0,
  };
  instances.set(phoneNumber, record);
  userStore.ensureUser(phoneNumber); // starts their trial clock now, if new

  await connectInstance(phoneNumber, sessionFolder, record, false);

  return { phoneNumber, status: record.status, pairingCode: record.pairingCode };
}

/**
 * Looks up a live instance record by dashboard token. Returns null if the
 * token is unknown or the instance isn't connected in this process (e.g.
 * after a redeploy — the customer would need to re-pair; see the storage
 * caveat in pairing/server.js).
 */
function getInstanceByToken(token) {
  const phoneNumber = getPhoneNumberByToken(token);
  if (!phoneNumber) return null;
  return instances.get(phoneNumber) || null;
}

/**
 * Lists the WhatsApp groups this customer's bot instance is a member of —
 * used by the dashboard to populate a "post status to" picker.
 */
async function listGroups(token) {
  const inst = getInstanceByToken(token);
  if (!inst) throw new Error('Dashboard link si sahihi au bot haijaunganishwa.');
  if (inst.status !== 'connected') throw new Error('Bot bado haijaunganishwa kikamilifu.');

  const chats = await inst.sock.groupFetchAllParticipating();
  return Object.values(chats).map(g => ({
    id: g.id,
    subject: g.subject,
    participants: g.participants.length,
  }));
}

/**
 * Posts a group status (text, or image/video with optional caption) from
 * the dashboard, using the same groupStatus:true mechanism the WhatsApp
 * commands (commands/admin/groupstatus.js, commands/owner/groupmanager.js)
 * already use.
 */
async function postGroupStatusForToken(token, { groupId, text, caption, imageBase64, videoBase64 }) {
  const inst = getInstanceByToken(token);
  if (!inst) throw new Error('Dashboard link si sahihi au bot haijaunganishwa.');
  if (inst.status !== 'connected') throw new Error('Bot bado haijaunganishwa kikamilifu.');
  if (!groupId) throw new Error('Chagua group ya kutuma status.');

  let payload;
  if (imageBase64) {
    payload = { image: Buffer.from(imageBase64, 'base64'), caption: caption || '' };
  } else if (videoBase64) {
    payload = { video: Buffer.from(videoBase64, 'base64'), caption: caption || '' };
  } else if (text) {
    payload = { text, backgroundColor: '#9C27B0' };
  } else {
    throw new Error('Weka maandishi au chagua picha/video.');
  }

  payload.groupStatus = true;

  const targets = groupId === 'all'
    ? Object.keys(await inst.sock.groupFetchAllParticipating())
    : [groupId];

  let success = 0;
  let failed = 0;
  for (const gid of targets) {
    try {
      await inst.sock.sendMessage(gid, payload);
      success++;
      if (targets.length > 1) await new Promise(r => setTimeout(r, 1500));
    } catch (e) {
      failed++;
    }
  }

  return { success, failed, total: targets.length };
}

/**
 * Sends a normal chat message (text, or image/video with optional caption)
 * to one or more groups at once — used by the dashboard's "Tuma Ujumbe kwa
 * Groups" picker. Unlike postGroupStatusForToken(), this posts a REGULAR
 * group message (no groupStatus:true flag), and accepts an array of group
 * ids so the customer can broadcast to several groups in one go.
 */
async function sendMessageToGroups(token, { groupIds, text, caption, imageBase64, videoBase64 }) {
  const inst = getInstanceByToken(token);
  if (!inst) throw new Error('Dashboard link si sahihi au bot haijaunganishwa.');
  if (inst.status !== 'connected') throw new Error('Bot bado haijaunganishwa kikamilifu.');
  if (!Array.isArray(groupIds) || groupIds.length === 0) {
    throw new Error('Chagua angalau group moja.');
  }

  let payload;
  if (imageBase64) {
    payload = { image: Buffer.from(imageBase64, 'base64'), caption: caption || '' };
  } else if (videoBase64) {
    payload = { video: Buffer.from(videoBase64, 'base64'), caption: caption || '' };
  } else if (text) {
    payload = { text };
  } else {
    throw new Error('Weka maandishi au chagua picha/video.');
  }

  const targets = groupIds.includes('all')
    ? Object.keys(await inst.sock.groupFetchAllParticipating())
    : groupIds;

  let success = 0;
  let failed = 0;
  for (const gid of targets) {
    try {
      await inst.sock.sendMessage(gid, payload);
      success++;
      if (targets.length > 1) await new Promise(r => setTimeout(r, 1500));
    } catch (e) {
      failed++;
    }
  }

  return { success, failed, total: targets.length };
}

/**
 * Dashboard "Downloads" section — step 1: resolve a user-typed song/video
 * name or a pasted YouTube link into preview info (title, thumbnail,
 * duration) so the customer can confirm before actually downloading
 * anything. Only requires a valid dashboard token (doesn't need the bot
 * socket to be connected — this doesn't touch WhatsApp at all).
 */
async function previewMediaForToken(token, input) {
  if (!getPhoneNumberByToken(token)) {
    throw new Error('Dashboard link si sahihi. Tumia link uliyopewa baada ya kuunganisha.');
  }
  return mediaDownloader.previewMedia(input);
}

/**
 * Dashboard "Downloads" section — step 2: called only when the customer
 * presses "Pakua". Resolves a real, direct download URL for the given
 * YouTube link (mp3 or mp4) so pairing/server.js can stream the file
 * straight to the browser.
 */
async function resolveMediaDownloadForToken(token, youtubeUrl, type) {
  if (!getPhoneNumberByToken(token)) {
    throw new Error('Dashboard link si sahihi. Tumia link uliyopewa baada ya kuunganisha.');
  }
  return mediaDownloader.resolveDownload(youtubeUrl, type);
}

/**
 * Dashboard "Settings" — reads a customer's current prefix/botName
 * overrides (either may be unset, meaning "use the default"), plus the
 * defaults themselves so the dashboard can show helpful placeholders.
 */
function getSettingsForToken(token) {
  const phoneNumber = getPhoneNumberByToken(token);
  if (!phoneNumber) throw new Error('Dashboard link si sahihi.');
  const defaults = require('../config');
  const custom = getInstanceSettings(phoneNumber);
  return {
    prefix: custom.prefix || '',
    botName: custom.botName || '',
    defaultPrefix: defaults.prefix,
    defaultBotName: defaults.botName,
  };
}

/**
 * Dashboard "Settings" — save a customer's optional prefix / bot name.
 * Passing an empty string / omitting a field clears that override so the
 * instance falls back to the shared default again. Applies immediately to
 * a live connection (no restart needed) by updating sock.instanceSettings.
 */
function updateSettingsForToken(token, { prefix, botName }) {
  const phoneNumber = getPhoneNumberByToken(token);
  if (!phoneNumber) throw new Error('Dashboard link si sahihi.');

  const trimmedPrefix = typeof prefix === 'string' ? prefix.trim() : '';
  if (trimmedPrefix && trimmedPrefix.length > 3) {
    throw new Error('Prefix isiwe zaidi ya herufi 3.');
  }
  const trimmedName = typeof botName === 'string' ? botName.trim() : '';
  if (trimmedName && trimmedName.length > 40) {
    throw new Error('Jina la bot lisizidi herufi 40.');
  }

  const next = {};
  if (trimmedPrefix) next.prefix = trimmedPrefix;
  if (trimmedName) next.botName = trimmedName;

  if (Object.keys(next).length === 0) {
    settingsIndex.delete(phoneNumber);
  } else {
    settingsIndex.set(phoneNumber, next);
  }
  persistSettingsIndex();

  // Live-update the running connection, if any, so the change is instant.
  const inst = instances.get(phoneNumber);
  if (inst?.sock) {
    inst.sock.instanceSettings = next;
  }

  return getSettingsForToken(token);
}

/**
 * Re-sends the dashboard link to a customer who already connected but lost
 * (forgot) their link. Only works if the instance is still live in THIS
 * process (i.e. no redeploy happened since they connected) and connected.
 */
async function resendDashboardLink(rawPhoneNumber) {
  const phoneNumber = normalizePhoneNumber(rawPhoneNumber);
  const inst = instances.get(phoneNumber);

  if (!inst || inst.status !== 'connected' || !inst.sock) {
    throw new Error('Namba hii haijaunganishwa kwa sasa. Tumia "Pata Pairing Code" kuunganisha upya.');
  }

  const token = inst.token || getOrCreateToken(phoneNumber);
  inst.token = token;
  await sendDashboardLinkMessage(inst.sock, phoneNumber, token);
  return { phoneNumber, sent: true };
}

/**
 * Admin dashboard — full list of customers, merging persisted trial/paid
 * status (userStore) with live connection status (this process' instances
 * map, if the process hasn't been redeployed since they connected).
 */
function adminListUsers() {
  return userStore.getAllUsers().map((u) => {
    const live = instances.get(u.phoneNumber);
    return {
      ...u,
      liveStatus: live ? live.status : 'offline',
      dashboardToken: live ? live.token : null,
    };
  }).sort((a, b) => b.pairedAt - a.pairedAt);
}

function adminMarkPaid(phoneNumber, days, meta) {
  return userStore.markPaid(normalizePhoneNumber(phoneNumber), days, meta);
}

function adminExtendTrial(phoneNumber, days) {
  return userStore.extendTrial(normalizePhoneNumber(phoneNumber), days);
}

function adminSetBlocked(phoneNumber, blocked) {
  return userStore.setBlocked(normalizePhoneNumber(phoneNumber), blocked);
}

/**
 * Dashboard "Billing" tab — a customer's own trial/paid status, used to
 * show a countdown / pay button on their dashboard.html.
 */
function getBillingForToken(token) {
  const phoneNumber = getPhoneNumberByToken(token);
  if (!phoneNumber) throw new Error('Dashboard link si sahihi.');
  const access = userStore.getAccessStatus(phoneNumber);
  return {
    allowed: access.allowed,
    reason: access.reason,
    trialExpiresAt: access.user.trialExpiresAt,
    isPaid: access.user.isPaid,
    paidUntil: access.user.paidUntil,
  };
}

module.exports = {
  createOrPairInstance,
  getInstanceStatus,
  normalizePhoneNumber,
  getPhoneNumberByToken,
  getInstanceByToken,
  listGroups,
  postGroupStatusForToken,
  sendMessageToGroups,
  previewMediaForToken,
  resolveMediaDownloadForToken,
  getSettingsForToken,
  updateSettingsForToken,
  resendDashboardLink,
  adminListUsers,
  adminMarkPaid,
  adminExtendTrial,
  adminSetBlocked,
  getBillingForToken,
};
