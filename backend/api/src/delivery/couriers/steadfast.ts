import type { ShipmentStatus } from '../../generated/prisma/client.js';
import { type Account, type Courier, CourierError, http, humanize, sameSecret } from './types.js';

/**
 * Steadfast Courier (Packzy) API v1, per the official Laravel package and WordPress plugin:
 *   POST /create_order with the invoice and address (no area lists) → consignment_id + tracking_code →
 *   webhooks (Bearer token set in the Steadfast panel), or GET /status_by_cid/{id}.
 * There's no sandbox: every order is a real parcel, so the store books with it in live mode only.
 * Failed sign-ins count towards a lockout, so nothing here retries on 401.
 */
const BASE = 'https://portal.packzy.com/api/v1';

/** Steadfast's delivery_status values onto ours. null: waiting on Steadfast's review; keep the status. */
const STATUS: Record<string, ShipmentStatus | null> = {
  in_review: 'BOOKED',
  pending: 'IN_TRANSIT', // accepted and on its way through Steadfast
  hold: 'FAILED_ATTEMPT',
  delivered: 'DELIVERED',
  partial_delivered: 'DELIVERED',
  cancelled: 'CANCELLED', // becomes RETURNED if it had been picked up
  delivered_approval_pending: null,
  partial_delivered_approval_pending: null,
  cancelled_approval_pending: null,
  unknown_approval_pending: null,
  unknown: null,
};
const statusOf = (s: unknown) => STATUS[String(s ?? '').toLowerCase()] ?? null;

type Reply = Record<string, unknown>;
const headers = (acct: Account) => ({ 'Api-Key': acct.creds.apiKey, 'Secret-Key': acct.creds.secretKey });
const reason = (b: Reply) => {
  const errors = b.errors as Record<string, string[]> | undefined;
  return String((errors && Object.values(errors).flat()[0]) ?? b.message ?? 'Steadfast had a problem');
};
const failed = (r: { status: number; body: Reply }) => r.status >= 400 || (r.body.status != null && Number(r.body.status) !== 200);

export const steadfast: Courier = {
  id: 'steadfast',
  name: 'Steadfast',
  noSandbox: true,
  fields: [
    { key: 'apiKey', label: 'API key', secret: true, hint: 'Steadfast panel → API. There’s no test account: bookings are real parcels.' },
    { key: 'secretKey', label: 'Secret key', secret: true },
    { key: 'webhookToken', label: 'Webhook bearer token', secret: true, optional: true, hint: 'Make up a long random token, and enter the same one as the “Auth Token (Bearer)” with the webhook URL in Steadfast’s panel.' },
  ],
  baseUrl: () => BASE,
  // Steadfast's tracking page takes the link from its SMS, not the code; customers get the code to type in.
  publicTrackingUrl: () => 'https://steadfast.com.bd/tracking',
  levels: [],

  async book(acct, input) {
    const res = await http('POST', `${acct.baseUrl}/create_order`, headers(acct), {
      invoice: input.invoice,
      recipient_name: input.recipient.name.slice(0, 100),
      recipient_phone: input.recipient.phone,
      recipient_address: `${input.recipient.address}, ${input.recipient.city}`.slice(0, 250),
      cod_amount: Math.round(input.codAmount),
      note: input.note,
      item_description: input.description,
      total_lot: input.itemCount,
    });
    const c = res.body.consignment as Reply | undefined;
    if (failed(res) || !c?.consignment_id) throw new CourierError(`Steadfast didn’t book it: ${reason(res.body)}`, res.body);
    return {
      consignmentId: String(c.consignment_id),
      trackingCode: c.tracking_code ? String(c.tracking_code) : undefined,
      courierStatus: humanize(c.status) || undefined,
      status: statusOf(c.status) ?? 'BOOKED',
      raw: res.body,
    };
  },

  async track(acct, s) {
    const res = await http('GET', `${acct.baseUrl}/status_by_cid/${encodeURIComponent(s.consignmentId ?? '')}`, headers(acct));
    if (failed(res) || !res.body.delivery_status) throw new CourierError(`Steadfast didn’t find ${s.consignmentId}: ${reason(res.body)}`, res.body);
    return { status: statusOf(res.body.delivery_status), courierStatus: humanize(res.body.delivery_status), raw: res.body };
  },

  webhookAuth: 'header',
  async webhook(acct, { headers: h, query, body }) {
    const expected = acct.creds.webhookToken;
    const given = h.authorization?.replace(/^Bearer\s+/i, '') ?? query.token;
    if (!sameSecret(given, expected)) return null;
    if (!body.consignment_id && !body.invoice) return { updates: [], status: 200 };
    const tracking = body.notification_type === 'tracking_update';
    const text = body.tracking_message ? String(body.tracking_message) : humanize(body.status);
    return {
      status: 200,
      updates: [
        {
          consignmentId: body.consignment_id != null ? String(body.consignment_id) : undefined,
          invoice: body.invoice ? String(body.invoice) : undefined,
          status: tracking ? null : statusOf(body.status),
          courierStatus: tracking ? text : humanize(body.status),
          message: text || 'Update from Steadfast',
          // Steadfast's times are Bangladesh time without a zone.
          at: body.updated_at ? new Date(`${String(body.updated_at).replace(' ', 'T')}+06:00`) : undefined,
          charge: body.delivery_charge != null ? Number(body.delivery_charge) : undefined,
          codCollected: !tracking && statusOf(body.status) === 'DELIVERED' && body.cod_amount != null ? Number(body.cod_amount) : undefined,
          raw: body,
        },
      ],
    };
  },

  async test(acct) {
    const res = await http('GET', `${acct.baseUrl}/get_balance`, headers(acct));
    if (failed(res)) throw new CourierError(`Steadfast didn’t accept the keys: ${reason(res.body)}`, res.body);
    return `Connected to Steadfast. Balance: ৳${Number(res.body.current_balance ?? 0)}.`;
  },
};
