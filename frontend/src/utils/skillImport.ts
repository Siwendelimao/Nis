import { unzipSync, strFromU8 } from 'fflate'

interface ParsedSkill {
  name: string
  description: string
}

/** 从 SKILL.md 开头 frontmatter 提取 name/description（兼容社区 SKILLS 生态） */
function parseFrontmatter(content: string): { name: string; description: string } {
  const m = content.match(/^---\s*\n([\s\S]*?)\n---/)
  const result = { name: '', description: '' }
  if (!m) return result
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^(\w+)\s*:\s*(.*)$/)
    if (!kv) continue
    const key = kv[1].toLowerCase()
    const val = kv[2].trim().replace(/^["']|["']$/g, '')
    if (key === 'name') result.name = val
    if (key === 'description') result.description = val
  }
  return result
}

/**
 * 解析 skill 包 zip：优先取根目录 SKILL.md（或任意层级第一个 SKILL.md），
 * 提取 frontmatter 的 name/description。找不到则用 zip 文件名兜底。
 * 返回 null 表示不是合法 skill 包。
 */
export function parseSkillZip(file: ArrayBuffer, fileName: string): ParsedSkill | null {
  let entries
  try {
    entries = unzipSync(new Uint8Array(file))
  } catch {
    return null
  }
  const names = Object.keys(entries)
  // 优先根目录 / 任意层级的 SKILL.md（大小写不敏感）
  const skillMd = names.find(n => n.toLowerCase().endsWith('skill.md')) || names.find(n => /skill\.md$/i.test(n))
  if (skillMd) {
    try {
      const text = strFromU8(entries[skillMd])
      const meta = parseFrontmatter(text)
      if (meta.name) return meta
    } catch {
      /* fallthrough */
    }
  }
  // 兜底：zip 文件名（去扩展名）作为技能名
  const base = fileName.replace(/\.(zip|skill)$/i, '').trim()
  return base ? { name: base, description: '从 zip 导入的 skill 包' } : null
}

/** 从 SKILL.md 文本解析技能；无法解析出 name 返回 null */
function parseSkillMd(text: string): ParsedSkill | null {
  const meta = parseFrontmatter(text)
  if (!meta.name) return null
  return meta
}

async function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(reader.error)
    reader.readAsText(file)
  })
}

/** 从目录 entry 中递归查找第一个 SKILL.md，并读取其内容 */
async function findSkillMdInDir(entry: any, depth = 0): Promise<string | null> {
  if (depth > 8) return null
  if (entry.isFile) {
    if (entry.name.toLowerCase().endsWith('skill.md')) {
      const file: File = await new Promise((resolve, reject) => entry.file(resolve, reject))
      return readFileAsText(file)
    }
    return null
  }
  if (entry.isDirectory) {
    const reader = entry.createReader()
    const entries: any[] = await new Promise((resolve, reject) => {
      reader.readEntries(resolve, reject)
    })
    // 先查当前目录，再递归子目录
    for (const e of entries) {
      if (e.isFile && e.name.toLowerCase().endsWith('skill.md')) {
        const file: File = await new Promise((res, rej) => e.file(res, rej))
        return readFileAsText(file)
      }
    }
    for (const e of entries) {
      if (e.isDirectory) {
        const found = await findSkillMdInDir(e, depth + 1)
        if (found) return found
      }
    }
  }
  return null
}

/**
 * 从拖入的条目解析技能（目录 或 zip 文件，自动识别）。
 * 目录：递归找 SKILL.md 读取 frontmatter；zip：解压找 SKILL.md。
 * 解析出 name 返回技能信息，否则返回 null。
 */
export async function parseDroppedSkill(item: any, fallbackName: string): Promise<ParsedSkill | null> {
  if (item.isDirectory) {
    const md = await findSkillMdInDir(item)
    if (!md) return null
    return parseSkillMd(md)
  }
  if (item.isFile) {
    const file: File = await new Promise((resolve, reject) => item.file(resolve, reject))
    const lower = file.name.toLowerCase()
    if (lower.endsWith('.zip')) {
      const buf = await file.arrayBuffer()
      return parseSkillZip(buf, file.name)
    }
    if (lower.endsWith('skill.md') || lower.endsWith('.md')) {
      const text = await readFileAsText(file)
      return parseSkillMd(text)
    }
  }
  // 兜底用文件名
  const base = fallbackName.replace(/\.(zip|skill|md)$/i, '').trim()
  return base ? { name: base, description: '从拖拽导入的 skill 包' } : null
}

// ── AI 导入通用：从 文件 / zip / 文件夹 提取文本内容 ──

const TEXT_EXTS = /\.(txt|md|markdown|py|js|ts|jsx|tsx|json|yml|yaml|html|css|scss|vue|java|go|rs|c|cpp|h|sh|bat|ini|conf|log|csv|xml|sql)$/i

/** 从文本文件读取内容（带大小上限） */
async function readTextWithLimit(file: File, limit: number): Promise<string> {
  try {
    const text = await readFileAsText(file)
    return text.slice(0, limit)
  } catch {
    return ''
  }
}

/** 从 zip 提取文本文件内容（拼接，跳过二进制/大文件） */
async function extractZipText(file: ArrayBuffer, limit = 8000): Promise<string> {
  try {
    const entries = unzipSync(new Uint8Array(file))
    const parts: string[] = []
    let total = 0
    for (const name of Object.keys(entries)) {
      if (!TEXT_EXTS.test(name)) continue
      const bytes = entries[name]
      if (bytes.length > 200_000) continue
      try {
        const text = strFromU8(bytes)
        parts.push(`=== ${name} ===\n${text}`)
        total += text.length
        if (total >= limit) break
      } catch {
        /* skip binary */
      }
    }
    return parts.join('\n\n').slice(0, limit)
  } catch {
    return ''
  }
}

/** 从目录 entry 递归收集文本文件内容 */
async function extractDirText(entry: any, depth = 0, limit = 8000): Promise<string> {
  if (depth > 6) return ''
  const parts: string[] = []
  let total = 0
  const walk = async (e: any, d: number, path: string): Promise<void> => {
    if (total >= limit) return
    if (e.isFile) {
      if (!TEXT_EXTS.test(e.name)) return
      const file: File = await new Promise((resolve, reject) => e.file(resolve, reject))
      if (file.size > 200_000) return
      const text = await readTextWithLimit(file, limit - total)
      if (text) {
        parts.push(`=== ${path}/${e.name} ===\n${text}`)
        total += text.length
      }
      return
    }
    if (e.isDirectory) {
      const reader = e.createReader()
      const children: any[] = await new Promise((resolve, reject) => reader.readEntries(resolve, reject))
      for (const child of children) {
        await walk(child, d + 1, `${path}/${e.name}`)
        if (total >= limit) return
      }
    }
  }
  await walk(entry, depth, '')
  return parts.join('\n\n').slice(0, limit)
}

/** AI 导入入口：文件/zip/文件夹 统一提取文本。返回提取出的内容（可能为空）。 */
export async function extractInputText(input: File | any): Promise<string> {
  if (input instanceof File) {
    const lower = input.name.toLowerCase()
    if (lower.endsWith('.zip')) {
      const buf = await input.arrayBuffer()
      return extractZipText(buf)
    }
    return readTextWithLimit(input, 8000)
  }
  if (input && typeof input.isDirectory === 'boolean') {
    if (input.isDirectory) return extractDirText(input)
    if (input.isFile) {
      const file: File = await new Promise((resolve, reject) => input.file(resolve, reject))
      return extractInputText(file)
    }
  }
  return ''
}
