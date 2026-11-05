/*
 * How much a shopper is likely to like a product, 0–1, with the parts it's made of and reasons a person would
 * say. Pure functions (likeness.spec.ts): the taste profile (taste.ts) is what they did; the preferences are
 * what they told us (sizes, colouring). Used for the admin's "What they like" view and to pick products for
 * outreach emails. The reasons are for staff: an email never tells a shopper what we assume about them.
 *
 * Colours that suit a skin tone follow the usual colour-analysis conventions (warm undertones with warm
 * shades, cool with cool; deeper skin with clearer, higher-contrast colours). It's a gentle nudge, a quarter
 * of the colour score at most, never a rule, and only when the shopper chose to share their colouring.
 */
import type { Taste, TasteProduct } from './taste.js';

export type Undertone = 'warm' | 'cool' | 'neutral';
export interface Preferences {
  /** Monk Skin Tone scale 1–10. */
  skinTone?: number | null;
  undertone?: Undertone | string | null;
  sizes?: Record<string, string> | null;
  fit?: string | null;
}
export type TasteLike = Pick<Taste, 'tags' | 'categories' | 'genders' | 'priceBand' | 'traits' | 'evidence'> & { colors?: Record<string, number> };
export interface LikenessProduct extends TasteProduct {
  name?: string;
  sizes?: string[];
  colors?: { name: string; hex: string }[];
}
export interface Likeness {
  score: number;
  parts: { style: number; category: number; price: number; colour: number; size: number; gender: number; popularity: number };
  reasons: string[];
}

/* ------------------------------ colour ------------------------------ */

function hsl(hex: string) {
  const n = parseInt(hex.replace('#', ''), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  let h = 0;
  if (d) {
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  return { h: (h + 360) % 360, s, l };
}

export const COLOUR_FAMILIES = ['black', 'white', 'grey', 'beige', 'brown', 'red', 'pink', 'orange', 'yellow', 'green', 'blue', 'navy', 'purple'] as const;
export type ColourFamily = (typeof COLOUR_FAMILIES)[number];

/** The family a swatch belongs to, so "Sage", "Olive" and "#6b7a4b" all count as green. */
export function colourFamily(hex: string): ColourFamily {
  if (!/^#?[0-9a-f]{6}$/i.test(hex)) return 'grey';
  const { h, s, l } = hsl(hex);
  if (l < 0.13) return 'black';
  if (l > 0.92 && s < 0.6) return 'white';
  if (s < 0.14) return l < 0.2 ? 'black' : l > 0.85 ? 'white' : 'grey';
  if (h >= 20 && h < 50 && s < 0.5 && l > 0.6) return 'beige';
  if (h >= 10 && h < 50 && l < 0.42) return 'brown';
  if (h < 12 || h >= 345) return l > 0.72 ? 'pink' : 'red';
  if (h < 40) return 'orange';
  if (h < 68) return 'yellow';
  if (h < 170) return 'green';
  if (h < 255) return l < 0.3 ? 'navy' : 'blue';
  if (h < 290) return 'purple';
  return 'pink';
}

/** -1 (cool) … 1 (warm). Neutrals sit near 0; beige and browns lean warm, greys none. */
export function colourWarmth(hex: string) {
  const { h, s } = hsl(hex);
  if (s < 0.12) return 0;
  const strength = Math.min(1, s * 1.5);
  // Warmest at orange (30°), coolest at blue (220°), on a cosine around the wheel.
  return Math.round(Math.cos(((h - 30) * Math.PI) / 190) * strength * 100) / 100;
}

/**
 * How well a colour suits a shopper's colouring, 0–1 (0.5 when it's neither here nor there). Undertone counts
 * most; depth adds a little for contrast (deep skin with clear or light colours, light skin with mid and deep ones).
 */
export function toneFit(skinTone: number | null | undefined, undertone: string | null | undefined, hex: string) {
  if (!skinTone && !undertone) return null;
  const { s, l } = hsl(hex);
  let fit = 0.5;
  const u = undertone === 'warm' ? 1 : undertone === 'cool' ? -1 : 0;
  const w = colourWarmth(hex);
  fit += u ? 0.3 * w * u : 0.1 * (1 - Math.abs(w)); // neutral undertones: softer, in-between shades
  if (skinTone) {
    const depth = (Math.min(10, Math.max(1, skinTone)) - 1) / 9; // 0 light … 1 deep
    const skinL = 0.85 - depth * 0.65;
    fit += 0.15 * Math.min(1, Math.abs(l - skinL) / 0.5); // contrast with the skin
    const chroma = s * (1 - Math.abs(2 * l - 1));
    fit += depth > 0.6 ? 0.08 * chroma : -0.05 * Math.max(0, chroma - 0.7); // deep skin carries clear colours
  }
  return Math.round(Math.min(1, Math.max(0, fit)) * 100) / 100;
}

/** Shades that usually suit a colouring, for the shopper's own Account page and Pip (when asked "what suits me"). */
export function suitingShades(skinTone: number | null | undefined, undertone: string | null | undefined) {
  const base: Record<string, string[]> = {
    warm: ['olive', 'rust', 'mustard', 'camel', 'coral', 'cream', 'warm red'],
    cool: ['navy', 'emerald', 'berry', 'cobalt', 'lavender', 'charcoal', 'crisp white'],
    neutral: ['jade', 'dusty pink', 'teal', 'soft white', 'taupe', 'plum'],
  };
  const out = [...(base[undertone ?? ''] ?? base.neutral)];
  if (skinTone && skinTone >= 7) out.push('bright white', 'fuchsia', 'cobalt');
  else if (skinTone && skinTone <= 3) out.push('soft rose', 'powder blue', 'dove grey');
  return [...new Set(out)].slice(0, 8);
}

/* ------------------------------ likeness ------------------------------ */

const WEIGHTS = { style: 0.32, category: 0.14, price: 0.14, colour: 0.16, size: 0.12, popularity: 0.12 };
const r2 = (x: number) => Math.round(x * 100) / 100;
const STYLE_WORDS: Record<string, string> = { streetwear: 'streetwear', minimal: 'minimal', classic: 'classic', boho: 'boho', sporty: 'sporty', elegant: 'elegant', romantic: 'romantic', retro: 'retro', cosy: 'cosy', festive: 'festive' };

/** Size labels compared loosely: "m" = "M", "41" = "EU 41". */
const sizeKey = (s: string) => s.toLowerCase().replace(/^(eu|uk|us)\s*/, '').trim();

export function likeness(
  t: TasteLike | null,
  prefs: Preferences | null,
  p: LikenessProduct,
  ctx: { medians: Map<string, number>; maxPop: number },
): Likeness {
  const evidence = t?.evidence ?? 0;
  const maxTag = Math.max(0, ...Object.values(t?.tags ?? {}));
  const maxCat = Math.max(0, ...Object.values(t?.categories ?? {}));
  const maxCol = Math.max(0, ...Object.values(t?.colors ?? {}));
  const reasons: string[] = [];

  // Style: how much of what they engage with carries this product's tags.
  const matchedTags = p.styleTags.filter((tag) => (t?.tags[tag.toLowerCase()] ?? 0) > 0);
  const style = maxTag ? Math.min(1, p.styleTags.reduce((a, tag) => a + (t!.tags[tag.toLowerCase()] ?? 0), 0) / maxTag) : 0;
  if (style >= 0.5 && matchedTags[0]) reasons.push(`${STYLE_WORDS[matchedTags[0].toLowerCase()] ?? matchedTags[0].toLowerCase()} style they keep coming back to`);

  const category = maxCat ? (t!.categories[p.categorySlug] ?? 0) / maxCat : 0;

  const ratio = p.price / (ctx.medians.get(p.categorySlug) || p.price);
  let price = 0.5;
  if (t?.priceBand === 'budget') price = ratio <= 1 ? 1 : 1 / (ratio * ratio);
  else if (t?.priceBand === 'premium') price = ratio >= 1 ? 1 : ratio;
  else if (t?.priceBand === 'value') price = Math.exp(-Math.abs(Math.log(ratio)));
  if (t?.priceBand && price >= 0.8) reasons.push('in their usual price range');
  if (t?.traits.includes('deal-seeker') && p.compareAt && p.compareAt > p.price) {
    price = Math.min(1, price + 0.2);
    reasons.push('on sale, and they like a deal');
  }

  // Colour: the families they engage with, and (if they shared it) what suits their colouring.
  let colour = 0.5;
  const swatches = p.colors ?? [];
  if (swatches.length) {
    const scores = swatches.map((c) => {
      const affinity = maxCol ? (t!.colors![colourFamily(c.hex)] ?? 0) / maxCol : null;
      const suit = toneFit(prefs?.skinTone, prefs?.undertone, c.hex);
      // Their own choices count most; what suits their colouring is a quarter of it at most.
      const value = (affinity ?? 0.5) * (suit != null ? 0.75 : 1) + (suit != null ? 0.25 * suit : 0);
      return { name: c.name, affinity, suit, value };
    });
    const best = scores.reduce((a, b) => (b.value > a.value ? b : a));
    colour = best.value;
    if ((best.affinity ?? 0) >= 0.6) reasons.push(`${best.name.toLowerCase()}: a colour they often choose`);
    if ((best.suit ?? 0) >= 0.7) reasons.push(`${best.name.toLowerCase()} suits their colouring`);
  }

  // Size: in their size (1), no size on file (0.5), not available in it (0: they can't buy it).
  let size = 0.5;
  const mine = prefs?.sizes?.[p.type];
  if (mine && p.sizes?.length) {
    const has = p.sizes.some((s) => sizeKey(s) === sizeKey(mine)) || p.sizes.some((s) => /one size/i.test(s));
    size = has ? 1 : 0;
    reasons.push(has ? `comes in their size (${mine})` : `not in their size (${mine})`);
  }

  const gendered = Object.entries(t?.genders ?? {}).filter(([g]) => g !== 'unisex');
  const genderTotal = gendered.reduce((a, [, v]) => a + v, 0);
  const gender = p.gender === 'unisex' || !genderTotal ? 1 : (t!.genders[p.gender] ?? 0) / genderTotal;
  const popularity = ctx.maxPop ? p.popularity / ctx.maxPop : 0;
  if (t?.traits.includes('trend-seeker') && p.isNew) reasons.push('new in, and they like new things');

  // Little history: popularity carries more of the score until their own signals add up.
  const known = Math.min(1, evidence / 8);
  let score =
    known * (WEIGHTS.style * style + WEIGHTS.category * category + WEIGHTS.price * price) +
    WEIGHTS.colour * colour +
    WEIGHTS.size * size +
    WEIGHTS.popularity * popularity +
    (1 - known) * (WEIGHTS.style + WEIGHTS.category + WEIGHTS.price) * popularity;
  if (gender < 0.1) score *= 0.3; // a gender they never look at
  if (size === 0) score *= 0.4;
  if (p.stock <= 0) score *= 0.2;
  return {
    score: r2(Math.min(1, Math.max(0, score))),
    parts: { style: r2(style), category: r2(category), price: r2(price), colour: r2(colour), size: r2(size), gender: r2(gender), popularity: r2(popularity) },
    reasons: reasons.slice(0, 4),
  };
}

/** Products ranked by likeness, best first (in stock, not already bought). */
export function rankByLikeness(
  t: TasteLike | null,
  prefs: Preferences | null,
  products: LikenessProduct[],
  opts: { exclude?: Set<number>; limit?: number; medians: Map<string, number> },
) {
  const maxPop = Math.max(1, ...products.map((p) => p.popularity));
  return products
    .filter((p) => p.stock > 0 && !opts.exclude?.has(p.id))
    .map((p) => ({ id: p.id, ...likeness(t, prefs, p, { medians: opts.medians, maxPop }) }))
    .sort((a, b) => b.score - a.score || a.id - b.id)
    .slice(0, opts.limit ?? 8);
}
