import type { Product, Order, OrderItem, Review } from '../generated/prisma/client.js';
import { detailGaps } from './product-details.js';
import { fitSummary } from '../catalog/fit.js';

// Prisma returns money as Decimal; the API speaks plain numbers (dollars).
const num = (v: unknown) => (v == null ? null : Number(v));

export const toProduct = (p: Product) => ({
  id: p.id,
  slug: p.slug,
  name: p.name,
  description: p.description,
  category: p.categorySlug,
  type: p.type,
  gender: p.gender,
  label: p.label,
  price: Number(p.price),
  compareAt: num(p.compareAt),
  discountPercent: p.compareAt ? Math.round((1 - Number(p.price) / Number(p.compareAt)) * 100) : 0,
  isNew: p.isNew,
  rating: p.rating,
  reviewCount: p.reviewCount,
  popularity: p.popularity,
  image: p.image,
  /** Unsplash photo id, used by the storefront to build a cropped gallery. */
  photo: p.photoId || null,
  colors: p.colors as { name: string; hex: string }[],
  sizes: p.sizes,
  collections: p.collections,
  /**
   * Virtual try-on: where it's worn, the clean photo the AI try-on uses, and for the quick preview the
   * item cut out on a transparent background (or where it sits in the photo, to cut it out on-device).
   */
  tryOn: p.tryOnSlot
    ? {
        slot: p.tryOnSlot,
        image: p.tryOnImage ?? null,
        cutout: p.tryOnCutout ?? null,
        crop: ((p.tryOnInfo ?? {}) as { crop?: number[] }).crop ?? null,
      }
    : null,
  /** What it's made of, how it fits and what it's for (Pip and search use these too). */
  material: p.material,
  fit: p.fit,
  fitNotes: p.fitNotes,
  features: p.features,
  careNotes: p.careNotes,
  occasions: p.occasions,
  seasons: p.seasons,
  styleTags: p.styleTags,
  pairsWith: p.pairsWith,
  /** How it really fits, from shoppers' fit reviews and size returns (null until someone says). */
  fitFeedback: fitSummary(p.fitVotes, p.fitVerdict),
  inStock: p.stock > 0,
  /** Set when only a few are left, so the storefront can say "Only 3 left". */
  lowStock: p.stock > 0 && p.stock <= 5 ? p.stock : null,
});

/** Everything an admin needs, including stock and archive state. */
export const toAdminProduct = (p: Product) => ({
  ...toProduct(p),
  stock: p.stock,
  active: p.active,
  tryOnSlot: p.tryOnSlot,
  tryOnImage: p.tryOnImage,
  tryOnInfo: p.tryOnInfo,
  tryOnCutout: p.tryOnCutout,
  keywords: p.keywords,
  /** What Pip still needs to know (required gaps block saving; suggested ones improve answers). */
  details: detailGaps(p),
  createdAt: p.createdAt,
  updatedAt: p.updatedAt,
});

export const toReview = (r: Review) => ({
  id: r.id,
  author: r.author,
  rating: r.rating,
  title: r.title,
  text: r.text,
  /** Only when the reviewer had a delivered order with the product. */
  verified: r.verified,
  size: r.size,
  fit: r.fit,
  heightCm: r.heightCm,
  usualSize: r.usualSize,
  photos: r.photos,
  createdAt: r.createdAt,
});

export const toOrder = (o: Order & { items: OrderItem[] }) => ({
  id: o.id,
  status: o.status,
  createdAt: o.createdAt,
  updatedAt: o.updatedAt,
  subtotal: Number(o.subtotal),
  discount: Number(o.discount),
  shipping: Number(o.shipping),
  total: Number(o.total),
  promoCode: o.promoCode,
  delivery: o.delivery,
  address: o.address,
  cardLast4: o.cardLast4,
  payment: {
    method: o.paymentMethod,
    status: o.paymentStatus,
    /** What's charged in taka, and the rate it was worked out at (not set for the demo card). */
    amountBdt: num(o.amountBdt),
    usdToBdt: num(o.exchangeRate),
  },
  items: o.items.map((i) => ({
    productId: i.productId,
    name: i.name,
    image: i.image,
    price: Number(i.price),
    qty: i.qty,
    color: i.color,
    size: i.size,
  })),
});
