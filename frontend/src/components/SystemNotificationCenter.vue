<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { Bell, CircleCheck, TriangleAlert, CircleX } from 'lucide-vue-next'
import { useNotificationsStore } from '@/stores/notifications'
import { useSettingsStore } from '@/stores/settings'
import { t } from '@/utils/i18n'

const notificationsStore = useNotificationsStore()
const settingsStore = useSettingsStore()

const open = ref(false)
const bellRef = ref<HTMLElement | null>(null)
const panelRef = ref<HTMLElement | null>(null)
const removingId = ref(0)
const clearingAll = ref(false)
/** 面板位置（left/top，视口坐标）。0920 改：原先用 `bottom` + 硬编码高度 420 估算，
 *  窗口一矮面板顶部就顶出视口被裁（实测）。现在按**可用空间**算，保证完整可见。 */
const pos = ref({ left: 0, top: 0 })
/** 列表区最大高度（跟着可用空间走，不再写死 420） */
const listMaxH = ref(420)
const PANEL_W = 320
const GAP = 8          // 面板与视口/铃铛的最小间隙
const PANEL_HEAD = 46  // 面板头部（标题行 + 全部已读/清空）高度
const LIST_MIN = 120   // 列表最小可用高度（再挤也得能看几行）

const items = computed(() => notificationsStore.system)
const unreadCount = computed(() => notificationsStore.unreadSystemCount)

/**
 * 算面板位置。铁律（MEMORY 里那条）：**浮层必须完整收进视口**，位置走响应式 state。
 * 铃铛现在挂在标题栏右上角，上方基本没空间 → 优先往下弹；下方也不够就压缩列表高度，
 * 最后再 clamp 一次，任何窗口尺寸下都不会出现"顶部被裁"。
 */
function positionPanel() {
  const el = bellRef.value
  if (!el) return
  const r = el.getBoundingClientRect()
  const vw = window.innerWidth
  const vh = window.innerHeight

  // ① 水平：优先贴铃铛右侧，右边放不下就改为右对齐视口右边（保证整块可见）
  let left = r.right + GAP
  if (left + PANEL_W > vw - GAP) left = Math.max(GAP, vw - GAP - PANEL_W)

  // ② 垂直：先看铃铛下方/上方各有多少可用高度
  const below = vh - r.bottom - GAP * 2
  const above = r.top - GAP * 2
  let listH: number
  let top: number
  if (below >= LIST_MIN + PANEL_HEAD) {
    listH = Math.min(420, below - PANEL_HEAD)
    top = r.bottom + GAP
  } else if (above >= LIST_MIN + PANEL_HEAD) {
    listH = Math.min(420, above - PANEL_HEAD)
    top = r.top - GAP - PANEL_HEAD - listH
  } else {
    // 上下都紧张（小窗口）：占较高的那侧并压缩列表
    const useBelow = below >= above
    listH = Math.max(LIST_MIN * 0.6, (useBelow ? below : above) - PANEL_HEAD)
    top = useBelow ? r.bottom + GAP : Math.max(GAP, r.top - GAP - PANEL_HEAD - listH)
  }
  // ③ 兜底 clamp：绝不允许超出视口（含顶部）
  top = Math.max(GAP, Math.min(top, vh - GAP - (PANEL_HEAD + listH)))

  pos.value = { left, top }
  listMaxH.value = Math.max(LIST_MIN * 0.6, listH)
}

function onBellClick() {
  open.value = !open.value
  if (open.value) positionPanel()
}

function onClickOutside(e: MouseEvent) {
  if (!open.value) return
  const path = (e.composedPath?.() || []) as unknown[]
  const isInside =
    path.includes(bellRef.value) ||
    path.includes(panelRef.value) ||
    (panelRef.value
      ? path.some(el => el instanceof Node && panelRef.value!.contains(el))
      : false)
  if (isInside) return
  open.value = false
}

// 新系统通知到达 → 自动展开一次（不随聊天窗口关闭）
// 0920：静默条目（AI 回复完成这类高频常驻记录）**不自动弹开**——否则每次回复都抢焦点；
// 审批/错误这类要人搭理的仍然自动展开。
watch(() => notificationsStore.system.length, (len, old) => {
  if (len <= old) return
  if (notificationsStore.system[0]?.silent) return
  positionPanel()
  open.value = true
})

onMounted(() => {
  document.addEventListener('click', onClickOutside)
/* 0927 netfix: 具名 resize 监听 + 卸载移除（原匿名监听泄漏） */
const onSncResize = () => { if (open.value) positionPanel() }
  window.addEventListener('resize', onSncResize)
})
onUnmounted(() => {
  window.removeEventListener('resize', onSncResize)
  document.removeEventListener('click', onClickOutside)
})

function toggleRead(id: number) {
  const item = notificationsStore.system.find(x => x.id === id)
  if (item) notificationsStore.markSystemRead(id)
}

/** 0920：点「查看对话」→ 收起面板 + 直接打开对应会话（会话已被删则只标已读，不报错） */
function viewConversation(item: { id: number; sessionId?: string }) {
  notificationsStore.markSystemRead(item.id)
  const sid = item.sessionId
  if (!sid) return
  void import('@/stores/conversations').then((m) => {
    const store = m.useConversationsStore()
    if (!store.getById(sid)) return
    open.value = false
    void store.openConversation(sid)
  }).catch(() => { /* ignore */ })
}

/* ── 0920 动画（用户：通知也要有动效）──
   删除/清空都**先播完退出动画再动数据**，否则列表会"啪"地跳一下。
   时长与 CSS 里的 .22s/.18s 对齐；用定时器而不依赖 Transition 的钩子，逻辑更直白。 */
const ROW_LEAVE_MS = 180
const LIST_LEAVE_MS = 200

function removeWithAnim(id: number) {
  if (removingId.value === id) return
  removingId.value = id
  setTimeout(() => {
    notificationsStore.removeSystem(id)
    removingId.value = 0
  }, ROW_LEAVE_MS)
}

function clearAllWithAnim() {
  if (!items.value.length || clearingAll.value) return
  clearingAll.value = true
  setTimeout(() => {
    notificationsStore.clearSystem()
    clearingAll.value = false
  }, LIST_LEAVE_MS)
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}

function formatDate(ts: number): string {
  const d = new Date(ts)
  const today = new Date()
  const sameDay = d.toDateString() === today.toDateString()
  if (sameDay) return formatTime(ts)
  return `${d.getMonth() + 1}/${d.getDate()} ${formatTime(ts)}`
}

/**
 * 条目图标：0920 从 FontAwesome 实心（fa-bell / fa-circle-check…）换成 **lucide 线性图标**，
 * 并缩到 12px —— 实心图标在 13px 下比周围文字重一大截，看着"顶"（截图指出）。
 */
function typeIcon(type: string) {
  switch (type) {
    case 'success': return CircleCheck
    case 'warning': return TriangleAlert
    case 'error': return CircleX
    default: return Bell
  }
}

function typeIconColor(type: string): string {
  switch (type) {
    case 'success': return 'text-emerald-500'
    case 'warning': return 'text-amber-500'
    case 'error': return 'text-red-500'
    default: return 'text-gray-400'
  }
}

// 类别文案（设置「系统提示」四类事件）
function categoryLabel(cat: string): string {
  switch (cat) {
    case 'permission': return t('settings.notifications.permission')
    case 'error': return t('settings.notifications.error')
    case 'memory': return t('settings.notifications.memory')
    default: return t('settings.notifications.agent')
  }
}

// 设置开关状态：某类关闭时提示
function categoryOff(cat: string): boolean {
  switch (cat) {
    case 'permission': return !settingsStore.notify.permission
    case 'error': return !settingsStore.notify.error
    case 'memory': return !settingsStore.notify.memory
    default: return !settingsStore.notify.agent
  }
}

/** 条目入场错峰：越靠下的越晚一点（最多给 8 条加延迟，多了会显得拖沓） */
function rowDelay(i: number): string {
  return Math.min(i, 8) * 32 + 'ms'
}
</script>

<template>
  <div ref="bellRef" class="relative">
    <button
      @click="onBellClick"
      class="w-9 h-9 sidebar-gear relative flex items-center justify-center rounded-xl hover:bg-gray-100 transition-colors"
      :title="t('notification.systemCenter')"
    >
      <!-- 0920：铃铛换线性图标（原来 fa-bell 是实心，跟旁边的线性图标不搭），16px -->
      <Bell :size="16" :stroke-width="1.9" />
      <span
        v-if="unreadCount > 0"
        :key="unreadCount"
        class="absolute top-0.5 right-0.5 min-w-[15px] h-[15px] px-1 rounded-full bg-red-500 text-white text-[9px] font-medium flex items-center justify-center shadow-sm notif-badge-pop"
      >{{ unreadCount > 99 ? '99+' : unreadCount }}</span>
    </button>

    <Teleport to="body">
      <Transition name="panel-fold">
        <div
          v-if="open"
          ref="panelRef"
          class="fixed z-[9999] bg-white rounded-2xl shadow-2xl border border-gray-100 overflow-hidden panel-origin"
          :style="{ left: pos.left + 'px', top: pos.top + 'px', width: PANEL_W + 'px' }"
        >
          <div class="flex items-center justify-between px-4 py-3">
            <span class="text-[13px] font-semibold text-gray-800">{{ t('notification.systemCenter') }}</span>
            <div class="flex items-center gap-1">
              <button
                v-if="items.length"
                @click="notificationsStore.markAllSystemRead()"
                class="px-2 py-1 text-[11px] text-gray-500 hover:text-gray-800 hover:bg-gray-100 rounded-lg transition-colors"
              >{{ t('notification.markAllRead') }}</button>
              <button
                v-if="items.length"
                :disabled="clearingAll"
                @click="clearAllWithAnim()"
                class="px-2 py-1 text-[11px] text-gray-500 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors disabled:opacity-50"
              >{{ t('notification.clearAll') }}</button>
            </div>
          </div>

          <!-- 列表高度跟着可用空间走（见 positionPanel 的 listMaxH）——写死 420 会在矮窗口里把面板顶出视口 -->
          <!-- 0920：条目之间的分隔横线全部去掉（反馈太碎）；靠 hover 底色区分每一条 -->
          <div
            class="overflow-y-auto custom-scroll px-1.5 pb-1.5 notif-list"
            :class="clearingAll ? 'is-clearing' : ''"
            :style="{ maxHeight: listMaxH + 'px' }"
          >
            <div v-if="!items.length" class="px-4 py-10 text-center">
              <Bell :size="26" :stroke-width="1.5" class="text-gray-200 mx-auto mb-2" />
              <p class="text-xs text-gray-400">{{ t('notification.empty') }}</p>
            </div>
            <div
              v-for="(item, i) in items"
              :key="item.id"
              class="notif-row group flex items-start gap-2.5 px-2.5 py-2.5 rounded-xl hover:bg-gray-50/80 cursor-pointer transition-colors"
              :class="[item.read ? 'opacity-55' : '', removingId === item.id ? 'is-removing' : '']"
              :style="{ animationDelay: rowDelay(i) }"
              @click="toggleRead(item.id)"
            >
              <component
                :is="typeIcon(item.type)"
                :size="12"
                :stroke-width="2.2"
                class="mt-0.5 flex-shrink-0"
                :class="typeIconColor(item.type)"
              />
              <div class="flex-1 min-w-0">
                <div class="flex items-center gap-2">
                  <span class="text-[13px] font-medium text-gray-800 truncate">{{ item.title }}</span>
                  <span v-if="!item.read" class="w-1.5 h-1.5 rounded-full bg-red-500 flex-shrink-0"></span>
                  <!-- 0920：单条清除（悬停才显形，平时不抢视线）
                       ★1013e：**常驻条目不给关闭按钮**（用户："常驻一个不可以关的通知"）——
                       要它消失只能把状态修好（如去设置里配好后台模型） -->
                  <button
                    v-if="!item.sticky"
                    class="ml-auto flex-none w-5 h-5 flex items-center justify-center rounded-md text-gray-300 opacity-0 group-hover:opacity-100 hover:text-red-500 hover:bg-red-50 transition-all"
                    :title="t('notification.clearOne')"
                    @click.stop="removeWithAnim(item.id)"
                  >
                    <i class="fas fa-times text-[10px]"></i>
                  </button>
                  <span
                    v-else
                    class="ml-auto flex-none text-[9px] px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-600 dark:bg-amber-500/20 dark:text-amber-400"
                  >{{ t('notification.stickyTag') }}</span>
                </div>
                <p
                  v-if="item.message"
                  class="text-[11px] text-gray-500 mt-0.5 break-words whitespace-pre-line line-clamp-2"
                  :title="item.message"
                >{{ item.message }}</p>
                <div class="flex items-center gap-2 mt-1">
                  <span class="text-[10px] text-gray-400">{{ formatDate(item.time) }}</span>
                  <span
                    class="text-[10px] px-1.5 py-0.5 rounded-full border"
                    :class="categoryOff(item.category) ? 'text-gray-400 border-gray-200' : 'text-gray-500 border-gray-200'"
                  >{{ categoryLabel(item.category) }}</span>
                  <!-- 0920：带会话的条目给一个直达按钮（反馈：提醒里要能一键跳过去） -->
                  <button
                    v-if="item.sessionId"
                    @click.stop="viewConversation(item)"
                    class="ml-auto flex-none flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-md text-blue-600 hover:bg-blue-50 dark:text-blue-400 dark:hover:bg-blue-500/15 transition-colors"
                  >
                    <i class="fas fa-arrow-up-right-from-square text-[9px]"></i>{{ t('notification.viewChat') }}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
/* 面板进出场：从铃铛那一角"长出来"（transform-origin 在右上角） */
.panel-origin { transform-origin: top right; }
.panel-fold-enter-active {
  transition: opacity 0.2s ease, transform 0.26s cubic-bezier(0.16, 1, 0.3, 1);
}
.panel-fold-leave-active {
  transition: opacity 0.14s ease, transform 0.14s ease;
}
.panel-fold-enter-from,
.panel-fold-leave-to {
  opacity: 0;
  transform: scale(0.92) translateY(-8px);
}

/* 条目的入场（错峰）与退场（单条删除 / 整体清空） */
@keyframes notifRowIn {
  from { opacity: 0; transform: translateY(-6px); }
  to { opacity: 1; transform: translateY(0); }
}
.notif-row { animation: notifRowIn 0.26s cubic-bezier(0.16, 1, 0.3, 1) both; }
.notif-row.is-removing {
  animation: none;
  opacity: 0 !important;
  transform: translateX(14px) scale(0.98);
  transition: opacity 0.18s ease, transform 0.18s ease;
  pointer-events: none;
}
.notif-list.is-clearing .notif-row {
  animation: none;
  opacity: 0 !important;
  transform: translateY(-6px);
  transition: opacity 0.2s ease, transform 0.2s ease;
  pointer-events: none;
}

/* 未读角标：数字变化时轻轻弹一下 */
@keyframes notifBadgePop {
  0% { transform: scale(0.6); }
  60% { transform: scale(1.14); }
  100% { transform: scale(1); }
}
.notif-badge-pop { animation: notifBadgePop 0.28s cubic-bezier(0.34, 1.6, 0.64, 1); }
</style>
