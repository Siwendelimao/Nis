import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { useChatStore } from './chat'

type BgTaskStatus = 'background' | 'paused' | 'completed' | 'cancelled' | 'failed'

interface BgTaskStep {
  id: string
  label: string
  status: 'active' | 'done' | 'pending'
}

type BgRecordKind = 'system' | 'progress' | 'result' | 'summary' | 'user' | 'ai'

interface BgTaskRecord {
  id: string
  time: string
  /** 创建时间戳（过程块计时用） */
  ts: number
  /** 发送者 key：伙伴英文 id（Luna/TestPilot/Auditor...）或 'Nis' / 'user' */
  senderKey: string
  content: string
  kind: BgRecordKind
  /** 细分明细（有则记录可在气泡上展开查看） */
  detail?: string[]
  /** 富内容块（与原对话 AI 消息一致：文本/markdown/代码/图片/任务列表...），有则替代纯文本渲染 */
  blocks?: Array<{ type: string; content: string; [key: string]: any }>
  /** 是否为最新内容（流式结束后置 true，渲染最终形态） */
  settled?: boolean
  /** 过程块状态（与原对话 AI 消息 processStates 一致：thinking/search/tools/review/write → active/done） */
  processStates?: Record<string, 'active' | 'done'>
  /** 过程块展开后的子项（key = 过程名，value = 子项列表） */
  processDetail?: Record<string, string[]>
  /** Thinking 的推理过程：自由流动文本（非结构化，与原对话 thinkingContent 一致） */
  thinkingText?: string
}

export interface BackgroundTask {
  task_id: string
  title: string
  status: BgTaskStatus
  /** 所属会话：后台任务 tab 只出现在派发它的会话窗口里 */
  conversationId: number | string
  steps: BgTaskStep[]
  records: BgTaskRecord[]
  /** 完成后「查看结果」写入：在原对话渲染可溯源的气泡 */
  result?: string
  resultDelivered: boolean
  created_at: number
  /** 演示仿真的计时器句柄（老 demo 留下的字段，保留以免外部引用炸） */
  _timers: ReturnType<typeof setTimeout>[]
  /* ── 0920 新增：真实后端字段的镜像 ── */
  kind?: 'command' | 'download'
  command?: string
  cwd?: string
  url?: string
  dest?: string
  /** 进度（download 有百分比；command 只有备注） */
  percent?: number
  progressNote?: string
  speedBps?: number
  etaSec?: number
  exitCode?: number
  error?: string
  finishedAt?: number
  /** ★ 0922c-7（Q2）：AI 自报过进度（bg_note）→ 面板会画读条或显示一行说明 */
  progressReported?: boolean
  /** ★ 0922c-10（A）：预计总时长（秒）→ 面板画浅色「预计」时间条 */
  estSec?: number
}

function nowTime(ts?: number): string {
  const d = new Date(ts || Date.now())
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/**
 * 后台任务 store —— **backend/backgroundTasks.ts 的镜像**（0920 起接真数据）。
 *
 * 产品设计（已与产品对齐，别再改口径）：
 *   - 每个后台任务一个小胶囊 tab，贴在输入框上方；**只出现在派发它的会话里**
 *   - 任务的进度/记录只进它自己的视图，不混入原对话
 *   - 完成后原对话里出现可溯源的结果气泡，点进去看完整运行记录
 *
 * 数据来源：
 *   · 拉：`bg.list` RPC（打开会话 / 首次加载时同步一次）
 *   · 推：host 帧 `bg/updated`（后端进度变化时推一条 task）→ applyBackendTask()
 *   · 停：`bg.stop`；清理：`bg.clear`
 *
 * ⚠️ 之前这里是一整套 **demo 仿真**（startDemo + 定时器编剧本，假伙伴名、假步骤）。
 *    0920 删掉了 —— 留着会让人以为后台任务已经能用，实际跑的是假数据。
 */
export const useTasksStore = defineStore('tasks', () => {
  const tasks = ref<BackgroundTask[]>([])

  const runningCount = computed(
    () => tasks.value.filter(t => t.status === 'background' || t.status === 'paused').length,
  )

  /** 某会话的后台任务（胶囊 tab 数据源）。会话 id 前端是 number|string，统一按字符串比。 */
  function tasksForConversation(convId: number | string): BackgroundTask[] {
    const key = String(convId)
    /* ★ 0922c-3：**稳定顺序**（task_id 兜底）——
       原来直接返回数组顺序，而数组会被"单条推送/整表同步"两条路径来回改写，
       下载任务每秒推一次进度 ⇒ 行在列表里反复跳（实测"上下乱窜"）。
       ★ 0930（需求）：改为**最新创建的排前面**（升序时代找新任务要翻底，反直觉）。 */
    return tasks.value
      .filter(t => String(t.conversationId) === key)
      .sort((a, b) => (b.created_at - a.created_at) || String(b.task_id).localeCompare(String(a.task_id)))
  }

  function getTask(taskId: string): BackgroundTask | undefined {
    return tasks.value.find(t => t.task_id === taskId)
  }

  /* ── 后端映射 ── */

  /** 后端 BgTask → 前端 BackgroundTask（结构对齐，UI 不用改） */
  function mapBackendTask(b: any): BackgroundTask {
    const steps: BgTaskStep[] = Array.isArray(b.steps)
      ? b.steps.map((s: any) => ({ id: String(s.id), label: String(s.label), status: s.status }))
      : []
    const records: BgTaskRecord[] = (Array.isArray(b.records) ? b.records : []).map((r: any) => ({
      id: String(r.id),
      time: nowTime(r.ts),
      ts: Number(r.ts) || Date.now(),
      senderKey: 'Nis',
      content: String(r.content || ''),
      kind: r.kind === 'result' ? 'result' : r.kind === 'system' ? 'system' : 'progress',
      detail: Array.isArray(r.detail) ? r.detail : undefined,
      settled: true,
    }))
    const finished = b.status !== 'background' && b.status !== 'paused'
    return {
      task_id: String(b.task_id),
      title: String(b.title || '后台任务'),
      status: (b.status || 'background') as BgTaskStatus,
      conversationId: b.conversationId,
      steps,
      records,
      result: b.result || undefined,
      // 结束即视为"有结果可看" → 原对话渲染可溯源气泡（点进去看完整记录）
      resultDelivered: finished,
      created_at: Number(b.createdAt) || Date.now(),
      _timers: [],
      kind: b.kind,
      command: b.command,
      cwd: b.cwd,
      url: b.url,
      dest: b.dest,
      percent: typeof b.progress?.percent === 'number' ? b.progress.percent : undefined,
      progressNote: b.progress?.note,
      speedBps: b.progress?.speedBps,
      etaSec: b.progress?.etaSec,
      exitCode: b.exitCode,
      error: b.error || undefined,
      finishedAt: b.finishedAt,
      progressReported: b.progressReported === true,
      estSec: Number(b.estSec) > 0 ? Number(b.estSec) : undefined,
    }
  }

  /** ★ 0922：按 task_id 去重（保留最后一条）——重复 key 会让 Vue patch 崩溃（实测见 console） */
  function dedupeById(list: BackgroundTask[]): BackgroundTask[] {
    const m = new Map<string, BackgroundTask>()
    for (const t of list) if (t && t.task_id) m.set(String(t.task_id), t)
    return [...m.values()]
  }

  /** 整表同步（按会话过滤；不传 = 全部）
   *  ⚠️ **必须保留 `preview_` 前缀的本地预览数据**：那些是 /bg-demo 注入的纯前端假任务，
   *  后端不知道它们；一开始没保住，展开胶囊触发的同步就把预览冲掉了（胶囊直接消失）。 */
  async function syncFromBackend(conversationId?: number | string): Promise<void> {
    try {
      const chatStore = useChatStore()
      const r: any = await chatStore.bridgeRpc('bg.list', conversationId != null ? { conversationId: String(conversationId) } : {})
      const list = Array.isArray(r?.tasks) ? r.tasks : []
      const mapped = list.map(mapBackendTask)
      const isPreview = (t: BackgroundTask) => t.task_id.startsWith('preview_')
      if (conversationId != null) {
        // 只覆盖本会话的，别的会话的镜像保持不动
        const key = String(conversationId)
        const others = tasks.value.filter(t => !isPreview(t) && String(t.conversationId) !== key)
        const previews = tasks.value.filter(t => isPreview(t) && String(t.conversationId) === key)
        tasks.value = dedupeById([...others, ...mapped, ...previews])
      } else {
        tasks.value = dedupeById([...mapped, ...tasks.value.filter(isPreview)])
      }
    } catch (e) {
      console.warn('[tasks] 同步后台任务失败:', e)
    }
  }

  /** 单条推送（host 帧 bg/updated）：有就更新，没有就补进来 */
  function applyBackendTask(b: any): void {
    if (!b || !b.task_id) return
    const mapped = mapBackendTask(b)
    /* ★ 0922：先剔除同 task_id 的旧条目（可能有重复），再更新或追加 —— 保证 key 唯一 */
    /* ★ 0922c-3：但必须**原地更新**（原来"剔除+追加"会把该条挪到数组末尾 —— 下载每秒推一次进度，
       于是它不停跳到列表底部，表现为"上下乱窜"）。 */
    const i = tasks.value.findIndex(t => String(t.task_id) === String(mapped.task_id))
    if (i >= 0) tasks.value.splice(i, 1, mapped)
    else tasks.value = dedupeById([...tasks.value, mapped])
  }

  /** 停掉一个后台任务（后端树杀子进程） */
  async function stopTask(taskId: string): Promise<void> {
    try {
      const chatStore = useChatStore()
      await chatStore.bridgeRpc('bg.stop', { taskId })
      await syncFromBackend()
    } catch (e) { console.warn('[tasks] 停止失败:', e) }
  }

  /** ★ 0922c-3：暂停/继续下载（后端掐流/续流） */
  async function pauseTask(taskId: string): Promise<void> {
    try {
      const chatStore = useChatStore()
      await chatStore.bridgeRpc('bg.pause', { taskId })
      await syncFromBackend()
    } catch (e) { console.warn('[tasks] 暂停失败:', e) }
  }
  async function resumeTask(taskId: string): Promise<void> {
    try {
      const chatStore = useChatStore()
      await chatStore.bridgeRpc('bg.resume', { taskId })
      await syncFromBackend()
    } catch (e) { console.warn('[tasks] 继续失败:', e) }
  }

  /** 读任务末尾输出（任务视图里"查看输出"用） */
  async function readOutput(taskId: string, lines = 200): Promise<string> {
    try {
      const chatStore = useChatStore()
      const r: any = await chatStore.bridgeRpc('bg.read', { taskId, lines })
      return r?.ok ? String(r.text || '') : ''
    } catch { return '' }
  }

  /** 清掉已结束的任务（不传 = 全清已结束的） */
  async function clearFinished(ids?: string[]): Promise<void> {
    try {
      const chatStore = useChatStore()
      await chatStore.bridgeRpc('bg.clear', ids?.length ? { ids } : {})
      const list = tasks.value.filter(t => t.status === 'background' || t.status === 'paused')
      tasks.value = list
    } catch (e) { console.warn('[tasks] 清理失败:', e) }
  }

  /* ── 兼容层：老 API 保留（ChatInterface 还在用），行为对齐真实数据 ── */

  function closeTask(taskId: string) {
    const t = getTask(taskId)
    if (t) for (const timer of t._timers) clearTimeout(timer)
    tasks.value = tasks.value.filter(x => x.task_id !== taskId)
    // 真数据在后端也清一份（否则下次同步又回来了）
    void clearFinished([taskId])
  }

  function clearAll() {
    tasks.value = []
    void clearFinished()
  }

  /** 任务视图里的输入框：给后台任务追加一行本地记录（要跟 AI 说话请回原会话） */
  function appendRecord(taskId: string, record: Omit<BgTaskRecord, 'id' | 'time' | 'ts'>) {
    const t = getTask(taskId)
    if (!t) return
    const prev = t.records[t.records.length - 1]
    if (prev && prev.blocks?.length) prev.settled = true
    t.records.push({ ...record, id: `bgrec-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, time: nowTime(), ts: Date.now(), settled: false })
  }

  function updateStep(taskId: string, stepId: string, status: BgTaskStep['status']) {
    const t = getTask(taskId)
    const step = t?.steps.find(s => s.id === stepId)
    if (step) step.status = status
  }

  /** 结果可见（后端完成时已置 resultDelivered；这里留给"手动点查看结果"的路径） */
  function deliverResult(taskId: string) {
    const t = getTask(taskId)
    if (!t) return
    t.resultDelivered = true
  }

  function updateStatus(taskId: string, status: BgTaskStatus) {
    const t = getTask(taskId)
    if (!t) return
    // 只有"停止"能映到后端；其余状态由后端说了算
    if (status === 'cancelled') void stopTask(taskId)
    else t.status = status
  }

  /* ── 样式预览（/bg-demo）：只注入本地假数据，绝不写后端 ──
   * 要求看面板长什么样就得有"正在下载/正在跑的长命令/已完成"三种态，
   * 真跑一遍太慢，所以给一组带 `preview_` 前缀的假任务（UI 上会打「预览」标）。 */
  let previewSeq = 0
  function startPreview(convId: number | string): void {
    previewSeq += 1
    const now = Date.now()
    const steps3 = (a: BgTaskStep['status'], b: BgTaskStep['status'], c: BgTaskStep['status']): BgTaskStep[] => [
      { id: 's1', label: '连接', status: a },
      { id: 's2', label: '下载 / 执行', status: b },
      { id: 's3', label: '收尾', status: c },
    ]
    const rec = (kind: BgTaskRecord['kind'], content: string, detail?: string[], ts?: number): BgTaskRecord => ({
      id: `pv${previewSeq}-${Math.random().toString(36).slice(2, 6)}`, time: nowTime(ts), ts: ts || now, senderKey: 'Nis', kind, content, detail, settled: true,
    })
    const mk = (o: Partial<BackgroundTask>): BackgroundTask => ({
      task_id: `preview_${previewSeq}_${Math.random().toString(36).slice(2, 6)}`,
      title: '预览任务', status: 'background', conversationId: convId,
      steps: [], records: [], resultDelivered: false, created_at: now, _timers: [],
      ...o,
    })
    const dl = mk({
      title: '下载 sherpa-onnx 语音模型（229MB）', kind: 'download',
      url: 'https://hf-mirror.com/…/model.int8.onnx', dest: 'D:\\…\\env\\voice\\models\\sensevoice\\model.int8.onnx',
      progressNote: '下载 model.int8.onnx', percent: 34, speedBps: 4.2 * 1048576, etaSec: 36,
      created_at: now - 52_000,
      steps: steps3('done', 'active', 'pending'),
      records: [
        rec('system', '已挂到后台下载：model.int8.onnx', ['来源 https://hf-mirror.com/…', '保存到 D:\\…\\env\\voice\\models\\sensevoice\\model.int8.onnx'], now - 52_000),
        rec('progress', '已下载 12.4MB / 229MB', [], now - 40_000),
        rec('progress', '已下载 78.1MB / 229MB（4.2MB/s）', [], now - 15_000),
      ],
    })
    /* ★ 0922c-13：这条故意做成**持续挂机类**样例（无进度、无预计、无步骤）→ 面板只显示"名称+计时" */
    const cmd = mk({
      title: 'npm install（前端依赖）', kind: 'command', command: 'npm install',
      progressNote: '执行中…', percent: -1, created_at: now - 3 * 60_000 - 24_000,
      steps: [],
      records: [
        rec('system', '已挂到后台执行：npm install', ['工作目录 D:\\nis0812\\frontend'], now - 3 * 60_000 - 24_000),
        rec('progress', 'added 412 packages in 2m', [], now - 40_000),
      ],
    })
    const ok = mk({
      title: '下载发布包并校验 SHA256', kind: 'download', status: 'completed',
      percent: 100, progressNote: '已完成', created_at: now - 4 * 60_000, finishedAt: now - 2 * 60_000,
      result: '已下载 68.4MB → D:\\…\\NIS_Setup_0.0.11_x64.exe',
      steps: steps3('done', 'done', 'done'),
      records: [rec('result', '已下载 68.4MB → D:\\…\\NIS_Setup_0.0.11_x64.exe', [], now - 2 * 60_000)],
    })
    const fail = mk({
      title: '构建 cargo（release）', kind: 'command', status: 'failed',
      percent: -1, progressNote: '失败：退出码 1', created_at: now - 9 * 60_000, finishedAt: now - 7 * 60_000,
      error: '退出码 1。末尾输出：error: could not compile `nis-ui`',
      steps: steps3('done', 'active', 'pending'),
      records: [rec('result', '退出码 1。末尾输出：error: could not compile `nis-ui`', [], now - 7 * 60_000)],
    })
    const stop = mk({
      title: '测试下载 1MB 文件（已停止）', kind: 'download', status: 'cancelled',
      url: 'https://example.com/1mb.bin', dest: 'D:\\…\\1mb.bin.part',
      percent: 43, progressNote: '已停止', created_at: now - 11 * 60_000, finishedAt: now - 10 * 60_000,
      result: '已被手动取消',
      steps: steps3('done', 'done', 'done'),
      records: [rec('result', '已被手动取消', [], now - 10 * 60_000)],
    })
    const paused = mk({
      title: '下载模型（已暂停）', kind: 'download', status: 'paused',
      url: 'https://hf-mirror.com/…/model.onnx', dest: 'D:\\…\\model.onnx',
      percent: 57, progressNote: '已暂停', speedBps: 0, etaSec: 0,
      created_at: now - 6 * 60_000,
      steps: steps3('done', 'active', 'pending'),
      records: [
        rec('progress', '已下载 12.1MB / 21MB', [], now - 4 * 60_000),
        rec('progress', '已暂停下载', [], now - 3 * 60_000),
      ],
    })
    const cmdProg = mk({
      title: '构建 cargo（release · 8 步）', kind: 'command', command: 'cargo build --release',
      percent: 62, progressReported: true, progressNote: '编译 nis-ui（第 5/8 步）',
      created_at: now - 8 * 60_000,
      steps: steps3('done', 'active', 'pending'),
      records: [
        rec('system', '已挂到后台执行：cargo build --release', ['工作目录 D:\\nis0812\\src-tauri'], now - 8 * 60_000),
        rec('progress', '37% · 编译 nis-core（第 3/8 步）', [], now - 6 * 60_000),
        rec('progress', '62% · 编译 nis-ui（第 5/8 步）', [], now - 2 * 60_000),
      ],
    })
    const estOnly = mk({
      title: '压测（预计 10 分钟）', kind: 'command', command: 'node bench.mjs',
      percent: -1, estSec: 600, progressNote: '脚本自己会跑完，没有中间进度',
      created_at: now - 3 * 60_000 - 20_000,
      steps: [],
      records: [rec('system', '已挂到后台执行：node bench.mjs', [], now - 3 * 60_000 - 20_000)],
    })
    const stepOnly = mk({
      title: '发布流程（5 步）', kind: 'command', command: './release.ps1',
      percent: -1, progressReported: true, progressNote: '',
      created_at: now - 12 * 60_000,
      steps: [
        { id: 's1', label: '环境检查', status: 'done' },
        { id: 's2', label: '拉取依赖', status: 'done' },
        { id: 's3', label: '构建产物', status: 'active' },
        { id: 's4', label: '签名打包', status: 'pending' },
        { id: 's5', label: '生成发布说明', status: 'pending' },
      ],
      records: [rec('system', '已挂到后台执行：./release.ps1', [], now - 12 * 60_000)],
    })
    tasks.value = [...tasks.value.filter((t) => !t.task_id.startsWith('preview_')), dl, cmd, cmdProg, estOnly, stepOnly, ok, fail, stop, paused]
  }

  /** 去掉预览数据（id 传数组 = 只删这些；不传 = 全删） */
  function dropPreview(ids?: string | string[]): void {
    const kill = ids == null ? null : new Set(Array.isArray(ids) ? ids : [ids])
    tasks.value = tasks.value.filter((t) => !t.task_id.startsWith('preview_') || (kill ? !kill.has(t.task_id) : false))
  }

  return {
    tasks,
    runningCount,
    tasksForConversation,
    getTask,
    syncFromBackend,
    applyBackendTask,
    pauseTask,
    resumeTask,
    stopTask,
    readOutput,
    clearFinished,
    closeTask,
    clearAll,
    appendRecord,
    updateStep,
    deliverResult,
    updateStatus,
    startPreview,
    dropPreview,
  }
})
