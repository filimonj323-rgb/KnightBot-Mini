# Deriv kwa kila mteja — Hatua (a) (DEMO tu)

## Lazima kabla ya kuwasha
1. Tengeneza ufunguo wa usimbaji na uuweke KWENYE RAILWAY ENV PEKEE:
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   Jina la env: TOKENVAULT_KEY
   - USIITE DERIV_* / AUTO_TRADE_* — pairing/envSync.js huhifadhi env hizo ndani ya Turso, na ufunguo ungehifadhiwa pamoja na token zenyewe.
   - Hifadhi nakala mahali salama. Ukipotea, wateja wote wataweka token zao upya.
2. DERIV_APP_ID lazima iwepo (ile ile ya sasa).
3. Anza server — jedwali deriv_accounts + column fx_auto_trades.ownerPhone vinaundwa kiotomatiki (data zilizopo hazibadiliki).

## Mtiririko
Mteja: dashboard → 📈 Deriv → weka PIN → weka token ya demo → (admin anaidhinisha) → anawasha Trading.
Admin: admin.html → mteja → "Akaunti ya Deriv ya Mteja": idhinisha, auto, vikomo, reset PIN (+DM). Juu: kill switch ya wote.
Reset PIN: mfumo unatengeneza PIN ya muda ya tarakimu 6 (haihifadhiwi wazi); mteja analazimika kuibadilisha. PIN ya zamani HAIWEZI kurudishwa (ni hash).

## Bado haifanyi (hatua zinazofuata)
Commands (.fxbuy/.positions n.k.) bado zimefungwa kwa pairing bots; hakuna trade inayofunguliwa kutoka akaunti ya mteja bado. canTrade()/getTokenForTrading() ndiyo lango la hatua (b)-(d).
Swichi ya Auto-Trade inahifadhi chaguo tu hadi injini ya per-user (hatua d).

## Majaribio
node tests/deriv-step-a/unit.js <njia-ya-mradi>   (58)
node tests/deriv-step-a/routes.js <njia-ya-mradi> (24)
Yanahitaji Node 22 (node:sqlite). axios inabadilishwa na shim ndogo ya majaribio.
