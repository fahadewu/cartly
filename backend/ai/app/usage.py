"""What the paid AI features used today, what that cost, and the daily cap on each.

Every paid call (Claude, FASHN, ElevenLabs) adds its usage and an estimated cost to one Redis hash per
UTC day, shared by every AI replica. The admin panel shows it (GET /usage), and each feature checks its
cap before spending: past it, Pip answers with the rule brain, try-on falls back to the on-device
preview and voice to the browser's own. The same hash counts the paid calls a cache or a free path
answered instead (saved:*) and Pip's own decisions (gate:*, pip:*). Metering never breaks the feature
it measures.
"""
import logging
import re
import time

from . import redis_client
from .config import settings

log = logging.getLogger("cartly.usage")

# USD per million tokens: input, output, cache read, cache write (5-minute TTL; a 1-hour write costs 2x input).
# Anthropic list prices, 2026-09. Opus 5 and Opus 4.8 are where the refusal fallback may answer instead
# (Sonnet 5 for Sonnet 5.5).
CLAUDE_PRICES = {
    "claude-opus-5-5": (4.0, 20.0, 0.20, 5.0),
    "claude-sonnet-5-5": (2.0, 10.0, 0.20, 2.5),
    "claude-haiku-5-5": (0.10, 0.50, 0.01, 0.125),  # prompts up to 100K tokens (Pip's are ~10K)
    "claude-haiku-4-5": (1.0, 5.0, 0.10, 1.25),
    "claude-opus-5": (5.0, 25.0, 0.50, 6.25),
    "claude-opus-4-8": (5.0, 25.0, 0.50, 6.25),
    "claude-sonnet-5": (2.0, 10.0, 0.20, 2.5),
    # Meta Model API (dev.meta.ai/docs/pricing-rate-limits, 2026-11): prefix caching is automatic, writes at the
    # input price. The Contributor tier is cheaper because Meta may train on what's sent: not for shoppers' chats.
    "muse-spark-1.3": (1.25, 4.25, 0.15, 1.25),
    "muse-spark-1.2": (1.25, 4.25, 0.15, 1.25),
    "muse-spark-1.1": (1.25, 4.25, 0.15, 1.25),
    "muse-spark-1.3-contributor": (0.10, 0.20, 0.002, 0.10),
    "muse-spark-1.2-contributor": (0.10, 0.20, 0.002, 0.10),
}
WEB_SEARCH_USD = 0.01
# Where a chat turn came from (the storefront's context.origin); anything else counts as "other", so the
# hash keeps a fixed set of fields.
ORIGINS = {"typed", "voice", "chip", "card", "greet", "other"}
STOP_REASON = re.compile(r"^[a-z_]{1,32}$")
# FASHN Try-On Max credits per render, by generation mode and resolution.
FASHN_CREDITS = {"fast": {"1k": 1, "2k": 2, "4k": 3}, "balanced": {"1k": 2, "2k": 3, "4k": 4}, "quality": {"1k": 3, "2k": 4, "4k": 5}}
KEEP_DAYS = 40
CAPS = {"claude": "claude_daily_budget", "fashn": "tryon_daily_budget", "voice": "voice_daily_budget"}


class OverBudget(Exception):
    """Today's cap for this feature is spent."""


def get_redis():
    """The state Redis, looked up on every call (tests swap it here or in redis_client)."""
    return redis_client.get_redis()


def day_key(ts: float | None = None) -> str:
    return "usage:" + time.strftime("%Y%m%d", time.gmtime(ts))


async def _add(fields: dict[str, float]) -> None:
    try:
        pipe = get_redis().pipeline()
        key = day_key()
        for field, n in fields.items():
            if n:
                pipe.hincrbyfloat(key, field, n)
        pipe.expire(key, KEEP_DAYS * 86400)
        await pipe.execute()
    except Exception as e:
        log.warning("Usage not recorded: %s", e)


def _writes(u) -> tuple[int, int]:
    """Cache writes by TTL: (1-hour, 5-minute). Without the breakdown, every write counts as 5-minute."""
    total = getattr(u, "cache_creation_input_tokens", 0) or 0
    split = getattr(u, "cache_creation", None)
    if split is None:
        return 0, total
    hour = getattr(split, "ephemeral_1h_input_tokens", 0) or 0
    five = getattr(split, "ephemeral_5m_input_tokens", None)
    return hour, five if five is not None else max(0, total - hour)


def base_model(model: str | None) -> str:
    """A model id without its snapshot date: an alias ("claude-haiku-4-5") is answered by a dated snapshot
    ("claude-haiku-4-5-20251001"), and both are the same model and price."""
    return re.sub(r"-\d{8}$", "", model or "")


def claude_cost(model: str, u) -> float:
    """Estimated USD for one usage record: a response's, or one attempt's from usage.iterations."""
    if base_model(model).endswith(":free"):  # OpenRouter's free models
        return 0.0
    price_in, price_out, price_read, price_write = CLAUDE_PRICES.get(base_model(model), CLAUDE_PRICES["claude-opus-5-5"])
    tokens = lambda name: getattr(u, name, 0) or 0  # noqa: E731
    hour, five = _writes(u)
    searches = getattr(getattr(u, "server_tool_use", None), "web_search_requests", 0) or 0
    return (
        tokens("input_tokens") * price_in + tokens("output_tokens") * price_out
        + tokens("cache_read_input_tokens") * price_read + five * price_write + hour * 2 * price_in
    ) / 1e6 + searches * WEB_SEARCH_USD


def _attempts(message, model: str) -> list[tuple[str, object]]:
    """(model, usage) for every billed attempt. A response with several usage.iterations (a declined attempt
    that the refusal fallback answered on another model, for instance) itemises them there, and its top-level
    usage covers only the attempt that answered. An entry without a model ran on the requested one, except the
    fallback's own entry, which ran on the model that answered."""
    u = message.usage
    served = getattr(message, "model", None) or model
    entries = list(getattr(u, "iterations", None) or [])
    if len(entries) <= 1:  # one attempt: the top-level usage is that attempt, with its cache-write breakdown
        return [(served, u)]
    return [
        (getattr(e, "model", None) or (served if getattr(e, "type", "") == "fallback_message" else model), e)
        for e in entries
    ]


async def claude(feature: str, model: str, message, origin: str | None = None) -> float:
    """One Messages API response; returns its estimated cost. `feature`: chat, greet, photo-check or
    product-suggest. `origin`: where a chat turn came from (typed, voice, chip, card or greet)."""
    u = getattr(message, "usage", None)
    if u is None:
        return 0.0
    attempts = _attempts(message, model)
    entries = list(getattr(u, "iterations", None) or [])
    searches = getattr(getattr(u, "server_tool_use", None), "web_search_requests", 0) or 0
    cost = sum(claude_cost(m, a) for m, a in attempts)
    if attempts[0][1] is not u:  # itemised attempts carry no web-search count; the response's own does
        cost += searches * WEB_SEARCH_USD
    tokens = lambda name: sum(getattr(a, name, 0) or 0 for _, a in attempts)  # noqa: E731
    stop = str(getattr(message, "stop_reason", None) or "none")
    fields = {
        "claude:cost": cost, "claude:calls": 1,
        f"claude:{feature}:cost": cost, f"claude:{feature}:calls": 1,
        "claude:input": tokens("input_tokens"), "claude:output": tokens("output_tokens"),
        "claude:cache_read": tokens("cache_read_input_tokens"), "claude:cache_write": tokens("cache_creation_input_tokens"),
        "claude:cache_write_1h": sum(_writes(a)[0] for _, a in attempts),
        # Already inside output_tokens (and the cost); counted apart to show what thinking takes.
        "claude:thinking": getattr(getattr(u, "output_tokens_details", None), "thinking_tokens", 0) or 0,
        "claude:searches": searches,
        f"claude:stop:{stop if STOP_REASON.match(stop) else 'other'}": 1,
        "claude:fallbacks": int(any(getattr(e, "type", "") == "fallback_message" for e in entries)),
    }
    if origin is not None:
        where = origin if origin in ORIGINS else "other"
        fields[f"claude:origin:{where}:calls"] = 1
        fields[f"claude:origin:{where}:cost"] = cost
    await _add(fields)
    return cost


async def fashn_render() -> None:
    credits = FASHN_CREDITS.get(settings.tryon_mode, FASHN_CREDITS["balanced"]).get(settings.tryon_resolution, 2)
    await _add({"fashn:renders": 1, "fashn:credits": credits, "fashn:cost": credits * settings.fashn_usd_per_credit})


async def tts(chars: int) -> None:
    cost = chars / 1000 * settings.tts_usd_per_1k_chars
    await _add({"voice:cost": cost, "tts:calls": 1, "tts:chars": chars, "tts:cost": cost})


async def meta_image_render() -> None:
    """A Muse Image try-on step (TRYON_PROVIDER=meta). Counted as try-on spend ("fashn" is the try-on cap's key)."""
    cost = settings.meta_image_usd
    await _add({"metaimage:renders": 1, "metaimage:cost": cost, "fashn:cost": cost})


async def meta_segment() -> None:
    """A SAM 3.1 cut-out (CUTOUT_PROVIDER=meta), counted with try-on spend."""
    cost = settings.meta_sam_usd_per_image
    await _add({"metasam:calls": 1, "metasam:cost": cost, "fashn:cost": cost})


async def stt(seconds: float, vendor: str = "elevenlabs") -> None:
    rate = settings.meta_stt_usd_per_hour if vendor == "meta" else settings.stt_usd_per_hour
    cost = seconds / 3600 * rate
    await _add({"voice:cost": cost, "stt:calls": 1, "stt:seconds": seconds, "stt:cost": cost})


async def saved(what: str, n: int = 1) -> None:
    """A paid call a cache or a free path answered instead: greet, greet_personal, reply (Pip's caches),
    gate and closer (template replies), card (card buttons the storefront handled itself), tryon_step, tts."""
    await _add({f"saved:{what}": n})


async def count(name: str, n: float = 1) -> None:
    """One of Pip's own decisions, for the admin panel: gate:<kind>, pip:strikes, pip:cooldown, pip:quota..."""
    await _add({name: n})


async def spent(vendor: str) -> float:
    """Today's metered spend on a vendor, in USD (0 when Redis can't say)."""
    try:
        return float(await get_redis().hget(day_key(), f"{vendor}:cost") or 0)
    except Exception:
        return 0.0


async def over_budget(vendor: str) -> bool:
    cap = getattr(settings, CAPS[vendor])
    if cap <= 0:
        return False
    spent_today = await spent(vendor)
    if spent_today >= cap:
        log.warning("%s daily budget ($%.2f) reached: $%.2f spent", vendor, cap, spent_today)
        return True
    return False


async def check(vendor: str) -> None:
    if await over_budget(vendor):
        raise OverBudget(vendor)


async def today(days: int = 1) -> list[dict]:
    """The last `days` days of usage, newest first: [{day, fields...}]."""
    out = []
    now = time.time()
    for i in range(days):
        key = day_key(now - i * 86400)
        raw = await get_redis().hgetall(key)
        out.append({"day": key.split(":")[1], **{k: round(float(v), 4) for k, v in sorted(raw.items())}})
    return out
