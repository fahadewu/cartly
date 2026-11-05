# Cartly

An online store with Pip, an AI shopping assistant with voice and virtual try-on. This repo is the storefront.

| Part | Repo | Runs on |
|---|---|---|
| Storefront (Vue 3 + Vite, this repo) | [cartly_storefront](https://github.com/fahadewu/cartly_storefront) | http://localhost:5173 |
| Admin panel (Vue 3 + Vite) | [cartly_admin](https://github.com/fahadewu/cartly_admin) | http://localhost:5174 |
| Commerce API (NestJS + Prisma) | [cartly_backend](https://github.com/fahadewu/cartly_backend) `api/` | http://localhost:4100/api/v1 (docs at `/docs`) |
| AI service for Pip and search (FastAPI) | [cartly_backend](https://github.com/fahadewu/cartly_backend) `ai/` | http://localhost:8001 |

Postgres (with pgvector) and Redis hold everything: see the backend README for setup, the API reference and the business rules.

AI features switch on with keys in the backend's `.env`, and each has a fallback without one: `ANTHROPIC_API_KEY` (Pip in any language, photo review), `FASHN_API_KEY` (AI try-on), `ELEVENLABS_API_KEY` (voice in any language).

## Run it

The quickest way is Docker, from the workspace folder: `docker compose up --build` (see the workspace README). This
repo's `Dockerfile` builds the storefront and serves it with nginx, which forwards `/api` to the API.

From source:

```bash
# 1. Backend first (see cartly_backend: cp .env.example .env, then migrate and seed)
cd cartly_backend/api && npm run start:dev    # commerce API
cd cartly_backend/ai && ./run.sh              # AI service (optional: search and Pip fall back without it)

# 2. Storefront (this repo)
npm install && npm run dev                    # http://localhost:5173
```

Vite proxies `/api` to the API in development, on `API_PORT` from `../backend/.env` (4100 when the backend isn't checked out beside this repo). For a build that talks to another host, set `VITE_API_URL` (e.g. `https://api.example.com/api/v1`) and add the site's origin to `CORS_ORIGIN` in the backend's `.env`.

**Logins:** storefront `demo@cartly.dev` / `Demo1234!` · admin panel `admin@cartly.dev` / `Admin1234!` · test card `4242 4242 4242 4242`.

## How the storefront uses the backend

- `src/api.js`: fetch wrapper (token, error messages, session expiry).
- `src/auth.js`: sign up, sign in, profile and password through `/auth/*`.
- `src/catalog.js`: the live catalog from `GET /catalog`, loaded before the app mounts and refreshed when a tab comes back after a while, so price, stock and content changes made in the admin panel show up.
- `src/store.js`: cart, promo codes, checkout, orders, favourites, reviews, product requests and team, all stored server-side.
- `src/agent/useAgent.js`: Pip talks to the AI service through `POST /assistant/chat`, which knows the shopper's cart and orders. If the AI service is down, the same rules run in the browser (`src/agent/brain.js`).
- **Any language**: with the Claude brain, Pip answers in the language (and script) the shopper uses, greets them in their device language, and brings up what's timely for them, like the season or an upcoming Durga Puja, Eid, Diwali, Lunar New Year, Thanksgiving or 11.11 sale. It talks only about Cartly's own catalog: "what's trending" means the store's popular and new products. The reply's language drives the voice: with ElevenLabs, speech-to-text detects the spoken language by itself and one Pip voice answers in it. Without it, the browser listens in the language picked on the voice screen (or the last one used) and speaks with a matching device voice. Chat bubbles handle right-to-left scripts.
- **AI try-on** (`src/tryon/useTryOn.js`): with FASHN enabled, the fitting room re-renders the shopper's photo wearing the look. Their own photo needs their agreement first; sample models don't. Styling ("tucked in", "worn open", or your own words, or just ask Pip) re-renders it, "hold to compare" shows the original, and an on-device check flags photos that are cropped or side-on. The quick preview (cut-outs placed from body landmarks, never uploaded) remains as a fallback and a choice, for accessories only: glasses, hats, headphones, watches and bags (`PREVIEW_SLOTS` in `src/tryon/specs.js`). A flat cut-out can't make clothes or shoes look worn, so without AI try-on those have no "Try it on" button and Pip says they need the AI try-on. Cut-outs come from the server (`product.tryOn.cutout`); without one, a studio shot's plain backdrop is removed on-device from the item's `tryOn.crop`.
- `src/capabilities.js`: which AI features the deployment has (`GET /assistant/capabilities`), so each one uses its best path or its fallback.
- The catalog search box uses the semantic search (`/products/search`), so “warm jacket” or “red dress under $100” work.

If the API isn't reachable, the storefront shows a clear “store isn't reachable” screen instead of stale data.
