/**
 * Shared helper: ongeza members kwenye group (inatumika na `.add` na `.gm add`)
 */

const database = require('../database');

const MAX_PER_COMMAND = 20;
const DELAY_MS = 2000; // pumziko kati ya kila mtu — epuka WhatsApp ku-flag bot

// Sanifisha namba: 0712345678 / 712345678 (Tanzania) -> 255712345678
function normalizeNumber(raw) {
  let n = String(raw || '').replace(/[^0-9]/g, '');
  if (!n) return null;
  if (n.startsWith('0') && n.length === 10) n = '255' + n.slice(1);
  else if (n.length === 9 && /^[67]/.test(n)) n = '255' + n;
  if (n.length < 8 || n.length > 15) return null;
  return n;
}

// Gawanya input (args au string) kuwa namba safi, ondoa marudio
function parseNumbers(input) {
  const parts = (Array.isArray(input) ? input.join(' ') : String(input || '')).split(/[\s,;]+/).filter(Boolean);
  const valid = [];
  const invalid = [];
  for (const p of parts) {
    const n = normalizeNumber(p);
    if (n) { if (!valid.includes(n)) valid.push(n); } else invalid.push(p);
  }
  return { valid, invalid };
}

async function addMembers(sock, groupId, numbers) {
  const res = { added: [], already: [], privacy: [], recentlyLeft: [], notOnWA: [], failed: [], skipped: 0 };
  const list = numbers.slice(0, MAX_PER_COMMAND);
  res.skipped = numbers.length - list.length;

  const meta = await sock.groupMetadata(groupId);
  res.subject = meta.subject;
  const inGroup = (n, jid) => (meta.participants || []).some((p) =>
    p.id === jid || p.phoneNumber === jid || (p.id || '').split('@')[0] === n || (p.phoneNumber || '').split('@')[0] === n);

  for (let i = 0; i < list.length; i++) {
    const n = list[i];
    let jid = `${n}@s.whatsapp.net`;
    try {
      const check = await sock.onWhatsApp(jid);
      if (!check?.[0]?.exists) { res.notOnWA.push(n); continue; }
      jid = check[0].jid || jid;

      if (inGroup(n, jid)) { res.already.push(n); continue; }

      const r = await sock.groupParticipantsUpdate(groupId, [jid], 'add');
      const status = String(r?.[0]?.status);
      if (status === '200') { res.added.push(n); database.removeLeftMember(groupId, jid); }
      else if (status === '409') res.already.push(n);
      else if (status === '403') res.privacy.push(n);
      else if (status === '408') res.recentlyLeft.push(n);
      else res.failed.push(`${n} (${status})`);
    } catch (e) {
      res.failed.push(`${n} (${e.message})`);
    }
    if (i < list.length - 1) await new Promise((r) => setTimeout(r, DELAY_MS));
  }
  return res;
}

function formatResult(res, invalid = []) {
  const lines = [`👥 *Matokeo — ${res.subject}*`, ''];
  if (res.added.length) lines.push(`✅ Wameongezwa (${res.added.length}): ${res.added.join(', ')}`);
  if (res.already.length) lines.push(`ℹ️ Tayari wapo (${res.already.length}): ${res.already.join(', ')}`);
  if (res.privacy.length) lines.push(`🔒 Privacy hairuhusu (${res.privacy.length}): ${res.privacy.join(', ')}\n   ↳ Watumie invite link (*.gm link* / *.link*)`);
  if (res.recentlyLeft.length) lines.push(`⏳ Wameondoka hivi karibuni (${res.recentlyLeft.length}): ${res.recentlyLeft.join(', ')}\n   ↳ Subiri kidogo au tumia invite link`);
  if (res.notOnWA.length) lines.push(`❌ Hawapo WhatsApp (${res.notOnWA.length}): ${res.notOnWA.join(', ')}`);
  if (res.failed.length) lines.push(`⚠️ Imeshindwa (${res.failed.length}): ${res.failed.join(', ')}`);
  if (invalid.length) lines.push(`🚫 Namba zisizo sahihi: ${invalid.join(', ')}`);
  if (res.skipped) lines.push(`⏭️ Zimerukwa ${res.skipped} (kikomo ${MAX_PER_COMMAND} kwa amri moja)`);
  return lines.join('\n');
}

module.exports = { addMembers, parseNumbers, formatResult, normalizeNumber, MAX_PER_COMMAND };
