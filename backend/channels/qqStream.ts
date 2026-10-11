/**
 * QQ 私聊「流式消息」发送（★1014b）—— 官方 `stream_messages` 协议。
 *
 * 官方语义（口径来自 4 家已在真实 QQ 上验证的实现；见知识库 kb_5b3abae3b093）：
 *   POST {base}/v2/users/{openid}/stream_messages
 *   body = { input_mode:'replace', input_state:1|10, index, msg_seq, msg_id,
 *            content_type:'text'|'markdown', content_raw:<累计全文>, stream_msg_id? }
 *   · **replace 模式**：每帧携带"到目前为止的完整内容"，QQ 客户端把**同一条消息**替换刷新
 *     ⇒ 用户看到一条消息的字逐个长出来（打字机）。不是"转圈动画 + 一次性吐全文"。
 *   · **内容只能增长**：每帧必须是上一帧的超集；缩短或改写 → 404 / 40007。
 *   · 终帧 `input_state:10` 必须携带**完整且非空**的正文；否则客户端会退回第一帧的内容。
 *   · **首帧响应里的 `id`** = 后续帧要带的 `stream_msg_id`。
 *   · 仅**私聊（c2c）**有此接口；群聊/频道既无流式、也无"编辑已发消息"能力。
 *
 * ★★ 边界声明（与 channels/qqPanel.ts 同规矩，务必保持）★★
 *   · 只做"发一帧 HTTP"：**不广播、不注册事件监听、不碰任何会话/窗口路由**；
 *   · **不做重试、不做兜底** —— 失败原样上抛，由调用方（server.ts 的流式调度器）决定降级；
 *   · 只用异步 fetch，并只缓存 token（内存，官方 60s 级有效期）—— server.ts 是单进程单
 *     事件循环，同步阻塞会卡住整个后端。
 */

/** QQ 开放平台接口基址（与 qqBot.ts / qqPanel.ts 一致；这里独立定义，避免互相 import） */
const API_BASE = 'https://api.sgroup.qq.com'
const TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken'

/** 机器人凭据（由调用方从通道配置里取） */
interface QqStreamAuth {
  botId: string
  appId: string
  secret: string
}

/** token 缓存：官方返回 expires_in（秒），这里提前 60s 过期，避免边界上用到失效 token */
const tokenCache = new Map<string, { token: string; expiresAt: number }>()

async function getAccessToken(auth: QqStreamAuth): Promise<string> {
  const hit = tokenCache.get(auth.botId)
  if (hit && hit.expiresAt > Date.now()) return hit.token
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ appId: auth.appId, clientSecret: auth.secret }),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`取 QQ token 失败 ${res.status}: ${text.slice(0, 150)}`)
  let json: any = {}
  try { json = text ? JSON.parse(text) : {} } catch { json = {} }
  const token = String(json?.access_token || '')
  if (!token) throw new Error(`QQ token 响应里没有 access_token：${text.slice(0, 150)}`)
  const ttlSec = Number(json?.expires_in || 600)
  tokenCache.set(auth.botId, { token, expiresAt: Date.now() + Math.max(60, ttlSec - 60) * 1000 })
  return token
}

/** 单帧正文上限（与 server.ts 的 deliverToChannel 4000 口径一致） */
export const QQ_STREAM_MAX_CHARS = 4000

/**
 * **单调护栏**（流式的安全命门）：新文本必须是"已推送文本"的**超集**才允许推送。
 *
 * 官方规则：流式内容**只能增长**，缩短或改写会返回 404 / 40007（平台直接拒收）。
 * 拼接口径的抖动（段落 trim、去重）会造成"新文本不是旧文本前缀" —— 这种帧一律**本地丢掉**：
 * 宁可少推一帧，也绝不发平台必然拒绝的帧。
 */
export function shouldPushFrame(sent: string, next: string): boolean {
  if (!next) return false
  if (!sent) return true
  return next.length > sent.length && next.startsWith(sent)
}

/** 单帧截断（与既有一次性回推同口径：超长截断并注明） */
export function clipStreamText(text: string, max = QQ_STREAM_MAX_CHARS): string {
  return text.length > max ? text.slice(0, max) + '\n…（内容过长已截断）' : text
}

interface QqStreamFrameOptions {
  /** 私聊对方的 openid */
  openid: string
  /** 入站消息 id（被动回复锚点；流式帧不吃被动回复次数，但必须带） */
  msgId: string
  /** 累计全文（replace 模式：每帧都是"到目前为止的完整内容"） */
  text: string
  /** 本流内的帧序号（首帧 0，逐帧 +1） */
  index: number
  /** 本流固定的 msg_seq（同一 msg_id 下与普通消息避免撞号，创建流时取一次） */
  msgSeq: number
  /** 1 = 生成中，10 = 结束（终帧必须带完整非空正文） */
  inputState: 1 | 10
  /** 首帧响应里拿到的 id；后续帧必须原样带上 */
  streamMsgId?: string
  /** 正文类型（NIS 现有回推是纯文本，默认 text） */
  contentType?: 'text' | 'markdown'
}

/**
 * 发送一帧流式内容。
 * @returns `{ streamMsgId }` —— 首帧返回平台生成的 id（= 后续帧的 stream_msg_id）；
 *          后续帧通常也回 id，但调用方**只信任首帧**（后续帧缺失不报错）。
 */
export async function sendQqStreamFrame(
  auth: QqStreamAuth,
  opts: QqStreamFrameOptions,
): Promise<{ streamMsgId: string }> {
  const token = await getAccessToken(auth)
  const body: Record<string, unknown> = {
    input_mode: 'replace',          // 官方语义：每帧替换为"累计全文"（append 会因丢帧永久缺字）
    input_state: opts.inputState,
    index: opts.index,
    msg_seq: opts.msgSeq,
    msg_id: opts.msgId,
    content_type: opts.contentType || 'text',
    content_raw: opts.text,
  }
  if (opts.streamMsgId) body.stream_msg_id = opts.streamMsgId

  const url = `${API_BASE}/v2/users/${encodeURIComponent(opts.openid)}/stream_messages`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Authorization: `QQBot ${token}`,
      'X-Union-Appid': auth.appId,
    },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`stream_messages ${res.status}: ${text.slice(0, 200)}`)
  let json: any = {}
  try { json = text ? JSON.parse(text) : {} } catch { json = {} }
  // 平台把流 id 放在顶层 id（部分响应会包一层 data）
  const id = String(json?.id || json?.data?.id || '')
  return { streamMsgId: id }
}
