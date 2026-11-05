"""Shared Claude client (optional; needs ANTHROPIC_API_KEY), and the request shape each model takes.
A model id with a "/" in it (an OpenRouter id) goes to OpenRouter instead (needs OPENROUTER_API_KEY), and
comes back shaped like a Claude message, so the callers don't change.
A "muse-" model (Meta's Muse Spark, e.g. muse-spark-1.3) goes to Meta Model API's Anthropic-compatible Messages
endpoint (needs META_API_KEY): same request and reply, minus what Meta doesn't take (dev.meta.ai/docs/protocols/messages)."""
import json
import re
from types import SimpleNamespace

import anthropic
import httpx

from . import usage
from .config import settings

# Server-side fallback: if a request is declined, the API retries it on the model
# Anthropic recommends for that case instead of returning the refusal.
FALLBACK_BETA = "server-side-fallback-2026-07-01"

_client: anthropic.AsyncAnthropic | None = None


def is_openrouter(model: str) -> bool:
    return "/" in model


def is_meta(model: str) -> bool:
    return model.startswith("muse-")


def configured(model: str | None = None) -> bool:
    """A key for the model (default AGENT_MODEL): OpenRouter's for an OpenRouter id, Meta's for a muse- model,
    Anthropic's otherwise."""
    model = model or settings.agent_model
    if is_openrouter(model):
        return bool(settings.openrouter_api_key)
    if is_meta(model):
        return bool(settings.meta_api_key)
    return bool(settings.anthropic_api_key)


_meta_client: anthropic.AsyncAnthropic | None = None


def meta_client() -> anthropic.AsyncAnthropic:
    """Meta Model API through the Anthropic SDK: it accepts x-api-key and anthropic-version as Anthropic does."""
    global _meta_client
    if _meta_client is None:
        _meta_client = anthropic.AsyncAnthropic(api_key=settings.meta_api_key, base_url=settings.meta_base_url, timeout=40.0, max_retries=1)
    return _meta_client


def set_meta_client(c) -> None:
    """Tests swap in a fake client."""
    global _meta_client
    _meta_client = c


def _meta_blocks(content):
    """Meta caches prefixes by itself and takes cache_control only with its 5-minute TTL: longer TTLs are dropped."""
    if isinstance(content, list):
        out = []
        for b in content:
            if isinstance(b, dict) and isinstance(b.get("cache_control"), dict):
                b = {**b, "cache_control": {"type": "ephemeral"}}
            out.append(b)
        return out
    return content


def client() -> anthropic.AsyncAnthropic:
    global _client
    if _client is None:
        # One retry. 40 s an attempt suits the admin photo check and product suggestion (the gateway waits 45
        # and 60 s); a chat turn sets its own (AGENT_TIMEOUT) and has AGENT_DEADLINE for the whole turn.
        _client = anthropic.AsyncAnthropic(api_key=settings.anthropic_api_key, timeout=40.0, max_retries=1)
    return _client


def set_client(c) -> None:
    """Tests swap in a fake client."""
    global _client
    _client = c


def request_options(model: str, effort: str | None = None, schema: dict | None = None, thinking: str = "") -> dict:
    """What a request carries besides the prompt, by model family:
    - Claude Opus 5.5 / Opus 5 (and any model not named below): effort and the JSON format, with the
      server-side refusal fallback; no `thinking` (Opus 5.5 can't switch it off, effort steers it);
    - Claude Sonnet 5.5: the same, plus `thinking` when one is set (AGENT_THINKING: between_tools or adaptive);
    - Claude Haiku 5.5: effort and the format, without the refusal fallback (it has none server-side);
    - Claude Haiku 4.5: the format only (it takes no effort and no refusal fallback)."""
    fmt = {"format": {"type": "json_schema", "schema": schema}} if schema else {}
    config = {**({"effort": effort} if effort else {}), **fmt}
    if is_meta(model):
        # Muse Spark: effort (low … xhigh) and the JSON format in output_config; no refusal fallback, no thinking switch.
        return {"output_config": config} if config else {}
    if model.startswith("claude-haiku-5-5"):
        return {"output_config": config} if config else {}
    if "haiku" in model:
        return {"output_config": fmt} if fmt else {}
    options: dict = {"betas": [FALLBACK_BETA], "fallbacks": "default", **({"output_config": config} if config else {})}
    if thinking and model.startswith("claude-sonnet-5-5"):
        options["thinking"] = {"type": thinking}
    return options


async def create(
    feature: str = "chat", origin: str | None = None, *, model: str, effort: str | None = None,
    schema: dict | None = None, thinking: str = "", timeout: float | None = None, **kwargs,
):
    """messages.create shaped for `model` (request_options); the usage is metered under `feature` and `origin`.
    `timeout`: seconds for each attempt of this request, instead of the client's 40."""
    if is_openrouter(model):
        message = await _openrouter(model, effort, schema, timeout, **kwargs)
        await usage.claude(feature, model, message, origin=origin)
        return message
    options = request_options(model, effort, schema, thinking)
    if timeout is not None:
        options["timeout"] = timeout
    if is_meta(model):
        if "system" in kwargs:
            kwargs["system"] = _meta_blocks(kwargs["system"])
        if "messages" in kwargs:
            kwargs["messages"] = [{**m, "content": _meta_blocks(m.get("content"))} for m in kwargs["messages"]]
        message = await meta_client().messages.create(model=model, **options, **kwargs)
        await usage.claude(feature, model, message, origin=origin)
        return message
    api = client().beta.messages if "betas" in options else client().messages
    message = await api.create(model=model, **options, **kwargs)
    await usage.claude(feature, model, message, origin=origin)
    return message


def text_of(message) -> str:
    return next((b.text for b in message.content if b.type == "text"), "")


def _text(content) -> str:
    """A Claude system or message content (a string or blocks) as plain text; cache_control has no meaning here."""
    if isinstance(content, str):
        return content
    return "\n\n".join(b["text"] for b in content if b.get("type") == "text")


def _openai_content(content):
    """Claude content blocks as OpenAI-style parts (text, and base64 images as data URLs)."""
    if isinstance(content, str):
        return content
    parts = []
    for b in content:
        if b.get("type") == "text":
            parts.append({"type": "text", "text": b["text"]})
        elif b.get("type") == "image" and b.get("source", {}).get("type") == "base64":
            src = b["source"]
            parts.append({"type": "image_url", "image_url": {"url": f"data:{src['media_type']};base64,{src['data']}"}})
    return parts


async def _openrouter(model: str, effort: str | None, schema: dict | None, timeout: float | None, *,
                      max_tokens: int, messages: list, system=None, **_ignored):
    """One OpenRouter chat completion, returned as a Claude-shaped message (content, stop_reason, usage, model)."""
    system_text = _text(system or "")
    if schema:  # also in the prompt: not every model on OpenRouter honours response_format
        system_text += "\n\nReply with only one JSON object matching this JSON schema, no other text:\n" + json.dumps(schema)
    body = {
        "model": model,
        "max_tokens": max_tokens,
        "messages": [
            *([{"role": "system", "content": system_text.strip()}] if system_text.strip() else []),
            *({"role": m["role"], "content": _openai_content(m["content"])} for m in messages),
        ],
        # Reasoning tokens count against max_tokens and add seconds: off at low effort (Pip's AGENT_EFFORT),
        # where even "low" reasoning took 300-600 tokens on Nemotron; otherwise at that effort, not returned.
        "reasoning": {"enabled": False} if effort in (None, "low") else {"effort": effort, "exclude": True},
    }
    fallbacks = [m for m in settings.openrouter_fallback_models if m != model]
    if fallbacks:
        body["models"] = [model, *fallbacks]
    if schema:
        body["response_format"] = {"type": "json_schema", "json_schema": {"name": "reply", "strict": True, "schema": schema}}
    async with httpx.AsyncClient(timeout=timeout or 40.0) as http:
        r = await http.post(
            f"{settings.openrouter_base_url}/chat/completions", json=body,
            headers={"Authorization": f"Bearer {settings.openrouter_api_key}", "X-Title": "Cartly"},
        )
    data = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
    if r.status_code != 200 or "choices" not in data:
        raise RuntimeError(f"OpenRouter {r.status_code}: {(data.get('error') or {}).get('message') or r.text[:200]}")
    choice = data["choices"][0]
    text = (choice.get("message") or {}).get("content") or ""
    if schema:  # a model that ignored response_format may still wrap the JSON in a code fence
        text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text.strip())
    finish = choice.get("finish_reason")
    u = data.get("usage") or {}
    return SimpleNamespace(
        model=model,  # the id asked for, so caches and the meter see the configured model
        stop_reason={"stop": "end_turn", "length": "max_tokens"}.get(finish, finish or "end_turn"),
        content=[SimpleNamespace(type="text", text=text)],
        usage=SimpleNamespace(input_tokens=u.get("prompt_tokens", 0), output_tokens=u.get("completion_tokens", 0)),
    )
