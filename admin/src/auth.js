import { reactive, readonly } from 'vue'
import { api, getToken, setToken } from './api.js'

const state = reactive({ user: null, ready: false, offline: '' })
export const auth = readonly(state)

// Staff only: staff roles run the panel (what each may do comes from the API), riders get the rider app at /rider.
export const STAFF_ROLES = ['ADMIN', 'MANAGER', 'SUPPORT', 'MERCHANDISER', 'ANALYST']
const STAFF = [...STAFF_ROLES, 'RIDER']
export const isStaffRole = (role) => STAFF_ROLES.includes(role)

/** Whether the signed-in user's role grants a permission, e.g. can('orders.write'). The API enforces the same list. */
export const can = (permission) => !!state.user?.permissions?.includes(permission)
/** The first page this user may open: the dashboard for every staff role. */
export const home = () => (state.user?.role === 'RIDER' ? '/rider' : '/')
/** Updates the signed-in user after they change their own details or password. */
export function setUser(user) {
  state.user = { ...state.user, ...user }
}

/** Restores the session from the saved token (admins and riders). */
export async function restore() {
  state.offline = ''
  if (!getToken()) {
    state.ready = true
    return
  }
  try {
    const user = await api('/auth/me')
    if (STAFF.includes(user.role)) state.user = user
    else setToken(null)
  } catch (e) {
    if (e.status === 0) state.offline = e.message
    else setToken(null)
  } finally {
    state.ready = true
  }
}

export async function signIn(email, password) {
  const { accessToken, user } = await api('/auth/login', { method: 'POST', body: { email: email.trim(), password } })
  if (!STAFF.includes(user.role)) throw new Error('This account doesn’t have admin access.')
  setToken(accessToken)
  state.user = user
}

export function signOut() {
  setToken(null)
  state.user = null
}

// Roles change while people are signed in: a demoted manager would keep seeing write buttons, a promoted
// one would miss new areas. Re-read who we are when the tab comes back, at most every few minutes.
let lastRefresh = 0
export async function refreshUser() {
  if (!state.user || !getToken() || Date.now() - lastRefresh < 3 * 60_000) return
  lastRefresh = Date.now()
  try {
    const user = await api('/auth/me')
    if (STAFF.includes(user.role)) state.user = user
  } catch {
    // Offline or signed out: the 401 handler takes care of the latter.
  }
}
if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => !document.hidden && refreshUser())
