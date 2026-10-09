# Deriv kwa kila mteja — Hatua (a) + (c) (DEMO tu)

Zip hii ina faili ZOTE zilizobadilika tangu zip yako ya awali (hatua a + c). Inabadilisha faili zilizopo — hakuna pairingConfig.js ndani.

## Lazima kabla ya kuwasha (kama hatua a)
- Env ya Railway: TOKENVAULT_KEY (hex 64) — USIITE DERIV_*; hifadhi nakala. DERIV_APP_ID lazima iwepo.
- Schema inajitengeneza: jedwali deriv_accounts + fx_auto_trades.ownerPhone (data za owner hazibadiliki).

## Mpya kwenye hatua (c)
- utils/derivSession.js: muunganisho wa Deriv wa KILA mteja (OTP → WebSocket), heartbeat, reconnect, idle close, kikomo DERIV_MAX_SESSIONS (default 20).
- utils/derivCustomerTrader.js: LANGO LA PEKEE la kufungua/kufunga trade ya mteja. Kufungua kunapita: idhini (admin+mteja+kill switch), jozi kwenye orodha, stake <= kikomo (inakataa, haipunguzi), SL+TP lazima, trades wazi < maxOpen, trades za leo < maxTradesDay, hasara ya leo + SL <= maxDailyLoss, hakuna trade wazi ya jozi hiyo, hakuna marudio ya sekunde 8, mutex kwa kila mteja, DB/Deriv ikishindwa = haifunguki.
  Kufunga/kuona: kunafanya kazi hata trading ikiwa imezimwa au kill switch imewashwa (kupunguza hatari).
  Siku = UTC (inabadilika saa 03:00 EAT).
- utils/derivTrades.js: rekodi za wateja kwenye fx_auto_trades (ownerPhone = namba ya mteja).
- utils/autoTrader.js: query 3 za SELECT sasa zinachuja `ownerPhone IS NULL` — trades za wateja hazingii kwenye ufuatiliaji/stats za owner. (Tabia ya owner haibadiliki.)
- Commands kwenye pairing bot (mteja pekee): .fxbuy .fxsell .positions .panic .fxclose (mpya). Global owner hawezi kuzitumia kwenye bot ya mteja. Bot kuu inaendelea kama zamani (akaunti ya owner).
- handler.js: lango linatumia forexAccess.decide(); ngazi mpya ACCOUNT_OWN.
- Dashboard ya mteja: kadi ya "Trade (DEMO)": balance, positions, funga, fungua (PIN kila mara). API: GET /deriv/overview, POST /deriv/trade|close|closeall.

## Bado (hatua zinazofuata)
- (d) auto-trade ya kila mteja (swichi ipo, injini bado). (e) historia/ripoti kwa admin.
- Commands za owner-only bado hazijagusa: fxautostake, fxtrailing, fxautostatus, autostats, fxcheck, fxbacktest zimefungwa kwa pairing bots.
- ⚠️ Bot kuu: fxbuy/fxsell/positions/panic HAZINA ownerOnly (haijabadilishwa — subiri uamuzi wako).

## Majaribio (Node 22)
node tests/deriv/a-unit.js <njia>   (58)   node tests/deriv/a-routes.js <njia> (24)   node tests/deriv/c-trade.js <njia> (54)
ws na axios zinabadilishwa na shim za majaribio (npm inazuia kusakinisha hapa) — muunganisho halisi wa Deriv HAUJAJARIBIWA.
