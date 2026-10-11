import { defineStore } from 'pinia'
import { ref } from 'vue'
import { formatElementTagToken } from '../utils/elementTag'
import { BRIDGE_URL } from '../utils/bridgeUrl'
import { authHeaders } from '@/utils/nisToken'
import { swallowed } from '@/utils/swallowed'

interface ChatMessage {
  type: string
  request_id?: string
  question?: string
  options?: string[]
  tool?: string
  risk?: 'low' | 'medium' | 'high'
  placeholder?: string
  [key: string]: any
}

interface ContentItem {
  id: string
  type: 'text' | 'tag'
  content: string
  metadata?: {
    tagType: 'element' | 'box' | 'draw' | 'image'
    selector?: string
    tagName?: string
    text?: string
    rect?: { x: number; y: number; w: number; h: number }
    paths?: Array<Array<{ x: number; y: number }>>
    fileName?: string
    fileSize?: number
    dataUrl?: string
    mimeType?: string
  }
}

export const useChatStore = defineStore('chat', () => {
  const contentItems = ref<ContentItem[]>([])
  const pendingText = ref('')
  const wsConnected = ref(false)
  // 多 handler：不同模块（聊天窗口 / 日志流）可各自订阅消息并按 type 过滤
  let messageHandlers: Array<(msg: ChatMessage) => void> = []

  function setPendingText(text: string) {
    pendingText.value = text
  }

  function addText(text: string) {
    if (!text) return
    contentItems.value.push({
      id: 'item-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
      type: 'text',
      content: text
    })
  }

  function addTag(tag: Omit<ContentItem, 'id' | 'type'>, tagId?: string) {
    if (pendingText.value.trim()) {
      addText(pendingText.value.trim())
      pendingText.value = ''
    }
    contentItems.value.push({
      ...tag,
      // 与输入框 DOM 标签的 data-tag-id 保持一致（否则 getStructuredContent 匹配不到 → 图片/标注丢失）
      id: tagId || ('tag-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6)),
      type: 'tag'
    })
  }

  function removeItem(id: string) {
    contentItems.value = contentItems.value.filter(item => item.id !== id)
  }

  function moveItem(fromIndex: number, toIndex: number) {
    const items = contentItems.value
    if (fromIndex < 0 || fromIndex >= items.length || toIndex < 0 || toIndex >= items.length) return
    const [moved] = items.splice(fromIndex, 1)
    items.splice(toIndex, 0, moved)
  }

  function setContentItems(items: ContentItem[]) {
    contentItems.value = items
  }

  function clearInput() {
    contentItems.value = []
    pendingText.value = ''
  }

  function getPlainText(): string {
    const parts = contentItems.value.map(item => {
      if (item.type === 'text') return item.content
      if (item.metadata?.tagType === 'element') {
        // 0914：选中元素标签 → 完整 token（选择器 + 文件内精确坐标 + 来源文件/路径；与 ChatInput 发送路径同源）
        return formatElementTagToken(item.metadata)
      }
      if (item.metadata?.tagType === 'box') {
        const r = item.metadata.rect
        return `[box:${r ? `x${r.x}_y${r.y}_w${r.w}_h${r.h}` : ''}|${item.content}]`
      }
      if (item.metadata?.tagType === 'draw') {
        return `[draw:${item.metadata.paths?.length || 0}笔|${item.content}]`
      }
      return item.content
    })
    if (pendingText.value.trim()) {
      parts.push(pendingText.value.trim())
    }
    return parts.join('')
  }

  function getStructuredMessage() {
    const items = contentItems.value.map(item => {
      if (item.type === 'text') return { type: 'text', content: item.content }
      return { type: 'tag', content: item.content, metadata: item.metadata }
    })
    if (pendingText.value.trim()) {
      items.push({ type: 'text', content: pendingText.value.trim() })
    }
    return items
  }

  function setInputText(text: string) {
  contentItems.value = text ? [{ id: 'item-' + Date.now(), type: 'text', content: text }] : []
  }

  // Flash selection in preview when tag is clicked
  const flashSelection = ref<any>(null)

  // Pending tag to insert at cursor (set by RightPanel, consumed by ChatInput)
  const pendingInsert = ref<{ content: string; metadata: any } | null>(null)

  function requestInsertTag(content: string, metadata: any) {
    pendingInsert.value = { content, metadata }
  }

  function consumeInsert(): { content: string; metadata: any } | null {
    const val = pendingInsert.value
    pendingInsert.value = null
    return val
  }

  /* ── 0918：外部预置「整段文案」到输入框 ──────────────────────────────
   * 与 pendingInsert 不同：pendingInsert 是插标签（文件/技能 chip），这里要放的是多行纯文本
   * （例如「导入其他 Agent 数据」的引导词）。
   * 起因：SettingsModal.startAgentImport 以前直接写 contentItems，而输入框实际是 contenteditable，
   * ChatInput 从不回读 contentItems → 引导词永远不显示。
   * 现在走 store →（会话切换后）ChatInterface 调 ChatInput.insertText() 的正规通道。
   *
   * ★ 0919 修（实测：引导词跑到了**别的对话**里）：
   *   以前只有一个裸字符串，而且只在「会话切换」那一刻消费。而 SettingsModal 是
   *   `await openConversation(...)` **之后**才 requestPrefill —— 切换那次已经消费过了（拿到空），
   *   于是文案一直挂在 store 里，**等用户下次切会话时才被塞进那条会话**。
   *   现在带「目标会话 id」，并允许 ChatInterface 监听 store 变化即时落地（不再依赖切换时机）。 */
  const pendingPrefill = ref<{ text: string; convId: string } | null>(null)
  function requestPrefill(text: string, convId = '') {
    const s = String(text || '')
    pendingPrefill.value = s ? { text: s, convId: String(convId || '') } : null
  }
  /** 取走待预置文案：只在「没指定目标会话」或「就是当前会话」时取走，否则留给它归属的那条会话 */
  function consumePrefill(convId = ''): string {
    const v = pendingPrefill.value
    if (!v) return ''
    if (v.convId && v.convId !== String(convId || '')) return ''
    pendingPrefill.value = null
    return v.text
  }
  let flashTimeout: ReturnType<typeof setTimeout> | null = null

  function triggerFlash(metadata: any) {
    if (flashTimeout) clearTimeout(flashTimeout)
    flashSelection.value = metadata
    flashTimeout = setTimeout(() => {
      flashSelection.value = null
    }, 1500)
  }

  let eventSource: EventSource | null = null
  let abortCtrl: AbortController | null = null
  let sessionAbortCtrl: AbortController | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  /* ★ 0922：host 流（/api/events.host）—— 后端 host 帧的唯一出口，此前前端没连 ⇒ 全丢 */
  let hostAbortCtrl: AbortController | null = null
  let hostReconnectTimer: ReturnType<typeof setTimeout> | null = null
  let sessionReconnectTimer: ReturnType<typeof setTimeout> | null = null
  /** 当前已订阅的会话 id；'' = 未订阅（草稿态，无会话） */
  let sessionKey = ''

  function muxUrl(sessionId: string): string {
    /* ★1012al：**SSE 必须把 token 拼进 URL** —— EventSource 带不了请求头（`x-nis-token` 用不上），
       而远程访问时后端按 Host 判为外部来源、无 token 直接 403。
       症状（实测"手机端对话流渲染问题"）：**事件流 403 ⇒ 对话流收不到任何帧 ⇒ 不渲染/不更新**，
       console 里满屏 `Failed to load resource: 403 (Forbidden)`。
       注意 `utils/nisToken.ts` 早有 `withToken()` 就是为这种场景写的，但全项目从未调用过 —— 这里内联拼，
       与 `nisToken.ts` 同源（同一 `?token=`），零 import 依赖。 */
    let tok = ''
    try { tok = new URLSearchParams(window.location.search).get('token') || '' } catch { /* 非浏览器环境 */ }
    const base = sessionId
      ? `${BRIDGE_URL}/api/events.mux?sessionId=${encodeURIComponent(sessionId)}`
      : `${BRIDGE_URL}/api/events.mux`
    return tok ? `${base}${base.includes('?') ? '&' : '?'}token=${encodeURIComponent(tok)}` : base
  }

  /** ★0926 止血：轻量健康探针（只在"判死"前用）。3s 超时；任何异常=返回 false → 走原重连逻辑。
   *  为什么需要它：后端主线程被同步重活堵住时，本流的 15s 保活 ping 也会一起迟到，
   *  旧逻辑会直接判死重连 → 重连补账（resyncAfterReconnect）会把正在流式的气泡定稿/覆盖，
   *  表现就是用户看到的「A 报错，正在跑的 B 也中断了」。探针能把"后端忙"和"流真死"分开。 */
  async function probeBackendAlive(): Promise<boolean> {
    try {
      const r = await fetch(`${BRIDGE_URL}/api/ping`, { cache: 'no-store', signal: AbortSignal.timeout(3000), headers: authHeaders() })
      if (!r.ok) return false
      const j: any = await r.json().catch(() => null)
      return !!(j && j.ok)
    } catch {
      return false
    }
  }

  /** 解析一条 mux SSE 流；onDown 在流中断（非主动 abort）时回调，由调用方安排重连 */
  function pumpMuxStream(res: Response, label: string, onDown: () => void): void {
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    let lastAt = Date.now()
    let stopped = false
    /* 0917b（网页端「卡住不回」）——服务端每 15s 发一次 `: ping` 保活。
     *  若 45s 内一个字节都没到（含 ping），说明这条 TCP 半死/被中间层静默丢弃：
     *  浏览器不会报错、reader.read() 会永远挂着 → 界面一直停在「回复中」，
     *  只有手动刷新才恢复（刷新重新建连 + 拉历史）。这里补客户端侧死活检测：
     *  超时即主动断开并交给调用方重连。阈值取 3 个 ping（45s），避免后端长阻塞时误杀。 */
    const STALL_MS = 45000
    /* ★0926 ①a（升级·判死策略）：**唯一死因 = socket 自身报错**。
       旧行为的病：45s 没数据就 cancel + 重连 ⇒ 把 socket 里已缓冲、还没读的 delta 一起丢掉，
       而重连补账（reconcileLive）不补正文 ⇒ 界面永久缺口 = 用户看到的「B 也中断了」。
       新行为：45s 没数据只**提示 + 探针一次**，**不 cancel、不重连**；真正判死交给
       pump 的 .catch / done（socket 自己的死亡信号）。
       另设 HARD_STALL_MS：半死 TCP 在系统层面可能永不报错（这是物理事实，必须明确一个边界），
       到点才强制重连。
       ★0929（实测"后端重启后实时帧断供好几分钟"）：两处收紧——
       ① 探针**失败**（后端根本不可达）时不再死等：此时 socket 已无价值，立即重连；
          探针**成功**（后端忙/网络抖动）才继续等待（保住缓冲 delta 的初衷不变）。
       ② 硬上限 600s → 180s：主线程最长实测阻塞是秒级，10 分钟的死窗只会把
          "卡思考态/权限卡不弹"拖成灾难；且 0926①b 之后 reconcileLive 已会补正文缺口，
          重连的代价比死等低得多。 */
    const HARD_STALL_MS = 180000
    let probing = false
    let lastWarnAt = 0
    const watchdog = window.setInterval(() => {
      if (stopped) return
      const idle = Date.now() - lastAt
      if (idle <= STALL_MS) return
      if (idle > HARD_STALL_MS) {
        stopped = true
        window.clearInterval(watchdog)
        console.warn(`[SSE] ${label} 连续 ${Math.round(idle / 1000)}s 无数据，超过硬上限(${HARD_STALL_MS / 1000}s) → 强制重连`)
        try { void reader.cancel() } catch { /* ignore */ }
        onDown()
        return
      }
      if (probing) return
      if (Date.now() - lastWarnAt < 15000) return
      lastWarnAt = Date.now()
      probing = true
      void probeBackendAlive().then((alive) => {
        probing = false
        if (stopped) return
        if (!alive) {
          /* ★0929：探针失败 = 后端不可达（多半是重启/挂了），这条流已不可能再有数据 —— 立即重连。
             原实现这里也"继续等待"，遇上后端重启就是几分钟实时帧全断（思考卡死/权限卡不弹）。 */
          console.warn(`[SSE] ${label} 已 ${Math.round(idle / 1000)}s 无数据且探针未应答 → 判死重连`)
          stopped = true
          window.clearInterval(watchdog)
          try { void reader.cancel() } catch { /* ignore */ }
          onDown()
          return
        }
        console.warn(`[SSE] ${label} 已 ${Math.round(idle / 1000)}s 无数据：后端存活（忙/网络抖动）→ 继续等待，不重连`)
      }).catch(() => { probing = false })
    }, 5000)
    const finish = (): void => {
      if (stopped) return
      stopped = true
      window.clearInterval(watchdog)
    }
    const pump = (): void => {
      reader.read().then(({ done, value }) => {
        if (done) { finish(); throw new Error('SSE closed') }
        lastAt = Date.now()
        buf += decoder.decode(value, { stream: true })
        let nl: number
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl)
          buf = buf.slice(nl + 1)
          if (line.startsWith('data: ')) {
            try {
              const frame = JSON.parse(line.slice(6).trim())
              for (const handler of messageHandlers) handler(frame)
            } catch (e) { swallowed('SSE 帧解析失败，该帧已跳过（界面可能少一次更新）', e) }
          }
        }
        pump()
      }).catch(() => { finish(); onDown() })
    }
    pump()
    void label
  }

  /* 0917b：SSE（重）连成功后的「补账」钩子。
   *  断线期间结束的回合不会重放终态帧（尤其 session/status running=false），
   *  重连只是重新订阅、不补历史 → 界面会一直卡在「回复中」，只有手动刷新才恢复。
   *  这里在「重连」（同一流第 2 次及以后连上）时通知上层，主动向服务端对齐一次状态。 */
  const resyncHandlers: Array<() => void> = []
  function onResync(fn: () => void): void { resyncHandlers.push(fn) }
  function offResync(fn: () => void): void {
    const i = resyncHandlers.indexOf(fn)
    if (i >= 0) resyncHandlers.splice(i, 1)
  }
  function fireResync(): void {
    for (const h of resyncHandlers) { try { h() } catch (e) { swallowed('重连补账 handler 抛错（该项补账被跳过，界面可能停在旧状态）', e) } }
  }
  /** 每条流已成功连上的次数（key：'global' / sessionId）——>0 表示本次是重连 */
  const streamConnCount = new Map<string, number>()
  function markConnected(key: string): boolean {
    const n = streamConnCount.get(key) || 0
    streamConnCount.set(key, n + 1)
    return n > 0
  }

  /**
   * 连接 bridge SSE（fetch 手动解析）。
   * 不用 EventSource：其原生自动重连与手动重连叠加会产生双连接，
   * 导致后端事件被广播两份、前端节点重复（"发一条出多条"的根因）。
   *
   * 0911 帧按会话订阅：拆成两条独立流——
   *   ① 全局流（无 sessionId）：收跨会话帧（浏览器动作/预览/帧推送）与会话状态镜像；
   *   ② 会话流（带 sessionId）：只收当前会话自己的帧（消息/日志/计划/投影）。
   * 两条各自重连，切换会话只需重订会话流（全局流稳定不动）。
   */
  function connect(_wsUrl?: string) {
    connectGlobalStream()
    connectHostStream()
    connectSessionStream(sessionKey)
  }

  /** ★ 0922 补：host 流。后端 hostClients（/api/events.host）是设置变更/会话增删等
   *  host 帧的唯一出口；前端此前只连了 /api/events.mux，没人连 host ⇒ hostClients 恒空
   *  ⇒ 那些帧全部丢掉，表现是"要切窗口/刷新才更新"（如切供应商）。
   *  这里照全局流的写法补一条（含断线重连），帧仍走 pumpMuxStream 逐帧派发给 handlers。 */
  function connectHostStream() {
    if (hostAbortCtrl) hostAbortCtrl.abort()
    if (hostReconnectTimer) clearTimeout(hostReconnectTimer)
    hostAbortCtrl = new AbortController()
    const signal = hostAbortCtrl.signal
    fetch(`${BRIDGE_URL}/api/events.host`, { signal, headers: authHeaders() })
      .then((res) => {
        if (!res.ok || !res.body) throw new Error(`host SSE status ${res.status}`)
        console.log('[SSE] Connected to bridge host stream')
        if (markConnected('host')) fireResync()
        pumpMuxStream(res, 'host', () => {
          if (signal.aborted) return
          hostReconnectTimer = setTimeout(() => connectHostStream(), 1500)
        })
      })
      .catch(() => {
        if (signal.aborted) return
        hostReconnectTimer = setTimeout(() => connectHostStream(), 1500)
      })
  }

  function connectGlobalStream() {
    if (abortCtrl) abortCtrl.abort()
    if (reconnectTimer) clearTimeout(reconnectTimer)
    abortCtrl = new AbortController()
    const signal = abortCtrl.signal
    wsConnected.value = false

    fetch(muxUrl(''), { signal, headers: authHeaders() })
      .then((res) => {
        if (!res.ok || !res.body) throw new Error(`SSE status ${res.status}`)
        wsConnected.value = true
        console.log('[SSE] Connected to bridge mux (global)')
        window.dispatchEvent(new CustomEvent('nis-ws-connected'))
        // 重连（非首连）→ 通知上层补账：断线期间丢掉的终态帧不会重放
        if (markConnected('global')) fireResync()
        pumpMuxStream(res, 'global', () => {
          if (signal.aborted) return
          wsConnected.value = false
          reconnectTimer = setTimeout(() => connectGlobalStream(), 1500)
        })
      })
      .catch(() => {
        if (signal.aborted) return
        wsConnected.value = false
        reconnectTimer = setTimeout(() => connectGlobalStream(), 1500)
      })
  }

  function connectSessionStream(sessionId: string) {
    sessionKey = sessionId || ''
    if (sessionAbortCtrl) sessionAbortCtrl.abort()
    if (sessionReconnectTimer) clearTimeout(sessionReconnectTimer)
    if (!sessionKey) return
    sessionAbortCtrl = new AbortController()
    const signal = sessionAbortCtrl.signal

    fetch(muxUrl(sessionKey), { signal, headers: authHeaders() })
      .then((res) => {
        if (!res.ok || !res.body) throw new Error(`SSE status ${res.status}`)
        console.log('[SSE] Connected to bridge mux (session)', sessionKey)
        // 重连（非首连）→ 该会话很可能有断线期间结束的回合没收到终态帧，补账
        if (markConnected('session:' + sessionKey)) fireResync()
        pumpMuxStream(res, 'session', () => {
          if (signal.aborted) return
          sessionReconnectTimer = setTimeout(() => connectSessionStream(sessionKey), 1500)
        })
      })
      .catch(() => {
        if (signal.aborted) return
        sessionReconnectTimer = setTimeout(() => connectSessionStream(sessionKey), 1500)
      })
  }

  /** 切换活跃会话时重订会话流（同会话重复调用为幂等空操作） */
  function subscribeSession(sessionId: string) {
    const next = String(sessionId || '')
    if (next === sessionKey) return
    connectSessionStream(next)
  }

  function disconnect() {
    if (reconnectTimer) clearTimeout(reconnectTimer)
    if (sessionReconnectTimer) clearTimeout(sessionReconnectTimer)
    if (abortCtrl) abortCtrl.abort()
    if (hostReconnectTimer) clearTimeout(hostReconnectTimer)
    if (hostAbortCtrl) hostAbortCtrl.abort()
    if (sessionAbortCtrl) sessionAbortCtrl.abort()
    if (eventSource) eventSource.close()
    eventSource = null
    sessionKey = ''
    wsConnected.value = false
  }

  /** Send a message via bridge API (session.prompt)；skills = 消息置入的技能标签（触发后端 use_skill 引导）；
   *  attachments = 图片附件（dataUrl）多模态；mode = 工作模式（default/plan/build）——随消息带走，避免"刚切模式就发消息"读到旧值 */
  // 0907 A+B：最近一次 sendMessage 被后端拒绝的具体原因（如图片闸门「模型不支持图片输入」），
  // 供调用方替换通用"发送失败"文案——后端错误文本不落地就白做闸门提示
  const lastSendError = ref('')
  async function sendMessage(sessionId: string, message: string, effort?: string, skills?: string[], attachments?: Array<{ name: string; dataUrl: string }>, model?: { provider: string; model_id: string; base?: string }, mode?: string): Promise<boolean> {
    lastSendError.value = ''
    try {
      const res = await fetch(`${BRIDGE_URL}/api/session.prompt`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders() },
        signal: AbortSignal.timeout(30 * 60 * 1000),  /* 0927 netfix: session.prompt resolves only after the WHOLE turn finishes;
           the old 30s cap false-failed every long reply (red ! + later reply). 30min = turn-level bound. */
        body: JSON.stringify({
          type: 'client-request',
          rpcId: crypto.randomUUID(),
          method: 'session.prompt',
          payload: { sessionId, message, effort, skills, attachments: attachments && attachments.length ? attachments : undefined, model, mode },
        }),
      })
      if (!res.ok) {
        console.error('[Chat] sendMessage failed:', res.status)
        return false
      }
      const data = await res.json()
      if (data.result?.ok === false) {
        console.error('[Chat] sendMessage error:', data.result.error)
        lastSendError.value = String(data.result?.error || '')
        return false
      }
      return true
    } catch (e: any) {
      console.error('[Chat] sendMessage exception:', e)
      /* ★0927：超时也给明确文案（后端忙时入队响应会迟到；超时≠没发出去，文案让用户知道先确认） */
      lastSendError.value = e?.name === 'TimeoutError' ? '后端响应超时（可能正忙），请确认消息是否已发出再重试' : ''
      return false
    }
  }

  /** 成员单聊（0904）：用户 @某团队成员 1:1 对话，走 session.memberPrompt。
   *  成功 true / 校验失败（非团队、成员不存在、无工作区等）false（错误经 SSE/日志侧呈现）。 */
  async function sendMemberMessage(sessionId: string, memberId: string, message: string): Promise<boolean> {
    try {
      const v = await bridgeRpc('session.memberPrompt', { sessionId, memberId, message })
      return v?.ok !== false
    } catch (e) {
      console.error('[Chat] sendMemberMessage failed:', e)
      return false
    }
  }

  /** 通用 bridge RPC：POST /api/{method}，返回 result.value。失败抛错。
   *  ★0927（需求要求"前后端都不可以出问题"）：**加超时** —— SSE 侧早有 45s 软/600s 硬死活边界，
   *   RPC 侧原来是 ∞：后端主线程被同步重活堵死时（0926 止血轮实测发生过）fetch 永远不返回 ⇒
   *  session.history 挂起=骨架屏永久停、compactNow 挂起=调用方永久等待、刷新设置挂起=转圈不停。
   *  对标 codex/hermes：RPC 层必须有边界。默认 30s；已知慢的调用（压缩摘要要走模型）由调用方传更大值。 */
  async function bridgeRpc(method: string, payload: Record<string, any> = {}, timeoutMs = 30000): Promise<any> {
    let res: Response
    try {
      res = await fetch(`${BRIDGE_URL}/api/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders() },
        signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify({
          type: 'client-request',
          rpcId: crypto.randomUUID(),
          method,
          payload,
        }),
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

  function onMessage(handler: (msg: ChatMessage) => void) {
    messageHandlers.push(handler)
  }

  function offMessage(handler: (msg: ChatMessage) => void) {
    messageHandlers = messageHandlers.filter(h => h !== handler)
  }

  /** bridge RPC：权限审批应答（HITL_REQUEST 的选择） */
  async function sendHitlResponse(request_id: string, choice: string, sessionId?: string) {
    const sid = sessionId || (window as any).__nisActiveSessionId || ''
    try {
      await fetch(`${BRIDGE_URL}/api/session.approval`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders() },
        signal: AbortSignal.timeout(15000), /* ★0927：HITL 应答不能无声沉没（后端忙时 15s 兜底） */
        body: JSON.stringify({
          type: 'client-request',
          rpcId: crypto.randomUUID(),
          method: 'session.approval',
          payload: { sessionId: sid, requestId: request_id, choice },
        }),
      })
    } catch (e) {
      console.error('[Chat] sendHitlResponse failed:', e)
    }
  }

  /** bridge RPC：权限模式切换（confirm/self_audit/full_access） */
  async function sendPermissionMode(mode: string, sessionId?: string) {
    const sid = sessionId || (window as any).__nisActiveSessionId || ''
    try {
      await fetch(`${BRIDGE_URL}/api/session.setPermission`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders() },
        signal: AbortSignal.timeout(15000), /* ★0927：HITL 应答不能无声沉没（后端忙时 15s 兜底） */
        body: JSON.stringify({
          type: 'client-request',
          rpcId: crypto.randomUUID(),
          method: 'session.setPermission',
          payload: { sessionId: sid, mode },
        }),
      })
    } catch (e) {
      console.error('[Chat] sendPermissionMode failed:', e)
    }
  }

  /** bridge RPC：工作模式切换（0920；default=默认 / plan=计划 / build=构建 / goal=目标·未实装）。
   *  后端只把它转成一段随消息注入的行为指令（见 server.ts buildModeHint），不动 systemPrompt。 */
  async function sendMode(mode: string, sessionId?: string) {
    const sid = sessionId || (window as any).__nisActiveSessionId || ''
    try {
      await fetch(`${BRIDGE_URL}/api/session.setMode`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders() },
        signal: AbortSignal.timeout(15000), /* ★0927：HITL 应答不能无声沉没（后端忙时 15s 兜底） */
        body: JSON.stringify({
          type: 'client-request',
          rpcId: crypto.randomUUID(),
          method: 'session.setMode',
          payload: { sessionId: sid, mode },
        }),
      })
    } catch (e) {
      console.error('[Chat] sendMode failed:', e)
    }
  }

  /** bridge RPC：询问卡应答（QUESTION_ANSWER → session.questionAnswer）。
   *  ★0930：返回**是否真的送达并被后端受理** —— 旧版吞掉一切失败，界面显示"已提交"而
   *  ask_user 的 promise 还挂着（答题卡卡死实测现场），调用方必须据此决定要不要落"已答"态。 */
  async function sendQuestionAnswer(request_id: string, value: string, sessionId?: string): Promise<boolean> {
    const sid = sessionId || (window as any).__nisActiveSessionId || ''
    try {
      const res = await fetch(`${BRIDGE_URL}/api/session.questionAnswer`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders() },
        signal: AbortSignal.timeout(15000), /* ★0927：HITL 应答不能无声沉没（后端忙时 15s 兜底） */
        body: JSON.stringify({
          type: 'client-request',
          rpcId: crypto.randomUUID(),
          method: 'session.questionAnswer',
          payload: { sessionId: sid, requestId: request_id, value },
        }),
      })
      if (!res.ok) return false
      const data = await res.json().catch(() => null)
      return data?.result?.ok !== false
    } catch (e) {
      console.error('[Chat] sendQuestionAnswer failed:', e)
      return false
    }
  }

  // 测试钩子：直接注入一条 WS 消息给已注册 handler（CDP 端到端验证用）
  function dispatchTest(msg: ChatMessage) {
    for (const handler of messageHandlers) handler(msg)
  }

  return {
    contentItems,
    pendingText,
    pendingInsert,
    flashSelection,
    triggerFlash,
    wsConnected,
    lastSendError,
    setPendingText,
    addText,
    addTag,
    removeItem,
    moveItem,
    setContentItems,
    clearInput,
    getPlainText,
    getStructuredMessage,
    setInputText,
    requestInsertTag,
    consumeInsert,
    pendingPrefill,
    requestPrefill,
    consumePrefill,
    connect,
    disconnect,
    subscribeSession,
    sendMessage,
    sendMemberMessage,
    bridgeRpc,
    onMessage,
    offMessage,
    onResync,
    offResync,
    dispatchTest,
    sendHitlResponse,
    sendPermissionMode,
    sendMode,
    sendQuestionAnswer
  }
})
