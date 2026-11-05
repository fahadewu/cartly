"""Transparent cut-outs of accessories for the storefront's on-device quick preview.

BiRefNet-lite (MIT licence) finds the item, so busy or light backgrounds work where a simple
background flood fill doesn't (a white watch on grey, a beanie on a knit throw). It runs once per
product photo here, never in the shopper's browser. The model (~220 MB) downloads on first use.
"""
import io
import logging
import threading
import urllib.request
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageOps, UnidentifiedImageError

from .config import settings

log = logging.getLogger(__name__)

MEAN = np.array([0.485, 0.456, 0.406], np.float32)
STD = np.array([0.229, 0.224, 0.225], np.float32)
SIZE = 1024  # the model's input
MAX_SIDE = 700  # the storefront never draws a cut-out bigger than this

_session = None
_lock = threading.Lock()


class CutoutUnavailable(Exception):
    """The model or onnxruntime isn't there (the storefront then uses its simple background removal)."""


def _model():
    global _session
    with _lock:
        if _session is None:
            try:
                import onnxruntime as ort
            except ImportError as e:
                raise CutoutUnavailable("onnxruntime isn't installed") from e
            path = Path(settings.cutout_model_path)
            if not path.exists():
                log.info("Downloading the cut-out model to %s", path)
                path.parent.mkdir(parents=True, exist_ok=True)
                part = path.with_suffix(".part")
                try:
                    urllib.request.urlretrieve(settings.cutout_model_url, part)
                except OSError as e:
                    raise CutoutUnavailable("the cut-out model couldn't be downloaded") from e
                part.rename(path)
            _session = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
    return _session


def _mask(img: Image.Image) -> np.ndarray:
    """The item's alpha (0-255). The photo is padded to a square with its own border colour rather
    than stretched: a squashed item loses parts (a watch face read as background)."""
    w, h = img.size
    a = np.asarray(img)
    pad = tuple(int(v) for v in np.median(np.concatenate([a[0], a[-1], a[:, 0], a[:, -1]]), axis=0))
    s = max(w, h)
    square = Image.new("RGB", (s, s), pad)
    ox, oy = (s - w) // 2, (s - h) // 2
    square.paste(img, (ox, oy))
    x = np.asarray(square.resize((SIZE, SIZE), Image.BILINEAR), np.float32) / 255
    x = ((x - MEAN) / STD).transpose(2, 0, 1)[None]
    session = _model()
    logits = session.run(None, {session.get_inputs()[0].name: x})[0][0, 0]
    m = Image.fromarray((255 / (1 + np.exp(-logits))).astype(np.uint8)).resize((s, s), Image.BILINEAR)
    return np.asarray(m.crop((ox, oy, ox + w, oy + h)))


def fill_holes(alpha: np.ndarray) -> np.ndarray:
    """Pixels the model was unsure about that the background can't reach from the edge are part of
    the item (a watch's screen, a printed logo): make them opaque. Background it was sure about
    stays see-through even when enclosed, like the gap under a bag's handle."""
    bg = np.where(alpha < 128, 255, 0).astype(np.uint8)
    framed = Image.new("L", (bg.shape[1] + 2, bg.shape[0] + 2), 255)
    framed.paste(Image.fromarray(bg), (1, 1))
    ImageDraw.floodfill(framed, (0, 0), 128)  # the frame joins every edge-touching background region
    enclosed = np.asarray(framed)[1:-1, 1:-1] == 255
    out = alpha.copy()
    out[enclosed & (alpha >= 10)] = 255
    return out


def prepare(data: bytes, crop: list[float] | None = None) -> Image.Image:
    """The photo, upright, cropped to the item when `crop` is [x0, y0, x1, y1] (0-1), at most 1400 px."""
    try:
        img = ImageOps.exif_transpose(Image.open(io.BytesIO(data))).convert("RGB")
    except (UnidentifiedImageError, OSError) as e:
        raise ValueError("That image couldn't be read.") from e
    if crop:
        W, H = img.size
        img = img.crop((round(crop[0] * W), round(crop[1] * H), round(crop[2] * W), round(crop[3] * H)))
    img.thumbnail((1400, 1400))  # plenty for the mask and the output
    return img


def cut_out(data: bytes, crop: list[float] | None = None) -> bytes:
    """PNG of the item on a transparent background, trimmed to it. `crop` is [x0, y0, x1, y1] (0-1)
    of the item inside a photo that shows more (a styled shot)."""
    img = prepare(data, crop)
    return compose(img, _mask(img))


def compose(img: Image.Image, alpha: np.ndarray) -> bytes:
    """The image with `alpha` (0-255, holes filled) as its transparency, trimmed to the item."""
    rgba = img.convert("RGBA")
    rgba.putalpha(Image.fromarray(fill_holes(alpha)))
    box = rgba.getchannel("A").point(lambda v: 255 if v > 24 else 0).getbbox()
    if not box:
        raise ValueError("No item was found in that photo.")
    out = rgba.crop(box)
    out.thumbnail((MAX_SIDE, MAX_SIDE), Image.LANCZOS)
    buf = io.BytesIO()
    out.save(buf, "PNG", optimize=True)
    return buf.getvalue()
