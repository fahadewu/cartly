// Returns end to end (request → approve → rider pickup → inspect and restock → refund) and the analytics
// read back from a known set of orders: regions, refunds net of sales, demand from views and searches.
// Uses the real local Postgres + Redis; everything it creates is removed afterwards.
import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { createApp } from '../src/main.js';
import { PrismaService } from '../src/common/infra.module.js';
import { regionOf } from '../src/analytics/regions.js';

let app: INestApplication;
let db: PrismaService;
const api = () => request(app.getHttpServer());
const DOMAIN = '@returns-e2e.test';
const as = (token: string) => ({ Authorization: `Bearer ${token}` });
let admin = '';
let dhaka = { id: '', token: '' };
let ctg = { id: '', token: '' };
let rider = { id: '', token: '' };
const created: string[] = [];
let savedWindow: unknown;
let stock23 = 0;
const RATE = 120;

beforeAll(async () => {
  app = await createApp();
  await app.init();
  db = app.get(PrismaService);
  const jwt = app.get(JwtService);
  const sign = (u: { id: string; email: string }, role: string) => jwt.signAsync({ sub: u.id, email: u.email, role });
  const a = await db.user.findUniqueOrThrow({ where: { email: 'admin@cartly.dev' } });
  admin = await sign(a, 'ADMIN');
  for (const [who, name] of [['dhaka', 'Nusrat Jahan'], ['ctg', 'Tanvir Hasan']] as const) {
    const u = await db.user.create({ data: { email: `${who}${DOMAIN}`, name, passwordHash: 'x' } });
    const t = { id: u.id, token: await sign(u, 'CUSTOMER') };
    if (who === 'dhaka') dhaka = t;
    else ctg = t;
  }
  const r = await db.rider.create({ data: { phone: '01911000000', user: { create: { email: `rider${DOMAIN}`, name: 'Sabbir Rider', role: 'RIDER', passwordHash: 'x' } } }, include: { user: true } });
  rider = { id: r.id, token: await sign(r.user, 'RIDER') };
  savedWindow = await db.storeSetting.findUnique({ where: { key: 'returnWindowDays' } });
  stock23 = (await db.product.findUniqueOrThrow({ where: { id: 23 } })).stock;
});

afterAll(async () => {
  await db.order.deleteMany({ where: { id: { in: created } } });
  await db.demandEvent.deleteMany({ where: { user: { email: { endsWith: DOMAIN } } } });
  await db.user.deleteMany({ where: { email: { endsWith: DOMAIN } } });
  await db.storeSetting.deleteMany({ where: { key: 'returnWindowDays' } });
  if (savedWindow) await db.storeSetting.create({ data: savedWindow as never });
  await db.product.update({ where: { id: 23 }, data: { stock: stock23 } });
  await app.close();
});

/** A delivered (or other) order placed `daysAgo`, made directly: checkout is covered elsewhere. */
async function order(userId: string, address: object, opts: { status?: 'DELIVERED' | 'CANCELLED' | 'PROCESSING'; daysAgo?: number; qty?: number; price?: number; color?: string; discount?: number; method?: string } = {}) {
  const id = `CL-${Math.floor(1_000_000 + Math.random() * 9_000_000)}`;
  created.push(id);
  const qty = opts.qty ?? 2;
  const price = opts.price ?? 50;
  const subtotal = qty * price;
  const discount = opts.discount ?? 0;
  await db.order.create({
    data: {
      id,
      userId,
      status: opts.status ?? 'DELIVERED',
      subtotal,
      discount,
      shipping: 0,
      total: subtotal - discount,
      delivery: 'standard',
      address: { name: 'Test', street: 'House 1', postal: '1000', phone: '01711000000', ...address },
      paymentMethod: opts.method ?? 'cod',
      paymentStatus: 'PAID',
      amountBdt: (subtotal - discount) * RATE,
      exchangeRate: RATE,
      createdAt: new Date(Date.now() - (opts.daysAgo ?? 1) * 864e5),
      items: { create: [{ productId: 23, name: 'Test tee', image: '/x.jpg', price, qty, color: opts.color ?? 'Black', size: 'M' }] },
    },
  });
  return id;
}

describe('regions', () => {
  it('reads Bangladeshi addresses however they’re written', () => {
    expect(regionOf({ city: 'Chittagong', country: 'Bangladesh' })).toMatchObject({ division: 'Chattogram', district: 'Chattogram' });
    expect(regionOf({ city: 'CTG', country: 'BD' })).toMatchObject({ division: 'Chattogram' });
    expect(regionOf({ city: 'Dhanmondi', country: 'Bangladesh' })).toMatchObject({ division: 'Dhaka', district: 'Dhaka' });
    expect(regionOf({ city: 'Bogra', country: 'bangladesh' })).toMatchObject({ division: 'Rajshahi', district: 'Bogura' });
    expect(regionOf({ city: 'সিলেট', country: 'বাংলাদেশ' })).toMatchObject({ division: 'Sylhet' });
    expect(regionOf({ city: 'Somewhere', street: 'Road 3, Uttara', country: 'Bangladesh' })).toMatchObject({ division: 'Dhaka' });
    expect(regionOf({ city: 'Nowhere', country: 'Bangladesh' })).toMatchObject({ country: 'Bangladesh', division: null });
    expect(regionOf({ city: 'london', country: 'UK' })).toEqual({ country: 'United Kingdom', division: null, district: null, place: 'London' });
  });
});

describe('returns', () => {
  let orderId = '';
  let returnId = '';

  it('lets the shopper return part of a delivered order, refunding their share of any promo', async () => {
    orderId = await order(dhaka.id, { city: 'Dhaka', country: 'Bangladesh' }, { qty: 2, price: 50, discount: 10 });
    const e = await api().get(`/api/v1/orders/${orderId}/returns`).set(as(dhaka.token)).expect(200);
    expect(e.body).toMatchObject({ open: true, windowDays: 7, items: [{ qty: 2, returnable: 2 }] });
    const line = e.body.items[0].orderItemId;
    await api().post(`/api/v1/orders/${orderId}/returns`).set(as(dhaka.token)).send({ items: [{ orderItemId: line, qty: 3 }], reason: 'TOO_SMALL' }).expect(400);
    await api().post(`/api/v1/orders/${orderId}/returns`).set(as(ctg.token)).send({ items: [{ orderItemId: line, qty: 1 }], reason: 'TOO_SMALL' }).expect(404);
    const res = await api().post(`/api/v1/orders/${orderId}/returns`).set(as(dhaka.token)).send({ items: [{ orderItemId: line, qty: 1 }], reason: 'TOO_SMALL', note: 'Runs small' }).expect(201);
    returnId = res.body.id;
    // $50 item, $10 off a $100 order → 10% off each item → $45, and ৳5,400 at the order's rate.
    expect(res.body).toMatchObject({ status: 'REQUESTED', reason: 'TOO_SMALL', refundUsd: 45, refundBdt: 5400, items: [{ qty: 1 }] });
    // The shopper's view carries nothing store-internal.
    expect(res.body).not.toHaveProperty('storeNote');
    expect(res.body).not.toHaveProperty('customer');
    expect(res.body.order).not.toHaveProperty('address');
    const again = await api().get(`/api/v1/orders/${orderId}/returns`).set(as(dhaka.token)).expect(200);
    expect(again.body.items[0].returnable).toBe(1);
  });

  it('two return requests sent together for the last unit create one', async () => {
    const id = await order(dhaka.id, { city: 'Dhaka', country: 'Bangladesh' }, { qty: 1 });
    const line = (await api().get(`/api/v1/orders/${id}/returns`).set(as(dhaka.token)).expect(200)).body.items[0].orderItemId;
    const body = { items: [{ orderItemId: line, qty: 1 }], reason: 'CHANGED_MIND' };
    const [a, b] = await Promise.all([
      api().post(`/api/v1/orders/${id}/returns`).set(as(dhaka.token)).send(body),
      api().post(`/api/v1/orders/${id}/returns`).set(as(dhaka.token)).send(body),
    ]);
    expect([a.status, b.status].filter((s) => s === 201)).toHaveLength(1);
    expect(await db.returnRequest.count({ where: { orderId: id } })).toBe(1);
  });

  it('is approved, collected by a rider and handed in at the store', async () => {
    await api().post(`/api/v1/admin/returns/${returnId}/refund`).set(as(admin)).send({ via: 'manual', reference: 'x' }).expect(409); // not back yet
    await api().post(`/api/v1/admin/returns/${returnId}/approve`).set(as(admin)).send({}).expect(200);
    const picked = await api().post(`/api/v1/admin/returns/${returnId}/pickup`).set(as(admin)).send({ riderId: rider.id }).expect(200);
    expect(picked.body.pickups).toHaveLength(1);
    const job = (await api().get('/api/v1/rider').set(as(rider.token)).expect(200)).body.active.find((j: { returnId: string }) => j.returnId === returnId);
    expect(job).toMatchObject({ kind: 'return', next: ['PICKED_UP', 'FAILED_ATTEMPT'], codAmount: 0, needsCode: false, items: [{ qty: 1 }] });
    await api().post(`/api/v1/rider/shipments/${job.id}/status`).set(as(rider.token)).send({ status: 'PICKED_UP' }).expect(200);
    await api().post(`/api/v1/rider/shipments/${job.id}/status`).set(as(rider.token)).send({ status: 'DELIVERED' }).expect(200);
    const back = await api().get(`/api/v1/admin/returns/${returnId}`).set(as(admin)).expect(200);
    expect(back.body.status).toBe('RECEIVED');
    // The delivered order itself is untouched by the pickup.
    expect((await db.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('DELIVERED');
    const home = (await api().get('/api/v1/rider').set(as(rider.token)).expect(200)).body;
    expect(home.cashHeld.amount).toBe(0);
  });

  it('puts sellable items back in stock and records the refund once', async () => {
    const r = (await api().get(`/api/v1/admin/returns/${returnId}`).set(as(admin)).expect(200)).body;
    await api().post(`/api/v1/admin/returns/${returnId}/refund`).set(as(admin)).send({ via: 'manual', reference: 'x' }).expect(409); // not inspected
    const before = (await db.product.findUniqueOrThrow({ where: { id: 23 } })).stock;
    await api().post(`/api/v1/admin/returns/${returnId}/receive`).set(as(admin)).send({ items: [] }).expect(400);
    await api().post(`/api/v1/admin/returns/${returnId}/receive`).set(as(admin)).send({ items: [{ id: r.items[0].id, restock: true }] }).expect(200);
    expect((await db.product.findUniqueOrThrow({ where: { id: 23 } })).stock).toBe(before + 1);
    await api().post(`/api/v1/admin/returns/${returnId}/refund`).set(as(admin)).send({ via: 'gateway' }).expect(409); // cash on delivery: no gateway payment
    await api().post(`/api/v1/admin/returns/${returnId}/refund`).set(as(admin)).send({ via: 'manual', manualMethod: 'bKash transfer' }).expect(400); // needs a reference
    const done = await api().post(`/api/v1/admin/returns/${returnId}/refund`).set(as(admin)).send({ via: 'manual', manualMethod: 'bKash transfer', reference: 'BK9X77' }).expect(200);
    expect(done.body).toMatchObject({ status: 'REFUNDED', refundBdt: 5400, refundMethod: 'manual: bKash transfer', refundRef: 'BK9X77' });
    await api().post(`/api/v1/admin/returns/${returnId}/refund`).set(as(admin)).send({ via: 'manual', reference: 'x' }).expect(409);
    const list = await api().get('/api/v1/admin/returns').set(as(admin)).query({ q: returnId }).expect(200);
    expect(list.body.items).toHaveLength(1);
  });

  it('closes once the window has passed, and a rejection needs a reason', async () => {
    const id = await order(dhaka.id, { city: 'Dhaka', country: 'Bangladesh' });
    const line = (await api().get(`/api/v1/orders/${id}/returns`).set(as(dhaka.token)).expect(200)).body.items[0].orderItemId;
    const rt = (await api().post(`/api/v1/orders/${id}/returns`).set(as(dhaka.token)).send({ items: [{ orderItemId: line, qty: 1 }], reason: 'CHANGED_MIND' }).expect(201)).body;
    await api().post(`/api/v1/admin/returns/${rt.id}/reject`).set(as(admin)).send({}).expect(400);
    await api().post(`/api/v1/admin/returns/${rt.id}/reject`).set(as(admin)).send({ note: 'Worn and washed' }).expect(200);
    await api().patch('/api/v1/admin/returns/settings').set(as(admin)).send({ windowDays: 0 }).expect(200);
    const closed = await api().get(`/api/v1/orders/${id}/returns`).set(as(dhaka.token)).expect(200);
    expect(closed.body).toMatchObject({ open: false, why: 'This store doesn’t take returns.' });
    await api().patch('/api/v1/admin/returns/settings').set(as(admin)).send({ windowDays: 7 }).expect(200);
    const processing = await order(dhaka.id, { city: 'Dhaka', country: 'Bangladesh' }, { status: 'PROCESSING' });
    expect((await api().get(`/api/v1/orders/${processing}/returns`).set(as(dhaka.token)).expect(200)).body.why).toBe('Returns open once the order is delivered.');
  });
});

describe('analytics', () => {
  it('counts views and searches once per shopper, and finds what nobody could find', async () => {
    const send = (events: object[], token = ctg.token) => api().post('/api/v1/events').set(as(token)).send({ events }).expect(202);
    const first = await send([{ type: 'view', productId: 23 }, { type: 'view', productId: 23 }, { type: 'search', query: '  Red PANJABI ', results: 0 }, { type: 'view', productId: 999999 }]);
    expect(first.body.recorded).toBe(2); // the repeat view and the unknown product don't count
    await send([{ type: 'search', query: 'red panjabi', results: 0 }]); // same search again soon: once
    await send([{ type: 'search', query: 'red panjabi', results: 0 }], dhaka.token);
    const d = (await api().get('/api/v1/admin/analytics/demand').set(as(admin)).query({ days: 7 }).expect(200)).body;
    expect(d.tracking.since).not.toBeNull();
    expect(d.searches.unmet.find((s: { query: string }) => s.query === 'red panjabi')).toMatchObject({ searches: 2, people: 2, zeroResults: 2 });
    expect(d.topSellers.find((p: { id: number }) => p.id === 23).views).toBeGreaterThanOrEqual(1);
  });

  it('splits sales by region, net of refunds, with Chattogram read from “CTG”', async () => {
    const region = async () =>
      (await api().get('/api/v1/admin/analytics/regions').set(as(admin)).query({ days: 7 }).expect(200)).body.regions.find((x: { name: string }) => x.name === 'Chattogram division') ?? { orders: 0, gross: 0, units: 0, tastes: { color: { top: [] } } };
    const before = await region();
    await order(ctg.id, { city: 'CTG', street: 'Agrabad', country: 'Bangladesh' }, { qty: 3, price: 40, color: 'Maroon', daysAgo: 2 });
    await order(ctg.id, { city: 'Chittagong', country: 'Bangladesh' }, { status: 'CANCELLED', qty: 5, price: 40 });
    const c = await region();
    // The cancelled order doesn't count; the delivered one does.
    expect({ orders: c.orders - before.orders, gross: c.gross - before.gross, units: c.units - before.units }).toEqual({ orders: 1, gross: 120, units: 3 });
    const maroon = (x: { tastes: { color: { top: { name: string; units: number }[] } } }) => x.tastes.color.top.find((t) => t.name === 'Maroon')?.units ?? 0;
    expect(maroon(c) - maroon(before)).toBe(3);
    const place = (await api().get('/api/v1/admin/analytics/regions').set(as(admin)).query({ days: 7, level: 'place' }).expect(200)).body;
    expect(place.regions.map((x: { name: string }) => x.name)).toContain('Chattogram, Chattogram');

    const s = (await api().get('/api/v1/admin/analytics/sales').set(as(admin)).query({ days: 7 }).expect(200)).body;
    // The $45 return refunded by hand (৳5,400 at ৳120) comes off net sales, once.
    expect(s.refunds.total).toBeGreaterThanOrEqual(45);
    expect(s.net.total).toBeCloseTo(s.gross.total - s.refunds.total, 2);
    expect(s.series.reduce((a: number, d: { gross: number }) => a + d.gross, 0)).toBeCloseTo(s.gross.total, 2);
    expect(s.series).toHaveLength(7);

    const rt = (await api().get('/api/v1/admin/analytics/returns').set(as(admin)).query({ days: 7 }).expect(200)).body;
    expect(rt.byReason.find((x: { name: string }) => x.name === 'TOO_SMALL').units).toBeGreaterThanOrEqual(1);
    expect(rt.fit.find((x: { size: string }) => x.size === 'M').tooSmall).toBeGreaterThanOrEqual(1);
    expect(rt.totals.restocked).toBeGreaterThanOrEqual(1);
  });

  it('answers every section for every range', async () => {
    for (const section of ['sales', 'demand', 'customers', 'regions', 'returns', 'delivery', 'ai-costs']) {
      for (const days of [7, 30, 90, 365]) await api().get(`/api/v1/admin/analytics/${section}`).set(as(admin)).query({ days }).expect(200);
    }
    await api().get('/api/v1/admin/analytics/sales').set(as(admin)).query({ days: 12 }).expect(400);
    await api().get('/api/v1/admin/analytics/sales').set(as(dhaka.token)).expect(403);
  });
});
