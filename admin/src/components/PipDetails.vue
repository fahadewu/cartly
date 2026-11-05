<script setup>
import { computed, ref } from 'vue'
import Field from './Field.vue'
import Icon from './Icon.vue'
import { post } from '../api.js'
import { toast } from '../toast.js'

// What Pip (the AI shopping assistant) and search know about a product beyond its description.
// Edits `form` in place, like TryOnPanel. The same rules are enforced by the API.
const props = defineProps({ form: Object, errors: Object })
const OCCASIONS = ['everyday', 'office', 'formal', 'party', 'wedding', 'festive', 'date-night', 'sport', 'travel', 'lounge', 'beach', 'gift']
const SEASONS = ['summer', 'monsoon', 'autumn', 'winter', 'all-season']
const FITS = ['slim', 'regular', 'relaxed', 'oversized']
const STYLES = ['minimal', 'classic', 'streetwear', 'sporty', 'elegant', 'casual', 'boho', 'traditional', 'statement', 'cosy']
const label = (s) => s.charAt(0).toUpperCase() + s.slice(1).replace('-', ' ')

const clothing = computed(() => props.form.type === 'Clothing')
const drafts = ref({ styleTags: '', keywords: '', features: '' })
function toggle(list, value) {
  const i = props.form[list].indexOf(value)
  if (i >= 0) props.form[list].splice(i, 1)
  else props.form[list].push(value)
}
function add(list, max) {
  for (const raw of drafts.value[list].split(list === 'features' ? /\n|;/ : ',')) {
    const v = list === 'features' ? raw.trim() : raw.trim().toLowerCase()
    if (v && !props.form[list].some((x) => x.toLowerCase() === v.toLowerCase()) && props.form[list].length < max) props.form[list].push(v)
  }
  drafts.value[list] = ''
}
function onKey(e, list, max) {
  if (e.key === 'Enter' || (e.key === ',' && list !== 'features')) {
    e.preventDefault()
    add(list, max)
  } else if (e.key === 'Backspace' && !drafts.value[list] && props.form[list].length) props.form[list].pop()
}

// What's still missing, in the order the form asks for it (mirrors api/src/common/product-details.ts).
const checks = computed(() => {
  const f = props.form
  const list = [
    { ok: f.description.trim().length >= 40, text: 'A description of 40+ characters' },
    { ok: !!f.material.trim(), text: 'Material' },
    ...(clothing.value ? [{ ok: !!f.fit, text: 'Fit' }] : []),
    { ok: f.occasions.length > 0, text: 'An occasion' },
    { ok: f.seasons.length > 0, text: 'A season' },
    { ok: f.styleTags.length >= 2, text: 'Two style tags' },
    { ok: f.features.length >= 2, text: 'Two key features' },
    { ok: f.keywords.length >= 3, text: 'Three names shoppers search for', optional: true },
  ]
  return list
})
const score = computed(() => Math.round((checks.value.filter((c) => c.ok).length / checks.value.length) * 100))

const suggesting = ref(false)
async function suggest() {
  const f = props.form
  if (!f.name.trim()) return toast('Give the product a name first.', 'error')
  suggesting.value = true
  try {
    const s = await post('/admin/products/suggest-details', {
      name: f.name.trim(),
      type: f.type,
      category: f.category,
      gender: f.gender,
      description: f.description.trim() || undefined,
      colors: f.colors.map((c) => c.name),
      image: /^https?:\/\//.test(f.image.trim()) ? f.image.trim() : undefined,
    })
    // Fill what's empty; lists gain what's new. Nothing is saved until you save the product.
    let filled = 0
    for (const k of ['material', 'fitNotes', 'careNotes']) if (!f[k].trim() && s[k]) (f[k] = s[k]), filled++
    if (clothing.value && !f.fit && s.fit) (f.fit = s.fit), filled++
    if (f.description.trim().length < 40 && s.description) (f.description = s.description), filled++
    for (const k of ['occasions', 'seasons', 'styleTags', 'features', 'keywords']) {
      const extra = (s[k] ?? []).filter((v) => !f[k].some((x) => x.toLowerCase() === v.toLowerCase()))
      if (extra.length) (f[k] = [...f[k], ...extra]), filled++
    }
    toast(filled ? 'Suggestions added. Check them before saving.' : 'Nothing new to suggest: everything is filled in.')
  } catch (e) {
    toast(e.status === 503 ? e.message || 'Suggestions need the AI service with a Claude key.' : e.message, 'error')
  } finally {
    suggesting.value = false
  }
}
</script>

<template>
  <section class="panel">
    <div class="panel-head">
      <h2>For Pip and search</h2>
      <span class="score figures" :class="{ done: score === 100 }">{{ score }}% ready</span>
      <button type="button" class="btn sm" :disabled="suggesting" @click="suggest"><Icon name="sparkle" :size="15" />{{ suggesting ? 'Looking at it…' : 'Suggest with AI' }}</button>
    </div>
    <div class="panel-body">
      <p class="muted intro">Pip recommends from these, so a product can’t be saved without the required ones. “Suggest with AI” drafts them from the photo and the text; check them before saving.</p>
      <ul class="checks">
        <li v-for="c in checks" :key="c.text" :class="{ ok: c.ok }">
          <Icon :name="c.ok ? 'check' : c.optional ? 'plus' : 'alert'" :size="14" />{{ c.text }}<span v-if="c.optional" class="muted"> (recommended)</span>
        </li>
      </ul>
      <div class="grid">
        <Field id="material" label="Material" :error="errors.material" hint="What it’s made of: “100% cotton”, “leather upper, rubber sole”." class="span-2">
          <input id="material" v-model="form.material" class="input" maxlength="80" />
        </Field>
        <Field v-if="clothing" id="fit" label="Fit" :error="errors.fit">
          <select id="fit" v-model="form.fit" class="select">
            <option value="">Choose…</option>
            <option v-for="x in FITS" :key="x" :value="x">{{ label(x) }}</option>
          </select>
        </Field>
        <Field id="fitNotes" label="How it fits" optional hint="“Runs small, size up.”" :class="{ 'span-2': !clothing }">
          <input id="fitNotes" v-model="form.fitNotes" class="input" maxlength="120" />
        </Field>
        <Field id="occasions" label="Occasions" :error="errors.occasions" class="span-2">
          <div class="chips" role="group" aria-label="Occasions">
            <button v-for="x in OCCASIONS" :key="x" type="button" class="chip" :aria-pressed="form.occasions.includes(x)" @click="toggle('occasions', x)">{{ label(x) }}</button>
          </div>
        </Field>
        <Field id="seasons" label="Seasons" :error="errors.seasons" class="span-2">
          <div class="chips" role="group" aria-label="Seasons">
            <button v-for="x in SEASONS" :key="x" type="button" class="chip" :aria-pressed="form.seasons.includes(x)" @click="toggle('seasons', x)">{{ label(x) }}</button>
          </div>
        </Field>
        <Field id="styleTags" label="Style" :error="errors.styleTags" hint="At least two. Pick or type your own, then Enter." class="span-2">
          <div class="tags">
            <span v-for="t in form.styleTags" :key="t" class="tag">{{ t }}<button type="button" :aria-label="`Remove ${t}`" @click="toggle('styleTags', t)">×</button></span>
            <input id="styleTags" v-model="drafts.styleTags" class="bare" maxlength="24" placeholder="Add a style" @keydown="onKey($event, 'styleTags', 8)" @blur="add('styleTags', 8)" />
          </div>
          <div class="chips small">
            <button v-for="x in STYLES.filter((s) => !form.styleTags.includes(s))" :key="x" type="button" class="chip" @click="toggle('styleTags', x)">+ {{ x }}</button>
          </div>
        </Field>
        <Field id="features" label="Key features" :error="errors.features" hint="At least two short selling points, Enter after each: “Breathable linen”, “Hidden pocket”." class="span-2">
          <ul v-if="form.features.length" class="feature-list">
            <li v-for="(x, i) in form.features" :key="x">{{ x }}<button type="button" class="link-btn" :aria-label="`Remove ${x}`" @click="form.features.splice(i, 1)">Remove</button></li>
          </ul>
          <input id="features" v-model="drafts.features" class="input" maxlength="80" placeholder="Add a feature, then Enter" @keydown="onKey($event, 'features', 8)" @blur="add('features', 8)" />
        </Field>
        <Field id="keywords" label="Other names shoppers use" optional hint="Any language, Enter after each: “panjabi, পাঞ্জাবি, kurta”. Search and Pip match on these." class="span-2">
          <div class="tags">
            <span v-for="t in form.keywords" :key="t" class="tag">{{ t }}<button type="button" :aria-label="`Remove ${t}`" @click="toggle('keywords', t)">×</button></span>
            <input id="keywords" v-model="drafts.keywords" class="bare" maxlength="40" placeholder="Add a name" @keydown="onKey($event, 'keywords', 20)" @blur="add('keywords', 20)" />
          </div>
        </Field>
        <Field id="careNotes" label="Care" optional class="span-2">
          <input id="careNotes" v-model="form.careNotes" class="input" maxlength="200" placeholder="Machine wash cold, hang to dry" />
        </Field>
      </div>
    </div>
  </section>
</template>

<style scoped>
.panel-head {
  gap: 12px;
}
.score {
  margin-left: auto;
  color: var(--warn);
  font-weight: 700;
  font-size: 13px;
}
.score.done {
  color: var(--ok);
}
.intro {
  margin: 0 0 12px;
  font-size: 13.5px;
}
.checks {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 14px;
  margin: 0 0 16px;
  padding: 0;
  list-style: none;
  font-size: 13px;
  color: var(--warn);
}
.checks li {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.checks li.ok {
  color: var(--ok);
}
.grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
}
.span-2 {
  grid-column: span 2;
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.chip {
  padding: 5px 11px;
  border: 1px solid var(--line-strong);
  border-radius: 999px;
  background: var(--surface);
  color: var(--ink-2);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}
.chip[aria-pressed='true'] {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent);
  font-weight: 600;
}
.chips.small {
  margin-top: 6px;
}
.chips.small .chip {
  padding: 3px 9px;
  font-size: 12px;
  border-style: dashed;
}
.tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
  min-height: 42px;
  padding: 6px 8px;
  border: 1px solid var(--line-strong);
  border-radius: var(--r-control);
  background: var(--surface);
}
.tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 4px 3px 10px;
  border-radius: 999px;
  background: var(--grey);
  font-size: 13px;
}
.tag button {
  border: 0;
  background: none;
  cursor: pointer;
  color: var(--muted);
  font-size: 15px;
  line-height: 1;
}
.bare {
  flex: 1;
  min-width: 120px;
  border: 0;
  outline: 0;
  font: inherit;
  background: transparent;
}
.feature-list {
  display: grid;
  gap: 4px;
  margin: 0 0 6px;
  padding: 0;
  list-style: none;
}
.feature-list li {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  padding: 6px 10px;
  border-radius: 8px;
  background: var(--hover);
  font-size: 14px;
}
@media (max-width: 700px) {
  .grid {
    grid-template-columns: 1fr;
  }
  .span-2 {
    grid-column: auto;
  }
}
</style>
