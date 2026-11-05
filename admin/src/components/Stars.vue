<script setup>
defineProps({ rating: Number })
</script>

<template>
  <span class="stars" role="img" :aria-label="`${rating} out of 5 stars`">
    <svg v-for="i in 5" :key="i" width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="m12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9L12 3.5Z"
        :fill="i <= Math.round(rating) ? '#f2b705' : '#e3e6df'"
      />
    </svg>
  </span>
</template>

<style scoped>
.stars {
  display: inline-flex;
  gap: 1px;
  vertical-align: -2px;
}
</style>
