<script setup>
import { computed, reactive, ref } from 'vue'
import PageHeader from '../components/PageHeader.vue'
import StatusTag from '../components/StatusTag.vue'
import StateBlock from '../components/StateBlock.vue'
import Dialog from '../components/Dialog.vue'
import Field from '../components/Field.vue'
import DeliveryPanel from '../components/DeliveryPanel.vue'
import { get, patch, post } from '../api.js'
import { refreshBadges } from '../badges.js'
import { confirm } from '../confirm.js'
import { useResource } from '../composables.js'
import { RETURN_REASON, dateTime, money, plural, sizeLabel, taka } from '../format.js'
import { toast } from '../toast.js'

const props = defineProps({ id: String })
const { data: o, loading, error, reload } = useResource(() => get(`/admin/orders/${encodeURIComponent(props.id)}`))
const busy = ref('')

const ACTIONS = {
  SHIPPED: { label: 'Mark as shipped', done: 'Order marked as shipped', primary: true },
  DELIVERED: { label: 'Mark as delivered', done: 'Order marked as delivered', primary: true },
  CANCELLED: { label: 'Cancel order', done: 'Order cancelled and items restocked', danger: true },
}
const actions = computed(() => (o.value?.next ?? []).map((status) => ({ status, ...ACTIONS[status] })))
const units = computed(() => o.value?.items.reduce((n, i) => n + i.qty, 0) ?? 0)

const METHOD = { bkash: 'bKash', nagad: 'Nagad', rocket: 'Rocket', card: 'Card', cod: 'Cash on delivery', demo: 'Demo card' }
const GATEWAY = { bkash: 'bKash', nagad: 'Nagad', sslcommerz: 'SSLCommerz' }
const paidOnline = computed(() => o.value?.payment.status === 'PAID' && !['cod', 'demo'].includes(o.value.payment.method))

async function move(a) {
  if (a.status === 'CANCELLED') {
    const ok = await confirm({
      title: `Cancel order ${o.value.id}?`,
      body: `The ${plural(units.value, 'item')} go back into stock and the order can’t be reopened.${paidOnline.value ? ' The payment isn’t sent back automatically: refund it from this page afterwards.' : ''}`,
      confirmLabel: 'Cancel order',
      danger: true,
    })
    if (!ok) return
  }
  busy.value = a.status
  try {
    o.value = await patch(`/admin/orders/${encodeURIComponent(o.value.id)}/status`, { status: a.status })
    toast(a.done)
    refreshBadges({ force: true })
  } catch (e) {
    toast(e.message, 'error')
    if (e.status === 409) reload({ quiet: true })
  } finally {
    busy.value = ''
  }
}
const lines = (a) => [a.name, a.street, `${a.city} ${a.postal}`, a.country, a.phone].filter(Boolean)

/* ---------- payment ---------- */
async function markPaid() {
  // One click used to flip a cash order to paid with no way back in the UI.
  if (!(await confirm({ title: 'Record cash received?', body: `${o.value.id} will be marked as paid. Only do this once the cash is in hand.`, confirmLabel: 'Mark as paid' }))) return
  busy.value = 'paid'
  try {
    o.value = await patch(`/admin/orders/${encodeURIComponent(o.value.id)}/payment`, { status: 'PAID' })
    toast('Marked as paid')
  } catch (e) {
    toast(e.message, 'error')
  } finally {
    busy.value = ''
  }
}
async function check(p) {
  busy.value = `check:${p.id}`
  try {
    const r = await post(`/admin/payments/${p.id}/check`)
    toast(r.status === p.status ? `${GATEWAY[p.gateway]} says it’s still ${r.status.toLowerCase()}` : `Updated: ${r.status.toLowerCase()}`)
    reload({ quiet: true })
  } catch (e) {
    toast(e.message, 'error')
  } finally {
    busy.value = ''
  }
}
const refund = reactive({ open: false, payment: null, amount: '', reason: '', manual: false, error: '', saving: false })
function openRefund(p) {
  Object.assign(refund, { open: true, payment: p, amount: +(p.amount - p.refunded).toFixed(2), reason: '', manual: p.gateway === 'nagad', error: '', saving: false })
}
async function sendRefund() {
  const p = refund.payment
  const left = +(p.amount - p.refunded).toFixed(2)
  const amount = Number(refund.amount)
  if (!(amount > 0 && amount <= left)) return (refund.error = `Refund between ৳0.01 and ${taka(left)}.`)
  refund.saving = true
  refund.error = ''
  try {
    await post(`/admin/payments/${p.id}/refund`, { amount, reason: refund.reason.trim() || undefined, manual: refund.manual })
    toast(refund.manual ? 'Refund recorded' : `${taka(amount)} refunded through ${GATEWAY[p.gateway]}`)
    refund.open = false
    reload({ quiet: true })
    refreshBadges({ force: true })
  } catch (e) {
    refund.error = e.message
  } finally {
    refund.saving = false
  }
}
</script>

<template>
  <div>
    <StateBlock :loading="loading" :error="error" @retry="reload">
      <template v-if="o">
        <PageHeader :title="`Order ${o.id}`" back="/orders" back-label="Orders">
          <template #tag><StatusTag :status="o.status" /></template>
          <template #description>Placed {{ dateTime(o.createdAt) }}<template v-if="o.updatedAt !== o.createdAt">, last updated {{ dateTime(o.updatedAt) }}</template>.</template>
          <button
            v-for="a in actions"
            v-can="'orders.write'"
            :key="a.status"
            class="btn"
            :class="{ primary: a.primary, danger: a.danger }"
            :disabled="!!busy"
            @click="move(a)"
          >
            {{ busy === a.status ? 'Saving…' : a.label }}
          </button>
        </PageHeader>

        <p v-if="o.status === 'DELIVERED' || o.status === 'CANCELLED'" class="final muted">
          {{ o.status === 'DELIVERED' ? 'This order has been delivered. Nothing left to do.' : 'This order was cancelled and its items went back into stock.' }}
        </p>

        <div class="layout">
          <div class="stack">
            <section class="panel">
              <div class="panel-head"><h2>{{ plural(units, 'item') }}</h2></div>
              <ul class="items">
                <li v-for="(i, n) in o.items" :key="n">
                  <img class="thumb big" :src="i.image" alt="" />
                  <div class="grow">
                    <RouterLink :to="`/products/${i.productId}`" class="name">{{ i.name }}</RouterLink>
                    <span class="sub">{{ i.color }}, {{ sizeLabel(i.size) }}</span>
                  </div>
                  <span class="figures muted">{{ i.qty }} × {{ money(i.price) }}</span>
                  <strong class="figures">{{ money(i.qty * i.price) }}</strong>
                </li>
              </ul>
              <dl class="totals figures">
                <div><dt>Subtotal</dt><dd>{{ money(o.subtotal) }}</dd></div>
                <div v-if="o.discount">
                  <dt>Discount <span class="code">{{ o.promoCode }}</span></dt>
                  <dd>−{{ money(o.discount) }}</dd>
                </div>
                <div><dt>{{ o.delivery === 'express' ? 'Express' : 'Standard' }} delivery</dt><dd>{{ o.shipping ? money(o.shipping) : 'Free' }}</dd></div>
                <div class="grand"><dt>Total</dt><dd>{{ money(o.total) }}</dd></div>
              </dl>
            </section>
          </div>

          <div class="stack">
            <section class="panel pad">
              <h2>Customer</h2>
              <p class="who">
                <RouterLink :to="`/customers/${o.customer.id}`"><strong>{{ o.customer.name }}</strong></RouterLink>
                <a :href="`mailto:${o.customer.email}`" class="muted">{{ o.customer.email }}</a>
              </p>
              <dl class="kv">
                <dt>Orders</dt>
                <dd class="figures">{{ o.customer.orders }}</dd>
                <dt>Total spent</dt>
                <dd class="figures">{{ money(o.customer.spent) }}</dd>
              </dl>
            </section>
            <section class="panel pad">
              <h2>Ship to</h2>
              <address>
                <span v-for="l in lines(o.address)" :key="l">{{ l }}</span>
              </address>
              <p class="muted small">{{ o.delivery === 'express' ? 'Express, 1–2 business days' : 'Standard, 3–5 business days' }}</p>
            </section>
            <DeliveryPanel :order="o" @changed="reload({ quiet: true })" />
            <section v-if="o.returns?.length" class="panel pad">
              <h2>Returns</h2>
              <ul class="attempts">
                <li v-for="rt in o.returns" :key="rt.id">
                  <div class="pay-line">
                    <RouterLink :to="`/returns/${rt.id}`"><strong>{{ rt.id }}</strong></RouterLink>
                    <StatusTag :status="`RT_${rt.status}`" />
                  </div>
                  <span class="muted small">{{ plural(rt.units, 'item') }} · {{ RETURN_REASON[rt.reason] }} · {{ rt.refundBdt != null ? taka(rt.refundBdt) : money(rt.refundUsd) }}</span>
                </li>
              </ul>
            </section>
            <section class="panel pad">
              <h2>Payment</h2>
              <p class="pay-line">
                <strong>{{ METHOD[o.payment.method] ?? o.payment.method }}</strong>
                <StatusTag :status="o.refundDue ? 'REFUND_DUE' : o.payment.status" />
              </p>
              <p v-if="o.payment.amountBdt != null" class="figures">
                {{ taka(o.payment.amountBdt) }} <span class="muted small">for {{ money(o.total) }} at ৳{{ o.payment.usdToBdt }} per dollar</span>
              </p>
              <p v-if="o.cardLast4" class="muted small">Demo card ending {{ o.cardLast4 }}: nothing was charged.</p>
              <p v-if="o.refundDue" class="warn small">This order was cancelled after it was paid. Refund the payment below.</p>
              <button v-can="'payments.write'" v-if="o.payment.method === 'cod' && o.payment.status === 'UNPAID' && o.status !== 'CANCELLED'" class="btn sm" :disabled="!!busy" @click="markPaid">
                {{ busy === 'paid' ? 'Saving…' : 'Mark as paid (cash collected)' }}
              </button>
              <ul v-if="o.payments.length" class="attempts">
                <li v-for="p in o.payments" :key="p.id">
                  <div class="pay-line">
                    <strong>{{ GATEWAY[p.gateway] }}<template v-if="p.gateway === 'sslcommerz'"> · {{ METHOD[p.method] }}</template></strong>
                    <StatusTag :status="p.status" />
                    <span v-if="p.sandbox" class="muted small">Sandbox</span>
                  </div>
                  <dl class="kv small">
                    <dt>Amount</dt>
                    <dd class="figures">{{ taka(p.amount) }}<template v-if="p.refunded"> · {{ taka(p.refunded) }} refunded</template></dd>
                    <dt>Invoice</dt>
                    <dd class="mono">{{ p.invoice }}</dd>
                    <template v-if="p.trxId">
                      <dt>Transaction</dt>
                      <dd class="mono">{{ p.trxId }}</dd>
                    </template>
                    <dt>{{ p.paidAt ? 'Paid' : 'Started' }}</dt>
                    <dd>{{ dateTime(p.paidAt ?? p.createdAt) }}</dd>
                  </dl>
                  <p v-if="p.error" class="warn small">{{ p.error }}</p>
                  <div class="pay-actions">
                    <button v-can="'payments.write'" v-if="p.status === 'PENDING' || p.status === 'EXPIRED'" class="btn sm" :disabled="!!busy" @click="check(p)">
                      {{ busy === `check:${p.id}` ? 'Checking…' : `Check with ${GATEWAY[p.gateway]}` }}
                    </button>
                    <button v-can="'refunds.write'" v-if="p.status === 'PAID'" class="btn sm" :class="{ danger: o.refundDue }" :disabled="!!busy" @click="openRefund(p)">Refund</button>
                  </div>
                </li>
              </ul>
            </section>
          </div>
        </div>
      </template>
    </StateBlock>

    <Dialog :open="refund.open" title="Refund payment" @close="refund.open = false">
      <form v-if="refund.payment" class="refund" novalidate @submit.prevent="sendRefund">
        <p v-if="refund.error" class="form-error" role="alert">{{ refund.error }}</p>
        <Field id="r-amount" label="Amount (taka)" :hint="`Up to ${taka(refund.payment.amount - refund.payment.refunded)}.`">
          <input id="r-amount" v-model="refund.amount" class="input" type="number" min="0.01" step="0.01" />
        </Field>
        <Field id="r-reason" label="Reason" optional>
          <input id="r-reason" v-model="refund.reason" class="input" maxlength="200" placeholder="Out of stock, customer changed their mind…" />
        </Field>
        <label class="check-row">
          <input v-model="refund.manual" type="checkbox" :disabled="refund.payment.gateway === 'nagad'" />
          <span>
            Already refunded in the {{ GATEWAY[refund.payment.gateway] }} merchant portal: just record it
            <span v-if="refund.payment.gateway === 'nagad'" class="muted small">(Nagad has no refund API)</span>
          </span>
        </label>
        <div class="dialog-buttons">
          <button type="button" class="btn" @click="refund.open = false">Cancel</button>
          <button class="btn primary" :disabled="refund.saving">{{ refund.saving ? 'Refunding…' : refund.manual ? 'Record refund' : `Refund through ${GATEWAY[refund.payment.gateway]}` }}</button>
        </div>
      </form>
    </Dialog>
  </div>
</template>

<style scoped>
.pay-line {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.attempts {
  display: grid;
  gap: 14px;
  margin: 14px 0 0;
  padding: 14px 0 0;
  list-style: none;
  border-top: 1px solid var(--line);
}
.attempts li {
  display: grid;
  gap: 8px;
}
.pay-actions,
.dialog-buttons {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.dialog-buttons {
  justify-content: flex-end;
}
.refund {
  display: grid;
  gap: 14px;
}
.check-row {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  font-size: 14px;
}
.warn {
  color: var(--warn);
}
.mono {
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
  font-size: 12.5px;
  word-break: break-all;
}
.final {
  margin: -8px 0 18px;
}
.layout {
  display: grid;
  grid-template-columns: minmax(0, 1.7fr) minmax(280px, 1fr);
  gap: 18px;
  align-items: start;
}
.items {
  margin: 0;
  padding: 0;
  list-style: none;
}
.items li {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 12px 18px;
  border-top: 1px solid var(--line);
}
.items li:first-child {
  border-top: 0;
}
.thumb.big {
  width: 56px;
  height: 56px;
  border-radius: 10px;
}
.grow {
  display: grid;
  flex: 1;
  min-width: 0;
}
.name {
  color: var(--ink);
  font-weight: 700;
}
.sub {
  font-size: 12.5px;
  color: var(--muted);
}
.totals {
  display: grid;
  gap: 8px;
  margin: 0;
  padding: 14px 18px 16px;
  border-top: 1px solid var(--line);
}
.totals div {
  display: flex;
  justify-content: space-between;
  gap: 12px;
}
.totals dt {
  color: var(--muted);
}
.totals dd {
  margin: 0;
  font-weight: 650;
}
.totals .grand {
  padding-top: 10px;
  border-top: 1px solid var(--line);
  font-size: 16px;
}
.totals .grand dt,
.totals .grand dd {
  color: var(--ink);
  font-weight: 800;
}
.code {
  margin-left: 4px;
  padding: 1px 6px;
  border-radius: 5px;
  background: var(--grey);
  color: var(--ink);
  font-size: 12px;
  font-weight: 700;
}
.panel.pad h2 {
  margin-bottom: 10px;
}
.who {
  display: grid;
  margin-bottom: 12px;
}
address {
  display: grid;
  font-style: normal;
  font-weight: 600;
  margin-bottom: 8px;
}
.small {
  font-size: 12.5px;
  margin-top: 4px;
}
@media (max-width: 960px) {
  .layout {
    grid-template-columns: minmax(0, 1fr);
  }
}
@media (max-width: 560px) {
  .items li {
    flex-wrap: wrap;
  }
}
</style>
