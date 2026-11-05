<script setup>
import { useRoute, useRouter } from 'vue-router'
import Icon from '../Icon.vue'
import { useAgent } from '../../agent/useAgent.js'

defineProps({ dark: Boolean })

const agent = useAgent()
const { state } = agent
const route = useRoute()
const router = useRouter()

function signIn() {
  agent.dismissVoiceIssue()
  if (state.mode === 'stage') agent.toChat()
  router.push({ name: 'login', query: { redirect: route.fullPath } })
}
</script>

<template>
  <Transition name="notice">
    <div v-if="state.voiceIssue" class="notice" :class="[state.voiceIssue.kind, { dark }]" role="alert">
      <span class="icon"><Icon :name="state.voiceIssue.kind === 'offline' ? 'globe' : 'mic'" :size="16" /><i /></span>
      <div class="text">
        <b>{{ state.voiceIssue.title }}</b>
        <p>{{ state.voiceIssue.body }}</p>
        <button v-if="state.voiceIssue.signIn" class="act" @click="signIn">Sign in for voice</button>
      </div>
      <button class="x" aria-label="Dismiss" @click="agent.dismissVoiceIssue()"><Icon name="close" :size="14" /></button>
    </div>
  </Transition>
</template>

<style scoped>
.notice {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  margin: 0 16px;
  padding: 12px 12px 12px 14px;
  border-radius: 16px;
  background: #fff4d6;
  color: #5c3d00;
  text-align: left;
}
.notice.blocked,
.notice.offline {
  background: #fef3f2;
  color: #912018;
}
.notice.dark {
  margin: 0;
  max-width: 520px;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.12);
}
.icon {
  position: relative;
  flex: none;
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.7);
}
/* a slash through the mic: voice is off, not broken */
.icon i {
  position: absolute;
  width: 2px;
  height: 22px;
  border-radius: 2px;
  background: currentColor;
  transform: rotate(-45deg);
}
.text {
  flex: 1;
  min-width: 0;
}
.text b {
  display: block;
  font-size: 13px;
  font-weight: 650;
  margin-bottom: 2px;
}
.text p {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.45;
  opacity: 0.9;
}
.act {
  margin-top: 8px;
  padding: 6px 12px;
  border: 0;
  border-radius: var(--r-pill);
  background: var(--ink);
  color: #fff;
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}
.x {
  flex: none;
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: inherit;
  cursor: pointer;
  opacity: 0.6;
}
.x:hover {
  opacity: 1;
  background: rgba(0, 0, 0, 0.06);
}
.notice-enter-active,
.notice-leave-active {
  transition: opacity 0.2s, transform 0.2s;
}
.notice-enter-from,
.notice-leave-to {
  opacity: 0;
  transform: translateY(6px);
}
</style>
