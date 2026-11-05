"""LiveKit access tokens for real-time voice (optional)."""
from datetime import timedelta

from .config import settings


class VoiceNotConfigured(Exception):
    pass


def livekit_configured() -> bool:
    return bool(settings.livekit_url and settings.livekit_api_key and settings.livekit_api_secret)


def create_token(identity: str, room: str | None = None) -> dict:
    if not livekit_configured():
        raise VoiceNotConfigured()
    from livekit import api  # lazy: optional dependency

    room = room or f"cartly-{identity}"
    token = (
        api.AccessToken(settings.livekit_api_key, settings.livekit_api_secret)
        .with_identity(identity)
        .with_name(identity)
        .with_ttl(timedelta(hours=1))
        .with_grants(api.VideoGrants(room_join=True, room=room, can_publish=True, can_subscribe=True))
        .to_jwt()
    )
    return {"token": token, "url": settings.livekit_url, "room": room, "identity": identity}
