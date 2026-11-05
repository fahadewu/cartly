<script setup>
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import Icon from './Icon.vue'
import { auth, can } from '../auth.js'
defineProps({ title: String, description: String, back: [String, Object], backLabel: { type: String, default: 'Back' } })

// Pages the signed-in role can look at but not change say so up front.
const route = useRoute()
const NOTHING_TO_CHANGE = ['dashboard', 'analytics']
const viewOnly = computed(() => {
  const area = route.meta.area
  return !!area && !NOTHING_TO_CHANGE.includes(area) && can(`${area}.read`) && !can(`${area}.write`)
})
</script>

<template>
  <header class="page-header">
    <div class="text">
      <RouterLink v-if="back" :to="back" class="back"><Icon name="back" :size="16" />{{ backLabel }}</RouterLink>
      <div class="title-row">
        <h1 class="display">{{ title }}</h1>
        <slot name="tag" />
        <span v-if="viewOnly" class="view-only" :title="`Your role (${auth.user?.roleLabel}) can look but not change anything here.`">
          <Icon name="eye" :size="14" />View only
        </span>
      </div>
      <p v-if="description || $slots.description" class="muted"><slot name="description">{{ description }}</slot></p>
    </div>
    <div v-if="$slots.default" class="actions"><slot /></div>
  </header>
</template>

<style scoped>
.page-header {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 16px 24px;
  flex-wrap: wrap;
  margin-bottom: 22px;
}
.text {
  min-width: 0;
  max-width: 72ch;
}
.back {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-bottom: 8px;
  color: var(--muted);
  font-weight: 650;
  font-size: 13px;
}
.title-row {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
h1 {
  font-size: 30px;
}
p {
  margin-top: 6px;
  font-size: 14.5px;
}
.view-only {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 9px;
  border-radius: var(--r-tag);
  background: var(--grey);
  color: var(--ink-2);
  font-size: 12px;
  font-weight: 700;
}
.actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
@media (max-width: 600px) {
  h1 {
    font-size: 25px;
  }
}
</style>
