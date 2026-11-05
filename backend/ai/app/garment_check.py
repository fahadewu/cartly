"""Is this product photo good enough for an accurate AI try-on?

Two passes:
1. Pixel checks (always): format, resolution, framing, background, whether the
   item is cut off at the edge, sharpness and exposure.
2. A vision review by Claude (when configured): is it really this product, one
   item, fully visible, front view, not on a hanger, no watermark?

Returns a report the admin panel shows next to the photo:
    {ok, score, grade, width, height, format, background, issues: [{level, code, message}], ai, checkedAt}
`ok` is False only for problems that make the try-on fail or look wrong.
"""
import asyncio
import base64
import io
import json
import logging
from datetime import datetime, timezone

import numpy as np
from PIL import Image, ImageFilter, ImageOps, UnidentifiedImageError

from . import llm, usage
from .config import settings

# Pillow only refuses images above ~178 million pixels, and a 170 MP PNG fits in the 15 MB upload limit
# while decoding to ~680 MB. 40 MP is far above any product photo. (Shared by every module that opens images.)
Image.MAX_IMAGE_PIXELS = 40_000_000

log = logging.getLogger("cartly.garment")

GARMENT = {"top", "outer", "dress", "bottom"}
SLOT_NAME = {
    "top": "top", "outer": "jacket or coat", "dress": "dress", "bottom": "pair of trousers, jeans or a skirt",
    "feet": "pair of shoes", "eyes": "pair of glasses or sunglasses", "head": "hat or cap", "ears": "pair of headphones",
    "wrist": "watch", "hand": "bag",
}
# Minimum short side in pixels: below `error` the AI can't see enough detail; below `warn` fine details blur.
MIN_SIDE = {"garment": (512, 1024), "accessory": (400, 800)}
FORMATS = {"JPEG": "image/jpeg", "PNG": "image/png", "WEBP": "image/webp"}
PENALTY = {"error": 35, "warn": 12, "info": 0}


def _issue(level: str, code: str, message: str) -> dict:
    return {"level": level, "code": code, "message": message}


def open_image(data: bytes) -> Image.Image:
    img = Image.open(io.BytesIO(data))
    img.load()
    return img


def pixel_checks(img: Image.Image, slot: str) -> tuple[list[dict], dict]:
    issues: list[dict] = []
    kind = "garment" if slot in GARMENT else "accessory"
    fmt = img.format or "unknown"
    img = ImageOps.exif_transpose(img)
    w, h = img.size
    facts = {"width": w, "height": h, "format": FORMATS.get(fmt, fmt), "background": "unknown"}

    if fmt not in FORMATS:
        issues.append(_issue("error", "format", "Use a JPG, PNG or WebP image."))
    short = min(w, h)
    err_min, warn_min = MIN_SIDE[kind]
    if short < err_min:
        issues.append(_issue("error", "too_small", f"The photo is {w}×{h}px. Use at least {err_min}px on the short side ({warn_min}px or more is best)."))
    elif short < warn_min:
        issues.append(_issue("warn", "low_resolution", f"The photo is {w}×{h}px. {warn_min}px or more on the short side keeps prints, logos and stitching sharp."))
    ratio = w / h
    if kind == "garment" and ratio > 1.15:
        issues.append(_issue("warn", "landscape", "Garments come out most accurately in a portrait photo (3:4 or 2:3), with the whole piece filling the frame."))
    if ratio > 3 or ratio < 1 / 3:
        issues.append(_issue("warn", "extreme_ratio", "The photo is very wide or tall. Crop it to roughly 3:4 around the item."))

    # Work on a small copy for speed; the checks are about framing, not fine detail.
    small = img.convert("RGBA")
    small.thumbnail((384, 384))
    px = np.asarray(small).astype(np.float32)
    rgb, alpha = px[..., :3], px[..., 3]
    sh, sw = alpha.shape
    # The background is judged from the four corners: an item that runs off an edge
    # still rarely fills a corner, so this holds even when the photo is badly cropped.
    # Three of the four corners agreeing is enough (a table edge or shadow may fill the fourth).
    c = max(3, int(min(sh, sw) * 0.08))
    patches = [rgb[:c, :c], rgb[:c, -c:], rgb[-c:, :c], rgb[-c:, -c:]]
    corner_alpha = np.concatenate([alpha[:c, :c], alpha[:c, -c:], alpha[-c:, :c], alpha[-c:, -c:]]).ravel()

    if (corner_alpha < 16).mean() > 0.9:
        facts["background"] = "transparent"
        mask = alpha > 24
    else:
        stats = []
        for patch in patches:
            px_ = patch.reshape(-1, 3)
            med = np.median(px_, axis=0)
            stats.append((med, float(np.linalg.norm(px_ - med, axis=1).mean())))
        # A studio backdrop is uniform in each corner, though light often falls off across it,
        # so the corners may differ; the background is modelled as a gradient between them.
        uniform = [j for j in range(4) if stats[j][1] < 14]
        agree = max(
            ([j for j in uniform if np.linalg.norm(stats[i][0] - stats[j][0]) < 110] for i in uniform), key=len, default=[]
        )
        plain = len(agree) >= 3
        mask = None
        if plain:
            fill = np.mean([stats[j][0] for j in agree], axis=0)
            tl, tr, bl, br = (stats[j][0] if j in agree else fill for j in range(4))
            fy = np.linspace(0, 1, sh)[:, None, None]
            fx = np.linspace(0, 1, sw)[None, :, None]
            bg = (1 - fy) * ((1 - fx) * tl + fx * tr) + fy * ((1 - fx) * bl + fx * br)
            mask = np.linalg.norm(rgb - bg, axis=2) > 42
        facts["background"] = "plain" if plain else "busy"
        if not plain:
            issues.append(_issue("warn", "busy_background", "Use a plain, light background (white or light grey) that contrasts with the item. A busy background can end up in the try-on."))

    if mask is not None and mask.any():
        mask = np.asarray(Image.fromarray((mask * 255).astype(np.uint8)).filter(ImageFilter.MedianFilter(5))) > 127
        coverage = float(mask.mean())
        edges = {
            "top": mask[0].mean(), "bottom": mask[-1].mean(), "left": mask[:, 0].mean(), "right": mask[:, -1].mean()
        }
        cut = [side for side, frac in edges.items() if frac > 0.12]
        if cut:
            issues.append(_issue(
                "error" if len(cut) >= 2 else "warn", "cut_off",
                f"The item touches the {' and '.join(cut)} edge{'s' if len(cut) > 1 else ''}, so part of it may be cut off. "
                "Show the whole item with a small margin all round (sleeves, hem and straps included).",
            ))
        # Size is judged by the item's bounding box: light parts of an item can blend into a light backdrop.
        ys, xs = np.nonzero(mask)
        box = ((ys.max() - ys.min() + 1) * (xs.max() - xs.min() + 1) / mask.size) if len(ys) else 0
        if box < 0.2 or coverage < 0.03:
            issues.append(_issue("warn", "small_in_frame", "The item is small in the frame. Crop closer so it fills most of the photo."))
        if mask.any():
            fg = rgb[mask].mean(axis=1)
            if fg.mean() < 40:
                issues.append(_issue("warn", "too_dark", "The item looks very dark. Use brighter, even light so the AI can see its texture."))
            elif (fg > 250).mean() > 0.5:
                issues.append(_issue("warn", "overexposed", "The item looks washed out. Lower the exposure so details and true colour show."))

    gray = np.asarray(ImageOps.grayscale(img).resize((512, max(1, int(512 * h / w))) if w >= h else (max(1, int(512 * w / h)), 512))).astype(np.float32)
    lap = gray[1:-1, 1:-1] * -4 + gray[:-2, 1:-1] + gray[2:, 1:-1] + gray[1:-1, :-2] + gray[1:-1, 2:]
    sharpness = float(lap.var())
    facts["sharpness"] = round(sharpness, 1)
    if sharpness < 25:
        issues.append(_issue("warn", "blurry", "The photo looks soft or out of focus. Use a sharp photo so prints, logos and texture carry over."))
    return issues, facts


REVIEW_SCHEMA = {
    "type": "object",
    "properties": {
        "item_seen": {"type": "string", "description": "What the photo shows, in a few words"},
        "matches_product": {"type": "boolean"},
        "single_item": {"type": "boolean", "description": "Only this one product is shown (a pair of shoes or earrings counts as one)"},
        "fully_visible": {"type": "boolean", "description": "Nothing important is cropped or hidden (sleeves, hem, straps, both shoes)"},
        "view": {"type": "string", "enum": ["front", "back", "side", "angled", "top-down", "unclear"]},
        "presentation": {"type": "string", "enum": ["on-model", "ghost-mannequin", "flat-lay", "product-shot", "on-hanger", "lifestyle", "other"]},
        "person_visible": {"type": "boolean"},
        "text_or_watermark": {"type": "boolean", "description": "Overlaid text, logos or watermarks that aren't part of the product"},
        "obstructed": {"type": "boolean", "description": "Hands, hair, props or other items cover part of the product"},
        "wrinkled_or_folded": {"type": "boolean"},
        "tip": {"type": "string", "description": "One short, practical tip to improve this photo for try-on, or empty"},
    },
    "required": [
        "item_seen", "matches_product", "single_item", "fully_visible", "view", "presentation", "person_visible",
        "text_or_watermark", "obstructed", "wrinkled_or_folded", "tip",
    ],
    "additionalProperties": False,
}


def _jpeg_b64(img: Image.Image, side: int = 1024) -> str:
    copy = ImageOps.exif_transpose(img).convert("RGB")
    copy.thumbnail((side, side))
    buf = io.BytesIO()
    copy.save(buf, "JPEG", quality=88)
    return base64.b64encode(buf.getvalue()).decode()


async def ai_review(img: Image.Image, slot: str, name: str | None, colors: list[str] | None) -> dict | None:
    if not llm.configured(settings.admin_ai_model or settings.agent_model):
        return None
    what = f"“{name}”, a {SLOT_NAME.get(slot, 'fashion item')}" if name else f"a {SLOT_NAME.get(slot, 'fashion item')}"
    colour = f" Listed colours: {', '.join(colors)}." if colors else ""
    prompt = (
        f"This photo will be used for AI virtual try-on of {what}.{colour} "
        "The try-on model copies the product from this photo onto a shopper's body, so the photo must show exactly this "
        "one product, all of it, clearly, from the front. Review the photo against that and fill in the fields."
    )
    try:
        await usage.check("claude")  # the daily Claude budget covers admin reviews too
        data = await asyncio.to_thread(_jpeg_b64, img)
        msg = await llm.create(
            feature="photo-check",
            model=settings.admin_ai_model or settings.agent_model,
            effort="low",
            schema=REVIEW_SCHEMA,
            max_tokens=2000,
            # Each attempt stays inside the API gateway's 45 s wait, so a slow answer isn't paid for twice.
            timeout=20.0,
            messages=[{
                "role": "user",
                "content": [
                    {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": data}},
                    {"type": "text", "text": prompt},
                ],
            }],
        )
    except usage.OverBudget:
        log.info("Garment review skipped: today's Claude budget is spent")
        return None
    except Exception as e:
        log.warning("Garment review unavailable: %s", e)
        return None
    if msg.stop_reason != "end_turn":
        return None
    try:
        review = json.loads(llm.text_of(msg))
    except ValueError:
        return None
    # Structured output guarantees the shape, but a partial review must never break the check.
    return review if isinstance(review, dict) and all(k in review for k in REVIEW_SCHEMA["required"]) else None


def review_issues(r: dict, slot: str) -> list[dict]:
    out = []
    thing = SLOT_NAME.get(slot, "item")
    if not r["matches_product"]:
        out.append(_issue("error", "wrong_item", f"This doesn't look like the product (I see: {r['item_seen']}). Upload a photo of this {thing}."))
    if not r["single_item"]:
        out.append(_issue("error", "several_items", "More than one product is in the photo, so the try-on may copy the wrong one. Show only this item."))
    if not r["fully_visible"]:
        out.append(_issue("error", "not_fully_visible", "Part of the item is cropped or hidden. Show all of it, including sleeves, hem and straps."))
    if slot in GARMENT and r["view"] in ("back", "side"):
        out.append(_issue("warn", "not_front", f"The photo shows the {r['view']}. Use a straight-on front view."))
    if r["presentation"] == "on-hanger":
        out.append(_issue("warn", "on_hanger", "Hangers distort the shape. Use an on-model, ghost-mannequin or flat-lay photo instead."))
    if r["presentation"] == "lifestyle":
        out.append(_issue("warn", "lifestyle", "This is a styled scene. A clean product photo on a plain background is more accurate."))
    if r["text_or_watermark"]:
        out.append(_issue("warn", "watermark", "Remove overlaid text, badges or watermarks; the try-on can copy them onto the shopper."))
    if r["obstructed"]:
        out.append(_issue("warn", "obstructed", "Something covers part of the product (hands, hair or props). Show it unobstructed."))
    if r["wrinkled_or_folded"] and slot in GARMENT:
        out.append(_issue("warn", "wrinkled", "The garment is creased or folded. Steam it and lay it out flat, or shoot it on a model or mannequin."))
    if r["person_visible"] and r["presentation"] == "on-model" and slot in GARMENT:
        out.append(_issue("info", "on_model", "On-model photos work well. Make sure the model's pose shows the whole garment."))
    return out


async def check(data: bytes, slot: str, name: str | None = None, colors: list[str] | None = None, use_ai: bool = True) -> dict:
    try:
        img = await asyncio.to_thread(open_image, data)
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError):
        return {
            "ok": False, "score": 0, "grade": "fail", "width": 0, "height": 0, "format": None, "background": "unknown",
            "issues": [_issue("error", "unreadable", "That file isn't an image I can read. Use a JPG, PNG or WebP.")],
            "ai": {"used": False}, "checkedAt": datetime.now(timezone.utc).isoformat(),
        }
    # numpy and Pillow work in a thread: a photo check must not stall every chat turn on the event loop.
    issues, facts = await asyncio.to_thread(pixel_checks, img, slot)
    review = await ai_review(img, slot, name, colors) if use_ai else None
    if review:
        issues.extend(review_issues(review, slot))
        # The vision review is better at judging "cut off" than edge pixels are.
        if review["fully_visible"]:
            issues = [i for i in issues if not (i["code"] == "cut_off" and i["level"] == "error")] + [
                {**i, "level": "warn"} for i in issues if i["code"] == "cut_off" and i["level"] == "error"
            ]
        if review["tip"]:
            issues.append(_issue("info", "tip", review["tip"]))
    score = max(0, 100 - sum(PENALTY[i["level"]] for i in issues))
    ok = not any(i["level"] == "error" for i in issues)
    grade = "fail" if not ok else "great" if score >= 90 else "good" if score >= 70 else "fix"
    order = {"error": 0, "warn": 1, "info": 2}
    return {
        "ok": ok, "score": score, "grade": grade, **facts,
        "issues": sorted(issues, key=lambda i: order[i["level"]]),
        "ai": {"used": bool(review), **({"seen": review["item_seen"], "presentation": review["presentation"], "view": review["view"]} if review else {})},
        "checkedAt": datetime.now(timezone.utc).isoformat(),
    }
