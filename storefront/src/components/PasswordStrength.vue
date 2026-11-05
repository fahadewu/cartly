<script setup>
import Icon from './Icon.vue'

defineProps({
  rules: { type: Array, required: true },
  score: { type: Number, required: true },
  strength: { type: String, required: true },
})
</script>

<template>
  <div class="strength" :data-score="score">
    <div class="bars"><i v-for="n in 4" :key="n" :class="{ on: n <= score }" /></div>
    <span>{{ strength }}</span>
  </div>
  <ul class="rules">
    <li v-for="r in rules" :key="r.label" :class="{ ok: r.ok }">
      <Icon :name="r.ok ? 'check' : 'minus'" :size="13" />{{ r.label }}
    </li>
  </ul>
</template>

<style scoped>
.strength {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 2px 6px 0;
  font-size: 12px;
  font-weight: 500;
  color: var(--muted);
}
.bars {
  flex: 1;
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 6px;
}
.bars i {
  height: 5px;
  border-radius: 4px;
  background: var(--line);
  transition: background 0.25s ease;
}
[data-score='1'] .on { background: #f04438; }
[data-score='2'] .on { background: #f5a524; }
[data-score='3'] .on { background: #7cc47f; }
[data-score='4'] .on { background: #17b26a; }

.rules {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 0;
  padding: 0 0 0 4px;
  list-style: none;
}
.rules li {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 28px;
  padding: 0 12px;
  border-radius: var(--r-pill);
  background: var(--chip);
  font-size: 12px;
  color: var(--muted);
  transition: all 0.2s ease;
}
.rules li.ok {
  background: #e7f8ef;
  color: #067647;
}
</style>
