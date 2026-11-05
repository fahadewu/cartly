import { reactive, computed, watch } from 'vue'
import { specFor, isWearable, inPreview, REPLACES, Z, SAMPLE_MODELS } from './specs.js'
import { cutout, loadImage } from './cutout.js'
import { fitBox, FALLBACK_POSE } from './fit.js'
import { assessPhoto } from './photoCheck.js'
import { productById } from '../catalog.js'
import { caps } from '../capabilities.js'
import { api } from '../api.js'
import { onAuthChange } from '../auth.js'

// The virtual fitting room. Shared by the studio, the mini preview, product pages and Pip.
//
// AI try-on (when the AI service has it switched on): the shopper's photo is re-rendered
// by AI wearing the look, so fabric drapes, sleeves and lighting follow their body. Every
// change to the look triggers one render; earlier steps are cached on the server.
// Quick preview (fallback): product cut-outs placed on the photo from body landmarks,
// entirely on the device.
const KEY = 'cartly.tryon.v2'
const CONSENT = 'cartly.tryon.consent.v1'
const saved = (() => {
  try {
    return JSON.parse(sessionStorage.getItem(KEY)) ?? {}
  } catch {
    return {}
  }
})()
const readConsent = () => {
  try {
    return localStorage.getItem(CONSENT) === 'yes'
  } catch {
    return false
  }
}

const state = reactive({
  view: 'closed', // closed | full | mini
  photo: saved.photo ?? null, // data URL or remote URL
  size: saved.size ?? null, // { w, h } natural photo size
  pose: saved.pose ?? null, // 33 landmarks, or null
  poseSource: saved.poseSource ?? null, // 'detected' | 'estimated'
  check: saved.check ?? null, // how well the photo suits try-on (see photoCheck.js)
  source: saved.source ?? null, // 'photo' (the shopper's own) | 'sample'
  sample: saved.sample ?? null, // sample model index when source is 'sample'
  photoVersion: saved.photoVersion ?? 0,
  status: 'idle', // idle | detecting | working
  message: '',
  layers: [], // { uid, id, slot, src, aspect, box, auto, fit, opacity, hidden }
  fitted: null, // { uid, name } of the item Pip just fitted, for the on-canvas hint
  selected: null,
  pending: saved.pending ?? [], // product ids waiting for a photo
  mode: saved.mode ?? 'ai', // the shopper's choice: 'ai' | 'preview'
  consent: readConsent(), // agreed to their own photo being processed for AI try-on
  notes: saved.notes ?? {}, // product id → how to wear it ("tuck in the shirt")
  seed: saved.seed ?? 42, // a new seed gives another take on the same look
  ai: { status: 'idle', image: saved.ai?.image ?? null, key: saved.ai?.key ?? '', error: '', started: 0, steps: 0 },
})
let uid = 0
const listeners = new Set()

// Signing out forgets the photo, the render and the look: on a shared phone the next person who opens
// the fitting room must not find someone else's body photo waiting there.
onAuthChange((user) => {
  if (user) return
  state.layers = []
  state.pending = []
  Object.assign(state, { photo: null, size: null, pose: null, poseSource: null, check: null, source: null, sample: null, fitted: null, selected: null, notes: {}, view: 'closed' })
  Object.assign(state.ai, { status: 'idle', image: null, key: '', error: '' })
  try {
    sessionStorage.removeItem(KEY)
  } catch {}
})

/** AI try-on is on for this deployment and the shopper hasn't switched to the quick preview. */
const aiMode = computed(() => !!caps.tryon && state.mode === 'ai')
/** …and it may use this photo: a sample model, or the shopper agreed to the photo notice. */
const aiReady = computed(() => aiMode.value && !!state.photo && (state.source === 'sample' || state.consent))
const visibleIds = () => state.layers.filter((l) => !l.hidden).map((l) => l.id)
/** Identifies the look on screen; a render is only shown for the look it was made for. */
const lookKey = computed(() => {
  const ids = visibleIds().sort((a, b) => a - b)
  return ids.length ? JSON.stringify([state.photoVersion, ids, ids.map((id) => state.notes[id] ?? ''), state.seed]) : ''
})

function persist() {
  const base = {
    size: state.size,
    pose: state.pose,
    poseSource: state.poseSource,
    check: state.check,
    source: state.source,
    sample: state.sample,
    photoVersion: state.photoVersion,
    pending: state.pending,
    mode: state.mode,
    notes: state.notes,
    seed: state.seed,
    layers: state.layers.map(({ id, box, fit, opacity, hidden }) => ({ id, box, fit, opacity, hidden })),
  }
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ ...base, photo: state.photo, ai: { image: state.ai.image, key: state.ai.key } }))
  } catch {
    // Photos too large for session storage: keep the look, drop the images.
    try {
      sessionStorage.setItem(KEY, JSON.stringify({ ...base, pending: [...new Set([...state.pending, ...base.layers.map((l) => l.id)])], layers: [] }))
    } catch {}
  }
}

// Downscale big uploads so they're fast to process and store.
async function normalisePhoto(src) {
  const img = await loadImage(src)
  const max = 1400
  const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight))
  const w = Math.round(img.naturalWidth * k)
  const h = Math.round(img.naturalHeight * k)
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  c.getContext('2d').drawImage(img, 0, 0, w, h)
  const data = c.toDataURL('image/jpeg', 0.9)
  return { src: data, w, h, img: await loadImage(data) }
}

function autoBox(slot, aspect) {
  return fitBox(slot, aspect, state.pose ?? FALLBACK_POSE, state.size.w, state.size.h)
}

async function addLayer(id, { silent = false } = {}) {
  const spec = specFor(id)
  if (!spec || !state.photo || !isWearable(id)) return null
  state.status = 'working'
  try {
    // The cut-out is only drawn in quick preview, which shows accessories only; AI try-on works
    // from the product photo itself.
    let cut = null
    try {
      if (inPreview(spec.slot)) cut = await cutout(id)
    } catch {
      if (!aiMode.value) {
        state.message = 'Couldn’t load that item’s photo. Check your connection and try again.'
        return null
      }
    }
    const aspect = cut?.aspect ?? 1
    // Pip fits it to the body first; the shopper can fine-tune afterwards.
    const box = autoBox(spec.slot, aspect)
    const replaced = REPLACES[spec.slot]
    state.layers = state.layers.filter((l) => !replaced.includes(l.slot))
    const layer = { uid: ++uid, id, slot: spec.slot, src: cut?.src ?? null, aspect, box, auto: { ...box }, fit: 'pip', opacity: 1, hidden: false }
    state.layers.push(layer)
    state.layers.sort((a, b) => Z[a.slot] - Z[b.slot])
    state.selected = layer.uid
    if (!silent) state.fitted = { uid: layer.uid, name: productById(id)?.name }
    persist()
    if (!silent) listeners.forEach((fn) => fn({ type: 'applied', id }))
    return layer
  } finally {
    state.status = 'idle'
  }
}

async function restore() {
  if (!saved.layers?.length || !state.photo) return
  for (const l of saved.layers) {
    const layer = await addLayer(l.id, { silent: true })
    if (layer) Object.assign(layer, { box: l.box, fit: l.fit ?? 'pip', opacity: l.opacity, hidden: l.hidden })
  }
  state.selected = null
}
restore()

/* ---------- AI rendering ---------- */
let renderTimer = null
let renderAbort = null

function scheduleRender() {
  clearTimeout(renderTimer)
  if (!aiReady.value) {
    renderAbort?.abort()
    if (state.ai.status === 'rendering') state.ai.status = 'idle'
    return
  }
  const key = lookKey.value
  if (!key) {
    renderAbort?.abort()
    Object.assign(state.ai, { status: 'idle', image: null, key: '', error: '' })
    return
  }
  if (key === state.ai.key && state.ai.image) {
    renderAbort?.abort()
    state.ai.status = 'idle'
    return
  }
  Object.assign(state.ai, { status: 'rendering', error: '', started: Date.now(), steps: visibleIds().length })
  renderTimer = setTimeout(renderLook, 450) // a burst of changes becomes one render
}

async function renderLook() {
  const key = lookKey.value
  const ids = state.layers.filter((l) => !l.hidden).map((l) => l.id) // already in wearing order
  renderAbort?.abort()
  const abort = (renderAbort = new AbortController())
  Object.assign(state.ai, { status: 'rendering', error: '', steps: ids.length })
  try {
    const form = new FormData()
    form.append('productIds', JSON.stringify(ids))
    const notes = Object.fromEntries(ids.filter((id) => state.notes[id]).map((id) => [id, state.notes[id]]))
    if (Object.keys(notes).length) form.append('notes', JSON.stringify(notes))
    form.append('seed', String(state.seed))
    if (state.source === 'sample') form.append('sample', String(state.sample))
    else {
      form.append('photo', await (await fetch(state.photo)).blob(), 'photo.jpg')
      form.append('consent', 'true')
    }
    const r = await api('/tryon/render', { method: 'POST', body: form, signal: abort.signal })
    if (key !== lookKey.value) return
    Object.assign(state.ai, { status: 'idle', image: r.image, key })
    persist()
    listeners.forEach((fn) => fn({ type: 'rendered' }))
  } catch (e) {
    if (e.name === 'AbortError' || key !== lookKey.value) return
    Object.assign(state.ai, { status: 'error', error: e.message || 'The AI try-on didn’t work this time.' })
  }
}

watch([lookKey, aiReady], scheduleRender, { immediate: true })

export function useTryOn() {
  const hasPhoto = computed(() => !!state.photo)
  const lookItems = computed(() => state.layers.map((l) => productById(l.id)).filter(Boolean))
  const lookTotal = computed(() => lookItems.value.reduce((n, p) => n + p.price, 0))
  const selectedLayer = computed(() => state.layers.find((l) => l.uid === state.selected) ?? null)
  /** The AI image for the look on screen (or the last one, while the next is rendering). */
  const aiImage = computed(() => (aiReady.value && lookKey.value ? state.ai.image : null))

  async function setPhoto(src, { source = 'photo', sample = null } = {}) {
    state.status = 'detecting'
    state.message = ''
    try {
      const { src: data, w, h, img } = await normalisePhoto(src)
      state.photo = data
      state.size = { w, h }
      state.pose = null
      state.source = source
      state.sample = sample
      state.photoVersion++
      Object.assign(state.ai, { image: null, key: '', error: '' })
      try {
        const { detectPose } = await import('./pose.js')
        const lm = await detectPose(img)
        if (lm) {
          state.pose = lm
          state.poseSource = 'detected'
        } else {
          state.poseSource = 'estimated'
          state.message = aiMode.value
            ? ''
            : 'I couldn’t spot a full body, so I’ve placed items where a standing person usually is. Drag them to fine-tune, or try a head-to-toe photo.'
        }
        state.check = assessPhoto(lm, { w, h })
      } catch {
        state.poseSource = 'estimated'
        state.check = null
        if (!aiMode.value) state.message = 'Body detection didn’t load (are you offline?), so items are placed approximately. You can drag and resize them.'
      }
      // Re-fit anything already on, then apply queued items.
      const current = state.layers.map((l) => l.id)
      state.layers = []
      state.status = 'idle'
      for (const id of [...current, ...state.pending]) await addLayer(id, { silent: !state.pending.includes(id) })
      state.pending = []
      persist()
      listeners.forEach((fn) => fn({ type: 'photo' }))
    } catch {
      state.status = 'idle'
      state.message = 'That photo couldn’t be opened. Try a JPG or PNG.'
    }
  }

  function useSample(model) {
    return setPhoto(`https://images.unsplash.com/photo-${model.photo}?w=1100&q=85&auto=format`, { source: 'sample', sample: SAMPLE_MODELS.indexOf(model) })
  }

  /** Put a product on. Returns 'applied' | 'needs-photo' | 'not-wearable'. */
  async function tryOn(id, { open = 'mini' } = {}) {
    if (!isWearable(id)) return 'not-wearable'
    if (!inPreview(specFor(id).slot) && state.mode === 'preview') {
      state.mode = 'ai'
      state.message = 'Clothes and shoes only show in AI try-on, so I switched it on.'
    }
    if (!state.photo) {
      if (!state.pending.includes(id)) state.pending.push(id)
      state.view = 'full'
      persist()
      return 'needs-photo'
    }
    if (state.view === 'closed' || (open === 'full' && state.view === 'mini')) state.view = open
    await addLayer(id)
    return 'applied'
  }

  function remove(uidOrId) {
    const gone = state.layers.filter((l) => l.uid === uidOrId || l.id === uidOrId)
    state.layers = state.layers.filter((l) => !gone.includes(l))
    gone.forEach((l) => delete state.notes[l.id])
    if (!state.layers.some((l) => l.uid === state.selected)) state.selected = null
    persist()
  }
  function removeLast() {
    const last = state.layers.findLast((l) => l.uid === state.selected) ?? state.layers.at(-1)
    if (last) remove(last.uid)
    return last ? productById(last.id) : null
  }
  function clear() {
    state.layers = []
    state.notes = {}
    state.selected = null
    persist()
  }
  function toggleHidden(layer) {
    layer.hidden = !layer.hidden
    persist()
  }
  // Back to Pip's fit for one item, or for everything (quick preview).
  function refit(layer) {
    layer.box = autoBox(layer.slot, layer.aspect)
    layer.auto = { ...layer.box }
    layer.fit = 'pip'
    state.fitted = { uid: layer.uid, name: productById(layer.id)?.name }
    persist()
  }
  function refitAll() {
    state.layers.forEach((l) => {
      l.box = autoBox(l.slot, l.aspect)
      l.auto = { ...l.box }
      l.fit = 'pip'
    })
    state.fitted = { uid: null, name: 'your whole look' }
    persist()
  }
  // Small adjustments Pip makes when asked ("make it bigger", "move it up") in quick preview.
  function adjust(op, { all = false } = {}) {
    const layer = state.layers.find((l) => l.uid === state.selected) ?? state.layers.at(-1)
    if (!layer) return
    if (op === 'reset') return all ? refitAll() : refit(layer)
    const b = { ...layer.box }
    const step = state.size.w * 0.025
    const k = { bigger: [1.08, 1.08], smaller: [0.93, 0.93], wider: [1.08, 1], narrower: [0.93, 1], longer: [1, 1.08], shorter: [1, 0.93] }[op]
    if (k) {
      b.w *= k[0]
      b.h *= k[1]
    }
    if (op === 'up') b.cy -= step
    if (op === 'down') b.cy += step
    if (op === 'left') b.cx -= step
    if (op === 'right') b.cx += step
    layer.box = b
    state.selected = layer.uid
    markCustom(layer)
  }
  /** How to wear an item in the AI look ("tuck in the shirt"); empty clears it. */
  function restyle(id, prompt) {
    const layer = state.layers.find((l) => l.id === Number(id)) ?? state.layers.find((l) => l.uid === state.selected) ?? state.layers.at(-1)
    if (!layer) return
    const note = (prompt ?? '').trim().slice(0, 120)
    if (note) state.notes[layer.id] = note
    else delete state.notes[layer.id]
    state.selected = layer.uid
    persist()
  }
  /** Same look, another take. */
  function anotherTake() {
    state.seed = Math.floor(Math.random() * 2 ** 31)
    persist()
  }
  function retry() {
    Object.assign(state.ai, { key: '', error: '' })
    scheduleRender()
  }
  function setMode(mode) {
    state.mode = mode
    if (mode === 'preview' && state.layers.some((l) => !inPreview(l.slot)))
      state.message = 'Quick preview shows accessories only. Your clothes and shoes appear in AI try-on.'
    persist()
  }
  function setConsent(yes) {
    state.consent = yes
    try {
      localStorage.setItem(CONSENT, yes ? 'yes' : 'no')
    } catch {}
  }
  // Called whenever the shopper tweaks an item by hand.
  function markCustom(layer) {
    layer.fit = 'custom'
    persist()
  }
  function changePhoto() {
    state.pending = [...new Set([...state.pending, ...state.layers.map((l) => l.id)])]
    state.layers = []
    state.photo = null
    state.pose = null
    state.size = null
    state.check = null
    state.source = null
    Object.assign(state.ai, { status: 'idle', image: null, key: '', error: '' })
    state.view = 'full'
    persist()
  }
  function isOn(id) {
    return state.layers.some((l) => l.id === id)
  }
  function onEvent(fn) {
    listeners.add(fn)
    return () => listeners.delete(fn)
  }

  // The look as an image the shopper can keep: the AI render, or the preview flattened to PNG.
  async function snapshot() {
    if (aiImage.value && state.ai.key === lookKey.value) return aiImage.value
    const c = document.createElement('canvas')
    c.width = state.size.w
    c.height = state.size.h
    const ctx = c.getContext('2d')
    ctx.drawImage(await loadImage(state.photo), 0, 0, c.width, c.height)
    for (const l of state.layers) {
      if (l.hidden || !l.src) continue
      const img = await loadImage(l.src)
      ctx.save()
      ctx.globalAlpha = l.opacity
      ctx.translate(l.box.cx, l.box.cy)
      ctx.rotate((l.box.rot * Math.PI) / 180)
      ctx.drawImage(img, -l.box.w / 2, -l.box.h / 2, l.box.w, l.box.h)
      ctx.restore()
    }
    return c.toDataURL('image/png')
  }

  return {
    state,
    hasPhoto,
    lookItems,
    lookTotal,
    selectedLayer,
    aiMode,
    aiReady,
    aiImage,
    lookKey,
    samples: SAMPLE_MODELS,
    setPhoto,
    useSample,
    tryOn,
    remove,
    removeLast,
    clear,
    toggleHidden,
    refit,
    refitAll,
    markCustom,
    adjust,
    restyle,
    anotherTake,
    retry,
    setMode,
    setConsent,
    changePhoto,
    isOn,
    onEvent,
    snapshot,
    persist,
  }
}
