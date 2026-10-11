/**
 * 对端显示名（0912 十七批）—— 「多个群聊怎么区分」的基础设施。
 *
 * 问题：一个机器人可能进了好几个群，会话标题是**会话自己**的（可重名、可被改），
 * 光看标题根本分不清哪个是哪个群；而 openid（60B6CC…）人又看不懂。
 *
 * 方案：给每个「对端」（channel + botId + peerId）一个稳定显示名：
 *   · 群聊自动分配 群A / 群B / 群C…（按首次出现顺序，**永不复用已分配的字母**）
 *   · 私聊默认「私聊」
 *   · 允许自定义改名（改成"家人群""工作群"都行）—— auto=false 后不再自动生成
 *
 * 落盘：data/channels/peer-labels.json
 */
import fs from 'node:fs'
import path from 'node:path'
import { DATA_ROOT } from '../paths.ts'

const FILE = path.join(DATA_ROOT, 'channels', 'peer-labels.json')
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'

interface PeerLabel {
  /** 显示名 */
  label: string
  /** 对端类型（c2c/group/channel）—— 便于列表分组 */
  kind?: string
  /** true = 系统自动分配的（改了名就变 false） */
  auto: boolean
  firstAt: number
}

interface StoreShape {
  version: number
  peers: Record<string, PeerLabel>
}

let cache: StoreShape | null = null

function load(): StoreShape {
  if (cache) return cache
  try {
    if (fs.existsSync(FILE)) {
      const raw = JSON.parse(fs.readFileSync(FILE, 'utf-8'))
      if (raw && typeof raw === 'object' && raw.peers && typeof raw.peers === 'object') {
        cache = { version: 1, peers: raw.peers }
        dedupeAutoPrivateLabels(cache)
        return cache
      }
    }
  } catch (e) {
    console.warn('[peerLabels] 读取失败，回退空表:', e)
  }
  cache = { version: 1, peers: {} }
  return cache
}

/**
 * 二十一批迁移：历史数据里同一机器人的多个私聊都叫「私聊」——
 * 列表/通知位置里出现两个一模一样的条目（用户实测）。这里给**自动命名**的重复项重新编号：
 * 最早的保持「私聊」，其余按 firstAt 依次「私聊2」「私聊3」…（手填名不动）。
 */
function dedupeAutoPrivateLabels(data: StoreShape): void {
  const groups = new Map<string, Array<{ v: PeerLabel }>>()
  for (const [k, v] of Object.entries(data.peers)) {
    if (v.kind === 'group' || v.kind === 'channel') continue
    if (!v.auto) continue
    if (v.label !== '私聊' && !/^私聊\d+$/.test(v.label)) continue
    const prefix = k.split(':').slice(0, 2).join(':')
    const arr = groups.get(prefix) || []
    arr.push({ v })
    groups.set(prefix, arr)
  }
  let changed = false
  for (const arr of groups.values()) {
    if (arr.length < 2) continue
    arr.sort((a, b) => (a.v.firstAt || 0) - (b.v.firstAt || 0))
    arr.forEach((it, i) => {
      const want = i === 0 ? '私聊' : `私聊${i + 1}`
      if (it.v.label !== want) { it.v.label = want; changed = true }
    })
  }
  if (changed) {
    console.log('[peerLabels] 已重新编号重复的「私聊」标签（二十一批迁移）')
    persist()
  }
}

function persist(): void {
  const data = load()
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true })
    const tmp = FILE + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8')
    fs.renameSync(tmp, FILE)
  } catch (e) {
    console.error('[peerLabels] 落盘失败:', e)
  }
}

function key(channel: string, botId: string, peerId: string): string {
  return `${channel}:${botId || '-'}:${peerId}`
}

/** 自动分配：群聊 → 群A/群B…；私聊 → 私聊/私聊2/私聊3…（都跳过已占用，永不复用）
 *  ⚠️ 私聊必须编号（二十一批修）：同一机器人可能有多个私聊对端，
 *  全都叫「私聊」时列表/通知位置里会出现两个一模一样的「QQ · Nis · 私聊」（用户实测反馈）。 */
function autoLabel(data: StoreShape, channel: string, botId: string, kind?: string): string {
  const sameBot = (k: string, v: PeerLabel) => k.startsWith(`${channel}:`) && k.includes(`:${botId || '-'}:`) && v
  if (kind !== 'group' && kind !== 'channel') {
    // 私聊：第一个「私聊」，之后 私聊2、私聊3…
    let n = 0
    for (const [k, v] of Object.entries(data.peers)) {
      if (!sameBot(k, v)) continue
      if (v.kind === 'group' || v.kind === 'channel') continue
      n++
    }
    return n === 0 ? '私聊' : `私聊${n + 1}`
  }
  const used = new Set<string>()
  for (const [k, v] of Object.entries(data.peers)) {
    if (!sameBot(k, v)) continue
    if (v.kind !== 'group' && v.kind !== 'channel') continue
    used.add(v.label)
  }
  for (const ch of LETTERS) {
    const cand = `群${ch}`
    if (!used.has(cand)) return cand
  }
  return `群${Object.keys(data.peers).length + 1}`
}

/**
 * 取对端显示名（首次访问时自动分配并落盘）。
 * @param kind 对端类型（群聊/私聊）—— 只在首次分配时用到
 */
export function labelFor(channel: string, botId: string, peerId: string, kind?: string): string {
  if (!peerId) return ''
  const data = load()
  const k = key(channel, botId, peerId)
  const hit = data.peers[k]
  if (hit?.label) {
    // 类型后补（老记录没有 kind）
    if (kind && !hit.kind) { hit.kind = kind; persist() }
    return hit.label
  }
  const label = autoLabel(data, channel, botId, kind)
  data.peers[k] = { label, kind, auto: true, firstAt: Date.now() }
  persist()
  return label
}

/**
 * 写对端显示名。
 * @param opts.auto true = 系统写入（如从平台拉到的真实群名），仍属自动 → 之后还能被覆盖/再更新；
 *                  省略 = 用户手填（auto=false，之后不再被自动逻辑覆盖）
 */
export function setPeerLabel(
  channel: string,
  botId: string,
  peerId: string,
  label: string,
  kind?: string,
  opts: { auto?: boolean } = {},
): PeerLabel | null {
  if (!peerId) return null
  const name = String(label || '').trim().slice(0, 30)
  if (!name) return null
  const data = load()
  const k = key(channel, botId, peerId)
  const prev = data.peers[k]
  // 用户手填过（auto=false）的名字优先，平台群名不许覆盖它
  if (opts.auto && prev && prev.auto === false) return { ...prev }
  data.peers[k] = { label: name, kind: kind || prev?.kind, auto: !!opts.auto, firstAt: prev?.firstAt || Date.now() }
  persist()
  return { ...data.peers[k] }
}

/** 全部对端显示名（调试/列表用） */
export function allPeerLabels(): Record<string, PeerLabel> {
  const out: Record<string, PeerLabel> = {}
  for (const [k, v] of Object.entries(load().peers)) out[k] = { ...v }
  return out
}
