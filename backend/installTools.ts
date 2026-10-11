/**
 * 安装助手工具集 —— 供「AI 导入安装助手」agent 使用。
 *
 * 能力：
 *   - 安装 skill / MCP（从本地目录 / git 仓库复制到白名单目录）
 *   - 卸载 skill / MCP
 *   - 安全扫描（skill 用 skill_security_auditor.py；MCP 用 mcp-scan）
 *   - 安装记录写入 install-log.jsonl（溯源）
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type as TbType } from 'typebox'
import { invalidateSkillCache, getSkills } from './skillTools.ts'
import { DATA_ROOT, SKILLS_ROOT } from './paths.ts'
import { gitExe } from './gitExe.ts' // ★0930b：git 绝对路径解析（后端 PATH 无 Git）

// ── 目录 / 路径约定（打包版经 NIS_DATA_DIR / NIS_SKILLS_DIR 重定向，见 paths.ts） ──
export const SKILLS_DIR = SKILLS_ROOT
export const MCP_DIR = path.join(DATA_ROOT, 'mcp-servers')
const INSTALL_LOG = path.join(DATA_ROOT, 'install-log.jsonl')
const TOOLS_DIR = path.join(DATA_ROOT, 'tools')
const SCANNER_SCRIPT = path.join(TOOLS_DIR, 'skill_security_auditor.py')
const SCANNER_REPO = 'https://github.com/alirezarezvani/claude-skills.git'

interface InstallRecord {
  name: string
  type: 'skill' | 'mcp'
  source: string
  version?: string
  audit: 'PASS' | 'WARN' | 'FAIL' | 'SKIP'
  installedAt: number
  uninstalledAt?: number
}

// ── 安装记录（溯源） ──
export function readInstallLog(): InstallRecord[] {
  try {
    if (!fs.existsSync(INSTALL_LOG)) return []
    const lines = fs.readFileSync(INSTALL_LOG, 'utf-8').split('\n').filter(Boolean)
    return lines.map(l => {
      try { return JSON.parse(l) } catch { return null }
    }).filter(Boolean)
  } catch {
    return []
  }
}

function appendInstallLog(rec: InstallRecord): void {
  try {
    fs.mkdirSync(path.dirname(INSTALL_LOG), { recursive: true })
    fs.appendFileSync(INSTALL_LOG, JSON.stringify(rec) + '\n', 'utf-8')
  } catch (e) {
    console.error('[install] log append failed:', e)
  }
}

export { appendInstallLog }

// ── 安全扫描器（按需拉取 skill_security_auditor.py） ──
async function ensureScanner(): Promise<string | null> {
  try {
    if (fs.existsSync(SCANNER_SCRIPT)) return SCANNER_SCRIPT
    fs.mkdirSync(TOOLS_DIR, { recursive: true })
    // 浅克隆到临时目录，拷贝脚本后清理（避免整个技能集仓库留在本地）
    const tmp = path.join(TOOLS_DIR, '.scanner-clone')
    await runProc(gitExe(), ['clone', '--depth', '1', SCANNER_REPO, tmp], 120000)
    // 仓库内实际路径：engineering/skills/skill-security-auditor/scripts/skill_security_auditor.py
    const scriptSrc = path.join(tmp, 'engineering', 'skills', 'skill-security-auditor', 'scripts', 'skill_security_auditor.py')
    if (fs.existsSync(scriptSrc)) {
      fs.copyFileSync(scriptSrc, SCANNER_SCRIPT)
    }
    fs.rmSync(tmp, { recursive: true, force: true })
    return fs.existsSync(SCANNER_SCRIPT) ? SCANNER_SCRIPT : null
  } catch (e) {
    console.error('[install] scanner fetch failed:', e)
    return null
  }
}

/** Python 解释器探测：Windows 常无 python3 命令（只有 python），自动回退并缓存 */
let pyCmdCache: string | null = null
async function resolvePython(): Promise<string> {
  if (pyCmdCache) return pyCmdCache
  for (const cmd of ['python3', 'python']) {
    try {
      await runProc(cmd, ['--version'], 8000)
      pyCmdCache = cmd
      return cmd
    } catch { /* try next */ }
  }
  pyCmdCache = 'python'
  return pyCmdCache
}

function runProc(cmd: string, args: string[], timeout = 60000): Promise<string> {
  return new Promise((resolve, reject) => {
    /* ★0930 修弹窗：python --version 探测 / skill_security_auditor.py 扫描（最长 90s）/ git clone
       都走这里，没 windowsHide 会在桌面弹出 cmd/python 控制台窗（后端无控制台=必弹）。 */
    execFile(cmd, args, { windowsHide: true, timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message))
      else resolve(stdout)
    })
  })
}

/** 从 git 仓库定位技能目录（含 SKILL.md）：指定 name 时递归精确查找（支持深层嵌套），否则按根/子目录识别 */
async function fetchSkillFromGit(repoUrl: string, skillName?: string, logger?: (category: string, message: string) => void): Promise<{ ok: boolean; dir: string; msg: string; repoRoot?: string; candidates?: string[] }> {
  const tmp = path.join(TOOLS_DIR, '.fetch-' + Date.now())
  const tClone = Date.now()
  try {
    fs.mkdirSync(tmp, { recursive: true })
    await runProc(gitExe(), ['clone', '--depth', '1', repoUrl, tmp], 120000)
    logger?.('install', `clone 完成（${((Date.now() - tClone) / 1000).toFixed(1)}s）`)
    console.log(`[install] clone done in ${((Date.now() - tClone) / 1000).toFixed(1)}s: ${repoUrl}`)
    const candidates: string[] = []
    // 收集仓库内全部 SKILL.md 目录（相对 tmp）：深度限 6、跳过 .git/符号链接/node_modules，防大仓库卡死
    const walkAll = (dir: string, out: string[], depth = 0) => {
      if (depth > 6) return
      let entries: fs.Dirent[] = []
      try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
      for (const e of entries) {
        if (!e.isDirectory() || e.name === '.git' || e.name === 'node_modules') continue
        if (typeof e.isSymbolicLink === 'function' && e.isSymbolicLink()) continue
        const sub = path.join(dir, e.name)
        if (fs.existsSync(path.join(sub, 'SKILL.md'))) out.push(sub)
        walkAll(sub, out, depth + 1)
      }
    }
    if (skillName) {
      // 指定技能：直接子目录 → 递归精确匹配目录名（如 engineering/skills/xxx），绝不回退到仓库根
      const direct = path.join(tmp, skillName)
      if (fs.existsSync(path.join(direct, 'SKILL.md'))) {
        candidates.push(direct)
      } else {
        const all: string[] = []
        walkAll(tmp, all)
        const hit = all.find(d => path.basename(d).toLowerCase() === skillName.toLowerCase())
        if (hit) candidates.push(hit)
      }
      if (candidates.length === 0) {
        // 明确报错并列出仓库内可用的技能，让 AI 纠正参数而不是装错东西
        const all: string[] = []
        walkAll(tmp, all)
        const names = all.map(d => path.basename(d))
        return { ok: false, dir: '', msg: `仓库内未找到技能「${skillName}」。可用技能：${names.slice(0, 15).join('、') || '（无）'}` }
      }
    } else {
      // 未指定：仓库根 / 顶层子目录 / 全部嵌套候选（交由上层询问用户）
      if (fs.existsSync(path.join(tmp, 'SKILL.md'))) {
        candidates.push(tmp)
      } else {
        const all: string[] = []
        walkAll(tmp, all)
        candidates.push(...all)
      }
    }
    if (candidates.length === 0) return { ok: false, dir: '', msg: '未找到 SKILL.md（该仓库可能不是 skill 技能包）' }
    return { ok: true, dir: candidates[0], msg: '', repoRoot: tmp, candidates }
  } catch (e: any) {
    return { ok: false, dir: '', msg: `拉取失败：${e?.message || e}` }
  }
}

/** 从 git URL 提取仓库名（作为技能包目录名） */
function extractRepoName(repoUrl: string): string {
  const clean = repoUrl.replace(/\.git\s*$/, '').replace(/\/+$/, '')
  const base = clean.split(/[\\/]/).pop() || 'skill-pack-' + Date.now()
  return base.replace(/[\\/:*?"<>|]/g, '-').slice(0, 60)
}

function copyDir(src: string, dest: string, skipGit = false): void {
  fs.mkdirSync(dest, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (skipGit && entry.name === '.git') continue
    const s = path.join(src, entry.name)
    const d = path.join(dest, entry.name)
    if (entry.isDirectory()) copyDir(s, d, skipGit)
    else fs.copyFileSync(s, d)
  }
}

// ── 工具工厂（context 绑定会话，供 ask_user 确认） ──
interface InstallCtx {
  sessionId: string
  askUser: (question: string, options?: string[]) => Promise<string>
  /** 会话权限模式：full_access 时免确认直接安装（用户显式开放完全权限） */
  getPermissionMode?: () => string
  /** 确认门禁：走权限卡通道（ApprovalPanel，显示/应答链路已验证可靠），resolve=block 与否 */
  confirmGate?: (question: string) => Promise<boolean>
  /** MCP 真实安装：写配置 + 连接（MCP 运行时）；repoUrl 非空时自动 clone 仓库+装依赖+设 cwd */
  mcpInstall?: (name: string, config: { command?: string; args?: string[]; env?: Record<string, string>; url?: string; cwd?: string; description?: string }, repoUrl?: string) => Promise<{ ok: boolean; error?: string; tools?: Array<{ name: string; description: string }> }>
  /** MCP 真实卸载：断开连接 + 删配置 */
  mcpUninstall?: (name: string) => Promise<{ ok: boolean; error?: string }>
  /** 会话执行日志（运行面板） */
  log?: (category: string, message: string, level?: 'info' | 'warn' | 'error') => void
}

/** 从 SKILL.md 提取技能名：frontmatter 的 name 优先，否则目录名（清理非法字符） */
function extractSkillName(dir: string, fallback: string): string {
  try {
    const md = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf-8')
    const m = md.match(/^---\s*\n([\s\S]*?)\n---/)
    if (m) {
      const fm = m[1]
      const nm = fm.match(/^\s*name\s*:\s*(.+)$/m)
      if (nm && nm[1].trim()) {
        const clean = nm[1].trim().replace(/["']/g, '').replace(/[\\/:*?"<>|]/g, '-').slice(0, 60)
        if (clean) return clean
      }
    }
  } catch { /* ignore */ }
  const base = path.basename(fallback || dir).replace(/^\.fetch-.*$/, '')
  return (base || 'skill-' + Date.now()).replace(/[\\/:*?"<>|]/g, '-').slice(0, 60)
}

/** 深度查重：在 skills 目录中找与目标技能同名的已有目录（按 SKILL.md 首部的 name/标题比对，目录名可能不同） */
function findExistingSkill(skillName: string): string | null {
  const target = skillName.toLowerCase().replace(/[-_\s]+/g, '')
  try {
    if (!fs.existsSync(SKILLS_DIR)) return null
    for (const d of fs.readdirSync(SKILLS_DIR, { withFileTypes: true })) {
      if (!d.isDirectory()) continue
      const sp = path.join(SKILLS_DIR, d.name, 'SKILL.md')
      if (!fs.existsSync(sp)) continue
      try {
        const head = fs.readFileSync(sp, 'utf-8').slice(0, 500).toLowerCase().replace(/[-_\s]+/g, '')
        // 目录名或 SKILL.md 头部（frontmatter name / 一级标题）包含目标名即判重复
        if (head.includes(target) || d.name.toLowerCase().replace(/[-_\s]+/g, '').includes(target)) return d.name
      } catch { /* continue */ }
    }
  } catch { /* ignore */ }
  return null
}

export function buildInstallTools(ctx: InstallCtx): AgentTool<any>[] {
  /** 完全权限模式：免确认（用户显式开放完全权限时，安装一路自动完成） */
  const isFullAccess = () => ctx.getPermissionMode?.() === 'full_access'
  /** 确认：优先走权限卡通道（显示可靠）；未提供时回退 ask_user 询问卡 */
  const confirm = async (question: string): Promise<boolean> => {
    if (isFullAccess()) {
      ctx.log?.('approval', `完全权限：免确认 ${String(question).split('\n')[0].slice(0, 60)}`)
      console.log(`[install] full_access skip confirm: ${String(question).slice(0, 60)}`)
      return true
    }
    if (ctx.confirmGate) {
      ctx.log?.('approval', `权限卡：${String(question).split('\n')[0].slice(0, 60)}`)
      console.log(`[install] confirm gate (permission card): ${String(question).slice(0, 60)}`)
      const r = await ctx.confirmGate(question)
      ctx.log?.('approval', r ? '已批准安装' : '已拒绝安装')
      console.log(`[install] confirm gate resolved: ${r ? 'approved' : 'denied'}`)
      return r
    }
    console.log(`[install] ask confirm (fallback ask_user): ${String(question).slice(0, 60)}`)
    const answer = await ctx.askUser(question, ['确认安装', '取消'])
    return answer.includes('确认')
  }

  return [
    {
      name: 'list_installed',
      label: '列出已安装',
      description: '列出当前已安装的全部技能（与技能仓库列表一致，含技能包子技能）和安装记录（来源/时间/安检）。安装前可先调用确认是否已存在同名技能。',
      parameters: TbType.Object({}),
      async execute() {
        // 用 getSkills（深扫）保证与前端技能仓库列表一致；含技能包子技能
        let skills: Array<{ name: string; path: string }> = []
        try {
          const all = await getSkills()
          skills = all.map(s => ({ name: s.name, path: s.filePath || '' }))
        } catch { /* ignore */ }
        const recs = readInstallLog().filter(r => !r.uninstalledAt)
        const lines = [
          `已安装技能（${skills.length} 个）：`,
          ...skills.map(s => `- ${s.name}`),
          `安装记录（${recs.length} 条）：`,
          ...recs.slice(-10).map(r => `- ${r.name}（${r.type}）来源 ${r.source} 安检 ${r.audit} ${new Date(r.installedAt).toLocaleString('zh-CN')}`),
        ]
        return { content: [{ type: 'text', text: lines.join('\n') }], details: { ok: true, skills, records: recs } }
      },
    },
    {
      name: 'install_skill',
      label: '安装技能',
      description: '把技能（SKILL.md 技能包）安装到 NIS 技能目录。source 可以是本地目录路径或 git 仓库 URL；name 可指定仓库内的子目录名。安装前会先汇报元数据并询问用户确认。工具内部自动处理含空格的路径——优先直接把 URL/路径传给本工具，不要自己跑 git clone 等命令安装。',
      parameters: TbType.Object({
        source: TbType.String({ description: '本地目录路径 或 git 仓库 URL' }),
        name: TbType.Optional(TbType.String({ description: 'git 仓库内的技能子目录名（可选）' })),
        sourceType: TbType.Optional(TbType.String({ description: '来源类型：local | git（不传则自动判断）' })),
      }),
      async execute(_callId, params: any) {
        const source = String(params.source || '').trim()
        if (!source) return { content: [{ type: 'text', text: '缺少 source 参数' }] }
        const isRemote = /^https?:\/\//.test(source)
        let dir = ''
        let displaySource = source
        let skillName = ''
        try {
          if (isRemote) {
            const r = await fetchSkillFromGit(source, params.name, (cat, msg) => ctx.log?.(cat, msg))
            if (!r.ok) return { content: [{ type: 'text', text: r.msg }] }
            // 多技能技能包（仓库含多个 SKILL.md 且未指定 name）：直接整体安装为技能包，不再询问
            // （询问卡曾导致挂起；用户明确要求"技能包直接整合着安装"。AI 想装单个时传 name 参数）
            if (!params.name && (r.candidates?.length || 0) > 1) {
              const names = (r.candidates || []).map(c => path.basename(c))
              const packName = extractRepoName(source)
              const dest = path.join(SKILLS_DIR, packName)
              if (fs.existsSync(dest)) {
                if (!isFullAccess()) {
                  return { content: [{ type: 'text', text: `技能包「${packName}」已存在，已保留现有版本、跳过安装。如需覆盖：删除现有后重装，或开启完全权限后重装。` }] }
                }
                fs.rmSync(dest, { recursive: true, force: true })
              }
              console.log(`[install] pack install (no ask): ${packName} (${names.length} skills)`)
              const okPack = await confirm(`确认整体安装技能包「${packName}」吗？\n包含 ${names.length} 个技能：${names.slice(0, 8).join('、')}${names.length > 8 ? ' 等' : ''}\n来源：${source}`)
              if (!okPack) return { content: [{ type: 'text', text: '用户取消了技能包安装' }] }
              copyDir(r.repoRoot || path.dirname(r.candidates![0]), dest, true)
              invalidateSkillCache()
              appendInstallLog({ name: packName, type: 'skill', source, audit: 'SKIP', installedAt: Date.now() })
              return { content: [{ type: 'text', text: `技能包「${packName}」（${names.length} 个技能：${names.slice(0, 8).join('、')}${names.length > 8 ? ' 等' : ''}）已整体安装到 ${dest}` }], details: { ok: true, name: packName, pack: names } }
            }
            dir = r.dir
            skillName = extractSkillName(dir, params.name || source)
            displaySource = source
          } else {
            const p = path.resolve(source)
            if (!fs.existsSync(path.join(p, 'SKILL.md'))) {
              return { content: [{ type: 'text', text: `目录 ${p} 未找到 SKILL.md` }] }
            }
            dir = p
            skillName = extractSkillName(p, p)
            displaySource = p
          }
          // 读元数据汇报给用户
          const skillMd = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf-8').slice(0, 400)
          const ok = await confirm(`确认安装技能「${skillName}」吗？\n来源：${displaySource}\n\n${skillMd}`)
          if (!ok) return { content: [{ type: 'text', text: `用户取消了安装「${skillName}」` }] }
          // 深度查重：目录名可能不同（如 ui-skills 仓库子目录），按 SKILL.md 的 name/标题比对
          // 重复处理不弹卡（避免卡住）：非完全权限默认保留现有并提示；完全权限自动覆盖
          const dupMatch = findExistingSkill(skillName)
          if (dupMatch) {
            if (!isFullAccess()) {
              return { content: [{ type: 'text', text: `技能「${skillName}」疑似已存在（目录「${dupMatch}」），已保留现有版本、跳过本次安装。如需覆盖：删除现有后重装，或开启完全权限后重装。` }] }
            }
            fs.rmSync(path.join(SKILLS_DIR, dupMatch), { recursive: true, force: true })
          }
          // 目录名精确查重（兼容直接同名目录）
          const dest = path.join(SKILLS_DIR, skillName)
          if (fs.existsSync(dest)) {
            if (!isFullAccess()) {
              return { content: [{ type: 'text', text: `技能「${skillName}」已存在同名目录，已保留现有版本、跳过本次安装。如需覆盖：删除现有后重装，或开启完全权限后重装。` }] }
            }
            fs.rmSync(dest, { recursive: true, force: true })
          }
          copyDir(dir, dest)
          invalidateSkillCache()
          appendInstallLog({ name: skillName, type: 'skill', source: displaySource, audit: 'SKIP', installedAt: Date.now() })
          return { content: [{ type: 'text', text: `技能「${skillName}」已安装到 ${dest}` }], details: { ok: true, name: skillName } }
        } catch (e: any) {
          return { content: [{ type: 'text', text: `安装失败：${e?.message || e}` }] }
        } finally {
          if (isRemote) fs.rmSync(dir, { recursive: true, force: true })
        }
      },
    },

    {
      name: 'uninstall_skill',
      label: '卸载技能',
      description: '从 NIS 技能目录卸载已安装的技能（只能卸载 AI 导入安装的，动不了系统内置）。',
      parameters: TbType.Object({
        name: TbType.String({ description: '要卸载的技能名（目录名）' }),
      }),
      async execute(_callId, params: any) {
        const name = String(params.name || '').trim()
        /* 0927 netfix sec-guard-0927：名称消毒 + resolve 界内判定 —— 原 path.join(SKILLS_DIR, name)
           接受 '..\\..\\x' 这类名字，确认后 rmSync(recursive) 可删技能目录之外的任意目录。 */
        if (!name || name === '.' || name === '..' || /[\\/\x00]/.test(name)) {
          return { content: [{ type: 'text', text: '技能名不合法（不能含路径分隔符）' }] }
        }
        const dest = path.resolve(SKILLS_DIR, name)
        const rootResolved = path.resolve(SKILLS_DIR)
        if (dest !== rootResolved && !dest.startsWith(rootResolved + path.sep)) {
          return { content: [{ type: 'text', text: '技能名不合法（越界）' }] }
        }
        if (!fs.existsSync(dest)) return { content: [{ type: 'text', text: `技能「${name}」不存在` }] }
        const recs = readInstallLog()
        const rec = recs.filter(r => r.type === 'skill' && r.name === name && !r.uninstalledAt).pop()
        const ok = await confirm(`确认卸载技能「${name}」吗？${rec ? `（来自 ${rec.source}）` : ''}`)
        if (!ok) return { content: [{ type: 'text', text: `用户取消卸载「${name}」` }] }
        fs.rmSync(dest, { recursive: true, force: true })
        invalidateSkillCache()
        if (rec) appendInstallLog({ ...rec, uninstalledAt: Date.now() })
        return { content: [{ type: 'text', text: `技能「${name}」已卸载` }], details: { ok: true, name } }
      },
    },

    {
      name: 'scan_skill',
      label: '安全扫描技能',
      description: '对已下载/待安装的技能目录运行安全扫描（静态分析，不执行代码），返回 PASS/WARN/FAIL 判定与风险清单。',
      parameters: TbType.Object({
        path: TbType.String({ description: '要扫描的技能目录路径' }),
        strict: TbType.Optional(TbType.Boolean({ description: '严格模式：任何 WARN 都算 FAIL' })),
      }),
      async execute(_callId, params: any) {
        const dir = String(params.path || '').trim()
        if (!fs.existsSync(dir)) return { content: [{ type: 'text', text: `目录不存在：${dir}` }] }
        const script = await ensureScanner()
        if (!script) return { content: [{ type: 'text', text: '安全扫描器未就绪（skill_security_auditor.py 下载失败），可跳过检查直接安装' }] }
        try {
          const args = [script, dir, '--json']
          if (params.strict) args.push('--strict')
          const out = await runProc(await resolvePython(), args, 90000)
          let parsed: any = {}
          try { parsed = JSON.parse(out) } catch { /* 回退文本 */ }
          const verdict = parsed.verdict || (out.includes('FAIL') ? 'FAIL' : out.includes('WARN') ? 'WARN' : 'PASS')
          return {
            content: [{ type: 'text', text: `安全扫描判定：${verdict}\n${out.slice(0, 1500)}` }],
            details: { ok: true, verdict, raw: out.slice(0, 2000) },
          }
        } catch (e: any) {
          return { content: [{ type: 'text', text: `扫描失败：${e?.message || e}` }] }
        }
      },
    },

    {
      name: 'install_mcp',
      label: '安装 MCP 服务',
      description: '安装一个 MCP 服务到 NIS（真实连接：clone 仓库+装依赖+启动，前缀 mcp__<服务名>__<工具名>）。工具表在会话（agent）建立时定型 ⇒ 新装的服务对**已开的会话**从下一条消息起可用（发消息时自动重建工具表），新会话立即可用。source 传 git 仓库 URL 时自动 clone 到本地并安装依赖，启动命令用相对路径即可（如 node src/index.js）。stdio 型传 command+args（如 npx -y @some/mcp-server，无需 clone）；远程型传 url。name 为短横线小写名。',
      parameters: TbType.Object({
        name: TbType.String({ description: 'MCP 服务名（小写短横线，如 kimi-webbridge-mcp）' }),
        source: TbType.String({ description: '来源（git 仓库 URL / 配置说明）；git URL 会自动 clone+装依赖' }),
        command: TbType.Optional(TbType.String({ description: 'stdio 型：启动命令（如 npx / node / uvx）' })),
        args: TbType.Optional(TbType.Array(TbType.String(), { description: 'stdio 型：启动参数列表（相对路径相对仓库根）' })),
        env: TbType.Optional(TbType.Record(TbType.String(), TbType.String(), { description: 'stdio 型：环境变量（如 API Key）' })),
        url: TbType.Optional(TbType.String({ description: '远程型：StreamableHTTP 端点 URL' })),
      }),
      async execute(_callId, params: any) {
        const name = String(params.name || '').trim()
        const source = String(params.source || '').trim()
        if (!name) return { content: [{ type: 'text', text: '缺少 name 参数' }] }
        const isGitUrl = /^https?:\/\/.*\.git($|[/?#])|^https?:\/\/github\.com\//i.test(source)
        const config: any = { description: source }
        if (params.url) config.url = String(params.url)
        else if (params.command) {
          config.command = String(params.command)
          if (Array.isArray(params.args)) config.args = params.args.map((a: any) => String(a))
          if (params.cwd) config.cwd = String(params.cwd)
          if (params.env && typeof params.env === 'object') {
            config.env = Object.fromEntries(Object.entries(params.env).map(([k, v]) => [k, String(v)]))
          }
        } else if (isGitUrl) {
          // 只有 git URL：常见默认启动（README 常见形态），连接失败会给出明确错误
          return { content: [{ type: 'text', text: '缺少启动配置：请从该 MCP 仓库 README 提取启动方式，传 command+args（仓库会自动 clone，相对路径可用）；或远程型传 url。' }] }
        } else {
          return { content: [{ type: 'text', text: '缺少启动配置：stdio 型需要 command（+args/env），远程型需要 url。请从该 MCP 仓库的 README 提取。' }] }
        }
        const repoUrl = isGitUrl ? source : undefined
        const ok = await confirm(`确认安装并连接 MCP 服务「${name}」吗？\n来源：${source}\n启动：${config.url || `${config.command} ${(config.args || []).join(' ')}`}${repoUrl ? '\n（将自动 clone 仓库并安装依赖）' : ''}`)
        if (!ok) return { content: [{ type: 'text', text: '用户取消安装 MCP' }] }
        if (!ctx.mcpInstall) return { content: [{ type: 'text', text: 'MCP 运行时未就绪（服务端未接入）' }] }
        const r = await ctx.mcpInstall(name, config, repoUrl)
        if (!r.ok) return { content: [{ type: 'text', text: `MCP「${name}」安装失败：${r.error}` }] }
        appendInstallLog({ name, type: 'mcp', source, audit: 'SKIP', installedAt: Date.now() })
        const toolList = (r.tools || []).map(t => `- ${t.name}: ${t.description}`).join('\n')
        return {
          content: [{ type: 'text', text: `MCP「${name}」已安装并连接成功（${r.tools?.length || 0} 个工具；已开的会话**发下一条消息即自动生效**，新会话立即可用）：\n${toolList || '（该服务未提供工具）'}` }],
          details: { ok: true, name, tools: r.tools },
        }
      },
    },

    {
      name: 'uninstall_mcp',
      label: '卸载 MCP 服务',
      description: '卸载指定 MCP 服务（断开连接并删除配置）。',
      parameters: TbType.Object({
        name: TbType.String({ description: 'MCP 服务名' }),
      }),
      async execute(_callId, params: any) {
        const name = String(params.name || '').trim()
        if (!name) return { content: [{ type: 'text', text: '缺少 name 参数' }] }
        const ok = await confirm(`确认卸载 MCP「${name}」吗？（断开连接并删除配置）`)
        if (!ok) return { content: [{ type: 'text', text: '用户取消' }] }
        // 真实卸载：断开连接 + 删配置目录（运行时已接入）
        if (ctx.mcpUninstall) {
          const r = await ctx.mcpUninstall(name)
          if (!r.ok) return { content: [{ type: 'text', text: `卸载失败：${r.error}` }] }
        }
        const recs = readInstallLog()
        const rec = recs.filter(r => r.type === 'mcp' && r.name === name && !r.uninstalledAt).pop()
        if (rec) appendInstallLog({ ...rec, uninstalledAt: Date.now() })
        return { content: [{ type: 'text', text: `MCP「${name}」已卸载（连接已断开、配置已删除）` }], details: { ok: true, name } }
      },
    },
  ]
}
