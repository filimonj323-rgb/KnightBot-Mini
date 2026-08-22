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

const SESSIONS_ROOT = path.join(__dirname, 'sessions');
if (!fs.existsSync(SESSIONS_ROOT)) fs.mkdirSync(SESSIONS_ROOT, { recursive: true });

const TOKENS_FILE = path.join(SESSIONS_ROOT, '_tokens.json');

// Optional custom pairing code. WhatsApp requires EXACTLY 8 uppercase
// alphanumeric characters. Set CUSTOM_PAIRING_CODE on Railway (Settings ->
// Variables) to override, e.g. "UMOJA4WA". Leave unset to let Baileys
// generate a random code as normal.
const RAW_CUSTOM_CODE = (process.env.CUSTOM_PAIRING_CODE || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const CUSTOM_PAIRING_CODE = RAW_CUSTOM_CODE.length === 8 ? RAW_CUSTOM_CODE : null;
if (RAW_CUSTOM_CODE && !CUSTOM_PAIRING_CODE) {
  console.warn(
    `[pairing] CUSTOM_PAIRING_CODE ("${RAW_CUSTOM_CODE}") si sahihi — inahitajika herufi 8 hasa (A-Z, 0-9). ` +
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

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === 'open') {
      record.status = 'connected';
      record.pairingCode = null;
      record.reconnectAttempts = 0;
      record.token = getOrCreateToken(phoneNumber);
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
  sock.ev.on('messages.upsert', (m) => {
    const msg = m.messages?.[0];
    if (!msg?.message) return;
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

module.exports = {
  createOrPairInstance,
  getInstanceStatus,
  normalizePhoneNumber,
  getPhoneNumberByToken,
  getInstanceByToken,
  listGroups,
  postGroupStatusForToken,
};
