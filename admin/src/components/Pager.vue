<script setup>
import { computed } from 'vue'
const props = defineProps({ page: Number, pages: Number, total: Number, limit: Number, noun: { type: String, default: 'results' } })
const emit = defineEmits(['go'])
const from = computed(() => (props.total ? (props.page - 1) * props.limit + 1 : 0))
const to = computed(() => Math.min(props.total, props.page * props.limit))
</script>

<template>
  <div v-if="total" class="pager panel-foot">
    <span class="muted figures">{{ from }}–{{ to }} of {{ total }} {{ noun }}</span>
    <div v-if="pages > 1" class="buttons">
      <button class="btn sm" :disabled="page <= 1" @click="emit('go', page - 1)">Previous</button>
      <span class="figures muted">Page {{ page }} of {{ pages }}</span>
      <button class="btn sm" :disabled="page >= pages" @click="emit('go', page + 1)">Next</button>
    </div>
  </div>
</template>

<style scoped>
.pager {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
  font-size: 13px;
}
.buttons {
  display: flex;
  align-items: center;
  gap: 10px;
}
</style>
