/**
 * Skill 系统：自研扫描 SKILL.md（★1011 起，不再依赖上游），
 * 注册 use_skill 工具让模型按需读取技能全文指令（产生标准工具过程块）。
 *
 * ★1011 pi 1.1.0 升级：上游在 1.0 把 harness（含 skills）整个搬出 pi-agent-core，
 *  `loadSkills` / `Skill` 类型都没了，`@earendil-works/pi-agent-core/node`（NodeExecutionEnv 所在子路径）
 *  的 exports 也被收掉 ⇒ 原实现三行 import 全部失效、后端**启动即崩**（ESM 静态解析失败）。
 *  这里改为自研扫描（约 80 行），外部行为与上游 loadSkills 对齐：
 *   · 递归遍历目录；**某目录里有 SKILL.md 就收下它并停止深入该目录**（与上游 loadSkillFromDir 同款短路）；
 *   · 根目录下直接放的 .md 也当作技能（对应上游 includeRootFiles=true）；
 *   · 跳过 `.` 开头与 node_modules；
 *   · name/description 从文件头 YAML frontmatter 取（支持 `>`/`|` 块标量、引号、多行）；
 *   · content = frontmatter 之后的正文，filePath = 绝对路径。
 *  有意不做的：上游的 ignore 文件（.gitignore 类）规则、`disableModelInvocation` 字段 —— 我们没用到。
 */
import fs from 'node:fs'
import path from 'node:path'


import { SKILLS_ROOT } from './paths.ts'

/** 技能（字段与上游 0.84.2 的 Skill 对齐，去掉我们没用到的 disableModelInvocation） */
export interface Skill {
  /** 技能名（模型可见清单里的标识） */
  name: string
  /** 一句话描述（清单里截断到 40 字） */
  description: string
  /** 技能全文（use_skill 时给模型） */
  content: string
  /** 绝对路径 */
  filePath: string
}

/* ★ 0923 修复（安装版实测复现）：原实现按本文件位置拼 skills 目录（=backend/skills），
   但打包版技能已迁到 NIS_SKILLS_DIR（paths.ts 统一重定向，installTools 同源），
   安装版里 backend/skills 不存在 → getSkills() 早退且不落缓存 → skillsSnapshotSync()
   永远返回 null → server.ts getOrCreateAgent 里 null.filter() 抛
   "Cannot read properties of null (reading 'filter')" → 发消息必炸 + 技能功能静默全瘫。
   改用 paths.ts 的 SKILLS_ROOT，dev/安装版行为一致。 */
const SKILLS_DIR = SKILLS_ROOT

const SKILL_FILE = 'SKILL.md'
const MAX_SCAN_DEPTH = 6

/** 解析一个技能文件：文件头 YAML frontmatter 的 name/description + 正文 */
function parseSkillFile(filePath: string): Skill | null {
  let raw = ''
  try { raw = fs.readFileSync(filePath, 'utf8') } catch { return null }
  raw = raw.replace(/^\uFEFF/, '')
  let name = ''
  let description = ''
  let body = raw

  const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/)
  if (fm) {
    body = raw.slice(fm[0].length)
    const lines = fm[1].split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      const kv = lines[i].match(/^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/)
      if (!kv) continue
      const key = kv[1]
      if (key !== 'name' && key !== 'description') continue
      let val = (kv[2] || '').trim()
      if (/^[>|][+-]?$/.test(val)) {
        // 块标量：把后续缩进行收进来（`>` 折叠成一行，`|` 保留换行）
        const block: string[] = []
        let j = i + 1
        for (; j < lines.length; j++) {
          const l = lines[j]
          if (l.trim() === '') { block.push(''); continue }
          if (!/^\s/.test(l)) break
          block.push(l.replace(/^\s+/, ''))
        }
        i = j - 1
        while (block.length && block[block.length - 1] === '') block.pop()
        const text = block.join('\n')
        val = val.startsWith('>') ? text.replace(/\n(?!\n)/g, ' ') : text
      } else {
        if (/^['"]/.test(val)) val = val.replace(/^['"]/, '').replace(/['"]$/, '')
        if (val.startsWith('#')) val = ''
      }
      if (key === 'name' && !name) name = val.trim()
      if (key === 'description' && !description) description = val.trim()
    }
  }

  const fallback = path.basename(path.dirname(filePath))
  const finalName = (name || fallback).trim()
  if (!finalName) return null
  return { name: finalName, description: (description || '').trim(), content: body, filePath }
}

/** 扫描技能目录（行为对齐上游 loadSkills） */
function scanSkills(dir: string): { skills: Skill[]; warnings: string[] } {
  const skills: Skill[] = []
  const warnings: string[] = []
  const walk = (d: string, depth: number, isRoot: boolean) => {
    let ents: fs.Dirent[] = []
    try { ents = fs.readdirSync(d, { withFileTypes: true }) } catch (e: any) {
      warnings.push(`readdir failed: ${d} (${e?.message || e})`)
      return
    }
    ents.sort((a, b) => a.name.localeCompare(b.name))
    /* 上游同款短路：本目录有 SKILL.md 就只收它，不再往下递归 */
    const own = ents.find(e => e.isFile() && e.name === SKILL_FILE)
    if (own) {
      const s = parseSkillFile(path.join(d, own.name))
      if (s) skills.push(s)
      else warnings.push(`skill parse failed: ${path.join(d, own.name)}`)
      return
    }
    for (const e of ents) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue
      const fp = path.join(d, e.name)
      if (e.isDirectory()) {
        if (depth < MAX_SCAN_DEPTH) walk(fp, depth + 1, false)
        continue
      }
      if (isRoot && e.name.endsWith('.md')) {
        const s = parseSkillFile(fp)
        if (s) skills.push(s)
      }
    }
  }
  walk(dir, 0, true)
  return { skills, warnings }
}

let cache: { skills: Skill[]; loadedAt: number } = { skills: [], loadedAt: 0 }
/* ★1003 并发批 4.45：原 getSkills() 是裸的 check-then-load —— 并发调用（预热 void getSkills()
 * 撞上首个请求）同时开加载，完成顺序不定互相覆盖（可能复活旧数据）；更毒的是 invalidateSkillCache()
 * 置零后，已在途的旧加载完成时会用新时间戳把失效**悄悄顶掉**。
 * 现在：① in-flight 共享同一个 Promise（同刻只跑一次加载）；② 代数计数 —— 只有发起时的代数
 * 仍是当前代数才允许提交结果，失效后旧加载的产物一律不进缓存。 */
let inFlight: Promise<Skill[]> | null = null
let loadGen = 0

/** 加载 skills 目录（60s 缓存；目录不存在返回空）。
 *  ★ 0923 修复：目录不存在/加载失败也【落缓存】（loadedAt）——旧实现早退不建缓存，
 *  skillsSnapshotSync() 永远返 null，调用方直接 null.filter() 崩（见 SKILLS_DIR 注释）。
 *  目录不存在时打 warn 日志，用户/排障可见（不再静默）。 */
export async function getSkills(): Promise<Skill[]> {
  const now = Date.now()
  if (now - cache.loadedAt < 60_000) return cache.skills
  if (inFlight) return inFlight   // ★4.45：并发同刻只跑一次加载
  const gen = ++loadGen
  inFlight = (async () => {
    try {
      if (!fs.existsSync(SKILLS_DIR)) {
        console.warn(`[skills] directory not found: ${SKILLS_DIR}（技能清单将为空）`)
        if (gen === loadGen) cache = { skills: [], loadedAt: Date.now() }
        return []
      }
      try {
        /* ★1011：原 `new NodeExecutionEnv(...) + loadSkills(env, SKILLS_DIR)` 在这里，
           上游 1.1.0 已删 ⇒ 换成自研扫描（scanSkills） */
        const { skills, warnings } = scanSkills(SKILLS_DIR)
        for (const w of warnings) console.warn(`[skills] ${w}`)
        console.log(`[skills] loaded ${skills.length} from ${SKILLS_DIR}`)
        // ★ 0923：同名技能去重——嵌套技能包（ui-skills/skills/*）会被递归加载多次，
        // dev/安装版均复现同名 ×5；不去重则系统提示清单一坨重复，还扰动 name 排序稳定性。
        const seen = new Set<string>()
        const deduped = skills.filter(s => {
          const k = String(s.name)
          if (seen.has(k)) return false
          seen.add(k)
          return true
        })
        if (gen === loadGen) cache = { skills: deduped, loadedAt: Date.now() }   // ★4.45：失效后的旧加载不许提交
        return deduped
      } catch (e) {
        console.error('[skills] load failed:', e)
        // ★ 0923：加载失败同样落空缓存，杜绝冷缓存 null 冒泡到调用方
        if (gen === loadGen) cache = { skills: [], loadedAt: Date.now() }
        return []
      }
    } finally { inFlight = null }
  })()
  return inFlight
}

export function invalidateSkillCache(): void {
  loadGen++            // ★4.45：代数+1 ⇒ 在途旧加载的产物一律不许再进缓存
  cache.loadedAt = 0
}

/** 0910 缓存优化：同步取当前缓存的技能清单（未预热返回 null）。
 *  agent 创建路径用它把技能清单【同步】拼进 systemPrompt——旧实现异步 .then 改写，
 *  导致 agent 重建后第 1、2 个请求的 system 前缀不一致（第 2 请求缓存断一次）。
 *  服务启动已 void getSkills() 预热 + 60s 缓存，绝大多数 agent 创建时缓存已热。 */
export function skillsSnapshotSync(): Skill[] | null {
  return cache.loadedAt > 0 ? cache.skills : null
}

/** ★1011（pi 1.1.0）：**同步**取技能，冷缓存时就地扫一次并填缓存。
 *  为什么要它：1.1.0 里 `agent.state.systemPrompt` 变成只读，旧实现"建完 agent 再异步补写技能清单"
 *  的兜底彻底作废（写不进去）。改为在建 agent 前同步拿到清单 ⇒ system 前缀一次成型。
 *  自研扫描本身就是同步的（scanSkills），目录很小，代价通常 <50ms；且服务启动已预热，
 *  只有启动头几十毫秒会真的走扫描。 */
export function getSkillsSync(): Skill[] {
  if (cache.loadedAt > 0) return cache.skills
  if (!fs.existsSync(SKILLS_DIR)) {
    console.warn(`[skills] directory not found: ${SKILLS_DIR}（技能清单将为空）`)
    cache = { skills: [], loadedAt: Date.now() }
    return []
  }
  try {
    const { skills, warnings } = scanSkills(SKILLS_DIR)
    for (const w of warnings) console.warn(`[skills] ${w}`)
    const seen = new Set<string>()
    const deduped = skills.filter(s => {
      const k = String(s.name)
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })
    console.log(`[skills] loaded ${skills.length} (${deduped.length} unique) from ${SKILLS_DIR}`)
    loadGen++   // 与异步路径共用代数：让在途的旧加载不许再提交
    cache = { skills: deduped, loadedAt: Date.now() }
    return deduped
  } catch (e) {
    console.error('[skills] sync load failed:', e)
    cache = { skills: [], loadedAt: Date.now() }
    return []
  }
}

/** 生成给模型的可用技能清单（注入 system prompt 尾部）。
 *  0910 缓存优化：按 name 排序保证字节稳定——目录扫描顺序不保证，
 *  顺序抖动 = system 前缀变 = prompt cache 全断（Claude/OpenAI 文档同口径：断点前任何变化都失效）。 */
/* ★ 0921w（反馈：系统提示里的技能清单太长）：每个技能**只占一行**，描述统一截断到 40 字。
   之前把整段描述（100~200 字）塞进 system prompt，7 个技能就是一大坨、每轮请求都要带；
   技能清单的作用只是"让模型知道有哪些技能可选"，细节等 use_skill 调用后再给全文。
   注意：排序保持按 name（见上方注释）—— 顺序抖动会断 prompt 缓存前缀。 */
const SKILL_DESC_MAX = 40
function formatSkillLines(skills: Skill[]): string {
  return [...skills]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((s) => {
      const d = String(s.description || '').replace(/\s+/g, ' ').trim()
      const short = d.length > SKILL_DESC_MAX ? d.slice(0, SKILL_DESC_MAX) + '…' : d
      return short ? '- ' + s.name + '：' + short : '- ' + s.name
    })
    .join('\n')
}

export function formatSkillList(skills: Skill[]): string {
  if (skills.length === 0) return ''
  const lines = formatSkillLines(skills)   // ★ 0921w：每技能一行、描述截 40 字（原：整段描述，太长）
  return [
    '',
    '## 可用技能（Skills）',
    '你可以通过调用 use_skill 工具加载以下技能的完整指令。当用户的任务匹配某个技能、或用户明确要求使用某技能时，先调用 use_skill 获取指令再按其执行。',
    lines,
  ].join('\n')
}
