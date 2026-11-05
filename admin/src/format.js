// Prices are kept in dollars; shoppers pay in taka at the store's rate (`taka` below).
const usd = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'USD', currencyDisplay: 'narrowSymbol' })
/** Every date and time in the panel is in the store's own time zone, the same one the analytics count days in. */
export const STORE_TZ = 'Asia/Dhaka'
const usdShort = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'USD', currencyDisplay: 'narrowSymbol', notation: 'compact', maximumFractionDigits: 1 })
const whole = new Intl.NumberFormat('en-GB')

export const money = (n) => usd.format(Number(n ?? 0))
// Taka with Bangladeshi digit grouping (1,23,456.50).
const bdt = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 })
export const taka = (n) => `৳${bdt.format(Number(n ?? 0))}`
export const moneyShort = (n) => usdShort.format(Number(n ?? 0))
export const count = (n) => whole.format(Number(n ?? 0))
export const plural = (n, one, many = `${one}s`) => `${count(n)} ${n === 1 ? one : many}`

export const date = (d) => (d ? new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: STORE_TZ }) : '—')
export const shortDate = (d) => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: STORE_TZ })
export const time = (d) => new Date(d).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: STORE_TZ })
export const dateTime = (d) => `${date(d)}, ${time(d)}`

const rtf = new Intl.RelativeTimeFormat('en-GB', { numeric: 'auto' })
export function ago(d) {
  const s = (new Date(d) - Date.now()) / 1000
  const units = [
    ['year', 31536000],
    ['month', 2592000],
    ['week', 604800],
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
  ]
  for (const [unit, size] of units) if (Math.abs(s) >= size) return rtf.format(Math.round(s / size), unit)
  return 'just now'
}

/** "+12.5%" / "−3%" / null when there is nothing to compare. */
export const change = (n) => (n == null ? null : `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n)}%`)

export const sizeLabel = (size) => (/^one size$/i.test(size) ? 'one size' : `size ${size}`)

export const title = (s) => (s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : '')

export const slugify = (s) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 80)

// Storefront colour tokens used by categories, collections and stories.
export const THEME_COLORS = [
  { token: 'var(--mint)', name: 'Mint', hex: '#b5eed3' },
  { token: 'var(--butter)', name: 'Butter', hex: '#fde8a1' },
  { token: 'var(--peach)', name: 'Peach', hex: '#ffeadd' },
  { token: 'var(--slate)', name: 'Slate', hex: '#f1f3f4' },
]
export const swatch = (color) => THEME_COLORS.find((c) => c.token === color)?.hex ?? color

export const RETURN_REASON = { TOO_SMALL: 'Too small', TOO_LARGE: 'Too large', DAMAGED: 'Damaged', WRONG_ITEM: 'Wrong item', NOT_AS_DESCRIBED: 'Not as described', QUALITY: 'Quality', CHANGED_MIND: 'Changed mind', OTHER: 'Other' }
