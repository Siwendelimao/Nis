<script setup lang="ts">
/**
 * ViewChatDock —— 共享的"视图内对话"悬浮球（0905）。
 *  挂在浏览器/办公室/画布/预览这类非纯对话视图右下角：折叠成小悬浮球，点开=精简对话小窗。
 *  实时读当前会话的 piChat 节点流；输入区复用主界面 ChatInput 编辑器（标签/图片粘贴完全同步）。
 *  0905 九批：发送后清空编辑器（老 bug 回归修复）；生成中发送按钮变"停止"（与主界面同步，
 *  走 session.cancel）；模型选择器紧凑版回归；审批/询问卡直接内嵌应答（不再跳回对话视图）；
 *  悬浮球角标四态：待确认琥珀 > 失败红 > 生成中转圈 > 未读绿。
 */
import { ref, computed, nextTick, watch, onMounted } from 'vue'
import { usePiChatStore } from '@/stores/piChat'
import { useChatStore } from '@/stores/chat'
import { useProvidersStore } from '@/stores/providers'

import { useConversationsStore } from '@/stores/conversations'
import { useBrowserStore } from '@/stores/browser'
import { useSettingsStore } from '@/stores/settings'
import { useQueueStore, type QueueItem } from '@/stores/queue'
import { useNotificationsStore } from '@/stores/notifications'
/* ★1011h：朗读（与主对话流同一 store；设置→语音 开了朗读才显示按钮） */
import { useVoiceStore } from '@/stores/voice'
import { MessageCircle, X, Paperclip, Copy, Check, CornerUpLeft, Pencil, Trash2, Square, Volume2 } from 'lucide-vue-next'
import { useFloatPos } from '@/composables/useFloatPos'
import { shortenElementTokens } from '@/utils/elementTag'
import { stripModeHint } from '@/utils/modeHint'
/* ★1011i：本轮计时（模块级单例、按会话键控）—— 与聊天界面共用**同一份**计数，切窗口/切会话都不归零 */
import { turnSecondsOf, turnTimerTick } from '@/utils/turnTimer'
import ChatInput from './ChatInput.vue'
import ApprovalPanel from './blocks/ApprovalPanel.vue'
import QuestionComposer from './blocks/QuestionComposer.vue'
import QueueBar from './blocks/QueueBar.vue'
/* ★1011d：消息渲染复用主对话流（PiChatView）那套现成组件 —— 反馈浮层"过于简陋，
   想要和正常对话流一样"。原来这里只有"灰底纯文本气泡 + Think 截断 160 字灰标签 + 工具名灰标签"，
   markdown 的 **粗体** / > 引用 / 代码块在浮层里全是原样字符。 */
import MarkdownText from './blocks/MarkdownText.vue'
import StreamingTail from './blocks/StreamingTail.vue'
import ReasoningBlock from './blocks/ReasoningBlock.vue'
import ToolPartBlock from './blocks/ToolPartBlock.vue'
import { t } from '@/utils/i18n'
import { localStore } from '@/utils/localStore'

const props = defineProps<{ conversationId: string | null }>()
const piChatStore = usePiChatStore()
const chatStore = useChatStore()
const providersStore = useProvidersStore()

const conversationsStore = useConversationsStore()
const browserStore = useBrowserStore()
const settingsStore = useSettingsStore()
const queueStore = useQueueStore()
const notificationsStore = useNotificationsStore()

const open = ref(false)
const sending = ref(false)
const listRef = ref<HTMLElement | null>(null)
const listAtBottom = ref(true)
function onListScroll() {
  const el = listRef.value
  if (!el) return
  listAtBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight <= 24
}
const chatInputRef = ref<InstanceType<typeof ChatInput> | null>(null)

/* 用户手动折叠后 AI 不再自动弹开（0905 十三批）；点球重新展开即恢复自动弹。
   必须声明在 dockOpenRequested watch 之前（immediate 回调可能访问，防 TDZ） */
const userCollapsed = ref(false)
function toggleDock() {
  open.value = !open.value
  if (!open.value) userCollapsed.value = true
  else userCollapsed.value = false
}

/* ── 0914：悬浮球自由定位（拖动 + 视口夹取 + 持久化 + 双击复位；与工具箱各拖各的） ── */
const float = useFloatPos({
  storageKey: 'nis.ui.chatBall.pos',
  size: { w: 48, h: 48 },
  // 默认位：贴右下（right:20 / bottom:20）
  defaultPos: (vw, vh) => ({ x: vw - 20 - 48, y: vh - 20 - 48 }),
  /* ★1011c：与工具箱球互相避让（历史保存位置可能让两球叠一起） */
  avoidKey: 'nis.ui.previewTools.pos',
})
const ballPos = float.pos
function onBallClick() {
  if (float.consumeDragClick()) return
  toggleDock()
}
/** 弹窗避让：按剩余空间选上/下展开，水平贴球并夹取；整体不越出视口（0914） */
const winStyle = computed(() => {
  const z = float.zoom.value
  const vwCss = float.viewport.value.w / z
  const vhCss = float.viewport.value.h / z
  const M = 8, GAP = 8, bw = 48, bh = 48
  const W = Math.min(360, vwCss - 2 * M)
  const desiredH = Math.min(520, vhCss * 0.75)
  const px = float.pos.value.x
  const py = float.pos.value.y
  const spaceAbove = py - GAP - M
  const spaceBelow = vhCss - (py + bh) - GAP - M
  let above = true
  let H = desiredH
  if (spaceAbove >= desiredH) { above = true; H = desiredH }
  else if (spaceBelow >= desiredH) { above = false; H = desiredH }
  else if (spaceAbove >= spaceBelow) { above = true; H = Math.max(160, spaceAbove) }
  else { above = false; H = Math.max(160, spaceBelow) }
  const top = above ? py - GAP - H : py + bh + GAP
  let left = px + bw - W
  left = Math.min(Math.max(M, left), Math.max(M, vwCss - W - M))
  const originX = px + bw / 2 - left
  const originY = above ? H : 0
  return {
    position: 'fixed' as const,
    left: left + 'px',
    top: top + 'px',
    width: W + 'px',
    height: H + 'px',
    transformOrigin: `${Math.round(originX)}px ${Math.round(originY)}px`,
  }
})

// 0905 十一批：AI 打开内容 → ChatInterface 置 browserStore.dockOpenRequested=true，
// 这里 immediate watch 消费（挂载晚于请求也能补开）；用户手动折叠期间不自动弹（0905 十三批）
watch(() => browserStore.dockOpenRequested, (v) => {
  if (v) {
    browserStore.dockOpenRequested = false
    if (!userCollapsed.value) open.value = true
  }
}, { immediate: true })

const nodes = computed(() => (props.conversationId ? piChatStore.getNodes(props.conversationId) : []))
const streaming = computed(() => nodes.value.some(n => (n.kind === 'assistant' || n.kind === 'tool') && n.status === 'streaming' && !(n as any).subAgent) || nodes.value.some(n => (n as any).subAgent && (n as any).subAgent.status === 'running'))

type Row = { key: string; role: 'user' | 'ai' | 'think' | 'tool' | 'member' | 'steer'; text: string; node: any; name?: string; status?: string; tail?: boolean; tailText?: string; tailItems?: any[]; turn?: number }
/** 工具参数（与 PiChatView 的 parseArgs 同口径） */
function parseArgs(args: any): Record<string, any> {
  if (args == null) return {}
  if (typeof args === 'object') return args
  try {
    const v = JSON.parse(String(args))
    return v && typeof v === 'object' ? v : {}
  } catch { return {} }
}
const rows = computed<Row[]>(() => {
  const out: Row[] = []
  /* ★1011h：轮号（与后端 session.deleteTurn 同口径：真实 user 消息 +1，"自动续跑"注入的不算）
     + 按轮收集 assistant 节点（"整组统计/朗读"要用 —— timing 挂在组内最后一条 assistant 上）。 */
  let curTurn = 0
  const asstByTurn = new Map<number, any[]>()
  for (const n of nodes.value as any[]) {
    if (n.kind === 'user' && !n.dm && !String(n.text || '').startsWith('【自动续跑')) curTurn += 1
    if (n.kind === 'assistant') {
      const arr = asstByTurn.get(curTurn) || []
      arr.push(n)
      asstByTurn.set(curTurn, arr)
    }
    const rowStart = out.length
    // ★0930：与 PiChatView.parseUserText 同口径——注入行（[记忆召回]/[模式:]）与 [技能:] 标签不进气泡
    if (n.kind === 'user') { const raw = stripModeHint(String(n.text || '')).replace(/(\[技能:[^\]]+\]\s*)+/g, ''); if (raw.trim()) out.push({ key: n.key, role: 'user', text: raw, node: n }) }
    else if (n.kind === 'notice' && n.noticePhase === 'steer') { out.push({ key: n.key, role: 'steer', text: '', node: n }) }
    /* ★1011d：工具/思考/正文都带上**节点引用**（原来只留压平的字符串，交给组件渲染时没有原始字段可用） */
    else if (n.kind === 'tool') { if (n.toolName) out.push({ key: n.key, role: 'tool', text: String(n.toolName), node: n, status: n.awaitingApproval ? 'pending' : n.toolStatus }) }
    else if (n.kind === 'assistant' && n.subAgent) {
      const sa = n.subAgent
      const txt = String(n.text || '').trim()
      if (txt || sa.status === 'running') out.push({ key: n.key, role: 'member', name: sa.memberName || t('chat.member'), text: txt || '…', node: n })
    } else if (n.kind === 'assistant') {
      const reason = String(n.reasoning || '').trim()
      const body = String(n.text || '').trim()
      /* 思考块占位条件抄主对话流：用"无实际正文"判空（provider 死区常先吐纯空白 delta） */
      if (reason || (n.status === 'streaming' && !body)) out.push({ key: n.key + '-t', role: 'think', text: reason, node: n })
      if (body) out.push({ key: n.key, role: 'ai', text: String(n.text || ''), node: n })
      /* ★1011g：不再在流式节点后插"…"占位 —— 那个转圈会飘到工具行中间/上面（实测反馈"缓冲动画位置不对"）。
         缓冲动画改为**钉在列表末尾**（见模板），视觉上就是"输入框上方、最新内容下方"。 */
    }
    /* ★1011h：本节点产生的行统一挂轮号（一处回填，省得每个分支各写一遍） */
    for (let k = rowStart; k < out.length; k++) out[k].turn = curTurn
  }
  /* ★1011g：复制按钮只出现在**一组 AI 回复的末尾**（实测反馈"复制按钮出现在不该出现的位置"）。
     主对话流就是"整组底部一个复制"；浮层按节点渲染，逐条冒复制钮会很乱。
     一组 = 连续的 非 user/steer 行；把组尾那条 ai row 标 tail，并带上整组正文供复制。 */
  const isBreak = (x: Row) => x.role === 'user' || x.role === 'steer'
  for (let i = 0; i < out.length; i++) {
    if (isBreak(out[i])) continue
    let j = i
    while (j + 1 < out.length && !isBreak(out[j + 1])) j++
    for (let k = j; k >= i; k--) {
      if (out[k].role === 'ai') {
        out[k].tail = true
        out[k].tailText = out.slice(i, j + 1)
          .filter(x => x.role === 'ai')
          .map(x => String(x.node?.text || ''))
          .join('\n\n')
          .trim()
        /* ★1011h：整组 assistant 节点（含无正文但带 timing 的那条）→ 统计/朗读都靠它 */
        out[k].tailItems = asstByTurn.get(out[k].turn || 0) || []
        break
      }
    }
    i = j
  }
  return out
})

/* ── ★1011h：补齐主对话流那套操作（朗读 / 删除这一轮 / 统计；编辑 = 回填输入框 + 删原轮） ── */
const voiceStore = useVoiceStore()
onMounted(() => { void voiceStore.ensureLoaded() })

/** 悬停统计的格式化（口径与 PiChatView 逐字一致） */
function formatFullTime(ts?: number): string {
  if (!ts) return ''
  const d = new Date(ts)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hh}:${mm}`
}
function formatDuration(ms?: number): string {
  if (ms == null) return ''
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}秒`
  return `${Math.floor(s / 60)}分${s % 60}秒`
}
function formatSec(ms?: number): string {
  if (ms == null) return ''
  return `${(ms / 1000).toFixed(1)}秒`
}
function tokPerSec(meta: any): number | null {
  if (!meta?.timing?.llmMs || !meta?.usage?.completionTokens) return null
  const sec = meta.timing.llmMs / 1000
  if (sec <= 0) return null
  return Math.round(meta.usage.completionTokens / sec)
}
/** 整组统计（日期时间 · 用时 · 首 token · tok/s · 缓存命中率）—— 口径同 PiChatView.aiGroupStats */
function groupStats(items: any[]): string {
  const asst = [...(items || [])].reverse().find(n => n.kind === 'assistant' && (n.turnTiming || n.turnUsage || n.text))
  const meta = { timing: asst?.turnTiming, usage: asst?.turnUsage }
  const parts: string[] = []
  const ft = formatFullTime(asst?.time)
  if (ft) parts.push(ft)
  const dur = formatDuration(meta?.timing?.llmMs)
  if (dur) parts.push(`用时 ${dur}`)
  const ttft = formatSec(meta?.timing?.ttftMs)
  if (ttft) parts.push(`首 token ${ttft}`)
  const tps = tokPerSec(meta)
  if (tps != null) parts.push(`${tps} tok/s`)
  const u = meta?.usage
  if (u) {
    const billed = (u.promptTokens || 0) + (u.cacheReadTokens || 0) + (u.cacheWriteTokens || 0)
    if (billed > 0 && ((u.cacheReadTokens || 0) > 0 || (u.cacheWriteTokens || 0) > 0)) {
      parts.push(`缓存 ${Math.round((u.cacheReadTokens || 0) / billed * 100)}%`)
    }
  }
  if (!meta?.timing?.llmMs && meta?.usage?.completionTokens) parts.push(`输出 ${meta.usage.completionTokens} tok`)
  return parts.join(' · ')
}

/* ★1011i：本轮计时胶囊（需求的：把列表末尾的转圈换成聊天界面输入框下方那个「📈 本轮 N 秒」）。
   计时本身就是主对话流那份（utils/turnTimer 模块级单例、per-conv 键控）—— 起停由 ChatInterface 的
   session/status 帧统一管，浮层只读；切窗口/切会话不归零、不串台。 */
const liveTurnSeconds = computed<number | null>(() => {
  void turnTimerTick.value                    // 响应式：每秒 tick 一次重算
  const cid = String(props.conversationId || '')
  return cid ? turnSecondsOf(cid) : null
})
/** 计时文案（秒→分→时→天进位；口径与 StatsLine.formatTurn 逐字一致） */
function formatTurn(sec: number): string {
  if (sec < 60) return t('stats.secN', { n: sec })
  if (sec < 3600) return t('stats.minSec', { m: Math.floor(sec / 60), s: sec % 60 })
  if (sec < 86400) return t('stats.hourMin', { h: Math.floor(sec / 3600), m: Math.floor((sec % 3600) / 60) })
  return t('stats.dayHour', { d: Math.floor(sec / 86400), h: Math.floor((sec % 86400) / 3600) })
}

/** 朗读：key 带上会话（同主对话流口径）；再点同一 key = 停止（voiceStore 内部处理） */
function speakKeyOf(key: string): string { return `${props.conversationId || ''}:${key}` }
function toggleSpeak(r: Row) {
  const text = String(r.tailText || r.text || '')
  if (!text) return
  void voiceStore.speakText(speakKeyOf(r.key), text)
}

/* 删除这一轮（与主对话流同一 RPC session.deleteTurn + 后端权威重放；弹卡确认、可只删回复或连提问一起删） */
const delTurnTarget = ref<{ turnIndex: number } | null>(null)
const delTurnIncludeUser = ref(true)
const delTurnBusy = ref(false)
const delTurnErr = ref('')
function openDeleteTurn(turnIndex: number) {
  if (!turnIndex || turnIndex < 1) return
  delTurnErr.value = ''
  delTurnIncludeUser.value = true
  delTurnTarget.value = { turnIndex }
}
async function confirmDeleteTurn() {
  const target = delTurnTarget.value
  if (!target || delTurnBusy.value) return
  delTurnBusy.value = true
  delTurnErr.value = ''
  /* ★ 竞态（照抄主对话流 0929 修法）：await 期间用户可能切走，收尾必须锁发起时的会话 id */
  const cid = String(props.conversationId || '')
  try {
    const r: any = await chatStore.bridgeRpc('session.deleteTurn', { sessionId: cid, turnIndex: target.turnIndex, includeUser: delTurnIncludeUser.value })
    if (r?.ok === false) throw new Error(String(r.error || '删除失败'))
    delTurnTarget.value = null
    const result: any = await chatStore.bridgeRpc('session.history', { sessionId: cid })
    if (result?.messages) {
      piChatStore.loadHistory(cid, result.messages,
        Array.isArray(result.compactions) ? result.compactions : undefined,
        Array.isArray(result.runningTools) ? result.runningTools : undefined)
    }
  } catch (e: any) {
    delTurnErr.value = String(e?.message || e || '删除失败')
    if (delTurnErr.value.includes('正在回复')) setTimeout(() => { delTurnTarget.value = null }, 2200)
  } finally { delTurnBusy.value = false }
}
/** 「编辑」= 主对话流的"删原轮重发"语义：先把文本回填输入框，再弹"删除这一轮"确认卡；
 *  （真正的**就地**富文本编辑要 contenteditable + 图片胶囊重建 200+ 行，浮层不做 —— 取舍见项目档案） */
function editUserMsg(r: Row) {
  returnToInput(r)
  if ((r.turn || 0) >= 1) openDeleteTurn(r.turn || 0)
}

/* ★1011f：消息操作行（主对话流同款：复制 / 回填输入框 / 时间）—— 反馈浮层缺这两排按钮 */
const copiedKey = ref('')
function copyMsg(text: string, key: string) {
  const s = String(text || '')
  if (!s) return
  try { void navigator.clipboard.writeText(s) } catch { /* 剪贴板不可用：静默 */ }
  copiedKey.value = key
  setTimeout(() => { if (copiedKey.value === key) copiedKey.value = '' }, 1500)
}
/** HTML 转义（回填进 contenteditable 前必须做，否则消息里的 < > 会被当标签解析） */
function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
/** 返回输入框：把这条用户消息的**文本**回填到浮层输入框（与主对话流同一编辑器接口 setEditorState），
 *  用户可改完再发。图片不搬（浮层的图片标签项没有主视图那套构造逻辑），标题里已注明。 */
function returnToInput(r: Row) {
  const el = chatInputRef.value as any
  if (!el?.setEditorState) return
  const txt = shortenElementTokens(String(r.text || '')).replace(/\r/g, '')
  el.setEditorState({ html: escHtml(txt).replace(/\n/g, '<br>'), items: [] })
  try { el.focusEditor?.() } catch { /* ignore */ }
}
/** 时间（浮层只用时分；今天以外的给 月/日 时分） */
function fmtDockTime(ts?: number): string {
  if (!ts) return ''
  const d = new Date(ts)
  const now = new Date()
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return d.toDateString() === now.toDateString() ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`
}

async function scrollBottom() { await nextTick(); const el = listRef.value; if (el) el.scrollTop = el.scrollHeight }
watch(() => [rows.value.length, open.value], () => { if (open.value && listAtBottom.value) scrollBottom() })

/* 悬浮球角标：未读（收起时有新内容；展开即已读）。必须在 rows 声明之后注册（TDZ 教训） */
const unread = ref(false)
watch(() => rows.value.length, () => { if (!open.value) unread.value = true })
watch(open, (v) => { if (v) unread.value = false })

/* 最近一轮是否失败（角标红点）：从尾部往前找，遇到用户消息即止 */
const lastFailed = computed(() => {
  const list = nodes.value as any[]
  for (let i = list.length - 1; i >= 0 && i >= list.length - 5; i--) {
    const n = list[i]
    if (n.kind === 'user') break
    if ((n.kind === 'assistant' || n.kind === 'tool') && n.status === 'error') return true
  }
  return false
})

/* 审批/询问卡（与主界面 pendingCard 同源逻辑）：直接在悬浮窗内嵌应答 */
const pendingCard = computed(() => {
  if (!props.conversationId) return null
  void piChatStore.asideVersion
  const list = nodes.value as any[]
  for (let i = list.length - 1; i >= 0; i--) {
    for (const a of (list[i].asides || [])) {
      if (a.type === 'permission_prompt' && !a.answered) return { kind: 'permission' as const, block: a }
    }
  }
  for (const n of list) {
    for (const a of (n.asides || [])) {
      if (a.type === 'ask_user' && !a.answered) return { kind: 'question' as const, block: a }
    }
  }
  return null
})

/* 生成中状态机（0905 十三批修正）：
   - 权威源 replying（后端 session/status）与流式 streaming 任一为真 = 生成中
   - 本地 generating：发消息即置位；尾部节点是 tool=工具间隙继续跑；尾部是 assistant/user=完成复位
   （十一批版本 break 后误落 return true 导致"回复完了按钮仍是停止"，已修） */
const generating = ref(false)
const aiBusy = computed(() => {
  const replying = props.conversationId ? !!conversationsStore.getById(String(props.conversationId))?.replying : false
  if (replying || streaming.value) return true
  if (!generating.value) return false
  const list = nodes.value as any[]
  for (let i = list.length - 1; i >= 0; i--) {
    const n = list[i]
    if (n.kind === 'tool') return true
    if (n.kind === 'assistant' || n.kind === 'user') return false
  }
  return true
})
// 流式节点一出现（无论来自哪个窗口/刷新后恢复）即进入生成态
watch(streaming, (v) => { if (v) generating.value = true })
watch(aiBusy, (v) => { if (!v) generating.value = false })

/* 上下文占用圆环（0905 十批）：打开悬浮窗时拉一次 + 每轮回复后刷新 */
const ctxPercent = ref(0)
const ctxDetail = ref<{ used?: number; max?: number }>({})
let ctxLastAt = 0
async function refreshCtx(force = false) {
  if (!props.conversationId) return
  if (!force && Date.now() - ctxLastAt < 5000) return
  ctxLastAt = Date.now()
  try {
    const r = await chatStore.bridgeRpc('session.context', { sessionId: String(props.conversationId) })
    if (r?.percent != null) ctxPercent.value = Math.round(r.percent)
    ctxDetail.value = { used: r?.usedTokens, max: r?.maxTokens }
  } catch { /* ignore */ }
}
watch(open, (v) => { if (v) void refreshCtx(true) })
watch(() => rows.value.length, () => { void refreshCtx() })
// 0908六：思考强度按会话隔离（dock 无强度 UI，此值只用于发送口径——读会话 effort（后端持久化，
// 主界面/会话列表回填），无则跟随全局默认。此前读 localStorage 全局值=dock 发送不跟会话走）
const reasoningMode = computed<string>(() => {
  const id = props.conversationId
  if (id) {
    const e = conversationsStore.getById(String(id))?.effort
    if (e) return e
  }
  return localStore.getItem('nis-reasoning-mode') || 'deep'
})

/* 卡片应答（与主界面 handleHitlResponse/handleQuestionSubmit 同通道） */
function onHitlRespond(payload: { request_id: string; choice: string }) {
  const convId = props.conversationId
  if (!convId) return
  /* ★0927：打上"本人答的"全局标记 —— 否则随后到达的结算帧（interaction-done）
     会把卡片覆盖成「已在其他窗口应答」（点卡的组件与处理帧的组件可能不是同一个实例）。 */
  piChatStore.markAnsweredByUser(String(payload.request_id))
  chatStore.sendHitlResponse(payload.request_id, payload.choice, String(convId))
  piChatStore.answerAside(String(convId), payload.request_id, payload.choice)
  conversationsStore.setPendingInteraction(String(convId), null)
}
function onQuestionSubmit(payload: { request_id: string; value: string }) {
  const convId = props.conversationId
  if (!convId) return
  piChatStore.markAnsweredByUser(String(payload.request_id))
  chatStore.sendQuestionAnswer(payload.request_id, payload.value, String(convId))
  piChatStore.answerAside(String(convId), payload.request_id, payload.value)
  conversationsStore.setPendingInteraction(String(convId), null)
}
function onQuestionIgnore(payload: { request_id: string }) {
  const convId = props.conversationId
  if (!convId) return
  piChatStore.markAnsweredByUser(String(payload.request_id))
  chatStore.sendQuestionAnswer(payload.request_id, '__ignored__', String(convId))
  piChatStore.answerAside(String(convId), payload.request_id, '__ignored__')
  conversationsStore.setPendingInteraction(String(convId), null)
}

/* 图片附件（按钮选择；粘贴图片由 ChatInput 编辑器原生处理成图片标签） */
interface DockAttachment { key: string; name: string; dataUrl: string }
const attachments = ref<DockAttachment[]>([])
const fileInputRef = ref<HTMLInputElement | null>(null)
function pickFiles() { fileInputRef.value?.click() }
function fileToDataUrl(f: File): Promise<string> {
  return new Promise(resolve => { const r = new FileReader(); r.onload = () => resolve(r.result as string); r.readAsDataURL(f) })
}
async function onFilesChosen(e: Event) {
  const input = e.target as HTMLInputElement
  for (const f of Array.from(input.files || [])) {
    if (!f.type.startsWith('image/')) continue
    attachments.value.push({ key: crypto.randomUUID(), name: f.name || t('chat.imageName'), dataUrl: await fileToDataUrl(f) })
  }
  input.value = ''
}
function removeAttachment(key: string) { attachments.value = attachments.value.filter(a => a.key !== key) }

async function send(channel?: 'ctrl') {
  if (!props.conversationId || sending.value) return
  // 与主聊天页同源：技能标签剥离 + 正文清洗 + 编辑器内嵌图片提取
  const skillTags = chatInputRef.value?.getSkillTags() || []
  const message = chatInputRef.value?.getPlainTextExcludingSkills() || chatInputRef.value?.getPlainText() || ''
  const cleanMessage = message.replace(/\[\[图片:\d+\]\]/g, '').replace(/\n{3,}/g, '\n\n').trim()
  const editorImages = chatInputRef.value?.getImageAttachments ? await chatInputRef.value.getImageAttachments() : []
  const imgAttachments = [...editorImages, ...attachments.value.map(a => ({ name: a.name, dataUrl: a.dataUrl }))]
  if (!cleanMessage && imgAttachments.length === 0) return
  // 0909⑦改：dock 也接队列/插话（与主界面同通道同设置）——AI 忙时 Enter=默认通道、Ctrl+Enter=反向通道。
  // 审批/询问卡挂起时同样走此分流（dock 输入区常驻，直发 session.prompt 会撞"already processing"丢消息；
  // 队列账本自带审批期冻结闸门，steer 注入点=当前轮工具批次跑完，两条通道都安全）。
  if (aiBusy.value) {
    const defaultMode = settingsStore.general.busySendMode || 'queue'
    const wantSteer = channel === 'ctrl' ? defaultMode !== 'steer' : defaultMode === 'steer'
    await busySend(cleanMessage, skillTags, imgAttachments, wantSteer)
    return
  }
  attachments.value = []
  sending.value = true
  generating.value = true   // 进入生成态（aiBusy 状态机维持停止按钮直到回复完成）
  try {
    piChatStore.finalizeStreaming(props.conversationId)
    piChatStore.getNodes(props.conversationId).push({
      key: crypto.randomUUID(), kind: 'user', text: cleanMessage || '[图片]', reasoning: '', status: 'done', time: Date.now(),
      skills: skillTags.length ? skillTags : undefined,
      images: imgAttachments.length ? imgAttachments.map(a => a.dataUrl) : undefined,
    } as any)
    piChatStore.beginAssistant(props.conversationId)
    chatInputRef.value?.clearEditor()   // 0905 九批：发送后清空编辑器（老 bug 回归修复）
    // 0908 二批条1：发送口径与主界面同源（store 共用，含选择器显示值兜底+供应商 ensure）
    const sendModel = await providersStore.modelForSend(String(props.conversationId))
    chatStore.sendMessage(
      props.conversationId,
      cleanMessage || '[图片]',
      reasoningMode.value,
      skillTags.length > 0 ? skillTags : undefined,
      imgAttachments.length ? imgAttachments : undefined,
      sendModel,
    )
    if (open.value) scrollBottom()
  } catch { /* ignore */ } finally { sending.value = false }
}

/* 0909⑦改：dock 忙时发送（steer/queue）——与主界面 busySend 同 RPC 同语义。
 * steer=pi 原生插话（当前轮工具跑完即注入）；queue=后端账本排队（整轮结束自动逐条发出）。 */
async function busySend(text: string, skillTags: string[], imgAttachments: Array<{ name: string; dataUrl: string }>, wantSteer: boolean) {
  const convId = String(props.conversationId)
  const sendText = text || '[图片]'
  const sendModel = await providersStore.modelForSend(convId)
  const clientMessageId = crypto.randomUUID()
  const clearInput = () => {
    chatInputRef.value?.clearEditor()
    if (imgAttachments.length) attachments.value = []
  }
  if (wantSteer) {
    try {
      const r = await chatStore.bridgeRpc('session.steer', {
        sessionId: convId, message: sendText, kind: 'steer', clientMessageId,
        attachments: imgAttachments.length ? imgAttachments : undefined,
        skills: skillTags.length ? skillTags : undefined,
        model: sendModel || undefined, effort: reasoningMode.value,
      }) as any
      if (r?.steered) {
        clearInput()
        /* ★ 0925（同 ChatInterface.busySend）：乐观气泡直 push 不占位 → 图片标签不渲染。
           按 stores/piChat.ts 恢复逻辑同口径，把 [[图片:N]] 拼到 text 末尾。 */
        const optImgs = imgAttachments.length ? imgAttachments.map(a => a.dataUrl) : undefined
        /* 0925b：纯图无文字时 sendText 是兜底字面量 '[图片]' —— 拼进去气泡会多一截难看的
           '[图片]' 文本，只留占位（回显回收有"仅一条待回收乐观气泡"兜底认领，匹配不受影响） */
        const optText = optImgs?.length
          ? [sendText === '[图片]' ? '' : sendText, ...optImgs.map((_, i) => `[[图片:${i}]]`)].filter(Boolean).join(' ')
          : sendText
        // 乐观气泡：pi 注入时发 message_start(user) 回显（piChat 按 steerOptimistic+文本匹配回收，0909⑨），带 steerPending=气泡发光描边
        piChatStore.getNodes(convId).push({ key: clientMessageId, kind: 'user', text: optText, reasoning: '', status: 'done', time: Date.now(), skills: skillTags.length ? skillTags : undefined, images: optImgs, steerPending: true, steerOptimistic: true } as any)
        if (open.value) scrollBottom()
        return
      }
      // agent 恰好空闲（竞态）→ 降级入队（消息不丢）
    } catch (e: any) {
      notificationsStore.push({ level: 'error', title: t('queue.steerFail'), content: String(e?.message || e), type: 'system' })
      return
    }
  }
  try {
    const r = await chatStore.bridgeRpc('session.queue.add', {
      sessionId: convId, message: sendText, clientMessageId,
      attachments: imgAttachments.length ? imgAttachments : undefined,
      skills: skillTags.length ? skillTags : undefined,
      model: sendModel || undefined, effort: reasoningMode.value,
    }) as any
    if (r?.queue) {
      /* ★0927（对齐 ChatInterface.busySend）：给本次发送落下的队列项补 markerText（带 [[图片:N]]
         位置标记的原文）—— 否则从 dock 点"撤回编辑"时图片标签插不回原文位置（主界面 0925 已做，dock 漏了）。
         匹配口径：未标记者里从后往前找 text 相同且 attachments 数相同的（刚 add 的就是它）。 */
      const list: any[] = Array.isArray(r.queue) ? r.queue : []
      const marker = imgAttachments.length
        ? [sendText === '[图片]' ? '' : sendText, ...imgAttachments.map((_, i) => `[[图片:${i}]]`)].filter(Boolean).join(' ')
        : sendText
      for (let i = list.length - 1; i >= 0; i--) {
        const q = list[i]
        if (q && !q.markerText && q.text === sendText && (q.attachments?.length || 0) === imgAttachments.length) {
          q.markerText = marker
          break
        }
      }
      queueStore.set(convId, list)
    }
    clearInput()
    if (open.value) scrollBottom()
  } catch (e: any) {
    notificationsStore.push({ level: 'error', title: t('queue.addFail'), content: String(e?.message || e), type: 'system' })
  }
}

/* 队列条操作（与主界面同 RPC）：编辑=删条目+文本回灌编辑器；删除/拖序=乐观+RPC */
async function queueEditItem(item: QueueItem) {
  const convId = props.conversationId
  if (!convId) return
  try {
    const r = await chatStore.bridgeRpc('session.queue.remove', { sessionId: String(convId), id: item.id }) as any
    if (r?.queue) queueStore.set(convId, r.queue)
    chatInputRef.value?.clearEditor()
    chatInputRef.value?.insertText(item.text)
    if (item.attachments?.length) {
      attachments.value = item.attachments.map(a => ({ key: crypto.randomUUID(), name: a.name, dataUrl: a.dataUrl }))
    }
    if (item.skills?.length) for (const s of item.skills) chatInputRef.value?.insertSkillTag(s)
  } catch (e: any) {
    notificationsStore.push({ level: 'error', title: t('queue.editFail'), content: String(e?.message || e), type: 'system' })
  }
}
async function queueRemoveItem(id: string) {
  const convId = props.conversationId
  if (!convId) return
  queueStore.optimisticRemove(convId, id)
  try {
    const r = await chatStore.bridgeRpc('session.queue.remove', { sessionId: String(convId), id }) as any
    if (r?.queue) queueStore.set(convId, r.queue)
  } catch (e: any) {
    notificationsStore.push({ level: 'error', title: t('queue.removeFail'), content: String(e?.message || e), type: 'system' })
  }
}
async function queueMoveItem(id: string, to: number) {
  const convId = props.conversationId
  if (!convId) return
  try {
    const r = await chatStore.bridgeRpc('session.queue.move', { sessionId: String(convId), id, to }) as any
    if (r?.queue) queueStore.set(convId, r.queue)
  } catch (e: any) {
    notificationsStore.push({ level: 'error', title: t('queue.moveFail'), content: String(e?.message || e), type: 'system' })
  }
}
/* ★0927 N1（乙）：暂停态的两条出路。dock 版回灌方式与它自己的 queueEditItem 同源（附件走 attachments 数组）。 */
async function queueResume() {
  const convId = props.conversationId
  if (!convId) return
  try {
    const r = await chatStore.bridgeRpc('session.queue.resume', { sessionId: String(convId) }) as any
    if (r?.queue) queueStore.set(convId, r.queue)
    queueStore.setPaused(convId, false)
  } catch (e: any) {
    notificationsStore.push({ level: 'error', title: t('queue.resumeFail'), content: String(e?.message || e), type: 'system' })
  }
}
async function queuePurgeAll() {
  const convId = props.conversationId
  if (!convId) return
  try {
    const r = await chatStore.bridgeRpc('session.queue.purge', { sessionId: String(convId) }) as any
    const items = Array.isArray(r?.items) ? r.items as QueueItem[] : []
    queueStore.set(convId, [])
    queueStore.setPaused(convId, false)
    if (!items.length) return
    chatInputRef.value?.clearEditor()
    attachments.value = []
    for (let i = 0; i < items.length; i++) {
      const it = items[i]
      if (it?.text) chatInputRef.value?.insertText((i ? '\n\n' : '') + it.text)
      if (Array.isArray(it?.attachments)) for (const a of it.attachments) { if (a?.dataUrl) attachments.value.push({ key: crypto.randomUUID(), name: a.name, dataUrl: a.dataUrl }) }
      if (it?.skills?.length) for (const s of it.skills) chatInputRef.value?.insertSkillTag(s)
    }
  } catch (e: any) {
    notificationsStore.push({ level: 'error', title: t('queue.purgeFail'), content: String(e?.message || e), type: 'system' })
  }
}

/* 按钮态与主界面同源（0909⑦改）：忙时且无草稿=停止；忙时有草稿=发送(排队/插话)；空闲=发送。
   ChatInput @draft 实时上报草稿有无（MutationObserver）。 */
const draftHasText = ref(false)
const showStopBtn = computed(() => aiBusy.value && !draftHasText.value)
function onSendButtonClick() {
  if (showStopBtn.value && props.conversationId) {
    piChatStore.finalizeStreaming(props.conversationId)
    chatStore.bridgeRpc('session.cancel', { sessionId: String(props.conversationId) }).catch(() => {})
    generating.value = false
    return
  }
  send()
}

/* 上下文圆环悬停明细 + 阈值变色（>70 琥珀 >90 红） */
const ctxColor = computed(() => ctxPercent.value > 90 ? '#ef4444' : ctxPercent.value > 70 ? '#f59e0b' : 'currentColor')
const ctxTitle = computed(() => {
  const u = ctxDetail.value
  return u?.used && u?.max ? t('chat.ctxUsedFull', { p: ctxPercent.value, used: Math.round(u.used / 1000), max: Math.round(u.max / 1000) }) : t('chat.ctxUsedSimple', { p: ctxPercent.value })
})
</script>

<template>
  <div class="fixed z-[60]" :style="{ left: ballPos.x + 'px', top: ballPos.y + 'px' }">
    <!-- 展开窗：缩放+上浮淡入；位置/方向由 winStyle 计算（贴球上/下避让 + 视口夹取；0914） -->
    <Transition
      enter-active-class="dock-pop-enter-active"
      enter-from-class="dock-pop-enter-from"
      leave-active-class="dock-pop-leave-active"
      leave-to-class="dock-pop-leave-to"
    >
      <div v-if="open" class="dock-window bg-white rounded-2xl shadow-[0_16px_50px_-12px_rgba(0,0,0,0.3)] border border-gray-200 flex flex-col overflow-hidden" :style="winStyle">
        <div class="flex items-center gap-2 px-3.5 py-2.5 border-b border-gray-100 shrink-0">
          <MessageCircle :size="14" stroke-width="1.75" class="text-gray-500" />
          <span class="text-[13px] font-[640] text-gray-800 flex-1">{{ t('tabs.chat') }}</span>
          <!-- ★1011g：标题栏的「⟳ 生成中」已去掉（需求的）——生成中由列表末尾那个缓冲动画表达，
               两处同时转圈反而吵 -->
          <button class="w-6 h-6 flex items-center justify-center rounded-md text-gray-400 hover:text-gray-700 hover:bg-gray-100" @click="toggleDock"><X :size="14" stroke-width="2" /></button>
        </div>

        <div ref="listRef" class="relative flex-1 min-h-0 overflow-y-auto overflow-x-hidden custom-scroll px-3 py-2.5 space-y-1.5" @scroll="onListScroll">
        <!-- 回到最新（0906 补 dock）：上翻后出现 -->
        <button v-if="!listAtBottom" class="dock-jump-bottom" :title="t('chat.backToLatest')" @click="listRef?.scrollTo({ top: listRef.scrollHeight, behavior: 'smooth' })"><i class="fas fa-arrow-down"></i></button>
          <div v-if="!rows.length" class="h-full flex items-center justify-center text-[12px] text-gray-300">{{ t('chat.dockEmpty') }}</div>
          <template v-for="r in rows" :key="r.key">
            <div v-if="r.role === 'user'" class="flex flex-col items-end">
              <!-- ★1011e：用户气泡对齐主对话流（蓝紫渐变 + 同一圆角变量 + 440 字重）；
                   原来是浮层自己的"深色窄气泡"。字号比主视图略缩（浮层只有 360px 宽）。 -->
              <div class="dsh-user-bubble max-w-[85%] text-[13px]" :class="{ 'steer-glow': (nodes as any[]).find(n => n.key === r.key)?.steerPending }">
                <div v-for="(img, i) in (nodes as any[]).find(n => n.key === r.key)?.images || []" :key="i" class="mb-1">
                  <img :src="img" class="max-w-[180px] max-h-[120px] rounded-lg object-cover" />
                </div>
                {{ shortenElementTokens(r.text) }}
              </div>
              <!-- ★1011f/g/h：气泡下方操作行（对照主对话流：编辑 / 返回输入框 / 复制 / 时间） -->
              <div class="dock-actions mt-1">
                <button class="dock-action" :title="t('chat.editMsg')" @click="editUserMsg(r)">
                  <Pencil :size="13" />
                </button>
                <button class="dock-action" :title="t('chat.returnToInput')" @click="returnToInput(r)">
                  <CornerUpLeft :size="13" />
                </button>
                <button class="dock-action" :title="copiedKey === 'u' + r.key ? t('chat.copied') : t('chat.copy')" @click="copyMsg(shortenElementTokens(r.text), 'u' + r.key)">
                  <Copy v-if="copiedKey !== 'u' + r.key" :size="13" />
                  <Check v-else :size="13" class="text-green-500" />
                </button>
                <span class="text-[10px] text-gray-400 ml-0.5">{{ fmtDockTime(r.node?.time) }}</span>
              </div>
            </div>
            <div v-else-if="r.role === 'steer'" class="flex justify-center py-0.5">
              <span class="dock-steer-pill"><i class="fas fa-arrow-right text-[9px]"></i>{{ t('divider.steered') }}</span>
            </div>
            <div v-else-if="r.role === 'think'" class="flex justify-start dock-zoom">
              <!-- ★1011d：思考块与主对话流同款（可点开看全文）——原来是"截 160 字的 Think 灰标签" -->
              <ReasoningBlock
                class="max-w-full"
                :content="String(r.node.reasoning || '')"
                :streaming="r.node.status === 'streaming' && !r.node.reasoningDone"
              />
            </div>
            <div v-else-if="r.role === 'tool'" class="flex justify-start min-w-0 dock-zoom">
              <!-- ★1011d：工具行与主对话流同款（图标/拟人文案/IN-OUT 折叠/耗时/失败态）——原来是"扳手 + 工具名"灰标签 -->
              <ToolPartBlock
                :stream-chars="r.node.toolStreamChars || 0"
                :part="{
                  tool: r.node.toolName,
                  input: parseArgs(r.node.toolArgs),
                  status: r.node.awaitingApproval ? 'pending' : r.node.toolStatus === 'running' ? 'running' : r.node.toolError ? 'error' : 'completed',
                  output: r.node.toolResult,
                  error: r.node.toolError ? r.node.toolResult : '',
                  call_id: r.node.callId,
                  memberNames: [],
                  shell: r.node.toolShell,
                  diffStat: r.node.diffStat,
                  fileSize: r.node.fileSize,
                }"
                :desc="r.node.toolName || ''"
              />
            </div>
            <div v-else-if="r.role === 'member'" class="flex justify-start">
              <div class="max-w-[88%] px-3 py-1.5 rounded-2xl rounded-bl-md bg-indigo-50 border border-indigo-100 text-gray-800 text-[12px] leading-snug whitespace-pre-wrap break-words">
                <div class="text-[10px] font-[640] text-indigo-500 mb-0.5"><i class="fas fa-user-gear mr-1"></i>{{ r.name }}</div>{{ r.text }}
              </div>
            </div>
            <div v-else-if="r.role === 'ai'" class="msg-body">
              <!-- ★1011d：正文与主对话流同款（定稿 = MarkdownText 走完整 markdown；流式中 = StreamingTail） -->
              <MarkdownText v-if="r.node.status === 'done' && r.node.text" :text="r.node.text" />
              <StreamingTail v-else-if="r.node.text" :text="String(r.node.text).replace(/\s+$/, '')" />
              <!-- ★1011g：这里的"转圈占位"已移除 —— 缓冲动画统一钉在列表末尾（见下方），不再跟着节点飘 -->
              <!-- ★1011g：只在**整组回复的末尾**出现操作行（复制整组正文），而不是每段正文下都冒一个 -->
              <!-- ★1011h：对照主对话流补齐 —— 复制 / 朗读 / 删除这一轮 / 统计 -->
              <div v-if="r.tail && r.tailText" class="dock-actions mt-0.5 flex-wrap">
                <button class="dock-action" :title="copiedKey === 'a' + r.key ? t('chat.copied') : t('chat.copy')" @click="copyMsg(r.tailText || '', 'a' + r.key)">
                  <Copy v-if="copiedKey !== 'a' + r.key" :size="13" />
                  <Check v-else :size="13" class="text-green-500" />
                </button>
                <button
                  v-if="voiceStore.ttsReady"
                  class="dock-action"
                  :class="{ 'is-speaking': voiceStore.speakingKey === speakKeyOf(r.key) }"
                  :title="voiceStore.speakingKey === speakKeyOf(r.key) ? t('chat.readAloudStop') : t('chat.readAloud')"
                  @click="toggleSpeak(r)"
                >
                  <Square v-if="voiceStore.speakingKey === speakKeyOf(r.key)" :size="12" class="text-indigo-500" />
                  <Volume2 v-else :size="13" />
                </button>
                <button
                  v-if="(r.turn || 0) >= 1"
                  class="dock-action"
                  :title="t('chat.deleteTurn')"
                  @click="openDeleteTurn(r.turn || 0)"
                >
                  <Trash2 :size="13" />
                </button>
                <span v-if="groupStats(r.tailItems || [])" class="ml-1 text-[10px] text-gray-400 cursor-default">{{ groupStats(r.tailItems || []) }}</span>
              </div>
            </div>
            <div v-else class="flex justify-start">
              <div class="max-w-[88%] px-3 py-1.5 rounded-2xl rounded-bl-md bg-gray-100 text-gray-800 text-[12px] leading-snug whitespace-pre-wrap break-words">{{ r.text }}</div>
            </div>
          </template>
          <!-- ★1011i：缓冲动画换成「本轮 N 秒」计时胶囊（需求的，与聊天界面输入框下方那个同款）。
               计时与主对话流共用同一份（turnTimer 单例、per-conv），起停由 session/status 帧管，这里只读。
               极端情况（状态帧还没到、计时未起表）退回转圈，避免"生成中却什么都不显示"。 -->
          <div v-if="liveTurnSeconds != null" class="dock-turn-pill" :title="t('stats.thisTurn')">
            <span class="turn-wave" aria-hidden>
              <svg viewBox="0 0 64 48" width="18" height="13" preserveAspectRatio="xMidYMid meet">
                <polyline class="tw-back" points="0.157 23.954, 14 23.954, 21.843 48, 43 0, 50 24, 64 24" />
                <polyline class="tw-front" points="0.157 23.954, 14 23.954, 21.843 48, 43 0, 50 24, 64 24" />
              </svg>
            </span>
            <span class="dock-turn-text">{{ t('stats.thisTurn') }} {{ formatTurn(liveTurnSeconds) }}</span>
          </div>
          <div v-else-if="aiBusy" class="flex items-center px-0.5 py-1 text-gray-300">
            <i class="fas fa-circle-notch fa-spin text-[12px]"></i>
          </div>
        </div>

        <div class="shrink-0 border-t border-gray-100 p-2">
          <!-- 审批/询问卡内嵌应答（0905 九批：与主界面同一组件、同一应答通道） -->
          <div v-if="pendingCard" class="mb-1.5 max-h-[220px] overflow-y-auto custom-scroll rounded-xl border border-amber-200 bg-amber-50/60 p-1.5">
            <ApprovalPanel
              v-if="pendingCard.kind === 'permission'"
              :key="pendingCard.block.request_id"
              class="dock-card-compact"
              :request_id="pendingCard.block.request_id"
              :question="pendingCard.block.question"
              :options="pendingCard.block.options"
              :tool="pendingCard.block.tool"
              :risk="pendingCard.block.risk"
              :answered="pendingCard.block.answered"
              :answered-value="pendingCard.block.answeredValue"
              @respond="onHitlRespond"
            />
            <QuestionComposer
              v-else
              :key="pendingCard.block.request_id"
              class="dock-card-compact"
              :request_id="pendingCard.block.request_id"
              :question="pendingCard.block.question"
              :options="pendingCard.block.options"
              :placeholder="pendingCard.block.placeholder"
              :multiple="pendingCard.block.multiple"
              :answered="pendingCard.block.answered"
              :answered-value="pendingCard.block.answeredValue"
              @submit="onQuestionSubmit"
              @ignore="onQuestionIgnore"
            />
          </div>
          <!-- 附件缩略 chips（按钮选择的图片；粘贴图片在编辑器里以图片标签呈现） -->
          <div v-if="attachments.length" class="flex flex-wrap gap-1.5 px-0.5 pb-1.5">
            <div v-for="a in attachments" :key="a.key" class="relative group">
              <img :src="a.dataUrl" class="w-11 h-11 rounded-lg object-cover border border-gray-200" :title="a.name" />
              <button class="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-gray-900 text-white text-[8px] flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity" @click="removeAttachment(a.key)">✕</button>
            </div>
          </div>
          <!-- 0909⑦改：排队消息条（与主界面同组件同账本；dock 精简版隐藏拖拽把手外的宽元素） -->
          <QueueBar :conv-id="props.conversationId" :items="queueStore.get(props.conversationId)" :paused="queueStore.isPaused(props.conversationId)" @edit="queueEditItem" @remove="queueRemoveItem" @move="queueMoveItem" @resume="queueResume" @purge-all="queuePurgeAll" />
          <!-- 编辑器：与主聊天页同一 ChatInput 组件（标签/图片/粘贴完全同步） -->
          <!-- ★1011e：输入区与主对话流统一视觉语言（16px 圆角 / 工具行 12px 内距 / 9×9 按钮）；
               控件保持精简三件套（附件 · 上下文圆环 · 发送），不搬主视图那排模型/权限/计划工具 -->
          <div class="border border-gray-200 rounded-2xl bg-white shadow-sm focus-within:border-gray-400 transition-colors overflow-hidden">
            <ChatInput ref="chatInputRef" :conv-id="String(props.conversationId ?? '')" @send="send" @draft="draftHasText = $event" />
            <div class="flex items-center gap-1.5 px-3 py-2 border-t border-gray-100">
              <!-- ★1011f：附件钮与主对话流逐字对齐（p-2 hover:bg-gray-100 rounded-full + 16px 图标） -->
              <button class="p-2 hover:bg-gray-100 rounded-full transition-colors" :title="t('chat.addImage')" @click="pickFiles">
                <Paperclip :size="16" stroke-width="1.75" class="text-gray-600" />
              </button>
              <input ref="fileInputRef" type="file" accept="image/*" multiple class="hidden" @change="onFilesChosen" />
              <!-- 上下文占用圆环（0905 十批）：>70% 琥珀 >90% 红；悬停显示 token 明细。
                   ★1011f：包一层圆钮（hover 底 + 18px），与"附件钮/发送钮"三件套同一视觉语言 -->
              <div class="flex-1 min-w-0 flex justify-start pl-0.5">
                <button class="p-1 rounded-full hover:bg-gray-100 transition-colors flex items-center" :title="ctxTitle">
                  <svg width="18" height="18" viewBox="0 0 20 20" class="shrink-0">
                    <circle cx="10" cy="10" r="7.5" fill="none" stroke="currentColor" opacity="0.18" stroke-width="3" />
                    <circle
                      cx="10" cy="10" r="7.5" fill="none" :stroke="ctxColor" stroke-width="3"
                      stroke-linecap="round" stroke-dasharray="47.1"
                      :stroke-dashoffset="47.1 * (1 - Math.min(100, ctxPercent) / 100)"
                      transform="rotate(-90 10 10)"
                      style="transition: stroke-dashoffset 0.4s ease, stroke 0.4s ease;"
                    />
                  </svg>
                </button>
              </div>
              <!-- 发送/停止（0909⑦改与主界面同源）：忙时且无草稿=停止；忙时有草稿=发送(排队/插话)；空闲=发送 -->
              <!-- ★1011f：改圆形 + 阴影 + 悬停微放大（原为方形 12px 圆角，看着"寡淡"） -->
              <button
                @click="onSendButtonClick"
                class="shrink-0 w-9 h-9 flex items-center justify-center rounded-full shadow-sm transition-all hover:shadow hover:scale-105 active:scale-95"
                :class="showStopBtn ? 'bg-red-500 hover:bg-red-600 text-white' : 'bg-gray-900 text-white hover:bg-black disabled:opacity-40 disabled:shadow-none disabled:scale-100'"
                :disabled="!showStopBtn && sending"
                :title="showStopBtn ? t('chat.stopGenerating') : aiBusy ? t('queue.busySendTitle') : t('chat.send')"
              >
                <i v-if="showStopBtn" class="fas fa-stop text-[10px]"></i>
                <i v-else class="fas fa-paper-plane text-[11px]"></i>
              </button>
            </div>
          </div>
        </div>
      </div>
    </Transition>

    <button @click="onBallClick" @dblclick="float.reset()" @pointerdown="float.startDrag" class="w-12 h-12 rounded-full bg-gray-900 text-white shadow-lg hover:scale-105 active:scale-95 transition-transform flex items-center justify-center relative" :title="open ? t('chat.collapseDock') : t('chat.openDock')">
      <MessageCircle :size="20" stroke-width="1.75" />
      <!-- 角标四态（0905 九批）：待确认琥珀 > 失败红 > 生成中转圈 > 未读绿 -->
      <span v-if="pendingCard" class="absolute top-0.5 right-0.5 w-4 h-4 rounded-full bg-amber-400 ring-2 ring-gray-900 flex items-center justify-center"><i class="fas fa-hand text-[7px] text-gray-900"></i></span>
      <span v-else-if="lastFailed && !streaming" class="absolute top-1 right-1 w-3 h-3 rounded-full bg-red-500 ring-2 ring-gray-900"></span>
      <span v-else-if="streaming" class="absolute top-0.5 right-0.5 w-5 h-5 rounded-full bg-white flex items-center justify-center shadow">
        <i class="fas fa-circle-notch fa-spin text-[9px] text-gray-700"></i>
      </span>
      <span v-else-if="unread" class="absolute top-1 right-1 w-2.5 h-2.5 rounded-full bg-green-400 ring-2 ring-gray-900"></span>
    </button>
    <!-- ★1011h：删除这一轮确认卡（Teleport 到 body：不受浮层定位/缩略缩放影响；语义与主对话流一致） -->
    <Teleport to="body">
      <div v-if="delTurnTarget" class="fixed inset-0 z-[10010] flex items-center justify-center bg-black/40" @click.self="!delTurnBusy && (delTurnTarget = null)">
        <div class="w-[320px] rounded-2xl bg-white p-4 shadow-2xl">
          <div class="mb-1 text-[13px] font-[640] text-gray-900">{{ t('chat.deleteTurnTitle') }}</div>
          <p class="mb-3 text-[12px] leading-relaxed text-gray-500">{{ t('chat.deleteTurnBody') }}</p>
          <label class="mb-2 flex cursor-pointer select-none items-start gap-2">
            <input type="radio" :checked="delTurnIncludeUser" class="mt-0.5" @change="delTurnIncludeUser = true" />
            <span class="text-[12px] leading-snug text-gray-700">{{ t('chat.deleteTurnWithUser') }}</span>
          </label>
          <label class="mb-3 flex cursor-pointer select-none items-start gap-2">
            <input type="radio" :checked="!delTurnIncludeUser" class="mt-0.5" @change="delTurnIncludeUser = false" />
            <span class="text-[12px] leading-snug text-gray-700">{{ t('chat.deleteTurnReplyOnly') }}</span>
          </label>
          <p v-if="delTurnErr" class="mb-2 text-[11px] text-red-500">{{ delTurnErr }}</p>
          <div class="flex justify-end gap-2">
            <button class="rounded-lg border border-gray-300 px-3 py-1.5 text-[12px] text-gray-700 hover:bg-gray-50 disabled:opacity-50" :disabled="delTurnBusy" @click="delTurnTarget = null">{{ t('chat.cancel') }}</button>
            <button class="rounded-lg bg-red-500 px-3 py-1.5 text-[12px] text-white hover:bg-red-600 disabled:opacity-50" :disabled="delTurnBusy" @click="confirmDeleteTurn">
              {{ delTurnBusy ? t('chat.deleteTurnBusy') : t('chat.deleteTurnConfirm') }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
/* 展开/折叠动画（0905）：右下原点 scale+位移+淡入 */
.dock-window {
  transform-origin: bottom right;
}
.dock-pop-enter-active {
  transition: opacity 0.14s ease-out, transform 0.14s cubic-bezier(0.2, 0.9, 0.3, 1.2);
}
.dock-pop-leave-active {
  transition: opacity 0.12s ease-in, transform 0.12s ease-in;
}
.dock-pop-enter-from,
.dock-pop-leave-to {
  opacity: 0;
  transform: scale(0.92) translateY(10px);
}
/* 内嵌审批/询问卡紧凑化（0905 问题8）：zoom 缩放整卡（Chromium/WebView 支持），不影响主对话窗口 */
.dock-card-compact {
  zoom: 0.72;
}
/* ★1011d：思考行/工具行紧凑化 —— 浮层只有 360px 宽，主对话流那套行宽是按整屏设计的 */
.dock-zoom {
  zoom: 0.9;
  max-width: 100%;
}
/* ★1011d：AI 正文与主对话流同款（无气泡底 + 同色同字重；MarkdownText 自带 14px/1.7、颜色 #15151a）。
   原来这里是"灰底 12px 纯文本气泡"，markdown 全是原样字符 —— 用户说"过于简陋"就是它。 */
.msg-body {
  color: #15151a;
  font-weight: 400;
  word-break: break-word;
  overflow-wrap: anywhere;
  /* ★1011e：宽内容（代码块/表格/长路径）**自己横向滚动** —— 列表容器已 overflow-x-hidden，
     这样只会出现"局部横条"，不会再有整窗那条横条（反馈要它消失） */
  overflow-x: auto;
}
/* ★1011e：用户气泡 = 主对话流同款观感（蓝紫渐变 + 同一个气泡圆角变量 --dsh-bubble-radius，
   设置→外观→气泡圆角 改了小/中/大，浮层跟着一起变）。字号由模板的 text-[13px] 收一档（浮层窄）。 */
.dsh-user-bubble {
  /* ★1010：配色走全局变量（设置→外观→我的气泡颜色；未设置回落原蓝紫渐变） */
  background: var(--dsh-user-bubble, linear-gradient(135deg, #2563eb 0%, #4f46e5 100%));
  border-radius: var(--dsh-bubble-radius, 16px) var(--dsh-bubble-radius, 16px) 4px var(--dsh-bubble-radius, 16px);
  padding: 8px 12px;
  line-height: 1.6;
  font-weight: 440;
  color: var(--dsh-user-bubble-fg, #ffffff);
  box-shadow: 0 2px 8px var(--dsh-user-bubble-shadow, rgba(37, 99, 235, 0.28));
  white-space: pre-wrap;
  word-break: break-word;
}
/* 插话待注入：气泡呼吸发光（主对话流同名类，浮层自带 keyframes 以免依赖主视图 scoped 样式） */
.dsh-user-bubble.steer-glow {
  animation: dockSteerGlow 1.5s ease-in-out infinite;
}
@keyframes dockSteerGlow {
  0%, 100% { box-shadow: 0 2px 8px rgba(37, 99, 235, 0.28); }
  50% { box-shadow: 0 0 0 3px rgba(79, 70, 229, 0.35), 0 2px 12px rgba(37, 99, 235, 0.45); }
}
.msg-typing {
  display: inline-flex;
  padding: 2px 0;
}
/* ★1011f：消息操作行（语义抄主对话流 .msg-action：圆形小钮 + hover 底色 + 常态低调灰） */
.dock-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  color: #9ca3af;
}
.dock-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 9999px;
  color: #9ca3af;
  transition: background 0.15s, color 0.15s;
}
.dock-action:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, 0.05));
  color: #4b5563;
}
/* ★1011h：正在朗读这条回复 —— 图标呼吸（同主对话流 .msg-action.is-speaking 的语义） */
.dock-action.is-speaking {
  color: #6366f1;
  animation: dockSpeakPulse 1.4s ease-in-out infinite;
}
@keyframes dockSpeakPulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.45; }
}
/* ★1011i：本轮计时胶囊（观感照抄 StatsLine 的 .stats-pill + 折线流动动画，尺寸/内距适配 360px 浮层） */
.dock-turn-pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  width: fit-content;
  margin: 2px 0 1px 2px;
  padding: 3px 10px;
  border-radius: 9999px;
  background: rgba(255, 255, 255, 0.6);
  border: 1px solid rgba(0, 0, 0, 0.06);
  font-size: 11px;
  color: #6b7280;
  white-space: nowrap;
}
.dock-turn-text {
  font-variant-numeric: tabular-nums;
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
.turn-wave .tw-back { stroke: #d1d5db; }
.turn-wave .tw-front {
  stroke: #1f2937;
  stroke-dasharray: 48, 144;
  stroke-dashoffset: 192;
  animation: dockTurnDash 1.4s linear infinite;
}
@keyframes dockTurnDash {
  72.5% { opacity: 0; }
  to { stroke-dashoffset: 0; }
}
html.dark .dock-turn-pill {
  background: rgba(30, 30, 36, 0.6);
  border-color: rgba(255, 255, 255, 0.08);
  color: #9ca3af;
}
html.dark .turn-wave .tw-back { stroke: #4b5563; }
html.dark .turn-wave .tw-front { stroke: #e5e7eb; }
</style>
<style scoped>
/* 回到最新小圆钮（0906）：列表区右下，玻璃质感随主题 */
.dock-jump-bottom {
  position: absolute;
  right: 10px;
  bottom: 10px;
  z-index: 10;
  width: 26px;
  height: 26px;
  border-radius: 9999px;
  border: 1px solid var(--glass-line, rgba(0, 0, 0, 0.08));
  background: var(--glass-panel, rgba(255, 255, 255, 0.85));
  -webkit-backdrop-filter: blur(8px);
  backdrop-filter: blur(8px);
  color: #374151;
  font-size: 11px;
  cursor: pointer;
  box-shadow: 0 3px 10px rgba(0, 0, 0, 0.16);
}
html.dark .dock-jump-bottom { color: #d9d9e3; box-shadow: 0 3px 10px rgba(0, 0, 0, 0.55); }
/* 0909⑦改：插话待注入=用户气泡呼吸发光描边（与主界面 steer-glow 同款） */
.dock-window .steer-glow {
  animation: dockSteerGlow 1.5s ease-in-out infinite;
}
@keyframes dockSteerGlow {
  0%, 100% { box-shadow: 0 0 0 1.5px rgba(96, 165, 250, 0.7), 0 0 10px 2px rgba(59, 130, 246, 0.35); }
  50% { box-shadow: 0 0 0 2px rgba(147, 197, 253, 0.95), 0 0 22px 6px rgba(59, 130, 246, 0.55); }
}
/* 0909⑨：插话已注入胶囊（重试过程块同款形态，dock 缩小版） */
.dock-steer-pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 9px;
  border-radius: 9999px;
  font-size: 11px;
  font-weight: 300;
  background: rgba(0, 0, 0, 0.035);
  border: 1px solid rgba(0, 0, 0, 0.06);
  color: #6b7280;
  user-select: none;
}
html.dark .dock-steer-pill {
  background: rgba(255, 255, 255, 0.05);
  border-color: rgba(255, 255, 255, 0.09);
  color: #9ca3af;
}
</style>
