import { createApp } from 'vue'
import './style.css'
import App from './App.vue'
import router from './router.js'
import { onSessionExpired } from './api.js'
import { restoreSession, signOut } from './auth.js'
import { loadCatalog } from './catalog.js'
import { loadCapabilities } from './capabilities.js'
import { trackPage } from './journey.js'
import { bdtRate } from './data.js'
import { onSignInNeeded, paymentMethods } from './store.js' // loads the shopper's cart, orders… on sign-in, so it must register first
import { toast } from './toast.js'

onSessionExpired(() => {
  signOut()
  router.replace({ name: 'login', query: { redirect: router.currentRoute.value.fullPath, expired: '1' } })
})
// Guests can browse; the cart and favourites are theirs once they sign in.
onSignInNeeded(() => {
  toast('Sign in to add things to your cart')
  router.push({ name: 'login', query: { redirect: router.currentRoute.value.fullPath } })
})

function offline(message) {
  const root = document.getElementById('app')
  root.replaceChildren()
  const box = Object.assign(document.createElement('main'), { className: 'boot-error' })
  const h1 = Object.assign(document.createElement('h1'), { textContent: 'The store isn’t reachable' })
  const p = Object.assign(document.createElement('p'), { textContent: `${message} If you’re running Cartly locally, start the API with “npm run start:dev” in backend/api.` })
  const retry = Object.assign(document.createElement('button'), { className: 'btn-primary sm', textContent: 'Try again', onclick: () => location.reload() })
  box.append(h1, p, retry)
  root.append(box)
}

loadCapabilities() // not awaited: AI features switch on as soon as it answers
try {
  // The catalog is the one thing the store can't open without. A saved session that can't be checked
  // right now (a dropped request) just means browsing as a guest until the next load.
  await Promise.all([loadCatalog(), restoreSession().catch(() => {})])
  router.afterEach((to, from, failure) => !failure && trackPage(to))
  createApp(App).use(router).mount('#app')
  // Not awaited: cards switch from dollars to taka as soon as the store's rate arrives.
  paymentMethods().then((m) => (bdtRate.value = m?.usdToBdt || null)).catch(() => {})
} catch (e) {
  offline(e.message)
}
