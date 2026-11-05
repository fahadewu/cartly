import { reactive } from 'vue'
import { api } from './api.js'

// What this deployment's AI service can do. Every feature has a fallback when it's off:
// Pip's rule brain (English), the on-device try-on preview, and the browser's own voice.
export const caps = reactive({
  loaded: false,
  agent: null, // 'claude' | 'rules' | null (AI service down)
  multilingual: false, // understands and answers in any language
  tryon: null, // 'fashn' when the AI try-on is on
  speech: { stt: null, tts: null }, // server speech-to-text (detects the language) and voice
})

let pending = null
export function loadCapabilities() {
  pending ??= api('/assistant/capabilities')
    .then((c) => Object.assign(caps, c))
    .catch(() => {})
    .finally(() => (caps.loaded = true))
  return pending
}
