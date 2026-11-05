import { ref } from 'vue'
import { get } from './api.js'

// What each staff role can do, straight from the API's permission table (GET /admin/roles), loaded once.
const roles = ref([])
const areas = ref({})
let pending = null
export function useRoles() {
  pending ??= get('/admin/roles')
    .then((r) => {
      roles.value = r.roles
      areas.value = r.areas
    })
    .catch(() => (pending = null))
  return { roles, areas }
}
export const CUSTOMER = { id: 'CUSTOMER', label: 'Customer', summary: 'Shops on the storefront. No admin panel access.' }
export const roleLabel = (id) => (id === 'CUSTOMER' ? 'Customer' : id === 'RIDER' ? 'Rider' : (roles.value.find((r) => r.id === id)?.label ?? id))
