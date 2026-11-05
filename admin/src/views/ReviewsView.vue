<script setup>
// How the reviewer said it fit (feeds the product's "runs small / large" verdict; deleting the review takes it back out).
const FIT = { small: 'Runs small', true: 'True to size', large: 'Runs large' }
import { computed } from 'vue'
import PageHeader from '../components/PageHeader.vue'
import StateBlock from '../components/StateBlock.vue'
import Tabs from '../components/Tabs.vue'
import SearchBox from '../components/SearchBox.vue'
import Pager from '../components/Pager.vue'
import Stars from '../components/Stars.vue'
import { del, get } from '../api.js'
import { confirm } from '../confirm.js'
import { useDebouncedSearch, useQueryState, useResource, clampPage } from '../composables.js'
import { date } from '../format.js'
import { toast } from '../toast.js'

const { state: q, set } = useQueryState({ source: 'all', rating: '', productId: '', q: '', page: 1 })
const search = useDebouncedSearch(q, set)
const { data, loading, error, reload } = useResource(() => get('/admin/reviews', { ...q.value, limit: 20 }), q)
const source = computed({ get: () => q.value.source, set: (v) => set({ source: v }) })
const product = computed(() => (q.value.productId && data.value?.items[0]?.product.id === Number(q.value.productId) ? data.value.items[0].product : null))

async function remove(r) {
  const ok = await confirm({
    title: 'Delete this review?',
    body: `“${r.title}” by ${r.author} will be removed from ${r.product.name}, and the product’s rating recalculated. This can’t be undone.`,
    confirmLabel: 'Delete review',
    danger: true,
  })
  if (!ok) return
  try {
    await del(`/admin/reviews/${r.id}`)
    toast('Review deleted')
    reload({ quiet: true })
  } catch (e) {
    toast(e.message, 'error')
  }
}
clampPage(data, set)
</script>

<template>
  <div>
    <PageHeader title="Reviews" description="What customers say about the products. Remove anything abusive, off-topic or fake." />
    <section class="panel">
      <div class="toolbar">
        <Tabs
          v-model="source"
          label="Source"
          :items="[
            { value: 'all', label: 'All reviews' },
            { value: 'customer', label: 'From customers' },
          ]"
        />
        <SearchBox v-model="search" label="Search reviews" placeholder="Words, author or product" />
        <label class="sr-only" for="r-rating">Rating</label>
        <select id="r-rating" class="select sm rating" :value="q.rating" @change="set({ rating: $event.target.value })">
          <option value="">Any rating</option>
          <option v-for="n in [5, 4, 3, 2, 1]" :key="n" :value="String(n)">{{ n }} {{ n === 1 ? 'star' : 'stars' }}</option>
        </select>
      </div>
      <div v-if="q.productId" class="filter-note">
        Showing reviews for {{ product?.name ?? `product #${q.productId}` }}.
        <button class="link-btn" @click="set({ productId: '' })">Show all products</button>
      </div>
      <StateBlock
        :loading="loading && !data"
        :error="error"
        :empty="!data?.items.length"
        :empty-text="q.source === 'customer' && !q.q && !q.rating ? 'No customer reviews yet. Reviews written in the store show up here.' : 'No reviews match these filters.'"
        @retry="reload"
      >
        <ul class="reviews">
          <li v-for="r in data.items" :key="r.id">
            <RouterLink :to="`/products/${r.product.id}`" class="product">
              <img class="thumb" :src="r.product.image" alt="" loading="lazy" />
            </RouterLink>
            <div class="body">
              <div class="meta">
                <Stars :rating="r.rating" />
                <RouterLink :to="`/products/${r.product.id}`">{{ r.product.name }}</RouterLink>
              </div>
              <strong>{{ r.title }}</strong>
              <p>{{ r.text }}</p>
              <span v-if="r.size || r.fit || r.heightCm || r.usualSize" class="fit-line">
                {{ [r.size && `Bought ${r.size}`, r.fit && FIT[r.fit], r.heightCm && `${r.heightCm} cm`, r.usualSize && `usually ${r.usualSize}`].filter(Boolean).join(' · ') }}
              </span>
              <div v-if="r.photos?.length" class="photos">
                <a v-for="u in r.photos" :key="u" :href="u" target="_blank" rel="noopener"><img :src="u" alt="Customer photo" loading="lazy" /></a>
              </div>
              <span class="muted by">
                <template v-if="r.customer"><RouterLink :to="`/customers/${r.customer.id}`">{{ r.author }}</RouterLink></template>
                <template v-else>{{ r.author }} (catalogue review)</template>, {{ date(r.createdAt) }}
                <b v-if="r.verified" class="verified">· Verified purchase</b>
              </span>
            </div>
            <button v-can="'reviews.write'" class="btn danger sm" @click="remove(r)">Delete</button>
          </li>
        </ul>
        <Pager :page="data.page" :pages="data.pages" :total="data.total" :limit="data.limit" noun="reviews" @go="set({ page: $event })" />
      </StateBlock>
    </section>
  </div>
</template>

<style scoped>
.rating {
  width: auto;
  margin-left: auto;
}
.filter-note {
  padding: 10px 16px;
  border-bottom: 1px solid var(--line);
  background: var(--accent-soft);
  font-size: 13.5px;
  font-weight: 600;
}
.reviews {
  margin: 0;
  padding: 0;
  list-style: none;
}
.reviews li {
  display: flex;
  align-items: flex-start;
  gap: 14px;
  padding: 14px 18px;
  border-top: 1px solid var(--line);
}
.reviews li:first-child {
  border-top: 0;
}
.thumb {
  width: 48px;
  height: 48px;
}
.body {
  display: grid;
  gap: 4px;
  flex: 1;
  min-width: 0;
  max-width: 78ch;
}
.meta {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  font-size: 13px;
  font-weight: 650;
}
.body p {
  color: var(--ink-2);
  line-height: 1.5;
}
.by {
  font-size: 12.5px;
}
.fit-line {
  display: block;
  margin-top: 4px;
  font-size: 13px;
  color: #4b5058;
}
.photos {
  display: flex;
  gap: 6px;
  margin-top: 8px;
}
.photos img {
  width: 64px;
  height: 64px;
  border-radius: 10px;
  object-fit: cover;
}
.verified {
  color: #1a7f4b;
  font-weight: 500;
}
</style>
