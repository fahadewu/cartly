// Delivery end to end: the store's own riders (assign → pick up → deliver with the customer's code →
// cash handed in) and Pathao, Steadfast and RedX against local stand-ins that speak each courier's
// protocol (Pathao's OAuth and webhook handshake, Steadfast's key headers, RedX's areas and cancel).
// Uses the real local Postgres + Redis; courier settings are put back afterwards.
import { createServer, type Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import type { PrismaService as Prisma } from '../src/common/infra.module.js';
import type { DeliveryService as Delivery } from '../src/delivery/delivery.service.js';

let app: INestApplication;
let db: Prisma;
let delivery: Delivery;
let server: Server;
const api = () => request(app.getHttpServer());
const DOMAIN = '@delivery-e2e.test';
let admin = '';
let shopper = '';
let shopperId = '';
const as = (token: string) => ({ Authorization: `Bearer ${token}` });
const ADDRESS = { name: 'Rahim Uddin', street: 'House 12, Road 5, Dhanmondi', city: 'Dhaka', postal: '1205', country: 'Bangladesh', phone: '+880 1711-000000' };

/* ---------- courier stand-ins ---------- */

const seen: { path: string; headers: Record<string, unknown>; body: Record<string, unknown> }[] = [];
const pathao = { tokens: 0, orders: new Map<string, { status: string }>() };
const steadfast = { orders: new Map<string, { status: string }>() };
const redx = { parcels: new Map<string, { status: string }>() };

function stand_ins(req: import('node:http').IncomingMessage, raw: string): [number, object] {
  const url = new URL(req.url!, 'http://x');
  const body = raw ? JSON.parse(raw) : {};
  seen.push({ path: `${req.method} ${url.pathname}`, headers: req.headers, body });
  const path = url.pathname;

  if (path.startsWith('/pathao/aladdin/api/v1/')) {
    const p = path.slice('/pathao/aladdin/api/v1'.length);
    if (p === '/issue-token') {
      if (body.client_id !== 'cid' || body.client_secret !== 'csecret-hidden' || body.username !== 'merchant@shop.test' || body.password !== 'pw-hidden') {
        return [400, { message: 'The user credentials were incorrect.', type: 'error', code: 400 }];
      }
      pathao.tokens++;
      return [200, { token_type: 'Bearer', expires_in: 7776000, access_token: `ptok-${pathao.tokens}`, refresh_token: 'prefresh' }];
    }
    if (req.headers.authorization !== `Bearer ptok-${pathao.tokens}`) return [401, { message: 'Unauthenticated.' }];
    if (p === '/stores') return [200, { data: { data: [{ store_id: 99, store_name: 'Cartly Dhanmondi', is_active: 1, is_default_store: true }] } }];
    if (p === '/city-list') return [200, { data: { data: [{ city_id: 1, city_name: 'Dhaka' }, { city_id: 2, city_name: 'Chattogram' }] } }];
    if (p === '/cities/1/zone-list') return [200, { data: { data: [{ zone_id: 62, zone_name: 'Dhanmondi' }] } }];
    if (p === '/orders' && req.method === 'POST') {
      if (!body.store_id || !/^01\d{9}$/.test(body.recipient_phone) || String(body.recipient_address).length < 10) {
        return [422, { message: 'Please fix the given errors', type: 'error', code: 422, errors: { recipient_phone: ['The recipient phone format is invalid.'] } }];
      }
      const id = `DT3009${String(pathao.orders.size + 1).padStart(2, '0')}TEST0`;
      pathao.orders.set(id, { status: 'Pending' });
      return [200, { message: 'Order Created Successfully', type: 'success', code: 200, data: { consignment_id: id, merchant_order_id: body.merchant_order_id, order_status: 'Pending', delivery_fee: 60 } }];
    }
    const m = p.match(/^\/orders\/([^/]+)\/info$/);
    if (m) {
      const o = pathao.orders.get(m[1]);
      if (!o) return [404, { message: 'Invalid order id' }];
      return [200, { data: { consignment_id: m[1], order_status: o.status, order_status_slug: o.status } }];
    }
  }

  if (path.startsWith('/steadfast/')) {
    if (req.headers['api-key'] !== 'sf-key-hidden' || req.headers['secret-key'] !== 'sf-secret-hidden') {
      return [401, { status: 401, message: 'Unauthorized Access (invalid API credentials)', attempts_left: 9 }];
    }
    const p = path.slice('/steadfast'.length);
    if (p === '/get_balance') return [200, { status: 200, current_balance: 1500 }];
    if (p === '/create_order') {
      const id = 1424100 + steadfast.orders.size + 1;
      steadfast.orders.set(String(id), { status: 'in_review' });
      return [200, { status: 200, message: 'Consignment has been created successfully.', consignment: { consignment_id: id, invoice: body.invoice, tracking_code: `15BAEB${id % 100}`, cod_amount: body.cod_amount, status: 'in_review' } }];
    }
    const m = p.match(/^\/status_by_cid\/(\d+)$/);
    if (m) return [200, { status: 200, delivery_status: steadfast.orders.get(m[1])?.status ?? 'unknown' }];
  }

  if (path.startsWith('/redx/')) {
    if (req.headers['api-access-token'] !== 'Bearer redx-token-hidden') return [401, { message: 'Unauthorized', status_code: 401 }];
    const p = path.slice('/redx'.length);
    if (p === '/areas') return [200, { areas: [{ id: 1, name: 'Mohammadpur(Dhaka)', post_code: 1207, division_name: 'Dhaka', zone_id: 1 }, { id: 7, name: 'Dhanmondi(Dhaka)', post_code: 1205, division_name: 'Dhaka', zone_id: 1 }] }];
    if (p === '/parcel' && req.method === 'POST') {
      if (!body.delivery_area_id || !body.delivery_area) return [400, { message: 'delivery_area_id is required' }];
      const id = `20A312T${redx.parcels.size + 1}`;
      redx.parcels.set(id, { status: 'pickup-pending' });
      return [200, { tracking_id: id }];
    }
    if (p === '/parcels' && req.method === 'PATCH') {
      const parcel = redx.parcels.get(body.entity_id);
      if (!parcel || parcel.status !== 'pickup-pending') return [400, { success: false, message: 'Parcel can not be cancelled' }];
      parcel.status = 'cancelled';
      return [200, { success: true, message: 'Request Accepted' }];
    }
    let m = p.match(/^\/parcel\/info\/(.+)$/);
    if (m) {
      const parcel = redx.parcels.get(m[1]);
      return parcel ? [200, { parcel: { tracking_id: m[1], status: parcel.status, charge: 75 } }] : [404, { message: 'Parcel not found' }];
    }
    m = p.match(/^\/parcel\/track\/(.+)$/);
    if (m) {
      return [200, { tracking: [
        { message_en: 'Package is created successfully', time: '2026-09-30T10:00:00.000Z' },
        { message_en: 'Package is picked up by RedX', time: '2026-09-30T11:00:00.000Z' },
        { message_en: 'Package is out for delivery to Dhanmondi', time: '2026-09-30T12:00:00.000Z' },
      ] }];
    }
  }
  return [404, { message: 'no such stand-in route' }];
}

/* ---------- setup ---------- */

let saved: unknown[];
const created: string[] = [];

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
  Object.assign(process.env, { PATHAO_BASE_URL: `${base}/pathao`, STEADFAST_BASE_URL: `${base}/steadfast`, REDX_BASE_URL: `${base}/redx` });

  // Imported after the stand-in URLs are set: config.ts reads them once.
  const { createApp } = await import('../src/main.js');
  const { PrismaService } = await import('../src/common/infra.module.js');
  const { RedisService } = await import('../src/common/infra.module.js');
  const { DeliveryService } = await import('../src/delivery/delivery.service.js');
  app = await createApp();
  await app.init();
  db = app.get(PrismaService);
  delivery = app.get(DeliveryService);
  saved = await db.courier.findMany();
  await db.courier.updateMany({ data: { secrets: null, live: false, enabled: false } });
  const redis = app.get(RedisService);
  for (const k of await redis.keys('pathao:token:*')) await redis.del(k);
  for (const k of await redis.keys('delivery:places:*')) await redis.del(k);

  const jwt = app.get(JwtService);
  const a = await db.user.findUniqueOrThrow({ where: { email: 'admin@cartly.dev' } });
  admin = await jwt.signAsync({ sub: a.id, email: a.email, role: 'ADMIN' });
  const u = await db.user.create({ data: { email: `shopper${DOMAIN}`, name: 'Rahim Uddin', passwordHash: 'x' } });
  shopperId = u.id;
  shopper = await jwt.signAsync({ sub: u.id, email: u.email, role: 'CUSTOMER' });
});

afterAll(async () => {
  await db.order.deleteMany({ where: { id: { in: created } } });
  await db.user.deleteMany({ where: { email: { endsWith: DOMAIN } } });
  await db.$transaction([db.courier.deleteMany(), db.courier.createMany({ data: saved as never })]);
  await app.close();
  server.close();
});

/** An order ready to go out (made directly: checkout itself is covered by the payments suite). */
async function makeOrder({ cod = true, phone = ADDRESS.phone } = {}) {
  const id = `CL-${Math.floor(1_000_000 + Math.random() * 9_000_000)}`;
  created.push(id);
  await db.order.create({
    data: {
      id,
      userId: shopperId,
      status: 'PROCESSING',
      subtotal: 10,
      discount: 0,
      shipping: 0,
      total: 10,
      delivery: 'standard',
      address: { ...ADDRESS, phone },
      paymentMethod: cod ? 'cod' : 'bkash',
      paymentStatus: cod ? 'UNPAID' : 'PAID',
      amountBdt: 1225.4,
      exchangeRate: 122.54,
      items: { create: [{ productId: 23, name: 'Test tee', image: '/x.jpg', price: 10, qty: 2, color: 'Black', size: 'M' }] },
    },
  });
  return id;
}
const order = (id: string) => db.order.findUniqueOrThrow({ where: { id } });
const ship = (id: string, body: object) => api().post(`/api/v1/admin/delivery/orders/${id}/ship`).set(as(admin)).send(body);
const saveCourier = (id: string, body: object) => api().put(`/api/v1/admin/delivery/couriers/${id}`).set(as(admin)).send(body);

/* ---------- own riders ---------- */

describe('own riders', () => {
  let riderId = '';
  let rider = '';
  let orderId = '';
  let shipmentId = '';

  it('creates a rider who signs in to the rider app, not the shop admin', async () => {
    const weak = await api().post('/api/v1/admin/delivery/riders').set(as(admin)).send({ name: 'Karim', email: `karim${DOMAIN}`, phone: '01811000000', password: 'short' }).expect(400);
    expect(weak.body.message).toEqual(expect.arrayContaining([expect.stringMatching(/at least 8 characters/)]));
    const res = await api()
      .post('/api/v1/admin/delivery/riders')
      .set(as(admin))
      .send({ name: 'Karim Mia', email: `karim${DOMAIN}`, phone: '01811000000', password: 'Rider1234!', zone: 'Dhanmondi', vehicle: 'bike' })
      .expect(201);
    riderId = res.body.id;
    expect(res.body).toMatchObject({ name: 'Karim Mia', active: true, onTheWay: 0, cashHeld: { amount: 0, parcels: 0 } });

    // Signed in through the auth service itself: the login route's rate limit is shared with other suites.
    const { AuthService } = await import('../src/auth/auth.module.js');
    const login = await app.get(AuthService).login({ email: `karim${DOMAIN}`, password: 'Rider1234!' });
    expect(login.user.role).toBe('RIDER');
    rider = login.accessToken;
    await api().get('/api/v1/admin/orders').set(as(rider)).expect(403);
    await api().get('/api/v1/rider').set(as(shopper)).expect(403);
    // Riders are kept out of the customer list, and their role can't be changed there.
    const users = await api().get('/api/v1/admin/users').set(as(admin)).query({ q: 'karim' }).expect(200);
    expect(users.body.items).toHaveLength(0);
    await api().patch(`/api/v1/admin/users/${res.body.userId}`).set(as(admin)).send({ role: 'ADMIN' }).expect(400);
  });

  it('assigns an order to the rider with a delivery code only the customer sees', async () => {
    orderId = await makeOrder();
    await ship(orderId, { carrier: 'rider' }).expect(400);
    const res = await ship(orderId, { carrier: 'rider', riderId, note: 'Call before coming' }).expect(201);
    shipmentId = res.body.id;
    expect(res.body).toMatchObject({ carrier: 'rider', status: 'BOOKED', invoice: orderId, codAmount: 1225, rider: { name: 'Karim Mia' } });
    expect(res.body.deliveryCode).toMatch(/^\d{4}$/);
    await ship(orderId, { carrier: 'rider', riderId }).expect(409); // one delivery at a time

    const mine = await api().get(`/api/v1/orders/${orderId}`).set(as(shopper)).expect(200);
    expect(mine.body.shipment).toMatchObject({ status: 'BOOKED', carrierName: 'Cartly rider', rider: { name: 'Karim Mia', phone: '01811000000' }, deliveryCode: res.body.deliveryCode, codAmount: 1225 });
    expect(mine.body.shipment).not.toHaveProperty('invoice');

    const home = await api().get('/api/v1/rider').set(as(rider)).expect(200);
    expect(home.body.active).toHaveLength(1);
    expect(home.body.active[0]).toMatchObject({ orderId, needsCode: true, codAmount: 1225, next: ['PICKED_UP'], note: 'Call before coming' });
    expect(JSON.stringify(home.body)).not.toContain(res.body.deliveryCode);

    // Once handed over, the shopper can't cancel it and the admin's manual moves wait for the delivery.
    await api().post(`/api/v1/orders/${orderId}/cancel`).set(as(shopper)).expect(409);
    await api().patch(`/api/v1/admin/orders/${orderId}/status`).set(as(admin)).send({ status: 'CANCELLED' }).expect(409);
    const adminView = await api().get(`/api/v1/admin/orders/${orderId}`).set(as(admin)).expect(200);
    expect(adminView.body).toMatchObject({ next: [], canShip: false, shipments: [{ id: shipmentId, status: 'BOOKED' }] });
  });

  it('two staff pressing “Ship” together book one delivery', async () => {
    const id = await makeOrder();
    const [a, b] = await Promise.all([ship(id, { carrier: 'rider', riderId }), ship(id, { carrier: 'rider', riderId })]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect(await db.shipment.count({ where: { orderId: id } })).toBe(1);
    await db.shipment.deleteMany({ where: { orderId: id } }); // the later rider tests count this rider's parcels
  });

  it('moves the order along as the rider goes, and needs the customer’s code to finish', async () => {
    const step = (status: string, extra = {}) => api().post(`/api/v1/rider/shipments/${shipmentId}/status`).set(as(rider)).send({ status, ...extra });
    await step('DELIVERED', { code: '0000' }).expect(409); // not picked up yet
    await step('PICKED_UP').expect(200);
    expect((await order(orderId)).status).toBe('SHIPPED');
    await step('OUT_FOR_DELIVERY').expect(200);
    await step('FAILED_ATTEMPT').expect(400); // needs a reason
    await step('FAILED_ATTEMPT', { note: 'Customer didn’t answer the phone' }).expect(200);
    await step('OUT_FOR_DELIVERY').expect(200);

    const s = await db.shipment.findUniqueOrThrow({ where: { id: shipmentId } });
    const wrong = await step('DELIVERED', { code: s.deliveryCode === '1234' ? '4321' : '1234', collected: 1225 }).expect(400);
    expect(wrong.body.message).toMatch(/delivery code isn’t right/);
    const done = await step('DELIVERED', { code: s.deliveryCode, collected: 1225 }).expect(200);
    expect(done.body).toMatchObject({ status: 'DELIVERED', codCollected: 1225, next: [] });
    expect(await order(orderId)).toMatchObject({ status: 'DELIVERED', paymentStatus: 'PAID' });

    const mine = await api().get(`/api/v1/orders/${orderId}`).set(as(shopper)).expect(200);
    expect(mine.body.shipment).toMatchObject({ status: 'DELIVERED', rider: null, deliveryCode: null });
    expect(mine.body.shipment.events.map((e: { status: string }) => e.status)).toEqual(['BOOKED', 'PICKED_UP', 'OUT_FOR_DELIVERY', 'FAILED_ATTEMPT', 'OUT_FOR_DELIVERY', 'DELIVERED']);
    expect(mine.body.shipment.events[3].message).toBe('Delivery attempt didn’t succeed: Customer didn’t answer the phone');
  });

  it('keeps count of the cash each rider holds until it’s handed in', async () => {
    const [r] = (await api().get('/api/v1/admin/delivery/riders').set(as(admin)).expect(200)).body.filter((x: { id: string }) => x.id === riderId);
    expect(r).toMatchObject({ delivered: 1, onTheWay: 0, cashHeld: { amount: 1225, parcels: 1 } });
    const settled = await api().post(`/api/v1/admin/delivery/riders/${riderId}/settle`).set(as(admin)).expect(200);
    expect(settled.body).toMatchObject({ settled: { amount: 1225 }, rider: { cashHeld: { amount: 0, parcels: 0 } } });
    await api().post(`/api/v1/admin/delivery/riders/${riderId}/settle`).set(as(admin)).expect(409);
  });

  it('flags cash collected short, and can’t switch off a rider who still has parcels', async () => {
    const id = await makeOrder();
    const s = (await ship(id, { carrier: 'rider', riderId }).expect(201)).body;
    await api().patch(`/api/v1/admin/delivery/riders/${riderId}`).set(as(admin)).send({ active: false }).expect(409);
    const code = (await db.shipment.findUniqueOrThrow({ where: { id: s.id } })).deliveryCode;
    for (const status of ['PICKED_UP', 'OUT_FOR_DELIVERY']) await api().post(`/api/v1/rider/shipments/${s.id}/status`).set(as(rider)).send({ status }).expect(200);
    const short = await api().post(`/api/v1/rider/shipments/${s.id}/status`).set(as(rider)).send({ status: 'DELIVERED', code, collected: 1000 }).expect(200);
    expect(short.body.error).toBe('Collected ৳1000 of ৳1225. Mark the order paid once the rest is in.');
    expect(await order(id)).toMatchObject({ status: 'DELIVERED', paymentStatus: 'UNPAID' });
    const attention = await api().get('/api/v1/admin/delivery/shipments').set(as(admin)).query({ status: 'ATTENTION' }).expect(200);
    expect(attention.body.items.map((x: { id: string }) => x.id)).toContain(s.id);
    await api().patch(`/api/v1/admin/delivery/riders/${riderId}`).set(as(admin)).send({ active: false }).expect(200);
    await api().get('/api/v1/rider').set(as(rider)).expect(409);
  });
});

/* ---------- couriers ---------- */

describe('courier settings', () => {
  it('keeps courier credentials encrypted and never sends secrets back', async () => {
    await saveCourier('pathao', { enabled: true }).expect(400); // not set up
    await saveCourier('pathao', { credentials: { clientId: 'cid', clientSecret: 'csecret-hidden', username: 'merchant@shop.test', password: 'pw-hidden', webhookSecret: 'hook-hidden' } }).expect(200);
    const view = await api().get('/api/v1/admin/delivery/couriers').set(as(admin)).expect(200);
    const p = view.body.couriers.find((c: { id: string }) => c.id === 'pathao');
    expect(p).toMatchObject({ configured: true, enabled: false, live: false, webhookUrl: 'http://localhost:4100/api/v1/delivery/webhooks/pathao' });
    expect(p.fields.find((f: { key: string }) => f.key === 'username')).toMatchObject({ set: true, value: 'merchant@shop.test' });
    expect(JSON.stringify(view.body)).not.toMatch(/hidden/);
    expect((await db.courier.findUniqueOrThrow({ where: { id: 'pathao' } })).secrets).toMatch(/^v1:/);
    const test = await api().post('/api/v1/admin/delivery/couriers/pathao/test').set(as(admin)).expect(200);
    expect(test.body.message).toBe('Connected to Pathao (sandbox); parcels are picked up from store 99.');
    await saveCourier('pathao', { enabled: true }).expect(200);
    const redxView = view.body.couriers.find((c: { id: string }) => c.id === 'redx');
    expect(redxView.webhookUrl).toBe('http://localhost:4100/api/v1/delivery/webhooks/redx?token=YOUR_WEBHOOK_TOKEN');
  });
});

describe('Pathao', () => {
  let orderId = '';
  let cid = '';

  it('books a parcel with the right fields and a Bangladeshi mobile number', async () => {
    const places = await api().get('/api/v1/admin/delivery/couriers/pathao/locations').set(as(admin)).query({ level: 'city' }).expect(200);
    expect(places.body).toEqual([{ id: '2', name: 'Chattogram' }, { id: '1', name: 'Dhaka' }]);
    const zones = await api().get('/api/v1/admin/delivery/couriers/pathao/locations').set(as(admin)).query({ level: 'zone', parent: '1' }).expect(200);
    expect(zones.body).toEqual([{ id: '62', name: 'Dhanmondi' }]);

    const bad = await makeOrder({ phone: '+44 20 7946 0000' });
    const refused = await ship(bad, { carrier: 'pathao' }).expect(400);
    expect(refused.body.message).toMatch(/Bangladeshi mobile number/);

    orderId = await makeOrder();
    const res = await ship(orderId, { carrier: 'pathao', weightKg: 0.8, location: { city: '1', zone: '62' } }).expect(201);
    cid = res.body.consignmentId;
    expect(res.body).toMatchObject({ carrier: 'pathao', sandbox: true, status: 'BOOKED', charge: 60, trackingCode: cid, courierStatus: 'Pending' });
    const sent = seen.findLast((s) => s.path === 'POST /pathao/aladdin/api/v1/orders')!.body;
    expect(sent).toMatchObject({
      store_id: 99,
      merchant_order_id: orderId,
      recipient_phone: '01711000000',
      recipient_city: 1,
      recipient_zone: 62,
      delivery_type: 48,
      item_type: 2,
      item_quantity: 2,
      item_weight: 0.8,
      amount_to_collect: 1225,
    });
    const mine = await api().get(`/api/v1/orders/${orderId}`).set(as(shopper)).expect(200);
    expect(mine.body.shipment).toMatchObject({ carrierName: 'Pathao', trackingCode: cid, trackingUrl: null, rider: null, deliveryCode: null }); // sandbox: no public link
  });

  it('answers Pathao’s webhook handshake and refuses unsigned calls', async () => {
    await api().post('/api/v1/delivery/webhooks/pathao').send({ event: 'webhook_integration' }).expect(401);
    await api().post('/api/v1/delivery/webhooks/pathao').set('X-PATHAO-Signature', 'wrong').send({ event: 'webhook_integration' }).expect(401);
    const hi = await api().post('/api/v1/delivery/webhooks/pathao').set('X-PATHAO-Signature', 'hook-hidden').send({ event: 'webhook_integration' }).expect(202);
    expect(hi.headers['x-pathao-merchant-webhook-integration-secret']).toBe('f3992ecc-59da-4cbe-a049-a13da2018d51');
  });

  it('follows the parcel through Pathao’s webhooks to delivery and cash collected', async () => {
    const hook = (body: object) => api().post('/api/v1/delivery/webhooks/pathao').set('X-PATHAO-Signature', 'hook-hidden').send({ consignment_id: cid, merchant_order_id: orderId, store_id: 99, ...body }).expect(202);
    await hook({ event: 'order.picked', timestamp: '2026-09-30T08:00:00+00:00' });
    expect((await order(orderId)).status).toBe('SHIPPED');
    await hook({ event: 'order.at-the-sorting-hub' });
    await hook({ event: 'order.assigned-for-delivery' });
    await hook({ order_status_slug: 'Delivered', collected_amount: 1225 }); // the older payload shape
    expect(await order(orderId)).toMatchObject({ status: 'DELIVERED', paymentStatus: 'PAID' });
    await hook({ event: 'order.paid', invoice_id: 'INV1' }); // settlement: noted, status stays
    const s = await db.shipment.findFirstOrThrow({ where: { orderId }, include: { events: { orderBy: { at: 'asc' } } } });
    expect(s).toMatchObject({ status: 'DELIVERED', courierStatus: 'Paid' });
    expect(Number(s.codCollected)).toBe(1225);
    expect(s.events.map((e) => e.message)).toEqual(['Booked with Pathao (sandbox)', 'Picked', 'At the sorting hub', 'Assigned for delivery', 'Delivered', 'Paid']);
  });

  it('asks Pathao for parcels it hasn’t heard about in a while', async () => {
    const id = await makeOrder();
    const s = (await ship(id, { carrier: 'pathao' }).expect(201)).body;
    pathao.orders.get(s.consignmentId)!.status = 'In_Transit';
    await db.shipment.update({ where: { id: s.id }, data: { updatedAt: new Date(Date.now() - 3600_000) } });
    await app.get((await import('../src/common/infra.module.js')).RedisService).del('delivery:sweep');
    const r = await delivery.sweep();
    expect(r.checked).toBeGreaterThanOrEqual(1);
    expect(await db.shipment.findUniqueOrThrow({ where: { id: s.id } })).toMatchObject({ status: 'IN_TRANSIT', courierStatus: 'In transit' });
    expect((await order(id)).status).toBe('SHIPPED');
  });
});

describe('Steadfast', () => {
  it('books only in live mode, since Steadfast has no sandbox', async () => {
    await saveCourier('steadfast', { enabled: true, credentials: { apiKey: 'sf-key-hidden', secretKey: 'sf-secret-hidden', webhookToken: 'sf-hook-hidden' } }).expect(200);
    const test = await api().post('/api/v1/admin/delivery/couriers/steadfast/test').set(as(admin)).expect(200);
    expect(test.body.message).toBe('Connected to Steadfast. Balance: ৳1500.');
    const id = await makeOrder({ cod: false });
    const refused = await ship(id, { carrier: 'steadfast' }).expect(409);
    expect(refused.body.message).toMatch(/no test mode/);
    expect(seen.some((s) => s.path === 'POST /steadfast/create_order')).toBe(false);

    await saveCourier('steadfast', { live: true }).expect(200);
    const res = await ship(id, { carrier: 'steadfast' }).expect(201);
    expect(res.body).toMatchObject({ carrier: 'steadfast', sandbox: false, status: 'BOOKED', codAmount: 0, trackingUrl: 'https://steadfast.com.bd/tracking' });
    expect(seen.findLast((s) => s.path === 'POST /steadfast/create_order')!.body).toMatchObject({ invoice: id, recipient_phone: '01711000000', cod_amount: 0 });

    const hook = (auth: string, body: object) => api().post('/api/v1/delivery/webhooks/steadfast').set('Authorization', auth).send({ consignment_id: Number(res.body.consignmentId), invoice: id, ...body });
    await hook('Bearer nope', { notification_type: 'delivery_status', status: 'pending' }).expect(401);
    await hook('Bearer sf-hook-hidden', { notification_type: 'delivery_status', status: 'pending', delivery_charge: 60, updated_at: '2026-09-30 12:45:30' }).expect(200);
    await hook('Bearer sf-hook-hidden', { notification_type: 'tracking_update', tracking_message: 'Package arrived at the sorting center.' }).expect(200);
    await hook('Bearer sf-hook-hidden', { notification_type: 'delivery_status', status: 'delivered', cod_amount: 0 }).expect(200);
    const s = await db.shipment.findUniqueOrThrow({ where: { id: res.body.id }, include: { events: { orderBy: { at: 'asc' } } } });
    expect(s).toMatchObject({ status: 'DELIVERED' });
    expect(Number(s.charge)).toBe(60);
    expect(s.events.map((e) => e.message)).toContain('Package arrived at the sorting center.');
    expect(await order(id)).toMatchObject({ status: 'DELIVERED', paymentStatus: 'PAID' });
  });
});

describe('RedX', () => {
  it('needs the delivery area, cancels before pickup, and books again as a new invoice', async () => {
    await saveCourier('redx', { enabled: true, credentials: { token: 'redx-token-hidden', webhookToken: 'rx-hook-hidden' } }).expect(200);
    const areas = await api().get('/api/v1/admin/delivery/couriers/redx/locations').set(as(admin)).query({ level: 'area' }).expect(200);
    expect(areas.body[0]).toEqual({ id: '7', name: 'Dhanmondi(Dhaka) · 1205' });

    const id = await makeOrder();
    await ship(id, { carrier: 'redx' }).expect(400);
    const first = (await ship(id, { carrier: 'redx', location: { area: '7' }, locationNames: { area: 'Dhanmondi(Dhaka) · 1205' } }).expect(201)).body;
    expect(seen.findLast((s) => s.path === 'POST /redx/parcel')!.body).toMatchObject({ delivery_area: 'Dhanmondi(Dhaka)', delivery_area_id: 7, cash_collection_amount: '1225', parcel_weight: 500, merchant_invoice_id: id });
    const cancelled = await api().post(`/api/v1/admin/delivery/shipments/${first.id}/cancel`).set(as(admin)).send({ reason: 'Customer asked to wait' }).expect(200);
    expect(cancelled.body.status).toBe('CANCELLED');
    expect(redx.parcels.get(first.consignmentId)!.status).toBe('cancelled');

    const again = (await ship(id, { carrier: 'redx', location: { area: '7' }, locationNames: { area: 'Dhanmondi(Dhaka) · 1205' } }).expect(201)).body;
    expect(again.invoice).toBe(`${id}-2`);

    // History comes in from RedX's tracking, and a webhook without our token is refused.
    redx.parcels.get(again.consignmentId)!.status = 'delivery-in-progress';
    const synced = await api().post(`/api/v1/admin/delivery/shipments/${again.id}/sync`).set(as(admin)).expect(200);
    expect(synced.body).toMatchObject({ status: 'OUT_FOR_DELIVERY', charge: 75 });
    expect(synced.body.events.map((e: { message: string }) => e.message)).toEqual(['Booked with RedX (sandbox)', 'Package is created successfully', 'Package is picked up by RedX', 'Package is out for delivery to Dhanmondi']);
    await api().post('/api/v1/delivery/webhooks/redx').send({ tracking_number: again.consignmentId, status: 'delivered' }).expect(401);

    // Parcel refused at the door: RedX brings it back, and the order waits for the store's decision.
    const hook = (status: string, message_en: string) =>
      api().post('/api/v1/delivery/webhooks/redx?token=rx-hook-hidden').send({ tracking_number: again.consignmentId, status, message_en, invoice_number: `${id}-2`, timestamp: new Date().toISOString() }).expect(200);
    await hook('agent-returning', 'Package is returning to merchant');
    await hook('returned', 'Package returned to merchant');
    expect((await db.shipment.findUniqueOrThrow({ where: { id: again.id } })).status).toBe('RETURNED');
    const view = await api().get(`/api/v1/admin/orders/${id}`).set(as(admin)).expect(200);
    expect(view.body).toMatchObject({ status: 'SHIPPED', canShip: true, next: ['DELIVERED', 'CANCELLED'] });
    const attention = await api().get('/api/v1/admin/delivery/shipments').set(as(admin)).query({ status: 'ATTENTION' }).expect(200);
    expect(attention.body.items.map((x: { id: string }) => x.id)).toContain(again.id);
    await api().patch(`/api/v1/admin/orders/${id}/status`).set(as(admin)).send({ status: 'CANCELLED' }).expect(200);
    await db.product.update({ where: { id: 23 }, data: { stock: { decrement: 2 } } }); // the test order never held any
    const after = await api().get('/api/v1/admin/delivery/shipments').set(as(admin)).query({ status: 'ATTENTION' }).expect(200);
    expect(after.body.items.map((x: { id: string }) => x.id)).not.toContain(again.id);
  });

  it('lets the admin correct a status by hand, and the order follows', async () => {
    const id = await makeOrder();
    const s = (await ship(id, { carrier: 'redx', location: { area: '1' }, locationNames: { area: 'Mohammadpur(Dhaka) · 1207' } }).expect(201)).body;
    const res = await api().post(`/api/v1/admin/delivery/shipments/${s.id}/status`).set(as(admin)).send({ status: 'DELIVERED', message: 'Confirmed with the customer by phone', codCollected: 1225 }).expect(200);
    expect(res.body.events.at(-1)).toMatchObject({ status: 'DELIVERED', message: 'Updated by the store: Confirmed with the customer by phone', source: 'admin' });
    expect(await order(id)).toMatchObject({ status: 'DELIVERED', paymentStatus: 'PAID' });
  });
});
