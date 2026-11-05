<script setup>
import { toasts } from '../toast.js'
</script>

<template>
  <div class="toasts" role="status" aria-live="polite">
    <TransitionGroup name="toast">
      <div v-for="t in toasts" :key="t.id" class="toast" :class="t.kind">{{ t.message }}</div>
    </TransitionGroup>
  </div>
</template>

<style scoped>
.toasts {
  position: fixed;
  z-index: 100;
  left: 50%;
  bottom: 22px;
  translate: -50% 0;
  display: grid;
  justify-items: center;
  gap: 8px;
  width: min(460px, calc(100vw - 32px));
  pointer-events: none;
}
.toast {
  padding: 10px 16px;
  border-radius: var(--r-control);
  background: var(--ink);
  color: #fff;
  font-weight: 600;
  font-size: 13.5px;
  box-shadow: 0 10px 30px -12px rgba(18, 20, 23, 0.45);
}
.toast.error {
  background: #8f241c;
}
.toast-enter-active,
.toast-leave-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateY(8px);
}
</style>
