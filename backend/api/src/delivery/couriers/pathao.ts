import { createHash } from 'node:crypto';
import type { ShipmentStatus } from '../../generated/prisma/client.js';
import { type Account, type Courier, CourierError, http, humanize, type Place, sameSecret, squash } from './types.js';

/**
 * Pathao Courier merchant API (aladdin/api/v1), per merchant.pathao.com/courier/developer-api and the
 * official WooCommerce plugin:
 *   issue a token (password grant, lasts ~90 days, refreshable) → POST /orders with the store (pickup
 *   point) → consignment_id → webhooks as it moves, or GET /orders/{id}/info.
 * City, zone and area are optional: Pathao works them out from the address when they're left out.
 * The sandbox's public test account is in the docs (client 7N1aMJQbWm, test@pathao.com).
 */
const BASE = { sandbox: 'https://courier-api-sandbox.pathao.com', live: 'https://api-hermes.pathao.com' };
const API = '/aladdin/api/v1';
// The handshake header Pathao's panel asks for; the official plugin sends this value for every merchant.
const INTEGRATION_HEADER = 'X-Pathao-Merchant-Webhook-Integration-Secret';
const INTEGRATION_DEFAULT = 'f3992ecc-59da-4cbe-a049-a13da2018d51';

/** Pathao's event names and status slugs (both spellings squashed), onto ours. null: note it, keep the status. */
const STATUS: Record<string, ShipmentStatus | null> = {
  pending: 'BOOKED',
  created: 'BOOKED',
  ordercreated: 'BOOKED',
  updated: null,
  orderupdated: null,
  pickuprequested: 'BOOKED',
  assignedforpickup: 'BOOKED',
  picked: 'PICKED_UP',
  pickupfailed: null,
  pickupcancelled: 'CANCELLED',
  atthesortinghub: 'IN_TRANSIT',
  intransit: 'IN_TRANSIT',
  receivedatlastmilehub: 'IN_TRANSIT',
  assignedfordelivery: 'OUT_FOR_DELIVERY',
  delivered: 'DELIVERED',
  partialdelivery: 'DELIVERED',
  deliveryfailed: 'FAILED_ATTEMPT',
  onhold: 'FAILED_ATTEMPT',
  return: 'RETURNING',
  returned: 'RETURNING',
  returnidcreated: 'RETURNING',
  returnintransit: 'RETURNING',
  returnedtomerchant: 'RETURNED',
  paid: null,
  paymentinvoice: null,
  paidreturn: null,
  exchange: null,
  exchanged: null,
};
const statusOf = (s: unknown) => {
  const k = squash(s);
  return k in STATUS ? STATUS[k] : null;
};

type Reply = Record<string, unknown>;
const HOUR = 3600;
const reason = (b: Reply) => {
  const errors = b.errors as Record<string, string[]> | undefined;
  const first = errors && Object.values(errors).flat()[0];
  return String(first ?? b.message ?? 'Pathao had a problem');
};

const tokenKey = (acct: Account) => 'pathao:token:' + createHash('sha256').update(`${acct.baseUrl}|${acct.creds.clientId}|${acct.creds.username}`).digest('hex').slice(0, 24);

async function token(acct: Account, renew = false): Promise<string> {
  const key = tokenKey(acct);
  const raw = await acct.store.get(key);
  const cached = raw ? (JSON.parse(raw) as { access: string; refresh?: string; expires: number }) : null;
  if (!renew && cached && cached.expires > Date.now() + HOUR * 1000) return cached.access;
  const { clientId, clientSecret, username, password } = acct.creds;
  let res = cached?.refresh
    ? await http('POST', `${acct.baseUrl}${API}/issue-token`, {}, { client_id: clientId, client_secret: clientSecret, refresh_token: cached.refresh, grant_type: 'refresh_token' })
    : null;
  if (!res?.body.access_token) {
    res = await http('POST', `${acct.baseUrl}${API}/issue-token`, {}, { client_id: clientId, client_secret: clientSecret, username, password, grant_type: 'password' });
  }
  if (!res.body.access_token) throw new CourierError(`Pathao didn’t accept the credentials: ${reason(res.body)}`, res.body);
  const ttl = Number(res.body.expires_in ?? 30 * 24 * HOUR);
  const next = { access: String(res.body.access_token), refresh: res.body.refresh_token ? String(res.body.refresh_token) : undefined, expires: Date.now() + ttl * 1000 };
  await acct.store.set(key, JSON.stringify(next), ttl);
  return next.access;
}

/** An API call, signing in again once if the token was rejected. */
async function api(acct: Account, method: string, path: string, body?: unknown) {
  const call = async (t: string) => http(method, `${acct.baseUrl}${API}${path}`, { authorization: `Bearer ${t}` }, body);
  let res = await call(await token(acct));
  if (res.status === 401) res = await call(await token(acct, true));
  return res;
}

const list = (b: Reply) => ((b.data as Reply)?.data ?? b.data ?? []) as Reply[];

/** The store (pickup point) to book from: the one set in the admin panel, else Pathao's default. */
async function storeId(acct: Account): Promise<number> {
  if (acct.creds.storeId) return Number(acct.creds.storeId);
  const res = await api(acct, 'GET', '/stores');
  const stores = list(res.body).filter((s) => s.is_active !== 0 && s.is_active !== false);
  const pick = stores.find((s) => s.is_default_store) ?? stores[0];
  if (!pick) throw new CourierError('Your Pathao account has no active store (pickup point). Add one in the Pathao merchant panel.', res.body);
  return Number(pick.store_id);
}

export const pathao: Courier = {
  id: 'pathao',
  name: 'Pathao',
  fields: [
    { key: 'clientId', label: 'Client ID', secret: false, hint: 'Pathao merchant panel → Developer API. Sandbox: 7N1aMJQbWm.' },
    { key: 'clientSecret', label: 'Client secret', secret: true },
    { key: 'username', label: 'Merchant email', secret: false, hint: 'The email you sign in to Pathao with (sandbox: test@pathao.com).' },
    { key: 'password', label: 'Password', secret: true },
    { key: 'storeId', label: 'Store ID', secret: false, optional: true, hint: 'The pickup point to book from. Leave empty to use your default Pathao store.' },
    { key: 'webhookSecret', label: 'Webhook secret', secret: true, optional: true, hint: 'The secret you set with the webhook URL in Pathao’s panel (the client secret if you left it empty there).' },
    { key: 'integrationSecret', label: 'Webhook integration header', secret: false, optional: true, hint: `The value Pathao’s panel shows for ${INTEGRATION_HEADER}. Leave empty for the standard one.` },
  ],
  baseUrl: (live) => (live ? BASE.live : BASE.sandbox),
  publicTrackingUrl: (code) => `https://merchant.pathao.com/tracking?consignment_id=${encodeURIComponent(code)}`,
  levels: [
    { key: 'city', label: 'City', optional: true },
    { key: 'zone', label: 'Zone', parent: 'city', optional: true },
    { key: 'area', label: 'Area', parent: 'zone', optional: true },
  ],

  async locations(acct, level, parent) {
    const path = level === 'city' ? '/city-list' : level === 'zone' ? `/cities/${Number(parent)}/zone-list` : `/zones/${Number(parent)}/area-list`;
    const res = await api(acct, 'GET', path);
    if (res.status >= 400) throw new CourierError(`Pathao didn’t send its ${level} list: ${reason(res.body)}`, res.body);
    return list(res.body)
      .map((p): Place => ({ id: String(p[`${level}_id`]), name: String(p[`${level}_name`]) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  },

  async book(acct, input) {
    const n = (k: string) => (input.location[k] ? Number(input.location[k]) : undefined);
    const res = await api(acct, 'POST', '/orders', {
      store_id: await storeId(acct),
      merchant_order_id: input.invoice,
      recipient_name: input.recipient.name.slice(0, 64),
      recipient_phone: input.recipient.phone,
      // Pathao wants at least 10 characters, and reads the city from it when none is picked.
      recipient_address: `${input.recipient.address}, ${input.recipient.city}`.slice(0, 220),
      recipient_city: n('city'),
      recipient_zone: n('zone'),
      recipient_area: n('area'),
      delivery_type: 48, // normal (12 is on-demand)
      item_type: 2, // parcel
      item_quantity: input.itemCount,
      item_weight: Math.min(10, Math.max(0.5, input.weightKg)),
      amount_to_collect: Math.round(input.codAmount),
      item_description: input.description,
      special_instruction: input.note,
    });
    const data = res.body.data as Reply | undefined;
    if (res.status >= 400 || !data?.consignment_id) throw new CourierError(`Pathao didn’t book it: ${reason(res.body)}`, res.body);
    const id = String(data.consignment_id);
    return {
      consignmentId: id,
      trackingCode: id,
      trackingUrl: `https://merchant.pathao.com/tracking?consignment_id=${encodeURIComponent(id)}&phone=${input.recipient.phone}`,
      charge: data.delivery_fee != null ? Number(data.delivery_fee) : undefined,
      courierStatus: humanize(data.order_status) || undefined,
      status: statusOf(data.order_status) ?? 'BOOKED',
      raw: res.body,
    };
  },

  async track(acct, s) {
    const res = await api(acct, 'GET', `/orders/${encodeURIComponent(s.consignmentId ?? '')}/info`);
    const data = res.body.data as Reply | undefined;
    if (res.status >= 400 || !data) throw new CourierError(`Pathao didn’t find ${s.consignmentId}: ${reason(res.body)}`, res.body);
    const slug = data.order_status_slug ?? data.order_status;
    return { status: statusOf(slug), courierStatus: humanize(data.order_status ?? slug), raw: data };
  },

  webhookAuth: 'header',
  async webhook(acct, { headers, body }) {
    const secret = acct.creds.webhookSecret || acct.creds.clientSecret;
    if (!sameSecret(headers['x-pathao-signature'], secret)) return null;
    // Pathao checks the endpoint when the URL is saved: it wants 202 and the integration header back.
    const reply = { status: 202, headers: { [INTEGRATION_HEADER]: acct.creds.integrationSecret || INTEGRATION_DEFAULT } };
    const event = body.event ?? body.order_status_slug ?? body.order_status;
    if (!body.consignment_id || squash(event) === 'webhookintegration' || String(event).startsWith('store.')) return { ...reply, updates: [] };
    const text = humanize(event);
    return {
      ...reply,
      updates: [
        {
          consignmentId: String(body.consignment_id),
          invoice: body.merchant_order_id ? String(body.merchant_order_id) : undefined,
          status: statusOf(event),
          courierStatus: text,
          message: body.reason ? `${text}: ${String(body.reason)}` : text,
          at: body.timestamp ? new Date(String(body.timestamp)) : undefined,
          charge: body.delivery_fee != null ? Number(body.delivery_fee) : undefined,
          codCollected: body.collected_amount != null ? Number(body.collected_amount) : undefined,
          raw: body,
        },
      ],
    };
  },

  async test(acct) {
    await token(acct, true);
    const id = await storeId(acct);
    return `Connected to Pathao (${acct.live ? 'live' : 'sandbox'}); parcels are picked up from store ${id}.`;
  },
};
