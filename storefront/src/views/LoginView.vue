<script setup>
import { reactive, ref } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import AuthLayout from '../components/AuthLayout.vue'
import AuthField from '../components/AuthField.vue'
import Icon from '../components/Icon.vue'
import { signIn, DEMO } from '../auth.js'

const router = useRouter()
const route = useRoute()

const form = reactive({ email: '', password: '', remember: true })
const errors = reactive({ email: '', password: '' })
const formError = ref('')
const notice = ref(route.query.expired ? 'Your session has expired. Please sign in again.' : '')
const loading = ref(false)

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
// Only paths inside the store: never another site (`//evil`), and never back to the sign-in pages.
const safeRedirect = (to) => (typeof to === 'string' && /^\/(?!\/)/.test(to) && !/^\/(login|signup)\b/.test(to) ? to : '/')

function validate() {
  errors.email = !form.email ? 'Enter your email.' : EMAIL.test(form.email) ? '' : 'Enter a valid email address.'
  errors.password = form.password ? '' : 'Enter your password.'
  return !errors.email && !errors.password
}

async function submit() {
  formError.value = notice.value = ''
  if (!validate()) return
  loading.value = true
  try {
    await signIn(form.email, form.password, form.remember)
    router.replace(safeRedirect(route.query.redirect))
  } catch (e) {
    formError.value = e.message
  } finally {
    loading.value = false
  }
}

// There is no password-reset email yet: the store resets it from the admin panel. Say so, rather than
// promising a link that never comes.
function forgot() {
  formError.value = ''
  notice.value = 'Forgot your password? Message the store and we’ll reset it for you.'
}

// The test shopper from `npm run test-kit` (backend/api). Shown only when VITE_SHOW_TEST_ACCOUNTS is "true"
// (or "development", which docker compose passes from NODE_ENV): a build that doesn't ask for it never
// prints a password on the sign-in page. See TESTING.md.
const SHOW_TEST_ACCOUNTS = ['true', 'development'].includes(import.meta.env.VITE_SHOW_TEST_ACCOUNTS ?? (import.meta.env.DEV ? 'true' : 'false'))
function useDemo() {
  Object.assign(form, { email: DEMO.email, password: DEMO.password })
  errors.email = errors.password = ''
}

function social(provider) {
  notice.value = `${provider} sign-in isn’t connected yet. Use your email for now.`
}
</script>

<template>
  <AuthLayout title="Welcome back" subtitle="Log in to pick up where you left off: your cart, favourites and orders." @social="social">
    <form class="form" novalidate @submit.prevent="submit">
      <p v-if="formError" class="form-alert error" role="alert"><Icon name="alert" :size="18" />{{ formError }}</p>
      <p v-if="notice" class="form-alert info" role="status"><Icon name="mail" :size="18" />{{ notice }}</p>

      <button v-if="SHOW_TEST_ACCOUNTS" type="button" class="demo" @click="useDemo">
        <span><b>Demo account</b>{{ DEMO.email }} · {{ DEMO.password }}</span>
        <em>Use it</em>
      </button>

      <AuthField
        v-model="form.email"
        label="Email"
        icon="mail"
        type="email"
        placeholder="you@example.com"
        autocomplete="email"
        :error="errors.email"
        @input="errors.email = ''"
      />
      <AuthField
        v-model="form.password"
        label="Password"
        icon="lock"
        type="password"
        placeholder="Your password"
        autocomplete="current-password"
        :error="errors.password"
        @input="errors.password = ''"
      />

      <div class="form-row">
        <label class="check"><input v-model="form.remember" type="checkbox" />Remember me</label>
        <button type="button" class="link" @click="forgot">Forgot password?</button>
      </div>

      <button class="btn-primary" type="submit" :disabled="loading">
        <span v-if="loading" class="spinner" />
        {{ loading ? 'Logging in…' : 'Log in' }}
      </button>
    </form>

    <template #footer>
      New to Cartly? <RouterLink to="/signup" class="link">Create an account</RouterLink>
    </template>
  </AuthLayout>
</template>

<style scoped>
.demo {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 16px 14px 20px;
  border: 1.5px dashed #b9cbff;
  border-radius: 20px;
  background: #f5f8ff;
  text-align: left;
  transition: background 0.2s ease;
}
.demo:hover {
  background: var(--blue-soft);
}
.demo span {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 13px;
  color: var(--muted);
}
.demo b {
  font-size: 14px;
  font-weight: 500;
  color: var(--ink);
}
.demo em {
  flex-shrink: 0;
  padding: 8px 14px;
  border-radius: var(--r-pill);
  background: var(--blue);
  color: #fff;
  font-size: 13px;
  font-style: normal;
  font-weight: 500;
}
</style>
