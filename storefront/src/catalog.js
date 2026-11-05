import { reactive } from 'vue'
import { api } from './api.js'

// The live catalog from the API (GET /catalog): every product on sale plus categories,
// collections, stories and delivery rules. It's loaded before the app mounts, so the
// storefront, Pip and the fitting room can all look products up synchronously, and
// refreshed when the tab comes back after a while so admin changes show up.
export const products = reactive([])
export const categories = reactive({})
export const collections = reactive({})
export const stories = reactive([])
export const delivery = reactive({ freeShippingOver: 100, options: {}, returnsDays: 30 })
export const typeDetails = reactive({})
/** Shopping styles for the style quiz: [{ key, label, tags }]. */
export const styles = reactive([])

const byId = reactive(new Map())
export const productById = (id) => byId.get(Number(id))

const replace = (target, entries) => {
  Object.keys(target).forEach((k) => delete target[k])
  Object.assign(target, entries)
}
const bySlug = (rows) => Object.fromEntries(rows.map(({ slug, ...rest }) => [slug, rest]))

let loadedAt = 0

export async function loadCatalog() {
  const c = await api('/catalog')
  products.splice(0, products.length, ...c.products)
  byId.clear()
  c.products.forEach((p) => byId.set(p.id, p))
  replace(categories, bySlug(c.categories))
  replace(collections, bySlug(c.collections))
  stories.splice(0, stories.length, ...c.stories.map((s) => ({ ...s, products: s.productIds })))
  Object.assign(delivery, c.delivery)
  replace(typeDetails, c.typeDetails)
  styles.splice(0, styles.length, ...(c.styles ?? []))
  loadedAt = Date.now()
}

/** Keeps a product object in the catalog in step with a fresher copy (e.g. a product page). */
export function updateProduct(fresh) {
  const p = byId.get(fresh.id)
  if (p) Object.keys(p).forEach((k) => k in fresh && (p[k] = fresh[k]))
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && loadedAt && Date.now() - loadedAt > 2 * 60_000) loadCatalog().catch(() => {})
  })
}
