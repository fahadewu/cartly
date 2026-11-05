<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { RouterLink } from 'vue-router'
import Icon from '../components/Icon.vue'
import { api } from '../api.js'
import { productById } from '../catalog.js'
import { price } from '../data.js'
import { REACTIONS, TAGS } from '../looks.js'

// The page family and friends open from an "Ask family" link: no account, one tap to vote, in English or Bangla.
const props = defineProps({ token: { type: String, required: true } })

const T = {
  en: {
    asks: (n) => (n ? `${n} wants your opinion` : 'Your opinion, please'),
    vote: 'Tap how you feel',
    why: 'Why? (optional)',
    who: 'Your name',
    whoHint: 'e.g. Ammu, Apu, Rafi',
    say: 'Add a note (optional)',
    send: 'Send my vote',
    change: 'Change my vote',
    thanks: 'Thanks! They’ll see your vote.',
    so_far: (n) => `${n} vote${n === 1 ? '' : 's'} so far`,
    whole: 'Whole look',
    shop: 'See it on Cartly',
    gone: 'This look isn’t shared any more',
    goneSub: 'Links last 7 days, or until the person who shared it stops sharing.',
    browse: 'Browse Cartly',
    days: (d) => `Voting open for ${d} more day${d === 1 ? '' : 's'}`,
    private: 'Only people with this link can see it.',
  },
  bn: {
    asks: (n) => (n ? `${n} তোমার মতামত চায়` : 'তোমার মতামত দাও'),
    vote: 'কেমন লাগছে? একটা চাপো',
    why: 'কেন? (ইচ্ছে হলে)',
    who: 'তোমার নাম',
    whoHint: 'যেমন আম্মু, আপু, রাফি',
    say: 'কিছু বলতে চাও? (ইচ্ছে হলে)',
    send: 'ভোট পাঠাও',
    change: 'ভোট বদলাও',
    thanks: 'ধন্যবাদ! তোমার ভোট পৌঁছে গেছে।',
    so_far: (n) => `এখন পর্যন্ত ${n.toLocaleString('bn-BD')}টি ভোট`,
    whole: 'পুরো লুক',
    shop: 'Cartly-তে দেখো',
    gone: 'এই লুকটা আর শেয়ার করা নেই',
    goneSub: 'লিংক ৭ দিন থাকে, অথবা যিনি শেয়ার করেছেন তিনি বন্ধ করা পর্যন্ত।',
    browse: 'Cartly ঘুরে দেখো',
    days: (d) => `আরও ${d.toLocaleString('bn-BD')} দিন ভোট দেওয়া যাবে`,
    private: 'শুধু এই লিংক যাদের কাছে আছে তারাই দেখতে পাবে।',
  },
}
const lang = ref(navigator.language?.startsWith('bn') ? 'bn' : 'en')
const t = computed(() => T[lang.value])
const label = (x) => x[lang.value]

const look = ref(null)
const missing = ref(false)
async function load() {
  try {
    look.value = await api(`/looks/${props.token}`)
  } catch (e) {
    if (e.status === 404) missing.value = true
  }
}

const imageSrc = computed(() => `${import.meta.env.VITE_API_URL ?? '/api/v1'}/looks/${props.token}/image`)
const items = computed(() => (look.value?.items ?? []).map((i) => ({ ...i, p: productById(i.productId) })).filter((i) => i.p))
const total = computed(() => items.value.reduce((n, i) => n + i.p.price, 0))
const daysLeft = computed(() => (look.value ? Math.max(1, Math.ceil((Date.parse(look.value.expiresAt) - Date.now()) / 864e5)) : 0))

// One vote per browser: a random id kept here, so voting again changes your vote instead of adding one.
const VOTER = 'cartly.voter'
const MINE = 'cartly.myvotes'
const store = {
  get: (k, d) => {
    try {
      return JSON.parse(localStorage.getItem(k)) ?? d
    } catch {
      return d
    }
  },
  set: (k, v) => {
    try {
      localStorage.setItem(k, JSON.stringify(v))
    } catch {}
  },
}
let voterId = store.get(VOTER, null)
if (!voterId) store.set(VOTER, (voterId = crypto.randomUUID()))
const mine = store.get(MINE, {})[props.token] ?? null

const draft = reactive({ reaction: mine?.reaction ?? '', tags: mine?.tags ?? [], comment: mine?.comment ?? '', name: mine?.name ?? store.get('cartly.voterName', '') })
const voted = ref(!!mine)
const sending = ref(false)
const error = ref('')
function toggleTag(id) {
  draft.tags = draft.tags.includes(id) ? draft.tags.filter((x) => x !== id) : [...draft.tags, id].slice(-3)
}
async function send() {
  if (!draft.reaction) return
  sending.value = true
  error.value = ''
  try {
    const body = { voterId, reaction: draft.reaction, tags: draft.tags, name: draft.name.trim() || undefined, comment: draft.comment.trim() || undefined }
    look.value = await api(`/looks/${props.token}/votes`, { method: 'POST', body })
    store.set(MINE, { ...store.get(MINE, {}), [props.token]: { ...body } })
    if (body.name) store.set('cartly.voterName', body.name)
    voted.value = true
  } catch (e) {
    error.value = e.message
  } finally {
    sending.value = false
  }
}

const bars = computed(() => {
  const n = look.value?.total || 0
  return REACTIONS.map((r) => ({ ...r, n: look.value?.reactions?.[r.id] ?? 0, pct: n ? Math.round(((look.value.reactions[r.id] ?? 0) / n) * 100) : 0 }))
})
const emoji = (id) => REACTIONS.find((r) => r.id === id)?.emoji ?? ''
const tagLabel = (id) => label(TAGS.find((x) => x.id === id) ?? { en: id, bn: id })

let timer
onMounted(() => {
  load()
  // Others' votes appear while the page is open.
  timer = setInterval(() => !document.hidden && voted.value && load(), 15_000)
  document.title = 'Help choose a look · Cartly'
})
onBeforeUnmount(() => clearInterval(timer))
</script>

<template>
  <main class="vote-page" :lang="lang">
    <header class="top">
      <RouterLink to="/" class="logo">Cartly</RouterLink>
      <div class="langs" role="group" aria-label="Language">
        <button :class="{ on: lang === 'en' }" @click="lang = 'en'">English</button>
        <button :class="{ on: lang === 'bn' }" @click="lang = 'bn'">বাংলা</button>
      </div>
    </header>

    <section v-if="missing" class="card gone">
      <h1>{{ t.gone }}</h1>
      <p>{{ t.goneSub }}</p>
      <RouterLink to="/" class="btn-primary">{{ t.browse }}</RouterLink>
    </section>

    <template v-else-if="look">
      <section class="card ask">
        <p class="kicker"><Icon name="users" :size="16" />{{ t.asks(look.name) }}</p>
        <h1 v-if="look.note" dir="auto">“{{ look.note }}”</h1>

        <img v-if="look.image" class="photo" :src="imageSrc" alt="The look on them" />
        <ul class="items" :class="{ grid: !look.image && items.length > 1 }">
          <li v-for="i in items" :key="i.productId">
            <img :src="i.p.image" :alt="i.p.name" />
            <div>
              <b>{{ i.p.name }}</b>
              <small>{{ [i.color, i.size].filter(Boolean).join(' · ') }}</small>
              <span>{{ price(i.p.price) }}</span>
            </div>
          </li>
        </ul>
        <p v-if="items.length > 1" class="whole">{{ t.whole }} <b>{{ price(total) }}</b></p>
      </section>

      <section class="card">
        <h2>{{ voted ? t.so_far(look.total) : t.vote }}</h2>

        <div v-if="!voted" class="reactions" role="radiogroup" :aria-label="t.vote">
          <button
            v-for="r in REACTIONS"
            :key="r.id"
            role="radio"
            :aria-checked="draft.reaction === r.id"
            :class="{ on: draft.reaction === r.id }"
            @click="draft.reaction = r.id"
          >
            <span class="e">{{ r.emoji }}</span>{{ label(r) }}
          </button>
        </div>

        <Transition name="fade">
          <div v-if="!voted && draft.reaction" class="more">
            <p class="sub">{{ t.why }}</p>
            <div class="tags">
              <button v-for="x in TAGS" :key="x.id" :class="{ on: draft.tags.includes(x.id) }" :aria-pressed="draft.tags.includes(x.id)" @click="toggleTag(x.id)">
                {{ label(x) }}
              </button>
            </div>
            <label class="field">
              <span>{{ t.who }}</span>
              <input v-model="draft.name" maxlength="30" :placeholder="t.whoHint" dir="auto" />
            </label>
            <label class="field">
              <span>{{ t.say }}</span>
              <input v-model="draft.comment" maxlength="120" dir="auto" />
            </label>
            <p v-if="error" class="form-alert error"><Icon name="alert" :size="16" />{{ error }}</p>
            <button class="btn-primary send" :disabled="sending" @click="send">{{ t.send }}</button>
          </div>
        </Transition>

        <template v-if="voted">
          <p class="thanks"><Icon name="check" :size="16" />{{ t.thanks }}</p>
          <ul class="bars">
            <li v-for="b in bars" :key="b.id">
              <span>{{ b.emoji }} {{ label(b) }}</span><i><em :style="{ width: `${b.pct}%` }" /></i><b>{{ b.n }}</b>
            </li>
          </ul>
          <ul class="votes">
            <li v-for="(v, i) in look.votes" :key="i">
              <span class="e">{{ emoji(v.reaction) }}</span>
              <div>
                <b dir="auto">{{ v.name || '—' }}</b>
                <small v-if="v.tags.length">{{ v.tags.map(tagLabel).join(' · ') }}</small>
                <p v-if="v.comment" dir="auto">{{ v.comment }}</p>
              </div>
            </li>
          </ul>
          <button class="btn-secondary sm" @click="voted = false">{{ t.change }}</button>
        </template>
      </section>

      <p class="foot">
        {{ t.days(daysLeft) }} · {{ t.private }}
        <RouterLink v-if="items[0]" :to="`/product/${items[0].productId}`">{{ t.shop }} →</RouterLink>
      </p>
    </template>

    <div v-else class="loading"><span class="spinner" /></div>
  </main>
</template>

<style scoped>
.vote-page {
  max-width: 560px;
  min-height: 100dvh;
  margin: 0 auto;
  padding: 16px 16px 40px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 4px 0;
}
.logo {
  font-size: 24px;
  font-weight: 700;
  letter-spacing: -0.03em;
  color: var(--ink);
  text-decoration: none;
}
.langs {
  display: inline-flex;
  padding: 3px;
  border-radius: var(--r-pill);
  background: #fff;
}
.langs button {
  height: 34px;
  padding: 0 14px;
  border-radius: var(--r-pill);
  font-size: 14px;
}
.langs button.on {
  background: var(--ink);
  color: #fff;
}
.card {
  padding: 20px;
  border-radius: 28px;
  background: #fff;
}
.kicker {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  border-radius: var(--r-pill);
  background: var(--mint);
  font-size: 14px;
  font-weight: 500;
}
.ask h1 {
  margin-top: 12px;
  font-size: 24px;
  font-weight: 600;
  letter-spacing: -0.01em;
}
.photo {
  display: block;
  width: 100%;
  max-height: 70vh;
  margin-top: 14px;
  border-radius: 20px;
  object-fit: contain;
  background: var(--card);
}
.items {
  margin: 14px 0 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.items li {
  display: flex;
  gap: 12px;
  align-items: center;
}
.items img {
  width: 64px;
  height: 64px;
  border-radius: 16px;
  object-fit: cover;
  background: var(--card);
}
.items.grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
}
.items.grid li {
  flex-direction: column;
  align-items: stretch;
}
.items.grid img {
  width: 100%;
  height: auto;
  aspect-ratio: 1;
}
.items:not(.grid) li:only-child img {
  width: 100%;
  height: auto;
  aspect-ratio: 1;
}
.items:not(.grid) li:only-child {
  flex-direction: column;
  align-items: stretch;
}
.items div {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.items b {
  font-size: 15px;
  font-weight: 500;
}
.items small {
  font-size: 13px;
  color: var(--muted);
}
.items span {
  font-size: 15px;
  font-weight: 600;
}
.whole {
  margin-top: 12px;
  font-size: 14px;
  color: var(--muted);
}
.whole b {
  color: var(--ink);
}
h2 {
  font-size: 18px;
  font-weight: 600;
  margin-bottom: 12px;
}
.reactions {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
}
.reactions button {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 14px 4px;
  border: 2px solid transparent;
  border-radius: 20px;
  background: var(--card);
  font-size: 13px;
  font-weight: 500;
  transition: transform 0.12s ease;
}
.reactions button:active {
  transform: scale(0.96);
}
.reactions button.on {
  border-color: var(--ink);
  background: #fff;
}
.e {
  font-size: 30px;
  line-height: 1;
}
.more {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-top: 16px;
}
.sub {
  font-size: 13px;
  color: var(--muted);
}
.tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: -6px;
}
.tags button {
  padding: 8px 12px;
  border-radius: var(--r-pill);
  background: var(--chip);
  font-size: 13px;
}
.tags button.on {
  background: var(--ink);
  color: #fff;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 13px;
  color: var(--muted);
}
.field input {
  height: 48px;
  padding: 0 16px;
  border: 1.5px solid transparent;
  border-radius: 16px;
  background: var(--chip);
  font: inherit;
  font-size: 16px;
  color: var(--ink);
  outline: none;
}
.field input:focus {
  border-color: var(--blue);
  background: #fff;
}
.send {
  width: 100%;
}
.thanks {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
  color: #1a7f4b;
  font-size: 14px;
  font-weight: 500;
}
.bars {
  margin: 0 0 14px;
  padding: 0;
  list-style: none;
}
.bars li {
  display: grid;
  grid-template-columns: 130px 1fr 24px;
  align-items: center;
  gap: 10px;
  padding: 5px 0;
  font-size: 14px;
}
.bars i {
  height: 10px;
  border-radius: 5px;
  background: var(--line);
  overflow: hidden;
}
.bars em {
  display: block;
  height: 100%;
  background: var(--blue);
}
.bars b {
  text-align: right;
}
.votes {
  margin: 0 0 14px;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.votes li {
  display: flex;
  gap: 10px;
}
.votes .e {
  font-size: 22px;
}
.votes div {
  display: flex;
  flex-direction: column;
}
.votes b {
  font-size: 14px;
  font-weight: 500;
}
.votes small {
  font-size: 12px;
  color: var(--muted);
}
.votes p {
  font-size: 14px;
  color: #4b5058;
}
.foot {
  padding: 0 6px;
  font-size: 13px;
  color: var(--muted);
}
.foot a {
  display: inline-block;
  margin-left: 6px;
  color: var(--blue);
  font-weight: 500;
}
.gone {
  text-align: center;
}
.gone h1 {
  font-size: 22px;
}
.gone p {
  margin: 8px 0 16px;
  color: var(--muted);
}
.loading {
  display: grid;
  place-items: center;
  min-height: 50vh;
}
@media (max-width: 400px) {
  .reactions {
    grid-template-columns: repeat(2, 1fr);
  }
  .bars li {
    grid-template-columns: 110px 1fr 24px;
  }
}
</style>
