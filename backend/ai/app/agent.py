"""Agent orchestration: Redis session memory + per-user cart/order context."""
import json
import time
import uuid

from . import db
from .catalog import Catalog
from .config import settings
from .redis_client import get_redis

MEMORY_KEYS = ("results", "filters", "focus", "pending", "offset", "lastAdjust", "history")
# Client-side facts the brain may use: device locale and time zone (for language, season and
# festivals), the reply language Pip last used or the shopper picked, whether they spoke and whether
# the reply will be spoken, where the message came from (typed, voice, chip, card, greet) and what they
# did on the product cards since the last reply. The brain validates every one before using it.
CLIENT_KEYS = ("tryOn", "locale", "timeZone", "lang", "langMode", "spoken", "voiceOut", "origin", "events", "quizStyles")
# Titles many Bangladeshi and South Asian names start with ("Md. Rahim Uddin", "Mst. Fatema Begum").
TITLES = {"md", "mohd", "mst", "most", "sk", "dr", "mr", "mrs", "ms", "engr", "prof", "adv"}


def first_name(name: str | None) -> str | None:
    """The name Pip calls the shopper by: the first word that isn't a title ("Md. Rahim Uddin" -> "Rahim")."""
    return next((w for w in (name or "").split() if w.lower().rstrip(".") not in TITLES), None)


def session_key(session_id: str) -> str:
    return f"agent:session:{session_id}"


def new_session_id() -> str:
    return uuid.uuid4().hex


async def load_memory(session_id: str) -> dict:
    raw = await get_redis().get(session_key(session_id))
    try:
        return json.loads(raw) if raw else {}
    except ValueError:
        return {}


async def save_memory(session_id: str, memory: dict) -> None:
    await get_redis().set(session_key(session_id), json.dumps(memory), ex=settings.session_ttl)


async def build_context(user_id: str | None, catalog: Catalog, client_ctx: dict | None = None) -> dict:
    """Cart (Redis, written by the API) + latest orders (Postgres) for `user_id`."""
    ctx: dict = {"cart": [], "cartTotal": 0, "orders": [], "userName": None}
    client_ctx = client_ctx or {}
    ctx.update({k: client_ctx[k] for k in CLIENT_KEYS if client_ctx.get(k) is not None})
    if not user_id:
        return ctx

    r = get_redis()
    # The shopper profile and "Picked for you" list the API builds in the background (one round trip).
    # The family's votes on their latest shared look ("Ask family"), summarised by the API as votes arrive.
    profile, reco, looks = await r.mget(f"profile:{user_id}", f"reco:{user_id}", f"looksum:{user_id}")
    try:
        if profile:
            ctx["profile"] = json.loads(profile)
        if reco:
            ctx["suggested"] = json.loads(reco).get("ids") or []
        if looks:
            ctx["familyVotes"] = json.loads(looks)
    except ValueError:
        pass

    raw = await r.hgetall(f"cart:{user_id}")
    total = 0.0
    for value in raw.values():
        try:
            line = json.loads(value)
        except ValueError:
            continue
        p = catalog.get(line.get("productId"))
        if not p:
            continue
        qty = int(line.get("qty") or 1)
        ctx["cart"].append({"id": p["id"], "name": p["name"], "qty": qty, "price": p["price"], "color": line.get("color"), "size": line.get("size")})
        total += p["price"] * qty
    ctx["cartTotal"] = round(total, 2)

    # What they told us (Account: sizes, colouring). Pip uses sizes, and colouring only when asked what suits them.
    prefs = await db.fetch('SELECT sizes, fit, "skinTone", undertone, styles FROM public."ShopperPreferences" WHERE "userId" = %s', (user_id,))
    if prefs:
        told = {"sizes": prefs[0]["sizes"] or {}, "fit": prefs[0]["fit"], "skinTone": prefs[0]["skinTone"], "undertone": prefs[0]["undertone"]}
        ctx["prefs"] = {k: v for k, v in told.items() if v}
        # The style quiz answers saved on the account win over what a guest browser sent.
        if prefs[0].get("styles"):
            ctx["quizStyles"] = list(prefs[0]["styles"])

    users = await db.fetch('SELECT name, personalise FROM public."User" WHERE id = %s', (user_id,))
    if users and users[0]["name"]:
        ctx["userName"] = first_name(users[0]["name"])
    ctx["personalise"] = bool(users and users[0]["personalise"])
    if not ctx["personalise"]:
        ctx.pop("profile", None)
        ctx.pop("suggested", None)

    orders = await db.fetch(
        'SELECT o.id, o.status::text AS status, o.total, o."createdAt" AS created_at, '
        "COALESCE(json_agg(json_build_object('productId', i.\"productId\", 'name', i.name, 'qty', i.qty)) "
        "FILTER (WHERE i.id IS NOT NULL), '[]') AS items, "
        # The latest delivery: who has it and where it is (rider codes and phone numbers stay out).
        '(SELECT s.status::text || \'|\' || s.carrier FROM public."Shipment" s WHERE s."orderId" = o.id '
        'ORDER BY s."createdAt" DESC LIMIT 1) AS delivery '
        'FROM public."Order" o LEFT JOIN public."OrderItem" i ON i."orderId" = o.id '
        'WHERE o."userId" = %s GROUP BY o.id ORDER BY o."createdAt" DESC LIMIT 5',
        (user_id,),
    )
    ctx["orders"] = [
        {
            "id": o["id"], "status": o["status"], "total": float(o["total"]), "items": o["items"], "createdAt": o["created_at"].isoformat(),
            "delivery": dict(zip(("status", "carrier"), o["delivery"].split("|"))) if o.get("delivery") else None,
        }
        for o in orders
    ]
    return ctx


async def chat(
    provider, message: str | None, session_id: str | None, user_id: str | None, client_ctx: dict | None, catalog: Catalog,
    kind: str = "message", client: str | None = None,
) -> dict:
    """One turn. `kind="greet"` asks for an opening line (in the shopper's language, when the brain can).
    `client`: the API gateway's hash of a guest's network, so Pip's daily quota holds when the session id
    changes (strikes stay on the guest's own chat: one network is often many shoppers)."""
    session_id = session_id or new_session_id()
    memory = await load_memory(session_id)
    if client_ctx and client_ctx.get("results"):
        memory["results"] = [pid for pid in client_ctx["results"] if catalog.get(pid)]
    ctx = await build_context(user_id, catalog, client_ctx)
    # Who the shopper is, for strikes and daily quotas (brain/limits.py); never shown to Claude.
    ctx.update(userId=user_id, sessionId=session_id, client=client)
    reply = await provider.greet(memory, ctx) if kind == "greet" else await provider.respond(message or "", memory, ctx)
    await save_memory(session_id, memory)
    hints = reply.pop("hints", None)
    if hints and user_id and ctx.get("personalise"):
        await remember_hints(user_id, hints)
    wanted = reply.pop("wanted", None)
    if wanted and user_id and ctx.get("personalise") and kind != "greet":
        await remember_want(user_id, wanted)
    return {**reply, "session_id": session_id}


async def remember_want(user_id: str, text: str) -> None:
    """Something the catalog didn't have, for the API's outreach worker (backend/api/src/outreach/inbox.ts)."""
    try:
        r = get_redis()
        await r.rpush("wants:inbox", json.dumps({"userId": user_id, "source": "chat", "text": text[:160], "at": int(time.time() * 1000)}))
        await r.ltrim("wants:inbox", -50000, -1)
    except Exception:
        pass


async def remember_hints(user_id: str, hints: dict) -> None:
    """What the shopper said about their taste, for the API's profile builder (backend/api/src/journeys)."""
    try:
        r = get_redis()
        key = f"profile:hints:{user_id}"
        await r.lpush(key, json.dumps(hints))
        await r.ltrim(key, 0, 49)
        await r.expire(key, 90 * 86400)
        await r.sadd("profile:dirty", user_id)
    except Exception:
        pass


async def publish(session_id: str, event: dict) -> None:
    try:
        await get_redis().publish(f"agent:events:{session_id}", json.dumps(event))
    except Exception:
        pass
