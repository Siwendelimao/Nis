<script setup lang="ts">
import { ref, watch, computed, nextTick, onMounted, onUnmounted, triggerRef, defineAsyncComponent } from 'vue'
import type { Component } from 'vue'
import { Paperclip, Cpu } from 'lucide-vue-next'
import { useChatStore } from '@/stores/chat'
import { usePiChatStore } from '@/stores/piChat'
import PiChatView from './PiChatView.vue'
import ThinkLoader from './ThinkLoader.vue'
import SearchLoader from './SearchLoader.vue'
import ToolLoader from './ToolLoader.vue'
import CodeLoader from './CodeLoader.vue'
import CellLoader from './CellLoader.vue'
import ShinyText from './ShinyText.vue'
import StreamingText from './blocks/StreamingText.vue'
import MessageBlocks from './blocks/MessageBlocks.vue'
import StatsLine from './blocks/StatsLine.vue'

import PermissionSelector from './blocks/PermissionSelector.vue'
import PlanModeSelector from './blocks/PlanModeSelector.vue'
import ModelSelector from './blocks/ModelSelector.vue'
import VoiceInputButton from './blocks/VoiceInputButton.vue'
import QuickCommands from './blocks/QuickCommands.vue'
import SkillPicker from './blocks/SkillPicker.vue'
import ChatInput from './ChatInput.vue'
import { useWorkspaceStore } from '@/stores/workspace'
import { useBrowserStore } from '@/stores/browser'
import { useConversationsStore } from '@/stores/conversations'
import { useExternalChatStore } from '@/stores/externalChat'
import type { Conversation } from '@/stores/conversations'
import { t } from '@/utils/i18n'
import { startTurnTimer, stopTurnTimer, turnSecondsOf, syncTurnTimer, turnTimerTick } from '@/utils/turnTimer'  /* ★1004m-2 模块级单例 + ★1012e 计时同步 */
import { useAgentPresetsStore, presetDisplayName } from '@/stores/agentPresets'
import MiniSelect from './blocks/MiniSelect.vue'   // ★1001 外部预设 own 档的模型下拉（自家样式/深色适配）
import { useTeamsStore } from '@/stores/teams'
import { useNotificationsStore } from '@/stores/notifications'
import { usePartnersStore } from '@/stores/partners'
import { useProvidersStore } from '@/stores/providers'
import { useTasksStore } from '@/stores/tasks'
/* ★ 0922e：进程监控（铃铛左侧按钮 → 弹窗） */
import { useProcsStore } from '@/stores/procs'

import PreviewTabBar from './PreviewTabBar.vue'
import WindowControls from './blocks/WindowControls.vue'
import SystemNotificationCenter from './SystemNotificationCenter.vue'
/* ★1012 手机端瘦身：PC 专用面板改成「用到才下载」（它们都由 v-if 控制，不点开就不会渲染 ⇒ chunk 不下载） */
const ProcMonitorModal = defineAsyncComponent(() => import('./blocks/ProcMonitorModal.vue'))
/* ★1012 手机端瘦身：PC 专用面板改成「用到才下载」（它们都由 v-if 控制，不点开就不会渲染 ⇒ chunk 不下载） */
const RunLogPanel = defineAsyncComponent(() => import('./RunLogPanel.vue'))
import MemberDmPicker from './blocks/MemberDmPicker.vue'
/* ★1012 手机端瘦身：PC 专用面板改成「用到才下载」（它们都由 v-if 控制，不点开就不会渲染 ⇒ chunk 不下载） */
const WorkspacePanel = defineAsyncComponent(() => import('./WorkspacePanel.vue'))
/* ★1012 手机端瘦身：PC 专用面板改成「用到才下载」（它们都由 v-if 控制，不点开就不会渲染 ⇒ chunk 不下载） */
const VersionPanel = defineAsyncComponent(() => import('./VersionPanel.vue'))
import PlanCard from './blocks/PlanCard.vue'
import BgTaskPill from './blocks/BgTaskPill.vue'
import BgTaskModal from './blocks/BgTaskModal.vue'
import QueueBar from './blocks/QueueBar.vue'
import AttachmentsBar from './blocks/AttachmentsBar.vue'   /* ★1011：附件条抽成组件 —— 会话页与欢迎页共用（原来只有会话页渲染，空态拖入文件"看不见"） */
import { useQueueStore, type QueueItem } from '@/stores/queue'
/* ★1012 手机端瘦身：PC 专用面板改成「用到才下载」（它们都由 v-if 控制，不点开就不会渲染 ⇒ chunk 不下载） */
const PreviewTabContent = defineAsyncComponent(() => import('./PreviewTabContent.vue'))
/* ★1012 手机端瘦身：PC 专用面板改成「用到才下载」（它们都由 v-if 控制，不点开就不会渲染 ⇒ chunk 不下载） */
const BrowserPanel = defineAsyncComponent(() => import('./BrowserPanel.vue'))
/* ★1012 手机端瘦身：PC 专用面板改成「用到才下载」（它们都由 v-if 控制，不点开就不会渲染 ⇒ chunk 不下载） */
const CanvasPanel = defineAsyncComponent(() => import('./CanvasPanel.vue'))
import ViewChatDock from './ViewChatDock.vue'
import ApprovalPanel from './blocks/ApprovalPanel.vue'
import QuestionComposer from './blocks/QuestionComposer.vue'
import { usePreviewTabsStore } from '@/stores/previewTabs'
import { useSettingsStore } from '@/stores/settings'
import Globe from './blocks/Globe.vue'
import ContextMenu, { type ContextMenuItem } from './ContextMenu.vue'

import LogAvatar from './LogAvatar.vue'
import { localStore } from '@/utils/localStore'
import { stripModeHint } from '@/utils/modeHint'

interface Message {
  id: number
  type: 'user' | 'ai' | 'partner'
  content?: string
  time: string
  status?: 'thinking' | 'searching' | 'done'
  model?: string
  duration?: string
  sender?: string
  blocks?: Array<{ type: string; content: string; [key: string]: any }>
}

const chatStore = useChatStore()

/* ★1012（手机端瘦身配套）：下面那 7 个 PC 面板改成了「用到才下载」，点开才现取会有一瞬延迟。
   这里在首屏挂载后趁浏览器**一空闲就并行把它们的 chunk 全部取回本地** ⇒ 点开即开（与静态引入体感一致）。
   手机端**跳过**（省流量优先）；预取失败静默忽略 —— 真去点开时 defineAsyncComponent 还会再取一次。 */
onMounted(() => {
  try {
    const narrow = window.matchMedia('(max-width: 767px)').matches
    const coarse = window.matchMedia('(pointer: coarse)').matches
    const ua = /Android|iPhone|iPod|iPad|Mobile/i.test(navigator.userAgent || '')
    if (narrow && (coarse || ua)) return
  } catch { /* 判定失败就照常预取：宁可多下点，也不要点开时才发现没准备 */ }
  const warm = () => {
    const jobs: Array<() => Promise<unknown>> = [
      () => import('./PreviewTabContent.vue'),
      () => import('./BrowserPanel.vue'),
      () => import('./CanvasPanel.vue'),
      () => import('./WorkspacePanel.vue'),
      () => import('./VersionPanel.vue'),
      () => import('./RunLogPanel.vue'),
      () => import('./blocks/ProcMonitorModal.vue'),
    ]
    for (const j of jobs) void Promise.resolve(j()).catch(() => { /* 预取失败不打扰用户 */ })
  }
  const ric = (window as any).requestIdleCallback
  if (typeof ric === 'function') ric(warm, { timeout: 800 })   /* 一空闲就做；最多等 0.8s */
  else window.setTimeout(warm, 200)
})
const piChatStore = usePiChatStore()
const externalChatStore = useExternalChatStore()
const previewTabsStore = usePreviewTabsStore()
/** agent-event 去重：窗口内相同 seq 重复到达视为�?SSE 连接（丢弃）�? *  seq 回退（后端重�?agentEventSeq 归零重发）不被淘汰，事件照常接受 */
let lastAgentSeq = 0
const recentAgentSeqs = new Map<number, number>()
const SEQ_DUP_WINDOW = 8000
/** 0914c（双通知修复）：回合完成通知按会话去重——session/status 帧经会话流+全局流双到达（后端镜像），
 *  同一次完成会被处理两遍；提示音/系统通知是非幂等副作用，1.5s 窗口内只放行一次 */
const lastTurnNotifyAt = new Map<string, number>()

/**
 * 0920（反馈）：系统提醒要"显示对话名 + AI 回复摘要"。
 * 取该会话**最后一条 assistant 回复**的正文 → 去掉 markdown 装饰/代码块/图片链接 → 压成一行截断。
 * 拿不到（纯工具轮、被中断、回复为空）时返回空串，调用方自行兜底文案。
 */
function lastReplySummary(sid: string, max = 120): string {
  try {
    const nodes = piChatStore.getNodes(sid) || []
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n: any = nodes[i]
      if (n?.kind !== 'assistant') continue
      let raw = String(n.text || '').trim()
      if (!raw && Array.isArray(n.blocks)) {
        raw = n.blocks.filter((b: any) => b?.type === 'plaintext').map((b: any) => String(b.content || '')).join('\n')
      }
      if (!raw.trim()) continue
      const clean = raw
        .replace(/```[\s\S]*?```/g, ' ')            // 代码块整段去掉（摘要里没有意义）
        .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')      // 图片
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')    // 链接只留文字
        .replace(/^\s{0,3}#{1,6}\s*/gm, '')         // 标题符号
        .replace(/^\s{0,3}[-*+]\s+/gm, '')          // 列表符号
        .replace(/[*`>_~]/g, '')                    // 其余 markdown 装饰
        .replace(/\s+/g, ' ')
        .trim()
      return clean.slice(0, max)
    }
  } catch { /* 拿不到就算了，通知退化为只有对话名 */ }
  return ''
}
/** 预览刚打开的时间戳（0908 备注：原用于抑制 browser/act 拉扯；自动切视图已移除，保留供未来预览节流） */
let previewJustOpenedAt = 0
void previewJustOpenedAt

/** 输入框磨砂（0903 二次修）：本环境 backdrop-filter 采样在 F5 全量加载后失效（HANDOVER 铁律 #23，
 *  CSS.supports 检测不出这种失效），真模糊路线放弃；磨砂改由壳内独立图层承担伪磨砂材质
 *  （冷调白渐变 + 内高光，PlanCard 同款），与 ::before 流光描边分属不同图层互不冲突。 */

/** 当前窗口的 tab 归属 key。
 *  ★1011c 修（实测反馈"对话界面输入内容 → 进预览页 tab → 切回对话，输入框内容没了"）：
 *  草稿态（还没发消息的窗口）`conversation.id` 为 null，旧写法让下面两个 computed 直接退化成
 *  null / 'chat'；而 tab 栏（PreviewTabBar）用的 key 是 `String(activeConversationId ?? '')` = ''。
 *  于是「面板 tab 真切了、这里的 watch 源却一动不动」⇒ 切出时不 stash、切回时不 restore，
 *  对话模板 v-if 一卸载，contenteditable 里的字就没了。两处统一成同一个 key。 */
const previewTabsKey = computed(() => String(props.conversation?.id ?? ''))
/** 当前窗口激活的预览 tab id（null = 显示对话内容）*/
const activePreviewTabId = computed(() => previewTabsStore.activeTabId(previewTabsKey.value))

/** 当前窗口固定视图（chat/browser/office）：browser/office 时优先于预览 tab */
const currentFixedView = computed(() => previewTabsStore.fixedView(previewTabsKey.value))

/** 扫描当前会话消息流，找最近一个未应答的权限审批/询问块（输入框接管数据源） */
const pendingCard = computed(() => {
  if (!props.conversation?.id) return null
  void piChatStore.asideVersion
  const nodes = piChatStore.getNodes(String(props.conversation.id))
  // 权限卡：取最后一个未应答�?
for (let i = nodes.length - 1; i >= 0; i--) {
    for (const a of (nodes[i].asides || [])) {
      if (a.type === 'permission_prompt' && !a.answered) {
        return { kind: 'permission', block: a }
      }
    }
  }
  // 询问卡：收集所有未应答的（多题 aside �?questions 数组展开为独立题目）
  const questions: any[] = []
  for (let i = 0; i < nodes.length; i++) {
    for (const a of (nodes[i].asides || [])) {
      if (a.type === 'ask_user' && !a.answered) {
        if (Array.isArray(a.questions) && a.questions.length > 0) {
          // 一次多题：每题独立（共�?request_id，最后一次性提交全部）
          for (const q of a.questions) {
            questions.push({ ...q, request_id: a.request_id, group: a.request_id })
          }
        } else {
          questions.push(a)
        }
      }
    }
  }
  if (questions.length > 0) return { kind: 'question', block: questions[0], questions }
  return null
})

/* ★0927：本窗口答过的交互卡 requestId —— 用来区分「你答的」与「别的窗口答的」
   （后端结算帧不区分，前端原来一律写成"已在其他窗口应答"）。上限 200 防无限增长。 */
const hitlAnsweredHere = new Set<string>()
function trimAnsweredHere() { if (hitlAnsweredHere.size > 200) hitlAnsweredHere.clear() }

/* ★0930：答题卡提交失败后的重挂序号 —— 答题卡 done 态是组件内部 ref，失败后已冻结成"已提交"，
   只能让它按新 key 重建才能重新作答（见两处 QuestionComposer 的 :key）。 */
const qSubmitSeq = ref(0)

function handleHitlResponse(payload: { request_id: string; choice: string }) {
  const convId = props.conversation?.id
  if (convId == null) return
  /* ★0927：记下"这张卡是本窗口答的" —— 后端结算帧（interaction-done）随后就到，
     不记的话会被统一改写成「已在其他窗口应答」（实测困惑：自己刚点的同意显示成别的窗口答的）。 */
  hitlAnsweredHere.add(String(payload.request_id))
  trimAnsweredHere()
  chatStore.sendHitlResponse(payload.request_id, payload.choice, String(convId))
  piChatStore.answerAside(String(convId), payload.request_id, payload.choice)
  conversationsStore.setPendingInteraction(String(convId), null)
}

function handleQuestionSubmit(payload: { request_id: string; value: string }) {
  const convId = props.conversation?.id
  if (convId == null) return
  /* ★1011 修（"问题卡又显示已在其他窗口应答"真凶）：**"本人答的"标记必须赶在 await 之前** ——
     后端一收到答案就 resolve 并广播结算帧（session/interaction-done），SSE 帧与 RPC 响应
     走两条通道、**帧完全可能先到**。0930 把标记挪到"送达成功才落"之后 → 帧抢先到达时
     mine=false ⇒ 卡被改写成「已在其他窗口应答」，随后真实答案想写又被 first-wins 挡住
     （权限卡是同步打标记，所以只有问题卡中招）。送达失败再撤回标记，语义与 0930 一致。 */
  hitlAnsweredHere.add(String(payload.request_id))
  trimAnsweredHere()
  try { piChatStore.markAnsweredByUser(String(payload.request_id)) } catch { /* ignore */ }
  void (async () => {
    const ok = await chatStore.sendQuestionAnswer(payload.request_id, payload.value, String(convId))
    /* ★0930 修（答题卡"2/2 已提交"但 AI 停"等待处理"卡死）：**送达成功才落已答态** ——
       旧版不管答案有没有到后端就撤计时+标已答+收卡：答案丢了时界面全绿、AI 却一直挂着等。
       送达失败＝什么态都不落：卡片保持可重试（qSubmitSeq 逼答题卡重建，解除"已提交"冻结），
       3 分钟超时兜底计时也留着，绝不把"没送达"演成"已提交"。 */
    if (!ok) {
      /* ★1011：没送达 = 谁都没答 → 撤回上面那笔乐观标记（否则真被别的窗口答时会误判"我答的"） */
      hitlAnsweredHere.delete(String(payload.request_id))
      try { piChatStore.forgetAnsweredByUser(String(payload.request_id)) } catch { /* ignore */ }
      qSubmitSeq.value += 1
      notificationsStore.pushSystem({
        title: t('sysNotify.questionSendFailTitle'),
        message: t('sysNotify.questionSendFailBody'),
        level: 'error',
        category: 'permission',
        sessionId: String(convId),
      })
      return
    }
    /* ★ 0923：用户已作答且送达 → 撤掉超时计时（否则 3 分钟后那次会再提交一遍"跳过"，把真实答案盖掉） */
    cancelQuestionTimeout()
    piChatStore.answerAside(String(convId), payload.request_id, payload.value)
    conversationsStore.setPendingInteraction(String(convId), null)
  })()
}

function handleQuestionIgnore(payload: { request_id: string }) {
  const convId = props.conversation?.id
  if (convId == null) return
  /* ★1011：同 handleQuestionSubmit —— 标记也要赶在 await 前（竞态一模一样） */
  hitlAnsweredHere.add(String(payload.request_id))
  trimAnsweredHere()
  try { piChatStore.markAnsweredByUser(String(payload.request_id)) } catch { /* ignore */ }
  void (async () => {
    const ok = await chatStore.sendQuestionAnswer(payload.request_id, '__ignored__', String(convId))
    /* ★0930：同 handleQuestionSubmit —— 跳过也要真送达才算数（失败保留卡+计时兜底） */
    if (!ok) {
      hitlAnsweredHere.delete(String(payload.request_id))
      try { piChatStore.forgetAnsweredByUser(String(payload.request_id)) } catch { /* ignore */ }
      qSubmitSeq.value += 1
      return
    }
    /* ★ 0923：用户主动跳过 → 同样撤掉超时计时 */
    cancelQuestionTimeout()
    piChatStore.answerAside(String(convId), payload.request_id, '__ignored__')
    conversationsStore.setPendingInteraction(String(convId), null)
  })()
}

/** 测试/演示后门：往当前会话注入门禁/询问卡（detail: { kind, ...block 字段 }�?*/
function handleInjectCard(e: Event) {
  const d = (e as CustomEvent).detail || {}
  const convId = props.conversation?.id
  if (convId == null) return
  const kind = d.kind === 'question' ? 'ask_user' : 'permission_prompt'
  const list = getMessages(convId)
  const ai = list.find(m => m.type === 'ai' && m.status === 'done')
  const target = ai || (() => { const m = { id: nextMessageId(convId), type: 'ai', status: 'done', content: '', blocks: [] }; list.push(m); return m })()
  if (!target.blocks) target.blocks = []
  target.blocks.push({
    type: kind,
    request_id: d.request_id || `inject_${Date.now().toString(36)}`,
    question: d.question,
    options: d.options,
    tool: d.tool,
    risk: d.risk || 'medium',
    placeholder: d.placeholder,
    multiple: d.multiple,
  })
  nextTick(() => scrollToBottom())
}

function handleWebSocketMessage(msg: any) {
  // 对话渲染基于 pi 原始事件（piChat 节点运行时），事件消费在组件级保证不丢失
  if (msg.type === 'server-request' && msg.payload) {
    const p = msg.payload
    // pi 原始事件 �?
    // piChat 节点（seq 去重：前端偶发重连会产生短暂�?SSE 连接，事件双份）
    // 注意：不做当前会话过滤——切换会话后原会话仍流式/收尾（agent_end 丢失会导�?    // streaming 节点永不定稿，切回时只剩"无内�?Think"）；节点�?convId 独立存储
    // 内置浏览器帧（0905 七批按会话隔离）：按帧里的 sessionId 路由进对应桶
    if (p.type === 'browser/frame') { browserStore.onFrame(String(p.sessionId || props.conversation?.id || 'default'), p); return }
    if (p.type === 'browser/status') { browserStore.onStatusFrame(String(p.sessionId || props.conversation?.id || 'default'), p); return }
    if (p.type === 'browser/tabs') { browserStore.onTabsFrame(String(p.sessionId || props.conversation?.id || 'default'), p); return }
    if (p.type === 'browser/control') { browserStore.onControlFrame(String(p.sessionId || props.conversation?.id || 'default'), p); return }
    if (p.type === 'browser/scroll') { browserStore.onScrollFrame(String(p.sessionId || props.conversation?.id || 'default'), p); return }
    if (p.type === 'browser/act') {
      // 0908：去掉"AI 一动浏览器工具就把用户拽到浏览器视图/弹悬浮窗"的自动拉页
      //（来回拉+与预览打架；模型 navigate→preview_file 各拉一边）。AI 活跃指示小动画
      // 走 browser/control(aiLastActiveAt) 独立链路，不受影响。事件本身继续透传（无害）。
      return
    }
    // AI 用 wb_preview_file 打开本地产物 → 预览 tab 展示（0905 问题6：本地文件优先预览）
    // 0908：AI 通道改为【后台打开】（activate:false）——不再抢用户视图，tab 上亮琥珀点由用户自己决定何时看；
    // key 去掉内容长度=同文件再预览刷新同一 tab（旧版每次新 key，改一次文件多一个重复 tab）
    if (p.type === 'preview/open') {
      try {
        const sid = String(p.sessionId || '')
        const convId = props.conversation?.id != null ? String(props.conversation.id) : null
        if (!convId || sid !== convId) return
        previewJustOpenedAt = Date.now()
        // 0914 精准打击②：消息带 path 时（后端给的工作区相对路径）先找本会话同源文件的已开 tab，
        // 命中则【就地刷新内容】（代理 iframe 随 content 变化自动重载），不再叠一个 ai: 重复 tab；
        // 找不到才走原 ai: 通道（后台打开 + 琥珀点）。无 path（旧后端）行为不变。
        const normP = (x: unknown) => String(x || '').replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase()
        const wantPath = normP(p.path)
        const target = wantPath
          ? previewTabsStore.tabsFor(convId).find((t: any) => !!t.srcPath && normP(t.srcPath) === wantPath)
          : null
        if (target) {
          previewTabsStore.openTab(convId, {
            key: target.key,
            kind: p.kind,
            title: target.title || p.name,
            content: p.content,
            dataUrl: p.dataUrl,
            viewMode: p.kind === 'html' ? (target.viewMode || 'page') : undefined,
          } as any, { activate: false })
        } else {
          previewTabsStore.openTab(convId, {
            key: 'ai:' + p.name,
            kind: p.kind,
            title: p.name,
            content: p.content,
            dataUrl: p.dataUrl,
            viewMode: p.kind === 'html' ? 'page' : undefined,
          } as any, { activate: false })
        }
      } catch { /* ignore */ }
      return
    }
    /* ★1010 外部流（P0 契约）：ext-stream 帧（server-request.payload）→ externalChat store；
       PartEvent 累积 + seq 断序容错在 store 内（乱序缓冲补齐再渲染、缺号按到序补渲不阻塞）。 */
    if (p.type === 'ext-stream') {
      externalChatStore.ingestFrame(String(p.sessionId || ''), p.seq, p.part)
      return
    }
    if (p.type === 'session/agent-event') {
      const sid = String(p.sessionId)
      /* ★1010 外部流（P0 契约）：外部会话不进 piChat 的 agent-event 翻译路径（正文/思考/工具走 ext-stream 帧，
         live 与回放同一渲染路径）。收轮副作用保留：侧栏预览 + 未读/已读口径不变。 */
      if (externalChatStore.isExternal(sid)) {
        if (p.event?.type === 'agent_end') {
          conversationsStore.onAiReplyCompleted(sid, externalChatStore.lastText(sid), nowTime())
          if (String(props.conversation?.id ?? '') === sid) conversationsStore.markRead(sid)
        }
        return
      }
      if (typeof p.seq === 'number') {
        const now = Date.now()
        const seenAt = recentAgentSeqs.get(p.seq)
        if (seenAt != null && now - seenAt < SEQ_DUP_WINDOW) return
        recentAgentSeqs.set(p.seq, now)
        if (p.seq > lastAgentSeq) lastAgentSeq = p.seq
        if (recentAgentSeqs.size > 100) {
          for (const [k, t] of recentAgentSeqs) {
            if (now - t >= SEQ_DUP_WINDOW) recentAgentSeqs.delete(k)
          }
        }
      }
      piChatStore.handleAgentEvent(sid, p.event)
      // 该会话 AI 回复完成（agent_end）：更新列表预览 + 未读（是否当前会话由 conversations store 判断）
      if (p.event?.type === 'agent_end') {
        const nodes = piChatStore.getNodes(sid)
        const lastAsst = [...nodes].reverse().find(n => n.kind === 'assistant' && n.text)
        conversationsStore.onAiReplyCompleted(sid, lastAsst?.text || '', nowTime())
        /* ★0927（①b）：**正在看的这条会话**跑完一轮 = 已读（写回后端 lastReadAt）。
           否则"开着会话看回复"的场景，刷新后会被算成未读（后端口径与肉眼不一致）。 */
        if (String(props.conversation?.id ?? '') === sid) conversationsStore.markRead(sid)
      }
      return
    }
    // 团队子 agent 事件（team_dispatch 派发的成员实例）：挂到对应工具节点折叠渲染
    if (p.type === 'session/subagent-event') {
      piChatStore.handleSubagentEvent(String(p.sessionId), p)
      return
    }
    // 权限卡挂起帧 �?注入 piChat 节点 + 列表等待状态（不做会话过滤：切走后该会话仍要挂�?记录等待�?    // 否则切回时卡片丢失且 agent 一直等�?�?发送按钮卡�?停止"�?
    if (p.type === 'session/hitl-request') {
      const sid = String(p.sessionId)
      /* ★0929（已定案新口径）：审批卡**只在正显示这条会话的窗口挂卡可答**；
         别的窗口/正看着别的会话时只弹系统通知（点击跳转）+ 侧栏"等待你"角标 ——
         不再到处弹可作答的卡（0926"任何窗口都可答"旧口径退役）。
         不挂卡不会丢：切到该会话时 openConversation / reconcileLive 会按
         pendingApprovals / pendingQuestions 回灌出卡（见 piChat 0929 补挂）。 */
      if (String(props.conversation?.id ?? '') === sid) {
        piChatStore.attachAside(sid, {
          type: 'permission_prompt',
          request_id: p.requestId,
          question: p.question,
          options: p.options,
          tool: p.tool,
          risk: p.risk || 'medium',
        })
      }
      conversationsStore.setPendingInteraction(sid, 'permission')
      ensureSessionVisible(sid)
      // 0914（设置→提示接线）：审批请求 → 系统通知（窗口可见时只播提示音；受「审批」开关门控）
      void import('@/utils/systemNotify')
        .then((m) =>
          m.notifySystem({
            category: 'permission',
            title: t('sysNotify.approvalTitle'),
            message: String(p.question || '').slice(0, 90),
            // 0914c：点击系统通知 → 直达对应对话窗口（审批卡等待作答）
            sessionId: sid,
            soundOnly: !document.hidden,
          }),
        )
        .catch(() => { /* ignore */ })
      // 0905 九批：审批卡已在悬浮窗内嵌可应答（不再强制切回对话视图）；收起悬浮窗时球上有琥珀角标提醒
      return
    }
    // 询问卡（同上：不过滤会话�?
if (p.type === 'session/question') {
      const sid = String(p.sessionId)
      /* ★0929（已定案新口径，与审批卡一致）：只在正显示该会话的窗口挂卡可答 + 武装前端
         超时自动跳过；其他窗口只弹系统通知（点击跳转）+ 侧栏角标。
         原实现每窗都挂卡、**每窗都各自计时到点各自提交「忽略」**（多窗口双答/你刚答完又被
         别窗的计时器补一脚），一并收口到"谁看着谁负责"。 */
      const _viewing = String(props.conversation?.id ?? '') === sid
      if (_viewing) {
        piChatStore.attachAside(sid, {
          type: 'ask_user',
          request_id: p.requestId,
          question: p.question,
          questions: Array.isArray(p.questions) && p.questions.length > 0 ? p.questions : undefined,
          options: p.options,
          placeholder: p.placeholder,
        })
      }
      conversationsStore.setPendingInteraction(sid, 'ask')
      ensureSessionVisible(sid)
      /* ★0926 链路修复④（可见性）：询问卡此前**没有即时系统通知**（只有权限卡有），
         用户不在看这条会话时完全无感（实测：新开窗口里等待标记命中 0）。
         这里补上；沿用「审批」类别的开关门控（两者语义都是"agent 在等你操作"）。
         若日后要独立开关，需同时改 settings/i18n/提示音 —— 项目对"加开关"有四处同步纪律。 */
      void import('@/utils/systemNotify')
        .then((m) =>
          m.notifySystem({
            category: 'permission',
            title: t('sysNotify.questionTitle'),
            message: String(p.question || '').slice(0, 90),
            sessionId: sid,
            soundOnly: !document.hidden,
          }),
        )
        .catch(() => { /* ignore */ })
      if (_viewing) armQuestionTimeout(sid, String(p.requestId), String(p.question || ''))   // ★0929：只有看着这条会话的窗口才计时自动跳过
      // 同审批卡：询问卡在悬浮窗内嵌应答，不再强制切回（0905 九批）
      return
    }
    /* ★0926 链路修复②（补漏，E2E 实测发现）：后端 session.create 每次都广播 host/session-added，
       但前端**没有这个帧的处理器**（全仓 0 命中）⇒ 别的窗口（含 QQ/微信来的会话）新建的会话
       在本窗口侧栏里不出现，直到手动刷新 —— 而"正在等你应答的会话"恰恰最不能看不见。
       对策：收到交互帧时，若本窗口不认识这个会话 → 拉一次列表（拿回 awaitingUser → 侧栏带"等待你"）。
       （刻意不对 host/session-added 无条件插行：空白草稿会话在别窗弹行只是噪声，不是需求。） */
    function ensureSessionVisible(sid: string): void {
      if (!sid || conversationsStore.getById(sid)) return
      void conversationsStore.loadConversations()
        .catch((e) => swallowed('交互帧触发补拉会话列表失败（等你在应答的会话不会出现在侧栏）', e))
    }
    /* ★0926 链路修复②（配套）：交互结束（已应答/超时/会话被停）→ 清"等待你"标记 + 把本地那张卡
       标为已应答。必须做：卡可能是**别的窗口**答的，不处理就会留一张假卡 + 假等待标记。 */
    if (p.type === 'session/interaction-done') {
      const sid = String(p.sessionId)
      const rid = String(p.requestId || '')
      conversationsStore.setPendingInteraction(sid, null)
      if (rid) {
        /* ★0927：按**原因**说实话 —— 原实现四种情况（本窗口答的/别的窗口答的/超时/会话被停）
           都写成「已在其他窗口应答」，害得用户以为自己点的同意没生效。 */
        const reason = String((p as any).reason || '')
        /* ★0927：**"本窗口/本人答的"以全局 store 标记为准**（组件实例可能不是同一个），
           兜底再查组件局部 Set —— 两道都不命中才认定"别的窗口答的"。 */
        const mine = piChatStore.wasAnsweredByUser(rid) || hitlAnsweredHere.has(rid)
        if (reason === 'timeout') piChatStore.answerAside(sid, rid, t('chat.answeredTimeout'))
        else if (reason === 'cancelled') piChatStore.answerAside(sid, rid, t('chat.answeredCancelled'))
        else if (!mine) piChatStore.answerAside(sid, rid, t('chat.answeredElsewhere'))
        /* 本窗口答的：卡片上已经是你选的那项，**不要覆盖** */
        piChatStore.forgetAnsweredByUser(rid)
        hitlAnsweredHere.delete(rid)
      }
      return
    }
    // 全局设置更新（AI 改名工具/其他端修改）�?前端设置 store 立即同步
    if (p.type === 'host/settings-updated') {
      if (p.settings && typeof p.settings === 'object') {
        settingsStore.syncFromBackend()
      }
      return
    }
    /* ★1012o（已定案："以后端为权威反推，其他旧页面打开也应同步新值"）：
       全局模型/强度变更（后端 providers.setModel 广播）→ 本窗口立即对齐后端权威值。
       没有这条时，长期开着的标签页只在"连上那一刻"拉过一次，之后永远停在旧值，
       还会在发消息时把旧值反推回后端（1012n 那条漂移闭环）。用动态 import 避免动本文件 import 区。 */
    if (p.type === 'host/providers-updated') {
      void import('@/stores/providers').then(m => m.useProvidersStore().syncFromBackend()).catch(() => { /* 拉取失败也没关系：下次连上仍会拉到权威值 */ })
      return
    }
    /* ★1012t：**系统通知帧** —— 后端在"后台模型（提炼/蒸馏/渠道）失败"时广播；落进侧边栏铃铛面板
       （pushSystem 只做软件内记录，不受设置「系统提示」开关门控 —— 这正是需求的"面板里留一条"）。 */
    if (p.type === 'host/system-notice') {
      void import('@/stores/notifications').then((m) => m.useNotificationsStore().pushSystem({
        title: String(p.title || '系统通知'),
        message: String(p.message || ''),
        level: String(p.level || 'error'),
        category: 'error',
      })).catch(() => { /* ignore */ })
      return
    }
    /* 0920：后台任务进度推送（后端 backgroundTasks 每次状态/进度变化都推一条）
       → 直接喂给 tasks store（胶囊 tab + 任务视图的实时数据源） */
    /* ★ 0922e：进程监控 —— 新增/更新 + 结束移除（面板实时增删；设计口径：结束就消失） */
if (p.type === 'proc/updated') {
  if (p.proc && typeof p.proc === 'object') procsStore.applyProc(p.proc)
  return
}
if (p.type === 'proc/removed') {
  procsStore.removeProc(String(p.id || ''))
  return
}
if (p.type === 'bg/updated') {
      if (p.task && typeof p.task === 'object') tasksStore.applyBackendTask(p.task)
      return
    }
    // 0914 下午：QQ/微信机器人回复消息 → 系统通知（受设置→提示「机器人回复」开关门控）
    if (p.type === 'host/channel-reply') {
      const chLabel = p.channel === 'wechat' ? t('sysNotify.channelWechat') : t('sysNotify.channelQq')
      const preview = String(p.preview || '').slice(0, 90)
      void import('@/utils/systemNotify')
        .then((m) =>
          m.notifySystem({
            category: 'channel',
            title: t('sysNotify.channelTitle', { channel: chLabel }),
            message: [String(p.title || ''), preview].filter(Boolean).join('：'),
          }),
        )
        .catch(() => { /* ignore */ })
      return
    }
    // AI 生成会话标题（第一轮对话总结）：更新列表标题（手动命名的不覆盖）
    if (p.type === 'host/session-renamed') {
      conversationsStore.applyTitle(String(p.sessionId), String(p.title))
      return
    }
    // LLM 重试过程块（后端 createStreamFn 建立阶段失败/恢复时经 session/projection 下发）
    if (p.type === 'session/projection' && p.key === 'llm-retry') {
      piChatStore.handleLlmRetry(String(p.sessionId), p.value || {})
      return
    }
    /* ★0927（①b）：**未读推送** —— 后端整轮收尾时按权威口径（lastReadAt 之后的新回复数）经全局桶下发。
       不再只靠 agent_end 事件帧在本地 +1（丢帧/组件没挂载/刚重连/人在别的窗口，角标都会漏）。
       ⚠️ 但**正在看的这条会话不能算未读**：后端这句推送发在 markRead 之后（同一个 agent_end 里），
       会把"用户正在看"的会话又覆盖成未读 ⇒ 实测"读完切回来，发现还挂着未读"。
       所以：当前打开的会话 → 直接标已读（并补一次 markRead 把后端口径对齐），不当成未读。 */
    if (p.type === 'session/projection' && p.key === 'unread') {
      const sid = String(p.sessionId)
      const n = Number(p.value?.unread) || 0
      if (sid && sid === String(conversationsStore.activeConversationId || '')) {
        if (n > 0) conversationsStore.markRead(sid)
        return
      }
      const conv = conversationsStore.getById(sid)
      if (conv) conv.unread = n
      return
    }
    // 上下文压缩内联通知（后端 createStreamFn 压缩时经 session/projection 下发）
    if (p.type === 'session/projection' && p.key === 'context-compaction') {
      piChatStore.handleContextNotice(String(p.sessionId), p.value || {})
      return
    }
    // 0908七：系统收尾提示（工具轮次上限等）→ 内联 notice
    if (p.type === 'session/projection' && p.key === 'session-notice') {
      piChatStore.handleSessionNotice(String(p.sessionId), p.value || {})
      return
    }
    // 0909⑦：排队账本快照（后端权威，多窗口同步）→ 覆盖本地镜像
    if (p.type === 'session/projection' && p.key === 'queue') {
      queueStore.set(String(p.sessionId), (p.value?.queue || []) as any)
      /* ★0927 N1：暂停态（乙）随同一帧下发 —— 多窗口一致（后端权威，不持久化，重启即恢复 continue） */
      queueStore.setPaused(String(p.sessionId), p.value?.paused === true)
      return
    }
    /* ★0927 N1（丙）：停止时队里唯一一条被后端退回 → 回灌本窗口编辑器（内容不丢、可改）。
       依据 pi 官方 TUI 的 Esc 语义（clearQueue → 放回编辑器 → abort）；只做当前打开的那条会话。 */
    if (p.type === 'session/projection' && p.key === 'queue-return-to-editor') {
      const sid = String(p.sessionId || '')
      if (sid && sid === String(props.conversation?.id ?? '')) {
        const item = p.value?.item
        if (item) void restoreQueueItemToEditor(item as any, false)
      }
      return
    }
    // 0909⑦：排队消息已发出（后端 flush）→ 清掉对应乐观标记（若本地有）
    if (p.type === 'session/projection' && p.key === 'queue-sent') {
      const cmid = String(p.value?.clientMessageId || '')
      if (cmid) {
        const list = piChatStore.getNodes(String(p.sessionId))
        const n = list.find(x => x.key === cmid)
        if (n) n.steerPending = false
      }
      return
    }
    // 0909⑦：插话已注入（steer-ack）→ 清乐观标记
    if (p.type === 'session/projection' && p.key === 'steer-ack') {
      const cmid = String(p.value?.clientMessageId || '')
      if (cmid) {
        const list = piChatStore.getNodes(String(p.sessionId))
        const n = list.find(x => x.key === cmid)
        if (n) n.steerPending = false
      }
      return
    }
    // 计划本（plan_write 工具写入）：实时更新当前会话计划卡
    if (p.type === 'session/plan') {
      const c = conversationsStore.getById(String(p.sessionId))
      if (c) {
        c.plan = p.items || []
        // 0910 三批①：黑板计划独立字段（原先与主计划共用同一字段互相覆盖 → 计划面板串台）
        c.boardPlan = p.boardItems || []
      }
      return
    }
    /* ★0927（实测"压缩后界面还挂着压缩前的旧正文"）：后端压缩成功广播 session/compacted
       → **强制重建**该会话视图（折叠掉的旧消息必须从界面消失，只留摘要 + 最近几轮）。
       只对"当前正在看的会话"立即重建；后台会话等切过去时由 reconcileOnFocus 兜（省无谓重渲染）。
       （流式进行中会延后到本轮结束，见 conversations.reloadConversationAfterCompaction） */
    if (p.type === 'session/compacted') {
      const sid = String(p.sessionId || '')
      if (sid && sid === String(conversationsStore.activeConversationId ?? '')) {
        void conversationsStore.reloadConversationAfterCompaction(sid)
      }
      return
    }
    // 会话运行状态（agent_start/agent_end）：同步会话列表 replying 动画 + 当前会话按钮�?    // finalizeStreaming / usage/timing 记录对全会话执行（切走后原会话的流式节点也要定稿、胶囊数据按会话隔离�?
if (p.type === 'session/status') {      const sid = String(p.sessionId)
      conversationsStore.setReplying(sid, !!p.running)
      if (!p.running) {
        // agent 结束：定稿残�?streaming 节点（abort 中断的节点不再保�?Think 动画/串到下一轮）
        // T3（0928）收尾单一化：仅真实终态帧（agentEnd/aborted/stopped）才定稿流式节点，
        // 其余 running:false 子事件帧一律不落态（防"回复还在跑就显示已完成"）
        // ★1004：自然收轮（agentEnd）不定稿后台分身（spawn_clone 还在跑，别造"假完成"）；
        //   用户主动停止（aborted/stopped）连分身一起定稿（中止级联已杀它们）。
        if ((p as any).agentEnd || (p as any).aborted || (p as any).stopped) piChatStore.finalizeStreaming(sid, { finalizeClones: !!((p as any).aborted || (p as any).stopped) })
        /* ★0927：本轮结束 → 补上"流式中被延后的压缩重建"（有待办才动，零开销）。
           没有这一处，自动压缩撞上正在流的回合时，界面要等用户切走再切回才刷新。 */
        if (sid === String(conversationsStore.activeConversationId ?? '')) {
          void conversationsStore.flushPendingCompactionReload(sid)
        }
        // 0914b（设置→提示接线）：回合完成 → 开关开着就弹系统通知 + 提示音（不再区分窗口可见性）
        // 0914c 双通知修复（两个来源一起防）：
        //  ① session/status 帧经会话流+全局流双到达（后端镜像）→ 同一次完成被处理两遍；
        //     音效/系统通知是非幂等副作用 → 按会话 1.5s 窗口去重（与上面 agent seq 去重同思路）。
        //  ② 通道会话（QQ/微信来源）的回推完成由 host/channel-reply 单独通知（带内容预览）→
        //     这里跳过 agent 通知，避免「已完成回复 + 机器人回复」两条重复提醒。
        const notifiedAt = lastTurnNotifyAt.get(sid) || 0
        const turnOrigin = conversationsStore.getById(sid)?.origin
        const isChannelSession = turnOrigin === 'qq' || turnOrigin === 'wechat'
        // T3（0928）收尾单一化：「已完成回复」通知只绑真实 agent_end 帧（p.agentEnd）——
        // 用户自停 stopped / 无标记子事件帧一律不弹
        if ((p as any).agentEnd && !isChannelSession && Date.now() - notifiedAt > 1500) {
          /* ★1010 通知收窄（反馈：派分身的短报回合也弹系统通知，嫌吵）——只在「用户需要看」的时刻弹：
             ① 回合结束但后台分身/run 还在跑（spawn_clone detached），或队列里还有排队消息
             = 干活中途的短报（「派出分身…」类）→ 不弹；分身场景记一笔欠账（补弹见 session/subagent-event 终帧）；
             ② 排队场景不记欠账：链上最后一回合收尾（队列空）时自然正常弹。
             回合真正完成/审批卡/询问卡的提醒路径全部不动；未读红点/侧栏预览/标题等消费方不涉及。 */
          // 0920（反馈）：系统提醒要「显示对话名 + AI 回复摘要」。
          // 对话名优先用后端帧里的权威值，再退本地列表；摘要优先用后端随 status 帧带来的，拿不到退回本地节点。
          const convTitle = String((p as any).sessionTitle || conversationsStore.getById(sid)?.title || '')
          const replySummary = String((p as any).replyPreview || '') || lastReplySummary(sid)
          // 后台还有活在跑：分身/run 仍在 running，或队列还有排队消息（回合链没走完）
          const bgRunning = piChatStore.getNodes(sid).some((n: any) => n.subAgent && n.subAgent.status === 'running')
          const moreQueued = (queueStore.get(sid) || []).length > 0
          if (bgRunning || moreQueued) {
            // 干活中途的短报：不弹（★1010 已定案：分身干完也不弹，只主 agent 真完成才弹）
          } else {
            // 真正收尾：正常提醒
            lastTurnNotifyAt.set(sid, Date.now())
            void import('@/utils/systemNotify')
              .then((m) => {
                // 0914b（用户反馈：看着窗口也收不到提醒）→ 不再区分可见性：开关开着就弹系统通知 + 提示音
                return m.notifySystem({
                  category: 'agent',
                  title: convTitle || ((p as any).aborted || (p as any).loopBreak ? t('sysNotify.agentInterrupted') : t('sysNotify.agentTitle')),
                  // 桌面通知没有按钮（插件不支持），所以正文末尾给出可点提示：点整条即直达该会话
                  message: replySummary
                    ? `${replySummary} · ${t('sysNotify.clickToView')}`
                    : ((p as any).aborted || (p as any).loopBreak ? t('sysNotify.agentInterruptedHint') : t('sysNotify.agentDoneHint')),
                  // 0914c：点击系统通知 → 直达对应对话窗口（通道通知不带 sessionId，QQ/微信无需跳转）
                  sessionId: sid,
                })
              })
              .catch(() => { /* ignore */ })
          }
        }
      }
      /* ★1004m：计时起停对**任意会话**生效（per-conv 键控）——只处理当前会话的话，
         切走期间结束的会话计数没人清、永远涨（泄漏）。 */
      if (p.running) { if (turnSecondsOf(sid) == null) startTurnTimer(sid); void syncTurnFromBackend(sid) }
      else stopTurnTimer(sid)
      if (sid === String(props.conversation?.id)) {
        if (p.running) {
          isGenerating.value = true
        } else {
          isGenerating.value = false
          if (generateTimeout.value) clearTimeout(generateTimeout.value)
          if (p.aborted) {
            // 中断轮（用户点停止）：usage/timing 无权威数据（流切在 usage 块之前）——
            // 不覆盖统计（防旧 usage + 中断时刻 timing 混搭稀释 tok/s），只拉上下文占用
            refreshContextUsage()
          } else {
          // 记录真实 usage/timing（StatsLine 展示；仅当前会话；全零 usage 不覆盖旧数据——工具轮次/网关未上报时保留上一轮真实值）
          const genModel = p.model || selectedModel.value
          if (genModel) {
            if (p.usage && (p.usage.promptTokens || p.usage.completionTokens || p.usage.cacheReadTokens || p.usage.cacheWriteTokens)) {
              modelStats.value[genModel] = { timing: p.timing, usage: p.usage }
            } else if (p.timing && p.timing.llmMs) {
              modelStats.value[genModel] = { timing: p.timing, usage: modelStats.value[genModel]?.usage }
            }
            if (!usedModels.value.includes(genModel)) usedModels.value.push(genModel)
          }
          // 挂到 piChat 节点：本轮 turn 的 assistant 节点悬停展示用时/首 token/tok/s（每轮独立）
          if (p.timing) piChatStore.attachTurnMeta(sid, p.timing, p.usage)
          // 拉取真实上下文占用（模型 maxContext 上限 + transcript token 估算�?
          refreshContextUsage()
          }
        }
      }
      return
    }
  }
  if (msg.type === 'WORKSPACE_LIST') {
    // 后端推送工作区文件树（项目级：project_id 指定到具体项目）
    if (Array.isArray(msg.files)) {
      workspaceStore.setFiles(msg.files, String(msg.project_id || props.conversation?.project_id || ''))
    }
  } else if (msg.type === 'WORKSPACE_FILE') {
    // 后端返回文件内容，写入工作空间缓?
	if (msg.name) {
      workspaceStore.setFileContent(msg.name, msg.type === 'image' ? 'image' : 'html', msg.content || '')
    }
  } else if (msg.type === 'HITL_REQUEST') {
    const aiMsg = messages.value.find(m => m.type === 'ai' && m.status === 'done')
    if (aiMsg) {
      if (!aiMsg.blocks) aiMsg.blocks = []
      aiMsg.blocks.push({
        type: 'permission_prompt',
        request_id: msg.request_id,
        question: msg.question,
        options: msg.options,
        tool: msg.tool,
        risk: msg.risk || 'medium'
      })
    }
  } else if (msg.type === 'QUESTION') {
    const aiMsg = messages.value.find(m => m.type === 'ai' && m.status === 'done')
    if (aiMsg) {
      if (!aiMsg.blocks) aiMsg.blocks = []
      aiMsg.blocks.push({
        type: 'ask_user',
        request_id: msg.request_id,
        question: msg.question,
        options: msg.options,
        placeholder: msg.placeholder
      })
    }
  } else if (msg.type === 'DAG_UPDATE' || msg.type === 'PARTNER_WORK_PROGRESS') {
    // nis_brain 协作事件：pi-bridge 不再产生，忽略
  } else if (msg.type === 'PARTNER_TASK_START') {
    // 旧伙伴协作事件，忽略
  } else if (msg.type === 'PARTNER_REASONING') {
    // 旧伙伴推理事件，忽略
  } else if (msg.type === 'AI_REPLY_DONE' || msg.type === 'CHAT_RESPONSE') {
    // �?AI 回复完成事件（pi-bridge �?message_updated expectFinal 收尾），忽略
  } else if (msg.type === 'text') {
    // 旧内联通知（nis_brain 专属），忽略
  }
}

chatStore.onMessage(handleWebSocketMessage)
/* ★0929：流重连即清 seq 去重窗 —— 后端重启后服务端 agentEventSeq 从 0 重新计数，
   本地残留的旧序号（8s 窗内）会把重启后的头几帧误判成"重复帧"直接丢掉
   （表现=刷新后开头几秒思考/正文不长）。重连＝新纪元，去重窗必须跟着归零。 */
chatStore.onResync(() => { recentAgentSeqs.clear() })

const props = defineProps<{
  conversation?: Conversation
}>()

const emit = defineEmits<{
  back: []
}>()

const conversationsStore = useConversationsStore()
const notificationsStore = useNotificationsStore()

/** 读用户设置（0 = 不超时）。settingsStore 在本文件后段声明 —— 本函数只在事件回调里执行，无 TDZ 问题。 */
function questionTimeoutMs(): number {
  const sec = Number((settingsStore as any)?.general?.questionTimeoutSec ?? 180)
  if (!Number.isFinite(sec) || sec <= 0) return 0
  return Math.round(sec * 1000)
}
let _qTimeoutTimer: ReturnType<typeof setTimeout> | undefined
let _qTimeoutKey = ''

function cancelQuestionTimeout() {
  if (_qTimeoutTimer) { clearTimeout(_qTimeoutTimer); _qTimeoutTimer = undefined }
  _qTimeoutKey = ''
}

/** 武装"问题卡超时"：询问卡一进来就开始计时 */
function armQuestionTimeout(sid: string, requestId: string, question: string) {
  cancelQuestionTimeout()
  const ms = questionTimeoutMs()
  if (!ms) return   // 用户选了「不超时」
  _qTimeoutKey = `${sid}::${requestId}`
  _qTimeoutTimer = setTimeout(() => {
    const key = _qTimeoutKey
    _qTimeoutTimer = undefined
    _qTimeoutKey = ''
    if (!key) return
    // 用户始终没答 → 按「忽略」提交：AI 侧收到"用户跳过了这个问题"，不会一直挂着等
    try { chatStore.sendQuestionAnswer(requestId, '__ignored__', sid) }
    catch (e) { swallowed('超时自动应答没能提交给后端（卡片已关，但后端可能一直挂着等你答）', e, 1) }
    /* ★0927：这是**前端自己的超时**（不是别的窗口答的）→ 打个标记，避免结算帧把它写成
       「已在其他窗口应答」；卡片文案统一显示「已超时·未应答」。 */
    try { piChatStore.markAnsweredByUser(requestId) } catch { /* ignore */ }
    try { piChatStore.answerAside(sid, requestId, t('chat.answeredTimeout')) } catch { /* ignore */ }
    // 卡片关掉（输入框位置恢复给正常输入）
    try { conversationsStore.setPendingInteraction(sid, null) } catch { /* ignore */ }
    // ① 软件内通知中心（常驻铃铛，不受系统提示开关门控）
    try {
      notificationsStore.pushSystem({
        title: t('sysNotify.questionTimeoutTitle'),
        message: String(question || '').slice(0, 120) || t('sysNotify.questionTimeoutBody'),
        level: 'warn',
        category: 'permission',
        sessionId: sid,
      })
    } catch { /* ignore */ }
    // ② Windows 系统通知（受设置→提示「审批」开关门控）
    void import('@/utils/systemNotify')
      .then((m) => m.notifySystem({
        category: 'permission',
        title: t('sysNotify.questionTimeoutTitle'),
        message: String(question || '').slice(0, 90) || t('sysNotify.questionTimeoutBody'),
        sessionId: sid,
      }))
      .catch(() => { /* ignore */ })
  }, ms)
}
const partnersStore = usePartnersStore()
const settingsStore = useSettingsStore()
const queueStore = useQueueStore()
const providersStore = useProvidersStore()
const tasksStore = useTasksStore()
const procsStore = useProcsStore()
/** ★ 0922e：进程监控弹窗（铃铛左侧按钮点开；打开时拉一次全量） */
const procOpen = ref(false)
function openProcs(): void { procOpen.value = true; void procsStore.sync() }
/** /bg-demo 的自动收尾定时器（60s 后把预览数据撤掉） */
let bgDemoTimer: ReturnType<typeof setTimeout> | null = null

// ── 后台任务：胶�?tab 切换（null = 原对话，�?null = 该任务的后台视图�?──
const activeTaskId = ref<string | null>(null)
const activeTask = computed(() =>
  activeTaskId.value ? tasksStore.getTask(activeTaskId.value) || null : null,
)
const bgTasksForConv = computed(() =>
  props.conversation?.id != null ? tasksStore.tasksForConversation(props.conversation.id) : [],
)

const bgInput = ref('')

/** ★ 0922 D：任务详情弹窗（查看不再切全屏视图） */
const bgModalId = ref<string | null>(null)
function selectBgTab(taskId: string | null) {
  activeTaskId.value = taskId
}
/** ★ 0922 D 批次：查看改成**弹窗**（设计口径）—— 不再切全屏"任务视图"
 *  （那套是复用聊天气泡的对话式记录，内容冗余）。旧视图代码保留，已无入口。 */
function openBgTask(taskId: string) {
  bgModalId.value = String(taskId)
}
function removeBgTask(taskId: string) {
  tasksStore.closeTask(taskId)
  if (activeTaskId.value === taskId) activeTaskId.value = null
}
const bgDoneSteps = computed(
  () => activeTask.value?.steps.filter(s => s.status === 'done').length || 0,
)
const bgProgressPct = computed(() => {
  const t = activeTask.value
  if (!t || !t.steps.length) return 0
  return Math.round((t.steps.filter(s => s.status === 'done').length / t.steps.length) * 100)
})
const bgStatusLabel = computed(() => {
  const m: Record<string, string> = {
      // background: '后台运行中',
      // paused: '已暂停',
      // completed: '已完成',
      // cancelled: '已取消',
      // failed: '执行失败',
  }
  return activeTask.value ? m[activeTask.value.status] || activeTask.value.status : ''
})
function sendBgMessage() {
  const t = activeTask.value
  const text = bgInput.value.trim()
  if (!t || !text) return
  bgInput.value = ''
  tasksStore.appendRecord(t.task_id, { senderKey: 'user', content: text, kind: 'user' })
  setTimeout(() => {
    if (tasksStore.getTask(t.task_id)) {
      // tasksStore.appendRecord(t.task_id, { senderKey: 'Nis', content: `收到，已把「${text}」交给后台任务继续处理。`, kind: 'ai' })
    }
  }, 900)
}

// 后台任务记录：细分明细展开
const expandedRecs = ref<Record<string, boolean>>({})
function toggleRec(rec: { id: string }) {
  expandedRecs.value[rec.id] = !expandedRecs.value[rec.id]
}

// 后台任务记录的过程块（与原对话过程块一致：loader + 文案 + 计时 + 可展开）

// 后台任务记录的过程块（与原对话过程块一致：loader + 文案 + 计时 + 可展开�?
  const BG_PROCESS_META: Array<{ key: string; label: string; loader: Component; size?: number }> = [
  { key: 'thinking', label: 'Thinking', loader: ThinkLoader, size: 20 },
      // { key: 'search', label: '搜索', loader: SearchLoader },
      // { key: 'tools', label: '工具调用', loader: ToolLoader, size: 16 },
      // { key: 'write', label: '正在写入', loader: CodeLoader },
      // { key: 'review', label: '代码审查', loader: CellLoader },
]
// 过程块展开状�?+ 秒级跳动（计时用�?
const bgTick = ref(0)
let timerInterval: ReturnType<typeof setInterval> | null = null
const expandedProcess = ref<Record<string, boolean>>({})
function toggleProcess(rec: { id: string; processStates?: Record<string, 'active' | 'done'> }, key: string) {
  const k = rec.id + '_' + key
  expandedProcess.value[k] = !isProcessOpen(rec, key)
}
// 进行中的过程默认展开，完成后折叠；手动切换后以手动为�?
function isProcessOpen(rec: { id: string; processStates?: Record<string, 'active' | 'done'> }, key: string): boolean {
  const k = rec.id + '_' + key
  if (k in expandedProcess.value) return !!expandedProcess.value[k]
  return rec.processStates?.[key] === 'active'
}
const BG_DONE_DURATION: Record<string, string> = {
  thinking: '12s',
  search: '3.2s',
  tools: '8s',
  write: '25s',
  review: '5s',
}
// 过程块计时：active 实时走秒（依�?
      // bgTick 触发重渲染），done 显示固定耗时
function bgProcessDuration(rec: { ts: number; processStates: Record<string, 'active' | 'done'> }, key: string): string {
  void bgTick.value
  const st = rec.processStates[key]
  if (st === 'active') {
    const sec = Math.max(0, Math.floor((Date.now() - rec.ts) / 1000))
    return sec + 's'
  }
  return BG_DONE_DURATION[key] || t('chat.completed')
}

// 切换会话时回到「原对话」视图（后台任务 tab 是每个会话各自的�?
watch(() => props.conversation?.id, () => {
  activeTaskId.value = null
})

// ── 内联通知（旧 nis_brain 专属，已移除�?──

// 伙伴/普�?AI 回复流式：新消息（带 blocks）出现时最后一块流式，一段时间后 settle 成最终形�?
const msgStreaming = ref<Record<number, boolean>>({})
let msgStreamTimer: ReturnType<typeof setTimeout> | null = null
function startMsgStream(id: number, durationMs: number) {
  msgStreaming.value[id] = true
  if (msgStreamTimer) clearTimeout(msgStreamTimer)
  msgStreamTimer = setTimeout(() => {
    msgStreaming.value[id] = false
  }, durationMs)
}
function estimateStreamMs(msg: { blocks?: Array<{ content: string }> }): number {
  const total = (msg.blocks || []).reduce((s, b) => s + (b.content?.length || 0), 0)
  return Math.min(2500, Math.max(900, total * 55))
}

const workspaceStore = useWorkspaceStore()
const browserStore = useBrowserStore()

const agentPresetsStore = useAgentPresetsStore()
const teamsStore = useTeamsStore()
/** 空对话暂存的 Agent 预设选择（新会话创建时定型）。
 *  初始=设置里的「新会话默认预设」；不持久化临时选择（0904 决策3：默认值归设置管，localStorage 记住上次属于兜底乱源） */
const selectedPresetId = ref(agentPresetsStore.defaultPresetId)
/** 工作模式：preset=�?Agent 预设；team=团队协作 */
const selectedMode = ref<'preset' | 'team' | 'external'>('preset')   // ★1001 四批：外部 agent 独立类别
const selectedTeamId = ref('')
const modeMenuOpen = ref(false)
const pickerMenuOpen = ref(false)
/* 预设弹层：**最多露 5 条**（产品要求），其余滚动；高度再按触发按钮上/下方的真实剩余空间夹一次，
   保证任何窗口高度都不顶出屏幕。行高与模板里的 `h-[46px]` 必须一致。 */
const PICKER_ROW_H = 46
const PICKER_MAX_ROWS = 5
const PICKER_PAD = 16 // 容器 py-2
const pickerMenuUp = ref(true)
const pickerMenuMaxH = ref(PICKER_MAX_ROWS * PICKER_ROW_H + PICKER_PAD)
function togglePickerMenu(e: MouseEvent) {
  if (pickerMenuOpen.value) { pickerMenuOpen.value = false; return }
  const r = (e.currentTarget as HTMLElement | null)?.getBoundingClientRect()
  if (r) {
    const above = Math.max(0, r.top - 10)
    const below = Math.max(0, window.innerHeight - r.bottom - 10)
    const up = above >= 160 || above >= below
    pickerMenuUp.value = up
    // 先按"5 条"限，再按可用空间夹 —— 两者取小，绝不溢出
    pickerMenuMaxH.value = Math.round(Math.min(PICKER_MAX_ROWS * PICKER_ROW_H + PICKER_PAD, up ? above : below))
  }
  pickerMenuOpen.value = true
}
const modeMenuRef = ref<HTMLElement | null>(null)
const pickerMenuRef = ref<HTMLElement | null>(null)

const currentPickerLabel = computed(() => {
  if (selectedMode.value === 'team') {
    return teamsStore.teams.find(t => t.id === selectedTeamId.value)?.name || t('chat.selectTeam')
  }
  /* ★1001 五批：外部类别只认外部预设（选中项不在外部清单里=回落最靠前的外部预设；绝不显示内置预设名） */
  if (selectedMode.value === 'external') {
    const list = externalPresetOptions.value
    return presetDisplayName(list.find(p => p.id === selectedPresetId.value)) || presetDisplayName(list[0]) || t('chat.selectPreset')
  }
  return presetDisplayName(agentPresetsStore.presets.find(p => p.id === selectedPresetId.value)) || t('chat.selectPreset')
})

/** 会话标题右侧的模式名：当前会话绑定的预设/团队名；空白会话显示暂存的选择 */
const currentPresetName = computed(() => {
  const conv = props.conversation
  // 团队会话：显示团队名
  const teamId = conv?.teamId || (selectedMode.value === 'team' && !conv?.presetId ? selectedTeamId.value : '')
  if (teamId) {
    const t = teamsStore.teams.find(x => x.id === teamId)
    if (t) return t.name
    return conv?.teamId ? (t?.name || '') : ''
  }
  // 预设名按会话隔离（0904 bug4）：已有对话恒读它自己的 presetId（后端真实数据，列表映射回填）；
  // 只有还没建对话的空态才显示暂存选择。禁止「缺 presetId 就拿全局临时值凑」——那正是串台根源。
  const pid = conv?.id != null ? conv.presetId : selectedPresetId.value
  if (!pid) return ''
  return presetDisplayName(agentPresetsStore.presets.find(p => p.id === pid))
})

function switchMode(mode: 'preset' | 'team' | 'external') {
  selectedMode.value = mode
  modeMenuOpen.value = false
  if (mode === 'team') teamsStore.load()
  if (mode === 'external') {
    agentPresetsStore.load()   // 外部类别=已安装的外部预设（装完才有的清单，拉最新）
    /* ★1001 五批：进外部类别=自动落在「安装位置最靠前」的外部预设上（不能显示内置的"标准模式"——
       那不属于外部 agent；没装任何外部 agent 时入口本身禁用，进不来）。 */
    const first = agentPresetsStore.presets.find(p => p.engine && p.engine !== 'native')
    if (first) selectedPresetId.value = first.id
  }
}
/* ★1001 四批：选择下拉的内容——外部类别只列外部预设（带它产品 logo 头像） */
const externalPresetOptions = computed(() => agentPresetsStore.presets.filter(p => p.engine && p.engine !== 'native'))
const hasExternalPresets = computed(() => externalPresetOptions.value.length > 0)
const pickerPresetOptions = computed(() =>
  selectedMode.value === 'external' ? externalPresetOptions.value : agentPresetsStore.presets.filter(p => !(p.engine && p.engine !== 'native'))   // ★1001 五批：Agent 预设清单不含外部（两类彻底分家）
)

/* ── 成员单聊（0904 批次：@成员 1:1 对话）──
 * 团队会话的工具栏出现成员选择器；选中后输入进入"单聊目标"模式：发送走 session.memberPrompt
 * （直连成员、不经主 agent、不动黑板），成员回复以现有 subAgent 气泡呈现；再点选同一成员延续其历史。
 * 空白会话/非团队会话不显示该按钮（行为完全不变）。 */
const dmTarget = ref<{ id: string; name: string } | null>(null)
/** 当前会话所属团队的成员清单（含展示名）；非团队会话返回空数组 */
const currentTeamMembers = computed(() => {
  const teamId = props.conversation?.teamId
  if (!teamId) return [] as Array<{ id: string; name: string; role: string; avatar: string }>
  const t = teamsStore.teams.find(x => x.id === teamId)
  if (!t) return []
  return t.members.map(m => {
    const preset = agentPresetsStore.presets.find(p => p.id === m.preset)
    return {
      id: m.id,
      name: preset?.name || m.preset,
      role: String(m.role || preset?.description || '').slice(0, 60),
      // 0913 头像批：@成员选择器里同步显示成员预设头像（未设置 → 空串，组件回退默认样式）
      avatar: agentPresetsStore.avatarOf(m.preset) || '',
    }
  })
})
/** 切换会话：单聊目标属于具体会话，换会话即清除（防串会话） */
watch(() => props.conversation?.id, () => { dmTarget.value = null })
function pickDmMember(m: { id: string; name: string }) {
  dmTarget.value = m
}
// 团队数据全局预载：刷新后徽标/成员按钮立即有数据（不能等用户打开 AgentModal 才 load）
if (teamsStore.teams.length === 0) void teamsStore.load()

function pickPreset(id: string) {
  selectedPresetId.value = id
  presetPickTouched = true
  pickerMenuOpen.value = false
}
// store 异步加载完成后默认预设才准：用户没手动选过就跟一次真实默认（避免 setup 时读到未初始化的 'standard'）
let presetPickTouched = false
watch(() => agentPresetsStore.defaultPresetId, (v) => { if (!presetPickTouched && v) selectedPresetId.value = v })
/* 0919 修：打开一条会话时，把底部的预设选择器同步成**这条会话自己的预设**。
   以前选择器恒读 selectedPresetId（它只服务"空对话的暂存选择"），于是打开「导入助手」这类
   带专属预设的会话时，底部仍显示上一个预设 —— 实测："agent 预设没自动切换成导入助手"。
   （会话标题右侧的 currentPresetName 一直是对的，因为它读的是 conv.presetId，两处数据源不一致。） */
watch(() => props.conversation?.id, () => {
  const pid = props.conversation?.presetId
  if (pid) {
    selectedPresetId.value = pid
    presetPickTouched = true
  }
}, { immediate: true })
function pickTeam(id: string) {
  selectedTeamId.value = id
  pickerMenuOpen.value = false
}
function handlePickerOutside(e: MouseEvent) {
  if (modeMenuRef.value && !modeMenuRef.value.contains(e.target as Node)) modeMenuOpen.value = false
  if (pickerMenuRef.value && !pickerMenuRef.value.contains(e.target as Node)) pickerMenuOpen.value = false
}
const chatInputRef = ref<InstanceType<typeof ChatInput> | null>(null)

/* 预览/固定视图切出时，对话模板被 v-if 整块卸载，contenteditable DOM 随之丢弃 →
   输入框内容消失。这里在卸载前把编辑器状态（HTML + store 标签项）按会话存起来，
   切回对话视图后恢复。watch 默认 flush:pre 在 DOM 更新前执行，保存时 ChatInput 还挂载着；
   恢复要等新 ChatInput 挂载完成，故放 nextTick。发送清空输入框后切出时 HTML 为空，
   会清掉缓存，避免已发送内容串回输入框。 */
const editorStateByConv = new Map<string, { html: string; items: any[] }>()
/* 0910 反馈2：草稿（未发送的新对话）内容不能丢。
   背景：新建对话不建会话（draft、activeConversationId=null），编辑器内容只活在 contenteditable DOM 里，
   切会话/切视图/刷新都会没。用户场景="开新窗口粘贴一大段提示词"，丢了就得重粘。
   方案：①草稿编辑器内容按内容变化即时暂存（下 key=''）②额外写 sessionStorage（按窗口隔离，
   刷新/切视图都在，新窗口是干净的一份）③发送成功即清（避免发出去的内容再冒回输入框）。 */
const DRAFT_STASH_KEY = 'nis-draft-editor'
function readDraftStash(): { html: string; items: any[] } | null {
  try {
    const raw = sessionStorage.getItem(DRAFT_STASH_KEY)
    if (!raw) return null
    const v = JSON.parse(raw)
    return v && typeof v.html === 'string' && v.html ? { html: v.html, items: Array.isArray(v.items) ? v.items : [] } : null
  } catch { return null }
}
function writeDraftStash(st: { html: string; items: any[] } | null) {
  try {
    if (st?.html) sessionStorage.setItem(DRAFT_STASH_KEY, JSON.stringify(st))
    else sessionStorage.removeItem(DRAFT_STASH_KEY)
  } catch { /* 隐私模式/配额满：静默降级（内存缓存仍在） */ }
}
function clearDraftStash() {
  /* ★ 0920 修「导入引导词发出去后，输入框里又冒出这段文案」（实测）：
     这里以前只清"空会话草稿"那个桶（key=''），但**导入引导词是挂在真实会话 id 下的**
     （applyPrefill → stashEditorState 存进 editorStateByConv.get(convId)）。
     发送时 clearEditor() 清了 DOM，随后"空会话→有消息"会让 ChatInput 换实例，
     watch(chatInputRef) 立刻 restoreEditorState() → 把这条会话的旧草稿（就是那段引导词）捞回输入框。
     所以：**发送时连当前会话的草稿一起清**，并顺手把还没落地的预置文案也作废。 */
  const convId = String(props.conversation?.id ?? '')
  editorStateByConv.delete('')
  editorStateByConv.delete(convId)
  writeDraftStash(null)
  pendingPrefillText = ''
  pendingPrefillConvId = ''
}
/** 当前编辑器里的内容（无内容返回 null） */
function grabEditorState(): { html: string; items: any[] } | null {
  const st = chatInputRef.value?.getEditorState()
  return st && st.html ? st : null
}
/** 暂存当前编辑器内容（草稿同时落 sessionStorage） */
function stashEditorState() {
  const convId = String(props.conversation?.id ?? '')
  const st = grabEditorState()
  if (st) {
    editorStateByConv.set(convId, st)
    if (convId === '') writeDraftStash(st)
  } else {
    editorStateByConv.delete(convId)
    if (convId === '') writeDraftStash(null)
  }
}
/* ★ 0924（反馈"输入框有内容时，出现询问卡/权限卡内容就没了"）：
   待处理卡片是**替换输入框**渲染的（模板里 v-if/v-else-if/v-else 链，permission / question 各一支），
   卡片一出现 ChatInput 就被卸载 → contenteditable DOM 连同内容一起销毁。
   这里在卡片出现前先 stash；卡片消失后 ChatInput 重新挂载，watch(chatInputRef) 会自动 restore
   —— 与"切预览视图再回来"走的是同一条通路，不额外造机制。 */
watch(() => pendingCard.value?.kind || '', (kind, old) => {
  if (kind && !old) stashEditorState()
})
/* ★0930（答题卡卡死同族修）：**补挂出来的询问卡也要武装超时** —— 计时原来只在实时帧
   （session/question）处理里武装；卡若是"切回来/重连对账"时按 pendingQuestions 补挂的，
   就没人计时：人不在/没注意时 ask_user 会一直挂到后端 10 分钟超时才继续（实测 600s）。
   这里按"当前询问卡的 requestId 变化"武装一次，与实时帧路径同款计时（幂等，同卡不重复武装）。 */
watch(() => pendingCard.value?.kind === 'question' ? String((pendingCard.value?.block as any)?.request_id || '') : '', (rid, old) => {
  if (!rid || rid === old) return
  const convId = String(props.conversation?.id ?? '')
  if (!convId) return
  armQuestionTimeout(convId, rid, String(pendingCard.value?.block?.question || ''))
})
/** 恢复编辑器内容：目标编辑器必须为空（不然会覆盖用户正在打的字） */
function restoreEditorState() {
  const convId = String(props.conversation?.id ?? '')
  const st = editorStateByConv.get(convId) || (convId === '' ? readDraftStash() : null)
  if (!st?.html) return
  nextTick(() => {
    if (!chatInputRef.value) return
    const cur = chatInputRef.value.getEditorState()
    if (cur?.html) return
    chatInputRef.value.setEditorState(st)
  })
}
/* 0918：外部预置「整段文案」（如设置里「导入其他 agent 数据」的引导词）。
   编辑器已有内容时**不覆盖**（别冲掉用户草稿）。
   0919 修：① 消费时带上**当前会话 id**，不匹配就留着（否则会漏到别的对话里）；
           ② 文案可能在会话已经打开之后才挂上（设置里的导入流程是异步建完会话再 requestPrefill），
              所以再加一个 store 监听，不再只依赖"切换那一刻"；
           ③ ★ **写完必须回读校验**（复测仍为空，真根因就在这）：空态↔会话是**两套 ChatInput 实例**，
              `conversation.id` 的 watch 在 DOM 更新**之前**触发，此刻 chatInputRef 还指向**即将被卸载的旧实例**，
              insertText 写进去 → 组件一卸载 DOM 全丢 → 输入框看着还是空的。以前"写没写进去"全凭运气，
              所以偶尔能成（新会话仍是空态布局、分支没换、实例没重挂时就成）。现在写不进就重试。 */
let pendingPrefillText = ''
let pendingPrefillConvId = ''
function applyPrefill(tries = 0) {
  const convId = String(props.conversation?.id ?? '')
  const incoming = chatStore.consumePrefill(convId)
  if (incoming) { pendingPrefillText = incoming; pendingPrefillConvId = convId }
  if (!pendingPrefillText) return
  // 目标不是当前这条会话 → 先留着，等切到它再落（别插到别的对话里）
  if (pendingPrefillConvId !== convId) return
  const text = pendingPrefillText
  nextTick(() => {
    const el = chatInputRef.value
    if (!el) {
      if (tries < 60) setTimeout(() => applyPrefill(tries + 1), 80)
      return
    }
    const cur = el.getEditorState()
    if (cur?.html) { pendingPrefillText = ''; pendingPrefillConvId = ''; return }
    el.insertText(text)
    // 回读校验：实例若已换代，这次写入是白写的 → 下一轮重试（新实例挂好后自然成功）
    nextTick(() => {
      if (String(props.conversation?.id ?? '') !== convId) return // 又切走了，交给下一次
      if (chatInputRef.value?.getEditorState()?.html) {
        /* ★ 0919 加固：写成功后**立刻把它存进"按会话的草稿表"**。
           之后即使 ChatInput 又被重建（空态↔会话两套实例互换、消息加载完重排……），
           `restoreEditorState()` 也会把这段文案放回来 —— 不再有一次写成功就算完的赌运气。
           （只靠 300ms 的 @draft 防抖暂存来不及：重建可能发生在它之前。） */
        stashEditorState()
        pendingPrefillText = ''
        pendingPrefillConvId = ''
        return
      }
      if (tries < 60) setTimeout(() => applyPrefill(tries + 1), 90)
    })
  })
}
/* 文案后到也能立刻落地（不依赖下一次会话切换） */
watch(() => chatStore.pendingPrefill, () => { applyPrefill() })
/* ★ ChatInput 实例换代（空态↔会话是两套 v-if 分支）→ 先恢复草稿，再兜一次未落地的文案 */
watch(chatInputRef, () => {
  restoreEditorState()
  if (pendingPrefillText) applyPrefill()
})

/* 0919：这里以前有一个「填入导入引导词」的快捷按钮 + 软件名弹窗（自动预填的兜底入口）。
   用户定案：**入口收敛到设置页那个「开始导入」按钮**（点它先问软件名、再建会话并预填"带软件名"的
   引导词），输入框下方那个 chip 与弹窗一并删掉 —— 两个入口只会让人困惑（而且现在自动预填是可靠的）。 */

watch([activePreviewTabId, currentFixedView], ([tabNow, viewNow], [tabPrev, viewPrev]) => {
  const isChat = (v: unknown) => v == null || v === 'chat'
  if (isChat(tabPrev) && isChat(viewPrev) && !(isChat(tabNow) && isChat(viewNow))) {
    stashEditorState()
  } else if ((!isChat(tabPrev) || !isChat(viewPrev)) && isChat(tabNow) && isChat(viewNow)) {
    restoreEditorState()
  }
})
/* 会话切换（含 草稿↔会话、会话↔会话）：切走前暂存、切回后恢复。
   watch 源用 conv.id：空态分支与正常分支是两套 ChatInput 实例，切换会挂/卸，DOM 内容随卸载丢。 */
watch(() => props.conversation?.id, (_now, prev) => {
  // 切走前：把上一个会话的编辑器内容存下（此刻引用还是旧的，取到的是旧内容）
  if (chatInputRef.value) {
    const prevKey = String(prev ?? '')
    const st = grabEditorState()
    if (st) {
      editorStateByConv.set(prevKey, st)
      if (prevKey === '') writeDraftStash(st)
    } else {
      editorStateByConv.delete(prevKey)
      if (prevKey === '') writeDraftStash(null)
    }
  }
  /* ★1004p（实测反馈"a 的输入框内容串到 b、切回 a 又没了"）：同实例切换时旧内容留在 DOM 里没人清 ——
     restoreEditorState 是"空才补"守卫（防覆盖正在打的字），切换路径必须**无条件换上**新会话的
     状态（含空），否则 A 的内容串进 B，而 B 的空状态又把 A 的内容顶掉。 */
  const newKey = String(_now ?? '')
  /* ★1004r：兜底源加一档"已持久化草稿"——内存 stash 只活在页面生命周期内，刷新后只剩
     localStore 那份；不兜这档会把刚恢复的持久化草稿清掉（实测反馈"刷新回来输入框没了"）。 */
  /* ★1005 修复（实测反馈"a 的输入框内容串到 b"）：这一档必须**显式传 newKey** ——
     此刻是 pre-flush watch，`chatInputRef` 还挂在**旧会话**的实例上；不传参就会读到上一个会话的
     持久化草稿塞进新会话（兜底链静默给错数据）。传参后：newKey 是自己 → 读到自己的草稿；
     newKey 无草稿 → null → 正常清空。 */
  const nextState = editorStateByConv.get(newKey) || chatInputRef.value?.getSavedDraft?.(newKey) || (newKey === '' ? readDraftStash() : null)
  nextTick(() => { chatInputRef.value?.setEditorState(nextState) })
  applyPrefill()
})
/* 内容变化即暂存（@draft 是 ChatInput 的 MutationObserver 上报，含键盘输入/粘贴/标签增删） */
let stashTimer: ReturnType<typeof setTimeout> | null = null
function onDraftChange(has: boolean) {
  draftHasText.value = has
  if (stashTimer) clearTimeout(stashTimer)
  stashTimer = setTimeout(() => { stashEditorState() }, 300)
}
/** ★ 0921 修「切到别的窗口再回来，输入框里的字都没了、只剩最开始写的那一行」：
 *  真因 = **防抖窗口**。草稿只在 `@draft` 后 **300ms** 才落袋，而切窗口会让 ChatInput
 *  实例重建（空态↔会话两套实例、消息重排等），重建若发生在计时器到点**之前**
 *  ⇒ 存下的是更早那一版草稿（用户看到"只剩最初那行"）。
 *  （0919 的同款教训在 applyPrefill 注释里写着："只靠 300ms 的 @draft 防抖暂存来不及"。）
 *  对策：在这些"马上就要重建/离开"的时刻**立刻 flush**，不等防抖。 */
function flushStashNow() {
  if (stashTimer) { clearTimeout(stashTimer); stashTimer = null }
  stashEditorState()
}
onUnmounted(() => {
  if (stashTimer) clearTimeout(stashTimer)
  window.removeEventListener('blur', flushStashNow)
  document.removeEventListener('visibilitychange', flushStashNow)
})
// 挂载即尝试恢复（刷新/重开窗口后草稿内容回到输入框；空会话里没内容时是空操作）
onMounted(() => {
  restoreEditorState(); applyPrefill()
  window.addEventListener('blur', flushStashNow)
  document.addEventListener('visibilitychange', flushStashNow)
})

const conversationMessages = ref<Record<number, Message[]>>({})

function getMessages(convId: number): Message[] {
  if (!conversationMessages.value[convId]) {
    conversationMessages.value[convId] = []
  }
  return conversationMessages.value[convId]
}

const messages = computed(() => {
  const convId = props.conversation?.id ?? 0
  return getMessages(convId)
})

/** 空窗口：新对�?新项目窗口无内容，显示地�?问候语，输入框上移 */
/* ★ 0922z2d9（回退）：一度用"没拉过首屏就不渲染空态"来避免"先闪一下地球"，但实测加载期会露出
   空态布局的头像+问候语（地球是异步加载 + 0.9s 入场动画，还没渲染出来）→ 看着像半成品，比原样更差。
   故还原空态为原行为。piChat 的 markSettled/isOpening 保留（后续若改"延后显示空态"可直接用）。
   结论：这条路径的正确解法是"空态整体延后到 X ms 再淡入（CSS delay，无 JS 定时器）"，需用户定 X。 */
/* ★1012av：`isEmpty` 恢复原公式（骨架方案已回退：加载期显示空态，地球/问候语/输入框都在）。 */
const isEmpty = computed(() => piChatStore.getNodes(String(props.conversation?.id || '')).length === 0 && !activeTask.value)
/** ★1012aw：**首屏加载中** —— 只用于给空态页叠一个"正在加载会话…"指示。
 *  需求要求："点开一个对话别在空态页面上干等，至少要有个过渡界面"。
 *  这次**刻意不动消息区的 v-if 结构**（上次骨架就是栽在与空态的 v-if 竞争/叠加/挤掉输入框上），
 *  只在空态页内部加一个 `pointer-events: none` 的指示条 ⇒ 零冲突、零布局影响、可边等边打字。 */
const chatOpening = computed(() => piChatStore.isOpening(String(props.conversation?.id || '')))

/** 空态问候语：项目窗口与普通聊天不�?*/
const emptyGreeting = computed(() =>
      props.conversation?.project_id ? t('chat.emptyGreetingProject', { name: 'Nis' }) : t('chat.emptyGreetingChat', { name: 'Nis' }),
)
const emptyGreetingSub = computed(() =>
props.conversation?.project_id ? t('chat.emptyGreetingSubProject') : t('chat.emptyGreetingSubChat'),
)

// 新消息（�?blocks）出现时最后一块流式，一段时间后 settle 成最终形�?
watch(() => messages.value.length, (len, old) => {
  if (len <= old) return
  const last = messages.value[len - 1]
  if (last && last.blocks?.length && last.type !== 'user') {
    startMsgStream(last.id, estimateStreamMs(last))
  }
})

watch(() => props.conversation?.id, (id) => {
  if (id == null) return
  if (!conversationMessages.value[id]) {
    conversationMessages.value[id] = []
  }
  // 打开对应窗口即清零未�?
  conversationsStore.markRead(id)
}, { immediate: true })

/** 0905 七批：浏览器按会话隔离后，空闲释放全权交给引擎侧 idle（watch 挂起/unwatch 起算 90s），UI 全局 sweep 删除 */


// 重命名对�?
const renameModalVisible = ref(false)
const renameValue = ref('')

// 删除对话确认弹窗
const deleteModalVisible = ref(false)

function confirmRename() {
  const id = props.conversation?.id
  const title = renameValue.value.trim()
  if (id != null && title) {
    conversationsStore.renameConversation(id, title)
  }
  renameModalVisible.value = false
}

function closeRename() {
  renameModalVisible.value = false
}

function closeDeleteModal() {
  deleteModalVisible.value = false
}

function confirmDeleteConversation() {
  const id = props.conversation?.id
  deleteModalVisible.value = false
  // 先恢复列表并关闭当前会话（缩放动画正常播放），再移除会话
  emit('back')
  if (id != null) conversationsStore.deleteConversation(id)
}

// ── 右键菜单 ──
const ctxMenu = ref<{ visible: boolean; x: number; y: number; items: ContextMenuItem[] }>({
  visible: false, x: 0, y: 0, items: [],
})

// 全局右键桥接：ctxGlobal.open 只改模块级 state，此前没有任何组件渲染它
// （ConversationList/RightPanel/ModernTimeline 均未挂载或已退役）→ 工作区树右键
// 菜单永远不显示。挂载态的 ChatInterface 承接显示：watch 全局 state → 本地 ctxMenu
import { useGlobalContextMenu } from '@/composables/useGlobalContextMenu'
const ctxGlobal = useGlobalContextMenu()
watch(() => ctxGlobal.state, (s) => {
  if (s.visible) {
    ctxMenu.value = { visible: true, x: s.x, y: s.y, items: s.items as ContextMenuItem[] }
    s.visible = false
  }
}, { deep: true })

function openCtxMenu(e: MouseEvent, items: ContextMenuItem[]) {
  if (e.button !== undefined && e.button !== 2) return
  e.preventDefault()
  ctxMenu.value = { visible: true, x: e.clientX, y: e.clientY, items }
}

function closeCtxMenu() {
  ctxMenu.value.visible = false
}

function copyText(text: string) {
  try {
    navigator.clipboard?.writeText(text)
  } catch {
    /* ignore */
  }
}

/** 后台任务卡右键菜�?*/
function taskCtxMenu(task: any, e: MouseEvent) {
  const items: ContextMenuItem[] = []
  if (task.status === 'background') {
      // items.push({ label: '暂停', icon: 'fas fa-pause', action: () => tasksStore.updateStatus(task.task_id, 'paused') })
  } else if (task.status === 'paused') {
      // items.push({ label: '恢复', icon: 'fas fa-play', action: () => tasksStore.updateStatus(task.task_id, 'background') })
  }
      // items.push({ label: '取消任务', icon: 'fas fa-ban', action: () => tasksStore.updateStatus(task.task_id, 'cancelled') })
  items.push({ divider: true })
      // items.push({ label: '移除任务', icon: 'fas fa-trash-alt', danger: true, action: () => tasksStore.closeTask(task.task_id) })
  openCtxMenu(e, items)
}

/** 后台记录气泡右键菜单 */
function bgRecCtxMenu(rec: any, e: MouseEvent) {
  openCtxMenu(e, [
      // { label: '复制内容', icon: 'fas fa-copy', action: () => copyText(rec.content || '') },
  ])
}

// 模型选择：代�?providers store �?currentModelId（setter 触发 syncModelToBackend�?// 后端 activeModelId 才更新——之前本�?ref 只改 UI，选了 kimi 实际还是 longcat�?
/* ★1001 四批：外部 own 档的对话窗下拉=面板里配置的模型（清单在面板「获取」后才有，这里不摆假货架） */
const externalOwnModels = computed(() => {
  const pid = props.conversation?.presetId
  const p = pid ? agentPresetsStore.presets.find(x => x.id === pid) : null
  if (!(p?.engine && p.engine !== 'native' && p.modelSource === 'own')) return null
  return p.externalModel ? [p.externalModel] : []
})
const selectedModel = computed({
  get: () => {
    const id = props.conversation?.id
    if (id != null) {
      const cm = providersStore.getConvModel(String(id))
      if (cm?.model_id) return cm.model_id
    }
    return providersStore.currentModelId
  },
  set: (v: string) => {
    const id = props.conversation?.id
    /* ★1012r（实测："全局模型会跟着对话切换模型而改变，任何一个对话切换模型，他都会跟着走"）：
       老代码把"全局默认同步"放在 setter 末尾、**任何分支掉下来都会执行** ⇒
       ① 没有会话（空态）时改全局 —— 这是有意的（就是在设全局默认）；
       ② **有会话、但没找到归属供应商**（选的模型不在"就绪供应商表"里）时，也会掉到那行改全局 ——
          这是 bug：上一行注释本来就写着"找不到归属供应商=静默不写"，代码却改了全局（注释与实现不符的残留）。
       现在改成：**有会话 → 只写会话级覆盖，绝不碰全局**；只有真的没有会话，才写全局默认。 */
    if (id == null) {
      providersStore.currentModelId = v
      return
    }
    // ★1001 外部预设 own 档：它家模型不是 NIS 供应商的——直接落会话覆盖（provider='external' 占位）
    if (externalOwnModels.value?.includes(v)) {
      providersStore.setConvModel(String(id), { provider: 'external', model_id: v, base: '' })
      return
    }
    // 找到 v 所属供应商，写入会话级模型覆盖（每窗口独立，互不影响）
    for (const p of providersStore.enabledProviders) {
      if ((providersStore.models[p.id] || []).some(m => m.id === v && m.enabled)) {
        const base = (providersStore.providers.find(x => x.id === p.id)?.base || '')
        providersStore.setConvModel(String(id), { provider: p.id, model_id: v, base: base.includes('://') ? base : `https://${base}` })
        return
      }
    }
    // 0908 二批条1：找不到归属供应商=静默不写，发送仍走旧模型（"显示 b 回 a"路径之一）。现在至少留痕可取证
    console.warn('[model] 选择的模型不在就绪供应商表，会话覆盖未写入（★1012r 起也不再改全局）:', v)
  },
})
/** 0908 二批条1：用户点选信号（ModelSelector @change，带归属供应商）→ 直接写会话覆盖，
 *  不再依赖 setter 遍历 enabledProviders 猜归属（isProviderReady 过滤/供应商刚新增都会猜不到）。
 *  后端已配套：供应商没注册自动注册、缺 Key 明确报错——不存在"悄悄用旧模型"。 */
function onModelPick(id: string, vendorId: string | null) {
  const convId = props.conversation?.id
  if (convId == null || !id) return
  // ★1001 外部预设 own 档：'external' 是占位供应商（它家模型）——只写会话覆盖，不落 session.model
  if (vendorId === 'external') {
    providersStore.setConvModel(String(convId), { provider: 'external', model_id: id, base: '' })
    return
  }
  /* ★ 0921（实测："选择完模型没有立马切换，要点一下别的对话再切回来才显示"）：
     原来这里 `!vendorId` 也一并 return ⇒ 凡是"没带归属供应商"的点选路径（列表里某些入口、
     或供应商刚注册还没进 enabled 表）都**静默丢弃**，界面自然不动。
     改成**反查归属供应商**兜底 —— 找不到才真的放弃（并留痕）。 */
  const vid = vendorId
    || providersStore.enabledProviders.find(p => (providersStore.models[p.id] || []).some(m => m.id === id))?.id
    || null
  if (!vid) { console.warn('[model] 找不到该模型的归属供应商，会话覆盖未写入:', id); return }
  const p = providersStore.providers.find(x => x.id === vid)
  if (!p) return
  const raw = p.base || ''
  providersStore.setConvModel(String(convId), { provider: vid, model_id: id, base: raw.includes('://') ? raw : `https://${raw}` })
  /* ★1012s（实测："重启前端后全局模型还是随对话切换而改变，我要的是全局模型固定死用户选的"）：
     **这条就是漏掉的第二条写入口** —— `ModelSelector` 的 `@change`（用户点选的主路径）在这里顺手把
     **全局模型**也改了。1012r 只修了 v-model 那条 setter，漏了这里，所以现象照旧。
     语义定稿（设计口径）：**聊天窗下拉 = 只改本会话**；全局模型只由「设置 → 人格 → 全局模型」
     （ExtractModelSelector）修改，且固定不变。 */
  // （原第 1589 行 `providersStore.currentModelId = id` 已删除 —— 那正是本条 bug）
  // 0908三：即时落盘后端 session.model/providerId——换模型后没发消息就刷新/重开，仍是所选模型。
  // 不依赖 session.prompt 副作用（发送时才写），fire-and-forget，失败只留痕（发送路径仍会带覆盖）
  chatStore.bridgeRpc('session.model', { sessionId: String(convId), modelId: id, providerId: vid })
    .catch(e => console.warn('[model] session.model 落盘失败（发送时仍会带覆盖）:', e))
}
// 0908三：切会话时本地无该会话覆盖 → 向后端取权威模型回填（照 0904 预设隔离思路补数据链）。
// 兜住两类漏网：① loadConversations 回填字段上线前建的会话；② 新会话创建晚于上次列表加载
//（打开即定型为当下全局，与"发送过就持久化"的刷新回填语义一致，之后全局再变不被带着走）。
watch(() => props.conversation?.id, (id) => {
  if (id == null) return
  const key = String(id)
  if (providersStore.getConvModel(key)) return
  chatStore.bridgeRpc('session.model', { sessionId: key }).then((r: any) => {
    if (!r?.model || !r.providerId) return // 后端反查不到供应商 → 保持兜底全局的旧行为
    if (providersStore.getConvModel(key)) return // await 期间用户刚选过，不覆盖
    const raw = r.base || ''
    providersStore.setConvModel(key, { provider: r.providerId, model_id: r.model, base: raw.includes('://') ? raw : `https://${raw}` })
  }).catch(() => { /* 后端未就绪：本轮跟随全局，下次切换再试 */ })
}, { immediate: true })
// 推理强度：0908六 按会话隔离（此前 localStorage 全局单值 → 一个会话改，所有会话跟着变）。
// getter=本会话 effort（loadConversations 从后端 session.list 回填）优先，无则跟随全局默认；
// setter=写本会话（store + RPC session.model{effort} 落盘）+ 更新全局默认（新会话兜底值跟随最后一次）。
// 0909 ①：补"切会话即时回填"（与上面模型回填同思路）——loadConversations 只在启动跑一次，
// 本次运行内新建/晚到的会话记录没有 effort → getter 落 localStorage 全局兜底 → 别的窗口一改强度
// 它就跟着变（用户实锤"窗口1选high，窗口2的max也变high"的残留通道）。切到该会话时向 session.model
// 取权威值种上；后端也没有（全新会话）则保持跟随全局，语义不变。
watch(() => props.conversation?.id, (id) => {
  if (id == null) return
  const conv = conversationsStore.getById(String(id))
  if (!conv || conv.effort) return
  chatStore.bridgeRpc('session.model', { sessionId: String(id) }).then((r: any) => {
    const c2 = conversationsStore.getById(String(id))
    if (c2 && !c2.effort && typeof r?.effort === 'string' && r.effort) c2.effort = r.effort
  }).catch(() => { /* 后端未就绪：本轮跟随全局，下次切换再试 */ })
}, { immediate: true })
const draftEffort = ref<string | null>(null)
const reasoningMode = computed<string>({
  get: () => {
    const id = props.conversation?.id
    if (id != null) {
      const e = conversationsStore.getById(String(id))?.effort
      if (e) return e
    }
    /* ★0926（修「空态推理强度切换失灵」）：localStore 是**非响应式 Map**（utils/localStore.ts），
       光写它 computed 永不重算 → 显示冻结在旧值（"拨了没反应、切窗口回来才变"的真断环本体）。
       空态走 draftEffort（响应式草稿）做显示源，localStore 只负责持久化/新会话兜底。 */
    return draftEffort.value ?? (localStore.getItem('nis-reasoning-mode') || 'deep')
  },
  set: (v: string) => {
    const id = props.conversation?.id
    if (id != null) {
      const conv = conversationsStore.getById(String(id))
      if (conv) conv.effort = v
      chatStore.bridgeRpc('session.model', { sessionId: String(id), effort: v }).catch(e => console.warn('[effort] session.model 落盘失败:', e))
    } else {
      draftEffort.value = v
    }
    try { localStore.setItem('nis-reasoning-mode', v) } catch { /* ignore */ }
  },
})
const contextValue = ref(65)
const contextMax = ref(128000)

/* ── 0907 图二：手机模式下统计胶囊 Teleport 到底部导航中心槽（App.vue #mobile-tabbar-stats）。
 *  ⚠ 不能动态挂载 Teleport（Vue 已知坑：卸载时 target 已被 v-if 删掉 → parentNode of null 崩树）——
 *  Teleport 常驻渲染 + defer，用 :disabled 切"搬走/就地"；disabled 切换自带 move 语义不销毁实例。 ── */
const mqMobileStats = window.matchMedia('(max-width: 767px)')
const isMobileUi = ref(mqMobileStats.matches)
const onMobileStatsMq = (e: MediaQueryListEvent) => { isMobileUi.value = e.matches }
onMounted(() => mqMobileStats.addEventListener('change', onMobileStatsMq))
onUnmounted(() => mqMobileStats.removeEventListener('change', onMobileStatsMq))
const statsLineProps = computed(() => ({
  contextValue: contextValue.value,
  contextMax: contextMax.value,
  /** 判定值（= 进度条上的**下轮预测线**位置） */
  contextUsed: contextUsed.value,
  /** ★★ 0924：**真实已用**（= 圆环百分比 + 进度条已用段） */
  contextRealUsed: contextRealUsed.value,
  modelUsage: modelStats.value,
  usedModels: usedModels.value,
  currentModel: selectedModel.value,
  turns: statsTurns.value,
  steps: statsSteps.value,
  toolCalls: statsToolCalls.value,
  memberUsage: memberUsageStats.value,
  turnSeconds: turnElapsed.value,
  breakdown: contextBreakdown.value,
  // ★ 0921m：累计视角 + 缓存自检锚点 + 压缩计数
  usageTotals: contextTotals.value,
  compactionCount: compactionCount.value,
  lastCompaction: lastCompaction.value,
}))

/* ── 本轮计时（0902 反馈 #7）：发消息起显示计时胶囊（并入 StatsLine 最左胶囊），秒→分→时→日。
 *    ★1004m-2 重构：状态挪进 utils/turnTimer.ts（模块级单例）——切会话/切窗口/多窗口共享
 *    同一份计数，不归零、不串台（per-conv 键控）；本轮开始即从 0 显示，无 10s 阈值（已定案）。
 *    清理只在会话真实终态（agentEnd/aborted/stopped）发生，见 session/status 处理块。 */
const turnElapsed = computed(() => {
  void turnTimerTick.value
  return turnSecondsOf(String(props.conversation?.id ?? ''))
})
/* ★1012e【计时同步】向后端要"本轮已用秒数"并校准本地计时。
   为什么需要：计时器是每个浏览器**各自**从"收到 running 帧"起表的（模块级单例只共享同一个 JS 运行时）。
   本机是发起方（按下发送就起表），而手机/另一台电脑可能是**本轮中途才连上**的 —— 收到帧时本轮
   已经跑了 N 秒却无从得知，于是两端永远差 N 秒（实测：1 分 11 秒 vs 1 分 30 秒）。
   后端的 turnStartTime（agent_start 时打下）是权威基准，问一次对齐即可，之后各自 tick 走。 */
async function syncTurnFromBackend(sid: string) {
  if (!sid) return
  try {
    const r: any = await chatStore.bridgeRpc('session.turnElapsed', { sessionId: sid })
    if (r?.sec != null) syncTurnTimer(sid, r.sec)
    else if (r && r.running === false) stopTurnTimer(sid)
  } catch { /* 校准失败就退回各自计时，不影响主流程 */ }
}

// 切会话：不清计数（单例续算）；若目标会话在跑则确保计时器挂着（切回续算，不归零）
watch(() => props.conversation?.id, (id) => {
  if (id != null && conversationsStore.getById(String(id))?.replying) {
    startTurnTimer(String(id))
    /* ★1012e：切到"正在跑"的会话时也校准一次 —— 这个窗口可能是在本轮中途才切过来/才打开的 */
    void syncTurnFromBackend(String(id))
  }
})

/* ★ 0925r（实测"压缩成功但圆环没减"）：压缩收尾（done/failed）后 piChat 会派发
   nis-refresh-context —— 这里监听立刻重拉上下文统计，圆环/预测线马上跟上锚点缩放后的值。
   ★ 0925u（实测"压缩完得发一次消息圆环才变"）：圆环百分比吃的是 contextRealUsed
   （上轮模型实报=账单口径）——压缩不动账单，所以圆环纹丝不动。压缩收尾后把"真实已用"
   **切到判定值**（= 压缩后锚点缩放值），圆环立刻回落；下一轮真实 usage 回来自然覆盖回实报口径。 */
function _onRefreshContext() {
  void refreshContextUsage().then(() => {
    if (contextUsed.value != null && contextUsed.value > 0) contextRealUsed.value = contextUsed.value
  })
}
window.addEventListener('nis-refresh-context', _onRefreshContext)
onUnmounted(() => window.removeEventListener('nis-refresh-context', _onRefreshContext))

/** 后端"判定值"（session.context.usedTokens 优先取 ctxUsedForRing = 上轮真实 + 此后新增估算；
 *  未拉到时 undefined → StatsLine 按百分比近似） */
const contextUsed = ref<number | undefined>(undefined)
/* ★★ 0924（用户设计"预测线"）：**真实已用** token —— 与上面的"判定值"分开口径。
   分工（用户定案）：
     · contextRealUsed（真实 usage）→ 进度条"已用段" + 圆环百分比，回答"**我现在实际用了多少**"；
     · contextUsed（判定值）        → 进度条上的**下轮预测线**，回答"**再发一条消息会到多少**"。
   预测线碰到触发线 ⇒ 这条消息发出去就会压缩 —— 这才是"什么时候会锁"的直观答案。 */
const contextRealUsed = ref<number | undefined>(undefined)
/** 上下文分段占用（后端按真实请求内容分类的字符估算；无则 StatsLine 回退固定比例） */
const contextBreakdown = ref<{ base: number; sysTools: number; specialTools: number; mcpTools: number; skill: number; messages: number } | null>(null)
/** ★ 0921m：本会话累计用量（悬停气泡"累计视角"）*/
const contextTotals = ref<{ uncached: number; cacheRead: number; cacheWrite: number; output: number; turns: number } | null>(null)
/** ★ 0921m：已压缩次数 + 最近一次明细（上下文胶囊"压 N" / 气泡细节）*/
const compactionCount = ref<number>(0)
const lastCompaction = ref<{ folded: number; at: number } | null>(null)
/** 各模型最近一次真实 usage/timing（StatsLine：后两胶囊跟随当前模型；第5胶囊计数+悬停） */
const modelStats = ref<Record<string, { timing?: { llmMs?: number; ttftMs?: number; toolMs?: number }; usage?: { promptTokens?: number; completionTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number } }>>({})
/** 本对话用过的不同模型（首次使用顺序去重，同一模型不二次计入） */
const usedModels = ref<string[]>([])
/** ★ 0922z2c（反馈）：统计一律用**整段对话**口径。
 *  背景：原来只数 piChat 内存里的节点 —— 分批加载上线后，长会话首屏只装最后 20 轮，
 *       统计就只算那 20 轮（实测 72 轮会话显示"20 轮"）。
 *  做法：与后端全量计数（session.history 的 totalTurns/totalReplies/totalToolCalls）取较大者。
 *       max() 的语义：后端数 = 整段基线；本地节点在"新一轮正在跑"时会先超过它 → 统计仍是活的。 */
const statsTurns = computed(() => {
  const nodes = piChatStore.getNodes(String(props.conversation?.id ?? ''))
  // ★ 0922z3：只数"真实用户轮" —— dm（成员单聊气泡）不是轮，与后端 totalTurns 同口径
  const local = nodes.filter(n => n.kind === 'user' && !(n as any).dm).length
  return local // ★0930 拆分批加载：恒全量=本地即整段
})
const statsSteps = computed(() => {
  const nodes = piChatStore.getNodes(String(props.conversation?.id ?? ''))
  const local = nodes.filter(n => n.kind === 'assistant' && (n.text || n.reasoning)).length
  return local // ★0930 拆分批加载：恒全量=本地即整段
})
const statsToolCalls = computed(() => {
  const nodes = piChatStore.getNodes(String(props.conversation?.id ?? ''))
  const local = nodes.filter(n => n.kind === 'tool' && n.toolName !== 'ask_user').length
  return local // ★0930 拆分批加载：恒全量=本地即整段
})
/** 第 6 胶囊（仅团队会话）：黑板 runs 按成员聚合（任务累计口径） */
const memberUsageStats = ref<Array<{ memberName: string; promptTokens: number; completionTokens: number; cacheReadTokens: number; cacheWriteTokens: number; llmMs: number; model?: string; runs: number }>>([])
async function refreshMemberUsage() {
  const convId = props.conversation?.id
  const conv = props.conversation as any
  if (convId == null || !conv?.teamId) { memberUsageStats.value = []; return }
  try {
    const v = await chatStore.bridgeRpc('blackboard.read', { sessionId: String(convId) })
    const runs = (v?.blackboard?.runs || []) as any[]
    const byMember = new Map<string, { memberName: string; promptTokens: number; completionTokens: number; cacheReadTokens: number; cacheWriteTokens: number; llmMs: number; model?: string; runs: number }>()
    for (const r of runs) {
      const name = String(r.memberName || r.memberId || t('chat.member'))
      const e = byMember.get(name) || { memberName: name, promptTokens: 0, completionTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, llmMs: 0, model: r.model, runs: 0 }
      e.promptTokens += r.usage?.promptTokens || 0
      e.completionTokens += r.usage?.completionTokens || 0
      // 缓存维度与主胶囊同口径（LongCat 命中后 promptTokens 只含未命中部分，漏算会把成员 token 压到近 0）
      e.cacheReadTokens += r.usage?.cacheReadTokens || 0
      e.cacheWriteTokens += r.usage?.cacheWriteTokens || 0
      e.llmMs += r.timing?.llmMs || 0
      if (r.model) e.model = r.model
      e.runs += 1
      byMember.set(name, e)
    }
    memberUsageStats.value = Array.from(byMember.values())
  } catch { memberUsageStats.value = [] }
}
// 黑板帧实时刷新成员用量
if (true) {
  const onBbFrame = (frame: any) => {
    const p = frame?.payload
    if (p?.type === 'session/blackboard' && p.sessionId === String(props.conversation?.id ?? '')) void refreshMemberUsage()
  }
  onMounted(() => chatStore.onMessage(onBbFrame))
  onUnmounted(() => chatStore.offMessage(onBbFrame))
}
/** 拉取真实上下文占用（后端 session.context：模�?maxContext + transcript token 估算 + usage/timing�?*/
async function refreshContextUsage() {
  const convId = props.conversation?.id
  if (convId == null) return
  try {
    const r = await chatStore.bridgeRpc('session.context', { sessionId: String(convId) })
    if (r?.percent != null) contextValue.value = r.percent
    if (r?.maxTokens) contextMax.value = r.maxTokens
    // 判定值直通（= 进度条上的**下轮预测线**；胶囊悬停显示 ~N / M）
    contextUsed.value = typeof r?.usedTokens === 'number' ? r.usedTokens : undefined
    /* ★★ 0924（用户设计"预测线"）：**真实已用**（圆环 + 已用段用）—— 与判定值分开口径。
       来源 = 后端 session.context.usage（上一轮模型回报的真实 usage：prompt + cacheRead + cacheWrite）。
       拿不到（首轮 / 刚重启）时留 undefined → StatsLine 回退用 contextValue 百分比近似。 */
    const _realU = r?.usage
    contextRealUsed.value = _realU
      ? (Number(_realU.promptTokens) || 0) + (Number(_realU.cacheReadTokens) || 0) + (Number(_realU.cacheWriteTokens) || 0)
      : undefined
    contextBreakdown.value = r?.breakdown && typeof r.breakdown === 'object' ? r.breakdown : null
    // 回填 per-model usage/timing（刷新后胶囊数据不归零；后端 modelUsage/usedModels 持久化）
    if (r?.modelUsage) modelStats.value = r.modelUsage
    if (r?.usedModels) usedModels.value = r.usedModels
    // ★ 0921m：累计视角 / 压缩次数
    if (r?.usageTotals && typeof r.usageTotals === 'object') contextTotals.value = r.usageTotals
    compactionCount.value = Number(r?.compactionCount) || 0
    lastCompaction.value = r?.lastCompaction && typeof r.lastCompaction === 'object' ? r.lastCompaction : null
    // 兼容旧后端字段：无 modelUsage 时回退全局 usage/timing
    if (!r?.modelUsage && r?.usage && (r.usage.promptTokens || r.usage.completionTokens || r.usage.cacheReadTokens || r.usage.cacheWriteTokens)) {
      const mid = selectedModel.value
      if (mid) modelStats.value[mid] = { timing: r.timing, usage: r.usage }
    }
  } catch { /* 后端未就绪时保持旧值 */ }
}
// 打开会话时拉一次（历史消息的上下文占用）；并做会话级状态隔离：
// isGenerating（发�?停止按钮）、胶�?usage/timing 均按会话重置，防止串�?
// 权限模式按会话隔离（每窗口独立记忆），变化即同步后端（决定 NIS 工具门禁是询问还是自动放行）
const permissionModes = ref<Record<string, string>>({})
const runLogOpen = ref(false)
const workspaceOpen = ref(false)
/** 版本面板（右栏）：本会话工作区的 git 提交时间线（只读） */
const versionOpen = ref(false)
/** 窗口宽度（右栏百分比上限要随窗口变化重算） */
const winW = ref(typeof window !== 'undefined' ? window.innerWidth : 1400)
/** 右栏总宽（0915 用户口径修正）：面板各自首选宽（日志 380 / 工作区 300），
 *  但**合计不超过窗口 35%** —— 此前固定 680px，1400 宽窗口下≈49%，把主视图挤得太狠。
 *  面板已去掉 shrink-0、容器 overflow-hidden，超出部分按各自宽度等比压缩（不再是硬裁）。 */
const rightDocksWidth = computed(() => {
  /* ★ 0924（需求要求收窄 + "改了没变化"根因）：这里的日志面板宽度必须与 RunLogPanel 内部**同步** ——
     原来写死 380 而面板内部改成 300，外层就比面板宽 80px：右侧留一条空白带，看着像"改宽度没生效"。 */
  const n = (runLogOpen.value ? 300 : 0) + (workspaceOpen.value ? 300 : 0) + (versionOpen.value ? 300 : 0)
  if (!n) return '0px'
  const cap = Math.round(winW.value * 0.35)
  return `${Math.min(n, cap)}px`
})
/** 极窄窗口保险丝（0904③，随固定宽上调阈值）：面板固定合计 680 + 左列保底 380 = 1060，
 *  窗口 <1080px 时双栏同开会挤压主视图，故整栏收起（单开 380/300 时不影响）。
 *  手机端规划里此宽度档会改 overlay 抽屉，届时替换本逻辑（预留见 right-docks 包装层注释）。 */
function onWinResizeFuse() {
  winW.value = window.innerWidth
  if (window.innerWidth < 1080) { runLogOpen.value = false; workspaceOpen.value = false; versionOpen.value = false }
}
onMounted(() => window.addEventListener('resize', onWinResizeFuse))
onUnmounted(() => window.removeEventListener('resize', onWinResizeFuse))
/* ★ 0924（反馈"空态这两个按钮无法正确切换"·真凶）：
   原来空态（新会话还没 id）时 —— getter 永远返回固定默认值、setter 直接 `return` 丢弃，
   所以点选只会"看着没反应"。现在空态走**草稿态**：先记住用户的选择，
   会话一建立（id 从 null → 有值）就带过去（落地逻辑见下面那个恢复用的 watch）。 */
const draftPermissionMode = ref('confirm')
const permissionMode = computed({
  get: () => {
    const id = props.conversation?.id
    return id != null ? (permissionModes.value[String(id)] || 'confirm') : draftPermissionMode.value
  },
  set: (v: string) => {
    const id = props.conversation?.id
    if (id == null) { draftPermissionMode.value = v; return }
    permissionModes.value[String(id)] = v
    chatStore.sendPermissionMode(v, String(id))
  },
})
/** 工作模式（0920）：与权限模式同款——**按会话隔离记忆** + 变化即同步后端。
 *  后端不把它塞进 systemPrompt，而是转成一段随消息注入的行为指令（server.ts buildModeHint），
 *  所以切模式**不会重建 agent**、也不影响其它会话。
 *  ⚠️ 默认 'default' = 不额外约束：存量会话（老数据没这个字段）行为与改前完全一致。
 *  ⚠️ 定义必须留在下面那个 watch 之前（恢复逻辑要读它，否则 TDZ）。 */
const planModes = ref<Record<string, string>>({})
/** ★ 0924：空态草稿（同权限模式）—— 让新会话在建立之前也能真正切换工作模式 */
const draftPlanMode = ref('default')
const planMode = computed({
  get: () => {
    const id = props.conversation?.id
    return id != null ? (planModes.value[String(id)] || 'default') : draftPlanMode.value
  },
  set: (v: string) => {
    const id = props.conversation?.id
    if (id == null) { draftPlanMode.value = v; return }
    planModes.value[String(id)] = v
    chatStore.sendMode(v, String(id))
  },
})
// 打开/切换会话时恢复该窗口自己的权限模式（后端持久化过）
watch(() => props.conversation?.id, (id, prevId) => {
  if (id == null) return
  const sid = String(id)
  /* ★ 0924：空态切过的选择（draft）在这里**落地到新会话** —— 否则"空态切了、一发消息就变回默认"。
     只在"空态 → 有会话"这一跳带过去（prevId == null），避免跨会话串台。
     落地的值优先于后端旧值（下面那两个 `!xxx.value[sid]` 判断天然让位）。 */
  if (prevId == null) {
    if (draftPermissionMode.value !== 'confirm') {
      permissionModes.value[sid] = draftPermissionMode.value
      chatStore.sendPermissionMode(draftPermissionMode.value, sid)
    }
    if (draftPlanMode.value !== 'default') {
      planModes.value[sid] = draftPlanMode.value
      chatStore.sendMode(draftPlanMode.value, sid)
    }
  }
  const c = conversationsStore.getById(sid) as any
  if (c && c.permissionMode && !permissionModes.value[sid]) {
    permissionModes.value[sid] = c.permissionMode
  }
  // 工作模式同样按会话恢复（后端落盘过就走它；没有=默认，行为与改前一致）
  if (c && c.mode && !planModes.value[sid]) {
    planModes.value[sid] = c.mode
  }
  // 输入区模式选择跟随会话（团队会话=team+其 teamId；否则 preset）——
  // 之前 selectedMode 是全局单例且不随会话切：刷新后回落 'preset'，团队会话
  // 再发消息走预设分支（标题显示团队名但实际按单 agent 发送，"刷新变标准模式"根因）
  const isTeam = !!c?.teamId
  /* ★1001 四批：外部预设的会话恢复成「外部 agent」类别（不然显示成普通预设模式） */
  const _ep = c?.presetId ? agentPresetsStore.presets.find(p => p.id === c.presetId) : null
  selectedMode.value = isTeam ? 'team' : (_ep?.engine && _ep.engine !== 'native' ? 'external' : 'preset')
  if (isTeam) selectedTeamId.value = String(c.teamId)
}, { immediate: true })
const isSending = ref(false)
const isGenerating = ref(false)
/** 0909⑦改：输入框草稿有无（ChatInput MutationObserver 实时上报）。
 *  忙时按钮态=有草稿显示「发送」(走排队/插话)，无草稿显示「停止」；替代旧 wasInterrupted 假草稿判定。 */
const draftHasText = ref(false)

/** 对话 store 的 replying 状态（后端 session/status 事件驱动），作为 isGenerating 的补充。 */
const isReplying = computed(() => {
  if (!props.conversation?.id) return false
  return !!conversationsStore.getById(String(props.conversation.id))?.replying
})
/** 生成超时兜底（SSE 断连时防止按钮卡死） */
const generateTimeout = ref<ReturnType<typeof setTimeout> | null>(null)
// 打开会话时拉一次（历史消息的上下文占用）；并做会话级状态隔离：
// isGenerating（发�?停止按钮）、胶�?usage/timing 均按会话重置，防止串�?
watch(() => props.conversation?.id, (newId, oldId) => {
  contextValue.value = 65
  // 当前会话是否在回复：�?
      // conversations store �?per-session replying 为准（不是沿用上一个会话的状态）
  isGenerating.value = newId != null ? !!conversationsStore.getById(String(newId))?.replying : false
  // 胶囊数据按会话隔离：切走不残留上一个会话的 usage/timing
  if (oldId !== newId) {
    modelStats.value = {}
    usedModels.value = []
    memberUsageStats.value = []
    contextBreakdown.value = null
  }
  if (props.conversation?.id != null) { refreshContextUsage(); refreshMemberUsage() }
  /* 0920：切会话 → 同步该会话的后台任务（胶囊 tab 只显示本会话的） */
  void tasksStore.syncFromBackend(props.conversation?.id ?? undefined)
}, { immediate: true })
const attachments = ref<Array<{ name: string; size: number; type: string; preview?: string; file?: File }>>([])
const fileInput = ref<HTMLInputElement | null>(null)

function handleCommand(e: Event) {
  const cmd = (e as CustomEvent).detail as string
  // /demo：跑一条演示流水线（真实工具链�?+ 通知/询问卡渲染）
  if (cmd.trim() === '/demo' || cmd.trim() === '/demo ') {
    runDemoFlow()
    return
  }
  if (cmd.trim() === '/demo-blocks' || cmd.trim() === '/demo-blocks ') {
    runDemoBlocks()
    return
  }
  // /plan-demo：计划卡样式演示（条目依次完成划勾）
  if (cmd.trim() === '/plan-demo' || cmd.trim() === '/plan-demo ') {
    runPlanDemo()
    return
  }
  // ★ 0920 /bg-demo：后台任务面板样式演示（左上角胶囊 + 读条 + 计时）
  if (cmd.trim() === '/bg-demo' || cmd.trim() === '/bg-demo ') {
    runBgDemo()
    return
  }
  chatStore.addText(cmd)
}

/** ★ 0920 /bg-demo：后台任务面板样式演示。
 *  注入一组**只在前端**的假任务（id 带 preview_ 前缀，UI 上打「预览」标），
 *  覆盖三种形态：下载（读条+速度+ETA）、长命令（计时）、已完成/失败。
 *  60s 后自动收掉，免得一直挂在左上角。 */
function runBgDemo() {
  const convId = props.conversation?.id
  if (convId == null) return
  tasksStore.startPreview(convId)
  notificationsStore.push({ level: 'info', title: t('bgTask.demoTitle'), content: t('bgTask.demoBody'), type: 'system' })
  if (bgDemoTimer) clearTimeout(bgDemoTimer)
  bgDemoTimer = setTimeout(() => { tasksStore.dropPreview() }, 60_000)
}

/** /demo 演示：真实会话上跑工具链�?+ 注入渲染演示（内联通知/询问�?权限卡） */
async function runDemoFlow() {
  try {
    let convId = props.conversation?.id
    if (convId == null) {
      const conv = await conversationsStore.createConversation(null, selectedPresetId.value)
      if (!conv) { console.error('[demo] createConversation returned null'); return }
      await conversationsStore.openConversation(conv.id)
      await nextTick()
      for (let i = 0; i < 100; i++) {
        if (props.conversation?.id === conv.id) break
        await new Promise(r => setTimeout(r, 50))
      }
      convId = props.conversation?.id
      if (convId == null) { console.error('[demo] convId still null after waiting'); return }
    }
    console.log('[demo] starting with convId:', convId)
    // 演示前清空旧消息，重新开场（key 用字符串，与 props.conversation.id 一致）
    const cid = String(convId)
    conversationMessages.value[cid] = []
    const list = getMessages(cid)
    const m = { id: nextMessageId(cid), type: 'ai' as const, content: '', blocks: [], time: nowTime(), status: 'done' as const }
    list.push(m)
    nextTick(() => scrollToBottom())

  const set = (fn: () => void, delay: number) => {
    setTimeout(() => {
      fn()
      // 强制触发 conversationMessages ref 更新（m.blocks 赋值不改变数组长度，computed 不重算）
      triggerRef(conversationMessages)
      nextTick(() => scrollToBottom())
    }, delay)
  }

  // 2. 工具链演示（真实 dsh 工具块渲染）：并行运行→完成打勾 / 出错红叉
  set(() => {
    m.blocks = [
      { type: 'tool', tool: 'run_command', input: { command: 'npm install' }, status: 'running', call_id: 'demo_running' },
      // { type: 'tool', tool: 'memory_search', input: { query: '技术栈偏好' }, status: 'running', call_id: 'demo_search' },
      { type: 'tool', tool: 'fs_read', input: { path: 'src/views/Login.vue' }, status: 'running', call_id: 'demo_read' },
      // { type: 'tool', tool: 'knowledge_query', input: { query: '部署' }, status: 'running', call_id: 'demo_kq' },
    ]
  }, 2000)
  set(() => {
    m.blocks = (m.blocks || []).map(b => b.call_id === 'demo_running'
      ? { ...b, status: 'completed', output: 'added 23 packages in 3s\nfound 0 vulnerabilities' }
      : b)
  }, 5200)
  set(() => {
    m.blocks = (m.blocks || []).map(b => b.call_id === 'demo_search'
? { ...b, status: 'completed', output: '1. [preference] 用户偏好纯前端技术栈 (相关度0.72)\n2. [fact] 个人博客项目已确定技术栈 React+TS' }
      : b)
  }, 6400)
  set(() => {
    m.blocks = (m.blocks || []).map(b => b.call_id === 'demo_read'
      ? { ...b, status: 'completed', output: '<template>\n  <div class="login">…\n</template>' }
      : b)
  }, 7600)
  set(() => {
    m.blocks = (m.blocks || []).map(b => b.call_id === 'demo_kq'
? { ...b, status: 'completed', output: '1. [doc][id=kb_x] 生产级 Agent Memory 架构笔记：纯向量库的局限' }
      : b)
  }, 8800)

  // 3. 权限卡（输入框接管）+ 询问卡（多选）
  set(() => {
    m.blocks = (m.blocks || []).concat([
      {
        type: 'permission_prompt',
        request_id: 'demo_perm_1',
      // question: '需要执行命令以安装项目依赖，是否授权？',
      // options: ['本次允许', '当前会话允许', '当前项目允许', '拒绝'],
        tool: 'npm install',
        risk: 'medium',
      },
    ])
  }, 10000)
  set(() => {
    m.blocks = (m.blocks || []).concat([
      {
        type: 'ask_user',
        request_id: 'demo_q_1',
      // question: '部署到哪里？',
      // options: ['Vercel', '自建服务�?],
      },
    ])
  }, 11000)

  // 4. 收尾：伙伴完�?+ 任务完成通知 + 总结文本
  set(() => {
  }, 13500)
  set(() => {
  }, 15000)
  set(() => {
      // m.content = '演示完成：\n\n�?工具链（执行命令/检索记�?读取文件/知识库查询）�?dsh 工具块，运行中扫光，完成打勾，可展开 IN/OUT\n�?权限�?询问�?�?输入框位置接管，选择后恢复\n�?内联通知 �?气泡间状态条\n\n现在输入框上方的权限选择器可切换「需要确�?自审�?完全访问」，真实对话中工具调用会按三档策略弹卡�?
    // 总结作为 plaintext 块渲染（content 字段不参与渲染）
    m.blocks = (m.blocks || []).concat([{ type: 'plaintext', content: m.content }])
    // 卡标记为已答（保留展示，但输入框恢复�?
for (const b of m.blocks) {
      if (b.type === 'permission_prompt' || b.type === 'ask_user') b.answered = true
    }
  }, 17000)
  } catch (e) {
    console.error('[demo] runDemoFlow failed:', e)
  }
}

/** /plan-demo：计划卡样式演示（依次完成划勾，8s 后清空） */
function runPlanDemo() {
  const convId = props.conversation?.id
  if (convId == null) return
  const conv = conversationsStore.getById(String(convId))
  if (!conv) return
  const plan = [
    { text: '拆解任务并列出计划', done: false },
    { text: '读取现有代码结构', done: false },
    { text: '实现核心功能', done: false },
    { text: '自测与修复', done: false },
    { text: '汇总交付', done: false },
  ]
  conv.plan = plan.map(p => ({ ...p }))
  plan.forEach((_, i) => {
    setTimeout(() => {
      const c = conversationsStore.getById(String(convId))
      if (!c?.plan) return
      c.plan = c.plan.map((p2, j) => ({ ...p2, done: j <= i }))
    }, 1200 + i * 1300)
  })
  setTimeout(() => { const c = conversationsStore.getById(String(convId)); if (c) c.plan = undefined }, 11000)
}

/** /demo-blocks：注入全部过程块到当前会话 piChat 节点（不走真实调用），展示所有工具变体
 *  过程态工具（run_command/web_search/web_fetch/fs_write）演示 5s 运行中动画 + 计时，
 *  瞬时工具直接以完成态渲染。 */
async function runDemoBlocks() {
  const convId = props.conversation?.id
  if (convId == null) return
  const cid = String(convId)
  const nodes = piChatStore.getNodes(cid)
  nodes.length = 0
  nodes.push({ key: crypto.randomUUID(), kind: 'user', text: '/demo-blocks 展示', reasoning: '', status: 'done', time: Date.now() })
  // 思考块（streaming → done）
  nodes.push({ key: crypto.randomUUID(), kind: 'assistant', text: '', reasoning: '正在分析您的需求，考虑多种方案……', status: 'streaming', time: Date.now() })
  setTimeout(() => {
    const t = nodes.find(n => n.kind === 'assistant' && n.status === 'streaming')
    if (t) { t.status = 'done'; t.text = '为您展示了以下工具块样式：' }
  }, 2500)

  // 工具列表：process=true 的过程态工具（演示 5s 运行中），其余瞬时直出
  const TOOLS: Array<{ name: string; input: any; output?: string; process?: boolean }> = [
    // ── 过程态（5s 运行动画 + 计时） ──
    { name: 'run_command', input: { command: 'npm install tailwindcss' }, output: 'added 23 packages in 3s\nfound 0 vulnerabilities', process: true },
    { name: 'web_search', input: { query: 'Vue 3.5 最新特性' }, output: '1. Vue 3.5 正式发布 - vuejs.org\n2. 全新响应式优化与懒水合支持', process: true },
    { name: 'web_fetch', input: { url: 'https://vuejs.org/guide/introduction.html' }, output: 'Vue.js - 渐进式 JavaScript 框架\n上手简单，生态丰富……', process: true },
    { name: 'fs_write', input: { path: 'src/output.txt', content: '演示写入内容' }, output: '已写入 1280 字节 → src/output.txt', process: true },
    // ── 安装/扫描（安装助手） ──
    { name: 'install_skill', input: { source: 'https://github.com/example/skill-pack.git', name: 'my-skill' }, output: '技能「my-skill」已安装到 backend/skills/my-skill', process: true },
    { name: 'uninstall_skill', input: { name: 'old-skill' }, output: '技能「old-skill」已卸载（连接已断开、配置已删除）' },
    { name: 'scan_skill', input: { path: 'backend/skills/my-skill' }, output: '安全扫描判定：PASS\n0 critical / 0 high / 2 info', process: true },
    { name: 'list_installed', input: {}, output: '已安装技能（3 个）：\n- changelog\n- code-review\n- my-skill' },
    // ── MCP 运行时 ──
    { name: 'install_mcp', input: { name: 'filesystem-mcp', source: 'https://github.com/example/mcp-fs.git', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', './data'] }, output: 'MCP「filesystem-mcp」已安装并连接成功（3 个工具，已对 agent 生效）', process: true },
    { name: 'uninstall_mcp', input: { name: 'old-mcp' }, output: 'MCP「old-mcp」已卸载（连接已断开、配置已删除）' },
    // ── 预设管理（创造模式） ──
    { name: 'list_tools', input: {}, output: '- fs_read: 读取文件内容\n- run_command: 执行命令\n- web_search: 联网搜索\n（共 26 个）' },
    { name: 'read_preset', input: { id: 'standard' }, output: '{\n  "id": "standard",\n  "name": "标准模式",\n  "role": "你是资深全栈工程师……"\n}' },
    { name: 'save_preset', input: { id: 'my-writer', name: '文案写手', description: '营销文案创作', role: '你是资深文案……', tools: ['fs_read', 'web_search'] }, output: '已保存预设「文案写手」（id=my-writer）\n运行时检查：PASS（模型 self-test 通过）', process: true },
    { name: 'delete_preset', input: { id: 'my-writer' }, output: '已删除预设 my-writer（文件夹已移除）' },
    // ── 自定义工具管理（创造模式） ──
    { name: 'plan_write', input: { items: [{ text: '拆解任务并列出计划' }, { text: '实现核心功能', done: true }] }, output: '计划已更新（1/2 完成）' },
    { name: 'list_custom_tools', input: {}, output: '- query_ip: 查询指定域名的 IP 解析结果（参数：host）' },
    { name: 'save_custom_tool', input: { name: 'query_ip', description: '查询指定域名的 IP 解析结果', code: 'const r = await fetch(`https://dns.google/resolve?name=${args.host}`)\nreturn await r.json()' }, output: '自定义工具「query_ip」已保存（高风险：所有 agent 调用它时都会先弹权限卡）。', process: true },
    { name: 'delete_custom_tool', input: { name: 'query_ip' }, output: '自定义工具「query_ip」已删除。' },
    // ── 项目自我修改（创造模式专属） ──
    { name: 'project_fs_read', input: { path: 'backend/server.ts' }, output: '/**\n * pi-bridge: DSH frontend <-> Pi Agent <-> LongCat LLM\n */\nimport http from …' },
    { name: 'project_fs_write', input: { path: 'backend/mcpRuntime.ts', content: '// 新增重连逻辑…' }, output: '已写入 842 字节 → backend/mcpRuntime.ts（后端改动需重启生效）', process: true },
    { name: 'project_run_command', input: { command: 'node --import tsx/esm server.ts' }, output: '[pi-bridge] listening on http://127.0.0.1:8766', process: true },
    // ── MCP 动态工具（运行时桥接） ──
    { name: 'mcp__kimi-webbridge-mcp__wb_navigate', input: { url: 'https://example.com' }, output: '已导航到 https://example.com（title: Example Domain）', process: true },
    { name: 'mcp__kimi-webbridge-mcp__wb_snapshot', input: {}, output: '页面快照：heading Example Domain / link More information…' },
    // ── 瞬时直出 ──
    { name: 'fs_read', input: { path: 'src/App.vue' }, output: '<template>\n  <div id="app">…</div>\n</template>' },
    { name: 'fs_delete', input: { path: 'src/old.txt' }, output: '已删除 src/old.txt' },
    { name: 'run_code', input: { code: 'return [1,2,3].reduce((a,b)=>a+b,0)' }, output: '6' },
    { name: 'memory_search', input: { query: '技术栈偏好' }, output: '1. [preference] 用户偏好纯前端技术栈' },
    { name: 'memory_store', input: { content: '用户偏好：纯前端技术栈' }, output: '已记录' },
    { name: 'memory_delete', input: { id: 'mem_123' }, output: '已删除记忆条目' },
    { name: 'knowledge_query', input: { query: '部署流程' }, output: '1. [doc] 部署到 Vercel 的步骤。' },
    { name: 'knowledge_add', input: { path: 'docs/deploy.md', content: '部署步骤…' }, output: '已添加到知识库' },
    { name: 'knowledge_delete', input: { id: 'kb_123' }, output: '已删除知识条目' },
    { name: 'github_search', input: { query: 'vue language:typescript stars:>10000' }, output: '1. ⭐184k [Vue] vuejs/core\n   渐进式 JS 框架核心仓库' },
    { name: 'use_skill', input: { name: 'code-review' }, output: '# 技能已加载：code-review\n\n## 步骤\n\n1. 确定范围…' },
    { name: 'settings_update', input: { userName: '小明' }, output: '已更新设置' },
  ]

  const PROCESS_MS = 5000
  let at = 1000
  for (const t of TOOLS) {
    const key = crypto.randomUUID()
    nodes.push({
      key,
      kind: 'tool',
      text: '',
      reasoning: '',
      status: 'done',
      toolName: t.name,
      toolArgs: t.input,
      toolStatus: t.process ? 'running' : 'done',
      toolResult: t.process ? undefined : t.output || '',
      time: Date.now(),
    })
    if (t.process) {
      const tk = key
      const out = t.output
      setTimeout(() => {
        const node = nodes.find(n => n.key === tk)
        if (node) { node.toolStatus = 'done'; node.toolResult = out || '' }
      }, at + PROCESS_MS)
    }
    at += 500
  }
  // ── LLM 重试过程块演示（复用后端同款状态机 handleLlmRetry）：
  //    周期1 retry(1/2)→retry(2/2)→recovered（✓ 短暂停留后自移除）；周期2 retry→…→failed（琥珀保留）
  const rn = (v: Parameters<typeof piChatStore.handleLlmRetry>[1]) => { piChatStore.handleLlmRetry(cid, v); nextTick(() => scrollToBottom()) }
  setTimeout(() => rn({ phase: 'retry', attempt: 1, maxRetries: 2, reason: 'connect ETIMEDOUT · 模型网关无响应' }), 1500)
  setTimeout(() => rn({ phase: 'retry', attempt: 2, maxRetries: 2, reason: '502 Bad Gateway' }), 4000)
  setTimeout(() => rn({ phase: 'recovered' }), 6500)
  setTimeout(() => rn({ phase: 'retry', attempt: 1, maxRetries: 2, reason: 'connection reset by peer' }), 10500)
  setTimeout(() => rn({ phase: 'retry', attempt: 2, maxRetries: 2, reason: 'connection reset by peer' }), 12500)
  setTimeout(() => rn({ phase: 'failed', reason: 'connection reset by peer' }), 14500)
  nextTick(() => scrollToBottom())
}

function triggerFileInput() {
  fileInput.value?.click()
}

/* ★1011（拖拽增强）：附件被拒的**即时提示** —— 4 秒后自动消失。
   为什么要有：拒收原因原本只在 collectAttachments 里 console.warn（发送那一刻），
   用户看不到 ⇒ 表现就是"我拖了，东西没了"。 */
const attachHint = ref('')
let attachHintTimer: ReturnType<typeof setTimeout> | null = null
function showAttachHint(msg: string) {
  attachHint.value = msg
  if (attachHintTimer) clearTimeout(attachHintTimer)
  attachHintTimer = setTimeout(() => { attachHint.value = '' }, 4000)
}
/** 本次拖入里有几个是**文件夹**（不支持当附件）—— webkitGetAsEntry 只在 drop 的同步处理里有效，不能延后调用 */
function countDroppedDirs(dt: DataTransfer | null): number {
  if (!dt?.items) return 0
  let n = 0
  for (const it of Array.from(dt.items)) {
    if (it.kind !== 'file') continue
    const entry = (it as any).webkitGetAsEntry?.()
    if (entry && entry.isDirectory) n++
  }
  return n
}

function addFilesToAttachments(files: File[], dirsSkipped = 0) {
  /* ★1011（拖拽增强）：体积闸门**前移到"拖入那一刻"** —— 超限的直接拒收 + 当场提示，
     不再等发送时才在 console 里悄悄丢掉。阈值与发送路径同一套常量（见下方 ATTACH_MAX_*）。 */
  let total = attachments.value.reduce((n, a) => n + (a.size || 0), 0)
  let rejected: { name: string; kind: 'one' | 'all' } | null = null
  for (const file of files) {
    if (file.size > ATTACH_MAX_ONE) { rejected = rejected || { name: file.name, kind: 'one' }; continue }
    if (total + file.size > ATTACH_MAX_ALL) { rejected = rejected || { name: file.name, kind: 'all' }; continue }
    total += file.size
    const ext = file.name.split('.').pop()?.toLowerCase() || ''
    if (file.type.startsWith('image/')) {
      // 先立即推入（带 file 引用），让 UI 显示占位；FileReader 异步完成后再补 preview
      attachments.value.push({ name: file.name, size: file.size, type: ext, file })
      const reader = new FileReader()
      reader.onload = (ev) => {
        const idx = attachments.value.findIndex(a => a.name === file.name && a.size === file.size && !a.preview)
        if (idx >= 0) attachments.value[idx].preview = ev.target?.result as string
      }
      reader.readAsDataURL(file)
    } else {
      /* ★1011s（实测反馈"附了控制台 exe，气泡里什么都没有"）：
         非图片附件**必须保留 File 引用** —— 旧代码这里只存 name/size/type，把 file 引用直接丢了，
         于是发送路径既读不到 dataUrl、也读不到 file ⇒ 附件在"发送那一刻"被静默丢弃。
         保留引用后，由发送路径读成 base64 上传到会话工作区（★1011t），气泡里按文件名渲染 chip。 */
      attachments.value.push({ name: file.name, size: file.size, type: ext, file })
    }
  }
  /* ★1011（拖拽增强）：被拒的当场说清原因（文件夹 / 单文件超限 / 总量超限），4 秒后自动消失 */
  if (dirsSkipped > 0) showAttachHint(t('chatInput.hintFolder', { n: dirsSkipped }))
  else if (rejected) showAttachHint(rejected.kind === 'one'
    ? t('chatInput.hintTooBig', { name: rejected.name, size: '8 MB' })
    : t('chatInput.hintTotal', { size: '20 MB', name: rejected.name }))
}

/** ★1011v（实测反馈"输入框好像只能拖入图片，无法拖入文件"）：
 *  ChatInput 拖入非图片时会 `emit('attach', files)`（事件也声明了），但**两处 <ChatInput> 都没接**
 *  ⇒ 文件 emit 出去没人要、无声消失（图片能进是因为它走 readImageFile 直接插进编辑器，不经这个事件）。
 *  这里接住，与"选文件"完全同源 —— 拖进来就变成附件条。 */
function onAttachFiles(files: File[]) {
  if (!files?.length) return
  addFilesToAttachments(files)
}

/* ★1011w（需求要求"扩大到整个输入框那么大"）：拖放热区再扩一层 —— 挂到**输入区外壳**
   （含附件条、工具栏那一片）。ChatInput 内部处理过的拖放会 stopPropagation，所以不会重复触发；
   这里接的是"落在工具栏/附件条上"的拖入。高亮用外壳的 ring，免得拖到按钮上时毫无反馈。 */
const shellDragOver = ref(false)
function onShellDragOver(e: DragEvent) {
  if (!e.dataTransfer?.types?.includes?.('Files')) return
  e.preventDefault()
  shellDragOver.value = true
}
/* ★1011w-4（用户澄清："目前只有工具栏那一块能触发，我要的是整个输入框都作为热区"）：
   根因是"谁绑事件谁才算热区" —— 内层任何 `stopPropagation` 都会让某一块失效（ChatInput 就拦了拖放），
   于是表现为"只有工具栏那片能触发"。改成 **window 级 + 捕获阶段**统一接管：
   不管拖到窗口哪里、内层怎么拦，都能收到 ⇒ 视觉上整个输入框点亮，松手一律加为附件。
   ⚠️ 捕获阶段（addEventListener 第三参 true）是关键：它在内层处理**之前**先跑，内层拦不住。 */
function onWinDragOver(e: DragEvent) {
  const types = Array.from(e.dataTransfer?.types || [])
  if (!types.includes('Files')) return
  e.preventDefault()          // 不 preventDefault 浏览器不允许 drop
  /* ★1011w-5（用户定稿：两个红框各管一件事）：
     · 拖到**输入框**（.input-shell：附件条 / 编辑区 / 工具栏）⇒ 高亮输入框 =「将加为附件」
     · 拖到**消息区**（其余地方）⇒ 高亮消息区 =「将打开预览」（保留原行为）
     关键：两个高亮**只亮一个**。上一版 window 级不分位置地一律点亮输入框，
     于是出现"同时触发两个"。 */
  if (isInInputShell(e.target)) {
    shellDragOver.value = true
    dragOverChat.value = false
    e.stopPropagation()       // 吃掉：别让根级的"预览高亮"再亮起来
  } else {
    shellDragOver.value = false
    dragOverChat.value = true
  }
}
/** 事件目标是否落在输入框外壳里（捕获阶段 e.target 已是最终目标，可靠） */
function isInInputShell(t: EventTarget | null): boolean {
  return !!(t instanceof Element && t.closest('.input-shell'))
}
function onWinDragLeave(e: DragEvent) {
  /* 只在真正离开窗口时复位（relatedTarget === null）—— 否则鼠标划过任何子元素都会闪一下 */
  if (e.relatedTarget == null) {
    shellDragOver.value = false
    dragOverChat.value = false
  }
}
function onWinDrop(e: DragEvent) {
  const files = Array.from(e.dataTransfer?.files || [])
  /* ★1011（拖拽增强）：目录数必须在**同步**处理里数（webkitGetAsEntry 在 drop 之后就失效）。
     注意"只拖文件夹"时 files 恰好为空 —— 所以"空 files 就早退"会连提示都没有，得按 files+dirs 一起判。 */
  const dirs = countDroppedDirs(e.dataTransfer)
  shellDragOver.value = false
  dragOverChat.value = false
  /* ★1011w-5：只有落在**输入框**里才由我们吃掉（加为附件）；落在消息区则**放行**，
     交给根级 onChatDrop 走原逻辑（打开预览 tab）。 */
  if (!isInInputShell(e.target)) return
  if (!files.length && dirs === 0) return
  e.preventDefault()
  e.stopPropagation()         // 吃掉：内层不再当"插图/预览"处理，行为统一为"加附件"
  addFilesToAttachments(files, dirs)
}

function onShellDragLeave() {
  shellDragOver.value = false
}
function onShellDrop(e: DragEvent) {
  /* ★1011w-3：外壳接住后**阻止冒泡** —— 否则根级 section 的 onChatDrop 还会再跑一次
     （它原来会把文件读成"预览 tab"）⇒ 一次拖拽既加附件又开预览。 */
  e.stopPropagation()
  shellDragOver.value = false
  const files = Array.from(e.dataTransfer?.files || [])
  const dirs = countDroppedDirs(e.dataTransfer)
  if (!files.length && dirs === 0) return
  e.preventDefault()
  addFilesToAttachments(files, dirs)
}

function onFileSelected(e: Event) {
  const input = e.target as HTMLInputElement
  if (!input.files) return
  addFilesToAttachments(Array.from(input.files))
  input.value = ''
}

/** ★1011s：读 File → dataURL（图片补读、非图片取 base64 都用它） */
function readFileDataUrl(file: File): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result || ''))
    r.onerror = () => reject(new Error('read failed: ' + file.name))
    r.readAsDataURL(file)
  })
}

/* ★1011s：附件体积上限 —— 超限的**留在编辑器里**、绝不静默丢弃。
   消息体要随 SSE 与 transcript 走，几十 MB 会把链路和存储都拖垮，所以必须有闸门。 */
const ATTACH_MAX_ONE = 8 * 1024 * 1024
const ATTACH_MAX_ALL = 20 * 1024 * 1024

/** ★1011s + ★1011t：把编辑器里的附件收成"可发送"的两份 ——
 *  images = 图片（dataUrl，喂 vision）；
 *  files  = 非图片（**上传一次落进会话工作区**，消息里只带相对路径 —— 见 persistUpload 那套取舍）；
 *  dropped = 超限/上传失败/读失败的（调用方把它们留在编辑器里，用户能看见"没发出去"）。 */
async function collectAttachments(sessionId: string): Promise<{
  images: Array<{ name: string; dataUrl: string }>
  files: Array<{ name: string; size: number; mime: string; relPath?: string }>
  dropped: string[]
}> {
  const images: Array<{ name: string; dataUrl: string }> = []
  const files: Array<{ name: string; size: number; mime: string; relPath?: string }> = []
  const dropped: string[] = []
  let total = 0
  for (const a of attachments.value) {
    const looksImage = !!a.preview || !!a.file?.type?.startsWith('image/')
    if (looksImage) {
      let d = a.preview
      if (!d && a.file) { try { d = await readFileDataUrl(a.file); a.preview = d } catch { /* 读失败按丢弃处理 */ } }
      if (d) { images.push({ name: a.name, dataUrl: d }); continue }
    }
    if (!a.file) { dropped.push(a.name); continue }
    if (a.size > ATTACH_MAX_ONE || total + a.size > ATTACH_MAX_ALL) { dropped.push(a.name); continue }
    /* ★1011t（用户定 B 方案）：非图片附件**上传一次、落进会话工作区**，消息里只带相对路径 ——
       消息轻（几十字节），而且 AI 能用现成工具**直接读到这个文件**。
       上传失败或会话还没工作区 ⇒ 归入 dropped（留在输入框让用户看见），**绝不假装成功**。 */
    try {
      const dataUrl = await readFileDataUrl(a.file)
      const mm = /^data:([^;]*);base64,(.*)$/s.exec(dataUrl)
      if (!mm) { dropped.push(a.name); continue }
      const r: any = await chatStore.bridgeRpc('session.uploadFile', { sessionId, name: a.name, dataBase64: mm[2] })
      if (!r?.relPath) { dropped.push(a.name); continue }
      files.push({ name: a.name, size: a.size, mime: a.file.type || 'application/octet-stream', relPath: r.relPath })
      total += a.size
    } catch (e: any) {
      console.warn('[attach] 上传失败：', a.name, e?.message || e)
      dropped.push(a.name)
    }
  }
  return { images, files, dropped }
}

/** ★1011s：发送后清空编辑器附件时用 —— 只清"确实发出去了"的，超限/失败的留着让用户看得见 */
function keepDroppedAttachments(dropped: string[]) {
  if (!dropped.length) { attachments.value = []; return }
  const set = new Set(dropped)
  attachments.value = attachments.value.filter(a => set.has(a.name))
}

/** ★1011s：把附件标记拼进消息正文 —— 图片走既有 `[[图片:N]]` 位置标记，文件走 `[[文件:名字]]`。
 *  与图片标记**同一种机制**（后端/历史/回显都据此重建，渲染端按标记拆段显示）：
 *  · `[[图片:N]]` 早就"发送/入队一律保留"（见 sendMessage 里 ★0927 netfix 的注释）；
 *  · 纯附件无文字时，兜底字面量（'[图片]' / '[文件]'）不再拼进正文，免得气泡里多一截难看的文本。 */
function withAttachMarkers(
  text: string,
  imgs: Array<{ name: string; dataUrl: string }>,
  files: Array<{ name: string; size: number; mime: string; relPath?: string }>,
): string {
  const base = text === '[图片]' || text === '[文件]' ? '' : text
  const parts: string[] = []
  if (base) parts.push(base)
  /* ★1015 修（实测反馈"图片在消息最后又出现了一次"，老 bug 回归）：
     正文里可能**已经带了这个标记** —— 编辑器里的图片胶囊在 `getPlainText()` 时就会转成
     `[[图片:N]]`（编辑重发 / 返回输入框都是先把图插成胶囊 ⇒ 取文本时已是标记），
     这里再无条件追加就成了"一图两标"，气泡里同一张图渲染两次。
     判据：base 里已有该标记就不再追加（位置由正文保真；追加只用来补"没进正文的图"）。 */
  /* ★1011t：文件用**工作区相对路径**（uploads/xxx）—— 消息轻，而且 AI 能照着这个路径直接读文件。
     没拿到 relPath（上传失败）就不写标记，免得给 AI 一个不存在的路径。 */
  for (const f of files) {
    if (f.relPath && !base.includes(`[[文件:${f.relPath}]]`)) parts.push(`[[文件:${f.relPath}]]`)
  }
  imgs.forEach((_, i) => {
    if (!base.includes(`[[图片:${i}]]`)) parts.push(`[[图片:${i}]]`)
  })
  return parts.join(' ')
}

function removeAttachment(index: number) {
  attachments.value.splice(index, 1)
}

function nowTime(): string {
  const d = new Date()
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function nextMessageId(convId: number): number {
  const list = conversationMessages.value[convId] || []
  return list.reduce((m, x) => Math.max(m, x.id), 0) + 1
}

/* ══ 0909⑦ 忙时通道（插话/排队）══
 * Enter（ChatInput @send）= 走 steer/queue 分流；发送按钮（@click）与显示态同源：
 * 忙时且输入框无草稿=「停止」（点击→session.cancel）；忙时有草稿=「发送」（点击→排队/插话通道）；
 * 空闲=「发送」（正常发送）。旧版显示"停止"却把点击路由进排队=用户所见"点停止无效"根因。 */
function busyChannelOn(): boolean {
  return !!(isGenerating.value || isReplying.value) && !pendingCard.value && !dmTarget.value
}
/** 按钮当前是否处于"停止"形态（与 onButtonSend 的路由判定严格同源） */
/** ★0930（MCP 实测抓的缺口）：分身即派即回后主回合立刻结束，停止按钮跟着消失——
 *  用户"点停止结束分身"没了入口。分身 run 还在跑（subAgent.status==='running'）就该有停止键，
 *  点它走 session.cancel（中止级联：杀命令进程+气泡「用户已停止」+不重派，E2E 已验）。 */
const cloneBusy = computed(() => {
  if (props.conversation?.id == null) return false
  return piChatStore.getNodes(String(props.conversation.id)).some((n: any) => n.subAgent && n.subAgent.status === 'running')
})
const showStopBtn = computed(() => (isSending.value || ((isGenerating.value || isReplying.value || cloneBusy.value) && !pendingCard.value)) && !draftHasText.value)
/** 按钮点击：停止形态=停止；否则=发送（忙时由 sendMessage 内部分流进排队/插话） */
/** ★0926 修（实测反馈"忙时发的消息刷新后消失"）：以**编辑器真实内容**为准判定"有没有内容"。
 *  为什么需要：按钮形态 showStopBtn 依赖 draftHasText —— 它由 ChatInput 的 MutationObserver **异步上报**，
 *  存在"刚打完字就点"的时序窗口 ⇒ 点击被路由成 stopGeneration()，文字留在输入框没发出去（刷新/切会话即丢）。
 *  getPlainText 是 ChatInput 暴露的实时读取口，天然无时序问题。 */
function hasLiveInput(): boolean {
  try {
    const t = String((chatInputRef.value as any)?.getPlainText?.() ?? '').trim()
    return t.length > 0 || attachments.value.length > 0
  } catch { return false }
}
function onButtonSend() {
  if (showStopBtn.value && !hasLiveInput()) {
    stopGeneration()
    return
  }
  void sendMessage()
}
/** Enter 发送：忙时按设置分流 steer/queue；空闲正常发送 */
function onEnterSend(channel?: 'ctrl') {
  void sendMessage(channel)
}
/** 忙时发送：wantSteer=true 走 session.steer（pi 原生队列，当前轮工具跑完即注入）；
 *  false 走 session.queue.add（整轮结束后后端自动逐条发出）。失败（steer 竞态/队列满）退回提示，消息不丢。 */
async function busySend(convId: string, text: string, skillTags: string[], editorImages: Array<{ name: string; dataUrl: string }>, wantSteer: boolean) {
  /* ★1011s：附件统一由 collectAttachments 收（顺带保留原有的"快速发送防丢图"补读）——
     图片走 dataUrl 喂 vision；非图片读成 base64，随消息交给后端落盘到会话工作区（AI 可读）。 */
  const _col = await collectAttachments(String(convId))
  const imgAttachments = _col.images
  const fileAttachments = _col.files
  if (_col.dropped.length) console.warn('[attach] 未随消息发送（超限或读失败，已留在输入框）：', _col.dropped)
  for (const img of editorImages) {
    if (!imgAttachments.some(x => x.dataUrl === img.dataUrl)) imgAttachments.push(img)
  }
  const sendText = text || (imgAttachments.length ? '[图片]' : fileAttachments.length ? '[文件]' : '')
  const sendModel = await providersStore.modelForSend(convId)
  const clientMessageId = crypto.randomUUID()
  const clearInput = () => {
    chatInputRef.value?.clearEditor()
    if (imgAttachments.length || fileAttachments.length) keepDroppedAttachments(_col.dropped)
    // 0910 反馈2：内容已发出去 → 草稿暂存必须一起清（否则发出去的内容下次进草稿又冒回输入框）
    clearDraftStash()
  }
  if (wantSteer) {
    try {
      /* ★1011s：正文带上附件标记（图片 [[图片:N]] + 文件 [[文件:名字]]）—— 乐观气泡、发后端的 message、
         历史重建共用同一份文本，渲染端才能按标记拆段显示（含非图片附件）。 */
      const steerText = withAttachMarkers(sendText, imgAttachments, fileAttachments)
      const r = await chatStore.bridgeRpc('session.steer', {
        sessionId: convId, message: steerText, kind: 'steer', clientMessageId,
        attachments: imgAttachments.length ? imgAttachments : undefined,
        skills: skillTags.length ? skillTags : undefined,
        model: sendModel || undefined, effort: reasoningMode.value,
      }) as any
      if (r?.steered) {
        clearInput()
        /* ★ 0925：乐观气泡是前端直 push 的，不像后端回显链路那样由 piChat store 补占位 ——
           这里直接用同一份 steerText（已含图片/文件标记），PiChatView 的 userSegments 即可拆段渲染。 */
        const optImgs = imgAttachments.length ? imgAttachments.map(a => a.dataUrl) : undefined
        const optText = steerText
        // 乐观气泡：pi 注入时会发 message_start(user) 回显（piChat 按 steerOptimistic+文本匹配回收，
        // 0909⑨：注入可晚于发送 10s+，旧 5s 窗罩不住导致"光圈不消失+回显又冒一条"双份）
        piChatStore.getNodes(convId).push({ key: clientMessageId, kind: 'user', text: optText, reasoning: '', status: 'done', time: Date.now(), skills: skillTags.length ? skillTags : undefined, images: optImgs, steerPending: true, steerOptimistic: true })
        nextTick(() => scrollToBottom('smooth'))
        return
      }
      // agent 恰好空闲（竞态）→ 降级：直接当普通发送走队列（消息不丢，语义=排队等下轮）
    } catch (e: any) {
      notificationsStore.push({ level: 'error', title: t('queue.steerFail'), content: String(e?.message || e), type: 'system' })
      return
    }
  }
  // 排队通道（默认 queue / steer 降级 / Ctrl 反向=queue）
  try {
    /* ★1011s：排队路径同样带附件标记（marker 与 message 同源，改成一处拼、多处用） */
    const queueText = withAttachMarkers(sendText, imgAttachments, fileAttachments)
    const r = await chatStore.bridgeRpc('session.queue.add', {
      sessionId: convId, message: queueText, clientMessageId,
      attachments: imgAttachments.length ? imgAttachments : undefined,
      skills: skillTags.length ? skillTags : undefined,
      model: sendModel || undefined, effort: reasoningMode.value,
    }) as any
    if (r?.queue) {
      /* ★ 0925（要求"撤回编辑"功能）：给本次发送落下的队列项补 markerText（带 [[图片:N]]
         位置标记的原文）—— 后端 queue 账本只存干净 text，标记仅前端保存，
         供点编辑按钮时照标记把图片标签插回原文位置（队列项撤回编辑 = queueEditItem）。
         匹配口径：未标记者里从后往前找 text 相同且附件数相同的（刚 add 的就是它）。 */
      const list: any[] = Array.isArray(r.queue) ? r.queue : []
      const marker = queueText
      for (let i = list.length - 1; i >= 0; i--) {
        const q = list[i]
        if (q && !q.markerText && q.text === queueText && (q.attachments?.length || 0) === imgAttachments.length) {
          q.markerText = marker
          break
        }
      }
      queueStore.set(convId, list)
    }
    clearInput()
    nextTick(() => scrollToBottom('smooth'))
  } catch (e: any) {
    notificationsStore.push({ level: 'error', title: t('queue.addFail'), content: String(e?.message || e), type: 'system' })
  }
}
/** ★0927 N1 抽出：把一条排队项"照原样"回灌编辑器（文字/图片位置标记/技能标签都不丢）。
 *  · removeFromQueue=true（默认，队列条-编辑的语义）→ 先调 RPC 把该条从后端队列移除；
 *  · removeFromQueue=false → 后端已经把它移出来了（停止键丙：queue-return-to-editor 帧），只负责回灌；
 *  · replaceEditor=false（丙路径）→ 编辑器里已有草稿时**不清空**，用空行分隔追加（绝不吞用户正在写的东西）。 */
async function restoreQueueItemToEditor(item: QueueItem, replaceEditor = true, removeFromQueue = false) {
  const convId = props.conversation?.id
  if (convId == null) return
  try {
    if (removeFromQueue) {
      const r = await chatStore.bridgeRpc('session.queue.remove', { sessionId: String(convId), id: item.id }) as any
      if (r?.queue) queueStore.set(convId, r.queue)
    }
    const keepDraft = !replaceEditor && hasLiveInput()
    if (keepDraft) chatInputRef.value?.insertText('\n\n')
    else chatInputRef.value?.clearEditor()
    const imgs = Array.isArray(item.attachments) ? item.attachments.filter(a => a && a.dataUrl) : []
    const usedIdx = new Set<number>()
    if (item.markerText) {
      const parts = item.markerText.split(/\[\[图片:(\d+)\]\]/g)   // 偶数位=文字、奇数位=图片序号（0 基）
      for (let k = 0; k < parts.length; k++) {
        if (k % 2 === 0) {
          const seg = parts[k].replace(/\n{3,}/g, '\n\n')
          if (seg) chatInputRef.value?.insertText(seg)
        } else {
          const idx = Number(parts[k])
          const d = imgs[idx]
          if (d) { insertImageTagToInput(d.dataUrl, idx + 1); usedIdx.add(idx) }
        }
      }
    } else if (item.text) {
      chatInputRef.value?.insertText(item.text)
    }
    /* 没被任何标记引用的图片 → 保底追加（绝不丢图） */
    imgs.forEach((a, i) => { if (!usedIdx.has(i)) insertImageTagToInput(a.dataUrl, i + 1) })
    if (item.skills?.length) for (const s of item.skills) chatInputRef.value?.insertSkillTag(s)
    /* ★ 0925：撤回后聚焦编辑器、光标落末尾 —— 用户原话"撤回到输入框上方并进入编辑状态" */
    chatInputRef.value?.focusEditor()
  } catch (e: any) {
    notificationsStore.push({ level: 'error', title: t('queue.editFail'), content: String(e?.message || e), type: 'system' })
  }
}
/** 队列条-编辑：★ 0925（需求的功能）原条目删除 + 内容**照原样**回灌编辑器并聚焦进入编辑态
 * （重发即新排队项；比"原地改文本"更符合直觉，且编辑器能带 skill/图片标签，后端 update 只支持纯文本/附件替换）。 */
async function queueEditItem(item: QueueItem) {
  await restoreQueueItemToEditor(item, true, true)
}
/** ★0927 N1（乙）：用户点「继续发送」→ 清后端暂停态 + 立刻续发 */
async function queueResume() {
  const convId = props.conversation?.id
  if (convId == null) return
  try {
    const r = await chatStore.bridgeRpc('session.queue.resume', { sessionId: String(convId) }) as any
    if (r?.queue) queueStore.set(convId, r.queue)
    queueStore.setPaused(convId, false)
  } catch (e: any) {
    notificationsStore.push({ level: 'error', title: t('queue.resumeFail'), content: String(e?.message || e), type: 'system' })
  }
}
/** ★0927 N1：「全部撤回编辑」——后端清队 + 内容全部回灌编辑器（多条合并：正文按空行分隔，图片按序追加） */
async function queuePurgeAll() {
  const convId = props.conversation?.id
  if (convId == null) return
  try {
    const r = await chatStore.bridgeRpc('session.queue.purge', { sessionId: String(convId) }) as any
    const items = Array.isArray(r?.items) ? r.items as QueueItem[] : []
    queueStore.set(convId, [])
    queueStore.setPaused(convId, false)
    if (!items.length) return
    chatInputRef.value?.clearEditor()
    const imgs: Array<{ name: string; dataUrl: string }> = []
    for (const it of items) {
      if (it?.text) chatInputRef.value?.insertText((items.indexOf(it) ? '\n\n' : '') + it.text)
      if (Array.isArray(it?.attachments)) for (const a of it.attachments) { if (a?.dataUrl) imgs.push(a) }
      if (it?.skills?.length) for (const s of it.skills) chatInputRef.value?.insertSkillTag(s)
    }
    imgs.forEach((a, i) => insertImageTagToInput(a.dataUrl, i + 1))
    chatInputRef.value?.focusEditor()
  } catch (e: any) {
    notificationsStore.push({ level: 'error', title: t('queue.purgeFail'), content: String(e?.message || e), type: 'system' })
  }
}
async function queueRemoveItem(id: string) {
  const convId = props.conversation?.id
  if (convId == null) return
  queueStore.optimisticRemove(convId, id)
  try {
    const r = await chatStore.bridgeRpc('session.queue.remove', { sessionId: String(convId), id }) as any
    if (r?.queue) queueStore.set(convId, r.queue)
  } catch (e: any) {
    queueStore.set(convId, queueStore.get(convId)) // 失败回滚=重拉
    const cur = await chatStore.bridgeRpc('session.queue', { sessionId: String(convId) }).catch(() => null) as any
    if (cur?.queue) queueStore.set(convId, cur.queue)
    notificationsStore.push({ level: 'error', title: t('queue.removeFail'), content: String(e?.message || e), type: 'system' })
  }
}
async function queueMoveItem(id: string, to: number) {
  const convId = props.conversation?.id
  if (convId == null) return
  try {
    const r = await chatStore.bridgeRpc('session.queue.move', { sessionId: String(convId), id, to }) as any
    if (r?.queue) queueStore.set(convId, r.queue)
  } catch (e: any) {
    notificationsStore.push({ level: 'error', title: t('queue.moveFail'), content: String(e?.message || e), type: 'system' })
  }
}
/** 0911 排队条-插话：把该条不等本轮结束、立即注入进行中的回复（session.steer）。
 *  成功 → 从队列移除（内容已进入本轮，与忙时 steer 通道同款乐观气泡回收）；
 *  竞态（agent 恰好空闲/本轮已结束）→ 提示"未生效"，条目保留在队列，不丢内容。 */
async function queueSteerItem(item: QueueItem) {
  const convId = props.conversation?.id
  if (convId == null) return
  /* ★0930 发送防重：双击"插话"按钮=同一排队条注入两次（两次 session.steer → 双份消息+双胶囊）
     ★1004：防重改单源 sendGuard，指纹与 sendMessage 同口径（纯文本；空文本用图片指纹） */
  if (isDuplicateSend((item.text || '') || `[图片×${item.attachments?.length || 0}]`)) return
  try {
    const clientMessageId = crypto.randomUUID()
    const r = await chatStore.bridgeRpc('session.steer', {
      sessionId: String(convId), message: item.text, kind: 'steer', clientMessageId,
      attachments: item.attachments?.length ? item.attachments : undefined,
      skills: item.skills?.length ? item.skills : undefined,
      model: item.model || undefined, effort: item.effort,
    }) as any
    if (r?.steered) {
      /* ★ 0925c：排队项转 steer 的乐观气泡也要拼 [[图片:N]] 占位（同 busySend steer 分支口径；
         item.markerText 有就直接用，没有则按 attachments 现拼）——否则排队里带的图在气泡里不显示。 */
      const qImgs = item.attachments?.length ? item.attachments.map(a => a.dataUrl) : undefined
      const qText = qImgs?.length
        ? (item.markerText || [item.text === '[图片]' ? '' : item.text, ...qImgs.map((_: string, i: number) => `[[图片:${i}]]`)].filter(Boolean).join(' '))
        : item.text
      // 乐观气泡：pi 注入时会发 message_start(user) 回显（piChat 按 steerOptimistic+文本匹配回收）
      piChatStore.getNodes(convId).push({ key: clientMessageId, kind: 'user', text: qText, reasoning: '', status: 'done', time: Date.now(), skills: item.skills?.length ? item.skills : undefined, images: qImgs, steerPending: true, steerOptimistic: true })
      const rr = await chatStore.bridgeRpc('session.queue.remove', { sessionId: String(convId), id: item.id }) as any
      if (rr?.queue) queueStore.set(convId, rr.queue)
      nextTick(() => scrollToBottom('smooth'))
      return
    }
    notificationsStore.push({ level: 'error', title: t('queue.steerFail'), content: t('queue.steerIdle'), type: 'system' })
  } catch (e: any) {
    notificationsStore.push({ level: 'error', title: t('queue.steerFail'), content: String(e?.message || e), type: 'system' })
  }
}

/* ★0930 修（同一条消息被重复投递/重复引导两次，实测 session.steer 840ms 内注入两条）：**发送防重**。
   ★1004（实测反馈"同一条消息 18ms 建出两个重复会话"）：判重挪进 utils/sendGuard.ts 单源 + **提到
   任何 await 之前**——原实现判重在 `await getImageAttachments()` 之后，双触发并发穿过 await、
   图片提取竞态还能算出不同指纹 ⇒ 两条全放行 ⇒ 双会话。现在同步段就拦死（详见 sendGuard.ts 注释）。 */
import { isDuplicateSend } from '@/utils/sendGuard'
import { swallowed } from '@/utils/swallowed'
/** ★1015（实测反馈"点编辑发送，内容会在输入框出现一下再消失，消息多时更明显，体感不好"）：
 *  编辑重发**不再走"回填底部编辑器 → 立刻发送"**那条路 —— 从回填到发送完成之间，内容会真的渲染进
 *  输入框（消息越多渲染越慢，闪现越久）。改为把编辑好的正文/图片/技能标签**直接交给发送函数**，
 *  编辑器全程不碰；万一发送失败，再把内容退回输入框（见 onUserEditSend 的 catch）。
 *  ⚠️ 可选入参：不传 override 时，下面每条分支都与原实现完全一致（普通发送路径不受影响）。 */
interface SendOverride {
  text: string
  images?: Array<{ name: string; dataUrl: string }>
  skills?: string[]
}
async function sendMessage(channel?: 'ctrl', override?: SendOverride) {
  // 0914b：用户手势里顺手拉起浏览器通知授权（仅 default 时弹一次）——AI 回复完成要弹系统通知，必须先有权限
  void import('@/utils/systemNotify').then((m) => m.primeNotificationPermission()).catch(() => { /* ignore */ })
  // 忙时且通道分流不可用（成员单聊挂起等）：无草稿=纯停止；有草稿=停止后继续发送（旧语义）。
  // 注：按钮的"停止形态"点击已改走 onButtonSend→stopGeneration，不再进这里；Enter 仍保留该兜底。
  if ((isGenerating.value || isReplying.value) && !busyChannelOn()) {
    stopGeneration()
    if (!draftHasText.value) return
  }
  if (!chatInputRef.value) return
  // skill 标签不算正文：剥离后取纯文本；标签名随 payload.skills 发送触发后端引导。
  // 图片标签 → [[图片:N]] 位置标记（本地气泡内联展示用）；发送后端前剔除标记
  const skillTags = override?.skills?.length ? override.skills.map(String) : chatInputRef.value.getSkillTags()
  /* ★1015：编辑重发（override）直接用传入的正文，**不读编辑器** —— 编辑内容里已含 `[[图片:N]]` 位置标记 */
  const message = override
    ? String(override.text || '')
    : (chatInputRef.value.getPlainTextExcludingSkills() || chatInputRef.value.getPlainText())
  // ★0927 netfix（图片顺序）：[[图片:N]] 是**正式的位置标记**，发送/入队一律保留（存储与历史重建据此保序）；
  //   标题/列表预览等纯文本场景用 plainMessage（剥离版）。原实现发送前剥标记 → 图片位置丢失、一律掉到末尾。
  const cleanMessage = message.replace(/\n{3,}/g, '\n\n').trim()
  const plainMessage = message.replace(/\[\[图片:\d+\]\]/g, '').replace(/\n{3,}/g, '\n\n').trim()
  /* ★0930 发送防重 + ★1004 前移：同文本 2s 内的重复触发=同一内容被发了两次（IME 确认 Enter/双击/连按），
     直接丢弃第二次。**必须在任何 await 之前判**（1004 实锤：原在 await 图片提取后判，双触发并发穿过
     await 全放行 → 18ms 建出两个重复会话）；纯图片消息（无文本）在提取完后补一道图片指纹判重。 */
  if (cleanMessage && isDuplicateSend(cleanMessage)) return
  // 多模态：提取编辑器中的图片 dataUrl（拖拽/粘贴的图片通过 insertImageTag 存在 data-preview 里），
  // 必须在 clearEditor 之前！之后编辑器清空就提取不到了；async 等待 FileReader 完成避免偶发丢失
  const editorImages = override?.images?.length
    ? override.images
    : (chatInputRef.value.getImageAttachments ? await chatInputRef.value.getImageAttachments() : [])
  if (!cleanMessage && editorImages.length === 0) return
  if (!cleanMessage && isDuplicateSend(`[图片×${editorImages.length}]${editorImages.map(a => String(a?.dataUrl || '').length).join(',')}`)) return
  // 无选中会话：自动新建并选中（左侧聊天列表新增一条），带上空态选择的工作模式与预设
  // 团队模式：主预设 = 团队的 mainPreset（team-lead）；会话绑定 teamId（P2 编排运行时消费）
  const teamForSend = selectedMode.value === 'team' ? teamsStore.teams.find(t => t.id === selectedTeamId.value) : null
  // 0904 bug4：预设按会话隔离——已有对话恒用自己的 presetId（真实数据；万一无值补真实默认预设并落回，
  // 而非拿空态选择器的临时值覆盖）；空态首条才用选择器的暂存创建
  const presetForSend = teamForSend
    ? teamForSend.mainPreset
    : (props.conversation?.id != null
      ? (props.conversation.presetId || agentPresetsStore.defaultPresetId)
      : selectedPresetId.value)
  const teamIdForSend = teamForSend?.id
  let convId = props.conversation?.id
  if (convId == null) {
    // ⑥ 草稿态首发：此刻才真正建会话+工作区，落到草稿所属项目（本体聊天=project_id null）
    const conv = await conversationsStore.createConversation(conversationsStore.draftProjectId ?? null, presetForSend, teamIdForSend)
    if (!conv) return
    await conversationsStore.openConversation(conv.id)
    conversationsStore.draftProjectId = null
    convId = conv.id
      /* ★0926②：草稿态首发必须**立刻**把本窗口的"会话级 SSE 订阅"切到新会话。
         否则：createConversation → openConversation 是靠 Vue watcher 异步重订会话流（App.vue:142），
         而后端这一轮的首批帧（工具/询问卡/权限卡）可能先到 → 投给"还没有订阅者的桶"= 直接丢，
         前端只能靠刷新补账才看到卡（0926 实报：3 窗口跑任务，卡全部刷新后才出现，agent 白等 144 秒）。
         这里是显式订阅 + 幂等（subscribeSession 同 id 直接 return）。 */
      chatStore.subscribeSession(String(conv.id))
      // ★ 0922 修：草稿态首发 = 这条会话马上就要有用户消息了 —— 必须立刻标记，
      // 否则会被 Sidebar「空对话不进主列表」的规则挡掉（表现为：发完消息列表里没有，刷新才出现）
      ;(conv as any).msgCount = 1
  } else {
    // 已有会话：预设变化时把暂存选择落地（仅空白会话生效，applyPresetToBlank 内部有判断）
    if (props.conversation?.presetId !== presetForSend) {
      await conversationsStore.applyPresetToBlank(String(convId), presetForSend)
    }
    // 团队绑定自愈（三层）：
    // ① 前端明确选了团队 → 用它
    // ② 未选但会话主预设是某团队的 mainPreset（team-lead）→ 推断绑该团队（修复历史丢 teamId 的会话）
    // ③ 用户明确切回预设模式（且会话预设不是 team-lead）→ 解绑
    // 刷新后选择为空 ≠ 解绑——不能把后端已有的 teamId 清掉（测试3 曾被清成 undefined）
    const currentConv = conversationsStore.getById(String(convId)) as any
    const inferredTeamId = !teamIdForSend && currentConv?.presetId === 'team-lead'
      ? (teamsStore.teams.find(t => t.mainPreset === 'team-lead')?.id || '')
      : ''
    const effectiveTeamId = teamIdForSend || inferredTeamId
    if (effectiveTeamId) {
      try { await chatStore.bridgeRpc('session.configure', { sessionId: String(convId), teamId: effectiveTeamId }) }
      catch (e) { swallowed('团队绑定未同步到后端（本地已切团队、后端仍按旧绑定走）', e) }
      if (currentConv) currentConv.teamId = effectiveTeamId
    } else if (selectedMode.value !== 'team' && currentConv?.presetId !== 'team-lead') {
      // 明确切回预设/外部模式且不是团队指挥官会话 → 解绑
      try { await chatStore.bridgeRpc('session.configure', { sessionId: String(convId), teamId: '' }) }
      catch (e) { swallowed('团队解绑未同步到后端（本地已解绑、后端仍绑着团队）', e) }
      if (currentConv) currentConv.teamId = undefined
    }
  }
  // ══ 0909⑦ 忙时通道分流（AI 回复中 Enter/Ctrl+Enter 走插话或排队，不整轮停止）══
  // 判定"忙"：isGenerating（本窗口）∨ replying（后端权威）；审批/询问卡挂起与成员单聊走原路径。
  // 默认通道=设置→通用 busySendMode；Ctrl+Enter=反向通道。
  if (busyChannelOn()) {
    const defaultMode = settingsStore.general.busySendMode || 'queue'
    const wantSteer = channel === 'ctrl' ? defaultMode !== 'steer' : defaultMode === 'steer'
    await busySend(String(convId), cleanMessage, skillTags, editorImages, wantSteer)
    return
  }
  // ★ 0922 修（第 1 条）：本会话马上要有用户消息 → 立刻把列表计数抬到 ≥1，
  // 否则 Sidebar 的「空对话不进主列表」会把它挡掉（表现：发完消息列表没它，刷新才出现）。
  {
    const _c = conversationsStore.getById(String(convId)) as any
    if (_c) _c.msgCount = Math.max(Number(_c.msgCount) || 0, 1)
  }
  isSending.value = true
  isGenerating.value = true
  // 本轮计时起表（0902 反馈 #7）
  startTurnTimer(String(convId))
  // 兜底：300s 未收到结束事件才复位（防 SSE 断连卡死；多轮工具调用期间不提前复位）
  clearTimeout(generateTimeout.value)
  generateTimeout.value = setTimeout(() => {
    if (isGenerating.value) {
      isGenerating.value = false
    }
  }, 300000)
  // 本地显示用户消息（PiChatView 渲染 pi 节点；SSE 回显会重复，本地 push 即时显示�?  // 先清理残�?streaming 节点（abort 中断�?finalize 的），避免内容串到新一�?
  piChatStore.finalizeStreaming(String(convId))
  const wasEmpty = piChatStore.getNodes(String(convId)).length === 0
  const now = nowTime()
  // 成员单聊（0904）：本轮目标是某成员 → 用户气泡加 @名字 前缀，且不起主 agent 占位气泡
  //（成员回复由 subagent-event 生成独立 subAgent 气泡；主助手不代答）
  const dm = dmTarget.value
  piChatStore.getNodes(String(convId)).push({
    key: crypto.randomUUID(),
    kind: 'user',
    text: dm ? `@${dm.name} ${message}` : message,
    reasoning: '',
    status: 'done',
    time: Date.now(),
    skills: skillTags.length ? skillTags : undefined,
    // 0910：单聊气泡标记——不在主会话 transcript 里，删除轮次计数要跳过（与后端 turnIndex 对齐）
    ...(dm ? { dm: true } : {}),
  })
  if (!dm) piChatStore.beginAssistant(String(convId))
  /* ★1015：编辑重发（override）**不清编辑器** —— 编辑器里装的是用户自己的草稿，跟这次重发无关 */
  if (!override) chatInputRef.value.clearEditor()
  /* ★1010w（已定案修订 1004q）：**不再把技能标签放回输入框** —— 用户选用那一轮显示标签，
     发出去之后输入框保持干净（输入框旁的技能按钮仍显示"使用中"，用不着标签占位、也不挡停止键）。
     选用状态本身照旧跨轮粘住（SkillPicker 维护），只是不再往输入框里塞标签。 */
  clearDraftStash()
  // 标题：首条用户消息自动命名（仅一次）；列表预览同�?


  conversationsStore.ensureAutoTitle(convId, plainMessage || '图片')
  conversationsStore.setLastMessage(convId, plainMessage || '[图片]', now)
  nextTick(() => scrollToBottom(wasEmpty ? 'auto' : 'smooth'))
  // 500ms 后复位 isSending（isGenerating 由 SSE expectFinal 事件控制）
  setTimeout(() => { isSending.value = false }, 500)
  // 异步发消息（不 await，SSE 事件驱动 UI 更新；失败时复位）
  // 多模态：先把还没读取完的图片文件补读成 dataURL（FileReader 异步，避免用户快速发送时图片丢失）
  /* ★1011s：统一由 collectAttachments 收（顺带保留原有的"快速发送防丢图"补读）——
     图片走 dataUrl 喂 vision；非图片留元信息，随消息正文的 [[文件:名字]] 标记带出去。
     ★1015：编辑重发（override）**不读输入框附件** —— 否则会把用户随手留在输入框的草稿附件一起发出去。 */
  const _col = override
    ? { images: [] as Array<{ name: string; dataUrl: string }>, files: [] as Array<{ name: string; size: number; mime: string; relPath?: string }>, dropped: [] as string[] }
    : await collectAttachments(String(convId))
  const imgAttachments = _col.images
  const fileAttachments = _col.files
  if (_col.dropped.length) console.warn('[attach] 未随消息发送（超限或读失败，已留在输入框）：', _col.dropped)
  // 编辑器内嵌图片（已提前提取）合并去重
  for (const img of editorImages) {
    if (!imgAttachments.some(x => x.dataUrl === img.dataUrl)) imgAttachments.push(img)
  }
  // 用户气泡渲染图片缩略图：把 dataUrl 挂到本地 user 节点上（在 push 之前取到的节点列表里设，触发响应）
  if (imgAttachments.length) {
    const nodes = piChatStore.getNodes(String(convId))
    const lastUser = nodes[nodes.length - 1]
    if (lastUser && lastUser.kind === 'user') lastUser.images = imgAttachments.map(a => a.dataUrl)
  }
  /* ★1011s：正文带附件标记（图片 [[图片:N]] + 文件 [[文件:名字]]）—— 与乐观气泡、发后端的 message 同一份文本 */
  const sendText = withAttachMarkers(
    cleanMessage || (imgAttachments.length ? '[图片]' : fileAttachments.length ? '[文件]' : ''),
    imgAttachments, fileAttachments)
  // 会话级模型覆盖（每窗口独立选择）：随 prompt 发给后端 llmOverride。
  // 0908 二批条1：无显式覆盖时兜底=选择器当前显示值（先推供应商 ensure 再发），显示与发送同源
  const sendModel = await providersStore.modelForSend(String(convId))
  // 成员单聊分支：直连成员会话（后端校验团队/成员/工作区），不占用主 agent 生成态
  if (dm) {
    // 复位主发送态（成员回复靠 subagent-event 流呈现，与主 agent 的 isGenerating 无关）
    isSending.value = false
    isGenerating.value = false
    stopTurnTimer(String(convId))   // 单聊不占主会话计时胶囊（0904 实测残留修正）
    clearTimeout(generateTimeout.value)
    chatStore.sendMemberMessage(String(convId), dm.id, sendText).then((ok) => {
      if (!ok) notificationsStore.push({ level: 'error', title: t('chat.sendDmFailTitle'), content: t('chat.sendDmFailBody'), type: 'system' })
    }).catch(() => {
      notificationsStore.push({ level: 'error', title: t('chat.sendDmErrorTitle'), content: t('chat.sendDmErrorBody'), type: 'system' })
    })
    return
  }
  /* ★1011u（实测反馈"带附件的消息发出去之后输入框里的没清除、直到 AI 回复完成后才消失，体感不好"）：
     附件**即时清空** —— 原实现把那句 `attachments.value = []` 放在 sendMessage().then() 里，
     而那个 Promise 要等**整轮回复结束**才 resolve ⇒ 输入框一直挂着附件等 AI 说完话。
     内容此刻已经读好、随消息发出去了，没有理由再留着。
     失败时把附件**放回输入框**（用户的文件不能丢；快照含超限被 dropped 的那些）。 */
  const sentAttachmentsSnapshot = attachments.value.slice()
  if (imgAttachments.length || fileAttachments.length) keepDroppedAttachments(_col.dropped)
  chatStore.sendMessage(String(convId), sendText, reasoningMode.value, skillTags.length > 0 ? skillTags : undefined, imgAttachments, sendModel, planMode.value).then((ok) => {
    if (ok) { /* 附件已在上面的"即时清空"处理过 */ }
    else {
      attachments.value = sentAttachmentsSnapshot
      piChatStore.finalizeStreaming(String(convId))
      isSending.value = false
      isGenerating.value = false
      /* ★ 0925aa（需求的）：失败消息留气泡（红叹号+点击重发），不再只弹 toast */
      piChatStore.pushFailedUserMessage(String(convId), sendText, imgAttachments.map(x => x.dataUrl))
      notificationsStore.push({ level: 'error', title: t('chat.sendFailTitle'), content: chatStore.lastSendError || t('chat.sendFailBody'), type: 'system' })
    }
  }).catch(() => {
    attachments.value = sentAttachmentsSnapshot
    piChatStore.finalizeStreaming(String(convId))
    isSending.value = false
    isGenerating.value = false
    piChatStore.pushFailedUserMessage(String(convId), sendText, imgAttachments.map(x => x.dataUrl))
    notificationsStore.push({ level: 'error', title: t('chat.sendErrorTitle'), content: t('chat.sendErrorBody'), type: 'system' })
  })
}

function stopGeneration() {
  const convId = props.conversation?.id
  // 立即清理前端 streaming 节点（不等后�?confirm，即时停�?Think 动画�?
  if (convId) piChatStore.finalizeStreaming(String(convId))
  if (convId != null) {
    // 真正的停止：后端 session.cancel（abort agent + 清理流式状态）
    chatStore.bridgeRpc('session.cancel', { sessionId: String(convId) })
      .catch((e) => swallowed('「停止」没送到后端（界面已按停止渲染，但后端可能仍在跑——继续烧 token）', e, 1))
  }
  if (generateTimeout.value) clearTimeout(generateTimeout.value)
  isGenerating.value = false
  // 中断即停计时（0902 反馈 #7）
  if (convId != null) stopTurnTimer(String(convId))
}

watch(isGenerating, (val, oldVal) => {
  if (oldVal && !val) {
    if (generateTimeout.value) clearTimeout(generateTimeout.value)
  }
})

onMounted(() => {
  // 后台任务 active 计时（bgTick 驱动 bgProcessDuration 实时秒数）
  timerInterval = setInterval(() => { bgTick.value += 1 }, 1000)
  document.addEventListener('click', handlePickerOutside)
  // 测试/演示后门：nis-inject-card �?往当前会话注入门禁/询问卡（模拟后端推送）
  window.addEventListener('nis-inject-card', handleInjectCard)
  /* ★1011w-4：拖放统一由 **window 级 + 捕获阶段** 接管（见 onWinDragOver 注释）——
     这样整个窗口都算热区，不会因为内层 stopPropagation 而只剩某一块能触发。 */
  window.addEventListener('dragover', onWinDragOver, true)
  window.addEventListener('dragleave', onWinDragLeave, true)
  window.addEventListener('drop', onWinDrop, true)
})

onUnmounted(() => {
  if (timerInterval) clearInterval(timerInterval)
  document.removeEventListener('click', handlePickerOutside)
  window.removeEventListener('nis-inject-card', handleInjectCard)
  window.removeEventListener('dragover', onWinDragOver, true)
  window.removeEventListener('dragleave', onWinDragLeave, true)
  window.removeEventListener('drop', onWinDrop, true)
})

/* ★1011：formatSize / getFileType 两个助手随附件条一起搬进 components/blocks/AttachmentsBar.vue ——
   它们在本文件已无使用点（唯一的附件条渲染已改为 <AttachmentsBar>），留着就是死代码。 */

const chatScrollRef = ref<HTMLElement | null>(null)
const showScrollButton = ref(false)
/** PiChatView 实例（滚动到底/回到最新） */
const piChatViewRef = ref<InstanceType<typeof PiChatView> | null>(null)

/* ── 0914：用户消息「编辑重发 / 返回输入框」（PiChatView 气泡按钮 → 这里执行）──
 * 编辑重发 = 删除原轮（含 user 及其 AI 回复）→ 编辑后内容回灌编辑器（图片随附）→ 标准发送 → AI 重新回复。
 * 返回输入框 = 文字/图片/技能标签全部回填编辑器；原消息不动，用户自行决定发不发。 */

/** dataUrl → 图片「标签」插进输入框（与拖拽/粘贴图片同款 .tag-inline 胶囊；此前误用附件卡片样式） */
function insertImageTagToInput(dataUrl: string, idx: number) {
  const m = /^data:(image\/[a-z0-9.+-]+);base64,/i.exec(dataUrl)
  const mime = m ? m[1] : 'image/png'
  const ext = (mime.split('/')[1] || 'png').replace('jpeg', 'jpg')
  chatInputRef.value?.insertImageTag?.(`图片-${idx}.${ext}`, Math.round(dataUrl.length * 0.75), dataUrl, mime)
}

/** ★ 0924（反馈"编辑发送会卡一会儿"）：**本地就地移除**第 turnIndex 轮（用户节点 + 其后的 AI 回复）。
 *  替代原来"await 一次全量 session.history + loadHistory 重建整个列表"——那一步要传输、解析、重渲
 *  几百条消息（含图片 dataURL），全部压在主线程上，正是"点发送后卡一会儿"的主因。
 *  轮次口径与后端一致：只数真实用户节点（跳过单聊 dm 节点）。定位失败返回 false，调用方退回全量重放。 */
function removeTurnLocally(convId: string, turnIndex: number): boolean {
  const list = (piChatStore as any).nodes?.[convId] as any[] | undefined
  if (!Array.isArray(list) || !(turnIndex >= 1)) return false
  /* ★★ 0924 修复（实测反馈"编辑重发后，原来那条消息和它的回复都还在"）：
     轮次口径必须与后端 session.deleteTurn 一致（1 基、跳过「自动续跑」注入的 user 消息）。
     ★0930 拆分批加载后恒全量：全局轮次=本地轮次（base 恒 0），历史错位的根因场景已不存在。 */
  const base = 0 // ★0930 拆分批加载：恒全量——全局轮次=本地轮次
  const localTurn = turnIndex - base
  if (localTurn < 1) return false
  const userIdx: number[] = []
  list.forEach((n: any, i: number) => {
    if (n?.kind !== 'user' || n.dm) return
    if (String(n.text || '').startsWith('【自动续跑')) return   // 后端同款：自动续跑不算真实轮次
    userIdx.push(i)
  })
  const start = userIdx[localTurn - 1]
  if (start === undefined) return false
  const end = localTurn < userIdx.length ? userIdx[localTurn] : list.length
  if (end <= start) return false
  list.splice(start, end - start)
  return true
}

async function onUserEditSend(payload: { turnIndex: number; text: string; node: any; images?: string[] }) {
  const convId = props.conversation?.id
  if (convId == null || !chatInputRef.value) return
  if (isGenerating.value || isReplying.value) {
    notificationsStore.push({ level: 'warning', content: t('chat.editBusy'), type: 'system' })
    return
  }
  try {
    /* ★1004p（实测反馈"编辑发送会把输入框里没发的内容清掉"）：编辑重发与输入框草稿无关 ——
       先把草稿收好，发完放回。原来无条件 clearEditor() 直接冲掉。 */
    const keepDraft = grabEditorState()
    // ① 删除原轮（后端为权威；运行中的轮次后端会拦）
    const r = await chatStore.bridgeRpc('session.deleteTurn', { sessionId: String(convId), turnIndex: payload.turnIndex, includeUser: true })
    if (r?.ok === false) throw new Error(String(r.error || t('chat.editFail')))
    /* ★ 0924（反馈"编辑发送会卡一会儿"）：这里原来紧跟着 `await session.history`（**全量**历史）
       再由 loadHistory 重建整个消息列表 —— 几百条消息 + 图片 dataURL 的传输/解析/重渲全在主线程，
       就是"点发送后卡一会儿"的主因。改为**本地就地移除该轮**：立即见效、零网络开销
       （后端已是权威，上面 deleteTurn 已完成；前端下次刷新/切会话自然对齐）。
       本地定位失败时退回原来的全量重放，行为不退化。 */
    const removed = removeTurnLocally(String(convId), payload.turnIndex)
    if (!removed) {
      const result = await chatStore.bridgeRpc('session.history', { sessionId: String(convId) })
      if (result?.messages) {
        piChatStore.loadHistory(String(convId), result.messages, Array.isArray(result.compactions) ? result.compactions : undefined, Array.isArray(result.runningTools) ? result.runningTools : undefined)
      }
    }
    // ② 编辑后内容 → 直接发送（★1015：不再"回灌编辑器再发"）
    /* ★1015（实测反馈"点编辑发送，内容会在输入框出现一下再消失，消息多时更明显，体感不好"）：
       改为把正文/图片/技能标签**直接喂给 sendMessage**（override 入参），编辑器全程不碰 ⇒ 没有闪现，
       也不会动用户正在写的草稿。
       · 正文里的 `[[图片:N]]` 标记照旧保留（位置保真，气泡内联渲染据此拆段）；
       · 图片整组随附：正文没引用的图由 withAttachMarkers 补到末尾（保底：绝不丢图）；
       · 万一发送失败 → 下面 catch 把内容退回输入框（原来"回填"路径的兜底价值，这里保留）。 */
    const raw = String(payload.text || '').replace(/\n{3,}/g, '\n\n').trim()
    /* ★ 0924：优先用编辑态传来的图片副本（支持粘贴新增 / 删除）；老调用方没传 images 时退回 node.images */
    const imgs = Array.isArray(payload.images)
      ? payload.images.filter(Boolean)
      : (Array.isArray(payload.node?.images) ? payload.node.images.filter(Boolean) : [])
    const skills = Array.isArray(payload.node?.skills) ? payload.node.skills : []
    try {
      await sendMessage(undefined, {
        text: raw,
        images: imgs.map((d: string, i: number) => ({ name: `图片-${i + 1}.png`, dataUrl: d })),
        skills: skills.map((s: any) => String(s)),
      })
    } catch (e) {
      /* 发送失败 → 内容绝不丢：退回输入框（同 onSteerRecycle 的兜底口径），用户手动重发即可 */
      chatInputRef.value?.clearEditor()
      chatInputRef.value?.insertText(raw.replace(/\[\[图片:\d+\]\]/g, '').trim())
      imgs.forEach((d: string, i: number) => insertImageTagToInput(d, i + 1))
      for (const s of skills) chatInputRef.value?.insertSkillTag(String(s))
      chatInputRef.value?.focusEditor()
      throw e
    }
    /* ★1004p：发完把没发的草稿放回输入框（sendMessage 只该带走被编辑重发的内容） */
    if (keepDraft?.html) chatInputRef.value?.setEditorState(keepDraft)
  } catch (e: any) {
    const msg = String(e?.message || e)
    notificationsStore.push({ level: 'error', content: msg.includes('正在回复') ? t('chat.editBusy') : t('chat.editFail'), type: 'system' })
  }
}

/**
 * 0920：语音输入识别结果 → 写进输入框（**必须走 ChatInput.insertText**：
 * contenteditable 直接改 DOM，Vue 侧回读不到，草稿也存不下）。
 * 已有内容时补一个空格，避免跟前面粘在一起。
 */
function onVoiceText(text: string) {
  const t2 = String(text || '').trim()
  if (!t2 || !chatInputRef.value) return
  const cur = String(chatInputRef.value.getPlainText?.() || '').trim()
  chatInputRef.value.insertText(cur ? ' ' + t2 : t2)
}

function onUserReturnInput(node: any) {
  if (!chatInputRef.value) return
  // 文字：剥 [技能:X] 前缀（技能单独回填标签）与工作模式指令行
  const raw = stripModeHint(String(node?.text || ''))
  let rest = raw
  const re = /\[技能:([^\]]+)\]\s*/g
  let m: RegExpExecArray | null
  while ((m = re.exec(raw)) !== null) rest = raw.slice(m.index + m[0].length)
  /* ★ 0925（反馈"返回输入框标签位置乱，图片/标签全都跑到最后"）：
     照 `[[图片:N]]` 位置标记走（**0 基**，与 userSegments / piChat store 拼占位同口径）——
     文字段 insertText、标记处 insertImageTagToInput，光标自然前进 ⇒ 标签落回原文位置。
     （旧实现把标记整段剥掉、图片再 append 到末尾，位置信息全丢 —— 等于必然乱序。） */
  const imgs = Array.isArray(node?.images) ? node.images.filter(Boolean) : []
  chatInputRef.value.clearEditor()
  const usedIdx = new Set<number>()
  const parts = rest.split(/\[\[图片:(\d+)\]\]/g)   // 偶数位=文字、奇数位=图片序号（0 基）
  for (let k = 0; k < parts.length; k++) {
    if (k % 2 === 0) {
      const seg = parts[k].replace(/\n{3,}/g, '\n\n')
      if (seg) chatInputRef.value.insertText(seg)
    } else {
      const idx = Number(parts[k])
      const d = imgs[idx]
      if (d) { insertImageTagToInput(d, idx + 1); usedIdx.add(idx) }
    }
  }
  /* 没被任何标记引用的图片 → 追加末尾（保底：绝不丢图） */
  imgs.forEach((d: string, i: number) => { if (!usedIdx.has(i)) insertImageTagToInput(d, i + 1) })
  const skills = Array.isArray(node?.skills) ? node.skills : []
  for (const s of skills) chatInputRef.value.insertSkillTag(String(s))
  notificationsStore.push({ level: 'success', content: t('chat.returnedToInput'), type: 'system' })
}

/** ★ 0925f：插话乐观气泡「撤回重排」（需求的功能）—— AI 回复中，还没插进去的插话
 *  （乐观气泡 steerOptimistic/steerPending）点编辑按钮 → 从对话流移除 + 内容退回归队条。
 *  后端 steer 无取消 API（agent.steer 立即注入）→ 撤回后 pi 注入时仍会发 message_start(user)
 *  回显，piChat 侧 withdrawSteerNode 已登记 withdrawn 集合把它拦掉，不会重复冒泡。
 *  如实限制：AI 上下文里可能已收到原消息（无法撤销），极端情况下 AI 回复仍可能提及该内容。 */
async function onSteerRecycle(node: any) {
  const convId = props.conversation?.id
  if (convId == null || !node) return
  const withdrawn = piChatStore.withdrawSteerNode(String(convId), String(node.key || ''))
  if (!withdrawn) return
  const imgs = Array.isArray(node.images) ? node.images.filter(Boolean) : []
  const skills = Array.isArray(node.skills) ? node.skills.filter(Boolean) : []
  try {
    // 内容原样退回归队条（后端 queue.add 落账；重发即新排队项）
    const r = await chatStore.bridgeRpc('session.queue.add', {
      sessionId: String(convId),
      message: String(node.text || ''),
      attachments: imgs.length ? imgs.map((d: string, i: number) => ({ name: `图片-${i + 1}.png`, dataUrl: d })) : undefined,
      skills: skills.length ? skills : undefined,
    }) as any
    if (r?.queue) queueStore.set(String(convId), r.queue)
    notificationsStore.push({ level: 'info', content: t('queue.steerRecycled'), type: 'system' })
  } catch {
    // 入队失败 → 内容绝不丢：退回底部输入框并聚焦，用户可手动重发
    chatInputRef.value?.clearEditor()
    if (node.text) chatInputRef.value?.insertText(String(node.text).replace(/\[\[图片:\d+\]\]/g, '').trim())
    imgs.forEach((d: string, i: number) => insertImageTagToInput(d, i + 1))
    for (const s of skills) chatInputRef.value?.insertSkillTag(String(s))
    chatInputRef.value?.focusEditor()
    notificationsStore.push({ level: 'warning', content: t('queue.steerRecycleFail'), type: 'system' })
  }
}
/** 定位到第 N 轮用户消息（WorkspacePanel「定位到对话」按钮 → mitt 总线跨组件调用） */
function onLocateTurn(e: Event) {
  const turnIndex = Number((e as CustomEvent).detail?.turnIndex || 0)
  if (turnIndex > 0) piChatViewRef.value?.scrollToTurn(turnIndex)
}
onMounted(() => { window.addEventListener('nis-locate-turn', onLocateTurn) })
onUnmounted(() => { window.removeEventListener('nis-locate-turn', onLocateTurn) })

/** 工作区文件右键「添加到输入框」→ 在输入框插入文件引用标签（发送时转 [引用文件：路径] 供 AI fs_read） */
function onAddFileRef(e: Event) {
  const d = (e as CustomEvent).detail || {}
  if (d.relPath) chatInputRef.value?.insertFileRef(String(d.relPath), d.name ? String(d.name) : undefined)
}
onMounted(() => { window.addEventListener('nis-add-file-ref', onAddFileRef) })
onUnmounted(() => { window.removeEventListener('nis-add-file-ref', onAddFileRef) })

/* ★0927：**切回窗口/标签 → 对齐一次**（实测"切回来显示的是旧内容，刷新后内容又回来了"）。
   实时视图靠 SSE 增量拼，丢一帧就停在旧状态；这里在窗口重新获得焦点/标签变可见时做一次
   增量补账（只补缺、不动已有节点）+ 对"在跑但漏了终态帧"的会话做一次权威对齐 —— 不用再手动刷新。
   blur/隐藏时不清任何东西；节流在 store 里（2s）。 */
function onWindowFocusReconcile() {
  if (document.visibilityState && document.visibilityState !== 'visible') return
  void conversationsStore.reconcileOnFocus()
}
onMounted(() => {
  window.addEventListener('focus', onWindowFocusReconcile)
  document.addEventListener('visibilitychange', onWindowFocusReconcile)
})
onUnmounted(() => {
  window.removeEventListener('focus', onWindowFocusReconcile)
  document.removeEventListener('visibilitychange', onWindowFocusReconcile)
})

/** 变更面板 ↔ 聊天文件高亮（0904 定稿）：面板点文件 → 聊天里点亮同文件（10s 单目标） */
function onFileHighlight(e: Event) {
  const d = (e as CustomEvent).detail || {}
  if (String(d.convId || '') !== String(props.conversation?.id ?? '')) return
  if (d.relPath) piChatViewRef.value?.highlightFile(String(d.relPath), d.turnIndex ?? null)
}
onMounted(() => { window.addEventListener('nis-file-highlight', onFileHighlight) })
onUnmounted(() => { window.removeEventListener('nis-file-highlight', onFileHighlight) })

/* ── Skill 标签：SkillPicker 选中 → 置入输入框；再次点击 → 移除；发送时随 payload.skills 带给后端 ── */
function handleSkillSelect(e: Event) {
  const name = (e as CustomEvent).detail?.name as string
  if (!name) return
  chatInputRef.value?.insertSkillTag(name)
}
function handleSkillRemove(e: Event) {
  const name = (e as CustomEvent).detail?.name as string
  if (!name) return
  // 移除输入框里所有该 skill 标签
  chatInputRef.value?.removeSkillTags(name)
}

/* ── 底部浮层高度测量：计划卡折叠/展开/审批卡变化时动态调整预留，贴底时最新回复永远在浮层上方 ──
   注意：dock 可能在挂载后才渲染（空对话态无 dock）——必须 watch ref 出现后再挂 RO，否则测量永久失效 */
const inputDockRef = ref<HTMLDivElement | null>(null)
const bottomInset = ref(200)
let dockResizeObserver: ResizeObserver | null = null
onMounted(() => {
  if (typeof ResizeObserver === 'undefined') return
  dockResizeObserver = new ResizeObserver((entries) => {
    for (const e of entries) {
      // 0907 图二：手机 dock 有 64px 底部避让 padding（contentRect 不含 padding），
      // 用 borderBox 总高保证消息列表底部预留完整输入区
      const box = e.borderBoxSize?.[0]?.blockSize
      const h = Math.ceil(box ?? e.contentRect.height) + 12
      if (h > 0) bottomInset.value = h
    }
  })
  if (inputDockRef.value) dockResizeObserver.observe(inputDockRef.value)
})
watch(inputDockRef, (el) => {
  if (el && dockResizeObserver) dockResizeObserver.observe(el)
})
onUnmounted(() => {
  dockResizeObserver?.disconnect()
  dockResizeObserver = null
})

function onScrollState(distanceFromBottom: number) {
  showScrollButton.value = distanceFromBottom > 200
}

/* 计划卡 B 方案收尾：全部完成后 10s 淡出 → 本地清空 plan（不调后端，AI 零消耗） */
/** 0910 三批①计划面板三合一：黑板 / 主 agent 计划 / 各成员自列计划 三源并列显示，
 *  顺序固定 黑板 → 主计划 → 子计划（缺项自动顶上）；三种各带标识（见 PlanCard variant） */
const boardPlanItems = computed(() => (props.conversation?.boardPlan || []) as Array<{ text: string; done: boolean }>)
const memberPlanCards = computed(() => piChatStore.memberPlans(String(props.conversation?.id || '')).filter(mp => !dismissedMemberPlans.value.has(`${props.conversation?.id}:${mp.key}`)))
const hasAnyPlanCard = computed(() => boardPlanItems.value.length > 0 || (props.conversation?.plan?.length || 0) > 0 || memberPlanCards.value.length > 0)
/** 0911 反馈：成员计划卡全 done 后 10s 自动消失（PlanCard expired 机制同款）——完成的不堆积。
 *  仅本地隐藏（会话流里的过程块不受影响）；跨窗口/刷新不复现由 store 的 finished 标记兜底（memberPlans 过滤）。 */
const dismissedMemberPlans = ref<Set<string>>(new Set())
function dismissMemberPlan(key: string) {
  const s = new Set(dismissedMemberPlans.value)
  s.add(`${props.conversation?.id}:${key}`)
  dismissedMemberPlans.value = s
}

function clearPlanLocal() {
  const convId = props.conversation?.id
  if (convId == null) return
  const c = conversationsStore.getById(String(convId))
  if (c) c.plan = []
}
/** 0911 反馈8：黑板计划全 done 后同样 10s 淡出 → 本地清空（此前 expired 未接线，
 *  淡出后会因 v-if 仍成立而闪回）。刷新后不复现由加载侧 prunedPlan 兜底。 */
function clearBoardPlanLocal() {
  const convId = props.conversation?.id
  if (convId == null) return
  const c = conversationsStore.getById(String(convId))
  if (c) c.boardPlan = []
}

function scrollToBottom(behavior: ScrollBehavior = 'smooth') {
  if (piChatViewRef.value) {
    piChatViewRef.value.scrollToBottom()
    return
  }
  const el = chatScrollRef.value
  if (!el) return
  el.scrollTo({ top: el.scrollHeight, behavior })
}

/** 消息内文�?图片预览 �?打开当前窗口的预�?tab（窗口隔离由 store 保证�?*/
function handleFilePreview(e: Event) {
  const detail = (e as CustomEvent).detail || {}
  const convId = props.conversation?.id
  if (convId == null) return
  const id = String(convId)
  const name = detail.name || t('panel.viewPreview')
  if (detail.type === 'image' || (detail.content && detail.content.startsWith('data:image'))) {
    previewTabsStore.openTab(id, {
      key: 'data:' + (detail.name || Math.random().toString(36).slice(2, 6)),
      kind: 'image',
      title: name,
      dataUrl: detail.content,
    })
  } else if (detail.content) {
    previewTabsStore.openTab(id, {
      key: 'file:' + name,
      kind: 'html',
      title: name,
      content: detail.content,
    })
  } else {
    // 工作区文件（无内容）：读取工作区缓存后打开
    const cached = workspaceStore.openFile(name)
    if (cached) {
      previewTabsStore.openTab(id, {
        key: 'file:' + name,
        kind: cached.type === 'image' ? 'image' : 'html',
        title: name,
        dataUrl: cached.type === 'image' ? cached.content : undefined,
        content: cached.type === 'html' ? cached.content : undefined,
      })
    }
  }
}

/* ── 拖拽文件到聊天区（输入框以外）→ 打开预览 tab ── */
const dragOverChat = ref(false)

function onChatDragOver(e: DragEvent) {
  if (!e.dataTransfer?.types.includes('Files')) return
  e.preventDefault()
  dragOverChat.value = true
  /* ★1011w-5：这里**不再**点亮输入框 —— 根级这一路只代表"消息区 = 打开预览"。
     两个区的高亮由 window 捕获阶段的 onWinDragOver 按"鼠标在哪个区"来定，保证**只亮一个**
     （上一版在这里也点亮输入框 ⇒ 拖到消息区时两个高亮同时出现）。 */
}

function onChatDragLeave() {
  dragOverChat.value = false
  shellDragOver.value = false
}

async function onChatDrop(e: DragEvent) {
  dragOverChat.value = false
  shellDragOver.value = false
  const files = Array.from(e.dataTransfer?.files || [])
  if (files.length === 0) return
  e.preventDefault()
  const convId = props.conversation?.id
  if (convId == null) return
  const id = String(convId)
  for (const file of files) {
    const ext = (file.name.split('.').pop() || '').toLowerCase()
    const isImage = file.type.startsWith('image/')
    // 图片 �?dataURL 预览；其�?�?交给 open-file-viewer（File 对象�?
    if (isImage) {
      const dataUrl = await new Promise<string>((resolve) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result || ''))
        reader.readAsDataURL(file)
      })
      previewTabsStore.openTab(id, {
        key: 'data:' + file.name,
        kind: 'image',
        title: file.name,
        dataUrl,
      })
    } else {
      // HTML/前端页面：读取文本内容，支持「页�?代码」切�?
      if (ext === 'html' || ext === 'htm') {
        const text = await file.text()
        // 0914 精准打击：拖入的非工作区文件先入库到工作区「外部文件/」子目录（后端落盘真实副本），
        // srcPath 指向副本 → 元素标签带可寻址路径，AI 可 fs_read/fs_edit 直接修改；
        // 入库失败（如未设置工作区/后端未重启）则回退纯预览（srcdoc），行为与旧版一致。
        let srcPath = ''
        try {
          const r: any = await chatStore.bridgeRpc('fs.importExternalFile', { sessionId: id, name: file.name, content: text })
          if (r && typeof r.path === 'string' && r.path) {
            srcPath = r.path
            notificationsStore.push({ level: 'success', content: t('chat.dropImported', { path: r.path }), type: 'system' })
          } else {
            console.warn('[chat] importExternalFile: 后端未返回路径（后端可能未重启/版本旧）')
          }
        } catch (err: any) {
          console.warn('[chat] importExternalFile failed:', err)
          notificationsStore.push({ level: 'warning', content: t('chat.dropImportFailed'), type: 'system' })
        }
        previewTabsStore.openTab(id, {
          key: 'file:' + (srcPath || file.name),
          kind: 'html',
          title: file.name,
          content: text,
          file,
          mimeType: file.type || 'text/html',
          srcPath: srcPath || undefined,
          viewMode: 'page',
        })
        continue
      }
      // 其余格式交给 open-file-viewer（textPlugin/officePlugin/pdfPlugin 等按扩展名识别）
      previewTabsStore.openTab(id, {
        key: 'file:' + file.name,
        kind: 'file',
        title: file.name,
        file,
        mimeType: file.type || undefined,
      })
    }
  }
}

onMounted(() => {
  window.addEventListener('command-selected', handleCommand)
  window.addEventListener('nis-file-preview', handleFilePreview)
  window.addEventListener('nis-skill-select', handleSkillSelect)
  window.addEventListener('nis-skill-remove', handleSkillRemove)
  nextTick(() => scrollToBottom())
})

onUnmounted(() => {
  window.removeEventListener('command-selected', handleCommand)
  window.removeEventListener('nis-file-preview', handleFilePreview)
  window.removeEventListener('nis-skill-select', handleSkillSelect)
  window.removeEventListener('nis-skill-remove', handleSkillRemove)
  // 卸载时移�?WS 消息订阅，避免重复挂载后 handler 堆积
  chatStore.offMessage(handleWebSocketMessage)
})
/** ★ 0925n（用户指正：复制顶栏会话标题）：点击标题复制到剪贴板
 *  ★ 0925o（实测"粘贴出来是 后台任务：undefined"）：activeTask 是 computed ——
 *  模板里自动解包，函数里必须 .value，漏了就拿 ref 对象的 .title（恒 undefined）。 */
async function copySessionTitle() {
  const at = activeTask.value
  const text = at ? t('chat.bgTaskPrefix') + (at.title || at.task_id || '') : (props.conversation?.title || 'Nis')
  try {
    await navigator.clipboard.writeText(text)
    const { useNotificationsStore } = await import('@/stores/notifications')
    useNotificationsStore().push({ title: 'Nis', level: 'success', message: t('sbl.copied') })
  } catch (e) { swallowed('复制到剪贴板失败（点了没反应，也没提示）', e, 1) }
}

/** ★1011（需求：会话号要能看见）：复制当前会话的**完整会话号**。
 *  为什么需要：会话标题是模型自动生成的、还会被改写（实测"LongCat缓存测试"被改成了「Nis自我介绍」），
 *  而排障时真正对得上的是会话号 —— 日志文件名 data/logs/<id>.jsonl、黑板 data/blackboard/<id>.json、
 *  会话落盘 data/sessions/<id>.json 全都是它。标题栏只显示前 8 位，点一下复制完整值。 */
async function copySessionId() {
  const id = String(props.conversation?.id || '')
  if (!id) return
  try {
    await navigator.clipboard.writeText(id)
    const { useNotificationsStore } = await import('@/stores/notifications')
    useNotificationsStore().push({ title: 'Nis', level: 'success', message: t('chat.sessionIdCopied') })
  } catch (e) { swallowed('复制会话号失败（点了没反应，也没提示）', e, 1) }
}
</script>

<template>
  <section
    class="absolute inset-0 flex flex-col overflow-hidden"
    :class="{ 'chat-dragover': dragOverChat }"
    @dragover="onChatDragOver"
    @dragleave="onChatDragLeave"
    @drop="onChatDrop"
  >
      <!-- DSH 风格会话标题栏：仅标�?+ 底部 1px 细线，无返回/按钮；悬停显示会话工作区 -->
      <header class="dsh-session-header shrink-0" data-tauri-drag-region>
        <div class="flex items-center gap-2 min-w-0 flex-1" data-tauri-drag-region>
          <!-- ★ 0925n（用户指正：复制的是**顶栏这个标题**）：点击标题复制到剪贴板 -->
          <h1
            class="dsh-session-title min-w-0 cursor-copy"
            data-tauri-drag-region
            :title="(props.conversation?.workDir ? `${t('chat.workspacePrefix')}${props.conversation.workDir}` : '') + (props.conversation?.title ? ` · ${t('sbl.copyTitleHint')}` : t('sbl.copyTitleHint'))"
            @click="copySessionTitle"
          >{{ activeTask ? t('chat.bgTaskPrefix') + activeTask.title : (props.conversation?.title || 'Nis') }}</h1>
          <!-- ★1011（老大反馈：会话号往前移 + 与模式标签区分开）：会话号排在**模式前面**，并改成"纯等宽文字"
               （无底色、更浅、hover 才变深）；模式标签改成**浅底胶囊** —— 两者一眼能分辨（原来都是灰色小字，看着差不多）。 -->
          <button
            v-if="props.conversation?.id && !activeTask"
            class="shrink-0 font-mono text-[10px] leading-none text-gray-300 hover:text-gray-600 transition-colors"
            :title="`${t('chat.sessionIdHint')}${props.conversation.id}`"
            @click.stop="copySessionId"
          >{{ String(props.conversation.id).slice(0, 8) }}</button>
          <span v-if="currentPresetName && !activeTask" class="shrink-0 px-1.5 py-0.5 rounded-md bg-gray-100 text-[10px] font-[530] text-gray-500 whitespace-nowrap" :title="`${t('chat.sessionModePrefix')}${currentPresetName}`">{{ currentPresetName }}</span>
        </div>
        <!-- 0909⑦改：主计划 pill 已移入对话区右上角悬浮（见下方 plan-float-row）；标题栏容器留给后续子 agent 计划条。 -->
        <div class="flex items-center gap-2 shrink-0">
          <!-- 0920 与「接入」互换位置：标题栏右上角改挂**系统通知中心**（通知属即时回看，右上角是惯例；
               接入+设置挪到侧边栏底部同列）。铃铛点开是通知面板，每条可「查看对话」直达。 -->
          <!-- ★ 0922e：进程监控按钮（在铃铛左侧；角标 = 正在运行的进程数） -->
          <button
            class="w-9 h-9 sidebar-gear relative flex items-center justify-center rounded-xl hover:bg-gray-100 transition-colors"
            :title="t('proc.title')"
            @click="openProcs"
          >
            <Cpu :size="16" :stroke-width="1.9" />
            <span
              v-if="procsStore.runningCount"
              class="absolute top-0.5 right-0.5 min-w-[15px] h-[15px] px-1 rounded-full bg-indigo-500 text-white text-[9px] font-medium flex items-center justify-center shadow-sm"
            >{{ procsStore.runningCount }}</span>
          </button>
          <SystemNotificationCenter />
          <ProcMonitorModal v-if="procOpen" @close="procOpen = false" />
        </div>
        <!-- 窗口控制按钮（0911 反馈：位置应在上方标题栏右上角，非 tag 栏内）——桌面版真实控制，浏览器给提示 -->
        <WindowControls />
      </header>

      <!-- 标签栏：第一个固定「对话」，后续为预�?tab（窗口隔离） -->
      <PreviewTabBar
        :run-log-open="runLogOpen"
        :workspace-open="workspaceOpen"
        :version-open="versionOpen"
        @toggle-run-log="runLogOpen = !runLogOpen"
        @toggle-workspace="workspaceOpen = !workspaceOpen"
        @toggle-version="versionOpen = !versionOpen"
      />

    <!-- 浏览器视图（固定 tab�?0s 未使用自动释放） -->
    <!-- ══ 会话级主体行（0904）：左=主视图（浏览器/办公室/对话/预览 四选一互斥），右=共享右栏（日志/工作区）。
         右栏对所有主视图可见可开；展开时左列按 flex-1 让位缩小，收起时左列铺满。
         各主视图以 absolute inset-0 撑满左列（empty-layout 自带 absolute；chat/preview 外包 absolute 壳）。
         右栏宽=min(合计px,34vw) + 聊天保底 + <900px 保险丝逻辑全部复用（定义在本行末尾与 script）。 ══ -->
    <div class="flex-1 min-h-0 min-w-0 flex">
    <!-- 主视图左列（0907 图一：手机端解除 PC 右栏挤压保险丝 min-w-[380px]——390px 视口下
         它把整条对话列撑出屏幕，Think/正文/卡片全部右侧被裁=用户所见"到屏幕外去"根因） -->
    <div class="relative flex-1 min-h-0" :class="isMobileUi ? 'min-w-0' : 'min-w-[380px]'">
    <BrowserPanel v-if="currentFixedView === 'browser'" class="absolute inset-0" :conversation-id="String(props.conversation?.id || '')" />


    <!-- 画布视图（固定 tab，仿 open-pencil 自研 v0） -->
    <CanvasPanel v-else-if="currentFixedView === 'canvas'" />

    <!-- 对话内容区（无预�?tab 激活时显示�?-->
    <template v-else-if="activePreviewTabId === null">

    <!-- ★1012av：**骨架方案已按需求要求回退**（1012ao~1012au 全部撤除）。
         原因：连续几轮仍出现"骨架与空态叠加/骨架期无输入框"，体验不如原来的纯空态；
         已定案"退回" ⇒ 恢复"加载期直接显示空态（地球+问候语+输入框）"的原行为。
         注：`conversations.ts` 里 markSettled 的时机修正**保留**（那是行为修复、不涉及 UI，
         可减少"空态闪现后再变内容"的闪烁）。 -->

    <!-- ══�?空对话：居中布局（地球放�?+ 问候语 + 输入框居中） ══�?-->
    <div v-if="isEmpty && !activeTask" class="empty-layout">
      <!-- ★ 0920：空会话态也要有后台任务胶囊（左上角）——任务跑着的时候用户可能停在空对话上 -->
      <!-- ★1012aw：**首屏"正在加载"过渡指示** —— 需求要求"点开对话别在空态页上干等"。
           刻意**不铺遮罩、不挡输入框**（pointer-events: none）、不改消息区 v-if 结构；
           放在空态页顶部居中，加载完（markSettled）自动消失。 -->
      <div v-if="chatOpening" class="empty-loading-modal">
        <span class="elc-spin" aria-hidden></span>
        <span>正在加载会话…</span>
      </div>
      <div v-if="bgTasksForConv.length" class="absolute top-2 inset-x-0 z-30 flex justify-center pointer-events-none">
        <div class="w-full max-w-[600px] px-4 flex flex-col items-start gap-1.5">
          <BgTaskPill :conv-id="props.conversation?.id ?? null" :open-task="openBgTask" />
        <!-- ★ 0922 D：任务详情弹窗 -->
        <BgTaskModal
          v-if="bgModalId"
          :task-id="bgModalId"
          :conv-id="props.conversation?.id ?? null"
          @close="bgModalId = null"
        />
        </div>
      </div>
      <div class="empty-globe">
        <!-- ★1012h：手机端降采样（反馈「空态选模型很卡」）—— 地球原来恒按 900×900×dpr 每帧重绘，
             移动端 GPU 压力大；手机端改 420（视觉上仍被 CSS 缩到约屏宽，观感几乎无差）。 -->
        <!-- ★1011：fit —— 尺寸跟随内容区（size 退化为上限：移动端仍 ≤420） -->
        <Globe fit :size="isMobileUi ? 420 : 900" />
      </div>
      <div class="text-center empty-greeting">
        <h2 class="text-[26px] font-[640] text-gray-800 tracking-wide">{{ emptyGreeting }}</h2>
        <p class="mt-2 text-[14px] text-gray-500">{{ emptyGreetingSub }}</p>
      </div>
      <!-- 工作模式 + Agent 选择（层级高于背景地球） -->
      <div class="w-full max-w-[600px] mx-auto mb-3 flex items-center justify-end gap-1.5 px-4 relative z-[2]">
        <!-- 模式下拉：Agent预设 / 团队 -->
        <div ref="modeMenuRef" class="relative flex items-center">
          <button
            type="button"
            class="empty-picker-pill flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/15 backdrop-blur-md border border-gray-200/70 text-[12px] text-gray-700 hover:border-gray-400 transition-colors"
            @click="modeMenuOpen = !modeMenuOpen"
          >
            <i :class="['fas text-[10px] text-gray-400', selectedMode === 'team' ? 'fa-users' : selectedMode === 'external' ? 'fa-terminal' : 'fa-robot']"></i>
            <span>{{ selectedMode === 'team' ? t('chat.modeTeam') : selectedMode === 'external' ? t('chat.modeExternal') : t('settings.tabs.agentPresets') }}</span>
            <i class="fas fa-chevron-down text-[8px] text-gray-400"></i>
          </button>
          <Transition name="cmd-pop">
            <div v-if="modeMenuOpen" class="tool-popover absolute bottom-full left-0 mb-2 w-44 bg-white rounded-xl shadow-xl border border-gray-200 py-2 z-[9999]">
              <button
                type="button"
                class="cmd-item w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-gray-900 hover:text-white transition-colors group"
                @click="switchMode('preset')"
              >
                <i class="fas fa-robot text-[11px] text-gray-400 group-hover:text-white"></i>
                <div class="flex-1 min-w-0">
                  <div class="text-xs font-[530]">{{ t('settings.tabs.agentPresets') }}</div>
                  <div class="text-[10px] text-gray-400 group-hover:text-gray-300 truncate">{{ t('chat.modePresetDesc') }}</div>
                </div>
              </button>
              <button
                type="button"
                class="cmd-item w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-gray-900 hover:text-white transition-colors group"
                @click="switchMode('team')"
              >
                <i class="fas fa-users text-[11px] text-gray-400 group-hover:text-white"></i>
                <div class="flex-1 min-w-0">
                  <div class="text-xs font-[530]">{{ t('chat.modeTeam') }}</div>
                  <div class="text-[10px] text-gray-400 group-hover:text-gray-300 truncate">{{ t('chat.modeTeamDesc') }}</div>
                </div>
              </button>
              <!-- ★1001 四批：外部 agent 独立类别（已安装的外部预设在这里选）；★五批：一个没装=禁用入口 -->
              <button
                type="button"
                class="cmd-item w-full flex items-center gap-2.5 px-3 py-2 text-left transition-colors group"
                :class="hasExternalPresets ? 'hover:bg-gray-900 hover:text-white' : 'opacity-40 cursor-not-allowed'"
                :disabled="!hasExternalPresets"
                :title="hasExternalPresets ? '' : t('agent.extNotInstalled')"
                @click="switchMode('external')"
              >
                <i class="fas fa-terminal text-[11px] text-gray-400 group-hover:text-white"></i>
                <div class="flex-1 min-w-0">
                  <div class="text-xs font-[530]">{{ t('chat.modeExternal') }}</div>
                  <div class="text-[10px] text-gray-400 group-hover:text-gray-300 truncate">{{ t('chat.modeExternalDesc') }}</div>
                </div>
              </button>
            </div>
          </Transition>
        </div>

        <!-- 选择下拉：随模式显示预设列表或团队列�?-->
        <div ref="pickerMenuRef" class="relative flex items-center">
          <button
            type="button"
            class="empty-picker-pill flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/15 backdrop-blur-md border border-gray-200/70 text-[12px] text-gray-700 hover:border-gray-400 transition-colors max-w-[200px]"
            @click="togglePickerMenu($event)"
          >
            <span class="truncate">{{ currentPickerLabel }}</span>
            <i class="fas fa-chevron-down text-[8px] text-gray-400 flex-shrink-0"></i>
          </button>
          <Transition name="cmd-pop">
            <div
              v-if="pickerMenuOpen"
              class="tool-popover absolute left-0 w-60 bg-white rounded-xl shadow-xl border border-gray-200 py-2 z-[9999] overflow-y-auto overscroll-contain custom-scroll"
              :class="pickerMenuUp ? 'bottom-full mb-2' : 'top-full mt-2'"
              :style="{ maxHeight: pickerMenuMaxH + 'px' }"
            >
              <template v-if="selectedMode === 'team'">
                <div v-if="teamsStore.teams.length === 0" class="px-3 py-3 text-center">
                  <p class="text-[11px] text-gray-400">{{ t('chat.noTeams') }}</p>
                  <p class="text-[10px] text-gray-300 mt-1">{{ t('chat.teamComingSoon') }}</p>
                </div>
                <button
                  v-for="team in teamsStore.teams"
                  :key="team.id"
                  type="button"
                  class="cmd-item w-full h-[46px] flex items-center gap-2.5 px-3 text-left hover:bg-gray-900 hover:text-white transition-colors group shrink-0 overflow-hidden"
                  @click="pickTeam(team.id)"
                >
                  <i class="fas fa-users text-[11px] text-gray-400 group-hover:text-white"></i>
                  <div class="flex-1 min-w-0">
                    <div class="text-xs font-[530] truncate">{{ team.name }}</div>
                    <div class="text-[10px] text-gray-400 group-hover:text-gray-300 truncate">{{ team.description || t('chat.memberCount', { n: team.members.length }) }}</div>
                  </div>
                </button>
              </template>
              <template v-else>
                <button
                  v-for="p in pickerPresetOptions"
                  :key="p.id"
                  type="button"
                  class="cmd-item w-full h-[46px] flex items-center gap-2.5 px-3 text-left hover:bg-gray-900 hover:text-white transition-colors group shrink-0 overflow-hidden"
                  @click="pickPreset(p.id)"
                >
                  <!-- ★1001：外部预设显示产品 logo 头像（无头像走原机器人图标） -->
                  <img v-if="p.avatar" :src="p.avatar" class="w-[18px] h-[18px] rounded object-cover flex-shrink-0" alt="" />
                  <i v-else class="fas fa-robot text-[11px] text-gray-400 group-hover:text-white"></i>
                  <div class="flex-1 min-w-0">
                    <div class="text-xs font-[530] truncate">{{ p.name }}</div>
                    <div class="text-[10px] text-gray-400 group-hover:text-gray-300 truncate">{{ p.description }}</div>
                  </div>
                </button>
              </template>
            </div>
          </Transition>
        </div>
      </div>
      <div class="w-full max-w-[600px] mx-auto empty-input">
        <!-- 0909⑤：计划卡不再挂输入框上方（改标题栏右侧 pill，见 dsh-session-header） -->
        <!-- 输入框接管：待处理的门禁/询问卡（dsh 样式；key 保证多题切换时组件重建，状态不残留） -->
        <ApprovalPanel
          v-if="pendingCard && pendingCard.kind === 'permission'"
          :key="pendingCard.block.request_id"
          :request_id="pendingCard.block.request_id"
          :question="pendingCard.block.question"
          :options="pendingCard.block.options"
          :tool="pendingCard.block.tool"
          :risk="pendingCard.block.risk"
          :answered="pendingCard.block.answered"
          :answered-value="pendingCard.block.answeredValue"
          @respond="handleHitlResponse"
        />
        <QuestionComposer
          v-else-if="pendingCard && pendingCard.kind === 'question'"
          :key="String(pendingCard.block.request_id || '') + '::' + qSubmitSeq"
          :questions="pendingCard.questions"
          :request_id="pendingCard.block.request_id"
          :question="pendingCard.block.question"
          :options="pendingCard.block.options"
          :placeholder="pendingCard.block.placeholder"
          :multiple="pendingCard.block.multiple"
          :answered="pendingCard.block.answered"
          :answered-value="pendingCard.block.answeredValue"
          @submit="handleQuestionSubmit"
          @ignore="handleQuestionIgnore"
        />
        <div v-else class="input-shell relative border border-gray-200 rounded-2xl flex flex-col" :data-drop-hint="t('chatInput.dropHint')" :class="{ 'drop-target': shellDragOver }" @dragover="onShellDragOver" @dragleave="onShellDragLeave" @drop="onShellDrop">
          <!-- 伪磨砂垫底层（不能放 .input-shell 自身，::before mask 冲突；材质见样式区注释） -->
          <div class="input-blur-layer absolute inset-0 rounded-2xl pointer-events-none" />
          <!-- ★1011：附件条 —— 空态原来缺这段 DOM（只有会话页有），拖入/选择文件后界面毫无反馈，文件其实已进 attachments ⇒ 用户感知"拖不进来" -->
          <AttachmentsBar :files="attachments" :hint="attachHint" @remove="removeAttachment" />
          <ChatInput ref="chatInputRef" :conv-id="String(props.conversation?.id ?? '')" @tag-click="chatStore.triggerFlash" @send="onEnterSend" @draft="onDraftChange" @attach="onAttachFiles" />
          <!-- 工具栏（与正常聊天一致：附件/权限/计划/快捷/锚点/模型/推理/发送） -->
          <div class="flex flex-wrap items-center justify-between gap-y-1.5 px-3 py-2">
            <div class="flex items-center gap-1 relative">
              <button @click="triggerFileInput" class="ci-attach-btn p-2 hover:bg-gray-100 rounded-full transition-colors" :title="t('chat.addAttachment')"><Paperclip :size="16" stroke-width="1.75" class="text-gray-600" /></button>
              <PermissionSelector v-model="permissionMode" />
              <PlanModeSelector v-model="planMode" />
              <QuickCommands />
              <SkillPicker />
              <!-- @成员单聊（0904）：组件化（0904 反馈：胶囊按钮/外点关闭/动画与快捷命令对齐） -->
              <MemberDmPicker
                v-if="currentTeamMembers.length"
                :members="currentTeamMembers"
                :target="dmTarget"
                @pick="pickDmMember"
                @clear="dmTarget = null"
              />
            </div>
            <div class="flex items-center space-x-3 input-meta-row">
<!-- ★0926（修「空态推理强度切换没了」）：禁止把 selectedModel/reasoningMode 绑进 :key——选完模型或拨一挡强度
     key 就变、组件整只重挂，弹层/强度卡交互状态（isOpen/effortOpen）全被销毁 ⇒ 选完模型强度卡永远弹不出来、
     强度卡一拨就闪关。显示刷新由响应式链保证（currentEffort 直读 conversationsStore，见 ModelSelector 续㊾ 注释）。 -->
<template v-if="!externalOwnModels">
      <ModelSelector v-model="selectedModel" v-model:effort="reasoningMode" @change="onModelPick" />
    </template>
    <!-- ★1001 外部预设 own 档：模型下拉=它家模型清单（MiniSelect 自家样式/深色适配） -->
    <MiniSelect v-else :model-value="selectedModel"
      :options="(externalOwnModels || []).map(m => ({ value: m, label: m }))"
      width="w-44" @update:model-value="onModelPick(String($event), 'external')" />
              <div class="w-4"></div>
              <!-- 0920：语音输入按钮（发送按钮左侧；开关联动——关掉语音输入它就消失） -->
              <VoiceInputButton @text="onVoiceText" />
              <button
                class="send-btn button"
                :class="{ 'is-sending': showStopBtn, 'is-interrupted': busyChannelOn() && draftHasText }"
                @click="onButtonSend"
              >
                <div class="outline"></div>
                <div class="state state--default">
                  <div class="icon">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                    <line x1="22" y1="2" x2="11" y2="13"/>
                    <polygon points="22 2 15 22 11 13 2 9 22 2"/>
                  </svg>
                  </div>
                  <p>
                    <span v-for="(ch, i) in t('chat.send').split('')" :key="i" :style="{ '--i': i }">{{ ch }}</span>
                  </p>
                </div>
                <div class="state state--sent">
                  <div class="icon">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
                    <rect x="4" y="4" width="16" height="16" rx="3"/>
                  </svg>
                  </div>
                  <p>
                    <span v-for="(ch, i) in t('chat.stop').split('')" :key="i" :style="{ '--i': i }">{{ ch }}</span>
                  </p>
                </div>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- ══�?正常聊天布局（消息流�?PiChatView 基于 pi 原始事件渲染�?══�?-->
    <template v-else>
    <!-- 对话滚动列（absolute 撑满左列；本身即定位上下文，供 PiChatView 与输入 dock 子层） -->
    <div class="absolute inset-0 flex flex-col overflow-hidden">
    <!-- 0909⑦改：主计划胶囊悬浮在对话区右上角（用户拍板：不进标题栏，要在对话范围内）。
         外层 pointer-events-none 不拦滚动，仅胶囊本体可点；列宽与消息列 max-w-3xl 对齐。 -->
    <div v-if="hasAnyPlanCard" class="absolute top-2 inset-x-0 z-30 flex justify-center pointer-events-none">
      <div class="w-full max-w-3xl px-6 flex flex-col items-end gap-1.5">
        <PlanCard v-if="boardPlanItems.length" class="pointer-events-auto" pill variant="board" :title="t('chat.planBoard')" :items="boardPlanItems" :conv-key="props.conversation?.id" @expired="clearBoardPlanLocal" />
        <PlanCard v-if="(props.conversation?.plan?.length || 0) > 0" class="pointer-events-auto" pill variant="agent" :title="t('chat.planAgent')" :items="props.conversation?.plan || []" :conv-key="props.conversation?.id" @expired="clearPlanLocal" />
        <PlanCard v-for="mp in memberPlanCards" :key="mp.key" class="pointer-events-auto" pill variant="member" :title="mp.memberName" :items="mp.items" :conv-key="props.conversation?.id" @expired="dismissMemberPlan(mp.key)" />
      </div>
    </div>
    <!-- ★ 0920：后台任务胶囊 —— 与右上角计划卡**对称但不混淆**：放**左上角**、
         靛蓝配色 + 闪电图标 + 明确写「后台」（计划卡是灰黑/琥珀/青 + 清单图标）。
         同样 pointer-events-none 外框不拦滚动，只有胶囊本体可点。 -->
    <div v-if="bgTasksForConv.length" class="absolute top-2 inset-x-0 z-30 flex justify-center pointer-events-none">
      <div class="w-full max-w-3xl px-6 flex flex-col items-start gap-1.5">
        <BgTaskPill :conv-id="props.conversation?.id ?? null" :open-task="openBgTask" />
        <!-- ★ 0922 D：任务详情弹窗（每个挂载点都要有，否则该布局下点「查看」无反应） -->
        <BgTaskModal
          v-if="bgModalId"
          :task-id="bgModalId"
          :conv-id="props.conversation?.id ?? null"
          @close="bgModalId = null"
        />
      </div>
    </div>
    <div v-if="!activeTask" class="absolute inset-0">
    <PiChatView v-if="!activeTask" class="h-full" ref="piChatViewRef" :conv-id="String(props.conversation?.id || '')" :selected-model="selectedModel" :bottom-inset="bottomInset" @scroll-state="onScrollState" @edit-send="onUserEditSend" @return-input="onUserReturnInput" @steer-recycle="onSteerRecycle" />
    </div>

    <!-- 后台任务视图：与正常对话同窗口，顶部简化（仅铃�?上下文圆环）、淡色背�?-->
    <div v-else class="absolute inset-0 overflow-y-auto custom-scroll">
      <div v-if="activeTask" class="max-w-3xl mx-auto p-6 space-y-4">
        <!-- ★ 0920：返回对话的入口 —— 原来靠输入框上方那条任务标签条（已撤掉），现在放这儿 -->
        <button
          class="flex items-center gap-1.5 text-[12px] text-gray-500 hover:text-gray-800 transition-colors"
          @click="selectBgTab(null)"
        >
          <i class="fas fa-arrow-left text-[10px]"></i>{{ t('bgTask.backToChat') }}
        </button>
        <!-- 任务状态卡 -->
        <div class="bg-white/90 border border-indigo-100 rounded-2xl p-5 shadow-sm" @mousedown="taskCtxMenu(activeTask, $event)">
          <div class="flex items-center justify-between gap-3">
            <div class="flex items-center gap-2 min-w-0">
              <span :class="['w-2 h-2 rounded-full flex-shrink-0', activeTask.status === 'background' ? 'bg-indigo-500 animate-pulse' : activeTask.status === 'completed' ? 'bg-green-500' : activeTask.status === 'paused' ? 'bg-amber-400' : 'bg-red-500']"></span>
              <span class="text-sm font-[640] text-gray-900 truncate">{{ activeTask.title }}</span>
              <span :class="['text-[10px] px-2 py-0.5 rounded-full font-[530] border', activeTask.status === 'background' ? 'bg-indigo-50 text-indigo-600 border-indigo-200' : activeTask.status === 'completed' ? 'bg-green-50 text-green-600 border-green-200' : activeTask.status === 'paused' ? 'bg-amber-50 text-amber-600 border-amber-200' : 'bg-red-50 text-red-600 border-red-200']">{{ bgStatusLabel }}</span>
            </div>
            <button v-if="activeTask.status === 'completed'" @click="removeBgTask(activeTask.task_id)" class="px-2.5 py-1 rounded-lg border border-gray-200 text-[11px] text-gray-500 hover:bg-gray-50 transition-colors flex-shrink-0">{{ t('chat.removeTask') }}</button>
          </div>
          <div class="text-[11px] text-gray-400 mt-1">{{ t('chat.taskIdLine', { id: activeTask.task_id, name: props.conversation?.title }) }}</div>

          <!-- 进度�?-->
          <div class="mt-4">
            <div class="flex items-center justify-between mb-1.5">
              <span class="text-[11px] text-gray-500">{{ t('chat.overallProgress') }}</span>
              <span class="text-[11px] text-gray-400">{{ bgDoneSteps }}/{{ activeTask.steps.length }} {{ t('chat.stepsDone') }}</span>
            </div>
            <div class="h-1.5 bg-gray-100 rounded-full overflow-hidden">
              <div class="h-full bg-indigo-500 rounded-full transition-all duration-500" :style="{ width: bgProgressPct + '%' }"></div>
            </div>
          </div>

          <!-- 步骤列表 -->
          <div class="mt-4 space-y-2">
            <div v-for="step in activeTask.steps" :key="step.id" class="flex items-center gap-2.5 text-[13px]">
              <i v-if="step.status === 'done'" class="fas fa-circle-check text-green-500 text-xs"></i>
              <i v-else-if="step.status === 'active'" class="fas fa-spinner fa-spin text-indigo-500 text-xs"></i>
              <i v-else class="fas fa-circle text-gray-200 text-xs"></i>
              <span :class="step.status === 'pending' ? 'text-gray-400' : 'text-gray-700'">{{ step.label }}</span>
            </div>
          </div>
        </div>

        <!-- 任务记录（气泡与原对�?1:1：用户右侧、Nis/伙伴左侧带头像） -->
        <div class="bg-white/80 border border-indigo-100 rounded-2xl p-5 shadow-sm">
          <div class="text-xs font-[640] text-gray-500 mb-4 flex items-center gap-1.5"><i class="fas fa-timeline text-indigo-400"></i>{{ t('chat.taskRecords') }}</div>
          <div v-if="!activeTask.records.length" class="text-[12px] text-gray-400 py-8 text-center">{{ t('chat.taskRecordsPending') }}</div>
          <div v-else class="space-y-4">
            <div v-for="rec in activeTask.records" :key="rec.id" @mousedown="bgRecCtxMenu(rec, $event)">
              <!-- 用户消息：右侧（与原对话用户气泡一致） -->
              <div v-if="rec.senderKey === 'user'" class="flex justify-end">
                <div class="max-w-[80%]">
                  <div class="bg-gray-100 text-gray-800 px-4 py-3 rounded-2xl rounded-tr-sm shadow-sm text-[15px]">{{ rec.content }}</div>
                  <div class="flex items-center justify-end gap-3 mt-1.5 text-xs text-gray-400">
                    <span>{{ rec.time }}</span>
                  </div>
                </div>
              </div>
              <!-- Nis / 伙伴消息：左侧带头像（与原对�?AI/伙伴气泡一致） -->
              <div v-else class="flex items-start gap-3">
                <template v-if="settingsStore.appearance?.bubbleAvatar !== false">
                  <LogAvatar
                    v-if="rec.senderKey !== 'Nis'"
                    :name="partnersStore.displayName(rec.senderKey)"
                    :image="partnersStore.avatar(rec.senderKey) || undefined"
                    :size="32"
                    class="flex-shrink-0"
                  />
                  <div v-else class="relative flex-shrink-0">
                    <!-- 0920：默认头像用 NIS logo（settingsStore.nisAvatar = 自定义 || 默认），
                         所以这里不再需要"没设头像就显示首字母"的兜底分支 -->
                    <LogAvatar :name="settingsStore.persona.nisName || 'Nis'" :image="settingsStore.nisAvatar" :size="32" />
                  </div>
                </template>
                <div class="flex-1 min-w-0">
                  <div class="flex items-center gap-2 mb-2">
                    <span class="font-[530] text-gray-700 text-sm">{{ rec.senderKey === 'Nis' ? (settingsStore.persona.nisName || 'Nis') : partnersStore.displayName(rec.senderKey) }}</span>
                    <span
                      v-if="rec.kind === 'summary'"
                      class="text-[10px] text-indigo-500 bg-indigo-50 px-2 py-0.5 rounded border border-indigo-200"
>{{ t('chat.taskSummary') }}</span>
                    <span
                      v-else-if="rec.senderKey !== 'Nis' && partnersStore.role(rec.senderKey)"
                      class="text-[10px] text-gray-500 bg-gray-100 px-2 py-0.5 rounded border border-gray-200"
                    >{{ partnersStore.role(rec.senderKey) }}</span>
                    <span v-else class="text-[10px] text-gray-500 bg-gray-100 px-2 py-0.5 rounded border border-gray-200">{{ t('chat.bgTask') }}</span>
                    <span class="text-[10px] text-gray-400">{{ rec.time }}</span>
                  </div>
                  <div class="mb-3 space-y-3">
                    <!-- 过程块（与原对话一致：可展开 + 计时�?-->
                    <div v-if="rec.processStates" class="space-y-1.5">
                      <template v-for="m in BG_PROCESS_META" :key="m.key">
                        <div
                          v-show="rec.processStates[m.key]"
                          class="flex items-center gap-2 text-sm text-gray-500 hover:text-gray-700 cursor-pointer group"
                          @click="toggleProcess(rec, m.key)"
                        >
                          <component :is="m.loader" :active="rec.processStates[m.key] === 'active'" :size="m.size" />
                          <ShinyText :text="m.label" :speed="4" className="font-[530]" :disabled="rec.processStates[m.key] === 'done'" />
                          <span class="text-xs text-gray-400">{{ bgProcessDuration(rec, m.key) }}</span>
                          <i :class="['fas fa-chevron-right text-xs text-gray-300 transition-all opacity-0 group-hover:opacity-100', isProcessOpen(rec, m.key) ? 'rotate-90' : '']"></i>
                        </div>
                        <Transition name="collapse">
                          <div
                            v-if="isProcessOpen(rec, m.key) && (m.key === 'thinking' ? !!rec.thinkingText : !!rec.processDetail?.[m.key]?.length)"
                            class="pl-7 text-xs"
                          >
                            <!-- Thinking：推理过�?= 自由流动文本，active 时流式逐字出现 -->
                            <p v-if="m.key === 'thinking'" class="whitespace-pre-wrap slow-shine leading-relaxed">
                              <StreamingText v-if="rec.processStates[m.key] === 'active'" :text="rec.thinkingText || ''" :active="true" />
                              <template v-else>{{ rec.thinkingText || '' }}</template>
                            </p>
                            <!-- 其它过程：结构化子项 -->
                            <div v-else class="space-y-1">
                              <div v-for="(sub, si) in rec.processDetail[m.key]" :key="si" class="flex items-center gap-2">
                                <i class="fas fa-circle text-[5px] text-gray-300"></i>{{ sub }}
                              </div>
                            </div>
                          </div>
                        </Transition>
                      </template>
                    </div>
                    <template v-if="rec.blocks?.length">
                      <MessageBlocks
                        v-for="(b, bi) in rec.blocks"
                        :key="bi"
                        :block="b"
                        :streaming="!rec.settled && bi === rec.blocks.length - 1"
                      />
                    </template>
                    <p v-else class="whitespace-pre-wrap text-gray-700 text-[15px] leading-relaxed">{{ rec.content }}</p>
                    <button
                      v-if="rec.detail?.length"
                      @click="toggleRec(rec)"
                      class="flex items-center gap-1 text-[11px] text-indigo-500 hover:text-indigo-700 transition-colors"
                    >
                      <i :class="['fas fa-chevron-down text-[9px] transition-transform', expandedRecs[rec.id] ? 'rotate-180' : '']"></i>
                      {{ expandedRecs[rec.id] ? t('chat.collapseDetail') : t('chat.expandDetail') }}（{{ rec.detail.length }}）
                    </button>
                    <div v-if="expandedRecs[rec.id]" class="space-y-1 border-t border-gray-100 pt-2">
                      <div v-for="(d, di) in rec.detail" :key="di" class="flex items-start gap-1.5 text-[13px] text-gray-600">
                        <i class="fas fa-circle text-[5px] mt-2 text-indigo-300 flex-shrink-0"></i>{{ d }}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 输入 dock：绝对浮层磨砂玻璃——消息从计划卡/输入框/统计胶囊后模糊穿过（真穿透）；
         bottomInset 动态预留浮层高度，贴底时最新回复完整显示在浮层上方 -->
    <div ref="inputDockRef" class="input-dock absolute inset-x-0 bottom-0 z-10 px-4 pb-3">
      <!-- 回到最新消息：显示在输入框正上方，居中 -->
      <Transition name="rise">
        <button
          v-if="showScrollButton"
          @click="scrollToBottom('smooth')"
          class="absolute left-1/2 -translate-x-1/2 bottom-full mb-2 w-10 h-10 rounded-full bg-white border border-gray-200 shadow-lg flex items-center justify-center text-gray-500 hover:text-gray-900 hover:shadow-xl transition-colors"
          :title="t('chat.backToLatest')"
        >
          <i class="fas fa-chevron-down text-sm"></i>
        </button>
      </Transition>
      <!-- ★ 0920：输入框上方的任务标签条**撤掉**了 —— 后台任务统一走左上角胶囊（BgTaskPill），
           否则同一批任务在两处出现（设计口径：面板做成计划卡那种折叠/展开的形态，放左上角）。 -->
      <template v-if="!activeTask">
      <input ref="fileInput" type="file" multiple hidden @change="onFileSelected" />
      <!-- 0909⑤：计划卡不再挂输入框上方（已移至标题栏右侧 pill，见 dsh-session-header） -->
      <!-- 待处理的门禁/询问卡：替换输入框（流内推挤布局，不遮挡消息） -->
      <template v-if="pendingCard && pendingCard.kind === 'permission'">
        <div class="w-full max-w-3xl mx-auto">
        <ApprovalPanel
          :key="pendingCard.block.request_id"
          :request_id="pendingCard.block.request_id"
          :question="pendingCard.block.question"
          :options="pendingCard.block.options"
          :tool="pendingCard.block.tool"
          :risk="pendingCard.block.risk"
          :answered="pendingCard.block.answered"
          :answered-value="pendingCard.block.answeredValue"
          @respond="handleHitlResponse"
        />
        </div>
      </template>
      <template v-else-if="pendingCard && pendingCard.kind === 'question'">
        <div class="w-full max-w-3xl mx-auto">
        <QuestionComposer
          :key="String(pendingCard.block.request_id || '') + '::' + qSubmitSeq"
          :request_id="pendingCard.block.request_id"
          :question="pendingCard.block.question"
          :questions="pendingCard.questions"
          :options="pendingCard.block.options"
          :placeholder="pendingCard.block.placeholder"
          :multiple="pendingCard.block.multiple"
          :answered="pendingCard.block.answered"
          :answered-value="pendingCard.block.answeredValue"
          @submit="handleQuestionSubmit"
          @ignore="handleQuestionIgnore"
        />
        </div>
      </template>
      <template v-else>
      <div class="input-shell relative w-full max-w-3xl mx-auto border border-gray-200 rounded-2xl flex flex-col" :data-drop-hint="t('chatInput.dropHint')" :class="{ 'drop-target': shellDragOver }" @dragover="onShellDragOver" @dragleave="onShellDragLeave" @drop="onShellDrop">
        <!-- 0911：排队条移到磨砂层【之前】（z 同层 0、DOM 靠前者衬底）——绝对定位不撑高输入框，
             压边部分被磨砂层半透明盖住 → 呈现"从输入框背后升起"（见 QueueBar.vue 顶部注释） -->
        <QueueBar :conv-id="props.conversation?.id" :items="queueStore.get(props.conversation?.id)" :paused="queueStore.isPaused(props.conversation?.id)" @steer="queueSteerItem" @edit="queueEditItem" @remove="queueRemoveItem" @move="queueMoveItem" @resume="queueResume" @purge-all="queuePurgeAll" />
        <!-- 伪磨砂垫底层（与上方输入框同法） -->
        <div class="input-blur-layer absolute inset-0 rounded-2xl pointer-events-none" />

        <!-- 单聊模式标识（0904 用户定稿）：极简黑胶囊"@成员名"+内嵌×退出，不写解释文案 -->
        <div v-if="dmTarget" class="relative flex items-center px-3 pt-2.5">
          <span class="inline-flex items-center gap-1.5 pl-2.5 pr-1.5 py-1 rounded-full text-[11px] font-[530] bg-gray-900 text-white">
            <i class="fas fa-at text-[9px] text-white/70"></i>{{ dmTarget.name }}
            <button @click="dmTarget = null" class="w-4 h-4 flex items-center justify-center rounded-full text-white/60 hover:text-white hover:bg-white/20 transition-colors" :title="t('chat.exitDm')">
              <i class="fas fa-times text-[8px]"></i>
            </button>
          </span>
        </div>

        <!-- 附件预览�?-->
        <AttachmentsBar :files="attachments" :hint="attachHint" @remove="removeAttachment" />
        <!-- 0911：排队条已上移至磨砂层之前（"从输入框背后升起"、不撑高输入框；见本容器第一行） -->
        <ChatInput ref="chatInputRef" :conv-id="String(props.conversation?.id ?? '')" @tag-click="chatStore.triggerFlash" @send="onEnterSend" @draft="onDraftChange" @attach="onAttachFiles" />
        <!-- 工具?-->
        <div class="flex flex-wrap items-center justify-between gap-y-1.5 px-3 py-2">
          <div class="flex items-center gap-1 relative">
            <button @click="triggerFileInput" class="ci-attach-btn p-2 hover:bg-gray-100 rounded-full transition-colors" :title="t('chat.addAttachment')"><Paperclip :size="16" stroke-width="1.75" class="text-gray-600" /></button>
            <PermissionSelector v-model="permissionMode" />
            <PlanModeSelector v-model="planMode" />
            <QuickCommands />
            <SkillPicker />
            <!-- @成员单聊（0904）：组件化（0904 反馈：胶囊按钮/外点关闭/动画与快捷命令对齐） -->
            <MemberDmPicker
              v-if="currentTeamMembers.length"
              :members="currentTeamMembers"
              :target="dmTarget"
              @pick="pickDmMember"
              @clear="dmTarget = null"
            />
          </div>
          <div class="flex items-center space-x-3">
            <!-- ★0926：同空态那处——:key 不得绑 selectedModel/reasoningMode（重挂会杀掉强度卡交互，见空态处注释） -->
            <template v-if="!externalOwnModels">
              <ModelSelector v-model="selectedModel" v-model:effort="reasoningMode" @change="onModelPick" />
            </template>
            <!-- ★1001 外部预设 own 档：模型下拉=它家模型清单（MiniSelect 自家样式/深色适配） -->
            <MiniSelect v-else :model-value="selectedModel"
              :options="(externalOwnModels || []).map(m => ({ value: m, label: m }))"
              width="w-44" @update:model-value="onModelPick(String($event), 'external')" />
            <div class="w-4"></div>
            <!-- 0920：语音输入按钮（发送按钮左侧；开关联动——关掉语音输入它就消失） -->
            <VoiceInputButton @text="onVoiceText" />
            <button
              class="send-btn button"
              :class="{ 'is-sending': showStopBtn, 'is-interrupted': busyChannelOn() && draftHasText }"
              @click="onButtonSend"
            >
              <div class="outline"></div>
              <div class="state state--default">
                <div class="icon">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                    <line x1="22" y1="2" x2="11" y2="13"/>
                    <polygon points="22 2 15 22 11 13 2 9 22 2"/>
                  </svg>
                </div>
                <p>
                  <span v-for="(ch, i) in t('chat.send').split('')" :key="i" :style="{ '--i': i }">{{ ch }}</span>
                </p>
              </div>
              <div class="state state--sent">
                <div class="icon">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
                    <rect x="4" y="4" width="16" height="16" rx="3"/>
                  </svg>
                </div>
                <p>
                  <span v-for="(ch, i) in t('chat.stop').split('')" :key="i" :style="{ '--i': i }">{{ ch }}</span>
                </p>
              </div>
            </button>
          </div>
        </div>
      </div>
      </template>
      </template>

      <!-- 后台任务消息输入（给后台任务发消息） -->
      <div v-else class="bg-input-row flex items-center gap-2 border border-gray-200 rounded-2xl bg-white shadow-sm px-3 py-2.5 focus-within:ring-1 focus-within:ring-gray-900 focus-within:border-gray-900 transition-shadow">
        <i class="fas fa-hourglass-half text-gray-400 text-xs"></i>
        <input
          v-model="bgInput"
          @keydown.enter="sendBgMessage"
          :placeholder="t('chat.bgInputPlaceholder')"
          class="flex-1 outline-none text-[14px] text-gray-800 bg-transparent"
        />
        <button
          @click="sendBgMessage"
          class="px-3 py-1.5 rounded-lg bg-black text-white text-xs font-[530] hover:bg-gray-800 transition-colors flex-shrink-0"
>{{ t('chat.send') }}</button>
      </div>

      <!-- 统计条（0907 图二重构）：PC=输入框下方完整胶囊行；手机=Teleport 到底部导航中心槽
           （compact 模式：上下文常驻+其余轮播）。Teleport 常驻+defer+:disabled 切换（动态挂载会崩）。
           ★1012 用户真机反馈「输入框界面的胶囊一个都没显示」：底部导航 1011 已整体撤掉，
           Teleport 目标 #mobile-tabbar-stats 成了 display:none 的死槽 ⇒ 手机端改成**原位渲染**
           （与 PC 同一位置：输入框下方一行，compact 样式仍然生效）。 -->
      <Teleport v-if="!activeTask" to="#mobile-tabbar-stats" defer disabled>
        <StatsLine v-bind="statsLineProps" :compact="isMobileUi" :class="isMobileUi ? '' : 'relative z-20'" />
      </Teleport>
    </div>
    </div>
    </template><!-- /正常聊天 v-else -->
    </template><!-- /对话四选一 v-else-if -->

    <!-- 预览 tab 内容区（有预览 tab 激活时替代对话内容；四选一分支，absolute 撑满左列。
         用独立 v-if 而非 v-else：上面对话 template 已含 activePreviewTabId===null 判定，二者互斥） -->
    <div v-if="currentFixedView === 'chat' && activePreviewTabId !== null" class="absolute inset-0 flex flex-col overflow-hidden">
      <PreviewTabContent />
    </div>

    </div><!-- /主视图左列 -->

    <!-- ══ 共享右栏（0904 终值）：对话/预览/浏览器/办公室四视图共用；两面板各自固定宽（日志 300 / 工作区 300），
         包装层宽=打开组合的自然合计（不再随窗口等比压缩，见 rightDocksWidth）；主视图由左列 flex-1 吃剩余空间。
         <1080px 保险丝整栏收起（保底左列 380 + 双栏合计 680 不溢出）。动画在包装层 width 过渡（面板自身不挂 Transition）。══ -->
    <div class="right-docks flex shrink-0 overflow-hidden transition-[width] duration-300 ease-[cubic-bezier(0.4,0,0.2,1)]" :style="{ width: rightDocksWidth }">
      <RunLogPanel v-if="runLogOpen" :open="runLogOpen" @close="runLogOpen = false" />
      <WorkspacePanel v-if="workspaceOpen" :open="workspaceOpen" @close="workspaceOpen = false" />
       <VersionPanel v-if="versionOpen" :open="versionOpen" @close="versionOpen = false" />
    </div>
    </div><!-- /会话级主体行 -->

    <!-- 右键菜单 -->
    <ContextMenu
      :visible="ctxMenu.visible"
      :x="ctxMenu.x"
      :y="ctxMenu.y"
      :items="ctxMenu.items"
      @close="closeCtxMenu"
    />
  </section>


  <!-- 重命名对话弹�?-->
  <Transition name="fade">
    <div v-if="renameModalVisible" class="fixed inset-0 z-50 flex items-center justify-center" @click.self="closeRename">
      <div class="absolute inset-0 bg-black/30" @click="closeRename"></div>
      <div class="relative bg-white border border-gray-200 rounded-xl shadow-sm w-80 p-5">
        <div class="flex items-center gap-2 mb-4">
          <i class="fas fa-pen text-gray-700 text-sm"></i>
          <span class="text-sm font-[640] text-gray-900">{{ t('chat.renameDialog') }}</span>
        </div>
        <input
          v-model="renameValue"
          class="w-full border border-gray-300 rounded-xl px-3 py-2 text-sm text-gray-700 focus:outline-none focus:border-black focus:ring-1 focus:ring-black"
          :placeholder="t('chat.renamePlaceholder')"
          @keydown.enter="confirmRename"
        />
        <div class="flex justify-end gap-2 mt-4">
          <button
            @click="closeRename"
            class="px-3.5 py-1.5 rounded-xl border border-gray-300 bg-white text-sm text-gray-700 hover:bg-gray-50 transition-colors"
          >
            {{ t('chat.cancel') }}
          </button>
          <button
            @click="confirmRename"
            class="px-3.5 py-1.5 rounded-xl bg-black text-white text-sm font-[530] hover:opacity-80 transition-opacity"
          >
            {{ t('chat.confirm') }}
          </button>
        </div>
      </div>
    </div>
  </Transition>

  <!-- 删除对话确认弹窗 -->
  <Transition name="fade">
    <div v-if="deleteModalVisible" class="fixed inset-0 z-50 flex items-center justify-center" @click.self="closeDeleteModal">
      <div class="absolute inset-0 bg-black/30" @click="closeDeleteModal"></div>
      <div class="relative bg-white border border-gray-200 rounded-xl shadow-sm w-80 p-5">
        <div class="flex items-center gap-2 mb-4">
          <i class="fas fa-trash-alt text-gray-700 text-sm"></i>
          <span class="text-sm font-[640] text-gray-900">{{ t('chat.deleteDialog') }}</span>
        </div>
        <p class="text-sm text-gray-500 mb-5">{{ t('chat.deleteConfirmPrefix') }}{{ props.conversation?.title }}{{ t('chat.deleteConfirmSuffix') }}</p>
        <div class="flex justify-end gap-2">
          <button
            @click="closeDeleteModal"
            class="px-3.5 py-1.5 rounded-xl border border-gray-300 bg-white text-sm text-gray-700 hover:bg-gray-50 transition-colors"
          >
            {{ t('chat.cancel') }}
          </button>
          <button
            @click="confirmDeleteConversation"
            class="px-3.5 py-1.5 rounded-xl bg-black text-white text-sm font-[530] hover:opacity-80 transition-opacity"
          >
            {{ t('chat.delete') }}
          </button>
        </div>
      </div>
    </div>
  </Transition>

    <!-- 视图内对话悬浮球：浏览器/办公室/画布/预览 这类非纯对话视图右下角出现（纯对话视图本身就有对话，不重复） -->
    <ViewChatDock
      v-if="(currentFixedView !== 'chat' || activePreviewTabId !== null) && props.conversation?.id != null"
      :conversation-id="String(props.conversation.id)"
    />
</template>

  <style scoped>
/* 空对话：地球 2x 背景 + 问候语/输入框垂直居�?*/
/* ★1012av：骨架方案回退后，`.chat-opening-skel ~ .empty-layout` 这条 CSS 保险一并撤除。 */

/* ★1012aw/1012ax：空态页的"正在加载"指示 —— 用户先要"别干等"（顶部小胶囊），反馈"太小了"，
   改为**对话区正中弹窗**：竖排（转圈在上、文案在下）、卡片式、加大尺寸。
   仍然 **pointer-events: none**（不挡地球/输入框/任何点击）、深色自适应；加载完由 v-if 自动移除。 */
.empty-loading-modal {
  position: absolute;
  top: 46%;                 /* 略高于几何中心：视觉重心更舒服，也把下方留给输入框 */
  left: 50%;
  transform: translate(-50%, -50%);
  z-index: 40;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  min-width: 210px;
  padding: 26px 34px;
  border-radius: 16px;
  font-size: 14.5px;
  letter-spacing: 0.02em;
  color: #4b5563;
  background: rgba(255, 255, 255, 0.9);
  border: 1px solid rgba(0, 0, 0, 0.07);
  box-shadow: 0 10px 34px rgba(0, 0, 0, 0.12), 0 2px 8px rgba(0, 0, 0, 0.06);
  backdrop-filter: blur(8px);
  pointer-events: none;
}
html.dark .empty-loading-modal {
  color: #d6d6de;
  background: rgba(38, 38, 44, 0.92);
  border-color: rgba(255, 255, 255, 0.12);
  box-shadow: 0 10px 34px rgba(0, 0, 0, 0.5);
}
.elc-spin {
  width: 30px;
  height: 30px;
  border-radius: 9999px;
  border: 3px solid currentColor;
  border-top-color: transparent;
  opacity: 0.85;
  animation: elcSpin 0.7s linear infinite;
}
@keyframes elcSpin { to { transform: rotate(360deg); } }

.empty-layout {
  /* 0904 bug3：宿主改为"主视图左列"（block）后，flex:1+relative 高度塌陷、空态缩顶部；
     absolute 直接写进 CSS——模板加 tailwind class 会被本 scoped 规则特异性压回 relative（翻车根因） */
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 0 24px;
  overflow: hidden;
}

.empty-globe {
  position: absolute;
  inset: 0;
  pointer-events: none;
  display: flex;
  align-items: center;
  justify-content: center;
}
.empty-greeting {
  position: relative;
  z-index: 2;
  margin-bottom: 24px;
  text-align: center;
}
.empty-input {
  position: relative;
  z-index: 2;
  width: 100%;
  max-width: 600px;
}

/* DSH 风格会话标题栏：仅标题，无分隔线 */
.dsh-session-header {
  position: relative;
  flex: none;
  display: flex;
  align-items: center;
  gap: 10px;
  /* 0911：右侧 padding 28→10px——窗口按钮组挂本行右端，贴角更近（原 28px 为大留白设计） */
  padding: 12px 10px 0 20px;
}
.dsh-session-title {
  font-size: 14px;
  font-weight: 500;
  color: #111827;
  line-height: 28px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 100%;
}

/* 拖拽文件到聊天区：高亮提�?*/
/* ★1011w-2：拖入提示改用**外壳自己的虚线边框 + 伪元素**（不再放独立的高亮 div）。
   理由：之前那个 absolute 提示层在部分布局下会画偏（实测"提示跑到输入框上面"），
   而边框与 ::after 一定跟着 .input-shell 走 —— 覆盖范围天然等于整个输入框，不会错位。 */
.input-shell.drop-target {
  border-color: #6366f1 !important;
  border-style: dashed !important;
  border-width: 2px !important;
  background: rgba(99, 102, 241, 0.06);
}
.input-shell.drop-target::after {
  content: attr(data-drop-hint);
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
  z-index: 40;
  font-size: 13px;
  font-weight: 530;
  color: #4f46e5;
  background: rgba(238, 242, 255, 0.82);
  border-radius: 14px;
}
.chat-dragover {
  outline: 2px dashed #4f46e5;
  outline-offset: -8px;
  background: rgba(79, 70, 229, 0.04);
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

.rise-enter-active,
.rise-leave-active {
  transition: opacity 0.25s ease, transform 0.25s ease;
}
.rise-enter-from,
.rise-leave-to {
  opacity: 0;
  transform: translate(-50%, 20px);
}

/* 空态渐隐：首条消息发出时地�?问候语淡出 */
.empty-fade-leave-active {
  transition: opacity 0.45s ease;
}
.empty-fade-leave-to {
  opacity: 0;
}

/* 工作模式/Agent 选择下拉：与快捷命令同款弹出动画 */
.cmd-pop-enter-active {
  animation: pickerPopIn 0.22s cubic-bezier(0.34, 1.56, 0.64, 1) both;
}
.cmd-pop-leave-active {
  animation: pickerPopOut 0.13s ease-in both;
}
@keyframes pickerPopIn {
  from { opacity: 0; transform: translateY(6px) scale(0.95); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}
@keyframes pickerPopOut {
  from { opacity: 1; transform: translateY(0) scale(1); }
  to { opacity: 0; transform: translateY(6px) scale(0.95); }
}

/* ── dsh 风格气泡（对�?design-platform 令牌�?── */

/* AI 正文排版�?6px/28px 行高，label-primary 颜色（dsh AssistantMarkdown root�?*/
.dsh-ai-body {
  font-size: 16px;
  line-height: 28px;
  color: var(--dsw-alias-label-primary);
}

/* 用户消息列：右对齐，气泡 + 操作行（dsh userRow 语义�?*/
.dsh-user-col {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 6px;
  min-width: 0;
}

/* 用户气泡：浅蓝底 deepseek-50�?2px 大圆角，16px/24px 正文 */
.dsh-user-bubble {
  max-width: 100%;
  background: var(--dsw-specific-bubble);
  /* 0913：圆角走全局变量（设置→外观→气泡圆角；缺省 22px 保持原设计） */
  border-radius: var(--dsh-bubble-radius, 22px);
  padding: 10px 16px;
  font-size: 16px;
  line-height: 24px;
  color: var(--dsw-alias-label-primary);
  word-break: break-word;
  white-space: pre-wrap;
}

/* 首条用户消息：从自身右上角展开（transform-origin 右上�?+ 缩小放大），视觉从右上出�?*/
.msg-user-in-first {
  transform-origin: top right;
  animation: msgUserFirstIn 0.55s cubic-bezier(0.16, 1, 0.3, 1) both;
}
@keyframes msgUserFirstIn {
  from {
    opacity: 0;
    transform: translate(36px, -24px) scale(0.55);
  }
  to {
    opacity: 1;
    transform: translate(0, 0) scale(1);
  }
}

/* 后续用户消息：从实际位置的正右方水平滑入 */
.msg-user-in {
  transform-origin: right center;
  animation: msgUserSlideIn 0.4s cubic-bezier(0.16, 1, 0.3, 1) both;
}
@keyframes msgUserSlideIn {
  from {
    opacity: 0;
    transform: translateX(48px);
  }
  to {
    opacity: 1;
    transform: translateX(0);
  }
}

.collapse-enter-active,
.collapse-leave-active {
  transition: all 0.25s ease-out;
  overflow: hidden;
}
.collapse-enter-from,
.collapse-leave-to {
  opacity: 0;
  max-height: 0;
  padding-top: 0;
  padding-bottom: 0;
}

.slow-shine {
  background: linear-gradient(120deg, rgba(75, 85, 99, 0.6) 40%, rgba(75, 85, 99, 1) 50%, rgba(75, 85, 99, 0.6) 60%);
  background-size: 300% 100%;
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
  color: transparent;
  animation: slowShine 10s linear infinite;
}

@keyframes slowShine {
  0% { background-position: 150%; }
  100% { background-position: -150%; }
}

.streaming-cursor {
  display: inline-block;
  width: 2px;
  height: 1em;
  background: #6366f1;
  margin-left: 2px;
  vertical-align: text-bottom;
  animation: blink 1s step-end infinite;
}

@keyframes blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0; }
}

/* ===== Send Button (fox-61 style) ===== */
.send-btn {
  --primary: #6366F1;
  --neutral-1: #1e1e2e;
  --neutral-2: #0a0a12;
  --radius: 9999px;

  cursor: pointer;
  border-radius: var(--radius);
  text-shadow: 0 1px 1px rgba(0, 0, 0, 0.3);
  border: none;
  box-shadow: 0 0.5px 0.5px 1px rgba(0, 0, 0, 0.2),
    0 10px 20px rgba(0, 0, 0, 0.2), 0 4px 5px 0px rgba(0, 0, 0, 0.05);
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
  transition: all 0.3s ease;
  /* 圆形：宽高相等，去掉文字内边�?*/
  /* ★ 0923（用户定）：发送按钮 36px（语音 28 保持），一大一小、主次分明 */
  width: 36px;
  min-width: 36px;
  height: 36px;
  padding: 0;
  font-family: inherit;
  font-style: normal;
  font-size: 13px;
  font-weight: 600;
  color: #ffffff;
  background: var(--neutral-1);
  flex-shrink: 0;
}

/* 0911 反馈③（第三次修）：悬停「位置偏移」根治——删除一切会改几何的悬停效果：
   ① 原 .send-btn:hover { transform: scale(1.05) }：整钮（含飞机）hover 放大 5%，边沿各向外扩 ~1px，读作"位置动了"；
   ② 原 .send-btn:hover::after { transform: scale(1.05, 1.1) }：非均匀放大，描边环上下各胀 ~1.9px。
   新策略：悬停/按下只改"光效"（外发光/阴影/流动环），按钮与飞机几何全程零位移。 */
.send-btn:hover {
  box-shadow: 0 0 1px 2px rgba(99, 102, 241, 0.35),
    0 15px 30px rgba(0, 0, 0, 0.28), 0 10px 3px -3px rgba(0, 0, 0, 0.04);
}

.send-btn:active {
  box-shadow: 0 0 1px 2px rgba(99, 102, 241, 0.32),
    0 10px 3px -3px rgba(0, 0, 0, 0.2);
}

.send-btn:after {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: var(--radius);
  border: 1px solid transparent;
  background: linear-gradient(var(--neutral-1), var(--neutral-2)) padding-box,
    linear-gradient(to bottom, rgba(0, 0, 0, 0.1), rgba(0, 0, 0, 0.45))
      border-box;
  z-index: 0;
  transition: all 0.4s ease;
}

.send-btn:hover::after {
  /* 0911 反馈③：去掉 scale(1.05,1.1)——非均匀放大让描边环上下多胀 ~1.9px，是"位置会动"观感的一大来源 */
  box-shadow: inset 0 -1px 3px 0 rgba(99, 102, 241, 0.3);
}

.send-btn::before {
  content: "";
  inset: 4px 4px 4px 4px;
  position: absolute;
  background: linear-gradient(to top, var(--neutral-1), var(--neutral-2));
  border-radius: 30px;
  filter: blur(0.5px);
  z-index: 2;
}

.state p {
  display: none;
}

.state .icon {
  position: absolute;
  left: 0;
  right: 0;
  top: 0;
  bottom: 0;
  margin: auto;
  transform: scale(1);
  transition: all 0.3s ease;
  display: flex;
  align-items: center;
  justify-content: center;
}

.state .icon svg {
  overflow: visible;
}

/* Outline：流光环（mask 裁剪成按钮边缘一圈，很细�?*/
.outline {
  position: absolute;
  border-radius: 9999px;
  overflow: hidden;
  z-index: 1;
  opacity: 0;
  transition: opacity 0.4s ease;
  inset: 0;
}

.outline::before {
  content: "";
  position: absolute;
  inset: 0;
  background: conic-gradient(
    from 180deg,
    transparent 70%,
    rgba(255, 255, 255, 0.95) 82%,
    transparent 90%
  );
  /* 只保留按钮边�?1.5px 的圆环，内部不显示流�?*/
  -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 1.5px), #000 calc(100% - 1.5px));
  mask: radial-gradient(farthest-side, transparent calc(100% - 1.5px), #000 calc(100% - 1.5px));
  animation: sendSpin 1.6s linear infinite;
  animation-play-state: paused;
}

@keyframes sendSpin {
  0% { transform: rotate(0deg); }
  100% { transform: rotate(360deg); }
}

.send-btn:hover .outline {
  opacity: 1;
}

.send-btn:hover .outline::before {
  animation-play-state: running;
}

/* 发送中：流光环持续旋转（回复中反馈），方块保持静止 */
.send-btn.is-sending .outline {
  opacity: 1;
}

.send-btn.is-sending .outline::before {
  animation-play-state: running;
}

/* Interrupted state: show rotating outline glow */
.send-btn.is-interrupted .outline {
  opacity: 1;
}

.send-btn.is-interrupted .outline::before {
  animation-play-state: running;
}

/* Letters */
.state p span {
  display: block;
  opacity: 0;
  animation: letterSlideDown 0.8s ease forwards calc(var(--i) * 0.03s);
}

.send-btn:hover p span {
  opacity: 1;
  animation: letterWave 0.5s ease forwards calc(var(--i) * 0.02s);
}

.send-btn.is-sending p span {
  opacity: 1;
  animation: letterDisappear 0.6s ease forwards calc(var(--i) * 0.03s);
}

@keyframes letterWave {
  30% { opacity: 1; transform: translateY(4px) translateX(0) rotate(0); }
  50% { opacity: 1; transform: translateY(-3px) translateX(0) rotate(0); color: var(--primary); }
  100% { opacity: 1; transform: translateY(0) translateX(0) rotate(0); }
}

@keyframes letterSlideDown {
  0% { opacity: 0; transform: translateY(-20px) translateX(5px) rotate(-90deg); color: var(--primary); filter: blur(5px); }
  30% { opacity: 1; transform: translateY(4px) translateX(0) rotate(0); filter: blur(0); }
  50% { opacity: 1; transform: translateY(-3px) translateX(0) rotate(0); }
  100% { opacity: 1; transform: translateY(0) translateX(0) rotate(0); }
}

@keyframes letterDisappear {
  from { opacity: 1; }
  to { opacity: 0; transform: translateX(5px) translateY(20px); color: var(--primary); filter: blur(5px); }
}

/* Plane：发送时飞机飞离（带旋转+尾迹），停止时弹�?*/
/* Plane：发送时飞机飞离（带旋转+尾迹），停止时弹回。
   0911 反馈⑦：①静止位改 translate(-1px, 1.3px)——纸飞机描边墨迹重心天然偏上（实测 ~1.5px），
   下移 1.3px 做视觉居中，修正「未悬停偏上」；②移除悬停时 icon 的单独 scale(1.08)：悬停仅保留
   按钮整体等比缩放（1.05），飞机随按钮同步缩放、相对位置零位移，消除「悬停时飞机向下动一点」。 */
.state--default .icon svg {
  transform: translate(-1px, 1.3px);
  animation: planeIn 0.25s ease;
}

.send-btn.is-sending .state--default svg {
  animation: planeTakeOff 0.4s ease-in forwards;
}

.send-btn.is-sending .state--default .icon {
  transform: scale(1);
}

@keyframes planeTakeOff {
  0% { opacity: 1; transform: translate(-1px, 1.3px) rotate(0) scale(1); }
  100% { opacity: 0; transform: translate(16px, -22px) rotate(28deg) scale(0.2); filter: blur(2px); }
}

@keyframes planeIn {
  /* 进/出落点与静止基准 translate(-1px, 1.3px) 保持一致：动画结束不填充也不会在收尾瞬间横跳 1px */
  from { opacity: 0; transform: translate(-1px, 7.3px) scale(0.85); }
  to { opacity: 1; transform: translate(-1px, 1.3px) scale(1); }
}

/* Contrail */
.state--default .icon:before {
  content: "";
  position: absolute;
  top: 50%;
  height: 2px;
  width: 0;
  left: -5px;
  background: linear-gradient(to right, transparent, rgba(255, 255, 255, 0.5));
}

.send-btn.is-sending .state--default .icon:before {
  animation: contrail 0.4s ease-out forwards;
}

@keyframes contrail {
  0% { width: 0; opacity: 1; }
  100% { width: 44px; opacity: 0; }
}

/* States：每�?state 撑满按钮，内容居中，图标正立 */
.state {
  position: absolute;
  inset: 0;
  z-index: 2;
  display: flex;
  align-items: center;
  justify-content: center;
}

.state--default span:nth-child(4) {
  margin-right: 5px;
}

.state--sent {
  display: none;
}

.state--sent svg {
  transform: none;
  margin: 0;
}

.send-btn.is-sending .state--default {
  position: absolute;
}

.send-btn.is-sending .state--sent {
  display: flex;
  opacity: 0;
  animation: stopIn 0.2s ease 0.2s forwards;
}

.send-btn.is-sending .state--sent span {
  opacity: 0;
  animation: letterSlideDown 0.8s ease forwards calc(var(--i) * 0.2s);
}

/* 停止方块：静止不动（反馈感由外围流光环提供） */
.send-btn.is-sending .state--sent .icon svg {
  opacity: 1;
}

@keyframes stopIn {
  from { opacity: 0; transform: scale(0.6); }
  to { opacity: 1; transform: scale(1); }
}

/* 右侧面板（日志/工作区）展开收起动画（0902 反馈 #3）：
   width 收展 + opacity，不用 backdrop-filter/transform 避免铁律 23 布局问题 */
.side-panel-enter-active,
.side-panel-leave-active {
  transition: width 0.28s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.22s ease;
  overflow: hidden;
}
.side-panel-enter-from,
.side-panel-leave-to {
  width: 0 !important;
  opacity: 0;
}
.side-panel-enter-to,
.side-panel-leave-from {
  opacity: 1;
}

/* ===== 输入框悬停/聚焦交互（0903） =====
   悬停=细线描边点亮一圈柔光；聚焦/正在编辑=细线里一段光绕边框缓慢流动。
   用 padding-box/border-box 双遮罩把渐变"只留 1px 边框环"（border-box trick）；
   @property 让 conic 角度可动画（不支持时退化为静止柔光环，不报错）。 */
.input-shell {
  border-color: rgb(229, 231, 235);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.06);
  transition: border-color 0.3s ease, box-shadow 0.3s ease;
}
/* 磨砂垫底层（0903 终版）：真模糊 + 可见半透明底双保险——环境 backdrop-filter 采样可用时
   是真玻璃（用户实测胶囊 blur 正常，铁律 #23 的 F5 失效结论不再成立）；失效时退化为
   半透明白卡仍然可见可读。position 必须 !important：.input-shell > *[data-v]（0-2-0）
   会盖过 Tailwind .absolute（0-1-0）把本层改成 relative → 塌缩 0 高 → 整层不可见。 */
.input-blur-layer {
  position: absolute !important;
  z-index: 0 !important;
  inset: 0;
  background: linear-gradient(160deg, rgba(255, 255, 255, 0.66) 0%, rgba(255, 255, 255, 0.5) 100%);
  backdrop-filter: blur(16px) saturate(1.6);
  -webkit-backdrop-filter: blur(16px) saturate(1.6);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.9);
}
/* ⑦ 空态（地球线稿背景）：输入框垫底层要"看得穿"——重模糊(16px)+saturate 会把背后的淡线稿整个抹平成实心白，反而显不透明。
   这里降低模糊与白底，让地球线稿隐约透出，才读得出玻璃半透感。 */
.empty-input .input-blur-layer {
  background: linear-gradient(160deg, rgba(255, 255, 255, 0.3) 0%, rgba(255, 255, 255, 0.16) 100%);
  backdrop-filter: blur(7px) saturate(1.05);
  -webkit-backdrop-filter: blur(7px) saturate(1.05);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.35);
}
.empty-input .input-shell {
  border-color: rgba(180, 184, 195, 0.5);
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.04);
}
/* 0919：导入助手的「填入导入引导词」胶囊 —— 材质**完全对齐输入框**（需求要求"跟输入框一样做半透明"）。
   刻意不写 Tailwind 的 bg-white/70：那是"填色"，而输入框是"磨砂玻璃"。
   这里直接复刻 .input-blur-layer 的两档参数（常规档 / 空态档），空态在 .empty-layout 下自动更透，
   这样胶囊与它下面的输入框永远是同一块玻璃，不会一个实一个透。 */
.import-chip {
  background: linear-gradient(160deg, rgba(255, 255, 255, 0.66) 0%, rgba(255, 255, 255, 0.5) 100%);
  backdrop-filter: blur(16px) saturate(1.6);
  -webkit-backdrop-filter: blur(16px) saturate(1.6);
  border: 1px solid rgb(229, 231, 235);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.9);
}
.empty-layout .import-chip {
  background: linear-gradient(160deg, rgba(255, 255, 255, 0.3) 0%, rgba(255, 255, 255, 0.16) 100%);
  backdrop-filter: blur(7px) saturate(1.05);
  -webkit-backdrop-filter: blur(7px) saturate(1.05);
  border-color: rgba(180, 184, 195, 0.5);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.35);
}
.import-chip:hover {
  border-color: rgba(156, 163, 175, 0.75);
}
/* 空态右上角两个下拉：同样降到近乎无填充 + 轻模糊，只留描边，让地球透出来 */
.empty-layout .empty-picker-pill {
  background: rgba(255, 255, 255, 0.12) !important;
  border-color: rgba(180, 184, 195, 0.5) !important;
  backdrop-filter: blur(3px) saturate(1.05);
  -webkit-backdrop-filter: blur(3px) saturate(1.05);
}
@property --nis-angle {
  syntax: '<angle>';
  initial-value: 0deg;
  inherits: false;
}
.input-shell::before {
  content: '';
  position: absolute;
  inset: -1px;
  border-radius: 17px; /* rounded-2xl(16) + 1px 边框厚 */
  padding: 1.5px;
  background: conic-gradient(
    from var(--nis-angle),
    transparent 0deg,
    rgba(99, 102, 241, 0.15) 60deg,
    rgba(99, 102, 241, 0.8) 90deg,
    rgba(56, 189, 248, 0.15) 140deg,
    transparent 180deg,
    transparent 360deg
  );
  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  -webkit-mask-composite: xor;
  mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  mask-composite: exclude;
  pointer-events: none;
  z-index: 0;
}
/* 静止态：::before 柔光极淡 */
.input-shell::before {
  opacity: 0.25;
  transition: opacity 0.3s ease;
}
/* 悬停：细线发光加强（柔光但不流动） */
.input-shell:hover::before {
  opacity: 0.55;
}
.input-shell:hover {
  border-color: rgba(99, 102, 241, 0.35);
  box-shadow: 0 2px 10px rgba(99, 102, 241, 0.10);
}
/* 聚焦/编辑：细线光效缓慢流动（一圈约 7.5s） */
.input-shell:focus-within {
  border-color: rgba(99, 102, 241, 0.6);
  box-shadow: 0 2px 12px rgba(99, 102, 241, 0.16);
}
.input-shell:focus-within::before {
  opacity: 1;
  animation: nis-border-flow 7.5s linear infinite;
}
@keyframes nis-border-flow {
  to { --nis-angle: 360deg; }
}
/* 输入框内正文/编辑器保持在上层（不被 ::before 遮罩盖住） */
.input-shell > * {
  position: relative;
  z-index: 1;
}
@media (prefers-reduced-motion: reduce) {
  .input-shell:focus-within::before {
    animation: none;
  }
}
</style>
