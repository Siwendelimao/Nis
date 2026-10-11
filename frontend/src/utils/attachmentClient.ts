import { useChatStore } from '@/stores/chat'

/**
 * 附件本地存储客户端 —— 后端 attachment.upload / attachment.get / attachment.delete。
 * 存 DATA_ROOT/knowledge-attachments/<entryId>/，attachment.url 记为 `nis://<相对路径>`；
 * 后端未连接时回退 dataURL（前端内嵌，调用方自行兜底）。
 *
 * 0911 接通：原先走 WS ATTACHMENT_UPLOAD/GET/DELETE 死通道（等后端永不发送的消息 → 转 15s 失败），
 * 现改为 bridgeRpc 实链路。同时按扩展名推断 MIME——旧实现固定返回
 * `data:application/octet-stream`，浏览器不会把它当图片渲染（本地图片附件此前根本显示不出来）。
 */

interface UploadedAttachment {
  /** nis:// 相对路径（后端存储）或 data: 内嵌 */
  url: string
  path?: string
}

/** 判断附件 url 是否指向后端本地文件 */
export function isLocalAttachment(url: string): boolean {
  return url.startsWith('nis://')
}

/** nis:// 相对路径 → 纯相对路径 */
export function localPathOf(url: string): string {
  return url.replace(/^nis:\/\//, '')
}

/** 后端单次上限（与 server.ts attachment.upload 的 12MB 对齐） */
const MAX_ATTACH_BYTES = 12 * 1024 * 1024

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  avif: 'image/avif',
  ico: 'image/x-icon',
  mp4: 'video/mp4',
  webm: 'video/webm',
  ogg: 'video/ogg',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  pdf: 'application/pdf',
  json: 'application/json',
  md: 'text/markdown',
  txt: 'text/plain',
  csv: 'text/csv',
  zip: 'application/zip',
}

function mimeOf(nameOrPath: string, hint = ''): string {
  if (/^data:([^;,]+)/.test(hint)) return /^data:([^;,]+)/.exec(hint)![1]
  const m = /\.([A-Za-z0-9]+)(?:\?.*)?$/.exec(nameOrPath)
  const ext = m ? m[1].toLowerCase() : ''
  return MIME_BY_EXT[ext] || 'application/octet-stream'
}

/**
 * 上传附件到后端本地存储。
 * @returns { url, path }；后端未连接或失败返回 null（调用方回退 dataURL）
 */
export async function uploadAttachment(
  entryId: string,
  type: string,
  name: string,
  data: string,
): Promise<UploadedAttachment | null> {
  const chatStore = useChatStore()
  if (!chatStore.wsConnected) return null
  // 只允许 dataURL 或裸 base64
  let base64 = data
  if (data.startsWith('data:')) {
    const comma = data.indexOf(',')
    if (comma < 0) return null
    base64 = data.slice(comma + 1)
  }
  if (!base64) return null
  // 二进制体积估算（base64 长度 * 3/4）
  if (base64.length * 3 / 4 > MAX_ATTACH_BYTES) return null

  try {
    const r = await chatStore.bridgeRpc('attachment.upload', { entryId, type, name, data: base64 }, 120000 /* ★0927 慢 RPC 大超时：附件可能大 */)
    if (r?.ok && r.path) return { url: `nis://${r.path}`, path: String(r.path) }
    return null
  } catch {
    return null
  }
}

/** 后端本地文件 → 可展示的 dataURL（带缓存，避免重复拉取） */
const contentCache = new Map<string, string>()

export async function fetchAttachmentContent(path: string): Promise<string | null> {
  if (contentCache.has(path)) return contentCache.get(path)!

  const chatStore = useChatStore()
  if (!chatStore.wsConnected) return null

  try {
    const r = await chatStore.bridgeRpc('attachment.get', { path: localPathOf(path) })
    if (!r?.data) return null
    const src = `data:${mimeOf(path)};base64,${r.data}`
    contentCache.set(path, src)
    return src
  } catch {
    return null
  }
}


