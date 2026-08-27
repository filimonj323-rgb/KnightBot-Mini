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
const axios = require('axios');
const NodeCache = require('node-cache');
const mediaDownloader = require('./mediaDownloader');
const userStore = require('./userStore');
const cfg = require('./pairingConfig');
const db = require('./db');
// Group-wise protection (antilink/antigroupmention/antipromo) reuses the
// SAME JSON-file group settings store the WhatsApp commands already use
// (commands/admin/antilink.js etc.) — one source of truth, no duplication.
const groupDb = require('../database');
// Auto-Forward rules — SAME store the `.autoforward` WhatsApp command
// (commands/owner/autoforward.js) already reads/writes, so a rule set from
// the dashboard shows up instantly via WhatsApp and vice versa.
const af = require('../utils/autoforward');

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

// Automation keys that ship ON for every customer unless they explicitly
// switch them off from the dashboard (Settings > Otomatiki) — same
// "opt-out, not opt-in" treatment as autoForwardMessages below. Requested
// so AutoStatus (view + react) works out of the box, matching the /owner
// !autostatus command's own default behaviour (AUTOSTATUS_DEFAULTS.view/
// .react = true in commands/owner/autostatus.js's spirit).
const DEFAULT_ON_AUTOMATION_KEYS = ['autoViewStatus', 'autoReactStatus'];

async function getInstanceSettings(phoneNumber) {
  const res = await db.query('SELECT prefix, botName, automation FROM settings WHERE phoneNumber = ?', [phoneNumber]);
  const row = res.rows[0] || {};
  // autoForwardMessages, autoViewStatus and autoReactStatus default to ON
  // (see DEFAULT_ON_AUTOMATION_KEYS above) — UNLIKE the rest of
  // AUTOMATION_KEYS, which all default OFF until a customer opts in.
  const out = { autoForwardMessages: true, autoViewStatus: true, autoReactStatus: true };
  if (row.prefix) out.prefix = row.prefix;
  if (row.botName) out.botName = row.botName;
  if (row.automation) {
    try {
      const parsed = JSON.parse(row.automation);
      AUTOMATION_KEYS.forEach((k) => {
        if (DEFAULT_ON_AUTOMATION_KEYS.includes(k)) {
          if (parsed[k] === false) out[k] = false; // explicit opt-out
        } else if (parsed[k]) {
          out[k] = true; // explicit opt-in
        }
      });
      if (parsed.autoForwardMessages === false) out.autoForwardMessages = false;
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

// Linki ya malipo — dashboard ile ile lakini na "&section=billing" ili
// mteja akiigusa aende MOJA KWA MOJA kwenye tab ya "💳 Malipo" (package
// zote), badala ya kuanzia kwenye Status na kutafuta mwenyewe.
function paymentUrl(token) {
  return `${dashboardUrl(token)}&section=billing`;
}

/**
 * Kufupisha linki (TinyURL, hauhitaji API key) kwa ajili ya ujumbe wa
 * WhatsApp uonekane safi zaidi. Matokeo yanahifadhiwa kwenye Turso
 * (tokens.shortDashUrl / shortPayUrl) ili tusiombe TinyURL kila mara —
 * mara moja tu kwa kila token. Ikishindwa kwa sababu yoyote (mtandao,
 * TinyURL chini, n.k.) tunarudi kwenye linki ndefu badala ya kuvunja
 * ujumbe — kufupisha ni "bonus", si lazima.
 */
async function shortenUrl(longUrl) {
  try {
    const res = await axios.get('https://tinyurl.com/api-create.php', {
      params: { url: longUrl },
      timeout: 5000,
    });
    const short = String(res.data || '').trim();
    return short.startsWith('http') ? short : longUrl;
  } catch (e) {
    return longUrl;
  }
}

/**
 * Inarudisha { dash, pay } za token husika — zikiwa fupi. Kwa token
 * mpya inafupisha na kuhifadhi kwenye DB; kwa token iliyokwishafupishwa
 * awali inasoma kutoka DB moja kwa moja (hakuna ombi jipya kwa TinyURL).
 */
async function getShortLinks(token) {
  const res = await db.query('SELECT shortDashUrl, shortPayUrl FROM tokens WHERE token = ?', [token]);
  const row = res.rows[0] || {};
  if (row.shortDashUrl && row.shortPayUrl) {
    return { dash: row.shortDashUrl, pay: row.shortPayUrl };
  }

  const longDash = dashboardUrl(token);
  const longPay = paymentUrl(token);
  const [dash, pay] = await Promise.all([shortenUrl(longDash), shortenUrl(longPay)]);

  await db.query('UPDATE tokens SET shortDashUrl = ?, shortPayUrl = ? WHERE token = ?', [dash, pay, token]);
  return { dash, pay };
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

async function successMessageText(token) {
  const { dash, pay } = await getShortLinks(token);
  return (
    '┏━━━━━━━━━━━━━━━━━━┓\n' +
    '   ✅  *BOT IMEUNGANISHWA*\n' +
    '┗━━━━━━━━━━━━━━━━━━┛\n\n' +
    'Karibu! Bot yako sasa iko *live* na commands zote tayari kutumika.\n\n' +
    '📊 *1. Dashibodi Yako* _(dhibiti bot: status, groups, settings...)_\n' +
    dash + '\n\n' +
    '💳 *2. Package za Malipo* _(ongeza siku za matumizi)_\n' +
    pay + '\n\n' +
    '━━━━━━━━━━━━━━━━━━\n' +
    '💡 Hifadhi (bookmark) link ya dashibodi — ni *yako binafsi*, usiishiriki na wengine.\n' +
    'Ukiisahau, rudi kwenye website ya pairing na tumia "Umesahau link?" kwa namba yako hii hii.'
  );
}

// Ujumbe wa "Bot Imeunganishwa" usimtumie mteja kila baada ya kuungana
// upya (reconnect/redeploy) — mara moja tu kwa kipindi hiki cha saa
// (session), hata kama mchakato uka-restart. Muda umewekwa Turso
// (tokens.welcomeSentAt), si kwenye kumbukumbu ya process (in-memory),
// ndiyo maana unabaki sahihi hata baada ya Railway kuanzisha upya.
const WELCOME_RESEND_HOURS = 24;

async function shouldSendWelcome(token) {
  const res = await db.query('SELECT welcomeSentAt FROM tokens WHERE token = ?', [token]);
  const sentAt = res.rows[0] && res.rows[0].welcomeSentAt;
  if (!sentAt) return true;
  return (Date.now() - sentAt) >= WELCOME_RESEND_HOURS * 60 * 60 * 1000;
}

async function markWelcomeSent(token) {
  await db.query('UPDATE tokens SET welcomeSentAt = ? WHERE token = ?', [Date.now(), token]);
}

/**
 * Sends the customer their dashboard + payment links over WhatsApp (to
 * their own inbox, i.e. "Message Yourself"), with a success message.
 * Called right after a successful connection (subject to the 24h
 * cooldown above), and also from resendDashboardLink() (explicit
 * request from the customer — always sends, and also resets the
 * cooldown so an automatic reconnect right after doesn't double-send).
 */
async function sendDashboardLinkMessage(sock, phoneNumber, token) {
  try {
    const selfJid = `${phoneNumber}@s.whatsapp.net`;
    await sock.sendMessage(selfJid, { text: await successMessageText(token) });
    await markWelcomeSent(token);
  } catch (e) {
    console.error(`[pairing:${phoneNumber}] imeshindwa kutuma dashboard link:`, e.message);
  }
}

/**
 * Ujumbe wa "muda unaisha / umeisha" — daima na link ya MALIPO pekee
 * (fupi, inayoenda moja kwa moja "💳 Malipo"), kwa matukio matatu:
 *   'warning'  → muda bado upo lakini unakaribia kuisha (onyo la mapema)
 *   'expired'  → muda umekwisha sasa hivi, bot haijibu tena mpaka alipe
 *   'reminder' → muda ulikwisha tangu awali, kumbusho la mara kwa mara
 */
async function buildExpiryMessage(kind, token, extra = {}) {
  const { pay } = await getShortLinks(token);

  if (kind === 'warning') {
    return (
      '⏳ *Muda Wako Unakaribia Kuisha*\n\n' +
      'Bot yako itaacha kujibu ujumbe hivi karibuni ikiwa hutalipia.\n\n' +
      '💳 Lipa mapema uendelee bila usumbufu:\n' + pay
    );
  }

  if (kind === 'expired') {
    return (
      '⏰ *' + (extra.reasonText || 'Muda wako umeisha.') + '*\n\n' +
      'Bot yako haitajibu ujumbe hadi ulipe.\n\n' +
      '💳 Lipa hapa kuendelea kutumia:\n' + pay
    );
  }

  // 'reminder'
  return (
    '⏰ *Kumbusho la Malipo*\n\n' +
    'Bot yako haijibu ujumbe kwa sasa kwa sababu muda umeisha.\n\n' +
    '💳 Lipa hapa kuendelea kutumia:\n' + pay
  );
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

  // Auto View/React Status — per-instance dedup cache + processing queue,
  // same pattern as handler.js's setupAutoStatusViewer() (the /owner
  // !autostatus implementation), scoped to THIS customer only so one
  // instance's cache can never suppress another's view/react on the same
  // broadcasted status.
  const viewedStatusCache = new NodeCache({ stdTTL: 86400, checkperiod: 3600, maxKeys: 5000 });
  const statusProcessingQueue = new Set();

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
      record.token = await getOrCreateToken(phoneNumber);
      if (await shouldSendWelcome(record.token)) {
        sendDashboardLinkMessage(sock, phoneNumber, record.token);
      }

      // If trial/subscription has already lapsed by the time they reconnect,
      // let them know once (not on every reconnect) with a link to pay.
      const access = await userStore.getAccessStatus(phoneNumber);
      if (!access.allowed && !access.user.expiryNotifiedAt) {
        const selfJid = `${phoneNumber}@s.whatsapp.net`;
        if (access.reason === 'blocked') {
          sock.sendMessage(selfJid, {
            text: '🚫 *Akaunti Yako Imezuiwa*\n\nAkaunti yako imezuiwa na msimamizi. Wasiliana naye kwa maelezo zaidi.',
          }).catch(() => {});
        } else {
          const reasonText = access.reason === 'subscription_expired'
            ? 'Muda wa malipo yako umeisha.'
            : 'Muda wako wa majaribio (trial) umeisha.';
          buildExpiryMessage('expired', record.token, { reasonText }).then((text) => {
            sock.sendMessage(selfJid, { text }).catch(() => {});
          });
        }
        await userStore.markExpiryNotified(phoneNumber);
      }
      return;
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = DisconnectReason && statusCode === DisconnectReason.loggedOut;
      // statusCode 440 = another socket connected with the SAME creds at the
      // same time (e.g. an overlapping Railway deploy, or >1 replica, both
      // calling restoreAllInstances() for this number). This is NOT a bad
      // or corrupt session — deleting it here would be wrong. Handle it
      // separately, before the retry counter below can ever reach the
      // destructive fs.rm branch for this cause.
      const conflict = DisconnectReason && statusCode === DisconnectReason.connectionReplaced;

      if (loggedOut) {
        record.status = 'disconnected';
        instances.delete(phoneNumber);
        return;
      }

      if (conflict) {
        console.warn(`[pairing:${phoneNumber}] mgongano wa connection (statusCode 440) — socket nyingine ilikuwa imeunganishwa na creds zilezile (mf. deploy mbili zikiendesha kwa wakati mmoja). Kusubiri na kujaribu tena bila kugusa session.`);
        record.status = 'connecting';
        setTimeout(() => {
          connectInstance(phoneNumber, sessionFolder, record, true).catch((e) => {
            record.status = 'error';
            record.error = e.message;
          });
        }, 8000);
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
    // (Settings > Otomatiki), ON BY DEFAULT for every customer (see
    // getInstanceSettings() below). Independent of the trial/billing gate
    // below, same as autoTyping/autoRecording aren't billing-gated commands.
    // Mirrors handler.js's setupAutoStatusViewer() (the /owner !autostatus
    // command's own logic) — dedup cache, delayed react, and LID-aware
    // delivery JID — because that is the version proven to actually work;
    // the difference here is it's scoped to sock.instanceSettings per
    // customer instead of one shared database/autostatus.json file.
    if (msg.key.remoteJid === 'status@broadcast' && !msg.key.fromMe) {
      const auto = sock.instanceSettings || {};
      const statusId = msg.key.id;

      if ((auto.autoViewStatus || auto.autoReactStatus) && statusId
          && !viewedStatusCache.has(statusId) && !statusProcessingQueue.has(statusId)) {
        statusProcessingQueue.add(statusId);
        viewedStatusCache.set(statusId, true);

        (async () => {
          try {
            if (auto.autoViewStatus) {
              await sock.readMessages([msg.key]);
            }
            if (auto.autoReactStatus) {
              const posterJid = msg.key.participant || msg.key.remoteJid;
              // 30-60s random delay — mirrors the /owner behaviour so
              // reactions don't all fire the instant a status goes up.
              const delayMs = 30000 + Math.floor(Math.random() * 30000);
              setTimeout(async () => {
                try {
                  // Required lazily (not at module top) because this file is
                  // require()'d by server.js at startup, before
                  // ensureBaileysBridge() has set global.__baileys —
                  // jidHelper.js reads that at require-time, so requiring it
                  // early crashes the whole server on boot. By the time this
                  // callback runs, connectInstance() (and therefore the
                  // bridge) has always already completed.
                  const { normalizeJidWithLid } = require('../utils/jidHelper');
                  const deliverJid = normalizeJidWithLid(posterJid, sessionFolder) || posterJid;
                  await sock.sendMessage('status@broadcast', {
                    react: { text: '❤️', key: msg.key },
                  }, { statusJidList: [deliverJid, sock.user.id] });
                } catch (e) { /* status inaweza kuwa imeondolewa kabla ya react — si tatizo */ }
              }, delayMs);
            }
          } catch (e) {
            viewedStatusCache.del(statusId);
          } finally {
            statusProcessingQueue.delete(statusId);
          }
        })();
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

    // Antilink & Antipromo — handler.handleMessage() ABOVE already covers
    // Auto-Forward and Antigroupmention internally (see handler.js), but
    // NOT these two: the shared/main bot (index.js) triggers them itself in
    // a separate background step after handleMessage(), and a paired
    // customer's instance never had the equivalent call — meaning Antilink
    // and Antipromo have been silently doing NOTHING for every dashboard
    // customer even when switched ON (Settings > Ulinzi), no matter what
    // groupmanager.js / database.js had stored. Mirrors index.js's own
    // pattern (getGroupMetadata + handleAntilink + handleAntipromo) so
    // paired customers finally get the same protection the main bot has.
    if (msg.key.remoteJid?.endsWith('@g.us')) {
      handler.getGroupMetadata(sock, msg.key.remoteJid).then(async (groupMetadata) => {
        if (!groupMetadata) return;
        await handler.handleAntilink(sock, msg, groupMetadata);
        await handler.handleAntipromo(sock, msg, groupMetadata);
      }).catch(() => {});
    }
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
  automation.autoForwardMessages = custom.autoForwardMessages !== false; // default true

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
  // Default true (unlike the AUTOMATION_KEYS above) — only an explicit
  // `false` from the dashboard checkbox turns it off; omitting the field
  // entirely must not silently disable a customer's forwarding rules.
  automation.autoForwardMessages = (payload || {}).autoForwardMessages !== false;

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

// ─────────────────────────────────────────────────────────────────────────
// Auto-Forward rules ("Otomatiki" tab → Auto Forward Messages) — lets a
// customer set up SOURCE group, DESTINATION (another group/channel/ID), and
// who triggers the forward (any group admin, or specific numbers) straight
// from the dashboard, instead of typing `.autoforward` commands in WhatsApp.
//
// utils/autoforward.js keeps ONE shared JSON file keyed only by
// sourceGroupId (used process-wide, including by every pairing customer).
// That's safe here with zero schema changes because a WhatsApp group ID is
// globally unique — a customer's bot is only ever a member of their OWN
// groups — so scoping every dashboard read/write to "sourceGroupId must be
// one of MY bot's groups" (via listGroups(token), same check used above by
// getProtectionForToken/updateProtectionForToken) naturally isolates each
// customer's rules from everyone else's without touching the WhatsApp
// command at all.
// ─────────────────────────────────────────────────────────────────────────

function assertOwnsSourceGroup(myGroupIds, sourceGroupId) {
  if (!sourceGroupId || !myGroupIds.has(sourceGroupId)) {
    throw new Error('Chagua group ya CHANZO (source) inayosimamiwa na bot yako.');
  }
}

/**
 * Dashboard "Otomatiki" — list this customer's Auto-Forward rules only
 * (filtered down from the shared store to just this bot's own groups).
 */
async function getAutoForwardRulesForToken(token) {
  const groups = await listGroups(token);
  const myGroupIds = new Set(groups.map((g) => g.id));
  const nameById = new Map(groups.map((g) => [g.id, g.subject]));

  const rules = af.getRules().filter((r) => myGroupIds.has(r.sourceGroupId));

  return {
    rules: rules.map((r) => ({
      sourceGroupId: r.sourceGroupId,
      sourceName: nameById.get(r.sourceGroupId) || r.sourceGroupId,
      destinationJid: r.destinationJid,
      destinationName: nameById.get(r.destinationJid) || r.destinationJid,
      enabled: !!r.enabled,
      alladmin: !!r.alladmin,
      numbers: r.numbers || [],
    })),
  };
}

/**
 * Dashboard "Otomatiki" — create/update ONE Auto-Forward rule: source
 * group, destination (another group/channel/ID), and trigger mode
 * ("alladmin" = any group admin, or "numbers" = specific phone numbers).
 * Saving always enables the rule immediately (matches `.autoforward set` +
 * `.autoforward numbers`/`alladmin on` + `.autoforward on`, done in one step).
 */
async function saveAutoForwardRuleForToken(token, payload) {
  const { sourceGroupId, destinationJid, mode, numbers } = payload || {};

  const groups = await listGroups(token);
  const myGroupIds = new Set(groups.map((g) => g.id));
  assertOwnsSourceGroup(myGroupIds, sourceGroupId);

  const dest = String(destinationJid || '').trim();
  if (!dest) throw new Error('Weka group/channel ya kupelekea (destination).');

  const cleanNumbers = (Array.isArray(numbers) ? numbers : String(numbers || '').split(','))
    .map((n) => String(n).trim().replace(/[^0-9]/g, ''))
    .filter(Boolean);

  const alladmin = mode === 'alladmin';
  if (!alladmin && !cleanNumbers.length) {
    throw new Error('Chagua "Admin Yeyote" au weka angalau namba moja.');
  }

  af.upsertRule(sourceGroupId, {
    destinationJid: dest,
    alladmin,
    numbers: alladmin ? [] : cleanNumbers,
    enabled: true,
  });

  return getAutoForwardRulesForToken(token);
}

/**
 * Dashboard "Otomatiki" — flip a single rule on/off without touching its
 * source/destination/trigger settings (same as `.autoforward on`/`off`).
 */
async function toggleAutoForwardRuleForToken(token, sourceGroupId, enabled) {
  const groups = await listGroups(token);
  const myGroupIds = new Set(groups.map((g) => g.id));
  assertOwnsSourceGroup(myGroupIds, sourceGroupId);

  const rule = af.findRule(sourceGroupId);
  if (!rule) throw new Error('Rule haipo.');
  if (enabled && !rule.destinationJid) throw new Error('Weka destination kwanza.');
  if (enabled && !rule.alladmin && !(rule.numbers || []).length) {
    throw new Error('Weka "Admin Yeyote" au namba kabla ya kuwasha.');
  }

  af.upsertRule(sourceGroupId, { enabled: !!enabled });
  return getAutoForwardRulesForToken(token);
}

/**
 * Dashboard "Otomatiki" — permanently delete a rule (same as
 * `.autoforward remove`).
 */
async function removeAutoForwardRuleForToken(token, sourceGroupId) {
  const groups = await listGroups(token);
  const myGroupIds = new Set(groups.map((g) => g.id));
  assertOwnsSourceGroup(myGroupIds, sourceGroupId);

  af.removeRule(sourceGroupId);
  return getAutoForwardRulesForToken(token);
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
 * Scheduler ya kila saa inayoshughulikia matukio MAWILI kwa kila instance
 * iliyounganika:
 *   1) Muda unakaribia kuisha (bado hajaisha) → onyo MOJA la mapema.
 *   2) Muda tayari umekwisha → kumbusho la mara kwa mara (kila
 *      REMINDER_INTERVAL_HOURS) mpaka alipe.
 * Zote mbili zinatumia link ya malipo pekee (fupi, moja kwa moja
 * "💳 Malipo"). Inafikia tu wateja ambao socket yao iko live kwenye
 * process hii (yaani hakuna redeploy tangu waunganike mara ya mwisho) —
 * mipaka ile ile ya model ya in-memory instances iliyopo kwenye faili hii.
 */
function startReminderScheduler() {
  setInterval(async () => {
    const warningHours = cfg.TRIAL_WARNING_HOURS || 24;

    for (const [phoneNumber, record] of instances.entries()) {
      if (record.status !== 'connected' || !record.sock || !record.token) continue;
      const selfJid = `${phoneNumber}@s.whatsapp.net`;

      // (1) Onyo la mapema — muda bado upo lakini unakaribia kuisha.
      if (await userStore.isExpiryWarningDue(phoneNumber, warningHours)) {
        buildExpiryMessage('warning', record.token).then((text) => {
          record.sock.sendMessage(selfJid, { text }).catch(() => {});
        });
        await userStore.markExpiryWarningSent(phoneNumber);
        continue; // asipate onyo na kumbusho kwenye mzunguko mmoja
      }

      // (2) Muda tayari umekwisha — kumbusho la mara kwa mara.
      const due = await userStore.isReminderDue(phoneNumber, cfg.REMINDER_INTERVAL_HOURS || 24);
      if (!due) continue;

      buildExpiryMessage('reminder', record.token).then((text) => {
        record.sock.sendMessage(selfJid, { text }).catch(() => {});
      });
      await userStore.markReminderSent(phoneNumber);
    }
  }, 60 * 60 * 1000); // checks every hour; per-user due-time controlled above
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
 * Admin-triggered GROUP STATUS post — same idea as adminSendToGroups(),
 * but flags every payload with groupStatus:true (same mechanism as
 * postGroupStatusForToken() above / commands/admin/groupstatus.js), so the
 * admin dashboard's "Groups" tab can post a status update to one or more
 * of a customer's groups directly, without the customer needing to do it
 * themselves from their own dashboard.
 */
async function adminPostGroupStatus(rawPhoneNumber, { groupIds, text, caption, imageBase64, videoBase64, audioBase64, audioMimetype }) {
  const phoneNumber = normalizePhoneNumber(rawPhoneNumber);
  const inst = instances.get(phoneNumber);
  if (!inst) throw new Error('Bot ya namba hii haipo "live" kwenye process hii kwa sasa (labda haijaunganishwa, au kuna redeploy tangu iunganishwe).');
  if (inst.status !== 'connected') throw new Error('Bot bado haijaunganishwa kikamilifu.');
  if (!Array.isArray(groupIds) || groupIds.length === 0) throw new Error('Chagua angalau group moja ya kutuma status.');

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
      // Fresh copy per send — Baileys mutates the content object while
      // building the message (uploads media, strips groupStatus once
      // consumed), so reusing one object across sends only works for the
      // first group. Same fix as postGroupStatusForToken() above.
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
 * Admin: invite link ya GROUP MOJA ya instance ya mteja fulani. Inaitwa moja
 * moja (per group, kwenye kitufe "Pata Link" cha kila group) badala ya
 * kuchukua links za groups zote kwa pamoja — kuepuka kupiga WhatsApp maombi
 * mengi kwa wakati mmoja (rate limit), hasa kwa bot yenye groups nyingi.
 */
async function adminGetGroupInviteLink(rawPhoneNumber, groupId) {
  const phoneNumber = normalizePhoneNumber(rawPhoneNumber);
  const inst = instances.get(phoneNumber);
  if (!inst || inst.status !== 'connected' || !inst.sock) {
    throw new Error('Bot ya namba hii haipo "live" kwa sasa.');
  }
  if (!groupId) throw new Error('groupId haipo.');

  try {
    const code = await inst.sock.groupInviteCode(groupId);
    return { groupId, link: `https://chat.whatsapp.com/${code}` };
  } catch (e) {
    throw new Error('Imeshindwa kupata link (huenda bot si admin kwenye group hii): ' + e.message);
  }
}

/**
 * Admin: tafuta NAMBA yoyote ya WhatsApp (targetRaw) KATIKA GROUPS ZA BOT
 * ZOTE zinazoendesha (si bot moja tu) — kwa sababu namba fulani inaweza
 * kuwa kwenye group ya bot A wakati unaangalia bot B. Inapekua kila
 * instance iliyo "live", na kwa kila group inayopatikana yenye namba hiyo,
 * inajaribu kupata invite link papo hapo (isipokuwa bot si admin humo, ambapo
 * inarudisha ujumbe wa sababu badala ya link). Jina na picha ya profile
 * hutafutwa kwa kutumia instance ya kwanza inayofanikiwa (kila account ina
 * contact store/faragha yake tofauti).
 */
async function adminLookupNumberAcrossAllInstances(targetRaw) {
  const targetNumber = normalizePhoneNumber(targetRaw);
  if (!targetNumber || targetNumber.length < 9) throw new Error('Namba si sahihi — weka namba kamili yenye country code.');

  const live = Array.from(instances.values()).filter(inst => inst.status === 'connected' && inst.sock);
  if (!live.length) throw new Error('Hakuna bot yoyote iliyo "live" kwa sasa.');

  let jid = `${targetNumber}@s.whatsapp.net`;
  let existsOnWhatsApp = null; // null = haikuthibitika kwa uhakika na instance yoyote
  for (const inst of live) {
    try {
      const check = await inst.sock.onWhatsApp(jid);
      const result = Array.isArray(check) ? check[0] : check;
      if (result && typeof result.exists === 'boolean') existsOnWhatsApp = result.exists;
      if (result && result.jid) jid = result.jid;
      if (existsOnWhatsApp !== null) break;
    } catch (e) { /* jaribu instance nyingine */ }
  }
  if (existsOnWhatsApp === false) throw new Error('Namba hii haipo kwenye WhatsApp.');

  let name = targetNumber;
  for (const inst of live) {
    const contact = inst.sock.store?.contacts?.[jid];
    const candidate = (contact?.notify && contact.notify.trim() && !/^\d+$/.test(contact.notify.trim())) ? contact.notify.trim()
      : (contact?.name && contact.name.trim() && !/^\d+$/.test(contact.name.trim())) ? contact.name.trim()
      : null;
    if (candidate) { name = candidate; break; }
  }

  let ppUrl = null;
  for (const inst of live) {
    try {
      ppUrl = await inst.sock.profilePictureUrl(jid, 'image');
      if (ppUrl) break;
    } catch (e) { /* akaunti hii haioni picha yake (faragha) — jaribu nyingine */ }
  }

  // Pekua groups za KILA instance, ukitafuta jid hii kama participant, na
  // pata link papo hapo kwa kila group inayopatikana.
  const groups = [];
  const scanErrors = [];
  for (const inst of live) {
    let chats;
    try {
      chats = await inst.sock.groupFetchAllParticipating();
    } catch (e) {
      scanErrors.push(`${inst.phoneNumber}: ${e.message}`);
      continue;
    }
    const found = Object.values(chats).filter(g => (g.participants || []).some(p => (p.id || p.jid) === jid));
    for (const g of found) {
      let link = null;
      let linkError = null;
      try {
        const code = await inst.sock.groupInviteCode(g.id);
        link = `https://chat.whatsapp.com/${code}`;
      } catch (e) {
        linkError = 'Bot si admin humo, hivyo haiwezi kutoa link.';
      }
      groups.push({
        id: g.id,
        subject: g.subject,
        participants: g.participants.length,
        viaBot: inst.phoneNumber,
        link,
        linkError,
      });
    }
  }

  return { number: targetNumber, jid, name, ppUrl, groups, scanErrors, scannedBots: live.length };
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
  getAutoForwardRulesForToken,
  saveAutoForwardRuleForToken,
  toggleAutoForwardRuleForToken,
  removeAutoForwardRuleForToken,
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
  adminPostGroupStatus,
  adminResetUserSession,
  adminGetGroupInviteLink,
  adminLookupNumberAcrossAllInstances,
  restoreAllInstances,
  adminAdjustDays,
};
