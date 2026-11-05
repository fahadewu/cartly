<script setup>
import { computed, reactive, watch } from 'vue'
import Dialog from './Dialog.vue'
import Icon from './Icon.vue'
import { download, upload } from '../api.js'
import { meta } from '../meta.js'
import { toast } from '../toast.js'

// Products from a CSV: Cartly's own (the export / template), a Shopify or a WooCommerce product export.
// The file is checked first and every row shows what will happen; nothing is saved until "Import".
const props = defineProps({ open: Boolean })
const emit = defineEmits(['close', 'imported'])

const blank = () => ({ file: null, kind: '', gender: '', busy: false, error: '', result: null, onlyNotes: false })
const s = reactive(blank())
watch(
  () => props.open,
  (open) => open && Object.assign(s, blank()),
)

// "<category>|<type>" for rows the file doesn't say enough about.
const kinds = computed(() => meta.categories.flatMap((c) => c.types.map((t) => ({ value: `${c.slug}|${t}`, label: `${t} (${c.title})` }))))
const fields = () => {
  const [category, type] = s.kind ? s.kind.split('|') : []
  return { category, type, gender: s.gender || undefined }
}

async function run(apply) {
  s.error = ''
  s.busy = true
  try {
    const r = await upload('/admin/catalog/import', s.file, { ...fields(), apply })
    s.result = r
    if (apply) {
      const saved = r.create + r.update
      toast(saved ? `${saved} product${saved === 1 ? '' : 's'} imported` : 'Nothing was imported', saved ? 'info' : 'error')
      emit('imported', r)
    }
  } catch (e) {
    s.error = e.message
  } finally {
    s.busy = false
  }
}

const FORMAT = { cartly: 'Cartly', shopify: 'Shopify', woocommerce: 'WooCommerce' }
const rows = computed(() => {
  const all = s.result?.rows ?? []
  return (s.onlyNotes ? all.filter((r) => r.errors.length || r.warnings.length) : all).slice(0, 300)
})
const toSave = computed(() => (s.result ? s.result.create + s.result.update : 0))
const ACTION = { create: 'New', update: 'Update', skip: 'Skip' }
const DONE = { create: 'Added', update: 'Updated', skip: 'Skipped' }

const template = () => download('/admin/catalog/export', { template: 'true' }).catch((e) => toast(e.message, 'error'))
</script>

<template>
  <Dialog :open="open" title="Import products" wide @close="emit('close')">
    <form v-if="!s.result" class="dialog-form" @submit.prevent="run(false)">
      <p class="muted">
        A CSV from Cartly (<button type="button" class="link" @click="template">download the template</button>, or Export on this page),
        Shopify or WooCommerce (Products → Export in either). You’ll see what happens to each product before anything is saved.
      </p>

      <label class="file" :class="{ chosen: s.file }">
        <input type="file" accept=".csv,text/csv" @change="s.file = $event.target.files[0] ?? null" />
        <Icon name="upload" :size="18" />
        <span>{{ s.file ? s.file.name : 'Choose a CSV file' }}</span>
      </label>

      <fieldset class="defaults">
        <legend>When a row doesn’t say</legend>
        <div class="two">
          <label>
            <span class="label">Kind of product</span>
            <select v-model="s.kind" class="select">
              <option value="">Work it out from the name and tags</option>
              <option v-for="k in kinds" :key="k.value" :value="k.value">{{ k.label }}</option>
            </select>
          </label>
          <label>
            <span class="label">Who it’s for</span>
            <select v-model="s.gender" class="select">
              <option value="">From the wording, else unisex</option>
              <option value="women">Women</option>
              <option value="men">Men</option>
              <option value="unisex">Unisex</option>
            </select>
          </label>
        </div>
      </fieldset>

      <p v-if="s.error" class="form-error" role="alert">{{ s.error }}</p>
      <div class="dialog-buttons">
        <button type="button" class="btn" @click="emit('close')">Cancel</button>
        <button class="btn primary" :disabled="!s.file || s.busy">{{ s.busy ? 'Checking…' : 'Check the file' }}</button>
      </div>
    </form>

    <div v-else class="dialog-form">
      <p class="summary">
        <strong>{{ FORMAT[s.result.format] }} file, {{ s.result.total }} product{{ s.result.total === 1 ? '' : 's' }}.</strong>{{ ' ' }}
        <template v-if="s.result.applied">
          {{ s.result.create }} added, {{ s.result.update }} updated, {{ s.result.skip }} skipped.
        </template>
        <template v-else>
          {{ s.result.create }} new, {{ s.result.update }} to update, {{ s.result.skip }} to skip.
        </template>
      </p>
      <p v-if="s.result.hidden" class="note">
        <Icon name="alert" :size="16" />
        <span>
          {{ s.result.hidden }} {{ s.result.applied ? 'came in' : 'will come in' }} hidden from the store: Pip needs their material, occasions,
          seasons, style tags and features first. Filter Products by <em>Missing Pip details</em> and use <em>Suggest with AI</em> in the editor.
        </span>
      </p>

      <label class="check"><input v-model="s.onlyNotes" type="checkbox" /><span>Only rows with notes</span></label>
      <ol class="rows">
        <li v-for="r in rows" :key="r.line">
          <div class="row-head">
            <span class="line">Line {{ r.line }}</span>
            <RouterLink v-if="s.result.applied && r.id" class="name" :to="`/products/${r.id}`" @click="emit('close')">{{ r.name || r.slug }}</RouterLink>
            <span v-else class="name">{{ r.name || r.slug || '(no name)' }}</span>
            <span class="action" :class="r.action">{{ (s.result.applied ? DONE : ACTION)[r.action] }}{{ r.hidden ? ', hidden' : '' }}</span>
          </div>
          <ul v-if="r.errors.length || r.warnings.length" class="notes">
            <li v-for="(e, i) in r.errors" :key="'e' + i" class="err">{{ e }}</li>
            <li v-for="(w, i) in r.warnings" :key="'w' + i">{{ w }}</li>
          </ul>
        </li>
        <li v-if="!rows.length" class="muted">No notes: every row is fine.</li>
      </ol>
      <p v-if="(s.result.rows?.length ?? 0) > 300" class="muted">Showing the first 300 rows.</p>

      <p v-if="s.error" class="form-error" role="alert">{{ s.error }}</p>
      <div class="dialog-buttons">
        <template v-if="!s.result.applied">
          <button type="button" class="btn" :disabled="s.busy" @click="s.result = null">Choose another file</button>
          <button type="button" class="btn primary" :disabled="!toSave || s.busy" @click="run(true)">
            {{ s.busy ? 'Importing…' : `Import ${toSave} product${toSave === 1 ? '' : 's'}` }}
          </button>
        </template>
        <button v-else type="button" class="btn primary" @click="emit('close')">Done</button>
      </div>
    </div>
  </Dialog>
</template>

<style scoped>
.dialog-form {
  display: grid;
  gap: 14px;
}
.link {
  padding: 0;
  border: 0;
  background: none;
  color: var(--accent);
  font: inherit;
  text-decoration: underline;
  cursor: pointer;
}
.file {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 18px;
  border: 1.5px dashed var(--line);
  border-radius: var(--r-panel);
  font-weight: 600;
  cursor: pointer;
}
.file.chosen {
  border-style: solid;
}
.file:focus-within {
  outline: 2px solid var(--ink);
  outline-offset: 2px;
}
.file input {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
}
.defaults {
  margin: 0;
  padding: 0;
  border: 0;
}
.defaults legend {
  margin-bottom: 8px;
  font-size: 13px;
  font-weight: 700;
}
.two {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.two label {
  display: grid;
  gap: 6px;
}
.label {
  font-size: 13px;
  font-weight: 600;
}
.summary {
  margin: 0;
}
.note {
  display: flex;
  gap: 8px;
  margin: 0;
  padding: 10px 12px;
  border-radius: var(--r-control);
  background: var(--accent-soft);
  font-size: 14px;
}
.note :deep(svg) {
  flex: none;
  margin-top: 2px;
}
.rows {
  display: grid;
  gap: 0;
  max-height: 46vh;
  margin: 0;
  padding: 0;
  overflow: auto;
  border: 1px solid var(--line);
  border-radius: var(--r-control);
  list-style: none;
}
.rows > li {
  padding: 10px 12px;
  border-top: 1px solid var(--line);
}
.rows > li:first-child {
  border-top: 0;
}
.row-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 10px;
}
.line {
  color: var(--muted);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.name {
  flex: 1;
  min-width: 0;
  font-weight: 650;
}
.action {
  font-size: 13px;
  font-weight: 650;
}
.action.create {
  color: var(--ok);
}
.action.skip,
.err {
  color: var(--danger);
}
.notes {
  display: grid;
  gap: 2px;
  margin: 6px 0 0;
  padding-left: 18px;
  color: var(--muted);
  font-size: 13px;
}
.dialog-buttons {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  flex-wrap: wrap;
}
@media (max-width: 560px) {
  .two {
    grid-template-columns: 1fr;
  }
}
</style>
