from app.brain.parsing import budget, money, normalise, parse_filters, parse_size, stem, tokens


def test_normalise_ordinals_and_punctuation():
    assert normalise("Add #2, please!") == " add number 2 please "
    assert normalise("no. 3?") == " number 3 "


def test_stem_matches_js():
    assert stem("sneakers") == "sneaker"
    assert stem("dresses") == "dress"
    assert stem("men's") == "men"
    assert stem("bus") == "bus"  # too short to strip


def test_tokens_drop_stopwords():
    assert tokens("Show me some red sneakers") == ["red", "sneakers"]


def test_price_gender_colour_filters():
    f = parse_filters(" red sneakers for him under $100 ")
    assert f["types"] == ["Shoes"] and f["colors"] == ["Scarlet"] and f["gender"] == "men" and f["max"] == 100
    assert f["terms"] == ["sneaker"]
    f = parse_filters(" dresses between 50 and 120 on sale ")
    assert (f["min"], f["max"], f["sale"]) == (50, 120, True)
    assert parse_filters(" something cheap ")["max"] == 50
    assert parse_filters(" new arrivals ")["isNew"] is True
    assert parse_filters(" cosy winter layers ")["occasion"] == 0


def test_parse_size():
    p = {"sizes": ["XS", "S", "M", "L", "XL"]}
    assert parse_size(" medium please ", p) == "M"
    assert parse_size(" size xl ", p) == "XL"
    assert parse_size(" 42 ", {"sizes": ["41", "42"]}) == "42"
    assert parse_size(" whatever ", p) is None


def test_money():
    assert money(98) == "$98" and money(98.5) == "$98.50"


def test_a_budget_in_taka_is_converted_to_the_catalog_s_dollars():
    for msg in ("a gift under 5000 taka", "a gift under ৳5000", "gift within tk 5000", "৫০০০ টাকা gift", "gift 5000tk"):
        f = parse_filters(normalise(msg), 122)
        assert f["max"] == 40.98 and f["rate"] == 122 and f.get("gift"), msg
        assert "taka" not in f["terms"] and "tk" not in f["terms"], msg
    f = parse_filters(normalise("between 2000 and 6000 taka"), 122)
    assert (f["min"], f["max"]) == (16.39, 49.18)
    # Dollars stay dollars, and without a store rate nothing is converted.
    assert parse_filters(normalise("under $50"), 122) == parse_filters(normalise("under $50"))
    assert parse_filters(normalise("under 5000 taka"))["max"] == 5000
    assert budget(40.98, 122) == "৳5,000 (~$41)" and budget(40) == "$40"
