"""
pocket_bridge/app.py

Bridge ndogo ya HTTP (Flask) inayounganisha na Pocket Option kupitia
maktaba ya pocketoptionapi_async (ChipaDevTeam) — nyaraka rasmi:
https://chipadevteam.github.io/PocketOptionAPI/

Hii inaruhusu bot ya Node.js (utils/pocketOptionTrader.js) kuongea na
Pocket Option kupitia HTTP rahisi, badala ya kuandika upya WebSocket
protocol yenyewe kwa JavaScript.

Endesha: python3 app.py  (baada ya kuweka POCKET_OPTION_SSID kwenye .env)
Default port: 5055 (badilisha na POCKET_BRIDGE_PORT ukitaka)
"""

import os
import re
import sys
import json
import random
import traceback
import asyncio
import threading
import time
import enum
import dataclasses
import datetime as _dt
import decimal
from flask import Flask, request, jsonify
from dotenv import load_dotenv
from pocketoptionapi_async import AsyncPocketOptionClient, OrderDirection

load_dotenv()

# Bridge inaendeshwa kama child process (stdout ni pipe) — bila hii, print() zinakusanywa
# kwenye buffer na kufika kwenye logi za Railway kwa makundi dakika kadhaa baadaye.
try:
    sys.stdout.reconfigure(line_buffering=True)
except Exception:
    pass

def _normalize_ssid(raw):
    """Ondoa nafasi/newline na nukuu za ziada ambazo mara nyingi huingia
    wakati wa kubandika variable kwenye Railway."""
    v = (raw or "").strip()
    if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
        v = v[1:-1].strip()
    return v.replace("\\\"", "\"")


def _truthy(v):
    return str(v).strip().lower() in ("1", "true", "yes", "on")


SSID = _normalize_ssid(os.environ.get("POCKET_OPTION_SSID", ""))

# isDemo ndani ya SSID ndiyo ya kuaminika — env POCKET_OPTION_DEMO inatumika
# tu kama SSID haina isDemo. (Zamani "1" kwenye env ilisomwa kama false.)
_m = re.search(r'"isDemo"\s*:\s*(\d|true|false)', SSID, re.I)
_ssid_demo = None if not _m else _truthy(_m.group(1))
_env_demo = os.environ.get("POCKET_OPTION_DEMO")
if _ssid_demo is not None:
    IS_DEMO = _ssid_demo
    if _env_demo is not None and _truthy(_env_demo) != _ssid_demo:
        print(f"⚠️  POCKET_OPTION_DEMO={_env_demo!r} hailingani na isDemo ndani ya SSID — natumia ya SSID (demo={IS_DEMO}).")
else:
    IS_DEMO = _truthy(_env_demo) if _env_demo is not None else True


def _ssid_summary():
    """Muhtasari salama (bila kufichua session) kwa logs."""
    if not SSID:
        return "SSID: HAIPO"
    sess = re.search(r'"session"\s*:\s*"([^"]*)"', SSID)
    uid = re.search(r'"uid"\s*:\s*(\d+)', SSID)
    return (f"SSID: urefu={len(SSID)}, inaanza={SSID[:11]!r}, inaishia={SSID[-2:]!r}, "
            f"session_len={len(sess.group(1)) if sess else 'HAIPO'}, uid={uid.group(1) if uid else 'HAIPO'}, "
            f"isDemo={_ssid_demo}")


print(f"ℹ️  [pocket_bridge] {_ssid_summary()} | demo inayotumika={IS_DEMO}")

# Port ni constant (si env) — inalingana na BRIDGE_URL iliyowekwa moja kwa
# moja (hardcoded) kwenye utils/pocketOptionTrader.js upande wa Node.
PORT = 5055
BRIDGE_SECRET = os.environ.get("POCKET_BRIDGE_SECRET", "badilisha_hii_iwe_secret_ndefu")

if not SSID:
    print("⚠️  POCKET_OPTION_SSID haijawekwa kwenye .env — bridge haitaweza connect.")

import logging
logging.getLogger("werkzeug").setLevel(logging.ERROR)

# pocketoptionapi_async inatumia loguru na inachapisha DEBUG kwa kila tick ya bei
# (maelfu ya mistari kwa dakika). Weka INFO kupunguza kelele kwenye logs.
# Ukihitaji debug: weka env POCKET_LOG_LEVEL=DEBUG.
try:
    import sys
    from loguru import logger as _loguru
    _loguru.remove()
    _loguru.add(sys.stderr, level=os.environ.get("POCKET_LOG_LEVEL", "INFO").upper())
except Exception:
    pass

app = Flask(__name__)

# ── Event loop ya asyncio inayoendesha kwenye thread yake mwenyewe — Flask
# ni sync, pocketoptionapi_async ni async, hii ndiyo "daraja" kati ya hizo
# mbili (connection MOJA inabaki wazi, badala ya kuunganisha upya kila ombi).
_loop = asyncio.new_event_loop()
_client = None
_client_lock = threading.Lock()
_last_error = None  # sababu ya mwisho ya kushindwa ku-connect (inaonekana kwenye /health)


def _run_loop():
    asyncio.set_event_loop(_loop)
    _loop.run_forever()


threading.Thread(target=_run_loop, daemon=True).start()


def run_async(coro, timeout=30):
    """Endesha coroutine kwenye event loop ya background thread, subiri jibu."""
    future = asyncio.run_coroutine_threadsafe(coro, _loop)
    return future.result(timeout=timeout)


def _err(e):
    """Ujumbe wa error usio tupu (str(TimeoutError()) ni tupu)."""
    if isinstance(e, TimeoutError):
        return ("Pocket Option haikujibu kwa wakati (timeout). Angalia kwenye app ya "
                "Pocket Option kama order imefunguliwa kabla ya kujaribu tena.")
    return str(e) or f"{type(e).__name__} (hakuna ujumbe)"


def _is_connected(client):
    """True kama client ipo na library inasema imeunganishwa."""
    if client is None:
        return False
    val = getattr(client, "is_connected", True)
    try:
        return bool(val() if callable(val) else val)
    except Exception:
        return False


async def _connect_client():
    global _client
    try:
        client = AsyncPocketOptionClient(SSID, is_demo=IS_DEMO, enable_logging=True)
    except TypeError:
        client = AsyncPocketOptionClient(SSID, is_demo=IS_DEMO)
    try:
        ok = await client.connect()
    except Exception:
        print("❌ [pocket_bridge] connect() imetoa exception:\n" + traceback.format_exc())
        raise
    print(f"ℹ️  [pocket_bridge] connect() ilirudisha: {ok!r}, is_connected={_is_connected(client)}")
    # connect() inaweza kurudisha False (au kurudi bila error) wakati SSID si
    # sahihi/imeisha muda — usihifadhi client ambayo haijaunganishwa kweli.
    if ok is False or not _is_connected(client):
        try:
            await client.disconnect()
        except Exception:
            pass
        raise RuntimeError(
            "Imeshindwa kuunganisha na Pocket Option. Angalia logi za Railway kwa "
            "kosa halisi: (1) tatizo la library/websockets (mfano 'extra_headers'), "
            "(2) network, au (3) POCKET_OPTION_SSID imeisha muda / haulingani na "
            "POCKET_OPTION_DEMO (demo/real)."
        )
    _client = client
    print(f"✅ [pocket_bridge] Imeunganishwa na Pocket Option (demo={IS_DEMO})")


def get_client():
    global _client, _last_error
    with _client_lock:
        # Client ipo lakini connection imedondoka → itupe na unganisha upya.
        if _client is not None and not _is_connected(_client):
            print("⚠️ [pocket_bridge] Connection imedondoka — naunganisha upya...")
            old, _client = _client, None
            try:
                run_async(old.disconnect(), timeout=10)
            except Exception:
                pass
        if _client is None:
            if not SSID:
                _last_error = "POCKET_OPTION_SSID haijawekwa (Railway variable)."
                raise RuntimeError(_last_error)
            try:
                run_async(_connect_client(), timeout=60)
                _last_error = None
            except Exception as e:
                _last_error = f"{type(e).__name__}: {e}"
                raise
        return _client


def _eager_connect_loop():
    """Unganisha na Pocket Option mara tu bridge inapoanza, na baadaye
    simamia connection (reconnect ikidondoka), ili /health iwe sahihi."""
    delay = 5
    while True:
        if not SSID:
            time.sleep(60)
            continue
        try:
            get_client()
            delay = 5
            time.sleep(30)  # kagua tena baada ya sekunde 30
        except Exception as e:
            print(f"⚠️ [pocket_bridge] Connect imeshindwa: {e} — jaribu tena baada ya {delay}s")
            time.sleep(delay)
            delay = min(delay * 2, 120)


def check_secret(req):
    secret = req.headers.get("X-Bridge-Secret") or req.args.get("secret")
    return secret == BRIDGE_SECRET


@app.before_request
def _auth():
    if request.path == "/health":
        return None
    if not check_secret(request):
        return jsonify({"ok": False, "error": "Secret si sahihi."}), 403


def _to_jsonable(obj, _depth=0):
    """Geuza object yoyote ya maktaba (OrderResult, enum, dataclass, pydantic,
    datetime, Decimal...) kuwa data ambayo jsonify inaweza kutuma."""
    if _depth > 6:
        return str(obj)
    if obj is None or isinstance(obj, (bool, int, float, str)):
        return obj
    if isinstance(obj, enum.Enum):
        return obj.value if isinstance(obj.value, (bool, int, float, str)) else obj.name
    if isinstance(obj, decimal.Decimal):
        return float(obj)
    if isinstance(obj, (_dt.datetime, _dt.date)):
        return obj.isoformat()
    if isinstance(obj, dict):
        return {str(k): _to_jsonable(v, _depth + 1) for k, v in obj.items()}
    if isinstance(obj, (list, tuple, set)):
        return [_to_jsonable(v, _depth + 1) for v in obj]
    if hasattr(obj, "model_dump"):  # pydantic v2
        try:
            return _to_jsonable(obj.model_dump(), _depth + 1)
        except Exception:
            pass
    if hasattr(obj, "dict") and callable(obj.dict):  # pydantic v1
        try:
            return _to_jsonable(obj.dict(), _depth + 1)
        except Exception:
            pass
    if dataclasses.is_dataclass(obj) and not isinstance(obj, type):
        return _to_jsonable(dataclasses.asdict(obj), _depth + 1)
    if hasattr(obj, "__dict__"):
        return {k: _to_jsonable(v, _depth + 1) for k, v in vars(obj).items() if not k.startswith("_")}
    return str(obj)


def _order_result_payload(result):
    """JSON ya matokeo + sehemu ya `win` (true/false) ambayo poresult.js
    inatarajia, ikichukuliwa kutoka status au profit."""
    data = _to_jsonable(result)
    print(f"ℹ️  [pocket_bridge] matokeo ghafi ya order: {data!r}")  # kwa uchunguzi (win/status/profit)
    # Maktaba ikikosa uthibitisho wa server (timeout), inaunda matokeo ya "fallback" yenye status
    # ACTIVE milele — order hiyo kwa kawaida haikufunguliwa kabisa. Yaweke alama ili isisubiriwe bure.
    if isinstance(data, dict) and "Timeout waiting for server confirmation" in str(data.get("error_message") or ""):
        data["unconfirmed"] = True
        return data
    if isinstance(data, dict) and not isinstance(data.get("win"), bool):
        status = str(data.get("status", "")).lower()
        profit = data.get("profit")
        if "win" in status:
            data["win"] = True
        elif "lose" in status or "loss" in status:
            data["win"] = False
        elif isinstance(profit, (int, float)):
            data["win"] = profit > 0
    return data


@app.route("/health", methods=["GET"])
def health():
    return jsonify({
        "ok": True,
        "connected": _is_connected(_client),
        "demo": IS_DEMO,
        "ssid_set": bool(SSID),
        "last_error": _last_error,
    })


@app.route("/balance", methods=["GET"])
def balance():
    try:
        client = get_client()
        bal = run_async(client.get_balance())
        return jsonify({"ok": True, "balance": {"balance": bal.balance, "currency": bal.currency}})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/assets", methods=["GET"])
def assets():
    """Orodha ya assets zinazotambulika na maktaba (forex, OTC, commodities, crypto, indices, hisa)."""
    try:
        from pocketoptionapi_async.constants import ASSETS
        return jsonify({"ok": True, "assets": sorted(ASSETS.keys())})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


def _candle_secs(ts):
    """Muda wa candle kama sekunde (inakubali datetime au namba)."""
    if isinstance(ts, _dt.datetime):
        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=_dt.timezone.utc)
        return ts.timestamp()
    return float(ts)


# ── Historia ya candles kupitia `loadHistoryPeriod` ─────────────────────────────
# Maktaba (pocketoptionapi_async 2.0.1) hutumia `changeSymbol` tu na inapuuza `count` na
# `end_time`, hivyo timeframe > 1m zinarudi na data ya zamani. Web ya Pocket Option hutumia
# `loadHistoryPeriod` {asset, period, time, offset, index}; server inajibu na `index` ile ile
# + `data: [{time, open, close, high, low, volume}]`. Tunalinganisha jibu kwa `index`, kwa hiyo
# maombi ya wakati mmoja (scan) hayachanganyiki.
# POCKET_HISTORY_MODE: "htf" (default: timeframe > 60s tu) | "all" (zote) | "off" (zima).
_HIST_PENDING = {}  # index -> asyncio.Future


def _history_mode():
    return os.environ.get("POCKET_HISTORY_MODE", "htf").strip().lower()


def _history_dispatch(data):
    """Inaitwa kwa kila ujumbe wa server. Ikiwa ni jibu la loadHistoryPeriod letu, linapeleka
    candles kwa ombi linalosubiri."""
    if not isinstance(data, dict):
        return
    idx = data.get("index")
    items = data.get("data")
    if idx is None or not isinstance(items, list):
        return
    fut = _HIST_PENDING.get(idx)
    if fut is None or fut.done():
        return
    by_time = {}
    for it in items:
        if isinstance(it, dict) and "time" in it and "open" in it:
            try:
                t = int(float(it["time"]))
                by_time[t] = {"time": t, "open": float(it["open"]), "high": float(it["high"]),
                              "low": float(it["low"]), "close": float(it["close"])}
            except (TypeError, ValueError):
                continue
    out = [by_time[t] for t in sorted(by_time)]
    fut.get_loop().call_soon_threadsafe(lambda: None if fut.done() else fut.set_result(out))


async def _history_request(client, pair, period, count, end_ts=None):
    """Omba `count` candles za `period` sekunde zinazoishia `end_ts` (default: sasa)."""
    count = max(1, min(int(count), 500))
    offset = count * period
    end_ts = int(end_ts or time.time())
    index = int(time.time()) * 100 + random.randint(10, 99)
    while index in _HIST_PENDING:
        index += 1
    fut = asyncio.get_running_loop().create_future()
    _HIST_PENDING[index] = fut
    msg = "42" + json.dumps(["loadHistoryPeriod", {
        "asset": pair, "period": period, "time": end_ts, "index": index, "offset": offset}])
    try:
        if getattr(client, "_is_persistent", False) and getattr(client, "_keep_alive_manager", None):
            await client._keep_alive_manager.send_message(msg)
        else:
            await client._websocket.send_message(msg)
        timeout = float(os.environ.get("POCKET_HISTORY_TIMEOUT", "12"))
        return await asyncio.wait_for(fut, timeout=timeout)
    except asyncio.TimeoutError:
        print(f"⚠️ [pocket_bridge] {pair} {period}s: loadHistoryPeriod haikujibu (timeout)")
        return []
    finally:
        _HIST_PENDING.pop(index, None)


# Buffer ya muda ya uchunguzi (/debug/history): inakusanya ujumbe wa server wakati wa dirisha fupi.
_CAPTURE = {"on": False, "msgs": []}


def _install_server_msg_logger():
    """Chapisha ujumbe wa server wenye maneno ya kushindwa/kukataliwa (mfano order kukataliwa).

    Maktaba inameza kosa la server na kuishia na timeout; hii inaonyesha kosa halisi kwenye logi.
    Haibadilishi tabia ya maktaba — inaangalia tu data inayopita.
    """
    import functools
    import inspect
    try:
        orig = AsyncPocketOptionClient._on_json_data
    except AttributeError:
        print("ℹ️  [pocket_bridge] _on_json_data haipo — logger ya ujumbe wa server haijawashwa")
        return
    keys = ("fail", "error", "unavailable", "not_available", "reject", "forbidden", "denied")

    def _peek(args, kwargs):
        try:
            if args:
                _history_dispatch(args[0])
        except Exception:
            pass
        try:
            text = repr(args[0] if args else kwargs)
            low = text.lower()
            if _CAPTURE["on"] and len(_CAPTURE["msgs"]) < 40 and "updatestream" not in low:
                _CAPTURE["msgs"].append(text[:900])
            if any(k in low for k in keys):
                print(f"⚠️ [pocket_bridge] ujumbe wa server: {text[:600]}")
        except Exception:
            pass

    if inspect.iscoroutinefunction(orig):
        @functools.wraps(orig)
        async def wrapper(self, *args, **kwargs):
            _peek(args, kwargs)
            return await orig(self, *args, **kwargs)
    else:
        @functools.wraps(orig)
        def wrapper(self, *args, **kwargs):
            _peek(args, kwargs)
            return orig(self, *args, **kwargs)
    AsyncPocketOptionClient._on_json_data = wrapper


_install_server_msg_logger()


def _page_1m_to_tf(client, pair, timeframe, need):
    """Jenga candles za `timeframe` kwa kuomba candles za 1m (ambazo ni sahihi) kurasa kadhaa kwa
    kutumia `end_time`, kisha kuziunganisha. Inajithibitisha: ikiona dalili yoyote ya data mbovu
    (end_time haifanyi kazi, muda wa baadaye, n.k.) inarudisha [] ili tusilishe data mbaya."""
    step = timeframe // 60
    pages = min(12, -(-(need * step) // 90) + 1)
    now = time.time()
    seen = {}
    end = now
    for i in range(pages):
        end_dt = _dt.datetime.fromtimestamp(end, tz=_dt.timezone.utc).replace(tzinfo=None)  # UTC isiyo na tz
        try:
            raw = run_async(client.get_candles(asset=pair, timeframe=60, count=100, end_time=end_dt), timeout=40)
        except TypeError:
            print("⚠️ [pocket_bridge] get_candles haikubali end_time — kurasa za 1m haziwezekani")
            return []
        if not raw:
            break
        stamps = [int(_candle_secs(c.timestamp)) for c in raw]
        before = len(seen)
        for t, c in zip(stamps, raw):
            seen[t] = c
        if len(seen) == before:
            print(f"⚠️ [pocket_bridge] {pair}: ukurasa {i + 1} haukuleta candles mpya — end_time haifanyi kazi")
            break
        end = min(stamps) - 1
    if len(seen) < 2 * step:
        return []
    ts_sorted = sorted(seen)
    if ts_sorted[-1] > now + 90:  # candle ya baadaye = data mbovu
        print(f"⚠️ [pocket_bridge] {pair}: candles za 1m zina muda wa baadaye — nimezikataa")
        return []
    sample = seen[ts_sorted[-1]].timestamp
    buckets = {}
    for t in ts_sorted:
        buckets.setdefault(t - (t % timeframe), []).append(seen[t])
    keys = sorted(buckets)
    out = []
    for i, key in enumerate(keys):
        if i == 0 and len(keys) > 1:
            continue  # kundi la kwanza mara nyingi halijakamilika
        items = buckets[key]
        time_val = _dt.datetime.fromtimestamp(key, tz=_dt.timezone.utc) if isinstance(sample, _dt.datetime) else key
        out.append({
            "time": time_val,
            "open": float(items[0].open),
            "high": max(float(c.high) for c in items),
            "low": min(float(c.low) for c in items),
            "close": float(items[-1].close),
        })
    return out


@app.route("/candles", methods=["GET"])
def candles():
    """
    Query params: pair (mfano EURUSD_otc), timeframe (sekunde, mfano 60),
    count — tunakata (slice) idadi hii baada ya kupokea candles zote.
    Inarudisha: [{time, open, high, low, close}, ...] za zamani kwanza.
    """
    pair = request.args.get("pair", "EURUSD_otc")
    timeframe = int(request.args.get("timeframe", "60"))
    count = int(request.args.get("count", "100"))
    try:
        client = get_client()

        # Njia mpya: loadHistoryPeriod (candles halisi za timeframe husika). Ikishindwa au
        # data ni ya zamani, tunaendelea na njia ya zamani hapa chini kama kawaida.
        mode = _history_mode()
        if mode == "all" or (mode == "htf" and timeframe > 60):
            try:
                hist = run_async(_history_request(client, pair, timeframe, count), timeout=25)
            except Exception as e:
                hist = []
                print(f"⚠️ [pocket_bridge] {pair} {timeframe}s: history imeshindwa: {type(e).__name__}: {e}")
            if hist:
                age = time.time() - hist[-1]["time"]
                if age <= max(timeframe * 3, 180):
                    return jsonify({"ok": True, "pair": pair, "timeframe": timeframe,
                                    "source": "loadHistoryPeriod", "candles": hist[-count:]})
                print(f"ℹ️  [pocket_bridge] {pair} {timeframe}s: history ni ya zamani (umri {int(age // 60)} dk) — natumia njia ya zamani")

        raw_candles = run_async(client.get_candles(asset=pair, timeframe=timeframe))

        candles_out = [
            {
                "time": c.timestamp,
                "open": float(c.open),
                "high": float(c.high),
                "low": float(c.low),
                "close": float(c.close),
            }
            for c in raw_candles
        ]

        # Timeframe kubwa kuliko 1m: maktaba hii inarudisha candles za zamani (au zenye muda usio sahihi)
        # hata soko likiwa wazi. Tunajaribu kuzijenga kutoka kurasa za 1m; tukishindwa, tunaacha kama zilivyo.
        if timeframe > 60 and timeframe % 60 == 0 and raw_candles:
            now_ts = time.time()
            age = now_ts - _candle_secs(raw_candles[-1].timestamp)
            if age > timeframe * 3:
                first_ts = _candle_secs(raw_candles[0].timestamp)
                last_ts = _candle_secs(raw_candles[-1].timestamp)
                print(f"⚠️ [pocket_bridge] {pair} {timeframe}s: candles za zamani — n={len(raw_candles)} "
                      f"ya kwanza={_dt.datetime.fromtimestamp(first_ts, tz=_dt.timezone.utc):%m-%d %H:%M} "
                      f"ya mwisho={_dt.datetime.fromtimestamp(last_ts, tz=_dt.timezone.utc):%m-%d %H:%M} "
                      f"sasa={_dt.datetime.fromtimestamp(now_ts, tz=_dt.timezone.utc):%m-%d %H:%M} UTC — najaribu kurasa za 1m")
                agg = _page_1m_to_tf(client, pair, timeframe, min(count, 60))
                if agg:
                    agg_age = now_ts - _candle_secs(agg[-1]["time"])
                    print(f"ℹ️  [pocket_bridge] {pair} {timeframe}s: zilizojengwa={len(agg)}, umri wa mwisho={int(agg_age // 60)} dk")
                    if 0 <= agg_age <= timeframe * 3:
                        candles_out = agg
        candles_out = candles_out[-count:]
        return jsonify({"ok": True, "pair": pair, "timeframe": timeframe, "candles": candles_out})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/order", methods=["POST"])
def order():
    """
    Body (JSON): { "pair": "EURUSD_otc", "direction": "BUY"|"SELL",
                    "amount": 5, "expiry_seconds": 60 }
    """
    body = request.get_json(force=True) or {}
    pair = body.get("pair")
    direction = str(body.get("direction", "BUY")).upper()
    amount = float(body.get("amount", 1))
    expiry_seconds = int(body.get("expiry_seconds", 60))

    if not pair:
        return jsonify({"ok": False, "error": "pair inahitajika."}), 400

    try:
        client = get_client()
        po_direction = OrderDirection.CALL if direction == "BUY" else OrderDirection.PUT
        order_result = run_async(client.place_order(
            asset=pair,
            amount=amount,
            direction=po_direction,
            duration=expiry_seconds,
        ), timeout=75)
        if "Timeout waiting for server confirmation" in str(getattr(order_result, "error_message", None) or ""):
            print(f"⚠️ [pocket_bridge] Order {order_result.order_id} ({pair}) haikuthibitishwa na Pocket Option (timeout).")
            return jsonify({
                "ok": False,
                "error": (f"Pocket Option haikuthibitisha order ya {pair} (timeout) — huenda HAIKUFUNGULIWA. "
                          "Angalia history kwenye app ya Pocket Option kabla ya kujaribu tena. "
                          "Ikijirudia, jaribu jozi ya _otc."),
            }), 504
        return jsonify({
            "ok": True,
            "order_id": order_result.order_id,
            "raw": {
                "order_id": order_result.order_id,
                "amount": order_result.amount,
                "direction": str(order_result.direction),
                "duration": order_result.duration,
            },
        })
    except Exception as e:
        return jsonify({"ok": False, "error": _err(e)}), 500


@app.route("/order/<order_id>/result", methods=["GET"])
def order_result(order_id):
    try:
        client = get_client()
        # check_order_result() inasubiri mpaka trade ikamilike na kurudisha
        # matokeo kamili (win/loss + profit); check_win() ni mbadala rahisi.
        result = run_async(client.check_order_result(order_id), timeout=200)
        return jsonify({"ok": True, "result": _order_result_payload(result)})
    except Exception as e:
        return jsonify({"ok": False, "error": _err(e)}), 500


@app.route("/orders/active", methods=["GET"])
def active_orders():
    try:
        client = get_client()
        orders = run_async(client.get_active_orders())
        return jsonify({"ok": True, "orders": _to_jsonable(orders)})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


def _lib_diagnostics():
    """Uchunguzi wa MUDA: toleo la maktaba ya Pocket Option na msimbo wa kazi zake za
    candles/history — ili kuona kwa nini timeframe kubwa (5m+) zinarudisha data ya zamani.
    Inasoma tu msimbo wa maktaba; haibadilishi chochote."""
    import inspect
    import importlib.metadata as md
    out = []
    ver = None
    for name in ("pocketoptionapi-async", "pocketoptionapi_async"):
        try:
            ver = md.version(name)
            break
        except Exception:
            pass
    try:
        src_file = inspect.getsourcefile(AsyncPocketOptionClient)
    except Exception:
        src_file = "?"
    out.append(f"version={ver} file={src_file}")

    names = [n for n in dir(AsyncPocketOptionClient)
             if any(k in n.lower() for k in ("candle", "history", "period"))]
    out.append("methods=" + ", ".join(names))

    for n in names:
        try:
            fn = getattr(AsyncPocketOptionClient, n)
            out.append(f"\n--- {n}{inspect.signature(fn)} ---\n" + inspect.getsource(fn))
        except Exception as e:
            out.append(f"\n--- {n}: haisomeki ({e}) ---")

    # Mistari ya moduli nzima inayogusa history (ujumbe wa server unaoshughulikiwa wapi)
    try:
        mod_src = inspect.getsource(sys.modules[AsyncPocketOptionClient.__module__]).splitlines()
        hits = [f"{i + 1}: {ln.strip()}" for i, ln in enumerate(mod_src)
                if any(k in ln.lower() for k in ("loadhistory", "updatehistory", "history_period", "_candles"))]
        out.append("\n--- mistari ya moduli inayotaja history/candles ---\n" + "\n".join(hits[:120]))
    except Exception as e:
        out.append(f"\n(moduli haisomeki: {e})")
    return "\n".join(out)[:40000]


@app.route("/debug/lib", methods=["GET"])
def debug_lib():
    try:
        return app.response_class(_lib_diagnostics(), mimetype="text/plain")
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500



@app.route("/debug/history", methods=["GET"])
def debug_history():
    """Uchunguzi wa MUDA: tuma ombi la `loadHistoryPeriod` (kama web ya Pocket Option) na
    onyesha jibu halisi la server — ili tuone muundo wa data ya timeframe kubwa. Hairekebishi
    wala kuhifadhi chochote; ni ombi la kusoma tu."""
    try:
        pair = request.args.get("pair", "EURUSD_otc")
        if not re.fullmatch(r"[#A-Za-z0-9_]{3,20}", pair):
            return jsonify({"ok": False, "error": "pair si sahihi"}), 400
        period = max(1, min(int(request.args.get("period", "300")), 86400))
        offset = max(period, min(int(request.args.get("offset", str(period * 100))), 1_000_000))
        end_ts = int(request.args.get("time", str(int(time.time()))))

        client = get_client()
        index = int(time.time()) * 100 + random.randint(10, 99)
        msg = "42" + json.dumps(["loadHistoryPeriod", {
            "asset": pair, "period": period, "time": end_ts, "index": index, "offset": offset}])

        async def _go():
            if getattr(client, "_is_persistent", False) and getattr(client, "_keep_alive_manager", None):
                await client._keep_alive_manager.send_message(msg)
            else:
                await client._websocket.send_message(msg)
            await asyncio.sleep(5)

        _CAPTURE["msgs"] = []
        _CAPTURE["on"] = True
        try:
            run_async(_go(), timeout=20)
        finally:
            _CAPTURE["on"] = False
        out = [f"sent: {msg}", f"captured={len(_CAPTURE['msgs'])}"]
        out += [f"[{i}] {m}" for i, m in enumerate(_CAPTURE["msgs"])]
        return app.response_class("\n".join(out), mimetype="text/plain")
    except Exception as e:
        return jsonify({"ok": False, "error": f"{type(e).__name__}: {e}"}), 500


if __name__ == "__main__":
    print(f"🌐 [pocket_bridge] Inaanza kwenye port {PORT} (demo={IS_DEMO})")
    if os.environ.get("POCKET_DEBUG_LIB", "true").strip().lower() != "false":
        try:
            print("===== POCKET_LIB_DIAG BEGIN =====")
            print(_lib_diagnostics())
            print("===== POCKET_LIB_DIAG END =====")
        except Exception as e:
            print(f"[pocket_bridge] uchunguzi wa maktaba umeshindwa: {e}")
    threading.Thread(target=_eager_connect_loop, daemon=True).start()
    app.run(host="0.0.0.0", port=PORT)
