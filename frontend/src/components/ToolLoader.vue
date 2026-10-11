<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  active?: boolean
}>()

const isActive = computed(() => props.active !== false)
</script>

<template>
  <div :class="['tool-loader', { 'tool-loader-active': isActive }]">
    <div class="loader-square"></div>
    <div class="loader-square"></div>
    <div class="loader-square"></div>
    <div class="loader-square"></div>
    <div class="loader-square"></div>
    <div class="loader-square"></div>
    <div class="loader-square"></div>
  </div>
</template>

<style scoped>
@keyframes square-animation {
  0% {
    left: 2px;
    top: 2px;
  }
  10.5% {
    left: 2px;
    top: 2px;
  }
  12.5% {
    left: 6px;
    top: 2px;
  }
  23% {
    left: 6px;
    top: 2px;
  }
  25% {
    left: 10px;
    top: 2px;
  }
  35.5% {
    left: 10px;
    top: 2px;
  }
  37.5% {
    left: 10px;
    top: 6px;
  }
  48% {
    left: 10px;
    top: 6px;
  }
  50% {
    left: 6px;
    top: 6px;
  }
  60.5% {
    left: 6px;
    top: 6px;
  }
  62.5% {
    left: 6px;
    top: 10px;
  }
  73% {
    left: 6px;
    top: 10px;
  }
  75% {
    left: 2px;
    top: 10px;
  }
  85.5% {
    left: 2px;
    top: 10px;
  }
  87.5% {
    left: 2px;
    top: 6px;
  }
  98% {
    left: 2px;
    top: 6px;
  }
  100% {
    left: 2px;
    top: 2px;
  }
}

.tool-loader {
  position: relative;
  width: 16px;
  height: 16px;
  transform: rotate(45deg);
  flex-shrink: 0;
}

.loader-square {
  position: absolute;
  top: 0;
  left: 0;
  width: 3px;
  height: 3px;
  border-radius: 0px;
  background: #1f2937;
}
.tool-loader-active .loader-square {
  animation: square-animation 10s ease-in-out infinite both;
}

.tool-loader-active .loader-square:nth-of-type(0) {
  animation-delay: 0s;
}
.tool-loader-active .loader-square:nth-of-type(1) {
  animation-delay: -1.4285714286s;
}
.tool-loader-active .loader-square:nth-of-type(2) {
  animation-delay: -2.8571428571s;
}
.tool-loader-active .loader-square:nth-of-type(3) {
  animation-delay: -4.2857142857s;
}
.tool-loader-active .loader-square:nth-of-type(4) {
  animation-delay: -5.7142857143s;
}
.tool-loader-active .loader-square:nth-of-type(5) {
  animation-delay: -7.1428571429s;
}
.tool-loader-active .loader-square:nth-of-type(6) {
  animation-delay: -8.5714285714s;
}
.tool-loader-active .loader-square:nth-of-type(7) {
  animation-delay: -10s;
}
</style>
