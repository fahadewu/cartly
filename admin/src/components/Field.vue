<script setup>
// Label + control + hint/error. The control goes in the default slot and gets `id`.
defineProps({ label: String, id: String, hint: String, error: String, optional: Boolean })
</script>

<template>
  <div class="field" :class="{ invalid: error }">
    <label :for="id">{{ label }}<span v-if="optional" class="opt"> (optional)</span></label>
    <slot />
    <p v-if="error" :id="`${id}-error`" class="error">{{ error }}</p>
    <p v-else-if="hint" class="hint">{{ hint }}</p>
  </div>
</template>

<style scoped>
.field {
  display: grid;
  gap: 6px;
  min-width: 0;
  align-content: start;
}
label {
  font-size: 13px;
  font-weight: 700;
}
.opt {
  font-weight: 500;
  color: var(--muted);
}
.hint,
.error {
  font-size: 12.5px;
  line-height: 1.4;
}
.hint {
  color: var(--muted);
}
.error {
  color: var(--danger);
  font-weight: 600;
}
</style>
