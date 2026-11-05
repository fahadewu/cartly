"""Text parsing for Pip's rule-based brain (port of src/agent/brain.js).

Pure functions, no I/O. Filters are plain JSON-serialisable dicts so they can
live in Redis session memory; `occasion` is stored as an index into OCCASIONS.
"""
import re

STOP = set(
    ["a", "an", "the", "i", "im", "i'm", "me", "my", "mine", "we", "our", "you", "your", "it", "its", "is", "are", "am", "was", "be", "been", "to", "for", "of", "in", "on", "at", "by", "with", "and", "or", "but", "so", "some", "any", "something", "anything", "thing", "things", "show", "find", "get", "give", "want", "need", "looking", "look", "search", "please", "can", "could", "would", "like", "love", "lets", "let's", "do", "does", "have", "has", "just", "really", "very", "also", "maybe", "perhaps", "pip", "hey", "hi", "hello", "there", "this", "that", "these", "those", "one", "ones", "stuff", "item", "items", "product", "products", "buy", "shop", "shopping", "see", "me", "more", "about", "what", "which", "who", "how"]
)

GENDER = {
    "men": re.compile(r"\b(men|mens|men's|man|male|guy|guys|him|his|boyfriend|husband|dad|father|brother|son|grandpa|uncle)\b"),
    "women": re.compile(r"\b(women|womens|women's|woman|female|lady|ladies|her|hers|girlfriend|wife|mom|mum|mother|sister|daughter|grandma|aunt)\b"),
}

TYPES = [
    ("Shoes", re.compile(r"\b(shoes?|sneakers?|trainers?|kicks|footwear|runners?|heels?|slip-?ons?)\b")),
    ("Clothing", re.compile(r"\b(clothes|clothing|outfit|wear|dress(es)?|jackets?|coats?|tees?|t-?shirts?|shirts?|hoodies?|sweat(shirt|er)s?|jumpers?|jeans|denim|trousers|pants|poncho|tops?)\b")),
    ("Accessories", re.compile(r"\b(accessor(y|ies)|bags?|handbags?|purse|watch(es)?|sunglasses|shades|caps?|hats?|beanies?|backpacks?)\b")),
    ("Home", re.compile(r"\b(home|house|decor|candles?|plants?|succulents?|cactus|mugs?|cups?|bottles?|kitchen|living)\b")),
]

COLORS = {
    "red": ["Scarlet"],
    "pink": ["Blush"],
    "orange": ["Copper", "Terracotta"],
    "yellow": ["Lemon", "Butter", "Gold"],
    "gold": ["Gold"],
    "green": ["Mint", "Sage"],
    "mint": ["Mint"],
    "blue": ["Cobalt", "Sky", "Ice", "Denim", "Navy"],
    "navy": ["Navy"],
    "black": ["Black"],
    "white": ["White", "Cream"],
    "cream": ["Cream"],
    "grey": ["Stone"],
    "gray": ["Stone"],
    "brown": ["Chestnut", "Tan"],
    "beige": ["Sand", "Tan", "Cream"],
    "tan": ["Tan"],
}
COLOR_RES = {c: re.compile(rf"\b{c}\b") for c in COLORS}

OCCASIONS = [
    {"re": re.compile(r"\b(winter|cold|cosy|cozy|warm|snow|layer(s|ing)?)\b"), "terms": ["hoodie", "jacket", "beanie", "sweatshirt", "candle", "denim", "bomber"], "label": "cosy winter picks"},
    {"re": re.compile(r"\b(party|wedding|date|night out|occasion|dinner|event|dressy|fancy)\b"), "terms": ["dress", "heels", "maxi", "wrap", "leather", "bag"], "label": "going-out pieces"},
    {"re": re.compile(r"\b(run|running|gym|sport|sporty|workout|training|jog)\b"), "terms": ["runner", "trainer", "hoop", "knit", "bottle"], "label": "sporty picks"},
    {"re": re.compile(r"\b(work|office|meeting|smart|formal|interview)\b"), "terms": ["oxford", "shirt", "watch", "backpack", "leather"], "label": "work-ready picks"},
    {"re": re.compile(r"\b(summer|beach|holiday|vacation|sunny|hot)\b"), "terms": ["sunglasses", "shades", "cap", "maxi", "poncho", "woven"], "label": "summer picks"},
    {"re": re.compile(r"\b(relax|lounge|lazy|casual|weekend|comfy|comfortable)\b"), "terms": ["hoodie", "sweatshirt", "tee", "slip", "court"], "label": "laid-back favourites"},
]

# Input is normalised first, so "#2" and "no. 2" arrive as "number 2".
ORDINALS = [
    (re.compile(r"\b(first|1st|number (one|1))\b"), 0),
    (re.compile(r"\b(second|2nd|number (two|2))\b"), 1),
    (re.compile(r"\b(third|3rd|number (three|3))\b"), 2),
    (re.compile(r"\b(fourth|4th|number (four|4))\b"), 3),
    (re.compile(r"\b(fifth|5th|number (five|5))\b"), 4),
    (re.compile(r"\b(sixth|6th|number (six|6))\b"), 5),
    (re.compile(r"\b(last|final)\b"), -1),
]

PAGES = [
    {"re": re.compile(r"\b(orders?|purchases?|order history)\b"), "to": "/orders", "name": "your orders"},
    {"re": re.compile(r"\b(favou?rites?|wishlist|saved|liked)\b"), "to": "/favourites", "name": "your favourites"},
    {"re": re.compile(r"\b(account|profile|settings|password)\b"), "to": "/account", "name": "your account"},
    {"re": re.compile(r"\b(team|members?|invite)\b"), "to": "/team", "name": "your team"},
    {"re": re.compile(r"\b(request|can'?t find|source)\b"), "to": "/request", "name": "the request form"},
    {"re": re.compile(r"\b(inspiration|stories|ideas|lookbook|blog)\b"), "to": "/inspiration", "name": "Inspiration"},
    {"re": re.compile(r"\b(popular|best ?sellers?|trending)\b"), "to": "/popular", "name": "Popular products", "catalog": True},
    {"re": re.compile(r"\b(offers?|deals?|sale|discounts?)\b"), "to": "/collection/offers", "name": "the offers", "catalog": True},
    {"re": re.compile(r"\b(home ?page|explore|start)\b"), "to": "/", "name": "Explore", "catalog": True},
]

SIZE_WORDS = {"extra small": "XS", "extra large": "XL", "small": "S", "medium": "M", "large": "L"}

KNOWN = {
    "gift", "gifts", "present", "cheap", "under", "over", "between", "sale", "new", "popular", "budget", "premium",
    "cheaper", "expensive", "less", "only", "just", "similar", "else", "different", "option", "options", "other", "others",
    "next", "fancier", "nicer", "affordable", "lower", "price", "higher", "end", "trending", "top", "best", "deal", "deals",
    "size", "medium", "small", "large", "nice", "cute", "good", "cool", "great",
    *COLORS.keys(),
}


def test(pattern: str, text: str) -> bool:
    return re.search(pattern, text) is not None


def stem(w: str) -> str:
    w = re.sub(r"'s$", "", w)
    return re.sub(r"(es|s)$", lambda m: "" if len(w) > 3 else m.group(0), w, count=1)


def tokens(text: str) -> list[str]:
    t = re.sub(r"[^a-z0-9$'\s-]", " ", text.lower())
    return [w for w in t.split() if w and w not in STOP]


def normalise(text: str) -> str:
    """Lowercase, '#2'/'no. 2' -> 'number 2', strip punctuation, pad with spaces."""
    t = text.lower()
    t = re.sub(r"(?:#|\bno\.?)\s?(\d)\b", r" number \1 ", t)
    t = re.sub(r"[?!.,]", " ", t)
    t = re.sub(r"\s+", " ", t).strip()
    return f" {t} "


def word_count(t: str) -> int:
    return len(t.strip().split(" "))


def occasion_of(f: dict) -> dict | None:
    i = f.get("occasion")
    return OCCASIONS[i] if isinstance(i, int) and 0 <= i < len(OCCASIONS) else None


def parse_filters(t: str) -> dict:
    f: dict = {}
    women, men = GENDER["women"].search(t), GENDER["men"].search(t)
    if women and not men:
        f["gender"] = "women"
    elif men and not women:
        f["gender"] = "men"

    types = [name for name, rx in TYPES if rx.search(t)]
    if types:
        f["types"] = types
    if test(r"\bgifts?\b|\bpresent\b|\bbirthday\b|\banniversary\b", t):
        f["gift"] = True

    colors = [c for c, rx in COLOR_RES.items() if rx.search(t)]
    if colors:
        f["colors"] = [n for c in colors for n in COLORS[c]]

    m = re.search(r"between\s*\$?(\d+)\s*(?:and|-|to)\s*\$?(\d+)", t)
    if m:
        f["min"], f["max"] = int(m.group(1)), int(m.group(2))
    else:
        m = re.search(r"(?:under|below|less than|cheaper than|max(?:imum)?|up to|within|no more than|budget(?: of| is)?)\s*\$?(\d+)", t)
        if m:
            f["max"] = int(m.group(1))
        m = re.search(r"(?:over|above|more than|at least|from|min(?:imum)?)\s*\$?(\d+)", t)
        if m:
            f["min"] = int(m.group(1))
        if not f.get("max") and not f.get("min"):
            m = re.search(r"\$(\d+)", t)
            if m:
                f["max"] = int(m.group(1))
    if test(r"\b(cheap|affordable|budget|inexpensive|low cost)\b", t) and not f.get("max"):
        f["max"] = 50
    if test(r"\b(premium|luxury|luxurious|expensive|high end|splurge)\b", t) and not f.get("min"):
        f["min"] = 120

    if test(r"\b(sale|deals?|discount(ed)?|offers?|bargains?|reduced)\b", t):
        f["sale"] = True
    if test(r"\b(new|latest|fresh|new in|arrivals?)\b", t):
        f["isNew"] = True
    if test(r"\b(popular|trending|best ?sellers?|top|hot|favourite)\b", t):
        f["sort"] = "popular"
    if test(r"\b(top rated|best rated|highest rated|reviews?)\b", t):
        f["sort"] = "rating"

    for i, occ in enumerate(OCCASIONS):
        if occ["re"].search(t):
            f["occasion"] = i
            break

    f["terms"] = [
        stem(w)
        for w in tokens(t)
        if not re.fullmatch(r"\$?\d+", w) and w not in KNOWN and not GENDER["men"].search(w) and not GENDER["women"].search(w)
    ]
    return f


def ordinal_hit(t: str):
    return next(((rx, i) for rx, i in ORDINALS if rx.search(t)), None)


def parse_size(t: str, product: dict) -> str | None:
    word = next((w for w in SIZE_WORDS if w in t), None)
    if word and SIZE_WORDS[word] in product["sizes"]:
        return SIZE_WORDS[word]
    m = re.search(r"\bsize\s*([a-z0-9]+)\b", t) or re.search(r"\b(xs|xl|s|m|l|\d{2})\b", t)
    if not m:
        return None
    s = m.group(1).upper()
    return next((x for x in product["sizes"] if x.upper() == s), None)


def parse_color(t: str, product: dict) -> str | None:
    names = [n for c, rx in COLOR_RES.items() if rx.search(t) for n in COLORS[c]]
    for c in product["colors"]:
        if c["name"] in names or c["name"].lower() in t:
            return c["name"]
    return None


def money(n) -> str:
    f = float(n)
    return f"${int(f)}" if f.is_integer() else f"${f:.2f}"
