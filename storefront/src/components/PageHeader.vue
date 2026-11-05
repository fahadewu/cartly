<script setup>
import Icon from './Icon.vue'

defineProps({
  title: String,
  subtitle: String,
  crumbs: { type: Array, default: () => [] }, // [{ label, to }]
})
</script>

<template>
  <header class="page-head">
    <div class="text">
      <nav v-if="crumbs.length" class="crumbs" aria-label="Breadcrumb">
        <template v-for="(c, i) in crumbs" :key="c.label">
          <RouterLink v-if="c.to" :to="c.to">{{ c.label }}</RouterLink>
          <span v-else aria-current="page">{{ c.label }}</span>
          <Icon v-if="i < crumbs.length - 1" name="chevronRight" :size="14" />
        </template>
      </nav>
      <h1 v-if="title">{{ title }}</h1>
      <p v-if="subtitle">{{ subtitle }}</p>
    </div>
    <div v-if="$slots.default" class="actions"><slot /></div>
  </header>
</template>

<style scoped>
.page-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 24px;
  padding: 36px 34px 26px 22px;
  border-bottom: 1px solid var(--line);
}
.crumbs {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 12px;
  font-size: 13px;
  color: var(--muted);
}
.crumbs:last-child {
  margin-bottom: 0;
}
.crumbs a {
  color: inherit;
  text-decoration: none;
}
.crumbs a:hover {
  color: var(--blue);
}
.crumbs span {
  color: var(--ink);
}
h1 {
  font-size: 34px;
  font-weight: 500;
  letter-spacing: -0.02em;
}
p {
  margin-top: 8px;
  font-size: 15px;
  color: var(--muted);
}
.actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

@media (max-width: 860px) {
  .page-head {
    flex-direction: column;
    align-items: stretch;
    padding: 24px 16px 20px;
  }
  h1 {
    font-size: 28px;
  }
}
</style>
