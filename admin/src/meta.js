import { reactive } from 'vue'
import { get } from './api.js'

// Categories and collections change rarely; load once and refresh after content edits.
export const meta = reactive({ categories: [], collections: [], loaded: false })
let loading = null

export function loadMeta({ force = false } = {}) {
  if (meta.loaded && !force) return Promise.resolve(meta)
  loading ??= Promise.all([get('/admin/categories'), get('/admin/collections')])
    .then(([categories, collections]) => Object.assign(meta, { categories, collections, loaded: true }))
    .finally(() => (loading = null))
  return loading
}
export const categoryTitle = (slug) => meta.categories.find((c) => c.slug === slug)?.title ?? slug
