def ids(reply):
    return reply.get("products") or []


def action_types(reply):
    return [a["type"] for a in reply.get("actions", [])]


def test_search_then_ordinal_add_with_size_followup(brain, ai_tryon):
    m = {}
    r = brain.respond("show me dresses", m, {})
    assert ids(r) == [17, 18] and "Try on number 1" in r["chips"]
    r = brain.respond("add the second one", m, {})
    assert "Which size" in r["text"] and m["pending"]["id"] == 18
    r = brain.respond("large", m, {})
    assert r["actions"] == [{"type": "add", "id": 18, "size": "L", "color": "Scarlet"}]
    assert m["pending"] is None


def test_out_of_range_ordinal(brain):
    m = {}
    brain.respond("show me dresses", m, {})
    r = brain.respond("add the fifth one", m, {})
    assert r["text"].startswith("I only showed you 2 items")


def test_try_on_without_photo_asks_for_photo(brain, ai_tryon):
    m = {}
    brain.respond("show me dresses", m, {})
    r = brain.respond("try on number 1", m, {"tryOn": {"hasPhoto": False, "on": []}})
    assert r["actions"] == [{"type": "tryon", "id": 17}] and "full-length photo" in r["text"]
    r = brain.respond("try on #1", m, {"tryOn": {"hasPhoto": True, "on": []}})
    assert "fitted" in r["text"] and r["chips"][0] == "Try on heels"


def test_try_on_search_and_not_wearable(brain, ai_tryon):
    m = {}
    r = brain.respond("try on a red dress", m, {"tryOn": {"hasPhoto": True, "on": []}})
    assert action_types(r) == ["tryon"] and r["actions"][0]["id"] in (17, 18)
    m = {"results": [29], "focus": 29}
    r = brain.respond("try it on", m, {})
    assert "isn’t something you can wear" in r["text"]


def test_clothes_need_the_ai_tryon_when_it_is_off(brain):
    m = {}
    r = brain.respond("show me dresses", m, {})
    assert ids(r) == [17, 18] and "Try on number 1" not in r["chips"]
    r = brain.respond("try on number 1", m, {"tryOn": {"hasPhoto": True, "on": []}})
    assert "need the AI try-on" in r["text"] and not r.get("actions")
    r = brain.respond("try on a red dress", {}, {"tryOn": {"hasPhoto": True, "on": []}})
    assert "need the AI try-on" in r["text"]
    # Accessories still work in the on-device preview.
    r = brain.respond("try on sunglasses", {}, {"tryOn": {"hasPhoto": True, "on": []}})
    assert action_types(r) == ["tryon"] and r["actions"][0]["id"] in (24, 35)


def test_fit_adjustments_and_look(brain):
    ctx = {"tryOn": {"hasPhoto": True, "on": [{"id": 17, "name": "Scarlet Wrap Dress"}]}}
    m = {}
    assert brain.respond("make it bigger", m, ctx)["actions"] == [{"type": "adjust", "op": "bigger", "all": False}]
    assert brain.respond("a bit more", m, ctx)["actions"] == [{"type": "adjust", "op": "bigger"}]
    assert brain.respond("move it up", m, ctx)["actions"][0]["op"] == "up"
    assert brain.respond("reset everything", m, ctx)["actions"] == [{"type": "adjust", "op": "reset", "all": True}]
    assert action_types(brain.respond("take it off", m, ctx)) == ["untry"]
    assert action_types(brain.respond("take everything off", m, ctx)) == ["clearLook"]
    assert action_types(brain.respond("add the look to cart", m, ctx)) == ["buyLook"]
    assert action_types(brain.respond("open the fitting room", m, ctx)) == ["fittingRoom"]
    assert action_types(brain.respond("use a sample model", m, ctx)) == ["sampleModel"]


def test_refinements(brain):
    m = {}
    brain.respond("show me shoes", m, {})
    first = list(m["results"])
    r = brain.respond("show more", m, {})
    assert set(ids(r)).isdisjoint(first) and m["offset"] == 4
    cheapest = min(brain.product(i)["price"] for i in m["results"])
    r = brain.respond("cheaper", m, {})
    assert ids(r) and all(brain.product(i)["price"] < cheapest for i in ids(r))
    r = brain.respond("only on sale", m, {})
    assert all(brain.product(i)["compareAt"] for i in ids(r))


def test_cart_orders_nav_and_smalltalk(brain):
    ctx = {"cart": [{"name": "Mug", "qty": 2, "price": 18}], "cartTotal": 36, "orders": [{"id": "CL-1", "status": "SHIPPED", "total": 50, "items": [{}]}]}
    m = {}
    assert action_types(brain.respond("checkout", m, ctx)) == ["navigate"]
    assert brain.respond("what's in my cart", m, ctx)["actions"] == [{"type": "openCart"}]
    assert brain.respond("reorder", m, ctx)["actions"] == [{"type": "reorder", "id": "CL-1"}]
    assert "shipped" in brain.respond("where is my order", m, ctx)["text"]
    assert brain.respond("take me to my favourites", m, ctx)["actions"] == [{"type": "navigate", "to": "/favourites"}]
    assert brain.respond("hi", m, {"userName": "Maya"})["mood"] == "happy"
    assert "Pip" in brain.respond("who are you", m, {})["text"]
    assert brain.respond("checkout", m, {})["mood"] == "sorry"


def test_details_compare_save_and_unknown(brain):
    m = {}
    brain.respond("show me dresses", m, {})
    r = brain.respond("tell me about number 2", m, {})
    assert ids(r) == [18] and "Flowing Maxi Dress" in r["text"]
    r = brain.respond("compare them", m, {})
    assert ids(r) == [17, 18]
    assert brain.respond("save the first one", m, {})["actions"] == [{"type": "like", "id": 17}]
    r = brain.respond("snowboard", {}, {})
    assert "don't think we carry" in r["text"] and "Request this product" in r["chips"]


def test_preview(brain):
    assert brain.preview("re") == []
    assert brain.preview("um so") == []
    assert 11 in brain.preview("red sneakers")


def test_fit_question_uses_what_shoppers_reported(brain):
    dress = brain.product(17)
    old = dress.get("fitVerdict")
    try:
        dress["fitVerdict"] = "small"
        r = brain.respond("does it run small?", {"results": [17], "focus": 17}, {})
        assert "runs small" in r["text"] and "one size up" in r["text"] and r["askSize"] == 17
        dress["fitVerdict"] = None
        r = brain.respond("what size should I get", {"results": [17], "focus": 17}, {})
        assert "Not enough shoppers" in r["text"]
    finally:
        dress["fitVerdict"] = old


def test_a_complaint_gets_an_apology_and_a_person_when_the_store_has_one(brain):
    orders = [{"id": "CL-20931", "status": "SHIPPED", "total": 99, "items": []}]
    brain.catalog.support = {}
    r = brain.respond("my parcel never arrived, worst service", {}, {"orders": orders})
    assert r["mood"] == "sorry" and "CL-20931" in r["text"] and not r.get("actions") and not r.get("products")
    brain.catalog.support = {"whatsapp": True, "phone": False, "hours": None}
    try:
        for msg in ("taka kete niche kintu order pai nai", "আমি পণ্য পাইনি", "I was charged twice!"):
            r = brain.respond(msg, {}, {"orders": orders})
            assert r["actions"] == [{"type": "human"}] and r["mood"] == "sorry", msg
        assert brain.respond("show me a red dress", {}, {}).get("actions") != [{"type": "human"}]
    finally:
        brain.catalog.support = {}


def test_a_taka_budget_is_answered_in_taka(brain):
    old = brain.catalog.payments
    brain.catalog.payments = {"methods": [], "usdToBdt": 122}
    try:
        memory = {}
        r = brain.respond("I need a birthday gift for my sister under 5000 taka", memory, {})
        assert r["products"] and all(brain.product(i)["price"] <= 40.98 for i in r["products"])
        assert "$5000" not in r["text"]
        assert "৳5,000 (~$41)" in brain.describe(memory["filters"], 2)
    finally:
        brain.catalog.payments = old


def test_anything_with_a_wish_is_a_search_not_a_surprise(brain):
    r = brain.respond("Anything for a beach day? Maybe sunglasses", {}, {})
    assert "random" not in r["text"] and r["products"]
    assert all(brain.product(i)["type"] == "Accessories" for i in r["products"])
    assert "random" in brain.respond("surprise me", {}, {})["text"]
    assert "random" in brain.respond("anything", {}, {})["text"]
