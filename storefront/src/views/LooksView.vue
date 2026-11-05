<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import PageHeader from '../components/PageHeader.vue'
import Icon from '../components/Icon.vue'
import { productById } from '../catalog.js'
import { price } from '../data.js'
import { looks, refreshLooks, markSeen, stopSharing, lookUrl, REACTIONS, TAGS } from '../looks.js'
import { useShop } from '../store.js'
import { toast } from '../toast.js'

// Family votes: the looks this shopper shared with "Ask family", and what everyone said.
const { addToCart } = useShop()
const loading = ref(!looks.loaded)

const list = computed(() =>
  looks.list.map((l) => ({
    ...l,
    products: l.items.map((i) => ({ ...i, p: productById(i.productId) })).filter((i) => i.p),
    top: REACTIONS.reduce((best, r) => ((l.reactions?.[r.id] ?? 0) > (l.reactions?.[best.id] ?? 0) ? r : best), REACTIONS[0]),
  })),
)
const emoji = (id) => REACTIONS.find((r) => r.id === id)?.emoji ?? ''
const tagLabel = (id) => TAGS.find((t) => t.id === id)?.en ?? id
const pct = (l, id) => (l.total ? Math.round(((l.reactions?.[id] ?? 0) / l.total) * 100) : 0)
const left = (l) => Math.max(1, Math.ceil((Date.parse(l.expiresAt) - Date.now()) / 864e5))
const imageSrc = (token) => `${import.meta.env.VITE_API_URL ?? '/api/v1'}/looks/${token}/image`

async function load() {
  await refreshLooks().catch(() => {})
  loading.value = false
  markSeen()
}
function copy(token) {
  navigator.clipboard?.writeText(lookUrl(token)).then(() => toast('Link copied'))
}
const whatsapp = (l) => `https://wa.me/?text=${encodeURIComponent(`${l.note || 'What do you think of this look?'} কেমন লাগছে? 👉 ${lookUrl(l.token)}`)}`
async function addLook(l) {
  let added = 0
  for (const i of l.products) if (await addToCart(i.p, { color: i.color ?? undefined, size: i.size ?? undefined }, { silent: true })) added++
  if (added) toast(`${added} item${added > 1 ? 's' : ''} added to your cart`)
}
async function unshare(l) {
  try {
    await stopSharing(l.token)
    toast('Stopped sharing. The link and its photo are deleted.')
  } catch (e) {
    toast(e.message, 'error')
  }
}

let timer
onMounted(() => {
  load()
  timer = setInterval(() => !document.hidden && load(), 20_000)
})
onBeforeUnmount(() => clearInterval(timer))
</script>

<template>
  <div>
    <PageHeader title="Family votes" subtitle="Looks you asked family and friends about, and what they said." :crumbs="[{ label: 'Explore', to: '/' }, { label: 'Family votes' }]" />
    <div class="page">
      <div v-if="loading" class="empty"><span class="spinner" /></div>
      <div v-else-if="!list.length" class="empty box">
        <Icon name="users" :size="28" />
        <h2>No shared looks yet</h2>
        <p class="muted">Try something on, or open a product, and tap <b>Ask family</b>. They vote with one tap, no app or account needed.</p>
        <RouterLink to="/" class="btn-primary sm">Find something</RouterLink>
      </div>

      <article v-for="l in list" :key="l.token" class="look box">
        <div class="pics">
          <img v-if="l.image" :src="imageSrc(l.token)" alt="Your look" class="photo" />
          <img v-for="i in l.products.slice(0, l.image ? 2 : 4)" :key="i.productId" :src="i.p.image" :alt="i.p.name" />
        </div>
        <div class="body">
          <header>
            <div>
              <h2 dir="auto">{{ l.note || l.products.map((i) => i.p.name).join(' + ') }}</h2>
              <small class="muted">{{ l.total ? `${l.total} vote${l.total === 1 ? '' : 's'}` : 'No votes yet' }} · link works for {{ left(l) }} more day{{ left(l) === 1 ? '' : 's' }}</small>
            </div>
            <span v-if="l.total" class="verdict">{{ l.top.emoji }} {{ l.top.en }}</span>
          </header>

          <ul class="bars">
            <li v-for="r in REACTIONS" :key="r.id">
              <span>{{ r.emoji }} {{ r.en }}</span><i><em :style="{ width: `${pct(l, r.id)}%` }" /></i><b>{{ l.reactions?.[r.id] ?? 0 }}</b>
            </li>
          </ul>

          <ul v-if="l.votes.length" class="votes">
            <li v-for="(v, i) in [...l.votes].reverse()" :key="i">
              <span class="e">{{ emoji(v.reaction) }}</span>
              <div>
                <b dir="auto">{{ v.name || 'Someone' }}</b>
                <small v-if="v.tags.length">{{ v.tags.map(tagLabel).join(' · ') }}</small>
                <p v-if="v.comment" dir="auto">“{{ v.comment }}”</p>
              </div>
            </li>
          </ul>

          <ul class="items">
            <li v-for="i in l.products" :key="i.productId">
              <RouterLink :to="`/product/${i.productId}`">{{ i.p.name }}</RouterLink>
              <small>{{ [i.color, i.size].filter(Boolean).join(' · ') }}</small>
              <span>{{ price(i.p.price) }}</span>
            </li>
          </ul>

          <div class="acts">
            <button class="btn-primary sm" @click="addLook(l)"><Icon name="bag" :size="15" />Add to cart</button>
            <a class="btn-secondary sm" :href="whatsapp(l)" target="_blank" rel="noopener">Ask more on WhatsApp</a>
            <button class="btn-secondary sm" @click="copy(l.token)"><Icon name="copy" :size="15" />Copy link</button>
            <button class="link danger" @click="unshare(l)">Stop sharing</button>
          </div>
        </div>
      </article>
    </div>
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 40px 24px;
  text-align: center;
}
.empty h2 {
  font-size: 20px;
}
.empty p {
  max-width: 420px;
}
.look {
  display: grid;
  grid-template-columns: 260px 1fr;
  gap: 24px;
}
.pics {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  align-content: start;
}
.pics img {
  width: 100%;
  aspect-ratio: 1;
  border-radius: 18px;
  object-fit: cover;
  background: var(--card);
}
.pics img:only-child {
  grid-column: 1 / -1;
}
.pics .photo {
  grid-column: 1 / -1;
  aspect-ratio: 3 / 4;
  object-fit: contain;
}
.body {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-width: 0;
}
header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
header h2 {
  font-size: 20px;
  font-weight: 600;
}
.verdict {
  flex: none;
  padding: 8px 14px;
  border-radius: var(--r-pill);
  background: var(--mint);
  font-size: 14px;
  font-weight: 500;
}
.bars {
  margin: 0;
  padding: 0;
  list-style: none;
}
.bars li {
  display: grid;
  grid-template-columns: 120px 1fr 28px;
  align-items: center;
  gap: 10px;
  padding: 4px 0;
  font-size: 14px;
}
.bars i {
  height: 10px;
  border-radius: 5px;
  background: var(--line);
  overflow: hidden;
}
.bars em {
  display: block;
  height: 100%;
  background: var(--blue);
}
.bars b {
  text-align: right;
}
.votes {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.votes li {
  display: flex;
  gap: 10px;
}
.e {
  font-size: 22px;
  line-height: 1.2;
}
.votes div {
  display: flex;
  flex-direction: column;
}
.votes b {
  font-size: 14px;
  font-weight: 500;
}
.votes small {
  font-size: 12px;
  color: var(--muted);
}
.votes p {
  font-size: 14px;
  color: #4b5058;
}
.items {
  margin: 0;
  padding: 12px 0 0;
  border-top: 1px solid var(--line);
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 14px;
}
.items li {
  display: flex;
  gap: 8px;
  align-items: baseline;
}
.items a {
  color: var(--ink);
  font-weight: 500;
}
.items small {
  flex: 1;
  color: var(--muted);
}
.acts {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.acts .btn-primary,
.acts .btn-secondary {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  text-decoration: none;
}
.link.danger {
  margin-left: auto;
  color: #b42318;
  font-size: 14px;
}
@media (max-width: 760px) {
  .look {
    grid-template-columns: 1fr;
  }
  .bars li {
    grid-template-columns: 100px 1fr 24px;
  }
}
</style>
