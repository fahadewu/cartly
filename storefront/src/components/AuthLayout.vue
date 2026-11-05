<script setup>
import Icon from './Icon.vue'
import PoweredBy from './PoweredBy.vue'
import { banners, img, money } from '../data.js'
import { computed } from 'vue'
import { products } from '../catalog.js'

defineEmits(['social'])
defineProps({
  title: { type: String, required: true },
  subtitle: String,
})

// A real product from the live catalog for the showcase card.
const sneaker = computed(() => products.find((p) => p.id === 2) ?? products[0])
const faces = ['1517841905240-472988babdf9', '1571945153237-4929e783af4a', '1503342217505-b0a15ec3261c', '1552374196-1ab2a1c593e8'].map((id) => ({ id, image: img(id, 120) }))
</script>

<template>
  <div class="shell auth">
    <section class="panel">
      <header class="head">
        <RouterLink to="/" class="logo">C<span>art</span>ly</RouterLink>
        <nav class="segmented" aria-label="Account">
          <RouterLink to="/login" class="seg">Log in</RouterLink>
          <RouterLink to="/signup" class="seg">Sign up</RouterLink>
        </nav>
      </header>

      <div class="body">
        <h1>{{ title }}</h1>
        <p v-if="subtitle" class="sub">{{ subtitle }}</p>

        <div class="social">
          <button type="button" class="pill social-btn" @click="$emit('social', 'Google')">
            <svg width="20" height="20" viewBox="0 0 48 48" aria-hidden="true">
              <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3 0 5.8 1.1 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
              <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3 0 5.8 1.1 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
              <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
              <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
            </svg>
            Google
          </button>
          <button type="button" class="pill social-btn" @click="$emit('social', 'Apple')">
            <svg width="18" height="20" viewBox="0 0 384 512" aria-hidden="true">
              <path fill="currentColor" d="M318.7 268.7c-.2-36.7 16.4-64.4 50-84.8-18.8-26.9-47.2-41.7-84.7-44.6-35.5-2.8-74.3 20.7-88.5 20.7-15 0-49.4-19.7-76.4-19.7C63.3 141.2 4 184.8 4 273.5q0 39.3 14.4 81.2c12.8 36.7 59 126.7 107.2 125.2 25.2-.6 43-17.9 75.8-17.9 31.8 0 48.3 17.9 76.4 17.9 48.6-.7 90.4-82.5 102.6-119.3-65.2-30.7-61.7-90-61.7-91.9zm-56.6-164.2c27.3-32.4 24.8-61.9 24-72.5-24.1 1.4-52 16.4-67.9 34.9-17.5 19.8-27.8 44.3-25.6 71.9 26.1 2 49.9-11.4 69.5-34.3z" />
            </svg>
            Apple
          </button>
        </div>

        <div class="divider"><span>or continue with email</span></div>

        <slot />
      </div>

      <footer class="foot">
        <slot name="footer" />
        <div class="powered-row"><PoweredBy compact /></div>
      </footer>
    </section>

    <!-- Showcase: the storefront's bento cards, echoing the dashboard. -->
    <aside class="showcase" aria-hidden="true">
      <div class="card promo">
        <div class="promo-copy">
          <small>New members</small>
          <h2>GET UP TO<br />50% OFF</h2>
          <span class="glass">On your first order</span>
        </div>
        <img :src="banners.promo" alt="" />
      </div>

      <div class="row">
        <div v-if="sneaker" class="card product">
          <div class="p-top">
            <div class="dots"><i v-for="c in sneaker.colors.slice(0, 2)" :key="c.name" :style="{ background: c.hex }" /></div>
            <span class="icon-btn"><Icon name="heart" :size="16" filled class="heart" /></span>
          </div>
          <img :src="sneaker.image" alt="" />
          <div class="p-foot">
            <div>
              <small>{{ sneaker.label }}</small>
              <b>{{ sneaker.name }}</b>
            </div>
            <span class="price">{{ money(sneaker.price) }}</span>
          </div>
        </div>

        <div class="stack">
          <div class="card weekend">
            <span class="icon-btn corner"><Icon name="arrow" :size="15" /></span>
            <h3>Winter’s weekend</h3>
            <p>keep it casual</p>
            <img :src="banners.weekend" alt="" />
          </div>
          <div class="card community">
            <div class="faces">
              <img v-for="f in faces" :key="f.id" :src="f.image" alt="" />
            </div>
            <div>
              <b>12k+ shoppers</b>
              <p>already saving with Cartly</p>
            </div>
          </div>
        </div>
      </div>
    </aside>
  </div>
</template>

<style scoped>
.auth {
  display: grid;
  grid-template-columns: minmax(420px, 1fr) 1.1fr;
  /* Fill the window, leaving a thin strip of background all round. */
  min-height: calc(100dvh - 2 * var(--gutter));
  margin: var(--gutter);
  background: var(--shell);
  border-radius: var(--r-shell);
  box-shadow: 0 40px 80px -40px rgba(40, 80, 50, 0.35);
  overflow: hidden;
}

/* ---- Form panel ---- */
.panel {
  display: flex;
  flex-direction: column;
  padding: 44px 64px 40px;
}
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
.logo {
  font-size: 26px;
  font-weight: 600;
  letter-spacing: -0.03em;
  color: inherit;
  text-decoration: none;
}
.logo span {
  position: relative;
}
.logo span::after {
  content: '';
  position: absolute;
  left: 2px;
  right: 6px;
  bottom: -5px;
  height: 3px;
  border-radius: 3px;
  background: var(--blue);
}

.segmented {
  display: flex;
  padding: 4px;
  border-radius: var(--r-pill);
  background: var(--chip);
}
.seg {
  display: grid;
  place-items: center;
  height: 46px;
  padding: 0 24px;
  border-radius: var(--r-pill);
  font-size: 14px;
  font-weight: 500;
  color: var(--muted);
  text-decoration: none;
  transition: all 0.25s ease;
}
.seg:hover {
  color: var(--ink);
}
.seg.router-link-exact-active {
  background: #fff;
  color: var(--ink);
  box-shadow: 0 8px 20px -8px rgba(0, 0, 0, 0.15);
}

.body {
  width: 100%;
  max-width: 440px;
  margin: auto;
  padding: 48px 0 32px;
}
h1 {
  font-size: 38px;
  font-weight: 500;
  letter-spacing: -0.03em;
}
.sub {
  margin-top: 10px;
  font-size: 15px;
  line-height: 1.5;
  color: var(--muted);
}

.social {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
  margin-top: 32px;
}
.social-btn {
  justify-content: center;
  height: 54px;
  font-size: 15px;
}
.social-btn:hover {
  background: var(--line);
}

.divider {
  display: flex;
  align-items: center;
  gap: 14px;
  margin: 26px 0;
  font-size: 13px;
  color: var(--muted);
}
.divider::before,
.divider::after {
  content: '';
  flex: 1;
  height: 1px;
  background: var(--line);
}

.powered-row {
  margin-top: 14px;
}
.foot {
  text-align: center;
  font-size: 14px;
  color: var(--muted);
}

/* ---- Showcase ---- */
.showcase {
  display: flex;
  flex-direction: column;
  gap: 18px;
  padding: 24px;
  background: #fafbfa;
  border-left: 1px solid var(--line);
}
.card {
  position: relative;
  overflow: hidden;
  border-radius: var(--r-card);
}
.card img {
  transition: transform 0.6s ease;
}
.card:hover img {
  transform: scale(1.04);
}

.promo {
  flex: 1;
  min-height: 260px;
  background: var(--mint);
}
.promo img {
  position: absolute;
  top: 0;
  right: 0;
  width: 58%;
  height: 100%;
  object-fit: cover;
  mask-image: linear-gradient(90deg, transparent, #000 45%);
  -webkit-mask-image: linear-gradient(90deg, transparent, #000 45%);
}
.promo-copy {
  position: relative;
  z-index: 1;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: flex-start;
  gap: 14px;
  height: 100%;
  padding: 40px;
}
.promo small {
  font-size: 13px;
  font-weight: 500;
}
.promo h2 {
  font-size: 40px;
  font-weight: 600;
  line-height: 1.05;
  letter-spacing: -0.02em;
}
.glass {
  display: inline-flex;
  align-items: center;
  height: 44px;
  padding: 0 24px;
  border-radius: var(--r-pill);
  background: rgba(255, 255, 255, 0.6);
  backdrop-filter: blur(10px);
  font-size: 14px;
  font-weight: 500;
}

.row {
  display: grid;
  grid-template-columns: 1fr 1.15fr;
  gap: 18px;
}

.product {
  display: flex;
  flex-direction: column;
  min-height: 360px;
  padding: 22px;
  background: var(--card);
}
.p-top {
  position: relative;
  z-index: 1;
  display: flex;
  justify-content: space-between;
}
.dots {
  display: flex;
  gap: 4px;
}
.dots i {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  border: 2px solid #fff;
}
.heart {
  color: #ff3b6b;
}
.product img {
  flex: 1;
  min-height: 0;
  width: calc(100% + 44px);
  max-width: none;
  margin: -18px -22px 14px;
  object-fit: cover;
  mix-blend-mode: multiply;
}
.p-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.p-foot small {
  font-size: 12px;
  color: var(--muted);
}
.p-foot b {
  display: block;
  font-size: 15px;
  font-weight: 500;
}
.price {
  display: grid;
  place-items: center;
  height: 44px;
  padding: 0 18px;
  border-radius: var(--r-pill);
  background: var(--blue);
  color: #fff;
  font-size: 14px;
  font-weight: 500;
}

.stack {
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.weekend {
  flex: 1;
  display: flex;
  flex-direction: column;
  justify-content: center;
  padding: 28px;
  background: var(--butter);
}
.weekend h3,
.weekend p {
  position: relative;
  z-index: 1;
}
.weekend h3 {
  max-width: 7ch;
  font-size: 26px;
  font-weight: 600;
  line-height: 1.1;
  letter-spacing: -0.02em;
}
.weekend p {
  margin-top: 8px;
  font-size: 14px;
}
.weekend img {
  position: absolute;
  top: 0;
  right: 0;
  width: 50%;
  height: 100%;
  object-fit: cover;
  mask-image: linear-gradient(90deg, transparent, #000 40%);
  -webkit-mask-image: linear-gradient(90deg, transparent, #000 40%);
}
.corner {
  position: absolute;
  top: 16px;
  right: 16px;
  z-index: 2;
  width: 36px;
  height: 36px;
  border-radius: 12px;
}

.community {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 18px 22px;
  background: var(--peach);
}
.faces {
  display: flex;
}
.faces img {
  width: 40px;
  height: 40px;
  margin-left: -10px;
  border: 3px solid var(--peach);
  border-radius: 50%;
  object-fit: cover;
}
.faces img:first-child {
  margin-left: 0;
}
.community b {
  font-size: 15px;
  font-weight: 600;
}
.community p {
  font-size: 13px;
  color: #7a6a60;
}

@media (max-width: 1100px) {
  .auth {
    grid-template-columns: 1fr;
    max-width: 640px;
    margin: var(--gutter) auto;
  }
  .showcase {
    display: none;
  }
}
@media (max-width: 680px) {
  .auth {
    margin: 0;
    min-height: 100dvh;
    border-radius: 0;
  }
  .panel {
    padding: 24px 20px 32px;
  }
  .seg {
    padding: 0 16px;
  }
  .body {
    padding-top: 36px;
  }
  h1 {
    font-size: 30px;
  }
}
</style>
