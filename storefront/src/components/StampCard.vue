<script setup>
import { onMounted, ref } from 'vue'
import Icon from './Icon.vue'
import { api } from '../api.js'
import { useShop } from '../store.js'
import { toast } from '../toast.js'

// The stamp card (only when the store has switched it on): a stamp per delivered order, and a code of their
// own when it's full. Each card starts with a few stamps on it already.
const card = ref(null)
onMounted(() => api('/me/stamps').then((c) => (card.value = c)).catch(() => {}))
const { applyPromo } = useShop()
async function use(code) {
  const err = await applyPromo(code)
  toast(err || `${code} is on your cart`, err ? 'error' : undefined)
}
</script>

<template>
  <section v-if="card?.enabled" class="stamps">
    <div class="head">
      <div>
        <b>Your stamp card</b>
        <small>{{ card.toGo === 1 ? 'One more delivered order' : `${card.toGo} more delivered orders` }} for {{ card.percentOff }}% off your next order.<template v-if="card.headStart"> The first {{ card.headStart }} are on us.</template></small>
      </div>
    </div>
    <ol class="row" :aria-label="`${card.filled} of ${card.slots} stamps`">
      <li v-for="n in card.slots" :key="n" :class="{ on: n <= card.filled, gift: n <= card.headStart, last: n === card.slots }">
        <Icon v-if="n === card.slots" name="gift" :size="16" />
        <Icon v-else-if="n <= card.filled" name="check" :size="15" />
      </li>
    </ol>
    <ul v-if="card.rewards.some((r) => !r.used)" class="rewards">
      <li v-for="r in card.rewards.filter((x) => !x.used)" :key="r.code">
        <span><b>{{ r.code }}</b> · {{ r.percentOff }}% off one order, just for you</span>
        <button class="btn-primary sm" @click="use(r.code)">Use it</button>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.stamps {
  display: flex;
  flex-direction: column;
  gap: 14px;
  margin-bottom: 18px;
  padding: 20px 22px;
  border-radius: var(--r-card);
  background: var(--butter);
}
.head b {
  display: block;
  font-size: 17px;
  font-weight: 600;
}
.head small {
  font-size: 14px;
  color: #4b5058;
}
.row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.row li {
  display: grid;
  place-items: center;
  width: 38px;
  height: 38px;
  border: 2px dashed rgba(18, 20, 23, 0.25);
  border-radius: 50%;
  color: #fff;
}
.row li.on {
  border: 0;
  background: var(--ink);
}
.row li.on.gift {
  background: var(--blue);
}
.row li.last {
  border-style: solid;
  color: var(--ink);
  background: #fff;
}
.rewards {
  margin: 0;
  padding: 0;
  list-style: none;
}
.rewards li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px 10px 16px;
  border-radius: 18px;
  background: #fff;
  font-size: 14px;
}
.rewards .btn-primary {
  padding: 0 18px;
}
</style>
