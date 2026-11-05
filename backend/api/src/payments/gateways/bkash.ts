import { createHash } from 'node:crypto';
import type { Payment } from '../../generated/prisma/client.js';
import { type Account, type Gateway, GatewayError, type Outcome } from './types.js';

/**
 * bKash Tokenized Checkout v2 (payment without agreement), per developer.bka.sh:
 *   grant a token → create a payment → the shopper approves it on bKash's page → bKash sends them back
 *   to our callback with ?paymentID=&status= → we execute it (only that completes it) → query to check.
 * bKash allows only two token requests (grant or refresh) an hour and blocks the app for an hour past
 * that, so the token is cached in Redis for every API instance and fetched by one caller at a time.
 */
const BASE = {
  sandbox: 'https://tokenized.sandbox.bka.sh/v2/tokenized-checkout',
  live: 'https://tokenized.pay.bka.sh/v2/tokenized-checkout',
};
const HOUR = 3600;
// Execute answered "already done" or "not in a state to execute": ask what actually happened.
const ASK_AGAIN = new Set(['2056', '2062', '2068', '2117']);

type Reply = Record<string, unknown>;

async function post(url: string, headers: Record<string, string>, body: Reply): Promise<{ status: number; body: Reply }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) as Reply };
  } catch {
    return { status: res.status, body: { message: text.slice(0, 300) } };
  }
}

const code = (b: Reply) => String(b.externalCode ?? b.errorCode ?? (b.statusCode !== '0000' ? (b.statusCode ?? '') : ''));
const failed = (r: { status: number; body: Reply }) => r.status >= 400 || !!code(r.body) || (!!r.body.message && !r.body.transactionStatus);
const reason = (b: Reply) => String(b.errorMessageEn ?? b.errorMessage ?? b.statusMessage ?? b.message ?? 'bKash had a problem');

/** Tokens are cached per credentials and mode, so new credentials never reuse an old token. */
const tokenKey = (acct: Account) =>
  'bkash:token:' + createHash('sha256').update(`${acct.baseUrl}|${acct.creds.appKey}|${acct.creds.username}`).digest('hex').slice(0, 24);

interface Cached {
  id: string;
  refresh?: string;
  expires: number;
  refreshExpires: number;
}

async function token(acct: Account, renew = false): Promise<string> {
  const key = tokenKey(acct);
  const read = async () => {
    const raw = await acct.store.get(key);
    return raw ? (JSON.parse(raw) as Cached) : null;
  };
  let cached = await read();
  if (!renew && cached && cached.expires > Date.now() + 5 * 60_000) return cached.id;
  if (!(await acct.store.claim(`${key}:lock`, 30))) {
    // Another request is fetching one: wait for it rather than spending another of the hour's two.
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const next = await read();
      if (next && next.id !== cached?.id) return next.id;
    }
    throw new GatewayError('bKash is busy. Please try again in a moment.');
  }
  try {
    const { appKey, appSecret, username, password } = acct.creds;
    const auth = { username, password };
    let res: { status: number; body: Reply } | null = null;
    if (cached?.refresh && cached.refreshExpires > Date.now()) {
      res = await post(`${acct.baseUrl}/auth/refresh-token`, auth, { app_key: appKey, app_secret: appSecret, refresh_token: cached.refresh });
    }
    if (!res || res.body.statusCode !== '0000') res = await post(`${acct.baseUrl}/auth/grant-token`, auth, { app_key: appKey, app_secret: appSecret });
    // Wrong credentials still come back as HTTP 200, with statusCode 9999.
    if (res.body.statusCode !== '0000' || !res.body.id_token) {
      throw new GatewayError(`bKash didn’t accept the credentials: ${reason(res.body)}.`, res.body);
    }
    cached = {
      id: String(res.body.id_token),
      refresh: res.body.refresh_token ? String(res.body.refresh_token) : cached?.refresh,
      expires: Date.now() + Number(res.body.expires_in ?? HOUR) * 1000,
      refreshExpires: res.body.refresh_token ? Date.now() + 29 * 24 * HOUR * 1000 : (cached?.refreshExpires ?? 0),
    };
    await acct.store.set(key, JSON.stringify(cached), 30 * 24 * HOUR);
    return cached.id;
  } finally {
    await acct.store.del(`${key}:lock`);
  }
}

/** A payment API call, re-authenticating once if the token was rejected. */
async function api(acct: Account, path: string, body: Reply) {
  const call = async (t: string) => post(`${acct.baseUrl}${path}`, { authorization: t, 'x-app-key': acct.creds.appKey }, body);
  let res = await call(await token(acct));
  if (res.status === 401) res = await call(await token(acct, true));
  return res;
}

function outcome(b: Reply): Outcome {
  const status = String(b.transactionStatus ?? '');
  const trxId = (b.trxId ?? b.trxID) as string | undefined;
  if (status === 'Completed' && trxId) return { status: 'PAID', trxId, amount: Number(b.amount), raw: b };
  if (status === 'Cancelled') return { status: 'CANCELLED', raw: b };
  if (status === 'Failed' || status === 'Expired') return { status: 'FAILED', error: `The bKash payment ${status.toLowerCase()}.`, raw: b };
  return { status: 'PENDING', raw: b }; // Initiated: not approved yet (or the shopper left)
}

async function query(acct: Account, p: Payment): Promise<Outcome> {
  if (!p.reference) return { status: 'FAILED', error: 'The payment never reached bKash.' };
  const res = await api(acct, '/query/payment', { paymentId: p.reference });
  if (failed(res)) return { status: 'PENDING', error: reason(res.body), raw: res.body };
  return outcome(res.body);
}

export const bkash: Gateway = {
  id: 'bkash',
  name: 'bKash',
  fields: [
    { key: 'username', label: 'Username', secret: false, hint: 'From bKash’s merchant onboarding (the sandbox username for testing).' },
    { key: 'password', label: 'Password', secret: true },
    { key: 'appKey', label: 'App key', secret: true },
    { key: 'appSecret', label: 'App secret', secret: true },
  ],
  baseUrl: (live) => (live ? BASE.live : BASE.sandbox),

  async start(acct, input) {
    const res = await api(acct, '/payment/create', {
      // Pre-fills the shopper's wallet number on bKash's page when we have it.
      payerReference: input.customer.phone?.replace(/[^\d+]/g, '') || input.invoice,
      callbackURL: input.callbackUrl,
      amount: input.amount.toFixed(2),
      currency: 'BDT',
      intent: 'sale',
      merchantInvoiceNumber: input.invoice,
    });
    const paymentId = (res.body.paymentId ?? res.body.paymentID) as string | undefined;
    const url = (res.body.bkashURL ?? res.body.bKashURL) as string | undefined;
    if (failed(res) || !paymentId || !url) throw new GatewayError(`bKash couldn’t start the payment: ${reason(res.body)}.`, res.body);
    return { reference: paymentId, redirectUrl: url, raw: res.body };
  },

  async confirm(acct, p, params) {
    // The callback comes through the shopper's browser, so it only says which payment to look at.
    if (params.paymentID && params.paymentID !== p.reference) throw new GatewayError('That bKash payment doesn’t belong to this order.');
    if (params.status === 'cancel') return { status: 'CANCELLED', raw: params };
    if (params.status === 'failure') return { status: 'FAILED', error: 'The bKash payment didn’t go through.', raw: params };
    let res: { status: number; body: Reply };
    try {
      res = await api(acct, '/payment/execute', { paymentId: p.reference });
    } catch {
      return query(acct, p); // a timeout isn't a failure: bKash may have completed it
    }
    if (!failed(res)) {
      const o = outcome(res.body);
      if (o.status !== 'PENDING') return o;
    }
    if (ASK_AGAIN.has(code(res.body)) || res.status >= 500) return query(acct, p);
    return { status: 'FAILED', error: reason(res.body), raw: res.body };
  },

  query,

  async refund(acct, p, amount, why) {
    const res = await api(acct, '/refund/payment/transaction', {
      paymentId: p.reference,
      trxId: p.trxId,
      refundAmount: amount.toFixed(2),
      sku: p.invoice,
      reason: why.slice(0, 255),
    });
    if (failed(res) || res.body.refundTransactionStatus !== 'Completed') throw new GatewayError(`bKash didn’t refund it: ${reason(res.body)}.`, res.body);
    return { refundId: String(res.body.refundTrxId ?? ''), raw: res.body };
  },

  async test(acct) {
    await token(acct);
    return `Connected to bKash (${acct.live ? 'live' : 'sandbox'}).`;
  },
};
