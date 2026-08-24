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
const os = require('os');
const crypto = require('crypto');
const mediaDownloader = require('./mediaDownloader');
const userStore = require('./userStore');
const cfg = require('./pairingConfig');
const db = require('./db');
// Group-wise protection (antilink/antigroupmention/antipromo) reuses the
// SAME JSON-file group settings store the WhatsApp commands already use
// (commands/admin/antilink.js etc.) — one source of truth, no duplication.
const groupDb = require('../database');

const SESSIONS_ROOT = path.join(__dirname, 'sessions');
if (!fs.existsSync(SESSIONS_ROOT)) fs.mkdirSync(SESSIONS_ROOT, { recursive: true });

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

// ── Dashboard tokens (Turso — lives outside Railway, survives redeploys
// AND account/host changes) ────────────────────────────────────────────
async function getOrCreateToken(phoneNumber) {
  const existing = await db.query('SELECT token FROM tokens WHERE phoneNumber = ?', [phoneNumber]);
  if (existing.rows.length) return existing.rows[0].token;
  const token = crypto.randomBytes(24).toString('hex');
  await db.query('INSERT INTO tokens (token, phoneNumber) VALUES (?, ?)', [token, phoneNumber]);
  return token;
}

async function getPhoneNumberByToken(token) {
  const res = await db.query('SELECT phoneNumber FROM tokens WHERE token = ?', [token]);
  return res.rows.length ? res.rows[0].phoneNumber : null;
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
// Automation toggles ("Vipengele vya Kiotomatiki" kwenye dashboard) — kila
// moja ni boolean, default false hadi mteja aiwashe mwenyewe. Zinahifadhiwa
// kama JSON moja kwenye safu ya `automation`, kisha zinaunganishwa gorofa
// (flat) na prefix/botName kwenye sock.instanceSettings, kwa sababu
// handler.js inasoma effectiveConfig = { ...config, ...sock.instanceSettings }
// — funguo hizi lazima ziwe gorofa ili zilingane na majina ya config.js
// (autoTyping, autoRecording, autoReactStatus) au kutumiwa moja kwa moja
// (autoViewStatus, autoReactMessages) na mantiki ya per-instance.
const AUTOMATION_KEYS = ['autoViewStatus', 'autoReactStatus', 'autoTyping', 'autoRecording', 'autoReactMessages'];

// Dashboard feature name -> jina la field kwenye database.js (groups.json),
// lile lile linalotumiwa na commands/admin/antilink.js na antigroupmention.js.
const PROTECTION_FEATURES = {
  antiGroupMention: 'antigroupmention',
  antiPromo: 'antipromo',
  antiLink: 'antilink',
};

async function getInstanceSettings(phoneNumber) {
  const res = await db.query('SELECT prefix, botName, automation FROM settings WHERE phoneNumber = ?', [phoneNumber]);
  const row = res.rows[0] || {};
  const out = {};
  if (row.prefix) out.prefix = row.prefix;
  if (row.botName) out.botName = row.botName;
  if (row.automation) {
    try {
      const parsed = JSON.parse(row.automation);
      AUTOMATION_KEYS.forEach((k) => { if (parsed[k]) out[k] = true; });
    } catch (e) {
      // Corrupt/empty JSON — treat as no automation overrides set.
    }
  }
  return out;
}

// Base URL used to build the dashboard link sent to customers over WhatsApp.
// Edit PAIRING_BASE_URL in pairing/pairingConfig.js to your public domain,
// e.g. "https://your-app.up.railway.app".
const PUBLIC_BASE_URL = (cfg.PAIRING_BASE_URL || 'https://pairingpage.up.railway.app').replace(/\/+$/, '');

function dashboardUrl(token) {
  return `${PUBLIC_BASE_URL}/dashboard.html?token=${token}`;
}

/**
 * Merges a still image + an audio file into ONE mp4 (image as the frame for
 * the whole clip, audio as the soundtrack, trimmed to the audio's length) —
 * this is the only way WhatsApp can show "picha + wimbo" as a SINGLE status,
 * since its status types are text / image / video / audio, never a
 * combination; a video with a static frame is what every "photo with music"
 * status tool actually sends under the hood. Same fluent-ffmpeg + ffmpeg-
 * static pattern already used by groupstatus.js / sticker.js in this repo.
 */
async function combineImageAudioToVideo(imageBuffer, audioBuffer) {
  const ffmpeg = require('fluent-ffmpeg');
  const ffmpegStaticPath = require('ffmpeg-static');
  if (ffmpegStaticPath) ffmpeg.setFfmpegPath(ffmpegStaticPath);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-combo-'));
  const imgPath = path.join(tmpDir, 'in.img');
  const audPath = path.join(tmpDir, 'in.audio');
  const outPath = path.join(tmpDir, 'out.mp4');

  try {
    fs.writeFileSync(imgPath, imageBuffer);
    fs.writeFileSync(audPath, audioBuffer);

    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(imgPath)
        .inputOptions(['-loop 1'])
        .input(audPath)
        .outputOptions([
          '-c:v libx264',
          '-tune stillimage',
          '-c:a aac',
          '-b:a 192k',
          '-pix_fmt yuv420p',
          '-shortest',
          '-movflags +faststart',
        ])
        .on('error', reject)
        .on('end', resolve)
        .save(outPath);
    });

    return fs.readFileSync(outPath);
  } finally {
    fs.rm(tmpDir, { recursive: true, force: true }, () => {});
  }
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
  sock.instanceSettings = await getInstanceSettings(phoneNumber);

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === 'open') {
      record.status = 'connected';
      record.pairingCode = null;
      record.reconnectAttempts = 0;
      const isFirstConnect = !record.token;
      record.token = await getOrCreateToken(phoneNumber);
      if (isFirstConnect) {
        sendDashboardLinkMessage(sock, phoneNumber, record.token);
      }

      // If trial/subscription has already lapsed by the time they reconnect,
      // let them know once (not on every reconnect) with a link to pay.
      const access = await userStore.getAccessStatus(phoneNumber);
      if (!access.allowed && !access.user.expiryNotifiedAt) {
        const selfJid = `${phoneNumber}@s.whatsapp.net`;
        const reasonText = access.reason === 'blocked'
          ? 'Akaunti yako imezuiwa na msimamizi.'
          : 'Muda wako wa majaribio (trial) umeisha.';
        sock.sendMessage(selfJid, {
          text: `⏰ *${reasonText}*\n\nBot yako haitajibu ujumbe hadi ulipe.\n\n💳 Lipa kupitia dashboard yako:\n${dashboardUrl(record.token)}`,
        }).catch(() => {});
        await userStore.markExpiryNotified(phoneNumber);
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
        // Futa auth-state chakavu ya jaribio hili lililoshindwa — bila hii,
        // jaribio LIJALO linarithi creds mbovu na kuendelea kupata
        // "connection closed" hata baada ya kubadilisha CUSTOM_PAIRING_CODE
        // au kusubiri. Jaribio jipya lazima lianze na session tupu.
        fs.rm(sessionFolder, { recursive: true, force: true }, () => {});
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
  sock.ev.on('messages.upsert', async (m) => {
    const msg = m.messages?.[0];
    if (!msg?.message) return;

    // Auto View/React Status — per-customer toggles from the dashboard
    // (Settings > Otomatiki). Independent of the trial/billing gate below,
    // same as autoTyping/autoRecording aren't billing-gated commands.
    if (msg.key.remoteJid === 'status@broadcast' && !msg.key.fromMe) {
      const auto = sock.instanceSettings || {};
      if (auto.autoViewStatus) {
        sock.readMessages([msg.key]).catch(() => {});
      }
      if (auto.autoReactStatus) {
        const emojis = ['❤️', '🔥', '😍', '👍', '💯', '✨'];
        const reaction = emojis[Math.floor(Math.random() * emojis.length)];
        const posterJid = msg.key.participant || msg.key.remoteJid;
        // Small random delay so replies don't all fire at the exact same
        // instant a status is posted — mirrors handler.js's own status
        // reactor behaviour.
        setTimeout(() => {
          sock.sendMessage('status@broadcast', {
            react: { text: reaction, key: msg.key },
          }, { statusJidList: [posterJid, sock.user.id] }).catch(() => {});
        }, 3000 + Math.floor(Math.random() * 5000));
      }
    }

    // Auto Recording indicator — per-customer toggle, mirrors index.js's
    // implementation for the single-owner bot, but scoped to this instance
    // via sock.instanceSettings instead of the shared config.js.
    if (sock.instanceSettings?.autoRecording && msg.key.remoteJid && msg.key.remoteJid !== 'status@broadcast' && !msg.key.fromMe) {
      sock.sendPresenceUpdate('recording', msg.key.remoteJid).then(() => {
        setTimeout(() => {
          sock.sendPresenceUpdate('paused', msg.key.remoteJid).catch(() => {});
        }, 3000);
      }).catch(() => {});
    }

    const access = await userStore.getAccessStatus(phoneNumber);
    if (!access.allowed) return;

    userStore.incrementUsage(phoneNumber).catch(() => {}); // fire-and-forget — powers the admin "Matumizi" tab

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
      // Futa session hii mara moja pia — usisubiri hadi reconnectAttempts
      // ifike 6 kama request ya kwanza kabisa ya pairing code ndiyo
      // iliyoshindwa (mfano "Connection Closed" kabla ya code kutolewa).
      fs.rm(sessionFolder, { recursive: true, force: true }, () => {});
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
  await userStore.ensureUser(phoneNumber); // starts their trial clock now, if new

  await connectInstance(phoneNumber, sessionFolder, record, false);

  return { phoneNumber, status: record.status, pairingCode: record.pairingCode };
}

/**
 * Looks up a live instance record by dashboard token. Returns null if the
 * token is unknown or the instance isn't connected in this process (e.g.
 * after a redeploy — the customer would need to re-pair; see the storage
 * caveat in pairing/server.js).
 */
async function getInstanceByToken(token) {
  const phoneNumber = await getPhoneNumberByToken(token);
  if (!phoneNumber) return null;
  return instances.get(phoneNumber) || null;
}

/**
 * Lists the WhatsApp groups this customer's bot instance is a member of —
 * used by the dashboard to populate a "post status to" picker.
 */
async function listGroups(token) {
  const inst = await getInstanceByToken(token);
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
 * already use. Accepts an array of group ids so the customer can tick
 * several groups (checkbox picker) and post the same status to all of them
 * in one go — same shape as sendMessageToGroups() below.
 */
async function postGroupStatusForToken(token, { groupIds, text, caption, imageBase64, videoBase64, audioBase64, audioMimetype }) {
  const inst = await getInstanceByToken(token);
  if (!inst) throw new Error('Dashboard link si sahihi au bot haijaunganishwa.');
  if (inst.status !== 'connected') throw new Error('Bot bado haijaunganishwa kikamilifu.');
  if (!Array.isArray(groupIds) || groupIds.length === 0) {
    throw new Error('Chagua angalau group moja ya kutuma status.');
  }

  let payload;
  if (imageBase64 && audioBase64) {
    // Combined "picha + wimbo" — merge into one mp4 first, see
    // combineImageAudioToVideo()'s comment for why this is the only way.
    const videoBuf = await combineImageAudioToVideo(
      Buffer.from(imageBase64, 'base64'),
      Buffer.from(audioBase64, 'base64')
    );
    payload = { video: videoBuf, caption: caption || '' };
  } else if (imageBase64) {
    payload = { image: Buffer.from(imageBase64, 'base64'), caption: caption || '' };
  } else if (videoBase64) {
    payload = { video: Buffer.from(videoBase64, 'base64'), caption: caption || '' };
  } else if (audioBase64) {
    payload = { audio: Buffer.from(audioBase64, 'base64'), mimetype: audioMimetype || 'audio/mpeg', ptt: false };
  } else if (text) {
    payload = { text, backgroundColor: '#9C27B0' };
  } else {
    throw new Error('Weka maandishi, au chagua picha/video/wimbo.');
  }

  payload.groupStatus = true;

  const targets = groupIds.includes('all')
    ? Object.keys(await inst.sock.groupFetchAllParticipating())
    : groupIds;

  let success = 0;
  let failed = 0;
  for (const gid of targets) {
    try {
      // IMPORTANT: pass a FRESH copy of the payload to every send. Baileys
      // mutates the content object while building the message (uploads
      // media, rewrites keys, and strips the groupStatus flag once it's
      // been consumed) — reusing the same object reference across multiple
      // sendMessage() calls meant only the first group got a real status;
      // every group after that received it as a normal message instead.
      await inst.sock.sendMessage(gid, { ...payload });
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
async function sendMessageToGroups(token, { groupIds, text, caption, imageBase64, videoBase64, audioBase64, audioMimetype }) {
  const inst = await getInstanceByToken(token);
  if (!inst) throw new Error('Dashboard link si sahihi au bot haijaunganishwa.');
  if (inst.status !== 'connected') throw new Error('Bot bado haijaunganishwa kikamilifu.');
  if (!Array.isArray(groupIds) || groupIds.length === 0) {
    throw new Error('Chagua angalau group moja.');
  }

  let payload;
  if (imageBase64 && audioBase64) {
    const videoBuf = await combineImageAudioToVideo(
      Buffer.from(imageBase64, 'base64'),
      Buffer.from(audioBase64, 'base64')
    );
    payload = { video: videoBuf, caption: caption || '' };
  } else if (imageBase64) {
    payload = { image: Buffer.from(imageBase64, 'base64'), caption: caption || '' };
  } else if (videoBase64) {
    payload = { video: Buffer.from(videoBase64, 'base64'), caption: caption || '' };
  } else if (audioBase64) {
    payload = { audio: Buffer.from(audioBase64, 'base64'), mimetype: audioMimetype || 'audio/mpeg', ptt: false };
  } else if (text) {
    payload = { text };
  } else {
    throw new Error('Weka maandishi, au chagua picha/video/wimbo.');
  }

  const targets = groupIds.includes('all')
    ? Object.keys(await inst.sock.groupFetchAllParticipating())
    : groupIds;

  let success = 0;
  let failed = 0;
  for (const gid of targets) {
    try {
      // Same reasoning as postGroupStatusForToken() above: always send a
      // fresh copy so Baileys' internal mutation of one send doesn't affect
      // the next group's message.
      await inst.sock.sendMessage(gid, { ...payload });
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
  if (!(await getPhoneNumberByToken(token))) {
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
  if (!(await getPhoneNumberByToken(token))) {
    throw new Error('Dashboard link si sahihi. Tumia link uliyopewa baada ya kuunganisha.');
  }
  return mediaDownloader.resolveDownload(youtubeUrl, type);
}

/**
 * Dashboard "Settings" — reads a customer's current prefix/botName
 * overrides (either may be unset, meaning "use the default"), plus the
 * defaults themselves so the dashboard can show helpful placeholders.
 */
async function getSettingsForToken(token) {
  const phoneNumber = await getPhoneNumberByToken(token);
  if (!phoneNumber) throw new Error('Dashboard link si sahihi.');
  const defaults = require('../config');
  const custom = await getInstanceSettings(phoneNumber);

  const automation = {};
  AUTOMATION_KEYS.forEach((k) => { automation[k] = !!custom[k]; });

  return {
    prefix: custom.prefix || '',
    botName: custom.botName || '',
    defaultPrefix: defaults.prefix,
    defaultBotName: defaults.botName,
    automation,
    protection: await getProtectionForToken(token),
  };
}

/**
 * Dashboard "Settings" — save a customer's optional prefix / bot name.
 * Passing an empty string / omitting a field clears that override so the
 * instance falls back to the shared default again. Applies immediately to
 * a live connection (no restart needed) by updating sock.instanceSettings.
 */
async function updateSettingsForToken(token, { prefix, botName }) {
  const phoneNumber = await getPhoneNumberByToken(token);
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

  await db.query(
    `INSERT INTO settings (phoneNumber, prefix, botName) VALUES (?, ?, ?)
     ON CONFLICT(phoneNumber) DO UPDATE SET prefix = excluded.prefix, botName = excluded.botName`,
    [phoneNumber, next.prefix || null, next.botName || null]
  );

  // Live-update the running connection, if any, so the change is instant.
  // Re-read from the DB (instead of assigning `next` directly) so this
  // doesn't wipe out automation toggles already merged onto instanceSettings.
  const inst = instances.get(phoneNumber);
  if (inst?.sock) {
    inst.sock.instanceSettings = await getInstanceSettings(phoneNumber);
  }

  return getSettingsForToken(token);
}

/**
 * Dashboard "Vipengele vya Kiotomatiki" — save a customer's automation
 * toggles (autoTyping, autoRecording, n.k). Applies to the whole instance
 * (not one group), takes effect immediately on the live connection via
 * sock.instanceSettings, same live-update mechanism as prefix/botName.
 */
async function updateAutomationForToken(token, payload) {
  const phoneNumber = await getPhoneNumberByToken(token);
  if (!phoneNumber) throw new Error('Dashboard link si sahihi.');

  const automation = {};
  AUTOMATION_KEYS.forEach((k) => { automation[k] = !!(payload || {})[k]; });

  const current = await getInstanceSettings(phoneNumber); // keeps prefix/botName intact
  await db.query(
    `INSERT INTO settings (phoneNumber, prefix, botName, automation) VALUES (?, ?, ?, ?)
     ON CONFLICT(phoneNumber) DO UPDATE SET automation = excluded.automation`,
    [phoneNumber, current.prefix || null, current.botName || null, JSON.stringify(automation)]
  );

  const inst = instances.get(phoneNumber);
  if (inst?.sock) {
    inst.sock.instanceSettings = await getInstanceSettings(phoneNumber);
  }

  return automation;
}

/**
 * Dashboard "Ulinzi wa Groups" — reads which groups currently have each
 * protection feature (antiGroupMention/antiPromo/antiLink) enabled, using
 * the SAME per-group store the WhatsApp commands write to. A feature is
 * reported "enabled" if at least one group has it on — the dashboard only
 * needs the per-group list to render checkboxes correctly.
 */
async function getProtectionForToken(token) {
  const result = {};
  Object.keys(PROTECTION_FEATURES).forEach((f) => { result[f] = { enabled: false, groupIds: [] }; });

  try {
    const groups = await listGroups(token);
    Object.keys(PROTECTION_FEATURES).forEach((feature) => {
      const dbField = PROTECTION_FEATURES[feature];
      const groupIds = groups
        .filter((g) => !!groupDb.getGroupSettings(g.id)[dbField])
        .map((g) => g.id);
      result[feature] = { enabled: groupIds.length > 0, groupIds };
    });
  } catch (e) {
    // Bot haijaunganishwa au imeshindwa kupakia groups — onesha ulinzi tupu
    // badala ya kuvunja ukurasa mzima wa settings.
  }

  return result;
}

/**
 * Dashboard "Ulinzi wa Groups" — save which groups have each protection
 * feature on. Requires a live connection (needs the current groups list) —
 * throws a clear Swahili error otherwise, same as other dashboard actions
 * that need the bot online.
 */
async function updateProtectionForToken(token, features) {
  if (!Array.isArray(features)) throw new Error('Data ya ulinzi si sahihi.');

  const groups = await listGroups(token);
  for (const entry of features) {
    const dbField = PROTECTION_FEATURES[entry.feature];
    if (!dbField) continue;
    const selected = new Set(Array.isArray(entry.groupIds) ? entry.groupIds : []);
    for (const g of groups) {
      const shouldEnable = !!entry.enabled && selected.has(g.id);
      groupDb.updateGroupSettings(g.id, { [dbField]: shouldEnable });
    }
  }

  return getProtectionForToken(token);
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

  const token = inst.token || await getOrCreateToken(phoneNumber);
  inst.token = token;
  await sendDashboardLinkMessage(inst.sock, phoneNumber, token);
  return { phoneNumber, sent: true };
}

/**
 * Admin dashboard — full list of customers, merging persisted trial/paid
 * status (userStore) with live connection status (this process' instances
 * map, if the process hasn't been redeployed since they connected).
 */
async function adminListUsers() {
  const all = await userStore.getAllUsers();
  return all.map((u) => {
    const live = instances.get(u.phoneNumber);
    return {
      ...u,
      liveStatus: live ? live.status : 'offline',
      dashboardToken: live ? live.token : null,
    };
  }).sort((a, b) => b.pairedAt - a.pairedAt);
}

async function adminMarkPaid(phoneNumber, days, meta) {
  return userStore.markPaid(normalizePhoneNumber(phoneNumber), days, meta);
}

async function adminExtendTrial(phoneNumber, days) {
  return userStore.extendTrial(normalizePhoneNumber(phoneNumber), days);
}

async function adminSetBlocked(phoneNumber, blocked) {
  return userStore.setBlocked(normalizePhoneNumber(phoneNumber), blocked);
}

/** Admin "badilisha muda" — deltaDays may be negative (punguza) or positive (ongeza). */
async function adminAdjustDays(phoneNumber, deltaDays) {
  return userStore.adjustActiveDays(normalizePhoneNumber(phoneNumber), Number(deltaDays) || 0);
}

/**
 * Dashboard "Billing" tab — a customer's own trial/paid status, used to
 * show a countdown / pay button on their dashboard.html.
 */
async function getBillingForToken(token) {
  const phoneNumber = await getPhoneNumberByToken(token);
  if (!phoneNumber) throw new Error('Dashboard link si sahihi.');
  const access = await userStore.getAccessStatus(phoneNumber);
  return {
    phoneNumber,
    allowed: access.allowed,
    reason: access.reason,
    trialExpiresAt: access.user.trialExpiresAt,
    isPaid: access.user.isPaid,
    paidUntil: access.user.paidUntil,
  };
}

/**
 * Daily payment-reminder scheduler. Every REMINDER_INTERVAL_HOURS, checks
 * every currently-connected instance whose trial/subscription has expired
 * (and who isn't blocked) and sends them a WhatsApp reminder with their
 * dashboard payment link — until they pay, once per interval.
 *
 * Only reaches customers whose socket is live in THIS process (i.e. no
 * redeploy since they last connected) — same limitation as the rest of
 * this in-memory instance model.
 */
function startReminderScheduler() {
  setInterval(async () => {
    for (const [phoneNumber, record] of instances.entries()) {
      if (record.status !== 'connected' || !record.sock || !record.token) continue;
      const due = await userStore.isReminderDue(phoneNumber, cfg.REMINDER_INTERVAL_HOURS || 24);
      if (!due) continue;

      const selfJid = `${phoneNumber}@s.whatsapp.net`;
      const link = dashboardUrl(record.token);
      record.sock.sendMessage(selfJid, {
        text: `⏰ *Kumbusho la Malipo*\n\nBot yako haijibu ujumbe kwa sasa kwa sababu muda umeisha.\n\n💳 Lipa hapa kuendelea kutumia:\n${link}`,
      }).catch(() => {});
      await userStore.markReminderSent(phoneNumber);
    }
  }, 60 * 60 * 1000); // checks every hour; REMINDER_INTERVAL_HOURS controls per-user due-time above
}

/**
 * ── Admin "full access" helpers ─────────────────────────────────────────
 * Everything below lets the admin dashboard act on a customer's bot
 * DIRECTLY by phone number (no dashboard token needed) — groups list,
 * sending messages/status to groups, reading/editing prefix+botName, and
 * force-resetting one customer's session. Only reaches an instance that is
 * live in THIS process (same limitation as the rest of the in-memory model
 * — see the comment on resendDashboardLink above).
 */
async function adminGetInstanceDetail(rawPhoneNumber) {
  const phoneNumber = normalizePhoneNumber(rawPhoneNumber);
  const inst = instances.get(phoneNumber);
  const settingsRow = await getInstanceSettings(phoneNumber);
  const defaults = require('../config');

  let groups = [];
  let groupsError = null;
  if (inst && inst.status === 'connected' && inst.sock) {
    try {
      const chats = await inst.sock.groupFetchAllParticipating();
      groups = Object.values(chats).map(g => ({ id: g.id, subject: g.subject, participants: g.participants.length }));
    } catch (e) {
      groupsError = e.message;
    }
  }

  const [user, paymentHistory, usage] = await Promise.all([
    userStore.getUser(phoneNumber),
    userStore.getPaymentHistory(phoneNumber),
    userStore.getUsage(phoneNumber, 14),
  ]);
  const lastPayment = paymentHistory[0] || null;
  // "Package" the customer is on — matched against the price list in
  // pairingConfig.js by the day-count of their most recent payment, so the
  // admin sees a human label ("Mwezi 1") instead of just a raw day count.
  const matchedPlan = lastPayment ? cfg.PLANS.find(p => p.days === lastPayment.days) : null;

  return {
    phoneNumber,
    liveStatus: inst ? inst.status : 'offline',
    pairingCode: inst ? inst.pairingCode : null,
    error: inst ? inst.error : null,
    dashboardToken: inst ? inst.token : null,
    dashboardUrl: inst && inst.token ? dashboardUrl(inst.token) : null,
    groups,
    groupsError,
    settings: {
      prefix: settingsRow.prefix || '',
      botName: settingsRow.botName || '',
      defaultPrefix: defaults.prefix,
      defaultBotName: defaults.botName,
    },
    billing: {
      isPaid: user?.isPaid || false,
      paidUntil: user?.paidUntil || null,
      trialExpiresAt: user?.trialExpiresAt || null,
      blocked: user?.blocked || false,
      packageLabel: matchedPlan
        ? (matchedPlan.days === 1 ? 'Siku 1' : matchedPlan.days === 30 ? 'Mwezi 1 (siku 30)' : `Siku ${matchedPlan.days}`)
        : (user?.isPaid ? `Siku ${lastPayment?.days ?? '—'} (custom)` : 'Trial'),
      lastPayment,
    },
    usage,
  };
}

async function adminUpdateInstanceSettings(rawPhoneNumber, { prefix, botName }) {
  const phoneNumber = normalizePhoneNumber(rawPhoneNumber);

  const trimmedPrefix = typeof prefix === 'string' ? prefix.trim() : '';
  if (trimmedPrefix && trimmedPrefix.length > 3) throw new Error('Prefix isiwe zaidi ya herufi 3.');
  const trimmedName = typeof botName === 'string' ? botName.trim() : '';
  if (trimmedName && trimmedName.length > 40) throw new Error('Jina la bot lisizidi herufi 40.');

  const next = {};
  if (trimmedPrefix) next.prefix = trimmedPrefix;
  if (trimmedName) next.botName = trimmedName;

  await db.query(
    `INSERT INTO settings (phoneNumber, prefix, botName) VALUES (?, ?, ?)
     ON CONFLICT(phoneNumber) DO UPDATE SET prefix = excluded.prefix, botName = excluded.botName`,
    [phoneNumber, next.prefix || null, next.botName || null]
  );

  const inst = instances.get(phoneNumber);
  if (inst?.sock) inst.sock.instanceSettings = next;

  return adminGetInstanceDetail(phoneNumber);
}

/**
 * Admin-triggered send — same payload shape as sendMessageToGroups() but
 * addressed by phone number directly, no customer token required.
 */
async function adminSendToGroups(rawPhoneNumber, { groupIds, text, caption, imageBase64, videoBase64, audioBase64, audioMimetype }) {
  const phoneNumber = normalizePhoneNumber(rawPhoneNumber);
  const inst = instances.get(phoneNumber);
  if (!inst) throw new Error('Bot ya namba hii haipo "live" kwenye process hii kwa sasa (labda haijaunganishwa, au kuna redeploy tangu iunganishwe).');
  if (inst.status !== 'connected') throw new Error('Bot bado haijaunganishwa kikamilifu.');
  if (!Array.isArray(groupIds) || groupIds.length === 0) throw new Error('Chagua angalau group moja.');

  let payload;
  if (imageBase64 && audioBase64) {
    const videoBuf = await combineImageAudioToVideo(
      Buffer.from(imageBase64, 'base64'),
      Buffer.from(audioBase64, 'base64')
    );
    payload = { video: videoBuf, caption: caption || '' };
  } else if (imageBase64) {
    payload = { image: Buffer.from(imageBase64, 'base64'), caption: caption || '' };
  } else if (videoBase64) {
    payload = { video: Buffer.from(videoBase64, 'base64'), caption: caption || '' };
  } else if (audioBase64) {
    payload = { audio: Buffer.from(audioBase64, 'base64'), mimetype: audioMimetype || 'audio/mpeg', ptt: false };
  } else if (text) {
    payload = { text };
  } else {
    throw new Error('Weka maandishi, au chagua picha/video/wimbo.');
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
 * Force-resets ONE customer's session (disconnects the live socket if any,
 * then deletes their pairing/sessions/<phone> folder) — the per-user
 * version of the bulk "Futa Sessions Chakavu" admin action. Customer will
 * need to press "Pata Pairing Code" again afterwards.
 */
async function adminResetUserSession(rawPhoneNumber) {
  const phoneNumber = normalizePhoneNumber(rawPhoneNumber);
  const inst = instances.get(phoneNumber);
  if (inst?.sock) {
    try { inst.sock.end(undefined); } catch (e) { /* already closed — fine */ }
  }
  instances.delete(phoneNumber);
  const sessionFolder = path.join(SESSIONS_ROOT, sanitizeFolderName(phoneNumber));
  fs.rmSync(sessionFolder, { recursive: true, force: true });
  return { phoneNumber, reset: true };
}

/**
 * Auto-reconnects every previously-paired customer on server startup — this
 * is what makes bots come back online BY THEMSELVES after a redeploy,
 * instead of everyone needing to open the pairing page and re-scan.
 *
 * IMPORTANT CAVEAT: this only has anything to restore if the folders under
 * pairing/sessions/ actually SURVIVED the redeploy. On Railway, the
 * filesystem is wiped on every deploy UNLESS pairing/sessions is a
 * persistent Volume — see the setup note in README/pairingConfig. Without
 * that Volume, this function will simply find zero folders and do nothing
 * (customers still have to re-pair), which is the exact behaviour being
 * reported.
 */
async function restoreAllInstances() {
  await ensureBaileysBridge();

  let folders;
  try {
    folders = fs.readdirSync(SESSIONS_ROOT, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch (e) {
    console.error('[pairing] imeshindwa kusoma sessions folder kwa ajili ya auto-reconnect:', e.message);
    return;
  }

  if (!folders.length) {
    console.log('[pairing] hakuna session zilizohifadhiwa — hakuna cha ku-auto-reconnect (ni kawaida ukiwa huna Volume, angalia pairingConfig.js).');
    return;
  }

  console.log(`[pairing] inajaribu ku-auto-reconnect namba ${folders.length}...`);

  let restored = 0;
  for (const folder of folders) {
    const phoneNumber = normalizePhoneNumber(folder);
    if (!phoneNumber) continue;
    const sessionFolder = path.join(SESSIONS_ROOT, folder);

    try {
      // Peek at the saved creds WITHOUT opening a socket yet, so we skip
      // folders that never finished pairing (no point reconnecting those —
      // and doing so with isReconnect=true would silently sit in "pairing"
      // status forever with no code shown).
      const { state } = await useMultiFileAuthState(sessionFolder);
      if (!state.creds.registered) continue;

      const record = {
        phoneNumber,
        sock: null,
        status: 'connecting',
        pairingCode: null,
        error: null,
        createdAt: Date.now(),
        reconnectAttempts: 0,
      };
      instances.set(phoneNumber, record);

      // isReconnect=true so this NEVER requests a fresh pairing code — it
      // just resumes the existing linked session, exactly like Baileys'
      // own reconnect-after-close path does.
      connectInstance(phoneNumber, sessionFolder, record, true).catch((e) => {
        record.status = 'error';
        record.error = e.message;
        console.error(`[pairing:${phoneNumber}] auto-reconnect imeshindwa:`, e.message);
      });

      restored++;
      // Stagger connections so we don't open a burst of sockets to
      // WhatsApp all at once (looks like abuse and can trigger rate limits).
      await new Promise((r) => setTimeout(r, 1500));
    } catch (e) {
      console.error(`[pairing:${phoneNumber}] auto-reconnect: imeshindwa kusoma session:`, e.message);
    }
  }

  console.log(`[pairing] auto-reconnect: ${restored}/${folders.length} zimeanzishwa.`);
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
  updateAutomationForToken,
  getProtectionForToken,
  updateProtectionForToken,
  resendDashboardLink,
  adminListUsers,
  adminMarkPaid,
  adminExtendTrial,
  adminSetBlocked,
  getBillingForToken,
  startReminderScheduler,
  adminGetInstanceDetail,
  adminUpdateInstanceSettings,
  adminSendToGroups,
  adminResetUserSession,
  restoreAllInstances,
  adminAdjustDays,
};
