<script setup>
// The studio credit, as on portfoliyo.live's footer: a full-width band with the Leopard wordmark drawn
// stroke by stroke when it scrolls into view. `compact` fits the narrow sign-in panel.
import { onBeforeUnmount, onMounted, ref } from 'vue'
import Icon from './Icon.vue'

defineProps({ compact: Boolean })

// The wordmark's strokes (viewBox 34 20 808 216), each drawn in turn.
const strokes = [
  'M42 26.5V177q0 4 4 4h101.5',
  'M256.5 156.5A50.7 53 0 1 1 259.1 107.4L166 150.7',
  'M332 74.5a53.5 53 0 1 0 0 106a53.5 53 0 1 0 0-106',
  'M406.5 75.5H409q4.5 0 4.5 4.5V229.5',
  'M413.5 127.5a53 53 0 1 1 106 0a53 53 0 1 1-106 0',
  'M560.5 75H614.5q10 0 10 10V174.5q0 6 6 6',
  'M624.5 138a42.5 42.5 0 1 1-85 0a42.5 42.5 0 1 1 85 0',
  'M657.5 75.5V180.5',
  'M657.5 130A54.5 54.5 0 0 1 712 75.5h1.5',
  'M826.5 127.5a53 53 0 1 1-106 0a53 53 0 1 1 106 0',
  'M826.5 26.5V174.5q0 6 6.5 6',
]

const el = ref(null)
// Drawn from the start where it can't animate (no IntersectionObserver), so the mark never stays blank.
const drawn = ref(typeof IntersectionObserver === 'undefined')
let observer

onMounted(() => {
  if (drawn.value) return
  observer = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) {
      drawn.value = true
      observer.disconnect()
    }
  }, { threshold: 0.4 })
  observer.observe(el.value)
})
onBeforeUnmount(() => observer?.disconnect())
</script>

<template>
  <a
    ref="el"
    class="leopard"
    :class="{ compact, drawn }"
    href="https://iamleopard.com"
    target="_blank"
    rel="noopener"
    title="Leopard — AI & software engineering studio in Dhaka, Bangladesh"
  >
    <span class="label"><span class="pulse" aria-hidden="true"></span>Powered by</span>
    <svg class="mark" viewBox="34 20 808 216" fill="none" stroke="currentColor" stroke-width="8"
         stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="Leopard">
      <path v-for="(d, i) in strokes" :key="i" :d="d" pathLength="1" :style="{ '--i': i }" />
    </svg>
    <span class="meta">
      <span class="what">AI &amp; software engineering studio · Dhaka</span>
      <span class="site">iamleopard.com</span>
    </span>
    <span class="go" aria-hidden="true"><Icon name="arrow" :size="compact ? 18 : 20" /></span>
    <span class="sr-only">(opens in a new tab)</span>
  </a>
</template>

<style scoped>
.leopard {
  --leo-ink: #1a1a17;
  --leo-quiet: #8a8a82;
  --leo-dot: #2563eb;
  position: relative;
  isolation: isolate;
  overflow: hidden;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto auto;
  grid-template-areas: 'label mark meta go';
  align-items: center;
  gap: 16px clamp(20px, 3vw, 48px);
  padding: clamp(24px, 3.5vw, 44px) 0;
  border-block: 1px solid var(--line);
  color: var(--leo-ink);
  text-decoration: none;
  border-radius: 2px;
}
/* A soft light sweeping across on hover. */
.leopard::before {
  content: '';
  position: absolute;
  inset: 0;
  z-index: -1;
  background: linear-gradient(100deg, transparent 20%, rgba(26, 26, 23, 0.05) 50%, transparent 80%);
  transform: translateX(-100%);
  transition: transform 1s ease-out;
}
.leopard:hover::before {
  transform: translateX(100%);
}
.leopard:focus-visible {
  outline: 2px solid var(--leo-dot);
  outline-offset: 4px;
}

.label {
  grid-area: label;
  display: inline-flex;
  align-items: center;
  gap: 10px;
  white-space: nowrap;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--leo-quiet);
  transition: color 0.3s ease;
}
.pulse {
  position: relative;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--leo-dot);
}
.pulse::after {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: 50%;
  background: var(--leo-dot);
  animation: ping 2.4s cubic-bezier(0, 0, 0.2, 1) infinite;
}
@keyframes ping {
  75%, 100% {
    transform: scale(2.2);
    opacity: 0;
  }
}

.mark {
  grid-area: mark;
  justify-self: start;
  display: block;
  height: clamp(40px, 1.2rem + 3vw, 72px);
  width: auto;
  aspect-ratio: 808 / 216;
  overflow: visible;
}
.mark path {
  stroke-dasharray: 1;
  stroke-dashoffset: 1;
  transition: stroke-dashoffset 0.7s cubic-bezier(0.65, 0, 0.35, 1);
  transition-delay: calc(var(--i) * 90ms);
}
.drawn .mark path {
  stroke-dashoffset: 0;
}

.meta {
  grid-area: meta;
  display: grid;
  gap: 4px;
  justify-items: end;
  text-align: right;
}
.what {
  font-size: 15px;
  letter-spacing: -0.01em;
  color: #55554e;
}
.site {
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--leo-quiet);
  transition: color 0.3s ease;
}

.go {
  grid-area: go;
  justify-self: end;
  display: grid;
  place-items: center;
  width: 56px;
  height: 56px;
  border-radius: 50%;
  border: 1px solid #dcdbd5;
  transition: background-color 0.5s, border-color 0.5s, color 0.5s, transform 0.5s;
}

.leopard:hover .label,
.leopard:hover .site,
.leopard:focus-visible .label,
.leopard:focus-visible .site {
  color: var(--leo-ink);
}
.leopard:hover .go,
.leopard:focus-visible .go {
  background: var(--leo-ink);
  border-color: var(--leo-ink);
  color: #fff;
  transform: rotate(45deg);
}

/* Narrow screens: label and arrow on top, the wordmark below, then the studio line. */
@media (max-width: 767px) {
  .leopard {
    grid-template-columns: minmax(0, 1fr) auto;
    grid-template-areas: 'label go' 'mark mark' 'meta meta';
  }
  .mark {
    height: clamp(44px, 12vw, 60px);
  }
  .meta {
    justify-items: start;
    text-align: left;
  }
  .go {
    width: 48px;
    height: 48px;
  }
}

/* The sign-in panel: the same band, smaller. */
.compact {
  grid-template-columns: minmax(0, 1fr) auto;
  grid-template-areas: 'label go' 'mark mark' 'meta meta';
  gap: 12px 20px;
  padding: 20px 0;
}
.compact .mark {
  height: 40px;
}
.compact .meta {
  justify-items: start;
  text-align: left;
}
.compact .what {
  font-size: 13px;
}
.compact .site,
.compact .label {
  font-size: 11px;
}
.compact .go {
  width: 40px;
  height: 40px;
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}

@media (prefers-reduced-motion: reduce) {
  .pulse::after {
    display: none;
  }
  .mark path {
    transition: none;
  }
  .leopard::before {
    display: none;
  }
}
</style>
