<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import Icon from '../Icon.vue'
import { useTryOn } from '../../tryon/useTryOn.js'

const props = defineProps({ interactive: Boolean, compare: Boolean })
const { state, persist, markCustom, aiReady, aiImage, retry, setMode } = useTryOn()

// AI try-on: the photo itself is re-rendered wearing the look, so there's nothing to drag.
// `compare` shows the original photo (press and hold in the studio).
const ai = computed(() => aiReady.value)
const shown = computed(() => (props.compare || !ai.value ? state.photo : aiImage.value ?? state.photo))
const rendering = computed(() => ai.value && state.ai.status === 'rendering' && !props.compare)
const now = ref(Date.now())
let clock
watch(
  () => state.ai.status,
  (s) => {
    clearInterval(clock)
    if (s === 'rendering') clock = setInterval(() => (now.value = Date.now()), 400)
  },
  { immediate: true },
)
// An honest-ish progress bar: each item usually takes 10–20 seconds.
const progress = computed(() => Math.min(0.94, Math.max(0.04, (now.value - state.ai.started) / (Math.max(1, state.ai.steps) * 15000))))

// After Pip fits something: glow on that item and a short hint to fine-tune.
const glowUid = ref(null)
const hint = ref(null)
let hintTimer
watch(
  () => state.fitted,
  (f) => {
    if (!f || !props.interactive) return
    glowUid.value = f.uid
    hint.value = f.name
    clearTimeout(hintTimer)
    setTimeout(() => (glowUid.value = null), 1400)
    hintTimer = setTimeout(() => (hint.value = null), 4500)
  },
)

const frame = ref(null)
const fit = ref({ w: 0, h: 0 })
let ro

// Fit the photo inside the frame, preserving its aspect ratio.
function measure() {
  const el = frame.value
  if (!el || !state.size) return
  const k = Math.min(el.clientWidth / state.size.w, el.clientHeight / state.size.h)
  fit.value = { w: state.size.w * k, h: state.size.h * k }
}
onMounted(() => {
  ro = new ResizeObserver(measure)
  ro.observe(frame.value)
  measure()
})
onBeforeUnmount(() => {
  ro?.disconnect()
  clearInterval(clock)
})

const scale = computed(() => (state.size ? fit.value.w / state.size.w : 1))
const style = (l) => ({
  left: `${(l.box.cx - l.box.w / 2) * scale.value}px`,
  top: `${(l.box.cy - l.box.h / 2) * scale.value}px`,
  width: `${l.box.w * scale.value}px`,
  height: `${l.box.h * scale.value}px`,
  transform: `rotate(${l.box.rot}deg)`,
  opacity: l.hidden ? 0 : l.opacity,
})

// Drag to move, corner handle to resize, top handle to rotate.
let drag = null
function start(e, layer, mode = 'move') {
  if (!props.interactive || ai.value) return
  e.preventDefault()
  e.stopPropagation()
  state.selected = layer.uid
  const rect = frame.value.querySelector('.photo-box').getBoundingClientRect()
  drag = { mode, layer, x: e.clientX, y: e.clientY, box: { ...layer.box }, rect, moved: false }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', end, { once: true })
}
function move(e) {
  if (!drag) return
  const { layer, box, mode, rect } = drag
  const dx = (e.clientX - drag.x) / scale.value
  const dy = (e.clientY - drag.y) / scale.value
  if (Math.abs(dx) + Math.abs(dy) > 1) drag.moved = true
  if (mode === 'move') {
    layer.box = { ...box, cx: box.cx + dx, cy: box.cy + dy }
  } else if (mode === 'resize') {
    const k = Math.max(0.25, 1 + (dx + dy) / (box.w + box.h))
    layer.box = { ...box, w: box.w * k, h: box.h * k }
  } else if (mode === 'rotate') {
    const cx = rect.left + box.cx * scale.value
    const cy = rect.top + box.cy * scale.value
    const deg = (Math.atan2(e.clientY - cy, e.clientX - cx) * 180) / Math.PI + 90
    layer.box = { ...box, rot: Math.round(((deg + 540) % 360) - 180) }
  }
}
function end() {
  window.removeEventListener('pointermove', move)
  if (drag?.moved) markCustom(drag.layer)
  else persist()
  drag = null
}
function wheel(e, layer) {
  if (!props.interactive) return
  e.preventDefault()
  const k = e.deltaY < 0 ? 1.04 : 0.96
  layer.box = { ...layer.box, w: layer.box.w * k, h: layer.box.h * k }
  state.selected = layer.uid
  markCustom(layer)
}
function deselect(e) {
  if (props.interactive && e.target.classList.contains('photo')) state.selected = null
}
</script>

<template>
  <div ref="frame" class="frame">
    <div v-if="state.photo" class="photo-box" :style="{ width: `${fit.w}px`, height: `${fit.h}px` }" @pointerdown="deselect">
      <img class="photo" :class="{ dim: rendering }" :src="shown" :alt="ai && aiImage && !compare ? 'You, wearing your look' : 'Your photo'" draggable="false" @load="measure" />
      <template v-if="!ai">
        <div
          v-for="l in state.layers.filter((x) => x.src)"
          :key="l.uid"
          class="layer"
          :class="{ selected: interactive && state.selected === l.uid, interactive, glow: glowUid === l.uid || (glowUid === null && hint && state.fitted?.uid === null) }"
          :style="style(l)"
          @pointerdown="start($event, l)"
          @wheel="wheel($event, l)"
        >
          <img :src="l.src" alt="" draggable="false" />
          <template v-if="interactive && state.selected === l.uid">
            <span class="handle rotate" title="Rotate" @pointerdown="start($event, l, 'rotate')" />
            <span class="handle resize" title="Resize" @pointerdown="start($event, l, 'resize')" />
          </template>
        </div>
      </template>
      <div v-if="state.status === 'detecting' || (state.status === 'working' && !ai) || rendering" class="scan" aria-hidden="true" />
      <div v-if="state.status === 'working' && !ai" class="working"><span />Pip is fitting it to your body…</div>
      <div v-if="rendering" class="rendering" :class="{ small: !interactive }" role="status">
        <span class="spin" />
        <div>
          <b>Pip is dressing you…</b>
          <small v-if="interactive">{{ state.ai.steps }} item{{ state.ai.steps === 1 ? '' : 's' }} · usually 10–30 seconds</small>
          <i class="bar"><i :style="{ width: `${progress * 100}%` }" /></i>
        </div>
      </div>
      <div v-if="ai && state.ai.status === 'error' && interactive" class="ai-error" role="alert">
        <Icon name="alert" :size="16" />
        <p>{{ state.ai.error }}</p>
        <div>
          <button class="btn-primary sm" @click="retry()">Try again</button>
          <button class="btn-secondary sm" @click="setMode('preview')">Use quick preview</button>
        </div>
      </div>
      <span v-if="compare" class="badge">Your original photo</span>
      <span v-else-if="ai && aiImage && !rendering && interactive" class="badge ai"><Icon name="sparkle" :size="12" />AI try-on</span>
      <Transition name="hint">
        <div v-if="interactive && !ai && hint && state.status !== 'working'" class="fitted">
          <Icon name="sparkle" :size="14" />
          <span><b>Fitted by Pip</b> {{ hint }} · drag, resize or use the controls to fine-tune</span>
        </div>
      </Transition>
    </div>
  </div>
</template>

<style scoped>
.frame {
  position: relative;
  display: grid;
  place-items: center;
  width: 100%;
  height: 100%;
  min-height: 0;
}
.photo-box {
  position: relative;
  border-radius: 24px;
  overflow: hidden;
  touch-action: none;
  box-shadow: 0 20px 50px -24px rgba(20, 33, 77, 0.45);
}
.photo {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
  user-select: none;
}
.layer {
  position: absolute;
  transform-origin: center;
  transition: opacity 0.2s ease;
  pointer-events: none;
}
.layer.interactive {
  pointer-events: auto;
  cursor: grab;
}
.layer.interactive:active {
  cursor: grabbing;
}
.layer img {
  width: 100%;
  height: 100%;
  object-fit: fill;
  user-select: none;
  pointer-events: none;
  filter: drop-shadow(0 6px 10px rgba(0, 0, 0, 0.22));
}
.layer.selected {
  outline: 2px dashed rgba(31, 91, 255, 0.85);
  outline-offset: 2px;
}
.handle {
  position: absolute;
  width: 18px;
  height: 18px;
  border: 3px solid #fff;
  border-radius: 50%;
  background: var(--blue);
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.3);
}
.rotate {
  top: -30px;
  left: 50%;
  margin-left: -9px;
  cursor: grab;
}
.rotate::after {
  content: '';
  position: absolute;
  top: 15px;
  left: 50%;
  width: 2px;
  height: 14px;
  margin-left: -1px;
  background: var(--blue);
}
.resize {
  right: -10px;
  bottom: -10px;
  cursor: nwse-resize;
}
.layer.glow img {
  animation: glow 1.4s ease-out;
}
@keyframes glow {
  0% { filter: drop-shadow(0 0 0 rgba(31, 91, 255, 0)) brightness(1.4); opacity: 0.2; transform: scale(0.94); }
  40% { filter: drop-shadow(0 0 18px rgba(159, 245, 207, 0.95)) brightness(1.1); opacity: 1; transform: scale(1.02); }
  100% { filter: drop-shadow(0 6px 10px rgba(0, 0, 0, 0.22)); transform: scale(1); }
}
.scan {
  position: absolute;
  inset: 0;
  background: linear-gradient(180deg, transparent 0%, rgba(159, 245, 207, 0) 40%, rgba(159, 245, 207, 0.55) 50%, rgba(159, 245, 207, 0) 60%, transparent 100%);
  background-size: 100% 220%;
  animation: scan 1.3s linear infinite;
  pointer-events: none;
  mix-blend-mode: screen;
}
@keyframes scan {
  from { background-position: 0 100%; }
  to { background-position: 0 -120%; }
}
.fitted {
  position: absolute;
  left: 50%;
  bottom: 14px;
  display: flex;
  align-items: center;
  gap: 8px;
  max-width: calc(100% - 24px);
  padding: 9px 14px;
  border-radius: 16px;
  background: rgba(255, 255, 255, 0.94);
  color: var(--ink);
  font-size: 12.5px;
  line-height: 1.35;
  box-shadow: 0 10px 24px -12px rgba(20, 33, 77, 0.45);
  transform: translateX(-50%);
  pointer-events: none;
}
.fitted svg {
  flex-shrink: 0;
  color: var(--blue);
}
.fitted b {
  color: var(--blue);
  font-weight: 600;
}
.hint-enter-active,
.hint-leave-active {
  transition: all 0.3s ease;
}
.hint-enter-from,
.hint-leave-to {
  opacity: 0;
  transform: translate(-50%, 8px);
}
.working {
  position: absolute;
  left: 50%;
  bottom: 14px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  border-radius: var(--r-pill);
  background: rgba(18, 20, 23, 0.8);
  color: #fff;
  font-size: 12px;
  transform: translateX(-50%);
}
.photo.dim {
  filter: saturate(0.85) brightness(0.96);
  transition: filter 0.3s ease;
}
.rendering {
  position: absolute;
  left: 50%;
  bottom: 14px;
  display: flex;
  align-items: center;
  gap: 10px;
  width: min(320px, calc(100% - 24px));
  padding: 10px 14px;
  border-radius: 16px;
  background: rgba(18, 20, 23, 0.82);
  color: #fff;
  transform: translateX(-50%);
  backdrop-filter: blur(6px);
}
.rendering div {
  display: grid;
  gap: 3px;
  flex: 1;
  min-width: 0;
}
.rendering b {
  font-size: 13px;
  font-weight: 600;
}
.rendering small {
  font-size: 11.5px;
  opacity: 0.8;
}
.rendering.small {
  bottom: 8px;
  padding: 6px 10px;
  gap: 8px;
}
.rendering.small b {
  font-size: 11px;
}
.bar {
  display: block;
  height: 4px;
  margin-top: 3px;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.2);
  overflow: hidden;
}
.bar i {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--mint);
  transition: width 0.4s linear;
}
.spin,
.working span {
  width: 12px;
  height: 12px;
  border: 2px solid rgba(255, 255, 255, 0.4);
  border-top-color: #fff;
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
}
.spin {
  flex-shrink: 0;
  width: 16px;
  height: 16px;
  border: 2px solid rgba(255, 255, 255, 0.35);
  border-top-color: #fff;
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
}
.ai-error {
  position: absolute;
  left: 50%;
  bottom: 14px;
  display: grid;
  justify-items: center;
  gap: 8px;
  width: min(340px, calc(100% - 24px));
  padding: 14px 16px;
  border-radius: 16px;
  background: rgba(255, 255, 255, 0.96);
  color: var(--ink);
  text-align: center;
  font-size: 13px;
  box-shadow: 0 10px 24px -12px rgba(20, 33, 77, 0.45);
  transform: translateX(-50%);
}
.ai-error svg {
  color: var(--danger, #d64545);
}
.ai-error div {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 8px;
}
.badge {
  position: absolute;
  top: 12px;
  left: 12px;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 10px;
  border-radius: var(--r-pill);
  background: rgba(18, 20, 23, 0.72);
  color: #fff;
  font-size: 11.5px;
  font-weight: 600;
  pointer-events: none;
}
.badge.ai {
  background: rgba(255, 255, 255, 0.92);
  color: var(--blue);
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
