<script setup>
import { ref, computed, watch, onBeforeUnmount, nextTick } from 'vue'
import { useRouter } from 'vue-router'
import TryOnCanvas from './TryOnCanvas.vue'
import Mascot from '../agent/Mascot.vue'
import Icon from '../Icon.vue'
import { useTryOn } from '../../tryon/useTryOn.js'
import { specFor, isWearable, SLOT_LABEL } from '../../tryon/specs.js'
import { money } from '../../data.js'
import { products, productById } from '../../catalog.js'
import { useShop } from '../../store.js'
import { caps } from '../../capabilities.js'

import ShareLook from '../ShareLook.vue'
const router = useRouter()
const tryon = useTryOn()
const { state, selectedLayer, aiMode, aiReady, aiImage } = tryon
const shop = useShop()

const fileInput = ref(null)
const consentBox = ref(null)
const dragOver = ref(false)
const comparing = ref(false)

/* ---------- photo input ---------- */
// AI try-on sends the shopper's own photo to the try-on service, so they agree first.
// Sample models need no agreement, and quick preview never leaves the device.
const needsConsent = computed(() => aiMode.value && !state.consent)
function blocked() {
  if (!needsConsent.value) return false
  state.message = 'Tick the box above to use AI try-on with your photo, or switch to quick preview.'
  consentBox.value?.focus()
  return true
}
function pickFile() {
  if (blocked()) return
  fileInput.value?.click()
}
function readFile(file) {
  if (blocked()) return
  if (!file || !file.type.startsWith('image/')) {
    state.message = 'Please choose an image file (JPG or PNG).'
    return
  }
  const reader = new FileReader()
  reader.onload = () => tryon.setPhoto(reader.result)
  reader.readAsDataURL(file)
}
function onFile(e) {
  readFile(e.target.files?.[0])
  e.target.value = ''
}
function onDrop(e) {
  dragOver.value = false
  readFile(e.dataTransfer.files?.[0])
}

/* ---------- camera ---------- */
const camera = ref(false)
const video = ref(null)
const countdown = ref(0)
let stream = null
async function openCamera() {
  if (blocked()) return
  state.message = ''
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 1920 } } })
    camera.value = true
    await nextTick()
    video.value.srcObject = stream
  } catch {
    state.message = 'I couldn’t open your camera. Allow camera access, or upload a photo instead.'
  }
}
function stopCamera() {
  stream?.getTracks().forEach((t) => t.stop())
  stream = null
  camera.value = false
  countdown.value = 0
}
function capture() {
  countdown.value = 3
  const tick = setInterval(() => {
    countdown.value--
    if (countdown.value > 0) return
    clearInterval(tick)
    const v = video.value
    const c = document.createElement('canvas')
    c.width = v.videoWidth
    c.height = v.videoHeight
    const ctx = c.getContext('2d')
    ctx.translate(c.width, 0)
    ctx.scale(-1, 1) // un-mirror the selfie preview
    ctx.drawImage(v, 0, 0)
    stopCamera()
    tryon.setPhoto(c.toDataURL('image/jpeg', 0.9))
  }, 1000)
}
onBeforeUnmount(stopCamera)
watch(
  () => state.view,
  (v) => {
    if (v !== 'full') stopCamera()
  },
)

/* ---------- studio ---------- */
const pendingItems = computed(() => state.pending.map(productById).filter(Boolean))
const suggestions = computed(() => {
  const worn = new Set(state.layers.map((l) => l.slot))
  const wornIds = new Set(state.layers.map((l) => l.id))
  return products
    .filter((p) => isWearable(p.id) && !wornIds.has(p.id) && !worn.has(specFor(p.id).slot))
    .sort((a, b) => b.popularity - a.popularity)
    .slice(0, 8)
})
// Sliders are relative to Pip's fit (100% = exactly what Pip chose).
const pct = (key) =>
  computed({
    get: () => {
      const l = selectedLayer.value
      return l ? Math.round((l.box[key] / l.auto[key]) * 100) : 100
    },
    set: (v) => {
      const l = selectedLayer.value
      l.box = { ...l.box, [key]: (l.auto[key] * v) / 100 }
      tryon.markCustom(l)
    },
  })
const widthPct = pct('w')
const lengthPct = pct('h')
const sizePct = computed({
  get: () => Math.round(Math.sqrt(widthPct.value * lengthPct.value)),
  set: (v) => {
    const l = selectedLayer.value
    const k = v / sizePct.value
    l.box = { ...l.box, w: l.box.w * k, h: l.box.h * k }
    tryon.markCustom(l)
  },
})
const rot = computed({
  get: () => Math.round(selectedLayer.value?.box.rot ?? 0),
  set: (v) => {
    const l = selectedLayer.value
    l.box = { ...l.box, rot: v }
    tryon.markCustom(l)
  },
})
const opacity = computed({
  get: () => selectedLayer.value?.opacity ?? 1,
  set: (v) => {
    selectedLayer.value.opacity = v
    tryon.markCustom(selectedLayer.value)
  },
})
function nudge(axis, amount) {
  const l = selectedLayer.value
  if (!l) return
  const step = state.size.w * 0.01 * amount
  l.box = { ...l.box, [axis]: l.box[axis] + step }
  tryon.markCustom(l)
}

/* ---------- styling (AI try-on) ---------- */
// The AI shows each item at its true size and cut; styling changes how it's worn.
const STYLES = {
  top: [['Tucked in', 'tuck the top in'], ['Untucked', 'wear the top untucked'], ['Sleeves rolled up', 'roll up the sleeves']],
  outer: [['Worn open', 'wear it open'], ['Done up', 'wear it zipped or buttoned up'], ['Sleeves pushed up', 'push the sleeves up']],
  dress: [['Belt cinched', 'cinch the belt at the waist']],
  bottom: [['Cuffed hem', 'cuff the hem'], ['High-waisted', 'wear it high on the waist']],
  eyes: [['Pushed up', 'wear the glasses pushed up on the head']],
  head: [['Worn backwards', 'wear the cap backwards']],
  ears: [['Around the neck', 'wear the headphones around the neck']],
  hand: [['Over the shoulder', 'carry the bag over the shoulder'], ['In hand', 'hold the bag in the hand']],
  feet: [],
  wrist: [],
}
const styleText = ref('')
const noteFor = (l) => (l ? state.notes[l.id] ?? '' : '')
watch(selectedLayer, (l) => (styleText.value = noteFor(l)), { immediate: true })
function applyStyle(prompt) {
  const l = selectedLayer.value
  tryon.restyle(l.id, noteFor(l) === prompt ? '' : prompt)
  styleText.value = noteFor(l)
}
function submitStyle() {
  tryon.restyle(selectedLayer.value.id, styleText.value)
}
const photoIssues = computed(() => state.check?.tips.filter((t) => !t.ok) ?? [])

function addLook() {
  shop.addAllToCart(tryon.lookItems.value)
}
async function save() {
  const url = await tryon.snapshot()
  const a = document.createElement('a')
  a.href = url
  a.download = `my-cartly-look.${url.startsWith('data:image/jpeg') ? 'jpg' : 'png'}`
  a.click()
}
/* ---------- Ask family ---------- */
const asking = ref(false)
const shareItems = computed(() => [...new Set(state.layers.filter((l) => !l.hidden).map((l) => l.id))].map((productId) => ({ productId })))
// Only a real photo of the look is worth sharing; the shopper still chooses whether to include it.
const shareImage = computed(() => (state.photo ? () => tryon.snapshot() : null))

function view(id) {
  state.view = 'mini'
  router.push(`/product/${id}`)
}
function close() {
  state.view = 'closed'
}
function onKey(e) {
  if (e.key === 'Escape' && state.view === 'full') state.view = state.layers.length ? 'mini' : 'closed'
  if ((e.key === 'Delete' || e.key === 'Backspace') && state.view === 'full' && selectedLayer.value && e.target === document.body)
    tryon.remove(selectedLayer.value.uid)
}
watch(
  () => state.view,
  (v) => {
    if (v === 'full') document.addEventListener('keydown', onKey)
    else document.removeEventListener('keydown', onKey)
  },
  { immediate: true },
)
onBeforeUnmount(() => document.removeEventListener('keydown', onKey))
</script>

<template>
  <Teleport to="body">
    <!-- Full studio -->
    <Transition name="studio">
      <div v-if="state.view === 'full'" class="studio" role="dialog" aria-modal="true" aria-label="Virtual fitting room">
        <header class="bar">
          <div class="brand"><Icon name="sparkle" :size="18" /><b>Fitting room</b><span>with Pip</span></div>
          <div class="bar-acts">
            <button v-if="state.photo" class="tbtn" @click="tryon.changePhoto()"><Icon name="refresh" :size="15" />Change photo</button>
            <button v-if="state.photo && state.layers.length" class="tbtn" @click="state.view = 'mini'"><Icon name="minus" :size="15" />Keep shopping</button>
            <button class="tbtn icon" aria-label="Close fitting room" @click="close"><Icon name="close" :size="18" /></button>
          </div>
        </header>

        <!-- Step 1: ask for a photo -->
        <div v-if="!state.photo" class="setup">
          <section class="ask">
            <Mascot :state="state.status === 'detecting' ? 'thinking' : 'happy'" :size="130" track />
            <h1>Let’s see it on you!</h1>
            <p v-if="aiMode">Share a <b>full-length photo</b> and I’ll use AI to show you <b>really wearing</b> the pieces you pick, with the fabric, fit and lighting on your body.</p>
            <p v-else>Share a <b>full-length photo</b> and I’ll dress you in the pieces you pick. You can keep adding more while you shop.</p>
            <ul class="tips">
              <li><Icon name="check" :size="15" />Head to toe in the frame, facing the camera</li>
              <li><Icon name="check" :size="15" />Arms slightly away from your body</li>
              <li><Icon name="check" :size="15" />Fitted clothes, with no bag or hair covering your outfit</li>
              <li><Icon name="check" :size="15" />Just you, in good, even light</li>
            </ul>
            <div v-if="pendingItems.length" class="queued">
              <span>Ready to try on:</span>
              <img v-for="p in pendingItems" :key="p.id" :src="p.image" :alt="p.name" :title="p.name" />
            </div>
          </section>

          <section class="inputs">
            <label v-if="aiMode" class="consent" :class="{ on: state.consent }">
              <input ref="consentBox" type="checkbox" :checked="state.consent" @change="tryon.setConsent($event.target.checked); state.message = ''" />
              <span>
                <b>Use AI try-on with my photo.</b> It’s sent securely to our try-on partner to create your look, then deleted. It’s never stored
                or used to train AI. Only use a photo of yourself, or of someone who agreed.
              </span>
            </label>
            <div v-if="camera" class="cam">
              <video ref="video" autoplay playsinline muted />
              <div class="guide" aria-hidden="true" />
              <span v-if="countdown" class="count">{{ countdown }}</span>
              <div class="cam-acts">
                <button class="btn-secondary sm" @click="stopCamera">Cancel</button>
                <button class="btn-primary sm" :disabled="countdown > 0" @click="capture">Take photo in 3s</button>
              </div>
            </div>

            <template v-else>
              <div
                class="drop"
                :class="{ over: dragOver, busy: state.status === 'detecting', locked: needsConsent }"
                role="button"
                tabindex="0"
                @click="pickFile"
                @keydown.enter="pickFile"
                @dragover.prevent="dragOver = true"
                @dragleave="dragOver = false"
                @drop.prevent="onDrop"
              >
                <template v-if="state.status === 'detecting'">
                  <span class="spinner dark" />
                  <b>Finding your shoulders, hips and feet…</b>
                  <small>This runs on your device.</small>
                </template>
                <template v-else>
                  <span class="drop-icon"><Icon name="plus" :size="26" /></span>
                  <b>Upload a full-length photo</b>
                  <small>Drag it here or click to browse · JPG or PNG</small>
                </template>
              </div>
              <input ref="fileInput" type="file" accept="image/*" hidden @change="onFile" />

              <button class="btn-secondary cam-btn" :disabled="state.status === 'detecting'" @click="openCamera">
                <Icon name="user" :size="18" />Take a photo with my camera
              </button>

              <div class="samples">
                <span>No photo handy? Try a sample model</span>
                <div class="sample-row">
                  <button v-for="m in tryon.samples" :key="m.id" class="sample" :disabled="state.status === 'detecting'" @click="tryon.useSample(m)">
                    <img :src="`https://images.unsplash.com/photo-${m.photo}?w=200&h=300&fit=crop`" :alt="m.label" />
                    <small>{{ m.label }}</small>
                  </button>
                </div>
              </div>
            </template>

            <p v-if="state.message" class="msg"><Icon name="alert" :size="15" />{{ state.message }}</p>
            <p class="privacy">
              <Icon name="lock" :size="14" />
              <template v-if="aiMode">Sample models work without sharing a photo.</template>
              <template v-else>Quick preview: your photo stays on this device. It’s never uploaded.</template>
              <button v-if="caps.tryon" class="link small" @click="tryon.setMode(aiMode ? 'preview' : 'ai'); state.message = ''">
                {{ aiMode ? 'Prefer quick preview?' : 'Switch to AI try-on' }}
              </button>
            </p>
          </section>
        </div>

        <!-- Step 2: the studio -->
        <div v-else class="work">
          <section class="canvas-area" :class="{ 'has-mode': caps.tryon }">
            <div v-if="caps.tryon" class="mode" role="group" aria-label="Try-on mode">
              <button :class="{ on: aiMode }" :aria-pressed="aiMode" @click="tryon.setMode('ai')"><Icon name="sparkle" :size="14" />AI try-on</button>
              <button :class="{ on: !aiMode }" :aria-pressed="!aiMode" @click="tryon.setMode('preview')">Quick preview</button>
            </div>
            <TryOnCanvas interactive :compare="comparing" />
            <p v-if="!aiMode && state.poseSource === 'detected' && !state.message" class="pose-ok"><Icon name="check" :size="14" />Body detected. Items are fitted to you.</p>
            <p v-if="state.message" class="msg floating"><Icon name="alert" :size="15" />{{ state.message }}</p>
            <div v-if="aiMode && !aiReady && state.photo" class="consent floating">
              <label>
                <input type="checkbox" :checked="state.consent" @change="tryon.setConsent($event.target.checked)" />
                <span><b>Dress my photo with AI.</b> It’s sent securely to our try-on partner, then deleted. Never stored or used to train AI.</span>
              </label>
            </div>
            <button
              v-if="aiReady && aiImage && state.ai.status !== 'rendering'"
              class="compare"
              @pointerdown="comparing = true"
              @pointerup="comparing = false"
              @pointerleave="comparing = false"
              @pointercancel="comparing = false"
              @keydown.space.prevent="comparing = true"
              @keyup.space="comparing = false"
            >
              <Icon name="eye" :size="15" />Hold to see your original
            </button>
            <p v-if="!state.layers.length" class="empty-hint">Pick something on the right, or ask Pip: “try on a red dress”.</p>
          </section>

          <aside class="side">
            <section v-if="photoIssues.length" class="panel photo-check">
              <div class="panel-head"><h2>Your photo</h2><button class="link small" @click="tryon.changePhoto()">Change photo</button></div>
              <ul>
                <li v-for="t in photoIssues" :key="t.text"><Icon name="alert" :size="14" />{{ t.text }}</li>
              </ul>
            </section>

            <section class="panel">
              <div class="panel-head">
                <h2>On you</h2>
                <button v-if="!aiMode && state.layers.some((l) => l.fit === 'custom')" class="link small" @click="tryon.refitAll()"><Icon name="sparkle" :size="13" />Re-fit all with Pip</button>
                <span v-else>{{ state.layers.length }} item{{ state.layers.length === 1 ? '' : 's' }}</span>
              </div>
              <p v-if="!state.layers.length" class="muted small">Nothing yet.</p>
              <ul class="layers">
                <li
                  v-for="l in [...state.layers].reverse()"
                  :key="l.uid"
                  :class="{ on: state.selected === l.uid }"
                  @click="state.selected = l.uid"
                >
                  <img :src="productById(l.id).image" alt="" />
                  <div class="l-text">
                    <b>{{ productById(l.id).name }}</b>
                    <small>
                      {{ SLOT_LABEL[l.slot] }} · {{ money(productById(l.id).price) }}
                      <em v-if="aiMode" class="fit-badge" :class="{ custom: state.notes[l.id] }">{{ state.notes[l.id] ? `Styled: ${state.notes[l.id]}` : '✨ AI fit' }}</em>
                      <em v-else-if="!l.src" class="fit-badge ai-only">Shows in AI try-on</em>
                      <em v-else class="fit-badge" :class="l.fit">{{ l.fit === 'custom' ? 'Adjusted by you' : '✨ Pip fit' }}</em>
                    </small>
                  </div>
                  <button class="mini-btn" :aria-label="l.hidden ? 'Show' : 'Hide'" :title="l.hidden ? 'Show' : 'Hide'" @click.stop="tryon.toggleHidden(l)">
                    <Icon :name="l.hidden ? 'eyeOff' : 'eye'" :size="15" />
                  </button>
                  <button class="mini-btn" aria-label="Take off" title="Take off" @click.stop="tryon.remove(l.uid)"><Icon name="close" :size="15" /></button>
                </li>
              </ul>
            </section>

            <section v-if="aiMode && selectedLayer" class="panel adjust">
              <div class="panel-head">
                <h2>Style it</h2>
                <button class="reset" :disabled="state.ai.status === 'rendering' || !aiReady" @click="tryon.anotherTake()"><Icon name="refresh" :size="13" />Another take</button>
              </div>
              <p class="fit-note">
                The AI shows the {{ productById(selectedLayer.id).name }} at its real size and cut. Choose how you’d wear it:
              </p>
              <div v-if="STYLES[selectedLayer.slot]?.length" class="style-chips">
                <button
                  v-for="c in STYLES[selectedLayer.slot]"
                  :key="c[1]"
                  :class="{ on: state.notes[selectedLayer.id] === c[1] }"
                  :disabled="!aiReady"
                  @click="applyStyle(c[1])"
                >
                  {{ c[0] }}
                </button>
              </div>
              <form class="style-form" @submit.prevent="submitStyle">
                <label class="sr-only" for="style-text">How to wear it</label>
                <input id="style-text" v-model="styleText" maxlength="120" placeholder="e.g. sleeves pushed up" :disabled="!aiReady" />
                <button class="btn-primary sm" :disabled="!aiReady || styleText.trim() === noteFor(selectedLayer)">Apply</button>
              </form>
              <small class="muted">Or just tell Pip, like “tuck it in” or “wear the jacket open”.</small>
            </section>

            <section v-else-if="selectedLayer?.src" class="panel adjust">
              <div class="panel-head">
                <h2>Fine-tune</h2>
                <button class="reset" :disabled="selectedLayer.fit === 'pip'" @click="tryon.refit(selectedLayer)">
                  <Icon name="sparkle" :size="13" />{{ selectedLayer.fit === 'pip' ? 'Fitted by Pip' : 'Reset to Pip’s fit' }}
                </button>
              </div>
              <p class="fit-note">
                {{ selectedLayer.fit === 'pip'
                  ? 'Pip sized and placed this to your body. Adjust anything that doesn’t look right.'
                  : 'You’ve adjusted Pip’s fit. 100% on each slider means exactly what Pip chose.' }}
              </p>
              <label class="slider"><span>Size</span><input v-model.number="sizePct" type="range" min="40" max="180" /><em>{{ sizePct }}%</em></label>
              <label class="slider"><span>Width</span><input v-model.number="widthPct" type="range" min="50" max="170" /><em>{{ widthPct }}%</em></label>
              <label class="slider"><span>Length</span><input v-model.number="lengthPct" type="range" min="50" max="170" /><em>{{ lengthPct }}%</em></label>
              <label class="slider"><span>Rotate</span><input v-model.number="rot" type="range" min="-45" max="45" /><em>{{ rot }}°</em></label>
              <label class="slider"><span>Opacity</span><input v-model.number="opacity" type="range" min="0.3" max="1" step="0.05" /><em>{{ Math.round(opacity * 100) }}%</em></label>
              <div class="nudges">
                <span>Move</span>
                <button aria-label="Move left" @click="nudge('cx', -1)"><Icon name="chevronLeft" :size="16" /></button>
                <button aria-label="Move up" @click="nudge('cy', -1)"><Icon name="chevronLeft" :size="16" style="transform: rotate(90deg)" /></button>
                <button aria-label="Move down" @click="nudge('cy', 1)"><Icon name="chevronRight" :size="16" style="transform: rotate(90deg)" /></button>
                <button aria-label="Move right" @click="nudge('cx', 1)"><Icon name="chevronRight" :size="16" /></button>
              </div>
              <small class="muted">Tip: drag the item on the photo, use the corner dot to resize and the top dot to rotate.</small>
            </section>

            <section class="panel">
              <div class="panel-head"><h2>Complete the look</h2></div>
              <div class="suggest">
                <div v-for="p in suggestions" :key="p.id" class="s-card">
                  <img :src="p.image" :alt="p.name" @click="view(p.id)" />
                  <b :title="p.name">{{ p.name }}</b>
                  <small>{{ SLOT_LABEL[specFor(p.id).slot] }} · {{ money(p.price) }}</small>
                  <button class="try" :disabled="state.status === 'working'" @click="tryon.tryOn(p.id)"><Icon name="sparkle" :size="13" />Try on</button>
                </div>
              </div>
            </section>

            <footer class="look">
              <div><span>Your look</span><b>{{ money(tryon.lookTotal.value) }}</b></div>
              <div class="look-acts">
                <button class="btn-secondary sm" :disabled="!state.layers.length" @click="save"><Icon name="arrow" :size="15" />Save photo</button>
                <button class="btn-secondary sm" :disabled="!shareItems.length" @click="asking = true"><Icon name="users" :size="15" />Ask family</button>
                <button class="btn-primary sm" :disabled="!state.layers.length" @click="addLook"><Icon name="bag" :size="15" />Add look to cart</button>
              </div>
            </footer>
          </aside>
        </div>
      </div>
    </Transition>

    <ShareLook v-if="asking" :items="shareItems" :get-image="shareImage" @close="asking = false" />

    <!-- Mini picture-in-picture preview -->
    <Transition name="mini">
      <aside v-if="state.view === 'mini' && state.photo" class="mini" aria-label="Your look">
        <div class="mini-canvas" role="button" tabindex="0" title="Open fitting room" @click="state.view = 'full'" @keydown.enter="state.view = 'full'">
          <TryOnCanvas />
        </div>
        <div class="mini-bar">
          <span><Icon name="sparkle" :size="13" />{{ state.layers.length }} on</span>
          <button aria-label="Open fitting room" title="Open fitting room" @click="state.view = 'full'"><Icon name="expand" :size="14" /></button>
          <button aria-label="Close preview" title="Close preview" @click="close"><Icon name="close" :size="14" /></button>
        </div>
      </aside>
    </Transition>
  </Teleport>
</template>

<style scoped>
.studio {
  position: fixed;
  inset: 0;
  z-index: 110;
  display: flex;
  flex-direction: column;
  background: radial-gradient(1200px 600px at 10% -10%, var(--mint), transparent 60%),
    radial-gradient(900px 500px at 110% 0%, #d9e4ff, transparent 60%),
    radial-gradient(800px 500px at 50% 120%, var(--butter), transparent 60%), #f4f8f5;
}
.bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 18px 26px;
}
.brand {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--blue);
}
.brand b {
  font-size: 20px;
  font-weight: 600;
  color: var(--ink);
}
.brand span {
  padding: 4px 10px;
  border-radius: var(--r-pill);
  background: rgba(255, 255, 255, 0.75);
  font-size: 12px;
  color: var(--muted);
}
.bar-acts {
  display: flex;
  gap: 8px;
}
.tbtn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 44px;
  padding: 0 16px;
  border-radius: var(--r-pill);
  background: rgba(255, 255, 255, 0.8);
  font-size: 13px;
  font-weight: 500;
}
.tbtn:hover {
  background: #fff;
}
.tbtn.icon {
  justify-content: center;
  width: 44px;
  padding: 0;
}

/* Setup */
.setup {
  flex: 1;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 40px;
  align-items: center;
  max-width: 1100px;
  width: 100%;
  margin: 0 auto;
  padding: 0 32px 32px;
  overflow-y: auto;
}
.ask {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 14px;
}
.ask h1 {
  font-size: 40px;
  font-weight: 600;
  letter-spacing: -0.03em;
}
.ask p {
  font-size: 17px;
  line-height: 1.55;
  color: #3b4047;
}
.ask p b {
  color: var(--blue);
}
.tips {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 4px 0 0;
  padding: 0;
  list-style: none;
  font-size: 14px;
}
.tips li {
  display: flex;
  align-items: center;
  gap: 10px;
}
.tips svg {
  flex-shrink: 0;
  padding: 3px;
  border-radius: 50%;
  background: #e7f8ef;
  color: #067647;
  box-sizing: content-box;
}
.queued {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
  padding: 10px 14px;
  border-radius: 18px;
  background: rgba(255, 255, 255, 0.75);
  font-size: 13px;
  color: var(--muted);
}
.queued img {
  width: 40px;
  height: 40px;
  border-radius: 12px;
  object-fit: cover;
}
.inputs {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 24px;
  border-radius: var(--r-card);
  background: rgba(255, 255, 255, 0.8);
  backdrop-filter: blur(12px);
  box-shadow: 0 30px 60px -40px rgba(20, 33, 77, 0.4);
}
.drop {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-height: 190px;
  padding: 24px;
  border: 2px dashed #c9d6ff;
  border-radius: 24px;
  background: #f7f9ff;
  text-align: center;
  cursor: pointer;
  transition: all 0.2s ease;
}
.drop:hover,
.drop.over {
  border-color: var(--blue);
  background: var(--blue-soft);
}
.drop.busy {
  cursor: progress;
}
.drop b {
  font-size: 16px;
  font-weight: 600;
}
.drop small {
  font-size: 13px;
  color: var(--muted);
}
.drop-icon {
  display: grid;
  place-items: center;
  width: 56px;
  height: 56px;
  border-radius: 20px;
  background: var(--blue);
  color: #fff;
}
.spinner.dark {
  width: 30px;
  height: 30px;
  border-color: var(--blue-soft);
  border-top-color: var(--blue);
}
.cam-btn {
  width: 100%;
  height: 54px;
}
.samples > span {
  display: block;
  margin-bottom: 8px;
  font-size: 13px;
  color: var(--muted);
}
.sample-row {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
}
.sample {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--muted);
}
.sample img {
  width: 100%;
  aspect-ratio: 2 / 3;
  border: 2px solid transparent;
  border-radius: 16px;
  object-fit: cover;
  transition: border-color 0.2s ease, transform 0.2s ease;
}
.sample:hover img {
  border-color: var(--blue);
  transform: translateY(-2px);
}
.cam {
  position: relative;
  overflow: hidden;
  border-radius: 24px;
  background: #000;
}
.cam video {
  display: block;
  width: 100%;
  max-height: 52vh;
  object-fit: cover;
  transform: scaleX(-1);
}
.guide {
  position: absolute;
  inset: 6% 30%;
  border: 3px dashed rgba(255, 255, 255, 0.7);
  border-radius: 45% 45% 20% 20%;
  pointer-events: none;
}
.count {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  color: #fff;
  font-size: 96px;
  font-weight: 700;
  text-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
}
.cam-acts {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 14px;
  display: flex;
  justify-content: center;
  gap: 8px;
}
.msg {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 12px 14px;
  border-radius: 16px;
  background: #fff4d6;
  color: #7a5200;
  font-size: 13px;
  line-height: 1.45;
}
.msg svg {
  flex-shrink: 0;
  margin-top: 1px;
}
.privacy {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  font-size: 12px;
  color: var(--muted);
}
.privacy .link {
  margin-left: auto;
}
.consent {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 12px 14px;
  border: 1.5px solid var(--line, #e3e7ee);
  border-radius: 16px;
  background: #fff;
  font-size: 12.5px;
  line-height: 1.45;
  color: var(--muted);
  cursor: pointer;
}
.consent.on {
  border-color: var(--blue);
  background: var(--blue-soft);
}
.consent b {
  color: var(--ink);
}
.consent input {
  flex-shrink: 0;
  width: 17px;
  height: 17px;
  margin-top: 1px;
  accent-color: var(--blue);
}
.consent.floating {
  position: absolute;
  top: 64px;
  left: 50%;
  z-index: 2;
  width: min(460px, 90%);
  border-color: var(--blue);
  box-shadow: 0 10px 24px -12px rgba(20, 33, 77, 0.45);
  transform: translateX(-50%);
}
.consent.floating label {
  display: flex;
  gap: 10px;
  cursor: pointer;
}
.drop.locked {
  opacity: 0.55;
}
.mode {
  display: inline-flex;
  align-self: center;
  gap: 4px;
  margin-bottom: 10px;
  padding: 4px;
  border-radius: var(--r-pill);
  background: rgba(255, 255, 255, 0.8);
  box-shadow: 0 6px 16px -10px rgba(20, 33, 77, 0.35);
}
.mode button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  padding: 0 14px;
  border-radius: var(--r-pill);
  color: var(--muted);
  font-size: 13px;
  font-weight: 600;
}
.mode button.on {
  background: var(--blue);
  color: #fff;
}
.has-mode .pose-ok,
.has-mode .msg.floating {
  top: 64px;
}
.pose-ok {
  pointer-events: none;
}
.compare {
  position: absolute;
  left: 50%;
  bottom: 26px;
  transform: translateX(-50%);
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 36px;
  padding: 0 14px;
  border-radius: var(--r-pill);
  background: rgba(255, 255, 255, 0.94);
  color: var(--ink);
  font-size: 12.5px;
  font-weight: 600;
  box-shadow: 0 8px 20px -10px rgba(20, 33, 77, 0.45);
  user-select: none;
  touch-action: none;
}
.photo-check ul {
  display: grid;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.photo-check li {
  display: flex;
  gap: 8px;
  font-size: 12.5px;
  line-height: 1.45;
  color: #7a5200;
}
.photo-check svg {
  flex-shrink: 0;
  margin-top: 2px;
}
.style-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.style-chips button {
  height: 30px;
  padding: 0 12px;
  border: 1.5px solid var(--line, #e3e7ee);
  border-radius: var(--r-pill);
  background: #fff;
  font-size: 12.5px;
  font-weight: 600;
}
.style-chips button.on {
  border-color: var(--blue);
  background: var(--blue-soft);
  color: var(--blue);
}
.style-chips button:disabled,
.style-form :disabled {
  opacity: 0.5;
  cursor: default;
}
.style-form {
  display: flex;
  gap: 8px;
}
.style-form input {
  flex: 1;
  min-width: 0;
  height: 36px;
  padding: 0 12px;
  border: 1.5px solid var(--line, #e3e7ee);
  border-radius: 12px;
  font: inherit;
  font-size: 13px;
}

/* Studio */
.work {
  flex: 1;
  display: grid;
  grid-template-columns: 1fr 400px;
  gap: 20px;
  min-height: 0;
  padding: 0 26px 22px;
}
.canvas-area {
  position: relative;
  display: flex;
  flex-direction: column;
  min-height: 0;
  padding: 10px;
}
.pose-ok {
  position: absolute;
  top: 18px;
  left: 50%;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border-radius: var(--r-pill);
  background: rgba(231, 248, 239, 0.95);
  color: #067647;
  font-size: 12px;
  font-weight: 500;
  transform: translateX(-50%);
}
.msg.floating {
  position: absolute;
  top: 18px;
  left: 50%;
  width: min(520px, 90%);
  transform: translateX(-50%);
}
.empty-hint {
  position: absolute;
  left: 50%;
  bottom: 26px;
  padding: 10px 16px;
  border-radius: var(--r-pill);
  background: rgba(18, 20, 23, 0.78);
  color: #fff;
  font-size: 13px;
  transform: translateX(-50%);
  white-space: nowrap;
}
.side {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 0;
  overflow-y: auto;
  padding-right: 4px;
}
.panel {
  padding: 18px;
  border-radius: 26px;
  background: rgba(255, 255, 255, 0.85);
  backdrop-filter: blur(12px);
}
.panel-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: 12px;
}
.panel-head h2 {
  font-size: 16px;
  font-weight: 600;
}
.panel-head span {
  font-size: 13px;
  color: var(--muted);
}
.small {
  font-size: 13px;
}
.layers {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.layers li {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 8px 6px 6px;
  border: 2px solid transparent;
  border-radius: 18px;
  cursor: pointer;
  transition: background 0.15s ease;
}
.layers li:hover {
  background: var(--chip);
}
.layers li.on {
  border-color: var(--blue);
  background: #f7f9ff;
}
.layers img {
  width: 44px;
  height: 44px;
  border-radius: 14px;
  object-fit: cover;
}
.l-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.l-text b {
  overflow: hidden;
  font-size: 13.5px;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.l-text small {
  font-size: 12px;
  color: var(--muted);
}
.mini-btn {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border-radius: 10px;
  color: var(--muted);
}
.mini-btn:hover {
  background: #fff;
  color: var(--ink);
}
.adjust {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.fit-badge {
  display: inline-block;
  margin-left: 4px;
  padding: 1px 7px;
  border-radius: var(--r-pill);
  background: var(--blue-soft);
  color: var(--blue);
  font-size: 10.5px;
  font-style: normal;
  font-weight: 600;
}
.fit-badge.custom {
  background: #fff4d6;
  color: #9a6700;
}
.fit-badge.ai-only {
  background: var(--line);
  color: var(--muted);
}
.panel-head .link {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.reset {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 30px;
  padding: 0 12px;
  border-radius: var(--r-pill);
  background: var(--blue);
  color: #fff;
  font-size: 12px;
  font-weight: 600;
}
.reset:disabled {
  background: var(--blue-soft);
  color: var(--blue);
  cursor: default;
}
.fit-note {
  font-size: 12.5px;
  line-height: 1.45;
  color: var(--muted);
}
.adjust .panel-head {
  margin-bottom: 2px;
}
.slider {
  display: grid;
  grid-template-columns: 60px 1fr 44px;
  align-items: center;
  gap: 10px;
  font-size: 13px;
}
.slider input {
  accent-color: var(--blue);
}
.slider em {
  font-style: normal;
  text-align: right;
  color: var(--muted);
}
.nudges {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
}
.nudges span {
  width: 60px;
}
.nudges button {
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  border-radius: 12px;
  background: var(--chip);
}
.nudges button:hover {
  background: var(--line);
}
.suggest {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 8px;
}
.s-card {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px;
  border-radius: 18px;
  background: #fff;
}
.s-card img {
  width: 100%;
  height: 96px;
  margin-bottom: 4px;
  border-radius: 14px;
  object-fit: cover;
  cursor: pointer;
}
.s-card b {
  overflow: hidden;
  padding: 0 4px;
  font-size: 12.5px;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.s-card small {
  padding: 0 4px;
  font-size: 11.5px;
  color: var(--muted);
}
.try {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  height: 32px;
  margin-top: 6px;
  border-radius: var(--r-pill);
  background: var(--blue-soft);
  color: var(--blue);
  font-size: 12px;
  font-weight: 600;
}
.try:hover {
  background: var(--blue);
  color: #fff;
}
.look {
  position: sticky;
  bottom: 0;
  padding: 16px 18px;
  border-radius: 26px;
  background: var(--ink);
  color: #fff;
}
.look > div:first-child {
  display: flex;
  justify-content: space-between;
  margin-bottom: 12px;
  font-size: 14px;
}
.look b {
  font-size: 18px;
}
.look-acts {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}
.look-acts .btn-primary {
  grid-column: 1 / -1;
}
.look .btn-secondary {
  background: rgba(255, 255, 255, 0.12);
  color: #fff;
}
.look .btn-secondary:hover {
  background: rgba(255, 255, 255, 0.2);
}
.look button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

/* Mini preview */
.mini {
  position: fixed;
  left: 24px;
  bottom: 24px;
  z-index: 110;
  width: 190px;
  padding: 8px;
  border-radius: 26px;
  background: #fff;
  box-shadow: 0 24px 50px -16px rgba(20, 33, 77, 0.45);
}
.mini-canvas {
  height: 250px;
  border-radius: 20px;
  background: var(--card);
  overflow: hidden;
  cursor: zoom-in;
}
.mini-canvas :deep(.photo-box) {
  border-radius: 18px;
  box-shadow: none;
}
.mini-bar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 8px 4px 2px 8px;
}
.mini-bar span {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  font-weight: 600;
  color: var(--blue);
}
.mini-bar button {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border-radius: 10px;
  background: var(--chip);
}

.studio-enter-active,
.studio-leave-active {
  transition: opacity 0.3s ease, transform 0.35s cubic-bezier(0.2, 0.8, 0.2, 1);
}
.studio-enter-from,
.studio-leave-to {
  opacity: 0;
  transform: scale(0.98);
}
.mini-enter-active,
.mini-leave-active {
  transition: all 0.35s cubic-bezier(0.2, 0.8, 0.2, 1);
}
.mini-enter-from,
.mini-leave-to {
  opacity: 0;
  transform: translateY(20px) scale(0.9);
}

@media (max-width: 1000px) {
  .setup {
    grid-template-columns: 1fr;
    gap: 20px;
    align-items: start;
    padding: 0 16px 24px;
  }
  .ask h1 {
    font-size: 30px;
  }
  .work {
    grid-template-columns: 1fr;
    grid-template-rows: minmax(360px, 55vh) auto;
    overflow-y: auto;
    padding: 0 12px 16px;
  }
  .side {
    overflow: visible;
  }
  .bar {
    padding: 14px 16px;
  }
  .tbtn:not(.icon) {
    padding: 0 12px;
    font-size: 12px;
  }
  .brand span {
    display: none;
  }
}
@media (max-width: 560px) {
  .mini {
    left: 12px;
    bottom: 96px;
    width: 130px;
  }
  .mini-canvas {
    height: 170px;
  }
}
</style>
