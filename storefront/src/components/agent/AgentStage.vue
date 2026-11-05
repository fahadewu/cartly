<script setup>
import { ref, computed, watch, nextTick, onBeforeUnmount } from 'vue'
import Mascot from './Mascot.vue'
import AgentProducts from './AgentProducts.vue'
import VoiceNotice from './VoiceNotice.vue'
import Icon from '../Icon.vue'
import { useAgent, voiceSupported, speechSupported } from '../../agent/useAgent.js'
import { rich } from '../../agent/format.js'
import { LANGUAGES, languageName } from '../../agent/languages.js'
import { caps } from '../../capabilities.js'
import { productById } from '../../catalog.js'

const agent = useAgent()
const { state, face } = agent

// Auto: Pip follows whatever language you speak (detected on the server when speech-to-text is
// on, otherwise the language Pip last replied in). Picking one pins it.
const langChoice = computed({
  get: () => (state.langMode === 'auto' ? 'auto' : state.lang),
  set: (v) => agent.setLanguage(v),
})
const options = computed(() => {
  const tags = LANGUAGES.includes(state.lang) || !state.lang ? LANGUAGES : [state.lang, ...LANGUAGES]
  // Show the region only where two variants of a language are listed (English US/UK…).
  const bases = tags.map((t) => t.split('-')[0])
  return tags.map((t) => ({ tag: t, label: languageName(t, { region: bases.filter((b) => b === t.split('-')[0]).length > 1 }) }))
})
const autoLabel = computed(() => (state.langMode === 'auto' && state.lang ? `Auto · ${languageName(agent.language.value, { region: false })}` : 'Auto-detect'))

const typing = ref(!voiceSupported)
const draft = ref('')
const input = ref(null)

const lastUser = computed(() => [...state.messages].reverse().find((m) => m.role === 'user'))
const lastAgent = computed(() => [...state.messages].reverse().find((m) => m.role === 'agent'))
const lastShown = computed(() => [...state.messages].reverse().find((m) => m.role === 'agent' && m.products?.length))
const lastResults = computed(() => lastShown.value?.products ?? [])
// Pip asked which size: tapping one adds it (in the colour the shopper asked for, else the product's first),
// so the answer needs no spoken (and billed) turn. A tick marks a size already in the cart in that colour.
const sizeAsk = computed(() => {
  const p = productById(lastAgent.value?.askSize)
  if (!p?.inStock || p.sizes.length < 2) return null
  const colour = p.colors.find((c) => c.name === lastAgent.value.askColor) ?? p.colors[0]
  const inCart = agent.cartVariants(p.id).filter((l) => l.color === colour?.name).map((l) => l.size)
  return { product: p, colour, inCart }
})
// While the shopper is talking, the tray shows live matches for what they've said so far.
const liveNow = computed(() => state.status === 'listening' && state.live.length > 0)
const results = computed(() => (liveNow.value ? state.live : lastResults.value))

const caption = computed(() => {
  if (state.status === 'listening') return state.interim || 'I’m listening…'
  if (state.status === 'thinking') return 'Let me look…'
  return ''
})
const hint = computed(() => {
  if (state.status === 'listening') return agent.serverStt() ? 'Just talk. I’ll stop when you pause' : 'Tap the mic when you’re done'
  if (state.status === 'speaking') return 'Tap the mic to interrupt'
  if (state.status === 'thinking') return 'Searching the store'
  if (!voiceSupported) return 'Type what you’re looking for below'
  return caps.multilingual ? 'Tap the mic and talk to me in any language' : 'Tap the mic and tell me what you need'
})

function submit() {
  const t = draft.value
  draft.value = ''
  agent.send(t)
}
function mic() {
  if (state.status === 'speaking') agent.stopSpeaking()
  agent.listen()
}

function onKey(e) {
  if (e.key === 'Escape') agent.close()
  if (e.code === 'Space' && !typing.value && e.target === document.body) {
    e.preventDefault()
    mic()
  }
}
watch(
  () => state.mode,
  async (m) => {
    if (m === 'stage') {
      document.addEventListener('keydown', onKey)
      document.documentElement.style.overflow = 'hidden'
      if (typing.value) {
        await nextTick()
        input.value?.focus()
      }
    } else {
      document.removeEventListener('keydown', onKey)
      document.documentElement.style.overflow = ''
    }
  },
)
onBeforeUnmount(() => document.removeEventListener('keydown', onKey))

const sparkles = Array.from({ length: 14 }, (_, i) => ({
  left: `${(i * 37) % 100}%`,
  top: `${(i * 53) % 100}%`,
  delay: `${(i % 7) * 0.6}s`,
  size: 6 + ((i * 5) % 10),
}))
</script>

<template>
  <Teleport to="body">
    <Transition name="stage">
      <div v-if="state.mode === 'stage'" class="stage" role="dialog" aria-modal="true" aria-label="Talk to Pip">
        <!-- animated backdrop -->
        <div class="bg" aria-hidden="true">
          <span class="blob b1" /><span class="blob b2" /><span class="blob b3" /><span class="blob b4" />
          <i v-for="(s, i) in sparkles" :key="i" class="spark" :style="{ left: s.left, top: s.top, animationDelay: s.delay, width: `${s.size}px`, height: `${s.size}px` }" />
        </div>

        <header class="bar">
          <div class="brand"><Icon name="sparkle" :size="18" /><b>Pip</b><span>Voice shopping</span></div>
          <div class="bar-acts">
            <label v-if="voiceSupported" class="lang" title="The language Pip listens and replies in">
              <Icon name="globe" :size="16" />
              <span class="sr-only">Language</span>
              <select v-model="langChoice">
                <option value="auto">{{ autoLabel }}</option>
                <option v-for="o in options" :key="o.tag" :value="o.tag">{{ o.label }}</option>
              </select>
            </label>
            <button
              v-if="voiceSupported"
              class="tbtn"
              :class="{ on: state.autoListen }"
              :title="state.autoListen ? 'Hands-free: Pip listens again after replying' : 'Hands-free is off'"
              @click="agent.toggleAutoListen()"
            >
              <Icon name="mic" :size="16" />{{ state.autoListen ? 'Hands-free on' : 'Hands-free off' }}
            </button>
            <button v-if="speechSupported" class="tbtn icon" :aria-label="state.muted ? 'Unmute Pip' : 'Mute Pip'" @click="agent.toggleMute()">
              <Icon :name="state.muted ? 'volumeOff' : 'volume'" :size="18" />
            </button>
            <button class="tbtn" @click="agent.toChat()"><Icon name="send" :size="15" />Chat view</button>
            <button class="tbtn icon" aria-label="Close voice mode" @click="agent.close()"><Icon name="close" :size="18" /></button>
          </div>
        </header>

        <main class="center" :class="{ compact: results.length }">
          <div class="pip-wrap" :class="state.status" :style="{ '--level': state.level }">
            <span class="ring r1" /><span class="ring r2" /><span class="ring r3" />
            <Mascot :state="face" :size="240" track />
          </div>

          <div class="captions" aria-live="polite">
            <p v-if="caption" class="you" :class="{ live: state.status === 'listening' }" dir="auto">{{ caption }}</p>
            <template v-else>
              <p v-if="lastUser" class="you small" dir="auto">“{{ lastUser.text }}”</p>
              <p v-if="lastAgent" :key="lastAgent.id" class="pip-says" dir="auto" :lang="lastAgent.lang" v-html="rich(lastAgent.text)" />
            </template>
          </div>

          <div
            v-if="sizeAsk && state.status !== 'thinking'"
            class="chips sizes"
            role="group"
            :aria-label="`Sizes of ${sizeAsk.product.name} in ${sizeAsk.colour?.name}`"
          >
            <span v-if="sizeAsk.product.colors.length > 1" class="colour"><i :style="{ background: sizeAsk.colour.hex }" />{{ sizeAsk.colour.name }}</span>
            <button
              v-for="s in sizeAsk.product.sizes"
              :key="s"
              :class="{ on: sizeAsk.inCart.includes(s) }"
              :title="sizeAsk.inCart.includes(s) ? 'In cart' : undefined"
              :disabled="sizeAsk.inCart.includes(s) || agent.adding.has(sizeAsk.product.id)"
              @click="agent.addFromCard(sizeAsk.product, s, sizeAsk.colour?.name)"
            >
              <Icon v-if="sizeAsk.inCart.includes(s)" name="check" :size="15" />{{ s }}
            </button>
          </div>

          <div v-if="lastAgent?.chips?.length && state.status === 'idle'" class="chips">
            <button v-for="c in lastAgent.chips" :key="c" dir="auto" @click="agent.send(c, { origin: 'chip' })">{{ c }}</button>
          </div>
        </main>

        <Transition name="tray">
          <section v-if="results.length" :key="liveNow ? 'live' : results.join()" class="tray" :class="{ live: liveNow }" aria-label="Pip’s picks">
            <div class="tray-head">
              <b v-if="liveNow"><i class="live-dot" />Matching as you speak…</b>
              <b v-else>Pip’s picks</b>
              <span>Tap Add or Try on, or just tell me</span>
            </div>
            <AgentProducts
              :ids="results"
              large
              :ask-size="liveNow ? undefined : lastShown?.askSize"
              :ask-color="liveNow ? undefined : lastShown?.askColor"
            />
          </section>
        </Transition>

        <footer class="controls">
          <VoiceNotice v-if="state.voiceIssue" dark />
          <p v-else-if="state.error" class="err"><Icon name="alert" :size="15" />{{ state.error }}</p>
          <p v-else-if="state.note" class="hint note">{{ state.note }}</p>
          <p v-else class="hint">{{ hint }}</p>

          <div class="row">
            <button v-if="voiceSupported" class="side" :aria-label="typing ? 'Hide keyboard' : 'Type instead'" @click="typing = !typing">
              <Icon :name="typing ? 'close' : 'keyboard'" :size="20" />
            </button>
            <button
              v-if="voiceSupported"
              class="big-mic"
              :class="[state.status, { warn: state.voiceIssue }]"
              :aria-label="state.status === 'listening' ? 'Stop listening' : 'Start talking'"
              :disabled="state.status === 'thinking'"
              @click="mic"
            >
              <Icon name="mic" :size="34" />
            </button>
            <button v-if="voiceSupported" class="side" aria-label="Start over" @click="agent.reset()"><Icon name="refresh" :size="20" /></button>
          </div>

          <Transition name="fade">
            <form v-if="typing" class="type" @submit.prevent="submit">
              <input ref="input" v-model="draft" dir="auto" placeholder="Ask about products, sizes or your orders…" aria-label="Message Pip" maxlength="300" />
              <button type="submit" :disabled="!draft.trim() || state.status === 'thinking'" aria-label="Send"><Icon name="send" :size="18" /></button>
            </form>
          </Transition>
        </footer>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.stage {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: #eef7f1;
  color: var(--ink);
}

/* Backdrop */
.bg {
  position: absolute;
  inset: 0;
  overflow: hidden;
}
.blob {
  position: absolute;
  border-radius: 50%;
  filter: blur(60px);
  opacity: 0.85;
  animation: drift 16s ease-in-out infinite alternate;
}
.b1 { width: 52vw; height: 52vw; left: -12vw; top: -18vw; background: var(--mint); }
.b2 { width: 44vw; height: 44vw; right: -10vw; top: -8vw; background: #cddcff; animation-duration: 19s; }
.b3 { width: 46vw; height: 46vw; left: 20vw; bottom: -26vw; background: var(--butter); animation-duration: 22s; }
.b4 { width: 30vw; height: 30vw; right: 6vw; bottom: -6vw; background: var(--peach); animation-duration: 14s; }
@keyframes drift {
  to { transform: translate(6vw, 4vw) scale(1.12); }
}
.spark {
  position: absolute;
  border-radius: 50%;
  background: #fff;
  opacity: 0;
  animation: twinkle 4.2s ease-in-out infinite;
}
@keyframes twinkle {
  50% { opacity: 0.9; transform: translateY(-14px) scale(1.2); }
}

.bar,
.center,
.controls,
.tray {
  position: relative;
  z-index: 1;
}
.bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 22px 28px;
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
  background: rgba(255, 255, 255, 0.7);
  font-size: 12px;
  font-weight: 500;
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
  background: rgba(255, 255, 255, 0.72);
  backdrop-filter: blur(10px);
  font-size: 13px;
  font-weight: 500;
  transition: background 0.2s ease;
}
.tbtn:hover {
  background: #fff;
}
.tbtn.icon {
  justify-content: center;
  width: 44px;
  padding: 0;
}
.tbtn.on {
  color: var(--blue);
}

/* Center */
.center {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  /* "safe": a long caption (taller scripts like Bangla or Devanagari) scrolls instead of overlapping */
  justify-content: safe center;
  overflow-y: auto;
  gap: 18px;
  min-height: 0;
  padding: 0 24px;
  text-align: center;
}
.pip-wrap {
  position: relative;
  display: grid;
  place-items: center;
}
/* While recording for server speech-to-text, Pip glows with your voice. */
.pip-wrap.listening::before {
  content: '';
  position: absolute;
  inset: 8%;
  border-radius: 50%;
  background: radial-gradient(circle, rgba(159, 245, 207, 0.9), rgba(159, 245, 207, 0) 70%);
  transform: scale(calc(1 + var(--level, 0) * 0.45));
  opacity: calc(0.25 + var(--level, 0) * 0.75);
  transition: transform 0.08s linear, opacity 0.08s linear;
}
.lang {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 44px;
  padding: 0 6px 0 14px;
  border-radius: var(--r-pill);
  background: rgba(255, 255, 255, 0.72);
  backdrop-filter: blur(10px);
  font-size: 13px;
  font-weight: 500;
}
.lang select {
  max-width: 190px;
  height: 36px;
  padding: 0 8px;
  border: 0;
  border-radius: var(--r-pill);
  background: transparent;
  font: inherit;
  color: inherit;
  cursor: pointer;
}
.hint.note {
  color: #7a5200;
}
.ring {
  position: absolute;
  inset: 10%;
  border-radius: 50%;
  border: 2px solid rgba(31, 91, 255, 0.25);
  opacity: 0;
}
.listening .ring {
  animation: pulse 1.8s ease-out infinite;
}
.listening .r2 { animation-delay: 0.6s; }
.listening .r3 { animation-delay: 1.2s; }
.speaking .ring {
  border-color: rgba(23, 178, 106, 0.3);
  animation: pulse 1.1s ease-out infinite;
}
.speaking .r2 { animation-delay: 0.35s; }
.speaking .r3 { animation-delay: 0.7s; }
.thinking .r1 {
  opacity: 1;
  inset: 4%;
  border: 3px dashed rgba(31, 91, 255, 0.35);
  animation: spin 6s linear infinite;
}
@keyframes pulse {
  0% { opacity: 0.9; transform: scale(0.8); }
  100% { opacity: 0; transform: scale(1.6); }
}
@keyframes spin {
  to { transform: rotate(360deg); }
}

.captions {
  flex-shrink: 0;
  max-width: 760px;
  min-height: 90px;
}
.compact .pip-wrap :deep(svg) {
  width: 170px;
  height: 170px;
  transition: width 0.4s ease, height 0.4s ease;
}
.compact .captions {
  min-height: 0;
}
/* With product cards showing, make room for the reply and its chips on shorter screens. */
@media (max-height: 980px) {
  .compact .pip-wrap :deep(svg) {
    width: 120px;
    height: 120px;
  }
  .compact .you.small {
    display: none;
  }
  .compact {
    gap: 12px;
  }
}
.you {
  font-size: clamp(22px, 3vw, 34px);
  font-weight: 500;
  letter-spacing: -0.02em;
  line-height: 1.25;
}
.you.live {
  color: var(--blue);
}
.you.small {
  margin-bottom: 10px;
  font-size: 15px;
  font-weight: 400;
  color: var(--muted);
}
.pip-says {
  font-size: clamp(18px, 2.2vw, 24px);
  line-height: 1.45;
  animation: fadeUp 0.4s ease both;
}
.pip-says :deep(b) {
  font-weight: 600;
  color: var(--blue);
}
@keyframes fadeUp {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
}
.chips {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 8px;
  max-width: 760px;
}
.chips button {
  height: 40px;
  padding: 0 18px;
  border-radius: var(--r-pill);
  background: rgba(255, 255, 255, 0.8);
  backdrop-filter: blur(8px);
  font-size: 14px;
  font-weight: 500;
  transition: all 0.15s ease;
}
.chips button:hover {
  background: var(--blue);
  color: #fff;
}
.sizes button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  min-width: 56px;
  font-weight: 600;
}
.sizes button:disabled {
  opacity: 0.6;
  cursor: default;
}
.sizes button:disabled:hover {
  background: rgba(255, 255, 255, 0.8);
  color: inherit;
}
.sizes button.on,
.sizes button.on:hover {
  background: var(--ink);
  color: #fff;
  opacity: 1;
}
/* The colour the size buttons add. */
.sizes .colour {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 40px;
  padding: 0 14px;
  border-radius: var(--r-pill);
  background: rgba(255, 255, 255, 0.55);
  font-size: 14px;
  font-weight: 500;
}
.sizes .colour i {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  box-shadow: inset 0 0 0 1px rgba(20, 33, 77, 0.2);
}

/* Tray */
.tray {
  margin: 0 auto;
  width: min(1100px, calc(100% - 32px));
  padding: 16px 18px 10px;
  border-radius: 30px;
  background: rgba(255, 255, 255, 0.6);
  backdrop-filter: blur(16px);
  box-shadow: 0 20px 50px -30px rgba(20, 33, 77, 0.4);
}
.tray-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  padding: 0 4px 10px;
}
.tray-head b {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 15px;
  font-weight: 600;
}
.tray.live {
  box-shadow: 0 0 0 2px rgba(255, 59, 107, 0.35), 0 20px 50px -30px rgba(20, 33, 77, 0.4);
}
.live-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #ff3b6b;
  animation: livepulse 1s infinite;
}
@keyframes livepulse {
  50% { opacity: 0.25; }
}
.tray-head span {
  font-size: 12.5px;
  color: var(--muted);
}

/* Controls */
.controls {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  padding: 18px 24px 28px;
}
.hint {
  font-size: 14px;
  color: var(--muted);
}
.err {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 16px;
  border-radius: var(--r-pill);
  background: rgba(254, 243, 242, 0.95);
  color: #b42318;
  font-size: 13px;
}
.row {
  display: flex;
  align-items: center;
  gap: 22px;
}
.side {
  display: grid;
  place-items: center;
  width: 54px;
  height: 54px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.75);
  backdrop-filter: blur(8px);
}
.side:hover {
  background: #fff;
}
.big-mic {
  display: grid;
  place-items: center;
  width: 92px;
  height: 92px;
  border-radius: 50%;
  background: var(--blue);
  color: #fff;
  box-shadow: 0 20px 40px -14px rgba(31, 91, 255, 0.8);
  transition: transform 0.15s ease, background 0.2s ease;
}
.big-mic:hover:not(:disabled) {
  transform: scale(1.05);
}
.big-mic:disabled {
  cursor: default;
}
.big-mic.listening {
  background: #ff3b6b;
  animation: micring 1.3s infinite;
}
.big-mic.thinking {
  opacity: 0.7;
}
.big-mic {
  position: relative;
}
.big-mic.warn::after {
  content: '!';
  position: absolute;
  top: 2px;
  right: 2px;
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  border: 3px solid #fff;
  border-radius: 50%;
  background: #f79009;
  color: #fff;
  font-size: 14px;
  font-weight: 800;
  line-height: 1;
}
@keyframes micring {
  0% { box-shadow: 0 0 0 0 rgba(255, 59, 107, 0.45); }
  100% { box-shadow: 0 0 0 26px rgba(255, 59, 107, 0); }
}
.type {
  display: flex;
  gap: 8px;
  width: min(620px, 100%);
}
.type input {
  flex: 1;
  min-width: 0;
  height: 54px;
  padding: 0 22px;
  border: 1.5px solid transparent;
  border-radius: var(--r-pill);
  background: rgba(255, 255, 255, 0.9);
  font: inherit;
  font-size: 15px;
  outline: none;
}
.type input:focus {
  border-color: var(--blue);
}
.type button {
  display: grid;
  place-items: center;
  width: 54px;
  height: 54px;
  border-radius: 50%;
  background: var(--blue);
  color: #fff;
}
.type button:disabled {
  opacity: 0.45;
}

/* Transitions */
.stage-enter-active,
.stage-leave-active {
  transition: opacity 0.35s ease, clip-path 0.55s cubic-bezier(0.7, 0, 0.2, 1);
}
.stage-enter-from,
.stage-leave-to {
  opacity: 0;
  clip-path: circle(0% at calc(100% - 70px) calc(100% - 70px));
}
.stage-enter-to,
.stage-leave-from {
  clip-path: circle(150% at calc(100% - 70px) calc(100% - 70px));
}
.tray-enter-active,
.tray-leave-active {
  transition: all 0.45s cubic-bezier(0.2, 0.8, 0.2, 1);
}
.tray-enter-from,
.tray-leave-to {
  opacity: 0;
  transform: translateY(40px);
}
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

@media (max-width: 760px) {
  .bar {
    padding: 14px 16px;
  }
  .brand span,
  .tbtn:not(.icon) {
    display: none;
  }
  .pip-wrap :deep(svg) {
    width: 170px;
    height: 170px;
  }
  .captions {
    min-height: 70px;
  }
  .tray {
    padding: 12px 12px 6px;
    border-radius: 24px;
  }
  .tray-head span {
    display: none;
  }
}
@media (max-height: 760px) {
  .pip-wrap :deep(svg) {
    width: 160px;
    height: 160px;
  }
  .center {
    gap: 10px;
  }
}
</style>
