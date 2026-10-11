/**
 * 用户记事本（0920 新增）—— 用户与 AI **共用**的便签/待办本。
 *
 * 为什么不用记忆内核（Python）：记事本是"用户自己的东西"，要求**即时、确定、可编辑**，
 * 不适合走向量检索/提炼那套。这里就是一张本地表，落盘 <数据根>/notebook.json。
 *
 * 条目语义：
 *   title   标题（列表里显示）
 *   detail  详情（点开才展开，AI 写入时建议把上下文/来源写这里）
 *   status  todo 待办 / hold 搁置 / done 已完成 / cancelled 取消
 *   source  user 用户建的 / ai AI 写的（列表上给个来源标记，用户知道哪条是自己写的）
 *   images  ★ 1011：详情里贴的图片（只存元数据；图本体落盘 <数据根>/notebook-assets/）
 *
 * 图片口径（1011）：notebook.json 每次打开面板都要全量读，**不能塞 base64**
 *  → JSON 里只留 { id, name, mime, bytes }，图本体在 notebook-assets/<id>.<ext>；
 * 删条目时按 images 级联删文件，不留孤儿。
 *
 * 排序口径：未办（todo/hold）在前、已办（done/cancelled）在后；
 * 同组内按**最近改动**倒序 —— 刚改过的条目永远在最上面（记事本的心智）。
 */
import path from 'node:path'
import crypto from 'node:crypto'
import { SessionAssetStore } from './sessionAssets.ts'
import { DATA_ROOT } from './paths.ts'
import { loadJsonOrBackup, persistJson } from './jsonStore.ts'

/* ★ 0923：新增两态 —— pending 待拍板（等用户决策）/ testing 待测（等验证） */
export type NotebookStatus = 'todo' | 'hold' | 'pending' | 'testing' | 'done' | 'cancelled'
export const NOTEBOOK_STATUSES: NotebookStatus[] = ['todo', 'hold', 'pending', 'testing', 'done', 'cancelled']

export interface NotebookItem {
  id: string
  title: string
  detail: string
  status: NotebookStatus
  /** 谁写的：user=用户在界面里建的 / ai=AI 通过工具写的 */
  source: 'user' | 'ai'
  tags: string[]
  /** ★ 1011：详情里贴的图片（ref → /api/notebook-asset/<ref>，本体在 <数据根>/notebook-assets/） */
  images: NotebookImage[]
  createdAt: number
  updatedAt: number
}

/** ★ 1011：便签图片（只存引用与元数据，本体在磁盘） */
export interface NotebookImage {
  /** 内容寻址引用：<sha256>.<ext>（同图天然去重） */
  ref: string
  name: string
  mime: string
  bytes: number
}

interface NotebookFile {
  version: number
  items: NotebookItem[]
}

const FILE = path.join(DATA_ROOT, 'notebook.json')
const MAX_ITEMS = 500

/* ── ★ 1011：便签图片（详情里贴的图）───────────────────────────────────────
   图片**不进 notebook.json** —— 打开面板每次都要全量读这个文件，塞 base64 会又慢又脆
   （data/sessions.json 28MB 里 9.9MB 是内联图，最后靠剥离 session-assets 才救回来）。
   这里复用会话资产那套 SessionAssetStore：内容寻址 sha256 → <数据根>/notebook-assets/<sha>.<ext>，
   同一张图多处引用只存一份；前端直接 <img src="/api/notebook-asset/<ref>"> 直出。
   ⚠️ 内容寻址 ⇒ 删条目**不删文件**（无法判断别的条目是否还引用同一张图）；
   代价是贴过又删掉的图留在盘上（用户贴图频率低，量很小），孤儿回收留作后续。 */
const NOTEBOOK_ASSETS = new SessionAssetStore(path.join(DATA_ROOT, 'notebook-assets'))
export const NOTEBOOK_ASSET_URL_PREFIX = '/api/notebook-asset/'
/** 一条便签最多贴 8 张 */
const MAX_IMAGES_PER_ITEM = 8
/** 单张上限 3MB（前端会先压一道，这里是兜底） */
const MAX_IMAGE_BYTES = 3 * 1024 * 1024

/** ref 严格校验（同 sessionAssets 的 REF_RE，防路径穿越） */
const IMG_REF_RE = /^[0-9a-f]{64}\.[a-z0-9]{2,5}(?:\.b64)?$/

/** 入口/出口都过一遍白名单：脏数据（旧版无 images / 手改 JSON）不能带坏引用进前端 */
function sanitizeImages(v: unknown): NotebookImage[] {
  if (!Array.isArray(v)) return []
  const out: NotebookImage[] = []
  for (const x of v) {
    const ref = String((x as any)?.ref || '')
    if (!IMG_REF_RE.test(ref)) continue
    out.push({
      ref,
      name: String((x as any)?.name || 'image').slice(0, 120),
      mime: String((x as any)?.mime || 'image/png'),
      bytes: Number((x as any)?.bytes) || 0,
    })
    if (out.length >= MAX_IMAGES_PER_ITEM) break
  }
  return out
}

/** 贴一张图：dataURL → notebook-assets，返回引用与元数据（格式/大小不合格直接抛错，前端好提示） */
export function notebookImageAdd(dataUrl: string, name?: string): NotebookImage {
  const raw = String(dataUrl || '').replace(/\s+/g, '')
  const m = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/i.exec(raw)
  if (!m) throw new Error('图片数据无效（需要 data:image/…;base64,… 形式）')
  const mime = m[1].toLowerCase()
  const b64 = m[2]
  const bytes = Math.floor(b64.length * 3 / 4)
  if (bytes > MAX_IMAGE_BYTES) throw new Error(`图片太大（约 ${(bytes / 1048576).toFixed(1)}MB，上限 ${MAX_IMAGE_BYTES / 1048576}MB）`)
  const ref = NOTEBOOK_ASSETS.save(b64, mime)
  if (!ref) throw new Error('图片写入失败（数据目录不可写？）')
  return { ref, name: String(name || 'image').slice(0, 120), mime, bytes }
}

/** ref → 磁盘文件（HTTP 路由用；非法/缺失返回 null） */
export function resolveNotebookAsset(ref: string): { full: string; mime: string } | null {
  return NOTEBOOK_ASSETS.resolveRef(String(ref || ''))
}

/** 状态归中文文案（AI 工具与日志共用一套口径，避免两边写法不一致） */
export const STATUS_LABEL: Record<NotebookStatus, string> = {
  todo: '待办',
  hold: '搁置',
  pending: '待拍板',
  testing: '待测',
  done: '已完成',
  cancelled: '取消',
}

/* 排序：待办 → 待拍板 → 待测 → 搁置 → 已完成 → 取消（"要人动手的"排在前面） */
const STATUS_RANK: Record<NotebookStatus, number> = { todo: 0, pending: 1, testing: 2, hold: 3, done: 4, cancelled: 5 }

function normalizeStatus(v: unknown): NotebookStatus {
  const s = String(v || '').trim().toLowerCase()
  /* ★ 0923：'pending' 从"归到搁置"改为**独立状态「待拍板」**（旧映射会让 AI 写 pending 静默落到搁置） */
  if (s === 'pending' || s === '待拍板' || s === '待确认' || s === '待决策') return 'pending'
  if (s === 'testing' || s === 'test' || s === '待测' || s === '待验证' || s === '待测试') return 'testing'
  if (s === 'hold' || s === '搁置' || s === 'parked') return 'hold'
  if (s === 'done' || s === '已完成' || s === 'complete' || s === 'completed' || s === 'finish' || s === 'finished') return 'done'
  if (s === 'cancelled' || s === 'canceled' || s === 'cancel' || s === '取消') return 'cancelled'
  return 'todo'
}

/* ★ 0927 第 0 批：文件损坏降级标志（load 时登记；degraded 期间禁止把空本写回盘覆盖用户数据） */
let notebookDegraded = false

function readFileSafe(): NotebookFile {
  /* ★ 0927 第 0 批：改用共享 jsonStore —— ENOENT 才回落空本；内容损坏先备份 .corrupt-* 再回落，
     且本次会话标记 degraded。（旧逻辑：任何失败都静默按空本处理 → 下一次写入就把空本固化成
     权威数据 → 一次文件损坏=全部便签丢失且无感知。体检 P0，家族①病根。） */
  const r = loadJsonOrBackup<any>(FILE, () => ({ version: 1, items: [] }))
  const itemsOk = Array.isArray(r.data?.items)
  /* schema 级损坏（JSON 合法但结构不对，如 {items:null}）同样按降级处理：
     文件本身合法不备份，但触发空本回写保护 + 明确日志 */
  const schemaBad = !r.degraded && r.data != null && !itemsOk
  notebookDegraded = r.degraded || schemaBad
  if (schemaBad) console.error('[notebook] 文件结构异常（items 不是数组），按降级处理：', FILE)
  const items: NotebookItem[] = itemsOk ? r.data.items : []
  return {
      version: 1,
      items: items
        .filter(x => x && typeof x.id === 'string')
        .map(x => ({
          id: String(x.id),
          title: String(x.title || ''),
          detail: String(x.detail || ''),
          status: normalizeStatus(x.status),
          source: x.source === 'ai' ? 'ai' as const : 'user' as const,
          tags: Array.isArray(x.tags) ? x.tags.map((t: any) => String(t)) : [],
          /* ★ 1011：老数据没有 images 字段 → 空数组（不破坏旧条目） */
          images: sanitizeImages((x as any).images),
          createdAt: Number(x.createdAt) || Date.now(),
          updatedAt: Number(x.updatedAt) || Number(x.createdAt) || Date.now(),
        })),
    }
}

/** ★ 0927 第 0 批：原子写（tmp 带 pid+随机，多进程/多实例并发不互截）+ degraded 空本回写保护 */
function writeFileSafe(data: NotebookFile): void {
  persistJson(FILE, data, { degraded: notebookDegraded, isEmpty: () => data.items.length === 0 })
}
function sortItems(items: NotebookItem[]): NotebookItem[] {
  return [...items].sort((a, b) => {
    const r = STATUS_RANK[a.status] - STATUS_RANK[b.status]
    if (r) return r
    return (b.updatedAt || 0) - (a.updatedAt || 0)
  })
}



/** 列出条目：可按状态/关键词过滤 */
export function notebookList(filter?: { status?: string; keyword?: string }): NotebookItem[] {
  const all = readFileSafe().items
  let out = all
  const st = String(filter?.status || '').trim().toLowerCase()
  if (st && st !== 'all' && st !== '全部') {
    const want = normalizeStatus(st)
    out = out.filter(x => x.status === want)
  }
  const kw = String(filter?.keyword || '').trim().toLowerCase()
  if (kw) {
    out = out.filter(x =>
      x.title.toLowerCase().includes(kw) || x.detail.toLowerCase().includes(kw) ||
      x.tags.some(t => t.toLowerCase().includes(kw)))
  }
  return sortItems(out)
}

export function notebookCounts(): Record<NotebookStatus, number> {
  const all = readFileSafe().items
  return {
    todo: all.filter(x => x.status === 'todo').length,
    hold: all.filter(x => x.status === 'hold').length,
    pending: all.filter(x => x.status === 'pending').length,
    testing: all.filter(x => x.status === 'testing').length,
    done: all.filter(x => x.status === 'done').length,
    cancelled: all.filter(x => x.status === 'cancelled').length,
  }
}

export function notebookAdd(input: {
  title: string
  detail?: string
  status?: unknown
  source?: 'user' | 'ai'
  tags?: unknown
  /** ★ 1011：图片引用数组（前端贴图后随保存一起提交） */
  images?: unknown
}): NotebookItem {
  const title = String(input.title || '').trim()
  if (!title) throw new Error('标题不能为空')
  const now = Date.now()
  const item: NotebookItem = {
    id: 'nb-' + now.toString(36) + '-' + crypto.randomBytes(3).toString('hex'),
    title: title.slice(0, 200),
    detail: String(input.detail || '').slice(0, 20000),
    status: normalizeStatus(input.status),
    source: input.source === 'ai' ? 'ai' : 'user',
    tags: Array.isArray(input.tags) ? (input.tags as any[]).map(t => String(t)).slice(0, 12) : [],
    images: sanitizeImages(input.images),
    createdAt: now,
    updatedAt: now,
  }
  const data = readFileSafe()
  data.items.unshift(item)
  data.items = data.items.slice(0, MAX_ITEMS)
  writeFileSafe(data)
  return item
}

/** 按 id 更新；找不到返回 null（调用方自己决定报错口径） */
export function notebookUpdate(id: string, patch: {
  title?: string
  detail?: string
  status?: unknown
  tags?: unknown
  /** ★ 1011：传数组 = **整体替换**图片列表（传空数组即清空）；不传 = 不动图片 */
  images?: unknown
}): NotebookItem | null {
  const data = readFileSafe()
  const it = data.items.find(x => x.id === id)
  if (!it) return null
  if (patch.title != null) it.title = String(patch.title).slice(0, 200)
  if (patch.detail != null) it.detail = String(patch.detail).slice(0, 20000)
  if (patch.status != null) it.status = normalizeStatus(patch.status)
  if (Array.isArray(patch.tags)) it.tags = (patch.tags as any[]).map(t => String(t)).slice(0, 12)
  if (patch.images != null) it.images = sanitizeImages(patch.images)
  it.updatedAt = Date.now()
  writeFileSafe(data)
  return it
}

/** 删条目。★ 1011：**不删图片文件** —— 图片是内容寻址共享的（另一条便签可能引用同一张），
 *  删文件会误伤别人；孤儿图留在 notebook-assets/（用户贴过又删的图，量小），后续可做 GC。 */
export function notebookRemove(id: string): boolean {
  const data = readFileSafe()
  const before = data.items.length
  data.items = data.items.filter(x => x.id !== id)
  if (data.items.length === before) return false
  writeFileSafe(data)
  return true
}

/** 给 AI 工具用：把条目渲染成紧凑文本（别把整个 JSON 丢给模型） */
export function formatNotebook(items: NotebookItem[]): string {
  if (!items.length) return '（便签里没有符合条件的条目）'
  return items.map((x, i) => {
    const detail = x.detail ? `\n   详情：${x.detail.slice(0, 300)}` : ''
    /* ★ 1011：图片只报数量 —— 工具不吃 base64；要 AI 看图，让用户把图放进对话 */
    const imgs = x.images?.length ? `（含 ${x.images.length} 张图）` : ''
    const tag = x.tags.length ? ` [${x.tags.join(',')}]` : ''
    const src = x.source === 'ai' ? '（AI写的）' : ''
    return `${i + 1}. 【${STATUS_LABEL[x.status]}】【id=${x.id}】${x.title}${src}${imgs}${tag}${detail}`
  }).join('\n')
}
