"""Who is calling? The AI service trusts a user id only when it can prove it.

- Server-to-server (the NestJS gateway): `X-Internal-Key` header must match INTERNAL_API_KEY.
- Browser WebSocket: the user's API access token (HS256 JWT signed with JWT_SECRET).
Anything else is treated as an anonymous shopper (no cart or order context).
"""
import base64
import hashlib
import hmac
import json
import time

from .config import settings


def internal_ok(key: str | None) -> bool:
    return bool(settings.internal_api_key) and key is not None and hmac.compare_digest(key, settings.internal_api_key)


def _b64(part: str) -> bytes:
    return base64.urlsafe_b64decode(part + "=" * (-len(part) % 4))


def user_from_token(token: str | None) -> str | None:
    """Returns the user id (`sub`) from a valid, unexpired API token, else None."""
    if not token or not settings.jwt_secret:
        return None
    try:
        header_b64, payload_b64, sig_b64 = token.split(".")
        if json.loads(_b64(header_b64)).get("alg") != "HS256":
            return None
        expected = hmac.new(settings.jwt_secret.encode(), f"{header_b64}.{payload_b64}".encode(), hashlib.sha256).digest()
        if not hmac.compare_digest(expected, _b64(sig_b64)):
            return None
        payload = json.loads(_b64(payload_b64))
        if payload.get("exp") and payload["exp"] < time.time():
            return None
        return payload.get("sub")
    except (ValueError, json.JSONDecodeError):
        return None
