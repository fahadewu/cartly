import { COLUMNS, EXAMPLE, detectFormat, guessGender, htmlToText, parseCsv, productRow, readProducts, toCsv } from './import-csv.js';

const CATEGORIES = [
  { slug: 'clothing-shoes', title: 'Clothing and Shoes', types: ['Clothing', 'Shoes'] },
  { slug: 'gifts-living', title: 'Gifts and Living', types: ['Accessories', 'Home', 'Gifts'] },
];

describe('parseCsv / toCsv', () => {
  it('reads quotes, escaped quotes, line breaks inside quotes, CRLF and a BOM', () => {
    const rows = parseCsv('﻿a,b,c\r\n1,"two, with ""quotes""","line\nbreak"\r\n\r\n');
    expect(rows).toEqual([
      ['a', 'b', 'c'],
      ['1', 'two, with "quotes"', 'line\nbreak'],
    ]);
  });

  it('detects semicolon-separated files (Excel in many locales)', () => {
    expect(parseCsv('name;price\nShirt;12,50')).toEqual([
      ['name', 'price'],
      ['Shirt', '12,50'],
    ]);
  });

  it('round-trips, Bangla included, and defuses spreadsheet formulas', () => {
    const csv = toCsv([['name', 'keywords'], ['=HYPERLINK("x")', 'পাঞ্জাবি|panjabi']]);
    expect(csv.startsWith('﻿')).toBe(true);
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
    const [, row] = parseCsv(csv);
    expect(row[1]).toBe('পাঞ্জাবি|panjabi');
  });
});

describe('detectFormat', () => {
  it('tells the three formats apart', () => {
    expect(detectFormat(['Handle', 'Title', 'Body (HTML)', 'Variant Price'])).toBe('shopify');
    expect(detectFormat(['ID', 'Type', 'SKU', 'Name', 'Regular price'])).toBe('woocommerce');
    expect(detectFormat([...COLUMNS])).toBe('cartly');
    expect(detectFormat(['slug', 'price', 'stock'])).toBe('cartly');
    expect(detectFormat(['foo', 'bar'])).toBeNull();
    expect(detectFormat(['name', 'colour'])).toBeNull();
  });
});

describe('Cartly format', () => {
  it('reads back exactly what it exports', () => {
    const csv = toCsv([[...COLUMNS], productRow(EXAMPLE as unknown as Record<string, unknown>)]);
    const { format, drafts } = readProducts(csv, CATEGORIES);
    expect(format).toBe('cartly');
    const [d] = drafts;
    expect(d.errors).toEqual([]);
    expect(d.slug).toBe('linen-panjabi-sage');
    expect(d.data).toMatchObject({
      name: 'Linen Panjabi in Sage',
      category: 'clothing-shoes',
      type: 'Clothing',
      gender: 'men',
      price: 54,
      compareAt: 64,
      stock: 25,
      active: true,
      colors: [
        { name: 'Sage', hex: '#9caf88' },
        { name: 'Ivory', hex: '#fffff0' },
      ],
      sizes: ['S', 'M', 'L', 'XL'],
      occasions: ['festive', 'wedding'],
      keywords: ['panjabi', 'পাঞ্জাবি', 'kurta', 'eid'],
      tryOnSlot: 'top',
    });
  });

  it('leaves out empty cells, so an update keeps what the store has', () => {
    const { drafts } = readProducts('id,name,price,stock,material\n12,,49.5,,\n', CATEGORIES);
    expect(drafts[0].id).toBe(12);
    expect(drafts[0].data).toEqual({ price: 49.5 });
  });

  it('accepts a category by title, a colour by name, and 0 to clear a sale price', () => {
    const { drafts } = readProducts('name,category,type,price,compareAt,colors\nTee,Clothing and Shoes,clothing,10,0,Navy|Mystery\n', CATEGORIES);
    expect(drafts[0].data).toMatchObject({ category: 'clothing-shoes', type: 'Clothing', compareAt: null });
    expect(drafts[0].data.colors).toEqual([
      { name: 'Navy', hex: '#1c2a4a' },
      { name: 'Mystery', hex: '#9e9e9e' },
    ]);
    expect(drafts[0].warnings.join(' ')).toMatch(/Mystery/);
  });

  it('reads prices with currency signs, thousands separators and decimal commas', () => {
    const { drafts } = readProducts('name;price;compareAt\nA;৳1,299;"12,50"\n', CATEGORIES);
    expect(drafts[0].data).toMatchObject({ price: 1299, compareAt: 12.5 });
  });

  it('flags bad numbers, unknown categories and the same product twice', () => {
    const { drafts } = readProducts('name,slug,category,price\nA,a,clothing-shoes,cheap\nB,b,shoes-only,5\nA again,a,clothing-shoes,5\n', CATEGORIES);
    expect(drafts[0].errors.join()).toMatch(/isn’t a number/);
    expect(drafts[1].errors.join()).toMatch(/Unknown category/);
    expect(drafts[2].errors.join()).toMatch(/Same product as line 2/);
  });
});

describe('Shopify export', () => {
  const csv = [
    'Handle,Title,Body (HTML),Vendor,Product Category,Type,Tags,Published,Option1 Name,Option1 Value,Option2 Name,Option2 Value,Variant Inventory Qty,Variant Price,Variant Compare At Price,Image Src,Image Position,Status',
    'linen-shirt,Linen Shirt,"<p>A <strong>breathable</strong> linen shirt for hot days &amp; humid nights in the city.</p>",Acme,Apparel & Accessories > Clothing,Shirts,"summer, linen, Men",TRUE,Size,S,Color,White,4,30.00,40.00,https://cdn.shopify.com/a.jpg,1,active',
    'linen-shirt,,,,,,,,,M,,White,6,32.00,,,,',
    'linen-shirt,,,,,,,,,M,,Sky Blue,0,32.00,,https://cdn.shopify.com/b.jpg,2,',
    'tote,Canvas Tote,,Acme,,,,FALSE,Title,Default Title,,,2,15.00,,//cdn.shopify.com/t.jpg,1,draft',
  ].join('\n');

  it('groups variants into one product with its sizes, colours, cheapest price and total stock', () => {
    const { format, drafts } = readProducts(csv, CATEGORIES);
    expect(format).toBe('shopify');
    expect(drafts).toHaveLength(2);
    const shirt = drafts[0];
    expect(shirt.slug).toBe('linen-shirt');
    expect(shirt.data).toMatchObject({
      name: 'Linen Shirt',
      description: 'A breathable linen shirt for hot days & humid nights in the city.',
      type: 'Clothing',
      category: 'clothing-shoes',
      gender: 'men',
      label: 'Shirts',
      price: 30,
      compareAt: 40,
      stock: 10,
      sizes: ['S', 'M'],
      image: 'https://cdn.shopify.com/a.jpg',
      active: true,
      keywords: ['summer', 'linen', 'men'],
    });
    expect(shirt.data.colors).toEqual([
      { name: 'White', hex: '#ffffff' },
      { name: 'Sky Blue', hex: '#87c4ec' },
    ]);
  });

  it('defaults what Shopify doesn’t have, and says so', () => {
    const tote = readProducts(csv, CATEGORIES).drafts[1];
    expect(tote.data).toMatchObject({ type: 'Accessories', category: 'gifts-living', gender: 'unisex', active: false, sizes: ['One size'], image: 'https://cdn.shopify.com/t.jpg' });
    expect(tote.data.colors).toEqual([{ name: 'As shown', hex: '#9e9e9e' }]);
    expect(tote.warnings.join(' ')).toMatch(/guessed from “Canvas Tote”/);
  });

  it('asks for a type when it can’t tell, unless one is given', () => {
    const odd = 'Handle,Title,Variant Price\nthing,Mystery Object,5\n';
    expect(readProducts(odd, CATEGORIES).drafts[0].errors.join()).toMatch(/Can’t tell what kind of product/);
    expect(readProducts(odd, CATEGORIES, { type: 'Gifts' }).drafts[0].data).toMatchObject({ type: 'Gifts', category: 'gifts-living' });
  });
});

describe('WooCommerce export', () => {
  const csv = [
    'ID,Type,SKU,Name,Published,Is featured?,Short description,Description,Stock,Sale price,Regular price,Categories,Tags,Images,Parent,Attribute 1 name,Attribute 1 value(s),Attribute 2 name,Attribute 2 value(s)',
    '10,variable,HOOD,Cotton Hoodie,1,0,Soft,"A heavyweight cotton hoodie with a kangaroo pocket, made for cool winter mornings.",,,,"Clothing > Hoodies, Women",cosy,"https://shop.test/h1.jpg, https://shop.test/h2.jpg",,Size,"S, M",Color,"Black, Rust"',
    '11,variation,HOOD-S,Cotton Hoodie - S,1,0,,,3,35,45,,,,id:10,Size,S,Color,Black',
    '12,variation,HOOD-M,Cotton Hoodie - M,1,0,,,5,,45,,,,id:10,Size,M,Color,Rust',
    '20,simple,MUG,Clay Mug,1,1,Hand-thrown mug,,,,12,Home > Kitchen,,https://shop.test/m.jpg,,,,,',
  ].join('\n');

  it('puts variations under their parent', () => {
    const { format, drafts } = readProducts(csv, CATEGORIES);
    expect(format).toBe('woocommerce');
    expect(drafts.map((d) => d.name)).toEqual(['Cotton Hoodie', 'Clay Mug']);
    expect(drafts[0].data).toMatchObject({
      slug: 'cotton-hoodie',
      type: 'Clothing',
      gender: 'women',
      label: 'Hoodies',
      price: 35,
      compareAt: 45,
      stock: 8,
      sizes: ['S', 'M'],
      image: 'https://shop.test/h1.jpg',
      active: true,
    });
    expect(drafts[0].data.colors).toEqual([
      { name: 'Black', hex: '#111111' },
      { name: 'Rust', hex: '#b5502b' },
    ]);
  });

  it('marks a missing stock count instead of inventing one', () => {
    const mug = readProducts(csv, CATEGORIES).drafts[1];
    expect(mug.data).toMatchObject({ type: 'Home', price: 12, stock: 0, isNew: true, description: 'Hand-thrown mug' });
    expect(mug.warnings.join(' ')).toMatch(/No stock count/);
  });
});

describe('helpers', () => {
  it('turns description HTML into text', () => {
    expect(htmlToText('<ul><li>Soft</li><li>Warm &amp; light</li></ul><p>Hand&nbsp;wash</p>')).toBe('• Soft\n• Warm & light\nHand wash');
  });
  it('reads gender from wording, women before men', () => {
    expect(guessGender(['Women > Tops'], undefined)).toBe('women');
    expect(guessGender(["Men's shoes"], undefined)).toBe('men');
    expect(guessGender(['Scarves'], 'unisex')).toBe('unisex');
  });
  it('refuses files it can’t read', () => {
    expect(() => readProducts('just,some,columns\n1,2,3', CATEGORIES)).toThrow(/Unrecognised columns/);
    expect(() => readProducts('name,price\n', CATEGORIES)).toThrow(/no product rows/);
  });
});
