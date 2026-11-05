import { ref } from 'vue'

// One global toast message, shown by AppLayout. `kind`: 'success' (a tick) or 'error' (an alert icon,
// read out by screen readers), so "Out of stock" never looks like "Added".
export const toastMessage = ref('')
export const toastKind = ref('success')
let timer
export function toast(message, kind = 'success') {
  toastMessage.value = message
  toastKind.value = kind
  clearTimeout(timer)
  timer = setTimeout(() => (toastMessage.value = ''), kind === 'error' ? 3600 : 2400)
}
