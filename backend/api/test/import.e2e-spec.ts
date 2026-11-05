// Product import / export end-to-end against the real local Postgres + Redis (seeded). The AI service may be
// down: the import only warns that search wasn't rebuilt.
import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { createApp } from '../src/main.js';
import { PrismaService } from '../src/common/infra.module.js';
import { COLUMNS, parseCsv } from '../src/admin/import-csv.js';

let app: INestApplication;
let db: PrismaService;
const api = () => request(app.getHttpServer());
const as = (token: string) => ({ Authorization: `Bearer ${token}` });
let admin = '';
let support = '';
const DOMAIN = '@import-e2e.test';

const csv = (rows: string[][]) => Buffer.from(rows.map((r) => r.map((v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join(',')).join('\n'));
const send = (token: string, file: Buffer, fields: Record<string, string> = {}) => {
  let r = api().post('/api/v1/admin/catalog/import').set(as(token));
  for (const [k, v] of Object.entries(fields)) r = r.field(k, v);
  return r.attach('file', file, { filename: 'products.csv', contentType: 'text/csv' });
};

const HEADER = ['slug', 'name', 'category', 'type', 'gender', 'label', 'price', 'stock', 'image', 'colors', 'sizes', 'description', 'material', 'fit', 'occasions', 'seasons', 'styleTags', 'features', 'keywords'];
const full = [
  'e2e-import-panjabi', 'E2E Import Panjabi', 'clothing-shoes', 'Clothing', 'men', 'Festive', '54', '7',
  'https://images.unsplash.com/photo-1602810318383-e386cc2a3ccf?w=600', 'Sage:#9caf88', 'M|L',
  'A breathable linen panjabi with a band collar, made for testing the product import end to end.',
  '100% linen', 'regular', 'festive|wedding', 'summer', 'classic|minimal', 'breathable linen|hidden placket', 'panjabi|পাঞ্জাবি|kurta',
];
const bare = ['e2e-import-tote', 'E2E Import Tote', 'gifts-living', 'Accessories', 'unisex', 'Bags', '15', '3', 'https://images.unsplash.com/photo-1590874103328-eac38a683ce7?w=600', 'Natural:#e8dcc4', 'One size', 'A sturdy canvas tote with long handles, made for testing hidden imports.', '', '', '', '', '', '', ''];

beforeAll(async () => {
  app = await createApp();
  await app.init();
  db = app.get(PrismaService);
  const jwt = app.get(JwtService);
  const a = await db.user.findUniqueOrThrow({ where: { email: 'admin@cartly.dev' } });
  admin = await jwt.signAsync({ sub: a.id, email: a.email, role: 'ADMIN' });
  const s = await db.user.create({ data: { email: `support${DOMAIN}`, name: 'Import E2E Support', passwordHash: 'x', role: 'SUPPORT' } });
  support = await jwt.signAsync({ sub: s.id, email: s.email, role: 'SUPPORT' });
});

afterAll(async () => {
  await db.product.deleteMany({ where: { slug: { startsWith: 'e2e-import-' } } });
  await db.user.deleteMany({ where: { email: { endsWith: DOMAIN } } });
  await app.close();
});

describe('product import', () => {
  it('checks without saving, row by row', async () => {
    const res = await send(admin, csv([HEADER, full, bare])).expect(200);
    expect(res.body).toMatchObject({ format: 'cartly', applied: false, total: 2, create: 2, update: 0, skip: 0, hidden: 1 });
    expect(res.body.rows[1]).toMatchObject({ name: 'E2E Import Tote', action: 'create', hidden: true });
    expect(res.body.rows[1].warnings.join(' ')).toMatch(/Hidden until it has the material/);
    expect(await db.product.count({ where: { slug: { startsWith: 'e2e-import-' } } })).toBe(0);
  });

  it('saves with apply=true: complete products go live, the rest hidden', async () => {
    const res = await send(admin, csv([HEADER, full, bare]), { apply: 'true' }).expect(200);
    expect(res.body).toMatchObject({ applied: true, create: 2, skip: 0 });
    const live = await db.product.findUniqueOrThrow({ where: { slug: 'e2e-import-panjabi' } });
    expect(live).toMatchObject({ active: true, stock: 7, material: '100% linen', keywords: ['panjabi', 'পাঞ্জাবি', 'kurta'] });
    expect(Number(live.price)).toBe(54);
    const hidden = await db.product.findUniqueOrThrow({ where: { slug: 'e2e-import-tote' } });
    expect(hidden.active).toBe(false);
    // The storefront doesn't show the hidden one.
    const store = await api().get('/api/v1/catalog').expect(200);
    const slugs = store.body.products.map((p: { slug: string }) => p.slug);
    expect(slugs).toContain('e2e-import-panjabi');
    expect(slugs).not.toContain('e2e-import-tote');
  });

  it('updates by slug and keeps what the file leaves empty', async () => {
    const res = await send(admin, csv([['slug', 'price', 'stock', 'material'], ['e2e-import-panjabi', '49.50', '', '']]), { apply: 'true' }).expect(200);
    expect(res.body).toMatchObject({ update: 1, create: 0, skip: 0 });
    const p = await db.product.findUniqueOrThrow({ where: { slug: 'e2e-import-panjabi' } });
    expect(Number(p.price)).toBe(49.5);
    expect(p).toMatchObject({ stock: 7, material: '100% linen', active: true });
  });

  it('reads a Shopify export', async () => {
    const shopify = csv([
      ['Handle', 'Title', 'Body (HTML)', 'Type', 'Tags', 'Option1 Name', 'Option1 Value', 'Variant Inventory Qty', 'Variant Price', 'Image Src', 'Status'],
      ['e2e-import-sneaker', 'E2E Import Sneaker', '<p>A light canvas sneaker with a cushioned sole, made for testing the Shopify import.</p>', 'Sneakers', 'canvas, women', 'Size', '38', '2', '40', 'https://cdn.shopify.com/s.jpg', 'active'],
      ['e2e-import-sneaker', '', '', '', '', '', '39', '3', '40', '', ''],
    ]);
    const res = await send(admin, shopify).expect(200);
    expect(res.body).toMatchObject({ format: 'shopify', create: 1, skip: 0, hidden: 1 });
    expect(res.body.rows[0].warnings.join(' ')).toMatch(/Type Shoes, guessed from “Sneakers”/);
  });

  it('reports rows it can’t use and refuses files it can’t read', async () => {
    const res = await send(admin, csv([HEADER, [...full.slice(0, 2), 'no-such-category', ...full.slice(3)]])).expect(200);
    expect(res.body).toMatchObject({ skip: 1 });
    expect(res.body.rows[0].errors.join(' ')).toMatch(/Unknown category/);
    const bad = await send(admin, Buffer.from('a,b\n1,2\n')).expect(400);
    expect(bad.body.message).toMatch(/Unrecognised columns/);
  });

  it('needs catalogue write access', async () => {
    await send(support, csv([HEADER, full])).expect(403);
  });
});

describe('product export', () => {
  it('lists every product in the import’s own columns', async () => {
    const res = await api().get('/api/v1/admin/catalog/export').set(as(admin)).expect(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="cartly-products-\d{8}\.csv"/);
    const rows = parseCsv(res.text);
    expect(rows[0]).toEqual([...COLUMNS]);
    expect(rows.length - 1).toBe(await db.product.count());
  });

  it('gives a template that imports cleanly', async () => {
    const res = await api().get('/api/v1/admin/catalog/export?template=true').set(as(admin)).expect(200);
    const check = await send(admin, Buffer.from(res.text)).expect(200);
    expect(check.body).toMatchObject({ total: 1, skip: 0, hidden: 0 });
  });
});
