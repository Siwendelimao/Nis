/**
 * 定时任务「待回复通知」台账（0912 十九批）。
 *
 * 场景（用户设计）：通知是**穿插**进你当前通道的 —— 它不抢你正在聊的对话的落点。
 * 那你想就这条通知追问时，总得有个东西告诉机器人「我在回哪一条」：
 *   · `/通知`          → 列出最近几条（序号 + 任务名 + 时间）
 *   · `/回复通知 内容`  → 追问最近一条（`/回复通知2 内容` 指定第 2 条）
 *
 * 本模块只管记账（谁、什么时候、哪个任务、落在哪条支线会话），不涉及发送。
 * 落盘 data/channels/notices.json（防抖 2s），每对端最多留 10 条。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { DATA_ROOT } from '../paths.ts'

const FILE = path.join(DATA_ROOT, 'channels', 'notices.json')
const MAX_PER_PEER = 10
const PERSIST_DEBOUNCE_MS = 2000

interface ChannelNotice {
  id: string
  at: number
  taskId: string
  taskName: string
  /** 这条通知所在的支线会话（追问就送进它） */
  sessionId: string
  /** 发出去的通知正文（短摘要，列表展示用） */
  text: string
  /** 已经追问过的时间（0/未设 = 还没追问） */
  repliedAt?: number
}

interface StoreShape {
  version: number
  peers: Record<string, ChannelNotice[]>
}

let cache: StoreShape | null = null
let timer: NodeJS.Timeout | null = null

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
    console.warn('[notices] 读取失败，回退空表:', e)
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
    console.error('[notices] 落盘失败:', e)
  }
}

function schedulePersist(): void {
  if (timer) return
  timer = setTimeout(() => { timer = null; persistNow() }, PERSIST_DEBOUNCE_MS)
  timer.unref?.()
}

function peerKey(channel: string, botId: string, peerId: string): string {
  return `${channel}:${botId || '-'}:${peerId}`
}

/** 记一条已发出的通知（推送成功后调用） */
export function recordNotice(
  channel: string,
  botId: string,
  peerId: string,
  n: { taskId: string; taskName: string; sessionId: string; text: string },
): ChannelNotice {
  const data = load()
  const pk = peerKey(channel, botId, peerId)
  const arr = data.peers[pk] || (data.peers[pk] = [])
  const item: ChannelNotice = {
    id: `nt_${Date.now().toString(36)}_${crypto.randomBytes(2).toString('hex')}`,
    at: Date.now(),
    taskId: String(n.taskId || ''),
    taskName: String(n.taskName || '定时任务'),
    sessionId: String(n.sessionId || ''),
    text: String(n.text || '').replace(/\s+/g, ' ').slice(0, 160),
  }
  arr.push(item)
  if (arr.length > MAX_PER_PEER) arr.splice(0, arr.length - MAX_PER_PEER)
  schedulePersist()
  return { ...item }
}

/** 最近的通知（新的排前面，便于「默认最近一条」） */
export function listNotices(channel: string, botId: string, peerId: string, limit = 5): ChannelNotice[] {
  const arr = load().peers[peerKey(channel, botId, peerId)] || []
  return arr.slice(-limit).reverse().map(n => ({ ...n }))
}

/** 标记某条已被追问（列表里区分"已回复"） */
export function markNoticeReplied(channel: string, botId: string, peerId: string, id: string): void {
  const arr = load().peers[peerKey(channel, botId, peerId)] || []
  const hit = arr.find(n => n.id === id)
  if (!hit) return
  hit.repliedAt = Date.now()
  schedulePersist()
}

/** 清空某任务的待回复通知台账（任务删除时顺手清理，不留死数据） */
export function clearNoticesByTask(taskId: string): number {
  const data = load()
  let n = 0
  for (const [k, arr] of Object.entries(data.peers)) {
    const before = arr.length
    data.peers[k] = arr.filter(x => x.taskId !== taskId)
    n += before - data.peers[k].length
    if (!data.peers[k].length) delete data.peers[k]
  }
  if (n) schedulePersist()
  return n
}

