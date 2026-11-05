import { createHash, timingSafeEqual } from 'node:crypto';
import type { Payment } from '../../generated/prisma/client.js';
import { type Account, type Gateway, GatewayError, type Outcome } from './types.js';

/**
 * SSLCommerz (API v4), per developer.sslcommerz.com/doc/v4: Rocket (its "DBBL Mobile Banking" gateway)
 * and cards. A session gives the hosted payment page; the shopper's browser is posted back to our
 * return URL, and SSLCommerz's server posts an IPN. Neither proves anything by itself: the payment is
 * confirmed with the validation API (and the IPN's signature is checked first).
 */
const BASE = { sandbox: 'https://sandbox.sslcommerz.com', live: 'https://securepay.sslcommerz.com' };
/** The hosted page shows only these (Rocket also skips it: see `start`). */
const GATEWAY_CODES = { rocket: 'dbblmobilebanking', card: 'visacard,mastercard,amexcard' } as const;
const PAID = new Set(['VALID', 'VALIDATED']);
const md5 = (s: string) => createHash('md5').update(s).digest('hex');

type Reply = Record<string, unknown>;

async function get(acct: Account, path: string, params: Record<string, string>): Promise<Reply> {
  const qs = new URLSearchParams({ ...params, store_id: acct.creds.storeId, store_passwd: acct.creds.storePassword, format: 'json' });
  const res = await fetch(`${acct.baseUrl}${path}?${qs}`, { signal: AbortSignal.timeout(30_000) });
  const text = await res.text();
  try {
    return JSON.parse(text) as Reply;
  } catch {
    throw new GatewayError(`SSLCommerz answered with a non-JSON page (HTTP ${res.status}).`);
  }
}

/** Validates a completed attempt by its val_id and checks it's this payment, in taka, for this amount. */
async function validate(acct: Account, p: Payment, valId: string): Promise<Outcome> {
  const b = await get(acct, '/validator/api/validationserverAPI.php', { val_id: valId, v: '1' });
  const status = String(b.status ?? '');
  if (!PAID.has(status)) return { status: 'FAILED', error: `SSLCommerz didn’t validate the payment (${status || 'no status'}).`, raw: b };
  if (b.tran_id !== p.invoice) return { status: 'FAILED', error: 'SSLCommerz validated a different transaction.', raw: b };
  if (b.currency_type && b.currency_type !== 'BDT') return { status: 'FAILED', error: `Paid in ${String(b.currency_type)} instead of taka.`, raw: b };
  return {
    status: 'PAID',
    trxId: String(b.bank_tran_id ?? valId),
    amount: Number(b.currency_amount ?? b.amount),
    // SSLCommerz asks merchants to hold risky payments until the customer is verified.
    error: String(b.risk_level) === '1' ? `SSLCommerz flagged this payment as risky (${String(b.risk_title ?? 'risk level 1')}): check the customer before shipping.` : undefined,
    raw: b,
  };
}

async function query(acct: Account, p: Payment): Promise<Outcome> {
  const b = await get(acct, '/validator/api/merchantTransIDvalidationAPI.php', { tran_id: p.invoice });
  const attempts = (Array.isArray(b.element) ? b.element : []) as Reply[];
  const paid = attempts.find((a) => PAID.has(String(a.status)));
  if (paid?.val_id) return validate(acct, p, String(paid.val_id));
  const states = new Set(attempts.map((a) => String(a.status)));
  if (!attempts.length || states.has('PENDING') || states.has('UNATTEMPTED') || states.has('INVALID')) return { status: 'PENDING', raw: b };
  if (states.has('CANCELLED')) return { status: 'CANCELLED', raw: b };
  return { status: 'FAILED', error: 'The SSLCommerz payment failed or expired.', raw: b };
}

/** An IPN is from SSLCommerz if verify_sign = md5 of the listed fields plus md5(store password), sorted by name. */
function signed(body: Record<string, string>, password: string) {
  if (!body.verify_key || !body.verify_sign) return false;
  const fields: Record<string, string> = { store_passwd: md5(password) };
  for (const k of body.verify_key.split(',')) if (k in body) fields[k] = body[k];
  const text = Object.keys(fields)
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join('&');
  const expected = Buffer.from(md5(text));
  const got = Buffer.from(String(body.verify_sign).toLowerCase());
  return expected.length === got.length && timingSafeEqual(expected, got);
}

export const sslcommerz: Gateway = {
  id: 'sslcommerz',
  name: 'SSLCommerz',
  fields: [
    { key: 'storeId', label: 'Store ID', secret: false },
    { key: 'storePassword', label: 'Store password', secret: true, hint: 'The API password SSLCommerz emails you, not the merchant panel login.' },
    { key: 'baseUrl', label: 'API base URL', secret: false, optional: true, hint: 'Only if SSLCommerz gives you a different one. Standard: sandbox.sslcommerz.com / securepay.sslcommerz.com.' },
  ],
  baseUrl: (live) => (live ? BASE.live : BASE.sandbox),

  async start(acct, input) {
    if (input.amount < 10) throw new GatewayError('SSLCommerz takes payments of ৳10 or more.');
    const c = input.customer;
    const form = new URLSearchParams({
      store_id: acct.creds.storeId,
      store_passwd: acct.creds.storePassword,
      total_amount: input.amount.toFixed(2),
      currency: 'BDT',
      tran_id: input.invoice,
      success_url: input.callbackUrl,
      fail_url: input.callbackUrl,
      cancel_url: input.callbackUrl,
      ipn_url: input.callbackUrl.replace(/\/return\/[^/]+$/, '/ipn'),
      multi_card_name: GATEWAY_CODES[input.method as 'rocket' | 'card'] ?? '',
      cus_name: c.name.slice(0, 50),
      cus_email: c.email.slice(0, 50),
      cus_add1: c.street.slice(0, 50),
      cus_city: c.city.slice(0, 50),
      cus_postcode: c.postal.slice(0, 30),
      cus_country: c.country.slice(0, 50),
      cus_phone: (c.phone || 'N/A').slice(0, 20),
      shipping_method: 'NO', // Cartly ships the order itself
      num_of_item: String(input.items.reduce((n, i) => n + i.qty, 0)),
      product_name: input.items.map((i) => i.name).join(', ').slice(0, 255),
      product_category: 'Fashion',
      product_profile: 'physical-goods',
      value_a: input.orderId,
    });
    const res = await fetch(`${acct.baseUrl}/gwprocess/v4/api.php`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form,
      signal: AbortSignal.timeout(30_000),
    });
    let b: Reply;
    try {
      b = (await res.json()) as Reply;
    } catch {
      throw new GatewayError(`SSLCommerz answered with a non-JSON page (HTTP ${res.status}).`);
    }
    if (b.status !== 'SUCCESS' || !b.GatewayPageURL || !b.sessionkey) {
      throw new GatewayError(`SSLCommerz couldn’t start the payment: ${String(b.failedreason ?? 'no reason given')}.`, b);
    }
    // Rocket goes straight to its own page instead of the full list of methods.
    let url = String(b.GatewayPageURL);
    if (input.method === 'rocket') {
      const entry = ((b.desc ?? []) as Reply[]).find((d) => d.gw === GATEWAY_CODES.rocket && d.redirectGatewayURL);
      url = entry ? String(entry.redirectGatewayURL) : b.redirectGatewayURL ? `${String(b.redirectGatewayURL)}${GATEWAY_CODES.rocket}` : url;
    }
    return { reference: String(b.sessionkey), redirectUrl: url, raw: { sessionkey: b.sessionkey, GatewayPageURL: b.GatewayPageURL, store_name: b.store_name } };
  },

  async confirm(acct, p, params) {
    if (params.tran_id && params.tran_id !== p.invoice) throw new GatewayError('That SSLCommerz payment doesn’t belong to this order.');
    if (params.status === 'CANCELLED') return { status: 'CANCELLED', raw: params };
    if (params.status === 'FAILED') return { status: 'FAILED', error: String(params.error || 'The payment was declined.'), raw: params };
    if (params.val_id) return validate(acct, p, params.val_id);
    return query(acct, p);
  },

  async notify(acct, body) {
    if (!body.tran_id || !signed(body, acct.creds.storePassword)) return null;
    const p = { invoice: body.tran_id } as Payment;
    const outcome: Outcome = PAID.has(body.status)
      ? await validate(acct, p, body.val_id)
      : body.status === 'CANCELLED'
        ? { status: 'CANCELLED', raw: body }
        : body.status === 'FAILED' || body.status === 'EXPIRED'
          ? { status: 'FAILED', error: `The payment ${body.status.toLowerCase()}.`, raw: body }
          : { status: 'PENDING', raw: body };
    return { invoice: body.tran_id, outcome };
  },

  query,

  async refund(acct, p, amount, why) {
    if (!p.trxId) throw new GatewayError('This payment has no SSLCommerz bank transaction id to refund.');
    const b = await get(acct, '/validator/api/merchantTransIDvalidationAPI.php', {
      bank_tran_id: p.trxId,
      // Our own unique id for the refund (required since February 2025).
      refund_trans_id: `${p.invoice}R${Date.now().toString(36).toUpperCase()}`.slice(0, 30),
      refund_amount: amount.toFixed(2),
      refund_remarks: why.slice(0, 255),
      refe_id: p.invoice,
    });
    if (b.APIConnect !== 'DONE' || !['success', 'processing'].includes(String(b.status))) {
      throw new GatewayError(`SSLCommerz didn’t accept the refund: ${String(b.errorReason ?? b.APIConnect ?? 'no reason given')}.`, b);
    }
    return { refundId: String(b.refund_ref_id ?? ''), raw: b };
  },

  async test(acct) {
    const b = await get(acct, '/validator/api/merchantTransIDvalidationAPI.php', { tran_id: 'CARTLYCONNECTIONTEST' });
    if (b.APIConnect === 'FAILED') throw new GatewayError('SSLCommerz didn’t accept the store ID and password.');
    if (b.APIConnect === 'INACTIVE') throw new GatewayError('SSLCommerz says this store isn’t active yet.');
    if (b.APIConnect !== 'DONE') throw new GatewayError(`SSLCommerz answered: ${String(b.APIConnect ?? 'nothing')}.`);
    return `Connected to SSLCommerz (${acct.live ? 'live' : 'sandbox'}).`;
  },
};
