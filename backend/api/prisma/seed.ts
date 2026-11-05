// Seeds the database from ../catalog/catalog.json plus demo accounts and a few
// months of sample orders for the admin dashboard. Safe to re-run.
//   npx prisma db seed                       adds anything missing, keeps admin edits
//   npx prisma db seed -- --reset-catalog    also resets products, content and promo codes to catalog.json
import { readFileSync } from 'node:fs';
import { config } from 'dotenv';
import bcrypt from 'bcryptjs';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, Prisma } from '../src/generated/prisma/client.js';
import { refreshFit } from '../src/catalog/fit.js';

config({ path: '../.env', quiet: true });

const catalog = JSON.parse(readFileSync(new URL('../../catalog/catalog.json', import.meta.url), 'utf8'));
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
const reset = process.argv.includes('--reset-catalog') || process.env.SEED_RESET_CATALOG === '1';

const DEMO = { email: 'demo@cartly.dev', password: 'Demo1234!', name: 'Maya Chen' };
const ADMIN = { email: 'admin@cartly.dev', password: 'Admin1234!', name: 'Riley Admin' };
// A few items start low on stock so the dashboard has something to flag.
const START_STOCK: Record<number, number> = { 9: 3, 14: 2, 18: 5, 26: 4 };
const stockFor = (id: number) => START_STOCK[id] ?? 40 + ((id * 37) % 160);

// Sample shoppers with order history (password: Demo1234!).
const SHOPPERS = [
  ['Aisha Khan', 'Manchester'],
  ['Tom Reid', 'Bristol'],
  ['Lena Müller', 'Berlin'],
  ['Jonas Petersen', 'Copenhagen'],
  ['Priya Sharma', 'London'],
  ['Marco Díaz', 'Madrid'],
  ['Chloe Martin', 'Paris'],
  ['Kenji Tanaka', 'London'],
  ['Sofia Rossi', 'Milan'],
  ['Noah Williams', 'Leeds'],
  ['Amara Okafor', 'London'],
  ['Liam O’Brien', 'Dublin'],
] as const;
const COUNTRY: Record<string, string> = {
  Berlin: 'Germany',
  Copenhagen: 'Denmark',
  Madrid: 'Spain',
  Paris: 'France',
  Milan: 'Italy',
  Dublin: 'Ireland',
};
const emailFor = (name: string) =>
  `${name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z ]/g, '')
    .replace(/ /g, '.')}@example.com`;

// Deterministic randomness, so re-seeding gives the same history.
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function upsert<T>(exists: boolean, create: () => Promise<T>, update: () => Promise<T>) {
  if (!exists) return create();
  if (reset) return update();
}

/** A catalog entry's `details`, as product columns. */
export function productDetails(d: any = {}) {
  return {
    material: d.material ?? null,
    fit: d.fit ?? null,
    fitNotes: d.fitNotes ?? null,
    occasions: d.occasions ?? [],
    seasons: d.seasons ?? [],
    styleTags: d.styleTags ?? [],
    features: d.features ?? [],
    keywords: d.keywords ?? [],
    careNotes: d.careNotes ?? null,
    pairsWith: d.pairsWith ?? [],
  };
}

async function seedCatalog() {
  // A starting taka rate so checkout works on a fresh database; the admin panel's Payments page sets the real one.
  if (catalog.usdToBdt && !(await prisma.storeSetting.findUnique({ where: { key: 'usdToBdt' } }))) {
    await prisma.storeSetting.create({ data: { key: 'usdToBdt', value: catalog.usdToBdt } });
  }
  for (const [slug, c] of Object.entries<any>(catalog.categories)) {
    const data = { title: c.title, subtitle: c.subtitle, color: c.color, image: c.image, types: c.types };
    const exists = !!(await prisma.category.findUnique({ where: { slug } }));
    await upsert(exists, () => prisma.category.create({ data: { slug, ...data } }), () => prisma.category.update({ where: { slug }, data }));
  }
  for (const [slug, c] of Object.entries<any>(catalog.collections)) {
    const data = { title: c.title, subtitle: c.subtitle, color: c.color, image: c.image };
    const exists = !!(await prisma.collection.findUnique({ where: { slug } }));
    await upsert(exists, () => prisma.collection.create({ data: { slug, ...data } }), () => prisma.collection.update({ where: { slug }, data }));
  }

  for (const p of catalog.products) {
    const data = {
      slug: p.slug,
      name: p.name,
      description: p.description,
      categorySlug: p.category,
      type: p.type,
      gender: p.gender,
      label: p.label,
      price: new Prisma.Decimal(p.price),
      compareAt: p.compareAt == null ? null : new Prisma.Decimal(p.compareAt),
      isNew: p.isNew,
      rating: p.rating,
      reviewCount: p.reviewCount,
      popularity: p.popularity,
      image: p.image,
      photoId: p.photoId,
      colors: p.colors,
      sizes: p.sizes,
      collections: p.collections,
      tryOnSlot: p.tryOn?.slot ?? null,
      stock: stockFor(p.id),
      active: true,
      // What Pip and search know about it (see api/src/common/product-details.ts).
      ...productDetails(p.details),
    };
    const current = await prisma.product.findUnique({ where: { id: p.id } });
    // Where an accessory sits in its photo, for the quick preview's cut-out (kept with the admin's own try-on notes).
    const tryOnInfo = p.tryOn?.crop ? { ...((current?.tryOnInfo as object) ?? {}), crop: p.tryOn.crop, ...(p.tryOn.cutout ? { cutout: p.tryOn.cutout } : {}) } : undefined;
    const written = await upsert(
      !!current,
      () => prisma.product.create({ data: { id: p.id, ...data, tryOnInfo } }),
      () => prisma.product.update({ where: { id: p.id }, data: { ...data, tryOnInfo } }),
    );
    if (!written) continue;
    // Catalog reviews are replaced with the product; customer reviews (with a userId) are kept.
    await prisma.review.deleteMany({ where: { productId: p.id, userId: null } });
    await prisma.review.createMany({
      data: p.reviews.map((r: any) => ({ productId: p.id, author: r.author, rating: r.rating, title: r.title, text: r.text, fit: r.fit ?? null, createdAt: new Date(r.date) })),
    });
  }
  // Catalog reviews seeded before reviews had a fit: copy it over (they're only re-created on a reset), then
  // recount every product's "runs small / true to size" from its fit reviews and size returns.
  for (const p of catalog.products)
    for (const r of p.reviews.filter((x: any) => x.fit))
      await prisma.review.updateMany({ where: { productId: p.id, userId: null, author: r.author, text: r.text, fit: null }, data: { fit: r.fit } });
  await refreshFit(prisma, catalog.products.map((p: any) => p.id));

  for (const s of catalog.stories) {
    const data = { title: s.title, excerpt: s.excerpt, color: s.color, image: s.image, body: s.body, productIds: s.products };
    const exists = !!(await prisma.story.findUnique({ where: { slug: s.slug } }));
    await upsert(exists, () => prisma.story.create({ data: { slug: s.slug, ...data } }), () => prisma.story.update({ where: { slug: s.slug }, data }));
  }

  for (const [code, percent] of Object.entries<number>(catalog.promoCodes)) {
    const exists = !!(await prisma.promoCode.findUnique({ where: { code } }));
    await upsert(
      exists,
      () => prisma.promoCode.create({ data: { code, percent } }),
      () => prisma.promoCode.update({ where: { code }, data: { percent, active: true } }),
    );
  }
}

const byId = new Map<number, any>(catalog.products.map((p: any) => [p.id, p]));
const line = (id: number, qty: number, color?: string, size?: string) => {
  const p = byId.get(id);
  return { productId: id, name: p.name, image: p.image, price: new Prisma.Decimal(p.price), qty, color: color ?? p.colors[0].name, size: size ?? p.sizes[0] };
};
type Line = ReturnType<typeof line>;

async function replaceOrder(o: {
  id: string;
  userId: string;
  status: 'PROCESSING' | 'SHIPPED' | 'DELIVERED' | 'CANCELLED';
  createdAt: Date;
  items: Line[];
  address: object;
  delivery?: 'standard' | 'express';
  promo?: string;
}) {
  const subtotal = o.items.reduce((n, i) => n + Number(i.price) * i.qty, 0);
  const percent = o.promo ? catalog.promoCodes[o.promo] : 0;
  const discount = Math.round(subtotal * percent * 100) / 100;
  const delivery = o.delivery ?? 'standard';
  const shipping = delivery === 'standard' && subtotal - discount >= catalog.freeShippingOver ? 0 : catalog.shipping[delivery].price;
  await prisma.order.deleteMany({ where: { id: o.id } });
  await prisma.order.create({
    data: {
      id: o.id,
      userId: o.userId,
      status: o.status,
      subtotal,
      discount,
      shipping,
      total: Math.round((subtotal - discount + shipping) * 100) / 100,
      promoCode: o.promo ?? null,
      delivery,
      address: o.address,
      cardLast4: '4242',
      createdAt: o.createdAt,
      updatedAt: o.createdAt,
      items: { create: o.items },
    },
  });
}

async function seedPeople() {
  const hash = await bcrypt.hash(DEMO.password, 10);

  // Demo shopper, with the same history the storefront has always shown.
  const demo = await prisma.user.upsert({
    where: { email: DEMO.email },
    create: { email: DEMO.email, name: DEMO.name, passwordHash: hash, createdAt: new Date('2025-03-14') },
    update: { name: DEMO.name, passwordHash: hash },
  });
  const address = { name: DEMO.name, street: '24 Orchard Lane', city: 'London', postal: 'E2 7DJ', country: 'United Kingdom' };
  const ago = (days: number) => new Date(Date.now() - days * 864e5);
  await replaceOrder({ id: 'CL-20931', userId: demo.id, status: 'PROCESSING', createdAt: ago(2), address, items: [line(2, 1, 'Lemon', '42'), line(21, 1, 'Stone', 'M')] });
  await replaceOrder({ id: 'CL-20874', userId: demo.id, status: 'SHIPPED', createdAt: ago(6), address, items: [line(4, 1, 'Copper', 'L')] });
  await replaceOrder({ id: 'CL-20512', userId: demo.id, status: 'DELIVERED', createdAt: ago(21), address, items: [line(28, 2), line(29, 2), line(30, 1)] });
  for (const m of [
    { name: 'Jordan Blake', email: 'jordan@cartly.dev', role: 'BUYER', status: 'ACTIVE' },
    { name: 'Sam Rivera', email: 'sam@cartly.dev', role: 'VIEWER', status: 'INVITED' },
  ] as const) {
    await prisma.teamMember.upsert({
      where: { ownerId_email: { ownerId: demo.id, email: m.email } },
      create: { ownerId: demo.id, ...m },
      update: { role: m.role, status: m.status },
    });
  }

  // Store admin for the admin panel.
  await prisma.user.upsert({
    where: { email: ADMIN.email },
    create: { email: ADMIN.email, name: ADMIN.name, role: 'ADMIN', passwordHash: await bcrypt.hash(ADMIN.password, 10), createdAt: new Date('2025-01-06') },
    update: { role: 'ADMIN' },
  });

  // Sample shoppers and ~90 days of orders (ids CL-1xxxx, never used by real checkouts).
  const rand = rng(20260929);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)];
  const shoppers = [];
  for (const [i, [name, city]] of SHOPPERS.entries()) {
    const email = emailFor(name);
    shoppers.push({
      city,
      user: await prisma.user.upsert({
        where: { email },
        create: { email, name, passwordHash: hash, createdAt: ago(8 + i * 9 + Math.floor(rand() * 6)) },
        update: {},
      }),
    });
  }
  await prisma.order.deleteMany({ where: { id: { startsWith: 'CL-1' }, userId: { in: shoppers.map((s) => s.user.id) } } });
  const ids = catalog.products.map((p: any) => p.id as number);
  let n = 0;
  for (let daysAgo = 89; daysAgo >= 0; daysAgo--) {
    // Busier recently and at weekends.
    const perDay = rand() < 0.35 + (90 - daysAgo) / 200 ? 1 + Math.floor(rand() * (ago(daysAgo).getUTCDay() % 6 === 0 ? 3 : 2)) : 0;
    for (let k = 0; k < perDay; k++) {
      const s = pick(shoppers);
      if (s.user.createdAt > ago(daysAgo)) continue;
      const items = Array.from({ length: 1 + Math.floor(rand() * 3) }, () => {
        const p = byId.get(pick(ids));
        return line(p.id, rand() < 0.2 ? 2 : 1, pick(p.colors as { name: string }[]).name, pick(p.sizes as string[]));
      }).filter((l, i, all) => all.findIndex((x) => x.productId === l.productId) === i);
      const status = rand() < 0.06 ? 'CANCELLED' : daysAgo < 2 ? 'PROCESSING' : daysAgo < 6 ? (rand() < 0.5 ? 'SHIPPED' : 'PROCESSING') : daysAgo < 10 ? 'SHIPPED' : 'DELIVERED';
      const createdAt = new Date(ago(daysAgo).getTime() - Math.floor(rand() * 10 * 36e5));
      await replaceOrder({
        id: `CL-${10001 + n++}`,
        userId: s.user.id,
        status,
        createdAt,
        items,
        delivery: rand() < 0.2 ? 'express' : 'standard',
        promo: rand() < 0.18 ? pick(['WELCOME20', 'CARTLY10']) : undefined,
        address: { name: s.user.name, street: `${1 + Math.floor(rand() * 120)} ${pick(['High Street', 'Station Road', 'Park Lane', 'Mill Road', 'Church Street'])}`, city: s.city, postal: pick(['M1 4BT', 'BS1 5TR', '10115', '1050', 'SW1A 1AA', '28013', '75002', 'N1 9GU', '20121', 'LS1 4AP', 'E8 3RL', 'D02 X285']), country: COUNTRY[s.city] ?? 'United Kingdom' },
      });
    }
  }

  // A few product requests waiting for the buying team.
  const requests = [
    { who: 0, product: 'Linen wide-leg trousers in olive', category: 'Clothing', size: 'M', budget: 80, status: 'RECEIVED' },
    { who: 4, product: 'Chunky knit cardigan, cream', category: 'Clothing', size: 'S', budget: 120, status: 'SOURCING' },
    { who: 7, product: 'Trail running shoes, waterproof', category: 'Shoes', size: '43', budget: 150, status: 'RECEIVED' },
    { who: 2, product: 'Ceramic pour-over coffee set', category: 'Home', budget: 60, status: 'FOUND' },
    { who: 10, product: 'Silk scarf with a botanical print', category: 'Accessories', budget: 45, status: 'UNAVAILABLE' },
  ] as const;
  for (const [i, r] of requests.entries()) {
    const u = shoppers[r.who].user;
    await prisma.productRequest.deleteMany({ where: { userId: u.id, product: r.product } });
    await prisma.productRequest.create({
      data: { userId: u.id, email: u.email, product: r.product, category: r.category, size: 'size' in r ? r.size : null, budget: r.budget, status: r.status, createdAt: ago(1 + i * 3) },
    });
  }
  return n;
}

async function main() {
  await seedCatalog();
  const sampleOrders = await seedPeople();
  const counts = await Promise.all([prisma.product.count(), prisma.review.count(), prisma.story.count(), prisma.order.count(), prisma.user.count()]);
  console.log(
    `Seeded ${counts[0]} products, ${counts[1]} reviews, ${counts[2]} stories, ${counts[4]} users, ${counts[3]} orders (${sampleOrders} sample)${reset ? ', catalog reset' : ''}.`,
  );
  console.log(`Storefront: ${DEMO.email} / ${DEMO.password} · Admin panel: ${ADMIN.email} / ${ADMIN.password}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
