"""Meta Model API (dev.meta.ai) for the jobs the owner may move to Meta, each switched on separately and only with
META_API_KEY set:
  TRYON_PROVIDER=meta    Muse Image edits: each try-on step fuses the person photo and the product photo ($0.01 an image)
  STT_PROVIDER=meta      Muse Voice Transcribe: WAV in, text out, Bengali among its 25 languages ($0.18 an hour)
  CUTOUT_PROVIDER=meta   SAM 3.1: the accessory's mask from a noun ("sunglasses") for the quick preview ($2.50 per 1,000)
Muse Spark (the chat model) goes through llm.py instead, as AGENT_MODEL=muse-spark-1.3.

Request shapes follow Meta's API reference (images/edit-image, voice/transcribe, sam/segmenting, 2026-11). They had
not been run against the live API when this was written (no key yet): run scripts/meta_eval.py before switching.
"""
import base64
import io
import json
import logging
import re

import httpx
import numpy as np

from .config import settings

log = logging.getLogger("cartly.meta")


class MetaError(Exception):
    def __init__(self, message: str, status: int = 502):
        super().__init__(message)
        self.status = status


def configured() -> bool:
    return bool(settings.meta_api_key)


def _headers() -> dict:
    return {"Authorization": f"Bearer {settings.meta_api_key}"}


def _fail(res: httpx.Response, what: str) -> MetaError:
    try:
        detail = res.json().get("error") or res.text[:200]
    except ValueError:
        detail = res.text[:200]
    log.warning("Meta %s %s: %s", what, res.status_code, detail)
    if res.status_code in (401, 403):
        return MetaError(f"Meta {what} refused the key.", 503)
    if res.status_code == 429:
        return MetaError(f"Meta {what} is busy. Try again in a moment.", 429)
    return MetaError(f"Meta {what} had a problem.", 502)


# ---------------- try-on (Muse Image) ----------------

TRYON_PROMPT = (
    "Image 1 is a photo of a person. Image 2 is a product photo. Dress the person in image 1 in {item}, exactly as it "
    "looks in image 2: the same colour, pattern, fabric and details. Keep the person's face, hair, skin tone, body "
    "shape, pose, hands, the background and the lighting from image 1 unchanged, and change only what the item covers. "
    "Photorealistic, with a natural fit and drape."
)


def tryon_item(item: dict) -> str:
    """'the Scarlet Wrap Dress (worn open)' from a try-on item."""
    name = (item.get("name") or "").strip()
    how = ", ".join(x.strip().rstrip(".") for x in (item.get("styling") or "", item.get("notes") or "") if x and x.strip())
    return (f"the {name}" if name else "the item in image 2") + (f" ({how})" if how else "")


async def tryon_step(http: httpx.AsyncClient, person: str, product: str, item: dict) -> str:
    """One layer of the look: the person (a data URI) wearing the product (a data URI), as a JPEG data URI."""
    body = {
        "model": settings.meta_image_model,
        "prompt": TRYON_PROMPT.format(item=tryon_item(item))[:1500],
        "images": [{"image_url": person}, {"image_url": product}],
        "response_format": "b64_json",
        "output_format": "jpeg",
    }
    try:
        res = await http.post(f"{settings.meta_base_url}/v1/images/edits", headers=_headers(), json=body, timeout=120)
    except httpx.HTTPError as e:
        raise MetaError("Meta's image service isn't reachable right now.", 503) from e
    if res.status_code != 200:
        raise _fail(res, "image edit")
    data = (res.json().get("data") or [{}])[0]
    if not data.get("b64_json"):
        raise MetaError("Meta's image service sent no image.", 502)
    return f"data:image/jpeg;base64,{data['b64_json']}"


# ---------------- speech-to-text (Muse Voice Transcribe) ----------------

# Its languageBias takes language names, not codes.
LANGUAGE_NAMES = {
    "bn": "Bengali", "en": "English", "hi": "Hindi", "ur": "Urdu", "ar": "Arabic", "es": "Spanish", "fr": "French",
    "de": "German", "pt": "Portuguese", "id": "Indonesian", "ms": "Malay", "ta": "Tamil", "tr": "Turkish",
    "zh": "Chinese", "ja": "Japanese", "ko": "Korean", "ru": "Russian", "it": "Italian", "vi": "Vietnamese", "th": "Thai",
}
_SCRIPTS = [
    (re.compile(r"[ঀ-৿]"), "bn"),
    (re.compile(r"[ऀ-ॿ]"), "hi"),
    (re.compile(r"[؀-ۿ]"), "ar"),
    (re.compile(r"[஀-௿]"), "ta"),
    (re.compile(r"[぀-ヿ]"), "ja"),
    (re.compile(r"[가-힯]"), "ko"),
    (re.compile(r"[一-鿿]"), "zh"),
    (re.compile(r"[Ѐ-ӿ]"), "ru"),
    (re.compile(r"[฀-๿]"), "th"),
]


def script_lang(text: str, hint: str | None = None) -> str | None:
    """The transcript's language from its script (Voice Transcribe doesn't say). Arabic script is Urdu when that was the
    hint; Latin script is the hint, else English."""
    base = (hint or "").split("-")[0].lower() or None
    for pattern, lang in _SCRIPTS:
        if pattern.search(text):
            return "ur" if lang == "ar" and base == "ur" else lang
    return base or ("en" if text.strip() else None)


def is_wav(audio: bytes) -> bool:
    return len(audio) > 12 and audio[:4] == b"RIFF" and audio[8:12] == b"WAVE"


async def transcribe(audio: bytes, hint: str | None = None) -> dict:
    """{text, lang, seconds}. WAV only (mono, 16-bit PCM, 16 or 24 kHz): the storefront records it that way when the
    capabilities say stt is meta."""
    if not is_wav(audio):
        raise MetaError("Meta Voice Transcribe takes WAV recordings.", 415)
    request = {"model": settings.meta_stt_model, "audioEncoding": "WAV", "mode": "PUSH_TO_TALK"}
    name = LANGUAGE_NAMES.get((hint or "").split("-")[0].lower())
    if name:
        request["languageBias"] = [name]
    files = {"request": (None, json.dumps(request), "application/json"), "audio": ("speech.wav", audio, "audio/wav")}
    async with httpx.AsyncClient(timeout=httpx.Timeout(30.0, connect=5.0)) as http:
        try:
            res = await http.post(f"{settings.meta_base_url}/v1/asr/transcribe", headers=_headers(), files=files)
        except httpx.HTTPError as e:
            raise MetaError("Meta's voice service isn't reachable.", 503) from e
    if res.status_code != 200:
        raise _fail(res, "transcription")
    body = res.json()
    text = (body.get("transcript") or "").strip()
    return {"text": text, "lang": script_lang(text, hint), "seconds": (body.get("audioDurationMs") or 0) / 1000}


# ---------------- cut-outs (SAM 3.1) ----------------

# What to ask SAM for, per try-on slot of the quick preview.
SLOT_NOUN = {"eyes": "sunglasses", "head": "hat", "ears": "headphones", "wrist": "watch", "hand": "bag"}
_MASK = re.compile(r"<\|mask;([^|]*)\|>")


def parse_masks(text: str) -> list[dict]:
    """The mask records in SAM's output text: [{x, y, height, width, encoding, payload}]. Grammar from
    dev.meta.ai/docs/sam/reading-segmentation: <|mask;x=..;y=..[;c=..];data=<H>,<W>,<marker><payload>|>."""
    out = []
    for m in _MASK.finditer(text):
        fields = dict(f.split("=", 1) for f in m.group(1).split(";") if "=" in f)
        data = fields.get("data", "")
        parts = data.split(",", 2)
        if len(parts) != 3 or not parts[2]:
            continue
        h, w, rest = int(parts[0]), int(parts[1]), parts[2]
        encoding = {"!": "one_bit", "~": "lossless"}.get(rest[0])
        if not encoding:
            continue
        out.append({"x": int(fields.get("x", 0)), "y": int(fields.get("y", 0)), "height": h, "width": w, "encoding": encoding, "payload": rest[1:]})
    return out


def _decode(record: dict) -> np.ndarray:
    """One mask as an H×W 0/1 array, with Meta's parser (pip install meta-sam-parser; SAM License)."""
    try:
        from meta_sam_parser import SegmentationMask, decode_mask_to_raster  # type: ignore[import-not-found]
    except ImportError as e:
        raise MetaError("CUTOUT_PROVIDER=meta needs Meta's mask decoder: pip install meta-sam-parser (SAM License).", 503) from e
    raster = decode_mask_to_raster(SegmentationMask(encoding=record["encoding"], payload=record["payload"], width=record["width"], height=record["height"]))
    return np.frombuffer(bytes(raster), dtype=np.uint8).reshape(record["height"], record["width"])


async def sam_mask(image_png: bytes, width: int, height: int, prompt: str) -> np.ndarray:
    """0/255 alpha of everything SAM finds for `prompt` in the image (all matches joined)."""
    body = {
        "model": settings.meta_sam_model,
        "input": [{"type": "message", "role": "user", "content": [
            {"type": "input_text", "text": prompt},
            {"type": "input_image", "image_url": "data:image/png;base64," + base64.b64encode(image_png).decode()},
        ]}],
        "stream": True,
        "metadata": {"mask_encoding": "one_bit"},
    }
    text = ""
    async with httpx.AsyncClient(timeout=httpx.Timeout(60.0, connect=5.0)) as http:
        try:
            async with http.stream("POST", f"{settings.meta_base_url}/v1/responses", headers={**_headers(), "Accept": "text/event-stream"}, json=body) as res:
                if res.status_code != 200:
                    await res.aread()
                    raise _fail(res, "segmentation")
                async for line in res.aiter_lines():
                    if not line.startswith("data: "):
                        continue
                    try:
                        event = json.loads(line[6:])
                    except ValueError:
                        continue
                    if event.get("type") == "response.output_text.delta":
                        text += event.get("delta") or ""
        except httpx.HTTPError as e:
            raise MetaError("Meta's segmentation service isn't reachable.", 503) from e
    records = parse_masks(text)
    if not records:
        raise ValueError(f"No {prompt} was found in that photo.")
    alpha = np.zeros((height, width), dtype=np.uint8)
    for r in records:
        m = _decode(r)
        y0, x0 = r["y"], r["x"]
        y1, x1 = min(height, y0 + m.shape[0]), min(width, x0 + m.shape[1])
        alpha[y0:y1, x0:x1] |= m[: y1 - y0, : x1 - x0]
    return alpha * 255


def png_bytes(img) -> bytes:
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()
