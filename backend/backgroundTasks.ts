/**
 * 后台任务（0920）—— 把"耗时动作"从对话里摘出来，挂到后台真跑。
 *
 * 为什么需要它（设计口径）：
 *   装依赖 / 下载大文件 / 长命令这些事，一旦在工具调用里同步等，就**卡住整轮对话**——
 *   AI 干不了别的、用户也插不上话。所以要有「挂后台、完事再通知我」。
 *
 * 产品设计（前端 `stores/tasks.ts` 的注释里已经跟用户对齐过，这里按它落地，不要另起一套）：
 *   · 每个后台任务一个小胶囊 tab，贴在输入框上方，**只出现在派发它的会话里**
 *   · 进度/记录只进它自己的视图，不混进原对话
 *   · 完成后通知：会话里给一条内联提示；同时通知"派它的那轮 AI"
 *
 * ★ 通知 AI 的两条路（server 注入的 notifier 负责）：
 *   ① 会话的 agent **正在跑** → 用 pi 原生 `agent.steer()` 把完成消息插进去（注入点=当前轮
 *      工具批次跑完、下次 LLM 调用前）→ AI 立刻就能接着处理；
 *   ② 会话**没在跑** → 记成 pending notice，下次该会话发消息时补进上下文。
 *   （`bg_list` / `bg_read` 工具任何时候都能主动查，这是兜底。）
 *
 * ⚠️ 边界：任务是**本进程内**的（跟 NIS 后端同生共死）。关窗口选「最小化到托盘」→ 后端还在跑，
 *   任务继续；真正退出应用 → 正在跑的任务丢失（重启后状态会从持久化文件恢复成"已中断"，不装成功）。
 */

import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import https from 'node:https'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { DATA_ROOT } from './paths.ts'
import { loadJsonOrBackup, writeJsonAtomic } from './jsonStore.ts'
import { resolveShellForCommand, writeTempCmdFile, writeTempPs1File, needsPsFile, bashExePath, pwshExePath, decodeOutput, type ShellKind } from './tools.ts'
/* ★ 0922e：进程身份指纹工具（CIM + 2 秒容差）与「进程注册表」 */
import { procStartStamp, sameStamp, snapshotProcesses } from './procIdentity.ts'
import { procRegister, procEndByPid } from './processRegistry.ts'


type BgStatus = 'background' | 'paused' | 'completed' | 'failed' | 'cancelled'
type BgKind = 'command' | 'download'

interface BgStep { id: string; label: string; status: 'active' | 'done' | 'pending' }
interface BgRecord {
  id: string
  ts: number
  kind: 'system' | 'progress' | 'result'
  content: string
  detail?: string[]
}

interface BgProgress {
  percent: number
  note: string
  bytes?: number
  totalBytes?: number
  speedBps?: number
  etaSec?: number
}

export interface BgTask {
  task_id: string
  title: string
  kind: BgKind
  status: BgStatus
  /** 派发它的会话（前端胶囊 tab 按它过滤） */
  conversationId: string
  createdAt: number
  finishedAt?: number
  /** 命令任务 */
  command?: string
  cwd?: string
  /** 下载任务 */
  url?: string
  dest?: string
  /** ★ 0922c-5：url 模式的**自定义请求头**（用于需要鉴权的直链）；随任务持久化 */
  headers?: Record<string, string>
  /** ★ 0922c-7（Q2）：AI 是否用 bg_note 自报过进度 —— 面板据此决定"画读条 / 显示一行灰字 / 只显示计时" */
  progressReported?: boolean
  /** ★ 0922c-10（A）：**预计总时长**（秒）—— 有它、又拿不到百分比时，面板画一条浅色「预计」时间条
   *（明确标注"预计"，不伪装成精确进度）；AI 可显式给，缺省由同类历史中位推。 */
  estSec?: number
  steps: BgStep[]
  records: BgRecord[]
  /** 输出尾部（环形，最多 OUTPUT_MAX 行；AI 用 bg_read 读） */
  output: string[]
  progress: BgProgress
  result?: string
  error?: string
  exitCode?: number
  /** 完成通知是否已经交代出去 */
  notified: boolean
  /** ★ 0922d：子进程 pid + 进程"创建时间指纹"（ToFileTimeUtc）。
   *  为什么要落盘：Windows 不随父进程回收子进程 —— 后端退出/重启会把还在跑的命令任务孤儿化
   *  （实测一个 pwsh 空转 5 小时）。下次启动 load() 靠这两个值确认"pid 还是当时那个进程"再树杀整棵；
   *  pid 会被系统复用，只凭 pid 杀会误伤无辜进程。 */
  pid?: number
  pidStart?: string
  /** ★ 0922e：子进程树成员（pid + 创建时间指纹 + 名字）。
   *  为什么需要：命令里若再套一层 shell（`pwsh -Command "…"`），真正干活的是**内层** pwsh，
   *  而 spawn 拿到的是外层 pid —— 外层随父进程退出后 /T 够不着，内层就成了清不掉的残留。
   *  spawn 后延迟采样一次，清理时逐个成员校验指纹再杀。 */
  tree?: { pid: number; start: string; name: string }[]
}

/* ── 持久化 ── */

const FILE = path.join(DATA_ROOT, 'background-tasks.json')
const OUTPUT_MAX = 400
/** 只保留最近这么多条（跑完的按 finishedAt 淘汰） */
const KEEP = 60

const tasks = new Map<string, BgTask>()
/** 活着的子进程（stop 用；不持久化） */
const procs = new Map<string, ChildProcess>()
/** ★ 0922c-3：活着的**进程内下载**（下载没有子进程可杀 —— 不留句柄就没法真正停止/暂停）。
 *   res = 可暂停/可销毁的响应流；ws = .part 写流；stop 时还要删掉 .part。 */
const downloads = new Map<string, { res: any; ws?: any; part: string; flush?: () => void }>()
let seq = 0
let loaded = false
/** ★ 0922d：load() 改过任务状态（标"已中断"）就得落盘 —— 否则磁盘永远停在最后一次业务写盘的时刻，
 *  与内存不一致（实测：内存里 cancelled / 磁盘里 background）。 */
let loadDirty = false

/* ── ★ 0922c-7（Q1）：写盘脱敏 ──
   后台任务会持久化到 background-tasks.json。若 url 模式带了 Authorization / Cookie 之类的头，
   明文落盘＝密钥躺在磁盘上（备份/同步会带走）。这里只在**写盘副本**里把敏感头的值打码，
   内存中的真值照常用于下载（任务重启后本来就是"已中断"，不需要真值）。 */
const SENSITIVE_HEADER_RE = /authorization|cookie|token|secret|passwd|password|api[-_]?key/i
function redactTaskForDisk(t: BgTask): BgTask {
  if (!t.headers) return t
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(t.headers)) out[k] = SENSITIVE_HEADER_RE.test(k) ? '***' : v
  return { ...t, headers: out }
}

function nextId(): string {
  seq += 1
  return `bg_${Date.now().toString(36)}_${seq}`
}

function load(): void {
  if (loaded) return
  loaded = true
  try {
    /* ★0927 netfix：进 jsonStore 家族 —— 坏档先备份 .corrupt-* 再回落空表，
       杜绝"坏档→catch 吞掉→空内存→persist() 写盘固化"把用户任务记录清零（家族①病根）。 */
    const r = loadJsonOrBackup<{ tasks?: BgTask[] }>(FILE, () => ({ tasks: [] }))
    if (r.degraded) console.error('[bg] background-tasks.json 坏档已备份为 .corrupt-*，本会话以空表运行（原档可捞）')
    const raw: any = r.data || {}
    const list: BgTask[] = Array.isArray(raw?.tasks) ? raw.tasks : []
    for (const t of list) {
      // 上次进程退出时还在跑的 → 状态改「已中断」，别让 UI 一直转圈
      if (t.status === 'background' || t.status === 'paused') {
        t.status = 'failed'
        t.error = '应用退出导致中断'
        t.finishedAt = t.finishedAt || Date.now()
        loadDirty = true
        killOrphanProcess(t)
        t.pid = undefined
        t.pidStart = undefined
        t.tree = undefined
      }
      tasks.set(t.task_id, t)
    }
    if (loadDirty) persist()
  } catch (e) { console.warn('[bg] load 失败:', e) }
}

/* ── ★ 0922d：孤儿进程清理 ──
   背景（实测）：任务 bg_muc1raq6_6 的 pwsh 在后端重启后继续空转 5 小时 —— Windows 不随父进程回收
   子进程，Node 退出也没有机会跑清理钩子（被强杀时更没有）。所以：
   ① spawn 后立刻把 pid + 进程创建时间指纹落盘；
   ② 下次启动 load() 看到"上次还在跑"的任务时，**确认 pid 身份未变**再 taskkill /T /F 清整棵树；
   ③ 指纹缺失/不符 → 一律不杀（pid 复用宁可漏杀，绝不误伤别的进程）。 */
/* PS_EXE 已搬到 procIdentity.ts（0922e） */

/* procStartStamp 已搬到 procIdentity.ts（0922e） */

/* sameStamp 已搬到 procIdentity.ts（0922e） */

/** spawn 成功后立刻记下身份指纹（拿不到就不记 —— 不记指纹=下次不杀，安全方向） */
function stampPidIdentity(t: BgTask): void {
  if (!t.pid || process.platform !== 'win32') return
  const stamp = procStartStamp(t.pid)
  if (!stamp) { console.warn(`[bg] 拿不到 pid ${t.pid} 的创建时间，本次不记身份指纹`); return }
  t.pidStart = stamp
  persist()
}

/** 上次中断任务的残留进程清理：**逐个成员**做身份校验，只在匹配时动手 */
function killOrphanProcess(t: BgTask): void {
  const root = Number(t.pid)
  if (!root || process.platform !== 'win32') return
  /* ★ 0922e：优先用 spawn 后采样的子树名单（外层 shell 已死、内层还活着的情况全靠它）；
     没有名单（旧数据）时退回"只有根"的老行为。 */
  const members = Array.isArray(t.tree) && t.tree.length ? t.tree : [{ pid: root, start: String(t.pidStart || ''), name: '' }]
  let killed = 0
  let mismatch = 0
  let gone = 0
  for (const m of members) {
    const pid = Number(m.pid)
    if (!pid) continue
    const was = String(m.start || '')
    const now = procStartStamp(pid)
    if (!now) { gone += 1; continue }
    if (!sameStamp(was, now)) { mismatch += 1; continue }
    try {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, timeout: 10000 })
      killed += 1
    } catch { /* ignore */ }
  }
  if (killed) console.log(`[bg] 已清理上次中断任务的残留进程树：${killed} 个（${members.map((m) => m.pid).join(',')}；已退出 ${gone}，身份不符跳过 ${mismatch}）`)
  else if (mismatch) console.warn(`[bg] 残留进程清理：${mismatch} 个身份不符（pid 已被复用）已跳过；已退出 ${gone}`)
  else console.warn(`[bg] 残留进程清理：pid ${root} 及其子孙都已退出（无需处理）`)
}

/* ── ★ 0922e：子树采样 ──
   为什么需要：命令里若自己再套一层 shell（`pwsh -Command "…"`），真正干活的是**内层** pwsh，
   而 spawn 拿到的是**外层** pid —— 外层随父进程退出后就查不到了，/T 也就无从下手（实测：三轮
   测试各留一个内层 pwsh 存活）。所以 spawn 后延迟采样整棵子树，清理时逐个成员校验指纹再杀。 */
const TREE_MAX = 32

/* snapshotProcesses 已搬到 procIdentity.ts（0922e） */

/** 采 rootPid 的整棵子树（含自身，BFS，最多 TREE_MAX 个成员） */
function sampleTree(rootPid: number): { pid: number; start: string; name: string }[] {
  const list = snapshotProcesses()
  const kids = new Map<number, { pid: number; ppid: number; name: string; start: string }[]>()
  for (const p of list) {
    const arr = kids.get(p.ppid) || []
    arr.push(p)
    kids.set(p.ppid, arr)
  }
  const out: { pid: number; start: string; name: string }[] = []
  const root = list.find((x) => x.pid === rootPid)
  if (root) out.push({ pid: root.pid, start: root.start, name: root.name })
  const queue = [rootPid]
  const seen = new Set<number>([rootPid])
  while (queue.length && out.length < TREE_MAX) {
    const cur = queue.shift() as number
    for (const c of kids.get(cur) || []) {
      if (seen.has(c.pid)) continue
      seen.add(c.pid)
      out.push({ pid: c.pid, start: c.start, name: c.name })
      queue.push(c.pid)
    }
  }
  return out
}

/** 合并两次采样的成员（按 pid 去重，先到的留着） */
function mergeMembers(prev: { pid: number; start: string; name: string }[] | undefined, add: { pid: number; start: string; name: string }[]): { pid: number; start: string; name: string }[] {
  const map = new Map<number, { pid: number; start: string; name: string }>()
  for (const m of prev || []) map.set(Number(m.pid), m)
  for (const m of add) if (!map.has(Number(m.pid))) map.set(Number(m.pid), m)
  return [...map.values()]
}

/** spawn 后**多轮**采样子树并落盘。
 *  ⚠️ 实测（0922e）：外层 pwsh 可能在 1 秒内就退出（内层是异步拉起的）—— 单次 900ms 采样会扑空。
 *  所以：① 400ms 就开采；② 采 3 轮并合并；③ 靠 ParentProcessId 建树 ⇒ **根已死也能找到还活着的子孙**
 *  （Windows 不会改写已死父进程留下的 ppid），这正是"外层死了、内层还在飘"那种残留唯一的抓手。 */
function trackTree(t: BgTask, delays: number[] = [400, 1200, 2500]): void {
  const root = Number(t.pid)
  if (!root || process.platform !== 'win32') return
  let round = 0
  const tick = () => {
    try {
      if (t.status !== 'background' && t.status !== 'paused') return
      const found = sampleTree(root)
      if (found.length) {
        const merged = mergeMembers(t.tree, found)
        if (merged.length !== (Array.isArray(t.tree) ? t.tree.length : 0)) { t.tree = merged; persist() }
      }
    } catch { /* ignore */ }
    round += 1
    if (round < delays.length) { const h = setTimeout(tick, delays[round] - delays[round - 1]); h.unref?.() }
  }
  const h0 = setTimeout(tick, delays[0])
  h0.unref?.()
}

function persist(): void {
  /* ★0926c 铁律（用户：严禁兜底，问题直接暴露）：此处曾是 `load()` 静默补加载（掩盖调用方顺序错误）——
     已改为**断言暴露**：谁没先 load() 就写盘，直接炸出来修调用方，不用兜底把 bug 藏起来。 */
  if (!loaded) throw new Error('[backgroundTasks] persist() 前必须先 load()——否则会用空内存覆盖磁盘任务记录（调用方顺序错误）')
  try {
    const all = [...tasks.values()].sort((a, b) => a.createdAt - b.createdAt)
    // 超出上限：优先丢"已结束"的最旧几条
    while (all.length > KEEP) {
      const idx = all.findIndex((t) => t.status !== 'background' && t.status !== 'paused')
      all.splice(idx === -1 ? 0 : idx, 1)
    }
    fs.mkdirSync(path.dirname(FILE), { recursive: true })
    /* ★ 0922c-7：落盘前脱敏（磁盘不留 token；内存仍真值） */
    writeJsonAtomic(FILE, { version: 1, tasks: all.map(redactTaskForDisk) })
  } catch (e) {
    console.error('[bg] 持久化失败：', e)
  }
}

/* ── 对外查询 ── */

export function bgList(conversationId?: string): BgTask[] {
  load()
  const all = [...tasks.values()].sort((a, b) => b.createdAt - a.createdAt)
  return conversationId ? all.filter((t) => t.conversationId === String(conversationId)) : all
}

export function bgGet(id: string): BgTask | undefined {
  load()
  return tasks.get(id)
}

export function bgReadOutput(id: string, lines = 60): { ok: boolean; error?: string; text?: string; status?: BgStatus } {
  const t = bgGet(id)
  if (!t) return { ok: false, error: '任务不存在' }
  const n = Math.min(Math.max(Math.round(lines) || 60, 1), OUTPUT_MAX)
  return { ok: true, status: t.status, text: t.output.slice(-n).join('\n') }
}

/* ── 事件 / 通知（由 server 注入） ── */

let emitter: ((t: BgTask) => void) | null = null
let notifier: ((t: BgTask) => void) | null = null

/** 每次任务状态/进度变化都调（server 拿它广播给前端） */
export function setBgEmitter(fn: (t: BgTask) => void): void { emitter = fn }
/** 任务结束（完成/失败/取消）时调（server 拿它通知会话 + AI） */
export function setBgNotifier(fn: (t: BgTask) => void): void { notifier = fn }

function emit(t: BgTask): void {
  try { emitter?.(t) } catch { /* ignore */ }
}

function finish(t: BgTask, status: BgStatus, result?: string, error?: string): void {
  const from = t.status
  /* ★ 0922e：bgStop 会**先把 status 打成 cancelled**（为了让下载的数据回调/收尾识别"已停止"），
     于是原来那句严格守卫会让「停止」**什么收尾都不做** —— 实测：不落盘、不注销进程、不通知 AI，
     这也正是 0922d 那个"内存 cancelled / 磁盘 background"的真正根因。
     这里只放行 cancelled → cancelled 这一种；finishedAt 已存在说明收尾过了，早退防重复；
     其它从结束态出发的调用（如 close 回调想把 cancelled 改成 completed）照旧被挡。 */
  if (from === 'cancelled' && status === 'cancelled') {
    if (t.finishedAt) return
  } else if (from !== 'background' && from !== 'paused') {
    return
  }
  t.status = status
  t.finishedAt = Date.now()
  /* ★ 0922e：任务收尾 → 从「进程监控」列表移除（结束就消失） */
  if (t.pid) procEndByPid(t.pid)
  /* ★ 0922d：任务已结束 —— 清掉 pid 指纹（磁盘不留无用 pid，也不算"孤儿"） */
  t.pid = undefined
  t.pidStart = undefined
  t.tree = undefined
  if (result) t.result = result
  if (error) t.error = error
  t.progress = { ...t.progress, percent: status === 'completed' ? 100 : t.progress.percent, note: noteFor(t) }
  t.steps.forEach((s) => { s.status = status === 'completed' ? 'done' : s.status })
  pushRecord(t, { kind: 'result', content: result || error || noteFor(t) })
  persist()
  emit(t)
  try { notifier?.(t) } catch (e) { console.error('[bg] 通知失败：', e) }
}

function noteFor(t: BgTask): string {
  if (t.status === 'completed') return '已完成'
  if (t.status === 'cancelled') return '已停止'
  if (t.status === 'paused') return '已暂停'
  return t.error ? `失败：${t.error}` : '失败'
}

function pushRecord(t: BgTask, r: Omit<BgRecord, 'id' | 'ts'>): void {
  t.records.push({ id: `${t.task_id}_r${t.records.length + 1}`, ts: Date.now(), ...r })
  if (t.records.length > 120) t.records.splice(0, t.records.length - 120)
}

function pushOut(t: BgTask, line: string): void {
  if (!line) return
  t.output.push(line)
  if (t.output.length > OUTPUT_MAX) t.output.splice(0, t.output.length - OUTPUT_MAX)
}

/* ── 命令执行 ── */

function readShellKind(): ShellKind {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(DATA_ROOT, 'settings.json'), 'utf-8'))
    const v = String(raw?.cmdShell || '')
    if (v === 'powershell' || v === 'pwsh' || v === 'cmd' || v === 'bash' || v === 'auto') return v
  } catch { /* ignore */ }
  return 'cmd'
}

/** 与 tools.ts 的 runCommand 同一套 Shell 解析（背景任务必须跟前台命令一致，否则语法会对不上）
 *  ★ 1010-C 同步：① bash 分支（1010 前台加了 Git Bash，这里漏了）；② PS 高危命令 .ps1 落盘
 *    （前台 1010-B 的引号防护，同一套语义）；③ 多行 .cmd 落盘的双层引号（cmd /s 剥引号规则）。 */
function buildInvocation(command: string): { exe: string; argv: string[] } {
  const isWin = process.platform === 'win32'
  const normalized = isWin ? command.replace(/\r\n/g, '\n').replace(/\r/g, '\n') : command
  if (!isWin) return { exe: '/bin/sh', argv: ['-c', normalized] }
  const chosen = resolveShellForCommand(readShellKind(), normalized)
  if (chosen === 'bash') {
    const bp = bashExePath()
    if (!bp) throw new Error('Git Bash 未安装：请到 设置 → 运行环境 安装「Git Bash」，或换回 cmd/PowerShell')
    return { exe: bp, argv: ['-c', normalized] }
  }
  if (chosen === 'powershell' || chosen === 'pwsh') {
    const exe = chosen === 'pwsh' ? (pwshExePath() || 'pwsh.exe') : 'powershell.exe'
    if (needsPsFile(normalized)) {
      const tmp = writeTempPs1File(normalized)
      if (tmp) return { exe, argv: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', tmp.file] }
    }
    return { exe, argv: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', normalized] }
  }
  if (normalized.includes('\n')) {
    const tmp = writeTempCmdFile(normalized)
    /* ★ 1010-C：windowsVerbatimArguments 下 Node 不加引号（旧写法裸路径带空格即拆开）；
       cmd /s 剥首尾引号后要剩一层 → 双层引号 `""path""`（与 tools.ts 同款实测结论）。 */
    if (tmp) return { exe: 'cmd.exe', argv: ['/d', '/s', '/c', `""${tmp.file}""`] }
    /* ★1003 并发批 4.3：原来写临时 .cmd 失败就只跑 `split('\n')[0]`、其余静默丢弃还报成功
       （多行命令悄悄只干 1/N 的活）。宁可不跑也不蒙混 —— 如实抛错，runCommandTask 会按失败落账。 */
    throw new Error('多行命令需要临时 .cmd 文件但写入失败（磁盘满/无权限？）——拒绝只执行第一行蒙混过关')
  }
  return { exe: 'cmd.exe', argv: ['/d', '/s', '/c', normalized] }
}

interface BgStartOpts {
  title: string
  conversationId: string
  cwd?: string
  /** ★ 0922c-5：url 模式的请求头（string→string） */
  headers?: Record<string, string>
  /** ★ 0922c-10（A）：预计总时长（秒） */
  estSec?: number
}

/** 挂一条命令到后台（立刻返回 task；输出流式写进 records/output） */
export function bgStartCommand(command: string, opts: BgStartOpts): { ok: boolean; task?: BgTask; error?: string } {
  load()
  const cmd = String(command || '').trim()
  if (!cmd) return { ok: false, error: '命令为空' }
  const running = bgList(opts.conversationId).filter((t) => t.status === 'background')
  if (running.length >= 8) return { ok: false, error: '后台任务太多了（同时最多 8 个），先等几个跑完或 bg_stop 掉' }
  const cwd = opts.cwd || process.cwd()
  const t: BgTask = {
    task_id: nextId(),
    title: opts.title || cmd.slice(0, 60),
    kind: 'command',
    status: 'background',
    conversationId: String(opts.conversationId || ''),
    createdAt: Date.now(),
    command: cmd,
    cwd,
    steps: [
      { id: 's1', label: '启动', status: 'active' },
      { id: 's2', label: '执行中', status: 'pending' },
      { id: 's3', label: '收尾', status: 'pending' },
    ],
    records: [],
    output: [],
    progress: { percent: -1, note: '已挂到后台' },
    notified: false,
  }
  tasks.set(t.task_id, t)
  /* ★ 0922c-13：**只认显式 est_sec**。原来"没给就按同类历史中位推"——实测反馈：持续型任务（守护/挂机）
     因此被画上一条"约剩 4 分 51 秒"的假倒计时。持续性任务本就没有预计结束时间，宁可不显示。 */
  t.estSec = Number(opts.estSec) > 0 ? Math.round(Number(opts.estSec)) : undefined
  pushRecord(t, { kind: 'system', content: `已挂到后台：${cmd.length > 160 ? cmd.slice(0, 160) + '…' : cmd}`, detail: [`工作目录：${cwd}`] })
  persist()
  emit(t)
  void runCommandTask(t)
  return { ok: true, task: t }
}

async function runCommandTask(t: BgTask): Promise<void> {
  try {
    const { exe, argv } = buildInvocation(t.command!)
    /* ★ 0920：cmd.exe 必须原样传参（Node 默认转义会把 `node -e "..."` 弄成空输出）；
       PowerShell 相反，保持默认。详见 tools.ts runCommand 里的同款注释。 */
    const cp = spawn(exe, argv, {
      cwd: t.cwd,
      windowsHide: true,
      env: process.env,
      windowsVerbatimArguments: process.platform === 'win32' && /cmd\.exe$/i.test(exe),
    })
    procs.set(t.task_id, cp)
    /* ★ 0922d：记 pid + 身份指纹（供"后端退出后清孤儿"用） */
    t.pid = cp.pid
    stampPidIdentity(t)
    trackTree(t)
    /* ★ 0922e：登记进「进程监控」注册表（AI 工具拉起的进程都该在那儿看得到）；
       结束/停止时由 finish() 注销 —— 设计口径：只显示正在运行的，结束就消失。 */
    procRegister(cp.pid as number, { exe, cmdline: t.command, cwd: t.cwd, origin: { tool: 'bg_start', conversationId: t.conversationId, label: t.title } })
    t.steps[0].status = 'done'
    t.steps[1].status = 'active'
    t.progress = { ...t.progress, note: '执行中…' }
    emit(t)
    let buf = Buffer.alloc(0)
    /* ★ 0922c 修乱码：**按行切字节、逐行探测编码**（复用 tools.ts#decodeOutput）。
       上一版按 shell 猜编码（pwsh→utf-8）在本机是错的：pwsh 7.6 的 stdout 实际是 GBK/cp936，
       中文全被解成乱码（"计时 1 分钟"任务实锤）。
       为什么能按行解：UTF-8 的续字节与 GBK 的次字节都不会是 0x0A，按 0x0A 切字节不会切碎多字节字符，
       于是不需要流式 TextDecoder —— 顺带支持一行 UTF-8、一行 GBK 混着认（PS 里调原生工具那种）。 */
    const oneLine = (s: string) => {
      // 任务已结束（尤其被 stop 掉）之后就别再攒输出了 —— 进程被杀前还会有几行数据飞过来
      if (!s || t.status !== 'background') return
      pushOut(t, s)
    }
    const feed = (chunk: Buffer, isErr: boolean) => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk
      let i: number
      while ((i = buf.indexOf(0x0a)) !== -1) {
        const line = decodeOutput(buf.subarray(0, i)).replace(/\r$/, '')
        buf = buf.subarray(i + 1)
        if (line.trim()) oneLine((isErr ? '[err] ' : '') + line.slice(0, 500))
      }
      if (buf.length > 8192) { oneLine((isErr ? '[err] ' : '') + decodeOutput(buf).slice(0, 500)); buf = Buffer.alloc(0) }
    }
    cp.stdout?.on('data', (c: Buffer) => feed(c, false))
    cp.stderr?.on('data', (c: Buffer) => feed(c, true))
    const code: number | null = await new Promise((resolve) => {
      cp.on('error', (e: any) => {
        pushOut(t, '[err] ' + String(e?.message || e))
        resolve(-1)
      })
      cp.on('close', (c) => resolve(typeof c === 'number' ? c : -1))
    })
    procs.delete(t.task_id)
    const _tail = decodeOutput(buf).trim()
    if (_tail) oneLine(_tail.slice(0, 500))
    t.exitCode = code
    t.steps[1].status = 'done'
    t.steps[2].status = 'active'
    const tail = t.output.slice(-6).join('\n')
    if (t.status === 'cancelled') return /* stop() 已经收尾 */
    if (code === 0) finish(t, 'completed', tail ? `退出码 0。末尾输出：\n${tail}` : '退出码 0（无输出）')
    else finish(t, 'failed', undefined, `退出码 ${code}${tail ? `。末尾输出：\n${tail}` : ''}`)
  } catch (e: any) {
    procs.delete(t.task_id)
    finish(t, 'failed', undefined, String(e?.message || e).slice(0, 300))
  }
}

/* ── 下载 ── */

/** 挂一条下载到后台（带字节进度；目标目录不存在会自动建） */
export function bgStartDownload(url: string, dest: string, opts: BgStartOpts): { ok: boolean; task?: BgTask; error?: string } {
  load()
  const u = String(url || '').trim()
  const d = String(dest || '').trim()
  if (!/^https?:\/\//i.test(u)) return { ok: false, error: '下载地址必须以 http(s):// 开头' }
  if (!d) return { ok: false, error: '缺少保存路径 dest' }
  const hz = sanitizeHeaders(opts.headers)
  if (!hz.ok) return { ok: false, error: hz.error }
  const t: BgTask = {
    task_id: nextId(),
    title: opts.title || path.basename(d) || u,
    kind: 'download',
    status: 'background',
    conversationId: String(opts.conversationId || ''),
    createdAt: Date.now(),
    url: u,
    dest: d,
    headers: hz.headers,
    steps: [
      { id: 's1', label: '连接', status: 'active' },
      { id: 's2', label: '下载', status: 'pending' },
      { id: 's3', label: '落盘', status: 'pending' },
    ],
    records: [],
    output: [],
    progress: { percent: 0, note: '连接中…' },
    notified: false,
  }
  tasks.set(t.task_id, t)
  /* ★ 0922c-13：同上，下载类也只在显式给了 est_sec 时才写（下载本来就有 etaSec） */
  t.estSec = Number(opts.estSec) > 0 ? Math.round(Number(opts.estSec)) : undefined
  pushRecord(t, { kind: 'system', content: `已挂到后台下载：${path.basename(d)}`, detail: [u, `保存到：${d}`] })
  persist()
  emit(t)
  void runDownloadTask(t)
  return { ok: true, task: t }
}

/** ★ 0922c-5：请求头白名单化（只接受 string→string，条数/长度设上限） */
function sanitizeHeaders(raw: any): { ok: boolean; headers?: Record<string, string>; error?: string } {
  if (raw == null) return { ok: true, headers: undefined }
  if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'headers 必须是对象，如 { "Authorization": "Bearer xxx" }' }
  const keys = Object.keys(raw)
  if (keys.length > 20) return { ok: false, error: 'headers 太多了（最多 20 条）' }
  const out: Record<string, string> = {}
  for (const k of keys) {
    const v = (raw as any)[k]
    if (typeof v !== 'string') return { ok: false, error: `header「${k}」的值必须是字符串` }
    if (v.length > 2048) return { ok: false, error: `header「${k}」的值太长（最多 2048 字符）` }
    out[k] = v
  }
  return { ok: true, headers: out }
}

function httpGet(url: string, redirects = 0, headers?: Record<string, string>): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https:') ? https : http
    /* ★ 0922c-5：透传自定义请求头（默认 UA 保留，可被覆盖）—— 需鉴权的直链也能走 url 模式 */
    const hdrs: Record<string, string> = { 'User-Agent': 'NIS-BgTask/1.0', ...(headers || {}) }
    const req = mod.get(url, { headers: hdrs, timeout: 30000 }, (res) => {
      const code = res.statusCode || 0
      if (code >= 300 && code < 400 && res.headers.location) {
        res.resume()
        if (redirects >= 6) return reject(new Error('重定向过多'))
        return resolve(httpGet(new URL(res.headers.location, url).toString(), redirects + 1, headers))
      }
      if (code !== 200) {
        res.resume()
        /* ★ 0922c-5：把"该给 headers 还是该换命令模式"的线索直接写进报错，模型据此自己改 */
        const hint = code === 401 || code === 403
          ? '（需要鉴权：用 headers 传 Authorization/Cookie，或改用命令模式 curl/aria2c）'
          : code === 404 ? '（地址可能已失效）' : ''
        return reject(new Error(`HTTP ${code}${hint}`))
      }
      resolve(res)
    })
    req.on('timeout', () => req.destroy(new Error('连接超时')))
    req.on('error', reject)
  })
}

async function runDownloadTask(t: BgTask): Promise<void> {
  try {
    fs.mkdirSync(path.dirname(t.dest!), { recursive: true })
    const part = t.dest! + '.part'
    const res = await httpGet(t.url!, 0, t.headers)
    downloads.set(t.task_id, { res, part })
    const total = Number(res.headers['content-length'] || 0)
    t.steps[0].status = 'done'
    t.steps[1].status = 'active'
    t.progress = { percent: total > 0 ? 0 : -1, note: '下载中…', bytes: 0, totalBytes: total }
    emit(t)
    const t0 = Date.now()
    let got = 0
    let lastEmit = 0
    await new Promise<void>((resolve, reject) => {
      const ws = fs.createWriteStream(part)
      /* ★1003 并发批 4.4/4.5：暂停期间的在途字节原来被 `if (t.status !== 'background') return`
         **直接丢弃**（恢复后文件缺块=坏档），drain 又**无条件** res.resume()（暂停键被背压顶掉=失效）。
         现在：暂停=在途字节入队暂存（不丢），drain 只在真在跑时恢复流；恢复（bgResume）走 flush
         按原序补写后再继续。 */
      const pendingBufs: Buffer[] = []
      const writeChunk = (chunk: Buffer) => {
        got += chunk.length
        t.progress.bytes = got
        if (total > 0) t.progress.percent = (got / total) * 100
        const el = (Date.now() - t0) / 1000
        if (el > 0.3) {
          t.progress.speedBps = got / el
          t.progress.etaSec = t.progress.speedBps > 0 && total > 0 ? Math.round((total - got) / t.progress.speedBps) : 0
        }
        /* 进度广播节流 ★ 0920 设计口径：后台任务**不需要实时**，轮询粒度就够——
           拉长到 1s（以前 250ms 太密，下载时一直在刷屏推帧）。 */
        const now = Date.now()
        if (now - lastEmit > 1000) { lastEmit = now; emit(t) }
        if (!ws.write(chunk)) res.pause()
      }
      const flushPending = () => {
        while (pendingBufs.length && t.status === 'background') writeChunk(pendingBufs.shift()!)
        if (t.status === 'background' && !pendingBufs.length) { try { res.resume() } catch { /* ignore */ } }
      }
      { const h = downloads.get(t.task_id); if (h) { h.ws = ws; h.flush = flushPending } }
      res.on('data', (chunk: Buffer) => {
        if (t.status === 'cancelled') return   // 已停止：bgStop 已销毁流/删 .part
        if (t.status === 'paused') { pendingBufs.push(chunk); return }   // ★4.4 暂存不丢
        writeChunk(chunk)
      })
      ws.on('drain', () => {
        /* ★4.5：只在真在跑时恢复（无条件 resume 会把暂停顶掉） */
        if (t.status === 'background' && !pendingBufs.length) res.resume()
      })
      res.on('end', () => {
        // 收尾兜底：恰好在暂停窗口结束时，把暂存字节补写完再关流（否则尾块丢失）
        while (pendingBufs.length) { const c = pendingBufs.shift()!; got += c.length; if (!ws.write(c)) { /* 尽力写 */ } }
        ws.end()
      })
      res.on('error', (e) => { ws.destroy(); reject(e) })
      ws.on('error', (e) => { res.destroy(); reject(e) })
      ws.on('finish', () => resolve())
    })
    downloads.delete(t.task_id)
    /* ★ 0922c-3：被停止的任务 —— 不 rename、不标完成（.part 已在 bgStop 里删掉） */
    if (t.status !== 'background') { try { fs.rmSync(part, { force: true }) } catch { /* ignore */ } return }
    if (total > 0 && got < total) throw new Error(`下载不完整（${got}/${total} 字节）`)
    fs.renameSync(part, t.dest!)
    t.steps[1].status = 'done'
    t.steps[2].status = 'active'
    const mb = (got / 1048576).toFixed(1)
    finish(t, 'completed', `已下载 ${mb}MB → ${t.dest}`)
  } catch (e: any) {
    downloads.delete(t.task_id)
    /* ★ 0922c-3：停止/暂停导致的流销毁不算"失败" */
    if (t.status !== 'background') return
    finish(t, 'failed', undefined, String(e?.message || e).slice(0, 300))
  }
}

/* ── 停止 / 清理 ── */

export function bgStop(id: string): { ok: boolean; error?: string } {
  const t = bgGet(id)
  if (!t) return { ok: false, error: '任务不存在' }
  if (t.status !== 'background' && t.status !== 'paused') return { ok: false, error: '任务已经结束了' }
  t.status = 'cancelled'
  /* ★ 0922c-3：下载任务是**进程内流**、没有子进程 —— 必须显式销毁响应流/写流并删掉 .part，
     否则"停止"之后它照样下完（实测：状态已停止、进度条还在涨）。 */
  const dl = downloads.get(id)
  if (dl) {
    downloads.delete(id)
    try { dl.res?.destroy?.() } catch { /* ignore */ }
    try { dl.ws?.destroy?.() } catch { /* ignore */ }
    try { fs.rmSync(dl.part, { force: true }) } catch { /* ignore */ }
    t.progress = { ...t.progress, note: '已停止', speedBps: 0, etaSec: 0 }
  }
  const cp = procs.get(id)
  if (cp?.pid) {
    procs.delete(id)
    // Windows 只杀直接子进程会留孙进程（npm→node）→ 树杀
    try {
      if (process.platform === 'win32') spawn('taskkill', ['/pid', String(cp.pid), '/T', '/F'], { windowsHide: true })
      else cp.kill('SIGTERM')
    } catch { /* ignore */ }
  }
  finish(t, 'cancelled', '已被手动取消')
  return { ok: true }
}

/** ★ 0922c-3：暂停下载（只支持下载类 —— 命令任务没有可移植的挂起手段） */
export function bgPause(id: string): { ok: boolean; error?: string } {
  const t = bgGet(id)
  if (!t) return { ok: false, error: '任务不存在' }
  if (t.status !== 'background') return { ok: false, error: '任务不在运行中' }
  const dl = downloads.get(id)
  if (!dl) return { ok: false, error: '只有下载任务支持暂停' }
  try { dl.res?.pause?.() } catch { /* ignore */ }
  t.status = 'paused'
  t.progress = { ...t.progress, note: '已暂停', speedBps: 0, etaSec: 0 }
  pushRecord(t, { kind: 'progress', content: '已暂停下载' })
  persist()
  emit(t)
  return { ok: true }
}

/** ★ 0922c-3：继续下载（先恢复运行态，再 resume 流 —— 数据回调的守卫按 status 判定） */
export function bgResume(id: string): { ok: boolean; error?: string } {
  const t = bgGet(id)
  if (!t) return { ok: false, error: '任务不存在' }
  if (t.status !== 'paused') return { ok: false, error: '任务不在暂停中' }
  const dl = downloads.get(id)
  if (!dl) return { ok: false, error: '这个任务已经不在后台了' }
  t.status = 'background'
  t.progress = { ...t.progress, note: '下载中…' }
  pushRecord(t, { kind: 'progress', content: '继续下载' })
  persist()
  emit(t)
  try {
    /* ★1003 并发批 4.4：恢复时先把暂停期暂存的在途字节按原序补写（flush 内部随后 resume 流） */
    if (dl.flush) dl.flush()
    else dl.res?.resume?.()
  } catch { /* ignore */ }
  return { ok: true }
}

/** ★ 0922c-7（Q2）：AI 自报进度 —— 命令类任务也能有读条 / 一行说明。
 *  设计：把「进度」从「类型」里解耦 —— 面板只要 percent ≥ 0 就画读条（下载类天然有，命令类靠这里喂）。
 *  用途：长构建报"3/8 步"、批量处理报"已处理 120/500"、阶段说明写 note。 */
export function bgNote(id: string, note?: string, percent?: number, estSec?: number): { ok: boolean; error?: string } {
  const t = bgGet(id)
  if (!t) return { ok: false, error: '任务不存在' }
  if (t.status !== 'background' && t.status !== 'paused') return { ok: false, error: '任务已经结束了，不用再报进度' }
  const n = String(note ?? '').trim()
  let pct: number | undefined
  if (percent != null && Number.isFinite(Number(percent))) pct = Math.min(100, Math.max(0, Math.round(Number(percent))))
  const est = Number(estSec)
  if (!n && pct == null && !(Number.isFinite(est) && est > 0)) return { ok: false, error: 'note / percent / est_sec 至少给一个' }
  if (Number.isFinite(est) && est > 0) t.estSec = Math.round(est)
  t.progress = {
    ...t.progress,
    ...(pct != null ? { percent: pct } : {}),
    note: n || t.progress.note,
  }
  t.progressReported = true
  pushRecord(t, { kind: 'progress', content: [pct != null ? `${pct}%` : '', n, Number.isFinite(est) && est > 0 ? `预计 ${Math.round(est / 60)} 分` : ''].filter(Boolean).join(' · ') })
  persist()
  emit(t)
  return { ok: true }
}

/** 清掉已结束的任务（closed id 列表为空 = 清全部已结束的） */
export function bgClear(ids?: string[]): { ok: boolean; removed: number } {
  load()
  const kill = new Set(Array.isArray(ids) && ids.length ? ids : [])
  let removed = 0
  for (const [id, t] of tasks) {
    if (t.status === 'background' || t.status === 'paused') continue
    if (kill.size && !kill.has(id)) continue
    tasks.delete(id)
    removed += 1
  }
  if (removed) persist()
  return { ok: true, removed }
}

/* ── 提示词用：给 AI 看的一行摘要 ── */

export function bgSummaryForModel(limit = 8): string {
  const list = bgList().slice(0, limit)
  if (!list.length) return '（当前没有后台任务）'
  return list.map((t) => {
    const prog = t.progress.percent >= 0 ? `${t.progress.percent.toFixed(0)}%` : t.progress.note
    const tail = t.status === 'background' ? '' : (t.result || t.error || '').replace(/\s+/g, ' ').slice(0, 120)
    return `· [${t.task_id}] ${t.title}｜${t.status}｜${prog}${tail ? '｜' + tail : ''}`
  }).join('\n')
}

/** 测试用：重置（仅测试脚本调） */
/* ── 0922：AI 自约定「过会儿回来看一眼」（产品要求的能力）──────────────────
 * 现状缺口：后台任务只在**结束时**通知 AI；任务在跑的过程中 AI 是瞎的，只能干等。
 * 这里补「定时回访」：AI 挂完任务可约 X 秒后回看，到点由 server 把该任务现状
 *（状态/进度/输出尾部）通过通知通路推回给 AI —— 正在跑就插话，空闲就按设置
 * 自动拉起一轮（bgWatchAutoWake，默认开）。
 * 护栏：单会话最多 WATCH_MAX_PER_CONV 个；after 夹在 [5s, 30min]。 */
interface BgWatch {
  id: string
  taskId: string
  conversationId: string
  afterSec: number
  note: string
  dueAt: number
  fired: boolean
  /** ★ 0922c-7：这是第几次回访（同一任务/会话累计，用于提示 AI"别反复自唤醒"） */
  seq?: number
}

const watches = new Map<string, BgWatch>()
const WATCH_MAX_PER_CONV = 5
const WATCH_MIN_SEC = 5
const WATCH_MAX_SEC = 1800
/** ★ 0922c-7：同一目标最多回访几次（每次到点都可能拉起一轮完整模型调用，必须封顶） */
const WATCH_MAX_FIRE = 5
/** 已触发次数：key = conversationId|taskId（taskId 空则记 '*'） */
const watchFireCount = new Map<string, number>()
function watchKeyOf(conversationId: string, taskId: string): string {
  return `${conversationId}|${taskId || '*'}`
}

/** ★ 0922c-7（Q3-2）：这次回访还有必要吗？
 *  任务已结束且结果已经交代出去（notified）→ 叫醒 AI 纯属浪费一整轮调用，直接丢弃。
 *  注意：notified 只在"插话通知成功"时为 true；会话空闲时通知进 pending，会在下轮开跑时补送 → 同样不必回访。 */
function watchStillUseful(w: BgWatch): boolean {
  load()
  if (w.taskId) {
    const t = tasks.get(w.taskId)
    if (!t) return false
    if (t.status === 'background' || t.status === 'paused') return true
    return t.notified !== true
  }
  const mine = [...tasks.values()].filter((t) => t.conversationId === w.conversationId)
  if (mine.some((t) => t.status === 'background' || t.status === 'paused')) return true
  return mine.some((t) => !t.notified)
}
let watchTimer: ReturnType<typeof setInterval> | null = null
let watcher: ((w: BgWatch) => void) | null = null

/** server 注册：到点怎么把回访交出去（插话 / 自动拉起 / 记待办由它决定） */
export function setBgWatcher(fn: (w: BgWatch) => void): void { watcher = fn }

/** 还在等的回访（按到点时间排序） */
function bgWatchList(conversationId?: string): BgWatch[] {
  const all = [...watches.values()].filter((w) => !w.fired).sort((a, b) => a.dueAt - b.dueAt)
  return conversationId ? all.filter((w) => w.conversationId === String(conversationId)) : all
}

/** ★ 0922c-7（Q3-1）：给出「建议 X 秒后回访」——不让模型凭空拍脑袋。
 *  ① 单任务：下载类直接用后端已有的 etaSec；否则用进度外推（已用时长 × 剩余比例）
 *  ② 兜底：同类（同 kind）历史任务耗时的中位数（样本 ≥3）
 *  ③ 再兜底：60 秒 */
/** ★ 0922c-10：同类（同 kind）历史任务耗时的中位数（秒）；样本 < 3 返回 0 */
function sameKindMedianSec(kind?: BgKind): number {
  const durs = [...tasks.values()]
    .filter((x) => (x.status === 'completed' || x.status === 'failed') && x.finishedAt && (!kind || x.kind === kind))
    .map((x) => (Number(x.finishedAt) - Number(x.createdAt)) / 1000)
    .filter((s) => s > 5)
    .sort((a, b) => a - b)
  return durs.length >= 3 ? durs[Math.floor(durs.length / 2)] : 0
}

export function bgSuggestWatchSec(taskId?: string, _conversationId?: string): number {
  load()
  /** 建议值下限 30s —— 别给出"5 秒后回访"这种等于轮询的骚扰值 */
  const clamp = (n: number) => Math.min(Math.max(Math.round(n), WATCH_MIN_SEC, 30), WATCH_MAX_SEC)
  const t = taskId ? tasks.get(String(taskId)) : undefined
  if (t && (t.status === 'background' || t.status === 'paused')) {
    const eta = Number(t.progress?.etaSec || 0)
    if (eta > 0) return clamp(eta * 1.2)
    const pct = Number(t.progress?.percent ?? -1)
    const el = (Date.now() - t.createdAt) / 1000
    if (pct > 3 && el > 5) return clamp((el * (100 - pct)) / pct * 1.2)
  }
  const med = sameKindMedianSec(t?.kind)
  if (med > 0) return clamp(Math.min(med, 600) * 1.2)
  return clamp(60)
}

/** 约一个回访；taskId 为空 = 回看该会话全部在跑的任务 */
export function bgWatch(conversationId: string, taskId: string, afterSec: number, note: string): { ok: boolean; error?: string; watch?: BgWatch } {
  load()
  const conv = String(conversationId || '')
  if (!conv) return { ok: false, error: '缺少会话 id' }
  const sec = Math.min(Math.max(Math.round(Number(afterSec) || 0), WATCH_MIN_SEC), WATCH_MAX_SEC)
  if (bgWatchList(conv).length >= WATCH_MAX_PER_CONV) {
    return { ok: false, error: `回访排太多了（同一会话最多 ${WATCH_MAX_PER_CONV} 个），先等前面几个到点` }
  }
  /* ★ 0922c-7（Q3-3）：同一目标回访次数封顶 —— 防 AI 反复自唤醒烧 token */
  const _k = watchKeyOf(conv, String(taskId || ''))
  if ((watchFireCount.get(_k) || 0) >= WATCH_MAX_FIRE) {
    return { ok: false, error: `这个任务已经回访 ${WATCH_MAX_FIRE} 次了 —— 别反复自唤醒（每次到点都可能拉起一整轮模型调用）；等它结束的通知即可` }
  }
  const w: BgWatch = {
    id: `bw_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    taskId: String(taskId || ''),
    conversationId: conv,
    afterSec: sec,
    note: String(note || '').slice(0, 300),
    dueAt: Date.now() + sec * 1000,
    fired: false,
  }
  watches.set(w.id, w)
  if (!watchTimer) {
    watchTimer = setInterval(() => {
      const now = Date.now()
      for (const it of [...watches.values()]) {
        if (it.fired || it.dueAt > now) continue
        it.fired = true
        watches.delete(it.id)
        /* ★ 0922c-7（Q3-2）：已结束且已交代 → 丢弃这次回访（省一次整轮模型调用） */
        if (!watchStillUseful(it)) {
          console.log(`[bg] 回访丢弃（任务已结束且结果已交代）：${it.taskId || it.conversationId}`)
          continue
        }
        const k = watchKeyOf(it.conversationId, it.taskId)
        const n = (watchFireCount.get(k) || 0) + 1
        watchFireCount.set(k, n)
        /* 0927 netfix：计数表 FIFO 封顶（原无限增长——每「对话|任务」一 key，长生命周期必泄漏） */
        if (watchFireCount.size > 2048) { const _old = watchFireCount.keys().next().value; if (_old) watchFireCount.delete(_old) }
        it.seq = n
        /* ★0930：回访处理器已改 async（LLM 裁决）——同步 try 抓不到 promise 拒绝，
     未处理拒绝会把整个后端进程打死；补一层 .catch 兜住。 */
  try { void Promise.resolve(watcher?.(it)).catch((e) => console.warn('[bg] 回访触发失败:', e)) } catch (e) { console.warn('[bg] 回访触发失败:', e) }
      }
    }, 1000)
    watchTimer.unref?.()
  }
  return { ok: true, watch: w }
}




