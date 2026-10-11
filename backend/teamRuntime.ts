/**
 * 团队运行时（P2）—— 黑板 + 子 agent（同步阻塞式，Claude Code Task 模式）
 *
 * 心智（docs/team-mode-plan.md 定稿）：
 *  - 黑板是唯一事实源：goal/plan/findings/final 全落 backend/data/blackboard/<sessionId>.json（按会话键控隔离）
 *  - 子 agent 用完即焚：team_dispatch 的 execute() 内同步 await 跑完，产出摘要作为 tool result 返回主 agent
 *    （业界主流：Claude Code Task 工具同款；主 agent 在 tool result 里直接审核，无需后台调度器）
 *  - 依赖硬校验：步骤 deps 前置未 done → 整次派发拒绝（LLM 判断错了也发不出去）
 *  - 打回 ≤2：同一步骤累计派发 3 次后拒绝再派，主 agent 必须把产出对比上抛用户
 *  - 并行预算：单次 dispatch 按 maxParallel(1-3) 分批 Promise 并发（auto 模式 3+2 分批）
 *  - 子 agent 权限：不走权限卡（工作目录限会话工作区，主 agent 结果审核制）；工具 = 成员预设 tools
 *    白名单 + bb_write（只能汇报自己的步骤）；无派发权/无黑板管理权
 *  - 成员上下文精准打包（防爆窗）：团队清单 + 黑板快照 + 任务单，不共享主对话历史、不共享彼此上下文
 */
import fs from 'node:fs'
import path from 'node:path'
import { Agent } from '@earendil-works/pi-agent-core'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { toFinishTurn } from './piCompat.ts'
import { Type } from 'typebox'
import { matchIndiscriminateKillCommand } from './processGuard.ts'
import { releaseRun as releaseFileLocks, detectDispatchOverlap } from './fileLocks.ts'
import { DATA_ROOT } from './paths.ts'
import { readAgentPreset } from './agentPresetsStore.ts'
import { writeJsonAtomic } from './jsonStore.ts'
import type { TeamDef, TeamMember } from './teamsStore.ts'

// ============================================================================
// 黑板存储（backend/data/blackboard/<sessionId>.json，按会话键控）
// ============================================================================

type StepStatus = 'pending' | 'running' | 'review' | 'done' | 'rejected' | 'failed' | 'interrupted'

export interface BlackboardStep {
  id: string
  text: string
  deps: string[]
  owner: string
  status: StepStatus
  attempts: number
  result?: string
  artifacts?: string[]
  feedback?: string
  runId?: string
  updatedAt?: number
}

export interface Blackboard {
  sessionId: string
  teamId: string
  goal: string
  acceptance?: string
  steps: BlackboardStep[]
  findings: Array<{ t: number; by: string; text: string }>
  finalResult?: string
  createdAt: number
  updatedAt: number
  /** ★1005 补类型：黑板上的**成员运行记录**（派发/收尾/看板去重都读写它，键含 runId/stepId/memberId/status）。
   *  带索引签名：实现里还会塞别的时间戳/文本字段，避免为它反复改类型。 */
  runs?: Array<{ runId?: string; id?: string; stepId?: string; memberId?: string; status?: string; [k: string]: any }>
}

const BB_DIR = path.join(DATA_ROOT, 'blackboard')

function bbPath(sessionId: string): string {
  return path.join(BB_DIR, `${sessionId}.json`)
}

export function loadBlackboard(sessionId: string): Blackboard | null {
  try {
    const raw = fs.readFileSync(bbPath(sessionId), 'utf-8')
    const bb = JSON.parse(raw)
    if (!bb || bb.sessionId !== sessionId) return null
    // 冻结步骤自愈（0902 事故遗留形态：进程被杀时步骤停在 running，黑板永远显示进行中）。
    // 写入侧修（铁律 31 允许的防御类）：读侧发现 running 步骤但其 runId 的子 agent 已不在
    // 运行集（重启后必然不在）→ 标 interrupted，主 agent 收到后可补派
    if (Array.isArray(bb.steps)) {
      let changed = false
      for (const s of bb.steps) {
        const live = s.runId && activeRunIds.has(String(s.runId))
        if (s.status === 'running' && !live) { s.status = 'interrupted'; changed = true }
      }
      // 0910 反馈4：run 记录同样自愈——进程被杀时 run 停在 'running'，读侧标 'interrupted'
      // 并写明原因（前端气泡据此显示"被中断"，而不是空着或永远转圈）。记录本身不删，产出照旧可回看。
      if (Array.isArray(bb.runs)) {
        for (const r of bb.runs) {
          if (r && r.status === 'running' && !activeRunIds.has(String(r.runId))) {
            r.status = 'interrupted'
            r.endedAt = r.endedAt || Date.now()
            r.text = r.text || '（这轮执行被中断——后端在处理过程中重启/停止，产出以工作区文件为准）'
            changed = true
          }
        }
      }
      if (changed) {
        try {
          bb.updatedAt = Date.now()
          /* ★0929 P0（多窗口长任务隐患排查）：原子写 —— 裸 writeFileSync 崩溃窗口会留
             半截 JSON，下次 loadBlackboard 直接解析失败=整板丢（#clone 板实测已达 4MB）。 */
          writeJsonAtomic(bbPath(sessionId), bb)
        } catch { /* ignore */ }
      }
    }
    return bb
  } catch {
    return null
  }
}

function saveBlackboard(bb: Blackboard): void {
  try {
    bb.updatedAt = Date.now()
    /* ★0929 P1（刀6 成员回流覆盖）：**所有板**落盘统一「盘上取最新 → 合并 → 原子写」同步临界区。
       旧病（分身2 审计实锤）：team_dispatch execute 开头 `loadBlackboard` 持一份副本**跨整个派发期**
       （分钟级 await Promise.all），期间【成员单聊回流 findings（2010）/ 同轮并行 bb_write·bb_goal
       （pi 同轮工具确为 Promise.all）】写盘的成果，会被 dispatch 侧 bb_write/步骤状态回写用旧副本
       **整板覆盖**——单聊产出白干、指挥官 done/rejected 被打回。
       合并规则（JS 单线程：load→merge→write 之间无 await，天然互斥）：
         · runs 按 runId/id 合并（同键本地=最新状态优先），按 t 排序、封顶 60 条
         · steps 按 id 合并，**同 id 取 updatedAt 较新者**（全部状态变更路径都 stamp updatedAt，判据可靠）
         · findings 内容并集去重（append-only，按 t 排序）
         · 标量字段（goal/acceptance/finalResult…）以本地为准（本地=刚被业务代码改过的对象）
         · 合并结果回灌本地 bb —— 后续事件推进的整板写的都是同一份全量
       注：0929 刀1 曾决定「团队板保持直写（共享对象无自丢）」——共享对象确实不丢**自己的**写，
       但防不住**外部写者**（单聊回流/并行工具副本），本刀按分身2 P1 证据统一改为合并落盘。 */
    const fresh: any = loadBlackboard(bb.sessionId) || {}
    const local: any = bb as any
    const runs: any[] = (() => {
      const m = new Map<string, any>()
      for (const r of [...(fresh.runs || []), ...(local.runs || [])]) m.set(String((r as any)?.runId || (r as any)?.id || Math.random()), r)
      return Array.from(m.values()).sort((a: any, b: any) => (a?.t || 0) - (b?.t || 0)).slice(-60)
    })()
    const steps: any[] = (() => {
      const m = new Map<string, any>()
      for (const s of [...(fresh.steps || []), ...(local.steps || [])]) {
        const id = String((s as any)?.id || Math.random())
        const prev = m.get(id)
        if (!prev || Number((s as any)?.updatedAt || 0) >= Number(prev?.updatedAt || 0)) m.set(id, s)
      }
      return Array.from(m.values())
    })()
    const seen = new Set<string>()
    const findings: any[] = [...(fresh.findings || []), ...(local.findings || [])]
      .filter((f: any) => { const k = JSON.stringify(f); if (seen.has(k)) return false; seen.add(k); return true })
      .sort((a: any, b: any) => (a?.t || 0) - (b?.t || 0))
    const merged: any = { ...fresh, ...local, runs, steps, findings, sessionId: local.sessionId || bb.sessionId }
    merged.createdAt = fresh.createdAt || local.createdAt || Date.now()
    merged.updatedAt = Date.now()
    ;(bb as any).runs = runs
    ;(bb as any).steps = steps
    ;(bb as any).findings = findings
    /* ★0929 P0 同款：原子写（tmp+rename），防崩溃留半截 JSON 丢整板 */
    writeJsonAtomic(bbPath(bb.sessionId), merged)
  } catch (e) {
    console.error('[team] blackboard save failed:', e)
  }
}

/** ★0929 刀1 原分身板合并器——刀6 起其算法已**收口进 saveBlackboard（全板合并）**，
 *  本函数保留为兼容别名（persistRuns 的 #clone 分流仍按名调用，语义不变）。 */
function saveBlackboardRunsMerged(bb: Blackboard): void {
  saveBlackboard(bb)
}

/** 会话删除时清理黑板落盘 */
export function clearBlackboard(sessionId: string): void {
  try {
    fs.rmSync(bbPath(sessionId), { force: true })
  } catch { /* ignore */ }
}

/** 只读黑板 runs（不改步骤状态、不触发热路径自愈写盘）：bb_goal 重写计划时保留成员执行记录用 */
function readBlackboardRuns(sessionId: string): any[] {
  try {
    const raw = fs.readFileSync(bbPath(sessionId), 'utf-8')
    const bb = JSON.parse(raw)
    return Array.isArray(bb?.runs) ? bb.runs : []
  } catch {
    return []
  }
}

/** 本进程内**正在跑**的 run（派发 + 单聊共用）：读侧自愈必须跳过它们——否则前端随手
 *  读一次黑板就会把"正在执行的步骤/成员"误标成 interrupted（自愈只该处理上一个进程留下的残留）。 */
const activeRunIds = new Set<string>()

// ============================================================================
// 子 agent 生命周期跟踪（session.cancel / session.delete 时中止）+ 看门狗
// ============================================================================

const subAgents = new Map<string, Set<Agent>>()
/** 子 agent 的中断控制器（runKey → AC）：abort 时连 LLM 流一起断 */
const subControllers = new Map<string, Set<AbortController>>()
/** ★0930：会话「用户中止」时间戳 —— abortSubAgents 打点，调用方用 abortedSince 判定
 *  「这批 run 是不是被用户停掉的」（失败链严禁把用户中止当失败重派，见 cloneRuntime）。 */
const abortStamps = new Map<string, number>()

export function abortedSince(sessionId: string, sinceMs: number): boolean {
  return (abortStamps.get(sessionId) || 0) > sinceMs
}

export function abortSubAgents(sessionId: string): void {
  abortStamps.set(sessionId, Date.now())
  const set = subAgents.get(sessionId)
  /* ★0930c：原写法 `if (!set) return` —— agents 表缺席时**直接返回，控制器全漏 abort**
     （注册竞态/异常路径下两表不一致就够出事）。两表各自独立结算，谁在场谁被中止。 */
  if (set) {
    for (const a of set) {
      try { a.abort() } catch { /* ignore */ }
    }
    subAgents.delete(sessionId)
  }
  const acs = subControllers.get(sessionId)
  if (acs) {
    for (const ac of acs) {
      try { ac.abort() } catch { /* ignore */ }
    }
    subControllers.delete(sessionId)
  }
  // 清看门狗：传 entry.timer（不是 entry 对象——clearTimeout(对象) 是无效调用，
  // 残留 timer 到点会误触发"看门狗击杀"假日志）
  const runMap = watchdogs.get(sessionId)
  if (runMap) {
    for (const [, entry] of runMap) {
      if (entry?.timer) clearTimeout(entry.timer)
    }
    watchdogs.delete(sessionId)
  }
}

/** 看门狗：runId → (最后活动时间, timer)。派发超过 MAX_RUN_MS 无活动 → abort 子 agent（主 agent 收到超时产出，自行调整） */
const watchdogs = new Map<string, Map<string, { last: number; timer: NodeJS.Timeout; agent: Agent }>>()

/* ★1005（已定案"分身还在跑 ⇒ 会话就是进行中"，且**必须是真实后端状态**）：
   watchdogs 就是权威登记表 —— run 开始时登记（runSubAgent）、disarm/看门狗击杀/abort 时注销。
   ① runningSubAgentCount：给 server.ts 在收轮时判断"还有没有在跑的成员/分身"；
   ② setSubAgentsIdleHook：**最后一个 run 收尾**时通知 server.ts 把会话置 idle 并广播
      （server.ts 接线；不设=不通知）。此前后端根本没有这份"运行中"名单可查 ⇒ 前端只能瞎猜。 */
export function runningSubAgentCount(sessionId: string): number {
  return watchdogs.get(String(sessionId || ''))?.size || 0
}
let onSubAgentsIdle: ((sessionId: string) => void) | null = null
export function setSubAgentsIdleHook(fn: (sessionId: string) => void): void { onSubAgentsIdle = fn }
function notifySubAgentsIdleIfEmpty(sessionId: string): void {
  if (watchdogs.get(sessionId)?.size) return
  try { onSubAgentsIdle?.(sessionId) } catch (e) { console.warn('[subagent] 空闲回调失败:', e) }
}
/** 无活动超时（成员可能陷入死循环/网关挂死）：10 分钟。**不可调**——这是最后一道兜底，
 *  「成员单次运行不设限」档位下唯一的回收机制，任何配置都不关闭它。 */
const WATCHDOG_IDLE_MS = 10 * 60 * 1000
/** 单次派发硬上限默认值：30 分钟（到点强杀，防无限占用并行预算；挂起时长不计入） */
const MAX_RUN_MS = 30 * 60 * 1000
/** 绝对墙钟上限默认值：60 分钟，**不受挂起顺延影响**。挂起顺延本为"人不在权限卡前"设计，
 *  但每次工具授权都会 suspend/resume，授权间隙的 LLM 慢/429 重试会把 started 不断推走，
 *  30 分钟硬上限可能永远到不了（0911 商城实验实锤：agnes 429 风暴把测试 run 挂了 35 分钟+）。
 *  墙钟上限是无条件兜底：真需要长任务的成员，60 分钟也该到头了。 */
const MAX_RUN_WALL_MS = 60 * 60 * 1000

/** 0911：成员单次运行上限可调（设置·通用「成员单次运行上限」，0=不设限）——
 *  server.ts 注入热读函数（activeMs=连续工作硬上限（挂起不计）；wallMs=绝对墙钟（含权限等待）；
 *  Infinity=不设限）。默认值=旧行为（30/60 分钟），改动即时生效、无需重启。 */
let memberRunCaps: () => { activeMs: number; wallMs: number } = () => ({ activeMs: MAX_RUN_MS, wallMs: MAX_RUN_WALL_MS })
export function setMemberRunLimitProvider(fn: () => { activeMs: number; wallMs: number }): void { memberRunCaps = fn }

// ============================================================================
// 成员巡检官（0911 三批，用户拍板「完整版」）
//  看门狗管「死活」（无活动/超时→击杀）；巡检官管「方向」（偏离主线/陷入循环→纠偏→击杀）。
//  三件套：规则预筛（零模型成本，每次工具调用后评估）→ 疑似才轻量模型复审（短上下文直调）
//  → 动作阶梯：先 steer 纠偏一次；再犯 abort 击杀（原因沿既有失败路径回报主 agent，主 agent 逻辑零改动）。
//  边界：只管 team_dispatch 派发的成员 run（成员单聊有人盯着，不巡检）；复审失败静默跳过；
//  阈值保守（宁可漏抓不可误杀）；开关走设置（默认开）。
// ============================================================================

/** 复审结果（server.ts 实现 reviewer 并注入，teamRuntime 不反向依赖 server） */
interface InspectorVerdict { verdict: 'ok' | 'drift' | 'loop'; reason: string; fix?: string }
interface InspectorReviewInput {
  memberName: string; roleText: string; stepText: string; taskText: string; acceptance: string
  suspicion: string; trajectory: string
}
let inspectorEnabled: () => boolean = () => true
export function setMemberInspectorProvider(fn: () => boolean): void { inspectorEnabled = fn }
let inspectorReviewer: ((input: InspectorReviewInput) => Promise<InspectorVerdict>) | null = null
export function setInspectorReviewer(fn: (input: InspectorReviewInput) => Promise<InspectorVerdict>): void { inspectorReviewer = fn }

/** 成员只读类工具（连续只读=空转嫌疑；与 server.ts READONLY_TOOL_RE 同源 + 成员常见记忆/技能读类） */
const INSPECTOR_READONLY_RE = /^(fs_read|fs_grep|search_files|list_dir|web_search|web_fetch|memory_search|use_skill|read_preset|scan_skill|list_installed|snapshotFile|wb_get_text|wb_snapshot|wb_screenshot|wb_read_console)$/i
/** 成员写入类工具（成功执行=真实进展信号） */
const INSPECTOR_WRITE_RE = /^(fs_write|fs_delete|run_command|memory_store|memory_delete|project_note)$/i
/* ★ 0929 工具瘦身·刀①：家族工具按 (name, action) 判读写；未识别的家族调用**从严按"写"**（不误放空转） */
const FAM_READONLY = new Set(['memory:search', 'knowledge:query', 'notebook:list', 'bg:list', 'bg:read', 'history:list', 'history:stat', 'schedule:list', 'git:status', 'git:diff', 'git:log', 'repo:map', 'repo:search', 'repo:build'])
const FAM_WRITE = new Set(['memory:store', 'memory:delete', 'memory:distill', 'knowledge:add', 'knowledge:delete', 'notebook:add', 'notebook:update', 'notebook:delete', 'bg:start', 'bg:stop', 'bg:note', 'bg:watch', 'history:restore', 'schedule:create', 'schedule:update', 'schedule:remove', 'schedule:run_now', 'git:commit'])
function famClassify(name: string, argsStr: string): 'readonly' | 'write' | null {
  let action = ''
  try { action = String((argsStr && JSON.parse(argsStr))?.action || '') } catch { /* args 非 JSON 就落名字判 */ }
  const key = action ? `${name}:${action}` : ''
  if (FAM_READONLY.has(key)) return 'readonly'
  if (FAM_WRITE.has(key)) return 'write'
  if (/^(bg|memory|knowledge|notebook|history|schedule)$/.test(name)) return 'write'
  return null
}

interface InspectorCall { name: string; args: string; result: string; isError: boolean; readonly: boolean; progress: boolean; ts: number }

/** 规则预筛（纯函数，可单测）：命中返回嫌疑标记，未命中返回 null。
 *  阈值取保守值——巡检官的价值在"疑似才升级复审"，宁可漏抓不可误杀。 */
function inspectorSuspect(calls: InspectorCall[]): string | null {
  // A. 只读空转：最近 18 次调用全是只读（读文件/搜索/抓网页）——探索过头或空转
  const w18 = calls.slice(-18)
  if (w18.length >= 18 && w18.every(c => c.readonly)) return 'readonly-spin'
  // B. 变体重复：最近 10 次里同一工具出现 ≥8 次，且多为失败或结果高度雷同
  //    （同指纹熔断抓不到"参数每次微变"的变体循环，这里补位）
  const w10 = calls.slice(-10)
  if (w10.length >= 10) {
    const byName = new Map<string, InspectorCall[]>()
    for (const c of w10) { const g = byName.get(c.name) || []; g.push(c); byName.set(c.name, g) }
    for (const [nm, g] of byName) {
      if (g.length >= 8) {
        const errs = g.filter(c => c.isError).length
        const distinct = new Set(g.map(c => c.result)).size
        if (errs >= 6 || distinct <= 2) return `variant-repeat:${nm}`
      }
    }
  }
  // C. 无进展：最近 30 次调用无任何进展信号（成功写/命令/汇报/子计划推进）——在动，但什么都没产出
  if (calls.length >= 30 && !calls.slice(-30).some(c => c.progress)) return 'no-progress'
  return null
}

const INSPECTOR_REVIEW_COOLDOWN_MS = 90_000
const INSPECTOR_MAX_REVIEWS_PER_RUN = 6
const INSPECTOR_MAX_CORRECTIONS = 1

function inspectorSuspectLabel(suspect: string): string {
  if (suspect === 'readonly-spin') return '连续只读（空转迹象）'
  if (suspect === 'no-progress') return '长时间无进展'
  if (suspect.startsWith('variant-repeat:')) return `重复调用 ${suspect.split(':')[1]}`
  return suspect
}

/** 巡检官挂载（随 run 生命周期；noteCall 每次工具调用后调用，disarm 在 run 收尾 finally 调用） */
function armInspector(p: {
  agent: Agent
  memberName: string
  roleText: string
  stepText: string
  taskText: string
  acceptance: string
  log: (message: string) => void
  note: (text: string) => void
  onKill: (reason: string) => void
}): { noteCall: (c: { name: string; args: string; result: string; isError: boolean; progressOverride?: boolean }) => void; disarm: () => void } {
  const calls: InspectorCall[] = []
  const flagTimes = new Map<string, number>()
  let disarmed = false
  let inFlight = false
  let reviews = 0
  let corrections = 0
  let lastReviewAt = 0
  const trigger = (suspect: string) => {
    void (async () => {
      if (disarmed || inFlight) return
      if (reviews >= INSPECTOR_MAX_REVIEWS_PER_RUN) return
      if (Date.now() - lastReviewAt < INSPECTOR_REVIEW_COOLDOWN_MS) return
      const reviewer = inspectorReviewer
      if (!reviewer) return
      inFlight = true
      reviews++
      lastReviewAt = Date.now()
      try {
        const trajectory = calls.slice(-14).map((c, i) =>
          `${i + 1}. ${c.name}(${truncate(c.args, 90)}) → ${c.isError ? '[失败] ' : ''}${truncate(c.result, 120)}`).join('\n')
        const verdict = await reviewer({
          memberName: p.memberName, roleText: p.roleText, stepText: p.stepText,
          taskText: p.taskText, acceptance: p.acceptance, suspicion: suspect, trajectory,
        })
        if (disarmed) return
        try { if (p.agent.signal?.aborted) return } catch { /* ignore */ }
        const label = verdict.verdict === 'drift' ? '偏离任务单' : verdict.verdict === 'loop' ? '陷入循环' : '正常'
        if (verdict.verdict === 'ok') {
          p.note(`巡检：检测到「${inspectorSuspectLabel(suspect)}」，复审判定正常（${truncate(verdict.reason, 80) || '继续观察'}）`)
          return
        }
        if (corrections < INSPECTOR_MAX_CORRECTIONS) {
          corrections++
          const fix = String(verdict.fix || '').trim() || '回到任务单范围，聚焦本步骤的产出本身。'
          try {
            p.agent.steer({
              role: 'user',
              content: [{ type: 'text', text: `【巡检纠偏】你被判定${label}（${truncate(verdict.reason, 120)}）。${fix}\n若任务已完成，立即用 bb_write 汇报后结束；若被阻塞，在 bb_write 的 result 里写明阻塞点，不要继续无效尝试。` }],
              timestamp: Date.now(),
            } as any)
          } catch { /* ignore */ }
          p.note(`巡检：复审判定${label}（${truncate(verdict.reason, 100)}）→ 已注入纠偏指令，再犯将中止`)
          p.log(`${p.memberName} 被判定${label}，已纠偏一次：${truncate(verdict.reason, 140)}`)
        } else {
          const reason = `巡检官中止：${label}，纠偏后仍无改善（${truncate(verdict.reason, 140)}）`
          p.note(`巡检：${label}且纠偏无效 → 已中止本次运行（${truncate(verdict.reason, 100)}）`)
          p.log(`${p.memberName} ${reason}`)
          p.onKill(reason)
          try { p.agent.abort() } catch { /* ignore */ }
        }
      } catch { /* 复审失败（网关/解析）静默：巡检是增益，不是依赖 */ }
      finally { inFlight = false }
    })()
  }
  return {
    noteCall: (c) => {
      if (disarmed || !inspectorEnabled()) return
      const fam = famClassify(c.name, c.args)
      const readonly = fam ? fam === 'readonly' : INSPECTOR_READONLY_RE.test(c.name)
      const progress = typeof c.progressOverride === 'boolean'
        ? c.progressOverride
        : ((fam ? fam === 'write' : INSPECTOR_WRITE_RE.test(c.name)) && !c.isError)
      calls.push({ name: c.name, args: c.args, result: c.result, isError: c.isError, readonly, progress, ts: Date.now() })
      if (calls.length > 60) calls.splice(0, calls.length - 60)
      if (calls.length < 10) return
      const suspect = inspectorSuspect(calls)
      if (!suspect) return
      // 同一嫌疑 2 个复审周期内不重复触发（轨迹仍在变时的自然去抖）
      const prev = flagTimes.get(suspect) || 0
      if (Date.now() - prev < INSPECTOR_REVIEW_COOLDOWN_MS * 2) return
      flagTimes.set(suspect, Date.now())
      trigger(suspect)
    },
    disarm: () => { disarmed = true },
  }
}

/* ★1005 修类型：原声明 `): () => void` —— 但实现返回的是**对象字面量**（键见下方 return），
   于是三处调用「.suspend()/.resume()/.disarm()」全被 TS 判"属性不存在"。
   运行时一直是好的（团队会话能跑）⇒ 纯类型缺口。返回类型按**实际字面量的键**生成（补丁脚本自校验过）。 */
function armWatchdog(ctx: TeamCtx, runId: string, agent: Agent, onTimeout: (reason: string) => void): { disarm: () => void; suspend: () => void; resume: () => void } {
  const started = Date.now()
  const state = {
    last: Date.now(), timer: null as NodeJS.Timeout | null, agent,
    /** 权限卡等待期间挂起（用户可能几小时不在线）：不计时、不击杀，恢复后重新起算 */
    suspended: false,
    /** 硬上限：只计非挂起时段（suspend 累积的时长在 resume 时顺延 started） */
    started,
  }
  let runMap = watchdogs.get(ctx.sessionId)
  if (!runMap) { runMap = new Map(); watchdogs.set(ctx.sessionId, runMap) }
  runMap.set(runId, state)
  // 0911：绝对墙钟起点（不随 suspend 顺延）——无条件兜底
  const wallStarted = Date.now()
  // 排程：取「无活动余量」与「硬上限余量」的较小者——硬上限到期前即使心跳不断也会触发
  const schedule = () => {
    if (state.timer) { clearTimeout(state.timer); state.timer = null }
    if (state.suspended) return
    const caps = memberRunCaps()
    const idleIn = WATCHDOG_IDLE_MS - (Date.now() - state.last)
    const hardIn = caps.activeMs - (Date.now() - state.started)
    const wallIn = caps.wallMs - (Date.now() - wallStarted)
    state.timer = setTimeout(check, Math.max(1000, Math.min(idleIn, hardIn, wallIn)))
  }
  const check = () => {
    state.timer = null
    if (state.suspended) return
    // 触发时校验：已被清理（disarm/abortSubAgents）或 agent 已中止 → 跳过，不写"看门狗击杀"假日志
    if (runMap!.get(runId) !== state) return
    try { if (agent.signal?.aborted) return } catch { /* ignore */ }
    const caps = memberRunCaps()
    const idleMs = Date.now() - state.last
    const totalMs = Date.now() - state.started
    const wallMs = Date.now() - wallStarted
    const reason = idleMs >= WATCHDOG_IDLE_MS
      ? `子 agent 超过 ${Math.round(idleMs / 60000)} 分钟无任何活动（疑似死循环/挂死），已被看门狗中止`
      : totalMs >= caps.activeMs
        ? `子 agent 运行超过 ${Math.round(caps.activeMs / 60000)} 分钟上限，已被强制中止`
        : wallMs >= caps.wallMs
          ? `子 agent 运行超过 ${Math.round(wallMs / 60000)} 分钟绝对上限（含权限等待），已被强制中止`
          : null
    if (!reason) { schedule(); return }
    runMap!.delete(runId)
    notifySubAgentsIdleIfEmpty(ctx.sessionId)   // ★1005：击杀也可能清空最后一个 run
    try { agent.abort() } catch { /* ignore */ }
    onTimeout(reason)
  }
  schedule()
  // 子 agent 事件算心跳（text_delta/tool_call 刷新；挂起期间忽略）。
  // 0911 修正：错误/重试类事件**不算**活动——429 限流风暴时 run 持续吐 error 事件，
  // 若刷新心跳，"无活动超时"永不触发（商城实验实锤：测试 run 挂 35 分钟+）。
  agent.subscribe((heartbeatEvt: any) => {
    const et = String(heartbeatEvt?.type || '')
    if (/error|retry|abort/i.test(et)) return
    if (runMap!.has(runId) && !state.suspended) { state.last = Date.now(); schedule() }
  })
  // 权限卡挂起/恢复接口（runSubAgent 在 beforeToolCall 前后调用）
  return {
    disarm: () => {
      if (state.timer) clearTimeout(state.timer)
      runMap?.delete(runId)
      notifySubAgentsIdleIfEmpty(ctx.sessionId)   // ★1005：最后一个 run 收尾 → 通知会话层置 idle
    },
    suspend: () => {
      if (state.suspended) return
      state.suspended = true
      if (state.timer) { clearTimeout(state.timer); state.timer = null }
      // 硬上限顺延：挂起时长不计入
      state.started += Date.now() - state.last
    },
    resume: () => {
      if (!state.suspended) return
      state.suspended = false
      state.last = Date.now()
      schedule()
    },
  }
}

// ============================================================================
// 运行时上下文（server.ts 注入，避免本文件反向依赖 server 内部状态）
// ============================================================================

/** 从子 agent 消息序列构建按时间穿插的 segments（思考/正文/工具真实顺序，前端回放用）。
 *  tool 段带 args（供前端推导团队交付物卡片：fs_write 的 path 是数据源） */
/** 成员 run 的 usage 快照（带缓存维度——LongCat 缓存命中后 usage.input 只报未命中部分，
 *  裸取 input 会把成员 token 统计压到近 0，与主 agent 胶囊口径对齐：input+cacheRead+cacheWrite） */
function memberUsageOf(msgs: any[]): { promptTokens: number; completionTokens: number; cacheReadTokens: number; cacheWriteTokens: number } | undefined {
  const m = [...msgs].reverse().find((x: any) => x?.role === 'assistant' && x?.usage && (x.usage.input || x.usage.output || x.usage.cacheRead || x.usage.cacheWrite))
  if (!m) return undefined
  const u = m.usage
  return {
    promptTokens: u.input ?? 0,
    completionTokens: u.output ?? 0,
    cacheReadTokens: u.cacheRead ?? 0,
    cacheWriteTokens: u.cacheWrite ?? 0,
  }
}

function buildRunSegments(msgs: any[]): Array<{ type: 'thinking' | 'text'; text: string } | { type: 'tool'; toolCallId?: string; name: string; status: string; result?: string; args?: any }> {
  const segs: Array<{ type: 'thinking' | 'text'; text: string } | { type: 'tool'; toolCallId?: string; name: string; status: string; result?: string; args?: any }> = []
  let cur: { type: 'thinking' | 'text'; text: string } | null = null
  for (const m of msgs) {
    if (m?.role === 'assistant' && Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b?.type === 'thinking' && b.thinking) {
          if (!cur || cur.type !== 'thinking') { cur = { type: 'thinking', text: '' }; segs.push(cur) }
          cur.text += b.thinking
        } else if (b?.type === 'text' && b.text) {
          if (!cur || cur.type !== 'text') { cur = { type: 'text', text: '' }; segs.push(cur) }
          cur.text += b.text
        } else if (b?.type === 'toolCall' && b.name) {
          cur = null
          segs.push({ type: 'tool', toolCallId: b.id, name: b.name, status: 'running', args: b.arguments })
        }
      }
    } else if (m?.role === 'toolResult' && m.toolCallId) {
      cur = null
      const t = segs.find((s: any) => s.type === 'tool' && s.toolCallId === m.toolCallId) as any
      if (t) {
        t.status = m.isError ? 'error' : 'done'
        t.result = (Array.isArray(m.content) ? m.content : []).filter((c: any) => c?.type === 'text').map((c: any) => c.text).join('\n').slice(0, 160)
      }
    }
  }
  // 未回填结果的工具（中断）保持 running → 标 error
  for (const s of segs) {
    if ((s as any).type === 'tool' && (s as any).status === 'running') (s as any).status = 'error'
  }
  return segs
}

export interface ModelOverride {
  providerId: string
  providerName: string
  base: string
  apiKey: string
  model: string
  /** 0910 协议扩展：成员独立模型随供应商带协议（createStreamFn 据此路由适配器） */
  protocol?: 'openai-completions' | 'anthropic-messages' | 'google-generative-ai'
}

export interface TeamCtx {
  sessionId: string
  team: TeamDef
  /** SSE 帧广播（bind broadcastMux） */
  broadcast: (frame: Record<string, any>) => void
  /** 会话执行日志（bind sessionLog） */
  log: (level: 'info' | 'warn' | 'error', category: 'lifecycle' | 'tool' | 'session' | 'approval', message: string, data?: any) => void
  /** 成员可用工具池（fs/记忆/联网/技能/询问，cwd=会话工作区；成员按预设白名单过滤）
   *  0910 二批 F：可选 actor 参数按实例捕获文件快照署名（并发多实例互不覆盖）
   *  0911 反馈③：可选 lock 参数按实例注入文件写锁（owner=runId；并行成员写同一文件时互斥） */
  buildMemberToolPool: (actor?: string, lock?: { owner: string; label: string }) => AgentTool<any>[]
  /** 子 agent 流工厂（包装 createStreamFn：成员模型覆盖 + 可配推理挡位（member.effort，缺省 deep）+ 中断信号桥接） */
  createSubStreamFn: (systemPrompt: string, override: ModelOverride | null, signal?: AbortSignal, effort?: string, actor?: string, onStreamNote?: (n: { kind: string; attempt: number; reason: string }) => void) => (model: unknown, context: any) => any
  /** 成员独立模型解析（失效返回 null，运行时回退共享模型并告警） */
  resolveMemberModel: (member: TeamMember) => ModelOverride | null
  /** 0910 三批②：成员模型档位（fast/standard/strong）；capability=auto 或未设 → 按实际模型能力自动识别 */
  resolveMemberCapability: (member: TeamMember) => { level: 'fast' | 'standard' | 'strong'; auto: boolean }
  /** 会话级成员技能覆盖（新对话默认空数组；TeamMemberPanel 勾选保存到本会话） */
  memberSkills: (memberId: string) => string[]
  /** 成员写类工具审批门禁（fs_write/fs_delete/run_command → 复用主会话权限卡；"本会话允许"按工具名记忆） */
  approval: (toolName: string, args: any) => Promise<{ block: boolean; reason?: string } | undefined>
  /** 会话工作区 */
  workDir: () => string
  /** 会话当前使用的模型 id（跟随会话的成员也要能报出"实际跑的是哪个模型"，被中断的 run 也有标签） */
  sessionModel: () => string
  /** 计划同步（写 session.plan + broadcastPlan → 用户计划卡） */
  syncPlan: (items: Array<{ text: string; done: boolean }>) => void
  /** ★0929 P1（分身黑板互丢）：spawn_clone 完成后把本次 run 快照按 toolCallId 登记进
   *  session.subRuns（随会话落盘）——injectSubRuns 的 subRuns 兜底原来只认 team_dispatch，
   *  分身一直没登记 → 刷新/黑板被清后分身气泡无从恢复。server.ts 接线；不设=不登记（老行为）。 */
  registerSubRuns?: (toolCallId: string, runs: any[]) => void
  /** ★0930（分身改"即派即回"）：分身批次跑完后把「分身回归」摘要送回对话
   *  （streaming→steer 插话；空闲→自动拉起一轮；失败转待办）。server.ts 接线。 */
  notifyCloneDone?: (text: string) => void
  /** ★0929 P0：spawn_clone 异常中断路径兜底击杀失控分身 */
  abortSubAgents?: () => void

}

// ============================================================================
// 小工具
// ============================================================================

function truncate(s: unknown, n: number): string {
  const str = String(s ?? '')
  return str.length > n ? str.slice(0, n) + '…' : str
}

function memberName(team: TeamDef, memberId: string): string {
  const m = team.members.find(x => x.id === memberId)
  if (!m) return memberId
  /* ★ 0925w（实测"分身显示成团队成员名/预设名"）：优先用成员自带显示名（m.name）——
     分身场景正是靠它显示「小螺丝 分身N」；团队成员没填 name 时回退预设名（原行为）。 */
  return (m.name || '').trim() || readAgentPreset(m.preset)?.name || m.preset
}

/** 计划卡条目：[成员名] 步骤描述；running 的步骤带"进行中"标记（用户可见谁正在做哪条） */
function planItems(ctx: TeamCtx, bb: Blackboard): Array<{ text: string; done: boolean }> {
  return bb.steps.map(s => {
    let text = `[${memberName(ctx.team, s.owner)}] ${s.text}`
    if (s.status === 'running') text += `（${memberName(ctx.team, s.owner)} 正在做，第 ${s.attempts} 次）`
    else if (s.status === 'review') text += `（已完成，待审核）`
    else if (s.status === 'rejected') text += `（已打回：${s.feedback ? truncate(s.feedback, 40) : '需重做'}）`
    return { text, done: s.status === 'done' }
  })
}

function formatBB(bb: Blackboard): string {
  const steps = bb.steps.map(s => {
    const deps = s.deps.length ? `（依赖 ${s.deps.join('、')}）` : ''
    const extra: string[] = []
    if (s.result) extra.push(`产出：${truncate(s.result, 400)}`)
    if (s.artifacts?.length) extra.push(`产物：${s.artifacts.join('、')}`)
    if (s.feedback) extra.push(`打回反馈：${truncate(s.feedback, 200)}`)
    if (s.attempts > 1) extra.push(`已派发 ${s.attempts} 次`)
    return `- [${s.status}] ${s.id}（${s.owner}）${s.text}${deps}${extra.length ? '\n  ' + extra.join('\n  ') : ''}`
  }).join('\n')
  const findings = bb.findings.length
    ? bb.findings.slice(-10).map(f => `- [${f.by}] ${truncate(f.text, 240)}`).join('\n')
    : '（无）'
  return `# 黑板（${bb.teamId}）\n目标：${bb.goal}\n${bb.acceptance ? `总验收标准：${bb.acceptance}\n` : ''}计划：\n${steps}\n发现：\n${findings}${bb.finalResult ? `\n最终汇总：${truncate(bb.finalResult, 800)}` : ''}`
}

function broadcastBB(ctx: TeamCtx, bb: Blackboard): void {
  try {
    ctx.broadcast({ type: 'session/blackboard', sessionId: ctx.sessionId, blackboard: JSON.parse(JSON.stringify(bb)) })
  } catch { /* ignore */ }
}

/** 步骤依赖环检测（Kahn）：有环直接拒绝建计划 */
function detectCycle(steps: BlackboardStep[]): string | null {
  const indeg = new Map<string, number>()
  const out = new Map<string, string[]>()
  for (const s of steps) {
    indeg.set(s.id, s.deps.length)
    out.set(s.id, [])
  }
  for (const s of steps) {
    for (const d of s.deps) {
      out.get(d)?.push(s.id)
    }
  }
  const queue = steps.filter(s => (indeg.get(s.id) || 0) === 0).map(s => s.id)
  let visited = 0
  while (queue.length) {
    const id = queue.shift()!
    visited++
    for (const next of out.get(id) || []) {
      const v = (indeg.get(next) || 0) - 1
      indeg.set(next, v)
      if (v === 0) queue.push(next)
    }
  }
  return visited === steps.length ? null : steps.filter(s => (indeg.get(s.id) || 0) > 0).map(s => s.id).join('、')
}

// ============================================================================
// 子 agent 运行（用完即焚）
// ============================================================================

/* ★1010（实测反馈"刷新后分身计时归零/过程内容丢失/只剩最新的/停止键变发送"）：run 事件帧
 * 只广播不落盘，刷新后前端只能等新帧重建卡片（计时/segments 全归零）。这里按 runId 在内存里
 * 缓存事件帧，开窗/刷新时经 blackboard.read.activeRuns 下发，前端重放进 handleSubagentEvent
 * 原样重建。只活在进程内存：重启即清 = 永不产生僵尸"运行中"卡片（黑板快照僵尸前科见 1004 CPU 事故）。
 * ponytail: 每 run 留最近 400 帧、30 分钟过期——够刷新窗口用；更长回看走黑板终态快照。 */
const activeRunFrames = new Map<string, { sessionId: string; t: number; last: number; frames: Record<string, any>[] }>()
const RUN_FRAME_CAP = 400
const RUN_FRAME_TTL_MS = 30 * 60 * 1000
export function bufferRunFrame(frame: Record<string, any>): void {
  const rid = String(frame?.runId || ''); const sid = String(frame?.sessionId || '')
  if (!rid || !sid) return
  /* ★1005：过期清理原来**只**写在 listActiveRunFrames 里（= 只有被读到才清）——
     没人读就一直堆着（run 数无上界）。这里按同一口径顺手清一遍：每帧 O(条目数)，量级极小。 */
  const _now = Date.now()
  for (const [k, v] of activeRunFrames) if (_now - v.last > RUN_FRAME_TTL_MS) activeRunFrames.delete(k)
  let e = activeRunFrames.get(rid)
  if (!e) { e = { sessionId: sid, t: Date.now(), last: Date.now(), frames: [] }; activeRunFrames.set(rid, e) }
  e.last = Date.now()
  e.frames.push(frame)
  if (e.frames.length > RUN_FRAME_CAP) e.frames = e.frames.slice(-RUN_FRAME_CAP)
}
export function listActiveRunFrames(sessionId: string): Array<{ runId: string; t: number; frames: Record<string, any>[] }> {
  const now = Date.now()
  for (const [rid, e] of activeRunFrames) if (now - e.last > RUN_FRAME_TTL_MS) activeRunFrames.delete(rid)
  const out: Array<{ runId: string; t: number; frames: Record<string, any>[] }> = []
  for (const [rid, e] of activeRunFrames) if (e.sessionId === sessionId) out.push({ runId: rid, t: e.t, frames: e.frames })
  return out
}

export async function runSubAgent(
  ctx: TeamCtx,
  bb: Blackboard,
  step: BlackboardStep,
  member: TeamMember,
  runId: string,
  taskText: string,
  acceptance: string,
): Promise<void> {

  // ★1010 事件帧缓存（一处包装覆盖本 ctx 全部 broadcast 调用点；帧自带 runId 分账）
  if (!(ctx.broadcast as any).__runBuffer) {
    const _bc = ctx.broadcast.bind(ctx)
    const wrapped = (frame: Record<string, any>) => { try { bufferRunFrame(frame) } catch { /* ignore */ }; _bc(frame) }
    ;(wrapped as any).__runBuffer = true
    ctx.broadcast = wrapped
  }
  const mName = memberName(ctx.team, member.id)
  const preset = readAgentPreset(member.preset)
  if (!preset) throw new Error(`成员预设不存在：${member.preset}`)

  // ── 精准上下文打包（定稿八）：团队清单 + 黑板快照 + 任务单 ──
  const roleText = String(member.role || preset.description || '').trim() || '（见任务单）'
  const teamList = ctx.team.members
    .map(m => `- ${m.id} ${memberName(ctx.team, m.id)}：${truncate(readAgentPreset(m.preset)?.description || '', 80)}`)
    .join('\n')
  const depText = step.deps.map(depId => {
    const d = bb.steps.find(s => s.id === depId)
    return `- ${depId}：${truncate(d?.result || '(无产出摘要)', 1200)}`
  }).join('\n') || '（无前置依赖）'
  const findingsText = bb.findings.slice(-8).map(f => `- [${f.by}] ${truncate(f.text, 240)}`).join('\n') || '（无）'

  let sys = `你是「${mName}」，NIS 团队「${ctx.team.name}」的专职成员（一次性实例，完成任务即销毁）。
你的唯一职责：${truncate(roleText, 400)}

工作纪律：
- 只做任务单内的事，不越职责边界；不做团队派发/管理类工作（没有这些工具）
- 当前工作目录是会话工作区：${ctx.workDir()}——产出文件一律写在这里（相对路径）
${(Array.isArray(preset.tools) ? preset.tools : []).includes('sub_plan') ? '- 接到任务先自列执行计划：用 sub_plan 把任务拆成 3~6 条可核对的小步骤（复杂任务必做；一句话能做完的简单任务可跳过），然后逐条执行、完成一条就更新它的 done 状态（全量重写）\n' : ''}${(() => { try { return fs.existsSync(path.join(ctx.workDir(), 'NIS-notes.md')) ? '- 工作区有项目档案 NIS-notes.md（项目背景/进度/约定），开工前先读它对齐上下文\n' : '' } catch { return '' } })()}- 完成或遇阻都必须用 bb_write 汇报：result 用 3~6 句话写清产出摘要（做了什么/结果如何/关键决策），有产物文件把相对路径写进 artifacts（分号分隔）
- 遇到无法完成：照常 bb_write，在 result 里写明障碍与已尝试的方案，不要编造完成
- 对其他成员有用的中间结论，用 bb_write 的 finding 参数随时记录

# 团队成员（只读参考，无法互相联系）
${teamList}

# 黑板快照（唯一事实源）
目标：${truncate(bb.goal, 300)}
${bb.acceptance ? `总验收标准：${truncate(bb.acceptance, 300)}\n` : ''}计划进度：
${bb.steps.map(s => `- [${s.status}] ${s.id}（${s.owner}）${truncate(s.text, 120)}`).join('\n')}
已有发现：
${findingsText}

# 你的任务单
步骤：${step.id}
任务描述：${truncate(step.text, 500)}
任务单（指挥官打包）：${truncate(taskText, 2000)}
${acceptance ? `本步骤验收标准：${truncate(acceptance, 600)}` : ''}
${step.feedback ? `上一次打回反馈（务必解决）：${truncate(step.feedback, 400)}\n` : ''}${step.deps !== undefined && step.deps.length ? `前置依赖产出（可直接使用）：
${depText}` : ''}
汇报纪律：bb_write 是唯一汇报通道，口头返回无效。`

  // ── 工具：成员预设白名单 + 受限 bb_write（只能汇报自己的步骤） ──
  const whitelist = Array.isArray(preset.tools) ? preset.tools : []
  // 最终汇报标记：bb_write 写入 result（产出摘要）= 任务完成终点。
  // 之后 shouldStopAfterTurn 直接停——模型常在"汇报完成"后仍反复调用 bb_write
  // （实锤：单 run 连调 5-7 次、每次隔 4-12s 全是完整 LLM 轮，"汇报很久"的根因）。
  // 必须在 buildSubWriteTool 之前声明（闭包引用，声明在 Agent 构造后会 TDZ）
  const reportState: { final: boolean; id: string; summary: string } = { final: false, id: Math.random().toString(36).slice(2, 8), summary: '' }
  // 0911 三批：30 轮硬停前先给一次"收尾汇报"机会（此前直接闷头停 → 主 agent 当"未汇报"重派，白耗打回配额）
  const roundGrace: { used: boolean } = { used: false }
  // 0911 反馈3：LLM 流式重试/报错事件（透传前端实时显示；收尾并入 segments 随 run 落盘）
  const streamNotes: Array<{ kind: string; attempt: number; reason: string }> = []
  // 0911 三批：注释类事件 → error 段（模型重试/恢复 + 巡检，两类共用；收尾与击杀两条路径都并入 segments）
  const notesToSegments = () => streamNotes.map(n => ({
    type: 'error' as const,
    text: n.kind === 'inspector'
      ? n.reason
      : `模型调用${n.kind === 'retry' ? `重试（第 ${n.attempt} 次）` : n.kind === 'recovered' ? '已恢复' : '多次重试后失败'}${n.reason ? `：${n.reason.slice(0, 160)}` : ''}`,
  }))
  // bb_write 限流状态：必须与 reportState 一样在 buildSubWriteTool 之前声明并传参——
  // 工具工厂是模块级函数，闭包捕获不到 runSubAgent 的局部变量（0901 实锤：execute 引用
  // 未传参的 bbWrites → ReferenceError，成员所有 bb_write 汇报报"bbWrites is not defined"，
  // 步骤 result 却被主 agent 审核路径代写，把故障掩盖）
  const bbWriteState: { writes: number; limit: number } = { writes: 0, limit: 4 }
  // 成员自列计划状态（0910 反馈4）：run 内私有的子任务清单，随 run 快照落黑板 → 刷新可回放。
  // 与主 agent 的 plan_write 区分：不碰会话计划卡（那是指挥官的），只在自己气泡里显示。
  const subPlanState: { items: Array<{ text: string; done: boolean }> } = { items: [] }
  // 0910 二批 F：署名不再用全局 setSnapshotActor（并发多实例会互相覆盖署名），
  // 改为构建工具池时按实例闭包捕获（ctx.buildMemberToolPool(mName)）
  // 0911 反馈③：同时按实例注入文件写锁（owner=本 run 的 runId）——并行成员写同一文件互斥
  const memberTools = ctx.buildMemberToolPool(mName, { owner: runId, label: mName }).filter(t => whitelist.includes(t.name))
  // 实时广播成员计划（前端成员气泡里的清单即时更新；run 结束时随快照一并落黑板）
  const emitSubPlan = (items: Array<{ text: string; done: boolean }>) => {
    try {
      ctx.broadcast({
        type: 'session/subagent-event', sessionId: ctx.sessionId, runId, stepId: step.id,
        memberId: member.id, memberName: mName, seq: ++seq,
        event: { type: 'sub_plan', plan: items },
      })
    } catch { /* ignore */ }
  }
  // 0910 二批修正（用户拍板）：sub_plan 由成员预设勾选控制——原先无条件追加，与预设编辑/工具页的
  // 勾选语义冲突（"没勾选却有功能"）；现在勾了才挂载，系统提示的列计划指引也同步条件化
  const tools = [...memberTools, buildSubWriteTool(ctx, bb, step, mName, reportState, bbWriteState)]
  if (whitelist.includes('sub_plan')) tools.push(buildSubPlanTool(subPlanState, emitSubPlan))

  // 技能提示（会话级技能覆盖，新对话默认空——团队配置不再携带技能）
  const memberSkillList = ctx.memberSkills(member.id)
  if (memberSkillList.length > 0 && tools.some(t => t.name === 'use_skill')) {
    sys = sys + `\n可用技能：${memberSkillList.join('、')}（需要时用 use_skill 加载指令）`
  }

  // ── 模型：independent 解析失败回退 shared ──
  // 0910 反馈5：回退必须"可见"——除了日志，把结果带进 run 快照（前端气泡显示"独立模型不可用，已回退"），
  // team_info 也会标注不可用，避免"设了独立模型却在跑会话模型"静默发生
  let override: ModelOverride | null = null
  let modelFallback = false
  if (member.modelMode === 'independent') {
    override = ctx.resolveMemberModel(member)
    if (!override) {
      modelFallback = true
      ctx.log('warn', 'session', `[团队] 成员 ${mName} 独立模型（${member.modelId}）解析失败（该模型不在任何已配置可用供应商中），本次回退共享模型`)
    }
  }
  const memberEffort = String((member as any).effort || '').trim()
  // 0910 反馈3：成员气泡上的模型名必须与用户在成员面板里选的**同步**。
  // 独立模型 = 配置的那个 id（解析成功用它、回退时仍显示配置值 + 已回退徽标）；
  // 跟随会话 = 空（前端沿用响应里的会话模型名），不再让"网关回包里的 model 字段"冒充成员模型。
  const effectiveModelId = member.modelMode === 'independent'
    ? String(member.modelId || '').trim()
    : String(ctx.sessionModel?.() || '').trim()  // 跟随会话：把会话模型 id 也写进记录（中断时气泡仍有标签）

  // ── 中断控制器：session.cancel → abortSubAgents → ac.abort() → LLM 流即时断开 ──
  const ac = new AbortController()

  const agent = new Agent({
    // signal 桥接（铁律 21）：pi 的 abort signal 在 streamFn 第三参 config.signal 里，
    // opts.signal（=ac.signal）是本子 agent 的中断控制器。用 AbortSignal.any 合流——
    // 包装层不得把 ac.signal 塞进 context（第二参）丢掉 pi 的 signal（点停止后子 agent 继续跑的根因）
    streamFn: (model: unknown, context: any, config?: { signal?: AbortSignal }) => {
      const signals = [ac.signal, config?.signal].filter(Boolean) as AbortSignal[]
      const merged = signals.length > 1 ? AbortSignal.any(signals) : signals[0]
      // 0911 反馈3：成员名归因 + 重试事件透传（气泡过程块显示报错/重连；run 记录留存）
      return ctx.createSubStreamFn(sys, override, merged, memberEffort || undefined, mName, (note) => {
        streamNotes.push(note)
        try {
          ctx.broadcast({
            type: 'session/subagent-event', sessionId: ctx.sessionId, runId, stepId: step.id,
            memberId: member.id, memberName: mName, seq: ++seq,
            event: { type: 'stream_note', ...note },
          })
        } catch { /* ignore */ }
      })(model, context)
    },
    // 工具结果回执走 pi-ai 适配器原生 role:"tool" 转换（压平 hack 已退役，与主 agent 一致）
    initialState: { systemPrompt: sys, tools },
    sessionId: `${ctx.sessionId}/sub/${runId.slice(0, 8)}`,
    finishTurn: toFinishTurn((c: any) => {
      // pi 0.84.x 回调参数是 {message, toolResults, context, newMessages}——没有 messages 字段
      // （c.messages 恒为 undefined → 熔断从未生效，实测单成员刷 107 次 bb_write）。取全量上下文判定
      // 只看本轮新增消息，避免历史上下文触发成员熔断。
      const msgs = Array.isArray(c?.newMessages) ? c.newMessages : []
      // 最终汇报收敛：bb_write 带 result（产出摘要）的调用出现 ≥1 次即停。
      // 模型常在"汇报完成"后仍反复调用（实锤：单 run 连调 5-7 次，每次都是完整 LLM 轮，
      // "汇报很久"的根因）。直接从上下文消息里判——不依赖 execute 置位/闭包状态
      for (const m of msgs) {
        if (m.role !== 'assistant' || !Array.isArray(m.content)) continue
        for (const b of m.content) {
          if (b.type === 'toolCall' && b.name === 'bb_write' && b.arguments?.result) return true
        }
      }
      const toolRounds = msgs.filter((m: any) =>
        m.role === 'assistant' && Array.isArray(m.content) && m.content.some((b: any) => b.type === 'toolCall'))
      // 0911 三批：30 轮不再是"闷头硬停"——先给一轮收尾汇报机会（bb_write 汇报后由上方规则自然停），
      // 仍不汇报才硬停。消除"硬停→无摘要→主 agent 当未汇报重派→白耗打回配额"的空转。
      if (toolRounds.length >= 30) {
        if (!roundGrace.used && !reportState.final) {
          roundGrace.used = true
          try {
            agent.steer({
              role: 'user',
              content: [{ type: 'text', text: '【巡检】本轮工具调用已达上限（30 轮）。请立刻用 bb_write 汇报：①已完成什么、产出文件路径 ②未完成什么、阻塞点。汇报后立即结束，不要再开新的工具调用。' }],
              timestamp: Date.now(),
            } as any)
          } catch { /* ignore */ }
          ctx.log('warn', 'lifecycle', `[团队] ${mName} 工具轮达 30 上限——已注入收尾指令，允许一轮汇报后停止`)
          return false
        }
        return true
      }
      // 通用重复熔断：同工具、同参数且同结果连续第 5 次才停；结果变化说明有进展。
      const resultByCall = new Map<string, unknown>()
      for (const m of msgs) {
        if (m.role === 'toolResult' && m.toolCallId) resultByCall.set(String(m.toolCallId), m.content ?? m.result ?? '')
      }
      const calls: Array<{ sig: string; result: unknown }> = []
      for (const m of msgs) {
        if (m.role !== 'assistant' || !Array.isArray(m.content)) continue
        for (const b of m.content) {
          if (b.type !== 'toolCall') continue
          let argsSig = ''
          try { argsSig = JSON.stringify(b.arguments ?? {}).replace(/\s+/g, '').slice(0, 120) } catch { argsSig = '' }
          const callId = String(b.id || b.toolCallId || '')
          if (!callId || !resultByCall.has(callId)) continue
          calls.push({ sig: `${b.name}:${argsSig}`, result: resultByCall.get(callId) })
        }
      }
      let run = 0
      let prev: string | null = null
      for (const call of calls) {
        let resultSig = ''
        try { resultSig = JSON.stringify(call.result).replace(/\s+/g, '').slice(0, 240) } catch { resultSig = String(call.result).slice(0, 240) }
        const key = `${call.sig}:${resultSig}`
        run = key === prev ? run + 1 : 1
        prev = key
        if (run >= 5) {
          const toolName = call.sig.split(':')[0]
          ctx.log('error', 'lifecycle', `循环熔断：${toolName} 参数和结果均未变化，连续第 ${run} 次，已硬停止本轮执行`, { guard: 'hard-stop', tool: toolName, repeat: run })
          return true
        }
        if (run === 4) {
          const toolName = call.sig.split(':')[0]
          ctx.log('warn', 'lifecycle', `循环预警：${toolName} 参数和结果均未变化，已连续第 4 次；这是软提醒，下一次仍重复才会停止`, { guard: 'soft-warning', tool: toolName, repeat: run })
        }
      }
      return false
    }),
    // 写类工具走主会话审批门禁（成员的 fs_write/fs_delete/run_command 弹权限卡，
    // "当前会话允许"按工具名记忆——批准一次后同类放行）；其余（读/搜索/汇报）免审。
    // 审批等待期间挂起看门狗（等待无心跳，用户可能长时间不在线——审批自带 10 分钟超时不会永久挂）
    beforeToolCall: async (tctx: any) => {
      ctx.log('info', 'tool', `[${mName}] ${tctx.toolCall.name} ${truncate(JSON.stringify(tctx.args ?? {}), 120)}`)
      // 无差别进程杀伤硬拦截（0902 事故：成员跑 taskkill /IM node.exe 团灭 pi-bridge/vite）。
      // 放在写类审批之前：full_access 模式下主会话审批门禁直接放行，成员侧必须自拦
      if (tctx.toolCall.name === 'run_command') {
        const kill = matchIndiscriminateKillCommand(String(tctx.args?.command || ''))
        if (kill) {
          ctx.log('error', 'approval', `[${mName}] 已拦截无差别进程杀伤命令：${kill.cmd}`)
          return { block: true, reason: `命令「${kill.cmd}」会按映像名杀掉所有 ${kill.image} 进程（包括 NIS 后端自身）。请用 taskkill /F /PID <具体进程号> 指定进程，或用其他方式停止你启动的测试服务。` }
        }
      }
      if (['fs_write', 'fs_delete', 'run_command'].includes(tctx.toolCall.name)) {
        watchdog.suspend()
        try {
          // 权限申请必须留痕（权限筛选可见）——之前成员弹卡用户在日志里看不到来源（0901 反馈 #5）
          ctx.log('warn', 'approval', `[团队] 成员 ${mName} 请求授权：${tctx.toolCall.name}`)
          const r = await ctx.approval(tctx.toolCall.name, tctx.args)
          if (r?.block) {
            ctx.log('warn', 'approval', `[${mName}] ${tctx.toolCall.name} 被拒绝：${r.reason || '用户拒绝'}`)
            return { block: true, reason: r.reason }
          }
          ctx.log('info', 'approval', `[团队] 成员 ${mName} 的 ${tctx.toolCall.name} 已获授权/免审`)
        } finally {
          watchdog.resume()
        }
      }
      return undefined
    },
  })

  const set = subAgents.get(ctx.sessionId) ?? new Set<Agent>()
  set.add(agent)
  subAgents.set(ctx.sessionId, set)
  const acSet = subControllers.get(ctx.sessionId) ?? new Set<AbortController>()
  acSet.add(ac)
  subControllers.set(ctx.sessionId, acSet)

  // ── run 记录：开工即落盘（0910 反馈4：用户要求"后端不丢"，不接受前端兜底拼装）──
  // 旧实现只在 run 结束时 push 快照 → 派发途中后端被杀（用户实锤：重启后成员气泡消失）就全没了。
  // 现在：①开工写 status='running' ②订阅里节流增量更新（工具轨迹/分段/计划）③正常/看门狗/异常
  // 三条结束路径都**就地更新同一条记录** ④读侧 loadBlackboard 把残留 running 自愈成 'interrupted'
  // （带原因）——任何时刻进程被杀，都还留着"这个成员干了什么"。
  if (!Array.isArray((bb as any).runs)) (bb as any).runs = []
  const runRec: any = {
    runId, stepId: step.id, memberId: member.id, memberName: mName,
    /** 0913 头像批：成员预设 id —— 前端气泡按它取预设头像（未设置则回退默认头像） */
    memberPreset: member.preset,
    status: 'running', text: '', reasoning: '',
    tools: [], model: effectiveModelId || undefined,
    modelFallback: modelFallback || undefined,
    modelConfigured: member.modelMode === 'independent' ? String(member.modelId || '') : undefined,
    plan: undefined, segments: [],
    timing: { llmMs: 0 }, usage: undefined,
    t: Date.now(), startedAt: Date.now(),
  }
  ;(bb as any).runs.push(runRec)
  activeRunIds.add(runId)
  const persistRuns = () => {
    if ((bb as any).runs.length > 60) (bb as any).runs = (bb as any).runs.slice(-60)
    /* ★0929 P1 分流：分身板（${sessionId}#clone）各 run 各持副本跨 await 互写 ⇒ 走合并落盘；
       团队板是共享对象，保持原直写。 */
    if (String((bb as any).sessionId || '').endsWith('#clone')) saveBlackboardRunsMerged(bb)
    else saveBlackboard(bb)
  }
  persistRuns()

  // bb_write 限流：正常完成 2~3 次足够（result + 途中 finding）。刷屏 = 模型误解纪律，
  // 超限后工具报错并明示"立即结束"，防一轮烧几十次调用（测试3 曾单成员刷 40+ 次）。
  // 状态本体 bbWriteState 在上方（工具工厂之前）声明——此处只留时间戳
  const started = Date.now()

  // 看门狗：死循环/挂死检测，超时 abort 并把原因写进步骤（主 agent 收到后自行调整/打回/上抛）
  let watchdogReason: string | null = null
  const watchdog = armWatchdog(ctx, `${ctx.sessionId}/${runId}`, agent, (reason) => {
    watchdogReason = reason
    ctx.log('warn', 'session', `[团队] ${mName} ${reason}`)
  })
  // 0911 三批：巡检官（方向；与看门狗「死活」并行）——规则预筛即时评估，疑似才轻量复审；纠偏一次后仍异常则击杀
  let inspectorKillReason: string | null = null
  const inspector = armInspector({
    agent, memberName: mName, roleText, stepText: step.text, taskText, acceptance,
    log: (msg) => ctx.log('warn', 'session', `[团队·巡检] ${msg}`),
    note: (text) => {
      streamNotes.push({ kind: 'inspector', attempt: 1, reason: text })
      try {
        ctx.broadcast({
          type: 'session/subagent-event', sessionId: ctx.sessionId, runId, stepId: step.id,
          memberId: member.id, memberName: mName, seq: ++seq,
          event: { type: 'stream_note', kind: 'inspector', attempt: 1, reason: text },
        })
      } catch { /* ignore */ }
    },
    onKill: (reason) => { inspectorKillReason = reason },
  })
  // 子 agent 事件订阅（含透传 + bb_write 计数限流 + 工具轨迹记录）
  let seq = 0
  let lastRunSnap = 0
  /** 巡检官：tool_execution_end 不带参数 → 用 start 事件按 toolCallId 暂存参数对齐 */
  const pendingCallArgs = new Map<string, unknown>()
  /** 巡检官：sub_plan 的进展信号 = 完成项数增加（全量替换语义，可能减少，取历史最大） */
  let lastPlanDone = 0
  const toolLog: Array<{ name: string; status: string; result?: string }> = []
  /** 过程快照（节流 8s / 工具完成时强制）：把"此刻能看到的东西"写进 run 记录 */
  const snapshotRunProgress = (force = false) => {
    const now = Date.now()
    if (!force && now - lastRunSnap < 8000) return
    lastRunSnap = now
    try {
      const live = (agent.state.messages || []) as any[]
      const lastTextMsg = [...live].reverse().find(m => m?.role === 'assistant' && Array.isArray(m?.content) && m.content.some((c: any) => c.type === 'text' && c.text))
      const txt = lastTextMsg ? (lastTextMsg.content as any[]).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('') : ''
      runRec.text = txt.slice(0, 8000)
      runRec.tools = toolLog.slice(0, 40)
      runRec.segments = buildRunSegments(live)
      runRec.usage = memberUsageOf(live)
      runRec.timing = { llmMs: Date.now() - started }
      if (subPlanState.items.length) runRec.plan = subPlanState.items
      persistRuns()
    } catch { /* 快照失败不打断执行 */ }
  }
  agent.subscribe((event: any) => {
    if (event?.type === 'tool_execution_start') {
      if (event?.toolName === 'bb_write') bbWriteState.writes++
      // 巡检官：暂存参数（end 事件不带参数），按 toolCallId 对齐
      if (event?.toolCallId) pendingCallArgs.set(String(event.toolCallId), event.args)
    }
    if (event?.type === 'tool_execution_end' && event?.toolName) {
      const resText = (Array.isArray(event.result?.content) ? event.result.content : [])
        .filter((c: any) => c?.type === 'text').map((c: any) => c.text).join('\n').slice(0, 160)
      toolLog.push({
        name: event.toolName,
        status: event.isError ? 'error' : 'done',
        result: resText,
      })
      if (toolLog.length > 60) toolLog.splice(0, toolLog.length - 60)
      snapshotRunProgress(true)
      // 0911 三批：巡检官规则预筛（零模型成本；疑似才触发轻量复审）
      const cid = String(event.toolCallId || '')
      const argsRaw = pendingCallArgs.get(cid)
      pendingCallArgs.delete(cid)
      if (pendingCallArgs.size > 80) pendingCallArgs.clear()
      let argsStr = ''
      try { argsStr = JSON.stringify(argsRaw ?? {}).replace(/\s+/g, ' ').slice(0, 160) } catch { argsStr = '' }
      let progressOverride: boolean | undefined
      if (event.toolName === 'sub_plan') {
        const dn = subPlanState.items.filter((i: any) => i.done).length
        progressOverride = dn > lastPlanDone
        lastPlanDone = Math.max(lastPlanDone, dn)
      } else if (event.toolName === 'bb_write') {
        progressOverride = !event.isError
      }
      inspector.noteCall({ name: String(event.toolName), args: argsStr, result: resText, isError: !!event.isError, progressOverride })
    }
    try {
      ctx.broadcast({
        type: 'session/subagent-event', sessionId: ctx.sessionId, runId, stepId: step.id,
        memberId: member.id, memberName: mName, memberPreset: member.preset, seq: ++seq, model: effectiveModelId || undefined,
        modelFallback: modelFallback || undefined,
        modelConfigured: member.modelMode === 'independent' ? String(member.modelId || '') : undefined,
        event,
      })
    } catch { /* ignore */ }
  })

  /* ★0930 修（实测"点停止分身卡在过程态、根本停不掉"）：**用户中止要走击杀收尾** ——
     abort 后 prompt 会以异常/返回两种方式落地，这里统一记 wasAborted，收尾归入 killedReason
     路径（status=timeout → 前端映射 interrupted，气泡定稿）+ 气泡里落一条「用户已停止」。
     ★0930b（实测残留：停止后仍有 run 卡 running 十几分钟）：abort 后 prompt 偶发**不结算**
     （工具/流的某条等待路径不落地）⇒ 加 8s 强制结算兜底：中止起算 8 秒内必须落地走收尾，
     绝不留过程态僵尸 run。计时只在 abort 后起算，正常 run 零影响。 */
  let wasAborted = false
  let caughtErr: any = null
  const settleGuard = new Promise<never>((_, rej) => {
    const fire = () => setTimeout(() => rej(new Error('用户已停止')), 8000)
    if (ac.signal.aborted) void fire()
    else ac.signal.addEventListener('abort', () => { void fire() }, { once: true })
  })
  try {
    await Promise.race([agent.prompt(`开始执行你的任务单（步骤 ${step.id}）。完成后必须用 bb_write 汇报产出摘要与产物路径，然后立即结束（不要反复汇报）。`), settleGuard])
    wasAborted = ac.signal.aborted || !!(agent as any).signal?.aborted
  } catch (e) {
    /* ★0930d（实测残留 run 卡 running 的真凶之一）：abortSubAgents 先 abort **agent** 后 abort **ac**，
       prompt 在这个窗口里以 abort 错误落地时 ac.signal 还没置位 ⇒ 旧判定当它是真异常、跳过收尾
       ⇒ run 永远卡过程态。判定改为「两个信号任一 + 错误文本」三路兜（不放过中止，也不误吞真异常）。
       ★0930e（真凶之二，存量老洞）：**非中止异常旧代码直接 rethrow、跳过收尾** ⇒ runRec 永远 'running'
       （实测每批分身恰好一个卡过程态——就是它在 LLM 重试中抛错了）。现在先落收尾（status=error +
       错误段），再原样抛出，runCloneOnce 的失败链语义不变。 */
    const _m = String((e as any)?.message || e)
    wasAborted = ac.signal.aborted || !!(agent as any).signal?.aborted || /abort/i.test(_m)
    if (!wasAborted) caughtErr = e
  } finally {
    watchdog.disarm()
    inspector.disarm()
    set.delete(agent)
    acSet.delete(ac)
    activeRunIds.delete(runId)
    // 0911 反馈③：run 收尾释放文件写锁（含击杀/异常路径，finally 必到）
    releaseFileLocks(runId)
    ac.abort()
    try { agent.abort() } catch { /* ignore */ }
  }
  // 0911 三批：巡检官击杀与看门狗击杀同走此路径（先到者为准，实际不会同时发生）
  const killedReason = watchdogReason || inspectorKillReason || (wasAborted ? '用户已停止' : '')
  if (killedReason) {
    // 看门狗/巡检官击杀的 run 也要落快照：否则刷新后该成员气泡丢失（黑板步骤状态还在但 runs 缺失）
    const killedMsgs = (agent.state.messages || []) as any[]
    const killedUsage = memberUsageOf(killedMsgs)
    const killedModel = [...killedMsgs].reverse().find(m => m?.role === 'assistant' && m?.model)?.model
    Object.assign(runRec, {
      status: 'timeout', reasoning: '',
      tools: toolLog.slice(0, 40), model: effectiveModelId || killedModel,
      plan: subPlanState.items.length ? subPlanState.items : undefined,
      /* ★0930：用户中止时气泡尾部落「用户已停止」一行（需求要求的停止语义） */
      segments: [...buildRunSegments(killedMsgs), ...notesToSegments(), ...(wasAborted ? [{ type: 'text', text: '—— 用户已停止 ——' }] : [])],
      timing: { llmMs: Date.now() - started },
      usage: killedUsage,
      endedAt: Date.now(),
    })
    persistRuns()
    broadcastBB(ctx, bb)
    /* ★1004b 防僵尸三保险之③：击杀/中止路径补**终态事件帧** —— 原来只发黑板帧（broadcastBB），
     * 前端 subAgent 节点收不到终态 → 永卡 running（1004 CPU 满事故僵尸源头之一）。
     * interrupted 语义随帧下发（看门狗/巡检官/用户停止都算"被打断"，不是真 error）。 */
    try {
      ctx.broadcast({
        type: 'session/subagent-event', sessionId: ctx.sessionId, runId, stepId: step.id,
        memberId: member.id, memberName: mName, seq: ++seq,
        event: { type: 'error', message: killedReason, interrupted: true },
      })
    } catch { /* ignore */ }
    throw new Error(killedReason)
  }
  /* ★0930e：非中止异常的收尾 —— 先落盘+广播（status=error，气泡出错误段并定稿），
     再原样抛给 runCloneOnce 的失败链（step.result 语义不变）。 */
  if (caughtErr) {
    const errMsg = String((caughtErr as any)?.message || caughtErr)
    const errMsgs = (agent.state.messages || []) as any[]
    Object.assign(runRec, {
      status: 'error', text: errMsg.slice(0, 500), reasoning: '',
      tools: toolLog.slice(0, 40), model: effectiveModelId,
      plan: subPlanState.items.length ? subPlanState.items : undefined,
      segments: [...buildRunSegments(errMsgs), ...notesToSegments(), { type: 'error', text: errMsg.slice(0, 300) }],
      timing: { llmMs: Date.now() - started },
      usage: memberUsageOf(errMsgs),
      endedAt: Date.now(),
    })
    persistRuns()
    broadcastBB(ctx, bb)
    /* ★1004b 防僵尸三保险之③：异常路径同补终态事件帧（原只发黑板帧 → 前端节点永卡 running） */
    try {
      ctx.broadcast({
        type: 'session/subagent-event', sessionId: ctx.sessionId, runId, stepId: step.id,
        memberId: member.id, memberName: mName, seq: ++seq,
        event: { type: 'error', message: errMsg.slice(0, 300), interrupted: false },
      })
    } catch { /* ignore */ }
    throw caughtErr
  }

  // 终帧：本次 run 的 usage/timing（前端持久化统计用，刷新后可回看）
  const liveMsgs = (agent.state.messages || []) as any[]
  const lastUsageMsg = memberUsageOf(liveMsgs)
  const lastModel = [...liveMsgs].reverse().find(m => m?.role === 'assistant' && m?.model)?.model
  const finalText = [...liveMsgs].reverse().find(m => m?.role === 'assistant' && Array.isArray(m?.content) && m.content.some((c: any) => c.type === 'text' && c.text))
  const finalTextStr = finalText ? (finalText.content as any[]).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('') : ''
  const finalReasoning = [...liveMsgs].reverse().find(m => m?.role === 'assistant' && Array.isArray(m?.content) && m.content.some((c: any) => c.type === 'thinking' && c.thinking))
  const finalReasoningStr = finalReasoning ? (finalReasoning.content as any[]).filter((c: any) => c.type === 'thinking').map((c: any) => c.thinking).join('') : ''
  // run 记录收尾（就地更新开工时那条：后端权威，前端只读、不做兜底拼装）
  // 0910 三批：正文为空（成员只调 bb_write 汇报、没发正文）时用汇报摘要兜底，避免气泡空白
  const finalTextOut = finalTextStr.trim() ? finalTextStr : reportState.summary
  Object.assign(runRec, {
    status: 'done', text: finalTextOut.slice(0, 8000), reasoning: finalReasoningStr.slice(0, 4000),
    tools: toolLog.slice(0, 40), model: effectiveModelId || lastModel,
    // 0910 反馈4：成员自列计划（sub_plan）随 run 落盘，刷新后气泡里可回放
    plan: subPlanState.items.length ? subPlanState.items : undefined,
    // segments：按消息序记录（思考/正文/工具真实穿插），刷新后可按时间顺序回放；
    // 0911 反馈3/三批：LLM 重试/报错与巡检注释附在尾部（error 段），气泡回放可见"报错与重连过程 / 巡检记录"
    segments: [...buildRunSegments(liveMsgs), ...notesToSegments()],
    timing: { llmMs: Date.now() - started },
    usage: lastUsageMsg,
    endedAt: Date.now(),
  })
  persistRuns()
  try {
    ctx.broadcast({
      type: 'session/subagent-event', sessionId: ctx.sessionId, runId, stepId: step.id,
      memberId: member.id, memberName: mName, seq: ++seq,
      event: {
        type: 'agent_stats',
        model: effectiveModelId || lastModel,
        timing: { llmMs: Date.now() - started },
        usage: lastUsageMsg,
      },
    })
  } catch { /* ignore */ }
}

/** 子 agent 的自列计划工具（0910 反馈4：成员可自己拆子任务，弱模型靠清单稳住执行节奏）。
 *  与指挥官 plan_write 隔离：只进 run 快照（前端成员气泡里显示），不碰会话计划卡。
 *  全量替换语义；每次写入广播一帧 session/subagent-event（event.type='sub_plan'）供实时显示。 */
function buildSubPlanTool(state: { items: Array<{ text: string; done: boolean }> }, onUpdate?: (items: Array<{ text: string; done: boolean }>) => void): AgentTool<any> {
  return {
    name: 'sub_plan',
    label: '成员自列执行计划',
    description: '给自己列执行计划（子任务清单，最多 12 条）：开工前写下要做的 3~6 件小事，每完成一件就重写一次清单把对应项 done 置 true。全量替换语义（每次传完整清单）',
    parameters: Type.Object({
      items: Type.Array(Type.Object({
        text: Type.String({ description: '子任务描述（一句话，具体可核对）' }),
        done: Type.Optional(Type.Boolean({ description: '该子任务是否已完成（默认 false）' })),
      }), { description: '完整子任务清单（全量替换）' }),
    }),
    async execute(_callId, params: any) {
      const items = (Array.isArray(params?.items) ? params.items : [])
        .map((it: any) => ({ text: truncate(String(it?.text || '').trim(), 120), done: !!it?.done }))
        .filter((it: any) => it.text)
        .slice(0, 12)
      if (!items.length) throw new Error('items 不能为空：传完整子任务清单（text 必填）')
      state.items = items
      try { onUpdate?.(items) } catch { /* ignore */ }
      const doneN = items.filter(i => i.done).length
      return {
        content: [{ type: 'text', text: `计划已更新（${doneN}/${items.length} 完成）。按清单推进；全部完成后用 bb_write 汇报产出摘要。` }],
        details: { ok: true, items, done: doneN, total: items.length },
      }
    },
  }
}

/** 子 agent 的受限 bb_write：只能写自己步骤的 result/artifacts 与团队 findings。
 *  reportState.final 在写入 result（最终汇报）时置位 → shouldStopAfterTurn 终止 run。
 *  bbWriteState：限流计数（writes）+ 上限（limit），由 runSubAgent 传入——
 *  本函数是模块级工厂，不能直接引用 runSubAgent 局部变量（bbWrites 事故根因） */
function buildSubWriteTool(ctx: TeamCtx, bb: Blackboard, step: BlackboardStep, mName: string, reportState: { final: boolean; summary: string }, bbWriteState: { writes: number; limit: number }): AgentTool<any> {
  return {
    name: 'bb_write',
    label: '汇报黑板',
    description: '任务完成/有发现时写黑板（唯一汇报通道）：result 写产出摘要（3~6 句），artifacts 写产物相对路径（可选），finding 写对团队有用的发现（可选，可多次调用）',
    parameters: Type.Object({
      result: Type.Optional(Type.String({ description: '产出摘要（3~6 句：做了什么/结果如何/关键决策）' })),
      artifacts: Type.Optional(Type.String({ description: '产物文件相对路径，多个用分号分隔' })),
      finding: Type.Optional(Type.String({ description: '对其他成员有用的中间发现（可多次写）' })),
    }),
    async execute(_callId, params: any) {
      const result = String(params?.result || '').trim()
      const finding = String(params?.finding || '').trim()
      if (!result && !finding) throw new Error('result 与 finding 至少写一个')
      // 限流：超过次数拒绝并强令结束（防 bb_write 死循环刷屏；测试3 单成员曾刷 40+ 次）
      if (bbWriteState.writes > bbWriteState.limit) {
        return {
          content: [{ type: 'text', text: `【提示，非失败】黑板汇报已达上限（${bbWriteState.limit} 次），你的产出此前已成功记录——这不是错误。现在立即结束任务：不要再调用任何工具，直接结束回复。` }],
          details: { limited: true },
        }
      }
      if (result) {
        // 最终汇报完成 → run 终点。置位必须最先做：后续 saveBlackboard/broadcast 任一抛错
        // 都不能让 run 继续循环（0831 深夜实锤：置位放在副作用之后，异常路径 final 恒 false，
        // 成员"汇报完成"后仍连调 4-7 次 bb_write，每次都是完整 LLM 轮）
        reportState.final = true
        // 0910 三批：产出摘要留一份在 run 上——成员常常"只调 bb_write、不发正文"，
        // 气泡正文就空了（用户反馈"子 agent 回复一条内容都没有"）。收尾时正文为空则兜底用它。
        reportState.summary = result
        step.result = truncate(result, 2000)
        const arts = String(params?.artifacts || '').split(/[;；\n]/).map(s => s.trim()).filter(Boolean)
        step.artifacts = arts.length ? arts.slice(0, 10) : undefined
      }
      if (finding) {
        bb.findings.push({ t: Date.now(), by: mName, text: truncate(finding, 600) })
        if (bb.findings.length > 30) bb.findings = bb.findings.slice(-30)
      }
      step.updatedAt = Date.now()
      try {
        saveBlackboard(bb)
        broadcastBB(ctx, bb)
      } catch (e: any) {
        ctx.log('warn', 'session', `[${mName}] 黑板落盘/广播异常（汇报仍有效）: ${e?.message || e}`)
      }
      ctx.log('info', 'tool', `[${mName}] bb_write（${result ? `result ${result.length} 字` : ''}${result && finding ? ' + ' : ''}${finding ? 'finding' : ''}）`)
      if (result) {
        ctx.log('info', 'session', `[${mName}] 最终汇报已写入黑板，本次任务结束（final=${reportState.final}）`)
        return {
          content: [{ type: 'text', text: '黑板已更新，最终汇报已记录——这就是任务终点。运行系统会自动结束本次执行，无需你再做任何事。' }],
          details: { ok: true, final: true },
        }
      }
      return {
        content: [{ type: 'text', text: '发现已记录，继续你的工作。' }],
        details: { ok: true },
      }
    },
  }
}

/** 单步骤派发（同步阻塞：内部 await 子 agent 跑完） */
async function runStepTask(ctx: TeamCtx, bb: Blackboard, t: any): Promise<any> {
  const step = bb.steps.find(s => s.id === String(t.stepId || ''))!
  const member = ctx.team.members.find(m => m.id === String(t.memberId || ''))!
  const mName = memberName(ctx.team, member.id)

  // 打回上限：累计 3 次派发后拒绝（打回 ≤2）
  if (step.attempts >= 3) {
    return {
      stepId: step.id, memberId: member.id, memberName: mName, blocked: true,
      reason: `步骤 ${step.id} 已派发 ${step.attempts} 次仍未达标（打回上限 2 次）——停止循环，把各次产出对比呈现给用户请求定夺`,
    }
  }

  const runId = crypto.randomUUID()
  step.attempts += 1
  step.runId = runId
  step.status = 'running'
  step.updatedAt = Date.now()
  saveBlackboard(bb)
  ctx.syncPlan(planItems(ctx, bb))
  broadcastBB(ctx, bb)
  ctx.log('info', 'session', `[团队] 派发 ${step.id} → ${mName}（第 ${step.attempts} 次）`)

  const started = Date.now()
  try {
    await runSubAgent(ctx, bb, step, member, runId, String(t.task || ''), String(t.acceptance || ''))
  } catch (e: any) {
    step.status = 'failed'
    step.updatedAt = Date.now()
    saveBlackboard(bb)
    ctx.syncPlan(planItems(ctx, bb))
    ctx.log('error', 'tool', `[团队] 成员 ${mName} 执行步骤 ${step.id} 异常：${e?.message || e}`)
    return { stepId: step.id, memberId: member.id, memberName: mName, status: 'failed', attempts: step.attempts, result: `(执行异常：${e?.message || e})` }
  }
  step.status = 'review'
  step.updatedAt = Date.now()
  saveBlackboard(bb)
  ctx.syncPlan(planItems(ctx, bb))
  ctx.log('info', 'session', `[团队] 成员 ${mName} 完成步骤 ${step.id}，待审核（${((Date.now() - started) / 1000).toFixed(1)}s）`)
  return {
    stepId: step.id, memberId: member.id, memberName: mName, status: 'review',
    attempts: step.attempts, result: step.result || '', artifacts: step.artifacts || [],
  }
}

// ============================================================================
// 指挥官工具集（team-lead 主 agent 挂载）
// ============================================================================

export function buildTeamTools(ctx: TeamCtx): AgentTool<any>[] {
  return [
    // ── team_dispatch：派发成员（数组参数 + deps 硬校验 + maxParallel 分批并行） ──
    {
      name: 'team_dispatch',
      label: '派发任务',
      description: '把任务单派发给成员（同步等待成员完成并返回产出摘要）。参数 tasks 数组一次可派多个=并行（实际并行数 = min(团队并行总预算, 各成员并行上限之和, 待派数)，超出自动分批）。派发前必须先 bb_goal 写计划；步骤 deps 前置未 done 会被硬拒绝；打回用 bb_write(status=rejected) 后重新派发（同一任务最多 3 次）。派活难度要与成员档位匹配（档位/忙闲见 team_info：fast 档给边界清晰的小任务，strong 档给复杂任务；优先派给空闲成员）',
      parameters: Type.Object({
        tasks: Type.Array(Type.Object({
          stepId: Type.String({ description: '黑板计划里的步骤 id' }),
          memberId: Type.String({ description: '成员 id（team_info 查清单）' }),
          task: Type.String({ description: '任务单：目标+边界+注意事项（精准打包；重做时必须带上打回 feedback 的解决要求）' }),
          acceptance: Type.Optional(Type.String({ description: '本步骤验收标准（逐条可检验）' })),
        }), { description: '要派发的任务（数组，一次可多个=并行）' }),
      }),
      async execute(_callId, params: any) {
        const tasks = Array.isArray(params?.tasks) ? params.tasks : []
        if (tasks.length === 0) throw new Error('tasks 不能为空')
        if (tasks.length > 12) throw new Error('单次最多派发 12 项——更多请分批（留出审核间隙）')
        const bb = loadBlackboard(ctx.sessionId)
        if (!bb || !bb.goal) throw new Error('黑板为空：先用 bb_goal 写入目标与计划，再派发。若属简单修改（单文件小改），可直接用 fs_write 完成，无需派发')
        // 结构/owner/依赖 硬校验（任一不过 → 整次拒绝，零副作用）
        for (const t of tasks) {
          const step = bb.steps.find(s => s.id === String(t?.stepId || ''))
          if (!step) throw new Error(`步骤不存在：${t?.stepId}。用 bb_read 查看当前计划`)
          const member = ctx.team.members.find(m => m.id === String(t?.memberId || ''))
          if (!member) throw new Error(`成员不存在：${t?.memberId}。可用成员：${ctx.team.members.map(m => `${m.id}(${memberName(ctx.team, m.id)})`).join('、')}`)
          if (step.owner !== member.id) throw new Error(`步骤 ${step.id} 的 owner 是 ${step.owner}(${memberName(ctx.team, step.owner)})，不能派给 ${member.id}——修正计划（bb_goal）或改派对的成员。owner 必须与成员职责匹配，不要为凑数派给不相关成员`)
          if (step.status === 'done') throw new Error(`步骤 ${step.id} 已 done，无需重复派发。若属简单修改想直接调整，可用 fs_write 完成，无需派发`)
          for (const dep of step.deps) {
            const d = bb.steps.find(s => s.id === dep)
            if (!d) throw new Error(`步骤 ${step.id} 依赖的 ${dep} 不在计划里`)
            if (d.status !== 'done') throw new Error(`依赖硬校验失败：步骤 ${step.id} 依赖的 ${dep} 状态是 ${d.status}（需 done）——先等前置完成或修正计划`)
          }
        }
        // 并行预算（0910 三批③）：总闸 maxParallel(1-8) ∧ 各成员同时实例上限(1-3，缺省1) ∧ 待派数。
        // 做法=按成员分桶后逐批轮流取：同一成员一批内最多取它的 maxInstances 个，批总长不超过总闸。
        const gate = Math.max(1, Math.min(8, ctx.team.maxParallel || 3))
        const perLimit = new Map<string, number>()
        for (const m of ctx.team.members) perLimit.set(m.id, Math.max(1, Math.min(3, Number((m as any).maxInstances) || 1)))
        const results: any[] = []
        {
          const buckets = new Map<string, any[]>()
          for (const t of tasks) {
            const mid = String(t?.memberId || '')
            if (!buckets.has(mid)) buckets.set(mid, [])
            buckets.get(mid)!.push(t)
          }
          let guard = 0
          while ([...buckets.values()].some(b => b.length) && guard++ < 200) {
            const chunk: any[] = []
            for (const m of ctx.team.members) {
              const b = buckets.get(m.id)
              if (!b || !b.length) continue
              const take = Math.min(b.length, perLimit.get(m.id) || 1, gate - chunk.length)
              for (let i = 0; i < take; i++) chunk.push(b.shift())
              if (chunk.length >= gate) break
            }
            if (!chunk.length) break
            const rs = await Promise.all(chunk.map(t => runStepTask(ctx, bb, t)))
            results.push(...rs)
          }
        }
        ctx.syncPlan(planItems(ctx, bb))
        // 0911 反馈③：同批任务的文件边界重叠预检（warn-only：附在派发回执尾部，不阻断）
        const overlapWarn = detectDispatchOverlap(tasks.map((t: any) => ({
          text: `${String(t?.task || '')}\n${String(t?.acceptance || '')}`,
          label: `步骤 ${String(t?.stepId || '?')}`,
        })))
        const lines = results.map(r => {
          if (r.blocked) return `[${r.memberName}] 步骤 ${r.stepId} 未派发：${r.reason}`
          const arts = Array.isArray(r.artifacts) && r.artifacts.length ? `\n产物：${r.artifacts.join('、')}` : ''
          return `[${r.memberName}] 步骤 ${r.stepId} — ${r.status}${r.attempts > 1 ? `（第 ${r.attempts} 次）` : ''}\n产出摘要：${r.result || '(成员未汇报，见黑板)'}${arts}`
        })
        return {
          content: [{ type: 'text', text: `派发完成（${results.length} 项）。\n\n${lines.join('\n\n')}\n\n下一步：逐项审核——合格 bb_write(kind=step,stepId,status=done)；不合格 bb_write(status=rejected,feedback=...) 后重新 team_dispatch（同一任务累计 3 次封顶，超限上抛用户）${overlapWarn ? `\n\n${overlapWarn}` : ''}` }],
          details: { results, fileOverlapWarn: overlapWarn || undefined },
        }
      },
    },

    // ── bb_goal：写黑板目标与计划（同步用户计划卡） ──
    {
      name: 'bb_goal',
      label: '写黑板目标',
      description: '开工前写黑板：目标 + 总验收标准 + 计划步骤（每步标 owner 成员与 deps 依赖）。全量替换语义——重写时传完整计划。计划同步显示为用户可见的计划卡',
      parameters: Type.Object({
        goal: Type.String({ description: '本任务的总目标（一句话）' }),
        acceptance: Type.Optional(Type.String({ description: '总验收标准（逐条可检验）' })),
        plan: Type.Array(Type.Object({
          id: Type.Optional(Type.String({ description: '步骤 id（如 s1；不传自动生成 s1/s2…）' })),
          text: Type.String({ description: '步骤描述（一句话，具体可执行）' }),
          owner: Type.String({ description: '负责成员 id（team_info 查清单）' }),
          deps: Type.Optional(Type.Array(Type.String(), { description: '依赖的前置步骤 id（派发硬校验：未 done 不能开工）' })),
        }), { description: '计划步骤（全量）' }),
      }),
      async execute(_callId, params: any) {
        const goal = String(params?.goal || '').trim()
        if (!goal) throw new Error('goal 不能为空')
        const plan = Array.isArray(params?.plan) ? params.plan : []
        if (plan.length === 0) throw new Error('plan 不能为空——纯咨询任务不需要团队，直接回复即可')
        if (plan.length > 12) throw new Error('计划最多 12 步——拆得更细不如先做起来')
        // ── 单步计划启发校验（拒绝一次 + 申辩通道；通过时零成本，不加系统提示词） ──
        // 背景：弱模型常把"N 个独立页面"整包拆 1 步派 1 人串行做，浪费并行预算。
        // 强模型若确属单步任务，singleton:true 申明即过——不束缚正确决策
        if (plan.length === 1 && !params?.singleton) {
          const only = plan[0]
          const text = `${only?.text || ''} ${goal}`
          const multiOutput = /[1-9一-九两三四五六七八]\s*[个份页张条块]/.test(text) && ctx.team.members.length >= 3
          if (multiOutput) {
            // 拒绝信息按团队实际成员构成动态生成（铁律 32：约束在边界条件下要自洽——
            // 成员不足时"分给不同成员"是谎言，会把弱模型逼出职责错派）
            const presetCount = new Map<string, number>()
            for (const m of ctx.team.members) presetCount.set(m.preset, (presetCount.get(m.preset) || 0) + 1)
            const samePreset = [...presetCount.entries()].find(([, n]) => n > 1)
            const splitAdvice = samePreset
              ? `① 按独立产出物拆成多步，分派给同职责的多个成员（${samePreset[0]} 配了 ${samePreset[1]} 名）并行，deps 留空`
              : `① 多个产出物可合并为一步派给对应职责的成员（同一成员的多个步骤会作为独立实例并行执行，不串行）；或到团队设置添加同预设成员后再拆分并行`
            throw new Error([
              '单步计划被拒绝（启发式预警，非硬性）：',
              `任务描述疑似包含多个独立产出物（"${truncate(text, 80)}"）。`,
              '两种处理方式（二选一）：',
              splitAdvice + '；确需验收的补一步测试。拆分/合并后，独立步骤必须在【同一次 team_dispatch 调用】里以 tasks 数组一次性提交',
              '② 若确属单步任务（产出物强耦合不可拆，或量小不值得并行），重写本工具调用并带上 singleton:true 参数申明，即可通过',
              '注意：owner 必须与成员职责匹配（参照各成员职责描述），不要为凑数派给不相关成员',
            ].join('\n'))
          }
        }
        const steps: BlackboardStep[] = []
        const usedIds = new Set<string>()
        plan.forEach((p: any, i: number) => {
          const id = String(p?.id || '').trim() || `s${i + 1}`
          if (usedIds.has(id)) throw new Error(`步骤 id 重复：${id}`)
          usedIds.add(id)
          const owner = String(p?.owner || '').trim()
          if (!ctx.team.members.some(m => m.id === owner)) {
            throw new Error(`步骤 ${id} 的 owner「${owner}」不在团队成员里。可用：${ctx.team.members.map(m => m.id).join('、')}`)
          }
          steps.push({
            id,
            text: String(p?.text || '').trim().slice(0, 160),
            deps: (Array.isArray(p?.deps) ? p.deps : []).map((d: any) => String(d)),
            owner,
            status: 'pending',
            attempts: 0,
            updatedAt: Date.now(),
          })
        })
        for (const s of steps) {
          for (const d of s.deps) {
            if (!usedIds.has(d)) throw new Error(`步骤 ${s.id} 依赖的 ${d} 不在计划里`)
          }
        }
        const cycle = detectCycle(steps)
        if (cycle) throw new Error(`计划存在循环依赖：${cycle}`)
        // 0910 反馈6：重写计划时保留已有 runs——旧实现全量替换 blackboard 对象，把成员执行记录
        // 一起抹掉（刷新后子 agent 气泡无法从 transcript.subRuns 恢复的另一半根因）。
        const prevRuns = readBlackboardRuns(ctx.sessionId)
        const bb: Blackboard = {
          sessionId: ctx.sessionId,
          teamId: ctx.team.id,
          goal,
          acceptance: String(params?.acceptance || '').trim() || undefined,
          steps,
          findings: [],
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }
        if (prevRuns.length) (bb as any).runs = prevRuns
        saveBlackboard(bb)
        broadcastBB(ctx, bb)
        ctx.syncPlan(planItems(ctx, bb))
        ctx.log('info', 'session', `[团队] 黑板目标已写入（${steps.length} 步）`)
        const readyNow = steps.filter(s => s.deps.length === 0)
        const parallelHint = readyNow.length > 1
          ? `【并行提示】${readyNow.length} 个独立步骤（${readyNow.map(s => `${s.id}→${s.owner}`).join('、')}）无相互依赖：把它们放在【同一次 team_dispatch 调用】的 tasks 数组里一次性提交（并行预算 ${ctx.team.maxParallel}，超出自动分批）。同一成员的多个步骤也会作为独立实例并行执行，互不阻塞。`
          : '进入下一步：用 team_dispatch 派发。'
        return {
          content: [{ type: 'text', text: `黑板已建立：目标「${goal}」，计划 ${steps.length} 步（已同步用户计划卡）。计划不要重复写——直接派发。${parallelHint}` }],
          details: { ok: true, steps: steps.map(s => ({ id: s.id, owner: s.owner, deps: s.deps, status: s.status })) },
        }
      },
    },

    // ── bb_write：审核打回 / 发现 / 最终汇总（指挥官用） ──
    {
      name: 'bb_write',
      label: '写黑板',
      description: '审核/汇总写黑板：kind=step 标记步骤 done 或 rejected（打回必须带 feedback）；kind=finding 记录发现；kind=final 写最终汇总',
      parameters: Type.Object({
        kind: Type.Union([Type.Literal('step'), Type.Literal('finding'), Type.Literal('final')], { description: '写入类型' }),
        stepId: Type.Optional(Type.String({ description: 'kind=step 时必填' })),
        status: Type.Optional(Type.Union([Type.Literal('done'), Type.Literal('rejected')], { description: 'kind=step 时必填' })),
        result: Type.Optional(Type.String({ description: 'kind=step&status=done 时可修正产出摘要' })),
        feedback: Type.Optional(Type.String({ description: 'kind=step&status=rejected 时必填：打回反馈（具体可执行）' })),
        text: Type.Optional(Type.String({ description: 'kind=finding/final 时必填' })),
      }),
      async execute(_callId, params: any) {
        const bb = loadBlackboard(ctx.sessionId)
        if (!bb) throw new Error('黑板为空：先用 bb_goal 建立目标与计划')
        const kind = String(params?.kind || '')
        if (kind === 'step') {
          const step = bb.steps.find(s => s.id === String(params?.stepId || ''))
          if (!step) throw new Error(`步骤不存在：${params?.stepId}`)
          const status = String(params?.status || '')
          if (status === 'done') {
            // 审核校验：步骤必须真的被执行过（有 runs 记录）才能标 done——
            // 防主 agent 对从未派发的步骤直接"审核通过"（0901 c5d8b964 实锤：s2-s4 无成员
            // 执行被批量标 done，5 步计划假完成）。rejected/running 状态可正常打回重派
            const executed = (bb.runs || []).some(r => r.stepId === step.id && (r.status === 'done' || r.status === 'timeout'))
            if (!executed && step.status !== 'done') {
              throw new Error(`步骤 ${step.id} 从未派发执行（无 runs 记录），不能标记 done。先用 team_dispatch 派发该步骤；如果该步骤确实不需要执行，应修改计划（bb_goal 重写）把它移除`)
            }
            step.status = 'done'
            if (params?.result) step.result = truncate(params.result, 2000)
            step.updatedAt = Date.now()
            saveBlackboard(bb)
            broadcastBB(ctx, bb)
            ctx.syncPlan(planItems(ctx, bb))
            ctx.log('info', 'session', `[团队] 步骤 ${step.id} 审核通过`)
            const doneN = bb.steps.filter(s => s.status === 'done').length
            const allDone = doneN === bb.steps.length
            return {
              content: [{ type: 'text', text: `步骤 ${step.id} → done（${doneN}/${bb.steps.length}）。${allDone ? '全部完成：核对各成员产出，用 bb_write(kind=final) 写最终汇总，然后整合答复用户。' : '继续派发有依赖的后续步骤（deps 已满足）。'}` }],
              details: { ok: true, attemptsLeft: 3 - step.attempts },
            }
          }
          if (status === 'rejected') {
            const fb = String(params?.feedback || '').trim()
            if (!fb) throw new Error('打回必须带 feedback（具体可执行的修改要求）')
            step.status = 'rejected'
            step.feedback = truncate(fb, 600)
            step.updatedAt = Date.now()
            saveBlackboard(bb)
            broadcastBB(ctx, bb)
            ctx.syncPlan(planItems(ctx, bb))
            const left = 3 - step.attempts
            ctx.log('warn', 'session', `[团队] 步骤 ${step.id} 打回（剩余派发机会 ${left}）`)
            return {
              content: [{ type: 'text', text: left > 0
                ? `步骤 ${step.id} 已打回，反馈已记录。剩余派发机会 ${left} 次——重新 team_dispatch 时必须把 feedback 的解决要求写进任务单`
                : `步骤 ${step.id} 已打回并记录反馈。注意：该步骤已派发 ${step.attempts} 次达到上限，不能再派发——把各次产出对比呈现给用户请求定夺` }],
              details: { ok: true, attemptsLeft: left },
            }
          }
          throw new Error('status 只能是 done/rejected')
        }
        if (kind === 'finding') {
          const text = String(params?.text || '').trim()
          if (!text) throw new Error('text 不能为空')
          bb.findings.push({ t: Date.now(), by: '指挥官', text: truncate(text, 600) })
          if (bb.findings.length > 30) bb.findings = bb.findings.slice(-30)
          saveBlackboard(bb)
          broadcastBB(ctx, bb)
          return { content: [{ type: 'text', text: '发现已记录到黑板' }], details: { ok: true } }
        }
        if (kind === 'final') {
          const text = String(params?.text || '').trim()
          if (!text) throw new Error('text 不能为空')
          bb.finalResult = truncate(text, 4000)
          saveBlackboard(bb)
          broadcastBB(ctx, bb)
          ctx.log('info', 'session', '[团队] 最终汇总已写入黑板')
          return {
            content: [{ type: 'text', text: '最终汇总已写入黑板。请把它整合成给用户的答复（引用成员产出与产物路径，黑板是事实源）。' }],
            details: { ok: true },
          }
        }
        throw new Error('kind 只能是 step/finding/final')
      },
    },

    // ── bb_read：读黑板快照 ──
    {
      name: 'bb_read',
      label: '读黑板',
      description: '读取黑板当前快照（目标/计划进度/发现/最终汇总）——巡检、调整计划、决策前先读',
      parameters: Type.Object({}),
      async execute() {
        const bb = loadBlackboard(ctx.sessionId)
        if (!bb) return { content: [{ type: 'text', text: '黑板为空（尚未 bb_goal 建立目标）' }], details: { empty: true } }
        return { content: [{ type: 'text', text: formatBB(bb) }], details: { blackboard: JSON.parse(JSON.stringify(bb)) } }
      },
    },

    // ── team_info：读团队清单 ──
    {
      name: 'team_info',
      label: '读团队信息',
      description: '查看团队成员清单（id/名称/职责/可用工具/模型模式）与运行模式——拆解任务、分配 owner 前先读',
      parameters: Type.Object({}),
      async execute() {
        const bbNow = loadBlackboard(ctx.sessionId)
        const members = ctx.team.members.map(m => {
          const p = readAgentPreset(m.preset)
          // 0910 反馈4/5：独立模型"是否真的可用"必须暴露给指挥官——不可用=实际跑会话模型，
          // 拆任务/评估产出时必须知道（弱模型成员要配更细的任务单与验收标准）
          let modelText: string
          if (m.modelMode === 'independent') {
            const ok = !!ctx.resolveMemberModel(m)
            modelText = `独立(${m.modelId || '未填'}${ok ? '' : ' ⚠不可用→实际使用会话模型'}${(m as any).effort ? `｜思考挡位:${(m as any).effort}` : ''})`
          } else {
            modelText = '跟随会话'
          }
          // 0910 三批②：模型档位（主 agent 据此匹配任务难度）；三批③：成员并行上限 + 当前忙闲
          const cap = ctx.resolveMemberCapability(m)
          const capText = `档位:${cap.level}${cap.auto ? '(系统识别)' : ''}`
          const maxInst = Math.max(1, Math.min(3, Number((m as any).maxInstances) || 1))
          const busyCnt = (bbNow?.runs || []).filter(r => r.memberId === m.id && r.status === 'running' && activeRunIds.has(String(r.runId))).length
          const stateText = busyCnt ? `忙(在跑${busyCnt})` : '空闲'
          return `- ${m.id}：${p?.name || m.preset}｜职责：${truncate(m.role || p?.description || '', 120)}｜工具：${(p?.tools || []).join('、')}｜模型：${modelText}｜${capText}｜并行上限:${maxInst}｜${stateText}${ctx.memberSkills(m.id).length ? `｜技能：${ctx.memberSkills(m.id).join('、')}` : ''}`
        }).join('\n')
        const text = `团队「${ctx.team.name}」（${ctx.team.id}）\n模式：${ctx.team.mode}｜并行总预算：${ctx.team.maxParallel}｜黑板：${ctx.team.blackboard ? '开' : '关'}\n派发规则：单次 team_dispatch 的实际并行数 = min(并行总预算, 各成员并行上限之和, 待派任务数)；同一成员一批内最多并行它的"并行上限"个实例，超出的自动排到下一批。\n派活原则：任务难度要与成员「档位」匹配——fast 档只派边界清晰的小任务，strong 档可派需要判断与设计的复杂任务。成员「空闲」的可立刻派，「忙」的需等其当前实例结束。\n主指挥官：${ctx.team.mainPreset}\n成员：\n${members}`
        return { content: [{ type: 'text', text }], details: { team: JSON.parse(JSON.stringify(ctx.team)) } }
      },
    },
  ]
}

// ============================================================================
// 成员单聊（0904 批次：@成员 1:1 对话，计划 plan-sess_b14f7407 定稿）
//   - 每轮一次性成员 Agent（与派发同款"做完即焚"），但上下文=该成员自己的单聊历史
//     （持久化 member-chats/<sessionId>.json，主会话全文不注入）
//   - 事件继续走 session/subagent-event（stepId='@dm'）→ 前端现有 SubAgentBlock 气泡零改动
//   - 审批/无差别击杀拦截/看门狗/重复熔断全部同款复用；写类审批走主会话权限卡
//   - 取消/删除会话/同成员重发 → generation++ + abortSubAgents，迟到回写被 generation 拦截
// ============================================================================

interface MemberChatRun {
  runId: string
  memberId: string
  memberName: string
  /** 0913 头像批：成员预设 id —— 前端单聊气泡头像取用 */
  memberPreset?: string
  /** 用户消息（历史恢复气泡用） */
  userText: string
  text: string
  reasoning: string
  model?: string
  status: 'done' | 'error'
  tools: Array<{ name: string; status: string; result?: string }>
  segments?: any[]
  usage?: { promptTokens?: number; completionTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number }
  timing?: { llmMs: number }
  /** 锚点：发起时主会话用户消息轮数 → 刷新恢复时插到第 N 个用户气泡之后，时间线顺序不乱 */
  afterTurns: number
  t: number
}

const MC_DIR = path.join(DATA_ROOT, 'member-chats')
function mcPath(sessionId: string): string {
  return path.join(MC_DIR, `${sessionId}.json`)
}

/** sessionId → memberId → 该成员的单聊 run 列表（按时间升序，落盘裁剪 60 条） */
const memberChats = new Map<string, Map<string, MemberChatRun[]>>()

function mcEnsure(sessionId: string, memberId: string): MemberChatRun[] {
  let bySession = memberChats.get(sessionId)
  if (!bySession) { bySession = new Map(); memberChats.set(sessionId, bySession) }
  let list = bySession.get(memberId)
  if (!list) { list = []; bySession.set(memberId, list) }
  return list
}

function mcPersist(sessionId: string): void {
  /* ★0926c 铁律（用户：严禁兜底，问题直接暴露）：此处曾是写前静默 ensure（掩盖调用方顺序错误）——
     已改为**断言暴露**：谁没先 ensureMemberChatsLoaded() 就写盘，直接炸出来修调用方。 */
  if (!mcLoadedSet.has(sessionId)) throw new Error(`[team] mcPersist() 前必须先 ensureMemberChatsLoaded()——否则会用空内存覆盖磁盘单聊记录（调用方顺序错误）：${sessionId}`)
  try {
    fs.mkdirSync(MC_DIR, { recursive: true })
    const obj: Record<string, MemberChatRun[]> = {}
    const bySession = memberChats.get(sessionId)
    if (bySession) for (const [mid, list] of bySession) obj[mid] = list
    fs.writeFileSync(mcPath(sessionId), JSON.stringify({ sessionId, chats: obj }, null, 2) + '\n', 'utf-8')
  } catch (e) {
    console.error('[team] member-chats save failed:', e)
  }
}

/** 启动时加载 / history 兜底：把落盘记录灌回内存（不覆盖已有内存态——运行中的 run 比文件新）
 *  ★0926 扫雷脆弱点B：①"已读盘"用独立标记 mcLoadedSet 判——不能拿 memberChats.has() 当判据
 *  （mcEnsure 先插空 Map 就短路=磁盘历史永远读不回，下次 mcPersist 整份覆盖）；
 *  ② 灌回时"内存该成员为空/不存在才灌盘版"（空 Map/空列表场景补上历史，非空=运行中保留）。 */
const mcLoadedSet = new Set<string>()
function ensureMemberChatsLoaded(sessionId: string): void {
  if (mcLoadedSet.has(sessionId)) return
  /* 0927 netfix data-guard-0927：loaded 标记必须在**成功出口**回填 —— 原来进门就标记，
     坏 JSON/读错误抛出后标记仍留着 ⇒ 下次 mcPersist() 以为已加载，用空内存整份覆盖磁盘
     （成员单聊历史永久丢失）。 */
  let raw: string
  try {
    raw = fs.readFileSync(mcPath(sessionId), 'utf-8')
  } catch (e: any) {
    if (e?.code === 'ENOENT') {   // 首次无文件=正常空表（业务语义）
      if (!memberChats.has(sessionId)) memberChats.set(sessionId, new Map())
      mcLoadedSet.add(sessionId)   // 正常空表（首次无文件）也算已加载
      return
    }
    throw e   // ★0926c 铁律：其他读错误直接暴露，不静默吞
  }
  const j = JSON.parse(raw)   // ★0926c 铁律：坏 JSON 直接抛出暴露，不静默重置成空表
  if (!j || j.sessionId !== sessionId || !j.chats || typeof j.chats !== 'object') {
    throw new Error(`[team] 成员单聊文件结构非法（sessionId/chats 不符）：${mcPath(sessionId)}`)
  }
  const m = memberChats.get(sessionId) ?? new Map<string, MemberChatRun[]>()
  // 0910 反馈4：单聊轮同样自愈——进程被杀时停在 running，读盘标 interrupted（记录保留可回看）
  for (const [mid, list] of Object.entries(j.chats)) {
    if (!Array.isArray(list)) throw new Error(`[team] 成员单聊数据非法（chats.${mid} 应为数组）：${mcPath(sessionId)}`)
    for (const r of list as any[]) {
      if (r && r.status === 'running' && !activeRunIds.has(String(r.runId))) {
        r.status = 'interrupted'
        r.endedAt = r.endedAt || Date.now()
        r.text = r.text || '（这轮对话被中断——后端在处理过程中重启/停止）'
      }
    }
    const cur = m.get(String(mid))
    if (!cur || cur.length === 0) m.set(String(mid), list as MemberChatRun[])   // 内存该成员空=灌盘版（合并语义，非兜底）
  }
  memberChats.set(sessionId, m)
  mcLoadedSet.add(sessionId)   // 成功出口才标记 loaded
}

/** RPC 出口：全部成员单聊记录（前端恢复气泡/成员面板红点用） */
export function memberChatsSnapshot(sessionId: string): Record<string, MemberChatRun[]> {
  ensureMemberChatsLoaded(sessionId)
  const out: Record<string, MemberChatRun[]> = {}
  const bySession = memberChats.get(sessionId)
  if (bySession) for (const [mid, list] of bySession) out[mid] = JSON.parse(JSON.stringify(list))
  return out
}

export function clearMemberChats(sessionId: string): void {
  memberChats.delete(sessionId)
  try { fs.rmSync(mcPath(sessionId), { force: true }) } catch { /* ignore */ }
}

/** 单聊轮次作废代数（sessionId::memberId → generation）。cancel/delete/同成员重发 ++ → 迟到回写丢弃 */
const dmGen = new Map<string, number>()
/** 在途单聊控制器（sessionId → memberId → AbortController）：同成员重发中断上一轮，防并发跑两轮 */
const dmActive = new Map<string, Map<string, AbortController>>()
function dmKey(sessionId: string, memberId: string): string { return `${sessionId}::${memberId}` }
export function bumpMemberDmGeneration(sessionId: string, memberId?: string): void {
  if (memberId) {
    const k = dmKey(sessionId, memberId)
    dmGen.set(k, (dmGen.get(k) || 0) + 1)
  } else {
    for (const k of [...dmGen.keys()]) if (k.startsWith(`${sessionId}::`)) dmGen.set(k, (dmGen.get(k) || 0) + 1)
  }
}
/** 中断某成员在途单聊（session.cancel / 同成员重发时调）：abort 控制器 + generation++ */
export function abortMemberDm(sessionId: string, memberId?: string): void {
  const byMember = dmActive.get(sessionId)
  if (byMember) {
    if (memberId) {
      const ac = byMember.get(memberId)
      if (ac) { try { ac.abort() } catch { /* ignore */ }; byMember.delete(memberId) }
    } else {
      for (const ac of byMember.values()) { try { ac.abort() } catch { /* ignore */ } }
      byMember.clear()
    }
  }
}

interface MemberDmParams {
  sessionId: string
  memberId: string
  message: string
  /** 发起时主会话的用户消息轮数（时间线恢复锚点） */
  afterTurns: number
}

/** 单聊系统提示词：成员身份 + 职责 + 工作区 + 工具白名单纪律（无派发/无 bb_write，不混主会话历史） */
function buildDmSystem(ctx: TeamCtx, member: TeamMember, mName: string): string {
  const preset = readAgentPreset(member.preset)
  const roleText = String(member.role || preset?.description || '').trim() || '团队专职成员'
  const whitelist = Array.isArray(preset?.tools) ? preset.tools : []
  let sys = `你是「${mName}」，NIS 团队「${ctx.team.name}」的「${roleText.slice(0, 60)}」。
用户此刻在与你 1:1 单独对话（不是任务派发，没有任务单/黑板）。
- 用你自己的专长直接回答和干活，保持你预设的角色性格
- 当前工作目录是会话工作区：${ctx.workDir()}——产出文件写在这里（相对路径），可用读文件工具查看工作区
- 只能使用你被允许的工具：${whitelist.length ? whitelist.join('、') : '（无写类工具，纯对话）'}
- 不要声称能调度团队其他成员，也不要提及黑板/派发机制
- 拿不准的事实先查（fs_read / 联网工具，若可用）再回答，不编造`
  // 0910 三批⑤：工作区项目档案（NIS-notes.md）——成员按需读（项目背景/进度/约定）
  try {
    if (fs.existsSync(path.join(ctx.workDir(), 'NIS-notes.md'))) {
      sys += `\n- 工作区有项目档案 NIS-notes.md（项目背景/进度/决策记录），需要了解项目上下文时先读它`
    }
  } catch { /* ignore */ }
  // 0910 二批修正：sub_plan 由预设勾选控制——只有真挂了工具才给列清单指引（否则模型会去调不存在的工具）
  if (whitelist.includes('sub_plan')) {
    sys += `\n- 接到需要多步推进的任务时，先用 sub_plan 工具给自己列执行清单（3~6 条），完成一条就更新一次`
  }
  const memberSkillList = ctx.memberSkills(member.id)
  if (memberSkillList.length > 0 && whitelist.includes('use_skill')) {
    sys += `\n可用技能：${memberSkillList.join('、')}（需要时用 use_skill 加载指令）`
  }
  return sys
}

/** 成员单聊一轮：一次性 Agent（做完即焚），历史从 memberChats 灌入，事件走 subagent-event。
 *  server 侧 fire-and-forget（前端靠事件流收尾），异常已在内部消化成 error 落库/日志，不抛出。 */
export async function runMemberChat(ctx: TeamCtx, p: MemberDmParams): Promise<{ ok: boolean; runId: string }> {
  const runId = crypto.randomUUID()
  const member = ctx.team.members.find(m => m.id === p.memberId)
  if (!member) throw new Error(`成员不存在：${p.memberId}`)
  const mName = memberName(ctx.team, member.id)
  const preset = readAgentPreset(member.preset)
  if (!preset) throw new Error(`成员预设不存在：${member.preset}`)
  ensureMemberChatsLoaded(ctx.sessionId)
  const list = mcEnsure(ctx.sessionId, member.id)
  const gk = dmKey(ctx.sessionId, member.id)
  // 同成员在途单聊：先作废（迟到回写被 generation 拦截）+ abort（LLM 流即时断开）→ 新轮接上
  const inflight = dmActive.get(ctx.sessionId)?.get(member.id)
  if (inflight) {
    try { inflight.abort() } catch { /* ignore */ }
    ctx.log('info', 'session', `[单聊] ${mName} 上一轮被新的 @ 中断`)
  }
  const gen = (dmGen.get(gk) || 0) + (inflight ? 1 : 0)
  if (inflight) dmGen.set(gk, gen)

  const sys = buildDmSystem(ctx, member, mName)
  // 工具：成员预设白名单（与派发同款过滤）；单聊不注入 bb_write（无步骤可汇报）
  const whitelist = Array.isArray(preset.tools) ? preset.tools : []
  // 0910 反馈（二批②）：单聊成员同样可自列执行计划——sub_plan 无条件追加（与派发同语义，不受预设白名单限制），
  // 实时走 stepId='@dm' 的 sub_plan 帧（前端 SubAgentBlock 清单卡同款渲染），收尾随 dmRec 落盘（刷新可回放）
  const subPlanState: { items: Array<{ text: string; done: boolean }> } = { items: [] }
  const emitSubPlan = (items: Array<{ text: string; done: boolean }>) => {
    try {
      ctx.broadcast({
        type: 'session/subagent-event', sessionId: ctx.sessionId, runId, stepId: '@dm',
        memberId: member.id, memberName: mName, seq: ++seq,
        event: { type: 'sub_plan', plan: items },
      })
    } catch { /* ignore */ }
  }
  // 0910 二批修正（用户拍板）：单聊的 sub_plan 同样回归预设勾选控制（撤销上一轮的无条件追加）
  // 0911 反馈③：单聊 run 同样注入文件写锁（与派发成员互斥）
  const tools = [...ctx.buildMemberToolPool(mName, { owner: runId, label: mName }).filter(t => whitelist.includes(t.name))]
  if (whitelist.includes('sub_plan')) tools.push(buildSubPlanTool(subPlanState, emitSubPlan))
  // 模型：independent 解析失败回退共享（与派发同语义）
  let override: ModelOverride | null = null
  if (member.modelMode === 'independent') {
    override = ctx.resolveMemberModel(member)
    if (!override) ctx.log('warn', 'session', `[单聊] 成员 ${mName} 独立模型（${member.modelId}）解析失败（该模型不在任何已配置可用供应商中），回退共享模型`)
  }
  const dmEffort = String((member as any).effort || '').trim()
  // 0910 反馈3：单聊气泡头部模型名与成员面板选择同步（同派发路径）
  const dmModelId = member.modelMode === 'independent'
    ? String(member.modelId || '').trim()
    : String(ctx.sessionModel?.() || '').trim()
  const ac = new AbortController()
  const agent = new Agent({
    streamFn: (model: unknown, context: any, config?: { signal?: AbortSignal }) => {
      const signals = [ac.signal, config?.signal].filter(Boolean) as AbortSignal[]
      const merged = signals.length > 1 ? AbortSignal.any(signals) : signals[0]
      return ctx.createSubStreamFn(sys, override, merged, dmEffort || undefined, mName)(model, context)
    },
    initialState: { systemPrompt: sys, tools },
    sessionId: `${ctx.sessionId}/dm/${runId.slice(0, 8)}`,
    finishTurn: toFinishTurn((c: any) => {
      const msgs = Array.isArray(c?.newMessages) ? c.newMessages : []
      const toolRounds = msgs.filter((m: any) =>
        m.role === 'assistant' && Array.isArray(m.content) && m.content.some((b: any) => b.type === 'toolCall'))
      if (toolRounds.length >= 30) return true
      // 与派发同款通用重复熔断：同工具+同参数+同结果连续 5 次硬停、第 4 次日志预警
      const resultByCall = new Map<string, unknown>()
      for (const m of msgs) {
        if (m.role === 'toolResult' && m.toolCallId) resultByCall.set(String(m.toolCallId), m.content ?? m.result ?? '')
      }
      const calls: Array<{ sig: string; result: unknown }> = []
      for (const m of msgs) {
        if (m.role !== 'assistant' || !Array.isArray(m.content)) continue
        for (const b of m.content) {
          if (b.type !== 'toolCall') continue
          let argsSig = ''
          try { argsSig = JSON.stringify(b.arguments ?? {}).replace(/\s+/g, '').slice(0, 120) } catch { argsSig = '' }
          const callId = String(b.id || b.toolCallId || '')
          if (!callId || !resultByCall.has(callId)) continue
          calls.push({ sig: `${b.name}:${argsSig}`, result: resultByCall.get(callId) })
        }
      }
      let run = 0
      let prev: string | null = null
      for (const call of calls) {
        let resultSig = ''
        try { resultSig = JSON.stringify(call.result).replace(/\s+/g, '').slice(0, 240) } catch { resultSig = String(call.result).slice(0, 240) }
        const key = `${call.sig}:${resultSig}`
        run = key === prev ? run + 1 : 1
        prev = key
        if (run >= 5) {
          const toolName = call.sig.split(':')[0]
          ctx.log('error', 'lifecycle', `[单聊·${mName}] 循环熔断：${toolName} 参数和结果均未变化，连续第 ${run} 次，已硬停止本轮`, { guard: 'hard-stop', tool: toolName, repeat: run })
          return true
        }
        if (run === 4) {
          const toolName = call.sig.split(':')[0]
          ctx.log('warn', 'lifecycle', `[单聊·${mName}] 循环预警：${toolName} 参数和结果均未变化，已连续第 4 次；这是软提醒，下一次仍重复才会停止`, { guard: 'soft-warning', tool: toolName, repeat: run })
        }
      }
      return false
    }),
    // 写类工具走主会话权限卡（与派发同款：full_access/self_audit 跟随会话模式）+ 无差别击杀硬拦
    beforeToolCall: async (tctx: any) => {
      ctx.log('info', 'tool', `[@${mName}] ${tctx.toolCall.name} ${truncate(JSON.stringify(tctx.args ?? {}), 120)}`)
      if (tctx.toolCall.name === 'run_command') {
        const kill = matchIndiscriminateKillCommand(String(tctx.args?.command || ''))
        if (kill) {
          ctx.log('error', 'approval', `[单聊·${mName}] 已拦截无差别进程杀伤命令：${kill.cmd}`)
          return { block: true, reason: `命令「${kill.cmd}」会按映像名杀掉所有 ${kill.image} 进程（包括 NIS 后端自身）。请用 taskkill /F /PID <具体进程号> 指定进程。` }
        }
      }
      if (['fs_write', 'fs_delete', 'run_command'].includes(tctx.toolCall.name)) {
        watchdog.suspend()
        try {
          ctx.log('warn', 'approval', `[单聊] 成员 ${mName} 请求授权：${tctx.toolCall.name}`)
          const r = await ctx.approval(tctx.toolCall.name, tctx.args)
          if (r?.block) {
            ctx.log('warn', 'approval', `[${mName}] ${tctx.toolCall.name} 被拒绝：${r.reason || '用户拒绝'}`)
            return { block: true, reason: r.reason }
          }
          ctx.log('info', 'approval', `[单聊] 成员 ${mName} 的 ${tctx.toolCall.name} 已获授权/免审`)
        } finally {
          watchdog.resume()
        }
      }
      return undefined
    },
  })

  // 单聊历史灌入（pi 消息序：user=上一轮用户原话，assistant=该轮最终正文）
  try {
    const hist: any[] = []
    for (const run of list) {
      if (run.text) hist.push({ role: 'assistant', content: [{ type: 'text', text: run.text }], timestamp: run.t })
      if (run.userText) hist.push({ role: 'user', content: [{ type: 'text', text: run.userText }], timestamp: run.t + 1 })
    }
    if (hist.length > 20) hist.splice(0, hist.length - 20)
    if (hist.length > 0) agent.state.messages = hist
  } catch { /* ignore：失败退化为无历史单聊 */ }

  // 0910 反馈4：单聊同样"开工即落盘"——重启/中断后这轮也留着记录（就地更新，不追加重复条目）
  const dmRec: any = {
    runId, memberId: member.id, memberName: mName, memberPreset: member.preset, userText: p.message,
    text: '', reasoning: '', model: dmModelId || undefined,
    status: 'running', tools: [], segments: [],
    usage: undefined, timing: { llmMs: 0 },
    afterTurns: p.afterTurns, t: Date.now(), startedAt: Date.now(),
  }
  list.push(dmRec)
  activeRunIds.add(runId)
  mcPersist(ctx.sessionId)

  // 生命周期登记：session.cancel/delete → abortSubAgents 一并中断
  const set = subAgents.get(ctx.sessionId) ?? new Set<Agent>()
  set.add(agent)
  subAgents.set(ctx.sessionId, set)
  const acSet = subControllers.get(ctx.sessionId) ?? new Set<AbortController>()
  acSet.add(ac)
  subControllers.set(ctx.sessionId, acSet)
  let dmByMember = dmActive.get(ctx.sessionId)
  if (!dmByMember) { dmByMember = new Map(); dmActive.set(ctx.sessionId, dmByMember) }
  dmByMember.set(member.id, ac)

  const started = Date.now()
  let watchdogReason: string | null = null
  const watchdog = armWatchdog(ctx, `${ctx.sessionId}/dm/${runId}`, agent, (reason) => {
    watchdogReason = reason
    ctx.log('warn', 'session', `[单聊] ${mName} ${reason}`)
  })
  const toolLog: Array<{ name: string; status: string; result?: string }> = []
  let seq = 0
  agent.subscribe((event: any) => {
    if (event?.type === 'tool_execution_end' && event?.toolName) {
      toolLog.push({
        name: event.toolName,
        status: event.isError ? 'error' : 'done',
        result: (Array.isArray(event.result?.content) ? event.result.content : [])
          .filter((c: any) => c?.type === 'text').map((c: any) => c.text).join('\n').slice(0, 160),
      })
      if (toolLog.length > 60) toolLog.splice(0, toolLog.length - 60)
    }
    try {
      ctx.broadcast({
        type: 'session/subagent-event', sessionId: ctx.sessionId, runId, stepId: '@dm',
        memberId: member.id, memberName: mName, memberPreset: member.preset, seq: ++seq, model: dmModelId || undefined, event,
      })
    } catch { /* ignore */ }
  })

  let runError: string | null = null
  try {
    await agent.prompt(p.message)
  } catch (e: any) {
    runError = String(e?.message || e)
  } finally {
    watchdog.disarm()
    set.delete(agent)
    acSet.delete(ac)
    try { if (dmActive.get(ctx.sessionId)?.get(member.id) === ac) dmActive.get(ctx.sessionId)!.delete(member.id) } catch { /* ignore */ }
    activeRunIds.delete(runId)
    // 0911 反馈③：单聊 run 收尾释放文件写锁（含异常路径）
    releaseFileLocks(runId)
    ac.abort()
    try { agent.abort() } catch { /* ignore */ }
  }

  // 迟到回写防护：本轮结束时会话被删 / 该成员被作废（cancel/重发）→ 丢弃结果
  if (!sessions_alive_check(ctx.sessionId) || (dmGen.get(gk) || 0) !== gen) {
    ctx.log('warn', 'session', `[单聊] ${mName} 的结果已作废（会话删除或轮次中断），不回写记录`)
    // 发终止帧让前端气泡收尾（否则停在 running 转圈）
    try {
      ctx.broadcast({
        type: 'session/subagent-event', sessionId: ctx.sessionId, runId, stepId: '@dm',
        memberId: member.id, memberName: mName, seq: ++seq,
        event: { type: 'agent_end' },
      })
    } catch { /* ignore */ }
    return { ok: false, runId }
  }

  const liveMsgs = (agent.state.messages || []) as any[]
  const usage = memberUsageOf(liveMsgs)
  const lastModel = [...liveMsgs].reverse().find(m => m?.role === 'assistant' && m?.model)?.model
  const finalTextMsg = [...liveMsgs].reverse().find(m => m?.role === 'assistant' && Array.isArray(m?.content) && m.content.some((c: any) => c.type === 'text' && c.text))
  const finalText = finalTextMsg ? (finalTextMsg.content as any[]).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('') : ''
  const finalReasoningMsg = [...liveMsgs].reverse().find(m => m?.role === 'assistant' && Array.isArray(m?.content) && m.content.some((c: any) => c.type === 'thinking' && c.thinking))
  const finalReasoning = finalReasoningMsg ? (finalReasoningMsg.content as any[]).filter((c: any) => c.type === 'thinking').map((c: any) => c.thinking).join('') : ''
  // 失败判定（0904 深夜实测修正）：成员 LLM 建连失败时 pi 把错误文案包成普通 text 块回传
  // （"[LLM 流式错误…]"），旧判据 `runError && !finalText` 漏检 → 限流轮被标"已完成"。
  // 错误前缀文本或空回复一律标 error（前端徽章显示"失败"）；空回复给占位文案避免气泡空白。
  // ★ 0928 修（错误人话化回归）：错误文案已人话化（"这一步没跑起来：…\n原始错误：…"），旧前缀判据失灵。
  // 改「结构判据优先 + 文本兜底」：错误消息进 _state.messages 时自带 stopReason:'error'/'aborted' + errorMessage
  // （pi-agent-core agent-loop case "done"/"error" 原样 push；failMsg 注入），不再依赖具体文案。
  // 文本兜底三分支：旧前缀 / 新人话句式（必须带"原始错误："配对行，防成员正常汇报误伤）/ 旧 fatal 兜底句式。
  const lastAsstMsg = [...liveMsgs].reverse().find(m => m?.role === 'assistant') || {}
  const errByStruct = lastAsstMsg.stopReason === 'error' || lastAsstMsg.stopReason === 'aborted' || !!lastAsstMsg.errorMessage
  const errByOldText = /^\s*\[(LLM 流式错误|流式响应异常中断|aborted)/.test(finalText)
  const errByHintText = /^这一步没跑起来：[\s\S]*\n原始错误：/.test(finalText)
  const errByFatalText = /^本次请求是确定性错误（如上下文超限/.test(finalText)
  const isErrText = errByStruct || errByOldText || errByHintText || errByFatalText
  const failed = !!runError || isErrText || !finalText.trim()
  const record: MemberChatRun = {
    runId, memberId: member.id, memberName: mName, memberPreset: member.preset, userText: p.message,
    text: (finalText.trim() || (failed ? '（模型本轮未返回内容，可能是网关限流或瞬时错误，请重试）' : '')).slice(0, 8000),
    reasoning: finalReasoning.slice(0, 4000),
    model: dmModelId || lastModel, status: failed ? 'error' : 'done',
    tools: toolLog.slice(0, 40), segments: buildRunSegments(liveMsgs),
    usage, timing: { llmMs: Date.now() - started }, afterTurns: p.afterTurns, t: Date.now(),
  }
  if (watchdogReason) record.text = record.text || `（本轮被守护中断：${watchdogReason}）`
  if (runError && !finalText) record.text = `（执行失败：${runError.slice(0, 200)}）`
  // 就地更新开工时写的那条（含 startedAt），不追加第二条
  // 0910 反馈（二批②）：单聊自列计划随 dmRec 落盘，刷新后气泡可回放（前端 restoreMemberChats 读 run.plan）
  Object.assign(dmRec, record, { startedAt: dmRec.startedAt, endedAt: Date.now(), plan: subPlanState.items.length ? subPlanState.items : undefined })
  if (list.length > 60) list.splice(0, list.length - 60)
  mcPersist(ctx.sessionId)
  // 0910 三批⑤：单聊产出回流黑板（只回结论摘要 + 产物路径，标注来源=@成员单聊）。
  // 之前单聊是"私密频道"——产出不进团队事实源，指挥官和其他成员都看不到，等于白干。
  try {
    const bbNow = loadBlackboard(ctx.sessionId)
    if (bbNow && String(record.text || '').trim() && !failed) {
      const paths = (record.tools || []).map(t => /→\s*([^\s]+)\s*$/.exec(String(t.result || ''))?.[1]).filter(Boolean) as string[]
      const uniq = [...new Set(paths)].slice(0, 6)
      const text = `【@${mName} 单聊产出】${truncate(record.text, 300)}${uniq.length ? `\n产物：${uniq.join('、')}` : ''}`
      bbNow.findings = [...(bbNow.findings || []), { by: `${mName}(单聊)`, text, t: Date.now() } as any]
      saveBlackboard(bbNow)
      ctx.syncPlan(planItems(ctx, bbNow))
      ctx.log('info', 'session', `[单聊] ${mName} 产出已回流黑板（findings）`)
    }
  } catch { /* 回流失败不影响单聊本身 */ }
  // 收尾帧（0904 深夜实测修正）：成员 LLM 建连失败时 pi 不流任何 delta，live 气泡会停在
  // "成员正在工作"占位且徽章"已完成"——这里补发 message_end 承载最终文本 + 失败轮发 error 事件，
  // 前端徽章正确显示"失败"、气泡显示原因文案。
  try {
    if (record.text && !(liveMsgs.length && finalText)) {
      ctx.broadcast({
        type: 'session/subagent-event', sessionId: ctx.sessionId, runId, stepId: '@dm',
        memberId: member.id, memberName: mName, seq: ++seq,
        event: { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: record.text }], timestamp: Date.now() } },
      })
    }
    if (failed) {
      ctx.broadcast({
        type: 'session/subagent-event', sessionId: ctx.sessionId, runId, stepId: '@dm',
        memberId: member.id, memberName: mName, seq: ++seq,
        event: { type: 'error', message: String(record.text || '成员模型调用失败').slice(0, 300) },
      })
    }
    ctx.broadcast({
      type: 'session/subagent-event', sessionId: ctx.sessionId, runId, stepId: '@dm',
      memberId: member.id, memberName: mName, seq: ++seq,
      event: { type: 'agent_end' },
    })
  } catch { /* ignore */ }
  ctx.log('info', 'session', `[单聊] ${mName} 本轮完成（${record.status}，${Math.round((Date.now() - started) / 1000)}s）`)
  return { ok: record.status === 'done', runId }
}

/** 会话是否仍存活（server 注入；未注入时保守视为存活） */
let sessions_alive_check: (sessionId: string) => boolean = () => true
export function setMemberChatSessionLivenessCheck(fn: (sessionId: string) => boolean): void {
  sessions_alive_check = fn
}

/** 0911 反馈③：run 是否活跃（server 启动时注入给 fileLocks 做残留锁兜底：
 *  owner 已失活时新持有者可直接抢锁，杜绝 run 异常路径残留导致的死锁） */
export function isRunActive(runId: string): boolean {
  return activeRunIds.has(runId)
}
