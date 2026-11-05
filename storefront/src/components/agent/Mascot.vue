<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'

// Pip, the shopping buddy. Pure SVG + CSS so it scales to any size.
const props = defineProps({
  state: { type: String, default: 'idle' }, // idle | listening | thinking | speaking | happy | sorry | curious
  size: { type: Number, default: 120 },
  track: Boolean, // eyes follow the pointer
})

const root = ref(null)
const look = ref({ x: 0, y: 0 })
const blinking = ref(false)
let blinkTimer

function onMove(e) {
  const r = root.value?.getBoundingClientRect()
  if (!r) return
  const dx = e.clientX - (r.left + r.width / 2)
  const dy = e.clientY - (r.top + r.height / 2)
  const d = Math.hypot(dx, dy) || 1
  const k = Math.min(1, d / 400)
  look.value = { x: (dx / d) * 6 * k, y: (dy / d) * 5 * k }
}

function scheduleBlink() {
  blinkTimer = setTimeout(() => {
    blinking.value = true
    setTimeout(() => (blinking.value = false), 140)
    scheduleBlink()
  }, 2200 + Math.random() * 3200)
}

onMounted(() => {
  scheduleBlink()
  if (props.track) window.addEventListener('pointermove', onMove, { passive: true })
})
onBeforeUnmount(() => {
  clearTimeout(blinkTimer)
  window.removeEventListener('pointermove', onMove)
})

const eyeShift = computed(() => {
  if (props.state === 'thinking') return { x: 5, y: -6 }
  if (props.state === 'sorry') return { x: 0, y: 4 }
  return props.track ? look.value : { x: 0, y: 0 }
})
const happy = computed(() => props.state === 'happy')
</script>

<template>
  <svg
    ref="root"
    class="pip"
    :class="[`s-${state}`, { blinking }]"
    :width="size"
    :height="size"
    viewBox="0 0 200 200"
    role="img"
    :aria-label="`Pip is ${state}`"
  >
    <defs>
      <linearGradient id="pip-head" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#6e95ff" />
        <stop offset="1" stop-color="#1f5bff" />
      </linearGradient>
      <linearGradient id="pip-body" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#3a6dff" />
        <stop offset="1" stop-color="#1846d1" />
      </linearGradient>
      <radialGradient id="pip-glow">
        <stop offset="0" stop-color="#fff6c9" />
        <stop offset="0.5" stop-color="#ffd65a" />
        <stop offset="1" stop-color="#ffb800" stop-opacity="0" />
      </radialGradient>
    </defs>

    <ellipse class="shadow" cx="100" cy="190" rx="44" ry="7" fill="#1f5bff" opacity="0.14" />

    <g class="float">
      <!-- body + arms -->
      <g class="arm arm-l"><ellipse cx="56" cy="166" rx="11" ry="15" fill="url(#pip-body)" /></g>
      <g class="arm arm-r"><ellipse cx="144" cy="166" rx="11" ry="15" fill="url(#pip-body)" /></g>
      <rect x="64" y="146" width="72" height="38" rx="19" fill="url(#pip-body)" />
      <path class="heart" d="M100 176c-6-4-11-8-11-13a5.5 5.5 0 0 1 11-2 5.5 5.5 0 0 1 11 2c0 5-5 9-11 13z" fill="#ff8fb1" />

      <!-- antenna -->
      <g class="antenna">
        <path d="M100 42 V20" stroke="#1f5bff" stroke-width="5" stroke-linecap="round" />
        <circle class="bulb-glow" cx="100" cy="16" r="16" fill="url(#pip-glow)" />
        <circle class="bulb" cx="100" cy="16" r="7.5" fill="#ffd65a" />
      </g>

      <!-- ears -->
      <rect x="18" y="80" width="18" height="38" rx="9" fill="#1846d1" />
      <rect x="164" y="80" width="18" height="38" rx="9" fill="#1846d1" />

      <!-- head -->
      <g class="head">
        <rect x="28" y="38" width="144" height="120" rx="54" fill="url(#pip-head)" />
        <ellipse cx="66" cy="58" rx="22" ry="9" fill="#fff" opacity="0.28" transform="rotate(-18 66 58)" />
        <rect x="44" y="62" width="112" height="78" rx="36" fill="#14214d" />

        <!-- eyes -->
        <g class="eyes" :style="{ transform: `translate(${eyeShift.x}px, ${eyeShift.y}px)` }">
          <template v-if="happy">
            <path d="M68 102 q10 -14 20 0" stroke="#9ff5cf" stroke-width="6" fill="none" stroke-linecap="round" />
            <path d="M112 102 q10 -14 20 0" stroke="#9ff5cf" stroke-width="6" fill="none" stroke-linecap="round" />
          </template>
          <template v-else>
            <g class="eye"><ellipse cx="78" cy="98" rx="10" ry="13" fill="#9ff5cf" /><circle cx="82" cy="93" r="3.5" fill="#fff" /></g>
            <g class="eye"><ellipse cx="122" cy="98" rx="10" ry="13" fill="#9ff5cf" /><circle cx="126" cy="93" r="3.5" fill="#fff" /></g>
          </template>
        </g>

        <!-- cheeks -->
        <ellipse cx="60" cy="120" rx="8" ry="5" fill="#ff8fb1" opacity="0.75" />
        <ellipse cx="140" cy="120" rx="8" ry="5" fill="#ff8fb1" opacity="0.75" />

        <!-- mouth -->
        <ellipse v-if="state === 'speaking'" class="mouth-talk" cx="100" cy="122" rx="9" ry="6" fill="#ff8fb1" />
        <circle v-else-if="state === 'curious' || state === 'listening'" cx="100" cy="123" r="4.5" fill="#ff8fb1" />
        <path v-else-if="state === 'sorry'" d="M91 127 q9 -7 18 0" stroke="#ff8fb1" stroke-width="4" fill="none" stroke-linecap="round" />
        <path v-else d="M90 119 q10 10 20 0" stroke="#ff8fb1" stroke-width="4.5" fill="none" stroke-linecap="round" />
      </g>

      <!-- thinking dots -->
      <g v-if="state === 'thinking'" class="dots">
        <circle cx="160" cy="34" r="5" fill="#1f5bff" />
        <circle cx="174" cy="22" r="4" fill="#1f5bff" />
        <circle cx="186" cy="12" r="3" fill="#1f5bff" />
      </g>
    </g>
  </svg>
</template>

<style scoped>
.pip {
  display: block;
  overflow: visible;
}
.pip * {
  transform-box: fill-box;
  transform-origin: center;
}

.float {
  animation: float 3.2s ease-in-out infinite;
  transform-box: view-box;
}
.shadow {
  animation: shadow 3.2s ease-in-out infinite;
}
@keyframes float {
  50% { transform: translateY(-7px); }
}
@keyframes shadow {
  50% { transform: scaleX(0.82); opacity: 0.09; }
}

.eyes {
  transition: transform 0.18s ease-out;
  transform-box: view-box;
}
.eye {
  transition: transform 0.12s ease;
}
.blinking .eye {
  transform: scaleY(0.1);
}

.bulb-glow {
  opacity: 0.55;
  animation: glow 2.4s ease-in-out infinite;
}
@keyframes glow {
  50% { opacity: 1; transform: scale(1.15); }
}

/* States */
.s-listening .bulb {
  fill: #9ff5cf;
}
.s-listening .bulb-glow {
  animation-duration: 0.8s;
}
.s-listening .eye {
  transform: scale(1.12);
}
.s-listening .head {
  animation: tilt 2.4s ease-in-out infinite;
}
@keyframes tilt {
  50% { transform: rotate(-4deg); }
}

.s-thinking .head {
  animation: wobble 1.4s ease-in-out infinite;
}
@keyframes wobble {
  25% { transform: rotate(3deg); }
  75% { transform: rotate(-3deg); }
}
.dots circle {
  animation: dot 1.2s ease-in-out infinite;
}
.dots circle:nth-child(2) { animation-delay: 0.15s; }
.dots circle:nth-child(3) { animation-delay: 0.3s; }
@keyframes dot {
  0%, 100% { opacity: 0.2; }
  50% { opacity: 1; }
}

.mouth-talk {
  animation: talk 0.28s ease-in-out infinite alternate;
}
@keyframes talk {
  from { transform: scaleY(0.35); }
  to { transform: scaleY(1.2); }
}
.s-speaking .antenna {
  animation: bop 0.56s ease-in-out infinite;
  transform-box: view-box;
}
@keyframes bop {
  50% { transform: translateY(-2px); }
}

.s-happy .float {
  animation: hop 0.7s ease-in-out 2, float 3.2s ease-in-out 1.4s infinite;
}
@keyframes hop {
  40% { transform: translateY(-16px); }
}
.s-happy .arm-r {
  animation: wave 0.45s ease-in-out 4;
  transform-origin: 30% 90%;
}
@keyframes wave {
  50% { transform: rotate(-35deg) translate(4px, -6px); }
}
.s-happy .heart {
  animation: beat 0.6s ease-in-out 3;
}
@keyframes beat {
  50% { transform: scale(1.3); }
}

.s-sorry .head {
  transform: rotate(-6deg) translateY(3px);
  transition: transform 0.3s ease;
}

.s-curious .head {
  transform: rotate(6deg);
  transition: transform 0.3s ease;
}

@media (prefers-reduced-motion: reduce) {
  .pip *,
  .float,
  .shadow {
    animation: none !important;
  }
}
</style>
