import { defineStore } from 'pinia'
import { ref } from 'vue'

/**
 * externalChat —— 外部会话（codex 等外部 agent）的 part 流前端数据层（P0 契约 1010）。
 *
 * 两个来源，同一形状（PartEvent）：
 *   ① SSE 实时帧：{ type: 'ext-stream', sessionId, seq, part }（ChatInterface 收帧后喂 ingestFrame）
 *   ② 回放：session.extTranscript（seedFromHistory，随会话打开/对账播种）
 * seq 断序容错：乱序先缓冲、补齐再渲染；缺号（丢了/迟到未补）等待 GAP_WAIT_MS 后按到序补渲，
 * 不阻塞渲染（契约「乱序先缓冲补齐再渲染，缺号按到序渲染+标记，不阻塞」）。
 * 渲染层（PiChatView 分支 → ExternalStream）只读 partsFor()，live 与回放同一渲染路径。
 */

/** P0 契约（1010）：PartEvent —— 归一层输出 = ext-stream 帧体 = extTranscript 落盘体，同一形状。 */
export type PartEvent =
  | { kind: 'text'; seq: number; t: number; delta: string }
  | { kind: 'thought'; seq: number; t: number; delta: string }
  | { kind: 'tool-start'; seq: number; t: number; id: string; name: string; summary: string }
  | { kind: 'tool-end'; seq: number; t: number; id: string; detail?: string; isError?: boolean }
  | { kind: 'usage'; seq: number; t: number; inputTokens: number; cachedReadTokens: number; completionTokens: number; thoughtTokens?: number }
  | { kind: 'info'; seq: number; t: number; text: string }
  | { kind: 'turn-end'; seq: number; t: number; stopReason: string; ok: boolean; reason?: string }

/** 轮段切分：每个 turn-end 收一段；尾部未收轮的余量（live 过程态）单独一段。live 与回放同口径。 */
export function splitTurns(parts: PartEvent[]): PartEvent[][] {
  const segs: PartEvent[][] = []
  let cur: PartEvent[] = []
  for (const p of parts || []) {
    cur.push(p)
    if (p.kind === 'turn-end') { segs.push(cur); cur = [] }
  }
  if (cur.length) segs.push(cur)
  return segs
}

interface SessMeta {
  /** 本会话走外部流（存在 extTranscript 或收到过 ext-stream 帧） */
  external: boolean
  /** 回放已查过（seedFromHistory 跑过；旧会话=查过但没有 extTranscript） */
  seeded: boolean
  /** 已渲染的 seq 集（重复帧去重：前端偶发重连会产生短暂双 SSE 连接，事件双份） */
  applied: Set<number>
  /** 已渲染的最大 seq（断序判定基准） */
  lastSeq: number
  /** 乱序缓冲：seq → part（等补齐） */
  buffer: Map<number, PartEvent>
  gapTimer: ReturnType<typeof setTimeout> | null
  /** 缺号记录（丢了的 seq，按到序补渲后留痕=契约「+标记」；暴露问题不遮盖） */
  gaps: number[]
}

/** 断序补齐等待：超时仍缺号 → 按到序补渲不阻塞（渲染等的是人，不许被丢帧卡住） */
const GAP_WAIT_MS = 500

const EMPTY: PartEvent[] = []

export const useExternalChatStore = defineStore('externalChat', () => {
  /** sid → PartEvent[]（响应式，渲染层直接消费） */
  const partsByConv = ref<Record<string, PartEvent[]>>({})
  /** sid → 是否外部会话（响应式标记） */
  const externalByConv = ref<Record<string, boolean>>({})
  /** 非响应式簿记（seq 去重/断序缓冲；只在 store 动作里读写） */
  const meta = new Map<string, SessMeta>()

  /* ★1005：只在内存里跟最近 N 个外部会话 —— 原来 meta / partsByConv / externalByConv **只增不清**，
     用久了无界增长（parts 是完整 part 流，最占内存）。淘汰是**安全**的：三者一起清 ⇒
     该会话退回 pi transcript 路径（有镜像正文，不会白屏）；重新打开时 seedFromHistory 会从后端
     extTranscript 回放重建（同一渲染路径）。保守取 12：正常用法（1~3 个外部会话）永远碰不到上限。 */
  const MAX_TRACKED_SESSIONS = 12
  const trackedOrder: string[] = []
  function touchTracked(sid: string): void {
    const i = trackedOrder.indexOf(sid)
    if (i >= 0) trackedOrder.splice(i, 1)
    trackedOrder.push(sid)
    while (trackedOrder.length > MAX_TRACKED_SESSIONS) {
      const old = trackedOrder.shift() as string
      if (!old) break
      meta.delete(old)
      delete partsByConv.value[old]
      delete externalByConv.value[old]
    }
  }

  function metaOf(sid: string): SessMeta {
    let m = meta.get(sid)
    if (!m) {
      m = { external: false, seeded: false, applied: new Set(), lastSeq: 0, buffer: new Map(), gapTimer: null, gaps: [] }
      meta.set(sid, m)
    }
    touchTracked(sid)   // ★1005：每次访问都刷新 LRU ⇒ 正在用的会话一定不会被淘汰
    return m
  }
  function arrOf(sid: string): PartEvent[] {
    if (!partsByConv.value[sid]) partsByConv.value[sid] = []
    return partsByConv.value[sid]
  }
  function markExternal(sid: string): void {
    metaOf(sid).external = true
    externalByConv.value[sid] = true
  }

  function isExternal(sid: string): boolean {
    return !!externalByConv.value[String(sid || '')]
  }
  function partsFor(sid: string): PartEvent[] {
    return partsByConv.value[String(sid || '')] || EMPTY
  }
  function gapsOf(sid: string): number[] {
    return metaOf(String(sid || '')).gaps.slice()
  }

  /** 最近一条回复正文（收轮副作用用：侧栏预览）——取最后一轮的 text delta 合并文本。 */
  function lastText(sessionId: string): string {
    const segs = splitTurns(partsFor(String(sessionId || '')))
    for (let i = segs.length - 1; i >= 0; i--) {
      let out = ''
      for (const p of segs[i]) if (p.kind === 'text') out += p.delta
      if (out.trim()) return out.trim()
    }
    return ''
  }

  function apply(m: SessMeta, arr: PartEvent[], part: PartEvent, seq?: number): void {
    if (seq != null) {
      m.applied.add(seq)
      if (seq > m.lastSeq) m.lastSeq = seq
    }
    arr.push(part)
  }
  /** 缓冲里有连续号就按序补渲（补齐再渲染） */
  function drain(m: SessMeta, arr: PartEvent[]): void {
    while (m.buffer.has(m.lastSeq + 1)) {
      const s = m.lastSeq + 1
      const p = m.buffer.get(s) as PartEvent
      m.buffer.delete(s)
      apply(m, arr, p, s)
    }
    if (!m.buffer.size && m.gapTimer) { clearTimeout(m.gapTimer); m.gapTimer = null }
  }
  function armGap(m: SessMeta, arr: PartEvent[]): void {
    if (m.gapTimer) return
    m.gapTimer = setTimeout(() => {
      m.gapTimer = null
      if (!m.buffer.size) return
      /* 缺号（迟到未补/真丢）：按到序补渲不阻塞 —— 把缺的 seq 记痕（+标记）后从缓冲最小号起补渲 */
      let min = Infinity
      for (const s of m.buffer.keys()) if (s < min) min = s
      for (let s = m.lastSeq + 1; s < min; s++) m.gaps.push(s)
      if (m.gaps.length > 200) m.gaps.splice(0, m.gaps.length - 200)
      if (m.gaps.length <= 20) console.warn('[ExternalStream] seq 断号，按到序补渲不阻塞：', m.gaps.slice(-20))
      m.lastSeq = min - 1
      drain(m, arr)
    }, GAP_WAIT_MS)
  }

  /** SSE 实时帧入口（ChatInterface 的 ext-stream case 调用） */
  function ingestFrame(sessionId: string, seq: unknown, part: PartEvent): void {
    const sid = String(sessionId || '')
    if (!sid || !part) return
    markExternal(sid)
    const m = metaOf(sid)
    const arr = arrOf(sid)
    const s = Number(seq)
    if (!Number.isFinite(s)) { apply(m, arr, part); return }   // 无 seq 脏帧：直接落，不丢内容（契约帧恒带 seq）
    if (m.lastSeq === 0 && m.applied.size === 0 && !m.seeded) { apply(m, arr, part, s); return }   // ★1010e 首帧锚定：新开页账本是空的、帧却续旧账（如 28 起）——别当缺号干等，直接锚上
    if (s <= m.lastSeq) return                                 // 重复帧（重连双流）/ 缺号已按到序补渲后的迟到帧
    if (s === m.lastSeq + 1) { apply(m, arr, part, s); drain(m, arr); return }
    m.buffer.set(s, part)                                      // 断序：先缓冲，等补齐
    armGap(m, arr)
  }

  function rebuildSeq(m: SessMeta, arr: PartEvent[]): void {
    m.applied.clear()
    m.buffer.clear()
    if (m.gapTimer) { clearTimeout(m.gapTimer); m.gapTimer = null }
    m.lastSeq = 0
    for (const p of arr) {
      const s = Number((p as { seq?: number }).seq)
      if (Number.isFinite(s)) {
        m.applied.add(s)
        if (s > m.lastSeq) m.lastSeq = s
      }
    }
  }

  /** 回放播种（会话打开/对账拿到 session.history 时调用）：回放 = 重放 extTranscript，天然不乱序。 */
  function seedFromHistory(sessionId: string, payload: unknown): void {
    const sid = String(sessionId || '')
    if (!sid) return
    const m = metaOf(sid)
    m.seeded = true
    /* 契约（1010）：回放源 = session.extTranscript（PartEvent[]）。
       RPC 回包信封契约未钉死（session.history 直出 / 挂在 session 对象下），两处都认。 */
    const p = payload as { extTranscript?: unknown; session?: { extTranscript?: unknown } } | null
    const raw = Array.isArray(p?.extTranscript) ? p.extTranscript
      : Array.isArray(p?.session?.extTranscript) ? p.session.extTranscript
      : null
    /* ★1005 修复（实测反馈「重启后端后对话内容直接不显示」）：
       **空数组必须等同于"没有外部流"**。后端 session.history 曾恒输出 `extTranscript: []`
       （见 server.ts 的 `|| []`），而这里原判据只认 `Array.isArray` ⇒ 普通会话被误标成外部会话，
       后果是双重的：
         ① 渲染切到 ExternalStream（0 段）= **整窗空白**（PiChatView `v-if="extActive"` 把 pi 列表整个换掉）；
         ② ChatInterface 对外部会话会**直接丢弃该会话的 live agent-event**（不进 piChat）⇒ 对话变哑。
       真·外部会话不受影响：它一有实时帧 ingestFrame 就自行 markExternal，回放时 extTranscript 也非空。 */
    if (!raw || raw.length === 0) return   // 旧会话 / 普通会话：走现有 pi transcript 路径，两路并存互不干扰
    markExternal(sid)
    const arr = arrOf(sid)
    if (!arr.length) {
      for (const part of raw) arr.push(part as PartEvent)
      rebuildSeq(m, arr)
      return
    }
    /* 已有实时帧（开着会话时对账/播种）：同 seq 去重并轨，按 t+seq 归序（t=同一后端进程的 Date.now()，同源可比）。
       回放值后写覆盖实时值（落盘为权威）。 */
    const bySeq = new Map<number, PartEvent>()
    const noSeq: PartEvent[] = []
    for (const part of [...arr, ...raw] as PartEvent[]) {
      const s = Number((part as { seq?: number }).seq)
      if (Number.isFinite(s)) bySeq.set(s, part)
      else noSeq.push(part)
    }
    const merged = [...bySeq.values(), ...noSeq].sort((a, b) => (Number(a.t) - Number(b.t)) || (Number(a.seq) - Number(b.seq)))
    arr.splice(0, arr.length, ...merged)
    rebuildSeq(m, arr)
  }

  return { partsByConv, externalByConv, isExternal, partsFor, gapsOf, lastText, ingestFrame, seedFromHistory }
})
