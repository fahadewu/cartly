<script setup>
import { computed, reactive, ref } from 'vue'
import PageHeader from '../components/PageHeader.vue'
import StatusTag from '../components/StatusTag.vue'
import StateBlock from '../components/StateBlock.vue'
import Dialog from '../components/Dialog.vue'
import Field from '../components/Field.vue'
import { get, post } from '../api.js'
import { refreshBadges } from '../badges.js'
import { useResource } from '../composables.js'
import { RETURN_REASON, dateTime, money, plural, sizeLabel, taka } from '../format.js'
import { toast } from '../toast.js'

// One return, from the shopper asking to the money going back.
const props = defineProps({ id: String })
const { data: r, loading, error, reload } = useResource(() => get(`/admin/returns/${encodeURIComponent(props.id)}`))
const busy = ref('')
const METHOD = { bkash: 'bKash', nagad: 'Nagad', rocket: 'Rocket', card: 'Card', cod: 'Cash on delivery', demo: 'Demo card' }
const online = computed(() => ['bkash', 'nagad', 'rocket', 'card'].includes(r.value?.order.paymentMethod))
const activePickup = computed(() => r.value?.pickups.find((s) => !['DELIVERED', 'RETURNED', 'CANCELLED'].includes(s.status)))
const units = computed(() => r.value?.items.reduce((n, i) => n + i.qty, 0) ?? 0)
const STEPS = ['REQUESTED', 'APPROVED', 'RECEIVED', 'REFUNDED']
const STEP_LABEL = { REQUESTED: 'Asked', APPROVED: 'Approved', RECEIVED: 'Back & inspected', REFUNDED: 'Refunded' }
const reached = computed(() => STEPS.indexOf(r.value?.status))

async function act(key, fn, done) {
  busy.value = key
  try {
    r.value = await fn()
    toast(done)
    refreshBadges({ force: true })
    return true
  } catch (e) {
    toast(e.message, 'error')
    if (e.status === 409) reload({ quiet: true })
    return false
  } finally {
    busy.value = ''
  }
}

/* ---------- decide ---------- */
const decide = reactive({ open: false, approve: true, note: '' })
const openDecide = (approve) => Object.assign(decide, { open: true, approve, note: '' })
async function sendDecide() {
  if (!decide.approve && !decide.note.trim()) return toast('Say why, so the customer knows.', 'error')
  const ok = await act('decide', () => post(`/admin/returns/${r.value.id}/${decide.approve ? 'approve' : 'reject'}`, { note: decide.note.trim() || undefined }), decide.approve ? 'Return approved' : 'Return turned down')
  if (ok) decide.open = false
}

/* ---------- pickup ---------- */
const pickup = reactive({ open: false, riderId: '', note: '', riders: [] })
async function openPickup() {
  Object.assign(pickup, { open: true, riderId: '', note: '', riders: [] })
  try {
    pickup.riders = (await get('/admin/delivery/options')).riders
  } catch (e) {
    toast(e.message, 'error')
  }
}
async function sendPickup() {
  if (!pickup.riderId) return toast('Choose a rider.', 'error')
  const ok = await act('pickup', () => post(`/admin/returns/${r.value.id}/pickup`, { riderId: pickup.riderId, note: pickup.note.trim() || undefined }), 'Rider sent to collect it')
  if (ok) pickup.open = false
}

/* ---------- inspect ---------- */
const inspect = reactive({ open: false, restock: {}, note: '' })
function openInspect() {
  Object.assign(inspect, { open: true, note: '', restock: Object.fromEntries(r.value.items.filter((i) => i.restocked == null).map((i) => [i.id, r.value.reason !== 'DAMAGED'])) })
}
async function sendInspect() {
  const items = Object.entries(inspect.restock).map(([id, restock]) => ({ id, restock }))
  const n = r.value.items.filter((i) => inspect.restock[i.id]).reduce((a, i) => a + i.qty, 0)
  const ok = await act('inspect', () => post(`/admin/returns/${r.value.id}/receive`, { items, note: inspect.note.trim() || undefined }), n ? `${plural(n, 'item')} back in stock` : 'Recorded: nothing went back into stock')
  if (ok) inspect.open = false
}

/* ---------- refund ---------- */
const refund = reactive({ open: false, via: 'gateway', amount: '', manualMethod: 'bKash transfer', reference: '', error: '' })
function openRefund() {
  Object.assign(refund, { open: true, via: online.value ? 'gateway' : 'manual', amount: r.value.refundBdt ?? '', manualMethod: r.value.order.paymentMethod === 'cod' ? 'bKash transfer' : 'Bank transfer', reference: '', error: '' })
}
async function sendRefund() {
  refund.error = ''
  const amount = Number(refund.amount)
  if (!(amount > 0)) return (refund.error = 'Enter the amount in taka.')
  if (refund.via === 'manual' && !refund.reference.trim() && r.value.order.paymentMethod !== 'demo') return (refund.error = 'Add the transfer’s reference, e.g. the bKash transaction id.')
  busy.value = 'refund'
  try {
    r.value = await post(`/admin/returns/${r.value.id}/refund`, { via: refund.via, amountBdt: amount, manualMethod: refund.via === 'manual' ? refund.manualMethod : undefined, reference: refund.reference.trim() || undefined })
    toast(`${taka(amount)} refunded`)
    refund.open = false
    refreshBadges({ force: true })
  } catch (e) {
    refund.error = e.message
  } finally {
    busy.value = ''
  }
}
const lines = (a) => [a.name, a.street, `${a.city ?? ''} ${a.postal ?? ''}`.trim(), a.country, a.phone].filter(Boolean)
</script>

<template>
  <div>
    <StateBlock :loading="loading" :error="error" @retry="reload">
      <template v-if="r">
        <PageHeader :title="`Return ${r.id}`" back="/returns" back-label="Returns">
          <template #tag><StatusTag :status="`RT_${r.status}`" /></template>
          <template #description>
            For order <RouterLink :to="`/orders/${r.orderId}`">{{ r.orderId }}</RouterLink>, asked {{ dateTime(r.createdAt) }}.
          </template>
          <template v-if="r.status === 'REQUESTED'">
            <button v-can="'returns.write'" class="btn primary" :disabled="!!busy" @click="openDecide(true)">Approve</button>
            <button v-can="'returns.write'" class="btn danger" :disabled="!!busy" @click="openDecide(false)">Turn down</button>
          </template>
          <template v-if="r.status === 'APPROVED'">
            <button v-can="'returns.write'" v-if="!activePickup" class="btn" :disabled="!!busy" @click="openPickup">Send a rider</button>
            <button v-can="'returns.write'" class="btn primary" :disabled="!!busy || (activePickup && activePickup.status !== 'BOOKED')" @click="openInspect">It’s back: inspect</button>
            <button v-can="'returns.write'" class="btn danger" :disabled="!!busy" @click="openDecide(false)">Turn down</button>
          </template>
          <template v-if="r.status === 'RECEIVED'">
            <button v-can="'returns.write'" v-if="r.items.some((i) => i.restocked == null)" class="btn primary" :disabled="!!busy" @click="openInspect">Inspect</button>
            <button v-can="'refunds.write'" v-else class="btn primary" :disabled="!!busy" @click="openRefund">Refund {{ r.refundBdt != null ? taka(r.refundBdt) : money(r.refundUsd) }}</button>
          </template>
        </PageHeader>

        <ol v-if="r.status !== 'REJECTED' && r.status !== 'CANCELLED'" class="steps">
          <li v-for="(s, i) in STEPS" :key="s" :class="{ done: i <= reached }">{{ STEP_LABEL[s] }}</li>
        </ol>
        <p v-else class="muted">{{ r.status === 'REJECTED' ? `Turned down: ${r.storeNote}` : 'The customer withdrew this return.' }}</p>

        <div class="layout">
          <div class="stack">
            <section class="panel">
              <div class="panel-head"><h2>{{ plural(units, 'item') }} coming back</h2></div>
              <ul class="items">
                <li v-for="i in r.items" :key="i.id">
                  <img class="thumb big" :src="i.image" alt="" />
                  <div class="grow">
                    <RouterLink :to="`/products/${i.productId}`" class="name">{{ i.name }}</RouterLink>
                    <span class="sub">{{ i.color }}, {{ sizeLabel(i.size) }} · {{ i.qty }} × {{ money(i.price) }}</span>
                  </div>
                  <span v-if="i.restocked === true" class="ok small">Back in stock</span>
                  <span v-else-if="i.restocked === false" class="warn small">Not restocked</span>
                </li>
              </ul>
            </section>
            <section class="panel pad">
              <h2>Why</h2>
              <p><b>{{ RETURN_REASON[r.reason] }}</b></p>
              <p v-if="r.note" class="quote">“{{ r.note }}”</p>
              <p v-if="r.storeNote && r.status !== 'REJECTED'" class="muted small">Store note: {{ r.storeNote }}</p>
            </section>
            <section v-for="s in r.pickups" :key="s.id" class="panel pad">
              <h2>Pickup by {{ s.rider?.name ?? 'rider' }} <StatusTag :status="s.status" /></h2>
              <ol class="timeline">
                <li v-for="(e, i) in s.events" :key="i"><b>{{ e.message }}</b> <span class="muted small">{{ dateTime(e.at) }}</span></li>
              </ol>
            </section>
          </div>
          <div class="stack">
            <section class="panel pad">
              <h2>Refund</h2>
              <p class="big figures">{{ r.refundBdt != null ? taka(r.refundBdt) : money(r.refundUsd) }}</p>
              <p class="muted small">{{ money(r.refundUsd) }}: the items’ price less their share of any promo. Delivery isn’t refunded.</p>
              <dl class="kv small">
                <dt>Paid with</dt><dd>{{ METHOD[r.order.paymentMethod] ?? r.order.paymentMethod }}</dd>
                <template v-if="r.refundedAt"><dt>Refunded</dt><dd>{{ dateTime(r.refundedAt) }}</dd><dt>How</dt><dd>{{ r.refundMethod }}</dd><dt>Reference</dt><dd class="mono">{{ r.refundRef ?? '—' }}</dd></template>
              </dl>
            </section>
            <section class="panel pad">
              <h2>Customer</h2>
              <p><RouterLink :to="`/customers/${r.customer.id}`"><b>{{ r.customer.name }}</b></RouterLink><br /><span class="muted">{{ r.customer.email }}</span></p>
              <address><span v-for="l in lines(r.order.address)" :key="l">{{ l }}</span></address>
            </section>
          </div>
        </div>
      </template>
    </StateBlock>

    <Dialog :open="decide.open" :title="decide.approve ? 'Approve the return' : 'Turn the return down'" @close="decide.open = false">
      <form class="dialog-form" @submit.prevent="sendDecide">
        <Field id="d-note" :label="decide.approve ? 'Note' : 'Why'" :optional="decide.approve" :hint="decide.approve ? '' : 'The customer sees this.'">
          <input id="d-note" v-model="decide.note" class="input" maxlength="300" :placeholder="decide.approve ? 'Drop it at the Dhanmondi shop, or we’ll collect' : 'Worn and washed; outside the policy'" />
        </Field>
        <div class="dialog-buttons">
          <button type="button" class="btn" @click="decide.open = false">Cancel</button>
          <button class="btn" :class="decide.approve ? 'primary' : 'danger'" :disabled="busy === 'decide'">{{ decide.approve ? 'Approve' : 'Turn down' }}</button>
        </div>
      </form>
    </Dialog>

    <Dialog :open="pickup.open" title="Send a rider to collect it" @close="pickup.open = false">
      <form class="dialog-form" @submit.prevent="sendPickup">
        <Field id="p-rider" label="Rider">
          <select id="p-rider" v-model="pickup.riderId" class="select">
            <option value="" disabled>Choose a rider</option>
            <option v-for="x in pickup.riders" :key="x.id" :value="x.id">{{ x.name }}{{ x.zone ? ` · ${x.zone}` : '' }} · {{ x.onTheWay }} on the way</option>
          </select>
        </Field>
        <Field id="p-note" label="Note for the rider" optional><input id="p-note" v-model="pickup.note" class="input" maxlength="250" placeholder="Check the tags are still on" /></Field>
        <div class="dialog-buttons">
          <button type="button" class="btn" @click="pickup.open = false">Cancel</button>
          <button class="btn primary" :disabled="busy === 'pickup'">Send</button>
        </div>
      </form>
    </Dialog>

    <Dialog :open="inspect.open" title="Inspect what came back" @close="inspect.open = false">
      <form v-if="r" class="dialog-form" @submit.prevent="sendInspect">
        <p class="muted small">Tick what can be sold again: it goes straight back into stock.</p>
        <label v-for="i in r.items.filter((x) => x.restocked == null)" :key="i.id" class="check-row">
          <input v-model="inspect.restock[i.id]" type="checkbox" />
          <span>{{ i.qty }} × {{ i.name }} ({{ i.color }}, {{ sizeLabel(i.size) }})</span>
        </label>
        <Field id="i-note" label="Note" optional><input id="i-note" v-model="inspect.note" class="input" maxlength="300" placeholder="Tag missing on one" /></Field>
        <div class="dialog-buttons">
          <button type="button" class="btn" @click="inspect.open = false">Cancel</button>
          <button class="btn primary" :disabled="busy === 'inspect'">Save</button>
        </div>
      </form>
    </Dialog>

    <Dialog :open="refund.open" title="Refund the return" @close="refund.open = false">
      <form v-if="r" class="dialog-form" novalidate @submit.prevent="sendRefund">
        <p v-if="refund.error" class="form-error" role="alert">{{ refund.error }}</p>
        <label v-if="online" class="check-row"><input v-model="refund.via" type="radio" value="gateway" /> <span>Back through {{ METHOD[r.order.paymentMethod] }} (the payment it came from)</span></label>
        <label class="check-row"><input v-model="refund.via" type="radio" value="manual" /> <span>Sent another way, and record it here</span></label>
        <Field id="rf-amount" label="Amount (taka)"><input id="rf-amount" v-model="refund.amount" class="input" type="number" min="1" step="0.01" /></Field>
        <template v-if="refund.via === 'manual'">
          <Field id="rf-method" label="How it was sent">
            <select id="rf-method" v-model="refund.manualMethod" class="select">
              <option>bKash transfer</option><option>Nagad transfer</option><option>Rocket transfer</option><option>Bank transfer</option><option>Cash</option><option>Store credit</option>
            </select>
          </Field>
          <Field id="rf-ref" label="Reference" hint="The transfer’s transaction id, or who handed the cash over."><input id="rf-ref" v-model="refund.reference" class="input" maxlength="120" /></Field>
        </template>
        <div class="dialog-buttons">
          <button type="button" class="btn" @click="refund.open = false">Cancel</button>
          <button class="btn primary" :disabled="busy === 'refund'">{{ busy === 'refund' ? 'Refunding…' : refund.via === 'gateway' ? 'Refund now' : 'Record refund' }}</button>
        </div>
      </form>
    </Dialog>
  </div>
</template>

<style scoped>
.steps {
  display: flex;
  gap: 8px;
  margin: -6px 0 18px;
  padding: 0;
  list-style: none;
  flex-wrap: wrap;
}
.steps li {
  padding: 6px 12px;
  border-radius: 999px;
  background: var(--grey);
  color: var(--muted);
  font-size: 13px;
  font-weight: 650;
}
.steps li.done {
  background: var(--accent-soft);
  color: var(--accent);
}
.layout {
  display: grid;
  grid-template-columns: minmax(0, 1.6fr) minmax(280px, 1fr);
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
  width: 52px;
  height: 52px;
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
  color: var(--muted);
  font-size: 12.5px;
}
.ok {
  color: var(--ok);
  font-weight: 700;
}
.warn {
  color: var(--warn);
  font-weight: 700;
}
.small {
  font-size: 12.5px;
}
.big {
  margin: 0;
  font-size: 26px;
  font-weight: 800;
}
.quote {
  margin: 6px 0 0;
  font-style: italic;
}
.panel.pad h2 {
  display: flex;
  gap: 8px;
  align-items: center;
  margin: 0 0 10px;
}
.timeline {
  display: grid;
  gap: 6px;
  margin: 0;
  padding-left: 18px;
  font-size: 13.5px;
}
address {
  display: grid;
  margin-top: 8px;
  font-style: normal;
}
.mono {
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
}
.dialog-form {
  display: grid;
  gap: 14px;
}
.dialog-buttons {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}
.check-row {
  display: flex;
  gap: 10px;
  align-items: center;
  font-size: 14px;
}
@media (max-width: 960px) {
  .layout {
    grid-template-columns: 1fr;
  }
}
</style>
