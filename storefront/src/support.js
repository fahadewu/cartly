import { reactive } from 'vue'
import { api } from './api.js'

// How to reach a person on the team (Admin → Returns → Support contact). Pip's hand-off card shows these;
// with none set, Pip doesn't offer a hand-off at all.
export const support = reactive({ loaded: false, whatsapp: null, phone: null, hours: null })
let pending = null
export const loadSupport = () => (pending ??= api('/support').then((s) => Object.assign(support, s, { loaded: true })).catch(() => ((pending = null), support)))
export const hasSupport = () => !!(support.whatsapp || support.phone)
