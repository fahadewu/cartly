# Cartly

[![CI](https://github.com/fahadewu/cartly/actions/workflows/ci.yml/badge.svg)](https://github.com/fahadewu/cartly/actions/workflows/ci.yml)

A fashion store for Bangladesh with **Pip**, an AI shopping assistant that chats and talks in the shopper's
language (English, বাংলা, Banglish, Hindi, Urdu…), recommends from the store's own catalog, adds to the cart and
starts virtual try-ons. Checkout takes bKash, Nagad, Rocket, cards and cash on delivery. Delivery goes through the
store's own riders (with a phone app) or Pathao, Steadfast and RedX. Staff run everything from an admin panel:
orders, products, returns, analytics, visitor journeys, AI spend and team roles.

## Run it (judges, start here)

You need **Docker** ([Docker Desktop](https://docs.docker.com/get-docker/), OrbStack or Colima), about 6 GB of free
disk and an internet connection for the first build. Nothing else: no Node, Python, database or API keys.

From this folder (the one with `docker-compose.yml`, `storefront/`, `admin/` and `backend/`):

```bash
docker compose up --build        # or: ./cartly up   (macOS/Linux: same thing, waits and prints the addresses)
```

The first build takes 5–10 minutes. The first start then sets up the database and loads a demo store with
products, shoppers, orders and test accounts. After that:

| Open | Address | Sign in with |
|---|---|---|
| The store | http://localhost:5173 | `demo@cartly.dev` / `Demo1234!` |
| The admin panel | http://localhost:5174 | `admin@cartly.dev` / `Admin1234!` |
| The rider app (best on a phone-sized window) | http://localhost:5174/rider | `rider@cartly.dev` / `Rider1234!` |
| The API reference | http://localhost:4100/docs | |
| Emails Cartly sends (Mailpit catches them all) | http://localhost:8025 | |

The login pages have a **Use it** button that fills these in. Stop with `Ctrl-C` (or `./cartly down`); the data
stays until `./cartly reset` or `docker compose down -v`.

### What works without any keys

Everything except the paid AI vendors, which fall back to free versions:

| Feature | Without a key (default) | With a key in `.env` |
|---|---|---|
| Pip | English rule brain: search, filters, cart, orders, try-on | Claude: any language and script, festivals and seasons, sweeter conversation |
| Virtual try-on | Quick preview of accessories on your photo (on-device) | FASHN AI try-on of clothes and shoes on your photo |
| Voice | The browser's speech recognition and voices | ElevenLabs: detects the spoken language, one Pip voice |
| Payments | bKash, Rocket and card in their **sandboxes** (no real money), cash on delivery, a demo card | Your own gateway credentials (Admin → Payments) |

To switch an AI feature on: `cp .env.example .env`, add the key (and a daily spend cap), then `./cartly up` again.
Each one can also run on Meta Model API (`META_API_KEY` plus one switch per job, see `.env.example`); the defaults
stay as they are until Meta passes a test in Bangla.

### A five-minute tour

- **Store:** search "office shirt" or "কেডস". Ask Pip "red sneakers under $100" or "show me something for Eid".
  Open sunglasses or a cap and press *Try it on* (upload a photo or use a sample model).
- **Checkout:** pay with bKash's sandbox (wallet `01770618575`, OTP `123456`, PIN `12121`), the test card
  `4111 1111 1111 1111` (12/26, CVV 111) or cash on delivery. More test details are in [TESTING.md](TESTING.md).
- **What shoppers like:** as the demo shopper, open Account and turn on *Emails about products for you*, set your
  sizes and colouring (a tone swatch, or estimate it from a photo on the device). Search for something the store
  doesn't sell, like "kurti". Then in the admin panel, add or import a kurti: within a minute **Emails** has a
  draft "We found it" for that shopper with the reason, and sending it lands in Mailpit. **Customers → the shopper**
  shows *What they like* (style mix, colours, 12 weeks of interest, best matches and why); **Analytics → Interests &
  emails** shows unmet wants worth sourcing and how the emails do.
- **Admin:** the dashboard. Then open a cash-on-delivery order and **Send out** → *Own rider* → Karim Mia, and follow
  it in the rider app (*Picked up* → *On my way* → *Delivered* with the code the shopper sees). Also try
  **Analytics**, **Products → Import** (a Shopify or WooCommerce export works), and **Team & roles**.

### Features built from shopping research

Each one cites the study behind it in its source file. Try them as the demo shopper:

- **Fit confidence.** On a product page, *Write a review* takes the size you bought, how it fit, your height and
  photos. Once 3+ shoppers agree, the page says *Runs small · 3 of 4 shoppers said so* and, if you saved your size
  in Account, *You wear M, so pick L*. The star bars are real counts; "Verified purchase" only after delivery.
- **Ask family.** *Can't decide? Ask family to vote* on a product, or *Ask family* in the fitting room (optionally
  with your try-on photo). Open the link in a private window: family vote with one tap, in English or বাংলা, no
  account. Results show under **Family votes** in the sidebar, and Pip knows what they said.
- **Style quiz.** Explore → *Find your style in 30 seconds* (`/style`): seven "this or that" picks, then *Picked for
  you* says "Because you picked Minimalist in your style quiz".
- **Festival deadlines.** The banner on Explore, product pages and checkout show the real last day to order before the
  next festival (Eid, Puja, Pohela Boishakh, Victory Day…), from the posted delivery times. *Plan family outfits*
  (`/festival`) is one board for everyone's outfits with a budget each.
- **Pip, in a bad moment.** Tell Pip "my parcel never arrived, worst service": it drops the cheer, says sorry and,
  once Admin → Returns → *Support contact* is filled in, offers WhatsApp or a call. When you're torn between two
  pieces it shows them side by side with what each wins at.
- **The Cartly promise** (`/promise`) and a **stamp card** with a head start (Admin → Promotions, off by default).

## Test it

Every automated check, in Docker, with nothing installed but Docker:

```bash
./cartly test          # API lint, types, unit + end-to-end; AI service ruff + pytest; store and admin lint + build
./cartly test api      # or just one part: api | ai | web
./cartly smoke         # with the store running (./cartly up): a quick end-to-end pass over HTTP, ~30 checks
```

`./cartly test` runs on its own throwaway Postgres and Redis, so your demo store isn't touched. The first run
builds the test image (a few minutes). The same checks run on every push in GitHub Actions
([CI](https://github.com/fahadewu/cartly/actions/workflows/ci.yml)), including a job that does exactly what a judge
does: `./cartly up`, `./cartly smoke`, `./cartly test`. Without bash: `docker compose --profile test run --rm --build test`.

For hands-on testing, [TESTING.md](TESTING.md) has the test accounts, sandbox payment details and a checklist.

## Data: upgrades, backups, moving a store, importing products

- **Database upgrades are automatic.** Every start applies the migrations a new version brings; nothing to run.
- **Back up the whole store** (database, uploaded photos, the AI spend meter) to one file:
  `./cartly backup` → `backups/cartly-backup-<time>.tar.gz`. Add `--with-secrets` to include the key that unlocks
  the saved payment and courier credentials. Either way, keep the file private: it holds customers' details.
- **Restore or move a store** (laptop → server, or onto a fresh install): `./cartly restore backups/<file>`. It
  replaces this install's data. Photo addresses are moved to the new install's address, and the search index is
  rebuilt. A backup from an older Cartly is upgraded on start; one from a newer version is refused.
- **Import products** from a CSV: Admin → Products → **Import**, or `./cartly import products.csv` (add `--apply`
  to save). It reads Cartly's own columns (Products → **Export**, or the template in the import dialog), a Shopify
  product export or a WooCommerce product export. Every row is checked first. Products that lack what Pip needs to
  recommend them (material, occasions, seasons, style tags, features) come in hidden until you finish them in the
  editor, where *Suggest with AI* drafts those details. A `slug,price,stock` file updates prices and stock in bulk.
- **Export products:** Admin → Products → **Export**, or `./cartly export products.csv`.

Without bash (Windows PowerShell), the same commands are `docker compose run --rm tools backup`,
`docker compose run --rm tools restore /backups/<file>` (stop `api` and `ai` first), and
`Get-Content products.csv | docker compose exec -T api sh /app/docker/with-secrets.sh npm run -s catalog:import -- - --apply`.

## Everyday commands

```bash
./cartly up | down | status | logs [service] | test | smoke | reset | help
```

## If something goes wrong

- **A port is already in use:** set `CARTLY_STOREFRONT_PORT`, `CARTLY_ADMIN_PORT` or `CARTLY_API_PORT` in `.env`
  (see `.env.example`), then `./cartly up`.
- **The microphone or camera doesn't work:** browsers allow them only on `localhost` or HTTPS, so open the store
  as `http://localhost:5173`, not by the machine's IP address.
- **`failed to xattr …/._…: operation not permitted`** while building on a Mac from an external (exFAT) drive:
  `./cartly up` removes those macOS `._` metadata files first, or run `dot_clean -m .` once.
- **Is it healthy?** `./cartly status` shows each service and its health check; `./cartly logs api` shows why one
  isn't starting.

## Developing without Docker

`./dev.sh` runs the four apps from source with live reload (needs Node 22+, Python 3.12+, PostgreSQL 15+ with
pgvector, Redis, and `backend/.env` from `backend/.env.example`). It installs missing or changed packages, applies
new migrations, loads the demo store into an empty database, and refuses to start if another project holds a
port, naming it. `./dev.sh status` and `./dev.sh stop` do what they say.

| Folder | What | Port |
|---|---|---|
| `storefront/` | Vue 3 store with Pip, voice and try-on | 5173 |
| `admin/` | Vue 3 admin panel and rider app | 5174 |
| `backend/api/` | NestJS commerce API (Prisma, PostgreSQL, Redis) | 4100 |
| `backend/ai/` | FastAPI AI service: Pip, semantic search, try-on, voice | 8001 |
| `backend/catalog/` | The demo store's seed catalog | |

More: [backend/README.md](backend/README.md) (API, business rules, payments, delivery),
[backend/ai/README.md](backend/ai/README.md) (how Pip works), [TESTING.md](TESTING.md) (test accounts and sandbox
details) and [PROJECT_CONTEXT.md](PROJECT_CONTEXT.md) (the whole project in one file, for people and AI assistants).
