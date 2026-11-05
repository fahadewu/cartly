<script setup>
import { computed } from 'vue'
import { productById } from '../../catalog.js'
import { price } from '../../data.js'

// "Help me decide": the two or three pieces side by side, with what each one wins at, so the choice is
// narrowed instead of widened (choice overload bites when the shopper is unsure: Chernev et al. 2015).
const props = defineProps({ rows: { type: Array, required: true } })
const items = computed(() => props.rows.map((r) => ({ ...r, p: productById(r.id) })).filter((r) => r.p))
</script>

<template>
  <div v-if="items.length >= 2" class="compare" :style="{ '--n': items.length }" role="table" aria-label="Side by side">
    <RouterLink v-for="r in items" :key="r.id" :to="`/product/${r.id}`" class="col" role="cell">
      <img :src="r.p.image" :alt="r.p.name" />
      <b>{{ r.p.name }}</b>
      <span class="price">{{ price(r.p.price) }}</span>
      <span class="best" dir="auto">{{ r.best }}</span>
    </RouterLink>
  </div>
</template>

<style scoped>
.compare {
  display: grid;
  grid-template-columns: repeat(var(--n), 1fr);
  gap: 8px;
  margin-top: 8px;
}
.col {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px;
  border-radius: 16px;
  background: #fff;
  border: 1.5px solid var(--line);
  color: var(--ink);
  text-decoration: none;
  font-size: 12px;
}
.col img {
  width: 100%;
  aspect-ratio: 1;
  border-radius: 10px;
  object-fit: cover;
  background: var(--card);
}
.col b {
  font-weight: 600;
  line-height: 1.25;
}
.price {
  font-weight: 600;
}
.best {
  padding: 4px 8px;
  border-radius: 8px;
  background: var(--mint);
  font-size: 12px;
  line-height: 1.3;
}
</style>
