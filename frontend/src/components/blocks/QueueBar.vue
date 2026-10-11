<script setup lang="ts">
/**
 * QueueBar —— 排队消息条（0909⑦ 建；0911 多批改造）。
 * 后端 session.queuedMessages 账本的前端镜像（queue store），多条可：
 *  - 拖拽改顺序（HTML5 draggable，落点即 session.queue.move RPC）
 *  - 插话（不等本轮结束，立即注入进行中的回复 → session.steer）
 *  - 编辑（回灌编辑器，原条目删除；重发即新排队项）
 *  - 删除（乐观移除+RPC，后端快照回包覆盖）
 * 视觉（0911 第一批）：留白上移 10px / 输入框同款磨砂玻璃 / 折叠箭头方向修正。
 * 视觉（0911 第二批）：
 *  - 折叠态文字上下间距对称（shell 上下 6px + head 上下 3px）；
 *  - 三按钮悬停 = 正圆底（border-radius 50%）；图标 11→12px（22-12=10 → 边距 5px 整数，
 *    消除 11px 图标在 22px 按钮中半像素居中导致的「悬停时 icon 不居中」）；
 *  - 插话图标 = MessageSquareReply（对话气泡+回应，贴合「插话」语义）；
 *  - 自绘深色 tooltip（同设置页 HintTip 语言：#111827 白字圆角）；悬停 140ms 即现，移开即灭；
 *    弃用原生 title（系统样式不适配 + 出现慢 ~1s）。
 */
import { ref, onBeforeUnmount } from 'vue'
import { Layers, ChevronDown, GripVertical, MessageSquareReply, PenLine, X } from 'lucide-vue-next'
import { t } from '@/utils/i18n'
import { useQueueStore, type QueueItem } from '@/stores/queue'

const props = defineProps<{ convId: string | number | null | undefined; items: QueueItem[]; paused?: boolean }>()
const emit = defineEmits<{
  edit: [item: QueueItem]
  remove: [id: string]
  move: [id: string, to: number]
  steer: [item: QueueItem]
  /** ★0927 N1（乙）：暂停态下的「继续发送」/「全部撤回编辑」 */
  resume: []
  purgeAll: []
}>()

const queueStore = useQueueStore()
const collapsed = ref(false)
const dragId = ref<string | null>(null)
const overIdx = ref<number>(-1)

/* ── 自绘 tooltip（0911：原生 title 样式不适配 + 出现慢）── */
const tip = ref<{ text: string; x: number; y: number } | null>(null)
let tipTimer: ReturnType<typeof setTimeout> | undefined
function showTip(e: MouseEvent, text: string) {
  const el = e.currentTarget as HTMLElement
  if (!el) return
  const r = el.getBoundingClientRect()
  if (tipTimer) clearTimeout(tipTimer)
  tipTimer = setTimeout(() => {
    const half = 132
    const x = Math.min(Math.max(r.left + r.width / 2, half + 8), window.innerWidth - half - 8)
    tip.value = { text, x, y: r.top - 7 }
  }, 140)
}
function hideTip() {
  if (tipTimer) { clearTimeout(tipTimer); tipTimer = undefined }
  tip.value = null
}
onBeforeUnmount(() => { if (tipTimer) clearTimeout(tipTimer) })
function onSteer(item: QueueItem) { hideTip(); emit('steer', item) }
function onEdit(item: QueueItem) { hideTip(); emit('edit', item) }
function onRemove(id: string) { hideTip(); emit('remove', id) }

function onDragStart(id: string, e: DragEvent) {
  hideTip()
  dragId.value = id
  if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', id) }
}
function onDragOver(idx: number, e: DragEvent) {
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
  overIdx.value = idx
}
function onDrop(idx: number) {
  const id = dragId.value
  overIdx.value = -1
  dragId.value = null
  if (!id) return
  const cur = queueStore.get(props.convId).findIndex(q => q.id === id)
  if (cur < 0 || cur === idx) return
  emit('move', id, idx)
}
function onDragEnd() { dragId.value = null; overIdx.value = -1 }
</script>

<template>
  <div v-if="items.length" class="qb-anchor qb-in">
    <div class="qb-shell">
      <!-- 头部：计数+提示+折叠 -->
      <div class="qb-head flex items-center gap-2 cursor-pointer select-none" @click="collapsed = !collapsed">
        <Layers :size="11" :stroke-width="1.75" class="qb-ic" />
        <span class="text-[11px] font-[530] text-gray-600">{{ t('queue.title') }}</span>
        <span class="text-[11px] font-mono text-gray-400">{{ items.length }}</span>
        <span class="flex-1 min-w-0 truncate text-[10px] text-gray-400">{{ collapsed && items[0] ? String(items[0].text || '').replace(/\[\[图片:\d+\]\]/g, '') : t('queue.hint') }}</span>
        <!-- 折叠箭头：收起=▲（点击向上展开）/ 展开=▼（点击向下收起） -->
        <ChevronDown :size="11" :stroke-width="2" class="qb-ic transition-transform duration-200" :class="collapsed ? 'rotate-180' : ''" />
      </div>
      <!-- ★0927 N1（乙）：暂停态横幅 —— 明说"已暂停"并给两条出路（继续发送 / 全部撤回编辑），绝不静默卡住 -->
      <div v-if="paused" class="qb-paused flex items-center gap-1.5">
        <span class="flex-1 min-w-0 truncate text-[11px] text-amber-700">{{ t('queue.paused') }}</span>
        <button class="qb-btn2" @click.stop="emit('resume')">{{ t('queue.resume') }}</button>
        <button class="qb-btn2" @click.stop="emit('purgeAll')">{{ t('queue.purgeAll') }}</button>
      </div>
      <!-- 条目列表 -->
      <div v-show="!collapsed" class="qb-list custom-scroll">
        <div
          v-for="(q, i) in items"
          :key="q.id"
          class="qb-item flex items-center gap-2 px-2 py-1.5 rounded-lg"
          :class="[
            dragId === q.id ? 'qb-dragging' : '',
            overIdx === i && dragId && dragId !== q.id ? 'qb-over' : '',
          ]"
          draggable="true"
          @dragstart="onDragStart(q.id, $event)"
          @dragover="onDragOver(i, $event)"
          @drop="onDrop(i)"
          @dragend="onDragEnd"
        >
          <GripVertical
            :size="11" :stroke-width="1.75" class="qb-grip qb-ic shrink-0 cursor-grab"
            @mouseenter="showTip($event, t('queue.dragTip'))" @mouseleave="hideTip"
          />
          <span class="text-[10px] font-mono text-gray-400 shrink-0">#{{ i + 1 }}</span>
          <span class="flex-1 min-w-0 text-[12px] text-gray-700 flex items-center gap-1" :title="String(q.text || '').replace(/\[\[图片:\d+\]\]/g, '')">
            <!-- 0925：排队项也显示图片缩略图（最多 2 张 + 溢出计数）——原来只有一个小图标，
                 带头像的排队消息看不出带了几张图 -->
            <template v-if="q.attachments?.length">
              <img
                v-for="(a, ai) in q.attachments.slice(0, 2)"
                :key="ai"
                :src="a.dataUrl"
                class="w-4 h-4 rounded object-cover shrink-0 border border-black/10"
                alt=""
              />
              <span v-if="q.attachments.length > 2" class="text-[10px] text-gray-400 shrink-0">+{{ q.attachments.length - 2 }}</span>
            </template>
            <span class="truncate">{{ String(q.text || '').replace(/\[\[图片:\d+\]\]/g, '') }}</span>
          </span>
          <button class="qb-btn shrink-0" @mouseenter="showTip($event, t('queue.steer'))" @mouseleave="hideTip" @click.stop="onSteer(q)"><MessageSquareReply :size="12" :stroke-width="1.75" /></button>
          <button class="qb-btn shrink-0" @mouseenter="showTip($event, t('queue.edit'))" @mouseleave="hideTip" @click.stop="onEdit(q)"><PenLine :size="12" :stroke-width="1.75" /></button>
          <button class="qb-btn qb-btn-del shrink-0" @mouseenter="showTip($event, t('queue.remove'))" @mouseleave="hideTip" @click.stop="onRemove(q.id)"><X :size="12" :stroke-width="2" /></button>
        </div>
      </div>
    </div>
    <!-- 自绘 tooltip：深色气泡（同应用 HintTip 语言），出现在按钮正上方 -->
    <Teleport to="body">
      <Transition name="qb-tip">
        <span
          v-if="tip"
          class="qb-tip"
          :style="{ left: tip.x + 'px', top: tip.y + 'px' }"
        >{{ tip.text }}</span>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
/* 根容器：绝对定位、零布局占位（不撑高输入框）。卡片底边 = 输入框顶边上方 10px。
   position/z-index 必须 !important：.input-shell > *（0-2-0）会盖过 scoped 单类选择器把根压成 relative。 */
.qb-anchor {
  position: absolute !important;
  left: 0;
  right: 0;
  bottom: calc(100% + 10px);
  z-index: 0 !important;
}
.qb-in { animation: qb-rise 0.26s cubic-bezier(0.22, 0.9, 0.36, 1); }
@keyframes qb-rise {
  from { transform: translateY(14px); opacity: 0.4; }
  to { transform: translateY(0); opacity: 1; }
}
/* 磨砂玻璃卡片（输入框同款材质；深色模式见下方全局块）。
   0911 二批：padding 上下对称 6px（原 6/8）——折叠态文字上下间距对称的前提之一 */
.qb-shell {
  background: linear-gradient(160deg, rgba(255, 255, 255, 0.66) 0%, rgba(255, 255, 255, 0.5) 100%);
  backdrop-filter: blur(16px) saturate(1.6);
  -webkit-backdrop-filter: blur(16px) saturate(1.6);
  border: 1px solid rgba(229, 231, 235, 0.85);
  border-radius: 14px;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.9), 0 8px 24px rgba(0, 0, 0, 0.08), 0 2px 6px rgba(0, 0, 0, 0.04);
  padding: 6px 10px 6px;
}
/* 0911 二批：上下对称 3px（原 2/4）——折叠态（仅头部可见）文字上下间距相等 */
.qb-head { padding: 3px 2px 3px; }
.qb-ic { color: #9ca3af; }
.qb-list { display: flex; flex-direction: column; gap: 2px; max-height: 172px; overflow-y: auto; }
.qb-item { transition: background 0.15s ease, opacity 0.15s ease; }
.qb-item:hover { background: rgba(0, 0, 0, 0.035); }
.qb-dragging { opacity: 0.4; }
.qb-over { box-shadow: inset 0 2px 0 0 rgba(17, 24, 39, 0.5); }
/* 按钮常显；0911 二批：悬停为正圆底（50%），图标 12px（整除居中） */
.qb-btn {
  width: 22px; height: 22px; border-radius: 50%; border: none; background: transparent;
  color: #9ca3af; cursor: pointer; display: inline-flex; align-items: center; justify-content: center;
  transition: background 0.15s ease, color 0.15s ease;
}
.qb-btn:hover { background: rgba(0, 0, 0, 0.07); color: #374151; }
.qb-btn-del:hover { color: #ef4444; }
/* ★0927 N1（乙）：暂停横幅（琥珀提示 + 两个胶囊按钮；纯状态提示，不用 backdrop-filter 叠层） */
.qb-paused {
  margin: 0 2px 4px;
  padding: 4px 8px;
  border-radius: 9px;
  background: rgba(251, 191, 36, 0.14);
  border: 1px solid rgba(251, 191, 36, 0.35);
}
.qb-btn2 {
  border: 1px solid rgba(180, 130, 20, 0.35);
  background: rgba(255, 255, 255, 0.75);
  color: #92400e;
  font-size: 11px;
  line-height: 1;
  padding: 4px 8px;
  border-radius: 999px;
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
}
.qb-btn2:hover { background: #fff; color: #78350f; }
</style>

<style>
/* 深色（全局选择器，html.dark 在 scoped 下组件根类拿不到 data-v 的稳妥写法） */
html.dark .qb-shell {
  background: rgba(17, 17, 17, 0.62);
  border-color: #2a2a2e;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.06), 0 8px 24px rgba(0, 0, 0, 0.45), 0 2px 6px rgba(0, 0, 0, 0.3);
}
html.dark .qb-head .text-gray-600 { color: #c9c9d1; }
html.dark .qb-ic { color: #6f6f78; }
html.dark .qb-item:hover { background: rgba(255, 255, 255, 0.06); }
html.dark .qb-item .text-gray-700 { color: #d6d6de; }
html.dark .qb-btn { color: #6f6f78; }
html.dark .qb-btn:hover { background: rgba(255, 255, 255, 0.1); color: #e9e9ef; }
/* ★0927 N1：暂停横幅（深色） */
html.dark .qb-paused { background: rgba(251, 191, 36, 0.12); border-color: rgba(251, 191, 36, 0.28); }
html.dark .qb-paused .text-amber-700 { color: #fcd34d; }
html.dark .qb-btn2 { background: rgba(255, 255, 255, 0.08); border-color: rgba(251, 191, 36, 0.3); color: #fcd34d; }
html.dark .qb-btn2:hover { background: rgba(255, 255, 255, 0.16); color: #fde68a; }
/* 自绘 tooltip（Teleport 到 body，fixed 定位；深色气泡与 HintTip 同款语言） */
.qb-tip {
  position: fixed;
  z-index: 10060;
  transform: translate(-50%, -100%);
  background: #111827;
  color: #fff;
  font-size: 11px;
  line-height: 1.5;
  border-radius: 10px;
  padding: 5px 10px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.22);
  pointer-events: none;
  white-space: normal;
  max-width: min(280px, calc(100vw - 16px));
  text-align: center;
}
.qb-tip-enter-active { transition: opacity 0.12s ease, transform 0.12s ease; }
.qb-tip-leave-active { transition: opacity 0.1s ease; }
.qb-tip-enter-from { opacity: 0; transform: translate(-50%, calc(-100% + 3px)); }
.qb-tip-leave-to { opacity: 0; transform: translate(-50%, -100%); }
</style>
