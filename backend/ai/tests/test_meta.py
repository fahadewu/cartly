"""Meta Model API request shapes (no network: httpx is mocked) and the bits that can be checked offline."""
import asyncio
import json

import httpx
import pytest

from app import llm, meta, speech, tryon, usage

from .fakes import Settings


@pytest.fixture
def meta_on():
    s = Settings()
    s(meta_api_key="LLM_test", stt_provider="meta", tryon_provider="meta")
    yield
    s.restore()


def test_muse_spark_takes_effort_and_format_but_no_refusal_fallback_or_long_cache():
    opts = llm.request_options("muse-spark-1.3", "low", {"type": "object"})
    assert opts == {"output_config": {"effort": "low", "format": {"type": "json_schema", "schema": {"type": "object"}}}}
    blocks = llm._meta_blocks([{"type": "text", "text": "x", "cache_control": {"type": "ephemeral", "ttl": "1h"}}])
    assert blocks[0]["cache_control"] == {"type": "ephemeral"}  # Meta takes only its 5-minute TTL
    assert llm.is_meta("muse-spark-1.3") and not llm.is_meta("claude-haiku-5-5")
    assert usage.CLAUDE_PRICES["muse-spark-1.3"] == (1.25, 4.25, 0.15, 1.25)


def test_muse_spark_goes_to_meta_with_the_claude_shape(meta_on, monkeypatch):
    sent = {}

    class Messages:
        async def create(self, **kw):
            sent.update(kw)
            from types import SimpleNamespace
            return SimpleNamespace(content=[SimpleNamespace(type="text", text="{}")], usage=SimpleNamespace(input_tokens=10, output_tokens=5), stop_reason="end_turn", model=kw["model"])

    class Client:
        messages = Messages()

    llm.set_meta_client(Client())
    monkeypatch.setattr(usage, "claude", lambda *a, **k: _none())
    asyncio.run(llm.create(model="muse-spark-1.3", effort="low", max_tokens=100, system=[{"type": "text", "text": "p", "cache_control": {"type": "ephemeral", "ttl": "1h"}}],
                     messages=[{"role": "user", "content": "hi"}]))
    assert sent["model"] == "muse-spark-1.3" and sent["output_config"] == {"effort": "low"}
    assert sent["system"][0]["cache_control"] == {"type": "ephemeral"} and "betas" not in sent and "fallbacks" not in sent
    llm.set_meta_client(None)


async def _none():
    return None


def test_transcripts_get_a_language_from_their_script():
    assert meta.script_lang("আমি একটা লাল শাড়ি চাই") == "bn"
    assert meta.script_lang("मुझे जूते चाहिए") == "hi"
    assert meta.script_lang("مجھے جوتے چاہئیں", "ur") == "ur"
    assert meta.script_lang("ami ekta lal shari chai", "bn-BD") == "bn"  # Banglish: the hint
    assert meta.script_lang("red sneakers") == "en"


def test_voice_transcribe_request(meta_on, monkeypatch):
    seen = {}

    def handler(request: httpx.Request):
        seen["url"] = str(request.url)
        seen["auth"] = request.headers["authorization"]
        seen["body"] = request.content
        return httpx.Response(200, json={"sessionId": "s", "transcript": " লাল শাড়ি ", "audioDurationMs": 2500, "turns": []})

    real = httpx.AsyncClient
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kw: real(transport=httpx.MockTransport(handler), **kw))
    monkeypatch.setattr(usage, "over_budget", lambda *_: _false())
    monkeypatch.setattr(usage, "stt", lambda *a, **k: _none())
    wav = b"RIFF\x24\x00\x00\x00WAVEfmt " + b"\x00" * 32
    out = asyncio.run(speech.transcribe(wav, "speech.wav", "audio/wav", "bn-BD"))
    assert out == {"text": "লাল শাড়ি", "lang": "bn", "confidence": None}
    assert seen["url"].endswith("/v1/asr/transcribe") and seen["auth"] == "Bearer LLM_test"
    assert b'"audioEncoding": "WAV"' in seen["body"] and b'"languageBias": ["Bengali"]' in seen["body"]
    with pytest.raises(speech.SpeechError):
        asyncio.run(speech.transcribe(b"webm-bytes", "speech.webm", "audio/webm"))  # Meta takes WAV only


async def _false():
    return False


def test_muse_image_try_on_step(meta_on):
    seen = {}

    def handler(request: httpx.Request):
        seen.update(json.loads(request.content))
        seen["url"] = str(request.url)
        return httpx.Response(200, json={"created": 1, "data": [{"b64_json": "QUJD"}]})

    async def go():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
            return await meta.tryon_step(http, "data:image/jpeg;base64,cA==", "data:image/jpeg;base64,cQ==", {"name": "Scarlet Wrap Dress", "styling": "worn open"})

    out = asyncio.run(go())
    assert out == "data:image/jpeg;base64,QUJD"
    assert seen["url"].endswith("/v1/images/edits") and seen["model"] == "muse-image-1.0"
    assert [i["image_url"] for i in seen["images"]] == ["data:image/jpeg;base64,cA==", "data:image/jpeg;base64,cQ=="]
    assert "the Scarlet Wrap Dress (worn open)" in seen["prompt"] and "Keep the person's face" in seen["prompt"]
    assert tryon.vendor() == "meta"


def test_sam_output_records_are_parsed():
    text = "<0f>1<|box;x1=2;y1=3;x2=10;y2=12;w=20;h=16;c=0.91|><|mask;x=0;y=0;c=0.9;data=16,20,!abc#d|>,2<|box;x1=0;y1=0;x2=1;y2=1;w=20;h=16|><|mask;x=4;y=5;data=2,3,~zz|>"
    recs = meta.parse_masks(text)
    assert recs[0] == {"x": 0, "y": 0, "height": 16, "width": 20, "encoding": "one_bit", "payload": "abc#d"}
    assert recs[1]["encoding"] == "lossless" and (recs[1]["x"], recs[1]["y"]) == (4, 5)
    assert meta.parse_masks("") == []
