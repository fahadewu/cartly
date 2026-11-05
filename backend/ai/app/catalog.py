"""In-memory product catalog loaded from Postgres (refreshed on reindex).

Products are exposed as dicts shaped like the frontend's `src/data.js`
entries so the ported brain can use them unchanged.
"""
from . import db
from .config import settings

SLOT_LABEL = {
    "top": "Top", "outer": "Outerwear", "dress": "Dress", "bottom": "Bottoms", "feet": "Shoes",
    "eyes": "Eyewear", "head": "Headwear", "ears": "Headphones", "wrist": "Watch", "hand": "Bag",
}
# What the storefront's on-device quick preview can show convincingly: small, rigid items. Clothes and
# shoes need the AI try-on (a flat cut-out can't drape, go behind the arms or replace what you're wearing).
PREVIEW_SLOTS = {"eyes", "head", "ears", "wrist", "hand"}


def wearable(p: dict | None) -> bool:
    """Can the shopper try it on here: anything with a slot when AI try-on is on, else accessories."""
    slot = p and p.get("tryOnSlot")
    return bool(slot) and (bool(settings.fashn_api_key) or slot in PREVIEW_SLOTS)


def needs_ai_tryon(p: dict | None) -> bool:
    """Wearable in principle, but only with the AI try-on, which is off."""
    return bool(p and p.get("tryOnSlot")) and not wearable(p)

SQL = """
SELECT p.id, p.slug, p.name, p.description, p."categorySlug" AS category, c.title AS category_title,
       p.type, p.gender::text AS gender, p.label, p.price, p."compareAt" AS compare_at, p."isNew" AS is_new,
       p.rating, p."reviewCount" AS reviews, p.popularity, p.image, p.colors, p.sizes, p.collections,
       p."tryOnSlot" AS try_on_slot, p."tryOnImage" AS try_on_image, p."tryOnInfo" AS try_on_info, p.stock,
       p.material, p.fit, p."fitNotes" AS fit_notes, p.occasions, p.seasons, p."styleTags" AS style_tags,
       p.features, p.keywords, p."careNotes" AS care_notes, p."pairsWith" AS pairs_with,
       p."fitVerdict" AS fit_verdict
FROM public."Product" p LEFT JOIN public."Category" c ON c.slug = p."categorySlug"
WHERE p.active
ORDER BY p.id
"""
# How shoppers can pay (set in the admin panel), so Pip answers "can I pay with bKash?" correctly.
PAYMENTS_SQL = """
SELECT m.id, (SELECT s.value FROM public."StoreSetting" s WHERE s.key = 'usdToBdt') AS rate
FROM public."PaymentMethod" m WHERE m.enabled AND m.id <> 'demo' ORDER BY m.position
"""
# Whether a person can take over from Pip (Admin → Returns → Support contact). Pip only learns that one exists;
# the numbers are shown by the storefront's hand-off card.
SUPPORT_SQL = """SELECT value FROM public."StoreSetting" WHERE key = 'supportContact'"""
PAYMENT_LABEL = {"bkash": "bKash", "nagad": "Nagad", "rocket": "Rocket", "card": "debit/credit card", "cod": "cash on delivery"}


def _num(v):
    if v is None:
        return None
    f = float(v)
    return int(f) if f.is_integer() else f


def normalise(r: dict) -> dict:
    return {
        "id": r["id"],
        "slug": r["slug"],
        "name": r["name"],
        "description": r["description"],
        "category": r["category"],
        "categoryTitle": r.get("category_title") or r["category"],
        "type": r["type"],
        "gender": r["gender"],
        "label": r["label"],
        "price": _num(r["price"]),
        "compareAt": _num(r["compare_at"]),
        "isNew": bool(r["is_new"]),
        "rating": float(r["rating"]),
        "reviews": r["reviews"],
        "popularity": r["popularity"],
        "image": r["image"],
        "colors": list(r["colors"] or []),
        "sizes": list(r["sizes"] or []) or ["One size"],
        "collections": list(r["collections"] or []),
        "tryOnSlot": r["try_on_slot"],  # set per product in the admin panel
        # The clean product photo the AI try-on uses, and the admin's notes on it (photo type, styling).
        "tryOnImage": r.get("try_on_image") or None,
        "tryOnInfo": r.get("try_on_info") or {},
        "stock": r["stock"],
        # What Pip and search know beyond the description (the admin panel requires most of these).
        "material": r.get("material"),
        "fit": r.get("fit"),
        "fitNotes": r.get("fit_notes"),
        "occasions": list(r.get("occasions") or []),
        "seasons": list(r.get("seasons") or []),
        "styleTags": list(r.get("style_tags") or []),
        "features": list(r.get("features") or []),
        "keywords": list(r.get("keywords") or []),
        "careNotes": r.get("care_notes"),
        "pairsWith": list(r.get("pairs_with") or []),
        # How it really fits, from shoppers' fit reviews and size returns ("small" | "true" | "large" | None).
        "fitVerdict": r.get("fit_verdict"),
    }


class Catalog:
    def __init__(self, products: list[dict] | None = None):
        self.payments: dict = {"methods": [], "usdToBdt": None}
        self.support: dict = {}
        self.set(products or [])

    def set(self, products: list[dict]) -> None:
        self.products = products
        self.by_id = {p["id"]: p for p in products}

    async def load(self) -> "Catalog":
        rows = await db.fetch(SQL)
        try:
            pay = await db.fetch(PAYMENTS_SQL)
            self.payments = {
                "methods": [PAYMENT_LABEL.get(r["id"], r["id"]) for r in pay],
                "usdToBdt": float(pay[0]["rate"]) if pay and pay[0]["rate"] is not None else None,
            }
        except Exception:
            self.payments = {"methods": [], "usdToBdt": None}
        try:
            row = await db.fetch(SUPPORT_SQL)
            v = (row[0]["value"] if row else None) or {}
            self.support = {"whatsapp": bool(v.get("whatsapp")), "phone": bool(v.get("phone")), "hours": str(v.get("hours") or "")[:60] or None}
        except Exception:
            self.support = {}
        self.set([normalise(r) for r in rows])
        return self

    def get(self, pid) -> dict | None:
        try:
            return self.by_id.get(int(pid))
        except (TypeError, ValueError):
            return None

    def is_wearable(self, pid) -> bool:
        return wearable(self.get(pid))


catalog = Catalog()
