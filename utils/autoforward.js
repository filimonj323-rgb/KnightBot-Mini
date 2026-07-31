/**
 * Auto-Forward Database Helper
 * Rules: forward messages from a source group to a destination group/channel,
 * either from specific numbers, or from any group admin.
 */

const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'database');
const AUTOFORWARD_DB = path.join(DB_PATH, 'autoforward.json');

function ensureDb() {
  if (!fs.existsSync(DB_PATH)) fs.mkdirSync(DB_PATH, { recursive: true });
  if (!fs.existsSync(AUTOFORWARD_DB)) {
    fs.writeFileSync(AUTOFORWARD_DB, JSON.stringify({ rules: [] }, null, 2));
  }
}

function load() {
  try {
    ensureDb();
    const data = JSON.parse(fs.readFileSync(AUTOFORWARD_DB, 'utf-8'));
    if (!Array.isArray(data.rules)) data.rules = [];
    return data;
  } catch (e) {
    return { rules: [] };
  }
}

function save(data) {
  try {
    ensureDb();
    fs.writeFileSync(AUTOFORWARD_DB, JSON.stringify(data, null, 2));
    return true;
  } catch (e) {
    console.error('[autoforward] save error:', e.message);
    return false;
  }
}

function getRules() {
  return load().rules;
}

function getActiveRulesForSource(sourceGroupId) {
  return load().rules.filter(r => r.sourceGroupId === sourceGroupId && r.enabled);
}

function findRule(sourceGroupId) {
  return load().rules.find(r => r.sourceGroupId === sourceGroupId) || null;
}

function upsertRule(sourceGroupId, patch) {
  const data = load();
  let rule = data.rules.find(r => r.sourceGroupId === sourceGroupId);
  if (!rule) {
    rule = {
      sourceGroupId,
      destinationJid: null,
      enabled: false,
      alladmin: false,
      numbers: []
    };
    data.rules.push(rule);
  }
  Object.assign(rule, patch);
  save(data);
  return rule;
}

function removeRule(sourceGroupId) {
  const data = load();
  const before = data.rules.length;
  data.rules = data.rules.filter(r => r.sourceGroupId !== sourceGroupId);
  save(data);
  return data.rules.length < before;
}

module.exports = {
  getRules,
  getActiveRulesForSource,
  findRule,
  upsertRule,
  removeRule
};
