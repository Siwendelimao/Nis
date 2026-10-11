<script setup lang="ts">
/**
 * StatsLine 统计条 —— 合并版：同类参数汇入同一胶囊，悬停看明细
 *
 * 胶囊列表（每个都可悬停看详情）：
 *  [◐ 12%]              上下文（悬停：分段 + 已用/上限）
 *  [5 轮 · 6 回]         轮次/回复（悬停：工具调用数）
 *  [LLM 6.4s · 工具 2.1s] 耗时/速度（悬停明细含首字延迟；**胶囊不显示首字**=0930 设计口径）
 *  [输入 1.8K · 缓存 91%] token/缓存（胶囊=**本会话累计**命中率；悬停：单轮+累计明细）
 *
 * 数据全部真实：session.context RPC + session/status 事件 usage/timing + piChat 节点统计
 */
import { computed, ref, watch, onBeforeUnmount } from 'vue'
import { useProvidersStore } from '@/stores/providers'
import { useSettingsStore } from '@/stores/settings'
import { t } from '@/utils/i18n'
import { toolTitle } from '@/utils/toolClassifier'

const providersStore = useProvidersStore()
const settingsStore = useSettingsStore()

const props = defineProps<{
  contextValue?: number
  contextMax?: number
  /** 后端"判定值"（= 上轮真实 + 此后新增估算）—— ★ 0924 起语义收敛为：
   *  进度条上的**下轮预测线**位置（回答"再发一条消息会到多少"） */
  contextUsed?: number
  /** ★★ 0924（用户设计"预测线"）：**真实已用** token（上一轮模型回报的真实 usage）——
   *  圆环百分比 + 进度条"已用段"用它。与上面 contextUsed 的分工：
   *  真实值回答"**我现在用了多少**"，判定值回答"**再发一条会到多少**"。 */
  contextRealUsed?: number
  modelUsage?: Record<string, { timing?: { llmMs?: number; ttftMs?: number; toolMs?: number }; usage?: { promptTokens?: number; completionTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number } }> | null
  usedModels?: string[]
  currentModel?: string
  turns?: number
  steps?: number
  toolCalls?: number
  /** 本轮已运行秒数（>=0 时在最左显示计时胶囊，置于上下文胶囊左侧；ChatInterface 满 10s 才传值，之前传 null） */
  turnSeconds?: number | null
  /** 上下文分段占用（后端按真实请求内容分类的字符估算；null 时回退固定比例）。
   *  0911 体系化：mcpDetail=MCP 分服务明细；toolDetail=逐工具明细（前端按 bucket 挂到对应行下） */
  breakdown?: {
    base: number; sysTools: number; specialTools: number; mcpTools: number; skill: number; messages: number
    mcpDetail?: Array<{ name: string; tokens: number }>
    toolDetail?: Array<{ name: string; bucket: 'mcp' | 'skill' | 'sys' | 'special'; tokens: number }>
  } | null
  /** 成员 token 汇总（第 6 胶囊，仅团队会话）：黑板 runs 按成员累计（任务口径） */
  memberUsage?: Array<{ memberName: string; promptTokens: number; completionTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number; llmMs: number; model?: string; runs: number }>
  /** 手机端紧凑模式（0907 图二）：上下文胶囊常驻 + 其余胶囊单槽轮播（Teleport 进底部导航） */
  compact?: boolean
  /** ★ 0921m：本会话累计用量（悬停气泡"累计视角"；每轮真实 usage 累加，压缩/换模型都不清零） */
  usageTotals?: { uncached: number; cacheRead: number; cacheWrite: number; output: number; turns: number } | null
  /** ★ 0921m：已压缩次数 + 最近一次折叠明细（上下文胶囊显示"压 N"） */
  compactionCount?: number
  lastCompaction?: { folded: number; at: number } | null
}>()

/* ── 上下文 ── */
const contextMaxTokens = computed(() => (props.contextMax && props.contextMax > 0 ? props.contextMax : 128000))
/* ★★ 0924（用户设计"预测线"）：百分比改用**真实已用** —— 圆环百分比、已用段、五档配色全跟它走。
   原来用的是后端下发的 usedTokens（= 判定值，含"此后新增估算"），于是"已用"和"预测线"是同一个数，
   屏幕上根本分不出"我现在用了多少 / 再发一条会到多少"。真实值拿不到时（首轮/刚重启）回退原百分比。 */
const contextPercent = computed(() => {
  const real = props.contextRealUsed
  if (real != null && real > 0) return Math.max(0, Math.min(100, real / contextMaxTokens.value * 100))
  return Math.max(0, Math.min(100, props.contextValue ?? 0))
})
/* 悬停明细里那行"~N / M"：同样优先真实值（它回答的就是"已经用了多少"） */
const contextUsedTokens = computed(() =>
  props.contextRealUsed != null && props.contextRealUsed > 0
    ? props.contextRealUsed
    : (props.contextUsed != null && props.contextUsed > 0
        ? props.contextUsed
        : Math.round(contextMaxTokens.value * contextPercent.value / 100)),
)
const ringPercent = computed(() => Math.max(2, contextPercent.value))
/* 0911 新批：压缩触发线——只保留气泡进度条上的刻度线（圆环上的小点用户反馈不好看，已去掉）。
   pct=阈值百分比（刻度线位置）；reached=当前占用是否已达阈值（达线加深）。 */
const compactMark = computed(() => {
  const g: any = settingsStore.general
  if (!g?.contextCompaction) return null
  const pct = Math.min(99, Math.max(1, Number(g.contextCompactThresholdPct) || 80))
  return { pct, reached: contextPercent.value >= pct }
})
/* ★★ 0924（用户定稿）：**圆环/进度条上不再加任何新标记** —— 中间试过"余量块 / 预测线 / 保留线"，
   实装后用户反馈"搞得更复杂了"，全部撤掉，只保留原来的**触发线刻度**（.ctx-bar-mark）。
   （四档配色 + 黄色预警是用户自己定的，保留；见下方 contextColor / nextCompactSoon。） */

/* ★★ 0924：**黄 = 下轮会压缩**（设计口径）—— 判据直接用"判定值是否到压缩线"。
   判定值（props.contextUsed）= 上轮真实 + 此后新增估算 ⇒ 它到线就意味着"这条消息发出去就会压"，
   与后端触发压缩的判定同源 —— **不需要在进度条上再画任何东西**（这正是撤掉预测线也不丢信息的原因）。
   ⚠️ 必须声明在 contextColor **之前** —— 项目踩过 TDZ（Cannot access before initialization）的坑。 */
const nextCompactSoon = computed(() => {
  const mark = compactMark.value
  if (!mark) return false
  const est = props.contextUsed
  if (est == null || est <= 0) return contextPercent.value >= mark.pct
  return est / contextMaxTokens.value * 100 >= mark.pct
})
/* ★ 0924（用户改版）：**四档梯度 + 黄色专用于「下一轮即将压缩」预警**。
   梯度（按"到压缩线的比例"）：绿 <25% → 蓝 <50% → 紫 <75% → 红 ≥75%（到线/超线）
   黄色 #f59e0b **退出梯度**，改为专用预警色 —— 语义是"这一轮还没超，但下一轮就要压了"。
   （原五档每档 20% 的绿→蓝→黄→紫→红被用户否掉：黄色与梯度混用会看不清"是安全档位还是预警"） */
const contextColor = computed(() => {
  // ① 预警优先：下一轮即将压缩 → 黄（不属于梯度，是独立语义）
  if (nextCompactSoon.value) return '#f59e0b'
  const scale = compactMark.value?.pct ?? 100   // 颜色刻度的“100%”对应的实际占用%（压缩关闭时=整个窗口）
  const ratio = contextPercent.value / scale
  if (ratio < 0.25) return '#10b981'   // 绿
  if (ratio < 0.50) return '#3b82f6'   // 蓝
  if (ratio < 0.75) return '#8b5cf6'   // 紫
  return '#ef4444'                      // 红（到线/超线，最警示）
})

// 无真实分段时的兜底比例（新会话首帧前）：系统/系统工具/对话消息
const SEG_FALLBACK = { base: 0.15, sysTools: 0.08, special: 0, mcp: 0, skill: 0, messages: 0.77 }
const SEG_META = [
  { key: 'base', label: 'stats.systemPrompt', color: '#111827' },
  { key: 'sysTools', label: 'stats.sysTools', color: '#6b7280' },
  { key: 'specialTools', label: 'stats.specialTools', color: '#9ca3af' },
  { key: 'mcpTools', label: 'stats.mcpTools', color: '#a78bfa' },
  // 0908收尾（用户反馈11）：该栏计量的是"技能设施预留"（系统提示技能清单+use_skill 定义），
  // 不是"用过技能"——旧标签 "Skill" 让人误以为本会话调用过技能。改语义化标签。
  { key: 'skill', label: 'stats.skillReserve', color: '#f59e0b' },
  { key: 'messages', label: 'stats.messages', color: '#3b82f6' },
] as const
const segments = computed(() => {
  const bd = props.breakdown
  let shares: Record<string, number>
  if (bd) {
    const total = (bd.base + bd.sysTools + bd.specialTools + bd.mcpTools + bd.skill + bd.messages) || 1
    shares = {
      base: bd.base / total, sysTools: bd.sysTools / total, specialTools: bd.specialTools / total,
      mcpTools: bd.mcpTools / total, skill: bd.skill / total, messages: bd.messages / total,
    }
  } else {
    shares = { base: SEG_FALLBACK.base, sysTools: SEG_FALLBACK.sysTools, specialTools: SEG_FALLBACK.special, mcpTools: SEG_FALLBACK.mcp, skill: SEG_FALLBACK.skill, messages: SEG_FALLBACK.messages }
  }
  // 0911 反馈②：六段常驻显示——去掉旧"低于阈值即隐藏"的过滤（大窗模型会把小段滤成只剩 3 条），
  // 没有数值的段显示 ~0；进度条里 0 宽段不画（barSegments 过滤，避免 min-width:2px 冒小色块）。
  return SEG_META.map(m => ({
    ...m,
    raw: (shares[m.key] || 0) * contextPercent.value,
    width: contextPercent.value * (shares[m.key] || 0),
  }))
})
/** 进度条实际绘制段（0 宽不画） */
const barSegments = computed(() => segments.value.filter(s => s.width > 0.01))
/** 0911 体系化子明细（反馈⑥）：MCP 行下挂逐 server；系统/特殊工具行下挂逐工具。
 *  来源 = 后端 toolDetail / mcpDetail（分类与计量均由后端体系化产出，前端只负责展示）。 */
const segDetails = computed<Record<string, Array<{ key: string; label: string; tokens: number }>>>(() => {
  const out: Record<string, Array<{ key: string; label: string; tokens: number }>> = {}
  const bd: any = props.breakdown
  if (!bd) return out
  if (Array.isArray(bd.mcpDetail) && bd.mcpDetail.length) {
    out.mcpTools = bd.mcpDetail.map((d: any) => ({
      key: 'mcp:' + String(d.name),
      label: mcpServerLabel(String(d.name)),
      tokens: Math.max(0, Math.round(Number(d.tokens) || 0)),
    }))
  }
  if (Array.isArray(bd.toolDetail) && bd.toolDetail.length) {
    for (const d of bd.toolDetail) {
      const bucket = d.bucket === 'sys' ? 'sysTools' : d.bucket === 'special' ? 'specialTools' : null
      if (!bucket) continue
      ;(out[bucket] ||= []).push({
        key: bucket + ':' + String(d.name),
        label: toolTitle(String(d.name)),
        tokens: Math.max(0, Math.round(Number(d.tokens) || 0)),
      })
    }
  }
  return out
})
/** 内置虚拟 MCP 的友好显示名；其余 server 直接显示名字（接入新 MCP 无需改这里） */
function mcpServerLabel(name: string): string {
  if (name === 'nis-browser') return t('panel.builtinBrowser')
  return name
}

/* ── usage/timing 按当前模型取（后两胶囊跟随模型）——selectedModel 链路断点时回退最近使用的模型，胶囊不空转 ── */
const currentData = computed(() => {
  const mu = props.modelUsage
  if (!mu) return null
  const cur = props.currentModel ? mu[props.currentModel] : null
  if (cur) return cur
  const keys = Object.keys(mu)
  if (keys.length === 1) return mu[keys[0]]
  if (keys.length && props.usedModels?.length) {
    for (let i = props.usedModels.length - 1; i >= 0; i--) {
      const m = props.usedModels[i]
      if (mu[m]) return mu[m]
    }
  }
  return null
})
const timing = computed(() => currentData.value?.timing || null)
const usage = computed(() => {
  const u = currentData.value?.usage
  if (!u) return null
  if (!u.promptTokens && !u.completionTokens && !u.cacheReadTokens) return null
  return {
    // 后端口径（pi-ai）：promptTokens 已是未命中部分，cacheRead/cacheWrite 单列——
    // 不得再减一遍（曾把 uncached 减成 0 → 缓存命中率恒 100%）
    uncached: u.promptTokens || 0,
    cacheRead: u.cacheReadTokens || 0,
    cacheWrite: u.cacheWriteTokens || 0,
    output: u.completionTokens || 0,
  }
})
const billedInput = computed(() => usage.value ? usage.value.uncached + usage.value.cacheRead + usage.value.cacheWrite : 0)
const cacheHit = computed(() => {
  if (!usage.value || billedInput.value === 0) return null
  if (!usage.value.cacheRead && !usage.value.cacheWrite) return null
  return Math.round(usage.value.cacheRead / billedInput.value * 100)
})
/* ★ 0921m：本会话累计口径（与单轮同一算法：命中读 ÷ 全部计费输入） */
const totalsInput = computed(() => {
  const t = props.usageTotals
  return t ? (t.uncached || 0) + (t.cacheRead || 0) + (t.cacheWrite || 0) : 0
})
const totalsHit = computed(() => {
  if (!props.usageTotals || totalsInput.value <= 0) return null
  return Math.round((props.usageTotals.cacheRead || 0) / totalsInput.value * 100)
})
const compactionCount = computed(() => Number(props.compactionCount) || 0)
const lastCompaction = computed(() => props.lastCompaction || null)
const tokensPerSec = computed(() => {
  if (!usage.value || !timing.value?.llmMs || timing.value.llmMs <= 0) return null
  return usage.value.output / (timing.value.llmMs / 1000)
})

/* ── 胶囊文案（空数据也显示，默认值兜底） ── */
const showToolMs = computed(() => !!timing.value?.toolMs && timing.value.toolMs > 0)
const showTTFT = computed(() => !!timing.value?.ttftMs)   // 明细行仍展示首字延迟（0930：只在胶囊隐藏）
/** ★ 0922z2c（反馈"三种耗时挤一串看着乱"）：拆成"标签 + 数值"两段给模板渲染；
 *  timingText 仍由它拼出 —— 手机端轮播等其它用法行为不变。 */
const timingParts = computed<Array<{ label: string; value: string }>>(() => {
  if (!timing.value?.llmMs) return [{ label: 'LLM', value: '--' }]
  const out = [{ label: 'LLM', value: formatDuration(timing.value.llmMs) }]
  if (showToolMs.value) out.push({ label: t('stats.tool'), value: formatDuration(timing.value.toolMs || 0) })
  return out
})
const timingText = computed(() => timingParts.value.map(p => `${p.label} ${p.value}`).join(' · '))
/** 轮次行的悬停介绍 = 口径说明（★0930 拆分批加载：范围说明随批次一起拆） */
const turnRowHint = computed(() => t('stats.turnCountHint'))
/** token 胶囊文案：输入（完整 prompt=未命中+缓存读写，对齐供应商账单）+ 缓存命中率 */
const tokensText = computed(() => {
  const parts = [usage.value ? `${t('stats.input')} ${formatTokens(billedInput.value)}` : `${t('stats.input')} --`]
  /* ★0930 设计口径：胶囊显示**本会话累计**缓存命中（单轮值仍在悬停明细里） */
  const hitShown = totalsHit.value != null ? totalsHit.value : cacheHit.value
  if (hitShown != null) parts.push(`${t('stats.cache')} ${hitShown}%`)
  return parts.join(' · ')
})

/* ── 第5胶囊：对话用过的不同模型（去重计数） ── */
const modelCount = computed(() => props.usedModels?.length || 0)
function modelDisplayName(mid: string): string {
  for (const p of providersStore.providers) {
    const name = providersStore.modelName(p.id, mid)
    if (name && name !== mid) return name
  }
  return mid
}

/* ── 第6胶囊：成员 token（仅团队会话）——黑板 runs 按成员任务累计 ──
 *  口径与主胶囊一致：billed 输入 = promptTokens（未命中）+ cacheRead + cacheWrite */
const memberTotal = computed(() => (props.memberUsage || []).reduce((acc, m) => acc + (m.promptTokens || 0) + (m.cacheReadTokens || 0) + (m.cacheWriteTokens || 0) + (m.completionTokens || 0), 0))
function memberLine(mu: { memberName: string; promptTokens: number; completionTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number; llmMs: number; runs: number; model?: string }): string {
  const billedInput = (mu.promptTokens || 0) + (mu.cacheReadTokens || 0) + (mu.cacheWriteTokens || 0)
  const parts = [t('stats.turnN', { n: mu.runs }), `${t('stats.inShort')} ${formatTokens(billedInput)}`, `${t('stats.outShort')} ${formatTokens(mu.completionTokens || 0)}`]
  const cached = (mu.cacheReadTokens || 0) + (mu.cacheWriteTokens || 0)
  if (cached > 0 && billedInput > 0) parts.push(`${t('stats.cache')} ${Math.round((mu.cacheReadTokens || 0) / billedInput * 100)}%`)
  if (mu.llmMs > 0) parts.push(formatDuration(mu.llmMs))
  return parts.join(' · ')
}
function modelTimingLine(mid: string): string {
  const tm = props.modelUsage?.[mid]?.timing
  if (!tm?.llmMs) return '--'
  const parts = [`LLM ${formatDuration(tm.llmMs)}`]
  if (tm.ttftMs) parts.push(`${t('stats.ttft')} ${formatDuration(tm.ttftMs)}`)
  return parts.join(' · ')
}
function modelTokensLine(mid: string): string {
  const u = props.modelUsage?.[mid]?.usage
  if (!u || (!u.promptTokens && !u.completionTokens && !u.cacheReadTokens)) return '--'
  const billed = (u.promptTokens || 0) + (u.cacheReadTokens || 0) + (u.cacheWriteTokens || 0)
  const parts = [`${t('stats.input')} ${formatTokens(billed)}`]
  if ((u.cacheReadTokens || u.cacheWriteTokens) && billed > 0) parts.push(`${t('stats.cache')} ${Math.round(((u.cacheReadTokens || 0) / billed) * 100)}%`)
  return parts.join(' · ')
}

/* 悬停状态 */
const hover = ref<Record<string, boolean>>({})
function onHover(key: string, v: boolean) {
  hover.value[key] = v
}
/* ★ 0920（反馈）：上下文气泡内的逐工具明细 —— 原先是在弹窗**内部**展开（撑开弹窗、
   还会被 `.ctx-rows` 的 overflow 裁掉）；现改成悬停在父行时从**行右侧**弹一个独立小气泡。
   气泡 Teleport 到 body，所以这里只负责"给谁弹 + 弹在哪"。 */
const subPop = ref<{ key: string; x: number; y: number; color: string; list: Array<{ key: string; label: string; tokens: number }> }>(
  { key: '', x: 0, y: 0, color: '', list: [] },
)
let subHideTimer: ReturnType<typeof setTimeout> | null = null

/** 悬停父行：量该行真实矩形，把气泡贴在它右侧；右侧放不下就翻到左侧；下方放不下则上移 */
function showSubPop(seg: { key: string; color: string }, ev: MouseEvent): void {
  const el = ev.currentTarget as HTMLElement | null
  const list = segDetails.value[seg.key] || []
  if (!el || !list.length) return
  if (subHideTimer) { clearTimeout(subHideTimer); subHideTimer = null }
  const r = el.getBoundingClientRect()
  const W = 236
  const H = Math.min(320, 22 + list.length * 20)
  let x = r.right + 8
  if (x + W > window.innerWidth - 12) x = Math.max(8, r.left - 8 - W)
  let y = r.top
  if (y + H > window.innerHeight - 12) y = Math.max(8, window.innerHeight - 12 - H)
  subPop.value = { key: seg.key, x, y, color: seg.color, list }
}

/** 移开父行：延时收起（行与行之间移动时不闪） */
function hideSubPopSoon(): void {
  if (subHideTimer) clearTimeout(subHideTimer)
  subHideTimer = setTimeout(() => { subPop.value = { ...subPop.value, key: '' } }, 140)
}

function hasSub(key: string): boolean {
  const d = segDetails.value[key]
  return Array.isArray(d) && d.length > 0
}

/* 格式化 */
function formatTokens(n: number): string {
  const scaled = (v: number): string =>
    v >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10)
  if (n < 1000) return String(n)
  if (n < 1000000) return `${scaled(n / 1000)}K`
  return `${scaled(n / 1000000)}M`
}
function formatDuration(ms: number): string {
  const s = ms / 1000
  if (s < 60) return `${Math.round(s * 10) / 10}s`
  const whole = Math.round(s)
  return `${Math.floor(whole / 60)}m${whole % 60}s`
}
function formatTokensPerSecond(tps: number): string {
  const clamped = Math.max(0, tps)
  return clamped >= 10 ? String(Math.round(clamped)) : String(Math.round(clamped * 10) / 10)
}
/** 本轮计时文案：秒→分→时→日进位（>10s 起由 ChatInterface 传值） */
function formatTurn(sec: number): string {
  if (sec < 60) return t('stats.secN', { n: sec })
  if (sec < 3600) return t('stats.minSec', { m: Math.floor(sec / 60), s: sec % 60 })
  if (sec < 86400) return t('stats.hourMin', { h: Math.floor(sec / 3600), m: Math.floor((sec % 3600) / 60) })
  return t('stats.dayHour', { d: Math.floor(sec / 86400), h: Math.floor((sec % 86400) / 3600) })
}

/* ── compact（0907 图二）：上下文常驻 + 其余胶囊文案单槽轮播（Teleport 进手机底部导航） ── */
const rollTexts = computed<string[]>(() => {
  const out: string[] = []
  if (props.turnSeconds != null) out.push(`${t('stats.thisTurn')} ${formatTurn(props.turnSeconds)}`)
  out.push(t('stats.turnsSteps', { turns: props.turns || 0, steps: props.steps || 0 }))
  out.push(timingText.value + (showToolMs.value && timing.value?.toolMs ? ` · ${t('stats.tool')} ${formatDuration(timing.value.toolMs)}` : ''))
  out.push(tokensText.value)
  if (modelCount.value > 1) out.push(`${modelCount.value}`)
  if (props.memberUsage && props.memberUsage.length) out.push(`${t('stats.members')} ${formatTokens(memberTotal.value)}`)
  return out
})
/** ★1012y：**第三胶囊**（用户图2「输入 4.5M · 缓存 98%」）——
 *  输入 = 非缓存 + 缓存读 + 缓存写（本会话累计 `usageTotals`）；缓存命中率 = 缓存读 /（缓存读 + 非缓存）。 */
const usageText = computed(() => {
  const u: any = props.usageTotals
  if (!u) return ''
  const inTok = (u.uncached || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0)
  if (inTok <= 0) return ''
  const base = (u.cacheRead || 0) + (u.uncached || 0)
  const hit = base > 0 ? Math.round((u.cacheRead || 0) / base * 100) : 0
  // ★1012af：需求要求手机端**只显示缓存命中率** —— "输入 36K · 缓存 42%" 会撑出胶囊格（300px 宽的屏上没地方）。
  return `缓存 ${hit}%`
})
const rollIdx = ref(0)
let rollTimer: ReturnType<typeof setInterval> | undefined
function stopRoll() { if (rollTimer) { clearInterval(rollTimer); rollTimer = undefined } }
function startRoll() {
  stopRoll()
  /* ★1012y：用户改口 —— 点击切换在他真机上没反应 ⇒ **改回自动轮播**（并去掉圆点指示）。
     胶囊宽度已固定（11em），轮播不会再让整行左右跳；节能档仍不轮播。 */
  if (!props.compact || (settingsStore.appearance as any)?.fxLevel === 'eco') return
  rollTimer = setInterval(() => {
    const n = rollTexts.value.length
    if (n > 1) rollIdx.value = (rollIdx.value + 1) % n
  }, 2600)
}
watch(() => [props.compact, (settingsStore.appearance as any)?.fxLevel] as const, ([c]) => { c ? startRoll() : stopRoll() }, { immediate: true })
// 文案列表变短（如计时消失）时索引越界回绕
watch(rollTexts, (arr) => { if (rollIdx.value >= arr.length) rollIdx.value = 0 })
onBeforeUnmount(stopRoll)
</script>

<template>
  <div class="stats-line" :class="{ 'stats-line-compact': compact, 'stats-teleported': compact }">
    <!-- ── compact（0907 图二）：上下文胶囊常驻 + 其余胶囊文案单槽轮播 ── -->
    <template v-if="compact">
      <!-- ★1012aa：手机**没有 hover** ⇒ 三颗胶囊都改成「点击看明细气泡」（PC 是悬停触发）。
           气泡复用既有 .ctx-popover 样式；.stats-tap-pop 负责手机端屏内定位。 -->
      <div class="stats-pill stats-pill-ctx" @click="onHover('ctx', !hover.ctx)">
        <svg viewBox="0 0 14 14" width="13" height="13" aria-hidden>
          <circle cx="7" cy="7" r="5.5" fill="none" :stroke="contextColor + '22'" stroke-width="2" />
          <circle
            cx="7" cy="7" r="5.5" fill="none"
            :stroke="contextColor" stroke-width="2" stroke-linecap="round"
            :stroke-dasharray="`${(2 * Math.PI * 5.5) * ringPercent / 100} ${2 * Math.PI * 5.5}`"
            transform="rotate(-90 7 7)"
          />
        </svg>
        <span class="stats-text">{{ Math.round(contextPercent * 10) / 10 }}%<template v-if="compactionCount"> · {{ t('stats.compactedShort') }}{{ compactionCount }}</template></span>
        <div v-if="hover.ctx" class="ctx-popover stats-tap-pop">
          <div class="ctx-rows">
            <div class="ctx-row"><dt>已用</dt><dd>{{ formatTokens(contextUsedTokens) }} / {{ formatTokens(contextMaxTokens) }}</dd></div>
            <div class="ctx-row"><dt>占比</dt><dd>{{ Math.round(contextPercent * 10) / 10 }}%</dd></div>
            <div v-if="breakdown" class="ctx-row"><dt>基础</dt><dd>{{ formatTokens(breakdown.base) }}</dd></div>
            <div v-if="breakdown" class="ctx-row"><dt>工具</dt><dd>{{ formatTokens((breakdown.sysTools || 0) + (breakdown.specialTools || 0) + (breakdown.mcpTools || 0)) }}</dd></div>
            <div v-if="breakdown" class="ctx-row"><dt>技能</dt><dd>{{ formatTokens(breakdown.skill || 0) }}</dd></div>
            <div v-if="breakdown" class="ctx-row"><dt>消息</dt><dd>{{ formatTokens(breakdown.messages || 0) }}</dd></div>
          </div>
        </div>
      </div>
      <!-- ★1012y：第二条 = 标准胶囊（与上下文同款 ⇒ 等高），内容自动轮播；点击看耗时明细 -->
      <div v-if="rollTexts.length" class="stats-pill stats-pill-roll" @click="onHover('timing', !hover.timing)">
        <Transition name="roll" mode="out-in">
          <span class="stats-roll" :key="rollIdx">{{ rollTexts[rollIdx] }}</span>
        </Transition>
        <div v-if="hover.timing" class="ctx-popover stats-tap-pop">
          <div class="ctx-rows">
            <div class="ctx-row"><dt>轮次</dt><dd>{{ turns || 0 }} 轮 · {{ steps || 0 }} 段</dd></div>
            <div class="ctx-row"><dt>耗时</dt><dd>{{ timingText }}</dd></div>
          </div>
        </div>
      </div>
      <!-- ★1012y：第三条 = 输入量 / 缓存命中率（点击看 token 明细） -->
      <div v-if="usageText" class="stats-pill stats-pill-usage" @click="onHover('tokens', !hover.tokens)">
        {{ usageText }}
        <div v-if="hover.tokens" class="ctx-popover stats-tap-pop">
          <div class="ctx-rows">
            <div v-if="usageTotals" class="ctx-row"><dt>非缓存</dt><dd>{{ formatTokens(usageTotals.uncached || 0) }}</dd></div>
            <div v-if="usageTotals" class="ctx-row"><dt>缓存读</dt><dd>{{ formatTokens(usageTotals.cacheRead || 0) }}</dd></div>
            <div v-if="usageTotals" class="ctx-row"><dt>缓存写</dt><dd>{{ formatTokens(usageTotals.cacheWrite || 0) }}</dd></div>
            <div v-if="usageTotals" class="ctx-row"><dt>输出</dt><dd>{{ formatTokens(usageTotals.output || 0) }}</dd></div>
          </div>
        </div>
      </div>
    </template>
    <!-- ── PC 完整模式（原有各胶囊，悬停看详情） ── -->
    <!-- 本轮计时胶囊（黑灰折线动画 + 计时），置于上下文胶囊左侧 -->
    <div v-if="!compact && turnSeconds != null" class="stats-pill stats-pill-turn">
      <span class="turn-wave" aria-hidden>
        <svg viewBox="0 0 64 48" width="18" height="13" preserveAspectRatio="xMidYMid meet">
          <polyline class="tw-back" points="0.157 23.954, 14 23.954, 21.843 48, 43 0, 50 24, 64 24" />
          <polyline class="tw-front" points="0.157 23.954, 14 23.954, 21.843 48, 43 0, 50 24, 64 24" />
        </svg>
      </span>
      <span class="stats-text">{{ t('stats.thisTurn') }} {{ formatTurn(turnSeconds) }}</span>
    </div>

    <!-- 上下文：圆环 + 百分比（手机端唯一保留的胶囊，见 style.css .stats-pill-ctx） -->
    <div
      v-if="!compact"
      class="stats-pill stats-pill-ctx"
      @mouseenter="onHover('ctx', true)"
      @mouseleave="onHover('ctx', false)"
    >
      <svg viewBox="0 0 14 14" width="14" height="14" aria-hidden>
        <circle cx="7" cy="7" r="5.5" fill="none" :stroke="contextColor + '22'" stroke-width="2" />
        <circle
          cx="7" cy="7" r="5.5" fill="none"
          :stroke="contextColor" stroke-width="2" stroke-linecap="round"
          :stroke-dasharray="`${(2 * Math.PI * 5.5) * ringPercent / 100} ${2 * Math.PI * 5.5}`"
          transform="rotate(-90 7 7)"
        />
      </svg>
      <span class="stats-text">{{ Math.round(contextPercent * 10) / 10 }}%</span>
      <Transition name="ctx-pop">
        <div v-if="hover.ctx" class="ctx-popover">
          <div class="ctx-header">
            <span class="ctx-title">{{ t('stats.ctxUsed') }}</span>
            <span class="ctx-percent" :style="{ color: contextColor }">{{ Math.round(contextPercent * 10) / 10 }}%</span>
            <span class="ctx-figures">~{{ formatTokens(contextUsedTokens) }} / {{ formatTokens(contextMaxTokens) }}</span>
          </div>
          <div class="ctx-bar-wrap">
            <div class="ctx-bar">
              <div
                v-for="seg in barSegments"
                :key="seg.key"
                class="ctx-bar-seg"
                :style="{ width: seg.width + '%', backgroundColor: seg.color }"
              ></div>
            </div>
            <!-- ★★ 0924（用户定稿）：**预测线 / 保留线已撤掉** —— 用户反馈"搞得更复杂了"，
                 回到只留下面那条触发线刻度的干净状态（信息一个没少：判定值到线时圆环会变黄）。 -->
            <!-- 0911 新批：进度条上的压缩触发刻度线（与圆环标识同一阈值；超出条身 3px 更像刻度） -->
            <span
              v-if="compactMark"
              class="ctx-bar-mark"
              :class="{ reached: compactMark.reached }"
              :style="{ left: compactMark.pct + '%' }"
            ></span>
          </div>
          <!-- 0911 反馈②：六段常驻（无数据也列 ~0）；
               0917b 反馈①：默认只显示各段合计，悬停某段看子项
               ★ 0920（反馈）：子项**不再在弹窗内部展开** —— 那会撑开弹窗、还会被
               `.ctx-rows` 的 overflow 裁掉；改成从该行**右侧弹出独立气泡**（见下方 Teleport）。 -->
          <dl class="ctx-rows">
            <template v-for="seg in segments" :key="seg.key">
              <div
                class="ctx-row-wrap"
                @mouseenter="hasSub(seg.key) && showSubPop(seg, $event)"
                @mouseleave="hasSub(seg.key) && hideSubPopSoon()"
              >
                <div class="ctx-row" :class="{ 'ctx-row-hassub': hasSub(seg.key) }">
                  <dt>
                    <span class="ctx-swatch" :style="{ backgroundColor: seg.color }"></span>
                    {{ t(seg.label) }}
                    <span v-if="hasSub(seg.key)" class="ctx-caret">›</span>
                  </dt>
                  <dd>~{{ formatTokens(Math.round(contextMaxTokens * seg.width / 100)) }}</dd>
                </div>
              </div>
            </template>
          </dl>
          <div class="ctx-arrow"></div>
          <!-- ★ 0920：明细气泡 —— Teleport 到 body + fixed 定位，
               这样既不被 `.ctx-rows`/`.ctx-popover` 的 overflow 裁掉，也不会把弹窗撑大。
               位置在 showSubPop() 里按行矩形算：默认贴行右侧，右边放不下就翻到左侧。 -->
          <Teleport to="body">
            <div
              v-if="subPop.key"
              class="ctx-subs-pop"
              :style="{ left: subPop.x + 'px', top: subPop.y + 'px' }"
            >
              <div v-for="d in subPop.list" :key="d.key" class="ctx-row ctx-row-sub">
                <dt>
                  <span class="ctx-dot" :style="{ backgroundColor: subPop.color }"></span>
                  <span class="ctx-sub-name" :title="d.label">{{ d.label }}</span>
                </dt>
                <dd>~{{ formatTokens(d.tokens) }}</dd>
              </div>
            </div>
          </Teleport>
        </div>
      </Transition>
    </div>

    <!-- 轮次 · 回复数 -->
    <div
      v-if="!compact"
      class="stats-pill"
      @mouseenter="onHover('meta', true)"
      @mouseleave="onHover('meta', false)"
    >
      <span class="stats-text">
        <span class="st-v">{{ turns || 0 }}</span><span class="st-u">{{ t('stats.unitTurn') }}</span>
        <span class="st-sep">·</span>
        <span class="st-v">{{ steps || 0 }}</span><span class="st-u">{{ t('stats.unitSeg') }}</span>
      </span>
      <Transition name="ctx-pop">
        <div v-if="hover.meta" class="ctx-popover">
          <div class="ctx-header"><span class="ctx-title">{{ t('stats.dialogStats') }}</span></div>
          <dl class="ctx-rows">
            <div class="ctx-row" :title="turnRowHint"><dt>{{ t('stats.turnCount') }}</dt><dd>{{ turns || 0 }}</dd></div>
            <div class="ctx-row" :title="t('stats.replyCountHint')"><dt>{{ t('stats.replyCount') }}</dt><dd>{{ steps || 0 }}</dd></div>
            <div v-if="toolCalls" class="ctx-row" :title="t('stats.toolCallsHint')"><dt>{{ t('stats.toolCalls') }}</dt><dd>{{ toolCalls }}</dd></div>
          </dl>

          <div class="ctx-arrow"></div>
        </div>
      </Transition>
    </div>

    <!-- LLM 耗时 · 首字延迟（工具耗时并入文字） -->
    <div
      v-if="!compact"
      class="stats-pill"
      @mouseenter="onHover('timing', true)"
      @mouseleave="onHover('timing', false)"
    >
      <span class="stats-text">
        <template v-for="(p, i) in timingParts" :key="p.label + i">
          <span v-if="i" class="st-sep">·</span>
          <span class="st-l">{{ p.label }}</span><span class="st-v">{{ p.value }}</span>
        </template>
      </span>
      <Transition name="ctx-pop">
        <div v-if="hover.timing" class="ctx-popover">
          <div class="ctx-header"><span class="ctx-title">{{ t('stats.timing') }}</span></div>
          <dl class="ctx-rows">
            <template v-if="timing">
              <div class="ctx-row"><dt>{{ t('stats.llmTime') }}</dt><dd>{{ timing.llmMs ? formatDuration(timing.llmMs) : '--' }}</dd></div>
              <div v-if="showTTFT" class="ctx-row"><dt>{{ t('stats.ttftTime') }}</dt><dd>{{ formatDuration(timing.ttftMs) }}</dd></div>
              <div v-if="showToolMs" class="ctx-row"><dt>{{ t('stats.toolTime') }}</dt><dd>{{ formatDuration(timing.toolMs) }}</dd></div>
              <div v-if="tokensPerSec != null" class="ctx-row"><dt>{{ t('stats.genSpeed') }}</dt><dd>{{ formatTokensPerSecond(tokensPerSec) }}{{ t('stats.tokensPerSec') }}</dd></div>
            </template>
            <div v-else class="ctx-row"><dt>{{ t('stats.noData') }}</dt><dd>—</dd></div>
          </dl>
          <div class="ctx-arrow"></div>
        </div>
      </Transition>
    </div>

    <!-- 输入 token · 缓存命中率 -->
    <div
      v-if="!compact"
      class="stats-pill"
      @mouseenter="onHover('tokens', true)"
      @mouseleave="onHover('tokens', false)"
    >
      <span class="stats-text">{{ tokensText }}</span>
      <Transition name="ctx-pop">
        <div v-if="hover.tokens" class="ctx-popover">
          <div class="ctx-header"><span class="ctx-title">{{ t('stats.tokenUsage') }}</span></div>
          <dl class="ctx-rows">
            <template v-if="usage">
              <div class="ctx-row"><dt>{{ t('stats.inputUncached') }}</dt><dd>{{ formatTokens(usage.uncached) }}</dd></div>
              <div class="ctx-row"><dt>{{ t('stats.inputCachedTotal') }}</dt><dd>{{ formatTokens(billedInput) }}</dd></div>
              <div class="ctx-row"><dt>{{ t('stats.output') }}</dt><dd>{{ formatTokens(usage.output) }}</dd></div>
              <div v-if="cacheHit != null" class="ctx-row"><dt>{{ t('stats.cacheHit') }}</dt><dd>{{ cacheHit }}%</dd></div>
              <div v-if="usage.cacheRead" class="ctx-row"><dt>{{ t('stats.cacheRead') }}</dt><dd>{{ formatTokens(usage.cacheRead) }}</dd></div>
              <div v-if="usage.cacheWrite" class="ctx-row"><dt>{{ t('stats.cacheWrite') }}</dt><dd>{{ formatTokens(usage.cacheWrite) }}</dd></div>
              <!-- ★ 0921m：本会话累计视角（不受压缩影响） -->
              <template v-if="usageTotals && usageTotals.turns">
                <div class="ctx-sub">{{ t('stats.sessionTotals') }}</div>
                <div class="ctx-row"><dt>{{ t('stats.inputCachedTotal') }}</dt><dd>{{ formatTokens(totalsInput) }}</dd></div>
                <div class="ctx-row"><dt>{{ t('stats.cacheHit') }}</dt><dd>{{ totalsHit != null ? totalsHit + '%' : '—' }}</dd></div>
                <div class="ctx-row"><dt>{{ t('stats.output') }}</dt><dd>{{ formatTokens(usageTotals.output) }}</dd></div>
                <div class="ctx-row"><dt>{{ t('stats.turnsShort') }}</dt><dd>{{ usageTotals.turns }}</dd></div>
              </template>
              <!-- ★ 0921m：压缩次数（每次压缩 +1） -->
              <div v-if="compactionCount" class="ctx-sub">{{ t('stats.compacted', { n: compactionCount }) }}<template v-if="lastCompaction">（{{ t('stats.compactLast', { folded: lastCompaction.folded }) }}）</template></div>
            </template>
            <div v-else class="ctx-row"><dt>{{ t('stats.noData') }}</dt><dd>—</dd></div>
          </dl>
          <div class="ctx-arrow"></div>
        </div>
      </Transition>
    </div>

    <!-- 第5胶囊：对话用过的不同模型（去重计数；悬停查看各模型后两胶囊数据） -->
    <div
      v-if="!compact && modelCount > 1"
      class="stats-pill"
      @mouseenter="onHover('models', true)"
      @mouseleave="onHover('models', false)"
    >
      <span class="stats-text">{{ modelCount }}</span>
      <Transition name="ctx-pop">
        <div v-if="hover.models" class="ctx-popover">
          <div class="ctx-header"><span class="ctx-title">{{ t('stats.usedModels', { n: modelCount }) }}</span></div>
          <div class="ctx-rows">
            <div v-for="mid in usedModels" :key="mid" class="model-entry">
              <div class="model-entry-name">{{ modelDisplayName(mid) }}</div>
              <div class="ctx-row"><dd>{{ modelTimingLine(mid) }}</dd></div>
              <div class="ctx-row"><dd>{{ modelTokensLine(mid) }}</dd></div>
            </div>
          </div>
          <div class="ctx-arrow"></div>
        </div>
      </Transition>
    </div>

    <!-- 第6胶囊：成员 token（仅团队会话；任务累计口径，与黑板进度对齐） -->
    <div
      v-if="!compact && memberUsage && memberUsage.length"
      class="stats-pill"
      @mouseenter="onHover('members', true)"
      @mouseleave="onHover('members', false)"
    >
      <span class="stats-text">{{ t('stats.members') }} {{ formatTokens(memberTotal) }}</span>
      <Transition name="ctx-pop">
        <div v-if="hover.members" class="ctx-popover">
          <div class="ctx-header"><span class="ctx-title">{{ t('stats.memberUsageTitle') }}</span></div>
          <div class="ctx-rows">
            <div v-for="mu in memberUsage" :key="mu.memberName" class="model-entry">
              <div class="model-entry-name">{{ mu.memberName }}<span v-if="mu.model" class="member-model"> · {{ mu.model }}</span></div>
              <div class="ctx-row"><dd>{{ memberLine(mu) }}</dd></div>
            </div>
          </div>
          <div class="ctx-arrow"></div>
        </div>
      </Transition>
    </div>
  </div>
</template>

<style scoped>
.stats-line {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-wrap: wrap;
  gap: 6px;
  padding: 4px 0 2px;
  user-select: none;
}
.stats-pill {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 10px;
  border-radius: 9999px;
  background: rgba(255, 255, 255, 0.6);
  backdrop-filter: blur(8px);
  border: 1px solid rgba(0, 0, 0, 0.06);
  font-size: 11px;
  color: #6b7280;
  white-space: nowrap;
  cursor: pointer;
  transform: translateZ(0);
  transition: transform 0.15s ease, box-shadow 0.15s ease;
}
.stats-pill:hover {
  transform: translateY(-2px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.10);
}
.stats-text {
  display: inline-flex;
  align-items: baseline;
  gap: 3px;
  font-variant-numeric: tabular-nums;
}
/* ★ 0922z2c（反馈：中间两个胶囊"有点懵、有点乱"）：胶囊内统一"标签/数值"层次 ——
   数值更深更粗、标签与单位浅灰一号、分隔点更淡；与"输入/缓存"那个胶囊的节奏对齐。 */
.st-v { font-weight: 600; color: #4b5563; }
.st-l { color: #9ca3af; margin-right: 3px; }
.st-u { color: #9ca3af; margin-left: 1px; }
.st-sep { color: #d1d5db; margin: 0 3px; }
html.dark .st-v { color: #cbd5e1; }
html.dark .st-l, html.dark .st-u { color: #6b7280; }
html.dark .st-sep { color: #4b5563; }
/* ★ 0922z2c：统计卡底部的口径说明（浅灰小字，虚线分隔） */
.ctx-note {
  margin-top: 7px;
  padding-top: 6px;
  border-top: 1px dashed rgba(0, 0, 0, 0.07);
  font-size: 10px;
  line-height: 1.55;
  color: #9ca3af;
  max-width: 240px;
  white-space: normal;
}
html.dark .ctx-note { border-top-color: rgba(255, 255, 255, 0.1); }
.ctx-note-warn { border-top: none; padding-top: 0; margin-top: 3px; color: #b45309; }

/* DSH ContextMeter 风格悬停气泡 */
.ctx-popover {
  position: absolute;
  bottom: calc(100% + 8px);
  left: 50%;
  transform: translateX(-50%);
  min-width: 160px;
  background: #ffffff;
  border: 1px solid rgba(0, 0, 0, 0.08);
  border-radius: 12px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
  padding: 12px 14px;
  z-index: 9999;
}
.ctx-header {
  display: flex;
  align-items: baseline;
  gap: 6px;
  margin-bottom: 8px;
}
.ctx-title {
  font-size: 11px;
  color: #6b7280;
}
.ctx-percent {
  font-size: 16px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
/* ★ 0921m：气泡里的分组小标题（累计 / 压缩） */
.ctx-sub {
  margin-top: 8px;
  padding-top: 6px;
  border-top: 1px dashed rgba(0, 0, 0, 0.08);
  font-size: 10px;
  color: #6b7280;
}
.ctx-figures {
  margin-left: auto;
  font-size: 10px;
  color: #9ca3af;
  font-variant-numeric: tabular-nums;
}
.ctx-bar {
  display: flex;
  width: 100%;
  height: 6px;
  border-radius: 9999px;
  background: rgba(0, 0, 0, 0.06);
  overflow: hidden;
  gap: 2px;
}
.ctx-bar-seg {
  height: 100%;
  min-width: 2px;
  border-radius: 9999px;
  transition: width 0.5s ease-out;
}
/* ★★ 0924（用户定稿）：`.ctx-bar-est`（预测线）与 `.ctx-bar-keep`（保留线）**已整体移除** ——
   用户反馈"加了更复杂"。进度条上只保留下面那条 `.ctx-bar-mark` 触发线刻度。 */
/* 0911 新批：压缩触发刻度线——进度条上的小竖标（上下各出 3px 呈刻度感，不被条身圆角裁切） */
.ctx-bar-wrap { position: relative; }
.ctx-bar-mark {
  position: absolute;
  top: -3px;
  bottom: -3px;
  width: 2px;
  margin-left: -1px;
  border-radius: 1px;
  background: #64748b;
  pointer-events: none;
}
.ctx-bar-mark.reached { background: #111827; }
.ctx-rows {
  margin: 10px 0 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.ctx-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 11px;
  color: #6b7280;
}
.ctx-row dt {
  display: flex;
  align-items: center;
}
.ctx-swatch {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 3px;
  margin-right: 6px;
}
.ctx-row dd {
  margin: 0;
  font-size: 10px;
  color: #9ca3af;
  font-variant-numeric: tabular-nums;
}
.model-entry {
  padding: 6px 0;
  border-top: 1px solid rgba(0, 0, 0, 0.05);
}
.model-entry:first-child {
  border-top: none;
  padding-top: 0;
}
.model-entry-name {
  font-size: 11px;
  font-weight: 600;
  color: #374151;
  margin-bottom: 3px;
}
.member-model {
  font-weight: 400;
  color: #9ca3af;
  font-size: 10px;
}
.ctx-arrow {
  position: absolute;
  bottom: -5px;
  left: 50%;
  transform: translateX(-50%) rotate(45deg);
  width: 10px;
  height: 10px;
  background: #ffffff;
  border-right: 1px solid rgba(0, 0, 0, 0.08);
  border-bottom: 1px solid rgba(0, 0, 0, 0.08);
}

/* 气泡出现动画 */
.ctx-pop-enter-active {
  transition: opacity 0.2s ease, transform 0.2s cubic-bezier(0.34, 1.56, 0.64, 1);
}
.ctx-pop-leave-active {
  transition: opacity 0.12s ease, transform 0.12s ease;
}
.ctx-pop-enter-from,
.ctx-pop-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(6px) scale(0.96);
}

/* ── 本轮计时胶囊：折线流动动画（黑/灰配色，套用给定 dash 动画改色）── */
.stats-pill-turn {
  cursor: default;
}
.stats-pill-turn:hover {
  transform: translateY(-1px);
  box-shadow: 0 3px 8px rgba(0, 0, 0, 0.08);
}
.turn-wave {
  display: inline-flex;
  align-items: center;
  line-height: 0;
}
.turn-wave polyline {
  fill: none;
  stroke-width: 5;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.turn-wave .tw-back {
  stroke: #d1d5db; /* gray-300 轨道 */
}
.turn-wave .tw-front {
  stroke: #1f2937; /* gray-800 主体 */
  stroke-dasharray: 48, 144;
  stroke-dashoffset: 192;
  animation: turn-dash 1.4s linear infinite;
}
@keyframes turn-dash {
  72.5% { opacity: 0; }
  to { stroke-dashoffset: 0; }
}
/* ── compact（0907 图二）：底部导航单槽轮播样式 ── */
.stats-line-compact {
  justify-content: center;
  align-items: center;          /* ★1012y：三胶囊等高对齐（反馈"高度和上下文的不一样"） */
  gap: 8px;
  padding: 0;
}
/* ★1012y：第二/第三胶囊固定宽度 ⇒ 轮播与数值变化都不撑动整行（内容居中）。
   ★1012ad：第三胶囊（输入/缓存）**去掉强制最小宽** —— 用户真机反馈「文字跑到胶囊外面了」：
   它内部是裸文本没有省略号容器，min-width 小于文字宽时就会撑出边框。改为按内容自适应。 */
.stats-pill-roll { min-width: 11em; justify-content: center; }
.stats-pill-usage { min-width: 0; justify-content: center; }
/* ★1012z：三胶囊**等高** —— 反馈"高度和上下文的不一样"：轮播胶囊内容更矮（20px vs 25px），
   统一给个最小高度（内容垂直居中由 .stats-pill 的 inline-flex + align-items 负责）。 */
.stats-line-compact .stats-pill { min-height: 25px; }
/* ★1012aa：手机端点击气泡定位 —— `.ctx-popover` 原本是 absolute（跟着胶囊跑，窄屏容易出屏），
   这里改成**屏内固定**：贴在输入区上方、左右各留 10px，超高内部滚动。 */
.stats-tap-pop {
  position: fixed !important;
  /* ★1012ad：`.ctx-popover` 自带 `transform: translateX(-50%)`（PC 居中定位），手机端会把气泡推出屏
     （实测 rect.left = -55，而 left 计算值是 10px）⇒ 这里必须显式禁掉 transform。 */
  transform: none !important;
  left: 10px !important;
  right: 10px !important;
  bottom: calc(150px + env(safe-area-inset-bottom, 0px)) !important;
  top: auto !important;
  width: auto !important;
  max-width: none !important;
  max-height: 50vh;
  overflow-y: auto;
  z-index: 10020;
}
/* ★1012v（用户真机反馈）：
   ① 右侧轮播文案**没有胶囊外观**（左侧圆环有胶囊、右侧是裸文字，看着不成对）⇒ 套用 `.stats-pill` 同款；
   ② 文案长短变化 + 自动轮播导致**左右来回跑，很扎眼** ⇒ 给固定最小宽度（不再随文案伸缩），
      并**停掉自动轮播**（见 startRoll），只保留点击手动切换。 */
.stats-roll-slot {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 3px 10px;
  border: 1px solid rgba(0, 0, 0, 0.06);
  border-radius: 9999px;
  background: rgba(255, 255, 255, 0.6);
  backdrop-filter: blur(8px);
  width: 11em;                 /* ★1012w：用户定稿「第二个胶囊固定宽度 + 轮播」——硬固定，文案长短都不撑动整行 */
  overflow: hidden;
  font-size: 11px;
  color: #6b7280;
  white-space: nowrap;
  cursor: pointer;
  transition: background 0.15s ease;
}
html.dark .stats-roll-slot {
  background: rgba(30, 30, 36, 0.6);
  border-color: rgba(255, 255, 255, 0.08);
  color: #a1a1aa;
}
.stats-roll-slot:active { background: rgba(0, 0, 0, 0.06); }
.stats-roll-dots { display: inline-flex; align-items: center; gap: 3px; }
.stats-roll-dot { width: 4px; height: 4px; border-radius: 50%; background: rgba(0, 0, 0, 0.18); }
.stats-roll-dot.is-on { background: rgba(0, 0, 0, 0.45); }
html.dark .stats-roll-slot:active { background: rgba(255, 255, 255, 0.08); }
html.dark .stats-roll-dot { background: rgba(255, 255, 255, 0.2); }
html.dark .stats-roll-dot.is-on { background: rgba(255, 255, 255, 0.62); }
.stats-roll {
  /* ★1012w：固定宽度下，超长文案以省略号收尾（不再撑动整行） */
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
  font-size: 10px;
  font-weight: 400;
  line-height: 1.2;
  color: #9ca3af;
  white-space: nowrap;
  max-width: 150px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.roll-enter-active, .roll-leave-active { transition: opacity 0.28s ease, transform 0.28s ease; }
.roll-enter-from { opacity: 0; transform: translateY(7px); }
.roll-leave-to { opacity: 0; transform: translateY(-7px); }

/* 0911 体系化：子明细（MCP 逐 server / 系统·特殊工具逐工具）——缩进 + 圆点 + 长名省略 */
/* 0917b 反馈①：父行可悬停展开（默认只显示合计） */
.ctx-row-wrap { display: flex; flex-direction: column; }
.ctx-row-hassub { cursor: default; }
.ctx-row-hassub:hover dt { color: #374151; }
.ctx-caret {
  margin-left: 4px;
  font-size: 11px;
  line-height: 1;
  color: #cbd5e1;
  transform: translateY(-1px);
  transition: transform 0.15s ease, color 0.15s ease;
}
.ctx-row-hassub:hover .ctx-caret { color: #64748b; transform: translateX(1px) translateY(-1px); }
.ctx-subs-pop {
  /* ★ 0920：悬停父行时右侧弹出的明细气泡（fixed，left/top 由 showSubPop 算）。
     宽度/高度都设上限：明细十几条时自己内部滚动，不撑破屏幕。 */
  position: fixed;
  z-index: 10050;
  min-width: 176px;
  max-width: 260px;
  max-height: 320px;
  overflow-y: auto;
  background: #ffffff;
  border: 1px solid rgba(0, 0, 0, 0.08);
  border-radius: 10px;
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.14);
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  animation: ctxSubIn 0.14s ease-out;
}
@keyframes ctxSubIn {
  from { opacity: 0; transform: translateX(-4px); }
  to { opacity: 1; transform: none; }
}
html.dark .ctx-subs-pop {
  background: #1d1d1d;
  border-color: #2e2e2e;
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.5);
}
html.dark .ctx-subs-pop .ctx-row { color: #d4d4dc; }
html.dark .ctx-subs-pop .ctx-row-sub dt { color: #9a9aa6; }
html.dark .ctx-subs-pop .ctx-row dd { color: #8a8a96; }
.ctx-row-sub { padding-left: 14px; }
.ctx-row-sub dt { color: #9ca3af; }
.ctx-dot {
  display: inline-block;
  width: 4px;
  height: 4px;
  border-radius: 9999px;
  margin-right: 7px;
  flex: none;
  opacity: 0.6;
}
.ctx-sub-name {
  max-width: 132px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 明细变多后的防溢出：行区限高内滚 + 气泡略加宽 */
.ctx-rows { max-height: 320px; overflow-y: auto; }
.ctx-popover { min-width: 196px; }
</style>
