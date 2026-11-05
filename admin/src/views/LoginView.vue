<script setup>
import { reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import Field from '../components/Field.vue'
import { home, signIn } from '../auth.js'

const route = useRoute()
const router = useRouter()
const form = reactive({ email: '', password: '' })
// The test admin from `npm run test-kit` (backend/api). Shown only when VITE_SHOW_TEST_ACCOUNTS is "true"
// (or "development", which docker compose passes from NODE_ENV): a build that doesn't ask for it never
// prints a password on the sign-in page. See TESTING.md.
const SHOW_TEST_ACCOUNTS = ['true', 'development'].includes(import.meta.env.VITE_SHOW_TEST_ACCOUNTS ?? (import.meta.env.DEV ? 'true' : 'false'))
const TEST_ADMIN = SHOW_TEST_ACCOUNTS ? { email: 'admin@cartly.dev', password: 'Admin1234!' } : null
const TEST_RIDER = TEST_ADMIN && { email: 'rider@cartly.dev', password: 'Rider1234!' }
const useTest = (a = TEST_ADMIN) => Object.assign(form, a)
const error = ref('')
const busy = ref(false)

async function submit() {
  error.value = ''
  if (!form.email.trim() || !form.password) {
    error.value = 'Enter your email and password.'
    return
  }
  busy.value = true
  try {
    await signIn(form.email, form.password)
    const to = typeof route.query.redirect === 'string' && route.query.redirect.startsWith('/') ? route.query.redirect : home()
    router.replace(to)
  } catch (e) {
    error.value = e.message
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="login">
    <form class="panel card" novalidate @submit.prevent="submit">
      <p class="wordmark">Cartly <span>Admin</span></p>
      <h1 class="display">Sign in to run the shop</h1>
      <p class="muted lede">Orders, products, customers and content, all in one place. Staff accounts only. Riders sign in here too, for their deliveries.</p>
      <p v-if="error" class="form-error" role="alert">{{ error }}</p>
      <button v-if="TEST_ADMIN" type="button" class="test-account" @click="useTest()">
        <span><b>Test admin account</b>{{ TEST_ADMIN.email }} · {{ TEST_ADMIN.password }}</span>
        <em>Use it</em>
      </button>
      <button v-if="TEST_RIDER" type="button" class="test-account" @click="useTest(TEST_RIDER)">
        <span><b>Test rider account</b>{{ TEST_RIDER.email }} · {{ TEST_RIDER.password }}</span>
        <em>Use it</em>
      </button>
      <Field id="email" label="Email">
        <input id="email" v-model="form.email" class="input" type="email" autocomplete="username" required autofocus />
      </Field>
      <Field id="password" label="Password">
        <input id="password" v-model="form.password" class="input" type="password" autocomplete="current-password" required />
      </Field>
      <button class="btn primary big" :disabled="busy">{{ busy ? 'Signing in…' : 'Sign in' }}</button>
    </form>
  </div>
</template>

<style scoped>
.test-account {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 14px;
  border: 1px dashed var(--accent);
  border-radius: var(--r-control);
  background: var(--accent-soft);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.test-account span {
  display: grid;
  font-size: 13px;
  color: var(--ink-2);
}
.test-account b {
  color: var(--ink);
}
.test-account em {
  font-style: normal;
  font-weight: 700;
  color: var(--accent);
}
.login {
  display: grid;
  place-items: center;
  min-height: 100vh;
  padding: 24px 16px;
}
.card {
  display: grid;
  gap: 16px;
  width: min(400px, 100%);
  padding: 30px 28px 28px;
}
.wordmark {
  font-family: var(--font-display);
  font-size: 21px;
  font-weight: 700;
  letter-spacing: -0.03em;
}
.wordmark span {
  font-family: var(--font-ui);
  font-size: 13px;
  font-weight: 650;
  letter-spacing: 0;
  color: var(--muted);
}
h1 {
  margin-top: 10px;
  font-size: 28px;
}
.lede {
  margin-top: -8px;
}
.big {
  height: 42px;
  margin-top: 4px;
}
</style>
