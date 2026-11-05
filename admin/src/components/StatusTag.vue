<script setup>
import { computed } from 'vue'

// Status labels shaped like the little tags tied to parcels and price tickets.
const props = defineProps({ status: { type: String, required: true }, label: String })
const LOOK = {
  PENDING_PAYMENT: ['Awaiting payment', 'peach'],
  PROCESSING: ['Processing', 'butter'],
  SHIPPED: ['Shipped', 'sky'],
  DELIVERED: ['Delivered', 'mint'],
  CANCELLED: ['Cancelled', 'rose'],
  RECEIVED: ['Received', 'grey'],
  SOURCING: ['Sourcing', 'peach'],
  FOUND: ['Found', 'mint'],
  UNAVAILABLE: ['Unavailable', 'rose'],
  ACTIVE: ['Active', 'mint'],
  ARCHIVED: ['Archived', 'grey'],
  LOW: ['Low stock', 'butter'],
  OUT: ['Sold out', 'rose'],
  ADMIN: ['Admin', 'sky'],
  MANAGER: ['Manager', 'mint'],
  SUPPORT: ['Support', 'peach'],
  MERCHANDISER: ['Merchandiser', 'butter'],
  ANALYST: ['Analyst', 'grey'],
  DISABLED: ['Turned off', 'rose'],
  TEMP_PASSWORD: ['Must set password', 'butter'],
  CUSTOMER: ['Customer', 'grey'],
  LIVE: ['Live', 'mint'],
  PAUSED: ['Paused', 'grey'],
  OK: ['Healthy', 'mint'],
  DOWN: ['Unreachable', 'rose'],
  // Payments
  UNPAID: ['Unpaid', 'butter'],
  PENDING: ['Pending', 'peach'],
  PAID: ['Paid', 'mint'],
  FAILED: ['Failed', 'rose'],
  EXPIRED: ['Expired', 'grey'],
  REFUNDED: ['Refunded', 'sky'],
  REFUND_DUE: ['Refund due', 'rose'],
  SANDBOX: ['Sandbox', 'butter'],
  READY: ['Set up', 'mint'],
  NOT_SET_UP: ['Not set up', 'grey'],
  INCOMPLETE: ['Needs details', 'butter'],
  // Deliveries
  BOOKED: ['Booked', 'butter'],
  PICKED_UP: ['Picked up', 'sky'],
  IN_TRANSIT: ['In transit', 'sky'],
  OUT_FOR_DELIVERY: ['Out for delivery', 'peach'],
  FAILED_ATTEMPT: ['Attempt failed', 'rose'],
  RETURNING: ['Returning', 'rose'],
  RETURNED: ['Returned', 'grey'],
  RIDER: ['Rider', 'peach'],
  INACTIVE: ['Inactive', 'grey'],
  OFF: ['Off', 'grey'],
  // Returns
  RT_REQUESTED: ['To decide', 'butter'],
  RT_APPROVED: ['Coming back', 'sky'],
  RT_REJECTED: ['Turned down', 'rose'],
  RT_RECEIVED: ['To refund', 'peach'],
  RT_REFUNDED: ['Refunded', 'mint'],
  RT_CANCELLED: ['Withdrawn', 'grey'],
}
const look = computed(() => LOOK[props.status] ?? [props.status, 'grey'])
</script>

<template>
  <span class="tag" :class="look[1]">{{ label ?? look[0] }}</span>
</template>

<style scoped>
.tag {
  --fill: var(--grey);
  position: relative;
  display: inline-flex;
  align-items: center;
  height: 22px;
  padding: 0 9px 0 17px;
  border-radius: var(--r-tag);
  background: var(--fill);
  color: #1d2126;
  font-size: 12px;
  font-weight: 700;
  line-height: 1;
  white-space: nowrap;
  /* Clipped point on the left, like a luggage tag. */
  clip-path: polygon(7px 0, 100% 0, 100% 100%, 7px 100%, 0 50%);
}
/* The punched hole. */
.tag::before {
  content: '';
  position: absolute;
  left: 7px;
  top: 50%;
  width: 5px;
  height: 5px;
  margin-top: -2.5px;
  border-radius: 50%;
  background: var(--surface);
  box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.1);
}
.butter {
  --fill: var(--butter);
}
.sky {
  --fill: var(--sky);
}
.mint {
  --fill: var(--mint);
}
.rose {
  --fill: var(--rose);
}
.peach {
  --fill: var(--peach);
}
.grey {
  --fill: var(--grey);
}
</style>
