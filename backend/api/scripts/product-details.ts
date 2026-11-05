// Fills in Pip's product details (material, fit, occasions, seasons, style, features, other names)
// from backend/catalog/catalog.json for seeded products that don't have them yet. Details an admin has
// already entered are kept. Run once after upgrading an existing database:  npm run catalog:details
import { readFileSync } from 'node:fs';
import { PrismaPg } from '@prisma/adapter-pg';
import { env } from '../src/config.js';
import { PrismaClient } from '../src/generated/prisma/client.js';

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: env.databaseUrl }) });
const catalog = JSON.parse(readFileSync(env.catalogPath, 'utf8'));
const LISTS = ['occasions', 'seasons', 'styleTags', 'features', 'keywords', 'pairsWith'] as const;
const TEXT = ['material', 'fit', 'fitNotes', 'careNotes'] as const;

let filled = 0;
for (const entry of catalog.products) {
  const p = await db.product.findUnique({ where: { id: entry.id } });
  const d = entry.details ?? {};
  if (!p) continue;
  const data: Record<string, unknown> = {};
  for (const k of TEXT) if (!p[k] && d[k]) data[k] = d[k];
  for (const k of LISTS) if (!p[k]?.length && d[k]?.length) data[k] = d[k];
  if (!Object.keys(data).length) continue;
  await db.product.update({ where: { id: p.id }, data });
  filled++;
  console.log(`#${p.id} ${p.name}: ${Object.keys(data).join(', ')}`);
}
console.log(`Filled in details for ${filled} products. Restart or reindex the AI service (admin → System) so Pip picks them up.`);
await db.$disconnect();
