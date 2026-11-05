<script setup>
import { ref, computed } from 'vue'
import Icon from './Icon.vue'
import { curatedFavourites } from '../data.js'
import { productById } from '../catalog.js'
import { useShop } from '../store.js'

// Shows the shopper's liked products, or our picks until they like something.
const { state } = useShop()
const items = computed(() => (state.liked.length >= 2 ? state.liked : curatedFavourites).map(productById).filter(Boolean))

const start = ref(0)
const visible = computed(() => [0, 1].map((i) => items.value[(start.value + i) % items.value.length]))
const step = (d) => (start.value = (start.value + d + items.value.length) % items.value.length)
</script>

<template>
  <section class="fav">
    <header>
      <span>{{ state.liked.length >= 2 ? 'Favourites' : 'Our picks' }}</span>
      <button aria-label="Previous" @click="step(-1)"><Icon name="chevronLeft" /></button>
      <button aria-label="Next" @click="step(1)"><Icon name="chevronRight" /></button>
    </header>
    <div class="tiles">
      <TransitionGroup name="slide">
        <RouterLink v-for="p in visible" :key="p.id" :to="`/product/${p.id}`" class="tile" :title="p.name">
          <img :src="p.image" :alt="p.name" />
        </RouterLink>
      </TransitionGroup>
      <RouterLink to="/favourites" class="see-all">See All</RouterLink>
    </div>
  </section>
</template>

<style scoped>
.fav {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border: 2px solid var(--line);
  border-radius: var(--r-card);
}

header {
  display: flex;
  align-items: center;
  gap: 16px;
  height: 70px;
  padding: 0 28px;
  border-radius: 28px;
  background: var(--peach);
  font-size: 15px;
  font-weight: 500;
}
header span {
  margin-right: auto;
}
header button {
  display: grid;
  place-items: center;
  transition: transform 0.15s ease;
}
header button:hover {
  transform: scale(1.2);
}

.tiles {
  position: relative;
  flex: 1;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  padding: 8px;
  border-radius: 28px;
  background: var(--peach);
  min-height: 170px;
  overflow: hidden;
}
.tile {
  display: block;
  overflow: hidden;
  border-radius: 22px;
  background: #fff;
}
.tile img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  transition: transform 0.4s ease;
}
.tile:hover img {
  transform: scale(1.06);
}
.see-all {
  position: absolute;
  right: 16px;
  bottom: 16px;
  display: grid;
  place-items: center;
  width: calc(50% - 20px);
  height: 50px;
  border-radius: var(--r-pill);
  background: #fff;
  color: inherit;
  font-size: 14px;
  font-weight: 500;
  text-decoration: none;
}
.see-all:hover {
  background: var(--chip);
}

.slide-enter-active {
  transition: all 0.35s ease;
}
.slide-enter-from {
  opacity: 0;
  transform: translateY(12px);
}
.slide-leave-active {
  display: none;
}
</style>
