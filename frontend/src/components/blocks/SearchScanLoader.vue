<script setup lang="ts">
/**
 * SearchScanLoader —— 放大镜循环扫视（fs_grep / project_fs_grep 搜索类工具专属过程态）
 *
 * 0925 需求要求：搜索工具的过程态从"四色条纹流动"换成"放大镜循环移动"。
 * 完成态是放大镜线性图标（lucide Search）→ 过程态让同一个放大镜沿轨迹左右循环扫视
 * （位移 + 轻微倾斜，像手持放大镜在查找），两态同语言、一眼能认出是"在搜索"。
 * 颜色走 currentColor，跟随过程块图标色（浅/深主题自适应）；只动 transform。
 */
const props = defineProps<{ size?: number }>()
</script>

<template>
  <svg
    class="scan"
    :width="props.size || 14"
    :height="props.size || 14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2.2"
    stroke-linecap="round"
    aria-hidden="true"
  >
    <!-- 轨迹线（静止垫底，表达"沿线扫视"） -->
    <line class="scan-track" x1="4.5" y1="20.5" x2="19.5" y2="20.5" stroke-width="1.3" opacity="0.35" />
    <!-- 放大镜（循环左右扫视 + 倾斜） -->
    <g class="scan-mag">
      <circle cx="10.5" cy="10" r="5.8" />
      <line x1="14.8" y1="14.3" x2="19" y2="18.5" stroke-width="2.6" />
    </g>
  </svg>
</template>

<style scoped>
.scan { display: block; flex-shrink: 0; }
.scan-mag {
  transform-origin: 12px 12px;
  animation: scan-sweep 1.3s cubic-bezier(0.45, 0, 0.55, 1) infinite;
}
@keyframes scan-sweep {
  0%, 100% { transform: translateX(-2.4px) rotate(-12deg); }
  50% { transform: translateX(2.4px) rotate(12deg); }
}
</style>
