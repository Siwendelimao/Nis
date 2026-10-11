/**
 * 进程注册表（0922e）—— 「进程监控」面板的数据源。
 *
 * 设计口径（0922e 定）：
 *   · 只显示**正在运行的**进程（哪怕只活 1 秒也要显示）；**结束后立即消失** ⇒ 不落盘历史
 *   · 每行要有时长 + 来源（项目 → 会话）
 * P0 范围：**AI 工具拉起的进程** —— `run_command` / `project_run_command`（前台命令）
 *   与 `bg_start`（后台任务）。内置服务（记忆桥/MCP/语音引擎）暂不接入（P1 再说）。
 *
 * 安全：面板上的「停止」先做**身份校验**（pid + 创建时间指纹，见 procIdentity.ts），
 *   pid 被系统复用时**拒绝执行**，绝不误杀别的进程。
 * 形态：**纯内存**注册表 —— 后端一退出，这些进程归 Windows 管；面板只回答"此刻还有谁在跑、是谁拉起的"。
 */
import { spawnSync } from 'node:child_process'
import { procStartStamp, sameStamp } from './procIdentity.ts'

interface ProcOrigin {
  /** 拉起它的工具名：run_command / project_run_command / bg_start … */
  tool: string
  /** 派发它的会话（前端据此显示「项目 → 会话」来源） */
  conversationId?: string
  projectId?: string
  /** 显示用短标签（后台任务标题 / 命令摘要） */
  label?: string
}

export interface TrackedProc {
  id: string
  pid: number
  /** 创建时间指纹（FileTime，CIM）—— 停止前校验身份，防 pid 复用误杀 */
  pidStart?: string
  name: string
  /** 命令行摘要（≤240 字） */
  cmdline: string
  cwd?: string
  startedAt: number
  status: 'running'
  origin: ProcOrigin
}

let seq = 0
const procs = new Map<string, TrackedProc>()
let emitter: ((p: TrackedProc) => void) | null = null
let remover: ((p: TrackedProc) => void) | null = null

/** 新增/变化 → server 广播（前端列表实时出现/更新） */
export function setProcEmitter(fn: ((p: TrackedProc) => void) | null): void { emitter = fn }
/** 结束 → server 广播移除（设计口径：结束就消失，不留在列表里） */
export function setProcRemover(fn: ((p: TrackedProc) => void) | null): void { remover = fn }

const emit = (p: TrackedProc): void => { try { emitter?.(p) } catch { /* ignore */ } }
const remove = (p: TrackedProc): void => { try { remover?.(p) } catch { /* ignore */ } }

function baseName(p: string): string {
  const s = String(p || '')
  const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'))
  return i >= 0 ? s.slice(i + 1) : s
}
const clip = (s: string, n = 240): string => (s.length > n ? s.slice(0, n) + '…' : s)

/** 登记一个"由 NIS 拉起"的进程；返回注册 id（pid 非法时返回 null） */
export function procRegister(pid: number, meta: { exe?: string; cmdline?: string; cwd?: string; origin: ProcOrigin }): string | null {
  const n = Number(pid)
  if (!n || n <= 0) return null
  const id = `proc_${(++seq).toString(36)}_${n}`
  const p: TrackedProc = {
    id,
    pid: n,
    name: baseName(meta.exe || '') || 'process',
    cmdline: clip(String(meta.cmdline || '')),
    cwd: meta.cwd,
    startedAt: Date.now(),
    status: 'running',
    origin: { ...meta.origin },
  }
  procs.set(id, p)
  /* 指纹同步补一次（~150ms）：拿不到就不记 —— procKill 里"没有指纹"走宽松分支，见那里的守卫 */
  p.pidStart = procStartStamp(n) || undefined
  emit(p)
  return id
}

/** 进程结束（子进程 close / 任务收尾）→ 从列表移除并广播 */
export function procEndByPid(pid: number): void {
  const n = Number(pid)
  if (!n) return
  for (const [id, p] of [...procs.entries()]) {
    if (p.pid === n) { procs.delete(id); remove(p) }
  }
}

/** 当前正在跑的（按启动时间升序 —— 与后台任务面板一致的"旧在上"口径） */
export function procList(): TrackedProc[] {
  return [...procs.values()].sort((a, b) => a.startedAt - b.startedAt)
}

/** 面板上的「停止」：先验身份，pid 被复用则拒绝 */
export function procKill(id: string): { ok: boolean; error?: string } {
  const p = procs.get(id)
  if (!p) return { ok: false, error: '进程已不在列表里（可能已经结束）' }
  const now = procStartStamp(p.pid)
  /* ★1003 安全批 4.24/4.25/4.27（同族连修）：
     ① 查询失败（null）原来被当"已退出"→ 注销登记+报成功（活进程从此不受控）——现如实报错让用户重试；
     ② p.pidStart 缺失（登记时没取到指纹）时校验整个跳过 = 可能被复用的 pid 照杀，
        直接违反文件头"绝不误杀别的进程"承诺——现在证不出身份就拒绝；
     ③ taskkill 失败原来被当成功（spawnSync 不抛错，失败在 status/error 里）——现检查结果。 */
  if (now === null) {
    return { ok: false, error: '进程身份查询失败（PowerShell 超时/异常），出于安全未执行，请重试' }
  }
  if (!now) { procEndByPid(p.pid); return { ok: true } }  // 查明确实不存在 = 已退出
  if (!p.pidStart) {
    return { ok: false, error: '该进程缺少身份指纹（登记时未取到），无法证明是它，拒绝停止（防 pid 复用误杀）' }
  }
  if (!sameStamp(p.pidStart, now)) {
    return { ok: false, error: 'pid 已被系统复用，出于安全未执行（不会去杀别的进程）' }
  }
  const r = spawnSync('taskkill', ['/pid', String(p.pid), '/T', '/F'], { windowsHide: true, timeout: 10000 })
  if (r.error || r.status !== 0) {
    return { ok: false, error: 'taskkill 失败：' + String(r.error?.message || (r.stderr || '').toString().trim().slice(0, 160) || `exit ${r.status}`) }
  }
  procEndByPid(p.pid)
  return { ok: true }
}


