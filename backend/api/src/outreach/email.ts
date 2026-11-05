// Outreach emails: the words (English and Bangla), the HTML and plain text, and the SMTP sender.
// renderEmail is pure (email.spec.ts). The copy says what the email is about ("back in stock", "you were looking
// for something like this"), never what the store assumes about the shopper (taste, age, colouring).
import nodemailer, { type Transporter } from 'nodemailer';
import { env } from '../config.js';

export const KINDS = ['found_it', 'back_in_stock', 'price_drop', 'cart', 'picked_for_you'] as const;
export type Kind = (typeof KINDS)[number];
/** When one email could be several kinds, the most useful one leads. */
export const PRIORITY: Record<Kind, number> = { found_it: 5, back_in_stock: 4, price_drop: 3, cart: 2, picked_for_you: 1 };
export const KIND_LABEL: Record<Kind, string> = {
  found_it: 'We found what they looked for',
  back_in_stock: 'Back in stock',
  price_drop: 'Price dropped',
  cart: 'Left in their bag',
  picked_for_you: 'New in, picked for them',
};

export interface EmailProduct {
  id: number;
  name: string;
  image: string;
  price: number;
  compareAt: number | null;
  /** For a price drop: what it cost before. */
  was?: number | null;
}
export interface EmailInput {
  kind: Kind;
  lang: string;
  name: string;
  products: EmailProduct[];
  /** Taka per dollar (store setting), to show both. */
  rate: number | null;
  link: (productId: number) => string;
  unsubscribeUrl: string;
  storeName?: string;
}

const WORDS = {
  en: {
    hi: (n: string) => `Hi ${n},`,
    intro: {
      found_it: 'You were looking for something like this. It’s here now:',
      back_in_stock: 'Good news: it’s back in stock.',
      price_drop: 'Something you liked costs less now.',
      cart: 'You left these in your bag. They’re still waiting for you.',
      picked_for_you: 'New in, and we think you’ll like these:',
    },
    subject: {
      found_it: (p: string) => `We found it: ${p}`,
      back_in_stock: (p: string) => `${p} is back in stock`,
      price_drop: (p: string, price: string) => `${p} is now ${price}`,
      cart: (p: string) => `Still thinking about ${p}?`,
      picked_for_you: () => 'New in, picked for you',
    },
    more: (n: number) => ` and ${n} more`,
    see: 'See it',
    was: 'was',
    footer: (store: string) => `You’re getting this because you turned on emails from ${store}.`,
    unsubscribe: 'Unsubscribe',
  },
  bn: {
    hi: (n: string) => `হ্যালো ${n},`,
    intro: {
      found_it: 'আপনি এমন কিছু খুঁজছিলেন। এখন এটা আমাদের কাছে আছে:',
      back_in_stock: 'সুখবর: এটা আবার স্টকে এসেছে।',
      price_drop: 'আপনার পছন্দের জিনিসটির দাম কমেছে।',
      cart: 'আপনার ব্যাগে এগুলো রয়ে গেছে। এখনো আপনার জন্য অপেক্ষা করছে।',
      picked_for_you: 'নতুন এসেছে, আমাদের মনে হয় এগুলো আপনার ভালো লাগবে:',
    },
    subject: {
      found_it: (p: string) => `পেয়ে গেছি: ${p}`,
      back_in_stock: (p: string) => `${p} আবার স্টকে এসেছে`,
      price_drop: (p: string, price: string) => `${p} এখন ${price}`,
      cart: (p: string) => `${p} নিয়ে এখনো ভাবছেন?`,
      picked_for_you: () => 'আপনার জন্য বাছাই করা নতুন পণ্য',
    },
    more: (n: number) => ` এবং আরও ${n}টি`,
    see: 'দেখুন',
    was: 'আগে',
    footer: (store: string) => `আপনি ${store}-এর ইমেইল চালু করেছেন বলে এটি পাচ্ছেন।`,
    unsubscribe: 'আনসাবস্ক্রাইব করুন',
  },
};

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const usd = (n: number) => `$${n.toFixed(n % 1 ? 2 : 0)}`;
const taka = (n: number, rate: number | null) => (rate ? `৳${Math.round(n * rate).toLocaleString('en-US')}` : '');
const price = (n: number, rate: number | null) => [usd(n), taka(n, rate)].filter(Boolean).join(' · ');
const firstName = (name: string) => name.trim().split(/\s+/)[0] || name;

export function renderEmail(e: EmailInput) {
  const w = e.lang === 'bn' ? WORDS.bn : WORDS.en;
  const store = e.storeName ?? 'Cartly';
  const [first, ...rest] = e.products;
  const lead = first.name + (rest.length ? w.more(rest.length) : '');
  const subject = (w.subject[e.kind] as (p: string, price: string) => string)(lead, usd(first.price));

  const card = (p: EmailProduct) => {
    const before = p.was ?? (p.compareAt && p.compareAt > p.price ? p.compareAt : null);
    return `
      <tr><td style="padding:12px 0;border-top:1px solid #eef0f2">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
          <td width="120" valign="top"><a href="${esc(e.link(p.id))}"><img src="${esc(p.image)}" width="112" height="112" alt="${esc(p.name)}" style="display:block;width:112px;height:112px;object-fit:cover;border-radius:16px;background:#f3f4f4"></a></td>
          <td valign="top" style="padding-left:14px">
            <div style="font-size:16px;font-weight:700;color:#121417">${esc(p.name)}</div>
            <div style="margin-top:6px;font-size:15px;color:#121417">${esc(price(p.price, e.rate))}${before ? ` <span style="color:#8b9098;text-decoration:line-through">${esc(w.was)} ${esc(usd(before))}</span>` : ''}</div>
            <a href="${esc(e.link(p.id))}" style="display:inline-block;margin-top:12px;padding:10px 18px;border-radius:999px;background:#1f5bff;color:#ffffff;font-weight:700;font-size:14px;text-decoration:none">${esc(w.see)}</a>
          </td>
        </tr></table>
      </td></tr>`;
  };

  const html = `<!doctype html><html lang="${e.lang === 'bn' ? 'bn' : 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:#f5f6f1;font-family:-apple-system,'Segoe UI',Roboto,'Noto Sans Bengali',sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f6f1"><tr><td align="center" style="padding:24px 12px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:24px">
    <tr><td style="padding:28px 28px 8px;font-size:22px;font-weight:800;color:#121417">${esc(store)}</td></tr>
    <tr><td style="padding:8px 28px 0;font-size:16px;line-height:1.5;color:#121417">${esc(w.hi(firstName(e.name)))}<br>${esc(w.intro[e.kind])}</td></tr>
    <tr><td style="padding:8px 28px 20px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${e.products.map(card).join('')}</table></td></tr>
    <tr><td style="padding:16px 28px 28px;font-size:12px;line-height:1.5;color:#8b9098;border-top:1px solid #eef0f2">
      ${esc(w.footer(store))} <a href="${esc(e.unsubscribeUrl)}" style="color:#8b9098">${esc(w.unsubscribe)}</a>
    </td></tr>
  </table>
</td></tr></table></body></html>`;

  const text = [
    w.hi(firstName(e.name)),
    w.intro[e.kind],
    '',
    ...e.products.flatMap((p) => [`${p.name}: ${price(p.price, e.rate)}`, e.link(p.id), '']),
    `${w.footer(store)} ${w.unsubscribe}: ${e.unsubscribeUrl}`,
  ].join('\n');
  return { subject, html, text };
}

/** SMTP_URL (smtp://user:pass@host:587, smtps://… for TLS). In Docker it's the bundled Mailpit. */
export class Mailer {
  private transport: Transporter | null = null;

  get configured() {
    return !!env.smtpUrl;
  }
  /** Where mail goes, without the password, for the admin panel. */
  get server() {
    try {
      const u = new URL(env.smtpUrl);
      return `${u.hostname}:${u.port || (u.protocol === 'smtps:' ? 465 : 587)}`;
    } catch {
      return null;
    }
  }

  async send(m: { to: string; subject: string; html: string; text: string; unsubscribeUrl: string }) {
    if (!env.smtpUrl) throw new Error('No mail server: set SMTP_URL (see .env.example).');
    this.transport ??= nodemailer.createTransport(env.smtpUrl);
    await this.transport.sendMail({
      from: env.mailFrom,
      to: m.to,
      subject: m.subject,
      html: m.html,
      text: m.text,
      // One-click unsubscribe (RFC 8058), which Gmail and Yahoo ask of bulk senders.
      list: { unsubscribe: { url: m.unsubscribeUrl, comment: 'Unsubscribe' } },
      headers: { 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
    });
  }
}
