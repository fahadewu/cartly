import asyncio
import io

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

from app import garment_check


def png(img: Image.Image, fmt="PNG") -> bytes:
    buf = io.BytesIO()
    img.save(buf, fmt)
    return buf.getvalue()


def garment(w=1200, h=1600, box=(250, 200, 950, 1400), bg=(245, 245, 245)):
    """A navy 'shirt' with some texture on a plain studio background."""
    img = Image.new("RGB", (w, h), bg)
    d = ImageDraw.Draw(img)
    d.rectangle(box, fill=(30, 45, 90))
    for y in range(box[1], box[3], 24):  # stripes, so there's detail to keep sharp
        d.line([(box[0], y), (box[2], y)], fill=(200, 60, 60), width=4)
    return img


def check(data, slot="top"):
    return asyncio.run(garment_check.check(data, slot, "Test Shirt", ["Navy"], use_ai=False))


def codes(report):
    return {i["code"] for i in report["issues"]}


def test_good_studio_photo_passes():
    r = check(png(garment()))
    assert r["ok"] and r["grade"] == "great" and r["background"] == "plain" and not codes(r)
    assert (r["width"], r["height"], r["format"]) == (1200, 1600, "image/png")


def test_too_small_is_an_error():
    r = check(png(garment().resize((300, 400))))
    assert not r["ok"] and "too_small" in codes(r)


def test_cut_off_at_two_edges_is_an_error():
    r = check(png(garment(box=(0, 200, 1199, 1400))))
    assert not r["ok"] and "cut_off" in codes(r)


def test_busy_background_and_landscape_are_warnings():
    noise = (np.random.default_rng(1).random((1200, 1800, 3)) * 255).astype(np.uint8)
    img = Image.fromarray(noise)
    ImageDraw.Draw(img).rectangle((600, 200, 1200, 1000), fill=(30, 45, 90))
    r = check(png(img))
    assert r["ok"] and {"busy_background", "landscape"} <= codes(r) and r["grade"] != "great"


def test_blurry_photo_is_flagged():
    r = check(png(garment().filter(ImageFilter.GaussianBlur(12))))
    assert "blurry" in codes(r)


def test_transparent_cutout_is_recognised():
    img = Image.new("RGBA", (1200, 1600), (0, 0, 0, 0))
    ImageDraw.Draw(img).rectangle((250, 200, 950, 1400), fill=(30, 45, 90, 255))
    r = check(png(img), slot="dress")
    assert r["ok"] and r["background"] == "transparent"


def test_not_an_image():
    r = check(b"%PDF-1.7 definitely not a photo")
    assert not r["ok"] and codes(r) == {"unreadable"}


def test_ai_review_findings_become_issues():
    review = {
        "item_seen": "a folded shirt on a hanger", "matches_product": True, "single_item": False, "fully_visible": True,
        "view": "front", "presentation": "on-hanger", "person_visible": False, "text_or_watermark": True,
        "obstructed": False, "wrinkled_or_folded": True, "tip": "",
    }
    found = {i["code"]: i["level"] for i in garment_check.review_issues(review, "top")}
    assert found == {"several_items": "error", "on_hanger": "warn", "watermark": "warn", "wrinkled": "warn"}


def test_incomplete_ai_review_falls_back_to_pixel_checks(monkeypatch):
    from app import llm

    from .fakes import FakeAnthropic, Settings, text_message

    s = Settings()
    s(anthropic_api_key="test")
    llm.set_client(FakeAnthropic(text_message({"matches_product": True})))
    try:
        r = asyncio.run(garment_check.check(png(garment()), "top", "Test Shirt", None))
    finally:
        llm.set_client(None)
        s.restore()
    assert r["ok"] and r["ai"] == {"used": False}
