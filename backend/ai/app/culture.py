"""Where and when is the shopper? Region, season and the festivals and shopping
moments coming up for them, so Pip can join in ("Durga Puja is next week!").

The region is a guess from the device's language tag and time zone, never from
anything the shopper said. Moon-sighted dates (Ramadan, Eid) can shift by a day.
"""
import re
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

# A BCP-47 language tag ("bn", "bn-BD", "zh-Hant-TW", "es-419"); the browser sends them, so anything else is noise.
TAG = re.compile(r"^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,2}$")

COUNTRY = {
    "AE": "the UAE", "AR": "Argentina", "AU": "Australia", "BD": "Bangladesh", "BR": "Brazil", "CA": "Canada",
    "CL": "Chile", "CN": "China", "CO": "Colombia", "DE": "Germany", "EG": "Egypt", "ES": "Spain", "FR": "France",
    "GB": "the UK", "HK": "Hong Kong", "ID": "Indonesia", "IE": "Ireland", "IN": "India", "IR": "Iran", "IT": "Italy",
    "JP": "Japan", "KE": "Kenya", "KR": "South Korea", "LK": "Sri Lanka", "MA": "Morocco", "MX": "Mexico",
    "MY": "Malaysia", "NG": "Nigeria", "NL": "the Netherlands", "NP": "Nepal", "NZ": "New Zealand", "PE": "Peru",
    "PH": "the Philippines", "PK": "Pakistan", "PL": "Poland", "PT": "Portugal", "QA": "Qatar", "RU": "Russia",
    "SA": "Saudi Arabia", "SE": "Sweden", "SG": "Singapore", "TH": "Thailand", "TR": "Türkiye", "TW": "Taiwan",
    "UA": "Ukraine", "US": "the US", "VN": "Vietnam", "ZA": "South Africa",
}
# Time zones for when the language tag carries no region (e.g. plain "bn" or "en").
TZ_COUNTRY = {
    "Asia/Dhaka": "BD", "Asia/Kolkata": "IN", "Asia/Calcutta": "IN", "Asia/Karachi": "PK", "Asia/Kathmandu": "NP",
    "Asia/Colombo": "LK", "Asia/Jakarta": "ID", "Asia/Kuala_Lumpur": "MY", "Asia/Singapore": "SG",
    "Asia/Bangkok": "TH", "Asia/Manila": "PH", "Asia/Ho_Chi_Minh": "VN", "Asia/Saigon": "VN", "Asia/Shanghai": "CN",
    "Asia/Hong_Kong": "HK", "Asia/Taipei": "TW", "Asia/Tokyo": "JP", "Asia/Seoul": "KR", "Asia/Dubai": "AE",
    "Asia/Riyadh": "SA", "Asia/Qatar": "QA", "Asia/Tehran": "IR", "Europe/Istanbul": "TR", "Africa/Cairo": "EG",
    "Africa/Casablanca": "MA", "Africa/Lagos": "NG", "Africa/Nairobi": "KE", "Africa/Johannesburg": "ZA",
    "Europe/London": "GB", "Europe/Dublin": "IE", "Europe/Paris": "FR", "Europe/Berlin": "DE", "Europe/Madrid": "ES",
    "Europe/Rome": "IT", "Europe/Amsterdam": "NL", "Europe/Stockholm": "SE", "Europe/Warsaw": "PL",
    "Europe/Lisbon": "PT", "Europe/Kyiv": "UA", "Europe/Kiev": "UA", "Europe/Moscow": "RU",
    "America/New_York": "US", "America/Chicago": "US", "America/Denver": "US", "America/Los_Angeles": "US",
    "America/Phoenix": "US", "America/Toronto": "CA", "America/Vancouver": "CA", "America/Mexico_City": "MX",
    "America/Sao_Paulo": "BR", "America/Argentina/Buenos_Aires": "AR", "America/Bogota": "CO", "America/Lima": "PE",
    "America/Santiago": "CL", "Australia/Sydney": "AU", "Australia/Melbourne": "AU", "Australia/Perth": "AU",
    "Pacific/Auckland": "NZ",
}
SOUTH = {"AR", "AU", "BR", "CL", "NZ", "PE", "ZA"}
TROPICAL = {"BD", "CO", "ID", "IN", "KE", "LK", "MY", "NG", "NP", "PH", "SG", "TH", "VN"}
SOUTH_ASIA = {"BD", "IN", "LK", "NP", "PK"}

MUSLIM = {"AE", "BD", "EG", "ID", "IR", "MA", "MY", "NG", "PK", "QA", "SA", "TR"}
HINDU = {"IN", "NP", "BD", "LK", "MY", "SG"}
LUNAR_NY = {"CN", "HK", "TW", "SG", "MY", "VN", "KR"}
ANGLO = {"US", "CA", "GB", "IE", "AU", "NZ"}
GLOBAL = None  # visible almost everywhere online


def _range(y, m, d, days=1):
    start = date(y, m, d)
    return start, start + timedelta(days=days - 1)


def _day(d):
    return d, d


def _nth_weekday(y, month, weekday, n):
    """n-th weekday (Mon=0) of a month; n=-1 means the last one."""
    if n > 0:
        d = date(y, month, 1)
        d += timedelta(days=(weekday - d.weekday()) % 7)
        return d + timedelta(weeks=n - 1)
    d = date(y, month + 1, 1) - timedelta(days=1) if month < 12 else date(y, 12, 31)
    return d - timedelta(days=(d.weekday() - weekday) % 7)


def _easter(y):
    """Western Easter Sunday (anonymous Gregorian algorithm)."""
    a, b, c = y % 19, y // 100, y % 100
    d, e = b // 4, b % 4
    f = (b + 8) // 25
    g = (b - f + 1) // 3
    h = (19 * a + b - d - g + 15) % 30
    i, k = c // 4, c % 4
    l = (32 + 2 * e + 2 * i - h - k) % 7
    m = (a + 11 * h + 22 * l) // 451
    month = (h + l - 7 * m + 114) // 31
    return date(y, month, (h + l - 7 * m + 114) % 31 + 1)


def _m(name, span, where, angle):
    return {"name": name, "start": span[0], "end": span[1], "where": where, "angle": angle}


# Lunar and lunisolar dates, checked against published calendars (Sep 2026).
DATED = [
    _m("Ramadan", _range(2026, 2, 18, 30), MUSLIM, "modest, comfortable pieces and Eid gift planning"),
    _m("Eid al-Fitr", _range(2026, 3, 20, 3), MUSLIM, "new outfits for Eid, gifts for family (Eidi / Eid salami)"),
    _m("Eid al-Adha", _range(2026, 5, 27, 3), MUSLIM, "festive outfits and gifts"),
    _m("Lunar New Year", _range(2026, 2, 17, 3), LUNAR_NY, "something red, gifts for family"),
    _m("Holi", _range(2026, 3, 3, 2), {"IN", "NP"}, "white clothes you don't mind getting colourful"),
    _m("Durga Puja", _range(2026, 10, 17, 5), {"BD", "IN"}, "festive outfits for pandal-hopping, gifts, comfy shoes for all that walking"),
    _m("Diwali", _range(2026, 11, 6, 5), HINDU, "festive outfits, gifts and home pieces"),
    _m("Hanukkah", _range(2026, 12, 4, 9), {"US", "CA", "GB", "IL"}, "eight nights of small gifts"),
    _m("Lunar New Year (Year of the Goat)", _range(2027, 2, 6, 3), LUNAR_NY, "something red, gifts for family"),
    _m("Ramadan", _range(2027, 2, 8, 30), MUSLIM, "modest, comfortable pieces and Eid gift planning"),
    _m("Eid al-Fitr", _range(2027, 3, 9, 3), MUSLIM, "new outfits for Eid, gifts for family (Eidi / Eid salami)"),
    _m("Holi", _range(2027, 3, 22, 2), {"IN", "NP"}, "white clothes you don't mind getting colourful"),
    _m("Eid al-Adha", _range(2027, 5, 16, 3), MUSLIM, "festive outfits and gifts"),
    _m("Mid-Autumn Festival", _range(2027, 9, 15, 1), {"CN", "HK", "TW", "SG", "MY", "VN"}, "gifts and a cosy evening look"),
    _m("Durga Puja", _range(2027, 10, 5, 5), {"BD", "IN"}, "festive outfits for pandal-hopping, gifts, comfy shoes"),
    _m("Diwali", _range(2027, 10, 27, 5), HINDU, "festive outfits, gifts and home pieces"),
]


def _yearly(y):
    thanksgiving = _nth_weekday(y, 11, 3, 4)
    easter = _easter(y)
    return [
        _m("New Year", _range(y, 1, 1), GLOBAL, "a fresh-start piece, party outfits for the night before"),
        _m("Valentine's Day", _range(y, 2, 14), GLOBAL, "gifts and a date-night look"),
        _m("International Mother Language Day (Ekushey)", _range(y, 2, 21), {"BD"}, "white and black, a thoughtful day"),
        _m("Carnival", (easter - timedelta(days=50), easter - timedelta(days=47)), {"BR"}, "bold colours and comfy shoes"),
        _m("International Women's Day", _range(y, 3, 8), GLOBAL, "gifts for the women in your life"),
        _m("Mothering Sunday", _day(easter - timedelta(days=21)), {"GB", "IE"}, "gifts for mum"),
        _m("Nowruz", _range(y, 3, 20, 2), {"IR", "AF", "TR"}, "new clothes for the new year"),
        _m("Independence Day", _range(y, 3, 26), {"BD"}, "red and green"),
        _m("Easter", (easter - timedelta(days=2), easter + timedelta(days=1)), ANGLO | {"DE", "FR", "IT", "ES", "PL", "PT", "BR", "MX", "PH"}, "spring colours, gifts"),
        _m("Songkran", _range(y, 4, 13, 3), {"TH"}, "light clothes that can get wet"),
        _m("Pohela Boishakh (Bengali New Year)", _range(y, 4, 14), {"BD", "IN"}, "red-and-white outfits, festive accessories"),
        _m("Mother's Day", _day(_nth_weekday(y, 5, 6, 2)), {"US", "CA", "AU", "NZ", "IN", "BD", "BR", "JP", "IT", "DE"}, "gifts for mum"),
        _m("Father's Day", _day(_nth_weekday(y, 6, 6, 3)), {"US", "CA", "GB", "IE", "IN", "BD", "PK", "JP", "MX", "ZA"}, "gifts for dad"),
        _m("Independence Day", _range(y, 7, 4), {"US"}, "red, white and blue, summer cookouts"),
        _m("Independence Day", _range(y, 8, 14), {"PK"}, "green and white"),
        _m("Independence Day", _range(y, 8, 15), {"IN"}, "saffron, white and green"),
        _m("Halloween", _range(y, 10, 31), ANGLO, "costume ideas and a cosy autumn look"),
        _m("Día de Muertos", _range(y, 11, 1, 2), {"MX"}, "marigold colours"),
        _m("Singles' Day (11.11)", _range(y, 11, 11), GLOBAL, "the world's biggest online sale day"),
        _m("Thanksgiving", _day(thanksgiving), {"US"}, "a smart-casual dinner look"),
        _m("Black Friday", _day(thanksgiving + timedelta(days=1)), GLOBAL, "deals season"),
        _m("Cyber Monday", _day(thanksgiving + timedelta(days=4)), GLOBAL, "online deals"),
        _m("Victory Day", _range(y, 12, 16), {"BD"}, "red and green"),
        _m("Christmas", _range(y, 12, 24, 3), GLOBAL, "gifts, party outfits and cosy knits"),
        _m("Boxing Day sales", _range(y, 12, 26), {"GB", "IE", "AU", "NZ", "CA"}, "sales"),
        _m("New Year's Eve", _range(y, 12, 31), GLOBAL, "a party outfit"),
    ]


def valid_tag(tag) -> str | None:
    """The language tag if it is one, else None (never repeat what a client sent as it is)."""
    return tag if isinstance(tag, str) and TAG.match(tag) else None


def valid_zone(time_zone) -> str | None:
    """The time zone if the server knows it, else None."""
    if not isinstance(time_zone, str) or not time_zone or len(time_zone) > 64:
        return None
    try:
        ZoneInfo(time_zone)
    except (ZoneInfoNotFoundError, ValueError):
        return None
    return time_zone


def region_of(locale: str | None, time_zone: str | None) -> str | None:
    """Best guess at the shopper's country: where their clock is, else the language tag's region.

    The time zone wins because most phones in Bangladesh report `en-US` or `en-GB`: trusting the locale
    would give a shopper in Dhaka an American autumn and Thanksgiving instead of the monsoon and Eid.
    """
    by_clock = TZ_COUNTRY.get(time_zone or "")
    if by_clock:
        return by_clock
    if locale:
        parts = locale.replace("_", "-").split("-")
        for part in parts[1:]:
            if len(part) == 2 and part.isalpha():
                return part.upper()
    return None


def local_now(time_zone: str | None, now: datetime | None = None) -> datetime:
    try:
        tz = ZoneInfo(time_zone) if time_zone else ZoneInfo("UTC")
    except (ZoneInfoNotFoundError, ValueError):
        tz = ZoneInfo("UTC")
    return (now or datetime.now(tz)).astimezone(tz)


def season(country: str | None, today: date) -> str:
    m = today.month
    if country in SOUTH_ASIA:
        if m in (6, 7, 8, 9):
            return "monsoon season: hot and rainy"
        if m in (12, 1, 2):
            return "the cool, dry season"
        return "hot season" if m in (3, 4, 5) else "post-monsoon, warm with cooler evenings ahead"
    if country in TROPICAL:
        return "warm all year"
    north = ["winter", "winter", "spring", "spring", "spring", "summer", "summer", "summer", "autumn", "autumn", "autumn", "winter"]
    s = north[m - 1]
    if country in SOUTH:
        s = {"winter": "summer", "summer": "winter", "spring": "autumn", "autumn": "spring"}[s]
    return s


def moments(country: str | None, today: date, days: int = 45) -> list[dict]:
    """Moments that are on now or start within `days`, for this country plus the global ones."""
    out = []
    horizon = today + timedelta(days=days)
    for m in [*DATED, *_yearly(today.year), *_yearly(today.year + 1)]:
        if m["end"] < today or m["start"] > horizon:
            continue
        local = m["where"] is not GLOBAL and country in m["where"]
        if m["where"] is not GLOBAL and not local:
            continue
        out.append({**m, "local": local, "days_away": max(0, (m["start"] - today).days)})
    # Local moments first, then by date; drop duplicates (e.g. the same Christmas from two years).
    seen, unique = set(), []
    for m in sorted(out, key=lambda m: (not m["local"], m["start"])):
        key = (m["name"], m["start"])
        if key not in seen:
            seen.add(key)
            unique.append(m)
    return unique


def _when(m: dict, today: date) -> str:
    if m["start"] <= today <= m["end"]:
        return "happening now"
    span = m["start"].strftime("%-d %b") + (f"–{m['end'].strftime('%-d %b')}" if m["end"] != m["start"] else "")
    return f"{span}, in {m['days_away']} day{'s' if m['days_away'] != 1 else ''}"


def describe(ctx: dict, now: datetime | None = None, *, hourly: bool = False, angles: bool = True) -> str:
    """A short, prompt-ready note on the shopper's device, local time, season and upcoming moments.

    `hourly` rounds the local time down to the hour (in the shopper's own zone, so half-hour zones and the
    date just after midnight stay right), which keeps the note the same for the whole hour. `angles` adds
    what each moment is good for; names and dates alone are enough once a conversation is under way."""
    locale, tz = valid_tag(ctx.get("locale")), valid_zone(ctx.get("timeZone"))
    country = region_of(locale, tz)
    t = local_now(tz, now)
    if hourly:
        t = t.replace(minute=0, second=0, microsecond=0)
    lines = [
        f"Device: {locale or 'unknown'}, {tz or 'unknown'}"
        + (f"; likely {COUNTRY.get(country, country)} (a guess, don't state it)" if country else ""),
        f"Local time: {t.strftime('%A %-d %B %Y, %H:%M')}; season: {season(country, t.date())}",
    ]
    ms = moments(country, t.date())
    if ms:
        lines.append("Coming up: " + "; ".join(
            f"{m['name']} ({_when(m, t.date())}" + (f": {m['angle']}" if angles else "") + ")" for m in ms
        ))
    return "\n".join(lines)
