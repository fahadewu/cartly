<script setup>
import { computed, watch } from 'vue'
import Dialog from './Dialog.vue'
import StateBlock from './StateBlock.vue'
import { get } from '../api.js'
import { useResource } from '../composables.js'
import { dateTime, money, time } from '../format.js'

// One visit step by step: every page with the time it was on screen, what the shopper did there,
// any order placed, and the page they left from. `id` opens it; `close` is emitted to shut it.
const props = defineProps({ id: { type: String, default: null } })
const emit = defineEmits(['close'])

const { data: d, loading, error, reload } = useResource(() => (props.id ? get(`/admin/analytics/visits/${props.id}`) : Promise.resolve(null)), () => props.id)
watch(
  () => props.id,
  (id) => !id && (d.value = null),
)

const ACTION = { view: 'Viewed', search: 'Searched', cart_add: 'Added to cart', favourite: 'Saved to favourites', tryon: 'Tried on', order: 'Placed order' }
const seconds = (s) => (s == null ? '—' : s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`)
const v = computed(() => d.value?.visit)
const lastPage = computed(() => {
  const pages = (d.value?.timeline ?? []).filter((t) => t.kind === 'page')
  return pages.at(-1)
})
const where = (x) => [x.city, x.region, x.country].filter(Boolean).join(', ') || 'Unknown'
</script>

<template>
  <Dialog :open="!!id" title="Visit journey" wide @close="emit('close')">
    <StateBlock :loading="loading && !d" :error="error" @retry="reload">
      <template v-if="d && v">
        <dl class="meta small">
          <dt>Who</dt><dd>{{ v.user ? `${v.user.name} (${v.user.email})` : 'Not signed in' }}</dd>
          <dt>When</dt><dd>{{ dateTime(v.startedAt) }} – {{ time(v.lastSeenAt) }} · {{ seconds(Math.round(v.activeMs / 1000)) }} on screen</dd>
          <dt>Came from</dt><dd>{{ v.source }}{{ v.referrer ? ` · ${v.referrer}` : '' }}{{ v.campaign ? ` · campaign ${v.campaign}` : '' }}</dd>
          <dt>Where</dt><dd>{{ where(v) }}<span v-if="v.geoSource" class="muted"> ({{ v.geoSource === 'device' ? 'from device time zone' : v.geoSource }})</span></dd>
          <dt>Device</dt><dd>{{ [v.device, v.browser, v.os].filter(Boolean).join(' · ') || '—' }}</dd>
        </dl>
        <ol class="timeline">
          <li v-for="(t, i) in d.timeline" :key="i" :class="[t.kind === 'page' ? 'page' : 'action', { exit: t === lastPage }]">
            <span class="at muted figures">{{ time(t.at) }}</span>
            <div v-if="t.kind === 'page'">
              <strong>{{ t.path }}</strong>
              <span class="muted"> · {{ seconds(t.seconds) }}{{ t.scroll != null ? ` · scrolled ${t.scroll}%` : '' }}</span>
              <span v-if="t === lastPage" class="left">Left here</span>
            </div>
            <div v-else-if="t.kind === 'order'">
              <strong>{{ ACTION.order }}</strong> <RouterLink :to="`/orders/${t.orderId}`" @click="emit('close')">{{ t.orderId }}</RouterLink>
              <span class="muted"> · {{ money(t.total) }} · {{ t.status.toLowerCase() }}</span>
            </div>
            <div v-else>
              {{ ACTION[t.kind] ?? t.kind }}
              <template v-if="t.kind === 'search'"> “{{ t.query }}”</template>
              <RouterLink v-else-if="t.productId" :to="`/products/${t.productId}`" @click="emit('close')">{{ t.product ?? `#${t.productId}` }}</RouterLink>
            </div>
          </li>
        </ol>
        <p v-if="!d.timeline.length" class="muted small">No pages recorded for this visit yet.</p>
      </template>
    </StateBlock>
    <div class="actions"><button class="btn" type="button" @click="emit('close')">Close</button></div>
  </Dialog>
</template>

<style scoped>
.meta {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 4px 14px;
  margin: 0 0 14px;
}
.meta dt {
  color: var(--muted);
  font-weight: 600;
}
.meta dd {
  margin: 0;
}
.timeline {
  display: grid;
  gap: 0;
  margin: 0;
  padding: 0;
  list-style: none;
  font-size: 13.5px;
}
.timeline li {
  display: grid;
  grid-template-columns: 52px 1fr;
  gap: 10px;
  padding: 7px 0 7px 10px;
  border-left: 2px solid var(--line);
}
.timeline li.action {
  padding-left: 26px;
  color: var(--muted);
}
.timeline li.exit {
  border-left-color: #c2410c;
}
.left {
  margin-left: 8px;
  padding: 1px 8px;
  border-radius: 999px;
  background: #fde7d9;
  color: #9a3412;
  font-size: 12px;
  font-weight: 700;
}
.small {
  font-size: 13px;
}
.actions {
  display: flex;
  justify-content: flex-end;
  margin-top: 14px;
}
</style>
