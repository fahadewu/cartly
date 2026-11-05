<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
import Icon from './Icon.vue'
import { auth } from '../auth.js'
import { productById } from '../catalog.js'
import { price } from '../data.js'
import { shareLook } from '../looks.js'
import { toast } from '../toast.js'

// "Ask family": turns a look into a link family can vote on with one tap, no app or account.
const props = defineProps({
  /** [{ productId, color?, size? }] */
  items: { type: Array, required: true },
  /** Returns the fitting-room photo (data URL) when the shopper chooses to include it. */
  getImage: { type: Function, default: null },
})
const emit = defineEmits(['close'])

const products = computed(() => props.items.map((i) => ({ ...i, p: productById(i.productId) })).filter((i) => i.p))
const total = computed(() => products.value.reduce((n, i) => n + i.p.price, 0))
const withPhoto = ref(false)
const preview = ref(null)
const note = ref('')
const name = ref('')
const busy = ref(false)
const made = ref(null)
const error = ref('')

async function togglePhoto() {
  withPhoto.value = !withPhoto.value
  if (withPhoto.value && !preview.value) preview.value = await props.getImage().catch(() => null)
}

async function create() {
  busy.value = true
  error.value = ''
  try {
    const image = withPhoto.value ? (preview.value ?? (await props.getImage())) : null
    made.value = await shareLook({ items: props.items, note: note.value.trim(), name: auth.user ? undefined : name.value.trim(), image })
  } catch (e) {
    error.value = e.message
  } finally {
    busy.value = false
  }
}

const message = computed(() => `${note.value.trim() || 'What do you think of this look?'} কেমন লাগছে? Vote here, no app needed 👉 ${made.value?.url}`)
const whatsapp = computed(() => `https://wa.me/?text=${encodeURIComponent(message.value)}`)
const messenger = computed(() => `fb-messenger://share/?link=${encodeURIComponent(made.value?.url ?? '')}`)
const mobile = /Android|iPhone|iPad/i.test(navigator.userAgent)
const canShare = typeof navigator.share === 'function'
function nativeShare() {
  navigator.share({ title: 'Help me choose', text: message.value, url: made.value.url }).catch(() => {})
}
function copy() {
  navigator.clipboard?.writeText(made.value.url).then(
    () => toast('Link copied'),
    () => toast('Couldn’t copy. Select the link and copy it.'),
  )
}

const onKey = (e) => e.key === 'Escape' && emit('close')
onMounted(() => document.addEventListener('keydown', onKey))
onBeforeUnmount(() => document.removeEventListener('keydown', onKey))
</script>

<template>
  <Teleport to="body">
    <div class="scrim" @click.self="emit('close')">
      <section class="dialog" role="dialog" aria-modal="true" aria-labelledby="share-title">
        <header>
          <span class="badge"><Icon name="users" :size="18" /></span>
          <div>
            <h2 id="share-title">Ask family</h2>
            <p>They vote with one tap. No app or account needed.</p>
          </div>
          <button class="icon-btn" aria-label="Close" @click="emit('close')"><Icon name="close" :size="18" /></button>
        </header>

        <div class="look">
          <img v-if="withPhoto && preview" :src="preview" alt="Your look" class="photo" />
          <ul>
            <li v-for="i in products" :key="i.productId">
              <img :src="i.p.image" alt="" />
              <div>
                <b>{{ i.p.name }}</b>
                <small>{{ [i.color, i.size].filter(Boolean).join(' · ') }}</small>
              </div>
              <span>{{ price(i.p.price) }}</span>
            </li>
          </ul>
          <p v-if="products.length > 1" class="sum">Whole look <b>{{ price(total) }}</b></p>
        </div>

        <template v-if="!made">
          <button v-if="getImage" class="opt" :class="{ on: withPhoto }" role="switch" :aria-checked="withPhoto" @click="togglePhoto">
            <span class="tick"><Icon v-if="withPhoto" name="check" :size="14" /></span>
            <span><b>Include my try-on photo</b><small>Anyone with the link can see it. It’s deleted after 7 days, or when you stop sharing.</small></span>
          </button>
          <label class="field">
            <span>Ask them something</span>
            <input v-model="note" maxlength="140" placeholder="Which one for Eid? / ঈদের জন্য কোনটা?" dir="auto" />
          </label>
          <label v-if="!auth.user" class="field">
            <span>Your name, so they know who’s asking</span>
            <input v-model="name" maxlength="30" placeholder="e.g. Rumi" dir="auto" />
          </label>
          <p v-if="error" class="form-alert error"><Icon name="alert" :size="16" />{{ error }}</p>
          <button class="btn-primary go" :disabled="busy || !products.length" @click="create">
            <span v-if="busy" class="spinner" />{{ busy ? 'Making your link…' : 'Get a voting link' }}
          </button>
        </template>

        <template v-else>
          <div class="link">
            <input :value="made.url" readonly aria-label="Voting link" @focus="$event.target.select()" />
            <button class="btn-secondary sm" @click="copy"><Icon name="copy" :size="15" />Copy</button>
          </div>
          <div class="send">
            <a class="wa" :href="whatsapp" target="_blank" rel="noopener">WhatsApp</a>
            <a v-if="mobile" class="ms" :href="messenger">Messenger</a>
            <button v-if="canShare" class="more" @click="nativeShare"><Icon name="share" :size="16" />More apps</button>
          </div>
          <p class="after">
            Votes show up on <RouterLink to="/looks" @click="emit('close')">Family votes</RouterLink>, and Pip can tell you what they said.
          </p>
        </template>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.scrim {
  position: fixed;
  inset: 0;
  z-index: 130;
  display: grid;
  place-items: center;
  padding: 16px;
  background: rgba(18, 20, 23, 0.45);
}
.dialog {
  width: min(460px, 100%);
  max-height: calc(100dvh - 32px);
  overflow: auto;
  padding: 22px;
  border-radius: 28px;
  background: #fff;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
header {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}
header div {
  flex: 1;
}
header h2 {
  font-size: 20px;
  font-weight: 600;
}
header p {
  margin-top: 2px;
  font-size: 13px;
  color: var(--muted);
}
.badge {
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  border-radius: 14px;
  background: var(--mint);
}
.look {
  padding: 12px;
  border-radius: 20px;
  background: var(--card);
}
.photo {
  display: block;
  width: 100%;
  max-height: 260px;
  object-fit: contain;
  margin-bottom: 10px;
  border-radius: 14px;
  background: #fff;
}
.look ul {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.look li {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 14px;
}
.look li img {
  width: 44px;
  height: 44px;
  border-radius: 12px;
  object-fit: cover;
  background: #fff;
  mix-blend-mode: multiply;
}
.look li div {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.look li b {
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.look li small {
  font-size: 12px;
  color: var(--muted);
}
.sum {
  margin-top: 8px;
  font-size: 13px;
  text-align: right;
  color: var(--muted);
}
.sum b {
  color: var(--ink);
}
.opt {
  display: flex;
  gap: 12px;
  padding: 12px 14px;
  border: 1.5px solid var(--line);
  border-radius: 18px;
  text-align: left;
}
.opt.on {
  border-color: var(--ink);
}
.opt b {
  display: block;
  font-size: 14px;
  font-weight: 500;
}
.opt small {
  font-size: 12px;
  color: var(--muted);
}
.tick {
  flex: none;
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  margin-top: 1px;
  border: 1.5px solid #c9cdd2;
  border-radius: 7px;
}
.opt.on .tick {
  border-color: var(--ink);
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
.field input,
.link input {
  height: 46px;
  padding: 0 16px;
  border: 1.5px solid transparent;
  border-radius: 16px;
  background: var(--chip);
  font: inherit;
  font-size: 15px;
  color: var(--ink);
  outline: none;
}
.field input:focus {
  border-color: var(--blue);
  background: #fff;
}
.go {
  width: 100%;
}
.link {
  display: flex;
  gap: 8px;
}
.link input {
  flex: 1;
  min-width: 0;
  font-size: 13px;
}
.send {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.send a,
.send button {
  flex: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 48px;
  min-width: 120px;
  border-radius: var(--r-pill);
  font-size: 15px;
  font-weight: 500;
  text-decoration: none;
}
.wa {
  background: #25d366;
  color: #08331a;
}
.ms {
  background: #0a7cff;
  color: #fff;
}
.more {
  background: var(--chip);
  color: var(--ink);
}
.after {
  font-size: 13px;
  color: var(--muted);
}
.after a {
  color: var(--blue);
}
</style>
