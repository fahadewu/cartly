<script setup>
import { computed, reactive, ref, watch } from 'vue'
import Icon from '../components/Icon.vue'
import ShareLook from '../components/ShareLook.vue'
import { products, productById } from '../catalog.js'
import { bdtRate, price } from '../data.js'
import { festival, next, loadFestivals, fmtDay, shortName, daysWord } from '../festival.js'
import { style } from '../style.js'
import { useShop } from '../store.js'
import { useAgent } from '../agent/useAgent.js'
import { toast } from '../toast.js'

// The family outfit planner: one board for everyone's festival outfits (Eid shopping is usually for the whole
// family), each person with an optional budget, and the real "order by" date for delivery before the day.
loadFestivals()
const { addToCart } = useShop()
const agent = useAgent()

const KEY = 'cartly.planner.v1'
const saved = (() => {
  try {
    return JSON.parse(localStorage.getItem(KEY))
  } catch {
    return null
  }
})()
let uid = Math.max(0, ...(saved?.people ?? []).map((p) => p.id))
const person = (name, shopsFor = 'women') => ({ id: ++uid, name, for: shopsFor, budget: null, items: [] })
const board = reactive(saved?.people?.length ? saved : { people: [person('Me', style.gender === 'men' ? 'men' : 'women')] })
watch(
  board,
  () => {
    try {
      localStorage.setItem(KEY, JSON.stringify(board))
    } catch {}
  },
  { deep: true },
)

const local = (usd) => usd * (bdtRate.value || 1)
const currency = computed(() => (bdtRate.value ? '৳' : '$'))
const lines = (p) => p.items.map((i) => ({ ...i, p: productById(i.productId) })).filter((i) => i.p)
const spent = (p) => lines(p).reduce((n, i) => n + i.p.price, 0)
const total = computed(() => board.people.reduce((n, p) => n + spent(p), 0))
const allItems = computed(() => board.people.flatMap((p) => lines(p)))

const FESTIVE = ['festive', 'wedding', 'party', 'eid', 'puja', 'formal', 'date-night']
const picking = ref(null)
const search = ref('')
function ideas(p) {
  const q = search.value.trim().toLowerCase()
  const chosen = new Set(p.items.map((i) => i.productId))
  return products
    .filter((x) => x.inStock && !chosen.has(x.id) && ['Clothing', 'Shoes', 'Accessories'].includes(x.type))
    .filter((x) => x.gender === p.for || x.gender === 'unisex')
    .filter((x) => !q || x.name.toLowerCase().includes(q) || x.styleTags?.some((t) => t.includes(q)))
    .sort((a, b) => festiveScore(b) - festiveScore(a) || b.popularity - a.popularity)
    .slice(0, 12)
}
const festiveScore = (x) => (x.occasions ?? []).filter((o) => FESTIVE.includes(o)).length

function add(p, product) {
  p.items.push({ productId: product.id, color: product.colors[0]?.name ?? null, size: product.sizes.length === 1 ? product.sizes[0] : '' })
}
const remove = (p, i) => p.items.splice(i, 1)
const QUICK = [
  ['Ammu', 'women'],
  ['Abbu', 'men'],
  ['Apu', 'women'],
  ['Bhaiya', 'men'],
]
function addPerson(name = '', shopsFor = 'women') {
  board.people.push(person(name || `Person ${board.people.length + 1}`, shopsFor))
}
function dropPerson(p) {
  board.people = board.people.filter((x) => x.id !== p.id)
}

function askPip(p) {
  const what = next.value ? `${shortName(next.value.name)} outfit` : 'festive outfit'
  const budget = p.budget ? `, budget about ${currency.value}${p.budget}` : ''
  agent.open('chat')
  agent.send(`Help me pick a ${what} for ${p.name} (${p.for === 'men' ? "men's" : "women's"}${budget}).`)
}

const missingSize = ref(false)
async function addAll() {
  const needs = allItems.value.filter((i) => i.p.sizes.length > 1 && !i.size)
  missingSize.value = needs.length > 0
  if (needs.length) return toast(`Pick a size for ${needs.length} piece${needs.length > 1 ? 's' : ''} first`, 'error')
  let n = 0
  for (const i of allItems.value) if (await addToCart(i.p, { color: i.color ?? undefined, size: i.size || undefined }, { silent: true })) n++
  if (n) toast(`${n} piece${n > 1 ? 's' : ''} added to your cart`)
}
const asking = ref(false)
const shareItems = computed(() => allItems.value.slice(0, 6).map((i) => ({ productId: i.productId, color: i.color ?? undefined, size: i.size || undefined })))
</script>

<template>
  <div class="planner">
    <header class="hero">
      <span class="kicker"><span aria-hidden="true">✦</span>Family outfit planner</span>
      <h1>{{ next ? `${shortName(next.name)} outfits for everyone` : 'Festive outfits for everyone' }}</h1>
      <p v-if="next">
        {{ shortName(next.name) }} is {{ daysWord(next.daysAway) }} ({{ fmtDay(next.start) }}).
        <template v-if="next.orderBy.standard"><b>Order by {{ fmtDay(next.orderBy.standard) }}</b> for standard delivery<template v-if="next.orderBy.express">, or by {{ fmtDay(next.orderBy.express) }} with express</template>, to have it the day before.</template>
        <template v-else><b>Order by {{ fmtDay(next.orderBy.express) }}</b> with express to have it the day before.</template>
        <small>From our posted delivery times.</small>
      </p>
      <p v-else-if="festival.loaded">Plan outfits for the whole family on one board, with a budget for each person.</p>
    </header>

    <div class="people">
      <article v-for="p in board.people" :key="p.id" class="person">
        <header>
          <input v-model="p.name" class="name" maxlength="24" aria-label="Name" dir="auto" />
          <div class="seg" role="group" aria-label="Shops for">
            <button :class="{ on: p.for === 'women' }" @click="p.for = 'women'">Women’s</button>
            <button :class="{ on: p.for === 'men' }" @click="p.for = 'men'">Men’s</button>
          </div>
          <button v-if="board.people.length > 1" class="icon-btn sm" :aria-label="`Remove ${p.name}`" @click="dropPerson(p)"><Icon name="close" :size="15" /></button>
        </header>

        <label class="budget">
          <span>Budget</span>
          <span class="cur">{{ currency }}</span>
          <input v-model.number="p.budget" inputmode="numeric" placeholder="optional" />
        </label>
        <div v-if="p.budget" class="bar" :class="{ over: local(spent(p)) > p.budget }">
          <i :style="{ width: `${Math.min(100, (local(spent(p)) / p.budget) * 100)}%` }" />
        </div>
        <small v-if="p.budget" class="muted spent">{{ price(spent(p)) }} of {{ currency }}{{ p.budget.toLocaleString('en-IN') }}<template v-if="local(spent(p)) > p.budget"> · over budget</template></small>

        <ul class="items">
          <li v-for="(i, n) in lines(p)" :key="`${i.productId}-${n}`">
            <img :src="i.p.image" :alt="i.p.name" />
            <div>
              <RouterLink :to="`/product/${i.productId}`">{{ i.p.name }}</RouterLink>
              <span>{{ price(i.p.price) }}</span>
            </div>
            <select v-if="i.p.sizes.length > 1" v-model="p.items[n].size" class="size" :class="{ need: missingSize && !i.size }" :aria-label="`Size for ${i.p.name}`">
              <option value="">Size</option>
              <option v-for="s in i.p.sizes" :key="s">{{ s }}</option>
            </select>
            <button class="icon-btn sm" :aria-label="`Remove ${i.p.name}`" @click="remove(p, n)"><Icon name="close" :size="14" /></button>
          </li>
        </ul>

        <div v-if="picking === p.id" class="picker">
          <input v-model="search" placeholder="Search, e.g. dress, kurta, shoes" />
          <div class="ideas">
            <button v-for="x in ideas(p)" :key="x.id" class="idea" @click="add(p, x)">
              <img :src="x.image" :alt="x.name" />
              <b>{{ x.name }}</b>
              <span>{{ price(x.price) }}</span>
            </button>
            <p v-if="!ideas(p).length" class="muted">Nothing matches. Try another word, or ask Pip.</p>
          </div>
        </div>
        <div class="person-acts">
          <button class="btn-secondary sm" @click="picking = picking === p.id ? null : p.id; search = ''"><Icon :name="picking === p.id ? 'minus' : 'plus'" :size="15" />{{ picking === p.id ? 'Done' : 'Add a piece' }}</button>
          <button class="btn-secondary sm" @click="askPip(p)"><Icon name="sparkle" :size="15" />Ideas from Pip</button>
        </div>
      </article>

      <div class="add-person">
        <b>Add someone</b>
        <div class="quick">
          <button v-for="[n, f] in QUICK" :key="n" @click="addPerson(n, f)">+ {{ n }}</button>
          <button @click="addPerson()">+ Someone else</button>
        </div>
      </div>
    </div>

    <footer class="tally">
      <div>
        <span class="muted">{{ allItems.length }} piece{{ allItems.length === 1 ? '' : 's' }} for {{ board.people.length }} {{ board.people.length === 1 ? 'person' : 'people' }}</span>
        <b>{{ price(total) }}</b>
      </div>
      <button class="btn-secondary" :disabled="!allItems.length" @click="asking = true"><Icon name="users" :size="16" />Ask family to vote</button>
      <button class="btn-primary" :disabled="!allItems.length" @click="addAll"><Icon name="bag" :size="17" />Add everything to cart</button>
    </footer>

    <ShareLook v-if="asking" :items="shareItems" @close="asking = false" />
  </div>
</template>

<style scoped>
.planner {
  padding: 26px 34px 0 22px;
}
.hero {
  padding: 28px;
  border-radius: var(--r-card);
  background: linear-gradient(110deg, #10213f, #1f3b7a);
  color: #dfe6f8;
}
.kicker {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 14px;
  border-radius: var(--r-pill);
  background: #f5c64f;
  color: #10213f;
  font-size: 13px;
  font-weight: 600;
}
.hero h1 {
  margin: 14px 0 8px;
  color: #fff;
  font-size: 38px;
  font-weight: 600;
  letter-spacing: -0.02em;
}
.hero p {
  max-width: 720px;
  font-size: 16px;
  line-height: 1.55;
}
.hero b {
  color: #fff;
}
.hero small {
  display: block;
  margin-top: 4px;
  color: #a9b6da;
}
.people {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 16px;
  margin-top: 20px;
}
.person,
.add-person {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 18px;
  border-radius: 28px;
  background: var(--card);
}
.person header {
  display: flex;
  align-items: center;
  gap: 8px;
}
.name {
  flex: 1;
  min-width: 0;
  height: 40px;
  padding: 0 12px;
  border: 1.5px solid transparent;
  border-radius: 12px;
  background: #fff;
  font: inherit;
  font-size: 17px;
  font-weight: 600;
  outline: none;
}
.name:focus {
  border-color: var(--blue);
}
.seg {
  display: inline-flex;
  padding: 3px;
  border-radius: 12px;
  background: #fff;
}
.seg button {
  height: 32px;
  padding: 0 10px;
  border-radius: 9px;
  font-size: 13px;
}
.seg button.on {
  background: var(--ink);
  color: #fff;
}
.icon-btn.sm {
  width: 32px;
  height: 32px;
}
.budget {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--muted);
}
.budget input {
  width: 120px;
  height: 36px;
  padding: 0 10px;
  border: 1.5px solid transparent;
  border-radius: 10px;
  background: #fff;
  font: inherit;
  font-size: 14px;
  color: var(--ink);
  outline: none;
}
.cur {
  margin-right: -4px;
  color: var(--ink);
}
.bar {
  height: 8px;
  border-radius: 4px;
  background: #fff;
  overflow: hidden;
}
.bar i {
  display: block;
  height: 100%;
  background: #1a7f4b;
}
.bar.over i {
  background: #d97706;
}
.spent {
  margin-top: -6px;
  font-size: 12px;
}
.items {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.items li {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px;
  border-radius: 16px;
  background: #fff;
}
.items img {
  width: 48px;
  height: 48px;
  border-radius: 12px;
  object-fit: cover;
}
.items div {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  font-size: 14px;
}
.items a {
  color: var(--ink);
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.size {
  height: 34px;
  padding: 0 8px;
  border: 1.5px solid var(--line);
  border-radius: 10px;
  background: #fff;
  font: inherit;
  font-size: 13px;
}
.size.need {
  border-color: #d97706;
}
.picker input {
  width: 100%;
  height: 40px;
  padding: 0 14px;
  border: 1.5px solid transparent;
  border-radius: 12px;
  background: #fff;
  font: inherit;
  font-size: 14px;
  outline: none;
}
.ideas {
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: 112px;
  gap: 8px;
  margin-top: 8px;
  overflow-x: auto;
  padding-bottom: 6px;
}
.idea {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 6px;
  border-radius: 14px;
  background: #fff;
  text-align: left;
  font-size: 12px;
}
.idea img {
  width: 100%;
  aspect-ratio: 1;
  border-radius: 10px;
  object-fit: cover;
}
.idea b {
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.person-acts {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.person-acts .btn-secondary {
  background: #fff;
}
.add-person {
  justify-content: center;
  border: 2px dashed #d6dade;
  background: transparent;
}
.quick {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.quick button {
  padding: 10px 14px;
  border-radius: var(--r-pill);
  background: var(--chip);
  font-size: 14px;
}
.tally {
  position: sticky;
  bottom: 12px;
  z-index: 5;
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 22px;
  padding: 14px 16px 14px 24px;
  border-radius: 28px;
  background: var(--ink);
  color: #fff;
  box-shadow: 0 18px 40px -20px rgba(0, 0, 0, 0.5);
}
.tally div {
  flex: 1;
  display: flex;
  flex-direction: column;
}
.tally b {
  font-size: 22px;
}
.tally .btn-primary {
  padding: 0 24px;
}
.tally .btn-secondary {
  background: rgba(255, 255, 255, 0.12);
  color: #fff;
}
@media (max-width: 760px) {
  .planner {
    padding: 18px 16px 0;
  }
  .hero h1 {
    font-size: 28px;
  }
  .tally {
    flex-wrap: wrap;
  }
}
</style>
