<script setup>
import { computed, watchEffect } from 'vue'
import PageHeader from '../components/PageHeader.vue'
import ProductCard from '../components/ProductCard.vue'
import NotFoundView from './NotFoundView.vue'
import { stories, productById } from '../catalog.js'
import { useShop } from '../store.js'

const props = defineProps({ slug: { type: String, required: true } })
const { addAllToCart } = useShop()

const story = computed(() => stories.find((s) => s.slug === props.slug))
const items = computed(() => story.value?.products.map(productById).filter(Boolean) ?? [])
const others = computed(() => stories.filter((s) => s.slug !== props.slug).slice(0, 3))
const lookTotal = computed(() => items.value.reduce((n, p) => n + p.price, 0))

watchEffect(() => {
  if (story.value) document.title = `${story.value.title} · Cartly`
})

function shopLook() {
  addAllToCart(items.value)
}
</script>

<template>
  <NotFoundView v-if="!story" />
  <div v-else>
    <PageHeader :title="story.title" :crumbs="[{ label: 'Explore', to: '/' }, { label: 'Inspiration', to: '/inspiration' }, { label: story.title }]" />

    <div class="page">
      <div class="hero" :style="{ background: story.color }">
        <img :src="story.image" alt="" />
      </div>

      <div class="article">
        <p class="excerpt">{{ story.excerpt }}</p>
        <p v-for="(para, i) in story.body" :key="i">{{ para }}</p>
      </div>

      <div class="section-title">
        <h2>Shop the look</h2>
        <button class="btn-primary sm look-btn" @click="shopLook">Add all {{ items.length }} · ${{ lookTotal }}</button>
      </div>
      <div class="product-grid">
        <ProductCard v-for="p in items" :key="p.id" :product="p" compact />
      </div>

      <div class="section-title"><h2>More stories</h2><RouterLink to="/inspiration" class="link">See all</RouterLink></div>
      <div class="more">
        <RouterLink v-for="s in others" :key="s.slug" :to="`/inspiration/${s.slug}`" class="mini" :style="{ background: s.color }">
          <img :src="s.image" alt="" loading="lazy" />
          <b>{{ s.title }}</b>
        </RouterLink>
      </div>
    </div>
  </div>
</template>

<style scoped>
.hero {
  height: 420px;
  border-radius: var(--r-card);
  overflow: hidden;
}
.hero img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.article {
  max-width: 720px;
  margin: 40px auto 0;
}
.article p {
  margin-bottom: 18px;
  font-size: 17px;
  line-height: 1.75;
  color: #3b4047;
}
.article .excerpt {
  font-size: 22px;
  line-height: 1.5;
  color: var(--ink);
}
.look-btn {
  padding: 0 22px;
}
.more {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 18px;
}
.mini {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 10px 20px 10px 10px;
  border-radius: 24px;
  color: inherit;
  text-decoration: none;
  transition: transform 0.2s ease;
}
.mini:hover {
  transform: translateY(-2px);
}
.mini img {
  width: 72px;
  height: 72px;
  border-radius: 18px;
  object-fit: cover;
}
.mini b {
  font-size: 15px;
  font-weight: 500;
}

@media (max-width: 860px) {
  .hero {
    height: 260px;
  }
  .article p {
    font-size: 16px;
  }
  .article .excerpt {
    font-size: 19px;
  }
}
</style>
