<script setup>
import { computed, reactive, ref } from 'vue'
import PageHeader from '../components/PageHeader.vue'
import Tabs from '../components/Tabs.vue'
import Pager from '../components/Pager.vue'
import StateBlock from '../components/StateBlock.vue'
import Dialog from '../components/Dialog.vue'
import { get, patch, post } from '../api.js'
import { can } from '../auth.js'
import { useQueryState, useResource, clampPage } from '../composables.js'
import { dateTime } from '../format.js'
import { toast } from '../toast.js'

// Emails that bring shoppers back: drafted with why (they searched for it, it's back in stock, it dropped in price…),
// sent from here, or automatically for the kinds switched on below. Only shoppers who opted in get them.
const { state: q, set } = useQueryState({ status: 'draft', page: 1 })
const { data, loading, error, reload } = useResource(() => get('/admin/outreach', { status: q.value.status, page: q.value.page }), q)
const settings = ref(null)
const loadSettings = () => get('/admin/outreach/settings').then((s) => (settings.value = s))
loadSettings()

const STATUS = [
  ['draft', 'Waiting for you'],
  ['queued', 'Queued'],
  ['sent', 'Sent'],
  ['skipped', 'Skipped'],
  ['failed', 'Failed'],
]
const tabs = computed(() => STATUS.map(([value, label]) => ({ value, label, count: data.value?.counts?.[value] ?? 0 })))
const status = computed({ get: () => q.value.status, set: (v) => set({ status: v, page: 1 }) })
const picked = reactive(new Set())
const allPicked = computed(() => !!data.value?.items.length && data.value.items.every((o) => picked.has(o.id)))
const toggleAll = () => (allPicked.value ? picked.clear() : data.value.items.forEach((o) => picked.add(o.id)))
const busy = ref(false)

async function act(kind, ids = [...picked]) {
  busy.value = true
  try {
    const r = await post(`/admin/outreach/${kind}`, { ids })
    if (kind === 'send') toast([`${r.sent} sent`, r.waiting && `${r.waiting} waiting for the frequency limit`, r.failed && `${r.failed} failed`, r.dropped && `${r.dropped} dropped`].filter(Boolean).join(', '), r.failed ? 'error' : 'info')
    else toast(`${r.skipped} skipped`)
    picked.clear()
    await reload()
  } catch (e) {
    toast(e.message, 'error')
  } finally {
    busy.value = false
  }
}
async function runNow() {
  busy.value = true
  try {
    const r = await post('/admin/outreach/run')
    toast(r.busy ? 'Already checking: try again in a minute' : `Checked: ${r.matched} new match${r.matched === 1 ? '' : 'es'}, ${r.sent} sent`)
    await reload()
  } catch (e) {
    toast(e.message, 'error')
  } finally {
    busy.value = false
  }
}
async function save(patchBody) {
  try {
    settings.value = await patch('/admin/outreach/settings', patchBody)
    toast('Saved')
    await reload()
  } catch (e) {
    toast(e.message, 'error')
  }
}

const preview = ref(null)
const open = async (id) => (preview.value = await get(`/admin/outreach/${id}`).catch((e) => (toast(e.message, 'error'), null)))
clampPage(data, set)
</script>

<template>
  <div>
    <PageHeader title="Emails" description="Emails that bring shoppers back, each drafted with the reason it was picked. Only shoppers who turned emails on get them, at most one every few days.">
      <button v-can="'marketing.write'" type="button" class="btn" :disabled="busy" @click="runNow">Check now</button>
    </PageHeader>

    <section v-if="settings" class="panel pad settings">
      <div>
        <h2>Send on their own</h2>
        <p class="muted small">Off: they wait here for you. On: they go out as soon as the frequency limit allows.</p>
        <div class="kinds">
          <label v-for="k in settings.kinds" :key="k.kind" class="check">
            <input type="checkbox" :checked="settings.auto[k.kind]" :disabled="!can('marketing.write')" @change="save({ auto: { [k.kind]: $event.target.checked } })" />
            <span>{{ k.label }}</span>
          </label>
        </div>
      </div>
      <div class="limits">
        <label>
          <span class="label">At most one email per shopper every</span>
          <select class="select sm" :value="settings.capDays" :disabled="!can('marketing.write')" @change="save({ capDays: Number($event.target.value) })">
            <option v-for="n in [1, 2, 3, 5, 7, 14]" :key="n" :value="n">{{ n }} day{{ n === 1 ? '' : 's' }}</option>
          </select>
        </label>
        <p class="small" :class="settings.mail.configured ? 'muted' : 'warn'">
          {{ settings.mail.configured ? `Mail server ${settings.mail.server}, from ${settings.mail.from}` : 'No mail server: set SMTP_URL, or emails fail when sent.' }}
        </p>
      </div>
    </section>

    <section class="panel">
      <div class="toolbar">
        <Tabs v-model="status" label="Email status" :items="tabs" />
        <div v-if="['draft', 'queued', 'failed'].includes(q.status) && data?.items.length" v-can.hide="'marketing.write'" class="bulk">
          <button type="button" class="btn sm" :disabled="busy || !picked.size" @click="act('skip')">Skip {{ picked.size || '' }}</button>
          <button type="button" class="btn sm primary" :disabled="busy || !picked.size" @click="act('send')">Send {{ picked.size || '' }}</button>
        </div>
      </div>
      <StateBlock :loading="loading" :error="error" :empty="!data?.items.length" :empty-text="q.status === 'draft' ? 'Nothing waiting. Drafts appear when a product matches what a shopper wanted or liked.' : 'Nothing here.'" @retry="reload">
        <div class="table-wrap">
          <table class="table">
            <thead>
              <tr>
                <th v-if="['draft', 'queued', 'failed'].includes(q.status)"><input type="checkbox" :checked="allPicked" aria-label="Pick all" @change="toggleAll" /></th>
                <th>Shopper</th>
                <th>Email</th>
                <th>Products</th>
                <th>Why</th>
                <th>{{ q.status === 'sent' ? 'Sent' : 'Drafted' }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="o in data.items" :key="o.id">
                <td v-if="['draft', 'queued', 'failed'].includes(q.status)"><input type="checkbox" :checked="picked.has(o.id)" :aria-label="`Pick ${o.subject}`" @change="picked.has(o.id) ? picked.delete(o.id) : picked.add(o.id)" /></td>
                <td><RouterLink :to="`/customers/${o.user.id}`">{{ o.user.name }}</RouterLink><div class="muted small">{{ o.user.email }}</div></td>
                <td>
                  <button type="button" class="link" @click="open(o.id)">{{ o.subject }}</button>
                  <div class="muted small">{{ o.kindLabel }}{{ o.clicks ? ` · ${o.clicks} click${o.clicks === 1 ? '' : 's'}` : '' }}{{ o.error ? ` · ${o.error}` : '' }}</div>
                </td>
                <td><span class="thumbs"><img v-for="p in o.products" :key="p.id" :src="p.image" :alt="p.name" :title="p.name" /></span></td>
                <td class="why small">{{ o.reasons.map((r) => r.reason).join(' · ') }}</td>
                <td class="small">{{ dateTime(o.sentAt ?? o.createdAt) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <Pager :page="q.page" :pages="data.pages" :total="data.total" :limit="25" noun="emails" @go="(p) => set({ page: p })" />
      </StateBlock>
    </section>

    <Dialog :open="!!preview" :title="preview?.subject ?? ''" wide @close="preview = null">
      <template v-if="preview">
        <p class="muted small">To {{ preview.user.name }} &lt;{{ preview.user.email }}&gt; · {{ preview.kindLabel }} · {{ preview.status }}</p>
        <iframe v-if="preview.preview" class="mail" sandbox="" :srcdoc="preview.preview.html" title="Email preview" />
        <p v-else class="muted">Its products are sold out or hidden now, so it would not be sent.</p>
        <div class="dialog-buttons">
          <button type="button" class="btn" @click="preview = null">Close</button>
          <template v-if="['draft', 'queued', 'failed'].includes(preview.status)">
            <button v-can="'marketing.write'" type="button" class="btn" :disabled="busy" @click="act('skip', [preview.id]).then(() => (preview = null))">Skip</button>
            <button v-can="'marketing.write'" type="button" class="btn primary" :disabled="busy || !preview.preview" @click="act('send', [preview.id]).then(() => (preview = null))">Send</button>
          </template>
        </div>
      </template>
    </Dialog>
  </div>
</template>

<style scoped>
.settings {
  display: grid;
  grid-template-columns: 1.4fr 1fr;
  gap: 24px;
  margin-bottom: 16px;
}
.settings h2 {
  margin: 0 0 4px;
  font-size: 15px;
}
.kinds {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 18px;
  margin-top: 10px;
}
.limits {
  display: grid;
  align-content: start;
  gap: 10px;
}
.limits label {
  display: grid;
  gap: 6px;
}
.label {
  font-size: 13px;
  font-weight: 600;
}
.warn {
  color: var(--warn);
}
.toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 14px 16px;
}
.bulk {
  display: flex;
  gap: 8px;
}
.thumbs {
  display: flex;
  gap: 4px;
}
.thumbs img {
  width: 36px;
  height: 36px;
  border-radius: 8px;
  object-fit: cover;
  background: var(--grey);
}
.why {
  max-width: 320px;
  color: var(--muted);
}
.link {
  padding: 0;
  border: 0;
  background: none;
  color: var(--ink);
  font: inherit;
  font-weight: 600;
  text-align: left;
  cursor: pointer;
}
.link:hover {
  color: var(--accent);
}
.mail {
  width: 100%;
  height: 60vh;
  border: 1px solid var(--line);
  border-radius: var(--r-control);
  background: #f5f6f1;
}
.dialog-buttons {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
@media (max-width: 800px) {
  .settings {
    grid-template-columns: 1fr;
  }
}
</style>
