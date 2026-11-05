<script setup>
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import Icon from './Icon.vue'
import QtyStepper from './QtyStepper.vue'
import { useShop } from '../store.js'
import { price } from '../data.js'
import { delivery } from '../catalog.js'

const { state, lines, subtotal, changeQty, removeLine } = useShop()
const router = useRouter()
const toFree = computed(() => state.cart.freeShippingRemaining)

function go(name) {
  state.cartOpen = false
  router.push({ name })
}
</script>

<template>
  <Transition name="fade">
    <div v-if="state.cartOpen" class="scrim" @click="state.cartOpen = false" />
  </Transition>
  <Transition name="drawer">
    <aside v-if="state.cartOpen" class="drawer" aria-label="Cart" @keydown.esc="state.cartOpen = false">
      <header>
        <h2>Your cart</h2>
        <button class="icon-btn" aria-label="Close cart" @click="state.cartOpen = false">
          <Icon name="close" />
        </button>
      </header>

      <div v-if="lines.length" class="ship" :class="{ done: !toFree }">
        <p>{{ toFree ? `Add ${price(toFree)} more for free delivery` : 'You’ve unlocked free delivery' }}</p>
        <div class="meter"><i :style="{ width: `${Math.min(100, ((delivery.freeShippingOver - toFree) / delivery.freeShippingOver) * 100)}%` }" /></div>
      </div>

      <div v-if="!lines.length" class="empty-cart">
        <span class="empty-icon"><Icon name="bag" :size="28" /></span>
        <p>Your cart is empty. Tap a price to add something.</p>
        <button class="btn-secondary sm" @click="go('shop')">Browse products</button>
      </div>

      <ul v-else>
        <li v-for="line in lines" :key="line.key">
          <RouterLink :to="`/product/${line.id}`" @click="state.cartOpen = false">
            <img :src="line.product.image" alt="" />
          </RouterLink>
          <div class="info">
            <b>{{ line.product.name }}</b>
            <span>{{ line.color }} · {{ line.size }}</span>
            <span class="line-price">{{ price(line.product.price * line.qty) }}</span>
          </div>
          <div class="actions">
            <QtyStepper :value="line.qty" small @dec="changeQty(line.key, -1)" @inc="changeQty(line.key, 1)" />
            <button class="remove" @click="removeLine(line.key)">Remove</button>
          </div>
        </li>
      </ul>

      <footer v-if="lines.length">
        <div class="total"><span>Subtotal</span><b>{{ price(subtotal) }}</b></div>
        <div class="buttons">
          <button class="btn-secondary" @click="go('cart')">View cart</button>
          <button class="btn-primary" @click="go('checkout')">Checkout</button>
        </div>
      </footer>
    </aside>
  </Transition>
</template>

<style scoped>
.scrim {
  position: fixed;
  inset: 0;
  z-index: 50;
  background: rgba(18, 20, 23, 0.3);
}
.drawer {
  position: fixed;
  top: 16px;
  right: 16px;
  bottom: 16px;
  z-index: 51;
  display: flex;
  flex-direction: column;
  width: min(420px, calc(100vw - 32px));
  padding: 28px;
  border-radius: var(--r-card);
  background: #fff;
  box-shadow: 0 30px 80px rgba(0, 0, 0, 0.2);
}
header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 20px;
}
header .icon-btn {
  background: var(--chip);
}
h2 {
  font-size: 24px;
  font-weight: 500;
}

.ship {
  padding: 14px 18px;
  margin-bottom: 8px;
  border-radius: 20px;
  background: var(--peach);
  font-size: 13px;
}
.ship.done {
  background: #e7f8ef;
}
.meter {
  height: 6px;
  margin-top: 10px;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.8);
  overflow: hidden;
}
.meter i {
  display: block;
  height: 100%;
  border-radius: 4px;
  background: var(--blue);
  transition: width 0.4s ease;
}
.done .meter i {
  background: #17b26a;
}

.empty-cart {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  text-align: center;
  color: var(--muted);
}
.empty-icon {
  display: grid;
  place-items: center;
  width: 64px;
  height: 64px;
  border-radius: 22px;
  background: var(--chip);
  color: var(--blue);
}

ul {
  flex: 1;
  margin: 0;
  padding: 0;
  list-style: none;
  overflow-y: auto;
}
li {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 14px 0;
  border-bottom: 1px solid var(--line);
}
li img {
  width: 68px;
  height: 68px;
  border-radius: 18px;
  object-fit: cover;
  background: var(--card);
}
.info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
  font-size: 14px;
}
.info b {
  font-weight: 500;
}
.info span {
  font-size: 13px;
  color: var(--muted);
}
.info .line-price {
  color: var(--ink);
  font-weight: 500;
}
.actions {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 6px;
}
.remove {
  font-size: 12px;
  color: var(--muted);
}
.remove:hover {
  color: #d92d20;
}

footer {
  margin-top: auto;
  padding-top: 20px;
}
.total {
  display: flex;
  justify-content: space-between;
  margin-bottom: 16px;
  font-size: 17px;
}
.total b {
  font-weight: 600;
}
.buttons {
  display: grid;
  grid-template-columns: 1fr 1.4fr;
  gap: 10px;
}
.buttons .btn-primary {
  height: 52px;
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.25s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
.drawer-enter-active,
.drawer-leave-active {
  transition: transform 0.35s cubic-bezier(0.2, 0.8, 0.2, 1);
}
.drawer-enter-from,
.drawer-leave-to {
  transform: translateX(110%);
}
</style>
