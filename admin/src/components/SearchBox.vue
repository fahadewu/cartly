<script setup>
import Icon from './Icon.vue'
defineProps({ modelValue: String, label: { type: String, default: 'Search' }, placeholder: String })
const emit = defineEmits(['update:modelValue'])
</script>

<template>
  <div class="search">
    <Icon name="search" :size="16" />
    <input
      class="input"
      type="search"
      :aria-label="label"
      :placeholder="placeholder ?? label"
      :value="modelValue"
      @input="emit('update:modelValue', $event.target.value)"
    />
  </div>
</template>
