<script setup>
// Segmented filter tabs with optional counts. items: [{ value, label, count? }]
defineProps({ items: Array, modelValue: [String, Number], label: String })
const emit = defineEmits(['update:modelValue'])
</script>

<template>
  <div class="tabs" role="tablist" :aria-label="label">
    <button
      v-for="t in items"
      :key="t.value"
      role="tab"
      class="tab"
      :aria-selected="modelValue === t.value"
      @click="emit('update:modelValue', t.value)"
    >
      {{ t.label }}<span v-if="t.count != null" class="n figures">{{ t.count }}</span>
    </button>
  </div>
</template>

<style scoped>
.tabs {
  display: flex;
  gap: 2px;
  padding: 3px;
  border-radius: var(--r-control);
  background: var(--paper);
  border: 1px solid var(--line);
  overflow-x: auto;
  max-width: 100%;
}
.tab {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  height: 30px;
  padding: 0 11px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: none;
  color: var(--muted);
  font-weight: 650;
  font-size: 13px;
  white-space: nowrap;
}
.tab:hover {
  color: var(--ink);
}
.tab[aria-selected='true'] {
  background: var(--surface);
  border-color: var(--line);
  color: var(--ink);
}
.n {
  font-size: 12px;
  color: var(--muted);
  font-weight: 700;
}
</style>
