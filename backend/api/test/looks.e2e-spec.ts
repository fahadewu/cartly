// "Ask family" shared looks, end to end against the real local Redis + Postgres.
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import sharp from 'sharp';
import request from 'supertest';
import { createApp } from '../src/main.js';
import { PrismaService, RedisService } from '../src/common/infra.module.js';

let app: INestApplication;
let db: PrismaService;
let redis: RedisService;
const api = () => request(app.getHttpServer());
const DOMAIN = '@looks-e2e.test';
let shopper = '';
let shopperId = '';
const as = (token: string) => ({ Authorization: `Bearer ${token}` });

beforeAll(async () => {
  app = await createApp();
  await app.init();
  db = app.get(PrismaService);
  redis = app.get(RedisService);
  const u = await db.user.create({ data: { email: `maya${DOMAIN}`, name: 'Maya Chowdhury', passwordHash: 'x' } });
  shopperId = u.id;
  shopper = await app.get(JwtService).signAsync({ sub: u.id, email: u.email, role: 'CUSTOMER' });
});

afterAll(async () => {
  const tokens = await redis.zrange(`looks:user:${shopperId}`, '0', '-1');
  for (const t of tokens) await redis.del(`look:${t}`, `look:${t}:img`, `look:${t}:votes`);
  await redis.del(`looks:user:${shopperId}`, `looksum:${shopperId}`);
  await db.user.deleteMany({ where: { email: { endsWith: DOMAIN } } });
  await app.close();
});

describe('shared looks', () => {
  it('lets a guest share a look and family vote on it without an account', async () => {
    await api().post('/api/v1/looks').send({ items: [] }).expect(400);
    await api().post('/api/v1/looks').send({ items: [{ productId: 999999 }] }).expect(400);
    const made = await api()
      .post('/api/v1/looks')
      .send({ items: [{ productId: 17, color: 'scarlet', size: 'm' }, { productId: 14, color: 'Neon' }], note: 'Which one for Eid?', name: 'Rumi' })
      .expect(201);
    const { token, ownerKey } = made.body;
    expect(token).toMatch(/^[A-Za-z0-9_-]{16}$/);

    const view = await api().get(`/api/v1/looks/${token}`).expect(200);
    expect(view.body).toMatchObject({ name: 'Rumi', note: 'Which one for Eid?', image: false, total: 0 });
    expect(view.body.items).toEqual([
      { productId: 17, color: 'Scarlet', size: 'M' },
      { productId: 14, color: null, size: null }, // a colour the product doesn't come in is dropped
    ]);
    expect(view.body).not.toHaveProperty('ownerKeyHash');

    const ammu = randomUUID();
    await api().post(`/api/v1/looks/${token}/votes`).send({ voterId: ammu, reaction: 'meh' }).expect(400);
    await api().post(`/api/v1/looks/${token}/votes`).send({ voterId: ammu, reaction: 'yes', name: 'Ammu' }).expect(200);
    // Changing your mind replaces your vote rather than adding one.
    await api().post(`/api/v1/looks/${token}/votes`).send({ voterId: ammu, reaction: 'love', name: 'Ammu', tags: ['occasion'], comment: 'Perfect for Eid <3' }).expect(200);
    const after = await api().post(`/api/v1/looks/${token}/votes`).send({ voterId: randomUUID(), reaction: 'unsure', tags: ['too-bright'] }).expect(200);
    expect(after.body).toMatchObject({ total: 2, reactions: { love: 1, yes: 0, unsure: 1, no: 0 }, tags: { occasion: 1, 'too-bright': 1 } });
    expect(after.body.votes[0]).toMatchObject({ name: 'Ammu', reaction: 'love', comment: 'Perfect for Eid 3' });

    // Only the sharer can add the photo or stop sharing.
    const jpg = await sharp({ create: { width: 60, height: 90, channels: 3, background: '#d33' } }).jpeg().withMetadata({ exif: { IFD0: { Make: 'Phone' } } }).toBuffer();
    await api().post(`/api/v1/looks/${token}/image`).attach('file', jpg, 'look.jpg').expect(403);
    await api().post(`/api/v1/looks/${token}/image`).set('x-look-key', 'wrong').attach('file', jpg, 'look.jpg').expect(403);
    await api().post(`/api/v1/looks/${token}/image`).set('x-look-key', ownerKey).attach('file', jpg, 'look.jpg').expect(201);
    const img = await api().get(`/api/v1/looks/${token}/image`).expect(200).expect('content-type', 'image/jpeg');
    expect((await sharp(img.body).metadata()).exif).toBeUndefined();
    expect(await redis.ttl(`look:${token}:img`)).toBeGreaterThan(6 * 86_400);

    await api().delete(`/api/v1/looks/${token}`).set(as(shopper)).expect(403);
    await api().delete(`/api/v1/looks/${token}`).set('x-look-key', ownerKey).expect(204);
    await api().get(`/api/v1/looks/${token}`).expect(404);
    await api().get(`/api/v1/looks/${token}/image`).expect(404);
    expect(await redis.exists(`look:${token}:votes`)).toBe(0);
  });

  it('keeps a signed-in shopper’s looks and a summary of the votes for Pip', async () => {
    await api().get('/api/v1/looks/mine').expect(401);
    const made = await api().post('/api/v1/looks').set(as(shopper)).send({ items: [{ productId: 17 }] }).expect(201);
    const { token } = made.body;
    expect((await api().get(`/api/v1/looks/${token}`).expect(200)).body.name).toBe('Maya');
    expect(await redis.get(`looksum:${shopperId}`)).toBeNull(); // nothing to say before anyone votes

    await api().post(`/api/v1/looks/${token}/votes`).send({ voterId: randomUUID(), reaction: 'love', name: 'Apu', comment: 'Take the red one' }).expect(200);
    const mine = await api().get('/api/v1/looks/mine').set(as(shopper)).expect(200);
    expect(mine.body[0]).toMatchObject({ token, total: 1, reactions: { love: 1 } });
    const summary = JSON.parse((await redis.get(`looksum:${shopperId}`))!);
    expect(summary).toMatchObject({ items: [17], reactions: { love: 1 }, comments: [{ name: 'Apu', comment: 'Take the red one' }] });

    await api().delete(`/api/v1/looks/${token}`).set(as(shopper)).expect(204);
    expect((await api().get('/api/v1/looks/mine').set(as(shopper)).expect(200)).body).toEqual([]);
    expect(await redis.get(`looksum:${shopperId}`)).toBeNull();
  });

  it('treats unknown and malformed links as gone', async () => {
    await api().get('/api/v1/looks/AAAAAAAAAAAAAAAAAAAAAA').expect(404);
    await api().get('/api/v1/looks/..%2Fadmin').expect(404);
    await api().post('/api/v1/looks/AAAAAAAAAAAAAAAAAAAAAA/votes').send({ voterId: randomUUID(), reaction: 'love' }).expect(404);
  });
});
