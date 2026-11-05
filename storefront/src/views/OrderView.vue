<script setup>
import { computed, onMounted, onUnmounted, ref, watch, watchEffect } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import PageHeader from '../components/PageHeader.vue'
import OrderSummary from '../components/OrderSummary.vue'
import Icon from '../components/Icon.vue'
import NotFoundView from './NotFoundView.vue'
import { money } from '../data.js'
import { delivery } from '../catalog.js'
import { PAY_LABEL, paymentMethods, useShop } from '../store.js'
import { toast } from '../toast.js'
import { api } from '../api.js'

const props = defineProps({ id: { type: String, required: true } })
const route = useRoute()
const router = useRouter()
const { state, reorder, cancelOrder, payOrder, loadOrder } = useShop()

const order = computed(() => state.orders.find((o) => o.id === props.id))
watchEffect(() => {
  if (order.value) document.title = `Order ${order.value.id} · Cartly`
})

const STEPS = ['Placed', 'Processing', 'Shipped', 'Delivered']
const reached = computed(() => STEPS.indexOf(order.value.status))
const placed = computed(() => route.query.placed === '1')

/* ---------- delivery tracking ---------- */
// The latest delivery (own rider or courier), with its timeline. Refreshed every minute while it's on the way.
const shipment = computed(() => order.value?.shipment ?? null)
const FINISHED = ['DELIVERED', 'RETURNED', 'CANCELLED']
const onTheWay = computed(() => shipment.value && !FINISHED.includes(shipment.value.status))
const refresh = () => loadOrder(props.id).catch(() => {})
let poll
onMounted(() => {
  refresh()
  poll = setInterval(() => {
    if (onTheWay.value || order.value?.status === 'Processing') refresh()
  }, 60_000)
})
onUnmounted(() => clearInterval(poll))
const LEFT = ['PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'FAILED_ATTEMPT', 'RETURNING', 'DELIVERED']
const shippedAt = computed(() => shipment.value?.events.find((e) => LEFT.includes(e.status))?.at)
const SHIP_TEXT = {
  BOOKED: 'Packed, waiting for pickup',
  PICKED_UP: 'Picked up',
  IN_TRANSIT: 'On the way',
  OUT_FOR_DELIVERY: 'Out for delivery today',
  FAILED_ATTEMPT: 'Delivery attempt missed',
  RETURNING: 'Returning to us',
}
/* ---------- returns ---------- */
// Delivered orders can be sent back within the store's return window.
const REASONS = { TOO_SMALL: 'Too small', TOO_LARGE: 'Too large', DAMAGED: 'Arrived damaged', WRONG_ITEM: 'Wrong item sent', NOT_AS_DESCRIBED: 'Not as described', QUALITY: 'Quality not as expected', CHANGED_MIND: 'Changed my mind', OTHER: 'Something else' }
const RT_STATUS = { REQUESTED: 'Waiting for the store', APPROVED: 'Approved: we’ll collect it', REJECTED: 'Turned down', RECEIVED: 'Back with us: refund on its way', REFUNDED: 'Refunded', CANCELLED: 'Withdrawn' }
const returns = ref(null)
const loadReturns = () =>
  order.value?.status === 'Delivered' &&
  api(`/orders/${encodeURIComponent(props.id)}/returns`)
    .then((r) => (returns.value = r))
    .catch(() => {})
watch(() => order.value?.status, loadReturns, { immediate: true })
const rform = ref(null)
function startReturn() {
  rform.value = { qty: Object.fromEntries(returns.value.items.map((i) => [i.orderItemId, 0])), reason: '', note: '', error: '', saving: false }
}
async function sendReturn() {
  const f = rform.value
  f.error = ''
  const items = Object.entries(f.qty).filter(([, n]) => n > 0).map(([orderItemId, qty]) => ({ orderItemId, qty: Number(qty) }))
  if (!items.length) return (f.error = 'Choose what you’re sending back.')
  if (!f.reason) return (f.error = 'Tell us why.')
  if (f.reason === 'OTHER' && !f.note.trim()) return (f.error = 'Tell us a little about why.')
  f.saving = true
  try {
    await api(`/orders/${encodeURIComponent(props.id)}/returns`, { method: 'POST', body: { items, reason: f.reason, note: f.note.trim() || undefined } })
    rform.value = null
    toast('Return requested. We’ll let you know once it’s approved.')
    loadReturns()
  } catch (e) {
    f.error = e.message
  } finally {
    f.saving = false
  }
}
async function withdraw(rt) {
  try {
    await api(`/returns/${rt.id}/cancel`, { method: 'POST' })
    toast('Return withdrawn')
    loadReturns()
  } catch (e) {
    toast(e.message)
  }
}

const fmtTime = (d) => new Date(d).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

const day = 864e5
const fmt = (d) => new Date(d).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })
const stepDate = (i) => {
  // Real dates once the parcel is moving; before that, the usual timings.
  if (i < 2 && i <= reached.value) return fmt(order.value.date) // placed, and processed from then
  if (i === 2 && shippedAt.value) return fmt(shippedAt.value)
  if (i === 3 && shipment.value?.deliveredAt) return fmt(shipment.value.deliveredAt)
  const base = new Date(order.value.date).getTime()
  const offsets = [0, 0.2, 1.5, order.value.delivery === 'express' ? 2 : 4]
  return fmt(base + offsets[i] * day)
}
const eta = computed(() => {
  const base = new Date(order.value.date).getTime()
  return fmt(base + (order.value.delivery === 'express' ? 2 : 5) * day)
})

async function buyAgain() {
  if (!(await reorder(order.value))) return
  toast('Items added to your cart')
  state.cartOpen = true
}

// Orders can be cancelled until they ship; the items go back into stock.
const confirmCancel = ref(false)
const cancelling = ref(false)
async function cancel() {
  cancelling.value = true
  try {
    await cancelOrder(order.value.id)
    toast(`Order ${order.value.id} cancelled`)
  } catch (e) {
    toast(e.message)
  } finally {
    cancelling.value = false
    confirmCancel.value = false
  }
}
function dismiss() {
  router.replace({ query: {} })
}

/* ---------- payment ---------- */
const taka = (n) => `৳${new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 }).format(n)}`
// Back from bKash, Nagad or SSLCommerz: ?payment=success|cancelled|failed|pending|expired
const returned = computed(() => route.query.payment)
const awaiting = computed(() => order.value?.status === 'Awaiting payment')
const retryMethods = ref([])
if (typeof window !== 'undefined') {
  paymentMethods()
    .then((r) => (retryMethods.value = r.methods.filter((m) => m.id !== 'demo')))
    .catch(() => {})
}
const paying = ref('')
const payError = ref('')
async function payWith(m) {
  paying.value = m.id
  payError.value = ''
  try {
    const o = await payOrder(order.value.id, m.id)
    if (o.payment.redirectUrl) return window.location.assign(o.payment.redirectUrl)
    router.replace({ query: {} })
    toast(m.id === 'cod' ? 'Done: you’ll pay the courier on delivery' : 'Order updated')
  } catch (e) {
    payError.value = e.message
  }
  paying.value = ''
}
const paymentText = computed(() => {
  const p = order.value.payment
  if (!p) return ''
  if (p.method === 'cod') return p.status === 'PAID' ? 'Paid on delivery' : `Pay ${taka(p.amountBdt)} on delivery`
  if (p.status === 'PAID') return `Paid ${p.amountBdt != null ? taka(p.amountBdt) : money(order.value.total)}`
  if (p.status === 'REFUNDED') return 'Refunded'
  return p.amountBdt != null ? `${taka(p.amountBdt)} · ${p.status.toLowerCase()}` : ''
})
</script>

<template>
  <NotFoundView v-if="!order" />
  <div v-else>
    <PageHeader
      :title="`Order ${order.id}`"
      :subtitle="`Placed ${new Date(order.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}`"
      :crumbs="[{ label: 'Explore', to: '/' }, { label: 'Orders', to: '/orders' }, { label: order.id }]"
    >
      <span class="status" :class="order.status.toLowerCase()">{{ order.status }}</span>
      <template v-if="(order.status === 'Processing' && !onTheWay) || awaiting">
        <template v-if="confirmCancel">
          <button class="btn-secondary sm danger" :disabled="cancelling" @click="cancel">{{ cancelling ? 'Cancelling…' : 'Yes, cancel order' }}</button>
          <button class="btn-secondary sm" :disabled="cancelling" @click="confirmCancel = false">Keep order</button>
        </template>
        <button v-else class="btn-secondary sm" @click="confirmCancel = true">Cancel order</button>
      </template>
      <button class="btn-primary sm" @click="buyAgain"><Icon name="bag" :size="16" />Buy again</button>
    </PageHeader>

    <div class="page">
      <div v-if="returned === 'success'" class="thanks">
        <span class="tick"><Icon name="check" :size="26" /></span>
        <div>
          <h2>Payment received, thank you!</h2>
          <p>Your order is confirmed and we’ll let you know when it ships. Estimated delivery: <b>{{ eta }}</b>.</p>
        </div>
        <button class="icon-btn" aria-label="Dismiss" @click="dismiss"><Icon name="close" :size="18" /></button>
      </div>
      <div v-else-if="returned === 'pending'" class="thanks pending">
        <div>
          <h2>We’re confirming your payment</h2>
          <p>This can take a minute. Refresh this page shortly; nothing is charged twice if you try again.</p>
        </div>
      </div>
      <section v-if="awaiting" class="box pay-box">
        <h2>{{ returned && returned !== 'pending' ? 'The payment didn’t go through' : 'Waiting for your payment' }}</h2>
        <p>Your items are held for a little while. Pay with any of these to confirm the order, or cancel it.</p>
        <div class="pay-methods">
          <button v-for="m in retryMethods" :key="m.id" class="pay-method" :class="m.id" :disabled="!!paying" @click="payWith(m)">
            {{ paying === m.id ? 'One moment…' : m.id === 'cod' ? 'Cash on delivery instead' : `Pay ${taka(order.payment.amountBdt)} with ${m.label}` }}
          </button>
        </div>
        <p v-if="payError" class="form-alert error" role="alert"><Icon name="alert" :size="16" />{{ payError }}</p>
      </section>
      <div v-if="placed" class="thanks">
        <span class="tick"><Icon name="check" :size="26" /></span>
        <div>
          <h2>Thank you, your order is confirmed!</h2>
          <p>We’ve emailed a receipt and will let you know when it ships. Estimated delivery: <b>{{ eta }}</b>.</p>
        </div>
        <button class="icon-btn" aria-label="Dismiss" @click="dismiss"><Icon name="close" :size="18" /></button>
      </div>

      <section v-if="order.status === 'Cancelled'" class="box track cancelled-note">
        <h2>Order cancelled</h2>
        <p>
          This order was cancelled and won’t be shipped.
          {{ order.payment?.status === 'PAID' && order.payment.method !== 'demo' ? 'Your payment will be refunded to the account you paid from.' : order.payment?.status === 'REFUNDED' ? 'Your payment has been refunded.' : 'Nothing was charged.' }}
        </p>
      </section>
      <section v-else-if="!awaiting" class="box track">
        <h2>Tracking</h2>
        <ol class="timeline">
          <li v-for="(s, i) in STEPS" :key="s" :class="{ done: i <= reached, current: i === reached }">
            <span class="node"><Icon v-if="i <= reached" name="check" :size="14" /></span>
            <b>{{ s }}</b>
            <small>{{ i <= reached ? stepDate(i) : i === 3 ? `Est. ${eta}` : 'Pending' }}</small>
          </li>
        </ol>

        <div v-if="shipment && shipment.status !== 'CANCELLED'" class="parcel">
          <div class="parcel-head">
            <span class="truck"><Icon name="truck" :size="20" /></span>
            <div>
              <b>{{ shipment.rider ? `${shipment.rider.name} is bringing your order` : shipment.status === 'DELIVERED' ? `Delivered by ${shipment.carrierName}` : `With ${shipment.carrierName}` }}</b>
              <small>{{ SHIP_TEXT[shipment.status] ?? (shipment.status === 'DELIVERED' ? `Delivered ${fmtTime(shipment.deliveredAt)}` : 'Returned to us') }}</small>
            </div>
            <a v-if="shipment.rider" class="btn-secondary sm call" :href="`tel:${shipment.rider.phone}`"><Icon name="phone" :size="16" />Call {{ shipment.rider.name.split(' ')[0] }}</a>
          </div>

          <div v-if="shipment.deliveryCode" class="code-box">
            <span>Your delivery code</span>
            <strong>{{ shipment.deliveryCode }}</strong>
            <small>Tell it to the rider when they hand you the parcel, not before. It confirms you received it.</small>
          </div>
          <p v-if="onTheWay && shipment.codAmount" class="cod-note">Please have <b>{{ taka(shipment.codAmount) }}</b> ready in cash.</p>
          <p v-if="shipment.trackingCode" class="track-code">
            {{ shipment.carrierName }} tracking code: <b>{{ shipment.trackingCode }}</b>
            <a v-if="shipment.trackingUrl" :href="shipment.trackingUrl" target="_blank" rel="noopener">Track on {{ shipment.carrierName }}</a>
          </p>

          <ol v-if="shipment.events.length" class="events">
            <li v-for="(e, i) in [...shipment.events].reverse()" :key="i" :class="{ latest: i === 0 }">
              <span class="dot" />
              <span>{{ e.message }}</span>
              <small>{{ fmtTime(e.at) }}</small>
            </li>
          </ol>
        </div>
      </section>

      <section v-if="returns && (returns.open || returns.returns.length)" class="box returns-box">
        <div class="rt-head">
          <h2>Returns</h2>
          <button v-if="returns.open && !rform" class="btn-secondary sm" @click="startReturn">Return items</button>
        </div>
        <p v-if="returns.open && !rform" class="muted-line">You can send items back until {{ new Date(returns.until).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' }) }} ({{ returns.windowDays }} days from delivery).</p>
        <form v-if="rform" class="rt-form" novalidate @submit.prevent="sendReturn">
          <p v-if="rform.error" class="form-alert error" role="alert"><Icon name="alert" :size="16" />{{ rform.error }}</p>
          <div v-for="i in returns.items.filter((x) => x.returnable)" :key="i.orderItemId" class="rt-item">
            <img :src="i.image" alt="" />
            <span>{{ i.name }}<small>{{ i.color }} · {{ i.size === 'One size' ? i.size : `Size ${i.size}` }}</small></span>
            <label>Qty
              <select v-model.number="rform.qty[i.orderItemId]">
                <option v-for="n in i.returnable + 1" :key="n" :value="n - 1">{{ n - 1 }}</option>
              </select>
            </label>
          </div>
          <label class="rt-field">Why are you returning it?
            <select v-model="rform.reason"><option value="" disabled>Choose a reason</option><option v-for="(label, k) in REASONS" :key="k" :value="k">{{ label }}</option></select>
          </label>
          <label class="rt-field">Anything else? <small>(optional)</small>
            <textarea v-model="rform.note" rows="2" maxlength="500" placeholder="e.g. the sleeves are short" />
          </label>
          <div class="rt-buttons">
            <button type="button" class="btn-secondary sm" @click="rform = null">Cancel</button>
            <button class="btn-primary sm" :disabled="rform.saving">{{ rform.saving ? 'Sending…' : 'Request return' }}</button>
          </div>
        </form>
        <ul v-if="returns.returns.length" class="rt-list">
          <li v-for="rt in returns.returns" :key="rt.id">
            <div>
              <b>{{ rt.items.map((i) => `${i.qty} × ${i.name}`).join(', ') }}</b>
              <small>{{ RT_STATUS[rt.status] }}<template v-if="rt.status === 'REJECTED' && rt.storeNote">: {{ rt.storeNote }}</template> · refund {{ rt.refundBdt != null ? taka(rt.refundBdt) : money(rt.refundUsd) }}</small>
            </div>
            <button v-if="rt.status === 'REQUESTED' || rt.status === 'APPROVED'" class="btn-secondary sm" @click="withdraw(rt)">Withdraw</button>
          </li>
        </ul>
      </section>

      <div class="layout">
        <section class="box">
          <h2>Items</h2>
          <ul class="items">
            <li v-for="i in order.items" :key="i.id + i.size + i.color">
              <RouterLink :to="`/product/${i.id}`" class="thumb"><img :src="i.image" :alt="i.name" /></RouterLink>
              <div class="i-text">
                <RouterLink :to="`/product/${i.id}`">{{ i.name }}</RouterLink>
                <small>{{ i.color }} · {{ i.size === 'One size' ? i.size : `Size ${i.size}` }} · Qty {{ i.qty }}</small>
              </div>
              <b>{{ money(i.price * i.qty) }}</b>
            </li>
          </ul>
        </section>

        <aside class="side">
          <section class="box">
            <h2>Summary</h2>
            <OrderSummary :subtotal="order.subtotal" :discount="order.discount" :shipping="order.shipping" :total="order.total" />
          </section>
          <section class="box details">
            <div>
              <h3>Delivery</h3>
              <p>
                {{ order.address.name }}<br />{{ order.address.street }}<br />{{ order.address.city }} {{ order.address.postal }}<br />{{ order.address.country }}
                <template v-if="order.address.phone"><br />{{ order.address.phone }}</template>
              </p>
              <small>{{ delivery.options[order.delivery]?.label }} · {{ delivery.options[order.delivery]?.eta }}</small>
            </div>
            <div>
              <h3>Payment</h3>
              <p v-if="order.card" class="card"><span>VISA</span>•••• {{ order.card }}</p>
              <p v-else>{{ PAY_LABEL[order.payment?.method] ?? 'Card' }}</p>
              <small v-if="paymentText">{{ paymentText }}</small>
            </div>
          </section>
        </aside>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pay-box {
  margin-bottom: 18px;
  border: 2px solid var(--peach, #ffd7b8);
}
.pay-box p {
  margin: 6px 0 14px;
  color: var(--muted);
}
.pay-methods {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}
.pay-method {
  padding: 12px 18px;
  border: 0;
  border-radius: 999px;
  background: var(--ink, #121417);
  color: #fff;
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}
.pay-method.bkash {
  background: #e2136e;
}
.pay-method.nagad {
  background: #ed1c24;
}
.pay-method.rocket {
  background: #8c3494;
}
.pay-method.cod {
  background: transparent;
  color: var(--ink, #121417);
  box-shadow: inset 0 0 0 2px var(--line, #e3e6df);
}
.pay-method:disabled {
  opacity: 0.6;
}
.thanks.pending {
  background: var(--butter, #fde8a1);
}
.danger {
  color: #b42318;
}
.cancelled-note p {
  margin: 0;
  color: var(--muted);
}
.thanks {
  display: flex;
  align-items: center;
  gap: 18px;
  padding: 24px 28px;
  margin-bottom: 18px;
  border-radius: var(--r-card);
  background: var(--mint);
}
.tick {
  display: grid;
  place-items: center;
  flex-shrink: 0;
  width: 56px;
  height: 56px;
  border-radius: 50%;
  background: #fff;
  color: #067647;
}
.thanks div {
  flex: 1;
}
.thanks h2 {
  font-size: 20px;
  font-weight: 600;
}
.thanks p {
  margin-top: 4px;
  font-size: 14px;
}

.track {
  margin-bottom: 18px;
}
.returns-box {
  margin-bottom: 18px;
}
.rt-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.muted-line {
  margin: 6px 0 0;
  color: var(--muted);
  font-size: 14px;
}
.rt-form {
  display: grid;
  gap: 14px;
  margin-top: 14px;
}
.rt-item {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 14px;
}
.rt-item img {
  width: 48px;
  height: 48px;
  border-radius: 10px;
  object-fit: cover;
}
.rt-item span {
  display: grid;
  flex: 1;
}
.rt-item small,
.rt-list small {
  color: var(--muted);
  font-size: 13px;
}
.rt-field {
  display: grid;
  gap: 6px;
  font-size: 14px;
  font-weight: 500;
}
.rt-form select,
.rt-form textarea {
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: #fff;
  font: inherit;
}
.rt-buttons {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.rt-list {
  display: grid;
  gap: 10px;
  margin: 14px 0 0;
  padding: 0;
  list-style: none;
}
.rt-list li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.rt-list li > div {
  display: grid;
  font-size: 14px;
}
.parcel {
  display: grid;
  gap: 14px;
  margin-top: 26px;
  padding-top: 20px;
  border-top: 1px solid var(--line);
}
.parcel-head {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.parcel-head > div {
  display: grid;
  flex: 1;
  min-width: 180px;
}
.parcel-head small,
.events small {
  color: var(--muted);
  font-size: 13px;
}
.truck {
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: var(--blue-soft);
  color: var(--blue);
}
.call {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  text-decoration: none;
}
.code-box {
  display: grid;
  justify-items: start;
  gap: 2px;
  padding: 14px 16px;
  border-radius: 14px;
  background: var(--butter, #fde8a1);
  color: #1d2126;
}
.code-box span {
  font-size: 13px;
  font-weight: 600;
}
.code-box strong {
  font-size: 30px;
  letter-spacing: 0.3em;
  font-variant-numeric: tabular-nums;
}
.code-box small {
  font-size: 13px;
}
.cod-note,
.track-code {
  margin: 0;
  font-size: 14px;
}
.track-code a {
  margin-left: 8px;
}
.events {
  display: grid;
  gap: 10px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.events li {
  position: relative;
  display: grid;
  grid-template-columns: 14px 1fr;
  column-gap: 10px;
  font-size: 14px;
}
.events li:not(:last-child)::before {
  content: '';
  position: absolute;
  left: 4px;
  top: 14px;
  bottom: -12px;
  width: 2px;
  background: var(--line);
}
.events .dot {
  grid-row: span 2;
  width: 10px;
  height: 10px;
  margin-top: 5px;
  border-radius: 50%;
  background: var(--line);
}
.events .latest .dot {
  background: var(--blue);
}
.events .latest span:not(.dot) {
  font-weight: 600;
}
.timeline {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  margin: 0;
  padding: 0;
  list-style: none;
}
.timeline li {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-top: 44px;
}
.timeline li::before {
  content: '';
  position: absolute;
  top: 14px;
  left: 0;
  right: 0;
  height: 4px;
  background: var(--line);
}
.timeline li:first-child::before {
  left: 14px;
}
.timeline li:last-child::before {
  right: auto;
  width: 14px;
}
.timeline li.done::before {
  background: var(--blue);
}
.node {
  position: absolute;
  top: 0;
  left: 0;
  z-index: 1;
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border: 3px solid #fff;
  border-radius: 50%;
  background: var(--line);
  color: #fff;
}
.done .node {
  background: var(--blue);
}
.current .node {
  box-shadow: 0 0 0 5px var(--blue-soft);
}
.timeline b {
  font-size: 14px;
  font-weight: 500;
}
.timeline small {
  font-size: 13px;
  color: var(--muted);
}

.layout {
  display: grid;
  grid-template-columns: 1fr 380px;
  gap: 18px;
  align-items: start;
}
.side {
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.items {
  margin: 0;
  padding: 0;
  list-style: none;
}
.items li {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 14px 0;
  border-bottom: 1px solid var(--line);
}
.items li:last-child {
  border-bottom: 0;
}
.thumb {
  flex-shrink: 0;
  width: 80px;
  height: 80px;
  border-radius: 20px;
  background: var(--card);
  overflow: hidden;
}
.thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  mix-blend-mode: multiply;
}
.i-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.i-text a {
  font-weight: 500;
  color: inherit;
  text-decoration: none;
}
.i-text a:hover {
  color: var(--blue);
}
.i-text small {
  font-size: 13px;
  color: var(--muted);
}
.details {
  display: flex;
  flex-direction: column;
  gap: 20px;
}
.details h3 {
  margin-bottom: 8px;
  font-size: 14px;
  font-weight: 600;
}
.details p {
  font-size: 14px;
  line-height: 1.6;
}
.details small {
  display: block;
  margin-top: 6px;
  font-size: 13px;
  color: var(--muted);
}
.card {
  display: flex;
  align-items: center;
  gap: 10px;
}
.card span {
  padding: 3px 8px;
  border-radius: 6px;
  background: #1a1f71;
  color: #fff;
  font-size: 11px;
  font-weight: 700;
  font-style: italic;
}

@media (max-width: 1100px) {
  .layout {
    grid-template-columns: 1fr;
  }
}
@media (max-width: 560px) {
  .timeline {
    grid-template-columns: 1fr;
    gap: 18px;
  }
  .timeline li {
    padding: 4px 0 0 48px;
  }
  .timeline li::before {
    display: none;
  }
}
</style>
