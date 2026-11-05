// First start of a fresh install (the Docker entrypoint runs this on every start; it acts only once per database):
// - the demo store from catalog/catalog.json (`prisma/seed.ts`): products, content, demo shoppers and orders;
// - outside production, the test kit (`scripts/test-kit.ts`): test accounts, a rider, sandbox gateways and Pathao;
// - the accessories' quick-preview cut-outs shipped in catalog/cutouts/, so no 220 MB model download is needed.
// Then it records itself in StoreSetting "install". A database that already has products (an existing store, or
// one restored from a backup) is left alone and only gets the record.
//   CARTLY_SEED=demo|none   load the demo store into an empty database (default: demo, but none with
//                           NODE_ENV=production: a real store starts from a restored backup, never demo data)
//   CARTLY_TEST_KIT=false   skip the test kit (it never runs with NODE_ENV=production anyway)
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import { env } from '../src/config.js';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { cutoutSource, wantsCutout } from '../src/tryon/cutout.js';

const MARK = 'install';
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: env.databaseUrl }) });

const run = (script: string) => {
  const r = spawnSync('npx', ['tsx', script], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`${script} failed (exit ${r.status}).`);
};

/** Copies the shipped cut-outs whose source photo still matches the product, and points the product at them. */
async function installCutouts() {
  const shipped = path.join(path.dirname(env.catalogPath), 'cutouts');
  const dir = path.join(env.uploadDir, 'tryon');
  let installed = 0;
  let wanted = 0;
  for (const p of await db.product.findMany({ where: { tryOnSlot: { not: null }, tryOnCutout: null } })) {
    if (!wantsCutout(p)) continue;
    wanted++;
    const { name } = cutoutSource(p);
    if (!existsSync(path.join(shipped, name))) continue;
    await mkdir(dir, { recursive: true });
    await copyFile(path.join(shipped, name), path.join(dir, name));
    await db.product.update({ where: { id: p.id }, data: { tryOnCutout: `${env.publicUrl}/api/v1/uploads/tryon/${name}` } });
    installed++;
  }
  if (wanted) console.log(`Quick-preview cut-outs: ${installed} of ${wanted} installed from catalog/cutouts.`);
}

try {
  if (await db.storeSetting.findUnique({ where: { key: MARK } })) {
    console.log('Store already set up.');
  } else {
    const existing = await db.product.count();
    const testKit = !env.production && process.env.CARTLY_TEST_KIT !== 'false';
    const seed = (process.env.CARTLY_SEED ?? (env.production ? 'none' : 'demo')) === 'demo';
    if (existing) {
      console.log(`The database already has ${existing} products: keeping it as it is.`);
    } else if (!seed) {
      console.log(
        'Empty database, and no demo store in production. Restore your store into it (./cartly restore <backup>,' +
          ' or backend/scripts/store-data.sh restore), or set CARTLY_SEED=demo.',
      );
      process.exit(0); // not recorded: the next start checks again
    } else {
      console.log('First start: loading the demo store…');
      run('prisma/seed.ts');
      if (testKit) run('scripts/test-kit.ts');
      await installCutouts();
    }
    await db.storeSetting.create({
      data: { key: MARK, value: { at: new Date().toISOString(), demo: !existing, testKit: !existing && testKit } },
    });
  }
} finally {
  await db.$disconnect();
}
