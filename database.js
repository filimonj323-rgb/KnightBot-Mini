/**
 * Simple JSON-based Database for Group Settings
 */

const fs = require('fs');
const path = require('path');
const config = require('./config');
const { AsyncLocalStorage } = require('async_hooks');

const DB_PATH = path.join(__dirname, 'database');
const GROUPS_DB = path.join(DB_PATH, 'groups.json');
const USERS_DB = path.join(DB_PATH, 'users.json');
const WARNINGS_DB = path.join(DB_PATH, 'warnings.json');
const MODS_DB = path.join(DB_PATH, 'mods.json');

// Initialize database directory
if (!fs.existsSync(DB_PATH)) {
  fs.mkdirSync(DB_PATH, { recursive: true });
}

// Initialize database files
const initDB = (filePath, defaultData = {}) => {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, JSON.stringify(defaultData, null, 2));
  }
};

initDB(GROUPS_DB, {});
initDB(USERS_DB, {});
initDB(WARNINGS_DB, {});
initDB(MODS_DB, { moderators: [] });

// Read database
const readDB = (filePath) => {
  try {
    const data = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(data);
  } catch (error) {
    console.error(`Error reading database: ${error.message}`);
    return {};
  }
};

// Write database
const writeDB = (filePath, data) => {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    return true;
  } catch (error) {
    console.error(`Error writing database: ${error.message}`);
    return false;
  }
};

// Owner scoping — lets multiple bot instances (the main bot + every
// pairing/instanceManager.js customer) share this same JSON store without
// one customer's group toggle (antipromo/antilink/n.k) leaking onto another
// customer's bot that also happens to be a member of the same physical
// WhatsApp group. A groupId is globally unique, but it is NOT unique to one
// owner — two different linked numbers can both be in the same group.
//
// runWithOwnerScope(ownerId, fn) marks every getGroupSettings/
// updateGroupSettings call made (directly or via any command it triggers)
// during fn's execution as belonging to `ownerId`. Using AsyncLocalStorage
// (not a plain module variable) keeps this correct even when several
// customers' messages are being handled concurrently.
//
// Passing ownerId=null (or never calling runWithOwnerScope at all — e.g. the
// main bot in index.js) keeps the ORIGINAL unscoped groupId key, so existing
// data for the main bot is untouched. Only pairing/instanceManager.js passes
// a real ownerId (the customer's phone number), which is what actually fixes
// the cross-customer leak.
const ownerScopeStorage = new AsyncLocalStorage();

const runWithOwnerScope = (ownerId, fn) => ownerScopeStorage.run(ownerId || null, fn);

const scopedGroupKey = (groupId) => {
  const owner = ownerScopeStorage.getStore();
  return owner ? `${owner}::${groupId}` : groupId;
};

// Group Settings
const getGroupSettings = (groupId) => {
  const key = scopedGroupKey(groupId);
  const groups = readDB(GROUPS_DB);
  if (!groups[key]) {
    groups[key] = { ...config.defaultGroupSettings };
    writeDB(GROUPS_DB, groups);
  }
  return groups[key];
};

const updateGroupSettings = (groupId, settings) => {
  const key = scopedGroupKey(groupId);
  const groups = readDB(GROUPS_DB);
  groups[key] = { ...groups[key], ...settings };
  return writeDB(GROUPS_DB, groups);
};

// User Data
const getUser = (userId) => {
  const users = readDB(USERS_DB);
  if (!users[userId]) {
    users[userId] = {
      registered: Date.now(),
      premium: false,
      banned: false
    };
    writeDB(USERS_DB, users);
  }
  return users[userId];
};

const updateUser = (userId, data) => {
  const users = readDB(USERS_DB);
  users[userId] = { ...users[userId], ...data };
  return writeDB(USERS_DB, users);
};

// Warnings System
const getWarnings = (groupId, userId) => {
  const warnings = readDB(WARNINGS_DB);
  const key = `${groupId}_${userId}`;
  return warnings[key] || { count: 0, warnings: [] };
};

const addWarning = (groupId, userId, reason) => {
  const warnings = readDB(WARNINGS_DB);
  const key = `${groupId}_${userId}`;
  
  if (!warnings[key]) {
    warnings[key] = { count: 0, warnings: [] };
  }
  
  warnings[key].count++;
  warnings[key].warnings.push({
    reason,
    date: Date.now()
  });
  
  writeDB(WARNINGS_DB, warnings);
  return warnings[key];
};

const removeWarning = (groupId, userId) => {
  const warnings = readDB(WARNINGS_DB);
  const key = `${groupId}_${userId}`;
  
  if (warnings[key] && warnings[key].count > 0) {
    warnings[key].count--;
    warnings[key].warnings.pop();
    writeDB(WARNINGS_DB, warnings);
    return true;
  }
  return false;
};

const clearWarnings = (groupId, userId) => {
  const warnings = readDB(WARNINGS_DB);
  const key = `${groupId}_${userId}`;
  delete warnings[key];
  return writeDB(WARNINGS_DB, warnings);
};

// Moderators System
const getModerators = () => {
  const mods = readDB(MODS_DB);
  return mods.moderators || [];
};

const addModerator = (userId) => {
  const mods = readDB(MODS_DB);
  if (!mods.moderators) mods.moderators = [];
  if (!mods.moderators.includes(userId)) {
    mods.moderators.push(userId);
    return writeDB(MODS_DB, mods);
  }
  return false;
};

const removeModerator = (userId) => {
  const mods = readDB(MODS_DB);
  if (mods.moderators) {
    mods.moderators = mods.moderators.filter(id => id !== userId);
    return writeDB(MODS_DB, mods);
  }
  return false;
};

const isModerator = (userId) => {
  const mods = getModerators();
  return mods.includes(userId);
};

module.exports = {
  getGroupSettings,
  updateGroupSettings,
  runWithOwnerScope,
  getUser,
  updateUser,
  getWarnings,
  addWarning,
  removeWarning,
  clearWarnings,
  getModerators,
  addModerator,
  removeModerator,
  isModerator
};
