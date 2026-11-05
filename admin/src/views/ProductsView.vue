<script setup>
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import PageHeader from '../components/PageHeader.vue'
import StatusTag from '../components/StatusTag.vue'
import StateBlock from '../components/StateBlock.vue'
import Tabs from '../components/Tabs.vue'
import SearchBox from '../components/SearchBox.vue'
import Pager from '../components/Pager.vue'
import Icon from '../components/Icon.vue'
import ImportProductsDialog from '../components/ImportProductsDialog.vue'
import { download, get } from '../api.js'
import { toast } from '../toast.js'
import { categoryTitle, loadMeta, meta } from '../meta.js'
import { useDebouncedSearch, useQueryState, useResource, clampPage } from '../composables.js'
import { count, money } from '../format.js'

const router = useRouter()
loadMeta()
const { state: q, set } = useQueryState({ status: 'all', stock: '', details: '', category: '', sort: 'newest', q: '', page: 1 })
const search = useDebouncedSearch(q, set)
const { data, loading, error, reload } = useResource(() => get('/admin/products', { ...q.value, limit: 25 }), q)

const importing = ref(false)
const exportAll = () => download('/admin/catalog/export', {}, 'cartly-products.csv').catch((e) => toast(e.message, 'error'))

const status = computed({ get: () => q.value.status, set: (v) => set({ status: v }) })
const tabs = computed(() => {
  const c = data.value?.counts ?? {}
  return [
    { value: 'all', label: 'All', count: c.all },
    { value: 'active', label: 'Active', count: c.active },
    { value: 'archived', label: 'Archived', count: c.archived },
  ]
})
const LOW = 5
const emptyText = computed(() => {
  if (q.value.q) return `No products match “${q.value.q}”. Search by name, label, type or product ID.`
  if (q.value.stock === 'low') return 'No products are running low. Nice.'
  if (q.value.stock === 'out') return 'Nothing is sold out.'
  if (q.value.status === 'archived') return 'No archived products. Archive a product to hide it from the store without losing its history.'
  return 'No products match these filters.'
})
clampPage(data, set)
</script>

<template>
  <div>
    <PageHeader title="Products" description="Everything in the catalogue. Changes show up in the store, search and Pip right after you save.">
      <button type="button" class="btn" title="Every product as a CSV: edit it in a spreadsheet and import it back" @click="exportAll"><Icon name="download" :size="16" />Export</button>
      <button v-can="'catalog.write'" type="button" class="btn" @click="importing = true"><Icon name="upload" :size="16" />Import</button>
      <RouterLink v-can="'catalog.write'" to="/products/new" class="btn primary"><Icon name="plus" :size="16" />Add product</RouterLink>
    </PageHeader>
    <ImportProductsDialog :open="importing" @close="importing = false" @imported="reload" />

    <section class="panel">
      <div class="toolbar">
        <Tabs v-model="status" label="Product status" :items="tabs" />
        <SearchBox v-model="search" label="Search products" placeholder="Name, label, type or ID" />
        <div class="filters">
          <label class="sr-only" for="f-stock">Stock</label>
          <select id="f-stock" class="select sm" :value="q.stock" @change="set({ stock: $event.target.value })">
            <option value="">Any stock</option>
            <option value="in">In stock</option>
            <option value="low">Running low (1–{{ LOW }})</option>
            <option value="out">Sold out</option>
          </select>
          <select id="f-details" class="select sm" :value="q.details" aria-label="Pip details" @change="set({ details: $event.target.value })">
            <option value="">Any details</option>
            <option value="incomplete">Missing Pip details</option>
          </select>
          <label class="sr-only" for="f-cat">Category</label>
          <select id="f-cat" class="select sm" :value="q.category" @change="set({ category: $event.target.value })">
            <option value="">All categories</option>
            <option v-for="c in meta.categories" :key="c.slug" :value="c.slug">{{ c.title }}</option>
          </select>
          <label class="sr-only" for="f-sort">Sort</label>
          <select id="f-sort" class="select sm" :value="q.sort" @change="set({ sort: $event.target.value })">
            <option value="newest">Newest first</option>
            <option value="name">Name A–Z</option>
            <option value="price-asc">Price, low to high</option>
            <option value="price-desc">Price, high to low</option>
            <option value="stock-asc">Stock, lowest first</option>
            <option value="popular">Most popular</option>
          </select>
        </div>
      </div>

      <StateBlock :loading="loading && !data" :error="error" :empty="!data?.items.length" :empty-text="emptyText" @retry="reload">
        <div class="table-wrap">
          <table class="table">
            <thead>
              <tr>
                <th>Product</th>
                <th>Category</th>
                <th class="num">Price</th>
                <th class="num">Stock</th>
                <th class="num">Sold</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="p in data.items" :key="p.id" class="row-link" @click="router.push(`/products/${p.id}`)">
                <td class="primary-cell">
                  <div class="with-thumb">
                    <img class="thumb" :src="p.image" alt="" loading="lazy" />
                    <div>
                      <RouterLink :to="`/products/${p.id}`" @click.stop>{{ p.name }}</RouterLink>
                      <span class="sub">#{{ p.id }}, {{ p.label }}</span>
                    </div>
                  </div>
                </td>
                <td>
                  {{ categoryTitle(p.category) }}
                  <span class="sub">{{ p.type }}, {{ p.gender }}</span>
                </td>
                <td class="num">
                  <strong>{{ money(p.price) }}</strong>
                  <s v-if="p.compareAt" class="sub">{{ money(p.compareAt) }}</s>
                </td>
                <td class="num">
                  <span v-if="p.stock <= 0" class="stock out">Sold out</span>
                  <span v-else class="stock" :class="{ low: p.stock <= LOW }">{{ count(p.stock) }}</span>
                </td>
                <td class="num">{{ count(p.unitsSold) }}</td>
                <td>
                  <StatusTag :status="p.active ? 'ACTIVE' : 'ARCHIVED'" />
                  <StatusTag v-if="p.details?.required.length" status="INCOMPLETE" :title="`Pip needs: ${p.details.required.join(', ')}`" />
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <Pager :page="data.page" :pages="data.pages" :total="data.total" :limit="data.limit" noun="products" @go="set({ page: $event })" />
      </StateBlock>
    </section>
  </div>
</template>

<style scoped>
.filters {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-left: auto;
}
.filters .select {
  width: auto;
}
.stock {
  font-weight: 700;
}
.stock.low {
  color: var(--warn);
}
.stock.low::before {
  content: '';
  display: inline-block;
  width: 7px;
  height: 7px;
  margin-right: 6px;
  border-radius: 50%;
  background: #e5a100;
  vertical-align: 1px;
}
.stock.out {
  color: var(--danger);
}
s.sub {
  text-decoration: line-through;
}
</style>
