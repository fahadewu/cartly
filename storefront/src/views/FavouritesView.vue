<script setup>
import { computed } from 'vue'
import PageHeader from '../components/PageHeader.vue'
import ProductCard from '../components/ProductCard.vue'
import Icon from '../components/Icon.vue'
import { curatedFavourites } from '../data.js'
import { productById } from '../catalog.js'
import { useShop } from '../store.js'

const { state, addAllToCart, clearFavourites } = useShop()
const items = computed(() => state.liked.map(productById).filter(Boolean))
// Curated ids may have been retired by an admin since: never render a missing product.
const picks = computed(() => curatedFavourites.map(productById).filter(Boolean))

function addAll() {
  addAllToCart(items.value)
}
function clearAll() {
  clearFavourites()
}
</script>

<template>
  <div>
    <PageHeader
      title="Favourites"
      :subtitle="items.length ? `${items.length} saved item${items.length === 1 ? '' : 's'}` : 'Everything you love, in one place'"
      :crumbs="[{ label: 'Explore', to: '/' }, { label: 'Favourites' }]"
    >
      <template v-if="items.length">
        <button class="btn-secondary sm" @click="clearAll">Clear all</button>
        <button class="btn-primary sm" @click="addAll"><Icon name="bag" :size="16" />Add all to cart</button>
      </template>
    </PageHeader>

    <div class="page">
      <TransitionGroup v-if="items.length" tag="div" name="grid" class="product-grid">
        <ProductCard v-for="p in items" :key="p.id" :product="p" compact />
      </TransitionGroup>

      <template v-else>
        <div class="empty">
          <span class="empty-icon"><Icon name="heart" :size="28" /></span>
          <h3>No favourites yet</h3>
          <p>Tap the heart on anything you like and it will be saved here for later.</p>
          <RouterLink to="/shop" class="btn-primary sm">Start exploring</RouterLink>
        </div>
        <div class="section-title"><h2>Our picks for you</h2></div>
        <div class="product-grid">
          <ProductCard v-for="p in picks" :key="p.id" :product="p" compact />
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
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
</style>
