import { reactive } from 'vue'
import { api } from './api.js'
import { auth, onAuthChange } from './auth.js'

// What a signed-in shopper chose to tell the store (Account → Preferences): their sizes and fit.
// Loaded once on first use and shared, so the product page can say "you wear M, so try L".
export const prefs = reactive({ sizes: {}, fit: null, loaded: false })

let pending = null
export function loadPrefs() {
  if (!auth.user) return Promise.resolve(prefs)
  pending ??= api('/me/preferences')
    .then((p) => Object.assign(prefs, { sizes: p?.sizes ?? {}, fit: p?.fit ?? null, loaded: true }))
    .catch(() => ((pending = null), prefs))
  return pending
}
/** PreferencesCard calls this after a save, so other pages see the new sizes at once. */
export const setPrefs = (p) => Object.assign(prefs, { sizes: p?.sizes ?? {}, fit: p?.fit ?? null, loaded: true })

onAuthChange(() => {
  pending = null
  Object.assign(prefs, { sizes: {}, fit: null, loaded: false })
})

/**
 * The size to suggest for someone who usually wears `usual`, given how shoppers say it fits: one up when it
 * runs small, one down when it runs large. Null when their size isn't on the list or there's no size beyond it.
 */
export function suggestSize(sizes, usual, verdict) {
  if (!usual || !sizes?.length) return null
  const i = sizes.findIndex((s) => s.toLowerCase() === String(usual).toLowerCase())
  if (i < 0) return null
  const j = verdict === 'small' ? i + 1 : verdict === 'large' ? i - 1 : i
  return j >= 0 && j < sizes.length ? sizes[j] : null
}
