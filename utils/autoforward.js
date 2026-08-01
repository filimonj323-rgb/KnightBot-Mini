/**
 * Auto-Forward Database Helper
 * Rules: forward messages from a source group to a destination group/channel,
 * either from specific numbers, or from any group admin.
 *
 * ⚡ PERFORMANCE: rules zinahifadhiwa kwenye MEMORY (cache) baada ya kusomwa
 * mara moja. Kabla, kila ujumbe kwenye group YOYOTE ulisababisha kusoma faili
 * kutoka diski (synchronous/blocking) - hii ilikuwa inazuia (block) event loop
 * nzima ya bot kwa muda mfupi kila ujumbe unapoingia, ikisababisha commands
 * kuchelewa na "waiting for message". Sasa disk inasomwa MARA MOJA tu, na
 * kuandikwa upya (save) kwa njia ya async isiyoblock chochote.
 */

const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'database');
const AUTOFORWARD_DB = path.join(DB_PATH, 'autoforward.json');

let cache = null; // { rules: [...] } - inabaki kwenye memory maadamu process haijarestart

function ensureDbSync() {
  if (!fs.existsSync(DB_PATH)) fs.mkdirSync(DB_PATH, { recursive: true });
  if (!fs.existsSync(AUTOFORWARD_DB)) {
    fs.writeFileSync(AUTOFORWARD_DB, JSON.stringify({ rules: [] }, null, 2));
  }
}

// Inasoma kutoka diski MARA MOJA tu (wakati wa kwanza kabisa kuitwa),
// baada ya hapo inarudisha cache ya memory - haraka sana, hakuna blocking I/O.
function ensureLoaded() {
  if (cache !== null) return cache;
  try {
    ensureDbSync();
    const data = JSON.parse(fs.readFileSync(AUTOFORWARD_DB, 'utf-8'));
    if (!Array.isArray(data.rules)) data.rules = [];
    cache = data;
  } catch (e) {
    cache = { rules: [] };
  }
  return cache;
}

// Inaandika kwenye diski kwa njia ya ASYNC (haiblock event loop hata kidogo).
function persist() {
  fs.writeFile(AUTOFORWARD_DB, JSON.stringify(cache, null, 2), (err) => {
    if (err) console.error('[autoforward] save error:', err.message);
  });
}

function load() {
  return ensureLoaded();
}

function save(data) {
  cache = data;
  persist();
  return true;
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

function setAllEnabled(enabled) {
  const data = load();
  data.rules.forEach(r => { r.enabled = enabled; });
  save(data);
  return data.rules.length;
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
  removeRule,
  setAllEnabled
};
