/* trade-export.js — Export ya Trading History (Excel .xlsx / PDF / CSV)
 * Inatumika na pocketoption.html na fxtrading.html.
 *
 * TradeExport.run(kind, opts)   kind = 'xlsx' | 'pdf' | 'csv'
 * opts = {
 *   title:    'Pocket Option — Trading History',
 *   filename: 'pocketoption-history',            // bila extension
 *   columns:  [{ key, label, num?:true }],        // num = nambari (Excel itaihesabu)
 *   rows:     [ { ... } ],                        // data (tayari imechujwa)
 *   pairKey:  'pair',                             // key ya jozi (kwa sheet ya "By Pair")
 *   resultKey:'result',                           // 'WIN' | 'LOSS' | 'OPEN'
 *   profitKey:'profit',                           // nambari
 *   stakeKey: 'stake',
 *   notes:    'Filter: ...'                       // maelezo ya hiari
 * }
 * Libraries (SheetJS, jsPDF) zinapakiwa tu pale unapobonyeza — hazipunguzi kasi ya ukurasa.
 * Zikishindwa kupakia (offline) → xlsx inaanguka kwenye CSV, pdf inaanguka kwenye print.
 */
(function () {
  const CDN = {
    xlsx: 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js',
    jspdf: 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
    autotable: 'https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.5.31/jspdf.plugin.autotable.min.js',
  };

  const loaded = {};
  function loadScript(url) {
    if (!loaded[url]) {
      loaded[url] = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = url;
        s.onload = resolve;
        s.onerror = () => { delete loaded[url]; reject(new Error('Imeshindwa kupakia ' + url)); };
        document.head.appendChild(s);
      });
    }
    return loaded[url];
  }

  const stamp = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Dar_es_Salaam' });
  const num = (v, d = 2) => Number(Number(v || 0).toFixed(d));

  // Muda wa Dar es Salaam kama maandishi yanayosomeka na yanayopangika (YYYY-MM-DD HH:mm:ss)
  function tz(ms) {
    if (!ms) return '';
    const d = new Date(Number(ms));
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleString('sv-SE', { timeZone: 'Africa/Dar_es_Salaam' });
  }

  function cellValue(col, row) {
    const v = row[col.key];
    if (v === null || v === undefined || v === '') return '';
    if (col.num) { const n = Number(v); return Number.isNaN(n) ? '' : n; }
    return v;
  }

  // Takwimu za jumla + kwa kila jozi (kwa uchambuzi)
  function analyse(o) {
    const rk = o.resultKey || 'result', pk = o.profitKey || 'profit', sk = o.stakeKey || 'stake', pairK = o.pairKey || 'pair';
    const mk = () => ({ trades: 0, wins: 0, losses: 0, open: 0, staked: 0, net: 0, best: null, worst: null });
    const add = (g, r) => {
      const res = r[rk], p = Number(r[pk]) || 0;
      g.trades++;
      if (res === 'WIN') g.wins++; else if (res === 'LOSS') g.losses++; else { g.open++; return; }
      g.staked += Number(r[sk]) || 0;
      g.net += p;
      g.best = g.best === null ? p : Math.max(g.best, p);
      g.worst = g.worst === null ? p : Math.min(g.worst, p);
    };
    const all = mk(); const by = {};
    o.rows.forEach((r) => { add(all, r); const k = r[pairK] || '—'; add(by[k] = by[k] || mk(), r); });
    const fin = (g) => {
      const d = g.wins + g.losses;
      return { ...g, winRate: d ? num((g.wins / d) * 100, 1) : null, net: num(g.net), staked: num(g.staked),
        avg: d ? num(g.net / d) : null, roi: g.staked ? num((g.net / g.staked) * 100, 1) : null,
        best: g.best === null ? null : num(g.best), worst: g.worst === null ? null : num(g.worst) };
    };
    return { all: fin(all), pairs: Object.keys(by).sort().map((k) => ({ pair: k, ...fin(by[k]) })) };
  }

  function summaryRows(o, a) {
    const g = a.all;
    return [
      ['Ripoti', o.title], ['Tarehe ya export', tz(Date.now()) + ' (Africa/Dar_es_Salaam)'],
      ...(o.notes ? [['Filter', o.notes]] : []), [],
      ['Trades zote', g.trades], ['Win', g.wins], ['Loss', g.losses], ['Wazi / haijulikani', g.open],
      ['Win rate %', g.winRate ?? ''], ['Jumla ya stake', g.staked], ['Net P/L', g.net],
      ['Wastani wa P/L kwa trade', g.avg ?? ''], ['ROI % (Net / Stake)', g.roi ?? ''],
      ['Trade bora', g.best ?? ''], ['Trade mbaya', g.worst ?? ''],
    ];
  }

  function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  // ── CSV ──────────────────────────────────────────────────────────────
  function toCsv(o) {
    const q = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
    const lines = [o.columns.map((c) => q(c.label)).join(',')];
    o.rows.forEach((r) => lines.push(o.columns.map((c) => q(cellValue(c, r))).join(',')));
    return '\ufeff' + lines.join('\r\n'); // BOM → Excel inasoma UTF-8 vizuri
  }
  function csv(o) {
    download(new Blob([toCsv(o)], { type: 'text/csv;charset=utf-8' }), `${o.filename}-${stamp()}.csv`);
    return 'csv';
  }

  // ── Excel (.xlsx): sheets 3 — Trades, Summary, By Pair ─────────────────
  async function xlsx(o) {
    try { await loadScript(CDN.xlsx); } catch (e) { csv(o); return 'csv'; }
    const X = window.XLSX;
    const a = analyse(o);

    const head = o.columns.map((c) => c.label);
    const body = o.rows.map((r) => o.columns.map((c) => cellValue(c, r)));
    const ws1 = X.utils.aoa_to_sheet([head, ...body]);
    ws1['!cols'] = o.columns.map((c) => ({ wch: Math.max(10, Math.min(24, c.label.length + 4)) }));
    ws1['!freeze'] = { xSplit: 0, ySplit: 1 };
    ws1['!autofilter'] = { ref: X.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(body.length, 1), c: head.length - 1 } }) };

    const ws2 = X.utils.aoa_to_sheet(summaryRows(o, a));
    ws2['!cols'] = [{ wch: 28 }, { wch: 40 }];

    const ph = ['Jozi', 'Trades', 'Win', 'Loss', 'Wazi', 'Win rate %', 'Stake', 'Net P/L', 'Wastani P/L', 'ROI %', 'Bora', 'Mbaya'];
    const pb = a.pairs.map((p) => [p.pair, p.trades, p.wins, p.losses, p.open, p.winRate ?? '', p.staked, p.net, p.avg ?? '', p.roi ?? '', p.best ?? '', p.worst ?? '']);
    const ws3 = X.utils.aoa_to_sheet([ph, ...pb]);
    ws3['!cols'] = ph.map(() => ({ wch: 12 }));

    const wb = X.utils.book_new();
    X.utils.book_append_sheet(wb, ws1, 'Trades');
    X.utils.book_append_sheet(wb, ws2, 'Summary');
    X.utils.book_append_sheet(wb, ws3, 'By Pair');
    X.writeFile(wb, `${o.filename}-${stamp()}.xlsx`);
    return 'xlsx';
  }

  // ── PDF: jsPDF + autotable; ikishindwa → dirisha la print (Save as PDF) ──
  async function pdf(o) {
    try {
      await loadScript(CDN.jspdf);
      await loadScript(CDN.autotable);
    } catch (e) { return printFallback(o); }
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });
    const a = analyse(o), g = a.all;
    const W = doc.internal.pageSize.getWidth();

    doc.setFontSize(15); doc.setFont(undefined, 'bold');
    doc.text(o.title, 36, 38);
    doc.setFontSize(9); doc.setFont(undefined, 'normal'); doc.setTextColor(110);
    doc.text(`Imetolewa: ${tz(Date.now())} (Dar es Salaam)${o.notes ? '  |  ' + o.notes : ''}`, 36, 54);
    doc.setTextColor(0);

    const sign = (n) => (n >= 0 ? '+' : '-') + '$' + Math.abs(n).toFixed(2);
    doc.autoTable({
      startY: 66, theme: 'grid', styles: { fontSize: 9, halign: 'center' },
      headStyles: { fillColor: [30, 41, 59] },
      head: [['Trades', 'Win', 'Loss', 'Win rate', 'Stake', 'Net P/L', 'Wastani/trade', 'ROI', 'Bora', 'Mbaya']],
      body: [[g.trades, g.wins, g.losses, g.winRate == null ? '-' : g.winRate + '%', '$' + g.staked.toFixed(2), sign(g.net),
        g.avg == null ? '-' : sign(g.avg), g.roi == null ? '-' : g.roi + '%', g.best == null ? '-' : sign(g.best), g.worst == null ? '-' : sign(g.worst)]],
    });

    if (a.pairs.length > 1) {
      doc.autoTable({
        startY: doc.lastAutoTable.finalY + 10, theme: 'striped', styles: { fontSize: 8 },
        headStyles: { fillColor: [51, 65, 85] },
        head: [['Jozi', 'Trades', 'Win', 'Loss', 'Win rate', 'Net P/L', 'ROI']],
        body: a.pairs.map((p) => [p.pair, p.trades, p.wins, p.losses, p.winRate == null ? '-' : p.winRate + '%', sign(p.net), p.roi == null ? '-' : p.roi + '%']),
        tableWidth: Math.min(420, W - 72),
      });
    }

    const resIdx = o.columns.findIndex((c) => c.key === (o.resultKey || 'result'));
    const plIdx = o.columns.findIndex((c) => c.key === (o.profitKey || 'profit'));
    doc.autoTable({
      startY: doc.lastAutoTable.finalY + 14, theme: 'striped', styles: { fontSize: 7.5, cellPadding: 3 },
      headStyles: { fillColor: [15, 23, 42] },
      head: [o.columns.map((c) => c.label)],
      body: o.rows.map((r) => o.columns.map((c) => { const v = cellValue(c, r); return v === '' ? '-' : v; })),
      didParseCell: (d) => {
        if (d.section !== 'body') return;
        if (d.column.index === resIdx) { const v = d.cell.raw; d.cell.styles.textColor = v === 'WIN' ? [22, 130, 70] : v === 'LOSS' ? [200, 40, 40] : [120, 120, 120]; }
        if (d.column.index === plIdx) { const n = Number(d.cell.raw); if (!Number.isNaN(n)) d.cell.styles.textColor = n >= 0 ? [22, 130, 70] : [200, 40, 40]; }
      },
      didDrawPage: () => {
        doc.setFontSize(8); doc.setTextColor(130);
        doc.text(`Ukurasa ${doc.internal.getNumberOfPages()}`, W - 36, doc.internal.pageSize.getHeight() - 16, { align: 'right' });
        doc.setTextColor(0);
      },
    });
    doc.save(`${o.filename}-${stamp()}.pdf`);
    return 'pdf';
  }

  function printFallback(o) {
    const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const a = analyse(o), g = a.all;
    const w = window.open('', '_blank');
    if (!w) throw new Error('Popup imezuiwa — ruhusu popups kisha jaribu tena (au tumia Excel).');
    w.document.write(`<!doctype html><meta charset="utf-8"><title>${esc(o.filename)}</title>
      <style>body{font:12px Arial;margin:18px}table{border-collapse:collapse;width:100%}th,td{border:1px solid #bbb;padding:3px 6px;text-align:left}th{background:#1e293b;color:#fff}h2{margin:0 0 4px}</style>
      <h2>${esc(o.title)}</h2><p>${esc(tz(Date.now()))} · Trades ${g.trades} · Win ${g.wins} · Loss ${g.losses} · Win rate ${g.winRate ?? '-'}% · Net ${g.net}</p>
      <table><thead><tr>${o.columns.map((c) => `<th>${esc(c.label)}</th>`).join('')}</tr></thead><tbody>${
        o.rows.map((r) => `<tr>${o.columns.map((c) => `<td>${esc(cellValue(c, r))}</td>`).join('')}</tr>`).join('')
      }</tbody></table><script>onload=()=>setTimeout(()=>print(),300)<\/script>`);
    w.document.close();
    return 'print';
  }

  async function run(kind, opts) {
    if (!opts.rows || !opts.rows.length) throw new Error('Hakuna trades za ku-export (angalia filter).');
    if (kind === 'xlsx') return xlsx(opts);
    if (kind === 'pdf') return pdf(opts);
    return csv(opts);
  }

  // ── Uchambuzi wa AI: HTML ya matokeo ya /analyze (pocketoption + fxtrading) ──
  function renderAnalysis(d) {
    const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const ai = d.ai || {}, st = d.stats || {};
    const box = 'border:1px solid rgba(128,128,128,.35);border-radius:8px;padding:10px 12px;margin:8px 0;';
    const good = 'border-left:4px solid #22c55e;', bad = 'border-left:4px solid #ef4444;', info = 'border-left:4px solid #3b82f6;', warn = 'border-left:4px solid #f59e0b;';
    const pairItem = (x, st_) => `<div style="${box}${st_}"><b>${esc(x.pair)}</b><div style="font-size:12px;opacity:.85;margin-top:2px;">${esc(x.reason)}</div></div>`;
    const pc = (v, suf = '%') => (v == null ? '—' : v + suf);
    const sgn = (v) => (v == null ? '—' : (v >= 0 ? '+' : '-') + '$' + Math.abs(v).toFixed(2));

    let h = `<div style="${box}${info}"><div style="font-size:11px;opacity:.7;">🧠 ${ai.source === 'ai' ? 'Groq AI' : 'Takwimu tu (bila AI)'} · trades ${st.sampleSize ?? 0}${d.cached ? ' · cache' : ''}</div>`;
    h += `<div style="margin-top:4px;line-height:1.45;">${esc(ai.summary || 'Hakuna muhtasari.')}</div></div>`;
    if (ai.note) h += `<div style="${box}${warn}font-size:12px;">ℹ️ ${esc(ai.note)}</div>`;
    (ai.warnings || []).forEach((w) => { h += `<div style="${box}${warn}font-size:12px;">⚠️ ${esc(w)}</div>`; });

    if ((ai.strongPairs || []).length) h += `<div style="font-weight:700;margin-top:10px;">💪 Jozi imara</div>` + ai.strongPairs.map((x) => pairItem(x, good)).join('');
    if ((ai.weakPairs || []).length) h += `<div style="font-weight:700;margin-top:10px;">⚠️ Jozi dhaifu</div>` + ai.weakPairs.map((x) => pairItem(x, bad)).join('');
    if (ai.bestStrength && ai.bestStrength.recommendation) {
      h += `<div style="font-weight:700;margin-top:10px;">🎯 Strength bora</div><div style="${box}${good}"><b>${esc(ai.bestStrength.recommendation)}</b><div style="font-size:12px;opacity:.85;margin-top:2px;">${esc(ai.bestStrength.reason)}</div></div>`;
    }
    if ((ai.recommendations || []).length) h += `<div style="font-weight:700;margin-top:10px;">✅ Mapendekezo</div><ul style="margin:4px 0 0 18px;padding:0;font-size:13px;line-height:1.5;">${ai.recommendations.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>`;

    const tbl = (title, head, rows) => rows.length
      ? `<div style="font-weight:700;margin-top:12px;">${title}</div><div style="overflow-x:auto;"><table style="width:100%;border-collapse:collapse;font-size:12px;margin-top:4px;"><thead><tr>${head.map((x) => `<th style="text-align:left;padding:4px 6px;border-bottom:1px solid rgba(128,128,128,.4);white-space:nowrap;">${x}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td style="padding:4px 6px;border-bottom:1px solid rgba(128,128,128,.2);white-space:nowrap;">${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : '';
    const row = (g) => [`<b>${esc(g.label)}</b>`, g.n + (g.confidence !== 'ok' ? ' ⚠️' : ''), pc(g.winRate), pc(g.winRateLow95), pc(g.roiPct), sgn(g.net)];
    const H = ['', 'Trades', 'Win%', 'Win% (chini 95%)', 'ROI', 'Net'];
    h += tbl('📊 Jozi (zimepangwa kwa ubora)', ['Jozi', ...H.slice(1)], (st.pairs || []).map(row));
    if (st.strength && st.strength.thresholds) {
      h += tbl('🎚️ Ukitumia strength ≥ X tu', ['Kizingiti', ...H.slice(1)], st.strength.thresholds.map(row));
      h += tbl('🧱 Kwa kundi la strength', ['Kundi', ...H.slice(1)], st.strength.buckets.map(row));
    }
    if (st.signalTracker && st.signalTracker.strength && st.signalTracker.strength.length) {
      h += tbl('📡 Strength ya signals (siku 30)', ['Kundi', 'Signals', 'Win%'], st.signalTracker.strength.map((g) => [`<b>${esc(g.label)}</b>`, g.n, pc(g.winRatePct)]));
    }
    if (st.expiry && st.expiry.length) h += tbl('⏱️ Expiry', ['Expiry', ...H.slice(1)], st.expiry.map(row));
    h += `<div style="font-size:11px;opacity:.65;margin-top:10px;">⚠️ Takwimu zinaonyesha yaliyopita, si ahadi ya siku zijazo. ⚠️ = sampuli ndogo. Si ushauri wa kifedha.</div>`;
    return h;
  }

  window.TradeExport = { run, tz, renderAnalysis };
})();
