/**
 * QQ 机器人通道 —— 官方 Bot API（WebSocket 长连接）
 *
 * 背景：用户在 q.qq.com 创建机器人并填了 AppID/AppSecret 后，QQ 客户端发消息会提示
 *   「该机器人未连接服务」—— 因为**没有任何客户端连接 QQ 网关**。QQ 服务端以「是否有活跃
 *   WS 连接」判定机器人是否在线，光有配置是不够的，本模块负责真正连上。
 *
 * 协议（官方文档 bot.qq.com/wiki/develop/api-v2/）：
 *   ① POST https://bots.qq.com/app/getAppAccessToken  { appId, clientSecret }
 *      → { access_token, expires_in }
 *   ② GET  {base}/gateway   Header: Authorization: QQBot {token}
 *      → { url: "wss://..." }        正式 api.sgroup.qq.com / 沙箱 sandbox.api.sgroup.qq.com
 *   ③ WS 连接，Header: Authorization: QQBot {token} + X-Union-Appid: {appId}
 *   ④ 收 op=10 Hello { heartbeat_interval } → 回 op=2 Identify { token, intents, shard:[0,1] }
 *   ⑤ 收 op=0 READY → 上线成功
 *   ⑥ 收 op=0 事件：C2C_MESSAGE_CREATE(私聊) / GROUP_AT_MESSAGE_CREATE(群@) / AT_MESSAGE_CREATE(频道)
 *   ⑦ 回推：POST {base}/v2/users/{openid}/messages （需 msg_seq 递增 + msg_id 回执）
 *
 * 设计约束（对齐 docs/通道接入设计-前端与上下文-0912.md）：
 *   - 通道会话 = 普通会话：按 channelKey 映射到 sessionId，PC 上可继续聊
 *   - 被动回复窗口：私聊 60 分钟 / 每条消息最多回 5 次 → 长任务「先回执、后汇报」
 *   - 游标/去重：按 message_id 去重，防重复投递
 *   - 命令：走 channelCommands 的解析层（/new /list /switch /status /stop /help）
 */
import WebSocket from 'ws'
import { getChannel } from '../channelsStore.ts'

import { extractQqImages, fetchQqImages, downloadBinary, saveInboundImage, saveInboundFile, INBOUND_FILE_MAX_BYTES, INBOUND_IMAGE_MAX_BYTES, type InboundImage } from './imageIntake.ts'
import fs from 'node:fs'
import path from 'node:path'
import { DATA_ROOT } from '../paths.ts'
import { listMembers } from './memberDirectory.ts'

const TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken'
/** 正式环境网关；沙箱用 sandbox.api.sgroup.qq.com（当前走正式，沙箱可后续做成开关） */
const API_BASE = 'https://api.sgroup.qq.com'
/** intents：C2C 私信 + 群 @ + 频道 @（1<<25 = 群/私聊事件；见官方 Intents 文档） */
/**
 * intents：`1<<25` = 群/私聊消息事件；`1<<30` = 原有；**`1<<26` = INTERACTION（交互事件）**。
 * ★1016e：`1<<26` 是**消息按钮点击**的前提 —— 官方「互动事件」页明写 `Intent INTERACTION (1<<26)`。
 * 不加它平台**根本不推** `INTERACTION_CREATE` ⇒ 用户点按钮后客户端一直 loading，最后弹「请求第三方失败」。
 */
const INTENTS = (1 << 25) | (1 << 30) | (1 << 26)

interface QqMessageEvent {
  kind: 'c2c' | 'group' | 'channel'
  messageId: string
  /**
   * ★1016e：**事件被动回复**用的事件 id（与 messageId/msg_id 二选一）。
   * 按钮点击（INTERACTION_CREATE）就靠它回消息 —— 官方口径：「`id` 用于被动消息发送和互动回调」。
   */
  eventId?: string
  /** 回复目标：c2c=openid / group=group_openid / channel=channel_id */
  target: string
  content: string
  /** 频道消息另需 msg_id（频道 API 与群/私聊 API 不同） */
  channelMsgId?: string
  timestamp: number
  /**
   * 发送者标识（0912 十四批）——
   *   群聊 = `author.member_openid`（**群内**唯一，同一 QQ 号在不同群里不同）
   *   单聊 = `author.user_openid`
   * 之前整个字段被丢掉 → AI 完全不知道谁在说话，多人群里也分不清人。
   */
  senderId?: string
  /** 发送者昵称（`author.username`，平台较新版本才下发，可能为空） */
  senderName?: string
  /** 群内角色：member / admin / owner */
  senderRole?: string
  /** 这条消息里 @ 了谁（不含 @机器人 自身）—— 平台在群聊事件里下发 */
  mentions?: Array<{ id?: string; name?: string }>
  /** 0913 串台修复：全量消息里「@ 的是**别的机器人**」—— 不回复（只记背景）；插嘴仍按配置照常（用户拍板：提到它就搭腔"挺有意思"，保留） */
  mentionsOtherBot?: boolean
  /**
   * 0912 二十二批：**富媒体附件**（官方 `attachments[]`）——
   * 实测/文档：QQ 图片**不在 content 的 `<image>` 标签里**，而是走 attachments：
   *   { url(预签名下载地址), filename, content_type: image/jpeg|image/png|image/gif|video/mp4|voice|file, size, width, height }
   * 之前只认 content 标签 → 私聊发图整条被丢（用户实测「他直接不理我」）。
   */
  attachments?: QqAttachment[]
  /**
   * 这条消息携带的图片（已下载落盘）——
   * content 里的 `<image url>` 标签与 attachments[] 两条来源都会收进来，上层当附件喂给 agent（AI 能看图）。
   */
  images?: InboundImage[]
  /** 图片下载失败时的原因（无图可发时上层回一句友好提示，而不是静默吞掉） */
  imageError?: string
  /** 本条消息携带的**文件**（已下载落盘；非图片/视频/语音）—— 让 AI 能读用户发来的文件 */
  files?: Array<{ path: string; name: string; mime: string; bytes: number }>
}

/** 官方富媒体附件（attachments[]） */
interface QqAttachment {
  url?: string
  filename?: string
  content_type?: string
  size?: number
  width?: number
  height?: number
  voice_wav_url?: string
  asr_refer_text?: string
}

interface QqBotHandlers {
  /** 收到用户消息 → 交给上层（转 NIS session.prompt） */
  onMessage: (botId: string, ev: QqMessageEvent) => void
  /**
   * 旁听到的**群内全量消息**（0912 十五批）—— 只在群主把群设置改成
   * 「机器人可获取的群聊消息范围 = 获取群内全部消息」后才会推送。
   * ⚠️ 这类消息**不触发回复**（否则机器人会对群里每句话插嘴），只作为背景流水。
   */
  onGroupMessage?: (botId: string, ev: QqMessageEvent) => void
  /**
   * 机器人**被拉进群**（0912 十六批）—— 事件 `GROUP_ADD_ROBOT`。
   *
   * 为什么要处理：在此之前，被拉进群不会产生任何反应 —— 没人 @ 它就不会有会话，
   * 用户在 PC 端看不到这个群，容易误以为「几个群合并了 / 没生效」（用户实测提出过）。
   * 现在收到即主动打招呼（用 event_id 走**事件被动回复**，不占主动消息额度）。
   */
  onGroupAdded?: (botId: string, ev: { groupOpenid: string; operatorId?: string; eventId?: string; timestamp: number }) => void
  /** 状态变化（连接/断开/错误）—— 供前端展示 */
  onStatus?: (botId: string, status: { connected: boolean; error?: string; nickname?: string }) => void
}

interface BotConn {
  botId: string
  appId: string
  secret: string
  ws: WebSocket | null
  heartbeatTimer: NodeJS.Timeout | null
  /** 心跳序列号（每次发送 +1，服务端校验） */
  seq: number
  token: string
  tokenExpireAt: number
  /** 重连退避计数 */
  retries: number
  stopped: boolean
  connected: boolean
  /** 机器人自己的昵称（READY 事件下发）—— 提示词里告诉 AI「你叫什么」用 */
  nickname: string
  /** 回复用的 msg_seq 计数器（QQ 要求同一 msg_id 下逐条递增，防重复） */
  msgSeq: Map<string, number>
  /** 已处理的 msg_id（官方明确「相同 msg_id 可能重复推送」，按 id 去重防重复回复） */
  seenMsgIds: Set<string>
  /** 全量群消息的去重集（**独立**于 seenMsgIds：一条消息可能同时触发 @ 事件与全量事件，
   *  共用一个集会互相顶掉 —— 那是"漏回复"级别的 bug，不能混） */
  seenGroupMsgIds: Set<string>
  /** 是否已经打过一次「事件字段」诊断日志（每台机器人一次，用于确认平台实际下发了哪些字段） */
  dumpOnce?: boolean
  /** 是否已打过一次「富消息（@/附件）」诊断（二十二批：全量模式下判断 @ 我的依据） */
  dumpRichOnce?: boolean
}

const conns = new Map<string, BotConn>()
let handlers: QqBotHandlers | null = null

function log(...args: any[]) {
  console.log('[qqBot]', ...args)
}

/* ── Token ─────────────────────────────────────────────── */

async function fetchAccessToken(appId: string, secret: string): Promise<{ token: string; expiresIn: number }> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ appId, clientSecret: secret }),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`getAppAccessToken ${res.status}: ${text.slice(0, 200)}`)
  const j = JSON.parse(text)
  if (!j?.access_token) throw new Error(`getAppAccessToken 无 access_token: ${text.slice(0, 200)}`)
  return { token: j.access_token, expiresIn: Number(j.expires_in) || 7200 }
}

/** 取 token（带缓存，提前 60s 过期重取） */
async function ensureToken(c: BotConn): Promise<string> {
  if (c.token && Date.now() < c.tokenExpireAt - 60_000) return c.token
  const { token, expiresIn } = await fetchAccessToken(c.appId, c.secret)
  c.token = token
  c.tokenExpireAt = Date.now() + expiresIn * 1000
  return token
}

/* ── 网关与连接 ─────────────────────────────────────────── */

async function fetchGateway(token: string): Promise<string> {
  const res = await fetch(`${API_BASE}/gateway`, { headers: { Authorization: `QQBot ${token}` } })
  const text = await res.text()
  if (!res.ok) throw new Error(`getGateway ${res.status}: ${text.slice(0, 200)}`)
  const j = JSON.parse(text)
  if (!j?.url) throw new Error(`getGateway 无 url: ${text.slice(0, 200)}`)
  return j.url
}

function clearTimers(c: BotConn) {
  if (c.heartbeatTimer) { clearInterval(c.heartbeatTimer); c.heartbeatTimer = null }
}

function scheduleReconnect(c: BotConn) {
  if (c.stopped) return
  c.retries += 1
  // 退避：1s,2s,4s... 上限 60s（避免频繁重连被风控）
  const delay = Math.min(1000 * 2 ** Math.min(c.retries - 1, 6), 60_000)
  log(`bot ${c.botId} 将在 ${delay}ms 后重连（第 ${c.retries} 次）`)
  setTimeout(() => { if (!c.stopped) void connect(c) }, delay)
}

async function connect(c: BotConn): Promise<void> {
  if (c.stopped) return
  try {
    const token = await ensureToken(c)
    const url = await fetchGateway(token)
    log(`bot ${c.botId} 连接网关 ${url}`)

    const ws = new WebSocket(url, {
      headers: {
        Authorization: `QQBot ${token}`,
        'X-Union-Appid': c.appId,
      },
    })
    c.ws = ws

    ws.on('open', () => log(`bot ${c.botId} WS 已建立，等待 Hello`))

    ws.on('message', (raw) => {
      let pkt: any
      try { pkt = JSON.parse(raw.toString()) } catch { return }
      void handlePacket(c, pkt, token)
    })

    ws.on('error', (err: any) => {
      log(`bot ${c.botId} WS 错误: ${err?.message || err}`)
      handlers?.onStatus?.(c.botId, { connected: false, error: String(err?.message || err).slice(0, 200) })
    })

    ws.on('close', (code: number) => {
      clearTimers(c)
      c.connected = false
      handlers?.onStatus?.(c.botId, { connected: false, error: `连接关闭 (${code})` })
      if (!c.stopped) {
        log(`bot ${c.botId} WS 关闭 code=${code}，准备重连`)
        scheduleReconnect(c)
      }
    })
  } catch (e: any) {
    const msg = String(e?.message || e).slice(0, 300)
    log(`bot ${c.botId} 连接失败: ${msg}`)
    handlers?.onStatus?.(c.botId, { connected: false, error: msg })
    scheduleReconnect(c)
  }
}

async function handlePacket(c: BotConn, pkt: any, token: string) {
  const op = pkt?.op
  // op=10 Hello：拿到心跳间隔 → Identify 鉴权
  if (op === 10) {
    const interval = Number(pkt?.d?.heartbeat_interval) || 45000
    sendIdentify(c, token)
    startHeartbeat(c, interval)
    return
  }
  // op=11 心跳 ACK
  if (op === 11) return
  // op=7 服务端要求重连 / op=9 会话失效（invalid session）→ 关闭走统一退避重连。
  // （不处理的风险：平台发了信号而连接又没断 → 机器人「在线但收不到消息」。）
  if (op === 7 || op === 9) {
    log(`bot ${c.botId} 网关信号 op=${op}（${op === 7 ? '要求重连' : '会话失效'}）→ 重新连接`)
    if (op === 9) c.retries = 0
    try { c.ws?.close() } catch { /* ignore */ }
    return
  }
  // op=0 Dispatch
  if (op === 0) {
    const t = String(pkt?.t || '')
    const d = pkt?.d || {}
    if (t === 'READY') {
      c.connected = true
      c.retries = 0
      const nickname = d?.user?.username || ''
      c.nickname = nickname
      log(`✅ bot ${c.botId} 已上线（${nickname || '未知昵称'}）`)
      handlers?.onStatus?.(c.botId, { connected: true, nickname })
      return
    }
    /**
     * ★1016：消息按钮被点击（`INTERACTION_CREATE`）。
     * 官方要求：收到后**3 秒内**调 `PUT /interactions/{interaction_id}` 应答，否则用户侧看不到反馈。
     * 做法：① 立刻 PUT 一个"收到"（不阻塞后续）；② 把按钮的 `data`（我们放的就是命令文本）
     *       当**一条普通消息**交给上层 ⇒ 复用现有命令链路，零新机制。
     * ⚠️ target / msg_id 都从事件里尽力取；**取不到就只记日志**（不猜、不假装成功）。
     */
    if (t === 'INTERACTION_CREATE') {
      const r = d?.data?.resolved || {}
      const iid = String(d?.id || '').trim()
      const cmd = String(r.button_data ?? d?.data?.button_data ?? '').trim()
      /**
       * ★1020：**群聊按钮的 peer 必须是 `group_openid`**（与 `GROUP_AT_MESSAGE_CREATE` 的
       * `target: d.group_openid` 对齐，见下方那个分支），否则算出来的 `channelKey` 和普通群消息
       * 不是同一个 → 映射查不到 → **每点一次按钮就"新建一个会话"**（现象：对话跳走、权限回默认、上下文断）。
       * 历史：这里一律取 `r.user_id`（点按钮的人）当 peer，群场景必然落到"成员 openid" ⇒ 必错。
       * 兜底：万一平台没给 group_openid，退回老行为（用成员 id）并**明确打日志**，不假装成功。
       */
      const isGroup = !!(d?.scene === 'group' || d?.group_openid || r?.group_openid)
      const groupOpenid = String(r?.group_openid || d?.group_openid || d?.data?.group_openid || '').trim()
      const uid = String(r.user_id || d?.user_openid || '').trim()
      const peer = isGroup ? (groupOpenid || uid) : (uid || groupOpenid)
      log(`bot ${c.botId} 按钮交互：data=${cmd || '(空)'} scene=${isGroup ? 'group' : 'c2c'} peer=${peer.slice(0, 8)} user=${uid.slice(0, 8)} iid=${iid.slice(0, 12)}`)
      if (isGroup && !groupOpenid) {
        log(`bot ${c.botId} ⚠️ 群聊按钮事件未带 group_openid，peer 兜底用成员 id=${uid.slice(0, 8)}（可能落到新会话）`)
      }
      // ① 3 秒内应答（失败只记日志：应答失败不该拖垮命令处理）
      if (iid) {
        void qqApi(c.botId, `${API_BASE}/interactions/${iid}`, { code: 0 }, 'interactionAck', 'PUT')
          .catch(e => log(`bot ${c.botId} 按钮应答失败：${String(e?.message || e).slice(0, 200)}`))
      }
      // ② 当命令跑（拿不到命令或 peer 就到此为止 —— 如实留日志，不瞎猜）
      if (cmd && peer) {
        emitMessage(c, {
          kind: (isGroup ? 'group' : 'c2c') as 'c2c' | 'group',
          /**
           * ★1016e：回消息要用**事件 id（event_id）**，不是 msg_id —— 官方「互动事件」页明写
           * 「`id` 事件 ID，用于被动消息发送和互动回调」，而 msg_id 只对 MESSAGE_CREATE 那类有效。
           */
          messageId: '',
          eventId: String(d?.id || ''),
          target: peer,
          content: cmd,
          timestamp: Number(d?.timestamp) || Date.now(),
          senderId: uid || peer,
          senderName: '',
        })
      }
      return
    }

    if (t === 'C2C_MESSAGE_CREATE') {
      const a = d?.author || {}
      emitMessage(c, {
        kind: 'c2c',
        messageId: String(d.id || ''),
        target: String(a.user_openid || ''),
        content: String(d.content || '').trim(),
        timestamp: Number(d.timestamp) || Date.now(),
        senderId: String(a.user_openid || a.id || '').trim() || undefined,
        senderName: String(a.username || '').trim() || undefined,
        mentions: parseMentions(d.mentions),
        // 二十二批：私聊图片/文件走 attachments（此前完全没读 → 发图被静默丢弃）
        attachments: parseAttachments(d.attachments),
      })
      return
    }
    if (t === 'GROUP_ADD_ROBOT') {
      const ev = {
        groupOpenid: String(d?.group_openid || ''),
        operatorId: String(d?.op_member_openid || d?.op_member_openid_list?.[0] || '') || undefined,
        eventId: String(d?.id || pkt?.id || '') || undefined,
        timestamp: Number(d?.timestamp) || Date.now(),
      }
      log(`bot ${c.botId} 被拉进群 group=${ev.groupOpenid.slice(0, 10)} by=${(ev.operatorId || '?').slice(0, 8)}`)
      handlers?.onGroupAdded?.(c.botId, ev)
      return
    }
    if (t === 'GROUP_AT_MESSAGE_CREATE') {
      const a = d?.author || {}
      dumpRichGroupEventOnce(c, d)
      // 平台通常已去掉 @机器人 前缀；没去掉（或还有别的 <@…> 开头）也统一剥一层
      const atRaw = String(d.content || '').trim()
      const atMentions = parseMentions(d.mentions)
      // 0913：AT 事件 = 注定就是「@ 本 bot」→ 顺手学习**自身 openid**（多机器人同群仅名字核对过才采信）
      learnSelfIdFromAtEvent(c, d?.mentions, atRaw)
      emitMessage(c, {
        kind: 'group',
        messageId: String(d.id || ''),
        target: String(d?.group_openid || ''),
        // 0913：行首剥离后，再清洗中段/尾部的 `<@id>`（→ `@昵称`，不再透出乱码）
        content: sanitizeMentionCodes(stripLeadingMentions(atRaw) || atRaw, c, String(d?.group_openid || ''), atMentions),
        timestamp: Number(d.timestamp) || Date.now(),
        // 发送者：群聊用 member_openid（群内唯一）；老版本字段叫 id，一并兜住
        senderId: String(a.member_openid || a.id || '').trim() || undefined,
        senderName: String(a.username || '').trim() || undefined,
        senderRole: String(a.member_role || '').trim() || undefined,
        mentions: atMentions,
        attachments: parseAttachments(d.attachments),
      })
      return
    }
    if (t === 'AT_MESSAGE_CREATE') {
      const a = d?.author || {}
      emitMessage(c, {
        kind: 'channel',
        messageId: String(d.id || ''),
        target: String(d.channel_id || ''),
        channelMsgId: String(d.id || ''),
        content: String(d.content || '').trim(),
        timestamp: Number(d.timestamp) || Date.now(),
        senderId: String(a.id || '').trim() || undefined,
        senderName: String(a.username || '').trim() || undefined,
        mentions: parseMentions(d.mentions),
        attachments: parseAttachments(d.attachments),
      })
      return
    }
    if (t === 'GROUP_MESSAGE_CREATE') {
      /**
       * 群**全量**消息（不限于 @机器人）—— 需要群主在群设置里开
       * 「机器人可获取的群聊消息范围 = 获取群内全部消息」。
       *
       * 处理方式：**默认只记流水、不回复**；但二十二批修了一个关键坑：
       * 开全量后 @机器人的消息也走这个事件（实测没有 GROUP_AT_MESSAGE_CREATE），
       * 早期一律当背景 → 群里 @ 它完全不理（用户实测「群聊它不回复」）。
       * 现在：**@ 了机器人 → 走正常回复链路**（用本条 id 被动回复），其余仅记背景。
       *
       * 二十三批两个补丁：
       *   ① 正文里平台会保留「@机器人」原文（<@xxxx>）→ 剥掉开头 @ 标记（命令/提示词用干净正文）；
       *   ② @ 判定升级为「mentions 精确 → 已学自身 id → 成员表排除法」（不会帮别人的 @ 接话）。
       */
      const a = d?.author || {}
      if (a.bot) return   // 其他机器人发的跳过
      const fullRaw = String(d.content || '').trim()
      const gmMentions = parseMentions(d.mentions)
      const ev: QqMessageEvent = {
        kind: 'group',
        messageId: String(d.id || ''),
        target: String(d?.group_openid || ''),
        // 0913：行首剥离后，再清洗中段/尾部的 `<@id>`（→ `@昵称`；「@我」判定用的是原始 d.content，不受影响）
        content: sanitizeMentionCodes(stripLeadingMentions(fullRaw) || fullRaw, c, String(d?.group_openid || ''), gmMentions),
        timestamp: Number(d.timestamp) || Date.now(),
        senderId: String(a.member_openid || a.id || '').trim() || undefined,
        senderName: String(a.username || '').trim() || undefined,
        senderRole: String(a.member_role || '').trim() || undefined,
        mentions: gmMentions,
        attachments: parseAttachments(d.attachments),
      }
      if (d?.mentions || d?.attachments) dumpRichGroupEventOnce(c, d)
      // 0913 串台修复：多机器人同群时「mentions 有 bot:true」≠「@的是我」——
      // 逐条核对（已学 id / 平台昵称 / notMine 排除表）；名字明确是别的机器人 → 不回复、不插嘴。
      const dir = classifyGroupDirected(c, d)
      if (dir.self) {
        log(`bot ${c.botId} 全量模式里识别到「@我」 → 按 @ 消息回复（group=${ev.target.slice(0, 10)}）`)
        emitMessage(c, ev)
        return
      }
      if (dir.otherBot) log(`bot ${c.botId} 全量消息 @ 的是别的机器人 → 仅记背景（不主答；插嘴照常按配置）`)
      emitGroupBackground(c, dir.otherBot ? { ...ev, mentionsOtherBot: true } : ev)
      return
    }
  }
}

function sendIdentify(c: BotConn, token: string) {
  c.ws?.send(JSON.stringify({
    op: 2,
    d: {
      token: `QQBot ${token}`,
      intents: INTENTS,
      shard: [0, 1],
      properties: { $os: process.platform, $browser: 'nis', $device: 'nis' },
    },
  }))
}

function startHeartbeat(c: BotConn, intervalMs: number) {
  clearTimers(c)
  c.heartbeatTimer = setInterval(() => {
    if (c.ws?.readyState !== WebSocket.OPEN) return
    c.seq += 1
    try { c.ws.send(JSON.stringify({ op: 1, d: c.seq })) } catch { /* 发送失败等 close 重连 */ }
  }, Math.max(5000, intervalMs))
}

/**
 * 解析消息里 @ 到的用户列表（不含 @机器人 自身；平台只给 id / username，可能为空）。
 * 用途：让 AI 知道「这条消息是在 @ 谁」—— 它自己也能 @ 人（正文直接写「@昵称」），这里让它看懂群友在点谁的名。
 */
function parseMentions(input: any): Array<{ id?: string; name?: string }> | undefined {
  if (!Array.isArray(input) || !input.length) return undefined
  const out = input.slice(0, 10)
    .map((m: any) => ({
      id: String(m?.id || m?.member_openid || '').trim() || undefined,
      name: String(m?.username || '').trim() || undefined,
    }))
    .filter(m => m.id || m.name)
  return out.length ? out : undefined
}

/**
 * 每台机器人第一次收到群聊消息时打一份字段诊断 ——
 * 平台对 `author.username` / `member_role` / `mentions` 是**灰度下发**，
 * 打一份就知道这台机器人实际能拿到哪些字段（排查「AI 不知道谁在说话」全靠它）。
 */
/**
 * 解析官方富媒体附件（`attachments[]`）—— 只保留有下载地址的项。
 * 形态：{ url, filename, content_type(image/jpeg|image/png|image/gif|video/mp4|voice|file), size, width, height }
 */
function parseAttachments(input: any): QqAttachment[] | undefined {
  if (!Array.isArray(input) || !input.length) return undefined
  const out = input.slice(0, 9).map((a: any) => ({
    url: String(a?.url || '').trim() || undefined,
    filename: String(a?.filename || '').trim() || undefined,
    content_type: String(a?.content_type || '').trim() || undefined,
    size: Number(a?.size) || undefined,
    width: Number(a?.width) || undefined,
    height: Number(a?.height) || undefined,
    voice_wav_url: typeof a?.voice_wav_url === 'string' ? a.voice_wav_url : undefined,
    asr_refer_text: typeof a?.asr_refer_text === 'string' ? a.asr_refer_text : undefined,
  })).filter(a => a.url || a.content_type)
  return out.length ? out : undefined
}

/** 从正文里抠出所有 `<@xxxx>` 提及 id（全量模式平台不保证下发 mentions，正文是主要依据） */
function extractMentionIds(content: string): string[] {
  const out: string[] = []
  const re = /<@!?([A-Za-z0-9_=-]{4,})>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(String(content || '')))) {
    if (!out.includes(m[1])) out.push(m[1])
  }
  return out
}

/**
 * 平台会**保留**「@机器人」原文（形如 `<@xxxx> 说句话`）在正文里 ——
 * 这个标记对命令识别（/new）和提示词都是噪音 → 剥掉开头的 @ 标记（可能连续多个）。
 * 剥完为空则返回空串，调用方自行兜底。
 */
function stripLeadingMentions(s: string): string {
  let t = String(s || '')
  for (let i = 0; i < 4; i++) {
    const n = t.replace(/^[\s\u00a0]*(?:<@!?[A-Za-z0-9_=-]{4,}>[\s\u00a0]*)+/, '')
    if (n === t) break
    t = n
  }
  return t.trim()
}

/**
 * 入站正文里的 `<@id>` 清洗（0913 反馈批② —— 「ai 的艾特还是乱码」根因）。
 *
 * 平台把「@某人」在**下行正文**里编码成 `<@id>`（32 位 openid）。只在**行首**的会被
 * `stripLeadingMentions` 剥掉；**中段/尾部**的一直原样投射到 NIS 界面（引用块/背景流水）
 * 和 AI 上下文 —— 用户截图里「看不见这是好事啊<@9164D2F2…>」就是这么来的。
 * 规则：@机器人自身 → `@<机器人昵称>`；成员目录命中 → `@<目录标签>`；本条 mentions 带名字 → `@<名字>`；
 * 都不认识 → `@某人`（不再透出裸 id 乱码）。
 *
 * ⚠️ 必须在 @ 判定（botMentionVerdict / selfMentionByContent，基于**原始**正文与 mentions）**之后**调用 ——
 * 否则会把「这条在 @ 我」的判定依据洗掉，机器人就不回话了。
 */
function sanitizeMentionCodes(
  text: string,
  c: BotConn,
  groupId: string,
  mentions?: Array<{ id?: string; name?: string }>,
): string {
  const raw = String(text || '')
  if (!raw.includes('<@')) return raw
  const selfId = groupId ? trustedSelfIdFor(c.botId, groupId) : ''   // 0913：只用「核对过」的自身 id（防污染值把别人的 @ 误标成 @我）
  const selfName = String(c.nickname || '').trim()
  const nameById = new Map<string, string>()
  for (const m of mentions || []) {
    const id = String(m?.id || '').trim()
    const name = String(m?.name || '').trim()
    if (id && name) nameById.set(id, name)
  }
  let roster: Array<{ id: string; label: string }> = []
  try { roster = listMembers('qq', groupId, 200).map(x => ({ id: x.id, label: x.label })) } catch { /* ignore */ }
  return raw.replace(/<@!?([A-Za-z0-9_=-]{4,})>/g, (_full, id: string) => {
    if (selfId && id === selfId) return `@${selfName || '机器人'}`
    const byDir = roster.find(x => x.id === id)
    if (byDir?.label) return `@${byDir.label}`
    const byMention = nameById.get(id)
    if (byMention) return `@${byMention}`
    return '@某人'
  })
}

/* ── 机器人自身 openid 学习（二十三批）────────────────────────
 * 全量模式下判「这条在 @ 我」只能靠正文 `<@xxxx>` —— 但它也可能是在 @ 别的群友。
 * 三级策略：
 *   ① mentions 里 bot:true（平台下发时，最可靠）→ 直接学成自身 id；
 *   ② 已学到 → 正文含 <@自身id> 才算 @ 我（精确，不会帮别人接话）；
 *   ③ 没学到 → 用群成员表排除「已知群友」，剩下的未知名视为 @ 我；
 *      同一群里命中 ≥3 次且候选唯一 → 学成该群的自身 id（此后走 ②）。
 */
const SELF_ID_FILE = path.join(DATA_ROOT, 'channels', 'bot-self-ids.json')
interface SelfIdPeer { selfId?: string; cand?: Record<string, number>; notMine?: Record<string, number>; selfIdVerified?: boolean }
interface SelfIdStore { version: number; bots: Record<string, { selfId?: string; selfIdVerified?: boolean; peers?: Record<string, SelfIdPeer> }> }
let selfIdCache: SelfIdStore | null = null
function loadSelfIds(): SelfIdStore {
  if (selfIdCache) return selfIdCache
  try {
    if (fs.existsSync(SELF_ID_FILE)) {
      const raw = JSON.parse(fs.readFileSync(SELF_ID_FILE, 'utf-8'))
      if (raw && typeof raw === 'object' && raw.bots) {
        selfIdCache = { version: 1, bots: raw.bots }
        return selfIdCache
      }
    }
  } catch (e) { console.warn('[qqBot] bot-self-ids 读取失败:', e) }
  selfIdCache = { version: 1, bots: {} }
  return selfIdCache
}
function persistSelfIds(): void {
  const d = loadSelfIds()
  try {
    fs.mkdirSync(path.dirname(SELF_ID_FILE), { recursive: true })
    const tmp = SELF_ID_FILE + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(d, null, 2), 'utf-8')
    fs.renameSync(tmp, SELF_ID_FILE)
  } catch (e) { console.error('[qqBot] bot-self-ids 落盘失败:', e) }
}

/**
 * 0913 串台修复：**可信的**自身 openid —— 只有被验证过来源（名字核对 / AT 事件）的才参与判定。
 * 历史存量与启发式学习（bumpSelfCandidate）不带 selfIdVerified → 一律不信（自愈被污染的存量数据）。
 */
function trustedSelfIdFor(botId: string, groupId: string): string {
  const b = loadSelfIds().bots[botId]
  if (!b) return ''
  const p = groupId ? b.peers?.[groupId] : undefined
  if (p?.selfId && p.selfIdVerified) return String(p.selfId)
  if (b.selfId && b.selfIdVerified) return String(b.selfId)
  return ''
}
/**
 * 学习自身 openid（**只允许从可验证来源调用**：mention 名字与本 bot 平台昵称核对通过、
 * 或 AT 事件（注定 @ 的是本 bot））—— 顺手打 selfIdVerified 标记。
 */
function learnSelfIdFromMentions(botId: string, id: string): void {
  const v = String(id || '').trim()
  if (!v) return
  const d = loadSelfIds()
  const b = d.bots[botId] || (d.bots[botId] = {})
  if (b.selfId === v && b.selfIdVerified) return
  b.selfId = v
  b.selfIdVerified = true
  persistSelfIds()
  log(`bot ${botId} 已核对并学习自身 openid: ${v.slice(0, 10)}…`)
}
/** 候选命中 +1；同群候选唯一且 ≥3 次 → 记为该群 selfId（0913 起仅作记录：@ 判定只信带 selfIdVerified 的值） */
function bumpSelfCandidate(botId: string, groupId: string, id: string): boolean {
  if (!groupId || !id) return false
  if (notMineHas(botId, groupId, id)) return false   // 0913：已知是别的机器人 → 永不当自身学
  const d = loadSelfIds()
  const b = d.bots[botId] || (d.bots[botId] = {})
  const peers = b.peers || (b.peers = {})
  const p = peers[groupId] || (peers[groupId] = {})
  const cand = p.cand || (p.cand = {})
  cand[id] = (cand[id] || 0) + 1
  const qualified = Object.entries(cand).filter(([, n]) => n >= 3)
  if (qualified.length === 1 && !p.selfId) {
    p.selfId = qualified[0][0]
    persistSelfIds()
    log(`bot ${botId} 群 ${groupId.slice(0, 8)} 候选记为该群自身 openid: ${p.selfId.slice(0, 10)}…（未验证，仅记录）`)
    return true
  }
  persistSelfIds()
  return false
}

/**
 * 0913 串台修复（**多机器人同群**）：判断「这条全量群消息 @ 的是不是我」。
 *
 * 背景：@ 了**别的机器人**时，平台同样下发 `mentions: [{ id, username, bot: true }]`——
 * 旧逻辑「见到 bot:true 就当 @ 我 + 顺手学 id」在单 bot 群没事，两个机器人同群后：
 * ① 互相抢答（@Nis 的消息牢大也回）；② 把**别人的 id 学成自己的**（越学越乱）。
 *
 * 判定顺序（先 mentions 核对，再正文兜底）：
 *   ① bot:true 条目逐一核对：可信自身 id 命中 / username == 本 bot 平台昵称 → 是我；
 *   ② 名字明确是别的机器人 → other（不回复、不插嘴），并把它的 id 记入 notMine 排除表；
 *   ③ mentions 无法判定（名字缺失等）→ 正文 `<@id>` 兜底（selfMentionByContent）。
 */
function botMentionVerdict(c: BotConn, d: any): 'self' | 'other' | 'none' {
  const ms = Array.isArray(d?.mentions) ? d.mentions.filter((m: any) => m?.bot === true) : []
  if (!ms.length) return 'none'
  const groupId = String(d?.group_openid || '')
  const myName = String(c.nickname || '').trim()
  const selfId = trustedSelfIdFor(c.botId, groupId)
  let mine = false
  let sawForeign = false
  const foreignIds: string[] = []
  for (const m of ms) {
    const id = String(m?.id || m?.member_openid || '').trim()
    const nm = String(m?.username || '').trim()
    if ((selfId && id && id === selfId) || (nm && myName && nm === myName)) {
      mine = true
      if (nm && myName && nm === myName && id && id !== selfId) learnSelfIdFromMentions(c.botId, id)   // 名字核对通过 → 学 id
    } else if ((nm && myName && nm !== myName) || (id && notMineHas(c.botId, groupId, id))) {
      sawForeign = true
      if (id && !foreignIds.includes(id)) foreignIds.push(id)
    }
  }
  // 本条里确认的「别的机器人」id 一律记入排除表（无论本条最终判定是不是在 @ 我）
  for (const id of foreignIds) markNotMine(c.botId, groupId, id)
  if (mine) return 'self'
  return sawForeign ? 'other' : 'none'
}

/** 正文 `<@id>` 兜底判定（mentions 无 bot 标记 / 名字缺失时用）—— 可信自身 id → 成员表+排除表。 */
function selfMentionByContent(c: BotConn, d: any): boolean {
  const ids = extractMentionIds(String(d?.content || ''))
  if (!ids.length) return false
  const groupId = String(d?.group_openid || '')
  const selfId = trustedSelfIdFor(c.botId, groupId)
  if (selfId) {
    const hit = ids.includes(selfId)
    if (!hit) log(`bot ${c.botId} 全量消息 @ 的不是我（${ids.map(i => i.slice(0, 6)).join('、')}）→ 仅记背景`)
    return hit
  }
  // 没学到自身 id：用群成员表 + notMine 表排除「别人」，剩下的未知名视为 @ 我
  let known = new Set<string>()
  try { known = new Set(listMembers('qq', groupId, 80).map(x => x.id)) } catch { /* ignore */ }
  const suspects = ids.filter(id => !known.has(id) && !notMineHas(c.botId, groupId, id))
  if (!suspects.length) {
    log(`bot ${c.botId} 全量消息 @ 的是已知群友/别的机器人（${ids.map(i => i.slice(0, 6)).join('、')}）→ 仅记背景`)
    return false
  }
  const promoted = suspects.length === 1 ? bumpSelfCandidate(c.botId, groupId, suspects[0]) : false
  log(`bot ${c.botId} 全量消息 @判定（未学习）：${suspects.map(i => i.slice(0, 8)).join('、')} 不在成员表 → 视为 @我${promoted ? '，并已学成自身 id' : ''}`)
  return true
}

/** 组合判定（分支与测试钩子共用）：{ self: 对着我说, otherBot: 明确对着别的机器人说 } */
function classifyGroupDirected(c: BotConn, d: any): { self: boolean; otherBot: boolean } {
  const mv = botMentionVerdict(c, d)
  const self = mv === 'self' || (mv === 'none' && selfMentionByContent(c, d))
  return { self, otherBot: !self && mv === 'other' }
}

/** 「不是本机器人」的 id 排除表（同群持久化）—— 0913 串台修复配套 */
function markNotMine(botId: string, groupId: string, id: string): void {
  const v = String(id || '').trim()
  if (!groupId || !v) return
  const d = loadSelfIds()
  const b = d.bots[botId] || (d.bots[botId] = {})
  const peers = b.peers || (b.peers = {})
  const p = peers[groupId] || (peers[groupId] = {})
  const nm = p.notMine || (p.notMine = {})
  nm[v] = (nm[v] || 0) + 1
  persistSelfIds()
}
function notMineHas(botId: string, groupId: string, id: string): boolean {
  const p = loadSelfIds().bots[botId]?.peers?.[groupId]
  return !!p?.notMine?.[String(id || '')]
}

/**
 * 0913：**AT 事件 = 注定 @ 的是本 bot** → 顺手学习自身 openid
 * （多机器人同群仅名字核对过才采信；名字缺失时当且仅当只有一个候选 id 时采信）。
 */
function learnSelfIdFromAtEvent(c: BotConn, rawMentions: any, rawContent: string): void {
  const myName = String(c.nickname || '').trim()
  const ms = Array.isArray(rawMentions) ? rawMentions : []
  const named = ms.find((m: any) => {
    const nm = String(m?.username || '').trim()
    return !!nm && !!myName && nm === myName
  })
  if (named) {
    const id = String(named?.id || named?.member_openid || '').trim()
    if (id) { learnSelfIdFromMentions(c.botId, id); return }
  }
  const ids = [...new Set([
    ...ms.map((m: any) => String(m?.id || m?.member_openid || '').trim()).filter(Boolean),
    ...extractMentionIds(String(rawContent || '')),
  ])]
  if (ids.length === 1) learnSelfIdFromMentions(c.botId, ids[0])
}


/**
 * 每台机器人第一次收到「带 @ / 带附件」的群消息时打一份原始字段诊断 ——
 * 平台对全量事件的字段是灰度下发的，判「有没有 @ 我」全靠它（排查时一眼可见）。
 */
function dumpRichGroupEventOnce(c: BotConn, d: any): void {
  if (c.dumpRichOnce) return
  c.dumpRichOnce = true
  try {
    const a = d?.author || {}
    log(`bot ${c.botId} 富消息诊断: ${JSON.stringify({
      author: a,
      content: String(d?.content || '').slice(0, 120),
      message_type: d?.message_type,
      mentions: d?.mentions ?? '(无)',
      attachments: d?.attachments ?? '(无)',
      dKeys: Object.keys(d || {}),
    }).slice(0, 900)}`)
  } catch { /* ignore */ }
}


function emitMessage(c: BotConn, ev: QqMessageEvent) {
  /**
   * 0912 二十一批/二十二批：图片消息不再整条丢弃。
   *
   * 图片两条来源都要收（用户实测 + 官方文档）：
   *   ① `attachments[]`（**主力**）：{ url, content_type: image/png|image/jpeg|image/gif, filename, size }
   *   ② content 里的 `<image url="…"/>` 标签（老形态，保留兼容）
   * 非图片附件（file/video/voice）落盘后记成一条 `[文件：xxx]` 说明，让 AI 知道对方发了什么、文件在哪。
   * 注意：去重必须**同步**做（下载是异步的，放到下载后去重会让重复投递的两条都通过）。
   */
  const parsed = extractQqImages(ev.content)
  const atts = Array.isArray(ev.attachments) ? ev.attachments : []
  /* 0920 修（反馈"图片间歇性能看"）：以前按 `content_type` **精确匹配**：
   *   · 只有 /^image\// 才算图 → 平台偶尔**不给 content_type**（或给 octet-stream）时，
   *     整条附件被直接丢掉（连试都不试一次），表现就是"有时能看、有时完全看不到"；
   *   · 只有 `content_type === 'file'` 才算文件 → 同理。
   * 现在分四档，**"类型未知"不再丢弃**，而是照常下载、用魔数嗅探后归类。 */
  const bucketOf = (a: QqAttachment): 'image' | 'file' | 'other' | 'unknown' => {
    const ct = String(a?.content_type || '').trim().toLowerCase()
    if (ct.startsWith('image/')) return 'image'
    if (ct === 'file') return 'file'
    if (ct.startsWith('video/') || ct.startsWith('voice') || ct === 'audio' || ct.startsWith('audio/')) return 'other'
    return 'unknown'
  }
  const hasUrl = (a: QqAttachment) => /^https?:\/\//i.test(String(a?.url || ''))
  const attImages = atts.filter(a => bucketOf(a) === 'image' && hasUrl(a))
  const attFiles = atts.filter(a => bucketOf(a) === 'file' && hasUrl(a))
  const attOthers = atts.filter(a => bucketOf(a) === 'other')
  /** 类型未识别的附件：下载后按魔数归类（图→图、其它→文件） */
  const attUnknown = atts.filter(a => bucketOf(a) === 'unknown' && hasUrl(a))
  if (attUnknown.length) {
    log(`bot ${c.botId} 附件类型未标注（content_type 缺失），改为下载后嗅探：${attUnknown.map(a => a.filename || a.url?.slice(-24) || '?').join('、')}`)
  }
  const urls = [
    ...attImages.map(a => String(a.url)),
    ...parsed.urls,
  ].slice(0, 4)
  // 附件/文件也要在正文里留痕（AI 才知道"对方还发了个文件"）
  const attNote = attFiles.map(f => `[对方发来文件：${f.filename || '未命名'}${f.size ? `（${Math.round(f.size / 1024)}KB）` : ''}]`).join(' ')
  const otherNote = attOthers.map(a => `[对方发来${/^video\//i.test(String(a.content_type)) ? '视频' : '语音'}]`).join(' ')
  const bodyText = [parsed.text, attNote, otherNote].filter(Boolean).join(' ').trim()
  if (!bodyText && !urls.length) {
    // 什么都没解析出来：留一条诊断（新形态的附件字段可能又变了），别再静默吞
    if (atts.length) log(`bot ${c.botId} ⚠️ 收到 ${ev.kind} 消息但附件类型未识别：${JSON.stringify(atts).slice(0, 300)}`)
    return
  }
  if (ev.messageId) {
    if (c.seenMsgIds.has(ev.messageId)) {
      log(`bot ${c.botId} 跳过重复投递 ${ev.messageId.slice(0, 24)}`)
      return
    }
    c.seenMsgIds.add(ev.messageId)
    if (c.seenMsgIds.size > 500) {
      const first = c.seenMsgIds.values().next().value
      if (first) c.seenMsgIds.delete(first)
    }
  }
  const who = ev.senderName || (ev.senderId ? ev.senderId.slice(0, 8) : '?')
  const clean: QqMessageEvent = { ...ev, content: bodyText, attachments: undefined }
  const mediaTotal = urls.length + attFiles.length + attUnknown.length
  if (!mediaTotal) {
    log(`bot ${c.botId} 收到 ${ev.kind} 消息 from=${ev.target.slice(0, 10)} by=${who}${ev.mentions?.length ? ` @${ev.mentions.length}人` : ''}`)
    handlers?.onMessage(c.botId, clean)
    return
  }
  log(`bot ${c.botId} 收到 ${ev.kind} 媒体消息 from=${ev.target.slice(0, 10)} by=${who}（图 ${urls.length} 张 / 文件 ${attFiles.length} 个 / 类型未标注 ${attUnknown.length} 个，下载中…）`)
  void (async () => {
    try {
      const { images, errors } = urls.length ? await fetchQqImages('qq', c.botId, urls) : { images: [], errors: [] }
      const files: Array<{ path: string; name: string; mime: string; bytes: number }> = []
      for (const f of attFiles.slice(0, 2)) {
        const got = await downloadBinary(String(f.url), 'qq-file', INBOUND_FILE_MAX_BYTES)   // 同一个下载器（带 UA/超时/大小限制）
        if (!got.ok) { errors.push(`文件 ${f.filename || ''} ${got.reason}`); continue }
        const savedFile = saveInboundFile('qq', c.botId, got.buf, f.filename || 'file.bin', String(f.content_type || got.mime || 'application/octet-stream'))
        if ('error' in savedFile) { errors.push(savedFile.error); continue }
        files.push(savedFile)
      }
      /* 类型未标注的附件：下载后按**魔数**归类（图→图，其它→文件）。
       * 这是"平台偶尔不给 content_type"时仍能看图的兜底 —— 以前这类附件直接被丢掉。 */
      for (const a of attUnknown.slice(0, 2)) {
        const got = await downloadBinary(String(a.url), 'qq-unknown', Math.max(INBOUND_IMAGE_MAX_BYTES, INBOUND_FILE_MAX_BYTES))
        if (!got.ok) { errors.push(`${a.filename || '附件'} ${got.reason}`); continue }
        if (/^image\//i.test(got.mime)) {
          const saved = saveInboundImage('qq', c.botId, got.buf, got.mime)
          if ('error' in saved) { errors.push(saved.error); continue }
          images.push(saved)
          log(`bot ${c.botId} 未标注附件嗅探为图片（${got.mime}）→ 已入库`)
        } else {
          const saved = saveInboundFile('qq', c.botId, got.buf, a.filename || 'attachment.bin', got.mime)
          if ('error' in saved) { errors.push(saved.error); continue }
          files.push(saved)
          log(`bot ${c.botId} 未标注附件嗅探为文件（${got.mime}）→ 已落盘`)
        }
      }
      const gotCount = images.length + files.length
      /* 0920：**部分失败也要如实说出来**。
       * 以前只有"一个都没拿到"才带 imageError，4 张里丢了 3 张时是全静默的
       * —— 这正是反馈"图片间歇性能看"却查不到原因的地方。 */
      if (errors.length) {
        const summary = `${gotCount}/${mediaTotal} 个附件取到；${errors.slice(0, 2).join('；')}${errors.length > 2 ? ` 等共 ${errors.length} 项` : ''}`
        log(`bot ${c.botId} 媒体下载部分失败：${summary}`)
        if (!gotCount) {
          handlers?.onMessage(c.botId, { ...clean, imageError: summary })
          return
        }
        // 部分成功：如实带上 imageError；由 server 侧在**组装 prompt 时**并入正文
        // （不能直接改 content —— 那会让"纯图等配文"的挂起逻辑失效）
        handlers?.onMessage(c.botId, {
          ...clean,
          images: images.length ? images : undefined,
          files: files.length ? files : undefined,
          imageError: summary,
        })
        return
      }
      handlers?.onMessage(c.botId, { ...clean, images: images.length ? images : undefined, files: files.length ? files : undefined })
    } catch (e: any) {
      handlers?.onMessage(c.botId, { ...clean, imageError: String(e?.message || e).slice(0, 100) })
    }
  })()
}

/** 旁听消息（全量群消息）：独立去重 + 不触发回复 */
function emitGroupBackground(c: BotConn, ev: QqMessageEvent) {
  // 图片/附件剥成 [图片]/[文件] 占位（流水里记 URL 又噪又没用）
  const parsed = extractQqImages(ev.content)
  const atts = Array.isArray(ev.attachments) ? ev.attachments : []
  const attMarks = atts.map(a => {
    const ct = String(a?.content_type || '')
    if (/^image\//i.test(ct)) return '[图片]'
    if (ct === 'file') return `[文件：${a?.filename || '未命名'}]`
    if (/^video\//i.test(ct)) return '[视频]'
    return ct.startsWith('voice') ? '[语音]' : ''
  }).filter(Boolean).join(' ')
  const text = [parsed.text, attMarks].filter(Boolean).join(' ').trim()
  if (!text || !ev.target) return
  /**
   * ★1014c：**不再丢弃 attachments** —— 正文依旧换成 `[图片]/[文件]` 占位（群流水里不记 URL），
   * 但附件随事件上行，由 server 侧登记成"该群最近的媒体"（**只存地址、不下载**）。
   * 等有人 @ 机器人、或它自己决定插嘴时，才按需把图下载喂给模型。
   *
   * 病案（实测）：群里**先发图、再 @ 它问「这是谁」**——图那条走旁听被剥成 `[图片]`，
   * 地址被丢 ⇒ 它手里只有"[图片]"三个字，只能回「看不见图片」。
   */
  ev = { ...ev, content: text }
  if (ev.messageId) {
    if (c.seenGroupMsgIds.has(ev.messageId)) return
    c.seenGroupMsgIds.add(ev.messageId)
    if (c.seenGroupMsgIds.size > 800) {
      const first = c.seenGroupMsgIds.values().next().value
      if (first) c.seenGroupMsgIds.delete(first)
    }
  }
  const who = ev.senderName || (ev.senderId ? ev.senderId.slice(0, 8) : '?')
  log(`bot ${c.botId} 旁听群消息 group=${ev.target.slice(0, 10)} by=${who}（不回复，仅作背景）`)
  handlers?.onGroupMessage?.(c.botId, ev)
}

/* ── 发消息 ─────────────────────────────────────────────── */

/**
 * 回推消息。QQ 要求：同一 msg_id 下 msg_seq 递增（防重复投递），
 * 且**被动回复必须在窗口内**（私聊 60 分钟 / 群 5 分钟），超窗口需用主动消息（每月 4 条额度）。
 */
export async function sendQqMessage(
  botId: string,
  ev: { kind: 'c2c' | 'group' | 'channel'; target: string; messageId: string; channelMsgId?: string; eventId?: string },
  text: string,
  opts: { markdown?: boolean; keyboard?: any } = {},
): Promise<void> {
  /**
   * ★1014e：markdown 回复（官方 2026-04-23 起对**全部机器人**开放单聊/群聊自定义 markdown：
   * `msg_type: 2` + `markdown: { content }`）。不加这个，模型产出的 `**加粗**`、`# 标题`、列表、
   * 表格在 QQ 里都是**原始标记**（很难看）。
   * ⚠️ 失败降级（回纯文本）由**调用方**做（见 server.ts 的 deliverToChannel）——
   *    本函数只如实发、失败如实抛，不在这里悄悄换格式。
   * ⚠️ 频道（kind='channel'）不支持 markdown，调用方应传 false。
   */
  const body: any = opts.markdown
    ? { msg_type: 2, markdown: { content: text } }
    : { content: text, msg_type: 0 }
  /**
   * ★1016d：消息按钮（keyboard）挂在**顶层**（官方示例即 `{ msg_type:2, markdown:{content}, keyboard:{...} }`）。
   * 踩过两次，都记下来：
   *   ① **纯文本 + keyboard 会被官方静默忽略**（不报错、也没按钮）⇒ 按钮必须配 markdown 一起发；
   *   ② keyboard 结构与单聊 schema 不符 → 400「markdown消息参数错误」（文案误导，真因在字段）。
   */
  if (opts.keyboard) body.keyboard = opts.keyboard
  fillMsgRef(body, botId, ev)
  await qqApi(botId, messageEndpoint(ev), body, opts.markdown ? 'sendMessage(markdown)' : 'sendMessage')
}

/* ── 富媒体（图片 / 视频 / 语音 / 文件）─────────────────────
 * QQ 发送媒体分两步（官方 Bot API v2）：
 *   ① POST /v2/{users|groups}/{target}/files  { file_type, file_data | url, srv_send_msg:false }
 *      → { file_uuid, file_info, ttl } —— srv_send_msg=false 表示"只上传不发送"
 *   ② POST /v2/{users|groups}/{target}/messages { msg_type:7, media:{ file_info }, msg_id, msg_seq }
 */

/** 本地文件扩展名 → QQ 富媒体类型（1=图片 2=视频 3=音频 4=文件） */
function qqFileType(fileName: string): number {
  const ext = String(fileName).toLowerCase().match(/\.[a-z0-9]+$/)?.[0] || ''
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico'].includes(ext)) return 1
  if (['.mp4', '.mov', '.avi', '.mkv', '.webm', '.flv'].includes(ext)) return 2
  if (['.mp3', '.wav', '.m4a', '.ogg', '.amr', '.silk', '.aac', '.flac'].includes(ext)) return 3
  return 4
}

/**
 * 上传并发送一个媒体文件。
 * @param opts.fileName 文件名（用于判定类型 + 展示）
 * @param opts.buffer   本地文件内容（与 url 二选一）
 * @param opts.url      公网 URL（与 buffer 二选一；QQ 自己去拉）
 */
export async function sendQqMedia(
  botId: string,
  ev: { kind: 'c2c' | 'group' | 'channel'; target: string; messageId: string; channelMsgId?: string; eventId?: string },
  opts: { fileName: string; buffer?: Buffer; url?: string },
): Promise<void> {
  const fileType = qqFileType(opts.fileName)
  const upBody: any = { file_type: fileType, srv_send_msg: false }
  if (opts.url) upBody.url = opts.url
  else if (opts.buffer && opts.buffer.length) upBody.file_data = opts.buffer.toString('base64')
  else throw new Error('媒体源为空（需要 buffer 或 url）')
  /**
   * 二十二批（用户实测「发过去的 html 显示成『未命名』」）：
   * file_type=4（文件）必须带 `file_name`，否则 QQ 拿不到名字 → 手机上显示「未命名」。
   * 图片/视频/语音不需要（平台自己按内容类型处理）。
   */
  if (fileType === 4 && opts.fileName) upBody.file_name = String(opts.fileName)

  const up = await qqApi(botId, filesEndpoint(ev), upBody, 'uploadMedia')
  // 兼容两种返回层级（官方直接返回 file_info，部分响应包在 data 里）
  const fileInfo = String(up?.file_info || up?.data?.file_info || '')
  if (!fileInfo) throw new Error(`uploadMedia 未返回 file_info: ${JSON.stringify(up).slice(0, 180)}`)

  const body: any = { msg_type: 7, media: { file_info: fileInfo }, content: '' }
  fillMsgRef(body, botId, ev)
  await qqApi(botId, messageEndpoint(ev), body, 'sendMedia')
}

/** 消息端点（c2c / group / channel） */
function messageEndpoint(ev: { kind: 'c2c' | 'group' | 'channel'; target: string }): string {
  if (ev.kind === 'c2c') return `${API_BASE}/v2/users/${ev.target}/messages`
  if (ev.kind === 'group') return `${API_BASE}/v2/groups/${ev.target}/messages`
  return `${API_BASE}/channels/${ev.target}/messages`
}

/** 富媒体上传端点 */
function filesEndpoint(ev: { kind: 'c2c' | 'group' | 'channel'; target: string }): string {
  if (ev.kind === 'c2c') return `${API_BASE}/v2/users/${ev.target}/files`
  if (ev.kind === 'group') return `${API_BASE}/v2/groups/${ev.target}/files`
  return `${API_BASE}/channels/${ev.target}/files`
}

/** 填 msg_id / msg_seq（频道 API 与群/私聊不同：频道只带 msg_id，无 msg_seq 递增要求） */
function fillMsgRef(
  body: any,
  botId: string,
  ev: { kind: 'c2c' | 'group' | 'channel'; messageId: string; channelMsgId?: string; eventId?: string },
): void {
  /**
   * 事件被动回复（0912 十六批）：带 `event_id` 回复**平台事件**（如 GROUP_ADD_ROBOT）——
   * 与 msg_id 二选一，且不需要 msg_seq（msg_seq 只与 msg_id 联合使用）。
   */
  if (ev.eventId) {
    body.event_id = ev.eventId
    return
  }
  if (ev.kind === 'channel') {
    if (ev.channelMsgId || ev.messageId) body.msg_id = ev.channelMsgId || ev.messageId
    return
  }
  /**
   * ⚠️ messageId 为空 = **主动消息**（不带 msg_id/msg_seq）—— 用于「定时任务/通知」这类
   * 非回复场景。官方限制：主动消息**每个用户每月 4 条**，超出会失败；
   * 带 msg_id 才是 60 分钟窗口内的被动回复（不限量）。调用方需自行权衡。
   */
  if (!ev.messageId) return
  body.msg_id = ev.messageId
  // msg_seq：同一 msg_id 递增（QQ 用它去重；同 seq 会被判重复丢弃）
  const c = conns.get(botId)
  if (c) {
    const next = (c.msgSeq.get(ev.messageId) || 0) + 1
    c.msgSeq.set(ev.messageId, next)
    if (c.msgSeq.size > 200) {
      const first = c.msgSeq.keys().next().value
      if (first) c.msgSeq.delete(first)
    }
    body.msg_seq = next
  }
}

/**
 * ★1014b：为「流式消息」预留一个 msg_seq（与普通回复**共用**同一自增空间）。
 *
 * 为什么必须共用：官方按 (msg_id, msg_seq) 去重 —— 流式帧的 msg_seq 是**整条流固定值**，
 * 若它与后续普通回复的 msg_seq 撞上，那条回复会被判「重复」直接丢弃。开流时从这里取一个新号，
 * 之后普通回复继续往上递增 ⇒ 天然不撞。
 *
 * @returns 预留到的号；`0` = 机器人未连接（调用方应当**放弃流式**，走普通一次性回复）
 */
export function reserveQqMsgSeq(botId: string, messageId: string): number {
  const c = conns.get(botId)
  if (!c || !messageId) return 0
  const next = (c.msgSeq.get(messageId) || 0) + 1
  c.msgSeq.set(messageId, next)
  if (c.msgSeq.size > 200) {
    const first = c.msgSeq.keys().next().value
    if (first) c.msgSeq.delete(first)
  }
  return next
}

/** 统一的 QQ API 调用（自动带 token / appid，返回解析后的 JSON）。★1016：加 method —— 按钮交互应答要 PUT */
async function qqApi(botId: string, url: string, body: any, label: string, method: 'POST' | 'PUT' = 'POST'): Promise<any> {
  const c = conns.get(botId)
  if (!c) throw new Error(`bot ${botId} 未连接`)
  const token = await ensureToken(c)
  const res = await fetch(url, {
    method,
    headers: {
      'content-type': 'application/json',
      Authorization: `QQBot ${token}`,
      'X-Union-Appid': c.appId,
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const t = await res.text()
    throw new Error(`${label} ${res.status}: ${t.slice(0, 200)}`)
  }
  const text = await res.text()
  try { return text ? JSON.parse(text) : {} } catch { return {} }
}

/**
 * 获取群基本信息（0912 十八批）：`GET /v2/groups/{group_openid}/info` → group_name ...
 *
 * ⚠️ 官方明确：**该接口仅白名单机器人可用**（否则返回 11253 无接口访问权限）。
 * 所以调用方必须能容忍失败 —— 拿到群名就用真名做显示名，拿不到继续用「群A/群B」。
 */
export async function fetchQqGroupInfo(
  botId: string,
  groupOpenid: string,
): Promise<{ ok: boolean; name?: string; memo?: string; memberNum?: number; error?: string }> {
  const c = conns.get(botId)
  if (!c) return { ok: false, error: `bot ${botId} 未连接` }
  try {
    const token = await ensureToken(c)
    const res = await fetch(`${API_BASE}/v2/groups/${groupOpenid}/info`, {
      headers: { Authorization: `QQBot ${token}`, 'X-Union-Appid': c.appId },
    })
    const text = await res.text()
    if (!res.ok) return { ok: false, error: `${res.status}: ${text.slice(0, 180)}` }
    const j = text ? JSON.parse(text) : {}
    return {
      ok: true,
      name: String(j?.group_name || '').trim() || undefined,
      memo: String(j?.group_finger_memo || '').trim() || undefined,
      memberNum: Number(j?.group_member_num) || undefined,
    }
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e).slice(0, 180) }
  }
}

/* ── 生命周期 ──────────────────────────────────────────── */

/** 启动某个机器人（幂等：已启动则先停再起） */
async function startQqBot(botId: string, appId: string, secret: string): Promise<void> {
  await stopQqBot(botId)
  const c: BotConn = {
    botId, appId, secret,
    ws: null, heartbeatTimer: null, seq: 0,
    token: '', tokenExpireAt: 0,
    retries: 0, stopped: false, connected: false,
    nickname: '',
    msgSeq: new Map(),
    seenMsgIds: new Set(),
    seenGroupMsgIds: new Set(),
  }
  conns.set(botId, c)
  void connect(c)
}

async function stopQqBot(botId: string): Promise<void> {
  const c = conns.get(botId)
  if (!c) return
  c.stopped = true
  clearTimers(c)
  try { c.ws?.close() } catch { /* ignore */ }
  conns.delete(botId)
}

export function stopAllQqBots(): void {
  for (const id of Array.from(conns.keys())) void stopQqBot(id)
}

/** 当前连接状态（供 RPC 查询） */
export function qqBotStatus(): Record<string, { connected: boolean; appId: string; nickname?: string }> {
  const out: Record<string, { connected: boolean; appId: string; nickname?: string }> = {}
  for (const [id, c] of conns) out[id] = { connected: c.connected, appId: c.appId, nickname: c.nickname || undefined }
  return out
}

/** 注入消息处理器（server.ts 启动时注入，避免循环依赖） */
export function setQqBotHandlers(h: QqBotHandlers): void {
  handlers = h
}

/**
 * 按当前配置启动所有「已启用 + 有凭据」的 QQ 机器人。
 * 由 server.ts 在启动时与配置变更时调用（配置改了要重连）。
 */
export async function syncQqBotsFromConfig(): Promise<void> {
  const cfg = getChannel('qq')
  if (!cfg) return
  const wanted = new Map<string, { appId: string; secret: string }>()
  if (cfg.enabled) {
    for (const b of cfg.bots) {
      if (b.enabled && b.accountId && b.secret) wanted.set(b.id, { appId: b.accountId, secret: b.secret })
    }
  }
  // 停掉不在期望列表里的
  for (const id of Array.from(conns.keys())) {
    if (!wanted.has(id)) await stopQqBot(id)
  }
  // 启动期望列表里未连接的
  for (const [id, { appId, secret }] of wanted) {
    if (!conns.has(id)) await startQqBot(id, appId, secret)
  }
}
