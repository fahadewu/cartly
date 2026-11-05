import { auth, can } from './auth.js'

// v-can="'catalog.write'" on a button, link or input: locks it, with a tooltip saying why, when the
// signed-in role lacks the permission. The API refuses the same action anyway; this keeps the page honest.
// v-can.hide="'team.write'" removes it from view instead.
function apply(el, { value, modifiers }) {
  const allowed = !value || can(value)
  if (modifiers.hide) {
    el.style.display = allowed ? '' : 'none'
    return
  }
  if (allowed) {
    if (el.dataset.canLocked) {
      el.disabled = false
      el.removeAttribute('aria-disabled')
      el.classList.remove('locked')
      el.title = el.dataset.canTitle ?? ''
      delete el.dataset.canLocked
    }
    return
  }
  if (!el.dataset.canLocked) el.dataset.canTitle = el.title
  el.dataset.canLocked = '1'
  if ('disabled' in el) el.disabled = true
  el.setAttribute('aria-disabled', 'true')
  el.classList.add('locked')
  el.title = `Your role (${auth.user?.roleLabel ?? 'staff'}) can’t do this. Ask an admin if you need to.`
}
// A locked link must not navigate.
const stop = (e) => {
  if (e.currentTarget.dataset.canLocked) {
    e.preventDefault()
    e.stopImmediatePropagation()
  }
}

export const vCan = {
  mounted(el, binding) {
    el.addEventListener('click', stop, true)
    apply(el, binding)
  },
  updated: apply,
  unmounted: (el) => el.removeEventListener('click', stop, true),
}
