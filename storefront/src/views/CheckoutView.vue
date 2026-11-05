<script setup>
import { reactive, ref, computed, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import PageHeader from '../components/PageHeader.vue'
import AuthField from '../components/AuthField.vue'
import OrderSummary from '../components/OrderSummary.vue'
import Icon from '../components/Icon.vue'
import { money } from '../data.js'
import { delivery } from '../catalog.js'
import { paymentMethods, useShop } from '../store.js'
import { auth } from '../auth.js'
import { next as festivalNext, loadFestivals, shortName } from '../festival.js'

const router = useRouter()
const { state, lines, subtotal, discount, shippingFor, placeOrder, resetCart } = useShop()
// Keep showing what was paid for until the order page has taken over.
let placed = false
onUnmounted(() => placed && resetCart())

const form = reactive({
  email: auth.user?.email ?? '',
  name: auth.user?.name ?? '',
  street: '',
  city: '',
  postal: '',
  country: 'Bangladesh',
  phone: '',
  delivery: 'standard',
  method: '',
  cardName: auth.user?.name ?? '',
  card: '',
  expiry: '',
  cvc: '',
})
const errors = reactive({})
const placing = ref(false)
const submitError = ref('')

const shipping = computed(() => shippingFor(form.delivery))
const total = computed(() => subtotal.value - discount.value + shipping.value)

// Payment options come from the admin panel (bKash, Nagad, Rocket, cards, cash on delivery…).
const methods = ref([])
const rate = ref(null)
const methodsError = ref('')
paymentMethods()
  .then((r) => {
    methods.value = r.methods
    rate.value = r.usdToBdt
    form.method ||= r.methods[0]?.id ?? ''
  })
  .catch((e) => (methodsError.value = e.message))
const chosen = computed(() => methods.value.find((m) => m.id === form.method))
const takaTotal = computed(() => (rate.value ? Math.round(total.value * rate.value * 100) / 100 : null))
const taka = (n) => `৳${new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 }).format(n)}`
const payLabel = computed(() => {
  const m = chosen.value
  if (!m) return 'Place order'
  if (m.id === 'demo') return `Pay ${money(total.value)}`
  if (m.id === 'cod') return `Place order · pay ${taka(takaTotal.value)} on delivery`
  return `Pay ${taka(takaTotal.value)} with ${m.label}`
})
// Test details for the gateways' sandboxes: shown only while a method is in sandbox mode.
const SANDBOX = {
  bkash: 'Sandbox: wallet 01770618575, OTP 123456, PIN 12121.',
  nagad: 'Sandbox: use the test wallet from your Nagad sandbox onboarding.',
  rocket: 'Sandbox: any mobile number, OTP 111111.',
  card: 'Sandbox: card 4111 1111 1111 1111, expiry 12/26, CVV 111 (then OTP 111111 if asked).',
}
const NOTE = {
  bkash: 'You’ll approve the payment on bKash’s page with your wallet number, OTP and PIN, then come straight back here.',
  nagad: 'You’ll finish paying on Nagad’s page, then come straight back here.',
  rocket: 'You’ll pay with your Rocket (Dutch-Bangla) account on the secure SSLCommerz page, then come straight back here.',
  card: 'You’ll enter your card on the secure SSLCommerz page (Visa, Mastercard, Amex), then come straight back here.',
  cod: 'Pay the courier in cash when your order arrives. We’ll call the phone number above to arrange delivery.',
}

// Light formatting as the shopper types.
function formatCard(e) {
  e.target.value = form.card = e.target.value.replace(/\D/g, '').slice(0, 16).replace(/(.{4})/g, '$1 ').trim()
}
function formatExpiry(e) {
  const d = e.target.value.replace(/\D/g, '').slice(0, 4)
  e.target.value = form.expiry = d.length > 2 ? `${d.slice(0, 2)}/${d.slice(2)}` : d
}

const luhn = (num) =>
  num
    .split('')
    .reverse()
    .reduce((sum, ch, i) => {
      let n = Number(ch)
      if (i % 2) n = n * 2 > 9 ? n * 2 - 9 : n * 2
      return sum + n
    }, 0) %
    10 ===
  0

function validate() {
  const e = {}
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) e.email = 'Enter a valid email.'
  if (form.name.trim().length < 2) e.name = 'Enter the recipient’s name.'
  if (form.street.trim().length < 4) e.street = 'Enter a street address.'
  if (!form.city.trim()) e.city = 'Enter a city.'
  if (form.postal.trim().length < 3) e.postal = 'Enter a postcode.'
  // Every parcel in Bangladesh goes out with a mobile number: riders and couriers call before they come.
  const phone = form.phone.replace(/[\s()-]/g, '')
  if (!phone) e.phone = 'Add a mobile number so the rider or courier can reach you.'
  else if (!/^(\+?88)?01[3-9]\d{8}$/.test(phone) && !/^\+[1-9]\d{7,14}$/.test(phone)) e.phone = 'Enter a Bangladeshi mobile number (01XXXXXXXXX) or an international one with its country code.'
  if (!chosen.value) e.method = 'Choose how to pay.'
  Object.keys(errors).forEach((k) => delete errors[k])
  Object.assign(errors, e)
  if (form.method !== 'demo') return !Object.keys(e).length
  if (form.cardName.trim().length < 2) e.cardName = 'Enter the name on the card.'
  const digits = form.card.replace(/\s/g, '')
  if (digits.length !== 16 || !luhn(digits)) e.card = 'Enter a valid 16-digit card number.'
  const [mm, yy] = form.expiry.split('/').map(Number)
  const expired = !mm || !yy || mm > 12 || new Date(2000 + yy, mm) < new Date()
  if (expired) e.expiry = 'Enter a valid expiry date.'
  if (!/^\d{3,4}$/.test(form.cvc)) e.cvc = '3 or 4 digits.'
  Object.keys(errors).forEach((k) => delete errors[k])
  Object.assign(errors, e)
  return !Object.keys(e).length
}

async function submit() {
  if (!validate()) {
    document.querySelector('[aria-invalid="true"]')?.focus()
    return
  }
  placing.value = true
  submitError.value = ''
  try {
    const order = await placeOrder({
      address: { name: form.name.trim(), street: form.street.trim(), city: form.city.trim(), postal: form.postal.trim(), country: form.country, phone: form.phone.trim() || undefined },
      delivery: form.delivery,
      payment:
        form.method === 'demo'
          ? { method: 'demo', nameOnCard: form.cardName.trim(), cardNumber: form.card, expiry: form.expiry, cvc: form.cvc }
          : { method: form.method },
    })
    placed = true
    // Online payments continue on the gateway's own page, which sends the shopper back to their order.
    if (order.payment.redirectUrl) return window.location.assign(order.payment.redirectUrl)
    router.replace({ name: 'order', params: { id: order.id }, query: { placed: '1' } })
  } catch (e) {
    submitError.value = e.message
    placing.value = false
  }
}
// The posted delivery times against the next festival: honest about what will and won't make it.
loadFestivals()
</script>

<template>
  <div>
    <PageHeader title="Checkout" :crumbs="[{ label: 'Explore', to: '/' }, { label: 'Cart', to: '/cart' }, { label: 'Checkout' }]" />

    <div class="page">
      <div v-if="!lines.length" class="empty">
        <span class="empty-icon"><Icon name="bag" :size="28" /></span>
        <h3>Nothing to check out</h3>
        <p>Your cart is empty. Add something first and come back here.</p>
        <RouterLink to="/shop" class="btn-primary sm">Browse products</RouterLink>
      </div>

      <form v-else class="layout" novalidate @submit.prevent="submit">
        <div class="steps">
          <section class="box">
            <h2><span class="num">1</span>Contact</h2>
            <div class="form-grid">
              <AuthField v-model="form.email" label="Email" icon="mail" type="email" autocomplete="email" :error="errors.email" class="full" />
              <AuthField
                v-model="form.phone"
                :label="form.method === 'cod' ? 'Phone' : 'Phone (optional)'"
                type="tel"
                autocomplete="tel"
                :placeholder="form.method === 'bkash' ? 'Your bKash number, filled in for you' : 'For delivery updates'"
                :error="errors.phone"
                class="full"
              />
            </div>
          </section>

          <section class="box">
            <h2><span class="num">2</span>Delivery address</h2>
            <div class="form-grid">
              <AuthField v-model="form.name" label="Full name" icon="user" autocomplete="name" :error="errors.name" class="full" />
              <AuthField v-model="form.street" label="Street address" autocomplete="street-address" placeholder="House number and street" :error="errors.street" class="full" />
              <AuthField v-model="form.city" label="City" autocomplete="address-level2" :error="errors.city" />
              <AuthField v-model="form.postal" label="Postcode" autocomplete="postal-code" :error="errors.postal" />
              <div class="full">
                <label class="label" for="country">Country</label>
                <select id="country" v-model="form.country" class="select" autocomplete="country-name">
                  <option>Bangladesh</option>
                  <option>United Kingdom</option>
                  <option>Ireland</option>
                  <option>United States</option>
                  <option>Canada</option>
                  <option>Germany</option>
                  <option>France</option>
                  <option>Pakistan</option>
                  <option>United Arab Emirates</option>
                </select>
              </div>
            </div>
          </section>

          <section class="box">
            <h2><span class="num">3</span>Delivery method</h2>
            <div class="methods">
              <label v-for="(m, key) in delivery.options" :key="key" class="method" :class="{ on: form.delivery === key }">
                <input v-model="form.delivery" type="radio" name="delivery" :value="key" />
                <span class="dot" />
                <span class="m-text">
                  <b>{{ m.label }}</b><small>{{ m.eta }}</small>
                  <small v-if="festivalNext && festivalNext.orderBy[key]" class="before"><Icon name="check" :size="12" />Arrives before {{ shortName(festivalNext.name) }}</small>
                  <small v-else-if="festivalNext" class="after">May not arrive before {{ shortName(festivalNext.name) }}</small>
                </span>
                <b class="m-price">{{ shippingFor(key) === 0 ? 'Free' : money(shippingFor(key)) }}</b>
              </label>
            </div>
          </section>

          <RouterLink to="/promise" class="promise-note"><Icon name="check" :size="15" />No hidden fees: what you see in the summary is what you pay. Our promise</RouterLink>

          <section class="box">
            <h2><span class="num">4</span>Payment</h2>
            <p v-if="methodsError" class="form-alert error" role="alert"><Icon name="alert" :size="16" />{{ methodsError }}</p>
            <p v-else-if="!methods.length" class="demo-note">Loading payment options…</p>
            <div class="methods pay" role="radiogroup" aria-label="Payment method">
              <label v-for="m in methods" :key="m.id" class="method" :class="{ on: form.method === m.id }">
                <input v-model="form.method" type="radio" name="method" :value="m.id" />
                <span class="dot" />
                <span class="m-text">
                  <b>{{ m.label }}</b>
                  <small>{{ m.id === 'demo' ? 'Development only' : m.sandbox ? 'Test mode (sandbox)' : m.online ? 'Secure payment page' : 'Pay in cash' }}</small>
                </span>
                <span class="brand" :class="m.id" aria-hidden="true" />
              </label>
            </div>
            <p v-if="errors.method" class="form-alert error">{{ errors.method }}</p>
            <p v-if="chosen && chosen.id !== 'demo'" class="demo-note">
              <Icon name="lock" :size="16" />
              <span>
                {{ NOTE[chosen.id] }}
                <template v-if="takaTotal != null">You’ll pay <b>{{ taka(takaTotal) }}</b> ({{ money(total) }} at ৳{{ rate }} per dollar).</template>
              </span>
            </p>
            <p v-if="chosen?.sandbox && SANDBOX[chosen.id]" class="demo-note sandbox">
              <Icon name="alert" :size="16" /><span><b>Test mode.</b> {{ SANDBOX[chosen.id] }} No real money moves.</span>
            </p>
            <p v-if="chosen?.id === 'demo'" class="demo-note"><Icon name="lock" :size="16" />Demo card: no real payment is taken. Try card <b>4242 4242 4242 4242</b>.</p>
            <div v-if="chosen?.id === 'demo'" class="form-grid">
              <AuthField v-model="form.cardName" label="Name on card" icon="user" autocomplete="cc-name" :error="errors.cardName" class="full" />
              <AuthField :model-value="form.card" label="Card number" icon="lock" inputmode="numeric" autocomplete="cc-number" placeholder="1234 5678 9012 3456" :error="errors.card" class="full" @input="formatCard" />
              <AuthField :model-value="form.expiry" label="Expiry" inputmode="numeric" autocomplete="cc-exp" placeholder="MM/YY" :error="errors.expiry" @input="formatExpiry" />
              <AuthField v-model="form.cvc" label="CVC" inputmode="numeric" autocomplete="cc-csc" maxlength="4" placeholder="123" :error="errors.cvc" />
            </div>
          </section>
        </div>

        <aside class="box summary">
          <h2>Your order</h2>
          <ul class="items">
            <li v-for="l in lines" :key="l.key">
              <span class="thumb"><img :src="l.product.image" alt="" /><i>{{ l.qty }}</i></span>
              <span class="i-text"><b>{{ l.product.name }}</b><small>{{ l.color }} · {{ l.size }}</small></span>
              <b>{{ money(l.product.price * l.qty) }}</b>
            </li>
          </ul>
          <OrderSummary :subtotal="subtotal" :discount="discount" :shipping="shipping" :total="total" :promo="state.cart.promoCode" />
          <p v-if="submitError" class="form-alert error" role="alert"><Icon name="alert" :size="16" />{{ submitError }}</p>
          <button class="btn-primary place" type="submit" :disabled="placing">
            <span v-if="placing" class="spinner" />
            {{ placing ? (chosen?.online ? 'Opening the payment page…' : 'Placing order…') : payLabel }}
          </button>
          <RouterLink to="/cart" class="back">Back to cart</RouterLink>
        </aside>
      </form>
    </div>
  </div>
</template>

<style scoped>
.layout {
  display: grid;
  grid-template-columns: 1fr 400px;
  gap: 28px;
  align-items: start;
}
.steps {
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.box h2 {
  display: flex;
  align-items: center;
  gap: 12px;
}
.num {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border-radius: 50%;
  background: var(--blue);
  color: #fff;
  font-size: 14px;
  font-weight: 600;
}
.methods {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.methods.pay {
  margin-bottom: 14px;
}
/* A colour chip in each wallet's own brand colour. */
.brand {
  width: 14px;
  height: 14px;
  border-radius: 4px;
  background: var(--line);
}
.brand.bkash {
  background: #e2136e;
}
.brand.nagad {
  background: #ed1c24;
}
.brand.rocket {
  background: #8c3494;
}
.brand.card {
  background: #1a1f71;
}
.brand.cod {
  background: #17803d;
}
.method {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 18px 20px;
  border: 2px solid var(--line);
  border-radius: 22px;
  cursor: pointer;
  transition: border-color 0.2s ease, background 0.2s ease;
}
.method input {
  position: absolute;
  opacity: 0;
  pointer-events: none;
}
.method.on {
  border-color: var(--blue);
  background: #f7f9ff;
}
.method:focus-within {
  box-shadow: 0 0 0 4px var(--blue-soft);
}
.dot {
  width: 20px;
  height: 20px;
  border: 2px solid #c9cdd2;
  border-radius: 50%;
  transition: all 0.2s ease;
}
.on .dot {
  border: 6px solid var(--blue);
}
.m-text {
  flex: 1;
  display: flex;
  flex-direction: column;
  font-size: 14px;
}
.m-text b {
  font-weight: 500;
}
.m-text small {
  color: var(--muted);
}
.m-price {
  font-size: 14px;
  font-weight: 600;
}
.demo-note.sandbox {
  background: var(--blue-soft, #e7eeff);
}
.demo-note {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 18px;
  padding: 12px 16px;
  border-radius: 16px;
  background: var(--butter);
  font-size: 13px;
}
.demo-note b {
  font-weight: 600;
}

.summary {
  position: sticky;
  top: 24px;
}
.items {
  display: flex;
  flex-direction: column;
  gap: 14px;
  margin: 0 0 22px;
  padding: 0 0 22px;
  border-bottom: 1px solid var(--line);
  list-style: none;
  max-height: 320px;
  overflow-y: auto;
}
.items li {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 14px;
}
.thumb {
  position: relative;
  flex-shrink: 0;
  width: 56px;
  height: 56px;
  border-radius: 16px;
  background: var(--card);
}
.thumb img {
  width: 100%;
  height: 100%;
  border-radius: 16px;
  object-fit: cover;
  mix-blend-mode: multiply;
}
.thumb i {
  position: absolute;
  top: -6px;
  right: -6px;
  display: grid;
  place-items: center;
  min-width: 22px;
  height: 22px;
  border-radius: 11px;
  background: var(--ink);
  color: #fff;
  font-size: 11px;
  font-style: normal;
  font-weight: 600;
}
.i-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.i-text b {
  font-weight: 500;
}
.i-text small {
  color: var(--muted);
}
.place {
  width: 100%;
  margin-top: 22px;
}
.back {
  display: block;
  margin-top: 14px;
  text-align: center;
  font-size: 14px;
  color: var(--muted);
}

@media (max-width: 1100px) {
  .layout {
    grid-template-columns: 1fr;
  }
  .summary {
    position: static;
  }
}
@media (max-width: 560px) {
  .methods {
    grid-template-columns: 1fr;
  }
}
.m-text .before {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: #1a7f4b;
}
.m-text .after {
  color: #9a6700;
}
.promise-note {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: -6px 4px 0;
  font-size: 13px;
  color: #1a7f4b;
  text-decoration: none;
}
</style>
