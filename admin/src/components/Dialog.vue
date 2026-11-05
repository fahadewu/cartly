<script setup>
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'

// Native <dialog>: showModal() traps focus and makes the page behind inert; Esc closes it.
const props = defineProps({ open: Boolean, title: String, wide: Boolean })
const emit = defineEmits(['close'])
const el = ref(null)
let opener = null

watch(
  () => props.open,
  async (open) => {
    await nextTick()
    if (!el.value) return
    if (open && !el.value.open) {
      opener = document.activeElement
      el.value.showModal()
    } else if (!open && el.value.open) {
      el.value.close()
      opener?.focus?.()
    }
  },
  { immediate: true },
)
onBeforeUnmount(() => el.value?.open && el.value.close())
</script>

<template>
  <dialog ref="el" class="dialog" :class="{ wide }" :aria-label="title" @cancel.prevent="emit('close')" @click.self="emit('close')">
    <div class="box">
      <h2 v-if="title" class="display">{{ title }}</h2>
      <slot />
    </div>
  </dialog>
</template>

<style scoped>
.dialog {
  width: min(440px, calc(100vw - 32px));
  max-height: calc(100dvh - 48px);
  padding: 0;
  border: 1px solid var(--line);
  border-radius: var(--r-panel);
  background: var(--surface);
  color: var(--ink);
  box-shadow: 0 24px 60px -24px rgba(18, 20, 23, 0.4);
}
.dialog.wide {
  width: min(560px, calc(100vw - 32px));
}
.dialog::backdrop {
  background: rgba(18, 20, 23, 0.35);
}
.box {
  display: grid;
  gap: 14px;
  padding: 22px 22px 20px;
}
h2 {
  font-size: 21px;
}
</style>
