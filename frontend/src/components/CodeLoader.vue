<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  active?: boolean
}>()

const isActive = computed(() => props.active !== false)
</script>

<template>
  <div :class="['code-loader', { 'code-loader-active': isActive }]">
    <span>{</span><span>}</span>
  </div>
</template>

<style scoped>
.code-loader {
  display: inline-flex;
  align-items: center;
  gap: 1px;
  font-family: Consolas, Menlo, Monaco, monospace;
  font-weight: bold;
  font-size: 16px;
  color: #6366f1;
  flex-shrink: 0;
  line-height: 1;
}

.code-loader span {
  display: inline-block;
}
.code-loader-active span {
  animation: pulse_414 0.4s alternate infinite ease-in-out;
}

.code-loader span:nth-child(odd) {
  animation-delay: 0.4s;
}

@keyframes pulse_414 {
  to {
    transform: scale(0.8);
    opacity: 0.5;
  }
}
</style>
