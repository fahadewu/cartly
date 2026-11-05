import { reactive, computed, watch } from 'vue'
import { api } from './api.js'
import { auth, onAuthChange } from './auth.js'
import { productById, delivery } from './catalog.js'
import { toast } from './toast.js'

// The shopper's cart, favourites, orders, requests and team all live in the API.
// This store mirrors them for the UI; the server does the pricing and validation.
const PREFS_KEY = 'cartly.prefs.v1'
const prefs = (() => {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY)) ?? {}
  } catch {
    return {}
  }
})()

const emptyCart = () => ({ items: [], count: 0, subtotal: 0, discount: 0, promoCode: null, shipping: 0, total: 0, freeShippingRemaining: delivery.freeShippingOver })

const state = reactive({
  cart: emptyCart(),
  liked: [],
  orders: [],
  requests: [],
  members: [],
  loaded: false,
  cartOpen: false,
  mode: prefs.mode ?? 'dashboard', // 'dashboard' | 'website'
})

watch(
  () => state.mode,
  (mode) => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify({ mode }))
    } catch {}
  },
)

// The API speaks in upper-case enums; the storefront shows them in sentence case.
const sentence = (s) => s.charAt(0) + s.slice(1).toLowerCase()
const toOrder = (o) => ({
  ...o,
  status: o.status === 'PENDING_PAYMENT' ? 'Awaiting payment' : sentence(o.status),
  date: o.createdAt,
  card: o.cardLast4,
  items: o.items.map((i) => ({ ...i, id: i.productId })),
})
export const PAY_LABEL = { bkash: 'bKash', nagad: 'Nagad', rocket: 'Rocket', card: 'Card', cod: 'Cash on delivery', demo: 'Demo card' }

// What a shopper can pay with right now (set in the admin panel), and taka per dollar.
let methodsPending = null
export const paymentMethods = () => (methodsPending ??= api('/payments/methods').catch((e) => ((methodsPending = null), Promise.reject(e))))
const toRequest = (r) => ({ ...r, status: sentence(r.status), date: r.createdAt })
const toMember = (m) => ({ ...m, role: sentence(m.role), status: sentence(m.status) })

let askSignIn = () => {}
/** Called when a guest tries something that needs an account (add to cart, like). */
export const onSignInNeeded = (fn) => (askSignIn = fn)
const signedIn = () => (auth.user ? true : (askSignIn(), false))

/** Loads the shopper's things. One dropped request on a slow connection keeps the rest, rather than failing the boot. */
export async function loadShop() {
  const got = async (path, fallback) => {
    try {
      return await api(path)
    } catch (e) {
      if (e.status === 401) throw e
      return fallback
    }
  }
  const [cart, favourites, orders, requests, team] = await Promise.all([
    got('/cart', state.cart),
    got('/me/favourites', null),
    got('/orders', null),
    got('/me/requests', null),
    got('/team', null),
  ])
  Object.assign(state, {
    cart,
    liked: favourites ? favourites.map((p) => p.id) : state.liked,
    orders: orders ? orders.map(toOrder) : state.orders,
    requests: requests ? requests.map(toRequest) : state.requests,
    members: team ? team.members.map(toMember) : state.members,
    loaded: true,
  })
}

onAuthChange((user) => {
  if (user) return loadShop()
  Object.assign(state, { cart: emptyCart(), liked: [], orders: [], requests: [], members: [], loaded: false, cartOpen: false })
})

// Cart changes run one at a time so quick taps can't arrive out of order.
let queue = Promise.resolve()
function cartOp(request) {
  const op = queue.then(request).then(
    (cart) => {
      state.cart = cart
      return true
    },
    async (e) => {
      toast(e.message, 'error')
      state.cart = await api('/cart').catch(() => state.cart)
      return false
    },
  )
  queue = op
  return op
}

const lines = computed(() =>
  state.cart.items.map((i) => ({ key: i.key, id: i.product.id, color: i.color, size: i.size, qty: i.qty, product: productById(i.product.id) ?? i.product })),
)
const cartCount = computed(() => state.cart.count)
const subtotal = computed(() => state.cart.subtotal)
const discount = computed(() => state.cart.discount)
// Same rule the server applies at checkout, so switching delivery updates instantly.
const shippingFor = (method = 'standard') =>
  !lines.value.length ? 0 : method === 'standard' && subtotal.value - discount.value >= delivery.freeShippingOver ? 0 : (delivery.options[method]?.price ?? 0)

export function useShop() {
  /** Adds to the cart; resolves true on success. Shows its own toast unless `silent`. */
  async function addToCart(product, { color, size, qty = 1 } = {}, { silent = false } = {}) {
    if (!signedIn()) return false
    color ??= product.colors[0].name
    size ??= product.sizes.length === 1 ? product.sizes[0] : product.sizes[Math.floor(product.sizes.length / 2)]
    const ok = await cartOp(() => api('/cart/items', { method: 'POST', body: { productId: product.id, color, size, qty } }))
    if (ok && !silent) toast(`${qty > 1 ? `${qty} × ` : ''}${product.name} added to cart`)
    return ok
  }

  /** Adds several products in their default colour and size, with one toast. */
  async function addAllToCart(items) {
    if (!signedIn()) return 0
    const added = (await Promise.all(items.map((p) => addToCart(p, {}, { silent: true })))).filter(Boolean).length
    if (added) toast(added === items.length ? `${added} item${added > 1 ? 's' : ''} added to cart` : `${added} of ${items.length} items added to cart`)
    return added
  }

  function changeQty(key, delta) {
    const item = state.cart.items.find((i) => i.key === key)
    if (!item) return
    const qty = Math.max(0, item.qty + delta)
    if (qty === 0) return removeLine(key)
    item.qty = qty // optimistic; the server's totals follow
    return cartOp(() => api(`/cart/items/${encodeURIComponent(key)}`, { method: 'PATCH', body: { qty } }))
  }

  function removeLine(key) {
    state.cart.items = state.cart.items.filter((i) => i.key !== key)
    return cartOp(() => api(`/cart/items/${encodeURIComponent(key)}`, { method: 'DELETE' }))
  }

  /** Resolves to an error message, or '' when the code was applied. */
  async function applyPromo(code) {
    try {
      state.cart = await api('/cart/promo', { method: 'POST', body: { code: code.trim() } })
      return ''
    } catch (e) {
      return e.message
    }
  }
  const removePromo = () => cartOp(() => api('/cart/promo', { method: 'DELETE' }))

  const isLiked = (id) => state.liked.includes(id)
  async function toggleLike(id) {
    if (!signedIn()) return
    const liked = isLiked(id)
    state.liked = liked ? state.liked.filter((x) => x !== id) : [id, ...state.liked]
    try {
      await api(`/me/favourites/${id}`, { method: liked ? 'DELETE' : 'PUT' })
    } catch (e) {
      state.liked = liked ? [id, ...state.liked] : state.liked.filter((x) => x !== id)
      toast(e.message, 'error')
    }
  }
  async function clearFavourites() {
    const ids = state.liked
    state.liked = []
    await Promise.allSettled(ids.map((id) => api(`/me/favourites/${id}`, { method: 'DELETE' })))
  }

  /**
   * Places the order from the server-side cart (which the server then empties). Throws
   * ApiError with the reason on failure. Call resetCart() once the checkout page is gone.
   */
  /** Places the order; for an online payment, `order.payment.redirectUrl` is the gateway page to go to. */
  async function placeOrder({ address, delivery: method, payment }) {
    const order = toOrder(await api('/orders', { method: 'POST', body: { address, delivery: method, payment } }))
    state.orders.unshift(order)
    return order
  }
  /** Pays for an order still awaiting payment (another try, another method, or cash on delivery). */
  async function payOrder(id, method) {
    const order = toOrder(await api(`/orders/${id}/pay`, { method: 'POST', body: { method } }))
    state.orders = state.orders.map((o) => (o.id === id ? order : o))
    return order
  }
  const resetCart = () => (state.cart = emptyCart())

  const reorder = (order) => cartOp(() => api(`/orders/${order.id}/reorder`, { method: 'POST' }))

  /** One order with its delivery tracking (the list leaves tracking out). */
  async function loadOrder(id) {
    const order = toOrder(await api(`/orders/${encodeURIComponent(id)}`))
    const i = state.orders.findIndex((o) => o.id === id)
    if (i >= 0) state.orders[i] = order
    else state.orders.unshift(order)
    return order
  }

  async function cancelOrder(id) {
    const order = toOrder(await api(`/orders/${id}/cancel`, { method: 'POST' }))
    state.orders = state.orders.map((o) => (o.id === id ? order : o))
    return order
  }

  const addReview = (productId, review) => api(`/products/${productId}/reviews`, { method: 'POST', body: review })

  async function addRequest({ product, category, size, budget, link, notes, email }) {
    const body = { product, category, email, size: size || undefined, budget: budget ? Number(budget) : undefined, link: link || undefined, notes: notes || undefined }
    state.requests.unshift(toRequest(await api('/me/requests', { method: 'POST', body })))
  }

  async function addMember({ name, email, role }) {
    state.members.push(toMember(await api('/team', { method: 'POST', body: { name, email, role: role.toUpperCase() } })))
  }
  async function updateMember(id, role) {
    const updated = toMember(await api(`/team/${id}`, { method: 'PATCH', body: { role: role.toUpperCase() } }))
    state.members = state.members.map((m) => (m.id === id ? updated : m))
  }
  async function removeMember(id) {
    await api(`/team/${id}`, { method: 'DELETE' })
    state.members = state.members.filter((m) => m.id !== id)
  }

  return {
    state,
    lines,
    cartCount,
    subtotal,
    discount,
    shippingFor,
    addToCart,
    addAllToCart,
    changeQty,
    removeLine,
    applyPromo,
    removePromo,
    isLiked,
    toggleLike,
    clearFavourites,
    placeOrder,
    payOrder,
    resetCart,
    reorder,
    cancelOrder,
    loadOrder,
    addReview,
    addRequest,
    addMember,
    updateMember,
    removeMember,
  }
}
