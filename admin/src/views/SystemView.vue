<script setup>
import { computed, ref } from 'vue'
import PageHeader from '../components/PageHeader.vue'
import StatusTag from '../components/StatusTag.vue'
import StateBlock from '../components/StateBlock.vue'
import Icon from '../components/Icon.vue'
import { get, post } from '../api.js'
import { useResource } from '../composables.js'
import { count, money } from '../format.js'
import { toast } from '../toast.js'

const { data: sys, loading, error, reload } = useResource(() => get('/admin/system'))
const rebuilding = ref(false)
const result = ref('')

async function rebuild() {
  rebuilding.value = true
  result.value = ''
  try {
    const r = await post('/admin/system/reindex')
    result.value = `Indexed ${count(r.indexed)} products with the ${r.embedder} embedder.`
    toast('Search index rebuilt')
    reload({ quiet: true })
  } catch (e) {
    toast(e.message, 'error')
    result.value = e.message
  } finally {
    rebuilding.value = false
  }
}

const services = computed(() => {
  const s = sys.value?.services
  if (!s) return []
  return [
    { name: 'Database', about: 'PostgreSQL with pgvector. Products, orders, accounts.', ...s.database },
    { name: 'Redis', about: 'Carts, Pip’s memory, rate limits and search cache.', ...s.redis },
  ]
})
const ai = computed(() => sys.value?.services.ai)
const PROVIDERS = { rules: 'Rule-based (no API key needed)' }

// Estimated spend on the paid AI services (UTC days), from the AI service's meter.
const cents = (n) => (n > 0 && n < 0.01 ? '<$0.01' : money(n))
const spend = computed(() => {
  const u = sys.value?.aiUsage
  if (!u) return null
  const [day] = u.days
  const n = (k) => Number(day[k] ?? 0)
  const vendors = [
    { name: 'Pip (Claude)', cost: n('claude:cost'), cap: u.budgets.claude, detail: `${count(n('claude:calls'))} calls · ${u.models.agent}` },
    { name: 'AI try-on (FASHN)', cost: n('fashn:cost'), cap: u.budgets.fashn, detail: `${count(n('fashn:renders'))} renders · ${count(n('fashn:credits'))} credits` },
    { name: 'Voice (ElevenLabs)', cost: n('voice:cost'), cap: u.budgets.voice, detail: `${count(n('tts:chars'))} characters spoken · ${count(n('stt:calls'))} transcribed` },
  ]
  const total = (d) => ['claude:cost', 'fashn:cost', 'voice:cost'].reduce((t, k) => t + Number(d[k] ?? 0), 0)
  return {
    vendors,
    today: total(day),
    week: u.days.reduce((t, d) => t + total(d), 0),
    saved: [
      [n('saved:greet') + n('saved:greet_personal'), 'greetings'],
      [n('saved:reply'), 'Pip replies'],
      [n('saved:tryon_step'), 'try-on steps'],
      [n('saved:tts'), 'voice clips'],
    ].filter(([k]) => k > 0),
    // Pip turns that never reached Claude: off-topic or noise messages and plain thank-yous answered from
    // templates, and taps on Pip's product cards that used to be sent as chat messages.
    free: [
      [n('saved:gate'), 'off-topic or noise messages'],
      [n('saved:closer'), 'thank-yous'],
      [n('saved:card'), 'card taps'],
    ].filter(([k]) => k > 0),
  }
})
const VOICE = { browser: 'Browser speech recognition', livekit: 'LiveKit real-time voice' }
</script>

<template>
  <div>
    <PageHeader title="System" description="The services behind the store, and the settings that apply to every order.">
      <button class="btn" :disabled="loading" @click="reload()"><Icon name="refresh" :size="15" />Check again</button>
    </PageHeader>

    <StateBlock :loading="loading && !sys" :error="error" @retry="reload">
      <template v-if="sys">
        <div class="layout">
          <div class="stack">
            <section class="panel">
              <div class="panel-head">
                <h2>Services</h2>
                <StatusTag :status="sys.status === 'ok' ? 'OK' : 'DOWN'" :label="sys.status === 'ok' ? 'All running' : 'Needs attention'" />
              </div>
              <ul class="services">
                <li v-for="s in services" :key="s.name">
                  <span class="dot" :class="s.ok ? 'ok' : 'bad'" />
                  <div class="grow">
                    <strong>{{ s.name }}</strong>
                    <span class="muted">{{ s.about }}</span>
                  </div>
                  <span class="figures" :class="{ bad: !s.ok }">{{ s.ok ? `${s.ms} ms` : s.error }}</span>
                </li>
                <li>
                  <span class="dot" :class="ai.ok ? 'ok' : 'bad'" />
                  <div class="grow">
                    <strong>AI service</strong>
                    <span class="muted">Pip, semantic search and voice. The store keeps working without it, with keyword search.</span>
                  </div>
                  <span class="figures" :class="{ bad: !ai.ok }">{{ ai.ok ? `${ai.ms} ms` : 'Unreachable' }}</span>
                </li>
              </ul>
            </section>

            <section class="panel">
              <div class="panel-head"><h2>Pip and search</h2></div>
              <div class="panel-body">
                <dl v-if="ai.ok" class="kv">
                  <dt>Pip’s brain</dt>
                  <dd>{{ PROVIDERS[ai.provider] ?? ai.provider }}</dd>
                  <dt>Search model</dt>
                  <dd>{{ ai.embedder === 'hashing' ? 'Built-in (offline, no model download)' : ai.embedder }}</dd>
                  <dt>Products indexed</dt>
                  <dd class="figures">{{ count(ai.index_size) }} of {{ count(ai.catalog_size) }} live products</dd>
                  <dt>Voice</dt>
                  <dd>{{ VOICE[ai.voice] ?? ai.voice }}</dd>
                </dl>
                <p v-else class="muted">The AI service at {{ sys.settings.aiServiceUrl }} isn’t responding. Start it with <strong>./run.sh</strong> in backend/ai.</p>
                <div class="reindex">
                  <p class="muted">Search and Pip pick up product changes a few seconds after you save. Rebuild by hand if results look out of date.</p>
                  <button v-can="'system.write'" class="btn primary" :disabled="rebuilding || !ai.ok" @click="rebuild">{{ rebuilding ? 'Rebuilding…' : 'Rebuild search index' }}</button>
                  <p v-if="result" class="result" role="status">{{ result }}</p>
                </div>
              </div>
            </section>
          </div>

          <div class="stack">
            <section class="panel">
              <div class="panel-head"><h2>Store settings</h2></div>
              <div class="panel-body">
                <dl class="kv">
                  <dt>Free delivery</dt>
                  <dd>On orders over {{ money(sys.settings.freeShippingOver) }} after discounts (standard only)</dd>
                  <template v-for="(opt, key) in sys.settings.shipping" :key="key">
                    <dt>{{ opt.label }}</dt>
                    <dd>{{ money(opt.price) }}, {{ opt.eta }}</dd>
                  </template>
                  <dt>Low stock</dt>
                  <dd>{{ sys.settings.lowStockThreshold }} or fewer left</dd>
                  <dt>Live promo codes</dt>
                  <dd><RouterLink to="/promotions">{{ sys.settings.activePromoCodes }}</RouterLink></dd>
                  <dt>Sign-in lasts</dt>
                  <dd>{{ sys.settings.sessionLength.replace(/d$/, ' days').replace(/h$/, ' hours') }}</dd>
                </dl>
                <p class="muted note">Delivery rules come from backend/catalog/catalog.json, shared by the API and the storefront.</p>
              </div>
            </section>

            <section v-if="spend" class="panel">
              <div class="panel-head">
                <h2>AI spend today</h2>
                <span class="figures">{{ cents(spend.today) }}</span>
              </div>
              <div class="panel-body">
                <dl class="kv">
                  <template v-for="v in spend.vendors" :key="v.name">
                    <dt>{{ v.name }}</dt>
                    <dd>
                      <span class="figures">{{ cents(v.cost) }}</span>{{ v.cap ? ` of ${money(v.cap)} daily cap` : ' (no daily cap)' }}
                      <span class="muted sub">{{ v.detail }}</span>
                    </dd>
                  </template>
                  <dt>Last 7 days</dt>
                  <dd class="figures">{{ cents(spend.week) }}</dd>
                  <template v-if="spend.saved.length">
                    <dt>Served from cache</dt>
                    <dd>{{ spend.saved.map(([n, what]) => `${count(n)} ${what}`).join(', ') }}</dd>
                  </template>
                  <template v-if="spend.free.length">
                    <dt>Answered without Claude</dt>
                    <dd>{{ spend.free.map(([n, what]) => `${count(n)} ${what}`).join(', ') }}</dd>
                  </template>
                </dl>
                <p class="muted note">Estimates from list prices, in UTC days. Past a cap, that feature falls back for the rest of the day: Pip to its built-in answers, try-on to the quick preview, voice to the browser’s. Caps are set in backend/.env.</p>
              </div>
            </section>
          </div>
        </div>
      </template>
    </StateBlock>
  </div>
</template>

<style scoped>
.layout {
  display: grid;
  grid-template-columns: minmax(0, 1.4fr) minmax(280px, 1fr);
  gap: 18px;
  align-items: start;
}
.sub {
  display: block;
  font-size: 12.5px;
}
.services {
  margin: 0;
  padding: 0;
  list-style: none;
}
.services li {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 18px;
  border-top: 1px solid var(--line);
}
.services li:first-child {
  border-top: 0;
}
.grow {
  display: grid;
  flex: 1;
  min-width: 0;
  font-size: 13.5px;
}
.grow .muted {
  font-size: 12.5px;
}
.bad {
  color: var(--danger);
  font-weight: 700;
}
.reindex {
  display: grid;
  justify-items: start;
  gap: 10px;
  margin-top: 16px;
  padding-top: 16px;
  border-top: 1px solid var(--line);
}
.reindex p {
  max-width: 60ch;
  font-size: 13.5px;
}
.result {
  font-weight: 650;
}
.note {
  margin-top: 16px;
  font-size: 12.5px;
}
@media (max-width: 960px) {
  .layout {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
