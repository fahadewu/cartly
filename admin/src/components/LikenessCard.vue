<script setup>
import { computed } from 'vue'
import BarList from './BarList.vue'
import StackedDays from './StackedDays.vue'
import { get } from '../api.js'
import { useResource } from '../composables.js'
import { count, date } from '../format.js'
import { categoryTitle, loadMeta } from '../meta.js'

// Customers → a shopper → What they like: taste learned from behaviour, what they told us (sizes, colouring),
// their best-matching products with the reasons, what they wanted and didn't find, and the emails they got.
const props = defineProps({ id: { type: String, required: true } })
loadMeta()
const { data: d, loading, error } = useResource(() => get(`/admin/analytics/shoppers/${props.id}/likeness`))

// The categorical palette's first slots, in fixed order (validated: legend + table view carry the low-contrast two).
const SERIES = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100']
const OTHER = '#9aa1a9'
// Monk Skin Tone scale swatches (Google, CC BY 4.0), 1 lightest to 10 deepest.
const MONK = ['#f6ede4', '#f3e7db', '#f7ead0', '#eadaba', '#d7bd96', '#a07e56', '#825c43', '#604134', '#3a312a', '#292420']
const FAMILY_HEX = { black: '#111111', white: '#f4f4f2', grey: '#8a8d91', beige: '#d9c7a7', brown: '#6d4c33', red: '#c62828', pink: '#f2a7c3', orange: '#ef7d2d', yellow: '#f5d75a', green: '#2e7d4f', blue: '#1f5bff', navy: '#1c2a4a', purple: '#6a3d9a' }
const SOURCE = { search: 'Searched', chat: 'Asked Pip', soldout: 'Sold out when they looked', request: 'Requested' }
const pct = (v) => `${Math.round((Number(v) || 0) * 100)}%`

// Stored as JSON objects, whose key order Postgres doesn't keep: always sort before showing the top.
const byShare = (entries) => entries.filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1])
const styles = computed(() => byShare((d.value?.profile?.styles ?? []).map((s) => [s.label, s.share])).slice(0, 6).map(([name, value]) => ({ name, value })))
const categories = computed(() => byShare(Object.entries(d.value?.profile?.categories ?? {})).map(([k, v]) => ({ name: categoryTitle(k), value: v })))
const colours = computed(() => byShare(Object.entries(d.value?.profile?.colors ?? {})).slice(0, 8).map(([k, v]) => ({ key: k, value: v })))

// Interest over 12 weeks by style: the four biggest styles by name, the rest as "Other".
const weekKeys = computed(() => {
  const totals = {}
  for (const w of d.value?.weeks ?? []) for (const [k, v] of Object.entries(w.styles)) totals[k] = (totals[k] ?? 0) + v
  const top = Object.entries(totals).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k]) => k)
  const label = (k) => d.value?.profile?.styles.find((s) => s.key === k)?.label ?? k
  return [...top.map((k, i) => ({ key: k, label: label(k), color: SERIES[i] })), { key: 'other', label: 'Other', color: OTHER }]
})
const weekSeries = computed(() =>
  (d.value?.weeks ?? []).map((w) => {
    const row = { date: w.week }
    let named = 0
    for (const k of weekKeys.value) {
      if (k.key === 'other') continue
      row[k.key] = Math.round((w.styles[k.key] ?? 0) * 10) / 10
      named += w.styles[k.key] ?? 0
    }
    // Everything else: other styles, and products without style tags.
    row.other = Math.round(Math.max(0, w.total - named) * 10) / 10
    return row
  }),
)
const anyWeeks = computed(() => (d.value?.weeks ?? []).some((w) => w.total > 0))
const told = computed(() => d.value?.preferences)
const sizes = computed(() => Object.entries(told.value?.sizes ?? {}))
</script>

<template>
  <section class="panel likeness">
    <div class="panel-head">
      <h2>What they like</h2>
      <span v-if="d?.profile" class="muted small">From {{ count(Math.round(d.profile.evidence)) }} weighted signals · updated {{ date(d.profile.updatedAt) }}</span>
    </div>
    <p v-if="loading" class="muted pad-x">Loading…</p>
    <p v-else-if="error" class="form-error pad-x">{{ error.message }}</p>
    <template v-else-if="d">
      <p v-if="!d.user.personalise" class="muted pad-x">They switched personalised suggestions off, so nothing is learned from what they do.</p>
      <div class="grid">
        <div>
          <h3>Style mix <span class="muted small">{{ d.profile?.personalityLabel ? `· mostly ${d.profile.personalityLabel.toLowerCase()}` : '' }}</span></h3>
          <BarList :items="styles" :format="pct" empty="Not enough browsing yet." />
        </div>
        <div>
          <h3>Categories</h3>
          <BarList :items="categories" :format="pct" empty="Not enough browsing yet." />
        </div>
        <div>
          <h3>Colours they choose</h3>
          <ul v-if="colours.length" class="colours">
            <li v-for="c in colours" :key="c.key" :title="`${c.key}: ${pct(c.value)}`">
              <span class="swatch" :style="{ background: FAMILY_HEX[c.key] ?? '#999' }" />
              <span class="cname">{{ c.key }}</span>
              <span class="track"><span class="fill" :style="{ width: `${Math.max(2, (c.value / colours[0].value) * 100)}%` }" /></span>
              <span class="figures small">{{ pct(c.value) }}</span>
            </li>
          </ul>
          <p v-else class="muted small">Not enough browsing yet.</p>
          <p v-if="d.profile?.priceBand || d.profile?.traits?.length" class="chips">
            <span v-if="d.profile.priceBand" class="chip">{{ { budget: 'Budget-conscious', value: 'Value for money', premium: 'Quality-focused' }[d.profile.priceBand] }}</span>
            <span v-for="t in d.profile.traits" :key="t" class="chip">{{ t }}</span>
          </p>
        </div>
      </div>

      <div class="block">
        <h3>Interest over the last 12 weeks, by style</h3>
        <StackedDays v-if="anyWeeks" :series="weekSeries" :keys="weekKeys" :format="(v) => String(Math.round(v * 10) / 10)" label="Weighted activity per week by style (views 1, favourites and try-ons 3, bag adds 4, purchases 6)" />
        <p v-else class="muted small">No activity in the last 12 weeks.</p>
      </div>

      <div class="grid two">
        <div>
          <h3>What they told us</h3>
          <dl class="told">
            <div>
              <dt>Colouring</dt>
              <dd v-if="told?.skinTone || told?.undertone">
                <span v-if="told.skinTone" class="tone" :style="{ background: MONK[told.skinTone - 1] }" :title="`Monk scale ${told.skinTone} of 10`" />
                {{ told.skinTone ? `Tone ${told.skinTone}/10` : '' }}{{ told.skinTone && told.undertone ? ', ' : '' }}{{ told.undertone ? `${told.undertone} undertone` : '' }}
                <span class="muted small">({{ told.toneSource === 'photo' ? 'estimated from their photo, confirmed by them' : 'picked by them' }})</span>
                <span v-if="told.suits?.length" class="muted small block-line">Usually suits: {{ told.suits.join(', ') }}</span>
              </dd>
              <dd v-else class="muted">Not shared</dd>
            </div>
            <div>
              <dt>Sizes</dt>
              <dd v-if="sizes.length || told?.fit">{{ sizes.map(([t, s]) => `${t} ${s}`).join(' · ') }}{{ told?.fit ? ` · ${told.fit} fit` : '' }}</dd>
              <dd v-else class="muted">Not shared</dd>
            </div>
            <div>
              <dt>Emails</dt>
              <dd>{{ told?.marketingEmails ? `On since ${date(told.marketingSince)} (${told.emailLang === 'bn' ? 'Bangla' : 'English'})` : 'Off' }}</dd>
            </div>
          </dl>
        </div>
        <div>
          <h3>Best matches now</h3>
          <ol class="matches">
            <li v-for="m in d.matches" :key="m.id">
              <RouterLink :to="`/products/${m.id}`" class="mname">{{ m.name }}</RouterLink>
              <span class="track"><span class="fill" :style="{ width: `${m.score * 100}%` }" /></span>
              <span class="figures small">{{ pct(m.score) }}</span>
              <span v-if="m.reasons.length" class="muted small reasons">{{ m.reasons.join(' · ') }}</span>
            </li>
          </ol>
        </div>
      </div>

      <div class="grid two">
        <div>
          <h3>Wanted, not found</h3>
          <ul v-if="d.wants.length" class="rows">
            <li v-for="w in d.wants" :key="w.id">
              <span>“{{ w.text }}”</span>
              <span class="muted small">{{ SOURCE[w.source] ?? w.source }} · {{ date(w.createdAt) }}</span>
              <span class="small" :class="w.matchedAt ? 'ok' : 'muted'">
                {{ w.closedReason === 'told' ? `Told them about ${w.matchedName ?? 'it'}` : w.matchedAt ? `Found: ${w.matchedName ?? 'a match'}` : 'Still open' }}
              </span>
            </li>
          </ul>
          <p v-else class="muted small">Nothing yet: searches with no results, Pip chats where nothing fitted and sold-out items they looked at show here.</p>
        </div>
        <div>
          <h3>Emails</h3>
          <ul v-if="d.emails.length" class="rows">
            <li v-for="e in d.emails" :key="e.id">
              <span>{{ e.subject }}</span>
              <span class="muted small">{{ e.kindLabel }} · {{ e.status }}{{ e.sentAt ? ` ${date(e.sentAt)}` : '' }}{{ e.clicks ? ` · ${e.clicks} click${e.clicks === 1 ? '' : 's'}` : '' }}</span>
            </li>
          </ul>
          <p v-else class="muted small">No emails yet.</p>
        </div>
      </div>
    </template>
  </section>
</template>

<style scoped>
.likeness {
  margin-bottom: 18px;
}
.pad-x {
  padding: 0 18px 14px;
}
.grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 22px;
  padding: 4px 18px 16px;
}
.grid.two {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}
.block {
  padding: 4px 18px 16px;
}
h3 {
  margin: 0 0 10px;
  font-size: 14px;
}
.colours,
.matches,
.rows {
  display: grid;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.colours li {
  display: grid;
  grid-template-columns: 14px 64px 1fr 40px;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}
.swatch,
.tone {
  display: inline-block;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.15);
  vertical-align: -2px;
}
.cname {
  text-transform: capitalize;
}
.track {
  height: 8px;
  border-radius: 999px;
  background: var(--grey);
  overflow: hidden;
}
.fill {
  display: block;
  height: 100%;
  border-radius: 999px;
  background: var(--accent);
}
.matches li {
  display: grid;
  grid-template-columns: minmax(0, 1.4fr) 1fr 40px;
  align-items: center;
  gap: 4px 10px;
}
.mname {
  overflow: hidden;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.reasons {
  grid-column: 1 / -1;
}
.rows li {
  display: grid;
  gap: 2px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--line);
}
.ok {
  color: var(--ok);
}
.told {
  display: grid;
  gap: 10px;
  margin: 0;
}
.told dt {
  color: var(--muted);
  font-size: 12px;
}
.told dd {
  margin: 2px 0 0;
}
.block-line {
  display: block;
  margin-top: 2px;
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 12px 0 0;
}
.chip {
  padding: 3px 10px;
  border-radius: 999px;
  background: var(--grey);
  font-size: 12px;
}
@media (max-width: 900px) {
  .grid,
  .grid.two {
    grid-template-columns: 1fr;
  }
}
</style>
