<script setup>
import { onMounted, ref } from 'vue'
import PageHeader from '../components/PageHeader.vue'
import Icon from '../components/Icon.vue'
import { delivery } from '../catalog.js'
import { paymentMethods, PAY_LABEL } from '../store.js'
import { hasSupport, loadSupport, support } from '../support.js'

// The Cartly promise: honest selling, said out loud. Every line here is something the store's code already
// does; if one stops being true, change the code or take the line out. Shoppers who were burned by advance-
// payment scams want control and protection more than slogans, and pressure tricks (fake timers, fake
// scarcity) make newer online shoppers feel manipulated (Mathur et al. 2019; Luguri & Strahilevitz 2021).
const methods = ref([])
onMounted(loadSupport)
onMounted(() =>
  paymentMethods()
    .then((m) => (methods.value = (m?.methods ?? m ?? []).filter((x) => x.id !== 'demo').map((x) => PAY_LABEL[x.id] ?? x.label)))
    .catch(() => {}),
)

const PROMISES = [
  {
    icon: 'alert',
    title: 'No fake timers, no fake “only 2 left”',
    body: '“Only N left” appears only when that’s the real stock. The only deadlines we show are real ones: the last day to order for delivery before a festival, worked out from our own delivery times.',
  },
  {
    icon: 'check',
    title: 'Reviews you can read straight',
    body: 'The star bars are real counts, never a curve. “Verified purchase” appears only when the reviewer had that item delivered. Fit notes (“runs small”) come from what shoppers reported and returned.',
  },
  {
    icon: 'bag',
    title: 'The price you see is the price you pay',
    body: 'Delivery is shown before you pay, and there are no extra fees at checkout, for cash on delivery or any wallet.',
  },
  {
    icon: 'truck',
    title: 'Handed over to you, not left at the gate',
    body: 'Our own riders hand your order over only with the 4-digit code on your order page.',
  },
  {
    icon: 'refresh',
    title: 'Returns that don’t argue',
    body: null, // filled in with the store's return window below
  },
  {
    icon: 'lock',
    title: 'Your photos stay yours',
    body: 'Try-on photos are never stored. The quick preview never leaves your phone. A look you share with family is deleted after 7 days, or the moment you stop sharing.',
  },
  {
    icon: 'sparkle',
    title: 'Pip works for you',
    // The hand-off line only shows once the store has set a support contact (it's only true then).
    body: 'Pip only suggests what we actually sell, and never says it knows things about you it was only guessing.',
    human: ' When something has gone wrong, it hands you to a person on our team.',
  },
]
</script>

<template>
  <div>
    <PageHeader title="The Cartly promise" subtitle="Honest shopping, in writing. If we break one of these, tell us." :crumbs="[{ label: 'Explore', to: '/' }, { label: 'Our promise' }]" />
    <div class="page">
      <ol class="promises">
        <li v-for="p in PROMISES" :key="p.title">
          <span class="ic"><Icon :name="p.icon" :size="20" /></span>
          <div>
            <h2>{{ p.title }}</h2>
            <p v-if="p.body">{{ p.body }}<template v-if="p.human && support.loaded && hasSupport()">{{ p.human }}</template></p>
            <p v-else>
              <template v-if="delivery.returnsDays">Changed your mind or it doesn’t fit? Return it within {{ delivery.returnsDays }} days of delivery and get your money back for the item.</template>
              <template v-else>Something wrong with your order? Tell us and we’ll put it right.</template>
            </p>
          </div>
        </li>
        <li v-if="methods.length">
          <span class="ic"><Icon name="cart" :size="20" /></span>
          <div>
            <h2>Pay the way you trust</h2>
            <p>{{ methods.join(', ') }}. Online payments are confirmed with the payment provider before your order is marked paid.</p>
          </div>
        </li>
      </ol>
    </div>
  </div>
</template>

<style scoped>
.promises {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 16px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.promises li {
  display: flex;
  gap: 16px;
  padding: 22px;
  border-radius: 28px;
  background: var(--card);
}
.ic {
  flex: none;
  display: grid;
  place-items: center;
  width: 44px;
  height: 44px;
  border-radius: 14px;
  background: var(--mint);
}
h2 {
  font-size: 17px;
  font-weight: 600;
}
p {
  margin-top: 6px;
  font-size: 14px;
  line-height: 1.6;
  color: #4b5058;
}
</style>
