"""Multilingual speech through ElevenLabs (optional; needs ELEVENLABS_API_KEY).

- transcribe(): speech-to-text that detects the language itself, so a shopper can
  just start talking in Bangla, Spanish or Arabic without picking a language first.
- synthesize(): Pip's voice, speaking whatever language the reply is written in.

Without a key the browser does both (Web Speech API), in the language the
shopper picked or Pip last detected. Past the daily voice budget, the browser
takes over too (the storefront falls back on any error).
"""
import base64
import hashlib
import json
import logging

import httpx

from . import meta, usage
from .config import settings
from .redis_client import get_cache

log = logging.getLogger("cartly.speech")

# ElevenLabs reports ISO 639-3 ("ben") or 639-1 ("bn"); the storefront speaks BCP-47 ("bn").
ISO3_TO_1 = {
    "afr": "af", "amh": "am", "ara": "ar", "aze": "az", "bel": "be", "ben": "bn", "bos": "bs", "bul": "bg",
    "cat": "ca", "ces": "cs", "cmn": "zh", "cym": "cy", "dan": "da", "deu": "de", "ell": "el", "eng": "en",
    "est": "et", "eus": "eu", "fas": "fa", "fil": "fil", "fin": "fi", "fra": "fr", "gle": "ga", "glg": "gl",
    "guj": "gu", "hau": "ha", "heb": "he", "hin": "hi", "hrv": "hr", "hun": "hu", "hye": "hy", "ind": "id",
    "isl": "is", "ita": "it", "jav": "jv", "jpn": "ja", "kan": "kn", "kat": "ka", "kaz": "kk", "khm": "km",
    "kor": "ko", "lao": "lo", "lav": "lv", "lit": "lt", "mal": "ml", "mar": "mr", "mkd": "mk", "mlt": "mt",
    "mon": "mn", "msa": "ms", "mya": "my", "nep": "ne", "nld": "nl", "nor": "no", "pan": "pa", "pol": "pl",
    "por": "pt", "pus": "ps", "ron": "ro", "rus": "ru", "sin": "si", "slk": "sk", "slv": "sl", "som": "so",
    "spa": "es", "sqi": "sq", "srp": "sr", "swa": "sw", "swe": "sv", "tam": "ta", "tel": "te", "tgl": "fil",
    "tha": "th", "tur": "tr", "ukr": "uk", "urd": "ur", "uzb": "uz", "vie": "vi", "yor": "yo", "yue": "zh",
    "zho": "zh", "zul": "zu",
}


class SpeechError(Exception):
    def __init__(self, message: str, status: int = 502):
        super().__init__(message)
        self.status = status


def stt_vendor() -> str | None:
    """Who transcribes: Meta when STT_PROVIDER=meta and META_API_KEY is set, else ElevenLabs with its key."""
    if settings.stt_provider == "meta" and settings.meta_api_key:
        return "meta"
    return "elevenlabs" if settings.elevenlabs_api_key else None


def stt_configured() -> bool:
    return stt_vendor() is not None


def tts_configured() -> bool:
    return bool(settings.elevenlabs_api_key)


def normalise_lang(code: str | None) -> str | None:
    if not code:
        return None
    code = code.strip().lower().replace("_", "-")
    base = code.split("-")[0]
    return ISO3_TO_1.get(base, base if len(base) in (2, 3) else None)


def _headers() -> dict:
    return {"xi-api-key": settings.elevenlabs_api_key}


def _error(res: httpx.Response) -> SpeechError:
    try:
        detail = res.json().get("detail")
    except ValueError:
        detail = None
    code = (detail.get("code") or detail.get("status")) if isinstance(detail, dict) else None
    log.warning("ElevenLabs %s: %s", res.status_code, detail)
    if res.status_code in (401, 403):
        return SpeechError("The voice service key isn't valid.", 503)
    if res.status_code == 402 or code in ("insufficient_credits", "quota_exceeded"):
        return SpeechError("The voice service is out of credits.", 503)
    if res.status_code == 429:
        return SpeechError("The voice service is busy. Try again in a moment.", 429)
    if code in ("audio_too_short", "invalid_audio", "invalid_audio_format"):
        return SpeechError("I couldn't make out that recording. Try again, a little closer to the mic.", 422)
    return SpeechError("The voice service had a problem.", 502)


async def transcribe(audio: bytes, filename: str, content_type: str, hint: str | None = None) -> dict:
    """{text, lang, confidence}. `hint` is only used when the shopper chose a language."""
    if not stt_configured():
        raise SpeechError("Speech-to-text isn't configured.", 503)
    if await usage.over_budget("voice"):
        raise SpeechError("The voice service is resting for today.", 503)
    if stt_vendor() == "meta":
        try:
            out = await meta.transcribe(audio, hint)
        except meta.MetaError as e:
            raise SpeechError(str(e), e.status) from e
        await usage.stt(out["seconds"], vendor="meta")
        return {"text": out["text"], "lang": out["lang"], "confidence": None}
    data = {"model_id": settings.elevenlabs_stt_model, "tag_audio_events": "false"}
    if hint:
        data["language_code"] = hint
    async with httpx.AsyncClient(timeout=httpx.Timeout(30.0, connect=5.0)) as http:
        try:
            res = await http.post(
                f"{settings.elevenlabs_base_url}/v1/speech-to-text",
                headers=_headers(),
                data=data,
                files={"file": (filename, audio, content_type)},
            )
        except httpx.HTTPError as e:
            log.warning("ElevenLabs STT unreachable: %s", e)
            raise SpeechError("The voice service isn't reachable.", 503) from e
    if res.status_code != 200:
        raise _error(res)
    body = res.json()
    # Billed per second of audio: the last word's end time is a close estimate of the recording's length.
    await usage.stt(max((w.get("end") or 0 for w in body.get("words") or []), default=0))
    return {
        "text": (body.get("text") or "").strip(),
        "lang": normalise_lang(body.get("language_code")),
        "confidence": body.get("language_probability"),
    }


_voice_id: str | None = None


async def _voice(http: httpx.AsyncClient) -> str:
    """ELEVENLABS_VOICE_ID, or the first voice on the account (looked up once)."""
    global _voice_id
    if settings.elevenlabs_voice_id:
        return settings.elevenlabs_voice_id
    if _voice_id:
        return _voice_id
    res = await http.get(f"{settings.elevenlabs_base_url}/v2/voices", headers=_headers(), params={"page_size": 10})
    if res.status_code != 200:
        raise _error(res)
    voices = res.json().get("voices") or []
    if not voices:
        raise SpeechError("There are no voices on the voice service account. Set ELEVENLABS_VOICE_ID.", 503)
    _voice_id = voices[0]["voice_id"]
    return _voice_id


async def synthesize(text: str, lang: str | None = None) -> bytes:
    """MP3 audio of `text`. One voice speaks every language, so Pip sounds the same in all of them.

    A phrase asked for a second time (greetings, "Your look is ready!", "I'm listening") is kept and
    replayed for free; one-off replies aren't, so they don't fill the cache."""
    if not tts_configured():
        raise SpeechError("Text-to-speech isn't configured.", 503)
    body: dict = {
        "text": text,
        "model_id": settings.elevenlabs_tts_model,
        "voice_settings": {
            "stability": settings.elevenlabs_stability,
            "similarity_boost": settings.elevenlabs_similarity,
            "style": settings.elevenlabs_style,
            "use_speaker_boost": True,
            "speed": settings.elevenlabs_speed,
        },
    }
    code = normalise_lang(lang)
    if code and len(code) == 2:
        body["language_code"] = code  # ignored by models that don't support it
    r = get_cache()
    key = "tts:" + hashlib.sha1(f"{settings.elevenlabs_voice_id}|{body['model_id']}|{json.dumps(body['voice_settings'], sort_keys=True)}|{code}|{text}".encode()).hexdigest()
    try:
        hit = await r.get(key)
        seen = int(await r.incr(f"{key}:seen"))
        if seen == 1:
            await r.expire(f"{key}:seen", 86400)
    except Exception:
        hit, seen = None, 1
    if hit:
        await usage.saved("tts")
        return base64.b64decode(hit)
    if await usage.over_budget("voice"):
        raise SpeechError("The voice service is resting for today.", 503)
    async with httpx.AsyncClient(timeout=httpx.Timeout(30.0, connect=5.0)) as http:
        try:
            voice = await _voice(http)
            res = await http.post(
                f"{settings.elevenlabs_base_url}/v1/text-to-speech/{voice}",
                headers=_headers(),
                params={"output_format": "mp3_44100_64"},
                json=body,
            )
        except httpx.HTTPError as e:
            log.warning("ElevenLabs TTS unreachable: %s", e)
            raise SpeechError("The voice service isn't reachable.", 503) from e
    if res.status_code != 200:
        raise _error(res)
    await usage.tts(len(text))
    if seen >= 2:
        try:
            await r.set(key, base64.b64encode(res.content).decode(), ex=settings.tts_cache_ttl)
        except Exception:
            pass
    return res.content
