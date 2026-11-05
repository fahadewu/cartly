<script setup>
import { computed, ref } from 'vue'

// Orders by weekday × hour (store time). One hue, light → dark; hover a cell to read it.
const props = defineProps({ grid: { type: Array, default: () => [] } })
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const ORDER = [6, 0, 1, 2, 3, 4, 5] // Saturday first, as the Bangladeshi work week starts
const STEPS = ['#eef3fb', '#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#256abf', '#184f95']
const max = computed(() => Math.max(0, ...props.grid.flat()))
const fill = (v) => (!v ? STEPS[0] : STEPS[Math.min(STEPS.length - 1, 1 + Math.floor((v / max.value) * (STEPS.length - 2)))])
const hover = ref(null)
const busiest = computed(() => {
  let best = null
  props.grid.forEach((row, d) => row.forEach((v, h) => (!best || v > best.v) && v && (best = { d, h, v })))
  return best
})
const hourLabel = (h) => `${String(h).padStart(2, '0')}:00`
</script>

<template>
  <div>
    <div class="heat" role="img" :aria-label="busiest ? `Busiest: ${DAYS[busiest.d]} ${hourLabel(busiest.h)}, ${busiest.v} orders` : 'No orders yet'" @mouseleave="hover = null">
      <span />
      <span v-for="h in 24" :key="h" class="hour">{{ (h - 1) % 3 === 0 ? h - 1 : '' }}</span>
      <template v-for="d in ORDER" :key="d">
        <span class="day">{{ DAYS[d] }}</span>
        <span
          v-for="(v, h) in grid[d] ?? []"
          :key="h"
          class="cell"
          :style="{ background: fill(v) }"
          @mouseenter="hover = { d, h, v }"
        />
      </template>
    </div>
    <p class="muted small read">
      <template v-if="hover">{{ DAYS[hover.d] }} {{ hourLabel(hover.h) }}–{{ hourLabel((hover.h + 1) % 24) }}: <b>{{ hover.v }}</b> {{ hover.v === 1 ? 'order' : 'orders' }}</template>
      <template v-else-if="busiest">Busiest hour: <b>{{ DAYS[busiest.d] }} {{ hourLabel(busiest.h) }}</b> ({{ busiest.v }} orders). Hover a square to read it.</template>
      <template v-else>No orders in this period.</template>
    </p>
  </div>
</template>

<style scoped>
.heat {
  display: grid;
  grid-template-columns: 34px repeat(24, minmax(8px, 1fr));
  gap: 2px;
  align-items: center;
}
.cell {
  aspect-ratio: 1;
  border-radius: 3px;
}
.day,
.hour {
  color: var(--muted);
  font-size: 11px;
}
.hour {
  text-align: left;
}
.read {
  margin: 8px 0 0;
}
.small {
  font-size: 12.5px;
}
</style>
