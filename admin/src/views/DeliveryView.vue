<script setup>
import { computed, reactive, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import PageHeader from '../components/PageHeader.vue'
import StatusTag from '../components/StatusTag.vue'
import StateBlock from '../components/StateBlock.vue'
import Tabs from '../components/Tabs.vue'
import SearchBox from '../components/SearchBox.vue'
import Pager from '../components/Pager.vue'
import Field from '../components/Field.vue'
import Dialog from '../components/Dialog.vue'
import Icon from '../components/Icon.vue'
import { api, get, patch, post } from '../api.js'
import { confirm } from '../confirm.js'
import { useDebouncedSearch, useQueryState, useResource, clampPage } from '../composables.js'
import { ago, date, dateTime, plural, taka, time } from '../format.js'
import { toast } from '../toast.js'

const router = useRouter()
const CARRIER = { rider: 'Own riders', pathao: 'Pathao', steadfast: 'Steadfast', redx: 'RedX' }
const VEHICLE = { bike: 'Motorbike', bicycle: 'Bicycle', van: 'Van', walk: 'On foot' }
const { state: q, set } = useQueryState({ view: 'shipments', status: 'ACTIVE', carrier: '', q: '', page: 1 })
const view = computed({ get: () => q.value.view, set: (v) => set({ view: v }) })
const views = [
  { value: 'shipments', label: 'Shipments' },
  { value: 'riders', label: 'Riders' },
  { value: 'couriers', label: 'Couriers' },
]
const busy = ref('')
async function run(key, fn, done) {
  busy.value = key
  try {
    const r = await fn()
    if (done) toast(typeof done === 'function' ? done(r) : done)
    return r
  } catch (e) {
    toast(e.message, 'error')
  } finally {
    busy.value = ''
  }
}

/* ---------- shipments ---------- */
const search = useDebouncedSearch(q, set)
const listQuery = computed(() => (q.value.view === 'shipments' ? { status: q.value.status, carrier: q.value.carrier, q: q.value.q, page: q.value.page } : null))
const { data: list, loading: listLoading, error: listError, reload: reloadList } = useResource(
  () => (listQuery.value ? get('/admin/delivery/shipments', { ...listQuery.value, limit: 25 }) : null),
  listQuery,
)
const status = computed({ get: () => q.value.status, set: (v) => set({ status: v }) })
const carrier = computed({ get: () => q.value.carrier, set: (v) => set({ carrier: v }) })
const statusTabs = computed(() => {
  const c = list.value?.counts ?? {}
  return [
    { value: 'ACTIVE', label: 'On the way', count: c.ACTIVE },
    { value: 'ATTENTION', label: 'Needs a look', count: list.value?.problems },
    { value: 'DELIVERED', label: 'Delivered', count: c.DELIVERED },
    { value: 'RETURNED', label: 'Returned', count: c.RETURNED },
    { value: 'CANCELLED', label: 'Cancelled', count: c.CANCELLED },
    { value: '', label: 'All' },
  ]
})
const EMPTY = {
  ACTIVE: 'Nothing on the way. Send an order out from its order page.',
  ATTENTION: 'Nothing needs a look.',
}

/* ---------- riders ---------- */
const { data: riders, loading: ridersLoading, error: ridersError, reload: reloadRiders } = useResource(
  () => (q.value.view === 'riders' ? get('/admin/delivery/riders') : null),
  () => q.value.view,
)
const riderForm = reactive({ open: false, id: null, name: '', email: '', phone: '', zone: '', vehicle: 'bike', password: '', active: true, error: '', saving: false })
function openRider(r) {
  Object.assign(riderForm, r
    ? { open: true, id: r.id, name: r.name, email: r.email, phone: r.phone, zone: r.zone ?? '', vehicle: r.vehicle ?? 'bike', password: '', active: r.active, error: '', saving: false }
    : { open: true, id: null, name: '', email: '', phone: '', zone: '', vehicle: 'bike', password: '', active: true, error: '', saving: false })
}
async function saveRider() {
  const f = riderForm
  f.error = ''
  if (f.name.trim().length < 2) return (f.error = 'Enter the rider’s name.')
  if (!f.id && !/^\S+@\S+\.\S+$/.test(f.email.trim())) return (f.error = 'Enter an email for the rider to sign in with.')
  if (!/^\+?[0-9][0-9 ()-]{6,19}$/.test(f.phone.trim())) return (f.error = 'Enter the rider’s phone number.')
  if (!f.id && !f.password) return (f.error = 'Choose a password for the rider app.')
  f.saving = true
  try {
    const body = { name: f.name.trim(), phone: f.phone.trim(), zone: f.zone.trim(), vehicle: f.vehicle, ...(f.password ? { password: f.password } : {}) }
    if (f.id) await patch(`/admin/delivery/riders/${f.id}`, { ...body, active: f.active })
    else await post('/admin/delivery/riders', { ...body, email: f.email.trim() })
    toast(f.id ? 'Rider updated' : `${f.name.trim()} can now sign in to the rider app`)
    f.open = false
    reloadRiders({ quiet: true })
  } catch (e) {
    f.error = e.message
  } finally {
    f.saving = false
  }
}
async function settle(r) {
  const ok = await confirm({
    title: `Received ${taka(r.cashHeld.amount)} from ${r.name}?`,
    body: `Cash on delivery from ${plural(r.cashHeld.parcels, 'parcel')}. Only confirm once you have the cash in hand.`,
    confirmLabel: 'Cash received',
  })
  if (ok) run(`settle:${r.id}`, () => post(`/admin/delivery/riders/${r.id}/settle`), `${taka(r.cashHeld.amount)} from ${r.name} recorded`).then(() => reloadRiders({ quiet: true }))
}
const RIDER_APP = `${window.location.origin}/rider`
const copy = (text) => navigator.clipboard?.writeText(text).then(() => toast('Copied'))

/* ---------- couriers ---------- */
const { data: cfg, loading: cfgLoading, error: cfgError, reload: reloadCfg } = useResource(
  () => (q.value.view === 'couriers' ? get('/admin/delivery/couriers') : null),
  () => q.value.view,
)
const forms = reactive({})
watch(
  cfg,
  (c) => {
    for (const k of c?.couriers ?? []) forms[k.id] = { values: Object.fromEntries(k.fields.map((f) => [f.key, f.secret ? '' : (f.value ?? '')])) }
  },
  { immediate: true },
)
const saveCourier = (k, body, done) => run(`c:${k.id}`, () => api(`/admin/delivery/couriers/${k.id}`, { method: 'PUT', body }), done).then((r) => r && (cfg.value = r))
function changes(k) {
  const out = {}
  for (const f of k.fields) {
    const v = (forms[k.id].values[f.key] ?? '').trim()
    if (f.secret ? v : v !== (f.value ?? '')) out[f.key] = v
  }
  return out
}
function saveCreds(k) {
  const credentials = changes(k)
  if (!Object.keys(credentials).length) return toast('Nothing to save: type a new value first.', 'error')
  saveCourier(k, { credentials }, `${k.name} settings saved`)
}
async function clearField(k, f) {
  const ok = await confirm({ title: `Remove the ${f.label.toLowerCase()}?`, body: `${k.name} can’t book parcels until it’s entered again.`, confirmLabel: 'Remove', danger: true })
  if (ok) saveCourier(k, { credentials: { [f.key]: '' } }, `${f.label} removed`)
}
async function setLive(k, live) {
  if (live) {
    const ok = await confirm({
      title: `Book real parcels with ${k.name}?`,
      body: `${k.name} will send riders to pick parcels up and charge its delivery fee. Make sure these are your live credentials and a sandbox booking worked.`,
      confirmLabel: 'Go live',
    })
    if (!ok) return
  }
  saveCourier(k, { live }, `${k.name} is now in ${live ? 'live' : 'sandbox'} mode`)
}
const setEnabled = (k, enabled) => saveCourier(k, { enabled }, `${k.name} ${enabled ? 'can take parcels' : 'switched off'}`)
const test = (k) => run(`t:${k.id}`, () => post(`/admin/delivery/couriers/${k.id}/test`), (r) => r.message)
const NOTES = {
  pathao: 'Uses your Pathao merchant API client and login. Parcels are booked from your store (pickup point); picking the customer’s city and zone is optional, since Pathao reads them from the address. Pathao has no cancel API: cancel a parcel in its merchant panel. The sandbox’s public test account is in Pathao’s developer docs.',
  steadfast: 'Steadfast has no test mode: Test connection is safe (it reads your balance), but every booking is a real parcel, so it books only once switched to live. It needs no area list. Set the webhook URL and a bearer token in the Steadfast panel (the same token here) for instant updates.',
  redx: 'Each parcel needs the delivery area from RedX’s list. Set the webhook URL in the RedX merchant panel so parcels update as they move.',
}
clampPage(list, set)
</script>

<template>
  <div>
    <PageHeader title="Delivery" description="Your own riders and the couriers you book with, and every parcel on its way.">
      <Tabs v-model="view" label="Delivery view" :items="views" />
    </PageHeader>

    <!-- Shipments -->
    <section v-if="view === 'shipments'" class="panel">
      <div class="toolbar">
        <Tabs v-model="status" label="Shipment status" :items="statusTabs" />
        <select v-model="carrier" class="select" aria-label="Carrier">
          <option value="">Every carrier</option>
          <option v-for="(label, id) in CARRIER" :key="id" :value="id">{{ label }}</option>
        </select>
        <SearchBox v-model="search" label="Search shipments" placeholder="Order, consignment or tracking code" />
      </div>
      <StateBlock
        :loading="listLoading && !list"
        :error="listError"
        :empty="!list?.items.length"
        :empty-text="q.q ? `No shipments match “${q.q}”.` : (EMPTY[q.status] ?? 'No shipments here.')"
        @retry="reloadList"
      >
        <div class="table-wrap">
          <table class="table">
            <thead>
              <tr>
                <th>Sent</th>
                <th>Order</th>
                <th>With</th>
                <th>To</th>
                <th class="num">Collect</th>
                <th>Status</th>
                <th>Last update</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="s in list.items" :key="s.id" class="row-link" @click="router.push(`/orders/${s.orderId}`)">
                <td>
                  {{ date(s.createdAt) }}
                  <span class="sub">{{ time(s.createdAt) }}</span>
                </td>
                <td class="primary-cell">
                  <RouterLink :to="`/orders/${s.orderId}`" @click.stop>{{ s.invoice }}</RouterLink>
                  <span v-if="s.trackingCode" class="sub mono">{{ s.trackingCode }}</span>
                </td>
                <td>
                  {{ s.rider ? s.rider.name : s.carrierName }}
                  <span class="sub">{{ s.rider ? 'Own rider' : s.sandbox ? 'Sandbox' : s.courierStatus ?? '' }}</span>
                </td>
                <td>
                  {{ s.recipient.name }}
                  <span class="sub">{{ s.recipient.city }}</span>
                </td>
                <td class="num">
                  <strong v-if="s.codAmount">{{ taka(s.codAmount) }}</strong>
                  <span v-else class="muted">Paid</span>
                </td>
                <td>
                  <StatusTag :status="s.status" />
                  <span v-if="s.error" class="sub warn" :title="s.error">Needs a look</span>
                </td>
                <td class="muted">{{ ago(s.updatedAt) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <Pager :page="list.page" :pages="list.pages" :total="list.total" :limit="list.limit" noun="shipments" @go="set({ page: $event })" />
      </StateBlock>
    </section>

    <!-- Riders -->
    <StateBlock v-else-if="view === 'riders'" :loading="ridersLoading && !riders" :error="ridersError" @retry="reloadRiders">
      <section v-if="riders" class="panel">
        <div class="panel-head">
          <h2>{{ plural(riders.filter((r) => r.active).length, 'active rider') }}</h2>
          <button v-can="'delivery.write'" class="btn primary sm push" @click="openRider()"><Icon name="plus" :size="16" /> Add rider</button>
        </div>
        <p class="panel-body muted small app-link">
          Riders sign in on their phone at
          <button type="button" class="link-btn mono" title="Copy" @click="copy(RIDER_APP)">{{ RIDER_APP }}</button>
          with the email and password you give them. They see their parcels, call the customer, and mark each step; delivery needs the 4-digit code the customer has on their order page.
        </p>
        <StateBlock :empty="!riders.length" empty-text="No riders yet. Add the people who deliver for you, then assign orders to them from each order page.">
          <div class="table-wrap">
            <table class="table">
              <thead>
                <tr>
                  <th>Rider</th>
                  <th>Phone</th>
                  <th>Covers</th>
                  <th class="num">On the way</th>
                  <th class="num">Delivered</th>
                  <th class="num">Cash held</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                <tr v-for="r in riders" :key="r.id" :class="{ muted: !r.active }">
                  <td class="primary-cell">
                    <strong>{{ r.name }}</strong>
                    <StatusTag v-if="!r.active" status="INACTIVE" />
                    <span class="sub">{{ r.email }}</span>
                  </td>
                  <td><a :href="`tel:${r.phone}`">{{ r.phone }}</a></td>
                  <td>
                    {{ r.zone || '—' }}
                    <span class="sub">{{ VEHICLE[r.vehicle] ?? '' }}</span>
                  </td>
                  <td class="num">
                    <RouterLink v-if="r.onTheWay" :to="{ query: { view: 'shipments', status: 'ACTIVE', carrier: 'rider', q: '' } }">{{ r.onTheWay }}</RouterLink>
                    <span v-else>0</span>
                  </td>
                  <td class="num">{{ r.delivered }}</td>
                  <td class="num">
                    <strong v-if="r.cashHeld.amount">{{ taka(r.cashHeld.amount) }}</strong>
                    <span v-else class="muted">—</span>
                    <span v-if="r.cashHeld.parcels" class="sub">{{ plural(r.cashHeld.parcels, 'parcel') }}</span>
                  </td>
                  <td class="actions">
                    <button v-can="'payments.write'" v-if="r.cashHeld.amount" class="btn sm" :disabled="!!busy" @click="settle(r)">{{ busy === `settle:${r.id}` ? 'Saving…' : 'Cash received' }}</button>
                    <button v-can="'delivery.write'" class="btn sm" @click="openRider(r)">Edit</button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </StateBlock>
      </section>
    </StateBlock>

    <!-- Couriers -->
    <StateBlock v-else :loading="cfgLoading && !cfg" :error="cfgError" @retry="reloadCfg">
      <template v-if="cfg">
        <p v-if="!cfg.secretsKeySet" class="banner danger" role="alert">
          <Icon name="alert" :size="18" />
          <span>Credentials can’t be saved yet. Add <code>PAYMENT_SECRETS_KEY</code> (any long random string) to backend/.env and restart the API: it encrypts every key stored here.</span>
        </p>
        <div class="couriers">
          <section v-for="k in cfg.couriers" :key="k.id" class="panel">
            <div class="panel-head">
              <h2>{{ k.name }}</h2>
              <StatusTag :status="k.configured ? (k.enabled ? 'ACTIVE' : 'OFF') : 'NOT_SET_UP'" />
              <label class="switch mode">
                <input type="checkbox" role="switch" :checked="k.live" :disabled="busy === `c:${k.id}` || !k.configured" @change="setLive(k, !k.live)" />
                <StatusTag :status="k.live ? 'LIVE' : 'SANDBOX'" :label="k.noSandbox && !k.live ? 'Not live yet' : undefined" />
                <span class="sr-only">{{ k.live ? (k.noSandbox ? 'Stop booking with it' : 'Switch to sandbox') : 'Switch to live' }}</span>
              </label>
            </div>
            <form class="panel-body fields" novalidate autocomplete="off" @submit.prevent="saveCreds(k)">
              <label class="switch">
                <input type="checkbox" role="switch" :checked="k.enabled" :disabled="busy === `c:${k.id}` || !k.configured" @change="setEnabled(k, !k.enabled)" />
                <span>Offer {{ k.name }} when sending an order out</span>
              </label>
              <Field v-for="f in k.fields" :id="`${k.id}-${f.key}`" :key="f.key" :label="f.label" :optional="f.optional" :hint="f.hint">
                <input
                  :id="`${k.id}-${f.key}`"
                  v-model="forms[k.id].values[f.key]"
                  class="input"
                  :type="f.secret ? 'password' : 'text'"
                  spellcheck="false"
                  :autocomplete="f.secret ? 'new-password' : 'off'"
                  :placeholder="f.secret && f.set ? 'Saved. Type a new one to replace it.' : ''"
                />
                <button v-can="'settings.write'" v-if="f.set" type="button" class="link-btn small" @click="clearField(k, f)">Remove</button>
              </Field>
              <div v-if="k.webhookUrl" class="callback">
                <span class="muted small">Webhook URL to give {{ k.name }}</span>
                <button type="button" class="link-btn mono" title="Copy" @click="copy(k.webhookUrl)">{{ k.webhookUrl }}</button>
              </div>
              <p class="muted small">{{ NOTES[k.id] }}</p>
              <div class="buttons">
                <button v-can="'settings.write'" class="btn primary" :disabled="!!busy">{{ busy === `c:${k.id}` ? 'Saving…' : 'Save' }}</button>
                <button v-can="'settings.write'" type="button" class="btn" :disabled="!k.configured || !!busy" @click="test(k)">{{ busy === `t:${k.id}` ? 'Testing…' : 'Test connection' }}</button>
              </div>
              <p v-if="k.updatedAt" class="muted small">Last changed {{ dateTime(k.updatedAt) }}.</p>
            </form>
          </section>
        </div>
      </template>
    </StateBlock>

    <Dialog :open="riderForm.open" :title="riderForm.id ? `Edit ${riderForm.name}` : 'Add a rider'" @close="riderForm.open = false">
      <form class="dialog-form" novalidate autocomplete="off" @submit.prevent="saveRider">
        <p v-if="riderForm.error" class="form-error" role="alert">{{ riderForm.error }}</p>
        <Field id="rd-name" label="Name"><input id="rd-name" v-model="riderForm.name" class="input" maxlength="80" /></Field>
        <Field v-if="!riderForm.id" id="rd-email" label="Email" hint="They sign in to the rider app with it.">
          <input id="rd-email" v-model="riderForm.email" class="input" type="email" autocomplete="off" />
        </Field>
        <Field id="rd-phone" label="Phone" hint="Customers see it while the rider has their parcel.">
          <input id="rd-phone" v-model="riderForm.phone" class="input" type="tel" placeholder="01711-000000" />
        </Field>
        <div class="two">
          <Field id="rd-zone" label="Areas covered" optional><input id="rd-zone" v-model="riderForm.zone" class="input" maxlength="120" placeholder="Dhanmondi, Mohammadpur" /></Field>
          <Field id="rd-vehicle" label="Gets around by">
            <select id="rd-vehicle" v-model="riderForm.vehicle" class="select">
              <option v-for="(label, id) in VEHICLE" :key="id" :value="id">{{ label }}</option>
            </select>
          </Field>
        </div>
        <Field id="rd-pass" :label="riderForm.id ? 'New password' : 'Password'" :optional="!!riderForm.id" hint="8+ characters mixing upper and lower case, numbers or symbols.">
          <input id="rd-pass" v-model="riderForm.password" class="input" type="password" autocomplete="new-password" />
        </Field>
        <label v-if="riderForm.id" class="check-row">
          <input v-model="riderForm.active" type="checkbox" />
          <span>Active: can sign in and be given parcels</span>
        </label>
        <div class="dialog-buttons">
          <button type="button" class="btn" @click="riderForm.open = false">Cancel</button>
          <button class="btn primary" :disabled="riderForm.saving">{{ riderForm.saving ? 'Saving…' : riderForm.id ? 'Save' : 'Add rider' }}</button>
        </div>
      </form>
    </Dialog>
  </div>
</template>

<style scoped>
.banner {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  margin: 0 0 18px;
  padding: 14px 16px;
  border-radius: var(--r-panel);
  background: var(--danger-soft);
  color: var(--danger);
}
.couriers {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(340px, 1fr));
  gap: 18px;
  align-items: start;
}
.sub {
  display: block;
  color: var(--muted);
  font-size: 12.5px;
}
.warn {
  color: var(--warn);
}
.small {
  font-size: 13px;
}
.mono {
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
  font-size: 12.5px;
}
.push {
  margin-left: auto;
}
.app-link {
  border-bottom: 1px solid var(--line);
}
.actions {
  display: flex;
  gap: 6px;
  justify-content: flex-end;
}
tr.muted td {
  color: var(--muted);
}
.panel-head .mode {
  margin-left: auto;
}
.fields,
.dialog-form {
  display: grid;
  gap: 14px;
}
.two {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.callback {
  display: grid;
  gap: 2px;
}
.link-btn.mono {
  justify-self: start;
  text-align: left;
  word-break: break-all;
}
.buttons,
.dialog-buttons {
  display: flex;
  gap: 10px;
}
.dialog-buttons {
  justify-content: flex-end;
}
.check-row {
  display: flex;
  gap: 10px;
  align-items: center;
  font-size: 14px;
}
.switch {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  font-size: 14px;
}
.switch input {
  appearance: none;
  width: 34px;
  height: 20px;
  margin: 0;
  border-radius: 999px;
  background: var(--line-strong);
  position: relative;
  cursor: pointer;
  transition: background 0.15s ease;
  flex: none;
}
.switch input::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #fff;
  transition: transform 0.15s ease;
}
.switch input:checked {
  background: var(--accent);
}
.switch input:checked::after {
  transform: translateX(14px);
}
.switch input:disabled {
  opacity: 0.45;
  cursor: default;
}
@media (max-width: 560px) {
  .two {
    grid-template-columns: 1fr;
  }
}
</style>
