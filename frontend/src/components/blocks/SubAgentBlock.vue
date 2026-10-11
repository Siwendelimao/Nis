<script setup lang="ts">
/**
 * SubAgentBlock —— 团队成员子 agent 的独立消息组（和主 agent 一样：头像+名字+模型+气泡+统计，区别是限制在气泡里）。
 * 折叠态：约 5 行高度窗口，滚动显示最新时间线；展开态：气泡内向下展开、限高滚动，按时间穿插（思考→工具过程块→正文逐轮交替）。
 * 底部为基准（0911 反馈5）：折叠/展开都停靠最新内容；想回看自己上滑（上滑后不被新内容顶掉）。
 * 收起交互（0911 反馈7）：恢复「收起」按钮（sticky 气泡底部）——点空白收起在选词/链接场景仍易误触，回退按钮方案。
 * 滚动指示条：只在用户手动滚动时出现（程序性钉底不触发），挂滚动容器内裁剪，3s 淡出。
 */
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue'
import MarkdownText from './MarkdownText.vue'
import ReasoningBlock from './ReasoningBlock.vue'
import ToolPartBlock from './ToolPartBlock.vue'
import { derivePersona } from '@/utils/toolClassifier'
import { t } from '@/utils/i18n'
import { useAgentPresetsStore } from '@/stores/agentPresets'
import { useSettingsStore } from '@/stores/settings'

const props = defineProps<{ node: any }>()

const sa = computed(() => props.node.subAgent || {})
const agentPresetsStore = useAgentPresetsStore()
/** 0913 头像批：成员预设头像（设置了才用；未设置回退「渐变+首字」默认头像） */
const presetAvatar = computed(() => {
  /* ★ 0925w（实测"分身头像显示的是预设头像而不是我的头像"）：分身=本体的样子 ——
     名字含「分身」的成员用人设头像（settingsStore.nisAvatar），其余成员照旧用预设头像。 */
  if (String(sa.value.memberName || '').includes('分身')) return String(useSettingsStore().nisAvatar || '')
  return sa.value.memberPreset ? agentPresetsStore.avatarOf(String(sa.value.memberPreset)) : ''
})
const expanded = ref(false)
const previewRef = ref<HTMLDivElement | null>(null)
const fullRef = ref<HTMLDivElement | null>(null)

/* ── 状态/头像/模型 ── */
const status = computed<'running' | 'done' | 'error' | 'interrupted'>(() => sa.value.status || (props.node.status === 'streaming' ? 'running' : 'done'))
const statusText = computed(() => status.value === 'running' ? t('sub.running')
  : status.value === 'error' ? t('chat.failed')
  : status.value === 'interrupted' ? t('sub.interrupted')
  : t('chat.completed'))
const initial = computed(() => String(sa.value.memberName || t('sub.initial')).slice(0, 1))
const avatarStyle = computed(() => {
  const palettes = [
    'linear-gradient(135deg, #0ea5e9 0%, #6366f1 100%)',
    'linear-gradient(135deg, #f59e0b 0%, #ef4444 100%)',
    'linear-gradient(135deg, #10b981 0%, #14b8a6 100%)',
    'linear-gradient(135deg, #ec4899 0%, #8b5cf6 100%)',
  ]
  const id = String(sa.value.memberId || '')
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return { background: palettes[h % palettes.length] }
})
const modelLabel = computed(() => sa.value.model || t('sub.followModel'))

/** 0910 反馈4：成员自列计划（sub_plan） */
const planItems = computed<Array<{ text: string; done: boolean }>>(() =>
  Array.isArray(sa.value.plan) ? sa.value.plan : [],
)
const planDone = computed(() => planItems.value.filter(p => p.done).length)

/** 本 run 用过的技能（segments 里的 use_skill 调用名去重）——头部绿色标识，无则不显示 */
const usedSkills = computed<string[]>(() => {
  const out: string[] = []
  for (const s of sa.value.segments || []) {
    if (s?.type === 'tool' && s?.name === 'use_skill' && s?.args?.name && !out.includes(s.args.name)) out.push(String(s.args.name))
  }
  return out
})

/* ── 过程时间线：segments（后端写时补全按消息序真实穿插；实时流与持久化同构） ── */
interface FeedItem { kind: 'think' | 'text' | 'tool' | 'error'; text: string; toolStatus?: string; toolResult?: string; persona?: string }

function toolLabel(name: string): string {
  const map: Record<string, string> = {
    fs_read: 'sub.toolRead', fs_write: 'sub.toolWrite', run_command: 'sub.toolRun', web_search: 'sub.toolSearch',
    use_skill: 'sub.toolSkill', ask_user: 'sub.toolAsk', bb_write: 'sub.toolBlackboard',
  }
  if (name.startsWith('mcp__')) {
    const parts = name.split('__')
    return `MCP ${parts[1] || ''}/${parts[2] || ''}`
  }
  return map[name] ? t(map[name]) : name
}

const hasSegments = computed(() => Array.isArray(sa.value.segments) && sa.value.segments.length > 0)
const segmentsView = computed<FeedItem[]>(() => {
  return (sa.value.segments as any[]).map((s, ai) => ({
    kind: s.type === 'thinking' ? 'think' : s.type === 'error' ? 'error' : s.type === 'text' ? 'text' : 'tool',
    text: s.type === 'tool' ? `${toolLabel(s.name)}${s.status === 'error' ? `（${t('sub.failed')}）` : ''}` : s.text,
    toolStatus: s.type === 'tool' ? s.status : undefined,
    toolResult: s.type === 'tool' ? (s.result || '') : undefined,
    toolName: s.type === 'tool' ? s.name : undefined,
    toolArgs: s.type === 'tool' ? s.args : undefined,
    /* [T6] stable synthetic toolCallId (runId + seg index, memoized) + one-shot persona cached on the segment:
       render only reads caches, no re-randomized copy on re-render (flicker fix) */
    toolCallId: s.type === 'tool' ? (s.toolCallId || (s.toolCallId = 'subseg:' + String(sa.value.runId || '') + ':' + ai)) : undefined,
    persona: s.type === 'tool' ? (s.persona || (s.args && Object.keys(s.args).length ? (s.persona = derivePersona(s.name, s.args)) : undefined)) : undefined,
  }))
})
/**
 * ★0929（实测"子agent显示的不是新内容，是最开始的3条"）：折叠预览改为**尾部连续
 * PREVIEW_TAIL_N 条（最新动态）**。旧 [T7] 取头部前 N 条（"折叠首条=展开首条"）——
 * 长任务的预览永远冻结在开工那几段，与下方 0911"钉底跟随最新"的滚动设计直接矛盾。
 * 不变量改为：**同源同函数**（仍是 segmentsView 同一数组的连续切片、同一取文本函数），
 * 预览即"展开列表的尾部"；展开首条≠折叠首条不再作为要求（要看开头就展开往回翻）。
 * 保留 0910 二批②：切片前滤掉空正文段（流式中空 text 不渲染白框）。
 */
const PREVIEW_TAIL_N = 3
const previewItems = computed<FeedItem[]>(() => {
  const all = segmentsView.value
  if (!all.length) return []
  const solid = all.filter(f => f.kind !== 'text' || (f.text || '').trim())
  return solid.slice(-PREVIEW_TAIL_N)
})

/* ── 实时计时：running 时头部走秒（每 500ms 刷新），done 后显示终帧统计 ── */
const nowTick = ref(Date.now())
let tickTimer: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  /* ★1004：只在 running 时写 ref —— done/僵尸卡片不再每 500ms 空转触发重算
     （多卡片叠起来是持续重绘源之一，配合僵尸清理把 CPU 彻底按下去） */
  tickTimer = setInterval(() => { if (status.value === 'running') nowTick.value = Date.now() }, 500)
})
onUnmounted(() => { if (tickTimer) clearInterval(tickTimer) })
const liveElapsed = computed(() => {
  if (status.value !== 'running') return ''
  const ms = nowTick.value - (props.node.time || nowTick.value)
  if (ms < 1000) return ''
  const s = Math.floor(ms / 1000)
  return s < 60 ? t('sub.execSec', { n: s }) : t('sub.execMinSec', { m: Math.floor(s / 60), s: s % 60 })
})

/* ── 滚动：流式钉底 + 隐藏式滚动指示条（仅用户手动滚动时出现，3s 淡出） ── */
const indicator = ref<{ show: boolean; top: number; height: number }>({ show: false, top: 0, height: 0 })
let indicatorTimer: ReturnType<typeof setTimeout> | null = null
let pinned = true
let userScrolling = false

function updateIndicator(el: HTMLElement | null) {
  if (!el) return
  if (el.scrollHeight <= el.clientHeight + 4) { indicator.value.show = false; return }
  const ratio = Math.max(0.12, Math.min(1, el.clientHeight / el.scrollHeight))
  indicator.value.height = ratio * el.clientHeight
  // top 限制在容器内（不超出气泡边框）
  const rawTop = (el.scrollTop / el.scrollHeight) * el.clientHeight
  indicator.value.top = Math.max(2, Math.min(el.clientHeight - indicator.value.height - 2, rawTop))
  if (!userScrolling) return
  indicator.value.show = true
  if (indicatorTimer) clearTimeout(indicatorTimer)
  indicatorTimer = setTimeout(() => { indicator.value.show = false; userScrolling = false }, 3000)
}
// 只在用户手动滚动（滚轮/触摸/拖动滚动条）时显示指示条——程序性 scrollTop 赋值不触发 wheel/touch
function onUserScroll(e: Event) {
  const el = e.target as HTMLElement
  pinned = el.scrollHeight - el.scrollTop - el.clientHeight <= 8
  userScrolling = true
  updateIndicator(el)
}
/* 0911 反馈5：底部为基准——折叠/展开都程序性钉底到最新内容；用户上滑（pinned=false）后不打扰回看 */
function pinToBottom() {
  const el = expanded.value ? fullRef.value : previewRef.value
  if (el && pinned) el.scrollTop = el.scrollHeight
}
watch(() => [props.node.text.length, props.node.reasoning.length, segmentsView.value.length], () => {
  if (status.value === 'running') nextTick(() => pinToBottom())
})
watch(expanded, (v) => {
  // 0911 反馈5：展开即停靠最新内容（上滑回看中途展开也回到底部看最新）；收起同样贴底恢复跟随
  pinned = true
  nextTick(() => {
    const el = v ? fullRef.value : previewRef.value
    if (el) el.scrollTop = el.scrollHeight
    updateIndicator(el)
  })
})
onUnmounted(() => { if (indicatorTimer) clearTimeout(indicatorTimer) })

function toggle() {
  expanded.value = !expanded.value
}

/* ── 统计（同主 agent 格式：用时 · tok/s；数据来自 agent_end usage/timing 或持久化） ── */
function fmtDuration(ms?: number): string {
  if (!ms || ms <= 0) return ''
  const s = Math.round(ms / 1000)
  if (s < 60) return t('sub.durSec', { n: s })
  return t('sub.durMinSec', { m: Math.floor(s / 60), s: s % 60 })
}
function tokPerSec(): number | null {
  const meta = { timing: props.node.turnTiming, usage: props.node.turnUsage }
  if (!meta?.timing?.llmMs || !meta?.usage?.completionTokens) return null
  const sec = meta.timing.llmMs / 1000
  if (sec <= 0) return null
  return Math.round(meta.usage.completionTokens / sec)
}
const statsText = computed(() => {
  if (status.value !== 'done') return ''
  const parts: string[] = []
  const dur = fmtDuration(props.node.turnTiming?.llmMs)
  if (dur) parts.push(`${t('sub.elapsed')} ${dur}`)
  const tps = tokPerSec()
  if (tps != null) parts.push(`${tps} tok/s`)
  return parts.join(' · ')
})
function fmtTime(ts?: number): string {
  if (!ts) return ''
  return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}
</script>

<template>
  <div class="sub-agent-group" :data-status="status">
    <!-- 双列布局：头像列（32px，与主 agent 一致）+ 内容列——气泡左缘与主 agent 正文左缘对齐（0901 反馈 #3） -->
    <div class="flex items-start gap-3">
      <div class="relative flex-shrink-0">
        <!-- 0913 头像批：预设头像优先；未设置回退「渐变+首字」默认头像 -->
        <img v-if="presetAvatar" :src="presetAvatar" alt=""
             class="w-8 h-8 rounded-full object-cover shadow-sm border border-black/15" />
        <div v-else class="w-8 h-8 rounded-full flex items-center justify-center text-white font-bold text-sm shadow-sm border border-black/15" :style="avatarStyle">{{ initial }}</div>
      </div>
      <div class="flex-1 min-w-0">
        <!-- 头部：名字 + 模型 + 状态 + 计时（对齐主 agent 组头部排版） -->
        <div class="flex items-center gap-2 mb-1.5 flex-wrap">
          <span class="font-medium text-gray-700 text-sm">{{ sa.memberName }}<span v-if="sa.instanceNo && sa.instanceNo > 1" class="text-gray-400 font-mono text-xs"> #{{ sa.instanceNo }}</span></span>
          <span class="text-[11px] text-gray-400">{{ modelLabel }}</span>
          <!-- 0910 反馈5：独立模型解析失败（回退会话模型）不再静默——气泡上明确标注配置的是什么、为什么换了 -->
          <span
            v-if="sa.modelFallback"
            class="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-50 text-amber-600 border border-amber-200"
            :title="`${t('team.subFallback')}${sa.modelConfigured ? `（配置：${sa.modelConfigured}）` : ''}`"
          >
            <i class="fas fa-triangle-exclamation mr-0.5 text-[9px]"></i>{{ t('team.subFallback') }}
          </span>
          <span class="sub-agent-state text-[11px]" :class="{ 'is-running': status === 'running', 'is-error': status === 'error', 'is-interrupted': status === 'interrupted' }">{{ statusText }}</span>
          <span v-if="liveElapsed" class="text-[10px] text-gray-400 tabular-nums">{{ liveElapsed }}</span>
          <span v-else-if="statsText" class="text-[10px] text-gray-300">{{ statsText }}</span>
          <span v-for="sk in usedSkills" :key="sk" class="text-[10px] px-1.5 py-0.5 rounded-full bg-green-50 text-green-600 border border-green-200" :title="t('sub.skillTip', { skill: sk })">
            <i class="fas fa-wand-sparkles mr-0.5 text-[9px]"></i>{{ sk }}
          </span>
        </div>

        <!-- 0910 反馈4：成员自列执行计划（sub_plan）——折叠态/展开态都常驻显示，一眼看进度 -->
        <div v-if="planItems.length" class="member-plan-card">
          <div class="member-plan-head">{{ t('team.memberPlan') }} {{ planDone }}/{{ planItems.length }}</div>
          <div v-for="(p, pi) in planItems" :key="pi" class="member-plan-row" :class="{ 'is-done': p.done }">
            <span class="member-plan-box">{{ p.done ? '✓' : '' }}</span>
            <span class="member-plan-text">{{ p.text }}</span>
          </div>
        </div>

        <!-- 气泡：白底浅灰边框，左上角小圆角；点击切换展开 -->
        <div class="sub-agent-bubble" :class="{ 'is-collapsed': !expanded }" @click="!expanded && toggle()">
          <!-- ★0929 preview tail：与展开态同源（segmentsView 同一数组），预览取尾部连续 PREVIEW_TAIL_N 条＝最新动态 -->          <div v-if="!expanded" ref="previewRef" class="sub-agent-preview" @scroll="onUserScroll" @wheel.passive="onUserScroll" @touchmove.passive="onUserScroll">
            <template v-if="hasSegments && previewItems.length">
              <template v-for="(f, fi) in previewItems" :key="fi">
                <ReasoningBlock v-if="f.kind === 'think'" :content="f.text" :streaming="status === 'running' && fi === previewItems.length - 1" />
                <ToolPartBlock
                  v-else-if="f.kind === 'tool'"
                  :part="{
                    tool: f.toolName,
                    input: f.toolArgs || {},
                    status: f.toolStatus === 'running' ? 'running' : f.toolStatus === 'error' ? 'error' : 'completed',
                    output: f.toolResult || '',
                    error: f.toolStatus === 'error' ? (f.toolResult || '') : '',
                    call_id: f.toolCallId,
                    persona: f.persona,
                  }"
                  :desc="f.toolName || ''"
                />
                <div v-else-if="f.kind === 'error'" class="sub-agent-err">⚠ {{ f.text }}</div>
                <div v-else class="sub-agent-text sub-agent-text-preview"><MarkdownText :text="f.text" /></div>
              </template>
            </template>
            <div v-else class="sub-agent-live py-1">{{ status === 'error' ? t('sub.memberFailed') : t('sub.memberWorking') }}</div>
          </div>
          <!-- 展开态：限高滚动，按时间穿插（思考块 → 工具过程块 → 正文段逐轮交替）；收起按钮 sticky 底部 -->
          <div v-else ref="fullRef" class="sub-agent-full" @scroll="onUserScroll" @wheel.passive="onUserScroll" @touchmove.passive="onUserScroll" @click.stop>
            <template v-if="hasSegments">
              <template v-for="(f, fi) in segmentsView" :key="fi">
                <!-- 思考段：与主 agent 一致的可折叠 ReasoningBlock -->
                <ReasoningBlock v-if="f.kind === 'think'" :content="f.text" :streaming="status === 'running' && fi === segmentsView.length - 1" />
                <!-- 工具过程块：主 agent 同款 ToolPartBlock（同一套图标/摘要/展开体） -->
                <ToolPartBlock
                  v-else-if="f.kind === 'tool'"
                  :part="{
                    tool: f.toolName,
                    input: f.toolArgs || {},
                    status: f.toolStatus === 'running' ? 'running' : f.toolStatus === 'error' ? 'error' : 'completed',
                    output: f.toolResult || '',
                    error: f.toolStatus === 'error' ? (f.toolResult || '') : '',
                    call_id: f.toolCallId,
                    persona: f.persona,
                  }"
                  :desc="f.toolName || ''"
                />
                <div v-else-if="f.kind === 'error'" class="sub-agent-err">⚠ {{ f.text }}</div>
                <div v-else class="sub-agent-text"><MarkdownText :text="f.text" /></div>
              </template>
              <div v-if="segmentsView.every(f => f.kind !== 'text') && status === 'running'" class="sub-agent-live">{{ t('sub.memberWorking') }}</div>
            </template>
            <!-- 极端兜底（segments 为空的 running 态）：只显示状态占位，不做内容重建猜测 -->
            <div v-else class="sub-agent-live py-2">{{ t('sub.memberWorking') }}</div>
            <!-- 收起按钮：sticky 气泡底部（新内容从下方流过不被顶掉） -->
            <div class="sub-agent-collapse-wrap"><button class="sub-agent-collapse" type="button" @click.stop="toggle()">{{ t('filetree.collapse') }}</button></div>
          </div>
          <!-- 隐藏式滚动指示条（手动滚动出现，3s 淡出；挂在滚动容器所在气泡内裁剪） -->
          <div v-if="indicator.show" class="scroll-indicator" :style="{ top: indicator.top + 'px', height: indicator.height + 'px' }"></div>
        </div>
        <div class="text-[10px] text-gray-300 mt-1 ml-1">{{ fmtTime(node.time) }}</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.sub-agent-state.is-running {
  color: #4f6ef7;
}
.sub-agent-err {
  margin: 2px 0;
  padding: 3px 8px;
  border-radius: 6px;
  background: rgba(239, 68, 68, 0.08);
  border: 1px solid rgba(239, 68, 68, 0.25);
  color: #ef4444;
  font-size: 11px;
  line-height: 1.5;
}
.sub-agent-state.is-error {
  color: var(--dsw-alias-state-error-primary, #ef4444);
}
/* 被中断（后端重启/看门狗）：琥珀，与"失败"区分——活干过，只是没收尾 */
.sub-agent-state.is-interrupted { color: #b45309; }
/* 成员自列计划（sub_plan）：气泡上方的轻量清单卡——完成项划勾变灰，未完成项保持正文色 */
.member-plan-card {
  margin: 0 0 6px;
  padding: 7px 10px;
  border-radius: 10px;
  border: 1px solid rgba(0, 0, 0, 0.07);
  background: rgba(0, 0, 0, 0.025);
}
.member-plan-head {
  font-size: 10px;
  font-weight: 640;
  color: #6b7280;
  margin-bottom: 4px;
}
.member-plan-row {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  font-size: 12px;
  line-height: 1.5;
  color: #374151;
}
.member-plan-row.is-done { color: #9ca3af; }
.member-plan-box {
  flex: none;
  width: 13px;
  height: 13px;
  margin-top: 2px;
  border-radius: 4px;
  border: 1px solid rgba(0, 0, 0, 0.18);
  font-size: 9px;
  line-height: 11px;
  text-align: center;
  color: #10b981;
}
.member-plan-row.is-done .member-plan-box { border-color: rgba(16, 185, 129, 0.5); background: rgba(16, 185, 129, 0.12); }
.member-plan-text { min-width: 0; word-break: break-word; }
/* 气泡：白底浅灰边框；左上角小圆角（其余 14px），对齐用户气泡的镜像语义 */
.sub-agent-bubble {
  position: relative;
  max-width: 100%;
  padding: 9px 13px;
  border-radius: 4px 14px 14px 14px;
  background: #ffffff;
  border: 1px solid rgba(0, 0, 0, 0.09);
}
.sub-agent-bubble.is-collapsed {
  cursor: pointer;
}
.sub-agent-bubble.is-collapsed:hover {
  border-color: rgba(0, 0, 0, 0.16);
}
/* 折叠态窗口：与展开态同构渲染，约 5 行正文的高度（内容多时裁剪，滚动条隐藏）
 * 0910 二批②：148px(≈3行) → 248px(≈5行)，用户反馈 3 行看得太少 */
.sub-agent-preview,
.sub-agent-full {
  overflow-y: auto;
  scrollbar-width: none;
}
.sub-agent-preview {
  max-height: 248px;
}
.sub-agent-full {
  max-height: 420px;
}
/* 0911 反馈5：撤掉「向上浮层」——展开回归气泡内向下展开（.sub-agent-full 限高 420px 滚动），
 * 底部为基准显示最新内容（滚动/钉底逻辑见 script 区），不再有独立浮层面板 */
.sub-agent-preview::-webkit-scrollbar,
.sub-agent-full::-webkit-scrollbar {
  display: none;
}
.scroll-indicator {
  position: absolute;
  right: 2px;
  width: 3px;
  border-radius: 2px;
  background: rgba(0, 0, 0, 0.18);
  pointer-events: none;
  opacity: 0.85;
}
/* 折叠态正文压缩样式（与展开态同构，仅字号行高收紧） */
.sub-agent-text-preview {
  font-size: 12px;
  line-height: 1.55;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
/* 展开态：穿插块（思考段复用主 agent 的 ReasoningBlock，样式见其组件） */
.sub-agent-text {
  font-size: 14px;
  line-height: 1.6;
  margin-bottom: 6px;
  min-width: 0;
}
.sub-agent-tool {
  display: flex;
  align-items: baseline;
  gap: 6px;
  font-size: 11px;
  line-height: 17px;
  margin-bottom: 3px;
}
.sub-tool-dot {
  flex: none;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--dsw-alias-label-caption, #b8bcc4);
  align-self: center;
}
.sub-tool-dot[data-status='done'] {
  background: var(--dsw-static-green-500, #10b981);
}
.sub-tool-dot[data-status='error'] {
  background: var(--dsw-alias-state-error-primary, #ef4444);
}
.sub-tool-dot[data-status='running'] {
  background: var(--dsw-static-deepseek-500, #4f6ef7);
  animation: subPulse 1.4s ease-in-out infinite;
}
.sub-tool-name {
  flex: none;
  color: var(--dsw-alias-label-secondary, #4e5460);
}
.sub-tool-result {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--dsw-alias-label-caption, #b8bcc4);
}
.sub-agent-live {
  font-size: 11px;
  color: var(--dsw-alias-label-caption, #b8bcc4);
}
/* 收起按钮：sticky 于滚动容器底部——阅读中途新内容到达也不被顶出视野
 * （0911 反馈7：由「点空白收起」回退——选词/链接场景仍易误触，按钮方案更稳） */
.sub-agent-collapse-wrap {
  position: sticky;
  bottom: 0;
  display: flex;
  justify-content: flex-end;
  padding-top: 2px;
  pointer-events: none;
}
.sub-agent-collapse {
  pointer-events: auto;
  padding: 2px 10px;
  border: none;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.85);
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.08);
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary, #8a8f99);
  cursor: pointer;
  transition: all 0.15s ease;
}
.sub-agent-collapse:hover {
  color: var(--dsw-alias-label-primary, #1f2329);
  background: var(--dsw-alias-interactive-bg-hover-solid, rgba(0, 0, 0, 0.05));
}
</style>
