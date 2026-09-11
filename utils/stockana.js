/**
 * stockana.js — Fundamentals za hisa za DSE kutoka stockanalysis.com
 *
 * stockanalysis.com HUFUATILIA Dar es Salaam Stock Exchange chini ya
 * exchange code "dar" (mfano: https://stockanalysis.com/quote/dar/CRDB/).
 * Ukurasa wa "/statistics/" ndio wenye vigezo tunavyohitaji kwa nafasi
 * moja: EPS, Book Value Per Share, Dividend Per Share, ROE, P/E, P/B,
 * Market Cap, Shares Outstanding — hivi ndivyo vilivyokuwa vikinakiliwa
 * kwa mkono kwenye utils/data/fundamentals.json.
 *
 * ⚠️ MUHIMU: stockanalysis.com haitoi BEI ya moja kwa moja (live) kwa
 * hisa za DSE — inaonyesha "Price not available due to exchange
 * restrictions" kwa sababu ya vizuizi vya soko. Kwa hiyo bei ya SASA
 * bado inatoka dse.js (HTML ya dse.co.tz), si hapa. Faili hili linatoa
 * fundamentals PEKEE.
 *
 * Cache: siku 7 (data hizi hazibadiliki mara kwa mara — zinasasishwa
 * baada ya ripoti ya kifedha).
 */

const axios = require('axios');
const cheerio = require('cheerio');

const CACHE_MS = 7 * 24 * 60 * 60 * 1000; // siku 7
const cache = new Map(); // SYMBOL -> { data, at }

const EXCHANGE = 'dar'; // Dar es Salaam Stock Exchange kwenye stockanalysis.com

// Hubadilisha "1.96T" / "293.46" / "3.35%" / "(1,234.56)" kuwa namba halisi.
function parseNumber(raw) {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s || /^n\/a$/i.test(s) || s === '-' || s === '—' || s === '') return null;

  s = s.replace(/,/g, '');

  let sign = 1;
  if (s.startsWith('(') && s.endsWith(')')) {
    sign = -1;
    s = s.slice(1, -1);
  } else if (s.startsWith('-')) {
    sign = -1;
    s = s.slice(1);
  }

  const pct = s.match(/^([\d.]+)\s*%$/);
  if (pct) return sign * parseFloat(pct[1]);

  const withMult = s.match(/^([\d.]+)\s*([TBMK])$/i);
  if (withMult) {
    const mult = { T: 1e12, B: 1e9, M: 1e6, K: 1e3 }[withMult[2].toUpperCase()];
    return sign * parseFloat(withMult[1]) * mult;
  }

  const plain = parseFloat(s);
  return Number.isNaN(plain) ? null : sign * plain;
}

// Jedwali za ukurasa wa /statistics/ ni jozi za "Label | Value" — hakuna
// haja ya class/id maalum, tunachukua tu safu za jedwali lolote.
function extractStatsMap($) {
  const map = {};
  $('table').each((_, table) => {
    $(table)
      .find('tr')
      .each((__, tr) => {
        const cells = $(tr).find('td, th');
        if (cells.length < 2) return;
        const label = $(cells[0]).text().trim();
        const value = $(cells[1]).text().trim();
        if (label && !(label in map)) map[label] = value;
      });
  });
  return map;
}

function extractCompanyName($) {
  const h1 = $('h1').first().text().trim();
  const m = h1.match(/^(.*?)\s*\([A-Z]+:[A-Z0-9.]+\)\s*$/);
  return (m ? m[1] : h1).trim() || null;
}

async function fetchStockanaRaw(symbol) {
  const url = `https://stockanalysis.com/quote/${EXCHANGE}/${symbol}/statistics/`;

  const res = await axios.get(url, {
    timeout: 15000,
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
    validateStatus: (s) => s < 500, // tunataka kushughulikia 404 wenyewe
  });

  if (res.status !== 200) return null; // symbol haipo kwenye stockanalysis.com/dar

  const $ = cheerio.load(res.data);
  const stats = extractStatsMap($);
  const name = extractCompanyName($);

  const eps = parseNumber(stats['Earnings Per Share (EPS)']);
  const bvps = parseNumber(stats['Book Value Per Share']);
  const dps = parseNumber(stats['Dividend Per Share']);
  const roe = parseNumber(stats['Return on Equity (ROE)']);
  const pe = parseNumber(stats['PE Ratio']);
  const pb = parseNumber(stats['PB Ratio']);
  const divYield = parseNumber(stats['Dividend Yield']);
  const marketcap = parseNumber(stats['Market Cap']);
  const sharesOutstanding = parseNumber(
    stats['Shares Outstanding'] || stats['Current Share Class']
  );

  // Kama hatukupata hata kigezo kimoja cha msingi, symbol pengine haipo
  // (au ukurasa umebadilika muundo) — usirudishe kitu bandia.
  if (eps == null && bvps == null && marketcap == null) return null;

  return {
    symbol,
    name,
    eps,
    bvps,
    dps,
    roe,
    pe,
    pb,
    divYield,
    marketcap,
    sharesOutstanding,
    asOf: 'TTM',
    source: 'stockanalysis.com',
  };
}

async function fetchStockana(symbol) {
  const key = String(symbol).toUpperCase();
  const cached = cache.get(key);

  if (cached && Date.now() - cached.at < CACHE_MS) {
    return cached.data;
  }

  try {
    const data = await fetchStockanaRaw(key);
    cache.set(key, { data, at: Date.now() });
    return data;
  } catch (err) {
    console.warn('stockana: fetch error kwa', key, '-', err.message);
    // Tumia cache ya zamani (hata ikiwa imepitwa na muda wa siku 7)
    // kuliko kutorudisha kitu kabisa.
    if (cached) return cached.data;
    return null;
  }
}

module.exports = { fetchStockana };
