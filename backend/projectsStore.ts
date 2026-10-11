/**
 * 项目存储（0911 反馈：PROJECT_CREATE 后端未接 → 落地）
 *
 * 此前"项目"纯前端 localStorage——换设备/清缓存即丢。本模块把项目实体落盘到后端：
 *   backend/data/projects.json（原子写；项目数量少，单文件足够）
 *
 * 结构：{ version: 1, projects: Project[] }
 *   Project = { id, name, root_path, description?, status, created_at, updatedAt, members[], pinned? }
 *
 * 与前端 stores/projects.ts 的 Project 接口对齐（members 为伙伴名单，后端透传存储，不解析内部结构）。
 * 安全：project.delete 只删记录——**绝不动用户的文件夹**（root_path 是用户本地资产）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { DATA_ROOT } from './paths.ts'
import { isAbsolutePath, normalizeRootPath, resolveRelativeRoot } from './projectPaths.ts'

const PROJECTS_FILE = path.join(DATA_ROOT, 'projects.json')

/* ★ 0921z：存储根来源（settings.storagePath）由 server 注入（同 memberRunLimit / inspector 等 provider 惯例）：
 *  相对 root_path 兜底解析时，优先在"存储根/相对名"下找真实目录。 */
let storageRootProvider: () => string = () => ''
export function setProjectStorageRootProvider(fn: () => string): void {
  storageRootProvider = typeof fn === 'function' ? fn : () => ''
}

interface ProjectRecord {
  id: string
  name: string
  root_path: string
  description?: string
  status: 'active' | 'archived'
  created_at: number
  updatedAt: number
  members: any[]
  pinned?: boolean
}

interface StoreShape { version: number; projects: ProjectRecord[] }

let cache: StoreShape | null = null

function load(): StoreShape {
  if (cache) return cache
  try {
    if (fs.existsSync(PROJECTS_FILE)) {
      const raw = JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf-8'))
      if (raw && Array.isArray(raw.projects)) {
        cache = { version: 1, projects: raw.projects }
        return cache
      }
    }
  } catch (e) {
    console.error('[projects] load failed:', e)
  }
  cache = { version: 1, projects: [] }
  return cache
}

function persist(): void {
  try {
    const store = load()
    fs.mkdirSync(path.dirname(PROJECTS_FILE), { recursive: true })
    // 原子写（同 sessions/providers 惯例：先写临时文件再 rename）
    const tmp = PROJECTS_FILE + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf-8')
    fs.renameSync(tmp, PROJECTS_FILE)
  } catch (e) {
    console.error('[projects] persist failed:', e)
  }
}



function genId(): string {
  return `proj_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
}

/** 校验创建参数（name 与 root_path 必填；description 可选）。返回错误或 null */
function validateProjectInput(p: any): string | null {
  if (!p || typeof p !== 'object') return 'project 必须是对象'
  if (typeof p.name !== 'string' || !p.name.trim()) return 'name 不能为空'
  if (p.name.length > 100) return 'name 过长（>100）'
  if (typeof p.root_path !== 'string' || !p.root_path.trim()) return 'root_path 不能为空'
  if (p.root_path.length > 500) return 'root_path 过长（>500）'
  if (p.members !== undefined && !Array.isArray(p.members)) return 'members 必须是数组'
  return null
}

export function listProjects(): ProjectRecord[] {
  return load().projects.slice().sort((a, b) => (b.updatedAt || b.created_at || 0) - (a.updatedAt || a.created_at || 0))
}

export function getProject(id: string): ProjectRecord | null {
  return load().projects.find(p => p.id === id) || null
}

export function findByRootPath(rootPath: string): ProjectRecord | null {
  const n = String(rootPath || '').trim().replace(/[\\/]+$/, '').toLowerCase()
  if (!n) return null
  return load().projects.find(p => String(p.root_path || '').trim().replace(/[\\/]+$/, '').toLowerCase() === n) || null
}

/** 创建项目（幂等性提示：同 root_path 已有活跃项目时返回已存在的——前端重复点创建不产生幽灵记录） */
export function createProject(input: { name: string; root_path: string; description?: string; members?: any[]; id?: string }): { ok: true; project: ProjectRecord; existed?: boolean } | { ok: false; error: string } {
  const err = validateProjectInput(input)
  if (err) return { ok: false, error: err }
  /* ★ 0921z：root_path **兜底成绝对路径**。
   *  相对路径是历史脏数据（前端用浏览器 API 取目录只拿得到目录名）——会被按后端进程 cwd 解析到
   *  `backend/<名字>` 下，造成同名工作区两份。前端已改成原生对话框 + 建项目时校验；
   *  这里再兜一层，防 AI 工具 / 旧客户端直接传相对值进来。 */
  const rawRoot = String(input.root_path || '').trim()
  const root = isAbsolutePath(rawRoot)
    ? normalizeRootPath(rawRoot)
    : resolveRelativeRoot(rawRoot, { storageRoot: storageRootProvider(), dataRoot: DATA_ROOT }).path
  /* ★1003 修复 4.28 连带：resolveRelativeRoot 判无效（`..`/盘符相对写法）返回空串，如实拒绝，别拿空路径入库 */
  if (!root) return { ok: false, error: 'root_path 非法（含 .. 段或盘符相对写法），请改用绝对路径' }
  if (root !== rawRoot) console.warn(`[projects] root_path 规范化：${JSON.stringify(rawRoot)} → ${JSON.stringify(root)}`)
  const dup = findByRootPath(root)
  if (dup) return { ok: true, project: dup, existed: true }
  const now = Date.now()
  const project: ProjectRecord = {
    id: input.id && /^[\w-]{4,60}$/.test(input.id) ? input.id : genId(),
    name: input.name.trim(),
    root_path: root,
    description: typeof input.description === 'string' ? input.description.trim() : undefined,
    status: 'active',
    created_at: now,
    updatedAt: now,
    members: Array.isArray(input.members) ? input.members : [],
  }
  const store = load()
  store.projects.push(project)
  persist()
  return { ok: true, project }
}

/** 更新项目（部分字段；id 不可改）。patch 为 undefined 的字段不动 */
export function updateProject(id: string, patch: { name?: string; description?: string; status?: string; members?: any[]; pinned?: boolean }): { ok: true; project: ProjectRecord } | { ok: false; error: string } {
  const store = load()
  const p = store.projects.find(x => x.id === id)
  if (!p) return { ok: false, error: `项目不存在：${id}` }
  if (patch.name !== undefined) {
    if (typeof patch.name !== 'string' || !patch.name.trim()) return { ok: false, error: 'name 不能为空' }
    p.name = patch.name.trim()
  }
  if (patch.description !== undefined) p.description = String(patch.description).trim() || undefined
  if (patch.status !== undefined) {
    if (patch.status !== 'active' && patch.status !== 'archived') return { ok: false, error: 'status 只能是 active/archived' }
    p.status = patch.status
  }
  if (patch.members !== undefined) {
    if (!Array.isArray(patch.members)) return { ok: false, error: 'members 必须是数组' }
    p.members = patch.members
  }
  if (patch.pinned !== undefined) p.pinned = !!patch.pinned
  p.updatedAt = Date.now()
  persist()
  return { ok: true, project: p }
}

/** 删除项目记录（**只删记录，绝不动用户文件夹**——root_path 是用户本地资产） */
export function deleteProject(id: string): { ok: true; existed: boolean } {
  const store = load()
  const before = store.projects.length
  store.projects = store.projects.filter(p => p.id !== id)
  const existed = store.projects.length < before
  if (existed) persist()
  return { ok: true, existed }
}
