import type { Product } from '../generated/prisma/client.js';

// The vocabulary Pip and search understand. The admin panel offers these as choices.
export const OCCASIONS = ['everyday', 'office', 'formal', 'party', 'wedding', 'festive', 'date-night', 'sport', 'travel', 'lounge', 'beach', 'gift'];
export const SEASONS = ['summer', 'monsoon', 'autumn', 'winter', 'all-season'];
export const FITS = ['slim', 'regular', 'relaxed', 'oversized'];
/** Types where the cut matters to a shopper, so `fit` is required. */
export const FITTED_TYPES = ['Clothing'];
export const MIN_DESCRIPTION = 40;

type Details = Pick<Product, 'type' | 'description' | 'material' | 'fit' | 'occasions' | 'seasons' | 'styleTags' | 'features' | 'keywords' | 'tryOnSlot' | 'tryOnImage'>;

/**
 * What Pip still doesn't know about a product. `required` gaps block saving it; `suggested` ones make
 * Pip and search better (other names shoppers use, a dedicated try-on photo).
 */
export function detailGaps(p: Details) {
  const required: string[] = [];
  const suggested: string[] = [];
  let checks = 0;
  const need = (ok: boolean, gaps: string[], what: string) => {
    checks++;
    if (!ok) gaps.push(what);
  };
  need((p.description ?? '').trim().length >= MIN_DESCRIPTION, required, `a description of at least ${MIN_DESCRIPTION} characters`);
  need(!!p.material?.trim(), required, 'the material');
  if (FITTED_TYPES.includes(p.type)) need(!!p.fit, required, 'the fit');
  need(!!p.occasions?.length, required, 'at least one occasion');
  need(!!p.seasons?.length, required, 'at least one season');
  need((p.styleTags?.length ?? 0) >= 2, required, 'at least two style tags');
  need((p.features?.length ?? 0) >= 2, required, 'at least two key features');
  need((p.keywords?.length ?? 0) >= 3, suggested, 'other names shoppers search for (three or more, in any language)');
  if (p.tryOnSlot) need(!!p.tryOnImage, suggested, 'a dedicated try-on photo');
  return { required, suggested, score: Math.round(((checks - required.length - suggested.length) / checks) * 100) };
}

/** "the material, the fit and at least one season" */
export const listOf = (xs: string[]) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);

/** Tidies free-text lists: trimmed, no blanks or repeats (case-insensitive), in the given order. */
export function cleanList(xs: string[] | undefined, lower = false) {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of xs ?? []) {
    const v = (lower ? raw.toLowerCase() : raw).trim().replace(/\s+/g, ' ');
    const k = v.toLowerCase();
    if (v && !seen.has(k)) {
      seen.add(k);
      out.push(v);
    }
  }
  return out;
}
