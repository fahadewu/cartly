# Running Cartly for 10,000 concurrent shoppers

The web tier is cheap to scale; the paid AI services are not. At 10,000 shoppers online at once, the
servers cost a few hundred dollars a month, but Pip, the AI try-on and Pip's voice could each cost that
much in an hour. This page covers how to deploy for that load, what the code already does to keep
spending down, and which cost decisions are still open.

## What the load looks like

These are assumptions, so replace them with real numbers once the site is live:

| | Assumption | Result |
|---|---|---|
| Web traffic | Each shopper makes one API request every ~8 s (pages, cart, search) | ~1,250 req/s on average, ~4,000 req/s at peaks |
| Storefront bootstrap | `GET /catalog` once per visit, plus a refresh after 2 min in the background | Mostly served by the CDN (see below) |
| Pip | 25% of shoppers chat, one message every ~45 s while chatting | ~55 Claude calls/s, ~200,000 per hour |
| AI try-on | 5% of shoppers render ~3 looks an hour | ~1,500 renders per hour |
| Voice | 5% of shoppers talk to Pip, and each reply is spoken | ~40,000 spoken replies per hour |

## Architecture

```
 Shoppers ─▶ CDN ──────────────▶ storefront + admin (static builds: vite build)
              │  caches /api/v1/catalog, /products, /categories, /collections, /stories, /products/search
              ▼  (s-maxage=30); everything else passes through
          Load balancer ─▶ API × 3–8 (NestJS, 1 vCPU each, stateless, autoscale on CPU)
                              │  internal network only
                              ├──▶ AI service × 2 (FastAPI; not reachable from the internet)
                              ├──▶ Postgres (managed; the API and AI pools share max_connections)
                              ├──▶ Redis "state": carts, Pip sessions, rate limits, usage meter (noeviction, AOF)
                              └──▶ Redis "cache": try-on renders, voice clips, greetings, search (allkeys-lru)
```

| Piece | Size to start | Settings |
|---|---|---|
| Storefront, admin | Static hosting on the CDN | `VITE_API_URL` pointing at the API's public URL |
| API | 3 containers × 1 vCPU / 1 GB, autoscale to 8 at 60% CPU | `NODE_ENV=production`, `TRUST_PROXY` = number of proxy hops (e.g. 2 for CDN + load balancer), `DB_POOL_MAX=10` |
| AI service | 2 containers × 2 vCPU / 2 GB, `WEB_CONCURRENCY=2` (uvicorn workers) | Private network only. `CACHE_REDIS_URL` |
| Postgres | 2 vCPU / 8 GB, managed, daily backups | `max_connections` ≥ API instances × 10 + AI workers × 10 (8 × 10 + 4 × 10 = 120), or put the provider's pooler in front |
| Redis (state) | 1 GB | `maxmemory-policy noeviction`, AOF on. Losing it loses carts |
| Redis (cache) | 2 GB | `maxmemory 2gb`, `maxmemory-policy allkeys-lru`. A try-on render is a few hundred KB |

**Required before running more than one API instance:** uploaded product photos and cut-outs are written to
the API's local disk (`UPLOAD_DIR`). Mount a shared volume there (EFS, Filestore, NFS), or move them to object
storage (S3, R2) served through the CDN. Otherwise an upload goes to one instance and every other instance
returns 404 for it.

## What the code does for this

### Web tier

| Change | Where | Effect |
|---|---|---|
| Catalog reads are cached in each API instance for 30 s. A version key in Redis makes every instance reload as soon as an admin saves or a shopper posts a review | `api/src/common/cache.ts`, `catalog/catalog.module.ts` | Postgres sees one bootstrap load per instance per 30 s instead of one per visit |
| Public catalog GETs send `Cache-Control: public, max-age=0, s-maxage=30, stale-while-revalidate=60` and an ETag. Product pages don't, so a new review shows up at once | `catalog.module.ts` | A CDN serves the storefront bootstrap; browsers revalidate with a cheap 304 |
| The AI capabilities check (made on every page load) is cached for 30 s | `api/src/common/ai.ts` | One call to the AI service per instance per 30 s |
| Rate limits count per signed-in account, else per IP. One atomic Redis round trip per request instead of 3–4 | `api/src/common/redis-throttler.storage.ts` | Shoppers behind a mobile carrier's shared IP don't throttle each other |
| `TRUST_PROXY`, `DB_POOL_MAX`, `THROTTLE_LIMIT` | `api/src/config.ts` | Real client IPs behind a CDN, a pool sized to the database, a tunable limit |
| Each AI replica checks every 15 s whether the catalog was re-indexed on another replica, and reloads | `ai/app/main.py` | Several AI replicas stay in step with admin edits |
| Caches can go to a separate, evictable Redis (`CACHE_REDIS_URL`) | `ai/app/redis_client.py` | A busy try-on day evicts old renders instead of failing cart writes |
| docker-compose publishes only the API; Postgres, Redis and the AI service listen on localhost | `docker-compose.yml` | Nobody outside the machine can reach the AI service (and spend on Claude) directly |

Measured on the development machine (one API process, 200 connections, 10–15 s runs, `npx autocannon`):

| Endpoint | Before | After |
|---|---|---|
| `GET /catalog` (35 KB) | 1,288 req/s · p50 146 ms · p99 277 ms | 2,967 req/s · p50 52 ms · p99 187 ms |
| `GET /products/12` | 2,580 req/s · p50 70 ms | 13,038 req/s · p50 13 ms |
| `GET /assistant/capabilities` | 7,765 req/s · p50 22 ms | 26,357 req/s · p50 6 ms |
| `GET /cart` (signed in) | | 7,565 req/s · p50 23 ms · p99 65 ms |
| `GET /products?category=…` | | 15,182 req/s · p50 12 ms |
| `GET /products/search?q=…` (cached) | | 4,346 req/s · p50 18 ms · p99 103 ms |

A cloud vCPU is slower than this workstation's cores, so plan on about a third of these numbers per vCPU.
That still leaves 3 API instances with plenty of headroom for ~4,000 req/s, because the CDN takes the
heaviest reads.

### AI spend

The research behind the 2026-10-08 controls (where the money went, what each change saves, what was rejected
and why, how the relevance check was tested) is in [PIP_COSTS.md](PIP_COSTS.md).

| Change | Where | Effect |
|---|---|---|
| **Metering**: each Claude, FASHN and ElevenLabs call adds its usage and an estimated cost to a per-day Redis hash, shown on the admin **System** page (`GET /usage` on the AI service) | `ai/app/usage.py` | Real cost per feature per day, so decisions can be based on actual numbers |
| **Daily caps**: `CLAUDE_DAILY_BUDGET_USD`, `TRYON_DAILY_BUDGET_USD`, `VOICE_DAILY_BUDGET_USD` (0 = none). Once a cap is reached, that feature falls back until 00:00 UTC | `usage.py`, `brain/claude.py`, `tryon.py`, `speech.py` | A bad day, a bug or abuse can't cost more than the cap |
| **Shared greetings**: shoppers Pip knows nothing about yet (not signed in, empty cart) get one of 3 greetings generated for their language, time zone and hour | `brain/claude.py` | Pip's opening line costs ~3 Claude calls per locale per hour instead of one per visit |
| **Pip chat limit**: 20 messages a minute per account (else per IP). Past it, the storefront's built-in brain answers | `api/src/assistant/assistant.module.ts` | Nobody can script thousands of Claude calls |
| **Shared sample-model looks**: renders on the four sample models are the same for every shopper, so they're cached for everyone for 7 days (`TRYON_SAMPLE_CACHE_TTL`) | `ai/app/tryon.py`, `main.py` | Each sample look is paid for once |
| **One render per look**: two identical render requests at the same time (a double tap, two shoppers on the same sample look) run once. The cache key includes the product photo, so replacing a photo renders again | `tryon.py` | No duplicate FASHN charges |
| **Voice clip cache**: a phrase requested for the second time (greetings, "Your look is ready!") is kept for 7 days and replayed | `ai/app/speech.py` | Repeated phrases are free; one-off replies aren't stored |
| **Catalog-only Pip**: no web trend lookups; "what's trending" is answered from Cartly's own popular and new products, so every reply is exactly one Claude call | `brain/claude.py` | No web search fees or extra summarising calls |
| **Stepped history window**: up to 16 messages; past that the oldest are dropped in one step down to 8. The end of the history carries a cache breakpoint, so each follow-up re-reads the conversation at the cached rate (a 12-message sliding window rewrote the whole history to the cache, at 1.25x, on every turn from the 7th message) | `brain/claude.py` | Long chats stop paying a cache write for the whole history every turn |
| **Reply cap**: `max_tokens` 1500 (was 4000), enough for a short JSON reply in any script; a reply that runs past it goes to the rule brain | `brain/claude.py` | Caps the worst case per reply |
| **Big catalogs**: above 150 products the prompt lists the most popular ones and each message adds up to 8 matches from our own pgvector search | `brain/claude.py`, `search.py` | Every product stays findable without sending the whole catalog |
| **Free relevance check before Claude**: obvious off-topic tasks (poems, homework, code, trivia, jokes, translations), prompt-injection attempts, empty input and speech-to-text noise get a sweet template reply in the shopper's language; a plain "thanks" / "bye" gets a template "you're welcome". It never declines on a topic word or inside an answer to Pip's question; unsure messages go to Claude. Zero false declines on a 1,500-message test set in 13 languages plus romanized Bangla, Hindi and Urdu. `PIP_GATE`, `PIP_TEMPLATE_LANGS`, `PIP_CLOSERS` | `ai/app/brain/gate.py`, `templates.py` | Off-topic, injection and noise turns cost nothing; Claude still declines whatever slips through |
| **Strikes and cooldown**: 3 off-topic turns within 30 minutes (from the check or Claude's own `offTopic` flag) start a 10-minute cooldown in which messages with nothing about shopping get a template. Counted per account, else per guest chat; the guest network only counts daily turns (one mobile IP is often thousands of shoppers, so a stranger's off-topic turns never cool anyone else down) | `ai/app/brain/limits.py` | Off-topic chats stop costing after 3 messages; a script that drops its session id is bounded by the network's daily quota |
| **Daily Claude-turn quotas**: 200 per signed-in shopper, 80 per guest chat, 1,000 per guest network (mobile networks share IPs); past one, Pip answers in quick mode (rule brain for English, a template elsewhere). With `CLAUDE_DAILY_BUDGET_USD` set, guests with an empty cart switch to quick mode at 80% of it, so signed-in shoppers and full carts keep Claude longest | `limits.py`, `brain/claude.py` | One identity can't burn the day's budget; the cap's cliff hits the least valuable traffic first |
| **Card buttons act in the browser**: Add (with an inline colour and size picker for items that have a choice) and Try on on Pip's product cards no longer send "Add number N" through Claude; what the shopper did rides along as a note with their next message. Claude's own size questions come with `askSize` (and `askColor` when the shopper named one), shown as size buttons that add that colour | `storefront/src/components/agent/AgentProducts.vue`, `useAgent.js` | Each tap was a full Claude turn (two for multi-size items) and switched Bangla chats to English |
| **Shorter replies**: at most 2 short sentences (the cards carry names and prices), 2–3 chips, and `speech` only when the reply will be spoken (`voiceOut`) | `brain/claude.py`, `useAgent.js` | Fewer output tokens on every turn, the most expensive part of a reply |
| **Compact context note**: lines at their default are left out, products by id, festival angles only early in a chat; every client field validated (an oversized fitting-room name could add ~28k uncached tokens a turn) | `brain/claude.py`, `culture.py` | Fewer uncached input tokens per turn, and no cost amplification |
| **1-hour cache on the shared prompt** (`PIP_SYSTEM_CACHE_TTL`) | `brain/claude.py` | After any quiet gap over 5 minutes the 9k-token prefix was re-written (~$0.045, about five turns' worth); now once an hour |
| **Shared replies for identical requests** from shoppers Pip knows nothing about: same message, history, locale and hour, no name/cart/orders/profile; up to 2 stored replies per request, kept an hour (`PIP_REPLY_CACHE`) | `brain/claude.py` | Taps on the same greeting chips cost one Claude call per hour, not one per shopper |
| **A signed-in shopper's own opener** is kept for the same facts within the hour (`PIP_GREETING_CACHE`) | `brain/claude.py` | Re-opening Pip or "Start over" doesn't pay again |
| **Deadlines**: one retry, 35 s per chat attempt (so a slow reply can still finish), 38 s per turn (`AGENT_TIMEOUT`, `AGENT_DEADLINE`), under the gateway's 45 s; the admin photo check and product suggestion allow 40 s an attempt | `ai/app/llm.py`, `brain/claude.py` | No paying for replies that arrive after the shopper got the fallback |
| **Hands-free guard**: the voice screen stops listening again by itself after an off-topic reply or a goodbye, a one-word low-confidence transcript, or 3 automatic re-listens without a tap | `storefront/src/agent/useAgent.js` | A TV in the room doesn't keep paying for speech-to-text, Claude and voice |
| **Websocket chat off** unless `AGENT_WS_ENABLED=true`: the storefront doesn't use it and it had no gateway throttle | `ai/app/main.py` | One less unthrottled way to spend on Claude |

## What it costs

Unit prices (list prices, 2026-09; the meter uses the same ones, and they can be adjusted in `.env`):

| Unit | Opus 5.5 (current) | Cheaper option |
|---|---|---|
| Pip reply before 2026-10-08 (~9k cached prompt tokens, 0.2–0.45k uncached, ~90–210 visible output tokens plus 0–150 thinking, effort low) | ≈ $0.006–0.011 (estimate) | Sonnet 5.5 ≈ 40% less with thinking on, ≈ 55–59% less with `AGENT_THINKING=between_tools` |
| AI try-on render, 1k (`TRYON_MODE`) | balanced: 2 credits ≈ $0.15 | fast: 1 credit ≈ $0.075 (−50%) |
| Spoken reply, ~100 characters (ElevenLabs v4) | ≈ $0.01 | Flash model ≈ half, but only for the languages it covers (not Bangla) |
| Transcribed voice message, ~5 s | ≈ $0.0003 | |

Output tokens are the largest part of a reply on Opus 5.5 (about 40–60%, thinking included, which can't be
switched off there), then the cached prompt (20–33%), the uncached context note (10–16%) and cache writes. So
the controls above aim first at not calling Claude at all, then at fewer output tokens.

What the 2026-10-08 controls are expected to save on Pip's chat spend, same model (estimates from the code and
an assumed traffic mix; the meter's `saved:*`, `gate:*` and `claude:origin:*` counters replace them within a week):

| Control | Expected saving |
|---|---|
| Card buttons and size answers in the browser | ≈ 8–15% of calls |
| Shorter replies and no `speech` on typed turns | ≈ 8–12% of each remaining turn (more in Bangla) |
| Stepped history window | ≈ 5% overall; 15–17% of every turn past the 7th message of a chat |
| Compact context note | ≈ 3–6% of each turn |
| Shared replies and openers | ≈ 3–10% of calls, mostly guests tapping greeting chips |
| Free relevance check, closers, cooldown | ≈ 3–6% normally; 10–15% during launch spikes or abuse |
| 1-hour shared-prompt cache | ≈ 0 at continuous peak; most of the cost of quiet hours |
| **Together** (overlaps removed) | **≈ 30–40%**; with Sonnet 5.5 after the eval, ≈ 60% |

At the assumed peak (see the top of this page), one hour costs roughly:

| | Before (Opus 5.5, balanced) | With the new controls | Plus the open decisions below |
|---|---|---|---|
| Pip: 200,000 messages | ~$1,100–2,400 | ~$750–1,500 | ~$450–900 on Sonnet 5.5 |
| Try-on: 1,500 renders, assuming ~40% come from the shared sample cache | ~$135 | ~$135 | ~$70 in fast mode |
| Voice: 40,000 spoken replies | ~$400 | a little less (fewer noise turns; template phrases replay from the clip cache) | less with browser voices for English |
| Servers, CDN, databases | ~$1 (about $400–700 a month) | | |

The per-reply figures are estimates from the prompt sizes (no API key was available to measure them); the meter
measures the real ones. Pip's reply cost at this scale is what matters most, so treat the chat assumptions (25%
of shoppers, one message every 45 s) as the number to check first. RAG (retrieving a few products per message
instead of caching the catalog in the prompt) would cost more, not less, below roughly 160 products on Opus 5.5:
a cached product line costs a twentieth of an uncached one.

## Decisions for you

1–4 aren't switched on; 5–8 are on with defaults chosen without you, and each is one `.env` line to change.

1. **Set the daily caps** before launch, for example `CLAUDE_DAILY_BUDGET_USD=300`, `TRYON_DAILY_BUDGET_USD=100`,
   `VOICE_DAILY_BUDGET_USD=50`, then adjust them from what the System page shows.
2. **(Decided 2026-10-15: Pip and the admin AI run on Haiku 5.5, now the default `AGENT_MODEL`. Kept for
   comparing models.)** **Pip on Sonnet 5.5** (≈ 40% less per reply, ≈ 55–59% with `AGENT_THINKING=between_tools`). First compare
   quality, language accuracy and reply times in Bangla and the other languages:
   `cd ai && .venv/bin/python -m scripts.pip_model_eval --yes` (about $4 for Opus, Sonnet and Sonnet without
   thinking, 3 trials each; about $1.40 with `--trials 1`; without `--yes` it only prints the plan). Then set
   `AGENT_MODEL=claude-sonnet-5-5`. Haiku 4.5 (`--configs claude-haiku-4-5`) is supported by the request code now,
   but needs its own eval run.
3. **Try-on mode and hourly limit**: `TRYON_MODE=fast` halves the cost per render. Choose it (or keep balanced)
   from the paid quality test (`python -m scripts.tryon_eval --yes`). `TRYON_HOURLY_LIMIT=30` allows a single
   shopper to spend $4.50 an hour; 10 is plenty for real shoppers.
4. **Voice**: signed-in shoppers in voice mode always get ElevenLabs. Using the device's own voice for English
   (and ElevenLabs where the device has no good voice, as for Bangla), or the cheaper flash model for the
   languages it covers, would cut most of the voice cost. Pip would sound less consistent across languages.
5. **The relevance check enforces** (`PIP_GATE=enforce`) in all 8 template languages. Have a native speaker read
   the template replies in `ai/app/brain/templates.py` (Bangla, Banglish, Hindi, Hinglish, Urdu, Arabic,
   Spanish); until they're approved you can narrow `PIP_TEMPLATE_LANGS` (e.g. `en,bn,bn-Latn`: other languages
   then always go to Claude), or set `PIP_GATE=shadow` for a week to see what it would catch (`gate:*` counters).
6. **Quotas**: 200 Claude turns a day per signed-in shopper, 80 per guest chat, 1,000 per guest network. Quick
   mode still answers, in English through the rule brain or with a template. Raise them if real shoppers hit them.
7. **Shared replies** (`PIP_REPLY_CACHE=true`, 2 replies per identical request): guests who send exactly the same
   request in the same hour share Pip's answer. `false` gives every shopper a fresh reply.
8. **Hands-free voice** pauses after 3 automatic re-listens without a tap, after an off-topic reply or a goodbye,
   and after a one-word transcript the browser's recogniser says it isn't sure of (a confidence under 0.5; one
   that reports none, or Pip's own speech-to-text, never pauses it this way).
9. **After the eval**: `PIP_PROMPT_KEYWORDS=false` drops the "also called" names from Pip's prompt (about 2% of an
   Opus turn, 4–5% on Sonnet); keep it on if Pip finds fewer products by their Bangla names without them.

## Before launch

- [ ] Uploads on shared storage (see above).
- [ ] `TRUST_PROXY` set to the real number of proxy hops, and only then. Without a proxy in front, anyone
      could choose their IP with an `X-Forwarded-For` header. Behind a proxy without it, every guest shares the
      proxy's IP: one rate limit and one guest-network quota for all of them.
- [ ] `CACHE_REDIS_URL` pointing at a separate Redis with `allkeys-lru`; the state Redis on `noeviction` with AOF.
- [ ] AI service on the private network only (no public port). It answers `/agent/chat` without the internal
      key, as a guest.
- [ ] The same `INTERNAL_API_KEY` in the API and the AI service: without it the AI service treats everyone as an
      anonymous guest with no account, cart, orders or guest network (quotas then count per chat only).
- [ ] Restart every AI replica once after this release: the search index rebuilds itself as `hashing-v2`, which
      reads Bangla, Hindi and Arabic (the old one gave them empty vectors).
- [ ] Anthropic: check the organisation's rate limits (requests, input and output tokens per minute) against
      ~3,300 requests a minute at peak, and ask for an increase in the Console well before launch. The same
      applies to FASHN's and ElevenLabs' concurrency limits for your plans.
- [ ] Daily caps set (decision 1).
- [ ] A load test against staging with the CDN in front: `npx autocannon -c 500 -d 60 https://staging…/api/v1/catalog`,
      and a signed-in mix (cart, product pages, search). Set `THROTTLE_LIMIT` high on staging, or every request from
      the test machine counts against one IP.

## Not done yet (worth measuring first)

- **Session context in a cached block**: about 65% of Pip's per-turn context note (device, festivals, profile)
  doesn't change during a chat. A second, per-session system block would cache it (≈ 4–7% of a turn), at the cost
  of a cache write whenever the cart changes. Decide from a week of meter data.
- **A local multilingual encoder for the relevance check** (multilingual-e5-small, 118 MB, ~2 ms per message,
  ~350 MB RAM per worker): only worth it if `gate:unsure` turns that Claude then flags `offTopic` reach about 3% of
  calls. It would also improve Bangla product search.
- **Inflected Bangla words in search** (জুতাগুলো, জুতার) don't match the base keyword জুতা yet; Hindi, Urdu and
  Arabic queries need keywords in those scripts in the catalog.
- **Password hashing** uses bcryptjs (pure JavaScript: 56 ms of CPU per sign-in on the development machine, more on a cloud vCPU). A sign-in burst needs a
  native bcrypt or argon2 before it becomes the bottleneck.
