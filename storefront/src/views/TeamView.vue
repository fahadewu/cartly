<script setup>
import { reactive, ref, computed } from 'vue'
import PageHeader from '../components/PageHeader.vue'
import AuthField from '../components/AuthField.vue'
import Icon from '../components/Icon.vue'
import { useShop } from '../store.js'
import { auth } from '../auth.js'
import { toast } from '../toast.js'

const { state, addMember, updateMember, removeMember } = useShop()

const ROLES = {
  Admin: 'Manage team, billing and every order',
  Buyer: 'Place orders and manage the cart',
  Viewer: 'Browse and save favourites only',
}

const form = reactive({ name: '', email: '', role: 'Buyer' })
const errors = reactive({})
const confirming = ref(null)

const owner = computed(() => ({ name: auth.user?.name ?? 'You', email: auth.user?.email ?? '' }))

const sending = ref(false)
async function submit() {
  const e = {}
  const email = form.email.trim().toLowerCase()
  if (form.name.trim().length < 2) e.name = 'Enter their name.'
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) e.email = 'Enter a valid email.'
  else if (email === owner.value.email || state.members.some((m) => m.email === email)) e.email = 'This person is already on your team.'
  Object.keys(errors).forEach((k) => delete errors[k])
  Object.assign(errors, e)
  if (Object.keys(e).length) return
  sending.value = true
  try {
    await addMember({ name: form.name.trim(), email, role: form.role })
    toast(`Invite sent to ${email}`)
    Object.assign(form, { name: '', email: '', role: 'Buyer' })
  } catch (err) {
    errors.email = err.message
  } finally {
    sending.value = false
  }
}

async function changeRole(m, role) {
  try {
    await updateMember(m.id, role)
    toast(`${m.name} is now a ${role.toLowerCase()}`)
  } catch (e) {
    toast(e.message)
  }
}

async function remove(m) {
  try {
    await removeMember(m.id)
    toast(`${m.name} removed`)
  } catch (e) {
    toast(e.message)
  } finally {
    confirming.value = null
  }
}

const initials = (name) => name.split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase()
</script>

<template>
  <div>
    <PageHeader
      title="Team"
      subtitle="Invite people to shop with your account and choose what they can do."
      :crumbs="[{ label: 'Explore', to: '/' }, { label: 'Team' }]"
    />

    <div class="page layout">
      <section class="box">
        <h2>Members <span class="muted">{{ state.members.length + 1 }}</span></h2>
        <ul class="members">
          <li>
            <span class="avatar owner">{{ initials(owner.name) }}</span>
            <div class="who"><b>{{ owner.name }} <em>You</em></b><small>{{ owner.email }}</small></div>
            <span class="role-fixed">Owner</span>
            <span class="status active">Active</span>
            <span class="spacer" />
          </li>
          <TransitionGroup name="list">
            <li v-for="m in state.members" :key="m.id">
              <span class="avatar">{{ initials(m.name) }}</span>
              <div class="who"><b>{{ m.name }}</b><small>{{ m.email }}</small></div>
              <select :value="m.role" class="select role" :aria-label="`Role for ${m.name}`" @change="changeRole(m, $event.target.value)">
                <option v-for="(_, r) in ROLES" :key="r">{{ r }}</option>
              </select>
              <span class="status" :class="m.status.toLowerCase()">{{ m.status }}</span>
              <div class="remove-wrap">
                <template v-if="confirming === m.id">
                  <button class="confirm" @click="remove(m)">Remove</button>
                  <button class="cancel" @click="confirming = null">Keep</button>
                </template>
                <button v-else class="icon-btn remove" :aria-label="`Remove ${m.name}`" @click="confirming = m.id">
                  <Icon name="close" :size="16" />
                </button>
              </div>
            </li>
          </TransitionGroup>
        </ul>
      </section>

      <aside class="side">
        <form class="box" novalidate @submit.prevent="submit">
          <h2>Add member</h2>
          <div class="fields">
            <AuthField v-model="form.name" label="Name" icon="user" placeholder="Alex Morgan" :error="errors.name" />
            <AuthField v-model="form.email" label="Email" icon="mail" type="email" placeholder="alex@company.com" :error="errors.email" />
            <div>
              <span class="label">Role</span>
              <div class="roles">
                <label v-for="(desc, r) in ROLES" :key="r" class="role-opt" :class="{ on: form.role === r }">
                  <input v-model="form.role" type="radio" name="role" :value="r" />
                  <b>{{ r }}</b><small>{{ desc }}</small>
                </label>
              </div>
            </div>
          </div>
          <button class="btn-primary send" type="submit" :disabled="sending"><Icon name="plus" :size="18" />Send invite</button>
        </form>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.layout {
  display: grid;
  grid-template-columns: 1fr 400px;
  gap: 24px;
  align-items: start;
}
.box h2 .muted {
  margin-left: 6px;
  font-size: 15px;
}
.members {
  margin: 0;
  padding: 0;
  list-style: none;
}
.members li {
  display: grid;
  grid-template-columns: 44px 1fr 140px 90px 120px;
  align-items: center;
  gap: 14px;
  padding: 14px 0;
  border-bottom: 1px solid var(--line);
}
.members li:last-child {
  border-bottom: 0;
}
.avatar {
  display: grid;
  place-items: center;
  width: 44px;
  height: 44px;
  border-radius: 50%;
  background: var(--peach);
  font-size: 14px;
  font-weight: 600;
}
.avatar.owner {
  background: var(--blue);
  color: #fff;
}
.who {
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.who b {
  font-size: 15px;
  font-weight: 500;
}
.who em {
  margin-left: 6px;
  padding: 2px 8px;
  border-radius: var(--r-pill);
  background: var(--blue-soft);
  color: var(--blue);
  font-size: 11px;
  font-style: normal;
}
.who small {
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 13px;
  color: var(--muted);
}
.role {
  height: 42px;
  border-radius: var(--r-pill);
  font-size: 14px;
  background-position: right 12px center;
}
.role-fixed {
  padding-left: 20px;
  font-size: 14px;
  font-weight: 500;
}
.remove-wrap {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
}
.remove {
  background: var(--chip);
  color: var(--muted);
}
.remove:hover {
  color: #d92d20;
}
.confirm,
.cancel {
  height: 34px;
  padding: 0 12px;
  border-radius: var(--r-pill);
  font-size: 13px;
  font-weight: 500;
}
.confirm {
  background: #fef3f2;
  color: #d92d20;
}
.cancel {
  background: var(--chip);
}

.fields {
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.roles {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.role-opt {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 14px 18px;
  border: 2px solid var(--line);
  border-radius: 18px;
  cursor: pointer;
  transition: all 0.2s ease;
}
.role-opt input {
  position: absolute;
  opacity: 0;
  pointer-events: none;
}
.role-opt.on {
  border-color: var(--blue);
  background: #f7f9ff;
}
.role-opt:focus-within {
  box-shadow: 0 0 0 4px var(--blue-soft);
}
.role-opt b {
  font-size: 14px;
  font-weight: 500;
}
.role-opt small {
  font-size: 13px;
  color: var(--muted);
}
.send {
  width: 100%;
  margin-top: 22px;
}

.list-enter-active,
.list-leave-active {
  transition: all 0.3s ease;
}
.list-enter-from,
.list-leave-to {
  opacity: 0;
  transform: translateX(-16px);
}

@media (max-width: 1100px) {
  .layout {
    grid-template-columns: 1fr;
  }
}
@media (max-width: 680px) {
  .members li {
    grid-template-columns: 44px 1fr auto;
  }
  .role,
  .role-fixed {
    grid-column: 2;
  }
  .members .status {
    grid-column: 3;
    grid-row: 1;
  }
  .remove-wrap,
  .spacer {
    grid-column: 3;
  }
}
</style>
