import math

import numpy as np
import pytest

from app.embeddings import DIM, HashingEmbedder, words
from app.search import _keyword_score, product_content


def test_hashing_embedder_shape_and_similarity():
    e = HashingEmbedder()
    v = e.embed(["red sneakers", "scarlet trainers", "porcelain mug"])
    assert v.shape == (3, DIM)
    assert np.allclose(np.linalg.norm(v, axis=1), 1.0, atol=1e-5)
    assert v[0] @ v[1] > v[0] @ v[2]


def test_words_in_every_script():
    # Vowel signs stay in the word (Python's \w would cut "শাড়ি" into pieces); dandas and Arabic-script
    # punctuation separate words; native digits read as ASCII.
    assert words("লাল শাড়ি দেখাও") == ["লাল", "শাড়ি", "দেখাও"]
    assert words("मुझे जूते चाहिए।") == ["मुझे", "जूते", "चाहिए"]
    assert words("أريد حذاء أحمر؟ ۔،٪") == ["أريد", "حذاء", "أحمر"]
    assert words("৫০০ টাকার নিচে") == ["500", "টাকার", "নিচে"]
    # ড় typed as one character or as ড + nukta is one word; the zero-width joiner keyboards put after র splits nothing.
    saree = "\u09b6\u09be\u09a1\u09bc\u09bf"
    assert words("\u09b6\u09be\u09dc\u09bf") == words(saree) == [saree]
    assert words("\u09b0\u200d\u09cd\u09af\u09be\u0995") == ["\u09b0\u09cd\u09af\u09be\u0995"]
    # English reads as before: hyphenated words stay whole, apostrophes and symbols split.
    assert words("Red T-shirt, men's $20") == ["red", "t-shirt", "men", "s", "20"]


@pytest.mark.parametrize(
    "text, similar, unrelated",
    [
        ("লাল শাড়ি", "লাল জামদানি শাড়ি", "সাদা কফির মগ"),  # Bangla: red saree / red jamdani saree / white coffee mug
        ("लाल जूते", "मुझे लाल जूते चाहिए", "चाय का कप"),  # Hindi: red shoes / I want red shoes / tea cup
        ("حذاء أحمر", "أريد حذاء أحمر", "كوب قهوة أبيض"),  # Arabic: red shoe / I want a red shoe / white coffee cup
        ("سرخ جوتے", "مجھے سرخ جوتے چاہئیں", "چائے کا کپ"),  # Urdu: red shoes / I want red shoes / tea cup
    ],
)
def test_hashing_embedder_reads_every_script(text, similar, unrelated):
    v = HashingEmbedder().embed([text, similar, unrelated])
    assert np.allclose(np.linalg.norm(v, axis=1), 1.0, atol=1e-5)  # v1 gave these all-zero vectors
    assert v[0] @ v[1] > v[0] @ v[2]


def test_only_symbols_embed_to_zero():
    v = HashingEmbedder().embed_one("?!… — ৳ ۔ 👗")
    assert not v.any() and np.isfinite(v).all()


def test_keyword_score_counts_a_non_latin_hit_like_a_name_hit():
    row = {"name": "Runner Flow Sneaker", "content": "runner flow sneaker running shoes কেডস জুতা"}
    assert _keyword_score(row, ["sneaker"]) == 1.0  # in the name
    assert _keyword_score(row, ["shoes"]) == 0.35  # elsewhere in the text
    assert _keyword_score(row, [], ["জুতা"]) == 1.0  # only the admin's Bangla keywords carry Bangla words
    assert _keyword_score(row, ["shoes"], ["জুতা"]) == pytest.approx(0.675)


def test_index_populated(client):
    assert client.get("/health").json()["index_size"] == 40


def test_red_sneakers_under_100(client):
    r = client.get("/search", params={"q": "red sneakers under 100", "limit": 5}).json()
    assert r["results"][0]["id"] == 11
    assert r["filters"]["max"] == 100 and r["filters"]["colors"] == ["Scarlet"]


def test_cosy_winter_hoodie_for_men(client):
    r = client.get("/search", params={"q": "cosy winter hoodie for men"}).json()
    assert r["results"][0]["id"] == 21  # Everyday Grey Hoodie (unisex)
    assert r["filters"]["gender"] == "men"


def test_filters_relax_when_nothing_matches(client):
    r = client.get("/search", params={"q": "green heels under 20"}).json()
    assert r["results"] and "relaxed" in r["filters"]


@pytest.mark.parametrize(
    "q, word",
    [
        ("জুতা", "জুতা"),  # shoes
        ("লাল শাড়ি", "লাল"),  # red saree: no saree here, but the red dress has "লাল জামা"
        ("আমাকে একটা লাল শাড়ি দেখাও", "লাল"),  # show me a red saree
    ],
)
def test_bangla_keyword_ranks_its_products_first(client, q, word):
    from app.catalog import catalog

    expected = {p["id"] for p in catalog.products if word in product_content(p)}
    if not expected:
        pytest.skip(f"no product in the local catalog has the keyword {word}")
    r = client.get("/search", params={"q": q, "limit": 20}).json()
    top = r["results"][: len(expected)]
    assert {x["id"] for x in top} == expected
    # The storefront's catalog search drops semantic hits under 0.12, so these must clear it.
    assert all(x["score"] >= 0.12 for x in top)
    assert word in r["filters"]["terms"]


def test_bangla_keyword_hits_stay_candidates_in_a_big_catalog(client):
    # Past 50 products only the nearest vectors get scored, and hashing noise can outweigh a one-word Bangla match
    # (for "show me a red saree" the vector alone ranks a canvas shoe and a backpack above the red dress).
    from app import search
    from app.catalog import catalog

    q = "আমাকে একটা লাল শাড়ি দেখাও"
    expected = {p["id"] for p in catalog.products if "লাল" in product_content(p)}
    if not expected:
        pytest.skip("no product in the local catalog has the keyword লাল")
    vec = search.embedder().embed([q])[0]
    rows = client.portal.call(search._query, vec, {}, len(expected), search._native_words(q))
    assert {r["id"] for r in rows} == expected


def test_query_without_words_ranks_by_popularity(client):
    # Only symbols: no vector to compare with (pgvector's distance to it is NaN, sent as null before), so the
    # keyword score and then popularity decide, and every score is a number.
    from app.catalog import catalog

    r = client.get("/search", params={"q": "?!", "limit": 8}).json()
    popularity = {p["id"]: p["popularity"] for p in catalog.products}
    assert [popularity[x["id"]] for x in r["results"]] == sorted(popularity.values(), reverse=True)[:8]
    assert all(x["score"] == 0 for x in r["results"])


@pytest.mark.parametrize("q", ["मुझे जूते चाहिए", "أريد حذاء أحمر", "পাঞ্জাবি"])
def test_scores_are_always_numbers(client, q):
    r = client.get("/search", params={"q": q}).json()
    assert r["results"] and all(isinstance(x["score"], float) and math.isfinite(x["score"]) for x in r["results"])
