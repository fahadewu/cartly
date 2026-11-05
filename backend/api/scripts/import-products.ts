// Imports products from a CSV: Cartly's own columns (see `npm run catalog:export`), or a Shopify or WooCommerce
// product export. Checks every row and prints what would happen; nothing is saved without --apply.
//   npm run catalog:import -- products.csv                 check only
//   npm run catalog:import -- products.csv --apply         save
//   npm run catalog:import -- - --apply < products.csv     read the file from stdin (what ./cartly import does)
// For rows whose kind of product can't be told from the file:  --type=Clothing  --category=clothing-shoes  --gender=women
// Same rules as Admin → Products → Import: products missing what Pip needs come in hidden, to finish in the editor.
import { readFileSync } from 'node:fs';
import { AiIndexService } from '../src/common/ai-index.js';
import { AdminCatalogService } from '../src/admin/catalog.js';
import { ProductImportService } from '../src/admin/import.js';
import { CatalogCache } from '../src/common/cache.js';
import { PrismaService, RedisService } from '../src/common/infra.module.js';

const args = process.argv.slice(2);
const flag = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
const file = args.find((a) => !a.startsWith('--'));
if (!file) {
  console.error('Usage: npm run catalog:import -- <products.csv | -> [--apply] [--type=…] [--category=…] [--gender=…]');
  process.exit(2);
}
const text = readFileSync(file === '-' ? 0 : file, 'utf8');
const apply = args.includes('--apply');

// The services by hand: tsx doesn't emit the decorator metadata Nest's injection needs.
const db = new PrismaService();
const redis = new RedisService();
const index = new AiIndexService();
const imports = new ProductImportService(db, new AdminCatalogService(db, index, redis), index, new CatalogCache(redis));
let code = 0;
try {
  const r = await imports.run(text, { apply, type: flag('type'), category: flag('category'), gender: flag('gender') });
  const label = { create: apply ? 'added' : 'new', update: apply ? 'updated' : 'update', skip: 'skipped' };
  for (const row of r.rows) {
    const where = `line ${row.line}`.padEnd(9);
    const what = `${label[row.action].padEnd(7)} ${row.name || row.slug || '(no name)'}${row.id ? ` #${row.id}` : ''}${row.hidden ? ' (hidden)' : ''}`;
    console.log(`${where} ${what}`);
    for (const e of row.errors) console.log(`            ✗ ${e}`);
    for (const w of row.warnings) console.log(`            · ${w}`);
  }
  const n = (x: number, word: string) => `${x} ${word}${x === 1 ? '' : 's'}`;
  const done = apply ? `${r.create} added, ${r.update} updated` : `${r.create} new, ${r.update} to update`;
  const hidden = r.hidden ? `, ${r.hidden} hidden until Pip's details are filled in` : '';
  console.log(`\n${r.format} file, ${n(r.total, 'product')}: ${done}, ${r.skip} skipped${hidden}.`);
  if (!apply && r.create + r.update) console.log('Nothing saved yet: run it again with --apply.');
  if (r.skip) code = 1;
} catch (e) {
  console.error(`✗ ${(e as Error).message}`);
  code = 2;
} finally {
  await Promise.allSettled([db.$disconnect(), redis.quit()]);
}
process.exit(code);
