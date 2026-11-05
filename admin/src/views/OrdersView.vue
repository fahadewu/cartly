<script setup>
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import PageHeader from '../components/PageHeader.vue'
import StatusTag from '../components/StatusTag.vue'
import StateBlock from '../components/StateBlock.vue'
import Tabs from '../components/Tabs.vue'
import SearchBox from '../components/SearchBox.vue'
import Pager from '../components/Pager.vue'
import { get } from '../api.js'
import { useDebouncedSearch, useQueryState, useResource, clampPage } from '../composables.js'
import { date, money, time } from '../format.js'

const router = useRouter()
const { state: q, set } = useQueryState({ status: '', q: '', page: 1 })
const METHOD = { bkash: 'bKash', nagad: 'Nagad', rocket: 'Rocket', card: 'Card', cod: 'Cash on delivery', demo: 'Demo card' }
const search = useDebouncedSearch(q, set)
// "Refund due" is a filter of its own: cancelled after being paid.
const params = computed(() => (q.value.status === 'REFUND_DUE' ? { ...q.value, status: '', refundDue: 'true' } : q.value))
const { data, loading, error, reload } = useResource(() => get('/admin/orders', { ...params.value, limit: 25 }), q)

const tabs = computed(() => {
  const c = data.value?.counts ?? {}
  return [
    { value: '', label: 'All', count: c.ALL },
    { value: 'PENDING_PAYMENT', label: 'Awaiting payment', count: c.PENDING_PAYMENT },
    { value: 'PROCESSING', label: 'To ship', count: c.PROCESSING },
    { value: 'SHIPPED', label: 'Shipped', count: c.SHIPPED },
    { value: 'DELIVERED', label: 'Delivered', count: c.DELIVERED },
    { value: 'CANCELLED', label: 'Cancelled', count: c.CANCELLED },
    ...(c.REFUND_DUE ? [{ value: 'REFUND_DUE', label: 'Refund due', count: c.REFUND_DUE }] : []),
  ]
})
const status = computed({ get: () => q.value.status, set: (v) => set({ status: v }) })
const emptyText = computed(() =>
  q.value.q ? `No orders match “${q.value.q}”. Try an order number like CL-10012, or a customer’s name or email.` : 'No orders here yet.',
)
clampPage(data, set)
</script>

<template>
  <div>
    <PageHeader title="Orders" description="Every order placed in the store. Open one to ship, deliver or cancel it." />
    <section class="panel">
      <div class="toolbar">
        <Tabs v-model="status" label="Order status" :items="tabs" />
        <SearchBox v-model="search" label="Search orders" placeholder="Order number, name or email" />
      </div>
      <StateBlock :loading="loading && !data" :error="error" :empty="!data?.items.length" :empty-text="emptyText" @retry="reload">
        <div class="table-wrap">
          <table class="table">
            <thead>
              <tr>
                <th>Order</th>
                <th>Placed</th>
                <th>Customer</th>
                <th class="num">Items</th>
                <th class="num">Total</th>
                <th>Payment</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="o in data.items" :key="o.id" class="row-link" @click="router.push(`/orders/${o.id}`)">
                <td class="primary-cell"><RouterLink :to="`/orders/${o.id}`" @click.stop>{{ o.id }}</RouterLink></td>
                <td>
                  {{ date(o.createdAt) }}
                  <span class="sub">{{ time(o.createdAt) }}</span>
                </td>
                <td>
                  {{ o.customer.name }}
                  <span class="sub">{{ o.customer.email }}</span>
                </td>
                <td class="num">{{ o.itemCount }}</td>
                <td class="num">
                  <strong>{{ money(o.total) }}</strong>
                  <span v-if="o.promoCode" class="sub">{{ o.promoCode }}</span>
                </td>
                <td>
                  {{ METHOD[o.payment.method] ?? o.payment.method }}
                  <span class="sub">{{ o.status === 'CANCELLED' && o.payment.status === 'PAID' && o.payment.method !== 'demo' ? 'Refund due' : o.payment.status.toLowerCase() }}</span>
                </td>
                <td><StatusTag :status="o.status" /></td>
              </tr>
            </tbody>
          </table>
        </div>
        <Pager :page="data.page" :pages="data.pages" :total="data.total" :limit="data.limit" noun="orders" @go="set({ page: $event })" />
      </StateBlock>
    </section>
  </div>
</template>
