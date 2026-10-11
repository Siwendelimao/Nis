/* repoIndex.ts —— 批次C：仓库地图 + 代码语义级搜索的索引核心（0929）
 * 定位：fs_grep 是"按字面找文本"，repo_search 是"按符号/概念找位置"（哪个文件定义了什么、
 *      某功能大概在哪）——介于 grep 与真语义向量之间：**符号 + 词元打分**，零依赖零模型。
 * 索引：.nis-repo-index.json（落工作区，幂等重建；预算护栏同 project_fs_grep 口径）。 */
import fs from 'node:fs'
import path from 'node:path'

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.nis-history', 'target', '__pycache__', '.venv', 'venv', 'coverage', '.next', '.cache', 'toolchain', '.turbo', '.parcel-cache'])
/* ★1010c：构建产物/缓存目录**常有别名**（dist2、dist-probe-1012、.vite-mcptest）—— 精确匹配漏掉它们，
   实测 NIS 仓库被 toolchain/codex(2127 文件)、frontend/.vite*(738)、dist2/dist-probe-1012(369) 吃掉预算，
   索引 truncated 而真源码反而没扫全。这里补"前缀式"判断（这些名字本身就是构建/依赖语义）。 */
const skipDirName = (name: string): boolean =>
  SKIP_DIRS.has(name) || /^(dist|build|out)[-._0-9]/i.test(name) || /^\.vite/.test(name) || /^\.turbo/.test(name)
const CODE_EXT = new Set(['.ts', '.js', '.mjs', '.cjs', '.tsx', '.jsx', '.vue', '.py', '.go', '.rs', '.java', '.kt', '.cs', '.rb', '.php', '.swift', '.c', '.h', '.cpp', '.hpp', '.md', '.json', '.yml', '.yaml', '.toml', '.sh', '.ps1'])
const MAX_FILES = 20000
const MAX_BYTES = 256 * 1024 * 1024
const MAX_MS = 20000
const INDEX_FILE = '.nis-repo-index.json'

interface RepoFileEntry {
  rel: string
  lines: number
  bytes: number
  symbols: Array<{ name: string; line: number }>
  words: string[]
}

interface RepoIndex {
  version: number
  builtAt: number
  workDir: string
  files: Record<string, RepoFileEntry>
  truncated?: boolean
}

const IDENT = /[A-Za-z_$][\w$]*/g
const CJK_RUN = /[\u4e00-\u9fa5]{2,}/g
const SYMBOL_RE = /(?:export\s+)?(?:async\s+)?(?:function|class|const|let|var|def|interface|type|enum|struct|impl)\s+([A-Za-z_$][\w$]*)/g

function tokenize(s: string): string[] {
  const out = new Set<string>()
  const str = String(s || '')
  for (const m of str.toLowerCase().matchAll(IDENT)) {
    const w = m[0]
    if (w.length >= 2) out.add(w)
  }
  // 中文：整词 + 二元组（"定时任务"→定时/时任/任务 —— 无分词库的标准打法，召回稳）
  for (const m of str.matchAll(CJK_RUN)) {
    const run = m[0]
    out.add(run)
    for (let i = 0; i + 1 < run.length; i++) out.add(run.slice(i, i + 2))
  }
  return [...out]
}

function walkFiles(root: string, onFile: (abs: string, rel: string) => boolean): { count: number; truncated: boolean } {
  let count = 0
  let bytes = 0
  let truncated = false
  const t0 = Date.now()
  const stack: string[] = [root]
  while (stack.length) {
    const dir = stack.pop()!
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      if (e.name.startsWith('.nis-')) continue
      const abs = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (skipDirName(e.name)) continue
        stack.push(abs)
      } else {
        const ext = path.extname(e.name).toLowerCase()
        if (!CODE_EXT.has(ext)) continue
        let size = 0
        try { size = fs.statSync(abs).size } catch { continue }
        count++
        bytes += size
        if (count > MAX_FILES || bytes > MAX_BYTES || Date.now() - t0 > MAX_MS) { truncated = true; return { count, truncated } }
        if (!onFile(abs, path.relative(root, abs).replace(/\\/g, '/'))) return { count, truncated: true }
      }
    }
  }
  return { count, truncated }
}

/** 建/重建索引（幂等）：扫代码文件 → 每文件符号 + 词元 */
export function buildIndex(workDir: string): RepoIndex {
  const files: Record<string, RepoFileEntry> = {}
  const t0 = Date.now()
  const walk = walkFiles(workDir, (abs, rel) => {
    let text = ''
    try {
      const st = fs.statSync(abs)
      if (st.size > 2 * 1024 * 1024) { files[rel] = { rel, lines: 0, bytes: st.size, symbols: [], words: [] }; return true }
      text = fs.readFileSync(abs, 'utf8')
    } catch { return true }
    const symbols: Array<{ name: string; line: number }> = []
    const lines = text.split('\n')
    for (let i = 0; i < lines.length && symbols.length < 200; i++) {
      for (const m of lines[i].matchAll(SYMBOL_RE)) symbols.push({ name: m[1], line: i + 1 })
    }
    files[rel] = {
      rel,
      lines: lines.length,
      bytes: Buffer.byteLength(text),
      symbols,
      // 词元=路径词+符号词+内容词（内容词限量防索引膨胀；中文 bigram 让"定时任务"这类概念词搜得到）
      words: [...new Set([...tokenize(`${rel} ${symbols.map(s => s.name).join(' ')}`), ...tokenize(text.slice(0, 60000))])].slice(0, 1500),
    }
    return Date.now() - t0 < MAX_MS
  })
  const idx: RepoIndex = { version: 1, builtAt: Date.now(), workDir, files, truncated: walk.truncated }
  try { fs.writeFileSync(path.join(workDir, INDEX_FILE), JSON.stringify(idx)) } catch { /* 索引写不进就算了，内存照用 */ }
  return idx
}

export function loadIndex(workDir: string): RepoIndex | null {
  try {
    const raw = fs.readFileSync(path.join(workDir, INDEX_FILE), 'utf8')
    const idx = JSON.parse(raw) as RepoIndex
    /* ★1003 安全批 4.35：索引来自磁盘（可篡改/陈旧）——workDir 对不上的索引直接不用，
     * 否则别的目录建的索引被静默套用（rel 是相对另一棵树的，叠加越界读风险）。 */
    if (idx?.version === 1 && idx.files && (!idx.workDir || path.resolve(String(idx.workDir)) === path.resolve(workDir))) return idx
    return null
  } catch { return null }
}

/** 符号/概念级搜索：query 分词 → 符号命中(权重3) + 词元命中(1) + 路径命中(0.5) → top 结果带定义行 */
export function searchIndex(idx: RepoIndex, workDir: string, query: string, limit = 15): Array<{ rel: string; score: number; hits: string[]; line?: number; context?: string }> {
  const qTokens = tokenize(query)
  if (!qTokens.length) return []
  const scored: Array<{ rel: string; score: number; hits: string[]; line?: number }> = []
  for (const f of Object.values(idx.files)) {
    let score = 0
    const hits: string[] = []
    let bestLine: number | undefined
    for (const q of qTokens) {
      for (const s of f.symbols) {
        const n = s.name.toLowerCase()
        if (n === q) { score += 3; hits.push(`符号 ${s.name}`); bestLine = bestLine ?? s.line }
        else if (n.includes(q)) { score += 1.5; if (!hits.includes(`符号 ${s.name}`)) hits.push(`符号 ~${s.name}`); bestLine = bestLine ?? s.line }
      }
      if (f.words.includes(q)) { score += 1; if (!hits.some(h => h.includes(q))) hits.push(`词 ${q}`) }
      if (f.rel.toLowerCase().includes(q)) { score += 0.5; hits.push(`路径含 ${q}`) }
    }
    if (score > 0) scored.push({ rel: f.rel, score, hits: hits.slice(0, 4), line: bestLine })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, limit).map(r => {
    // 附上下文：命中符号所在行 ±2
    let context = ''
    if (r.line) {
      try {
        /* ★1003 安全批 4.35：r.rel 来自磁盘索引（可被篡改）—— path.join(workDir,'../../x') 直接
         * 逃出工作区 = 被篡改的 .nis-repo-index.json 变成任意文件读（最多整文件）。resolve 后
         * 必须仍在工作区内才读，越界当读不到处理。 */
        const rootAbs = path.resolve(workDir)
        const abs = path.resolve(rootAbs, String(r.rel || ''))
        if (abs === rootAbs || !abs.startsWith(rootAbs + path.sep)) return { ...r, context: '' }
        const lines = fs.readFileSync(abs, 'utf8').split('\n')
        context = lines.slice(Math.max(0, r.line - 1), Math.max(0, r.line - 1) + 3).join('\n').slice(0, 200)
      } catch { /* 读不到就裸结果 */ }
    }
    return { ...r, context }
  })
}

/** 仓库地图：目录树概览（深度 2）+ 规模/语言分布 */
export function repoMap(workDir: string): string {
  const dirs: Array<{ rel: string; files: number; bytes: number }> = []
  const extCount: Record<string, number> = {}
  let totalFiles = 0
  let totalBytes = 0
  walkFiles(workDir, (abs, rel) => {
    const top = rel.split('/').slice(0, 2).join('/')
    let d = dirs.find(x => x.rel === top)
    if (!d) { d = { rel: top, files: 0, bytes: 0 }; dirs.push(d) }
    let size = 0
    try { size = fs.statSync(abs).size } catch { /* ignore */ }
    d.files++
    d.bytes += size
    totalFiles++
    totalBytes += size
    const ext = path.extname(rel).toLowerCase() || '(无)'
    extCount[ext] = (extCount[ext] || 0) + 1
    return true
  })
  dirs.sort((a, b) => b.bytes - a.bytes)
  const topLangs = Object.entries(extCount).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([e, n]) => `${e}×${n}`).join('、')
  const topDirs = dirs.slice(0, 25).map(d => `  ${d.rel}/（${d.files} 文件 ${(d.bytes / 1024).toFixed(0)}KB）`).join('\n')
  return `仓库地图（${totalFiles} 个代码文件 ${(totalBytes / 1024 / 1024).toFixed(1)}MB，深度 2 概览）：\n${topDirs}\n语言/类型分布：${topLangs}\n（找具体符号用 repo(action=search)；全文内容用 fs_grep）`
}
