<script setup>
import { reactive, ref, computed, toRef, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import PageHeader from '../components/PageHeader.vue'
import AuthField from '../components/AuthField.vue'
import PasswordStrength from '../components/PasswordStrength.vue'
import Icon from '../components/Icon.vue'
import { money, initials } from '../data.js'
import { auth, updateProfile, changePassword, signOut } from '../auth.js'
import { usePasswordRules } from '../password.js'
import { useShop } from '../store.js'
import { toast } from '../toast.js'
import { api } from '../api.js'
import PreferencesCard from '../components/PreferencesCard.vue'

const router = useRouter()
const { state } = useShop()

const since = computed(() =>
  auth.user?.since ? new Date(auth.user.since).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }) : 'recently',
)
const spent = computed(() => state.orders.reduce((n, o) => n + (o.status === 'Cancelled' ? 0 : o.total), 0))

// Profile
const profile = reactive({ name: auth.user?.name ?? '', email: auth.user?.email ?? '' })
const pErrors = reactive({ name: '', email: '' })
const pFormError = ref('')
const pSaving = ref(false)
const dirty = computed(() => profile.name.trim() !== auth.user?.name || profile.email.trim().toLowerCase() !== auth.user?.email)

async function saveProfile() {
  pFormError.value = ''
  pErrors.name = profile.name.trim().length >= 2 ? '' : 'Enter your full name.'
  pErrors.email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(profile.email) ? '' : 'Enter a valid email.'
  if (pErrors.name || pErrors.email) return
  pSaving.value = true
  try {
    await updateProfile(profile)
    toast('Profile updated')
  } catch (e) {
    pFormError.value = e.message
  } finally {
    pSaving.value = false
  }
}

// Password
const pw = reactive({ current: '', next: '', confirm: '' })
const pwErrors = reactive({ current: '', next: '', confirm: '' })
const pwFormError = ref('')
const pwSaving = ref(false)
const { rules, score, strength, error: nextError } = usePasswordRules(toRef(pw, 'next'))

async function savePassword() {
  pwFormError.value = ''
  pwErrors.current = pw.current ? '' : 'Enter your current password.'
  pwErrors.next = nextError()
  pwErrors.confirm = pw.confirm === pw.next ? '' : 'Passwords don’t match.'
  if (pwErrors.current || pwErrors.next || pwErrors.confirm) return
  pwSaving.value = true
  try {
    await changePassword(pw.current, pw.next)
    Object.assign(pw, { current: '', next: '', confirm: '' })
    toast('Password changed')
  } catch (e) {
    pwErrors.current = e.message
  } finally {
    pwSaving.value = false
  }
}

// Personalised suggestions: on, the store learns the shopper's taste from what they browse and buy.
const personalise = ref(null)
onMounted(() => api('/me/personalisation').then((r) => (personalise.value = r.personalise)).catch(() => {}))
async function setPersonalise(on) {
  const was = personalise.value
  personalise.value = on
  try {
    await api('/me/personalisation', { method: 'PUT', body: { personalise: on } })
    toast(on ? 'Suggestions will follow your taste' : 'Personalisation off, and what we’d learned is deleted')
  } catch (e) {
    personalise.value = was
    toast(e.message)
  }
}

function logout() {
  signOut()
  router.push({ name: 'login' })
}
</script>

<template>
  <div>
    <PageHeader title="Account" subtitle="Manage your profile, security and preferences" :crumbs="[{ label: 'Explore', to: '/' }, { label: 'Account' }]">
      <button class="btn-secondary sm" @click="logout"><Icon name="logout" :size="16" />Log out</button>
    </PageHeader>

    <div class="page">
      <section class="profile">
        <span class="initials" aria-hidden="true">{{ initials(auth.user?.name) }}</span>
        <div class="who">
          <h2>{{ auth.user?.name }}</h2>
          <p>{{ auth.user?.email }} · Member since {{ since }}</p>
        </div>
        <div class="stats">
          <RouterLink to="/orders"><strong>{{ state.orders.length }}</strong><small>Orders</small></RouterLink>
          <RouterLink to="/favourites"><strong>{{ state.liked.length }}</strong><small>Favourites</small></RouterLink>
          <div><strong>{{ money(spent) }}</strong><small>Spent</small></div>
        </div>
      </section>

      <div class="grid">
        <form class="box" novalidate @submit.prevent="saveProfile">
          <h2>Profile</h2>
          <div class="fields">
            <p v-if="pFormError" class="form-alert error"><Icon name="alert" :size="16" />{{ pFormError }}</p>
            <AuthField v-model="profile.name" label="Full name" icon="user" autocomplete="name" :error="pErrors.name" />
            <AuthField v-model="profile.email" label="Email" icon="mail" type="email" autocomplete="email" :error="pErrors.email" />
          </div>
          <button class="btn-primary sm save" type="submit" :disabled="pSaving || !dirty">
            <span v-if="pSaving" class="spinner" />{{ pSaving ? 'Saving…' : 'Save changes' }}
          </button>
        </form>

        <form class="box" novalidate @submit.prevent="savePassword">
          <h2>Change password</h2>
          <div class="fields">
            <p v-if="pwFormError" class="form-alert error"><Icon name="alert" :size="16" />{{ pwFormError }}</p>
            <AuthField v-model="pw.current" label="Current password" icon="lock" type="password" autocomplete="current-password" :error="pwErrors.current" />
            <AuthField v-model="pw.next" label="New password" icon="lock" type="password" autocomplete="new-password" :error="pwErrors.next">
              <PasswordStrength v-if="pw.next" :rules="rules" :score="score" :strength="strength" />
            </AuthField>
            <AuthField v-model="pw.confirm" label="Confirm new password" icon="lock" type="password" autocomplete="new-password" :error="pwErrors.confirm" />
          </div>
          <button class="btn-primary sm save" type="submit" :disabled="pwSaving">
            <span v-if="pwSaving" class="spinner" />{{ pwSaving ? 'Updating…' : 'Update password' }}
          </button>
        </form>

        <section class="box">
          <h2>Preferences</h2>
          <div class="pref">
            <div><b>Layout</b><small>Dashboard shows the sidebar; Website uses a top menu.</small></div>
            <div class="seg">
              <button :class="{ on: state.mode === 'dashboard' }" @click="state.mode = 'dashboard'">Dashboard</button>
              <button :class="{ on: state.mode === 'website' }" @click="state.mode = 'website'">Website</button>
            </div>
          </div>
          <div v-if="personalise !== null" class="pref">
            <div>
              <b>Personalised suggestions</b>
              <small>Pip and “Picked for you” learn your style from what you browse, try on and buy. Turn off to stop and delete what we’ve learned.</small>
            </div>
            <div class="seg">
              <button :class="{ on: personalise }" @click="setPersonalise(true)">On</button>
              <button :class="{ on: !personalise }" @click="setPersonalise(false)">Off</button>
            </div>
          </div>
          <PreferencesCard />
        </section>

        <section class="box quick">
          <h2>Shortcuts</h2>
          <RouterLink to="/orders"><Icon name="bag" :size="18" />Order history<Icon name="chevronRight" :size="18" /></RouterLink>
          <RouterLink to="/favourites"><Icon name="heart" :size="18" />Favourites<Icon name="chevronRight" :size="18" /></RouterLink>
          <RouterLink to="/team"><Icon name="user" :size="18" />Team members<Icon name="chevronRight" :size="18" /></RouterLink>
          <RouterLink to="/request"><Icon name="search" :size="18" />Request a product<Icon name="chevronRight" :size="18" /></RouterLink>
        </section>
      </div>
    </div>
  </div>
</template>

<style scoped>
.profile {
  display: flex;
  align-items: center;
  gap: 22px;
  padding: 28px;
  margin-bottom: 18px;
  border-radius: var(--r-card);
  background: var(--mint);
}
.profile .initials {
  display: grid;
  place-items: center;
  width: 88px;
  height: 88px;
  border: 5px solid #fff;
  border-radius: 50%;
  background: var(--blue-soft);
  color: var(--blue);
  font-weight: 700;
  font-size: 26px;
}
.who {
  flex: 1;
  min-width: 0;
}
.who h2 {
  font-size: 26px;
  font-weight: 600;
  letter-spacing: -0.01em;
}
.who p {
  margin-top: 4px;
  font-size: 14px;
  color: #3b5a4a;
}
.stats {
  display: flex;
  gap: 10px;
}
.stats > * {
  display: flex;
  flex-direction: column;
  align-items: center;
  min-width: 96px;
  padding: 14px 18px;
  border-radius: 22px;
  background: rgba(255, 255, 255, 0.7);
  color: inherit;
  text-decoration: none;
}
.stats a:hover {
  background: #fff;
}
.stats strong {
  font-size: 22px;
  font-weight: 600;
}
.stats small {
  font-size: 12px;
  color: var(--muted);
}

.grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 18px;
  align-items: start;
}
.fields {
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.save {
  margin-top: 22px;
  padding: 0 26px;
}
.save:disabled:not(:has(.spinner)) {
  cursor: not-allowed;
  opacity: 0.45;
}

.pref + .pref {
  margin-top: 18px;
  padding-top: 18px;
  border-top: 1px solid var(--line);
}
.pref {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
.pref div:first-child {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.pref b {
  font-weight: 500;
}
.pref small {
  font-size: 13px;
  color: var(--muted);
}
.seg {
  display: flex;
  flex-shrink: 0;
  padding: 4px;
  border-radius: var(--r-pill);
  background: var(--chip);
}
.seg button {
  height: 40px;
  padding: 0 16px;
  border-radius: var(--r-pill);
  font-size: 13px;
  color: var(--muted);
}
.seg button.on {
  background: #fff;
  color: var(--ink);
  box-shadow: 0 6px 16px -8px rgba(0, 0, 0, 0.2);
}

.quick a {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 4px;
  border-bottom: 1px solid var(--line);
  color: inherit;
  font-size: 15px;
  text-decoration: none;
}
.quick a:last-child {
  border-bottom: 0;
}
.quick a svg:first-child {
  color: var(--blue);
}
.quick a svg:last-child {
  margin-left: auto;
  color: var(--muted);
}
.quick a:hover {
  color: var(--blue);
}

@media (max-width: 1100px) {
  .grid {
    grid-template-columns: 1fr;
  }
  .profile {
    flex-wrap: wrap;
  }
  .stats {
    width: 100%;
  }
  .stats > * {
    flex: 1;
  }
}
</style>
