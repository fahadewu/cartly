// Admin API end-to-end tests against the real local Postgres + Redis (run `npx prisma db seed` first).
// Tokens are signed directly so these tests never touch the rate-limited login endpoint.
import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { createApp } from '../src/main.js';
import { PrismaService } from '../src/common/infra.module.js';

let app: INestApplication;
let db: PrismaService;
const api = () => request(app.getHttpServer());
const DOMAIN = '@admin-e2e.test';
let admin = '';
let shopper = '';
let shopperId = '';
const as = (token: string) => ({ Authorization: `Bearer ${token}` });

const product = {
  name: 'E2E Linen Overshirt',
  description: 'A breathable linen overshirt made for testing the admin API.',
  category: 'clothing-shoes',
  type: 'Clothing',
  gender: 'unisex',
  label: 'Test',
  price: 64,
  stock: 3,
  image: 'https://images.unsplash.com/photo-1602810318383-e386cc2a3ccf?w=600&q=80',
  colors: [{ name: 'Olive', hex: '#6b7a4b' }],
  sizes: ['S', 'M', 'L'],
  collections: ['winter-weekend'],
  tryOnSlot: 'top',
  // What Pip needs to recommend it.
  material: '100% linen',
  fit: 'relaxed',
  occasions: ['everyday', 'travel'],
  seasons: ['summer'],
  styleTags: ['Minimal', 'relaxed', 'minimal'],
  features: ['Breathable linen', 'Chest pockets'],
  keywords: ['Overshirt', 'shacket', 'শার্ট'],
};

beforeAll(async () => {
  app = await createApp();
  await app.init();
  db = app.get(PrismaService);
  const jwt = app.get(JwtService);
  const seededAdmin = await db.user.findUniqueOrThrow({ where: { email: 'admin@cartly.dev' } });
  admin = await jwt.signAsync({ sub: seededAdmin.id, email: seededAdmin.email, role: 'ADMIN' });
  const u = await db.user.create({ data: { email: `shopper${DOMAIN}`, name: 'Admin E2E Shopper', passwordHash: 'x' } });
  shopperId = u.id;
  shopper = await jwt.signAsync({ sub: u.id, email: u.email, role: 'CUSTOMER' });
});

afterAll(async () => {
  const orders = await db.order.findMany({ where: { user: { email: { endsWith: DOMAIN } } }, select: { id: true } });
  await db.orderItem.deleteMany({ where: { orderId: { in: orders.map((o) => o.id) } } });
  await db.auditEntry.deleteMany({ where: { target: { contains: DOMAIN } } });
  await db.user.deleteMany({ where: { email: { endsWith: DOMAIN } } });
  await db.product.deleteMany({ where: { slug: { startsWith: 'e2e-' } } });
  await db.promoCode.deleteMany({ where: { code: { startsWith: 'E2E' } } });
  await app.close();
});

describe('access', () => {
  it('requires a signed-in admin', async () => {
    await api().get('/api/v1/admin/stats').expect(401);
    await api().get('/api/v1/admin/stats').set(as(shopper)).expect(403);
    const stats = await api().get('/api/v1/admin/stats?days=7').set(as(admin)).expect(200);
    expect(stats.body.series).toHaveLength(7);
    expect(stats.body.orders.byStatus).toHaveProperty('PROCESSING');
    await api().get('/api/v1/admin/stats?days=12').set(as(admin)).expect(400);
  });

  it('applies role changes immediately, even to tokens issued before the change', async () => {
    await api().patch(`/api/v1/admin/users/${shopperId}`).set(as(admin)).send({ role: 'ADMIN' }).expect(200);
    await api().get('/api/v1/admin/system').set(as(shopper)).expect(200); // old CUSTOMER token, now admin
    await api().patch(`/api/v1/admin/users/${shopperId}`).set(as(admin)).send({ role: 'CUSTOMER' }).expect(200);
    await api().get('/api/v1/admin/system').set(as(shopper)).expect(403);

    const me = await db.user.findUniqueOrThrow({ where: { email: 'admin@cartly.dev' } });
    await api().patch(`/api/v1/admin/users/${me.id}`).set(as(admin)).send({ role: 'CUSTOMER' }).expect(400);
  });

  it('shows a customer with their orders and spend', async () => {
    const list = await api().get('/api/v1/admin/users?q=admin-e2e').set(as(admin)).expect(200);
    expect(list.body.items.map((u: any) => u.id)).toEqual([shopperId]);
    const detail = await api().get(`/api/v1/admin/users/${shopperId}`).set(as(admin)).expect(200);
    expect(detail.body.stats).toMatchObject({ orders: 0, spent: 0 });
  });
});

describe('products', () => {
  let id = 0;

  it('validates cross-field rules', async () => {
    await api().post('/api/v1/admin/products').set(as(admin)).send({ ...product, type: 'Home' }).expect(400);
    await api().post('/api/v1/admin/products').set(as(admin)).send({ ...product, compareAt: 50 }).expect(400);
    await api().post('/api/v1/admin/products').set(as(admin)).send({ ...product, collections: ['nope'] }).expect(400);
    await api().post('/api/v1/admin/products').set(as(admin)).send({ ...product, colors: [{ name: 'Olive', hex: 'green' }] }).expect(400);
  });

  it('won’t save a product without the details Pip needs', async () => {
    const { material, occasions, ...thin } = product;
    const res = await api().post('/api/v1/admin/products').set(as(admin)).send({ ...thin, slug: 'e2e-thin-overshirt', occasions: [] }).expect(400);
    expect(res.body.message).toBe('Pip needs the material and at least one occasion before this product can be saved.');
    expect(material && occasions).toBeTruthy();
  });

  it('creates a product that shows up in the storefront', async () => {
    const res = await api().post('/api/v1/admin/products').set(as(admin)).send({ ...product, slug: 'e2e-linen-overshirt' }).expect(201);
    id = res.body.id;
    expect(res.body).toMatchObject({
      slug: 'e2e-linen-overshirt',
      stock: 3,
      active: true,
      photo: '1602810318383-e386cc2a3ccf',
      tryOn: { slot: 'top' },
      styleTags: ['minimal', 'relaxed'], // tidied: lower-case, no repeats
      keywords: ['overshirt', 'shacket', 'শার্ট'],
      details: { required: [], suggested: ['a dedicated try-on photo'] },
    });
    await api().post('/api/v1/admin/products').set(as(admin)).send({ ...product, slug: 'e2e-linen-overshirt' }).expect(409);

    const page = await api().get('/api/v1/products/e2e-linen-overshirt').expect(200);
    expect(page.body.lowStock).toBe(3);
    const boot = await api().get('/api/v1/catalog').expect(200);
    expect(boot.body.products.some((p: any) => p.id === id)).toBe(true);
  });

  it('archives a product: hidden from shoppers, still visible to admins', async () => {
    await api().patch(`/api/v1/admin/products/${id}`).set(as(admin)).send({ active: false, price: 59 }).expect(200);
    await api().get('/api/v1/products/e2e-linen-overshirt').expect(404);
    await api().post('/api/v1/cart/items').set(as(shopper)).send({ productId: id, size: 'M' }).expect(404);
    const archived = await api().get('/api/v1/admin/products?status=archived&q=linen').set(as(admin)).expect(200);
    expect(archived.body.items[0]).toMatchObject({ id, active: false, price: 59 });
    await api().patch(`/api/v1/admin/products/${id}`).set(as(admin)).send({ active: true }).expect(200);
  });

  it('only deletes products that were never ordered', async () => {
    await api().delete('/api/v1/admin/products/2').set(as(admin)).expect(409);
    await api().delete(`/api/v1/admin/products/${id}`).set(as(admin)).expect(204);
    await api().get(`/api/v1/admin/products/${id}`).set(as(admin)).expect(404);
  });
});

describe('orders', () => {
  const checkout = {
    address: { name: 'Admin E2E', street: '1 Test Street', city: 'London', postal: 'E1 6AN', country: 'United Kingdom' },
    delivery: 'standard',
    payment: { nameOnCard: 'Admin E2E', cardNumber: '4242 4242 4242 4242', expiry: '12/30', cvc: '123' },
  };

  it('moves an order through fulfilment and restocks on cancel', async () => {
    const stock = async () => (await db.product.findUniqueOrThrow({ where: { id: 13 } })).stock;
    const before = await stock();
    await api().post('/api/v1/cart/items').set(as(shopper)).send({ productId: 13, size: '40', qty: 2 }).expect(201);
    const order = (await api().post('/api/v1/orders').set(as(shopper)).send(checkout).expect(201)).body;
    expect(await stock()).toBe(before - 2);

    const listed = await api().get(`/api/v1/admin/orders?q=${order.id}`).set(as(admin)).expect(200);
    expect(listed.body.items[0]).toMatchObject({ id: order.id, itemCount: 2, customer: { id: shopperId } });

    const shipped = await api().patch(`/api/v1/admin/orders/${order.id}/status`).set(as(admin)).send({ status: 'SHIPPED' }).expect(200);
    expect(shipped.body).toMatchObject({ status: 'SHIPPED', next: ['DELIVERED', 'CANCELLED'] });
    await api().post(`/api/v1/orders/${order.id}/cancel`).set(as(shopper)).expect(409); // shipped: shoppers can't cancel
    await api().patch(`/api/v1/admin/orders/${order.id}/status`).set(as(admin)).send({ status: 'PROCESSING' }).expect(409);

    await api().patch(`/api/v1/admin/orders/${order.id}/status`).set(as(admin)).send({ status: 'CANCELLED' }).expect(200);
    expect(await stock()).toBe(before);
    await api().patch(`/api/v1/admin/orders/${order.id}/status`).set(as(admin)).send({ status: 'DELIVERED' }).expect(409);
    await api().get('/api/v1/admin/orders/CL-00000').set(as(admin)).expect(404);
  });
});

describe('promotions, reviews and requests', () => {
  it('creates, pauses and deletes promo codes', async () => {
    const created = await api().post('/api/v1/admin/promos').set(as(admin)).send({ code: 'e2esave', percentOff: 15 }).expect(201);
    expect(created.body).toMatchObject({ code: 'E2ESAVE', percentOff: 15, active: true, uses: 0 });
    await api().post('/api/v1/admin/promos').set(as(admin)).send({ code: 'E2ESAVE', percentOff: 15 }).expect(409);

    await api().post('/api/v1/cart/items').set(as(shopper)).send({ productId: 13, size: '41' }).expect(201);
    const applied = await api().post('/api/v1/cart/promo').set(as(shopper)).send({ code: 'E2ESAVE' }).expect(200);
    expect(applied.body.promoCode).toBe('E2ESAVE');

    await api().patch('/api/v1/admin/promos/E2ESAVE').set(as(admin)).send({ active: false }).expect(200);
    const cart = await api().get('/api/v1/cart').set(as(shopper)).expect(200);
    expect(cart.body).toMatchObject({ promoCode: null, discount: 0 }); // paused codes stop applying
    await api().post('/api/v1/cart/promo').set(as(shopper)).send({ code: 'E2ESAVE' }).expect(400);
    await api().delete('/api/v1/admin/promos/E2ESAVE').set(as(admin)).expect(204);
    await api().delete('/api/v1/cart').set(as(shopper)).expect(204);
  });

  it('removes a review and takes it out of the rating', async () => {
    const r = await api().post('/api/v1/products/13/reviews').set(as(shopper)).send({ rating: 1, text: 'Testing the moderation queue.' }).expect(201);
    const before = await db.product.findUniqueOrThrow({ where: { id: 13 } });
    const queue = await api().get('/api/v1/admin/reviews?source=customer&productId=13').set(as(admin)).expect(200);
    expect(queue.body.items.some((x: any) => x.id === r.body.id)).toBe(true);
    await api().delete(`/api/v1/admin/reviews/${r.body.id}`).set(as(admin)).expect(204);
    const after = await db.product.findUniqueOrThrow({ where: { id: 13 } });
    expect(after.reviewCount).toBe(before.reviewCount - 1);
    expect(after.rating).toBeGreaterThanOrEqual(before.rating);
  });

  it('turns fit reviews into a "runs small" verdict, one vote per shopper, and takes them back out', async () => {
    const jwt = app.get(JwtService);
    const reviewers = await Promise.all(
      [1, 2].map(async (n) => {
        const u = await db.user.create({ data: { email: `fit${n}${DOMAIN}`, name: `Fit Reviewer ${n}`, passwordHash: 'x' } });
        return jwt.signAsync({ sub: u.id, email: u.email, role: 'CUSTOMER' });
      }),
    );
    const before = await db.product.findUniqueOrThrow({ where: { id: 17 } });
    const ids: string[] = [];
    const post = async (token: string, body: object) => {
      const r = await api().post('/api/v1/products/17/reviews').set(as(token)).send({ rating: 4, text: 'Lovely dress, but check the size first.', ...body }).expect(201);
      ids.push(r.body.id);
      return r.body;
    };
    try {
      await api().post('/api/v1/products/17/reviews').set(as(shopper)).send({ rating: 4, text: 'Lovely dress overall.', size: 'XXXL' }).expect(400);
      await api().post('/api/v1/products/17/reviews').set(as(shopper)).send({ rating: 4, text: 'Lovely dress overall.', photos: ['https://evil.example/x.jpg'] }).expect(400);
      const first = await post(shopper, { size: 'm', fit: 'small', heightCm: 162, usualSize: 'M' });
      expect(first).toMatchObject({ size: 'M', fit: 'small', heightCm: 162, usualSize: 'M', verified: false, photos: [] });
      await post(shopper, { fit: 'small' }); // the same shopper again: still one vote
      await post(reviewers[0], { size: 'S', fit: 'small' });
      await post(reviewers[1], { size: 'M', fit: 'true' });
      const p = await db.product.findUniqueOrThrow({ where: { id: 17 } });
      const own = (p.fitVotes as any).small - ((before.fitVotes as any).small ?? 0);
      expect(own).toBe(2);
      const detail = await api().get('/api/v1/products/17').expect(200);
      expect(detail.body.fitFeedback.small).toBeGreaterThanOrEqual(2);
      expect(detail.body.ratingCounts).toHaveLength(5);
      expect(detail.body.ratingCounts[1]).toBeGreaterThanOrEqual(4); // four-star reviews are counted for real
    } finally {
      for (const id of ids) await api().delete(`/api/v1/admin/reviews/${id}`).set(as(admin)).expect(204);
    }
    const after = await db.product.findUniqueOrThrow({ where: { id: 17 } });
    const zero = { small: 0, true: 0, large: 0, returnsSmall: 0, returnsLarge: 0 };
    expect({ ...zero, ...(after.fitVotes as object) }).toEqual({ ...zero, ...(before.fitVotes as object) });
    expect(after.fitVerdict).toBe(before.fitVerdict);
  });

  it('stores review photos without their metadata and deletes them with the review', async () => {
    const sharp = (await import('sharp')).default;
    const jpg = await sharp({ create: { width: 40, height: 30, channels: 3, background: '#c33' } }).jpeg().withMetadata({ exif: { IFD0: { Make: 'E2E Camera' } } }).toBuffer();
    await api().post('/api/v1/reviews/photos').attach('file', jpg, 'p.jpg').expect(401);
    await api().post('/api/v1/reviews/photos').set(as(shopper)).attach('file', Buffer.from('not an image'), 'x.jpg').expect(400);
    const up = await api().post('/api/v1/reviews/photos').set(as(shopper)).attach('file', jpg, 'p.jpg').expect(201);
    expect(up.body.url).toMatch(/\/api\/v1\/uploads\/reviews\/[0-9a-f-]{36}\.jpg$/);
    const file = new URL(up.body.url).pathname.replace('/api/v1', '');
    const served = await api().get(`/api/v1${file}`).expect(200);
    expect((await sharp(served.body).metadata()).exif).toBeUndefined();
    const r = await api().post('/api/v1/products/13/reviews').set(as(shopper)).send({ rating: 5, text: 'Photo of how it looks on.', photos: [up.body.url] }).expect(201);
    expect(r.body.photos).toEqual([up.body.url]);
    await api().delete(`/api/v1/admin/reviews/${r.body.id}`).set(as(admin)).expect(204);
    await api().get(`/api/v1${file}`).expect(404);
  });

  it('keeps the support contact Pip hands shoppers to, and shows it publicly', async () => {
    const before = (await api().get('/api/v1/admin/support').set(as(admin)).expect(200)).body;
    try {
      await api().patch('/api/v1/admin/support').set(as(shopper)).send({ whatsapp: '8801700000000' }).expect(403);
      await api().patch('/api/v1/admin/support').set(as(admin)).send({ whatsapp: '+880 17-000' }).expect(400);
      const saved = await api().patch('/api/v1/admin/support').set(as(admin)).send({ whatsapp: '8801700000000', phone: '+880 9612 000000', hours: ' Sat–Thu ' }).expect(200);
      expect(saved.body).toEqual({ whatsapp: '8801700000000', phone: '+880 9612 000000', hours: 'Sat–Thu' });
      expect((await api().get('/api/v1/support').expect(200)).body.whatsapp).toBe('8801700000000');
      const cleared = await api().patch('/api/v1/admin/support').set(as(admin)).send({ phone: null }).expect(200);
      expect(cleared.body).toMatchObject({ whatsapp: '8801700000000', phone: null }); // fields not sent are kept
    } finally {
      await api().patch('/api/v1/admin/support').set(as(admin)).send(before).expect(200);
    }
  });

  it('runs the stamp card: off by default, a head start, a personal single-use reward', async () => {
    const before = (await api().get('/api/v1/admin/loyalty').set(as(admin)).expect(200)).body;
    const jwt = app.get(JwtService);
    const other = await db.user.create({ data: { email: `stamps-other${DOMAIN}`, name: 'Other Shopper', passwordHash: 'x' } });
    const otherToken = await jwt.signAsync({ sub: other.id, email: other.email, role: 'CUSTOMER' });
    const order = (id: string) =>
      db.order.create({ data: { id, userId: shopperId, status: 'DELIVERED', subtotal: 50, discount: 0, shipping: 0, total: 50, delivery: 'standard', address: { name: 'E2E', street: '1 Road', city: 'Dhaka', postal: '1207', country: 'Bangladesh' } } });
    try {
      await api().patch('/api/v1/admin/loyalty').set(as(admin)).send({ enabled: false }).expect(200);
      expect((await api().get('/api/v1/me/stamps').set(as(shopper)).expect(200)).body).toEqual({ enabled: false });
      await api().patch('/api/v1/admin/loyalty').set(as(shopper)).send({ enabled: true }).expect(403);
      await api().patch('/api/v1/admin/loyalty').set(as(admin)).send({ enabled: true, target: 2, headStart: 1, percentOff: 15 }).expect(200);

      const fresh = (await api().get('/api/v1/me/stamps').set(as(shopper)).expect(200)).body;
      expect(fresh).toMatchObject({ enabled: true, slots: 3, filled: 1, toGo: 2, rewards: [] });
      await order('CL-E2E0001');
      await order('CL-E2E0002');
      const full = (await api().get('/api/v1/me/stamps').set(as(shopper)).expect(200)).body;
      expect(full).toMatchObject({ earned: 1, filled: 1, toGo: 2 });
      expect(full.rewards).toHaveLength(1);
      const code = full.rewards[0].code;
      expect(full.rewards[0]).toMatchObject({ percentOff: 15, used: false });
      expect((await api().get('/api/v1/me/stamps').set(as(shopper)).expect(200)).body.rewards).toHaveLength(1); // issued once

      // Only theirs, and only once.
      await api().post('/api/v1/cart/items').set(as(otherToken)).send({ productId: 13, size: '41' }).expect(201);
      await api().post('/api/v1/cart/promo').set(as(otherToken)).send({ code }).expect(400);
      await api().post('/api/v1/cart/items').set(as(shopper)).send({ productId: 13, size: '41' }).expect(201);
      const applied = await api().post('/api/v1/cart/promo').set(as(shopper)).send({ code }).expect(200);
      expect(applied.body.promoCode).toBe(code);
      await db.order.update({ where: { id: 'CL-E2E0002' }, data: { promoCode: code } }); // as if an order used it
      expect((await api().get('/api/v1/cart').set(as(shopper)).expect(200)).body.promoCode).toBeNull();
      await api().post('/api/v1/cart/promo').set(as(shopper)).send({ code }).expect(400);
      expect((await api().get('/api/v1/me/stamps').set(as(shopper)).expect(200)).body.rewards[0].used).toBe(true);
    } finally {
      await api().delete('/api/v1/cart').set(as(shopper));
      await api().delete('/api/v1/cart').set(as(otherToken));
      await db.order.deleteMany({ where: { id: { in: ['CL-E2E0001', 'CL-E2E0002'] } } });
      await db.promoCode.deleteMany({ where: { userId: shopperId } });
      await api().patch('/api/v1/admin/loyalty').set(as(admin)).send(before).expect(200);
    }
  });

  it('updates a product request status', async () => {
    const r = await api().post('/api/v1/me/requests').set(as(shopper)).send({ product: 'Admin E2E cardigan', category: 'Clothing', email: `shopper${DOMAIN}` }).expect(201);
    const updated = await api().patch(`/api/v1/admin/requests/${r.body.id}`).set(as(admin)).send({ status: 'SOURCING' }).expect(200);
    expect(updated.body).toMatchObject({ status: 'SOURCING', customer: { id: shopperId } });
    const mine = await api().get('/api/v1/me/requests').set(as(shopper)).expect(200);
    expect(mine.body[0].status).toBe('SOURCING');
  });
});

describe('content', () => {
  it('edits categories, collections and stories', async () => {
    const cats = await api().get('/api/v1/admin/categories').set(as(admin)).expect(200);
    const cat = cats.body[0];
    await api().patch(`/api/v1/admin/categories/${cat.slug}`).set(as(admin)).send({ subtitle: 'E2E subtitle' }).expect(200);
    await api().patch(`/api/v1/admin/categories/${cat.slug}`).set(as(admin)).send({ subtitle: cat.subtitle }).expect(200);

    const cols = await api().get('/api/v1/admin/collections').set(as(admin)).expect(200);
    expect(cols.body.find((c: any) => c.slug === 'offers')).toMatchObject({ automatic: true });
    await api().delete('/api/v1/admin/collections/offers').set(as(admin)).expect(400);

    const story = await api()
      .post('/api/v1/admin/stories')
      .set(as(admin))
      .send({ title: 'E2E story', excerpt: 'A story written by the tests.', image: product.image, color: 'var(--mint)', body: ['Hello.'], productIds: [1, 2] })
      .expect(201);
    expect(story.body.slug).toBe('e2e-story');
    await api().get('/api/v1/stories/e2e-story').expect(200);
    await api().patch('/api/v1/admin/stories/e2e-story').set(as(admin)).send({ productIds: [999] }).expect(400);
    await api().delete('/api/v1/admin/stories/e2e-story').set(as(admin)).expect(204);
  });
});
