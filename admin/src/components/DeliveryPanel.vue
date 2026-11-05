<script setup>
import { computed, reactive, ref, watch } from 'vue'
import StatusTag from './StatusTag.vue'
import Dialog from './Dialog.vue'
import Field from './Field.vue'
import Icon from './Icon.vue'
import { get, post } from '../api.js'
import { refreshBadges } from '../badges.js'
import { confirm } from '../confirm.js'
import { dateTime, taka } from '../format.js'
import { toast } from '../toast.js'

// Sending an order out (own rider or a courier) and following each trip.
const props = defineProps({ order: { type: Object, required: true } })
const emit = defineEmits(['changed'])
const o = computed(() => props.order)
const busy = ref('')
const trips = computed(() => [...(o.value.shipments ?? [])].reverse())
// The customer's 4-digit code is their proof of being there: shown only on request, and only to roles that run deliveries.
const codeShown = ref('')
const STATUS_LABEL = {
  BOOKED: 'Booked',
  PICKED_UP: 'Picked up',
  IN_TRANSIT: 'In transit',
  OUT_FOR_DELIVERY: 'Out for delivery',
  DELIVERED: 'Delivered',
  FAILED_ATTEMPT: 'Attempt failed',
  RETURNING: 'Returning',
  RETURNED: 'Returned',
  CANCELLED: 'Cancelled',
}
const TERMINAL = ['DELIVERED', 'RETURNED', 'CANCELLED']
const unpaidCod = computed(() => o.value.payment.method === 'cod' && o.value.payment.status === 'UNPAID')

async function act(key, fn, done) {
  busy.value = key
  try {
    const r = await fn()
    toast(typeof done === 'function' ? done(r) : done)
    emit('changed')
    refreshBadges({ force: true })
    return r
  } catch (e) {
    toast(e.message, 'error')
    if (e.status === 409) emit('changed')
  } finally {
    busy.value = ''
  }
}

/* ---------- sending it out ---------- */
const options = ref(null)
const form = reactive({ open: false, carrier: '', riderId: '', phone: '', address: '', city: '', weightKg: 0.5, codAmount: 0, note: '', location: {}, places: {}, error: '', saving: false })
const chosen = computed(() => options.value?.couriers.find((c) => c.id === form.carrier))

async function openShip() {
  const a = o.value.address
  Object.assign(form, {
    open: true,
    carrier: '',
    riderId: '',
    phone: a.phone ?? '',
    address: [a.street, a.postal].filter(Boolean).join(', '),
    city: a.city,
    weightKg: 0.5,
    codAmount: unpaidCod.value ? Math.round(o.value.payment.amountBdt ?? 0) : 0,
    note: '',
    location: {},
    places: {},
    error: '',
    saving: false,
  })
  try {
    options.value = await get('/admin/delivery/options')
    form.carrier = options.value.riders.length ? 'rider' : (options.value.couriers[0]?.id ?? '')
  } catch (e) {
    form.error = e.message
  }
}
// A courier's lists load one level at a time: Pathao's zones once a city is picked, and so on.
async function loadLevel(level, parent) {
  form.places[level.key] = null
  try {
    form.places[level.key] = await get(`/admin/delivery/couriers/${form.carrier}/locations`, { level: level.key, parent })
  } catch (e) {
    form.places[level.key] = []
    form.error = e.message
  }
}
watch(
  () => form.carrier,
  () => {
    form.location = {}
    form.places = {}
    const first = chosen.value?.levels.find((l) => !l.parent)
    if (first) loadLevel(first)
  },
)
function pick(level, id) {
  form.location[level.key] = id
  // Everything under it has to be picked again.
  for (const l of chosen.value.levels) {
    if (l.parent === level.key) {
      delete form.location[l.key]
      if (id) loadLevel(l, id)
      else delete form.places[l.key]
    }
  }
}
const cityName = (id) => form.places.city?.find((p) => p.id === id)?.name

async function ship() {
  form.error = ''
  if (!form.carrier) return (form.error = 'Choose who takes it.')
  if (form.carrier === 'rider' && !form.riderId) return (form.error = 'Choose a rider.')
  if (!form.phone.trim()) return (form.error = 'Add the customer’s phone number.')
  for (const l of chosen.value?.levels ?? []) if (!l.optional && !form.location[l.key]) return (form.error = `Choose the ${l.label.toLowerCase()}.`)
  if (unpaidCod.value && !(Number(form.codAmount) > 0)) return (form.error = 'Set the cash to collect.')
  form.saving = true
  try {
    const body = {
      carrier: form.carrier,
      riderId: form.carrier === 'rider' ? form.riderId : undefined,
      phone: form.phone.trim(),
      address: form.address.trim(),
      // Pathao's city from its own list reads better than whatever was typed at checkout.
      city: (cityName(form.location.city) ?? form.city).trim(),
      weightKg: Number(form.weightKg) || 0.5,
      codAmount: Math.round(Number(form.codAmount) || 0),
      note: form.note.trim() || undefined,
      location: chosen.value ? form.location : undefined,
      locationNames: chosen.value ? Object.fromEntries(Object.entries(form.location).map(([k, id]) => [k, form.places[k]?.find((p) => p.id === id)?.name ?? ''])) : undefined,
    }
    const s = await post(`/admin/delivery/orders/${encodeURIComponent(o.value.id)}/ship`, body)
    toast(s.rider ? `Assigned to ${s.rider.name}` : `Booked with ${s.carrierName}${s.trackingCode ? `: ${s.trackingCode}` : ''}`)
    form.open = false
    emit('changed')
  } catch (e) {
    form.error = e.message
  } finally {
    form.saving = false
  }
}

/* ---------- a trip on its way ---------- */
const sync = (s) => act(`sync:${s.id}`, () => post(`/admin/delivery/shipments/${s.id}/sync`), (r) => (r.status === s.status ? `${s.carrierName}: still ${STATUS_LABEL[r.status].toLowerCase()}` : `Updated: ${STATUS_LABEL[r.status].toLowerCase()}`))
async function cancel(s) {
  const ok = await confirm({
    title: 'Cancel this delivery?',
    body: s.carrier === 'rider' ? `${s.rider?.name ?? 'The rider'} won’t see it any more. You can send the order out again afterwards.` : `The parcel is cancelled with ${s.carrierName} too. You can send the order out again afterwards.`,
    confirmLabel: 'Cancel delivery',
    danger: true,
  })
  if (ok) act(`cancel:${s.id}`, () => post(`/admin/delivery/shipments/${s.id}/cancel`, {}), 'Delivery cancelled')
}

const reassign = reactive({ open: false, shipment: null, riderId: '', riders: [] })
async function openReassign(s) {
  Object.assign(reassign, { open: true, shipment: s, riderId: '', riders: [] })
  try {
    reassign.riders = (await get('/admin/delivery/options')).riders.filter((r) => r.id !== s.rider?.id)
  } catch (e) {
    toast(e.message, 'error')
  }
}
async function sendReassign() {
  if (!reassign.riderId) return toast('Choose a rider.', 'error')
  const r = await act('reassign', () => post(`/admin/delivery/shipments/${reassign.shipment.id}/reassign`, { riderId: reassign.riderId }), (x) => `Handed to ${x.rider.name}`)
  if (r) reassign.open = false
}

const override = reactive({ open: false, shipment: null, status: '', message: '', codCollected: '' })
function openOverride(s) {
  Object.assign(override, { open: true, shipment: s, status: '', message: '', codCollected: s.codAmount || '' })
}
async function sendOverride() {
  if (!override.status) return toast('Choose the status.', 'error')
  const s = override.shipment
  const r = await act(
    'override',
    () => post(`/admin/delivery/shipments/${s.id}/status`, {
      status: override.status,
      message: override.message.trim() || undefined,
      codCollected: override.status === 'DELIVERED' && s.codAmount ? Number(override.codCollected) : undefined,
    }),
    `Marked ${STATUS_LABEL[override.status].toLowerCase()}`,
  )
  if (r) override.open = false
}
</script>

<template>
  <section class="panel pad">
    <div class="head">
      <h2>Delivery</h2>
      <button v-can="'delivery.write'" v-if="o.canShip" class="btn sm primary" :disabled="!!busy" @click="openShip">
        <Icon name="delivery" :size="16" /> {{ trips.length ? 'Send again' : 'Send out' }}
      </button>
    </div>
    <p v-if="!trips.length" class="muted small">
      {{ o.canShip ? 'Not sent yet. Give it to one of your riders or book a courier.' : o.status === 'PENDING_PAYMENT' ? 'Can be sent once it’s paid.' : 'Nothing to deliver.' }}
    </p>

    <ul class="trips">
      <li v-for="s in trips" :key="s.id" :class="{ old: TERMINAL.includes(s.status) && s.status !== 'DELIVERED' }">
        <div class="line">
          <strong>{{ s.rider ? s.rider.name : s.carrierName }}</strong>
          <StatusTag :status="s.status" />
          <span v-if="s.sandbox" class="muted small">Sandbox</span>
        </div>
        <dl class="kv small">
          <template v-if="s.rider">
            <dt>Rider</dt>
            <dd><a :href="`tel:${s.rider.phone}`">{{ s.rider.phone }}</a></dd>
            <template v-if="s.deliveryCode && !TERMINAL.includes(s.status)">
              <dt>Customer’s code</dt>
              <dd class="mono">
                <span v-if="codeShown === s.id">{{ s.deliveryCode }}</span>
                <button v-else v-can.hide="'delivery.write'" type="button" class="btn ghost sm" @click="codeShown = s.id">Reveal</button>
                <span v-if="codeShown !== s.id" v-can.hide="'delivery.write'" class="muted small">Only if the customer can’t find it</span>
              </dd>
            </template>
          </template>
          <template v-if="s.consignmentId">
            <dt>Consignment</dt>
            <dd class="mono">{{ s.consignmentId }}</dd>
          </template>
          <template v-if="s.trackingCode && s.trackingCode !== s.consignmentId">
            <dt>Tracking</dt>
            <dd class="mono">{{ s.trackingCode }}</dd>
          </template>
          <template v-if="s.courierStatus">
            <dt>{{ s.carrierName }} says</dt>
            <dd>{{ s.courierStatus }}</dd>
          </template>
          <dt>Collect</dt>
          <dd class="figures">
            {{ s.codAmount ? taka(s.codAmount) : 'Nothing (paid)' }}
            <template v-if="s.codCollected != null && s.codAmount"> · {{ taka(s.codCollected) }} collected<template v-if="s.carrier === 'rider'">{{ s.codSettledAt ? ', handed in' : ', rider has it' }}</template></template>
          </dd>
          <template v-if="s.charge != null">
            <dt>Courier charge</dt>
            <dd class="figures">{{ taka(s.charge) }}</dd>
          </template>
          <dt>Invoice</dt>
          <dd class="mono">{{ s.invoice }}</dd>
        </dl>
        <p v-if="s.error" class="warn small">{{ s.error }}</p>
        <p v-if="s.status === 'RETURNED' && o.canShip" class="warn small">Back at the store. Send it again, or cancel the order to put the items back in stock.</p>

        <ol class="timeline">
          <li v-for="(e, i) in s.events" :key="i">
            <span class="dot" :class="{ now: i === s.events.length - 1 }" />
            <span class="what">{{ e.message }}</span>
            <span class="when">{{ dateTime(e.at) }}</span>
          </li>
        </ol>

        <div v-if="!TERMINAL.includes(s.status) || s.status === 'RETURNED'" class="actions">
          <a v-if="s.trackingUrl && !s.sandbox" :href="s.trackingUrl" target="_blank" rel="noopener" class="btn sm">Track on {{ s.carrierName }} <Icon name="external" :size="14" /></a>
          <button v-can="'delivery.write'" v-if="s.carrier !== 'rider' && !TERMINAL.includes(s.status)" class="btn sm" :disabled="!!busy" @click="sync(s)">
            {{ busy === `sync:${s.id}` ? 'Checking…' : `Check with ${s.carrierName}` }}
          </button>
          <button v-can="'delivery.write'" v-if="s.carrier === 'rider' && !TERMINAL.includes(s.status)" class="btn sm" :disabled="!!busy" @click="openReassign(s)">Hand to another rider</button>
          <button v-can="'delivery.write'" v-if="!TERMINAL.includes(s.status)" class="btn sm" :disabled="!!busy" @click="openOverride(s)">Set status</button>
          <button v-can="'delivery.write'" v-if="s.status === 'BOOKED'" class="btn sm danger" :disabled="!!busy" @click="cancel(s)">{{ busy === `cancel:${s.id}` ? 'Cancelling…' : 'Cancel' }}</button>
        </div>
      </li>
    </ul>

    <Dialog :open="form.open" title="Send the order out" @close="form.open = false">
      <form class="dialog-form" novalidate @submit.prevent="ship">
        <p v-if="form.error" class="form-error" role="alert">{{ form.error }}</p>
        <p v-if="options && !options.riders.length && !options.couriers.length" class="warn small">
          No riders or couriers yet. Add riders or set up a courier under <RouterLink to="/delivery?view=riders">Delivery</RouterLink>.
        </p>
        <fieldset v-if="options" class="carriers">
          <legend class="sr-only">Who takes it</legend>
          <label v-if="options.riders.length" class="carrier" :class="{ on: form.carrier === 'rider' }">
            <input v-model="form.carrier" type="radio" value="rider" />
            <span><strong>Own rider</strong><span class="sub">Your staff deliver it</span></span>
          </label>
          <label v-for="c in options.couriers" :key="c.id" class="carrier" :class="{ on: form.carrier === c.id }">
            <input v-model="form.carrier" type="radio" :value="c.id" />
            <span><strong>{{ c.name }}</strong><span class="sub">{{ c.sandbox ? (c.noSandbox ? 'Switch it to live to book' : 'Sandbox: test booking') : 'Courier pickup' }}</span></span>
          </label>
        </fieldset>

        <Field v-if="form.carrier === 'rider'" id="sh-rider" label="Rider">
          <select id="sh-rider" v-model="form.riderId" class="select">
            <option value="" disabled>Choose a rider</option>
            <option v-for="r in options.riders" :key="r.id" :value="r.id">{{ r.name }}{{ r.zone ? ` · ${r.zone}` : '' }} · {{ r.onTheWay }} on the way</option>
          </select>
        </Field>

        <template v-if="chosen">
          <Field v-for="l in chosen.levels" :id="`sh-loc-${l.key}`" :key="l.key" :label="`${chosen.name} ${l.label.toLowerCase()}`" :optional="l.optional">
            <select
              :id="`sh-loc-${l.key}`"
              class="select"
              :value="form.location[l.key] ?? ''"
              :disabled="!form.places[l.key]"
              @change="pick(l, $event.target.value)"
            >
              <option value="">{{ form.places[l.key] === null ? 'Loading…' : !form.places[l.key] ? `Choose the ${chosen.levels.find((x) => x.key === l.parent)?.label.toLowerCase()} first` : `Choose the ${l.label.toLowerCase()}` }}</option>
              <option v-for="p in form.places[l.key] ?? []" :key="p.id" :value="p.id">{{ p.name }}</option>
            </select>
          </Field>
        </template>

        <div class="two">
          <Field id="sh-phone" label="Customer’s phone" :hint="form.carrier && form.carrier !== 'rider' ? 'A Bangladeshi mobile number (01XXXXXXXXX).' : ''">
            <input id="sh-phone" v-model="form.phone" class="input" type="tel" />
          </Field>
          <Field id="sh-city" label="City"><input id="sh-city" v-model="form.city" class="input" /></Field>
        </div>
        <Field id="sh-address" label="Address"><input id="sh-address" v-model="form.address" class="input" maxlength="250" /></Field>
        <div class="two">
          <Field id="sh-cod" label="Cash to collect (taka)" :hint="unpaidCod ? `Cash on delivery: ${taka(o.payment.amountBdt)}.` : 'Paid already: nothing to collect.'">
            <input id="sh-cod" v-model="form.codAmount" class="input" type="number" min="0" step="1" />
          </Field>
          <Field id="sh-weight" label="Weight (kg)"><input id="sh-weight" v-model="form.weightKg" class="input" type="number" min="0.1" max="50" step="0.1" /></Field>
        </div>
        <Field id="sh-note" label="Note for the rider" optional>
          <input id="sh-note" v-model="form.note" class="input" maxlength="250" placeholder="Call before coming, fragile…" />
        </Field>
        <div class="dialog-buttons">
          <button type="button" class="btn" @click="form.open = false">Cancel</button>
          <button class="btn primary" :disabled="form.saving || !options">
            {{ form.saving ? 'Sending…' : form.carrier === 'rider' ? 'Assign to rider' : chosen ? `Book with ${chosen.name}` : 'Send' }}
          </button>
        </div>
      </form>
    </Dialog>

    <Dialog :open="reassign.open" title="Hand to another rider" @close="reassign.open = false">
      <form class="dialog-form" novalidate @submit.prevent="sendReassign">
        <Field id="ra-rider" label="Rider">
          <select id="ra-rider" v-model="reassign.riderId" class="select">
            <option value="" disabled>Choose a rider</option>
            <option v-for="r in reassign.riders" :key="r.id" :value="r.id">{{ r.name }} · {{ r.onTheWay }} on the way</option>
          </select>
        </Field>
        <div class="dialog-buttons">
          <button type="button" class="btn" @click="reassign.open = false">Cancel</button>
          <button class="btn primary" :disabled="busy === 'reassign'">{{ busy === 'reassign' ? 'Saving…' : 'Hand over' }}</button>
        </div>
      </form>
    </Dialog>

    <Dialog :open="override.open" title="Set the delivery status" @close="override.open = false">
      <form v-if="override.shipment" class="dialog-form" novalidate @submit.prevent="sendOverride">
        <p class="muted small">For when {{ override.shipment.rider ? 'the rider can’t use the app' : `${override.shipment.carrierName} doesn’t report it` }}. The order follows, as if it had been reported.</p>
        <Field id="ov-status" label="Status">
          <select id="ov-status" v-model="override.status" class="select">
            <option value="" disabled>Choose</option>
            <option v-for="(label, k) in STATUS_LABEL" :key="k" :value="k" :disabled="k === override.shipment.status">{{ label }}</option>
          </select>
        </Field>
        <Field v-if="override.status === 'DELIVERED' && override.shipment.codAmount" id="ov-cod" label="Cash collected (taka)">
          <input id="ov-cod" v-model="override.codCollected" class="input" type="number" min="0" step="1" />
        </Field>
        <Field id="ov-msg" label="Note for the timeline" optional>
          <input id="ov-msg" v-model="override.message" class="input" maxlength="200" placeholder="Confirmed by phone with the customer" />
        </Field>
        <div class="dialog-buttons">
          <button type="button" class="btn" @click="override.open = false">Cancel</button>
          <button class="btn primary" :disabled="busy === 'override'">{{ busy === 'override' ? 'Saving…' : 'Save' }}</button>
        </div>
      </form>
    </Dialog>
  </section>
</template>

<style scoped>
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 10px;
}
.head h2 {
  margin: 0;
}
.trips {
  display: grid;
  gap: 16px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.trips > li {
  display: grid;
  gap: 8px;
}
.trips > li + li {
  padding-top: 14px;
  border-top: 1px solid var(--line);
}
.trips > li.old {
  opacity: 0.7;
}
.line {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.timeline {
  display: grid;
  gap: 8px;
  margin: 4px 0 0;
  padding: 0;
  list-style: none;
}
.timeline li {
  position: relative;
  display: grid;
  grid-template-columns: 14px 1fr;
  column-gap: 8px;
  font-size: 13px;
}
.timeline li:not(:last-child)::before {
  content: '';
  position: absolute;
  left: 4px;
  top: 12px;
  bottom: -10px;
  width: 2px;
  background: var(--line);
}
.dot {
  grid-row: span 2;
  width: 10px;
  height: 10px;
  margin-top: 4px;
  border-radius: 50%;
  background: var(--line-strong);
}
.dot.now {
  background: var(--accent);
}
.what {
  font-weight: 600;
}
.when {
  color: var(--muted);
  font-size: 12px;
}
.actions,
.dialog-buttons {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.dialog-buttons {
  justify-content: flex-end;
}
.dialog-form {
  display: grid;
  gap: 14px;
}
.two {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.carriers {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 8px;
  margin: 0;
  padding: 0;
  border: 0;
}
.carrier {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: 10px;
  cursor: pointer;
}
.carrier.on {
  border-color: var(--accent);
  box-shadow: 0 0 0 1px var(--accent);
}
.carrier input {
  margin-top: 3px;
}
.sub {
  display: block;
  color: var(--muted);
  font-size: 12px;
}
.warn {
  color: var(--warn);
}
.small {
  font-size: 12.5px;
}
.mono {
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
  font-size: 12.5px;
  word-break: break-all;
}
@media (max-width: 560px) {
  .two {
    grid-template-columns: 1fr;
  }
}
</style>
