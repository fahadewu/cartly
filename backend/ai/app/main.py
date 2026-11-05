"""Cartly AI & voice service (FastAPI)."""
import asyncio
import base64
import hashlib
import logging
from contextlib import asynccontextmanager
from typing import Annotated, Any, Literal

import anthropic
import httpx
from fastapi import FastAPI, File, Form, Header, HTTPException, Query, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field, model_validator

from . import agent, culture, cutout, db, garment_check, meta, product_details, search, speech, tryon, usage, voice
from .auth import internal_ok, user_from_token
from .brain import get_provider
from .catalog import catalog
from .config import settings
from .redis_client import close_redis, get_redis

log = logging.getLogger("cartly.ai")
state: dict[str, Any] = {}


async def follow_catalog() -> None:
    """With several AI replicas, an admin edit reindexes on one of them; the rest reload from here."""
    seen = await get_redis().get("search:version")
    while True:
        await asyncio.sleep(settings.catalog_refresh_seconds)
        try:
            version = await get_redis().get("search:version")
            if version != seen:
                seen = version
                await catalog.load()
        except Exception as e:
            log.warning("Catalog refresh failed: %s", e)


@asynccontextmanager
async def lifespan(app: FastAPI):
    await db.open_pool()
    await catalog.load()
    if await search.needs_rebuild(catalog):
        n = await search.rebuild_index(catalog)
        log.warning("Built product embedding index (%d products)", n)
    state["provider"] = get_provider(settings.agent_provider, catalog)
    follower = asyncio.create_task(follow_catalog())
    yield
    follower.cancel()
    await db.close_pool()
    await close_redis()


app = FastAPI(title="Cartly AI", version="1.0.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def provider():
    return state["provider"]


# ---------- models ----------
class TryOnItem(BaseModel):
    id: int
    name: str | None = Field(default=None, max_length=120)  # Pip names it from the catalog, not from this


class TryOnContext(BaseModel):
    hasPhoto: bool = False
    mode: Literal["ai", "preview"] | None = None  # AI-generated look, or the on-device overlay
    on: list[TryOnItem] = Field(default=[], max_length=12)


class CardEvent(BaseModel):
    """Something the shopper did on a product card without asking Pip (the card handled it itself)."""

    type: Literal["add", "tryon", "like"]
    id: int
    size: str | None = Field(default=None, max_length=12)
    color: str | None = Field(default=None, max_length=40)


class ClientContext(BaseModel):
    tryOn: TryOnContext | None = None
    # Product ids of the list the shopper just clicked in (e.g. "Add" on a card in an older reply).
    results: list[int] | None = Field(default=None, max_length=12)
    locale: str | None = Field(default=None, max_length=35)  # navigator.language, e.g. "bn-BD"
    timeZone: str | None = Field(default=None, max_length=64)  # e.g. "Asia/Dhaka"
    lang: str | None = Field(default=None, max_length=20)  # reply language Pip used last, or the shopper's pick
    langMode: Literal["auto", "fixed"] | None = None
    spoken: bool | None = None
    voiceOut: bool | None = None  # the reply will be spoken (missing: only when the shopper spoke)
    # typed, voice, chip, card, greet; free text so a new storefront value never breaks the chat (metered as "other").
    origin: str | None = Field(default=None, max_length=20)
    events: list[CardEvent] | None = Field(default=None, max_length=8)  # card actions since Pip's last reply
    # Style quiz answers kept in a guest's browser (a signed-in shopper's come from the account).
    quizStyles: list[Annotated[str, Field(max_length=20)]] | None = Field(default=None, max_length=3)


class ChatRequest(BaseModel):
    message: str | None = Field(default=None, max_length=1000)
    kind: Literal["message", "greet"] = "message"
    session_id: str | None = Field(default=None, max_length=100)
    user_id: str | None = Field(default=None, max_length=100)
    # The gateway's hash of a guest's network, for Pip's per-shopper limits (trusted like user_id).
    client: str | None = Field(default=None, max_length=64)
    context: ClientContext | None = None

    @model_validator(mode="after")
    def _needs_message(self):
        if self.kind == "message" and not (self.message or "").strip():
            raise ValueError("message is required")
        return self


class AgentReply(BaseModel):
    model_config = {"extra": "allow"}
    text: str
    speech: str | None = None
    lang: str | None = None  # BCP-47 tag of the reply, so the browser speaks and listens in it
    products: list[int] | None = None
    actions: list[dict[str, Any]] | None = None
    chips: list[str] | None = None
    mood: str | None = None
    session_id: str


class SearchHit(BaseModel):
    id: int
    score: float


class SearchResponse(BaseModel):
    query: str
    results: list[SearchHit]
    filters: dict[str, Any]


class PreviewResponse(BaseModel):
    products: list[int]


class VoiceTokenRequest(BaseModel):
    identity: str = Field(min_length=1, max_length=100)
    room: str | None = Field(default=None, max_length=100)


class VoiceTokenResponse(BaseModel):
    token: str
    url: str
    room: str
    identity: str


class RenderItem(BaseModel):
    id: int | None = None  # a catalog product, or an explicit image + slot (admin previews)
    image: str | None = Field(default=None, max_length=15_000_000)
    slot: str | None = Field(default=None, max_length=20)
    name: str | None = Field(default=None, max_length=120)  # the product's name, for an explicit image
    styling: str | None = Field(default=None, max_length=200)
    notes: str | None = Field(default=None, max_length=200)  # the shopper's "tuck it in"


class RenderRequest(BaseModel):
    user_id: str = Field(min_length=1, max_length=100)
    photo: str | None = Field(default=None, max_length=15_000_000)  # data URI; or use a sample model
    sample: int | None = Field(default=None, ge=0, le=len(tryon.SAMPLE_MODELS) - 1)
    items: list[RenderItem] = Field(min_length=1, max_length=6)
    seed: int = Field(default=42, ge=0, le=2**32 - 1)


class CutoutRequest(BaseModel):
    image: str = Field(min_length=1, max_length=15_000_000)  # data URI or http(s) URL
    crop: list[float] | None = Field(default=None, min_length=4, max_length=4)  # [x0, y0, x1, y1], 0-1
    # The try-on slot (eyes, head…): what SAM is asked to find when CUTOUT_PROVIDER=meta.
    slot: str | None = Field(default=None, max_length=20)

    @model_validator(mode="after")
    def _crop_inside(self):
        c = self.crop
        if c and not (0 <= c[0] < c[2] <= 1 and 0 <= c[1] < c[3] <= 1):
            raise ValueError("crop must be [x0, y0, x1, y1] inside 0-1")
        return self


class CheckRequest(BaseModel):
    image: str = Field(min_length=1, max_length=15_000_000)  # data URI or http(s) URL
    slot: str = Field(max_length=20)
    name: str | None = Field(default=None, max_length=120)
    colors: list[str] | None = Field(default=None, max_length=12)
    ai: bool = True


class SuggestRequest(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    type: str = Field(max_length=40)
    category: str | None = Field(default=None, max_length=60)
    gender: str | None = Field(default=None, max_length=10)
    description: str | None = Field(default=None, max_length=1000)
    colors: list[str] | None = Field(default=None, max_length=12)
    image: str | None = Field(default=None, max_length=15_000_000)  # data URI or http(s) URL


class SpeakRequest(BaseModel):
    text: str = Field(min_length=1, max_length=800)
    lang: str | None = Field(default=None, max_length=20)


def ctx_dict(c: ClientContext | None) -> dict:
    return c.model_dump(exclude_none=True) if c else {}


def require_internal(key: str | None) -> None:
    if not internal_ok(key):
        raise HTTPException(401, "Invalid or missing X-Internal-Key")


def capabilities() -> dict:
    """What this deployment can do, so the storefront picks the best path (and the right fallbacks)."""
    return {
        "agent": provider().name,
        "multilingual": provider().name == "claude",
        "tryon": tryon.vendor(),
        # "meta": the storefront records WAV for it (Muse Voice Transcribe takes nothing else).
        "speech": {"stt": speech.stt_vendor(), "tts": "elevenlabs" if speech.tts_configured() else None},
    }


async def read_image(src: str) -> bytes:
    if src.startswith("data:image/"):
        try:
            return base64.b64decode(src.split(",", 1)[1], validate=False)
        except (IndexError, ValueError) as e:
            raise HTTPException(422, "The image couldn't be read.") from e
    if not src.startswith(("http://", "https://")):
        raise HTTPException(422, "Send an image URL or a data URI.")
    async with httpx.AsyncClient(timeout=httpx.Timeout(20.0, connect=5.0), follow_redirects=True) as http:
        try:
            res = await http.get(src)
        except httpx.HTTPError as e:
            raise HTTPException(422, "That image URL couldn't be loaded.") from e
    if res.status_code != 200 or len(res.content) > tryon.MAX_IMAGE_BYTES:
        raise HTTPException(422, "That image URL couldn't be loaded.")
    return res.content


# ---------- routes ----------
@app.get("/health")
async def health():
    out: dict[str, Any] = {"status": "ok", "provider": settings.agent_provider, "embedder": search.embedder().name}
    try:
        out["index_size"] = await search.index_size()
        out["db"] = "ok"
    except Exception as e:
        out.update(db=f"error: {e.__class__.__name__}", status="degraded")
    try:
        await get_redis().ping()
        out["redis"] = "ok"
    except Exception as e:
        out.update(redis=f"error: {e.__class__.__name__}", status="degraded")
    out["catalog_size"] = len(catalog.products)
    out["voice"] = "livekit" if voice.livekit_configured() else "browser"
    out["capabilities"] = capabilities()
    return JSONResponse(out, status_code=200 if out["status"] == "ok" else 503)


@app.get("/capabilities")
async def capabilities_route():
    return capabilities()


@app.get("/culture/moments")
async def culture_moments(tz: str | None = Query(None, max_length=64), locale: str | None = Query(None, max_length=35), days: int = Query(75, ge=1, le=120)):
    """The shopper's own festivals coming up (Eid, Puja, Pohela Boishakh…), for the storefront's festival
    banner and "order by" dates. Global sale days are left out: they're not the shopper's own occasions."""
    zone = culture.valid_zone(tz)
    country = culture.region_of(culture.valid_tag(locale), zone)
    today = culture.local_now(zone).date()
    found = [m for m in culture.moments(country, today, days) if m["local"]]
    return {
        "country": country,
        "today": today.isoformat(),
        "moments": [
            {"name": m["name"], "start": m["start"].isoformat(), "end": m["end"].isoformat(), "daysAway": m["days_away"], "angle": m["angle"]}
            for m in found
        ],
    }


@app.get("/usage")
async def usage_route(days: int = Query(7, ge=1, le=40), x_internal_key: str | None = Header(default=None)):
    """Paid AI usage and estimated spend per UTC day, newest first, with today's caps (0 = none)."""
    require_internal(x_internal_key)
    return {
        "days": await usage.today(days),
        "budgets": {"claude": settings.claude_daily_budget, "fashn": settings.tryon_daily_budget, "voice": settings.voice_daily_budget},
        "models": {"agent": settings.agent_model, "admin": settings.admin_ai_model or settings.agent_model},
    }


@app.post("/index/rebuild")
async def rebuild(x_internal_key: str | None = Header(default=None)):
    if not settings.internal_api_key or x_internal_key != settings.internal_api_key:
        raise HTTPException(401, "Invalid or missing X-Internal-Key")
    n = await search.rebuild_index(catalog)
    return {"indexed": n, "embedder": search.embedder().name}


@app.get("/search", response_model=SearchResponse)
async def search_route(q: str = Query(min_length=1, max_length=200), limit: int = Query(8, ge=1, le=50)):
    return await search.cached_search(q, limit)


@app.post("/agent/chat", response_model=AgentReply, response_model_exclude_none=True)
async def chat_route(body: ChatRequest, x_internal_key: str | None = Header(default=None)):
    # A user id (and a guest's network hash) is only trusted from the API gateway; otherwise the shopper is anonymous.
    trusted = internal_ok(x_internal_key)
    user_id, client = (body.user_id, body.client) if trusted else (None, None)
    return await agent.chat(provider(), body.message, body.session_id, user_id, ctx_dict(body.context), catalog, body.kind, client)


@app.get("/agent/preview", response_model=PreviewResponse)
async def preview_route(q: str = Query("", max_length=300)):
    return {"products": provider().preview(q)}


@app.post("/tryon/render")
async def tryon_render(body: RenderRequest, x_internal_key: str | None = Header(default=None)):
    """The shopper's photo, re-rendered wearing the look. Gateway-only: every render is billed."""
    require_internal(x_internal_key)
    if not tryon.configured():
        raise HTTPException(503, "AI try-on isn't configured.")
    person = body.photo if body.photo is not None else (tryon.SAMPLE_MODELS[body.sample] if body.sample is not None else None)
    if not person or not (person.startswith("data:image/") or person.startswith("https://")):
        raise HTTPException(422, "Send the shopper's photo, or pick a sample model.")
    items = []
    for it in body.items:
        p = catalog.get(it.id) if it.id is not None else None
        if it.id is not None and not (p and p.get("tryOnSlot")):
            raise HTTPException(422, f"Product {it.id} can't be tried on.")
        image = it.image or (p and (p.get("tryOnImage") or p["image"]))
        slot = it.slot or (p and p["tryOnSlot"])
        if not image or slot not in tryon.LAYER_ORDER:
            raise HTTPException(422, "Each item needs a product or an image and a try-on slot.")
        styling = it.styling if it.styling is not None else (p and (p.get("tryOnInfo") or {}).get("styling"))
        name = it.name or (p and p["name"])
        items.append({"key": p["id"] if p else hashlib.sha1(image.encode()).hexdigest(), "image": image, "slot": slot, "name": name, "styling": styling, "notes": it.notes})
    sample = body.photo is None
    try:
        return await tryon.render(
            body.user_id, person, items, body.seed,
            cache_scope="sample" if sample else None, cache_ttl=settings.tryon_sample_cache_ttl if sample else None,
        )
    except tryon.TryOnError as e:
        return JSONResponse(status_code=e.status, content={"error": e.code, "message": str(e)})


@app.post("/tryon/check")
async def tryon_check(body: CheckRequest, x_internal_key: str | None = Header(default=None)):
    """How well will this product photo work for AI try-on? (Used by the admin panel.)"""
    require_internal(x_internal_key)
    if body.slot not in tryon.LAYER_ORDER:
        raise HTTPException(422, "Unknown try-on slot.")
    data = await read_image(body.image if body.image.startswith("data:") else tryon.best_source(body.image))
    return await garment_check.check(data, body.slot, body.name, body.colors, use_ai=body.ai)


@app.post("/tryon/cutout")
async def tryon_cutout(body: CutoutRequest, x_internal_key: str | None = Header(default=None)):
    """The item on a transparent background, for the storefront's quick preview of accessories."""
    require_internal(x_internal_key)
    data = await read_image(body.image if body.image.startswith("data:") else tryon.best_source(body.image))
    try:
        if settings.cutout_provider == "meta" and meta.configured():
            img = await asyncio.to_thread(cutout.prepare, data, body.crop)
            noun = meta.SLOT_NOUN.get(body.slot or "", "the product")
            try:
                alpha = await meta.sam_mask(meta.png_bytes(img), img.width, img.height, noun)
            except meta.MetaError as e:
                return JSONResponse(status_code=e.status, content={"error": "cutout_unavailable", "message": str(e)})
            await usage.meta_segment()
            png = await asyncio.to_thread(cutout.compose, img, alpha)
        else:
            png = await asyncio.to_thread(cutout.cut_out, data, body.crop)
    except cutout.CutoutUnavailable as e:
        log.warning("Cut-out unavailable: %s", e)
        return JSONResponse(status_code=503, content={"error": "cutout_unavailable", "message": "Cut-outs aren't available right now."})
    except ValueError as e:
        raise HTTPException(422, str(e)) from e
    return {"image": "data:image/png;base64," + base64.b64encode(png).decode()}


@app.post("/catalog/suggest")
async def catalog_suggest(body: SuggestRequest, x_internal_key: str | None = Header(default=None)):
    """Drafts the product details Pip needs (admin panel), from the photo and the text so far."""
    require_internal(x_internal_key)
    image = None
    if body.image:
        image = await read_image(body.image if body.image.startswith("data:") else tryon.best_source(body.image))
    try:
        return await product_details.suggest(body.model_dump(exclude={"image"}), image)
    except (product_details.Unavailable, usage.OverBudget, anthropic.APIError) as e:  # APIError: Claude timed out or failed
        message = (
            str(e) if isinstance(e, product_details.Unavailable)
            else "Today's AI budget is spent." if isinstance(e, usage.OverBudget)
            else "The AI couldn't draft the details just now. Try again in a moment."
        )
        return JSONResponse(status_code=503, content={"error": "suggest_unavailable", "message": message})


@app.post("/speech/transcribe")
async def speech_transcribe(
    file: UploadFile = File(...),
    language: str | None = Form(default=None, max_length=10),
    x_internal_key: str | None = Header(default=None),
):
    """Speech in any language to text, with the language it was spoken in."""
    require_internal(x_internal_key)
    audio = await file.read()
    if not audio or len(audio) > 8 * 1024 * 1024:
        raise HTTPException(422, "Send a recording of up to 8 MB.")
    try:
        return await speech.transcribe(audio, file.filename or "speech.webm", file.content_type or "audio/webm", language)
    except speech.SpeechError as e:
        return JSONResponse(status_code=e.status, content={"error": "speech_failed", "message": str(e)})


@app.post("/speech/speak")
async def speech_speak(body: SpeakRequest, x_internal_key: str | None = Header(default=None)):
    """Pip's voice (MP3), in the reply's language."""
    require_internal(x_internal_key)
    try:
        audio = await speech.synthesize(body.text, body.lang)
    except speech.SpeechError as e:
        return JSONResponse(status_code=e.status, content={"error": "speech_failed", "message": str(e)})
    return Response(content=audio, media_type="audio/mpeg", headers={"Cache-Control": "no-store"})


@app.post("/voice/token", response_model=VoiceTokenResponse)
async def voice_token(body: VoiceTokenRequest, x_internal_key: str | None = Header(default=None)):
    # Minting tokens for arbitrary identities is gateway-only (the API passes the signed-in user).
    if not internal_ok(x_internal_key):
        raise HTTPException(401, "Invalid or missing X-Internal-Key")
    try:
        return voice.create_token(body.identity, body.room)
    except voice.VoiceNotConfigured:
        return JSONResponse(
            status_code=503,
            content={
                "error": "voice_not_configured",
                "message": "LiveKit is not configured (set LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET). "
                "Until then, voice runs through the chat: speech is transcribed in the browser (or by "
                "/speech/transcribe), sent as chat messages, and replies are spoken in the browser (or by /speech/speak).",
                "fallback": {"transport": "http", "path": "/agent/chat"},
            },
        )


@app.websocket("/agent/ws")
async def agent_ws(ws: WebSocket, session_id: str | None = None, token: str | None = None):
    # The storefront doesn't use it and no gateway throttle stands in front of it: off unless AGENT_WS_ENABLED.
    if not settings.agent_ws_enabled:
        await ws.accept()
        await ws.close(code=4403, reason="The WebSocket chat is switched off.")
        return
    # The browser passes its API access token; an invalid or missing token means an anonymous session.
    user_id = user_from_token(token)
    await ws.accept()
    sid = session_id or agent.new_session_id()
    await ws.send_json({"type": "session", "session_id": sid})
    pending: asyncio.Task | None = None
    lock = asyncio.Lock()

    async def send(msg: dict) -> None:
        async with lock:
            await ws.send_json(msg)

    async def suggest(text: str) -> None:
        await asyncio.sleep(0.15)  # debounce interim transcripts
        await send({"type": "suggestions", "products": provider().preview(text), "text": text})

    try:
        while True:
            try:
                msg = await ws.receive_json()
            except (ValueError, KeyError):
                await send({"type": "error", "error": "invalid_json"})
                continue
            kind = msg.get("type") if isinstance(msg, dict) else None
            if kind == "ping":
                await send({"type": "pong"})
            elif kind == "partial":
                if pending and not pending.done():
                    pending.cancel()
                pending = asyncio.create_task(suggest(str(msg.get("text", ""))[:300]))
            elif kind == "message":
                if pending and not pending.done():
                    pending.cancel()
                text = str(msg.get("text", "")).strip()[:1000]
                if not text:
                    await send({"type": "error", "error": "empty_message"})
                    continue
                await send({"type": "status", "status": "thinking"})
                try:
                    client_ctx = ClientContext.model_validate(msg.get("context") or {})
                except ValueError:
                    client_ctx = ClientContext()
                reply = await agent.chat(provider(), text, sid, user_id, ctx_dict(client_ctx), catalog)
                event = {"type": "reply", **reply}
                await send(event)
                await agent.publish(sid, event)
            else:
                await send({"type": "error", "error": "unknown_type"})
    except WebSocketDisconnect:
        pass
    finally:
        if pending and not pending.done():
            pending.cancel()
