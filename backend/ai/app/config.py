"""Settings, read from backend/.env (shared with the NestJS API)."""
import os
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv

AI_DIR = Path(__file__).resolve().parent.parent
load_dotenv(AI_DIR.parent / ".env")


def _bool(v: str) -> bool:
    return v.strip().lower() in ("1", "true", "yes", "on")


def _list(v: str) -> list[str]:
    return [x.strip() for x in v.split(",") if x.strip()]


@dataclass(frozen=True)
class Settings:
    database_url: str = os.getenv("DATABASE_URL", "postgresql://localhost:5432/cartly")
    redis_url: str = os.getenv("REDIS_URL", "redis://localhost:6379/0")
    cache_redis_url: str = os.getenv("CACHE_REDIS_URL", "")  # evictable caches; see redis_client.py
    port: int = int(os.getenv("AI_PORT", "8001"))
    internal_api_key: str = os.getenv("INTERNAL_API_KEY", "")
    jwt_secret: str = os.getenv("JWT_SECRET", "")
    cors_origins: list[str] = field(default_factory=lambda: _list(os.getenv("CORS_ORIGIN", "http://localhost:5173")))
    livekit_url: str = os.getenv("LIVEKIT_URL", "")
    livekit_api_key: str = os.getenv("LIVEKIT_API_KEY", "")
    livekit_api_secret: str = os.getenv("LIVEKIT_API_SECRET", "")
    embeddings_provider: str = os.getenv("EMBEDDINGS_PROVIDER", "hashing")
    # "auto" uses Claude when ANTHROPIC_API_KEY is set, else the rule-based brain.
    agent_provider: str = os.getenv("AGENT_PROVIDER", "auto")
    session_ttl: int = int(os.getenv("AGENT_SESSION_TTL", str(2 * 3600)))
    search_cache_ttl: int = int(os.getenv("SEARCH_CACHE_TTL", "60"))

    # Pip's LLM brain (Claude): any language in, same language out.
    anthropic_api_key: str = os.getenv("ANTHROPIC_API_KEY", "")
    # Trying other models through OpenRouter: an AGENT_MODEL / ADMIN_AI_MODEL with a "/" in it
    # ("nvidia/nemotron-3-super-120b-a12b:free") goes there instead of to Claude.
    openrouter_api_key: str = os.getenv("OPENROUTER_API_KEY", "")
    # Meta Model API (dev.meta.ai): Muse Spark as AGENT_MODEL / ADMIN_AI_MODEL (muse-spark-1.3), Muse Image try-on
    # (TRYON_PROVIDER=meta), Muse Voice Transcribe (STT_PROVIDER=meta) and SAM 3.1 cut-outs (CUTOUT_PROVIDER=meta).
    meta_api_key: str = os.getenv("META_API_KEY", "")
    meta_base_url: str = os.getenv("META_BASE_URL", "https://api.meta.ai").rstrip("/")
    meta_image_model: str = os.getenv("META_IMAGE_MODEL", "muse-image-1.0")
    meta_stt_model: str = os.getenv("META_STT_MODEL", "muse-voice-transcribe-1.0")
    meta_sam_model: str = os.getenv("META_SAM_MODEL", "sam-3.1")
    # Which vendor does each job. The defaults are today's: fashn, elevenlabs, local (BiRefNet-lite).
    tryon_provider: str = os.getenv("TRYON_PROVIDER", "fashn")
    stt_provider: str = os.getenv("STT_PROVIDER", "elevenlabs")
    cutout_provider: str = os.getenv("CUTOUT_PROVIDER", "local")
    meta_image_usd: float = float(os.getenv("META_IMAGE_USD", "0.01"))
    meta_stt_usd_per_hour: float = float(os.getenv("META_STT_USD_PER_HOUR", "0.18"))
    meta_sam_usd_per_image: float = float(os.getenv("META_SAM_USD_PER_IMAGE", "0.0025"))
    openrouter_base_url: str = os.getenv("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1").rstrip("/")
    # Tried in order when the model is overloaded or rate-limited (free models often are).
    openrouter_fallback_models: list[str] = field(default_factory=lambda: _list(os.getenv("OPENROUTER_FALLBACK_MODELS", "")))
    agent_model: str = os.getenv("AGENT_MODEL", "claude-haiku-5-5")
    agent_effort: str = os.getenv("AGENT_EFFORT", "low")  # low keeps voice replies quick
    # "" = the model's default; "between_tools" turns thinking off on Claude Sonnet 5.5 (fewer output tokens).
    agent_thinking: str = os.getenv("AGENT_THINKING", "")
    # Photo checks and product suggestions in the admin panel; empty = AGENT_MODEL.
    admin_ai_model: str = os.getenv("ADMIN_AI_MODEL", "")
    # One Claude attempt of a chat turn (keep it under AGENT_DEADLINE, so a slow reply can still finish; a fast
    # failure's one retry fits in what's left), and the whole turn including the retry: under the API gateway's
    # 45 s, so a slow reply isn't paid for after the shopper has already been given the fallback.
    agent_timeout: float = float(os.getenv("AGENT_TIMEOUT", "35"))
    agent_deadline: float = float(os.getenv("AGENT_DEADLINE", "38"))
    # The websocket chat isn't used by the storefront and has no gateway throttle in front of it.
    agent_ws_enabled: bool = _bool(os.getenv("AGENT_WS_ENABLED", "false"))

    # Pip's spend controls (backend/SCALING.md, "AI spend").
    # Free check before Claude: obvious off-topic tasks, prompt injection, empty input and plain thank-yous are
    # answered from templates. off | shadow (count only) | enforce. Anything unsure still goes to Claude.
    pip_gate: str = os.getenv("PIP_GATE", "enforce")
    # Languages the template replies are written in; a message in any other language goes to Claude.
    pip_template_langs: list[str] = field(
        default_factory=lambda: _list(os.getenv("PIP_TEMPLATE_LANGS", "en,bn,bn-Latn,hi,hi-Latn,ur,ar,es"))
    )
    pip_closers: bool = _bool(os.getenv("PIP_CLOSERS", "true"))  # a plain "thanks" / "bye" gets a template reply
    # After this many off-topic turns within PIP_STRIKE_WINDOW seconds, messages with nothing about shopping
    # get a template for PIP_COOLDOWN seconds (0 = off).
    pip_strikes: int = int(os.getenv("PIP_STRIKES", "3"))
    pip_strike_window: int = int(os.getenv("PIP_STRIKE_WINDOW", "1800"))
    pip_cooldown: int = int(os.getenv("PIP_COOLDOWN", "600"))
    # Claude turns per day before Pip switches to its built-in answers (0 = no limit): per signed-in
    # shopper, per guest session, and per guest network (hashed IP from the gateway; shared mobile IPs, so high).
    pip_daily_turns_account: int = int(os.getenv("PIP_DAILY_TURNS_ACCOUNT", "200"))
    pip_daily_turns_session: int = int(os.getenv("PIP_DAILY_TURNS_SESSION", "80"))
    pip_daily_turns_guest_ip: int = int(os.getenv("PIP_DAILY_TURNS_GUEST_IP", "1000"))
    # With CLAUDE_DAILY_BUDGET_USD set: past this share of it, guests with an empty cart get the built-in
    # answers first, so signed-in shoppers and full carts keep Claude longest.
    pip_soft_cap_ratio: float = float(os.getenv("PIP_SOFT_CAP_RATIO", "0.8"))
    # Identical requests from shoppers Pip knows nothing about (no name, cart, orders or profile) share replies.
    pip_reply_cache: bool = _bool(os.getenv("PIP_REPLY_CACHE", "true"))
    pip_reply_cache_variants: int = int(os.getenv("PIP_REPLY_CACHE_VARIANTS", "2"))
    pip_reply_cache_ttl: int = int(os.getenv("PIP_REPLY_CACHE_TTL", "3600"))
    pip_greeting_cache: bool = _bool(os.getenv("PIP_GREETING_CACHE", "true"))  # also a signed-in shopper's own opener
    # Cache lifetime of the shared persona + catalog prompt: "1h" (pays off whenever Pip is quiet for 5+ minutes) or "5m".
    pip_system_cache_ttl: str = os.getenv("PIP_SYSTEM_CACHE_TTL", "1h")
    pip_prompt_keywords: bool = _bool(os.getenv("PIP_PROMPT_KEYWORDS", "true"))  # "also called" names in Pip's catalog

    # Daily spending caps in USD (0 = no cap), checked against the metered spend in usage.py. Past a cap
    # the feature falls back for the rest of the UTC day: Pip to the rule brain (English), AI try-on to
    # the on-device preview, voice to the browser's own.
    claude_daily_budget: float = float(os.getenv("CLAUDE_DAILY_BUDGET_USD", "0"))
    tryon_daily_budget: float = float(os.getenv("TRYON_DAILY_BUDGET_USD", "0"))
    voice_daily_budget: float = float(os.getenv("VOICE_DAILY_BUDGET_USD", "0"))
    # Vendor unit prices for those estimates (check them against your plans).
    fashn_usd_per_credit: float = float(os.getenv("FASHN_USD_PER_CREDIT", "0.075"))
    tts_usd_per_1k_chars: float = float(os.getenv("TTS_USD_PER_1K_CHARS", "0.10"))
    stt_usd_per_hour: float = float(os.getenv("STT_USD_PER_HOUR", "0.22"))
    # How often each AI replica checks whether an admin edit reloaded the catalog elsewhere.
    catalog_refresh_seconds: float = float(os.getenv("CATALOG_REFRESH_SECONDS", "15"))

    # Generative virtual try-on (FASHN Try-On Max). Without a key the storefront uses its on-device preview.
    fashn_api_key: str = os.getenv("FASHN_API_KEY", "")
    fashn_base_url: str = os.getenv("FASHN_BASE_URL", "https://api.fashn.ai/v1").rstrip("/")
    tryon_mode: str = os.getenv("TRYON_MODE", "balanced")  # fast | balanced | quality
    tryon_resolution: str = os.getenv("TRYON_RESOLUTION", "1k")  # 1k | 2k | 4k
    tryon_hourly_limit: int = int(os.getenv("TRYON_HOURLY_LIMIT", "30"))  # AI renders per shopper per hour
    tryon_cache_ttl: int = int(os.getenv("TRYON_CACHE_TTL", "3600"))
    # Looks on the sample models are the same for every shopper (and aren't anyone's photo), so they're
    # shared and kept longer: each one is paid for once.
    tryon_sample_cache_ttl: int = int(os.getenv("TRYON_SAMPLE_CACHE_TTL", str(7 * 24 * 3600)))
    # Accessory cut-outs for the on-device quick preview (BiRefNet-lite, MIT; downloaded on first use).
    cutout_model_path: str = os.getenv("CUTOUT_MODEL_PATH", str(AI_DIR / ".models" / "birefnet-lite.onnx"))
    cutout_model_url: str = os.getenv(
        "CUTOUT_MODEL_URL", "https://huggingface.co/onnx-community/BiRefNet_lite-ONNX/resolve/main/onnx/model.onnx"
    )

    # Multilingual speech (ElevenLabs): language-detecting speech-to-text and a voice that speaks it back.
    elevenlabs_api_key: str = os.getenv("ELEVENLABS_API_KEY", "")
    # Regional endpoints exist, e.g. https://api.eu.residency.elevenlabs.io for EU data residency.
    elevenlabs_base_url: str = os.getenv("ELEVENLABS_BASE_URL", "https://api.elevenlabs.io").rstrip("/")
    elevenlabs_voice_id: str = os.getenv("ELEVENLABS_VOICE_ID", "")  # empty = first voice on the account
    elevenlabs_tts_model: str = os.getenv("ELEVENLABS_TTS_MODEL", "eleven_v4")
    elevenlabs_stt_model: str = os.getenv("ELEVENLABS_STT_MODEL", "scribe_v2")
    # How Pip sounds: warm and gentle. Lower stability = more expressive; style adds the voice's own warmth;
    # speed under 1 is a touch slower and softer. Set ELEVENLABS_VOICE_ID to a sweet, friendly voice too.
    elevenlabs_stability: float = float(os.getenv("ELEVENLABS_STABILITY", "0.45"))
    elevenlabs_similarity: float = float(os.getenv("ELEVENLABS_SIMILARITY", "0.8"))
    elevenlabs_style: float = float(os.getenv("ELEVENLABS_STYLE", "0.3"))
    elevenlabs_speed: float = float(os.getenv("ELEVENLABS_SPEED", "0.96"))
    # Pip's voice for a phrase asked for more than once (greetings, "Your look is ready!") is kept and replayed.
    tts_cache_ttl: int = int(os.getenv("TTS_CACHE_TTL", str(7 * 24 * 3600)))


settings = Settings()
