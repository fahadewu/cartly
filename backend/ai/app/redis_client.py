"""Shared async Redis clients.

`get_redis()` holds state that must not be lost: carts (written by the API), Pip's session memory,
quotas and the usage meter. `get_cache()` holds what can be rebuilt (try-on renders, voice clips,
greetings, trend and search results): point CACHE_REDIS_URL at a Redis with a memory cap and
`maxmemory-policy allkeys-lru` so a busy day evicts old renders instead of failing cart writes.
Without it, both use REDIS_URL."""
import redis.asyncio as aioredis

from .config import settings

_client: aioredis.Redis | None = None
_cache: aioredis.Redis | None = None

# A stalled Redis must fail fast: a chat turn has 45 s at the API gateway in all, and the fallback
# brain can only answer if the Redis calls around the Claude call give up well inside that.
_TIMEOUTS = {"socket_connect_timeout": 2.0, "socket_timeout": 3.0}


def get_redis() -> aioredis.Redis:
    global _client
    if _client is None:
        _client = aioredis.from_url(settings.redis_url, decode_responses=True, **_TIMEOUTS)
    return _client


def get_cache() -> aioredis.Redis:
    global _cache
    if not settings.cache_redis_url:
        return get_redis()
    if _cache is None:
        _cache = aioredis.from_url(settings.cache_redis_url, decode_responses=True, **_TIMEOUTS)
    return _cache


async def close_redis() -> None:
    global _client, _cache
    for c in (_client, _cache):
        if c is not None:
            await c.aclose()
    _client = _cache = None
