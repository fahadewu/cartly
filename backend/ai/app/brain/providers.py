"""Agent "brain" providers.

Everything above this layer (HTTP, WebSocket, Redis session memory, cart/order
context) only talks to `AgentProvider`. Two ship: `ClaudeProvider` (any language;
needs ANTHROPIC_API_KEY) and `RuleBasedProvider` (English rules, no keys).

Contract for `respond`:
  * `message`  what the shopper said/typed
  * `memory`   JSON-safe dict, persisted per session in Redis; mutate it freely
               (keys used by the rule brain: results, filters, focus, pending,
               offset, lastAdjust; Claude's: history)
  * `ctx`      {userName, cart:[{id,name,qty,price,size,color}], cartTotal,
                orders:[{id,status,total,items,delivery}], tryOn:{hasPhoto,mode,on:[{id,name}]},
                profile, suggested, locale, timeZone, lang, langMode, spoken, voiceOut,
                origin, events:[{type,id,size?,color?}],
                userId, sessionId, client (who the shopper is, for Pip's limits)}
  * returns    {text, speech?, lang?, products?: [ids], actions?: [...], chips?: [...], mood?,
                askSize?: id, askColor?: colour, offTopic?: true, done?: true (a goodbye)}
               with actions from: navigate, add, like, openCart, reorder, tryon, restyle,
               untry, clearLook, buyLook, fittingRoom, sampleModel, adjust.
"""
from typing import Protocol

from .. import llm
from ..catalog import Catalog
from ..config import settings
from .brain import RuleBrain
from .claude import ClaudeProvider


class AgentProvider(Protocol):
    name: str

    async def respond(self, message: str, memory: dict, ctx: dict) -> dict: ...

    async def greet(self, memory: dict, ctx: dict) -> dict: ...

    def preview(self, text: str) -> list[int]: ...


class RuleBasedProvider:
    """The dummy brain: deterministic rules over the in-memory catalog. No API keys."""

    name = "rules"

    def __init__(self, catalog: Catalog):
        self.brain = RuleBrain(catalog)

    async def respond(self, message: str, memory: dict, ctx: dict) -> dict:
        return self.brain.respond(message, memory, ctx)

    async def greet(self, memory: dict, ctx: dict) -> dict:
        return self.brain.greeting(ctx.get("userName"))

    def preview(self, text: str) -> list[int]:
        return self.brain.preview(text)


def check_thinking() -> None:
    """AGENT_THINKING must be one Claude accepts: every turn would fail over to the rule brain otherwise."""
    thinking = settings.agent_thinking
    if thinking not in ("", "adaptive", "between_tools"):
        raise ValueError(f"Unknown AGENT_THINKING {thinking!r} (available: adaptive, between_tools, or empty)")
    if thinking == "between_tools" and settings.agent_model.startswith("claude-sonnet-5-5") and settings.agent_effort in ("xhigh", "max"):
        raise ValueError("AGENT_THINKING=between_tools needs AGENT_EFFORT high or lower")


def get_provider(name: str, catalog: Catalog) -> AgentProvider:
    """`auto` (default): Claude when ANTHROPIC_API_KEY is set, otherwise the rule brain."""
    if name == "auto":
        name = "claude" if llm.configured() else "rules"
    if name in ("rules", "rule", "dummy", ""):
        return RuleBasedProvider(catalog)
    if name in ("claude", "llm"):
        if not llm.configured():
            raise ValueError("AGENT_PROVIDER=claude needs ANTHROPIC_API_KEY")
        check_thinking()
        return ClaudeProvider(catalog)
    raise ValueError(f"Unknown AGENT_PROVIDER {name!r} (available: auto, claude, rules)")
