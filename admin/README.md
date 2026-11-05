# Cartly Admin

The back-office for the Cartly store: a separate Vue 3 + Vite app that talks to the same NestJS API as the storefront, on its admin routes (`/api/v1/admin/*`, admins only).

| Part | Repo |
|---|---|
| Storefront (Vue 3 + Vite) | [cartly_storefront](https://github.com/fahadewu/cartly_storefront) |
| Admin panel (this repo) | [cartly_admin](https://github.com/fahadewu/cartly_admin) |
| Commerce API + AI service | [cartly_backend](https://github.com/fahadewu/cartly_backend) |

## Run it

The quickest way is Docker, from the workspace folder: `docker compose up --build` (see the workspace README). This
repo's `Dockerfile` builds the panel and serves it with nginx, which forwards `/api` to the API.

From source, start the backend first ([cartly_backend](https://github.com/fahadewu/cartly_backend): Postgres, Redis, `api/` on :4100, optionally `ai/` on :8001), then:

```bash
npm install
npm run dev        # http://localhost:5174 (API calls are proxied to API_PORT from ../backend/.env, 4100)
npm run build      # production build in dist/
npm run preview    # serve the build on http://localhost:4174
```

Sign in with the seeded admin: **admin@cartly.dev / Admin1234!** (created by `npm run db:seed` in the backend's `api/`). Customer accounts are refused. To make someone else an admin, open them under Customers and choose **Make admin**; role changes take effect on their next request.

## Settings

| Variable | Default | Use |
|---|---|---|
| `VITE_API_URL` | `/api/v1` | API base. Leave the default in development (Vite proxies `/api`); set a full URL like `https://api.example.com/api/v1` for a deployed build and add the admin origin to `CORS_ORIGIN` in `backend/.env`. |
| `VITE_STOREFRONT_URL` | `http://localhost:5173` | Where “View in store” and “Open the store” links go. |

## Pages

- **Dashboard**: today’s queues (orders to ship, stock to reorder, requests waiting), sales for 7/30/90 days with a daily revenue chart, latest orders, best sellers, quick restock, service health.
- **Orders**: filter by status, search by order number or customer. Order page shows items, totals, address and customer, with **Mark as shipped / delivered** and **Cancel order** (items go back into stock).
- **Products**: filter by status, stock, category; sort; search. **Import** a CSV (Cartly's own columns, a Shopify or a WooCommerce product export: checked row by row before anything is saved; products missing Pip's details come in hidden) and **Export** every product as a CSV to edit and import back. Editor with validation, live storefront card preview, sales stats, archive/restore and delete (only for products that were never ordered).
- **Virtual try-on** (in the product editor): where the item is worn, a dedicated try-on photo, and a per-slot photo guide (what the AI needs: one item, all of it visible, front view, plain background, no hanger, 1024 px+). Every photo is checked on upload, and existing photos can be re-checked. Pixel checks run always; an AI review runs when the AI service has an Anthropic key. Photos that will try on badly are flagged with the fix, and saving one asks first. Also: photo type, a default styling prompt ("wear it open"), and **Preview on a model**, which renders the real AI try-on on a sample model (needs `FASHN_API_KEY`). For accessories (the storefront's quick preview when AI try-on is off), the editor shows the cut-out shoppers see and lets you pick **AI** background removal (any background) or **Simple** (a studio shot on a plain backdrop); the cut-out is remade a few seconds after each save, or on demand.
- **Customers**: search and filter by role; customer page with orders, spend, favourites, reviews, requests and admin access.
- **Reviews**: moderation queue; deleting a review recalculates the product’s rating.
- **Promotions**: create codes, change the discount, pause/resume, delete; see uses, discount given and revenue.
- **Requests**: products customers asked for; set Received / Sourcing / Found / Unavailable (customers see it in their account).
- **Content**: category banners, collections (Offers fills itself from sale prices) and Inspiration stories with a product picker.
- **System**: database, Redis and AI service health; rebuild the search index; read-only store settings.

Product edits reach the store straight away and the AI service (search + Pip) re-indexes a couple of seconds after each save.
