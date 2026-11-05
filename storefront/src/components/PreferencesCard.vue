<script setup>
import { onMounted, reactive, ref } from 'vue'
import { useRoute } from 'vue-router'
import { api } from '../api.js'
import { toast } from '../toast.js'
import { MONK, estimateTone } from '../tone.js'
import { setPrefs } from '../prefs.js'
import { forgetStyle } from '../style.js'

// Account → what the shopper chooses to tell the store: emails (opt-in), sizes, and colouring for colour suggestions.
const route = useRoute()
const p = ref(null)
const CLOTHING = ['XS', 'S', 'M', 'L', 'XL', 'XXL']
const SHOES = ['35', '36', '37', '38', '39', '40', '41', '42', '43', '44', '45', '46']
const UNDERTONES = [
  { value: 'warm', label: 'Warm', hint: 'Veins look greenish; gold jewellery suits you' },
  { value: 'cool', label: 'Cool', hint: 'Veins look blue or purple; silver suits you' },
  { value: 'neutral', label: 'Neutral', hint: 'A mix of both, or hard to tell' },
]
const photo = reactive({ consent: false, busy: false, guess: null, error: '' })

onMounted(async () => {
  p.value = await api('/me/preferences').catch(() => null)
  if (route.query.unsubscribed) toast('You won’t get product emails from Cartly any more.')
})

async function save(body, done) {
  try {
    p.value = await api('/me/preferences', { method: 'PUT', body })
    setPrefs(p.value)
    if (done) toast(done)
  } catch (e) {
    toast(e.message, 'error')
  }
}
const setSize = (type, size) => save({ sizes: { ...p.value.sizes, [type]: size } }, 'Size saved')

async function estimate(e) {
  const file = e.target.files?.[0]
  e.target.value = ''
  if (!file) return
  Object.assign(photo, { busy: true, error: '', guess: null })
  try {
    photo.guess = await estimateTone(file)
  } catch (err) {
    photo.error = err.message
  } finally {
    photo.busy = false
  }
}
async function useGuess() {
  await save({ skinTone: photo.guess.tone, undertone: p.value.undertone, toneSource: 'photo' }, 'Tone saved')
  photo.guess = null
}
async function dropStyle() {
  try {
    await forgetStyle()
    p.value = { ...p.value, styles: [] }
    toast('Style quiz answers removed')
  } catch (e) {
    toast(e.message, 'error')
  }
}
async function forget() {
  try {
    p.value = await api('/me/preferences/colouring', { method: 'DELETE' })
    toast('Colouring removed')
  } catch (e) {
    toast(e.message, 'error')
  }
}
</script>

<template>
  <section v-if="p" class="prefs">
    <div class="pref">
      <div>
        <b>Emails about products for you</b>
        <small>When something you looked for arrives, comes back in stock or drops in price, and new things that suit you. At most one every few days; unsubscribe from any email.</small>
      </div>
      <div class="seg">
        <button :class="{ on: p.marketingEmails }" @click="save({ marketingEmails: true }, 'Emails on')">On</button>
        <button :class="{ on: !p.marketingEmails }" @click="save({ marketingEmails: false }, 'Emails off')">Off</button>
      </div>
    </div>
    <div v-if="p.marketingEmails" class="pref sub">
      <small>Email language</small>
      <div class="seg">
        <button :class="{ on: p.emailLang === 'en' }" @click="save({ emailLang: 'en' })">English</button>
        <button :class="{ on: p.emailLang === 'bn' }" @click="save({ emailLang: 'bn' })">বাংলা</button>
      </div>
    </div>

    <div class="pref">
      <div>
        <b>Your style</b>
        <small v-if="p.styles?.length">You picked {{ p.styles.map((s) => s.label).join(' + ') }} in the style quiz. “Picked for you” and Pip start from it.</small>
        <small v-else>Take the 30-second “this or that” quiz and suggestions start from what you choose.</small>
      </div>
      <div class="seg">
        <RouterLink to="/style" class="seg-link">{{ p.styles?.length ? 'Retake' : 'Take the quiz' }}</RouterLink>
        <button v-if="p.styles?.length" @click="dropStyle">Remove</button>
      </div>
    </div>

    <div class="block">
      <b>Your sizes</b>
      <small>Pip picks these first and tells you when something isn’t made in your size.</small>
      <div class="sizes">
        <label>Clothing
          <select :value="p.sizes.Clothing ?? ''" @change="setSize('Clothing', $event.target.value)">
            <option value="">Not set</option>
            <option v-for="s in CLOTHING" :key="s">{{ s }}</option>
          </select>
        </label>
        <label>Shoes (EU)
          <select :value="p.sizes.Shoes ?? ''" @change="setSize('Shoes', $event.target.value)">
            <option value="">Not set</option>
            <option v-for="s in SHOES" :key="s">{{ s }}</option>
          </select>
        </label>
        <label>Fit you like
          <select :value="p.fit ?? ''" @change="save({ fit: $event.target.value || null }, 'Saved')">
            <option value="">Any</option>
            <option v-for="f in ['slim', 'regular', 'relaxed', 'oversized']" :key="f" :value="f">{{ f[0].toUpperCase() + f.slice(1) }}</option>
          </select>
        </label>
      </div>
    </div>

    <div class="block">
      <b>Your colouring <span class="opt">optional</span></b>
      <small>Helps Pip and our picks suggest colours that suit you. Only you set it, and you can remove it any time.</small>
      <div class="tones" role="radiogroup" aria-label="Skin tone, lightest to deepest">
        <button
          v-for="(hex, i) in MONK"
          :key="hex"
          role="radio"
          :aria-checked="p.skinTone === i + 1"
          :aria-label="`Tone ${i + 1} of 10`"
          :class="{ on: p.skinTone === i + 1 }"
          :style="{ background: hex }"
          @click="save({ skinTone: i + 1, undertone: p.undertone, toneSource: 'picked' })"
        />
      </div>
      <div class="seg under">
        <button v-for="u in UNDERTONES" :key="u.value" :class="{ on: p.undertone === u.value }" :title="u.hint" @click="save({ skinTone: p.skinTone, undertone: u.value, toneSource: 'picked' })">
          {{ u.label }}
        </button>
      </div>
      <small v-if="p.undertone" class="muted">{{ UNDERTONES.find((u) => u.value === p.undertone)?.hint }}</small>
      <p v-if="p.suits.length" class="suits">Shades that usually suit you: {{ p.suits.join(', ') }}</p>

      <div class="photo">
        <label class="check">
          <input v-model="photo.consent" type="checkbox" />
          <span>Estimate it from a photo of me. The photo stays on this device; only the tone I confirm is saved.</span>
        </label>
        <label v-if="photo.consent" class="btn-secondary sm pick">
          <input type="file" accept="image/*" @change="estimate" />
          {{ photo.busy ? 'Looking…' : 'Choose a photo' }}
        </label>
        <p v-if="photo.error" class="err">{{ photo.error }}</p>
        <div v-if="photo.guess" class="guess">
          <span class="swatch" :style="{ background: MONK[photo.guess.tone - 1] }" />
          <span>Looks like tone {{ photo.guess.tone }} of 10. Lighting can shift it: pick another swatch if it’s off, and choose your undertone above.</span>
          <button class="btn-primary sm" @click="useGuess">Use this</button>
        </div>
      </div>
      <button v-if="p.skinTone || p.undertone" class="linkish" @click="forget">Remove my colouring</button>
    </div>
  </section>
</template>

<style scoped>
/* The same segmented control as the Account page's other preferences. */
.seg {
  display: flex;
  flex-shrink: 0;
  padding: 4px;
  border-radius: var(--r-pill);
  background: var(--chip);
}
.seg button {
  height: 40px;
  padding: 0 16px;
  border-radius: var(--r-pill);
  font-size: 13px;
  color: var(--muted);
}
.seg button.on {
  background: #fff;
  color: var(--ink);
  box-shadow: 0 6px 16px -8px rgba(0, 0, 0, 0.2);
}
.prefs {
  display: grid;
  gap: 18px;
}
.pref {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
.seg-link {
  display: inline-flex;
  align-items: center;
  padding: 0 14px;
  color: inherit;
  text-decoration: none;
  font-size: 14px;
}
.pref.sub {
  margin-top: -8px;
}
b {
  display: block;
}
small {
  display: block;
  color: var(--muted);
  line-height: 1.45;
}
.opt {
  margin-left: 6px;
  color: var(--muted);
  font-size: 12px;
  font-weight: 500;
}
.block {
  display: grid;
  gap: 8px;
}
.sizes {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}
.sizes label {
  display: grid;
  gap: 4px;
  font-size: 13px;
}
.sizes select {
  min-width: 120px;
  padding: 8px 10px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--shell);
  font: inherit;
}
.tones {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.tones button {
  width: 28px;
  height: 28px;
  border: 2px solid transparent;
  border-radius: 50%;
  box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.12);
  cursor: pointer;
}
.tones button.on {
  border-color: var(--ink);
  outline: 2px solid var(--shell);
  outline-offset: -4px;
}
.under {
  width: fit-content;
}
.suits {
  margin: 0;
  font-size: 14px;
}
.photo {
  display: grid;
  gap: 8px;
  padding: 12px;
  border-radius: 16px;
  background: var(--chip);
}
.check {
  display: flex;
  gap: 8px;
  font-size: 14px;
}
.pick {
  position: relative;
  width: fit-content;
  overflow: hidden;
}
.pick input {
  position: absolute;
  inset: 0;
  opacity: 0;
  cursor: pointer;
}
.guess {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  font-size: 14px;
}
.swatch {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.12);
}
.err {
  margin: 0;
  color: #c62828;
  font-size: 14px;
}
.linkish {
  width: fit-content;
  padding: 0;
  border: 0;
  background: none;
  color: var(--muted);
  font: inherit;
  font-size: 13px;
  text-decoration: underline;
  cursor: pointer;
}
</style>
