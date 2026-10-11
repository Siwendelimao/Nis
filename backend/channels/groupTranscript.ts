/**
 * 群聊流水（0912 十五批）—— 解「AI 不知道刚才群里说了什么」。
 *
 * 背景与平台事实（已查官方文档 + 实测）：
 *   · 官方机器人**默认只收到 @它的消息**（GROUP_AT_MESSAGE_CREATE）；
 *   · 群主在【手机 QQ 群设置 → 机器人 → 机器人可获取的群聊消息范围】改成
 *     「获取群内全部消息」后，平台会推 **GROUP_MESSAGE_CREATE**（全量群消息），
 *     其 intent 与我们已订阅的 GROUP_AND_C2C_EVENT(1<<25) **相同**，所以无需改订阅；
 *   · 全量事件字段与 @ 事件完全一致（author / content / mentions / group_openid）。
 *
 * 拿到全量消息后**不能直接回**（否则机器人会对群里每句话插嘴）。本模块只做一件事：
 * 把"旁听到"的消息记成流水；等有人 @ 它时，由 server 把最近流水作为**背景**注入提示词
 * —— 于是「A 问：B 刚才说了什么」就有答案了。
 *
 * 落盘 data/channels/group-transcript.json（**防抖 3s**：群里刷屏时不必每句都写盘）
 */
import fs from 'node:fs'
import path from 'node:path'
import { DATA_ROOT } from '../paths.ts'

const FILE = path.join(DATA_ROOT, 'channels', 'group-transcript.json')
/** 每个群保留多少条（够回答"刚才说了什么"，又不至于把提示词撑爆） */
const MAX_PER_PEER = 40
/** 落盘防抖 */
const PERSIST_DEBOUNCE_MS = 3000
/** 最多记多少个群（防极端情况文件无限增长） */
const MAX_PEERS = 60

interface GroupLine {
  /** 时间戳 */
  at: number
  /** 发言者标识（群内 openid） */
  speakerId: string
  /** 发言者标签（昵称或「群成员N」，与提示词里用的一致） */
  label: string
  /** 群内角色：member / admin / owner */
  role?: string
  text: string
  /** messageId（用于过滤掉"已经作为当前消息在回复"的那条） */
  messageId?: string
}

interface StoreShape {
  version: number
  peers: Record<string, GroupLine[]>
}

let cache: StoreShape | null = null
let persistTimer: NodeJS.Timeout | null = null

function load(): StoreShape {
  if (cache) return cache
  try {
    if (fs.existsSync(FILE)) {
      const raw = JSON.parse(fs.readFileSync(FILE, 'utf-8'))
      if (raw && typeof raw === 'object' && raw.peers && typeof raw.peers === 'object') {
        cache = { version: 1, peers: raw.peers }
        return cache
      }
    }
  } catch (e) {
    console.warn('[groupTranscript] 读取失败，回退空表:', e)
  }
  cache = { version: 1, peers: {} }
  return cache
}

function persistNow(): void {
  const data = load()
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true })
    const tmp = FILE + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8')
    fs.renameSync(tmp, FILE)
  } catch (e) {
    console.error('[groupTranscript] 落盘失败:', e)
  }
}

function schedulePersist(): void {
  if (persistTimer) return
  persistTimer = setTimeout(() => {
    persistTimer = null
    persistNow()
  }, PERSIST_DEBOUNCE_MS)
  // 别让定时器拖住进程退出
  persistTimer.unref?.()
}

function peerKey(channel: string, peerId: string): string {
  return `${channel}:${peerId}`
}

/** 记一条"旁听到"的群消息（只记，不回复） */
export function recordGroupLine(channel: string, peerId: string, line: GroupLine): void {
  const data = load()
  const pk = peerKey(channel, peerId)
  const arr = data.peers[pk] || (data.peers[pk] = [])
  // 同一条消息重复推送时只留一条
  if (line.messageId && arr.some(l => l.messageId === line.messageId)) return
  arr.push(line)
  if (arr.length > MAX_PER_PEER) arr.splice(0, arr.length - MAX_PER_PEER)
  const keys = Object.keys(data.peers)
  if (keys.length > MAX_PEERS) {
    // 淘汰最久没动静的群
    const oldest = keys
      .filter(k => k !== pk)
      .sort((a, b) => (data.peers[a].at(-1)?.at || 0) - (data.peers[b].at(-1)?.at || 0))[0]
    if (oldest) delete data.peers[oldest]
  }
  schedulePersist()
}

/**
 * 取最近的群聊流水（给提示词做背景）。
 * @param maxAgeMs 只看这段时间内的（默认 60 分钟 —— 更早的"刚才"没意义，还占 token）
 */
export function recentGroupLines(
  channel: string,
  peerId: string,
  limit = 10,
  maxAgeMs = 60 * 60 * 1000,
): GroupLine[] {
  const arr = load().peers[peerKey(channel, peerId)] || []
  const floor = Date.now() - maxAgeMs
  return arr.filter(l => l.at >= floor).slice(-limit).map(l => ({ ...l }))
}


/* ── 群聊「插嘴」节流（0912 二十四批）──
 *
 * 插嘴 = 群里没人 @ 它，它自己看到一句感兴趣的话就搭一句。
 * 用户要求做成开关；开了之后必须**有节制**，否则群里刷屏必被踢。
 *
 * 三道闸（全部存内存即可 —— 重启清零是合理语义，"冷静期"不需要跨重启）：
 *   ① 最短间隔 `idleMs`：该群距上次机器人发言不足这么久 → 不插；
 *   ② 每小时额度 `perHour`：该群滑动 1 小时内插嘴次数达上限 → 不再插（0=不限）；
 *   ③ 内容门槛（由调用方判）：默认只接"像提问"的消息。
 */
interface InterjectState {
  /** 该群上次插嘴时间 */
  lastAt: number
  /** 该群最近插嘴时间戳（滑动窗口，只留 1 小时内） */
  stamps: number[]
}
const interjectState = new Map<string, InterjectState>()

function interjectKey(channel: string, peerId: string): string {
  return `${channel}:${peerId}`
}



/**
 * 判断此刻能不能插嘴（不改状态）。
 * @param idleMs   两条插嘴之间至少隔多久（默认 8 分钟）
 * @param perHour  每小时最多插几次（默认 3；0 = 不限次数，仍受 idleMs 约束）
 * @returns { ok, reason } —— reason 仅用于日志
 */
export function canInterject(
  channel: string,
  peerId: string,
  idleMs = 8 * 60 * 1000,
  perHour = 3,
): { ok: boolean; reason: string } {
  const st = interjectState.get(interjectKey(channel, peerId))
  const now = Date.now()
  if (st) {
    const since = now - st.lastAt
    if (since < idleMs) {
      return { ok: false, reason: `距上次插嘴仅 ${Math.round(since / 1000)}s（< ${Math.round(idleMs / 1000)}s 冷静期）` }
    }
    if (perHour > 0) {
      const recent = st.stamps.filter(t => now - t < 60 * 60 * 1000)
      if (recent.length >= perHour) {
        return { ok: false, reason: `本群近 1 小时已插嘴 ${recent.length} 次（上限 ${perHour}）` }
      }
    }
  }
  return { ok: true, reason: '' }
}

/** 记一次插嘴（成功后调用）；同时兼作「机器人发言过」的标记 */
export function markInterject(channel: string, peerId: string, at = Date.now()): void {
  const k = interjectKey(channel, peerId)
  const st = interjectState.get(k) || { lastAt: 0, stamps: [] }
  st.lastAt = at
  st.stamps = st.stamps.filter(t => at - t < 60 * 60 * 1000)
  st.stamps.push(at)
  interjectState.set(k, st)
}

/** 机器人**正常回复**（被 @）也刷新"最后发言时间" —— 刚回完不该马上又插一句 */
export function markBotSpoke(channel: string, peerId: string, at = Date.now()): void {
  const k = interjectKey(channel, peerId)
  const st = interjectState.get(k) || { lastAt: 0, stamps: [] }
  st.lastAt = at
  interjectState.set(k, st)
}

