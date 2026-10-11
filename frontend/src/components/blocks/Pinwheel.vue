<script setup lang="ts">
/**
 * Pinwheel —— 风车旋转线动画
 * 用于 fs_write 运行态：6 条线由中心辐射旋转，透明度递减形成风车效果。
 */
const props = defineProps<{ size?: number }>()
const s = (props.size || 16) / 45
</script>

<template>
  <div class="pinwheel" aria-hidden="true" :style="{
    width: (props.size || 16) + 'px',
    height: (props.size || 16) + 'px',
    '--uib-line-weight': Math.max(1, s * 4) + 'px',
    '--uib-speed': '0.8s',
  }">
    <div class="pinwheel__line" v-for="i in 6" :key="i" :style="{ animationDelay: (i - 1) * 0.06 + 's', opacity: Math.max(0.1, 1 - (i - 1) * 0.15) }"></div>
  </div>
</template>

<style scoped>
.pinwheel {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.pinwheel__line {
  position: absolute;
  top: calc(50% - var(--uib-line-weight, 1.5px) / 2);
  left: 0;
  height: var(--uib-line-weight, 1.5px);
  width: 100%;
  border-radius: 1px;
  background-color: #312f2b;
  animation: rotate81232 var(--uib-speed, 0.8s) ease-in-out infinite;
}
@keyframes rotate81232 {
  0% { transform: rotate(0deg); }
  100% { transform: rotate(180deg); }
}
</style>