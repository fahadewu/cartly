<script setup>
import { can } from '../auth.js'
import { computed, reactive, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import PageHeader from '../components/PageHeader.vue'
import StatusTag from '../components/StatusTag.vue'
import StateBlock from '../components/StateBlock.vue'
import Tabs from '../components/Tabs.vue'
import SearchBox from '../components/SearchBox.vue'
import Pager from '../components/Pager.vue'
import Field from '../components/Field.vue'
import Icon from '../components/Icon.vue'
import { api, get, patch, post } from '../api.js'
import { confirm } from '../confirm.js'
import { useDebouncedSearch, useQueryState, useResource, clampPage } from '../composables.js'
import { date, dateTime, money, taka, time } from '../format.js'
import { toast } from '../toast.js'

const router = useRouter()
const METHOD = { bkash: 'bKash', nagad: 'Nagad', rocket: 'Rocket', card: 'Card', cod: 'Cash on delivery', demo: 'Demo card' }
const { state: q, set } = useQueryState({ view: 'transactions', status: '', method: '', q: '', page: 1 })
const view = computed({ get: () => q.value.view, set: (v) => set({ view: v }) })
// Gateway settings and credentials are for admins and managers.
const views = [{ value: 'transactions', label: 'Transactions' }, ...(can('settings.read') ? [{ value: 'settings', label: 'Settings' }] : [])]

/* ---------- transactions ---------- */
const search = useDebouncedSearch(q, set)
const txQuery = computed(() => (q.value.view === 'transactions' ? { status: q.value.status, method: q.value.method, q: q.value.q, page: q.value.page } : null))
const { data: tx, loading: txLoading, error: txError, reload: reloadTx } = useResource(() => (txQuery.value ? get('/admin/payments', { ...txQuery.value, limit: 25 }) : null), txQuery)
const status = computed({ get: () => q.value.status, set: (v) => set({ status: v }) })
const method = computed({ get: () => q.value.method, set: (v) => set({ method: v }) })
const statusTabs = computed(() => {
  const s = tx.value?.summary ?? {}
  const n = (k) => s[k]?.count ?? 0
  return [
    { value: '', label: 'All' },
    { value: 'PAID', label: 'Paid', count: n('PAID') },
    { value: 'PENDING', label: 'Pending', count: n('PENDING') },
    { value: 'FAILED', label: 'Failed', count: n('FAILED') },
    { value: 'CANCELLED', label: 'Cancelled', count: n('CANCELLED') },
    { value: 'REFUNDED', label: 'Refunded', count: n('REFUNDED') },
  ]
})

/* ---------- settings ---------- */
const { data: cfg, loading, error, reload } = useResource(() => (can('settings.read') ? get('/admin/payments/settings') : null))
const rate = ref('')
const forms = reactive({})
const busy = ref('')
watch(
  cfg,
  (c) => {
    if (!c) return
    rate.value = c.usdToBdt ?? ''
    for (const g of c.gateways) forms[g.id] = { values: Object.fromEntries(g.fields.map((f) => [f.key, f.secret ? '' : (f.value ?? '')])) }
  },
  { immediate: true },
)
const rateExample = computed(() => (Number(rate.value) > 0 ? `A ${money(50)} order is charged ${taka(50 * Number(rate.value))}.` : ''))

async function run(key, fn, done) {
  busy.value = key
  try {
    const r = await fn()
    if (r?.gateways) cfg.value = r
    if (done) toast(typeof done === 'function' ? done(r) : done)
    return r
  } catch (e) {
    toast(e.message, 'error')
  } finally {
    busy.value = ''
  }
}
function saveRate() {
  const n = Number(rate.value)
  if (!(n >= 1 && n <= 10000)) return toast('Enter how many taka a US dollar is worth, e.g. 122.50.', 'error')
  run('rate', () => patch('/admin/payments/settings', { usdToBdt: n }), `Checkout now charges ৳${n} per dollar`)
}
const toggle = (m) => run(`m:${m.id}`, () => patch('/admin/payments/settings', { methods: [{ id: m.id, enabled: !m.enabled }] }), `${m.label} ${m.enabled ? 'hidden from' : 'shown at'} checkout`)
function move(m, dir) {
  const list = [...cfg.value.methods]
  const i = list.indexOf(m)
  const j = i + dir
  if (j < 0 || j >= list.length) return
  ;[list[i], list[j]] = [list[j], list[i]]
  run(`m:${m.id}`, () => patch('/admin/payments/settings', { methods: list.map((x, position) => ({ id: x.id, position })) }))
}

const gatewayOf = (id) => cfg.value?.gateways.find((g) => g.id === id)
function changes(g) {
  const out = {}
  for (const f of g.fields) {
    const v = (forms[g.id].values[f.key] ?? '').trim()
    if (f.secret ? v : v !== (f.value ?? '')) out[f.key] = v
  }
  return out
}
async function saveGateway(g) {
  const credentials = changes(g)
  if (!Object.keys(credentials).length) return toast('Nothing to save: type a new value first.', 'error')
  await run(`g:${g.id}`, () => api(`/admin/payments/gateways/${g.id}`, { method: 'PUT', body: { credentials } }), `${g.name} settings saved`)
}
async function clearField(g, f) {
  const ok = await confirm({ title: `Remove the ${f.label.toLowerCase()}?`, body: `${g.name} stops working until it’s entered again, and checkout stops offering it.`, confirmLabel: 'Remove', danger: true })
  if (ok) run(`g:${g.id}`, () => api(`/admin/payments/gateways/${g.id}`, { method: 'PUT', body: { credentials: { [f.key]: '' } } }), `${f.label} removed`)
}
async function setLive(g, live) {
  if (live) {
    const ok = await confirm({
      title: `Take real payments with ${g.name}?`,
      body: 'Shoppers will be charged for real. Make sure these are your live credentials (not the sandbox ones) and that a test payment in the sandbox worked.',
      confirmLabel: 'Go live',
    })
    if (!ok) return
  }
  run(`g:${g.id}`, () => api(`/admin/payments/gateways/${g.id}`, { method: 'PUT', body: { live } }), `${g.name} is now in ${live ? 'live' : 'sandbox'} mode`)
}
const test = (g) => run(`t:${g.id}`, () => post(`/admin/payments/gateways/${g.id}/test`), (r) => r.message)
const copy = (text) => navigator.clipboard?.writeText(text).then(() => toast('Copied'))
const NOTES = {
  bkash: 'bKash allows two token requests an hour and blocks the app for an hour past that, so the store keeps one token for all its servers. Test connection uses it too.',
  nagad: 'In live mode Nagad only accepts the callback URL registered with it, from whitelisted server IPs. Refunds are made in Nagad’s merchant portal, then recorded on the order here.',
  sslcommerz: 'Takes Rocket (DBBL mobile banking) and cards. Set the IPN URL in the SSLCommerz panel too, so payments are confirmed even when a shopper closes the tab.',
}
clampPage(tx, set)
</script>

<template>
  <div>
    <PageHeader title="Payments" description="bKash, Nagad, Rocket and cards, cash on delivery, and the taka rate checkout charges at.">
      <Tabs v-model="view" label="Payments view" :items="views" />
    </PageHeader>

    <!-- Transactions -->
    <section v-if="view === 'transactions'" class="panel">
      <div class="toolbar">
        <Tabs v-model="status" label="Payment status" :items="statusTabs" />
        <select v-model="method" class="select" aria-label="Payment method">
          <option value="">Every method</option>
          <option v-for="(label, id) in METHOD" :key="id" :value="id">{{ label }}</option>
        </select>
        <SearchBox v-model="search" label="Search payments" placeholder="Invoice, transaction or order" />
      </div>
      <StateBlock
        :loading="txLoading && !tx"
        :error="txError"
        :empty="!tx?.items.length"
        :empty-text="q.q ? `No payments match “${q.q}”.` : 'No online payments yet. They appear here as soon as a shopper starts one.'"
        @retry="reloadTx"
      >
        <div class="table-wrap">
          <table class="table">
            <thead>
              <tr>
                <th>Started</th>
                <th>Order</th>
                <th>Customer</th>
                <th>Method</th>
                <th class="num">Amount</th>
                <th>Status</th>
                <th>Transaction</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="p in tx.items" :key="p.id" class="row-link" @click="router.push(`/orders/${p.order.id}`)">
                <td>
                  {{ date(p.createdAt) }}
                  <span class="sub">{{ time(p.createdAt) }}</span>
                </td>
                <td class="primary-cell">
                  <RouterLink :to="`/orders/${p.order.id}`" @click.stop>{{ p.order.id }}</RouterLink>
                  <span class="sub">{{ p.invoice }}</span>
                </td>
                <td>
                  {{ p.customer.name }}
                  <span class="sub">{{ p.customer.email }}</span>
                </td>
                <td>
                  {{ METHOD[p.method] ?? p.method }}
                  <span v-if="p.sandbox" class="sub">Sandbox</span>
                </td>
                <td class="num">
                  <strong>{{ taka(p.amount) }}</strong>
                  <span v-if="p.refunded" class="sub">{{ taka(p.refunded) }} refunded</span>
                </td>
                <td>
                  <StatusTag :status="p.status" />
                  <span v-if="p.error" class="sub warn" :title="p.error">Needs a look</span>
                </td>
                <td class="mono">{{ p.trxId ?? '—' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <Pager :page="tx.page" :pages="tx.pages" :total="tx.total" :limit="tx.limit" noun="payments" @go="set({ page: $event })" />
      </StateBlock>
    </section>

    <!-- Settings -->
    <StateBlock v-else :loading="loading && !cfg" :error="error" @retry="reload">
      <template v-if="cfg">
        <p v-if="!cfg.secretsKeySet" class="banner danger" role="alert">
          <Icon name="alert" :size="18" />
          <span>Credentials can’t be saved yet. Add <code>PAYMENT_SECRETS_KEY</code> (any long random string) to backend/.env and restart the API: it encrypts every key and password stored here.</span>
        </p>

        <div class="layout">
          <div class="stack">
            <section class="panel">
              <div class="panel-head"><h2>Taka rate</h2></div>
              <form class="panel-body rate" novalidate @submit.prevent="saveRate">
                <Field id="rate" label="One US dollar is" :hint="cfg.rateUpdatedAt ? `Last changed ${dateTime(cfg.rateUpdatedAt)}. ${rateExample}` : rateExample || 'Prices are in dollars; checkout charges the taka equivalent.'">
                  <div class="affix">
                    <span>৳</span>
                    <input id="rate" v-model="rate" class="input" type="number" min="1" step="0.01" placeholder="122.50" />
                  </div>
                </Field>
                <button v-can="'settings.write'" class="btn primary" :disabled="busy === 'rate'">{{ busy === 'rate' ? 'Saving…' : 'Save rate' }}</button>
              </form>
              <p v-if="!cfg.usdToBdt" class="panel-body warn small">Until a rate is set, only the demo card works at checkout.</p>
            </section>

            <section class="panel">
              <div class="panel-head"><h2>Checkout options</h2></div>
              <ul class="methods">
                <li v-for="(m, i) in cfg.methods" :key="m.id">
                  <label class="switch">
                    <input v-can="'settings.write'" type="checkbox" role="switch" :checked="m.enabled" :disabled="busy === `m:${m.id}` || (!m.enabled && !!m.unavailable)" @change="toggle(m)" />
                    <span class="sr-only">{{ m.enabled ? `Hide ${m.label}` : `Offer ${m.label}` }}</span>
                  </label>
                  <div class="grow">
                    <strong>{{ m.label }}</strong>
                    <span class="sub">{{ m.gateway ? `Through ${gatewayOf(m.gateway)?.name}` : m.id === 'cod' ? 'Paid to the courier; mark it paid on the order' : 'Test card for development only' }}</span>
                    <span v-if="m.unavailable" class="sub warn">{{ m.unavailable }}</span>
                  </div>
                  <div class="order-buttons">
                    <button v-can="'settings.write'" class="icon-btn" :disabled="i === 0 || !!busy" :aria-label="`Move ${m.label} up`" @click="move(m, -1)"><Icon name="up" :size="16" /></button>
                    <button v-can="'settings.write'" class="icon-btn" :disabled="i === cfg.methods.length - 1 || !!busy" :aria-label="`Move ${m.label} down`" @click="move(m, 1)"><Icon name="down" :size="16" /></button>
                  </div>
                </li>
              </ul>
              <p class="panel-body muted small">Shoppers see the options that are switched on, in this order. An option can only be switched on once its gateway is set up and the taka rate is saved.</p>
            </section>
          </div>

          <div class="stack">
            <section v-for="g in cfg.gateways" :key="g.id" class="panel">
              <div class="panel-head">
                <h2>{{ g.name }}</h2>
                <StatusTag :status="g.configured ? 'READY' : 'NOT_SET_UP'" />
                <label class="switch mode">
                  <input v-can="'settings.write'" type="checkbox" role="switch" :checked="g.live" :disabled="busy === `g:${g.id}` || !g.configured" @change="setLive(g, !g.live)" />
                  <StatusTag :status="g.live ? 'LIVE' : 'SANDBOX'" />
                  <span class="sr-only">{{ g.live ? 'Switch to sandbox' : 'Switch to live payments' }}</span>
                </label>
              </div>
              <form class="panel-body fields" novalidate autocomplete="off" @submit.prevent="saveGateway(g)">
                <Field v-for="f in g.fields" :id="`${g.id}-${f.key}`" :key="f.key" :label="f.label" :optional="f.optional" :hint="f.hint">
                  <textarea
                    v-if="f.multiline"
                    :id="`${g.id}-${f.key}`"
                    v-model="forms[g.id].values[f.key]"
                    class="textarea mono"
                    rows="3"
                    spellcheck="false"
                    :placeholder="f.secret && f.set ? 'Saved. Paste a new one to replace it.' : ''"
                  />
                  <input
                    v-else
                    :id="`${g.id}-${f.key}`"
                    v-model="forms[g.id].values[f.key]"
                    class="input"
                    :type="f.secret ? 'password' : 'text'"
                    spellcheck="false"
                    :autocomplete="f.secret ? 'new-password' : 'off'"
                    :placeholder="f.secret && f.set ? 'Saved. Type a new one to replace it.' : ''"
                  />
                  <button v-can="'settings.write'" v-if="f.set" type="button" class="link-btn small" @click="clearField(g, f)">Remove</button>
                </Field>
                <div v-for="(url, kind) in g.callbacks" :key="kind" class="callback">
                  <span class="muted small">{{ kind === 'ipn' ? 'IPN URL' : 'Callback URL' }} to give {{ g.name }}</span>
                  <button type="button" class="link-btn mono" :title="'Copy'" @click="copy(url)">{{ url }}</button>
                </div>
                <p class="muted small">{{ NOTES[g.id] }}</p>
                <div class="buttons">
                  <button v-can="'settings.write'" class="btn primary" :disabled="!!busy">{{ busy === `g:${g.id}` ? 'Saving…' : 'Save' }}</button>
                  <button v-can="'settings.write'" type="button" class="btn" :disabled="!g.configured || !!busy" @click="test(g)">{{ busy === `t:${g.id}` ? 'Testing…' : 'Test connection' }}</button>
                </div>
              </form>
            </section>
          </div>
        </div>
      </template>
    </StateBlock>
  </div>
</template>

<style scoped>
.layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.2fr);
  gap: 18px;
  align-items: start;
}
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
.rate {
  display: flex;
  align-items: flex-end;
  gap: 12px;
  flex-wrap: wrap;
}
.rate > :first-child {
  flex: 1;
  min-width: 220px;
}
.affix {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 700;
}
.affix .input {
  max-width: 160px;
}
.methods {
  margin: 0;
  padding: 0;
  list-style: none;
}
.methods li {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 12px 18px;
  border-top: 1px solid var(--line);
}
.methods li:first-child {
  border-top: 0;
}
.grow {
  display: grid;
  flex: 1;
  min-width: 0;
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
.order-buttons {
  display: flex;
  gap: 4px;
}
.icon-btn {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--surface);
  color: var(--ink-2);
  cursor: pointer;
}
.icon-btn:disabled {
  opacity: 0.4;
  cursor: default;
}
.panel-head .mode {
  margin-left: auto;
}
.fields {
  display: grid;
  gap: 14px;
}
.callback {
  display: grid;
  gap: 2px;
}
.callback .link-btn {
  justify-self: start;
  text-align: left;
  word-break: break-all;
}
.mono {
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
  font-size: 12.5px;
}
.buttons {
  display: flex;
  gap: 10px;
}
.switch {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
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
@media (max-width: 1100px) {
  .layout {
    grid-template-columns: 1fr;
  }
}
</style>
