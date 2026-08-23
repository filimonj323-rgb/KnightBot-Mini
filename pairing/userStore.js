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
    `UPDATE users SET trialExpiresAt=?, isPaid=?, paidUntil=?, blocked=?, expiryNotifiedAt=?, lastReminderAt=? WHERE phoneNumber=?`,
    [u.trialExpiresAt, u.isPaid ? 1 : 0, u.paidUntil, u.blocked ? 1 : 0, u.expiryNotifiedAt, u.lastReminderAt, u.phoneNumber]
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

module.exports = {
  TRIAL_DAYS,
  ensureUser,
  getUser,
  getAllUsers,
  getAccessStatus,
  markPaid,
  extendTrial,
  setBlocked,
  markExpiryNotified,
  isReminderDue,
  markReminderSent,
  getPaymentHistory,
};
