import asyncio

from app import llm, product_details, usage

from .fakes import FakeAnthropic, FakeRedis, Settings, text_message


def test_suggestions_keep_to_the_vocabulary_and_tidy_the_words(monkeypatch):
    s = Settings()
    s(anthropic_api_key="test")
    monkeypatch.setattr(usage, "get_redis", lambda: FakeRedis())
    fake = FakeAnthropic(text_message({
        "material": " Waxed canvas ", "fit": "slim", "fitNotes": "", "occasions": ["everyday", "rooftop", "everyday"],
        "seasons": ["all-season"], "styleTags": ["Heritage", "heritage", "Casual"], "features": ["Waxed canvas", "Suede overlays"],
        "keywords": ["Sneakers", "কেডস", "keds", "sneakers"], "careNotes": "", "description": "",
    }))
    llm.set_client(fake)
    try:
        out = asyncio.run(product_details.suggest({"name": "Tan Canvas Court", "type": "Shoes", "description": "Canvas shoes"}, None))
    finally:
        llm.set_client(None)
        s.restore()
    assert out["material"] == "Waxed canvas" and out["fit"] is None  # shoes have no fit
    assert out["occasions"] == ["everyday"] and out["styleTags"] == ["heritage", "casual"]
    assert out["keywords"] == ["sneakers", "কেডস", "keds"]
    prompt = fake.calls[0]["messages"][0]["content"][-1]["text"]
    assert "Banglish" in prompt and "a better description" in prompt  # the current one is short
    assert fake.calls[0]["output_config"]["format"]["schema"]["properties"]["occasions"]["items"]["enum"] == product_details.OCCASIONS


def test_search_finds_products_by_the_names_shoppers_use(client):
    ids = [r["id"] for r in client.get("/search", params={"q": "কেডস", "limit": 5}).json()["results"]]
    shoes = {1, 2, 3, 7, 11, 12, 13, 16}
    assert ids and set(ids[:3]) <= shoes
