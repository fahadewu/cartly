<script setup>
import { trackView } from '../track.js'
import { ref, reactive, computed, watch, watchEffect, onBeforeUnmount } from 'vue'
import { useRouter } from 'vue-router'
import PageHeader from '../components/PageHeader.vue'
import ProductCard from '../components/ProductCard.vue'
import QtyStepper from '../components/QtyStepper.vue'
import Stars from '../components/Stars.vue'
import Icon from '../components/Icon.vue'
import NotFoundView from './NotFoundView.vue'
import { gallery, price } from '../data.js'
import { productById, products, categories, typeDetails, delivery, updateProduct } from '../catalog.js'
import { api } from '../api.js'
import { useShop } from '../store.js'
import { toast } from '../toast.js'
import { useTryOn } from '../tryon/useTryOn.js'
import { isWearable } from '../tryon/specs.js'
import { prefs, loadPrefs, suggestSize } from '../prefs.js'
import { auth } from '../auth.js'
import ShareLook from '../components/ShareLook.vue'
import { next as festivalNext, loadFestivals, fmtDay, shortName } from '../festival.js'

const props = defineProps({ id: { type: String, required: true } })
const router = useRouter()
const { addToCart, isLiked, toggleLike, addReview } = useShop()

const product = computed(() => productById(props.id))
watchEffect(() => {
  if (product.value) document.title = `${product.value.name} · Cartly`
})

const images = computed(() => gallery(product.value))
const active = ref(0)
const color = ref('')
const size = ref('')
const qty = ref(1)
const sizeError = ref(false)
const open = ref('details')
const writing = ref(false)

// Full detail (reviews, care notes, live rating) comes from the API; the catalog
// copy renders the page straight away while it loads.
const detail = ref(null)
async function loadDetail(id) {
  try {
    const d = await api(`/products/${id}`)
    if (id !== props.id) return
    detail.value = d
    updateProduct(d)
  } catch (e) {
    if (e.status !== 404) toast(e.message)
  }
}
watch(
  () => props.id,
  (id) => {
    const p = productById(id)
    detail.value = null
    active.value = 0
    color.value = p?.colors[0].name ?? ''
    size.value = p?.sizes.length === 1 ? p.sizes[0] : ''
    qty.value = 1
    sizeError.value = writing.value = false
    if (p) {
      loadDetail(id)
      trackView(id)
    }
  },
  { immediate: true },
)

const discountPct = computed(() =>
  product.value.compareAt ? Math.round((1 - product.value.price / product.value.compareAt) * 100) : 0,
)
const category = computed(() => categories[product.value.category] ?? { title: product.value.category })
// This product's own details (entered in the admin panel) first, then the ones for its type.
const info = computed(() => {
  const p = product.value
  const fit = p.fit && `${p.fit.charAt(0).toUpperCase()}${p.fit.slice(1)} fit${p.fitNotes ? `: ${p.fitNotes.charAt(0).toLowerCase()}${p.fitNotes.slice(1)}` : ''}`
  return {
    details: [
      ...(p.material ? [`Made of ${p.material.charAt(0).toLowerCase()}${p.material.slice(1)}`] : []),
      ...(fit ? [fit] : []),
      ...(p.features ?? []),
      ...(detail.value?.details ?? typeDetails[p.type]?.details ?? []),
    ],
    care: [...(p.careNotes ? [p.careNotes] : []), ...(detail.value?.care ?? typeDetails[p.type]?.care ?? [])],
  }
})
const shippingNotes = computed(() => [
  ...Object.values(delivery.options).map((o) => `${o.label} delivery in ${o.eta.replace('business days', 'working days')}`),
  `Free returns within ${delivery.returnsDays} days`,
])

const related = computed(() =>
  products
    .filter((p) => p.id !== product.value.id && (p.type === product.value.type || p.category === product.value.category))
    .sort((a, b) => (b.type === product.value.type) - (a.type === product.value.type) || b.popularity - a.popularity)
    .slice(0, 4),
)

const reviews = computed(() => detail.value?.reviews ?? [])
const avg = computed(() => product.value.rating)
const reviewCount = computed(() => product.value.reviewCount)
// Real counts of the written reviews per star (5 → 1), never a curve drawn from the average.
const written = computed(() => (detail.value?.ratingCounts ?? []).reduce((a, b) => a + b, 0))
const breakdown = computed(() =>
  written.value ? detail.value.ratingCounts.map((n, i) => ({ stars: 5 - i, n, pct: Math.round((n / written.value) * 100) })) : [],
)

/* ---------- fit: what shoppers said, and the size to pick ---------- */
loadPrefs()
const FIT_LABEL = { small: 'Runs small', true: 'True to size', large: 'Runs large' }
const fit = computed(() => {
  const f = product.value?.fitFeedback
  if (!f) return null
  const lead = f.verdict ? f[f.verdict] : 0
  const usual = prefs.sizes?.[product.value.type] ?? null
  const pick = f.verdict ? suggestSize(product.value.sizes, usual, f.verdict) : null
  return { ...f, lead, usual, pick }
})

function validSize() {
  sizeError.value = !size.value
  return !sizeError.value
}
function add() {
  if (!validSize()) return
  addToCart(product.value, { color: color.value, size: size.value, qty: qty.value })
}
async function buyNow() {
  if (!validSize()) return
  if (await addToCart(product.value, { color: color.value, size: size.value, qty: qty.value }, { silent: true })) router.push({ name: 'checkout' })
}
const tryon = useTryOn()
function tryItOn() {
  tryon.tryOn(product.value.id, { open: 'full' })
}
// "Ask family": a voting link for this product in the colour and size picked.
const asking = ref(false)
loadFestivals()
const shareItems = computed(() => [{ productId: product.value.id, color: color.value || undefined, size: size.value || undefined }])

const blankDraft = () => ({ rating: 0, title: '', text: '', size: '', fit: '', heightCm: '', usualSize: '', photos: [] })
const draft = reactive(blankDraft())
const draftError = ref('')
const posting = ref(false)
const uploading = ref(0)
function startReview() {
  if (!auth.user) return router.push({ name: 'login', query: { redirect: `${router.currentRoute.value.fullPath}#reviews` } })
  writing.value = !writing.value
  if (writing.value && !draft.usualSize) draft.usualSize = prefs.sizes?.[product.value.type] ?? ''
}
async function addPhotos(e) {
  const files = [...(e.target.files ?? [])].slice(0, 3 - draft.photos.length)
  e.target.value = ''
  for (const file of files) {
    const form = new FormData()
    form.append('file', file)
    uploading.value++
    try {
      draft.photos.push((await api('/reviews/photos', { method: 'POST', body: form, timeout: 60_000 })).url)
    } catch (err) {
      draftError.value = err.message
    } finally {
      uploading.value--
    }
  }
}
async function submitReview() {
  if (!draft.rating) return (draftError.value = 'Pick a star rating.')
  if (draft.text.trim().length < 10) return (draftError.value = 'Tell us a little more (at least 10 characters).')
  const height = draft.heightCm === '' ? undefined : Number(draft.heightCm)
  if (height !== undefined && !(height >= 100 && height <= 230)) return (draftError.value = 'Height is in centimetres, e.g. 165.')
  if (uploading.value) return (draftError.value = 'One moment, your photos are still uploading.')
  posting.value = true
  try {
    await addReview(product.value.id, {
      rating: draft.rating,
      title: draft.title.trim() || undefined,
      text: draft.text.trim(),
      size: draft.size || undefined,
      fit: draft.fit || undefined,
      heightCm: height,
      usualSize: draft.usualSize || undefined,
      photos: draft.photos.length ? draft.photos : undefined,
    })
    await loadDetail(props.id) // picks up the new review, the updated rating and fit
    Object.assign(draft, blankDraft())
    draftError.value = ''
    writing.value = false
    toast('Thanks! Your review is live')
  } catch (e) {
    draftError.value = e.message
  } finally {
    posting.value = false
  }
}
const fitWords = (r) =>
  [r.size && `Bought ${r.size}`, r.fit && FIT_LABEL[r.fit].toLowerCase(), r.heightCm && `${r.heightCm} cm`, r.usualSize && `usually wears ${r.usualSize}`]
    .filter(Boolean)
    .join(' · ')
const photoOpen = ref(null)
const closeOnEscape = (e) => e.key === 'Escape' && (photoOpen.value = null)
watch(photoOpen, (open) => (open ? window.addEventListener('keydown', closeOnEscape) : window.removeEventListener('keydown', closeOnEscape)))
onBeforeUnmount(() => window.removeEventListener('keydown', closeOnEscape))

const fmtDate = (d) => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
</script>

<template>
  <NotFoundView v-if="!product" />
  <div v-else>
    <PageHeader
      :crumbs="[
        { label: 'Explore', to: '/' },
        { label: category.title, to: `/category/${product.category}` },
        { label: product.type, to: `/category/${product.category}?type=${product.type}` },
        { label: product.name },
      ]"
    />

    <div class="page">
      <div class="layout">
        <!-- Gallery -->
        <section class="gallery">
          <div class="stage">
            <div class="stage-top">
              <span v-if="discountPct" class="badge sale">−{{ discountPct }}%</span>
              <span v-else-if="product.isNew" class="badge new">New in</span>
              <span v-else />
              <div class="stage-actions">
                <button class="icon-btn" aria-label="Ask family or share" title="Ask family" @click="asking = true"><Icon name="share" :size="17" /></button>
                <button
                  class="icon-btn"
                  :class="{ liked: isLiked(product.id) }"
                  :aria-pressed="isLiked(product.id)"
                  aria-label="Add to favourites"
                  @click="toggleLike(product.id)"
                >
                  <Icon name="heart" :size="17" :filled="isLiked(product.id)" />
                </button>
              </div>
            </div>
            <Transition name="swap" mode="out-in">
              <img :key="active" :src="images[active]" :alt="`${product.name}, view ${active + 1}`" />
            </Transition>
            <template v-if="images.length > 1">
              <button class="nav prev" aria-label="Previous image" @click="active = (active + images.length - 1) % images.length"><Icon name="chevronLeft" /></button>
              <button class="nav next" aria-label="Next image" @click="active = (active + 1) % images.length"><Icon name="chevronRight" /></button>
            </template>
          </div>
          <div v-if="images.length > 1" class="thumbs">
            <button
              v-for="(src, i) in images"
              :key="src"
              class="thumb"
              :class="{ on: active === i }"
              :aria-label="`Show image ${i + 1}`"
              @click="active = i"
            >
              <img :src="src.replace('w=900&h=1000', 'w=200&h=200')" alt="" />
            </button>
          </div>
        </section>

        <!-- Buy box -->
        <section class="buybox">
          <span class="label">{{ product.label }}</span>
          <h1>{{ product.name }}</h1>
          <a href="#reviews" class="rating">
            <template v-if="reviewCount">
              <Stars :value="avg" />
              <b>{{ avg.toFixed(1) }}</b>
              <span>({{ reviewCount }} review{{ reviewCount === 1 ? '' : 's' }})</span>
            </template>
            <span v-else>No reviews yet</span>
          </a>

          <div class="price-row">
            <strong>{{ price(product.price) }}</strong>
            <s v-if="product.compareAt">{{ price(product.compareAt) }}</s>
            <span v-if="discountPct" class="save">Save {{ price(product.compareAt - product.price) }}</span>
          </div>

          <p v-if="!product.inStock" class="stock out"><Icon name="alert" :size="16" />Sold out. Check back soon, or ask Pip for something similar.</p>
          <p v-else-if="product.lowStock" class="stock low">Only {{ product.lowStock }} left in stock</p>

          <p class="desc">{{ product.description }}</p>

          <div class="option">
            <div class="option-head"><span>Colour</span><b>{{ color }}</b></div>
            <div class="colors">
              <button
                v-for="c in product.colors"
                :key="c.name"
                class="color"
                :class="{ on: color === c.name }"
                :style="{ background: c.hex }"
                :aria-label="c.name"
                :aria-pressed="color === c.name"
                @click="color = c.name"
              />
            </div>
          </div>

          <div v-if="product.sizes.length > 1" class="option">
            <div class="option-head">
              <span>Size</span>
              <b v-if="size">{{ size }}</b>
            </div>
            <div class="sizes" :class="{ shake: sizeError }">
              <button
                v-for="s in product.sizes"
                :key="s"
                class="size"
                :class="{ on: size === s }"
                :aria-pressed="size === s"
                @click="size = s; sizeError = false"
              >
                {{ s }}
              </button>
            </div>
            <p v-if="sizeError" class="size-error" role="alert">Please choose a size.</p>
            <div v-if="fit" class="fit" :class="fit.verdict ?? 'mixed'">
              <template v-if="fit.verdict">
                <b><Icon :name="fit.verdict === 'true' ? 'check' : 'alert'" :size="15" />{{ FIT_LABEL[fit.verdict] }}</b>
                <span>{{ fit.lead }} of {{ fit.total }} shoppers said so<template v-if="fit.returns"> (including {{ fit.returns }} size return{{ fit.returns === 1 ? '' : 's' }})</template>.</span>
                <button v-if="fit.pick && fit.pick !== size" class="fit-pick" @click="size = fit.pick; sizeError = false">
                  You wear {{ fit.usual }}, so pick {{ fit.pick }}
                </button>
              </template>
              <span v-else>
                Fit so far: <template v-for="(k, i) in ['small', 'true', 'large'].filter((k) => fit[k])" :key="k">{{ i ? ' · ' : '' }}{{ fit[k] }} {{ FIT_LABEL[k].toLowerCase() }}</template>
              </span>
            </div>
          </div>

          <div class="actions">
            <QtyStepper :value="qty" :min="1" @dec="qty--" @inc="qty = Math.min(qty + 1, product.lowStock ?? 20)" />
            <button class="btn-primary add" :disabled="!product.inStock" @click="add">
              <Icon name="bag" :size="18" />{{ product.inStock ? `Add to cart · ${price(product.price * qty)}` : 'Sold out' }}
            </button>
          </div>
          <div class="second-row">
            <button class="btn-secondary buy-now" :disabled="!product.inStock" @click="buyNow">Buy it now</button>
            <button v-if="isWearable(product.id)" class="btn-secondary try-on" @click="tryItOn">
              <Icon name="sparkle" :size="17" />{{ tryon.isOn(product.id) ? 'On you: open fitting room' : 'Try it on' }}
            </button>
          </div>

          <button class="ask-family" @click="asking = true">
            <Icon name="users" :size="17" /><span><b>Can’t decide?</b> Ask family to vote, no app needed</span><Icon name="chevronRight" :size="16" />
          </button>

          <div class="perks">
            <div><Icon name="bag" :size="18" /><span><b>Free delivery</b>on orders over {{ price(delivery.freeShippingOver) }}</span></div>
            <div><Icon name="check" :size="18" /><span><b>{{ delivery.returnsDays }}-day returns</b>free and easy</span></div>
            <div v-if="festivalNext" class="festive">
              <Icon name="truck" :size="18" />
              <span>
                <b>Before {{ shortName(festivalNext.name) }}</b>
                <template v-if="festivalNext.orderBy.standard">order by {{ fmtDay(festivalNext.orderBy.standard) }}</template>
                <template v-else>order by {{ fmtDay(festivalNext.orderBy.express) }} with express</template>
              </span>
            </div>
          </div>

          <div class="accordion">
            <div v-for="sec in [
              { id: 'details', title: 'Details', items: info.details },
              { id: 'care', title: 'Care', items: info.care },
              { id: 'shipping', title: 'Delivery & returns', items: shippingNotes },
            ]" :key="sec.id" class="acc" :class="{ open: open === sec.id }">
              <button :aria-expanded="open === sec.id" @click="open = open === sec.id ? '' : sec.id">
                {{ sec.title }}<Icon :name="open === sec.id ? 'minus' : 'plus'" :size="18" />
              </button>
              <ul v-if="open === sec.id">
                <li v-for="item in sec.items" :key="item">{{ item }}</li>
              </ul>
            </div>
          </div>
        </section>
      </div>

      <!-- Reviews -->
      <section id="reviews" class="reviews">
        <div class="section-title">
          <h2>Reviews</h2>
          <button class="btn-secondary sm" @click="startReview">{{ writing ? 'Cancel' : 'Write a review' }}</button>
        </div>

        <div class="reviews-layout">
          <div v-if="!reviewCount" class="score box">
            <strong>–</strong>
            <span class="muted">No reviews yet. Bought it? Be the first to say what you think.</span>
          </div>
          <div v-else class="score box">
            <strong>{{ avg.toFixed(1) }}</strong>
            <Stars :value="avg" :size="20" />
            <span class="muted">Based on {{ reviewCount }} review{{ reviewCount === 1 ? '' : 's' }}</span>
            <ul v-if="breakdown.length" class="bars" :aria-label="`Star ratings of the ${written} written reviews`">
              <li v-for="b in breakdown" :key="b.stars">
                <span>{{ b.stars }}★</span><i><em :style="{ width: `${b.pct}%` }" /></i><span>{{ b.n }}</span>
              </li>
            </ul>
            <small v-if="breakdown.length" class="muted">From the {{ written }} written review{{ written === 1 ? '' : 's' }}</small>
          </div>

          <div class="list">
            <form v-if="writing" class="box review-form" novalidate @submit.prevent="submitReview">
              <div class="pick" role="radiogroup" aria-label="Your rating">
                <button
                  v-for="n in 5"
                  :key="n"
                  type="button"
                  role="radio"
                  :aria-checked="draft.rating === n"
                  :aria-label="`${n} star${n > 1 ? 's' : ''}`"
                  :class="{ on: n <= draft.rating }"
                  @click="draft.rating = n"
                >★</button>
              </div>
              <input v-model="draft.title" class="title-input" placeholder="Headline (optional)" maxlength="60" />
              <textarea v-model="draft.text" class="textarea" placeholder="What did you like or dislike?" maxlength="600" />
              <fieldset v-if="product.sizes.length > 1" class="fitq">
                <legend>How did it fit? <small>Optional, and it helps shoppers like you pick a size</small></legend>
                <div class="fit-row">
                  <label class="mini-field">
                    <span>Size you bought</span>
                    <select v-model="draft.size" class="select sm">
                      <option value="">–</option>
                      <option v-for="s in product.sizes" :key="s">{{ s }}</option>
                    </select>
                  </label>
                  <div class="seg" role="radiogroup" aria-label="How it fit">
                    <button v-for="k in ['small', 'true', 'large']" :key="k" type="button" role="radio" :aria-checked="draft.fit === k" :class="{ on: draft.fit === k }" @click="draft.fit = draft.fit === k ? '' : k">
                      {{ FIT_LABEL[k] }}
                    </button>
                  </div>
                </div>
                <div class="fit-row">
                  <label class="mini-field">
                    <span>Your height (cm)</span>
                    <input v-model="draft.heightCm" class="select sm" inputmode="numeric" maxlength="3" placeholder="e.g. 165" />
                  </label>
                  <label class="mini-field">
                    <span>Size you usually wear</span>
                    <input v-model="draft.usualSize" class="select sm" maxlength="12" placeholder="e.g. M" />
                  </label>
                </div>
              </fieldset>
              <div class="photo-row">
                <figure v-for="(u, i) in draft.photos" :key="u" class="thumb-sm">
                  <img :src="u" alt="Your photo" />
                  <button type="button" aria-label="Remove photo" @click="draft.photos.splice(i, 1)"><Icon name="close" :size="13" /></button>
                </figure>
                <label v-if="draft.photos.length < 3" class="add-photo" :class="{ busy: uploading }">
                  <input type="file" accept="image/*" multiple class="sr-only" @change="addPhotos" />
                  <Icon name="plus" :size="16" />{{ uploading ? 'Uploading…' : 'Add photos' }}
                </label>
                <small class="muted">Up to 3. Location and camera details are removed.</small>
              </div>
              <p v-if="draftError" class="form-alert error"><Icon name="alert" :size="16" />{{ draftError }}</p>
              <button class="btn-primary sm" type="submit" :disabled="posting">{{ posting ? 'Posting…' : 'Post review' }}</button>
            </form>

            <article v-for="r in reviews" :key="r.id" class="review">
              <header>
                <span class="avatar">{{ r.author[0] }}</span>
                <div>
                  <b>{{ r.author }}</b>
                  <small>{{ fmtDate(r.createdAt) }}<template v-if="r.verified"> · <span class="verified"><Icon name="check" :size="12" />Verified purchase</span></template></small>
                </div>
                <Stars :value="r.rating" :size="14" />
              </header>
              <h4>{{ r.title }}</h4>
              <p>{{ r.text }}</p>
              <p v-if="fitWords(r)" class="fit-words">{{ fitWords(r) }}</p>
              <div v-if="r.photos?.length" class="photo-row">
                <button v-for="u in r.photos" :key="u" class="thumb-sm" :aria-label="`Open ${r.author}’s photo`" @click="photoOpen = u"><img :src="u" alt="" loading="lazy" /></button>
              </div>
            </article>
          </div>
        </div>
      </section>

      <div v-if="photoOpen" class="lightbox" role="dialog" aria-modal="true" aria-label="Review photo" @click="photoOpen = null">
        <img :src="photoOpen" alt="Shopper’s photo" />
        <button class="icon-btn" aria-label="Close photo" @click.stop="photoOpen = null"><Icon name="close" :size="18" /></button>
      </div>

      <ShareLook v-if="asking" :items="shareItems" @close="asking = false" />

      <section v-if="related.length">
        <div class="section-title">
          <h2>You may also like</h2>
          <RouterLink :to="`/category/${product.category}`" class="link">See more</RouterLink>
        </div>
        <div class="product-grid">
          <ProductCard v-for="p in related" :key="p.id" :product="p" compact />
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.stock {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 4px 0 0;
  font-size: 14px;
  font-weight: 600;
}
.stock.low {
  color: #9a6700;
}
.stock.out {
  color: #b42318;
}
.layout {
  display: grid;
  grid-template-columns: 1.1fr 1fr;
  gap: 40px;
  align-items: start;
}

/* Gallery */
.gallery {
  position: sticky;
  top: 24px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.stage {
  position: relative;
  aspect-ratio: 9 / 10;
  border-radius: var(--r-card);
  background: var(--card);
  overflow: hidden;
}
.stage img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  mix-blend-mode: multiply;
}
.stage-top {
  position: absolute;
  inset: 20px 20px auto;
  z-index: 2;
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.stage-actions {
  display: flex;
  gap: 8px;
}
.stage-actions .liked {
  color: #ff3b6b;
}
.badge {
  padding: 6px 12px;
  border-radius: var(--r-pill);
  font-size: 13px;
  font-weight: 600;
}
.badge.sale {
  background: #ff3b6b;
  color: #fff;
}
.badge.new {
  background: #fff;
  color: var(--blue);
}
.nav {
  position: absolute;
  top: 50%;
  z-index: 2;
  display: grid;
  place-items: center;
  width: 44px;
  height: 44px;
  margin-top: -22px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.85);
  opacity: 0;
  transition: opacity 0.2s ease;
}
.stage:hover .nav,
.nav:focus-visible {
  opacity: 1;
}
.prev {
  left: 16px;
}
.next {
  right: 16px;
}
.thumbs {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
}
.thumb {
  aspect-ratio: 1;
  border: 2px solid transparent;
  border-radius: 20px;
  background: var(--card);
  overflow: hidden;
  transition: border-color 0.2s ease;
}
.thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  mix-blend-mode: multiply;
}
.thumb.on {
  border-color: var(--blue);
}
.swap-enter-active,
.swap-leave-active {
  transition: opacity 0.2s ease;
}
.swap-enter-from,
.swap-leave-to {
  opacity: 0;
}

/* Buy box */
.buybox {
  display: flex;
  flex-direction: column;
}
.label {
  font-size: 13px;
  color: var(--muted);
}
.buybox h1 {
  margin-top: 6px;
  font-size: 34px;
  font-weight: 500;
  letter-spacing: -0.02em;
  line-height: 1.15;
}
.rating {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
  font-size: 14px;
  color: var(--muted);
  text-decoration: none;
}
.rating b {
  color: var(--ink);
  font-weight: 500;
}
.price-row {
  display: flex;
  align-items: baseline;
  gap: 12px;
  margin-top: 22px;
}
.price-row strong {
  font-size: 32px;
  font-weight: 600;
}
.price-row s {
  font-size: 18px;
  color: var(--muted);
}
.save {
  padding: 4px 10px;
  border-radius: var(--r-pill);
  background: #e7f8ef;
  color: #067647;
  font-size: 13px;
  font-weight: 600;
}
.desc {
  margin-top: 16px;
  font-size: 15px;
  line-height: 1.6;
  color: #4b5058;
}

.option {
  margin-top: 26px;
}
.option-head {
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
  font-size: 14px;
}
.option-head span {
  color: var(--muted);
}
.option-head b {
  font-weight: 500;
}
.colors {
  display: flex;
  gap: 10px;
}
.color {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  border: 3px solid #fff;
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.12);
  transition: transform 0.15s ease;
}
.color.on {
  box-shadow: 0 0 0 2px var(--ink);
  transform: scale(1.05);
}
.sizes {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(62px, 1fr));
  gap: 8px;
}
.size {
  height: 50px;
  border: 1.5px solid var(--line);
  border-radius: 16px;
  font-size: 14px;
  font-weight: 500;
  transition: all 0.15s ease;
}
.size:hover {
  border-color: #c9cdd2;
}
.size.on {
  border-color: var(--ink);
  background: var(--ink);
  color: #fff;
}
.shake {
  animation: shake 0.35s ease;
}
.shake .size:not(.on) {
  border-color: #fda29b;
}
@keyframes shake {
  25% { transform: translateX(-6px); }
  75% { transform: translateX(6px); }
}
.size-error {
  margin-top: 8px;
  font-size: 13px;
  color: #d92d20;
}

.actions {
  display: flex;
  gap: 10px;
  margin-top: 28px;
}
.add {
  flex: 1;
}
.second-row {
  display: flex;
  gap: 10px;
  margin-top: 10px;
}
.second-row > * {
  flex: 1;
}
.buy-now,
.try-on {
  height: 58px;
}
.try-on {
  background: linear-gradient(135deg, var(--mint), var(--butter));
}
.try-on:hover {
  filter: brightness(0.97);
}

.perks {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
  margin-top: 22px;
}
.perks div {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px;
  border-radius: 20px;
  background: var(--peach);
  font-size: 13px;
}
.perks div:nth-child(2) {
  background: var(--mint);
}
.perks div.festive {
  grid-column: 1 / -1;
  background: #e8edfb;
}
.perks span {
  display: flex;
  flex-direction: column;
}
.perks b {
  font-weight: 600;
}

.accordion {
  margin-top: 22px;
  border-top: 1px solid var(--line);
}
.acc {
  border-bottom: 1px solid var(--line);
}
.acc button {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 18px 4px;
  font-size: 15px;
  font-weight: 500;
}
.acc ul {
  margin: 0 0 18px;
  padding-left: 20px;
  font-size: 14px;
  line-height: 1.8;
  color: #4b5058;
}

/* Reviews */
.reviews-layout {
  display: grid;
  grid-template-columns: 320px 1fr;
  gap: 24px;
  align-items: start;
}
.score {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
}
.score strong {
  font-size: 48px;
  font-weight: 600;
  line-height: 1;
}
.score .muted {
  font-size: 13px;
}
.bars {
  width: 100%;
  margin: 12px 0 0;
  padding: 0;
  list-style: none;
}
.bars li {
  display: grid;
  grid-template-columns: 28px 1fr 36px;
  align-items: center;
  gap: 10px;
  padding: 4px 0;
  font-size: 13px;
  color: var(--muted);
}
.bars i {
  height: 8px;
  border-radius: 4px;
  background: var(--line);
  overflow: hidden;
}
.bars em {
  display: block;
  height: 100%;
  background: #f5a524;
}
.list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.review {
  padding: 22px 24px;
  border-radius: 24px;
  background: var(--card);
}
.review header {
  display: flex;
  align-items: center;
  gap: 12px;
}
.review header div {
  flex: 1;
  display: flex;
  flex-direction: column;
}
.review b {
  font-size: 14px;
  font-weight: 500;
}
.review small {
  font-size: 12px;
  color: var(--muted);
}
.avatar {
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: var(--blue-soft);
  color: var(--blue);
  font-weight: 600;
}
.review h4 {
  margin: 14px 0 6px;
  font-size: 15px;
  font-weight: 500;
}
.review p {
  font-size: 14px;
  line-height: 1.6;
  color: #4b5058;
}
.review-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.pick {
  display: flex;
  gap: 4px;
}
.pick button {
  font-size: 30px;
  line-height: 1;
  color: #dfe2e6;
  transition: transform 0.1s ease, color 0.1s ease;
}
.pick button.on {
  color: #f5a524;
}
.pick button:hover {
  transform: scale(1.15);
}
.title-input {
  height: 52px;
  padding: 0 20px;
  border: 1.5px solid transparent;
  border-radius: 18px;
  background: var(--chip);
  font: inherit;
  font-size: 15px;
  outline: none;
}
.title-input:focus {
  border-color: var(--blue);
  background: #fff;
}
.review-form .btn-primary {
  align-self: flex-start;
  padding: 0 28px;
}

.ask-family {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  margin-top: 4px;
  padding: 12px 16px;
  border-radius: 18px;
  background: var(--mint);
  font-size: 14px;
  text-align: left;
}
.ask-family span {
  flex: 1;
}
.ask-family b {
  font-weight: 600;
}

/* Fit: what shoppers said about the size */
.fit {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 10px;
  margin-top: 12px;
  padding: 12px 16px;
  border-radius: 18px;
  background: var(--chip);
  font-size: 13px;
  color: #4b5058;
}
.fit b {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
  color: var(--ink);
}
.fit.small b,
.fit.large b {
  color: #9a6700;
}
.fit.true b {
  color: #1a7f4b;
}
.fit-pick {
  margin-left: auto;
  padding: 6px 14px;
  border-radius: var(--r-pill);
  background: var(--ink);
  color: #fff;
  font-size: 13px;
  font-weight: 500;
}
.fitq {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin: 0;
  padding: 14px 16px;
  border: 0;
  border-radius: 18px;
  background: #fff;
}
.fitq legend {
  float: left;
  width: 100%;
  font-size: 14px;
  font-weight: 500;
}
.fitq legend small {
  display: block;
  font-weight: 400;
  color: var(--muted);
}
.fit-row {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 10px;
}
.mini-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--muted);
}
.select.sm {
  height: 40px;
  min-width: 110px;
  padding: 0 12px;
  border: 1.5px solid var(--line);
  border-radius: 12px;
  background: #fff;
  font: inherit;
  font-size: 14px;
  color: var(--ink);
}
.seg {
  display: inline-flex;
  padding: 3px;
  border-radius: 14px;
  background: var(--chip);
}
.seg button {
  height: 34px;
  padding: 0 12px;
  border-radius: 11px;
  font-size: 13px;
  color: #4b5058;
}
.seg button.on {
  background: var(--ink);
  color: #fff;
}
.photo-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
}
.photo-row .muted {
  font-size: 12px;
}
.thumb-sm {
  position: relative;
  width: 72px;
  height: 72px;
  margin: 0;
  padding: 0;
  border-radius: 14px;
  overflow: hidden;
  background: var(--chip);
}
.thumb-sm img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.thumb-sm button {
  position: absolute;
  top: 4px;
  right: 4px;
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: rgba(18, 20, 23, 0.7);
  color: #fff;
}
.add-photo {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 40px;
  padding: 0 14px;
  border: 1.5px dashed #c9cdd2;
  border-radius: 12px;
  font-size: 13px;
  cursor: pointer;
}
.add-photo.busy {
  opacity: 0.6;
}
.verified {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  color: #1a7f4b;
}
.fit-words {
  margin-top: 8px;
  font-size: 13px !important;
  color: var(--muted) !important;
}
.lightbox {
  position: fixed;
  inset: 0;
  z-index: 80;
  display: grid;
  place-items: center;
  padding: 24px;
  background: rgba(18, 20, 23, 0.82);
}
.lightbox img {
  max-width: min(100%, 900px);
  max-height: 86vh;
  border-radius: 20px;
}
.lightbox .icon-btn {
  position: absolute;
  top: 20px;
  right: 20px;
}

@media (max-width: 1100px) {
  .layout,
  .reviews-layout {
    grid-template-columns: 1fr;
  }
  .gallery {
    position: static;
  }
}
@media (max-width: 560px) {
  .actions {
    flex-direction: column;
  }
  .add {
    flex: none;
  }
  .actions .qty {
    justify-content: space-between;
  }
  .perks {
    grid-template-columns: 1fr;
  }
  .buybox h1 {
    font-size: 28px;
  }
}
</style>
