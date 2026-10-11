<script setup lang="ts">
/**
 * StripeLoader —— 四色竖条跳动（Google 风格）
 * 用于 web_search / web_fetch 运行态：四条不同颜色的竖条错峰拉伸。
 */
const props = defineProps<{ size?: number }>()
</script>

<template>
  <div class="stripe-loader" aria-hidden="true" :style="{ height: (props.size || 14) + 'px' }">
    <span class="stripe s1"></span>
    <span class="stripe s2"></span>
    <span class="stripe s3"></span>
    <span class="stripe s4"></span>
  </div>
</template>

<style scoped>
.stripe-loader {
  transform: rotate(80deg);
  display: flex;
  align-items: center;
}
.stripe {
  display: inline-block;
  width: 1.5px;
  height: 8px;
  margin: 0 0.4px;
  outline: 1px solid transparent;
  animation: stripePulse 1.2s ease-in-out infinite;
  border-radius: 1px;
}
.s1 { background-color: #4285f4; animation-delay: 0.15s; margin-bottom: -3px; }
.s2 { background-color: #db4437; animation-delay: 0.3s; margin-bottom: 3px; }
.s3 { background-color: #f4b400; animation-delay: 0.45s; margin-bottom: -4px; }
.s4 { background-color: #0f9d58; animation-delay: 0.6s; margin-bottom: 4px; }
@keyframes stripePulse {
  20% { transform: scale(1, 2.2); }
  40% { transform: scale(1); }
}
</style>