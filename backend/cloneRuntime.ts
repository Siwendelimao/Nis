/* ============================================================================
 * cloneRuntime.ts —— 分身工具（spawn_clone）：非团队模式派出 1~3 个「自己」并行执行子任务
 *
 * 设计（0925 已定案）：
 *  · 形式 = 工具（与 team_dispatch 同构），触发靠自然语言；上限 3 个，命名「<AI名> 分身1/2/3」
 *  · 分身只听主 agent 的任务单，用户只能展开气泡查看过程
 *  · 失败链：分身重试 2 次 → 主 agent 亲自补 1 次 → 都失败汇报用户定夺；
 *    主 agent 预判不妙时，分身第一次失败就应告知用户调整策略（写进工具描述的行为纪律）
 *  · 复用团队管线（零复制）：给分身伪造轻量 TeamCtx + 单步黑板 → 直接调 runSubAgent ——
 *    气泡/过程回放(segments)/中断/文件锁/工具池/模型解析全套免费。
 *    黑板 sessionId 带 `#clone` 后缀落独立文件，不污染真黑板。
 * ========================================================================== */
/* ★ 0925 修复：原写成 `@sinclair/typebox`（typebox 的**旧包名**，本项目从未安装）——
   它在启动期直接抛 `ERR_MODULE_NOT_FOUND: Cannot find package '@sinclair/typebox'`，
   整个后端起不来（症状：控制台报「30 秒内没等到就绪 + 日志尾部为空」，错误只在 .err 里）。
   项目约定（tools.ts / server.ts / teamRuntime.ts 等 10 处）统一用 `'typebox'`（v1.3.7，已在 node_modules）。 */
import { Type } from 'typebox'
import { randomUUID } from 'node:crypto'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { runSubAgent, loadBlackboard, abortedSince } from './teamRuntime.ts'
import type { Blackboard, BlackboardStep, TeamCtx } from './teamRuntime.ts'
import type { TeamMember } from './teamsStore.ts'

/** 主 agent 的自我信息（分身=复制它） */
interface CloneSelf {
  /** 显示名（如"小螺丝"）→ 分身命名 `${name} 分身N` */
  name: string
  /** 自己的预设 id（分身用同款工具箱/角色底子） */
  presetId: string
}

/** 分身需要的轻量上下文 = TeamCtx 的全部方法（server.ts 的 buildTeamCtx 直接提供，零转换） */
type CloneCtxLite = TeamCtx

const MAX_CLONES = 3
/** 槽位表：sessionId → 已占用槽号（派发占位、批次收尾释放） */
const cloneSlots = new Map<string, Set<number>>()

/* ★ 0925x（设计口径修正："分身应该只有 1/2/3，不管多少轮"）：**三槽位制** ——
   分身1/2/3 是固定槽位号（不是无限递增）：派分身时占用最小空闲槽，跑完释放复用；
   3 个槽都占着 = 3 个分身都在跑，再派会被拒（"上限 3 个"的并发语义）。
   ★1004 修复：本行原有第二个 `const cloneSlots`（同一作用域重复声明）→ esbuild 报
   `The symbol "cloneSlots" has already been declared` ⇒ **整个后端起不来**；已删掉重复声明，
   槽位表只保留上方第 37 行那一处。（注：同批加的 `cloneBusyCount()` 已被后续改动移除，
   目前无任何消费方 —— 侧栏「分身工作中」指示的缺口见 1005 诊断。） */
function acquireSlot(sessionId: string): number | null {
  const used = cloneSlots.get(sessionId) || new Set<number>()
  for (let i = 1; i <= MAX_CLONES; i++) {
    if (!used.has(i)) { used.add(i); cloneSlots.set(sessionId, used); return i }
  }
  return null
}
function releaseSlot(sessionId: string, n: number) {
  cloneSlots.get(sessionId)?.delete(n)
}

/* ★ 0925w（实测三连：分身挂后台任务/回访串扰/权限卡死 "ctx.approval is not a function"）：
 * 分身定位=查资料/简单提效 —— 工具箱限定安全范围：**不含** 后台任务(bg_*)、询问卡(ask_user)、
 * 设置修改、删除(fs_delete)、预设/自定义工具管理、自我修改(project_*)等高危/串扰类。
 * 免审批（approval 兜底返回放行）——工具箱已圈安全区，分身不再被审批卡死。
 * ★1005（已定案·方案A）：**分身改"只读 + 汇报"** —— 再去掉 fs_write/fs_edit/run_command：
 *   并行分身不再能改文件/跑命令（并行写冲突源与误操作面整体下线；0927 taskkill 差点杀后端就是这类口子）；
 *   产出照旧走 bb_write→step.result 汇报 —— bb_write 是团队管线内置的受限汇报工具
 *   （teamRuntime buildSubWriteTool），不经 buildMemberToolPool 白名单过滤 ⇒ 不受本次改动影响（已核）；
 *   **改文件由主 agent 汇总分身结论后自己落地**（它有完整审批链）。
 *   对标 opencode 的 Explore 子 agent（"Cannot modify files"）与 codex 的 read-only 档。 */
const CLONE_TOOL_WHITELIST = [
  'fs_read', 'fs_grep',
  'web_search', 'web_fetch', 'github_search',
  'plan_write', 'project_note', 'use_skill',
]
/* ★ 0929 工具瘦身·刀①：家族工具在分身里按 action 收口 —— **严格保持合并前的安全区**：
 * 合并前分身只有 memory_search/store、knowledge_query/add、notebook_list/add/update（无任何删除类、无 distill）。
 * 合并后家族工具整只给出去会连 delete 一起给（安全区扩大）⇒ 必须按 action 白名单收口。 */
const CLONE_ACTION_WHITELIST: Record<string, string[]> = {
  memory: ['search', 'store'],
  knowledge: ['query', 'add'],
  notebook: ['list', 'add', 'update'],
}
function cloneRestrictTool(t: any): any {
  const allow = CLONE_ACTION_WHITELIST[t.name]
  if (!allow) return t
  return {
    ...t,
    async execute(callId: string, params: any) {
      const a = String((params as any)?.action || '').trim()
      if (!allow.includes(a)) {
        return { content: [{ type: 'text', text: `【分身安全区】${t.name}(action=${a || '空'}) 不在分身工具箱里（分身只开放：${allow.join(' / ')}）` }], details: { ok: false } }
      }
      return t.execute(callId, params)
    },
  }
}

/** 给一组分身任务伪造「轻量 TeamCtx + 独立黑板」，返回可直接喂 runSubAgent 的壳 */
function makeShell(lite: CloneCtxLite, self: CloneSelf, n: number, goal: string, slot = 1) {
  const teamId = `clone-${randomUUID().slice(0, 8)}`
  const members: TeamMember[] = []
  for (let i = 1; i <= n; i++) {
    members.push({
      /* ★ 0925z（设计口径"#N 是身份牌"）：member.id 带**槽位号**（clone1/2/3）——
         前端实例号 #N 直接取它（第二轮派的还是 #1/#2/#3，不按出现顺序累加）。 */
      id: `clone${slot}`,
      /* ★ 0925x（设计口径："分身1 分身2 就不要了，#1 #2 #3 就可以了"）：名字不带序号 ——
         显示「<AI名> 分身」，实例区分交给界面的 #1/#2/#3（同成员多实例编号机制）。 */
      name: `${self.name} 分身`,
      preset: self.presetId,
      role: `「${self.name}」的分身（一次性实例）：只读调研员——只查资料/读文件/搜索，不落盘不改文件不跑命令；产出写黑板汇报，改文件由本体落地`,
      modelMode: 'shared',
      modelId: '',
      maxInstances: 1,
    } as any)
  }
  const bb: Blackboard = {
    sessionId: `${lite.sessionId}#clone`,
    teamId,
    goal,
    steps: [],
    findings: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    /* ★ 0925ab（实测"刷新后分身气泡没了"）：**续接历史 runs** ——
       每次 spawn_clone 造新黑板会覆盖 #clone 文件（前几轮的回放快照丢）；这里把旧 runs 带上累积。 */
    ...((): any => {
      try {
        const prev = loadBlackboard(`${lite.sessionId}#clone`) as any
        return Array.isArray(prev?.runs) ? { runs: prev.runs.slice(-40) } : {}
      } catch { return {} }
    })(),
  } as any
  const ctx: TeamCtx = {
    sessionId: lite.sessionId,
    team: { id: teamId, name: `${self.name}·分身小队`, mode: 'parallel', maxParallel: MAX_CLONES, members } as any,
    broadcast: lite.broadcast,
    log: lite.log,
    /* ★ 0925w：工具池包一层白名单过滤（分身只给查/轻写工具，bg_* 等不下发） */
    buildMemberToolPool: (actor?: string, lock?: { owner: string; label: string }) =>
      lite.buildMemberToolPool(actor, lock).filter(t => CLONE_TOOL_WHITELIST.includes(t.name) || CLONE_ACTION_WHITELIST[t.name]).map(cloneRestrictTool),
    createSubStreamFn: lite.createSubStreamFn as any,
    resolveMemberModel: lite.resolveMemberModel as any,
    resolveMemberCapability: lite.resolveMemberCapability as any,
    sessionModel: lite.sessionModel,
    memberSkills: lite.memberSkills,
    workDir: lite.workDir,
    /* ★ 0925w（实测 "ctx.approval is not a function" 卡死）：审批回调兜底 ——
       工具箱已圈定安全范围，分身一律放行，不再被审批链卡住。 */
    approval: async () => ({ block: false }),
    syncPlan: () => { /* 分身不碰会话计划卡（那是主 agent 的） */ },
  } as any
  return { ctx, bb, members }
}

/** 单个分身跑一次（★0926 已定案新失败链：**不再内层重试**——失败交批次层按失败数分流） */
async function runCloneOnce(lite: CloneCtxLite, self: CloneSelf, idx: number, task: string, goal: string, batchT0 = Date.now()): Promise<{ name: string; ok: boolean; result: string; attempts: number; runs: any[]; aborted?: boolean }> {
  const { ctx, bb, members } = makeShell(lite, self, 1, goal, idx)
  const member = members[0]
  const name = `${self.name} 分身${idx}`
  /* ★0929 P1：步骤 id 加唯一后缀 —— 槽位号在每次 spawn 复用 1/2/3，`clone-<idx>` 撞 id 会让
     合并落盘按 id 合并时互踩；全仓只此处构造、无处解析该前缀（已核）。 */
  const step: BlackboardStep = {
    id: `clone-${idx}-${randomUUID().slice(0, 6)}`, text: task, deps: [], owner: member.id,
    status: 'pending', attempts: 0,
  }
  bb.steps.push(step)
  /* ★0929 P1：本壳此前已带的 run（0925ab 续接的历史）——差集即本次新建的 run 快照 */
  const prevRunIds = new Set(((bb as any).runs || []).map((r: any) => String(r.runId || '')))
  const ownRuns = () => ((bb as any).runs || []).filter((r: any) => !prevRunIds.has(String(r.runId || '')))
  try {
    await runSubAgent(ctx, bb, step, member, randomUUID(), task, '')
    /* ★ 0925x（实测"分身明明找到了却报失败、还跑了两轮"）：runSubAgent 不改 step.status
       （'review' 是团队 runStepTask 设的，分身直调不经它）——旧判定看 status 恒不命中 →
       误判失败 → 自动重试（两轮）→ 主 agent 以为失败自己上。改为按**汇报**判定：
       bb_write 写了 step.result 即视为完成（分身的汇报通道就是 bb_write→step.result）。 */
    const _res = String(step.result || '').trim()
    /* 0927 netfix clone-block-0927：分身"遇阻/无法完成"类汇报不能算成功 —— 原只要非空就 ok:true，
       失败链（重派/自补）永远不触发。命中阻塞词的汇报按失败走链。 */
    const BLOCK_RE = /无法解决|无法继续|无法完成|缺少?(权限|信息|凭据)|方向不明|已中止|被中止|挂死|多次失败/
    if (_res && !BLOCK_RE.test(_res.slice(0, 400))) {
      return { name, ok: true, result: String(step.result || ''), attempts: 1, runs: ownRuns() }
    }
  } catch (e: any) {
    step.result = String(e?.message || e)
  }
  /* ★0930：失败带上「是否被用户中止」——失败链严禁把用户停止当失败重派（见批次层） */
  return { name, ok: false, result: String(step.result || '(未汇报)'), attempts: 1, runs: ownRuns(), aborted: abortedSince(lite.sessionId, batchT0) }
}

/** 分身工具工厂（挂载到普通模式主 agent 的工具集） */
export function buildCloneTools(lite: CloneCtxLite, getSelf: () => CloneSelf): AgentTool<any>[] {
  return [
    {
      name: 'spawn_clone',
      label: '派出分身',
      description:
        '派出自己的分身（2~3 个，命名「<我> 分身1/2/3」）**并行执行只读子任务**。分身是「只读调研员」：只查资料/读文件/搜索，**不能改文件、不能跑命令**；' +
        '产出写黑板汇报，**改文件由你（主 agent）汇总分身结论后自己落地**——别派分身去做写文件/跑命令的活。**立即返回，分身在后台干活**——' +
        '完成后自动把产出摘要以「分身回归」消息送回本对话；★派出后**立即收轮挂起**（一两句告知即可，不要做总结/后续规划、不要继续做别的事），' +
        '等待期间只有用户插话或后台任务通知才响应，「分身回归」消息到达后按其中指引收尾（含失败链）。' +
        '何时派：任务可拆成 2~3 个**互相独立**的子任务（不同文件/不同方向）时才值得派；单一连贯小任务自己做更快，不要为了派而派。' +
        '**派 2 个起——只派 1 个没必要（直接自己做）**。用户明说派几个就派几个（说 1 个=自己做）；没说就自己判断派不派/派几个（2~3）。' +
        '失败链（严格遵守，单个分身不自动重试）：失败 1 个 → 你直接自己上补做；失败 ≥2 个（含全军覆没）→ 换新分身重派失败的那些一轮，**重试仍失败的 → 你自己上**；' +
        '若你**预判自己也难解决**（缺权限/缺信息/方向不明），立即把情况与建议汇报给用户调整策略，不要硬补；' +
        '都失败就汇总现状交用户定夺，不要无限循环。' +
        '分身只听任务单，用户看不到过程之外的交互——任务单要写清目标/边界/注意事项/验收。',
      parameters: Type.Object({
        tasks: Type.Array(Type.Object({
          task: Type.String({ description: '任务单：目标+边界+注意事项+验收标准（分身只有这张单子）' }),
        }), { minItems: 2, maxItems: MAX_CLONES, description: '子任务清单（2~3 个，互相独立；只派 1 个没必要=直接自己做）' }),
      }),
      async execute(_callId, params: any) {
        const tasks: any[] = Array.isArray(params?.tasks) ? params.tasks : []
        if (tasks.length < 2) throw new Error('至少派 2 个分身——只派 1 个没必要，请直接自己做（0926 规则）')
        if (tasks.length > MAX_CLONES) throw new Error(`最多 ${MAX_CLONES} 个分身——请精简或分批`)
        const self = getSelf()
        const goal = tasks.map((t) => `分身：${String(t?.task || '').slice(0, 120)}`).join('；')
        /* ★ 0925x：三槽位制——每个任务占一个槽（1/2/3），3 个都在忙就拒绝 */
        const slots: number[] = []
        for (let i = 0; i < tasks.length; i++) {
          const slot = acquireSlot(lite.sessionId)
          if (slot == null) {
            slots.forEach(s => releaseSlot(lite.sessionId, s))
            throw new Error(`分身 1/2/3 都在执行中（上限 3 个）——等当前分身回归后再派`)
          }
          slots.push(slot)
        }
        lite.log('info', 'tool', `[分身] 派出 ${tasks.length} 个分身（${self.name} 分身${slots.join('/')}）`)
        const t0 = Date.now()
        /* ★0930（用户三点实测）：**即派即回** —— 批次放后台跑、工具立即返回。
           旧病：spawn_clone 同步等全部分身（2~5 分钟）→ 主 agent 被钉在工具里，插话没人理、
           通知不回话、界面看起来"AI 不输出"（实测三条全中）。现在分身跑完由 notifyCloneDone
           把「分身回归」摘要送回对话（streaming→steer；空闲→自动拉起一轮），主 agent 统一按序处理。 */
        void (async () => {
          try {
            const collectRuns = (list: any[]) => list.flatMap(r => (Array.isArray((r as any)?.runs) ? (r as any).runs : []))
            const spawnedRuns: any[] = []
            const results = await Promise.all(tasks.map((t, i) => runCloneOnce(lite, self, slots[i], String(t?.task || ''), goal, t0)))
            spawnedRuns.push(...collectRuns(results))
            /* ★0930（实测"点停止→又冒出两个分身继续干，根本停不掉"）：**用户中止不算失败** ——
               旧失败链把"两个都失败"判成"≥2 失败→换新分身重派一轮"，用户一按停止就重派两个新的
               （日志实锤 01:38:50「2 个分身失败（≥2）——换新分身重派一轮」）。现在批次期间发生过
               用户中止 → 不重派、不汇报，直接收摊（气泡上已有「用户已停止」）。 */
            if (abortedSince(lite.sessionId, t0) || results.some(r => (r as any).aborted)) {
              lite.log('info', 'tool', '[分身] 用户已停止——本批分身中止收摊（不重派、不汇报）')
              try { lite.registerSubRuns?.(_callId, spawnedRuns) } catch { /* ignore */ }
              return
            }
            /* ★0926d（设计口径终版）：失败链=**挂 1 个自己上，挂 ≥2 个先重派一轮**——
               · 失败 1 个（3 中挂 1 / 2 中挂 1）→ 不重派，主 agent 直接自己上补做；
               · 失败 ≥2 个（3 中挂 2 / 2 挂 2 / 3 挂 3）→ 换新分身重派失败的那些一轮，**重试仍失败的 → 主 agent 自己上**；
               · 限流类失败（429）不进重试（环境问题重试无意义，0925y 教训），如实汇报等用户调策略。 */
            const isRateLimited = (r: { result: string }) => /429|速率|rate.?limit|too many/i.test(r.result || '')
            const retryableFails = results.map((r, i) => (!r.ok && !r.aborted && !isRateLimited(r)) ? i : -1).filter(i => i >= 0)
            if (retryableFails.length >= 2 && !abortedSince(lite.sessionId, t0)) {
              lite.log('warn', 'tool', `[分身] ${retryableFails.length} 个分身失败（≥2）——换新分身重派一轮`)
              const retry = await Promise.all(retryableFails.map(i => runCloneOnce(lite, self, slots[i], String(tasks[i]?.task || ''), goal, t0)))
              spawnedRuns.push(...collectRuns(retry))
              retry.forEach((r2, k) => { results[retryableFails[k]] = r2 })
            }
            /* ★0929 P1（分身刷新恢复兜底）：把本次 spawn 的全部 run 快照（含首轮失败/重试轮）
               按 toolCallId 登记进 session.subRuns（随会话落盘）——injectSubRuns 的 subRuns
               兜底原来只认 team_dispatch、分身 run 从不入表；黑板被清/60 条滚动裁掉后
               分身气泡无从恢复（0929 排查实锤）。server.ts 接线；未设回调=老行为。 */
            try { lite.registerSubRuns?.(_callId, spawnedRuns) } catch { /* 登记失败不拦汇报 */ }
            /* 重派期间用户又点停止 → 同样不汇报 */
            if (abortedSince(lite.sessionId, t0) || results.some(r => (r as any).aborted)) return
            const lines = results.map(r =>
              `[${r.name}] ${r.ok ? '完成' : `失败（${r.attempts} 次）`}\n产出摘要：${r.result || '(未汇报)'}`)
            const allOk = results.every(r => r.ok)
            lite.notifyCloneDone?.(
              `【分身回归】分身回归（${results.filter(r => r.ok).length}/${results.length} 成功）。\n\n${lines.join('\n\n')}\n\n` +
              (allOk ? '下一步：汇总各分身产出并向用户交付。' : '下一步：有分身失败——按失败链：失败 1 个直接自己上补做；失败 ≥2 个已自动重派过一轮、**重试仍失败的由你自己上**；预判难解决（缺权限/缺信息/方向不明）就立即向用户汇报现状与建议，不要硬撑。'),
            )
          } catch (e) {
            /* ★0929 P0（停止级联兜底）：异常中断路径击杀失控分身——批次异常时
               Promise.all 走人但分身子任务还在跑，且注册状态不一致导致 abortSubAgents 表够不着。 */
            try { lite.abortSubAgents?.() } catch { /* ignore */ }
            if (!abortedSince(lite.sessionId, t0)) {
              lite.notifyCloneDone?.(`【分身回归】批次异常中止：${String((e as any)?.message || e).slice(0, 200)}`)
            }
          } finally {
            /* ★ 0925x：无论成败，槽位都释放（分身1/2/3 循环复用） */
            slots.forEach(s => releaseSlot(lite.sessionId, s))
          }
        })()
        return {
          content: [{
            type: 'text',
            text: `已派出 ${tasks.length} 个分身（${self.name} 分身${slots.join('/')}）并行开工，完成后自动把产出摘要送回本对话。\n` +
              '请**就此收轮挂起**：一两句告知用户即可，不要做总结/后续规划、不要继续做别的事；' +
              '「分身回归」消息到达后按其中指引收尾：汇总产出向用户交付；有失败的按失败链（失败 1 个自己补做；失败 ≥2 个已自动重派过一轮、重试仍失败的自己上；预判难解决就向用户汇报现状与建议）。' +
              '等待期间只有用户插话或后台任务通知才需要响应。',
          }],
          details: { detached: true, spawned: tasks.length },
        }
      },
    },
  ]
}
