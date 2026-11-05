import { reactive } from 'vue'
import { api, getToken } from './api.js'
import { auth, onAuthChange } from './auth.js'
import { toast } from './toast.js'

// "Ask family": looks the shopper shared for a vote. The API keeps each look (and its votes) for 7 days;
// this browser remembers the links it made and the key that proves it made them, so guests can follow
// their votes and stop sharing too. Signed-in shoppers' looks also come from the account.
const KEY = 'cartly.looks.v1'
const BASE = import.meta.env.VITE_API_URL ?? '/api/v1'
/** The owner's proofs: the account (if signed in) and the key this browser got when it shared the look. */
const ownerHeaders = (ownerKey) => ({ ...(ownerKey ? { 'x-look-key': ownerKey } : {}), ...(getToken() ? { authorization: `Bearer ${getToken()}` } : {}) })
const read = () => {
  try {
    return JSON.parse(localStorage.getItem(KEY)) ?? []
  } catch {
    return []
  }
}
const write = (list) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, 20)))
  } catch {}
}

export const looks = reactive({ list: [], loaded: false, unseen: 0 })

export const REACTIONS = [
  { id: 'love', emoji: '😍', en: 'Love it', bn: 'দারুণ!' },
  { id: 'yes', emoji: '👍', en: 'Buy it', bn: 'কিনে ফেলো' },
  { id: 'unsure', emoji: '🤔', en: 'Not sure', bn: 'বুঝতে পারছি না' },
  { id: 'no', emoji: '👎', en: 'Skip it', bn: 'বাদ দাও' },
]
export const TAGS = [
  { id: 'colour', en: 'Love the colour', bn: 'রংটা সুন্দর' },
  { id: 'other-colour', en: 'Try another colour', bn: 'অন্য রং দেখো' },
  { id: 'too-bright', en: 'Too bright', bn: 'বেশি চকচকে' },
  { id: 'occasion', en: 'Perfect for the occasion', bn: 'অনুষ্ঠানের জন্য পারফেক্ট' },
  { id: 'price', en: 'Worth the price', bn: 'দাম ঠিক আছে' },
  { id: 'pricey', en: 'Too pricey', bn: 'দাম বেশি' },
]

export const lookUrl = (token) => `${location.origin}/look/${token}`

/** Shares a look; resolves to { token, url }. `image` is a data URL or Blob of the fitting-room photo, only if they chose to include it. */
export async function shareLook({ items, note, name, image }) {
  const made = await api('/looks', { method: 'POST', body: { items, note: note || undefined, name: name || undefined } })
  const mine = [{ token: made.token, ownerKey: made.ownerKey, createdAt: new Date().toISOString(), seen: 0 }, ...read()]
  write(mine)
  if (image) {
    const blob = typeof image === 'string' ? await (await fetch(image)).blob() : image
    const form = new FormData()
    form.append('file', blob, 'look.jpg')
    try {
      await upload(made.token, made.ownerKey, form)
    } catch (e) {
      toast(`Shared without the photo: ${e.message}`, 'error')
    }
  }
  refreshLooks()
  return { token: made.token, url: lookUrl(made.token) }
}

const upload = (token, ownerKey, body) =>
  fetch(`${BASE}/looks/${token}/image`, { method: 'POST', headers: ownerHeaders(ownerKey), body }).then(async (r) => {
    if (!r.ok) throw new Error((await r.json().catch(() => null))?.message ?? 'the photo couldn’t be added')
  })

/** Every live look this shopper shared, newest first, with its votes. Expired links drop out. */
export async function refreshLooks() {
  const local = read()
  const fromAccount = auth.user ? await api('/looks/mine').catch(() => []) : []
  const known = new Set(fromAccount.map((l) => l.token))
  const others = local.filter((l) => !known.has(l.token))
  const fetched = await Promise.all(others.map((l) => api(`/looks/${l.token}`).catch((e) => (e.status === 404 ? 'gone' : null))))
  const gone = new Set(others.filter((_, i) => fetched[i] === 'gone').map((l) => l.token))
  if (gone.size) write(local.filter((l) => !gone.has(l.token)))
  const list = [...fromAccount, ...fetched.filter((r) => r && r !== 'gone')].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  // New votes since this browser last opened the Family votes page.
  const seen = new Map(read().map((l) => [l.token, l.seen ?? 0]))
  looks.unseen = list.reduce((n, l) => n + Math.max(0, l.total - (seen.get(l.token) ?? 0)), 0)
  Object.assign(looks, { list, loaded: true })
  return list
}

/** Marks every vote as seen (the Family votes page is open). */
export function markSeen() {
  const totals = new Map(looks.list.map((l) => [l.token, l.total]))
  const local = read()
  for (const l of looks.list) if (!local.some((x) => x.token === l.token)) local.push({ token: l.token, createdAt: l.createdAt, seen: 0 })
  write(local.map((l) => ({ ...l, seen: totals.get(l.token) ?? l.seen ?? 0 })))
  looks.unseen = 0
}

export async function stopSharing(token) {
  const ownerKey = read().find((l) => l.token === token)?.ownerKey
  const r = await fetch(`${BASE}/looks/${token}`, { method: 'DELETE', headers: ownerHeaders(ownerKey) })
  if (!r.ok && r.status !== 404) throw new Error('That look couldn’t be unshared. Try again.')
  write(read().filter((l) => l.token !== token))
  looks.list = looks.list.filter((l) => l.token !== token)
}

/** "Ammu voted 😍 on your look": checks for new votes every minute while the tab is open. */
let timer = null
export function watchLooks() {
  if (timer) return
  const tick = async () => {
    if (document.hidden || (!auth.user && !read().length)) return
    const before = looks.unseen
    await refreshLooks().catch(() => {})
    if (looks.unseen > before && looks.loaded) {
      const latest = looks.list.flatMap((l) => l.votes).sort((a, b) => b.at.localeCompare(a.at))[0]
      if (latest) toast(`${latest.name || 'Someone'} voted ${REACTIONS.find((r) => r.id === latest.reaction)?.emoji ?? ''} on your look`)
    }
  }
  tick()
  timer = setInterval(tick, 60_000)
}
onAuthChange(() => refreshLooks().catch(() => {}))
