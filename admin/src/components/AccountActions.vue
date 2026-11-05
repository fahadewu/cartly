<script setup>
import { computed, reactive } from 'vue'
import Dialog from './Dialog.vue'
import Icon from './Icon.vue'
import RolePicker from './RolePicker.vue'
import CredentialsNote from './CredentialsNote.vue'
import { patch, post } from '../api.js'
import { auth, can, isStaffRole } from '../auth.js'
import { confirm } from '../confirm.js'
import { roleLabel } from '../roles.js'
import { toast } from '../toast.js'

// Change role, reset password, turn off / on — for one account. Staff accounts need the team
// permission (admins); customer accounts need customers.write. You can't act on yourself.
const props = defineProps({ user: { type: Object, required: true }, compact: Boolean })
const emit = defineEmits(['updated'])

const isMe = computed(() => props.user.id === auth.user?.id)
const staff = computed(() => isStaffRole(props.user.role))
const allowed = computed(() => !isMe.value && props.user.role !== 'RIDER' && can(staff.value ? 'team.write' : 'customers.write'))
const why = computed(() =>
  isMe.value
    ? 'You can’t change your own account here. Ask another admin.'
    : staff.value
      ? 'Only admins can manage staff accounts.'
      : `Your role (${auth.user?.roleLabel}) can’t manage customer accounts.`,
)

const roleForm = reactive({ open: false, role: '', saving: false, error: '' })
const reset = reactive({ open: false, password: '', email: '' })
const busy = reactive({ reset: false, power: false })

function openRole() {
  Object.assign(roleForm, { open: true, role: props.user.role, saving: false, error: '' })
}
async function saveRole() {
  if (roleForm.role === props.user.role) return (roleForm.open = false)
  const toStaff = isStaffRole(roleForm.role)
  const ok = await confirm({
    title: `Make ${props.user.name} ${/^[AEIOU]/.test(roleLabel(roleForm.role)) ? 'an' : 'a'} ${roleLabel(roleForm.role)}?`,
    body: toStaff
      ? `They’ll be able to sign in to the admin panel with what a ${roleLabel(roleForm.role)} can do, straight away.`
      : 'They’ll lose admin panel access straight away. Their shopping account stays as it is.',
    confirmLabel: 'Change role',
    danger: !toStaff,
  })
  if (!ok) return
  roleForm.saving = true
  roleForm.error = ''
  try {
    const u = await patch(`/admin/users/${props.user.id}`, { role: roleForm.role })
    roleForm.open = false
    toast(`${u.name} is now ${roleLabel(u.role)}`)
    emit('updated', u)
  } catch (e) {
    roleForm.error = e.message
  } finally {
    roleForm.saving = false
  }
}

async function resetPassword() {
  const ok = await confirm({
    title: `Reset ${props.user.name}’s password?`,
    body: 'Their current password stops working at once. You’ll get a temporary one to pass on.',
    confirmLabel: 'Reset password',
    danger: true,
  })
  if (!ok) return
  busy.reset = true
  try {
    const r = await post(`/admin/users/${props.user.id}/reset-password`, {})
    Object.assign(reset, { open: true, password: r.temporaryPassword, email: r.user.email })
    emit('updated', r.user)
  } catch (e) {
    toast(e.message, 'error')
  } finally {
    busy.reset = false
  }
}

async function togglePower() {
  const off = !props.user.disabled
  const ok = await confirm(
    off
      ? {
          title: `Turn off ${props.user.name}’s account?`,
          body: staff.value
            ? 'They’re signed out of the admin panel at once and can’t sign in again until it’s turned back on. Nothing they did is deleted.'
            : 'They can’t sign in to the store until it’s turned back on. Their orders and history stay.',
          confirmLabel: 'Turn off',
          danger: true,
        }
      : { title: `Turn ${props.user.name}’s account back on?`, body: 'They can sign in again with their current password.', confirmLabel: 'Turn on' },
  )
  if (!ok) return
  busy.power = true
  try {
    const u = await post(`/admin/users/${props.user.id}/${off ? 'disable' : 'enable'}`)
    toast(off ? `${u.name}’s account is off` : `${u.name}’s account is back on`)
    emit('updated', u)
  } catch (e) {
    toast(e.message, 'error')
  } finally {
    busy.power = false
  }
}
</script>

<template>
  <div class="account-actions" :class="{ compact }">
    <template v-if="allowed">
      <!-- In a table row the actions are icons, labelled for screen readers and on hover. -->
      <button class="btn" :class="{ 'sm icon-only': compact }" :aria-label="`Change ${user.name}’s role`" :title="compact ? 'Change role' : undefined" @click="openRole">
        <Icon name="team" :size="16" /><span v-if="!compact">Change role</span>
      </button>
      <button class="btn" :class="{ 'sm icon-only': compact }" :aria-label="`Reset ${user.name}’s password`" :title="compact ? 'Reset password' : undefined" :disabled="busy.reset" @click="resetPassword">
        <Icon name="key" :size="16" /><span v-if="!compact">Reset password</span>
      </button>
      <button
        class="btn"
        :class="[{ 'sm icon-only': compact }, user.disabled ? '' : 'danger']"
        :aria-label="`${user.disabled ? 'Turn on' : 'Turn off'} ${user.name}’s account`"
        :title="compact ? (user.disabled ? 'Turn account on' : 'Turn account off') : undefined"
        :disabled="busy.power"
        @click="togglePower"
      >
        <Icon name="power" :size="16" /><span v-if="!compact">{{ user.disabled ? 'Turn on' : 'Turn off' }}</span>
      </button>
    </template>
    <span v-else-if="!compact && user.role !== 'RIDER'" class="muted small why"><Icon name="lock" :size="14" />{{ why }}</span>

    <Dialog :open="roleForm.open" :title="`Change ${user.name}’s role`" wide @close="roleForm.open = false">
      <form class="dialog-form" @submit.prevent="saveRole">
        <p v-if="roleForm.error" class="form-error" role="alert">{{ roleForm.error }}</p>
        <RolePicker v-model="roleForm.role" :staff-allowed="can('team.write')" :customer-allowed="can('customers.write')" legend="New role" />
        <div class="dialog-buttons">
          <button type="button" class="btn" @click="roleForm.open = false">Cancel</button>
          <button class="btn primary" :disabled="roleForm.saving || roleForm.role === user.role">{{ roleForm.saving ? 'Saving…' : 'Save role' }}</button>
        </div>
      </form>
    </Dialog>

    <Dialog :open="reset.open" :title="`New password for ${user.name}`" @close="reset.open = false">
      <div class="dialog-form">
        <CredentialsNote :email="reset.email" :password="reset.password" :staff="staff" />
        <div class="dialog-buttons"><button class="btn primary" @click="reset.open = false">Done</button></div>
      </div>
    </Dialog>
  </div>
</template>

<style scoped>
.account-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  align-items: center;
}
.icon-only {
  width: 32px;
  padding: 0;
  justify-content: center;
}
.why {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.small {
  font-size: 13px;
}
.dialog-form {
  display: grid;
  gap: 16px;
}
.dialog-buttons {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
