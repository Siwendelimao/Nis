/**
 * fileHistory —— AI 文件写入历史（撤销/审查数据层）
 *
 * 设计（docs/research-0902.md §1.5 v1 定稿）：
 *  - 精确快照：fs_write / fs_delete / fs.rename 执行前，把目标文件 beforeContent
 *    gzip 落盘（sha256 内容寻址去重），记一条 change（含来源 sessionId/memberName/toolCallId）
 *  - 树快照：run_command 执行前整工作区 gzip 打包（兜底覆盖 shell 重定向/脚本写入）
 *  - 恢复：fs.history.restore —— 无冲突直接写回；有冲突（当前内容 ≠ 快照后内容）
 *    返回 conflict=true 由前端走 DiffBlock 分支（另存 .restored / 放弃）
 *  - 生命周期：历史存 <工作区>/.nis-history/（跟会话走）；删除会话时打包迁移；
 *    全局 500MB LRU 兜底
 *  - 不覆盖用户手改：恢复时当前内容与快照后内容不符即判冲突，绝不盲写
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import zlib from 'node:zlib'
import { execFile } from 'node:child_process'
import { DATA_ROOT } from './paths.ts'
import { loadJsonOrBackup, writeJsonAtomic } from './jsonStore.ts'

/** 全局内容库：sha256 → { content(gzip), size, refs, lastAccess }（跨会话去重） */
/* ★ 0924 修复（产品要求）：原用 `process.cwd()/data` 求历史库根 —— 打包版 cwd = <安装目录>/pack/backend，
   于是历史对象落进**程序目录**（实测安装版 91.8MB 就在 D:\nIs0.1.0\NIS\pack\backend\data\file-history），
   与其它数据（DATA_ROOT = 安装目录/data，壳注入 NIS_DATA_DIR）不同源；换/重装 pack 即丢，
   也违反 0919 口径「不要有让用户看不到的地方」。现统一挂 DATA_ROOT：
   · 开发态：cwd=backend，两者本就同址 → 行为零变化；
   · 打包版：新位置还没有、旧位置有内容时 → **一次性复制**过来（保留旧目录当备份），
     保证旧历史的「撤销/审查」仍能取到对象；复制失败则退回旧位置（只记日志，不阻塞启动）。 */
const DATA_HISTORY_ROOT = path.join(DATA_ROOT, 'file-history')
const LEGACY_CWD_HISTORY_ROOT = path.join(process.cwd(), 'data', 'file-history')
function resolveHistoryRoot(): string {
  if (path.resolve(DATA_HISTORY_ROOT) === path.resolve(LEGACY_CWD_HISTORY_ROOT)) return DATA_HISTORY_ROOT
  if (fs.existsSync(DATA_HISTORY_ROOT)) return DATA_HISTORY_ROOT
  if (!fs.existsSync(LEGACY_CWD_HISTORY_ROOT)) return DATA_HISTORY_ROOT
  try {
    fs.mkdirSync(path.dirname(DATA_HISTORY_ROOT), { recursive: true })
    fs.cpSync(LEGACY_CWD_HISTORY_ROOT, DATA_HISTORY_ROOT, { recursive: true })
    console.log('[fileHistory] 历史库已从旧位置迁到 DATA_ROOT：' + LEGACY_CWD_HISTORY_ROOT + ' → ' + DATA_HISTORY_ROOT + '（旧目录可留作备份，也可删）')
  } catch (e: any) {
    try { fs.rmSync(DATA_HISTORY_ROOT, { recursive: true, force: true }) } catch { /* 清理半成品失败无所谓 */ }
    console.log('[fileHistory] 迁移失败，本次继续用旧位置：' + String(e?.message || e))
    return LEGACY_CWD_HISTORY_ROOT
  }
  return DATA_HISTORY_ROOT
}
const HISTORY_ROOT = resolveHistoryRoot()
const OBJECTS_DIR = path.join(HISTORY_ROOT, 'objects')
const GLOBAL_BUDGET_BYTES = 500 * 1024 * 1024
/** 单文件快照阈值：超过不存全文改存树级兜底，超大直接明示不纳入 */
const SNAPSHOT_MAX_BYTES = 10 * 1024 * 1024
/** 单条 change 元数据保留上限（LRU 硬顶之外的第二道闸） */
let MAX_CHANGES_PER_SESSION = 200

/** 0910 三批⑤：历史配额可调（设置页 historyMaxPerSession；缺省 200，夹在 50-2000） */
export function setHistoryQuota(n: unknown): void {
  const v = Number(n)
  if (Number.isFinite(v) && v >= 50) MAX_CHANGES_PER_SESSION = Math.min(2000, Math.floor(v))
}

/** 0910 三批⑤：历史配额按**对话**裁剪——原先对整工作区一刀切，项目内多对话共享工作区时，
 *  A 对话写得多会把 B 对话的历史挤出去。无 sessionId 的存量记录归入共享池（最旧优先裁）。 */
function pruneChangesBySession(changes: HistoryChange[], sessionId: string | undefined, limit: number): void {
  const key = sessionId || ''
  const same = (c: HistoryChange) => (c.sessionId || '') === key
  while (changes.filter(same).length > limit) {
    const idx = changes.findIndex(same)
    if (idx < 0) break
    changes.splice(idx, 1)
  }
}
/** 0910 磁盘治理：树快照/内容 GC 都跳过的目录（依赖/构建产物/版本库——快照它们=21GB 事故根因；
 *  且 tree 快照本就"只写不读"（restoreChange 拒绝、面板只列 kind=file），跳过零功能损失 */
/* ★ 0924：加了 'data'。
   事故：`project_run_command` 的工作区 = **项目根**（D:\nis0812），而项目根的 `backend\data`
   里堆着 39 万文件 / 28GB（其中一半正是本模块自己的 objects，见下方 file-history 4.1GB）。
   实测：按老名单扫一遍项目根 = **33.2 万文件 / 11GB，光 readdir+stat 就 100.8 秒**，
   而 snapshotTree 是**全同步**的（readFileSync + sha256 + gzip 写盘），事件循环被堵死几分钟
   ⇒ 前端所有请求超时，用户看到的就是「说两句话后端又断了」（进程其实还活着）。
   `data/` 属于运行时数据、不是源码，本就该排除在"撤销/审查"语义之外。 */
const SNAPSHOT_SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.nuxt', 'coverage', '__pycache__', '.venv', 'venv', 'target', '.zcode', 'data'])

/* ★ 0924：**两道兜底闸门**（防「换个大工作区又踩同一个坑」）。
   树快照本就是"尽力而为"的兜底（只有 shell 重定向写入才需要它），
   到顶就**放弃这次快照**——宁可没有树快照，也绝不能堵住事件循环。
   · 文件数闸门：一眼能看出"这目录太大"；
   · 时间闸门（更本质）：实测即使文件数不多，光"逐个 readFileSync + sha256 + gzip + 写盘"
     也能吃掉几十秒（项目根跳掉 data 后仍要 41 秒）——用 wall-clock 直接兜死。 */
const SNAPSHOT_MAX_FILES = 5000
const SNAPSHOT_BUDGET_MS = 1500

function ensureDirs(): void {
  fs.mkdirSync(OBJECTS_DIR, { recursive: true })
}

function sha256(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

function objPath(hash: string): string {
  return path.join(OBJECTS_DIR, hash.slice(0, 2), `${hash}.gz`)
}

/** 存内容块（去重）：已存在则 bump 引用与访问时间，否则 gzip 落盘 */
export function putObject(content: Buffer): { hash: string; size: number; bytesWritten: number } {
  ensureDirs()
  const hash = sha256(content)
  const target = objPath(hash)
  if (fs.existsSync(target)) {
    try { fs.utimesSync(target, new Date(), new Date()) } catch { /* ignore */ }
    return { hash, size: content.length, bytesWritten: 0 }
  }
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const gz = zlib.gzipSync(content, { level: 6 })
  fs.writeFileSync(target, gz)
  return { hash, size: content.length, bytesWritten: gz.length }
}

function getObject(hash: string): Buffer | null {
  const target = objPath(hash)
  if (!fs.existsSync(target)) return null
  try {
    fs.utimesSync(target, new Date(), new Date())
    return zlib.gunzipSync(fs.readFileSync(target))
  } catch {
    return null
  }
}

/** 会话历史元数据文件：<工作区>/.nis-history/changes.json */
function changesFile(workDir: string): string {
  return path.join(workDir, '.nis-history', 'changes.json')
}

function loadChanges(workDir: string): HistoryChange[] {
  /* ★0927 netfix：坏档走 jsonStore —— 原实现 catch 吞掉返回 []，随后任何 saveChanges 就把
     整份历史记录覆盖成空（撤销/审查数据全丢）。现在坏档先备份 .corrupt-* 再回落，原档可捞。 */
  try {
    const r = loadJsonOrBackup<{ changes?: HistoryChange[] }>(changesFile(workDir), () => ({ changes: [] }))
    return Array.isArray(r.data?.changes) ? r.data.changes : []
  } catch {
    return []
  }
}

export function saveChanges(workDir: string, changes: HistoryChange[]): void {
  const dir = path.join(workDir, '.nis-history')
  fs.mkdirSync(dir, { recursive: true })
  writeJsonAtomic(changesFile(workDir), { version: 1, changes })
}

export interface HistoryChange {
  id: string
  t: number
  /** 0910 三批④：所属对话 id —— 历史按对话隔离，撤销只认本对话的改动。
   *  此前无此维度且按 workDir 存：项目内多对话共享工作区时，A 撤销会连 B 的改动一起回滚（串数据） */
  sessionId?: string
  /** 'fs_write' | 'fs_delete' | 'fs_rename' | 'run_command'（树快照） */
  tool: string
  /** 执行来源：主 agent / 成员名 / 用户撤销 */
  actor: string
  toolCallId?: string
  /** 所属对话轮次（按对话轮次分组展示用）：turnId=本轮 user 消息摘要，turnIndex=会话内序号 */
  turnId?: string
  turnIndex?: number
  /** 文件级 diff 量（前后内容行数差异，展示 +N-M 用）：新增/删除行数 */
  diffAdded?: number
  diffRemoved?: number
  /** 撤销动作记录专属：被恢复的原始 change id（前端"撤销恢复"按钮据此反查：
   *  恢复本条 = 撤销那次恢复 = 回到 AI 修改后的状态） */
  undoOf?: string
  /** file 级变更明细（run_command 树快照时为 tree 类型） */
  kind: 'file' | 'tree'
  /** kind=file：相对工作区路径 */
  relPath?: string
  /** 改动前内容哈希（删除/新建时为空串） */
  beforeHash?: string
  /** 改动后内容哈希（供冲突检测：当前文件应等于 afterHash 才算"无冲突"） */
  afterHash?: string
  /** existedBefore：文件此前是否存在 */
  existedBefore?: boolean
  /** 改动前字节数 */
  beforeBytes?: number
  /** 撤销该条之后，同文件的后续记录全部作废（restoreChange 标记）：不可再重做 */
  voided?: boolean
}

type ChangeState = 'active' | 'undone' | 'superseded'

/* ★1004n（实测反馈"最新一轮灰色/灰亮闪现"根因）：relPath 可能是**跨盘符绝对路径**——
 * path.relative 跨盘（工作区在 C:、项目在 D:）直接返回目标绝对路径；再 join(workDir, relPath)
 * 会拼出无效路径 ⇒ existsSync 恒 false ⇒ 一律误判 superseded（灰）且撤销恢复会写错位置。
 * 所有 relPath→绝对路径的解析统一走这里（versionEffective/restoreChange/快照回填/后端恢复）。 */
export function resolveChangePath(workDir: string, relPath: string): string {
  return path.isAbsolute(relPath) ? relPath : path.join(workDir, relPath)
}

/** 该 change 写出的版本是否仍是文件当前版本（afterHash 空=删除类：当前不存在即生效；
 *  beforeHash 也为空=新建类且 after 快照缺失：文件存在即生效） */
function versionEffective(workDir: string, change: HistoryChange): boolean {
  if (!change.relPath || change.kind !== 'file') return true
  const abs = resolveChangePath(workDir, change.relPath)
  const exists = fs.existsSync(abs)
  if (change.afterHash) {
    if (!exists) return false
    try {
      return sha256(fs.readFileSync(abs)) === change.afterHash
    } catch {
      return false
    }
  }
  return change.beforeHash ? !exists : exists
}

/** 三态生效判定（0902-3 反馈 #2：区分"被覆盖"与"已撤销"）：
 *  - active     本条写出的版本仍生效 → 撤销按钮可点
 *  - undone     用户撤销过本条（存在 undoOf 指向本条、未被作废、且其写回版本仍生效的"用户撤销"留痕）
 *               → 黄字"已撤销" + 恢复按钮可点
 *  - superseded 后续改动推进了版本 → 灰色禁用，不再显示"已撤销"
 *  撤销后再恢复（redo）会把撤销留痕连同其后同路径全部记录标 voided，故只认未作废的生效留痕。 */
export function changeStatus(workDir: string, change: HistoryChange, all: HistoryChange[]): ChangeState {
  if (!change.relPath || change.kind !== 'file') return 'active'
  if (versionEffective(workDir, change)) return 'active'
  const trace = all.find(c => c.undoOf === change.id && !c.voided &&
    (c.actor === '用户撤销' || c.actor === '用户撤销(整轮)') && versionEffective(workDir, c))
  return trace ? 'undone' : 'superseded'
}

/** 轮次汇总（变更区组头一次批量算，替代前端逐条 status 往返）：
 *  turnStates 的判定范围 = 该轮全部未作废的 AI 文件级 change（不受前端"同轮同文件取最新"
 *  代表条目折叠影响）：任一被撤销 → undone；全部被后续轮次覆盖 → superseded；否则 active */
export function turnSummaries(workDir: string, sid?: string): Record<number, { undone: boolean; supersededAll: boolean; fileCount: number }> {
  const all = listChanges(workDir)
  const out: Record<number, { undone: boolean; supersededAll: boolean; fileCount: number }> = {}
  const byTurn = new Map<number, HistoryChange[]>()
  for (const c of all) {
    // 0929 隔离修复：team 成员聊天/其他窗口与主会话共享同一 workDir，turnIndex 口径不同——
    // 不过滤会把成员会话的轮次混进主会话组头（文件数串位、撤销状态互扰）。
    // 口径与 fs.history.restoreTurn（0910 三批④）一致：无 sessionId 的存量记录兼容放行。
    if (sid && c.sessionId && c.sessionId !== sid) continue
    if (c.kind !== 'file' || !c.relPath || c.voided) continue
    if (c.actor === '用户撤销' || c.actor === '用户撤销(整轮)') continue
    if (typeof c.turnIndex !== 'number' || c.turnIndex < 1) continue
    const arr = byTurn.get(c.turnIndex) || []
    arr.push(c)
    byTurn.set(c.turnIndex, arr)
  }
  for (const [ti, cs] of byTurn) {
    let undone = false
    let supersededAll = cs.length > 0
    for (const c of cs) {
      const st = changeStatus(workDir, c, all)
      if (st === 'undone') undone = true
      if (st !== 'superseded') supersededAll = false
    }
    out[ti] = { undone, supersededAll, fileCount: new Set(cs.map(c => c.relPath)).size }
  }
  return out
}

/** 行级 diff 量统计（LCS 行数差）：展示 +N-M 用，不做逐行对齐 */
function diffStat(before: Buffer | null, after: Buffer | null): { diffAdded: number; diffRemoved: number } {
  const a = before ? before.toString('utf8').split(/\r\n|\r|\n/) : []
  const b = after ? after.toString('utf8').split(/\r\n|\r|\n/) : []
  // LCS 长度（滚动数组；快照文件上限 10MB，行数上万美元级也够快）
  const n = a.length, m = b.length
  let prev = new Uint32Array(m + 1)
  let cur = new Uint32Array(m + 1)
  for (let i = 1; i <= n; i++) {
    const ai = a[i - 1]
    for (let j = 1; j <= m; j++) {
      cur[j] = ai === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1])
    }
    ;[prev, cur] = [cur, prev]
  }
  const lcs = prev[m]
  return { diffAdded: m - lcs, diffRemoved: n - lcs }
}

/** 精确快照：写/删/改名前调用。返回 changeId（异常静默——快照失败不阻塞业务） */
export function snapshotFile(opts: {
  workDir: string
  absPath: string
  tool: string
  actor: string
  /** 0910 三批④：所属对话（撤销按对话隔离用） */
  sessionId?: string
  toolCallId?: string
  /** 所属对话轮次（按轮次分组展示） */
  turn?: { turnId: string; turnIndex: number }
  /** 改名后的新绝对路径（rename 场景：before 记旧路径内容，after 记新路径） */
  newAbsPath?: string
}): string | null {
  try {
    const rel = path.relative(opts.workDir, opts.absPath).replace(/\\/g, '/')
    if (rel.startsWith('..')) return null
    if (rel.startsWith('.nis-history')) return null
    const existed = fs.existsSync(opts.absPath)
    let beforeBuf: Buffer | null = null
    if (existed) {
      const st = fs.statSync(opts.absPath)
      if (st.size > SNAPSHOT_MAX_BYTES) return null // 超大文件不纳入（明示策略）
      beforeBuf = fs.readFileSync(opts.absPath)
    }
    let afterHash = ''
    let afterBuf: Buffer | null = null
    const afterPath = opts.newAbsPath || opts.absPath
    if (fs.existsSync(afterPath)) {
      const st2 = fs.statSync(afterPath)
      if (st2.size <= SNAPSHOT_MAX_BYTES) {
        afterBuf = fs.readFileSync(afterPath)
        afterHash = sha256(afterBuf)
      }
    }
    let beforeHash = ''
    let beforeBytes = 0
    if (beforeBuf) {
      const put = putObject(beforeBuf)
      beforeHash = put.hash
      beforeBytes = beforeBuf.length
    }
    const change: HistoryChange = {
      id: crypto.randomUUID(),
      t: Date.now(),
      tool: opts.tool,
      actor: opts.actor,
      sessionId: opts.sessionId,
      toolCallId: opts.toolCallId,
      turnId: opts.turn?.turnId,
      turnIndex: opts.turn?.turnIndex,
      kind: 'file',
      relPath: rel,
      beforeHash,
      afterHash,
      existedBefore: existed,
      beforeBytes,
    }
    // diff 量仅在有前后两个版本时可算（rename 后路径存在的场景）；
    // fs_write 常规路径是"写入前快照"，此刻"改动后"内容尚不存在（afterHash 空）——
    // diff 由读取侧懒算（fs.history.diffStat 用 beforeHash+当前内容补算）
    if (beforeBuf && afterBuf) {
      const st3 = diffStat(beforeBuf, afterBuf)
      change.diffAdded = st3.diffAdded
      change.diffRemoved = st3.diffRemoved
    }
    const changes = loadChanges(opts.workDir)
    changes.push(change)
    pruneChangesBySession(changes, opts.sessionId, MAX_CHANGES_PER_SESSION)
    saveChanges(opts.workDir, changes)
    return change.id
  } catch {
    return null
  }
}

/** 树快照：run_command 执行前调用。整工作区 gzip 打包（排除 .nis-history 自身） */
export function snapshotTree(opts: { workDir: string; actor: string; sessionId?: string; toolCallId?: string; turn?: { turnId: string; turnIndex: number } }): string | null {
  try {
    const workDir = opts.workDir
    if (!fs.existsSync(workDir)) return null
    const files: Array<{ rel: string; hash: string }> = []
    /* ★ 0924：到预算就**立刻停止遍历**（不是扫完再判断）—— 这一步是关键，
       否则在大工作区上光"扫完"就已经把事件循环堵死了。 */
    let overBudget = false
    const snapT0 = Date.now()
    const walk = (dir: string) => {
      if (overBudget) return
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (overBudget) return
        if (Date.now() - snapT0 > SNAPSHOT_BUDGET_MS) { overBudget = true; return }
        if (e.name === '.nis-history') continue
        const full = path.join(dir, e.name)
        if (e.isDirectory()) {
          // 0910 磁盘治理：依赖/构建产物/版本库不进树快照（cordis 会话在工作区=E:\nis0812 时
          // 反复整仓快照堆出 21GB；tree 快照本就"只写不读"——restoreChange 拒绝、面板只列 file）
          if (SNAPSHOT_SKIP_DIRS.has(e.name)) continue
          walk(full); continue
        }
        try {
          const st = fs.statSync(full)
          if (st.size > SNAPSHOT_MAX_BYTES) continue
          if (files.length >= SNAPSHOT_MAX_FILES) { overBudget = true; return }
          const rel = path.relative(workDir, full).replace(/\\/g, '/')
          files.push({ rel, hash: putObject(fs.readFileSync(full)).hash })
        } catch { /* ignore 单文件失败 */ }
      }
    }
    walk(workDir)
    if (overBudget) {
      console.warn(`[fileHistory] 工作区过大（>${SNAPSHOT_MAX_FILES} 文件，或超 ${SNAPSHOT_BUDGET_MS}ms 预算；已扫 ${files.length} 个 / 耗时 ${Date.now() - snapT0}ms）：${workDir} → 跳过本次树快照（保护事件循环，命令照常执行）`)
      return null
    }
    const manifest = Buffer.from(JSON.stringify({ files }), 'utf8')
    const { hash: manifestHash } = putObject(manifest)
    const changes = loadChanges(workDir)
    changes.push({
      id: crypto.randomUUID(),
      t: Date.now(),
      tool: 'run_command',
      actor: opts.actor,
      sessionId: opts.sessionId,
      toolCallId: opts.toolCallId,
      turnId: opts.turn?.turnId,
      turnIndex: opts.turn?.turnIndex,
      kind: 'tree',
      beforeHash: manifestHash,
    })
    pruneChangesBySession(changes, opts.sessionId, MAX_CHANGES_PER_SESSION)
    saveChanges(workDir, changes)
    return changes[changes.length - 1].id
  } catch {
    return null
  }
}

/** 查询：会话历史列表（面板条目用；树快照标 kind=tree） */
export function listChanges(workDir: string): HistoryChange[] {
  return loadChanges(workDir).slice().reverse()
}

/** 读某个哈希的内容（审查/恢复用） */
export function readObject(hash: string): Buffer | null {
  return getObject(hash)
}

/** diff 量懒算（读取侧补算 fs_write 常规路径的 +N-M：快照是"写入前"语义，改动后内容当时不存在）。
 *  afterBuf 传 null 表示按当前磁盘内容计算 */
export function diffStatByHash(beforeHash: string, afterBuf: Buffer | null): { diffAdded: number; diffRemoved: number } | null {
  const before = beforeHash ? getObject(beforeHash) : null
  if (!before) return null
  const after = afterBuf || null
  if (!after) return null
  return diffStat(before, after)
}

/** 写入后回填：fs_write 完成后把"改动后"内容哈希与 diff 量补到 change 上
 *  （快照语义是"写入前"，当时 afterHash 还算不出来——审查/冲突检测需要 afterHash）
 *  ★ 0929：返回 diff 量（工具行要显示 +N/-M）；新文件没有 before → 全部算新增行 */
export function markAfterContent(workDir: string, changeId: string, afterContent: Buffer): { diffAdded: number; diffRemoved: number } | null {
  try {
    const changes = loadChanges(workDir)
    const c = changes.find(x => x.id === changeId)
    if (!c) return null
    const put = putObject(afterContent)
    c.afterHash = put.hash
    let st = { diffAdded: 0, diffRemoved: 0 }
    if (c.beforeHash) {
      const before = getObject(c.beforeHash)
      if (before) st = diffStat(before, afterContent)
    } else {
      st = { diffAdded: afterContent.toString('utf8').split('\n').length, diffRemoved: 0 }
    }
    c.diffAdded = st.diffAdded
    c.diffRemoved = st.diffRemoved
    saveChanges(workDir, changes)
    return st
  } catch { return null /* 静默：回填失败不影响业务 */ }
}

/** 恢复判断：当前文件内容是否仍等于 change.afterHash（无冲突） */
export function checkConflict(workDir: string, change: HistoryChange): { conflict: boolean; currentHash: string } {
  const abs = resolveChangePath(workDir, change.relPath || '')
  let currentHash = ''
  try {
    if (fs.existsSync(abs)) currentHash = sha256(fs.readFileSync(abs))
  } catch { /* ignore */ }
  const expected = change.afterHash || ''
  // 删除类变更：afterHash 为空 → 当前不存在才算无冲突
  const conflict = change.tool === 'fs_delete' ? currentHash !== '' : currentHash !== expected
  return { conflict, currentHash }
}

/** 执行恢复：写回 beforeHash 内容。返回 conflictWarning 标记（当前内容 ≠ 该次修改后
 *  的状态，说明用户可能手改过）——但不硬拒绝：恢复旧版本本身总是合法操作，
 *  覆盖防护由前端确认弹窗承担（面板与工具块都会先弹确认）。
 *  dryRun：只探测"这条撤销能不能真执行"——不落盘、不作废任何记录（组头本轮撤销可用性判定用） */
export function restoreChange(workDir: string, changeId: string, opts?: { dryRun?: boolean }): { ok: boolean; error?: string; restoredPath?: string; conflictWarning?: boolean } {
  const changes = loadChanges(workDir)
  const idx = changes.findIndex(c => c.id === changeId)
  if (idx === -1) return { ok: false, error: '记录不存在' }
  const change = changes[idx]
  if (change.kind === 'tree') return { ok: false, error: 'tree 级恢复请逐文件操作（面板展开文件清单）' }
  const { conflict: conflictWarning } = checkConflict(workDir, change)
  const abs = resolveChangePath(workDir, change.relPath || '')
  if (opts?.dryRun) {
    // 硬阻断两例：快照内容已被 LRU 清掉（写不回去）；新建类回退=删除但文件本就不存在（空操作）
    if (change.beforeHash && !getObject(change.beforeHash)) return { ok: false, error: '快照内容已失效（可能被 LRU 清理）', conflictWarning }
    if (!change.beforeHash && !fs.existsSync(abs)) return { ok: false, error: '文件已不存在（无可回退动作）', conflictWarning }
    return { ok: true, restoredPath: change.relPath, conflictWarning }
  }
  try {
    if (change.beforeHash) {
      const buf = getObject(change.beforeHash)
      if (!buf) return { ok: false, error: '快照内容已失效（可能被 LRU 清理）' }
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      fs.writeFileSync(abs, buf)
    } else {
      // beforeHash 为空 = 文件此前不存在 → 恢复 = 删除
      if (fs.existsSync(abs)) fs.rmSync(abs)
    }
    // 作废此 change 之后对同一文件的所有更新记录（保留可看，不可再重做）
    for (let i = idx + 1; i < changes.length; i++) {
      if (changes[i].kind === 'file' && changes[i].relPath === change.relPath) (changes[i] as any).voided = true
    }
    saveChanges(workDir, changes)
    return { ok: true, restoredPath: change.relPath, conflictWarning }
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) }
  }
}





/** 全局 GC（0910 磁盘治理重写）：引用计数安全回收，超预算再按最旧 tree 快照整链淘汰。
 *  旧版"按 atime 盲删"是死代码（无人调用）且会误删被引用对象——重写为两步：
 *  ① 删孤儿（所有已知工作区的 changes.json + tree 清单展开后都不引用的对象）
 *  ② 仍超 GLOBAL_BUDGET_BYTES → 按时间从旧到新淘汰 tree 快照链（清单对象 + 其独占文件对象，
 *    计数归零才删；被别的快照共享的对象保留）。tree 快照"只写不读"（restoreChange 拒绝、
 *    面板只列 kind=file），淘汰零功能损失。
 *  workDirs：调用方（server.ts）传入全部已知工作区（活跃会话 + sessions.json 恢复 + 滞留处 +
 *  仓库根）；另外恒扫 NisData 两层目录兜底，防漏报。 */
const GC_MIN_INTERVAL_MS = 60 * 60 * 1000  // 全库扫描不便宜：每小时最多跑一次
let lastGcAt = 0
/** opts.force=true：跳过 1h 限流（自动/手动清理刚裁掉记录，需要立即物理回收对象；否则要等下一小时） */
export function enforceBudget(workDirs?: string[], opts?: { force?: boolean }): { deletedOrphans: number; freedBytes: number } {
  const now = Date.now()
  if (!opts?.force && now - lastGcAt < GC_MIN_INTERVAL_MS) return { deletedOrphans: 0, freedBytes: 0 }
  lastGcAt = now
  let deletedOrphans = 0, freedBytes = 0
  try {
    if (!fs.existsSync(OBJECTS_DIR)) return { deletedOrphans, freedBytes }
    // 1) 收集引用计数：直接引用（changes.json 的 before/afterHash）+ tree 清单展开
    const refCount = new Map<string, number>()
    const treeEntries: Array<{ workDir: string; t: number; manifestHash: string }> = []
    const seenCf = new Set<string>()
    const bump = (h: string) => { if (h) refCount.set(h, (refCount.get(h) || 0) + 1) }
    const collectCf = (cf: string, workDir: string) => {
      if (seenCf.has(cf)) return
      seenCf.add(cf)
      try {
        const j = JSON.parse(fs.readFileSync(cf, 'utf8'))
        for (const ch of (Array.isArray(j) ? j : (j.changes || []))) {
          bump(ch.beforeHash); bump(ch.afterHash)
          if (ch.kind === 'tree' && ch.beforeHash) treeEntries.push({ workDir, t: ch.t || 0, manifestHash: ch.beforeHash })
        }
      } catch { /* 坏文件跳过 */ }
    }
    for (const wd of (workDirs || [])) collectCf(changesFile(wd), wd)
    // NisData 兜底扫描（两层：聊天工作区 + projects/<id>）
    const scanRoot = (root: string, depth: number) => {
      if (depth > 2) return
      let entries: fs.Dirent[]
      try { entries = fs.readdirSync(root, { withFileTypes: true }) } catch { return }
      for (const e of entries) {
        if (!e.isDirectory()) continue
        const full = path.join(root, e.name)
        const cf = path.join(full, '.nis-history', 'changes.json')
        if (fs.existsSync(cf)) collectCf(cf, full)
        if (e.name === 'projects' || depth === 0) scanRoot(full, depth + 1)
      }
    }
    scanRoot(NIS_DATA_WORKDIRS, 0)
    // tree 清单 BFS 展开（清单对象引用的文件也计数；同一清单内同 hash 去重）
    const readObj = (h: string): Buffer | null => {
      const p = objPath(h)
      try { return fs.existsSync(p) ? zlib.gunzipSync(fs.readFileSync(p)) : null } catch { return null }
    }
    const expanded = new Set<string>()
    let frontier = treeEntries.map(e => e.manifestHash)
    while (frontier.length) {
      const next: string[] = []
      for (const h of frontier) {
        if (expanded.has(h)) continue
        expanded.add(h)
        const buf = readObj(h)
        if (!buf) continue
        if (buf.slice(0, 10).toString('latin1') !== '{"files":[') continue
        try {
          const j = JSON.parse(buf.toString('utf8'))
          const inner = new Set<string>()
          for (const f of (j.files || [])) { if (f?.hash && !inner.has(f.hash)) { inner.add(f.hash); bump(f.hash); next.push(f.hash) } }
        } catch { /* ignore */ }
      }
      frontier = next
    }
    // 2) 删孤儿
    let total = 0
    for (const d of fs.readdirSync(OBJECTS_DIR)) {
      const sub = path.join(OBJECTS_DIR, d)
      let st: fs.Stats
      try { st = fs.statSync(sub) } catch { continue }
      if (!st.isDirectory()) continue
      for (const f of fs.readdirSync(sub)) {
        const full = path.join(sub, f)
        let fst: fs.Stats
        try { fst = fs.statSync(full) } catch { continue }
        total += fst.size
        const h = f.replace(/\.gz$/, '')
        if (!refCount.has(h)) {
          try { fs.rmSync(full); deletedOrphans++; freedBytes += fst.size; total -= fst.size } catch { /* ignore */ }
        }
      }
    }
    // 3) 仍超预算 → 按最旧 tree 链淘汰（清单 + 独占文件对象；共享对象计数>1 不动）
    treeEntries.sort((a, b) => a.t - b.t)
    for (const te of treeEntries) {
      if (total <= GLOBAL_BUDGET_BYTES) break
      const drop = (h: string | undefined) => {
        if (!h) return
        const c = refCount.get(h)
        if (c === undefined || c <= 0) return
        if (c > 1) { refCount.set(h, c - 1); return }
        refCount.delete(h)
        const p = objPath(h)
        try { if (fs.existsSync(p)) { total -= fs.statSync(p).size; freedBytes += fs.statSync(p).size; fs.rmSync(p) } } catch { /* ignore */ }
      }
      const buf = readObj(te.manifestHash)
      drop(te.manifestHash)
      if (buf && buf.slice(0, 10).toString('latin1') === '{"files":[') {
        try {
          const j = JSON.parse(buf.toString('utf8'))
          const inner = new Set<string>()
          for (const f of (j.files || [])) { if (f?.hash && !inner.has(f.hash)) { inner.add(f.hash); drop(f.hash) } }
        } catch { /* ignore */ }
      }
      // 从该工作区 changes.json 里移除这条 tree 条目（面板/统计不再引用它）
      try {
        const changes = loadChanges(te.workDir)
        const kept = changes.filter(c => !(c.kind === 'tree' && c.beforeHash === te.manifestHash))
        if (kept.length !== changes.length) saveChanges(te.workDir, kept)
      } catch { /* ignore */ }
    }
  } catch { /* GC 失败绝不影响业务 */ }
  return { deletedOrphans, freedBytes }
}

const NIS_DATA_WORKDIRS = 'C:/Users/Administrator/Documents/NisData'

/** 孤儿工作区盘点：sessions.json 里没有的工作区目录（数据管理页一键清理的对象） */
export function listOrphanWorkdirs(liveWorkdirs: string[]): Array<{ name: string; bytes: number }> {
  const root = NIS_DATA_WORKDIRS
  const live = new Set(liveWorkdirs.map(w => path.basename(w.replace(/[\\/]+$/, ''))))
  const out: Array<{ name: string; bytes: number }> = []
  try {
    for (const d of fs.readdirSync(root)) {
      const full = path.join(root, d)
      if (!fs.statSync(full).isDirectory()) continue
      if (live.has(d)) continue
      let bytes = 0
      const walk = (dir: string) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const p = path.join(dir, e.name)
          if (e.isDirectory()) walk(p)
          else bytes += fs.statSync(p).size
        }
      }
      try { walk(full) } catch { /* ignore */ }
      out.push({ name: d, bytes })
    }
  } catch { /* ignore */ }
  return out
}

/** 删除目录（孤儿清理用）：保留最近 N 个以防误判 */
export function removeWorkdir(name: string): { ok: boolean; error?: string } {
  if (!/^[\w.-]+$/.test(name)) return { ok: false, error: '非法目录名' }
  // 0906 加固补漏：上面字符类含 '.'，name='..' 能过正则 → 旧代码会 rmSync 递归删除整个 Documents。
  // 断言解析后目标真在 NisData 根内（封死 '..'、点开头目录等一切越界）
  const rootAbs = path.resolve(NIS_DATA_WORKDIRS)
  const full = path.join(NIS_DATA_WORKDIRS, name)
  const fullAbs = path.resolve(full)
  if (fullAbs === rootAbs || !fullAbs.startsWith(rootAbs + path.sep)) {
    return { ok: false, error: '非法目录名（路径越界）' }
  }
  if (!fs.existsSync(full)) return { ok: false, error: '不存在' }
  try {
    fs.rmSync(full, { recursive: true, force: true })
    return { ok: true }
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) }
  }
}

/** 树快照/精确快照的执行包装：run_command 用（child_process 引用转发） */
export { execFile }

// ── 0911 反馈：历史占用统计与自动清理 ──────────────────────────────────────────
// 背景：历史按工作区各自存放（<工作区>/.nis-history/changes.json + 全局去重对象库），
// 占用增长由对象库决定。设置页展示占用，并提供「占用达 X MB 时清理最旧 Y%」的自动/手动清理。

/** 工作区发现：显式传入（活跃会话 + 仓库根）∪ NisData 两层兜底扫描（与 enforceBudget 同口径） */
function discoverHistoryWorkdirs(extra: string[]): string[] {
  const out = new Set<string>()
  for (const wd of extra || []) { if (wd && wd.trim()) out.add(path.resolve(wd.trim())) }
  const scan = (root: string, depth: number) => {
    if (depth > 2) return
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(root, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const full = path.join(root, e.name)
      if (fs.existsSync(changesFile(full))) out.add(path.resolve(full))
      if (e.name === 'projects' || depth === 0) scan(full, depth + 1)
    }
  }
  scan(NIS_DATA_WORKDIRS, 0)
  return Array.from(out)
}

/** 占用统计（设置页展示）：totalBytes=对象库实际磁盘占用（跨工作区去重后）；
 *  workspaces=各工作区记录数/估算体积（beforeBytes 合计，未去重，仅作分布参考） */
export function historyStats(workDirs: string[]): {
  totalBytes: number
  objectCount: number
  totalChanges: number
  workspaces: Array<{ name: string; changes: number; bytes: number }>
} {
  let totalBytes = 0
  let objectCount = 0
  try {
    if (fs.existsSync(OBJECTS_DIR)) {
      for (const d of fs.readdirSync(OBJECTS_DIR)) {
        const sub = path.join(OBJECTS_DIR, d)
        let st: fs.Stats
        try { st = fs.statSync(sub) } catch { continue }
        if (!st.isDirectory()) continue
        for (const f of fs.readdirSync(sub)) {
          try {
            const fst = fs.statSync(path.join(sub, f))
            if (fst.isFile()) { totalBytes += fst.size; objectCount++ }
          } catch { /* ignore */ }
        }
      }
    }
  } catch { /* ignore */ }
  let totalChanges = 0
  const workspaces: Array<{ name: string; changes: number; bytes: number }> = []
  for (const wd of discoverHistoryWorkdirs(workDirs)) {
    const changes = loadChanges(wd)
    if (!changes.length) continue
    totalChanges += changes.length
    workspaces.push({
      name: path.basename(wd.replace(/[\\/]+$/, '')) || wd,
      changes: changes.length,
      bytes: changes.reduce((a, c) => a + (c.beforeBytes || 0), 0),
    })
  }
  workspaces.sort((a, b) => b.bytes - a.bytes)
  return { totalBytes, objectCount, totalChanges, workspaces }
}

/** 自动/手动清理：占用超阈值（或 force）时，把全部工作区的记录按时间从旧到新裁掉 pct%——
 *  先裁元数据（changes.json），再强制 GC 物理回收对象。内容寻址去重保证安全：
 *  仍被较新记录引用的对象引用计数>0 不动，只删引用归零的；被裁记录的撤销入口随之消失（预期行为）。
 *  opts.force=true：忽略阈值（设置页「立即清理」用）。 */
export function autoCleanHistory(
  workDirs: string[],
  thresholdBytes: number,
  pct: number,
  opts?: { force?: boolean },
): { triggered: boolean; removedWorkspaces: number; removedChanges: number; freedBytes: number; totalBytes: number } {
  const before = historyStats(workDirs).totalBytes
  const over = Number.isFinite(thresholdBytes) && thresholdBytes > 0 && before > thresholdBytes
  if (!opts?.force && !over) return { triggered: false, removedWorkspaces: 0, removedChanges: 0, freedBytes: 0, totalBytes: before }
  const ratio = Math.min(90, Math.max(5, Math.floor(Number(pct) || 20)))
  const dirs = discoverHistoryWorkdirs(workDirs)
  const all: Array<{ workDir: string; t: number; id: string }> = []
  for (const wd of dirs) for (const c of loadChanges(wd)) all.push({ workDir: wd, t: c.t || 0, id: c.id })
  if (!all.length) return { triggered: true, removedWorkspaces: 0, removedChanges: 0, freedBytes: 0, totalBytes: before }
  all.sort((a, b) => a.t - b.t)
  const dropCount = Math.max(1, Math.floor((all.length * ratio) / 100))
  const dropByDir = new Map<string, Set<string>>()
  for (let i = 0; i < dropCount && i < all.length; i++) {
    const e = all[i]
    let set = dropByDir.get(e.workDir)
    if (!set) { set = new Set(); dropByDir.set(e.workDir, set) }
    set.add(e.id)
  }
  let removedChanges = 0
  let removedWorkspaces = 0
  for (const [wd, ids] of dropByDir) {
    try {
      const changes = loadChanges(wd)
      const kept = changes.filter(c => !ids.has(c.id))
      if (kept.length !== changes.length) {
        removedChanges += changes.length - kept.length
        removedWorkspaces++
        saveChanges(wd, kept)
      }
    } catch { /* ignore */ }
  }
  // 强制 GC：跳过 1h 限流，立即回收引用归零的对象
  const gc = enforceBudget(workDirs, { force: true })
  const after = historyStats(workDirs).totalBytes
  return {
    triggered: true,
    removedWorkspaces,
    removedChanges,
    freedBytes: Math.max(0, before - after, gc.freedBytes),
    totalBytes: after,
  }
}
