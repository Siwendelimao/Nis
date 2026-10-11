/**
 * fileLocks.ts —— 文件写入锁（0911 反馈③「文件边界重叠校验」核心）
 *
 * 背景：团队成员并行 1-3 实例后，同一文件被两个成员并发写时无锁无提示——
 * 后写覆盖先写，双方都以为成功（静默互毁）。本模块提供**运行时互斥**：
 *
 * 机制：
 *  - 粒度 = 绝对路径（Windows 下大小写归一）；持锁者 = runId（成员 run / 单聊 run）
 *  - 同 run 重入放行（成员多次写同一文件是正常行为）
 *  - 释放 = run 收尾 finally 调 releaseRun；另外「owner 已失活」时自动抢锁（防残留锁卡死）
 *  - 冲突时不静默——返回结构化拒绝信息，由工具层转成给模型的可操作提示
 *
 * 覆盖范围：fs_write / fs_delete（成员上下文注入 lockCtx 才生效；主 agent 不参与，零影响）。
 * ⚠ 局限：run_command 的 shell 写入（重定向/脚本落盘）无法静态识别，不受此锁约束。
 *
 * 应急开关：环境变量 NIS_FILE_LOCK=0 → 全部放行（运维级兜底，无需改代码）。
 */

import path from 'node:path'

interface FileLockDeny {
  /** 持锁者的展示名（成员名） */
  ownerLabel: string
  /** 持锁开始时间 */
  since: number
}

/** 锁键（归一化绝对路径）→ 持有人 */
interface LockEntry { owner: string; ownerLabel: string; since: number }
const locks = new Map<string, LockEntry>()
/** owner(runId) → 其持有的全部锁键（releaseRun 一次性释放） */
const ownedBy = new Map<string, Set<string>>()

/** run 存活检查（由 server.ts 注入 teamRuntime 的 activeRunIds 查询；缺省视为全部存活） */
let runLiveness: ((runId: string) => boolean) | null = null
export function setFileLockRunLiveness(fn: (runId: string) => boolean): void { runLiveness = fn }

/** 应急开关：NIS_FILE_LOCK=0 停用 */
function fileLockEnabled(): boolean {
  return String(process.env.NIS_FILE_LOCK ?? '1') !== '0'
}

/** 归一化锁键：**先 resolve 成绝对路径**，Windows 大小写不敏感 → 统一小写。
 *  ★1003 并发批 4.9：原来只 normalize 不 resolve —— 同一文件的相对写法（src/a.ts）与绝对写法
 *  算出**两把不同的锁**，两写者各持一把互相覆盖 = 互斥形同虚设。 */
function lockKey(absPath: string): string {
  const n = path.resolve(absPath)
  return process.platform === 'win32' ? n.toLowerCase() : n
}

/**
 * 尝试获取文件写锁。
 * @returns null=获取成功（含重入）；非 null=被他人持有（拒绝，附持有人信息）
 */
export function acquireFileWrite(absPath: string, owner: string, ownerLabel: string): FileLockDeny | null {
  if (!fileLockEnabled() || !owner) return null
  /* ★1003 并发批 4.9：空/空白路径原来 normalize 成 '.'（cwd）—— 上了一把无意义的"锁"，
   * 写入实际裸奔且零提示（正是本模块要消灭的静默失败）。如实告警；空路径的写入本身也活不了。 */
  if (!String(absPath || '').trim()) {
    console.warn('[fileLocks] acquireFileWrite 收到空路径——无法上锁（已告警，写入侧应自行拒绝空路径）')
    return null
  }
  const key = lockKey(absPath)
  const cur = locks.get(key)
  if (cur) {
    if (cur.owner === owner) return null // 同 run 重入：放行
    // 残留锁兜底：原持有人已失活 → 夺取
    if (runLiveness && !runLiveness(cur.owner)) {
      locks.set(key, { owner, ownerLabel, since: Date.now() })
      let set = ownedBy.get(owner)
      if (!set) { set = new Set(); ownedBy.set(owner, set) }
      set.add(key)
      return null
    }
    return { ownerLabel: cur.ownerLabel, since: cur.since }
  }
  locks.set(key, { owner, ownerLabel, since: Date.now() })
  let set = ownedBy.get(owner)
  if (!set) { set = new Set(); ownedBy.set(owner, set) }
  set.add(key)
  return null
}

/** run 收尾释放（幂等；两处 run 的 finally 都调它） */
export function releaseRun(owner: string): void {
  const set = ownedBy.get(owner)
  if (!set) return
  for (const key of set) {
    const cur = locks.get(key)
    if (cur && cur.owner === owner) locks.delete(key)
  }
  ownedBy.delete(owner)
}


/** 冲突拒绝的模型可读提示（成员看到后应换策略，而非重试） */
export function fileLockDenyMessage(absPath: string, deny: FileLockDeny): string {
  const mins = Math.max(0, Math.round((Date.now() - deny.since) / 60000))
  return `【文件锁】${absPath} 正被「${deny.ownerLabel}」写入中（该成员本次任务进行中${mins > 0 ? `，已持有约 ${mins} 分钟` : ''}）。
为避免并行互相覆盖，本次写入被拒绝。处理方式（不要反复重试同一写入）：
1) 该文件不是你的职责范围 → 跳过它，继续完成你任务里其它部分；
2) 你的产出可以独立成新文件 → 写到自己的新文件（汇报时说明）；
3) 该文件确属你的职责、对方越界 → 用 bb_write 汇报本冲突（附文件路径与原因），由指挥官协调。`
}

/* ══ 派发时静态重叠预检（0911 反馈③ 的"提示层"：warn-only，绝不阻断） ══ */

/** 疑似文件路径 token（带常见代码/文档扩展名；宽松匹配 + 白名单收尾，宁可漏报不误报） */
const FILE_TOKEN_RE = /[\w\u4e00-\u9fa5.@\-\\/]+\.(?:ts|tsx|js|jsx|mjs|cjs|vue|json|md|html|htm|css|scss|less|py|java|go|rs|cpp|cs|rb|php|kt|swift|dart|lua|sql|yml|yaml|xml|txt|sh|bat|cmd|ps1|toml|ini|conf|env|svg|png|jpg|jpeg|gif|webp|ico|csv|xlsx?|pptx?|docx?)\b/gi

/** 从任务文本提取归一化文件 token（去首尾 ./、\→/、小写） */
function extractFileTokens(text: string): string[] {
  const out = new Set<string>()
  for (const m of String(text || '').matchAll(FILE_TOKEN_RE)) {
    let t = m[0].trim().replace(/\\/g, '/').toLowerCase().replace(/^[./]+/, '')
    if (!t || t.length < 3 || t.startsWith('.')) continue
    if (t.split('/').length > 6) continue // URL/长路径残留
    out.add(t)
  }
  return [...out]
}

/** 同批任务的文件边界重叠检测：返回提示文本（含重叠文件与涉及任务）或 null。
 *  仅作提示——主 agent 自行判断（分工不同区域/一读一写可忽略；都要写同一文件才需调整）。 */
export function detectDispatchOverlap(tasks: Array<{ text: string; label: string }>): string | null {
  const byToken = new Map<string, Set<string>>()
  for (const t of tasks) {
    for (const tok of extractFileTokens(t.text)) {
      let s = byToken.get(tok)
      if (!s) { s = new Set(); byToken.set(tok, s) }
      s.add(t.label)
    }
  }
  const overlaps = [...byToken.entries()].filter(([, labels]) => labels.size >= 2)
  if (!overlaps.length) return null
  const lines = overlaps.slice(0, 6).map(([tok, labels]) => `- ${tok}（${[...labels].join('、')}）`)
  return `⚠ 文件边界提示（并行防互覆预检）：以下文件被多个任务同时提及——\n${lines.join('\n')}\n若对同一文件是「分工不同区域/一读一写」可忽略；若两个任务都要写入同一文件，建议改为串行（加 deps）或拆分职责——并行写同一文件时，运行时锁会拒绝后写入者。`
}
