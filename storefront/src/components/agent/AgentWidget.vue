<script setup>
import { ref, nextTick, watch, onMounted, computed } from 'vue'
import { useRouter } from 'vue-router'
import Mascot from './Mascot.vue'
import AgentProducts from './AgentProducts.vue'
import CompareCard from './CompareCard.vue'
import HandoffCard from './HandoffCard.vue'
import AgentStage from './AgentStage.vue'
import VoiceNotice from './VoiceNotice.vue'
import Icon from '../Icon.vue'
import { useAgent, voiceSupported } from '../../agent/useAgent.js'
import { rich } from '../../agent/format.js'
import { productById } from '../../catalog.js'

const agent = useAgent()
const { state, face } = agent
agent.init(useRouter())

const draft = ref('')
const list = ref(null)
const input = ref(null)
const nudge = ref(false)

const statusLabel = computed(
  () => ({ listening: 'Listening…', thinking: 'Thinking…', speaking: 'Speaking…' })[state.status] ?? 'Online',
)
const lastAgent = computed(() => [...state.messages].reverse().find((m) => m.role === 'agent'))
const lastAgentId = computed(() => lastAgent.value?.id)
// Pip asked which size: the product's sizes as buttons, in the colour the shopper asked for (else its first),
// and a tap adds it without another message. A tick marks a size already in the cart in that colour.
const sizeAsk = computed(() => {
  const p = productById(lastAgent.value?.askSize)
  if (!p?.inStock || p.sizes.length < 2) return null
  const colour = p.colors.find((c) => c.name === lastAgent.value.askColor) ?? p.colors[0]
  const inCart = agent.cartVariants(p.id).filter((l) => l.color === colour?.name).map((l) => l.size)
  return { product: p, colour, inCart }
})

function submit() {
  const text = draft.value
  draft.value = ''
  agent.send(text)
}
function chip(text) {
  agent.send(text, { origin: 'chip' })
}

async function scrollDown() {
  await nextTick()
  list.value?.scrollTo({ top: list.value.scrollHeight, behavior: 'smooth' })
}
watch(() => [state.messages.length, state.status], scrollDown)
watch(
  () => state.mode,
  async (m) => {
    if (m === 'chat') {
      nudge.value = false
      await scrollDown()
      input.value?.focus({ preventScroll: true })
    }
  },
)
// Dictation in the chat box fills the input as you speak.
watch(
  () => state.interim,
  (t) => {
    if (state.mode === 'chat' && state.status === 'listening') draft.value = t
  },
)
// Once dictation ends the message is sent, so clear the leftover transcript.
watch(
  () => state.status,
  (now, before) => {
    if (before === 'listening' && now !== 'listening') draft.value = ''
  },
)

onMounted(() => {
  let seen = false
  try {
    seen = sessionStorage.getItem('cartly.agent.nudged') === '1'
  } catch {}
  if (!seen && state.mode === 'closed')
    setTimeout(() => {
      if (state.mode === 'closed') nudge.value = true
      try {
        sessionStorage.setItem('cartly.agent.nudged', '1')
      } catch {}
    }, 2500)
})

function toggle() {
  state.mode === 'closed' ? agent.open('chat') : agent.close()
}
</script>

<template>
  <!-- Launcher -->
  <div class="launcher-wrap" :class="{ hidden: state.mode === 'stage' }">
    <Transition name="pop">
      <div v-if="nudge && state.mode === 'closed'" class="nudge" role="status">
        <button class="nudge-close" aria-label="Dismiss" @click="nudge = false"><Icon name="close" :size="12" /></button>
        <b>Hi! I’m Pip 👋</b>
        <span>Need help finding something? Just ask, or talk to me.</span>
        <div class="nudge-acts">
          <button @click="agent.open('chat')">Chat</button>
          <button class="primary" @click="agent.open('stage')"><Icon name="mic" :size="14" />Talk</button>
        </div>
      </div>
    </Transition>
    <button
      class="launcher"
      :class="{ open: state.mode === 'chat' }"
      :aria-label="state.mode === 'chat' ? 'Close Pip' : 'Open Pip, your shopping assistant'"
      :aria-expanded="state.mode === 'chat'"
      @click="toggle"
    >
      <Mascot :state="state.mode === 'chat' ? face : 'idle'" :size="64" track />
      <span v-if="state.unread" class="badge">{{ state.unread }}</span>
    </button>
  </div>

  <!-- Chat panel -->
  <Transition name="panel">
    <section v-if="state.mode === 'chat'" class="panel" aria-label="Chat with Pip" @keydown.esc="agent.close()">
      <header>
        <div class="avatar"><Mascot :state="face" :size="46" /></div>
        <div class="title">
          <b>Pip</b>
          <span :class="['status', state.status]"><i />{{ statusLabel }}</span>
        </div>
        <button class="hbtn" title="Start over" aria-label="Start over" @click="agent.reset()"><Icon name="refresh" :size="17" /></button>
        <button class="hbtn voice" title="Full-screen voice mode" @click="agent.open('stage')">
          <Icon name="expand" :size="16" /><span>Voice mode</span>
        </button>
        <button class="hbtn" aria-label="Close chat" @click="agent.close()"><Icon name="close" :size="17" /></button>
      </header>

      <div ref="list" class="messages" aria-live="polite">
        <div v-for="m in state.messages" :key="m.id" class="msg" :class="m.role">
          <div class="bubble" dir="auto" :lang="m.lang" v-html="rich(m.text)" />
          <CompareCard v-if="m.compare?.length" :rows="m.compare" />
          <AgentProducts v-else-if="m.products?.length" :ids="m.products" :ask-size="m.askSize" :ask-color="m.askColor" />
          <HandoffCard v-if="m.handoff" />
          <!-- Not while Pip is answering: its reply may add the same thing. -->
          <div
            v-if="sizeAsk && m.id === lastAgentId && state.status !== 'thinking'"
            class="sizes"
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
              <Icon v-if="sizeAsk.inCart.includes(s)" name="check" :size="13" />{{ s }}
            </button>
          </div>
          <div v-if="m.chips?.length && m.id === lastAgentId && state.status !== 'thinking'" class="chips">
            <button v-for="c in m.chips" :key="c" dir="auto" @click="chip(c)">{{ c }}</button>
          </div>
        </div>
        <div v-if="state.status === 'thinking'" class="msg agent typing">
          <div class="bubble"><span /><span /><span /></div>
        </div>
      </div>

      <Transition name="live">
        <div v-if="state.status === 'listening' && state.live.length" class="live">
          <span><i />Matching as you speak…</span>
          <AgentProducts :ids="state.live" />
        </div>
      </Transition>

      <VoiceNotice />
      <p v-if="state.error" class="err"><Icon name="alert" :size="14" />{{ state.error }}</p>
      <p v-else-if="state.note" class="err note">{{ state.note }}</p>

      <form class="composer" @submit.prevent="submit">
        <button
          v-if="voiceSupported"
          type="button"
          class="mic"
          :class="{ on: state.status === 'listening', warn: state.voiceIssue }"
          :aria-label="state.status === 'listening' ? 'Stop listening' : 'Speak your message'"
          :disabled="state.status === 'thinking'"
          @click="agent.listen()"
        >
          <Icon name="mic" :size="19" />
        </button>
        <!-- Says what Pip is for, so fewer messages are about something else. -->
        <input
          ref="input"
          v-model="draft"
          dir="auto"
          :placeholder="state.status === 'listening' ? 'Listening…' : 'Ask about products, sizes, orders…'"
          aria-label="Message Pip"
          maxlength="300"
        />
        <button class="send" type="submit" :disabled="!draft.trim() || state.status === 'thinking'" aria-label="Send">
          <Icon name="send" :size="18" />
        </button>
      </form>
    </section>
  </Transition>

  <AgentStage />
</template>

<style scoped>
.launcher-wrap {
  position: fixed;
  right: 28px;
  bottom: 28px;
  z-index: 55;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 12px;
  transition: opacity 0.2s ease, transform 0.2s ease;
}
.launcher-wrap.hidden {
  opacity: 0;
  pointer-events: none;
  transform: scale(0.8);
}
.launcher {
  position: relative;
  display: grid;
  place-items: center;
  width: 84px;
  height: 84px;
  border-radius: 30px;
  background: #fff;
  box-shadow: 0 18px 40px -12px rgba(31, 91, 255, 0.45), 0 0 0 6px rgba(255, 255, 255, 0.6);
  transition: transform 0.2s ease, border-radius 0.3s ease;
}
.launcher:hover {
  transform: translateY(-3px) rotate(-3deg);
}
.launcher.open {
  border-radius: 50%;
}
.badge {
  position: absolute;
  top: -4px;
  right: -4px;
  display: grid;
  place-items: center;
  min-width: 24px;
  height: 24px;
  padding: 0 6px;
  border-radius: 12px;
  background: #ff3b6b;
  color: #fff;
  font-size: 12px;
  font-weight: 600;
}

.nudge {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 250px;
  padding: 16px 18px;
  border-radius: 24px 24px 8px 24px;
  background: #fff;
  box-shadow: 0 20px 40px -16px rgba(20, 33, 77, 0.35);
  font-size: 13px;
}
.nudge b {
  font-size: 15px;
  font-weight: 600;
}
.nudge span {
  color: var(--muted);
  line-height: 1.4;
}
.nudge-close {
  position: absolute;
  top: 10px;
  right: 10px;
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background: var(--chip);
  color: var(--muted);
}
.nudge-acts {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
  margin-top: 8px;
}
.nudge-acts button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  height: 36px;
  border-radius: var(--r-pill);
  background: var(--chip);
  font-size: 13px;
  font-weight: 500;
}
.nudge-acts .primary {
  background: var(--blue);
  color: #fff;
}

/* Panel */
.panel {
  position: fixed;
  right: 28px;
  bottom: 128px;
  z-index: 56;
  display: flex;
  flex-direction: column;
  width: 410px;
  height: min(660px, calc(100vh - 160px));
  border-radius: 34px;
  background: #fff;
  box-shadow: 0 40px 80px -24px rgba(20, 33, 77, 0.35), 0 0 0 1px rgba(20, 33, 77, 0.04);
  overflow: hidden;
}
header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 16px 16px 14px 18px;
  background: linear-gradient(135deg, var(--mint), #d9f7ea 60%, var(--butter));
}
.avatar {
  display: grid;
  place-items: center;
  width: 54px;
  height: 54px;
  border-radius: 20px;
  background: rgba(255, 255, 255, 0.7);
}
.title {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.title b {
  font-size: 17px;
  font-weight: 600;
}
.status {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: #3b5a4a;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.status i {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #17b26a;
}
.status.listening i {
  background: #ff3b6b;
  animation: blink 0.8s infinite;
}
.status.thinking i,
.status.speaking i {
  background: var(--blue);
  animation: blink 0.8s infinite;
}
@keyframes blink {
  50% { opacity: 0.2; }
}
.hbtn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 36px;
  min-width: 36px;
  padding: 0 8px;
  border-radius: 13px;
  background: rgba(255, 255, 255, 0.75);
  font-size: 12px;
  font-weight: 600;
  transition: background 0.2s ease;
}
.hbtn:hover {
  background: #fff;
}
.hbtn.voice {
  padding: 0 12px;
  background: var(--ink);
  color: #fff;
}
.hbtn.voice:hover {
  background: var(--blue);
}

.messages {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 18px 16px;
  overflow-y: auto;
  background: #fafbfc;
}
.msg {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-width: 100%;
  animation: msg 0.3s ease both;
}
@keyframes msg {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
}
.bubble {
  max-width: 88%;
  padding: 12px 16px;
  border-radius: 22px;
  font-size: 14px;
  line-height: 1.5;
}
.agent .bubble {
  align-self: flex-start;
  border-bottom-left-radius: 8px;
  background: #fff;
  box-shadow: 0 4px 14px -8px rgba(20, 33, 77, 0.25);
}
.user .bubble {
  align-self: flex-end;
  border-bottom-right-radius: 8px;
  background: var(--blue);
  color: #fff;
}
.bubble :deep(b) {
  font-weight: 600;
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.chips button {
  height: 32px;
  padding: 0 12px;
  border: 1.5px solid #d9e3ff;
  border-radius: var(--r-pill);
  background: #fff;
  color: var(--blue);
  font-size: 12.5px;
  font-weight: 500;
  transition: all 0.15s ease;
}
.chips button:hover {
  border-color: var(--blue);
  background: var(--blue-soft);
}
.sizes {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.sizes button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  min-width: 44px;
  height: 32px;
  padding: 0 12px;
  border: 1.5px solid #d9e3ff;
  border-radius: var(--r-pill);
  background: #fff;
  color: var(--blue);
  font-size: 12.5px;
  font-weight: 600;
  transition: all 0.15s ease;
}
.sizes button:hover:not(:disabled) {
  border-color: var(--blue);
  background: var(--blue-soft);
}
.sizes button:disabled {
  opacity: 0.6;
  cursor: default;
}
.sizes button.on {
  border-color: var(--ink);
  background: var(--ink);
  color: #fff;
  opacity: 1;
}
/* The colour the size buttons add. */
.sizes .colour {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 32px;
  padding: 0 4px;
  color: var(--muted);
  font-size: 12.5px;
  font-weight: 500;
}
.sizes .colour i {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  box-shadow: inset 0 0 0 1px rgba(20, 33, 77, 0.2);
}
.typing .bubble {
  display: flex;
  gap: 5px;
  padding: 16px 18px;
}
.typing span {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #b7c3e0;
  animation: bounce 1s infinite;
}
.typing span:nth-child(2) { animation-delay: 0.15s; }
.typing span:nth-child(3) { animation-delay: 0.3s; }
@keyframes bounce {
  30% { transform: translateY(-5px); background: var(--blue); }
}

.live {
  padding: 10px 14px 0;
  border-top: 1px solid var(--line);
  background: #fff;
}
.live > span {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  font-weight: 600;
  color: #ff3b6b;
}
.live i {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #ff3b6b;
  animation: blink 0.8s infinite;
}
.live-enter-active,
.live-leave-active {
  transition: all 0.25s ease;
}
.live-enter-from,
.live-leave-to {
  opacity: 0;
  transform: translateY(8px);
}
.err {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 16px;
  padding: 10px 12px;
  border-radius: 14px;
  background: #fef3f2;
  color: #b42318;
  font-size: 12.5px;
}
.err.note {
  background: #fff4d6;
  color: #7a5200;
}

.composer {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 14px 16px;
  border-top: 1px solid var(--line);
}
.composer input {
  flex: 1;
  min-width: 0;
  height: 48px;
  padding: 0 18px;
  border: 1.5px solid transparent;
  border-radius: var(--r-pill);
  background: var(--chip);
  font: inherit;
  font-size: 14px;
  outline: none;
}
.composer input:focus {
  border-color: var(--blue);
  background: #fff;
}
.mic,
.send {
  display: grid;
  place-items: center;
  flex-shrink: 0;
  width: 48px;
  height: 48px;
  border-radius: 50%;
}
.mic {
  background: var(--chip);
  position: relative;
}
.mic:disabled {
  opacity: 0.5;
  cursor: default;
}
.mic.warn::after {
  content: '!';
  position: absolute;
  top: -2px;
  right: -2px;
  display: grid;
  place-items: center;
  width: 16px;
  height: 16px;
  border: 2px solid #fff;
  border-radius: 50%;
  background: #f79009;
  color: #fff;
  font-size: 10px;
  font-weight: 800;
  line-height: 1;
}
.mic.on {
  background: #ff3b6b;
  color: #fff;
  animation: ring 1.2s infinite;
}
@keyframes ring {
  0% { box-shadow: 0 0 0 0 rgba(255, 59, 107, 0.5); }
  100% { box-shadow: 0 0 0 14px rgba(255, 59, 107, 0); }
}
.send {
  background: var(--blue);
  color: #fff;
}
.send:disabled {
  opacity: 0.4;
}

.panel-enter-active,
.panel-leave-active {
  transition: opacity 0.25s ease, transform 0.3s cubic-bezier(0.2, 0.8, 0.2, 1);
  transform-origin: bottom right;
}
.panel-enter-from,
.panel-leave-to {
  opacity: 0;
  transform: translateY(16px) scale(0.92);
}
.pop-enter-active,
.pop-leave-active {
  transition: all 0.3s cubic-bezier(0.2, 0.8, 0.2, 1);
  transform-origin: bottom right;
}
.pop-enter-from,
.pop-leave-to {
  opacity: 0;
  transform: scale(0.85) translateY(8px);
}

@media (max-width: 560px) {
  .launcher-wrap {
    right: 16px;
    bottom: 16px;
  }
  .launcher {
    width: 70px;
    height: 70px;
    border-radius: 26px;
  }
  .panel {
    inset: 0;
    width: auto;
    height: auto;
    border-radius: 0;
  }
  .launcher-wrap:has(+ .panel) {
    display: none;
  }
  .hbtn.voice span {
    display: none;
  }
}
</style>
