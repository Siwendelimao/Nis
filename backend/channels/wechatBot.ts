/**
 * 微信通道（官方 ClawBot / iLink 协议）—— getUpdates 长轮询 + sendMessage 回推
 *
 * 协议来源：腾讯官方开源项目 @tencent-weixin/openclaw-weixin（MIT），
 * 源码参考见 `backend/_research_wx/`。核心三条：
 *   · POST ilink/bot/msg/notifystart —— **上线通知**（不调它，手机端 ClawBot 会显示「暂时无法连接」）
 *   · POST ilink/bot/getupdates     —— **长轮询收消息**（35s 挂起；它本身也是"客户端在线"的心跳）
 *   · POST ilink/bot/sendmessage    —— 回推消息（带 context_token 才能进正确会话）
 *
 * ⚠️ 为什么必须要有长轮询：微信服务端以「是否有活跃 getupdates 连接」判定 bot 在线。
 *    只有 token 不拉取 = 服务端认为你掉线 → 手机端报「暂时无法连接」（用户实测踩到）。
 *
 * 凭据：bot_token 存通道配置的 `bots[].secret`（前端只看到 hasSecret 标记，不下发明文）。
 * 游标：get_updates_buf 落盘 `data/channels/wechat-sync.json`（重启续传，不丢消息）。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { DATA_ROOT } from '../paths.ts'
import { saveInboundImage, type InboundImage } from './imageIntake.ts'
import { filterWechatMarkdown } from './wechatMarkdownFilter.ts'

/* ── 协议常量（对齐官方 2.4.8）── */
const BASE_URL = 'https://ilinkai.weixin.qq.com'
const APP_ID = 'bot'
/** iLink-App-ClientVersion：major<<16 | minor<<8 | patch（官方 buildClientVersion） */
const CLIENT_VERSION = (2 << 16) | (4 << 8) | 8
const CHANNEL_VERSION = '2.4.8'
const BOT_AGENT = 'NIS/1.0'
const LONG_POLL_TIMEOUT_MS = 35_000
const API_TIMEOUT_MS = 15_000
const MAX_CONSECUTIVE_FAILURES = 3
const BACKOFF_MS = 30_000
const RETRY_MS = 2_000
/** 服务端返回此码 = bot_token 已失效（需重新扫码） */
const STALE_TOKEN_ERRCODE = -14

const SYNC_FILE = path.join(DATA_ROOT, 'channels', 'wechat-sync.json')

function log(msg: string): void {
  console.log(`[wechatBot] ${msg}`)
}

/* ══════════════════ 底层 HTTP ══════════════════ */

/** X-WECHAT-UIN：随机 uint32 → 十进制字符串 → base64（官方实现） */
function randomWechatUin(): string {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0)
  return Buffer.from(String(uint32), 'utf-8').toString('base64')
}

function buildHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'X-WECHAT-UIN': randomWechatUin(),
    'iLink-App-Id': APP_ID,
    'iLink-App-ClientVersion': String(CLIENT_VERSION),
  }
  if (token?.trim()) headers.Authorization = `Bearer ${token.trim()}`
  return headers
}

function buildBaseInfo(): { channel_version: string; bot_agent: string } {
  return { channel_version: CHANNEL_VERSION, bot_agent: BOT_AGENT }
}

/** 统一 POST（返回原始文本；HTTP 错误抛异常） */
async function postApi(
  endpoint: string,
  payload: unknown,
  opts: { token?: string; timeoutMs?: number; label: string; abortSignal?: AbortSignal },
): Promise<string> {
  const url = `${BASE_URL}/${endpoint}`
  const controller = new AbortController()
  const timer = opts.timeoutMs ? setTimeout(() => controller.abort(), opts.timeoutMs) : undefined
  // 外部 abort（停止通道）要能立即取消在途请求
  const onExternal = () => controller.abort()
  opts.abortSignal?.addEventListener('abort', onExternal, { once: true })
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: buildHeaders(opts.token),
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`${opts.label} ${res.status}: ${text.slice(0, 200)}`)
    return text
  } finally {
    if (timer) clearTimeout(timer)
    opts.abortSignal?.removeEventListener('abort', onExternal)
  }
}

/* ══════════════════ 协议封装 ══════════════════ */

interface WechatMessage {
  seq?: number
  message_id?: number
  from_user_id?: string
  to_user_id?: string
  client_id?: string
  create_time_ms?: number
  session_id?: string
  context_token?: string
  /**
   * 消息内容块。type：1=文本 / 2=图片 / 3=语音 / 4=文件 / 5=视频（官方 proto MessageItemType）。
   * 0912 二十一批：补齐 image_item 结构（此前只声明 text_item，图片消息整条被跳过）。
   */
  item_list?: WechatItem[]
}


interface WechatItem {
  type?: number
  text_item?: { text?: string }
  /**
   * ★1020：工具进度项的字段（照官方 reply-progress-sender.ts 拼）——
   * start 用 `is_completed: false` + `tool_call_start_item`；result 用 `true` + `tool_call_result_item.status`。
   */
  create_time_ms?: number
  is_completed?: boolean
  tool_call_start_item?: { tool_name?: string; tool_call_id?: string }
  tool_call_result_item?: { tool_name?: string; tool_call_id?: string; status?: string }
  image_item?: { media?: WechatCdnMedia; aeskey?: string; mid_size?: number }
  file_item?: { media?: WechatCdnMedia; file_name?: string }
  video_item?: { media?: WechatCdnMedia; video_size?: number }
  voice_item?: { media?: WechatCdnMedia }
}

/** 微信 CDN 媒体引用（加密下载用） */
interface WechatCdnMedia {
  encrypt_query_param?: string
  aes_key?: string
  full_url?: string
  encrypt_type?: number
}

interface GetUpdatesResp {
  ret?: number
  errcode?: number
  errmsg?: string
  msgs?: WechatMessage[]
  get_updates_buf?: string
  longpolling_timeout_ms?: number
}

/**
 * 长轮询拉消息。**客户端超时属正常**（服务端挂起到超时）—— 返回空响应让调用方直接重试。
 */
async function getUpdates(
  token: string,
  buf: string,
  timeoutMs: number,
  abortSignal?: AbortSignal,
): Promise<GetUpdatesResp> {
  try {
    const text = await postApi('ilink/bot/getupdates', {
      get_updates_buf: buf ?? '',
      base_info: buildBaseInfo(),
    }, { token, timeoutMs, label: 'getUpdates', abortSignal })
    return JSON.parse(text) as GetUpdatesResp
  } catch (err: any) {
    // 超时 / 外部 abort = 正常控制流退出，返回空响应
    if (err?.name === 'AbortError') return { ret: 0, msgs: [], get_updates_buf: buf }
    throw err
  }
}

/** 发送一条文本消息（需要 context_token 才能落入正确会话） */
export async function sendWechatText(
  token: string,
  toUserId: string,
  text: string,
  contextToken?: string,
): Promise<void> {
  const clientId = `nis:${Date.now()}-${crypto.randomBytes(4).toString('hex')}`
  const text2 = String(text || '').trim()
  /**
   * ★1020：出站先过官方 Markdown 过滤器（规则与来源见 channels/wechatMarkdownFilter.ts）。
   * 微信只"部分支持"markdown（官方原话 partially supported）——不过滤就会把 `#####`、
   * 包裹中文的 `*斜体*`、图片语法 `![x](url)` 这类裸标记直接甩到用户眼前。
   * 兜底：整条被过滤成空（例如正文只有一个图片语法）时退回原文，绝不发空消息。
   */
  const filtered = filterWechatMarkdown(text2).trim()
  const finalText = filtered || text2
  const body = {
    msg: {
      from_user_id: '',
      to_user_id: toUserId,
      client_id: clientId,
      message_type: 2,   // BOT
      message_state: 2,  // FINISH
      item_list: finalText ? [{ type: 1, text_item: { text: finalText } }] : undefined,
      context_token: contextToken || undefined,
    },
    base_info: buildBaseInfo(),
  }
  const raw = await postApi('ilink/bot/sendmessage', body, { token, timeoutMs: API_TIMEOUT_MS, label: 'sendMessage' })
  let resp: { ret?: number; errmsg?: string } = {}
  try { resp = JSON.parse(raw) } catch { /* 非 JSON 视为成功 */ }
  if (resp.ret && resp.ret !== 0) {
    throw new Error(`sendMessage ret=${resp.ret} errmsg=${resp.errmsg || '(none)'}`)
  }
}

/**
 * ★1020：发一条「工具进度」消息（官方 MessageItemType 11/12）。
 *
 * 官方做法照抄：`_research_wx/package/src/messaging/reply-progress-sender.ts`（模型每调一个工具，
 * 就独立发一条进度消息：start 一条、end 一条；不参与最终回复的汇总）。
 * 本通道没有流式（协议写死 message_state: FINISH）⇒ 进度是"过程可见"的唯一手段。
 * 失败**不抛**：进度是锦上添花，发不出去绝不能影响本轮回复 —— 只记日志。
 */
export async function sendWechatToolProgress(
  token: string,
  toUserId: string,
  item: WechatItem,
  contextToken?: string,
  phase = 'progress',
  /** 同一轮的 id：官方用它把这一轮的进度消息归组（官方 send.ts 的 msg.run_id，缺省可为空） */
  runId?: string,
): Promise<void> {
  if (!token || !toUserId || !item) return
  const body = {
    msg: {
      from_user_id: '',
      to_user_id: toUserId,
      client_id: `nis:${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
      message_type: 2,   // BOT
      message_state: 2,  // FINISH —— 官方进度消息也是各自独立一条
      item_list: [item],
      context_token: contextToken || undefined,
      run_id: runId || undefined,
    },
    base_info: buildBaseInfo(),
  }
  try {
    const raw = await postApi('ilink/bot/sendmessage', body, { token, timeoutMs: API_TIMEOUT_MS, label: `sendToolProgress:${phase}` })
    let resp: { ret?: number; errmsg?: string } = {}
    try { resp = JSON.parse(raw) } catch { /* 非 JSON 视为成功 */ }
    if (resp.ret && resp.ret !== 0) log(`工具进度发送被拒(${phase}) ret=${resp.ret} errmsg=${resp.errmsg || '(none)'}`)
  } catch (e: any) {
    log(`工具进度发送失败(${phase})：${String(e?.message || e).slice(0, 160)}`)
  }
}

/* ── 0912 二十一批：出站媒体（图片/视频/文件）—— CDN 加密上传 ──────────
 * 微信发媒体三步（移植自官方 openclaw-weixin，MIT，见 backend/_research_wx）：
 *   ① POST ilink/bot/getuploadurl（filekey/media_type/rawsize/md5/filesize/aeskey）→ 预签名上传地址
 *   ② AES-128-ECB 加密后 POST 到 CDN → 响应头 `x-encrypted-param` = 下载凭证
 *   ③ sendmessage 带 image_item/file_item（media.encrypt_query_param + aes_key + encrypt_type:1）
 * 为什么必须走加密：微信 CDN 只收密文，明文直传会被拒/对方解不出来。
 */

/** AES-128-ECB（PKCS7 默认填充）密文长度 */
function aesEcbPaddedSize(n: number): number {
  return Math.ceil((n + 1) / 16) * 16
}

/** 扩展名 → media_type / item type（1=图片 2=视频 3=文件；item 与之对应 2/5/4） */
function mediaKindOf(name: string): 'image' | 'video' | 'file' {
  const ext = String(name).toLowerCase().match(/\.[a-z0-9]+$/)?.[0] || ''
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico'].includes(ext)) return 'image'
  if (['.mp4', '.mov', '.avi', '.mkv', '.webm'].includes(ext)) return 'video'
  return 'file'
}

/**
 * 上传并发送一个媒体文件（图片/视频/文件）。
 * @param item.path 本地绝对路径
 * @param item.name 展示用文件名（决定类型判定）
 */
export async function sendWechatMedia(
  token: string,
  toUserId: string,
  item: { path: string; name: string },
  contextToken?: string,
): Promise<void> {
  const plain = fs.readFileSync(item.path)
  if (!plain.length) throw new Error('文件是空的')
  const kind = mediaKindOf(item.name)
  const rawsize = plain.length
  const rawfilemd5 = crypto.createHash('md5').update(plain).digest('hex')
  const filesize = aesEcbPaddedSize(rawsize)
  const filekey = crypto.randomBytes(16).toString('hex')
  const aeskey = crypto.randomBytes(16)
  const mediaType = kind === 'image' ? 1 : kind === 'video' ? 2 : 3

  // ① 预签名
  const upRaw = await postApi('ilink/bot/getuploadurl', {
    filekey,
    media_type: mediaType,
    to_user_id: toUserId,
    rawsize,
    rawfilemd5,
    filesize,
    no_need_thumb: true,
    aeskey: aeskey.toString('hex'),
    base_info: buildBaseInfo(),
  }, { token, timeoutMs: API_TIMEOUT_MS, label: 'getUploadUrl' })
  let up: any = {}
  try { up = JSON.parse(upRaw) } catch { throw new Error(`getUploadUrl 返回非 JSON：${upRaw.slice(0, 160)}`) }
  const uploadFull = String(up?.upload_full_url || '').trim()
  const uploadParam = String(up?.upload_param || '').trim()
  if (!uploadFull && !uploadParam) throw new Error(`getUploadUrl 未返回上传地址：${JSON.stringify(up).slice(0, 160)}`)
  const cdnUrl = uploadFull || `${CDN_BASE_URL}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`

  // ② 加密上传
  const cipher = (() => {
    const c = crypto.createCipheriv('aes-128-ecb', aeskey, null)
    return Buffer.concat([c.update(plain), c.final()])
  })()
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), 60_000)
  let downloadParam = ''
  try {
    const res = await fetch(cdnUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array(cipher),
      signal: ctl.signal,
    })
    if (!res.ok) {
      const msg = res.headers.get('x-error-message') || (await res.text().catch(() => ''))
      throw new Error(`CDN 上传失败 ${res.status}${msg ? `：${String(msg).slice(0, 120)}` : ''}`)
    }
    downloadParam = String(res.headers.get('x-encrypted-param') || '')
  } finally {
    clearTimeout(timer)
  }
  if (!downloadParam) throw new Error('CDN 上传成功但未返回 x-encrypted-param')

  // ③ 发送（每条消息只放一个 item；图片/视频/文件字段名不同）
  const mediaRef = {
    encrypt_query_param: downloadParam,
    aes_key: Buffer.from(aeskey.toString('hex')).toString('base64'),
    encrypt_type: 1,
  }
  const msgItem: any = kind === 'image'
    ? { type: 2, image_item: { media: mediaRef, mid_size: filesize } }
    : kind === 'video'
      ? { type: 5, video_item: { media: mediaRef, video_size: filesize } }
      : { type: 4, file_item: { media: mediaRef, file_name: item.name, len: String(rawsize) } }

  const clientId = `nis:${Date.now()}-${crypto.randomBytes(4).toString('hex')}`
  const body = {
    msg: {
      from_user_id: '',
      to_user_id: toUserId,
      client_id: clientId,
      message_type: 2,   // BOT
      message_state: 2,  // FINISH
      item_list: [msgItem],
      context_token: contextToken || undefined,
    },
    base_info: buildBaseInfo(),
  }
  const raw = await postApi('ilink/bot/sendmessage', body, { token, timeoutMs: API_TIMEOUT_MS, label: 'sendMedia' })
  let resp: { ret?: number; errmsg?: string } = {}
  try { resp = JSON.parse(raw) } catch { /* 非 JSON 视为成功 */ }
  if (resp.ret && resp.ret !== 0) throw new Error(`sendMedia ret=${resp.ret} errmsg=${resp.errmsg || '(none)'}`)
  log(`已发送${kind === 'image' ? '图片' : kind === 'video' ? '视频' : '文件'} → ${toUserId.slice(0, 8)}（${rawsize} 字节）`)
}

/**
 * 上线通知 —— **必须调**：手机端 ClawBot 的「已连接」状态靠它。
 * ⚠️ 返回值要判定：token 无效时服务端返回 `errcode: -14`（session timeout）。
 * 尽早判定可省掉后续的 getupdates 轮询（实测：假 token 时 notifyStart 就会返回 -14）。
 */
async function notifyStart(token: string): Promise<{ ok: boolean; stale: boolean; errmsg: string }> {
  try {
    const raw = await postApi('ilink/bot/msg/notifystart', { base_info: buildBaseInfo() }, { token, timeoutMs: 10_000, label: 'notifyStart' })
    let resp: any = {}
    try { resp = JSON.parse(raw) } catch { /* 非 JSON 视为成功 */ }
    const errcode = Number(resp?.errcode ?? resp?.ret ?? 0)
    if (errcode !== 0) {
      log(`notifyStart 返回错误: errcode=${errcode} ${resp?.errmsg || ''}`)
      return { ok: false, stale: errcode === STALE_TOKEN_ERRCODE, errmsg: String(resp?.errmsg || `errcode=${errcode}`) }
    }
    log('notifyStart ok')
    return { ok: true, stale: false, errmsg: '' }
  } catch (e: any) {
    const m = String(e?.message || e).slice(0, 150)
    log(`notifyStart 失败（忽略）: ${m}`)
    return { ok: false, stale: false, errmsg: m }
  }
}

/** 下线通知（停止通道/退出进程时） */
async function notifyWechatStop(token: string): Promise<void> {
  try {
    await postApi('ilink/bot/msg/notifystop', { base_info: buildBaseInfo() }, { token, timeoutMs: 10_000, label: 'notifyStop' })
    log('notifyStop ok')
  } catch (e: any) {
    log(`notifyStop 失败（忽略）: ${String(e?.message || e).slice(0, 150)}`)
  }
}

/* ══════════════════ 同步游标持久化 ══════════════════ */

interface SyncShape { version: number; buf: Record<string, string> }
let syncCache: SyncShape | null = null

function loadSync(): SyncShape {
  if (syncCache) return syncCache
  try {
    if (fs.existsSync(SYNC_FILE)) {
      const raw = JSON.parse(fs.readFileSync(SYNC_FILE, 'utf-8'))
      if (raw && typeof raw === 'object' && raw.buf && typeof raw.buf === 'object') {
        syncCache = { version: 1, buf: raw.buf }
        return syncCache
      }
    }
  } catch (e) {
    console.warn('[wechatBot] 游标读取失败，回退空表:', e)
  }
  syncCache = { version: 1, buf: {} }
  return syncCache
}

function saveSyncBuf(accountKey: string, buf: string): void {
  const data = loadSync()
  data.buf[accountKey] = buf
  try {
    fs.mkdirSync(path.dirname(SYNC_FILE), { recursive: true })
    const tmp = SYNC_FILE + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8')
    fs.renameSync(tmp, SYNC_FILE)
  } catch (e) {
    console.error('[wechatBot] 游标落盘失败:', e)
  }
}

const loadSyncBuf = (accountKey: string): string => loadSync().buf[accountKey] || ''

/* ══════════════════ 连接与轮询循环 ══════════════════ */

interface WechatConn {
  botId: string
  accountId: string
  token: string
  abort: AbortController
  running: boolean
  startedAt: number
  lastEventAt: number
  lastError: string
  /** token 失效（需重新扫码）——停止轮询并标记 */
  stale: boolean
}

const conns = new Map<string, WechatConn>()

/** 已处理的 message_id 去重（重启后游标正常情况下不会重投，这里兜底） */
const seenMessageIds = new Set<string>()
const SEEN_MAX = 500

/** 交给 server.ts 的入站处理器（避免本模块依赖 server） */
interface WechatHandlers {
  onMessage: (botId: string, ev: {
    kind: 'c2c'
    messageId: string
    target: string
    content: string
    contextToken?: string
    timestamp: number
    /** 0912 二十一批：本条消息携带的图片（已解密落盘）→ 上层当附件喂给 agent（AI 能看图） */
    images?: InboundImage[]
    /** 图片下载失败原因（无图可发时上层回一句友好提示，而不是静默吞掉） */
    imageError?: string
  }) => void
  onStatus?: (botId: string, st: { connected: boolean; error?: string; stale?: boolean }) => void
}
let handlers: WechatHandlers | null = null
export function setWechatBotHandlers(h: WechatHandlers): void { handlers = h }

/** 从消息里抽纯文本（多 item 拼接） */
function extractText(msg: WechatMessage): string {
  const items = Array.isArray(msg.item_list) ? msg.item_list : []
  return items
    .filter(i => i?.type === 1 && i.text_item?.text)
    .map(i => String(i.text_item!.text))
    .join('')
    .trim()
}

/* ── 0912 二十一批：入站图片（CDN 加密下载 + 解密）─────────────
 * 微信图片走 CDN：image_item.media{ encrypt_query_param, aes_key }，密文 AES-128-ECB，
 * 解密后才是图片本体。移植自官方 openclaw-weixin（MIT，见 backend/_research_wx）。
 * 用户实测反馈「微信发图给 AI，AI 看不到」——就是这条链路此前完全没接。
 */

/** 官方 CDN 基址（服务端没下发 full_url 时兜底拼接） */
const CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c'

/** aes_key 两种编码：base64(16 字节原文) 或 base64(32 位 hex 字符串) */
function parseWechatAesKey(b64: string): Buffer | null {
  try {
    const decoded = Buffer.from(b64, 'base64')
    if (decoded.length === 16) return decoded
    if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString('ascii'))) {
      return Buffer.from(decoded.toString('ascii'), 'hex')
    }
  } catch { /* ignore */ }
  return null
}

/**
 * 微信 CDN 图片解密（导出以便单测）：密文 + aes_key(base64) → 明文。
 * aes_key 两种编码都支持（base64(16 字节原文) / base64(32 位 hex 字符串)）。
 * 失败返回 null（调用方回一句提示，不静默吞）。
 */
function decryptWechatImagePayload(cipher: Buffer, keyB64: string): Buffer | null {
  const key = parseWechatAesKey(keyB64)
  if (!key) return null
  try {
    const decipher = crypto.createDecipheriv('aes-128-ecb', key, null)
    return Buffer.concat([decipher.update(cipher), decipher.final()])
  } catch (e: any) {
    log(`图片解密失败：${String(e?.message || e).slice(0, 120)}`)
    return null
  }
}

/**
 * 下载并解密一张微信图片。
 * @returns { buf, mime }；失败返回 null（调用方回一句提示，不静默吞）
 */
async function downloadWechatImage(item: WechatItem, label: string): Promise<{ buf: Buffer; mime: string } | null> {
  const img = item?.image_item
  const media: WechatCdnMedia | undefined = img?.media
  const encParam = String(media?.encrypt_query_param || '').trim()
  const fullUrl = String(media?.full_url || '').trim()
  if (!encParam && !fullUrl) return null
  // image_item.aeskey 是 hex；media.aes_key 是 base64 —— 两种都要兜住
  const keyB64 = img?.aeskey ? Buffer.from(String(img.aeskey), 'hex').toString('base64') : String(media?.aes_key || '')
  const url = fullUrl || `${CDN_BASE_URL}/download?encrypted_query_param=${encodeURIComponent(encParam)}`
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), 20_000)
  try {
    const res = await fetch(url, { signal: ctl.signal })
    if (!res.ok) {
      log(`${label} 图片 CDN 下载失败 ${res.status}`)
      return null
    }
    const cipher = Buffer.from(await res.arrayBuffer())
    if (!cipher.length) return null
    let plain: Buffer = cipher
    if (keyB64) {
      const dec = decryptWechatImagePayload(cipher, keyB64)
      if (!dec) return null
      plain = Buffer.from(dec)
    }
    // mime 交给嗅探（微信不返回 content-type）
    return { buf: plain, mime: '' }
  } catch (e: any) {
    log(`${label} 图片下载异常：${String(e?.message || e).slice(0, 120)}`)
    return null
  } finally {
    clearTimeout(t)
  }
}

/** 抽本条消息里的图片项（可多张） */
function extractImageItems(msg: WechatMessage): WechatItem[] {
  const items = Array.isArray(msg.item_list) ? msg.item_list : []
  return items.filter(i => i?.type === 2 && i.image_item)
}

/**
 * 启动某微信机器人的长轮询。
 * @param bot { botId, accountId, token }
 */
export function startWechatBot(bot: { botId: string; accountId: string; token: string }): void {
  const { botId, accountId, token } = bot
  if (!token?.trim()) { log(`bot ${botId} 缺少 token，跳过启动`); return }
  const exist = conns.get(botId)
  if (exist?.running) { log(`bot ${botId} 已在运行，跳过`); return }
  stopWechatBot(botId, { notify: false })

  const conn: WechatConn = {
    botId, accountId, token: token.trim(),
    abort: new AbortController(),
    running: true,
    startedAt: Date.now(),
    lastEventAt: Date.now(),
    lastError: '',
    stale: false,
  }
  conns.set(botId, conn)
  log(`bot ${botId}（${accountId}）启动：notifyStart + getUpdates 长轮询`)

  void (async () => {
    // ① 上线通知（手机端据此显示「已连接」；token 无效时这里就能判定出来）
    const ns = await notifyStart(conn.token)
    if (ns.stale) {
      conn.stale = true
      conn.running = false
      conn.lastError = 'token 已失效，需重新扫码'
      log(`bot ${botId} token 已失效（notifyStart 判定）——请重新扫码连接`)
      handlers?.onStatus?.(botId, { connected: false, error: conn.lastError, stale: true })
      return
    }
    handlers?.onStatus?.(botId, { connected: true, error: ns.ok ? undefined : `上线通知异常（继续监听）: ${ns.errmsg}` })

    // ② 长轮询循环
    const accountKey = accountId || botId
    let buf = loadSyncBuf(accountKey)
    let nextTimeout = LONG_POLL_TIMEOUT_MS
    let failures = 0

    while (conn.running && !conn.abort.signal.aborted) {
      try {
        const resp = await getUpdates(conn.token, buf, nextTimeout, conn.abort.signal)
        if (!conn.running) break

        if (resp.longpolling_timeout_ms && resp.longpolling_timeout_ms > 0) {
          nextTimeout = resp.longpolling_timeout_ms
        }

        const isApiError = (resp.ret !== undefined && resp.ret !== 0) || (resp.errcode !== undefined && resp.errcode !== 0)
        if (isApiError) {
          const isStale = resp.errcode === STALE_TOKEN_ERRCODE || resp.ret === STALE_TOKEN_ERRCODE
          if (isStale) {
            conn.stale = true
            conn.lastError = 'token 已失效，需重新扫码'
            log(`bot ${botId} token 失效（${STALE_TOKEN_ERRCODE}）——请重新扫码连接`)
            handlers?.onStatus?.(botId, { connected: false, error: conn.lastError, stale: true })
            break
          }
          failures++
          conn.lastError = `getUpdates ret=${resp.ret} errcode=${resp.errcode} ${resp.errmsg || ''}`
          log(`bot ${botId} getUpdates 失败（${failures}/${MAX_CONSECUTIVE_FAILURES}）: ${conn.lastError}`)
          handlers?.onStatus?.(botId, { connected: false, error: conn.lastError })
          await sleep(failures >= MAX_CONSECUTIVE_FAILURES ? BACKOFF_MS : RETRY_MS, conn.abort.signal)
          if (failures >= MAX_CONSECUTIVE_FAILURES) failures = 0
          continue
        }

        failures = 0
        conn.lastEventAt = Date.now()
        conn.lastError = ''
        handlers?.onStatus?.(botId, { connected: true })

        if (resp.get_updates_buf) {
          buf = resp.get_updates_buf
          saveSyncBuf(accountKey, buf)
        }

        for (const msg of resp.msgs || []) {
          const from = String(msg.from_user_id || '')
          const content = extractText(msg)
          const imgItems = extractImageItems(msg)
          const mid = String(msg.message_id ?? '')
          // 0912 二十一批：纯图片消息不再丢（此前 !content 直接 continue → 用户发图石沉大海）
          if (!from || (!content && !imgItems.length)) continue
          // 去重（同 id 只处理一次）—— 必须同步做：图片是异步下载，放到下载后去重会漏掉重复投递
          const dedupKey = `${from}:${mid}`
          if (mid && seenMessageIds.has(dedupKey)) continue
          if (mid) {
            seenMessageIds.add(dedupKey)
            if (seenMessageIds.size > SEEN_MAX) {
              const first = seenMessageIds.values().next().value as string | undefined
              if (first) seenMessageIds.delete(first)
            }
          }
          conn.lastEventAt = Date.now()
          const evBase = {
            kind: 'c2c' as const,
            messageId: mid || `wx_${Date.now().toString(36)}`,
            target: from,
            content,
            contextToken: msg.context_token ? String(msg.context_token) : undefined,
            timestamp: Number(msg.create_time_ms) || Date.now(),
          }
          if (!imgItems.length) {
            log(`bot ${botId} 收到 c2c 消息 from=${from} text=${content.slice(0, 40)}`)
            handlers?.onMessage(botId, evBase)
            continue
          }
          // 有图：下载解密（异步）后再交出去 —— 下载期间轮询继续，不阻塞后续消息
          log(`bot ${botId} 收到 c2c 图片消息 from=${from}（${imgItems.length} 张，下载中…）`)
          void (async () => {
            const images: InboundImage[] = []
            let err = ''
            for (const it of imgItems.slice(0, 4)) {
              const got = await downloadWechatImage(it, `bot ${botId}`)
              if (!got) { err = err || '图片下载/解密失败'; continue }
              const saved = saveInboundImage('wechat', botId, got.buf, got.mime || undefined)
              if ('error' in saved) { err = err || saved.error; continue }
              images.push(saved)
            }
            handlers?.onMessage(botId, images.length ? { ...evBase, images } : { ...evBase, imageError: err || '图片下载失败' })
          })()
        }
      } catch (err: any) {
        if (!conn.running || conn.abort.signal.aborted) break
        failures++
        conn.lastError = String(err?.message || err).slice(0, 200)
        log(`bot ${botId} 轮询异常（${failures}/${MAX_CONSECUTIVE_FAILURES}）: ${conn.lastError}`)
        handlers?.onStatus?.(botId, { connected: false, error: conn.lastError })
        await sleep(failures >= MAX_CONSECUTIVE_FAILURES ? BACKOFF_MS : RETRY_MS, conn.abort.signal)
        if (failures >= MAX_CONSECUTIVE_FAILURES) failures = 0
      }
    }
    if (conn.running && !conn.stale) {
      conn.running = false
      log(`bot ${botId} 轮询已结束`)
    }
  })()
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => { clearTimeout(t); resolve() }, { once: true })
  })
}

/** 停止某微信机器人的轮询（默认同时发下线通知） */
export function stopWechatBot(botId: string, opts?: { notify?: boolean }): void {
  const conn = conns.get(botId)
  if (!conn) return
  conn.running = false
  try { conn.abort.abort() } catch { /* ignore */ }
  conns.delete(botId)
  if (opts?.notify !== false && conn.token) {
    void notifyWechatStop(conn.token).catch(() => { /* ignore */ })
  }
  log(`bot ${botId} 已停止`)
}

/** 停止全部（进程退出时；默认发下线通知 —— 手机端能立刻反映离线） */
export function stopAllWechatBots(opts?: { notify?: boolean }): void {
  for (const id of [...conns.keys()]) {
    try { stopWechatBot(id, { notify: opts?.notify !== false }) } catch { /* ignore */ }
  }
}

/** 当前微信连接状态（供 channel.status / 前端展示） */
export function wechatBotStatus(): Record<string, {
  connected: boolean; accountId: string; running: boolean
  lastEventAt: number; lastError: string; stale: boolean
}> {
  const out: Record<string, any> = {}
  for (const [id, c] of conns) {
    out[id] = {
      connected: c.running && !c.stale && !c.lastError,
      accountId: c.accountId,
      running: c.running,
      lastEventAt: c.lastEventAt,
      lastError: c.lastError,
      stale: c.stale,
    }
  }
  return out
}


