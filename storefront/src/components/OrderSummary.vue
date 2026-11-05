<script setup>
import { money } from '../data.js'

defineProps({
  subtotal: { type: Number, required: true },
  discount: { type: Number, default: 0 },
  shipping: { type: Number, default: null }, // null = calculated at checkout
  total: { type: Number, required: true },
  promo: String,
})
</script>

<template>
  <dl class="summary">
    <div><dt>Subtotal</dt><dd>{{ money(subtotal) }}</dd></div>
    <div v-if="discount" class="discount"><dt>Discount <small v-if="promo">{{ promo }}</small></dt><dd>−{{ money(discount) }}</dd></div>
    <div>
      <dt>Delivery</dt>
      <dd>{{ shipping === null ? 'At checkout' : shipping === 0 ? 'Free' : money(shipping) }}</dd>
    </div>
    <div class="total"><dt>Total</dt><dd>{{ money(total) }}</dd></div>
  </dl>
</template>

<style scoped>
.summary {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin: 0;
}
.summary div {
  display: flex;
  justify-content: space-between;
  font-size: 15px;
}
dt {
  color: var(--muted);
}
dd {
  margin: 0;
  font-weight: 500;
}
.discount dd {
  color: #067647;
}
small {
  margin-left: 6px;
  padding: 2px 8px;
  border-radius: var(--r-pill);
  background: #e7f8ef;
  color: #067647;
  font-size: 11px;
  font-weight: 600;
}
.total {
  margin-top: 6px;
  padding-top: 16px;
  border-top: 1px solid var(--line);
  font-size: 18px !important;
}
.total dt {
  color: var(--ink);
  font-weight: 500;
}
.total dd {
  font-weight: 600;
}
</style>
