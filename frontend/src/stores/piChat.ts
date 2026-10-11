import { defineStore } from 'pinia'
import { ref } from 'vue'
import { t } from '@/utils/i18n'
import { BRIDGE_URL } from '@/utils/bridgeUrl'
import { stripModeHint } from '@/utils/modeHint'

/** 子 agent 运行（team_dispatch 派发的成员实例）：渲染为独立头像+名字+气泡（默认折叠，3 行滚动预览） */
interface SubRunTool {
  name: string
  status: 'running' | 'done' | 'error'
  result?: string
}
/** 按时间穿插的过程段（思考/正文/工具真实顺序；实时流与持久化 runs 共用） */
type SubSegment =
  | { type: 'thinking'; text: string }
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string; status: 'running' | 'done' | 'error'; result?: string }
  /** 0911 反馈3：LLM 流式报错/重连注释（成员气泡过程块可见"报错与重连过程"） */
  | { type: 'error'; text: string }

export interface PiNode {
  key: string
  /** image=工具"发给用户"的内嵌图片（wb_send_screenshot 等，details.dataUrl 投影为正文图片块，非工具卡） */
  kind: 'user' | 'assistant' | 'tool' | 'retry' | 'notice' | 'image'
  text: string
  reasoning: string
  /** streaming(助理流式中) / done(定稿) / error(发送失败的用户气泡)。
   *  ★1003 批次4 4.52：类型缺口补齐 —— 'error' 原不在联合里（pushFailedUserMessage 靠 as any 硬写），
   *  reasoningMs/reasoningDone 原未声明却在使用（vue-tsc/IDE 必报 excess-property/未定义），
   *  运行时只是靠 esbuild 不查类型才活着。声明真实形状，别再在使用处断言糊弄。 */
  status: 'streaming' | 'done' | 'error'
  /** ★4.52：已记录的思考耗时（ms）——刷新/回看历史时 ReasoningBlock 计时显示用 */
  reasoningMs?: number
  /** ★4.52：思考阶段是否定稿（false=思考进行中，Think 行陪跑动画的判据） */
  reasoningDone?: boolean
  time?: number
  /** [T4b] monotonic sequence anchor: every node entering the list takes an increasing seq;
   *  timestamps are display-only and never participate in ordering. */
  seq?: number
  /** 工具节点：LLM 消息 content 块索引（toolcall_start/end 关联） */
  contentIndex?: number
  /** 0910：工具节点所属的 assistant 消息代次（contentIndex 只在单条消息内有意义，跨消息会重复） */
  msgSeq?: number
  callId?: string
  toolName?: string
  toolArgs?: any
  toolResult?: string
  toolError?: boolean
  toolStatus?: 'running' | 'done' | 'error'
  /** 0906 五批：toolcall 参数流式到过的字符数（fs_write 诚实等待行的"已生成"进度；网关缓冲不下跳） */
  toolStreamChars?: number
  /** 等待用户审批（hitl-request 挂起期间）：工具行显示"等待审批"而非"运行中" */
  awaitingApproval?: boolean
  /** 模型名（assistant 节点：透传消息的 model 字段，供气泡头部展示） */
  model?: string
  /** fs_write 成功写入的字节数（产出物卡片显示大小；历史回填时从结果文本解析） */
  fileSize?: number
  diffStat?: { added: number; removed: number }
  /** 0920：run_command 本次实际走的 Shell（cmd / powershell / pwsh / sh）——命令过程行右侧小标识。
   *  来自后端 details.shell；存量历史消息没有这个字段（老记录不带），仅新执行的命令有。 */
  toolShell?: string
  /** 权限/问询卡等特殊交互块（HITL/QUESTION 注入） */
  asides?: any[]
  /** 本轮 turn 的耗时（AI 回复组头部悬停展示：用时/首 token/tok/s；每轮独立，历史不串） */
  turnTiming?: { llmMs?: number; ttftMs?: number }
  /** 本轮 turn 的用量（tok/s 计算用；0910 扩缓存三字段=悬停统计显示本轮命中率，口径同 StatsLine） */
  turnUsage?: { completionTokens?: number; promptTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number }
  /** 流式去重：上一次 text/thinking delta（模型末段重复推送相同增量时跳过） */
  lastTextDelta?: string
  lastReasoningDelta?: string
  /** 图片附件 dataUrl 列表（用户消息：发送时随消息附加，气泡内渲染缩略图） */
  images?: string[]
  /** 0910：单聊气泡标记（@成员 发起的用户消息）。它与成员回复成对存在，**不在**主会话 transcript 里
   *  （单聊记录由 memberChats 单独持久化）——删除轮次的 turnIndex 计数必须跳过它，否则与后端错位 */
  dm?: boolean
  /** 技能标签（用户消息：SkillPicker 选中的技能，气泡渲染 [技能:xxx] 标签） */
  skills?: string[]
  /** 0909⑦ 插话乐观气泡：steer 已发出待注入（steer-ack/回显后清除，注入前视觉带"插话中"标记） */
  steerPending?: boolean
  /** 0909⑨：乐观气泡身份标记——注入回显 message_start 可远晚于发送（等当前工具批次跑完，实测 17s+），
   *  普通 5s 去重窗罩不住 → 曾出现"光圈气泡+回显新气泡"双份。回显按文本匹配此标记去重并清除。 */
  steerOptimistic?: boolean
  /** 重试过程块（kind:'retry'）：phase=过程态(重试中)/完成态(recovered 已恢复 / failed 彻底失败) */
  retryPhase?: 'retry' | 'recovered' | 'failed'
  retryAttempt?: number
  retryMax?: number
  retryReason?: string
  /** 0910 反馈10：本次退避等待毫秒（后端阶梯 5/10/30/60/120s），过程块显示"等 N 秒" */
  retryDelayMs?: number
  /** 内联通知（kind:'notice'）：上下文压缩分隔线，phase=compacting（转圈）/compacted（"—— 上下文已压缩 ——"）
   *  0908七：info=系统收尾提示（工具轮次上限等，noticeText 自定义文案，ContextDivider 同组件渲染） */
  noticeText?: string
  noticePhase?: 'compacting' | 'compacted' | 'info' | 'steer'
  /** 子 agent 消息节点：团队派发的成员实例（独立头像+名字+气泡渲染，完全对齐主 agent 组） */
  subAgent?: {
    runId: string
    stepId: string
    memberId: string
    memberName: string
    /** 0913 头像批：成员预设 id —— 气泡头像按它取预设头像（未设置回退"渐变+首字"） */
    memberPreset?: string
    model?: string
    /** 0910 反馈5：成员独立模型配置了却解析失败（不在任何可用供应商里）→ 实际跑的是会话模型，
     *  气泡标注"已回退"，不再静默 */
    modelFallback?: boolean
    modelConfigured?: string
    /** 0910 反馈4：成员自己用 sub_plan 列的执行清单（实时事件 + run 快照都可带） */
    plan?: Array<{ text: string; done: boolean }>
    /** 0911 反馈5：同成员多实例编号（按消息流出现顺序，>1 时标题显示「名字 #N」） */
    instanceNo?: number
    tools: SubRunTool[]
    /** interrupted = 被中断（后端重启/看门狗）；后端权威记录里带原因文案 */
    status: 'running' | 'done' | 'error' | 'interrupted'
    /** 事件丢失兜底：宿主 dispatch 工具结束后置 done */
    finished?: boolean
    /** 按时间穿插的过程段（思考/正文/工具真实顺序；实时流与持久化 runs 共用） */
    segments?: SubSegment[]
    /** 0910 反馈6：由黑板 runs 兜底重建（transcript 里没留下 team_dispatch 记录时的恢复路径） */
    fromBlackboard?: boolean
  }
}

export const usePiChatStore = defineStore('piChat', () => {
  const nodes = ref<Record<string, PiNode[]>>({})
  /** aside 版本号（attach/answer 时递增）：pendingCard 等 computed 依赖它，解决对象内部修改不触发重算 */
  const asideVersion = ref(0)
  /** 把本轮 turn 的耗时/用量挂到「最后一个 user 节点之后」最近的 assistant 节点（每轮独立，历史消息数值不串）
   *  注意跳过子 agent 节点（也是 kind:'assistant'）——否则团队模式 timing 会挂到成员消息上，主 agent 气泡只剩时间 */
  function attachTurnMeta(convId: string, timing?: { llmMs?: number; ttftMs?: number }, usage?: { completionTokens?: number; promptTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number }) {
    const list = getNodes(convId)
    let lastUserIdx = -1
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].kind === 'user') { lastUserIdx = i; break }
    }
    for (let i = list.length - 1; i > lastUserIdx; i--) {
      if (list[i].kind === 'assistant' && !list[i].subAgent) {
        list[i].turnTiming = timing
        list[i].turnUsage = usage
        return
      }
    }
  }

  /* [T4b] unified ordering anchor (knife 4b): monotonic seq for every node in the list.
     Old roots of mis-ordering: main tool cards pushed by arrival, clone bubbles inserted by
     run.t timestamp (restoreBlackboardRuns), rebuilt tool nodes carried no time (0), assistant
     timestamp = turn-end > clone start => clone bubble jumped above tool cards (user report).
     New rule: seq = arrival order (== list order), timestamps are display-only. */
  let seqCounter = 0
  function nextSeq(): number { return ++seqCounter }
  /** assign seq + lazy backfill: nodes without seq are filled by current list order;
   *  keeps the list strictly increasing (idempotent). */
  function normalizeSeqList(list: Array<{ seq?: number }>): void {
    let last = 0
    for (const n of list) {
      const cur = Number((n as any).seq)
      if (!(cur > last)) n.seq = last + 1
      last = n.seq as number
    }
    if (last > seqCounter) seqCounter = last
  }
  /** the single entry for a node entering the list: take / keep an increasing seq */
  function stampSeq(n: PiNode): PiNode {
    if (!(Number(n.seq) > 0)) n.seq = nextSeq()
    return n
  }

  function getNodes(convId: string): PiNode[] {
    if (!nodes.value[convId]) nodes.value[convId] = []
    normalizeSeqList(nodes.value[convId]) /* [T4b] lazy backfill for pre-existing nodes */
    return nodes.value[convId]
  }

  function setNodes(convId: string, list: PiNode[]) {
    normalizeSeqList(list) /* [T4b] whole-list replacement also goes through seq normalization */
    nodes.value[convId] = list
  }

  /* ── ★ 0925f：插话"撤回编辑"（需求的功能）─────────────────────────────
   * 场景：steer 乐观气泡还没被回显回收（消息未真正进对话流）时，用户点编辑按钮撤回 →
   * 从界面移除 + 内容退回归队条。后端 steer 无取消 API（agent.steer 立即注入），
   * 所以撤回后 pi 注入时仍会发 message_start(user) 回显 —— 用 withdrawn 集合把它拦掉
   * （命中即删：一次性，避免误杀用户之后发的同文本消息）。 */
  const withdrawnSteers = new Map<string, Set<string>>()
  const normSteerText = (t: string): string =>
    String(t || '').replace(/^\[技能:[^\]]+\]\s*/, '').replace(/\[\[图片:\d+\]\]/g, '').replace(/\[\[文件:[^\]]+\]\]/g, '').replace(/\s+/g, ' ').trim()
  function isWithdrawnSteer(convId: string, text: string): boolean {
    const set = withdrawnSteers.get(convId)
    if (!set) return false
    const key = normSteerText(text)
    if (!key || !set.has(key)) return false
    set.delete(key) // 一次性：拦掉这次回显即失效
    if (!set.size) withdrawnSteers.delete(convId)
    return true
  }
  /** 撤回一条 steer 乐观气泡：移除节点 + 登记 withdrawn（拦后续回显）。返回被撤节点供调用方回灌/重排 */
  function withdrawSteerNode(convId: string, key: string): PiNode | null {
    const list = getNodes(convId)
    const idx = list.findIndex(n => n.key === key && (n.steerOptimistic || n.steerPending))
    if (idx < 0) return null
    const [node] = list.splice(idx, 1)
    const set = withdrawnSteers.get(convId) || new Set<string>()
    set.add(normSteerText(node.text))
    withdrawnSteers.set(convId, set)
    return node
  }

  /**
   * 从 pi 格式 transcript 批量加载历史节点（session.history 回包）
   * 按顺序：user → assistant(含 toolCall 块) → toolResult(更新 tool 节点)
   */
  /** 后端注入的「模型可见 user 消息」前缀 —— 只渲染成 notice 分隔，绝不当用户气泡。
   *  ①【自动续跑…（软段 / token 收尾）②【后台任务通知】（后台任务完成/失败时后端 steer 给 AI 的插话，0922 补）。
   *  ⚠️ 历史回放（loadHistory）与实时（handleAgentEvent）两条链路都要判 —— 0909④ 的教训：只改一条，
   *     刷新回放就又冒出假提问气泡。 */
  const INJECTED_USER_PREFIXES = ['【自动续跑', '【后台任务通知', '【后台任务回访', '【分身回归']  /* ★1004：分身回归同口径（改这里记得同步后端 server.ts） */
  const isInjectedUserText = (text: string) => !!text && INJECTED_USER_PREFIXES.some((p) => stripModeHint(String(text)).startsWith(p))
  /* ★1004 修假完成（实测反馈"分身卡片显示完成、实际还在跑"）：spawn_clone 是**即派即回**（detached），
     主回合结束时分身批次还在后台跑 —— finalizeStreaming 的"一刀切定稿"把它们全标成了 done（旧同步
     team_dispatch 语义残留）。判别口径：分身 run 的 stepId 恒以 'clone-' 开头（cloneRuntime 构造，
     run 快照/回放同款），只按 run 自己的 agent_end/agent_stats/error 置终态（handleSubagentEvent）。
     ★1004b 防僵尸：配套「恢复去重终态优先 + 实时帧认领未完结优先 + 击杀路径终态帧」三保险，
     否则拆掉一刀切兜底会让收不到终态帧的卡片永卡 running（CPU 满事故根因，勿单独回退这组）。 */
  const isDetachedClone = (sa?: { stepId?: string } | null) => !!sa && String(sa.stepId || '').startsWith('clone-')
  /* ★0930（需求）：长任务「软段续跑」的注入提示（【自动续跑 第 N/M 段】…）不再上时间线 ——
     纯机制噪音，运行日志里已有"自动续跑进入第 N 段"；只给模型看，不渲染成内联通知。
     后台任务完成/收尾（【自动续跑 · …】）仍显示（带任务信息）。两条链路（实时+刷新回放）同口径。 */
  const isSegmentContinue = (text: string) => /^【自动续跑\s*第/.test(String(text || ''))
  /* ★1005（已定案）：【分身回归】摘要**只给模型看**，不渲染成内联通知 ——
     分身卡片自带产出摘要、主 agent 紧接着就汇报，中间这条完全多余（用户原话"完全多余"）。
     与【自动续跑 第 N 段】同口径：实时 + 刷新回放两条链路都不上时间线。 */
  const isCloneReturnNotice = (text: string) => /^【分身回归】/.test(stripModeHint(String(text || '')))
  /* ★0928 刀4a：折叠锚点对不上账的会话标记（buildHistoryNodes 内置位，一次性消费）。
     conversations 据此走「发送后按刷新同口径重建窗口」——用刷新同口径的数据源重算 indexBase，
     而不是沿用旧偏移值。 */
  const foldAnchorMismatch = ref<Record<string, boolean>>({})
  function takeFoldAnchorMismatch(convId: string): boolean {
    const key = String(convId || '')
    const v = !!foldAnchorMismatch.value[key]
    if (v) foldAnchorMismatch.value[key] = false
    return v
  }

  /** ★ 0922z：把一段历史消息构建成节点数组（纯构建，不写 store）。
   *  indexBase = 这段消息在**完整 transcript** 里的起始下标（分批加载时非 0），
   *  压缩历史卡的定位靠它（compactions[].at 是绝对下标）。 */
  function buildHistoryNodes(convId: string, messages: any[], compactions?: Array<{ at: number; folded: number; summary: string }>, runningToolIds?: string[], indexBase = 0, forPrepend = false) {
    const list: PiNode[] = []
    const toolById = new Map<string, PiNode>()
    // 压缩历史卡：按折叠边界索引插入常驻 notice 节点（每次压缩一张，时间线；不展开，仅标注保留比例）
    const compactAt = new Map<number, Array<{ at: number; folded: number; summary: string }>>()
    for (const c of (compactions || [])) {
      const arr = compactAt.get(c.at) || []
      arr.push(c); compactAt.set(c.at, arr)
    }
    /* ★0927（实测"压缩后旧消息还在"）：**边界之前的原始消息不再渲染** —— 它们已折进摘要
       （原文见 compactArchiveRel 存档可回读）。原来只插一张卡、旧消息照显：
       lazyHistory 关掉或短会话（首屏窗口罩住边界）时"压了等于没压"。
       （★0930 拆分批加载：prependHistory/补更早已拆，本函数只走全量重放。） */
    const _lastCompactAt = (compactions || []).reduce((m: number, c: any) => Math.max(m, Number(c?.at) || 0), 0)
    /* ★0928 刀4a（根治"一发消息就变形/正文蒸发"）：折叠判定从「indexBase 算术」升级为「双重确认」。
       病根：分批加载靠 indexBase 偏移换算绝对位置，发送/增量重建时窗口前移 + 偏移一旦错位
       （compactions[].at 与 startIndex 还可能分属不同坐标系：后端二次压缩时 at 记的是"摘要视图"内下标），
       单靠索引算术就会把未折叠正文当折叠跳过（正文蒸发）、把压缩卡插进半轮中间（变形）——
       F5 全量重建路径健康，正因为它用的是同一次回包的新鲜 startIndex。
       双重确认（缺一不可，拿不准宁可多显示）：
         (1) 索引算术：mi + indexBase < _lastCompactAt；
         (2) 锚点对账：边界须落在本窗口内，且边界处消息是 user 轮起点（与后端切割口径一致：
             server 侧 _turnStarts 只取 role===user）。对不上账（边界在窗口外 / 落在半轮中间）
             一律不跳过，并置 foldAnchorMismatch -> conversations 走"发送后按刷新同口径重建窗口"。
       取更早批（forPrepend，上滑回读）不折叠：0927 既定口径"上滑取更早...仍可回读"，宁可多显示。 */
    let _foldEnd = 0
    if (!forPrepend && _lastCompactAt > 0 && indexBase > 0) {
      const _rel = _lastCompactAt - indexBase
      if (_rel > 0 && _rel < messages.length) {
        const _bm: any = messages[_rel]
        if (_bm && _bm.role === 'user') _foldEnd = _rel
        else foldAnchorMismatch.value[String(convId)] = true
      }
    }
    /* ★0928 刀4a：压缩卡插入同款对账 —— 锚点（c.at 落点）确认是 user 轮起点才插在原位；
       对不上账的卡改插到本窗口顶部（绝不插进半轮中间）；取更早批不插顶部（防重复堆叠）。 */
    for (const c of (compactions || [])) {
      const _rel = Number(c?.at) - indexBase
      const _ok = _rel >= 0 && _rel < messages.length && (messages[_rel] as any)?.role === 'user'
      if (!_ok && !forPrepend) {
        list.push({ key: crypto.randomUUID(), kind: 'notice', text: t('notice.compactFolded', { folded: c.folded, pct: 35 }), reasoning: '', status: 'done', noticePhase: 'compacted', noticeText: c.summary || undefined /* ★0928 顶部兜底 */ })
      }
    }
    for (let mi = 0; mi < messages.length; mi++) {
      const msg = messages[mi]
      /* ★0928 刀4a 折叠跳过 = 双重确认（(1) 索引算术 + (2) 锚点对账 _foldEnd，缺一不可）；单条件裸跳过已废除 */
      /* ★1003 修复 4.51：t5 变更把折叠跳过整个删了 —— _foldEnd 沦为只写不读的死代码，
         压缩边界前的原始消息全部照渲，0927「压缩后旧消息还在/压了等于没压」复活。
         按刀4a 双重确认口径恢复跳过：只有 _foldEnd 经锚点对账确认，才跳过边界之前的原文。 */
      if (!forPrepend && _foldEnd > 0 && mi < _foldEnd) continue
      for (const c of (compactAt.get(mi + indexBase) || [])) {
        /* ★0928 刀4a：锚点对账 —— 只有落点确认为 user 轮起点的压缩卡才插在原位（其余走顶部兜底） */
        const _crel = Number((c as any).at) - indexBase
        if (!(_crel >= 0 && _crel < messages.length && (messages[_crel] as any)?.role === 'user')) continue
        list.push({ key: crypto.randomUUID(), kind: 'notice', text: t('notice.compactFolded', { folded: c.folded, pct: 35 }), reasoning: '', status: 'done', noticePhase: 'compacted', noticeText: c.summary || undefined /* ★0927：摘要可展开读（原文在存档） */ })
      }
      if (msg.role === 'user') {
        const text = extractText(msg.content)
        // 0909④/0910：自动续跑注入指令是"模型可见的 user 消息"（transcript 保留原文），
        // 刷新回放时必须与实时链路同款渲染成 notice 分隔——旧版直接当用户气泡，刷新后
        // 时间线多出假提问（也顺带让删除轮次的序号数与实时一致）。
        if (isInjectedUserText(text)) {
          /* ★0930：软段续跑提示不上时间线（仅日志），见 isSegmentContinue */
          const clean = stripModeHint(text)  /* ★1004：显示净化（旧数据可能带 [记忆召回] 等行） */
          if (isSegmentContinue(clean) || isCloneReturnNotice(clean)) continue
          list.push({ key: crypto.randomUUID(), kind: 'notice', text: clean.slice(0, 60), reasoning: '', status: 'done', time: msg.timestamp, noticePhase: 'info', noticeText: clean.startsWith('【自动续跑·收尾】') ? t('notice.budgetGrace') : clean /* ★ 0923：给全文，UI 侧默认折叠成一行、点开才看（原来截 160 字，展开也是残的） */ })
          continue
        }
        const images = extractImages(msg.content)
        // 历史消息的图片没有位置标记 → 追加到文本末尾（气泡用内联标记渲染）
        const textWithMarkers = images.length ? ((/\[\[图片:\d+\]\]/.test(text) ? text : text + ' ' + images.map((_, i) => `[[图片:${i}]]`).join(' '))) : text
        list.push({ key: crypto.randomUUID(), kind: 'user', text: textWithMarkers, reasoning: '', status: 'done', time: msg.timestamp, images })
      } else if (msg.role === 'assistant') {
        // 0909⑨：历史消息内多 text 段近重复去重（旧数据落盘时后端还没这层过滤，如"小确幸"故事重说两遍）
        // ★0929e：先做思考回显剥离（mimo-v2.6-pro 时代存量消息 text 块以思考开头成对重复）
        const textParts = textPartsWithEchoStripped(msg.content)
        const kept: string[] = []
        for (let i = 0; i < textParts.length; i++) {
          const cur = textParts[i]
          if (!cur.trim()) continue
          if (textParts.slice(i + 1).some(later => later.trim() && isNearDuplicate(cur, later))) continue
          kept.push(cur)
        }
        const text = kept.join('\n\n')
        const reasoning = extractReasoning(msg.content)
        // turn 元数据直读：后端 agent_end 写时补全（turnMetas 按 ts 挂 _turnMeta），读侧零推断
        const meta = msg._turnMeta || undefined
        const turnTiming = meta?.timing
        const turnUsage = meta?.usage ? { completionTokens: meta.usage.completionTokens ?? 0, promptTokens: meta.usage.promptTokens ?? 0, cacheReadTokens: meta.usage.cacheReadTokens ?? 0, cacheWriteTokens: meta.usage.cacheWriteTokens ?? 0 } : undefined
        // 纯工具调用轮（无文本无思考）不渲染空气泡（dsh assistant-step chrome-free）
        if (text || reasoning) {
          list.push({ key: crypto.randomUUID(), kind: 'assistant', text, reasoning, status: 'done', reasoningMs: loadThinkMs(convId, msg.timestamp), time: msg.timestamp, model: msg.model, turnTiming, turnUsage })
        }
        // toolCall 块（pi 格式）→ 工具节点
        for (const c of Array.isArray(msg.content) ? msg.content : []) {
          if ((c.type === 'toolCall' || c.type === 'tool_use') && c.id) {
            const toolNode: PiNode = {
              key: crypto.randomUUID(), kind: 'tool', text: '', reasoning: '',
              /* [T4b] rebuilt tool node no longer has no time (0): time = its message time (display),
                 seq = its position inside the turn (taken here, in build order). */
              status: 'done', time: msg.timestamp, callId: c.id, toolName: c.name,
              toolArgs: c.arguments ?? c.input, toolStatus: 'done',
            }
            stampSeq(toolNode)
            toolById.set(c.id, toolNode)
            list.push(toolNode)
          }
        }
        /* ★ 0925j（实测"本轮对话的日志消失了很多"）：磁盘消息的 tool_result 是**内嵌在
         * assistant 消息 content 里的**（{type:'tool_result', toolUseId, content, isError}，DSH 形态，
         * content 还是字符串化 JSON）——读侧兼容层在"旧数据清理"时被删 ⇒ 343 个工具结果全部被忽略、
         * 工具行只剩调用没有输出。补回兼容：内嵌 tool_result 回填到同消息内已建的 tool 节点。 */
        for (const c of Array.isArray(msg.content) ? msg.content : []) {
          if (c?.type === 'tool_result' && (c.toolUseId || c.toolCallId)) {
            const tn = toolById.get(c.toolUseId || c.toolCallId)
            if (!tn) continue
            let rc: any = c.content
            if (typeof rc === 'string') {
              try { rc = JSON.parse(rc) } catch { /* 纯文本结果直接用 */ }
            }
            tn.toolResult = typeof rc === 'string' ? rc
              : extractText(Array.isArray(rc?.content) ? rc.content : (Array.isArray(rc) ? rc : [{ type: 'text', text: String(rc ?? '') }]))
            tn.toolError = !!c.isError
            tn.toolStatus = c.isError ? 'error' : 'done'
            if (tn.toolName === 'run_command') {
              const sh = (c as any).details?.shell
              if (typeof sh === 'string' && sh) tn.toolShell = sh
            }
            const m2 = /已写入\s*(\d+)\s*字节/.exec(tn.toolResult)
            if (m2) tn.fileSize = Number(m2[1])
            // ★ 0929：+N/-M 行数（工具行显示；details 优先，旧数据从结果文本补算）
            const d2 = (c as any).details
            if (typeof d2?.added === 'number' || typeof d2?.removed === 'number') tn.diffStat = { added: d2.added || 0, removed: d2.removed || 0 }
            else { const m3 = /（\+(\d+)\/-(\d+) 行）/.exec(tn.toolResult); if (m3) tn.diffStat = { added: Number(m3[1]), removed: Number(m3[2]) } }
          }
        }
      } else if (msg.role === 'toolResult' && msg.toolCallId) {
        // pi 持久化格式统一 toolCallId（旧 toolUseId 兼容层已随旧数据清理删除——读侧零推断）
        const existing = toolById.get(msg.toolCallId)
        if (existing) {
          existing.toolResult = extractText(Array.isArray(msg.content) ? msg.content : [])
          existing.toolError = !!msg.isError
          existing.toolStatus = msg.isError ? 'error' : 'done'
          // 0920：历史恢复命令过程行的终端标识（与实时路径同源；老数据没有该字段就不显示）
          if (existing.toolName === 'run_command') {
            const sh = (msg as any).details?.shell
            if (typeof sh === 'string' && sh) existing.toolShell = sh
          }
          const m = /已写入\s*(\d+)\s*字节/.exec(existing.toolResult)
          if (m) existing.fileSize = Number(m[1])
          // ★ 0929：+N/-M 行数（与实时路径同源）
          const dm = (msg as any).details
          if (typeof dm?.added === 'number' || typeof dm?.removed === 'number') existing.diffStat = { added: dm.added || 0, removed: dm.removed || 0 }
          else { const m3 = /（\+(\d+)\/-(\d+) 行）/.exec(existing.toolResult); if (m3) existing.diffStat = { added: Number(m3[1]), removed: Number(m3[2]) } }
          // 0908 截图内嵌对话流：历史恢复——toolResult.details（shotRef 工作区引用 / 兼容旧内联 dataUrl）
          // 紧随工具节点插 image 节点，刷新后正文图片不丢（list 即本轮重建数组，顺序=时间线）
          const shotSrc = resolveShotSrc((msg as any).details, convId)
          if (shotSrc && !msg.isError) {
            list.splice(list.indexOf(existing) + 1, 0, {
              key: crypto.randomUUID(), kind: 'image', text: '', reasoning: '',
              status: 'done', time: msg.timestamp, images: [shotSrc],
            })
          }
          // 团队持久化：team_dispatch 的成员 run 快照 → 恢复为 subAgent 消息节点（折叠可回看）
          if (['team_dispatch', 'spawn_clone'].includes(String(msg.toolName)) && Array.isArray(msg.subRuns)) {
            /* ★1004（CPU 满根因，实测反馈"那轮修改后 CPU 吃满"）：同一 runId 常有多条快照
             * （运行中快照 + 终态快照各登记过；重派/合并链路也会复制）——逐条建节点会恢复出
             * **僵尸「运行中」分身卡片**：实时终态帧按 runId 只认最后一个节点（findLast），
             * 先 push 的僵尸永远 running → 500ms 走秒 + subPulse 无限动画持续重绘，
             * dwm/夸克/远程抓屏全员陪烧。按 runId 去重、**终态优先**（done/error > interrupted/
             * timeout > running，同级取 endedAt 较新者）；批次真在跑时只剩 running 快照 = 保持
             * running 是对的（实时帧随后收尾）。 */
            const runRank = (r: any) => (!r ? -1 : r.status === 'running' ? 0
              : (r.status === 'interrupted' || r.status === 'timeout') ? 2
              : 3)   // done/error/其余终态
            const runById = new Map<string, any>()
            for (const run of msg.subRuns) {
              const k = String(run?.runId || '') || `${run?.stepId || ''}|${run?.memberId || ''}|${run?.t || 0}`
              const prev = runById.get(k)
              const rk = runRank(run), rp = runRank(prev)
              if (!prev || rk > rp || (rk === rp && Number(run?.endedAt || 0) >= Number(prev?.endedAt || 0))) runById.set(k, run)
            }
            for (const run of runById.values()) {
              list.push({
                key: crypto.randomUUID(), kind: 'assistant',
                text: String(run.text || ''), reasoning: String(run.reasoning || ''),
                status: 'done', time: run.t || msg.timestamp,
                turnTiming: run.timing, turnUsage: run.usage,
                subAgent: {
                  runId: run.runId, stepId: run.stepId, memberId: run.memberId,
                  memberName: run.memberName, memberPreset: run.memberPreset, model: run.model,
                  modelFallback: !!run.modelFallback, modelConfigured: run.modelConfigured,
                  plan: Array.isArray(run.plan) ? run.plan : undefined,
                  tools: (Array.isArray(run.tools) ? run.tools : []).map((t: any) => ({ name: t.name, status: t.status || 'done', result: t.result })),
                  // segments：按消息序的思考/正文/工具穿插记录（刷新后按真实时序回放）
                  segments: Array.isArray(run.segments) ? run.segments : undefined,
                  status: run.status === 'interrupted' || run.status === 'timeout' ? 'interrupted' : (run.status || 'done'),
                  // 0911 反馈5②：恢复即视为已完结——否则刷新后已完成计划卡复现、等 10s 才淡出（与单聊/黑板两条恢复路径同口径）
                  finished: true,
                },
              })
            }
          }
        }
      }
    }
    // 0908三①：回合进行中刷新——后端 runningTools 里的调用（tool_use 已落、tool_result 未落=正在执行/等审批）
    // 恢复为 running 态（loadHistory 历史数据一律标 done，"正在写入"块刷新即丢的根因）。
    // 审批卡由调用方随后 attachAside 挂上（permission_prompt 会把最后 running 节点标待批）。
    if (runningToolIds?.length) {
      const rid = new Set(runningToolIds.map(String))
      for (const n of list) {
        if (n.kind === 'tool' && n.callId && rid.has(String(n.callId))) {
          n.toolStatus = 'running'
          n.status = 'streaming'
        }
      }
    }
    // 0910：同轮跨消息近重复去重（旧数据=模型"工具轮→收尾轮"整段重说，两条 assistant 消息各带一遍
    // 全文；小确幸浏览器实测抓到单 msg 内过滤罩不住这个形态）。丢前者保后者=与后端定稿/实时 message_end 同口径。
    for (let i = 0; i < list.length; i++) {
      const a = list[i]
      if (a.kind !== 'assistant' || a.subAgent || !a.text) continue
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j]
        if (b.kind === 'user') break
        if (b.kind === 'assistant' && !b.subAgent && b.text && isNearDuplicate(a.text, b.text)) {
          a.text = ''
          break
        }
      }
    }
    /* ★ 0925m（实测"会话一直卡在正在整理较早的对话"）：历史里的 compacting 转圈是**过去时**
       （'done' 已随重启/进程中断丢失）——原样重建会永远转圈。一律落成「压缩中断」静态提示。 */
    for (const _cn of list as any[]) {
      if (_cn.kind === 'notice' && _cn.noticePhase === 'compacting') {
        _cn.noticePhase = 'info'
        _cn.text = t('notice.compactingTimeout')
        _cn.noticeText = t('notice.compactingTimeout')
      }
    }
    normalizeSeqList(list) /* [T4b] seq backfill: rebuilt nodes take seq by their list position */
    return list
  }

  /** ★ 0922z2d7（设计口径 b）：某些会话"正在等首屏回包"——true 期间界面不显示空态地球，改显示骨架占位。
   *  由 conversations 的首屏 session.history 用 try/finally 精确开关（成败都摘，不会留下卡住的骨架）。 */
  const settledIds = ref<Record<string, boolean>>({})
  /** 首屏回包结束（无论有没有消息）→ 标 settled；此前一律当"还在加载" → 显示骨架而不是空态地球 */
  function markSettled(convId: string) { settledIds.value[convId] = true }
  function isOpening(convId: string): boolean { return !!convId && settledIds.value[convId] !== true }

  /** 全量/首屏加载：整体替换该会话节点（与旧版 loadHistory 行为一致）。 */
  function loadHistory(convId: string, messages: any[], compactions?: Array<{ at: number; folded: number; summary: string }>, runningToolIds?: string[], indexBase = 0) {
    /* ★0929 重建不丢卡（实测"权限卡实时不弹、刷新后才出现"）：权限卡/询问卡只活在
       内存节点的 asides 上，任何整体重建（刷新/对账/迟到的旧回包覆盖）都会把它连节点一起掀掉。
       做法：重建前收集旧列表里**未应答**的 aside，重建后用 attachAside 挂回
       （attachAside 自带 request_id/requestId 双字段判重，重建数据里已带的卡不会重复挂）。
       已应答的不迁移（历史重建自带回放语义，别把答过的卡复活）。 */
    const carryAsides: any[] = []
    for (const n of (nodes.value[convId] || [])) {
      for (const a of (n.asides || [])) {
        if (a && !a.answered) carryAsides.push(a)
      }
    }
    nodes.value[convId] = buildHistoryNodes(convId, messages, compactions, runningToolIds, 0 /* t5: full-load, ignore indexBase */)
    for (const a of carryAsides) attachAside(convId, a)
  }

  /** 恢复成员单聊气泡（0904）：session.memberChats 回包 → 每个 run 还原成"用户@名字 + 成员 subAgent 气泡"。
   *  按 run.afterTurns（发起时主会话用户轮数）插到对应主时间线位置，保持历史顺序不乱。 */  function restoreMemberChats(convId: string, chats: Record<string, any[]>) {
    const list = getNodes(convId)
    const runs: any[] = []
    if (chats && typeof chats === 'object') {
      for (const arr of Object.values(chats)) if (Array.isArray(arr)) runs.push(...arr)
    }
    if (!runs.length) return
    runs.sort((a, b) => (a.t || 0) - (b.t || 0))
    for (const run of runs) {
      // 0910 二批③：插入点 = 第 want 个**主时间线**用户轮的回复结束处（下一轮 user 之前；最后一轮则末尾）。
      // 旧逻辑插在该 user 消息后一格 → 同一轮的多个单聊依次恢复时后者插到前者前面（顺序颠倒）、
      // 主 agent 回复被一路推到末尾；且恢复出来的 @成员 user 气泡（dm）也被计入轮数，进一步污染定位。
      const want = Math.max(0, Number(run.afterTurns) || 0)
      let insertAt = want === 0 ? 0 : list.length
      if (want > 0) {
        let seen = 0
        for (let i = 0; i < list.length; i++) {
          const n = list[i]
          if (n.kind !== 'user' || (n as any).dm) continue
          seen++
          if (seen === want) {
            insertAt = list.length
            for (let j = i + 1; j < list.length; j++) {
              const m = list[j]
              if (m.kind === 'user' && !(m as any).dm) { insertAt = j; break }
            }
            break
          }
        }
      }
      const pair: PiNode[] = []
      if (run.userText) {
        pair.push({
          key: crypto.randomUUID(), kind: 'user',
          text: `@${run.memberName} ${String(run.userText)}`,
          reasoning: '', status: 'done', time: run.t || Date.now(),
          dm: true,
        })
      }
      pair.push({
        key: crypto.randomUUID(), kind: 'assistant',
        text: String(run.text || ''), reasoning: String(run.reasoning || ''),
        status: 'done', time: (run.t || Date.now()) + 1,
        turnTiming: run.timing, turnUsage: run.usage,
        subAgent: {
          runId: run.runId, stepId: run.stepId || '@dm', memberId: run.memberId,
          memberName: run.memberName, memberPreset: run.memberPreset, model: run.model,
          modelFallback: !!run.modelFallback, modelConfigured: run.modelConfigured,
          plan: Array.isArray(run.plan) ? run.plan : undefined,
          tools: (Array.isArray(run.tools) ? run.tools : []).map((t: any) => ({ name: t.name, status: t.status || 'done', result: t.result })),
          segments: Array.isArray(run.segments) ? run.segments : undefined,
          status: run.status === 'interrupted' || run.status === 'timeout' ? 'interrupted' : (run.status || 'done'), finished: true,
        },
      })
      list.splice(insertAt, 0, ...pair.map((pn) => stampSeq(pn)))
    retractRunTools(list, run) /* [T6a] history-side: pull scattered clone tool nodes into the bubble */
    }
    normalizeSeqList(list) /* [T4b] member-chat bubbles join the same seq stream (arrival order) */
  }

  /** 从黑板 runs 兜底恢复成员气泡（0910 反馈6：重启后子 agent 气泡消失）。
   *  背景：成员 run 快照有两条持久化路径——①transcript 里 team_dispatch 的 toolResult.subRuns
   *  （loadHistory 恢复）②黑板 blackboard/<sessionId>.json 的 runs（teamRuntime 每轮结束落盘）。
   *  派发中途后端重启时 ① 断链（assistant 消息与 toolResult 都没落盘），只剩 ② 有数据但没人读。
   *  这里按 runId 去重后补建 subAgent 气泡（标 fromBlackboard），让"成员的活干过就在"。 */
  function restoreBlackboardRuns(convId: string, runs: any[]) {
    if (!Array.isArray(runs) || !runs.length) return 0
    const list = getNodes(convId)
    const known = new Set(list.filter(n => n.subAgent?.runId).map(n => String(n.subAgent!.runId)))
    let added = 0
    for (const run of runs) {
      const rid = String(run?.runId || '')
      if (!rid || known.has(rid)) continue
      known.add(rid)
      /* [T4b] (knife 4b seq anchor unification) do NOT insert by comparing run.t with node.time:
         the old tm > rt probe hit assistant nodes whose time = turn-end (> clone start) and dropped
         the clone bubble ABOVE the tool cards (user-reported mis-order); rebuilt tool nodes had no
         time at all (0) which made the probe even more wrong.
         New rule: a run belongs to the turn it started in -> insert at that turn block end (right
         before the next real user bubble), matching live arrival order (clone bubbles follow this
         turn tool cards). Timestamps only pick the turn; node ordering is carried by seq. */
      const at = turnEndAnchorIndex(list, Number(run.t) || 0)
      list.splice(at, 0, stampSeq({
        key: crypto.randomUUID(), kind: 'assistant',
        text: String(run.text || ''), reasoning: String(run.reasoning || ''),
        status: 'done', time: run.t || Date.now(),
        turnTiming: run.timing, turnUsage: run.usage,
        subAgent: {
          runId: rid, stepId: run.stepId || '', memberId: run.memberId,
          memberName: run.memberName, memberPreset: run.memberPreset, model: run.model,
          modelFallback: !!run.modelFallback, modelConfigured: run.modelConfigured,
          plan: Array.isArray(run.plan) ? run.plan : undefined,
          tools: (Array.isArray(run.tools) ? run.tools : []).map((t: any) => ({ name: t.name, status: t.status || 'done', result: t.result })),
          segments: Array.isArray(run.segments) ? run.segments : undefined,
          status: run.status === 'error' ? 'error' : run.status === 'interrupted' || run.status === 'timeout' ? 'interrupted' : 'done',
          finished: true,
          fromBlackboard: true,
        },
      }))
      retractRunTools(list, run) /* [T6b] history-side: pull scattered clone tool nodes into the bubble */
      added++
    }
    normalizeSeqList(list) /* [T4b] post-insert seq normalization (strictly increasing, idempotent) */
    return added
  }

  /** 成员自列计划聚合（0910 三批①计划面板三合一）：把会话内各成员气泡里的计划取出来，
   *  供计划面板区与黑板/主计划并列渲染。同一成员多实例按出现顺序标 #n（与项目档案记录口径一致）。 */
  /** 0911 反馈：成员计划卡"完成后消失"的持久化——终帧后 11s（> PlanCard 的 10s 淡出）标记 finished，
   *  memberPlans 过滤 finished → 切窗/刷新回来不再复现（气泡内过程回放不受影响） */
  function scheduleMemberPlanExpiry(sa: any) {
    if (!sa || sa._planExpiryTimer) return
    sa._planExpiryTimer = setTimeout(() => { sa.finished = true }, 11000)
  }

  /** 0911 反馈5：同成员多实例编号——按消息流出现顺序给每个 subAgent 节点写 instanceNo。
   *  块标题（SubAgentBlock）与成员计划卡（memberPlans）共用同一套编号，视觉一致。 */
  function renumberMemberInstances(convId: string) {
    const cnt = new Map<string, number>()
    for (const n of getNodes(convId)) {
      const sa = (n as any).subAgent
      if (!sa) continue
      const k = String(sa.memberId || sa.memberName || '')
      if (!k) continue
      /* ★ 0925z（设计口径"#N 是身份牌"）：分身的 #N=**槽位号**（memberId 的 cloneN）——
       不按出现顺序累加（第二轮派的还是 #1/#2/#3）。团队成员保持原行为（顺序编）。 */
    const slotMatch = /^clone(\d+)$/.exec(k)
    if (slotMatch) { sa.instanceNo = Number(slotMatch[1]); continue }
    const idx = (cnt.get(k) || 0) + 1
      cnt.set(k, idx)
      sa.instanceNo = idx
    }
  }

  function memberPlans(convId: string): Array<{ key: string; memberName: string; items: Array<{ text: string; done: boolean }> }> {
    const out: Array<{ key: string; memberName: string; items: Array<{ text: string; done: boolean }> }> = []
    const cnt = new Map<string, number>()
    for (const n of getNodes(convId)) {
      const sa = (n as any).subAgent
      if (!sa || !Array.isArray(sa.plan) || !sa.plan.length) continue
      // 0911 反馈：已完成（含恢复回来的历史 run）不再出计划卡——否则"10s 消失"后切窗/刷新又回来。
      // 计划卡只服务"进行中"的仪表；历史过程在气泡内仍可完整回放
      if (sa.finished) continue
      const base = String(sa.memberName || '成员')
      const idx = Number((sa as any).instanceNo) || (cnt.get(base) || 0) + 1
      cnt.set(base, idx)
      out.push({ key: String(sa.runId || `${base}-${idx}`), memberName: idx > 1 ? `${base} #${idx}` : base, items: sa.plan })
    }
    return out
  }

  /** 处理 pi agent 原始事件（流式更新节点） */
  // 最近一次收到 agent 事件的时刻 + 对应会话：ChatInterface 据此判断"生成中但 >2.5s 无新事件"
  // = 大参数流式盲区（provider 缓冲整段 tool_call 参数 30~60s，期间无 text_delta 也无工具事件，
  // 前端零反馈=体感卡死）。按会话记录，切会话不误判。
  const lastAgentEvent = ref<{ convId: string; at: number }>({ convId: '', at: 0 })
  /** 当前 assistant 消息代次（message_start(assistant) 时自增）：工具节点按它归属到具体消息，
   *  防止 contentIndex 跨消息复用时"上一条消息的工具行"被本条消息的流式事件认领（0910 图三根因） */
  let assistantSeq = 0
  /** 匹配"本轮消息里仍未定稿"的工具节点（contentIndex/callId 之外的统一入口） */
  function openToolNode(list: PiNode[], seq: number, pred: (n: any) => boolean) {
    return findLast(list, (n: any) => n.kind === 'tool' && (n.msgSeq ?? seq) === seq && n.status === 'streaming' && n.toolStatus !== 'done' && pred(n))
  }
  /** 0906 五批：thinking_delta 停止后 1.5s 置位=进入静默（Think 行右侧出现"还在进行 · Ns"，
   *  区分"上游死区慢"与"真死了"；任何新事件先清除，thinking 恢复或进入其他阶段自动消失）。 */
  const thinkIdleUntil = ref(0)
  let thinkIdleTimer: ReturnType<typeof setTimeout> | null = null
  function handleAgentEvent(convId: string, event: any) {
    lastAgentEvent.value = { convId, at: Date.now() }
    const _ae = event?.assistantMessageEvent
    if (thinkIdleTimer) { clearTimeout(thinkIdleTimer); thinkIdleTimer = null }
    thinkIdleUntil.value = 0
    if (_ae?.type === 'thinking_delta') {
      thinkIdleTimer = setTimeout(() => { thinkIdleUntil.value = Date.now() }, 1500)
    }
    const list = getNodes(convId)

    switch (event.type) {
      case 'message_start': {
        const msg = event.message
        // 0910 修"上轮工具行被本轮认领"（图三：读团队信息行展开显示上一轮询问卡的回答）：
        // contentIndex 是**每条 assistant 消息内的下标**，跨消息必然重复（每轮 thinking/text/toolCall
        // 都是 0/1/2）。旧实现按 contentIndex 全局 findLast 匹配 → 上一轮已完成的工具节点会被本轮
        // toolcall_start/delta 抢走（改名/串参/显示别轮结果）。用消息代次 + "仍未定稿"双条件约束匹配。
        if (msg.role === 'assistant') assistantSeq++
        if (msg.role === 'user') {
          // 0909④：自动续跑注入指令（后端软段机制，模型可见消息）→ 渲染成 notice 分隔，不造假用户气泡
          const _raw = extractText(msg.content)
          if (isInjectedUserText(_raw)) {
            /* ★0930：软段续跑提示不上时间线（仅日志），见 isSegmentContinue */
            /* ★1007 修复（上线前检查·critical）：此处原先引用了**未声明**的 `clean`（作用域里只有 `_raw`）
               ⇒ 每次注入消息（自动续跑/后台任务通知/分身回归）走到这里都抛 ReferenceError，
               整个 handleAgentEvent 中断 ⇒ 时间线该渲染的 notice 不渲染。与 buildHistoryNodes 同口径补上。 */
            const clean = stripModeHint(_raw)
            if (isSegmentContinue(clean) || isCloneReturnNotice(clean)) break
            getNodes(convId).push({ key: crypto.randomUUID(), kind: 'notice', text: clean.slice(0, 60), reasoning: '', status: 'done', time: Date.now(), noticePhase: 'info', noticeText: clean.startsWith('【自动续跑·收尾】') ? t('notice.budgetGrace') : clean })
            break
          }
          // 新一轮边界：把上一轮残留的"有内容但还在 streaming"的 assistant / 运行中 tool 定稿，
          // 避免本轮 thinking/text 误并入上一条（跨轮串轮 bug）。空的 beginAssistant 占位不动（它属于本轮）。
          for (const n of list) {
            if (n.kind === 'assistant' && n.status === 'streaming' && (n.text || n.reasoning)) n.status = 'done'
            if (n.kind === 'tool' && n.toolStatus === 'running') n.toolStatus = 'done'
          }
          const text = extractText(msg.content)
          const images = extractImages(msg.content)
          /* ★ 0925f：被撤回的插话 —— 回显到达直接丢弃（不回收已移除的乐观气泡、不新建回显节点） */
          if (isWithdrawnSteer(convId, text)) break
          // 本地文本可能带 [[图片:N]] 位置标记、skill/模式引导语前缀，回显是干净文本 → 剥离标记比较
          const stripAll = (t: string) => stripModeHint(t).replace(/^\[技能:[^\]]+\]\s*/, '').replace(/\[\[图片:\d+\]\]/g, '').replace(/\[\[文件:[^\]]+\]\]/g, '').replace(/\s+/g, ' ').trim()
          // 0909⑨：插话回显回收——注入可远晚于发送（等当前工具批次跑完，实测 17s+），5s 去重窗罩不住，
          // 曾致"光圈乐观气泡不消失 + 下方多出一条回显新气泡"。按 steerOptimistic 标记+文本匹配回收：
          // 清光圈、并在其前方插一枚"已引导至新对话"胶囊（重试过程块同款样式）。
          let steerNode = findLast(list, n => n.kind === 'user' && n.steerOptimistic && stripAll(n.text) === stripAll(text))
          /* ★ 0924（反馈“插话也变成两条了”）：原来只按“净化文本完全相等”认领乐观气泡 ——
             只要回显文本有一丁点差异（多一个换行、后端侧补了前缀、图片占位写法不同）就认领失败，
             结果「乐观气泡 + 回显新气泡」双份。这里加一道兜底：若当前**恰好只有一条**待回收的
             插话乐观气泡，就直接认它（并发插话多条极少见；真有多条时仍只走文本匹配，不会张冠李戴）。 */
          if (!steerNode) {
            const pend = list.filter((n: any) => n.kind === 'user' && n.steerOptimistic && n.steerPending)
            if (pend.length === 1) steerNode = pend[0]
          }
          if (steerNode) {
            steerNode.steerPending = false
            steerNode.steerOptimistic = false
            if (images.length) steerNode.images = images
            // 乐观气泡可能卡在旧轮流式内容中间（发送时 push 在末尾，之后旧轮又续了工具块）；
            // 注入时刻=旧轮真实边界 → 摘出重挂到列表末尾（回显本来的位置），前方插"已引导至新对话"胶囊。
            // 空 streaming 占位（本轮 round-2 的 delta 容器，beginAssistant/message_end 续出来的）
            // 必须跟着挪到气泡之后，否则新轮文本渲染在插话上方（顺序倒挂）。
            const si = list.indexOf(steerNode)
            if (si >= 0) list.splice(si, 1)
            list.push({ key: crypto.randomUUID(), kind: 'notice', text: '', reasoning: '', status: 'done', time: Date.now(), noticePhase: 'steer' })
            list.push(steerNode)
            for (let i = list.length - 3; i >= 0; i--) {
              const n = list[i]
              if (n.kind === 'assistant' && n.status === 'streaming' && !n.text && !n.reasoning && !n.subAgent) {
                list.splice(i, 1)
                list.push(n)
                break
              }
            }
            break
          }
          // 本地 sendMessage 已 push（即时显示）：同一文本 5s 内到达的 SSE 回显跳过
          // 兼容 skill 引导语前缀：[技能:xxx] 由后端加到消息开头，去重时剥离比较，
          // 命中则用回显全文覆盖本地文本（气泡据此渲染技能标签）
          const lastUser = findLast(list, n => n.kind === 'user')
          if (lastUser && (Date.now() - (lastUser.time || 0)) < 5000) {
            if (stripAll(lastUser.text) === stripAll(text)) {
              // 保留本地文本（含图片位置标记做内联渲染）与 skills；只补全回显里的 images
              /* ★1011t：本地气泡正文里没有**文件**标记（上传是异步的，push 那刻还没有 relPath），
                 而回显文本带着 `[[文件:uploads/x]]` ⇒ 把文件标记合并进来，否则气泡里永远看不到附件 chip。
                 注意不能整体覆盖成本地文本 = 回显文本：那会丢掉本地的图片位置标记（图会全挤到末尾）。 */
              const fileMarks = String(text || '').match(/\[\[文件:[^\]]+\]\]/g) || []
              if (fileMarks.length && !/\[\[文件:/.test(lastUser.text || '')) {
                lastUser.text = `${lastUser.text || ''} ${fileMarks.join(' ')}`.trim()
              }
              if (images.length) lastUser.images = images
              // 0909⑦：插话乐观气泡收到注入回显 → 清"插话中"标记（对账完成）
              lastUser.steerPending = false
              break
            }
          }
          list.push({ key: crypto.randomUUID(), kind: 'user', text: images.length ? ((/\[\[图片:\d+\]\]/.test(text) ? text : text + ' ' + images.map((_, i) => `[[图片:${i}]]`).join(' '))) : text, reasoning: '', status: 'done', time: msg.timestamp, images })
        } else if (msg.role === 'assistant') {
          // 复用 sendMessage 创建的占位节点（beginAssistant），否则新建
          const placeholder = findLast(list, n => n.kind === 'assistant' && n.status === 'streaming' && !n.text && !n.reasoning && !n.subAgent)
          if (!placeholder) {
            list.push({ key: crypto.randomUUID(), kind: 'assistant', text: '', reasoning: '', status: 'streaming', time: msg.timestamp, model: msg.model })
          } else {
            placeholder.model = msg.model || placeholder.model
          }
        }
        break
      }

      case 'message_update': {
        const ae = event.assistantMessageEvent
        if (!ae) break
        // 找当前 streaming assistant 节点；找不到时兜底新建（message_start 丢失/被去重时仍保证文本流入，
        // 否则 delta 被静默丢弃 → 回复空，刷新重放才恢复）
        let asst = findLast(list, n => n.kind === 'assistant' && n.status === 'streaming' && !n.subAgent)
        if (ae.type === 'text_delta' && ae.delta && !asst) {
          asst = { key: crypto.randomUUID(), kind: 'assistant', text: '', reasoning: '', status: 'streaming', time: Date.now(), model: event.message?.model }
          list.push(asst)
        } else if (ae.type === 'thinking_delta' && ae.delta && !asst) {
          asst = { key: crypto.randomUUID(), kind: 'assistant', text: '', reasoning: '', status: 'streaming', time: Date.now(), model: event.message?.model }
          list.push(asst)
        }
        if (ae.type === 'text_delta' && ae.delta && asst) {
          asst.reasoningDone = true // ★ 0925h：正文开始 = 思考阶段结束（Think 行定稿，不再陪跑）
          // delta 去重（LongCat 流式末段会重复推送相同增量，防止流式期间文本重复累积）
          if (ae.delta !== asst.lastTextDelta) {
            asst.lastTextDelta = ae.delta
            let d: string = ae.delta
            // 前导空白剥离：部分网关在工具轮之间先吐纯 \n 填充再吐正文；流式路径按 pre-wrap
            // 渲染会把空行撑成数百 px 的巨距（定稿换 MarkdownText 折叠空白后又消失=闪烁怪间距）。
            // 仅在气泡还是空的时候剥（句中换行/段落缩进不受影响）。
            // 尾随换行**不在此裁**（会毁段落间的 \n\n 语义）——渲染层 StreamingTail 入参已裁尾（PiChatView）。
            if (!asst.text) d = d.replace(/^\s+/, '')
            if (d) asst.text += d
          }
        } else if (ae.type === 'thinking_delta' && ae.delta && asst) {
          asst.reasoningDone = false // ★ 0925h：思考流又来了 → 回到"思考进行中"
          if (ae.delta !== asst.lastReasoningDelta) {
            asst.lastReasoningDelta = ae.delta
            asst.reasoning += ae.delta
          }
        } else if (ae.type === 'toolcall_start') {
          // ★ 0925h（反馈"Think 过程态陪跑完第一个工具才结束"）：工具一开调用，思考就该定稿
          {
            const asstT = findLast(list, n => n.kind === 'assistant' && n.status === 'streaming' && !n.subAgent)
            if (asstT) asstT.reasoningDone = true
          }
          // 占位工具节点。pi-ai 对 tool_calls 分片也会发 start（网关常缓冲参数到末刻一次性吐完，
          // 死区实测 38s 无任何 delta），若此处硬要求 contentIndex 会静默丢 start →
          // 过程块要等 toolcall_end/tool_execution_start 才出现（"动画迟到"根因之一）。
          // contentIndex 缺失时用 -1-index 占位；同一事件里可能已有多个块（partial 全量快照），按索引批量补建。
          const idx = typeof ae.contentIndex === 'number' ? ae.contentIndex : null
          const blocks: any[] = (ae.partial?.content || []).filter((c: any) => c.type === 'toolCall')
          // 并行多工具场景：partial 快照里有多个 toolCall 块，取"尚未被任何节点认领"的那块
          // （直接 find(c=>c.id) 会把第二个 start 误绑到第一个调用的 id 上）
          const block = blocks.find((c: any) => c.id && !list.some(n => n.kind === 'tool' && n.callId === c.id))
            || blocks.find((c: any) => !c.id) || blocks[0]
          // 0906 五批：fs_write 运行态=诚实等待行（静止图标+计时，无假想动；见 ToolPartBlock），
          // 节点照常创建（上批的 skip/隐藏已撤——等待态本身能治"卡住感"）。
          // 先对号：已有同 contentIndex 节点（真 index 精确匹配 / 负数占位按"第 k 个负位"对位）
          // 0910：候选必须是**本条消息内仍未定稿**的节点（跨消息 contentIndex 复用=图三串台根因）
          const placeholderCount = list.filter(n => n.kind === 'tool' && (n as any).msgSeq === assistantSeq && typeof n.contentIndex === 'number' && n.contentIndex < 0).length
          const existing = idx != null
            ? openToolNode(list, assistantSeq, n => n.contentIndex === idx)
            : openToolNode(list, assistantSeq, n => n.contentIndex === -(placeholderCount))
          if (existing) {
            if (block?.name && !existing.toolName) existing.toolName = block.name
            if (block?.id && !existing.callId) existing.callId = block.id
          } else {
            const placeholderIndex = idx != null ? idx : -(placeholderCount + 1)
            list.push({ key: crypto.randomUUID(), kind: 'tool', text: '', reasoning: '',
              status: 'streaming', msgSeq: assistantSeq, contentIndex: placeholderIndex, callId: block?.id || '',
              toolName: block?.name || '', toolArgs: '', toolStatus: 'running' })
          }
        } else if (ae.type === 'toolcall_delta' && typeof ae.contentIndex === 'number' && ae.delta) {
          const tool = openToolNode(list, assistantSeq, n => n.contentIndex === ae.contentIndex)
          if (tool) {
            // 0906 五批：累计已到的参数流字节数（诚实等待行显示"已生成 N 字符"进度；网关缓冲时恒 0=诚实）
            tool.toolStreamChars = (tool.toolStreamChars || 0) + (ae.delta || '').length
            const next = typeof tool.toolArgs === 'string' ? tool.toolArgs : JSON.stringify(tool.toolArgs || '')
            const merged = next + ae.delta
            try { tool.toolArgs = JSON.parse(merged) } catch { tool.toolArgs = merged }
          }
        } else if (ae.type === 'toolcall_delta' && typeof ae.contentIndex === 'number' && ae.partial) {
          // 从 partial 的 toolCall 块提取 name/args 实时更新（流式中立即显示正确图标）
          const blocks: any[] = (ae.partial.content || []).filter((c: any) => c.type === 'toolCall')
          const block = blocks[ae.contentIndex] && blocks[ae.contentIndex].id ? blocks[ae.contentIndex]
            : blocks.find((c: any) => c.id && !list.some(n => n.kind === 'tool' && n.callId === c.id && n.contentIndex !== ae.contentIndex))
          const tool = openToolNode(list, assistantSeq, n => n.contentIndex === ae.contentIndex)
          if (tool && block) {
            if (block.name) tool.toolName = block.name
            if (block.id && !tool.callId) tool.callId = block.id
            if (block.arguments) tool.toolArgs = block.arguments
          }
        } else if (ae.type === 'toolcall_end' && ae.toolCall) {
          // 对号入座（严禁误绑已定稿节点——并行双 fs_write 场景两个 end 会抢同一节点丢其一）：
          // ①contentIndex 相等 ②callId 相同 ③名称相同且无参数 ④最近一个"无 callId 且无参数"的占位
          // 0910：①②④ 的前两类候选都收敛在"本条消息内仍未定稿"的节点上（callId 匹配走全表——
          // callId 全局唯一，重复 end 幂等）；跨消息的已定稿节点一律不再被认领。
          const endIdx = typeof ae.contentIndex === 'number' ? ae.contentIndex : null
          const isEmptyPlaceholder = (n: any) => !n.callId && !n.toolArgs || (typeof n.toolArgs === 'object' && Object.keys(n.toolArgs || {}).length === 0 && !n.callId)
          const tool =
            (endIdx != null ? openToolNode(list, assistantSeq, n => n.contentIndex === endIdx && !n.callId) : undefined) ||
            findLast(list, n => n.kind === 'tool' && n.callId && n.callId === ae.toolCall.id) ||
            openToolNode(list, assistantSeq, n => isEmptyPlaceholder(n) && (!n.toolName || n.toolName === ae.toolCall.name)) ||
            openToolNode(list, assistantSeq, n => isEmptyPlaceholder(n))
          if (tool) {
            tool.callId = ae.toolCall.id
            tool.toolName = ae.toolCall.name
            tool.toolArgs = ae.toolCall.arguments
            if (endIdx != null) tool.contentIndex = endIdx
          } else {
            list.push({ key: crypto.randomUUID(), kind: 'tool', text: '', reasoning: '',
              status: 'streaming', msgSeq: assistantSeq, contentIndex: endIdx ?? -1, callId: ae.toolCall.id, toolName: ae.toolCall.name, toolArgs: ae.toolCall.arguments, toolStatus: 'running' })
          }
        }
        break
      }

      case 'message_end': {
        const msg = event.message
        if (msg.role === 'assistant') {
          let asst = findLast(list, n => n.kind === 'assistant' && n.status === 'streaming' && !n.subAgent)
          if (!asst) {
            // 兜底：streaming 节点丢失（前端重连/事件被去重）时按最终文本重建，避免回复空
            const finalText = extractText(msg.content)
            if (finalText) {
              asst = { key: crypto.randomUUID(), kind: 'assistant', text: finalText, reasoning: '',
                status: 'done', time: msg.timestamp || Date.now(), model: msg.model }
              list.push(asst)
            }
            break
          }
          asst.status = 'done'
          asst.model = msg.model || asst.model
          // 用 message.content 的最终文本覆盖（更准确，且消除流式去重边界残留）
          const finalText = extractText(msg.content)
          if (finalText) asst.text = finalText
          // 0909⑨：同轮近重复抑制——模型常在"工具轮→收尾轮"把整段答案原样重说（小确幸实锤：
          // 故事全文出现两遍）。本轮（最后一个 user 之后）更早的 assistant 节点若与新文本近重复，
          // 清空其正文只留 Think（后端 assembleTurnContent 同步做定稿去重，历史/实时两口径一致）。
          if (asst.text.trim()) {
            let lastUserIdx = -1
            for (let i = list.length - 1; i >= 0; i--) { if (list[i].kind === 'user') { lastUserIdx = i; break } }
            for (let i = list.length - 1; i > lastUserIdx; i--) {
              const prev = list[i]
              if (prev === asst || prev.kind !== 'assistant' || prev.subAgent) continue
              if (prev.text && isNearDuplicate(prev.text, asst.text)) {
                /* ★0927 留痕（实测①"Think/回复内容有时整段消失"）：这里会**直接抹掉**
                   上一段 assistant 的正文。若是误判（模型在同一轮里说了相似的两段），用户看到的就是
                   "内容凭空消失、刷新后又回来"（刷新走历史重建，不受影响）。加日志便于定位。 */
                console.warn(`[piChat] 近重复去重抹掉了上一段正文（${prev.text.length} 字）：`, prev.text.slice(0, 40))
                /* 0927-fix2: 近重复帧忽略，但绝不抹已有正文 */
              }
            }
          }
          asst.lastTextDelta = ''
          asst.lastReasoningDelta = ''
          // 0908 二批条3（"正在写入块时隐时现"根因）：纯工具轮的定稿会把【空】占位一并定稿→
          // 工具执行期间无 streaming 节点→Think 动画消失、下轮文本 delta 又新建→再出现。
          // 轮边界语义不变（定稿后本轮不再收 delta），只是立刻续一个【新】空占位（新内容进新节点，
          // 不串轮）；空 done 节点被 visibleNodes 过滤无残留，轮结束/停止由 finalizeStreaming 清理。
          if (!asst.text && !asst.reasoning) beginAssistant(convId)
        }
        break
      }

      case 'tool_execution_start': {
        // 兜底：tool_execution_start 事件自带 toolName，流式提取失败时也能显示正确图标
        // 0910：callId 精确匹配优先；无 callId 的兜底只在"本条消息内仍未定稿"的占位里找
        const tool = findLast(list, n => n.kind === 'tool' && n.callId && n.callId === event.toolCallId)
          || openToolNode(list, assistantSeq, n => !n.callId)
        if (tool) {
          tool.toolStatus = 'running'
          tool.callId = event.toolCallId
          tool.awaitingApproval = false
          if (event.toolName) tool.toolName = event.toolName
        }
        break
      }

      case 'tool_execution_end': {
        const tool = findLast(list, n => n.kind === 'tool' && n.callId === event.toolCallId)
        if (tool) {
          tool.toolResult = extractToolResult(event.result)
          tool.toolError = !!event.isError
          tool.toolStatus = event.isError ? 'error' : 'done'
          tool.status = 'done'
          // 团队派发收尾：本批子 agent 节点兜底定稿（事件丢失时）
          // ★1004：跳过后台分身（spawn_clone detached）——它不属于本批 team_dispatch，别误伤定稿
          if (tool.toolName === 'team_dispatch') {
            for (const n of list) {
              if (n.subAgent && n.subAgent.status === 'running' && !isDetachedClone(n.subAgent)) {
                n.subAgent.status = 'done'
                n.subAgent.finished = true
                if (n.status === 'streaming') n.status = 'done'
              }
            }
          }
          // 0920：命令过程行终端标识（后端 details.shell；老历史消息无此字段 → 不显示）
          if (tool.toolName === 'run_command') {
            const sh = (event.result as any)?.details?.shell
            if (typeof sh === 'string' && sh) tool.toolShell = sh
          }
          // fs_write 成功：记录字节数（产出物卡片显示大小）
          if (tool.toolName === 'fs_write' && !event.isError) {
            let bytes = typeof event.result?.details?.bytes === 'number' ? event.result.details.bytes : undefined
            if (bytes == null) {
              // fallback：从结果文本提取 "N 字节"
              const m = /(\d+)\s*字节/.exec(String(tool.toolResult || ''))
              if (m) bytes = Number(m[1])
            }
            if (bytes != null) tool.fileSize = bytes
          }
          // ★ 0929：+N/-M 行数（写类工具行显示改动量；details 通道，老历史没有就不显示）
          const dd = (event.result as any)?.details
          if (typeof dd?.added === 'number' || typeof dd?.removed === 'number') tool.diffStat = { added: dd.added || 0, removed: dd.removed || 0 }
          // 0908 截图内嵌对话流：vcall 透传的 details（shotRef=已落盘工作区 screenshots/；旧内联 dataUrl 兼容）→
          // 紧随工具卡插入独立 image 节点（正文流看图；失败不插，错误由工具卡自呈）
          const shotSrc = resolveShotSrc((event.result as any)?.details, convId)
          if (shotSrc && !event.isError) {
            list.splice(list.indexOf(tool) + 1, 0, {
              key: crypto.randomUUID(), kind: 'image', text: '', reasoning: '',
              status: 'done', time: Date.now(), images: [shotSrc],
            })
          }
        }
        break
      }

      case 'agent_end': {
        // 所有 streaming 节点定稿
        for (const n of list) {
          if (n.status === 'streaming') n.status = 'done'
          if (n.toolStatus === 'running') n.toolStatus = 'done'
        }
        break
      }
    }
  }

  /** 发送消息后立即创建 assistant 占位（头像+Think 动画即时反馈，不等待 LLM 首 token） */
  function beginAssistant(convId: string) {
    const list = getNodes(convId)
    // 只复用「空」的 streaming 占位（abort 残留的有内容节点不复用，避免内容串轮）
    const existing = findLast(list, n => n.kind === 'assistant' && n.status === 'streaming' && !n.text && !n.reasoning && !n.subAgent)
    if (existing) return existing
    const node: PiNode = {
      key: crypto.randomUUID(), kind: 'assistant', text: '', reasoning: '',
      status: 'streaming', time: Date.now(),
    }
    list.push(node)
    return node
  }

  /** 0908 修"回合中途刷新整轮消失"（正在写入块刷新后不见）：transcript 要等 agent_end 才落盘，
   *  loadHistory 重建时本轮不在盘上。会话仍在 replying 就补一个空 streaming 占位
   *  （与 beginAssistant 同款 Think 动画；后续 SSE 事件按 findLast streaming 挂上它）。
   *  竞态兜底：若 agent_end 恰在补位前已过，占位被 finalizeStreaming 定稿为空节点即自清，
   *  下一次 loadConversations/openConversation 会从已落盘 transcript 正常重建。 */
  function resumeStreamingPlaceholder(convId: string) {
    const list = getNodes(convId)
    if (list.some(n => n.status === 'streaming')) return
    beginAssistant(convId)
  }

  /** 定稿所有 streaming 节点（停止生成/agent 结束时调用）；定稿后完全空的 assistant 节点移除。
   *  ★1004 finalizeClones：用户**主动停止**才定稿后台分身（spawn_clone detached）——
   *  自然收轮时分身还在后台跑，一刀切置 done = "显示完成实际在跑"+ 把停止按钮 cloneBusy 判据打死；
   *  分身终态默认只按它自己的 run 帧（agent_end/agent_stats/error → handleSubagentEvent）。
   *  ★1004b：依赖三保险防僵尸（恢复去重终态优先 / 实时帧认领未完结优先 / 击杀路径终态帧），勿单独回退。 */
  function finalizeStreaming(convId: string, opts?: { finalizeClones?: boolean }) {
    const finalizeClones = opts?.finalizeClones !== false
    const list = getNodes(convId)
    for (const n of list) {
      if (n.status === 'streaming') n.status = 'done'
      if (n.kind === 'tool' && n.toolStatus === 'running') n.toolStatus = 'done'
      // 0909⑨：轮结束=插话对账终止（停止/中断时注入回显永不到达），光圈不再有意义；
      // steerOptimistic 保留——若消息被 drain 进 transcript，下轮回显仍按标记去重
      if (n.kind === 'user' && n.steerPending) n.steerPending = false
      if (n.subAgent && n.subAgent.status === 'running' && (finalizeClones || !isDetachedClone(n.subAgent))) {
        n.subAgent.status = 'done'
        n.subAgent.finished = true
      }
    }
    // 清理瞬时过程块：retry 全清（含恢复后自移除）；notice 只清"压缩中"转圈态，保留"已压缩"分隔线到刷新
    const cleaned = list.filter(n =>
      n.kind !== 'retry' &&
      !(n.kind === 'notice' && n.noticePhase === 'compacting') &&
      (n.kind !== 'assistant' || n.text || n.reasoning || (n.asides && n.asides.length > 0) || n.subAgent))
    if (cleaned.length !== list.length) nodes.value[convId] = cleaned
  }

  /** 重试过程块：后端 llm-retry 投影帧驱动。retry=过程态（就地更新未终结块），
   *  recovered=完成态✓短暂保留后自移除，failed=完成态✗琥珀保留。仅实时，不进历史/持久化。 */
  function handleLlmRetry(convId: string, v: { phase: 'retry' | 'recovered' | 'failed'; attempt?: number; maxRetries?: number; reason?: string; delayMs?: number }) {
    const list = getNodes(convId)
    let node = findLast(list, n => n.kind === 'retry' && n.retryPhase === 'retry')
    if (v.phase === 'retry') {
      if (!node) {
        node = { key: crypto.randomUUID(), kind: 'retry', text: '', reasoning: '', status: 'done', time: Date.now() }
        list.push(node)
      }
      node.retryPhase = 'retry'
      node.retryAttempt = v.attempt
      node.retryMax = v.maxRetries
      node.retryReason = v.reason
      // 0910 反馈10：本档等待秒数（后端退避阶梯值，过程块显示"等 N 秒"）
      node.retryDelayMs = v.delayMs || 0
      return
    }
    // recovered / failed：当前过程块转完成态（无过程块则补一个，如恢复事件单独到达）
    if (!node) {
      node = { key: crypto.randomUUID(), kind: 'retry', text: '', reasoning: '', status: 'done', time: Date.now() }
      list.push(node)
    }
    node.retryPhase = v.phase
    node.retryReason = v.reason || node.retryReason
    if (v.phase === 'recovered') {
      const rk = node.key
      setTimeout(() => {
        const l = getNodes(convId)
        const i = l.findIndex(n => n.key === rk && n.kind === 'retry' && n.retryPhase === 'recovered')
        if (i >= 0) l.splice(i, 1)
      }, 2400)
    }
  }

  /** 上下文压缩内联通知：phase=compacting 在流尾部加"压缩中"分隔线（转圈），done 就地转成"—— 上下文已压缩 ——"。仅实时。 */
  function handleContextNotice(convId: string, v: { phase: 'compacting' | 'done' | 'failed' }) {
    const list = getNodes(convId)
    let node = findLast(list, n => n.kind === 'notice' && n.noticePhase === 'compacting')
    /* ★ 0923（反馈"顺序不对：压缩线跑到回复底部"）——
       根因：turn 开始时 beginAssistant 先建了一个**空的 streaming 占位节点**，
       而这里一律 push 到末尾 → 压缩线排在占位节点**之后**；
       可后续正文恰恰写进那个占位节点 → 视觉上压缩线被排到了回复最后。
       修正：若当前 streaming 的 assistant 节点**还没有内容**，说明接下来的正文属于"压缩后"的，
       压缩线就该排在**它前面**（压缩前内容 → 压缩线 → 压缩后继续）；
       只有"已经有内容"时才追加到末尾（那说明压缩确实发生在正文之后）。 */
    const placeNotice = (fresh: any) => {
      const emptyPlaceholder = findLast(list, (n: any) => n.kind === 'assistant' && n.status === 'streaming' && !n.text && !n.reasoning && !n.subAgent)
      if (emptyPlaceholder) {
        const i = list.indexOf(emptyPlaceholder)
        list.splice(i >= 0 ? i : list.length, 0, fresh)
      } else {
        list.push(fresh)
      }
      return fresh /* 0927 netfix A4: return the inserted node (was void -> _fn stayed undefined and the
                      "压缩中断" text never landed on a freshly created notice) */
    }
    if (v.phase === 'compacting') {
      if (node) return // 已有转圈态，不重复
      const _freshNotice: any = { key: crypto.randomUUID(), kind: 'notice', text: t('notice.compacting'), reasoning: '', status: 'done', time: Date.now(), noticePhase: 'compacting' }
      placeNotice(_freshNotice)
      /* ★ 0925m（实测"会话一直卡在正在整理较早的对话"——重启打断压缩后 done 永远不来）：
         转圈态带 3 分钟超时自愈，到点没收到 done 就落成「压缩中断」提示，不再永久转圈。 */
      setTimeout(() => {
        const _still = (nodes.value[convId] || []).find((n: any) => n.key === _freshNotice.key && n.noticePhase === 'compacting')
        if (_still) { _still.noticePhase = 'info'; _still.text = t('notice.compactingTimeout'); _still.noticeText = t('notice.compactingTimeout') }
      }, 3 * 60 * 1000)
      return
    }
    /* ★ 0925o（实测"报错了却显示压缩成功"）：失败落成「压缩中断」，绝不转"已压缩"卡片 */
    if (v.phase === 'failed') {
      const _fn = node || placeNotice({ key: crypto.randomUUID(), kind: 'notice', text: '', reasoning: '', status: 'done', time: Date.now(), noticePhase: 'info' })
      if (_fn) { _fn.noticePhase = 'info'; _fn.text = t('notice.compactingTimeout'); _fn.noticeText = t('notice.compactingTimeout') }
      window.dispatchEvent(new CustomEvent('nis-refresh-context')) /* ★ 0925r：收尾后刷新圆环 */
      return
    }
    if (node) { node.noticePhase = 'compacted'; node.noticeText = undefined; node.text = t('notice.compacted', { pct: 35 }) }
    else placeNotice({ key: crypto.randomUUID(), kind: 'notice', text: t('notice.compacted', { pct: 35 }), reasoning: '', status: 'done', time: Date.now(), noticePhase: 'compacted' })
    window.dispatchEvent(new CustomEvent('nis-refresh-context')) /* ★ 0925r：压缩收尾后立刻刷圆环（锚点已在后端按比例缩放） */
  }

  /** 0908七：轮次上限等系统收尾提示（session/projection key=session-notice）
   *  → 内联 notice 节点（ContextDivider 的 noticeText 自定义文案分支渲染） */
  function handleSessionNotice(convId: string, v: { text?: string }) {
    if (!v?.text) return
    const list = getNodes(convId)
    list.push({ key: crypto.randomUUID(), kind: 'notice', text: v.text, reasoning: '', status: 'done', time: Date.now(), noticePhase: 'info', noticeText: v.text })
  }

  /** 权限/问询卡注入：挂到最后一个 assistant 节点（无节点时建占位承载，避免静默丢卡） */
  function attachAside(convId: string, aside: any) {
    const list = getNodes(convId)
    /* ★0930 修（答题卡提交后卡死 2/2 已提交但 AI 一直"等待处理"）：**字段名归一化** ——
       实时帧挂的卡带 request_id，reconcileLive 补挂的带 requestId（camelCase），两边不一致。
       pendingCard/answerAside 都只读 request_id ⇒ 补挂的卡提交时 request_id=undefined，
       后端 `session.questionAnswer` 直接拒（requestId required），ask_user 的 promise 永远挂着
       （实测拖满 600s 超时才继续）。挂进来时统一成 request_id，下游不再分叉。 */
    if (!aside.request_id && aside.requestId) aside.request_id = String(aside.requestId)
    /* ★0926②：按 requestId 去重（**重复卡的真实来源**：实时帧挂一张 + 重连补账
       （reconcileLive / session.history）又挂一张 —— 两边字段名还不一样，
       不看两侧都会被漏掉。不去重就会出现两张同样的卡，点一次不够）。 */
    const rid = String(aside?.request_id || aside?.requestId || '')
    if (rid) {
      const dup = list.some((n: any) => Array.isArray(n.asides) && n.asides.some((a: any) => String(a?.request_id || a?.requestId || '') === rid))
      if (dup) return
    }
    let asst = findLast(list, n => n.kind === 'assistant')
    if (!asst) {
      asst = { key: crypto.randomUUID(), kind: 'assistant', text: '', reasoning: '', status: 'done', time: Date.now() }
      list.push(asst)
    }
    if (!asst.asides) asst.asides = []
    asst.asides.push(aside)
    // 权限卡挂起期间：对应工具节点标记"等待审批"（工具行显示琥珀待批，而非运行中）
    if (aside.type === 'permission_prompt') {
      const tool = findLast(list, n => n.kind === 'tool' && (n.toolStatus === 'running' || n.status === 'streaming') && !n.awaitingApproval)
      if (tool) tool.awaitingApproval = true
    }
    asideVersion.value += 1
  }

  /** 标记 aside 已应答（问题卡/权限卡提交后） */
  function answerAside(convId: string, requestId: string, value: string) {
    /* ★0929：应答即打**全局**"本人已答"标记 —— 提交入口分散（输入区卡/悬浮窗/超时跳过），
       只打组件局部标记时，结算帧若由别的组件实例处理就会误判"别的窗口答的"。
       结算帧处理完会 forget 清除，此处多打一次无副作用。 */
    markAnsweredByUser(requestId)
    for (const n of getNodes(convId)) {
      const a = (n.asides || []).find(x => String(x?.request_id || x?.requestId) === requestId)
      /* ★0929（实测"回答完问题显示已在其他窗口应答"）：**首答即定（first-wins）** ——
         后端 broadcastInteractionDone 把结算帧同时投会话桶+全局桶，本窗口两条流各收一份：
         第一份消费掉"本窗口答的"标记（forget+delete），第二份误判"别的窗口答的"并把
         已答好的卡改写成「已在其他窗口应答」。已应答的卡一律拒收后续改写。 */
      if (a && !a.answered) {
        a.answered = true
        a.answeredValue = value
      }
    }
    // 审批应答后清除等待标记（工具可继续执行；若清除不全，tool_execution_start 也会清）
    for (const n of getNodes(convId)) {
      n.awaitingApproval = false
    }
    asideVersion.value += 1
  }

  /* ★0927：**"这张卡是本窗口/本人答的"全局标记**（存在 store 里，不是组件局部变量）。
     为什么要全局：点卡的组件实例 与 处理后端结算帧（session/interaction-done）的组件实例
     可能不是同一个（主界面 / 悬浮 dock / 多窗口），局部 Set 会漏 → 卡片被覆盖成「已在其他窗口应答」。
     requestId 是 UUID 全局唯一，直接用 requestId 作键；上限 500 防无限增长。 */
  const userAnsweredIds = new Set<string>()
  function markAnsweredByUser(requestId: string) {
    const r = String(requestId || '')
    if (!r) return
    userAnsweredIds.add(r)
    if (userAnsweredIds.size > 500) userAnsweredIds.clear()
  }
  function wasAnsweredByUser(requestId: string): boolean {
    return userAnsweredIds.has(String(requestId || ''))
  }
  function forgetAnsweredByUser(requestId: string) {
    userAnsweredIds.delete(String(requestId || ''))
  }

  /** 子 agent 事件（session/subagent-event）：维护独立的 subAgent 消息节点（头像+名字+气泡，默认折叠） */
  function handleSubagentEvent(convId: string, p: { runId: string; stepId: string; memberId: string; memberName: string; memberPreset?: string; seq: number; event: any; model?: string; modelFallback?: boolean; modelConfigured?: string }) {
    const list = getNodes(convId)
    // 目标节点：已认领该 run 的 subAgent 节点 → 否则新建
    /* ★1004：同 runId 可能有多个节点（重复快照历史数据）——认领**未完结的**优先，
       否则终态帧被已完结节点接走、真节点卡僵尸 running（CPU 满根因链的一环）。 */
    const sameRun = list.filter(n => n.subAgent?.runId === p.runId)
    let node = [...sameRun].reverse().find(n => n.subAgent?.status === 'running')
      || (sameRun.length ? sameRun[sameRun.length - 1] : undefined)
    if (!node) {
      node = {
        key: crypto.randomUUID(), kind: 'assistant', text: '', reasoning: '', status: 'streaming', time: Date.now(),
        seq: nextSeq(), /* [T4b] clone messages join the same seq stream: take a number by arrival order,
                           never inserted by their own timestamp */
        subAgent: { runId: p.runId, stepId: p.stepId, memberId: p.memberId, memberName: p.memberName, memberPreset: p.memberPreset, tools: [], status: 'running', segments: [] },
      }
      list.push(node)
      renumberMemberInstances(convId)
    }
    const sa = node.subAgent!
    sa.memberName = p.memberName || sa.memberName
    // 0913 头像批：memberPreset 可能只在部分帧上携带（如主中继帧）——任何一帧到了就回填
    if (p.memberPreset) sa.memberPreset = String(p.memberPreset)
    // 0910 反馈3：模型名以"后端下发的实际配置模型"为准（独立模型=成员面板选的那个 id），
    // 不再用 LLM 响应里的 model 字段兜底显示成另一个名字——气泡头部与成员面板保持同步
    if (p.model) sa.model = String(p.model)
    // 0910 反馈3（二修）：回退状态随实时帧一并下发（原先只写进 run 快照 → 实时气泡不显示"已回退"徽标）
    if (p.modelFallback !== undefined) sa.modelFallback = !!p.modelFallback
    if (p.modelConfigured) sa.modelConfigured = String(p.modelConfigured)
    if (!Array.isArray(sa.segments)) sa.segments = []
    const segs = sa.segments as SubSegment[]
    const ev = p.event || {}
    const ae = ev.assistantMessageEvent
    // 追加/合并内容段：与最近一段同类型则续写（流式增量），否则开新段（时间穿插的关键）
    const appendSeg = (type: 'thinking' | 'text', delta: string) => {
      const last = segs[segs.length - 1]
      if (last && last.type === type) last.text += delta
      else segs.push({ type, text: delta } as SubSegment)
    }
    switch (ev.type) {
      case 'stream_note': {
        // 0911 反馈3：LLM 报错/重连事件 → 过程块插入 error 段（同类相邻合并，避免刷屏）
        // 0911 三批：巡检记录（kind='inspector'）同走此通道，文本即后端给的巡检文案
        const noteText = ev.kind === 'inspector'
          ? String(ev.reason || '').slice(0, 160) || t('notice.inspectorRecord')
          : (ev.kind === 'retry' ? t('notice.retryAttempt', { n: ev.attempt }) : ev.kind === 'recovered' ? t('notice.retryRecovered') : t('notice.retryFailed')) + (ev.reason ? `：${String(ev.reason).slice(0, 160)}` : '')
        const lastSeg = segs[segs.length - 1]
        if (!(lastSeg && lastSeg.type === 'error' && lastSeg.text === noteText)) segs.push({ type: 'error', text: noteText })
        break
      }
      case 'message_start':
        /* [nis:diag] 临时诊断（确认"思考/正文是否流式到达"）：一轮最多 2 行，确认后摘除。 */
        if (!(node as any)._diagStart) { (node as any)._diagStart = Date.now(); try { console.log('[nis:diag] 流式开始 t=' + new Date().toISOString().slice(11, 23) + ' run=' + String(p.runId || '').slice(0, 8)) } catch { /* ignore */ } }
        // 0910 反馈3（二修）：不再用 LLM 回包里的 model 覆盖已同步的成员模型名——网关回包名 ≠ 用户所选。
        // 权威来源 = 后端下发的 p.model（成员面板所选）与 agent_stats 终帧；此处仅在任何来源都还没有时占位。
        if (!sa.model && ev.message?.role === 'assistant' && ev.message.model) sa.model = ev.message.model
        break
      case 'message_update':
        if (ae?.type === 'text_delta' && ae.delta) {
          // delta 去重（与主 agent 同策略：模型末段重复推送相同增量时跳过）
          if (ae.delta !== node.lastTextDelta) {
            node.lastTextDelta = ae.delta
            node.text += ae.delta
            appendSeg('text', ae.delta)
          }
        } else if (ae?.type === 'thinking_delta' && ae.delta) {
          if (ae.delta !== node.lastReasoningDelta) {
            node.lastReasoningDelta = ae.delta
            node.reasoning += ae.delta
            appendSeg('thinking', ae.delta)
          }
        } else if (ae?.type === 'toolcall_start') {
          const block = (ae.partial?.content || []).find((c: any) => c.type === 'toolCall' && c.name)
          if (block) {
            sa.tools.push({ name: block.name, status: 'running' })
            segs.push({ type: 'tool', name: block.name, status: 'running', toolCallId: block.id || ('subseg:' + p.runId + ':' + segs.length), args: (block as any).arguments, runId: p.runId } as any) /* [T6] ownership: runId + stable synthetic toolCallId */
          }
        } else if (ae?.type === 'toolcall_end' && ae.toolCall) {
          const t = [...sa.tools].reverse().find(x => x.name === ae.toolCall.name && x.status === 'running')
          if (t) t.status = 'done'
          // 回填该工具段的 id/args（ToolPartBlock 过程块渲染需要完整入参）
          const seg = [...segs].reverse().find(s => s.type === 'tool' && s.name === ae.toolCall!.name && s.status === 'running') as any
          if (seg) {
            seg.toolCallId = ae.toolCall.id || seg.toolCallId
            seg.args = ae.toolCall.arguments ?? seg.args
            seg.status = 'done'
          }
        }
        break
      case 'message_end':
        /* [nis:diag] 临时诊断：与"流式开始"配对 —— 间隔长 = 帧是渐到的（渲染问题）；
           间隔≈0 = 帧本来就是一口气到的（模型/适配器行为，不是 bug）。确认后摘除。 */
        try { console.log('[nis:diag] message_end t=' + new Date().toISOString().slice(11, 23) + ' 距开始 ' + ((Date.now() - ((node as any)._diagStart || Date.now())) / 1000).toFixed(1) + 's segs=' + segs.length) } catch { /* ignore */ }
        if (ev.message?.role === 'assistant') {
          const finalText = (Array.isArray(ev.message.content) ? ev.message.content : []).filter((c: any) => c?.type === 'text').map((c: any) => c.text).join('')
          if (finalText) {
            // 用最终文本覆盖 node.text（去重边界残留清理）；segments 末段同步校正
            const lastTextSeg = [...segs].reverse().find(s => s.type === 'text')
            if (lastTextSeg && node.text.endsWith(lastTextSeg.text)) lastTextSeg.text = finalText
            else if (!lastTextSeg) segs.push({ type: 'text', text: finalText } as SubSegment)  // 后端合成收尾帧（失败/空回复轮 live 无 delta）：补正文段防占位（0904）
            node.text = finalText
          }
          if (ev.message.model) sa.model = ev.message.model
        }
        break
      case 'tool_execution_start':
        if (ev.toolName && !sa.tools.some(x => x.name === ev.toolName && x.status === 'running')) {
          sa.tools.push({ name: ev.toolName, status: 'running' })
          const last = segs[segs.length - 1]
          // toolcall_start 可能已建了同名段：避免重复
          if (!(last && last.type === 'tool' && last.name === ev.toolName && last.status === 'running')) {
            segs.push({ type: 'tool', name: ev.toolName, status: 'running', toolCallId: ev.toolCallId || ('subseg:' + p.runId + ':' + segs.length), runId: p.runId } as any) /* [T6] ownership: runId + stable synthetic toolCallId */
          }
        }
        break
      case 'tool_execution_end': {
        const t = [...sa.tools].reverse().find(x => x.name === ev.toolName && x.status === 'running')
        const resultText = (Array.isArray(ev.result?.content) ? ev.result.content : []).filter((c: any) => c?.type === 'text').map((c: any) => c.text).join('\n').slice(0, 200)
        if (t) {
          t.status = ev.isError ? 'error' : 'done'
          t.result = resultText
        }
        const seg = [...segs].reverse().find(s => s.type === 'tool' && s.name === ev.toolName && s.status === 'running') as any
        if (seg) {
          seg.status = ev.isError ? 'error' : 'done'
          seg.result = resultText
        }
        break
      }
      case 'agent_end':
        // 失败态不被收尾帧覆盖（0904：单聊失败轮 error 帧先于 agent_end 到达，徽章须停在"失败"）
        if (sa.status !== 'error') sa.status = 'done'
        node.status = 'done'
        break
      case 'sub_plan':
        // 0910 反馈4：成员自己的执行清单（sub_plan 工具）——实时更新气泡里的清单
        if (Array.isArray(ev.plan)) sa.plan = ev.plan.map((x: any) => ({ text: String(x?.text || ''), done: !!x?.done }))
        break
      case 'agent_stats':
        // 终帧：usage/timing 挂到节点（SubAgentBlock 底部统计；刷新后从持久化恢复）
        if (ev.model) sa.model = ev.model
        if (ev.timing) node.turnTiming = ev.timing
        if (ev.usage) node.turnUsage = ev.usage
        if (sa.status !== 'error') sa.status = 'done'
        node.status = 'done'
        scheduleMemberPlanExpiry(sa)
        break
      case 'error':
        /* ★1004b：击杀/中止路径的 error 帧带 interrupted 标记 —— 被打断≠失败（琥珀≠红） */
        sa.status = (ev as any).interrupted ? 'interrupted' : 'error'
        node.status = 'done'
        scheduleMemberPlanExpiry(sa)
        // 成员失败原因（如网关限流）写进气泡：无正文段时补一条，避免停在"正在工作"占位误导（0904）
        if (!segs.some(s => s.type === 'text')) {
          const msg = String(ev.message || t('notice.memberModelFail')).slice(0, 300)
          segs.push({ type: 'text', text: msg } as SubSegment)
          if (!node.text) node.text = msg
        }
        break
    }
  }

  return { takeFoldAnchorMismatch, withdrawSteerNode, isWithdrawnSteer, markSettled, isOpening, nodes, asideVersion, getNodes, pushFailedUserMessage, setNodes, attachTurnMeta, loadHistory, restoreMemberChats, restoreBlackboardRuns, memberPlans, renumberMemberInstances, handleAgentEvent, handleSubagentEvent, beginAssistant, resumeStreamingPlaceholder, finalizeStreaming, handleLlmRetry, handleContextNotice, handleSessionNotice, attachAside, answerAside, markAnsweredByUser, wasAnsweredByUser, forgetAnsweredByUser, lastAgentEvent, thinkIdleUntil, isInjectedUserText }
})



/** ★0929f（ponytail 体检 P1）：text 块以配对思考块回显开头就剥掉——严格前缀、可多遍（与 server.ts 同步改）。
 *  旧"≥60% 模糊"档已删：切的是思考长度而非重合长度，会误删真正文（宁漏剥不误杀）。
 *  ponytail: 与 server.ts 的 stripThinkingEcho 为跨端双份，改一处必须同步另一处。 */
function stripThinkingEcho(text: string, reasoning: string): string {
  if (!text || !reasoning) return text
  let t = text
  for (let g = 0; g < 3; g++) {
    if (t.startsWith(reasoning)) {
      t = t.slice(reasoning.length).replace(/^\s+/, '')
      if (!t) break
    } else break
  }
  return t
}
/** 块序遍历：每个 text 块对照它**前一个**思考块做回显剥离（多段思考/正文交替也成立） */
function textPartsWithEchoStripped(content: any[]): string[] {
  const out: string[] = []
  let lastR = ''
  for (const c of Array.isArray(content) ? content : []) {
    if (c?.type === 'reasoning' && c.text) lastR = String(c.text)
    else if (c?.type === 'thinking' && c.thinking) lastR = String(c.thinking)
    else if (c?.type === 'text' && c.text) {
      const t = stripThinkingEcho(String(c.text), lastR)
      if (t) out.push(t)
    }
  }
  return out
}

function extractText(content: any[]): string {
  return textPartsWithEchoStripped(content).join('').trim()
}

/** 从消息 content 提取图片 dataUrl（pi image block {type:'image', data, mimeType} → dataURL） */
function extractImages(content: any[]): string[] {
  if (!Array.isArray(content)) return []
  return content
    .filter(c => c?.type === 'image' && c.data)
    .map(c => `data:${c.mimeType || 'image/png'};base64,${c.data}`)
}

/** 0908 三批：截图引用解析——details 带 shotRef（已落盘工作区 screenshots/）→ 拼 /api/workspace-file 出图 URL；
 *  兼容历史/无工作区回退的内联 dataUrl。live 与刷新同一条解析路径。 */
function resolveShotSrc(details: any, convId: string): string {
  const ref = typeof details?.shotRef === 'string' ? details.shotRef : ''
  if (ref) return `${BRIDGE_URL}/api/workspace-file?sessionId=${encodeURIComponent(convId)}&path=${encodeURIComponent(ref)}`
  const dataUrl = typeof details?.dataUrl === 'string' ? details.dataUrl : ''
  return dataUrl.startsWith('data:image/') ? dataUrl : ''
}

/** 工具执行结果 → 展示文本（AgentToolResult.content 提取 text 块，避免显示 JSON 外壳） */
function extractToolResult(result: any): string {
  if (result == null) return ''
  if (typeof result === 'string') return result
  const content = result.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const text = content.filter(c => c?.type === 'text').map(c => c.text).join('\n')
    return text.trim() || JSON.stringify(content)
  }
  return JSON.stringify(result)
}

function extractReasoning(content: any[]): string {
  /* ★0929d（bug2 排查顺手实锤）：原实现 for 循环里**首个** reasoning/thinking 块就 return ——
     一条消息常有十几个思考块（实测 msg#9 有 22 块），刷新/回看历史后 Think 行只剩第 1 块，
     其余思考凭空消失。改为收集**全部**思考块按序拼接（与流式端 asst.reasoning 的累积口径一致）。 */
  const parts: string[] = []
  for (const c of Array.isArray(content) ? content : []) {
    if (c?.type === 'reasoning' && c.text) parts.push(String(c.text))
    else if (c?.type === 'thinking' && c.thinking) parts.push(String(c.thinking))
  }
  return parts.join('\n\n')
}

/* ★ 0925o（实测"刷新一下，前面完成的思考计时没了"）：思考耗时本地持久化 ——
 * reasoningMs 原来只活在内存节点上，刷新/重建即丢。按「会话+消息时间戳」存 localStorage，
 * buildHistoryNodes 重建时恢复。量极小（一个数字/条），7 天自动过期。 */
export function saveThinkMs(convId: string, msgTime: number | undefined, ms: number) {
  if (!convId || !msgTime || !(ms > 0)) return
  try {
    localStorage.setItem(`nis-thinkms:${convId}:${msgTime}`, String(Math.round(ms)))
    const expire = Date.now() - 7 * 24 * 3600 * 1000
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i) || ''
      if (!k.startsWith('nis-thinkms:')) continue
      const ts = Number(k.split(':').pop()) || 0
      if (ts < expire) localStorage.removeItem(k)
    }
  } catch { /* ignore */ }
}
function loadThinkMs(convId: string, msgTime: number | undefined): number {
  if (!convId || !msgTime) return 0
  try { return Number(localStorage.getItem(`nis-thinkms:${convId}:${msgTime}`)) || 0 } catch { return 0 }
}

/* ★ 0925aa（需求的"发送失败用户气泡左边红叹号"）：失败消息**留在气泡里**（status:'error'），
 * 左侧红叹号标记、点击可重发 —— 消息永不消失（比退回输入框直观）。 */
export function pushFailedUserMessage(convId: string, text: string, images?: string[]) {
  /* 0927 netfix A1: same latent bug as reconcileLive (module-level export calling store-internal
     getNodes -> ReferenceError; also missing from store return map => pi.pushFailedUserMessage
     undefined) => the whole send-failure path exploded silently. Take the store instance explicitly. */
  const pi = usePiChatStore()
  const list = pi.getNodes(convId)
  /* ★0927 netfix（失败=一条）：优先把已存在的同文用户气泡（乐观/回显）就地标红，不叠第二条；
     幂等：同文已有失败气泡就不再增。 */
  const norm = (x: any) => String(x || '').replace(/\[\[图片:\d+\]\]/g, '').replace(/\[\[文件:[^\]]+\]\]/g, '').replace(/\s+/g, ' ').trim()
  const t = norm(text)
  const existing = [...list].reverse().find((n: any) => n.kind === 'user' && n.status !== 'error'
    && (n.text === text || (t && norm(n.text) === t)))
  if (existing) {
    existing.status = 'error'
    if (Array.isArray(images) && images.length) existing.images = images
    return
  }
  if (t && list.some((n: any) => n.kind === 'user' && n.status === 'error' && norm(n.text) === t)) return
  list.push({
    key: crypto.randomUUID(), kind: 'user', text: text || '', reasoning: '',
    status: 'error', time: Date.now(), images: Array.isArray(images) ? images : [],
  } as any)
}

/* ★ 0925ae（实测"工具过程块/权限卡实时丢、刷新才显示"）：**实时补缺** ——
 * 服务端还在跑时（不能整段覆盖流式节点），把断线窗口丢掉的帧**增量补回**：
 * ① 本地没有的 toolCall 块 → 补建工具节点（含结果）；② 未决审批卡 → 补挂 aside。
 * 不动任何流式中的文本/思考节点（实时流还在写的保持原样）。 */
export function reconcileLive(convId: string, hist: any) {
  /* ★0927 修（用户控制台一行警告抓到）：本函数是**模块级导出**，却直接调了 store 内部函数
     `getNodes` / `attachAside` ⇒ 一调用就 `ReferenceError: getNodes is not defined`。
     而它从 0925ae 写下起**从没被成功调用过**（唯一调用方写成了 `pi.reconcileLive`，方法不存在），
     这个 latent bug 被掩护到今天。这里显式取 store 实例再调（运行时 pinia 已就绪，安全）。 */
  const pi = usePiChatStore()
  const list = pi.getNodes(convId)
  const have = new Set(list.filter((n: any) => n.kind === 'tool' && n.callId).map((n: any) => String(n.callId)))
  const msgs: any[] = Array.isArray(hist?.messages) ? hist.messages : []
  for (const m of msgs) {
    for (const c of (Array.isArray(m?.content) ? m.content : [])) {
      if ((c?.type === 'toolCall' || c?.type === 'tool_use') && c.id && !have.has(String(c.id))) {
        have.add(String(c.id))
        list.push({
          key: crypto.randomUUID(), kind: 'tool', text: '', reasoning: '', status: 'done',
          callId: c.id, toolName: c.name, toolArgs: c.arguments ?? c.input, toolStatus: 'done',
        } as any)
      }
    }
  }
  /* 丢帧工具块的结果回填（内嵌 tool_result / 独立 toolResult 消息两种形态都认） */
  for (const m of msgs) {
    const blocks = Array.isArray(m?.content) ? m.content : []
    if (m?.role === 'toolResult' && m.toolCallId) {
      const tn = list.find((n: any) => n.kind === 'tool' && String(n.callId) === String(m.toolCallId))
      if (tn && !(tn as any).toolResult) {
        const rc: any = Array.isArray(m.content) ? m.content : []
        ;(tn as any).toolResult = extractText(rc)
        ;(tn as any).toolStatus = m.isError ? 'error' : 'done'
      }
    }
    for (const c of blocks) {
      if (c?.type === 'tool_result' && (c.toolUseId || c.toolCallId)) {
        const tn = list.find((n: any) => n.kind === 'tool' && String(n.callId) === String(c.toolUseId || c.toolCallId))
        if (tn && !(tn as any).toolResult) {
          let rc: any = c.content
          if (typeof rc === 'string') { try { rc = JSON.parse(rc) } catch { /* 文本直接用 */ } }
          ;(tn as any).toolResult = typeof rc === 'string' ? rc
            : extractText(Array.isArray(rc?.content) ? rc.content : (Array.isArray(rc) ? rc : [{ type: 'text', text: String(rc ?? '') }]))
          ;(tn as any).toolStatus = c.isError ? 'error' : 'done'
        }
      }
    }
  }
  /* ★0926 ①b（升级）：**正文缺口回填**。
     为什么需要：断流（判死重连）期间 socket 里已缓冲的 text/thinking delta 会随 cancel 丢掉，
     而本函数原先只补工具块/审批卡 ⇒ 界面正文永久缺一段（= 用户看到的「B 也中断了」）。
     三重护栏（防写错/防串轮）：
       ① 只动**最后一条** assistant 节点（★0927：`streaming` **或已定稿 `done`** 都要管 ——
          实测"回复完成、切过来却停在工具调用处、刷新后才有正文"就是"节点已定稿 → 旧代码不补"造成的）；
       ② 服务端文本必须**以本地文本为前缀**（证明是"同一段话在继续"）；
       ③ 服务端必须**更长**（更短一律以本地为准，绝不回退）。
     不满足条件就只打日志、不动数据。 */
  {
    const asst = [...list].reverse().find((n: any) => n.kind === 'assistant' && (n.status === 'streaming' || n.status === 'done'))
    if (asst) {
      const hasText = (c: any) => c?.type === 'text' && typeof c.text === 'string' && c.text.length > 0
      const lastAsst = [...msgs].reverse().find((m: any) => m?.role === 'assistant' && Array.isArray(m?.content) && m.content.some(hasText))
      if (lastAsst) {
        const srvText = extractText(lastAsst.content)
        const srvThink = extractReasoning(lastAsst.content)
        const localText = String(asst.text || '')
        const localThink = String(asst.reasoning || '')
        /* ★0927 R12（实测"发消息后上一轮回复正文先出现在本轮里、本轮回复跟着串后面"）：
           **时间戳防线** —— 原有护栏"服务端以本地为前缀"在本地文本为**空**时恒真
           （空串是任何文本的前缀）⇒ 新轮次刚起步（流式节点 text=''）时，会把服务端末条
           （上一轮回复）整段灌进本轮节点，之后 delta 接着拼 = 串轮。
          判据：服务端消息 ts 必须**不旧于**本节点创建时间（同轮/断流续传才允许回填）；
           服务端消息比节点还旧 ⇒ 它是上一轮的内容，一律不碰。留 1s 容差。 */
        const srvTs = Number((lastAsst as any)?.timestamp) || 0
        const nodeTs = Number((asst as any)?.time) || 0
        const sameOrNewerTurn = srvTs + 1000 >= nodeTs
        if (!sameOrNewerTurn) {
          console.warn(`[SSE-resync] 服务端末条早于本节点（上一轮内容），不串轮：srvTs=${srvTs} nodeTs=${nodeTs}`)
        } else if (srvText.length > localText.length && srvText.startsWith(localText.trim())) {
          console.warn(`[SSE-resync] 补回正文缺口：${localText.length} → ${srvText.length} 字符`)
          asst.text = srvText
        } else if (srvText.length > localText.length) {
          console.warn(`[SSE-resync] 服务端正文更长但非前缀，保守不覆盖（本地 ${localText.length} / 服务端 ${srvText.length}）`)
        }
        if (sameOrNewerTurn && srvThink.length > localThink.length && srvThink.startsWith(localThink.trim())) {
          console.warn(`[SSE-resync] 补回思考缺口：${localThink.length} → ${srvThink.length} 字符`)
          asst.reasoning = srvThink
        }
      }
    }
  }

  /* 未决审批卡补挂（重复 requestId 不挂） */
  const pending: any[] = Array.isArray(hist?.pendingApprovals) ? hist.pendingApprovals : []
  for (const pa of pending) {
    /* ★0929：判重字段统一（实时帧挂的卡带 request_id、回灌挂的带 requestId——原来只查后者，
       永远查不中实时卡，全靠 attachAside 内层兜底）。与 attachAside 同口径：两字段任一命中即算已挂。 */
    const _rid = String(pa?.requestId || '')
    const exists = list.some((n: any) => Array.isArray(n.asides) && n.asides.some((a: any) => String(a?.request_id || a?.requestId || '') === _rid))
    if (!exists) pi.attachAside(convId, { type: 'permission_prompt', request_id: pa.requestId, question: pa.question, tool: pa.tool, risk: pa.risk, options: pa.options })
  }
  /* ★0929：未决**询问卡**补挂 —— 旧实现只有审批卡回灌，询问卡只在 openConversation 全量路
     才恢复："本地有节点走增量对账"的会话切走再切回会丢询问卡。配合"卡只在看着的窗口挂"
     新口径，这条是切换后卡能重新出现的唯一保障。同 requestId 去重口径。 */
  const pendingQs: any[] = Array.isArray(hist?.pendingQuestions) ? hist.pendingQuestions : []
  for (const pq of pendingQs) {
    const _qid = String(pq?.requestId || '')
    const existsQ = list.some((n: any) => Array.isArray(n.asides) && n.asides.some((a: any) => String(a?.request_id || a?.requestId || '') === _qid))
     if (!existsQ) pi.attachAside(convId, { type: 'ask_user', request_id: pq.requestId, question: pq.question, questions: pq.questions, options: pq.options, placeholder: pq.placeholder })
  }
}

/** [T4b] (knife 4b) run.t -> insert index at the end of the turn block the run started in
 *  (right before the next real user bubble; no owning turn / no time -> list end = arrival order).
 *  Timestamps are used only to pick the turn; node ordering is carried by seq (== list order). */
function turnEndAnchorIndex(list: PiNode[], runT: number): number {
  if (!runT) return list.length
  let anchorUser = -1
  for (let i = 0; i < list.length; i++) {
    const n = list[i] as any
    if (n.kind !== 'user' || n.dm) continue
    const tm = Number(n.time) || 0
    if (!tm || tm <= runT) anchorUser = i
    else break
  }
  if (anchorUser < 0) return list.length
  for (let j = anchorUser + 1; j < list.length; j++) {
    const m = list[j] as any
    if (m.kind === 'user' && !m.dm) return j
  }
  return list.length
}

/* [T6] (knife 6) collect tool callIds owned by a clone run (from run.segments.toolCallId) */
function runToolCallIds(run: any): Set<string> {
  const ids = new Set<string>()
  const segs: any[] = Array.isArray(run && run.segments) ? run.segments : []
  for (const s of segs) {
    if (s && s.type === 'tool' && s.toolCallId) ids.add(String(s.toolCallId))
  }
  return ids
}
/* [T6] retract scattered clone tool nodes from the main timeline into the clone bubble.
   Live path already keeps clone tools inside the bubble (session/subagent-event -> sa.tools/segments);
   on history rebuild the same calls were also rebuilt as main-list tool nodes => duplicates outside
   the bubble. Match by callId against run.segments.toolCallId, drop the main-list node and backfill
   its result into the owning segment (run.segments is the very array the bubble renders). */
function retractRunTools(list: PiNode[], run: any): number {
  const ids = runToolCallIds(run)
  if (!ids.size) return 0
  const segs: any[] = Array.isArray(run && run.segments) ? run.segments : []
  let moved = 0
  for (let i = list.length - 1; i >= 0; i--) {
    const n = list[i] as any
    if (n.kind !== 'tool' || !n.callId || !ids.has(String(n.callId))) continue
    const seg = segs.find((s: any) => s && s.type === 'tool' && String(s.toolCallId || '') === String(n.callId))
    if (seg) {
      if (!seg.result && n.toolResult) seg.result = String(n.toolResult).slice(0, 200)
      if (n.toolStatus === 'error') seg.status = 'error'
    }
    list.splice(i, 1)
    moved++
  }
  return moved
}

function findLast<T>(arr: T[], pred: (x: T) => boolean): T | undefined {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (pred(arr[i])) return arr[i]
  }
  return undefined
}

/** ★0927 修（实测"正文/Think 整段消失、只剩工具调用"）：原判据太松——
 *  「包含关系」+ bigram Jaccard≥0.75 就把**上一段正文整段抹掉**（实测抹了 816 字）。
 *  同一轮里两段不同内容但用词接近（反复解释同一件事、模板化措辞）就会误判；
 *  尤其"后者更短却是前者子串"时，长的那段反而被抹 ⇒ 用户看到内容凭空消失、刷新又回来
 *  （刷新走历史重建所以一定好）；正文被抹后 turn 组装还会把工具块顶成正文（看着像乱码）。
 *  现在**只认"前者是后者的前缀"**（前者更短、后者以它开头）= 真正的"先说半截又整段重说"。
 *  （"重复推送相同增量"由 delta 级去重 lastTextDelta 覆盖，不需要更松的判据。） */
function isNearDuplicate(a: string, b: string): boolean {
  const na = a.replace(/\s+/g, ''), nb = b.replace(/\s+/g, '')
  if (na.length < 60 || nb.length < 60) return false
  if (na.length < nb.length && nb.startsWith(na)) return true
  return false
}