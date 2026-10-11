/**
 * 会话执行日志 —— 每会话一条时间线（JSONL 落盘），运行面板数据源。
 *
 * logEvent(sessionId, level, category, message, data?)
 *   level: info | warn | error
 *   category: lifecycle | llm | tool | approval | install | mcp | session
 * 落盘：backend/data/logs/<sessionId>.jsonl（每行一条）；启动时清理 7 天前旧文件。
 */
import fs from 'node:fs'
import path from 'node:path'
import { DATA_ROOT } from './paths.ts'

const LOGS_DIR = path.join(DATA_ROOT, 'logs')
const MAX_LINES = 2000

/** 内存缓存（避免每次读盘；按会话保留最近 MAX_LINES 条）。
 *  ★1003 批次4 4.41/4.43：np=persist:false（承诺不落盘）；flushed=已追加到磁盘 ——
 *  落盘按"未落且可落"过滤，条目级兑现契约。 */
const memLogs = new Map<string, Array<{ t: number; level: string; category: string; message: string; data?: any; np?: true; flushed?: true }>>()
const dirty = new Set<string>()
let flushTimer: NodeJS.Timeout | null = null

type LogLevel = 'info' | 'warn' | 'error'
type LogCategory = 'lifecycle' | 'llm' | 'tool' | 'approval' | 'install' | 'mcp' | 'session'

/** 从磁盘回读历史（★0926 修「重启后日志历史被冲」）：
 *  flushAll 是**整文件重写**，而 logEvent 只往内存追加 —— 重启后 memLogs 为空，
 *  新会话第一条日志 flush 时就用「仅含新条目」的内存列表把旧文件**整份覆盖**（实测 2eb3636d
 *  重启后首条 10:08:58、36 行，重启前历史全部蒸发）。修：内存首次见到某会话就先读回盘上历史。 */
function hydrateFromDisk(sessionId: string): Array<{ t: number; level: string; category: string; message: string; data?: any }> {
  try {
    if (!/^[0-9a-fA-F-]{8,64}$/.test(sessionId)) return []   // 0906 体检 P3#23：防 '..' 路径拼接
    const file = path.join(LOGS_DIR, `${sessionId}.jsonl`)
    if (!fs.existsSync(file)) return []
    const lines = fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean)
    const out: any[] = []
    for (const l of lines.slice(-MAX_LINES)) {
      /* ★0926c 铁律例外·注明必须理由：JSONL 单行坏=append 写入的固有风险（写一半被杀），
         单行跳过保其余历史可用（数据格式语义要求）；坏行不影响整体，故不逐行报错。 */
      try { out.push({ ...JSON.parse(l), flushed: 1 }) } catch { /* skip 坏行 */ }
    }
    return out
  } catch (e) {
    /* ★0926c 铁律例外·注明必须理由：日志读取必须容错（日志坏了不该拖垮业务/请求）——
       但问题必须可见：打出错误暴露，不无声吞掉。 */
    console.error('[sessionLogger] 读回日志历史失败（容错继续，不拖垮业务）:', e)
    return []
  }
}

/** 记录一条会话事件；persist=false 时不落盘（高频事件自行取舍） */
export function logEvent(sessionId: string, level: LogLevel, category: LogCategory, message: string, data?: any, persist = true): { t: number } {
  const t = Date.now()
  let list = memLogs.get(sessionId)
  if (!list) { list = hydrateFromDisk(sessionId); memLogs.set(sessionId, list) }   // ★0926：先回读历史，防 flush 覆盖旧日志
  const entry: any = { t, level, category, message: String(message).slice(0, 500) }
  if (data !== undefined) {
    try { entry.data = JSON.parse(JSON.stringify(data)) } catch { /* ignore */ }
  }
  /* ★1003 批次4 4.43：persist=false 打 np 标 —— 原来只是"不标 dirty"，后面任意一条真日志
   * 触发整文件重写就把它**捎带落盘**（"不落盘"承诺是假的）。现在 flush 按条目过滤。 */
  if (!persist) entry.np = 1
  list.push(entry)
  if (list.length > MAX_LINES) {
    /* ★1003 批次4 4.41 配套：内存瘦身从最旧开始丢，但**不丢还没落盘的**（丢已落盘/np 的）；
     * 极端全是未落盘时才硬丢最旧防无界增长（罕见，且磁盘侧已改追加不再有覆盖风险）。 */
    let overflow = list.length - MAX_LINES
    for (let i = 0; i < list.length && overflow > 0;) {
      if (list[i].flushed || list[i].np) { list.splice(i, 1); overflow-- } else i++
    }
    if (overflow > 0) list.splice(0, overflow)
  }
  if (persist) {
    dirty.add(sessionId)
    scheduleFlush()
  }
  return { t }
}

let flushTimerAt = 0
function scheduleFlush(delayMs = 800) {
  /* ★1003 批次4 4.42 配套：新事件可**提前唤醒** —— 原来 `if (flushTimer) return`，失败退避
   * （最长 60s）期间的新日志会被压满一分钟才落盘。已有更早的到期点才不动，否则重排。 */
  if (flushTimer && flushTimerAt <= Date.now() + delayMs) return
  if (flushTimer) clearTimeout(flushTimer)
  flushTimerAt = Date.now() + delayMs
  flushTimer = setTimeout(() => {
    flushTimer = null
    flushAll()
  }, delayMs)
}

/** ★0929 P1（刀5 日志丢弃）：每会话连续 flush 失败次数 → 退避重试延迟用 */
const flushFailStreak = new Map<string, number>()

/** ★1003 批次4 4.42：导出给宿主 —— gracefulExit 等收尾路径可显式调用；另有 process 'exit' 钩子兜底 */
function flushAll(): void {
  const failedIds: string[] = []
  for (const sessionId of dirty) {
    const list = memLogs.get(sessionId)
    if (!list) continue
    /* ★1003 批次4 4.41/4.43/4.44 换芯：**只追加未落盘的可落条目**（np 过滤、flushed 去重）——
     * ① 整文件重写曾把 MAX_LINES 之外的磁盘历史静默截掉（重启后首刷=老历史蒸发）；
     * ② persist=false 曾被整写捎带落盘（契约造假）；
     * ③ tmp+rename 整写曾吞掉并发进程的追加（谁后写谁赢）——O_APPEND 追加互不覆盖。
     * 坏行由读侧跳过容忍（写一半被杀只损一行，不损全档）。 */
    const pend = list.filter((e) => !e.flushed && !e.np)
    if (!pend.length) continue
    try {
      fs.mkdirSync(LOGS_DIR, { recursive: true })
      /* ★ 0927 第 0 批：非法 id 用 continue 不用 return —— 旧逻辑一个坏 id 就中断
         其余所有会话的 flush（其余会话的日志静默丢失）。 */
      if (!/^[0-9a-fA-F-]{8,64}$/.test(sessionId)) continue
      const file = path.join(LOGS_DIR, `${sessionId}.jsonl`)
      /* ★1003 4.41 配套：显式轮转（原隐式截断=无警告删史）——超 8MB 留档重开，轮转必留日志，
       * 旧档由 7 天清理回收。 */
      try {
        const st = fs.existsSync(file) ? fs.statSync(file) : null
        if (st && st.size > 8 * 1024 * 1024) {
          const old = `${file}.old-${new Date().toISOString().replace(/[:.]/g, '-')}`
          fs.renameSync(file, old)
          console.warn(`[sessionLogger] 日志超 8MB 已轮转（历史留档 ${old}，7 天清理回收）`)
        }
      } catch { /* 轮转失败不拦追加 */ }
      fs.appendFileSync(file, pend.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf-8')
      for (const e of pend) e.flushed = 1
      flushFailStreak.delete(sessionId)   // ★0929 刀5：成功 → 清失败退避计数
    } catch (e) {
      /* ★ 0927 第 0 批：落盘失败必须可见（旧逻辑静默 ignore——日志丢了没人知道）。
         日志容错（不拖垮业务）但问题必须暴露——0926c 铁律口径保持一致。
         ★1003：追加模式没有 tmp 尸体要清；条目仍 flushed=0，重试会补写。 */
      console.error('[sessionLogger] flush failed:', sessionId, e)
      failedIds.push(sessionId)
    }
  }
  dirty.clear()
  /* ★0929 P1（刀5 日志丢弃·主修）：失败的会话**重新入队 + 退避重试**。
     旧逻辑无条件 dirty.clear() ⇒ flush 失败的日志出队后再也没人补写 ——
     除非该会话恰好再来新事件；否则这批日志**永久丢失**（重启即蒸发）。
     退避：连续失败 n 次 → 5s × 3^(n-1)，60s 封顶（磁盘持续故障时不 800ms 死循环刷屏）。 */
  if (failedIds.length) {
    let delay = 5000
    for (const id of failedIds) {
      const n = (flushFailStreak.get(id) || 0) + 1
      flushFailStreak.set(id, n)
      dirty.add(id)
      delay = Math.max(delay, Math.min(5000 * Math.pow(3, n - 1), 60000))
    }
    scheduleFlush(delay)
  }
}

/** 读会话日志（RPC session.logs） */
export function readSessionLogs(sessionId: string): Array<{ t: number; level: string; category: string; message: string; data?: any }> {
  /* ★1003：内部标记（np/flushed）不外泄 —— 对外仍是纯日志条目 */
  const clean = (arr: any[]) => arr.map(({ np, flushed, ...rest }: any) => rest)
  const mem = memLogs.get(sessionId)
  if (mem && mem.length) return clean([...mem])
  try {
    const out = hydrateFromDisk(sessionId)   // ★0926：与 logEvent 共用同一读盘逻辑
    if (out.length) memLogs.set(sessionId, out)
    return clean(out)
  } catch (e) {
    /* ★0926c 铁律例外·注明必须理由：同 hydrateFromDisk——日志容错但错误必须可见 */
    console.error('[sessionLogger] session.logs 读取失败（容错返回空）:', e)
    return []
  }
}

/** 启动清理：删除 7 天前的日志文件 */
export function cleanupOldLogs(): void {
  try {
    if (!fs.existsSync(LOGS_DIR)) return
    const cutoff = Date.now() - 7 * 24 * 3600 * 1000
    for (const f of fs.readdirSync(LOGS_DIR)) {
      const file = path.join(LOGS_DIR, f)
      try {
        /* ★0929 P1（刀5）：flush 中途失败留下的 tmp 尸体（`.jsonl.tmp-<pid>-<hex>`）
           直接清（内容已由重试机制重写或已进 memLogs，尸体无价值）。 */
        if (f.includes('.jsonl.tmp-')) { fs.rmSync(file, { force: true }); continue }
        const st = fs.statSync(file)
        if (st.mtimeMs < cutoff) fs.rmSync(file, { force: true })
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

/* ★1003 批次4 4.42：进程退出前**同步必刷** —— 原来只有 800ms debounce（失败还退避到 60s），
 * 关机/崩溃前写进内存的日志（含错误日志）全部蒸发。fs 写是同步的，'exit' 钩子里照常能跑；
 * gracefulExit 最终走 process.exit → 必经此钩子。 */
process.on('exit', () => { try { flushAll() } catch { /* 退出路径不抛 */ } })
