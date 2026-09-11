/**
 * Stockana — Fundamentals kutoka stockanalysis.com
 *
 * Inatumia:
 *   - axios kupata __data.json
 *   - devalue (npm package) kuchambua SvelteKit encoding
 *
 * Chanzo: /quote/dar/{SYM}/financials/ratios/__data.json
 *         /quote/dar/{SYM}/dividend/__data.json
 *
 * ⚠️ Inahitaji: "devalue": "^5.1.1" kwenye package.json
 * ⚠️ SI USHAURI WA UWEKEZAJI.
 */

const path = require('path');
const fs = require('fs');
const axios = require('axios');
const { unflatten } = require('devalue');

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
 * Chambua node moja ya __data.json kwa kutumia devalue unflatten.
 *
 * SvelteKit inatuma: { type: "data", data: [ ...devalue-encoded... ] }
 * devalue unflatten inarudisha object halisi.
 */
function unflattenNode(node) {
  if (!node || node.type !== 'data' || !Array.isArray(node.data)) return null;
  try {
    return unflatten(node.data);
  } catch (err) {
    console.warn('[stockana] unflatten error:', err.message);
    return null;
  }
}

/**
 * Chambua __data.json ya financials/ratios/.
 */
function parseRatios(json) {
  if (!json || !Array.isArray(json.nodes)) {
    console.log('[stockana] parseRatios: hakuna nodes');
    return null;
  }

  let financialData = null;
  let info = null;

  for (const node of json.nodes) {
    const flat = unflattenNode(node);
    if (!flat) continue;

    const arr = Array.isArray(flat) ? flat : [flat];
    for (const item of arr) {
      if (!item || typeof item !== 'object') continue;
      if (item.financialData && !financialData) financialData = item.financialData;
      if (item.symbol && item.name && !info) info = item;
    }
  }

  if (!financialData) {
    console.log('[stockana] parseRatios: financialData haipatikani');
    return null;
  }

  const fd = financialData;

  console.log('[stockana] financialData imepatikana, keys:', Object.keys(fd).slice(0, 15));

  const first = (arr) => {
    if (!Array.isArray(arr) || arr.length === 0) return null;
    const v = arr[0];
    return typeof v === 'number' ? v : null;
  };

  const price      = first(fd.lastCloseRatios);
  const pe         = first(fd.pe);
  const pb         = first(fd.pb);
  const roeRaw     = first(fd.roe);
  const divYield   = first(fd.dividendyield);
  const payoutRaw  = first(fd.payoutratio);
  const mcap       = first(fd.marketcap);

  const ttm = fd.ttmPrior || {};
  console.log('[stockana] ttmPrior keys:', Object.keys(ttm).slice(0, 15));
  console.log('[stockana] ttm.epsBasic:', ttm.epsBasic);
  console.log('[stockana] ttm.bvps:', ttm.bvps);

  const eps  = typeof ttm.epsBasic === 'number' ? ttm.epsBasic
             : typeof ttm.epsDil === 'number' ? ttm.epsDil
             : null;
  const bvps = typeof ttm.bvps === 'number' ? ttm.bvps
             : typeof ttm.tangibleBookValuePerShare === 'number' ? ttm.tangibleBookValuePerShare
             : null;

  const fiscalYears = fd.fiscalYear;
  const asOf = Array.isArray(fiscalYears) && fiscalYears.length
    ? String(fiscalYears[0])
    : null;

  const result = {
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

  console.log('[stockana] parseRatios result:', {
    eps: result.eps,
    bvps: result.bvps,
    roe: result.roe,
    pe: result.pe,
    pb: result.pb,
    divYield: result.divYield,
  });

  return result;
}

/**
 * Chambua __data.json ya /dividend/ kutoa DPS halisi.
 */
function parseDividend(json) {
  if (!json || !Array.isArray(json.nodes)) return null;

  for (const node of json.nodes) {
    const flat = unflattenNode(node);
    if (!flat) continue;
    const arr = Array.isArray(flat) ? flat : [flat];
    for (const item of arr) {
      if (!item || typeof item !== 'object') continue;
      const candidates = [
        item.annualDividend,
        item.dividendPerShare,
        item.dps,
        item.dividend,
      ];
      for (const c of candidates) {
        if (typeof c === 'number' && c > 0 && c < 100000) {
          console.log('[stockana] DPS imepatikana:', c);
          return c;
        }
      }
    }
  }

  // Fallback: tafuta kwenye string
  const text = JSON.stringify(json);
  const m = text.match(/"(?:annualDividend|dividendPerShare|dps)"\s*:\s*([\d.]+)/);
  if (m) {
    const v = parseFloat(m[1]);
    if (Number.isFinite(v) && v > 0 && v < 100000) {
      console.log('[stockana] DPS (fallback):', v);
      return v;
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

  const [r1, r2] = await Promise.allSettled([getJson(u.ratios), getJson(u.dividend)]);

  if (r1.status === 'fulfilled') {
    ratios = parseRatios(r1.value);
  } else {
    console.log('[stockana] ratios fetch error:', r1.reason?.message);
  }

  if (r2.status === 'fulfilled') {
    dividend = parseDividend(r2.value);
  } else {
    console.log('[stockana] dividend fetch error:', r2.reason?.message);
  }

  let data = null;

  if (ratios) {
    const checked = sanity(ratios);

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
