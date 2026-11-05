<script setup>
import { trackSearch } from '../track.js'
import { computed, nextTick, reactive, ref, watch, watchEffect } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import PageHeader from '../components/PageHeader.vue'
import ProductCard from '../components/ProductCard.vue'
import Icon from '../components/Icon.vue'
import NotFoundView from './NotFoundView.vue'
import { products, categories, collections } from '../catalog.js'
import { toast } from '../toast.js'
import { api } from '../api.js'

const props = defineProps({
  mode: { type: String, required: true }, // shop | popular | category | collection
  slug: String,
})

const route = useRoute()
const router = useRouter()

const config = computed(() => {
  if (props.mode === 'category') {
    const c = categories[props.slug]
    return c && { ...c, base: products.filter((p) => p.category === props.slug) }
  }
  if (props.mode === 'collection') {
    const c = collections[props.slug]
    return (
      c && {
        ...c,
        base: products.filter((p) => (props.slug === 'offers' ? p.compareAt : p.collections.includes(props.slug))),
      }
    )
  }
  if (props.mode === 'popular')
    return { title: 'Popular products', subtitle: 'What everyone’s buying this week', base: products, defaultSort: 'popular' }
  return { title: 'All products', subtitle: `${products.length} pieces across clothing, shoes, gifts and home`, base: products }
})

watchEffect(() => {
  if (config.value) document.title = `${config.value.title} · Cartly`
})

// URL-synced controls, so filtered views can be shared and survive reloads.
const q = computed({
  get: () => route.query.q ?? '',
  set: (v) => setQuery({ q: v || undefined }),
})
const gender = computed(() => route.query.gender ?? 'all')
const type = computed(() => route.query.type ?? 'all')
const sort = computed({
  get: () => route.query.sort ?? config.value?.defaultSort ?? 'featured',
  set: (v) => setQuery({ sort: v }),
})
function setQuery(patch) {
  router.replace({ query: { ...route.query, ...patch } })
}

const types = computed(() => [...new Set(config.value?.base.map((p) => p.type))])
const allSizes = computed(() => [...new Set(config.value?.base.flatMap((p) => p.sizes))])
const allColors = computed(() => {
  const map = new Map()
  config.value?.base.forEach((p) => p.colors.forEach((c) => map.set(c.name, c.hex)))
  return [...map].map(([name, hex]) => ({ name, hex }))
})

const panelOpen = ref(false)
const filters = reactive({ min: '', max: '', sizes: [], colors: [], sale: false, isNew: false })
const toggle = (list, v) => (list.includes(v) ? list.splice(list.indexOf(v), 1) : list.push(v))
const activeCount = computed(
  () =>
    (filters.min !== '' || filters.max !== '' ? 1 : 0) +
    filters.sizes.length +
    filters.colors.length +
    (filters.sale ? 1 : 0) +
    (filters.isNew ? 1 : 0),
)
function clearFilters() {
  Object.assign(filters, { min: '', max: '', sizes: [], colors: [], sale: false, isNew: false })
}

const SORTS = {
  featured: () => 0,
  popular: (a, b) => b.popularity - a.popularity,
  newest: (a, b) => (b.isNew ? 1 : 0) - (a.isNew ? 1 : 0) || b.id - a.id,
  'price-asc': (a, b) => a.price - b.price,
  'price-desc': (a, b) => b.price - a.price,
  rating: (a, b) => b.rating - a.rating,
}

// Natural-language search ("warm jacket", "red dress under $100") is ranked by the AI
// service's semantic index. Plain keyword matches always count too, so nothing obvious
// goes missing while it loads or if the service is down.
const ranked = ref(null) // product id → relevance rank for the current search
let searching
watch(
  q,
  async (value) => {
    searching?.abort()
    ranked.value = null
    const term = value.trim()
    if (!term) return
    searching = new AbortController()
    try {
      const res = await api(`/products/search?q=${encodeURIComponent(term)}&limit=40`, { signal: searching.signal })
      const top = res.items[0]?.score ?? 0
      const relevant = res.engine === 'semantic' ? res.items.filter((p) => p.score >= Math.max(0.12, top * 0.35)) : res.items
      ranked.value = new Map(relevant.map((p, i) => [p.id, i]))
      // What the shopper actually saw (semantic and keyword matches together).
      nextTick(() => trackSearch(term, results.value.length))
    } catch {}
  },
  { immediate: true },
)
const byRelevance = (a, b) => (ranked.value.get(a.id) ?? 999) - (ranked.value.get(b.id) ?? 999)

const results = computed(() => {
  if (!config.value) return []
  const term = q.value.trim().toLowerCase()
  const word = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`) // "tee" finds tees, not "steel"
  const matches = (p) => ranked.value?.has(p.id) || word.test(`${p.name} ${p.label} ${p.type}`.toLowerCase())
  return config.value.base
    .filter(
      (p) =>
        (gender.value === 'all' || p.gender === gender.value || p.gender === 'unisex') &&
        (type.value === 'all' || p.type === type.value) &&
        (!term || matches(p)) &&
        (filters.min === '' || p.price >= Number(filters.min)) &&
        (filters.max === '' || p.price <= Number(filters.max)) &&
        (!filters.sizes.length || p.sizes.some((s) => filters.sizes.includes(s))) &&
        (!filters.colors.length || p.colors.some((c) => filters.colors.includes(c.name))) &&
        (!filters.sale || p.compareAt) &&
        (!filters.isNew || p.isNew),
    )
    .sort(term && ranked.value && sort.value === (config.value.defaultSort ?? 'featured') ? byRelevance : (SORTS[sort.value] ?? SORTS.featured))
})

const hero = computed(() => props.mode === 'category' || props.mode === 'collection')
const crumbs = computed(() => [{ label: 'Explore', to: '/' }, { label: config.value?.title }])

function copyCode() {
  navigator.clipboard?.writeText('WELCOME20').catch(() => {})
  toast('Code WELCOME20 copied')
}
</script>

<template>
  <NotFoundView v-if="!config" />
  <div v-else>
    <PageHeader :title="config.title" :subtitle="hero ? undefined : config.subtitle" :crumbs="crumbs">
      <label class="search">
        <Icon name="search" :size="18" />
        <input v-model.lazy="q" type="search" placeholder="Search, e.g. warm jacket under $150" @keydown.enter="q = $event.target.value" />
      </label>
      <select v-model="sort" class="select sort" aria-label="Sort by">
        <option value="featured">Featured</option>
        <option value="popular">Most popular</option>
        <option value="newest">Newest</option>
        <option value="rating">Top rated</option>
        <option value="price-asc">Price: low to high</option>
        <option value="price-desc">Price: high to low</option>
      </select>
      <button class="pill filter-btn" @click="panelOpen = true">
        Filters<b v-if="activeCount">{{ activeCount }}</b>
      </button>
    </PageHeader>

    <div class="page">
      <section v-if="hero" class="hero" :style="{ background: config.color }">
        <div class="hero-copy">
          <h2>{{ config.title }}</h2>
          <p>{{ config.subtitle }}</p>
          <button v-if="slug === 'offers'" class="glass code" @click="copyCode">
            Extra 20% off: <b>WELCOME20</b> <small>Copy</small>
          </button>
        </div>
        <img :src="config.image" alt="" />
      </section>

      <div class="toolbar">
        <div class="tabs" role="tablist" aria-label="Gender">
          <button
            v-for="g in ['all', 'men', 'women']"
            :key="g"
            role="tab"
            :aria-selected="gender === g"
            class="pill tab"
            :class="{ on: gender === g }"
            @click="setQuery({ gender: g === 'all' ? undefined : g })"
          >
            <Icon :name="g === 'all' ? 'grid' : g === 'men' ? 'man' : 'woman'" :size="17" />
            {{ g === 'all' ? 'All' : g === 'men' ? 'Men' : 'Women' }}
          </button>
        </div>
        <div v-if="types.length > 1" class="chips">
          <button
            v-for="t in ['all', ...types]"
            :key="t"
            class="chip"
            :class="{ on: type === t }"
            @click="setQuery({ type: t === 'all' ? undefined : t })"
          >
            {{ t === 'all' ? 'Everything' : t }}
          </button>
        </div>
      </div>

      <div v-if="activeCount || q" class="active">
        <span class="count">{{ results.length }} result{{ results.length === 1 ? '' : 's' }}</span>
        <button v-if="q" class="tag" @click="q = ''">“{{ q }}” <Icon name="close" :size="12" /></button>
        <button v-if="filters.min !== '' || filters.max !== ''" class="tag" @click="filters.min = filters.max = ''">
          ${{ filters.min || 0 }}–{{ filters.max ? `$${filters.max}` : 'any' }} <Icon name="close" :size="12" />
        </button>
        <button v-for="s in filters.sizes" :key="s" class="tag" @click="toggle(filters.sizes, s)">Size {{ s }} <Icon name="close" :size="12" /></button>
        <button v-for="c in filters.colors" :key="c" class="tag" @click="toggle(filters.colors, c)">{{ c }} <Icon name="close" :size="12" /></button>
        <button v-if="filters.sale" class="tag" @click="filters.sale = false">On sale <Icon name="close" :size="12" /></button>
        <button v-if="filters.isNew" class="tag" @click="filters.isNew = false">New in <Icon name="close" :size="12" /></button>
        <button v-if="activeCount" class="link clear" @click="clearFilters">Clear all</button>
      </div>

      <TransitionGroup v-if="results.length" tag="div" name="grid" class="product-grid results">
        <ProductCard
          v-for="(p, i) in results"
          :key="p.id"
          :product="p"
          :rank="sort === 'popular' && i < 10 ? i + 1 : undefined"
          compact
        />
      </TransitionGroup>

      <div v-else class="empty">
        <span class="empty-icon"><Icon name="search" :size="28" /></span>
        <h3>Nothing matches those filters</h3>
        <p>Try removing a filter or searching for something else.</p>
        <button class="btn-secondary sm" @click="clearFilters(); setQuery({ q: undefined, gender: undefined, type: undefined })">
          Reset everything
        </button>
      </div>
    </div>

    <!-- Filter drawer -->
    <Transition name="fade">
      <div v-if="panelOpen" class="scrim" @click="panelOpen = false" />
    </Transition>
    <Transition name="drawer">
      <aside v-if="panelOpen" class="panel" aria-label="Filters" @keydown.esc="panelOpen = false">
        <header>
          <h2>Filters</h2>
          <button class="icon-btn" aria-label="Close filters" @click="panelOpen = false"><Icon name="close" /></button>
        </header>

        <div class="panel-body">
          <section>
            <h3>Price</h3>
            <div class="range">
              <label><span>Min</span><input v-model="filters.min" type="number" min="0" placeholder="$0" /></label>
              <label><span>Max</span><input v-model="filters.max" type="number" min="0" placeholder="Any" /></label>
            </div>
            <div class="presets">
              <button v-for="[a, b] in [[0, 50], [50, 100], [100, 200], [200, '']]" :key="a" class="chip"
                :class="{ on: filters.min === a && filters.max === b }" @click="Object.assign(filters, { min: a, max: b })">
                {{ b === '' ? `$${a}+` : `$${a}–$${b}` }}
              </button>
            </div>
          </section>

          <section v-if="allSizes.length > 1">
            <h3>Size</h3>
            <div class="sizes">
              <button v-for="s in allSizes" :key="s" class="size" :class="{ on: filters.sizes.includes(s) }" @click="toggle(filters.sizes, s)">
                {{ s }}
              </button>
            </div>
          </section>

          <section>
            <h3>Colour</h3>
            <div class="colors">
              <button v-for="c in allColors" :key="c.name" class="swatch" :class="{ on: filters.colors.includes(c.name) }" @click="toggle(filters.colors, c.name)">
                <i :style="{ background: c.hex }" />{{ c.name }}
              </button>
            </div>
          </section>

          <section>
            <h3>Show only</h3>
            <label class="check"><input v-model="filters.sale" type="checkbox" />On sale</label>
            <label class="check"><input v-model="filters.isNew" type="checkbox" />New in</label>
          </section>
        </div>

        <footer>
          <button class="btn-secondary" @click="clearFilters">Clear</button>
          <button class="btn-primary" @click="panelOpen = false">Show {{ results.length }} results</button>
        </footer>
      </aside>
    </Transition>
  </div>
</template>

<style scoped>
.search {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 52px;
  padding: 0 20px;
  border-radius: var(--r-pill);
  background: var(--chip);
  color: var(--muted);
}
.search:focus-within {
  background: #fff;
  box-shadow: 0 0 0 2px var(--blue);
}
.search input {
  width: 180px;
  border: 0;
  background: none;
  font: inherit;
  font-size: 14px;
  color: var(--ink);
  outline: none;
}
.sort {
  width: auto;
  height: 52px;
  border-radius: var(--r-pill);
  font-size: 14px;
}
.filter-btn {
  height: 52px;
  padding: 0 26px;
}
.filter-btn:hover {
  background: var(--line);
}
.filter-btn b {
  display: grid;
  place-items: center;
  min-width: 22px;
  height: 22px;
  border-radius: 11px;
  background: var(--blue);
  color: #fff;
  font-size: 12px;
}

.hero {
  position: relative;
  display: flex;
  align-items: center;
  min-height: 240px;
  margin-bottom: 24px;
  border-radius: var(--r-card);
  overflow: hidden;
}
.hero-copy {
  position: relative;
  z-index: 1;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 10px;
  padding: 40px 48px;
  max-width: 60%;
}
.hero h2 {
  font-size: 40px;
  font-weight: 600;
  letter-spacing: -0.02em;
}
.hero p {
  font-size: 16px;
}
.hero img {
  position: absolute;
  top: 0;
  right: 0;
  width: 50%;
  height: 100%;
  object-fit: cover;
  mask-image: linear-gradient(90deg, transparent, #000 40%);
  -webkit-mask-image: linear-gradient(90deg, transparent, #000 40%);
}
.code {
  gap: 8px;
  margin-top: 8px;
  padding: 0 24px;
}
.code small {
  padding: 3px 10px;
  border-radius: var(--r-pill);
  background: var(--ink);
  color: #fff;
  font-size: 12px;
}

.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 16px;
  margin-bottom: 20px;
}
.tabs {
  display: flex;
  gap: 4px;
}
.tab {
  height: 50px;
  padding: 0 22px;
  color: var(--muted);
  font-size: 14px;
}
.tab:hover {
  color: var(--ink);
}
.tab.on {
  background: var(--blue);
  color: #fff;
}
.chips,
.presets,
.colors {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.chip {
  height: 40px;
  padding: 0 18px;
  border: 1.5px solid var(--line);
  border-radius: var(--r-pill);
  font-size: 14px;
  font-weight: 500;
  color: var(--muted);
  transition: all 0.2s ease;
}
.chip:hover {
  color: var(--ink);
  border-color: #dcdfe3;
}
.chip.on {
  border-color: var(--ink);
  background: var(--ink);
  color: #fff;
}

.active {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 20px;
}
.count {
  margin-right: 6px;
  font-size: 14px;
  font-weight: 500;
}
.tag {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  padding: 0 12px;
  border-radius: var(--r-pill);
  background: var(--blue-soft);
  color: var(--blue);
  font-size: 13px;
  font-weight: 500;
}
.clear {
  font-size: 13px;
}

.results {
  position: relative;
}
.grid-move,
.grid-enter-active,
.grid-leave-active {
  transition: all 0.3s ease;
}
.grid-enter-from,
.grid-leave-to {
  opacity: 0;
  transform: scale(0.96);
}
.grid-leave-active {
  position: absolute;
  visibility: hidden;
}

/* Filter drawer */
.scrim {
  position: fixed;
  inset: 0;
  z-index: 50;
  background: rgba(18, 20, 23, 0.3);
}
.panel {
  position: fixed;
  top: 16px;
  right: 16px;
  bottom: 16px;
  z-index: 51;
  display: flex;
  flex-direction: column;
  width: min(400px, calc(100vw - 32px));
  border-radius: var(--r-card);
  background: #fff;
  box-shadow: 0 30px 80px rgba(0, 0, 0, 0.2);
}
.panel header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 28px 28px 12px;
}
.panel header .icon-btn {
  background: var(--chip);
}
.panel h2 {
  font-size: 24px;
  font-weight: 500;
}
.panel-body {
  flex: 1;
  overflow-y: auto;
  padding: 0 28px;
}
.panel section {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 20px 0;
  border-bottom: 1px solid var(--line);
}
.panel h3 {
  font-size: 14px;
  font-weight: 600;
}
.range {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}
.range label {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 12px;
  color: var(--muted);
}
.range input {
  height: 48px;
  padding: 0 16px;
  border: 1.5px solid transparent;
  border-radius: 16px;
  background: var(--chip);
  font: inherit;
  font-size: 15px;
  outline: none;
}
.range input:focus {
  border-color: var(--blue);
  background: #fff;
}
.sizes {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(56px, 1fr));
  gap: 8px;
}
.size {
  height: 44px;
  border-radius: 14px;
  background: var(--chip);
  font-size: 14px;
  font-weight: 500;
}
.size.on {
  background: var(--ink);
  color: #fff;
}
.swatch {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 38px;
  padding: 0 14px 0 8px;
  border: 1.5px solid var(--line);
  border-radius: var(--r-pill);
  font-size: 13px;
}
.swatch i {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.1);
}
.swatch.on {
  border-color: var(--ink);
}
.panel footer {
  display: grid;
  grid-template-columns: 1fr 2fr;
  gap: 10px;
  padding: 20px 28px 28px;
}
.panel footer .btn-primary {
  height: 52px;
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.25s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
.drawer-enter-active,
.drawer-leave-active {
  transition: transform 0.35s cubic-bezier(0.2, 0.8, 0.2, 1);
}
.drawer-enter-from,
.drawer-leave-to {
  transform: translateX(110%);
}

@media (max-width: 860px) {
  .search {
    flex: 1;
  }
  .search input {
    width: 100%;
  }
  .hero-copy {
    max-width: 75%;
    padding: 28px;
  }
  .hero h2 {
    font-size: 28px;
  }
  .tabs {
    width: 100%;
  }
  .tab {
    flex: 1;
    justify-content: center;
    padding: 0 10px;
  }
}
</style>
