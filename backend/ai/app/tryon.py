"""Generative virtual try-on: the shopper's photo is re-rendered wearing the items
(FASHN Try-On Max), rather than a product cut-out laid on top of it.

A look is built one item at a time, innermost layer first (bottoms, dress, top,
outerwear, shoes, then accessories). Every step's result is cached, so adding a
fourth item to a three-item look costs one render and taking the last one off
costs none. Photos are sent as base64 (FASHN deletes base64 inputs when the
request finishes) and results come back as base64; nothing is stored on disk.

Looks on the sample models aren't anyone's photo and come out the same for every
shopper, so they share one cache (kept for days): each is paid for once. Two requests
for the same step at the same time render it once; the second waits for the first.
"""
import asyncio
import base64
import hashlib
import ipaddress
import json
import logging
import time
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

import httpx

from . import meta, usage
from .config import settings
from .redis_client import get_cache, get_redis

log = logging.getLogger("cartly.tryon")
MAX_IMAGE_BYTES = 15 * 1024 * 1024

LAYER_ORDER = {"bottom": 1, "dress": 2, "top": 3, "outer": 4, "feet": 5, "hand": 6, "wrist": 7, "eyes": 8, "ears": 9, "head": 10}
# Accessories get a short hint so the model knows exactly where the item goes.
SLOT_HINT = {
    "feet": "wearing these shoes",
    "eyes": "wearing these glasses",
    "head": "wearing this hat",
    "ears": "wearing these headphones on the head, over the ears",
    "wrist": "wearing this watch on the wrist",
    "hand": "carrying this bag naturally",
    "outer": "wearing this over the current outfit",
}
# Sample models for shoppers without a photo, and for admin previews (same photos as the storefront).
# Full body, facing the camera, fitted clothes, plain studio backdrop, as FASHN recommends.
SAMPLE_MODELS = [
    "https://images.unsplash.com/photo-1683126257977-5142e52acc7e?w=1100&q=85&auto=format",
    "https://images.unsplash.com/photo-1666358085605-b3b717d5a210?w=1100&q=85&auto=format",
    "https://images.unsplash.com/photo-1650003775377-81b873410f64?w=1100&q=85&auto=format",
    "https://images.unsplash.com/photo-1666358777243-320bf3632bc3?w=1100&q=85&auto=format",
]


class TryOnError(Exception):
    def __init__(self, message: str, status: int = 502, code: str = "tryon_failed"):
        super().__init__(message)
        self.status = status
        self.code = code


def vendor() -> str | None:
    """Who renders: Muse Image when TRYON_PROVIDER=meta and META_API_KEY is set, else FASHN with its key."""
    if settings.tryon_provider == "meta" and settings.meta_api_key:
        return "meta"
    return "fashn" if settings.fashn_api_key else None


def configured() -> bool:
    return vendor() is not None


def _public(url: str) -> bool:
    """Can FASHN fetch this URL itself? (Not for localhost, private addresses or plain http.)"""
    u = urlparse(url)
    if u.scheme != "https" or not u.hostname:
        return False
    host = u.hostname
    if host == "localhost" or host.endswith((".local", ".internal")):
        return False
    try:
        return ipaddress.ip_address(host).is_global
    except ValueError:
        return True


def best_source(url: str) -> str:
    """The largest useful version of a catalog photo: storefront thumbnails lose the detail
    (prints, stitching, logos) the try-on needs to copy the product faithfully."""
    u = urlparse(url)
    if u.hostname == "images.unsplash.com":
        q = dict(parse_qsl(u.query))
        q.pop("fit", None), q.pop("h", None), q.pop("crop", None)
        q.update(w="1600", q="90", auto="format")
        return urlunparse(u._replace(query=urlencode(q)))
    return url


async def image_input(src: str, http: httpx.AsyncClient) -> str:
    """A URL FASHN can fetch, or a base64 data URI of the image."""
    if src.startswith("data:image/"):
        return src
    if _public(src):
        return src
    try:
        res = await http.get(src, follow_redirects=True)
    except httpx.HTTPError as e:
        raise TryOnError("Couldn't load the product photo.", 502, "image_unavailable") from e
    ctype = res.headers.get("content-type", "").split(";")[0]
    if res.status_code != 200 or not ctype.startswith("image/") or len(res.content) > MAX_IMAGE_BYTES:
        raise TryOnError("Couldn't load the product photo.", 502, "image_unavailable")
    return f"data:{ctype};base64,{base64.b64encode(res.content).decode()}"


def step_prompt(item: dict) -> str:
    # Naming the item tells the model which one to take from a product photo that shows several
    # (a styled shot with shoes and a bag, say), as FASHN recommends.
    name = f"only the {item['name'].strip()}" if (item.get("name") or "").strip() else ""
    parts = [name, SLOT_HINT.get(item.get("slot") or "", ""), item.get("styling") or "", item.get("notes") or ""]
    return ", ".join(p.strip().rstrip(".") for p in parts if p and p.strip())[:300]


def order(items: list[dict]) -> list[dict]:
    return sorted(items, key=lambda i: LAYER_ORDER.get(i.get("slot") or "", 99))


def _step_keys(scope: str, person: str, items: list[dict], seed: int) -> list[str]:
    base = hashlib.sha256(person.encode()).hexdigest()[:32]
    keys, chain = [], []
    for item in items:
        # The photo too: when an admin replaces a product's try-on photo, earlier renders no longer apply.
        chain.append({"k": item["key"], "i": item["image"], "p": step_prompt(item)})
        digest = hashlib.sha1(
            json.dumps([chain, seed, settings.tryon_mode, settings.tryon_resolution], sort_keys=True).encode()
        ).hexdigest()
        keys.append(f"tryon:{scope}:{base}:{digest}")
    return keys


async def _quota(scope: str, needed: int) -> None:
    if needed <= 0 or settings.tryon_hourly_limit <= 0:
        return
    r = get_redis()
    key = f"tryon:quota:{scope}:{time.strftime('%Y%m%d%H', time.gmtime())}"
    used = int(await r.get(key) or 0)
    if used + needed > settings.tryon_hourly_limit:
        raise TryOnError(
            "You've created a lot of looks this hour. Take a breather and try again a little later.", 429, "tryon_quota"
        )
    pipe = r.pipeline()
    pipe.incrby(key, needed)
    pipe.expire(key, 3700)
    await pipe.execute()


FAILED = {
    "ContentModerationError": ("That photo can't be used for try-on. Please try a different one.", 422),
    "ImageLoadError": ("I couldn't read that photo. Try a JPG or PNG.", 422),
    "InputValidationError": ("That photo can't be used for try-on. Try a clear, full-length photo.", 422),
    "PoseError": ("I couldn't find a person in the photo. Try a clear, full-length photo.", 422),
}
RETRYABLE = {"ThirdPartyError", "UnavailableError", "PipelineError"}


# The API gateway waits 180 s for a render. Everything here stops before that, so no step is submitted
# (and paid for) after the shopper has already been told to try again; finished steps are cached, so a
# retry picks up where this one stopped.
RENDER_BUDGET = 150.0


async def _run_step(http: httpx.AsyncClient, model_image: str, product_image: str, prompt: str, seed: int, until: float | None = None) -> str:
    inputs = {
        "model_image": model_image,
        "product_image": product_image,
        "prompt": prompt,
        "resolution": settings.tryon_resolution,
        "generation_mode": settings.tryon_mode,
        "seed": seed,
        "num_images": 1,
        "output_format": "jpeg",
        "return_base64": True,
    }
    headers = {"Authorization": f"Bearer {settings.fashn_api_key}"}
    for attempt in range(2):
        try:
            res = await http.post(f"{settings.fashn_base_url}/run", headers=headers, json={"model_name": "tryon-max", "inputs": inputs})
        except httpx.HTTPError as e:
            raise TryOnError("The try-on service isn't reachable right now.", 503, "tryon_unavailable") from e
        if res.status_code != 200:
            err = (res.json() if res.headers.get("content-type", "").startswith("application/json") else {}).get("error")
            log.warning("FASHN run %s: %s", res.status_code, err)
            if err == "OutOfCredits" or res.status_code == 401:
                raise TryOnError("AI try-on is unavailable right now.", 503, "tryon_unavailable")
            if res.status_code == 429:
                raise TryOnError("The fitting room is busy. Try again in a moment.", 429, "tryon_busy")
            raise TryOnError("The try-on service had a problem.", 502)
        job = res.json()["id"]
        deadline = min(time.monotonic() + 150, until or float("inf"))
        while True:
            await asyncio.sleep(1.5)
            try:
                s = (await http.get(f"{settings.fashn_base_url}/status/{job}", headers=headers)).json()
            except (httpx.HTTPError, ValueError):
                s = {"status": "processing"}  # transient; keep polling until the deadline
            if s.get("status") == "completed" and s.get("output"):
                return s["output"][0]
            if s.get("status") in ("starting", "in_queue", "processing"):
                if time.monotonic() > deadline:
                    raise TryOnError("That took too long. Please try again.", 504, "tryon_timeout")
                continue
            name = (s.get("error") or {}).get("name")
            log.warning("FASHN job %s failed: %s", job, s.get("error"))
            if name in FAILED:
                msg, status = FAILED[name]
                raise TryOnError(msg, status, name)
            if name in RETRYABLE and attempt == 0:
                break  # submit once more
            raise TryOnError("The try-on service had a problem.", 502)
    raise TryOnError("The try-on service had a problem.", 502)


async def _claim(r, key: str) -> bool:
    """True if this request should render the step; False if another one already is."""
    try:
        return bool(await r.set(f"{key}:lock", "1", ex=180, nx=True))
    except Exception:
        return True


async def _wait_for(r, key: str, seconds: float = 170, until: float | None = None) -> str | None:
    """The step another request is rendering, once it's done (None if it failed or took too long)."""
    deadline = min(time.monotonic() + seconds, until or float("inf"))
    while time.monotonic() < deadline:
        await asyncio.sleep(1.5)
        hit = await r.get(key)
        if hit:
            return hit
        if not await r.get(f"{key}:lock"):
            return await r.get(key)
    return None


async def render(
    scope: str, person: str, items: list[dict], seed: int = 42, http: httpx.AsyncClient | None = None,
    cache_scope: str | None = None, cache_ttl: int | None = None,
) -> dict:
    """Dress `person` (a data URI or image URL) in `items` ([{key, image, slot, styling?, notes?}]).

    `scope` (the shopper's id) keeps the hourly quota per shopper, and the cached results too unless
    `cache_scope` shares them (sample models). Returns {image, steps, rendered, cached}.
    """
    if not configured():
        raise TryOnError("AI try-on isn't configured.", 503, "tryon_unavailable")
    items = order(items)
    keys = _step_keys(cache_scope or scope, person, items, seed)
    r = get_cache()
    cached = await r.mget(keys) if keys else []
    start = next((i + 1 for i in range(len(keys) - 1, -1, -1) if cached[i]), 0)
    current = cached[start - 1] if start else person
    if start:
        await usage.saved("tryon_step", start)
    if start == len(items):
        return {"image": current, "steps": len(items), "rendered": 0, "cached": start}
    if await usage.over_budget("fashn"):
        raise TryOnError("AI try-on is resting for today. Try again tomorrow!", 503, "tryon_unavailable")
    await _quota(scope, len(items) - start)

    own = http is None
    http = http or httpx.AsyncClient(timeout=httpx.Timeout(60.0, connect=10.0))
    rendered = 0
    until = time.monotonic() + RENDER_BUDGET
    try:
        if not start:
            current = await image_input(person, http)
        for i in range(start, len(items)):
            # Never start a step the gateway has already given up waiting for.
            if time.monotonic() + 20 > until:
                raise TryOnError("That took too long. Please try again.", 504, "tryon_timeout")
            if not await _claim(r, keys[i]):
                done = await _wait_for(r, keys[i], until=until)
                if done:
                    current = done
                    await usage.saved("tryon_step")
                    continue
            try:
                product = await image_input(best_source(items[i]["image"]), http)
                if vendor() == "meta":
                    try:
                        current = await meta.tryon_step(http, current, product, items[i])
                    except meta.MetaError as e:
                        raise TryOnError(str(e), e.status, "tryon_unavailable" if e.status == 503 else "tryon_failed") from e
                    rendered += 1
                    await usage.meta_image_render()
                else:
                    current = await _run_step(http, current, product, step_prompt(items[i]), seed, until=until)
                    rendered += 1
                    await usage.fashn_render()
                await r.set(keys[i], current, ex=cache_ttl or settings.tryon_cache_ttl)
            finally:
                await r.delete(f"{keys[i]}:lock")
    finally:
        if own:
            await http.aclose()
    return {"image": current, "steps": len(items), "rendered": rendered, "cached": len(items) - rendered}
