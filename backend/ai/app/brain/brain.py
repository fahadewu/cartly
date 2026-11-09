"""Pip's rule-based brain: a faithful Python port of src/agent/brain.js.

`respond(input, memory, ctx)` mutates `memory` (a JSON-safe dict persisted in
Redis by the caller) and returns the reply dict:
    {text, speech?, products?: [ids], actions?: [...], chips?: [...], mood?}
"""
import math
import random
import re

from ..catalog import SLOT_LABEL, Catalog, needs_ai_tryon
from .parsing import (
    COLORS,
    ORDINALS,
    PAGES,
    TYPES,
    budget,
    money,
    normalise,
    occasion_of,
    ordinal_hit,
    parse_color,
    parse_filters,
    parse_size,
    stem,
    test,
    tokens,
    word_count,
)

TYPE_TAGS = {
    "Shoes": "shoe shoes sneaker sneakers trainer trainers footwear kicks",
    "Clothing": "clothes clothing wear outfit top",
    "Accessories": "accessory accessories",
    "Home": "home decor living gift",
    "Gifts": "gift gifts present",
}
NOUNS = {
    "Shoes": ["shoe", "shoes"],
    "Clothing": ["clothing pick", "clothing picks"],
    "Accessories": ["accessory", "accessories"],
    "Home": ["home piece", "home pieces"],
}

ADJUST = [
    (r"\b(reset|re-?fit|fit (it|them|everything) again|auto-?fit|pip'?s fit)\b", "reset", "Back to my fit ✨"),
    (r"\b(bigger|larger|scale up|size up)\b", "bigger", "Made it a little bigger."),
    (r"\b(smaller|scale down|size down|tinier)\b", "smaller", "Made it a little smaller."),
    (r"\b(wider|broader|looser)\b", "wider", "A bit wider now."),
    (r"\b(narrower|slimmer|thinner|tighter)\b", "narrower", "Slimmed it down a touch."),
    (r"\b(longer|lengthen|taller)\b", "longer", "Made it a little longer."),
    (r"\b(shorter|shorten)\b", "shorter", "Made it a little shorter."),
    (r"\bmove (it |this |that )?(up|higher)\b|\braise it\b", "up", "Moved it up."),
    (r"\bmove (it |this |that )?(down|lower)\b|\blower it\b", "down", "Moved it down."),
    (r"\bmove (it |this |that )?left\b", "left", "Moved it left."),
    (r"\bmove (it |this |that )?right\b", "right", "Moved it right."),
]

# Clothes and shoes when the AI try-on is off (the storefront's preview only shows accessories).
NEEDS_AI_TRYON = {
    "text": "Clothes and shoes need the AI try-on, which isn’t switched on here yet. I can put **glasses, hats, headphones, watches and bags** on you, though!",
    "chips": ["Show me sunglasses", "Show me bags"],
    "mood": "sorry",
}


# Something has gone wrong with an order, or the shopper is angry: English, Bangla and Banglish.
COMPLAINT = re.compile(
    r"\b(angry|furious|worst|terrible|useless|scam|fraud|cheat(ed|ing)?|complain(t)?|not (received|delivered|arrived)|never (came|arrived)|"
    r"where is my (order|parcel)|wrong (item|size|product)|damaged|broken|charged twice|money (taken|deducted|cut)|refund (not|hasn'?t)|"
    r"taka kete|taka kete niche|pai ?nai|pai ?ni|faltu|baje service|bajee|dhoka|protarona)\b"
    r"|পাইনি|পাই নাই|টাকা কেটে|প্রতারণা|ধোঁকা|বাজে সার্ভিস|ভুল (পণ্য|সাইজ)|নষ্ট|অভিযোগ",
    re.IGNORECASE,
)


def pick(options: list[str]) -> str:
    return random.choice(options)


def clean(reply: dict) -> dict:
    """Drop absent keys so the shape matches the JS replies exactly."""
    return {k: v for k, v in reply.items() if v is not None}


def plural(n: int) -> str:
    return "s" if n > 1 else ""


# Things Pip doesn't do. Product words win (see TYPES), so "a jacket for my exam trip" still shops.
OFF_TOPIC = re.compile(
    r"\b(homework|assignment|essay|solve|equation|calculus|algebra|coding|programming|python|javascript|"
    r"politic\w*|election|president|prime minister|government|religio\w*|headlines|latest news|weather forecast|"
    r"stock market|crypto|bitcoin|diagnos\w*|symptoms?|medicine|legal advice|recipe|tell me a joke|"
    r"write (me )?(a |an )?(poem|story|song|letter)|capital of|who won|your opinion on)\b"
    r"|^\s*(what('?s| is)\s+)?\d+(\s*[-+*/^x]\s*\d+)+\s*=?\s*\??\s*$"
)

class RuleBrain:
    def __init__(self, catalog: Catalog):
        self.catalog = catalog
        self._index_for = None
        self._index: list[dict] = []

    @property
    def rate(self) -> float | None:
        """Taka per US dollar, when the store has set one."""
        return (getattr(self.catalog, "payments", None) or {}).get("usdToBdt")

    # ---------- catalog index ----------
    @property
    def index(self) -> list[dict]:
        if self._index_for is not self.catalog.products:
            self._index = [
                {
                    "p": p,
                    "name": p["name"].lower(),
                    "blob": (
                        f"{p['name']} {p['label']} {p['type']} {TYPE_TAGS.get(p['type'], '')} {p['categoryTitle']} "
                        f"{p['description']} {' '.join(c['name'] for c in p['colors'])}"
                    ).lower(),
                }
                for p in self.catalog.products
            ]
            self._index_for = self.catalog.products
        return self._index

    def product(self, pid):
        return self.catalog.get(pid)

    def wearable(self, pid) -> bool:
        return self.catalog.is_wearable(pid)

    # ---------- search ----------
    def search(self, f: dict, limit: int = 4, offset: int = 0, exclude: list | None = None):
        exclude = exclude or []
        occ = occasion_of(f)
        terms = [*(f.get("terms") or []), *(occ["terms"] if occ else [])]
        types, gift, colors = f.get("types"), f.get("gift"), f.get("colors")
        lo, hi = f.get("min"), f.get("max")
        scored = []
        for e in self.index:
            p = e["p"]
            if p["id"] in exclude:
                continue
            if f.get("gender") and p["gender"] not in (f["gender"], "unisex"):
                continue
            if types and not (p["type"] in types or (gift and p["type"] == "Gifts")):
                continue
            if gift and not types and p["category"] != "gifts-living":
                continue
            if lo is not None and p["price"] < lo:
                continue
            if hi is not None and p["price"] > hi:
                continue
            if f.get("sale") and not p["compareAt"]:
                continue
            if f.get("isNew") and not p["isNew"]:
                continue
            if colors and not any(c["name"] in colors for c in p["colors"]):
                continue
            score = 0
            for w in terms:
                if len(w) < 2:
                    continue
                if w in e["name"]:
                    score += 4
                elif w in e["blob"]:
                    score += 1
            scored.append((e, score))

        has_terms = any(len(w) > 2 and any(w in x["blob"] for x in self.index) for w in (f.get("terms") or []))
        pool = [x for x in scored if x[1] > 0] if (has_terms or occ) else scored
        if f.get("sort") == "rating":
            pool.sort(key=lambda x: -x[0]["p"]["rating"])
        else:
            pool.sort(key=lambda x: (-x[1], -x[0]["p"]["popularity"]))
        return [e["p"] for e, _ in pool[offset : offset + limit]], len(pool)

    def describe(self, f: dict, n: int = 2) -> str:
        one = n == 1
        bits = []
        if f.get("colors"):
            bits.append(next((c for c, names in COLORS.items() if names == f["colors"]), "colourful"))
        if f.get("sale"):
            bits.append("on-sale")
        if f.get("isNew"):
            bits.append("new")
        who = "men's " if f.get("gender") == "men" else "women's " if f.get("gender") == "women" else ""
        occ = occasion_of(f)
        types = f.get("types") or []
        if f.get("gift"):
            what = "gift idea" if one else "gift ideas"
        elif len(types) == 1:
            what = NOUNS.get(types[0], ["pick", "picks"])[0 if one else 1]
        elif occ:
            what = re.sub(r"s$", "", occ["label"]) if one else occ["label"]
        else:
            what = "pick" if one else "picks"
        lo, hi = f.get("min"), f.get("max")
        price = ""
        if lo is not None and hi is not None:
            price = f" between {budget(lo, f.get('rate'))} and {budget(hi, f.get('rate'))}"
        elif hi is not None:
            price = f" under {budget(hi, f.get('rate'))}"
        elif lo is not None:
            price = f" over {budget(lo, f.get('rate'))}"
        return re.sub(r"\s+", " ", f"{' '.join(bits)} {who}{what}{price}").strip()

    # ---------- references ----------
    def resolve_ref(self, t: str, memory: dict):
        lst = memory.get("results") or []
        if test(r"\b(it|this|that|this one|that one)\b", t) and not ordinal_hit(t) and memory.get("focus"):
            return self.product(memory["focus"])
        for rx, i in ORDINALS:
            if rx.search(t) and lst:
                return self.product(lst[-1 if i == -1 else i])
        words = [stem(w) for w in tokens(t)]
        best, best_n = None, 0
        for e in self.index:
            n = sum(1 for w in words if len(w) > 2 and w in e["name"])
            if n > best_n:
                best, best_n = e["p"], n
        if best:
            return best
        return self.product(lst[0]) if len(lst) == 1 else None

    def out_of_range(self, t: str, memory: dict):
        n = len(memory.get("results") or [])
        hit = ordinal_hit(t)
        if not hit or hit[1] == -1 or hit[1] < n:
            return None
        return {
            "text": f"I only showed you {n} item{plural(n)} just now. Pick one of those, or ask me to “show more”."
            if n
            else "I haven’t shown you anything yet. What are you looking for?",
            "chips": ["Show more", "Add the first one"] if n else ["Show me trending sneakers"],
            "mood": "curious",
        }

    def result_chips(self, items: list[dict]) -> list[str]:
        first_wearable = next((i for i, p in enumerate(items) if self.wearable(p["id"])), None)
        chips = [
            "Add the first one" if items else None,
            f"Try on number {first_wearable + 1}" if first_wearable is not None else None,
            "Tell me about #2" if len(items) > 1 else None,
            "Show cheaper",
            "Show more",
        ]
        return [c for c in chips if c]

    # ---------- cart ----------
    def add_reply(self, product: dict, size: str, color: str, memory: dict) -> dict:
        memory["focus"] = product["id"]
        memory["pending"] = None
        name = product["name"]
        return {
            "text": pick([
                f"Done! I added the **{name}** ({color}, {size}) to your cart. Anything to go with it?",
                f"Great choice! The **{name}** in {color}, size {size}, is in your cart.",
                f"Added **{name}** · {color} · {size}. Want me to find something that matches?",
            ]),
            "actions": [{"type": "add", "id": product["id"], "size": size, "color": color}],
            "chips": ["Open my cart", "Find something that matches", "Checkout"],
            "mood": "happy",
        }

    def want_add(self, product: dict, t: str, memory: dict) -> dict:
        size = product["sizes"][0] if len(product["sizes"]) == 1 else parse_size(t, product)
        color = parse_color(t, product) or product["colors"][0]["name"]
        if not size:
            memory["pending"] = {"type": "size", "id": product["id"], "color": color}
            memory["focus"] = product["id"]
            return {
                "text": f"Love it. Which size would you like for the **{product['name']}**?",
                "speech": f"Love it. Which size would you like for the {product['name']}?",
                "chips": [f"Size {s}" for s in product["sizes"]],
                "products": [product["id"]],
                "mood": "curious",
            }
        return self.add_reply(product, size, color, memory)

    # ---------- main entry ----------
    def respond(self, input_text: str, memory: dict, ctx: dict | None = None) -> dict:
        return clean(self._respond(input_text, memory, ctx or {}))

    def _respond(self, input_text: str, memory: dict, ctx: dict) -> dict:
        t = normalise(input_text)
        name = f" {ctx['userName']}" if ctx.get("userName") else ""
        cart = ctx.get("cart") or []
        orders = ctx.get("orders") or []
        cart_total = ctx.get("cartTotal") or 0

        # 1. Answering a question Pip asked (size).
        pending = memory.get("pending")
        if pending and pending.get("type") == "size":
            product = self.product(pending["id"])
            if product:
                size = parse_size(t, product) or next((s for s in product["sizes"] if f" {s.lower()} " in t), None)
                if size:
                    return self.add_reply(product, size, parse_color(t, product) or pending.get("color"), memory)
                if not test(r"\b(no|cancel|never ?mind|stop|forget)\b", t) and word_count(t) <= 3:
                    return {
                        "text": f"Hmm, the {product['name']} comes in {', '.join(product['sizes'])}. Which one?",
                        "chips": [f"Size {s}" for s in product["sizes"]],
                        "mood": "curious",
                    }
            memory["pending"] = None

        # 2. Something has gone wrong: no cheerfulness, no shopping, and a person when the store has one.
        if COMPLAINT.search(t) or COMPLAINT.search(input_text):
            return self.complaint_reply(orders)

        # 3. Small talk.
        if test(r"^\s*(hi|hey|hello|hiya|yo|good (morning|afternoon|evening))\b", t) and word_count(t) <= 4:
            return {
                "text": pick([f"Hey{name}! 👋 What are we shopping for today?", f"Hi{name}! Tell me what you need and I'll find it."]),
                "chips": ["Show me trending sneakers", "Gift for my mom under $60", "Something cosy for winter"],
                "mood": "happy",
            }
        if test(r"\b(keep shopping|nothing|no thanks|that'?s all|i'?m good)\b", t):
            return {"text": "Sounds good! Just call me whenever you need something 🛍️", "chips": ["Show me new arrivals", "Show me deals"], "mood": "happy"}
        if (
            test(r"\b(thanks|thank you|thx|cheers|awesome|perfect|great|love it|nice)\b", t)
            and word_count(t) <= 5
            and not any(rx.search(t) for _, rx in TYPES)
        ):
            return {"text": pick(["Anytime! 💙", "Happy to help!", "You got it! Need anything else?"]), "chips": ["Show me deals", "Open my cart"], "mood": "happy"}
        if test(r"\b(who are you|your name|what are you)\b", t):
            return {
                "text": "I'm **Pip**, your little shopping buddy! I can search the store, compare products, add things to your cart and take you anywhere in the app.",
                "chips": ["What can you do?", "Show me new arrivals"],
                "mood": "happy",
            }
        if test(r"\b(help|what can you do|how does this work|commands)\b", t):
            return {
                "text": "Try asking me things like:\n• “Red sneakers under $100”\n• “A gift for my dad”\n• “Add the second one in size 42”\n• “Try on number 2” (see it on you!)\n• “Show cheaper” or “Only on sale”\n• “Where is my order?”\n• “Take me to checkout”",
                "speech": "You can ask me for products by colour, price or occasion, ask me to add things to your cart, check your orders, or take you to checkout.",
                "chips": ["Red sneakers under $100", "A gift for my dad", "Where is my order?"],
            }

        # Off-topic (homework, news, politics, code…): a sweet no, then back to shopping.
        if OFF_TOPIC.search(t) and not any(rx.search(t) for _, rx in TYPES):
            return {
                "text": pick([
                    f"Aww, that one's outside my wardrobe{name} 😊 I'm all about shopping, though. Shall I find you something lovely?",
                    "Oh, I wish I could help with that! I only know about Cartly's shop, but I'd love to style you instead 💙",
                ]),
                "speech": "That one's outside my wardrobe, but I'd love to help you find something lovely.",
                "chips": ["Show me new arrivals", "A gift idea", "Show me deals"],
                "mood": "love",
            }

        # 3. Cart, checkout and orders.
        if test(r"\b(check ?out|pay|place (the |my )?order|buy (it|them) now)\b", t):
            if not cart:
                return {"text": "Your cart is empty right now. Want me to find something first?", "chips": ["Show me popular picks"], "mood": "sorry"}
            n = len(cart)
            return {"text": f"Heading to checkout: {n} item{plural(n)}, {money(cart_total)} so far.", "actions": [{"type": "navigate", "to": "/checkout"}], "mood": "happy"}
        if test(r"\b(buy (it|that|them) again|reorder|order (it )?again)\b", t):
            if not orders:
                return {"text": "You don't have any past orders to repeat yet.", "chips": ["Show me popular picks"]}
            o = orders[0]
            return {"text": f"Added everything from order **{o['id']}** back to your cart.", "actions": [{"type": "reorder", "id": o["id"]}], "chips": ["Open my cart", "Checkout"], "mood": "happy"}
        if test(r"\b(cart|basket)\b", t) and not test(r"\b(add|put|throw|drop)\b", t):
            if not cart:
                return {"text": "Your cart is empty. Shall I suggest a few things?", "chips": ["Show me popular picks", "Show me deals"], "mood": "sorry"}
            n = len(cart)
            lines = "\n".join(f"• {l['qty']} × {l['name']}" for l in cart)
            return {
                "text": f"You have {n} item{plural(n)} ({money(cart_total)}):\n{lines}",
                "speech": f"You have {n} item{plural(n)} in your cart, totalling {money(cart_total)}.",
                "actions": [{"type": "openCart"}],
                "chips": ["Checkout", "Keep shopping"],
            }
        if test(r"\b(where('?s| is)|track|status|when will|arriv)\b.*\b(order|package|parcel|delivery)\b|\bmy (last |latest )?order\b", t):
            if not orders:
                return {"text": "You haven't placed any orders yet.", "chips": ["Show me popular picks"]}
            o = orders[0]
            status = str(o["status"]).lower()
            n = len(o.get("items") or [])
            return {
                "text": f"Your latest order **{o['id']}** is **{status}**. It has {n} item{plural(n)} and came to {money(o['total'])}. I've opened it for you.",
                "speech": f"Your latest order is {status}. I've opened it for you.",
                "actions": [{"type": "navigate", "to": f"/orders/{o['id']}"}],
                "chips": ["Show all orders", "Buy it again"],
            }

        # 4a. Virtual try-on.
        try_on = ctx.get("tryOn") or {}
        has_photo = bool(try_on.get("hasPhoto"))
        wearing = try_on.get("on") or []
        if test(r"\b(sample model|use a model|use (the |a )?sample|model instead)\b", t):
            return {"text": "Sure! I’ll use a sample model so you can see how things look. You can switch to your own photo any time.", "actions": [{"type": "sampleModel"}], "chips": ["Try on sunglasses", "Show me shoes"], "mood": "happy"}
        if test(r"\b(fitting room|dressing room|try-?on (room|studio))\b", t) and not test(r"\btry (it|this|that|them|number|the)\b", t):
            return {
                "text": "Opening your fitting room ✨" if has_photo else "Opening the fitting room! First I’ll need a full-length photo of you.",
                "actions": [{"type": "fittingRoom"}],
                "chips": ["Try on number 1", "Show me dresses"],
            }
        if wearing:
            hit = next(((rx, op, msg) for rx, op, msg in ADJUST if re.search(rx, t)), None)
            if hit and not test(r"\b(cheaper|expensive|price)\b", t):
                _, op, msg = hit
                all_ = op == "reset" and test(r"\b(everything|all|them|whole)\b", t)
                memory["lastAdjust"] = None if op == "reset" else op
                return {
                    "text": f"{msg} Keep telling me, or use the sliders in the fitting room.",
                    "speech": msg,
                    "actions": [{"type": "adjust", "op": op, "all": all_}],
                    "chips": ["Make it bigger", "Move it up"] if op == "reset" else ["A bit more", "Reset the fit", "Looks good"],
                    "mood": "happy",
                }
            if test(r"\b(a bit more|a little more|more|again)\b", t) and memory.get("lastAdjust") and word_count(t) <= 4:
                return {"text": "A little more, done.", "actions": [{"type": "adjust", "op": memory["lastAdjust"]}], "chips": ["A bit more", "Reset the fit", "Looks good"], "mood": "happy"}
        if test(r"\b(looks good|perfect fit|that'?s (good|perfect|great))\b", t) and wearing:
            return {"text": "Looking sharp! 😍 Want to add the look to your cart or keep styling?", "chips": ["Add the look to cart", "Try on sunglasses", "Show me shoes"], "mood": "happy"}
        if test(r"\b(take (it|that|this|them|everything|it all) off|remove (it|that|this)|undress|take off)\b", t) and wearing:
            all_ = test(r"\b(everything|it all|them|all)\b", t)
            return {
                "text": "All cleared! Your fitting room is empty again." if all_ else "Done, I took it off. Want to try something else?",
                "actions": [{"type": "clearLook" if all_ else "untry"}],
                "chips": ["Show me something else", "Show me shoes"],
            }
        if test(r"\b(add|buy|get) (the |my |this |whole )?(look|outfit)\b", t) and wearing:
            return {
                "text": f"Adding your whole look to the cart: {', '.join(str(x.get('name')) for x in wearing)}.",
                "actions": [{"type": "buyLook"}],
                "chips": ["Checkout", "Keep shopping"],
                "mood": "happy",
            }
        if test(r"\b(try (it|this|that|them|these|number|the|on)|try-?on|on me|how (would|does|will) (it|this|that|they).*look|see (it|this|that) on|wear it|put (it|this|that) on)\b", t):
            oor = self.out_of_range(t, memory)
            if oor:
                return oor
            product = self.resolve_ref(t, memory)
            if not product:
                # "try on a red dress": search for it and put the best match on.
                f = parse_filters(re.sub(r"\b(try|on|me|wear|see|how|would|look)\b", " ", t), self.rate)
                items, _ = self.search(f, limit=6)
                wearable = next((p for p in items if self.wearable(p["id"])), None)
                if not wearable and any(needs_ai_tryon(p) for p in items):
                    return {**NEEDS_AI_TRYON}
                if not wearable:
                    return {"text": "Tell me which item to try on, e.g. “try on number 2” or “try on a red dress”.", "chips": ["Show me dresses", "Show me sunglasses"], "mood": "curious"}
                memory["results"] = [p["id"] for p in items if self.wearable(p["id"])][:4]
                memory["focus"] = wearable["id"]
                return self.try_on_reply(wearable, has_photo, memory["results"])
            if needs_ai_tryon(product):
                return {**NEEDS_AI_TRYON}
            if not self.wearable(product["id"]):
                return {
                    "text": f"The **{product['name']}** isn’t something you can wear, so I can’t put it on you, but it would look great in your cart!",
                    "chips": ["Add it to my cart", "Show me something to wear"],
                    "mood": "sorry",
                }
            memory["focus"] = product["id"]
            return self.try_on_reply(product, has_photo)

        # 4b. Acting on a product Pip showed.
        results = memory.get("results") or []
        if test(r"\b(add|put|throw|get me|i'?ll take|buy)\b", t):
            oor = self.out_of_range(t, memory)
            if oor:
                return oor
            product = self.resolve_ref(t, memory)
            if product:
                return self.want_add(product, t, memory)
            if not results and not test(r"\b(shoes?|dress|jacket|bag|watch|gift)\b", t):
                return {"text": "Sure! Which product should I add? Tell me what you’re looking for first.", "chips": ["Show me trending sneakers"], "mood": "curious"}
        if test(r"\b(save|favou?rite|like|wishlist|heart)\b", t) and not test(r"\b(my favou?rites|show)\b", t):
            oor = self.out_of_range(t, memory)
            if oor:
                return oor
            product = self.resolve_ref(t, memory)
            if product:
                memory["focus"] = product["id"]
                return {"text": f"Saved **{product['name']}** to your favourites ❤️", "actions": [{"type": "like", "id": product["id"]}], "chips": ["Show my favourites"], "mood": "happy"}
        if test(r"\b(tell me (more )?about|details|more about|describe|what about|more info)\b", t) and results:
            oor = self.out_of_range(t, memory)
            if oor:
                return oor
            product = self.resolve_ref(t, memory)
            if product:
                memory["focus"] = product["id"]
                p = product
                was = f" (was {money(p['compareAt'])})" if p["compareAt"] else ""
                sizes = f", sizes {p['sizes'][0]}–{p['sizes'][-1]}" if len(p["sizes"]) > 1 else ""
                return {
                    "text": f"**{p['name']}** · {money(p['price'])}{was}\n{p['description']}\nRated {p['rating']:.1f}★ by {p['reviews']} shoppers. Comes in {' and '.join(c['name'] for c in p['colors'])}{sizes}.",
                    "speech": f"The {p['name']} is {money(p['price'])}. {p['description']}",
                    "products": [p["id"]],
                    "chips": ["Add it to my cart", "Open the product page", "Show similar"],
                }
        if memory.get("focus") and test(r"\b(runs?|fits?|comes?) (small|big|large|tight|true)|\btrue to size\b|\b(what|which) size\b|\bsize (up|down)\b|\bhow (does|do) (it|they|this|that) fit\b", t):
            p = self.product(memory["focus"])
            if p:
                return self.fit_reply(p)
        if test(r"\b(open|go to|view) (the )?product( page)?\b", t) and memory.get("focus"):
            return {"text": "Opening it now.", "actions": [{"type": "navigate", "to": f"/product/{memory['focus']}"}]}
        if test(r"\bcompare\b", t) and len(results) >= 2:
            a, b = self.product(results[0]), self.product(results[1])
            if a and b:
                cheaper = a if a["price"] <= b["price"] else b
                better = a if a["rating"] >= b["rating"] else b
                return {
                    "text": f"**{a['name']}**: {money(a['price'])}, {a['rating']:.1f}★\n**{b['name']}**: {money(b['price'])}, {b['rating']:.1f}★\nThe {cheaper['name']} is the better deal; the {better['name']} has the happier reviewers.",
                    "products": [a["id"], b["id"]],
                    "chips": ["Add the first one", "Add the second one"],
                }

        # 5. Navigation. "show me deals" lists products; "take me to deals" navigates.
        explicit_nav = test(r"\b(go to|take me|open|navigate|bring me|visit|request this)\b", t)
        if explicit_nav or test(r"\bshow( me)?( my| all)?\b", t):
            page = next((pg for pg in PAGES if pg["re"].search(t) and (explicit_nav or not pg.get("catalog"))), None)
            if page and not any(rx.search(t) for _, rx in TYPES):
                return {"text": f"Taking you to {page['name']}.", "actions": [{"type": "navigate", "to": page["to"]}]}

        # 6. Refinements on the last search (only when the message doesn't describe something new).
        fresh = parse_filters(t, self.rate)
        bare = not fresh.get("types") and fresh.get("occasion") is None and not fresh.get("gift") and not any(len(w) > 2 for w in fresh["terms"])
        last = memory.get("filters") if bare else None
        prices = [p["price"] for p in (self.product(i) for i in results) if p]
        if last and test(r"\b(cheaper|less expensive|lower price|more affordable)\b", t):
            cap = min([*prices, last["max"] if last.get("max") is not None else math.inf])
            new_max = max(10, math.floor(cap - 1)) if math.isfinite(cap) else None
            return self.run_search({**last, "max": new_max, "min": None}, memory, name, refine="cheaper")
        if last and test(r"\b(more expensive|premium|fancier|higher end|nicer)\b", t):
            return self.run_search({**last, "min": math.ceil(max([*prices, 0]) + 1), "max": None}, memory, name, refine="pricier")
        if last and test(r"\b(show more|more options|others|something else|anything else|different|next)\b", t):
            return self.run_search(last, memory, name, offset=(memory.get("offset") or 0) + (len(memory["results"]) if memory.get("results") is not None else 4))
        if last and test(r"\b(similar|like this|matches|go with it|match)\b", t) and memory.get("focus"):
            fp = self.product(memory["focus"])
            if fp:
                return self.run_search(
                    {"types": ["Clothing"] if fp["type"] == "Shoes" else ["Shoes", "Accessories"], "gender": None if fp["gender"] == "unisex" else fp["gender"], "terms": []},
                    memory, name, exclude=[fp["id"]], refine="match",
                )
        if last and word_count(t) <= 5:
            extra = {k: v for k, v in fresh.items() if v is not None and not (isinstance(v, list) and not v)}
            return self.run_search({**last, **extra, "terms": last.get("terms") or []}, memory, name)

        long_terms = [w for w in fresh["terms"] if len(w) > 2]
        any_filter = any(fresh.get(k) for k in ("types", "colors", "gender", "sale", "isNew", "gift", "sort")) or fresh.get("min") is not None or fresh.get("max") is not None or fresh.get("occasion") is not None

        # "Surprise me", but not "anything for a beach day?": a message that says what it wants is a search.
        if test(r"\b(surprise me|random|anything|inspire me)\b", t) and not any_filter and not [w for w in long_terms if w not in ("surprise", "random", "inspire")]:
            items = random.sample(self.catalog.products, min(4, len(self.catalog.products)))
            memory["results"] = [p["id"] for p in items]
            memory["filters"] = {"terms": []}
            return {"text": "Ooh, fun! Here are four random things I love right now ✨", "products": memory["results"], "chips": self.result_chips(items), "mood": "happy"}

        # 7. Everything else is a product search.
        unknown = [w for w in long_terms if not any(w in e["blob"] for e in self.index)]
        if unknown and len(unknown) == len(long_terms) and not any_filter:
            items, _ = self.search({"sort": "popular", "terms": []})
            memory["results"] = [p["id"] for p in items]
            memory["filters"] = {"terms": []}
            return {
                "text": f"Hmm, I don't think we carry “{' '.join(unknown)}”. You can send a request and our buyers will try to find it. Meanwhile, here's what's popular:",
                "products": memory["results"],
                "chips": ["Request this product", "Show me deals", "What can you do?"],
                "mood": "sorry",
                "wanted": " ".join(unknown)[:120],
            }
        return self.run_search(fresh, memory, name, wanted=input_text)

    def complaint_reply(self, orders: list) -> dict:
        sup = getattr(self.catalog, "support", None) or {}
        human = bool(sup.get("whatsapp") or sup.get("phone"))
        latest = orders[0] if orders else None
        seen = f" I can see order {latest['id']} is {str(latest['status']).lower()}." if latest else ""
        text = (
            "I'm sorry about this." + seen
            + (" A person on our team can sort it out with you, here's how to reach them." if human else " Open the order from your Orders page and you'll see every option for it there.")
        )
        reply = {"text": text, "mood": "sorry", "chips": ["Show my orders"]}
        if human:
            reply["actions"] = [{"type": "human"}]
        return reply

    def fit_reply(self, p: dict) -> dict:
        """How a product fits: what shoppers reported first (fit reviews and size returns), then the store's own notes."""
        said = {
            "small": f"Shoppers say the **{p['name']}** runs small, so go one size up from your usual.",
            "large": f"Shoppers say the **{p['name']}** runs large, so go one size down from your usual.",
            "true": f"Shoppers say the **{p['name']}** is true to size, so your usual size is right.",
        }.get(p.get("fitVerdict") or "")
        own = "; ".join(x for x in (p.get("fit") and f"{p['fit']} fit", p.get("fitNotes")) if x)
        if said:
            text = said + (f" It's a {own}." if own else "")
        elif own:
            text = f"The **{p['name']}** is a {own}. Not enough shoppers have said how it fits yet."
        else:
            text = f"Not enough shoppers have said how the **{p['name']}** fits yet, so your usual size is the safest pick."
        reply = {"text": text, "products": [p["id"]], "chips": ["Add it to my cart", "Show similar"], "mood": "happy"}
        if len(p["sizes"]) > 1:
            reply["askSize"] = p["id"]
        return reply

    def try_on_reply(self, product: dict, has_photo: bool, products: list | None = None) -> dict:
        slot = SLOT_LABEL.get(product.get("tryOnSlot") or "", "").lower()
        if not has_photo:
            return {
                "text": f"Let’s see the **{product['name']}** on you! 📸 I need a **full-length photo** first: head to toe, facing the camera. Upload one, take one with your camera, or pick a sample model.",
                "speech": f"Let's see the {product['name']} on you! I need a full-length photo first, head to toe, facing the camera. You can upload one, take one with your camera, or use a sample model.",
                "actions": [{"type": "tryon", "id": product["id"]}],
                "products": products,
                "chips": ["Use a sample model"],
                "mood": "curious",
            }
        nxt = {"top": "Show matching trousers", "outerwear": "Show me t-shirts", "dress": "Try on heels", "bottoms": "Show me tops", "shoes": "Try on sunglasses"}.get(slot, "Show me shoes")
        return {
            "text": f"I’ve fitted the **{product['name']}** to your body ✨ If anything looks off, drag it or just tell me, like “make it a bit bigger” or “move it up”. Want to add more to the look?",
            "actions": [{"type": "tryon", "id": product["id"]}],
            "products": products,
            "chips": [nxt, "Take it off", "Add the look to cart"],
            "mood": "happy",
        }

    def preview(self, text: str) -> list[int]:
        """Live suggestions while the shopper is still talking: search only, no memory."""
        t = f" {text.lower()} "
        if len(t.strip()) < 3:
            return []
        f = parse_filters(t, self.rate)
        meaningful = (
            f.get("types") or f.get("colors") or f.get("gift") or f.get("occasion") is not None or f.get("sale") or f.get("isNew")
            or f.get("max") is not None or f.get("min") is not None
            or any(len(w) > 2 and any(w in e["name"] for e in self.index) for w in f["terms"])
        )
        if not meaningful:
            return []
        return [p["id"] for p in self.search(f, limit=6)[0]]

    def run_search(
        self, f: dict, memory: dict, name: str, offset: int = 0, exclude: list | None = None, refine: str | None = None, wanted: str | None = None
    ) -> dict:
        """`wanted`: the shopper's own words for a fresh search, kept when nothing matches (see below)."""
        f = {k: v for k, v in f.items() if v is not None}
        exclude = exclude or []
        items, total = self.search(f, offset=offset, exclude=exclude)
        relaxed = False
        if not items and offset == 0:
            # Relax the strictest constraints: first colour/new/sale, then (unless asked for cheaper) the price.
            loose = {k: v for k, v in f.items() if k not in ("colors", "isNew", "sale")}
            items, total = self.search(loose, exclude=exclude)
            if not items and refine != "cheaper":
                items, total = self.search({k: v for k, v in loose.items() if k not in ("min", "max")}, exclude=exclude)
            relaxed = bool(items)

        if not items:
            return {
                "text": "That's everything I've got for that search! Want to try something different?"
                if offset
                else f"Hmm, I couldn't find anything for that{name}. Try describing it differently, like “black sneakers” or “gift under $50”.",
                "chips": ["Show me popular picks", "Show me deals", "Surprise me"],
                "mood": "sorry",
                # What they asked for, so the store can tell them when it arrives (the API's outreach worker).
                **({"wanted": wanted.strip()[:120]} if wanted and wanted.strip() and not offset else {}),
            }

        memory["filters"] = f
        memory["offset"] = offset
        memory["results"] = [p["id"] for p in items]
        memory["focus"] = items[0]["id"]
        what = self.describe(f)
        top = items[0]

        if relaxed:
            text = f"No exact match for {what}, but these are close:"
        elif len(items) == 1:
            text = f"I found one {self.describe(f, 1)}: the **{top['name']}** at {money(top['price'])}."
        elif refine == "cheaper":
            text = f"Here are some more budget-friendly options, all under {money(f['max'] + 1)}:" if f.get("max") is not None else "Here are some more budget-friendly options:"
        elif refine == "pricier":
            text = "Treat yourself! A few more premium picks:"
        elif refine == "match":
            text = "These would pair nicely with it:"
        elif offset:
            text = f"Here are {len(items)} more {what}:"
        else:
            text = pick([
                f"Found {total} {what}. Here are my top {len(items)}: the **{top['name']}** is a crowd favourite at {money(top['price'])}.",
                f"Here are {len(items)} {what} I think you'll love. My pick is the **{top['name']}** ({money(top['price'])}).",
                f"Ooh, good taste! {total} {what} match. Start with the **{top['name']}**, it's {money(top['price'])}.",
            ])

        return {
            "text": text,
            "speech": f"{text.replace('**', '')} Say “add number one” or ask for something cheaper.",
            "products": memory["results"],
            "chips": self.result_chips(items),
            "mood": "curious" if relaxed else "happy",
        }

    def greeting(self, user_name: str | None = None) -> dict:
        n = f" {user_name}" if user_name else ""
        return {
            "text": f"Hi{n}! I'm **Pip** 👋 your shopping buddy. Tell me what you're after (a colour, a budget, an occasion) and I'll find it.",
            "speech": f"Hi{n}! I'm Pip, your shopping buddy. What are we looking for today?",
            "chips": ["Show me trending sneakers", "Try on a red dress", "Gift for my mom under $60", "What can you do?"],
            "mood": "happy",
        }
