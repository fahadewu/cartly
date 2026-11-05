import { reactive, readonly } from 'vue'
import { api, setToken } from './api.js'

// Accounts live in the Cartly API. The access token is kept in localStorage when
// "Remember me" is ticked, otherwise only for this browser session.
const TOKEN_KEY = 'cartly.token'

export const DEMO = { email: 'demo@cartly.dev', password: 'Demo1234!' }

// The old offline demo kept accounts (passwords included), the session and the cart in
// localStorage. None of it is used any more, so clear it out.
try {
  ;['cartly.users', 'cartly.session', 'cartly.shop.v1'].forEach((k) => localStorage.removeItem(k))
} catch {}

const state = reactive({ user: null })
export const auth = readonly(state)

const listeners = new Set()
/** `fn(user)` runs after every sign-in and `fn(null)` after sign-out; sign-in waits for it. */
export const onAuthChange = (fn) => listeners.add(fn)
const notify = () => Promise.all([...listeners].map((fn) => fn(state.user)))

const storage = () => {
  try {
    return localStorage.getItem(TOKEN_KEY) ? localStorage : sessionStorage.getItem(TOKEN_KEY) ? sessionStorage : null
  } catch {
    return null
  }
}
function saveToken(token, remember) {
  try {
    localStorage.removeItem(TOKEN_KEY)
    sessionStorage.removeItem(TOKEN_KEY)
    if (token) (remember ? localStorage : sessionStorage).setItem(TOKEN_KEY, token)
  } catch {}
  setToken(token)
}

const toUser = (u) => ({ id: u.id, name: u.name, email: u.email, role: u.role, since: u.memberSince })

async function start({ accessToken, user }, remember) {
  saveToken(accessToken, remember)
  state.user = toUser(user)
  await notify()
}

/** Picks up a saved session on page load. */
export async function restoreSession() {
  const store = storage()
  const token = store?.getItem(TOKEN_KEY)
  if (!token) return
  setToken(token)
  try {
    state.user = toUser(await api('/auth/me'))
    await notify()
  } catch (e) {
    // Only forget the token when the server rejected it, not when it was unreachable.
    if (e.status === 401) saveToken(null)
    else throw e
  }
}

export async function signIn(email, password, remember = true) {
  await start(await api('/auth/login', { method: 'POST', body: { email: email.trim(), password } }), remember)
}

export async function signUp({ name, email, password }) {
  await start(await api('/auth/signup', { method: 'POST', body: { name, email: email.trim(), password } }), true)
}

export async function updateProfile({ name, email }) {
  const remember = storage() !== sessionStorage
  // The API returns a fresh token, since the email is part of it.
  const session = await api('/auth/me', { method: 'PATCH', body: { name: name.trim(), email: email.trim().toLowerCase() } })
  saveToken(session.accessToken, remember)
  state.user = toUser(session.user)
}

export async function changePassword(currentPassword, newPassword) {
  await api('/auth/change-password', { method: 'POST', body: { currentPassword, newPassword }, keepSession: true })
}

export function signOut() {
  saveToken(null)
  state.user = null
  notify()
}
