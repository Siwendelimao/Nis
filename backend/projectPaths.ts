/**
 * ★ 0921z：工作区 root_path（项目根 / 会话 workDir）**绝对路径规范化与存量迁移**。
 *
 * ── 为什么需要它 ──
 * 历史 bug：前端新建项目时用**浏览器 API** 取目录（`showDirectoryPicker` / `webkitdirectory`），
 * 浏览器安全沙箱只给**目录名**（拿不到绝对路径）→ 项目 root_path 被存成 `chat_20260921_141903`
 * 这类相对路径 → 各处以「后端进程 cwd」为基准解析：
 *   · dev（cwd=backend）    → D:\nis0812\backend\chat_20260921_141903
 *   · 打包版（cwd=pack\backend）→ D:\NIS\pack\backend\chat_20260921_141903
 * 结果是**同一个工作区在两处生根**：项目档案、产出、下载各落一份，会话之间互相看不见。
 * （前端取值来源已在 0921y 修好：改用 Tauri 原生目录对话框，拿到的一定是绝对路径。）
 *
 * ── 这里做两件事 ──
 * ① `isAbsolutePath` / `normalizeRootPath`：统一的"是不是绝对路径"判定（Windows 盘符 / UNC / POSIX）
 *    —— 前端建项目校验、后端入库兜底共用同一口径；
 * ② `migrateRootPathsOnDisk`：**存量自愈**。启动时扫一遍 projects.json 与 sessions/*.json，
 *    把相对 root_path / workDir 尽量还原成**真实存在的绝对目录**（候选根按语义优先级探测，
 *    见 `candidateRoots`），落盘前整份备份，可回滚。
 *
 * 幂等：已经是绝对路径的一律原样保留（只去尾斜杠），可重复执行。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

/** 是否为绝对路径（Windows 盘符 `D:\`/`D:/`、UNC `\\server\share`、POSIX `/x`） */
export function isAbsolutePath(p: string): boolean {
  const s = String(p || '').trim()
  if (!s) return false
  if (/^[a-zA-Z]:[\\/]/.test(s)) return true
  if (/^[a-zA-Z]:$/.test(s)) return true          // 罕见：只给盘符（视作根）
  if (s.startsWith('\\\\') || s.startsWith('//')) return true
  return s.startsWith('/')
}

/** 规范化绝对路径：统一分隔符、去掉尾斜杠（盘符根 `C:\` 保留） */
export function normalizeRootPath(p: string): string {
  const s = String(p || '').trim()
  if (!s) return ''
  let out = path.normalize(s)
  if (out.length > 3) out = out.replace(/[\\/]+$/, '')
  return out
}

/** 候选基准目录（按语义优先级，先storage根、再数据根、最后历史 cwd 与盘符根） */
function candidateRoots(opts: { storageRoot?: string; dataRoot?: string; cwd?: string }): string[] {
  const list: string[] = []
  const push = (p?: string) => {
    const v = String(p || '').trim()
    if (v && !list.includes(v)) list.push(v)
  }
  const storage = String(opts.storageRoot || '').trim()
  const data = String(opts.dataRoot || '').trim()
  const cwd = String(opts.cwd || process.cwd()).trim()
  push(storage)
  push(data)
  if (storage) push(path.dirname(storage))
  if (data) push(path.dirname(data))
  push(cwd)
  push(path.dirname(cwd))
  // 盘符根兜底：历史脏数据常是"用户在某个盘里选的目录名"（如 `nis0812` → `D:\nis0812`）
  for (const base of [...list]) {
    const root = path.parse(base).root
    if (root && !list.includes(root)) list.push(root)
  }
  return list.filter(Boolean)
}

interface RelativeResolution {
  /** 迁移后的绝对路径（一定非空，除非入参为空） */
  path: string
  /** true=命中了真实存在的目录；false=所有候选都不存在，按 storage 根兜底（仍是绝对路径，但需人工确认） */
  resolved: boolean
  /** 命中的基准目录（或 'fallback'），用于日志/交接说明 */
  via: string
}

/**
 * 把相对 root_path 还原成绝对路径：按 `candidateRoots` 顺序探测，**取第一个真实存在的目录**。
 * 都不存在时退化为 `<storageRoot>/<rel>`（保证是绝对路径，不再随后端 cwd 漂移）。
 */
export function resolveRelativeRoot(rel: string, opts: { storageRoot?: string; dataRoot?: string; cwd?: string }): RelativeResolution {
  const seg = String(rel || '').trim().replace(/^[\\/]+/, '')
  if (!seg) return { path: '', resolved: false, via: 'empty' }
  /* ★1003 修复 4.28：`..` 段 / 盘符相对写法会逃出候选根（`path.join(base, '..\\..')` 指到根外），
   * 再叠加"第一个存在的候选根获胜"，会把 root_path/workDir 悄悄指到别的现存目录——直接判无效，不用。 */
  if (seg.includes('..') || /^[a-zA-Z]:/.test(seg)) return { path: '', resolved: false, via: 'invalid' }
  for (const base of candidateRoots(opts)) {
    const cand = path.join(base, seg)
    try {
      if (fs.existsSync(cand) && fs.statSync(cand).isDirectory()) {
        return { path: normalizeRootPath(cand), resolved: true, via: base }
      }
    } catch { /* 探测失败当不存在 */ }
  }
  const fallbackBase = String(opts.storageRoot || opts.dataRoot || '').trim()
  const fallback = fallbackBase ? path.join(fallbackBase, seg) : path.resolve(seg)
  return { path: normalizeRootPath(fallback), resolved: false, via: 'fallback' }
}

/**
 * ★ 0921z-2：删除**工作区目录**（项目 root_path）—— 走系统回收站，可还原。
 *
 * 与 `migrateRootPathsOnDisk` 同属"路径这一摊"，放这里一起维护。
 *
 * 设计要点：
 * ① **绝不硬删**：用 Shell 的 `delete` 动词 → 进 Windows 回收站（用户可还原）；不用 fs.rm 永久删。
 * ② **硬护栏**（`guardWorkspaceDelete`）：盘符根 / 系统目录 / 受保护目录（数据根、存储根、源码根、
 *    用户主目录…）以及"目标包含受保护目录"一律拒绝 —— 项目 root_path 是用户自己的文件夹，
 *    它既可能是别的 AI 做一半的工作区，也可能是 `D:\nis0812` 这种要命的位置。
 * ③ 路径通过**环境变量**传给 PowerShell（不做字符串拼接）→ 路径里的引号/空格不可能变成注入。
 * ④ 删除是异步的（Shell 处理大目录要时间）→ 调用后**轮询确认**目录真的消失才回 ok。
 */
interface WorkspaceDeleteResult {
  ok: boolean
  path: string
  /** 删除方式：recycle=移入回收站 */
  method?: 'recycle'
  /** 失败原因（中文，可直接展示给用户） */
  error?: string
}

/** 系统关键目录（盘符根下一层，禁止删除） */
const SYSTEM_DIR_BLOCK = new Set([
  'windows', 'program files', 'program files (x86)', 'programdata', 'users',
  'system volume information', 'recovery', '$recycle.bin', 'perflogs',
])

/**
 * 删除前的安全护栏。返回**拒绝原因**（中文），null = 允许删除。
 * @param opts.protect 受保护目录清单（数据根/存储根/源码根/主目录…）：
 *                     目标等于其中任一项、或**包含**其中任一项 → 一律拒绝。
 */
function guardWorkspaceDelete(dir: string, opts?: { protect?: string[] }): string | null {
  const raw = String(dir || '').trim()
  if (!raw) return '路径为空'
  if (!isAbsolutePath(raw)) return '不是绝对路径'
  const target = normalizeRootPath(raw)
  let st: fs.Stats
  try { st = fs.statSync(target) } catch { return '目录不存在（可能已被删除或移动）' }
  if (!st.isDirectory()) return '目标不是目录'
  const root = path.parse(target).root
  if (target.toLowerCase().replace(/[\\/]+$/, '') === root.toLowerCase().replace(/[\\/]+$/, '')) return '目标是盘符根目录'
  /* ★1003 安全批 4.29：原来只挡「盘符根的直接孩子」（按 basename 字面比对）——
   * C:\Windows\System32、C:\Users\Public、D:\Program Files\某App 这类**嵌套系统位置**全能过闸
   * 被送进回收站；短名（PROGRA~1）/尾随点空格也能绕过字面比对。
   * 现在：realpath 规范化（吃掉短名/符号链接）后判断「是否位于任一知名系统目录之内」，在内即拒。 */
  const t2 = (() => { try { return fs.realpathSync(target) } catch { return target } })().toLowerCase().replace(/[\\/]+$/, '')
  const driveRoot = root.toLowerCase().replace(/[\\/]+$/, '')
  const sysDirs = ['windows', 'program files', 'program files (x86)', 'programdata', 'perflogs', path.join('users', 'public')]
  for (const sd of sysDirs) {
    const base = path.join(driveRoot, sd).toLowerCase().replace(/[\\/]+$/, '')
    if (t2 === base || t2.startsWith(base + path.sep)) return '目标是系统目录（或位于系统目录之内）'
  }
  if (path.dirname(target).toLowerCase() === root.toLowerCase() && SYSTEM_DIR_BLOCK.has(path.basename(target).toLowerCase())) return '目标是系统目录'
  const t = path.resolve(target).toLowerCase().replace(/[\\/]+$/, '')
  for (const raw2 of opts?.protect || []) {
    const p = String(raw2 || '').trim()
    if (!p) continue
    const pl = path.resolve(p).toLowerCase().replace(/[\\/]+$/, '')
    if (t === pl) return `目标是受保护目录（${p}）`
    if (pl.startsWith(t + path.sep)) return `目标包含受保护目录（${p}），拒绝删除`
  }
  return null
}

/** 用 Shell 的 delete 动词把目录移入回收站（路径走环境变量，避免注入） */
function spawnShellDelete(target: string): Promise<{ code: number; stderr: string }> {
  const script = [
    '$p = $env:NIS_DEL_TARGET',
    'if (-not (Test-Path -LiteralPath $p)) { exit 0 }',
    "$sh = New-Object -ComObject Shell.Application",
    '$it = $sh.Namespace(0).ParseName($p)',
    'if ($null -eq $it) { exit 3 }',
    "foreach ($v in @('delete','Delete','DELETE')) { try { $it.InvokeVerb($v); exit 0 } catch { } }",
    'exit 4',
  ].join('; ')
  return new Promise((resolve) => {
    const ps = spawn('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      env: { ...process.env, NIS_DEL_TARGET: target },
      windowsHide: true,
    })
    /* ★1003 修复 4.30：Shell delete 动词可能弹模态确认框 / 大目录卡住（-NonInteractive 管不到 COM 对话框），
     * 无超时会把调用方永久挂死——加硬超时，到点杀子进程并报错 */
    const KILL_TIMEOUT_MS = 15000
    let settled = false
    const done = (r: { code: number; stderr: string }) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(r)
    }
    const timer = setTimeout(() => {
      try { ps.kill() } catch { /* 已退出 */ }
      done({ code: -2, stderr: `回收站删除超时（${KILL_TIMEOUT_MS}ms），已终止子进程；若未删完请检查回收站/手动处理` })
    }, KILL_TIMEOUT_MS)
    let err = ''
    ps.stderr?.on('data', (d) => { err += String(d) })
    ps.on('error', (e) => done({ code: -1, stderr: String(e?.message || e) }))
    ps.on('close', (code) => done({ code: code ?? -1, stderr: err.trim() }))
  })
}

/**
 * 删除工作区目录（移入回收站）+ 轮询确认。
 * @param opts.protect  受保护目录（见 guardWorkspaceDelete）
 * @param opts.timeoutMs 等待目录消失的上限（默认 12s，大目录/杀软扫描会慢）
 */
export async function deleteDirToRecycleBin(dir: string, opts?: { protect?: string[]; timeoutMs?: number }): Promise<WorkspaceDeleteResult> {
  const target = normalizeRootPath(String(dir || ''))
  const reason = guardWorkspaceDelete(dir, { protect: opts?.protect })
  if (reason) return { ok: false, path: target, error: reason }
  const { code, stderr } = await spawnShellDelete(target)
  if (code === 3) return { ok: false, path: target, error: 'Shell 无法解析该路径' }
  if (code === 4) return { ok: false, path: target, error: '系统拒绝删除（可能是权限不足或文件被占用）' }
  if (code !== 0 && fs.existsSync(target)) {
    return { ok: false, path: target, error: stderr || `Shell 删除失败（exit ${code}）` }
  }
  // 轮询确认（Shell 删除是异步的）
  const timeout = Math.max(1000, Number(opts?.timeoutMs) || 12000)
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    if (!fs.existsSync(target)) return { ok: true, path: target, method: 'recycle' }
    await new Promise((r) => setTimeout(r, 300))
  }
  return { ok: false, path: target, error: '已发出删除指令，但目录仍在（可能过大或被杀软/程序占用），请稍后确认' }
}

/** 落盘统一入口：原子写（先写 .tmp 再 rename，同 sessions/providers 惯例） */
function writeJsonAtomic(file: string, data: unknown): void {
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8')
  fs.renameSync(tmp, file)
}

interface RootPathMigrationReport {
  dataRoot: string
  storageRoot: string
  dryRun: boolean
  /** projects.json 备份文件路径（dryRun 或无需迁移时为 undefined） */
  backup?: string
  /** 会话改动明细的备份文件（dryRun 或无需迁移时为 undefined） */
  sessionBackup?: string
  projects: {
    scanned: number
    changed: Array<{ id: string; name: string; from: string; to: string; via: string; resolved: boolean }>
    /** 迁移了但候选目录都不存在（需人工确认的项目） */
    unresolved: Array<{ id: string; name: string; to: string }>
  }
  sessions: {
    scanned: number
    changed: Array<{ file: string; sessionId: string; from: string; to: string; via: string }>
  }
}

/** 时间戳后缀（YYYYMMDD-HHmmss） */
function stamp(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/**
 * 存量迁移（幂等，可 dry-run）。**调用时机：后端启动、loadSessions() 之前**——
 * 那时 projects.json / sessions/*.json 还没有被读进内存，直接改盘不会被内存缓存覆盖。
 *
 * @param opts.dataRoot    数据根（含 projects.json / sessions/）
 * @param opts.storageRoot 存储根（settings.storagePath；候选基准第一位）
 * @param opts.dryRun      true=只报告不落盘（审计/回归用）
 */
export function migrateRootPathsOnDisk(opts: { dataRoot: string; storageRoot?: string; cwd?: string; dryRun?: boolean }): RootPathMigrationReport {
  const dataRoot = path.resolve(String(opts.dataRoot || ''))
  const storageRoot = String(opts.storageRoot || '').trim()
  const dryRun = opts.dryRun === true
  const resolveOpts = { storageRoot, dataRoot, cwd: opts.cwd }

  const report: RootPathMigrationReport = {
    dataRoot,
    storageRoot,
    dryRun,
    projects: { scanned: 0, changed: [], unresolved: [] },
    sessions: { scanned: 0, changed: [] },
  }

  // ── ① 项目：projects.json ──
  const projectsFile = path.join(dataRoot, 'projects.json')
  let projectsRaw: any = null
  try { projectsRaw = JSON.parse(fs.readFileSync(projectsFile, 'utf-8')) } catch { projectsRaw = null }
  /** 项目 id → 迁移后 root_path（会话按 projectId 跟着走，比文件系统猜测可靠） */
  const newRootById = new Map<string, string>()
  if (projectsRaw && Array.isArray(projectsRaw.projects)) {
    report.projects.scanned = projectsRaw.projects.length
    for (const p of projectsRaw.projects) {
      const raw = String(p?.root_path || '').trim()
      if (!raw) continue
      if (isAbsolutePath(raw)) {
        const norm = normalizeRootPath(raw)
        if (norm !== raw) p.root_path = norm
        newRootById.set(String(p.id), norm)
        continue
      }
      const r = resolveRelativeRoot(raw, resolveOpts)
      /* ★1003 修复 4.28 连带：判无效（invalid，path 为空）时不动原值、记入 unresolved 等人工确认 */
      if (!r.path) {
        report.projects.unresolved.push({ id: String(p.id || ''), name: String(p.name || ''), to: raw })
        continue
      }
      p.root_path = r.path
      newRootById.set(String(p.id), r.path)
      report.projects.changed.push({ id: String(p.id || ''), name: String(p.name || ''), from: raw, to: r.path, via: r.via, resolved: r.resolved })
      if (!r.resolved) report.projects.unresolved.push({ id: String(p.id || ''), name: String(p.name || ''), to: r.path })
    }
    if (report.projects.changed.length && !dryRun) {
      try {
        report.backup = `${projectsFile}.bak-rootpath-${stamp()}`
        fs.copyFileSync(projectsFile, report.backup)
        writeJsonAtomic(projectsFile, projectsRaw)
      } catch (e) {
        console.error('[paths] projects.json 迁移写盘失败：', e)
      }
    }
  }

  // ── ② 会话：sessions/*.json 的 workDir ──
  const sessionsDir = path.join(dataRoot, 'sessions')
  const sessionBackups: Array<{ file: string; before: any }> = []
  /** ★1003 修复 4.31：改动先攒着，备份没写成功之前一个会话文件都不许动 */
  const pending: Array<{ file: string; j: any; to: string }> = []
  let sessionFiles: string[] = []
  try { sessionFiles = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.json')) } catch { sessionFiles = [] }
  report.sessions.scanned = sessionFiles.length
  for (const f of sessionFiles) {
    const file = path.join(sessionsDir, f)
    let j: any = null
    try { j = JSON.parse(fs.readFileSync(file, 'utf-8')) } catch { continue }
    if (!j || typeof j !== 'object') continue
    const wd = String(j.workDir || '').trim()
    if (!wd || isAbsolutePath(wd)) continue
    const pid = String(j.projectId || j.project_id || '').trim()
    let to = ''
    let via = ''
    if (pid && newRootById.has(pid)) {
      to = newRootById.get(pid) as string
      via = `project:${pid}`
    } else {
      const r = resolveRelativeRoot(wd, resolveOpts)
      to = r.path
      via = r.via
    }
    if (!to) continue
    report.sessions.changed.push({ file: f, sessionId: String(j.id || ''), from: wd, to, via })
    if (!dryRun) {
      /* ★1003 修复 4.1：备份必须存**深拷贝**——`before: j` 存的是引用，下一行 j.workDir = to
       * 就把"备份"本体也改了，落盘的备份全是改后的值，回滚救不回来 */
      sessionBackups.push({ file: f, before: structuredClone(j) })
      pending.push({ file, j, to })
    }
  }
  /* ★1003 修复 4.31：备份**先于**任何会话落盘改动写好；写不出来就整个中止迁移
   *（宁可一个不迁，也不留"改了一半 + 没有备份"的烂摊子） */
  if (pending.length && !dryRun) {
    const bf = path.join(dataRoot, `rootpath-migration-${stamp()}.json`)
    let backupOk = true
    try {
      fs.writeFileSync(bf, JSON.stringify({ at: Date.now(), dataRoot, sessions: sessionBackups }, null, 2), 'utf-8')
      report.sessionBackup = bf
    } catch (e) {
      backupOk = false
      console.error('[paths] 会话备份写盘失败，迁移中止（未改动任何会话文件）：', e)
      report.sessions.changed.splice(0)
    }
    if (backupOk) {
      for (const it of pending) {
        it.j.workDir = it.to
        try { writeJsonAtomic(it.file, it.j) } catch (e) { console.error(`[paths] 会话 ${path.basename(it.file)} 写盘失败：`, e) }
      }
    }
  }

  return report
}
