/*
 * The taste model: pure functions, no I/O, so they're cheap to run and easy to test.
 *
 * A shopper's profile comes from what they do, weighted by how strongly it shows intent and how recent
 * it is (half-life HALF_LIFE_DAYS): a purchase says more than a cart add, which says more than a view.
 * Everything here is an assumption from behaviour. It is never shown to the shopper as a fact about them.
 */

import { colourFamily } from './likeness.js';

export interface TasteProduct {
  id: number;
  categorySlug: string;
  type: string;
  gender: string;
  price: number;
  compareAt: number | null;
  isNew: boolean;
  popularity: number;
  stock: number;
  styleTags: string[];
  occasions: string[];
  /** Swatches, for the colour families they lean to (optional: older callers leave them out). */
  colors?: { name: string; hex: string }[];
}

export type Signal = 'view' | 'search' | 'favourite' | 'tryon' | 'cart_add' | 'purchase';
export interface Interaction {
  type: Signal;
  productId: number;
  at: Date;
}
/** What Pip picked up in conversation ("something minimal", "on a student budget", "for my 30th"), or the styles
 * picked in the style quiz (as their personalities' tags). */
export interface ChatHint {
  styles?: string[];
  budget?: 'budget' | 'value' | 'premium' | null;
  age?: string | null;
}
export interface Behaviour {
  /** Pages opened per route over the window, and average seconds on product pages. */
  routeViews: Record<string, number>;
  offersViews: number;
  productPageSeconds: number | null;
}

export interface Taste {
  personality: string | null;
  styles: Record<string, number>;
  tags: Record<string, number>;
  categories: Record<string, number>;
  genders: Record<string, number>;
  /** Share of attention by colour family (likeness.ts colourFamily). */
  colors: Record<string, number>;
  priceBand: 'budget' | 'value' | 'premium' | null;
  priceRatio: number | null;
  traits: string[];
  ageGroup: string | null;
  ageConfidence: number | null;
  evidence: number;
}

export const HALF_LIFE_DAYS = 30;
const WEIGHT: Record<Signal, number> = { view: 1, search: 0, favourite: 3, tryon: 3, cart_add: 4, purchase: 6 };

/** Shopping personalities, each recognised by the style tags of what the shopper engages with. */
export const PERSONALITIES: Record<string, { label: string; tags: string[] }> = {
  minimalist: { label: 'Minimalist', tags: ['minimal', 'clean', 'basics', 'modern', 'practical'] },
  classic: { label: 'Timeless classic', tags: ['classic', 'elegant', 'smart', 'preppy', 'heritage', 'workwear'] },
  trendsetter: { label: 'Trendsetter', tags: ['streetwear', 'graphic', 'edgy', 'biker', 'statement', 'bold', 'tech'] },
  romantic: { label: 'Romantic', tags: ['romantic', 'feminine', 'floral', 'flowy', 'pastel', 'soft', 'boho'] },
  sporty: { label: 'Active & sporty', tags: ['sporty', 'athleisure', 'outdoor'] },
  comfort: { label: 'Comfort-first', tags: ['cosy', 'warm', 'casual', 'self-care', 'lounge'] },
  free_spirit: { label: 'Free spirit', tags: ['boho', 'natural', 'handmade', 'festival', 'playful'] },
  vintage: { label: 'Vintage lover', tags: ['retro', 'vintage', 'heritage'] },
  glam: { label: 'Glam', tags: ['glam', 'statement', 'festival', 'bold'] },
};
const TAG_PERSONALITIES = new Map<string, string[]>();
for (const [key, p] of Object.entries(PERSONALITIES)) for (const t of p.tags) TAG_PERSONALITIES.set(t, [...(TAG_PERSONALITIES.get(t) ?? []), key]);

export const AGE_GROUPS = ['under-18', '18-24', '25-34', '35-44', '45-54', '55+'] as const;
const AGE_INDEX = Object.fromEntries(AGE_GROUPS.map((g, i) => [g, i]));
// How much engaging with a style or occasion nudges the age guess towards each group (18-24 … 55+).
// Deliberately soft: one style never decides an age, it only adds up with everything else.
const AGE_PRIOR: Record<string, number[]> = {
  streetwear: [3, 2, 0.5, 0, 0], graphic: [3, 2, 0.5, 0, 0], edgy: [2, 2, 1, 0, 0], playful: [2, 1.5, 1, 0.5, 0],
  festival: [3, 1.5, 0.5, 0, 0], tech: [1.5, 2, 1, 0.5, 0], biker: [1, 2, 1.5, 0.5, 0], retro: [1.5, 1.5, 1, 0.5, 0.5],
  minimal: [1, 2, 1.5, 1, 0.5], modern: [1, 2, 1.5, 1, 0.5], sporty: [1.5, 1.5, 1.5, 1, 0.5], casual: [1.5, 1.5, 1, 1, 1],
  classic: [0, 1, 1.5, 2, 2], elegant: [0, 1, 2, 2, 1.5], smart: [0.5, 1.5, 2, 1.5, 1], heritage: [0, 0.5, 1, 2, 2.5],
  workwear: [0.5, 2, 2, 1, 0.5], preppy: [1.5, 2, 1, 0.5, 0.5], 'self-care': [0.5, 1.5, 1.5, 1, 1], cosy: [1, 1, 1.5, 1.5, 1.5],
  office: [0, 2, 2, 1.5, 0.5], formal: [0, 1, 1.5, 2, 1.5], 'date-night': [1.5, 2, 1, 0.5, 0], party: [2, 2, 1, 0.5, 0],
  lounge: [1, 1, 1.5, 1.5, 1.5], wedding: [0.5, 1.5, 1.5, 1, 1],
};
const PRICE_AGE: Record<string, number[]> = { budget: [2, 1, 0.5, 0.5, 0.5], value: [1, 1.5, 1.5, 1, 1], premium: [0, 1, 2, 2, 1.5] };
const MIN_EVIDENCE = { personality: 5, priceBand: 4, age: 8 };

const decay = (at: Date, now: number) => 0.5 ** ((now - at.getTime()) / 864e5 / HALF_LIFE_DAYS);
const add = (m: Record<string, number>, k: string, v: number) => (m[k] = (m[k] ?? 0) + v);
const share = (m: Record<string, number>) => {
  const total = Object.values(m).reduce((a, b) => a + b, 0);
  return Object.fromEntries(
    Object.entries(m)
      .filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => [k, Math.round((v / total) * 1000) / 1000]),
  );
};
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0;
};

export function categoryMedians(products: TasteProduct[]) {
  const by = new Map<string, number[]>();
  for (const p of products) by.set(p.categorySlug, [...(by.get(p.categorySlug) ?? []), p.price]);
  return new Map([...by].map(([k, v]) => [k, median(v)]));
}

export function buildTaste(
  products: Map<number, TasteProduct>,
  interactions: Interaction[],
  behaviour: Behaviour,
  hints: ChatHint[],
  now = Date.now(),
): Taste {
  const medians = categoryMedians([...products.values()]);
  const tags: Record<string, number> = {};
  const categories: Record<string, number> = {};
  const genders: Record<string, number> = {};
  const colors: Record<string, number> = {};
  const age = [0, 0, 0, 0, 0]; // 18-24 … 55+ from behaviour; under-18 only ever comes from what the shopper said
  let evidence = 0;
  let priceSum = 0;
  let discounted = 0;
  let fresh = 0;
  const counts: Partial<Record<Signal, number>> = {};

  for (const e of interactions) {
    const p = products.get(e.productId);
    const w = WEIGHT[e.type] * decay(e.at, now);
    counts[e.type] = (counts[e.type] ?? 0) + 1;
    if (!p || !w) continue;
    evidence += w;
    for (const t of p.styleTags) add(tags, t.toLowerCase(), w);
    for (const tag of [...p.styleTags, ...p.occasions]) {
      const prior = AGE_PRIOR[tag.toLowerCase()];
      if (prior) prior.forEach((v, i) => (age[i] += v * w));
    }
    add(categories, p.categorySlug, w);
    add(genders, p.gender, w);
    // A product in several colours splits the signal between them.
    const swatches = p.colors ?? [];
    for (const c of swatches) add(colors, colourFamily(c.hex), w / swatches.length);
    priceSum += (p.price / (medians.get(p.categorySlug) || p.price)) * w;
    if (p.compareAt && p.compareAt > p.price) discounted += w;
    if (p.isNew) fresh += w;
  }

  // What the shopper said outweighs a few clicks, but doesn't erase a long history.
  let hintedBudget: Taste['priceBand'] = null;
  const hintedAge: number[] = [];
  for (const h of hints) {
    for (const s of h.styles ?? []) add(tags, s.toLowerCase(), 3);
    if (h.budget) hintedBudget = h.budget;
    if (h.age && h.age in AGE_INDEX) hintedAge.push(AGE_INDEX[h.age]);
  }

  const styles: Record<string, number> = {};
  for (const [tag, w] of Object.entries(tags)) for (const key of TAG_PERSONALITIES.get(tag) ?? []) add(styles, key, w);
  const styleShare = share(styles);
  const [top, topShare] = Object.entries(styleShare)[0] ?? [null, 0];
  const personality = top && topShare >= 0.25 && (evidence >= MIN_EVIDENCE.personality || hints.some((h) => h.styles?.length)) ? top : null;

  const priceRatio = evidence ? Math.round((priceSum / evidence) * 100) / 100 : null;
  let priceBand: Taste['priceBand'] = null;
  if (priceRatio != null && evidence >= MIN_EVIDENCE.priceBand) priceBand = priceRatio < 0.8 ? 'budget' : priceRatio > 1.25 ? 'premium' : 'value';
  if (hintedBudget && evidence < 20) priceBand = hintedBudget;

  const traits: string[] = [];
  if (evidence >= 4 && (discounted / evidence >= 0.4 || behaviour.offersViews >= 3)) traits.push('deal-seeker');
  if (evidence >= 4 && fresh / evidence >= 0.4) traits.push('trend-seeker');
  if ((counts.tryon ?? 0) >= 3) traits.push('tries-before-buying');
  const views = counts.view ?? 0;
  const commits = (counts.cart_add ?? 0) + (counts.purchase ?? 0);
  if (commits >= 1 && views / commits <= 3) traits.push('decisive');
  else if (views >= 10 && views / Math.max(1, commits) >= 10) traits.push('explorer');
  if (behaviour.productPageSeconds != null && behaviour.productPageSeconds >= 45) traits.push('researcher');
  if (priceBand === 'premium') traits.push('quality-focused');

  let ageGroup: string | null = null;
  let ageConfidence: number | null = null;
  const scores = [0, ...age]; // aligned with AGE_GROUPS
  if (priceBand) PRICE_AGE[priceBand].forEach((v, i) => (scores[i + 1] += v * Math.min(evidence, 10)));
  for (const i of hintedAge) scores[i] += Math.max(20, evidence * 2);
  const total = scores.reduce((a, b) => a + b, 0);
  if (total > 0 && (evidence >= MIN_EVIDENCE.age || hintedAge.length)) {
    // A soft guess: the most likely group, but also its neighbour when they're close, so confidence is honest.
    const best = scores.indexOf(Math.max(...scores));
    const conf = scores[best] / total;
    if (conf >= 0.3 || hintedAge.length) {
      ageGroup = AGE_GROUPS[best];
      ageConfidence = Math.round(Math.min(conf + (hintedAge.length ? 0.3 : 0), 0.95) * 100) / 100;
    }
  }

  return {
    personality,
    styles: styleShare,
    tags: share(tags),
    categories: share(categories),
    genders: share(genders),
    colors: share(colors),
    priceBand,
    priceRatio,
    traits,
    ageGroup,
    ageConfidence,
    evidence: Math.round(evidence * 100) / 100,
  };
}

/** "minimalist and classic" → a reason a person would say. */
export function tasteReason(t: Pick<Taste, 'styles' | 'traits' | 'priceBand'>, declared: string[] = []) {
  // What they told us in the style quiz may be said back to them; what we only inferred is said more softly.
  const picked = declared.filter((k) => PERSONALITIES[k] && (t.styles[k] ?? 0) > 0).slice(0, 2);
  if (picked.length) return `Because you picked ${picked.map((k) => PERSONALITIES[k].label).join(' and ')} in your style quiz`;
  const top = Object.entries(t.styles)
    .filter(([, v]) => v >= 0.15)
    .slice(0, 2)
    .map(([k]) => PERSONALITIES[k]?.label.toLowerCase())
    .filter(Boolean);
  if (top.length) return `Because you like ${top.join(' and ')} pieces`;
  if (t.traits.includes('deal-seeker')) return 'Great value picks for you';
  if (t.traits.includes('trend-seeker')) return 'New in, picked for you';
  return 'Picked for you';
}

export interface Ranked {
  id: number;
  score: number;
}

/**
 * Products ranked for this shopper. Style match counts most, then category, price fit and gender; a little
 * popularity breaks ties and carries shoppers we know nothing about yet. Bought items are left out and no one
 * type takes more than a third of the list, so the list stays varied.
 */
export function recommend(
  t: Taste | null,
  products: TasteProduct[],
  opts: { bought?: Set<number>; recent?: Set<number>; limit?: number } = {},
): Ranked[] {
  const limit = opts.limit ?? 12;
  const medians = categoryMedians(products);
  const maxPop = Math.max(1, ...products.map((p) => p.popularity));
  const maxTag = Math.max(0, ...Object.values(t?.tags ?? {}));
  const maxCat = Math.max(0, ...Object.values(t?.categories ?? {}));
  const gendered = Object.entries(t?.genders ?? {}).filter(([g]) => g !== 'unisex');
  const genderTotal = gendered.reduce((a, [, v]) => a + v, 0);

  const scored = products
    .filter((p) => p.stock > 0 && !opts.bought?.has(p.id))
    .map((p) => {
      let s = 0.6 * (p.popularity / maxPop);
      // Style quiz answers count from the first visit, before there's any browsing to learn from.
      if (t && (t.evidence > 0 || maxTag > 0)) {
        if (maxTag) s += 2 * (p.styleTags.reduce((a, tag) => a + (t.tags[tag.toLowerCase()] ?? 0), 0) / maxTag);
        if (maxCat) s += (t.categories[p.categorySlug] ?? 0) / maxCat;
        const g = p.gender === 'unisex' || !genderTotal ? 1 : (t.genders[p.gender] ?? 0) / genderTotal;
        s += 0.8 * g - (g < 0.1 ? 1.5 : 0); // rarely suggest a gender they never look at
        const r = p.price / (medians.get(p.categorySlug) || p.price);
        if (t.priceBand === 'budget') s += r <= 1 ? 1 : 1 / (r * r);
        else if (t.priceBand === 'premium') s += r >= 1 ? 1 : r;
        else if (t.priceBand === 'value') s += Math.exp(-Math.abs(Math.log(r)));
        if (t.traits.includes('deal-seeker') && p.compareAt && p.compareAt > p.price) s += 0.5;
        if (t.traits.includes('trend-seeker') && p.isNew) s += 0.5;
      }
      if (opts.recent?.has(p.id)) s *= 0.7; // just looked at it: still relevant, but show something new first
      return { id: p.id, type: p.type, score: Math.round(s * 1000) / 1000 };
    })
    .sort((a, b) => b.score - a.score || a.id - b.id);

  const perTypeMax = Math.max(2, Math.ceil(limit / 3));
  const perType = new Map<string, number>();
  const out: Ranked[] = [];
  for (const p of scored) {
    const n = perType.get(p.type) ?? 0;
    if (n >= perTypeMax) continue;
    perType.set(p.type, n + 1);
    out.push({ id: p.id, score: p.score });
    if (out.length >= limit) break;
  }
  return out;
}
