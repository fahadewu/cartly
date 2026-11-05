import { computed, reactive } from 'vue'
import { api } from './api.js'
import { deviceLocale, deviceTimeZone } from './agent/languages.js'

// The shopper's own festivals coming up (Eid, Durga Puja, Pohela Boishakh, Victory Day…) with the last day
// to order for delivery before each, worked out by the API from the store's posted delivery times. These are
// real deadlines, so the storefront shows them instead of countdown timers.
export const festival = reactive({ loaded: false, today: null, moments: [] })

let pending = null
export function loadFestivals() {
  const q = new URLSearchParams({ tz: deviceTimeZone() ?? '', locale: deviceLocale() })
  pending ??= api(`/festivals?${q}`)
    .then((r) => Object.assign(festival, { loaded: true, today: r.today, moments: r.moments ?? [] }))
    .catch(() => ((pending = null), festival))
  return pending
}

/** The nearest festival there's still time to order for, with its deadlines. */
export const next = computed(() => festival.moments.find((m) => Object.values(m.orderBy ?? {}).some(Boolean)) ?? null)

/** "Tue 8 Dec" */
export const fmtDay = (iso) => new Date(`${iso}T00:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })
/** "Victory Day" from "Pohela Boishakh (Bengali New Year)" → "Pohela Boishakh". */
export const shortName = (name) => name.replace(/\s*\(.*\)$/, '')
export const daysWord = (n) => (n === 0 ? 'today' : n === 1 ? 'tomorrow' : `in ${n} days`)
