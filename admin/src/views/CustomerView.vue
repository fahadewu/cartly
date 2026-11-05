<script setup>
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import PageHeader from '../components/PageHeader.vue'
import StatusTag from '../components/StatusTag.vue'
import StateBlock from '../components/StateBlock.vue'
import Stars from '../components/Stars.vue'
import VisitTimeline from '../components/VisitTimeline.vue'
import { get } from '../api.js'
import AccountActions from '../components/AccountActions.vue'
import { auth, isStaffRole } from '../auth.js'
import { useResource } from '../composables.js'
import LikenessCard from '../components/LikenessCard.vue'
import { count, date, dateTime, money } from '../format.js'

const props = defineProps({ id: String })
const router = useRouter()
const { data: u, loading, error, reload } = useResource(() => get(`/admin/users/${props.id}`))
const isMe = computed(() => u.value?.id === auth.user?.id)
const staffAccount = computed(() => isStaffRole(u.value?.role))

// What the store assumes about this shopper from what they do (never something they told us).
const { data: shopper } = useResource(() => get(`/admin/analytics/shoppers/${props.id}`).catch(() => null))
const openVisit = ref(null)
const PERSONALITY = {
  minimalist: 'Minimalist', classic: 'Timeless classic', trendsetter: 'Trendsetter', romantic: 'Romantic', sporty: 'Active & sporty',
  comfort: 'Comfort-first', free_spirit: 'Free spirit', vintage: 'Vintage lover', glam: 'Glam',
}
const PRICE_BAND = { budget: 'Budget-conscious', value: 'Value for money', premium: 'Happy to spend on quality' }
const styleMix = computed(() => Object.entries(shopper.value?.profile?.styles ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => ({ name: PERSONALITY[k] ?? k, pct: Math.round(v * 100) })))
const mins = (ms) => (ms < 60000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60000)} min`)

</script>

<template>
  <div>
    <StateBlock :loading="loading" :error="error" @retry="reload">
      <template v-if="u">
        <PageHeader :title="u.name" back="/customers" back-label="Customers">
          <template #tag>
            <StatusTag :status="u.role" />
            <StatusTag v-if="u.disabled" status="DISABLED" />
          </template>
          <template #description><a :href="`mailto:${u.email}`">{{ u.email }}</a>, member since {{ date(u.createdAt) }}</template>
          <AccountActions :user="u" @updated="u = $event" />
        </PageHeader>

        <p v-if="u.disabled" class="off-note" role="status">
          This account was turned off {{ dateTime(u.disabledAt) }}. They can’t sign in{{ staffAccount ? ' to the admin panel or the store' : '' }} until it’s turned back on.
        </p>

        <dl class="panel stats figures">
          <div><dt>Orders</dt><dd>{{ count(u.stats.orders) }}</dd></div>
          <div><dt>Total spent</dt><dd>{{ money(u.stats.spent) }}</dd></div>
          <div><dt>Average order</dt><dd>{{ money(u.stats.averageOrder) }}</dd></div>
          <div><dt>Favourites</dt><dd>{{ count(u.stats.favourites) }}</dd></div>
          <div><dt>Reviews</dt><dd>{{ count(u.stats.reviews) }}</dd></div>
          <div><dt>Team members</dt><dd>{{ count(u.stats.teamMembers) }}</dd></div>
        </dl>

        <LikenessCard v-can.hide="'customers.read'" :id="id" />

        <div class="layout">
          <section class="panel">
            <div class="panel-head">
              <h2>Orders</h2>
              <span v-if="u.stats.orders > u.orders.length" class="muted small">Latest {{ u.orders.length }}</span>
            </div>
            <StateBlock :empty="!u.orders.length" empty-text="No orders yet.">
              <div class="table-wrap">
                <table class="table">
                  <thead>
                    <tr>
                      <th>Order</th>
                      <th>Placed</th>
                      <th class="num">Items</th>
                      <th class="num">Total</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="o in u.orders" :key="o.id" class="row-link" @click="router.push(`/orders/${o.id}`)">
                      <td class="primary-cell"><RouterLink :to="`/orders/${o.id}`" @click.stop>{{ o.id }}</RouterLink></td>
                      <td>{{ date(o.createdAt) }}</td>
                      <td class="num">{{ o.items.reduce((n, i) => n + i.qty, 0) }}</td>
                      <td class="num">{{ money(o.total) }}</td>
                      <td><StatusTag :status="o.status" /></td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </StateBlock>
          </section>

          <div class="stack">
            <section class="panel">
              <div class="panel-head"><h2>Account</h2></div>
              <dl class="kv panel-body">
                <dt>Role</dt>
                <dd><StatusTag :status="u.role" /><span v-if="isMe" class="muted"> (you)</span></dd>
                <dt>Status</dt>
                <dd>{{ u.disabled ? 'Turned off' : u.passwordTemporary ? 'Active, must set a new password' : 'Active' }}</dd>
                <dt>Last sign-in</dt>
                <dd>{{ u.lastSignInAt ? dateTime(u.lastSignInAt) : 'Not since this was tracked' }}</dd>
              </dl>
              <template v-if="u.activity?.length">
                <h3 class="feed-title">Changes</h3>
                <ol class="feed">
                  <li v-for="e in u.activity" :key="e.id">
                    <span><strong>{{ e.actor?.name ?? 'Someone' }}</strong> {{ e.label }}</span>
                    <time class="muted" :datetime="e.createdAt">{{ dateTime(e.createdAt) }}</time>
                  </li>
                </ol>
              </template>
            </section>
            <section v-if="shopper" class="panel">
              <div class="panel-head"><h2>Shopping profile</h2><span class="muted small">Assumed from behaviour</span></div>
              <div class="profile">
                <template v-if="shopper.profile">
                  <dl class="kv">
                    <dt>Personality</dt><dd>{{ shopper.profile.personalityLabel ?? 'Still learning' }}</dd>
                    <dt>Price comfort</dt><dd>{{ PRICE_BAND[shopper.profile.priceBand] ?? 'Not enough to tell' }}</dd>
                    <dt>Age group</dt>
                    <dd>{{ shopper.profile.ageGroup ? `${shopper.profile.ageGroup} (${Math.round((shopper.profile.ageConfidence ?? 0) * 100)}% sure)` : 'Not enough to tell' }}</dd>
                    <dt>Shopping style</dt><dd>{{ shopper.profile.traits.length ? shopper.profile.traits.join(', ') : '—' }}</dd>
                    <dt>Based on</dt><dd>{{ Math.round(shopper.profile.evidence) }} weighted actions, updated {{ date(shopper.profile.updatedAt) }}</dd>
                  </dl>
                  <ul v-if="styleMix.length" class="mix">
                    <li v-for="m in styleMix" :key="m.name">
                      <span>{{ m.name }}</span><span class="figures">{{ m.pct }}%</span>
                      <div class="track"><span :style="{ width: `${m.pct}%` }" /></div>
                    </li>
                  </ul>
                </template>
                <p v-else class="muted">Still learning their taste, or they’ve turned personalisation off.</p>
                <p class="muted note">
                  {{ count(shopper.totals.visits) }} visits, {{ count(shopper.totals.minutes) }} minutes on screen<template v-if="shopper.totals.places.length"> · seen in {{ shopper.totals.places.join('; ') }}</template>
                </p>
              </div>
              <ul v-if="shopper.visits.length" class="rows">
                <li v-for="v in shopper.visits" :key="v.id" class="row-link" tabindex="0" @click="openVisit = v.id" @keydown.enter="openVisit = v.id">
                  <div class="line"><span>{{ dateTime(v.startedAt) }}</span><span class="muted">{{ v.pageCount }} pages · {{ mins(v.activeMs) }}</span></div>
                  <span class="muted">{{ v.landing }} → left from {{ v.exitPath ?? v.landing }} · {{ v.source }}{{ v.city || v.country ? ` · ${[v.city, v.country].filter(Boolean).join(', ')}` : '' }}</span>
                </li>
              </ul>
            </section>

            <section class="panel">
              <div class="panel-head"><h2>Favourites</h2></div>
              <StateBlock :empty="!u.favourites.length" empty-text="Nothing saved yet.">
                <ul class="favs">
                  <li v-for="p in u.favourites" :key="p.id">
                    <RouterLink :to="`/products/${p.id}`" :title="p.name"><img class="thumb" :src="p.image" :alt="p.name" loading="lazy" /></RouterLink>
                  </li>
                </ul>
              </StateBlock>
            </section>

            <section class="panel">
              <div class="panel-head"><h2>Reviews</h2></div>
              <StateBlock :empty="!u.reviews.length" empty-text="No reviews written.">
                <ul class="rows">
                  <li v-for="r in u.reviews" :key="r.id">
                    <div class="line">
                      <Stars :rating="r.rating" />
                      <RouterLink :to="`/products/${r.product.id}`">{{ r.product.name }}</RouterLink>
                    </div>
                    <strong>{{ r.title }}</strong>
                    <p class="muted">{{ r.text }}</p>
                  </li>
                </ul>
              </StateBlock>
            </section>

            <section class="panel">
              <div class="panel-head"><h2>Product requests</h2></div>
              <StateBlock :empty="!u.requests.length" empty-text="No requests sent.">
                <ul class="rows">
                  <li v-for="r in u.requests" :key="r.id">
                    <div class="line">
                      <strong>{{ r.product }}</strong>
                      <StatusTag :status="r.status" />
                    </div>
                    <span class="muted">{{ r.category }}<template v-if="r.budget">, up to {{ money(r.budget) }}</template>, {{ date(r.createdAt) }}</span>
                  </li>
                </ul>
                <div class="panel-foot"><RouterLink :to="`/requests?q=${encodeURIComponent(u.email)}`" class="small">Open in requests</RouterLink></div>
              </StateBlock>
            </section>
          </div>
        </div>
      </template>
    </StateBlock>
    <VisitTimeline :id="openVisit" @close="openVisit = null" />
  </div>
</template>

<style scoped>
.off-note {
  margin: -8px 0 18px;
  padding: 10px 14px;
  border-radius: var(--r-control);
  background: var(--danger-soft);
  color: #8f241c;
  font-weight: 600;
}
.feed-title {
  padding: 0 18px;
  font-size: 13px;
  font-weight: 700;
}
.feed {
  display: grid;
  gap: 8px;
  margin: 8px 0 0;
  padding: 0 18px 16px;
  list-style: none;
  font-size: 13px;
}
.feed li {
  display: grid;
  gap: 1px;
}
.feed time {
  font-size: 12px;
}
.stats {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  margin: 0 0 18px;
}
.stats div {
  padding: 14px 18px;
  border-left: 1px solid var(--line);
}
.stats div:first-child {
  border-left: 0;
}
.stats dt {
  font-size: 12.5px;
  font-weight: 650;
  color: var(--muted);
}
.stats dd {
  margin: 2px 0 0;
  font-family: var(--font-display);
  font-size: 24px;
  font-weight: 600;
}
.layout {
  display: grid;
  grid-template-columns: minmax(0, 1.5fr) minmax(280px, 1fr);
  gap: 18px;
  align-items: start;
}
.small {
  font-size: 12.5px;
  font-weight: 650;
}
.favs {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 0;
  padding: 14px 18px;
  list-style: none;
}
.favs .thumb {
  width: 52px;
  height: 52px;
}
.rows {
  margin: 0;
  padding: 0;
  list-style: none;
}
.rows li {
  display: grid;
  gap: 3px;
  padding: 12px 18px;
  border-top: 1px solid var(--line);
  font-size: 13.5px;
}
.rows li:first-child {
  border-top: 0;
}
.line {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.profile {
  padding: 12px 18px;
  font-size: 13.5px;
}
.kv {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 4px 14px;
  margin: 0;
}
.kv dt {
  color: var(--muted);
  font-weight: 600;
}
.kv dd {
  margin: 0;
}
.mix {
  display: grid;
  gap: 6px;
  margin: 12px 0 0;
  padding: 0;
  list-style: none;
}
.mix li {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 2px 8px;
}
.mix .track {
  grid-column: 1 / -1;
  height: 6px;
  border-radius: 3px;
  background: var(--line);
}
.mix .track span {
  display: block;
  height: 100%;
  border-radius: 3px;
  background: #2a78d6;
}
.note {
  margin: 10px 0 0;
  font-size: 12.5px;
}
.row-link {
  cursor: pointer;
}
@media (max-width: 1000px) {
  .layout {
    grid-template-columns: minmax(0, 1fr);
  }
  .stats {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
  .stats div:nth-child(4) {
    border-left: 0;
  }
  .stats div:nth-child(n + 4) {
    border-top: 1px solid var(--line);
  }
}
@media (max-width: 520px) {
  .stats {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .stats div:nth-child(odd) {
    border-left: 0;
  }
  .stats div:nth-child(4) {
    border-left: 1px solid var(--line);
  }
  .stats div:nth-child(n + 3) {
    border-top: 1px solid var(--line);
  }
}
</style>
