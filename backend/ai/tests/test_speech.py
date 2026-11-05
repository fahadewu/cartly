import asyncio

import httpx
import pytest

from app import speech, usage

from .fakes import FakeRedis, Settings


@pytest.fixture
def voice(monkeypatch):
    s = Settings()
    s(elevenlabs_api_key="test", elevenlabs_voice_id="pip")
    redis = FakeRedis()
    monkeypatch.setattr(speech, "get_cache", lambda: redis)
    monkeypatch.setattr(usage, "get_redis", lambda: redis)
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return httpx.Response(200, content=b"mp3:" + request.content[:20])

    real = httpx.AsyncClient
    monkeypatch.setattr(speech.httpx, "AsyncClient", lambda **kw: real(transport=httpx.MockTransport(handler), **kw))
    yield calls, redis
    s.restore()


def test_a_repeated_phrase_is_spoken_from_the_cache(voice):
    calls, redis = voice
    say = lambda text: asyncio.run(speech.synthesize(text, "en"))
    first = say("Your look is ready!")
    assert say("Your look is ready!") == first  # second ask: rendered once more, then kept
    assert say("Your look is ready!") == first and len(calls) == 2
    say("Something only said once")
    assert len(calls) == 3
    day = redis.hashes[usage.day_key()]
    assert day["tts:chars"] == str(float(2 * len("Your look is ready!") + len("Something only said once")))
    assert day["saved:tts"] == "1.0"


def test_voice_budget_hands_over_to_the_browser(voice):
    calls, redis = voice
    redis.hashes[usage.day_key()] = {"voice:cost": "5"}
    s = Settings()
    s(voice_daily_budget=1.0)
    try:
        with pytest.raises(speech.SpeechError) as e:
            asyncio.run(speech.synthesize("Hello", "en"))
        assert e.value.status == 503 and not calls
    finally:
        s.restore()
