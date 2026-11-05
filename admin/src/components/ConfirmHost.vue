<script setup>
import { nextTick, ref, watch } from 'vue'
import Dialog from './Dialog.vue'
import { dialog, settle } from '../confirm.js'

const cancelBtn = ref(null)
// Focus the safe choice first.
watch(
  () => dialog.open,
  async (open) => {
    if (open) {
      await nextTick()
      cancelBtn.value?.focus()
    }
  },
)
</script>

<template>
  <Dialog :open="dialog.open" :title="dialog.title" @close="settle(false)">
    <p v-if="dialog.body" class="body">{{ dialog.body }}</p>
    <div class="actions">
      <button ref="cancelBtn" class="btn" @click="settle(false)">Keep it</button>
      <button class="btn" :class="dialog.danger ? 'danger solid' : 'primary'" @click="settle(true)">{{ dialog.confirmLabel }}</button>
    </div>
  </Dialog>
</template>

<style scoped>
.body {
  color: var(--ink-2);
  line-height: 1.55;
}
.actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 4px;
}
</style>
