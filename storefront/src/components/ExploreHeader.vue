<script setup>
import { ref, nextTick } from 'vue'
import { useRouter } from 'vue-router'
import Icon from './Icon.vue'

const category = defineModel('category', { default: 'all' })
const query = defineModel('query', { default: '' })

const tabs = [
  { id: 'all', label: 'All', icon: 'grid' },
  { id: 'men', label: 'Men', icon: 'man' },
  { id: 'women', label: 'Women', icon: 'woman' },
]

const router = useRouter()
const searching = ref(false)
const input = ref(null)

async function openSearch() {
  searching.value = !searching.value
  if (searching.value) {
    await nextTick()
    input.value?.focus()
  } else {
    query.value = ''
  }
}
</script>

<template>
  <div class="explore">
    <h1>Explore</h1>

    <div class="tabs" role="tablist">
      <button
        v-for="t in tabs"
        :key="t.id"
        role="tab"
        :aria-selected="category === t.id"
        class="pill tab"
        :class="{ on: category === t.id }"
        @click="category = t.id"
      >
        <Icon :name="t.icon" :size="18" />
        {{ t.label }}
      </button>
    </div>

    <div class="tools">
      <input
        v-if="searching"
        ref="input"
        v-model="query"
        class="pill search-input"
        placeholder="Search products…"
        @keydown.esc="openSearch"
        @keydown.enter="query.trim() && router.push({ name: 'shop', query: { q: query.trim() } })"
      />
      <RouterLink to="/shop" class="pill filters">Filters<i /></RouterLink>
      <button class="pill round" :aria-label="searching ? 'Close search' : 'Search'" @click="openSearch">
        <Icon :name="searching ? 'close' : 'search'" :size="22" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.explore {
  display: flex;
  align-items: center;
  gap: 24px;
  padding: 40px 34px 24px 22px;
  border-bottom: 1px solid var(--line);
}

h1 {
  font-size: 34px;
  font-weight: 500;
  letter-spacing: -0.02em;
  margin-right: 110px;
}

.tabs {
  display: flex;
  gap: 4px;
}
.tab {
  position: relative;
  height: 60px;
  padding: 0 32px;
  color: var(--muted);
}
.tab.on {
  color: var(--ink);
}
.tab:hover {
  color: var(--ink);
}
.tab.on::after {
  content: '';
  position: absolute;
  left: 50%;
  bottom: -26px;
  width: 24px;
  height: 5px;
  margin-left: -12px;
  border-radius: 4px;
  background: var(--blue);
}

.tools {
  display: flex;
  gap: 4px;
  margin-left: auto;
}
.filters {
  position: relative;
  color: inherit;
  text-decoration: none;
  height: 60px;
  padding: 0 42px;
}
.filters i {
  position: absolute;
  top: -1px;
  right: 8px;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--blue);
}
.round {
  justify-content: center;
  width: 60px;
  height: 60px;
  padding: 0;
}
.pill:hover {
  background: var(--line);
}
.search-input {
  height: 60px;
  width: 240px;
  border: 0;
  outline-offset: -2px;
  animation: grow 0.25s ease;
}
@keyframes grow {
  from {
    width: 60px;
    opacity: 0;
  }
}

@media (max-width: 1280px) {
  h1 {
    margin-right: 0;
  }
}
@media (max-width: 860px) {
  .explore {
    flex-wrap: wrap;
    padding: 28px 16px 20px;
    gap: 16px;
  }
  h1 {
    font-size: 28px;
  }
  .tabs {
    order: 3;
    width: 100%;
  }
  .tab {
    flex: 1;
    justify-content: center;
    height: 50px;
    padding: 0 12px;
  }
  .tab.on::after {
    bottom: -14px;
  }
  .filters,
  .round {
    height: 50px;
  }
  .filters {
    padding: 0 22px;
  }
  .round {
    width: 50px;
  }
  .search-input {
    height: 50px;
    width: 150px;
  }
}
</style>
