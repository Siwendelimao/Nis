import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { useProjectsStore } from './projects'
import { useSettingsStore } from './settings'
import { useAgentPresetsStore } from './agentPresets'
import { usePreviewTabsStore } from './previewTabs'
import { useProvidersStore } from './providers'
import { useExternalChatStore } from './externalChat'
import { BRIDGE_URL } from '../utils/bridgeUrl'
import { authHeaders } from '@/utils/nisToken'
import { localStore } from '@/utils/localStore'
import { swallowed } from '@/utils/swallowed'

export async function bridgeRpc(method: string, payload: any = {}, timeoutMs = 30000): Promise<any> {
  const rpcId = crypto.randomUUID()
  let res: Response
  try {
    res = await fetch(`${BRIDGE_URL}/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders() },
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
    })
  } catch (e: any) {
    if (e?.name === 'TimeoutError') throw new Error(`后端响应超时（${method}，${Math.round(timeoutMs / 1000)}s 无响应——后端可能正忙，可重试）`)
    throw e
  }
  if (!res.ok) throw new Error(`Bridge API ${method} failed: ${res.status}`)
  const data = await res.json()
  if (data.result?.ok === false) throw new Error(data.result.error)
  return data.result?.value
}

export interface Conversation {
  id: string
  /** 创建时间戳（用于最新排最上） */
  createdAt?: number
  /** 最近活动时间戳（刷新/打包后首次打开取最新一条） */
  updatedAt?: number
  /** 展示标题：手动重命名 > 首条用户消息 > 'Nis' */
  title: string
  /** 手动重命名（优先级最高，设置后不再被首条消息覆盖） */
  customTitle?: string
  /** 该对话用户发的第一条消息（自动标题来源，只在首条时记一次） */
  firstUserMessage?: string
  lastMessage: string
  time: string
  unread: number
  /** 置顶：置顶的会话排到列表顶部并显示置顶标识 */
  pinned?: boolean
  /** 所属项目 id：null = 本体聊天（聊天 tab）；非空 = 该项目下的聊天窗口（项目 tab 树） */
  project_id?: string | null
  /** 会话工作区：项目会话=项目 root_path；普通聊天=储存目录下按时间戳建的子目录（产出/下载默认落这里） */
  workDir?: string
  /** 创建时定型的 Agent 预设 id（运行中不换，对齐 dsh 语义） */
  presetId?: string
  /** 思考强度（0908六：按会话隔离持久化；undefined=跟随全局默认） */
  effort?: string
  /** 0920：工作模式（plan=计划 / build=构建 / default=默认）——随会话持久化，刷新后从 session.list 回填。
   *  ⚠️ 必须映射：漏了会「后端按计划模式注入指令、界面显示默认模式」的状态不一致。 */
  mode?: string
  /** 团队 id（P1 配置绑定；P2 编排运行时消费） */
  teamId?: string
  /** 计划本（AI 拆解任务写入；输入框上方计划卡渲染） */
  plan?: Array<{ text: string; done: boolean }>
  /** 0910 三批①计划面板三合一：黑板计划与主计划分开存（原先共用一个字段互相覆盖=串台） */
  boardPlan?: Array<{ text: string; done: boolean }>
  /** 是否正在 AI 回复中（列表显示缓冲动画；完成后由未读/预览承接） */
  replying?: boolean
  /** 等待用户交互的类型：permission=等待权限卡作答 / ask=等待询问卡作答；null=无 */
  pendingInteraction?: 'permission' | 'ask' | null
  /** 0912 接入批：会话来源通道（undefined/空=普通聊天列表；'wechat'|'qq'|'remote'=归属该通道独享列表）。
   *  双向可迁移（channel.moveSession）—— 因为通道会话本就是普通会话，迁移只改这一个字段。 */
  origin?: string
  /** 0912 十九批：定时任务支线标记（= 所属任务 id）—— 列表打 ⏰、右键改「放回定时任务」、禁止直接删 */
  taskId?: string
  /** 该任务支线是否出现在主对话列表（穿插默认 false / 列表通知默认 true；可右键放回） */
  inMainList?: boolean
  /** ★ 0922z2b：**迁入主对话列表的时间**（「独享会话 → 移到聊天列表」时后端打点）。
   *  侧栏按 max(updatedAt, movedInAt) 排序 ⇒ 刚挪进来的排最前，聊过之后自然回落。 */
  movedInAt?: number
}

/** 滞留处对话：删除后暂存，到期彻底清除（含桥接会话） */
interface TrashedConversation {
  conversation: Conversation
  /** 移入滞留处的时间戳 */
  deleted_at: number
  /** 保留天数（到期自动彻底清除） */
  keep_days: number
}

/**
 * 会话 store —— 聊天列表与聊天窗口共享状态
 *
 * 标题规则：
 *   - 手动重命名（renameConversation）后固定使用该名字
 *   - 未手动重命名时，用用户发的第一条消息作标题（ensureAutoTitle，仅首条设置一次）
 *   - 都没有时回退为 'Nis'
 *
 * 未读规则：
 *   - 用户打开某对话（openConversation）即清零
 *   - AI 回复完成（onAiReplyCompleted）时，若该对话不是当前打开的对话，未读数 +1
 *   - 本地模拟回复与真实 WebSocket 回复都走 onAiReplyCompleted 这一个入口
 */
export const useConversationsStore = defineStore('conversations', () => {
  // 静态 mock 数据，上线时替换为后端数据。标题已按「首条用户消息」规则初始化
  // 注：演示数据已移除，聊天 tab 初始为空，由「+ 新对话」创建；项目 tab 由「+ 新建项目」创建
  const conversations = ref<Conversation[]>([])
  /** 0914c：首轮 session.list 是否已尝试完成（成败都置真）——侧栏未就绪态显示骨架占位用 */
  const listLoaded = ref(false)

  /** 会话消息缓存：按 convId 存消息数组（组件卸载/切换窗口不丢，问题4修复） */
  const messagesByConv = ref<Record<string, any[]>>({})

  function getMessages(convId: string): any[] {
    if (!messagesByConv.value[convId]) {
      messagesByConv.value[convId] = []
    }
    return messagesByConv.value[convId]
  }

  function setMessages(convId: string, list: any[]) {
    messagesByConv.value[convId] = list
  }


  const activeConversationId = ref<string | null>(null)

  /** ⑥ 新对话草稿：点"新建"不再立即建会话/工作区（避免列表出现空对话 + 磁盘空目录）。
   *  activeConversationId=null 即草稿态；ChatInterface 空态渲染，用户"发消息"那刻才真正 createConversation。
   *  draftProjectId 记住这次草稿属于哪个项目（null=本体聊天，字符串=项目下新建窗口），发送时透传给 createConversation。 */
  const draftProjectId = ref<string | null>(null)
  function startDraft(projectId: string | null = null) {
    draftProjectId.value = projectId
    activeConversationId.value = null
  }

  function getById(id: string): Conversation | undefined {
    return conversations.value.find(c => c.id === id)
  }

  function getActive(): Conversation | null {
    return activeConversationId.value != null
      ? getById(activeConversationId.value) ?? null
      : null
  }

  /** 置顶会话排最前，其余保持原有相对顺序 */
  const sortedConversations = computed(() => {
    const list = [...conversations.value]
    list.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0))
    return list
  })

  /** 本体聊天窗口列表（聊天 tab 数据源） */
  const chatConversations = computed(() =>
    conversations.value.filter(c => !c.project_id),
  )

  /** 最近活动的本体聊天（按 updatedAt 降序）。
   *  0911 反馈12 起启动不再自动打开会话（默认落新建对话界面），此 computed 暂无调用方——保留备用。 */
  const mostRecentChat = computed(() => {
    const list = conversations.value.filter(c => !c.project_id)
    if (!list.length) return null
    return [...list].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0]
  })

  /** 某项目下的聊天窗口（项目树子节点数据源） */
  function conversationsForProject(projectId: string): Conversation[] {
    return conversations.value.filter(c => c.project_id === projectId)
  }

const TRASH_CONV_KEY = 'nis-trash-convs'

/** 0911 反馈8：已全部完成的计划不随刷新恢复——"全 done"视同过期已消费（10s 淡出的终态），
 *  否则刷新后 PlanCard 重新挂载、又显示一遍再淡出（用户实测：完成后刷新还是会显示出来）。
 *  只作用于"加载侧"（列表/历史恢复）；实时帧不过滤，保留完成瞬间的变色收尾 + 10s 淡出动效。 */
function prunedPlan(v: any): Array<{ text: string; done: boolean }> | undefined {
  if (!Array.isArray(v) || v.length === 0) return undefined
  return v.every((x: any) => !!x?.done) ? undefined : v
}

/** 0917 存量数据兜底：老会话没存 projectId，但 workDir 就是项目 root_path → 按目录反查归属。
 *  只在 session.list 回来没有 projectId 时用；查不到返回 null（当普通聊天处理）。 */
function projectIdByWorkDir(workDir?: string): string | null {
  const wd = String(workDir || '').trim().replace(/[\\/]+$/, '').toLowerCase()
  if (!wd) return null
  try {
    const hit = useProjectsStore().projects.find(
      p => String(p.root_path || '').trim().replace(/[\\/]+$/, '').toLowerCase() === wd,
    )
    return hit ? hit.id : null
  } catch {
    return null
  }
}

/** 从桥接服务加载会话列表 */
async function loadConversations(): Promise<void> {
  try {
    const sessions = await bridgeRpc('session.list')
    if (sessions?.sessions) {
      // 滞留处中的会话不回到列表（桥接侧会话延后到彻底删除时再删）
      const trashedIds = new Set(trashedConversations.value.map(t => String(t.conversation.id)))
      /* ★0927：**刷新/重拉列表不许把未读清零**（实测"最近消息回复未查看，列表里没有对应显示"）。
         旧实现每次映射都硬写 unread:0 ⇒ 任何一次 loadConversations（刷新页面/切 tab/重连对账）
         都会把未读角标抹掉；只有"点开该会话"（openConversation/markRead）才该清零。这里按 id 继承上次的值。 */
      const prevUnread = new Map<string, number>()
      for (const c of conversations.value) prevUnread.set(String(c.id), Number((c as any).unread) || 0)
      conversations.value = sessions.sessions.map((s: any) => ({
        id: s.id,
        createdAt: s.createdAt || Date.now(),
        updatedAt: s.updatedAt || s.createdAt || Date.now(),
        title: s.title || '新对话',
        // firstUserMessage：完整首条消息（对话界面标题用它，比列表标题更长）；非空即视为已命名
        firstUserMessage: (s.firstMessage || s.title || '') !== '新对话' ? (s.firstMessage || s.title || '') : '',
        lastMessage: s.lastMessage || '',
        time: s.updatedAt ? new Date(s.updatedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '',
        unread: (() => {
          /* ★0927（①b）：**后端权威优先**（lastReadAt 现场算出来的，跨刷新有效）；
             老后端没这字段时退回"继承上次本地值"（至少不会一刷新就把未读抹掉）。 */
          const bu = (s as any).unread
          if (typeof bu === 'number' && Number.isFinite(bu) && bu >= 0) return bu
          return prevUnread.get(String(s.id)) || 0
        })(),
        // 置顶回填（0909⑦改）：此前恒 false → 刷新即取消置顶。后端 session.list 现带 pinned。
        pinned: !!s.pinned,
        // 0917 修（严重 bug）：此前写死 null —— 后端已持久化 projectId，重启/刷新后项目会话
        // 全被当成「本体聊天」跑进聊天 tab，项目树反而显示"暂无对话"。
        // 存量会话（改动前创建的）没有 projectId → 用 workDir 反查项目 root_path 兜底。
        project_id: s.projectId || s.project_id || projectIdByWorkDir(s.workDir),
        replying: s.status === 'running',
        /* ★0926 链路修复②：把后端"在等用户"落到列表项上。
           以前这里恒为 null（只靠实时帧 setPendingInteraction），所以换窗口/刷新后
           侧栏只剩"回复中"转圈 → 用户看不出"它在等我点卡"。
           'permission'=权限卡、'ask'=询问卡（与既有 Conversation.pendingInteraction 取值一致）。 */
        pendingInteraction: s.awaitingUser === 'permission' ? 'permission' : (s.awaitingUser === 'question' ? 'ask' : null),
        permissionMode: s.permissionMode || undefined,
        // 0920：工作模式（计划/构建）——同样是"刷新后必须回填"的会话级状态。
        // ⚠️ 漏映射会导致「后端还按计划模式注入指令、界面上却显示默认模式」的状态不一致（本轮踩到）。
        mode: s.mode || undefined,
        // 预设回填（0904 bug4 根因一）：此前列表重建丢 presetId → 显示层 fallback 到全局临时选择，
        // 切一个对话的预设所有旧对话跟着变（串台）。后端 session.list 有字段，之前没映射。
        presetId: s.presetId || undefined,
        // 思考强度回填（0908六，与模型回填同思路）：后端 session.list 带 effort → 本地会话记录
        effort: s.effort || undefined,
        teamId: s.teamId || undefined,
        plan: prunedPlan(s.plan),
        boardPlan: prunedPlan(s.boardPlan),
        // 0912 接入批：来源通道回填（侧栏显示平台图标 + 通道弹窗按它过滤）
        origin: s.origin || undefined,
        // 0912 十九批：定时任务支线（侧栏打 ⏰ + 放回定时任务）
        taskId: s.taskId || undefined,
        inMainList: (s.inMainList === true || s.taskInList === true) ? true : undefined,
        movedInAt: Number(s.movedInAt) || 0,   // ★ 0922z2b：列表排序用
        // ★ 0921i：消息条数（侧栏据此把"没有任何消息的空对话"挡在主列表外）
        /* ★0927 三档兼容（血的教训）：原写法只读 `s.messages` —— 后端为省 47MB 去掉 messages 后
           msgCount 恒 0，**刷新后侧栏会把会话全过滤掉**（实测只剩置顶/在回复的 2 条）。
           ① 新后端给 msgCount（最准）；② 老后端给 messages；③ 中间态（两者都没有）→ 用
           firstMessage/lastMessage 是否非空推断"非空对话"（侧栏只关心 0/非 0）。 */
        msgCount: (() => {
          const n = Number((s as any).msgCount)
          if (Number.isFinite(n) && n > 0) return n
          if (Array.isArray(s.messages)) return s.messages.length
          return (s.firstMessage || s.lastMessage) ? 1 : 0
        })(),
      })).filter((c: any) => !trashedIds.has(String(c.id)))
      // 0909⑦：排队消息回填（后端账本权威，刷新/重开窗口队列条不丢）
      try {
        const { useQueueStore } = await import('./queue')
        const qs = useQueueStore()
        for (const s of sessions.sessions) {
          if (Array.isArray(s.queuedMessages)) qs.set(String(s.id), s.queuedMessages)
        }
      } catch { /* 队列 store 未就绪：下次 projection 帧到达即同步 */ }
      // 模型回填（0908三，与 0904 预设回填同思路）：convModel 只在内存，刷新即丢 →
      // 选择器 getter 兜底全局 → 换 A 会话的模型 B 会话跟着变、刷新后个人选择也丢。
      // 后端现已把 model+provider 持久化到会话并随 session.list 带回，这里整表回填。
      // 已有本地覆盖的不覆盖（用户可能改了模型还没发消息，后端值反而是旧的）。
      try {
        const ps = useProvidersStore()
        for (const s of sessions.sessions) {
          if (!s.model || !s.modelProviderId) continue
          if (ps.getConvModel(String(s.id))) continue
          const raw = s.modelBase || ''
          ps.setConvModel(String(s.id), {
            provider: s.modelProviderId,
            model_id: s.model,
            base: raw.includes('://') ? raw : `https://${raw}`,
          })
        }
      } catch (e) {
        console.warn('[Conversations] 会话模型回填失败（本轮跟随全局兜底）:', e)
      }
    }
  } catch (e) {
    console.error('[Conversations] loadConversations failed:', e)
  } finally {
    /* 0914c：无论成败都标记"已尝试加载"——侧栏据此把未就绪态显示为骨架（替代"没有对话"空态闪烁） */
    listLoaded.value = true
  }
}

  /** 会话工作区目录：项目会话=项目 root_path；普通聊天=储存目录下按时间戳建子目录 */
  function resolveWorkDir(projectId: string | null): string {
    if (projectId) {
      const root = useProjectsStore().getProject(projectId)?.root_path
      if (root) return root
    }
    const base = (useSettingsStore().storagePath || '').replace(/[\\/]+$/, '')
    const d = new Date()
    const ts = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}_${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`
    return `${base}/chat_${ts}`
  }

  /** 把（可能变化了的）Agent 预设落地到一个仍为空白的会话：更新桥接会话与本地记录 */
  async function applyPresetToBlank(convId: string, presetId: string): Promise<void> {
    const conv = getById(convId)
    if (!conv || conv.presetId === presetId) return
    // 仅空白会话可换预设（跑过轮次的历史是在原预设下产生的）
    const msgs = messagesByConv.value[convId]
    if (Array.isArray(msgs) && msgs.length > 0) return
    const ap = useAgentPresetsStore()
    const system = ap.composeSystem(presetId, conv.workDir)
    try {
      await bridgeRpc('session.configure', { sessionId: convId, presetId, system })
      conv.presetId = presetId
    } catch (e) {
      console.error('[Conversations] applyPresetToBlank failed:', e)
    }
  }

  /** 新建一个聊天窗口（调用桥接服务）：带工作区 + Agent 预设（人格层+角色层 组装成系统提示词，创建时定型） */
  async function createConversation(projectId: string | null = null, presetId?: string, teamId?: string): Promise<Conversation | null> {
    const workDir = resolveWorkDir(projectId)
    const ap = useAgentPresetsStore()
    const pid = presetId || ap.defaultPresetId
    const system = ap.composeSystem(pid, workDir)
    try {
      const result = await bridgeRpc('session.create', { title: '新对话', workDir, presetId: pid, system, teamId, projectId: projectId || undefined })
      const conv: Conversation = {
        id: result.id ?? result.sessionId,
        createdAt: Date.now(),
        title: result.title || '新对话',
        lastMessage: '',
        time: nowListTime(),
        unread: 0,
        project_id: result.projectId || projectId,
        workDir: result.workDir || workDir,
        presetId: result.presetId || pid,
        teamId: result.teamId || teamId,
      }
      conversations.value.push(conv)
      return conv
    } catch (e) {
      console.error('[Conversations] createConversation failed:', e)
      return null
    }
  }

  /* ★0930 性能（治"切回长会话要等全量加载"）：版本号对账 —— 打开已有节点的会话时先问一次
     session.rev，与上次已应用的 rev 一致 ⇒ 服务端视图没变 ⇒ 跳过全量 session.history +
     前端对账重建（原来是几 MB 传输 + 主线程解析/对账，长会话切回必等）。
     ⚠️ 保守偏置（宁可多拉一次，不许看旧内容）：
       · rev 在全量拉取**之前**取 —— 回包只会比 rev 更新，缓存偏旧的 rev ⇒ 下次照拉，永不漏新；
       · 拉取/对账失败不缓存 rev（下次照拉）；
       · 正在回复（replying）不走捷径（流式期间帧可能缺，必须靠对账补）；
       · 后端 rev 覆盖影响视图的全部状态，任何变化都会变 rev ⇒ 自动回全量路径；
       · 治愈通道永远开着：刷新前端/重启 = rev 缓存为空 = 走全量。
     急停（回归对比用）：控制台 localStorage.setItem('nis-perf-rev','off') 再刷新。 */
  const revApplied = new Map<string, string>()
  /* ★1003 批次4 4.47②：per-session 在途互斥 —— openConversation/reconcileOnFocus/resyncAfterReconnect
   * 可并发触发同一会话（聚焦+重连），原无互斥 ⇒ 双拉历史、交错写 revApplied/compactAppliedAt。 */
  const reconcileInflight = new Map<string, Promise<void>>()
  function perfRevEnabled(): boolean {
    try { return localStorage.getItem('nis-perf-rev') !== 'off' } catch { return true }
  }
  async function fetchRev(id: string): Promise<string> {
    if (!perfRevEnabled()) return ''
    try { return String((await bridgeRpc('session.rev', { sessionId: id }))?.rev || '') } catch { return '' }
  }
  function reconcileIfChanged(pi: any, id: string): Promise<void> {
    const hit = reconcileInflight.get(id)
    if (hit) return hit
    const p = doReconcileIfChanged(pi, id).finally(() => reconcileInflight.delete(id))
    reconcileInflight.set(id, p)
    return p
  }
  async function doReconcileIfChanged(pi: any, id: string): Promise<void> {
    const rev = await fetchRev(id)
    if (rev && revApplied.get(id) === rev && !getById(id)?.replying) return   // 没变：跳过全量拉取+对账
    const h = await bridgeRpc('session.history', { sessionId: id })          // ★0930 拆分批加载：恒全量
    /* ★1010 外部流（P0 契约）：回放播种 —— 回包里的 extTranscript 喂给 externalChat
       （信封兼容 h.extTranscript / h.session.extTranscript 两种，seedFromHistory 内判）；
       刷新回放 = 重放 parts，与 live 同一渲染路径。旧会话无该字段：不标记外部，走 pi transcript 路径。 */
    /* ★1005 诚实性：保留 catch（播种失败不该挡住 pi 对账）但**必须留痕**——
       这条失败的用户可见后果正是"刷新后内容不对"，原来一行日志都没有，只能靠肉眼发现。 */
    try { useExternalChatStore().seedFromHistory(id, h) }
    catch (e) { console.warn('[conversations] 外部流回放播种失败（该会话刷新后可能缺 part 流）：', e) }
    /* ★1003 批次4 4.47①：只有**视图确实对齐**才记 rev —— 原来无条件记账，而
     * reconcileConversationView 有"不整表重建"的路径（streaming 保护/仅增量补缺），
     * 视图没按 rev 对齐却记了账 ⇒ 下次同 rev 直接跳过全量对账，漏掉的内容永远补不回来
     * （违反本函数开头「宁可多拉一次，不许看旧内容」的保守偏置）。 */
    const aligned = await reconcileConversationView(pi, id, h)
    if (rev && aligned) revApplied.set(id, rev)   // 对账失败/未全量对齐不记账（下次照拉）
  }

  /** 用户打开某个对话：记录活跃会话并清零未读 */
  async function openConversation(id: string) {
    activeConversationId.value = id
    /* ★1003 批次4 4.48：未读清零必须**写回后端**（session.markRead → lastReadAt 权威口径）——
     * 原来只 `c.unread = 0` 本地裸清，后端 lastReadAt 不动 ⇒ 刷新/重连后角标又冒出来。 */
    markRead(id)
    // 本地已有 piChat 节点（流式中/已缓存/挂起询问卡）不拉历史覆盖——
    // messagesByConv 是旧机制残留（sendMessage 后不再写入），发过消息的会话它恒为空，
    // 若只查它会导致每次切回会话都重新 loadHistory 覆盖内存节点，丢失挂起的询问卡/权限卡与流式内容
    const local = messagesByConv.value[id]
    if (Array.isArray(local) && local.length > 0) {
      /* ★0927：这条早退原来"光速返回、啥也不做" —— 而 `recoverRunningSessions` 会往
         `messagesByConv` 里写（setMessages），于是这一旦非空，**后面每次打开都早退**，
         增量补缺/缺整轮重建全都不会执行（实测"切回来是旧内容"的一条暗线）。
         现在：同样走一次对账再返回。 */
      try {
        const { usePiChatStore, reconcileLive } = await import('./piChat')
        const pi = usePiChatStore()
        if (pi.getNodes(id).length > 0) {
          await reconcileIfChanged(pi, id)   // ★0930：rev 没变就跳过全量拉取+对账
        }
      } catch (e) { swallowed('切会话增量补缺失败（界面可能停在旧内容，只能靠整页刷新恢复）', e) }
      return
    }
    try {
      const { usePiChatStore, reconcileLive } = await import('./piChat')
      const pi = usePiChatStore()
      if (pi.getNodes(id).length > 0) {
        /* ★0927（实测"切回来是旧内容、刷新后才有最新回复"）：
           本地已有节点**不等于**视图是最新的 —— SSE 丢一帧就会永久停在旧状态（比如停在工具调用处），
           而这条早退让"点侧栏切会话"永远不补账 ⇒ 只有整页刷新（重新走 session.history）才恢复。
           这里改成**增量补缺**：reconcileLive 只补缺（工具块/审批卡/正文缺口），
           不动已有节点、不动挂起卡、不重建列表 —— 所以"切会话"也能自动追平，且不会覆盖正在流式的内容。 */
        try {
          await reconcileIfChanged(pi, id)   // ★0930：rev 没变就跳过全量拉取+对账
        } catch (e) { swallowed('切会话增量补缺失败（界面可能停在旧内容）', e) }
        return
      }
    } catch { /* ignore */ }
    // Load conversation history from bridge（★0930 拆分批加载：恒全量）
    try {
      /* ★ 0922z2d7：这一整段就是"等首屏回包"的窗口 —— 期间界面显示骨架，不显示空态地球；
         try/finally 保证成败都摘掉标记（否则新建空会话会永远停在骨架上）。 */
      const { usePiChatStore: _piOpen, reconcileLive } = await import('./piChat')
      const rev = await fetchRev(id)   // ★0930：先取版本号（保守：取在拉取前，回包只会比它更新）
      let result: any
      /* ★0927：首屏回空就**自动重试**（实测"有时候直接没加载历史消息、只能刷新前端"）。
         会话明明有消息（列表里的 msgCount>0），session.history 却回 0 条（大历史正在落盘/瞬时抖动）——
         旧实现直接放弃，界面就停在空态/骨架，只能手动刷新。0929 起：空回包与 RPC 抛错同路，
         最多重试 2 次（700ms/1400ms 退避），耗尽后给一句可见提示。 */
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          result = await bridgeRpc('session.history', { sessionId: id })
        } catch (e) {
          /* ★0929：RPC 抛错（后端忙/重启窗口/超时）同样按"空回包"走重试 ——
             原实现没有 catch，一抛就跳到外层 catch 放弃，界面停在"只剩流式占位"
             （统计 0 轮 1 段）的空壳上，只有手动刷新才知道发生了什么。 */
          console.warn('[Conversations] session.history 失败，按空回包重试：', e)
          result = undefined
        }
        /* ★1012as：**不要在每轮的 finally 里 markSettled** —— 那会在第一轮空回包时就摘掉骨架标记，
           而重试退避等待（700/1400ms）期间节点仍为空 ⇒ 界面闪出**空态地球**（实测时序：
           骨架 → 空态 → 内容）。改为**整个重试循环结束后**统一标（见循环下方）。 */
        if (Array.isArray(result?.messages) && result.messages.length > 0) break
        const _mc = Number((getById(id) as any)?.msgCount) || 0
        if (attempt < 2 && _mc > 0) { await new Promise((r) => setTimeout(r, 700 * (attempt + 1))); continue }
        /* 重试耗尽仍是空、列表却说有消息：给一条**可见**的一句话提示（别再静默留空壳） */
        if (_mc > 0 && !(Array.isArray(result?.messages) && result.messages.length > 0)) {
          try { _piOpen().handleSessionNotice(id, { text: '历史暂时没加载出来，稍后切回本对话或刷新会自动重试' }) } catch { /* ignore */ }
        }
        break
      }
      /* ★1012ay：**摘"加载中"标记的位置已下移** —— 见下面 `loadHistory` 之后。 */

      /* ★1010 外部流（P0 契约）：首屏回包同样播种 externalChat（信封兼容 result.extTranscript /
         result.session.extTranscript 两种；旧会话无该字段时 seedFromHistory 原样早退，两路并存）。 */
      /* ★1005 诚实性：同上，留痕。这条失败 = 刷新后外部会话渲染不出来。 */
      try { useExternalChatStore().seedFromHistory(id, result) }
      catch (e) { console.warn('[conversations] 首屏外部流播种失败（外部会话刷新后可能渲染为空）：', e) }
      if (Array.isArray(result?.plan) || Array.isArray(result?.boardPlan)) {
        const conv = getById(id)
        if (conv) {
          // 0911 反馈8：与 loadConversations 同口径——全 done 的旧计划不恢复（视同已淡出）
          if (Array.isArray(result.plan)) conv.plan = prunedPlan(result.plan)
          if (Array.isArray(result.boardPlan)) conv.boardPlan = prunedPlan(result.boardPlan)
        }
      }
      if (result?.messages?.length) {
        setMessages(id, result.messages)
        // 同步写入 piChat 节点（PiChatView 渲染；空态判定依赖它）
        const { usePiChatStore, reconcileLive } = await import('./piChat')
        usePiChatStore().loadHistory(id, result.messages, Array.isArray(result.compactions) ? result.compactions : undefined,
          Array.isArray(result.runningTools) ? result.runningTools : undefined, Number(result?.startIndex) || 0)
        // ★0927：记下本视图已应用的压缩边界（对账靠它识别"后台又压了一次"）
        compactAppliedAt.value[String(id)] = maxCompactAt(result.compactions)
        if (rev) revApplied.set(id, rev)   // ★0930：加载成功才记账（失败/空回包下次照拉，不会留旧视图）
      }
      /* ★1012ay：**这里才是摘"加载中"标记的正确位置**（实测三拍现象的根因）。
         上一版把它放在"重试循环刚结束"处，而真正把消息写进渲染节点的是上面的 `loadHistory`
         —— 它前面还隔着 `await import('./piChat')` 与 `seedFromHistory` 等异步间隙，
         两者之间 Vue 必然渲染一帧"节点仍空" ⇒ 界面闪出空态（加载弹窗 → 空态 → 内容）。
         现在紧跟 loadHistory：拿到消息就摘；列表确认是空会话（msgCount===0）也摘；
         列表说有消息却始终取不到（后端忙/大历史落盘）则**保持加载态**，不闪空态。 */
      {
        const _mc3 = Number((getById(id) as any)?.msgCount) || 0
        const _got3 = ((result as any)?.messages?.length || 0) > 0
        if (_got3 || _mc3 === 0) { try { _piOpen().markSettled(id) } catch { /* ignore */ } }
      }
      /* ★0928 刀4a：打开/重建后对账一次 —— 折叠锚点对不上账则按刷新同口径重建窗口 */
      await maybeRebuildOnFoldAnchorMismatch(id)
      // 0908：回合进行中刷新（transcript 要等 agent_end 才落盘，首轮整轮不可见）→ replying 时补 streaming 占位。
      // 放在 messages 判定之外：首轮死区 transcript 为空也要有"回复进行中"（beginAssistant 同款去重，不会双占位）
      if (getById(id)?.replying) {
        const { usePiChatStore, reconcileLive } = await import('./piChat')
        usePiChatStore().resumeStreamingPlaceholder(id)
      }
      // 成员单聊气泡恢复（0904）：团队会话才查（普通会话零额外 RPC）
      if (getById(id)?.teamId) {
        try {
          const mc = await bridgeRpc('session.memberChats', { sessionId: id })
          if (mc?.chats && Object.keys(mc.chats).length > 0) {
            const { usePiChatStore, reconcileLive } = await import('./piChat')
            usePiChatStore().restoreMemberChats(id, mc.chats)
          }
        } catch (e) { console.warn('[conversations] 成员单聊记录恢复失败（成员气泡可能缺失）：', e) }
      }
      // 恢复挂起的审批卡（0908三①：刷新前 AI 正等授权，卡丢失=工具永远 running 用户却无从应答）。
      // attachAside 会把它挂到最后一条 assistant 节点，并把最后一个 running 工具标"等待审批"。
      // ★1010（实测反馈"刷新后分身卡片消失/计时归零/只剩最新的/停止键变发送"）：
      // 重放 run 事件帧内存缓存 → 原样重建分身卡片（segments 全量、计时锚回 run 起点）。
      /* ★1005 修（实测反馈"刷新后已完成的**过程块/内容消失**，只剩最新那条"）：
         原实现是"**先用终态快照建卡片、再回放帧**"，而回放里有句"同 runId 节点已存在就 skip（怕 segments 双记）"
         ⇒ **带完整过程帧的 run 被整段跳过**，卡片只剩快照里那点内容。
         实测同一 run：快照 segments=4 / 实时帧 59 个（28 个正文增量 + 3 次工具）；另一个 run 快照 segments=0
         （只有 35 字占位文案）/ 实时帧 49 个（含 agent_end+agent_stats）—— 全被 skip 掉了 ⇒ 看起来就是"过程块消失"。
         改法：**有帧的 run 一律用帧重建**（帧就是当初把卡片画出来的同一条流；handleSubagentEvent 能重建
         status/segments/timing/usage），**快照只用来补"没有帧的 run"**（例如缓存已过期或后端重启过的）。
         另加一道：帧流若被截断（没走到终帧）⇒ 用快照的终态兜住，绝不留下僵尸 running 卡片。 */
      try {
        const bbv2 = await bridgeRpc('blackboard.read', { sessionId: id })
        const { usePiChatStore } = await import('./piChat')
        const pc = usePiChatStore()
        // P0.5：黑板快照补建（真黑板 + #clone 分身黑板）——已完结分身卡片刷新可恢复，
        // 按 runId 去重（restoreBlackboardRuns 自带 known 集）。
        const snapRuns = [...(Array.isArray(bbv2?.blackboard?.runs) ? bbv2.blackboard.runs : []), ...(Array.isArray(bbv2?.cloneRuns) ? bbv2.cloneRuns : [])]
        const act = Array.isArray(bbv2?.activeRuns) ? bbv2.activeRuns : []
        const framedIds = new Set(act.map(a => String(a?.runId || '')).filter(Boolean))
        const snapOnly = snapRuns.filter(r => !framedIds.has(String(r?.runId || '')))
        if (snapOnly.length > 0) {
          try { pc.restoreBlackboardRuns(id, snapOnly) }
          catch (e) { console.warn('[conversations] 黑板快照补建失败（已完结的分身卡片可能不恢复）：', e) }
        }
        if (act.length > 0) {
          /* ★1005 诚实性：帧重放失败要留痕，但一帧一条会刷屏 ⇒ 每个会话只报一次 */
          let frameErrLogged = false
          for (const r of act) {
            for (const f of (r.frames || [])) {
              try { pc.handleSubagentEvent(id, f as any) }
              catch (e) { if (!frameErrLogged) { frameErrLogged = true; console.warn('[conversations] 分身运行帧重放失败（该分身卡片可能不完整）runId=' + r.runId + '：', e) } }
            }
            const nodes = pc.getNodes(id).filter(n => n.subAgent?.runId === r.runId)
            for (const n of nodes) n.time = Number(r.t) || n.time
            /* 帧流被截断时用快照终态兜住（只在节点还停在 running 时兜，帧里的终帧优先） */
            const snap = snapRuns.find(s => String(s?.runId || '') === String(r?.runId || ''))
            const st = String(snap?.status || '')
            if (st && st !== 'running') {
              for (const n of nodes) {
                if (!n.subAgent || n.subAgent.status !== 'running') continue
                n.subAgent.status = st === 'error' ? 'error' : (st === 'interrupted' || st === 'timeout' ? 'interrupted' : 'done')
                n.subAgent.finished = true
              }
            }
          }
        }
      } catch (e) { console.warn('[conversations] 分身运行帧/黑板缓存恢复失败（刷新后分身卡片可能不显示）：', e) }
      if (Array.isArray(result?.pendingApprovals) && result.pendingApprovals.length > 0) {
        const { usePiChatStore, reconcileLive } = await import('./piChat')
        for (const a of result.pendingApprovals) {
          usePiChatStore().attachAside(id, {
            type: 'permission_prompt',
            request_id: a.requestId,
            question: a.question,
            tool: a.tool,
            risk: a.risk || 'medium',
            options: Array.isArray(a.options) ? a.options : ['允许一次', '当前会话允许', '拒绝'],
          })
        }
        setPendingInteraction(id, 'permission')
      }
      // 恢复挂起的询问卡（刷新前 AI 正在等回答的场景，否则工具永远挂起用户却看不到卡）
      if (Array.isArray(result?.pendingQuestions) && result.pendingQuestions.length > 0) {
        const { usePiChatStore, reconcileLive } = await import('./piChat')
        for (const q of result.pendingQuestions) {
          usePiChatStore().attachAside(id, {
            type: 'ask_user',
            request_id: q.requestId,
            question: q.question,
            questions: Array.isArray(q.questions) && q.questions.length > 0 ? q.questions : undefined,
            options: q.options,
            placeholder: q.placeholder,
          })
        }
      }
    } catch (e) {
      console.error('[Conversations] load history failed:', e)
    }
  }

  function closeConversation() {
    activeConversationId.value = null
  }

  /** 手动重命名（调用桥接服务） */
  async function renameConversation(id: string, title: string) {
    const c = getById(id)
    if (!c) return
    c.customTitle = title
    c.title = title
    try {
      await bridgeRpc('session.rename', { sessionId: id, title })
    } catch (e) {
      console.error('[Conversations] renameConversation failed:', e)
    }
  }

  /** 置顶 / 取消置顶（0909⑦改：同步后端 session.setPinned 持久化，刷新不再丢） */
  function togglePin(id: string) {
    const c = getById(id)
    if (!c) return
    c.pinned = !c.pinned
    bridgeRpc('session.setPinned', { sessionId: id, pinned: c.pinned }).catch((e) => {
      console.error('[Conversations] setPinned failed:', e)
    })
  }

  /** 删除会话（调用桥接服务） */
  async function deleteConversation(id: string) {
    /* ★1003 批次4 4.49：先后端后本地 + 失败回滚 —— 原来先删本地再 await 后端（deleteWorkdir:true
     * 不可逆），RPC 一失败 = 界面没了、后端会话与工作区还在，状态永久分叉且用户无感知。
     * 现在：后端删成功才动本地；失败整组放回（行还在 = 如实可见的反馈）+ 留日志。 */
    const idx = conversations.value.findIndex(c => c.id === id)
    const backup = idx >= 0 ? conversations.value[idx] : null
    const msgBackup = messagesByConv.value[id]
    const wasActive = activeConversationId.value === id
    conversations.value = conversations.value.filter(c => c.id !== id)
    delete messagesByConv.value[id]
    if (wasActive) activeConversationId.value = null
    usePreviewTabsStore().closeAll(id)
    try {
      await bridgeRpc('session.delete', { sessionId: id, deleteWorkdir: true })
    } catch (e) {
      console.error('[Conversations] deleteConversation 失败（已回滚本地状态，会话仍在）:', e)
      if (backup) {
        conversations.value.splice(Math.min(idx, conversations.value.length), 0, backup)
        if (msgBackup !== undefined) messagesByConv.value[id] = msgBackup
        if (wasActive) activeConversationId.value = id
      }
    }
  }

  /** 删除某项目下所有窗口（删除项目时调用） */
  function deleteConversationsByProject(projectId: string) {
    const ids = conversations.value.filter(c => c.project_id === projectId).map(c => c.id)
    conversations.value = conversations.value.filter(c => c.project_id !== projectId)
    ids.forEach(id => {
      delete messagesByConv.value[id]
      usePreviewTabsStore().closeAll(id)
    })
    if (ids.includes(activeConversationId.value)) activeConversationId.value = null
  }

  /* ── 滞留处：对话删除进滞留处（可恢复），到期彻底清除（含桥接会话）── */

  const trashedConversations = ref<TrashedConversation[]>([])

  /** 保留期跟随项目滞留处设置（7/15/30 天） */
  function retentionDays(): number {
    try {
      return useProjectsStore().trashRetentionDays
    } catch {
      return 7
    }
  }

  function persistConversationTrash() {
    try {
      localStore.setItem(TRASH_CONV_KEY, JSON.stringify({ trash: trashedConversations.value }))
    } catch (e) {
      /* ignore */
    }
  }

  function loadConversationTrash() {
    try {
      const raw = localStore.getItem(TRASH_CONV_KEY)
      if (raw) {
        const parsed = JSON.parse(raw)
        trashedConversations.value = parsed.trash || []
      }
    } catch (e) {
      /* ignore */
    }
    purgeExpiredConversations()
  }

  /**
   * 0912 十九批：定时任务支线「放进 / 放回」主对话列表。
   * 放回（inList=false）不是删除 —— 会话照旧存在，任务卡片和独享对话里都能打开，
   * 只是不在主列表里碍眼；要真删只能删对应的定时任务。
   */
  async function setTaskSessionInList(id: string, inList: boolean): Promise<boolean> {
    try {
      const chatStore = (await import('./chat')).useChatStore()
      const r = await chatStore.bridgeRpc('task.sessionInList', { sessionId: id, inList })
      const c = getById(id)
      if (c) c.inMainList = r?.inList === true
      conversations.value = conversations.value.map(x => ({ ...x }))
      await loadConversations()
      return true
    } catch (e: any) {
      return false
    }
  }

  /**
   * 0912 十九批：把「已移到主对话列表」的通道会话**移回该通道的独享列表**。
   * 与 setTaskSessionInList 相对（那条是任务支线专用）；这条保留 origin（平台图标不丢）。
   */
  async function moveBackToChannel(id: string, channel: string): Promise<boolean> {
    if (!channel) return false
    try {
      const chatStore = (await import('./chat')).useChatStore()
      await chatStore.bridgeRpc('channel.moveSession', { sessionId: id, target: channel })
      await loadConversations()
      return true
    } catch (e: any) {
      return false
    }
  }

  /** 对话移入滞留处：从列表移除、暂存滞留处；桥接会话延后到彻底删除时再删 */
  function moveConversationToTrash(id: string) {
    const c = getById(id)
    if (!c) return
    conversations.value = conversations.value.filter(x => x.id !== id)
    delete messagesByConv.value[id]
    if (activeConversationId.value === id) activeConversationId.value = null
    usePreviewTabsStore().closeAll(id)
    trashedConversations.value = trashedConversations.value.filter(t => t.conversation.id !== id)
    trashedConversations.value.push({
      conversation: { ...c, pinned: false },
      deleted_at: Date.now(),
      keep_days: retentionDays(),
    })
    persistConversationTrash()
  }

  /** 从滞留处恢复对话（回到列表，桥接会话仍在） */
  function restoreConversation(id: string): Conversation | null {
    const idx = trashedConversations.value.findIndex(t => t.conversation.id === id)
    if (idx === -1) return null
    const trashed = trashedConversations.value[idx]
    trashedConversations.value.splice(idx, 1)
    conversations.value.push(trashed.conversation)
    persistConversationTrash()
    return trashed.conversation
  }

  /** 彻底删除滞留对话（同时删桥接会话+工作区——孤儿工作区治理：工作区生命周期跟随会话） */
  async function purgeConversation(id: string) {
    const idx = trashedConversations.value.findIndex(t => t.conversation.id === id)
    if (idx === -1) return
    trashedConversations.value.splice(idx, 1)
    persistConversationTrash()
    usePreviewTabsStore().closeAll(id)
    try {
      await bridgeRpc('session.delete', { sessionId: id, deleteWorkdir: true })
    } catch (e) {
      console.error('[Conversations] purgeConversation failed:', e)
    }
  }

  /** 某项目下全部对话移入滞留处（删除项目进滞留处时调用） */
  function moveConversationsByProjectToTrash(projectId: string) {
    conversations.value
      .filter(c => c.project_id === projectId)
      .forEach(c => moveConversationToTrash(c.id))
  }

  /** 彻底删除某项目下的滞留对话（彻底删除项目时调用） */
  function purgeConversationsByProject(projectId: string) {
    trashedConversations.value
      .filter(t => t.conversation.project_id === projectId)
      .forEach(t => { purgeConversation(t.conversation.id) })
  }

  /** 清理已到期滞留对话（彻底删除含桥接会话） */
  function purgeExpiredConversations() {
    /* ★1003 批次4 4.50：**删除成功才移除滞留记录** —— 原来先把记录滤掉并持久化、再
     * fire-and-forget 删后端（.catch 全吞）：删除一失败 = 会话+工作区成永久孤儿（无重试无留痕）。
     * 现在失败保留下次 purge 再试；异步化但对调用方仍 fire-and-forget。 */
    void (async () => {
      const now = Date.now()
      const before = trashedConversations.value.length
      const kept: typeof trashedConversations.value = []
      for (const t of trashedConversations.value) {
        const expiredAt = t.deleted_at + t.keep_days * 24 * 60 * 60 * 1000
        if (now < expiredAt) { kept.push(t); continue }
        try {
          usePreviewTabsStore().closeAll(t.conversation.id)
          await bridgeRpc('session.delete', { sessionId: t.conversation.id, deleteWorkdir: true })
        } catch (e) {
          console.error('[Conversations] 滞留会话彻底清除失败（保留待下次重试）:', t.conversation.id, e)
          kept.push(t)
        }
      }
      trashedConversations.value = kept
      if (kept.length !== before) persistConversationTrash()
    })()
  }

  /** #13 项目 id 重映射：前端本地项目 id → 后端确认回包 id（会话/窗口随之绑到后端项目，
   * 否则 WORKSPACE_LIST/流程模式/伙伴派发拿不到真实项目根）。 */
  function remapProjectId(oldProjectId: string, newProjectId: string) {
    for (const c of conversations.value) {
      if (c.project_id === oldProjectId) c.project_id = newProjectId
    }
    const active = getActive()
    if (active && active.project_id === oldProjectId) active.project_id = newProjectId
  }

  function nowListTime(): string {
    const d = new Date()
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }

  /** 自动标题：仅在未手动重命名且尚未记录首条消息时，先用首条消息截短作临时标题（#3 提炼结果到后会替换） */
  function ensureAutoTitle(id: string, firstUserMessage: string) {
    const c = getById(id)
    if (!c || c.customTitle) return
    if (!c.firstUserMessage) {
      c.firstUserMessage = firstUserMessage
      c.title = firstUserMessage.length > 12 ? firstUserMessage.slice(0, 12) + '…' : firstUserMessage
    }
  }

  /** 设置对话标题（提炼结果替换临时标题；customTitle 不变） */
  function applyTitle(id: string, title: string) {
    const c = getById(id)
    if (!c || !title || c.customTitle) return
    c.title = title
  }

  /** 更新列表预览的最后一条消息与时间 */
  function setLastMessage(id: string, text: string, time: string) {
    const c = getById(id)
    if (!c) return
    c.lastMessage = text
    // ★ 0922 修：消息落地即算"非空对话"（Sidebar 的 msgCount 过滤据此放行；
    // 此前新会话没有 msgCount 字段 → 被当成空对话挡掉，要刷新才出现）
    c.msgCount = Math.max(Number(c.msgCount) || 0, 1)
    c.time = time
    // 活动时间戳：对话列表按 updatedAt 排序（刚聊过的沉到顶部，置顶除外）
    c.updatedAt = Date.now()
  }

  /** 标记某对话已读（清零未读 + **写回后端**）：
   *  ★0927（已定案 ①b）：未读的权威口径落在后端 `lastReadAt`（随会话持久化）——
   *  否则刷新页面/重开窗口时未读会被重新算出来（或整片丢失）。 */
  function markRead(id: string) {
    const c = getById(id)
    if (c) c.unread = 0
    void bridgeRpc('session.markRead', { sessionId: String(id) }).catch((e) => swallowed('已读回写后端失败（本地已清零、后端未生效：刷新后未读角标会复活）', e))
  }

  /**
   * 0917b：SSE 断线重连后向服务端「补账」。
   *
   * 症状：网页端偶尔卡在「回复中」不回、刷新一下又显示回复完了。
   * 根因：终态帧（后端 agent_end 广播的 `session/status running=false`）只在事件流上
   *   实时下发、不落库也不重放；SSE 一旦静默断掉（半死 TCP / 后端重启 / 中间层丢包），
   *   前端重连只重新订阅，不会拿到断线期间那一刻的终态 → 流式节点永远定不了稿。
   *   手动刷新之所以能恢复，是因为刷新走的是 `session.history`（落库的完整记录）。
   *
   * 这里在重连后做一次权威对齐：
   *   ① 记录"本地以为还在跑"的会话（replying 或存在 streaming 节点）
   *   ② 拉一次 session.list 拿服务端真实运行态
   *   ③ 服务端已停的那些：定稿流式节点 + 用 session.history 覆盖回完整历史（此刻无在跑回合，覆盖安全）
   *   ④ 运行态以服务端为准回填，避免列表一直转圈
   */
  async function resyncAfterReconnect(): Promise<void> {
    const localRunning = new Set(conversations.value.filter(c => c.replying).map(c => String(c.id)))
    let streamingIds: string[] = []
    try {
      const { usePiChatStore, reconcileLive } = await import('./piChat')
      const pi = usePiChatStore()
      streamingIds = Object.keys(pi.nodes).filter(id => pi.getNodes(id).some(n => n.status === 'streaming'))
    } catch { /* piChat 未就绪：仅按 replying 对齐 */ }
    const targets = new Set([...localRunning, ...streamingIds])
    if (!targets.size) return

    let list: any[] = []
    try {
      const r = await bridgeRpc('session.list')
      list = Array.isArray(r?.sessions) ? r.sessions : []
    } catch { return }
    const runningSet = new Set(list.filter((s: any) => s?.status === 'running').map((s: any) => String(s.id)))

    const { usePiChatStore, reconcileLive } = await import('./piChat')
    const pi = usePiChatStore()
    for (const id of targets) {
      if (runningSet.has(id)) {
      /* ★ 0925ae（实测"工具过程块/权限卡实时丢、刷新才显示"）：服务端还在跑**也要补账** ——
         旧逻辑"绝不覆盖"让断线窗口丢的 toolcall/permission 帧永久缺。改为**增量补缺**：
         只补本地缺的工具块/结果/审批卡，不动流式中的节点。 */
      try {
        const result = await bridgeRpc('session.history', { sessionId: id })
        reconcileLive(id, result)
      } catch (e) { swallowed('聚焦时增量补缺失败（界面可能缺最新内容）', e) }
      continue
    }
      /* ★1005（关键修）：这里的 finalizeStreaming 原来**不带参数** ⇒ finalizeClones 默认 true，
         会把**还在跑的游离分身**直接标成 done —— 我的"有在跑的分身就跳过整表重建"护栏排在它后面，
         检查时已经查不到 running 的分身 ⇒ 护栏形同虚设、loadHistory 照跑（真机埋点实测）。
         改成 finalizeClones:false：游离分身（即派即回）不该被这里定稿 —— 它们还活着。 */
      pi.finalizeStreaming(id, { finalizeClones: false })
      /* ★1005（实测反馈"点空白处/窗口重新聚焦后，**正在跑的分身气泡消失**、直到它跑完才回来"）：
         这条"本轮已结束 → 按服务端整表重建"的路径**原来没有任何护栏**，而 reconcileOnFocus()
         第一件事就是调本函数 ⇒ 只要该会话还有**在跑的分身**（它的内容还没进历史），一聚焦就被
         loadHistory 抹掉。与其它重建路径同口径：**有在跑的分身也绝不整表重建**（跑完自然落进历史）。 */
      if (pi.getNodes(id).some((n: any) => n.subAgent && n.subAgent.status === 'running')) {
        console.warn('[reconcile] 该会话还有在跑的分身，跳过整表重建（保分身实时气泡）:', id.slice(0, 8))
        continue
      }
      try {
        const result = await bridgeRpc('session.history', { sessionId: id })
        if (!result?.messages?.length) continue
        setMessages(id, result.messages)
        pi.loadHistory(id, result.messages,
          Array.isArray(result.compactions) ? result.compactions : undefined,
          Array.isArray(result.runningTools) ? result.runningTools : undefined,
          Number(result?.startIndex) || 0)
            // 断线期间本轮已完成：非当前会话补一次未读（当前会话用户正看着，不补）
        const c = getById(id)
        if (c && activeConversationId.value !== id) {
          c.unread += 1
          c.replying = false
        }
      } catch (e) { swallowed('重连补账失败（该会话可能停在旧内容）', e) }
    }
    // 运行态以服务端为准回填（未在 targets 里的会话也一并纠正，避免列表转圈不停）
    for (const c of conversations.value) {
      const rid = String(c.id)
      if (runningSet.has(rid)) c.replying = true
      else if (targets.has(rid) || c.replying) c.replying = false
    }
  }

  /** ★0927：**增量补缺 or 缺整轮时重建**（实测"点系统通知回来还是旧内容、刷新后才有"）。
   *  为什么需要：`reconcileLive` 的正文回填护栏是「**同一段话的延续**」（服务端文本必须以本地为前缀且更长）。
   *  当本地**缺了整整一轮**（最后那轮的 assistant 气泡整个不在、只到工具行）时，服务端末条消息与本地
   *  最后一个节点根本不是同一段话 ⇒ 护栏判"非前缀，保守不覆盖" ⇒ 什么都不做 —— 那正是
   *  "停在工具调用处、刷新后才有正文"的根因（刷新走的是整表重建，所以刷新一定好）。
   *  现在：服务端末条消息比本地最后一个节点还新 ⇒ 判定"缺整轮" ⇒ 直接 `loadHistory` 重建
   *  （= 刷新做的事），重建后再 `reconcileLive` 一次把挂起的审批/询问卡补回去。
   *  安全边界：**有 streaming 节点时绝不重建**（会掀掉实时流），只做增量补缺。 */
  async function reconcileConversationView(pi: any, id: string, h: any): Promise<boolean> {
    if (!Array.isArray(h?.messages) || !h.messages.length) return false   // ★1003 4.47：空回包不算对齐
    /* reconcileLive 是 piChat 的**模块级导出函数**（不是 store 方法）——曾误写成 pi.reconcileLive 导致
       "is not a function" 被 try/catch 吞掉、整套对账静默失效（用户控制台抓到）。这里显式取函数引用。 */
    const { reconcileLive } = await import('./piChat')
    /* ★0927（实测"后台会话被压缩，切回来旧消息还在、压缩卡也不出现"）：压缩是**合法变短**，
       下面的"服务端不新就跳过重建"闸门会把它判成"本地更新"而永不重建。
       按"后端压缩边界 at 比本视图已应用的更新"放行：更新了就走强制重建
       （reloadConversationAfterCompaction 自带 streaming 保护与失败留痕）。 */
    const _srvMaxAt = maxCompactAt(h.compactions)
    if (_srvMaxAt > (compactAppliedAt.value[String(id)] ?? 0)) {
      await reloadConversationAfterCompaction(id)
      return true   // ★4.47：整表重建路径 = 视图已对齐
    }
    const nodes = pi.getNodes(id)
    const streaming = nodes.some((n: any) => n.status === 'streaming' || n.subAgent?.status === 'running')
    if (!streaming) {
      const srvLast = [...h.messages].reverse().find((m: any) => m?.role !== 'user')
      const srvTs = Number(srvLast?.timestamp) || 0
      const localLast = [...nodes].reverse().find((n: any) => n.kind === 'assistant')
      const localTs = Number(localLast?.time) || 0
      /* ★0927 补第二个判据：**文本发散**（不只是"缺整轮"）。
         增量补缺的正文护栏要求"服务端文本以本地文本为前缀"；一旦本地是**半截**文本（丢帧攒到的），
         两者就不是前缀关系 ⇒ 增量那条路会"保守不覆盖"、什么都不做 ⇒ 还是旧内容（用户图一）。
         ⚠️ 必须要求**服务端更长**：落盘有 500ms 去抖延迟，刚结束的轮次盘上可能还没写下 ⇒
         若不加这个条件，会用**旧盘内容**把更新的本地视图整表重建掉 ⇒ 回复/Think 整段消失
         （实测①："有时候 think、回复的内容会消失"，刷新后又回来）。 */
      const srvText = String((Array.isArray(srvLast?.content) ? srvLast!.content : [])
        .filter((c: any) => c?.type === 'text').map((c: any) => String(c.text || '')).join('')).trim()
      const localText = String((localLast as any)?.text || '').trim()
      const diverged = srvText.length > localText.length && !srvText.startsWith(localText)
      if (srvTs > localTs + 1000 || diverged) {
        pi.loadHistory(id, h.messages, Array.isArray(h.compactions) ? h.compactions : undefined, Array.isArray(h.runningTools) ? h.runningTools : undefined, Number(h.startIndex) || 0)
        reconcileLive(id, h)   // 重建后补一次：挂起的审批/询问卡 + 工具结果
        await maybeRebuildOnFoldAnchorMismatch(id)
        compactAppliedAt.value[String(id)] = maxCompactAt(h.compactions)
        return true   // ★4.47：loadHistory 整表重建 = 视图已对齐
      }
    }
    reconcileLive(id, h)
    /* ★0928 刀4a：窗口漂移检测 —— 发送/删轮后窗口前移，旧节点按旧 startIndex（折叠边界/压缩卡
       靠它换算绝对下标）构建；同参数对账发现 startIndex 已变 => 偏移重算错位风险 =>
       按刷新同口径重建窗口（重算 indexBase，不沿用旧值）。仅压缩会话触发（折叠有风险才有必要），
       rebuildWindowFromServerSameAsRefresh 自带 streaming 保护与冷却，幂等。 */
    await maybeRebuildOnFoldAnchorMismatch(id)
    /* ★1003 4.47：增量补缺路径的对齐判定 —— 非 streaming 且无发散（走不进上面重建分支）说明
     * 本地已与服务端一致，可记账；streaming 期间帧可能缺，**不记账**（下次照拉，保守偏置）。 */
    return !streaming
  }

  /** ★0927：**切回窗口/标签时对齐一次**（实测"切回来显示的是旧内容、要刷新才回来"）。
   *  为什么需要：实时视图靠 SSE 帧增量拼，丢一帧就停在旧状态；而前端的"切回会话"逻辑
   *  **本地有节点就不再去拉历史** ⇒ 旧内容会一直留着，只有整页刷新（重新走 session.history）才恢复。
   *  做法：① 先走既有 resyncAfterReconnect（补"在跑但漏了终态帧"的会话）；
   *        ② 再对**当前打开的会话**做一次增量补缺（pi.reconcileLive：只补缺、不动已有节点，安全）。
   *  节流 2s，避免频繁切窗打 RPC。 */
  let _lastFocusReconcile = 0
  async function reconcileOnFocus(force = false): Promise<void> {
    const now = Date.now()
    if (!force && now - _lastFocusReconcile < 2000) return
    _lastFocusReconcile = now
    try { await resyncAfterReconnect() } catch (e) { swallowed('重连后全量对账失败（界面可能与后端不一致）', e) }
    const id = String(activeConversationId.value || '')
    if (!id) return
    try {
      const { usePiChatStore, reconcileLive } = await import('./piChat')
      const pi = usePiChatStore()
      const nodes = pi.getNodes(id)
      if (!nodes.length) return                              // 还没加载过 → 交给正常打开流程
      /* ⚠️ 带 limitTurns（同首屏口径）：补缺只需要最近尾巴，别每次切窗口都拉全量历史（大会话数 MB） */
      const h = await bridgeRpc('session.history', { sessionId: id })
      await reconcileConversationView(pi, id, h)
      console.warn(`[reconcile] 切窗口/聚焦对账完成：${id.slice(0, 8)}（节点 ${nodes.length}）`)
      /* ★0927：切回来 = 用户正在看这条 ⇒ 若它还挂着未读（后端推送覆盖过的），一并标已读，
         否则会出现"明明读过了，切回来还挂着未读角标"（实测）。 */
      const conv = getById(id)
      if (conv && Number(conv.unread) > 0) { conv.unread = 0; markRead(id) }
    } catch (e) { console.warn('[reconcile] 聚焦对账失败:', String((e as any)?.message || e)) }
  }

  /** ★0927：**无条件按服务端重建某会话视图**（点系统通知回来专用）。
   *  为什么单独一条：`reconcileConversationView` 的"缺整轮"判定靠时间戳比较，万一漏判（节点 time 口径/
   *  时钟偏差/同一轮内多次落库）就还是旧内容 —— 而"用户点了通知要回这条对话"是**明确意图**，
   *  这时正确性 > 保留内存时间线：直接 `loadHistory`（=刷新的做法）+ `reconcileLive` 补挂卡片。
   *  安全边界：有 streaming 节点时不重建（那说明这一轮还在跑，实时流优先）。 */
  async function rebuildConversationFromServer(sessionId: string): Promise<void> {
    const id = String(sessionId || '')
    if (!id) return
    try {
      const { usePiChatStore, reconcileLive } = await import('./piChat')
      const pi = usePiChatStore()
      const nodes = pi.getNodes(id)
      if (nodes.some((n: any) => n.status === 'streaming' || n.subAgent?.status === 'running')) {
        console.warn('[reconcile] 该会话正在流式，跳过重建（保实时流）:', id.slice(0, 8))
        return
      }
      const h = await bridgeRpc('session.history', { sessionId: id })
      if (!Array.isArray(h?.messages) || !h.messages.length) return
      /* ★0927：压缩=合法变短，闸门会误判 ⇒ 与 reconcileConversationView 同款放行 */
      if (maxCompactAt(h.compactions) > (compactAppliedAt.value[String(id)] ?? 0)) {
        await reloadConversationAfterCompaction(id)
        return
      }
      /* ★0927 防"抹掉更新内容"：服务端还没本地新时**绝不整表重建**（只做增量补缺）。
         判据：服务端末条 ts ≤ 本地末节点 ts 且服务端末条文本不长于本地 ⇒ 本地更新 ⇒ 不重建。
         （没有这道闸门，刚结束的轮次/丢帧攒到的半截文本会被旧快照整表覆盖 = 实测①） */
      const srvLast = [...h.messages].reverse().find((m: any) => m?.role !== 'user')
      const srvTs = Number(srvLast?.timestamp) || 0
      const localLast = [...nodes].reverse().find((n: any) => n.kind === 'assistant')
      const localTs = Number(localLast?.time) || 0
      const srvText = String((Array.isArray(srvLast?.content) ? srvLast!.content : [])
        .filter((c: any) => c?.type === 'text').map((c: any) => String(c.text || '')).join('')).trim()
      const localText = String((localLast as any)?.text || '').trim()
      const serverNewer = srvTs > localTs + 1000 || srvText.length > localText.length
      if (!serverNewer) {
        reconcileLive(id, h)   // 本地不旧 ⇒ 只增量补缺（它自己只会"变多"，安全）
        console.warn(`[reconcile] 服务端不新于本地，跳过整表重建（保本地内容）：${id.slice(0, 8)}`)
        return
      }
      pi.loadHistory(id, h.messages, Array.isArray(h.compactions) ? h.compactions : undefined, Array.isArray(h.runningTools) ? h.runningTools : undefined, Number(h.startIndex) || 0)
      reconcileLive(id, h)
      console.warn(`[reconcile] 已按服务端重建会话 ${id.slice(0, 8)}（节点 ${nodes.length} → ${pi.getNodes(id).length}）`)
    } catch (e) { console.warn('[reconcile] 重建失败:', String((e as any)?.message || e)) }
  }

  /** ★0927（实测"压缩后界面还挂着压缩前的旧正文"）：压缩成功 → **强制重建**该会话视图。
   *  为什么单独一个函数（不能复用 rebuildConversationFromServer）：
   *  那个函数有"服务端不新于本地就跳过"的闸门（防旧快照覆盖新内容）—— 而压缩是**合法变短**
   *  （折叠掉的消息本该从界面消失），srvText < localText 会让闸门判"本地更新"⇒ 永远不重建。
   *  这里只保留唯一安全边界：**有 streaming 节点就跳过**（那轮还在跑，实时流优先），
   *  并记一个待办，等这轮跑完由 agent_end 的收尾逻辑补一次（见 piChat 的 turnEnd 钩子）。 */
  /** ★0927：后端 compactions 里的最大折叠边界 at（没有压缩 = 0） */
  function maxCompactAt(list: any): number {
    return (Array.isArray(list) ? list : []).reduce((m: number, c: any) => Math.max(m, Number(c?.at) || 0), 0)
  }
  /** ★0927：每个会话"当前视图已应用到的压缩边界"——对账时后端边界比它新 ⇒ 合法变短，必须重建 */
  const compactAppliedAt = ref<Record<string, number>>({})
  const pendingCompactionReload = ref<Record<string, boolean>>({})
  async function reloadConversationAfterCompaction(id: string): Promise<void> {
    const sid = String(id || '')
    if (!sid) return
    try {
      const { usePiChatStore, reconcileLive } = await import('./piChat')
      const pi = usePiChatStore()
      const nodes = pi.getNodes(sid)
      if (nodes.some((n: any) => n.status === 'streaming' || n.subAgent?.status === 'running')) {
        pendingCompactionReload.value[sid] = true     // 等这轮跑完再补
        console.warn('[compact] 该会话正在流式，压缩重建延后到本轮结束:', sid.slice(0, 8))
        return
      }
      const h = await bridgeRpc('session.history', { sessionId: sid })
      if (!Array.isArray(h?.messages)) return
      pi.loadHistory(sid, h.messages, Array.isArray(h.compactions) ? h.compactions : undefined, Array.isArray(h.runningTools) ? h.runningTools : undefined, Number(h?.startIndex) || 0)
      reconcileLive(sid, h)
      compactAppliedAt.value[sid] = maxCompactAt(h.compactions)
      pendingCompactionReload.value[sid] = false
      console.warn(`[compact] 已按压缩结果重建会话 ${sid.slice(0, 8)}（节点 ${nodes.length} → ${pi.getNodes(sid).length}）`)
    } catch (e) { console.warn('[compact] 重建失败:', String((e as any)?.message || e)) }
  }
  /** 流式收尾时调用：把延后的压缩重建补上（有待办才动） */
  async function flushPendingCompactionReload(id: string): Promise<void> {
    if (!pendingCompactionReload.value[String(id || '')]) return
    await reloadConversationAfterCompaction(id)
  }

  /* ── ★0928 刀4a（发送路径投影与刷新同源）──────────────────────────────
   * 「发送后按刷新同口径重建窗口」：折叠锚点对不上账 / 窗口漂移（发送、删轮后窗口前移，
   * 旧节点是按旧 startIndex 构建的，折叠边界与压缩卡都靠它换算绝对下标）时的退化路径 ——
   * 调用与刷新（F5/首屏）完全相同的数据源与函数重算 indexBase（session.history 回包的
   * 新鲜 startIndex），绝不沿用旧值。幂等：streaming 保护 + 120s 冷却防循环。 */
  const _lastFoldRebuildAt = ref<Record<string, number>>({})
  async function rebuildWindowFromServerSameAsRefresh(id: string): Promise<void> {
    const sid = String(id || '')
    if (!sid) return
    const now = Date.now()
    if (now - (_lastFoldRebuildAt.value[sid] || 0) < 120000) return
    _lastFoldRebuildAt.value[sid] = now
    try {
      const { usePiChatStore, reconcileLive } = await import('./piChat')
      const pi = usePiChatStore()
      if (pi.getNodes(sid).some((n: any) => n.status === 'streaming' || n.subAgent?.status === 'running')) return   // 实时流优先，本轮跑完再对账
      const h = await bridgeRpc('session.history', { sessionId: sid })
      if (!Array.isArray(h?.messages) || !h.messages.length) return
      setMessages(sid, h.messages)
      pi.loadHistory(sid, h.messages, Array.isArray(h.compactions) ? h.compactions : undefined,
        Array.isArray(h.runningTools) ? h.runningTools : undefined, Number(h?.startIndex) || 0)
      compactAppliedAt.value[sid] = maxCompactAt(h.compactions)
      reconcileLive(sid, h)
      console.warn(`[fold-anchor] 按刷新同口径重建窗口：${sid.slice(0, 8)}`)
    } catch (e) { console.warn('[fold-anchor] 重建失败:', String((e as any)?.message || e)) }
  }
  /** ★0928 刀4a：buildHistoryNodes 报「折叠锚点对不上账」-> 退化为刷新同口径重建（一次性消费标记） */
  async function maybeRebuildOnFoldAnchorMismatch(id: string): Promise<void> {
    try {
      const { usePiChatStore } = await import('./piChat')
      if (!usePiChatStore().takeFoldAnchorMismatch(String(id))) return
      await rebuildWindowFromServerSameAsRefresh(String(id))
    } catch (e) { swallowed('折叠锚点不匹配后的窗口重建失败（该会话显示可能与刷新后不一致）', e) }
  }

  /** 设置某对话是否正在回复（列表缓冲动画用） */
  function setReplying(id: string, replying: boolean) {
    const c = getById(id)
    if (c) c.replying = replying
  }

  /** 设置某对话是否在等待用户交互（权限卡/询问卡），列表显示"等待权限/等待回复" */
  function setPendingInteraction(id: string, kind: 'permission' | 'ask' | null) {
    const c = getById(id)
    if (c) c.pendingInteraction = kind
  }

  /**
   * AI 回复完成的统一入口（本地模拟回复与真实 WS 回复都调这里）。
   * 若该对话不是当前打开的对话，未读数 +1。
   */
  function onAiReplyCompleted(id: string, lastMessage: string, time: string) {
    const c = getById(id)
    if (!c) return
    c.lastMessage = lastMessage
    c.time = time
    if (activeConversationId.value !== id) {
      c.unread += 1
    }
  }

  loadConversationTrash()

  return {
    conversations,
    messagesByConv,
    getMessages,
    setMessages,
    sortedConversations,
    chatConversations,
    mostRecentChat,
    conversationsForProject,
    loadConversations,
    resyncAfterReconnect,
    createConversation,
    applyPresetToBlank,
    activeConversationId,
    draftProjectId,
    startDraft,
    getById,
    listLoaded,
    getActive,
    openConversation,
    closeConversation,
    renameConversation,
    togglePin,
    deleteConversation,
    deleteConversationsByProject,
    trashedConversations,
    moveConversationToTrash,
    setTaskSessionInList,
    moveBackToChannel,
    restoreConversation,
    purgeConversation,
    moveConversationsByProjectToTrash,
    purgeConversationsByProject,
    purgeExpiredConversations,
    remapProjectId,
    ensureAutoTitle,
    applyTitle,
    setLastMessage,
    markRead,
    setReplying,
    setPendingInteraction,
    onAiReplyCompleted,
    reconcileOnFocus,
    rebuildConversationFromServer,
    rebuildWindowFromServerSameAsRefresh,
    reloadConversationAfterCompaction,
    flushPendingCompactionReload,
  }
})
