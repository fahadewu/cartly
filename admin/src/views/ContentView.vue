<script setup>
import { computed, reactive } from 'vue'
import PageHeader from '../components/PageHeader.vue'
import StateBlock from '../components/StateBlock.vue'
import Tabs from '../components/Tabs.vue'
import Dialog from '../components/Dialog.vue'
import Field from '../components/Field.vue'
import ThemeColor from '../components/ThemeColor.vue'
import Icon from '../components/Icon.vue'
import { del, get, patch, post, STOREFRONT_URL } from '../api.js'
import { confirm } from '../confirm.js'
import { loadMeta } from '../meta.js'
import { useQueryState, useResource } from '../composables.js'
import { plural, slugify, swatch } from '../format.js'
import { toast } from '../toast.js'

const { state: q, set } = useQueryState({ tab: 'categories' })
const tab = computed({ get: () => q.value.tab, set: (v) => set({ tab: v }) })
const TABS = [
  { value: 'categories', label: 'Categories' },
  { value: 'collections', label: 'Collections' },
  { value: 'stories', label: 'Stories' },
]
const PATHS = { categories: '/admin/categories', collections: '/admin/collections', stories: '/admin/stories' }
const { data: rows, loading, error, reload } = useResource(() => get(PATHS[tab.value] ?? PATHS.categories), tab)

/* ---------- category / collection editor ---------- */
const editor = reactive({ open: false, kind: 'category', slug: '', error: '', saving: false, slugTouched: false })
const form = reactive({ slug: '', title: '', subtitle: '', image: '', color: 'var(--mint)' })
function openEditor(kind, row) {
  Object.assign(editor, { open: true, kind, slug: row?.slug ?? '', error: '', saving: false, slugTouched: false })
  Object.assign(form, { slug: row?.slug ?? '', title: row?.title ?? '', subtitle: row?.subtitle ?? '', image: row?.image ?? '', color: row?.color ?? 'var(--mint)' })
}
const creating = computed(() => editor.kind === 'collection' && !editor.slug)
function onTitle() {
  if (creating.value && !editor.slugTouched) form.slug = slugify(form.title).slice(0, 60)
}
function validate() {
  if (form.title.trim().length < 2) return 'Give it a title of at least 2 characters.'
  if (form.subtitle.length > 120) return 'Keep the subtitle to 120 characters.'
  if (!/^https?:\/\/\S+\.\S+/.test(form.image.trim())) return 'Paste a full image URL starting with https://.'
  if (creating.value && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(form.slug)) return 'The URL handle can use lowercase letters, numbers and dashes.'
  return ''
}
async function saveEditor() {
  editor.error = validate()
  if (editor.error) return
  editor.saving = true
  const body = { title: form.title.trim(), subtitle: form.subtitle.trim(), image: form.image.trim(), color: form.color }
  try {
    if (editor.kind === 'category') await patch(`/admin/categories/${editor.slug}`, body)
    else if (creating.value) await post('/admin/collections', { ...body, slug: form.slug })
    else await patch(`/admin/collections/${editor.slug}`, body)
    toast(creating.value ? 'Collection created' : `${editor.kind === 'category' ? 'Category' : 'Collection'} saved`)
    editor.open = false
    reload({ quiet: true })
    loadMeta({ force: true })
  } catch (e) {
    editor.error = e.message
  } finally {
    editor.saving = false
  }
}

async function removeCollection(c) {
  const ok = await confirm({
    title: `Delete “${c.title}”?`,
    body: `The collection page goes away. ${c.products ? `Its ${plural(c.products, 'product')} stay in the store.` : ''}`,
    confirmLabel: 'Delete collection',
    danger: true,
  })
  if (!ok) return
  try {
    await del(`/admin/collections/${c.slug}`)
    toast('Collection deleted')
    reload({ quiet: true })
    loadMeta({ force: true })
  } catch (e) {
    toast(e.message, 'error')
  }
}
async function removeStory(s) {
  const ok = await confirm({ title: `Delete “${s.title}”?`, body: 'The story is removed from the Inspiration page. Its products stay in the store.', confirmLabel: 'Delete story', danger: true })
  if (!ok) return
  try {
    await del(`/admin/stories/${s.slug}`)
    toast('Story deleted')
    reload({ quiet: true })
  } catch (e) {
    toast(e.message, 'error')
  }
}
const storeLink = (kind, slug) => `${STOREFRONT_URL}/${kind === 'categories' ? 'category' : kind === 'collections' ? 'collection' : 'inspiration'}/${slug}`
</script>

<template>
  <div>
    <PageHeader title="Content" description="The banners, collections and stories shoppers browse in the store.">
      <button v-can="'content.write'" v-if="tab === 'collections'" class="btn primary" @click="openEditor('collection')"><Icon name="plus" :size="16" />New collection</button>
      <RouterLink v-else-if="tab === 'stories'" to="/content/stories/new" class="btn primary"><Icon name="plus" :size="16" />New story</RouterLink>
    </PageHeader>

    <section class="panel">
      <div class="toolbar"><Tabs v-model="tab" label="Content type" :items="TABS" /></div>
      <StateBlock :loading="loading" :error="error" :empty="!rows?.length" :empty-text="tab === 'stories' ? 'No stories yet. Write one to feature products on the Inspiration page.' : 'Nothing here yet.'" @retry="reload">
        <ul class="rows">
          <li v-for="r in rows" :key="r.slug">
            <img class="banner" :src="r.image" alt="" loading="lazy" :style="{ background: swatch(r.color) }" />
            <div class="text">
              <div class="title-line">
                <strong>{{ r.title }}</strong>
                <span class="swatch" :style="{ background: swatch(r.color) }" :title="`Banner colour ${r.color}`" />
              </div>
              <p class="muted">{{ tab === 'stories' ? r.excerpt : r.subtitle }}</p>
              <span class="meta muted">
                <template v-if="tab === 'categories'">{{ plural(r.products, 'product') }}, types: {{ r.types.join(', ') }}</template>
                <template v-else-if="tab === 'collections'">{{ plural(r.products, 'product') }}<template v-if="r.automatic">, filled automatically with everything on sale</template></template>
                <template v-else>{{ plural(r.productIds.length, 'featured product') }}, {{ plural(r.body.length, 'paragraph') }}</template>
              </span>
            </div>
            <div class="actions">
              <a :href="storeLink(tab, r.slug)" target="_blank" rel="noopener" class="btn ghost sm" :aria-label="`View ${r.title} in the store`"><Icon name="external" :size="15" /></a>
              <button v-can="'content.write'" v-if="tab === 'categories'" class="btn sm" @click="openEditor('category', r)">Edit</button>
              <template v-else-if="tab === 'collections'">
                <button v-can="'content.write'" class="btn sm" @click="openEditor('collection', r)">Edit</button>
                <button v-can="'content.write'" v-if="!r.automatic" class="btn danger sm" @click="removeCollection(r)">Delete</button>
              </template>
              <template v-else>
                <RouterLink :to="`/content/stories/${r.slug}`" class="btn sm">Edit</RouterLink>
                <button v-can="'content.write'" class="btn danger sm" @click="removeStory(r)">Delete</button>
              </template>
            </div>
          </li>
        </ul>
      </StateBlock>
    </section>

    <Dialog :open="editor.open" wide :title="creating ? 'New collection' : `Edit ${editor.kind}`" @close="editor.open = false">
      <form class="form" novalidate @submit.prevent="saveEditor">
        <p v-if="editor.error" class="form-error" role="alert">{{ editor.error }}</p>
        <Field id="c-title" label="Title">
          <input id="c-title" v-model="form.title" class="input" maxlength="60" @input="onTitle" />
        </Field>
        <Field v-if="creating" id="c-slug" label="URL handle" hint="Appears in the store address, like /collection/summer-edit.">
          <input id="c-slug" v-model="form.slug" class="input" maxlength="60" @input="editor.slugTouched = true" />
        </Field>
        <Field id="c-sub" label="Subtitle" optional>
          <input id="c-sub" v-model="form.subtitle" class="input" maxlength="120" />
        </Field>
        <Field id="c-img" label="Banner image URL">
          <input id="c-img" v-model="form.image" class="input" type="url" />
        </Field>
        <Field id="c-color" label="Banner colour">
          <ThemeColor id="c-color" v-model="form.color" />
        </Field>
        <div class="dialog-actions">
          <button type="button" class="btn" @click="editor.open = false">Cancel</button>
          <button class="btn primary" :disabled="editor.saving">{{ editor.saving ? 'Saving…' : creating ? 'Create collection' : 'Save changes' }}</button>
        </div>
      </form>
    </Dialog>
  </div>
</template>

<style scoped>
.rows {
  margin: 0;
  padding: 0;
  list-style: none;
}
.rows li {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 14px 18px;
  border-top: 1px solid var(--line);
}
.rows li:first-child {
  border-top: 0;
}
.banner {
  width: 96px;
  height: 64px;
  border-radius: 10px;
  object-fit: cover;
  flex-shrink: 0;
}
.text {
  display: grid;
  gap: 3px;
  flex: 1;
  min-width: 0;
}
.title-line {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 15px;
}
.text p {
  max-width: 70ch;
}
.meta {
  font-size: 12.5px;
}
.actions {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
}
.form {
  display: grid;
  gap: 14px;
}
.dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
@media (max-width: 640px) {
  .rows li {
    flex-wrap: wrap;
  }
  .banner {
    width: 72px;
    height: 52px;
  }
  .actions {
    width: 100%;
    justify-content: flex-end;
  }
}
</style>
