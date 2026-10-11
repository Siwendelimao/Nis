<script setup lang="ts">
/**
 * HintTip —— 小节标题后的「?」提示 icon：悬停浮出深色说明气泡。
 * 0907：设置页长说明收进这里，不再占用版面。
 * ① 气泡 Teleport 到 body + fixed——设置弹窗根 overflow-hidden、内容列 overflow-y-auto，
 *    内部 absolute 浮层出块即被裁（实测半截消失）；body 层跳出全部裁切链。
 * ② 气泡本身可承接 hover：icon mouseleave → 延迟关闭；指针进入气泡 → 取消关闭；
 *    出气泡 → 再延迟关闭。两全"移过去读长文"与"移开即走"，无闪断死循环。
 * 用法：<HintTip text="一句说明" />（放在标题 flex 行内）
 */
import { ref, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { Info } from 'lucide-vue-next'
import { t } from '@/utils/i18n'

defineProps<{ text: string }>()
const show = ref(false)
const pos = ref({ left: 0, bottom: 0 })
const anchorRef = ref<HTMLElement | null>(null)
const popRef = ref<HTMLElement | null>(null)
let closeTimer: ReturnType<typeof setTimeout> | undefined
/** ★ 0923：兜底定时器（最长驻留 10s，防"悬停提示卡在界面上不消失"） */
let hardTimer: ReturnType<typeof setTimeout> | undefined

async function open() {
  if (closeTimer) { clearTimeout(closeTimer); closeTimer = undefined }
  /* ★ 0923 兜底：无论后面发生什么（鼠标被别的窗口抢走、mouseleave 丢失、宿主被顶掉），
     10 秒后一定自己收掉 —— 旧版偶尔出现"悬停提示卡在界面上不消失"。 */
  if (hardTimer) clearTimeout(hardTimer)
  hardTimer = setTimeout(() => { show.value = false; hardTimer = undefined }, 10000)
  const r = anchorRef.value?.getBoundingClientRect()
  if (!r) return
  // 预估上限宽定位 → 渲染后按实测宽修正（同一帧内，不可见跳位）
  const estW = Math.min(280, window.innerWidth - 16)
  const clampX = (w: number) => Math.max(8, Math.min(r.left + r.width / 2 - w / 2, window.innerWidth - w - 8))
  pos.value = { left: clampX(estW), bottom: window.innerHeight - r.top + 8 }
  show.value = true
  await nextTick()
  const w = popRef.value?.offsetWidth || estW
  pos.value = { ...pos.value, left: clampX(w) }
}
function scheduleClose() {
  if (closeTimer) clearTimeout(closeTimer)
  closeTimer = setTimeout(() => { show.value = false; closeTimer = undefined }, 140)
}
function cancelClose() { if (closeTimer) { clearTimeout(closeTimer); closeTimer = undefined } }

/* ★ 0923：「卡在界面上不消失」的四个堵口（各有真实触发场景，任一都能单独造成残留） */
function closeNow() {
  show.value = false
  if (closeTimer) { clearTimeout(closeTimer); closeTimer = undefined }
  if (hardTimer) { clearTimeout(hardTimer); hardTimer = undefined }
}
/** ① 页面滚动/缩放：浮层是 fixed 定位、不会跟着宿主走，留着就是"卡住" → 直接收掉 */
function onViewportChange() { if (show.value) closeNow() }
/** ② 窗口失焦（切到别的应用）：鼠标再也不会回来触发 mouseleave → 收掉 */
function onWinBlur() { if (show.value) closeNow() }
/** ③ 点击别处：收掉（点 icon 自身仍走 click 切换逻辑） */
function onDocDown(e: MouseEvent) {
  if (!show.value) return
  const el = e.target as Node
  if (anchorRef.value?.contains(el) || popRef.value?.contains(el)) return
  closeNow()
}
onMounted(() => {
  window.addEventListener('scroll', onViewportChange, true)
  window.addEventListener('resize', onViewportChange)
  window.addEventListener('blur', onWinBlur)
  document.addEventListener('mousedown', onDocDown, true)
})
/** ④ 宿主卸载（切 tab / 关弹窗 / 列表重渲染）：卸载瞬间必须收掉，否则只在 body 里孤零零留着 */
onBeforeUnmount(() => {
  closeNow()
  window.removeEventListener('scroll', onViewportChange, true)
  window.removeEventListener('resize', onViewportChange)
  window.removeEventListener('blur', onWinBlur)
  document.removeEventListener('mousedown', onDocDown, true)
})
</script>

<template>
  <span ref="anchorRef" class="hint-tip relative inline-flex shrink-0 self-center align-middle ml-0.5">
    <button
      type="button"
      class="hint-btn w-3.5 h-3.5 flex items-center justify-center text-gray-400 transition-colors"
      :aria-label="t('common.hintAria')"
      @mouseenter="open"
      @mouseleave="scheduleClose"
      @focus="open"
      @blur="scheduleClose"
      @click.stop.prevent="show ? (show = false) : open()"
    ><Info :size="12" stroke-width="1.75" /></button>
    <Teleport to="body">
      <Transition name="hint-tip">
        <span
          v-if="show && text"
          ref="popRef"
          class="fixed z-[10050] bg-gray-900 text-white text-[11px] font-normal leading-relaxed rounded-xl shadow-2xl px-3.5 py-2.5 whitespace-normal"
          style="direction: ltr; text-align: start; max-width: min(280px, calc(100vw - 16px))"
          :style="{ left: pos.left + 'px', bottom: pos.bottom + 'px' }"
          @mouseenter="cancelClose"
          @mouseleave="scheduleClose"
        >{{ text }}</span>
      </Transition>
    </Teleport>
  </span>
</template>

<style scoped>
/* A+D 收纳态：默认极淡，仅 hover 其所在行/标题才浮现 */
.hint-tip {
  opacity: 0;
  transition: opacity 0.18s ease;
}
/* hover 命中的可能宿主：h3 标题行 / 开关整行(灰底 rounded 容器) / 行内文字容器 .flex-1 / 字面 group */
.group:hover > .hint-tip,
h3:hover > .hint-tip,
h3:hover .hint-tip,
.flex-1:hover > .hint-tip,
[class*="rounded-xl"]:hover > .flex-1 .hint-tip,
[class*="rounded-xl"]:hover .hint-tip,
.hint-tip:focus-within,
.hint-tip:hover {
  opacity: 1;
}
.hint-btn {
  cursor: help;
}
.hint-btn:hover {
  color: #6b7280;
}
html.dark .hint-btn { color: #6f6f78; }
html.dark .hint-btn:hover { color: #b9b9c2; }
/* 手机端无 hover：提示 icon 恒淡显（可达），点按弹说明 */
@media (max-width: 767px) {
  .hint-tip { opacity: 0.55; }
}
.hint-tip-enter-active { transition: opacity 0.16s ease, transform 0.16s ease; }
.hint-tip-leave-active { transition: opacity 0.12s ease; }
.hint-tip-enter-from { opacity: 0; transform: translateY(4px); }
.hint-tip-leave-to { opacity: 0; }
</style>

