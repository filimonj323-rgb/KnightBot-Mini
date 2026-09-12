/**
 * Pending Analyze Follow-up Store
 *
 * Inatunza (kwa muda) muktadha (context) wa uchambuzi wa mwisho wa
 * ".analyze <symbol>" aliopewa mtumiaji, ili akitumia ".swali <swali lako>"
 * (au button "❓ Uliza Swali Zaidi" inayomwelekeza kwenye command hiyo hiyo),
 * bot iweze kujibu ikitumia data ile ile ya uchambuzi — bila kuomba tena
 * symbol au ku-fetch upya.
 *
 * MUHIMU (kwa nini si "free-text bila prefix"): tulijaribu awali muundo wa
 * "andika ujumbe wowote unaofuata, bila prefix, nitautambua kama swali" —
 * lakini hii ilikuwa hatari kwenye groups: ujumbe WOWOTE usiofungamana wa
 * mtumiaji (chat ya kawaida na wenzake) ungeweza "kunaswa" kimakosa kama
 * swali. Sasa mtumiaji LAZIMA atumie command ya wazi (".swali ...") —
 * hakuna kunasa ujumbe kimya kimya.
 *
 * Muundo:
 *   key: sender jid
 *   value: { context: { symbol, name, data, calc, ai, newsContext }, timestamp }
 *
 * Data inafutwa baada ya TTL (dakika 10) au baada ya kufutwa wazi.
 */

const pending = new Map();
const TTL_MS = 10 * 60 * 1000; // dakika 10

function set(sender, context) {
  pending.set(sender, { context, timestamp: Date.now() });
}

function get(sender) {
  const entry = pending.get(sender);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > TTL_MS) {
    pending.delete(sender);
    return null;
  }
  return entry;
}

// Rejesha muda (TTL) - inaitwa baada ya .swali kutumika, ili mtumiaji aweze
// kuuliza maswali kadhaa mfululizo bila kila mara kuanzia upya.
function touch(sender) {
  const entry = pending.get(sender);
  if (entry) entry.timestamp = Date.now();
}

function clear(sender) {
  pending.delete(sender);
}

module.exports = { set, get, touch, clear };
