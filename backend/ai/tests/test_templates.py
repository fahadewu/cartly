"""Pip's template replies (app/brain/templates.py): every kind in every language, ready to show and speak."""
import re
import unicodedata

import pytest

from app.brain import templates
from app.brain.claude import LANG

from .fakes import Settings

SCRIPT = {  # the letters each template language is written in
    "en": "[A-Za-z]", "bn-Latn": "[A-Za-z]", "hi-Latn": "[A-Za-z]", "es": "[A-Za-z]",
    "bn": "[\u0980-\u09ff]", "hi": "[\u0900-\u097f]", "ur": "[\u0600-\u06ff]", "ar": "[\u0600-\u06ff]",
}
EMOJI = re.compile("[\U0001f000-\U0001faff\u2600-\u27bf\u2300-\u23ff\u2b00-\u2bff\ufe0f]")


@pytest.mark.parametrize("lang", templates.LANGS)
@pytest.mark.parametrize("kind", templates.KINDS)
def test_every_kind_in_every_language(kind, lang):
    for _ in range(12):  # each of its phrasings
        r = templates.reply(kind, lang)
        assert r["text"].strip() and r["speech"].strip()
        assert r["lang"] == templates.TAGS[lang] and LANG.match(r["lang"])
        assert r["products"] == [] and r["actions"] == []
        if kind == "quota" and lang != "en":
            assert r["chips"] == []  # a tap would only get the same template back in quick mode
        else:
            assert 2 <= len(r["chips"]) <= 3 and all(c.strip() for c in r["chips"])
        assert r["mood"] == ("happy" if kind in ("closer", "quota", "busy") else "love")
        assert not EMOJI.search(r["speech"]) and not re.search(r"[*_`#]", r["speech"])
        assert "{" not in r["text"] and "}" not in r["text"]
        letters = re.findall(r"[^\W\d_]", r["text"].replace("Cartly", ""))
        native = [ch for ch in letters if re.match(SCRIPT[lang], ch)]
        assert len(native) >= 0.8 * len(letters), (kind, lang, r["text"])
        assert all(re.search(SCRIPT[lang], c) for c in r["chips"])


def test_two_or_three_phrasings_each():
    for kind in templates.KINDS:
        for lang in templates.LANGS:
            assert 2 <= len(templates.TEXTS[kind][lang]) <= 3, (kind, lang)
            assert len(set(templates.TEXTS[kind][lang])) == len(templates.TEXTS[kind][lang])


def test_speech_is_the_text_without_emoji():
    r = templates.reply("injection", "en")
    assert r["speech"] == EMOJI.sub("", r["text"]).replace("  ", " ").strip()
    assert templates.speech_of("Anytime! 💙 Come back whenever you like.") == "Anytime! Come back whenever you like."


def test_register_and_gender_neutral_wording():
    texts = {lang: " ".join(t for kind in templates.KINDS for t in templates.TEXTS[kind][lang]) for lang in templates.LANGS}
    assert not re.search("তুমি|তোমার|তোমাকে", texts["bn"])  # formal আপনি only
    assert not re.search(r"\b(tumi|tomar|tomake)\b", texts["bn-Latn"])
    # Pip ("I") and the shopper ("you") without gendered verb forms (सकता/सकती हूँ, आप … रहे/रही हैं, رہا/رہی ہوں…).
    assert not re.search("(?:सकता|सकती|रहा|रही|गया|गई) हूँ|आप [^।!?]*(?:सकते|सकती|रहे|रही) हैं", texts["hi"])
    assert not re.search(r"\b(?:sakta|sakti|raha|rahi|gaya|gayi) hoon\b|\baap\b[^.!?]*\b(?:sakte|sakti|rahe|rahi) hain\b", texts["hi-Latn"])
    assert not re.search("(?:سکتا|سکتی|رہا|رہی|گیا|گئی) ہوں|آپ [^۔!؟]*(?:سکتے|سکتی|رہے|رہی) ہیں", texts["ur"])
    assert not re.search(r"\b(bienvenido|bienvenida|encantado|encantada|listo|lista)\b", texts["es"])


def test_urdu_and_arabic_lines_start_right_to_left():
    """The chat bubble takes its direction from the first strong letter (dir="auto"): a line that opens
    with "Cartly" would be laid out left to right."""
    for lang in ("ur", "ar"):
        lines = [*(t for kind in templates.KINDS for t in templates.TEXTS[kind][lang]), *templates.CHIPS[lang]]
        for line in lines:
            first = next(unicodedata.bidirectional(ch) for ch in line if unicodedata.bidirectional(ch) in ("L", "R", "AL"))
            assert first in ("R", "AL"), (lang, line)


def test_closers_fit_a_goodbye_as_well_as_a_thank_you():
    """The gate sends "bye", "adiós" and "مع السلامة" to the closer too: none may say "you're welcome"."""
    thanks_only = ("Anytime", "My pleasure", "De nada", "Cuando quieras", "العفو", "في أي وقت", "যেকোনো সময়", "আমার আনন্দ", "कभी भी", "मेरी ख़ुशी", "کبھی بھی", "میری خوشی")
    for lang in templates.LANGS:
        for text in templates.TEXTS["closer"][lang]:
            assert not text.lstrip("¡").startswith(thanks_only), text


def test_quick_mode_says_the_chat_is_paused_not_a_short_break():
    """Quick mode lasts until the day's quota or budget resets: no "a little break" promise."""
    quota = " ".join(t for lang in templates.LANGS for t in templates.TEXTS["quota"][lang])
    for promise in ("little break", "breather", "বিশ্রামের সময়", "استراحة قصيرة", "pequeño descanso", "छोटा-सा ब्रेक"):
        assert promise not in quota, promise


def test_unknown_or_missing_language_is_english():
    for lang in (None, "", "fr", "zh-Hant-TW", "ar-Latn", 42):
        r = templates.reply("offtopic", lang)
        assert r["lang"] == "en" and r["text"] in templates.TEXTS["offtopic"]["en"]


@pytest.mark.parametrize("tag, key", [
    ("bn-BD", "bn"), ("bn-IN", "bn"), ("bn", "bn"), ("bn-Latn", "bn-Latn"), ("bn-latn-BD", "bn-Latn"), ("hi-IN", "hi"),
    ("hi-Latn", "hi-Latn"), ("ur-PK", "ur"), ("ur-Latn", "hi-Latn"), ("ar", "ar"), ("ar-SA", "ar"), ("ar-Latn", None),
    ("es", "es"), ("es-419", "es"), ("es-MX", "es"), ("en-GB", "en"), ("en", "en"), ("fr", None), ("ta-IN", None),
    (None, None), ("", None), ("<b>", None),
])
def test_language_of_maps_tags_to_template_languages(tag, key):
    assert templates.language_of(tag) == key


def test_language_of_respects_the_switched_on_languages():
    s = Settings()
    s(pip_template_langs=["en", "bn"])
    try:
        assert templates.language_of("bn-BD") == "bn" and templates.language_of("ur-PK") is None
        assert templates.reply("busy", "ur")["lang"] == "en"  # not reviewed for use: English
    finally:
        s.restore()


def test_the_shoppers_name_in_a_closer_only_and_safely():
    r = templates.reply("closer", "en", "Fahad")
    assert "Fahad" in r["text"] and "Fahad" in r["speech"] and "{name}" not in r["text"]
    assert ", Fahad!" in r["text"]
    assert "Fahad" not in templates.reply("offtopic", "en", "Fahad")["text"]
    ur = templates.reply("closer", "ur", "فہد")["text"]
    assert "، فہد" in ur
    sneaky = templates.reply("closer", "en", "**Bob** <script>[x](y) 😈 Smith")["text"]
    assert "<" not in sneaky and "*" not in sneaky and "[" not in sneaky and "😈" not in sneaky and "Smith" not in sneaky
    assert templates.reply("closer", "en", "   ")["text"] in [t.replace("{name}", "") for t in templates.TEXTS["closer"]["en"]]


def test_templates_are_recognised_in_the_history():
    for kind in ("offtopic", "injection", "junk", "cooldown", "refusal"):
        assert templates.is_template(templates.reply(kind, "bn")["text"])
    assert not templates.is_template("Here are three red dresses for Eid ✨ Want to see shoes?")
    assert not templates.is_template(None) and not templates.is_template("")


def test_unknown_kind_is_an_error():
    with pytest.raises(ValueError):
        templates.reply("decline", "en")


def test_replies_are_fresh_copies():
    a = templates.reply("closer", "en")
    a["chips"].append("x")
    assert "x" not in templates.reply("closer", "en")["chips"]
