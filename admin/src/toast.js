import { reactive } from 'vue'

// Short confirmations and errors, shown bottom-centre by <Toasts>.
export const toasts = reactive([])
let id = 0
export function toast(message, kind = 'info') {
  if (toasts.some((t) => t.message === message)) return
  const t = { id: ++id, message, kind }
  toasts.push(t)
  setTimeout(() => toasts.splice(toasts.indexOf(t), 1), kind === 'error' ? 5200 : 2800)
}
