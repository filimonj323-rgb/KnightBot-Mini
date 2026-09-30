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

app = Flask(__name__)

# ── Event loop ya asyncio inayoendesha kwenye thread yake mwenyewe — Flask
# ni sync, pocketoptionapi_async ni async, hii ndiyo "daraja" kati ya hizo
# mbili (connection MOJA inabaki wazi, badala ya kuunganisha upya kila ombi).
_loop = asyncio.new_event_loop()
_client = None
_client_lock = threading.Lock()


def _run_loop():
    asyncio.set_event_loop(_loop)
    _loop.run_forever()


threading.Thread(target=_run_loop, daemon=True).start()


def run_async(coro, timeout=30):
    """Endesha coroutine kwenye event loop ya background thread, subiri jibu."""
    future = asyncio.run_coroutine_threadsafe(coro, _loop)
    return future.result(timeout=timeout)


async def _connect_client():
    global _client
    client = AsyncPocketOptionClient(SSID, is_demo=IS_DEMO)
    await client.connect()
    _client = client
    print(f"✅ [pocket_bridge] Imeunganishwa na Pocket Option (demo={IS_DEMO})")


def get_client():
    global _client
    with _client_lock:
        if _client is None:
            run_async(_connect_client())
        return _client


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
    return jsonify({"ok": True, "connected": _client is not None, "demo": IS_DEMO})


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
    app.run(host="0.0.0.0", port=PORT)
