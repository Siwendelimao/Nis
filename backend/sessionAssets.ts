/**
 * 0911 #16 会话资产（截图剥离 + 全局去重）
 *
 * 背景：data/sessions.json 28MB 中约 9.9MB 是内嵌 base64 图片（AI 浏览器截图 wb_screenshot
 * 的 tool_result 文本 / image content block）。同一张图在 messages 与 transcript 各存一份，
 * 127 次引用只有 85 张唯一图。
 *
 * 策略（落盘剥离 / 加载还原，语义严格无损）：
 *   - 落盘前：内嵌 data URL → data/session-assets/<sha256>.<ext>，正文替换为
 *     `/api/session-asset/<sha256>.<ext>`；image block 的 data 原位换成 asset 字段。
 *   - 启动读取：反向还原为内嵌 data URL（内存态与改造前逐字节一致）。
 *
 * 严格无损的两个保证：
 *   1. image block 原位替换键（type,data,mimeType → type,asset,mimeType → type,data,mimeType），
 *      键顺序不变。
 *   2. 非规范 base64（解码-编码往返不稳定，如被截断的串）→ 存为 `<sha>.<ext>.b64` 文本，
 *      还原时逐字符回填，绝不规范化。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

export const ASSET_DIR_NAME = 'session-assets'
export const ASSET_URL_PREFIX = '/api/session-asset/'

const MIME_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
}
const EXT_MIME: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
  gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml',
}

/** ref：<64 位 hex>.<扩展名>[.b64]（严格校验，防路径穿越） */
const REF_RE = /^[0-9a-f]{64}\.[a-z0-9]{2,5}(?:\.b64)?$/
/** 文本内嵌 data URL（base64 载荷 ≥64 字符，避免误伤 1x1 占位图） */
/* 0927 netfix b64-wrap-0927：payload 允许被换行折断（存的时候先去空白）—— 原正则遇断行只匹配到
   第一段 → 图片被截断存成坏图。 */
const DATA_URL_RE = /data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+(?:\r?\n[A-Za-z0-9+/=]+)*)/g

interface RefParts { sha: string; ext: string; text: boolean }

function parseRef(ref: string): RefParts | null {
  if (!REF_RE.test(ref)) return null
  const parts = ref.split('.')
  return { sha: parts[0], ext: parts[1], text: parts.length === 3 }
}

export class SessionAssetStore {
  private known = new Set<string>()
  /** base64 → ref：同一张图在 messages/transcript 多处出现时跳过 sha256 + 写盘（persist 热路径） */
  private refCache = new Map<string, string>()

  constructor(private dir: string) { }

  /** base64 → ref（幂等：同图只落一份；非规范 base64 存文本形式以保证还原无损）。
   *  ★1003 批次4 4.40：写盘失败返回 **null**（原 `return ref` = 悬空引用 —— strip 会把 data URL
   *  换成 /api/session-asset/<ref>，但文件根本不存在：还原时 read()=null、URL 留原样不还原，
   *  图片字节**永久丢失**，违反本模块"语义严格无损"保证）。调用方按 null 保留原始内联数据。 */
  save(b64: string, mime: string): string | null {
    const cached = this.refCache.get(b64)
    if (cached) return cached
    const ext = MIME_EXT[String(mime || '').toLowerCase()] || 'png'
    const sha = crypto.createHash('sha256').update(b64).digest('hex')
    const canonical = Buffer.from(b64, 'base64').toString('base64')
    const text = canonical !== b64
    const ref = `${sha}.${ext}${text ? '.b64' : ''}`
    if (this.known.has(ref)) { this.refCache.set(b64, ref); return ref }
    const full = path.join(this.dir, ref)
    if (!fs.existsSync(full)) {
      try {
        fs.mkdirSync(this.dir, { recursive: true })
        if (text) fs.writeFileSync(full, b64, 'utf-8')
        else fs.writeFileSync(full, Buffer.from(b64, 'base64'))
      } catch (e) {
        console.error('[session-assets] write failed:', ref, e)
        return null   // ★1003 4.40：写不进盘就不造引用（调用方保留内联数据）
      }
    }
    this.known.add(ref)
    this.refCache.set(b64, ref)
    return ref
  }

  /** ref → { base64, mime }；非法 ref 或读失败返回 null */
  read(ref: string): { b64: string; mime: string } | null {
    const p = parseRef(ref)
    if (!p) return null
    try {
      const buf = fs.readFileSync(path.join(this.dir, ref))
      return { b64: p.text ? buf.toString('utf-8') : buf.toString('base64'), mime: EXT_MIME[p.ext] || 'image/png' }
    } catch {
      return null
    }
  }

  /** 路由用：ref → { 绝对路径, mime }（非法或不存在返回 null） */
  resolveRef(ref: string): { full: string; mime: string } | null {
    const p = parseRef(ref)
    if (!p) return null
    const full = path.join(this.dir, ref)
    try {
      if (!fs.statSync(full).isFile()) return null
      return { full, mime: EXT_MIME[p.ext] || 'application/octet-stream' }
    } catch {
      return null
    }
  }
}

/**
 * 落盘剥离：内嵌 base64 → asset 引用。
 * 未变更的分支返回原引用（写时复制），不含图的会话几乎零开销。
 */
export function stripSessionAssets(node: any, store: SessionAssetStore): any {
  if (typeof node === 'string') {
    if (!node.includes('data:image/')) return node
    return node.replace(DATA_URL_RE, (_m, mime: string, b64: string) => {
      const clean = String(b64).replace(/\s+/g, '')
      if (clean.length < 64) return _m   /* 不足 64 字符当占位图，不动 */
      const ref = store.save(clean, mime)
      return ref ? ASSET_URL_PREFIX + ref : _m   // ★1003 4.40：落盘失败保留原始内联数据（无损）
    })
  }
  if (Array.isArray(node)) {
    let changed = false
    const out = node.map((v) => {
      const r = stripSessionAssets(v, store)
      if (r !== v) changed = true
      return r
    })
    return changed ? out : node
  }
  if (node && typeof node === 'object') {
    // pi image block：data 原位换成 asset（保持键顺序，还原时 keys 不变）
    if (node.type === 'image' && typeof node.data === 'string' && node.data.length >= 64 && !node.asset) {
      const ref = store.save(node.data, node.mimeType || 'image/png')
      if (!ref) return node   // ★1003 4.40：落盘失败保留内联 data（无损，不造悬空 asset）
      const copy: any = {}
      for (const k of Object.keys(node)) {
        if (k === 'data') copy.asset = ref
        else copy[k] = node[k]
      }
      return copy
    }
    let changed = false
    const out: any = {}
    for (const k of Object.keys(node)) {
      const r = stripSessionAssets(node[k], store)
      if (r !== node[k]) changed = true
      out[k] = r
    }
    return changed ? out : node
  }
  return node
}

/**
 * 加载还原：asset 引用 → 内嵌 base64（与改造前内存态逐字节一致）。
 * 未变更的分支返回原引用。
 */
export function restoreSessionAssets(node: any, store: SessionAssetStore): any {
  if (typeof node === 'string') {
    if (!node.includes(ASSET_URL_PREFIX)) return node
    return node.replace(/\/api\/session-asset\/([0-9a-f]{64}\.[a-z0-9]{2,5}(?:\.b64)?)/g, (m, ref: string) => {
      const a = store.read(ref)
      return a ? `data:${a.mime};base64,${a.b64}` : m
    })
  }
  if (Array.isArray(node)) {
    let changed = false
    const out = node.map((v) => {
      const r = restoreSessionAssets(v, store)
      if (r !== v) changed = true
      return r
    })
    return changed ? out : node
  }
  if (node && typeof node === 'object') {
    if (node.type === 'image' && typeof node.asset === 'string' && !node.data) {
      const a = store.read(node.asset)
      if (a) {
        const copy: any = {}
        for (const k of Object.keys(node)) {
          if (k === 'asset') copy.data = a.b64
          else copy[k] = node[k]
        }
        return copy
      }
    }
    let changed = false
    const out: any = {}
    for (const k of Object.keys(node)) {
      const r = restoreSessionAssets(node[k], store)
      if (r !== node[k]) changed = true
      out[k] = r
    }
    return changed ? out : node
  }
  return node
}
