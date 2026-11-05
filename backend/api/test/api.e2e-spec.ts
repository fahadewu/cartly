// End-to-end tests against the real local Postgres + Redis (run `npx prisma db seed` first).
import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { createApp } from '../src/main.js';
import { PrismaService, RedisService } from '../src/common/infra.module.js';
import { env } from '../src/config.js';

let app: INestApplication<App>;
let db: PrismaService;
const api = () => request(app.getHttpServer());
const email = `e2e-${Date.now()}@cartly.test`;
const password = 'Summer2026!';
let token = '';
const auth = () => ({ Authorization: `Bearer ${token}` });

beforeAll(async () => {
  app = (await createApp()) as INestApplication<App>;
  await app.init();
  db = app.get(PrismaService);
  // Start with clean rate-limit counters, so re-running the suite within a minute works.
  const redis = app.get(RedisService);
  const keys = await redis.keys('throttle:*');
  if (keys.length) await redis.del(...keys);
});
afterAll(async () => {
  await db.user.deleteMany({ where: { email: { endsWith: '@cartly.test' } } });
  await app.close();
});

describe('health & catalog', () => {
  it('reports healthy dependencies', async () => {
    const res = await api().get('/api/v1/health').expect(200);
    expect(res.body.database.ok).toBe(true);
    expect(res.body.redis.ok).toBe(true);
  });

  it('filters, sorts and paginates products', async () => {
    const shoes = await api().get('/api/v1/products?type=Shoes&gender=women&limit=50').expect(200);
    expect(shoes.body.total).toBeGreaterThan(0);
    expect(shoes.body.items.every((p: any) => p.type === 'Shoes' && ['women', 'unisex'].includes(p.gender))).toBe(true);

    const sale = await api().get('/api/v1/products?sale=true&sort=price-asc').expect(200);
    const prices = sale.body.items.map((p: any) => p.price);
    expect(sale.body.items.every((p: any) => p.compareAt > p.price)).toBe(true);
    expect(prices).toEqual([...prices].sort((a: number, b: number) => a - b));

    const black = await api().get('/api/v1/products?colors=Black&maxPrice=50').expect(200);
    expect(black.body.items.every((p: any) => p.price <= 50 && p.colors.some((c: any) => c.name === 'Black'))).toBe(true);

    const page2 = await api().get('/api/v1/products?limit=10&page=2').expect(200);
    expect(page2.body.items).toHaveLength(10);
    expect(page2.body.pages).toBe(4);
  });

  it('rejects invalid query params', async () => {
    await api().get('/api/v1/products?sort=cheapest').expect(400);
  });

  it('returns product detail with care info, reviews and related items', async () => {
    const res = await api().get('/api/v1/products/scarlet-wrap-dress').expect(200);
    expect(res.body.id).toBe(17);
    expect(res.body.tryOn).toEqual({ slot: 'dress', image: null, cutout: null, crop: null });
    expect(res.body.details.length).toBeGreaterThan(0);
    expect(res.body.reviews.length).toBeGreaterThan(0);
    expect(res.body.related).toHaveLength(4);
    await api().get('/api/v1/products/does-not-exist').expect(404);
  });

  it('serves categories, collections and stories with products', async () => {
    const offers = await api().get('/api/v1/collections/offers').expect(200);
    expect(offers.body.products.items.every((p: any) => p.compareAt)).toBe(true);
    const story = await api().get('/api/v1/stories/winter-layering').expect(200);
    expect(story.body.products.map((p: any) => p.id)).toEqual([4, 9, 21, 22, 20]);
    const cats = await api().get('/api/v1/categories').expect(200);
    expect(cats.body.map((c: any) => c.slug).sort()).toEqual(['clothing-shoes', 'gifts-living']);
  });

  it('natural-language search works with or without the AI service', async () => {
    const res = await api().get('/api/v1/products/search?q=sneaker').expect(200);
    expect(['semantic', 'keyword']).toContain(res.body.engine);
    expect(res.body.items.length).toBeGreaterThan(0);
  });
});

describe('auth', () => {
  it('enforces password strength and signs up', async () => {
    await api().post('/api/v1/auth/signup').send({ name: 'E2E Tester', email, password: 'weakpass' }).expect(400);
    const res = await api().post('/api/v1/auth/signup').send({ name: 'E2E Tester', email, password }).expect(201);
    token = res.body.accessToken;
    expect(res.body.user.email).toBe(email);
    await api().post('/api/v1/auth/signup').send({ name: 'E2E Tester', email, password }).expect(409);
  });

  it('logs in, rejects bad passwords, and returns the profile', async () => {
    await api().post('/api/v1/auth/login').send({ email, password: 'Wrong1234!' }).expect(401);
    await api().post('/api/v1/auth/login').send({ email, password }).expect(200);
    const me = await api().get('/api/v1/auth/me').set(auth()).expect(200);
    expect(me.body.name).toBe('E2E Tester');
    await api().get('/api/v1/auth/me').expect(401);
  });

  it('logs the demo account in with its seeded orders', async () => {
    const res = await api().post('/api/v1/auth/login').send({ email: 'demo@cartly.dev', password: 'Demo1234!' }).expect(200);
    await api().get('/api/v1/orders?status=bogus').set({ Authorization: `Bearer ${res.body.accessToken}` }).expect(400);
    const orders = await api().get('/api/v1/orders').set({ Authorization: `Bearer ${res.body.accessToken}` }).expect(200);
    expect(orders.body.map((o: any) => o.id)).toEqual(expect.arrayContaining(['CL-20931', 'CL-20874', 'CL-20512']));
  });
});

describe('cart, checkout and orders', () => {
  it('validates items, merges quantities and applies promo codes', async () => {
    await api().delete('/api/v1/cart').set(auth()).expect(204);
    await api().post('/api/v1/cart/items').set(auth()).send({ productId: 2 }).expect(400); // needs a size
    await api().post('/api/v1/cart/items').set(auth()).send({ productId: 2, size: '99' }).expect(400);
    await api().post('/api/v1/cart/items').set(auth()).send({ productId: 2, size: '42', color: 'Lemon' }).expect(201);
    const merged = await api().post('/api/v1/cart/items').set(auth()).send({ productId: 2, size: '42', color: 'Lemon' }).expect(201);
    expect(merged.body.items[0].qty).toBe(2);
    expect(merged.body.subtotal).toBe(178);
    expect(merged.body.shipping).toBe(0); // over $100

    await api().post('/api/v1/cart/promo').set(auth()).send({ code: 'NOPE' }).expect(400);
    const promo = await api().post('/api/v1/cart/promo').set(auth()).send({ code: 'welcome20' }).expect(200);
    expect(promo.body.discount).toBe(35.6);
    expect(promo.body.total).toBe(142.4);

    const one = await api().patch(`/api/v1/cart/items/${encodeURIComponent('2|Lemon|42')}`).set(auth()).send({ qty: 1 }).expect(200);
    expect(one.body.shipping).toBe(8); // $89 - 20% < $100
  });

  it('checks out, decrements stock, then cancels and restocks', async () => {
    const stockBefore = (await db.product.findUniqueOrThrow({ where: { id: 2 } })).stock;
    const body = {
      address: { name: 'E2E Tester', street: '1 Test Street', city: 'London', postal: 'e1 6an', country: 'United Kingdom' },
      delivery: 'express',
      payment: { nameOnCard: 'E2E Tester', cardNumber: '4242 4242 4242 4241', expiry: '12/30', cvc: '123' },
    };
    await api().post('/api/v1/orders').set(auth()).send(body).expect(400); // fails Luhn
    body.payment.cardNumber = '4242 4242 4242 4242';
    const order = await api().post('/api/v1/orders').set(auth()).send(body).expect(201);
    expect(order.body.id).toMatch(/^CL-\d{7}$/);
    expect(order.body).toMatchObject({ status: 'PROCESSING', delivery: 'express', shipping: 15, cardLast4: '4242', promoCode: 'WELCOME20' });
    expect(order.body.address.postal).toBe('E1 6AN');
    expect((await db.product.findUniqueOrThrow({ where: { id: 2 } })).stock).toBe(stockBefore - 1);

    const cart = await api().get('/api/v1/cart').set(auth()).expect(200);
    expect(cart.body.items).toHaveLength(0);
    await api().post('/api/v1/orders').set(auth()).send(body).expect(400); // empty cart

    const again = await api().post(`/api/v1/orders/${order.body.id}/reorder`).set(auth()).expect(200);
    expect(again.body.count).toBe(1);

    const cancelled = await api().post(`/api/v1/orders/${order.body.id}/cancel`).set(auth()).expect(200);
    expect(cancelled.body.status).toBe('CANCELLED');
    expect((await db.product.findUniqueOrThrow({ where: { id: 2 } })).stock).toBe(stockBefore);
    await api().post(`/api/v1/orders/${order.body.id}/cancel`).set(auth()).expect(409);
    await api().get('/api/v1/orders/CL-00000').set(auth()).expect(404);
  });

  it('keeps admin endpoints for admins only', async () => {
    await api().patch('/api/v1/admin/orders/CL-20931/status').set(auth()).send({ status: 'SHIPPED' }).expect(403);
  });
});

describe('account', () => {
  it('manages favourites', async () => {
    await api().put('/api/v1/me/favourites/17').set(auth()).expect(200);
    const favs = await api().put('/api/v1/me/favourites/24').set(auth()).expect(200);
    expect(favs.body.map((p: any) => p.id)).toEqual([24, 17]);
    const after = await api().delete('/api/v1/me/favourites/17').set(auth()).expect(200);
    expect(after.body.map((p: any) => p.id)).toEqual([24]);
  });

  it('posts a review and updates the product rating', async () => {
    const before = await db.product.findUniqueOrThrow({ where: { id: 13 } });
    await api().get('/api/v1/products/13').expect(200); // now cached
    await api().post('/api/v1/products/13/reviews').set(auth()).send({ rating: 5, text: 'short' }).expect(400);
    const r = await api().post('/api/v1/products/13/reviews').set(auth()).send({ rating: 5, text: 'Comfortable and goes with everything.' }).expect(201);
    expect(r.body.author).toBe('E2E Tester');
    const after = await db.product.findUniqueOrThrow({ where: { id: 13 } });
    expect(after.reviewCount).toBe(before.reviewCount + 1);
    // The product page the shopper reloads shows it straight away, cache or not.
    const page = await api().get('/api/v1/products/13').expect(200);
    expect(page.body.reviews[0].id).toBe(r.body.id);
    expect(page.body.reviewCount).toBe(before.reviewCount + 1);
    await db.review.delete({ where: { id: r.body.id } });
    await db.product.update({ where: { id: 13 }, data: { reviewCount: before.reviewCount, rating: before.rating } });
  });

  it('handles product requests and team members', async () => {
    await api().post('/api/v1/me/requests').set(auth()).send({ product: 'Olive linen trousers', category: 'Clothing', email, link: 'not-a-url' }).expect(400);
    await api().post('/api/v1/me/requests').set(auth()).send({ product: 'Olive linen trousers', category: 'Clothing', budget: 90, email }).expect(201);
    const reqs = await api().get('/api/v1/me/requests').set(auth()).expect(200);
    expect(reqs.body[0]).toMatchObject({ product: 'Olive linen trousers', budget: 90, status: 'RECEIVED' });

    const m = await api().post('/api/v1/team').set(auth()).send({ name: 'Alex Morgan', email: 'alex@cartly.test', role: 'BUYER' }).expect(201);
    await api().post('/api/v1/team').set(auth()).send({ name: 'Alex Morgan', email: 'alex@cartly.test', role: 'BUYER' }).expect(409);
    await api().post('/api/v1/team').set(auth()).send({ name: 'Me', email, role: 'ADMIN' }).expect(400);
    await api().patch(`/api/v1/team/${m.body.id}`).set(auth()).send({ role: 'ADMIN' }).expect(200);
    await api().delete(`/api/v1/team/${m.body.id}`).set(auth()).expect(204);
  });
});

describe('caching', () => {
  it('lets a CDN keep public catalog reads briefly, and browsers revalidate with an ETag', async () => {
    const boot = await api().get('/api/v1/catalog').expect(200);
    expect(boot.headers['cache-control']).toBe('public, max-age=0, s-maxage=30, stale-while-revalidate=60');
    await api().get('/api/v1/catalog').set('If-None-Match', boot.headers.etag).expect(304);
    const detail = await api().get('/api/v1/products/13').expect(200);
    expect(detail.headers['cache-control']).toBeUndefined(); // reviews must show up at once
  });
});

describe('Pip gateway', () => {
  // A stand-in AI service: records each /agent/chat body (plus the internal key it came with) and answers `answer`.
  let server: Server;
  let realUrl = '';
  let sent: Record<string, any>[] = [];
  let answer: [number, Record<string, unknown>];
  const chat = (body: object, headers: Record<string, string> = {}) => api().post('/api/v1/assistant/chat').set(headers).send(body);
  const networkId = (ip: string) => createHmac('sha256', env.internalApiKey).update(ip).digest('hex').slice(0, 32);
  const shopper = async (sub: string) => ({ Authorization: `Bearer ${await app.get(JwtService).signAsync({ sub, email: `${sub}@e2e.test`, role: 'CUSTOMER' })}` });

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        sent.push({ ...JSON.parse(body || '{}'), key: req.headers['x-internal-key'] });
        res.writeHead(answer[0], { 'content-type': 'application/json' }).end(JSON.stringify(answer[1]));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    realUrl = env.aiServiceUrl;
    env.aiServiceUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    env.aiServiceUrl = realUrl;
    server.close();
  });
  beforeEach(() => {
    sent = [];
    answer = [200, { text: 'Hello!', session_id: 'pip-e2e' }];
  });

  it.skipIf(!env.internalApiKey)('tells Pip a guest’s network as a keyed id, never the IP', async () => {
    const res = await chat({ message: 'hi', sessionId: 'pip-e2e' }).expect(201);
    expect(res.body).toEqual({ text: 'Hello!', session_id: 'pip-e2e' });
    expect(sent).toEqual([{ message: 'hi', kind: 'message', session_id: 'pip-e2e', client: networkId('127.0.0.1'), key: env.internalApiKey }]);
  });

  it.skipIf(!env.internalApiKey)('reads the guest’s IP as TRUST_PROXY says: IPv4 by address, IPv6 by its /64', async () => {
    const express = app as unknown as NestExpressApplication;
    express.set('trust proxy', 'loopback'); // as TRUST_PROXY=loopback would, behind a proxy on this machine
    try {
      const from = async (ip: string) => {
        sent = [];
        await chat({ message: 'hi' }, { 'X-Forwarded-For': ip }).expect(201);
        expect(JSON.stringify(sent)).not.toContain(ip);
        return sent[0].client as string;
      };
      expect(await from('203.0.113.7')).toBe(networkId('203.0.113.7'));
      expect(await from('203.0.113.8')).toBe(networkId('203.0.113.8'));
      const phone = await from('2001:db8:1:2:aaaa:bbbb:cccc:dddd');
      expect(await from('2001:0db8:0001:0002::1')).toBe(phone); // same /64: the phone just picked a new address
      expect(await from('2001:db8:1:3::1')).not.toBe(phone);
      // A proxy that adds the source port: the same network on every connection.
      expect(await from('203.0.113.7:51234')).toBe(networkId('203.0.113.7'));
      expect(await from('203.0.113.7:51235')).toBe(networkId('203.0.113.7'));
      expect(await from('[2001:db8:1:2::1]:443')).toBe(phone);
    } finally {
      express.set('trust proxy', env.trustProxy ?? false);
    }
  });

  it('sends a signed-in shopper’s account instead of their network', async () => {
    const sub = `pip-gateway-${Date.now()}`;
    await chat({ kind: 'greet' }, await shopper(sub)).expect(201);
    expect(sent[0]).toMatchObject({ kind: 'greet', user_id: sub });
    expect(sent[0]).not.toHaveProperty('client');
  });

  it('forwards the context as it came, and turns one over 4 KB away before it reaches Pip', async () => {
    const context = {
      tryOn: { hasPhoto: false, mode: 'preview', on: [{ id: 17, name: 'Scarlet Wrap Dress' }] },
      locale: 'bn-BD',
      timeZone: 'Asia/Dhaka',
      lang: 'bn-BD',
      langMode: 'auto',
      spoken: true,
      voiceOut: false,
      origin: 'voice',
      results: [17, 18],
      events: [{ type: 'add', id: 17, size: 'M', color: 'Scarlet' }],
    };
    await chat({ message: 'লাল শাড়ি', context }).expect(201);
    expect(sent[0].context).toEqual(context);
    // {"note":"…"} is 11 bytes around the text, and the limit counts bytes: 1,400 Bangla letters are 4,200.
    await chat({ message: 'hi', context: { note: 'x'.repeat(4096 - 11) } }).expect(201);
    await chat({ message: 'hi', context: { note: 'x'.repeat(4096 - 10) } }).expect(400);
    const big = await chat({ message: 'hi', context: { note: 'শ'.repeat(1400) } }).expect(400);
    expect(big.body.message).toMatch(/too large/);
    expect(sent).toHaveLength(2);
  });

  it('answers 502 when the AI service refuses the internal key, so a key mix-up never signs shoppers out', async () => {
    const as = await shopper(`pip-gateway-key-${Date.now()}`);
    for (const status of [401, 403]) {
      answer = [status, { detail: 'Invalid or missing X-Internal-Key' }];
      const res = await chat({ message: 'hi' }, as).expect(502);
      expect(res.body.message).not.toMatch(/key/i);
    }
    answer = [503, { message: 'Pip is busy right now.' }];
    expect((await chat({ message: 'hi' }, as).expect(503)).body.message).toBe('Pip is busy right now.');
  });
});

describe('rate limiting', () => {
  it('limits Pip chat per shopper account, not per IP', async () => {
    // Two accounts on the same IP (as behind a mobile carrier's shared address). Synthetic ids, so no
    // other test's allowance is used up.
    const jwt = app.get(JwtService);
    const as = async (sub: string) => ({ Authorization: `Bearer ${await jwt.signAsync({ sub, email: `${sub}@e2e.test`, role: 'CUSTOMER' })}` });
    const [first, second] = [await as(`throttle-${Date.now()}-a`), await as(`throttle-${Date.now()}-b`)];
    const codes: number[] = [];
    for (let i = 0; i < 22; i++) codes.push((await api().post('/api/v1/assistant/chat').set(first).send({ message: 'hi' })).status);
    expect(codes).toContain(429);
    expect((await api().post('/api/v1/assistant/chat').set(second).send({ message: 'hi' })).status).not.toBe(429);
  });

  it('throttles repeated login attempts (Redis-backed)', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) codes.push((await api().post('/api/v1/auth/login').send({ email, password: 'Wrong1234!' })).status);
    expect(codes).toContain(429);
  });
});
