import asyncio
import json

import httpx
import pytest

from app import tryon, usage

from .fakes import FakeRedis, Settings

PERSON = "data:image/jpeg;base64,cGVyc29u"


class FakeFashn:
    """Pretends to be api.fashn.ai: every job 'wears' the product by appending its name."""

    def __init__(self, fail_with=None):
        self.runs: list[dict] = []
        self.fail_with = fail_with
        self.jobs: dict[str, dict] = {}

    def handler(self, request: httpx.Request) -> httpx.Response:
        if request.url.host == "localhost":  # a product photo served by the local API
            return httpx.Response(200, content=b"jpegbytes", headers={"content-type": "image/jpeg"})
        assert request.headers["authorization"] == "Bearer test-key"
        if request.url.path == "/v1/run":
            body = json.loads(request.content)
            assert body["model_name"] == "tryon-max" and body["inputs"]["return_base64"] is True
            self.runs.append(body["inputs"])
            job = f"job{len(self.runs)}"
            self.jobs[job] = body["inputs"]
            return httpx.Response(200, json={"id": job, "error": None})
        job = request.url.path.rsplit("/", 1)[-1]
        if self.fail_with:
            return httpx.Response(200, json={"id": job, "status": "failed", "error": {"name": self.fail_with, "message": "x"}})
        inputs = self.jobs[job]
        return httpx.Response(200, json={"id": job, "status": "completed", "output": [f"{inputs['model_image']}+{inputs['product_image'][-12:]}"]})


@pytest.fixture
def env(monkeypatch):
    s = Settings()
    s(fashn_api_key="test-key", tryon_hourly_limit=5)
    redis = FakeRedis()
    for fn in ("get_redis", "get_cache"):
        monkeypatch.setattr(tryon, fn, lambda: redis)
    monkeypatch.setattr(usage, "get_redis", lambda: redis)
    real_sleep = asyncio.sleep
    monkeypatch.setattr(tryon.asyncio, "sleep", lambda s: real_sleep(0))
    yield redis
    s.restore()


def render(fake, items, scope="u1", **kw):
    async def go():
        async with httpx.AsyncClient(transport=httpx.MockTransport(fake.handler)) as http:
            return await tryon.render(scope, PERSON, items, http=http, **kw)

    return asyncio.run(go())


SHIRT = {"key": 5, "image": "https://images.example.com/shirt.jpg", "slot": "top"}
JEANS = {"key": 19, "image": "https://images.example.com/jeans.jpg", "slot": "bottom"}
SHADES = {"key": 24, "image": "http://localhost:3000/api/v1/uploads/tryon/shades.jpg", "slot": "eyes"}


def test_layers_innermost_first_and_caches_every_step(env):
    fake = FakeFashn()
    out = render(fake, [SHIRT, JEANS])
    assert [r["product_image"] for r in fake.runs] == [JEANS["image"], SHIRT["image"]]  # bottoms before the top
    assert out == {"image": out["image"], "steps": 2, "rendered": 2, "cached": 0}
    # Adding sunglasses re-uses the cached two-item look: one new render.
    out = render(fake, [SHIRT, JEANS, SHADES])
    assert out["rendered"] == 1 and out["cached"] == 2 and len(fake.runs) == 3
    # The local photo is sent as base64 (FASHN can't reach localhost); the accessory gets a placement hint.
    assert fake.runs[2]["product_image"].startswith("data:image/jpeg;base64,")
    assert fake.runs[2]["prompt"] == "wearing these glasses"
    # Taking the sunglasses off again costs nothing.
    assert render(fake, [JEANS, SHIRT])["rendered"] == 0 and len(fake.runs) == 3


def test_styling_notes_change_the_render(env):
    fake = FakeFashn()
    render(fake, [SHIRT])
    render(fake, [{**SHIRT, "notes": "tuck in the shirt"}])
    assert len(fake.runs) == 2 and fake.runs[1]["prompt"] == "tuck in the shirt"


def test_prompt_names_the_item(env):
    fake = FakeFashn()
    render(fake, [{**SHADES, "name": "Classic Black Shades", "notes": "pushed up on the head"}])
    assert fake.runs[0]["prompt"] == "only the Classic Black Shades, wearing these glasses, pushed up on the head"


def test_cache_is_per_shopper(env):
    fake = FakeFashn()
    render(fake, [SHIRT], scope="alice")
    render(fake, [SHIRT], scope="bob")
    assert len(fake.runs) == 2


def test_sample_model_looks_are_shared_between_shoppers(env):
    fake = FakeFashn()
    render(fake, [SHIRT], scope="alice", cache_scope="sample")
    out = render(fake, [SHIRT], scope="bob", cache_scope="sample")
    assert len(fake.runs) == 1 and out["cached"] == 1
    assert "tryon:quota:bob" not in " ".join(env.data)  # cached looks don't count against the hour


def test_a_new_product_photo_renders_again(env):
    fake = FakeFashn()
    render(fake, [SHIRT])
    render(fake, [{**SHIRT, "image": "https://images.example.com/shirt-v2.jpg"}])
    assert len(fake.runs) == 2


def test_the_same_look_requested_twice_at_once_renders_once(env):
    fake = FakeFashn()

    async def go():
        async with httpx.AsyncClient(transport=httpx.MockTransport(fake.handler)) as http:
            return await asyncio.gather(*(tryon.render("u1", PERSON, [SHIRT], http=http) for _ in range(2)))

    first, second = asyncio.run(go())
    assert len(fake.runs) == 1 and first["image"] == second["image"]


def test_daily_budget_stops_new_renders_but_not_cached_ones(env):
    fake = FakeFashn()
    render(fake, [SHIRT])
    assert env.hashes[usage.day_key()]["fashn:credits"] == "2.0"  # balanced, 1k
    s = Settings()
    s(tryon_daily_budget=0.1)
    try:
        assert render(fake, [SHIRT])["cached"] == 1  # still free
        with pytest.raises(tryon.TryOnError) as e:
            render(fake, [SHIRT, JEANS])
        assert e.value.status == 503 and len(fake.runs) == 1
    finally:
        s.restore()


def test_hourly_quota(env):
    fake = FakeFashn()
    render(fake, [SHIRT, JEANS, SHADES])
    with pytest.raises(tryon.TryOnError) as e:
        render(fake, [{**SHIRT, "notes": "a"}, {**JEANS, "notes": "b"}, {**SHADES, "notes": "c"}])
    assert e.value.status == 429 and e.value.code == "tryon_quota"


def test_moderation_failure_is_a_clear_422(env):
    with pytest.raises(tryon.TryOnError) as e:
        render(FakeFashn(fail_with="ContentModerationError"), [SHIRT])
    assert e.value.status == 422 and "different one" in str(e.value)


def test_catalog_thumbnails_are_upgraded_to_full_size():
    thumb = "https://images.unsplash.com/photo-1572804013309-59a88b7e92f1?w=600&q=80&auto=format&fit=crop"
    assert tryon.best_source(thumb) == "https://images.unsplash.com/photo-1572804013309-59a88b7e92f1?w=1600&q=90&auto=format"
    assert tryon.best_source("https://cdn.example.com/x.jpg?w=600") == "https://cdn.example.com/x.jpg?w=600"


def test_public_urls():
    assert tryon._public("https://images.unsplash.com/photo-1?w=900")
    assert not tryon._public("http://images.unsplash.com/photo-1")
    assert not tryon._public("https://localhost:3000/x.jpg")
    assert not tryon._public("https://10.0.0.5/x.jpg")
