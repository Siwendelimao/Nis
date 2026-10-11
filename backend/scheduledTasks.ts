/**
 * 定时任务（0912 十二批）—— 到点让 AI 在指定会话里跑一段 prompt。
 *
 * 设计取向（对齐 NIS「会话即一切」的模型）：
 *   · 任务 = 名称 + 一段 prompt + 调度规则 + 目标会话
 *   · 执行走 `runPromptCore`（与手打消息同一条路径），结果**落在会话里** —— 打开对话就能看到
 *   · 不用 rrule 字符串，改用**结构化字段**（kind/interval/time/weekdays/dayOfMonth）：
 *     免依赖库 + 前端表单直接映射，不让用户手写 cron
 *
 * 落盘：data/scheduled-tasks.json（原子写）
 * 调度：setInterval 每 30s 扫一次到期任务（单进程本地服务，不需要分布式锁）
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { DATA_ROOT } from './paths.ts'
import { loadJsonOrBackup, persistJson } from './jsonStore.ts'

const FILE = path.join(DATA_ROOT, 'scheduled-tasks.json')
/** 扫描间隔：30s。任务粒度是分钟，够用且不浪费 */
const TICK_MS = 30_000

type TaskKind = 'once' | 'hourly' | 'daily' | 'weekly' | 'monthly'

export interface TaskSchedule {
  kind: TaskKind
  /** 仅 once：ISO 时间串（如 2026-09-13T09:00） */
  at?: string
  /** hourly/daily/weekly/monthly：每 N 个周期（默认 1） */
  interval?: number
  /** daily/weekly/monthly：'HH:mm' */
  time?: string
  /** weekly：周几（0=周日 … 6=周六） */
  weekdays?: number[]
  /** monthly：几号（1-28，>28 会被夹到 28，避免 2 月缺日） */
  dayOfMonth?: number
}

/**
 * 任务完成后的推送目标（0912 十三批）—— 通道 + 机器人 + 对端。
 *
 * 为什么存 peerId 而不是 sessionId：推送要发到**具体某个 IM 对端**（QQ 某台机器人的某个用户 / 微信账号），
 * 而推送完成后该对端的后续消息会自动落到任务的**专属会话**（映射切换，见 server 的 notifyTaskResult）。
 */
export interface TaskNotifyTarget {
  /**
   * 推送位置：
   *   'qq' | 'wechat' —— 某个 IM 对端（穿插通知：推一条带任务名的消息，但**不抢**你当前对话的落点）
   *   'list'          —— **列表通知**（0912 十九批）：不推 IM，只在对话列表里留一条带 ⏰ 的支线
   */
  channel: 'qq' | 'wechat' | 'list'
  botId: string
  peerId: string
  /** 消息场景（私聊/群聊）—— 决定 QQ 发送端点（/v2/users 还是 /v2/groups） */
  kind?: 'c2c' | 'group' | 'channel'
  /** 展示用标签（前端回显，后端不参与逻辑） */
  label?: string
}

export interface ScheduledTask {
  id: string
  name: string
  /** 到点发给 AI 的内容 */
  prompt: string
  /**
   * 目标会话：
   *   'own'（默认）—— **任务专属会话**：首次执行时自动创建（标题带 ⏰），跨次复用，
   *                  上下文连续、会话列表不堆积（用户拍板：「每个任务就是一条专属会话」）
   *   'new'        —— 每次执行新建一个会话
   *   '<sessionId>'—— 固定落进某个已有会话
   */
  targetSessionId: string
  /** 专属会话 id（targetSessionId === 'own' 且**没有通知目标**时用；跨次复用） */
  ownSessionId?: string
  /**
   * 每个通知目标各自的专属会话（0912 十七批）—— key = `${channel}:${botId}:${peerId}`。
   *
   * 为什么必须按目标拆开（用户实测 bug）：一条任务可以同时推「微信 + 群A + 群B」，
   * 若它们共用一条会话，**历史会互相污染** —— 用户在微信里回一句「ok」，
   * AI 却接上了 QQ 群里别人的话题（因为那条会话里躺着群聊记录）。
   * 拆开之后：哪个通道的通知就落在哪个通道的会话里，互不可见。
   */
  ownSessions?: Record<string, string>
  /** 执行会话 id（= 首个通知目标的专属会话；卡片「查看结果」直接开它） */
  execSessionId?: string
  /** 执行完成后通过哪些通道推送结果（可多选；空/未设 = 不推送） */
  notifyTargets?: TaskNotifyTarget[]
  /**
   * 任务用的模型（0912 用户拍板）。
   *   'global'（默认）—— 用「设置 → 人格 → 全局模型」；全局模型未选 → 执行时**明确报错**，不静默兜底。
   *   'custom'        —— 用 modelId/modelProviderId 指定的自选模型。
   *  未设（老数据）= 'global'。
   */
  modelMode?: 'global' | 'custom'
  /** modelMode='custom' 时的模型 id */
  modelId?: string
  /** modelMode='custom' 时的供应商 id */
  modelProviderId?: string
  /**
   * 自选模型的推理强度（F轮 2026-09-12）：fast/deep/heavy/burning；空 = 跟随模型默认。
   * modelMode='global' 时忽略此值（用全局强度 activeEffort）。
   */
  modelEffort?: string
  schedule: TaskSchedule
  enabled: boolean
  createdAt: number
  updatedAt: number
  /** 下次执行时间（0=不再执行，如 once 已过期） */
  nextRunAt: number
  lastRunAt?: number
  lastStatus?: 'ok' | 'error' | 'running'
  lastError?: string
  /** 最近一次执行落在哪个会话（列表里可直接点开看结果） */
  lastSessionId?: string
  runCount: number
}

interface StoreShape { version: number; tasks: ScheduledTask[] }
let cache: StoreShape | null = null
let ticking = false
let timer: NodeJS.Timeout | null = null
/* ★ 0927 第 0 批：文件损坏降级标志（degraded 期间禁止把空表写回盘覆盖用户数据） */
let tasksDegraded = false

function load(): StoreShape {
  if (cache) return cache
  /* ★ 0927 第 0 批：共享 jsonStore —— ENOENT 才回落空表；内容损坏先备份 .corrupt-* 再回落并标记
     degraded。（旧逻辑：任何失败 console.warn 后回退空表 → 下一次 persist 就把空表固化成权威
     → 一次文件损坏=全部定时任务丢失且无感知。体检 P0，家族①病根。） */
  const r = loadJsonOrBackup<any>(FILE, () => ({ version: 1, tasks: [] }))
  const shapeOk = !!r.data && typeof r.data === 'object' && Array.isArray(r.data.tasks)
  /* schema 级损坏（JSON 合法但结构不对）同样按降级处理：触发空表回写保护 + 明确日志 */
  tasksDegraded = r.degraded || (r.data != null && !shapeOk)
  if (tasksDegraded && !r.degraded) console.error('[scheduledTasks] 文件结构异常（tasks 不是数组），按降级处理：', FILE)
  if (shapeOk) {
    cache = { version: 1, tasks: r.data.tasks }
    return cache
  }
  cache = { version: 1, tasks: [] }
  return cache
}

function persist(): void {
  const data = load()
  /* ★ 0927 第 0 批：原子写（tmp 带 pid+随机防并发互截）+ degraded 空表拒绝回写。
     旧逻辑：固定 tmp 名 + 无降级保护 —— 损坏回落空表后，任何一次 refreshAllNextRun/
     任务回写都会把空表 rename 覆盖磁盘，用户任务被永久抹掉。 */
  persistJson(FILE, data, { degraded: tasksDegraded, isEmpty: () => data.tasks.length === 0 })
}

/** 'HH:mm' → [h, m]（非法值回退 09:00） */
function parseTime(s?: string): [number, number] {
  const m = String(s || '').match(/^(\d{1,2}):(\d{2})$/)
  if (!m) return [9, 0]
  const h = Math.min(23, Math.max(0, parseInt(m[1], 10)))
  const mi = Math.min(59, Math.max(0, parseInt(m[2], 10)))
  return [h, mi]
}

/**
 * 算下一次执行时间。
 * @param from 基准时间（默认 now）
 * @returns 时间戳；0 = 不再执行（once 已过期 / 规则为空）
 */
function computeNextRunAt(s: TaskSchedule, from: number = Date.now(), createdAt = 0): number {
  const iv = Math.max(1, Math.floor(s.interval || 1))
  switch (s.kind) {
    case 'once': {
      const t = s.at ? Date.parse(s.at) : 0
      return Number.isFinite(t) && t > from ? t : 0
    }
    case 'hourly': {
      const d = new Date(from)
      d.setMinutes(0, 0, 0)
      d.setHours(d.getHours() + iv)
      return d.getTime()
    }
    case 'daily': {
      const [h, m] = parseTime(s.time)
      const d = new Date(from)
      d.setHours(h, m, 0, 0)
      if (d.getTime() <= from) d.setDate(d.getDate() + iv)
      return d.getTime()
    }
    case 'weekly': {
      const wd = (Array.isArray(s.weekdays) && s.weekdays.length) ? s.weekdays : [1]
      const [h, m] = parseTime(s.time)
      const step = iv * 7
      /* ★1003 批次4 4.36/4.37 双修：
       * ① 原 i 从 1（明天）起扫 —— 今天正是配置星期且时刻未到也轮空，直接推到下周（最多七天）；
       *    改 i=0 起，靠 `> from` 守卫自然排除已过的时刻。
       * ② "每 N 周"原按 (d-from)/7d 算周序 —— 14 天窗口内只可能是 0/1，`0 % N === 0` 恒真
       *    ⇒ N>1 形同虚设（第一个匹配日必中）；改按**稳定纪元周序**取模（锚点不随 from 漂移），
       *    以任务创建周为基准，创建当周即"第 0 周"，符合直觉。 */
      /* ★1003 批次4 4.37 + 审计复核 #1（回归补修）：锚点取**任务创建周** —— 原写 `(s as any).createdAt`
       * 是错的：createdAt 在 ScheduledTask 上、不在 TaskSchedule 上，undefined||0 ⇒ 锚点恒 0、
       * "每 N 周"照旧不按创建周算（修复目标落空），`(s as any)` 还把类型错误盖住了。现由调用方
       * 以 createdAt 显式传入（类型可见，再错编译器会叫）。 */
      const epochWeek = (ms: number) => Math.floor(ms / (7 * 86400_000))
      const anchorWeek = epochWeek(Number(createdAt) || 0)
      for (let i = 0; i <= 14; i += 1) {
        const d = new Date(from)
        d.setDate(d.getDate() + i)
        d.setHours(h, m, 0, 0)
        if (d.getTime() > from && wd.includes(d.getDay())) {
          if (iv === 1) return d.getTime()
          if ((epochWeek(d.getTime()) - anchorWeek) % iv === 0) return d.getTime()
        }
      }
      // 兜底：至少给出 7 天后的同一时刻（防止规则异常导致任务永不触发）
      return from + step * 86400_000
    }
    case 'monthly': {
      const dom = Math.min(28, Math.max(1, Math.floor(s.dayOfMonth || 1)))
      const [h, m] = parseTime(s.time)
      const d = new Date(from)
      d.setDate(dom)
      d.setHours(h, m, 0, 0)
      if (d.getTime() <= from) {
        d.setMonth(d.getMonth() + iv)
        d.setDate(dom)
        d.setHours(h, m, 0, 0)
      }
      return d.getTime()
    }
  }
  return 0
}

/** 人类可读的周期描述（前端列表直接用，避免两边各写一套） */
export function describeSchedule(s: TaskSchedule): string {
  const iv = Math.max(1, Math.floor(s.interval || 1))
  const time = s.time || '09:00'
  const wdNames = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
  switch (s.kind) {
    case 'once': {
      if (!s.at) return '单次（未设时间）'
      const d = new Date(s.at)
      if (Number.isNaN(d.getTime())) return '单次（时间无效）'
      return `单次 · ${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    }
    case 'hourly':
      return iv === 1 ? '每小时' : `每 ${iv} 小时`
    case 'daily':
      return iv === 1 ? `每天 ${time}` : `每 ${iv} 天 ${time}`
    case 'weekly': {
      const wd = (Array.isArray(s.weekdays) && s.weekdays.length) ? s.weekdays.slice().sort((a, b) => a - b) : [1]
      const label = wd.map(d => wdNames[d] || '?').join('、')
      return `每${iv === 1 ? '' : ' ' + iv + ' '}周 ${label} ${time}`
    }
    case 'monthly':
      return iv === 1 ? `每月 ${s.dayOfMonth || 1} 号 ${time}` : `每 ${iv} 个月 ${s.dayOfMonth || 1} 号 ${time}`
  }
  return ''
}

/* ── CRUD ── */

export function listTasks(): ScheduledTask[] {
  return load().tasks.map(t => ({ ...t, schedule: { ...t.schedule } }))
    .sort((a, b) => (a.nextRunAt || Infinity) - (b.nextRunAt || Infinity))
}

function normalize(schedule: any): TaskSchedule {
  const kind: TaskKind = ['once', 'hourly', 'daily', 'weekly', 'monthly'].includes(schedule?.kind) ? schedule.kind : 'daily'
  const out: TaskSchedule = { kind }
  if (typeof schedule?.at === 'string') out.at = schedule.at
  if (schedule?.interval != null) out.interval = Math.max(1, Math.min(365, Math.floor(Number(schedule.interval) || 1)))
  if (typeof schedule?.time === 'string') out.time = schedule.time
  if (Array.isArray(schedule?.weekdays)) {
    out.weekdays = schedule.weekdays
      .map((x: any) => Math.floor(Number(x)))
      .filter((x: number) => Number.isInteger(x) && x >= 0 && x <= 6)
  }
  if (schedule?.dayOfMonth != null) out.dayOfMonth = Math.max(1, Math.min(28, Math.floor(Number(schedule.dayOfMonth) || 1)))
  return out
}

/** 通知目标归一化（去重 + 过滤非法值；上限 12 个，防误配） */
export function normalizeNotifyTargets(input: any): TaskNotifyTarget[] {
  if (!Array.isArray(input)) return []
  const out: TaskNotifyTarget[] = []
  const seen = new Set<string>()
  for (const raw of input) {
    const channel = String(raw?.channel || '').trim()
    if (channel !== 'qq' && channel !== 'wechat' && channel !== 'list') continue
    // 列表通知没有对端（它不属于任何 IM 账号）—— 单独一条，不参与去重键
    if (channel === 'list') {
      if (!seen.has('list')) {
        seen.add('list')
        out.push({ channel: 'list', botId: '', peerId: '', label: '列表通知' })
      }
      continue
    }
    const botId = String(raw?.botId || '').trim()
    const peerId = String(raw?.peerId || '').trim()
    if (!botId || !peerId) continue
    const key = `${channel}:${botId}:${peerId}`
    if (seen.has(key)) continue
    seen.add(key)
    const ch = channel as 'qq' | 'wechat'
    const kd = ['c2c', 'group', 'channel'].includes(String(raw?.kind)) ? (String(raw.kind) as 'c2c' | 'group' | 'channel') : undefined
    const label = String(raw?.label || '').trim()
    out.push({ channel: ch, botId, peerId, kind: kd, label: label || undefined })
  }
  return out.slice(0, 12)
}

export function createTask(input: {
  name?: string; prompt?: string; targetSessionId?: string; schedule?: any; enabled?: boolean; notifyTargets?: any
  modelMode?: 'global' | 'custom'; modelId?: string; modelProviderId?: string; modelEffort?: string
}): ScheduledTask {
  const data = load()
  const schedule = normalize(input.schedule)
  const now = Date.now()
  const task: ScheduledTask = {
    id: `task_${now.toString(36)}_${crypto.randomBytes(3).toString('hex')}`,
    name: String(input.name || '').trim() || '未命名任务',
    prompt: String(input.prompt || '').trim(),
    // 默认「任务专属会话」—— 未指定时不再每次新建（0912 十三批）
    targetSessionId: String(input.targetSessionId || '').trim() || 'own',
    notifyTargets: normalizeNotifyTargets(input.notifyTargets),
    modelMode: input.modelMode === 'custom' ? 'custom' : 'global',
    modelId: input.modelMode === 'custom' ? String(input.modelId || '').trim() || undefined : undefined,
    modelProviderId: input.modelMode === 'custom' ? String(input.modelProviderId || '').trim() || undefined : undefined,
    modelEffort: input.modelMode === 'custom' ? String(input.modelEffort || '').trim() || undefined : undefined,
    schedule,
    enabled: input.enabled !== false,
    createdAt: now,
    updatedAt: now,
    nextRunAt: computeNextRunAt(schedule, now, now),
    runCount: 0,
  }
  data.tasks.push(task)
  persist()
  return { ...task, schedule: { ...task.schedule } }
}

export function updateTask(id: string, patch: {
  name?: string; prompt?: string; targetSessionId?: string; schedule?: any; enabled?: boolean; notifyTargets?: any
  modelMode?: 'global' | 'custom'; modelId?: string; modelProviderId?: string; modelEffort?: string
}): ScheduledTask | null {
  const data = load()
  const t = data.tasks.find(x => x.id === id)
  if (!t) return null
  if (typeof patch.name === 'string' && patch.name.trim()) t.name = patch.name.trim()
  if (typeof patch.prompt === 'string') t.prompt = patch.prompt.trim()
  if (typeof patch.targetSessionId === 'string') t.targetSessionId = patch.targetSessionId.trim() || 'own'
  if (Array.isArray(patch.notifyTargets)) t.notifyTargets = normalizeNotifyTargets(patch.notifyTargets)
  if (patch.modelMode === 'global' || patch.modelMode === 'custom') {
    t.modelMode = patch.modelMode
    if (patch.modelMode === 'global') { t.modelId = undefined; t.modelProviderId = undefined; t.modelEffort = undefined }
  }
  if (patch.modelMode === 'custom') {
    if (typeof patch.modelId === 'string') t.modelId = patch.modelId.trim() || undefined
    if (typeof patch.modelProviderId === 'string') t.modelProviderId = patch.modelProviderId.trim() || undefined
  }
  // 强度独立于 modelMode：custom 可设；global 模式显式给值也照收（执行时忽略，避免切换模式即丢配置）
  if (typeof patch.modelEffort === 'string') {
    t.modelEffort = patch.modelEffort.trim() || undefined
  }
  if (patch.schedule) t.schedule = normalize(patch.schedule)
  if (typeof patch.enabled === 'boolean') t.enabled = patch.enabled
  t.updatedAt = Date.now()
  // 规则/启用态变了 → 重算下次执行（从"现在"起算，避免补跑历史欠账）
  /* 0927 netfix S4: only reschedule when schedule/enabled changed (renaming a task used to
     recompute from "now" and swallow the imminent run). */
  if (patch.schedule !== undefined || typeof patch.enabled === 'boolean') {
    t.nextRunAt = t.enabled ? computeNextRunAt(t.schedule, Date.now(), t.createdAt) : 0
  }
  persist()
  return { ...t, schedule: { ...t.schedule } }
}

/** 专属会话回写（server 调）：key 为空串 = 无目标时的任务会话；否则为某个通知目标的 key */
export function setOwnSession(taskId: string, key: string, sessionId: string): void {
  const data = load()
  const t = data.tasks.find(x => x.id === taskId)
  if (!t || !sessionId) return
  if (!key) {
    if (t.ownSessionId !== sessionId) { t.ownSessionId = sessionId; persist() }
    return
  }
  if (!t.ownSessions) t.ownSessions = {}
  if (t.ownSessions[key] === sessionId) return
  t.ownSessions[key] = sessionId
  persist()
}

/** 执行会话回写（= 首个目标的专属会话） */
export function setExecSession(taskId: string, sessionId: string): void {
  const data = load()
  const t = data.tasks.find(x => x.id === taskId)
  if (!t || !sessionId || t.execSessionId === sessionId) return
  t.execSessionId = sessionId
  persist()
}


export function removeTask(id: string): boolean {
  const data = load()
  const before = data.tasks.length
  data.tasks = data.tasks.filter(t => t.id !== id)
  if (data.tasks.length === before) return false
  persist()
  return true
}

/** 创建/更新后由 server 调：把"跟随当前时间"的下次执行点刷新一遍 */
function refreshAllNextRun(now: number = Date.now()): void {
  const data = load()
  let changed = false
  for (const t of data.tasks) {
    if (!t.enabled) { if (t.nextRunAt !== 0) { t.nextRunAt = 0; changed = true } continue }
    if (!t.nextRunAt || t.nextRunAt <= now) {
      const n = computeNextRunAt(t.schedule, now, t.createdAt)
      if (n !== t.nextRunAt) { t.nextRunAt = n; changed = true }
    }
  }
  if (changed) persist()
}

/* ── 调度循环 ── */

/** 执行器由 server 注入（避免本模块依赖 server，形成循环） */
type TaskRunner = (task: ScheduledTask, sessionId: string) => Promise<{ sessionId: string }>
let runner: TaskRunner | null = null
/** 目标会话不存在时由 server 建一个新会话并返回其 id */
let sessionResolver: ((task: ScheduledTask) => string) | null = null

export function setTaskRunner(fn: TaskRunner): void { runner = fn }
export function setTaskSessionResolver(fn: (task: ScheduledTask) => string): void { sessionResolver = fn }

/* ★1003 批次4 4.38：'running' 僵尸态复活 —— 启动时 persist 了 running、随后进程崩溃/runner
 * 永不 settle 时，lastStatus 永远卡 'running'，runTaskNow 与 tick **双双拒碰** = 任务永久死锁。
 * 超 30 分钟无下文视为陈尸，重置为可重跑（runningSince 缺失的旧记录拿 lastRunAt 兜）。 */
const RUNNING_STALE_MS = 30 * 60_000
function resetZombieRunning(t: ScheduledTask): boolean {
  if (t.lastStatus !== 'running') return true
  const since = Number((t as any).runningSince) || Number(t.lastRunAt) || 0
  if (since && Date.now() - since < RUNNING_STALE_MS) return false
  console.warn(`[scheduledTasks] 任务「${t.name}」的 running 已超 ${RUNNING_STALE_MS / 60000} 分钟无下文${since ? '' : '（且无时间戳）'}——判定为崩溃残留，重置可重跑`)
  t.lastStatus = 'error'
  t.lastError = '上次运行疑似中断（进程崩溃/悬挂），已自动重置可重跑'
  ;(t as any).runningSince = 0
  return true
}

/** 立刻执行一次（手动触发也走这里）；会推进 nextRunAt */
export async function runTaskNow(id: string): Promise<{ ok: boolean; error?: string; sessionId?: string }> {
  const data = load()
  const t = data.tasks.find(x => x.id === id)
  if (!t) return { ok: false, error: '任务不存在' }
  if (!runner || !sessionResolver) return { ok: false, error: '调度器未就绪' }
  /* ★1003 4.38：running 可能是崩溃残留的僵尸态 —— 超 30 分钟无下文自动重置后放行 */
  if (t.lastStatus === 'running' && !resetZombieRunning(t)) return { ok: false, error: '该任务正在执行中' }
  try {
    const sid = sessionResolver(t)
    if (!sid) return { ok: false, error: '无法确定目标会话' }
    t.lastStatus = 'running'
    ;(t as any).runningSince = Date.now()   // ★4.38：僵尸判据的时间戳
    t.lastError = ''
    t.lastSessionId = sid
    persist()
    await runner(t, sid)
    t.lastStatus = 'ok'
    ;(t as any).runningSince = 0
    t.lastRunAt = Date.now()
    t.runCount = (t.runCount || 0) + 1
    t.lastError = ''
    // 手动运行不改变原有排期（隔 1s 再算，避免正好落在当前这一刻被跳过）
    /* 0927 netfix S1: once must also reschedule -> zero after due (was: skip once =>
       nextRunAt stays in the past => tick refires every 30s forever; live-tested 4 runs / 150s).
       Manual run before due keeps original schedule (atMs in future => unchanged). */
    if (t.schedule.kind === 'once') {
      const atMs = Date.parse(String(t.schedule.at || ''))
      t.nextRunAt = t.enabled && Number.isFinite(atMs) && atMs > Date.now() + 1000 ? atMs : 0
    } else if (t.enabled) {
      t.nextRunAt = computeNextRunAt(t.schedule, Date.now() + 1000, t.createdAt)
    } else {
      t.nextRunAt = 0
    }
    persist()
    return { ok: true, sessionId: sid }
  } catch (e: any) {
    t.lastStatus = 'error'
    ;(t as any).runningSince = 0   // ★4.38：异常收尾同样清僵尸判据
    t.lastRunAt = Date.now()
    t.lastError = String(e?.message || e).slice(0, 300)
    /* ★1003 审计复核 #2：失败也必须**推进排期** —— 原来只改状态不动 nextRunAt，到期任务每 30s
     * 重新触发（重复跑 AI/重复推通知 = 重试风暴），一次性任务更成永久循环。与成功路径同款重算：
     * once → 过期即 0（不再自动触发，失败留给用户手动重跑）；周期 → 下一个匹配时刻。 */
    if (t.schedule.kind === 'once') {
      const atMs = Date.parse(String(t.schedule.at || ''))
      t.nextRunAt = t.enabled && Number.isFinite(atMs) && atMs > Date.now() + 1000 ? atMs : 0
    } else if (t.enabled) {
      t.nextRunAt = computeNextRunAt(t.schedule, Date.now() + 1000, t.createdAt)
    } else {
      t.nextRunAt = 0
    }
    persist()
    return { ok: false, error: t.lastError }
  }
}

/** 启动调度循环（幂等） */
export function startScheduler(): void {
  if (timer) return
  // 启动时先对齐一次（服务可能停了一阵子）
  try { refreshAllNextRun() } catch (e) { /* ★ 0927 第 0 批：定时刷新失败不能崩调用方，但必须可见 */
  console.error('[scheduledTasks] refreshAllNextRun failed:', e) }
  timer = setInterval(() => {
    if (ticking) return
    ticking = true
    void (async () => {
      try {
        const now = Date.now()
        for (const t of listTasks()) {
          if (!t.enabled || !t.nextRunAt || t.nextRunAt > now) continue
          /* ★1003 4.38：tick 同样放行僵尸 running（重置成功才继续往下走触发） */
          if (t.lastStatus === 'running' && !resetZombieRunning(t)) continue
          console.log(`[scheduledTasks] 触发「${t.name}」（${describeSchedule(t.schedule)}）`)
          void runTaskNow(t.id).catch(() => { /* 内部已记状态 */ })
        }
      } catch (e) {
        console.warn('[scheduledTasks] 扫描异常:', e)
      } finally {
        ticking = false
      }
    })()
  }, TICK_MS)
  console.log(`[scheduledTasks] 调度器已启动（每 ${TICK_MS / 1000}s 扫描一次），共 ${load().tasks.length} 个任务`)
}


