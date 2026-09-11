/**
 * Stockana — Fundamentals kutoka stockanalysis.com
 *
 * Chanzo: SvelteKit __data.json endpoints (bila HTML, bila Cloudflare):
 *   - /quote/dar/{SYM}/financials/ratios/__data.json  → EPS, BVPS, ROE, P/E, P/B, DivYield
 *   - /quote/dar/{SYM}/dividend/__data.json           → DPS halisi
 *
 * ⚠️ MUHIMU:
 *  - __data.json HAIPO nyuma ya Cloudflare (endpoint ya data).
 *  - Ina-cache kwa siku 7 (fundamentals hazibadiliki kila siku).
 *  - Fallback: fundamentals.json (manual) kama __data.json inashindwa.
 *
 * ⚠️ SI USHAURI WA UWEKEZAJI.
 */

const path = require('path');
const fs = require('fs');
const axios = require('axios');

const CACHE_FILE = path.join(__dirname, '..', 'data', 'stockana.cache.json');
const CACHE_MS = 7 * 24 * 60 * 60 * 1000; // siku 7

const BASE = 'https://stockanalysis.com/quote/dar';

function urlsFor(symbol) {
  const s = String(symbol).toUpperCase();
  const q = '?x-sveltekit-trailing-slash=1';
  return {
    ratios:   `${BASE}/${s}/financials/ratios/__data.json${q}`,
    dividend: `${BASE}/${s}/dividend/__data.json${q}`,
  };
}

function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  } catch (_) {}
  return {};
}

function saveCache(cache) {
  try {
    const dir = path.dirname(CACHE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
  } catch (_) {}
}

async function getJson(url) {
  const { data } = await axios.get(url, {
    timeout: 20000,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/120.0 Safari/537.36',
      Accept: 'application/json,text/plain,*/*',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });
  return data;
}

/**
 * Resolve devalue index -> thamani halisi.
 * SvelteKit inatumia arrays: thamani ziko kwenye array kubwa, na indices
 * ndogo zinaelekeza kwenye nafasi.
 */
function makeResolver(pool) {
  return function resolve(ref, depth = 0) {
    if (depth > 5) return null;
    if (ref == null) return null;
    if (typeof ref === 'number') {
      const v = pool[ref];
      if (typeof v === 'number' || typeof v === 'string' || v === null) return v;
      return resolve(v, depth + 1);
    }
    return ref;
  };
}

/**
 * Chambua __data.json ya financials/ratios/.
 * Inarudisha { eps, bvps, roe, pe, pb, divYield, marketcap, asOf }.
 */
function parseRatios(json) {
  if (!json || !Array.isArray(json.nodes)) return null;

  let financialData = null;
  let info = null;
  let pool = null;

  for (const node of json.nodes) {
    if (!node || node.type !== 'data' || !Array.isArray(node.data)) continue;
    const first = node.data[0];
    if (!first || typeof first !== 'object') continue;

    if (first.financialData && !financialData) financialData = first.financialData;
    if (first.symbol && first.name && !info) info = first;
    if (Array.isArray(first) && first.length > pool?.length) pool = first;
  }

  // pool = array kubwa ya values (devalue root). Tafuta kwenye node.data.
  if (!pool) {
    for (const node of json.nodes) {
      if (!node || node.type !== 'data') continue;
      // devalue inaweka values kwenye node.data yenyewe kama array
      if (Array.isArray(node.data) && node.data.length > 50) {
        pool = node.data;
        break;
      }
    }
  }

  // Kama bado hakuna pool, tumia json.nodes[2].data kama fallback
  if (!pool && json.nodes[2]?.data) pool = json.nodes[2].data;

  const resolve = makeResolver(pool || []);

  if (!financialData) return null;

  const at = (arr) => (Array.isArray(arr) ? resolve(arr[0]) : null);

  const price     = at(financialData.lastCloseRatios);
  const pe        = at(financialData.pe);
  const pb        = at(financialData.pb);
  const roeRaw    = at(financialData.roe);
  const divYield  = at(financialData.dividendyield);
  const payoutRaw = at(financialData.payoutratio);
  const mcap      = at(financialData.marketcap);

  const ttm = financialData.ttmPrior || {};
  const eps  = resolve(ttm.epsBasic) ?? resolve(ttm.epsDil) ?? null;
  const bvps = resolve(ttm.bvps) ?? resolve(ttm.tangibleBookValuePerShare) ?? null;

  const fiscalYears = financialData.fiscalYear;
  const asOf = Array.isArray(fiscalYears) && fiscalYears.length
    ? String(resolve(fiscalYears[0]) ?? '')
    : null;

  return {
    symbol: (info?.symbol || '').toUpperCase() || null,
    name: info?.name || info?.nameFull || null,
    price: typeof price === 'number' ? price : null,
    eps: typeof eps === 'number' ? eps : null,
    bvps: typeof bvps === 'number' ? bvps : null,
    roe: typeof roeRaw === 'number' ? roeRaw * 100 : null,
    pe: typeof pe === 'number' ? pe : null,
    pb: typeof pb === 'number' ? pb : null,
    divYield: typeof divYield === 'number' ? divYield * 100 : null,
    payoutRatio: typeof payoutRaw === 'number' ? payoutRaw * 100 : null,
    marketcap: typeof mcap === 'number' ? mcap : null,
    asOf: asOf || null,
  };
}

/**
 * Chambua __data.json ya /dividend/ — kutoa DPS halisi.
 * Muundo unatofautiana, tunatafuta "annualDividend" au "dividendPerShare".
 */
function parseDividend(json) {
  if (!json) return null;
  const text = JSON.stringify(json);

  // Tafuta fields zinazowezekana
  const patterns = [
    /"annualDividend"\s*:\s*([\d.]+)/i,
    /"dividendPerShare"\s*:\s*([\d.]+)/i,
    /"dps"\s*:\s*([\d.]+)/i,
    /"dividend"\s*:\s*([\d.]+)/i,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) {
      const v = parseFloat(m[1]);
      if (Number.isFinite(v) && v > 0 && v < 100000) return v;
    }
  }
  return null;
}

function sanity(v) {
  const out = {
    eps: null, bvps: null, dps: null, roe: null,
    pe: null, pb: null, divYield: null, marketcap: null, asOf: v.asOf || null,
    price: v.price ?? null, name: v.name ?? null,
  };
  if (v.eps != null && v.eps > -100000 && v.eps < 100000) out.eps = v.eps;
  if (v.bvps != null && v.bvps > 0 && v.bvps < 10000000) out.bvps = v.bvps;
  if (v.dps != null && v.dps >= 0 && v.dps < 100000) out.dps = v.dps;
  if (v.roe != null && v.roe > -100 && v.roe < 100) out.roe = v.roe;
  if (v.pe != null && v.pe > 0 && v.pe < 1000) out.pe = v.pe;
  if (v.pb != null && v.pb > 0 && v.pb < 1000) out.pb = v.pb;
  if (v.divYield != null && v.divYield >= 0 && v.divYield < 100) out.divYield = v.divYield;
  if (v.marketcap != null && v.marketcap > 0) out.marketcap = v.marketcap;
  return out;
}

/**
 * Kazi kuu: chukua fundamentals kwa symbol.
 */
async function fetchStockana(symbol) {
  symbol = String(symbol).toUpperCase();
  const cache = loadCache();
  const entry = cache[symbol];

  if (entry && entry.fetchedAt && Date.now() - entry.fetchedAt < CACHE_MS) {
    return { ...entry.data, source: entry.data.source || 'cache' };
  }

  const u = urlsFor(symbol);
  let ratios = null;
  let dividend = null;

  try {
    const [r1, r2] = await Promise.allSettled([getJson(u.ratios), getJson(u.dividend)]);
    if (r1.status === 'fulfilled') ratios = parseRatios(r1.value);
    if (r2.status === 'fulfilled') dividend = parseDividend(r2.value);
  } catch (err) {
    console.warn('stockana: fetch error', err.message);
  }

  let data = null;

  if (ratios) {
    const checked = sanity(ratios);
    // DPS: chukua kutoka dividend, la sivyo hesabu kutoka yield × price
    let dps = dividend;
    if (dps == null && checked.divYield != null && checked.price != null) {
      dps = (checked.divYield / 100) * checked.price;
    }
    checked.dps = dps;
    checked.source = 'stockanalysis.com';
    checked.confidence = 'scraped';
    data = checked;
  }

  // Fallback: fundamentals.json (manual)
  if (!data) {
    try {
      const manual = require('./data/fundamentals.json');
      const fx = manual[symbol];
      if (fx) {
        data = {
          eps: fx.eps ?? null, bvps: fx.bvps ?? null, dps: fx.dps ?? null, roe: fx.roe ?? null,
          asOf: fx.asOf ?? null, source: 'manual (fundamentals.json)', confidence: 'manual',
        };
      }
    } catch (_) {}
  }

  if (!data) return null;

  cache[symbol] = { data, fetchedAt: Date.now() };
  saveCache(cache);
  return data;
}

module.exports = { fetchStockana, urlsFor, parseRatios, parseDividend };
