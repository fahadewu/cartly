<script setup>
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import Icon from './Icon.vue'
import { auth, signOut } from '../auth.js'
import { useShop } from '../store.js'
import { looks } from '../looks.js'

defineProps({ open: Boolean })
defineEmits(['close'])

const nav = [
  { to: '/popular', label: 'Popular Products', icon: 'bolt' },
  { to: '/', label: 'Explore New', icon: 'compass', exact: true },
  { to: '/category/clothing-shoes', label: 'Clothing and Shoes', icon: 'cart' },
  { to: '/category/gifts-living', label: 'Gifts and Living', icon: 'gift' },
  { to: '/inspiration', label: 'Inspiration', icon: 'bulb' },
]

const { state } = useShop()
const recent = computed(() => state.orders.slice(0, 2))
const router = useRouter()

function logout() {
  signOut()
  router.push({ name: 'login' })
}
</script>

<template>
  <aside class="sidebar" :class="{ open }">
    <RouterLink to="/" class="logo">C<span>art</span>ly</RouterLink>

    <nav class="nav">
      <RouterLink
        v-for="item in nav"
        :key="item.to"
        :to="item.to"
        class="nav-item"
        :exact-active-class="item.exact ? 'active' : ''"
        :active-class="item.exact ? '' : 'active'"
      >
        <Icon :name="item.icon" :size="19" />
        {{ item.label }}
      </RouterLink>
      <RouterLink v-if="looks.list.length" to="/looks" class="nav-item" active-class="active">
        <Icon name="users" :size="19" />
        Family votes
        <span v-if="looks.unseen" class="count" :aria-label="`${looks.unseen} new`">{{ looks.unseen }}</span>
      </RouterLink>
    </nav>

    <template v-if="auth.user">
      <section class="group">
        <h4>Quick actions</h4>
        <RouterLink to="/request" class="quick"><span><Icon name="plus" :size="16" /></span>Request for product</RouterLink>
        <RouterLink to="/team" class="quick"><span><Icon name="plus" :size="16" /></span>Add member</RouterLink>
      </section>

      <section class="group">
        <h4>Last orders <b>{{ state.orders.length }}</b></h4>
        <RouterLink v-for="o in recent" :key="o.id" :to="`/orders/${o.id}`" class="order">
          <img :src="o.items[0]?.image" alt="" />
          <span><b>{{ (o.items[0]?.name ?? 'Order').split(' ').slice(0, 2).join(' ') }}…</b>view order</span>
        </RouterLink>
        <RouterLink to="/orders" class="see-all">See all</RouterLink>
      </section>

      <button class="logout" @click="logout"><Icon name="logout" :size="19" />Log out</button>
    </template>
    <section v-else class="group guest">
      <h4>Your account</h4>
      <p>Sign in to keep a cart, favourites and orders.</p>
      <RouterLink :to="{ name: 'login', query: { redirect: $route.fullPath } }" class="btn-primary sm">Sign in</RouterLink>
      <RouterLink to="/signup" class="see-all">Create an account</RouterLink>
    </section>
  </aside>
</template>

<style scoped>
.sidebar {
  display: flex;
  flex-direction: column;
  padding: 44px 34px 40px;
  border-right: 1px solid var(--line);
}

.logo {
  display: block;
  color: inherit;
  text-decoration: none;
  font-size: 26px;
  font-weight: 600;
  letter-spacing: -0.03em;
  margin-bottom: 80px;
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

.nav {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding-bottom: 28px;
  border-bottom: 1px solid var(--line);
}
.nav-item {
  color: inherit;
  text-decoration: none;
  display: flex;
  align-items: center;
  gap: 12px;
  height: 52px;
  padding: 0 22px;
  border-radius: 20px;
  font-size: 15px;
  font-weight: 500;
  text-align: left;
  transition: background 0.2s ease, color 0.2s ease;
}
.nav-item:hover {
  background: var(--chip);
}
.nav-item .count {
  margin-left: auto;
  min-width: 22px;
  height: 22px;
  padding: 0 6px;
  border-radius: 11px;
  background: var(--blue);
  color: #fff;
  font-size: 12px;
  font-weight: 600;
  line-height: 22px;
  text-align: center;
}
.nav-item.active {
  background: var(--blue);
  color: #fff;
  box-shadow: 0 10px 24px -10px rgba(31, 91, 255, 0.7);
}

.group {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 28px 22px;
  border-bottom: 1px solid var(--line);
}
.group h4 {
  margin: 0 0 4px;
  font-size: 13px;
  font-weight: 400;
  color: var(--muted);
}
.group h4 b {
  color: var(--ink);
  font-weight: 500;
}

.quick {
  color: inherit;
  text-decoration: none;
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 14px;
  font-weight: 500;
}
.quick:hover span {
  background: var(--line);
}
.quick.router-link-active span {
  background: var(--blue);
  color: #fff;
}
.quick span {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border-radius: 9px;
  background: var(--chip);
}

.order {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 14px;
  color: var(--muted);
  text-decoration: none;
}
.order:hover b {
  color: var(--blue);
}
.order img {
  width: 30px;
  height: 30px;
  border-radius: 50%;
  object-fit: cover;
}
.order b {
  color: var(--ink);
  font-weight: 500;
}
.see-all {
  font-size: 13px;
  color: var(--muted);
  text-decoration: none;
}

.logout {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: auto;
  padding: 40px 22px 0;
  font-size: 15px;
  font-weight: 500;
}

@media (max-width: 1100px) {
  .sidebar {
    position: fixed;
    inset: 0 auto 0 0;
    z-index: 40;
    width: 290px;
    overflow-y: auto;
    background: #fff;
    transform: translateX(-100%);
    transition: transform 0.3s ease;
  }
  .sidebar.open {
    transform: none;
    box-shadow: 20px 0 60px rgba(0, 0, 0, 0.15);
  }
  .logo {
    margin-bottom: 40px;
  }
}
.guest p {
  margin: 0 0 14px;
  font-size: 13px;
  line-height: 1.5;
  color: var(--muted);
}
.guest .btn-primary {
  display: inline-flex;
  margin-bottom: 10px;
}
</style>
