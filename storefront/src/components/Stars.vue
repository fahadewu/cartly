<script setup>
defineProps({ value: { type: Number, required: true }, size: { type: Number, default: 16 } })
const star = 'M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z'
</script>

<template>
  <span class="stars" :aria-label="`${value.toFixed(1)} out of 5 stars`" role="img">
    <svg v-for="n in 5" :key="n" :width="size" :height="size" viewBox="0 0 24 24" aria-hidden="true">
      <defs>
        <linearGradient :id="`s${n}-${Math.round(value * 10)}`">
          <stop :offset="`${Math.max(0, Math.min(1, value - n + 1)) * 100}%`" stop-color="#f5a524" />
          <stop offset="0" stop-color="#e3e5e8" />
        </linearGradient>
      </defs>
      <path :d="star" :fill="`url(#s${n}-${Math.round(value * 10)})`" />
    </svg>
  </span>
</template>

<style scoped>
.stars {
  display: inline-flex;
  gap: 2px;
  vertical-align: middle;
}
</style>
