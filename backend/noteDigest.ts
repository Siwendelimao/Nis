/* noteDigest.ts —— 项目档案「摘要层 + 分节读取」（1010 新增，通用件）
 *
 * 为什么：项目档案 NIS-notes.md 会随项目长成大文件（NIS 自己那份已是 2305 行 / 303,829 字符）。
 *   新窗口"了解项目"若靠 AI 自己 fs_read 逐段啃，要 ~13 次往返（单次上限 24000 字符）≈ 十几万 token，
 *   而且每次新窗口、每个项目都要重来。痛点与项目无关 ⇒ 这里做成**通用件**：
 *   任何工作区只要有 NIS-notes.md，就自动得到一张 ≤900 字符的"档案卡"（注入系统提示），
 *   细节用 project_note(action=read, section=…) 按节取 —— 模型不必再整份读。
 *
 * 口径：token 估算与 server.ts 上下文估算同源（CJK ≈ 字符/1.5，其余 ≈ /4）。
 * 依赖：只依赖 node:fs / node:path，无第三方依赖；纯函数可单测。
 */
import fs from 'node:fs'
import path from 'node:path'

export const PROJECT_NOTE_FILE = 'NIS-notes.md'
/* 节序 = 写文件时的顺序。★1010b：新增「任务日志」（追加型）：
   收尾记流水走它（一条几十字，零重写成本）；「当前进度」只当"最新状态总览"用
   —— 它是**整节替换**，很贵：本工作区档案里这节已达 13k 字符，每次「完成任务后更新档案」都要把它整段重发一遍。 */
export const NOTE_SECTIONS = ['项目约定', '当前进度', '任务日志', '决策记录', '产物清单'] as const

/** token 粗估（CJK 按 1.5 字符/token，其余按 4 字符/token）——与 server.ts:13607 口径同源 */
export function estimateTokens(s: string): number {
  const str = String(s || '')
  let cjk = 0
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i)
    // CJK 统一表意文字/兼容区/扩展A + 中文标点与全角符号
    if ((c >= 0x2e80 && c <= 0x9fff) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xffef)) cjk++
  }
  const rest = str.length - cjk
  return Math.round(cjk / 1.5 + rest / 4)
}

interface NoteSectionStat {
  name: string
  startLine: number  // '## 节名' 那一行的行号（1 基）
  endLine: number    // 该节正文最后一行（1 基，含）
  lines: number
  chars: number
  entries: number    // 决策记录/产物清单=条目数（'- ' 行）；其余=非空行数
}

interface NoteDigest {
  exists: boolean
  file: string
  chars: number
  lines: number
  tokens: number
  sections: NoteSectionStat[]
  progressHeads: string[]
  bullets: string[]
  logEntries: string[]
  recentEntries: string[]
  text: string
}

/** 按【已知节名】切分（与 tools.ts 的 upsertProjectNote 同一口径：只有已知节名的 '## ' 才算分节，
 *  正文里用户自己写的 '## 别的标题' 一律留在节内，不丢内容）。 */
export function splitNoteSections(raw: string): { head: string[]; stats: NoteSectionStat[]; bodies: Record<string, string[]> } {
  const lines = String(raw || '').split('\n')
  const KNOWN = new Set<string>(NOTE_SECTIONS)
  const bodies: Record<string, string[]> = {}
  const stats: NoteSectionStat[] = []
  const byName = new Map<string, NoteSectionStat>()
  const head: string[] = []
  let cur: string | null = null
  let startLine = 0
  const close = (endLine: number): void => {
    if (!cur) return
    const body = bodies[cur] || []
    while (body.length && !body[body.length - 1].trim()) body.pop()
    const chars = body.reduce((n, l) => n + l.length + 1, 0)
    const isLog = cur === '任务日志' || cur === '决策记录' || cur === '产物清单'
    const entries = isLog ? body.filter(l => /^-\s/.test(l.trim())).length : body.filter(l => l.trim()).length
    const prev = byName.get(cur)
    if (prev) {
      /* ★1010d（边界探查抓到的真 bug）：档案里**同名节出现两次**时（手工 append 一段 '## 当前进度'
         就会这样），旧实现每次 close 都 push 一条同名 stat，而 readNoteSection 用 find 取第一条
         ⇒ **行号指向第一段、内容却是第二段**（错位），且第一段内容**读不到**（丢档）。
         现在同名节合并成一条：起点取首段，末端取最后一次，内容按出现顺序累加（与 upsertProjectNote 的写入口径一致）。 */
      prev.endLine = endLine
      prev.lines = Math.max(0, endLine - prev.startLine)
      prev.chars = chars
      prev.entries = entries
      return
    }
    const st: NoteSectionStat = { name: cur, startLine, endLine, lines: Math.max(0, endLine - startLine), chars, entries }
    byName.set(cur, st)
    stats.push(st)
  }
  lines.forEach((line, i) => {
    const m = /^##\s+(.+?)\s*$/.exec(line)
    if (m && KNOWN.has(m[1])) {
      close(i)                    // 上一节正文止于本行之前（1 基行号 = i）
      const name = m[1]
      if (!bodies[name]) { bodies[name] = []; startLine = i + 1 }   // 只在**首次出现**时记起点
      cur = name
      return
    }
    if (cur) bodies[cur].push(line)
    else head.push(line)
  })
  close(lines.length)
  return { head, stats, bodies }
}

/** 当前进度节里的任务标题（二级/三级标题）——**取前 n 条**：该节是"保持最新状态"的整节替换，
 *  写的人按惯例把最新写在最上面（实测本工作区那份档案就是新→旧），所以**靠前才是最近的**。
 *  （初版写成 slice(-n) 取末尾=最旧的，被 E2E 抓出来后修正。） */
function pickProgressHeads(body: string[] | undefined, n = 5): string[] {
  const out: string[] = []
  for (const line of body || []) {
    const m = /^#{2,4}\s+(.+?)\s*$/.exec(line)
    if (m && m[1]) out.push(m[1])
  }
  return out.slice(0, n).map(s => s.length > 46 ? s.slice(0, 46) + '…' : s)
}

/** 项目约定节里的条目（'- ' 开头）前 n 条 —— 实测本档案的约定节就是"Node 不在 PATH / git 特殊路径 /
 *  改后端必须手动重启 / 弹窗纪律"这类**最容易踩的硬坑**，值得常驻卡片（精度>省字）。
 *  约定节是整节替换型，顺序由写的人定；取前面 n 条（惯例最新/最要紧的在上）。 */
function pickBullets(body: string[] | undefined, n = 3, maxLen = 64): string[] {
  const out: string[] = []
  for (const line of body || []) {
    const m = /^\s*[-*·]\s+(.+?)\s*$/.exec(line)
    if (!m || !m[1] || m[1] === '（暂无）') continue
    const t = m[1].replace(/\*\*/g, '').replace(/`/g, '').replace(/\s+/g, ' ').trim()
    if (t) out.push(t.length > maxLen ? t.slice(0, maxLen) + '…' : t)
    if (out.length >= n) break
  }
  return out
}

/** 追加型节（任务日志/决策记录/产物清单）的最近 n 条：这些节的新内容追加在**末尾** ⇒ slice(-n)。
 *  去掉时间戳前缀，压到 maxLen 字。 */
function pickRecentEntries(body: string[] | undefined, n = 2, maxLen = 88): string[] {
  const rows = (body || []).filter(l => /^-\s/.test(l.trim()))
  return rows.slice(-n).map(s => {
    const t = s.trim().replace(/^-\s*\[[^\]]*\]\s*/, '').replace(/\s+/g, ' ')
    return t.length > maxLen ? t.slice(0, maxLen) + '…' : t
  })
}

const LOG_SECTIONS = new Set(['任务日志', '决策记录', '产物清单'])
const FIG = (n: number): string => n >= 10000 ? `${(n / 10000).toFixed(1)}万` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)

/** 组装注入用的"档案卡"文本（严格 ≤ maxChars：按优先级逐段追加，装不下就停）
 *  优先级：抬头体量 > 各节行范围 > 关键约定 > 最近任务 > 当前进度总览 > 最近决策/产物
 *  maxChars 默认 1100（≈500 token）：常驻 system，但档案不变时命中前缀缓存；比"读一节"（1.3k token）仍便宜 */
function renderNoteDigest(args: {
  file: string; chars: number; lines: number; sections: NoteSectionStat[]
  progressHeads: string[]; bullets: string[]; logEntries: string[]; recentEntries: string[]
}, maxChars = 1100): string {
  const parts: string[] = []
  parts.push(`【项目档案】${args.file}：${args.lines} 行 / ${args.chars} 字符（≈${estimateTokensSize(args.chars)} token）——`
    + '**别整份读**：要细节用 project_note(action="read", section="当前进度") 按节取（或 action="read" 只看目录）。')
  const sec = args.sections.filter(s => s.startLine)
  if (sec.length) parts.push('· 各节行范围：' + sec.map(s => `${s.name} ${s.startLine}-${s.endLine} 行(${FIG(s.chars)}字${LOG_SECTIONS.has(s.name) ? `,${s.entries}条` : ''})`).join(' ｜ '))
  if (args.bullets.length) parts.push('· 关键约定：' + args.bullets.join(' ｜ '))
  if (args.logEntries.length) parts.push('· 最近任务（新→旧）：' + args.logEntries.slice().reverse().join(' ｜ '))
  if (args.progressHeads.length) parts.push('· 当前进度总览（新→旧）：' + args.progressHeads.join(' ｜ '))
  if (args.recentEntries.length) parts.push('· 最近决策/产物：' + args.recentEntries.join(' ｜ '))
  let out = ''
  for (const p of parts) {
    if (out && out.length + p.length + 1 > maxChars) {
      // 装不下：先塞进截断版；连截断版都塞不下就停
      const room = maxChars - out.length - 1
      if (room > 60) out += '\n' + p.slice(0, room - 1) + '…'
      break
    }
    out += (out ? '\n' : '') + p
    if (out.length > maxChars) { out = out.slice(0, maxChars - 1) + '…'; break }
  }
  return out
}

/** 由字符数估算 token（用于档案卡抬头显示体量） */
function estimateTokensSize(chars: number): string {
  const t = Math.round(chars / 2.2)   // 档案是中文为主的混合文本，取 /2.2（与上下文估算同源）
  return `${FIG(t)}`
}

const cache = new Map<string, { key: string; digest: NoteDigest }>()

/** 生成档案卡（带 mtime+size 缓存：buildDynamicSystem 每轮调用也不读盘解析） */
export function buildNoteDigest(workDir: string, maxChars = 1100): NoteDigest {
  const abs = path.join(workDir, PROJECT_NOTE_FILE)
  const absent: NoteDigest = { exists: false, file: PROJECT_NOTE_FILE, chars: 0, lines: 0, tokens: 0, sections: [], progressHeads: [], bullets: [], logEntries: [], recentEntries: [], text: '' }
  let raw = ''
  let key = 'absent'
  try {
    const st = fs.statSync(abs)
    key = `${st.mtimeMs}:${st.size}:${maxChars}`
    const hit = cache.get(abs)
    if (hit && hit.key === key) return hit.digest
    raw = fs.readFileSync(abs, 'utf8')
  } catch {
    return absent
  }
  const { stats, bodies } = splitNoteSections(raw)
  const chars = raw.length
  const lines = raw.split('\n').length
  const progressHeads = pickProgressHeads(bodies['当前进度'], 5)
  const bullets = pickBullets(bodies['项目约定'], 3, 64)
  const logEntries = pickRecentEntries(bodies['任务日志'], 3, 72)
  const recentEntries = [...pickRecentEntries(bodies['决策记录'], 1, 88), ...pickRecentEntries(bodies['产物清单'], 1, 88)].filter(Boolean)
  const digest: NoteDigest = {
    exists: true, file: PROJECT_NOTE_FILE, chars, lines,
    tokens: estimateTokens(raw), sections: stats, progressHeads, bullets, logEntries, recentEntries,
    text: '',
  }
  digest.text = renderNoteDigest(digest, maxChars)
  cache.set(abs, { key, digest })
  return digest
}

/** 读某一节（按行范围切片；超 maxChars 就截断并告知总长度） */
export function readNoteSection(workDir: string, section: string, maxChars = 12000): { text: string; startLine: number; endLine: number; chars: number; truncated: boolean } | null {
  const abs = path.join(workDir, PROJECT_NOTE_FILE)
  let raw = ''
  try { raw = fs.readFileSync(abs, 'utf8') } catch { return null }
  const { bodies, stats } = splitNoteSections(raw)
  if (!(NOTE_SECTIONS as readonly string[]).includes(section)) return null
  const body = (bodies[section] || []).join('\n').trim()
  const stat = stats.find(s => s.name === section)
  const truncated = body.length > maxChars
  return {
    text: truncated ? body.slice(0, maxChars) + `\n…（本节共 ${body.length} 字符，已截断；需要更靠后的内容请用 fs_read 读第 ${(stat?.startLine || 1)}-${stat?.endLine || 1} 行里靠后的行段）` : body,
    startLine: stat?.startLine || 0,
    endLine: stat?.endLine || 0,
    chars: body.length,
    truncated,
  }
}
