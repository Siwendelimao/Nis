/**
 * PC 会话接管的准入闸（★1014f）—— 配对码 + 对端白名单
 *
 * 为什么需要：`/pc` 让手机（QQ/微信）能接管**用户在 PC 上干活的项目会话**
 * （工作区 = 项目目录，能读写文件）。而 QQ / 微信机器人是**公开可私聊**的
 * （任何人加了机器人就能给它发消息）—— 不加闸的话，陌生人一句 `/pc`
 * 就能列到用户全部项目标题、还切进去读写他的硬盘。
 *
 * 规则（三道）：
 *   ① 只在**私聊**放行（群聊/频道一律拒绝：群里任何人都能 @，等于把硬盘挂群公告）
 *   ② 私聊也要先**配对**：用户拿到后端侧 6 位配对码，私聊发 `/pc <码>` 一次 → 永久放行
 *   ③ 配对码连错 5 次 → 该对端锁 10 分钟（防暴力猜）
 *
 * 落盘：`<DATA_ROOT>/channels/pc-access.json`（原子写；配对码与白名单）
 */
import fs from 'node:fs'
import path from 'node:path'
import { DATA_ROOT } from '../paths.ts'

const FILE = path.join(DATA_ROOT, 'channels', 'pc-access.json')

interface PairedPeer {
  channel: string
  botId: string
  peerId: string
  /** 配对时间 */
  at: number
}

interface StoreShape {
  version: number
  /** 6 位配对码（**兜底/旧数据用**；用户从后端日志/本文件取；不随消息外发） */
  pairCode: string
  /**
   * ★1015：**每台机器人各自的配对码**（需求要求：每个机器人配不一样的码）。
   * 取码规则：`botCodes[botId]` 有就用它；没有就**自动生成一个**（互不相同，天然隔离）。
   * 旧的全局 `pairCode` 只作兜底（老文件没有 botCodes 时照样能用）。
   */
  botCodes?: Record<string, string>
  paired: Record<string, PairedPeer>
}

let cache: StoreShape | null = null
/** 试错计数（内存态即可：进程重启后重置，够用且不落盘泄露） */
const fails = new Map<string, { n: number; until: number }>()
const MAX_FAIL = 5
const LOCK_MS = 10 * 60 * 1000

function keyOf(channel: string, botId: string, peerId: string): string {
  return `${channel}:${botId}:${peerId}`
}

function newPairCode(): string {
  return String(Math.floor(100000 + Math.random() * 900000))
}

function persist(): void {
  if (!cache) return
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true })
    const tmp = FILE + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), 'utf-8')
    fs.renameSync(tmp, FILE)
  } catch (e) {
    console.error('[pcAccess] 落盘失败:', e)
  }
}

function load(): StoreShape {
  if (cache) return cache
  try {
    if (fs.existsSync(FILE)) {
      const raw = JSON.parse(fs.readFileSync(FILE, 'utf-8'))
      const pairCode = String(raw?.pairCode || '')
      cache = {
        version: 1,
        pairCode: pairCode || newPairCode(),
        botCodes: (raw?.botCodes && typeof raw.botCodes === 'object') ? raw.botCodes : {},
        paired: (raw?.paired && typeof raw.paired === 'object') ? raw.paired : {},
      }
      // 老文件（早期手写的白名单）没有码 → 补一个
      if (!pairCode) persist()
      return cache
    }
  } catch (e) {
    console.warn('[pcAccess] 读取失败，重建:', e)
  }
  cache = { version: 1, pairCode: newPairCode(), botCodes: {}, paired: {} }
  persist()
  return cache
}

/** 已打过日志的码（避免重复刷屏） */
const loggedCodes = new Set<string>()

/**
 * 取**某台机器人**的配对码（不存在则自动生成）。顺手往控制台打一次 —— 用户就是这么拿到码的。
 * ⚠️ 码**只在 PC 端可见**，绝不回给 IM（否则等于没闸）。
 * 不传 botId → 旧口径：用全局兜底码（兼容老数据）。
 */
export function getPairCode(botId?: string): string {
  const data = load()
  const bid = String(botId || '').trim()
  if (!bid) return data.pairCode
  if (!data.botCodes) data.botCodes = {}
  let code = data.botCodes[bid]
  if (!code) {
    code = newPairCode()
    data.botCodes[bid] = code
    persist()
  }
  if (!loggedCodes.has(bid + ':' + code)) {
    loggedCodes.add(bid + ':' + code)
    console.log(`[pcAccess] 机器人 ${bid} 的 PC 接管配对码 = ${code}（私聊它发「/pc ${code}」即放行；存于 ${FILE}）`)
  }
  return code
}

/**
 * ★1015：换码（需求要求"能换"）。给某台机器人换新码，**并撤销它名下已配对的对端**
 * —— 换码的语义就是"作废旧授权"，否则旧设备照样能用，换了等于没换。
 * 不传 botId → 换全局兜底码，并清空全部配对。
 */
export function rotateCode(botId?: string): string {
  const data = load()
  const bid = String(botId || '').trim()
  const code = newPairCode()
  if (bid) {
    if (!data.botCodes) data.botCodes = {}
    data.botCodes[bid] = code
    for (const [k, v] of Object.entries(data.paired)) {
      if (v.botId === bid) delete data.paired[k]
    }
    loggedCodes.delete(bid + ':' + code)
  } else {
    data.pairCode = code
    data.paired = {}
    loggedCodes.clear()
  }
  persist()
  console.log(`[pcAccess] 已换码（${bid || '全局'}）→ ${code}；该机器人的已配对授权已撤销`)
  return code
}

export function isPaired(channel: string, botId: string, peerId: string): boolean {
  return !!load().paired[keyOf(channel, botId, peerId)]
}

/** 尝试配对 → 'ok' 成功 / 'bad' 码不对 / 'locked' 锁定中 */
export function tryPair(channel: string, botId: string, peerId: string, code: string): 'ok' | 'bad' | 'locked' {
  const k = keyOf(channel, botId, peerId)
  const now = Date.now()
  const f = fails.get(k)
  if (f && f.until > now) return 'locked'
  const data = load()
  // ★1015：比对**这台机器人自己的码**（没有 botId 时回退全局兜底码）
  if (String(code).trim() !== getPairCode(botId)) {
    const n = ((f && f.until <= now) ? f.n : 0) + 1
    fails.set(k, { n, until: n >= MAX_FAIL ? now + LOCK_MS : 0 })
    console.warn(`[pcAccess] 配对码错误（${channel}:${botId}:${peerId.slice(0, 8)}，第 ${n} 次）`)
    return 'bad'
  }
  fails.delete(k)
  data.paired[k] = { channel, botId, peerId, at: now }
  persist()
  console.log(`[pcAccess] 已放行对端：${k}`)
  return 'ok'
}



/** 落盘路径（提示文案里要让用户照着找） */
export function pcAccessFilePath(): string {
  return FILE
}
