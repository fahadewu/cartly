import { renderEmail } from './email.js';
import { answers } from './outreach.service.js';
import { weekOf } from './insights.js';

const kurti = {
  name: 'Block Print Cotton Kurti',
  type: 'Clothing',
  label: 'Festive',
  keywords: ['kurti', 'কুর্তি'],
  styleTags: ['boho'],
  colors: [{ name: 'Indigo', hex: '#2f3c7e' }],
};

describe('answers: a product really answers what they asked for', () => {
  it('needs a shared word', () => {
    expect(answers('cotton kurti', kurti)).toBe(true);
    expect(answers('kurtis for eid', kurti)).toBe(true); // plural
    expect(answers('laptop charger', kurti)).toBe(false);
  });
  it('respects a colour they named', () => {
    expect(answers('blue kurti', kurti)).toBe(true); // indigo is in the blue family
    expect(answers('red kurti', kurti)).toBe(false);
  });
  it('matches Bangla keywords', () => {
    expect(answers('কুর্তি', kurti)).toBe(true);
  });
  it('ignores filler and price words', () => {
    expect(answers('something nice under 50', kurti)).toBe(false);
  });
});

describe('renderEmail', () => {
  const base = {
    name: 'Maya Chen',
    products: [
      { id: 7, name: 'Linen Panjabi', image: 'https://img.test/p.jpg', price: 49.5, compareAt: null, was: 64 },
      { id: 8, name: 'Kolhapuri <Sandals>', image: 'https://img.test/s.jpg', price: 30, compareAt: 40 },
    ],
    rate: 122,
    link: (id: number) => `https://api.test/api/v1/o/c/tok?p=${id}`,
    unsubscribeUrl: 'https://api.test/api/v1/o/u/unsub',
  };

  it('writes a subject per kind, with the lead product', () => {
    expect(renderEmail({ ...base, kind: 'price_drop', lang: 'en' }).subject).toBe('Linen Panjabi and 1 more is now $49.50');
    expect(renderEmail({ ...base, kind: 'back_in_stock', lang: 'en', products: [base.products[0]] }).subject).toBe('Linen Panjabi is back in stock');
    expect(renderEmail({ ...base, kind: 'found_it', lang: 'bn' }).subject).toBe('পেয়ে গেছি: Linen Panjabi এবং আরও 1টি');
  });

  it('shows dollars and taka, the old price, links and an unsubscribe link, escaped', () => {
    const { html, text } = renderEmail({ ...base, kind: 'price_drop', lang: 'en' });
    expect(html).toContain('$49.50 · ৳6,039');
    expect(html).toContain('was $64');
    expect(html).toContain('Kolhapuri &lt;Sandals&gt;');
    expect(html).not.toContain('<Sandals>');
    expect(html).toContain('https://api.test/api/v1/o/c/tok?p=8');
    expect(html).toContain('https://api.test/api/v1/o/u/unsub');
    expect(html).toContain('Hi Maya,');
    expect(text).toContain('Unsubscribe: https://api.test/api/v1/o/u/unsub');
  });

  it('never mentions what the store assumes about them', () => {
    const { html } = renderEmail({ ...base, kind: 'picked_for_you', lang: 'en' });
    expect(html).not.toMatch(/skin|tone|undertone|age|personality/i);
  });

  it('speaks Bangla', () => {
    const { html } = renderEmail({ ...base, kind: 'back_in_stock', lang: 'bn' });
    expect(html).toContain('সুখবর');
    expect(html).toContain('আনসাবস্ক্রাইব');
    expect(html).toContain('lang="bn"');
  });
});

describe('weekOf', () => {
  it('starts weeks on Monday in the store’s time zone', () => {
    // Sunday 20:00 UTC is already Monday 02:00 in Dhaka.
    expect(weekOf(new Date('2026-11-01T20:00:00Z'), 'Asia/Dhaka')).toBe('2026-11-02');
    expect(weekOf(new Date('2026-11-01T20:00:00Z'), 'UTC')).toBe('2026-10-26');
  });
});
