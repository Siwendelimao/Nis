/**
 * 群成员目录（0912 十四批）—— 让 AI 分得清「群里谁在说话」。
 *
 * 背景：QQ 群 @消息事件里带 `author.member_openid`（**群内**唯一，同一个 QQ 号在不同群里不同）、
 * `author.username`（昵称，平台较新版本才下发）、`author.member_role`（member/admin/owner）。
 * 之前代码只取了 group_openid，把发送者整个丢了 —— AI 因此「不知道是谁在说话」。
 *
 * 落盘：data/channels/member-directory.json
 *   { version, peers: { "<channel>:<peerId>": { members: { [memberId]: MemberInfo } } } }
 *
 * 标签规则（给 AI 看的稳定称呼）：
 *   · 平台给了昵称 → 用昵称（后面可带角色，如「九日（群主）」）
 *   · 没给昵称 → 「群成员N」，N 按**首次出现顺序**分配且永不变（同一个人跨轮次始终是同一个 N）
 *   为什么需要兜底：平台对群成员昵称是灰度下发的，拿不到时至少要能区分「同一个人 / 换了个人」。
 */
import fs from 'node:fs'
import path from 'node:path'
import { DATA_ROOT } from '../paths.ts'

const FILE = path.join(DATA_ROOT, 'channels', 'member-directory.json')
/** 单个群最多记多少人（防极端群里把文件撑爆） */
const MAX_PER_PEER = 80

interface MemberInfo {
  id: string
  /** 展示用标签（昵称或「群成员N」）—— 给 AI 看的稳定称呼 */
  label: string
  /** 平台下发的昵称（可能没有） */
  name?: string
  /** member / admin / owner */
  role?: string
  /** 发言次数 */
  count: number
  firstAt: number
  lastAt: number
}

interface StoreShape {
  version: number
  peers: Record<string, { members: Record<string, MemberInfo>, seq: number }>
}

let cache: StoreShape | null = null

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
    console.warn('[memberDirectory] 读取失败，回退空表:', e)
  }
  cache = { version: 1, peers: {} }
  return cache
}

function persist(): void {
  const data = load()
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true })
    const tmp = FILE + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8')
    fs.renameSync(tmp, FILE)
  } catch (e) {
    console.error('[memberDirectory] 落盘失败:', e)
  }
}

function peerKey(channel: string, peerId: string): string {
  return `${channel}:${peerId}`
}

/** 角色中文（给提示词直接用） */
export function roleLabel(role?: string): string {
  if (role === 'owner') return '群主'
  if (role === 'admin') return '管理员'
  return ''
}

/**
 * 识别一条消息的发送者：登记 + 返回稳定标签。
 * @returns 该成员的目录信息（label 可直接写进提示词）
 */
export function identifyMember(
  channel: string,
  peerId: string,
  memberId: string,
  opts: { name?: string; role?: string } = {},
): MemberInfo {
  const data = load()
  const pk = peerKey(channel, peerId)
  if (!data.peers[pk]) data.peers[pk] = { members: {}, seq: 0 }
  const box = data.peers[pk]
  const id = String(memberId || '').trim() || 'unknown'
  const name = String(opts.name || '').trim()
  const role = String(opts.role || '').trim() || undefined
  const now = Date.now()
  let m = box.members[id]
  if (!m) {
    box.seq += 1
    m = {
      id,
      // 首次出现：有昵称用昵称，没有就按顺序给「群成员N」
      label: name || `群成员${box.seq}`,
      name: name || undefined,
      role,
      count: 0,
      firstAt: now,
      lastAt: now,
    }
    box.members[id] = m
    // 超出上限时淘汰最久未发言的（保留 seq 不回退，标签不会串）
    const ids = Object.keys(box.members)
    if (ids.length > MAX_PER_PEER) {
      const oldest = ids.sort((a, b) => (box.members[a].lastAt || 0) - (box.members[b].lastAt || 0))[0]
      if (oldest && oldest !== id) delete box.members[oldest]
    }
  } else {
    // 补昵称/角色（平台可能这次才下发），但**不改已分配的编号标签**，否则 AI 眼里的"人"会变
    if (name && !m.name) { m.name = name; if (/^群成员\d+$/.test(m.label)) m.label = name }
    if (role && m.role !== role) m.role = role
  }
  m.count += 1
  m.lastAt = now
  persist()
  return { ...m }
}

/** 该对端最近活跃的成员列表（给提示词做「群里都有谁」的上下文） */
export function listMembers(channel: string, peerId: string, limit = 6): MemberInfo[] {
  const box = load().peers[peerKey(channel, peerId)]
  if (!box) return []
  return Object.values(box.members)
    .sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0))
    .slice(0, limit)
    .map(m => ({ ...m }))
}



/**
 * 出站 @ 处理（0913 修正版 —— ⚠️ 上一版把 `<@openid>` 拼进正文，真机实测翻车）。
 *
 * **教训**：`<@openid>` 只用于**下行事件**（平台推给我们的消息里 @ 是这个写法）；
 * 发送侧拼它，QQ 会**原样把这段代码显示出来**，且对方收不到 @（用户截图"露出了代码、没艾特到"）。
 * 正确做法：**纯文本 `@昵称`** —— 用户早期截图里的真 @，就是 AI 自己写 `@昵称` 被 QQ 客户端渲染的。
 *
 * 本函数只做两件事：
 *   ① 剥掉误留在正文里的 `<@id>` 字面量（旧实现 / 模型模仿产物）；
 *   ② 正文一个 @ 都没有、又知道是谁问的 → 补一个 `@昵称`。
 */
export function toMentionText(text: string, senderName?: string): string {
  const out = String(text || '')
    .replace(/<@!?[A-Za-z0-9_=-]{4,}>/g, '') // 剥残留的 id 字面量
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
  if (!out) return senderName ? `@${senderName}` : ''
  // 已有 @某人（纯文本）就不补，避免重复
  if (!/@[^\s@，。！？、,.!?]{1,24}/.test(out) && senderName) return `@${senderName} ${out}`
  return out
}
