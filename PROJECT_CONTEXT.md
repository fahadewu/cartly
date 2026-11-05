# Cartly: project context for an AI assistant

> Written 2026-11-05 from the code, the repo READMEs and the project's decision log.
> Read this first, then the deeper docs listed in §15 when you work on a specific area.
> **Never paste `backend/.env` into a chat.** It holds real secrets (JWT, payment encryption key, an OpenRouter key).

---

## 1. What Cartly is

Cartly is a fashion e-commerce store for the **Bangladesh market** with an AI shopping assistant called **Pip**.

- **Shoppers** browse, search (semantic, multilingual), chat or talk to Pip by voice, try clothes on virtually,
  check out with Bangladeshi payment methods (bKash, Nagad, Rocket, cards, cash on delivery), and track delivery.
- **Pip** talks only about Cartly's own catalog. It answers in the shopper's language and script: English,
  Bangla (বাংলা), **Banglish** (Bangla written in Latin letters), Hindi, Urdu, Arabic and others. It mirrors
  code-mixing, knows the shopper's season and upcoming festivals (Eid, Durga Puja and others), adds to the cart,
  starts try-ons, and politely declines off-topic requests.
- **Staff** run the store from a separate admin panel: products, orders, payments, delivery (own riders and
  couriers), returns, analytics, visitor journeys, AI spend and team roles.
- **Riders** (the store's own delivery staff) use a phone-sized rider app inside the admin panel at `/rider`.

Most shoppers are Bangladeshi, so Bangla and Banglish quality is a hard requirement, not a nice-to-have.

Owner: the user (GitHub `fahadewu`). The footer carries a "Powered by Leopard" studio credit (`storefront/src/components/PoweredBy.vue`).

---

## 2. Repos and folder layout

The workspace root (`Agentic_Shopping/`) is **not** a git repo. It holds three repos side by side, plus `dev.sh`,
`README.md`, `TESTING.md` and this file.

| Folder | GitHub repo | What | Port |
|---|---|---|---|
| `storefront/` | `fahadewu/cartly_storefront` | Vue 3 + Vite shopper site, Pip widget, voice, try-on | 5173 |
| `admin/` | `fahadewu/cartly_admin` | Vue 3 + Vite admin panel + rider app (`/rider`) | 5174 |
| `backend/api/` | `fahadewu/cartly_backend` | NestJS 12 + Prisma 7 commerce API (`/api/v1`, Swagger at `/docs`) | 4100 |
| `backend/ai/` | (same repo) | FastAPI (Python 3.12) AI service: Pip, search, try-on, voice, usage meter | 8001 |
| `backend/catalog/catalog.json` | (same repo) | Seed data only: 40 products, categories, collections, 6 stories, 2 promo codes, shipping rules | n/a |

**Public monorepo (2026-11-05):** [`fahadewu/cartly`](https://github.com/fahadewu/cartly) holds all three apps as
plain folders plus the workspace files, as one public repo for judges: a fresh snapshot with no history from the
private repos. It adds `./cartly test` (every suite in Docker on throwaway databases), `./cartly smoke` (a running
store over HTTP) and one GitHub Actions workflow for everything. The private repos above stay the working repos; the
internal reviews (`CODE_REVIEW.md`, `ARCHITECTURE_PLAN.md`, `STOREFRONT_PLAN.md`) are kept out of the public one.

---

## 3. Architecture

```
 Storefront (Vue, :5173) ─┐                     ┌────────────────────────────────────┐
                          ├── REST /api/v1 ────▶│ API  NestJS + Prisma  (:4100)       │
 Admin + rider (:5174) ───┘   (Vite proxies     │ auth, catalog, cart, orders,        │
                               /api in dev)     │ payments, delivery, returns,        │
                                                │ analytics, journeys, admin/*        │
                                                └───────┬───────────────┬────────────┘
                                                        │               │ X-Internal-Key
                                                        │               ▼
                                                        │   ┌──────────────────────────────┐
                                                        │   │ AI service  FastAPI (:8001)   │
                                                        │   │ Pip brain, pgvector search,   │
                                                        │   │ try-on (FASHN), voice          │
                                                        │   │ (ElevenLabs), usage meter     │
                                                        │   └───────┬──────────────────────┘
                                                        ▼           ▼
                              ┌─────────────────────────────┐  ┌──────────────────────────────┐
                              │ PostgreSQL 15 + pgvector    │  │ Redis                         │
                              │ public: Prisma tables       │  │ carts, Pip sessions, rate     │
                              │ ai: product_embeddings      │  │ limits, usage meter, caches,  │
                              └─────────────────────────────┘  │ journey queue                 │
                                                               └──────────────────────────────┘
External: Anthropic (Claude), FASHN (try-on), ElevenLabs (voice), bKash, Nagad, SSLCommerz,
          Pathao, Steadfast, RedX, optional OpenRouter (model trials) and LiveKit (not used yet).
```

Key flows:
- **The browser only talks to the API.** Pip chat goes through `POST /api/v1/assistant/chat`. The API attaches the
  verified user and calls the AI service with the shared `X-Internal-Key`. The AI service trusts a `user_id` only
  with that key; anything else is treated as a guest.
- **The AI service reads Prisma tables but never writes them.** It owns only the `ai` schema (embeddings).
- **After any product change** the API asks the AI service to reload its catalog and rebuild the search index.
- **The storefront loads the whole live catalog** from `GET /catalog` before mounting, and refreshes it when a tab returns after a while.
- **Every AI feature is optional.** Each switches on with one key and has a free fallback without it (see §6).

---

## 4. Tech stack

| Layer | Choice |
|---|---|
| Storefront and admin | Vue 3.5 (`<script setup>`), vue-router 4, Vite 8, plain CSS with tokens on `:root` (no UI library, no Tailwind). Storefront also uses `@mediapipe/tasks-vision` for pose landmarks (try-on quick preview). |
| API | NestJS 12 (TypeScript, **ESM**: imports end in `.js`), Prisma 7 with `@prisma/adapter-pg`, ioredis, class-validator, sharp, `@nestjs/throttler` with Redis storage, bcryptjs, JWT. Lint `oxlint`, format `prettier`, tests `vitest`. |
| AI service | FastAPI, uvicorn, psycopg 3 + pool, pgvector, redis-py, pydantic 2, httpx, numpy, pillow, onnxruntime (BiRefNet-lite cut-outs). Anthropic SDK for Claude. Tests `pytest`. |
| Data | PostgreSQL 15 (Homebrew `postgresql@15`) with pgvector; Redis (Homebrew service). Docker: PostgreSQL 16 + pgvector, Redis 7, Mailpit (workspace `docker-compose.yml`, tested on Colima). |

---

## 5. Running it

```bash
./dev.sh          # from the workspace root: checks Postgres/Redis, starts all four apps, labelled logs
./dev.sh status   # what's on Cartly's ports
./dev.sh stop     # kill leftover Cartly servers from an earlier session
cd backend/api && npm run test-kit   # test accounts, BDT rate 122, sandbox gateways + Pathao
```

- **Always use `./dev.sh`.** Don't start the services one by one with `nohup`; that left orphaned duplicates before.
- **Ports live only in `backend/.env`** (`API_PORT=4100`, `AI_PORT=8001`). Both Vite configs read `API_PORT` from
  `../backend/.env`. The API is kept off 3000 because other Next.js projects on this machine use 3000–3005.
- If a port is taken, `dev.sh` names the process and its folder. **Never kill another project's server without asking.**
- First-time setup: `backend/README.md` → "Run locally" (`npm run db:deploy`, `npm run db:seed`, `backend/ai/run.sh` creates the venv).

Test accounts (dev/staging only; removal checklist in `TESTING.md`):

| App | Login |
|---|---|
| Storefront | `demo@cartly.dev` / `Demo1234!` |
| Admin | `admin@cartly.dev` / `Admin1234!` |
| Rider app (`:5174/rider`) | `rider@cartly.dev` / `Rider1234!` |

Promo codes: `WELCOME20`, `CARTLY10`. Dev-only demo card: `4242 4242 4242 4242`. Sandbox payment details are in `TESTING.md`.

Tests:
```bash
cd backend/api && npm run test:e2e              # e2e against real local Postgres + Redis, gateways/couriers stubbed
cd backend/api && npm test                      # unit (e.g. journeys/taste.spec.ts)
cd backend/ai && .venv/bin/python -m pytest -q  # ~465 tests incl. 1,501 labelled relevance cases
```
Last recorded run (2026-10-15): AI suite 463/465. `test_order_status_for_demo_user` fails only because the demo
order `CL-20931` was cancelled in the local DB. The login throttle (10/min) can trip e2e after repeated runs; wait a minute.

---

## 6. AI features and their fallbacks

| Feature | With a key | Without the key (current local state) |
|---|---|---|
| Pip's brain | Claude via `ANTHROPIC_API_KEY`; model `AGENT_MODEL=claude-haiku-5-5` | English **rule brain** (Python port of `storefront/src/agent/brain.js`); other languages get templates |
| Admin AI (photo review, "Suggest with AI" product details) | Claude (`ADMIN_AI_MODEL`, defaults to `AGENT_MODEL`) | Pixel checks only; no suggestions |
| Virtual try-on | FASHN Try-On Max via `FASHN_API_KEY` (re-renders the shopper's photo) | On-device quick preview, **accessories only** (glasses, hats, headphones, watches, bags) |
| Voice | ElevenLabs via `ELEVENLABS_API_KEY` (`scribe_v2` STT with language detection, `eleven_v4` TTS) | Browser Web Speech API and device voices |
| Search | Built-in dependency-free embedder `hashing-v2` (works for Bangla/Hindi/Arabic) in pgvector | Same; `EMBEDDINGS_PROVIDER=sentence-transformers` is optional |

`GET /assistant/capabilities` tells the storefront which features are on (`storefront/src/capabilities.js`).

**Current local `.env`:** `AGENT_MODEL=claude-haiku-5-5`, but **`ANTHROPIC_API_KEY`, `FASHN_API_KEY` and `ELEVENLABS_API_KEY` are not set.**
Locally, Pip therefore runs on the rule brain, try-on is the quick preview, and voice is the browser's.
An `OPENROUTER_API_KEY` is set from an earlier free-model trial. That key was pasted in chat once, so it should be rotated.

### How Pip answers a message (`backend/ai/app/brain/`)

1. **Gate** (`gate.py`, ~25 µs, free): catches obvious off-topic *tasks* (homework, poems, code, trivia), prompt
   injection, empty input or STT noise, and plain "thanks"/"bye"/"আল্লাহ হাফেজ". These get a reply from
   `templates.py` in 8 languages (`en, bn, bn-Latn, hi, hi-Latn, ur, ar, es`). Mode: `PIP_GATE=off|shadow|enforce`.
2. **Limits** (`limits.py`): 3 off-topic strikes in 30 min start a 10-min cooldown. Daily Claude-turn quotas apply:
   200 per account, 80 per guest chat, 1000 per guest network. A soft cap near the daily budget applies too.
   Past a limit, Pip switches to "quick mode" (rule brain or template).
3. **Caches**: shared replies for "unknown" guests sending identical requests (`PIP_REPLY_CACHE`), shared
   greetings, and a personal greeting cache.
4. **Exactly one Claude call per turn** (`claude.py`), with no tool loop and no web search:
   - The cached system prompt holds the persona, the rules and the whole catalog (up to `CATALOG_IN_PROMPT=150`
     products; above that, each message adds up to 8 pgvector matches). The cache lives 1 h (`PIP_SYSTEM_CACHE_TTL`).
   - A compact, validated per-turn context note carries locale, time zone, season, festivals (`culture.py`), cart,
     orders, fitting room, the quiet shopper profile, card events, and a `ROMANISED` hint so Banglish gets a Banglish answer.
   - History: up to 16 messages in Redis, dropped in one step to 8, so the cached prefix is reused.
   - `max_tokens` 1500. Structured JSON output: `text` (≤2 short sentences), `speech?`, `lang` (BCP-47),
     `products`, `actions`, 2–3 `chips`, `mood`, `askSize?`, `askColor?`, `offTopic?`, `done?`.
   - Every product id and action is validated against the catalog. Actions: `navigate, add, like, openCart,
     reorder, tryon, restyle, untry, clearLook, buyLook, fittingRoom, sampleModel, adjust`.
5. **Fallback**: on timeout (`AGENT_TIMEOUT` 35 s per attempt, `AGENT_DEADLINE` 38 s per turn, under the API
   gateway's 45 s), on error, or over budget, the rule brain answers English and templates answer other languages.
6. **Metering** (`usage.py`): every paid call is priced by feature, origin, cache use and thinking tokens. The
   admin System page shows today's spend and what free paths saved. Daily caps: `CLAUDE_/TRYON_/VOICE_DAILY_BUDGET_USD` (0 = off).

Model routing (`app/llm.py` → `request_options`): Opus gets effort plus a refusal fallback; Sonnet 5.5 can turn
thinking off; **Haiku 5.5 gets effort but no refusal fallback**; Haiku 4.5 gets neither. Any `AGENT_MODEL`
containing `/` goes to **OpenRouter** and comes back shaped like a Claude message. That route is for trials only.

The provider interface (`providers.py`) is `AgentProvider` with `respond`, `greet` and `preview`. Register new providers in `get_provider()`.

### Try-on
- AI try-on chains one product per render, innermost layer first, and caches each step 1 h per shopper in Redis.
  `TRYON_HOURLY_LIMIT` caps renders. Photos go to FASHN as base64 and are never written to disk. EXIF is stripped in the API.
- Each product can have a dedicated `tryOnImage` and `tryOnInfo` (photo type, styling prompt, quality check, crop, cutout mode).
- Admin uploads get pixel checks plus an optional Claude vision review (`garment_check.py`).
- Accessory cut-outs come from BiRefNet-lite (`cutout.py`, ~220 MB model downloaded on first use) and are stored under `uploads/tryon/`.

---

## 7. Commerce API map (`backend/api/src/`)

| Folder | Responsibility |
|---|---|
| `auth/` | signup, login, `/auth/me` (also returns the staff permission list), change password |
| `catalog/` | `/catalog` bootstrap, `/products` filters, `/products/search` (semantic with keyword fallback), reviews, categories, collections, stories |
| `cart/` | Redis cart, promo codes, checkout (`POST /orders`), stock checks inside the transaction (`stock.ts`) |
| `account/` | favourites, product requests, team |
| `assistant/` | gateway to the AI service: chat, transcribe, speak, capabilities, voice token |
| `tryon/` | `/tryon/render` gateway, cut-out generation |
| `payments/` | `gateways/{bkash,nagad,sslcommerz}.ts`, `secrets.ts` (AES-256-GCM with `PAYMENT_SECRETS_KEY`), payment sweeper, refunds, admin settings |
| `delivery/` | riders, `couriers/{pathao,steadfast,redx}.ts`, webhooks, a 5-minute status sweep, rider app endpoints |
| `returns/` | return requests → approve/reject → rider pickup → inspect/restock → refund |
| `analytics/` | sales, demand, customers, regions (`regions.ts`: BD's 64 districts and 8 divisions with aliases), returns, delivery, AI costs |
| `journeys/` | `/track` (Redis RPUSH, batched by a worker), `taste.ts` (pure shopper-profile model), `profile.ts` (incl. `/me/recommendations`), geo, user agent |
| `admin/` | dashboard, product CRUD, people, sales, try-on photo tools, AI reindex |
| `common/` | `permissions.ts` (**the single source of RBAC**), auth guards, cache (Redis version key + CDN headers), demand events, Redis throttler, image helpers |
| `generated/prisma/` | the generated Prisma client (don't edit) |

Scripts: `npm run test-kit`, `npm run db:seed` (`-- --reset-catalog` resets products/content), `npm run catalog:details`, `npm run tryon:cutouts`.

Rate limits: 120 req/min per shopper or IP (`THROTTLE_LIMIT`), 10/min on auth, 20/min on Pip chat.

---

## 8. Data model (`backend/api/prisma/schema.prisma`)

Models: `User, AuditEntry, Category, Collection, Product, Story, Review, Favourite, PromoCode, Order, OrderItem,
Payment, PaymentMethod, PaymentGateway, StoreSetting, Rider, Shipment, ShipmentEvent, Courier, ReturnRequest,
ReturnItem, DemandEvent, ProductRequest, TeamMember, Visit, PageView, ShopperProfile`. Migrations run 2026-09-28 → 2026-10-01 (12 so far).

Enums worth knowing:
- `Role`: `CUSTOMER, ADMIN, RIDER, MANAGER, SUPPORT, MERCHANDISER, ANALYST`
- `OrderStatus`: `PENDING_PAYMENT → PROCESSING → SHIPPED → DELIVERED`. `PROCESSING` or `SHIPPED` can go to `CANCELLED`, which restocks.
  Status changes are conditional updates, so two actors can't both win.
- `PaymentStatus`: `UNPAID` (COD), `PENDING, PAID, FAILED, CANCELLED, EXPIRED, REFUNDED`
- `ShipmentStatus`: `BOOKED, PICKED_UP, IN_TRANSIT, OUT_FOR_DELIVERY, DELIVERED, FAILED_ATTEMPT, RETURNING, RETURNED, CANCELLED`
- `ReturnStatus`: `REQUESTED, APPROVED, REJECTED, RECEIVED, REFUNDED, CANCELLED`

Products must carry the "details for Pip" (material, fit for clothing, occasions, seasons, style tags, features;
"also called" keywords are recommended) or the save is refused.

Gotcha: JSONB key order isn't preserved. Never read "top N" from `ShopperProfile.styles/tags` without sorting.

---

## 9. Business rules

- **Currency:** prices are stored in **USD**. Checkout charges **taka (BDT)** at an admin-set rate
  (`StoreSetting.usdToBdt`), fixed on each order. The local DB uses 122; the real rate is the owner's call.
- **Shipping** (seed values): standard $8, express $15, free standard over $100 after discounts. These look like
  demo values next to real ৳50–130 courier costs and are not confirmed by the owner.
- **Payments:** bKash (Tokenized Checkout v2), Nagad, Rocket and cards via SSLCommerz, COD, and a demo card that is
  refused in production. Credentials are entered in Admin → Payments → Settings and encrypted. An order is marked paid
  only after a server-side gateway confirmation, and each payment settles once. Unpaid online orders are cancelled
  after `PAYMENT_TIMEOUT_MINUTES` (30). Nagad has no refund API, so its refunds are recorded manually.
- **Delivery:** to own riders (a 4-digit code the customer sees is required on delivery; rider cash is "held"
  until an admin settles it) or to Pathao / Steadfast / RedX. Courier statuses map onto ours. Webhooks need a public HTTPS `API_PUBLIC_URL`.
- **Returns:** 7-day window after delivery (admin-editable; 0 = off). The refund is the item price less its share
  of the promo discount. Delivery is not refunded.
- **Analytics accuracy rules:** days are in `STORE_TIMEZONE` (Asia/Dhaka). Net = gross − refunds. "Rising" needs
  3+ units, +50%, and sales in the prior period. Regional lift needs 10+ items. Figures from fewer than 10 orders are
  flagged. Unmatched addresses are listed, never guessed.
- **Journeys and privacy:** no raw IP stored, Do Not Track / GPC visitors not tracked, 180-day retention, and an
  Account toggle that turns personalisation off and deletes the profile. Pip gets the profile as a quiet hint and
  never mentions it. Pip never asks age, income, religion or location.
- **Staff RBAC:** permissions are `<area>.read/write`. Routes use `@Staff('area')` (GET needs read, other methods
  need write). The admin UI hides or locks via `can()`, `v-can` and route `meta.area`. Only Admin manages staff;
  Support can't refund; Merchandiser can't see customers or payments; Analyst is read-only. **Change roles only in `common/permissions.ts`.**

---

## 10. Storefront map (`storefront/src/`)

- `api.js` fetch wrapper · `auth.js` · `catalog.js` (live catalog) · `store.js` (cart, checkout, orders, favourites, reviews, requests, team)
- `agent/useAgent.js` (Pip chat and voice; falls back to the in-browser `agent/brain.js` if the AI service is down), `agent/languages.js`, `agent/recorder.js`
- `components/agent/` (AgentWidget, AgentStage, Mascot, AgentProducts, VoiceNotice): the Pip UI. Card "Add" and
  "Try on" buttons act in the browser and only send Pip an event note, which saves Claude calls.
- `tryon/` (useTryOn, pose, fit, cutout, photoCheck, `specs.js` with `PREVIEW_SLOTS`) and `components/tryon/`
- `journey.js` / `track.js`: visitor journeys and demand events
- Research-backed features (2026-11-05, see §18): `prefs.js` (saved sizes, `suggestSize`), `looks.js` + `components/ShareLook.vue`
  (Ask family), `style.js` (style quiz), `festival.js` (order-by dates), `support.js` + `components/agent/HandoffCard.vue`,
  `components/agent/CompareCard.vue`, `components/StampCard.vue`
- Routes: `/`, `shop`, `popular`, `category/:slug`, `collection/:slug`, `product/:id`, `inspiration[/:slug]`,
  `favourites`, `cart`, `checkout`, `orders[/:id]`, `request`, `team`, `account`, `looks` (Family votes), `style` (quiz),
  `festival` (family outfit planner), `promise`, `/look/:token` (public voting page, no shop chrome), `/login`, `/signup`
- Design tokens are on `:root` in `style.css` (`--ink`, `--blue #1f5bff`, `--mint`, `--butter`, large radii `--r-shell 44px`, `--r-card 32px`).

## 11. Admin map (`admin/src/`)

Views: Dashboard, Orders/Order, Products/ProductEdit (with `TryOnPanel`, `PipDetails`), Customers/Customer
(profile card and `VisitTimeline`), Reviews, Promos, Returns/Return, Analytics (tabs including *Visitors & journeys*),
Delivery, Payments, Requests, Content/StoryEdit, Team (roles and audit), System (health, reindex, AI spend today),
Rider (`/rider`), SetPassword (forced change for temporary passwords). RBAC helpers: `can.js`, `roles.js`.
Reviews show fit details, photos and "Verified purchase"; Returns has the **Support contact** form (Pip's hand-off);
Promotions has the **Stamp card** switch (off by default).

---

## 12. Decisions the owner has made (treat as locked)

| Date | Decision |
|---|---|
| 2026-09-29 | AI vendors: **Claude** (brain), **FASHN Try-On Max** (try-on), **ElevenLabs** (voice). |
| 2026-09-30 | Repo split into storefront / admin / backend. API on port 4100. |
| 2026-09-30 | Keep **USD prices plus an admin-set USD→BDT rate**. Rocket and cards via **SSLCommerz**. Gateway credentials entered in the admin panel, encrypted. Real credentials will be added later, so everything ships in sandbox. |
| 2026-09-30 | **AI try-on becomes the main try-on for clothing, but only after a paid quality test** (`cd backend/ai && .venv/bin/python -m scripts.tryon_eval --yes`, ~$14). The quick preview is **accessories only**. |
| 2026-09-30 | Test accounts and test kit are wanted for testing, and must be removed before production (`TESTING.md`). |
| 2026-10-06 | **Pip is catalog-only.** Web trend lookup and web search were removed. "Trending" means Cartly's own popular and new products. **Don't re-add outside or web content to Pip without asking.** |
| 2026-10-08 | Cut AI spend as much as possible while keeping quality (led to the gate, quotas, caches, shorter replies). |
| 2026-10-15 | **Launch stack: Claude Haiku 5.5 for Pip and the admin AI, ElevenLabs for all voice.** OpenRouter (free NVIDIA models) was only a trial: Bangla was poor on most of them. Don't judge Pip's Bangla by those models. |
| 2026-10-15 | Bangla and Banglish must work well, because the core users are Bangladeshi. |

## 13. Defaults chosen by previous AI sessions, NOT confirmed by the owner

Flag these whenever related work comes up; don't present them as settled:
- `PIP_GATE=enforce` in all 8 template languages. The templates still need a native-speaker review.
- Quotas 200/80/1000, the reply cache on, the hands-free voice pause rules, and always asking the colour on multi-colour card adds.
- `TRYON_MODE=balanced` (vs `fast`, half the cost), `TRYON_HOURLY_LIMIT=30` (10 is probably enough).
- Daily budget caps are all 0, meaning off. They must be set before launch (suggested $300 / $100 / $50).
- The staff role → permission matrix.
- Return window 7 days, delivery not refunded.
- Privacy choices (retention 180 days, DNT/GPC handling). A UK/EU consent banner is **not** built.
- Shipping prices in the seed catalog.
- 2026-11-05 features (§18): fit verdict thresholds (3+ signals; ≥50% one way with 2+ votes, ≥60% true to size); shared
  looks live 7 days with up to 40 voters; order-by dates assume Friday off, one packing day and arrival the day before;
  the quiz keeps up to 3 styles; the stamp card defaults (off, 10 orders, 2-stamp head start, 10% off); no support
  contact set, so Pip offers no person until one is entered.

## 14. Status, gaps and launch blockers (as of 2026-11-05)

**Built and tested against local stand-ins:** payments, delivery, returns, analytics, journeys and profiles, RBAC, the Pip cost controls, and try-on plumbing.

**Not verified against real services:**
- **Pip on Haiku 5.5 has never run live**, because no `ANTHROPIC_API_KEY` has been added. Its Bangla/Banglish quality is unmeasured.
  Run `scripts.pip_model_eval --yes` (~$1.40–4) and `scripts.pip_cache_probe --yes` (~$0.10) once a key exists.
- The FASHN paid quality test hasn't been run (it needs the owner's key). The FASHN DPA and the consent copy haven't been reviewed.
- Payments: bKash, Rocket and card reached their real sandbox pages. **Nagad's sandbox rejects the sample kit**
  ("Failed to verify signature"), so Nagad is switched off until the owner adds their own sandbox keys.
- Couriers: one real Pathao sandbox booking succeeded. **Steadfast has no sandbox** (it books only in live mode).
  **RedX** needs the owner's sandbox token. The Pathao webhook integration-header value is uncertain.

**Known gaps:**
- Uploads live on local disk (`UPLOAD_DIR`). They must move to S3 or R2 before running more than one API instance.
- No email sending (order confirmations, password resets, staff invites). Temporary passwords are shown once.
- A disabled customer's existing token still works on most routes until it expires (`JwtAuthGuard` doesn't hit the DB).
- The forced password change is enforced only in the admin panel, not the storefront.
- LiveKit real-time voice isn't wired. Voice today is turn-based.
- City-level location needs CDN headers or a `GEOIP_DB` file in production.
- Launch checklist: `backend/SCALING.md` → "Before launch" (`TRUST_PROXY`, a separate LRU cache Redis, the AI
  service on a private network, Anthropic rate limits, a load test) and `TESTING.md` → "Before going live".

**Cost reference** (estimates, not measured): at 1,000 visits/day, about **$587/month** with balanced try-on, or
about $384 with fast. Try-on is ~69% of that bill; Pip on Haiku is about $13/month and voice about $78. The Bangladesh
payment and courier rates used were found online and are unofficial.

**Stale docs to be aware of:**
- `storefront/README.md` still says Pip "can also look up live fashion trends". That feature was removed on 2026-10-06.
- `backend/README.md` → "Not included yet" says "Real payments". The BD gateways are built; only Stripe and emails are missing.
- `backend/SCALING.md` decision 2 talks about moving from Opus to Sonnet. The default is now Haiku 5.5.

## 15. Rules for working on this codebase

1. **Ask before anything that spends money:** paid evals, live gateway or courier calls, try-on renders.
2. **Gate precision rule:** the relevance gate must never decline on topic words, only on task or structure shapes
   with no shopping signal. `tests/data/relevance_cases.json` must stay at **zero** false declines on
   shop/support/followup/borderline/smalltalk cases. A wrong block is worse than a missed off-topic, because Claude declines the rest anyway.
3. **Guest strikes are per chat, never per network** (mobile CGNAT shares IPs). The network hash only counts the daily quota.
4. Keep Pip to **one Claude call per turn**, short replies and catalog-only answers. Validate every id and action the model returns.
5. Keep every AI feature **optional with a fallback**. Browsing, cart and checkout must never depend on Pip.
6. RBAC changes go **only** in `backend/api/src/common/permissions.ts`.
7. Ports change only in `backend/.env` (API/AI) and the two `vite.config.js` files (frontends).
8. The API is ESM TypeScript: local imports end in `.js`. Don't edit `src/generated/prisma/`; run `prisma generate` instead.
9. The AI service must not write Prisma (`public`) tables.
10. Speed matters to the owner: tracking-style endpoints must stay O(1) on the request path (queue in Redis, batch in a worker).
11. Run the relevant tests after changes (`npm run test:e2e`, `pytest -q`) and report failures honestly.
12. Commit only when asked. Each of the three folders is its own repo with its own history.

## 16. Where to read more

| File | What's in it |
|---|---|
| `README.md` (root) | Workspace and `dev.sh` |
| `TESTING.md` (root) | Test accounts, sandbox payment details, a manual test checklist, the pre-launch removal checklist |
| `backend/README.md` | Full API reference, business rules, payments, delivery, returns, analytics, journeys, try-on |
| `backend/ai/README.md` | AI endpoints, the reply schema, how Pip's brain works, model eval scripts |
| `backend/SCALING.md` | Sizing for 10k concurrent shoppers, cost tables, **"Decisions for you"**, **"Before launch"** |
| `backend/PIP_COSTS.md` | Pip cost research, the relevance filter design and test results, rejected options |
| `backend/.env.example` | Every setting, with comments |
| `backend/api/prisma/schema.prisma` | The data model, with comments on enums |

## 17. Added on 2026-11-05 (uncommitted)

**Plug and play for judges (Docker).** The workspace `docker-compose.yml` runs postgres (pgvector pg16), redis, api, ai,
storefront and admin (each nginx, forwarding `/api`), mailpit and a `tools` profile. No configuration: the API
entrypoint (`backend/docker/`) generates JWT/internal/payment secrets into the `secrets` volume, runs
`prisma migrate deploy` on every start (automatic schema upgrades), and `scripts/first-run.ts` loads the demo store,
the test kit and the shipped accessory cut-outs (`catalog/cutouts/`) once per database (with `NODE_ENV=production` a
fresh database stays empty until a restore). `./cartly up | down | status | logs | backup | restore | import | export |
reset`. Optional settings in the workspace `.env.example` (ports `CARTLY_*_PORT`, AI keys, SMTP, Meta). Ports: store
5173, admin 5174, API docs 127.0.0.1:4100, Mailpit 127.0.0.1:8025. `./dev.sh` (no Docker) also installs changed
packages, migrates and runs first-run. Fixed on the way: `anthropic` and `python-multipart` were missing from
`backend/ai/requirements.txt`. On this Mac (exFAT drive) macOS `._*` files break Docker builds; `./cartly` removes them.

**Data.** `backend/scripts/store-data.sh backup [--with-secrets] | restore | inspect`: database (public schema), uploads
and the AI meter in one `.tar.gz`; restore refuses backups from a newer schema, rewrites photo URLs to the new
`API_PUBLIC_URL`, clears carts and caches. Product import/export as CSV (Cartly columns, Shopify and WooCommerce exports)
in Admin → Products and `npm run catalog:import|catalog:export` (`api/src/admin/import-csv.ts`, `import.ts`).

**Likeness, wants, emails** (user's requirements, all options I recommended were chosen): see backend README "Shopper
likeness, wants and outreach emails". New tables `ShopperPreferences`, `ShopperWant`, `Outreach`;
`ShopperProfile.colors`. Permission area `marketing`. Defaults that are mine, not the owner's: opt-in off by default,
cap 1 email per 3 days, every kind manual until switched to automatic, found-it threshold 0.28 plus word and colour
match, groups under 5 hidden in colouring analytics, photo estimates tone only (undertone is the shopper's pick).

**Meta Model API, switchable** (owner: add all, keep today's vendors as default until a Meta key passes a Bangla
test): `AGENT_MODEL=muse-spark-1.3`, `TRYON_PROVIDER=meta`, `STT_PROVIDER=meta`, `CUTOUT_PROVIDER=meta`, `META_API_KEY`
(`backend/ai/app/meta.py`, `llm.py`). Built from Meta's API reference and not run live yet (no key). Facts found:
Muse Spark 1.3 ≈ 10× Haiku 5.5 per reply, Bangla undocumented, US-only preview (Bangladesh unconfirmed); Muse Image
$0.01 a render vs FASHN ~$0.15 (try-on quality untested); Voice Transcribe lists Bengali, $0.18/h, WAV only; SAM masks
need `meta-sam-parser` (SAM License, unread).

**Tests (2026-11-05):** API 45 unit + 122 e2e pass; AI 473 pass, 2 fail only on local demo-order data (CL-20931).
**Open question for the owner:** how judges get one repo (recommended: a fourth `cartly` repo with the three as
submodules, holding the workspace files).

## 18. Research-backed shopper features (built 2026-11-05)

Chosen by the owner from a research review ("a mix of impress and business impact"). Each source file's header cites
the finding behind it. All of it is tested (API unit + e2e, AI pytest) and was checked in a browser.

| Feature | Where | Why (finding) |
|---|---|---|
| Fit confidence: fit reviews (size bought, fit, height, usual size, photos), real star counts, "Verified purchase" only after delivery, "Runs small" verdict + "You wear M, so pick L", Pip says it | `api/src/catalog/fit.ts`, reviews in `catalog.module.ts`, returns recount, `ProductView.vue` | Fit flags cut size returns (Zalando, KDD 2021); fit reviews with body context cut returns (Wang et al., ISR) |
| Ask family: share a look (optionally the try-on photo) as a link; no-login vote page in English/Bangla; Family votes page; Pip sees the votes | `api/src/looks/`, `LookView.vue`, `LooksView.vue` | Others' opinions drive online shopping intent in Dhaka (SAGE Open 2023); shopping together raises social presence (ISR 2010) |
| Style quiz ("this or that"), saved as declared styles; recommendations explain with them | `/style`, `ShopperPreferences.styles`, `journeys/taste.ts` | Explanations from data the shopper gave build trust; inferred-data explanations backfire (JCR 2019) |
| Festival deadlines + family outfit planner | `api/src/festivals/`, AI `GET /culture/moments`, `/festival` | Real deadlines instead of countdown timers (no effect, JLA 2021) |
| Cartly Promise page (only true claims) | `/promise` | Dark patterns erode trust, most for newer online shoppers |
| Pip: "help me decide" compare cards; plain tone + hand-off to a person when upset | AI `brain/claude.py` (`compare`, `human`), rule brain `COMPLAINT`, `api/src/support/` | Choice overload when unsure (meta-analyses); human-like bots hurt with angry customers (J. Marketing 2022) |
| Stamp card with a head start, personal single-use reward codes (**off by default**) | `api/src/loyalty/`, `PromoCode.userId/singleUse`, `StampCard.vue` | Endowed progress and goal gradient (JCR 2006, JMR 2006) |

Known gaps: WhatsApp link previews need server-rendered Open Graph tags (the storefront is a SPA); the in-browser
fallback brain (`agent/brain.js`) has no fit or complaint answers; orphaned review photos (uploaded, never posted)
aren't swept; the generic clothing details still say "true-to-size fit" even when shoppers say a product runs small;
the seed catalog has no Bangladeshi festive wear (panjabi, saree, three-piece), which the planner would show off best.
