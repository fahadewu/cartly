<script setup>
import PageHeader from '../components/PageHeader.vue'
import Icon from '../components/Icon.vue'
import { stories, productById } from '../catalog.js'

const [lead, ...rest] = stories
</script>

<template>
  <div>
    <PageHeader title="Inspiration" subtitle="Stories, styling notes and gift ideas from the Cartly team" :crumbs="[{ label: 'Explore', to: '/' }, { label: 'Inspiration' }]" />

    <div class="page">
      <RouterLink :to="`/inspiration/${lead.slug}`" class="lead" :style="{ background: lead.color }">
        <div class="lead-copy">
          <span class="kicker">Featured story</span>
          <h2>{{ lead.title }}</h2>
          <p>{{ lead.excerpt }}</p>
          <span class="glass">Read the story</span>
        </div>
        <img :src="lead.image" alt="" />
      </RouterLink>

      <div class="grid">
        <RouterLink v-for="s in rest" :key="s.slug" :to="`/inspiration/${s.slug}`" class="story" :style="{ background: s.color }">
          <div class="photo"><img :src="s.image" alt="" loading="lazy" /></div>
          <div class="copy">
            <h3>{{ s.title }}</h3>
            <p>{{ s.excerpt }}</p>
            <div class="foot">
              <div class="minis">
                <img v-for="id in s.products.slice(0, 3)" :key="id" :src="productById(id).image" alt="" />
              </div>
              <span class="icon-btn"><Icon name="arrow" :size="16" /></span>
            </div>
          </div>
        </RouterLink>
      </div>
    </div>
  </div>
</template>

<style scoped>
.lead {
  position: relative;
  display: flex;
  align-items: center;
  min-height: 360px;
  border-radius: var(--r-card);
  overflow: hidden;
  color: inherit;
  text-decoration: none;
}
.lead-copy {
  position: relative;
  z-index: 1;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 14px;
  max-width: 480px;
  padding: 48px;
}
.kicker {
  font-size: 13px;
  font-weight: 500;
}
.lead h2 {
  font-size: 42px;
  font-weight: 600;
  line-height: 1.05;
  letter-spacing: -0.02em;
}
.lead p {
  font-size: 16px;
  line-height: 1.5;
  color: #4b5058;
}
.lead img {
  position: absolute;
  top: 0;
  right: 0;
  width: 55%;
  height: 100%;
  object-fit: cover;
  mask-image: linear-gradient(90deg, transparent, #000 40%);
  -webkit-mask-image: linear-gradient(90deg, transparent, #000 40%);
  transition: transform 0.6s ease;
}
.lead:hover img {
  transform: scale(1.03);
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 18px;
  margin-top: 18px;
}
.story {
  display: flex;
  flex-direction: column;
  border-radius: var(--r-card);
  overflow: hidden;
  color: inherit;
  text-decoration: none;
  transition: transform 0.25s ease, box-shadow 0.25s ease;
}
.story:hover {
  transform: translateY(-4px);
  box-shadow: 0 24px 40px -24px rgba(0, 0, 0, 0.25);
}
.photo {
  height: 220px;
  margin: 10px 10px 0;
  border-radius: 24px;
  overflow: hidden;
}
.photo img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  transition: transform 0.5s ease;
}
.story:hover .photo img {
  transform: scale(1.05);
}
.copy {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 22px 24px 22px;
}
.copy h3 {
  font-size: 21px;
  font-weight: 600;
  letter-spacing: -0.01em;
}
.copy p {
  font-size: 14px;
  line-height: 1.5;
  color: #4b5058;
}
.foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: auto;
  padding-top: 12px;
}
.minis {
  display: flex;
}
.minis img {
  width: 38px;
  height: 38px;
  margin-left: -8px;
  border: 3px solid rgba(255, 255, 255, 0.9);
  border-radius: 50%;
  object-fit: cover;
  background: #fff;
}
.minis img:first-child {
  margin-left: 0;
}

@media (max-width: 860px) {
  .lead {
    min-height: 300px;
  }
  .lead-copy {
    padding: 28px;
    max-width: 75%;
  }
  .lead h2 {
    font-size: 30px;
  }
}
</style>
