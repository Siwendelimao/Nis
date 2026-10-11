<script setup lang="ts">
/**
 * CrosshairLoader —— 瞄准镜 / 锁定动画（fs_edit 专属过程态）
 *
 * 为什么单独做一个：`fs_edit` 的 variant 是 `edit`，而 `isShellVariant('edit') === true`
 * → 默认会套用和 `run_command` 一样的「终端打字」动画。用户明确要求两者区分开。
 * 语义也更贴：精确替换 = "瞄准目标片段 → 锁定 → 改"，所以用十字准星：
 * 外圈呼吸收缩（锁定感）+ 刻度线旋转（扫描感）+ 中心点脉冲。
 * 颜色走 `currentColor`，跟随过程块的图标色（浅/深主题自适应）。
 */
const props = defineProps<{ size?: number }>()
</script>

<template>
  <svg
    class="crosshair"
    :width="props.size || 16"
    :height="props.size || 16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    aria-hidden="true"
  >
    <circle class="ch-ring" cx="12" cy="12" r="6.5" />
    <g class="ch-ticks">
      <line x1="12" y1="1.5" x2="12" y2="5.2" />
      <line x1="12" y1="18.8" x2="12" y2="22.5" />
      <line x1="1.5" y1="12" x2="5.2" y2="12" />
      <line x1="18.8" y1="12" x2="22.5" y2="12" />
    </g>
    <circle class="ch-dot" cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
  </svg>
</template>

<style scoped>
.crosshair { display: block; flex-shrink: 0; }
/* SVG 的 transform-origin 要显式给到画布中心（24×24 → 12,12） */
.ch-ticks {
  transform-origin: 12px 12px;
  animation: ch-spin 1.7s linear infinite;
}
.ch-ring {
  transform-origin: 12px 12px;
  animation: ch-lock 1.25s ease-in-out infinite;
}
.ch-dot { animation: ch-dot 1.25s ease-in-out infinite; }

@keyframes ch-spin {
  to { transform: rotate(360deg); }
}
@keyframes ch-lock {
  0%, 100% { transform: scale(1); opacity: 1; }
  50% { transform: scale(0.68); opacity: 0.5; }
}
@keyframes ch-dot {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}
</style>
