import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { toast } from './toast.js'

/**
 * Loads data, tracks loading/error, and ignores stale responses.
 * A `quiet` reload that fails (a background poll on a flaky connection, a refresh after an action)
 * keeps what is on screen and says so in a toast, instead of replacing the page with an error block.
 */
export function useResource(fetcher, source) {
  const data = ref(null)
  const loading = ref(true)
  const error = ref('')
  let seq = 0
  async function load({ quiet = false } = {}) {
    const id = ++seq
    if (!quiet) loading.value = true
    if (!quiet || data.value == null) error.value = ''
    try {
      const result = await fetcher()
      if (id === seq) {
        data.value = result
        error.value = ''
      }
    } catch (e) {
      if (id !== seq) return
      if (quiet && data.value != null) toast(`Couldn’t refresh: ${e.message}`, 'error')
      else error.value = e.message
    } finally {
      if (id === seq) loading.value = false
    }
  }
  if (source) watch(source, () => load(), { immediate: true, deep: true })
  else load()
  return { data, loading, error, reload: load }
}

/**
 * Filters that live in the URL, so every list view is linkable.
 * Changing any filter other than `page` goes back to page 1.
 */
export function useQueryState(defaults) {
  const route = useRoute()
  const router = useRouter()
  const state = computed(() => {
    const q = { ...defaults }
    for (const k of Object.keys(defaults)) if (route.query[k] != null) q[k] = typeof defaults[k] === 'number' ? Number(route.query[k]) || defaults[k] : String(route.query[k])
    return q
  })
  function set(patch) {
    const next = { ...route.query, ...patch }
    if (!('page' in patch)) delete next.page
    for (const [k, v] of Object.entries(next)) if (v === '' || v == null || v === defaults[k]) delete next[k]
    router.replace({ query: next })
  }
  return { state, set }
}

/** A search box value that writes to the URL after the shopper stops typing. */
export function useDebouncedSearch(state, set, key = 'q', ms = 300) {
  const text = ref(state.value[key])
  let timer
  watch(text, (v) => {
    clearTimeout(timer)
    timer = setTimeout(() => set({ [key]: v.trim() }), ms)
  })
  watch(
    () => state.value[key],
    (v) => {
      if (v !== text.value.trim()) text.value = v
    },
  )
  return text
}

/**
 * Keeps `page` inside the list: deleting the last row on page 3 of 2, or filtering down, would otherwise
 * leave an empty page with no pager to get back from.
 */
export function clampPage(data, set) {
  watch(data, (d) => {
    if (d && Number(d.pages) >= 1 && Number(d.page) > Number(d.pages)) set({ page: Number(d.pages) })
  })
}
