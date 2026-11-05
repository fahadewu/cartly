<script setup>
import { computed } from 'vue'
import Icon from './Icon.vue'
import { initials } from '../data.js'
import { auth } from '../auth.js'
import { useShop } from '../store.js'

defineEmits(['menu'])

const { state, lines, cartCount } = useShop()
const thumbs = computed(() => lines.value.slice(0, 3).map((l) => l.product))
const extra = computed(() => Math.max(0, cartCount.value - thumbs.value.length))
const weekOrders = computed(() => state.orders.filter((o) => Date.now() - new Date(o.date) < 7 * 864e5).length)
const firstName = computed(() => auth.user?.name.split(' ')[0] ?? 'there')

const siteNav = [
  { to: '/', label: 'Explore' },
  { to: '/popular', label: 'Popular' },
  { to: '/category/clothing-shoes', label: 'Clothing & Shoes' },
  { to: '/category/gifts-living', label: 'Gifts & Living' },
  { to: '/inspiration', label: 'Inspiration' },
]
</script>

<template>
  <header class="topbar">
    <button class="menu icon-btn" aria-label="Open menu" @click="$emit('menu')">
      <Icon name="menu" />
    </button>

    <RouterLink v-if="state.mode === 'dashboard' && auth.user" to="/orders" class="stat">
      <strong>{{ weekOrders }}</strong>
      <span>Orders<small>Last 7 days</small></span>
    </RouterLink>
    <RouterLink v-else-if="state.mode === 'dashboard'" to="/" class="logo">C<span>art</span>ly</RouterLink>
    <template v-else>
      <RouterLink to="/" class="logo">C<span>art</span>ly</RouterLink>
      <nav class="site-nav">
        <RouterLink v-for="l in siteNav" :key="l.to" :to="l.to" :exact-active-class="l.to === '/' ? 'on' : ''" :active-class="l.to === '/' ? '' : 'on'">{{ l.label }}</RouterLink>
      </nav>
    </template>

    <div class="segmented" role="tablist">
      <button
        v-for="v in ['dashboard', 'website']"
        :key="v"
        role="tab"
        :aria-selected="state.mode === v"
        :class="{ on: state.mode === v }"
        @click="state.mode = v"
      >
        {{ v === 'dashboard' ? 'Dashboard' : 'Website' }}
      </button>
    </div>

    <div class="right">
      <RouterLink to="/favourites" class="pill fav" aria-label="Favourites">
        <Icon name="heart" :size="19" />
        <b v-if="state.liked.length">{{ state.liked.length }}</b>
      </RouterLink>
      <button class="pill cart" @click="state.cartOpen = true">
        <Icon name="bag" :size="19" />
        Cart
      </button>
      <div v-if="thumbs.length" class="stack">
        <img v-for="p in thumbs" :key="p.id" :src="p.image" alt="" />
        <span v-if="extra">+{{ extra }}</span>
      </div>
      <RouterLink v-if="auth.user" to="/account" class="user">
        <span class="initials" aria-hidden="true">{{ initials(auth.user?.name) }}</span>
        <span>{{ firstName }}</span>
      </RouterLink>
      <RouterLink v-else :to="{ name: 'login', query: { redirect: $route.fullPath } }" class="pill signin">Sign in</RouterLink>
    </div>
  </header>
</template>

<style scoped>
.topbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 24px;
  padding: 32px 34px 0 22px;
}

.menu {
  display: none;
  background: var(--chip);
}

.stat {
  color: inherit;
  text-decoration: none;
  display: flex;
  align-items: center;
  gap: 14px;
  min-width: 0;
}
.stat strong {
  font-size: 44px;
  font-weight: 500;
  letter-spacing: -0.02em;
  padding-right: 12px;
  border-right: 1px solid var(--line);
  line-height: 1;
}
.stat span {
  display: flex;
  flex-direction: column;
  font-size: 15px;
  font-weight: 500;
}
.stat small {
  font-size: 15px;
  font-weight: 400;
  color: var(--muted);
}

.segmented {
  display: flex;
  margin: 0 auto;
  padding: 4px;
  border-radius: var(--r-pill);
  background: var(--chip);
}
.segmented button {
  height: 52px;
  padding: 0 28px;
  border-radius: var(--r-pill);
  font-size: 15px;
  color: var(--muted);
  transition: all 0.25s ease;
}
.segmented button.on {
  background: #fff;
  color: var(--ink);
  box-shadow: 0 8px 20px -8px rgba(0, 0, 0, 0.15);
}

.right {
  display: flex;
  align-items: center;
  gap: 12px;
}
.logo {
  font-size: 24px;
  font-weight: 600;
  letter-spacing: -0.03em;
  color: inherit;
  text-decoration: none;
}
.logo span {
  position: relative;
}
.logo span::after {
  content: '';
  position: absolute;
  left: 2px;
  right: 6px;
  bottom: -5px;
  height: 3px;
  border-radius: 3px;
  background: var(--blue);
}
.site-nav {
  order: 10;
  flex-basis: 100%;
  display: flex;
  gap: 4px;
  overflow-x: auto;
  scrollbar-width: none;
}
.site-nav a {
  padding: 10px 14px;
  border-radius: var(--r-pill);
  font-size: 14px;
  font-weight: 500;
  color: var(--muted);
  text-decoration: none;
  white-space: nowrap;
  transition: all 0.2s ease;
}
.site-nav a:hover {
  color: var(--ink);
}
.site-nav a.on {
  background: var(--blue-soft);
  color: var(--blue);
}
.fav {
  position: relative;
  justify-content: center;
  width: 52px;
  height: 52px;
  padding: 0;
  color: inherit;
}
.fav:hover {
  background: var(--line);
}
.fav.router-link-active {
  color: #ff3b6b;
}
.fav b {
  position: absolute;
  top: -2px;
  right: -2px;
  display: grid;
  place-items: center;
  min-width: 20px;
  height: 20px;
  padding: 0 5px;
  border-radius: 10px;
  background: #ff3b6b;
  color: #fff;
  font-size: 11px;
}
.cart {
  height: 52px;
  padding: 0 20px;
}
.cart:hover {
  background: var(--line);
}

.stack {
  position: relative;
  display: grid;
  grid-template-columns: repeat(2, 22px);
  gap: 3px;
}
.stack img {
  width: 22px;
  height: 22px;
  border-radius: 7px;
  object-fit: cover;
}
.stack span {
  position: absolute;
  top: -10px;
  right: -22px;
  font-size: 12px;
  font-weight: 500;
}

.user {
  color: inherit;
  text-decoration: none;
  display: flex;
  align-items: center;
  gap: 12px;
  margin-left: 18px;
  font-size: 16px;
  font-weight: 500;
}
.user .initials {
  display: grid;
  place-items: center;
  width: 56px;
  height: 56px;
  border-radius: 50%;
  border: 4px solid var(--chip);
  background: var(--blue-soft);
  color: var(--blue);
  font-weight: 700;
  font-size: 16px;
  letter-spacing: 0.02em;
}

@media (max-width: 1100px) {
  .menu {
    display: grid;
  }
}
@media (max-width: 860px) {
  .topbar {
    flex-wrap: wrap;
    padding: 20px 16px 0;
    gap: 16px;
  }
  .segmented {
    order: 3;
    width: 100%;
  }
  .segmented button {
    flex: 1;
  }
  .right {
    margin-left: auto;
  }
  .user span,
  .stack {
    display: none;
  }
  .user {
    margin-left: 0;
  }
  .user .initials {
    width: 44px;
    height: 44px;
    font-size: 14px;
  }
  .stat strong {
    font-size: 34px;
  }
}
@media (max-width: 420px) {
  .stat span {
    display: none;
  }
}
</style>
