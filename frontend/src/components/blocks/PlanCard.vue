<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import { t } from '@/utils/i18n'
import { localStore } from '@/utils/localStore'

/**
 * 计划卡。两种形态（0909⑤）：
 * - pill（默认，新形态）：会话标题栏右侧的胶囊——折叠态显示「计划 n/m + 当前进行的一条」，
 *   点击向下展开浮层=原卡片形态（进度条+清单）。后续子 agent 计划条会在同一区域并列多枚（子 agent 区分样式预留）。
 * - inline（旧形态，保留给其它挂载点）：输入框上方整宽卡片。
 * - 完成一条划一条；进度条进行中有流光动画、全部完成有变色收尾动效
 * - 折叠/展开为高度过渡动画（grid-rows）；入场/退场（B 方案淡出）带动效
 * - 折叠状态按会话记忆（localStorage）：AI 首次出卡默认展开，切会话保持
 * - 材质为伪磨砂：本环境 backdrop-filter 采样不可用（详见 HANDOVER 铁律），
 *   用冷调白渐变 + 内高光模拟磨砂塑料质感
 */
const props = defineProps<{ items: Array<{ text: string; done: boolean }>; compact?: boolean; convKey?: string | number; pill?: boolean; title?: string; variant?: 'agent' | 'board' | 'member' }>()

/** 0910 三批①计划面板三合一：三种来源用标题色+图标区分（黑板=琥珀、主计划=灰黑、成员计划=青） */
const vType = computed<'agent' | 'board' | 'member'>(() => props.variant || 'agent')
const cardTitle = computed(() => props.title || t('plan.title'))

const PLAN_COLLAPSED_KEY = 'nis-plan-collapsed'
const collapsed = ref(false)

function readMap(): Record<string, boolean> {
  try { return JSON.parse(localStore.getItem(PLAN_COLLAPSED_KEY) || '{}') } catch { return {} }
}
function restoreState() {
  if (props.convKey == null || props.convKey === '') {
    // 无会话键：pill 默认折叠（标题栏胶囊不抢地方），inline 保持旧默认展开
    collapsed.value = !!props.pill
    return
  }
  const v = readMap()[String(props.convKey)]
  // pill 形态默认折叠（用户拍板：折叠态显示当前进行任务，点击展开）；无记录时用默认，有记录尊重记忆
  collapsed.value = v === undefined ? !!props.pill : v
}
/* 初始恢复 + 会话切换（convKey 变化）时恢复对应状态；无记录 = 默认展开 */
restoreState()
watch(() => props.convKey, restoreState)

/* 用户点击折叠/展开：状态落盘按会话记忆 */
function setCollapsed(v: boolean) {
  collapsed.value = v
  if (props.convKey == null || props.convKey === '') return
  try {
    const map = readMap()
    map[String(props.convKey)] = v
    localStore.setItem(PLAN_COLLAPSED_KEY, JSON.stringify(map))
  } catch { /* 存储异常时仅内存生效 */ }
}

/* pill 形态：展开浮层外点关闭（下拉菜单铁律：外点即收） */
const pillWrapRef = ref<HTMLElement | null>(null)
function onPillOutside(e: MouseEvent) {
  if (pillWrapRef.value && !pillWrapRef.value.contains(e.target as Node)) setCollapsed(true)
}
let outsideAddTimer: ReturnType<typeof setTimeout> | null = null
watch(collapsed, (c) => {
  /* 0927 netfix outside-guard-0927：挂起的 add 必须可撤销 —— 快速"展开又收起"时旧 add 会在
   remove 之后才执行 → 外点监听残留（泄漏 + 意外收起）。 */
  if (outsideAddTimer) { clearTimeout(outsideAddTimer); outsideAddTimer = null }
  if (props.pill && !c) {
    outsideAddTimer = setTimeout(() => { outsideAddTimer = null; document.addEventListener('click', onPillOutside) }, 0)
  } else {
    document.removeEventListener('click', onPillOutside)
  }
})

const doneCount = computed(() => props.items.filter(i => i.done).length)
const allDone = computed(() => props.items.length > 0 && doneCount.value === props.items.length)
/** 正在进行的一条 = 第一条未完成（全完成则为 null） */
const runningItem = computed(() => props.items.find(i => !i.done) || null)

/* B 方案收尾：全部条目 done 后 10s 倒计时自动淡出清空（省 token：AI 无需再调 plan_write 清空）。
 * 0911 反馈13：倒计时期间保留"任务名"位置（显示最后一条计划文本）+ 右侧只显示「Ns」数字。 */
const emit = defineEmits<{ (e: 'expired'): void }>()
const fadeOut = ref(false)
const EXPIRE_SECONDS = 10
const secondsLeft = ref(0)
let expireTimer: ReturnType<typeof setTimeout> | null = null
let countTimer: ReturnType<typeof setInterval> | null = null
/** 最后一条计划文本：完成瞬间从"最后未完成项"平滑过渡为它自己，任务名不消失 */
const lastItemText = computed(() => props.items.length ? props.items[props.items.length - 1].text : '')
/** 完成态主文本：倒计时中＝末条计划文本（保留任务名）；归零瞬间＝「全部完成」 */
const doneText = computed(() => allDone.value && secondsLeft.value > 0
  ? lastItemText.value
  : t('plan.allDone'))
watch(allDone, (done) => {
  if (expireTimer) { clearTimeout(expireTimer); expireTimer = null }
  if (countTimer) { clearInterval(countTimer); countTimer = null }
  if (done) {
    secondsLeft.value = EXPIRE_SECONDS
    countTimer = setInterval(() => { secondsLeft.value = Math.max(0, secondsLeft.value - 1) }, 1000)
    expireTimer = setTimeout(() => {
      if (countTimer) { clearInterval(countTimer); countTimer = null }
      fadeOut.value = true
      setTimeout(() => { emit('expired'); fadeOut.value = false }, 480)
    }, EXPIRE_SECONDS * 1000)
  } else {
    secondsLeft.value = 0
  }
}, { immediate: true })
onUnmounted(() => {
  if (outsideAddTimer) clearTimeout(outsideAddTimer)
  document.removeEventListener('click', onPillOutside)
  if (expireTimer) clearTimeout(expireTimer)
  if (countTimer) clearInterval(countTimer)
  document.removeEventListener('click', onPillOutside)
})
</script>

<template>
  <!-- ══ pill 形态（0909⑤ 新形态）：会话标题栏右侧胶囊。折叠态=「图标+进度+当前进行的一条」，
       点击向下展开浮层（进度条+清单）。外层容器是横排 flex，未来子 agent 计划条在同区域并列多枚。 ══ -->
  <div v-if="pill" ref="pillWrapRef" :class="['plan-pill-wrap', fadeOut ? 'plan-fadeout' : '']">
    <button class="plan-pill" :class="[{ open: !collapsed, 'pill-done': allDone }, `pill-${vType}`]" :title="collapsed ? t('plan.expandTitle') : t('plan.collapseTitle')" @click="setCollapsed(!collapsed)">
      <span :class="['text-[9px] leading-none px-1.5 py-1 rounded-full shrink-0 font-medium', allDone ? 'bg-green-100 text-green-600' : vType === 'board' ? 'bg-amber-100 text-amber-700' : vType === 'member' ? 'bg-cyan-100 text-cyan-700' : 'bg-gray-200/70 text-gray-600']">{{ cardTitle }}</span>
      <span :class="['text-[11px] font-mono', allDone ? 'text-green-500' : 'text-gray-400']">{{ doneCount }}/{{ items.length }}</span>
      <!-- 折叠态：正在进行的一条（展开时让位给浮层）；三点波浪=低干扰运行指示 -->
      <span v-if="collapsed && runningItem" class="pill-cur min-w-0 truncate"><span class="plan-dots" aria-hidden="true"><i></i><i></i><i></i></span>{{ runningItem.text }}</span>
      <span v-else-if="collapsed && allDone" class="pill-cur min-w-0 text-green-500">
        <span class="min-w-0 truncate">{{ doneText }}</span>
        <span v-if="secondsLeft > 0" class="shrink-0 tabular-nums">{{ t('plan.clearCountdown', { n: secondsLeft }) }}</span>
      </span>
      <i class="fas fa-chevron-down text-[9px] text-gray-400 transition-transform duration-200" :class="collapsed ? '' : 'rotate-180'"></i>
    </button>
    <Transition name="pill-pop">
      <div v-if="!collapsed" class="plan-pill-pop">
        <div class="flex items-center gap-2 mb-1.5">
          <span class="text-[11px] font-[530] text-gray-500 shrink-0">{{ doneCount }}/{{ items.length }}</span>
          <div class="flex-1 h-1 rounded-full bg-gray-100 overflow-hidden">
            <div
              :class="['relative h-full rounded-full transition-all duration-500', allDone ? 'bg-emerald-500 bar-done' : 'bg-gray-900']"
              :style="{ width: (items.length ? (doneCount / items.length) * 100 : 0) + '%' }"
            >
              <span v-if="!allDone" class="bar-shine"></span>
            </div>
          </div>
          <!-- 0911 反馈10：完成倒计时（展开态同款） -->
          <span v-if="allDone && secondsLeft > 0" class="text-[10px] text-emerald-500 shrink-0 tabular-nums">{{ t('plan.clearCountdown', { n: secondsLeft }) }}</span>
        </div>
        <ul class="plan-list !mt-0">
          <li v-for="(it, i) in items" :key="i" class="flex items-start gap-2 py-1">
            <span
              class="mt-0.5 w-4 h-4 shrink-0 rounded-full border flex items-center justify-center transition-all duration-300"
              :class="it.done ? 'bg-gray-900 border-gray-900' : 'border-gray-300'"
            >
              <i v-if="it.done" class="fas fa-check text-[8px] text-white"></i>
            </span>
            <span
              :class="[
                'text-[12px] leading-snug transition-all duration-300',
                it.done ? 'text-gray-300 line-through' : 'text-gray-700'
              ]"
            >{{ it.text }}</span>
          </li>
        </ul>
      </div>
    </Transition>
  </div>

  <!-- ══ inline 形态（旧：输入框上方整宽卡片，保留给其它挂载点） ══ -->
  <div v-else :class="['w-full max-w-3xl mx-auto mb-2 plan-card', collapsed ? 'is-collapsed' : '', fadeOut ? 'plan-fadeout' : '']">
    <div class="plan-shell">
      <!-- 头部行：折叠态整条可点展开 -->
      <div
        class="plan-head flex items-center gap-2"
        :class="{ 'cursor-pointer select-none': collapsed }"
        :title="collapsed ? t('plan.expandTitle') : ''"
        @click="collapsed && setCollapsed(false)"
      >
        <i :class="['fas text-[11px]', allDone ? 'fa-circle-check text-green-500' : 'fa-list-check text-gray-400']"></i>
        <span class="text-[12px] font-medium text-gray-700">{{ t('plan.title') }}</span>
        <span :class="['text-[11px] font-mono', allDone ? 'text-green-500' : 'text-gray-400']">{{ doneCount }}/{{ items.length }}</span>

        <!-- 展开态：进度条（进行中流光 / 全部完成变色收尾） -->
        <div v-if="!collapsed" class="flex-1 h-1 rounded-full bg-gray-100 overflow-hidden ml-1">
          <div
            :class="['relative h-full rounded-full transition-all duration-500', allDone ? 'bg-emerald-500 bar-done' : 'bg-gray-900']"
            :style="{ width: (items.length ? (doneCount / items.length) * 100 : 0) + '%' }"
          >
            <span v-if="!allDone" class="bar-shine"></span>
          </div>
        </div>
        <!-- 折叠态：正在进行的一条；三点波浪=低干扰运行指示 -->
        <span v-else class="flex-1 min-w-0 flex items-center gap-1.5 text-[11px] leading-tight" :class="allDone ? 'text-green-500' : 'text-gray-500'">
          <template v-if="runningItem">
            <span class="plan-dots" aria-hidden="true"><i></i><i></i><i></i></span>
            <span class="truncate">{{ runningItem.text }}</span>
          </template>
          <template v-else-if="allDone">
            <i class="fas fa-check text-[9px] shrink-0"></i>
            <span class="min-w-0 truncate">{{ doneText }}</span>
            <span v-if="secondsLeft > 0" class="shrink-0 tabular-nums">{{ t('plan.clearCountdown', { n: secondsLeft }) }}</span>
          </template>
        </span>

        <!-- 展开态：圆形折叠按钮 -->
        <button
          v-if="!collapsed"
          class="w-7 h-7 -mr-1.5 rounded-full flex items-center justify-center text-gray-400 hover:text-gray-700 hover:bg-gray-200/70 transition-colors shrink-0"
          :title="t('plan.collapseTitle')"
          @click.stop="setCollapsed(true)"
        >
          <i class="fas fa-chevron-down text-[11px]"></i>
        </button>
        <!-- 折叠态：展开箭头（朝上） -->
        <i v-else class="fas fa-chevron-down text-[10px] text-gray-400 rotate-180 shrink-0"></i>
      </div>

      <!-- 条目列表：grid-rows 高度过渡（折叠/展开动画） -->
      <div class="plan-list-wrap">
        <ul class="plan-list">
          <li v-for="(it, i) in items" :key="i" class="flex items-start gap-2 py-0.5">
            <span
              class="mt-0.5 w-4 h-4 shrink-0 rounded-full border flex items-center justify-center transition-all duration-300"
              :class="it.done ? 'bg-gray-900 border-gray-900' : 'border-gray-300'"
            >
              <i v-if="it.done" class="fas fa-check text-[8px] text-white"></i>
            </span>
            <span
              :class="[
                'text-[12px] leading-snug transition-all duration-300',
                it.done ? 'text-gray-300 line-through' : 'text-gray-700'
              ]"
            >{{ it.text }}</span>
          </li>
        </ul>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* ══ pill 形态（0909⑤）：标题栏右侧胶囊 + 向下展开浮层 ══ */
.plan-pill-wrap { position: relative; flex-shrink: 0; }
.plan-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 320px;
  padding: 4px 10px;
  border-radius: 9999px;
  /* 0909⑦改：输入框同款磨砂（.input-blur-layer 语言），折叠/展开两态统一 */
  border: 1px solid rgba(229, 231, 235, 0.9);
  background: linear-gradient(160deg, rgba(255, 255, 255, 0.72) 0%, rgba(255, 255, 255, 0.56) 100%);
  backdrop-filter: blur(16px) saturate(1.6);
  -webkit-backdrop-filter: blur(16px) saturate(1.6);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.06), inset 0 1px 0 rgba(255, 255, 255, 0.9);
  cursor: pointer;
  transition: background 0.15s ease, border-color 0.15s ease;
  white-space: nowrap;
}
.plan-pill:hover { background: linear-gradient(160deg, rgba(255, 255, 255, 0.84) 0%, rgba(255, 255, 255, 0.68) 100%); border-color: rgba(203, 213, 225, 0.9); }
.plan-pill.open { background: linear-gradient(160deg, rgba(255, 255, 255, 0.86) 0%, rgba(255, 255, 255, 0.72) 100%); }
.plan-pill.pill-done { border-color: rgba(16, 185, 129, 0.5); }
.pill-cur { font-size: 11px; color: #6b7280; max-width: 150px; display: inline-flex; align-items: center; gap: 4px; }
/* 运行中指示：三点波浪（0911 反馈13——替代旋转 spinner：幅度小、呼吸式亮灭，不持续扎眼；
 * 颜色跟随 currentColor，折叠 pill / inline 两处自动同色） */
.plan-dots { display: inline-flex; align-items: center; gap: 2.5px; flex-shrink: 0; }
.plan-dots i {
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: currentColor;
  opacity: 0.35;
  animation: planDot 1.4s ease-in-out infinite;
}
.plan-dots i:nth-child(2) { animation-delay: 0.18s; }
.plan-dots i:nth-child(3) { animation-delay: 0.36s; }
@keyframes planDot {
  0%, 100% { opacity: 0.3; transform: translateY(0); }
  40% { opacity: 0.9; transform: translateY(-2px); }
}
.plan-pill-pop {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 60;
  /* ★ 0922：宽度与后台任务面板统一 360px；限高改跟窗口走（原来写死 320px，长计划被切） */
  width: 360px;
  max-height: 46vh;
  overflow-y: auto;
  background: linear-gradient(160deg, rgba(255, 255, 255, 0.8) 0%, rgba(255, 255, 255, 0.64) 100%);
  backdrop-filter: blur(16px) saturate(1.6);
  -webkit-backdrop-filter: blur(16px) saturate(1.6);
  border: 1px solid rgba(229, 231, 235, 0.9);
  border-radius: 14px;
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.1), inset 0 1px 0 rgba(255, 255, 255, 0.85);
  padding: 10px 14px 12px;
}
.pill-pop-enter-active { animation: pillIn 0.18s ease-out; }
.pill-pop-leave-active { animation: pillIn 0.14s ease-in reverse; }
@keyframes pillIn {
  from { opacity: 0; transform: translateY(-6px) scale(0.97); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}

/* 伪磨砂材质：本环境 backdrop-filter 采样不可用（详见 HANDOVER 铁律），
   冷调白渐变 + 内高光模拟磨砂塑料；无 backdrop-filter，transform 动画安全 */
.plan-shell {
  background: linear-gradient(160deg, rgba(255, 255, 255, 0.97) 0%, rgba(248, 250, 252, 0.95) 55%, rgba(241, 245, 249, 0.94) 100%);
  border: 1px solid rgba(229, 231, 235, 0.9);
  border-radius: 16px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.05), inset 0 1px 0 rgba(255, 255, 255, 0.85);
  padding: 12px 16px;
  transition: padding 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}
.is-collapsed .plan-shell { padding: 6px 16px; }

/* 折叠/展开：grid-rows 高度过渡 */
.plan-list-wrap {
  display: grid;
  grid-template-rows: 1fr;
  transition: grid-template-rows 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}
.is-collapsed .plan-list-wrap { grid-template-rows: 0fr; }
.plan-list {
  overflow: hidden;
  min-height: 0;
  margin-top: 8px;
  opacity: 1;
  transition: opacity 0.2s ease, margin-top 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}
.is-collapsed .plan-list { margin-top: 0; opacity: 0; }
/* ★ 0922：条目 hover 落点感 + 轻微内缩（原来只有完成态淡化，鼠标划过没有反馈） */
.plan-pill-pop .plan-list li { border-radius: 8px; padding-left: 6px; padding-right: 6px; margin-left: -6px; margin-right: -6px; transition: background 0.15s ease; }
.plan-pill-pop .plan-list li:hover { background: rgba(244, 244, 245, 0.9); }
html.dark .plan-pill-pop .plan-list li:hover { background: rgba(255, 255, 255, 0.06); }

/* 进度条：进行中流光扫过 */
.bar-shine {
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: linear-gradient(90deg, transparent 0%, rgba(255, 255, 255, 0.6) 50%, transparent 100%);
  background-size: 200% 100%;
  animation: barShine 1.5s linear infinite;
}
@keyframes barShine {
  from { background-position: 200% 0; }
  to { background-position: -200% 0; }
}
/* 进度条：全部完成收尾动效（回弹 + 辉光，随后常驻绿色） */
.bar-done { animation: barDone 0.55s cubic-bezier(0.34, 1.56, 0.64, 1) both; }
@keyframes barDone {
  0% { transform: scaleY(1); box-shadow: none; }
  40% { transform: scaleY(1.9); box-shadow: 0 0 10px rgba(16, 185, 129, 0.55); }
  100% { transform: scaleY(1); box-shadow: none; }
}

/* 入场（AI 首次出卡）/退场（B 方案淡出）——伪磨砂下 transform 安全 */
.plan-card {
  animation: planIn 0.32s cubic-bezier(0.34, 1.56, 0.64, 1) both;
  transform-origin: bottom center;
}
@keyframes planIn {
  from { opacity: 0; transform: translateY(10px) scale(0.98); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}
.plan-fadeout {
  transition: opacity 0.45s ease, transform 0.45s ease;
  opacity: 0;
  transform: translateY(8px) scale(0.98);
  pointer-events: none;
}
</style>
