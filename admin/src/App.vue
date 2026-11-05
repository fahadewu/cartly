<script setup>
import { auth, restore } from './auth.js'
import Toasts from './components/Toasts.vue'
import ConfirmHost from './components/ConfirmHost.vue'

async function retry() {
  await restore()
  if (!auth.offline) location.reload()
}
</script>

<template>
  <div v-if="auth.offline" class="offline">
    <div class="panel pad">
      <h1 class="display">Can’t reach the store</h1>
      <p class="muted">{{ auth.offline }}</p>
      <button class="btn primary" @click="retry">Try again</button>
    </div>
  </div>
  <RouterView v-else />
  <Toasts />
  <ConfirmHost />
</template>

<style scoped>
.offline {
  display: grid;
  place-items: center;
  min-height: 100vh;
  padding: 16px;
}
.offline .panel {
  max-width: 420px;
}
.offline h1 {
  font-size: 26px;
}
</style>
