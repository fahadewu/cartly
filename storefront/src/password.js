import { computed } from 'vue'

// Password strength rules shared by signup and account pages.
export function usePasswordRules(password) {
  const rules = computed(() => [
    { label: '8+ characters', ok: password.value.length >= 8 },
    { label: 'Upper & lower case', ok: /[a-z]/.test(password.value) && /[A-Z]/.test(password.value) },
    { label: 'A number', ok: /\d/.test(password.value) },
    { label: 'A symbol', ok: /[^A-Za-z0-9]/.test(password.value) },
  ])
  const score = computed(() => rules.value.filter((r) => r.ok).length)
  const strength = computed(() => ['Too weak', 'Weak', 'Fair', 'Good', 'Strong'][score.value])
  const error = () =>
    password.value.length < 8 ? 'Use at least 8 characters.' : score.value < 3 ? 'Make it stronger: mix cases, numbers or symbols.' : ''
  return { rules, score, strength, error }
}
