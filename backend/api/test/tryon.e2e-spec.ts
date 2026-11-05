// Try-on, photo checks and voice gateway, against the real local Postgres + Redis.
// None of these tests need AI keys: paid calls are rejected before they would reach a vendor.
import { unlink } from 'node:fs/promises';
import path from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import sharp from 'sharp';
import request from 'supertest';
import { createApp } from '../src/main.js';
import { PrismaService } from '../src/common/infra.module.js';
import { Prisma } from '../src/generated/prisma/client.js';
import { env } from '../src/config.js';

let app: INestApplication;
let db: PrismaService;
const api = () => request(app.getHttpServer());
const DOMAIN = '@tryon-e2e.test';
let admin = '';
let shopper = '';
const as = (token: string) => ({ Authorization: `Bearer ${token}` });
const uploaded: string[] = [];

// A 900×1200 studio-style product shot: navy shirt on a light grey backdrop.
const shirtPhoto = () =>
  sharp({ create: { width: 900, height: 1200, channels: 3, background: '#f2f2f2' } })
    .composite([{ input: { create: { width: 500, height: 800, channels: 3, background: '#1f2a44' } }, top: 200, left: 200 }])
    .jpeg()
    .withMetadata({ exif: { IFD0: { Artist: 'Should be stripped' } } })
    .toBuffer();

beforeAll(async () => {
  app = await createApp();
  await app.init();
  db = app.get(PrismaService);
  const jwt = app.get(JwtService);
  const seededAdmin = await db.user.findUniqueOrThrow({ where: { email: 'admin@cartly.dev' } });
  admin = await jwt.signAsync({ sub: seededAdmin.id, email: seededAdmin.email, role: 'ADMIN' });
  const u = await db.user.create({ data: { email: `shopper${DOMAIN}`, name: 'Try-on Shopper', passwordHash: 'x' } });
  shopper = await jwt.signAsync({ sub: u.id, email: u.email, role: 'CUSTOMER' });
});

afterAll(async () => {
  await db.user.deleteMany({ where: { email: { endsWith: DOMAIN } } });
  await db.product.update({ where: { id: 5 }, data: { tryOnImage: null, tryOnInfo: Prisma.DbNull } });
  await Promise.all(uploaded.map((f) => unlink(path.join(env.uploadDir, 'tryon', f)).catch(() => {})));
  await app.close();
});

describe('capabilities and voice', () => {
  it('reports what the AI service can do, even when it is down', async () => {
    const r = await api().get('/api/v1/assistant/capabilities').expect(200);
    expect(r.body).toHaveProperty('tryon');
    expect(r.body.speech).toHaveProperty('stt');
  });

  it('asks for a message unless it is a greeting', async () => {
    await api().post('/api/v1/assistant/chat').send({ kind: 'message' }).expect(400);
    await api().post('/api/v1/assistant/chat').send({ kind: 'shout', message: 'hi' }).expect(400);
  });

  it('keeps paid voice endpoints behind sign-in and checks inputs', async () => {
    await api().post('/api/v1/assistant/speak').send({ text: 'hello' }).expect(401);
    await api().post('/api/v1/assistant/transcribe').attach('audio', Buffer.from('x'), 'a.webm').expect(401);
    await api().post('/api/v1/assistant/speak').set(as(shopper)).send({ text: 'hello', lang: 'not a language!' }).expect(400);
    await api().post('/api/v1/assistant/transcribe').set(as(shopper)).attach('audio', Buffer.from('x'), { filename: 'a.txt', contentType: 'text/plain' }).expect(400);
  });
});

describe('shopper try-on', () => {
  it('needs sign-in, wearable products, and consent for a personal photo', async () => {
    await api().post('/api/v1/tryon/render').field('productIds', '[17]').field('sample', '0').expect(401);
    const bad = await api().post('/api/v1/tryon/render').set(as(shopper)).field('productIds', '[30]').field('sample', '0').expect(400);
    expect(bad.body.message).toMatch(/can’t be tried on/);
    await api().post('/api/v1/tryon/render').set(as(shopper)).field('productIds', '[17]').expect(400);
    const photo = await shirtPhoto();
    const noConsent = await api().post('/api/v1/tryon/render').set(as(shopper)).field('productIds', '[17]').attach('photo', photo, { filename: 'me.jpg', contentType: 'image/jpeg' }).expect(400);
    expect(noConsent.body.message).toMatch(/photo notice/);
    await api().post('/api/v1/tryon/render').set(as(shopper)).field('productIds', '[1,2,3,4,5,6,7]').field('sample', '0').expect(400);
  });
});

describe('admin try-on photos', () => {
  it('uploads a photo: re-encoded, metadata stripped, served, and quality-checked', async () => {
    await api().post('/api/v1/admin/try-on/photo').set(as(shopper)).field('slot', 'top').attach('file', await shirtPhoto(), 'shirt.jpg').expect(403);
    const r = await api()
      .post('/api/v1/admin/try-on/photo')
      .set(as(admin))
      .field('slot', 'top')
      .field('name', 'Test Shirt')
      .field('colors', 'Navy')
      .attach('file', await shirtPhoto(), { filename: 'shirt.jpg', contentType: 'image/jpeg' })
      .expect(201);
    expect(r.body).toMatchObject({ width: 900, height: 1200 });
    expect(r.body.url).toMatch(/\/api\/v1\/uploads\/tryon\/[\w-]+\.jpg$/);
    expect(r.body.check.issues.some((i: { code: string }) => i.code === 'low_resolution')).toBe(true); // 900px: works, 1024+ is better
    const file = r.body.url.split('/').pop();
    uploaded.push(file);

    const served = await api().get(`/api/v1/uploads/tryon/${file}`).expect(200);
    expect(served.headers['content-type']).toBe('image/jpeg');
    expect(served.headers['x-content-type-options']).toBe('nosniff');
    expect(served.headers['access-control-allow-origin']).toBe('*'); // the storefront draws them on a canvas
    expect((await sharp(served.body).metadata()).exif).toBeUndefined();

    await api().post('/api/v1/admin/try-on/photo').set(as(admin)).field('slot', 'top').attach('file', Buffer.from('<svg/>'), { filename: 'x.svg', contentType: 'image/svg+xml' }).expect(400);
    await api().post('/api/v1/admin/try-on/photo').set(as(admin)).field('slot', 'cape').attach('file', await shirtPhoto(), 'shirt.jpg').expect(400);
  });

  it('saves the try-on photo and details on the product, keeping only known fields', async () => {
    const check = { ok: true, score: 88, grade: 'good', issues: [{ level: 'warn', code: 'low_resolution', message: 'm', extra: 'x' }], secret: 'drop me' };
    const r = await api()
      .patch('/api/v1/admin/products/5')
      .set(as(admin))
      .send({ tryOnImage: 'https://images.unsplash.com/photo-1556905055-8f358a7a47b2?w=900', tryOnInfo: { photoType: 'flat-lay', styling: ' tuck it in ', check, crop: [0.1, 0.2, 0.9, 0.8], cutout: 'plain' } })
      .expect(200);
    expect(r.body.tryOnInfo).toMatchObject({ photoType: 'flat-lay', styling: 'tuck it in', check: { ok: true, score: 88, issues: [{ level: 'warn', code: 'low_resolution', message: 'm' }] }, crop: [0.1, 0.2, 0.9, 0.8], cutout: 'plain' });
    expect(r.body.tryOnInfo.check.secret).toBeUndefined();
    expect(r.body.tryOnInfo.check.issues[0].extra).toBeUndefined();
    await api().patch('/api/v1/admin/products/5').set(as(admin)).send({ tryOnInfo: { photoType: 'on-a-hanger' } }).expect(400);
    await api().patch('/api/v1/admin/products/5').set(as(admin)).send({ tryOnInfo: { cutout: 'magic' } }).expect(400);
    await api().patch('/api/v1/admin/products/5').set(as(admin)).send({ tryOnInfo: { crop: [0, 0, 2, 1] } }).expect(400);
    const flipped = await api().patch('/api/v1/admin/products/5').set(as(admin)).send({ tryOnInfo: { crop: [0.9, 0, 0.1, 1] } }).expect(200);
    expect(flipped.body.tryOnInfo.crop).toBeUndefined(); // an inside-out crop is dropped

    const shop = await api().get('/api/v1/products/5').expect(200);
    expect(shop.body.tryOn).toEqual({ slot: 'top', image: 'https://images.unsplash.com/photo-1556905055-8f358a7a47b2?w=900', cutout: null, crop: null });
    // Clothes aren't in the quick preview, so they never get a cut-out.
    expect((await api().post('/api/v1/admin/try-on/cutout').set(as(admin)).send({ productId: 5 }).expect(201)).body.url).toBeNull();
    await api().post('/api/v1/admin/try-on/cutout').set(as(admin)).send({ productId: 99999 }).expect(404);
    expect(shop.body.tryOnInfo).toBeUndefined(); // admin-only details stay out of the storefront
  });
});

describe('uploaded photos on a local API', () => {
  it('accepts localhost upload URLs for the try-on photo', async () => {
    const url = `${env.publicUrl}/api/v1/uploads/tryon/example.jpg`;
    const r = await api().patch('/api/v1/admin/products/5').set(as(admin)).send({ tryOnImage: url }).expect(200);
    expect(r.body.tryOnImage).toBe(url);
  });
});
