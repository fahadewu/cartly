<script setup>
import { can } from '../auth.js'
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { onBeforeRouteLeave, useRouter } from 'vue-router'
import PageHeader from '../components/PageHeader.vue'
import StatusTag from '../components/StatusTag.vue'
import StateBlock from '../components/StateBlock.vue'
import Field from '../components/Field.vue'
import Icon from '../components/Icon.vue'
import ProductCardPreview from '../components/ProductCardPreview.vue'
import TryOnPanel from '../components/TryOnPanel.vue'
import PipDetails from '../components/PipDetails.vue'
import { del, get, patch, post, STOREFRONT_URL } from '../api.js'
import { refreshBadges } from '../badges.js'
import { confirm } from '../confirm.js'
import { loadMeta, meta } from '../meta.js'
import { count, money, slugify } from '../format.js'
import { toast } from '../toast.js'

const props = defineProps({ id: String })
const router = useRouter()
const isNew = !props.id

// The storefront's colour vocabulary: search and filters match on these names.
const PALETTE = [
  ['Black', '#1c1c1c'], ['White', '#ffffff'], ['Stone', '#9aa0a6'], ['Navy', '#1f2a44'], ['Cobalt', '#1f5bff'],
  ['Sky', '#c9d7ff'], ['Ice', '#8ec3ea'], ['Denim', '#4a6ea8'], ['Sage', '#5f7f6a'], ['Mint', '#b5eed3'],
  ['Lemon', '#f5d75a'], ['Butter', '#ffe29a'], ['Gold', '#d4af37'], ['Sand', '#e9dfcf'], ['Cream', '#efe3cf'],
  ['Tan', '#c49a6c'], ['Copper', '#c47a55'], ['Terracotta', '#d9774b'], ['Chestnut', '#6b4b3a'], ['Scarlet', '#e0322f'], ['Blush', '#f7a8c9'],
]
const SIZE_PRESETS = [
  { label: 'Clothing XS–XL', sizes: ['XS', 'S', 'M', 'L', 'XL'] },
  { label: 'Shoes 38–45', sizes: ['38', '39', '40', '41', '42', '43', '44', '45'] },
  { label: 'Waist 28–36', sizes: ['28', '30', '32', '34', '36'] },
  { label: 'One size', sizes: ['One size'] },
]

const blank = () => ({
  name: '',
  slug: '',
  description: '',
  category: 'clothing-shoes',
  type: 'Clothing',
  gender: 'unisex',
  label: '',
  price: '',
  compareAt: '',
  stock: 20,
  isNew: true,
  active: true,
  image: '',
  colors: [{ name: 'Black', hex: '#1c1c1c' }],
  sizes: ['XS', 'S', 'M', 'L', 'XL'],
  collections: [],
  tryOnSlot: '',
  tryOnImage: '',
  tryOnInfo: { photoType: '', styling: '', cutout: '' },
  ...pipBlank(),
})
// What Pip and search know beyond the description (see components/PipDetails.vue).
const PIP_TEXT = ['material', 'fit', 'fitNotes', 'careNotes']
const PIP_LISTS = ['occasions', 'seasons', 'styleTags', 'features', 'keywords', 'pairsWith']
function pipBlank() {
  return { ...Object.fromEntries(PIP_TEXT.map((k) => [k, ''])), ...Object.fromEntries(PIP_LISTS.map((k) => [k, []])) }
}
const form = reactive(blank())
const product = ref(null) // saved state from the server, with sales stats
const snapshot = ref(JSON.stringify(form))
const loading = ref(!isNew)
const loadError = ref('')
const saving = ref(false)
const submitted = ref(false)
const serverError = ref('')
const slugTouched = ref(false)
const sizeText = ref('')

function fill(p) {
  product.value = p
  Object.assign(form, {
    name: p.name,
    slug: p.slug,
    description: p.description,
    category: p.category,
    type: p.type,
    gender: p.gender,
    label: p.label,
    price: p.price,
    compareAt: p.compareAt ?? '',
    stock: p.stock,
    isNew: p.isNew,
    active: p.active,
    image: p.image,
    colors: p.colors.map((c) => ({ ...c })),
    sizes: [...p.sizes],
    collections: p.collections.filter((c) => c !== 'offers'),
    tryOnSlot: p.tryOnSlot ?? '',
    tryOnImage: p.tryOnImage ?? '',
    tryOnInfo: {
      photoType: p.tryOnInfo?.photoType ?? '',
      styling: p.tryOnInfo?.styling ?? '',
      cutout: p.tryOnInfo?.cutout ?? '',
      ...(p.tryOnInfo?.check ? { check: p.tryOnInfo.check } : {}),
      ...(p.tryOnInfo?.crop ? { crop: p.tryOnInfo.crop } : {}),
    },
    ...Object.fromEntries(PIP_TEXT.map((k) => [k, p[k] ?? ''])),
    ...Object.fromEntries(PIP_LISTS.map((k) => [k, [...(p[k] ?? [])]])),
  })
  snapshot.value = JSON.stringify(form)
}

async function load() {
  loadError.value = ''
  loading.value = !isNew
  try {
    await loadMeta()
    if (!isNew) fill(await get(`/admin/products/${props.id}`))
  } catch (e) {
    loadError.value = e.message
  } finally {
    loading.value = false
  }
}
load()

const category = computed(() => meta.categories.find((c) => c.slug === form.category))
const manualCollections = computed(() => meta.collections.filter((c) => !c.automatic))
watch(
  () => form.category,
  () => {
    if (category.value && !category.value.types.includes(form.type)) form.type = category.value.types[0]
  },
)
watch(
  () => form.name,
  (name) => {
    if (isNew && !slugTouched.value) form.slug = slugify(name)
  },
)

const dirty = computed(() => JSON.stringify(form) !== snapshot.value)

/* ---------- validation (mirrors the API's rules) ---------- */
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const twoDp = (n) => Math.round(n * 100) === Math.round(n * 100 * 1e6) / 1e6
const errors = computed(() => {
  const e = {}
  const name = form.name.trim()
  if (name.length < 2 || name.length > 80) e.name = 'Give the product a name between 2 and 80 characters.'
  if (form.slug && (!SLUG.test(form.slug) || form.slug.length > 90)) e.slug = 'Use lowercase letters, numbers and single dashes, like linen-overshirt.'
  const d = form.description.trim().length
  if (d < 40 || d > 1000) e.description = 'Write a description between 40 and 1,000 characters, so Pip can describe it.'
  if (!form.material.trim()) e.material = 'Say what it’s made of.'
  if (form.type === 'Clothing' && !form.fit) e.fit = 'Choose the fit.'
  if (!form.occasions.length) e.occasions = 'Choose at least one occasion.'
  if (!form.seasons.length) e.seasons = 'Choose at least one season.'
  if (form.styleTags.length < 2) e.styleTags = 'Add at least two style tags.'
  if (form.features.length < 2) e.features = 'Add at least two key features.'
  const label = form.label.trim().length
  if (label < 1 || label > 30) e.label = 'Add a short label of up to 30 characters, like “New In” or “Essentials”.'
  if (!category.value) e.category = 'Choose a category.'
  else if (!category.value.types.includes(form.type)) e.type = `Choose one of: ${category.value.types.join(', ')}.`
  const price = Number(form.price)
  if (form.price === '' || !Number.isFinite(price) || price < 0.5 || price > 100000 || !twoDp(price)) e.price = 'Enter a price from $0.50 to $100,000, with at most two decimals.'
  if (form.compareAt !== '' && form.compareAt != null) {
    const c = Number(form.compareAt)
    if (!Number.isFinite(c) || c > 100000 || !twoDp(c)) e.compareAt = 'Enter a valid price with at most two decimals.'
    else if (!e.price && c <= price) e.compareAt = 'The compare-at price must be higher than the selling price.'
  }
  const stock = Number(form.stock)
  if (form.stock === '' || !Number.isInteger(stock) || stock < 0 || stock > 100000) e.stock = 'Enter stock as a whole number from 0 to 100,000.'
  if (!/^https?:\/\/\S+\.\S+/.test(form.image.trim()) || form.image.length > 500) e.image = 'Paste a full image URL starting with https://.'
  if (!form.colors.length) e.colors = 'Add at least one colour.'
  else if (form.colors.length > 8) e.colors = 'Use at most 8 colours.'
  else if (form.colors.some((c) => !c.name.trim() || c.name.trim().length > 30)) e.colors = 'Every colour needs a name of up to 30 characters.'
  else if (new Set(form.colors.map((c) => c.name.trim().toLowerCase())).size !== form.colors.length) e.colors = 'Each colour needs a different name.'
  if (!form.sizes.length) e.sizes = 'Add at least one size, or choose “One size”.'
  else if (form.sizes.length > 12) e.sizes = 'Use at most 12 sizes.'
  return e
})
const show = (k) => (submitted.value ? errors.value[k] : '')
const invalid = (k) => (show(k) ? 'true' : undefined)

/* ---------- editors ---------- */
function addColor([name, hex]) {
  if (form.colors.some((c) => c.name.toLowerCase() === name.toLowerCase()) || form.colors.length >= 8) return
  form.colors.push({ name, hex })
}
function addSize() {
  for (const s of sizeText.value.split(',').map((x) => x.trim()).filter(Boolean)) {
    if (s.length <= 12 && !form.sizes.includes(s) && form.sizes.length < 12) form.sizes.push(s)
  }
  sizeText.value = ''
}
function onSizeKey(e) {
  if (e.key === 'Enter' || e.key === ',') {
    e.preventDefault()
    addSize()
  } else if (e.key === 'Backspace' && !sizeText.value && form.sizes.length) form.sizes.pop()
}

/* ---------- save & lifecycle ---------- */
// The try-on photo's check, if it's for the photo and slot being saved.
const tryOnPhoto = () => form.tryOnImage.trim() || form.image.trim()
const currentCheck = () => {
  const c = form.tryOnInfo.check
  return c && c.url === tryOnPhoto() && c.slot === form.tryOnSlot ? c : undefined
}
function tryOnInfo() {
  if (!form.tryOnSlot) return null
  const { photoType, styling, cutout, crop } = form.tryOnInfo
  const info = { photoType: photoType || undefined, styling: styling.trim() || undefined, check: currentCheck(), cutout: cutout || undefined, crop }
  return Object.values(info).some((v) => v !== undefined) ? info : null
}

function payload() {
  const body = {
    name: form.name.trim(),
    description: form.description.trim(),
    category: form.category,
    type: form.type,
    gender: form.gender,
    label: form.label.trim(),
    price: Number(form.price),
    compareAt: form.compareAt === '' || form.compareAt == null ? null : Number(form.compareAt),
    stock: Number(form.stock),
    isNew: form.isNew,
    active: form.active,
    image: form.image.trim(),
    colors: form.colors.map((c) => ({ name: c.name.trim(), hex: c.hex.toLowerCase() })),
    sizes: form.sizes,
    collections: form.collections,
    tryOnSlot: form.tryOnSlot || null,
    tryOnImage: form.tryOnSlot ? form.tryOnImage.trim() || null : null,
    tryOnInfo: tryOnInfo(),
    ...Object.fromEntries(PIP_TEXT.map((k) => [k, form[k].trim() || null])),
    ...Object.fromEntries(PIP_LISTS.map((k) => [k, form[k]])),
  }
  if (form.type !== 'Clothing') body.fit = null
  if (isNew ? slugTouched.value && form.slug : form.slug !== product.value.slug) body.slug = form.slug
  return body
}

async function save() {
  submitted.value = true
  serverError.value = ''
  if (Object.keys(errors.value).length) {
    toast('Fix the highlighted fields, then save again.', 'error')
    return
  }
  const check = form.tryOnSlot ? currentCheck() : undefined
  if (check && !check.ok) {
    const problems = check.issues.filter((i) => i.level === 'error').map((i) => i.message)
    const go = await confirm({
      title: 'This photo won’t try on accurately',
      body: `${problems.join(' ')} Shoppers may see the wrong item or a distorted fit. Upload a better photo, or save anyway.`,
      confirmLabel: 'Save anyway',
    })
    if (!go) return
  }
  saving.value = true
  try {
    if (isNew) {
      const created = await post('/admin/products', payload())
      snapshot.value = JSON.stringify(form)
      toast('Product created')
      refreshBadges({ force: true })
      router.replace(`/products/${created.id}`)
    } else {
      await patch(`/admin/products/${props.id}`, payload())
      fill(await get(`/admin/products/${props.id}`))
      toast('Product saved')
      refreshBadges({ force: true })
    }
    submitted.value = false
  } catch (e) {
    serverError.value = e.message
    toast(e.message, 'error')
  } finally {
    saving.value = false
  }
}

async function setActive(active) {
  if (dirty.value) {
    toast('Save or undo your changes first.', 'error')
    return
  }
  saving.value = true
  try {
    await patch(`/admin/products/${props.id}`, { active })
    fill(await get(`/admin/products/${props.id}`))
    toast(active ? 'Product restored to the store' : 'Product archived')
    refreshBadges({ force: true })
  } catch (e) {
    toast(e.message, 'error')
  } finally {
    saving.value = false
  }
}

async function remove() {
  if (product.value.unitsSold || product.value.orders) {
    const archive = await confirm({
      title: 'This product has been ordered',
      body: 'Products that appear in past orders can’t be deleted, so order history stays intact. Archive it instead to hide it from the store.',
      confirmLabel: product.value.active ? 'Archive product' : 'Keep archived',
    })
    if (archive && product.value.active) await setActive(false)
    return
  }
  const ok = await confirm({
    title: `Delete ${product.value.name}?`,
    body: 'It disappears from the store, favourites and stories, and its reviews are removed. This can’t be undone.',
    confirmLabel: 'Delete product',
    danger: true,
  })
  if (!ok) return
  try {
    await del(`/admin/products/${props.id}`)
    snapshot.value = JSON.stringify(form)
    toast('Product deleted')
    refreshBadges({ force: true })
    router.replace('/products')
  } catch (e) {
    toast(e.message, 'error')
  }
}

function discard() {
  if (isNew) Object.assign(form, blank())
  else fill(product.value)
  submitted.value = false
  serverError.value = ''
}

onBeforeRouteLeave(async () => {
  if (!dirty.value || saving.value) return true
  return confirm({ title: 'Leave without saving?', body: 'Your changes to this product will be lost.', confirmLabel: 'Discard changes', danger: true })
})
const beforeUnload = (e) => {
  if (dirty.value) e.preventDefault()
}
onMounted(() => window.addEventListener('beforeunload', beforeUnload))
onBeforeUnmount(() => window.removeEventListener('beforeunload', beforeUnload))

const preview = computed(() => ({ ...form, price: Number(form.price) || 0, compareAt: Number(form.compareAt) || null }))
const title = computed(() => (isNew ? 'New product' : product.value?.name ?? 'Product'))
</script>

<template>
  <div>
    <StateBlock :loading="loading" :error="loadError" @retry="load">
      <PageHeader :title="title" back="/products" back-label="Products">
        <template v-if="!isNew && product" #tag><StatusTag :status="product.active ? 'ACTIVE' : 'ARCHIVED'" /></template>
        <template #description>
          <template v-if="isNew">Fill in the details. The card on the right shows how it will look in the store.</template>
          <template v-else>Product #{{ product.id }}. Saved changes reach the store, search and Pip within a few seconds.</template>
        </template>
        <a v-if="!isNew && product?.active" :href="`${STOREFRONT_URL}/product/${product.id}`" target="_blank" rel="noopener" class="btn">
          <Icon name="external" :size="15" />View in store
        </a>
        <button v-can="'catalog.write'" v-if="dirty" class="btn ghost" :disabled="saving" @click="discard">Undo changes</button>
        <button v-can="'catalog.write'" class="btn primary" :disabled="saving || (!isNew && !dirty)" @click="save">{{ saving ? 'Saving…' : isNew ? 'Create product' : 'Save product' }}</button>
      </PageHeader>

      <div class="editor">
        <form class="stack" novalidate @submit.prevent="save">
          <fieldset :disabled="!can('catalog.write')" class="bare">
          <p v-if="serverError" class="form-error" role="alert">{{ serverError }}</p>

          <section class="panel">
            <div class="panel-head"><h2>Details</h2></div>
            <div class="panel-body grid">
              <Field id="name" label="Name" :error="show('name')" class="span-2">
                <input id="name" v-model="form.name" class="input" maxlength="80" :aria-invalid="invalid('name')" />
              </Field>
              <Field id="slug" label="URL handle" :error="show('slug')" :hint="isNew && !slugTouched ? 'Filled in from the name. Lowercase words joined by dashes.' : 'Lowercase words joined by dashes.'" class="span-2">
                <input id="slug" v-model="form.slug" class="input" :aria-invalid="invalid('slug')" @input="slugTouched = true" />
              </Field>
              <Field id="description" label="Description" :error="show('description')" :hint="`${form.description.trim().length} of 1,000 characters (at least 40)`" class="span-2">
                <textarea id="description" v-model="form.description" class="textarea" maxlength="1000" :aria-invalid="invalid('description')" />
              </Field>
              <Field id="label" label="Card label" :error="show('label')" hint="The small line above the name, like “New In” or “Bestseller”.">
                <input id="label" v-model="form.label" class="input" maxlength="30" :aria-invalid="invalid('label')" />
              </Field>
              <Field id="gender" label="Shop for">
                <select id="gender" v-model="form.gender" class="select">
                  <option value="women">Women</option>
                  <option value="men">Men</option>
                  <option value="unisex">Everyone (unisex)</option>
                </select>
              </Field>
              <Field id="category" label="Category" :error="show('category')">
                <select id="category" v-model="form.category" class="select" :aria-invalid="invalid('category')">
                  <option v-for="c in meta.categories" :key="c.slug" :value="c.slug">{{ c.title }}</option>
                </select>
              </Field>
              <Field id="type" label="Type" :error="show('type')">
                <select id="type" v-model="form.type" class="select" :aria-invalid="invalid('type')">
                  <option v-for="t in category?.types ?? []" :key="t" :value="t">{{ t }}</option>
                </select>
              </Field>
            </div>
          </section>

          <PipDetails :form="form" :errors="submitted ? errors : {}" />

          <section class="panel">
            <div class="panel-head"><h2>Price and stock</h2></div>
            <div class="panel-body grid three">
              <Field id="price" label="Price (USD)" :error="show('price')">
                <input id="price" v-model.number="form.price" class="input" type="number" min="0.5" step="0.01" inputmode="decimal" :aria-invalid="invalid('price')" />
              </Field>
              <Field id="compareAt" label="Compare-at price" optional :error="show('compareAt')" hint="Set a higher original price to put it on sale.">
                <input id="compareAt" v-model.number="form.compareAt" class="input" type="number" min="0.5" step="0.01" inputmode="decimal" :aria-invalid="invalid('compareAt')" />
              </Field>
              <Field id="stock" label="In stock" :error="show('stock')" :hint="Number(form.stock) === 0 ? 'Shows as sold out in the store.' : Number(form.stock) <= 5 ? 'Shows “Only a few left” in the store.' : ''">
                <input id="stock" v-model.number="form.stock" class="input" type="number" min="0" step="1" inputmode="numeric" :aria-invalid="invalid('stock')" />
              </Field>
            </div>
            <div class="panel-body toggles">
              <label class="check"><input v-model="form.active" type="checkbox" />Visible in the store</label>
              <label class="check"><input v-model="form.isNew" type="checkbox" />Mark as new</label>
            </div>
          </section>

          <section class="panel">
            <div class="panel-head"><h2>Photo</h2></div>
            <div class="panel-body photo-row">
              <Field id="image" label="Image URL" :error="show('image')" hint="Unsplash photos also get a cropped gallery on the product page." class="grow">
                <input id="image" v-model="form.image" class="input" type="url" placeholder="https://images.unsplash.com/photo-…" :aria-invalid="invalid('image')" />
              </Field>
              <img v-if="form.image" class="thumb big" :src="form.image" alt="" />
            </div>
          </section>

          <section class="panel">
            <div class="panel-head"><h2>Colours and sizes</h2></div>
            <div class="panel-body stack">
              <fieldset class="group">
                <legend>Colours</legend>
                <ul class="colors">
                  <li v-for="(c, i) in form.colors" :key="i">
                    <label class="sr-only" :for="`hex-${i}`">Colour {{ i + 1 }} shade</label>
                    <input :id="`hex-${i}`" v-model="c.hex" type="color" class="picker" />
                    <label class="sr-only" :for="`cname-${i}`">Colour {{ i + 1 }} name</label>
                    <input :id="`cname-${i}`" v-model="c.name" class="input sm" maxlength="30" placeholder="Colour name" />
                    <button type="button" class="btn ghost sm" :aria-label="`Remove ${c.name || 'colour'}`" @click="form.colors.splice(i, 1)"><Icon name="x" :size="15" /></button>
                  </li>
                </ul>
                <div class="palette" aria-label="Add a store colour">
                  <button
                    v-for="p in PALETTE"
                    :key="p[0]"
                    type="button"
                    class="chip"
                    :disabled="form.colors.some((c) => c.name.toLowerCase() === p[0].toLowerCase())"
                    @click="addColor(p)"
                  >
                    <span class="swatch" :style="{ background: p[1] }" />{{ p[0] }}
                  </button>
                  <button type="button" class="chip" @click="addColor([`Colour ${form.colors.length + 1}`, '#888888'])"><Icon name="plus" :size="13" />Custom</button>
                </div>
                <p v-if="show('colors')" class="err">{{ show('colors') }}</p>
              </fieldset>

              <fieldset class="group">
                <legend>Sizes</legend>
                <div class="chips-input" :class="{ invalid: show('sizes') }" @click="$refs.sizeInput.focus()">
                  <span v-for="(s, i) in form.sizes" :key="s" class="size">
                    {{ s }}
                    <button type="button" :aria-label="`Remove size ${s}`" @click.stop="form.sizes.splice(i, 1)"><Icon name="x" :size="12" /></button>
                  </span>
                  <label class="sr-only" for="size-input">Add a size</label>
                  <input id="size-input" ref="sizeInput" v-model="sizeText" placeholder="Type a size, then Enter" @keydown="onSizeKey" @blur="addSize" />
                </div>
                <div class="presets">
                  <span class="muted">Presets</span>
                  <button v-for="p in SIZE_PRESETS" :key="p.label" type="button" class="link-btn" @click="form.sizes = [...p.sizes]">{{ p.label }}</button>
                </div>
                <p v-if="show('sizes')" class="err">{{ show('sizes') }}</p>
              </fieldset>
            </div>
          </section>

          <section class="panel">
            <div class="panel-head"><h2>Where it appears</h2></div>
            <div class="panel-body stack">
              <fieldset class="group">
                <legend>Collections</legend>
                <div class="checks">
                  <label v-for="c in manualCollections" :key="c.slug" class="check">
                    <input v-model="form.collections" type="checkbox" :value="c.slug" />{{ c.title }}
                  </label>
                </div>
                <p class="muted small">“Offers” fills itself with every product that has a compare-at price.</p>
              </fieldset>
            </div>
          </section>

          <TryOnPanel :form="form" :product-id="product?.id" :cutout="product?.tryOnCutout" :dirty="dirty" />

          <section v-if="!isNew" class="panel pad danger-zone">
            <div>
              <h2>{{ product.active ? 'Take it out of the store' : 'Archived' }}</h2>
              <p class="muted">
                {{ product.active ? 'Archiving hides it from shoppers, search and Pip. Orders and reviews are kept, and you can restore it any time.' : 'Shoppers can’t see or buy this product. Restore it to put it back on sale.' }}
              </p>
            </div>
            <div class="row">
              <button type="button" class="btn" :disabled="saving" @click="setActive(!product.active)">{{ product.active ? 'Archive product' : 'Restore to store' }}</button>
              <button type="button" class="btn danger" :disabled="saving" @click="remove">Delete product</button>
            </div>
          </section>

          <div class="form-foot">
            <button class="btn primary" :disabled="saving || (!isNew && !dirty)">{{ saving ? 'Saving…' : isNew ? 'Create product' : 'Save product' }}</button>
          </div>
          </fieldset>
        </form>

        <aside class="side">
          <p class="side-title">Store preview</p>
          <ProductCardPreview :product="preview" />
          <section v-if="!isNew && product" class="panel pad sales">
            <h2>Sales</h2>
            <dl class="kv">
              <dt>Units sold</dt>
              <dd class="figures">{{ count(product.unitsSold) }}</dd>
              <dt>Revenue</dt>
              <dd class="figures">{{ money(product.revenue) }}</dd>
              <dt>Orders</dt>
              <dd class="figures">{{ count(product.orders) }}</dd>
              <dt>Favourited by</dt>
              <dd class="figures">{{ count(product.favourites) }}</dd>
              <dt>Rating</dt>
              <dd class="figures">{{ product.reviewCount ? `${product.rating} from ${count(product.reviewCount)} reviews` : 'No reviews yet' }}</dd>
            </dl>
            <RouterLink v-if="product.storedReviews" :to="`/reviews?productId=${product.id}`" class="small">Read its reviews</RouterLink>
          </section>
        </aside>
      </div>
    </StateBlock>
  </div>
</template>

<style scoped>
.editor {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 330px;
  gap: 22px;
  align-items: start;
}
.grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}
.grid.three {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}
.span-2 {
  grid-column: span 2;
}
.toggles {
  display: flex;
  gap: 24px;
  flex-wrap: wrap;
  padding-top: 0;
}
.photo-row {
  display: flex;
  align-items: flex-start;
  gap: 16px;
}
.photo-row .grow {
  flex: 1;
}
.thumb.big {
  width: 76px;
  height: 76px;
  border-radius: 10px;
}
.group {
  margin: 0;
  padding: 0;
  border: 0;
  min-width: 0;
}
legend {
  margin-bottom: 8px;
  font-size: 13px;
  font-weight: 700;
}
.colors {
  display: grid;
  gap: 8px;
  margin: 0 0 10px;
  padding: 0;
  list-style: none;
}
.colors li {
  display: flex;
  align-items: center;
  gap: 8px;
  max-width: 380px;
}
.picker {
  width: 34px;
  height: 30px;
  padding: 2px;
  border: 1px solid var(--line-strong);
  border-radius: 8px;
  background: var(--surface);
  cursor: pointer;
  flex-shrink: 0;
}
.palette {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 10px 0 6px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--surface);
  font-size: 12.5px;
  font-weight: 600;
}
.chip:hover:not(:disabled) {
  border-color: var(--line-strong);
  background: var(--hover);
}
.chip:disabled {
  opacity: 0.4;
  cursor: default;
}
.chip .swatch {
  width: 14px;
  height: 14px;
}
.chips-input {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  min-height: 40px;
  padding: 5px 8px;
  border: 1px solid var(--line-strong);
  border-radius: var(--r-control);
  cursor: text;
}
.chips-input:focus-within {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}
.chips-input.invalid {
  border-color: var(--danger);
}
.chips-input input {
  flex: 1;
  min-width: 150px;
  border: 0;
  outline: none;
  padding: 4px;
  background: none;
}
.size {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  height: 26px;
  padding: 0 4px 0 9px;
  border-radius: 7px;
  background: var(--grey);
  font-weight: 700;
  font-size: 12.5px;
}
.size button {
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  border: 0;
  border-radius: 5px;
  background: none;
  color: var(--muted);
}
.size button:hover {
  background: rgba(0, 0, 0, 0.07);
  color: var(--ink);
}
.presets {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 14px;
  margin-top: 8px;
  font-size: 12.5px;
}
.checks {
  display: flex;
  flex-wrap: wrap;
  gap: 10px 22px;
}
.small {
  font-size: 12.5px;
  margin-top: 8px;
}
.err {
  margin-top: 8px;
  color: var(--danger);
  font-weight: 600;
  font-size: 12.5px;
}
.danger-zone {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}
.danger-zone > div:first-child {
  max-width: 52ch;
}
.danger-zone h2 {
  margin-bottom: 4px;
}
.row {
  display: flex;
  gap: 8px;
}
.form-foot {
  display: flex;
  justify-content: flex-end;
}
.side {
  position: sticky;
  top: 24px;
  display: grid;
  gap: 16px;
}
.side-title {
  font-size: 13px;
  font-weight: 700;
  color: var(--muted);
  margin-bottom: -6px;
}
.sales h2 {
  margin-bottom: 12px;
}

@media (max-width: 1080px) {
  .editor {
    grid-template-columns: minmax(0, 1fr);
  }
  .side {
    position: static;
    grid-row: 1;
    grid-template-columns: minmax(0, 300px) minmax(0, 1fr);
    align-items: start;
  }
  .side-title {
    grid-column: 1 / -1;
  }
}
@media (max-width: 640px) {
  .grid,
  .grid.three {
    grid-template-columns: minmax(0, 1fr);
  }
  .span-2 {
    grid-column: auto;
  }
  .side {
    grid-template-columns: minmax(0, 1fr);
  }
  .photo-row .thumb {
    display: none;
  }
}
</style>
