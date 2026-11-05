import { createHash } from 'node:crypto';
import { mkdir, readdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Prisma, Product } from '../generated/prisma/client.js';
import { callAi } from '../common/ai.js';
import { env } from '../config.js';

/**
 * What the storefront's on-device quick preview shows: small, rigid items. Clothes and shoes need the
 * AI try-on (a flat cut-out can't drape, go behind the arms or replace what you're wearing).
 */
export const PREVIEW_SLOTS = ['eyes', 'head', 'ears', 'wrist', 'hand'];

type Db = { product: { update(args: { where: { id: number }; data: Prisma.ProductUpdateInput }): Promise<Product> } };
type Info = { crop?: number[]; cutout?: 'ai' | 'plain' };

/** Where the cut-out comes from: a dedicated try-on photo is just the item; a product photo is cropped. */
export function cutoutSource(p: Product) {
  const info = (p.tryOnInfo ?? {}) as Info;
  const image = p.tryOnImage ?? p.image;
  const crop = p.tryOnImage ? undefined : info.crop;
  const key = createHash('sha1').update(JSON.stringify([image, crop ?? null])).digest('hex').slice(0, 12);
  return { image, crop, name: `cutout-${p.id}-${key}.png` };
}

/** Does this product need a server-made cut-out? 'plain' means its photo is a studio shot the storefront cuts out itself. */
export const wantsCutout = (p: Product) =>
  !!p.tryOnSlot && PREVIEW_SLOTS.includes(p.tryOnSlot) && ((p.tryOnInfo ?? {}) as Info).cutout !== 'plain';

/**
 * Makes the product's quick-preview cut-out match its current try-on photo (or clears it), and
 * returns the product as saved. Uses the AI service; throws when that's unavailable.
 */
export async function refreshCutout(db: Db, p: Product): Promise<Product> {
  if (!wantsCutout(p)) return p.tryOnCutout ? db.product.update({ where: { id: p.id }, data: { tryOnCutout: null } }) : p;
  const src = cutoutSource(p);
  if (p.tryOnCutout?.endsWith(`/${src.name}`)) return p;
  const { image } = await callAi<{ image: string }>('/tryon/cutout', {
    method: 'POST',
    // The first cut-out also downloads the model (~220 MB); later ones take a few seconds.
    timeoutMs: 300_000,
    // slot: what SAM looks for when the AI service uses Meta for cut-outs (CUTOUT_PROVIDER=meta).
    body: JSON.stringify({ image: src.image, crop: src.crop, slot: p.tryOnSlot }),
  });
  const dir = path.join(env.uploadDir, 'tryon');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, src.name), Buffer.from(image.split(',')[1], 'base64'));
  // Earlier cut-outs of this product are no longer referenced.
  for (const f of await readdir(dir)) {
    if (f.startsWith(`cutout-${p.id}-`) && f !== src.name) await unlink(path.join(dir, f)).catch(() => {});
  }
  return db.product.update({ where: { id: p.id }, data: { tryOnCutout: `${env.publicUrl}/api/v1/uploads/tryon/${src.name}` } });
}
