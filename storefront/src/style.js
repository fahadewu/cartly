import { reactive } from 'vue'
import { api } from './api.js'
import { auth, onAuthChange } from './auth.js'
import { products, styles } from './catalog.js'

// The "This or that" style quiz: what the shopper picked, kept in this browser and, when signed in, on the
// account. It's what they told us, so the store may say "because you picked Minimalist". Recommendations,
// Pip and the explore page all read it from here.
const KEY = 'cartly.style.v1'
const load = () => {
  try {
    return JSON.parse(localStorage.getItem(KEY)) ?? null
  } catch {
    return null
  }
}
export const style = reactive({ picked: load()?.picked ?? [], gender: load()?.gender ?? 'all' })

function remember() {
  try {
    localStorage.setItem(KEY, JSON.stringify({ picked: style.picked, gender: style.gender }))
  } catch {}
}

/** Saves the quiz answers (best two or three styles). Signed-in shoppers keep them on their account. */
export async function saveStyle(picked, gender) {
  Object.assign(style, { picked: picked.slice(0, 3), gender })
  remember()
  if (auth.user) await api('/me/preferences', { method: 'PUT', body: { styles: style.picked } })
}
export async function forgetStyle() {
  Object.assign(style, { picked: [] })
  remember()
  if (auth.user) await api('/me/preferences', { method: 'PUT', body: { styles: [] } })
}

// An account's answers win over this browser's (they may have taken the quiz on another device).
onAuthChange(async (user) => {
  if (!user) return
  const p = await api('/me/preferences').catch(() => null)
  const saved = (p?.styles ?? []).map((s) => s.key)
  if (saved.length) {
    style.picked = saved
    remember()
  } else if (style.picked.length) api('/me/preferences', { method: 'PUT', body: { styles: style.picked } }).catch(() => {})
})

export const labelOf = (key) => styles.find((s) => s.key === key)?.label ?? key

/** How well a product matches a style: how many of the style's tags it carries. */
const match = (p, s) => p.styleTags.filter((t) => s.tags.includes(t.toLowerCase())).length
const forGender = (p, gender) => gender === 'all' || p.gender === gender || p.gender === 'unisex'
const wearable = (p) => p.inStock && ['Clothing', 'Shoes', 'Accessories'].includes(p.type)

/**
 * The quiz rounds: pairs of styles that each have at least two pieces to show for this gender, every style
 * appearing about twice, two pieces per side, never the same piece twice.
 */
export function buildRounds(gender, max = 7) {
  const pool = styles
    .map((s) => ({ ...s, items: products.filter((p) => wearable(p) && forGender(p, gender) && match(p, s)).sort((a, b) => match(b, s) - match(a, s) || b.popularity - a.popularity) }))
    .filter((s) => s.items.length >= 2)
  const used = new Set()
  const pick = (s) => {
    const two = s.items.filter((p) => !used.has(p.id)).slice(0, 2)
    two.forEach((p) => used.add(p.id))
    return two.length === 2 ? two : s.items.slice(0, 2)
  }
  const order = [...pool].sort(() => Math.random() - 0.5)
  const rounds = []
  for (let pass = 0; pass < 2 && rounds.length < max; pass++)
    for (let i = 0; i + 1 < order.length && rounds.length < max; i += 2) {
      const [a, b] = pass ? [order[i], order[(i + 3) % order.length]] : [order[i], order[i + 1]]
      if (a.key !== b.key) rounds.push([{ key: a.key, items: pick(a) }, { key: b.key, items: pick(b) }])
    }
  return rounds
}

/** Products for the styles they picked, best match first, for the result page. */
export function picksFor(keys, gender, limit = 8) {
  const chosen = styles.filter((s) => keys.includes(s.key))
  return products
    .filter((p) => p.inStock && forGender(p, gender))
    .map((p) => ({ p, score: chosen.reduce((n, s) => n + match(p, s), 0) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || b.p.popularity - a.p.popularity)
    .slice(0, limit)
    .map((x) => x.p)
}
