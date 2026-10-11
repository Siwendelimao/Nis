<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue'
import { useChatStore } from '@/stores/chat'
import { useConversationsStore } from '@/stores/conversations'
import SegTabs from './blocks/SegTabs.vue'
import { t } from '@/utils/i18n'
// 日志消息本地化：后端日志串为中文模板，按规则表渲染成当前语言（未命中则原样透出）
import { translateLog } from '@/utils/logText'

/**
 * 运行面板（右上角向下弹出的下拉面板）：会话执行时间线。
 * 单 agent = 会话日志（lifecycle/llm/tool/approval/install/mcp）；
 * 团队模式（后续）复用同一容器扩展编排树。
 * 自包含：自己拉 session.logs + 自己订阅 SSE session/log 帧。
 */
const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const chatStore = useChatStore()
const conversationsStore = useConversationsStore()
const convId = computed(() => String(conversationsStore.activeConversationId ?? ''))

interface LogEntry { t: number; level: string; category: string; message: string; data?: any }
const logs = ref<LogEntry[]>([])
const filter = ref<'all' | 'llm' | 'tool' | 'approval' | 'error'>('all')
const autoScroll = ref(true)
/** ★ 0924：日志行展开态（默认单行截断 → 点开看全文；长 JSON/命令不再把列表撑乱） */
const expanded = ref<Record<number, boolean>>({})
const listRef = ref<HTMLDivElement | null>(null)

const filtered = computed(() =>
  filter.value === 'all' ? logs.value : logs.value.filter(l => filter.value === 'error' ? l.level === 'error' : l.category === filter.value),
)

const CATEGORY_META: Record<string, { icon: string; color: string }> = {
  lifecycle: { icon: 'fa-bolt', color: 'text-indigo-500' },
  llm: { icon: 'fa-comment-dots', color: 'text-sky-500' },
  tool: { icon: 'fa-wrench', color: 'text-gray-500' },
  approval: { icon: 'fa-shield-halved', color: 'text-amber-500' },
  install: { icon: 'fa-box-open', color: 'text-teal-500' },
  mcp: { icon: 'fa-plug', color: 'text-violet-500' },
  session: { icon: 'fa-clock', color: 'text-gray-400' },
}
function meta(c: string) {
  return CATEGORY_META[c] || { icon: 'fa-circle', color: 'text-gray-400' }
}
function timeOf(t: number): string {
  const d = new Date(t)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
}

let loadSeq = 0
async function loadLogs() {
  if (!convId.value) { logs.value = []; return }
  // 代际守卫：快速切会话时旧会话的慢请求后到会覆盖新日志（"有时跟随有时不跟"的根因）
  const seq = ++loadSeq
  try {
    const v = await chatStore.bridgeRpc('session.logs', { sessionId: convId.value })
    if (seq !== loadSeq) return
    logs.value = Array.isArray(v?.logs) ? v.logs : []
    nextTick(scrollBottom)
  } catch { /* ignore */ }
}

function scrollBottom() {
  const el = listRef.value
  if (el && autoScroll.value) el.scrollTop = el.scrollHeight
}

// 实时追加：SSE session/log 帧（会话匹配才收）
function onFrame(frame: any) {
  if (!props.open) return
  const p = frame?.payload
  if (p?.type !== 'session/log' || p.sessionId !== convId.value) return
  logs.value.push(p.entry)
  if (logs.value.length > 2000) logs.value.splice(0, logs.value.length - 2000)
  nextTick(scrollBottom)
}
onMounted(() => {
  chatStore.onMessage(onFrame)
  // 面板经 v-if 挂载时 open 已是 true，watch(props.open) 不会触发——必须挂载即拉取历史日志
  loadLogs()
})
onUnmounted(() => chatStore.offMessage(onFrame))

watch(() => props.open, (v) => {
  if (v) { loadSeq += 1; logs.value = []; loadLogs() }
})
// 切会话跟随重拉：组件由 v-if 控制挂载（挂载即打开），不能判 props.open——
// 挂载处没传 open prop，恒 falsy，此 watch 从不触发（a→b→a 日志不跟随的根因）
watch(convId, () => {
  loadSeq += 1
  logs.value = []
  loadLogs()
})
watch(filtered, () => nextTick(scrollBottom))

/* ★ 0924（用户最终口径）：tabs 行**撑满整行**、右端与 × 右边缘对齐（而不是把 × 左移去迁就 tabs）。
   实现：SegTabs 自身是等分 flex（`.seg-item { flex:1 1 0 }`），给它的容器加 flex-1 就撑满；
   × 因此回到常规右端位置（面板右内边距），两者自然对齐。
   原来那套"量 tabs 宽度 → 用 marginRight 把 × 推回来"的测量代码随之删除（不再需要）。 */
</script>

<template>
  <!-- 右侧运行面板（占位一列，输入框/消息区向左让位）。
       0915：去掉 shrink-0 —— 右栏合计上限 35vw（见 ChatInterface.rightDocksWidth），
       超限时按各自宽度等比压缩（容器 overflow-hidden）；窄窗由 <1080px 保险丝整栏收起兜底。
       ★ 0924（需求要求"把右侧宽度收窄"）：380 → 320 —— 跟随挪到标题行后选项卡行只剩 5 个 tab，
       320 刚好容下，× 也随之贴到"错误"tab 右端（面板不再留一条空带）。 -->
  <div class="w-[300px] min-w-0 h-full bg-white border-l border-gray-200 flex flex-col overflow-hidden">
    <!-- 头部 -->
    <div class="px-3 pt-3 pb-2.5 border-b border-gray-100">
      <div ref="headHostEl" class="flex items-center justify-between mb-2.5">
        <div class="flex items-center gap-1.5 min-w-0">
          <span class="runlog-head-icon">
            <i class="fas fa-wave-square"></i>
          </span>
          <span class="text-[13px] font-[640] text-gray-800 truncate">{{ t('runlog.title') }}</span>
          <!-- ★ 0924 重做：跟随做成**小胶囊开关**（原来是个裸 checkbox 挂在标题右侧） -->
          <label class="runlog-follow" :title="t('runlog.follow')">
            <input v-model="autoScroll" type="checkbox" />
            <span>{{ t('runlog.follow') }}</span>
          </label>
        </div>
        <button class="runlog-close" :title="t('workspace.close')" @click="emit('close')">
          <i class="fas fa-xmark"></i>
        </button>
      </div>
      <!-- tabs 撑满整行 → 右端与上面的 × 右边缘对齐（设计口径） -->
      <div class="flex items-center">
        <SegTabs
          v-model="filter"
          size="xs"
          class="flex-1"
          :options="[{ id: 'all', label: t('skills.all') }, { id: 'llm', label: t('runlog.llm') }, { id: 'tool', label: t('plugins.tools') }, { id: 'approval', label: t('settings.notifications.permission') }, { id: 'error', label: t('settings.notifications.error') }]"
        />
      </div>
    </div>

    <!-- 时间线 -->
    <div ref="listRef" class="flex-1 min-h-0 overflow-y-auto custom-scroll px-2 py-2">
      <div v-if="filtered.length === 0" class="py-12 text-center">
        <i class="fas fa-wave-square text-xl text-gray-200 mb-2"></i>
        <p class="text-[12px] text-gray-400">{{ t('runlog.empty') }}</p>
      </div>
      <!-- ★ 0924 重做日志行（需求要求"每条都重新做一下"）：
           ① 默认**单行截断**（工具参数是长 JSON，原来一律折行 → 一屏看不了几条还错位）；
           ② **点任意一行展开全文**（展开后 pre-wrap，长命令/JSON 逐行可读）；
           ③ 类别图标统一成小圆片；④ error / warn 常态带色底。 -->
      <div
        v-for="(l, i) in filtered"
        :key="i"
        class="runlog-row"
        :class="{ 'is-open': !!expanded[i], 'is-err': l.level === 'error', 'is-warn': l.level === 'warn' }"
        @click="expanded[i] = !expanded[i]"
      >
        <span class="runlog-time">{{ timeOf(l.t) }}</span>
        <span class="runlog-ico"><i :class="['fas', meta(l.category).icon, meta(l.category).color]"></i></span>
        <span class="runlog-msg">{{ translateLog(l.message) }}</span>
        <i class="fas fa-chevron-down runlog-chev"></i>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* ★ 0924（需求要求"重新设计"）：头部件 —— 标题图标圆片 / 跟随小胶囊 / 关闭圆角方块 */
.runlog-head-icon {
  width: 20px; height: 20px; border-radius: 7px; flex: none;
  display: inline-flex; align-items: center; justify-content: center;
  background: linear-gradient(180deg, #f9fafb, #f3f4f6);
  border: 1px solid rgba(0, 0, 0, 0.05);
  color: #6b7280; font-size: 9px;
}
.runlog-follow {
  display: inline-flex; align-items: center; gap: 4px; flex: none;
  padding: 2px 8px 2px 6px; border-radius: 9999px;
  background: #f3f4f6; font-size: 10px; color: #6b7280;
  cursor: pointer; user-select: none; transition: background 0.15s;
}
.runlog-follow:hover { background: #e5e7eb; }
.runlog-follow input { width: 11px; height: 11px; accent-color: #111827; cursor: pointer; }
.runlog-close {
  width: 20px; height: 20px; border-radius: 7px; flex: none;
  display: inline-flex; align-items: center; justify-content: center;
  color: #9ca3af; font-size: 11px; transition: background 0.15s, color 0.15s;
}
.runlog-close:hover { background: #f3f4f6; color: #4b5563; }

/* ★ 0924 重做：日志行 —— 默认单行截断，点开看全文（长 JSON 不再把列表撑乱） */
.runlog-row {
  display: flex; align-items: flex-start; gap: 6px;
  padding: 5px 6px; border-radius: 8px;
  cursor: pointer; transition: background 0.12s;
}
.runlog-row:hover { background: #f8fafc; }
.runlog-row.is-open { background: #f8fafc; }
.runlog-row.is-warn { background: rgba(255, 251, 235, 0.7); }
.runlog-row.is-warn:hover { background: #fffbeb; }
.runlog-row.is-err { background: rgba(254, 242, 242, 0.8); }
.runlog-row.is-err:hover { background: #fef2f2; }
.runlog-time {
  flex: none; margin-top: 1px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 10px; line-height: 16px; color: #9ca3af;
  font-variant-numeric: tabular-nums;
}
.runlog-ico {
  width: 14px; height: 14px; border-radius: 9999px; flex: none;
  display: inline-flex; align-items: center; justify-content: center;
  background: #f1f5f9; margin-top: 1px; font-size: 7px;
}
.runlog-msg {
  flex: 1 1 auto; min-width: 0;
  font-size: 11.5px; line-height: 16px; color: #374151;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.runlog-row.is-open .runlog-msg { white-space: pre-wrap; word-break: break-word; overflow: visible; }
.runlog-row.is-err .runlog-msg { color: #dc2626; }
.runlog-row.is-warn .runlog-msg { color: #b45309; }
.runlog-chev { flex: none; margin-top: 4px; font-size: 8px; color: #cbd5e1; transition: transform 0.15s; }
.runlog-row.is-open .runlog-chev { transform: rotate(180deg); }

/* ★ 0930 深色适配（实测"深色下部分日志条浅色背景很刺眼"）：error/warn 色底与浅灰 hover
   全是写死的浅色十六进制 —— style.css 的类映射层罩不到 scoped 样式 ⇒ 深色主题下只剩这几条刺眼。
   口径同 BgTaskModal：html.dark 下整套重映射（纯黑色板 + 深色 amber/red 色底，文字换亮色）。 */
html.dark .runlog-head-icon { background: linear-gradient(180deg, #1d1d1d, #161616); border-color: rgba(255, 255, 255, 0.08); color: var(--nis-text-3); }
html.dark .runlog-follow { background: #262626; color: var(--nis-text-2); }
html.dark .runlog-follow:hover { background: #2e2e2e; }
html.dark .runlog-close { color: var(--nis-text-3); }
html.dark .runlog-close:hover { background: #262626; color: var(--nis-text-1); }
html.dark .runlog-row:hover { background: var(--nis-bg-hover); }
html.dark .runlog-row.is-open { background: var(--nis-bg-hover); }
html.dark .runlog-row.is-warn { background: rgba(146, 64, 14, 0.22); }
html.dark .runlog-row.is-warn:hover { background: rgba(146, 64, 14, 0.36); }
html.dark .runlog-row.is-err { background: rgba(127, 29, 29, 0.25); }
html.dark .runlog-row.is-err:hover { background: rgba(127, 29, 29, 0.4); }
html.dark .runlog-time { color: var(--nis-text-3); }
html.dark .runlog-ico { background: #262626; }
html.dark .runlog-msg { color: var(--nis-text-2); }
html.dark .runlog-row.is-err .runlog-msg { color: #f87171; }
html.dark .runlog-row.is-warn .runlog-msg { color: #fbbf24; }
html.dark .runlog-chev { color: var(--nis-text-4); }
</style>
