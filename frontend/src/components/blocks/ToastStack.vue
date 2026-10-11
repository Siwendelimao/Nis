<script setup lang="ts">
/**
 * 顶部通知条（toasts）渲染层 —— 0911 接通。
 *
 * 背景：notificationsStore.toasts 一直被 push() 填充，但**从未有任何渲染组件**，
 * 且 push() 读的是 msg.message、20 处调用点传的却是 content → 队列/发送/上传失败提示
 * 全部被静默吞掉（历史死渠道）。此处补齐渲染 + 字段兼容（见 stores/notifications.ts）。
 *
 * 形态：顶部居中堆叠，message/success 4s、warning 6s、error 8s 自动消失；可点 X 立即关闭。
 * 主题：浅色白底深字、深色 #1f2430 底浅字（与设置页 HintTip / 队列卡 .qb-tip 同一套语言）。
 */
import { watch, onUnmounted } from 'vue'
import { useNotificationsStore } from '@/stores/notifications'
import type { NotificationItem } from '@/stores/notifications'
import { t } from '@/utils/i18n'

const notificationsStore = useNotificationsStore()

/** 每条 toast 的自动消失定时器 */
const timers = new Map<number, number>()

function lifespan(item: NotificationItem): number {
  if (item.type === 'error') return 8000
  if (item.type === 'warning') return 6000
  return 4000
}

function clearTimer(id: number) {
  const h = timers.get(id)
  if (h != null) {
    clearTimeout(h)
    timers.delete(id)
  }
}

function dismiss(id: number) {
  clearTimer(id)
  notificationsStore.remove(id)
}

watch(
  () => notificationsStore.toasts.map(x => x.id).join(','),
  () => {
    const live = notificationsStore.toasts
    for (const item of live) {
      if (!timers.has(item.id)) {
        timers.set(item.id, window.setTimeout(() => dismiss(item.id), lifespan(item)))
      }
    }
    const ids = new Set(live.map(x => x.id))
    for (const id of Array.from(timers.keys())) {
      if (!ids.has(id)) clearTimer(id)
    }
  },
  { immediate: true },
)

onUnmounted(() => {
  for (const h of timers.values()) clearTimeout(h)
  timers.clear()
})

/** 类型 → 图标 / 色（浅色与深色各一套，避免硬编码色在深色下不可读） */
const TYPE_META: Record<string, { icon: string; cls: string }> = {
  message: { icon: 'fas fa-circle-info', cls: 'text-slate-500 dark:text-slate-300' },
  success: { icon: 'fas fa-circle-check', cls: 'text-emerald-500 dark:text-emerald-400' },
  warning: { icon: 'fas fa-triangle-exclamation', cls: 'text-amber-500 dark:text-amber-400' },
  error: { icon: 'fas fa-circle-xmark', cls: 'text-red-500 dark:text-red-400' },
}
function typeMeta(type: string) {
  return TYPE_META[type] || TYPE_META.message
}

/** 点动作按钮：当前无调用方依赖动作语义，先做「点了即关」（后续要接语义在此处派发） */
function onAction(id: number) {
  dismiss(id)
}

</script>

<template>
  <div v-if="notificationsStore.toasts.length" class="toast-host" aria-live="polite">
    <TransitionGroup name="toast">
      <div
        v-for="item in notificationsStore.toasts"
        :key="item.id"
        class="toast-card"
      >
        <i :class="[typeMeta(item.type).icon, typeMeta(item.type).cls, 'toast-ic']"></i>
        <div class="toast-body">
          <div class="toast-text">{{ item.text }}</div>
          <div v-if="item.actions && item.actions.length" class="toast-actions">
            <button
              v-for="a in item.actions"
              :key="a.id"
              class="toast-action"
              @click="onAction(item.id)"
            >{{ a.label }}</button>
          </div>
        </div>
        <button class="toast-close" :title="t('notice.dismiss')" :aria-label="t('notice.dismiss')" @click="dismiss(item.id)">
          <i class="fas fa-xmark"></i>
        </button>
      </div>
    </TransitionGroup>
  </div>
</template>

<style scoped>
.toast-host {
  position: fixed;
  top: 14px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 10050;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  pointer-events: none;
  max-width: min(560px, calc(100vw - 32px));
}
.toast-card {
  pointer-events: auto;
  display: flex;
  align-items: flex-start;
  gap: 9px;
  min-width: 260px;
  max-width: 100%;
  padding: 10px 12px;
  border-radius: 12px;
  background: #ffffff;
  border: 1px solid rgba(0, 0, 0, 0.08);
  box-shadow: 0 10px 30px -12px rgba(0, 0, 0, 0.28);
}
html.dark .toast-card {
  background: #1f2430;
  border-color: rgba(255, 255, 255, 0.1);
  box-shadow: 0 10px 30px -12px rgba(0, 0, 0, 0.6);
}
.toast-ic {
  font-size: 14px;
  line-height: 18px;
  margin-top: 1px;
  flex-shrink: 0;
}
.toast-body {
  flex: 1;
  min-width: 0;
}
.toast-text {
  font-size: 12.5px;
  line-height: 1.45;
  font-weight: 530;
  color: #1f2937;
  word-break: break-word;
}
html.dark .toast-text { color: #e8eaf0; }
.toast-actions {
  display: flex;
  gap: 6px;
  margin-top: 6px;
}
.toast-action {
  font-size: 11px;
  font-weight: 640;
  padding: 3px 9px;
  border-radius: 7px;
  border: 1px solid rgba(0, 0, 0, 0.1);
  background: #f9fafb;
  color: #374151;
  cursor: pointer;
}
.toast-action:hover { background: #f3f4f6; }
html.dark .toast-action {
  background: rgba(255, 255, 255, 0.06);
  border-color: rgba(255, 255, 255, 0.12);
  color: #cfd3dc;
}
html.dark .toast-action:hover { background: rgba(255, 255, 255, 0.12); }
.toast-close {
  flex-shrink: 0;
  width: 20px;
  height: 20px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: #9ca3af;
  font-size: 11px;
  cursor: pointer;
}
.toast-close:hover { color: #4b5563; background: rgba(0, 0, 0, 0.05); }
html.dark .toast-close:hover { color: #e8eaf0; background: rgba(255, 255, 255, 0.1); }

/* 进场：自上滑入淡入；离场：淡出上移 */
.toast-enter-active, .toast-leave-active { transition: opacity 0.22s ease, transform 0.22s cubic-bezier(0.32, 0.72, 0, 1); }
.toast-enter-from { opacity: 0; transform: translateY(-10px) scale(0.98); }
.toast-leave-to { opacity: 0; transform: translateY(-6px) scale(0.98); }
.toast-move { transition: transform 0.22s cubic-bezier(0.32, 0.72, 0, 1); }
</style>
