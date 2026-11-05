<script setup>
import { reactive, ref } from 'vue'
import PageHeader from '../components/PageHeader.vue'
import StatusTag from '../components/StatusTag.vue'
import StateBlock from '../components/StateBlock.vue'
import Field from '../components/Field.vue'
import { del, get, patch, post } from '../api.js'
import { confirm } from '../confirm.js'
import { useResource } from '../composables.js'
import { count, money } from '../format.js'
import { toast } from '../toast.js'

// The stamp card: a stamp per delivered order, a personal one-time code when the card is full. Off until the
// owner switches it on, because the reward costs money.
const loyalty = ref(null)
get('/admin/loyalty').then((l) => (loyalty.value = l)).catch(() => {})
const savingLoyalty = ref(false)
async function saveLoyalty(patchBody) {
  savingLoyalty.value = true
  try {
    loyalty.value = await patch('/admin/loyalty', patchBody ?? { target: Number(loyalty.value.target), headStart: Number(loyalty.value.headStart), percentOff: Number(loyalty.value.percentOff) })
    toast(loyalty.value.enabled ? `Stamp card on: ${loyalty.value.percentOff}% off after ${loyalty.value.target} delivered orders` : 'Stamp card off')
  } catch (e) {
    toast(e.message, 'error')
  } finally {
    savingLoyalty.value = false
  }
}

const { data: promos, loading, error, reload } = useResource(() => get('/admin/promos'))
const form = reactive({ code: '', percentOff: 15 })
const formError = ref('')
const creating = ref(false)
const busy = ref('')

async function create() {
  formError.value = ''
  const code = form.code.trim().toUpperCase()
  const pct = Number(form.percentOff)
  if (!/^[A-Z0-9]{2,32}$/.test(code)) formError.value = 'Codes are 2–32 letters or numbers, with no spaces.'
  else if (!Number.isInteger(pct) || pct < 1 || pct > 90) formError.value = 'Choose a whole-number discount from 1% to 90%.'
  if (formError.value) return
  creating.value = true
  try {
    await post('/admin/promos', { code, percentOff: pct })
    toast(`${code} created`)
    form.code = ''
    reload({ quiet: true })
  } catch (e) {
    formError.value = e.message
  } finally {
    creating.value = false
  }
}

async function update(p, body, message) {
  busy.value = p.code
  try {
    Object.assign(p, await patch(`/admin/promos/${p.code}`, body))
    toast(message)
  } catch (e) {
    toast(e.message, 'error')
    reload({ quiet: true })
  } finally {
    busy.value = ''
  }
}
const toggle = (p) => update(p, { active: !p.active }, p.active ? `${p.code} paused` : `${p.code} is live again`)
function setPercent(p, value) {
  const pct = Number(value)
  if (pct === p.percentOff) return
  if (!Number.isInteger(pct) || pct < 1 || pct > 90) {
    toast('Choose a whole-number discount from 1% to 90%.', 'error')
    reload({ quiet: true })
    return
  }
  update(p, { percentOff: pct }, `${p.code} now takes ${pct}% off`)
}
async function remove(p) {
  const ok = await confirm({
    title: `Delete ${p.code}?`,
    body: p.uses
      ? `Shoppers won’t be able to use it any more. The ${count(p.uses)} orders that used it keep their discount.`
      : 'Shoppers won’t be able to use it any more.',
    confirmLabel: 'Delete code',
    danger: true,
  })
  if (!ok) return
  try {
    await del(`/admin/promos/${p.code}`)
    toast(`${p.code} deleted`)
    reload({ quiet: true })
  } catch (e) {
    toast(e.message, 'error')
  }
}
</script>

<template>
  <div>
    <PageHeader title="Promotions" description="Discount codes shoppers enter in their cart. Pause a code to stop it without losing its history." />

    <section v-if="loyalty" class="panel stamps">
      <div class="panel-body stamps-body">
        <div class="stamps-head">
          <strong>Stamp card</strong>
          <span class="muted">One stamp per delivered order. A full card gives the shopper a personal code they can use once. Each card starts with a few stamps already on it, which makes shoppers likelier to finish it.</span>
        </div>
        <label>Orders for a reward<input v-model="loyalty.target" class="input" type="number" min="2" max="30" /></label>
        <label>Head start<input v-model="loyalty.headStart" class="input" type="number" min="0" max="5" /></label>
        <label>Reward (% off)<input v-model="loyalty.percentOff" class="input" type="number" min="1" max="50" /></label>
        <button v-can="'promos.write'" class="btn sm" :disabled="savingLoyalty" @click="saveLoyalty()">Save</button>
        <button v-can="'promos.write'" class="btn sm" :class="loyalty.enabled ? 'danger' : 'primary'" :disabled="savingLoyalty" @click="saveLoyalty({ enabled: !loyalty.enabled })">
          {{ loyalty.enabled ? 'Switch off' : 'Switch on' }}
        </button>
        <StatusTag :status="loyalty.enabled ? 'ACTIVE' : 'PAUSED'" />
      </div>
    </section>

    <section class="panel create">
      <form class="panel-body create-form" novalidate @submit.prevent="create">
        <Field id="code" label="New code" hint="Letters and numbers, shown to shoppers as typed here.">
          <input id="code" v-model="form.code" class="input code-input" maxlength="32" placeholder="SUMMER15" autocomplete="off" @input="form.code = form.code.toUpperCase()" />
        </Field>
        <Field id="pct" label="Discount">
          <div class="suffix">
            <input id="pct" v-model.number="form.percentOff" class="input" type="number" min="1" max="90" step="1" />
            <span>% off</span>
          </div>
        </Field>
        <button v-can="'promos.write'" class="btn primary" :disabled="creating">{{ creating ? 'Creating…' : 'Create code' }}</button>
      </form>
      <p v-if="formError" class="form-error inset" role="alert">{{ formError }}</p>
    </section>

    <section class="panel">
      <StateBlock :loading="loading && !promos" :error="error" :empty="!promos?.length" empty-text="No promo codes yet. Create one above." @retry="reload">
        <div class="table-wrap">
          <table class="table">
            <thead>
              <tr>
                <th>Code</th>
                <th>Discount</th>
                <th>Status</th>
                <th class="num">Orders</th>
                <th class="num">Discount given</th>
                <th class="num">Revenue</th>
                <th><span class="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="p in promos" :key="p.code">
                <td class="primary-cell"><strong class="code">{{ p.code }}</strong><span v-if="p.personal" class="muted personal"> · one shopper, once</span></td>
                <td>
                  <div class="suffix sm">
                    <label class="sr-only" :for="`pct-${p.code}`">Discount for {{ p.code }}</label>
                    <input
                      v-can="'promos.write'"
                      :id="`pct-${p.code}`"
                      class="input sm"
                      type="number"
                      min="1"
                      max="90"
                      :value="p.percentOff"
                      :disabled="busy === p.code"
                      @change="setPercent(p, $event.target.value)"
                    />
                    <span>% off</span>
                  </div>
                </td>
                <td>
                  <label class="switch">
                    <input v-can="'promos.write'" type="checkbox" role="switch" :checked="p.active" :disabled="busy === p.code" @change="toggle(p)" />
                    <StatusTag :status="p.active ? 'LIVE' : 'PAUSED'" />
                    <span class="sr-only">{{ p.active ? `Pause ${p.code}` : `Make ${p.code} live` }}</span>
                  </label>
                </td>
                <td class="num">{{ count(p.uses) }}</td>
                <td class="num">{{ money(p.discountGiven) }}</td>
                <td class="num">{{ money(p.revenue) }}</td>
                <td class="num"><button v-can="'promos.write'" class="link-btn danger" @click="remove(p)">Delete</button></td>
              </tr>
            </tbody>
          </table>
        </div>
      </StateBlock>
    </section>
  </div>
</template>

<style scoped>
.create {
  margin-bottom: 18px;
}
.create-form {
  display: flex;
  align-items: flex-start;
  gap: 16px;
  flex-wrap: wrap;
}
.create-form > :first-child {
  flex: 1 1 240px;
  max-width: 360px;
}
.create-form .btn {
  margin-top: 25px;
}
.code-input {
  text-transform: uppercase;
  font-weight: 700;
  letter-spacing: 0.04em;
}
.inset {
  margin: 0 18px 16px;
}
.suffix {
  display: flex;
  align-items: center;
  gap: 8px;
}
.suffix .input {
  width: 90px;
}
.suffix.sm .input {
  width: 70px;
}
.suffix span {
  color: var(--muted);
  font-weight: 600;
  white-space: nowrap;
}
.code {
  letter-spacing: 0.04em;
}
.switch {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
}
/* A real toggle track next to the tag. */
.switch input {
  appearance: none;
  width: 34px;
  height: 20px;
  margin: 0;
  border-radius: 999px;
  background: var(--line-strong);
  position: relative;
  cursor: pointer;
  transition: background 0.15s ease;
}
.switch input::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #fff;
  transition: transform 0.15s ease;
}
.switch input:checked {
  background: var(--accent);
}
.switch input:checked::after {
  transform: translateX(14px);
}
.stamps-body {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 12px;
}
.stamps-head {
  flex: 1 1 100%;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.stamps label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 13px;
  color: var(--muted);
}
.stamps .input {
  width: 120px;
}
.personal {
  font-size: 12px;
}
</style>
