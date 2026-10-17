/**
 * Auto-Add: bot inaongeza watu 'randomly' kutoka groups mbalimbali ambazo bot ipo,
 * kwenda kwenye group lengwa (target) lililochaguliwa — polepole, usiku tu.
 *
 * - Kila target ina mipangilio yake: perDay (default 10), dirisha la muda (default 00:00–05:00 EAT).
 * - Saa ni Africa/Dar_es_Salaam. NB: "saa 6 usiku" ya Kiswahili = 00:00 (usiku wa manane).
 * - Hairudii: mtu aliyejaribiwa (ameongezwa, privacy, n.k.) hajaribiwi tena kwa siku 45;
 *   walioondoka wenyewe kwenye target (.gm left) hawaongezwi tena.
 * - Inaongeza MMOJA kwa wakati, kwa mapumziko ya random ya dakika 15–35.
 */

const database = require('../database');
const { addMembers } = require('./addMembers');

const TZ = 'Africa/Dar_es_Salaam';
const TICK_MS = 3 * 60 * 1000;
const MIN_GAP_MIN = 15;
const MAX_GAP_MIN = 35;
const MAX_PER_DAY_CAP = 30;            // kikomo cha usalama
const TRIED_TTL_MS = 45 * 24 * 60 * 60 * 1000;
const MAX_TRIES_PER_RUN = 3;

const DEFAULTS = { enabled: false, perDay: 10, startHour: 0, endHour: 5 };

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

  for (const g of shuffle(groups)) {
    if (g.id === target || (g.participants || []).length < 2) continue;
    for (const p of shuffle(g.participants || [])) {
      const ph = phoneOf(p);
      if (!ph || bots.has(ph) || inTarget.has(ph) || leftNums.has(ph)) continue;
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
  if (!isBotAdminIn(meta, sock)) return { ok: false, msg: `Bot si admin kwenye *${meta.subject}*` };

  cfg.tried = cfg.tried || {};
  for (const [k, v] of Object.entries(cfg.tried)) if (Date.now() - v.t > TRIED_TTL_MS) delete cfg.tried[k]; // safisha

  let lastReason = '';
  for (let i = 0; i < MAX_TRIES_PER_RUN; i++) {
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
    const why = res.privacy.length ? 'privacy' : res.recentlyLeft.length ? 'ameondoka karibuni' : res.notOnWA.length ? 'hayupo WhatsApp' : res.already.length ? 'tayari yupo' : 'imeshindwa';
    cfg.tried[cand.phone] = { t: Date.now(), s: why };
    lastReason = `${cand.phone}: ${why}`;
    if (i < MAX_TRIES_PER_RUN - 1) await sleep(rand(15000, 45000));
  }
  return { ok: false, msg: `Majaribio ${MAX_TRIES_PER_RUN} hayakufanikiwa (mwisho: ${lastReason})` };
}

// ── Scheduler ──
let timer = null;
let running = false;

async function tick(getSock, opts = {}) {
  if (running) return;
  running = true;
  try {
    const sock = getSock();
    if (!sock) return;
    const all = database.getAutoAddAll();
    for (const [target, cfg] of Object.entries(all)) {
      if (!cfg.enabled) continue;
      const now = eatNow(opts.now);
      if (!inWindow(cfg, now.hour)) continue;

      const key = windowKey(cfg, now);
      if (cfg.windowKey !== key) {            // dirisha jipya => quota upya
        cfg.windowKey = key;
        cfg.count = 0;
        cfg.nextAt = Date.now() + rand(0, 15) * 60000;
        database.saveAutoAddAll(all);
      }
      if ((cfg.count || 0) >= Math.min(cfg.perDay, MAX_PER_DAY_CAP)) continue;
      if (Date.now() < (cfg.nextAt || 0)) continue;

      const r = await runOnce(sock, target, cfg, opts);
      cfg.lastRun = Date.now();
      cfg.lastResult = r.msg;
      cfg.nextAt = Date.now() + (r.ok ? rand(MIN_GAP_MIN, MAX_GAP_MIN) : 10) * 60000;
      if (r.ok) console.log(`[autoAdd] ✅ ${r.msg} (${cfg.count}/${cfg.perDay})`);
      else console.log(`[autoAdd] ⚠️ ${r.msg}`);
      database.saveAutoAddAll(all);
    }
  } catch (e) {
    console.error('[autoAdd] tick error:', e.message);
  } finally {
    running = false;
  }
}

// Inaitwa kila bot inapofunguka — salama kuitwa mara nyingi (timer moja tu)
function start(getSock) {
  if (timer) return;
  timer = setInterval(() => tick(getSock), TICK_MS);
  if (timer.unref) timer.unref();
  console.log('[autoAdd] scheduler imeanza (angalia kila dakika 3, dirisha la usiku EAT).');
}

async function statusText(sock) {
  const all = database.getAutoAddAll();
  const targets = Object.entries(all);
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

module.exports = { start, tick, runOnce, statusText, DEFAULTS, MAX_PER_DAY_CAP, eatNow, inWindow, windowKey };
