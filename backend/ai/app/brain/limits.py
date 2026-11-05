"""Per-shopper limits on Pip's Claude turns (backend/SCALING.md, "AI spend").

Strikes are off-topic turns: enforced gate declines, injection attempts and Claude's own offTopic flag.
After PIP_STRIKES of them within PIP_STRIKE_WINDOW seconds, messages with nothing about shopping get a
template for PIP_COOLDOWN seconds. Daily turns are Claude turns per UTC day: past a quota (or, for guests,
once today's spend nears CLAUDE_DAILY_BUDGET_USD) Pip answers in quick mode, without Claude.

Who the shopper is: their account when signed in; a guest is their session and, when the API gateway
passed one, their network (a hashed IP, so a script that drops its session id still counts as one).
Strikes count on the account, else on the guest's own chat: one IP is often thousands of shoppers
(mobile carrier NAT, office Wi-Fi), so a stranger's off-topic turns never cool down anyone else.
Quotas count on the account, or on both the guest's session and network (the network quota is what
bounds a script that drops its session id). The counters live on the state Redis (quotas must not be
evicted with the caches) and a failure there never stops a turn.
"""
import logging
import time
from dataclasses import dataclass

from .. import redis_client, usage
from ..config import settings

log = logging.getLogger("cartly.limits")

TURNS_TTL = 2 * 86400  # a day's counter outlives its UTC day


@dataclass(frozen=True)
class Standing:
    """Where the shopper stands before a Claude turn."""

    strikes: int = 0
    over_quota: bool = False
    soft_capped: bool = False

    @property
    def cooling_down(self) -> bool:
        return settings.pip_strikes > 0 and settings.pip_cooldown > 0 and self.strikes >= settings.pip_strikes


def identities(ctx: dict) -> tuple[str | None, list[tuple[str, int]]]:
    """(who strikes count against, [(who a daily quota counts against, its limit)]) for this shopper."""
    if ctx.get("userId"):
        account = f"u:{ctx['userId']}"
        return account, [(account, settings.pip_daily_turns_account)]
    session = f"s:{ctx['sessionId']}" if ctx.get("sessionId") else None
    network = f"g:{ctx['client']}" if ctx.get("client") else None
    quotas = [(who, n) for who, n in ((session, settings.pip_daily_turns_session), (network, settings.pip_daily_turns_guest_ip)) if who]
    return session, quotas  # never the network: its strangers would share one cooldown


def strike_key(who: str) -> str:
    return f"pip:strikes:{who}"


def turns_key(who: str, ts: float | None = None) -> str:
    return f"pip:turns:{who}:{time.strftime('%Y%m%d', time.gmtime(ts))}"


async def standing(ctx: dict) -> Standing:
    who, quotas = identities(ctx)
    keys = ([strike_key(who)] if who else []) + [turns_key(q) for q, _ in quotas]
    # Near the daily budget, guests with nothing in the cart give way first, so signed-in shoppers and
    # full carts keep Claude longest.
    soft = settings.claude_daily_budget > 0 and not ctx.get("userId") and not ctx.get("cart")
    try:
        values = await redis_client.get_redis().mget(keys) if keys else []
    except Exception as e:
        log.warning("Pip limits unavailable: %s", e)
        values = [None] * len(keys)
    strikes = int(values[0] or 0) if who else 0
    turns = values[1:] if who else values
    over = any(limit > 0 and int(n or 0) >= limit for (_, limit), n in zip(quotas, turns))
    capped = soft and await usage.spent("claude") >= settings.pip_soft_cap_ratio * settings.claude_daily_budget
    return Standing(strikes, over, capped)


async def strike(ctx: dict) -> int:
    """One more off-topic turn for this shopper; returns their strikes so far (0 when not counted)."""
    who, _ = identities(ctx)
    if not who or settings.pip_strikes <= 0:
        return 0
    key = strike_key(who)
    try:
        r = redis_client.get_redis()
        n = int(await r.incr(key))
        # The window runs from the first strike; reaching the limit starts the cooldown, and every strike
        # during it starts it again.
        if n >= settings.pip_strikes and settings.pip_cooldown > 0:
            await r.expire(key, settings.pip_cooldown)
        elif n == 1:
            await r.expire(key, settings.pip_strike_window)
    except Exception as e:
        log.warning("Strike not recorded: %s", e)
        return 0
    await usage.count("pip:strikes")
    return n


async def count_turn(ctx: dict) -> None:
    """One more Claude turn against this shopper's daily quotas."""
    _, quotas = identities(ctx)
    keys = [turns_key(who) for who, limit in quotas if limit > 0]
    if not keys:
        return
    try:
        pipe = redis_client.get_redis().pipeline()
        for key in keys:
            pipe.incr(key)
            pipe.expire(key, TURNS_TTL)
        await pipe.execute()
    except Exception as e:
        log.warning("Turn not counted: %s", e)
