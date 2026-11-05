<script setup>
import { computed } from 'vue'
import { CUSTOMER, useRoles } from '../roles.js'

// One card per role, each saying what it can do. Staff roles are locked unless you may manage the team.
const model = defineModel({ type: String })
const props = defineProps({ staffAllowed: Boolean, customerAllowed: { type: Boolean, default: true }, legend: { type: String, default: 'Role' } })
const { roles } = useRoles()
const options = computed(() => [
  { ...CUSTOMER, locked: !props.customerAllowed },
  ...roles.value.map((r) => ({ ...r, locked: !props.staffAllowed })),
])
</script>

<template>
  <fieldset class="roles">
    <legend>{{ legend }}</legend>
    <label v-for="r in options" :key="r.id" class="role" :class="{ on: model === r.id, locked: r.locked }" :title="r.locked ? 'Only admins can give staff roles.' : undefined">
      <input v-model="model" type="radio" name="role" :value="r.id" :disabled="r.locked" />
      <span class="text">
        <b>{{ r.label }}</b>
        <span>{{ r.summary }}</span>
      </span>
    </label>
  </fieldset>
</template>

<style scoped>
.roles {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 8px;
  margin: 0;
  padding: 0;
  border: 0;
}
legend {
  margin-bottom: 8px;
  font-size: 13px;
  font-weight: 700;
}
.role {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: var(--r-control);
  cursor: pointer;
}
.role:hover:not(.locked) {
  background: var(--hover);
}
.role.on {
  border-color: var(--accent);
  background: var(--accent-soft);
}
.role.locked {
  opacity: 0.5;
  cursor: not-allowed;
}
.role input {
  margin-top: 3px;
  accent-color: var(--accent);
}
.text {
  display: grid;
  gap: 2px;
}
.text b {
  font-size: 13.5px;
}
.text span {
  color: var(--muted);
  font-size: 12.5px;
  line-height: 1.4;
}
</style>
