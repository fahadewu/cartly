// Makes the quick-preview cut-outs for every accessory that needs one. Run after seeding, with the AI
// service up (the first run downloads its cut-out model, ~220 MB):  npm run tryon:cutouts
import { readFileSync } from 'node:fs';
import { PrismaPg } from '@prisma/adapter-pg';
import { env } from '../src/config.js';
import { PrismaClient, type Prisma } from '../src/generated/prisma/client.js';
import { refreshCutout, wantsCutout } from '../src/tryon/cutout.js';

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: env.databaseUrl }) });
// Seeded products added before crops were in the catalog get them now (admin edits are kept).
const seeded = new Map<number, { crop?: number[]; cutout?: string }>(
  JSON.parse(readFileSync(env.catalogPath, 'utf8')).products.map((p: { id: number; tryOn?: object }) => [p.id, p.tryOn ?? {}]),
);

let made = 0;
let failed = 0;
for (let p of await db.product.findMany({ where: { tryOnSlot: { not: null } }, orderBy: { id: 'asc' } })) {
  const info = (p.tryOnInfo ?? {}) as { crop?: number[]; cutout?: string };
  const s = seeded.get(p.id);
  if (s?.crop && !info.crop) {
    const tryOnInfo = { ...info, crop: s.crop, ...(s.cutout && !info.cutout ? { cutout: s.cutout } : {}) } as Prisma.InputJsonObject;
    p = await db.product.update({ where: { id: p.id }, data: { tryOnInfo } });
  }
  if (!wantsCutout(p) && !p.tryOnCutout) continue;
  const before = p.tryOnCutout;
  try {
    const after = await refreshCutout(db, p);
    if (after.tryOnCutout !== before) made++;
    console.log(`#${p.id} ${p.name}: ${after.tryOnCutout ?? 'none (uses on-device background removal)'}`);
  } catch (e) {
    failed++;
    console.warn(`#${p.id} ${p.name}: failed (${(e as Error).message})`);
  }
}
console.log(`${made} cut-out${made === 1 ? '' : 's'} made or updated${failed ? `, ${failed} failed` : ''}.`);
await db.$disconnect();
process.exit(failed ? 1 : 0);
