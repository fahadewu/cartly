import { toast } from './toast.js'

// Talks to the NestJS commerce API. In development Vite proxies /api to API_PORT from ../backend/.env (4100).
const BASE = import.meta.env.VITE_API_URL ?? '/api/v1'
const TOKEN_KEY = 'cartly.admin.token'
export const STOREFRONT_URL = (import.meta.env.VITE_STOREFRONT_URL ?? 'http://localhost:5173').replace(/\/$/, '')

export class ApiError extends Error {
  constructor(message, status, body) {
    super(message)
    this.status = status
    this.body = body
  }
}

export function getToken() {
  try {
    return localStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}
export function setToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token)
    else localStorage.removeItem(TOKEN_KEY)
  } catch {}
}

let onUnauthorized = () => {}
/** Called when a signed-in request comes back 401 (expired or revoked session). */
export const handleUnauthorized = (fn) => (onUnauthorized = fn)

const sentence = (s) => {
  const t = String(s).trim()
  return t ? t[0].toUpperCase() + t.slice(1).replace(/[.!]?$/, '.') : ''
}
// Nest returns { message: string | string[] } — validation errors come as a list.
function messageOf(body, status) {
  const m = body?.message
  if (Array.isArray(m)) return m.map(sentence).join(' ')
  if (typeof m === 'string' && m) return sentence(m)
  if (status === 429) return 'Too many requests. Wait a minute and try again.'
  if (status >= 500) return 'The API hit a problem. Try again in a moment.'
  return `Request failed (${status}).`
}

// Nothing in the panel should wait longer than this for one answer; a rider on a stalled connection
// gets a message and a retry instead of a button stuck on "Saving…".
const TIMEOUT_MS = 20_000
const OFFLINE = import.meta.env.DEV
  ? 'Can’t reach the Cartly API. Check that it’s running (API_PORT in backend/.env, 4100 by default), then try again.'
  : 'No connection. Check your signal and try again.'

/**
 * `keepSession`: a 401 from this call means "wrong password", not "signed out" (changing a password
 * with the wrong current one), so it must not end the session.
 */
export async function api(path, { method = 'GET', body, query, keepSession = false } = {}) {
  const url = new URL(BASE + path, window.location.origin)
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v)
  const token = getToken()
  const headers = {}
  const form = body instanceof FormData
  if (body !== undefined && !form) headers['content-type'] = 'application/json'
  if (token) headers.authorization = `Bearer ${token}`

  let res
  try {
    res = await fetch(url, { method, headers, body: body === undefined || form ? body : JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS) })
  } catch (e) {
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') throw new ApiError('That took too long. Check your connection and try again.', 0)
    throw new ApiError(OFFLINE, 0)
  }
  if (res.status === 204) return null
  const data = await res.json().catch(() => null)
  if (!res.ok) {
    if (res.status === 401 && token && !keepSession) onUnauthorized()
    if (res.status === 403) toast('You don’t have permission to do that.', 'error')
    throw new ApiError(messageOf(data, res.status), res.status, data)
  }
  return data
}

export const get = (path, query) => api(path, { query })
export const post = (path, body, opts) => api(path, { method: 'POST', body: body ?? {}, ...opts })
export const patch = (path, body) => api(path, { method: 'PATCH', body })
export const del = (path) => api(path, { method: 'DELETE' })
/** Multipart upload: `fields` are sent alongside the file. */
export function upload(path, file, fields = {}, name = 'file') {
  const form = new FormData()
  for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== null) form.append(k, Array.isArray(v) ? JSON.stringify(v) : String(v))
  form.append(name, file)
  return api(path, { method: 'POST', body: form })
}

/** Saves a file the API sends (a CSV export) under the name it gives, signed in. */
export async function download(path, query, fallbackName = 'download') {
  const url = new URL(BASE + path, window.location.origin)
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v)
  const token = getToken()
  let res
  try {
    res = await fetch(url, { headers: token ? { authorization: `Bearer ${token}` } : {} })
  } catch {
    throw new ApiError('Can’t reach the Cartly API. Check that it’s running, then try again.', 0)
  }
  if (!res.ok) {
    const data = await res.json().catch(() => null)
    if (res.status === 401 && token) onUnauthorized()
    throw new ApiError(messageOf(data, res.status), res.status, data)
  }
  const name = res.headers.get('content-disposition')?.match(/filename="([^"]+)"/)?.[1] ?? fallbackName
  const link = Object.assign(document.createElement('a'), { href: URL.createObjectURL(await res.blob()), download: name })
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(link.href), 10_000)
}
