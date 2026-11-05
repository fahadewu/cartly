<script setup>
import { computed } from 'vue'

// A ranked list with a bar per row: "units by colour", "sales by region". One hue, value labels in ink.
// items: [{ name, value, note? }]. `format` turns a value into its label.
const props = defineProps({
  items: { type: Array, default: () => [] },
  format: { type: Function, default: (v) => String(v) },
  empty: { type: String, default: 'Nothing yet.' },
  limit: { type: Number, default: 10 },
})
const rows = computed(() => props.items.slice(0, props.limit))
const max = computed(() => Math.max(0, ...rows.value.map((r) => Number(r.value) || 0)))
</script>

<template>
  <p v-if="!rows.length" class="muted small empty">{{ empty }}</p>
  <ol v-else class="bars">
    <li v-for="r in rows" :key="r.name" :title="`${r.name}: ${format(r.value)}${r.note ? ` · ${r.note}` : ''}`">
      <div class="line">
        <span class="name">{{ r.name }}</span>
        <span class="value figures">{{ format(r.value) }}</span>
      </div>
      <div class="track"><span class="fill" :style="{ width: `${max ? Math.max(1.5, (Number(r.value) / max) * 100) : 0}%` }" /></div>
      <span v-if="r.note" class="note">{{ r.note }}</span>
    </li>
  </ol>
</template>

<style scoped>
.bars {
  display: grid;
  gap: 10px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.line {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  font-size: 13.5px;
}
.name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.value {
  font-weight: 700;
  white-space: nowrap;
}
.track {
  height: 6px;
  margin-top: 4px;
  border-radius: 3px;
  background: var(--grey);
}
.fill {
  display: block;
  height: 100%;
  border-radius: 3px;
  background: #2a78d6;
}
.note {
  display: block;
  margin-top: 2px;
  color: var(--muted);
  font-size: 12px;
}
.small {
  font-size: 13px;
}
.empty {
  margin: 0;
}
</style>
