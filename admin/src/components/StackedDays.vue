<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

// Daily stacked bars (one axis, one unit). series: [{ date|day, [key]: number }], keys: [{ key, label, color }].
// Hover or arrow keys read a day; the legend names every series, and a table view sits behind "Show as table".
const props = defineProps({
  series: { type: Array, default: () => [] },
  keys: { type: Array, required: true },
  format: { type: Function, default: (v) => String(v) },
  label: { type: String, default: 'Daily chart' },
})

const wrap = ref(null)
const width = ref(760)
const H = 220
const pad = { l: 58, r: 6, t: 12, b: 26 }
let ro
onMounted(() => {
  ro = new ResizeObserver(([e]) => (width.value = Math.max(280, e.contentRect.width)))
  ro.observe(wrap.value)
})
onBeforeUnmount(() => ro?.disconnect())
const dateOf = (d) => d.date ?? d.day
const totalOf = (d) => props.keys.reduce((a, k) => a + (Number(d[k.key]) || 0), 0)
function niceMax(v) {
  if (v <= 0) return 1
  const p = 10 ** Math.floor(Math.log10(v))
  const n = v / p
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p
}
const n = computed(() => props.series.length || 1)
const max = computed(() => niceMax(Math.max(0, ...props.series.map(totalOf))))
const band = computed(() => (width.value - pad.l - pad.r) / n.value)
const barW = computed(() => Math.max(2, Math.min(26, band.value * 0.66)))
const y = (v) => pad.t + (1 - v / max.value) * (H - pad.t - pad.b)
const bars = computed(() =>
  props.series.map((d, i) => {
    let base = 0
    const segs = []
    for (const k of props.keys) {
      const v = Number(d[k.key]) || 0
      if (v > 0) {
        const top = y(base + v)
        const h = y(base) - top
        // 2px surface gap between stacked segments.
        segs.push({ key: k.key, color: k.color, y: top, h: Math.max(1, h - (segs.length ? 2 : 0)) })
      }
      base += v
    }
    return { i, x: pad.l + i * band.value + (band.value - barW.value) / 2, segs, d }
  }),
)
const labelled = computed(() => {
  const fit = Math.max(2, Math.min(6, Math.floor((width.value - pad.l - pad.r) / 70)))
  const step = Math.ceil(n.value / fit)
  return props.series.map((_, i) => (n.value - 1 - i) % step === 0)
})
const shortDate = (s) => new Date(`${s}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })
const active = ref(null)
const current = computed(() => (active.value == null ? null : props.series[active.value]))
function onMove(e) {
  const rect = e.currentTarget.getBoundingClientRect()
  const i = Math.floor((e.clientX - rect.left - pad.l) / band.value)
  active.value = i >= 0 && i < props.series.length ? i : null
}
function onKey(e) {
  const moves = { ArrowLeft: -1, ArrowRight: 1, Home: -Infinity, End: Infinity }
  if (!(e.key in moves)) return
  e.preventDefault()
  active.value = Math.min(props.series.length - 1, Math.max(0, (active.value ?? props.series.length - 1) + moves[e.key]))
}
const tipLeft = computed(() => (active.value == null ? 0 : Math.min(width.value - 190, Math.max(0, pad.l + active.value * band.value - 60))))
const showTable = ref(false)
</script>

<template>
  <div>
    <div class="legend">
      <span v-for="k in keys" :key="k.key"><i :style="{ background: k.color }" />{{ k.label }}</span>
      <button type="button" class="link-btn small push" @click="showTable = !showTable">{{ showTable ? 'Show as chart' : 'Show as table' }}</button>
    </div>
    <div v-show="!showTable" ref="wrap" class="chart">
      <svg
        :width="width"
        :height="H"
        role="img"
        :aria-label="label"
        tabindex="0"
        @mousemove="onMove"
        @mouseleave="active = null"
        @keydown="onKey"
        @blur="active = null"
      >
        <g class="grid">
          <template v-for="v in [0, max / 2, max]" :key="v">
            <line :x1="pad.l" :x2="width - pad.r" :y1="y(v)" :y2="y(v)" />
            <text :x="pad.l - 8" :y="y(v) + 4" text-anchor="end">{{ format(v) }}</text>
          </template>
        </g>
        <g v-for="b in bars" :key="b.i" :opacity="active == null || active === b.i ? 1 : 0.45">
          <rect v-for="s in b.segs" :key="s.key" :x="b.x" :y="s.y" :width="barW" :height="s.h" :fill="s.color" rx="2" />
          <rect v-if="!b.segs.length" :x="b.x" :y="y(0) - 2" :width="barW" height="2" fill="var(--line-strong)" />
        </g>
        <g class="axis">
          <template v-for="b in bars" :key="`l${b.i}`">
            <text v-if="labelled[b.i]" :x="b.x + barW / 2" :y="H - 8" text-anchor="middle">{{ shortDate(dateOf(b.d)) }}</text>
          </template>
        </g>
      </svg>
      <div v-if="current" class="tip" :style="{ left: `${tipLeft}px` }">
        <strong>{{ shortDate(dateOf(current)) }}</strong>
        <span v-for="k in keys" :key="k.key"><i :style="{ background: k.color }" />{{ k.label }} <b class="figures">{{ format(current[k.key] ?? 0) }}</b></span>
        <span v-if="keys.length > 1" class="total">Total <b class="figures">{{ format(totalOf(current)) }}</b></span>
      </div>
    </div>
    <div v-if="showTable" class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th>Day</th>
            <th v-for="k in keys" :key="k.key" class="num">{{ k.label }}</th>
            <th v-if="keys.length > 1" class="num">Total</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="d in [...series].reverse()" :key="dateOf(d)">
            <td>{{ shortDate(dateOf(d)) }}</td>
            <td v-for="k in keys" :key="k.key" class="num figures">{{ format(d[k.key] ?? 0) }}</td>
            <td v-if="keys.length > 1" class="num figures">{{ format(totalOf(d)) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.chart {
  position: relative;
}
svg {
  display: block;
  outline: none;
}
svg:focus-visible {
  box-shadow: 0 0 0 2px var(--accent);
  border-radius: 6px;
}
.grid line {
  stroke: var(--line);
}
.grid text,
.axis text {
  fill: var(--muted);
  font-size: 11px;
}
.legend {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  align-items: center;
  margin-bottom: 8px;
  font-size: 12.5px;
  color: var(--ink-2, var(--ink));
}
.legend i,
.tip i {
  display: inline-block;
  width: 10px;
  height: 10px;
  margin-right: 6px;
  border-radius: 3px;
  vertical-align: -1px;
}
.push {
  margin-left: auto;
}
.small {
  font-size: 12.5px;
}
.tip {
  position: absolute;
  top: 4px;
  display: grid;
  gap: 3px;
  min-width: 170px;
  padding: 8px 10px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--surface);
  box-shadow: 0 6px 20px rgb(0 0 0 / 0.08);
  font-size: 12.5px;
  pointer-events: none;
}
.tip span {
  display: flex;
  align-items: center;
}
.tip b {
  margin-left: auto;
  padding-left: 10px;
}
.total {
  padding-top: 3px;
  border-top: 1px solid var(--line);
}
</style>
