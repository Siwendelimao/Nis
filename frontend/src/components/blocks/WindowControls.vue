<script setup lang="ts">
/**
 * WindowControls —— 窗口控制按钮（最小化 / 最大化·还原 / 关闭）
 * 位置：会话标题栏（dsh-session-header）右上角——0911 反馈②修正：
 *   初版挂在 PreviewTabBar 尾部（与 tab 同排），用户指出应在「上方」标题栏行；
 *   现由 ChatInterface 直接挂进 header 右端。悬停底为正圆（50%）。
 *
 * 行为分层（环境自适应）：
 *  - Tauri 桌面环境（window.__TAURI_INTERNALS__ 存在）：真实窗口控制——
 *    getCurrentWindow().minimize() / toggleMaximize() / close()；
 *    isMaximized() + onResized 事件驱动「最大化 ⇄ 还原」图标切换。
 *  - 浏览器：按钮可见（与桌面版界面一致）；点击弹自绘气泡说明「桌面版可用」——
 *    【注】不用 notificationsStore.push()：其 toasts 数组当前无渲染组件（历史遗留死渠道），
 *    改用与 QueueBar 同款的自绘深色气泡（即时、可见、可靠）。
 *
 * 权限：src-tauri/capabilities/default.json 已配 allow-minimize/allow-close/allow-toggle-maximize/allow-is-maximized。
 * 桌面打包须知：若将窗口改为无边框（decorations:false），给 tab 栏空白区补 data-tauri-drag-region 即可拖动。
 */
import { ref, onMounted, onUnmounted } from 'vue'
import { Minus, Square, Copy, X } from 'lucide-vue-next'
import { t } from '@/utils/i18n'

const isTauriEnv = typeof window !== 'undefined' && !!(window as any).__TAURI_INTERNALS__
const isMaximized = ref(false)

/* ── 浏览器降级提示气泡 ── */
const tip = ref<{ text: string; x: number; y: number } | null>(null)
let tipTimer: ReturnType<typeof setTimeout> | undefined
function showHint(el: HTMLElement) {
  const r = el.getBoundingClientRect()
  const half = 150
  const x = Math.min(Math.max(r.left + r.width / 2, half + 8), window.innerWidth - half - 8)
  tip.value = { text: t('window.desktopOnlyHint'), x, y: r.bottom + 8 }
  if (tipTimer) clearTimeout(tipTimer)
  tipTimer = setTimeout(() => { tip.value = null }, 2600)
}
onUnmounted(() => { if (tipTimer) clearTimeout(tipTimer) })

/** 懒加载窗口实例（浏览器环境不会被调用；动态 import 避免无谓依赖加载） */
let winRef: any = null
async function getWin(): Promise<any> {
  if (winRef) return winRef
  const mod = await import('@tauri-apps/api/window')
  winRef = mod.getCurrentWindow()
  return winRef
}
let unlistenResize: (() => void) | null = null

async function onMinimize(e: MouseEvent) {
  if (!isTauriEnv) return showHint(e.currentTarget as HTMLElement)
  try { await (await getWin()).minimize() } catch (err) { console.warn('[win] minimize failed:', err) }
}

async function onToggleMaximize(e: MouseEvent) {
  if (!isTauriEnv) return showHint(e.currentTarget as HTMLElement)
  try {
    const w = await getWin()
    await w.toggleMaximize()
    try { isMaximized.value = await w.isMaximized() } catch { /* 状态查询失败不影响操作 */ }
  } catch (err) { console.warn('[win] toggleMaximize failed:', err) }
}

async function onClose(e: MouseEvent) {
  if (!isTauriEnv) {
    // 浏览器降级：window.close() 仅对脚本打开的窗口有效；不生效时给气泡提示
    try { window.close() } catch { /* ignore */ }
    setTimeout(() => { if (!document.hidden) showHint(e.currentTarget as HTMLElement) }, 180)
    return
  }
  try { await (await getWin()).close() } catch (err) { console.warn('[win] close failed:', err) }
}

onMounted(async () => {
  if (!isTauriEnv) return
  try {
    const w = await getWin()
    isMaximized.value = await w.isMaximized()
    unlistenResize = await w.onResized(async () => {
      try { isMaximized.value = await w.isMaximized() } catch { /* ignore */ }
    })
  } catch { /* 环境探测失败：按钮仍可用（点击时再试） */ }
})
onUnmounted(() => { if (unlistenResize) { try { unlistenResize() } catch { /* ignore */ } } })
</script>

<template>
  <div class="win-ctrl-bar">
    <button type="button" class="win-ctrl-btn" :title="t('window.minimize')" @click="onMinimize">
      <Minus :size="12" :stroke-width="1.75" />
    </button>
    <button type="button" class="win-ctrl-btn" :title="isMaximized ? t('window.restore') : t('window.maximize')" @click="onToggleMaximize">
      <Copy v-if="isMaximized" :size="11" :stroke-width="1.6" />
      <Square v-else :size="10" :stroke-width="1.6" />
    </button>
    <button type="button" class="win-ctrl-btn is-close" :title="t('window.close')" @click="onClose">
      <X :size="12" :stroke-width="1.75" />
    </button>
    <!-- 浏览器降级提示（自绘气泡，Teleport 到 body） -->
    <Teleport to="body">
      <Transition name="win-tip">
        <span
          v-if="tip"
          class="win-tip"
          :style="{ left: tip.x + 'px', top: tip.y + 'px' }"
        >{{ tip.text }}</span>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
/* 右端钉齐：margin-left:auto 把按钮组推到 tab 栏最右（0911 反馈：右上角窗口按钮）。
   flex:none 防被 tab zone 压缩；手机端隐藏（移动端无窗口概念，底部导航已承担）。 */
.win-ctrl-bar {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  margin-left: auto;
  flex: none;
  padding-left: 10px;
}
.win-ctrl-btn {
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: #9ca3af;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: background 0.15s ease, color 0.15s ease;
}
.win-ctrl-btn:hover { background: rgba(0, 0, 0, 0.07); color: #374151; }
.win-ctrl-btn.is-close:hover { background: #ef4444; color: #ffffff; }
@media (max-width: 767px) {
  .win-ctrl-bar { display: none; }
}
</style>

<style>
/* 深色适配（全局块，同其他组件惯例） */
html.dark .win-ctrl-btn { color: #6f6f78; }
html.dark .win-ctrl-btn:hover { background: rgba(255, 255, 255, 0.1); color: #e9e9ef; }
html.dark .win-ctrl-btn.is-close:hover { background: #ef4444; color: #ffffff; }
/* 降级提示气泡（同 QueueBar .qb-tip 语言） */
.win-tip {
  position: fixed;
  z-index: 10060;
  transform: translate(-50%, 0);
  background: #111827;
  color: #fff;
  font-size: 11px;
  line-height: 1.55;
  border-radius: 10px;
  padding: 6px 11px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.22);
  pointer-events: none;
  white-space: normal;
  max-width: min(300px, calc(100vw - 16px));
  text-align: center;
}
.win-tip-enter-active { transition: opacity 0.14s ease, transform 0.14s ease; }
.win-tip-leave-active { transition: opacity 0.12s ease; }
.win-tip-enter-from { opacity: 0; transform: translate(-50%, -4px); }
.win-tip-leave-to { opacity: 0; transform: translate(-50%, 0); }
</style>
