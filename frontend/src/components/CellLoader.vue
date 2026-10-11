<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  active?: boolean
}>()

const isActive = computed(() => props.active !== false)
</script>

<template>
  <div :class="['cell-loader', { 'cell-loader-active': isActive }]">
    <div class="cell d-0"></div>
    <div class="cell d-1"></div>
    <div class="cell d-2"></div>
    <div class="cell d-3"></div>
    <div class="cell d-4"></div>
    <div class="cell d-1"></div>
    <div class="cell d-2"></div>
    <div class="cell d-3"></div>
    <div class="cell d-4"></div>
    <div class="cell d-5"></div>
    <div class="cell d-2"></div>
    <div class="cell d-3"></div>
    <div class="cell d-4"></div>
    <div class="cell d-5"></div>
    <div class="cell d-6"></div>
    <div class="cell d-3"></div>
    <div class="cell d-4"></div>
    <div class="cell d-5"></div>
    <div class="cell d-6"></div>
    <div class="cell d-7"></div>
    <div class="cell d-4"></div>
    <div class="cell d-5"></div>
    <div class="cell d-6"></div>
    <div class="cell d-7"></div>
    <div class="cell d-8"></div>
  </div>
</template>

<style scoped>
.cell-loader {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 1px;
  width: 18px;
  height: 18px;
  flex-shrink: 0;
}

.cell {
  background-color: transparent;
  border-radius: 1px;
}
.cell-loader-active .cell {
  animation: ripple 1.5s ease infinite;
}

.cell.d-0 { animation-delay: 0ms; }
.cell.d-1 { animation-delay: 100ms; }
.cell.d-2 { animation-delay: 200ms; }
.cell.d-3 { animation-delay: 300ms; }
.cell.d-4 { animation-delay: 400ms; }
.cell.d-5 { animation-delay: 500ms; }
.cell.d-6 { animation-delay: 600ms; }
.cell.d-7 { animation-delay: 700ms; }
.cell.d-8 { animation-delay: 800ms; }

.cell:nth-child(5n+1) { --cell-color: #00FF87; }
.cell:nth-child(5n+2) { --cell-color: #0CFD95; }
.cell:nth-child(5n+3) { --cell-color: #17FBA2; }
.cell:nth-child(5n+4) { --cell-color: #23F9B2; }
.cell:nth-child(5n+5) { --cell-color: #30F7C3; }

@keyframes ripple {
  0% { background-color: transparent; }
  30% { background-color: var(--cell-color); }
  60% { background-color: transparent; }
  100% { background-color: transparent; }
}
</style>
