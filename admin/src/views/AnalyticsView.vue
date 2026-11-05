<script setup>
import { computed, ref } from 'vue'
import PageHeader from '../components/PageHeader.vue'
import StateBlock from '../components/StateBlock.vue'
import StatusTag from '../components/StatusTag.vue'
import Tabs from '../components/Tabs.vue'
import BarList from '../components/BarList.vue'
import StackedDays from '../components/StackedDays.vue'
import HourHeatmap from '../components/HourHeatmap.vue'
import VisitTimeline from '../components/VisitTimeline.vue'
import InterestsPanel from '../components/InterestsPanel.vue'
import { get } from '../api.js'
import { useQueryState, useResource } from '../composables.js'
import { RETURN_REASON, count, date, dateTime, money, plural, taka } from '../format.js'

const { state: q, set } = useQueryState({ tab: 'sales', days: 30, level: 'region' })
const tab = computed({ get: () => q.value.tab, set: (v) => set({ tab: v }) })
const days = computed({ get: () => q.value.days, set: (v) => set({ days: Number(v) }) })
const level = computed({ get: () => q.value.level, set: (v) => set({ level: v }) })
const TABS = [
  { value: 'sales', label: 'Sales' },
  { value: 'demand', label: 'Products & demand' },
  { value: 'customers', label: 'Customers' },
  { value: 'regions', label: 'Regions & trends' },
  { value: 'returns', label: 'Returns' },
  { value: 'delivery', label: 'Delivery' },
  { value: 'ai-costs', label: 'AI costs' },
  { value: 'visitors', label: 'Visitors & journeys' },
  { value: 'interests', label: 'Interests & emails' },
]
const RANGES = [7, 30, 90, 365]
const source = computed(() => ({ tab: q.value.tab, days: q.value.days, level: q.value.level }))
const { data: d, loading, error, reload } = useResource(
  () => get(`/admin/analytics/${q.value.tab}`, { days: q.value.days, ...(q.value.tab === 'regions' ? { level: q.value.level } : {}) }),
  source,
)
// The response for another tab can linger while the new one loads.
const ready = computed(() => d.value && !loading.value)

const pct = (v) => (v == null ? '—' : `${v}%`)
const signed = (v) => (v == null ? null : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v)}%`)
const usd4 = (v) => (v == null ? '—' : v > 0 && v < 0.01 ? `$${Number(v).toFixed(4)}` : money(v))
const hours = (h) => (h == null ? '—' : h < 48 ? `${h} h` : `${Math.round((h / 24) * 10) / 10} days`)
const METHOD = { bkash: 'bKash', nagad: 'Nagad', rocket: 'Rocket', card: 'Card', cod: 'Cash on delivery', demo: 'Demo card' }
const REASON = RETURN_REASON
const CARRIER = { rider: 'Own riders', pathao: 'Pathao', steadfast: 'Steadfast', redx: 'RedX' }
const ATTR = { category: 'Category', type: 'Type', color: 'Colour', size: 'Size', style: 'Style', occasion: 'Occasion', gender: 'Gender', material: 'Material', fit: 'Fit' }
const SEG_NOTE = {
  Champions: 'Bought 3+ times, most recently in the last 30 days',
  Loyal: '3+ orders, last one within 90 days',
  Promising: 'Bought within the last 60 days',
  New: 'First and only order in the last 30 days',
  'At risk': '2+ orders, but none for 2–6 months',
  Lapsed: 'Nothing for a long while',
}
const VENDOR_KEYS = [
  { key: 'claude', label: 'Claude', color: '#2a78d6' },
  { key: 'tryOn', label: 'FASHN try-on', color: '#eb6834' },
  { key: 'voice', label: 'ElevenLabs voice', color: '#1baf7a' },
]
const SALES_KEYS = [{ key: 'net', label: 'Net sales', color: '#2a78d6' }]
const since = (s) => (s ? `since ${date(s)}` : '')
const rangeText = computed(() => (d.value?.range ? `${date(d.value.range.from)} – ${date(d.value.range.to)} (${d.value.range.tz})` : ''))
const deltaClass = (v) => (v == null ? '' : v > 0 ? 'up' : v < 0 ? 'down' : '')
const regionTaste = (r, attr) => r.tastes[attr]

// Visitors & journeys
const openVisit = ref(null)
const secs = (s) => (s == null ? '—' : s < 60 ? `${Math.round(s)} s` : `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`)
const VISIT_KEYS = [{ key: 'visits', label: 'Visits', color: '#2a78d6' }]
const SOURCE = { direct: 'Direct', search: 'Search engines', social: 'Social media', referral: 'Other sites' }
const ROUTE = {
  explore: 'Explore (home)', shop: 'All products', popular: 'Popular', category: 'Category', collection: 'Collection', product: 'Product page',
  inspiration: 'Inspiration', story: 'Story', favourites: 'Favourites', cart: 'Cart', checkout: 'Checkout', orders: 'Orders', order: 'Order page',
  request: 'Request a product', team: 'Team', account: 'Account', login: 'Log in', signup: 'Sign up', 'not-found': 'Not found', '(left)': 'Left the store',
}
const routeName = (r) => ROUTE[r] ?? r
const PRICE_BAND = { budget: 'Budget-conscious', value: 'Value for money', premium: 'Quality-focused', unknown: 'Not enough to tell' }
const place = (v) => [v.city, v.country].filter(Boolean).join(', ') || '—'
</script>

<template>
  <div>
    <PageHeader title="Analytics" description="Sales, demand, customers, regional fashion trends, returns, delivery, AI spend and visitor journeys, all from the store’s own records.">
      <label class="range">
        <span class="sr-only">Period</span>
        <select v-model="days" class="select">
          <option v-for="n in RANGES" :key="n" :value="n">Last {{ n === 365 ? '12 months' : `${n} days` }}</option>
        </select>
      </label>
    </PageHeader>
    <div class="tabs-row"><Tabs v-model="tab" label="Analytics section" :items="TABS" /></div>
    <p v-if="rangeText" class="muted small period">{{ rangeText }}, compared with the {{ days }} days before.</p>

    <StateBlock :loading="loading && !d" :error="error" @retry="reload">
      <template v-if="ready">
        <p v-if="d.sample?.low" class="banner">
          Only {{ plural(d.sample.orders, 'sale') }} in this period: treat percentages and trends as rough until there are more.
        </p>

        <!-- ======================= SALES ======================= -->
        <template v-if="tab === 'sales'">
          <div class="kpis">
            <div class="tile"><span>Net sales</span><strong class="figures">{{ money(d.net.total) }}</strong><em :class="deltaClass(d.net.change)">{{ signed(d.net.change) ?? 'no earlier data' }}</em><small>Gross {{ money(d.gross.total) }} − refunds {{ money(d.refunds.total) }}</small></div>
            <div class="tile"><span>Orders</span><strong class="figures">{{ count(d.orders.total) }}</strong><em :class="deltaClass(d.orders.change)">{{ signed(d.orders.change) ?? 'no earlier data' }}</em><small>{{ d.units.perOrder }} items per order</small></div>
            <div class="tile"><span>Average order</span><strong class="figures">{{ money(d.aov.total) }}</strong><em :class="deltaClass(d.aov.change)">{{ signed(d.aov.change) ?? 'no earlier data' }}</em><small>{{ count(d.units.total) }} items sold</small></div>
            <div class="tile"><span>Buyers</span><strong class="figures">{{ count(d.buyers.total) }}</strong><em>{{ d.buyers.new }} new · {{ d.buyers.returning }} returning</em><small>{{ pct(d.buyers.repeatRate) }} have bought more than once</small></div>
            <div class="tile">
              <span>Conversion</span>
              <strong class="figures">{{ pct(d.conversion.rate) }}</strong>
              <em>{{ d.conversion.since ? `${d.conversion.buyers} of ${d.conversion.shoppers} shoppers bought` : 'Starts with view tracking' }}</em>
              <small>{{ d.conversion.since ? `Counted ${since(d.conversion.since)}` : 'Shoppers’ visits are recorded from now on' }}</small>
            </div>
            <div class="tile"><span>Cancelled</span><strong class="figures">{{ pct(d.cancellations.rate) }}</strong><em>{{ d.cancellations.cancelled }} of {{ d.cancellations.placed }} orders</em><small>Not counted as sales</small></div>
          </div>

          <section class="panel pad">
            <h2>Net sales by day</h2>
            <StackedDays :series="d.series" :keys="SALES_KEYS" :format="money" label="Net sales by day" />
          </section>

          <div class="grid3">
            <section class="panel pad">
              <h2>Where the money comes from</h2>
              <dl class="kv figures">
                <dt>Product sales</dt><dd>{{ money(d.productSales) }}</dd>
                <dt>Delivery charged</dt><dd>{{ money(d.shippingCharged) }}</dd>
                <dt>Promo discounts</dt><dd>−{{ money(d.discounts) }}</dd>
                <dt>Gross sales</dt><dd>{{ money(d.gross.total) }}</dd>
                <dt>Refunds ({{ d.refunds.count }})</dt><dd>−{{ money(d.refunds.total) }}</dd>
                <dt><b>Net sales</b></dt><dd><b>{{ money(d.net.total) }}</b></dd>
              </dl>
              <p class="muted small">New buyers brought {{ money(d.buyers.newRevenue) }}, returning buyers {{ money(d.buyers.returningRevenue) }}.</p>
            </section>
            <section class="panel pad">
              <h2>How people pay</h2>
              <BarList :items="d.payments.map((p) => ({ name: METHOD[p.method] ?? p.method, value: p.orders, note: `${pct(p.share)} of orders · ${money(p.gross)}` }))" :format="count" empty="No sales in this period." />
            </section>
            <section class="panel pad">
              <h2>Promo codes</h2>
              <BarList :items="d.promos.map((p) => ({ name: p.code, value: p.orders, note: `${money(p.discount)} given away` }))" :format="(v) => plural(v, 'order')" empty="No promo codes used." />
            </section>
          </div>

          <section class="panel pad">
            <h2>When people buy</h2>
            <HourHeatmap :grid="d.heatmap" />
          </section>
        </template>

        <!-- ======================= DEMAND ======================= -->
        <template v-else-if="tab === 'demand'">
          <p v-if="!d.tracking.since" class="banner info">
            Views, searches, cart adds, favourites and try-ons are recorded from now on. Sales below are complete; the demand columns fill in as shoppers browse.
          </p>
          <p v-else class="muted small">Browsing recorded {{ since(d.tracking.since) }}.</p>

          <section class="panel">
            <div class="panel-head"><h2>Best sellers</h2><span class="muted small">Units, then how shoppers got there</span></div>
            <div class="table-wrap">
              <table class="table">
                <thead>
                  <tr><th>Product</th><th class="num">Units</th><th class="num">Change</th><th class="num">Sales</th><th class="num">Views</th><th class="num">Viewers who bought</th><th class="num">Cart adds</th><th class="num">Returned</th><th class="num">Stock</th><th class="num">Days of stock</th></tr>
                </thead>
                <tbody>
                  <tr v-for="p in d.topSellers" :key="p.id">
                    <td class="with-thumb"><img class="thumb" :src="p.image" alt="" /><RouterLink :to="`/products/${p.id}`">{{ p.name }}</RouterLink></td>
                    <td class="num figures">{{ p.units }}</td>
                    <td class="num figures" :class="deltaClass(p.change)">{{ !d.sample.comparable ? '—' : (signed(p.change) ?? (p.previousUnits === 0 ? 'new' : '—')) }}</td>
                    <td class="num figures">{{ money(p.revenue) }}</td>
                    <td class="num figures">{{ p.views || '—' }}</td>
                    <td class="num figures" :title="p.viewers ? `${p.viewersWhoBought} of ${p.viewers} viewers` : ''">{{ pct(p.viewToOrder) }}</td>
                    <td class="num figures">{{ p.cartAdds || '—' }}</td>
                    <td class="num figures">{{ p.returned ? `${p.returned} (${pct(p.returnRate)})` : '—' }}</td>
                    <td class="num figures">{{ p.stock }}</td>
                    <td class="num figures" :class="{ warnText: p.daysOfCover != null && p.daysOfCover <= 14 }">{{ p.daysOfCover ?? '—' }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p v-if="!d.topSellers.length" class="panel-body muted">No sales in this period.</p>
          </section>

          <div class="grid3">
            <section class="panel pad">
              <h2>Rising</h2>
              <p class="muted small">At least 3 units, and half as many again as the period before.</p>
              <BarList :items="d.rising.map((p) => ({ name: p.name, value: p.units, note: `${p.previousUnits} before${p.change != null ? ` · ${signed(p.change)}` : ' · new'}` }))" :format="(v) => plural(v, 'unit')" :empty="d.sample.comparable ? 'Nothing is clearly rising.' : 'No earlier period with sales to compare with.'" />
            </section>
            <section class="panel pad">
              <h2>Running out</h2>
              <p class="muted small">14 days of stock or less at the current pace.</p>
              <BarList :items="d.runningOut.map((p) => ({ name: p.name, value: p.daysOfCover, note: `${p.stock} left · ${p.units} sold` }))" :format="(v) => `${v} days`" empty="Nothing is about to run out." />
            </section>
            <section class="panel pad">
              <h2>Lost to sold out</h2>
              <p class="muted small">Out of stock, still being looked at or added to carts.</p>
              <BarList :items="d.lostDemand.map((p) => ({ name: p.name, value: p.views + p.cartAdds, note: `${p.views} views · ${p.cartAdds} cart adds` }))" :format="count" :empty="d.tracking.since ? 'Nothing wanted is sold out.' : 'Needs view tracking.'" />
            </section>
          </div>

          <div class="grid2">
            <section class="panel pad">
              <h2>What people search for</h2>
              <p class="muted small">{{ count(d.searches.total) }} searches.</p>
              <BarList :items="d.searches.top.map((s) => ({ name: s.query, value: s.searches, note: `${s.people} ${s.people === 1 ? 'person' : 'people'} · ~${s.avgResults ?? 0} results` }))" :format="count" empty="No searches recorded yet." />
            </section>
            <section class="panel pad">
              <h2>Searched for, not found</h2>
              <p class="muted small">Searches that found nothing: the clearest sign of what to stock.</p>
              <BarList :items="d.searches.unmet.map((s) => ({ name: s.query, value: s.zeroResults, note: `${s.people} ${s.people === 1 ? 'person' : 'people'}` }))" :format="(v) => plural(v, 'search', 'searches')" empty="Every search found something." />
            </section>
            <section class="panel pad">
              <h2>Most looked at</h2>
              <BarList :items="d.mostWanted.map((p) => ({ name: p.name, value: p.views, note: `${p.viewers} people · ${p.cartAdds} cart adds · ${p.units} sold` }))" :format="count" empty="No views recorded yet." />
            </section>
            <section class="panel pad">
              <h2>Looked at, rarely bought</h2>
              <p class="muted small">5+ viewers. Price, photos or sizes may be putting people off.</p>
              <BarList :items="d.viewedNotBought.map((p) => ({ name: p.name, value: p.viewToOrder ?? 0, note: `${p.viewersWhoBought} of ${p.viewers} viewers bought` }))" :format="pct" empty="Nothing stands out yet." />
            </section>
          </div>

          <section class="panel pad">
            <h2>What sells, by attribute</h2>
            <div class="attrs">
              <div v-for="(label, k) in ATTR" :key="k">
                <h3>{{ label }}</h3>
                <BarList :items="d.attributes[k].map((a) => ({ name: a.name, value: a.units, note: `${pct(a.share)}${a.change != null ? ` · ${signed(a.change)}` : ''}` }))" :format="count" :limit="6" empty="—" />
              </div>
            </div>
          </section>

          <section class="panel pad">
            <h2>Product requests</h2>
            <p class="muted small">{{ plural(d.requests.total, 'request') }} for things the store doesn’t have.</p>
            <div class="grid2 flat">
              <BarList :items="d.requests.byCategory.map((c) => ({ name: c.category, value: c.count }))" :format="count" empty="No requests in this period." />
              <ul class="plain">
                <li v-for="(r, i) in d.requests.latest" :key="i"><b>{{ r.product }}</b> <span class="muted">· {{ r.category }}{{ r.size ? ` · size ${r.size}` : '' }}{{ r.budget ? ` · up to ${money(r.budget)}` : '' }} · {{ date(r.createdAt) }}</span></li>
              </ul>
            </div>
          </section>
        </template>

        <!-- ======================= CUSTOMERS ======================= -->
        <template v-else-if="tab === 'customers'">
          <div class="kpis">
            <div class="tile"><span>Customers</span><strong class="figures">{{ count(d.totals.customers) }}</strong><em>{{ d.totals.buyersEver }} have bought · {{ d.totals.neverBought }} haven’t</em></div>
            <div class="tile"><span>Sign-ups</span><strong class="figures">{{ count(d.totals.signups.total) }}</strong><em :class="deltaClass(d.totals.signups.change)">{{ signed(d.totals.signups.change) ?? 'no earlier data' }}</em></div>
            <div class="tile"><span>Lifetime value</span><strong class="figures">{{ money(d.totals.avgLifetimeValue) }}</strong><em>per buyer, all time</em></div>
            <div class="tile"><span>Orders per buyer</span><strong class="figures">{{ d.totals.avgOrdersPerBuyer }}</strong><em>{{ pct(d.totals.repeatShare) }} bought again</em></div>
            <div class="tile"><span>Between orders</span><strong class="figures">{{ d.totals.medianDaysBetweenOrders == null ? '—' : `${d.totals.medianDaysBetweenOrders} days` }}</strong><em>median, from {{ plural(d.totals.gapsMeasured, 'repeat order') }}</em></div>
          </div>
          <div class="grid2">
            <section class="panel pad">
              <h2>Segments</h2>
              <p class="muted small">Every buyer, by how recently and how often they buy (all time).</p>
              <BarList :items="d.segments.map((s) => ({ name: s.name, value: s.customers, note: `${SEG_NOTE[s.name]} · ${pct(s.share)} · ${money(s.spent)} spent` }))" :format="count" />
            </section>
            <section class="panel pad">
              <h2>Top customers in this period</h2>
              <ul class="plain">
                <li v-for="c in d.top" :key="c.id">
                  <RouterLink :to="`/customers/${c.id}`"><b>{{ c.name }}</b></RouterLink>
                  <span class="muted"> · {{ c.segment }} · {{ plural(c.orders, 'order') }} · last {{ date(c.lastOrderAt) }}</span>
                  <b class="right figures">{{ money(c.spent) }}</b>
                </li>
              </ul>
              <p v-if="!d.top.length" class="muted">No buyers in this period.</p>
            </section>
          </div>
          <section class="panel">
            <div class="panel-head"><h2>Coming back</h2><span class="muted small">Buyers by month of first purchase, and the share who bought again each month after. Months still running show —.</span></div>
            <div class="table-wrap">
              <table class="table cohorts">
                <thead><tr><th>First bought</th><th class="num">Buyers</th><th v-for="m in 6" :key="m" class="num">Month {{ m }}</th></tr></thead>
                <tbody>
                  <tr v-for="c in d.cohorts" :key="c.month">
                    <td>{{ c.month }}</td>
                    <td class="num figures">{{ c.customers }}</td>
                    <td v-for="(v, i) in c.retention" :key="i" class="num figures" :style="v != null ? { background: `rgba(42, 120, 214, ${Math.min(0.85, v / 100)})`, color: v > 55 ? '#fff' : undefined } : {}">{{ v == null ? '—' : `${v}%` }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>
        </template>

        <!-- ======================= REGIONS ======================= -->
        <template v-else-if="tab === 'regions'">
          <div class="toolbar-row">
            <Tabs v-model="level" label="Region level" :items="[{ value: 'region', label: 'Countries & divisions' }, { value: 'place', label: 'Cities & districts' }]" />
            <span v-if="d.unmatched.orders" class="muted small">{{ plural(d.unmatched.orders, 'order') }} with an address that couldn’t be placed ({{ d.unmatched.examples.join('; ') }}).</span>
          </div>
          <section class="panel">
            <div class="table-wrap">
              <table class="table">
                <thead><tr><th>Region</th><th class="num">Sales</th><th class="num">Share</th><th class="num">Orders</th><th class="num">Change</th><th class="num">Buyers</th><th class="num">Avg order</th><th class="num">Cash on delivery</th><th class="num">Return rate</th><th class="num">Delivery time</th></tr></thead>
                <tbody>
                  <tr v-for="r in d.regions" :key="r.name">
                    <td class="primary-cell">{{ r.name }} <span v-if="r.lowSample" class="sub muted" title="Fewer than 10 orders">few orders</span></td>
                    <td class="num figures">{{ money(r.gross) }}</td>
                    <td class="num figures">{{ pct(r.share) }}</td>
                    <td class="num figures">{{ r.orders }}</td>
                    <td class="num figures" :class="deltaClass(r.change)">{{ !d.sample.comparable ? '—' : (signed(r.change) ?? (r.previousOrders ? '—' : 'new')) }}</td>
                    <td class="num figures">{{ r.buyers }}</td>
                    <td class="num figures">{{ money(r.aov) }}</td>
                    <td class="num figures">{{ pct(r.codShare) }}</td>
                    <td class="num figures">{{ pct(r.returnRate) }}</td>
                    <td class="num figures">{{ r.deliveriesMeasured ? hours(r.avgDeliveryHours) : '—' }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p v-if="!d.regions.length" class="panel-body muted">No sales in this period.</p>
          </section>

          <h2 class="section-title">Fashion trends by region</h2>
          <p class="muted small">
            What each region buys most (share of its units), and <b>lift</b>: how much more it buys that than the store as a whole (×1.5 = half as much again), shown once a region has bought at least 10 items.
            <template v-if="!d.sample.comparable"> There’s no earlier period with sales yet, so nothing is marked rising.</template>
          </p>
          <div class="region-cards">
            <section v-for="r in d.regions.slice(0, 12)" :key="r.name" class="panel pad">
              <div class="region-head"><h3>{{ r.name }}</h3><span class="muted small">{{ plural(r.units, 'item') }} · {{ plural(r.orders, 'order') }}</span></div>
              <div class="tastes">
                <div v-for="attr in ['category', 'type', 'color', 'style', 'occasion', 'size']" :key="attr">
                  <h4>{{ ATTR[attr] }}</h4>
                  <ol class="taste">
                    <li v-for="t in regionTaste(r, attr).top.slice(0, 3)" :key="t.name">
                      <span>{{ t.name }}</span>
                      <span class="muted figures">{{ pct(t.share) }}<template v-if="t.lift != null && t.lift >= 1.2"> · <b class="lift">×{{ t.lift }}</b></template></span>
                    </li>
                    <li v-if="!regionTaste(r, attr).top.length" class="muted">—</li>
                  </ol>
                </div>
              </div>
              <p v-if="Object.values(r.tastes).some((t) => t.rising.length)" class="rising">
                <b>Rising:</b>
                {{ Object.entries(r.tastes).flatMap(([k, t]) => t.rising.slice(0, 2).map((x) => `${x.name} (${x.previous}→${x.units})`)).slice(0, 5).join(', ') }}
              </p>
            </section>
          </div>

          <div class="grid2">
            <section class="panel pad">
              <h2>Searches by region</h2>
              <p class="muted small">From each shopper’s latest delivery address.</p>
              <div v-for="s in d.searches" :key="s.name" class="search-region">
                <h4>{{ s.name }}</h4>
                <p class="small">{{ s.top.map((t) => `${t.query} (${t.searches}${t.zeroResults ? `, ${t.zeroResults} found nothing` : ''})`).join(' · ') }}</p>
              </div>
              <p v-if="!d.searches.length" class="muted">No searches recorded yet.</p>
            </section>
            <section class="panel pad">
              <h2>Season by season</h2>
              <p class="muted small">Units sold per category per month, last 12 months, every region.</p>
              <div class="table-wrap">
                <table class="table compact">
                  <thead><tr><th>Category</th><th v-for="m in d.seasonality.months" :key="m" class="num">{{ m.slice(5) }}/{{ m.slice(2, 4) }}</th></tr></thead>
                  <tbody>
                    <tr v-for="c in d.seasonality.categories" :key="c.name">
                      <td>{{ c.name }}</td>
                      <td v-for="(u, i) in c.units" :key="i" class="num figures" :style="u ? { background: `rgba(42, 120, 214, ${Math.min(0.8, 0.12 + u / Math.max(...c.units) * 0.6)})`, color: u / Math.max(...c.units) > 0.8 ? '#fff' : undefined } : {}">{{ u || '' }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </section>
          </div>
        </template>

        <!-- ======================= RETURNS ======================= -->
        <template v-else-if="tab === 'returns'">
          <div class="kpis">
            <div class="tile"><span>Return rate</span><strong class="figures">{{ pct(d.totals.returnRate) }}</strong><em>{{ d.totals.unitsReturned }} of {{ d.totals.unitsSold }} items</em></div>
            <div class="tile"><span>Requests</span><strong class="figures">{{ d.totals.requests }}</strong><em>{{ d.totals.open }} open · {{ d.totals.rejected }} turned down</em></div>
            <div class="tile"><span>Refunded</span><strong class="figures">{{ taka(d.totals.refundBdt) }}</strong><em>{{ money(d.totals.refundUsd) }} · {{ plural(d.totals.refunded, 'return') }}</em></div>
            <div class="tile"><span>Back in stock</span><strong class="figures">{{ d.totals.restocked }}</strong><em>{{ d.totals.writtenOff }} written off</em></div>
            <div class="tile"><span>Time to refund</span><strong class="figures">{{ hours(d.totals.hoursRequestToRefund) }}</strong><em>from request, average</em></div>
          </div>
          <div class="grid3">
            <section class="panel pad"><h2>Why</h2><BarList :items="d.byReason.map((x) => ({ name: REASON[x.name] ?? x.name, value: x.units, note: pct(x.share) }))" :format="(v) => plural(v, 'item')" empty="No returns in this period." /></section>
            <section class="panel pad"><h2>Which products</h2><BarList :items="d.byProduct.map((x) => ({ name: x.name, value: x.units, note: pct(x.share) }))" :format="(v) => plural(v, 'item')" empty="—" /></section>
            <section class="panel pad"><h2>Which categories</h2><BarList :items="d.byCategory.map((x) => ({ name: x.name, value: x.units, note: pct(x.share) }))" :format="(v) => plural(v, 'item')" empty="—" /></section>
            <section class="panel pad"><h2>Which regions</h2><BarList :items="d.byRegion.map((x) => ({ name: x.name, value: x.units, note: pct(x.share) }))" :format="(v) => plural(v, 'item')" empty="—" /></section>
            <section class="panel pad">
              <h2>Fit</h2>
              <p class="muted small">Sizes sent back as too small or too large. Mostly “too small” means the size runs small.</p>
              <table v-if="d.fit.length" class="table compact">
                <thead><tr><th>Size</th><th class="num">Too small</th><th class="num">Too large</th></tr></thead>
                <tbody><tr v-for="f in d.fit" :key="f.size"><td>{{ f.size }}</td><td class="num figures">{{ f.tooSmall }}</td><td class="num figures">{{ f.tooLarge }}</td></tr></tbody>
              </table>
              <p v-else class="muted">No fit returns.</p>
            </section>
            <section class="panel pad">
              <h2>Status</h2>
              <ul class="plain"><li v-for="s in d.byStatus" :key="s.status"><StatusTag :status="`RT_${s.status}`" /> <b class="right figures">{{ s.count }}</b></li></ul>
              <p v-if="!d.byStatus.length" class="muted">—</p>
            </section>
          </div>
        </template>

        <!-- ======================= DELIVERY ======================= -->
        <template v-else-if="tab === 'delivery'">
          <section class="panel">
            <div class="panel-head"><h2>By carrier</h2><span class="muted small">{{ plural(d.total, 'shipment') }} booked in this period</span></div>
            <div class="table-wrap">
              <table class="table">
                <thead><tr><th>Carrier</th><th class="num">Shipments</th><th class="num">Delivered</th><th class="num">Success rate</th><th class="num">Had a failed attempt</th><th class="num">Returned</th><th class="num">On the way</th><th class="num">Average time</th><th class="num">Median time</th><th class="num">Avg charge</th><th class="num">Cash collected</th></tr></thead>
                <tbody>
                  <tr v-for="c in d.byCarrier" :key="c.carrier">
                    <td class="primary-cell">{{ CARRIER[c.carrier] ?? c.carrier }}</td>
                    <td class="num figures">{{ c.shipments }}</td>
                    <td class="num figures">{{ c.delivered }}</td>
                    <td class="num figures">{{ pct(c.successRate) }}</td>
                    <td class="num figures">{{ pct(c.withFailedAttempt) }}</td>
                    <td class="num figures">{{ c.returned }}</td>
                    <td class="num figures">{{ c.onTheWay }}</td>
                    <td class="num figures">{{ hours(c.avgHours) }}</td>
                    <td class="num figures">{{ hours(c.medianHours) }}</td>
                    <td class="num figures">{{ c.avgCharge == null ? '—' : taka(c.avgCharge) }}</td>
                    <td class="num figures">{{ taka(c.codCollected) }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p v-if="!d.byCarrier.length" class="panel-body muted">No deliveries booked in this period.</p>
          </section>
          <div class="grid2">
            <section class="panel pad">
              <h2>Riders</h2>
              <ul class="plain">
                <li v-for="r in d.riders" :key="r.name"><b>{{ r.name }}</b><span class="muted"> · {{ r.delivered }}/{{ r.assigned }} delivered · {{ r.failedAttempts }} with a failed attempt · {{ hours(r.avgHoursPickupToDoor) }} pickup to door</span><b class="right figures">{{ taka(r.cashCollected) }}</b></li>
              </ul>
              <p v-if="!d.riders.length" class="muted">No rider deliveries in this period.</p>
            </section>
            <section class="panel pad">
              <h2>By region</h2>
              <BarList :items="d.byRegion.map((x) => ({ name: x.name, value: x.shipments, note: `${pct(x.successRate)} delivered of those finished` }))" :format="count" empty="—" />
            </section>
          </div>
        </template>

        <!-- ======================= AI COSTS ======================= -->
        <template v-else-if="tab === 'ai-costs'">
          <p v-if="!d.available" class="banner">The AI service isn’t answering, so its spending meter can’t be read. Check System.</p>
          <template v-else>
            <p class="muted small">{{ d.note }} The meter keeps 40 days<template v-if="days > 40">, so this shows the last 40</template>.</p>
            <div class="kpis">
              <div class="tile"><span>AI spend</span><strong class="figures">{{ usd4(d.total) }}</strong><em v-if="d.usdToBdt">{{ taka(d.total * d.usdToBdt) }}</em><small>last {{ d.days }} days</small></div>
              <div class="tile"><span>This month</span><strong class="figures">{{ usd4(d.monthToDate) }}</strong><em>on pace for {{ usd4(d.projectedMonth) }}</em></div>
              <div class="tile"><span>Per order</span><strong class="figures">{{ usd4(d.perOrder) }}</strong><em>{{ plural(d.orders, 'order') }}</em></div>
              <div class="tile"><span>Per buyer</span><strong class="figures">{{ usd4(d.perBuyer) }}</strong></div>
              <div class="tile"><span>Share of sales</span><strong class="figures">{{ pct(d.shareOfSales) }}</strong><em>of {{ money(d.gross) }}</em></div>
              <div class="tile"><span>Prompt cache</span><strong class="figures">{{ pct(d.tokens.cacheHitRate) }}</strong><em>of prompt tokens read from cache</em></div>
            </div>
            <section class="panel pad">
              <h2>Spend by day</h2>
              <StackedDays :series="d.series" :keys="VENDOR_KEYS" :format="usd4" label="AI spend by day and vendor" />
            </section>
            <div class="grid3">
              <section class="panel pad">
                <h2>By service</h2>
                <BarList :items="d.byVendor.map((v) => ({ name: v.name, value: v.cost, note: `${count(v.calls)} calls${v.credits ? ` · ${count(v.credits)} credits` : ''}` }))" :format="usd4" />
              </section>
              <section class="panel pad">
                <h2>Claude, by feature</h2>
                <BarList :items="d.byFeature.map((f) => ({ name: f.feature, value: f.cost, note: `${count(f.calls)} calls · ${usd4(f.perCall)} each` }))" :format="usd4" empty="No Claude calls in this period." />
              </section>
              <section class="panel pad">
                <h2>Usage</h2>
                <dl class="kv figures">
                  <dt>Input tokens</dt><dd>{{ count(d.tokens.input) }}</dd>
                  <dt>Output tokens</dt><dd>{{ count(d.tokens.output) }}</dd>
                  <dt>Cache reads</dt><dd>{{ count(d.tokens.cacheRead) }}</dd>
                  <dt>Cache writes</dt><dd>{{ count(d.tokens.cacheWrite) }}</dd>
                  <dt>Web searches</dt><dd>{{ count(d.tokens.webSearches) }}</dd>
                  <dt>Speech heard</dt><dd>{{ count(Math.round(d.tokens.speechSeconds)) }} s</dd>
                  <dt>Speech spoken</dt><dd>{{ count(d.tokens.spokenChars) }} chars</dd>
                  <template v-for="(n, what) in d.saved" :key="what"><dt>Saved by cache: {{ what }}</dt><dd>{{ count(n) }}</dd></template>
                </dl>
              </section>
            </div>
            <section class="panel pad">
              <h2>Daily caps</h2>
              <p class="muted small">Past a cap, the feature switches to its free version for the rest of the UTC day (Pip’s rule-based replies, the on-device try-on preview, the browser’s voice). Caps are set in backend/.env.</p>
              <dl class="kv figures">
                <dt>Claude</dt><dd>{{ d.caps?.claude ? `${money(d.caps.claude)} a day · today ${usd4(d.today?.claude)}` : 'No cap' }}</dd>
                <dt>FASHN try-on</dt><dd>{{ d.caps?.fashn ? `${money(d.caps.fashn)} a day · today ${usd4(d.today?.tryOn)}` : 'No cap' }}</dd>
                <dt>Voice</dt><dd>{{ d.caps?.voice ? `${money(d.caps.voice)} a day · today ${usd4(d.today?.voice)}` : 'No cap' }}</dd>
                <dt>Pip’s model</dt><dd>{{ d.models?.agent ?? '—' }}</dd>
              </dl>
            </section>
          </template>
        </template>

        <!-- ======================= VISITORS & JOURNEYS ======================= -->
        <template v-else-if="tab === 'interests'">
          <InterestsPanel :d="d" />
        </template>

        <template v-else-if="tab === 'visitors'">
          <p v-if="d.totals.lowSample" class="banner">
            Only {{ plural(d.totals.visits, 'visit') }} in this period: treat rates and averages as rough until there are more.
          </p>
          <div class="kpis">
            <div class="tile"><span>Visits</span><strong class="figures">{{ count(d.totals.visits) }}</strong><em :class="deltaClass(d.totals.visitsChange)">{{ signed(d.totals.visitsChange) ?? 'no earlier data' }}</em><small>{{ pct(d.totals.signedInRate) }} signed in</small></div>
            <div class="tile"><span>Visitors</span><strong class="figures">{{ count(d.totals.visitors) }}</strong><em>Devices</em><small>The same person on two devices counts twice</small></div>
            <div class="tile"><span>Average visit</span><strong class="figures">{{ secs(d.totals.avgVisitSeconds) }}</strong><em>{{ d.totals.pagesPerVisit ?? 0 }} pages per visit</em><small>Time on screen only</small></div>
            <div class="tile"><span>Bounce rate</span><strong class="figures">{{ pct(d.totals.bounceRate) }}</strong><em>Left after one page</em></div>
            <div class="tile"><span>Visit conversion</span><strong class="figures">{{ pct(d.totals.conversionRate) }}</strong><em>Visits with an order</em><small>During the visit or 30 minutes after</small></div>
          </div>

          <section class="panel pad">
            <h2>Visits by day</h2>
            <StackedDays :series="d.daily" :keys="VISIT_KEYS" :format="count" label="Visits by day" />
          </section>

          <div class="grid3">
            <section class="panel pad">
              <h2>Where visitors come from</h2>
              <BarList :items="d.sources.map((s) => ({ name: SOURCE[s.key] ?? s.key, value: s.n, note: `${pct(s.conversionRate)} converted · ${secs(s.avgSeconds)} average` }))" :format="(v) => plural(v, 'visit')" empty="No visits yet." />
            </section>
            <section class="panel pad">
              <h2>Referring sites</h2>
              <BarList :items="d.referrers.filter((r) => r.key).map((r) => ({ name: r.key, value: r.n }))" :format="(v) => plural(v, 'visit')" empty="No visits from other sites yet." />
            </section>
            <section class="panel pad">
              <h2>Landing pages</h2>
              <p class="muted small">The first page of a visit.</p>
              <BarList :items="d.landings.map((l) => ({ name: l.key, value: l.n, note: `${pct(l.bounceRate)} left straight away` }))" :format="(v) => plural(v, 'visit')" empty="No visits yet." />
            </section>
          </div>

          <div class="grid2">
            <section class="panel pad">
              <h2>Where they left</h2>
              <p class="muted small">The last page of each visit. Exit rate: how often seeing that page ended the visit.</p>
              <BarList :items="d.exits.map((e) => ({ name: e.key, value: e.n, note: `${pct(e.exitRate)} exit rate · ${count(e.views)} views` }))" :format="(v) => plural(v, 'exit')" empty="No visits yet." />
            </section>
            <section class="panel pad">
              <h2>Paths through the store</h2>
              <p class="muted small">The most common next step from each kind of page.</p>
              <ol v-if="d.flows.length" class="plain">
                <li v-for="f in d.flows" :key="`${f.from}-${f.to}`">
                  <span>{{ routeName(f.from) }}</span><span class="muted">→</span><span :class="{ warnText: f.to === '(left)' }">{{ routeName(f.to) }}</span>
                  <span class="right figures">{{ count(f.n) }}</span>
                </li>
              </ol>
              <p v-else class="muted small">No paths yet.</p>
            </section>
          </div>

          <section class="panel">
            <div class="panel-head"><h2>Time on page</h2><span class="muted small">On screen only; hidden tabs don’t count</span></div>
            <div class="table-wrap">
              <table class="table">
                <thead><tr><th>Page</th><th class="num">Views</th><th class="num">Average</th><th class="num">Median</th><th class="num">Scrolled</th></tr></thead>
                <tbody>
                  <tr v-for="p in d.pages" :key="p.route">
                    <td>{{ routeName(p.route) }}</td>
                    <td class="num figures">{{ count(p.views) }}</td>
                    <td class="num figures">{{ secs(p.avg) }}</td>
                    <td class="num figures">{{ secs(p.median) }}</td>
                    <td class="num figures">{{ p.scroll == null ? '—' : `${p.scroll}%` }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p v-if="!d.pages.length" class="panel-body muted">No pages recorded yet.</p>
          </section>

          <div class="grid3">
            <section class="panel pad">
              <h2>Countries</h2>
              <BarList :items="d.countries.map((c) => ({ name: c.key ?? 'Unknown', value: c.n }))" :format="(v) => plural(v, 'visit')" empty="No visits yet." />
            </section>
            <section class="panel pad">
              <h2>Cities</h2>
              <p class="muted small">Only when the CDN or GeoIP knows the city.</p>
              <BarList :items="d.cities.map((c) => ({ name: c.key, value: c.n }))" :format="(v) => plural(v, 'visit')" empty="No city-level locations yet (needs CDN location headers or GEOIP_DB)." />
            </section>
            <section class="panel pad">
              <h2>Devices &amp; browsers</h2>
              <BarList :items="d.devices.map((x) => ({ name: x.key ?? 'Unknown', value: x.n }))" :format="(v) => plural(v, 'visit')" empty="No visits yet." />
              <h3 class="sub">Browsers</h3>
              <BarList :items="d.browsers.map((x) => ({ name: x.key ?? 'Unknown', value: x.n }))" :format="(v) => plural(v, 'visit')" empty="No visits yet." />
            </section>
          </div>

          <h2 class="section-title">Who’s shopping <span class="muted small">· assumed from behaviour, never facts</span></h2>
          <p class="muted small">Signed-in shoppers who visited in this period, by the profile the store has built from what they browse, try on and buy.</p>
          <div class="grid3">
            <section class="panel pad">
              <h2>Shopping personalities</h2>
              <BarList :items="d.personalities.map((p) => ({ name: p.label, value: p.n }))" :format="(v) => plural(v, 'shopper')" empty="No profiles yet." />
            </section>
            <section class="panel pad">
              <h2>Age groups (assumed)</h2>
              <BarList :items="d.ageGroups.map((a) => ({ name: a.key === 'unknown' ? 'Not enough to tell' : a.key, value: a.n }))" :format="(v) => plural(v, 'shopper')" empty="No profiles yet." />
            </section>
            <section class="panel pad">
              <h2>Price comfort</h2>
              <BarList :items="d.priceBands.map((b) => ({ name: PRICE_BAND[b.key] ?? b.key, value: b.n }))" :format="(v) => plural(v, 'shopper')" empty="No profiles yet." />
            </section>
          </div>

          <section class="panel">
            <div class="panel-head"><h2>Recent visits</h2><span class="muted small">Click a visit to see its journey</span></div>
            <div class="table-wrap">
              <table class="table compact">
                <thead><tr><th>Started</th><th>Who</th><th>From</th><th>Where</th><th>Device</th><th>Landed on</th><th>Left from</th><th class="num">Pages</th><th class="num">Time</th><th>Order</th></tr></thead>
                <tbody>
                  <tr v-for="v in d.recent" :key="v.id" class="clickable" tabindex="0" @click="openVisit = v.id" @keydown.enter="openVisit = v.id">
                    <td class="figures">{{ dateTime(v.startedAt) }}</td>
                    <td>{{ v.name ?? 'Guest' }}</td>
                    <td>{{ SOURCE[v.source] ?? v.source }}{{ v.referrer ? ` · ${v.referrer}` : '' }}</td>
                    <td>{{ place(v) }}</td>
                    <td>{{ v.device ?? '—' }}</td>
                    <td>{{ v.landing }}</td>
                    <td>{{ v.exitPath ?? '—' }}</td>
                    <td class="num figures">{{ v.pageCount }}</td>
                    <td class="num figures">{{ secs(Math.round(v.activeMs / 1000)) }}</td>
                    <td>{{ v.converted ? 'Yes' : '' }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p v-if="!d.recent.length" class="panel-body muted">No visits yet. They appear a few seconds after shoppers browse the storefront.</p>
          </section>
        </template>

        <details class="panel pad how">
          <summary>How it’s counted</summary>
          <ul>
            <li>A sale is an order that isn’t cancelled or still waiting for online payment, counted on the day it was placed, in the store’s time zone ({{ d.range?.tz ?? 'Asia/Dhaka' }}).</li>
            <li>Money is in dollars, the store’s price currency. Refunds are paid in taka and converted back at the rate their own order was charged. Net sales = gross sales − refunds made in the period.</li>
            <li>Views are counted once per shopper per product every 30 minutes; searches once per shopper per search every 10 minutes. Both are recorded from the day tracking started.</li>
            <li>“Rising” needs at least 3 units and half as many again as the period before. Regions with fewer than 10 orders are marked “few orders”.</li>
            <li>Regions come from the delivery address. Bangladeshi addresses are matched to their district and division, including old spellings (Chittagong, Bogra) and neighbourhoods (Dhanmondi, Agrabad); addresses that can’t be matched are counted as unknown, never guessed.</li>
            <li>AI costs are the AI service’s own estimates at list prices, per UTC day.</li>
            <template v-if="tab === 'visitors'">
              <li>A visit is one device’s browsing until it’s idle for 30 minutes. A visitor is one device (a random id it keeps), so the same person on a phone and a laptop counts twice until they sign in.</li>
              <li>Time on a page is the time it was actually on screen: a hidden tab or a locked phone doesn’t count.</li>
              <li>A bounce is a visit that saw one page. The exit page is the last page of a visit.</li>
              <li>A visit converted when its signed-in shopper placed an order during it or within 30 minutes after.</li>
              <li>Locations are approximate (city from the CDN or GeoIP; otherwise just the country, from the device’s time zone). The IP address itself is never stored.</li>
              <li>Personalities, price comfort and age groups are assumptions from behaviour, never facts, and only for shoppers who haven’t turned personalisation off.</li>
              <li>Tracking started when this was released, and visitors who send Do Not Track or Global Privacy Control aren’t tracked at all, so totals undercount real traffic a little.</li>
            </template>
          </ul>
        </details>
      </template>
    </StateBlock>
    <VisitTimeline :id="openVisit" @close="openVisit = null" />
  </div>
</template>

<style scoped>
.range .select {
  min-width: 160px;
}
.tabs-row {
  margin: -6px 0 6px;
  overflow-x: auto;
}
.period {
  margin: 0 0 14px;
}
.banner {
  margin: 0 0 14px;
  padding: 12px 14px;
  border-radius: var(--r-panel);
  background: var(--butter);
  color: #1d2126;
  font-size: 14px;
}
.banner.info {
  background: var(--accent-soft);
}
.kpis {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
  gap: 12px;
  margin-bottom: 18px;
}
.tile {
  display: grid;
  gap: 2px;
  padding: 14px 16px;
  border: 1px solid var(--line);
  border-radius: var(--r-panel);
  background: var(--surface);
}
.tile span {
  color: var(--muted);
  font-size: 13px;
  font-weight: 600;
}
.tile strong {
  font-size: 24px;
  font-weight: 800;
  letter-spacing: -0.02em;
}
.tile em,
.tile small {
  color: var(--muted);
  font-size: 12.5px;
  font-style: normal;
}
.up {
  color: var(--ok) !important;
}
.down {
  color: var(--danger) !important;
}
.warnText {
  color: var(--warn);
  font-weight: 700;
}
.panel {
  margin-bottom: 18px;
}
.panel.pad h2 {
  margin: 0 0 8px;
}
.grid2,
.grid3 {
  display: grid;
  gap: 18px;
  align-items: start;
}
.grid2 {
  grid-template-columns: repeat(auto-fit, minmax(340px, 1fr));
}
.grid3 {
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
}
.grid2 > .panel,
.grid3 > .panel {
  margin-bottom: 0;
}
.grid2,
.grid3 {
  margin-bottom: 18px;
}
.grid2.flat {
  margin: 0;
}
.attrs {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 22px;
}
h3,
h4 {
  margin: 0 0 8px;
  font-size: 14px;
}
.plain {
  display: grid;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
  font-size: 13.5px;
}
.plain li {
  display: flex;
  gap: 6px;
  align-items: baseline;
  flex-wrap: wrap;
}
.right {
  margin-left: auto;
}
.small {
  font-size: 13px;
}
.toolbar-row {
  display: flex;
  gap: 14px;
  align-items: center;
  flex-wrap: wrap;
  margin-bottom: 14px;
}
.section-title {
  margin: 8px 0 4px;
  font-size: 18px;
}
.region-cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(330px, 1fr));
  gap: 14px;
  margin: 12px 0 18px;
}
.region-cards .panel {
  margin: 0;
}
.region-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 10px;
}
.region-head h3 {
  margin: 0;
  font-size: 16px;
}
.tastes {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
}
.tastes h4 {
  color: var(--muted);
  font-size: 12px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.taste {
  display: grid;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
  font-size: 13px;
}
.taste li {
  display: grid;
}
.lift {
  color: #1c5cab;
}
.rising {
  margin: 12px 0 0;
  padding-top: 10px;
  border-top: 1px solid var(--line);
  font-size: 13px;
}
.search-region + .search-region {
  margin-top: 10px;
}
.search-region p {
  margin: 0;
}
.compact th,
.compact td {
  padding: 6px 8px;
  font-size: 12.5px;
}
.cohorts td {
  transition: none;
}
.how summary {
  cursor: pointer;
  font-weight: 700;
}
.how ul {
  margin: 10px 0 0;
  padding-left: 18px;
  color: var(--muted);
  font-size: 13px;
  display: grid;
  gap: 6px;
}
.clickable {
  cursor: pointer;
}
.clickable:hover,
.clickable:focus-visible {
  background: var(--accent-soft);
}
.sub {
  margin: 14px 0 8px;
}
@media (max-width: 700px) {
  .tastes {
    grid-template-columns: repeat(2, 1fr);
  }
}
</style>
