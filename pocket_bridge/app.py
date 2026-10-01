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


if __name__ == "__main__":
    print(f"🌐 [pocket_bridge] Inaanza kwenye port {PORT} (demo={IS_DEMO})")
    threading.Thread(target=_eager_connect_loop, daemon=True).start()
    app.run(host="0.0.0.0", port=PORT)
