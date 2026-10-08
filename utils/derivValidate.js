/**
 * derivValidate.js — Kuthibitisha API token ya Deriv ya mteja KABLA ya kuihifadhi.
 *
 * Inauliza Deriv orodha ya Options accounts za token hiyo na kuamua kama ni DEMO.
 * FAIL-CLOSED: bila uthibitisho wazi kwamba akaunti ni demo, token inakataliwa.
 * (Tofauti na derivTrader.resolveAccountId() ya owner ambayo ina `|| accounts[0]` —
 * kwa mteja hiyo ingechagua akaunti ya REAL kimya.)
 *
 * Ishara mbili lazima zikubaliane: bendera ya Deriv (is_virtual/demo/account_type) NA kiambishi
 * cha account id (VRT… = demo; CR/MF/MLT/MX… = real). Zikipingana, au bendera ikikosekana,
 * akaunti hiyo inahesabiwa "haijulikani" na haitumiki.
 *
 * ⚠️ Majina ya field ya Deriv API mpya hayajathibitishwa na network hapa — tunakubali majina
 * yale yale ambayo derivTrader.js tayari inayatumia. Ikiwa Deriv itabadilisha, matokeo ni
 * "akaunti haijulikani" (kukataa), si kukubali kimakosa.
 *
 * Token KAMWE haiandikwi kwenye log wala kwenye ujumbe wa kosa.
 */

const axios = require('axios');

const API_BASE = process.env.DERIV_API_BASE || 'https://api.derivws.com'; // inabadilika kwa majaribio tu
const TIMEOUT_MS = 12000;

class DerivValidationError extends Error {
  constructor(userMessage, code) {
    super(userMessage);
    this.code = code || 'VALIDATION';
    this.userMessage = userMessage;
  }
}

function truthy(v) {
  return v === true || v === 1 || v === '1' || String(v).toLowerCase() === 'true';
}

/** Inarudisha { id, demo: true|false|null }. null = haijulikani/zinapingana. */
function classify(a) {
  const id = String(a?.account_id ?? a?.id ?? a?.loginid ?? '');
  const votes = [];
  if (a?.is_virtual !== undefined && a?.is_virtual !== null) votes.push(truthy(a.is_virtual));
  if (a?.is_demo !== undefined && a?.is_demo !== null) votes.push(truthy(a.is_demo));
  if (a?.demo !== undefined && a?.demo !== null) votes.push(truthy(a.demo));
  if (typeof a?.account_type === 'string') votes.push(a.account_type.toLowerCase() === 'demo');
  if (!votes.length) return { id, demo: null };
  if (votes.some((v) => v) && votes.some((v) => !v)) return { id, demo: null };
  const demo = votes[0];
  // Msalaba-kagua na kiambishi cha id (ikiwa kinatambulika).
  if (/^VRT/i.test(id) && demo === false) return { id, demo: null };
  if (/^(CR|MF|MLT|MX)\d/i.test(id) && demo === true) return { id, demo: null };
  return { id, demo };
}

function checkTokenShape(token) {
  const t = String(token ?? '').trim();
  if (t.length < 10 || t.length > 512 || /\s/.test(t) || !/^[\x21-\x7E]+$/.test(t)) {
    throw new DerivValidationError('Token haionekani sahihi. Nakili Personal Access Token kamili kutoka developers.deriv.com.', 'BAD_SHAPE');
  }
  return t;
}

/**
 * @param {string} token
 * @param {{ allowReal?: boolean }} [opts]
 * @returns {Promise<{ accountId: string, isDemo: boolean, currency: string|null, balance: number|null }>}
 */
async function validateToken(token, { allowReal = false } = {}) {
  const t = checkTokenShape(token);
  const appId = process.env.DERIV_APP_ID;
  if (!appId) throw new DerivValidationError('Huduma ya Deriv haijawekwa vizuri upande wa server (DERIV_APP_ID). Wasiliana na msimamizi.', 'NO_APP_ID');

  let data;
  try {
    const res = await axios.get(`${API_BASE}/trading/v1/options/accounts`, {
      headers: { Authorization: `Bearer ${t}`, 'Deriv-App-ID': appId },
      timeout: TIMEOUT_MS,
      validateStatus: () => true, // tunashughulikia status wenyewe — axios isitupe error yenye headers
      maxRedirects: 0,
    });
    if (res.status === 401 || res.status === 403) {
      throw new DerivValidationError('Deriv imekataa token hii (si sahihi, imekwisha muda, au haina ruhusa). Tengeneza mpya.', 'REJECTED');
    }
    if (res.status < 200 || res.status >= 300) {
      throw new DerivValidationError(`Deriv imejibu kwa hitilafu (${res.status}). Jaribu tena baadaye.`, 'UPSTREAM');
    }
    data = res.data;
  } catch (err) {
    if (err instanceof DerivValidationError) throw err;
    // Usitumie err.message/err.config — vinaweza kubeba headers (Authorization).
    throw new DerivValidationError('Imeshindwa kufikia Deriv sasa hivi. Jaribu tena baadaye.', 'NETWORK');
  }

  const list = data?.data ?? data?.accounts ?? [];
  if (!Array.isArray(list) || !list.length) {
    throw new DerivValidationError('Hakuna Options trading account kwenye token hii.', 'NO_ACCOUNTS');
  }

  const classified = list.map((a) => ({ raw: a, ...classify(a) })).filter((c) => c.id);
  const demo = classified.find((c) => c.demo === true);
  const real = classified.find((c) => c.demo === false);

  let chosen = demo;
  if (!chosen && allowReal) chosen = real;
  if (!chosen) {
    if (real) {
      throw new DerivValidationError('Token hii ni ya akaunti ya REAL. Kwa sasa DEMO tu inaruhusiwa — tumia token ya akaunti ya demo (VRT…).', 'REAL_NOT_ALLOWED');
    }
    throw new DerivValidationError('Siwezi kuthibitisha kwamba akaunti hii ni DEMO, kwa hiyo imekataliwa kwa usalama.', 'UNKNOWN_TYPE');
  }

  const bal = Number(chosen.raw?.balance);
  return {
    accountId: chosen.id,
    isDemo: chosen.demo === true,
    currency: chosen.raw?.currency ? String(chosen.raw.currency).toUpperCase() : null,
    balance: Number.isFinite(bal) ? bal : null,
  };
}

module.exports = { validateToken, classify, DerivValidationError };
