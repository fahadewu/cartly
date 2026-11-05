"""In-memory stand-ins for Redis, the Claude client and Pip's relevance gate and templates, so the LLM
and try-on paths can be tested offline, with no keys and no cost."""
import json
from dataclasses import dataclass
from types import SimpleNamespace

from app.config import settings


class FakeRedis:
    def __init__(self):
        self.data: dict[str, str] = {}
        self.hashes: dict[str, dict[str, str]] = {}
        self.ttls: dict[str, int] = {}

    async def get(self, key):
        return self.data.get(key)

    async def set(self, key, value, ex=None, nx=False):
        if nx and key in self.data:
            return None
        self.data[key] = value
        if ex is not None:
            self.ttls[key] = ex
        return True

    async def delete(self, *keys):
        return sum(self.data.pop(k, None) is not None for k in keys)

    async def mget(self, keys, *more):
        return [self.data.get(k) for k in [*keys, *more]]

    async def incrby(self, key, n):
        self.data[key] = str(int(self.data.get(key) or 0) + n)
        return int(self.data[key])

    async def incr(self, key):
        return await self.incrby(key, 1)

    async def expire(self, key, seconds):
        self.ttls[key] = seconds
        return True

    async def hincrbyfloat(self, key, field, n):
        h = self.hashes.setdefault(key, {})
        h[field] = str(float(h.get(field) or 0) + n)
        return float(h[field])

    async def hget(self, key, field):
        return self.hashes.get(key, {}).get(field)

    async def hgetall(self, key):
        return dict(self.hashes.get(key, {}))

    def pipeline(self):
        redis = self

        class Pipe:
            def __init__(self):
                self.ops = []

            def __getattr__(self, op):
                return lambda *args: self.ops.append((op, args))

            async def execute(self):
                return [await getattr(redis, op)(*args) for op, args in self.ops]

        return Pipe()


def text_message(payload, stop_reason="end_turn", model=None, usage=None):
    text = payload if isinstance(payload, str) else json.dumps(payload)
    msg = SimpleNamespace(content=[SimpleNamespace(type="text", text=text)], stop_reason=stop_reason)
    if model is not None:
        msg.model = model
    if usage is not None:
        msg.usage = usage
    return msg


def tool_message(name, args, tool_id="toolu_1"):
    return SimpleNamespace(
        content=[SimpleNamespace(type="tool_use", id=tool_id, name=name, input=args)], stop_reason="tool_use"
    )


class FakeAnthropic:
    """Returns queued responses in order and records every request (and which endpoint took it: the beta
    one with the refusal fallback, or the plain one). A queued exception is raised; a queued async
    function is awaited with the request, e.g. to answer slowly."""

    def __init__(self, *responses):
        self.queue = list(responses)
        self.calls: list[dict] = []
        self.endpoints: list[str] = []
        outer = self

        class Messages:
            def __init__(self, endpoint):
                self.endpoint = endpoint

            async def create(self, **kwargs):
                outer.calls.append(kwargs)
                outer.endpoints.append(self.endpoint)
                nxt = outer.queue.pop(0)
                if isinstance(nxt, Exception):
                    raise nxt
                if callable(nxt):
                    return await nxt(kwargs)
                return nxt

        self.beta = SimpleNamespace(messages=Messages("beta"))
        self.messages = Messages("messages")


class Settings:
    """Temporarily override the (frozen) settings."""

    def __init__(self):
        self.saved = {}

    def __call__(self, **kw):
        for k, v in kw.items():
            self.saved.setdefault(k, getattr(settings, k))
            object.__setattr__(settings, k, v)

    def restore(self):
        for k, v in self.saved.items():
            object.__setattr__(settings, k, v)


@dataclass(frozen=True)
class Verdict:
    """Shaped like app.brain.gate.Verdict."""

    action: str = "pass"
    kind: str = "unsure"
    lang: str | None = None
    rule: str = ""
    signal: bool = False


class FakeGate:
    """The relevance gate's interface: `verdict` is a Verdict, or a function of the message."""

    def __init__(self, verdict=Verdict()):
        self.verdict = verdict
        self.calls: list[str] = []

    def check(self, message, memory, ctx):
        self.calls.append(message)
        return self.verdict(message) if callable(self.verdict) else self.verdict


class FakeTemplates:
    """The templates module's interface; replies say which template and language were asked for."""

    LANGS = ("en", "bn", "bn-Latn", "hi", "hi-Latn", "ur", "ar", "es")
    TAGS = {"en": "en", "bn": "bn-BD", "bn-Latn": "bn-BD", "hi": "hi-IN", "hi-Latn": "hi-IN", "ur": "ur-PK", "ar": "ar", "es": "es"}

    def __init__(self):
        self.calls: list[tuple[str, str | None]] = []

    def reply(self, kind, lang, name=None):
        self.calls.append((kind, lang))
        text = f"[{kind}:{lang or 'en'}]"
        return {
            "text": text, "speech": text, "lang": self.TAGS.get(lang or "en"), "products": [], "actions": [],
            "chips": ["Show me new arrivals", "Gift ideas"], "mood": "happy" if kind == "closer" else "love",
        }

    def language_of(self, lang):
        if lang in self.LANGS:
            return lang
        base = str(lang or "").split("-")[0].lower()
        return base if base in self.LANGS else None
