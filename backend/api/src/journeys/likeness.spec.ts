import { colourFamily, colourWarmth, likeness, rankByLikeness, suitingShades, toneFit, type LikenessProduct, type TasteLike } from './likeness.js';
import { buildTaste, categoryMedians } from './taste.js';

const base: Omit<LikenessProduct, 'id'> = {
  categorySlug: 'clothing-shoes',
  type: 'Clothing',
  gender: 'unisex',
  price: 50,
  compareAt: null,
  isNew: false,
  popularity: 50,
  stock: 10,
  styleTags: [],
  occasions: [],
  sizes: ['S', 'M', 'L'],
  colors: [{ name: 'Black', hex: '#111111' }],
};
const product = (id: number, p: Partial<LikenessProduct>): LikenessProduct => ({ ...base, id, ...p });

describe('colours', () => {
  it('puts swatches into families', () => {
    expect(colourFamily('#111111')).toBe('black');
    expect(colourFamily('#ffffff')).toBe('white');
    expect(colourFamily('#8a8d91')).toBe('grey');
    expect(colourFamily('#1c2a4a')).toBe('navy');
    expect(colourFamily('#1f5bff')).toBe('blue');
    expect(colourFamily('#6b7a4b')).toBe('green'); // olive
    expect(colourFamily('#c62828')).toBe('red');
    expect(colourFamily('#f7a8c9')).toBe('pink');
    expect(colourFamily('#6d4c33')).toBe('brown');
    expect(colourFamily('#d9c7a7')).toBe('beige');
    expect(colourFamily('#f5d75a')).toBe('yellow');
    expect(colourFamily('not a colour')).toBe('grey');
  });

  it('tells warm from cool', () => {
    expect(colourWarmth('#ef7d2d')).toBeGreaterThan(0.5); // orange
    expect(colourWarmth('#1f5bff')).toBeLessThan(-0.5); // blue
    expect(colourWarmth('#8a8d91')).toBe(0); // grey
  });

  it('suits warm shades to warm undertones and cool to cool', () => {
    const rust = '#b5502b';
    const cobalt = '#1f4fd1';
    expect(toneFit(6, 'warm', rust)!).toBeGreaterThan(toneFit(6, 'warm', cobalt)!);
    expect(toneFit(3, 'cool', cobalt)!).toBeGreaterThan(toneFit(3, 'cool', rust)!);
    expect(toneFit(null, null, rust)).toBeNull();
  });

  it('gives deeper tones contrast: crisp white over a mid beige', () => {
    expect(toneFit(9, 'neutral', '#ffffff')!).toBeGreaterThan(toneFit(9, 'neutral', '#6d4c33')!);
  });

  it('names shades that usually suit', () => {
    expect(suitingShades(8, 'warm')).toEqual(expect.arrayContaining(['olive', 'rust', 'bright white']));
    expect(suitingShades(2, 'cool')).toEqual(expect.arrayContaining(['navy', 'soft rose']));
  });
});

describe('likeness', () => {
  const products = [
    product(1, { name: 'Street Hoodie', styleTags: ['streetwear', 'graphic'], colors: [{ name: 'Rust', hex: '#b5502b' }] }),
    product(2, { name: 'Linen Shirt', styleTags: ['classic', 'smart'], colors: [{ name: 'Cobalt', hex: '#1f4fd1' }] }),
    product(3, { name: 'Cargo Pants', styleTags: ['streetwear'], sizes: ['30', '32'], type: 'Clothing' }),
    product(4, { name: 'Sold-out Tee', styleTags: ['streetwear'], stock: 0 }),
    product(5, { name: 'Gift Candle', categorySlug: 'gifts-living', type: 'Home', styleTags: ['cosy'], gender: 'unisex' }),
  ];
  const byId = new Map(products.map((p) => [p.id, p]));
  const now = Date.now();
  const views = (id: number, n: number) => Array.from({ length: n }, (_, i) => ({ type: 'favourite' as const, productId: id, at: new Date(now - i * 3600e3) }));
  const taste = buildTaste(byId, [...views(1, 6), ...views(3, 3)], { routeViews: {}, offersViews: 0, productPageSeconds: null }, [], now) as TasteLike;
  const ctx = { medians: categoryMedians(products), maxPop: 50 };

  it('learns colour families from what they engage with', () => {
    expect(Object.keys(taste.colors ?? {})[0]).toBe('orange'); // the rust hoodie, most favourited
  });

  it('ranks their style first and says why', () => {
    const hoodie = likeness(taste, null, products[0], ctx);
    const shirt = likeness(taste, null, products[1], ctx);
    expect(hoodie.score).toBeGreaterThan(shirt.score);
    expect(hoodie.reasons.join(' ')).toMatch(/streetwear style/);
  });

  it('counts their colouring when they shared it', () => {
    const warm = likeness(taste, { skinTone: 6, undertone: 'warm' }, products[0], ctx);
    const cool = likeness(taste, { skinTone: 6, undertone: 'cool' }, products[0], ctx);
    expect(warm.parts.colour).toBeGreaterThan(cool.parts.colour);
    // A nudge, not a rule: their own choices still carry the colour score.
    expect(cool.parts.colour).toBeGreaterThan(0.75);
    expect(warm.reasons.join(' ')).toMatch(/rust suits their colouring/);
  });

  it('marks products down that don’t come in their size, and says so', () => {
    const cargo = likeness(taste, { sizes: { Clothing: 'M' } }, products[2], ctx);
    expect(cargo.parts.size).toBe(0);
    expect(cargo.reasons.join(' ')).toMatch(/not in their size \(M\)/);
    const hoodie = likeness(taste, { sizes: { Clothing: 'm' } }, products[0], ctx);
    expect(hoodie.parts.size).toBe(1);
  });

  it('leaves out sold-out and bought products when ranking', () => {
    const ranked = rankByLikeness(taste, null, products, { exclude: new Set([1]), medians: ctx.medians });
    expect(ranked.map((r) => r.id)).not.toContain(1);
    expect(ranked.map((r) => r.id)).not.toContain(4);
    expect(ranked[0].id).toBe(3);
  });

  it('falls back to popularity for a shopper with no history', () => {
    const r = likeness(null, null, products[0], ctx);
    expect(r.score).toBeGreaterThan(0);
    expect(r.parts.style).toBe(0);
  });
});
