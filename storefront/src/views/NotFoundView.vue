<script setup>
import Icon from '../components/Icon.vue'
</script>

<template>
  <div class="page nf">
    <div class="empty">
      <span class="empty-icon"><Icon name="compass" :size="28" /></span>
      <h3>We couldn’t find that page</h3>
      <p>It may have moved, or the link might be wrong. Let’s get you back to the good stuff.</p>
      <div class="row">
        <RouterLink to="/" class="btn-primary sm">Back to Explore</RouterLink>
        <RouterLink to="/shop" class="btn-secondary sm">Browse all products</RouterLink>
      </div>
    </div>
  </div>
</template>

<style scoped>
.nf {
  padding-top: 40px;
}
.row {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 10px;
}
</style>
