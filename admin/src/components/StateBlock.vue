<script setup>
// Loading, error and empty states for a panel's content.
defineProps({ loading: Boolean, error: String, empty: Boolean, emptyText: String })
const emit = defineEmits(['retry'])
</script>

<template>
  <div v-if="loading" class="state" aria-busy="true"><span class="spinner" aria-hidden="true" />Loading…</div>
  <div v-else-if="error" class="state error" role="alert">
    <p>{{ error }}</p>
    <button class="btn sm" @click="emit('retry')">Try again</button>
  </div>
  <div v-else-if="empty" class="state empty">
    <p>{{ emptyText }}</p>
    <slot name="empty" />
  </div>
  <slot v-else />
</template>

<style scoped>
.state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  min-height: 140px;
  padding: 28px 20px;
  color: var(--muted);
  font-weight: 600;
  text-align: center;
}
.state.empty {
  min-height: 96px;
  font-weight: 500;
}
.state:first-child:has(.spinner) {
  flex-direction: row;
}
.state.error p {
  color: #8f241c;
  max-width: 52ch;
}
.spinner {
  width: 16px;
  height: 16px;
  border: 2px solid var(--line-strong);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(1turn);
  }
}
</style>
