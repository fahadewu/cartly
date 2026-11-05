// Visitor journeys and shopper profiles end to end: the storefront's page batches → Redis queue → batched
// writes → admin journey analytics, and behaviour → profile (personality, price band, age guess) →
// "Picked for you", plus switching personalisation off. Real local Postgres + Redis; cleans up after itself.
import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { createApp } from '../src/main.js';
import { PrismaService, RedisService } from '../src/common/infra.module.js';
import { JourneyWorker } from '../src/journeys/track.js';
import { ProfileService } from '../src/journeys/profile.js';

let app: INestApplication;
let db: PrismaService;
let redis: RedisService;
const api = () => request(app.getHttpServer());
const DOMAIN = '@journeys-e2e.test';
const as = (token: string) => ({ Authorization: `Bearer ${token}` });
let admin = '';
let shopper = { id: '', token: '' };
const visitorId = `e2e-visitor-${Date.now()}`;
const visitId = `e2e-visit-${Date.now()}`;

beforeAll(async () => {
  app = await createApp();
  await app.init();
  db = app.get(PrismaService);
  redis = app.get(RedisService);
  const jwt = app.get(JwtService);
  const a = await db.user.findUniqueOrThrow({ where: { email: 'admin@cartly.dev' } });
  admin = await jwt.signAsync({ sub: a.id, email: a.email, role: 'ADMIN' });
  const u = await db.user.create({ data: { email: `street${DOMAIN}`, name: 'Rafi Street', passwordHash: 'x' } });
  shopper = { id: u.id, token: await jwt.signAsync({ sub: u.id, email: u.email, role: 'CUSTOMER' }) };
});

afterAll(async () => {
  await db.visit.deleteMany({ where: { visitorId } });
  await db.user.deleteMany({ where: { email: { endsWith: DOMAIN } } });
  await redis.del(`profile:${shopper.id}`, `reco:${shopper.id}`, `profile:hints:${shopper.id}`);
  await app.close();
});

describe('journeys', () => {
  it('takes page batches in one quick round trip and writes them in the background', async () => {
    const t0 = Date.now() - 5 * 60_000;
    const first = await api()
      .post('/api/v1/track')
      .set('cf-ipcountry', 'BD')
      .set('cf-ipcity', 'Chattogram')
      .set('user-agent', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Version/18.0 Mobile/15E148 Safari/604.1')
      .send({
        visitorId,
        visitId,
        at: Date.now(),
        start: { landing: '/login?redirect=/cart', referrer: 'https://www.facebook.com/', utmCampaign: 'puja', timeZone: 'Asia/Dhaka', locale: 'bn-BD' },
        pages: [{ seq: 1, path: '/login?redirect=/cart', route: 'login', at: t0, ms: 20_000 }],
      });
    expect(first.status).toBe(202);

    // Signed in now: the rest of the visit is theirs. The last page arrives twice (tab hidden, then left).
    const pages = [
      { seq: 2, path: '/', route: 'explore', at: t0 + 25_000, ms: 30_000, scroll: 40 },
      { seq: 3, path: '/product/6', route: 'product', at: t0 + 60_000, ms: 50_000, scroll: 90 },
      { seq: 4, path: '/cart', route: 'cart', at: t0 + 120_000, ms: 5_000 },
    ];
    await api().post('/api/v1/track').set(as(shopper.token)).send({ visitorId, visitId, at: Date.now(), pages }).expect(202);
    await api().post('/api/v1/track').set(as(shopper.token)).send({ visitorId, visitId, at: Date.now(), pages: [{ ...pages[2], ms: 15_000 }] }).expect(202);

    // Junk is refused before it reaches the queue.
    await api().post('/api/v1/track').send({ visitorId: 'x', visitId, at: Date.now(), pages: [] }).expect(400);
    await api().post('/api/v1/track').send({ visitorId, visitId, at: Date.now(), pages: [{ seq: 1, path: 'https://evil', route: 'x', at: 1, ms: 1 }] }).expect(400);

    await app.get(JourneyWorker).flush();
    const v = await db.visit.findUniqueOrThrow({ where: { id: visitId }, include: { pages: { orderBy: { seq: 'asc' } } } });
    expect(v).toMatchObject({
      userId: shopper.id, landing: '/login', exitPath: '/cart', source: 'social', referrer: 'facebook.com', campaign: 'puja',
      device: 'mobile', os: 'iOS', country: 'BD', city: 'Chattogram', geoSource: 'cdn', pageCount: 4, activeMs: 115_000,
    });
    expect(v.pages.map((p) => [p.route, p.activeMs, p.scrollPct])).toEqual([
      ['login', 20_000, null], ['explore', 30_000, 40], ['product', 50_000, 90], ['cart', 15_000, null],
    ]);
  });

  it('shows the admin where visitors came from, went and left', async () => {
    await api().get('/api/v1/admin/analytics/visitors?days=7').set(as(shopper.token)).expect(403);
    const { body } = await api().get('/api/v1/admin/analytics/visitors?days=7').set(as(admin)).expect(200);
    expect(body.totals.visits).toBeGreaterThanOrEqual(1);
    expect(body.sources.find((s: { key: string }) => s.key === 'social')).toBeTruthy();
    expect(body.exits.find((e: { key: string }) => e.key === '/cart')).toBeTruthy();
    expect(body.pages.find((p: { route: string }) => p.route === 'product')).toBeTruthy();
    expect(body.flows).toEqual(expect.arrayContaining([expect.objectContaining({ from: 'product', to: 'cart' }), expect.objectContaining({ from: 'cart', to: '(left)' })]));
    expect(body.cities.find((c: { key: string }) => c.key === 'Chattogram, BD')).toBeTruthy();
    expect(body.recent.find((r: { id: string }) => r.id === visitId)).toMatchObject({ name: 'Rafi Street', exitPath: '/cart' });

    const visit = await api().get(`/api/v1/admin/analytics/visits/${visitId}`).set(as(admin)).expect(200);
    expect(visit.body.timeline.filter((s: { kind: string }) => s.kind === 'page').map((s: { path: string }) => s.path)).toEqual(['/login', '/', '/product/6', '/cart']);
    expect(visit.body.exitPath).toBe('/cart');
  });
});

describe('shopper profile', () => {
  it('learns a streetwear taste and recommends to it', async () => {
    // Streetwear, men's, budget: graphic tee (6), relaxed jeans (19), cap (40); bought the runner sneaker (1).
    const ago = (m: number) => new Date(Date.now() - m * 60_000);
    await db.demandEvent.createMany({
      data: [
        ...[6, 19, 40, 6, 19, 4].map((productId, i) => ({ type: 'view', userId: shopper.id, productId, createdAt: ago(60 + i) })),
        { type: 'cart_add', userId: shopper.id, productId: 6, createdAt: ago(30) },
        { type: 'favourite', userId: shopper.id, productId: 40, createdAt: ago(20) },
      ],
    });
    await redis.lpush(`profile:hints:${shopper.id}`, JSON.stringify({ styles: ['streetwear'], age: '18-24' }));

    const taste = await app.get(ProfileService).rebuild(shopper.id);
    expect(taste?.personality).toBe('trendsetter');
    expect(taste?.ageGroup).toBe('18-24');
    const row = await db.shopperProfile.findUniqueOrThrow({ where: { userId: shopper.id } });
    expect(row.personality).toBe('trendsetter');

    const { body } = await api().get('/api/v1/me/recommendations?limit=6').set(as(shopper.token)).expect(200);
    expect(body.personalised).toBe(true);
    expect(body.reason).toMatch(/Because you like/);
    const products = await db.product.findMany({ where: { id: { in: body.ids } }, select: { styleTags: true } });
    expect(products.filter((p) => p.styleTags.some((t) => ['streetwear', 'graphic', 'bold', 'edgy'].includes(t))).length).toBeGreaterThanOrEqual(3);

    // Pip reads the same profile from Redis.
    const summary = JSON.parse((await redis.get(`profile:${shopper.id}`))!);
    expect(summary).toMatchObject({ personality: 'Trendsetter', ageGroup: '18-24' });

    const admin360 = await api().get(`/api/v1/admin/analytics/shoppers/${shopper.id}`).set(as(admin)).expect(200);
    expect(admin360.body.profile.personalityLabel).toBe('Trendsetter');
    expect(admin360.body.totals.visits).toBe(1);
  });

  it('forgets everything when personalisation is switched off', async () => {
    await api().put('/api/v1/me/personalisation').set(as(shopper.token)).send({ personalise: false }).expect(200);
    expect(await db.shopperProfile.findUnique({ where: { userId: shopper.id } })).toBeNull();
    expect(await redis.exists(`profile:${shopper.id}`, `reco:${shopper.id}`, `profile:hints:${shopper.id}`)).toBe(0);
    const { body } = await api().get('/api/v1/me/recommendations').set(as(shopper.token)).expect(200);
    expect(body).toMatchObject({ personalised: false, reason: 'Popular right now' });
    expect(await app.get(ProfileService).rebuild(shopper.id)).toBeNull();
    await api().put('/api/v1/me/personalisation').set(as(shopper.token)).send({ personalise: true }).expect(200);
    expect((await api().get('/api/v1/me/personalisation').set(as(shopper.token))).body.personalise).toBe(true);
  });
});
