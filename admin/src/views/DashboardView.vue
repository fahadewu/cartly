<script setup>
import { computed, reactive } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import PageHeader from '../components/PageHeader.vue'
import StatusTag from '../components/StatusTag.vue'
import StateBlock from '../components/StateBlock.vue'
import Tabs from '../components/Tabs.vue'
import RevenueChart from '../components/RevenueChart.vue'
import { get, patch } from '../api.js'
import { auth, can } from '../auth.js'
import { refreshBadges } from '../badges.js'
import { useQueryState, useResource } from '../composables.js'
import { ago, change, count, money, plural } from '../format.js'
import { toast } from '../toast.js'

const router = useRouter()
// Set by the router when someone opens a page their role can't see.
const route = useRoute()
const denied = computed(() => route.query.denied)
const { state: q, set } = useQueryState({ days: 30 })
const days = computed({ get: () => (([7, 30, 90].includes(q.value.days) ? q.value.days : 30)), set: (v) => set({ days: v }) })
const { data: s, loading, error, reload } = useResource(() => get('/admin/stats', { days: days.value }), days)
// Service health is for admins (System); other roles just don't see that card.
const { data: sys } = useResource(() => (can('system.read') ? get('/admin/system') : null))

const hour = new Date().getHours()
const greeting = `${hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'}, ${auth.user?.name?.split(' ')[0] ?? 'there'}`

const stock = computed(() => {
  const p = s.value?.products
  if (!p) return null
  const n = p.lowStock + p.outOfStock
  const text = !n
    ? 'Every product has healthy stock.'
    : p.outOfStock && p.lowStock
      ? `${count(p.outOfStock)} sold out and ${count(p.lowStock)} running low. Reorder before they’re gone.`
      : p.outOfStock
        ? `${n === 1 ? 'product is' : 'products are'} sold out and can’t be bought.`
        : `${n === 1 ? 'product is' : 'products are'} down to their last few units.`
  return { n, text, to: `/products?stock=${p.outOfStock && !p.lowStock ? 'out' : 'low'}` }
})
const trend = (n) => ({ text: change(n) })
const tone = (n) => ({ up: n > 0, down: n < 0 })

// Quick restock from the dashboard: adds units to what's on the shelf.
const restock = reactive({})
async function addStock(p) {
  const add = Number(restock[p.id])
  if (!Number.isInteger(add) || add < 1) {
    toast('Enter how many units arrived, as a whole number.', 'error')
    return
  }
  try {
    const updated = await patch(`/admin/products/${p.id}`, { stock: p.stock + add })
    toast(`${updated.name} restocked to ${updated.stock}`)
    delete restock[p.id]
    reload({ quiet: true })
    refreshBadges({ force: true })
  } catch (e) {
    toast(e.message, 'error')
  }
}
const services = computed(() => {
  const x = sys.value?.services
  if (!x) return []
  return [
    { name: 'Database', ok: x.database.ok, detail: x.database.ok ? `${x.database.ms} ms` : 'Down' },
    { name: 'Redis', ok: x.redis.ok, detail: x.redis.ok ? `${x.redis.ms} ms` : 'Down' },
    { name: 'AI service', ok: x.ai.ok, detail: x.ai.ok ? `${x.ai.index_size ?? 0} products indexed` : 'Search falls back to keywords' },
  ]
})
</script>

<template>
  <div>
    <PageHeader :title="greeting" description="Here’s what needs doing at Cartly today." />
    <p v-if="denied" class="denied" role="status">
      Your role ({{ auth.user?.roleLabel }}) can’t open {{ denied }}. Ask an admin if you need it.
      <button class="link-btn" @click="router.replace({ query: {} })">Dismiss</button>
    </p>

    <StateBlock :loading="loading && !s" :error="error" @retry="reload">
      <template v-if="s">
        <section class="panel queues" aria-label="Today’s queues">
          <RouterLink to="/orders?status=PROCESSING" class="queue">
            <StatusTag status="PROCESSING" label="To ship" />
            <strong class="display figures">{{ count(s.orders.byStatus.PROCESSING) }}</strong>
            <p>{{ s.orders.byStatus.PROCESSING === 1 ? 'order is' : 'orders are' }} waiting to be packed and shipped.</p>
            <span class="go">Open orders to ship</span>
          </RouterLink>
          <RouterLink :to="stock.to" class="queue">
            <StatusTag :status="s.products.outOfStock ? 'OUT' : 'LOW'" :label="stock.n ? 'Reorder' : 'Stock'" />
            <strong class="display figures">{{ count(stock.n) }}</strong>
            <p>{{ stock.text }}</p>
            <span class="go">Review stock</span>
          </RouterLink>
          <RouterLink to="/requests" class="queue">
            <StatusTag status="SOURCING" label="Waiting" />
            <strong class="display figures">{{ count(s.openRequests) }}</strong>
            <p>{{ s.openRequests === 1 ? 'customer request needs' : 'customer requests need' }} an answer from the buying team.</p>
            <span class="go">Answer requests</span>
          </RouterLink>
        </section>

        <section class="panel sales" aria-labelledby="sales-title">
          <div class="panel-head">
            <h2 id="sales-title">Sales</h2>
            <Tabs
              v-model="days"
              label="Period"
              :items="[
                { value: 7, label: '7 days' },
                { value: 30, label: '30 days' },
                { value: 90, label: '90 days' },
              ]"
            />
          </div>
          <div class="panel-body">
            <dl class="figures-line figures">
              <div class="lead">
                <dt>Revenue</dt>
                <dd>
                  <span class="display big">{{ money(s.revenue.total) }}</span>
                  <span v-if="trend(s.revenue.change).text" class="delta" :class="tone(s.revenue.change)">
                    {{ trend(s.revenue.change).text }} vs the previous {{ days }} days
                  </span>
                  <span v-else class="delta">No sales in the previous {{ days }} days to compare</span>
                </dd>
              </div>
              <div>
                <dt>Orders</dt>
                <dd>
                  {{ count(s.orders.total) }}
                  <span v-if="trend(s.orders.change).text" class="delta" :class="tone(s.orders.change)">{{ trend(s.orders.change).text }}</span>
                </dd>
              </div>
              <div>
                <dt>Average order</dt>
                <dd>
                  {{ money(s.averageOrderValue.total) }}
                  <span v-if="trend(s.averageOrderValue.change).text" class="delta" :class="tone(s.averageOrderValue.change)">{{ trend(s.averageOrderValue.change).text }}</span>
                </dd>
              </div>
              <div>
                <dt>New customers</dt>
                <dd>{{ count(s.customers.new) }}</dd>
              </div>
            </dl>
            <RevenueChart :series="s.series" />
          </div>
        </section>

        <div class="columns">
          <section class="panel" aria-labelledby="recent-title">
            <div class="panel-head">
              <h2 id="recent-title">Latest orders</h2>
              <RouterLink to="/orders" class="small-link">All orders</RouterLink>
            </div>
            <StateBlock :empty="!s.recentOrders.length" empty-text="No orders yet. They’ll appear here as soon as someone checks out.">
              <div class="table-wrap">
                <table class="table">
                  <thead>
                    <tr>
                      <th>Order</th>
                      <th>Customer</th>
                      <th class="num">Items</th>
                      <th class="num">Total</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="o in s.recentOrders" :key="o.id" class="row-link" @click="router.push(`/orders/${o.id}`)">
                      <td class="primary-cell">
                        <RouterLink :to="`/orders/${o.id}`" @click.stop>{{ o.id }}</RouterLink>
                        <span class="sub">{{ ago(o.createdAt) }}</span>
                      </td>
                      <td>{{ o.customer.name }}</td>
                      <td class="num">{{ o.itemCount }}</td>
                      <td class="num">{{ money(o.total) }}</td>
                      <td><StatusTag :status="o.status" /></td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </StateBlock>
          </section>

          <div class="stack">
            <section class="panel" aria-labelledby="top-title">
              <div class="panel-head">
                <h2 id="top-title">Best sellers</h2>
              </div>
              <StateBlock :empty="!s.topProducts.length" empty-text="Nothing sold in this period yet.">
                <ol class="list">
                  <li v-for="p in s.topProducts" :key="p.id">
                    <RouterLink :to="`/products/${p.id}`" class="with-thumb item-link">
                      <img class="thumb" :src="p.image" alt="" loading="lazy" />
                      <span class="grow">
                        <strong>{{ p.name }}</strong>
                        <span class="sub">{{ plural(p.units, 'unit') }} sold</span>
                      </span>
                    </RouterLink>
                    <span class="figures money">{{ money(p.revenue) }}</span>
                  </li>
                </ol>
              </StateBlock>
            </section>

            <section class="panel" aria-labelledby="low-title">
              <div class="panel-head">
                <h2 id="low-title">Running low</h2>
                <RouterLink to="/products?sort=stock-asc" class="small-link">All stock</RouterLink>
              </div>
              <StateBlock :empty="!s.lowStock.length" empty-text="No products are running low.">
                <ul class="list">
                  <li v-for="p in s.lowStock" :key="p.id">
                    <RouterLink :to="`/products/${p.id}`" class="with-thumb item-link">
                      <img class="thumb" :src="p.image" alt="" loading="lazy" />
                      <span class="grow">
                        <strong>{{ p.name }}</strong>
                        <span class="sub" :class="p.stock ? 'warn' : 'bad'">{{ p.stock ? `${p.stock} left` : 'Sold out' }}</span>
                      </span>
                    </RouterLink>
                    <form class="restock" @submit.prevent="addStock(p)">
                      <label class="sr-only" :for="`restock-${p.id}`">Units arrived for {{ p.name }}</label>
                      <input :id="`restock-${p.id}`" v-model="restock[p.id]" class="input sm" type="number" min="1" step="1" placeholder="+ units" />
                      <button v-can="'catalog.write'" class="btn sm">Restock</button>
                    </form>
                  </li>
                </ul>
              </StateBlock>
            </section>

            <section v-if="can('system.read')" class="panel" aria-labelledby="health-title">
              <div class="panel-head">
                <h2 id="health-title">Services</h2>
                <RouterLink to="/system" class="small-link">System</RouterLink>
              </div>
              <ul class="services">
                <li v-for="x in services" :key="x.name">
                  <span class="dot" :class="x.ok ? 'ok' : 'bad'" />
                  <strong>{{ x.name }}</strong>
                  <span class="muted">{{ x.detail }}</span>
                </li>
                <li v-if="!services.length" class="muted">Checking…</li>
              </ul>
            </section>
          </div>
        </div>
      </template>
    </StateBlock>
  </div>
</template>

<style scoped>
.denied {
  display: flex;
  gap: 12px;
  align-items: center;
  flex-wrap: wrap;
  margin: -6px 0 18px;
  padding: 10px 14px;
  border-radius: var(--r-control);
  background: var(--butter);
  color: #5c3d00;
  font-weight: 600;
}
.queues {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  margin-bottom: 18px;
}
.queue {
  display: grid;
  align-content: start;
  justify-items: start;
  gap: 8px;
  padding: 18px 22px 20px;
  color: var(--ink);
  text-decoration: none;
  border-left: 1px solid var(--line);
  transition: background 0.15s ease;
}
.queue:first-child {
  border-left: 0;
  border-radius: var(--r-panel) 0 0 var(--r-panel);
}
.queue:last-child {
  border-radius: 0 var(--r-panel) var(--r-panel) 0;
}
.queue:hover {
  background: var(--hover);
  text-decoration: none;
}
.queue strong {
  margin-top: 4px;
  font-size: 44px;
  line-height: 1;
}
.queue p {
  color: var(--ink-2);
  max-width: 34ch;
}
.go {
  margin-top: 2px;
  color: var(--accent);
  font-weight: 700;
  font-size: 13.5px;
}
.queue:hover .go {
  text-decoration: underline;
}

.sales {
  margin-bottom: 18px;
}
.figures-line {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 14px 36px;
  margin: 0 0 18px;
}
.figures-line dt {
  font-size: 12.5px;
  font-weight: 650;
  color: var(--muted);
}
.figures-line dd {
  margin: 2px 0 0;
  font-size: 18px;
  font-weight: 700;
}
.figures-line .lead {
  margin-right: auto;
}
.big {
  display: block;
  font-size: 38px;
}
.delta {
  display: inline-block;
  margin-left: 6px;
  font-size: 12.5px;
  font-weight: 700;
  color: var(--muted);
}
.lead .delta {
  margin: 4px 0 0;
}
.delta.up {
  color: var(--ok);
}
.delta.down {
  color: var(--danger);
}

.columns {
  display: grid;
  grid-template-columns: minmax(0, 1.55fr) minmax(300px, 1fr);
  gap: 18px;
  align-items: start;
}
.small-link,
.small {
  font-size: 13px;
  font-weight: 650;
}
.list {
  margin: 0;
  padding: 4px 0;
  list-style: none;
}
.list li {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 9px 18px;
  border-top: 1px solid var(--line);
}
.list li:first-child {
  border-top: 0;
}
.item-link {
  flex: 1;
  color: var(--ink);
}
.item-link:hover strong {
  color: var(--accent);
}
.item-link .grow {
  display: grid;
  min-width: 0;
}
.item-link strong {
  font-size: 13.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sub {
  font-size: 12.5px;
  color: var(--muted);
}
.sub.warn {
  color: var(--warn);
  font-weight: 700;
}
.sub.bad {
  color: var(--danger);
  font-weight: 700;
}
.money {
  font-weight: 700;
}
.restock {
  display: flex;
  gap: 6px;
}
.restock .input {
  width: 82px;
}
.services {
  display: grid;
  gap: 10px;
  margin: 0;
  padding: 14px 18px 16px;
  list-style: none;
  font-size: 13.5px;
}
.services li {
  display: flex;
  align-items: center;
  gap: 9px;
}
.services .muted {
  margin-left: auto;
  font-size: 12.5px;
  text-align: right;
}

@media (max-width: 1100px) {
  .columns {
    grid-template-columns: minmax(0, 1fr);
  }
}
@media (max-width: 520px) {
  .list li {
    flex-wrap: wrap;
  }
  .restock {
    width: 100%;
    padding-left: 52px;
  }
  .restock .input {
    flex: 1;
  }
}
@media (max-width: 720px) {
  .queues {
    grid-template-columns: minmax(0, 1fr);
  }
  .queue {
    border-left: 0;
    border-top: 1px solid var(--line);
    padding: 16px 18px;
  }
  .queue:first-child {
    border-top: 0;
    border-radius: var(--r-panel) var(--r-panel) 0 0;
  }
  .queue:last-child {
    border-radius: 0 0 var(--r-panel) var(--r-panel);
  }
  .queue strong {
    font-size: 36px;
  }
  .big {
    font-size: 32px;
  }
}
</style>
