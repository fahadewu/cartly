<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { money, moneyShort, count } from '../format.js'

// Daily revenue bars. Hover, or focus the chart and use the arrow keys, to read a day.
const props = defineProps({ series: { type: Array, default: () => [] } })

const wrap = ref(null)
const width = ref(760)
const H = 230
const pad = { l: 54, r: 6, t: 14, b: 28 }
let ro
onMounted(() => {
  ro = new ResizeObserver(([e]) => (width.value = Math.max(280, e.contentRect.width)))
  ro.observe(wrap.value)
})
onBeforeUnmount(() => ro?.disconnect())

function niceMax(v) {
  if (v <= 0) return 100
  const p = 10 ** Math.floor(Math.log10(v))
  const n = v / p
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p
}
const n = computed(() => props.series.length || 1)
const max = computed(() => niceMax(Math.max(0, ...props.series.map((d) => d.revenue))))
const band = computed(() => (width.value - pad.l - pad.r) / n.value)
const barW = computed(() => Math.max(2, Math.min(28, band.value * 0.66)))
const x = (i) => pad.l + i * band.value + (band.value - barW.value) / 2
const y = (v) => pad.t + (1 - v / max.value) * (H - pad.t - pad.b)
const grid = computed(() => [0, max.value / 2, max.value])
// Date labels about every 70px (at most six), counted back from today so the last bar is labelled.
const labelled = computed(() => {
  const fit = Math.max(2, Math.min(6, Math.floor((width.value - pad.l - pad.r) / 70)))
  const step = Math.ceil(n.value / fit)
  return props.series.map((_, i) => (n.value - 1 - i) % step === 0)
})
const bars = computed(() =>
  props.series.map((d, i) => {
    const h = d.revenue > 0 ? Math.max(2, y(0) - y(d.revenue)) : 2
    return { ...d, i, x: x(i), y: y(0) - h, h, empty: d.revenue <= 0 }
  }),
)

const active = ref(null)
const current = computed(() => (active.value == null ? null : bars.value[active.value]))
function onMove(e) {
  const rect = e.currentTarget.getBoundingClientRect()
  const i = Math.floor((e.clientX - rect.left - pad.l) / band.value)
  active.value = i >= 0 && i < props.series.length ? i : null
}
function onKey(e) {
  const last = props.series.length - 1
  const moves = { ArrowLeft: -1, ArrowRight: 1, Home: -Infinity, End: Infinity }
  if (!(e.key in moves)) return
  e.preventDefault()
  active.value = Math.min(last, Math.max(0, (active.value ?? last) + moves[e.key]))
}
const tipStyle = computed(() => {
  const b = current.value
  if (!b) return {}
  const left = Math.min(width.value - 90, Math.max(90, b.x + barW.value / 2))
  return { left: `${left}px`, top: `${Math.max(0, b.y - 10)}px` }
})
// Series dates are UTC days.
const dayLabel = (d) => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })
const longDate = (d) => new Date(d).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })
const total = computed(() => props.series.reduce((s, d) => s + d.revenue, 0))
</script>

<template>
  <div
    ref="wrap"
    class="chart"
    tabindex="0"
    role="group"
    :aria-label="`Daily revenue for the last ${series.length} days, ${money(total)} in total. Use the arrow keys to read each day.`"
    @keydown="onKey"
    @focus="active ??= series.length - 1"
    @blur="active = null"
  >
    <svg :width="width" :height="H" :viewBox="`0 0 ${width} ${H}`" aria-hidden="true" @pointermove="onMove" @pointerleave="active = null">
      <g class="grid">
        <template v-for="g in grid" :key="g">
          <line :x1="pad.l" :x2="width - pad.r" :y1="y(g)" :y2="y(g)" />
          <text :x="pad.l - 10" :y="y(g) + 4" text-anchor="end">{{ moneyShort(g) }}</text>
        </template>
      </g>
      <g>
        <rect
          v-for="b in bars"
          :key="b.date"
          class="bar"
          :class="{ empty: b.empty, on: active === b.i }"
          :x="b.x"
          :y="b.y"
          :width="barW"
          :height="b.h"
          rx="2"
        />
      </g>
      <g class="xlabels">
        <template v-for="b in bars" :key="`l-${b.date}`">
          <text v-if="labelled[b.i]" :x="b.x + barW / 2" :y="H - 8" text-anchor="middle">{{ dayLabel(b.date) }}</text>
        </template>
      </g>
    </svg>
    <div v-if="current" class="tip" :style="tipStyle" aria-live="polite">
      <strong>{{ longDate(current.date) }}</strong>
      <span class="figures">{{ money(current.revenue) }}</span>
      <span class="figures muted">{{ count(current.orders) }} {{ current.orders === 1 ? 'order' : 'orders' }}</span>
    </div>
  </div>
</template>

<style scoped>
.chart {
  position: relative;
  border-radius: var(--r-control);
}
.chart:focus-visible {
  outline-offset: 4px;
}
svg {
  display: block;
  overflow: visible;
}
.grid line {
  stroke: var(--line);
  stroke-width: 1;
}
text {
  fill: var(--muted);
  font-size: 11.5px;
  font-weight: 600;
  font-family: var(--font-ui);
  font-variant-numeric: tabular-nums;
}
.bar {
  fill: var(--accent);
  transition: fill 0.12s ease;
}
.bar.empty {
  fill: var(--line-strong);
}
.bar.on {
  fill: #0d2f99;
}
.tip {
  position: absolute;
  z-index: 2;
  display: grid;
  gap: 1px;
  min-width: 132px;
  padding: 8px 11px;
  border: 1px solid var(--line);
  border-radius: var(--r-control);
  background: var(--surface);
  box-shadow: 0 10px 28px -14px rgba(18, 20, 23, 0.4);
  font-size: 12.5px;
  transform: translate(-50%, -100%);
  pointer-events: none;
}
.tip span:first-of-type {
  font-size: 14px;
  font-weight: 700;
}
</style>
