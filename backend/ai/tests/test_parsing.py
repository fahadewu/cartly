from app.brain.parsing import money, normalise, parse_filters, parse_size, stem, tokens


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
