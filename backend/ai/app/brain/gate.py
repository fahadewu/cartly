"""Pip's relevance gate: a free check on each chat message before Claude (microseconds, no network).

Precision first: a wrong decline loses a shopper, a miss costs about a cent and Claude still declines.
So the gate never declines on topic words: "a watch for my lawyer brother", "jacket for this rainy
weather", "kurta for jummah", "আল্লাহ হাফেজ" all reach Claude or get a closer. It declines only:
- role tags aimed at Pip's prompt ("</context>", "[INST]", "SYSTEM:" at a line start, "[admin note: …]"),
  even with shopping words around them;
- when nothing in the message is about shopping and it isn't an answer to Pip: unambiguous task shapes
  (maths, code, "write me an essay", "translate this: …", homework, trivia, news and forecasts, jokes,
  "which AI are you", recipes, "which medicine should I take", tickets, jobs, film picks), injection
  phrasing aimed at Pip's own instructions, and noise (only punctuation, or a speech-to-text artefact on
  a voice turn).
A plain thank-you or goodbye gets a "closer" (also right after cards, never right after Pip's question).
Anything else goes to Claude ("unsure").

Order: role tags > follow-up window > noise > shopping signal > injection phrasing > off-topic tasks >
closers > unsure. A decline also needs the message's language to have templates (templates.LANGS,
switched on in PIP_TEMPLATE_LANGS); when the language isn't clear, Claude answers. The labelled corpus
and its recall figures are in tests/data/relevance_cases.json and tests/test_gate.py.
"""
import json
import re
import unicodedata
from dataclasses import dataclass
from functools import lru_cache

from ..config import settings
from . import templates


@dataclass(frozen=True)
class Verdict:
    """What the gate makes of one message. Only `action` says what to do: "pass" (send to Claude),
    "decline" (a template, no Claude) or "closer" (a template thank-you or goodbye). `kind` is what the
    message looks like ("shop", "followup", "unsure", "offtopic", "injection", "junk", "closer"); it can
    be a declining kind with action "pass" when the language has no templates. `lang` is the template
    language for the reply (None when unsure: never a decline). `rule` names what decided it, for
    metering. `signal`: the message has something about shopping in it, or answers Pip's own question or
    its cards (what gets a message past a cooldown)."""

    action: str
    kind: str
    lang: str | None
    rule: str
    signal: bool


# ---------- normalising ----------
# One alphabet for the message and every word list: NFC; no zero-width, direction or tatweel marks,
# nukta or Arabic vowel marks; native digits as ASCII; one kind of quote and dash; casefolded.
_DELETE = "\u200b\u200c\u200d\u2060\ufeff\u00ad\u200e\u200f\u061c\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069\u0640\u093c\u09bc"
_NORM = str.maketrans(
    {
        **{ord(c): None for c in _DELETE},
        **{cp: None for cp in range(0x064B, 0x0660)},
        0x0670: None,
        **{ord(c): str(i) for block in ("০১২৩৪৫৬৭৮৯", "०१२३४५६७८९", "٠١٢٣٤٥٦٧٨٩", "۰۱۲۳۴۵۶۷۸۹") for i, c in enumerate(block)},
        **{ord(c): "'" for c in "\u2019\u2018\u02bc`\u00b4\u02b9"},
        **{ord(c): '"' for c in "\u201c\u201d\u201e\u00ab\u00bb"},
        **{ord(c): "-" for c in "\u2010\u2011\u2012\u2013\u2212"},
        ord("\u2014"): " \u2014 ",
        ord("\u0901"): "\u0902",
    }
)
# Spellings that vary with the keyboard or the typist, matched as one: Arabic-script letter forms
# (Arabic and Urdu keyboards), Bangla and Hindi long/short vowels, Hindi's English-loan vowels.
_FOLD = str.maketrans(
    {
        "ك": "ک", "ي": "ی", "ى": "ی", "ئ": "ی", "ه": "ہ", "ھ": "ہ", "ة": "ہ", "ۃ": "ہ", "ۀ": "ہ",
        "أ": "ا", "إ": "ا", "آ": "ا", "ٱ": "ا", "ؤ": "و", "ۓ": "ے",
        "ী": "ি", "ূ": "ু", "ঈ": "ই", "ঊ": "উ",
        "ी": "ि", "ू": "ु", "ई": "इ", "ऊ": "उ", "ॉ": "ो", "ॅ": "े", "ऑ": "ओ", "ऍ": "ए",
    }
)
# Look-alike Cyrillic and Greek letters inside a Latin word ("іgnore" with a Cyrillic і).
_SPOOF = str.maketrans("\u0430\u0435\u043e\u0440\u0441\u0443\u0445\u0456\u0458\u0455\u0501\u04cf\u043a\u043c\u0442\u0432\u043d\u03bf\u03b1\u03b5\u03b9\u03c1\u03c4\u03c5\u03bd\u03ba", "aeopcyxijsdlkmtbhoaeiptuvk")
_GREEK_CYRILLIC = re.compile(r"[\u0370-\u03ff\u0400-\u04ff]")
_SPOOF_WORD = re.compile(r"[a-z\u0370-\u03ff\u0400-\u04ff]+")


def normalise(text: str) -> str:
    t = unicodedata.normalize("NFC", text).translate(_NORM).casefold()
    if _GREEK_CYRILLIC.search(t):  # only words that mix them with Latin letters: Russian stays Russian
        t = _SPOOF_WORD.sub(lambda m: m.group().translate(_SPOOF) if _mixed(m.group()) else m.group(), t)
    return t


def _mixed(word: str) -> bool:
    return bool(re.search("[a-z]", word)) and bool(_GREEK_CYRILLIC.search(word))


def fold(text: str) -> str:
    return text.translate(_FOLD)


# ---------- tokenising ----------
# Letters and combining marks per script (Python's \w drops Indic vowel signs, so it can't be used).
# Arabic-script punctuation (، ؛ ؟ ۔ ٪) and the dandas (। ॥) separate words; native digits are ASCII.
_LAT = "a-z0-9\u00b5\u00df-\u00f6\u00f8-\u00ff\u0100-\u024f\u0300-\u036f\u1e00-\u1eff"
_BN = "\u0980-\u09e3\u09f0\u09f1\u09fc\u09fe"
_DV = "\u0900-\u0963\u0971-\u097f\ua8e0-\ua8ff"
_AR = (
    "\u0610-\u061a\u0620-\u063f\u0641-\u065f\u066e-\u06d3\u06d5-\u06dc\u06df-\u06e8\u06ea-\u06ef\u06fa-\u06fc"
    "\u06ff\u0750-\u077f\u08a0-\u08ff\ufb50-\ufd3d\ufd50-\ufdfb\ufe70-\ufefc"
)
_IND = "\u0a00-\u0dff\u0e00-\u0eff\u0f00-\u0fff\u1000-\u109f\u1780-\u17ff\u0483-\u0489\u0591-\u05c7\u1ab0-\u1aff\u1dc0-\u1dff\u20d0-\u20ff\ufe20-\ufe2f"
# Any other script (Tamil, Thai, Cyrillic, CJK…) is still words, never noise.
TOKEN = re.compile(
    rf"[{_LAT}]+(?:['\-][{_LAT}]+)*|[{_BN}]+|[{_DV}]+|[{_AR}]+|(?:[^\W\d_{_LAT}{_BN}{_DV}{_AR}]|[{_IND}])+"
)
_SCRIPT_OF = (("latin", re.compile(f"[{_LAT}]")), ("bn", re.compile(f"[{_BN}]")), ("deva", re.compile(f"[{_DV}]")), ("arab", re.compile(f"[{_AR}]")))


def tokens(text: str) -> list[str]:
    """Words of a normalised, folded text, in any script."""
    return TOKEN.findall(text)


@lru_cache(maxsize=16384)
def _script(tok: str) -> str:
    for ch in tok:
        if not ch.isdigit():
            for name, rx in _SCRIPT_OF:
                if rx.match(ch):
                    return name
            return "other"
    return "num"


def _prep(text: str) -> str:
    return fold(normalise(text))


# ---------- inflections ----------
def _suffixes(*words: str) -> tuple[str, ...]:
    return tuple(sorted({_prep(w) for w in words}, key=len, reverse=True))


_BN_SUF = _suffixes("গুলো", "গুলি", "গুলা", "দের", "টার", "টির", "টাতে", "টায়", "টা", "টি", "খানা", "খানি", "কে", "তে", "এর", "ের", "র", "য়", "ে", "ও", "ই")
_DV_SUF = _suffixes("ियों", "ियां", "ाओं", "ाएं", "ुओं", "ने", "ना", "नी", "कर", "ूं", "ों", "ें", "ो", "े", "ी", "ा", "ं")
_AR_SUF = _suffixes("یوں", "یاں", "ات", "ین", "ون", "وں", "یں", "ہا", "ے", "ی", "ہ", "ا")
_AR_PRE = _suffixes("وال", "بال", "فال", "کال", "لل", "ال")
_LAT_PLURAL = (("ies", "y"), ("ches", "ch"), ("shes", "sh"), ("xes", "x"), ("ses", "s"), ("'s", ""), ("s", ""))
_LAT_SUF = ("gulo", "gula", "guli", "der", "ta", "ti", "te", "ke", "er", "re", "r", "e")


def _stems(tok: str) -> set[str]:
    """Inflections stripped the same way from words in the lists and in messages (plurals, Hindi and
    Urdu gender/number endings, Arabic sound plurals)."""
    out = set()
    script = _script(tok)
    if script == "latin":
        for suf, rep in _LAT_PLURAL:
            if tok.endswith(suf) and len(tok) - len(suf) >= 3 and not tok.endswith(("ss", "us", "is")):
                out.add(tok[: -len(suf)] + rep)
                break
    elif script == "deva":
        out |= {tok[: -len(s)] for s in _DV_SUF if tok.endswith(s) and len(tok) - len(s) >= 3}
    elif script == "arab":
        out |= {tok[: -len(s)] for s in _AR_SUF if tok.endswith(s) and len(tok) - len(s) >= 3}
    return out


@lru_cache(maxsize=16384)
def _variants(tok: str) -> frozenset[str]:
    """A message word and the base forms it may inflect (Bangla case endings, Banglish "-ta"/"-er",
    Arabic articles and prefixes, "t-shirt" = "tshirt"), to match words in the lists."""
    out = {tok} | _stems(tok)
    script = _script(tok)
    if script == "latin":
        if "'" in tok or "-" in tok:
            parts = [p for p in re.split(r"['\-]", tok) if len(p) > 1]
            out |= set(parts) | {re.sub(r"['\-]", "", tok)}
            if tok.endswith("'s"):
                out.add(tok[:-2])
        out |= {tok[: -len(s)] for s in _LAT_SUF if tok.endswith(s) and len(tok) - len(s) >= (3 if len(s) > 1 else 4)}
    elif script == "bn":
        for s in _BN_SUF:
            if tok.endswith(s) and len(tok) - len(s) >= 2:
                stem = tok[: -len(s)]
                out.add(stem)
                out |= {stem[: -len(s2)] for s2 in _BN_SUF if stem.endswith(s2) and len(stem) - len(s2) >= 2}
    elif script == "arab":
        bases = {tok} | {tok[len(p):] for p in _AR_PRE if tok.startswith(p) and len(tok) - len(p) >= 3}
        bases |= {tok[1:] for p in ("و", "ب", "ل", "ف") if tok.startswith(p) and len(tok) >= 4}
        for b in bases:
            out.add(b)
            out |= _stems(b)
    return frozenset(out)


def _lex(*groups: str) -> tuple[set[str], set[str]]:
    """Comma-separated words and phrases -> (single words with their stems, phrases of 2-4 words)."""
    words, phrases = set(), set()
    for group in groups:
        for entry in group.split(","):
            toks = tokens(_prep(entry.strip()))
            if len(toks) == 1:
                words.add(toks[0])
                words |= _stems(toks[0])
            elif 2 <= len(toks) <= 4:
                phrases.add(" ".join(toks))
    return words, phrases


def _set(*groups: str) -> set[str]:
    words, phrases = _lex(*groups)
    return words | phrases


def _rx(*alternatives: str) -> re.Pattern:
    """A pattern over the message's words joined by single spaces (no punctuation), written in plain
    spelling and folded like the message. Words are separated by " "; [^ ] is a letter of a word."""
    body = "|".join(_prep(a) for a in alternatives)
    return re.compile(f"(?<= )(?:{body})(?= )")


# ---------- shopping signal (seed lists; the catalog adds its own words) ----------
SIGNAL_WORDS, SIGNAL_PHRASES = _lex(
    # English: store, orders, payment, delivery, sizes and prices
    "shop, shopping, buy, buying, bought, purchase, sell, sells, selling, order, orders, ordered, reorder, cart, basket, "
    "checkout, check out, wishlist, favourite, favourites, favorite, favorites, price, prices, pricing, cost, costs, cheap, "
    "cheaper, cheapest, expensive, pricey, affordable, budget, discount, discounts, discounted, offer, offers, deal, deals, "
    "sale, sales, clearance, coupon, coupons, promo, promo code, coupon code, discount code, voucher, vouchers, cashback, "
    "bogo, stock, in stock, out of stock, sold out, restock, available, availability, size, sizes, sizing, size chart, "
    "fit, fits, fitting, fitting room, try on, try-on, tryon, trial room, delivery, deliver, delivered, shipping, ship, "
    "shipped, courier, parcel, package, track, tracking, rider, return, returns, returned, refund, refunds, exchange, "
    "exchanges, cancel, cancelled, canceled, cancellation, payment, payments, pay, paid, cod, cash on delivery, bkash, "
    "bikash, nagad, rocket, card, credit card, debit card, visa, mastercard, amex, emi, instalment, installment, invoice, "
    "receipt, taka, tk, bdt, usd, dollar, dollars, rupee, rupees, inr, pkr, cartly, pathao, steadfast, redx, login, log in, "
    "sign in, sign up, account, otp, forgot password, reset password, new arrivals, new arrival, new in, collection, "
    "collections, catalog, catalogue, brand, brands, quality, material, fabric, product, products, item, items, add to cart, "
    "add it, add this, money back, "
    # English: clothes, shoes, accessories, home and gifts
    "clothes, clothing, garment, garments, apparel, outfit, outfits, wear, wears, wearing, worn, dress up, dressed, look, "
    "looks, new look, style, styles, styling, stylish, stylist, fashion, fashionable, trend, trends, trending, trendy, "
    "matching, pair with, goes with, wardrobe, gift, gifts, gifting, present, presents, hamper, gift box, gift wrap, "
    "gift card, shoe, shoes, footwear, sneaker, sneakers, trainer, trainers, kicks, boot, boots, sandal, sandals, heel, "
    "heels, slipper, slippers, flip flops, loafer, loafers, flats, keds, slip-on, plimsolls, moccasins, mules, crocs, jutti, "
    "mojari, kolhapuri, dress, dresses, gown, gowns, frock, frocks, maxi, saree, sarees, sari, saris, sharee, salwar, "
    "kameez, shalwar, churidar, kurta, kurtas, kurti, kurtis, panjabi, punjabi, pajama, pyjama, pajamas, pyjamas, lehenga, "
    "lehnga, sherwani, achkan, abaya, abayas, hijab, hijabs, niqab, burqa, burka, borka, khimar, jilbab, thobe, thawb, "
    "jubba, kaftan, caftan, scarf, scarves, shawl, shawls, stole, dupatta, orna, urna, lungi, fatua, tupi, topi, kufi, "
    "prayer cap, prayer mat, jaynamaz, janamaz, tasbih, attar, mukena, tudung, shirt, shirts, t-shirt, tshirt, tee, tees, "
    "polo, top, tops, blouse, blouses, tunic, jacket, jackets, coat, coats, raincoat, overcoat, blazer, blazers, suit, "
    "suits, waistcoat, hoodie, hoodies, sweater, sweaters, sweatshirt, sweatshirts, jumper, jumpers, cardigan, cardigans, "
    "fleece, poncho, cape, jeans, denim, denims, trousers, pants, chinos, shorts, skirt, skirts, leggings, jeggings, joggers, "
    "tracksuit, trackpants, palazzo, culottes, overalls, dungarees, jumpsuit, romper, nightwear, sleepwear, nightdress, "
    "nightie, lingerie, bra, underwear, innerwear, socks, stockings, tights, uniform, apron, jersey, jerseys, kit, swimsuit, "
    "swimwear, bikini, bag, bags, handbag, handbags, purse, purses, tote, backpack, backpacks, rucksack, satchel, sling bag, "
    "crossbody, clutch, wallet, wallets, pouch, luggage, suitcase, trolley, duffel, belt, belts, watch, watches, wristwatch, "
    "smartwatch, fitness tracker, sunglasses, sunglass, shades, glasses, spectacles, eyewear, cap, caps, hat, hats, beanie, "
    "beanies, bandana, headband, gloves, mittens, muffler, necktie, bow tie, cufflinks, jewellery, jewelry, earring, "
    "earrings, jhumka, jhumkas, necklace, necklaces, pendant, locket, bracelet, bracelets, bangle, bangles, churi, chudi, "
    "ring, rings, anklet, nose pin, brooch, tiara, accessory, accessories, makeup, make-up, lipstick, kajal, eyeliner, "
    "mascara, nail polish, perfume, perfumes, fragrance, deodorant, body spray, skincare, skin care, serum, face oil, "
    "moisturiser, moisturizer, sunscreen, cosmetics, candle, candles, mug, mugs, cup, cups, bottle, bottles, flask, "
    "tumbler, plant, plants, succulent, cactus, planter, vase, decor, home decor, cushion, cushions, pillow, bedsheet, "
    "bed sheet, bedding, blanket, quilt, comforter, rug, carpet, curtain, curtains, lamp, photo frame, wall art, wall frame, "
    "headphone, headphones, earphones, earbuds, headset, airpods, phone case, phone cover, umbrella, toy, toys, teddy, "
    "kids, baby, toddler, men, mens, women, womens, ladies, gents, boys, girls, unisex, plus size, petite, maternity, "
    # English: occasions, seasons, colours, materials, sizes
    "eid, eid ul fitr, eid ul adha, eid mubarak, ramadan, ramzan, iftar, chand raat, puja, pujo, durga puja, diwali, "
    "deepavali, holi, navratri, dussehra, christmas, xmas, new year, boishakh, baishakh, pohela boishakh, falgun, valentine, "
    "valentines, mother's day, father's day, wedding, weddings, biye, bia, shaadi, shadi, nikah, walima, reception, "
    "engagement, mehendi, mehndi, holud, gaye holud, haldi, sangeet, barat, party, parties, birthday, anniversary, "
    "housewarming, baby shower, bridal, bride, groom, office, workwear, work wear, interview, formal, casual, smart casual, "
    "business casual, date night, first date, farewell, convocation, graduation, prom, picnic, vacation, holiday, trip, "
    "travel, travelling, beach, gym, workout, yoga, hiking, trekking, sportswear, winter, summer, spring, autumn, monsoon, "
    "rainy, rainy season, festive, festival, colour, colours, color, colors, colourful, colorful, red, blue, green, yellow, "
    "black, white, pink, purple, orange, brown, grey, gray, navy, maroon, beige, cream, golden, gold, silver, olive, teal, "
    "turquoise, lavender, lilac, peach, coral, mustard, khaki, burgundy, magenta, rose gold, off white, off-white, "
    "multicolour, multicolor, printed, floral, striped, stripes, checked, plaid, polka dots, cotton, linen, silk, satin, "
    "chiffon, georgette, muslin, jamdani, katan, benarasi, banarasi, tant, khadi, leather, faux leather, suede, wool, "
    "woollen, woolen, cashmere, polyester, nylon, rayon, viscose, velvet, lace, organza, canvas, xs, s, m, l, xl, xxl, "
    "xxxl, 2xl, 3xl, small, medium, large, extra large, free size, one size, waist, chest, bust, inseam, "
    "first one, second one, third one, fourth one, last one, 1st one, 2nd one, 3rd one, 4th one, 1st, 2nd, 3rd, 4th, "
    "this one, that one, number 1, number 2, number 3, number 4, both of them, complaint, complaints, complain, address, bill, bills, giveaway, "
    "contest, lucky draw, raffle, cm, centimetre, centimeter, inch, inches, you showed, you sent, you suggested, you recommended, "
    "the middle, middle one, these two, those two, which of these, which of them, pack, packing, warm enough, something warm, "
    "something light, dry clean, care label, ",
    # Bangla
    "কিনব, কিনবো, কিনতে, কিনি, কিনেছি, কেনা, কেনাকাটা, শপিং, দাম, দামে, দামের, টাকা, ছাড়, ডিসকাউন্ট, অফার, সেল, কুপন, "
    "প্রোমো, ভাউচার, ক্যাশব্যাক, স্টক, সাইজ, মাপ, ফিটিং, ট্রায়াল, ট্রাই, রং, রঙ, কালার, পরব, পরবো, পরতে, পরার, পরা, পরলে, "
    "পরেন, পোশাক, জামা, জামাকাপড়, কাপড়, ড্রেস, আউটফিট, লুক, স্টাইল, ফ্যাশন, ট্রেন্ড, ট্রেন্ডিং, ডিজাইন, মানাবে, মানায়, উপহার, "
    "গিফট, অর্ডার, অডার, ডেলিভারি, কুরিয়ার, পার্সেল, ট্র্যাক, ফেরত, রিটার্ন, রিটান, রিফান্ড, এক্সচেঞ্জ, বদল, বাতিল, ক্যানসেল, "
    "কেন্সেল, পেমেন্ট, বিকাশ, নগদ, রকেট, কার্ড, ভিসা, মাস্টারকার্ড, কিস্তি, ক্যাশ অন ডেলিভারি, কার্ট, চেকআউট, রাইডার, পাঠাও, "
    "স্টেডফাস্ট, রেডএক্স, কার্টলি, লগইন, পাসওয়ার্ড, জুতা, জুতো, স্যান্ডেল, চপ্পল, স্লিপার, বুট, হিল, কেডস, স্নিকার্স, স্নিকার, "
    "শাড়ি, জামদানি, কাতান, বেনারসি, তাঁত, সালোয়ার, সেলোয়ার, কামিজ, থ্রি পিস, থ্রিপিস, কুর্তা, কুর্তি, ফতুয়া, পাঞ্জাবি, পান্জাবি, "
    "পায়জামা, লেহেঙ্গা, শেরওয়ানি, শেরোয়ানি, বোরকা, বোরখা, হিজাব, নিকাব, আবায়া, ওড়না, উড়না, স্কার্ফ, শাল, চাদর, লুঙ্গি, "
    "গামছা, টুপি, ক্যাপ, জায়নামাজ, তসবি, আতর, শার্ট, টি-শার্ট, টিশার্ট, গেঞ্জি, পোলো, টপ, টপস, ব্লাউজ, জ্যাকেট, কোট, রেইনকোট, "
    "ব্লেজার, স্যুট, হুডি, সোয়েটার, সোয়েটশার্ট, কার্ডিগান, প্যান্ট, জিন্স, ট্রাউজার, শর্টস, স্কার্ট, লেগিংস, জগার্স, ট্রাকসুট, "
    "নাইটি, মোজা, ইউনিফর্ম, অ্যাপ্রন, এপ্রন, জার্সি, ব্যাগ, হ্যান্ডব্যাগ, পার্স, মানিব্যাগ, ওয়ালেট, ব্যাকপ্যাক, ট্রলি, লাগেজ, "
    "বেল্ট, ঘড়ি, হাতঘড়ি, স্মার্টওয়াচ, চশমা, সানগ্লাস, ফ্রেম, গয়না, গহনা, দুল, ঝুমকা, মালা, নেকলেস, চুড়ি, বালা, ব্রেসলেট, আংটি, "
    "নাকফুল, মেকআপ, সাজ, লিপস্টিক, কাজল, পারফিউম, সুগন্ধি, বডি স্প্রে, স্কিন কেয়ার, সিরাম, মোমবাতি, মগ, কাপ, বোতল, গাছ, টব, "
    "ক্যাকটাস, কুশন, বালিশ, বেডশিট, কম্বল, পর্দা, ল্যাম্প, হেডফোন, ইয়ারফোন, ইয়ারবাড, ছাতা, খেলনা, বাচ্চাদের, ছেলেদের, মেয়েদের, পাউচ, "
    "মহিলাদের, পুরুষদের, ঈদ, রমজান, ইফতার, চাঁদরাত, পূজা, পুজো, দুর্গাপূজা, দিওয়ালি, দীপাবলি, বড়দিন, ক্রিসমাস, বৈশাখ, "
    "পহেলা বৈশাখ, নববর্ষ, ফাল্গুন, বসন্ত, ভ্যালেন্টাইন, বিয়ে, বিবাহ, গায়ে হলুদ, মেহেদি, বৌভাত, আকদ, পার্টি, জন্মদিন, বার্থডে, "
    "অ্যানিভার্সারি, বিবাহবার্ষিকী, অফিস, ইন্টারভিউ, ফর্মাল, ক্যাজুয়াল, ফেয়ারওয়েল, কনভোকেশন, পিকনিক, ভ্রমণ, ট্যুর, জিম, শীত, "
    "শীতের, গরম, গরমের, বর্ষা, লাল, নীল, সবুজ, হলুদ, কালো, সাদা, গোলাপি, বেগুনি, কমলা, বাদামি, খয়েরি, মেরুন, ধূসর, সোনালি, "
    "রুপালি, আকাশি, নেভি, অফ হোয়াইট, ক্রিম, সুতি, লিনেন, সিল্ক, রেশম, চামড়া, উল, ডেনিম, শিফন, জর্জেট, মসলিন, কালেকশন, আইটেম, "
    "প্রোডাক্ট, পণ্য, ব্র্যান্ড, কোয়ালিটি, স্মল, মিডিয়াম, লার্জ, কোমর, প্রথমটা, দ্বিতীয়টা, তৃতীয়টা, চতুর্থটা, শেষেরটা, ডলার, "
    "সস্তা, সস্তায়, দামি, বিল, কমপ্লেইন, অভিযোগ, ঠিকানা, গিভঅ্যাওয়ে, গিভওয়ে, কনটেস্ট, লাকি ড্র",
    # Banglish
    "kinbo, kinte, kinsi, kinlam, kena, kenakata, dam, daam, takar, chhar, discount, rong, porbo, porte, porar, "
    "porle, poshak, jama, kapor, kapod, upohar, ferot, juta, jutta, jutto, juto, sandel, chappal, chappol, shari, kamiz, "
    "selwar, three piece, threepiece, panjbi, pajama, borka, borkha, shal, chador, genji, ghori, ghodi, chosma, choshma, "
    "sunglas, goyna, gohona, jhumka, churi, angti, botol, gach, biyer, mehedi, jonmodin, lal, nil, sobuj, kalo, shada, sada, "
    "golapi, beguni, komola, badami, khoyeri, akashi, sonali, rupali, suti, resham, chamra, chamrar, manabe, manay, "
    "manaibe, komor, prothom ta, 1st ta, 2nd ta, 3rd ta, 4th ta, ditiyo ta, ses er ta, sosta, shosta, dami, pori, porben, porbe, thikana",
    # Hindi
    "खरीद, खरीदना, खरीदूं, खरीदनी, खरीदारी, शॉपिंग, कीमत, दाम, रुपये, रुपए, टका, टके, डॉलर, छूट, डिस्काउंट, ऑफर, सेल, कूपन, "
    "प्रोमो, कैशबैक, स्टॉक, साइज़, साइज, नाप, फिटिंग, रंग, कलर, पहन, पहनना, पहनूं, पहनने, पहनें, पहनकर, कपड़े, कपड़ा, ड्रेस, "
    "आउटफिट, लुक, स्टाइल, फैशन, ट्रेंड, ट्रेंडिंग, डिज़ाइन, तोहफा, गिफ्ट, उपहार, ऑर्डर, डिलीवरी, कूरियर, पार्सल, ट्रैक, वापसी, "
    "रिटर्न, रिफंड, एक्सचेंज, कैंसल, भुगतान, पेमेंट, कार्ड, ईएमआई, किस्त, कैश ऑन डिलीवरी, कार्ट, चेकआउट, राइडर, जूते, जूता, "
    "चप्पल, सैंडल, हील, स्नीकर्स, साड़ी, सलवार, सूट, कुर्ता, कुरता, कुर्ती, पायजामा, लहंगा, शेरवानी, दुपट्टा, चुन्नी, शॉल, स्टोल, "
    "बुर्का, हिजाब, टोपी, शर्ट, टी-शर्ट, टीशर्ट, टॉप, ब्लाउज़, जैकेट, कोट, ब्लेज़र, स्वेटर, हुडी, जींस, पैंट, पतलून, स्कर्ट, "
    "लेगिंग्स, मोज़े, बैग, पर्स, बटुआ, बेल्ट, घड़ी, चश्मा, गहने, ज़ेवर, झुमके, चूड़ी, चूड़ियां, कंगन, अंगूठी, लिपस्टिक, मेकअप, "
    "परफ्यूम, इत्र, मोमबत्ती, मग, बोतल, पौधा, हेडफोन, ईयरफोन, छाता, खिलौने, बच्चों, लड़कियों, लड़कों, महिलाओं, पुरुषों, ईद, "
    "रमज़ान, पूजा, दिवाली, दीवाली, होली, नवरात्रि, दशहरा, करवा चौथ, राखी, क्रिसमस, शादी, विवाह, मेहंदी, हल्दी, पार्टी, जन्मदिन, "
    "सालगिरह, ऑफिस, दफ्तर, इंटरव्यू, फॉर्मल, कैज़ुअल, फेयरवेल, ट्रिप, यात्रा, जिम, सर्दी, सर्दियों, गर्मी, गर्मियों, बरसात, लाल, "
    "नीला, नीली, हरी, पीला, पीली, काला, काली, काले, सफेद, गुलाबी, बैंगनी, नारंगी, भूरा, मैरून, सुनहरा, चांदी, सूती, कॉटन, "
    "लिनन, सिल्क, रेशमी, चमड़ा, चमड़े, ऊनी, डेनिम, जंचेगा, सूट करेगा, मीडियम, लार्ज, स्मॉल, कमर, पहला वाला, दूसरा वाला, "
    "तीसरा वाला, पहली वाली, दूसरी वाली, सस्ता, सस्ती, सस्ते, महंगा, महंगी, शिकायत, ज्वेलरी, पता बदल, गिवअवे",
    # Hinglish
    "kharidna, kharid, kharidu, khareedna, kimat, keemat, rupay, rupaye, chhoot, rang, pehen, pehenna, pehnu, pehnoon, "
    "pehne, pehnne, kapde, kapda, kapdon, tohfa, wapas, wapsi, joote, joota, jute, chunni, ghadi, chashma, gehne, jhumke, "
    "choodi, churiyan, angoothi, mehendi, laal, neela, peela, kaala, kala, safed, gulabi, sasta, sasti, saste, mehenga, "
    "pehla wala, dusra wala, doosra wala, teesra wala, pehli wali, dusri wali, kamar, shikayat",
    # Urdu
    "خرید, خریدنا, خریدوں, خریداری, شاپنگ, قیمت, دام, روپے, ٹکا, ڈالر, رعایت, ڈسکاؤنٹ, آفر, سیل, کوپن, پرومو, سائز, ناپ, "
    "فٹنگ, رنگ, کلر, پہن, پہننا, پہنوں, پہننے, پہنیں, کپڑے, کپڑا, لباس, ڈریس, آؤٹ فٹ, لک, اسٹائل, سٹائل, فیشن, ٹرینڈ, ڈیزائن, "
    "تحفہ, تحفے, گفٹ, آرڈر, ڈیلیوری, کوریئر, پارسل, ٹریک, واپسی, ریٹرن, ریفنڈ, ایکسچینج, کینسل, منسوخ, ادائیگی, پیمنٹ, کارڈ, "
    "کیش آن ڈیلیوری, کارٹ, چیک آؤٹ, رائیڈر, جوتے, جوتا, جوتی, چپل, سینڈل, ہیل, سنیکرز, ساڑھی, ساڑی, شلوار, قمیض, سوٹ, کرتا, "
    "کرتی, پاجامہ, لہنگا, شیروانی, دوپٹہ, شال, اسکارف, عبایہ, برقع, حجاب, ٹوپی, شرٹ, ٹی شرٹ, ٹاپ, جیکٹ, کوٹ, بلیزر, سویٹر, "
    "ہڈی, جینز, پینٹ, پتلون, اسکرٹ, موزے, بیگ, ہینڈ بیگ, پرس, بٹوہ, بیلٹ, گھڑی, چشمہ, سن گلاسز, عینک, زیور, زیورات, جھمکے, "
    "بالیاں, چوڑیاں, چوڑی, کنگن, انگوٹھی, لپ اسٹک, میک اپ, پرفیوم, عطر, موم بتی, موم بتیاں, مگ, بوتل, پودا, ہیڈفون, ہیڈ فون, "
    "چھتری, کھلونے, بچوں, لڑکیوں, لڑکوں, خواتین, مردوں, عید, رمضان, چاند رات, شادی, نکاح, ولیمہ, مہندی, مایوں, بارات, پارٹی, "
    "سالگرہ, برتھ ڈے, آفس, دفتر, انٹرویو, فارمل, فیئرویل, سفر, جم, سردی, سردیوں, گرمی, گرمیوں, برسات, لال, سرخ, نیلا, نیلی, "
    "سبز, پیلا, کالا, کالی, کالے, سفید, گلابی, جامنی, نارنجی, بھورا, مہرون, سنہرا, سوتی, کاٹن, لان, ریشمی, سلک, چمڑا, چمڑے, "
    "اونی, ڈینم, میڈیم, لارج, کمر, پہلا والا, دوسرا والا, تیسرا والا, سستا, سستی, سستے, مہنگا, شکایت, پتہ بدل, پتا بدل",
    # Arabic
    "شراء, اشتري, أشتري, اشتريت, تسوق, سعر, اسعار, أسعار, بكم, بكام, ثمن, رخيص, رخيصة, غالي, خصم, خصومات, عرض, عروض, "
    "تخفيض, تخفيضات, كوبون, كود خصم, مقاس, مقاسات, قياس, لون, ألوان, الوان, ملابس, لبس, ألبس, البس, يلبس, لباس, ازياء, أزياء, "
    "موضة, ستايل, فستان, فساتين, هدية, هدايا, طلب, طلبي, اوردر, أوردر, توصيل, شحن, مندوب, ارجاع, إرجاع, استرجاع, استرداد, "
    "استبدال, الغاء, إلغاء, دفع, بطاقة, كارت, فيزا, سلة, عربة التسوق, الدفع عند الاستلام, حذاء, أحذية, احذية, جزمة, جزم, شبشب, "
    "صندل, كعب, سنيكرز, عباية, عبايات, حجاب, نقاب, طرحة, شيلة, ثوب, ثياب, دشداشة, جلابية, قميص, قمصان, تيشيرت, تي شيرت, "
    "بلوزة, جاكيت, جاكت, معطف, بالطو, بدلة, سترة, هودي, سويتر, بنطلون, بنطال, جينز, شورت, تنورة, جيبة, جوارب, حقيبة, حقائب, "
    "شنطة, شنط, محفظة, حزام, ساعة, ساعات, نظارة, نظارات, قبعة, كاب, طاقية, مجوهرات, اكسسوارات, إكسسوارات, حلق, اقراط, قلادة, "
    "اسوارة, سوار, خاتم, مكياج, ميكب, عطر, عطور, بخور, شمعة, شموع, مج, مجات, كوب, زجاجة, نبتة, سماعات, سماعة, مظلة, العاب, "
    "ألعاب, اطفال, أطفال, رجالي, نسائي, بناتي, ولادي, عيد, رمضان, زفاف, عرس, فرح, خطوبة, حفلة, حفل, عيد ميلاد, تخرج, مقابلة, "
    "كاجوال, سفر, رحلة, شتاء, شتوي, صيف, صيفي, احمر, أحمر, ازرق, أزرق, اخضر, أخضر, اصفر, أصفر, اسود, أسود, سودا, سوداء, ابيض, "
    "أبيض, بيضا, وردي, بنفسجي, برتقالي, بني, رمادي, كحلي, ذهبي, فضي, بيج, قطن, قطني, كتان, حرير, جلد, جلدي, صوف, يناسب, يليق, "
    "تليق, الأول, الاول, الثاني, التاني, الثالث, التالت, ساري, شكوى, شكوتي, العنوان, عنوان, مسابقة, منتج, منتجات, عندكم, كرت, شي خفيف, شي دافي",
    # Spanish
    "comprar, compro, compra, compras, comprarle, regalar, regalo, regalos, precio, precios, cuánto cuesta, cuanto cuesta, "
    "cuánto vale, cuesta, cuestan, barato, barata, baratos, baratas, descuento, descuentos, oferta, ofertas, rebaja, rebajas, "
    "cupón, cupon, promoción, talla, tallas, talle, ropa, prenda, prendas, vestido, vestidos, estilo, moda, pedido, pedidos, "
    "envío, envio, envíos, entrega, devolución, devolucion, devoluciones, devolver, reembolso, cambio, cambios, cancelar, "
    "pago, pagar, tarjeta, contra entrega, contrareembolso, carrito, cesta, zapatos, zapato, zapatillas, tenis, botas, "
    "botines, sandalias, chanclas, tacones, mocasines, camisa, camisas, camiseta, camisetas, playera, blusa, chaqueta, "
    "chamarra, campera, abrigo, sudadera, suéter, chaleco, traje, vaqueros, pantalón, pantalones, falda, calcetines, medias, "
    "bolso, bolsos, cartera, mochila, mochilas, billetera, cinturón, reloj, relojes, gafas, lentes, gorra, sombrero, joyas, "
    "aretes, pendientes, collar, pulsera, anillo, maquillaje, labial, colonia, vela, velas, taza, tazas, botella, planta, "
    "auriculares, audífonos, paraguas, boda, fiesta, cumpleaños, aniversario, graduación, oficina, entrevista, playa, viaje, "
    "invierno, verano, rojo, roja, azul, verde, amarillo, negro, negra, blanco, blanca, rosa, morado, naranja, marrón, gris, "
    "dorado, plateado, algodón, lino, seda, cuero, lana, mezclilla, ponerme, me pongo, pongo, vestirme, combinar, mediano, "
    "grande, pequeño, el primero, el segundo, el tercero, la primera, la segunda, la tercera, reclamo, reclamación, queja, "
    "dirección, direccion, sorteo, concurso, repartidor, mensajero, portero, dejarlo, dejarla",
)
# A few tokens that are shopping words on their own but not in these phrases ("world cup", "cup of tea").
NEUTRAL_PHRASES = _set("world cup, asia cup, t20 world cup, cup of tea, cup of coffee, a cup of, oxford university, news anchor")
# Occasion and fashion emoji count as shopping words (a bride, a mosque, a birthday cake…).
SIGNAL_EMOJI = set(
    "👗👠👟👞👢👡🥿🩴👕👖👔👚👘🥻🩱🩲🩳👙🧥🧣🧤🧦👒🎩🧢👑💍💎👜👛👝🎒🧳👓🕶⌚💄💅🎁🛍🛒👰🤵💒🕌🌙☪🪔🎂🎉🎊🎈"
    "💐🎄🎅🏏⚽☂☔❄⛄🌂🧕🥾🩰🎀🏷💸💳💰💵🪭"
)
CURRENCY = re.compile(r"[$৳€£₹﷼]")
# Questions about Pip itself are its job ("who are you", "can you speak Bangla").
CAPABILITY = _rx(
    "(?:who|what) (?:are|r) (?:you|u)", "what can (?:you|u) do", "what do (?:you|u) do", "how can (?:you|u) help",
    "what's your name", "whats your name", "what is your name", "are (?:you|u) (?:a |an )?(?:bot|robot|human|real|ai|person|machine)",
    "(?:can|do|could) (?:you|u) (?:speak|talk|understand|reply|chat|answer)(?: in)? [^ ]+",
    "real person", "human agent", "customer (?:care|service|support)", "talk to (?:a )?(?:human|person|agent)",
    "(?:তুমি|আপনি|তুই) কে", "কি কি করতে পার[^ ]*", "কী কী করতে পার[^ ]*", "কি করতে পারো", "(?:তোমার|আপনার) নাম",
    "বাংলা(?:য়|তে)? (?:কথা )?বল(?:তে)? পার[^ ]*", "রোবট", "মানুষ নাকি",
    "(?:tumi|apni) ke", "ki ki korte par[^ ]*", "ki korte paro", "(?:tomar|apnar) nam", "bangla(?:y|te|e)? (?:kotha )?bol(?:te)? par[^ ]*",
    "manush naki robot", "robot naki manush",
    "(?:तुम|आप) कौन (?:हो|हैं)", "क्या क्या कर सकते", "क्या कर सकते हो", "(?:हिंदी|बंगाली|बांग्ला|उर्दू|अंग्रेजी) में बात कर सकते",
    "(?:तुम्हारा|आपका) नाम", "(?:tum|aap) kaun (?:ho|hain)", "kya kya kar sakte", "kya kar sakte ho",
    "(?:hindi|urdu|bangla|english) (?:me|mein) baat kar sakte", "(?:tumhara|aapka) naam",
    "(?:تم|آپ) کون (?:ہو|ہیں)", "کیا کر سکتے", "(?:اردو|بنگالی|ہندی|انگریزی) میں بات کر سکتے", "آپ کا نام",
    "(?:انت|أنت|انتي) (?:مين|من)", "من (?:انت|أنت)", "(?:شو|ما|ايش) اسمك", "بتعرف تتكلم", "هل تتكلم", "تتكلم (?:عربي|العربية|انجليزي)",
    "ماذا تستطيع", "(?:quién|quien) eres", "(?:qué|que) puedes hacer", "hablas [^ ]+", "eres (?:un |una )?(?:bot|robot|humano|humana|persona)",
    "(?:cómo|como) te llamas",
)
# The chips on Pip's own template replies ("নতুন কী এসেছে দেখান"): a tap on one is about shopping, so it
# gets past a cooldown too.
TEMPLATE_CHIPS = frozenset(" ".join(tokens(_prep(chip))) for chips in templates.CHIPS.values() for chip in chips)

# Words a catalog name, tag or colour shares with everyday English: never a shopping signal alone.
GENERIC = _set(
    "with, from, that, this, your, their, every, everyday, classic, crew, court, cloud, night, lucky, round, studio, "
    "pocket, chunky, glow, surprise, morning, air, pulse, runner, flow, pastel, low, upper, sole, clean, modern, practical, "
    "natural, warm, soft, bold, smart, statement, tech, graphic, playful, basics, heritage, giftable, minimal, print, set, "
    "box, ribbon, kraft, desert, ice, sky, stone, sand, slate, ember, steel, sage, amber, copper, mint, lemon, butter, "
    "terracotta, cobalt, chestnut, blush, scarlet, rouge, midnight, botanical, porcelain, oxford, crisp, patched, relaxed, "
    "raw, flowing, rib, wireless, day, kit, glass, oil, face, weekend, season, all, and, the, for, of, in, on, a, an, one, "
    "size, oz, 100, edgy, biker, vintage, retro, clean, simple, plain, solid, sport, sports, lounge, tan, cream, gold, home, "
    "living, bloom, romantic, feminine, school, live, case, patent, finish, structured, rigid, fluid, flexible, responsive, "
    "synthetic, engineered, recycled, blend, curated, treats, chocolate, metal, washed, shell, lining, lightweight, "
    "heavyweight, highlighter, oils, water, coffee, running, walking, hand, indoor, fitness, smart, laptop, winter, hoop"
)

# ---------- off-topic task shapes (only when nothing in the message is about shopping) ----------
_OPERAND = r"(?:\d+(?:[.,]\d+)?[a-z]?|[a-z]\d*)(?![a-z])"
ARITH = re.compile(rf"(?:^|(?<=[\s(\[{{=+*×÷^,;:!?¿¡\"'.]))\(?{_OPERAND}\)?\s*[+*×÷^=]\s*\(?\s*-?{_OPERAND}")
ASK_SUM = _rx("what is", "what's", "whats", "calculate", "compute", "how much is", "koto", "কত", "कितना", "कितने", "کتنا", "كم", "cuánto es", "cuanto es")
SUM_WORDS = _rx(
    "\\d+ ?(?:x|times|into|plus|minus|divided by|multiplied by|gun|bhag|vag|jog|biyog|গুণ|ভাগ|যোগ|বিয়োগ|गुणा|भाग|जमा|घटा|ضرب|زائد|ناقص|"
    "más|menos|entre) ?\\d+",
)
SUM_GLUED = re.compile(r"\b\d+\s*[x×]\s*\d+\b")
MATHS_WORDS = _rx(
    "square root", "cube root", "বর্গমূল", "ঘনমূল", "वर्गमूल", "घनमूल", "جذر", "الجذر", "raíz cuadrada", "raiz cuadrada",
    "times table", "multiplication table", "নামতা", "पहाड़ा", "جدول الضرب", "tabla del", "factorial", "lcm", "hcf", "gcd",
    "ল সা গু", "গ সা গু", "derivative of", "integral of",
)
CODE_STRONG = [
    re.compile(r"```"),
    re.compile(r"^\s*def [A-Za-z_]\w*\s*\(.*\)\s*:", re.M),
    re.compile(r"console\.log\s*\("),
    re.compile(r"#include\s*<"),
    re.compile(r"\bstatic\s+void\s+main\b|\bint\s+main\s*\(", re.I),
    re.compile(r"System\.out\.print", re.I),
    re.compile(r"\bselect\s+(?:\*|[\w.]+(?:\s*,\s*[\w.]+)*)\s+from\s+[\w.]+\s+where\b", re.I),
    re.compile(r"\bfunction\s+\w+\s*\([^)]*\)\s*\{"),
    re.compile(r"\bprintf\s*\("),
    re.compile(r"<\?php"),
    re.compile(r"\)\s*=>\s*[{(]"),
]
CODE_WEAK = [
    re.compile(r"^\s*(?:import\s+[a-z_][\w.]*(?:\s+as\s+\w+)?|from\s+[a-z_][\w.]*\s+import\s+[\w*, ]+)\s*$", re.M | re.I),
    re.compile(r"^\s*function\s+\w+\s*\(", re.M),
    re.compile(r"^\s*class [A-Za-z_]\w*\s*[:(]", re.M),
    re.compile(r"<\s*(?:div|span|html|body|script|style|table|form|input|button|h[1-6])\b[^>]*>", re.I),
    re.compile(r"\bprint\s*\(\s*[\"'f]"),
    re.compile(r"\b(?:var|let|const)\s+\w+\s*="),
    re.compile(r"^\s*for\s+\w+\s+in\s+.+:\s*$|\bfor\s*\(\s*\w+\s*=", re.M),
    re.compile(r"^\s*(?:if|while|elif)\b.+:\s*$", re.M),
]
PROG_LANGS = _set(
    "python, javascript, java, typescript, php, html, css, sql, golang, kotlin, swift, reactjs, nodejs, django, ruby, rust, "
    "পাইথন, জাভাস্ক্রিপ্ট, জাভা, पायथन, जावास्क्रिप्ट, जावा, پائتھن, پائیتھن, جاوا, بايثون, جافا, جافاسكربت"
)
PROG_TERMS = _set(
    "loop, loops, function, functions, code, coding, program, programming, syntax, compile, compiler, "
    "variable, variables, array, arrays, string, strings, script, module, library, api, query, queries, database, "
    "কোড, লুপ, ফাংশন, প্রোগ্রাম, কোডিং, कोड, लूप, फंक्शन, प्रोग्राम, کوڈ, لوپ, فنکشن, پروگرام, كود, برنامج, دالة"
)
WRITE = _rx(
    "(?:write|compose|draft) (?!me (?:an? )?e-?mails? (?:when|if|once|whenever|as soon) )(?:me |us |him |her )?(?:an? |the |one |some |my |this )?(?:[^ ]+ ){0,3}?(?:poem|poems|poetry|"
    "essay|essays|story|stories|song|songs|lyrics|letters?(?! [a-z0-9]{1,3} (?:on|in|at|onto|for) )|application|cv|resume|email|e-mail|paragraph|speech|code(?! (?:again|down|once more) )|"
    "program|programme|script|caption|captions|article|report|summary|assignment|thesis|haiku|rap|shayari|sonnet|biodata)",
    "(?:give|make|create) (?:me |us )?(?:an? |the |one |some |my )?(?:[^ ]+ ){0,2}?(?:poem|poems|poetry|essay|story|song|"
    "lyrics|cv|resume|biodata|paragraph|speech|caption|summary|article|haiku|rap|shayari)",
    "(?:কবিতা|ছড়া|রচনা|প্রবন্ধ|গল্প|চিঠি|দরখাস্ত|আবেদনপত্র|সিভি|ভাবসম্প্রসারণ|অনুচ্ছেদ|প্যারাগ্রাফ|ক্যাপশন|গান|প্রোগ্রাম|"
    "ইমেইল|প্রতিবেদন|সারাংশ)[^ ]* (?:[^ ]+ ){0,2}?(?:(?:লিখে|লেইখা) (?:দাও|দেন|দিন|দিবা|দিবেন|দে|দিতে পারবা|দিতে পারবেন)"
    "|লিখো|লেখো|লিখুন|লিখতে হবে|বানিয়ে দাও|বানিয়ে দিন|বানায় দাও|বানাও)",
    "(?:kobita|kobta|kabita|chora|rochona|rocona|probondho|golpo|chithi|cithi|dorkhasto|dorkhast|application|cv|resume|"
    "caption|gaan|gan|song|program|essay|poem|story|letter|paragraph|email)[^ ]* (?:[^ ]+ ){0,2}?"
    "(?:(?:likhe|lekhe|likhay|likha|banay|banaye|baniye|banai) (?:dao|den|din|diba|diben|de|daw)|likho|lekho|likhun)",
    "(?:कविता|निबंध|कहानी|चिट्ठी|पत्र|ख़त|खत|लेख|गाना|गीत|शायरी|प्रोग्राम|एप्लीकेशन|आवेदन|अर्जी|सीवी|रिज्यूम|ईमेल|कैप्शन|"
    "भाषण|पैराग्राफ|अनुच्छेद)[^ ]* (?:[^ ]+ ){0,2}?(?:लिखो|लिख दो|लिख दीजिए|लिख दीजिये|लिखिए|लिखिये|लिख दें|लिखें|लिख|"
    "बना दो|बनाओ|बना दीजिए|सुनाओ)",
    "(?:kavita|kavitaa|kabita|poem|nibandh|essay|kahani|kahaani|story|chitthi|chithi|letter|patra|khat|shayari|gaana|gana|"
    "song|program|cv|resume|application(?! (?:me|mein|par|pe|ke) )|caption|speech|paragraph)[^ ]* (?:[^ ]+ ){0,2}?(?:likho|likh do|likh dijiye|"
    "likhiye|likh de|likh dena|likhna|bana do|banao|bana dijiye|sunao|suna do)",
    "(?:نظم|مضمون|کہانی|خط|شاعری|غزل|گانا|گیت|پروگرام|درخواست|سی وی|ای میل|کیپشن|تقریر|پیراگراف)[^ ]* (?:[^ ]+ ){0,2}?"
    "(?:لکھو|لکھ دو|لکھ دیں|لکھیں|لکھ دیجیے|لکھ دیجئے|لکھئے|لکھیے|بنا دو|بناؤ|بنا دیں|سناؤ|سنا دو)",
    "(?:اكتب|اكتبي|اكتبلي|اكتبيلي|تكتب|تكتبلي) (?:لي |لنا )?(?:[^ ]+ ){0,2}?(?:قصيدة|شعر|مقال|مقالة|قصة|رسالة|خطاب|برنامج|"
    "اغنية|أغنية|موضوع|تعبير|ايميل|إيميل|بحث|ملخص)",
    "(?:escribe|escríbeme|escribeme|escríbame|escribirme|redacta|redáctame|redactame|hazme|componme|compón|compon|créame|"
    "creame|inventa|invéntame|inventame) (?:me |un |una |unos |unas |el |la |mi )?(?:[^ ]+ ){0,3}?(?:poema|poemas|poesía|"
    "poesia|ensayo|cuento|historia|canción|cancion|letra|carta|programa|correo|email|párrafo|parrafo|"
    "discurso|redacción|redaccion|artículo|articulo|tarea|currículum|curriculum)",
)
TRANSLATE = _rx(
    "translate", "translation", "অনুবাদ[^ ]*", "onubad", "अनुवाद", "ट्रांसलेट", "anuvad", "anuvaad", "ترجمہ", "ٹرانسلیٹ",
    "ترجم[^ ]*", "traduce[^ ]*", "tradúceme", "traducir", "traducción", "traduccion",
)
PAYLOAD = re.compile(
    r":(?![-^']?[()\[\]/\\|*]|[dpo]\b)\s*[^\s:]|\"\s*[^\"]{2,}\"|(?<!\w)'(?:[^']|(?<=\w)'(?=\w)){3,}'(?!\w)|\b(?:this|the following|these) (?:line|lines|sentence|sentences|text|paragraph|"
    r"word|words|phrase|message)\b|এই (?:লাইন|বাক্য|লেখা|কথা)|\bei (?:line|kotha|lekha)\b|\b(?:isay|ise|isko|isse)\b|"
    r"यह (?:वाक्य|लाइन)|इस (?:वाक्य|लाइन)|इसे|یہ جملہ|اس جملے|اسے|هذه الجملة|هذا النص|\besta frase\b|\beste texto\b"
)
HOMEWORK = _rx(
    "(?:do|solve|finish|complete|help (?:me )?with|help me (?:do|solve|finish)) (?:my |his |her |our |their |this |these |the |a )?"
    "(?:[^ ]+ ){0,2}?(?:homework|home work|assignment|assignments|equation|equations|mathematics|"
    "worksheet|school project|thesis|dissertation|lab report)",
    "(?:do|solve|finish|complete|help (?:me )?with|help me (?:do|solve|finish)) (?:my|his|her|our|their) (?:[^ ]+ )?(?:sum|sums|math|maths)",
    "(?:homework|assignment) help", "solve (?:for )?x",
    "(?:(?:এই|এটা|ওই|আমার|আমাদের|তোমার) (?:অংক|অঙ্ক)|হোমওয়ার্ক|হোম ওয়ার্ক|বাড়ির কাজ|অ্যাসাইনমেন্ট|এসাইনমেন্ট|গণিত|ম্যাথ|সমীকরণ)[^ ]* (?:[^ ]+ )?"
    "(?:করে দাও|করে দেন|করে দিন|করে দিবা|সমাধান কর[^ ]*|সলভ কর[^ ]*|মিলিয়ে দাও|বুঝিয়ে দাও|বুঝায় দাও|কষে দাও)",
    "(?:(?:ei|eta|oi|amar|amader) (?:onko|ongko|math|maths)|homework|homwork|home work|assignment|asainment)[^ ]* (?:[^ ]+ )?(?:kore dao|kore den|kore din|"
    "kore diba|solve kore|solve koro|milaiye dao|milay dao|bujhay dao|bujhiye dao)",
    "(?:होमवर्क|गृहकार्य|असाइनमेंट)[^ ]* (?:[^ ]+ )?(?:कर दो|करो|कर दीजिए|कर दें)",
    "(?:(?:ये|यह|इस|इन) (?:सवाल|प्रश्न)|समीकरण|गणित)[^ ]* (?:[^ ]+ ){0,2}?(?:हल कर[^ ]*|सॉल्व कर[^ ]*)",
    "(?:homework|assignment)[^ ]* (?:[^ ]+ )?(?:kar do|karo|kar dijiye|kar de)",
    "(?:(?:ye|yeh|is|iss|in) (?:sawal|sawaal|question)|equation|math|maths)[^ ]* (?:[^ ]+ ){0,2}?(?:hal karo|hal kar do|solve karo|solve kar do|solve kro)",
    "(?:ہوم ورک|اسائنمنٹ)[^ ]* (?:کر دو|کرو|کر دیں)",
    "(?:(?:یہ|اس|ان) (?:سوال|سوالات)|ریاضی|مساوات)[^ ]* (?:[^ ]+ ){0,2}?(?:حل کرو|حل کر دو|حل کریں|حل کر دیں)",
    "(?:حل|حلي|تحل|احل|يحل) (?:لي )?(?:ال)?(?:واجب|واجبات|معادلة|مسألة|تمرين|سؤال|اسئلة)",
    "ساعدني في (?:ال)?(?:واجب|واجبات|معادلة|مسألة|تمرين)",
    "(?:resuelve|resuélveme|resuelveme|resolver|haz|hazme|ayúdame con|ayudame con|me ayudas con) (?:mi |la |las |el |esta |este |mis )?"
    "(?:tarea|tareas|deberes|ecuación|ecuacion|ejercicio|ejercicios)",
)
TRIVIA = _rx(
    # capitals, leaders, winners, inventors, populations
    "(?:what|which|whats|what's) (?:is |was )?(?:the )?capital (?:city )?of",
    "(?:who is|who was|who's|whos) (?:the )?(?:current |first |last |new )?(?:president|prime minister|pm|chief minister|king|queen|"
    "ceo|founder|governor|chief justice|minister) of(?! (?:this|your|ur|the|cartly) (?:store|shop|company|site|website|app|brand|page|business))",
    "who (?:won|wins|will win|is winning|is going to win|would win|has won) (?:the )?(?:[^ ]+ ){0,3}?(?:match|game|election|"
    "elections|world cup|cup|final|series|toss|league|tournament|trophy|ipl|bpl|psl|oscar|oscars|vote|title|race)",
    "who (?:invented|discovered|founded|painted|composed)", "how many (?:calories|countries|states|districts|planets|bones)(?! (?:do|does|are|can|will|is) (?:you|u|cartly|y'all))",
    "population of",
    # news, weather, scores
    "(?:latest|today's|todays|recent|breaking|current|daily|world|sports|political) news", "news (?:(?:about|on|of|from)(?! (?:my|your|ur|you|u|cartly) )|today|headlines)",
    "headlines (?:today|of)", "weather forecast", "forecast (?:for )?(?:today|tomorrow|tonight)",
    "(?:what's|what is|whats|how's|how is|hows) (?:the )?weather(?: like)? (?:today|tomorrow|tonight|now|in|this|at|outside)",
    "weather (?:today|tomorrow|tonight|update|report)", "will it (?:rain|snow|storm|be sunny|be cloudy)",
    "is it (?:going to|gonna) rain", "temperature (?:today|tomorrow|now|outside)", "(?:what's|what is|whats) the temperature",
    "(?:match|game|cricket|football) score", "score (?:of|in) (?:the )?(?:match|game)", "[^ ]+ vs [^ ]+ (?:match )?score",
    "live score", "scorecard",
    # Bangla
    "(?:প্রধানমন্ত্রী|রাষ্ট্রপতি|প্রেসিডেন্ট|মুখ্যমন্ত্রী|সিইও|প্রতিষ্ঠাতা) (?:কে|কারা)",
    "কে (?:জিতবে|জিতেছে|জিতলো|জিতল|জিতছে|জিতসে|জিতেছিল)", "রাজধানী(?:র নাম)? (?:কি|কী|কোথায়|কোনটা)",
    "(?:আজকের|সর্বশেষ|লেটেস্ট|তাজা|দেশের|রাজনীতির|খেলার) খবর", "ম্যাচের স্কোর", "স্কোর কত",
    "(?:বৃষ্টি|ঝড়) হবে (?:নাকি|কি|কিনা)", "আজ (?:কি )?বৃষ্টি হবে", "আবহাওয়া (?:কেমন|কি রকম) (?:থাকবে|হবে|যাবে)",
    "আবহাওয়ার (?:খবর|পূর্বাভাস)", "তাপমাত্রা কত", "জনসংখ্যা কত", "কে আবিষ্কার কর[^ ]*", "আবিষ্কার কে কর[^ ]*", "নির্বাচন কবে",
    # Banglish
    "(?:prodhan ?montri|prime minister|president|rashtropoti) ke", "ke (?:jitbe|jitse|jitlo|jiteche|jitche)",
    "(?:latest|ajker|aajker|taza|tatka|desher) (?:khobor|news)", "(?:match|khela)(?: er)? score",
    "score koto", "brishti hobe (?:naki|ki)", "weather kemon (?:thakbe|hobe)", "rajdhani (?:ki|koi|kothay|kon)", "election kobe",
    # Hindi and Hinglish
    "(?:प्रधानमंत्री|राष्ट्रपति|मुख्यमंत्री|सीईओ) कौन", "कौन (?:जीतेगा|जीता|जीतेगी|जीती|जीत रहा)", "(?:आज की|ताज़ा|ताजा|लेटेस्ट) (?:खबर|ख़बर|खबरें|समाचार|न्यूज़)",
    "खबरें (?:सुनाओ|बताओ)", "मैच (?:का|की) स्कोर", "स्कोर क्या", "बारिश होगी", "मौसम कैसा (?:रहेगा|होगा)", "(?:की|का) राजधानी",
    "किसने (?:आविष्कार|खोज)", "आविष्कार किसने", "किसको वोट", "चुनाव कब",
    "(?:pradhan ?mantri|prime minister|president) kaun", "kaun (?:jeetega|jeeta|jitega|jita|jeetegi|jeeti)",
    "(?:aaj ki|taza|taaza|latest) (?:khabar|khabrein|news)", "khabrein (?:sunao|batao)", "match ka score", "score kya",
    "barish hogi", "mausam kaisa (?:rahega|hoga)", "kisne (?:banaya tha|invent|avishkar)", "avishkar kisne", "election (?:kaun|kab)",
    # Urdu
    "(?:وزیر اعظم|وزیراعظم|صدر|وزیر اعلیٰ) کون", "کون (?:جیتے گا|جیتا|جیتے گی|جیتی)", "(?:آج کی|تازہ) (?:خبر|خبریں)",
    "خبریں (?:سناؤ|بتاؤ)", "میچ کا (?:سکور|اسکور)", "بارش ہوگی", "موسم کیسا (?:رہے گا|ہوگا)", "دارالحکومت کیا", "کس نے ایجاد", "ایجاد کس نے",
    # Arabic
    "(?:من|مين) (?:هو |هي )?(?:رئيس|رئيسة) (?:وزراء|الوزراء|الدولة|الجمهورية|امريكا|أمريكا)", "(?:من|مين) (?:هو )?ملك [^ ]+", "(?:من|مين) (?:سيفوز|فاز|هيكسب|راح يفوز|بيفوز)", "(?:ما هي|ماهي|ما هى|شو|ايش|وش|ما) عاصمة [^ ]+", "عاصمة [^ ]+ (?:ايش|شو|وش|ايه|هي)",
    "(?:اخر|آخر) (?:الاخبار|الأخبار)", "اخبار اليوم", "(?:حالة )?الطقس (?:اليوم|بكرة|بكره|غدا|الحين|بكرا)",
    "هل (?:ستمطر|راح تمطر|بتمطر)", "درجة الحرارة (?:اليوم|الآن|الان|كم)", "نتيجة (?:المباراة|الماتش|مباراة)",
    "(?:من|مين) (?:اخترع|اللي اخترع)", "عدد سكان",
    # Spanish
    "(?:quién|quien) (?:es|fue) (?:el |la )?(?:presidente|presidenta|primer ministro|primera ministra|rey|reina) de",
    "(?:quién|quien) (?:ganó|gano|va a ganar|ganará|ganara) (?:el |la |las |los )?(?:[^ ]+ ){0,2}?(?:partido|elecciones|"
    "elección|eleccion|mundial|copa|final|liga|clásico)",
    "(?:cuál|cual|qué|que) es la capital de", "(?:qué|que) tiempo (?:va a hacer|hace|hará|hara)(?! (?:falta|que))", "va a llover",
    "(?:pronóstico|pronostico) del (?:tiempo|clima)", "(?:últimas|ultimas) noticias", "noticias de hoy",
    "(?:quién|quien) (?:inventó|invento|descubrió|descubrio)",
)
JOKE = _rx(
    "(?:tell|say|give|share) (?:me |us )?(?:a |an |another |some |one )?(?:[^ ]+ ){0,2}?(?:joke|jokes|riddle|riddles)",
    "(?:know|got|have) (?:any )?(?:good |funny )?jokes",
    "(?:জোকস|জোক|কৌতুক|ধাঁধা|মজার গল্প|চুটকি)[^ ]* (?:[^ ]+ )?(?:বলো|বলেন|বলুন|শোনাও|শুনাও|শুনান|বল|শোনান)",
    "(?:joke|jokes|koutuk|kotuk|dhadha)[^ ]* (?:[^ ]+ )?(?:bolo|bolen|shunao|sunao|shonao|bol|shunan)",
    "(?:चुटकुला|चुटकुले|जोक|जोक्स|पहेली)[^ ]* (?:[^ ]+ )?(?:सुनाओ|सुनाइए|बताओ|सुना दो|बोलो)",
    "(?:chutkula|chutkule|joke|jokes|paheli)[^ ]* (?:[^ ]+ )?(?:sunao|suna do|batao|sunaiye|bolo)",
    "(?:لطیفہ|لطیفے|جوک|پہیلی)[^ ]* (?:[^ ]+ )?(?:سناؤ|سنا دو|سنائیں|بتاؤ)",
    "(?:قل|قول|قولي|احكي|احكيلي|اعطني|عطني|ابي|بدي|عايز|عاوز|ممكن) (?:لي )?(?:[^ ]+ )?(?:نكتة|نكت|لغز)",
    "(?:cuéntame|cuentame|dime|cuenta|échame|echame) (?:un |una |otro |unos )?(?:[^ ]+ )?(?:chiste|chistes|adivinanza|broma)",
)
META = _rx(
    "(?:what|which) (?:ai|llm|language model|gpt|bot)(?: model| version)? (?:are you|r u|do you use|powers you|runs you|"
    "are you based on|are you built on|are you running)",
    "(?:what|which) model (?:are you|r u|powers you|runs you|are you based on|are you built on)(?! (?:using|wearing|showing|in|for) )",
    "are (?:you|u) (?:chat ?gpt|gpt|gemini|claude|bard|copilot|llama|grok|deepseek|an llm|a language model|openai)",
    "(?:gpt|chatgpt|claude|gemini) (?:or|ya|ولا|او|o) (?:gpt|chatgpt|claude|gemini)", "(?:konsa|kaunsa|kon sa|kaun sa) (?:ai )?model ho",
    "(?:কোন|কি) এআই মডেল", "(?:কোন|কি) মডেল (?:দিয়ে|দিয়া) (?:চল[^ ]*|তৈরি|বানানো)", "kon (?:ai )?model diye",
    "(?:कौन ?सा|कौनसा) (?:[^ ]+ )?मॉडल हो", "(?:qué|que|cuál|cual) modelo (?:eres|usas(?! (?:en|para) ))",
    "(?:شغال|مبني) على (?:gpt|chatgpt|claude|gemini|جي بي تي|شات|نموذج|موديل)[^ ]*", "(?:انت|أنت|انتي) (?:شغال|شغالة|مبني|مبنية) على [^ ]+",
)
# Requests for advice outside the store, by their shape ("give me a … recipe", "which medicine should I take").
NOT_A_BOOK = "(?! (?:book|books|box|card|cards|journal|notebook|holder|stand|organiser|organizer|tin|jar|binder))"
ADVICE = {
    "task:recipe": _rx(
        f"(?:give|send|tell|share|show|need|want) (?:me |us )?(?:a |an |the |some |your )?(?:[^ ]+ ){{0,3}}?recipes?{NOT_A_BOOK}",
        "recipes? (?:for|of) [^ ]+", "how (?:to|do i|do you|can i) (?:cook|bake)",
        "রেসিপি[^ ]* (?:দাও|দেন|দিন|বলো|বলেন|বলুন|চাই|শিখাও|শেখাও)", "রান্নার (?:রেসিপি|পদ্ধতি|নিয়ম)", "কিভাবে রান্না কর[^ ]*",
        "recipe (?:dao|den|din|bolo|bolen|chai|batao|bata do|bataiye|do|dijiye|chahiye)", "ranna(?:r)? (?:recipe|niyom)",
        "रेसिपी (?:बताओ|बताइए|बता दो|दो|दीजिए|चाहिए)", "(?:बनाने|पकाने) (?:का|की) (?:तरीका|विधि)",
        "(?:banane|pakane) (?:ka|ki) (?:tareeqa|tarika|tariqa|vidhi|recipe)",
        "(?:ریسیپی|ترکیب)[^ ]* (?:بتاؤ|بتائیں|بتا دیں|بتا دو|دو|دیں)", "(?:بنانے|پکانے) (?:کا|کی) (?:طریقہ|ترکیب)",
        "(?:وصفة|وصفه|طريقة تحضير|طريقة طبخ) [^ ]+",
        "(?:dame|pásame|pasame|quiero|necesito|me das|me pasas) (?:la |una |tu )?receta(?! (?:médica|medica|del (?:médico|medico|oftalmólogo|oftalmologo|oculista|óptico|optico|doctor)|de (?:los |las )?(?:lentes|gafas)))",
    ),
    "task:health": _rx(
        "(?:which|what) (?:medicine|medication|tablet|tablets|pill|pills|drug|antibiotic)s? (?:should|can|do|to) (?:i|we|he|she) (?:take|use|give)",
        "what (?:should|can) i take for (?:a |my |the )?(?:fever|headache|cough|flu|migraine|toothache|diarrhoea|diarrhea)",
        "symptoms of [^ ]+",
        "কোন (?:ওষুধ|ঔষধ|ঔষুধ|ট্যাবলেট)[^ ]* (?:খাবো|খাব|খাওয়া|খাই|নিবো)",
        "kon (?:osud|oshud|oshudh|oushod|medicine|tablet) (?:khabo|khab|khai|nibo)",
        "कौन ?सी (?:दवाई|दवा|गोली|टैबलेट) (?:लूं|लूँ|लें|खाऊं|खाऊँ|खाएं)",
        "(?:kaun ?si|konsi|kon si) (?:dawai|dawa|dava|goli|tablet|medicine) (?:lu|loon|lun|khaun|khau|le)",
        "کون ?سی (?:دوائی|دوا|گولی|ٹیبلٹ) (?:لوں|کھاؤں|لیں)", "(?:وش|ايش|شو|ما هو|ماهو) (?:الدوا|الدواء)",
        "(?:qué|que) (?:medicina|medicamento|pastilla) (?:tomo|debo tomar|me tomo)",
    ),
    "task:trivia": _rx(
        "how much does (?:the )?(?:[^ ]+ ){0,3}?(?:earn|get paid)", "(?:salary|net worth|income) of",
        "(?:ceo|founder|chairman)'?s? (?:salary|net worth|income)", "(?:सैलरी|वेतन|तनख्वाह) (?:कितनी|कितना)",
        "(?:salary|tankhwah) (?:kitni|kitna)", "kitna (?:kamata|kamati|kamate)", "(?:تنخواہ|سیلری) (?:کتنی|کتنا)", "كم راتب",
        "(?:cuánto|cuanto) (?:gana|cobra)", "(?:सोने|सोना) (?:का )?भाव", "(?:sone|sona) (?:ka )?(?:bhav|bhaav|rate)",
        "(?:سونے|سونا) (?:کا )?(?:بھاؤ|ریٹ)", "print hello world", "hello world (?:program|code)",
    ),
    "task:travel": _rx(  # asking for tickets, not mentioning a trip
        "(?:book|get|find|need|want|how (?:to|do i|can i) (?:book|get)) (?:a |the |some |me )?(?:cheap )?(?:bus|train|flight|plane|"
        "air|launch|ferry|movie|cinema|concert) tickets?",
        "(?:bus|train|flight|plane|launch) tickets? (?:to|for|from) [^ ]+(?: [^ ]+){0,2}(?= $)",
        "(?:বাসের|ট্রেনের|প্লেনের|বিমানের|লঞ্চের|সিনেমার) (?:টিকেট|টিকিট) (?:কিভাবে|কোথায়|কত|কাটব[^ ]*|কাটতে|পাব[^ ]*)",
        "(?:bus|train|plane|launch) er (?:ticket|tiket) (?:kivabe|kothay|koto|katbo|pabo)",
        "(?:बस|ट्रेन|फ्लाइट) (?:का|की) (?:टिकट|टिकिट) (?:कितने|कैसे|कहाँ|कहां)",
        "(?:bus|train|flight) (?:ka|ki) ticket (?:kitne|kaise|kahan)", "(?:بس|ٹرین|فلائٹ|جہاز) (?:کا|کی) ٹکٹ (?:کتنے|کیسے|کہاں)",
        "سے [^ ]+ کا ٹکٹ (?:کتنے|کیسے|کہاں)", "(?:تذكرة|تذاكر) (?:طيران|قطار|باص)",
    ),
    "task:jobs": _rx(
        "(?:job|jobs) (?:vacancy|vacancies|opening|openings)", "(?:are you|r u|is cartly) hiring", "apply for (?:a |the )?job",
        "চাকরি (?:চাই|খুঁজ[^ ]*|দরকার|করতে চাই)", "চাকরির (?:খবর|সার্কুলার|বিজ্ঞপ্তি)", "chakri (?:chai|khujtesi|khujchi|dorkar|lagbe)",
        "नौकरी (?:चाहिए|चाहिये)", "naukri (?:chahiye|chahie|chaiye)", "نوکری (?:چاہیے|چاہئے)",
        "(?:ابي|ابغى|اريد|أريد|عايز|عاوز) (?:وظيفة|وظيفه)", "(?:busco|buscando) (?:trabajo|empleo)", "(?:están|estan) contratando",
    ),
    "task:media": _rx(
        "(?:recommend|suggest) (?:me )?(?:a |an |some )?(?:good |nice |new |funny )?(?:movie|movies|film|films|series(?! of)|"
        "web series|tv show|tv series|anime|song|songs|game|games)(?! (?:merch|merchandise|controllers?|consoles?|t-shirts?|tshirts?|tees?|"
        "shirts?|hoodies?|posters?|figures?|figurines?|mugs?|caps?|bags?|night|themed|inspired|prints?|printed|lovers?|fans?|costumes?|"
        "outfits?|accessories|collectibles|gifts?))",
        "(?:ترشح|رشح|رشحلي) (?:لي )?(?:فلم|فيلم|مسلسل|اغنية|أغنية)", "(?:সিনেমা|মুভি|নাটক|সিরিজ)[^ ]* (?:সাজেস্ট|রেকমেন্ড)",
        "(?:movie|cinema|natok|series)[^ ]* (?:suggest|recommend)", "(?:फिल्म|मूवी|सीरीज)[^ ]* (?:सजेस्ट|सुझाओ)",
        "(?:recomiéndame|recomiendame) (?:una |un |alguna )?(?:película|pelicula|serie|canción|cancion)",
    ),
    "task:plan": _rx("(?:give|make|create|send|share|write|suggest|prepare|need|want) (?:me |us )?(?:a |an |the |my |some )?(?:[^ ]+ ){0,2}?"
                     "(?:diet|meal|workout|exercise|weight loss|study) (?:plan|chart|routine)"),
}
RECIPE_END = re.compile(r" recipes?(?: (?:please|pls|plz))? $")
# "i g n o r e  a l l  r u l e s": letters spaced out to slip past word lists.
SPACED = re.compile(r"(?<![^\s])(?:[a-z] ){4,}[a-z](?![^\s])")
SPELLED = re.compile(r"(?:[a-z] )+[a-z]")

AI_NAMES = _set(
    "chatgpt, gpt, gpt4, gpt-4, gpt-4o, gpt5, gpt-5, claude, gemini, openai, anthropic, llama, bard, copilot, deepseek, "
    "mistral, grok, চ্যাটজিপিটি, জিপিটি, জেমিনি, ক্লড, चैटजीपीटी, जीपीटी, چیٹ, شات"
)
YOU = _set(
    "you, u, your, ur, yourself, tumi, tomar, tmr, apni, apnar, tui, tum, tumhara, aap, aapka, তুমি, তোমার, আপনি, আপনার, "
    "তুই, तुम, आप, तुम्हारा, आपका, تم, آپ, تمہارا, انت, أنت, انتي, tú, tu, eres, usted, model, ai, এআই, मॉडल, ماڈل, نموذج, موديل"
)

# ---------- prompt injection ----------
# Role tags and notes "to the AI": declined even with shopping words around them.
ROLE_TAG = re.compile(
    r"</?\s*(?:context|system|assistant|user|human|instructions?|im_start|im_end|sys|prompt|admin|developer)\s*>|<\|[^|<>]{1,40}\|>"
    r"|\[/?inst\]|<<\s*/?sys\s*>>|\[/?system\]|(?:^|\n)\s*(?:#{1,3}\s*)?(?:system|assistant|developer)\s*:"
    r"|(?:^|\n)\s*#{1,3}\s*(?:system|instructions?|assistant)\b|(?<=[.!?।؟\]>])\s*(?:system|developer)\s*:"
    r"|[\[(]\s*(?:system|admin|administrator|developer|assistant|ai|এডমিন|এআই|সিস্টেম|एडमिन|सिस्टम|ایڈمن|سسٹم|النظام|الادمن)"
    r"(?:\s+(?:note|notes|instruction|instructions|message|override|command|এর জন্য নোট|নোট|নির্দেশ|नोट|ہدایت|ملاحظة))?\s*:"
    r"|[\[(]\s*(?:nota para el asistente|note to (?:the )?(?:ai|assistant|bot|pip|model))\s*:"
)
FORGED_PIP = re.compile(r"(?:^|\s)(?:pip|assistant|bot)\s*:")
FORGED_USER = re.compile(r"(?:^|\s)(?:user|shopper|human|customer)\s*:")
# Phrasing aimed at Pip's own instructions (never "my previous instructions", "show me the instructions again").
INJECT = _rx(
    "(?:ignore|disregard|forget|override|bypass|skip|drop) (?:all )?(?:of )?(?:your|ur) (?:[^ ]+ ){0,2}?(?:instructions|instruction|"
    "prompt|prompts|directives|programming|guardrails|training)",
    "(?:ignore|disregard|forget|override|bypass|skip|drop) (?:all )?(?:of )?(?:the |your |ur )?(?:system|developer|hidden|"
    "internal) (?:instructions|instruction|prompt|prompts|rules|guidelines)",
    "(?:ignore|disregard|forget|override|bypass) (?:all|every|any) (?:the )?(?:previous|prior|above|earlier|preceding|existing) "
    "(?:instructions|instruction|prompts|rules|guidelines)",
    "(?:system|initial|original|secret|internal|hidden) prompt", "(?:your|ur) system instructions",
    "(?:your|ur) (?:initial|original|secret|internal|hidden) (?:instructions|rules|settings)", "hidden instructions",
    "(?:your|ur|apni|apne|apna|tumhare|tomar) (?:[^ ]+ ){0,3}?hidden rules",
    "(?:enable|activate|enter|switch to|turn on|go into|you are in|you're in|now in) (?:the )?(?:developer|dev) mode",
    "developer (?:instructions|prompt)",
    "god mode", "jailbreak (?:mode|prompt|you|yourself|pip)", "dan mode", "(?:stands for|called|named) do anything now", "act as dan",
    "(?:you are|you're|ur) (?:now )?dan", "admin access",
    "(?:you are|you're|act as|pretend to be|become) (?:now )?(?:an? )?(?:[^ ]+ )?(?:chatgpt|unrestricted|unfiltered|uncensored)",
    "(?:you are|you're) now (?:an? )?[^ ]*gpt", "(?:you are|you're) (?:no longer|not) pip",
    "(?:reveal|print|show|display|output|repeat|tell|give|send|share|write|leak|dump|list|paste) (?:me )?(?:your|ur|the) "
    "(?:full |entire |whole |exact |complete )?(?:system |hidden |initial |original |secret |internal |developer )?(?:prompt|prompts)",
    "(?:reveal|print|output|leak|dump|display) (?:me )?(?:your|ur) (?:full |entire |whole |exact |complete )?(?:instructions|rules|"
    "guidelines|configuration|config|settings)",
    "repeat (?:everything|all (?:the )?(?:text|words|content|instructions)|the text|the words|whatever is written|what is written|the content) (?!(?:you|u) (?:said|wrote|told|"
    "mentioned|sent|showed) )(?:[^ ]+ ){0,3}?"
    "(?:above|above this|before this message)",
    "(?:you|u) (?:have|has|now have) no (?:rules|guidelines)",
    "from now on (?:you )?(?:will |must |should |shall |can )?(?:answer|respond|reply) (?:to )?(?:every|any|all)",
    "(?:admin|administrator|api|secret|private) (?:password|key|token|credentials)", "api key",
    "authori[sz]e you to give me \\d+%?", "(?:i am|i'm|im|as) (?:the )?cartly(?:'s)? (?:owner|admin|manager|ceo|founder)(?! (?:told|said|promised|confirmed|asked|mentioned|agreed))",
    "(?:you are|you're|pretend you are|pretend you're|act as|pretend to be) my (?:late|dead|deceased) (?:grandma|grandmother|granny)",
    "(?:grandma|grandmother|granny) (?:who|that) used to (?:read|tell|say|give) (?:me |us )?(?:the |her )?(?:windows|product|"
    "activation|licen[cs]e|serial|admin|api|secret)",
    # Bangla and Banglish
    "(?:তোমার|আপনার|তোর) (?:সিস্টেম )?(?:প্রম্পট|প্রমপ্ট)", "সিস্টেম প্রম্পট", "গোপন (?:নির্দেশ|নির্দেশনা|ইনস্ট্রাকশন)[^ ]*",
    "তোমাকে (?:যে |যা )?(?:[^ ]+ ){0,2}?(?:নির্দেশ|নির্দেশনা|ইনস্ট্রাকশন)[^ ]* (?:দেয়া|দেওয়া)", "তোমাকে শুরুতে (?:কি|কী|যা|যে)", "ডেভেলপার মোড (?:অন )?(?:করো|কর|চালু করো)",
    "(?:তুমি|তুই) (?:এখন )?dan", "আর পিপ না", "এখন থেকে (?:তুমি )?(?:যেকোনো|যে কোনো|যেকোন|সব|সকল) প্রশ্নের উত্তর", "যা বলবো তাই করবা",
    "(?:এডমিন|অ্যাডমিন) পাসওয়ার্ড", "আমি কার্টলির মালিক", "তুমি আমার মরহুম (?:দাদু|দাদি|নানু|নানি)",
    "ami cartly(?: r| er|r)? malik", "(?:tomar|tmr|apnar) (?:sob )?instruction[^ ]* (?:ignore|bhule)",
    "(?:tomar|tmr|apnar) (?:system prompt|prompt)", "kono rule manba na", "tumi ekhon dan",
    # Hindi, Hinglish, Urdu
    "अपने (?:[^ ]+ )?(?:निर्देश|इंस्ट्रक्शन|नियम|रूल्स)[^ ]* (?:भूल जाओ|भूल जाइए|भूल जा|अनदेखा करो|इग्नोर करो)",
    "सिस्टम प्रॉम्प्ट", "(?:अपना|अपने|अपनी) (?:प्रॉम्प्ट|config|कॉन्फ़िग)", "डेवलपर मोड (?:ऑन |चालू )?(?:करो|कर दो)", "dan मोड", "कोई नियम नहीं (?:मानोगे|मानना)",
    "अब से तुम (?:[^ ]+ )?(?:dan|डैन) मोड", "अब से (?:तुम )?(?:हर|किसी भी) सवाल का जवाब", "मैं (?:इस स्टोर|cartly) का मालिक",
    "(?:main|mai|mein) cartly ka (?:store )?(?:manager|malik|owner)",
    "(?:apne|apna) (?:[^ ]+ )?(?:instructions?|rules|niyam)[^ ]* (?:ignore|bhool|bhul) (?:karo|kro|kar do|jao)",
    "(?:apna|apni) (?:prompt|system prompt)", "(?:tumhe|tumhein) jo hidayat",
    "اپنی (?:[^ ]+ )?(?:ہدایات|ہدایت|انسٹرکشنز)[^ ]* (?:بھول جاؤ|بھول جائیں|نظرانداز کرو|نظر انداز کرو|اگنور کرو)",
    "سسٹم پرامپٹ", "پرامپٹ", "(?:تم|آپ) اب پپ نہیں", "(?:تمہیں|تجھے|آپ کو) شروع میں (?:جو|کیا)",
    "ایڈمن (?:کا )?پاس ورڈ",
    # Arabic, Spanish
    "تجاهل (?:كل|جميع) (?:التعليمات|الأوامر|الاوامر|القواعد|التوجيهات)",
    "(?:البرومبت|برومبت|البرمبت)", "(?:الاعدادات|الإعدادات|التعليمات) (?:المخفية|السرية)", "التعليمات (?:حقك|حقتك|الخاصة بك)", "وضع المطور",
    "(?:eres|que eres) mi (?:abuelita|abuela) que me (?:leía|leia|contaba|decía|decia)",
    "ignora (?:tus|todas tus) instrucciones", "(?:tu|tus) (?:prompt|instrucciones|reglas) (?:de sistema|del sistema|ocultas|secretas|internas)",
    "prompt (?:de|del) sistema", "(?:activa|activar|entra en|pon|ponte en) (?:el )?modo (?:desarrollador|developer|dan)", "modo dan",
    "repite todo lo que (?:está|esta) (?:escrito )?arriba",
)
# The same request without "your"/"all": declined when nothing in the message is about shopping, no strike otherwise.
INJECT_WEAK = _rx(
    "(?:ignore|disregard|forget) (?:previous|prior|above|earlier|preceding) (?:instructions|instruction|prompts)",
    "(?:ignore|disregard|forget|break|bypass) (?:all|every|any) (?:the )?(?:rules|instructions|restrictions|guidelines)",
    "(?:সব|সমস্ত|সকল) (?:নিয়ম|রুলস|রুল)[^ ]* (?:ভুলে যাও|ভুলে যান|বাদ দাও|উপেক্ষা কর[^ ]*|ইগনোর কর[^ ]*)",
    "(?:sob|shob|all) (?:rules|rule|niyom)[^ ]* (?:bhule jao|bhule jan|ignore koro|ignore kore|bad dao)",
    "(?:tomar|tmr|apnar) (?:sob )?(?:rules|rule) (?:ignore|bhule)",
    "(?:सारे|सभी|सब) (?:[^ ]+ )?(?:नियम|रूल्स)[^ ]* (?:भूल जाओ|भूल जाइए|अनदेखा करो|इग्नोर करो)",
    "(?:sare|saare|sab|sabhi) (?:[^ ]+ )?(?:rules|niyam)[^ ]* (?:ignore|bhool|bhul) (?:karo|kro|kar do|jao)",
    "(?:ساری|سب|تمام) (?:[^ ]+ )?(?:اصول|رولز)[^ ]* (?:بھول جاؤ|بھول جائیں|نظرانداز کرو|اگنور کرو)",
    "(?:সব|সমস্ত|সকল) (?:ইনস্ট্রাকশন|নির্দেশ|নির্দেশনা)[^ ]* (?:ভুলে যাও|ভুলে যান|ভুলে যা|বাদ দাও|বাদ দেন|উপেক্ষা কর[^ ]*|ইগনোর কর[^ ]*)",
    "(?:sob|shob|all) (?:instruction|instructions|nirdesh)[^ ]* (?:bhule jao|bhule jan|ignore koro|ignore kore|bad dao)",
    "(?:सारे|सभी|सब) (?:[^ ]+ )?(?:निर्देश|इंस्ट्रक्शन)[^ ]* (?:भूल जाओ|भूल जाइए|भूल जा|अनदेखा करो|इग्नोर करो)",
    "(?:sare|saare|sab|sabhi) (?:[^ ]+ )?instructions?[^ ]* (?:ignore|bhool|bhul) (?:karo|kro|kar do|jao)",
    "(?:ساری|سب|تمام) (?:[^ ]+ )?(?:ہدایات|ہدایت|انسٹرکشنز)[^ ]* (?:بھول جاؤ|بھول جائیں|نظرانداز کرو|نظر انداز کرو|اگنور کرو)",
    "تجاهل (?:التعليمات|الأوامر|الاوامر) السابقة", "ignora todas las instrucciones",
)
BASE64 = re.compile(r"(?<![A-Za-z0-9+/])(?=[A-Za-z0-9+/]*[a-z])(?=[A-Za-z0-9+/]*[A-Z])[A-Za-z0-9+/]{20,}={0,2}(?![A-Za-z0-9+/])")
DECODE = _rx("decode", "decode this", "base64", "ডিকোড[^ ]*", "डिकोड", "ڈیکوڈ", "فك", "decodifica")

# ---------- noise ----------
# Emoji (also "‼️" and "⁉️") and text smileys (":)", "<3", "^_^"): reactions, not noise.
EMOJI = re.compile(
    "[\U0001f000-\U0001faff\u2600-\u27bf\u2300-\u23ff\u2b00-\u2bff\u3030\u303d\u3297\u3299\u203c\u2049\ufe0f]"
    r"|[:;=]['^-]?[()\[\]/\\|*]|<3|\^[_.-]?\^"
)
# What speech-to-text writes for silence, music or background noise.
STT_NOISE = re.compile(
    r"^\W*(?:(?:[\[(*♪]\s*[^\])*♪\n]{0,40}[\])*♪]\W*)+|thank you for watching|thanks for watching|please subscribe|"
    r"subscribe to (?:my|the|our) channel|like and subscribe|(?:subtitles?|captions?|transcribed) by\b.*|amara\.org.*|you)\W*$"
)

# ---------- closers ----------
CLOSER_WORDS, CLOSER_PHRASES = _lex(
    "thanks, thank, thanx, thnx, thnks, thx, tnx, tks, ty, tq, tysm, thankyou, thanku, thanq, tnq, bye, byee, byeee, byebye, "
    "goodbye, cya, cheers, thank you, thank u, see you, see ya, take care, good night, have a nice day, have a good day, "
    "many thanks, much appreciated, appreciate it, bye bye, good bye, "
    "ধন্যবাদ, ধন্নবাদ, থ্যাংকস, থ্যাংক্স, থ্যাঙ্কস, থ্যাংকু, থ্যাংক ইউ, শুকরিয়া, শোকরিয়া, জাজাকাল্লাহ, জাযাকাল্লাহ, খাইরান, আল্লাহ হাফেজ, "
    "আল্লাহ হাফিজ, খোদা হাফেজ, বিদায়, টাটা, বাই, ভালো থাকবেন, ভালো থাকুন, ভালো থেকো, আবার দেখা হবে, শুভরাত্রি, শুভ রাত্রি, "
    "dhonnobad, dhonnobaad, dhonyobad, dhonnyobad, donnobad, allah hafez, allah hafiz, khoda hafez, khuda hafez, jazakallah, "
    "jazakallahu, khairan, tata, bhalo thakben, valo thakben, abar dekha hobe, "
    "धन्यवाद, शुक्रिया, थैंक्स, थैंक यू, थैंक्यू, अलविदा, बाय, फिर मिलेंगे, फिर मिलते हैं, शुभ रात्रि, ख़ुदा हाफ़िज़, अल्लाह हाफ़िज़, "
    "shukriya, shukria, dhanyavad, dhanyavaad, dhanyawad, dhanywad, alvida, phir milenge, phir milte hain, khuda hafiz, "
    "شکریہ, شکریا, اللہ حافظ, خدا حافظ, جزاک اللہ, جزاکم اللہ, الوداع, پھر ملیں گے, پھر ملتے ہیں, خوش رہیں, شب بخیر, "
    "شكرا, شكرا جزيلا, مشكور, مشكورة, يعطيك العافية, الله يعطيك العافية, الله يعافيك, تسلم, تسلمي, يسلمو, جزاك الله, "
    "مع السلامة, في امان الله, وداعا, الى اللقاء, باي, تصبح على خير, "
    "gracias, muchas gracias, mil gracias, adiós, adios, chao, chau, hasta luego, hasta pronto, nos vemos, cuídate, cuidate",
)
# Words that may sit around a thank-you or goodbye ("thank u so much", "ধন্যবাদ ভাই, অনেক উপকার হলো").
CLOSER_FILLERS = _set(
    "so, much, very, a, lot, lots, again, pip, bhai, vai, bhaiya, apu, apa, dada, didi, bro, sis, dear, sir, madam, maam, "
    "ji, jee, jaan, yaar, ok, okay, okk, oki, k, and, for, everything, all, the, help, helping, helpful, your, you, u, ur, "
    "have, nice, great, day, good, later, soon, will, come, back, then, no, nah, guys, really, too, now, "
    "ভাই, ভাইয়া, আপু, আপা, দাদা, দিদি, পিপ, অনেক, খুব, উপকার, হলো, হল, হইল, হয়েছে, হইছে, সাহায্য, করার, জন্য, আপনাকে, "
    "তোমাকে, আচ্ছা, ঠিক, আছে, ওকে, onek, khub, hoilo, holo, hoise, hoyeche, upokar, korar, jonno, apnake, tomake, acha, "
    "accha, thik, ache, भैया, भाई, जी, दीदी, आपका, आपकी, बहुत, मदद, के, लिए, अच्छा, ठीक, है, aapka, bahut, bohot, bohat, madad, "
    "ke, liye, theek, hai, buenas, noches, بھائی, جی, آپ, کا, بہت, مدد, ہوئی, گئی, کرنے, کے, لیے, اچھا, ٹھیک, ہے, يا, قمر, حبيبي, حبيبتي, "
    "اخي, اختي, كثير, جدا, على, المساعدة, مساعدتك, لك, muchas, mil, por, todo, la, ayuda, amigo, amiga, de, nuevo, vale"
)
CLOSER_EMOJI = set("🙏👍👌🤝❤💙💜💚💛🧡🤍🖤💕💖💗💓💞\ufe0f\u200d\U0001f3fb\U0001f3fc\U0001f3fd\U0001f3fe\U0001f3ff")
# "Yes please", "হ্যাঁ দেখান", "sí, por favor": a yes to the offer a template of Pip's ended with ("shall I find
# you something lovely?"), which is shopping, so it gets past a cooldown.
ACCEPT = _set(
    "yes, yeah, yea, ya, yep, yup, sure, ok, okay, okk, k, please, pls, plz, go, ahead, show, me, something, anything, "
    "surprise, হ্যাঁ, হ্যা, জি, জ্বি, আচ্ছা, ঠিক, আছে, অবশ্যই, দেখান, দেখাও, কিছু, ha, hya, ji, accha, acha, thik, ache, "
    "dekhan, dekhao, kichu, हाँ, हां, जी, ठीक, है, ज़रूर, जरूर, दिखाइए, दिखाओ, कुछ, haan, han, theek, hai, zaroor, dikhao, "
    "dikhaiye, kuch, ہاں, جی, ٹھیک, ہے, ضرور, دکھائیں, دکھائیے, کچھ, نعم, أكيد, اكيد, حسنا, طيب, بالتأكيد, شيء, sí, si, "
    "claro, vale, dale, porfa, por, favor, bueno, algo"
)

# ---------- language ----------
_BANGLISH = _set(
    "ami, amar, amr, amake, amk, amader, tumi, tmi, tomar, tmr, tomake, apni, apnar, apnara, apnader, apnake, tui, tor, ki, "
    "kno, keno, kemon, kmn, kemne, kivabe, kibhabe, kothay, kobe, koto, kto, ache, ase, achhe, aso, acho, achen, nai, nei, "
    "na, hobe, hbe, hoy, hoye, hoise, hoyeche, hoilo, holo, hole, hoile, gelo, gese, jabo, jay, jacchi, korbo, korte, krte, "
    "kore, kre, koro, korsi, korse, korche, korteci, korchi, kortesi, dao, daw, den, din, dibo, diba, diben, dite, diye, "
    "dicche, dekhao, dekhan, dekha, dekhte, dekhi, chai, cai, lagbe, lage, laglo, kinbo, kinte, jonno, jnno, er, ta, ti, "
    "ekta, akta, ekti, ekhon, ekhono, akhon, eta, ota, oita, eita, ei, oi, sob, shob, kichu, kisu, kicu, ektu, onek, khub, "
    "valo, bhalo, sundor, shundor, mane, tahole, tobe, kintu, ar, abar, sathe, shathe, theke, moddhe, moto, bolo, bolen, acha, accha, thik, "
    "bolun, bujhi, bujhtesi, parbo, pari, paro, parben, pabo, dhonnobad, vai, apu, ajke, aj, ajker, kal, ke, naki, shunao, "
    "khujtesi, khujchi, porbo, jitbe, jitse, likhe, kobita, bhule, jao, chilo, chhilo, prothom, amra, tomra, ora, jodi, tai, "
    "eto, beshi, kom, notun, kharap, dekhte, bolte, jante, jani, janina, korben, korun, dekhun, nibo, nebo, niben, debo, "
    "thakbe, thakben, ashbe, asbe, gesi, korlam, dilam, pelam, chaile, hafez, khoda, jazakallah, tata, bhai, kmne, kamne"
)
_HINGLISH = _set(
    "mujhe, mjhe, mujhse, mera, meri, mere, hum, humko, hamara, tum, tumhe, tumhara, tumhari, aap, aapka, aapki, aapke, "
    "aapko, kya, kia, kyun, kyu, kaise, kaisa, kaisi, kab, kahan, kaha, kaun, kon, konsa, kaunsa, kitna, kitne, kitni, hai, "
    "hain, hu, hoon, ho, tha, thi, raha, rahi, rahe, gaya, gaye, gayi, gya, hoga, hogi, karo, kro, kar, karna, karne, karein, "
    "kare, kariye, kijiye, dijiye, dena, dikhao, dikhaiye, dikha, batao, bataiye, bata, sunao, chahiye, chaiye, chahie, "
    "chahta, chahti, milega, milegi, sakta, sakti, sakte, liye, ke, ka, ki, ko, se, mein, pe, aur, bhi, nahi, nahin, haan, "
    "accha, acha, theek, thik, bahut, bohot, bohat, sab, kuch, koi, wala, wali, wale, yaar, yar, bhai, bhaiya, ji, abhi, aaj, "
    "kal, baar, phir, fir, agar, lekin, magar, toh, iska, uska, inka, unka, apna, apni, apne, yeh, ye, woh, wo, isko, usko, "
    "shukriya, jeetega, likho, rahega, mausam, isay, dein, hota, tu, tera, teri, kiya, kiye, karta, karti, karte, dekho, "
    "suno, chalo, jao, aao, hafiz, khuda, alvida, milenge, jazakallah, dhanyavad, dhanyavaad, tumhe, tumko, hamein, unke, "
    "unki, jaisa, wahi, yahi, waala, waali"
)
_SPANISH = _set(
    "el, la, los, las, un, una, unos, unas, del, al, es, son, está, esta, están, estoy, soy, eres, qué, que, cuál, cual, cómo, "
    "como, dónde, donde, cuándo, cuando, cuánto, cuanto, quién, quien, por, para, con, sin, pero, muy, más, también, tambien, "
    "mi, mis, tus, su, sus, les, nos, y, o, de, en, hay, tengo, tienes, tiene, tienen, tenés, quiero, "
    "quieres, quiere, puedo, puedes, puede, necesito, busco, buscando, hola, gracias, adiós, adios, chao, favor, sí, algo, "
    "alguna, algún, alguno, muéstrame, muestrame, dime, hazme, ayúdame, ayudame, cuéntame, cuentame, escríbeme, va, mañana"
)
_ENGLISH = _set(
    "the, is, are, am, was, were, be, been, what, which, who, whom, whose, how, why, where, when, can, could, would, should, "
    "will, shall, do, does, did, you, your, yours, my, mine, me, i, i'm, im, it, it's, its, this, that, these, those, there, "
    "here, for, with, and, or, but, of, to, in, on, at, from, about, please, pls, plz, any, some, something, anything, tell, "
    "give, write, solve, translate, show, want, need, have, has, get, make, help, thanks, thank, bye, hello, hi, hey, a, an, "
    "if, so, just, not, yes, what's, whats, who's, let's, i'll, can't, don't, doesn't, won't, also, very, really, much, many, "
    "like, love, good, great, nice, new, now, today, tomorrow, again, ok, okay, sure, joke, poem, essay, cheers, goodbye, "
    "thx, ty, see, take, care, night"
)
# Other languages written in Latin letters (no templates): French, Portuguese, Turkish, Indonesian/Malay,
# German, Tagalog, Romanized Nepali and Tamil, Egyptian Arabizi.
_OTHER_LATIN = _set(
    "je, j'ai, vous, nous, il, elle, est, c'est, les, des, du, au, aux, une, pour, avec, dans, sur, pas, ne, mon, mes, ton, "
    "ses, cette, ce, ça, très, merci, bonjour, salut, oui, où, quoi, mais, et, suis, sont, avez, voulez, veux, cherche, "
    "beaucoup, journée, bonne, você, voce, não, nao, obrigado, obrigada, muito, com, uma, eu, isso, aqui, tem, quero, olá, "
    "bir, ve, için, icin, mı, mi, mu, mü, var, yok, nerede, nasıl, nasil, bu, şu, çok, ile, ama, gibi, lazım, arıyorum, "
    "yang, dan, ini, itu, ada, gak, nggak, tidak, tak, bisa, aku, kamu, saya, mau, dong, kak, buat, untuk, dengan, apa, "
    "berapa, nak, cari, pergi, kerja, warna, gimana, cara, dari, sama, juga, sudah, belum, udah, banget, aja, deh, sih, nih, "
    "ich, und, der, die, das, ist, nicht, bitte, danke, ein, eine, für, ang, ng, mga, po, ako, ko, ba, salamat, malai, euta, "
    "chahiyo, samma, cha, chha, garnu, hajur, tapai, venum, paaka, poga, oru, pannanum, epdi, illa, enna, romba, ana, enta, "
    "enti, fe, fi, lessa, mawsalsh, ezay, keda, habibi, yalla, wallah, shukran, naharda, kam, meno"
)
_ARABIZI = re.compile(r"(?<![a-z0-9])(?=[a-z0-9]*[a-z])[a-z]*[235789][a-z]+[a-z0-9]*|(?<![a-z0-9])[235789][a-z]{2,}")
_LATIN_KEYS = ("en", "bn-Latn", "hi-Latn", "es")
_NEPALI_MARATHI = _set(
    "छ, छन्, छैन, छु, छौं, मलाई, तपाईं, तपाई, तिमी, हजुर, गर्नु, गर्न, गर्छ, गर्नुहोस्, हुन्छ, भयो, पनि, कति, लागि, अनि, बिर्सिदेऊ, "
    "देखाऊ, सबै, पहिलेका, आफ्नो, मिल्छ, आहे, आहेत, मला, नाही, काय, तुम्ही, आम्ही, पाहिजे, कसे, कुठे, साठी, आणि, यो, एउटा, "
    "चाहियो, देखाउनुस्, देखाउनुहोस्, दिनुस्, दिनुहोस्, रातो, कालो, सेतो, किन्न, पाइन्छ, दाखवा, किती, द्या, मिळेल, हवंय, हवी, हवे"
)
_URDU_LETTERS = re.compile("[ٹڈڑںےۓھہۃ]")
# Languages without templates that share a script with one: their conversations never get a template.
_SAME_SCRIPT = {"deva": ("ne", "mr", "mai", "bho", "kok", "sa"), "bn": ("as", "mni", "sat"), "arab": ("fa", "ps", "sd", "ks", "ug", "ckb", "prs")}
_ASSAMESE = _set("মোক, মই, আপুনি, কিমান, দিয়ক, নেকি, জোতা, ধুনীয়া, হয়নে, লাগিব")
_URDU_WORDS = _set(
    "ہے, ہیں, کے, کی, کا, میں, کیا, نہیں, آپ, کو, سے, یہ, وہ, اور, مجھے, ہوں, تھا, تھی, لیے, کیلئے, چاہیے, کریں, کرو, بتاؤ, "
    "دکھاؤ, ہو, تم, ہم, بھی, بہت, کچھ, کوئی, اپنا, اپنی, والا, والی, شکریہ, حافظ, خدا"
)
_ARABIC_WORDS = _set(
    "هل, ماذا, لماذا, اريد, أريد, في, على, عن, هذا, هذه, انا, انت, عندكم, عندك, ابي, ابغى, ابغي, عايز, عاوز, عايزة, ايش, وش, "
    "شلون, كيف, ليش, مش, ده, من, شكرا, مرحبا, اهلا, ازيك, عامل, ايه, حاجة, بدي, شو, لو, سمحت, وين, فين, ممكن, جميل, والله, اللي"
)
_ARABIC_SKIP_AL = _set("الله, اللہ, السلام, الحمد, الحمدلله, الحمدللہ, الوداع")
_PERSIAN = _set("است, را, می, این, برای, هست, نیست, هستم, خیلی, ممنون, مرسی, چطور, کجا, دارید, میخواهم, میخوام, بخرم, چه, آیا, چی, میشه, "
    "دارین, چنده, کجاست, نمیدونم, کدوم, بهتره, میرسه, سفارشم, ممنونم, خوبه, چیه, هستش, بدید, بدین, بگید, بگین")

LINE_WORDS = 80
# Bare sizes, ranges and dates ("42", "32/34", "30-32", "12/10", "M", "xl"): answers, never maths.
SIZE_LIKE = re.compile(r"^\W*(?:\d{1,4}(?:\s*[/\-x×]\s*\d{1,4})?|[xsml]{1,4}|\d?x+l)\W*$")


class Gate:
    def __init__(self, catalog):
        self.catalog = catalog
        self._vocab_for = None
        self._words: set[str] = set()
        self._phrases: set[str] = set()
        self._heads: set[str] = set()  # first words of the phrases

    # ---------- the catalog's own words ----------
    def vocabulary(self) -> tuple[set[str], set[str]]:
        """Seed words plus the catalog's: names, types, categories, collections, keywords (any language),
        style tags, occasions, seasons, colours, materials and letter sizes. Rebuilt on a catalog reload."""
        products = self.catalog.products
        if self._vocab_for is not products:
            words, phrases = set(), set(SIGNAL_PHRASES)
            for p in products:
                fields = [
                    p.get("type"), p.get("categoryTitle"), *re.split(r"[,;]", p.get("material") or ""),
                    *(c.replace("-", " ") for c in p.get("collections") or []), *(p.get("keywords") or []),
                    *(p.get("styleTags") or []), *(p.get("occasions") or []), *(p.get("seasons") or []),
                    *(c.get("name") for c in p.get("colors") or [] if isinstance(c, dict)),
                    *(s for s in p.get("sizes") or [] if not str(s).strip().isdigit()),
                ]
                for field in fields:
                    toks = tokens(_prep(str(field or "")))
                    if len(toks) == 1 and not toks[0].isdigit():
                        words.add(toks[0])
                        words |= _stems(toks[0])
                    elif 2 <= len(toks) <= 4:
                        phrases.add(" ".join(toks))
                name = tokens(_prep(str(p.get("name") or "")))
                if 2 <= len(name) <= 4:
                    phrases.add(" ".join(name))
                for tok in name:
                    if len(tok) > 3 and not tok.isdigit():
                        words.add(tok)
                        words |= _stems(tok)
            self._words, self._phrases = SIGNAL_WORDS | (words - GENERIC), phrases
            self._heads = {ph.split(" ", 1)[0] for ph in phrases}
            self._vocab_for = products
        return self._words, self._phrases

    # ---------- the check ----------
    def check(self, message: str, memory: dict | None, ctx: dict | None) -> Verdict:
        try:
            return self._check(message or "", memory or {}, ctx or {})
        except Exception:
            return Verdict("pass", "unsure", None, "error", False)

    def _check(self, message: str, memory: dict, ctx: dict) -> Verdict:
        base = normalise(message)
        if SPACED.search(base):
            base = "  ".join(c.replace(" ", "") if SPELLED.fullmatch(c) else SPACED.sub(lambda m: m.group().replace(" ", ""), c)
                             for c in re.split(r" {2,}", base))
        text = fold(base)
        toks = tokens(text)
        # Task and injection shapes are read in the first words only: a long message's tail can only go to Claude.
        line = " " + " ".join(toks[:LINE_WORDS]) + " "
        lang = self.language(base, toks, ctx)
        signal = self.signal(toks, message, line)

        def verdict(kind: str, rule: str, action: str = "decline", has_signal: bool = False) -> Verdict:
            if action in ("decline", "closer") and not lang:
                action = "pass"  # no template in this language: Claude answers
            return Verdict(action, kind, lang, rule, has_signal)

        # 1. Role tags and notes to the AI, whatever else the message says.
        if ROLE_TAG.search(base) or (FORGED_PIP.search(base) and FORGED_USER.search(base)):
            return verdict("injection", "role-tag", has_signal=signal)

        # 2. A yes to the offer Pip's last template ended with, or an answer to Pip: its rule-brain
        # question, its own question, or its cards.
        if 0 < len(toks) <= 4 and set(toks) <= ACCEPT and self._offered(memory):
            return Verdict("pass", "followup", lang, "followup:offer", True)
        window = self.window(memory)
        if window in ("pending", "question") or (window and len(toks) <= 6):
            if window == "results" and self.closer(toks, message, line):
                return verdict("closer", "closer", "closer" if settings.pip_closers else "pass")
            answer = signal or window == "pending" or (window == "question" and len(toks) <= 6) or bool(SIZE_LIKE.match(base))
            if not answer:
                # A short reply to the cards ("I'll take it", "how much?", "আরও দেখাও") or a longer answer to
                # Pip's question ("she likes simple things, nothing too flashy") answers it, so a cooldown lets
                # it through; noise, an injection or a task ("tell me a joke") doesn't.
                noise = (not toks and not EMOJI.search(message)) or (ctx.get("spoken") and STT_NOISE.match(base.strip()))
                shady = INJECT.search(line) or INJECT_WEAK.search(line) or (BASE64.search(message) and DECODE.search(line))
                answer = not (noise or shady or self.task(base, message, toks, line))
            return Verdict("pass", "followup", lang, f"followup:{window}", answer)

        # 3. Noise: only punctuation or symbols, or what speech-to-text hears in silence.
        if not toks and not EMOJI.search(message):
            return verdict("junk", "junk:symbols")
        if ctx.get("spoken") and STT_NOISE.match(base.strip()):
            return verdict("junk", "stt-noise")

        injection = bool(INJECT.search(line)) or bool(BASE64.search(message) and DECODE.search(line))
        # 4. Anything about shopping goes to Claude (an injection attempt alongside it counts as a strike).
        if signal:
            return Verdict("pass", "injection" if injection else "shop", lang, "injection+signal" if injection else "signal", True)

        # 5. Injection phrasing aimed at Pip's own instructions.
        if injection or INJECT_WEAK.search(line):
            return verdict("injection", "injection")

        # 6. Unambiguous off-topic tasks.
        task = self.task(base, message, toks, line)
        if task:
            return verdict("offtopic", task)

        # 7. A plain thank-you or goodbye.
        if self.closer(toks, message, line):
            return verdict("closer", "closer", "closer" if settings.pip_closers else "pass")
        return Verdict("pass", "unsure", lang, "unsure", False)

    # ---------- layers ----------
    def window(self, memory: dict) -> str | None:
        """Is the shopper answering Pip? "pending" (the rule brain asked something), "question" (Pip's last
        reply asked one: not a greeting's open invitation or a template's), "results" (cards on show)."""
        if memory.get("pending"):
            return "pending"
        history = [m for m in memory.get("history") or [] if isinstance(m, dict)]
        last = next((i for i in range(len(history) - 1, -1, -1) if history[i].get("role") == "assistant"), None)
        if last is not None:
            said = _reply_text(history[last].get("content"))
            opened = last > 0 and history[last - 1].get("content") == "(opened Pip)"
            if said and _asks(said) and not opened and not templates.is_template(said):
                return "question"
        return "results" if memory.get("results") else None

    @staticmethod
    def _offered(memory: dict) -> bool:
        """Did Pip's last reply end with a template's offer ("shall I find you something lovely?")? The
        window leaves templates out (a decline is no question to answer), but a yes to its offer is shopping."""
        history = [m for m in memory.get("history") or [] if isinstance(m, dict)]
        said = next((_reply_text(m.get("content")) for m in reversed(history) if m.get("role") == "assistant"), "")
        return bool(said) and templates.is_template(said) and _asks(said)

    def signal(self, toks: list[str], message: str, line: str) -> bool:
        """Does the message mention anything shopping: a catalog or seed word or phrase (any language),
        a price sign, a fashion or occasion emoji, a question about Pip itself, or one of Pip's own chips?"""
        if " ".join(toks) in TEMPLATE_CHIPS:
            return True
        words, phrases = self.vocabulary()
        skip = set()
        if " cup " in line or " oxford " in line or " news " in line:
            for k in (2, 3, 4):
                for i in range(len(toks) - k + 1):
                    if " ".join(toks[i : i + k]) in NEUTRAL_PHRASES:
                        skip |= set(range(i, i + k))
        forms = [_variants(tok) for tok in toks]
        for i, tok in enumerate(toks):
            if i not in skip and not forms[i].isdisjoint(words):
                return True
        for i, tok in enumerate(toks):
            if tok in self._heads:
                for k in (2, 3, 4):
                    if i + k <= len(toks):
                        head = " ".join(toks[i : i + k - 1])
                        if any(f"{head} {v}" in phrases for v in forms[i + k - 1]):
                            return True
        for i in range(len(toks) - 1):
            if _script(toks[i]) == "latin" and toks[i] + toks[i + 1] in words:
                return True
        for tok in toks:  # typed without spaces: "showmeblackjeans32waist", "কালোপাঞ্জাবিআছে"
            if 14 <= len(tok) <= 48 and any(tok[i:j] in words for i in range(len(tok) - 3) for j in range(i + 4, min(len(tok), i + 12) + 1)):
                return True
        return bool(CURRENCY.search(message) or not SIGNAL_EMOJI.isdisjoint(message) or CAPABILITY.search(line))

    def task(self, base: str, message: str, toks: list[str], line: str) -> str | None:
        """The rule of an unambiguous off-topic task, or None."""
        if any(any(c.isdigit() for c in m.group()) and not _bill(m.group()) for m in ARITH.finditer(base)):
            return "task:maths"
        if ASK_SUM.search(line) and any(not _bill(m.group()) for m in (*SUM_WORDS.finditer(line), *SUM_GLUED.finditer(base))):
            return "task:maths"
        if MATHS_WORDS.search(line) and any(c.isdigit() for c in line):
            return "task:maths"
        if self._code(message) or (not PROG_LANGS.isdisjoint(toks) and not PROG_TERMS.isdisjoint(toks)):
            return "task:code"
        if WRITE.search(line):
            return "task:write"
        if TRANSLATE.search(line) and PAYLOAD.search(base):
            return "task:translate"
        if HOMEWORK.search(line):
            return "task:homework"
        if TRIVIA.search(line):
            return "task:trivia"
        if JOKE.search(line):
            return "task:joke"
        for rule, rx in ADVICE.items():
            if rx.search(line):
                return rule
        if RECIPE_END.search(line) and len(toks) <= 5:
            return "task:recipe"
        if META.search(line) or (not AI_NAMES.isdisjoint(toks) and not YOU.isdisjoint(toks)):
            return "task:meta"
        return None

    @staticmethod
    def _code(message: str) -> bool:
        if any(rx.search(message) for rx in CODE_STRONG):
            return True
        weak = sum(1 for rx in CODE_WEAK if rx.search(message))
        lines = sum(1 for ln in message.splitlines() if ln.strip())
        semis = len(re.findall(r";\s*$", message, re.M))
        return weak >= 2 or (weak and lines >= 2 and bool(re.search(r"[(){}\[\];=]", message))) or (semis >= 2 and "{" in message)

    def closer(self, toks: list[str], message: str, line: str) -> bool:
        """The whole message is a thank-you, goodbye or blessing ("thank u so much 😊", "আল্লাহ হাফেজ",
        "🙏"), nothing else. "ok", "yes" and "how are you" aren't."""
        if not toks:
            rest = re.sub(r"\s+", "", message)
            return bool(rest) and all(ch in CLOSER_EMOJI for ch in rest) and not {"\ufe0f", "\u200d"}.issuperset(rest)
        if toks[0] == "all" and len(toks) > 1 and toks[1] in CLOSER_WORDS:  # "all, thank you!" picks them all
            return False
        found, i, n = False, 0, len(toks)
        while i < n:
            for k in (4, 3, 2):
                if i + k <= n and " ".join(toks[i : i + k]) in CLOSER_PHRASES:
                    found, i = True, i + k
                    break
            else:
                tok = toks[i]
                if tok in CLOSER_WORDS:
                    found = True
                elif tok not in CLOSER_FILLERS:
                    return False
                i += 1
        return found

    def language(self, base: str, toks: list[str], ctx: dict) -> str | None:
        """The template language for a reply to this message, or None when it isn't clear (or has none)."""
        if ctx.get("langMode") == "fixed" and ctx.get("lang"):
            return templates.language_of(ctx["lang"])  # the shopper's own pick; none if it has no templates
        key = self._language(base, toks, ctx)
        return key if key in settings.pip_template_langs else None

    def _language(self, base: str, toks: list[str], ctx: dict) -> str | None:
        letters = {"latin": 0, "bn": 0, "deva": 0, "arab": 0, "other": 0}
        count = dict(letters)
        for tok in toks:
            script = _script(tok)
            if script != "num":
                letters[script] += sum(1 for c in tok if not c.isdigit())
                count[script] += 1
        total = sum(letters.values())
        if not total:  # emoji, numbers or punctuation: the conversation's language
            return templates.language_of(ctx.get("lang")) or templates.language_of(ctx.get("locale"))
        if letters["other"] * 2 >= total:
            return None  # Tamil, Thai, Cyrillic…: no templates
        natives = [s for s in ("bn", "deva", "arab") if count[s]]
        if len(natives) > 1:
            return None
        if natives and str(ctx.get("lang") or "").split("-")[0].lower() in _SAME_SCRIPT[natives[0]]:
            return None  # a Nepali, Marathi, Assamese or Persian conversation: no templates
        if natives and (count[natives[0]] >= 2 or letters[natives[0]] >= letters["latin"]):
            return {"bn": self._bangla, "deva": self._devanagari, "arab": self._arabic}[natives[0]](base, toks, ctx)
        return self._latin(base, toks, ctx) if letters["latin"] else None

    @staticmethod
    def _bangla(base: str, toks: list[str], ctx: dict) -> str | None:
        return None if re.search("[ৰৱ]", base) or not _ASSAMESE.isdisjoint(toks) else "bn"  # Assamese

    @staticmethod
    def _devanagari(base: str, toks: list[str], ctx: dict) -> str | None:
        return None if not _NEPALI_MARATHI.isdisjoint(toks) else "hi"

    @staticmethod
    def _arabic(base: str, toks: list[str], ctx: dict) -> str | None:
        urdu_letters = bool(_URDU_LETTERS.search(base))
        if not urdu_letters and (not _PERSIAN.isdisjoint(toks) or ("ی" in base and "ه" in base)):
            return None  # Persian
        if urdu_letters:
            return "ur"
        urdu = sum(1 for t in toks if t in _URDU_WORDS)
        arabic = sum(1 for t in toks if t in _ARABIC_WORDS) + ("ة" in base) + sum(
            1 for t in toks if t.startswith("ال") and len(t) > 3 and t not in _ARABIC_SKIP_AL
        )
        if urdu != arabic:
            return "ur" if urdu > arabic else "ar"
        last = templates.language_of(ctx.get("lang"))
        return last if last in ("ur", "ar") else None

    @staticmethod
    def _latin(base: str, toks: list[str], ctx: dict) -> str | None:
        words = set(toks)
        scores = {
            "bn-Latn": len(words & _BANGLISH),
            "hi-Latn": len(words & _HINGLISH),
            "es": len(words & _SPANISH) + 2 * bool(re.search("[¿¡ñ]", base)),
        }
        english = len(words & _ENGLISH)
        other = len(words & _OTHER_LATIN) + len(_ARABIZI.findall(base))
        best = max(scores, key=scores.get)
        top = scores[best]
        rivals = [k for k, v in scores.items() if v == top]
        last = templates.language_of(ctx.get("lang"))
        if top and len(rivals) == 1 and top * 2 > english and top > other:
            return "en" if top == 1 and last == "en" else best  # one shared word ("moto", "son") doesn't switch an English chat
        if top and len(rivals) > 1 and top * 2 >= english and top > other:
            return last if last in rivals else None
        if english and english > top and english > other:
            return "en"
        return last if last in _LATIN_KEYS and not other else None


def _bill(expr: str) -> bool:
    """"3 x 999", "499*2": a price times a few pieces (a bill), not a sum to solve."""
    nums = sorted(int(n) for n in re.findall(r"\d+", expr)[:2])
    return len(nums) == 2 and nums[0] <= 12 and nums[1] >= 100 and re.search(r"[x×*]|times|into|multiplied|gun|গুণ|गुणा|ضرب", expr) is not None


def _reply_text(content) -> str:
    """Pip's stored reply: JSON with "text", or plain text."""
    if isinstance(content, list):
        content = " ".join(str(b.get("text", "")) for b in content if isinstance(b, dict))
    if not isinstance(content, str):
        return ""
    if content.startswith("{"):
        try:
            data = json.loads(content)
            return str(data.get("text") or "") if isinstance(data, dict) else content
        except ValueError:
            pass
    return content


def _asks(text: str) -> bool:
    """Does the last sentence ask something? A trailing emoji, markdown or quote doesn't hide the '?'."""
    s = re.sub(r"[\s*_~`\"')\]»”]+$", "", EMOJI.sub(" ", text).replace("\ufe0f", " ")).rstrip()
    s = s.rstrip(".!।۔ ")
    last = re.split(r"[.!।۔\n]", s)[-1]
    return "?" in last or "؟" in last or "？" in last
