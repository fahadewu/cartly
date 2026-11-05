<script setup>
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import StatusTag from '../components/StatusTag.vue'
import StateBlock from '../components/StateBlock.vue'
import Dialog from '../components/Dialog.vue'
import Field from '../components/Field.vue'
import Icon from '../components/Icon.vue'
import { get, post } from '../api.js'
import { signOut } from '../auth.js'
import { useResource } from '../composables.js'
import { confirm } from '../confirm.js'
import { ago, plural, sizeLabel, taka, time } from '../format.js'
import { toast } from '../toast.js'

// The rider app: made for a phone in one hand. Each parcel shows who to call, where to go, what to
// collect, and the one or two things that can happen next.
const router = useRouter()
const { data: me, loading, error, reload } = useResource(() => get('/rider'))
const showDone = ref(false)
const busy = ref('')
// Refresh every minute while the app is on screen, and the moment the phone wakes or the tab comes back:
// phones suspend timers in the background, and a rider returning to the app must see today's parcels.
let timer
const onVisible = () => {
  if (document.hidden) return clearInterval(timer)
  reload({ quiet: true })
  clearInterval(timer)
  timer = setInterval(() => reload({ quiet: true }), 60_000)
}
onMounted(() => {
  timer = setInterval(() => reload({ quiet: true }), 60_000)
  document.addEventListener('visibilitychange', onVisible)
  window.addEventListener('online', onVisible)
})
onUnmounted(() => {
  clearInterval(timer)
  document.removeEventListener('visibilitychange', onVisible)
  window.removeEventListener('online', onVisible)
})

const STEP = {
  PICKED_UP: { label: 'Picked up', primary: true },
  OUT_FOR_DELIVERY: { label: 'On my way', primary: true },
  DELIVERED: { label: 'Delivered', primary: true },
  FAILED_ATTEMPT: { label: 'Couldn’t deliver' },
  RETURNING: { label: 'Taking it back' },
  RETURNED: { label: 'Back at the store', primary: true },
}
const RETURN_STEP = { PICKED_UP: 'Collected it', DELIVERED: 'Handed in at the store', FAILED_ATTEMPT: 'Couldn’t collect' }
const REASONS = ['Customer didn’t answer the phone', 'Customer not at the address', 'Customer asked to come another day', 'Wrong or incomplete address', 'Customer refused the parcel']
const mapUrl = (r) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent([r.address, r.city].filter(Boolean).join(', '))}`
const totalToCollect = computed(() => me.value?.active.reduce((n, j) => n + (j.codAmount || 0), 0) ?? 0)

async function send(job, body, done) {
  busy.value = job.id
  try {
    await post(`/rider/shipments/${job.id}/status`, body)
    toast(done)
    await reload({ quiet: true })
    return true
  } catch (e) {
    toast(e.message, 'error')
    if (e.status === 409 || e.status === 404) reload({ quiet: true })
    return false
  } finally {
    busy.value = ''
  }
}

const finish = reactive({ open: false, job: null, code: '', collected: '', error: '' })
const fail = reactive({ open: false, job: null, reason: '', other: '', error: '' })
async function step(job, status) {
  if (status === 'DELIVERED' && job.kind === 'return') return send(job, { status }, `${job.orderId}: return handed in`)
  if (status === 'DELIVERED') return Object.assign(finish, { open: true, job, code: '', collected: job.codAmount || '', error: '' })
  if (status === 'FAILED_ATTEMPT') return Object.assign(fail, { open: true, job, reason: REASONS[0], other: '', error: '' })
  // Turning back changes the order for the store too: one mis-tap must not do that.
  if (status === 'RETURNING' || status === 'RETURNED') {
    const ok = await confirm({ title: `${STEP[status].label}?`, body: `${job.orderId} will be marked “${STEP[status].label.toLowerCase()}”.`, confirmLabel: STEP[status].label })
    if (!ok) return
  }
  send(job, { status }, `${job.orderId}: ${STEP[status].label.toLowerCase()}`)
}
async function sendFinish() {
  const j = finish.job
  finish.error = ''
  if (j.needsCode && !/^\d{4}$/.test(finish.code.trim())) return (finish.error = 'Ask the customer for the 4-digit code on their order page.')
  const collected = String(finish.collected).trim()
  // An empty box is not "nothing collected": Number('') is 0, which would record no cash for a cash order.
  if (j.codAmount && (collected === '' || !(Number(collected) >= 0))) return (finish.error = 'Enter the cash you took (0 if the customer paid nothing).')
  if (j.codAmount && Number(collected) !== Number(j.codAmount)) {
    const ok = await confirm({
      title: 'Different amount?',
      body: `The order says ${taka(j.codAmount)}; you entered ${taka(Number(collected))}. Record ${taka(Number(collected))} as collected?`,
      confirmLabel: 'Yes, record it',
    })
    if (!ok) return
  }
  const ok = await send(j, { status: 'DELIVERED', code: j.needsCode ? finish.code.trim() : undefined, collected: j.codAmount ? Number(collected) : undefined }, `${j.orderId} delivered`)
  if (ok) finish.open = false
}
async function sendFail() {
  const note = fail.reason === 'other' ? fail.other.trim() : fail.reason
  if (!note) return (fail.error = 'Say what happened.')
  const ok = await send(fail.job, { status: 'FAILED_ATTEMPT', note }, 'Noted. Try again later or take it back.')
  if (ok) fail.open = false
}

async function logout() {
  // Next to Refresh on a small screen: a mis-tap mid-shift must not force a password sign-in.
  if (!(await confirm({ title: 'Sign out?', body: 'You’ll need your password to sign back in.', confirmLabel: 'Sign out' }))) return
  signOut()
  router.replace({ name: 'login' })
}
</script>

<template>
  <div class="rider">
    <header class="top">
      <div>
        <p class="wordmark">Cartly <span>Rider</span></p>
        <strong v-if="me">{{ me.rider.name }}</strong>
      </div>
      <div class="top-buttons">
        <button class="btn ghost sm" :disabled="loading" aria-label="Refresh" @click="reload({ quiet: true })"><Icon name="refresh" /></button>
        <button class="btn ghost sm" aria-label="Sign out" @click="logout"><Icon name="logout" /></button>
      </div>
    </header>

    <StateBlock :loading="loading && !me" :error="error" @retry="reload">
      <template v-if="me">
        <div class="summary">
          <div>
            <span class="big figures">{{ me.active.length }}</span>
            <span class="muted">{{ me.active.length === 1 ? 'parcel' : 'parcels' }} to deliver</span>
          </div>
          <div>
            <span class="big figures">{{ taka(totalToCollect) }}</span>
            <span class="muted">to collect</span>
          </div>
          <div v-if="me.cashHeld.amount">
            <span class="big figures">{{ taka(me.cashHeld.amount) }}</span>
            <span class="muted">cash to hand in</span>
          </div>
        </div>

        <p v-if="!me.active.length" class="panel pad empty muted">Nothing to deliver right now. New parcels show up here as soon as the store gives you one.</p>

        <article v-for="j in me.active" :key="j.id" class="panel job">
          <div class="job-head">
            <strong class="mono">{{ j.orderId }} <span v-if="j.kind === 'return'" class="return-tag">Return pickup</span></strong>
            <StatusTag :status="j.status" />
          </div>
          <div class="who">
            <strong class="name">{{ j.recipient.name }}</strong>
            <p class="addr">{{ j.recipient.address }}, {{ j.recipient.city }}</p>
            <div class="contact">
              <a class="btn sm" :href="`tel:${j.recipient.phone}`"><Icon name="phone" :size="16" /> {{ j.recipient.phone }}</a>
              <a class="btn sm" :href="mapUrl(j.recipient)" target="_blank" rel="noopener"><Icon name="pin" :size="16" /> Map</a>
            </div>
          </div>
          <div v-if="j.kind === 'return'" class="collect paid">
            <span>Collect these items from the customer</span>
            <strong>Pay nothing</strong>
          </div>
          <div v-else class="collect" :class="{ paid: !j.codAmount }">
            <span>{{ j.codAmount ? 'Collect in cash' : 'Already paid' }}</span>
            <strong v-if="j.codAmount" class="figures">{{ taka(j.codAmount) }}</strong>
            <strong v-else>Collect nothing</strong>
          </div>
          <p v-if="j.note" class="note"><b>Note:</b> {{ j.note }}</p>
          <ul class="items">
            <li v-for="(i, n) in j.items" :key="n">
              <img :src="i.image" alt="" />
              <span>{{ i.qty }} × {{ i.name }} <span class="muted">({{ i.color }}, {{ sizeLabel(i.size) }})</span></span>
            </li>
          </ul>
          <p v-if="j.error" class="warn small">{{ j.error }}</p>
          <div class="steps">
            <button
              v-for="s in j.next"
              :key="s"
              class="btn"
              :class="{ primary: STEP[s].primary }"
              :disabled="busy === j.id"
              @click="step(j, s)"
            >
              {{ busy === j.id ? 'Saving…' : j.kind === 'return' ? RETURN_STEP[s] : STEP[s].label }}
            </button>
          </div>
          <p class="muted small">Given to you {{ ago(j.createdAt) }}.</p>
        </article>

        <button v-if="me.done.length" class="btn ghost done-toggle" @click="showDone = !showDone">
          {{ showDone ? 'Hide' : 'Show' }} this week’s finished {{ plural(me.done.length, 'parcel') }}
        </button>
        <ul v-if="showDone" class="panel done">
          <li v-for="j in me.done" :key="j.id">
            <span class="mono">{{ j.orderId }}</span>
            <span class="grow">{{ j.recipient.name }}, {{ j.recipient.city }}</span>
            <span v-if="j.codCollected" class="figures">{{ taka(j.codCollected) }}</span>
            <StatusTag :status="j.status" />
            <span class="muted small">{{ time(j.deliveredAt ?? j.updatedAt) }}</span>
          </li>
        </ul>
      </template>
    </StateBlock>

    <Dialog :open="finish.open" title="Hand over the parcel" @close="finish.open = false">
      <form v-if="finish.job" class="dialog-form" novalidate @submit.prevent="sendFinish">
        <p v-if="finish.error" class="form-error" role="alert">{{ finish.error }}</p>
        <Field v-if="finish.job.needsCode" id="code" label="Customer’s delivery code" hint="It’s on their order page in the Cartly app.">
          <input id="code" v-model="finish.code" class="input code" inputmode="numeric" maxlength="4" autocomplete="off" placeholder="0000" />
        </Field>
        <Field v-if="finish.job.codAmount" id="collected" label="Cash you took (taka)" :hint="`The order is ${taka(finish.job.codAmount)}.`">
          <input id="collected" v-model="finish.collected" class="input" type="number" min="0" step="1" inputmode="numeric" />
        </Field>
        <div class="dialog-buttons">
          <button type="button" class="btn" @click="finish.open = false">Back</button>
          <button class="btn primary" :disabled="busy === finish.job.id">{{ busy === finish.job.id ? 'Saving…' : 'Delivered' }}</button>
        </div>
      </form>
    </Dialog>

    <Dialog :open="fail.open" title="Couldn’t deliver it" @close="fail.open = false">
      <form v-if="fail.job" class="dialog-form" novalidate @submit.prevent="sendFail">
        <p v-if="fail.error" class="form-error" role="alert">{{ fail.error }}</p>
        <fieldset class="reasons">
          <legend class="sr-only">What happened</legend>
          <label v-for="r in REASONS" :key="r" class="reason"><input v-model="fail.reason" type="radio" :value="r" /> {{ r }}</label>
          <label class="reason"><input v-model="fail.reason" type="radio" value="other" /> Something else</label>
        </fieldset>
        <input v-if="fail.reason === 'other'" v-model="fail.other" class="input" maxlength="200" placeholder="What happened?" aria-label="What happened" />
        <div class="dialog-buttons">
          <button type="button" class="btn" @click="fail.open = false">Back</button>
          <button class="btn primary" :disabled="busy === fail.job.id">{{ busy === fail.job.id ? 'Saving…' : 'Save' }}</button>
        </div>
      </form>
    </Dialog>
  </div>
</template>

<style scoped>
.rider {
  max-width: 560px;
  margin: 0 auto;
  padding: 12px 16px 40px;
}
.top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 0 14px;
}
.wordmark {
  margin: 0;
  font-family: var(--font-display);
  font-size: 19px;
  font-weight: 700;
  letter-spacing: -0.03em;
}
.wordmark span {
  font-family: var(--font-ui);
  font-size: 12px;
  font-weight: 650;
  letter-spacing: 0;
  color: var(--muted);
}
.top-buttons {
  display: flex;
  gap: 4px;
}
.summary {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: 10px;
  margin-bottom: 14px;
}
.summary > div {
  display: grid;
  padding: 12px 14px;
  border-radius: var(--r-panel);
  background: var(--grey);
}
.big {
  font-size: 22px;
  font-weight: 800;
}
.empty {
  text-align: center;
}
.job {
  display: grid;
  gap: 12px;
  margin-bottom: 14px;
  padding: 16px;
}
.job-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.who .name {
  font-size: 18px;
}
.addr {
  margin: 2px 0 8px;
}
.contact,
.steps {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.steps .btn {
  flex: 1;
  min-height: 46px;
  font-size: 15px;
}
.return-tag {
  margin-left: 6px;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--peach, #ffe3cc);
  color: #1d2126;
  font-family: var(--font-ui);
  font-size: 12px;
}
.collect {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 14px;
  border-radius: 10px;
  background: var(--butter, #fde8a1);
  color: #1d2126;
}
.collect strong {
  font-size: 20px;
}
.collect.paid {
  background: var(--mint, #b5eed3);
}
.collect.paid strong {
  font-size: 15px;
}
.note {
  margin: 0;
  font-size: 14px;
}
.items {
  display: grid;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
  font-size: 13.5px;
}
.items li {
  display: flex;
  align-items: center;
  gap: 10px;
}
.items img {
  width: 36px;
  height: 36px;
  border-radius: 8px;
  object-fit: cover;
}
.done-toggle {
  width: 100%;
}
.done {
  display: grid;
  margin: 10px 0 0;
  padding: 0;
  list-style: none;
}
.done li {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  border-top: 1px solid var(--line);
  font-size: 13.5px;
  flex-wrap: wrap;
}
.done li:first-child {
  border-top: 0;
}
.grow {
  flex: 1;
  min-width: 0;
}
.mono {
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
}
.small {
  font-size: 12.5px;
  margin: 0;
}
.warn {
  color: var(--warn);
}
.dialog-form {
  display: grid;
  gap: 14px;
}
.dialog-buttons {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.code {
  font-size: 26px;
  letter-spacing: 0.4em;
  text-align: center;
}
.reasons {
  display: grid;
  gap: 10px;
  margin: 0;
  padding: 0;
  border: 0;
}
.reason {
  display: flex;
  gap: 10px;
  align-items: center;
  font-size: 15px;
}
</style>
