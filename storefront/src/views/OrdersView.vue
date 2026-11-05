<script setup>
import { ref, computed } from 'vue'
import PageHeader from '../components/PageHeader.vue'
import Icon from '../components/Icon.vue'
import StampCard from '../components/StampCard.vue'
import { money } from '../data.js'
import { useShop } from '../store.js'

const { state } = useShop()
const filter = ref('All')
const tabs = ['All', 'Awaiting payment', 'Processing', 'Shipped', 'Delivered', 'Cancelled']
const count = (t) => (t === 'All' ? state.orders.length : state.orders.filter((o) => o.status === t).length)
const visible = computed(() => (filter.value === 'All' ? state.orders : state.orders.filter((o) => o.status === filter.value)))
const spent = computed(() => state.orders.reduce((n, o) => n + (o.status === 'Cancelled' ? 0 : o.total), 0))

const fmt = (d) => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
</script>

<template>
  <div>
    <PageHeader title="Orders" subtitle="Track, review and reorder your purchases" :crumbs="[{ label: 'Explore', to: '/' }, { label: 'Orders' }]" />

    <div class="page">
      <StampCard />
      <div class="stats">
        <div class="stat mint"><small>Total orders</small><strong>{{ state.orders.length }}</strong></div>
        <div class="stat butter"><small>In progress</small><strong>{{ count('Processing') + count('Shipped') }}</strong></div>
        <div class="stat peach"><small>Total spent</small><strong>{{ money(spent) }}</strong></div>
      </div>

      <div class="tabs" role="tablist">
        <button v-for="t in tabs" :key="t" role="tab" :aria-selected="filter === t" class="pill tab" :class="{ on: filter === t }" @click="filter = t">
          {{ t }}<span>{{ count(t) }}</span>
        </button>
      </div>

      <div v-if="!visible.length" class="empty">
        <span class="empty-icon"><Icon name="bag" :size="28" /></span>
        <h3>No {{ filter === 'All' ? '' : filter.toLowerCase() }} orders</h3>
        <p>When you place an order, it will show up here so you can track it.</p>
        <RouterLink to="/shop" class="btn-primary sm">Start shopping</RouterLink>
      </div>

      <ul v-else class="orders">
        <li v-for="o in visible" :key="o.id">
          <RouterLink :to="`/orders/${o.id}`" class="order">
            <div class="thumbs">
              <img v-for="i in o.items.slice(0, 3)" :key="i.id + i.size" :src="i.image" alt="" />
              <span v-if="o.items.length > 3">+{{ o.items.length - 3 }}</span>
            </div>
            <div class="meta">
              <b>Order {{ o.id }}</b>
              <small>{{ fmt(o.date) }} · {{ o.items.reduce((n, i) => n + i.qty, 0) }} items</small>
            </div>
            <span class="status" :class="o.status.toLowerCase()">{{ o.status }}</span>
            <b class="total">{{ money(o.total) }}</b>
            <Icon name="chevronRight" :size="20" class="chev" />
          </RouterLink>
        </li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.stats {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 18px;
  margin-bottom: 24px;
}
.stat {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 24px 28px;
  border-radius: var(--r-card);
}
.stat.mint { background: var(--mint); }
.stat.butter { background: var(--butter); }
.stat.peach { background: var(--peach); }
.stat small {
  font-size: 13px;
}
.stat strong {
  font-size: 34px;
  font-weight: 600;
  letter-spacing: -0.02em;
}

.tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 16px;
}
.tab {
  height: 46px;
  padding: 0 20px;
  font-size: 14px;
  color: var(--muted);
}
.tab span {
  padding: 2px 8px;
  border-radius: var(--r-pill);
  background: #fff;
  font-size: 12px;
}
.tab.on {
  background: var(--ink);
  color: #fff;
}
.tab.on span {
  background: rgba(255, 255, 255, 0.2);
}

.orders {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.order {
  display: flex;
  align-items: center;
  gap: 20px;
  padding: 16px 22px 16px 16px;
  border: 2px solid var(--line);
  border-radius: 26px;
  color: inherit;
  text-decoration: none;
  transition: border-color 0.2s ease, transform 0.2s ease;
}
.order:hover {
  border-color: #dfe3ff;
  transform: translateX(3px);
}
.thumbs {
  display: flex;
  align-items: center;
}
.thumbs img {
  width: 58px;
  height: 58px;
  margin-left: -14px;
  border: 3px solid #fff;
  border-radius: 18px;
  object-fit: cover;
  background: var(--card);
}
.thumbs img:first-child {
  margin-left: 0;
}
.thumbs span {
  margin-left: 8px;
  font-size: 13px;
  color: var(--muted);
}
.meta {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.meta b {
  font-weight: 500;
}
.meta small {
  font-size: 13px;
  color: var(--muted);
}
.total {
  min-width: 80px;
  text-align: right;
  font-weight: 600;
}
.chev {
  color: var(--muted);
}

@media (max-width: 860px) {
  .stats {
    grid-template-columns: 1fr;
  }
  .order {
    flex-wrap: wrap;
    gap: 12px;
  }
  .meta {
    flex-basis: calc(100% - 200px);
  }
  .chev {
    display: none;
  }
}
</style>
