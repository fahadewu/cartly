<script setup>
import { ref, computed, watch, nextTick } from 'vue'
import { useRouter } from 'vue-router'
import Icon from '../Icon.vue'
import { money } from '../../data.js'
import { productById } from '../../catalog.js'
import { useAgent } from '../../agent/useAgent.js'
import { useShop } from '../../store.js'
import { isWearable } from '../../tryon/specs.js'

const props = defineProps({
  ids: { type: Array, required: true },
  large: Boolean,
  // Pip asked which size of this product, and the colour the shopper named: the card's picker starts on it.
  askSize: Number,
  askColor: String,
})

const router = useRouter()
const { state, adding, addFromCard, tryOnFromCard, likeFromCard, cartVariants } = useAgent()
const { isLiked } = useShop()
const strip = ref(null)
const items = computed(() => props.ids.map(productById).filter(Boolean))
const picking = ref(null) // the card showing its colour and size buttons
const colour = ref(null) // the colour picked there
// "In cart · M Black" on the cards already in the cart (the size and colour only where there's a choice).
const inCart = computed(() => {
  const labels = {}
  for (const p of items.value) {
    const lines = cartVariants(p.id)
    if (!lines.length) continue
    const parts = lines.map((l) => [p.sizes.length > 1 && l.size, p.colors.length > 1 && l.color].filter(Boolean).join(' '))
    labels[p.id] = parts.some(Boolean) ? `In cart · ${[...new Set(parts)].join(', ')}` : 'In cart'
  }
  return labels
})
// Added another way while its picker was open (the size buttons under Pip's question, Pip itself, the product
// page): the picker closes rather than stay over the photo with nothing to close it.
watch(inCart, (labels) => {
  if (picking.value != null && labels[picking.value]) picking.value = null
})

/** Keyboard focus to one of a card's controls once it has rendered: `add`, `in-cart` or `picker`. */
async function focus(p, which) {
  await nextTick()
  const el = strip.value?.querySelector(`[data-${which}="${p.id}"]`)
  ;(which === 'picker' ? el?.querySelector('button') : el)?.focus()
}

function view(p) {
  if (state.mode === 'stage') state.mode = 'chat'
  router.push(`/product/${p.id}`)
}
// Add and Try on work right here, without a message to Pip. With several sizes or colours, the card asks which:
// a silent first colour could add the black one as yellow.
function add(p) {
  if (picking.value === p.id) return close(p)
  if (p.sizes.length < 2 && p.colors.length < 2) return addThis(p, p.sizes[0], p.colors[0]?.name)
  picking.value = p.id
  colour.value = p.colors.find((c) => c.name === (p.id === props.askSize ? props.askColor : null))?.name ?? p.colors[0]?.name
  focus(p, 'picker')
}
function close(p) {
  picking.value = null
  focus(p, 'add')
}
async function addThis(p, size, color) {
  picking.value = null
  const ok = await addFromCard(p, size, color)
  focus(p, ok ? 'in-cart' : 'add') // the button that had focus is gone either way
}
</script>

<template>
  <div ref="strip" class="strip" :class="{ large }">
    <article v-for="(p, i) in items" :key="p.id" class="card" :style="{ animationDelay: `${i * 70}ms` }">
      <span class="num">{{ i + 1 }}</span>
      <button class="heart" :class="{ on: isLiked(p.id) }" :aria-label="`Save ${p.name}`" :aria-pressed="isLiked(p.id)" @click="likeFromCard(p)">
        <Icon name="heart" :size="14" :filled="isLiked(p.id)" />
      </button>
      <button class="photo" :aria-label="`View ${p.name}`" @click="view(p)">
        <img :src="p.image" :alt="p.name" loading="lazy" />
      </button>
      <button v-if="isWearable(p.id)" class="try" :title="`See ${p.name} on you`" @click="tryOnFromCard(p)">
        <Icon name="sparkle" :size="12" />Try on
      </button>
      <div class="info">
        <b :title="p.name">{{ p.name }}</b>
        <span>
          {{ money(p.price) }}
          <s v-if="p.compareAt">{{ money(p.compareAt) }}</s>
        </span>
      </div>
      <div class="acts" :class="{ done: p.inStock && inCart[p.id] && picking !== p.id }">
        <button class="view" @click="view(p)">View</button>
        <span v-if="!p.inStock" class="state">Sold out</span>
        <span v-else-if="inCart[p.id] && picking !== p.id" class="state done" :title="inCart[p.id]" tabindex="-1" :data-in-cart="p.id">
          {{ inCart[p.id] }}
        </span>
        <!-- Not while Pip is answering: its reply may add the same thing (Close still works). -->
        <button
          v-else
          class="add"
          :class="{ open: picking === p.id }"
          :disabled="adding.has(p.id) || (state.status === 'thinking' && picking !== p.id)"
          :aria-expanded="p.sizes.length > 1 || p.colors.length > 1 ? picking === p.id : undefined"
          :data-add="p.id"
          @click="add(p)"
          @keydown.esc="(e) => picking === p.id && (e.stopPropagation(), close(p))"
        >
          <Icon :name="picking === p.id ? 'close' : 'plus'" :size="14" />{{ picking === p.id ? 'Close' : 'Add' }}
        </button>
      </div>
      <!-- After Add in the page order, so Tab goes from Add into the choices; it sits over the photo. Esc closes it
           (and only it: .stop keeps the chat or the voice screen open). -->
      <div
        v-if="picking === p.id"
        class="sizes"
        role="group"
        :aria-label="`Pick ${p.sizes.length > 1 ? 'a size' : 'a colour'} for ${p.name}`"
        :data-picker="p.id"
        @keydown.esc.stop="close(p)"
      >
        <template v-if="p.sizes.length > 1">
          <div v-if="p.colors.length > 1" class="colours">
            <button
              v-for="c in p.colors"
              :key="c.name"
              class="dot"
              :class="{ on: colour === c.name }"
              :style="{ background: c.hex }"
              :aria-label="c.name"
              :aria-pressed="colour === c.name"
              :title="c.name"
              @click="colour = c.name"
            />
            <b>{{ colour }}</b>
          </div>
          <span>Pick a size</span>
          <div>
            <button v-for="s in p.sizes" :key="s" :disabled="adding.has(p.id) || state.status === 'thinking'" @click="addThis(p, s, colour)">
              {{ s }}
            </button>
          </div>
        </template>
        <template v-else>
          <span>Pick a colour</span>
          <div>
            <button
              v-for="c in p.colors"
              :key="c.name"
              class="colour"
              :disabled="adding.has(p.id) || state.status === 'thinking'"
              @click="addThis(p, p.sizes[0], c.name)"
            >
              <i :style="{ background: c.hex }" />{{ c.name }}
            </button>
          </div>
        </template>
      </div>
    </article>
  </div>
</template>

<style scoped>
.strip {
  display: flex;
  gap: 10px;
  overflow-x: auto;
  padding: 4px 2px 8px;
  scroll-snap-type: x mandatory;
  scrollbar-width: thin;
}
.card {
  position: relative;
  flex: 0 0 148px;
  display: flex;
  flex-direction: column;
  padding: 8px;
  border-radius: 22px;
  background: #fff;
  box-shadow: 0 6px 18px -10px rgba(20, 33, 77, 0.3);
  scroll-snap-align: start;
  animation: rise 0.4s cubic-bezier(0.2, 0.8, 0.2, 1) both;
}
@keyframes rise {
  from {
    opacity: 0;
    transform: translateY(10px) scale(0.96);
  }
}
.num {
  position: absolute;
  top: 12px;
  left: 12px;
  z-index: 1;
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background: var(--ink);
  color: #fff;
  font-size: 12px;
  font-weight: 600;
}
.heart {
  position: absolute;
  top: 12px;
  right: 12px;
  z-index: 1;
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border-radius: 10px;
  background: #fff;
  color: var(--muted);
}
.heart.on {
  color: #ff3b6b;
}
.try {
  position: absolute;
  top: 98px;
  left: 14px;
  z-index: 1;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 24px;
  padding: 0 9px;
  border-radius: var(--r-pill);
  background: rgba(255, 255, 255, 0.92);
  color: var(--blue);
  font-size: 11px;
  font-weight: 600;
  box-shadow: 0 2px 8px rgba(20, 33, 77, 0.15);
}
.try:hover {
  background: var(--blue);
  color: #fff;
}
.large .try {
  top: 146px;
  height: 28px;
  font-size: 12px;
}
.photo {
  height: 118px;
  border-radius: 16px;
  background: var(--card);
  overflow: hidden;
}
.photo img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  mix-blend-mode: multiply;
  transition: transform 0.3s ease;
}
.photo:hover img {
  transform: scale(1.06);
}
.info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 4px 6px;
  min-width: 0;
}
.info b {
  overflow: hidden;
  font-size: 13px;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.info span {
  font-size: 13px;
  font-weight: 600;
}
.info s {
  margin-left: 4px;
  font-weight: 400;
  color: var(--muted);
}
.acts {
  display: grid;
  grid-template-columns: 1fr 1.2fr;
  gap: 6px;
}
.acts button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  height: 32px;
  border-radius: var(--r-pill);
  font-size: 12px;
  font-weight: 500;
}
.view {
  background: var(--chip);
}
.add {
  background: var(--blue);
  color: #fff;
}
.add:disabled {
  opacity: 0.6;
}
.add.open {
  background: var(--chip);
  color: var(--ink);
}
/* Sold out, or already in the cart: a label where Add was. */
.state {
  overflow: hidden;
  padding: 0 4px;
  border-radius: var(--r-pill);
  background: var(--chip);
  color: var(--muted);
  font-size: 12px;
  font-weight: 500;
  line-height: 32px;
  text-align: center;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.state.done {
  background: var(--mint);
  color: #12573a;
}
.acts.done {
  grid-template-columns: 1fr 1.5fr;
}

/* Colour and size buttons over the photo, after Add on a product with several of either. */
.sizes {
  position: absolute;
  top: 8px;
  left: 8px;
  right: 8px;
  z-index: 2;
  display: flex;
  flex-direction: column;
  gap: 6px;
  height: 118px;
  padding: 8px;
  border-radius: 16px;
  background: rgba(255, 255, 255, 0.94);
  backdrop-filter: blur(6px);
  overflow-y: auto;
  animation: sizes 0.2s ease both;
}
@keyframes sizes {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
}
.sizes > span {
  font-size: 11.5px;
  font-weight: 600;
  color: var(--muted);
}
.sizes div {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.sizes button {
  min-width: 30px;
  height: 24px;
  padding: 0 7px;
  border: 1.5px solid #d9e3ff;
  border-radius: var(--r-pill);
  background: #fff;
  color: var(--blue);
  font-size: 12px;
  font-weight: 500;
  transition: all 0.15s ease;
}
.sizes button:hover {
  border-color: var(--blue);
  background: var(--blue-soft);
}
.sizes button:disabled {
  opacity: 0.5;
}
/* Above the sizes: the colours as dots and the name of the one the sizes add. */
.sizes .colours {
  align-items: center;
}
.sizes .dot {
  min-width: 0;
  width: 20px;
  height: 20px;
  padding: 0;
  border: 2px solid #fff;
  border-radius: 50%;
  box-shadow: 0 0 0 1px rgba(20, 33, 77, 0.25);
}
.sizes .dot.on {
  box-shadow: 0 0 0 2px var(--blue);
}
.sizes .colours b {
  margin-left: 2px;
  font-size: 11.5px;
  font-weight: 600;
}
/* Without sizes to pick, the colours are the buttons that add it: a dot and the name. */
.sizes .colour {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.sizes .colour i {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  box-shadow: inset 0 0 0 1px rgba(20, 33, 77, 0.2);
}

.large .card {
  flex-basis: 196px;
  padding: 10px;
  border-radius: 26px;
}
.large .photo {
  height: 170px;
  border-radius: 20px;
}
.large .info b {
  font-size: 14px;
}
.large .acts button {
  height: 38px;
  font-size: 13px;
}
.large .state {
  font-size: 13px;
  line-height: 38px;
}
.large .sizes {
  top: 10px;
  left: 10px;
  right: 10px;
  height: 170px;
  padding: 10px;
  border-radius: 20px;
}
.large .sizes button {
  min-width: 34px;
  height: 30px;
  font-size: 13px;
}
</style>
