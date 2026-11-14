const Module = require('module');
const root = process.argv[2];
let page = '';
const orig = Module._load;
Module._load = function (req, ...a) {
  if (req === 'axios') return { get: async (url) => { if (/forexfactory/.test(url)) return { data: page }; throw new Error('feed down'); } };
  return orig.call(this, req, ...a);
};
const assert = require('assert');
const state = { days: [{ events: [
  { id: 111, name: 'CPI y/y', currency: 'AUD', dateline: 1763000000, impactName: 'high', actual: '0.7%', forecast: '0.8%', previous: '0.9%' },
  { id: 112, name: 'Sentix Investor Confidence', currency: 'EUR', dateline: 1763005000, impactName: 'medium', actual: '2.4', forecast: '2.1', previous: '2.7' },
  { id: 113, name: 'Future Event', currency: 'USD', dateline: 1999999999, impactName: 'low', actual: '', forecast: '1', previous: '2' },
] }] };
page = `<html><script>window.calendarComponentStates[1] = ${JSON.stringify(state)};\nfoo()</script></html>`;
(async () => {
  const ap = require(root + '/utils/actualsProvider.js');
  const parsed = ap.parseFfPage(page);
  assert.strictEqual(parsed.length, 3); assert.strictEqual(parsed[0].actual, '0.7%'); assert.strictEqual(parsed[2].actual, null);
  const feed = [{ title: 'CPI y/y', country: 'AUD', date: new Date(1763000000000).toISOString(), impact: 'High', forecast: '0.8%', previous: '0.9%' }];
  const m = ap.mergeActuals(feed, parsed);
  assert.strictEqual(m[0].actual, '0.7%'); assert.strictEqual(m[0].ffId, '111'); assert.ok(!feed[0].actual, 'feed haibadilishwi');
  // mtiririko kamili: feed ya faireconomy imeshindwa → FF inakuwa chanzo kikuu
  const ec = require(root + '/utils/economicCalendar.js');
  const v = await ec.getWeekView(['AUD', 'EUR', 'USD']);
  assert.ok(v.available); assert.strictEqual(v.events.find((e) => e.title === 'CPI y/y').actual, '0.7%');
  assert.strictEqual(v.events.find((e) => e.title === 'CPI y/y').ffId, '111');
  console.log('OK — parse, merge, fallback zote zimepita; events:', v.events.length);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
