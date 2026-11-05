<script setup>
import { reactive, ref, toRef } from 'vue'
import { useRouter } from 'vue-router'
import AuthLayout from '../components/AuthLayout.vue'
import AuthField from '../components/AuthField.vue'
import Icon from '../components/Icon.vue'
import PasswordStrength from '../components/PasswordStrength.vue'
import { usePasswordRules } from '../password.js'
import { signUp } from '../auth.js'

const router = useRouter()

const form = reactive({ name: '', email: '', password: '', confirm: '', terms: false })
const errors = reactive({ name: '', email: '', password: '', confirm: '', terms: '' })
const formError = ref('')
const notice = ref('')
const loading = ref(false)

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const { rules, score, strength, error: passwordError } = usePasswordRules(toRef(form, 'password'))

function validate() {
  errors.name = form.name.trim().length >= 2 ? '' : 'Enter your full name.'
  errors.email = !form.email ? 'Enter your email.' : EMAIL.test(form.email) ? '' : 'Enter a valid email address.'
  errors.password = passwordError()
  errors.confirm = form.confirm === form.password ? '' : 'Passwords don’t match.'
  errors.terms = form.terms ? '' : 'Please accept the terms to continue.'
  return Object.values(errors).every((e) => !e)
}

async function submit() {
  formError.value = notice.value = ''
  if (!validate()) return
  loading.value = true
  try {
    await signUp({ name: form.name.trim(), email: form.email, password: form.password })
    router.replace('/')
  } catch (e) {
    formError.value = e.message
  } finally {
    loading.value = false
  }
}

function social(provider) {
  notice.value = `${provider} sign-up isn’t connected yet. Use your email for now.`
}
</script>

<template>
  <AuthLayout title="Create your account" subtitle="Join Cartly and get 50% off your first order." @social="social">
    <form class="form" novalidate @submit.prevent="submit">
      <p v-if="formError" class="form-alert error" role="alert"><Icon name="alert" :size="18" />{{ formError }}</p>
      <p v-if="notice" class="form-alert info" role="status"><Icon name="mail" :size="18" />{{ notice }}</p>

      <AuthField
        v-model="form.name"
        label="Full name"
        icon="user"
        placeholder="Maya Chen"
        autocomplete="name"
        :error="errors.name"
        @input="errors.name = ''"
      />
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
        placeholder="Create a password"
        autocomplete="new-password"
        :error="errors.password"
        @input="errors.password = ''"
      >
        <PasswordStrength v-if="form.password" :rules="rules" :score="score" :strength="strength" />
      </AuthField>
      <AuthField
        v-model="form.confirm"
        label="Confirm password"
        icon="lock"
        type="password"
        placeholder="Repeat your password"
        autocomplete="new-password"
        :error="errors.confirm"
        @input="errors.confirm = ''"
      />

      <div>
        <label class="check" :class="{ invalid: errors.terms }">
          <input v-model="form.terms" type="checkbox" @change="errors.terms = ''" />
          <span>I agree to the <a href="#" class="link">Terms</a> and <a href="#" class="link">Privacy Policy</a></span>
        </label>
        <p v-if="errors.terms" class="terms-error">{{ errors.terms }}</p>
      </div>

      <button class="btn-primary" type="submit" :disabled="loading">
        <span v-if="loading" class="spinner" />
        {{ loading ? 'Creating account…' : 'Create account' }}
      </button>
    </form>

    <template #footer>
      Already have an account? <RouterLink to="/login" class="link">Log in</RouterLink>
    </template>
  </AuthLayout>
</template>

<style scoped>
.terms-error {
  margin-top: 6px;
  padding-left: 32px;
  font-size: 13px;
  color: #d92d20;
}
</style>
