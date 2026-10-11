<script setup lang="ts">
/**
 * TerminalLoader —— 终端打字动画
 * 用于 run_command 运行态：迷你终端窗口 + 绿色光标打字。
 */
const props = defineProps<{ size?: number }>()
</script>

<template>
  <div class="term-loader" :style="{ width: (props.size || 16) + 'px', height: (props.size || 15) + 'px' }" aria-hidden="true">
    <span class="dot d-close"></span>
    <span class="dot d-min"></span>
    <span class="dot d-max"></span>
    <span class="term-text">$&gt;</span>
  </div>
</template>

<style scoped>
.term-loader {
  position: relative;
  background: #1a1a1a;
  border: 1px solid #444;
  border-radius: 3px;
  box-sizing: border-box;
  overflow: hidden;
}
.dot {
  position: absolute;
  top: 1px;
  width: 2px;
  height: 2px;
  border-radius: 50%;
}
.d-close { left: 2px; background: #e33; }
.d-min   { left: 5px; background: #ee0; }
.d-max   { left: 8px; background: #0b0; }
.term-text {
  position: absolute;
  left: 2px;
  bottom: 0;
  color: #0f0;
  font-family: "Courier New", Courier, monospace;
  font-size: 8px;
  line-height: 10px;
  white-space: nowrap;
  overflow: hidden;
  border-right: 1px solid #0f0; /* 光标 */
  animation: termType 2s steps(4) infinite, blinkCursor 0.6s step-end infinite alternate;
  max-width: 100%;
}
@keyframes termType {
  0%, 10% { width: 0; }
  45%, 55% { width: 9px; }
  90%, 100% { width: 0; }
}
@keyframes blinkCursor {
  50% { border-right-color: transparent; }
}
</style>