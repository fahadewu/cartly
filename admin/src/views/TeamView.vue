<script setup>
import { computed, ref } from 'vue'
import PageHeader from '../components/PageHeader.vue'
import StatusTag from '../components/StatusTag.vue'
import StateBlock from '../components/StateBlock.vue'
import Icon from '../components/Icon.vue'
import AccountActions from '../components/AccountActions.vue'
import AddUserDialog from '../components/AddUserDialog.vue'
import { get } from '../api.js'
import { auth } from '../auth.js'
import { useResource } from '../composables.js'
import { useRoles } from '../roles.js'
import { ago, date } from '../format.js'

const { data, loading, error, reload } = useResource(() => get('/admin/team'))
const { roles, areas } = useRoles()
const adding = ref(false)

const active = computed(() => data.value?.items.filter((u) => !u.disabled) ?? [])
const off = computed(() => data.value?.items.filter((u) => u.disabled) ?? [])
const countOf = (role) => active.value.filter((u) => u.role === role).length

// The permission matrix: one row per area, one column per role.
const level = (role, area) => (role.permissions.includes(`${area}.write`) ? 'full' : role.permissions.includes(`${area}.read`) ? 'view' : 'none')
const LEVEL = { full: ['check', 'Can change'], view: ['eye', 'Can view'], none: ['x', 'No access'] }

function updated(u) {
  const i = data.value.items.findIndex((x) => x.id === u.id)
  if (i < 0) return reload({ quiet: true })
  // Someone moved to the Customer role leaves the team.
  if (u.role === 'CUSTOMER') data.value.items.splice(i, 1)
  else data.value.items[i] = { ...data.value.items[i], ...u }
  reload({ quiet: true })
}
</script>

<template>
  <div>
    <PageHeader title="Team & roles" description="Who can sign in to the admin panel, and what each role is allowed to see and change.">
      <button class="btn primary" @click="adding = true"><Icon name="plus" :size="16" />Add staff member</button>
    </PageHeader>

    <StateBlock :loading="loading && !data" :error="error" @retry="reload">
      <div class="layout">
        <div class="stack">
          <section class="panel">
            <div class="panel-head">
              <h2>Staff</h2>
              <span class="muted small">{{ active.length }} active<template v-if="off.length"> · {{ off.length }} turned off</template></span>
            </div>
            <div class="table-wrap">
              <table class="table">
                <thead>
                  <tr>
                    <th>Person</th>
                    <th>Role</th>
                    <th>Status</th>
                    <th>Last sign-in</th>
                    <th><span class="sr-only">Actions</span></th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="u in [...active, ...off]" :key="u.id" :class="{ dim: u.disabled }">
                    <td class="primary-cell">
                      <RouterLink :to="`/customers/${u.id}`">{{ u.name }}</RouterLink>
                      <span v-if="u.id === auth.user?.id" class="you">You</span>
                      <span class="sub">{{ u.email }}</span>
                    </td>
                    <td><StatusTag :status="u.role" /></td>
                    <td>
                      <StatusTag v-if="u.disabled" status="DISABLED" />
                      <StatusTag v-else-if="u.passwordTemporary" status="TEMP_PASSWORD" />
                      <StatusTag v-else status="ACTIVE" />
                    </td>
                    <td>
                      {{ u.lastSignInAt ? ago(u.lastSignInAt) : 'Never' }}
                      <span class="sub">Added {{ date(u.createdAt) }}</span>
                    </td>
                    <td class="actions-cell"><AccountActions :user="u" compact @updated="updated" /></td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p class="panel-foot muted small">
              To give an existing shopper a staff role, open them under <RouterLink to="/customers">Customers</RouterLink> and change their role. Riders are managed under
              <RouterLink to="/delivery?view=riders">Delivery</RouterLink>.
            </p>
          </section>

          <section class="panel">
            <div class="panel-head">
              <h2>What each role can do</h2>
              <span class="muted small">The API enforces the same table on every request.</span>
            </div>
            <div class="table-wrap">
              <table class="table matrix">
                <thead>
                  <tr>
                    <th>Area</th>
                    <th v-for="r in roles" :key="r.id" class="c">
                      {{ r.label }}<span class="sub">{{ countOf(r.id) }} {{ countOf(r.id) === 1 ? 'person' : 'people' }}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(name, area) in areas" :key="area">
                    <td>{{ name }}</td>
                    <td v-for="r in roles" :key="r.id" class="c" :class="level(r, area)">
                      <Icon :name="LEVEL[level(r, area)][0]" :size="15" /><span class="sr-only">{{ LEVEL[level(r, area)][1] }}</span>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div class="panel-foot legend">
              <span class="full"><Icon name="check" :size="14" />Can change</span>
              <span class="view"><Icon name="eye" :size="14" />Can view</span>
              <span class="none"><Icon name="x" :size="14" />No access</span>
            </div>
            <dl class="summaries panel-body">
              <template v-for="r in roles" :key="r.id">
                <dt><StatusTag :status="r.id" /></dt>
                <dd>{{ r.summary }}</dd>
              </template>
            </dl>
          </section>
        </div>

        <section class="panel activity">
          <div class="panel-head"><h2>Recent changes</h2></div>
          <ol v-if="data.activity.length" class="feed">
            <li v-for="e in data.activity" :key="e.id">
              <p>
                <strong>{{ e.actor?.name ?? 'Someone' }}</strong> {{ e.label }} for
                <RouterLink v-if="e.targetId" :to="`/customers/${e.targetId}`">{{ e.target.replace(/ <.*>$/, '') }}</RouterLink>
                <span v-else>{{ e.target }}</span>
              </p>
              <time class="muted small" :datetime="e.createdAt">{{ ago(e.createdAt) }}</time>
            </li>
          </ol>
          <p v-else class="panel-body muted small">Role changes, new accounts, password resets and accounts turned off show up here.</p>
        </section>
      </div>
    </StateBlock>

    <AddUserDialog :open="adding" role="SUPPORT" @close="adding = false" @created="reload({ quiet: true })" />
  </div>
</template>

<style scoped>
.layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 320px;
  gap: 18px;
  align-items: start;
}
.small {
  font-size: 12.5px;
}
.you {
  margin-left: 6px;
  padding: 0 6px;
  border-radius: var(--r-tag);
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 11px;
  font-weight: 700;
}
.dim td {
  opacity: 0.65;
}
.actions-cell {
  text-align: right;
}
.actions-cell :deep(.account-actions) {
  justify-content: flex-end;
  flex-wrap: nowrap;
}
.matrix .c {
  text-align: center;
}
.matrix th.c {
  white-space: nowrap;
}
.matrix .sub {
  display: block;
  font-weight: 500;
}
.full {
  color: var(--ok);
}
.view {
  color: var(--accent);
}
.none {
  color: var(--line-strong);
}
.legend {
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
  font-size: 12.5px;
}
.legend span {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.summaries {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 8px 14px;
  margin: 0;
  border-top: 1px solid var(--line);
}
.summaries dd {
  margin: 0;
  color: var(--ink-2);
  font-size: 13px;
}
.activity {
  position: sticky;
  top: 18px;
}
.feed {
  display: grid;
  margin: 0;
  padding: 4px 0;
  list-style: none;
  max-height: 70vh;
  overflow-y: auto;
}
.feed li {
  display: grid;
  gap: 2px;
  padding: 10px 18px;
  border-bottom: 1px solid var(--line);
  font-size: 13px;
}
.feed li:last-child {
  border-bottom: 0;
}
@media (max-width: 1100px) {
  .layout {
    grid-template-columns: 1fr;
  }
  .activity {
    position: static;
  }
}
</style>
