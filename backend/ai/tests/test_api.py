import base64
import hashlib
import hmac
import json
import time

import pytest
from starlette.websockets import WebSocketDisconnect

from app.config import settings

from .fakes import Settings

KEY = {"X-Internal-Key": settings.internal_api_key}


@pytest.fixture
def ws_on():
    """The WebSocket chat is off unless AGENT_WS_ENABLED."""
    s = Settings()
    s(agent_ws_enabled=True)
    yield
    s.restore()


def make_token(sub, secret=None, exp_in=3600):
    """An HS256 token shaped like the ones the NestJS API issues."""
    enc = lambda d: base64.urlsafe_b64encode(json.dumps(d).encode()).rstrip(b"=").decode()
    head, body = enc({"alg": "HS256", "typ": "JWT"}), enc({"sub": sub, "exp": int(time.time()) + exp_in})
    sig = hmac.new((secret or settings.jwt_secret).encode(), f"{head}.{body}".encode(), hashlib.sha256).digest()
    return f"{head}.{body}." + base64.urlsafe_b64encode(sig).rstrip(b"=").decode()


def test_rebuild_requires_key(client):
    assert client.post("/index/rebuild").status_code == 401


def test_chat_session_memory_in_redis(client, ai_tryon):
    r = client.post("/agent/chat", json={"message": "show me dresses"}).json()
    sid = r["session_id"]
    r = client.post("/agent/chat", json={"message": "try on number 1", "session_id": sid, "context": {"tryOn": {"hasPhoto": False, "on": []}}}).json()
    assert r["actions"] == [{"type": "tryon", "id": 17}]
    r = client.post("/agent/chat", json={"message": "add the first one", "session_id": sid}).json()
    assert "Which size" in r["text"]
    r = client.post("/agent/chat", json={"message": "M", "session_id": sid}).json()
    assert r["actions"] == [{"type": "add", "id": 17, "size": "M", "color": "Scarlet"}]


def test_a_slow_ai_suggestion_is_a_503_not_a_500(client, monkeypatch):
    """The admin panel shows its "try again" message when Claude times out (each attempt gets 40 s)."""
    import anthropic
    import httpx

    from app import product_details

    async def timed_out(fields, image):
        raise anthropic.APITimeoutError(request=httpx.Request("POST", "https://api.anthropic.com/v1/messages"))

    monkeypatch.setattr(product_details, "suggest", timed_out)
    s = Settings()
    s(internal_api_key="test-internal-key")
    try:
        r = client.post("/catalog/suggest", json={"name": "Tan Canvas Court", "type": "Shoes"}, headers={"X-Internal-Key": "test-internal-key"})
    finally:
        s.restore()
    assert r.status_code == 503 and r.json()["error"] == "suggest_unavailable"


def test_order_status_for_demo_user(client, demo_user_id, demo_latest_order):
    if not demo_user_id or not demo_latest_order:
        pytest.skip("demo user or order not seeded")
    r = client.post("/agent/chat", json={"message": "where is my order", "user_id": demo_user_id}, headers=KEY).json()
    assert demo_latest_order["id"] in r["text"]
    assert demo_latest_order["status"].lower().replace("_", " ") in r["text"].lower()


def test_user_id_is_ignored_without_internal_key(client, demo_user_id, demo_latest_order):
    if not demo_user_id or not demo_latest_order:
        pytest.skip("demo user or order not seeded")
    r = client.post("/agent/chat", json={"message": "where is my order", "user_id": demo_user_id}).json()
    assert demo_latest_order["id"] not in r["text"]
    r = client.post("/agent/chat", json={"message": "where is my order", "user_id": demo_user_id}, headers={"X-Internal-Key": "wrong"}).json()
    assert "CL-20931" not in r["text"]


def test_cart_context_from_redis(client):
    import redis

    from app.config import settings
    from app.redis_client import get_redis  # noqa: F401  (client fixture owns the loop)

    r = redis.from_url(settings.redis_url)
    uid = "pytest-ai-cart-user"
    r.hset(f"cart:{uid}", "11|Scarlet|42", json.dumps({"productId": 11, "color": "Scarlet", "size": "42", "qty": 2}))
    try:
        body = client.post("/agent/chat", json={"message": "what's in my cart", "user_id": uid}, headers=KEY).json()
        assert "2 × Ember Knit Runner" in body["text"] and "$196" in body["text"]
    finally:
        r.delete(f"cart:{uid}")


def test_preview_and_voice(client):
    assert client.get("/agent/preview", params={"q": "red dress"}).json()["products"] == [17, 18]
    assert client.post("/voice/token", json={"identity": "maya"}).status_code == 401
    r = client.post("/voice/token", json={"identity": "maya"}, headers=KEY)
    assert r.status_code == 503 and r.json()["error"] == "voice_not_configured" and "/agent/ws" not in r.text


def test_websocket_protocol(client, ws_on):
    with client.websocket_connect("/agent/ws") as ws:
        sid = ws.receive_json()["session_id"]
        ws.send_json({"type": "ping"})
        assert ws.receive_json() == {"type": "pong"}
        ws.send_json({"type": "partial", "text": "red"})
        ws.send_json({"type": "partial", "text": "red dress"})
        s = ws.receive_json()
        assert s == {"type": "suggestions", "products": [17, 18], "text": "red dress"}
        ws.send_json({"type": "message", "text": "show me red dresses"})
        assert ws.receive_json() == {"type": "status", "status": "thinking"}
        reply = ws.receive_json()
        assert reply["type"] == "reply" and reply["session_id"] == sid and reply["products"]


def test_websocket_user_comes_from_a_verified_token(client, demo_user_id, demo_latest_order, ws_on):
    if not demo_user_id or not demo_latest_order:
        pytest.skip("demo user or order not seeded")
    order_id = demo_latest_order["id"]

    def ask(url):
        with client.websocket_connect(url) as ws:
            ws.receive_json()
            ws.send_json({"type": "message", "text": "where is my order"})
            ws.receive_json()
            return ws.receive_json()["text"]

    assert order_id in ask(f"/agent/ws?token={make_token(demo_user_id)}")
    assert order_id not in ask(f"/agent/ws?token={make_token(demo_user_id, secret='forged')}")
    assert order_id not in ask(f"/agent/ws?token={make_token(demo_user_id, exp_in=-10)}")
    assert "CL-20931" not in ask(f"/agent/ws?user_id={demo_user_id}")


def test_capabilities_without_keys(client):
    caps = client.get("/capabilities").json()
    assert caps["agent"] in ("rules", "claude") and set(caps) >= {"multilingual", "tryon", "speech"}


def test_greeting_and_empty_message(client):
    r = client.post("/agent/chat", json={"kind": "greet", "context": {"locale": "bn-BD", "timeZone": "Asia/Dhaka"}})
    assert r.status_code == 200 and r.json()["text"] and r.json()["session_id"]
    assert client.post("/agent/chat", json={"message": "  "}).status_code == 422


def test_websocket_is_off_unless_enabled(client):
    s = Settings()
    s(agent_ws_enabled=False)
    try:
        with pytest.raises(WebSocketDisconnect) as closed, client.websocket_connect("/agent/ws") as ws:
            ws.receive_json()
    finally:
        s.restore()
    assert closed.value.code == 4403


def test_bad_client_context_is_rejected(client):
    r = client.post("/agent/chat", json={"message": "hi", "context": {"langMode": "sometimes"}})
    assert r.status_code == 422


def test_client_context_carries_voice_origin_and_card_events(client):
    context = {"origin": "a-new-origin", "voiceOut": True, "events": [{"type": "add", "id": 17, "size": "M", "color": "Scarlet"}]}
    assert client.post("/agent/chat", json={"message": "hi", "context": context}).status_code == 200
    for bad in (
        {"events": [{"type": "add", "id": 17}] * 9},
        {"events": [{"type": "buy", "id": 17}]},
        {"events": [{"type": "add", "id": 17, "size": "x" * 13}]},
        {"events": [{"type": "add", "id": 17, "color": "x" * 41}]},
        {"origin": "x" * 21},
        {"tryOn": {"on": [{"id": 17, "name": "x" * 121}]}},
    ):
        assert client.post("/agent/chat", json={"message": "hi", "context": bad}).status_code == 422, bad


def test_guest_network_is_trusted_only_from_the_gateway(client, monkeypatch):
    from app import agent

    seen = {}

    async def chat(provider, message, session_id, user_id, client_ctx, catalog, kind="message", client=None):
        seen.update(user_id=user_id, client=client)
        return {"text": "ok", "session_id": "s"}

    monkeypatch.setattr(agent, "chat", chat)
    s = Settings()
    s(internal_api_key="gateway-key")
    try:
        client.post("/agent/chat", json={"message": "hi", "user_id": "u", "client": "abc"})
        assert seen == {"user_id": None, "client": None}
        client.post("/agent/chat", json={"message": "hi", "user_id": "u", "client": "abc"}, headers={"X-Internal-Key": "gateway-key"})
        assert seen == {"user_id": "u", "client": "abc"}
    finally:
        s.restore()
    assert client.post("/agent/chat", json={"message": "hi", "client": "x" * 65}).status_code == 422


def test_size_buttons_and_off_topic_flags_reach_the_storefront(client, monkeypatch):
    from app import main

    class Brain:
        name = "claude"

        async def respond(self, message, memory, ctx):
            return {"text": "Which size?", "products": [17], "askSize": 17, "offTopic": True}

    monkeypatch.setitem(main.state, "provider", Brain())
    r = client.post("/agent/chat", json={"message": "add it"}).json()
    assert r["askSize"] == 17 and r["offTopic"] is True and r["products"] == [17]


def test_paid_endpoints_are_gateway_only(client):
    body = {"user_id": "u", "sample": 0, "items": [{"id": 17}]}
    assert client.post("/tryon/render", json=body).status_code == 401
    assert client.post("/tryon/check", json={"image": "https://x.test/a.jpg", "slot": "top"}).status_code == 401
    assert client.post("/speech/speak", json={"text": "hi"}).status_code == 401
    assert client.post("/speech/transcribe", files={"file": ("a.webm", b"x", "audio/webm")}).status_code == 401


def test_photo_check_route(client):
    import io

    from PIL import Image, ImageDraw

    img = Image.new("RGB", (900, 1200), (250, 250, 250))
    ImageDraw.Draw(img).rectangle((200, 150, 700, 1050), fill=(200, 30, 40))
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=92)
    uri = "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()
    r = client.post("/tryon/check", json={"image": uri, "slot": "dress", "ai": False}, headers=KEY).json()
    assert r["ok"] and r["format"] == "image/jpeg" and r["background"] == "plain"
    assert any(i["code"] == "low_resolution" for i in r["issues"])  # 900px short side: fine, 1024+ is better
    assert client.post("/tryon/check", json={"image": uri, "slot": "cape"}, headers=KEY).status_code == 422


def test_render_needs_a_wearable_product(client):
    from app import tryon

    if not tryon.configured():
        assert client.post("/tryon/render", json={"user_id": "u", "sample": 0, "items": [{"id": 17}]}, headers=KEY).status_code == 503
