<script setup>
import { ref, computed, onMounted } from 'vue'
import ExploreHeader from '../components/ExploreHeader.vue'
import ProductCard from '../components/ProductCard.vue'
import FavouritesCard from '../components/FavouritesCard.vue'
import Icon from '../components/Icon.vue'
import { banners } from '../data.js'
import { products, productById } from '../catalog.js'
import { api } from '../api.js'
import { auth } from '../auth.js'
import { style, picksFor, labelOf } from '../style.js'
import { next as festivalNext, loadFestivals, fmtDay, shortName, daysWord } from '../festival.js'

const category = ref('all')
const query = ref('')

// Explore shows the freshest picks first.
const ordered = computed(() => [...products].sort((a, b) => b.popularity - a.popularity))
const filtered = computed(() => {
  const q = query.value.trim().toLowerCase()
  return ordered.value.filter(
    (p) =>
      (category.value === 'all' || p.gender === category.value || p.gender === 'unisex') &&
      (!q || p.name.toLowerCase().includes(q)),
  )
})
const featured = computed(() => filtered.value.slice(0, 2))

// "Picked for you": ranked by the server from the shopper's taste (or what's popular, for someone new).
// Loaded after the page shows, below the fold, so it never holds the page up.
loadFestivals()
const picks = ref({ ids: [], reason: '' })
onMounted(() => {
  // A guest who took the style quiz gets picks from their answers; a signed-in shopper's come from the server.
  if (!auth.user && style.picked.length)
    picks.value = { ids: picksFor(style.picked, style.gender).map((p) => p.id), reason: `Because you picked ${style.picked.slice(0, 2).map(labelOf).join(' and ')} in your style quiz` }
  else api('/me/recommendations?limit=8').then((r) => (picks.value = r)).catch(() => {})
})
const picked = computed(() =>
  query.value.trim()
    ? []
    : picks.value.ids
        .map(productById)
        .filter((p) => p && (category.value === 'all' || p.gender === category.value || p.gender === 'unisex'))
        .slice(0, 4),
)
const more = computed(() => {
  const shown = new Set(picked.value.map((p) => p.id))
  return filtered.value.slice(2).filter((p) => !shown.has(p.id)).slice(0, 12)
})
</script>

<template>
  <div>
      <ExploreHeader v-model:category="category" v-model:query="query" />

      <RouterLink v-if="festivalNext" to="/festival" class="festival-strip">
        <span class="moon" aria-hidden="true">✦</span>
        <span>
          <b>{{ shortName(festivalNext.name) }} {{ daysWord(festivalNext.daysAway) }}</b>
          <template v-if="festivalNext.orderBy.standard">Order by {{ fmtDay(festivalNext.orderBy.standard) }} for standard delivery<template v-if="festivalNext.orderBy.express">, or {{ fmtDay(festivalNext.orderBy.express) }} with express</template>, to have it the day before.</template>
          <template v-else>Order by {{ fmtDay(festivalNext.orderBy.express) }} with express to have it the day before.</template>
        </span>
        <span class="plan">Plan family outfits<Icon name="arrow" :size="16" /></span>
      </RouterLink>

      <div class="bento">
        <div class="col">
          <section class="banner promo">
            <img :src="banners.promo" alt="" />
            <div class="promo-copy">
              <h2>GET UP TO 50% OFF</h2>
              <RouterLink to="/collection/offers" class="glass">Get Discount</RouterLink>
            </div>
          </section>

          <RouterLink to="/collection/winter-weekend" class="banner weekend">
            <div>
              <h2>Winter’s weekend</h2>
              <p>keep it casual</p>
            </div>
            <img :src="banners.weekend" alt="" />
            <span class="icon-btn corner"><Icon name="arrow" :size="16" /></span>
          </RouterLink>

          <div class="duo">
            <section class="banner offers">
              <img :src="banners.offers" alt="" />
              <RouterLink to="/collection/offers" class="glass offers-btn">Avail Offers</RouterLink>
            </section>
            <FavouritesCard />
          </div>
        </div>

        <div class="col">
          <div class="products">
            <TransitionGroup name="pop">
              <ProductCard v-for="p in featured" :key="p.id" :product="p" />
            </TransitionGroup>
            <p v-if="!featured.length" class="none">No products match “{{ query }}”.</p>
          </div>

          <RouterLink to="/collection/bold-fashion" class="banner bold">
            <div>
              <h2>Bring Bold Fashion</h2>
              <p>Layers on Layers</p>
            </div>
            <img :src="banners.bold" alt="" />
            <span class="icon-btn corner"><Icon name="arrow" :size="16" /></span>
          </RouterLink>
        </div>
      </div>

      <RouterLink to="/style" class="quiz-cta">
        <span class="spark"><Icon name="sparkle" :size="20" /></span>
        <span v-if="style.picked.length"><b>Your style: {{ style.picked.map(labelOf).join(' + ') }}</b>Picks below start from it. Retake the quiz any time.</span>
        <span v-else><b>Find your style in 30 seconds</b>Seven quick “this or that” picks, then everything here starts from what you chose.</span>
        <Icon name="arrow" :size="18" />
      </RouterLink>

      <section v-if="picked.length" class="more picked">
        <div class="section-title">
          <h2>Picked for you</h2>
          <span class="reason">{{ picks.reason }}</span>
        </div>
        <div class="product-grid">
          <ProductCard v-for="p in picked" :key="p.id" :product="p" compact />
        </div>
      </section>

      <section v-if="more.length" class="more">
        <div class="section-title">
          <h2>More to explore</h2>
          <RouterLink to="/shop" class="link">View all {{ filtered.length }} products</RouterLink>
        </div>
        <div class="product-grid">
          <ProductCard v-for="p in more" :key="p.id" :product="p" compact />
        </div>
      </section>
  </div>
</template>

<style scoped>
.festival-strip {
  display: flex;
  align-items: center;
  gap: 14px;
  margin: 18px 34px 0 22px;
  padding: 14px 18px;
  border-radius: 24px;
  background: linear-gradient(100deg, #10213f, #1f3b7a);
  color: #e9eefb;
  text-decoration: none;
  font-size: 14px;
}
.festival-strip > span:nth-child(2) {
  flex: 1;
  display: flex;
  flex-direction: column;
}
.festival-strip b {
  font-size: 16px;
  font-weight: 600;
  color: #fff;
}
.moon {
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: #f5c64f;
  color: #10213f;
  font-size: 18px;
}
.plan {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 10px 16px;
  border-radius: var(--r-pill);
  background: #fff;
  color: #10213f;
  font-weight: 600;
  white-space: nowrap;
}
@media (max-width: 760px) {
  .festival-strip {
    flex-wrap: wrap;
    margin: 14px 16px 0;
  }
}
.quiz-cta {
  display: flex;
  align-items: center;
  gap: 14px;
  margin: 24px 34px 0 22px;
  padding: 18px 22px;
  border-radius: var(--r-card);
  background: var(--butter);
  color: var(--ink);
  text-decoration: none;
  transition: transform 0.15s ease;
}
.quiz-cta:hover {
  transform: translateY(-2px);
}
.quiz-cta > span:nth-child(2) {
  flex: 1;
  display: flex;
  flex-direction: column;
  font-size: 14px;
  color: #4b5058;
}
.quiz-cta b {
  font-size: 17px;
  font-weight: 600;
  color: var(--ink);
}
.spark {
  display: grid;
  place-items: center;
  width: 44px;
  height: 44px;
  border-radius: 14px;
  background: #fff;
}
@media (max-width: 760px) {
  .quiz-cta {
    margin: 18px 16px 0;
  }
}
.reason {
  color: var(--muted);
  font-size: 14px;
}
.bento {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 24px;
  padding: 24px 34px 0 22px;
}
.col {
  display: flex;
  flex-direction: column;
  gap: 18px;
  min-width: 0;
}

.banner {
  display: block;
  color: inherit;
  text-decoration: none;
  position: relative;
  overflow: hidden;
  border-radius: var(--r-card);
  min-height: 200px;
}
.banner h2 {
  font-size: 32px;
  font-weight: 600;
  letter-spacing: -0.02em;
}
.banner p {
  margin-top: 8px;
  font-size: 16px;
}
.banner > img {
  transition: transform 0.5s ease;
}
.banner:hover > img {
  transform: scale(1.04);
}
.corner {
  position: absolute;
  top: 20px;
  right: 20px;
  z-index: 2;
}
.corner.liked {
  color: #ff3b6b;
}

.promo {
  background: var(--mint);
}
.promo img {
  position: absolute;
  top: 0;
  right: 0;
  width: 55%;
  height: 100%;
  object-fit: cover;
  object-position: center 30%;
  mask-image: linear-gradient(90deg, transparent, #000 45%);
  -webkit-mask-image: linear-gradient(90deg, transparent, #000 45%);
}
.promo-copy {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  justify-content: center;
  gap: 16px;
  height: 100%;
  padding-left: 48px;
  min-height: 200px;
}
.promo h2 {
  font-size: 26px;
}

.weekend > div,
.bold > div {
  position: relative;
  z-index: 1;
}
.weekend,
.bold {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-left: 56px;
}
.weekend {
  background: var(--butter);
}
.bold {
  background: var(--slate);
  padding-left: 46px;
}
.weekend img,
.bold img {
  position: absolute;
  top: 0;
  right: 0;
  height: 100%;
  width: 46%;
  object-fit: cover;
  mask-image: linear-gradient(90deg, transparent, #000 35%);
  -webkit-mask-image: linear-gradient(90deg, transparent, #000 35%);
}

.duo {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 18px;
  flex: 1;
}
.offers {
  min-height: 285px;
  background: #e9e9e9;
}
.offers img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.offers-btn {
  position: absolute;
  left: 50%;
  bottom: 22px;
  transform: translateX(-50%);
  background: rgba(255, 190, 150, 0.75);
  color: #fff;
  padding: 0 44px;
}
.offers-btn:hover {
  background: rgba(255, 170, 120, 0.95);
}

.products {
  position: relative;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 18px;
  flex: 1;
}
.none {
  grid-column: 1 / -1;
  align-self: center;
  text-align: center;
  color: var(--muted);
}

.more {
  padding: 0 34px 0 22px;
}

.pop-enter-active,
.pop-leave-active {
  transition: all 0.3s ease;
}
.pop-enter-from,
.pop-leave-to {
  opacity: 0;
  transform: scale(0.96);
}
.pop-leave-active {
  position: absolute;
}

@media (max-width: 1280px) {
  .bento {
    grid-template-columns: 1fr;
  }
}
@media (max-width: 860px) {
  .bento,
  .more {
    padding-left: 16px;
    padding-right: 16px;
  }
  .weekend,
  .bold {
    padding-left: 28px;
  }
  .banner h2 {
    font-size: 24px;
  }
  .promo h2 {
    font-size: 20px;
  }
}
@media (max-width: 560px) {
  .duo,
  .products {
    grid-template-columns: 1fr;
  }
}
</style>
