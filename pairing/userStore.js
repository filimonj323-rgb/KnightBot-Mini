/**
 * pairing/userStore.js
 *
 * Tracks, per customer phone number: when their free trial started/expires,
 * whether they've paid and until when, and an admin "blocked" flag. Backs
 * both the admin dashboard (list/manage all customers) and the access gate
 * in instanceManager.js (block bot replies once trial/subscription lapses).
 *
 * Persisted as a single JSON file, same lightweight pattern as
 * sessions/_tokens.json and sessions/_settings.json already used here.
 */

const fs = require('fs');
const path = require('path');
const cfg = require('./pairingConfig');

const SESSIONS_ROOT = path.join(__dirname, 'sessions');
if (!fs.existsSync(SESSIONS_ROOT)) fs.mkdirSync(SESSIONS_ROOT, { recursive: true });
const USERS_FILE = path.join(SESSIONS_ROOT, '_users.json');

const DAY_MS = 24 * 60 * 60 * 1000;

// Free trial length — edit TRIAL_DAYS in pairing/pairingConfig.js to change.
const TRIAL_DAYS = cfg.TRIAL_DAYS;

let users = {}; // phoneNumber -> record

function load() {
  try {
    users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
  } catch (e) {
    users = {};
  }
}
function persist() {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}
load();

/**
 * Creates a user record the first time a phone number pairs. Safe to call
 * repeatedly — does nothing if the record already exists, so re-pairing
 * (e.g. after a redeploy) never resets someone's trial or paid status.
 */
function ensureUser(phoneNumber) {
  if (!users[phoneNumber]) {
    const now = Date.now();
    users[phoneNumber] = {
      phoneNumber,
      pairedAt: now,
      trialExpiresAt: now + TRIAL_DAYS * DAY_MS,
      isPaid: false,
      paidUntil: null,
      blocked: false,
      expiryNotifiedAt: null,
      lastReminderAt: null,
      paymentHistory: [], // { at, days, amount, orderReference, method }
    };
    persist();
  }
  return users[phoneNumber];
}

function getUser(phoneNumber) {
  return users[phoneNumber] || null;
}

function getAllUsers() {
  return Object.values(users);
}

/**
 * The single source of truth for "is this customer's bot allowed to reply
 * right now". Checked on every incoming message in instanceManager.js.
 */
function getAccessStatus(phoneNumber) {
  const u = ensureUser(phoneNumber);
  const now = Date.now();

  if (u.blocked) {
    return { allowed: false, reason: 'blocked', user: u };
  }
  if (u.isPaid && u.paidUntil && u.paidUntil > now) {
    return { allowed: true, reason: 'paid', paidUntil: u.paidUntil, user: u };
  }
  if (!u.isPaid && u.trialExpiresAt > now) {
    return { allowed: true, reason: 'trial', trialExpiresAt: u.trialExpiresAt, user: u };
  }
  // Either trial ran out and never paid, or a previous subscription lapsed.
  return {
    allowed: false,
    reason: (u.paidUntil ? 'subscription_expired' : 'trial_expired'),
    user: u,
  };
}

/**
 * Records a successful payment. Extends from whichever is later: now, or
 * their current paidUntil (so paying early stacks on top of remaining time
 * instead of wasting it).
 */
function markPaid(phoneNumber, days, meta = {}) {
  const u = ensureUser(phoneNumber);
  const now = Date.now();
  const base = (u.isPaid && u.paidUntil && u.paidUntil > now) ? u.paidUntil : now;
  u.isPaid = true;
  u.paidUntil = base + days * DAY_MS;
  u.expiryNotifiedAt = null;
  u.paymentHistory.push({ at: now, days, ...meta });
  persist();
  return u;
}

function extendTrial(phoneNumber, days) {
  const u = ensureUser(phoneNumber);
  const now = Date.now();
  const base = u.trialExpiresAt > now ? u.trialExpiresAt : now;
  u.trialExpiresAt = base + days * DAY_MS;
  u.expiryNotifiedAt = null;
  persist();
  return u;
}

function setBlocked(phoneNumber, blocked) {
  const u = ensureUser(phoneNumber);
  u.blocked = !!blocked;
  persist();
  return u;
}

/**
 * Marks that we've already sent this customer a "your trial/subscription
 * expired" WhatsApp notice, so instanceManager.js only sends it once
 * instead of on every reconnect.
 */
function markExpiryNotified(phoneNumber) {
  const u = ensureUser(phoneNumber);
  u.expiryNotifiedAt = Date.now();
  persist();
}

/**
 * Used by the daily payment-reminder scheduler in instanceManager.js.
 * Returns true if this customer is currently locked out (trial/sub
 * expired, not blocked) AND enough time has passed since their last
 * reminder (or they've never gotten one).
 */
function isReminderDue(phoneNumber, intervalHours) {
  const u = ensureUser(phoneNumber);
  if (u.blocked) return false;
  const now = Date.now();
  const stillHasAccess = (u.isPaid && u.paidUntil > now) || (!u.isPaid && u.trialExpiresAt > now);
  if (stillHasAccess) return false;
  const intervalMs = intervalHours * 60 * 60 * 1000;
  return !u.lastReminderAt || (now - u.lastReminderAt) >= intervalMs;
}

function markReminderSent(phoneNumber) {
  const u = ensureUser(phoneNumber);
  u.lastReminderAt = Date.now();
  persist();
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
};
