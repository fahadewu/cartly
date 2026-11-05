import { type Interaction, type TasteProduct, buildTaste, PERSONALITIES, recommend, tasteReason } from './taste.js';
import { parseUa, sourceOf } from './ua.js';

const P = (id: number, over: Partial<TasteProduct>): TasteProduct => ({
  id, categorySlug: 'clothing-shoes', type: 'Clothing', gender: 'unisex', price: 60, compareAt: null, isNew: false,
  popularity: 50, stock: 10, styleTags: [], occasions: [], ...over,
});
const catalog = [
  P(1, { styleTags: ['streetwear', 'graphic'], price: 30, gender: 'men' }),
  P(2, { styleTags: ['streetwear', 'bold'], price: 40, gender: 'men', isNew: true }),
  P(3, { styleTags: ['classic', 'elegant'], price: 150, gender: 'women', popularity: 99 }),
  P(4, { styleTags: ['minimal', 'clean'], price: 70 }),
  P(5, { styleTags: ['streetwear', 'playful'], price: 35, gender: 'men' }),
  P(6, { styleTags: ['heritage', 'classic'], price: 160, gender: 'men', occasions: ['formal'] }),
  P(7, { styleTags: ['streetwear'], price: 45, stock: 0 }),
];
const byId = new Map(catalog.map((p) => [p.id, p]));
const now = Date.now();
const at = (daysAgo: number) => new Date(now - daysAgo * 864e5);
const none = { routeViews: {}, offersViews: 0, productPageSeconds: null };
const streetFan: Interaction[] = [
  ...Array.from({ length: 6 }, (_, i) => ({ type: 'view' as const, productId: i % 2 ? 1 : 5, at: at(i) })),
  { type: 'cart_add', productId: 1, at: at(1) },
  { type: 'purchase', productId: 5, at: at(2) },
];

describe('taste', () => {
  it('reads a streetwear shopper from what they do', () => {
    const t = buildTaste(byId, streetFan, none, [], now);
    expect(t.personality).toBe('trendsetter');
    expect(Object.keys(t.tags)[0]).toBe('streetwear');
    expect(t.priceBand).toBe('budget');
    expect(t.genders.men).toBe(1);
    expect(t.ageGroup).toBe('18-24');
    expect(t.ageConfidence).toBeGreaterThan(0.3);
    expect(tasteReason(t)).toMatch(/trendsetter/);
  });

  it('uses style quiz answers from the first visit, and says so', () => {
    const quiz = [{ styles: PERSONALITIES.minimalist.tags }];
    const t = buildTaste(byId, [], none, quiz, now);
    expect(t.evidence).toBe(0); // answers aren't behaviour: no age or price guesses from them
    expect(t.ageGroup).toBeNull();
    expect(t.personality).toBe('minimalist');
    expect(recommend(t, catalog, { limit: 1 })[0].id).toBe(4); // the minimal piece beats the most popular one
    expect(tasteReason(t, ['minimalist'])).toBe('Because you picked Minimalist in your style quiz');
    expect(tasteReason(t, ['glam'])).toMatch(/minimalist/); // a pick that doesn't show in what they like isn't claimed
  });

  it('knows nothing (and guesses nothing) about someone new', () => {
    const t = buildTaste(byId, [], none, [], now);
    expect(t).toMatchObject({ personality: null, priceBand: null, ageGroup: null, evidence: 0, traits: [] });
  });

  it('weighs recent behaviour over old', () => {
    const old = buildTaste(byId, [{ type: 'purchase', productId: 3, at: at(120) }, { type: 'view', productId: 4, at: at(0) }], none, [], now);
    expect(Object.keys(old.tags)[0]).toMatch(/minimal|clean/);
  });

  it('lets what the shopper said count, including a stated life stage', () => {
    const t = buildTaste(byId, [], none, [{ styles: ['minimal'], budget: 'premium', age: '55+' }], now);
    expect(t.personality).toBe('minimalist');
    expect(t.priceBand).toBe('premium');
    expect(t.ageGroup).toBe('55+');
  });

  it('spots shopping styles', () => {
    const t = buildTaste(byId, [{ type: 'view', productId: 2, at: at(0) }, { type: 'cart_add', productId: 2, at: at(0) }, { type: 'tryon', productId: 2, at: at(0) }, { type: 'tryon', productId: 1, at: at(0) }, { type: 'tryon', productId: 5, at: at(0) }], { ...none, productPageSeconds: 60 }, [], now);
    expect(t.traits).toEqual(expect.arrayContaining(['decisive', 'tries-before-buying', 'researcher']));
  });

  it('recommends to taste, leaves out bought and sold-out items', () => {
    const t = buildTaste(byId, streetFan, none, [], now);
    const ids = recommend(t, catalog, { bought: new Set([5]) }).map((r) => r.id);
    expect(ids.slice(0, 2).sort()).toEqual([1, 2]); // streetwear, men's, cheap
    expect(recommend(t, catalog, { bought: new Set([5]), recent: new Set([1]) })[0].id).toBe(2); // just seen: something new first
    expect(ids).not.toContain(5);
    expect(ids).not.toContain(7);
    const all = recommend(t, catalog.map((p, i) => ({ ...p, type: `T${i}` }))).map((r) => r.id); // no per-type cap
    expect(all.indexOf(3)).toBeGreaterThan(all.indexOf(1)); // women's premium classic ranks low for him
  });

  it('falls back to popularity for someone new', () => {
    expect(recommend(null, catalog)[0].id).toBe(3);
  });
});

describe('visits', () => {
  it('tells devices and sources apart', () => {
    expect(parseUa('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1')).toEqual({ device: 'mobile', browser: 'Safari', os: 'iOS' });
    expect(parseUa('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36 Edg/140.0')).toEqual({ device: 'desktop', browser: 'Edge', os: 'Windows' });
    expect(sourceOf('https://www.google.com/', ['cartly.shop'])).toEqual({ host: 'google.com', source: 'search' });
    expect(sourceOf('https://l.instagram.com/', ['cartly.shop']).source).toBe('social');
    expect(sourceOf('https://facebook.com/x', ['cartly.shop']).source).toBe('social');
    expect(sourceOf('https://cartly.shop/cart', ['cartly.shop'])).toEqual({ host: null, source: 'direct' });
    expect(sourceOf(null, [], 'Newsletter').source).toBe('newsletter');
  });
});
