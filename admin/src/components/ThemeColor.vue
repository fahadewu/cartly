<script setup>
import { computed } from 'vue'
import { THEME_COLORS } from '../format.js'

// Background colour for storefront banners: one of the store's pastel tokens, or a custom hex.
const props = defineProps({ modelValue: String, id: String })
const emit = defineEmits(['update:modelValue'])
const custom = computed(() => !THEME_COLORS.some((c) => c.token === props.modelValue))
</script>

<template>
  <div :id="id" class="theme" role="radiogroup" aria-label="Banner colour">
    <label v-for="c in THEME_COLORS" :key="c.token" class="opt" :class="{ on: modelValue === c.token }">
      <input type="radio" :name="`${id}-theme`" :value="c.token" :checked="modelValue === c.token" @change="emit('update:modelValue', c.token)" />
      <span class="swatch" :style="{ background: c.hex }" />{{ c.name }}
    </label>
    <label class="opt" :class="{ on: custom }">
      <input type="color" :value="custom && /^#[0-9a-f]{6}$/i.test(modelValue) ? modelValue : '#e7eeff'" aria-label="Custom colour" @input="emit('update:modelValue', $event.target.value)" />
      Custom
    </label>
  </div>
</template>

<style scoped>
.theme {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.opt {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  height: 32px;
  padding: 0 11px 0 7px;
  border: 1px solid var(--line);
  border-radius: 999px;
  font-size: 13px;
  font-weight: 650;
  cursor: pointer;
}
.opt.on {
  border-color: var(--ink);
  box-shadow: inset 0 0 0 1px var(--ink);
}
.opt:focus-within {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.opt input[type='radio'] {
  position: absolute;
  opacity: 0;
  pointer-events: none;
}
.opt input[type='color'] {
  width: 20px;
  height: 20px;
  padding: 0;
  border: 1px solid rgba(0, 0, 0, 0.12);
  border-radius: 50%;
  background: none;
  cursor: pointer;
}
.opt input[type='color']::-webkit-color-swatch-wrapper {
  padding: 0;
}
.opt input[type='color']::-webkit-color-swatch {
  border: 0;
  border-radius: 50%;
}
</style>
