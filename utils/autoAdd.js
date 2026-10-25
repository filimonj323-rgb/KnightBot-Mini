/**
 * Auto-Add: bot inaongeza watu 'randomly' kutoka groups mbalimbali ambazo bot ipo,
 * kwenda kwenye group lengwa (target) lililochaguliwa — polepole, usiku tu.
 *
 * - Kila target ina mipangilio yake: perDay (default 15), dirisha la muda (default 23:00–06:00 EAT = saa 5 usiku hadi saa 12 asubuhi).
 * - Saa ni Africa/Dar_es_Salaam. NB: saa za Kiswahili — "saa 5 usiku" = 23:00, "saa 6 usiku" = 00:00, "saa 12 asubuhi" = 06:00.
 * - Hairudii: mtu aliyejaribiwa (ameongezwa, privacy, n.k.) hajaribiwi tena kwa siku 45;
 *   walioondoka wenyewe kwenye target (.gm left) hawaongezwi tena.
 * - Inaongeza MMOJA kwa wakati. Mapumziko yanahesabiwa kulingana na muda uliobaki wa dirisha na watu waliobaki
 *   (random ndani ya ~55–95% ya wastani) ili quota ya siku ikamilike kabla dirisha halijaisha (mfano 15 ndani ya 23:00–06:00).
 */

const database = require('../database');
const { addMembers } = require('./addMembers');

const TZ = 'Africa/Dar_es_Salaam';
const TICK_MS = 60 * 1000;
const MIN_GAP_MIN = 5;
const END_MARGIN_MIN = 10;             // acha akiba ya dakika kabla dirisha halijaisha
const MAX_PER_DAY_CAP = 30;            // kikomo cha usalama
const TRIED_TTL_MS = 45 * 24 * 60 * 60 * 1000;
const MAX_TRIES_PER_RUN = 3;

const DEFAULTS = { enabled: false, perDay: 15, startHour: 23, endHour: 6 }; // 23:00–06:00 EAT (inavuka usiku wa manane)

// Entries za zamani zilihifadhi dirisha la zamani (0–5). Zibadilishe MARA MOJA kwenda 23–6;
// `windowV2` inazuia kubatilisha dirisha ambalo mtumiaji alilichagua mwenyewe baadaye (.gm autoadd ... window).
function migrateWindows(all) {
  let changed = false;
  for (const cfg of Object.values(all)) {
    if (!cfg) continue;
    if (!cfg.windowV2) {
      if (cfg.startHour === 0 && cfg.endHour === 5) { cfg.startHour = DEFAULTS.startHour; cfg.endHour = DEFAULTS.endHour; cfg.windowKey = null; }
      cfg.windowV2 = true; changed = true;
    }
    // idadi ya zamani (default 10) -> 15, mara moja; `perDayV2` inalinda idadi aliyochagua mtumiaji mwenyewe
    if (!cfg.perDayV2) {
      if (cfg.perDay === 10 || cfg.perDay === undefined) cfg.perDay = DEFAULTS.perDay;
      cfg.perDayV2 = true; changed = true;
    }
  }
  return changed;
}

// ── Owner scoping (bots za wateja wa pairing/instanceManager.js) ──
// Bot kuu: key ya store = groupId (kama zamani, haibadiliki).
// Bot ya mteja: key = "<namba ya mteja>::<groupId>" (muundo ule ule wa database.js scopedGroupKey),
// kwa hiyo mteja mmoja hagusi mipangilio ya mwingine wala ya bot kuu.
const SCOPE_SEP = '::';
const keyFor = (owner, groupId) => (owner ? `${owner}${SCOPE_SEP}${groupId}` : groupId);
const ownerOfKey = (k) => (String(k).includes(SCOPE_SEP) ? String(k).split(SCOPE_SEP)[0] : null);
const groupOfKey = (k) => (String(k).includes(SCOPE_SEP) ? String(k).slice(String(k).indexOf(SCOPE_SEP) + SCOPE_SEP.length) : String(k));

// Ruhusa ya feature kwa mteja — inawashwa/kuzimwa na admin PEKEE (admin dashboard > Mipangilio).
// Inahifadhiwa kwenye botsettings (Turso-backed, owner-scoped), default = OFF.
function ownerHasAccess(owner) {
  if (!owner) return true; // bot kuu haina gate
  try { return database.runWithOwnerScope(owner, () => database.getBotSettings().autoAddAccess === true); }
  catch { return false; }
}
function setOwnerAccess(owner, enabled) {
  return database.runWithOwnerScope(owner, () => database.updateBotSettings({ autoAddAccess: !!enabled }));
}

// Hifadhi entry MOJA tu kwa kusoma store upya (tick inachukua dakika kadhaa — haitakiwi kuandika juu
// ya mabadiliko ya wengine). Sehemu za runtime tu ndizo zinaandikwa; enabled/perDay/dirisha vya
// sasa vinabaki kama mtumiaji alivyovibadilisha wakati run inaendelea.
const RUNTIME_FIELDS = ['count', 'tried', 'totalAdded', 'lastRun', 'lastResult', 'nextAt', 'windowKey'];
function saveEntry(storeKey, cfg) {
  const fresh = database.getAutoAddAll();
  const cur = fresh[storeKey] || cfg;
  for (const f of RUNTIME_FIELDS) if (cfg[f] !== undefined) cur[f] = cfg[f];
  fresh[storeKey] = cur;
  database.saveAutoAddAll(fresh);
}

const rand = (a, b) => a + Math.random() * (b - a);
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shuffle = (arr) => { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

// ── Muda (EAT) ──
function eatNow(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t).value;
  return { hour: Number(get('hour')), date: `${get('year')}-${get('month')}-${get('day')}` };
}
const prevDate = (d) => new Date(new Date(d + 'T00:00:00Z').getTime() - 86400000).toISOString().slice(0, 10);

function inWindow(cfg, hour) {
  const s = cfg.startHour, e = cfg.endHour;
  if (s === e) return true;
  return s < e ? (hour >= s && hour < e) : (hour >= s || hour < e);
}
// Dakika zilizobaki hadi dirisha liishe (EAT = UTC+3, hakuna DST). Dirisha la masaa 24 (s===e) linaisha usiku wa manane.
function minutesLeftInWindow(cfg, date = new Date()) {
  const e = new Date(date.getTime() + 3 * 3600000);
  const nowMin = e.getUTCHours() * 60 + e.getUTCMinutes() + e.getUTCSeconds() / 60;
  if (cfg.startHour === cfg.endHour) return 1440 - nowMin;
  return (cfg.endHour * 60 - nowMin + 1440) % 1440;
}
// Mapumziko ya dakika hadi mtu anayefuata: wastani = (muda uliobaki) / (watu waliobaki), kisha random 55–95% yake.
function nextGapMin(cfg, date = new Date()) {
  const quota = Math.min(cfg.perDay, MAX_PER_DAY_CAP);
  const remaining = quota - (cfg.count || 0);
  if (remaining <= 0) return MIN_GAP_MIN;
  const avg = Math.max(0, minutesLeftInWindow(cfg, date) - END_MARGIN_MIN) / remaining;
  return Math.max(MIN_GAP_MIN, avg * rand(0.55, 0.95));
}
// Kitambulisho cha "dirisha la leo" — quota inaanza upya kila dirisha jipya
function windowKey(cfg, now) {
  const wraps = cfg.startHour > cfg.endHour;
  return wraps && now.hour < cfg.endHour ? prevDate(now.date) : now.date;
}

// ── Helpers za watu ──
function phoneOf(p) {
  for (const x of [p?.phoneNumber, p?.id]) {
    if (x && String(x).endsWith('@s.whatsapp.net')) return String(x).split('@')[0].split(':')[0];
  }
  return null; // LID bila namba — hatuwezi kum-add
}
function botNumbers(sock) {
  const set = new Set();
  for (const x of [sock.user?.id, sock.user?.lid]) if (x) set.add(String(x).split('@')[0].split(':')[0]);
  return set;
}
function isBotAdminIn(meta, sock) {
  const bots = botNumbers(sock);
  const me = (meta.participants || []).find((p) =>
    bots.has(String(p.id || '').split('@')[0].split(':')[0]) || bots.has(String(p.phoneNumber || '').split('@')[0]));
  return !!me && (me.admin === 'admin' || me.admin === 'superadmin');
}

// ── Uchaguzi wa mtu ──
async function pickCandidate(sock, target, cfg, targetMeta) {
  const groups = Object.values(await sock.groupFetchAllParticipating());
  const inTarget = new Set();
  for (const p of targetMeta.participants || []) {
    const ph = phoneOf(p); if (ph) inTarget.add(ph);
    inTarget.add(String(p.id || '').split('@')[0].split(':')[0]);
  }
  const leftNums = new Set(Object.keys(database.getLeftMembers(target) || {}).map((j) => j.split('@')[0].split(':')[0]));
  const bots = botNumbers(sock);
  const now = Date.now();
  const tried = cfg.tried || {};

  // Admins hawaongezwi: mtu yeyote aliye admin/superadmin kwenye group lolote ambalo bot ipo
  // (si tu kwenye group analotoka) anarukwa.
  const adminNums = new Set();
  for (const g of groups) {
    for (const p of g.participants || []) {
      if (p.admin === 'admin' || p.admin === 'superadmin') {
        const ph = phoneOf(p); if (ph) adminNums.add(ph);
      }
    }
  }

  for (const g of shuffle(groups)) {
    if (g.id === target || (g.participants || []).length < 2) continue;
    for (const p of shuffle(g.participants || [])) {
      const ph = phoneOf(p);
      if (!ph || bots.has(ph) || inTarget.has(ph) || leftNums.has(ph) || adminNums.has(ph)) continue;
      if (tried[ph] && now - tried[ph].t < TRIED_TTL_MS) continue;
      return { phone: ph, fromGroup: g.subject };
    }
  }
  return null;
}

/**
 * Jaribu ku-add mtu MMOJA (hadi majaribio MAX_TRIES_PER_RUN ikiwa wa kwanza wana privacy n.k.)
 * Inabadilisha cfg (count, tried, totalAdded) — mwitaji ahifadhi cfg.
 */
async function runOnce(sock, target, cfg, opts = {}) {
  const sleep = opts.sleep || defaultSleep;
  let meta;
  try { meta = await sock.groupMetadata(target); }
  catch (e) { return { ok: false, msg: `Imeshindwa kusoma group lengwa: ${e.message}` }; }
  // Bot haihitaji kuwa admin: inatosha group liruhusu "members wanaweza kuongeza watu" (memberAddMode),
  // au bot iwe admin. Kama hakuna kati ya hivyo (au field haipatikani kwenye toleo la Baileys) tunajaribu
  // MARA MOJA tu kwa kila run na hatumchomi mtu aliyejaribiwa kwa jibu la 403 (linaweza kuwa ni ukosefu wa ruhusa).
  const isAdmin = isBotAdminIn(meta, sock);
  const mayLackPermission = !isAdmin && meta.memberAddMode !== true;
  const maxTries = mayLackPermission ? 1 : MAX_TRIES_PER_RUN;

  cfg.tried = cfg.tried || {};
  for (const [k, v] of Object.entries(cfg.tried)) if (Date.now() - v.t > TRIED_TTL_MS) delete cfg.tried[k]; // safisha

  let lastReason = '';
  for (let i = 0; i < maxTries; i++) {
    const cand = await pickCandidate(sock, target, cfg, meta);
    if (!cand) return { ok: false, msg: lastReason || 'Hakuna mtu mpya wa kuongeza (wote wameshajaribiwa au wapo tayari)' };

    let res;
    try { res = await addMembers(sock, target, [cand.phone]); }
    catch (e) { cfg.tried[cand.phone] = { t: Date.now(), s: 'error' }; lastReason = `Error: ${e.message}`; continue; }

    if (res.added.length) {
      cfg.tried[cand.phone] = { t: Date.now(), s: 'added' };
      cfg.count = (cfg.count || 0) + 1;
      cfg.totalAdded = (cfg.totalAdded || 0) + 1;
      return { ok: true, msg: `Ameongezwa ${cand.phone} (kutoka ${cand.fromGroup}) → ${meta.subject}`, phone: cand.phone };
    }
    if (mayLackPermission && res.privacy.length && !res.added.length) {
      return { ok: false, msg: `Imekataliwa kwenye *${meta.subject}* — bot si admin na group halionekani kuruhusu members kuongeza watu (au mtu ana privacy). Weka bot kuwa admin au ruhusu members wa-add.` };
    }
    const why = res.privacy.length ? 'privacy' : res.recentlyLeft.length ? 'ameondoka karibuni' : res.notOnWA.length ? 'hayupo WhatsApp' : res.already.length ? 'tayari yupo' : 'imeshindwa';
    cfg.tried[cand.phone] = { t: Date.now(), s: why };
    lastReason = `${cand.phone}: ${why}`;
    if (i < maxTries - 1) await sleep(rand(8000, 20000));
  }
  return { ok: false, msg: `Majaribio ${maxTries} hayakufanikiwa (mwisho: ${lastReason})` };
}

// ── Scheduler ──
let timer = null;
const running = new Set(); // "__main__" au namba ya mteja — kila mmoja ana lock yake

async function tick(getSock, opts = {}, owner = null) {
  const lock = owner || '__main__';
  if (running.has(lock)) return;
  running.add(lock);
  try {
    const sock = getSock();
    if (!sock) return;
    if (owner && !ownerHasAccess(owner)) return; // admin amezima feature kwa mteja huyu
    const all = database.getAutoAddAll();
    if (migrateWindows(all)) database.saveAutoAddAll(all);
    for (const [storeKey, cfg] of Object.entries(all)) {
      if (ownerOfKey(storeKey) !== owner) continue; // bot kuu inagusa za bot kuu tu; mteja zake tu
      const target = groupOfKey(storeKey);
      if (!cfg.enabled) continue;
      const now = eatNow(opts.now);
      if (!inWindow(cfg, now.hour)) continue;

      const key = windowKey(cfg, now);
      if (cfg.windowKey !== key) {            // dirisha jipya => quota upya
        cfg.windowKey = key;
        cfg.count = 0;
        cfg.nextAt = Date.now() + rand(0, 3) * 60000;
        saveEntry(storeKey, cfg);
      }
      if ((cfg.count || 0) >= Math.min(cfg.perDay, MAX_PER_DAY_CAP)) continue;
      if (Date.now() < (cfg.nextAt || 0)) continue;

      const r = owner
        ? await database.runWithOwnerScope(owner, () => runOnce(sock, target, cfg, opts))
        : await runOnce(sock, target, cfg, opts);
      cfg.lastRun = Date.now();
      cfg.lastResult = r.msg;
      cfg.nextAt = Date.now() + (r.ok ? nextGapMin(cfg, opts.now || new Date()) : 3) * 60000;
      const tag = owner ? `[autoAdd:${owner}]` : '[autoAdd]';
      if (r.ok) console.log(`${tag} ✅ ${r.msg} (${cfg.count}/${cfg.perDay})`);
      else console.log(`${tag} ⚠️ ${r.msg}`);
      saveEntry(storeKey, cfg);
    }
  } catch (e) {
    console.error('[autoAdd] tick error:', e.message);
  } finally {
    running.delete(lock);
  }
}

// Inaitwa kila bot inapofunguka — salama kuitwa mara nyingi (timer moja tu)
function start(getSock) {
  if (timer) return;
  timer = setInterval(() => tick(getSock), TICK_MS);
  if (timer.unref) timer.unref();
  console.log('[autoAdd] scheduler imeanza (angalia kila dakika 1, dirisha la usiku EAT).');
}

// Bot ya mteja (pairing): timer moja kwa kila mteja. getSock inarudisha sock ya SASA ya mteja
// (au null ikiwa haijaunganishwa) kwa hiyo reconnect haihitaji kuanzisha upya. Salama kuitwa mara nyingi.
const ownerTimers = new Map();
function startForOwner(owner, getSock) {
  if (!owner || ownerTimers.has(owner)) return;
  const t = setInterval(() => tick(getSock, {}, owner), TICK_MS);
  if (t.unref) t.unref();
  ownerTimers.set(owner, t);
}
function stopForOwner(owner) {
  const t = ownerTimers.get(owner);
  if (t) { clearInterval(t); ownerTimers.delete(owner); }
}

// Admin dashboard: chagua/ondoa group lengwa la mteja. Inaunda entry yenye DEFAULTS ikiwa haipo;
// kuzima kunaacha mipangilio na historia (tried/totalAdded) kama ilivyo.
function setTarget(owner, groupId, enabled) {
  const k = keyFor(owner, groupId);
  const all = database.getAutoAddAll();
  const cfg = all[k] || { ...DEFAULTS, windowV2: true, perDayV2: true };
  cfg.enabled = !!enabled;
  if (enabled) cfg.windowKey = null; // quota ianze upya
  all[k] = cfg;
  database.saveAutoAddAll(all);
  return cfg;
}

// Muhtasari wa mipangilio ya mteja mmoja (kwa admin dashboard)
function listForOwner(owner) {
  const out = [];
  for (const [k, c] of Object.entries(database.getAutoAddAll())) {
    if (ownerOfKey(k) !== owner) continue;
    out.push({ groupId: groupOfKey(k), enabled: !!c.enabled, perDay: c.perDay, count: c.count || 0, totalAdded: c.totalAdded || 0, lastResult: c.lastResult || null });
  }
  return out;
}

async function statusText(sock) {
  const owner = sock?.pairingOwnerId || null;
  const all = database.getAutoAddAll();
  if (migrateWindows(all)) database.saveAutoAddAll(all);
  const targets = Object.entries(all).filter(([k]) => ownerOfKey(k) === owner).map(([k, c]) => [groupOfKey(k), c]);
  if (!targets.length) return 'ℹ️ Hakuna group lililowekwa auto-add bado.\nTumia: *.gm autoadd <namba|groupId> on*';
  let names = {};
  try { for (const g of Object.values(await sock.groupFetchAllParticipating())) names[g.id] = g.subject; } catch {}
  const now = eatNow();
  const out = ['👥 *AUTO-ADD*', ''];
  for (const [id, c] of targets) {
    const hh = (h) => String(h).padStart(2, '0') + ':00';
    out.push(`*${names[id] || id}* — ${c.enabled ? '🟢 ON' : '🔴 OFF'}`);
    out.push(`  Leo: ${c.windowKey === windowKey(c, now) ? (c.count || 0) : 0}/${c.perDay} | Jumla: ${c.totalAdded || 0}`);
    out.push(`  Dirisha: ${hh(c.startHour)}–${hh(c.endHour)} EAT`);
    if (c.lastRun) out.push(`  Mara ya mwisho: ${new Date(c.lastRun).toLocaleString('en-GB', { timeZone: TZ, hour12: false })} — ${c.lastResult}`);
    out.push('');
  }
  return out.join('\n').trim();
}

module.exports = {
  start, tick, runOnce, nextGapMin, minutesLeftInWindow, statusText, DEFAULTS, MAX_PER_DAY_CAP, eatNow, inWindow, windowKey,
  keyFor, setTarget, ownerHasAccess, setOwnerAccess, startForOwner, stopForOwner, listForOwner,
};
