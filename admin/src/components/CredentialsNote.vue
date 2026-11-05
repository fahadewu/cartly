<script setup>
import { ref } from 'vue'
import Icon from './Icon.vue'
import { toast } from '../toast.js'

// A password made by the API, shown once so the admin can pass it on.
const props = defineProps({ email: String, password: String, staff: Boolean })
const copied = ref(false)
async function copy() {
  try {
    await navigator.clipboard.writeText(`Email: ${props.email}\nTemporary password: ${props.password}`)
    copied.value = true
    setTimeout(() => (copied.value = false), 2000)
  } catch {
    toast('Couldn’t copy. Select the password and copy it yourself.', 'error')
  }
}
</script>

<template>
  <div class="creds" role="status">
    <p class="lead"><Icon name="key" :size="16" />Share these sign-in details with them. The password is shown only this once.</p>
    <dl>
      <dt>Email</dt>
      <dd>{{ email }}</dd>
      <dt>Temporary password</dt>
      <dd><code>{{ password }}</code></dd>
    </dl>
    <button type="button" class="btn sm" @click="copy"><Icon :name="copied ? 'check' : 'copy'" :size="15" />{{ copied ? 'Copied' : 'Copy details' }}</button>
    <p v-if="staff" class="muted small">They’ll be asked to choose their own password the first time they sign in to the admin panel.</p>
    <p v-else class="muted small">Ask them to change it from Account → Password on the store after signing in.</p>
  </div>
</template>

<style scoped>
.creds {
  display: grid;
  gap: 10px;
  padding: 14px;
  border: 1px solid var(--line-strong);
  border-radius: var(--r-control);
  background: var(--hover);
}
.lead {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  font-weight: 650;
}
.lead svg {
  flex: none;
  margin-top: 2px;
  color: var(--accent);
}
dl {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 4px 14px;
  margin: 0;
}
dt {
  color: var(--muted);
  font-size: 13px;
}
dd {
  margin: 0;
  font-weight: 650;
  overflow-wrap: anywhere;
}
code {
  font: 700 15px/1.3 ui-monospace, SFMono-Regular, Menlo, monospace;
  letter-spacing: 0.04em;
  user-select: all;
}
.btn {
  justify-self: start;
}
.small {
  font-size: 12.5px;
}
</style>
