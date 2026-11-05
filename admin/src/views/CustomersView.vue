<script setup>
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import PageHeader from '../components/PageHeader.vue'
import StatusTag from '../components/StatusTag.vue'
import StateBlock from '../components/StateBlock.vue'
import Tabs from '../components/Tabs.vue'
import SearchBox from '../components/SearchBox.vue'
import Pager from '../components/Pager.vue'
import Icon from '../components/Icon.vue'
import AddUserDialog from '../components/AddUserDialog.vue'
import { get } from '../api.js'
import { useDebouncedSearch, useQueryState, useResource, clampPage } from '../composables.js'
import { ago, count, date, money } from '../format.js'

const router = useRouter()
const { state: q, set } = useQueryState({ role: '', sort: 'newest', q: '', page: 1 })
const search = useDebouncedSearch(q, set)
const { data, loading, error, reload } = useResource(() => get('/admin/users', { ...q.value, limit: 25 }), q)
const role = computed({ get: () => q.value.role, set: (v) => set({ role: v }) })
const tabs = computed(() => [
  { value: '', label: 'Everyone', count: data.value?.counts.all },
  { value: 'CUSTOMER', label: 'Customers', count: data.value?.counts.customers },
  { value: 'STAFF', label: 'Staff', count: data.value?.counts.staff },
])
const adding = ref(false)
clampPage(data, set)
</script>

<template>
  <div>
    <PageHeader title="Customers" description="Everyone with a Cartly account, with what they’ve ordered and spent.">
      <button v-can="'customers.write'" class="btn primary" @click="adding = true"><Icon name="plus" :size="16" />Add customer</button>
    </PageHeader>
    <section class="panel">
      <div class="toolbar">
        <Tabs v-model="role" label="Role" :items="tabs" />
        <SearchBox v-model="search" label="Search customers" placeholder="Name or email" />
        <label class="sr-only" for="c-sort">Sort</label>
        <select id="c-sort" class="select sm sort" :value="q.sort" @change="set({ sort: $event.target.value })">
          <option value="newest">Newest first</option>
          <option value="oldest">Oldest first</option>
          <option value="name">Name A–Z</option>
        </select>
      </div>
      <StateBlock
        :loading="loading && !data"
        :error="error"
        :empty="!data?.items.length"
        :empty-text="q.q ? `No one matches “${q.q}”. Try part of a name or email address.` : 'No accounts yet.'"
        @retry="reload"
      >
        <div class="table-wrap">
          <table class="table">
            <thead>
              <tr>
                <th>Customer</th>
                <th>Role</th>
                <th class="num">Orders</th>
                <th class="num">Spent</th>
                <th>Last order</th>
                <th>Joined</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="u in data.items" :key="u.id" class="row-link" @click="router.push(`/customers/${u.id}`)">
                <td class="primary-cell">
                  <RouterLink :to="`/customers/${u.id}`" @click.stop>{{ u.name }}</RouterLink>
                  <span class="sub">{{ u.email }}</span>
                </td>
                <td>
                  <StatusTag :status="u.role" />
                  <StatusTag v-if="u.disabled" status="DISABLED" class="off" />
                </td>
                <td class="num">{{ count(u.orders) }}</td>
                <td class="num"><strong>{{ money(u.spent) }}</strong></td>
                <td>{{ u.lastOrderAt ? ago(u.lastOrderAt) : '—' }}</td>
                <td>{{ date(u.createdAt) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <Pager :page="data.page" :pages="data.pages" :total="data.total" :limit="data.limit" noun="accounts" @go="set({ page: $event })" />
      </StateBlock>
    </section>
    <AddUserDialog :open="adding" @close="adding = false" @created="reload({ quiet: true })" />
  </div>
</template>

<style scoped>
.off {
  margin-left: 4px;
}
.sort {
  width: auto;
  margin-left: auto;
}
</style>
