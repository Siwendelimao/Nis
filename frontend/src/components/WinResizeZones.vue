<script setup lang="ts">
/**
 * WinResizeZones —— 无边框窗口的边角缩放热区（0915，随打包引入）
 *
 * 背景：窗口 decorations:false 后失去系统级 resize。本组件在窗口 8 个边/角覆盖
 * 5~12px 的透明热区，pointerdown 时调 Tauri 的 startResizeDragging(dir) 还原缩放。
 * 仅 Tauri 桌面环境挂载（浏览器 dev 零影响）；最大化时自动隐藏（最大化不可缩放）。
 *
 * 权限：capabilities/default.json 已配 core:window:allow-start-resize-dragging。
 */
import { ref, onMounted, onUnmounted } from 'vue'

const isTauriEnv = typeof window !== 'undefined' && !!(window as any).__TAURI_INTERNALS__
const active = ref(false)
const maximized = ref(false)

let winRef: any = null
async function getWin(): Promise<any> {
  if (winRef) return winRef
  const mod = await import('@tauri-apps/api/window')
  winRef = mod.getCurrentWindow()
  return winRef
}

const DIRS: Array<{ key: string; cls: string; dir: string }> = [
  { key: 'n', cls: 'rz-n', dir: 'North' },
  { key: 's', cls: 'rz-s', dir: 'South' },
  { key: 'e', cls: 'rz-e', dir: 'East' },
  { key: 'w', cls: 'rz-w', dir: 'West' },
  { key: 'ne', cls: 'rz-ne', dir: 'NorthEast' },
  { key: 'nw', cls: 'rz-nw', dir: 'NorthWest' },
  { key: 'se', cls: 'rz-se', dir: 'SouthEast' },
  { key: 'sw', cls: 'rz-sw', dir: 'SouthWest' },
]

async function onDown(e: PointerEvent, dir: string) {
  if (!isTauriEnv) return
  e.preventDefault()
  try {
    await (await getWin()).startResizeDragging(dir)
  } catch { /* 环境不支持时静默 */ }
}

let unlisten: (() => void) | null = null
onMounted(async () => {
  if (!isTauriEnv) return
  active.value = true
  try {
    const w = await getWin()
    maximized.value = await w.isMaximized()
    unlisten = await w.onResized(async () => {
      try { maximized.value = await w.isMaximized() } catch { /* ignore */ }
    })
  } catch { /* 环境探测失败：不激活热区 */ }
})
onUnmounted(() => {
  if (unlisten) { try { unlisten() } catch { /* ignore */ } }
})
</script>

<template>
  <Teleport to="body">
    <div v-if="active && !maximized" class="rz-layer">
      <div
        v-for="z in DIRS"
        :key="z.key"
        :class="['rz', z.cls]"
        @pointerdown="onDown($event, z.dir)"
      ></div>
    </div>
  </Teleport>
</template>

<style scoped>
.rz-layer {
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 2147483000;
}
.rz {
  position: fixed;
  pointer-events: auto;
}
.rz-n { top: 0; left: 12px; right: 12px; height: 5px; cursor: n-resize; }
.rz-s { bottom: 0; left: 12px; right: 12px; height: 5px; cursor: s-resize; }
.rz-e { right: 0; top: 12px; bottom: 12px; width: 5px; cursor: e-resize; }
.rz-w { left: 0; top: 12px; bottom: 12px; width: 5px; cursor: w-resize; }
.rz-ne { top: 0; right: 0; width: 12px; height: 12px; cursor: ne-resize; }
.rz-nw { top: 0; left: 0; width: 12px; height: 12px; cursor: nw-resize; }
.rz-se { bottom: 0; right: 0; width: 12px; height: 12px; cursor: se-resize; }
.rz-sw { bottom: 0; left: 0; width: 12px; height: 12px; cursor: sw-resize; }
</style>
