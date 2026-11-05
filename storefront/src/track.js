import { api, getToken } from './api.js'

// What shoppers look at and search for, sent in small batches for the store's demand analytics.
// Never gets in the way: failures are dropped silently.
const queue = []
let timer = null

function flush() {
  clearTimeout(timer)
  timer = null
  if (!queue.length || !getToken()) return (queue.length = 0)
  const events = queue.splice(0, 25)
  api('/events', { method: 'POST', body: { events }, keepSession: true }).catch(() => {})
}
function push(e) {
  queue.push(e)
  if (queue.length >= 25) flush()
  else timer ??= setTimeout(flush, 4000)
}
if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && flush())

export const trackView = (productId) => productId && push({ type: 'view', productId: Number(productId) })

// A search counts once the shopper stops typing, so "r", "re", "red" don't count as three.
let pending = null
export function trackSearch(query, results) {
  clearTimeout(pending)
  const q = String(query ?? '').trim()
  if (q.length < 2) return
  pending = setTimeout(() => push({ type: 'search', query: q, results }), 1500)
}
