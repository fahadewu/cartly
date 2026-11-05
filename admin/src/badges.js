import { reactive } from 'vue'
import { get } from './api.js'

// Rail counts for things that need someone: orders to ship, stock to reorder, requests to answer.
export const badges = reactive({ orders: 0, products: 0, requests: 0, payments: 0, delivery: 0, returns: 0 })
let last = 0
let pending = null

export function refreshBadges({ force = false } = {}) {
  if (!force && (pending || Date.now() - last < 8000)) return pending
  last = Date.now()
  pending = get('/admin/stats', { days: 7 })
    .then((s) => {
      badges.orders = s.orders.byStatus.PROCESSING
      badges.products = s.products.lowStock + s.products.outOfStock
      badges.requests = s.openRequests
      badges.payments = s.refundsDue ?? 0
      badges.delivery = s.deliveryProblems ?? 0
      badges.returns = s.returnsToAction ?? 0
    })
    .catch(() => {})
    .finally(() => (pending = null))
  return pending
}
