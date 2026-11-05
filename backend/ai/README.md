# Cartly AI & voice service

FastAPI service for Pip, the shopping agent: a Claude brain that speaks the
shopper's language (with the rule brain, a Python port of `src/agent/brain.js`,
as the keyless fallback), hybrid semantic search (pgvector + filters + keywords),
Redis session memory, live suggestions while the shopper speaks, generative virtual
try-on, product-photo checks, multilingual speech, and LiveKit tokens.

## Run

```bash
cd ai                           # from the backend repo root
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
./run.sh                        # uvicorn --reload on AI_PORT (8001)
.venv/bin/python -m pytest -q   # uses the local Postgres + Redis from backend/.env
```

Config is read from `backend/.env`: `DATABASE_URL`, `REDIS_URL`, `AI_PORT`,
`INTERNAL_API_KEY`, `CORS_ORIGIN` (comma-separated), `LIVEKIT_URL/API_KEY/API_SECRET`.
Optional: `EMBEDDINGS_PROVIDER` (`hashing` default | `sentence-transformers`),
`AGENT_PROVIDER` (`auto` default: Claude with a key, else `rules`), `AGENT_SESSION_TTL` (7200), `SEARCH_CACHE_TTL` (60).

AI providers (each optional):

| Key | Enables | Tuning |
|---|---|---|
| `ANTHROPIC_API_KEY` | Pip on Claude, AI photo review | `AGENT_MODEL` (`claude-haiku-5-5`), `AGENT_EFFORT` (`low`, keeps voice replies quick) |
| `FASHN_API_KEY` | AI try-on (Try-On Max) | `TRYON_MODE` (`fast` / `balanced` / `quality`), `TRYON_RESOLUTION` (`1k` / `2k` / `4k`), `TRYON_HOURLY_LIMIT` (30), `TRYON_CACHE_TTL` (3600), `FASHN_BASE_URL` |
| `ELEVENLABS_API_KEY` | Speech-to-text with language detection, multilingual voice | `ELEVENLABS_VOICE_ID` (default: first voice on the account), `ELEVENLABS_TTS_MODEL` (`eleven_v4`), `ELEVENLABS_STT_MODEL` (`scribe_v2`), `ELEVENLABS_BASE_URL` (regional endpoints) |
| `META_API_KEY` | Meta Model API, per job: Muse Spark (`AGENT_MODEL=muse-spark-1.3`, through its Anthropic-compatible Messages endpoint), `TRYON_PROVIDER=meta` (Muse Image edits), `STT_PROVIDER=meta` (Muse Voice Transcribe; WAV only, the storefront converts), `CUTOUT_PROVIDER=meta` (SAM 3.1; needs `pip install meta-sam-parser`, SAM License) | `META_BASE_URL`, `META_IMAGE_MODEL`, `META_STT_MODEL`, `META_SAM_MODEL`; prices in `META_*_USD*`. All in `app/meta.py` and `app/llm.py`; written from Meta's API reference and **not yet run against the live API**. Muse Spark is about 10× Haiku 5.5 per reply and Bangla isn't documented: run `pip_model_eval --configs muse-spark-1.3` first. Meta's preview was US-only in 2026; check your country is enabled. |

On startup the service creates schema `ai` + `ai.product_embeddings` (vector(384),
HNSW cosine index) and embeds the catalog if the index is empty, incomplete, or
was built by a different embedder. Tables in `public` (Prisma) are read-only here.

## Endpoints

| Method | Path | Notes |
|---|---|---|
| GET | `/health` | db, redis, index size, catalog size, voice mode |
| POST | `/index/rebuild` | header `X-Internal-Key: $INTERNAL_API_KEY`; reloads catalog + re-embeds |
| GET | `/search?q=&limit=` | `{query, results:[{id, score}], filters}` (cached 60s in Redis) |
| POST | `/agent/chat` | `{message, session_id?, user_id?, client?, context?: {tryOn:{hasPhoto, mode, on:[{id}]}, results?, locale?, timeZone?, lang?, langMode?, spoken?, voiceOut?, origin?, events?}}` → brain reply + `session_id`. `user_id` and `client` (the gateway's hashed guest network) count only with `X-Internal-Key` |
| GET | `/agent/preview?q=` | `{products:[ids]}` live suggestions |
| WS | `/agent/ws?session_id=&token=` | only with `AGENT_WS_ENABLED=true` (the storefront doesn't use it, and it has no gateway throttle); see below |
| GET | `/capabilities` | `{agent, multilingual, tryon, speech: {stt, tts}}` |
| POST | `/tryon/render` | internal. `{user_id, photo? (data URI) \| sample? (0–3), items: [{id} \| {image, slot, styling?}], notes per item?, seed?}` → `{image, steps, rendered, cached}` |
| POST | `/tryon/cutout` | internal. `{image (data URI or URL), crop?: [x0, y0, x1, y1]}` → `{image}`: the item as a transparent PNG for the storefront's quick preview (BiRefNet-lite, MIT; ~220 MB, downloaded on first use to `CUTOUT_MODEL_PATH`, default `.models/`). 503 `cutout_unavailable` without `onnxruntime` or the model |
| POST | `/tryon/check` | internal. `{image (data URI or URL), slot, name?, colors?, ai?}` → photo quality report (`ok`, `score`, `grade`, `issues[]`) |
| POST | `/speech/transcribe` | internal, multipart `file` (+ `language` to pin one) → `{text, lang, confidence}` |
| POST | `/speech/speak` | internal. `{text, lang?}` → MP3 |
| POST | `/voice/token` | `{identity, room?}` → `{token, url, room, identity}`, or 503 without LiveKit keys |
| GET | `/usage?days=7` | internal. Paid AI usage and estimated spend per UTC day, today's caps, the models in use |

Brain reply: `{text, speech?, lang?, products?, actions?, chips?, mood?, askSize?, askColor?, offTopic?, done?}`
(plus `wanted`, kept server-side: what the shopper asked for that the catalog doesn't have, queued in Redis
`wants:inbox` for the API's outreach worker)
(`speech` only when the reply will be spoken; `askSize`: a product whose sizes the storefront shows as buttons,
`askColor` the colour the shopper named, which they add; `offTopic`: Pip declined, and `done`: the shopper said
goodbye, so hands-free listening pauses); actions are
`navigate, add, like, openCart, reorder, tryon, restyle, untry, clearLook, buyLook,
fittingRoom, sampleModel, adjust` (same objects as the JS brain; `restyle` is
`{id, prompt}`, how to wear an item in the AI try-on). `/agent/chat` also takes
`kind: "greet"` (no message) for an opening line in the shopper's language.
With `user_id`, cart lines come from Redis `cart:{userId}` and orders from Postgres.
Session memory lives in Redis `agent:session:{id}` (TTL 2h).

## WebSocket protocol (JSON)

Off unless `AGENT_WS_ENABLED=true`. On connect the server sends `{"type":"session","session_id":...}`.

| client → server | server → client |
|---|---|
| `{"type":"partial","text":...}` (interim transcript) | `{"type":"suggestions","products":[ids],"text":...}` (debounced 150ms) |
| `{"type":"message","text":...,"context"?:{...}}` | `{"type":"status","status":"thinking"}` then `{"type":"reply",...reply,"session_id"}` |
| `{"type":"ping"}` | `{"type":"pong"}` |

Each reply is also published on Redis channel `agent:events:{session_id}`.

## How Pip's Claude brain works (`app/brain/claude.py`)

Why it is built this way, with the cost research and the relevance check's test results: `../PIP_COSTS.md`.

- **Free checks first** (`app/brain/gate.py`, ~20 µs, no AI): obvious off-topic *tasks* (write a poem, solve
  this sum, code, translate, trivia, jokes), prompt-injection attempts, empty input or speech-to-text noise,
  and a plain "thanks" / "bye" / "আল্লাহ হাফেজ" get a reply from `app/brain/templates.py` in the shopper's
  language (English, Bangla, Banglish, Hindi, Hinglish, Urdu, Arabic, Spanish). It never declines on a topic
  word ("shoes for my diabetic dad", "a t-shirt with a Python logo" go to Claude), never inside an answer to
  Pip's own question, and anything it isn't sure about goes to Claude, which declines the rest itself
  (`offTopic` in its reply). `PIP_GATE=shadow` only counts what it would catch. The labelled test set
  (`tests/data/relevance_cases.json`, 1,500 messages in 13 languages plus romanized Bangla, Hindi and Urdu) must stay at zero false declines.
- **Limits** (`app/brain/limits.py`): 3 off-topic turns within 30 minutes (per account, else per guest chat)
  start a 10-minute cooldown for messages with nothing about shopping; daily Claude-turn quotas per signed-in
  shopper, guest chat and guest network; near `CLAUDE_DAILY_BUDGET_USD`, guests with an empty cart go to quick
  mode first. Quick mode is the rule brain for English and a template elsewhere; browsing, cart and checkout
  never depend on Pip.
- **One call per turn** otherwise. The persona, rules and the whole catalog (up to 150 products) sit in a
  system prompt cached for an hour (`PIP_SYSTEM_CACHE_TTL`), rebuilt only when the catalog reloads. The turn
  carries a compact context note: device language and time zone, local time and season, upcoming festivals for
  the likely region (`app/culture.py`), and only what differs from the defaults (cart, orders, fitting room,
  profile, products shown last by id, what the shopper did on the product cards). Every client field in it is
  validated, product names come from the catalog, and the shopper's message can't open or close the note.
- **Language**: Claude replies in the language and script of the shopper's message (mirroring code-mixing
  like Banglish or Hinglish) and returns a BCP-47 `lang`, which the browser uses to speak and to listen next.
- **Short structured reply**: JSON (`output_config.format`) with `text` (at most two short sentences; the
  product cards carry names and prices), `speech` (only when the reply will be spoken), `lang`, `products`,
  `actions`, 2–3 `chips`, `mood`, and optional `askSize` / `askColor` / `offTopic`. Every product id and action
  is validated against the catalog before it's returned.
- **Catalog only**: no tools or web search. "What's trending" means Cartly's own popular and new products. Above
  150 products the prompt lists the most popular and each message adds up to 8 pgvector matches. (Cheaper than
  retrieving products per message while the catalog is this size: a cached product line costs 1/20th of an
  uncached one on Opus 5.5.)
- **History**: up to 16 messages as plain text in Redis; past that the oldest are dropped in one step down to 8,
  so for several turns in a row each request's history is the cached prefix of the next (a sliding window
  rewrote the whole history to the cache every turn). The last message carries the cache breakpoint.
- **Shared replies**: a shopper Pip knows nothing about (no name, cart, orders or profile) who sends exactly the
  same request as another (same message, history, locale, hour) gets one of 2 stored replies
  (`PIP_REPLY_CACHE`): mostly taps on the same greeting chips. Greetings are shared the same way (3 per
  locale, time zone and hour), and a known shopper's own opener is kept for the hour.
- **Resilience**: refusals fall back server-side (`fallbacks: "default"`); if Claude is unreachable, slow
  (`AGENT_TIMEOUT` per attempt, 35 s; `AGENT_DEADLINE` per turn, 38 s) or over budget, the rule brain answers
  English and a template the other languages (quick mode's once the day's budget is spent).
- **Spend**: every call is metered (`app/usage.py`) by feature, by where the message came from (typed, voice,
  chip, greeting), with thinking tokens, stop reasons, 1-hour cache writes at their 2x price, and refusal
  fallbacks priced at the model that answered. What the free paths saved shows on the admin System page
  (`saved:gate`, `saved:closer`, `saved:reply`, `saved:card`, greetings). Past `CLAUDE_DAILY_BUDGET_USD` the
  free paths answer until 00:00 UTC. Try-on and voice have their own caps.
- **Model**: `AGENT_MODEL` picks the request shape per family (`llm.request_options`): Opus with effort and the
  refusal fallback, Sonnet 5.5 optionally without thinking (`AGENT_THINKING=between_tools`), Haiku 5.5 with
  effort but no refusal fallback, Haiku 4.5 without effort. Pip and the admin AI run on Haiku 5.5 (owner's call,
  2026-10-15); the eval below compares it with the others.
- **Trying other models**: an `AGENT_MODEL` with a "/" (an OpenRouter id such as
  `nvidia/nemotron-3-super-120b-a12b:free`) goes to OpenRouter with `OPENROUTER_API_KEY` (`llm._openrouter`),
  and the reply comes back shaped like a Claude message. No prompt caching or refusal fallback there;
  reasoning is off at effort `low`. `:free` models are metered at $0.

To compare models on the same conversations before switching `AGENT_MODEL`, run
`.venv/bin/python -m scripts.pip_model_eval` (prints the plan and its cost; `--yes` runs it: about $4 for the
default Opus / Sonnet / Sonnet-without-thinking configurations × 3 trials, about $1.40 with `--trials 1`;
`--configs model[:effort[:thinking]],...` to choose). The free paths and caches are off during the run, so it
measures the models. To check that prompt caching works on your key, `.venv/bin/python -m scripts.pip_cache_probe --yes`
(about $0.10) sends one request twice and fails if the second reads nothing from the cache.

To add another provider, implement `AgentProvider` in `app/brain/providers.py`
(`respond`, `greet`, `preview`) and register it in `get_provider()`. For better
search, `pip install sentence-transformers`, set `EMBEDDINGS_PROVIDER=sentence-transformers`
and restart (the index is rebuilt automatically; same 384 dims).

## LiveKit

Set `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`; `/voice/token` then
returns a room-join JWT (`livekit-api`, imported lazily). Without them, voice
runs in the browser (Web Speech API → Pip through the API's `/assistant/chat`, replies via speechSynthesis
or ElevenLabs).
