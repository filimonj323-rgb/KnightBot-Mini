/**
 * signalTargets.js — Group la WhatsApp la kutuma signals na matokeo (profit/loss)
 * kiotomatiki, kwa kila platform: 'deriv' | 'po' (Pocket Option).
 *
 * Mpangilio wa kila platform (unahifadhiwa Turso kupitia pocketStore, hivyo
 * unadumu baada ya restart/redeploy):
 *   { groupJid, groupName, sendSignals, sendResults }
 *
 * Kila function ni "best-effort": group likikosekana au kutuma kukishindwa,
 * trading HAIVUNJIKI — error inaandikwa kwenye log tu.
 */

const pocketStore = require('./pocketStore');
const notifyPrefs = require('./notifyPrefs');

const PLATFORMS = ['deriv', 'po'];
const KEY_PREFIX = 'targets:';

const DEFAULT = Object.freeze({ groupJid: '', groupName: '', sendSignals: false, sendResults: false });
const cache = {};
for (const p of PLATFORMS) cache[p] = { ...DEFAULT };

let loaded = false;

async function load() {
  const rows = await pocketStore.loadSettings(KEY_PREFIX);
  for (const { key, value } of rows) {
    const platform = key.slice(KEY_PREFIX.length);
    if (!PLATFORMS.includes(platform)) continue;
    try {
      cache[platform] = sanitize(JSON.parse(value));
    } catch (err) {
      console.error('[signalTargets] Setting iliyohifadhiwa si sahihi:', key, err.message);
    }
  }
  loaded = true;
}

function sanitize(raw = {}) {
  const groupJid = String(raw.groupJid || '').trim();
  if (groupJid && !groupJid.endsWith('@g.us')) throw new Error('Group JID si sahihi (lazima iishie @g.us).');
  return {
    groupJid,
    groupName: String(raw.groupName || '').slice(0, 120),
    sendSignals: raw.sendSignals === true,
    sendResults: raw.sendResults === true,
  };
}

function assertPlatform(platform) {
  if (!PLATFORMS.includes(platform)) throw new Error('Platform si sahihi (deriv au po).');
}

function get(platform) {
  assertPlatform(platform);
  return { ...cache[platform] };
}

function getAll() {
  return { deriv: get('deriv'), po: get('po') };
}

async function set(platform, raw) {
  assertPlatform(platform);
  const next = sanitize(raw);
  if ((next.sendSignals || next.sendResults) && !next.groupJid) {
    throw new Error('Chagua group kwanza kabla ya kuwasha kutuma signals/matokeo.');
  }
  cache[platform] = next;
  await pocketStore.saveSetting(KEY_PREFIX + platform, next);
  return { ...next };
}

async function sendToGroup(platform, text) {
  const t = cache[platform];
  const sock = global.currentSock;
  if (!t || !t.groupJid || !sock) return false;
  try {
    await notifyPrefs.enqueue(() => sock.sendMessage(t.groupJid, { text })); // foleni = pengo kati ya ujumbe
    return true;
  } catch (err) {
    console.error(`[signalTargets] Imeshindwa kutuma kwenye group (${platform}):`, err.message);
    return false;
  }
}

// Signal mpya (trade ya auto imefunguliwa / auto-signal) -> group, ikiwa imewashwa.
async function sendSignal(platform, text) {
  if (!PLATFORMS.includes(platform) || !cache[platform].sendSignals) return false;
  return sendToGroup(platform, text);
}

// Matokeo (profit/loss) -> group, ikiwa imewashwa.
async function sendResult(platform, text) {
  if (!PLATFORMS.includes(platform) || !cache[platform].sendResults) return false;
  return sendToGroup(platform, text);
}

// Ujumbe wa majaribio (hupuuza toggles — unahitaji group tu).
async function sendTest(platform) {
  assertPlatform(platform);
  const label = platform === 'deriv' ? 'Deriv' : 'Pocket Option';
  const ok = await sendToGroup(platform, `✅ *Test — ${label}*\nGroup hili limechaguliwa kupokea signals na matokeo (profit/loss) kutoka dashboard.`);
  if (!ok) throw new Error('Imeshindwa kutuma — angalia kama bot imeunganishwa na bado ni member wa group.');
  return true;
}

// Orodha ya groups ambazo bot kuu ni member.
async function listGroups() {
  const sock = global.currentSock;
  if (!sock) throw new Error('Bot kuu haijaunganishwa na WhatsApp.');
  const chats = await sock.groupFetchAllParticipating();
  return Object.values(chats)
    .map((g) => ({ id: g.id, subject: g.subject || g.id, participants: (g.participants || []).length }))
    .sort((a, b) => a.subject.localeCompare(b.subject));
}

module.exports = { PLATFORMS, load, get, getAll, set, sendSignal, sendResult, sendTest, listGroups, isLoaded: () => loaded };
