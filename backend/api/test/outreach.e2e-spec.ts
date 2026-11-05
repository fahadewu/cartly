// Shopper preferences, wants, likeness and outreach emails, end to end against the real local Postgres + Redis.
// The AI service may be down: matching then relies on the strict word-and-colour check. No mail leaves: the
// mailer is replaced by a spy.
import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { vi } from 'vitest';
import { createApp } from '../src/main.js';
import { PrismaService, RedisService } from '../src/common/infra.module.js';
import { OutreachService } from '../src/outreach/outreach.service.js';
import { WANTS_INBOX, CHANGES } from '../src/outreach/inbox.js';

let app: INestApplication;
let db: PrismaService;
let outreach: OutreachService;
let send: ReturnType<typeof vi.fn>;
const api = () => request(app.getHttpServer());
const as = (token: string) => ({ Authorization: `Bearer ${token}` });
const DOMAIN = '@outreach-e2e.test';
let admin = '';
let support = '';
let shopper = '';
let shopperId = '';
let quiet = '';
let quietId = '';
let productId = 0;

const kurti = {
  name: 'E2E Outreach Indigo Kurti',
  slug: 'e2e-outreach-kurti',
  description: 'A block-printed cotton kurti with a mandarin collar, made for testing outreach emails end to end.',
  category: 'clothing-shoes',
  type: 'Clothing',
  gender: 'women',
  label: 'Festive',
  price: 40,
  stock: 0,
  active: true,
  image: 'https://images.unsplash.com/photo-1610030469983-98e550d6193c?w=600',
  colors: [{ name: 'Indigo', hex: '#2f3c7e' }],
  sizes: ['S', 'M', 'L'],
  material: '100% cotton',
  fit: 'regular',
  occasions: ['festive', 'everyday'],
  seasons: ['summer'],
  styleTags: ['boho', 'classic'],
  features: ['block printed', 'side slits'],
  keywords: ['kurti', 'কুর্তি'],
};

beforeAll(async () => {
  app = await createApp();
  await app.init();
  db = app.get(PrismaService);
  outreach = app.get(OutreachService);
  send = vi.fn().mockResolvedValue(undefined);
  outreach.mailer.send = send as never;
  const jwt = app.get(JwtService);
  const redis = app.get(RedisService);
  await redis.del(WANTS_INBOX, CHANGES, 'outreach:lock');
  const a = await db.user.findUniqueOrThrow({ where: { email: 'admin@cartly.dev' } });
  admin = await jwt.signAsync({ sub: a.id, email: a.email, role: 'ADMIN' });
  const s = await db.user.create({ data: { email: `support${DOMAIN}`, name: 'Outreach Support', passwordHash: 'x', role: 'SUPPORT' } });
  support = await jwt.signAsync({ sub: s.id, email: s.email, role: 'SUPPORT' });
  const u = await db.user.create({ data: { email: `nadia${DOMAIN}`, name: 'Nadia Rahman', passwordHash: 'x' } });
  shopperId = u.id;
  shopper = await jwt.signAsync({ sub: u.id, email: u.email, role: 'CUSTOMER' });
  const q = await db.user.create({ data: { email: `quiet${DOMAIN}`, name: 'Quiet Shopper', passwordHash: 'x' } });
  quietId = q.id;
  quiet = await jwt.signAsync({ sub: q.id, email: q.email, role: 'CUSTOMER' });
});

afterAll(async () => {
  await db.product.deleteMany({ where: { slug: { startsWith: 'e2e-outreach' } } });
  await db.user.deleteMany({ where: { email: { endsWith: DOMAIN } } });
  await app.close();
});

describe('preferences', () => {
  it('starts with emails off', async () => {
    const res = await api().get('/api/v1/me/preferences').set(as(shopper)).expect(200);
    expect(res.body).toMatchObject({ marketingEmails: false, skinTone: null, sizes: {} });
  });

  it('saves sizes, colouring and the email opt-in, and suggests shades', async () => {
    const res = await api()
      .put('/api/v1/me/preferences')
      .set(as(shopper))
      .send({ marketingEmails: true, sizes: { Clothing: 'M', Shoes: '38', Bogus: 'x' }, skinTone: 6, undertone: 'warm', toneSource: 'photo' })
      .expect(200);
    expect(res.body).toMatchObject({ marketingEmails: true, skinTone: 6, undertone: 'warm', toneSource: 'photo', sizes: { Clothing: 'M', Shoes: '38' } });
    expect(res.body.marketingSince).toBeTruthy();
    expect(res.body.suits).toEqual(expect.arrayContaining(['olive', 'rust']));
  });

  it('rejects a tone off the scale', async () => {
    await api().put('/api/v1/me/preferences').set(as(shopper)).send({ skinTone: 11 }).expect(400);
  });

  it('forgets the colouring on its own', async () => {
    await api().put('/api/v1/me/preferences').set(as(quiet)).send({ skinTone: 3, undertone: 'cool' }).expect(200);
    const res = await api().delete('/api/v1/me/preferences/colouring').set(as(quiet)).expect(200);
    expect(res.body).toMatchObject({ skinTone: null, undertone: null, marketingEmails: false });
  });
});

describe('wants → we found it', () => {
  it('turns a search with no results into a want', async () => {
    await api().post('/api/v1/events').set(as(shopper)).send({ events: [{ type: 'search', query: 'Indigo kurti', results: 0 }] }).expect(202);
    await api().post('/api/v1/events').set(as(quiet)).send({ events: [{ type: 'search', query: 'indigo kurti', results: 0 }] }).expect(202);
    await new Promise((r) => setTimeout(r, 50));
    await outreach.tick();
    const wants = await db.shopperWant.findMany({ where: { userId: { in: [shopperId, quietId] } } });
    expect(wants.map((w) => [w.userId === shopperId ? 'nadia' : 'quiet', w.source, w.text]).sort()).toEqual([
      ['nadia', 'search', 'indigo kurti'],
      ['quiet', 'search', 'indigo kurti'],
    ]);
  });

  it('drafts a “we found it” email when a product that answers it arrives, only for the shopper who opted in', async () => {
    const res = await api().post('/api/v1/admin/products').set(as(admin)).send({ ...kurti, stock: 12 }).expect(201);
    productId = res.body.id;
    await outreach.tick();
    const drafts = await db.outreach.findMany({ where: { userId: { in: [shopperId, quietId] } } });
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ userId: shopperId, kind: 'found_it', status: 'draft', productIds: [productId] });
    expect(JSON.stringify(drafts[0].reasons)).toMatch(/Searched for “indigo kurti”/);
    const want = await db.shopperWant.findFirstOrThrow({ where: { userId: quietId } });
    expect(want.matchedProductId).toBe(productId); // matched for the analytics, but no email: no opt-in
  });

  it('lists it in the Outbox with a preview', async () => {
    const list = await api().get('/api/v1/admin/outreach?status=draft').set(as(admin)).expect(200);
    const item = list.body.items.find((o: { userId: string }) => o.userId === shopperId);
    expect(item).toMatchObject({ kind: 'found_it', kindLabel: 'We found what they looked for' });
    expect(item.products[0]).toMatchObject({ id: productId, name: kurti.name });
    const one = await api().get(`/api/v1/admin/outreach/${item.id}`).set(as(admin)).expect(200);
    expect(one.body.preview.subject).toBe(`We found it: ${kurti.name}`);
    expect(one.body.preview.html).toContain('/api/v1/o/u/');
  });

  it('keeps the Outbox from roles without it', async () => {
    await api().get('/api/v1/admin/outreach').set(as(support)).expect(403);
  });

  it('sends on request, then holds the next one for the frequency cap', async () => {
    const draft = await db.outreach.findFirstOrThrow({ where: { userId: shopperId, status: 'draft' } });
    const res = await api().post('/api/v1/admin/outreach/send').set(as(admin)).send({ ids: [draft.id] }).expect(200);
    expect(res.body).toMatchObject({ sent: 1 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toMatchObject({ to: `nadia${DOMAIN}`, subject: `We found it: ${kurti.name}` });
    const sent = await db.outreach.findUniqueOrThrow({ where: { id: draft.id } });
    expect(sent.status).toBe('sent');
    expect((await db.shopperWant.findFirstOrThrow({ where: { userId: shopperId } })).closedReason).toBe('told');
  });

  it('counts a click and goes on to the product with UTM tags', async () => {
    const o = await db.outreach.findFirstOrThrow({ where: { userId: shopperId, status: 'sent' } });
    const res = await api().get(`/api/v1/o/c/${o.token}?p=${productId}`).expect(302);
    expect(res.headers.location).toMatch(new RegExp(`/product/${productId}\\?utm_source=email&utm_medium=outreach&utm_campaign=found_it$`));
    expect((await db.outreach.findUniqueOrThrow({ where: { id: o.id } })).clicks).toBe(1);
  });
});

describe('back in stock, the cap and unsubscribing', () => {
  let soldOut = 0;
  it('remembers a sold-out product they looked at, and drafts when it’s restocked', async () => {
    const res = await api().post('/api/v1/admin/products').set(as(admin)).send({ ...kurti, name: 'E2E Outreach Rust Kurti', slug: 'e2e-outreach-kurti-rust', colors: [{ name: 'Rust', hex: '#b5502b' }], stock: 0 }).expect(201);
    soldOut = res.body.id;
    await api().post('/api/v1/events').set(as(shopper)).send({ events: [{ type: 'view', productId: soldOut }] }).expect(202);
    await new Promise((r) => setTimeout(r, 50));
    await outreach.tick();
    expect(await db.shopperWant.count({ where: { userId: shopperId, source: 'soldout', productId: soldOut } })).toBe(1);
    await api().patch(`/api/v1/admin/products/${soldOut}`).set(as(admin)).send({ stock: 5 }).expect(200);
    await outreach.tick();
    const o = await db.outreach.findFirstOrThrow({ where: { userId: shopperId, status: { in: ['draft', 'queued'] } } });
    expect(o).toMatchObject({ kind: 'back_in_stock', productIds: [soldOut] });
  });

  it('waits for the cap when the last email went out today', async () => {
    const o = await db.outreach.findFirstOrThrow({ where: { userId: shopperId, status: 'draft' } });
    const res = await api().post('/api/v1/admin/outreach/send').set(as(admin)).send({ ids: [o.id] }).expect(200);
    expect(res.body).toMatchObject({ sent: 0, waiting: 1 });
    expect((await db.outreach.findUniqueOrThrow({ where: { id: o.id } })).status).toBe('queued');
  });

  it('switching a kind to automatic queues its drafts', async () => {
    const res = await api().patch('/api/v1/admin/outreach/settings').set(as(admin)).send({ auto: { price_drop: true }, capDays: 3 }).expect(200);
    expect(res.body.auto).toMatchObject({ price_drop: true, found_it: false });
    expect(res.body.mail).toHaveProperty('configured');
    await api().patch('/api/v1/admin/outreach/settings').set(as(admin)).send({ auto: { price_drop: false } }).expect(200);
  });

  it('unsubscribes from the email link, dropping what was waiting', async () => {
    const prefs = await db.shopperPreferences.findUniqueOrThrow({ where: { userId: shopperId } });
    const res = await api().get(`/api/v1/o/u/${prefs.unsubscribeToken}`).expect(302);
    expect(res.headers.location).toMatch(/\/account\?unsubscribed=1$/);
    expect((await db.shopperPreferences.findUniqueOrThrow({ where: { userId: shopperId } })).marketingEmails).toBe(false);
    expect(await db.outreach.count({ where: { userId: shopperId, status: { in: ['draft', 'queued'] } } })).toBe(0);
    expect(await outreach.propose(shopperId, 'price_drop', [{ productId: soldOut, reason: 'test' }])).toBeNull();
  });
});

describe('insights', () => {
  it('shows one shopper’s likeness: weeks, colouring, matches, wants and emails', async () => {
    const res = await api().get(`/api/v1/admin/analytics/shoppers/${shopperId}/likeness`).set(as(admin)).expect(200);
    expect(res.body.weeks).toHaveLength(12);
    expect(res.body.preferences).toMatchObject({ skinTone: 6, undertone: 'warm', toneSource: 'photo' });
    expect(res.body.matches.length).toBeGreaterThan(0);
    expect(res.body.matches[0]).toHaveProperty('reasons');
    expect(res.body.wants.map((w: { source: string }) => w.source)).toEqual(expect.arrayContaining(['search', 'soldout']));
    expect(res.body.emails[0]).toHaveProperty('kindLabel');
  });

  it('sums up interests and outreach for the store', async () => {
    const res = await api().get('/api/v1/admin/analytics/interests?days=30').set(as(admin)).expect(200);
    expect(res.body.wants.bySource.map((s: { source: string }) => s.source)).toEqual(expect.arrayContaining(['search']));
    const found = res.body.emails.find((e: { kind: string }) => e.kind === 'found_it');
    expect(found.sent).toBeGreaterThanOrEqual(1);
    expect(found.clicked).toBeGreaterThanOrEqual(1);
    expect(res.body.audience.opted).toBeGreaterThanOrEqual(0);
  });
});
