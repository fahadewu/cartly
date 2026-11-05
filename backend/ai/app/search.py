"""Hybrid semantic product search: pgvector cosine + structured filters + keyword boost."""
import hashlib
import json
import math
import re
import unicodedata

import numpy as np

from . import db
from .brain.brain import TYPE_TAGS
from .brain.parsing import normalise, occasion_of, parse_filters
from .catalog import Catalog
from .config import settings
from .embeddings import get_embedder, words
from .redis_client import get_cache, get_redis

VECTOR_WEIGHT = 0.7
KEYWORD_WEIGHT = 0.3


def product_content(p: dict) -> str:
    gender = {"men": "men mens", "women": "women womens", "unisex": "unisex men women"}.get(p["gender"], p["gender"])
    # NFC like the query's words, so a Bangla keyword matches however it was typed (ড় as one character or two).
    return unicodedata.normalize("NFC", " ".join([
        p["name"], p["name"], p["label"], p["type"], TYPE_TAGS.get(p["type"], ""), p["categoryTitle"],
        p["description"], " ".join(c["name"] for c in p["colors"]), gender, " ".join(p["collections"]),
        "sale offer" if p["compareAt"] else "", "new" if p["isNew"] else "",
        # What the admin filled in for Pip: shoppers search by these too ("office", "linen", "পাঞ্জাবি").
        p.get("material") or "", p.get("fit") or "", " ".join(p.get("occasions") or []), " ".join(p.get("seasons") or []),
        " ".join(p.get("styleTags") or []), " ".join(p.get("features") or []), " ".join(p.get("keywords") or []),
    ]))


def embedder():
    return get_embedder(settings.embeddings_provider)


async def index_size() -> int:
    rows = await db.fetch("SELECT count(*) AS n FROM ai.product_embeddings")
    return rows[0]["n"]


async def needs_rebuild(catalog: Catalog) -> bool:
    """True when the index is missing products, used another embedder, or was built from older product text."""
    rows = await db.fetch("SELECT product_id, content, model FROM ai.product_embeddings")
    indexed = {r["product_id"]: r for r in rows}
    return any(
        (r := indexed.get(p["id"])) is None or r["model"] != embedder().name or r["content"] != product_content(p)
        for p in catalog.products
    )


async def rebuild_index(catalog: Catalog) -> int:
    await catalog.load()
    emb = embedder()
    contents = [product_content(p) for p in catalog.products]
    vectors = emb.embed(contents)
    pool = await db.open_pool()
    async with pool.connection() as conn, conn.transaction():
        await conn.execute("DELETE FROM ai.product_embeddings")
        async with conn.cursor() as cur:
            await cur.executemany(
                "INSERT INTO ai.product_embeddings (product_id, embedding, content, model, updated_at) "
                "VALUES (%s, %s, %s, %s, now())",
                [(p["id"], vectors[i], contents[i], emb.name) for i, p in enumerate(catalog.products)],
            )
    await get_redis().incr("search:version")
    return len(catalog.products)


def _where(f: dict) -> tuple[list[str], list]:
    where, params = ["p.active"], []  # archived products never show up
    if f.get("gender"):
        where.append("(p.gender::text = %s OR p.gender::text = 'unisex')")
        params.append(f["gender"])
    if f.get("types"):
        if f.get("gift"):
            where.append("(p.type = ANY(%s) OR p.type = 'Gifts')")
        else:
            where.append("p.type = ANY(%s)")
        params.append(f["types"])
    elif f.get("gift"):
        where.append("p.\"categorySlug\" = 'gifts-living'")
    if f.get("min") is not None:
        where.append("p.price >= %s")
        params.append(f["min"])
    if f.get("max") is not None:
        where.append("p.price <= %s")
        params.append(f["max"])
    if f.get("sale"):
        where.append("p.\"compareAt\" IS NOT NULL")
    if f.get("isNew"):
        where.append("p.\"isNew\"")
    if f.get("colors"):
        where.append("EXISTS (SELECT 1 FROM jsonb_array_elements(p.colors) c WHERE c->>'name' = ANY(%s))")
        params.append(f["colors"])
    return where, params


async def _query(vec: np.ndarray | None, f: dict, candidates: int, native: list[str]) -> list[dict]:
    where, params = _where(f)
    order, order_params = [], []
    if native:
        # The hashing vector barely tells a one-word Bangla match from noise, so products whose text has one of the
        # query's non-Latin words come first. Words are only letters, marks, digits and hyphens: no LIKE wildcards.
        order.append("lower(e.content) LIKE ANY(%s) DESC")
        order_params.append([f"%{w}%" for w in native])
    if vec is None:
        order.append("p.popularity DESC")  # a query of only symbols has nothing to compare with
    else:
        order.append("e.embedding <=> %s")
        order_params.append(vec)
    sim = "0::float8" if vec is None else "1 - (e.embedding <=> %s)"
    sql = (
        f"SELECT p.id, p.name, e.content, {sim} AS sim, p.popularity "
        "FROM ai.product_embeddings e JOIN public.\"Product\" p ON p.id = e.product_id "
        + (f"WHERE {' AND '.join(where)} " if where else "")
        + f"ORDER BY {', '.join(order)} LIMIT %s"
    )
    return await db.fetch(sql, [*([] if vec is None else [vec]), *params, *order_params, candidates])


def _native_words(q: str) -> list[str]:
    """The query's words in other scripts ("জুতা", "जूते", "حذاء"): parse_filters' terms only keep a-z and 0-9."""
    return list(dict.fromkeys(w for w in words(q) if len(w) >= 2 and not re.search(r"[a-z0-9]", w)))


def _sim(row: dict) -> float:
    s = float(row["sim"])
    return s if math.isfinite(s) else 0.0  # pgvector's distance to an all-zero vector is NaN, which JSON can't carry


def _keyword_score(row: dict, terms: list[str], native: list[str] | None = None) -> float:
    terms, native = [w for w in terms if len(w) >= 2], native or []
    if not terms and not native:
        return 0.0
    name, blob = row["name"].lower(), row["content"].lower()
    score = sum(1.0 if w in name else 0.35 if w in blob else 0.0 for w in terms)
    # The catalog is written in English, so a word in another script is one the admin added for shoppers who search
    # in it (keywords, tags): a hit anywhere counts like a hit in the name.
    score += sum(1.0 for w in native if w in blob)
    return min(1.0, score / (len(terms) + len(native)))


async def semantic_search(q: str, limit: int = 8) -> dict:
    t = normalise(q)
    f = parse_filters(t)
    occ = occasion_of(f)
    native = _native_words(q)
    filters = {k: v for k, v in f.items() if k not in ("terms", "occasion")}
    if occ:
        filters["occasion"] = occ["label"]
    filters["terms"] = [*f["terms"], *native]

    vec = embedder().embed([q])[0]
    if not vec.any() or not np.isfinite(vec).all():
        vec = None  # no words at all (only symbols or emoji): ranked by keyword score, then popularity
    candidates = max(50, limit * 5)
    rows = await _query(vec, f, candidates, native)
    relaxed = None
    if not rows:
        loose = {k: v for k, v in f.items() if k not in ("colors", "isNew", "sale")}
        rows = await _query(vec, loose, candidates, native)
        relaxed = "colors/new/sale"
        if not rows:
            rows = await _query(vec, {k: v for k, v in loose.items() if k not in ("min", "max")}, candidates, native)
            relaxed = "colors/new/sale/price"
    if relaxed and rows:
        filters["relaxed"] = relaxed

    terms = [*f["terms"], *(occ["terms"] if occ else [])]
    # Words no product has ("দেখাও", show; a thing the shop doesn't sell) don't water down a hit on one it has ("জুতা").
    native = [w for w in native if any(w in r["content"].lower() for r in rows)]
    scored = [
        {"id": r["id"], "score": round(VECTOR_WEIGHT * _sim(r) + KEYWORD_WEIGHT * _keyword_score(r, terms, native), 4), "_pop": r["popularity"]}
        for r in rows
    ]
    scored.sort(key=lambda x: (-x["score"], -x["_pop"]))
    return {"query": q, "results": [{"id": x["id"], "score": x["score"]} for x in scored[:limit]], "filters": filters}


async def cached_search(q: str, limit: int = 8) -> dict:
    """Pure (user-independent) search results, cached briefly in Redis."""
    r = get_cache()
    try:
        ver = await get_redis().get("search:version") or "0"
        key = f"search:v{ver}:{limit}:" + hashlib.sha1(q.strip().lower().encode()).hexdigest()
        hit = await r.get(key)
        if hit:
            return json.loads(hit)
    except Exception:
        key = None
    res = await semantic_search(q, limit)
    if key:
        try:
            await r.set(key, json.dumps(res), ex=settings.search_cache_ttl)
        except Exception:
            pass
    return res
