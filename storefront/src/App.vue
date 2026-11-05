<template>
  <!-- Decorative backdrop: thin curves and soft dots, like the shot. -->
  <div class="backdrop" aria-hidden="true">
    <span class="curve c1" /><span class="curve c2" /><span class="bubble b1" /><span class="bubble b2" />
  </div>

  <RouterView v-slot="{ Component }">
    <Transition name="page" mode="out-in">
      <component :is="Component" />
    </Transition>
  </RouterView>
</template>

<style scoped>
.backdrop {
  position: fixed;
  inset: 0;
  z-index: -1;
  overflow: hidden;
}
.curve {
  position: absolute;
  border: 1.5px solid rgba(255, 255, 255, 0.7);
  border-radius: 50%;
}
.c1 {
  width: 900px;
  height: 1400px;
  left: -620px;
  top: -300px;
}
.c2 {
  width: 1600px;
  height: 1600px;
  right: -1300px;
  top: -700px;
}
.bubble {
  position: absolute;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.7);
}
.b1 {
  left: 21%;
  top: 40px;
}
.b2 {
  right: 24%;
  bottom: 60px;
}

.page-enter-active,
.page-leave-active {
  transition: opacity 0.25s ease, transform 0.25s ease;
}
.page-enter-from,
.page-leave-to {
  opacity: 0;
  transform: translateY(8px);
}
</style>
