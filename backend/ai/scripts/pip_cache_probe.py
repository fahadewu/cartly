"""Paid check that Pip's prompt cache works: one representative Pip request, built by Pip's own code (a Bangla
follow-up after one earlier exchange, typed, from a shopper Pip knows nothing about), sent twice byte for byte,
with what each one read from and wrote to the cache.

    .venv/bin/python -m scripts.pip_cache_probe          # prints what it would send and cost; calls nothing
    .venv/bin/python -m scripts.pip_cache_probe --yes    # sends it twice (about $0.10)

The first request writes Pip's prompt to the cache (the persona and catalog for an hour, the conversation for
5 minutes), unless a request in the last hour already did; the second should read all of it. Exits 1 when the
second request read nothing from the cache (then every Pip turn pays the full input price), 2 when it couldn't
run. --config takes model[:effort[:thinking]] like pip_model_eval (default: AGENT_MODEL, AGENT_EFFORT and
AGENT_THINKING).
"""
import argparse
import asyncio
import json
import time
from dataclasses import replace
from types import SimpleNamespace

import anthropic

from app import db, llm, redis_client, usage
from app.brain.claude import ClaudeProvider
from app.catalog import catalog
from app.config import settings

from .pip_model_eval import Config, Watch, call_record, configure, current, estimate, isolated, parse_config

MESSAGE = "দ্বিতীয়টা কি সুতির? গরমে পরা যাবে?"
CTX = {"locale": "bn-BD", "timeZone": "Asia/Dhaka", "origin": "typed"}
SHOWN = [17, 18]
HISTORY = [
    {"role": "user", "content": "পূজার জন্য একটা লাল জামা দেখাও"},
    {"role": "assistant", "content": json.dumps(
        {"text": "পূজার জন্য দুটো দারুণ লাল জামা! ✨ কোনটা বেশি ভালো লাগছে?", "products": SHOWN, "actions": []}, ensure_ascii=False
    )},
]
# What the stand-in client answers while Pip's code builds the request (nothing is sent then).
REPLY = {"text": "হ্যাঁ, এটা সুতির।", "speech": "", "lang": "bn-BD", "products": [], "actions": [], "chips": ["আরও দেখাও", "দাম কত?"], "mood": "happy"}


class Recorder:
    """Stands in for the Anthropic client while Pip's code builds a turn: keeps the request, sends nothing."""

    def __init__(self):
        self.request: tuple[str, dict] | None = None
        self.messages = self._surface("messages")
        self.beta = SimpleNamespace(messages=self._surface("beta"))

    def _surface(self, name: str):
        async def create(**kwargs):
            self.request = (name, kwargs)
            text = json.dumps(REPLY, ensure_ascii=False)
            return SimpleNamespace(content=[SimpleNamespace(type="text", text=text)], stop_reason="end_turn", model=kwargs.get("model"), usage=None)

        return SimpleNamespace(create=create)


async def build(cfg: Config) -> tuple[str, dict]:
    """The request Pip's own code sends for this turn, and the client surface it goes through (beta or not)."""
    rec, watch = Recorder(), Watch()
    with isolated(watch):  # as in the eval: the turn reaches Claude, and no cache keeps the stand-in reply
        configure(cfg)
        llm.set_client(rec)
        try:
            memory = {"history": [dict(m) for m in HISTORY], "results": list(SHOWN)}
            await ClaudeProvider(catalog).respond(MESSAGE, memory, dict(CTX))
        finally:
            llm.set_client(None)
    if rec.request is None:
        raise RuntimeError("Pip's code sent no request: " + ("; ".join(watch.warnings) or "no reason logged"))
    return rec.request


def describe(request: dict) -> list[str]:
    """The request's shape: the model and its settings, the prompt's size, where the cache breakpoints sit."""
    def ttl(block):
        mark = block.get("cache_control") if isinstance(block, dict) else None
        return mark and mark.get("ttl", "5m")

    system = request.get("system") or []
    system = [{"type": "text", "text": system}] if isinstance(system, str) else system
    messages = request.get("messages") or []
    marks = [f"system block {i} ({ttl(b)})" for i, b in enumerate(system, 1) if ttl(b)]
    marks += [f"message {i} ({ttl(b)})" for i, m in enumerate(messages, 1) if isinstance(m.get("content"), list) for b in m["content"] if ttl(b)]
    if ttl(request):
        marks.append(f"automatic ({ttl(request)})")
    out = request.get("output_config") or {}
    return [
        f"{request.get('model')}: effort {out.get('effort') or 'none'}, thinking {(request.get('thinking') or {}).get('type') or 'default'}, "
        f"refusal fallback {'on' if request.get('fallbacks') else 'off'}, reply {'JSON schema' if out.get('format') else 'free text'}",
        f"system: {len(system)} blocks, {sum(len(b.get('text') or '') for b in system):,} characters; {len(messages)} messages",
        "cache breakpoints: " + (", ".join(marks) or "none"),
    ]


async def probe(cfg: Config, client=None) -> int:
    """Builds the request, sends it twice and compares the two: 0 when the second read the cache, 1 when not."""
    try:
        surface, request = await build(cfg)
    except RuntimeError as e:
        print(e)
        return 2
    for line in describe(request):
        print(f"  {line}")
    c = client or llm.client()
    create = c.beta.messages.create if surface == "beta" else c.messages.create
    model = request.get("model", "")
    print(f"  {'':5}{'input':>8}{'cache read':>12}{'write 5m':>10}{'write 1h':>10}{'output':>8}{'thinking':>10}  {'stop':10}{'cost':>8}{'time':>7}")
    second = None
    for name in ("1st", "2nd"):
        started = time.monotonic()
        try:
            msg = await create(**request)
        except anthropic.APIError as e:
            print(f"The {name} request failed: {e}")
            return 2
        seconds = time.monotonic() - started
        second = r = call_record(model, msg, await usage.claude("probe", model, msg))
        print(f"  {name:5}{r['input']:>8,}{r['cache_read']:>12,}{r['write_5m']:>10,}{r['write_1h']:>10,}{r['output']:>8,}"
              f"{r['thinking']:>10,}  {r['stop']:10}{'$' + format(r['cost'], '.4f'):>8}{seconds:>6.1f}s")
    if not second["cache_read"]:
        print("The second request read nothing from the cache: something in the prompt changes between requests, or it "
              "is below the model's minimum length for caching. Every Pip turn then pays the full input price.")
        return 1
    print(f"The second request read {second['cache_read']:,} tokens from the cache.")
    return 0


async def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--yes", action="store_true", help="call Claude (costs money)")
    ap.add_argument("--config", help="model[:effort[:thinking]] (default: what Pip runs with now)")
    args = ap.parse_args(argv)
    try:
        cfg = replace(parse_config(args.config or current()), keywords=settings.pip_prompt_keywords)  # the prompt Pip sends now
    except ValueError as e:
        print(e)
        return 2
    print(f"Pip cache probe on {cfg.label}: one Pip request (a Bangla follow-up after one exchange, built by Pip's own "
          f"code) sent twice, byte for byte, about ${estimate(cfg.model, 2):.2f}.")
    if not args.yes:
        print("Nothing called. Add --yes to run it.")
        return 0
    if not llm.configured(cfg.model):
        print("Set ANTHROPIC_API_KEY (META_API_KEY for muse- models) in backend/.env first.")
        return 2

    await db.open_pool()
    await catalog.load()
    try:
        return await probe(cfg)
    finally:
        await db.close_pool()
        await redis_client.close_redis()


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
