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
import asyncio
import threading
import time
from flask import Flask, request, jsonify
from dotenv import load_dotenv
from pocketoptionapi_async import AsyncPocketOptionClient, OrderDirection

load_dotenv()

SSID = os.environ.get("POCKET_OPTION_SSID", "")
IS_DEMO = os.environ.get("POCKET_OPTION_DEMO", "true").lower() == "true"
# Port ni constant (si env) — inalingana na BRIDGE_URL iliyowekwa moja kwa
# moja (hardcoded) kwenye utils/pocketOptionTrader.js upande wa Node.
PORT = 5055
BRIDGE_SECRET = os.environ.get("POCKET_BRIDGE_SECRET", "badilisha_hii_iwe_secret_ndefu")

if not SSID:
    print("⚠️  POCKET_OPTION_SSID haijawekwa kwenye .env — bridge haitaweza connect.")

import logging
logging.getLogger("werkzeug").setLevel(logging.ERROR)

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
    client = AsyncPocketOptionClient(SSID, is_demo=IS_DEMO)
    ok = await client.connect()
    # connect() inaweza kurudisha False (au kurudi bila error) wakati SSID si
    # sahihi/imeisha muda — usihifadhi client ambayo haijaunganishwa kweli.
    if ok is False or not _is_connected(client):
        try:
            await client.disconnect()
        except Exception:
            pass
        raise RuntimeError(
            "Pocket Option imekataa muunganisho — POCKET_OPTION_SSID si sahihi, "
            "imeisha muda, au haulingani na POCKET_OPTION_DEMO (demo/real)."
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
        ))
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
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/order/<order_id>/result", methods=["GET"])
def order_result(order_id):
    try:
        client = get_client()
        # check_order_result() inasubiri mpaka trade ikamilike na kurudisha
        # matokeo kamili (win/loss + profit); check_win() ni mbadala rahisi.
        result = run_async(client.check_order_result(order_id))
        return jsonify({"ok": True, "result": result})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/orders/active", methods=["GET"])
def active_orders():
    try:
        client = get_client()
        orders = run_async(client.get_active_orders())
        return jsonify({"ok": True, "orders": orders})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


if __name__ == "__main__":
    print(f"🌐 [pocket_bridge] Inaanza kwenye port {PORT} (demo={IS_DEMO})")
    threading.Thread(target=_eager_connect_loop, daemon=True).start()
    app.run(host="0.0.0.0", port=PORT)
