<script setup>
import { computed } from 'vue'
import BarList from './BarList.vue'
import { count, date, money } from '../format.js'

// Analytics → Interests & emails: what shoppers wanted and the store didn't have, what they told us (only counts and
// groups of at least `minGroup` shoppers), the colours they lean to, and how the outreach emails do.
const props = defineProps({ d: { type: Object, required: true } })
const SOURCE = { search: 'Searches with no results', chat: 'Pip chats where nothing fitted', soldout: 'Sold-out products they looked at', request: 'Product requests' }
const share = (v) => `${Math.round((Number(v) || 0) * 1000) / 10}%`
const rate = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '—')
const colours = computed(() => props.d.colours.all.shares.map((c) => ({ name: c.family, value: c.share })))
const FAMILY_HEX = { black: '#111111', white: '#f4f4f2', grey: '#8a8d91', beige: '#d9c7a7', brown: '#6d4c33', red: '#c62828', pink: '#f2a7c3', orange: '#ef7d2d', yellow: '#f5d75a', green: '#2e7d4f', blue: '#1f5bff', navy: '#1c2a4a', purple: '#6a3d9a' }
</script>

<template>
  <div class="interests">
    <div class="tiles">
      <div class="panel pad tile"><span class="muted small">Shoppers with emails on</span><strong class="figures">{{ count(d.audience.opted) }}</strong><span class="muted small">of {{ count(d.audience.shoppers) }} ({{ rate(d.audience.opted, d.audience.shoppers) }})</span></div>
      <div class="panel pad tile"><span class="muted small">Shared their colouring</span><strong class="figures">{{ count(d.audience.colouring) }}</strong></div>
      <div class="panel pad tile"><span class="muted small">Shared their sizes</span><strong class="figures">{{ count(d.audience.sizes) }}</strong></div>
      <div class="panel pad tile"><span class="muted small">Wants answered by a new product</span><strong class="figures">{{ count(d.wants.matched) }}</strong><span class="muted small">in the last {{ d.days }} days</span></div>
    </div>

    <div class="cols">
      <section class="panel pad">
        <h2>Wanted, not found</h2>
        <p class="muted small">What shoppers looked for that the store didn't have, most shoppers first. Worth sourcing.</p>
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th>They looked for</th><th class="num">Shoppers</th><th class="num">Times</th><th>Last</th></tr></thead>
            <tbody>
              <tr v-for="w in d.wants.topOpen" :key="w.text"><td>“{{ w.text }}”</td><td class="num">{{ count(w.shoppers) }}</td><td class="num">{{ count(w.times) }}</td><td class="small">{{ date(w.last) }}</td></tr>
              <tr v-if="!d.wants.topOpen.length"><td colspan="4" class="muted">Nothing yet.</td></tr>
            </tbody>
          </table>
        </div>
        <BarList class="sources" :items="d.wants.bySource.map((s) => ({ name: SOURCE[s.source] ?? s.source, value: s.total, note: `${s.matched} answered since` }))" :format="count" empty="No wants recorded in this period." />
      </section>

      <section class="panel pad">
        <h2>Colours shoppers lean to</h2>
        <p class="muted small">Share of attention by colour family, from what shoppers view, favourite, try on and buy.</p>
        <ul v-if="colours.length" class="legend">
          <li v-for="c in colours" :key="c.name"><span class="swatch" :style="{ background: FAMILY_HEX[c.name] }" />{{ c.name }}</li>
        </ul>
        <BarList :items="colours" :format="share" empty="Not enough browsing yet." />
        <template v-for="g in d.colours.byUndertone" :key="g.undertone">
          <h3>Shoppers with a {{ g.undertone }} undertone ({{ g.shoppers }})</h3>
          <BarList :items="g.shares.map((c) => ({ name: c.family, value: c.share }))" :format="share" :limit="5" />
        </template>
        <p v-if="!d.colours.byUndertone.length" class="muted small">By undertone once at least {{ d.minGroup }} shoppers in a group have shared their colouring (smaller groups stay hidden).</p>
      </section>
    </div>

    <section class="panel pad">
      <h2>Emails</h2>
      <p class="muted small">Drafted in the last {{ d.days }} days. Ordered: an order within 7 days of the email.</p>
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>Kind</th><th class="num">Drafted</th><th class="num">Sent</th><th class="num">Clicked</th><th class="num">Ordered</th><th class="num">Order value</th></tr></thead>
          <tbody>
            <tr v-for="e in d.emails" :key="e.kind">
              <td>{{ e.label }}</td>
              <td class="num">{{ count(e.drafted) }}</td>
              <td class="num">{{ count(e.sent) }}</td>
              <td class="num">{{ count(e.clicked) }} <span class="muted small">{{ rate(e.clicked, e.sent) }}</span></td>
              <td class="num">{{ count(e.ordered) }} <span class="muted small">{{ rate(e.ordered, e.sent) }}</span></td>
              <td class="num">{{ money(e.revenue) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>

<style scoped>
.interests {
  display: grid;
  gap: 16px;
}
.tiles {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
}
.tile {
  display: grid;
  gap: 4px;
}
.tile strong {
  font-size: 26px;
}
.cols {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}
h2 {
  margin: 0 0 4px;
  font-size: 16px;
}
h3 {
  margin: 16px 0 8px;
  font-size: 13px;
  text-transform: none;
}
.sources {
  margin-top: 14px;
}
.legend {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 12px;
  margin: 8px 0 10px;
  padding: 0;
  list-style: none;
  font-size: 12px;
  text-transform: capitalize;
}
.swatch {
  display: inline-block;
  width: 10px;
  height: 10px;
  margin-right: 5px;
  border-radius: 50%;
  box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.15);
}
@media (max-width: 900px) {
  .tiles {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .cols {
    grid-template-columns: 1fr;
  }
}
</style>
