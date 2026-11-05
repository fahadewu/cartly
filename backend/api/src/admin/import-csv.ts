// Reading and writing product CSVs: no database here, so it's all unit-tested (import-csv.spec.ts).
// Three formats come in:
// - Cartly's own columns: what the export writes, so export → edit in a spreadsheet → import round-trips;
// - Shopify's product export (Products → Export): one row per variant, grouped by Handle;
// - WooCommerce's product export (Products → Export): variations under their parent product.
// Each becomes a Draft: the product fields that file states (anything it leaves empty is left out, so an
// update never wipes what the store already has), plus what was guessed and why.

export type Format = 'cartly' | 'shopify' | 'woocommerce';
export type Category = { slug: string; title: string; types: string[] };
export type Defaults = { category?: string; type?: string; gender?: string };
export type Draft = {
  line: number;
  name: string;
  /** How to find the product if it already exists: Cartly's own id, else its slug. */
  id?: number;
  slug?: string;
  data: Record<string, unknown>;
  warnings: string[];
  errors: string[];
};

/** Cartly's columns, in export order. Lists are separated by "|"; colours are "Name:#hex". */
export const COLUMNS = [
  'id', 'slug', 'name', 'category', 'type', 'gender', 'label', 'price', 'compareAt', 'stock', 'active', 'isNew',
  'image', 'colors', 'sizes', 'collections', 'description', 'material', 'fit', 'fitNotes', 'occasions', 'seasons',
  'styleTags', 'features', 'keywords', 'careNotes', 'pairsWith', 'tryOnSlot', 'tryOnImage',
] as const;
const LIST_SEP = '|';
export const MAX_ROWS = 5000;

/* ------------------------------ CSV ------------------------------ */

/** RFC 4180 CSV (quotes, "" escapes, line breaks inside quotes), comma, semicolon or tab separated, BOM tolerated. */
export function parseCsv(text: string): string[][] {
  const s = text.replace(/^﻿/, '');
  const first = s.slice(0, (s.indexOf('\n') + 1 || s.length + 1) - 1);
  const count = (c: string) => first.split(c).length - 1;
  const delim = count(';') > count(',') ? ';' : count('\t') > count(',') ? '\t' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c !== '"') field += c;
      else if (s[i + 1] === '"') (field += '"'), i++;
      else quoted = false;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === delim) row.push(field), (field = '');
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      (row = []), (field = '');
    } else field += c;
  }
  if (field !== '' || row.length) row.push(field), rows.push(row);
  return rows.filter((r) => r.some((v) => v.trim() !== ''));
}

/** Cells a spreadsheet would run as a formula get a leading apostrophe on export, which import removes. */
const FORMULA = /^[=+\-@\t\r]/;
const cell = (v: unknown) => {
  let s = v == null ? '' : String(v);
  if (typeof v === 'string' && FORMULA.test(s) && !/^-?\d/.test(s)) s = `'${s}`;
  return /[",\n\r]|^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
/** CSV with a BOM, so Excel reads Bangla and other scripts correctly. */
export const toCsv = (rows: unknown[][]) => '﻿' + rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';

const norm = (h: string) => h.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const unformula = (v: string) => (/^'[=+\-@]/.test(v) ? v.slice(1) : v);

type Rec = { line: number; get: (column: string) => string };
function records(rows: string[][]) {
  const index = new Map<string, number>();
  rows[0].forEach((h, i) => !index.has(norm(h)) && index.set(norm(h), i));
  const has = (c: string) => index.has(norm(c));
  const recs: Rec[] = rows.slice(1).map((r, i) => ({
    line: i + 2,
    get: (c) => unformula((r[index.get(norm(c)) ?? -1] ?? '').trim()),
  }));
  return { has, recs };
}

export function detectFormat(header: string[]): Format | null {
  const h = new Set(header.map(norm));
  if (h.has('handle') && h.has('title')) return 'shopify';
  if (h.has('regular price') && h.has('name')) return 'woocommerce';
  // Cartly's own: something that names the product (a new one needs `name`; `id` or `slug` updates one) and
  // at least one more of its columns, so "slug,price,stock" updates prices and stock in bulk.
  const known = COLUMNS.filter((c) => h.has(norm(c))).length;
  if ((h.has('name') || h.has('slug') || h.has('id')) && known >= 2) return 'cartly';
  return null;
}

/* ------------------------------ guesses ------------------------------ */

const COLOUR_HEX: Record<string, string> = {
  black: '#111111', white: '#ffffff', 'off white': '#f4f1ea', ivory: '#fffff0', cream: '#f3ead3', beige: '#d9c7a7',
  grey: '#8a8d91', gray: '#8a8d91', charcoal: '#36393d', silver: '#c0c0c0', red: '#c62828', maroon: '#6d1a1f',
  burgundy: '#7a1f2b', wine: '#6b2737', pink: '#f2a7c3', blush: '#f7c8d0', rose: '#e8a0a8', orange: '#ef7d2d',
  rust: '#b5502b', coral: '#f47c6a', peach: '#f9c9a8', yellow: '#f5d75a', mustard: '#d4a72c', gold: '#c9a227',
  green: '#2e7d4f', olive: '#6b6b2a', khaki: '#b5a46d', mint: '#b5eed3', sage: '#9caf88', teal: '#1f7a7a',
  blue: '#1f5bff', 'sky blue': '#87c4ec', 'light blue': '#a8cdf0', navy: '#1c2a4a', denim: '#3b5b8c',
  purple: '#6a3d9a', lilac: '#c8a2c8', lavender: '#b9a7e0', brown: '#6d4c33', tan: '#c19a6b', camel: '#c19a6b',
  chocolate: '#4e3323', multi: '#9e9e9e', multicolor: '#9e9e9e', multicolour: '#9e9e9e',
};
const UNKNOWN_HEX = '#9e9e9e';

function colours(names: string[], warnings: string[]) {
  const unknown: string[] = [];
  const out = names.slice(0, 8).map((raw) => {
    const name = raw.trim().slice(0, 30);
    const hex = COLOUR_HEX[name.toLowerCase()] ?? COLOUR_HEX[name.toLowerCase().split(/[\s/-]+/).at(-1) ?? ''];
    if (!hex) unknown.push(name);
    return { name, hex: hex ?? UNKNOWN_HEX };
  });
  if (unknown.length) warnings.push(`Check the swatch colour of ${unknown.join(', ')} (set to grey).`);
  return out;
}

const TYPE_WORDS: Record<string, RegExp> = {
  Shoes: /\b(shoes?|sneakers?|trainers?|boots?|sandals?|heels?|loafers?|slippers?|flip[ -]?flops?|footwear|keds)\b/i,
  Clothing:
    /\b(shirts?|t-?shirts?|tees?|tops?|blouses?|dress(es)?|skirts?|jeans|trousers|pants|shorts|jackets?|coats?|hoodies?|sweaters?|sweatshirts?|cardigans?|kurtas?|kurtis?|panjabis?|punjabis?|sarees?|saris?|salwar|kameez|lehengas?|abayas?|lungis?|polos?|leggings|joggers|blazers?|suits?|apparel|clothing|nightwear|pyjamas?)\b/i,
  Accessories:
    /\b(bags?|backpacks?|totes?|wallets?|purses?|watch(es)?|sunglasses|glasses|eyewear|hats?|caps?|beanies?|scarf|scarves|hijabs?|belts?|jewel(le)?ry|necklaces?|rings?|earrings?|bracelets?|bangles?|headphones?|earbuds?|accessor(y|ies))\b/i,
  Home: /\b(home|decor|candles?|mugs?|cushions?|pillows?|throws?|blankets?|vases?|lamps?|kitchen|bedding|towels?)\b/i,
  Gifts: /\b(gifts?|gift ?cards?|hampers?)\b/i,
};

/** The Cartly type and category for a product, from its own wording (most specific text first), else the defaults. */
export function guessKind(texts: string[], categories: Category[], defaults: Defaults, warnings: string[], errors: string[]) {
  const types = [...new Set(categories.flatMap((c) => c.types))];
  let type: string | undefined;
  let from = '';
  outer: for (const text of texts.filter(Boolean)) {
    for (const t of types) {
      const words = TYPE_WORDS[t] ?? new RegExp(`\\b${t.replace(/[^\w ]/g, '')}\\b`, 'i');
      if (new RegExp(`^${t}$`, 'i').test(text.trim()) || words.test(text)) {
        type = t;
        from = text;
        break outer;
      }
    }
  }
  if (type) {
    if (!new RegExp(`^${type}$`, 'i').test(from.trim())) warnings.push(`Type ${type}, guessed from “${from.slice(0, 60)}”.`);
  } else if (defaults.type) {
    type = defaults.type;
  } else {
    errors.push(`Can’t tell what kind of product this is (${types.join(', ')}): choose a type for such rows.`);
    return {};
  }
  const category =
    (defaults.category && categories.find((c) => c.slug === defaults.category && c.types.includes(type!))) ||
    categories.find((c) => c.types.includes(type!));
  return { type, category: category?.slug };
}

export function guessGender(texts: string[], fallback: string | undefined) {
  const t = texts.join(' ');
  if (/\b(women'?s?|woman|ladies|lady|female|girls?)\b/i.test(t)) return 'women';
  if (/\b(men'?s?|man|male|gents?|boys?)\b/i.test(t)) return 'men';
  return fallback ?? 'unisex';
}

/** Plain text from a product description's HTML. */
export function htmlToText(html: string) {
  return html
    .replace(/<\s*(br|\/p|\/li|\/h\d|\/div)\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/** At most 1000 characters (the editor's limit), cut at a sentence when it's longer. */
function description(text: string, warnings: string[]) {
  if (text.length <= 1000) return text;
  const cut = text.slice(0, 1000);
  warnings.push('Description shortened to 1,000 characters.');
  return cut.slice(0, Math.max(cut.lastIndexOf('. ') + 1, 900)).trim();
}

export const slugify = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 80) || 'item';

/** A number from a cell: currency signs and thousands separators dropped, "12,50" read as 12.5; NaN for words. */
function num(v: string) {
  if (v === '') return undefined;
  let s = v.replace(/[^\d.,-]/g, '');
  if (!/\d/.test(s)) return NaN;
  s = /^-?\d+,\d{1,2}$/.test(s) ? s.replace(',', '.') : s.replace(/,/g, '');
  return Number(s);
}
const unique = <T>(xs: T[]) => [...new Set(xs)];
const splitList = (v: string, sep: string | RegExp = LIST_SEP) => unique(v.split(sep).map((s) => s.trim()).filter(Boolean));
const bool = (v: string) => (v === '' ? undefined : /^(1|true|yes|y|on|active|published)$/i.test(v));

/** Fields every imported shop product needs that other platforms don't have. */
function finishForeign(d: Draft, f: { colours: string[]; sizes: string[]; stock?: number }, isNew: boolean) {
  d.data.colors = f.colours.length ? colours(f.colours, d.warnings) : [{ name: 'As shown', hex: UNKNOWN_HEX }];
  if (!f.colours.length) d.warnings.push('No colour in the file: shown as “As shown”.');
  d.data.sizes = f.sizes.length ? f.sizes.slice(0, 12).map((s) => s.slice(0, 12)) : ['One size'];
  if (!f.sizes.length) d.warnings.push('No sizes in the file: set to “One size”.');
  if (f.stock !== undefined && Number.isFinite(f.stock)) d.data.stock = Math.max(0, Math.round(f.stock));
  else if (isNew) {
    d.data.stock = 0;
    d.warnings.push('No stock count in the file: set to 0 (sold out) until you add it.');
  }
}

/* ------------------------------ formats ------------------------------ */

function fromCartly(rows: string[][], categories: Category[], defaults: Defaults): Draft[] {
  const { recs } = records(rows);
  return recs.map((r) => {
    const d: Draft = { line: r.line, name: r.get('name'), data: {}, warnings: [], errors: [] };
    const set = (k: string, v: unknown) => v !== undefined && v !== '' && (d.data[k] = v);
    const id = num(r.get('id'));
    if (id !== undefined && Number.isInteger(id)) d.id = id;
    d.slug = r.get('slug') || (d.name ? slugify(d.name) : undefined);
    for (const k of ['name', 'description', 'label', 'image', 'material', 'fit', 'fitNotes', 'careNotes', 'tryOnImage']) set(k, r.get(k));
    if (r.get('slug')) d.data.slug = r.get('slug');
    if (r.get('tryOnSlot')) d.data.tryOnSlot = r.get('tryOnSlot').toLowerCase();

    const cat = r.get('category');
    if (cat) {
      const c = categories.find((x) => x.slug === cat.toLowerCase() || x.title.toLowerCase() === cat.toLowerCase());
      if (c) d.data.category = c.slug;
      else d.errors.push(`Unknown category “${cat}” (this store has ${categories.map((x) => x.slug).join(', ')}).`);
    }
    const type = r.get('type');
    if (type) {
      const t = categories.flatMap((c) => c.types).find((x) => x.toLowerCase() === type.toLowerCase());
      d.data.type = t ?? type;
      if (!d.data.category && t) d.data.category = categories.find((c) => c.types.includes(t))!.slug;
    }
    const gender = r.get('gender').toLowerCase();
    if (gender) d.data.gender = gender;

    for (const k of ['price', 'compareAt', 'stock']) {
      const v = num(r.get(k));
      if (v === undefined) continue;
      if (!Number.isFinite(v)) d.errors.push(`${k} “${r.get(k)}” isn’t a number.`);
      else d.data[k] = k === 'compareAt' && v === 0 ? null : v; // compareAt 0 clears a sale price
    }
    for (const k of ['active', 'isNew']) if (bool(r.get(k)) !== undefined) d.data[k] = bool(r.get(k));

    if (r.get('colors')) {
      const named: string[] = [];
      const cs = splitList(r.get('colors')).map((c) => {
        const m = c.match(/^(.*?):\s*(#[0-9a-f]{6})$/i);
        if (m) return { name: m[1].trim(), hex: m[2].toLowerCase() };
        named.push(c);
        return null;
      });
      d.data.colors = [...cs.filter(Boolean), ...(named.length ? colours(named, d.warnings) : [])];
    }
    for (const k of ['sizes', 'collections', 'styleTags', 'features', 'keywords']) if (r.get(k)) d.data[k] = splitList(r.get(k));
    for (const k of ['occasions', 'seasons']) if (r.get(k)) d.data[k] = splitList(r.get(k).toLowerCase());
    if (r.get('pairsWith')) d.data.pairsWith = splitList(r.get('pairsWith')).map(Number).filter(Number.isInteger);
    if (!d.data.gender && defaults.gender && id === undefined) d.data.gender = defaults.gender;
    if (!d.data.type && defaults.type && id === undefined) {
      d.data.type = defaults.type;
      d.data.category ??= defaults.category ?? categories.find((c) => c.types.includes(defaults.type!))?.slug;
    }
    return d;
  });
}

function fromShopify(rows: string[][], categories: Category[], defaults: Defaults): Draft[] {
  const { has, recs } = records(rows);
  const groups = new Map<string, Rec[]>();
  for (const r of recs) {
    const handle = r.get('Handle');
    if (!handle) continue;
    if (!groups.has(handle)) groups.set(handle, []);
    groups.get(handle)!.push(r);
  }
  return [...groups].map(([handle, group]) => {
    const first = group[0];
    const g = (c: string) => group.map((r) => r.get(c)).find(Boolean) ?? '';
    const d: Draft = { line: first.line, name: g('Title'), slug: handle.toLowerCase(), data: {}, warnings: [], errors: [] };
    d.data.name = d.name;
    d.data.slug = slugify(handle);
    const text = htmlToText(g('Body (HTML)'));
    if (text) d.data.description = description(text, d.warnings);
    const productType = g('Type');
    const tags = splitList(g('Tags'), ',');
    const kind = guessKind([productType, g('Product Category'), ...tags, d.name], categories, defaults, d.warnings, d.errors);
    Object.assign(d.data, kind);
    d.data.gender = guessGender([g('Product Category'), productType, ...tags, d.name], defaults.gender);
    d.data.label = (productType || (kind.type as string) || 'New').slice(0, 30);

    const option = (re: RegExp) => {
      for (const n of [1, 2, 3]) if (re.test(g(`Option${n} Name`))) return unique(group.map((r) => r.get(`Option${n} Value`)).filter(Boolean));
      return [];
    };
    const variants = group.filter((r) => r.get('Variant Price'));
    const priced = variants.map((r) => ({ price: num(r.get('Variant Price'))!, compare: num(r.get('Variant Compare At Price')) })).filter((v) => Number.isFinite(v.price));
    if (priced.length) {
      const cheapest = priced.reduce((a, b) => (b.price < a.price ? b : a));
      d.data.price = cheapest.price;
      if (cheapest.compare && cheapest.compare > cheapest.price) d.data.compareAt = cheapest.compare;
    } else d.errors.push('No price (Variant Price).');

    const images = group
      .filter((r) => r.get('Image Src'))
      .sort((a, b) => (num(a.get('Image Position')) ?? 99) - (num(b.get('Image Position')) ?? 99));
    const image = images[0]?.get('Image Src') || g('Variant Image');
    if (image) d.data.image = image.startsWith('//') ? `https:${image}` : image;

    const status = g('Status').toLowerCase();
    d.data.active = status ? status === 'active' : bool(g('Published')) !== false;
    if (tags.length) d.data.keywords = tags.map((t) => t.toLowerCase()).filter((t) => t.length >= 2 && t.length <= 40).slice(0, 20);
    const stock = has('Variant Inventory Qty') ? variants.reduce((n, r) => n + (num(r.get('Variant Inventory Qty')) || 0), 0) : undefined;
    finishForeign(d, { colours: option(/colou?r/i), sizes: option(/size/i), stock }, true);
    return d;
  });
}

function fromWoo(rows: string[][], categories: Category[], defaults: Defaults): Draft[] {
  const { has, recs } = records(rows);
  const isVariation = (r: Rec) => /variation/i.test(r.get('Type'));
  const parents = recs.filter((r) => !isVariation(r));
  const variationsOf = (p: Rec) =>
    recs.filter((r) => isVariation(r) && [`id:${p.get('ID')}`, p.get('SKU')].filter((x) => x && x !== 'id:').includes(r.get('Parent')));
  const attribute = (rs: Rec[], re: RegExp) => {
    const out: string[] = [];
    for (const r of rs)
      for (let n = 1; n <= 6; n++) if (re.test(r.get(`Attribute ${n} name`))) out.push(...splitList(r.get(`Attribute ${n} value(s)`), ','));
    return unique(out);
  };
  return parents.map((p) => {
    const d: Draft = { line: p.line, name: p.get('Name'), data: {}, warnings: [], errors: [] };
    d.data.name = d.name;
    d.slug = slugify(d.name);
    d.data.slug = d.slug;
    const text = htmlToText(p.get('Description')) || htmlToText(p.get('Short description'));
    if (text) d.data.description = description(text, d.warnings);
    const cats = splitList(p.get('Categories'), ',');
    const leaves = cats.map((c) => c.split('>').at(-1)!.trim());
    const tags = splitList(p.get('Tags'), ',');
    const kind = guessKind([...leaves, ...cats, ...tags, d.name], categories, defaults, d.warnings, d.errors);
    Object.assign(d.data, kind);
    d.data.gender = guessGender([...cats, ...tags, d.name], defaults.gender);
    d.data.label = (leaves[0] || (kind.type as string) || 'New').slice(0, 30);

    const vars = variationsOf(p);
    const priced = (vars.length ? vars : [p])
      .map((r) => ({ regular: num(r.get('Regular price')), sale: num(r.get('Sale price')) }))
      .map((v) => ({ price: v.sale ?? v.regular, compare: v.sale !== undefined ? v.regular : undefined }))
      .filter((v) => v.price !== undefined && Number.isFinite(v.price));
    if (priced.length) {
      const cheapest = priced.reduce((a, b) => (b.price! < a.price! ? b : a));
      d.data.price = cheapest.price;
      if (cheapest.compare && cheapest.compare > cheapest.price!) d.data.compareAt = cheapest.compare;
    } else d.errors.push('No price (Regular price).');

    const image = splitList(p.get('Images'), ',')[0];
    if (image) d.data.image = image;
    d.data.active = p.get('Published') === '' ? true : p.get('Published') === '1';
    if (bool(p.get('Is featured?'))) d.data.isNew = true;
    if (tags.length) d.data.keywords = tags.map((t) => t.toLowerCase()).filter((t) => t.length >= 2 && t.length <= 40).slice(0, 20);
    const stockOf = (r: Rec) => num(r.get('Stock'));
    const counted = (vars.length ? vars : [p]).map(stockOf).filter((n) => n !== undefined && Number.isFinite(n)) as number[];
    const stock = has('Stock') && counted.length ? counted.reduce((a, b) => a + b, 0) : undefined;
    finishForeign(d, { colours: attribute([p, ...vars], /colou?r/i), sizes: attribute([p, ...vars], /size/i), stock }, true);
    return d;
  });
}

/** Reads a CSV into drafts. Throws an Error with a shopper-readable message when the file can't be used at all. */
export function readProducts(text: string, categories: Category[], defaults: Defaults = {}) {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new Error('The file has no product rows.');
  const format = detectFormat(rows[0]);
  if (!format) throw new Error('Unrecognised columns. Use Cartly’s template (Export → Template), or a Shopify or WooCommerce product export.');
  if (rows.length - 1 > MAX_ROWS) throw new Error(`At most ${MAX_ROWS.toLocaleString('en')} rows at a time: split the file.`);
  const drafts = format === 'cartly' ? fromCartly(rows, categories, defaults) : format === 'shopify' ? fromShopify(rows, categories, defaults) : fromWoo(rows, categories, defaults);
  // The same product twice in one file: the first one counts.
  const seen = new Map<string, number>();
  for (const d of drafts) {
    const key = d.id !== undefined ? `id:${d.id}` : `slug:${d.slug}`;
    if (seen.has(key)) d.errors.push(`Same product as line ${seen.get(key)}: skipped.`);
    else seen.set(key, d.line);
  }
  return { format, drafts };
}

/** One product as a row of Cartly's columns. */
export function productRow(p: Record<string, unknown>) {
  const list = (v: unknown) => ((v as string[] | null) ?? []).join(LIST_SEP);
  return COLUMNS.map((c) => {
    const v = p[c === 'category' ? 'categorySlug' : c];
    if (c === 'colors') return ((v as { name: string; hex: string }[] | null) ?? []).map((x) => `${x.name}:${x.hex}`).join(LIST_SEP);
    if (Array.isArray(v)) return list(v);
    if (c === 'price' || c === 'compareAt') return v == null ? '' : Number(v).toFixed(2);
    return v ?? '';
  });
}

/** The template's example row: every column filled in the way the import reads it. */
export const EXAMPLE = {
  id: '',
  slug: 'linen-panjabi-sage',
  name: 'Linen Panjabi in Sage',
  categorySlug: 'clothing-shoes',
  type: 'Clothing',
  gender: 'men',
  label: 'Festive',
  price: 54,
  compareAt: 64,
  stock: 25,
  active: true,
  isNew: true,
  image: 'https://images.unsplash.com/photo-1610030469983-98e550d6193c?w=1200',
  colors: [{ name: 'Sage', hex: '#9caf88' }, { name: 'Ivory', hex: '#fffff0' }],
  sizes: ['S', 'M', 'L', 'XL'],
  collections: [],
  description: 'A breathable linen panjabi with a band collar and hidden placket, cut for Eid prayers, weddings and warm evenings out.',
  material: '100% linen',
  fit: 'regular',
  fitNotes: 'True to size',
  occasions: ['festive', 'wedding'],
  seasons: ['summer', 'monsoon'],
  styleTags: ['classic', 'minimal'],
  features: ['breathable linen', 'hidden placket'],
  keywords: ['panjabi', 'পাঞ্জাবি', 'kurta', 'eid'],
  careNotes: 'Hand wash cold, dry in shade',
  pairsWith: [],
  tryOnSlot: 'top',
  tryOnImage: '',
};
