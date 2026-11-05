<script setup>
// Virtual try-on settings for a product: where it's worn, the clean photo the AI copies
// the product from (with a quality check against the photo guide), how the AI should wear
// it by default, and a preview on a sample model with the real AI try-on.
import { computed, onMounted, ref, watch } from 'vue'
import Field from './Field.vue'
import Icon from './Icon.vue'
import { get, post, upload } from '../api.js'
import { toast } from '../toast.js'
import { ACCEPT, GRADE, GUIDE, MIN_SIDE, PHOTO_TYPES, PREVIEW_SLOTS, RULES, SAMPLE_MODELS, SLOTS, precheck } from '../tryonGuide.js'

const props = defineProps({
  form: { type: Object, required: true }, // the product form: tryOnSlot, tryOnImage, tryOnInfo, image, name, colors
  productId: Number, // saved products can be previewed from the database
  cutout: String, // the saved quick-preview cut-out (accessories), made by the server
  dirty: Boolean, // unsaved changes: the cut-out is made from the saved product
})

const status = ref(null) // { tryon, agent } from the AI service
const busy = ref('') // 'upload' | 'check' | 'preview' | 'cutout'
const drag = ref(false)
const fileInput = ref(null)
const preview = ref(null) // { image, sample }
const sample = ref(0)
const uploadError = ref('')

onMounted(async () => {
  status.value = await get('/admin/try-on/status').catch(() => null)
})

const slot = computed(() => props.form.tryOnSlot)
const guide = computed(() => GUIDE[slot.value])
const info = computed(() => props.form.tryOnInfo)
const photo = computed(() => props.form.tryOnImage || props.form.image)
// A check describes one photo in one slot; after either changes it no longer applies.
const saved = computed(() => info.value.check ?? null)
const stale = computed(() => !!saved.value && (saved.value.url !== photo.value || saved.value.slot !== slot.value))
const check = computed(() => (stale.value ? null : saved.value))
const usingMain = computed(() => !props.form.tryOnImage)
const grade = computed(() => (check.value ? GRADE[check.value.grade] ?? GRADE.fix : null))
const colours = computed(() => props.form.colors.map((c) => c.name.trim()).filter(Boolean))
const aiOn = computed(() => !!status.value?.tryon)
const reviewOn = computed(() => status.value?.agent === 'claude')
const min = computed(() => MIN_SIDE(slot.value))

watch([photo, slot], () => (preview.value = null))

// Quick preview (accessories): the cut-out shoppers see placed on their photo when AI try-on is off.
const inPreview = computed(() => PREVIEW_SLOTS.includes(slot.value))
const remade = ref(null)
watch(() => props.cutout, () => (remade.value = null))
const shownCutout = computed(() => (info.value.cutout === 'plain' ? null : remade.value ?? props.cutout))
async function remakeCutout() {
  busy.value = 'cutout'
  try {
    remade.value = (await post('/admin/try-on/cutout', { productId: props.productId })).url
  } catch (e) {
    toast(e.message, 'error')
  } finally {
    busy.value = ''
  }
}
const stamp = (c, url) => ({ ...c, url, slot: slot.value })

async function onFiles(files) {
  const file = files?.[0]
  if (!file) return
  uploadError.value = (await precheck(file, slot.value)) || ''
  if (uploadError.value) return
  busy.value = 'upload'
  try {
    const r = await upload('/admin/try-on/photo', file, { slot: slot.value, name: props.form.name.trim() || undefined, colors: colours.value })
    props.form.tryOnImage = r.url
    info.value.check = stamp(r.check, r.url)
    toast(r.check.ok ? 'Try-on photo uploaded and checked' : 'Uploaded, but the photo needs fixing', r.check.ok ? 'info' : 'error')
  } catch (e) {
    uploadError.value = e.message
  } finally {
    busy.value = ''
  }
}
function onDrop(e) {
  drag.value = false
  onFiles(e.dataTransfer.files)
}

async function runCheck() {
  if (!/^https?:\/\//.test(photo.value || '')) return toast('Add a photo URL first.', 'error')
  busy.value = 'check'
  try {
    const url = photo.value
    info.value.check = stamp(await post('/admin/try-on/check', { url, slot: slot.value, name: props.form.name.trim() || undefined, colors: colours.value }), url)
  } catch (e) {
    toast(e.status === 503 ? 'The photo check needs the AI service. Start it and try again.' : e.message, 'error')
  } finally {
    busy.value = ''
  }
}

async function runPreview() {
  busy.value = 'preview'
  preview.value = null
  try {
    const body = { sample: sample.value, image: photo.value, slot: slot.value, name: props.form.name.trim() || undefined, styling: info.value.styling?.trim() || '' }
    const r = await post('/admin/try-on/preview', body)
    preview.value = { image: r.image, sample: sample.value }
  } catch (e) {
    toast(e.message, 'error')
  } finally {
    busy.value = ''
  }
}

function useMainPhoto() {
  props.form.tryOnImage = ''
  uploadError.value = ''
}
</script>

<template>
  <section class="panel">
    <div class="panel-head">
      <h2>Virtual try-on</h2>
      <span v-if="status" class="state" :class="{ on: aiOn }">
        <i />{{ aiOn ? 'AI try-on is on' : 'AI try-on is off: shoppers can preview accessories only' }}
      </span>
    </div>
    <div class="panel-body stack">
      <Field id="slot" label="Where it’s worn" hint="Shoppers can try it on in the fitting room and by asking Pip.">
        <select id="slot" v-model="form.tryOnSlot" class="select">
          <option v-for="s in SLOTS" :key="s[0]" :value="s[0]">{{ s[1] }}</option>
        </select>
      </Field>

      <template v-if="slot">
        <div class="tryon">
          <div class="photo-col">
            <div
              class="drop"
              :class="{ over: drag, busy: busy === 'upload' }"
              role="button"
              tabindex="0"
              aria-label="Upload a try-on photo"
              @click="fileInput.click()"
              @keydown.enter="fileInput.click()"
              @dragover.prevent="drag = true"
              @dragleave="drag = false"
              @drop.prevent="onDrop"
            >
              <img v-if="photo" :src="photo" alt="" />
              <div class="drop-cta">
                <template v-if="busy === 'upload'"><span class="spinner" />Uploading and checking…</template>
                <template v-else><Icon name="up" :size="16" />{{ form.tryOnImage ? 'Replace try-on photo' : 'Upload a try-on photo' }}</template>
              </div>
            </div>
            <input ref="fileInput" type="file" :accept="ACCEPT" hidden @change="onFiles($event.target.files); $event.target.value = ''" />
            <p class="muted small">
              <template v-if="usingMain">Using the main product photo. A dedicated photo that follows the guide gives a more accurate try-on.</template>
              <template v-else>Dedicated try-on photo. <button v-can="'catalog.write'" type="button" class="link-btn" @click="useMainPhoto">Use the main photo instead</button></template>
            </p>
            <p v-if="uploadError" class="err" role="alert">{{ uploadError }}</p>
          </div>

          <div class="guide">
            <p class="best"><b>Best:</b> {{ guide.best }}</p>
            <ul>
              <li v-for="t in [...guide.tips, ...RULES]" :key="t"><Icon name="check" :size="14" />{{ t }}</li>
            </ul>
            <p class="muted small">Minimum {{ min.error }} px on the short side; {{ min.best }} px or more is best.</p>
          </div>
        </div>

        <div class="report" :class="grade?.tone ?? 'none'">
          <div class="report-head">
            <div>
              <b v-if="grade">{{ grade.label }}</b>
              <b v-else>Photo not checked yet</b>
              <span v-if="check" class="muted small">
                Score {{ check.score }}/100<template v-if="check.width"> · {{ check.width }}×{{ check.height }} px</template>
                · {{ check.ai?.used ? 'pixel checks + AI review' : 'pixel checks only' }}
              </span>
              <span v-else-if="stale" class="muted small">The photo or slot changed since the last check. Check it again.</span>
              <span v-else class="muted small">See how well this photo will work before shoppers try it on.</span>
            </div>
            <button v-can="'catalog.write'" type="button" class="btn sm" :disabled="!!busy || !photo" @click="runCheck">
              <Icon name="refresh" :size="14" />{{ busy === 'check' ? 'Checking…' : check ? 'Check again' : 'Check photo' }}
            </button>
          </div>
          <div v-if="check" class="meter"><i :style="{ width: `${check.score}%` }" /></div>
          <ul v-if="check?.issues?.length" class="issues">
            <li v-for="(i, n) in check.issues" :key="n" :class="i.level">
              <Icon :name="i.level === 'info' ? 'check' : 'alert'" :size="14" />{{ i.message }}
            </li>
          </ul>
          <p v-else-if="check" class="muted small">No problems found.</p>
          <p v-if="check && !check.ai?.used && !reviewOn" class="muted small">Add an Anthropic API key to the AI service for an AI review (right item, fully visible, no hanger or watermark).</p>
        </div>

        <div class="grid">
          <Field id="photo-type" label="Photo type" optional hint="On-model and ghost-mannequin photos give the most realistic drape.">
            <select id="photo-type" v-model="info.photoType" class="select">
              <option value="">Not set</option>
              <option v-for="t in PHOTO_TYPES" :key="t[0]" :value="t[0]">{{ t[1] }}</option>
            </select>
          </Field>
          <Field id="styling" label="How the AI should wear it" optional hint="In English, e.g. “wear it open” or “tuck it in”. Shoppers can change it.">
            <input id="styling" v-model="info.styling" class="input" maxlength="120" placeholder="Leave empty for the natural look" />
          </Field>
        </div>

        <div v-if="inPreview" class="cutout">
          <div class="cutout-img">
            <img v-if="shownCutout" :src="shownCutout" alt="The item cut out for the quick preview" />
            <span v-else class="muted small">{{ info.cutout === 'plain' ? 'Cut out in the shopper’s browser' : 'Made when you save' }}</span>
          </div>
          <div class="stack">
            <div class="cutout-head">
              <b>Quick preview</b>
              <span class="muted small">When AI try-on is off, shoppers see this cut-out placed on their photo.</span>
            </div>
            <Field id="cutout" label="Background removal" hint="AI works on any background. Simple suits a studio shot on a plain backdrop that the AI clips (a woven bag, a watch screen).">
              <select id="cutout" v-model="info.cutout" class="select">
                <option value="">AI (any background)</option>
                <option value="plain">Simple (plain backdrop)</option>
              </select>
            </Field>
            <div>
              <button v-can="'catalog.write'" type="button" class="btn sm" :disabled="!productId || dirty || !!busy || info.cutout === 'plain'" @click="remakeCutout">
                <Icon name="refresh" :size="14" />{{ busy === 'cutout' ? 'Making it…' : 'Remake cut-out' }}
              </button>
              <p class="muted small">{{ dirty || !productId ? 'Save first: the cut-out is made from the saved photo.' : 'It’s remade a few seconds after each save.' }}</p>
            </div>
          </div>
        </div>

        <div class="preview">
          <div class="preview-head">
            <div>
              <b>Preview on a model</b>
              <span class="muted small">See the real AI try-on before shoppers do. Uses one try-on render.</span>
            </div>
            <button v-can="'catalog.write'" type="button" class="btn primary sm" :disabled="!aiOn || !!busy || !photo" @click="runPreview">
              {{ busy === 'preview' ? 'Rendering… (up to 30s)' : 'Preview try-on' }}
            </button>
          </div>
          <div class="models">
            <button
              v-for="m in SAMPLE_MODELS"
              :key="m.index"
              type="button"
              :class="{ on: sample === m.index }"
              :aria-label="`Sample model ${m.index + 1}`"
              @click="sample = m.index"
            >
              <img :src="m.thumb" alt="" />
            </button>
            <figure v-if="preview" class="result">
              <img :src="preview.image" alt="AI try-on preview on a sample model" />
              <figcaption class="muted small">Check the colour, print and fit look right. If not, improve the photo using the guide.</figcaption>
            </figure>
          </div>
          <p v-if="status && !aiOn" class="muted small">Set FASHN_API_KEY on the AI service to turn on AI try-on and previews.</p>
        </div>
      </template>
    </div>
  </section>
</template>

<style scoped>
.state {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--muted);
}
.state i {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--line-strong);
}
.state.on {
  color: var(--ok);
}
.state.on i {
  background: var(--ok);
}
.tryon {
  display: grid;
  grid-template-columns: 220px minmax(0, 1fr);
  gap: 18px;
}
.photo-col {
  display: grid;
  gap: 8px;
  align-content: start;
}
.drop {
  position: relative;
  display: grid;
  place-items: center;
  aspect-ratio: 3 / 4;
  border: 1.5px dashed var(--line-strong);
  border-radius: var(--r-panel);
  background: var(--hover);
  overflow: hidden;
  cursor: pointer;
}
.drop:hover,
.drop.over,
.drop:focus-visible {
  border-color: var(--accent);
  outline: none;
}
.drop img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: contain;
  background: #fff;
}
.drop-cta {
  position: absolute;
  left: 10px;
  right: 10px;
  bottom: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 8px 10px;
  border-radius: var(--r-control);
  background: rgba(18, 20, 23, 0.78);
  color: #fff;
  font-size: 12.5px;
  font-weight: 600;
}
.spinner {
  width: 13px;
  height: 13px;
  border: 2px solid rgba(255, 255, 255, 0.35);
  border-top-color: #fff;
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
.guide {
  display: grid;
  gap: 10px;
  align-content: start;
  padding: 14px 16px;
  border-radius: var(--r-panel);
  background: var(--hover);
  font-size: 13px;
}
.guide ul {
  display: grid;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.guide li {
  display: flex;
  gap: 8px;
  line-height: 1.4;
}
.guide li svg {
  flex-shrink: 0;
  margin-top: 2px;
  color: var(--ok);
}
.best {
  line-height: 1.45;
}
.small {
  font-size: 12.5px;
}
.err {
  color: var(--danger);
  font-size: 12.5px;
  font-weight: 600;
}
.report {
  display: grid;
  gap: 10px;
  padding: 14px 16px;
  border: 1px solid var(--line);
  border-left: 4px solid var(--line-strong);
  border-radius: var(--r-panel);
}
.report.good {
  border-left-color: var(--ok);
}
.report.warn {
  border-left-color: #e0a100;
}
.report.bad {
  border-left-color: var(--danger);
  background: var(--danger-soft);
}
.report-head,
.preview-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.report-head > div,
.preview-head > div,
.cutout-head {
  display: grid;
  gap: 2px;
}
.meter {
  height: 6px;
  border-radius: 6px;
  background: var(--grey);
  overflow: hidden;
}
.meter i {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--ok);
}
.warn .meter i {
  background: #e0a100;
}
.bad .meter i {
  background: var(--danger);
}
.issues {
  display: grid;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
  font-size: 13px;
}
.issues li {
  display: flex;
  gap: 8px;
  line-height: 1.4;
}
.issues li svg {
  flex-shrink: 0;
  margin-top: 2px;
}
.issues .error {
  color: var(--danger);
  font-weight: 600;
}
.issues .warn {
  color: var(--warn);
}
.issues .info {
  color: var(--muted);
}
.grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}
.cutout {
  display: grid;
  grid-template-columns: 150px 1fr;
  gap: 14px;
  align-items: start;
}
.cutout-img {
  display: grid;
  place-items: center;
  aspect-ratio: 1;
  padding: 8px;
  border: 1px solid var(--line);
  border-radius: 10px;
  text-align: center;
  /* a checkerboard, so the transparent background shows */
  background: repeating-conic-gradient(var(--grey) 0 25%, var(--surface) 0 50%) 0 0 / 14px 14px;
}
.cutout-img img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
}
@media (max-width: 520px) {
  .cutout {
    grid-template-columns: 1fr;
  }
}
.preview {
  display: grid;
  gap: 10px;
}
.models {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: flex-start;
}
.models button {
  width: 54px;
  height: 74px;
  padding: 0;
  border: 2px solid transparent;
  border-radius: 10px;
  overflow: hidden;
  background: var(--grey);
}
.models button.on {
  border-color: var(--accent);
}
.models button img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.result {
  display: grid;
  gap: 6px;
  margin: 0 0 0 8px;
  max-width: 260px;
}
.result img {
  width: 100%;
  border-radius: var(--r-panel);
}
@media (max-width: 760px) {
  .tryon,
  .grid {
    grid-template-columns: minmax(0, 1fr);
  }
  .photo-col {
    max-width: 260px;
  }
}
</style>
