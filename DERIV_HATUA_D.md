# Deriv kwa kila mteja — Hatua (d): Auto-trade ya kila mteja (DEMO tu)

Zip hii ina faili ZOTE zilizobadilika tangu hatua (a)+(c). Zinabadilisha faili zilizopo; `utils/derivCustomerAuto.js` ni mpya.

## Inavyofanya kazi
- Kila mteja anatrade kwenye akaunti yake MWENYEWE (token yake, session yake, rekodi zake kwa `ownerPhone`). Hakuna mteja anayeathiri mwingine.
- Kitu pekee kinachoshirikiwa ni SIGNAL ya soko (haina data ya mtu): inahesabiwa MARA MOJA kila mzunguko, kisha kila mteja anaipitisha kwenye vizuizi vyake.
- Mteja anaingia kwenye mzunguko TU kama: admin amemwidhinisha (approve) + admin ameidhinisha auto (approve_auto) + mteja amewasha swichi ya Trading na Auto-Trade.
- Kila trade inapita `derivCustomerTrader.openTrade(phone, params, { auto: true })` — lango lilelile la trade za mkono (mutex ya mteja, SL+TP lazima, reconcile na Deriv, vikomo, fail-closed). Tofauti pekee: lango linadai pia autoApproved + autoEnabled.
- Mkakati: signal ya owner (strength >= AUTO_TRADE_STRENGTH_THRESHOLD, habari kubwa = ruka, regime filter ileile) + SL/TP kwa ATR (formula ileile ya owner). Stake = `DERIV_AUTO_STAKE_USD` (default 2) ikipunguzwa hadi maxStake ya mteja.
- Ulinzi wa ziada kwa kila mteja: correlation guard (kwa positions halisi za Deriv ya mteja huyo), cooldown (hasara 3 mfululizo za auto → pumzika saa 4, inahesabiwa kutoka DB kwa hiyo inadumu redeploy), na vikomo vya admin (trades wazi, trades/siku, hasara/siku).
- Arifa: WhatsApp self-chat ya mteja husika — trade ikifunguliwa na ikifungwa (FAIDA/HASARA). Kila kufungwa kunaarifiwa mara moja tu.

## Udhibiti wa admin (haujabadilika)
approve / revoke / approve_auto / revoke_auto / set_limits / kill_all / resume_all zinatumika moja kwa moja — zinakaguliwa KILA trade. `GET /api/admin/deriv` sasa pia inarudisha `autoEngine` (hali ya injini; wateja wanaonekana kwa tarakimu 4 za mwisho tu).

## Faili
- NEW `utils/derivCustomerAuto.js` — injini (mzunguko, poll ya kufungwa, arifa, getStatus).
- `utils/derivCustomerTrader.js` — `openTrade(phone, params, {auto, signalStrength})`, tukio `auto-closed`, `syncClosed(phone)`.
- `utils/derivTrades.js` — `reservePending` inaweka `signalStrength` (alama ya trade ya auto; za mkono = NULL), `recentAuto`, `phonesWithOpenAuto`, `openRows` inarudisha signalStrength.
- `utils/derivAccounts.js` — `listAutoReady()`.
- `utils/autoTrader.js` — export ya `checkRegimeFilter` tu (tabia ya owner haibadiliki).
- `pairing/server.js` — inaanzisha injini baada ya `restoreAllInstances()`; admin GET inaonyesha `autoEngine`.
- `pairing/public/dashboard.html` — tabs za Deriv (Akaunti / Auto-Trader / Trades / Fungua / History) + maelezo ya swichi ya Auto-Trade.
- `tests/deriv/d-auto.js` — majaribio 25.

## Env (zote hiari)
DERIV_CUSTOMER_AUTO_ENABLED (default true; "false" inazima injini yote) • DERIV_AUTO_CHECK_INTERVAL_MS • DERIV_AUTO_POLL_MS (default dk 3) • DERIV_AUTO_STAKE_USD • DERIV_AUTO_MULTIPLIER • DERIV_AUTO_MAX_CONSECUTIVE_LOSSES • DERIV_AUTO_COOLDOWN_MS • DERIV_AUTO_MAX_CURRENCY_EXPOSURE • DERIV_AUTO_PAIR_STAGGER_MS

## Bado (hatua zinazofuata)
- Trailing stop / breakeven kwa wateja (kwa sasa trades zao zinalindwa na SL/TP za Deriv pekee).
- (e) historia/ripoti kwa admin kwenye UI ya admin, na stake ya auto inayoweza kuwekwa na mteja mwenyewe.
- Mzunguko wa kwanza unaanza sekunde 45 baada ya server kuwaka, kisha kila saa (sawa na owner).

## Majaribio (Node 22) — tumia njia KAMILI ya mzizi
node tests/deriv/a-unit.js "$(pwd)" (58) • a-routes.js (24) • c-trade.js (54) • d-auto.js (25)
Deriv halisi, ws na axios hazijajaribiwa (zinabadilishwa na shim/injini bandia); signal na regime ni mocks.
