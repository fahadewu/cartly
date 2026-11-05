# Testing Cartly (development and staging only)

Everything on this page is **test-only** and must be removed before going live (checklist at the end).

## Set up

```bash
docker compose up --build             # Docker: the first start loads the demo store AND runs the test kit
# or, from source:
./dev.sh                              # start everything (an empty database gets the demo store and test kit too)
cd backend/api && npm run test-kit    # test accounts, a taka rate, every gateway and Pathao in sandbox
```

`test-kit` is safe to re-run. It refuses to run with `NODE_ENV=production` or while any gateway or courier is live.
In Docker it runs on its own on a fresh database (not with `NODE_ENV=production` in `.env`); to run it again:
`docker compose exec api sh /app/docker/with-secrets.sh npm run test-kit`.

## Test accounts

| Where | Email | Password |
|---|---|---|
| Storefront (http://localhost:5173) | demo@cartly.dev | Demo1234! |
| Admin panel (http://localhost:5174) | admin@cartly.dev | Admin1234! |
| Rider app (http://localhost:5174/rider, best on a phone) | rider@cartly.dev | Rider1234! |

The login pages have a **Use it** button that fills these in. The rider signs in on the admin panel's login page
and only ever sees the rider app.

## Payments (sandbox: no real money moves)

`test-kit` saves each gateway's public sandbox credentials (encrypted, in sandbox mode) and switches the
methods on. While a method is in sandbox mode, checkout shows its test details under the payment options.

| Method | Gateway sandbox | How to pay |
|---|---|---|
| bKash | bKash's demo merchant (Tokenized Checkout v2) | Wallet **01770618575**, OTP **123456**, PIN **12121** |
| Rocket | SSLCommerz `testbox` store | Any number, OTP **111111** (or 123456) |
| Card | SSLCommerz `testbox` store | **4111 1111 1111 1111** (Visa), 5111 1111 1111 1111 (Mastercard), 3711 111111 11111 (Amex); expiry **12/26**, CVV **111** |
| Cash on delivery | none | Needs a phone number; mark it paid on the order in the admin panel |
| Demo card | none (development only) | 4242 4242 4242 4242, any future expiry, any CVC |
| Nagad | **off**: see below | |

**Nagad** is saved with the public sample merchant from Nagad's integration kit, but the current sandbox
rejects it ("Failed to verify signature"). Put the sandbox keys from your own Nagad onboarding in Admin →
Payments → Settings → Nagad, then switch Nagad on under Checkout options.

The SSLCommerz test cards expire 12/26; after that, SSLCommerz's developer docs list the current ones.
Sandbox callbacks come back to `localhost`, so test in the same browser. SSLCommerz's server-to-server IPN
can't reach `localhost`; the shopper's return and the payment sweeper confirm the payment instead.

## Delivery (own riders and couriers)

`test-kit` adds the rider **Karim Mia** and switches **Pathao** on in sandbox mode with the public test merchant
from Pathao's developer docs (sandbox parcels are never picked up).

| Courier | Sandbox | To test it |
|---|---|---|
| Pathao | Public test merchant (set by the kit) | Nothing to do |
| RedX | Yes, but no public token | Request a sandbox token in your RedX merchant panel → Developer API, paste it in Admin → Delivery → Couriers |
| Steadfast | **None**: every booking is a real parcel | Only books once switched to live; Test connection is safe (it reads the balance) |

Couriers' webhooks can't reach `localhost`. Use **Check with …** on the order, or wait for the sweep, which asks
the courier about parcels it hasn't heard from in 30 minutes, every 5 minutes.

## What to try

- [ ] Pay with bKash, Rocket and card: the order goes from *Awaiting payment* to *Processing*, and Admin → Payments lists it as paid.
- [ ] Cancel on the gateway page: the order stays open. Pay again with another method, or switch to cash on delivery.
- [ ] Leave a payment unfinished: after 30 minutes the order is cancelled and its stock put back.
- [ ] Cash on delivery: Admin → the order → *Mark as paid (cash collected)*.
- [ ] Refund a bKash or SSLCommerz payment from the admin order page (partial, then the rest).
- [ ] Cancel a paid order as the shopper: the admin panel shows *Refund due* (and a badge on Payments).
- [ ] Admin → Products → a product → *For Pip and search*: remove the material and try to save (it's refused); *Suggest with AI* (needs `ANTHROPIC_API_KEY`).
- [ ] Search or ask Pip for "office shirt" or "কেডস"; with `ANTHROPIC_API_KEY` set, also ask Pip "can I pay with bKash?".
- [ ] Place a cash-on-delivery order, then Admin → the order → **Send out** → *Own rider* → Karim Mia. The shopper's order page shows the rider, a **Call** button and a 4-digit delivery code.
- [ ] Sign in as the rider on a phone (or a narrow window) at `/rider`: *Picked up* (the order becomes Shipped), *On my way*, then *Delivered* with the customer's code and the cash taken. The order becomes Delivered and paid.
- [ ] Try a wrong delivery code (refused), and *Couldn't deliver* with a reason (the customer sees it in their timeline).
- [ ] Admin → Delivery → Riders: the rider holds the cash; press **Cash received** once it's handed in.
- [ ] Send another order with **Pathao** (city and zone are optional). You get a consignment id and the ৳ fee; **Check with Pathao** asks for its status.
- [ ] Returns: on a delivered order, the shopper presses **Return items**, picks an item and a reason. Admin → Returns → the return: *Approve*, *Send a rider* (the rider app shows a *Return pickup*: *Collected it*, then *Handed in at the store*), *Inspect* (tick what goes back into stock), *Refund* (through the gateway for online payments, or record a bKash transfer with its reference). The shopper's order page follows each step.
- [ ] Admin → Analytics: switch between the tabs and periods. Browse a few products and search on the storefront (try something the store doesn't sell), then look at *Products & demand*: views, *Searched for, not found*.
- [ ] Journeys: open the storefront with `?utm_source=newsletter`, sign in, browse a few pages, scroll, then switch tabs. Within a few seconds Admin → Analytics → *Visitors & journeys* shows the visit; click it to see each page, time on it, what was done there and where the visit ended.
- [ ] Profiles: view and favourite a few streetwear items, then wait ~20 s: Explore's *Picked for you* leans that way, and Admin → Customers → the shopper shows the assumed shopping profile. Account → *Personalised suggestions* → Off deletes it.
- [ ] Ask Pip something off-topic ("solve 12 x 4", "who won the election"): a sweet one-line no, then a shopping idea.
- [ ] Admin → Delivery → Shipments: filter by carrier and status. *Needs a look* lists short cash collections, courier sync problems and parcels that came back.
- [ ] Staff roles: Admin → **Team & roles** → *Add staff member*, pick **Support**, keep *Make a temporary password*. Copy the details, sign out, and sign in as them: they must choose their own password first. Their sidebar has no Analytics, Content, Team or System; Products opens *View only*; an order's *Refund* button is locked. Back as the admin, the Team page's *Recent changes* lists what you did.
- [ ] As the admin, *Turn off* that account: they're signed out at once and can't sign in again. *Turn on* restores it; *Reset password* gives a new temporary one.

Automated tests cover the same flows against local stand-ins of the gateways and couriers: `cd backend/api && npm run test:e2e`.

## Before going live: remove the test setup

- [ ] Build the storefront and admin panel with `VITE_SHOW_TEST_ACCOUNTS=false` (hides the *Use it* buttons).
- [ ] Create your real admin account (Admin → Team & roles → *Add staff member* → Admin), then delete the `demo@cartly.dev`, `admin@cartly.dev` and `rider@cartly.dev` users from the database (or at the very least sign in as each on the storefront and change the password under Account).
- [ ] Don't run `npm run test-kit` or `npx prisma db seed` against the production database (the seed adds demo shoppers and orders).
- [ ] Replace every gateway's sandbox credentials with your live ones and switch each to **Live** (checkout's test details disappear by themselves).
- [ ] Switch off *Demo card* (the API also refuses it with `NODE_ENV=production`).
- [ ] Couriers: replace Pathao's sandbox merchant with your own client ID, secret and login, and switch each courier you use to **Live**. In each courier's merchant panel, set the webhook URL shown in Admin → Delivery → Couriers, with its secret or token (RedX: the token goes at the end of the URL). `API_PUBLIC_URL` must be the public HTTPS address: Pathao refuses webhooks without a valid certificate.
- [ ] Add your real riders (Admin → Delivery → Riders) and give them the rider app link: the admin panel's address + `/rider`.
- [ ] Set the real taka rate (the kit sets 122).
- [ ] Run the API with `NODE_ENV=production`, and set `API_PUBLIC_URL`, `STOREFRONT_URL` and a fresh `PAYMENT_SECRETS_KEY`.
- [ ] Docker: set `NODE_ENV=production` and `VITE_SHOW_TEST_ACCOUNTS=false` in the workspace `.env` before the first
      start on the real server. Its database then stays empty (no demo store, no test kit): restore your store into
      it (`./cartly restore`, from a backup made where you built the catalogue), then remove the test accounts as above.
- [ ] Optionally delete `backend/api/scripts/test-kit.ts` and this file.
