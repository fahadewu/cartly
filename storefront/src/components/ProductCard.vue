<script setup>
import { ref } from 'vue'
import Icon from './Icon.vue'
import { useShop } from '../store.js'
import { price } from '../data.js'

const props = defineProps({
  product: { type: Object, required: true },
  compact: Boolean,
  rank: Number,
})

const { isLiked, addToCart, toggleLike } = useShop()
const color = ref(props.product.colors[0]?.name)
const added = ref(false)
const picking = ref(false)

// Clothing comes in sizes: the card asks which one, rather than guessing a size that comes back as a return.
function add() {
  if (props.product.sizes.length > 1) {
    picking.value = !picking.value
    return
  }
  return pick(props.product.sizes[0])
}
async function pick(size) {
  picking.value = false
  if (!(await addToCart(props.product, { color: color.value, size }))) return
  added.value = true
  setTimeout(() => (added.value = false), 900)
}
</script>

<template>
  <article class="product" :class="{ compact }">
    <div class="top">
      <div class="dots">
        <button
          v-for="c in product.colors"
          :key="c.name"
          class="dot"
          :class="{ on: color === c.name }"
          :style="{ background: c.hex }"
          :aria-label="`Colour ${c.name}`"
          :title="c.name"
          @click="color = c.name"
        />
      </div>
      <button
        class="icon-btn like"
        :class="{ liked: isLiked(product.id) }"
        :aria-pressed="isLiked(product.id)"
        aria-label="Add to favourites"
        @click="toggleLike(product.id)"
      >
        <Icon name="heart" :size="17" :filled="isLiked(product.id)" />
      </button>
    </div>

    <span v-if="rank" class="badge rank">#{{ rank }}</span>
    <span v-else-if="product.compareAt" class="badge sale">−{{ Math.round((1 - product.price / product.compareAt) * 100) }}%</span>
    <span v-else-if="product.isNew" class="badge new">New</span>

    <RouterLink :to="`/product/${product.id}`" class="photo-link" :aria-label="product.name">
      <img class="photo" :src="product.image" :alt="product.name" loading="lazy" />
    </RouterLink>

    <footer>
      <RouterLink :to="`/product/${product.id}`" class="info">
        <small>{{ product.label }}</small>
        <h3>{{ product.name }}</h3>
      </RouterLink>
      <div v-if="picking" class="sizes" role="group" :aria-label="`Choose a size for ${product.name}`">
        <button v-for="s in product.sizes" :key="s" type="button" class="size" @click="pick(s)">{{ s }}</button>
        <button type="button" class="size cancel" aria-label="Cancel" @click="picking = false">×</button>
      </div>
      <div v-else class="buy">
        <s v-if="product.compareAt">{{ price(product.compareAt) }}</s>
        <button v-if="!product.inStock" class="price sold-out" disabled :aria-label="`${product.name} is sold out`">Sold out</button>
        <button v-else class="price" :class="{ added }" :aria-label="`Add ${product.name} to cart`" :aria-expanded="product.sizes.length > 1 ? picking : undefined" @click="add">
          <Icon v-if="added" name="check" :size="16" />
          <template v-else>{{ price(product.price) }}</template>
        </button>
      </div>
    </footer>
  </article>
</template>

<style scoped>
.sizes {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
}
.size {
  min-width: 40px;
  min-height: 40px;
  padding: 0 10px;
  border-radius: var(--r-pill);
  background: var(--chip);
  font-size: 13px;
  font-weight: 600;
}
.size:hover {
  background: var(--blue-soft);
  color: var(--blue);
}
.size.cancel {
  color: var(--muted);
  font-size: 18px;
}
.price.sold-out {
  background: var(--chip);
  color: var(--muted);
  cursor: default;
}
.product {
  position: relative;
  display: flex;
  flex-direction: column;
  min-height: 440px;
  padding: 24px;
  border-radius: var(--r-card);
  background: var(--card);
  overflow: hidden;
  transition: transform 0.25s ease, box-shadow 0.25s ease;
}
.product:hover {
  transform: translateY(-4px);
  box-shadow: 0 24px 40px -24px rgba(0, 0, 0, 0.25);
}

.top {
  position: relative;
  z-index: 2;
  display: flex;
  justify-content: space-between;
}
.dots {
  display: flex;
  gap: 4px;
}
.dot {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  border: 2px solid #fff;
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.06);
  transition: transform 0.15s ease;
}
.dot.on {
  transform: scale(1.15);
  box-shadow: 0 0 0 1.5px var(--ink);
}
.like.liked {
  color: #ff3b6b;
}

.badge {
  position: absolute;
  top: 70px;
  left: 24px;
  z-index: 2;
  padding: 5px 10px;
  border-radius: var(--r-pill);
  font-size: 12px;
  font-weight: 600;
}
.badge.sale {
  background: #ff3b6b;
  color: #fff;
}
.badge.new {
  background: #fff;
  color: var(--blue);
}
.badge.rank {
  background: var(--ink);
  color: #fff;
}

.photo-link {
  flex: 1;
  display: flex;
  min-height: 0;
  margin: -20px -24px 16px;
  overflow: hidden;
}
/* Multiply blends white studio backgrounds into the grey card. */
.photo {
  width: 100%;
  max-width: none;
  object-fit: cover;
  mix-blend-mode: multiply;
  transition: transform 0.4s ease;
}
.product:hover .photo {
  transform: scale(1.05) rotate(-2deg);
}

footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.info {
  min-width: 0;
  color: inherit;
  text-decoration: none;
}
.info:hover h3 {
  color: var(--blue);
}
small {
  font-size: 12px;
  color: var(--muted);
}
h3 {
  margin-top: 2px;
  font-size: 17px;
  font-weight: 500;
  line-height: 1.25;
  max-width: 13ch;
  transition: color 0.2s ease;
}
.buy {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 2px;
}
s {
  font-size: 12px;
  color: var(--muted);
}
.price {
  display: grid;
  place-items: center;
  flex-shrink: 0;
  min-width: 72px;
  height: 48px;
  padding: 0 18px;
  border-radius: var(--r-pill);
  background: var(--blue);
  color: #fff;
  font-size: 15px;
  font-weight: 500;
  transition: transform 0.15s ease, background 0.2s ease;
}
.price:hover {
  transform: scale(1.05);
}
.price.added {
  background: #17b26a;
}

.compact {
  min-height: 360px;
}
.compact h3 {
  font-size: 15px;
}
.compact .price {
  min-width: 64px;
  height: 44px;
  padding: 0 14px;
  font-size: 14px;
}
</style>
