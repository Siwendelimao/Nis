<script setup lang="ts">
import { ref, computed } from 'vue'

const props = defineProps<{
  size?: number
  active?: boolean
}>()

const s = ref(props.size || 20)
const isActive = computed(() => props.active !== false)
</script>

<template>
  <div :class="['n-loader', { 'n-loader-active': isActive }]" :style="{ width: s + 'px', height: s + 'px' }">
    <svg :width="s" :height="s" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M6 18 L6 6 L18 18 L18 6" stroke="#1f2937" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" fill="none" />
      <circle cx="6" cy="18" r="2" fill="#a5b4fc" :class="['n-light', { 'n-light-active': isActive }]" />
    </svg>
  </div>
</template>

<style scoped>
.n-loader {
  position: relative;
  flex-shrink: 0;
}
.n-loader-active {
  animation: nRotate 4s linear infinite;
}

.n-light-active {
  animation: nTrace 4s linear infinite;
  filter: drop-shadow(0 0 3px #6366f1);
}

@keyframes nTrace {
  0% { transform: translate(0, 0); opacity: 1; }
  25% { transform: translate(0, -12px); opacity: 1; }
  50% { transform: translate(12px, 0); opacity: 1; }
  75% { transform: translate(12px, -12px); opacity: 1; }
  99% { transform: translate(12px, -12px); opacity: 0; }
  100% { transform: translate(0, 0); opacity: 0; }
}

@keyframes nRotate {
  0%, 75% { transform: rotate(0deg); }
  100% { transform: rotate(360deg); }
}
</style>
