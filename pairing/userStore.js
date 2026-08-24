/**
 * pairing/userStore.js
 *
 * Tracks, per customer phone number: trial expiry, paid-until date, admin
 * "blocked" flag, and full payment history — backed by Turso (cloud
 * SQLite, db.js). Every function here is ASYNC — always `await` them.
 */

const db = require('./db');
const cfg = require('./pairingConfig');

const DAY_MS = 24 * 60 * 60 * 1000;
const TRIAL_DAYS = cfg.TRIAL_DAYS;

function rowToUser(row) {
  if (!row) return null;
  return {
    phoneNumber: row.phoneNumber,
    pairedAt: row.pairedAt,
    trialExpiresAt: row.trialExpiresAt,
    isPaid: !!row.isPaid,
    paidUntil: row.paidUntil,
    blocked: !!row.blocked,
    expiryNotifiedAt: row.expiryNotifiedAt,
    lastReminderAt: row.lastReminderAt,
    trialWarningSentAt: row.trialWarningSentAt,
  };
}

/**
 * Creates a user record the first time a phone number pairs. Safe to call
 * repeatedly — does nothing if the record already exists, so re-pairing
 * (e.g. after a redeploy) never resets someone's trial or paid status.
 */
async function ensureUser(phoneNumber) {
  const res = await db.query('SELECT * FROM users WHERE phoneNumber = ?', [phoneNumber]);
  if (res.rows.length) return rowToUser(res.rows[0]);

  const now = Date.now();
  const trialExpiresAt = now + TRIAL_DAYS * DAY_MS;
  await db.query(
    'INSERT INTO users (phoneNumber, pairedAt, trialExpiresAt, isPaid, paidUntil, blocked, expiryNotifiedAt, lastReminderAt) VALUES (?, ?, ?, 0, NULL, 0, NULL, NULL)',
    [phoneNumber, now, trialExpiresAt]
  );
  return {
    phoneNumber, pairedAt: now, trialExpiresAt,
    isPaid: false, paidUntil: null, blocked: false,
    expiryNotifiedAt: null, lastReminderAt: null,
  };
}

async function getUser(phoneNumber) {
  const res = await db.query('SELECT * FROM users WHERE phoneNumber = ?', [phoneNumber]);
  return rowToUser(res.rows[0]);
}

async function getAllUsers() {
  const res = await db.query('SELECT * FROM users ORDER BY pairedAt DESC', []);
  return res.rows.map(rowToUser);
}

async function getPaymentHistory(phoneNumber) {
  const res = await db.query('SELECT * FROM payments WHERE phoneNumber = ? ORDER BY at DESC', [phoneNumber]);
  return res.rows;
}

async function saveUser(u) {
  await db.query(
    `UPDATE users SET trialExpiresAt=?, isPaid=?, paidUntil=?, blocked=?, expiryNotifiedAt=?, lastReminderAt=?, trialWarningSentAt=? WHERE phoneNumber=?`,
    [u.trialExpiresAt, u.isPaid ? 1 : 0, u.paidUntil, u.blocked ? 1 : 0, u.expiryNotifiedAt, u.lastReminderAt, u.trialWarningSentAt, u.phoneNumber]
  );
}

/**
 * The single source of truth for "is this customer's bot allowed to reply
 * right now". Checked on every incoming message in instanceManager.js.
 */
async function getAccessStatus(phoneNumber) {
  const u = await ensureUser(phoneNumber);
  const now = Date.now();

  if (u.blocked) return { allowed: false, reason: 'blocked', user: u };
  if (u.isPaid && u.paidUntil && u.paidUntil > now) {
    return { allowed: true, reason: 'paid', paidUntil: u.paidUntil, user: u };
  }
  if (!u.isPaid && u.trialExpiresAt > now) {
    return { allowed: true, reason: 'trial', trialExpiresAt: u.trialExpiresAt, user: u };
  }
  return { allowed: false, reason: (u.paidUntil ? 'subscription_expired' : 'trial_expired'), user: u };
}

/**
 * Records a successful payment. Extends from whichever is later: now, or
 * their current paidUntil (so paying early stacks on top of remaining time
 * instead of wasting it).
 */
async function markPaid(phoneNumber, days, meta = {}) {
  const u = await ensureUser(phoneNumber);
  const now = Date.now();
  const base = (u.isPaid && u.paidUntil && u.paidUntil > now) ? u.paidUntil : now;

  u.isPaid = true;
  u.paidUntil = base + days * DAY_MS;
  u.expiryNotifiedAt = null;
  u.trialWarningSentAt = null;
  await saveUser(u);

  await db.query(
    'INSERT INTO payments (phoneNumber, at, days, amount, method, orderReference, paymentReference, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [phoneNumber, now, days, meta.amount ?? null, meta.method ?? null, meta.orderReference ?? null, meta.paymentReference ?? null, meta.note ?? null]
  );

  return u;
}

async function extendTrial(phoneNumber, days) {
  const u = await ensureUser(phoneNumber);
  const now = Date.now();
  const base = u.trialExpiresAt > now ? u.trialExpiresAt : now;
  u.trialExpiresAt = base + days * DAY_MS;
  u.expiryNotifiedAt = null;
  u.trialWarningSentAt = null;
  await saveUser(u);
  return u;
}

/**
 * Admin "badilisha muda" — days can be POSITIVE (ongeza) or NEGATIVE
 * (punguza), unlike markPaid/extendTrial which only ever add. Adjusts
 * whichever bucket the customer is actually on: paidUntil if they've ever
 * paid (even if currently lapsed — so a negative admin adjustment on an
 * active paid customer can push them into expired, and a positive one can
 * revive a lapsed paid customer), otherwise trialExpiresAt.
 */
async function adjustActiveDays(phoneNumber, deltaDays) {
  const u = await ensureUser(phoneNumber);
  const now = Date.now();

  if (u.isPaid) {
    const base = u.paidUntil || now;
    u.paidUntil = base + deltaDays * DAY_MS;
  } else {
    u.trialExpiresAt = u.trialExpiresAt + deltaDays * DAY_MS;
  }
  u.expiryNotifiedAt = null;
  u.trialWarningSentAt = null;
  await saveUser(u);
  return u;
}

async function setBlocked(phoneNumber, blocked) {
  const u = await ensureUser(phoneNumber);
  u.blocked = !!blocked;
  await saveUser(u);
  return u;
}

async function markExpiryNotified(phoneNumber) {
  const u = await ensureUser(phoneNumber);
  u.expiryNotifiedAt = Date.now();
  await saveUser(u);
}

/** Used by the daily payment-reminder scheduler in instanceManager.js. */
async function isReminderDue(phoneNumber, intervalHours) {
  const u = await ensureUser(phoneNumber);
  if (u.blocked) return false;
  const now = Date.now();
  const stillHasAccess = (u.isPaid && u.paidUntil > now) || (!u.isPaid && u.trialExpiresAt > now);
  if (stillHasAccess) return false;
  const intervalMs = intervalHours * 60 * 60 * 1000;
  return !u.lastReminderAt || (now - u.lastReminderAt) >= intervalMs;
}

async function markReminderSent(phoneNumber) {
  const u = await ensureUser(phoneNumber);
  u.lastReminderAt = Date.now();
  await saveUser(u);
}

/**
 * True kama akaunti BADO ina access (trial au malipo) lakini muda
 * uliobaki ni mchache (<= warningHours) na bado hajapewa onyo hili kwa
 * mzunguko huu wa kuisha — hutumika kutuma "muda unakaribia kuisha" MARA
 * MOJA kabla haujaisha (tofauti na isReminderDue, ambayo ni kwa AKAUNTI
 * ZILIZOKWISHA ISHA muda tayari).
 */
async function isExpiryWarningDue(phoneNumber, warningHours) {
  const u = await ensureUser(phoneNumber);
  if (u.blocked) return false;

  const now = Date.now();
  const expiresAt = u.isPaid ? u.paidUntil : u.trialExpiresAt;
  if (!expiresAt) return false;

  const msLeft = expiresAt - now;
  if (msLeft <= 0) return false; // tayari imeisha — hiyo inashughulikiwa na notisi/kumbusho lingine
  if (msLeft > warningHours * 60 * 60 * 1000) return false; // bado mapema

  // Onyo moja tu kwa kila "mzunguko wa kuisha" (yaani tangu mara ya mwisho
  // aliyeongezewa muda / kulipa) — trialWarningSentAt inafutwa na
  // markPaid/extendTrial/adjustActiveDays, hivyo huanza upya kila mzunguko.
  return !u.trialWarningSentAt;
}

async function markExpiryWarningSent(phoneNumber) {
  const u = await ensureUser(phoneNumber);
  u.trialWarningSentAt = Date.now();
  await saveUser(u);
}

/**
 * Usage tracking — one row per (phoneNumber, date), incremented once per
 * inbound message the bot actually handled that day. Powers the "Matumizi"
 * tab on the admin dashboard.
 */
function todayKey() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

async function incrementUsage(phoneNumber) {
  await db.query(
    `INSERT INTO usage_daily (phoneNumber, date, messageCount) VALUES (?, ?, 1)
     ON CONFLICT(phoneNumber, date) DO UPDATE SET messageCount = messageCount + 1`,
    [phoneNumber, todayKey()]
  );
}

/** Returns the last `days` days of usage, oldest first, zero-filled for days with no activity. */
async function getUsage(phoneNumber, days = 14) {
  const since = new Date(Date.now() - (days - 1) * DAY_MS).toISOString().slice(0, 10);
  const res = await db.query(
    'SELECT date, messageCount FROM usage_daily WHERE phoneNumber = ? AND date >= ? ORDER BY date ASC',
    [phoneNumber, since]
  );
  const byDate = new Map(res.rows.map((r) => [r.date, r.messageCount]));
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * DAY_MS).toISOString().slice(0, 10);
    out.push({ date: d, messageCount: byDate.get(d) || 0 });
  }
  return out;
}

module.exports = {
  TRIAL_DAYS,
  ensureUser,
  getUser,
  getAllUsers,
  getAccessStatus,
  markPaid,
  extendTrial,
  adjustActiveDays,
  setBlocked,
  markExpiryNotified,
  isReminderDue,
  markReminderSent,
  isExpiryWarningDue,
  markExpiryWarningSent,
  getPaymentHistory,
  incrementUsage,
  getUsage,
};
