/**
 * 通道会话映射（QQ / 微信共用）—— `channelKey` ↔ NIS `sessionId`
 *
 * 为什么需要映射：IM 侧的对端标识（QQ openid / 微信 from_user_id）不是 NIS 会话 id，
 * 同一个人连发多条消息必须落到**同一个会话**（否则上下文断裂、右侧栏会刷出一堆会话）。
 *
 * channelKey 组成（对齐官方 per-account-channel-peer 隔离策略）：
 *   `${channel}:${botId}:${peerId}`
 *   例：qq:qqbot_xxxx:8F3A...（openid）  wechat:acc_xxxx:user_xxxx@im.wechat
 *
 * 落盘：backend/data/channels/sessions.json（原子写）
 *   {
 *     version,
 *     map:      { [channelKey]: { sessionId, channel, botId, peerId, contextToken?, lastAt } },
 *     botActive:{ [channel:botId]: { sessionId, at } }
 *   }
 *
 * ⚠️ 两类「当前会话」记录，优先级：正式映射（map）> bot 级覆盖（botActive）
 *   · map        —— 收到过消息、对端已明确（正常路径）
 *   · botActive  —— PC 端在「还不知道对端是谁」时切换/新建用（0912 三批新增）。
 *                   首次收到该机器人的消息时被消费掉，绑定成正式映射。
 *
 * 注意：通道会话就是**普通会话**（打 origin 标记），所以 PC 上能直接打开继续聊。
 */
import fs from 'node:fs'
import path from 'node:path'
import { DATA_ROOT } from '../paths.ts'

const MAP_FILE = path.join(DATA_ROOT, 'channels', 'sessions.json')

interface ChannelSessionLink {
  sessionId: string
  channel: string
  botId: string
  peerId: string
  /** 微信回复需回传的会话上下文令牌 */
  contextToken?: string
  /**
   * 最近一条入站消息的 id（0912 十三批）—— **QQ 省额度用**：
   * 60 分钟窗口内用它可走「被动回复」（不消耗每月 4 条的主动消息额度）。
   */
  lastMessageId?: string
  /**
   * 上面那条入站消息的**到达时间**（0912 十三批）。
   *
   * 为什么不复用 lastAt：lastAt 会被推送/回推等写入刷新（语义是"最近一次活动"），
   * 用它判 60 分钟窗口会在"推送过但用户没回"之后误判成窗口内 → 拿过期 msg_id 发送 → QQ 直接拒绝。
   */
  lastMessageAt?: number
  /**
   * 该对端的消息场景（c2c 私聊 / group 群聊 / channel 频道）—— 0912 十三批。
   *
   * 为什么存在映射上而不是只放会话上：**同一会话可能被多个对端复用**
   * （定时任务专属会话会同时挂微信 + 某台 QQ 机器人的映射），
   * 会话级的 originKind 只能表达"最后一次是谁"，拿它去发别的对端会走错端点
   * （QQ 私聊要 /v2/users、群聊要 /v2/groups）。kind 是**对端的属性**，所以按 channelKey 存。
   */
  kind?: string
  /** 最近一条消息时间（用于清理陈旧映射 + 判断被动回复窗口） */
  lastAt: number
}

/** bot 级「活跃会话」覆盖 —— 对端尚未明确时的临时指向 */
interface ChannelBotActive {
  sessionId: string
  at: number
}

interface StoreShape {
  version: number
  map: Record<string, ChannelSessionLink>
  botActive: Record<string, ChannelBotActive>
}

let cache: StoreShape | null = null

function load(): StoreShape {
  if (cache) return cache
  try {
    if (fs.existsSync(MAP_FILE)) {
      const raw = JSON.parse(fs.readFileSync(MAP_FILE, 'utf-8'))
      if (raw && typeof raw === 'object' && raw.map && typeof raw.map === 'object') {
        cache = {
          version: 1,
          map: raw.map,
          // 兼容旧文件：早期版本没有 botActive 段
          botActive: (raw.botActive && typeof raw.botActive === 'object') ? raw.botActive : {},
        }
        return cache
      }
    }
  } catch (e) {
    console.warn('[channelSessionMap] 读取失败，回退空表:', e)
  }
  cache = { version: 1, map: {}, botActive: {} }
  return cache
}

function persist(): void {
  const data = load()
  try {
    fs.mkdirSync(path.dirname(MAP_FILE), { recursive: true })
    const tmp = MAP_FILE + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8')
    fs.renameSync(tmp, MAP_FILE)
  } catch (e) {
    console.error('[channelSessionMap] 落盘失败:', e)
  }
}

export function makeChannelKey(channel: string, botId: string, peerId: string): string {
  return `${channel}:${botId}:${peerId}`
}

/** bot 级覆盖的存储键（与通道会话 key 区分开，避免 peerId 为空时撞键） */
function botActiveKey(channel: string, botId: string): string {
  return `${channel}:${botId || '-'}`
}

export function getLink(key: string): ChannelSessionLink | null {
  const l = load().map[key]
  return l ? { ...l } : null
}

export function setLink(key: string, link: Omit<ChannelSessionLink, 'lastAt'> & { lastAt?: number }): void {
  const data = load()
  data.map[key] = { ...link, lastAt: link.lastAt || Date.now() }
  persist()
}

/** 更新最近活跃时间（收到消息时调用） */
export function touchLink(key: string): void {
  const data = load()
  const l = data.map[key]
  if (!l) return
  l.lastAt = Date.now()
  persist()
}

/** 微信 context_token 会随消息更新，需要回写 */
export function setContextToken(key: string, token: string): void {
  const data = load()
  const l = data.map[key]
  if (!l) return
  l.contextToken = token
  l.lastAt = Date.now()
  persist()
}

/** 回填对端类型（老映射没有 kind 字段；由 heal 从会话借，见 server.healSessionsFromLinks） */
export function setKind(key: string, kind: string): void {
  const data = load()
  const l = data.map[key]
  if (!l || !kind || l.kind === kind) return
  l.kind = kind
  persist()
}

/** 会话被删除/迁移时清理映射（避免指向不存在的会话） */
export function removeLinkBySession(sessionId: string): void {
  const data = load()
  let changed = false
  for (const [k, v] of Object.entries(data.map)) {
    if (v.sessionId === sessionId) { delete data.map[k]; changed = true }
  }
  // bot 级覆盖同样要清（否则会指向不存在的会话）
  for (const [k, v] of Object.entries(data.botActive)) {
    if (v.sessionId === sessionId) { delete data.botActive[k]; changed = true }
  }
  if (changed) persist()
}

/** 全部映射（调试/展示用） */
export function listLinks(): Record<string, ChannelSessionLink> {
  const out: Record<string, ChannelSessionLink> = {}
  for (const [k, v] of Object.entries(load().map)) out[k] = { ...v }
  return out
}

/* ── bot 级活跃覆盖（0912 三批：PC 端切换/新建对话时对端未知的兜底）── */

export function setBotActive(channel: string, botId: string, sessionId: string): void {
  const data = load()
  data.botActive[botActiveKey(channel, botId)] = { sessionId, at: Date.now() }
  persist()
}

export function getBotActive(channel: string, botId: string): ChannelBotActive | null {
  const v = load().botActive[botActiveKey(channel, botId)]
  return v ? { ...v } : null
}

export function clearBotActive(channel: string, botId: string): void {
  const data = load()
  const k = botActiveKey(channel, botId)
  if (data.botActive[k]) { delete data.botActive[k]; persist() }
}

