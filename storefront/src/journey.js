import { getToken } from './api.js'

// Visitor journeys for the store's analytics: which pages a visit went through, how long each was
// actually on screen, how far down it was scrolled, where the visit came from and where it ended.
//
// Built to cost the shopper nothing:
// - No timers run while browsing; time is measured from timestamps when a page is left.
// - Pages go out in one small batch a few seconds after navigation settles (in idle time), or at once
//   with `keepalive` when the tab is hidden or closed. A failed send is dropped, never retried in a loop.
// - Scroll depth is read at most once per animation frame, from a passive listener.
// Visitors who ask not to be tracked (Global Privacy Control or Do Not Track) aren't tracked at all.

const BASE = import.meta.env.VITE_API_URL ?? '/api/v1'
const VISIT_IDLE = 30 * 60e3 // a new visit after this long without activity
const PAGE_IDLE = 5 * 60e3 // time on a page stops counting after this long without any input
const SEND_AFTER = 4000
const MAX_BATCH = 20

const nav = typeof navigator !== 'undefined' ? navigator : {}
const optedOut = typeof window === 'undefined' || nav.globalPrivacyControl === true || nav.doNotTrack === '1' || window.doNotTrack === '1'

const id = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
const read = (k) => {
  try {
    return JSON.parse(localStorage.getItem(k))
  } catch {
    return null
  }
}
const write = (k, v) => {
  try {
    localStorage.setItem(k, JSON.stringify(v))
  } catch {
    // private mode or storage full: tracking still works for this page load
  }
}

let visitorId = null
let visit = null // { id, last, seq } shared by the shopper's tabs through localStorage
let start = null // where the visit came from, sent with its first batch
let page = null // { seq, path, route, at, ms, scroll }
let activeFrom = null
let lastInput = 0
const queue = new Map() // seq → latest snapshot of that page
let timer = null
let referred = false

function touchVisit(now, landing) {
  visit = read('cartly.visit')
  if (!visit?.id || now - visit.last > VISIT_IDLE) {
    if (queue.size) send() // what's left of the visit that just ended
    visit = { id: id(), last: now, seq: 0 }
    const q = new URLSearchParams(location.search)
    start = {
      landing,
      // The referrer belongs to the page load, so only the load's first visit came from it.
      referrer: (!referred && document.referrer) || undefined,
      utmSource: q.get('utm_source') || undefined,
      utmMedium: q.get('utm_medium') || undefined,
      utmCampaign: q.get('utm_campaign') || undefined,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      locale: nav.language,
    }
    referred = true
  }
  visit.last = now
  write('cartly.visit', visit)
}

/** Adds the time since the last check, if the page was on screen and someone was there. */
function accrue(now) {
  if (!page || activeFrom == null) return
  const end = Math.min(now, lastInput + PAGE_IDLE)
  if (end > activeFrom) page.ms += end - activeFrom
  activeFrom = now <= lastInput + PAGE_IDLE ? now : null
}

function snapshot() {
  if (page) queue.set(page.seq, { seq: page.seq, path: page.path, route: page.route, at: page.at, ms: Math.round(page.ms), scroll: page.scroll })
}

function send() {
  clearTimeout(timer)
  timer = null
  if (!visit || (!queue.size && !start)) return
  const pages = [...queue.values()].slice(0, 50)
  const body = JSON.stringify({ visitorId, visitId: visit.id, ...(start && { start }), pages, at: Date.now() })
  queue.clear()
  start = null
  const headers = { 'content-type': 'application/json' }
  const token = getToken()
  if (token) headers.authorization = `Bearer ${token}`
  // keepalive lets the request finish after the tab closes; it's also what sendBeacon uses, but with headers.
  fetch(`${BASE}/track`, { method: 'POST', headers, body, keepalive: true }).catch(() => {})
}

function later() {
  if (queue.size >= MAX_BATCH) return send()
  timer ??= setTimeout(() => (window.requestIdleCallback ? requestIdleCallback(send, { timeout: 4000 }) : send()), SEND_AFTER)
}

/** Call on every route change (router.afterEach). */
export function trackPage(to) {
  if (optedOut) return
  if (page && to.path === page.path) return // only the query changed (filters, search as you type)
  const now = Date.now()
  accrue(now)
  snapshot()
  touchVisit(now, to.path)
  visit.seq += 1
  write('cartly.visit', visit)
  page = { seq: visit.seq, path: to.path, route: String(to.name ?? 'other'), at: now, ms: 0, scroll: 0 }
  lastInput = now
  activeFrom = document.visibilityState === 'visible' ? now : null
  later()
}

function onInput() {
  const now = Date.now()
  if (now - lastInput < 1000) return
  if (activeFrom == null && page && document.visibilityState === 'visible') {
    // Back after a pause: if it was long, this is a new visit continuing on the same page.
    if (now - (read('cartly.visit')?.last ?? 0) > VISIT_IDLE) {
      lastInput = now
      const resumed = page
      page = null
      return trackPage({ path: resumed.path, name: resumed.route })
    }
    activeFrom = now
  }
  lastInput = now
}

let scrollQueued = false
function onScroll() {
  onInput()
  if (scrollQueued || !page) return
  scrollQueued = true
  requestAnimationFrame(() => {
    scrollQueued = false
    const el = document.documentElement
    const max = el.scrollHeight - el.clientHeight
    const pct = max > 0 ? Math.min(100, Math.round((el.scrollTop / max) * 100)) : 100
    if (page && pct > page.scroll) page.scroll = pct
  })
}

function onHide() {
  const now = Date.now()
  accrue(now)
  activeFrom = null
  snapshot()
  if (visit) {
    visit.last = now
    write('cartly.visit', visit)
  }
  send()
}

if (!optedOut) {
  visitorId = read('cartly.vid')
  if (!visitorId) write('cartly.vid', (visitorId = id()))
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') onHide()
    else onInput()
  })
  addEventListener('pagehide', onHide)
  for (const type of ['pointerdown', 'keydown', 'touchstart']) addEventListener(type, onInput, { passive: true, capture: true })
  addEventListener('scroll', onScroll, { passive: true })
}
