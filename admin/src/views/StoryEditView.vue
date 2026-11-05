<script setup>
import { can } from '../auth.js'
import { computed, reactive, ref, watch } from 'vue'
import { onBeforeRouteLeave, useRouter } from 'vue-router'
import PageHeader from '../components/PageHeader.vue'
import StateBlock from '../components/StateBlock.vue'
import Field from '../components/Field.vue'
import ThemeColor from '../components/ThemeColor.vue'
import SearchBox from '../components/SearchBox.vue'
import Icon from '../components/Icon.vue'
import { del, get, patch, post, STOREFRONT_URL } from '../api.js'
import { confirm } from '../confirm.js'
import { money, slugify, swatch } from '../format.js'
import { toast } from '../toast.js'

const props = defineProps({ slug: String })
const router = useRouter()
const isNew = !props.slug
const MAX_PRODUCTS = 12

const form = reactive({ title: '', slug: '', excerpt: '', image: '', color: 'var(--butter)', body: [''], productIds: [] })
const snapshot = ref(JSON.stringify(form))
const products = ref([]) // live catalogue for the picker
const extra = reactive({}) // archived products still referenced by the story
const loading = ref(true)
const loadError = ref('')
const saving = ref(false)
const submitted = ref(false)
const serverError = ref('')
const slugTouched = ref(false)
const find = ref('')

async function load() {
  loading.value = true
  loadError.value = ''
  try {
    const [catalog, story] = await Promise.all([get('/catalog'), isNew ? null : get(`/admin/stories/${props.slug}`)])
    products.value = catalog.products
    if (story) {
      Object.assign(form, { title: story.title, slug: story.slug, excerpt: story.excerpt, image: story.image, color: story.color, body: [...story.body], productIds: [...story.productIds] })
      const known = new Set(catalog.products.map((p) => p.id))
      await Promise.all(
        story.productIds.filter((id) => !known.has(id)).map(async (id) => (extra[id] = await get(`/admin/products/${id}`).catch(() => ({ id, name: `Product #${id}`, image: '', price: 0 })))),
      )
    }
    snapshot.value = JSON.stringify(form)
  } catch (e) {
    loadError.value = e.message
  } finally {
    loading.value = false
  }
}
load()

watch(
  () => form.title,
  (t) => {
    if (isNew && !slugTouched.value) form.slug = slugify(t)
  },
)
const dirty = computed(() => JSON.stringify(form) !== snapshot.value)
const byId = computed(() => new Map(products.value.map((p) => [p.id, p])))
const productOf = (id) => byId.value.get(id) ?? extra[id]
const matches = computed(() => {
  const t = find.value.trim().toLowerCase()
  const chosen = new Set(form.productIds)
  return products.value.filter((p) => !chosen.has(p.id) && (!t || `${p.name} ${p.label} ${p.type}`.toLowerCase().includes(t))).slice(0, 8)
})

const errors = computed(() => {
  const e = {}
  const t = form.title.trim().length
  if (t < 3 || t > 100) e.title = 'Give the story a title between 3 and 100 characters.'
  if (isNew && form.slug && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(form.slug)) e.slug = 'Use lowercase letters, numbers and single dashes.'
  const x = form.excerpt.trim().length
  if (x < 10 || x > 300) e.excerpt = 'Write a short summary between 10 and 300 characters.'
  if (!/^https?:\/\/\S+\.\S+/.test(form.image.trim())) e.image = 'Paste a full image URL starting with https://.'
  const paras = form.body.map((p) => p.trim()).filter(Boolean)
  if (!paras.length) e.body = 'Write at least one paragraph.'
  else if (form.body.some((p) => p.length > 2000)) e.body = 'Keep each paragraph under 2,000 characters.'
  else if (paras.length > 20) e.body = 'Use at most 20 paragraphs.'
  return e
})
const show = (k) => (submitted.value ? errors.value[k] : '')

function move(list, i, d) {
  const j = i + d
  if (j < 0 || j >= list.length) return
  ;[list[i], list[j]] = [list[j], list[i]]
}
function addProduct(p) {
  if (form.productIds.length < MAX_PRODUCTS) form.productIds.push(p.id)
}

async function save() {
  submitted.value = true
  serverError.value = ''
  if (Object.keys(errors.value).length) {
    toast('Fix the highlighted fields, then save again.', 'error')
    return
  }
  saving.value = true
  const body = {
    title: form.title.trim(),
    excerpt: form.excerpt.trim(),
    image: form.image.trim(),
    color: form.color,
    body: form.body.map((p) => p.trim()).filter(Boolean),
    productIds: form.productIds,
  }
  try {
    if (isNew) {
      const s = await post('/admin/stories', { ...body, ...(slugTouched.value && form.slug ? { slug: form.slug } : {}) })
      snapshot.value = JSON.stringify(form)
      toast('Story published')
      router.replace(`/content/stories/${s.slug}`)
    } else {
      await patch(`/admin/stories/${props.slug}`, body)
      form.body = body.body
      snapshot.value = JSON.stringify(form)
      toast('Story saved')
    }
    submitted.value = false
  } catch (e) {
    serverError.value = e.message
    toast(e.message, 'error')
  } finally {
    saving.value = false
  }
}

async function remove() {
  const ok = await confirm({ title: `Delete “${form.title}”?`, body: 'The story is removed from the Inspiration page. Its products stay in the store.', confirmLabel: 'Delete story', danger: true })
  if (!ok) return
  try {
    await del(`/admin/stories/${props.slug}`)
    snapshot.value = JSON.stringify(form)
    toast('Story deleted')
    router.replace('/content?tab=stories')
  } catch (e) {
    toast(e.message, 'error')
  }
}

onBeforeRouteLeave(async () => {
  if (!dirty.value || saving.value) return true
  return confirm({ title: 'Leave without saving?', body: 'Your changes to this story will be lost.', confirmLabel: 'Discard changes', danger: true })
})
</script>

<template>
  <div>
    <StateBlock :loading="loading" :error="loadError" @retry="load">
      <PageHeader :title="isNew ? 'New story' : form.title || 'Story'" back="/content?tab=stories" back-label="Stories">
        <template #description>{{ isNew ? 'Stories appear on the Inspiration page with the products you pick.' : `Published at /inspiration/${props.slug}.` }}</template>
        <a v-if="!isNew" :href="`${STOREFRONT_URL}/inspiration/${props.slug}`" target="_blank" rel="noopener" class="btn"><Icon name="external" :size="15" />View in store</a>
        <button v-can="'content.write'" v-if="!isNew" class="btn danger" @click="remove">Delete</button>
        <button v-can="'content.write'" class="btn primary" :disabled="saving || (!isNew && !dirty)" @click="save">{{ saving ? 'Saving…' : isNew ? 'Publish story' : 'Save story' }}</button>
      </PageHeader>

      <form class="layout" novalidate @submit.prevent="save">
        <fieldset :disabled="!can('content.write')" class="bare">
        <div class="stack">
          <p v-if="serverError" class="form-error" role="alert">{{ serverError }}</p>
          <section class="panel">
            <div class="panel-head"><h2>Story</h2></div>
            <div class="panel-body stack">
              <Field id="s-title" label="Title" :error="show('title')">
                <input id="s-title" v-model="form.title" class="input" maxlength="100" :aria-invalid="show('title') ? 'true' : undefined" />
              </Field>
              <Field v-if="isNew" id="s-slug" label="URL handle" :error="show('slug')" hint="Filled in from the title. It can’t be changed after publishing.">
                <input id="s-slug" v-model="form.slug" class="input" maxlength="90" @input="slugTouched = true" />
              </Field>
              <Field id="s-excerpt" label="Summary" :error="show('excerpt')" :hint="`Shown on the Inspiration page. ${form.excerpt.trim().length} of 300 characters.`">
                <textarea id="s-excerpt" v-model="form.excerpt" class="textarea short" maxlength="300" />
              </Field>
            </div>
          </section>

          <section class="panel">
            <div class="panel-head">
              <h2>Paragraphs</h2>
              <button type="button" class="btn sm" :disabled="form.body.length >= 20" @click="form.body.push('')"><Icon name="plus" :size="14" />Add paragraph</button>
            </div>
            <div class="panel-body stack">
              <div v-for="(p, i) in form.body" :key="i" class="para">
                <label class="sr-only" :for="`para-${i}`">Paragraph {{ i + 1 }}</label>
                <textarea :id="`para-${i}`" v-model="form.body[i]" class="textarea" maxlength="2000" />
                <div class="para-tools">
                  <button type="button" class="btn ghost sm" :disabled="i === 0" :aria-label="`Move paragraph ${i + 1} up`" @click="move(form.body, i, -1)"><Icon name="up" :size="15" /></button>
                  <button type="button" class="btn ghost sm" :disabled="i === form.body.length - 1" :aria-label="`Move paragraph ${i + 1} down`" @click="move(form.body, i, 1)"><Icon name="down" :size="15" /></button>
                  <button type="button" class="btn ghost sm" :disabled="form.body.length === 1" :aria-label="`Remove paragraph ${i + 1}`" @click="form.body.splice(i, 1)"><Icon name="trash" :size="15" /></button>
                </div>
              </div>
              <p v-if="show('body')" class="err">{{ show('body') }}</p>
            </div>
          </section>

          <section class="panel">
            <div class="panel-head">
              <h2>Featured products</h2>
              <span class="muted small figures">{{ form.productIds.length }} of {{ MAX_PRODUCTS }}</span>
            </div>
            <div class="panel-body stack">
              <ol v-if="form.productIds.length" class="picked">
                <li v-for="(id, i) in form.productIds" :key="id">
                  <img v-if="productOf(id)?.image" class="thumb" :src="productOf(id).image" alt="" />
                  <span class="grow">
                    <strong>{{ productOf(id)?.name ?? `Product #${id}` }}</strong>
                    <span v-if="!byId.has(id)" class="warn">Archived, hidden from the story</span>
                  </span>
                  <button type="button" class="btn ghost sm" :disabled="i === 0" :aria-label="`Move ${productOf(id)?.name} up`" @click="move(form.productIds, i, -1)"><Icon name="up" :size="15" /></button>
                  <button type="button" class="btn ghost sm" :disabled="i === form.productIds.length - 1" :aria-label="`Move ${productOf(id)?.name} down`" @click="move(form.productIds, i, 1)"><Icon name="down" :size="15" /></button>
                  <button type="button" class="btn ghost sm" :aria-label="`Remove ${productOf(id)?.name}`" @click="form.productIds.splice(i, 1)"><Icon name="x" :size="15" /></button>
                </li>
              </ol>
              <p v-else class="muted">No products yet. Pick a few below to shop the story.</p>

              <div class="finder">
                <SearchBox v-model="find" label="Find products to feature" placeholder="Search the catalogue" />
                <ul class="matches">
                  <li v-for="p in matches" :key="p.id">
                    <img class="thumb" :src="p.image" alt="" loading="lazy" />
                    <span class="grow">
                      <strong>{{ p.name }}</strong>
                      <span class="muted">{{ p.type }}, {{ money(p.price) }}</span>
                    </span>
                    <button type="button" class="btn sm" :disabled="form.productIds.length >= MAX_PRODUCTS" @click="addProduct(p)">Add</button>
                  </li>
                  <li v-if="!matches.length" class="muted">No products match “{{ find }}”.</li>
                </ul>
              </div>
            </div>
          </section>
        </div>

        <aside class="stack side">
          <section class="panel">
            <div class="panel-head"><h2>Banner</h2></div>
            <div class="panel-body stack">
              <div class="banner-preview" :style="{ background: swatch(form.color) }">
                <img v-if="form.image" :src="form.image" alt="" />
                <div>
                  <strong>{{ form.title || 'Story title' }}</strong>
                  <p>{{ form.excerpt || 'A short summary of the story.' }}</p>
                </div>
              </div>
              <Field id="s-image" label="Image URL" :error="show('image')">
                <input id="s-image" v-model="form.image" class="input" type="url" :aria-invalid="show('image') ? 'true' : undefined" />
              </Field>
              <Field id="s-color" label="Background colour">
                <ThemeColor id="s-color" v-model="form.color" />
              </Field>
            </div>
          </section>
        </aside>
        </fieldset>
      </form>
    </StateBlock>
  </div>
</template>

<style scoped>
.layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 340px;
  gap: 22px;
  align-items: start;
}
.side {
  position: sticky;
  top: 24px;
}
.textarea.short {
  min-height: 72px;
}
.para {
  display: flex;
  gap: 8px;
  align-items: flex-start;
}
.para .textarea {
  flex: 1;
}
.para-tools {
  display: grid;
  gap: 2px;
}
.err {
  color: var(--danger);
  font-weight: 600;
  font-size: 12.5px;
}
.small {
  font-size: 12.5px;
  font-weight: 650;
}
.picked,
.matches {
  display: grid;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.picked li,
.matches li {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 8px;
  border: 1px solid var(--line);
  border-radius: var(--r-control);
  font-size: 13.5px;
}
.matches li.muted {
  border-style: dashed;
}
.grow {
  display: grid;
  flex: 1;
  min-width: 0;
}
.warn {
  color: var(--warn);
  font-size: 12px;
  font-weight: 700;
}
.finder {
  display: grid;
  gap: 10px;
  padding-top: 6px;
  border-top: 1px solid var(--line);
}
.finder .search {
  max-width: none;
  margin-top: 8px;
}
.banner-preview {
  display: grid;
  overflow: hidden;
  border-radius: 18px;
}
.banner-preview img {
  width: 100%;
  height: 150px;
  object-fit: cover;
}
.banner-preview div {
  padding: 12px 14px 14px;
  font-family: 'Inter', var(--font-ui);
}
.banner-preview p {
  font-size: 12.5px;
  color: #4a4f55;
}
@media (max-width: 1000px) {
  .layout {
    grid-template-columns: minmax(0, 1fr);
  }
  .side {
    position: static;
  }
}
</style>
