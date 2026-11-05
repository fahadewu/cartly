<script setup>
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import Icon from './Icon.vue'
import { auth, can, signOut } from '../auth.js'
import { badges } from '../badges.js'
import { STOREFRONT_URL } from '../api.js'

const route = useRoute()
const router = useRouter()
const menuOpen = ref(false)
watch(() => route.fullPath, () => (menuOpen.value = false))

// Each item shows only to roles that can open it (the router and the API check the same areas).
const ALL = [
  { to: '/', label: 'Dashboard', icon: 'dashboard', exact: true, area: 'dashboard' },
  { to: '/orders', label: 'Orders', icon: 'orders', badge: 'orders', hint: 'orders to ship', area: 'orders' },
  { to: '/products', label: 'Products', icon: 'products', badge: 'products', hint: 'products low or out of stock', area: 'catalog' },
  { to: '/customers', label: 'Customers', icon: 'customers', area: 'customers' },
  { to: '/analytics', label: 'Analytics', icon: 'analytics', area: 'analytics' },
  { to: '/reviews', label: 'Reviews', icon: 'reviews', area: 'reviews' },
  { to: '/promotions', label: 'Promotions', icon: 'promotions', area: 'promos' },
  { to: '/emails', label: 'Emails', icon: 'mail', area: 'marketing' },
  { to: '/returns', label: 'Returns', icon: 'returns', badge: 'returns', hint: 'returns to decide or refund', area: 'returns' },
  { to: '/delivery', label: 'Delivery', icon: 'delivery', badge: 'delivery', hint: 'deliveries that need a look', area: 'delivery' },
  { to: '/payments', label: 'Payments', icon: 'payments', badge: 'payments', hint: 'refunds to make', area: 'payments' },
  { to: '/requests', label: 'Requests', icon: 'requests', badge: 'requests', hint: 'open requests', area: 'requests' },
  { to: '/content', label: 'Content', icon: 'content', area: 'content' },
  { to: '/team', label: 'Team & roles', icon: 'team', area: 'team' },
  { to: '/system', label: 'System', icon: 'system', area: 'system' },
]
const nav = computed(() => ALL.filter((item) => can(`${item.area}.read`)))
const isActive = (item) => (item.exact ? route.path === item.to : route.path.startsWith(item.to))

function logout() {
  signOut()
  router.replace({ name: 'login' })
}
</script>

<template>
  <div class="shell">
    <header class="topbar">
      <RouterLink to="/" class="wordmark">Cartly <span>Admin</span></RouterLink>
      <button class="btn ghost sm" :aria-expanded="menuOpen" aria-controls="rail" @click="menuOpen = !menuOpen">
        <Icon :name="menuOpen ? 'x' : 'menu'" />
        <span class="sr-only">Menu</span>
      </button>
    </header>

    <aside id="rail" class="rail" :class="{ open: menuOpen }">
      <RouterLink to="/" class="wordmark big">Cartly <span>Admin</span></RouterLink>
      <nav aria-label="Admin">
        <RouterLink
          v-for="item in nav"
          :key="item.to"
          :to="item.to"
          class="nav-item"
          :class="{ active: isActive(item) }"
          :aria-current="isActive(item) ? 'page' : undefined"
        >
          <Icon :name="item.icon" />
          <span class="label">{{ item.label }}</span>
          <span v-if="item.badge && badges[item.badge]" class="count" :title="`${badges[item.badge]} ${item.hint}`">
            {{ badges[item.badge] }}<span class="sr-only"> {{ item.hint }}</span>
          </span>
        </RouterLink>
      </nav>

      <div class="rail-foot">
        <a :href="STOREFRONT_URL" target="_blank" rel="noopener" class="nav-item quiet"><Icon name="store" /><span class="label">Open the store</span></a>
        <div class="me">
          <strong>{{ auth.user?.name }}</strong>
          <span>{{ auth.user?.email }}</span>
          <span class="role">{{ auth.user?.roleLabel }}</span>
        </div>
        <button class="nav-item quiet" @click="logout"><Icon name="logout" /><span class="label">Sign out</span></button>
      </div>
    </aside>
    <div v-if="menuOpen" class="scrim" @click="menuOpen = false" />

    <main class="main">
      <RouterView v-slot="{ Component }">
        <component :is="Component" :key="route.path" />
      </RouterView>
    </main>
  </div>
</template>

<style scoped>
.me .role {
  justify-self: start;
  margin-top: 4px;
  padding: 1px 7px;
  border-radius: var(--r-tag);
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 11.5px;
  font-weight: 700;
}
.shell {
  display: grid;
  grid-template-columns: var(--rail) minmax(0, 1fr);
  min-height: 100vh;
}
.topbar {
  display: none;
}
.wordmark {
  font-family: var(--font-display);
  font-size: 21px;
  font-weight: 700;
  letter-spacing: -0.03em;
  color: var(--ink);
  text-decoration: none;
}
.wordmark span {
  margin-left: 2px;
  font-family: var(--font-ui);
  font-size: 13px;
  font-weight: 650;
  letter-spacing: 0;
  color: var(--muted);
}
.rail {
  position: sticky;
  top: 0;
  display: flex;
  flex-direction: column;
  height: 100vh;
  padding: 22px 14px 16px;
  border-right: 1px solid var(--line);
  overflow-y: auto;
}
.wordmark.big {
  padding: 0 10px 22px;
}
nav {
  display: grid;
  gap: 2px;
}
.nav-item {
  display: flex;
  align-items: center;
  gap: 11px;
  width: 100%;
  min-height: 38px;
  padding: 0 10px;
  border: 1px solid transparent;
  border-radius: var(--r-control);
  background: none;
  color: var(--ink-2);
  font-weight: 600;
  font-size: 14px;
  text-align: left;
  text-decoration: none;
}
.nav-item svg {
  color: var(--muted);
  flex-shrink: 0;
}
.nav-item:hover {
  background: rgba(18, 20, 23, 0.04);
  text-decoration: none;
}
.nav-item.active {
  background: var(--surface);
  border-color: var(--line);
  color: var(--ink);
}
.nav-item.active svg {
  color: var(--accent);
}
.label {
  flex: 1;
}
.count {
  min-width: 22px;
  height: 20px;
  padding: 0 7px;
  border-radius: 999px;
  background: var(--butter);
  color: var(--ink);
  font-size: 11.5px;
  font-weight: 800;
  line-height: 20px;
  text-align: center;
  font-variant-numeric: tabular-nums;
}
.rail-foot {
  display: grid;
  gap: 2px;
  margin-top: auto;
  padding-top: 18px;
}
.nav-item.quiet {
  font-size: 13.5px;
  color: var(--muted);
}
.me {
  display: grid;
  padding: 10px 10px 8px;
  margin-top: 6px;
  border-top: 1px solid var(--line);
  font-size: 13px;
  min-width: 0;
}
.me span {
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
}
.main {
  min-width: 0;
  width: 100%;
  max-width: 1320px;
  padding: 30px 36px 72px;
}
.scrim {
  display: none;
}

@media (max-width: 900px) {
  .shell {
    grid-template-columns: minmax(0, 1fr);
  }
  .topbar {
    position: sticky;
    top: 0;
    z-index: 30;
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 56px;
    padding: 0 12px 0 16px;
    background: var(--paper);
    border-bottom: 1px solid var(--line);
  }
  .rail {
    position: fixed;
    z-index: 40;
    top: 56px;
    left: 0;
    width: min(300px, 86vw);
    height: calc(100dvh - 56px);
    background: var(--paper);
    transform: translateX(-100%);
    transition: transform 0.2s ease;
  }
  .rail.open {
    transform: none;
  }
  .wordmark.big {
    display: none;
  }
  .scrim {
    display: block;
    position: fixed;
    inset: 56px 0 0;
    z-index: 35;
    background: rgba(18, 20, 23, 0.28);
  }
  .main {
    padding: 20px 16px 56px;
  }
}
</style>
