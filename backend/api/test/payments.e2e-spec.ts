// Payments end to end: bKash, Nagad and SSLCommerz (Rocket, cards) against local stand-ins that speak
// each gateway's protocol (Nagad's RSA encryption and signatures, SSLCommerz's signed IPN), plus cash on
// delivery. Uses the real local Postgres + Redis; the store's payment settings are put back afterwards.
import { createHash, constants, generateKeyPairSync, privateDecrypt, publicEncrypt, sign, verify } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import type { PrismaService as Prisma } from '../src/common/infra.module.js';
import type { PaymentsService as Payments } from '../src/payments/payments.service.js';

let app: INestApplication;
let db: Prisma;
let payments: Payments;
let server: Server;
const api = () => request(app.getHttpServer());
const DOMAIN = '@payments-e2e.test';
let admin = '';
let shopper = '';
const as = (token: string) => ({ Authorization: `Bearer ${token}` });
const RATE = 122.5;
const ADDRESS = { name: 'Rahim Uddin', street: 'House 12, Road 5, Dhanmondi', city: 'Dhaka', postal: '1205', country: 'Bangladesh', phone: '01711000000' };

/* ---------- gateway stand-ins ---------- */

const bkash = { grants: 0, token: '', payments: new Map<string, { amount: string; invoice: string; status: string; trxId?: string }>(), lie: false, refuseRefunds: false };
const merchantKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const nagadKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const b64 = (k: { export(o: object): Buffer | string }, type: 'spki' | 'pkcs8') => (k.export({ format: 'der', type }) as Buffer).toString('base64');
const nagad = { merchantId: '683002007104225', sessions: new Map<string, { orderId: string; amount?: string; paid: boolean }>() };
const ssl = { storeId: 'cartlytest', password: 'secret-pass', sessions: new Map<string, { amount: string; paid: boolean }>() };
const md5 = (s: string) => createHash('md5').update(s).digest('hex');

function stand_ins(req: import('node:http').IncomingMessage, body: string): [number, object] {
  const url = new URL(req.url!, 'http://x');
  const json = () => JSON.parse(body || '{}');
  const path = url.pathname;
  if (path.startsWith('/bkash/')) {
    const p = path.slice('/bkash'.length);
    if (p === '/auth/grant-token') {
      const b = json();
      if (req.headers.username !== 'sandboxUser' || req.headers.password !== 'pw-hidden-1' || b.app_key !== 'key' || b.app_secret !== 'app-secret-hidden-2') {
        return [200, { statusCode: '9999', statusMessage: 'Invalid credentials' }];
      }
      bkash.grants++;
      bkash.token = `tok-${bkash.grants}`;
      return [200, { statusCode: '0000', id_token: bkash.token, refresh_token: 'refresh', expires_in: 3600 }];
    }
    if (req.headers.authorization !== bkash.token || req.headers['x-app-key'] !== 'key') return [401, { message: 'Unauthorized' }];
    const b = json();
    if (p === '/payment/create') {
      const paymentId = `TR00${bkash.payments.size + 1}`;
      bkash.payments.set(paymentId, { amount: b.amount, invoice: b.merchantInvoiceNumber, status: 'Initiated' });
      return [200, { paymentId, bkashURL: `https://sandbox.payment.bkash.com/?paymentId=${paymentId}`, transactionStatus: 'Initiated', amount: b.amount, signature: 'sig' }];
    }
    const pay = bkash.payments.get(b.paymentId);
    if (!pay) return [200, { externalCode: '2002', errorMessageEn: 'Invalid Payment ID' }];
    if (p === '/payment/execute') {
      if (pay.status === 'Completed') return [200, { externalCode: '2117', errorMessageEn: 'Payment execution already been called before' }];
      pay.status = 'Completed';
      pay.trxId = `BK${b.paymentId}`;
      return [200, { paymentId: b.paymentId, trxId: pay.trxId, transactionStatus: 'Completed', amount: bkash.lie ? '1.00' : pay.amount, merchantInvoiceNumber: pay.invoice }];
    }
    if (p === '/query/payment') return [200, { paymentId: b.paymentId, transactionStatus: pay.status, trxId: pay.trxId, amount: pay.amount }];
    if (p === '/refund/payment/transaction') {
      if (bkash.refuseRefunds) return [200, { statusCode: '2029', statusMessage: 'Refund not allowed' }];
      return [200, { refundTrxId: 'RF1', refundTransactionStatus: 'Completed', refundAmount: b.refundAmount }];
    }
  }
  if (path.startsWith('/nagad/')) {
    const p = path.slice('/nagad'.length);
    const open = (data: string) => {
      const text = privateDecrypt({ key: nagadKeys.privateKey, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(data, 'base64'));
      return { text, value: JSON.parse(text.toString()) };
    };
    const signedBy = (text: Buffer, sig: string) => verify('sha256', text, merchantKeys.publicKey, Buffer.from(sig, 'base64'));
    if (req.headers['x-km-api-version'] !== 'v-0.2.0' || !req.headers['x-km-ip-v4']) return [400, { reason: '16_0006_064', message: 'Mandatory Header Missing' }];
    let m = p.match(/^\/check-out\/initialize\/(\d+)\/(\w+)$/);
    if (m) {
      const b = json();
      const { text, value } = open(b.sensitiveData);
      if (!signedBy(text, b.signature) || value.merchantId !== m[1] || value.orderId !== m[2] || !/^\d{14}$/.test(value.datetime) || value.datetime !== b.dateTime) {
        return [400, { reason: '16_0006_059', message: 'Invalid request' }];
      }
      const ref = `REF${m[2]}`;
      nagad.sessions.set(ref, { orderId: m[2], paid: false });
      const out = Buffer.from(JSON.stringify({ paymentReferenceId: ref, challenge: 'NAGADCHALLENGE', acceptDateTime: value.datetime }));
      return [200, { sensitiveData: publicEncrypt({ key: merchantKeys.publicKey, padding: constants.RSA_PKCS1_PADDING }, out).toString('base64'), signature: sign('sha256', out, nagadKeys.privateKey).toString('base64') }];
    }
    m = p.match(/^\/check-out\/complete\/(.+)$/);
    if (m) {
      const b = json();
      const { text, value } = open(b.sensitiveData);
      const s = nagad.sessions.get(decodeURIComponent(m[1]));
      if (!s || !signedBy(text, b.signature) || value.challenge !== 'NAGADCHALLENGE' || value.currencyCode !== '050' || !b.merchantCallbackURL) return [400, { message: 'Invalid' }];
      s.amount = value.amount;
      return [200, { callBackUrl: `http://sandbox.mynagad.com:10060/check-out/${m[1]}`, status: 'Success' }];
    }
    m = p.match(/^\/verify\/payment\/(.+)$/);
    if (m) {
      const s = nagad.sessions.get(decodeURIComponent(m[1]));
      if (!s) return [404, { reason: '16_0004_999', message: 'Payment not found' }];
      return [200, { merchantId: nagad.merchantId, orderId: s.orderId, paymentRefId: m[1], amount: s.amount, status: s.paid ? 'Success' : 'Ready', issuerPaymentRefNo: s.paid ? 'NG7788' : null }];
    }
  }
  if (path.startsWith('/ssl/')) {
    const p = path.slice('/ssl'.length);
    const q = Object.fromEntries(url.searchParams);
    const f = Object.fromEntries(new URLSearchParams(body));
    const creds = (x: Record<string, string>) => x.store_id === ssl.storeId && x.store_passwd === ssl.password;
    if (p === '/gwprocess/v4/api.php') {
      if (!creds(f)) return [200, { status: 'FAILED', failedreason: 'Store Credential Error Or Store is De-active' }];
      ssl.sessions.set(f.tran_id, { amount: f.total_amount, paid: false });
      return [200, {
        status: 'SUCCESS',
        sessionkey: `SK${f.tran_id}`,
        GatewayPageURL: `https://sandbox.sslcommerz.com/EasyCheckOut/testcde${f.tran_id}`,
        redirectGatewayURL: 'https://sandbox.sslcommerz.com/gwprocess/v4/bankgw/indexhtmlOTP.php?cardname=',
        desc: [{ gw: 'dbblmobilebanking', redirectGatewayURL: `https://sandbox.sslcommerz.com/gwprocess/v4/bankgw/indexhtmlOTP.php?cardname=dbblmobilebanking&t=${f.tran_id}` }],
      }];
    }
    if (!creds(q)) return [200, { APIConnect: 'FAILED' }];
    if (p === '/validator/api/validationserverAPI.php') {
      const tran = q.val_id.replace(/^VAL/, '');
      const s = ssl.sessions.get(tran);
      if (!s?.paid) return [200, { status: 'INVALID_TRANSACTION' }];
      return [200, { status: 'VALID', tran_id: tran, val_id: q.val_id, amount: s.amount, currency_amount: s.amount, currency_type: 'BDT', bank_tran_id: `BANK${tran}`, risk_level: '0' }];
    }
    if (p === '/validator/api/merchantTransIDvalidationAPI.php') {
      if (q.bank_tran_id) return [200, q.refund_trans_id ? { APIConnect: 'DONE', status: 'success', refund_ref_id: 'SSLRF1' } : { APIConnect: 'INVALID_REQUEST' }];
      const s = ssl.sessions.get(q.tran_id);
      return [200, { APIConnect: 'DONE', no_of_trans_found: s ? 1 : 0, element: [{ tran_id: q.tran_id, status: s ? (s.paid ? 'VALID' : 'PENDING') : 'INVALID', val_id: `VAL${q.tran_id}` }] }];
    }
  }
  return [404, { message: 'no such stand-in route' }];
}

/** An IPN as SSLCommerz signs it. */
function ipn(fields: Record<string, string>, password = ssl.password) {
  const keys = Object.keys(fields);
  const all: Record<string, string> = { ...fields, store_passwd: md5(password) };
  const text = Object.keys(all).sort().map((k) => `${k}=${all[k]}`).join('&');
  return { ...fields, verify_key: keys.join(','), verify_sign: md5(text) };
}

/* ---------- setup ---------- */

let saved: { methods: unknown[]; gateways: unknown[]; rate: unknown };

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const [status, out] = stand_ins(req, body);
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(out));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  Object.assign(process.env, { BKASH_BASE_URL: `${base}/bkash`, NAGAD_BASE_URL: `${base}/nagad`, SSLCOMMERZ_BASE_URL: `${base}/ssl` });

  // Imported after the stand-in URLs are set: config.ts reads them once.
  const { createApp } = await import('../src/main.js');
  const { PrismaService } = await import('../src/common/infra.module.js');
  const { PaymentsService } = await import('../src/payments/payments.service.js');
  app = await createApp();
  await app.init();
  db = app.get(PrismaService);
  payments = app.get(PaymentsService);
  saved = { methods: await db.paymentMethod.findMany(), gateways: await db.paymentGateway.findMany(), rate: await db.storeSetting.findUnique({ where: { key: 'usdToBdt' } }) };

  const jwt = app.get(JwtService);
  const a = await db.user.findUniqueOrThrow({ where: { email: 'admin@cartly.dev' } });
  admin = await jwt.signAsync({ sub: a.id, email: a.email, role: 'ADMIN' });
  const u = await db.user.create({ data: { email: `shopper${DOMAIN}`, name: 'Rahim Uddin', passwordHash: 'x' } });
  shopper = await jwt.signAsync({ sub: u.id, email: u.email, role: 'CUSTOMER' });
});

afterAll(async () => {
  const orders = await db.order.findMany({ where: { user: { email: { endsWith: DOMAIN } } }, include: { items: true } });
  // Put back the stock the test orders still hold.
  for (const o of orders.filter((o) => o.status !== 'CANCELLED')) {
    for (const i of o.items) await db.product.update({ where: { id: i.productId }, data: { stock: { increment: i.qty } } });
  }
  await db.orderItem.deleteMany({ where: { orderId: { in: orders.map((o) => o.id) } } });
  await db.user.deleteMany({ where: { email: { endsWith: DOMAIN } } });
  await db.$transaction([
    db.paymentMethod.deleteMany(),
    db.paymentMethod.createMany({ data: saved.methods as never }),
    db.paymentGateway.deleteMany(),
    db.paymentGateway.createMany({ data: saved.gateways as never }),
    db.storeSetting.deleteMany({ where: { key: 'usdToBdt' } }),
    ...(saved.rate ? [db.storeSetting.create({ data: saved.rate as never })] : []),
  ]);
  await app.close();
  server.close();
});

const settings = () => api().get('/api/v1/admin/payments/settings').set(as(admin)).expect(200);
const enable = (id: string, enabled = true) => api().patch('/api/v1/admin/payments/settings').set(as(admin)).send({ methods: [{ id, enabled }] });
async function fillCart(productId = 23, qty = 1) {
  await api().delete('/api/v1/cart').set(as(shopper)).expect(204);
  await api().post('/api/v1/cart/items').set(as(shopper)).send({ productId, qty }).expect(201);
}
const checkout = (method: string, address: Record<string, string> = ADDRESS) =>
  api().post('/api/v1/orders').set(as(shopper)).send({ address, delivery: 'standard', payment: { method } });
const order = (id: string) => db.order.findUniqueOrThrow({ where: { id }, include: { payments: { orderBy: { createdAt: 'asc' } } } });

/* ---------- tests ---------- */

describe('setup', () => {
  it('offers only methods that are set up, priced in taka at the admin’s rate', async () => {
    await api().patch('/api/v1/admin/payments/settings').set(as(admin)).send({ usdToBdt: RATE }).expect(200);
    await db.paymentGateway.updateMany({ data: { secrets: null, live: false } });
    await db.paymentMethod.updateMany({ where: { id: { in: ['bkash', 'nagad', 'rocket', 'card'] } }, data: { enabled: false } });
    await enable('cod').expect(200);
    const res = await api().get('/api/v1/payments/methods').expect(200);
    expect(res.body.usdToBdt).toBe(RATE);
    expect(res.body.methods.map((m: { id: string }) => m.id)).toEqual(expect.arrayContaining(['cod']));
    expect(res.body.methods.map((m: { id: string }) => m.id)).not.toContain('bkash');
    const refused = await enable('bkash').expect(400);
    expect(refused.body.message).toBe('bKash can’t be switched on yet. Add the bKash credentials first.');
  });

  it('keeps gateway credentials encrypted and never sends secrets back', async () => {
    await api()
      .put('/api/v1/admin/payments/gateways/bkash')
      .set(as(admin))
      .send({ credentials: { username: 'sandboxUser', password: 'pw-hidden-1', appKey: 'key', appSecret: 'app-secret-hidden-2' } })
      .expect(200);
    const view = await settings();
    const g = view.body.gateways.find((x: { id: string }) => x.id === 'bkash');
    expect(g.configured).toBe(true);
    expect(g.fields.find((f: { key: string }) => f.key === 'username')).toMatchObject({ set: true, value: 'sandboxUser' });
    expect(g.fields.find((f: { key: string }) => f.key === 'appSecret')).toMatchObject({ set: true, value: null });
    expect(JSON.stringify(view.body)).not.toMatch(/hidden-[12]/);
    const row = await db.paymentGateway.findUniqueOrThrow({ where: { id: 'bkash' } });
    expect(row.secrets).toMatch(/^v1:/);
    expect(row.secrets).not.toContain('sandboxUser');

    // Leaving a credential out keeps it; the test signs in to the stand-in.
    await api().put('/api/v1/admin/payments/gateways/bkash').set(as(admin)).send({ live: false, credentials: { username: 'sandboxUser' } }).expect(200);
    const test = await api().post('/api/v1/admin/payments/gateways/bkash/test').set(as(admin)).expect(200);
    expect(test.body.message).toBe('Connected to bKash (sandbox).');
    await enable('bkash').expect(200);
  });
});

describe('bKash', () => {
  it('holds the stock, sends the shopper to bKash, and only counts it once bKash executes it', async () => {
    const before = (await db.product.findUniqueOrThrow({ where: { id: 23 } })).stock;
    await fillCart(23);
    const res = await checkout('bkash').expect(201);
    expect(res.body).toMatchObject({ status: 'PENDING_PAYMENT', payment: { method: 'bkash', status: 'PENDING', amountBdt: Math.round(res.body.total * RATE * 100) / 100, usdToBdt: RATE } });
    expect(res.body.payment.redirectUrl).toMatch(/^https:\/\/sandbox\.payment\.bkash\.com\/\?paymentId=TR00\d+$/);
    expect((await db.product.findUniqueOrThrow({ where: { id: 23 } })).stock).toBe(before - 1);
    expect((await api().get('/api/v1/cart').set(as(shopper))).body.items).toHaveLength(0);

    const [p] = (await order(res.body.id)).payments;
    const back = await api().get(`/api/v1/payments/bkash/callback/${p.id}?paymentID=${p.reference}&status=success&signature=sig`).expect(303);
    expect(back.headers.location).toBe(`http://localhost:5173/orders/${res.body.id}?payment=success`);
    const paid = await order(res.body.id);
    expect(paid).toMatchObject({ status: 'PROCESSING', paymentStatus: 'PAID', paymentMethod: 'bkash' });
    expect(paid.payments[0]).toMatchObject({ status: 'PAID', trxId: `BK${p.reference}` });

    // The same return again (a reload) changes nothing.
    await api().get(`/api/v1/payments/bkash/callback/${p.id}?paymentID=${p.reference}&status=success`).expect(303);
    expect((await order(res.body.id)).payments[0]).toMatchObject({ status: 'PAID', error: null });
  });

  it('reuses its access token (bKash allows two a hour)', async () => {
    const grants = bkash.grants;
    await fillCart(27);
    await checkout('bkash').expect(201);
    expect(bkash.grants).toBe(grants);
  });

  it('a callback for someone else’s payment or a forged "success" is not trusted', async () => {
    await fillCart(27);
    const res = await checkout('bkash').expect(201);
    const [p] = (await order(res.body.id)).payments;
    // Nobody paid: the stand-in says Initiated, and execute is what decides.
    bkash.payments.get(p.reference!)!.status = 'Initiated';
    await api().get(`/api/v1/payments/bkash/callback/${p.id}?paymentID=TR999&status=success`).expect(303);
    expect((await order(res.body.id)).payments[0].status).toBe('PENDING');
  });

  it('a cancelled payment leaves the order open to pay another way, like cash on delivery', async () => {
    await fillCart(27);
    const res = await checkout('bkash').expect(201);
    const [p] = (await order(res.body.id)).payments;
    const back = await api().get(`/api/v1/payments/bkash/callback/${p.id}?paymentID=${p.reference}&status=cancel`).expect(303);
    expect(back.headers.location).toContain('?payment=cancelled');
    expect(await order(res.body.id)).toMatchObject({ status: 'PENDING_PAYMENT', paymentStatus: 'CANCELLED' });

    const cod = await api().post(`/api/v1/orders/${res.body.id}/pay`).set(as(shopper)).send({ method: 'cod' }).expect(200);
    expect(cod.body).toMatchObject({ status: 'PROCESSING', payment: { method: 'cod', status: 'UNPAID', redirectUrl: null } });
    const marked = await api().patch(`/api/v1/admin/orders/${res.body.id}/payment`).set(as(admin)).send({ status: 'PAID' }).expect(200);
    expect(marked.body.payment.status).toBe('PAID');
  });

  it('rejects a payment for the wrong amount', async () => {
    await fillCart(27);
    const res = await checkout('bkash').expect(201);
    const [p] = (await order(res.body.id)).payments;
    bkash.lie = true;
    await api().get(`/api/v1/payments/bkash/callback/${p.id}?paymentID=${p.reference}&status=success`).expect(303);
    bkash.lie = false;
    const o = await order(res.body.id);
    expect(o.status).toBe('PENDING_PAYMENT');
    expect(o.payments[0]).toMatchObject({ status: 'FAILED', error: expect.stringContaining('instead of') });
  });

  it('refunds through bKash', async () => {
    const paid = await db.payment.findFirstOrThrow({ where: { gateway: 'bkash', status: 'PAID', order: { user: { email: { endsWith: DOMAIN } } } } });
    const res = await api().post(`/api/v1/admin/payments/${paid.id}/refund`).set(as(admin)).send({ reason: 'Changed mind' }).expect(200);
    expect(res.body).toMatchObject({ status: 'REFUNDED', refunded: Number(paid.amount) });
    expect((await order(paid.orderId)).paymentStatus).toBe('REFUNDED');
  });
});

describe('Nagad', () => {
  it('encrypts and signs every request, and verifies with Nagad before the order counts as paid', async () => {
    await api()
      .put('/api/v1/admin/payments/gateways/nagad')
      .set(as(admin))
      .send({ credentials: { merchantId: nagad.merchantId, merchantPrivateKey: b64(merchantKeys.privateKey, 'pkcs8'), nagadPublicKey: b64(nagadKeys.publicKey, 'spki') } })
      .expect(200);
    await enable('nagad').expect(200);
    await fillCart(27);
    const res = await checkout('nagad').expect(201);
    expect(res.body.payment.redirectUrl).toMatch(/^http:\/\/sandbox\.mynagad\.com:10060\/check-out\//);
    const [p] = (await order(res.body.id)).payments;
    expect(nagad.sessions.get(p.reference!)?.amount).toBe(Number(p.amount).toFixed(2));

    // Back before paying: still pending. Nagad's callback URL is one fixed address; the invoice says which payment.
    await api().get(`/api/v1/payments/nagad/callback?order_id=${p.invoice}&payment_ref_id=${p.reference}&status=Success`).expect(303);
    expect((await order(res.body.id)).payments[0].status).toBe('PENDING');
    nagad.sessions.get(p.reference!)!.paid = true;
    const back = await api().get(`/api/v1/payments/nagad/callback?order_id=${p.invoice}&payment_ref_id=${p.reference}&status=Success`).expect(303);
    expect(back.headers.location).toContain('?payment=success');
    expect(await order(res.body.id)).toMatchObject({ status: 'PROCESSING', paymentStatus: 'PAID' });
    await api().get('/api/v1/payments/nagad/callback?order_id=NOTOURS1&status=Success').expect(404);

    // Nagad has no public refund API: refund in its portal, then record it.
    await api().post(`/api/v1/admin/payments/${p.id}/refund`).set(as(admin)).send({}).expect(400);
    await api().post(`/api/v1/admin/payments/${p.id}/refund`).set(as(admin)).send({ manual: true, amount: 100 }).expect(200);
  });
});

describe('SSLCommerz (Rocket and cards)', () => {
  it('sends Rocket straight to the Rocket page and accepts only a signed, validated notification', async () => {
    await api().put('/api/v1/admin/payments/gateways/sslcommerz').set(as(admin)).send({ credentials: { storeId: ssl.storeId, storePassword: ssl.password } }).expect(200);
    await enable('rocket').expect(200);
    await enable('card').expect(200);
    await fillCart(27);
    const res = await checkout('rocket').expect(201);
    expect(res.body.payment.redirectUrl).toContain('cardname=dbblmobilebanking');
    const [p] = (await order(res.body.id)).payments;
    ssl.sessions.get(p.invoice)!.paid = true;

    const fields = { tran_id: p.invoice, val_id: `VAL${p.invoice}`, status: 'VALID', amount: Number(p.amount).toFixed(2), currency: 'BDT' };
    await api().post('/api/v1/payments/sslcommerz/ipn').type('form').send(ipn(fields, 'wrong-password')).expect(200);
    expect((await order(res.body.id)).payments[0].status).toBe('PENDING');
    await api().post('/api/v1/payments/sslcommerz/ipn').type('form').send(ipn(fields)).expect(200);
    expect(await order(res.body.id)).toMatchObject({ status: 'PROCESSING', paymentStatus: 'PAID' });
    expect((await order(res.body.id)).payments[0]).toMatchObject({ trxId: `BANK${p.invoice}` });

    // The shopper's browser arrives after the IPN: nothing changes, and they land on their order.
    const back = await api().post(`/api/v1/payments/sslcommerz/return/${p.id}`).type('form').send(fields).expect(303);
    expect(back.headers.location).toContain('?payment=success');

    const part = await api().post(`/api/v1/admin/payments/${p.id}/refund`).set(as(admin)).send({ amount: 50 }).expect(200);
    expect(part.body).toMatchObject({ status: 'PAID', refunded: 50 });
  });

  it('cards open the hosted page', async () => {
    await fillCart(23);
    const res = await checkout('card').expect(201);
    expect(res.body.payment.redirectUrl).toMatch(/^https:\/\/sandbox\.sslcommerz\.com\/EasyCheckOut\//);
  });
});

describe('two things at once', () => {
  const payViaBkash = async (productId = 27, qty = 1) => {
    await fillCart(productId, qty);
    const res = await checkout('bkash').expect(201);
    return { id: res.body.id as string, payment: (await order(res.body.id)).payments[0] };
  };
  const succeed = (p: { id: string; reference: string | null }) => api().get(`/api/v1/payments/bkash/callback/${p.id}?paymentID=${p.reference}&status=success&signature=sig`).expect(303);

  it('two refunds sent together refund once', async () => {
    const { payment } = await payViaBkash();
    await succeed(payment);
    const [a, b] = await Promise.all([
      api().post(`/api/v1/admin/payments/${payment.id}/refund`).set(as(admin)).send({ reason: 'double click' }),
      api().post(`/api/v1/admin/payments/${payment.id}/refund`).set(as(admin)).send({ reason: 'double click' }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const p = await db.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(p).toMatchObject({ status: 'REFUNDED', refunded: p.amount });
    expect((p.log as { step: string }[]).filter((l) => l.step === 'refunded')).toHaveLength(1);
  });

  it('a refund the gateway refuses gives the amount back for another try', async () => {
    const { payment } = await payViaBkash();
    await succeed(payment);
    bkash.refuseRefunds = true;
    await api().post(`/api/v1/admin/payments/${payment.id}/refund`).set(as(admin)).send({ reason: 'x' }).expect(502);
    bkash.refuseRefunds = false;
    expect(Number((await db.payment.findUniqueOrThrow({ where: { id: payment.id } })).refunded)).toBe(0);
    await api().post(`/api/v1/admin/payments/${payment.id}/refund`).set(as(admin)).send({ reason: 'x' }).expect(200);
  });

  it('a second attempt started while the first one paid cannot reopen the order', async () => {
    const { id, payment } = await payViaBkash();
    // The second tab read the order while it was still unpaid…
    const stale = await db.order.findUniqueOrThrow({ where: { id }, include: { items: true } });
    await succeed(payment);
    // …and only then reached the gateway.
    const u = await db.user.findUniqueOrThrow({ where: { email: `shopper${DOMAIN}` } });
    await expect(payments.begin(stale, 'bkash', { name: u.name, email: u.email })).rejects.toThrow(/paid by another attempt/);
    const o = await order(id);
    expect(o).toMatchObject({ status: 'PROCESSING', paymentStatus: 'PAID' });
    // The late attempt is still an open question for the sweep, never a "paid" that overwrote the first.
    expect(o.payments.map((p) => p.status)).toEqual(['PAID', 'PENDING']);
    // If the shopper paid that one too, it's flagged rather than counted.
    await succeed(o.payments[1]);
    expect((await order(id)).payments[1]).toMatchObject({ status: 'PAID', error: expect.stringContaining('already been paid by another attempt') });
  });

  it('a payment landing after the order was cancelled takes every item or none', async () => {
    await api().delete('/api/v1/cart').set(as(shopper)).expect(204);
    await api().post('/api/v1/cart/items').set(as(shopper)).send({ productId: 27, qty: 1 }).expect(201);
    await api().post('/api/v1/cart/items').set(as(shopper)).send({ productId: 23, qty: 1 }).expect(201);
    const res = await checkout('bkash').expect(201);
    const [p] = (await order(res.body.id)).payments;
    // The order timed out (as the sweep does it), with the payment still open at the gateway.
    const items = await db.orderItem.findMany({ where: { orderId: res.body.id } });
    await db.$transaction(async (tx) => {
      await tx.order.update({ where: { id: res.body.id }, data: { status: 'CANCELLED', paymentStatus: 'EXPIRED' } });
      for (const i of items) await tx.product.update({ where: { id: i.productId }, data: { stock: { increment: i.qty } } });
    });
    // Meanwhile the first product sold out again.
    const was23 = (await db.product.findUniqueOrThrow({ where: { id: 23 } })).stock;
    const was27 = (await db.product.findUniqueOrThrow({ where: { id: 27 } })).stock;
    await db.product.update({ where: { id: 23 }, data: { stock: 0 } });
    await succeed(p);
    const o = await order(res.body.id);
    expect(o.status).toBe('CANCELLED');
    expect(o.payments[0]).toMatchObject({ status: 'PAID', error: expect.stringContaining('sold out') });
    // The other product was not quietly taken off the shelf.
    expect((await db.product.findUniqueOrThrow({ where: { id: 27 } })).stock).toBe(was27);
    await db.product.update({ where: { id: 23 }, data: { stock: was23 } });
  });

  it('a gateway success after the shopper switched to cash is flagged, not counted', async () => {
    const { id, payment } = await payViaBkash();
    await api().post(`/api/v1/orders/${id}/pay`).set(as(shopper)).send({ method: 'cod' }).expect(200);
    await succeed(payment);
    const o = await order(id);
    expect(o).toMatchObject({ status: 'PROCESSING', paymentMethod: 'cod', paymentStatus: 'UNPAID' });
    expect(o.payments[0]).toMatchObject({ status: 'PAID', error: expect.stringContaining('switched to cash on delivery') });
  });
});

describe('cash on delivery and timeouts', () => {
  it('needs a phone number for the courier', async () => {
    await fillCart(27);
    const { phone, ...noPhone } = ADDRESS;
    expect(phone).toBeTruthy();
    const res = await checkout('cod', noPhone).expect(400);
    expect(res.body.message).toBe('Add a phone number so the courier can reach you.');
    const ok = await checkout('cod').expect(201);
    expect(ok.body).toMatchObject({ status: 'PROCESSING', payment: { method: 'cod', status: 'UNPAID' } });
  });

  it('cancels orders left unpaid and puts their stock back', async () => {
    await fillCart(27, 2);
    const before = (await db.product.findUniqueOrThrow({ where: { id: 27 } })).stock;
    const res = await checkout('bkash').expect(201);
    expect((await db.product.findUniqueOrThrow({ where: { id: 27 } })).stock).toBe(before - 2);
    // Every order still waiting for payment (this one and earlier tests') is past the timeout by then.
    const waiting = await db.order.findMany({ where: { status: 'PENDING_PAYMENT', user: { email: { endsWith: DOMAIN } } }, include: { items: true } });
    const held = waiting.flatMap((o) => o.items).filter((i) => i.productId === 27).reduce((n, i) => n + i.qty, 0);
    const stock = (await db.product.findUniqueOrThrow({ where: { id: 27 } })).stock;

    await app.get((await import('../src/common/infra.module.js')).RedisService).del('payments:sweep');
    await payments.sweep(Date.now() + 31 * 60_000);
    const o = await order(res.body.id);
    expect(o).toMatchObject({ status: 'CANCELLED', paymentStatus: 'EXPIRED' });
    expect(o.payments[0].status).toBe('EXPIRED');
    expect((await db.product.findUniqueOrThrow({ where: { id: 27 } })).stock).toBe(stock + held);
  });
});
