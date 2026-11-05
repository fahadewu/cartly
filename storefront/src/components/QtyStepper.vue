<script setup>
import Icon from './Icon.vue'

defineProps({ value: { type: Number, required: true }, small: Boolean, min: { type: Number, default: 0 } })
defineEmits(['inc', 'dec'])
</script>

<template>
  <div class="qty" :class="{ small }">
    <button type="button" aria-label="Decrease quantity" :disabled="value <= min" @click="$emit('dec')">
      <Icon name="minus" :size="small ? 13 : 16" />
    </button>
    <span aria-live="polite">{{ value }}</span>
    <button type="button" aria-label="Increase quantity" @click="$emit('inc')">
      <Icon name="plus" :size="small ? 13 : 16" />
    </button>
  </div>
</template>

<style scoped>
.qty {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 58px;
  padding: 6px;
  border-radius: var(--r-pill);
  background: var(--chip);
}
.qty span {
  min-width: 32px;
  text-align: center;
  font-weight: 500;
}
.qty button {
  display: grid;
  place-items: center;
  width: 46px;
  height: 46px;
  border-radius: 50%;
  background: #fff;
  transition: transform 0.15s ease;
}
.qty button:hover:not(:disabled) {
  transform: scale(1.08);
}
.qty button:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.small {
  height: 36px;
  padding: 4px;
  font-size: 14px;
}
.small span {
  min-width: 22px;
}
.small button {
  width: 28px;
  height: 28px;
}
</style>
