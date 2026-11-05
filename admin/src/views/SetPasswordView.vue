<script setup>
import { reactive } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import Field from '../components/Field.vue'
import { post } from '../api.js'
import { auth, setUser, signOut } from '../auth.js'
import { toast } from '../toast.js'

// After signing in with a password an admin made, staff choose their own before going on.
const route = useRoute()
const router = useRouter()
const STRONG = /^(?:(?=.*[a-z])(?=.*[A-Z])(?=.*\d)|(?=.*[a-z])(?=.*[A-Z])(?=.*[^A-Za-z0-9])|(?=.*[a-z])(?=.*\d)(?=.*[^A-Za-z0-9])|(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9])).{8,}$/
const f = reactive({ current: '', next: '', again: '', errors: {}, error: '', saving: false })

async function save() {
  const e = {}
  if (!f.current) e.current = 'Enter the temporary password you signed in with.'
  if (!STRONG.test(f.next)) e.next = 'Use 8+ characters mixing upper and lower case, numbers or symbols.'
  else if (f.next === f.current) e.next = 'Choose a password different from the temporary one.'
  if (f.again !== f.next) e.again = 'The passwords don’t match.'
  f.errors = e
  f.error = ''
  if (Object.keys(e).length) return
  f.saving = true
  try {
    // keepSession: a mistyped temporary password is a 401 from the API, and must not sign them out.
    await post('/auth/change-password', { currentPassword: f.current, newPassword: f.next }, { keepSession: true })
    setUser({ passwordTemporary: false })
    toast('Password saved. Welcome to Cartly Admin!')
    router.replace(route.query.redirect || '/')
  } catch (err) {
    f.error = err.message
  } finally {
    f.saving = false
  }
}
function leave() {
  signOut()
  router.replace({ name: 'login' })
}
</script>

<template>
  <main class="wrap">
    <form class="card panel" novalidate @submit.prevent="save">
      <p class="wordmark">Cartly <span>Admin</span></p>
      <h1 class="display">Choose your password</h1>
      <p class="muted">
        Hi {{ auth.user?.name?.split(' ')[0] }}, you’ve been added as <strong>{{ auth.user?.roleLabel }}</strong>. You signed in with a temporary password, so pick one only you know
        before carrying on.
      </p>
      <p v-if="f.error" class="form-error" role="alert">{{ f.error }}</p>
      <Field id="sp-current" label="Temporary password" :error="f.errors.current">
        <input id="sp-current" v-model="f.current" class="input" type="password" autocomplete="current-password" />
      </Field>
      <Field id="sp-next" label="New password" :error="f.errors.next" hint="8+ characters mixing upper and lower case, numbers or symbols.">
        <input id="sp-next" v-model="f.next" class="input" type="password" autocomplete="new-password" />
      </Field>
      <Field id="sp-again" label="New password again" :error="f.errors.again">
        <input id="sp-again" v-model="f.again" class="input" type="password" autocomplete="new-password" />
      </Field>
      <button class="btn primary" :disabled="f.saving">{{ f.saving ? 'Saving…' : 'Save and continue' }}</button>
      <button type="button" class="btn ghost" @click="leave">Sign out</button>
    </form>
  </main>
</template>

<style scoped>
.wrap {
  display: grid;
  place-items: center;
  min-height: 100vh;
  padding: 24px 16px;
}
.card {
  display: grid;
  gap: 14px;
  width: min(420px, 100%);
  padding: 28px 26px;
}
.wordmark {
  font-family: var(--font-display);
  font-size: 20px;
  font-weight: 700;
  letter-spacing: -0.03em;
}
.wordmark span {
  font-family: var(--font-ui);
  font-size: 13px;
  color: var(--muted);
}
h1 {
  font-size: 26px;
}
</style>
