<script setup>
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import PageHeader from '../components/PageHeader.vue'
import StatusTag from '../components/StatusTag.vue'
import StateBlock from '../components/StateBlock.vue'
import Tabs from '../components/Tabs.vue'
import SearchBox from '../components/SearchBox.vue'
import Pager from '../components/Pager.vue'
import { get, patch } from '../api.js'
import { useDebouncedSearch, useQueryState, useResource, clampPage } from '../composables.js'
import { RETURN_REASON, date, money, plural, taka, time } from '../format.js'
import { toast } from '../toast.js'

const router = useRouter()
const REASON = RETURN_REASON
const { state: q, set } = useQueryState({ status: 'REQUESTED', q: '', page: 1 })
const search = useDebouncedSearch(q, set)
const status = computed({ get: () => q.value.status, set: (v) => set({ status: v }) })
const query = computed(() => ({ ...q.value }))
const { data, loading, error, reload } = useResource(() => get('/admin/returns', { ...query.value, limit: 25 }), query)
const tabs = computed(() => {
  const c = data.value?.counts ?? {}
  return [
    { value: 'REQUESTED', label: 'To decide', count: c.REQUESTED },
    { value: 'APPROVED', label: 'Coming back', count: c.APPROVED },
    { value: 'RECEIVED', label: 'To refund', count: c.RECEIVED },
    { value: 'REFUNDED', label: 'Refunded', count: c.REFUNDED },
    { value: 'REJECTED', label: 'Turned down', count: c.REJECTED },
    { value: '', label: 'All', count: c.ALL },
  ]
})
const EMPTY = { REQUESTED: 'No returns waiting for a decision.', APPROVED: 'Nothing on its way back.', RECEIVED: 'Nothing waiting to be refunded.' }

const windowDays = ref(null)
const saving = ref(false)
async function saveWindow() {
  const n = Number(windowDays.value ?? data.value.windowDays)
  if (!(n >= 0 && n <= 90)) return toast('Between 0 and 90 days.', 'error')
  saving.value = true
  try {
    await patch('/admin/returns/settings', { windowDays: n })
    toast(n ? `Shoppers can return items for ${n} days after delivery` : 'Returns switched off')
    reload({ quiet: true })
  } catch (e) {
    toast(e.message, 'error')
  } finally {
    saving.value = false
  }
}
clampPage(data, set)

// Where Pip sends an upset shopper or a problem it can't fix. With nothing set, Pip doesn't offer a person.
const support = ref(null)
get('/admin/support').then((s) => (support.value = { whatsapp: s.whatsapp ?? '', phone: s.phone ?? '', hours: s.hours ?? '' })).catch(() => {})
const savingSupport = ref(false)
async function saveSupport() {
  savingSupport.value = true
  try {
    const s = support.value
    await patch('/admin/support', { whatsapp: s.whatsapp.replace(/\D/g, '') || null, phone: s.phone.trim() || null, hours: s.hours.trim() || null })
    toast(s.whatsapp || s.phone ? 'Pip will offer these when a shopper needs a person' : 'Support contact cleared: Pip won’t offer a person')
  } catch (e) {
    toast(e.message, 'error')
  } finally {
    savingSupport.value = false
  }
}
</script>

<template>
  <div>
    <PageHeader title="Returns" description="Items shoppers are sending back: decide, collect, inspect and refund.">
      <form v-if="data" class="window" @submit.prevent="saveWindow">
        <label for="win" class="muted small">Return window</label>
        <input id="win" class="input" type="number" min="0" max="90" :placeholder="String(data.windowDays)" :value="windowDays ?? data.windowDays" @input="windowDays = $event.target.value" />
        <span class="muted small">days after delivery</span>
        <button v-can="'settings.write'" class="btn sm" :disabled="saving">{{ saving ? 'Saving…' : 'Save' }}</button>
      </form>
    </PageHeader>
    <form v-if="support" class="panel support" @submit.prevent="saveSupport">
      <div class="support-head">
        <b>Support contact</b>
        <span class="muted small">When a shopper is upset or has a problem Pip can’t fix, Pip shows these. Leave both empty and Pip won’t offer a person.</span>
      </div>
      <label>WhatsApp<input v-model="support.whatsapp" class="input" inputmode="numeric" placeholder="8801712345678" /></label>
      <label>Phone<input v-model="support.phone" class="input" placeholder="+880 9612 345678" /></label>
      <label>Hours<input v-model="support.hours" class="input" maxlength="60" placeholder="Sat–Thu, 10am–8pm" /></label>
      <button v-can="'settings.write'" class="btn sm" :disabled="savingSupport">{{ savingSupport ? 'Saving…' : 'Save' }}</button>
    </form>

    <section class="panel">
      <div class="toolbar">
        <Tabs v-model="status" label="Return status" :items="tabs" />
        <SearchBox v-model="search" label="Search returns" placeholder="Return, order, customer" />
      </div>
      <StateBlock :loading="loading && !data" :error="error" :empty="!data?.items.length" :empty-text="q.q ? `No returns match “${q.q}”.` : (EMPTY[q.status] ?? 'No returns here.')" @retry="reload">
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th>Asked</th><th>Return</th><th>Customer</th><th>Items</th><th>Why</th><th class="num">Refund</th><th>Status</th></tr></thead>
            <tbody>
              <tr v-for="r in data.items" :key="r.id" class="row-link" @click="router.push(`/returns/${r.id}`)">
                <td>{{ date(r.createdAt) }}<span class="sub">{{ time(r.createdAt) }}</span></td>
                <td class="primary-cell"><RouterLink :to="`/returns/${r.id}`" @click.stop>{{ r.id }}</RouterLink><span class="sub">Order {{ r.orderId }}</span></td>
                <td>{{ r.customer.name }}<span class="sub">{{ r.customer.email }}</span></td>
                <td>{{ plural(r.items.reduce((n, i) => n + i.qty, 0), 'item') }}<span class="sub">{{ r.items.map((i) => i.name).join(', ') }}</span></td>
                <td>{{ REASON[r.reason] }}</td>
                <td class="num"><strong>{{ r.refundBdt != null ? taka(r.refundBdt) : money(r.refundUsd) }}</strong><span class="sub">{{ money(r.refundUsd) }}</span></td>
                <td><StatusTag :status="`RT_${r.status}`" /></td>
              </tr>
            </tbody>
          </table>
        </div>
        <Pager :page="data.page" :pages="data.pages" :total="data.total" :limit="data.limit" noun="returns" @go="set({ page: $event })" />
      </StateBlock>
    </section>
  </div>
</template>

<style scoped>
.window {
  display: flex;
  align-items: center;
  gap: 8px;
}
.window .input {
  width: 72px;
}
.sub {
  display: block;
  color: var(--muted);
  font-size: 12.5px;
}
.small {
  font-size: 13px;
}
.support {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 12px;
  margin-bottom: 16px;
}
.support-head {
  flex: 1 1 100%;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.support label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 13px;
  color: var(--muted);
}
.support .input {
  width: 200px;
}
</style>
