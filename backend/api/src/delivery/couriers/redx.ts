import type { ShipmentStatus } from '../../generated/prisma/client.js';
import { type Account, type Courier, CourierError, http, humanize, sameSecret } from './types.js';

/**
 * RedX open API v1.0.0-beta, per redx.com.bd/developer-api and the official WooCommerce plugin:
 *   POST /parcel with the delivery area (from GET /areas) → tracking_id → webhooks as it moves, or
 *   GET /parcel/info/{id} (status, charge) and /parcel/track/{id} (history). Cancelled with PATCH /parcels.
 * RedX signs nothing, so its webhook URL carries our own token (?token=…), as its docs suggest.
 */
const BASE = { sandbox: 'https://sandbox.redx.com.bd/v1.0.0-beta', live: 'https://openapi.redx.com.bd/v1.0.0-beta' };

const STATUS: Record<string, ShipmentStatus | null> = {
  'pickup-pending': 'BOOKED',
  'ready-for-delivery': 'PICKED_UP', // received from us at the hub
  'agent-area-change': 'IN_TRANSIT',
  'delivery-in-progress': 'OUT_FOR_DELIVERY',
  delivered: 'DELIVERED',
  'agent-hold': 'FAILED_ATTEMPT',
  'agent-returning': 'RETURNING',
  returned: 'RETURNED',
  cancelled: 'CANCELLED',
  paid: null, // RedX paid the cash it collected over to us
};
const statusOf = (s: unknown) => STATUS[String(s ?? '').toLowerCase()] ?? null;

type Reply = Record<string, unknown>;
const auth = (acct: Account) => ({ 'API-ACCESS-TOKEN': `Bearer ${acct.creds.token.replace(/^Bearer\s+/i, '')}` });
const reason = (b: Reply) => {
  const errors = b.errors as Record<string, string[]> | string[] | undefined;
  const first = Array.isArray(errors) ? errors[0] : errors && Object.values(errors).flat()[0];
  return String(first ?? b.message ?? 'RedX had a problem');
};

export const redx: Courier = {
  id: 'redx',
  name: 'RedX',
  fields: [
    { key: 'token', label: 'API access token', secret: true, hint: 'RedX merchant panel → Developer API → Request token (a sandbox one for testing).' },
    { key: 'pickupStoreId', label: 'Pickup store ID', secret: false, optional: true, hint: 'Leave empty to use your default RedX pickup store.' },
    { key: 'webhookToken', label: 'Webhook token', secret: true, optional: true, hint: 'Make up a long random token; it goes at the end of the webhook URL you give RedX, in place of YOUR_WEBHOOK_TOKEN.' },
  ],
  baseUrl: (live) => (live ? BASE.live : BASE.sandbox),
  publicTrackingUrl: (code) => `https://redx.com.bd/track-parcel/?trackingId=${encodeURIComponent(code)}`,
  levels: [{ key: 'area', label: 'Delivery area' }],

  async locations(acct) {
    const res = await http('GET', `${acct.baseUrl}/areas`, auth(acct));
    const areas = res.body.areas as Reply[] | undefined;
    if (res.status >= 400 || !areas) throw new CourierError(`RedX didn’t send its areas: ${reason(res.body)}`, res.body);
    return areas
      .map((a) => ({ id: String(a.id), name: a.post_code ? `${String(a.name)} · ${String(a.post_code)}` : String(a.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  },

  async book(acct, input) {
    const areaName = (input.locationNames.area ?? '').replace(/ · \d+$/, '');
    const res = await http('POST', `${acct.baseUrl}/parcel`, auth(acct), {
      customer_name: input.recipient.name,
      customer_phone: input.recipient.phone,
      delivery_area: areaName,
      delivery_area_id: Number(input.location.area),
      customer_address: `${input.recipient.address}, ${input.recipient.city}`,
      merchant_invoice_id: input.invoice,
      cash_collection_amount: String(Math.round(input.codAmount)),
      parcel_weight: Math.round(input.weightKg * 1000), // grams
      value: input.value,
      instruction: input.note,
      ...(acct.creds.pickupStoreId ? { pickup_store_id: Number(acct.creds.pickupStoreId) } : {}),
    });
    if (res.status >= 400 || !res.body.tracking_id) throw new CourierError(`RedX didn’t book it: ${reason(res.body)}`, res.body);
    const id = String(res.body.tracking_id);
    return { consignmentId: id, trackingCode: id, status: 'BOOKED', courierStatus: 'Pickup pending', raw: res.body };
  },

  async track(acct, s) {
    const id = encodeURIComponent(s.consignmentId ?? '');
    const [info, history] = await Promise.all([http('GET', `${acct.baseUrl}/parcel/info/${id}`, auth(acct)), http('GET', `${acct.baseUrl}/parcel/track/${id}`, auth(acct))]);
    const parcel = info.body.parcel as Reply | undefined;
    if (info.status >= 400 || !parcel) throw new CourierError(`RedX didn’t find ${s.consignmentId}: ${reason(info.body)}`, info.body);
    const steps = ((history.body.tracking as Reply[] | undefined) ?? [])
      .map((t) => ({ at: new Date(String(t.time)), message: String(t.message_en ?? '') }))
      .filter((t) => t.message)
      .sort((a, b) => a.at.getTime() - b.at.getTime());
    return {
      status: statusOf(parcel.status),
      courierStatus: humanize(parcel.status),
      events: steps.length ? steps : undefined,
      charge: parcel.charge != null ? Number(parcel.charge) : undefined,
      raw: parcel,
    };
  },

  async cancel(acct, s) {
    const res = await http('PATCH', `${acct.baseUrl}/parcels`, auth(acct), {
      entity_type: 'parcel-tracking-id',
      entity_id: s.consignmentId,
      update_details: { property_name: 'status', new_value: 'cancelled', reason: 'Cancelled by the store' },
    });
    if (res.status >= 400 || res.body.success === false) throw new CourierError(`RedX didn’t cancel it: ${reason(res.body)}`, res.body);
  },

  webhookAuth: 'query-token',
  async webhook(acct, { query, body }) {
    if (!sameSecret(query.token, acct.creds.webhookToken)) return null;
    if (!body.tracking_number) return { updates: [], status: 200 };
    return {
      status: 200,
      updates: [
        {
          consignmentId: String(body.tracking_number),
          invoice: body.invoice_number ? String(body.invoice_number) : undefined,
          status: statusOf(body.status),
          courierStatus: humanize(body.status),
          message: String(body.message_en ?? '') || humanize(body.status),
          at: body.timestamp ? new Date(String(body.timestamp)) : undefined,
          raw: body,
        },
      ],
    };
  },

  async test(acct) {
    const res = await http('GET', `${acct.baseUrl}/areas?post_code=1207`, auth(acct));
    if (res.status === 401) throw new CourierError('RedX didn’t accept the token. Check it’s the one for this mode (sandbox or live).', res.body);
    if (res.status >= 400) throw new CourierError(`RedX had a problem: ${reason(res.body)}`, res.body);
    return `Connected to RedX (${acct.live ? 'live' : 'sandbox'}).`;
  },
};
