"""Text embedders. All produce 384-dim, L2-normalised float32 vectors, so the
default hashing embedder and sentence-transformers/all-MiniLM-L6-v2 share the
same `ai.product_embeddings.embedding vector(384)` column.
"""
import hashlib
import re
import unicodedata
from functools import lru_cache
from typing import Protocol

import numpy as np

DIM = 384


class Embedder(Protocol):
    name: str
    dim: int

    def embed(self, texts: list[str]) -> np.ndarray: ...  # (n, dim), rows L2-normalised


# Small fashion vocabulary so related words land near each other.
SYNONYMS: dict[str, list[str]] = {
    "sneaker": ["shoe", "trainer", "runner"],
    "sneakers": ["shoes", "trainers", "runner"],
    "trainer": ["shoe", "sneaker"],
    "trainers": ["shoes", "sneakers"],
    "kicks": ["shoes", "sneakers"],
    "runner": ["shoe", "sneaker", "running"],
    "footwear": ["shoes"],
    "heels": ["shoes", "stilettos"],
    "stilettos": ["heels", "shoes"],
    "tee": ["t-shirt", "tshirt", "shirt"],
    "tees": ["t-shirt", "tshirt", "shirt"],
    "t-shirt": ["tee", "shirt"],
    "tshirt": ["tee", "shirt"],
    "bag": ["handbag", "purse"],
    "bags": ["handbag", "purse"],
    "handbag": ["bag", "purse"],
    "purse": ["bag", "handbag"],
    "backpack": ["bag", "daypack"],
    "cosy": ["warm", "cozy", "fleece", "winter"],
    "cozy": ["warm", "cosy", "fleece", "winter"],
    "warm": ["cosy", "winter", "fleece"],
    "winter": ["warm", "cosy", "wool"],
    "hoodie": ["sweatshirt", "hood", "fleece"],
    "sweatshirt": ["hoodie", "fleece", "crew"],
    "jumper": ["sweater", "sweatshirt", "knit"],
    "sweater": ["jumper", "knit"],
    "jacket": ["coat", "bomber", "outerwear"],
    "coat": ["jacket", "outerwear"],
    "jeans": ["denim", "trousers"],
    "denim": ["jeans"],
    "pants": ["trousers", "jeans"],
    "trousers": ["pants", "jeans"],
    "shades": ["sunglasses"],
    "sunglasses": ["shades"],
    "hat": ["cap", "beanie"],
    "cap": ["hat"],
    "beanie": ["hat", "wool"],
    "dress": ["maxi", "wrap"],
    "gift": ["present", "gifts"],
    "present": ["gift"],
    "red": ["scarlet", "rouge"],
    "scarlet": ["red"],
    "pink": ["blush"],
    "blue": ["cobalt", "navy", "sky", "denim"],
    "grey": ["gray", "stone"],
    "gray": ["grey", "stone"],
    "brown": ["chestnut", "tan"],
    "men": ["mens", "man"],
    "women": ["womens", "woman"],
    "headphones": ["audio", "wireless"],
    "watch": ["smartwatch"],
    "candle": ["scented", "home"],
    "plant": ["succulent", "cactus"],
}

# Zero-width (non-)joiners, word joiners and soft hyphens sit inside Bangla, Hindi and Urdu words, and the Arabic
# tatweel only stretches one: none of them may split or change a word (a zero-width space still separates words).
INVISIBLE = dict.fromkeys(map(ord, "\u00ad\u0640\u200c\u200d\u2060\ufeff"), None)
WORD = re.compile(r"[^\s-]+(?:-[^\s-]+)*")


def _char(ch: str) -> str:
    # Letters and combining marks of every script (Python's \w leaves out Bangla and Hindi vowel signs), digits
    # of every script as ASCII; anything else separates words.
    if ch.isalpha() or ch == "-":
        return ch
    if ch.isdecimal():
        return str(unicodedata.decimal(ch))
    return ch if unicodedata.category(ch)[0] == "M" else " "


def words(text: str) -> list[str]:
    """Lower-cased words in any script: "t-shirt", "শাড়ি", "जूते", "حذاء"; "৫০০" reads as "500"."""
    t = unicodedata.normalize("NFC", text).translate(INVISIBLE).lower()
    return WORD.findall("".join(map(_char, t)))


def _features(text: str) -> dict[str, float]:
    ws = words(text)
    feats: dict[str, float] = {}

    def add(k: str, w: float) -> None:
        feats[k] = feats.get(k, 0.0) + w

    for w in ws:
        add("w:" + w, 1.0)
        if len(w) > 4 and w.endswith("s"):
            add("w:" + w[:-1], 0.6)  # cheap singular
        for s in SYNONYMS.get(w, []):
            add("w:" + s, 0.5)
        padded = f"#{w}#"
        for i in range(len(padded) - 2):
            add("c:" + padded[i : i + 3], 0.25)
    for a, b in zip(ws, ws[1:]):
        add(f"b:{a} {b}", 0.7)
    return feats


def _bucket(key: str) -> tuple[int, float]:
    h = hashlib.blake2b(key.encode(), digest_size=8).digest()
    n = int.from_bytes(h, "little")
    return n % DIM, 1.0 if (n >> 63) & 1 else -1.0


class HashingEmbedder:
    """Dependency-free hashing-trick embedder (word uni/bigrams + char trigrams + synonyms), any script."""

    name = "hashing-v2"  # v1 only read a-z and 0-9; a new name re-embeds the index on startup (needs_rebuild)
    dim = DIM

    def embed_one(self, text: str) -> np.ndarray:
        v = np.zeros(DIM, dtype=np.float32)
        for k, w in _features(text).items():
            i, sign = _bucket(k)
            v[i] += sign * w
        n = float(np.linalg.norm(v))
        return v / n if n > 0 else v

    def embed(self, texts: list[str]) -> np.ndarray:
        return np.stack([self.embed_one(t) for t in texts]) if texts else np.zeros((0, DIM), dtype=np.float32)


class SentenceTransformerEmbedder:
    """Optional: `pip install sentence-transformers`, set EMBEDDINGS_PROVIDER=sentence-transformers."""

    name = "sentence-transformers/all-MiniLM-L6-v2"
    dim = DIM

    def __init__(self, model: str = "sentence-transformers/all-MiniLM-L6-v2"):
        from sentence_transformers import SentenceTransformer  # lazy, optional

        self.model = SentenceTransformer(model)
        self.name = model

    def embed(self, texts: list[str]) -> np.ndarray:
        return np.asarray(self.model.encode(texts, normalize_embeddings=True), dtype=np.float32)


@lru_cache(maxsize=1)
def get_embedder(provider: str = "hashing") -> Embedder:
    if provider in ("sentence-transformers", "sentence_transformers", "minilm"):
        return SentenceTransformerEmbedder()
    return HashingEmbedder()
