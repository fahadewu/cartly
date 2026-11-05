<script setup>
import { computed, reactive, watch } from 'vue'
import Dialog from './Dialog.vue'
import Field from './Field.vue'
import RolePicker from './RolePicker.vue'
import CredentialsNote from './CredentialsNote.vue'
import { post } from '../api.js'
import { can, isStaffRole } from '../auth.js'
import { toast } from '../toast.js'

// Adds a customer or (admins only) a staff account. Without a typed password the API makes a
// temporary one and returns it once, which this dialog then shows.
const props = defineProps({ open: Boolean, role: { type: String, default: 'CUSTOMER' } })
const emit = defineEmits(['close', 'created'])

const STRONG = /^(?:(?=.*[a-z])(?=.*[A-Z])(?=.*\d)|(?=.*[a-z])(?=.*[A-Z])(?=.*[^A-Za-z0-9])|(?=.*[a-z])(?=.*\d)(?=.*[^A-Za-z0-9])|(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9])).{8,}$/
const blank = () => ({ name: '', email: '', role: props.role, password: 'generate', typed: '', mustChange: true, errors: {}, error: '', saving: false, done: null })
const f = reactive(blank())
watch(
  () => props.open,
  (open) => open && Object.assign(f, blank()),
)
const staff = computed(() => isStaffRole(f.role))
const title = computed(() => (f.done ? `${f.done.user.name} is added` : staff.value ? 'Add a staff member' : 'Add a customer'))

function validate() {
  const e = {}
  if (f.name.trim().length < 2) e.name = 'Enter their name.'
  if (!/^\S+@\S+\.\S+$/.test(f.email.trim())) e.email = 'Enter a valid email address.'
  if (f.password === 'set' && !STRONG.test(f.typed)) e.password = 'Use 8+ characters mixing upper and lower case, numbers or symbols.'
  f.errors = e
  return !Object.keys(e).length
}

async function save() {
  f.error = ''
  if (!validate()) return
  f.saving = true
  try {
    const body = { name: f.name.trim(), email: f.email.trim(), role: f.role }
    if (f.password === 'set') Object.assign(body, { password: f.typed, mustChange: f.mustChange })
    f.done = await post('/admin/users', body)
    toast(`${f.done.user.name} added as ${staff.value ? 'staff' : 'a customer'}`)
    emit('created', f.done.user)
    if (!f.done.temporaryPassword) emit('close')
  } catch (e) {
    f.error = e.message
  } finally {
    f.saving = false
  }
}
</script>

<template>
  <Dialog :open="open" :title="title" wide @close="emit('close')">
    <div v-if="f.done" class="dialog-form">
      <CredentialsNote :email="f.done.user.email" :password="f.done.temporaryPassword" :staff="staff" />
      <div class="dialog-buttons">
        <RouterLink :to="`/customers/${f.done.user.id}`" class="btn" @click="emit('close')">Open their account</RouterLink>
        <button type="button" class="btn primary" @click="emit('close')">Done</button>
      </div>
    </div>

    <form v-else class="dialog-form" novalidate autocomplete="off" @submit.prevent="save">
      <p v-if="f.error" class="form-error" role="alert">{{ f.error }}</p>
      <div class="two">
        <Field id="au-name" label="Name" :error="f.errors.name">
          <input id="au-name" v-model="f.name" class="input" maxlength="80" :aria-invalid="!!f.errors.name" />
        </Field>
        <Field id="au-email" label="Email" :error="f.errors.email" :hint="staff ? 'They sign in to the admin panel with it.' : 'They sign in to the store with it.'">
          <input id="au-email" v-model="f.email" class="input" type="email" maxlength="160" autocomplete="off" :aria-invalid="!!f.errors.email" />
        </Field>
      </div>

      <RolePicker v-model="f.role" :staff-allowed="can('team.write')" :customer-allowed="can('customers.write')" />

      <fieldset class="pw">
        <legend>Password</legend>
        <label class="check">
          <input v-model="f.password" type="radio" value="generate" />
          <span>Make a temporary password <span class="muted">(shown once, for you to pass on)</span></span>
        </label>
        <label class="check">
          <input v-model="f.password" type="radio" value="set" />
          <span>I’ll set one now</span>
        </label>
        <template v-if="f.password === 'set'">
          <Field id="au-pass" label="Their password" :error="f.errors.password" hint="8+ characters mixing upper and lower case, numbers or symbols.">
            <input id="au-pass" v-model="f.typed" class="input" type="password" autocomplete="new-password" :aria-invalid="!!f.errors.password" />
          </Field>
          <label v-if="staff" class="check">
            <input v-model="f.mustChange" type="checkbox" />
            <span>Ask them to choose their own at first sign-in</span>
          </label>
        </template>
      </fieldset>

      <div class="dialog-buttons">
        <button type="button" class="btn" @click="emit('close')">Cancel</button>
        <button class="btn primary" :disabled="f.saving">{{ f.saving ? 'Adding…' : staff ? 'Add staff member' : 'Add customer' }}</button>
      </div>
    </form>
  </Dialog>
</template>

<style scoped>
.dialog-form {
  display: grid;
  gap: 16px;
}
.two {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.pw {
  display: grid;
  gap: 8px;
  margin: 0;
  padding: 0;
  border: 0;
}
.pw legend {
  margin-bottom: 6px;
  font-size: 13px;
  font-weight: 700;
}
.check {
  font-weight: 550;
}
.dialog-buttons {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  flex-wrap: wrap;
}
@media (max-width: 560px) {
  .two {
    grid-template-columns: 1fr;
  }
}
</style>
