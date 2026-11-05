<script setup>
import { onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import Sidebar from './Sidebar.vue'
import TopBar from './TopBar.vue'
import CartDrawer from './CartDrawer.vue'
import Icon from './Icon.vue'
import AgentWidget from './agent/AgentWidget.vue'
import TryOnStudio from './tryon/TryOnStudio.vue'
import PoweredBy from './PoweredBy.vue'
import { useShop } from '../store.js'
import { toastKind, toastMessage } from '../toast.js'
import { watchLooks } from '../looks.js'

const { state } = useShop()
const route = useRoute()
const menuOpen = ref(false)

watch(() => route.path, () => (menuOpen.value = false))
// New family votes on shared looks show up as a toast and a count in the sidebar.
onMounted(watchLooks)
</script>

<template>
  <div class="shell" :class="{ website: state.mode === 'website' }">
    <Sidebar :open="menuOpen" @close="menuOpen = false" />
    <div v-if="menuOpen" class="menu-scrim" @click="menuOpen = false" />

    <main class="main">
      <TopBar @menu="menuOpen = true" />
      <RouterView v-slot="{ Component, route: r }">
        <Transition name="fade" mode="out-in">
          <component :is="Component" :key="r.path" />
        </Transition>
      </RouterView>

      <footer class="app-footer">
        <PoweredBy />
        <div class="legal">
          © {{ new Date().getFullYear() }} Cartly. All rights reserved. ·
          <RouterLink to="/promise">The Cartly promise: no fake timers, no hidden fees</RouterLink>
        </div>
      </footer>
    </main>
  </div>

  <CartDrawer />
  <AgentWidget />
  <TryOnStudio />

  <Transition name="toast">
    <div v-if="toastMessage" class="toast" :class="toastKind" :role="toastKind === 'error' ? 'alert' : 'status'">
      <Icon :name="toastKind === 'error' ? 'alert' : 'check'" :size="16" />{{ toastMessage }}
    </div>
  </Transition>
</template>

<style scoped>
.shell {
  display: grid;
  grid-template-columns: 300px 1fr;
  /* Fill the window, leaving a thin strip of background all round. */
  min-height: calc(100dvh - 2 * var(--gutter));
  margin: var(--gutter);
  background: var(--shell);
  border-radius: var(--r-shell);
  box-shadow: 0 40px 80px -40px rgba(40, 80, 50, 0.35);
  /* clip (not hidden) keeps rounded corners without breaking the sticky sidebar */
  overflow: clip;
}
/* Desktop: the sidebar stays in view while the page scrolls. */
@media (min-width: 1101px) {
  .shell :deep(.sidebar) {
    position: sticky;
    top: var(--gutter);
    align-self: start;
    height: calc(100dvh - 2 * var(--gutter));
    overflow-y: auto;
    border-right: 0;
    scrollbar-width: thin;
  }
  .shell:not(.website) .main {
    border-left: 1px solid var(--line);
  }
}
.shell.website {
  grid-template-columns: 1fr;
}
.shell.website :deep(.sidebar) {
  display: none;
}

.main {
  min-width: 0;
  padding-bottom: 40px;
}

.menu-scrim {
  display: none;
}

.app-footer {
  margin: 56px 34px 0 22px;
}
.app-footer .legal {
  padding: 22px 0 6px;
  font-size: 13px;
  color: var(--muted);
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
  transform: translateY(6px);
}

@media (max-width: 1100px) {
  .shell {
    grid-template-columns: 1fr;
  }
  /* On small screens the sidebar is a drawer in both modes. */
  .shell.website :deep(.sidebar) {
    display: flex;
  }
  .menu-scrim {
    display: block;
    position: fixed;
    inset: 0;
    z-index: 39;
    background: rgba(18, 20, 23, 0.3);
  }
}
@media (max-width: 860px) {
  .shell {
    border-radius: 32px;
  }
  .app-footer {
    margin: 40px 16px 0;
    padding-bottom: 88px; /* clear of Pip's floating button at the end of the page */
  }
}
@media (max-width: 560px) {
  .shell {
    margin: 0;
    min-height: 100dvh;
    border-radius: 0;
  }
}
.legal a {
  color: inherit;
}
</style>
