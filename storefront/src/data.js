import { ref } from 'vue'
// Presentation helpers and marketing imagery. Products, categories, stories and
// delivery rules come from the API: see catalog.js.
export const img = (id, w = 600) => `https://images.unsplash.com/photo-${id}?w=${w}&q=80&auto=format&fit=crop`

// Same photo, different focal crops: gives every product a small gallery.
const VIEWS = [
  { x: 0.5, y: 0.5, z: 1 },
  { x: 0.42, y: 0.45, z: 1.7 },
  { x: 0.6, y: 0.62, z: 2.3 },
  { x: 0.5, y: 0.3, z: 1.35 },
]
export const gallery = (product) =>
  product.photo
    ? VIEWS.map(
        (v) =>
          `https://images.unsplash.com/photo-${product.photo}?w=900&h=1000&q=80&auto=format&fit=crop&crop=focalpoint&fp-x=${v.x}&fp-y=${v.y}&fp-z=${v.z}`,
      )
    : [product.image]

export const money = (n) => `$${Number(n).toFixed(Number.isInteger(n) ? 0 : 2)}`

// Prices are kept in dollars (the owner's decision); shoppers in Bangladesh think in taka. Once the store's
// rate is known (GET /payments/methods, loaded after boot) product prices show in taka, with dollars as the
// small print; checkout always charges the exact taka figure the server computes.
export const bdtRate = ref(null)
const bdt = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 })
export const price = (n) => (bdtRate.value ? `৳${bdt.format(Math.round(Number(n) * bdtRate.value))}` : money(n))
/** The dollar figure to show under a taka price, or '' while prices are already in dollars. */
export const priceSub = (n) => (bdtRate.value ? money(n) : '')

// Explore-page picks shown in the Favourites card until the shopper likes something.
export const curatedFavourites = [21, 17, 6, 5, 9, 12]

export const banners = {
  promo: img('1509631179647-0177331693ae', 900),
  weekend: img('1581044777550-4cfa60707c03', 700),
  bold: img('1485968579580-b6d095142e6e', 700),
  offers: img('1494790108377-be9c29b29330', 600),
}

/** "RU" for Rahim Uddin: the avatar is the shopper's own initials, never a stock photo of someone else. */
export const initials = (name) =>
  (name ?? '')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('') || '?'
