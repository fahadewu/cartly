import base64
import io

import numpy as np
from PIL import Image

from app import cutout
from app.config import settings

KEY = {"X-Internal-Key": settings.internal_api_key}


def png_uri(img: Image.Image) -> str:
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()


def fake_mask(img: Image.Image) -> np.ndarray:
    """The item is whatever isn't white."""
    return np.where(np.asarray(img.convert("L")) < 250, 255, 0).astype(np.uint8)


def test_fill_holes_fills_unsure_insides_and_keeps_real_gaps():
    a = np.zeros((40, 40), np.uint8)
    a[5:35, 5:35] = 255  # the item
    a[8:16, 8:16] = 60  # the model was unsure here, inside the item (a watch's screen)
    a[22:30, 22:30] = 0  # sure it's background, inside the item (the gap under a bag's handle)
    b = cutout.fill_holes(a)
    assert (b[8:16, 8:16] == 255).all() and (b[22:30, 22:30] == 0).all() and (b[:5] == 0).all()


def test_cut_out_crops_and_trims_to_the_item(monkeypatch):
    monkeypatch.setattr(cutout, "_mask", fake_mask)
    img = Image.new("RGB", (400, 200), "white")
    img.paste((20, 20, 20), (50, 50, 150, 100))  # the item, in the left half
    img.paste((200, 0, 0), (300, 50, 350, 150))  # something else in the photo
    out = Image.open(io.BytesIO(cutout.cut_out(base64.b64decode(png_uri(img).split(",")[1]), [0, 0, 0.5, 1])))
    assert out.mode == "RGBA" and out.size == (100, 50)


def test_endpoint(client, monkeypatch):
    monkeypatch.setattr(cutout, "_mask", fake_mask)
    img = Image.new("RGB", (120, 80), "white")
    img.paste((20, 20, 20), (10, 10, 60, 40))
    r = client.post("/tryon/cutout", json={"image": png_uri(img)}, headers=KEY)
    assert r.status_code == 200 and r.json()["image"].startswith("data:image/png;base64,")
    assert client.post("/tryon/cutout", json={"image": png_uri(img)}).status_code in (401, 403)
    assert client.post("/tryon/cutout", json={"image": png_uri(img), "crop": [0.5, 0, 0.2, 1]}, headers=KEY).status_code == 422
    assert client.post("/tryon/cutout", json={"image": png_uri(Image.new("RGB", (50, 50), "white"))}, headers=KEY).status_code == 422

    def missing(*_):
        raise cutout.CutoutUnavailable("no model")

    monkeypatch.setattr(cutout, "_mask", missing)
    r = client.post("/tryon/cutout", json={"image": png_uri(img)}, headers=KEY)
    assert r.status_code == 503 and r.json()["error"] == "cutout_unavailable"
