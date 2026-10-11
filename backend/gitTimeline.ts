/**
 * 版本面板数据源（只读）：当前仓库信息 + 提交时间线。
 *
 * 两条口径（写死在这里，别在别处再猜）：
 *  ① **git 是目录级的** —— 同一个仓库根 = 同一份历史。判定"是不是同一个项目"只认
 *     `git rev-parse --show-toplevel` 的路径。所以面板顶部必须把这个路径亮给用户看，不做静默兜底。
 *  ② **来源对话写在提交里**（trailer：Nis-Session / Nis-Session-Title / Nis-Source）——
 *     换机器、清缓存、重新克隆都不会丢。旧提交没有这几行 ⇒ 如实留空（前端显示"无来源"），不猜、不回填。
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { gitExe } from './gitExe.ts'

/** 字段分隔（提交正文里不会出现的控制字符） */
const SEP = '\u0001'
/** 块分隔（每条提交之间） */
const END = '\u0002'

/**
 * 给提交信息附上"来源对话"（写入口径 —— 与上面读的键名**必须一致**）：
 *   Nis-Source: ai|user        谁提交的
 *   Nis-Session: <会话 id>      哪个窗口
 *   Nis-Session-Title: <标题>   窗口名（供人看）
 * 用 git trailer 惯例（空行分段 + 键值行），`git log` 里直接可见。
 */
export function withNisTrailer(
  msg: string,
  o: { sessionId?: string; sessionTitle?: string; source?: 'ai' | 'user' },
): string {
  const lines = [`Nis-Source: ${o.source || 'ai'}`]
  const sid = String(o.sessionId || '').trim()
  if (sid) lines.push(`Nis-Session: ${sid}`)
  const title = String(o.sessionTitle || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 120)
  if (title) lines.push(`Nis-Session-Title: ${title}`)
  return `${String(msg).trim()}\n\n${lines.join('\n')}`
}

function run(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(gitExe(), args, { cwd, windowsHide: true, maxBuffer: 8 * 1024 * 1024, timeout: 30000 }, (err, stdout, stderr) => {
      if (err && (err as any).code === 'ENOENT') return reject(new Error('本机没有安装 git（或不在 PATH）'))
      if (err) reject(new Error(String(stderr || err.message).trim().slice(0, 300)))
      else resolve(String(stdout))
    })
  })
}

interface GitCommitView {
  hash: string
  short: string
  /** 毫秒时间戳 */
  at: number
  author: string
  subject: string
  /** 来源对话（提交 trailer；旧提交没有=undefined） */
  sessionId?: string
  sessionTitle?: string
  source?: 'ai' | 'user'
  files: number
  added: number
  removed: number
  /** 只在「其他存档点」区出现：它来自哪个备份标签 */
  tagName?: string
}

interface GitTimelineView {
  isRepo: boolean
  /** 仓库根绝对路径（判定"同一个项目"的唯一判据） */
  repoRoot?: string
  /** 会话工作目录（可能 ≠ repoRoot，用于提示"改了却没提交进这个仓库"） */
  workDir?: string
  branch?: string
  /** 未提交改动数（0=干净） */
  dirty?: number
  commits: GitCommitView[]
  /** 「其他存档点」：备份标签上可达、但已不在当前历史里的提交（被「回到这里」移出的那些线）——
   *  置灰显示但可以跳回去，于是 1/2/3 之间能自由来回，不用建分支。 */
  detached?: GitCommitView[]
  /** 不是仓库/没有 git/命令失败时的原始原因（如实回，不吞） */
  error?: string
}

/** 解析 `git log --numstat --pretty=format:…` 的输出（头行 + 正文 trailer + numstat）。
 *  「当前历史」与「其他存档点」共用这一份口径 —— 别在别处再写一遍。 */
function parseCommitLog(raw: string): GitCommitView[] {
  const commits: GitCommitView[] = []
  /* 按行扫，不按块切：git 把提交头放在 `%x02` 之前、numstat 行放在它之后（两个"块"），
     按块首行解析会漏掉除了第一条以外的全部提交（实测踩过）。 */
  let cur: GitCommitView | null = null
  let trailer = ''
  for (const rawLine of raw.split('\n')) {
    const line = rawLine.split(END).join('').trim()
    if (!line) continue
    if (line.includes(SEP)) {
      const [hash, short, at, author, subject] = line.split(SEP)
      cur = {
        hash, short, at: Number(at) * 1000, author, subject,
        files: 0, added: 0, removed: 0,
      }
      commits.push(cur)
      trailer = ''
      continue
    }
    if (!cur) continue
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line)
    if (m) {
      cur.files++
      if (m[1] !== '-') cur.added += Number(m[1])
      if (m[2] !== '-') cur.removed += Number(m[2])
      continue
    }
    // trailer 只认我们自己的键（正文里的普通文字不参与判定）
    if (/^Nis-(Session|Session-Title|Source):/i.test(line)) {
      trailer += line + '\n'
      const grab = (k: string) => (trailer.match(new RegExp(`^${k}:\\s*(.+)$`, 'mi')) || [])[1]?.trim()
      const src = grab('Nis-Source')?.toLowerCase()
      cur.sessionId = grab('Nis-Session')
      cur.sessionTitle = grab('Nis-Session-Title')
      cur.source = src === 'ai' || src === 'user' ? (src as 'ai' | 'user') : undefined
    }
  }
  return commits
}

/** 一条命令拿全部：提交头 + 正文(trailer) + 每个文件的增删行 */
export async function buildGitTimeline(cwd: string, limit = 30): Promise<GitTimelineView> {
  const wd = String(cwd || '').trim()
  if (!wd) return { isRepo: false, commits: [], error: '这个会话还没有工作区目录' }
  try {
    const repoRoot = (await run(wd, ['rev-parse', '--show-toplevel'])).trim()
    /* ⚠️ 空仓库（刚 init、0 提交）没有 HEAD：`rev-parse --abbrev-ref HEAD` 同样会失败 ——
       分支名如实留空即可（上面 rev-parse --show-toplevel 已经证明"是仓库"）。 */
    const branch = await run(wd, ['rev-parse', '--abbrev-ref', 'HEAD']).then(s => s.trim()).catch(() => '')
    const dirtyOut = await run(wd, ['status', '--porcelain']).catch(() => '')
    const dirty = dirtyOut.trim() ? dirtyOut.trim().split('\n').length : 0
    const n = Math.min(100, Math.max(1, Number(limit) || 30))
    /* ⚠️ 空仓库（刚 init、还没有任何提交）时 `git log` 会退 128 并报 "does not have any commits yet" ——
       那不是"不是仓库"，是"还没有提交"：这里咽掉错误、按 0 条提交处理（上面 rev-parse 已经证明是仓库）。 */
    const raw = await run(wd, [
      'log', '-n', String(n), '--numstat',
      `--pretty=format:%H${SEP}%h${SEP}%at${SEP}%an${SEP}%s%n%b${END}`,
    ]).catch(() => '')
    const commits = parseCommitLog(raw)
    // 「其他存档点」：每个备份标签上"可达、但已不在当前历史里"的提交 —— 即被「回到这里」移出的那些线。
    // 置灰显示 + 可跳回 ⇒ 1/2/3 之间能自由来回（不用真建分支）。
    let detached: GitCommitView[] = []
    try {
      const tags = (await run(wd, ['tag', '-l', 'nis-backup-*'])).trim().split('\n').map(s => s.trim()).filter(Boolean)
      const seen = new Set(commits.map(c => c.hash))
      for (const tg of tags.slice(-5)) {
        // ⚠️ 顺序要紧：`git log <tag> --not HEAD` —— `--not` 只作用于**它之后**的 revision，
        // 写成 `log --not HEAD … <tag>` 会把 tag 一起排除、结果永远是空（实测踩过）。
        const out = await run(wd, [
          'log', tg, '--not', 'HEAD', '-n', '20', '--numstat',
          `--pretty=format:%H${SEP}%h${SEP}%at${SEP}%an${SEP}%s%n%b${END}`,
        ]).catch(() => '')
        for (const c of parseCommitLog(out)) {
          if (seen.has(c.hash)) continue
          seen.add(c.hash)
          detached.push({ ...c, tagName: tg })
        }
      }
      detached.sort((a, b) => b.at - a.at)
      detached = detached.slice(0, 20)
    } catch { /* 备份标签读不出来不影响主流程 */ }
    return { isRepo: true, repoRoot, workDir: wd, branch, dirty, commits, detached }
  } catch (e: any) {
    // 不是仓库 / 没有 git —— 原文回给前端显示（空态提示要看得懂原因）
    return { isRepo: false, workDir: wd, commits: [], error: String(e?.message || e).slice(0, 300) }
  }
}

/**
 * 提交前预检：数一数到底有多少文件会被提交。
 * ⚠️ 必须 `-uall` 展开未跟踪目录 —— 默认的 `git status` 会把整个未跟踪目录**折叠成一行**，
 * 于是面板上"未提交 20"背后可能藏着四万个文件（实测踩过：916MB 临时目录被折成几行）。
 */
export async function previewCommitFiles(
  cwd: string,
): Promise<{ ok: boolean; files: number; bytes: number; sampled: boolean; error?: string }> {
  const wd = String(cwd || '').trim()
  if (!wd) return { ok: false, files: 0, bytes: 0, sampled: false, error: '没有目标目录' }
  try {
    const out = await run(wd, ['status', '--porcelain', '-uall']).catch(() => '')
    const lines = out.trim() ? out.trim().split('\n') : []
    // 体积：只对前 2000 个文件 stat（四万次 stat 在 Windows 上要好几秒；预检是估算，够用了）
    const LIMIT = 2000
    let bytes = 0
    for (const l of lines.slice(0, LIMIT)) {
      const rel = l.slice(3).trim().replace(/^"|"$/g, '')
      try {
        const st = fs.statSync(path.join(wd, rel))
        if (st.isFile()) bytes += st.size
      } catch { /* 竞态（刚被删/改名）：跳过，预检不追求精确 */ }
    }
    return { ok: true, files: lines.length, bytes, sampled: lines.length > LIMIT }
  } catch (e: any) {
    return { ok: false, files: 0, bytes: 0, sampled: false, error: String(e?.message || e).slice(0, 200) }
  }
}

interface GitResetResult {
  ok: boolean
  /** 操作前自动打的备份标签名（后悔药：`git checkout <标签>` 或 `git reset --hard <标签>`） */
  backup?: string
  /** 被移出当前历史的提交数 */
  moved?: number
  /** 一并丢弃的未提交改动数（含未跟踪文件） */
  discarded?: number
  error?: string
}

/**
 * 「回到这个存档点」：把工作区 + 历史一起回到某条提交的状态（= git reset --hard）。
 * ⚠️ 这是**危险**操作（之后的提交会移出历史、未提交改动会丢）⇒ 因此：
 *   ① **先自动打备份标签**，打不上就**直接中止**（没有后悔药就不做危险操作）；
 *   ② 把"移出几条 / 丢了多少未提交改动"如实回给前端展示，不静默。
 */
export async function resetToCommit(cwd: string, hash: string): Promise<GitResetResult> {
  const wd = String(cwd || '').trim()
  const h = String(hash || '').trim()
  if (!wd) return { ok: false, error: '没有目标目录' }
  if (!/^[0-9a-f]{7,40}$/i.test(h)) return { ok: false, error: '提交号看着不对：' + h.slice(0, 40) }
  try {
    const head = (await run(wd, ['rev-parse', 'HEAD'])).trim()
    if (head.toLowerCase().startsWith(h.toLowerCase())) return { ok: false, error: '已经在这个提交上了，不用回' }
    const moved = Number((await run(wd, ['rev-list', '--count', `${h}..HEAD`]).catch(() => '0')).trim()) || 0
    const dirtyOut = await run(wd, ['status', '--porcelain', '-uall']).catch(() => '')
    const discarded = dirtyOut.trim() ? dirtyOut.trim().split('\n').length : 0

    const t = new Date()
    const p = (n: number) => String(n).padStart(2, '0')
    const tag = `nis-backup-${t.getFullYear()}${p(t.getMonth() + 1)}${p(t.getDate())}-${p(t.getHours())}${p(t.getMinutes())}${p(t.getSeconds())}`
    let tagged = true
    try { await run(wd, ['tag', tag, 'HEAD']) } catch { tagged = false }
    if (!tagged) return { ok: false, error: '备份标签没打成功，为安全已中止（没有备份就不做危险操作）' }

    await run(wd, ['reset', '--hard', h])
    return { ok: true, backup: tag, moved, discarded }
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e).slice(0, 400) }
  }
}

interface GitDropBackupResult {
  ok: boolean
  /** 清掉了几个备份标签 */
  dropped?: number
  error?: string
}

/**
 * 清除备份标签（= 删掉「其他存档点」里的那条线）。
 * 只删**标签**，不动提交、不动工作区；清完后那条线不再有引用，将来可能被 git 回收（弹窗里如实告知用户）。
 * tag 传空 = 清除全部 `nis-backup-*` 标签（只认我们自己的前缀，不碰用户的其它标签）。
 */
export async function dropBackups(cwd: string, tag?: string): Promise<GitDropBackupResult> {
  const wd = String(cwd || '').trim()
  if (!wd) return { ok: false, error: '没有目标目录' }
  const one = String(tag || '').trim()
  if (one && !/^nis-backup-[\w.-]+$/.test(one)) return { ok: false, error: '标签名不对：' + one.slice(0, 60) }
  try {
    if (one) {
      await run(wd, ['tag', '-d', one])
      return { ok: true, dropped: 1 }
    }
    const tags = (await run(wd, ['tag', '-l', 'nis-backup-*'])).trim().split('\n').map(s => s.trim()).filter(Boolean)
    for (const tg of tags) await run(wd, ['tag', '-d', tg]).catch(() => '')
    return { ok: true, dropped: tags.length }
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e).slice(0, 300) }
  }
}

/** 取"作者兜底参数"：仓库/全局没配 git 作者时，用 `git -c` 临时带上（**不回写任何配置**）。
 *  commit 和 revert（revert 内部也会生成提交）都要用 —— 新 init 的仓库常常没配作者。 */
async function authorArgs(wd: string): Promise<{ args: string[]; fallback: boolean }> {
  const hasName = await run(wd, ['config', 'user.name']).then(s => !!s.trim()).catch(() => false)
  const hasMail = await run(wd, ['config', 'user.email']).then(s => !!s.trim()).catch(() => false)
  const args: string[] = []
  let fallback = false
  if (!hasName) { args.push('-c', 'user.name=NIS'); fallback = true }
  if (!hasMail) { args.push('-c', 'user.email=nis@local'); fallback = true }
  return { args, fallback }
}

interface GitCommitResult {
  ok: boolean
  hash?: string
  short?: string
  files?: number
  added?: number
  removed?: number
  /** 仓库没配 git 作者 ⇒ 用了临时兜底（不回写任何配置，如实标出来） */
  authorFallback?: boolean
  error?: string
}

/**
 * 手动提交（用户在版本面板点的）。
 * 与 AI 提交（tools.ts 的 git_commit）共用同一个 trailer 口径，只有来源不同：这里固定 `Nis-Source: user`。
 * 空仓库 / 没配 git 作者：用 `git -c` **临时**兜底作者，不改动用户任何配置，并在结果里标 authorFallback。
 */
export async function commitRepo(
  cwd: string,
  message: string,
  o: { sessionId?: string; sessionTitle?: string; path?: string } = {},
): Promise<GitCommitResult> {
  const wd = String(cwd || '').trim()
  const msg = String(message || '').trim()
  if (!wd) return { ok: false, error: '没有目标目录' }
  if (!msg) return { ok: false, error: '提交要写一句说明' }
  try {
    // 明确 add 全部改动（含新文件）—— 空仓库第一次提交也必须能进来
    if (o.path) await run(wd, ['add', '--', String(o.path)])
    else await run(wd, ['add', '-A'])
    const { args: cfg, fallback } = await authorArgs(wd)
    await run(wd, [
      ...cfg, 'commit', '-m',
      withNisTrailer(msg, { sessionId: o.sessionId, sessionTitle: o.sessionTitle, source: 'user' }),
    ])
    const hash = await run(wd, ['rev-parse', 'HEAD']).then(s => s.trim()).catch(() => '')
    const short = await run(wd, ['rev-parse', '--short', 'HEAD']).then(s => s.trim()).catch(() => '')
    const stat = await run(wd, ['show', '--numstat', '--format=', 'HEAD']).catch(() => '')
    let files = 0, added = 0, removed = 0
    for (const l of stat.split('\n')) {
      const m = /^(\d+|-)\t(\d+|-)\t/.exec(l.trim())
      if (!m) continue
      files++
      if (m[1] !== '-') added += Number(m[1])
      if (m[2] !== '-') removed += Number(m[2])
    }
    return { ok: true, hash, short, files, added, removed, authorFallback: fallback }
  } catch (e: any) {
    // 失败原因照实回（"nothing to commit" / 没权限 / 路径不是仓库…）—— 不吞、不假装成功
    return { ok: false, error: String(e?.message || e).slice(0, 400) }
  }
}

interface GitRevertResult {
  ok: boolean
  short?: string
  /** 有冲突（会把仓库恢复原状再报，不留半截状态） */
  conflict?: boolean
  error?: string
}

/**
 * 撤销某次提交：`git revert`（生成一条**反向提交**，历史保留、事后还能再撤销）。
 * 冲突时**先 `revert --abort` 回到操作前**，再把冲突如实报给用户 —— 绝不留下半截的合并状态。
 */
export async function revertCommit(cwd: string, hash: string): Promise<GitRevertResult> {
  const wd = String(cwd || '').trim()
  const h = String(hash || '').trim()
  if (!wd) return { ok: false, error: '没有目标目录' }
  if (!/^[0-9a-f]{7,40}$/i.test(h)) return { ok: false, error: '提交号看着不对：' + h.slice(0, 40) }
  try {
    // revert 内部也要生成提交 ⇒ 同样需要作者（新 init 的仓库常常没配）
    const { args: cfg } = await authorArgs(wd)
    await run(wd, [...cfg, 'revert', '--no-edit', h])
    const short = await run(wd, ['rev-parse', '--short', 'HEAD']).then(s => s.trim()).catch(() => '')
    return { ok: true, short }
  } catch (e: any) {
    let conflict = false
    try {
      const st = await run(wd, ['status', '--porcelain']).catch(() => '')
      conflict = /^(UU|AA|DD|U.|.U)\s/m.test(st)
      if (conflict) await run(wd, ['revert', '--abort']).catch(() => '')
    } catch { /* 清理失败也不掩盖原始错误 */ }
    return { ok: false, conflict, error: String(e?.message || e).slice(0, 400) }
  }
}

interface GitInitView {
  ok: boolean
  repoRoot?: string
  branch?: string
  /** true = 本来就在某个仓库里（本目录或上级），没重复初始化 */
  already?: boolean
  error?: string
}

/**
 * 从一段文本（通常是会话消息的 JSON）里反推"跟本对话有关的仓库"。
 *
 * 只认**证据**：文本里出现过的绝对路径 → 取所属目录 → 能被 git 认成仓库的才留下（按出现次数排序）。
 * 不猜：没有证据就没有候选 —— 宁可列表是空的，也不塞一个"可能相关"的仓库进去。
 * 它要抓的典型场景：在 A 工作区里改 B 的文件（那 B 的路径就会出现在会话里）。
 */
export async function relatedRepos(
  text: string,
  maxCandidates = 8,
  maxRepos = 6,
): Promise<Array<{ repoRoot: string; hits: number }>> {
  const src = String(text || '').slice(0, 2_000_000)
  const dirs = new Map<string, number>()
  for (const m of src.matchAll(/[A-Za-z]:[\\/][^"'\s,;:)}\][<>|*?\n]{2,200}/g)) {
    let p = m[0]
    // 中文标点（“；，。”等不在上面的排除集里）会被一起吃进来 → 从第一个标点处截断
    // （中文**目录名**本身不含标点，所以不受影响；否则会拼出一个不存在的路径）
    p = p.split(/[；，。、！？：）】》"'`（）]/)[0]
    p = p.replace(/\\\\/g, '\\').replace(/[\\/]+$/, '')
    if (p.length < 6) continue
    // 像文件名的，退到它所在目录
    if (/\.[A-Za-z0-9]{1,8}$/.test(p)) {
      const cut = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'))
      if (cut < 4) continue
      p = p.slice(0, cut)
    }
    if (p.length < 6) continue
    dirs.set(p, (dirs.get(p) || 0) + 1)
  }
  const candidates = [...dirs.entries()].sort((a, b) => b[1] - a[1]).slice(0, maxCandidates)
  const out = new Map<string, { repoRoot: string; hits: number }>()
  for (const [dir, hits] of candidates) {
    try {
      if (!fs.existsSync(dir)) continue
      const root = (await run(dir, ['rev-parse', '--show-toplevel'])).trim()
      if (!root) continue
      const key = root.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
      const prev = out.get(key)
      out.set(key, { repoRoot: root, hits: (prev?.hits || 0) + hits })
    } catch { /* 不是仓库的候选直接跳过（很常见，不算错误） */ }
  }
  return [...out.values()].sort((a, b) => b.hits - a.hits).slice(0, maxRepos)
}

/**
 * 初始化仓库：只跑 `git init`（在该目录**新增 .git**），**不 add、不 commit、不碰任何既有文件**。
 * 纪律：只在用户点按钮时调用（绝不自动执行）；目录不存在 / 上级已有仓库 ⇒ 如实回，不制造嵌套仓库。
 */
export async function initGitRepo(dir: string): Promise<GitInitView> {
  const wd = String(dir || '').trim()
  if (!wd) return { ok: false, error: '没有目标目录' }
  if (!fs.existsSync(wd)) return { ok: false, error: '目录不存在：' + wd }
  try {
    // 已经在某个仓库里（本目录或上级）就复用，不再 init —— 免得造出嵌套仓库
    try {
      const root = (await run(wd, ['rev-parse', '--show-toplevel'])).trim()
      if (root) {
        let branch = ''
        try { branch = (await run(wd, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim() } catch { /* 空仓库没有 HEAD */ }
        return { ok: true, repoRoot: root, branch, already: true }
      }
    } catch { /* 不在仓库里 —— 往下走 init */ }
    await run(wd, ['init'])
    const repoRoot = (await run(wd, ['rev-parse', '--show-toplevel'])).trim()
    let branch = ''
    try { branch = (await run(wd, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim() } catch { /* 空仓库还没有分支名 */ }
    return { ok: true, repoRoot, branch, already: false }
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e).slice(0, 300) }
  }
}
