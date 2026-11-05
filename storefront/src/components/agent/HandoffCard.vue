<script setup>
import { computed, onMounted } from 'vue'
import Icon from '../Icon.vue'
import { support, loadSupport } from '../../support.js'
import { useShop } from '../../store.js'

// Pip's hand-off: when something has gone wrong, a person on the team, one tap away.
const { state } = useShop()
onMounted(loadSupport)
const order = computed(() => state.orders[0]?.id ?? null)
const message = computed(() => `Hi Cartly, I need help${order.value ? ` with order ${order.value}` : ''}.`)
const wa = computed(() => support.whatsapp && `https://wa.me/${support.whatsapp}?text=${encodeURIComponent(message.value)}`)
const tel = computed(() => support.phone && `tel:${support.phone.replace(/[^\d+]/g, '')}`)
</script>

<template>
  <div v-if="support.whatsapp || support.phone" class="handoff">
    <b><Icon name="user" :size="15" />Talk to a person</b>
    <small v-if="support.hours">{{ support.hours }}</small>
    <div class="ways">
      <a v-if="wa" :href="wa" target="_blank" rel="noopener" class="wa">WhatsApp us</a>
      <a v-if="tel" :href="tel" class="call"><Icon name="phone" :size="15" />{{ support.phone }}</a>
    </div>
    <small v-if="order" class="muted">We’ll mention order {{ order }} so you don’t have to explain twice.</small>
  </div>
</template>

<style scoped>
.handoff {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 8px;
  padding: 14px;
  border-radius: 18px;
  background: #fff;
  border: 1.5px solid var(--line);
}
.handoff b {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 14px;
  font-weight: 600;
}
.handoff small {
  font-size: 12px;
  color: var(--muted);
}
.ways {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 4px;
}
.ways a {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 38px;
  padding: 0 14px;
  border-radius: var(--r-pill);
  font-size: 14px;
  font-weight: 500;
  text-decoration: none;
}
.wa {
  background: #25d366;
  color: #08331a;
}
.call {
  background: var(--chip);
  color: var(--ink);
}
</style>
