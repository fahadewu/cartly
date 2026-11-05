<script setup>
import { computed, ref, watch } from 'vue'

// A faithful copy of the storefront's product card, so edits can be judged before saving.
const props = defineProps({ product: { type: Object, required: true } })
const broken = ref(false)
watch(() => props.product.image, () => (broken.value = false))
const discount = computed(() => {
  const { price, compareAt } = props.product
  return compareAt > price && price > 0 ? Math.round((1 - price / compareAt) * 100) : 0
})
const price = (n) => `$${Number(n || 0).toFixed(Number.isInteger(Number(n)) ? 0 : 2)}`
</script>

<template>
  <article class="card" aria-label="Storefront preview">
    <div class="top">
      <div class="dots">
        <span v-for="c in product.colors" :key="c.name + c.hex" class="cdot" :style="{ background: c.hex }" :title="c.name" />
      </div>
      <span class="heart" aria-hidden="true">
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 20s-7-4.35-7-10a4 4 0 0 1 7-2.65A4 4 0 0 1 19 10c0 5.65-7 10-7 10Z" /></svg>
      </span>
    </div>
    <span v-if="discount" class="badge sale">−{{ discount }}%</span>
    <span v-else-if="product.isNew" class="badge new">New</span>
    <div class="photo">
      <img v-if="product.image && !broken" :src="product.image" alt="" @error="broken = true" />
      <p v-else class="no-photo">{{ product.image ? 'This image can’t be loaded' : 'Add an image URL to see the photo' }}</p>
    </div>
    <footer>
      <div class="info">
        <small>{{ product.label || 'Label' }}</small>
        <h3>{{ product.name || 'Product name' }}</h3>
      </div>
      <div class="buy">
        <s v-if="discount">{{ price(product.compareAt) }}</s>
        <span class="price">{{ price(product.price) }}</span>
      </div>
    </footer>
  </article>
</template>

<style scoped>
.card {
  position: relative;
  display: flex;
  flex-direction: column;
  min-height: 420px;
  padding: 24px;
  border-radius: 32px;
  background: #f3f4f4;
  overflow: hidden;
  font-family: 'Inter', var(--font-ui);
  color: #121417;
}
.top {
  position: relative;
  z-index: 2;
  display: flex;
  justify-content: space-between;
}
.dots {
  display: flex;
  gap: 4px;
}
.cdot {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  border: 2px solid #fff;
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.06);
}
.heart {
  display: grid;
  place-items: center;
  width: 38px;
  height: 38px;
  border-radius: 50%;
  background: #fff;
}
.badge {
  position: absolute;
  top: 70px;
  left: 24px;
  z-index: 2;
  padding: 5px 10px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 600;
}
.badge.sale {
  background: #ff3b6b;
  color: #fff;
}
.badge.new {
  background: #fff;
  color: #1f5bff;
}
.photo {
  flex: 1;
  display: flex;
  min-height: 240px;
  margin: -20px -24px 16px;
  overflow: hidden;
}
.photo img {
  width: 100%;
  object-fit: cover;
  mix-blend-mode: multiply;
}
.no-photo {
  margin: auto;
  padding: 0 24px;
  color: #8b9098;
  font-size: 13px;
  text-align: center;
}
footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.info {
  min-width: 0;
}
small {
  font-size: 12px;
  color: #8b9098;
}
h3 {
  margin-top: 2px;
  font-size: 17px;
  font-weight: 500;
  line-height: 1.25;
  max-width: 13ch;
  overflow-wrap: anywhere;
}
.buy {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 2px;
}
s {
  font-size: 12px;
  color: #8b9098;
}
.price {
  display: grid;
  place-items: center;
  min-width: 72px;
  height: 48px;
  padding: 0 18px;
  border-radius: 999px;
  background: #1f5bff;
  color: #fff;
  font-size: 15px;
  font-weight: 500;
}
</style>
