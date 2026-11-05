<script setup>
import { ref, computed } from 'vue'
import PageHeader from '../components/PageHeader.vue'
import ProductCard from '../components/ProductCard.vue'
import QtyStepper from '../components/QtyStepper.vue'
import OrderSummary from '../components/OrderSummary.vue'
import Icon from '../components/Icon.vue'
import { price } from '../data.js'
import { products } from '../catalog.js'
import { useShop } from '../store.js'
import { toast } from '../toast.js'

const { state, lines, cartCount, subtotal, discount, shippingFor, changeQty, removeLine, applyPromo, removePromo, isLiked, toggleLike } = useShop()

const code = ref('')
const codeError = ref('')
const shipping = computed(() => shippingFor('standard'))
const total = computed(() => subtotal.value - discount.value + shipping.value)
const toFree = computed(() => state.cart.freeShippingRemaining)

const suggestions = computed(() => {
  const inCart = new Set(lines.value.map((l) => l.id))
  return [...products].filter((p) => !inCart.has(p.id)).sort((a, b) => b.popularity - a.popularity).slice(0, 4)
})

const applying = ref(false)
async function apply() {
  codeError.value = ''
  if (!code.value.trim() || applying.value) return
  applying.value = true
  const error = await applyPromo(code.value)
  applying.value = false
  if (error) return (codeError.value = `${error} Try WELCOME20.`)
  toast(`Code ${state.cart.promoCode} applied`)
  code.value = ''
}

async function saveForLater(line) {
  if (!isLiked(line.id)) toggleLike(line.id)
  if (await removeLine(line.key)) toast('Moved to favourites')
}
</script>

<template>
  <div>
    <PageHeader
      title="Your cart"
      :subtitle="cartCount ? `${cartCount} item${cartCount === 1 ? '' : 's'}` : undefined"
      :crumbs="[{ label: 'Explore', to: '/' }, { label: 'Cart' }]"
    />

    <div class="page">
      <div v-if="!lines.length" class="empty">
        <span class="empty-icon"><Icon name="bag" :size="28" /></span>
        <h3>Your cart is empty</h3>
        <p>Looks like you haven’t added anything yet. Explore our latest drops and find something you love.</p>
        <RouterLink to="/shop" class="btn-primary sm">Start shopping</RouterLink>
      </div>

      <div v-else class="layout">
        <section>
          <div class="ship" :class="{ done: !toFree }">
            <Icon :name="toFree ? 'bag' : 'check'" :size="18" />
            <span>{{ toFree ? `You’re ${price(toFree)} away from free delivery` : 'Nice! Your order ships free' }}</span>
          </div>

          <TransitionGroup tag="ul" name="list" class="lines">
            <li v-for="line in lines" :key="line.key" class="line">
              <RouterLink :to="`/product/${line.id}`" class="thumb"><img :src="line.product.image" :alt="line.product.name" /></RouterLink>
              <div class="info">
                <RouterLink :to="`/product/${line.id}`" class="name">{{ line.product.name }}</RouterLink>
                <span class="muted">{{ line.color }} · {{ line.size === 'One size' ? line.size : `Size ${line.size}` }}</span>
                <span class="unit">{{ price(line.product.price) }} each</span>
                <div class="line-actions">
                  <button @click="saveForLater(line)"><Icon name="heart" :size="14" />Save for later</button>
                  <button class="danger" @click="removeLine(line.key)"><Icon name="close" :size="14" />Remove</button>
                </div>
              </div>
              <div class="right">
                <b>{{ price(line.product.price * line.qty) }}</b>
                <QtyStepper :value="line.qty" small @dec="changeQty(line.key, -1)" @inc="changeQty(line.key, 1)" />
              </div>
            </li>
          </TransitionGroup>
        </section>

        <aside class="box summary">
          <h2>Order summary</h2>
          <OrderSummary :subtotal="subtotal" :discount="discount" :shipping="shipping" :total="total" :promo="state.cart.promoCode" />

          <form class="promo" @submit.prevent="apply">
            <input v-model="code" placeholder="Promo code" aria-label="Promo code" />
            <button class="btn-secondary sm" type="submit">Apply</button>
          </form>
          <p v-if="codeError" class="code-error">{{ codeError }}</p>
          <button v-if="state.cart.promoCode" class="link remove-code" @click="removePromo">Remove code {{ state.cart.promoCode }}</button>

          <RouterLink to="/checkout" class="btn-primary checkout">Checkout · {{ price(total) }}</RouterLink>
          <RouterLink to="/shop" class="continue">Continue shopping</RouterLink>
        </aside>
      </div>

      <div class="section-title"><h2>{{ lines.length ? 'Complete your order' : 'Trending now' }}</h2></div>
      <div class="product-grid">
        <ProductCard v-for="p in suggestions" :key="p.id" :product="p" compact />
      </div>
    </div>
  </div>
</template>

<style scoped>
.layout {
  display: grid;
  grid-template-columns: 1fr 380px;
  gap: 28px;
  align-items: start;
}
.ship {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 16px 20px;
  margin-bottom: 12px;
  border-radius: 20px;
  background: var(--peach);
  font-size: 14px;
  font-weight: 500;
}
.ship.done {
  background: #e7f8ef;
  color: #067647;
}
.lines {
  position: relative;
  margin: 0;
  padding: 0;
  list-style: none;
}
.line {
  display: flex;
  gap: 18px;
  padding: 18px 0;
  border-bottom: 1px solid var(--line);
}
.thumb {
  flex-shrink: 0;
  width: 120px;
  height: 120px;
  border-radius: 24px;
  background: var(--card);
  overflow: hidden;
}
.thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  mix-blend-mode: multiply;
}
.info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.name {
  font-size: 17px;
  font-weight: 500;
  color: inherit;
  text-decoration: none;
}
.name:hover {
  color: var(--blue);
}
.info .muted,
.unit {
  font-size: 13px;
}
.line-actions {
  display: flex;
  gap: 16px;
  margin-top: auto;
}
.line-actions button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--muted);
}
.line-actions button:hover {
  color: var(--ink);
}
.line-actions .danger:hover {
  color: #d92d20;
}
.right {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  justify-content: space-between;
}
.right b {
  font-size: 17px;
  font-weight: 600;
}

.summary {
  position: sticky;
  top: 24px;
}
.promo {
  display: flex;
  gap: 8px;
  margin-top: 22px;
}
.promo input {
  flex: 1;
  min-width: 0;
  height: 44px;
  padding: 0 18px;
  border: 1.5px solid transparent;
  border-radius: var(--r-pill);
  background: var(--chip);
  font: inherit;
  font-size: 14px;
  text-transform: uppercase;
  outline: none;
}
.promo input:focus {
  border-color: var(--blue);
  background: #fff;
}
.code-error {
  margin-top: 8px;
  font-size: 13px;
  color: #d92d20;
}
.remove-code {
  margin-top: 8px;
  font-size: 13px;
}
.checkout {
  width: 100%;
  margin-top: 22px;
}
.continue {
  display: block;
  margin-top: 14px;
  text-align: center;
  font-size: 14px;
  color: var(--muted);
}

.list-move,
.list-enter-active,
.list-leave-active {
  transition: all 0.3s ease;
}
.list-enter-from,
.list-leave-to {
  opacity: 0;
  transform: translateX(-20px);
}
.list-leave-active {
  position: absolute;
  width: 100%;
}

@media (max-width: 1100px) {
  .layout {
    grid-template-columns: 1fr;
  }
  .summary {
    position: static;
  }
}
@media (max-width: 560px) {
  .thumb {
    width: 84px;
    height: 84px;
  }
  .line {
    flex-wrap: wrap;
  }
  .right {
    flex-direction: row;
    align-items: center;
    width: 100%;
  }
}
</style>
