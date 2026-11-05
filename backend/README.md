# Cartly backend

Two services share one Postgres (with pgvector) and one Redis. Two browser apps use them:
the storefront ([cartly_storefront](https://github.com/fahadewu/cartly_storefront), :5173) and the admin panel
([cartly_admin](https://github.com/fahadewu/cartly_admin), :5174).

```
  Vue storefront ┌──────────────────────────────┐
  ──────────────▶│  api/  NestJS 12 · Prisma 7   │  products, cart, checkout, orders,
  Admin panel    │  :4100/api/v1   docs: /docs   │  accounts, reviews, team, requests,
  ──────────────▶│                               │  /admin/* (admins only)
     (REST)      └──────┬──────────────┬─────────┘
                        │              │ gateway (/assistant/*) + semantic search
                        │              ▼
                        │     ┌───────────────────────────┐
                        │     │  ai/  FastAPI · Python    │  Pip agent, live suggestions,
                        │     │  :8001                    │  semantic search, voice token
                        │     └──────┬────────────────────┘
                        ▼            ▼
              ┌───────────────────────────────┐   ┌─────────────────────────────┐
              │ PostgreSQL 15+  (public: Prisma│   │ Redis                        │
              │ tables · ai: pgvector index)   │   │ carts · agent sessions ·     │
              └───────────────────────────────┘   │ rate limits · usage meter ·  │
                                                  │ caches (or CACHE_REDIS_URL)  │
                                                  └─────────────────────────────┘
```

| Layer | Choice | Why |
|---|---|---|
| Commerce API | **NestJS 12** (TypeScript, ESM) + **Prisma 7** | Same language as the Vue app; structured modules, validation, Swagger |
| AI & voice | **FastAPI** (Python) | Async, native WebSockets, easy to plug LLMs / PyTorch later |
| Search | **pgvector** in Postgres | Semantic search with no extra vendor; `ai` schema keeps it apart from Prisma |
| State | **Redis** | Carts, agent session memory, rate limiting, caching, pub/sub |
| Voice | Browser speech → Pip through the API, **LiveKit** token endpoint ready | Works today with no keys; add LiveKit keys for real-time WebRTC voice |

Every AI feature is optional and switches on with one key; without it the store keeps working with a fallback:

| Feature | With a key | Without |
|---|---|---|
| Pip's brain | **Claude** (`ANTHROPIC_API_KEY`): any language in, the same language out; knows the shopper's season and upcoming festivals; talks only about Cartly's catalog | English rule brain |
| Virtual try-on | **FASHN Try-On Max** (`FASHN_API_KEY`): the shopper's photo is re-rendered wearing the look | On-device quick preview of accessories only (cut-outs placed from body landmarks); clothes and shoes need the AI try-on |
| Voice | **ElevenLabs** (`ELEVENLABS_API_KEY`): speech-to-text that detects the language, and one Pip voice that speaks it back | Browser speech recognition (in the language picked or last used) and the device's voices |
| Photo review | Claude vision, on top of the pixel checks | Pixel checks only |

Each can also run on **Meta Model API** instead (`META_API_KEY`, one switch per job; defaults unchanged): Muse Spark as
`AGENT_MODEL`/`ADMIN_AI_MODEL` (`muse-spark-1.3`), `TRYON_PROVIDER=meta` (Muse Image), `STT_PROVIDER=meta` (Muse Voice
Transcribe, WAV recorded by the storefront) and `CUTOUT_PROVIDER=meta` (SAM 3.1). See `ai/README.md`.

`GET /assistant/capabilities` tells the storefront which are on. Every paid AI call is metered, each vendor can
have a daily cap, and the admin System page shows today's spend. For production sizing and the cost plan at
10,000 concurrent shoppers, see [SCALING.md](SCALING.md).

## Folder layout

```
backend/
  .env / .env.example     shared config for both services
  catalog/catalog.json    seed data: products, categories, collections, stories, promo codes, delivery rules
  catalog/cutouts/        the seeded accessories' quick-preview cut-outs (installed on first start: no model download)
  api/                    NestJS commerce API (see modules below)
    prisma/schema.prisma  data model · prisma/seed.ts · prisma/migrations/
    src/{auth,catalog,cart,account,assistant,admin,common}/
    test/*.e2e-spec.ts    end-to-end tests against real Postgres + Redis
  ai/                     FastAPI AI & voice service (see ai/README.md)
  docker/                 container entrypoints (secrets, migrations, first run) and the tools image
  scripts/store-data.sh   backup / restore of a whole store (database, photos, AI meter)
```

The Dockerfiles (`api/Dockerfile`, `ai/Dockerfile`) build from this folder; the workspace's `docker-compose.yml`
runs them with Postgres, Redis, the storefront and the admin panel (see the workspace README).

## Run locally

Prerequisites: Node 22+, Python 3.12+, PostgreSQL 15+ with the **pgvector** extension, Redis.

```bash
cp .env.example .env            # set DATABASE_URL (with a username), JWT_SECRET, INTERNAL_API_KEY
createdb cartly

# Commerce API
cd api
npm install                      # also generates the Prisma client
npm run db:deploy                # apply migrations
npm run db:seed                  # catalog, demo shopper, admin, 12 sample shoppers with ~90 days of orders
npm run start:dev                # http://localhost:4100/api/v1 · Swagger at http://localhost:4100/docs

# AI service (another terminal)
cd ../ai
./run.sh                         # creates/uses .venv, serves http://localhost:8001
```

Ports come from `.env`: `API_PORT` (4100, kept off 3000 because Next.js and most Node servers take it) and `AI_PORT` (8001); the storefront and admin panel read `API_PORT` for their `/api` proxy. Both services refuse to start if anything already listens on their port, IPv4 or IPv6, since macOS would otherwise let two servers share it and `localhost` would reach the wrong one. With the three repos checked out side by side, `../dev.sh` in the workspace starts all four apps in one terminal.

Storefront login: **demo@cartly.dev / Demo1234!** · Admin panel: **admin@cartly.dev / Admin1234!** · Promo codes: **WELCOME20** (20%), **CARTLY10** (10%) · Test card: **4242 4242 4242 4242**.

The seed is safe to re-run: it adds anything missing and never overwrites what admins changed. `npm run db:seed -- --reset-catalog` also resets products, content and promo codes to `catalog.json`.

With Docker instead (nothing to install but Docker): `docker compose up --build` in the workspace. The API
container generates its secrets, applies migrations and, on an empty database, runs `scripts/first-run.ts`: the
seed, the test kit (not with `NODE_ENV=production`) and the shipped cut-outs. `npm run` scripts in a running container
need those secrets: `docker compose exec api sh /app/docker/with-secrets.sh npm run <script>`.

## Data: import, export, backup

- `npm run catalog:import -- products.csv [--apply] [--type=… --category=… --gender=…]`: products from Cartly's own
  CSV columns, a Shopify product export or a WooCommerce product export (`src/admin/import-csv.ts`). Without
  `--apply` it only reports, row by row. Empty cells leave a product's existing value alone, so `slug,price,stock`
  updates prices and stock in bulk. Products missing Pip's details come in hidden. The admin panel does the same
  (`POST /admin/catalog/import`, multipart `file`, `apply=true` to save).
- `npm run -s catalog:export > products.csv` (`--template` for the columns and an example row), or
  `GET /admin/catalog/export[?template=true]`.
- `scripts/store-data.sh backup [--with-secrets] | restore <file> [--yes] | inspect <file>`: the database (schema
  `public`; the AI service rebuilds `ai`), `uploads/` and the AI spend meter in one `.tar.gz`. Restore checks the
  backup isn't from a newer schema, moves photo addresses to this install's `API_PUBLIC_URL`, and clears carts and
  caches tied to the old accounts. Stop the API and AI service first; with Docker, `./cartly backup` / `restore` do
  all of it.

## Commerce API (`/api/v1`)

| Area | Endpoints |
|---|---|
| Health | `GET /health` (database, Redis, AI service) |
| Auth | `POST /auth/signup` · `POST /auth/login` · `GET/PATCH /auth/me` · `POST /auth/change-password` |
| Catalog | `GET /catalog` (storefront bootstrap: every live product, categories, collections, stories, delivery rules) · `GET /products` (q, category, collection, type, gender, minPrice, maxPrice, sizes, colors, sale, isNew, tryOn, sort, page, limit) · `GET /products/search?q=` (semantic, falls back to keywords) · `GET /products/:idOrSlug` · `GET /products/:id/related` · `GET/POST /products/:id/reviews` · `GET /categories[/:slug]` · `GET /collections[/:slug]` · `GET /stories[/:slug]` |
| Cart (Redis) | `GET /cart?delivery=` · `POST /cart/items` · `PATCH/DELETE /cart/items/:key` · `DELETE /cart` · `POST/DELETE /cart/promo` |
| Orders | `POST /orders` (checkout from cart) · `GET /orders?status=` · `GET /orders/:id` (with `shipment`: the latest delivery's status, timeline, courier tracking code and link, and for a store rider their name, phone and the 4-digit delivery code) · `POST /orders/:id/reorder` · `POST /orders/:id/cancel` |
| Rider app (riders only) | `GET /rider` (their parcels, this week's finished ones, cash to hand in) · `POST /rider/shipments/:id/status` (`PICKED_UP`, `OUT_FOR_DELIVERY`, `DELIVERED` with the customer's `code` and `collected` cash, `FAILED_ATTEMPT` with a `note`, `RETURNING`, `RETURNED`) |
| Courier webhooks | `POST /delivery/webhooks/pathao\|steadfast\|redx` (each courier's own authentication) |
| Account | `GET/PUT/DELETE /me/favourites/:productId` · `GET/POST /me/requests` · `GET/POST /team` · `PATCH/DELETE /team/:id` |
| Assistant | `GET /assistant/capabilities` · `POST /assistant/chat` (proxies to the AI service with the signed-in user; `kind: "greet"` for an opening line; `context` carries locale, time zone, language and try-on state) · `POST /assistant/transcribe` (multipart `audio`, signed in) → `{text, lang, confidence}` · `POST /assistant/speak` (`{text, lang}`, signed in) → MP3 · `POST /assistant/voice-token` |
| Try-on | `POST /tryon/render` (signed in; multipart `photo` + `consent=true`, or `sample=0–3`; `productIds`, optional `notes` per product and `seed`) → `{image, steps, rendered, cached}`. The photo is re-encoded with its EXIF (location, camera) stripped before it leaves the API. |
| Reviews (fit, photos) | `POST /products/:id/reviews` also takes `size`, `fit` (`small`/`true`/`large`), `heightCm`, `usualSize` and up to 3 `photos` from `POST /reviews/photos` (signed in, multipart `file`, EXIF stripped, 10/min). `verified` is set only when the reviewer had the product delivered. Products carry `fitFeedback` (`{verdict, small, true, large, total, returns}`) and the product detail `ratingCounts` (real 5→1 star counts). |
| Ask family | `POST /looks` (guest or signed in; `items` 1–6, `note`, `name`) → `{token, ownerKey, expiresAt}` · `POST /looks/:token/image` (owner: account or `x-look-key`; multipart `file`) · `GET /looks/:token` (public: look + votes) · `GET /looks/:token/image` · `POST /looks/:token/votes` (public; `voterId` uuid, `reaction` love/yes/unsure/no, `tags`, `name`, `comment`; one vote per voter, changeable) · `GET /looks/mine` (signed in) · `DELETE /looks/:token` (owner). Everything lives in Redis for 7 days. |
| Festivals | `GET /festivals?tz=&locale=` → the shopper's own festivals in the next 75 days with `orderBy.{standard,express}`: the last day to order for delivery the day before (posted ETA max + 1 packing day, Fridays skipped). Empty when the AI service is down. |
| Support, stamps | `GET /support` (public: the WhatsApp/phone/hours Pip hands upset shoppers to) · `GET /me/stamps` (the stamp card, issuing earned reward codes; `{enabled:false}` while it's off) · `PUT /me/preferences` also takes `styles` (style quiz picks, personality keys from `journeys/taste.ts`). |

### Admin API (`/api/v1/admin`, admins only)

| Area | Endpoints |
|---|---|
| Dashboard | `GET /stats?days=7\|30\|90` (revenue, orders, AOV and new customers vs the previous period, daily series, top products, recent orders, low stock, open requests) · `GET /system` (service health, store settings) · `POST /system/reindex` |
| Products | `GET /products` (q, category, status=all\|active\|archived, stock=in\|low\|out, sort, page, limit; with tab counts and units sold) · `GET/PATCH/DELETE /products/:id` · `POST /products` |
| Orders | `GET /orders` (status, q = id/name/email, page; with tab counts) · `GET /orders/:id` (customer stats, allowed next statuses) · `PATCH /orders/:id/status` |
| Customers | `GET /users` (q, role, sort) · `GET /users/:id` (orders, spend, favourites, reviews, requests) · `PATCH /users/:id` (role) |
| Delivery | `GET /delivery/shipments` (status incl. `ACTIVE` and `ATTENTION`, carrier, rider, q, page) · `GET /delivery/shipments/:id` · `POST /delivery/orders/:id/ship` (`carrier`: `rider` + `riderId`, or `pathao`/`steadfast`/`redx` + `location`) · `POST /delivery/shipments/:id/sync\|cancel\|reassign\|status` · `GET/POST /delivery/riders` · `PATCH /delivery/riders/:id` · `POST /delivery/riders/:id/settle` (cash handed in) · `GET /delivery/couriers` · `PUT /delivery/couriers/:id` · `POST /delivery/couriers/:id/test` · `GET /delivery/couriers/:id/locations?level=&parent=` · `GET /delivery/options` |
| Promotions | `GET/POST /promos` (with uses, discount given, revenue) · `PATCH/DELETE /promos/:code` |
| Moderation | `GET /reviews` (q, rating, productId, source=customer) · `DELETE /reviews/:id` · `GET /requests` · `PATCH /requests/:id` |
| Content | `GET/PATCH /categories[/:slug]` · `GET/POST/PATCH/DELETE /collections[/:slug]` · `GET/POST/PATCH/DELETE /stories[/:slug]` |
| Try-on photos | `GET /try-on/status` · `POST /try-on/photo` (multipart `file` + `slot`, `name`, `colors`: re-encoded, metadata stripped, saved under `uploads/`, then quality-checked) → `{url, width, height, check}` · `POST /try-on/check` (`{url, slot}`) · `POST /try-on/preview` (`{productId}` or `{image, slot}`, `sample`) → the product on a sample model · `POST /try-on/cutout` (`{productId}`) → `{url}`: remakes an accessory's quick-preview cut-out now |

Admin rules: the role is re-read from the database on every admin request, so removing someone's admin access applies immediately (not when their token expires), and nobody can change their own role. Archived products disappear from the storefront, carts, search and Pip but stay in past orders; products that were ever ordered can be archived but not deleted. Orders move PROCESSING → SHIPPED → DELIVERED, and PROCESSING or SHIPPED → CANCELLED, which puts the items back in stock; status changes are conditional updates, so two people (or an admin and the shopper cancelling) can't both win. Paused promo codes stop applying to carts straight away. After any product change the API asks the AI service to reload its catalog and rebuild the search index.

Business rules match the storefront: free standard delivery over $100 (after discounts), express $15, promo codes from the database, stock checked and decremented inside the checkout transaction, cancellation only before shipping (restocks), card validated with a Luhn check and **only the last 4 digits stored** (payment is simulated). Rate limiting is Redis-backed (120 req/min, 10/min on auth endpoints).

```bash
cd api && npm test                          # unit tests: shopper profiles, CSV import parsing
cd api && npm run test:e2e                  # 106 end-to-end tests: storefront, admin, payments, delivery, returns, journeys, team, import (needs the seeded local DB + Redis)
cd ai && .venv/bin/python -m pytest -q      # 466 tests: parsing, agent, search, API, WebSocket, auth, Claude brain, relevance check (1,501 labelled messages), templates, limits, culture, try-on, photo checks, eval scripts
```

### Security between the services

- The browser only needs the API's access token. `POST /assistant/chat` goes through the API, which attaches the verified user.
- The AI service trusts a `user_id` only with the shared `X-Internal-Key` (server-to-server). The WebSocket (off unless `AGENT_WS_ENABLED=true`; the storefront doesn't use it) takes the user's API token and verifies it with the shared `JWT_SECRET`. Anything else is treated as a guest with no cart or order access.
- Minting voice tokens and rebuilding the search index are internal-key only.

## AI service (`:8001`)

See `ai/README.md` for details. Main endpoints: `GET /health`, `GET /capabilities`, `GET /search?q=` (pgvector + filters), `POST /agent/chat`, `GET /agent/preview?q=` (live suggestions), `WS /agent/ws` (off unless `AGENT_WS_ENABLED=true`), and internal-key only: `POST /tryon/render`, `POST /tryon/check`, `POST /speech/transcribe`, `POST /speech/speak`, `POST /voice/token`, `POST /index/rebuild`, `GET /usage`.

WebSocket protocol (`/agent/ws?session_id=&token=<API access token>`, only with `AGENT_WS_ENABLED=true`: it has no gateway throttle in front of it). On connect the server sends `{ "type": "session", "session_id": "..." }`.

```jsonc
// client → server
{ "type": "partial", "text": "red sneak" }                 // interim speech transcript
{ "type": "message", "text": "red sneakers under $100", "context": { "tryOn": { "hasPhoto": false, "on": [] } } }
{ "type": "ping" }
// server → client
{ "type": "suggestions", "products": [11], "text": "red sneak" }
{ "type": "status", "status": "thinking" }
{ "type": "reply", "text": "...", "products": [11], "actions": [], "chips": [], "mood": "happy", "session_id": "..." }
```

## Payments

Checkout offers what's switched on in the admin panel (Payments → Settings): **bKash** (Tokenized Checkout v2),
**Nagad** (encrypted, signed merchant API), **Rocket** and **cards** through **SSLCommerz**, **cash on delivery**, and a
dev-only demo card. Prices stay in dollars; checkout charges taka at the rate set on that page, fixed on each order.

- Credentials are pasted into the admin panel, encrypted with `PAYMENT_SECRETS_KEY` (AES-256-GCM) and never shown
  again. Each gateway starts in sandbox mode; "Test connection" checks the keys without moving money.
- An online order waits as *awaiting payment* with its stock held. It's marked paid only after the gateway confirms it
  server-side (bKash execute/query, Nagad verify, SSLCommerz validation; the SSLCommerz IPN is signature-checked too),
  and each payment settles once however many callbacks arrive. A failed or cancelled payment leaves the order open
  to pay again or switch to cash on delivery; unpaid orders are cancelled after `PAYMENT_TIMEOUT_MINUTES`.
- Refunds go through bKash and SSLCommerz from the order page; Nagad has no public refund API, so refund in its
  portal and record it. Cancelled-after-paying orders show as *refund due*.
- Live checklist: register the callback URL with Nagad (and whitelist the server IP), set the IPN URL in SSLCommerz,
  set `API_PUBLIC_URL` and `STOREFRONT_URL`, then switch each gateway to live.
- Tests: `test/payments.e2e-spec.ts` runs every flow against local stand-ins of the three gateways.

## Delivery

An order is sent out from its admin page: to one of the store's **own riders**, or booked with **Pathao**,
**Steadfast** or **RedX** (the three couriers most Bangladeshi shops use). Each trip is a `Shipment` with a timeline;
a returned or cancelled one can be followed by another (`CL-1234567-2`).

- **Riders** are user accounts with the `RIDER` role, created in Admin → Delivery → Riders. They sign in on the admin
  panel's login page and only get the rider app (`/rider`, made for a phone): their parcels, a call and map button,
  what cash to collect, and the next step. Delivery needs the 4-digit code the customer sees on their order page. The
  cash they collect counts as *held* until an admin records it as handed in.
- **Couriers** are set up like payment gateways: credentials encrypted with `PAYMENT_SECRETS_KEY`, sandbox or live, and
  *Test connection*. Pathao (OAuth, token cached in Redis; city/zone/area optional) and RedX (area list; cancel API)
  have sandboxes. **Steadfast has none**, so it books only in live mode. Each courier's statuses are mapped onto ours
  (booked, picked up, in transit, out for delivery, delivered, attempt failed, returning, returned, cancelled) and its
  own wording is kept too.
- Updates arrive by webhook (Pathao: `X-PATHAO-Signature` and the integration handshake answered with 202; Steadfast:
  a bearer token; RedX: `?token=` on the URL). A sweep every 5 minutes also asks the courier about any parcel it
  hasn't heard from in 30 minutes, so a missed webhook only delays an update.
- The order follows its parcel: *shipped* once picked up, *delivered* on delivery, and cash on delivery becomes *paid*
  when the collected amount covers it. A short collection is flagged. While a delivery is on its way, the shopper
  can't cancel and the admin's manual status buttons are replaced by the delivery's own actions (cancel, hand to
  another rider, set status).
- Tests: `test/delivery.e2e-spec.ts` covers riders and all three couriers against local stand-ins of their APIs.

## Returns

A delivered order can be returned from the shopper's order page within the return window (Admin → Returns,
7 days after delivery by default; 0 switches returns off). The shopper picks the items and quantities and a reason;
the refund is the items' price less their share of the order's promo discount (delivery isn't refunded), in taka at
the order's own rate. The store approves or turns it down (with a reason the shopper sees), sends one of its riders
to collect it (a *return pickup* in the rider app, which never touches the order's own status or the rider's cash),
inspects it (each item back into stock or written off), then refunds: through bKash/SSLCommerz for orders paid
online, or recorded as sent by hand (bKash/Nagad transfer, cash) with its reference.
Endpoints: `GET/POST /orders/:id/returns`, `POST /returns/:id/cancel`; admin `GET /admin/returns`,
`GET/PATCH /admin/returns/settings`, `GET /admin/returns/:id`, `POST /admin/returns/:id/approve|reject|pickup|receive|refund`.

## Analytics

Admin → Analytics, for the last 7, 30, 90 days or 12 months against the period before
(`GET /admin/analytics/sales|demand|customers|regions|returns|delivery|ai-costs?days=`):

- **Sales**: gross and net (after refunds), orders, average order, items per order, new vs returning buyers,
  conversion, cancellations, payment mix, promo codes, net sales by day, and a weekday × hour heatmap.
- **Products & demand**: best sellers with views, viewers who went on to buy, cart adds, returns and days of stock
  left; rising products; running out; demand lost to sold-out items; top searches and searches that found nothing;
  most viewed and viewed-but-not-bought; sales by category, type, colour, size, style, occasion, gender, material,
  fit; product requests.
- **Customers**: segments by recency and frequency (champions, loyal, promising, new, at risk, lapsed), monthly
  cohorts, lifetime value, time between orders, top customers.
- **Regions & trends**: countries and Bangladesh's divisions (or cities and districts): sales, share, average
  order, cash-on-delivery share, return rate, delivery time; what each region buys most, its *lift* against the
  whole store, and what's rising; searches by region; units per category per month.
- **Returns**, **Delivery** (success rate, failed attempts, delivery times and charges by courier; riders; regions),
  and **AI costs** (the AI service's meter: spend by day, service and feature, per order and as a share of sales,
  this month and its projection, tokens and cache use, daily caps).

How it's counted, so the numbers can be trusted:
- Days are in the store's time zone (`STORE_TIMEZONE`, Asia/Dhaka by default); the dashboard uses the same days.
- A sale is an order that isn't cancelled or still waiting for online payment. Net = gross − refunds made in the period.
  Refunds are paid in taka and converted back at their own order's rate, counted once: gateway refunds from the
  payment's log, returns refunded by hand from the return.
- Views, searches, cart adds, favourites and try-ons are recorded in `DemandEvent` (views and searches from the
  storefront, the rest on the server). A repeat view within 30 minutes or the same search within 10 minutes counts
  once, unknown products are dropped, and a deleted account takes its events with it. Anything that needs them
  says when tracking started.
- Addresses are matched to Bangladesh's 64 districts and 8 divisions, with old spellings, Bangla names and city
  neighbourhoods (`src/analytics/regions.ts`); unmatched ones are listed, never guessed.
- "Rising" needs 3+ units and 50% more than the period before, and only when that period had sales. Lift needs a
  region to have bought 10+ items. Figures from fewer than 10 orders are flagged.

## Visitor journeys and shopper profiles

Code: `api/src/journeys/` (storefront side: `storefront/src/journey.js`).

- **Journeys.** The storefront sends page changes to `POST /track` (signed in or not): the page, time it was
  actually on screen (hidden tabs and 5+ idle minutes don't count), scroll depth, and for a new visit where it came
  from (referring site, `utm_*`), landing page, time zone and language. The API adds the device and an approximate
  location (CDN headers `CF-IPCountry`/`CF-IPCity`, Vercel or CloudFront ones, else a GeoLite2 file at `GEOIP_DB`,
  else the device's time zone, country only). The IP itself is never stored. Admin → Analytics → *Visitors &
  journeys* shows sources, landing and exit pages, time on page, paths through the store, devices, locations and
  each visit step by step; a customer's page shows their visits.
- **Fast by design.** `/track` only appends to a Redis list (~0.6 ms); a worker on every API instance writes
  batches of 1000 with set-based SQL every 2 s (~10k batches/s locally). Visitors with Do Not Track or Global
  Privacy Control on aren't tracked. Data older than `TRACK_RETENTION_DAYS` (180) is deleted.
- **Shopper profiles** (`taste.ts`, pure functions): from views, favourites, try-ons, cart adds and purchases over
  90 days (half-life 30 days), plus what Pip hears in chat ("I'm a student", "I love minimal stuff"): a shopping
  personality (minimalist, classic, trendsetter, romantic…), price comfort, shopping style (decisive, explorer,
  researcher, deal-seeker, tries-before-buying) and an **assumed** age group with a confidence. Rebuilt in the
  background (never during a request) and cached in Redis for Pip and `GET /me/recommendations`
  ("Picked for you" on Explore). Shoppers can switch it off under Account, which deletes what was learned.
- **Pip** gets the profile as a quiet hint (never mentioned to the shopper), declines off-topic requests sweetly,
  asks only questions it needs, and never asks age, income, religion or where someone lives.

## Shopper likeness, wants and outreach emails

Code: `api/src/journeys/likeness.ts` (pure scoring), `api/src/outreach/` (wants, matching, emails, admin views),
storefront `src/components/PreferencesCard.vue` and `src/tone.js`, admin `LikenessCard.vue`, `OutreachView.vue`,
`InterestsPanel.vue`.

- **What they told us** (`ShopperPreferences`, Account → preferences, `GET/PUT /me/preferences`,
  `DELETE /me/preferences/colouring`): usual sizes per type, fit, marketing-email opt-in (off by default, with the
  date it was turned on) and email language, and an optional colouring: a Monk Skin Tone swatch (1–10) and
  undertone. The shopper can let the storefront estimate the tone from a photo **on their device** (pose landmarks find
  the cheeks; the nearest Monk swatch in CIELAB); the photo never leaves the browser and only the tone they confirm is
  saved. Undertone is always their own pick. Pip sees sizes always and colouring only for "what suits me".
- **Likeness** (`likeness()`, 0–1 with parts and reasons): style tags (32%), category (14%), price fit (14%), colour
  (16%: families they choose, plus at most a quarter from colours that suit their colouring), size availability (12%,
  and ×0.4 when it isn't made in their size), popularity (12%, carrying new shoppers). Colour families come from each
  swatch's hex (`colourFamily`), learned per shopper in `ShopperProfile.colors`.
- **Wants** (`ShopperWant`): searches with no results, Pip chats where nothing fitted (Pip's reply field `wanted`),
  sold-out products they viewed, favourited or added, and product requests. They go through a Redis inbox
  (`outreach/inbox.ts`) so the requests stay fast; personalisation off deletes them with the profile.
- **Matching** (worker every minute, one instance at a time): a restock answers sold-out wants and favourites; a price
  drop answers favourites, bag adds and repeat views; a new or changed product answers search and chat wants when the
  semantic search scores it ≥ 0.28 in the top 3 **and** it shares a word with the want **and** has any colour the
  shopper named (`answers()`); hourly, bags left 24–72 h; daily, new arrivals scoring ≥ `minLikeness`.
- **Emails** (`Outreach`, Admin → Emails): only for opted-in shoppers, one waiting email per shopper (new products join
  it), never a product they were told about in 30 days, at most one sent every `capDays` (3). Each kind is a draft
  for staff until switched to automatic. English or Bangla, dollars and taka, a click link per product
  (`/o/c/:token`, counted, then on to the product with `utm_*`) and one-click unsubscribe (`/o/u/:token`, RFC 8058).
  The copy never mentions taste, age or colouring; the reasons are for staff. SMTP via `SMTP_URL`; in Docker the
  bundled Mailpit catches everything (http://localhost:8025).
- **Admin**: Customers → a shopper → *What they like* (style mix, categories, colours, 12 weeks of interest by style,
  what they told us, best matches with reasons, wants, emails); Analytics → *Interests & emails* (opt-ins, unmet wants
  worth sourcing, colour leanings, by undertone only for groups of 5+, and per-kind drafted / sent / clicked /
  ordered within 7 days). Permission area `marketing` (Admin, Manager, Merchandiser; Analyst read-only).

## Research-backed shopper features (2026-11-05)

Each one is grounded in a finding cited in its source file's header comment.

- **Fit confidence** (`src/catalog/fit.ts`): fit reviews (one vote per reviewer, their latest) plus returns sent back
  as too small/large give each product a verdict once 3+ signals agree (≥50% one way with 2+ votes, or ≥60% true to
  size). Shown on the product page with a personal pick from the shopper's saved size, and in Pip's catalog lines.
- **Ask family** (`src/looks/`): share a look for a no-login vote. Pip gets a one-line summary (`looksum:<userId>`).
- **Style quiz**: the storefront's `/style` saves picked styles on `ShopperPreferences.styles`; they feed the taste
  model as hints, and "Picked for you" says "Because you picked … in your style quiz".
- **Festival deadlines** (`src/festivals/`): real order-by dates instead of countdown timers.
- **Hand-off to a person** (`src/support/`): Admin → Returns → Support contact. Unset = Pip never offers a person.
- **Stamp card** (`src/loyalty/`): Admin → Promotions → Stamp card, **off by default**. Rewards are personal,
  single-use promo codes (`PromoCode.userId`, `singleUse`), checked again inside the checkout transaction.

## Product details for Pip

A product can't be saved without what Pip needs to recommend it: material, fit (clothing), occasions, seasons,
style tags and key features; other names shoppers search for (any language) are recommended. "Suggest with AI" in
the editor drafts them from the photo. Pip's prompt and search both use them. Existing databases: `npm run catalog:details`
(in api/) fills them in for the seeded products.

## Updating the catalog

The database is the source of truth: edit products, stock, collections, stories and promo codes in the admin panel ([cartly_admin](https://github.com/fahadewu/cartly_admin)). The storefront loads the live catalog from `GET /catalog` on start (and again when a tab has been in the background for a couple of minutes), and the AI service is re-indexed automatically after product changes. `catalog/catalog.json` is only the starting data for a fresh database.

## Good to know

- Semantic search uses a built-in, dependency-free embedder (hashing trick over words, bigrams and character trigrams, plus fashion synonyms) so it works offline with no model download. Rankings are sensible but it isn't a neural model. Set `EMBEDDINGS_PROVIDER=sentence-transformers` (after `pip install sentence-transformers`) for real embeddings; the 384-dimension index rebuilds automatically.
- The Docker setup was tested end to end on Colima (Apple Silicon): fresh install, first run, smoke tests through
  the storefront and admin proxies, backup → wipe → restore onto another port, and a `--with-secrets` round trip.

## Accurate try-on: the product photo matters

The AI copies the product from its try-on photo onto the shopper, so each product can have a dedicated
`tryOnImage` (falls back to `image`) plus `tryOnInfo` (`photoType`, a default `styling` prompt such as
"wear it open", and the last quality `check`). The admin editor shows a per-slot photo guide and checks every
photo before it's used:

- **Pixel checks** (always): JPG/PNG/WebP; at least 512 px on the short side for garments (400 px for accessories),
  1024/800 px or more recommended; portrait framing for garments; a plain background (judged from the corners,
  tolerating studio light fall-off; transparent PNGs count as plain); the item not cut off at the edges and not
  tiny in the frame; sharpness; exposure.
- **AI review** (with `ANTHROPIC_API_KEY`): is it this product, one item, fully visible, front view, not on a hanger,
  no watermark or props, not creased.

Errors mean the try-on will likely be wrong (the editor asks before saving); warnings mean it works but could be better.
Unsplash catalog photos are fetched at full size for checks and renders, not the 600 px storefront thumbnail.

Try-on renders chain one product at a time, innermost layer first (bottoms, dress, top, outerwear, shoes, then
accessories). Every step is cached in Redis for an hour per shopper, so adding an item costs one render and removing
the last costs none. `TRYON_HOURLY_LIMIT` caps renders per shopper. Photos go to FASHN as base64 (deleted when the
request finishes, never used for training) and come back as base64; nothing is written to disk. Each step's prompt
names the product ("only the Scarlet Wrap Dress"), so the model takes the right item from a styled photo.

**Before switching AI try-on on**, run the paid quality test and review its contact sheet: every wearable product on
two sample models, plus full looks at 1k, 2k and quality. It prints the plan and cost first and stops at `--budget`:

```bash
cd ai && .venv/bin/python -m scripts.tryon_eval          # the plan and its cost (about 181 credits, ~$14)
cd ai && .venv/bin/python -m scripts.tryon_eval --yes    # renders, then prints where its contact sheet is
```

### Quick preview cut-outs (accessories)

Without AI try-on, shoppers can preview glasses, hats, headphones, watches and bags: a transparent cut-out placed on
their photo from body landmarks, on-device. The API makes each cut-out with the AI service (`POST /tryon/cutout`,
BiRefNet-lite) from the try-on photo, or from the product photo cropped to `tryOnInfo.crop`, stores it under
`uploads/tryon/` and serves it as `tryOn.cutout`. It's remade in the background whenever a product is saved. Set
`tryOnInfo.cutout` to `plain` for studio shots the AI clips (a woven bag, a watch screen); the storefront then removes
the plain backdrop itself. After seeding, or to rebuild them all (needs the AI service; the first run downloads the
model):

```bash
cd api && npm run tryon:cutouts
```

## Not included yet

- Card payments outside SSLCommerz (Stripe etc.) and emails (order confirmations, password resets, team invites).
- LiveKit real-time voice needs your keys (`LIVEKIT_*` in `.env`). Voice today is turn-based: recorded until you pause, then transcribed (ElevenLabs) or recognised in the browser.
- Uploaded photos live on the API's disk (`UPLOAD_DIR`); move them to object storage (S3, R2) before running more than one API instance.
