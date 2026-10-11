/**
 * 0912 二十一批：通道**入站图片**入库。
 *
 * 背景（用户实测反馈）：
 *   「QQ/微信里发图片给 AI，AI 看不到」——QQ 的图片在 content 里是 `<image url="..."/>`
 *   标签（早期被整条跳过），微信的图片在 item_list 的 image_item 里（加密，需 CDN 解密），
 *   两条链路此前**都没有**把图交给 agent，于是"给 AI 看图"一直是断的。
 *
 * 本模块负责：
 *   ① QQ：从 content 里剥出 `<image .../>` 标签（正文留下标记），下载 → 嗅探类型 → 落盘
 *   ② 统一落盘位置：DATA_ROOT/channel-inbox/<channel>/<botId>/<ts>-<rand>.<ext>
 *   ③ 产出 InboundImage：{ path, mime, dataUrl, bytes } ——
 *      dataUrl 供 agent 看图（pi ImageContent），path 供 AI 转发/复用（MEDIA: 行）
 *
 * 微信的 CDN 解密在 wechatBot.ts 内完成（要用到它的 token/请求封装），
 * 解出 Buffer 后同样调本模块的 saveInboundImage 落盘。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { DATA_ROOT } from '../paths.ts'

/** 单张入站图片上限（超过就拒绝并告知，避免 base64 撑爆请求/上下文） */
export const INBOUND_IMAGE_MAX_BYTES = 12 * 1024 * 1024
/** 单条消息最多处理几张（QQ 一次发 9 图也只取前几张，防上下文爆炸） */
export const INBOUND_IMAGE_MAX_COUNT = 4
/** 下载超时 */
const FETCH_TIMEOUT_MS = 20_000

export interface InboundImage {
  /** 绝对路径（AI 可用 MEDIA: 行转发它） */
  path: string
  mime: string
  /** data:<mime>;base64,<...> —— 直接喂给多模态模型 */
  dataUrl: string
  bytes: number
}

/** 魔数嗅探（平台给的 content-type 经常是 octet-stream，不能信） */
function sniffImageMime(buf: Buffer, fallback = 'image/png'): string {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png'
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
  if (buf.length >= 6 && buf.slice(0, 3).toString('ascii') === 'GIF') return 'image/gif'
  if (buf.length >= 12 && buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) return 'image/bmp'
  return fallback
}

const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
}

/**
 * 把入站图片写到通道收件目录。
 * @returns 落盘成功返回 InboundImage；超限/写盘失败返回 { error }
 */
export function saveInboundImage(
  channel: string,
  botId: string,
  buf: Buffer,
  mimeHint?: string,
): InboundImage | { error: string } {
  if (!buf?.length) return { error: '图片内容为空' }
  if (buf.length > INBOUND_IMAGE_MAX_BYTES) {
    return { error: `图片过大（${(buf.length / 1024 / 1024).toFixed(1)}MB，上限 ${INBOUND_IMAGE_MAX_BYTES / 1024 / 1024}MB）` }
  }
  const mime = sniffImageMime(buf, mimeHint || 'image/png')
  const ext = MIME_EXT[mime] || 'png'
  try {
    const dir = path.join(DATA_ROOT, 'channel-inbox', channel, botId || 'bot')
    fs.mkdirSync(dir, { recursive: true })
    const name = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}.${ext}`
    const full = path.join(dir, name)
    fs.writeFileSync(full, buf)
    const b64 = buf.toString('base64')
    return { path: full, mime, dataUrl: `data:${mime};base64,${b64}`, bytes: buf.length }
  } catch (e: any) {
    return { error: `图片落盘失败：${String(e?.message || e).slice(0, 120)}` }
  }
}

/* ── QQ：content 里的图片标签 ───────────────────────────────── */

/** QQ 图片标签：`<image url="..."/>`（可能还带 file_uuid/ttl 等属性；也有 url 为空的） */
const QQ_IMAGE_RE = /<image\b[^>]*\/?>/gi
const QQ_ATTR_RE = (name: string) => new RegExp(`${name}\\s*=\\s*"([^"]*)"`, 'i')

/**
 * 从 QQ 消息正文里剥出图片标签。
 * @returns text=去掉标签的正文（有多图时留 `[图片]` 占位）；urls=可下载的图片地址
 */
export function extractQqImages(content: string): { text: string; urls: string[] } {
  const raw = String(content || '')
  const urls: string[] = []
  const text = raw.replace(QQ_IMAGE_RE, (tag) => {
    const m = QQ_ATTR_RE('url').exec(tag)
    const u = String(m?.[1] || '').trim()
    // url 是 http(s) 才收（file_uuid 单独下发的老形态这里处理不了，直接忽略）
    if (/^https?:\/\//i.test(u)) urls.push(u)
    return ' [图片] '
  }).replace(/[ \t]{2,}/g, ' ').trim()
  return { text, urls: urls.slice(0, INBOUND_IMAGE_MAX_COUNT) }
}

/** 下载一张网络图片 / 一个附件（QQ 图链直连即可，无需鉴权）
 *  0920：改为**带失败原因**的版本（见 downloadBinary）——以前只返回 null，
 *  上层只能写"下载失败"，出了问题没法排查（"间歇性能看图"就是这么被静默吞掉的）。 */
export async function downloadBinary(
  url: string,
  label = 'image',
  maxBytes = INBOUND_IMAGE_MAX_BYTES,
): Promise<{ ok: true; buf: Buffer; mime: string } | { ok: false; reason: string }> {
  const tryFetch = async (u: string): Promise<{ ok: true; buf: Buffer; mime: string } | { ok: false; reason: string }> => {
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS)
    try {
      const res = await fetch(u, {
        headers: {
          // 部分 QQ 图链按 UA 做防盗链，带一个常见浏览器 UA 最稳
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
          Referer: 'https://q.qq.com/',
        },
        signal: ctl.signal,
      })
      if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` }
      const ab = await res.arrayBuffer()
      const buf = Buffer.from(ab)
      if (!buf.length) return { ok: false, reason: '下载内容为空' }
      if (buf.length > maxBytes) return { ok: false, reason: `超过 ${(maxBytes / 1024 / 1024).toFixed(0)}MB 上限` }
      const ct = String(res.headers.get('content-type') || '').toLowerCase()
      return { ok: true, buf, mime: sniffImageMime(buf, ct.startsWith('image/') ? ct.split(';')[0] : 'image/png') }
    } catch (e: any) {
      const aborted = String(e?.name || '') === 'AbortError'
      return { ok: false, reason: aborted ? `超时（${FETCH_TIMEOUT_MS / 1000}s）` : String(e?.message || e).slice(0, 80) }
    } finally {
      clearTimeout(t)
    }
  }
  const r1 = await tryFetch(url)
  if (r1.ok) return r1
  // http 失败时试一次 https（qpic 图链两种都有）
  let reason = r1.reason
  if (/^http:\/\//i.test(url)) {
    const r2 = await tryFetch(url.replace(/^http:/i, 'https:'))
    if (r2.ok) return r2
    reason = `${reason} → https 重试也未成（${r2.reason}）`
  }
  console.warn(`[imageIntake] ${label} 下载失败（${reason}）：${url.slice(0, 120)}`)
  return { ok: false, reason }
}

/** 兼容旧签名：拿不到就 null */
export async function downloadImageUrl(url: string, label = 'image', maxBytes = INBOUND_IMAGE_MAX_BYTES): Promise<{ buf: Buffer; mime: string } | null> {
  const r = await downloadBinary(url, label, maxBytes)
  return r.ok ? { buf: r.buf, mime: r.mime } : null
}

/** 批量下载 QQ 图片 → 落盘（失败的单张只记账，不拦整条消息） */
export async function fetchQqImages(
  channel: string,
  botId: string,
  urls: string[],
): Promise<{ images: InboundImage[]; errors: string[] }> {
  const images: InboundImage[] = []
  const errors: string[] = []
  const list = urls.slice(0, INBOUND_IMAGE_MAX_COUNT)
  for (let i = 0; i < list.length; i++) {
    const got = await downloadBinary(list[i], 'qq')
    // 0920：错误带上"第几张 + 原因"，上层才能如实告诉用户/AI（以前一律"下载失败"）
    if (!got.ok) { errors.push(`第${i + 1}张 ${got.reason}`); continue }
    const saved = saveInboundImage(channel, botId, got.buf, got.mime)
    if ('error' in saved) { errors.push(`第${i + 1}张 ${saved.error}`); continue }
    images.push(saved)
  }
  return { images, errors }
}

/* ── 非图片附件（文件）──────────────────────────────────────
 * QQ/微信把「文件」也当附件下发（content_type='file'）。落盘后让 AI 能读、
 * 也能原样转发（MEDIA: 行）。与图片分开存（files/ 子目录），避免和截图混在一起。
 */

/** 单个入站文件上限 */
export const INBOUND_FILE_MAX_BYTES = 20 * 1024 * 1024

interface InboundFile {
  path: string
  /** 原始文件名（已在前面加时间戳前缀防重名） */
  name: string
  mime: string
  bytes: number
}

/** 文件名消毒：去掉路径分隔符与控制字符，限制长度 */
function safeFileName(name: string): string {
  const base = String(name || 'file.bin').split(/[\\/]/).filter(Boolean).pop() || 'file.bin'
  return base.replace(/[\u0000-\u001f<>:"|?*]/g, '_').slice(0, 80)
}

/**
 * 落盘一个入站文件。
 * @returns 成功返回 InboundFile；超限/写盘失败返回 { error }
 */
export function saveInboundFile(
  channel: string,
  botId: string,
  buf: Buffer,
  fileName: string,
  mimeHint?: string,
): InboundFile | { error: string } {
  if (!buf?.length) return { error: '文件内容为空' }
  if (buf.length > INBOUND_FILE_MAX_BYTES) {
    return { error: `文件过大（${(buf.length / 1024 / 1024).toFixed(1)}MB，上限 ${INBOUND_FILE_MAX_BYTES / 1024 / 1024}MB）` }
  }
  const name = safeFileName(fileName)
  try {
    const dir = path.join(DATA_ROOT, 'channel-inbox', channel, botId || 'bot', 'files')
    fs.mkdirSync(dir, { recursive: true })
    const stamped = `${Date.now().toString(36)}-${name}`
    const full = path.join(dir, stamped)
    fs.writeFileSync(full, buf)
    return { path: full, name, mime: mimeHint || 'application/octet-stream', bytes: buf.length }
  } catch (e: any) {
    return { error: `文件落盘失败：${String(e?.message || e).slice(0, 120)}` }
  }
}
