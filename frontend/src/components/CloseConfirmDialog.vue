<script setup lang="ts">
/**
 * 关闭询问弹窗（0918 需求要求 / 0919 重做视觉与交互）
 *  触发：Rust 拦下窗口 ✕（prevent_close）后 emit `nis://close-requested`
 *  出口：取消 / 隐藏到托盘 / 退出 NIS
 *  仅 Tauri 桌面环境有效；浏览器里收不到事件，自然不显示。
 *
 * ⚠️ 0919 修「按钮点了没反应」——两件事一起做：
 *  ① **动作不再静默失败**：以前先把弹窗关掉再 invoke，invoke 一报错就只剩"点了没反应"。
 *     现在：先干活、成功了才关弹窗；失败把原因**写在弹窗里**（能截图），并留 1.6s 看门狗 ——
 *     命令"发出去了但没生效"也会明说，不再让你对着一个不动的窗口猜。
 *  ② 隐藏走**窗口插件通道**（`getCurrentWindow().hide()`，最直接），失败再退回自定义命令；
 *     退出走自定义命令 `window_action('quit')`（Rust 侧会写 `%APPDATA%\nis\close.log`）。
 *  另外：去掉 `backdrop-filter` 与 `Transition`（WebView2 下少两个变量），动画改用纯 CSS keyframes。
 */
import { ref, onMounted, onUnmounted, nextTick } from 'vue'
import { t } from '@/utils/i18n'
import { useModalLayer } from '@/utils/modalStack'

const isTauriEnv = typeof window !== 'undefined' && !!(window as any).__TAURI_INTERNALS__
const visible = ref(false)
const phase = ref<'' | 'hiding' | 'quitting'>('')
const errText = ref('')
const stuck = ref(false)
const cardRef = ref<HTMLDivElement | null>(null)
let unlisten: (() => void) | null = null
let stuckTimer: number | null = null

const short = (e: unknown): string => {
  const s = typeof e === 'string' ? e : ((e as any)?.message || String(e || ''))
  return s.length > 160 ? s.slice(0, 160) + '…' : s
}
function clearStuckTimer(): void {
  if (stuckTimer !== null) { window.clearTimeout(stuckTimer); stuckTimer = null }
}
/** 命令发出去 1.6s 后窗口还在 → 明说"没生效"（不要再让人怀疑是不是自己没点到） */
function armStuckWatch(what: string): void {
  clearStuckTimer()
  stuckTimer = window.setTimeout(() => {
    if (!visible.value) return
    stuck.value = true
    errText.value = `${t('app.close.stuck')}（${what}）`
    phase.value = ''
  }, 1600)
}

function reset(): void {
  clearStuckTimer()
  phase.value = ''
  errText.value = ''
  stuck.value = false
}

function cancel(): void {
  reset()
  visible.value = false
}

async function openTray(): Promise<void> {
  if (phase.value) return
  reset()
  phase.value = 'hiding'
  try {
    const w = await import('@tauri-apps/api/window')
    await w.getCurrentWindow().hide()
    visible.value = false
    return
  } catch (e1) {
    try {
      const core = await import('@tauri-apps/api/core')
      await core.invoke('window_action', { action: 'hide' })
      visible.value = false
      return
    } catch (e2) {
      phase.value = ''
      errText.value = t('app.close.err') + short(e2 || e1)
    }
  }
  armStuckWatch(t('app.close.tray'))
}

/** 0920：原来的「最小化」动作（minimizeWin）随文案一起撤掉了 —— 设计口径是
 *  "最小化的功能就是隐藏到托盘"，所以只留 openTray（窗口 hide，收进托盘、不占任务栏）。 */

async function quitApp(): Promise<void> {
  if (phase.value) return
  reset()
  phase.value = 'quitting'
  try {
    const core = await import('@tauri-apps/api/core')
    await core.invoke('window_action', { action: 'quit' })
  } catch (e) {
    phase.value = ''
    errText.value = t('app.close.err') + short(e)
    return
  }
  /* 命令返回了、进程却还活着 → 等 1.6s 看门狗把它摆到台面上 */
  armStuckWatch(t('app.close.quit'))
}

/* Esc：登记成"最上面一层"（0920）。
 * ★ 这条很关键：关窗询问出现时，底下可能还开着设置之类的弹窗；
 *   把 Esc 交给全局层级栈之后，询问框作为栈顶先吃到 Esc → 只取消询问，不会把下面的弹窗关掉。 */
useModalLayer(() => visible.value, () => cancel())

onMounted(async () => {
  if (!isTauriEnv) return
  try {
    const ev = await import('@tauri-apps/api/event')
    unlisten = await ev.listen('nis://close-requested', () => {
      reset()
      visible.value = true
      void nextTick(() => cardRef.value?.focus())
    })
    /* ★ 0919：告诉 Rust "关闭询问已经能收事件了"。
       在此之前（boot 页 / 接续帧的 ✕、以及启动早期的原生 ✕）Rust 会**直接退出**，
       免得拦下来却没人听 —— 反馈的"点 ✕ 没反应"就是那种情况。
       必须放在 listen 成功之后：提前置位会让早到的 ✕ 事件丢掉。 */
    const core_mod = await import('@tauri-apps/api/core')
    await core_mod.invoke('app_ui_ready').catch((err: unknown) => {
      console.warn('[close] app_ui_ready failed:', err)
    })
  } catch (e) {
    console.warn('[close] listen failed:', e)
  }
})

onUnmounted(() => {
  clearStuckTimer()
  if (unlisten) { try { unlisten() } catch { /* ignore */ } }
})
</script>

<template>
  <Teleport to="body">
    <div v-if="visible" class="cls-mask" @click.self="cancel">
      <div ref="cardRef" class="cls-card" role="dialog" aria-modal="true" tabindex="-1" aria-labelledby="cls-title">
        <div class="cls-head">
          <div class="cls-icon"><i class="fas fa-circle-question"></i></div>
          <div class="cls-headtext">
            <h3 id="cls-title" class="cls-title">{{ t('app.close.title') }}</h3>
            <p class="cls-msg">{{ t('app.close.msg') }}</p>
          </div>
          <!-- 0919 需求要求：取消按钮收进右上角的 ✕（等宽三按钮太挤） -->
          <button type="button" class="cls-x" :disabled="!!phase" :aria-label="t('app.close.cancel')" @click="cancel">
            <i class="fas fa-xmark"></i>
          </button>
        </div>

        <div class="cls-actions">
          <!-- 0920 设计口径：「最小化」实质就是**隐藏到托盘**（应用与后端继续在后台跑），
               所以文案改回「隐藏到托盘」，动作也走窗口 hide（收进托盘，不占任务栏） -->
          <button type="button" class="cls-btn cls-btn-tray" :disabled="!!phase" @click="openTray">
            <i class="fas fa-window-restore"></i>
            {{ phase === 'hiding' ? t('app.close.working') : t('app.close.tray') }}
          </button>
          <button type="button" class="cls-btn cls-btn-quit" :disabled="!!phase" @click="quitApp">
            <i class="fas fa-power-off"></i>
            {{ phase === 'quitting' ? t('app.close.working') : t('app.close.quit') }}
          </button>
        </div>

        <p v-if="errText" class="cls-err">{{ errText }}</p>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.cls-mask {
  position: fixed;
  inset: 0;
  z-index: 10080;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(17, 24, 39, 0.44);
}
.cls-card {
  width: 412px;
  max-width: calc(100vw - 40px);
  box-sizing: border-box;
  background: #ffffff;
  border: 1px solid #f0f0f3;
  border-radius: 18px;
  padding: 22px 22px 16px;
  box-shadow: 0 28px 70px -20px rgba(0, 0, 0, 0.5), 0 2px 8px rgba(0, 0, 0, 0.05);
  outline: none;
  animation: clsCardIn 0.22s cubic-bezier(0.16, 1, 0.3, 1);
  position: relative; /* 右上角 ✕ 的定位锚点 */
}
@keyframes clsCardIn {
  from { opacity: 0; transform: translateY(12px) scale(0.975); }
  to { opacity: 1; transform: none; }
}

/* 头部：图标 + 标题/说明（左对齐，读起来比居中舒服） */
.cls-head { display: flex; gap: 14px; align-items: flex-start; }
.cls-icon {
  flex: 0 0 auto;
  width: 44px;
  height: 44px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(124, 58, 237, 0.1);
  color: #7c3aed;
  font-size: 20px;
}
.cls-headtext { min-width: 0; padding-top: 1px; }
.cls-title {
  font-size: 15.5px;
  font-weight: 640;
  line-height: 1.4;
  color: #111827;
  margin: 0;
}
.cls-msg {
  margin: 5px 0 0;
  font-size: 12.5px;
  line-height: 1.75;
  color: #6b7280;
}

/* 动作区：右对齐，主按钮在最后（越靠右越是"主"） */
.cls-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 20px;
}
.cls-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  height: 36px;
  padding: 0 16px;
  border-radius: 11px;
  font-size: 12.5px;
  font-weight: 540;
  line-height: 1;
  cursor: pointer;
  white-space: nowrap;
  border: 1px solid transparent;
  transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease, opacity 0.15s ease;
}
.cls-btn i { font-size: 11px; }
/* 0920：去掉 min-height —— 之前取消按钮上移后，卡片底部留了一大块空白（反馈"布局差点意思"）。
   现在高度由内容决定：图标+标题说明 → 按钮行，收得干净。 */
.cls-x {
  position: absolute; top: 12px; right: 12px;
  width: 26px; height: 26px; border-radius: 8px; border: 0;
  display: flex; align-items: center; justify-content: center;
  font-size: 12px; color: #9ca3af; background: transparent; cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
}
.cls-x:not(:disabled):hover { background: #f3f4f6; color: #374151; }
.cls-x:disabled { opacity: 0.5; cursor: default; }
.cls-btn:focus-visible { outline: 2px solid #6366f1; outline-offset: 2px; }
.cls-btn:disabled { cursor: default; opacity: 0.6; }
.cls-btn-ghost { background: transparent; color: #6b7280; }
.cls-btn-ghost:not(:disabled):hover { background: #f3f4f6; color: #374151; }
.cls-btn-tray { background: #ffffff; border-color: #e5e7eb; color: #374151; }
.cls-btn-tray:not(:disabled):hover { border-color: #d1d5db; background: #fafafa; }
.cls-btn-quit { background: #000000; color: #ffffff; }
.cls-btn-quit:not(:disabled):hover { background: rgba(0, 0, 0, 0.82); }

.cls-err {
  margin: 12px 0 0;
  font-size: 11.5px;
  line-height: 1.7;
  color: #dc2626;
  word-break: break-all;
}
</style>

<style>
/* 深色适配（全局块，同其他组件惯例） */
html.dark .cls-card { background: #17171c; border-color: #2a2a33; }
html.dark .cls-title { color: #f0f0f4; }
html.dark .cls-msg { color: #9a9aa6; }
html.dark .cls-icon { background: rgba(124, 58, 237, 0.2); }
html.dark .cls-btn-ghost { color: #9a9aa6; }
html.dark .cls-btn-ghost:not(:disabled):hover { background: #26262d; color: #d4d4dc; }
html.dark .cls-btn-tray { background: #1c1c22; border-color: #33333d; color: #d4d4dc; }
html.dark .cls-btn-tray:not(:disabled):hover { border-color: #45454f; background: #22222a; }
html.dark .cls-btn-quit { background: #f0f0f4; color: #17171c; }
html.dark .cls-btn-quit:not(:disabled):hover { background: #ffffff; }
html.dark .cls-err { color: #f87171; }
html.dark .cls-foot { border-top-color: #26262e; color: #6f6f7a; }
</style>
