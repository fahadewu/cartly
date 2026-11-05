"""Drafts the details Pip needs for a product (admin panel's "Suggest with AI"), from its photo and what
the admin has written so far. The admin reviews every value before saving; nothing is saved here."""
import asyncio
import base64
import io
import json

from PIL import Image

from . import llm, usage
from .config import settings

# The same vocabulary as the API (api/src/common/product-details.ts).
OCCASIONS = ["everyday", "office", "formal", "party", "wedding", "festive", "date-night", "sport", "travel", "lounge", "beach", "gift"]
SEASONS = ["summer", "monsoon", "autumn", "winter", "all-season"]
FITS = ["slim", "regular", "relaxed", "oversized"]

SCHEMA = {
    "type": "object",
    "properties": {
        "material": {"type": "string"},
        "fit": {"type": "string", "enum": [*FITS, ""]},
        "fitNotes": {"type": "string"},
        "occasions": {"type": "array", "items": {"type": "string", "enum": OCCASIONS}},
        "seasons": {"type": "array", "items": {"type": "string", "enum": SEASONS}},
        "styleTags": {"type": "array", "items": {"type": "string"}},
        "features": {"type": "array", "items": {"type": "string"}},
        "keywords": {"type": "array", "items": {"type": "string"}},
        "careNotes": {"type": "string"},
        "description": {"type": "string"},
    },
    "required": ["material", "fit", "fitNotes", "occasions", "seasons", "styleTags", "features", "keywords", "careNotes", "description"],
    "additionalProperties": False,
}


class Unavailable(Exception):
    pass


def _jpeg(data: bytes, side: int = 1024) -> str:
    img = Image.open(io.BytesIO(data))
    img.thumbnail((side, side))
    out = io.BytesIO()
    img.convert("RGB").save(out, "JPEG", quality=85)
    return base64.b64encode(out.getvalue()).decode()


def _clean(raw: dict, is_clothing: bool) -> dict:
    words = lambda xs, n, lower=False: list(dict.fromkeys(  # noqa: E731
        (x.strip().lower() if lower else x.strip()) for x in xs if isinstance(x, str) and x.strip()
    ))[:n]
    return {
        "material": raw.get("material", "").strip()[:80],
        "fit": raw.get("fit") if is_clothing and raw.get("fit") in FITS else None,
        "fitNotes": raw.get("fitNotes", "").strip()[:120],
        "occasions": [o for o in dict.fromkeys(raw.get("occasions") or []) if o in OCCASIONS][:4],
        "seasons": [s for s in dict.fromkeys(raw.get("seasons") or []) if s in SEASONS][:3],
        "styleTags": [t[:24] for t in words(raw.get("styleTags") or [], 5, lower=True)],
        "features": [f[:80] for f in words(raw.get("features") or [], 5)],
        "keywords": [k[:40] for k in words(raw.get("keywords") or [], 12, lower=True)],
        "careNotes": raw.get("careNotes", "").strip()[:200],
        "description": raw.get("description", "").strip()[:1000],
    }


async def suggest(product: dict, image: bytes | None) -> dict:
    """{material, fit, fitNotes, occasions, seasons, styleTags, features, keywords, careNotes, description}."""
    if not llm.configured(settings.admin_ai_model or settings.agent_model):
        raise Unavailable("Suggestions need ANTHROPIC_API_KEY.")
    await usage.check("claude")
    is_clothing = product.get("type") == "Clothing"
    known = {k: v for k, v in product.items() if v not in (None, "", [])}
    prompt = (
        "You fill in product details for Cartly, an online fashion and lifestyle store in Bangladesh. Pip, the store's "
        "AI shopping assistant, recommends products from these details, and search matches on them, so be accurate: "
        "use the photo and the text below, and don't claim anything you can't see or read (no invented certifications, "
        "measurements or percentages).\n\n"
        f"What the admin has so far (JSON):\n{json.dumps(known, ensure_ascii=False)}\n\n"
        "Fill in:\n"
        "- material: what it's made of, short (\"100% cotton\", \"full-grain leather upper, rubber sole\").\n"
        f"- fit: {'slim, regular, relaxed or oversized' if is_clothing else 'empty (it is not clothing)'}; fitNotes: how it fits in practice, if the photo or text shows it, else empty.\n"
        "- occasions: 1 to 4 that it really suits. seasons: 1 to 3 (all-season if it isn't seasonal; monsoon for rain-ready things).\n"
        "- styleTags: 2 to 5 lower-case style words (minimal, streetwear, classic, boho…).\n"
        "- features: 2 to 5 short selling points a shopper cares about, in English.\n"
        "- keywords: 6 to 10 other names shoppers type for this kind of item: English synonyms, Bangla in Bangla script, "
        "and Banglish (Bangla in Latin letters), e.g. for sneakers: sneakers, keds, running shoes, কেডস, জুতা.\n"
        "- careNotes: short care instructions if it's something you care for, else empty.\n"
        f"- description: {'a better description of 2 or 3 sentences, if the current one is under 60 characters or missing' if len(product.get('description') or '') < 60 else 'empty (the current one is fine)'}."
    )
    content: list[dict] = []
    if image:
        try:
            data = await asyncio.to_thread(_jpeg, image)
        except Exception as e:  # a corrupt or oversized upload is the admin’s problem, not a crash
            raise Unavailable("That photo couldn't be read. Try a JPG or PNG.") from e
        content.append({"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": data}})
    content.append({"type": "text", "text": prompt})
    msg = await llm.create(
        feature="product-suggest",
        model=settings.admin_ai_model or settings.agent_model,
        effort="low",
        schema=SCHEMA,
        max_tokens=3000,
        timeout=28.0,  # each attempt inside the API gateway's 60 s wait
        messages=[{"role": "user", "content": content}],
    )
    if msg.stop_reason != "end_turn":
        raise Unavailable("The suggestion didn't finish. Try again.")
    return _clean(json.loads(llm.text_of(msg)), is_clothing)
