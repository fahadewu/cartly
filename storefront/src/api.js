// Thin client for the Cartly commerce API (backend/api). In development Vite proxies
// /api to the API (API_PORT in ../backend/.env, 4100 by default); set VITE_API_URL to point a build somewhere else.
const BASE = import.meta.env.VITE_API_URL ?? '/api/v1'

let token = null
let sessionExpired = () => {}

export const setToken = (t) => (token = t)
export const getToken = () => token
/** Called when a signed-in request comes back 401 (the token expired or was revoked). */
export const onSessionExpired = (fn) => (sessionExpired = fn)

export class ApiError extends Error {
  constructor(message, status, body) {
    super(message)
    this.status = status
    this.body = body
  }
}

const FALLBACK = {
  0: 'Can’t reach Cartly right now. Check your connection and try again.',
  429: 'That’s a lot of attempts. Please wait a minute and try again.',
  500: 'Something went wrong on our side. Please try again.',
}

/**
 * `api('/cart/items', { method: 'POST', body: {...} })` → parsed JSON, or throws ApiError
 * with the server's message. `body` may be FormData (file uploads); `raw` returns the
 * Response itself (e.g. audio). `keepSession` stops a 401 from signing the shopper out
 * (e.g. "current password is incorrect").
 */
/** No ordinary request waits longer than this; Pip and try-on pass their own `timeout`. */
const TIMEOUT_MS = 20_000

export async function api(path, { method = 'GET', body, signal, keepSession = false, raw = false, timeout = TIMEOUT_MS } = {}) {
  const headers = {}
  const form = typeof FormData !== 'undefined' && body instanceof FormData
  if (body !== undefined && !form) headers['content-type'] = 'application/json'
  if (token) headers.authorization = `Bearer ${token}`
  signal ??= AbortSignal.timeout(timeout)
  let res
  try {
    res = await fetch(BASE + path, { method, headers, body: body === undefined || form ? body : JSON.stringify(body), signal })
  } catch (e) {
    if (e.name === 'TimeoutError') throw new ApiError('That took too long. Check your connection and try again.', 0)
    if (e.name === 'AbortError') throw e
    throw new ApiError(FALLBACK[0], 0)
  }
  if (res.status === 204) return null
  if (raw && res.ok) return res
  const data = await res.json().catch(() => null)
  if (!res.ok) {
    if (res.status === 401 && token && !keepSession) sessionExpired()
    const message = Array.isArray(data?.message) ? data.message.join(' ') : data?.message
    throw new ApiError(message || FALLBACK[res.status] || FALLBACK[res.status >= 500 ? 500 : 0], res.status, data)
  }
  return data
}
