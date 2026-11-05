import { constants, createPrivateKey, createPublicKey, type KeyObject, privateDecrypt, publicEncrypt, randomBytes, sign } from 'node:crypto';
import type { Payment } from '../../generated/prisma/client.js';
import { type Account, type Gateway, GatewayError, type Outcome } from './types.js';

/**
 * Nagad's online payment gateway (API v-0.2.0), per Nagad's integration guide and the maintained
 * open-source integrations:
 *   initialize (encrypted, signed) → complete with the returned challenge → the shopper pays on Nagad's
 *   page → Nagad sends them to our registered callback URL (?payment_ref_id=&order_id=&status=) →
 *   we verify the payment with Nagad (plain JSON) and check it's ours and for the right amount.
 * Every request's `sensitiveData` is RSA-encrypted (PKCS#1 v1.5) with Nagad's public key and signed
 * (SHA256withRSA) with the merchant's private key. Nagad has no public refund API.
 */
const BASE = {
  sandbox: 'http://sandbox.mynagad.com:30001/api/dfs',
  live: 'https://api.mynagad.com/api/dfs',
};

type Reply = Record<string, unknown>;

/** Nagad gives keys as bare base64 DER (X.509 public, PKCS#8 private); PEM text works too. */
function publicKey(text: string): KeyObject {
  const t = text.trim();
  return t.includes('-----BEGIN') ? createPublicKey(t) : createPublicKey({ key: Buffer.from(t.replace(/\s+/g, ''), 'base64'), format: 'der', type: 'spki' });
}
function privateKey(text: string): KeyObject {
  const t = text.trim();
  if (t.includes('-----BEGIN')) return createPrivateKey(t);
  const der = Buffer.from(t.replace(/\s+/g, ''), 'base64');
  // PKCS#1 keys (from `openssl genrsa`) start MIIEp… / MIIEo…; Nagad's own are PKCS#8 (MIIEv…).
  const pkcs1 = /^MIIE[op]/.test(t);
  return createPrivateKey({ key: der, format: 'der', type: pkcs1 ? 'pkcs1' : 'pkcs8' });
}

function seal(acct: Account, data: Reply) {
  const text = Buffer.from(JSON.stringify(data), 'utf8');
  return {
    sensitiveData: publicEncrypt({ key: publicKey(acct.creds.nagadPublicKey), padding: constants.RSA_PKCS1_PADDING }, text).toString('base64'),
    signature: sign('sha256', text, privateKey(acct.creds.merchantPrivateKey)).toString('base64'),
  };
}

function unseal(acct: Account, sensitiveData: string): Reply {
  const text = privateDecrypt({ key: privateKey(acct.creds.merchantPrivateKey), padding: constants.RSA_PKCS1_PADDING }, Buffer.from(sensitiveData, 'base64'));
  try {
    return JSON.parse(text.toString('utf8')) as Reply;
  } catch {
    // A wrong private key decrypts to noise instead of failing.
    throw new GatewayError('Nagad’s reply couldn’t be read: check the merchant private key.');
  }
}

/** yyyyMMddHHmmss in Bangladesh time (UTC+6, no daylight saving). */
const dhakaNow = () => new Date(Date.now() + 6 * 3600_000).toISOString().replace(/[-:T]/g, '').slice(0, 14);
/** Nagad wants the shopper's IPv4 address on every call. */
const ipv4 = (ip?: string) => (ip?.replace(/^::ffff:/, '').match(/^\d{1,3}(\.\d{1,3}){3}$/) ? ip.replace(/^::ffff:/, '') : '127.0.0.1');

async function call(acct: Account, method: 'GET' | 'POST', path: string, body?: Reply, ip?: string): Promise<{ status: number; body: Reply }> {
  const res = await fetch(`${acct.baseUrl}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      'X-KM-Api-Version': 'v-0.2.0',
      'X-KM-IP-V4': ipv4(ip),
      'X-KM-Client-Type': 'PC_WEB',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) as Reply };
  } catch {
    // e.g. an HTML page from Nagad's firewall when the server's IP isn't whitelisted
    return { status: res.status, body: { message: `Nagad answered with a non-JSON page (HTTP ${res.status}); check that this server’s IP is whitelisted.` } };
  }
}

const reason = (b: Reply) => String(b.message ?? b.reason ?? 'Nagad had a problem');

async function verify(acct: Account, p: Payment): Promise<Outcome> {
  if (!p.reference) return { status: 'FAILED', error: 'The payment never reached Nagad.' };
  const res = await call(acct, 'GET', `/verify/payment/${encodeURIComponent(p.reference)}`);
  const b = res.body;
  if (res.status >= 400 || !b.status) return { status: 'PENDING', error: reason(b), raw: b };
  // Nagad's answer must be about this merchant, this attempt and this reference.
  if (b.merchantId !== acct.creds.merchantId || b.orderId !== p.invoice || b.paymentRefId !== p.reference) {
    return { status: 'FAILED', error: 'Nagad’s record doesn’t match this payment.', raw: b };
  }
  const status = String(b.status);
  if (status === 'Success' && b.issuerPaymentRefNo) return { status: 'PAID', trxId: String(b.issuerPaymentRefNo), amount: Number(b.amount), raw: b };
  if (status === 'Cancelled' || status === 'Aborted') return { status: 'CANCELLED', raw: b };
  if (['Initiated', 'Ready', 'InProgress', 'Processing'].includes(status)) return { status: 'PENDING', raw: b };
  return { status: 'FAILED', error: `The Nagad payment ended as “${status}”.`, raw: b };
}

export const nagad: Gateway = {
  id: 'nagad',
  name: 'Nagad',
  fields: [
    { key: 'merchantId', label: 'Merchant ID', secret: false, hint: 'The 15-digit ID from Nagad.' },
    { key: 'merchantNumber', label: 'Merchant number', secret: false, optional: true, hint: 'The merchant wallet’s 11-digit mobile number.' },
    { key: 'merchantPrivateKey', label: 'Merchant private key', secret: true, multiline: true, hint: 'Base64 (as Nagad gives it) or PEM.' },
    { key: 'nagadPublicKey', label: 'Nagad payment gateway public key', secret: false, multiline: true, hint: 'Base64 (as Nagad gives it) or PEM.' },
    {
      key: 'baseUrl',
      label: 'API base URL',
      secret: false,
      optional: true,
      hint: 'Only if Nagad’s onboarding email gives a different one. Standard: sandbox http://sandbox.mynagad.com:30001/api/dfs, live https://api.mynagad.com/api/dfs.',
    },
  ],
  baseUrl: (live) => (live ? BASE.live : BASE.sandbox),
  invoiceOf: (params) => params.order_id,

  async start(acct, input) {
    const { merchantId, merchantNumber } = acct.creds;
    const dateTime = dhakaNow();
    const init = await call(
      acct,
      'POST',
      `/check-out/initialize/${merchantId}/${input.invoice}`,
      {
        ...(merchantNumber ? { accountNumber: merchantNumber } : {}),
        dateTime,
        ...seal(acct, { merchantId, datetime: dateTime, orderId: input.invoice, challenge: randomBytes(20).toString('hex').toUpperCase() }),
      },
      input.ip,
    );
    if (init.status >= 400 || !init.body.sensitiveData) throw new GatewayError(`Nagad couldn’t start the payment: ${reason(init.body)}.`, init.body);
    const session = unseal(acct, String(init.body.sensitiveData));
    const reference = session.paymentReferenceId as string | undefined;
    const challenge = (session.challenge ?? session.random) as string | undefined;
    if (!reference || !challenge) throw new GatewayError('Nagad didn’t return a payment reference.', { ...init.body, sensitiveData: undefined });

    const done = await call(
      acct,
      'POST',
      `/check-out/complete/${encodeURIComponent(reference)}`,
      {
        ...seal(acct, { merchantId, orderId: input.invoice, currencyCode: '050', amount: input.amount.toFixed(2), challenge }),
        merchantCallbackURL: input.callbackUrl,
        additionalMerchantInfo: { serviceName: 'Cartly' },
      },
      input.ip,
    );
    const url = done.body.callBackUrl as string | undefined;
    if (done.status >= 400 || done.body.status !== 'Success' || !url) throw new GatewayError(`Nagad couldn’t start the payment: ${reason(done.body)}.`, done.body);
    // Only ever send shoppers to Nagad's own pages (when talking to Nagad itself, not a test double).
    if (acct.baseUrl.includes('mynagad.com') && !/^https?:\/\/([a-z0-9-]+\.)*mynagad\.com(:\d+)?\//i.test(url)) {
      throw new GatewayError('Nagad returned an unexpected payment page address.', done.body);
    }
    return { reference, redirectUrl: url, raw: { paymentReferenceId: reference, acceptDateTime: session.acceptDateTime, complete: done.body } };
  },

  async confirm(acct, p, params) {
    if (params.payment_ref_id && params.payment_ref_id !== p.reference) throw new GatewayError('That Nagad payment doesn’t belong to this order.');
    // The callback's status isn't signed: whatever it says, Nagad's own record decides.
    return verify(acct, p);
  },

  query: verify,

  async test(acct) {
    // Loading both keys and making a signed, encrypted payload catches most setup mistakes without calling Nagad.
    seal(acct, { check: dhakaNow() });
    const res = await call(acct, 'GET', `/verify/payment/cartly-connection-test`);
    if (res.status >= 500 || /whitelist/i.test(String(res.body.message ?? ''))) throw new GatewayError(reason(res.body));
    return `Keys load, and Nagad (${acct.live ? 'live' : 'sandbox'}) is reachable. A real test payment confirms the merchant ID and keys.`;
  },
};
