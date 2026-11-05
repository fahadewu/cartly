<script setup>
import { ref, computed, useId, useAttrs } from 'vue'
import Icon from './Icon.vue'

defineOptions({ inheritAttrs: false })

const model = defineModel({ type: String, default: '' })
const props = defineProps({
  label: { type: String, required: true },
  icon: String,
  type: { type: String, default: 'text' },
  error: String,
})

const id = useId()
// class/style style the wrapper; everything else goes to the <input>.
const attrs = useAttrs()
const inputAttrs = () => {
  const { class: _c, style: _s, ...rest } = attrs
  return rest
}
const reveal = ref(false)
const inputType = computed(() => (props.type === 'password' && reveal.value ? 'text' : props.type))
</script>

<template>
  <div class="field" :class="[{ invalid: error, 'no-icon': !icon, 'has-reveal': type === 'password' }, attrs.class]" :style="attrs.style">
    <label :for="id">{{ label }}</label>
    <div class="control">
      <Icon v-if="icon" :name="icon" :size="19" class="lead" />
      <input
        :id="id"
        v-model="model"
        :type="inputType"
        :aria-invalid="!!error"
        :aria-describedby="error ? `${id}-err` : undefined"
        v-bind="inputAttrs()"
      />
      <button
        v-if="type === 'password'"
        type="button"
        class="reveal"
        :aria-label="reveal ? 'Hide password' : 'Show password'"
        @click="reveal = !reveal"
      >
        <Icon :name="reveal ? 'eyeOff' : 'eye'" :size="19" />
      </button>
    </div>
    <p v-if="error" :id="`${id}-err`" class="error">{{ error }}</p>
    <slot />
  </div>
</template>

<style scoped>
.field {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
label {
  padding-left: 6px;
  font-size: 13px;
  font-weight: 500;
  color: var(--muted);
}
.control {
  position: relative;
  display: flex;
  align-items: center;
}
.lead {
  position: absolute;
  left: 22px;
  color: var(--muted);
  pointer-events: none;
  transition: color 0.2s ease;
}
input {
  width: 100%;
  height: 58px;
  padding: 0 20px 0 54px;
  border: 1.5px solid transparent;
  border-radius: 20px;
  background: var(--chip);
  font: inherit;
  font-size: 15px;
  color: var(--ink);
  outline: none;
  transition: border-color 0.2s ease, background 0.2s ease, box-shadow 0.2s ease;
}
input::placeholder {
  color: #b3b7bd;
}
input:hover {
  background: var(--line);
}
input:focus {
  background: #fff;
  border-color: var(--blue);
  box-shadow: 0 0 0 4px var(--blue-soft);
}
.no-icon input {
  padding-left: 20px;
}
.has-reveal input {
  padding-right: 56px;
}
.control:focus-within .lead {
  color: var(--blue);
}
.reveal {
  position: absolute;
  right: 12px;
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  border-radius: 12px;
  color: var(--muted);
}
.reveal:hover {
  background: #fff;
  color: var(--ink);
}

.invalid input {
  border-color: #f04438;
  background: #fff5f4;
}
.invalid input:focus {
  box-shadow: 0 0 0 4px #fee4e2;
}
.invalid .lead {
  color: #f04438;
}
.error {
  padding-left: 6px;
  font-size: 13px;
  color: #d92d20;
}
</style>
