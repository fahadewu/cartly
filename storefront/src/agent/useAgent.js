import { reactive, computed } from 'vue'
import { respond, greeting, preview } from './brain.js'
import { useTryOn } from '../tryon/useTryOn.js'
import { productById } from '../catalog.js'
import { useShop } from '../store.js'
import { auth, onAuthChange } from '../auth.js'
import { api } from '../api.js'
import { caps, loadCapabilities } from '../capabilities.js'
import { baseOf, deviceLocale, deviceTimeZone, fullTag, languageName } from './languages.js'
import { recordingSupported, recordUtterance, toWav } from './recorder.js'
import { toast } from '../toast.js'
import { style } from '../style.js'

// One shared agent for the whole app: the corner chat and the full-screen
// voice stage both read and write this state.
const KEY = 'cartly.agent.v1'
const load = () => {
  try {
    return JSON.parse(sessionStorage.getItem(KEY)) ?? {}
  } catch {
    return {}
  }
}
const saved = load()

const state = reactive({
  mode: 'closed', // closed | chat | stage
  messages: saved.messages ?? [], // { id, role: 'user'|'agent', text, products?, chips?, mood?, lang?, askSize?, askColor? }
  status: 'idle', // idle | listening | thinking | speaking
  mood: 'idle', // short-lived expression after a reply
  interim: '', // live speech transcript
  level: 0, // microphone level 0–1 while recording
  live: [], // product ids matching what the shopper is saying right now
  error: '',
  voiceIssue: null, // { kind, title, body, signIn? } — why voice can't work here, shown as a banner
  note: '', // gentle, non-error hint (e.g. no voice for a language on this device)
  muted: saved.muted ?? false,
  autoListen: saved.autoListen ?? true,
  // The conversation's language: detected from what the shopper says (auto) or picked by them (fixed).
  lang: saved.lang ?? null,
  langMode: saved.langMode ?? 'auto',
  unread: 0,
})
const memory = saved.memory ?? {} // for the in-browser fallback brain
let sessionId = saved.sessionId ?? null // the AI service keeps the conversation under this id
let pendingResults = null // a product list the shopper just picked from, sent with the next message
// What the shopper did with the product cards since their last message ({ type: 'add'|'tryon'|'like',
// id, size?, color? }). The cards act right here; Pip hears about it with the next message.
const MAX_EVENTS = 8
const events = Array.isArray(saved.events) ? saved.events.slice(-MAX_EVENTS) : []
const adding = reactive(new Set()) // product ids on their way into the cart from a card

function persist() {
  try {
    sessionStorage.setItem(
      KEY,
      JSON.stringify({
        messages: state.messages.slice(-60),
        memory,
        sessionId,
        events,
        muted: state.muted,
        autoListen: state.autoListen,
        lang: state.lang,
        langMode: state.langMode,
      }),
    )
  } catch {}
}

// A different shopper shouldn't inherit the last one's conversation.
onAuthChange((user) => {
  if (user) return
  state.messages.splice(0)
  Object.keys(memory).forEach((k) => delete memory[k])
  events.splice(0)
  sessionId = null
  state.mode = 'closed'
  persist()
})

const SR = typeof window !== 'undefined' ? window.SpeechRecognition || window.webkitSpeechRecognition : null
const synth = typeof window !== 'undefined' ? window.speechSynthesis : null
export const voiceSupported = !!SR || recordingSupported
export const speechSupported = !!synth || (typeof Audio !== 'undefined')

let router = null
let recognition = null
let recorder = null
let moodTimer = null
let liveTimer = null
let uid = Date.now()

// Hands-free guard: a TV or a nearby conversation would otherwise keep Pip listening, transcribing
// and replying (each turn billed). It waits for a tap after an off-topic reply or a goodbye, after an
// unsure scrap of speech, and after a few turns in a row that nobody tapped or typed.
const MAX_AUTO_LISTENS = 3
let autoListens = 0
let waitForTap = false
const TAP_TO_TALK = 'Tap the mic when you want to talk again'
/** The shopper tapped or typed, so someone is there: hands-free may carry on (and the note can go). */
function resumeHandsFree() {
  autoListens = 0
  waitForTap = false
  if (state.note === TAP_TO_TALK) state.note = ''
}
/** Words in a transcript, also in Thai, Chinese or Japanese, which don't put spaces between them. */
function words(text) {
  try {
    return [...new Intl.Segmenter(undefined, { granularity: 'word' }).segment(text)].filter((s) => s.isWordLike).length
  } catch {
    return text.trim().split(/\s+/).length
  }
}
/**
 * One word or less that the recogniser said it wasn't sure of (a confidence above 0 and under 0.5) is usually
 * not the shopper. A recogniser that reports 0 or nothing doesn't know, so that's no reason to doubt "M" or "42".
 */
const isUnsure = (text, confidence) => typeof confidence === 'number' && confidence > 0 && confidence < 0.5 && words(text) <= 1

const plain = (text) =>
  text
    .replace(/\*\*/g, '')
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/•/g, '')
    .replace(/\n+/g, '. ')
    .replace(/\s+/g, ' ')
    .trim()

function setMood(mood) {
  clearTimeout(moodTimer)
  state.mood = mood
  moodTimer = setTimeout(() => (state.mood = 'idle'), 2600)
}

/** The language Pip should listen and speak in right now. */
const currentLang = () => fullTag(state.lang ?? deviceLocale())
// Server speech needs a signed-in shopper (it's billed per use).
const serverStt = () => !!caps.speech.stt && !!auth.user && recordingSupported
const serverTts = () => !!caps.speech.tts && !!auth.user

/* ---------- speech out ---------- */
const ENGLISH = ['Samantha', 'Google US English', 'Microsoft Aria', 'Microsoft Jenny', 'Karen', 'Tessa', 'Moira', 'Serena']
const norm = (tag) => (tag || '').toLowerCase().replace('_', '-')
/** The nicest installed voice for a language: exact region first, then any voice of that language. */
function voiceFor(lang) {
  const voices = synth?.getVoices() ?? []
  const tag = norm(lang)
  if (baseOf(tag) === 'en') {
    const liked = ENGLISH.map((n) => voices.find((v) => v.name.includes(n))).filter(Boolean)
    const pick = liked.find((v) => norm(v.lang) === tag) ?? liked[0]
    if (pick) return pick
  }
  const exact = voices.filter((v) => norm(v.lang) === tag)
  const pool = exact.length ? exact : voices.filter((v) => baseOf(v.lang) === baseOf(tag))
  return pool.find((v) => /natural|neural|premium|enhanced|google/i.test(v.name)) ?? pool[0] ?? null
}
synth?.getVoices() // browsers load their voice list lazily

let audio = null
let speakRun = 0
function speakInBrowser(text, lang) {
  if (!synth) return maybeRelisten()
  const voice = voiceFor(lang)
  if (!voice) {
    state.note = `This device has no ${languageName(lang)} voice, so I’ll answer in text.`
    return maybeRelisten()
  }
  synth.cancel()
  const u = new SpeechSynthesisUtterance(text)
  u.voice = voice
  u.lang = voice.lang
  // Warm and gentle: a little slower than the default, a little brighter.
  u.rate = 0.97
  u.pitch = 1.15
  u.onstart = () => (state.status = 'speaking')
  u.onend = u.onerror = () => {
    if (state.status === 'speaking') state.status = 'idle'
    maybeRelisten()
  }
  synth.speak(u)
}

async function speak(text, lang = currentLang()) {
  stopSpeaking()
  if (state.muted) return maybeRelisten()
  const said = plain(text)
  if (!said) return maybeRelisten()
  state.note = ''
  const run = ++speakRun
  if (serverTts()) {
    try {
      const res = await api('/assistant/speak', { method: 'POST', body: { text: said, lang }, raw: true, timeout: 40_000 })
      const url = URL.createObjectURL(await res.blob())
      if (run !== speakRun || state.muted) return URL.revokeObjectURL(url)
      audio = new Audio(url)
      const done = () => {
        URL.revokeObjectURL(url)
        if (state.status === 'speaking') state.status = 'idle'
        maybeRelisten()
      }
      audio.onplaying = () => (state.status = 'speaking')
      audio.onended = done
      audio.onerror = done
      await audio.play()
      return
    } catch {
      if (run !== speakRun) return
      // Voice service busy or autoplay blocked: the device's own voice takes over.
    }
  }
  speakInBrowser(said, lang)
}
function stopSpeaking() {
  speakRun++
  synth?.cancel()
  if (audio) {
    audio.pause()
    audio = null
  }
  if (state.status === 'speaking') state.status = 'idle'
}
function maybeRelisten() {
  if (state.mode !== 'stage' || !state.autoListen || !voiceSupported || state.status !== 'idle') return
  if (waitForTap || autoListens >= MAX_AUTO_LISTENS) {
    state.note = TAP_TO_TALK
    return
  }
  setTimeout(() => {
    if (state.mode === 'stage' && state.status === 'idle') listen({ auto: true })
  }, 450)
}

/* ---------- speech in ---------- */
const NOTHING_HEARD = 'I didn’t hear anything. Tap the mic and try again.'

/** A best-effort name for the shopper's browser, so the banner can say what is actually wrong. */
function browserName() {
  if (typeof navigator === 'undefined') return 'this browser'
  if (navigator.brave) return 'Brave'
  const ua = navigator.userAgent
  if (/Edg\//.test(ua)) return 'Edge'
  if (/OPR\//.test(ua)) return 'Opera'
  if (/Vivaldi/.test(ua)) return 'Vivaldi'
  if (/Arc\//.test(ua)) return 'Arc'
  if (/Firefox\//.test(ua)) return 'Firefox'
  if (/Chrome\//.test(ua)) return (navigator.userAgentData?.brands ?? []).some((b) => b.brand === 'Google Chrome') ? 'Chrome' : 'this browser'
  if (/Safari\//.test(ua)) return 'Safari'
  return 'this browser'
}

// Problems the shopper can't fix by just trying again get a banner that says what's wrong and what to do.
function voiceProblem(kind, detail) {
  const name = browserName()
  const browser = name === 'this browser' ? 'This browser' : name
  const signIn = !!caps.speech.stt && !auth.user && recordingSupported
  const other = signIn ? 'Sign in to use Pip’s own voice recognition, which works in any browser, or type below.' : 'Try Chrome or Safari, or type below.'
  const issues = {
    offline: {
      title: 'You’re offline',
      body: 'Voice needs an internet connection. Reconnect and tap the mic again, or type below.',
    },
    service: {
      title: `${browser} can’t do voice input`,
      body: `Your microphone is working. ${browser} couldn’t reach its speech service (Brave, Arc, Opera and some other Chromium browsers don’t include it, and VPNs or blockers can stop it). ${other}`,
    },
    blocked: {
      title: 'Microphone access is blocked',
      body: 'Click the lock or site-settings icon next to the address bar, allow Microphone, then tap the mic again. Or type below.',
      signIn: false,
    },
    unsupported: {
      title: `${browser} doesn’t support voice input`,
      body: other,
    },
    language: {
      title: `${browser} can’t listen in ${detail}`,
      body: `Pick another language from the language menu. ${other}`,
    },
  }
  state.voiceIssue = { kind, signIn, ...issues[kind] }
}

// Each tap of the mic is one "listen"; cancelling bumps the number, so whatever an older listen was
// still waiting on (the microphone prompt, the transcription) knows to drop its result.
let listenSeq = 0

// Server speech-to-text: records until you pause, then detects the language and transcribes.
async function listenOnServer() {
  const seq = listenSeq
  let session
  try {
    session = await recordUtterance({ onLevel: (l) => (state.level = l) })
  } catch {
    voiceProblem('blocked')
    return
  }
  if (seq !== listenSeq || state.mode === 'closed') {
    // Pip was closed while the browser was still asking for the microphone.
    session.cancel()
    state.level = 0
    return
  }
  recorder = session
  state.status = 'listening'
  const blob = await session.done
  recorder = null
  state.level = 0
  if (state.status !== 'listening' || seq !== listenSeq) return // cancelled (closed, or Pip started speaking)
  if (!blob) {
    state.status = 'idle'
    state.error = NOTHING_HEARD
    return
  }
  state.status = 'thinking'
  state.interim = '…'
  try {
    const form = new FormData()
    if (caps.speech.stt === 'meta') form.append('audio', await toWav(blob), 'speech.wav') // Meta takes WAV only
    else form.append('audio', blob, `speech.${blob.type.includes('mp4') ? 'mp4' : blob.type.includes('ogg') ? 'ogg' : 'webm'}`)
    if (state.langMode === 'fixed' && state.lang) form.append('language', state.lang)
    const heard = await api('/assistant/transcribe', { method: 'POST', body: form, timeout: 40_000 })
    state.status = 'idle'
    if (seq !== listenSeq || state.mode === 'closed') return // closed meanwhile: nothing is sent or spoken
    state.interim = heard.text ?? ''
    if (!heard.text?.trim()) {
      state.error = 'I couldn’t make that out. Try again, a little closer to the mic.'
      return
    }
    // The detected language steers the reply until Pip confirms it.
    if (state.langMode === 'auto' && heard.lang && (heard.confidence ?? 1) >= 0.5) state.lang = fullTag(heard.lang)
    // That confidence is how sure it is of the language, not of the words: it can't mark a scrap as unsure.
    send(heard.text, { spoken: true })
  } catch (e) {
    state.status = 'idle'
    state.interim = ''
    state.error = e.message
  }
}

// The browser's recogniser: live transcript, but only in the language set up front.
function listenInBrowser() {
  let finalText = ''
  let confidence
  recognition = new SR()
  recognition.lang = currentLang()
  recognition.interimResults = true
  recognition.continuous = false
  recognition.onstart = () => (state.status = 'listening')
  recognition.onresult = (e) => {
    let interim = ''
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i]
      if (r.isFinal) {
        finalText += r[0].transcript
        confidence = r[0].confidence
      } else interim += r[0].transcript
    }
    state.interim = (finalText + ' ' + interim).trim()
    clearTimeout(liveTimer)
    liveTimer = setTimeout(() => {
      const ids = preview(state.interim)
      if (ids.length) state.live = ids
    }, 180)
  }
  recognition.onerror = (e) => {
    if (e.error === 'not-allowed') voiceProblem('blocked')
    else if (e.error === 'network' || e.error === 'service-not-allowed') voiceProblem(navigator.onLine === false ? 'offline' : 'service')
    else if (e.error === 'language-not-supported') voiceProblem('language', languageName(recognition?.lang ?? currentLang()))
    else if (e.error === 'no-speech') state.error = NOTHING_HEARD
    else if (e.error === 'audio-capture') state.error = 'No microphone found. Plug one in or check your sound settings, then try again.'
  }
  const rec = recognition
  rec.onend = () => {
    if (state.status === 'listening') state.status = 'idle'
    const text = finalText.trim()
    state.interim = text
    if (recognition === rec) recognition = null
    // An aborted listen (Pip closed, language switched) keeps its half-sentence to itself.
    if (text && !rec.aborted) send(text, { spoken: true, unsure: isUnsure(text, confidence) })
  }
  try {
    recognition.start()
  } catch {
    state.status = 'idle'
  }
}

/** `auto`: hands-free listening again after a reply; otherwise the shopper tapped the mic. */
function listen({ auto = false } = {}) {
  // Pip is still answering (or transcribing): a second message would only be dropped.
  if (state.status === 'thinking') return
  if (auto) autoListens++
  else resumeHandsFree()
  if (state.status === 'listening') return stopListening()
  if (!serverStt() && !SR) return voiceProblem('unsupported')
  stopSpeaking()
  state.error = ''
  state.voiceIssue = null
  state.note = ''
  state.interim = ''
  state.live = []
  if (serverStt()) listenOnServer()
  else listenInBrowser()
}
function stopListening() {
  if (recorder) recorder.stop()
  else recognition?.stop()
}
function cancelListening() {
  listenSeq++
  if (recorder) {
    state.status = 'idle'
    recorder.cancel()
  } else if (recognition) {
    recognition.aborted = true
    recognition.abort?.()
  }
}

/* ---------- actions ---------- */
function perform(actions = []) {
  const shop = useShop()
  for (const a of actions) {
    if (a.type === 'navigate') {
      if (state.mode === 'stage') state.mode = 'chat'
      router?.push(a.to)
    } else if (a.type === 'add') {
      const p = productById(a.id)
      if (p) shop.addToCart(p, { size: a.size, color: a.color })
    } else if (a.type === 'like') {
      if (!shop.isLiked(a.id)) shop.toggleLike(a.id)
    } else if (a.type === 'openCart') {
      if (state.mode === 'stage') state.mode = 'chat'
      shop.state.cartOpen = true
    } else if (a.type === 'tryon') {
      useTryOn().tryOn(a.id)
    } else if (a.type === 'restyle') {
      useTryOn().restyle(a.id, a.prompt)
    } else if (a.type === 'adjust') {
      useTryOn().adjust(a.op, { all: a.all })
    } else if (a.type === 'untry') {
      useTryOn().removeLast()
    } else if (a.type === 'clearLook') {
      useTryOn().clear()
    } else if (a.type === 'buyLook') {
      shop.addAllToCart(useTryOn().lookItems.value)
    } else if (a.type === 'fittingRoom') {
      useTryOn().state.view = 'full'
    } else if (a.type === 'sampleModel') {
      const t = useTryOn()
      const menswear = t.state.pending.some((id) => productById(id)?.gender === 'men')
      t.state.view = 'full'
      t.useSample(t.samples[menswear ? 1 : 0])
    } else if (a.type === 'reorder') {
      shop.reorder({ id: a.id })
    } else if (a.type === 'human') {
      // The contact card shows in the chat, so leave the voice screen for it.
      if (state.mode === 'stage') state.mode = 'chat'
    }
  }
}

/* ---------- card buttons ---------- */
// Add, Try on and the heart on Pip's product cards (and the size buttons under a "which size?")
// work right here: no message, no AI call, and no change to the list Pip is talking about. Pip
// hears what happened with the shopper's next message.
// The AI service refuses a longer size (12) or colour (40): leave it out of the note rather than fail the chat.
const within = (value, max) => (typeof value === 'string' && value.length <= max ? value : undefined)
function noteCardEvent(e) {
  events.push(e)
  events.splice(0, events.length - MAX_EVENTS)
  persist()
}
// Adding or trying on by tap answers Pip with the shopper's hands: stop the mic rather than wait on
// silence (or on the TV).
function tapped() {
  resumeHandsFree()
  if (state.status === 'listening') cancelListening()
}
/**
 * Adds `p` in `size` and `color` (its first colour unless `color` is one of its own); resolves true when it's
 * in the cart. The toast says which colour and size went in, so a wrong one is caught right away.
 */
async function addFromCard(p, size, color) {
  if (adding.has(p.id)) return false
  tapped()
  adding.add(p.id)
  try {
    const colour = p.colors.find((c) => c.name === color)?.name ?? p.colors[0]?.name
    const ok = await useShop().addToCart(p, { size, color: colour }, { silent: true })
    if (ok) {
      const details = [colour, p.sizes.length > 1 && size].filter(Boolean).join(', ')
      toast(`${p.name}${details ? ` (${details})` : ''} added to cart`)
      noteCardEvent({ type: 'add', id: p.id, size: within(size, 12), color: within(colour, 40) })
    }
    return ok
  } finally {
    adding.delete(p.id)
  }
}
async function tryOnFromCard(p) {
  tapped()
  // Same as Pip's own try-on: the look opens, or the fitting room asks for a photo first.
  const result = await useTryOn().tryOn(p.id)
  // Only a look that's on: an item waiting for a photo isn't worn yet (the Fitting room line covers it later).
  if (result === 'applied') noteCardEvent({ type: 'tryon', id: p.id })
  return result
}
async function likeFromCard(p) {
  const shop = useShop()
  const liking = !shop.isLiked(p.id)
  resumeHandsFree() // they may still be talking ("I like this one, but in blue")
  await shop.toggleLike(p.id)
  if (liking && shop.isLiked(p.id)) noteCardEvent({ type: 'like', id: p.id })
}
/** This product's lines in the cart as { size, color }, for "In cart · M Black" and the size buttons' ticks. */
const cartVariants = (id) => useShop().lines.value.filter((l) => l.id === id).map((l) => ({ size: l.size, color: l.color }))

const tryOnContext = () => {
  const t = useTryOn()
  return {
    hasPhoto: !!t.state.photo,
    mode: t.aiMode.value ? 'ai' : 'preview',
    on: t.state.layers.map((l) => ({ id: l.id, name: productById(l.id)?.name })),
  }
}

// Where and when the shopper is (for language, season and festivals) and how they're talking:
// `origin` is what sent the message (typed | voice | chip | card | greet); `voiceOut` says Pip will
// speak the reply, so only then does it write one to be spoken.
const clientContext = (extra = {}) => ({
  tryOn: tryOnContext(),
  locale: deviceLocale(),
  timeZone: deviceTimeZone(),
  lang: state.lang ?? undefined,
  langMode: state.langMode,
  // Styles picked in the style quiz (the account's copy wins on the server for signed-in shoppers).
  quizStyles: style.picked.length ? style.picked : undefined,
  ...extra,
})

function localContext() {
  const shop = useShop()
  return {
    userName: auth.user?.name?.split(' ')[0],
    cart: shop.lines.value.map((l) => ({ name: l.product.name, qty: l.qty, price: l.product.price })),
    cartTotal: shop.subtotal.value,
    orders: shop.state.orders,
    liked: shop.state.liked,
    tryOn: tryOnContext(),
  }
}

// Pip's brain runs in the AI service, reached through the API so it knows this shopper's
// cart and orders. If that's unavailable, the same rules run right here in the browser.
async function think(text, { spoken, origin, voiceOut }) {
  const results = pendingResults
  pendingResults = null
  // Card taps ride along once, even if this message fails: a note Pip missed costs nothing, a note
  // the service refused would fail every message after it.
  const cards = events.splice(0)
  try {
    const reply = await api('/assistant/chat', {
      method: 'POST',
      body: {
        message: text,
        sessionId: sessionId ?? undefined,
        context: clientContext({ spoken, origin, voiceOut, ...(results && { results }), ...(cards.length && { events: cards }) }),
      },
      timeout: 50_000, // the API gives Pip 45 s
    })
    sessionId = reply.session_id
    if (reply.products?.length) memory.results = reply.products
    return reply
  } catch {
    return respond(text, memory, localContext())
  }
}

function push(msg) {
  state.messages.push({ id: ++uid, ...msg })
  if (msg.role === 'agent' && state.mode === 'closed') state.unread++
  persist()
}

function adoptLanguage(reply) {
  if (reply.lang && state.langMode === 'auto') state.lang = fullTag(reply.lang)
}

/**
 * `origin`: what sent it (typed | voice | chip | card), for the AI service's meter.
 * `unsure`: a spoken scrap the recogniser doubted, so hands-free waits for a tap after the reply.
 */
async function send(text, { spoken = false, origin = spoken ? 'voice' : 'typed', unsure = false } = {}) {
  text = text.trim()
  if (!text || state.status === 'thinking') return
  if (!spoken) resumeHandsFree()
  else if (unsure) waitForTap = true
  stopSpeaking()
  push({ role: 'user', text })
  state.live = []
  state.status = 'thinking'
  state.error = ''
  // Pip speaks the reply when you talked to it or the voice screen is open, unless it's muted.
  const voiceOut = (spoken || state.mode === 'stage') && !state.muted
  // Keep a short, human-feeling pause while Pip "thinks", even when the reply is instant.
  const pause = new Promise((r) => setTimeout(r, 350 + Math.min(700, text.length * 10) + Math.random() * 250))
  const [reply] = await Promise.all([think(text, { spoken, origin, voiceOut }), pause])
  state.status = 'idle'
  adoptLanguage(reply)
  // Pip declined something that isn't shopping (often a TV or another conversation in the room), or the
  // shopper said goodbye (`done`): the mic waits for a tap.
  if (reply.offTopic || reply.done) waitForTap = true
  // `askSize`: Pip asked which size of this product, so its sizes show as buttons under the reply, adding
  // the colour the shopper asked for (`askColor`) when they named one.
  push({
    role: 'agent',
    text: reply.text,
    products: reply.products,
    chips: reply.chips,
    mood: reply.mood,
    lang: reply.lang,
    ...(reply.askSize && { askSize: reply.askSize, ...(reply.askColor && { askColor: reply.askColor }) }),
    // "Help me decide" rows, and Pip handing over to a person on the team.
    ...(reply.compare?.length && { compare: reply.compare }),
    ...(reply.actions?.some((a) => a.type === 'human') && { handoff: true }),
  })
  setMood(reply.mood ?? 'idle')
  perform(reply.actions)
  if (spoken || state.mode === 'stage') speak(reply.speech ?? reply.text, reply.lang ? fullTag(reply.lang) : currentLang())
}

// When the shopper adds a photo (and when an AI look is ready), Pip says a word about it.
useTryOn().onEvent((e) => {
  const t = useTryOn()
  const english = baseOf(currentLang()) === 'en'
  if (e.type === 'rendered') {
    if (state.mode === 'stage' && english) speak('Your look is ready!')
    return
  }
  if (e.type !== 'photo' || !english) return
  const names = t.lookItems.value.map((p) => p.name)
  const ai = t.aiMode.value
  const text = names.length
    ? ai
      ? `Dressing you in the **${names.join('**, **')}** ✨ Your look will be ready in a few seconds. Ask me to style it, like “tuck it in”.`
      : `I’ve fitted the **${names.join('**, **')}** to your body ✨ Fine-tune with the sliders, or just tell me, like “make it longer” or “move it up”.`
    : 'Got your photo! Now tell me what to try on, like “try on a red dress” or “try on sunglasses”.'
  push({ role: 'agent', text, chips: names.length ? ['Try on sunglasses', 'Show me shoes', 'Add the look to cart'] : ['Try on a red dress', 'Try on sunglasses'], mood: 'happy' })
  setMood('happy')
  if (state.mode === 'stage') speak(text)
})

// With the multilingual brain, Pip opens in the shopper's language and knows what's coming up
// for them (a festival, the season); otherwise the built-in English greeting.
async function greet({ voiceOut = false } = {}) {
  await loadCapabilities()
  if (caps.multilingual) {
    state.status = 'thinking'
    try {
      const context = clientContext({ origin: 'greet', voiceOut: voiceOut && !state.muted })
      const reply = await api('/assistant/chat', { method: 'POST', body: { kind: 'greet', sessionId: sessionId ?? undefined, context }, timeout: 50_000 })
      sessionId = reply.session_id
      state.status = 'idle'
      adoptLanguage(reply)
      push({ role: 'agent', text: reply.text, chips: reply.chips, mood: reply.mood ?? 'happy', lang: reply.lang })
      setMood(reply.mood ?? 'happy')
      if (voiceOut) speak(reply.speech ?? reply.text, reply.lang ? fullTag(reply.lang) : currentLang())
      return
    } catch {
      state.status = 'idle'
    }
  }
  const g = greeting(auth.user?.name?.split(' ')[0])
  push({ role: 'agent', text: g.text, chips: g.chips, mood: 'happy', lang: 'en' })
  setMood('happy')
  if (voiceOut) speak(g.speech, 'en-US')
}

export function useAgent() {
  const face = computed(() => (state.status !== 'idle' ? state.status : state.mood))
  const language = computed(() => currentLang())

  function init(r) {
    router = r
  }
  function open(mode = 'chat') {
    const first = !state.messages.length
    state.mode = mode
    state.unread = 0
    if (mode === 'stage') resumeHandsFree()
    if (first) greet({ voiceOut: mode === 'stage' })
    else if (mode === 'stage') {
      if (baseOf(currentLang()) === 'en') speak('I’m listening. What are you looking for?')
      else maybeRelisten()
    }
  }
  function close() {
    cancelListening()
    stopSpeaking()
    if (state.note === TAP_TO_TALK) state.note = '' // the voice screen's note, which the chat would keep showing
    state.mode = 'closed'
  }
  function toChat() {
    cancelListening()
    stopSpeaking()
    if (state.note === TAP_TO_TALK) state.note = ''
    state.mode = 'chat'
  }
  function reset() {
    cancelListening()
    stopSpeaking()
    state.messages.splice(0)
    Object.keys(memory).forEach((k) => delete memory[k])
    events.splice(0)
    sessionId = null
    resumeHandsFree()
    greet({ voiceOut: state.mode === 'stage' })
  }
  // Asking Pip to add or try on number N of a list (the cards themselves act directly, see addFromCard).
  function pickFrom(ids, i) {
    memory.results = pendingResults = ids
    send(`Add number ${i + 1}`, { origin: 'card' })
  }
  function tryFrom(ids, i) {
    memory.results = pendingResults = ids
    send(`Try on number ${i + 1}`, { origin: 'card' })
  }
  function toggleMute() {
    state.muted = !state.muted
    if (state.muted) stopSpeaking()
    persist()
  }
  function toggleAutoListen() {
    state.autoListen = !state.autoListen
    if (state.autoListen) resumeHandsFree()
    persist()
  }
  /** 'auto' follows whatever language the shopper speaks; a tag pins it. */
  function setLanguage(tag) {
    cancelListening()
    if (tag === 'auto') {
      state.langMode = 'auto'
      // Back to the language of the conversation so far, not the one that was pinned.
      const heard = [...state.messages].reverse().find((m) => m.role === 'agent' && m.lang)?.lang
      state.lang = heard ? fullTag(heard) : null
    } else {
      state.langMode = 'fixed'
      state.lang = tag
    }
    state.note = ''
    persist()
  }

  return {
    state,
    face,
    language,
    init,
    open,
    close,
    toChat,
    reset,
    send,
    listen,
    stopListening,
    stopSpeaking,
    pickFrom,
    tryFrom,
    adding,
    addFromCard,
    tryOnFromCard,
    likeFromCard,
    cartVariants,
    toggleMute,
    toggleAutoListen,
    setLanguage,
    serverStt,
    dismissVoiceIssue: () => (state.voiceIssue = null),
  }
}
