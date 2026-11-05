<script setup>
import { computed, ref } from 'vue'
import PageHeader from '../components/PageHeader.vue'
import StatusTag from '../components/StatusTag.vue'
import StateBlock from '../components/StateBlock.vue'
import Tabs from '../components/Tabs.vue'
import SearchBox from '../components/SearchBox.vue'
import Pager from '../components/Pager.vue'
import { get, patch } from '../api.js'
import { refreshBadges } from '../badges.js'
import { useDebouncedSearch, useQueryState, useResource, clampPage } from '../composables.js'
import { ago, money } from '../format.js'
import { toast } from '../toast.js'

const STATUSES = [
  ['RECEIVED', 'Received'],
  ['SOURCING', 'Sourcing'],
  ['FOUND', 'Found'],
  ['UNAVAILABLE', 'Unavailable'],
]
const { state: q, set } = useQueryState({ status: '', q: '', page: 1 })
const search = useDebouncedSearch(q, set)
const { data, loading, error, reload } = useResource(() => get('/admin/requests', { ...q.value, limit: 20 }), q)
const status = computed({ get: () => q.value.status, set: (v) => set({ status: v }) })
const tabs = computed(() => [{ value: '', label: 'All', count: data.value?.counts.ALL }, ...STATUSES.map(([value, label]) => ({ value, label, count: data.value?.counts[value] }))])
const busy = ref('')

async function setStatus(r, next) {
  busy.value = r.id
  try {
    Object.assign(r, await patch(`/admin/requests/${r.id}`, { status: next }))
    toast(`Request marked as ${next.toLowerCase()}`)
    refreshBadges({ force: true })
    reload({ quiet: true })
  } catch (e) {
    toast(e.message, 'error')
  } finally {
    busy.value = ''
  }
}
const host = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}
clampPage(data, set)
</script>

<template>
  <div>
    <PageHeader title="Requests" description="Products customers asked us to find. Customers see the status you set here in their account." />
    <section class="panel">
      <div class="toolbar">
        <Tabs v-model="status" label="Request status" :items="tabs" />
        <SearchBox v-model="search" label="Search requests" placeholder="Product, notes, name or email" />
      </div>
      <StateBlock :loading="loading && !data" :error="error" :empty="!data?.items.length" :empty-text="q.q || q.status ? 'No requests match these filters.' : 'No requests yet. Customers send them from the Request a product page.'" @retry="reload">
        <ul class="requests">
          <li v-for="r in data.items" :key="r.id">
            <div class="main">
              <div class="head">
                <strong>{{ r.product }}</strong>
                <StatusTag :status="r.status" />
              </div>
              <dl class="facts">
                <div><dt>Category</dt><dd>{{ r.category }}</dd></div>
                <div v-if="r.size"><dt>Size</dt><dd>{{ r.size }}</dd></div>
                <div v-if="r.budget"><dt>Budget</dt><dd class="figures">Up to {{ money(r.budget) }}</dd></div>
                <div v-if="r.link"><dt>Example</dt><dd><a :href="r.link" target="_blank" rel="noopener noreferrer">{{ host(r.link) }}</a></dd></div>
              </dl>
              <p v-if="r.notes" class="notes">{{ r.notes }}</p>
              <span class="muted by">
                From <RouterLink :to="`/customers/${r.customer.id}`">{{ r.customer.name }}</RouterLink>
                (<a :href="`mailto:${r.email}`">{{ r.email }}</a>), {{ ago(r.createdAt) }}
              </span>
            </div>
            <div class="side">
              <label :for="`st-${r.id}`">Status</label>
              <select v-can="'requests.write'" :id="`st-${r.id}`" class="select sm" :value="r.status" :disabled="busy === r.id" @change="setStatus(r, $event.target.value)">
                <option v-for="[v, l] in STATUSES" :key="v" :value="v">{{ l }}</option>
              </select>
            </div>
          </li>
        </ul>
        <Pager :page="data.page" :pages="data.pages" :total="data.total" :limit="data.limit" noun="requests" @go="set({ page: $event })" />
      </StateBlock>
    </section>
  </div>
</template>

<style scoped>
.requests {
  margin: 0;
  padding: 0;
  list-style: none;
}
.requests li {
  display: flex;
  gap: 20px;
  padding: 16px 18px;
  border-top: 1px solid var(--line);
}
.requests li:first-child {
  border-top: 0;
}
.main {
  display: grid;
  gap: 8px;
  flex: 1;
  min-width: 0;
}
.head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  font-size: 15px;
}
.facts {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 24px;
  margin: 0;
  font-size: 13px;
}
.facts dt {
  display: inline;
  color: var(--muted);
  margin-right: 6px;
}
.facts dd {
  display: inline;
  margin: 0;
  font-weight: 650;
}
.notes {
  max-width: 72ch;
  padding: 8px 12px;
  border-left: 3px solid var(--line-strong);
  color: var(--ink-2);
  font-size: 13.5px;
}
.by {
  font-size: 12.5px;
}
.side {
  display: grid;
  align-content: start;
  gap: 6px;
  width: 150px;
  flex-shrink: 0;
}
.side label {
  font-size: 12.5px;
  font-weight: 700;
}
@media (max-width: 640px) {
  .requests li {
    flex-direction: column;
    gap: 12px;
  }
}
</style>
