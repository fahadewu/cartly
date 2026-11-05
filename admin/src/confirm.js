import { reactive } from 'vue'

// One accessible confirm dialog for the whole app, rendered by <ConfirmHost>.
export const dialog = reactive({ open: false, title: '', body: '', confirmLabel: 'Confirm', danger: false, resolve: null })

export function confirm({ title, body = '', confirmLabel = 'Confirm', danger = false }) {
  dialog.resolve?.(false)
  return new Promise((resolve) => Object.assign(dialog, { open: true, title, body, confirmLabel, danger, resolve }))
}
export function settle(answer) {
  const r = dialog.resolve
  Object.assign(dialog, { open: false, resolve: null })
  r?.(answer)
}
