/**
 * 计费统计（pi-bridge 侧）：每次 LLM 调用的 token 用量与费用
 *
 * - recordUsage: 每次流结束后记录（按供应商/模型）
 * - stats: 按周期聚合（day/week/month/all）
 * - 价格：优先模型表里配置的 inputPrice/outputPrice（$/1M tokens），无配置按 0
 */
import fs from 'node:fs'
import path from 'node:path'
import { getState } from './providers.ts'
import { DATA_ROOT } from './paths.ts'
import { loadJsonOrBackup, persistJson } from './jsonStore.ts'

interface UsageRecord {
  ts: number
  provider: string
  model: string
  promptTokens: number
  completionTokens: number
  /** 缓存命中 token（LongCat/DeepSeek 单列上报——官方后台"输入(命中)"对账用） */
  cacheTokens: number
  cost: number
}

const USAGE_FILE = path.join(DATA_ROOT, 'usage.json')

/* ★ 0927 第 0 批：文件损坏降级标志（degraded 期间禁止把空历史写回盘覆盖用户计费数据） */
let billingDegraded = false

const records: UsageRecord[] = load()

function load(): UsageRecord[] {
  /* ★ 0927 第 0 批：共享 jsonStore —— ENOENT 才回落空数组；内容损坏先备份 .corrupt-* 再回落并标记
     degraded。（旧逻辑：损坏也静默 return [] → 随后任意一次 recordUsage 就把剩余历史永久覆盖
     → 计费/对账数据整体丢失且只有 console.error。体检 P1，家族①病根。） */
  const r = loadJsonOrBackup<UsageRecord[]>(USAGE_FILE, () => [])
  billingDegraded = r.degraded
  const arr = Array.isArray(r.data) ? r.data : []
  if (!r.degraded && r.data != null && !Array.isArray(r.data)) {
    billingDegraded = true
    console.error('[billing] 文件结构异常（不是数组），按降级处理：', USAGE_FILE)
  }
  /* 0927 netfix billing-archive-0927：超窗旧账先归档再截断（原直接 slice → 早前账目随下次写盘被静默抹掉）。
     归档失败就本次不截断——宁可文件大，绝不丢账。 */
  try {
    if (arr.length > 10000) {
      const over = arr.slice(0, arr.length - 10000)
      fs.appendFileSync(USAGE_FILE + '.archive.jsonl', over.map((x: any) => JSON.stringify(x)).join('\n') + '\n')
    }
  } catch (e) { console.warn('[billing] 归档失败（本次不截断）:', e); return arr }
  return arr.slice(-10000)
}

function persist(): void {
  /* ★ 0927 第 0 批：原子写（tmp 带 pid+随机）+ degraded 空历史拒绝回写。
     旧逻辑：裸 writeFileSync 无 tmp/rename（写一半崩了即截断）+ 无降级保护。 */
  persistJson(USAGE_FILE, records.slice(-10000), {
    degraded: billingDegraded,
    isEmpty: () => records.length === 0,
  })
}

/** 模型单价（$/1M tokens）——从供应商模型表读，无配置按 0 */
function modelPrice(providerId: string, modelId: string): { input: number; output: number } {
  const p = getState().providers.find(x => x.id === providerId)
  const m = p?.models?.find(x => x.id === modelId)
  return {
    input: Number(m?.inputPrice ?? 0),
    output: Number(m?.outputPrice ?? 0),
  }
}

/** 记录本次 LLM 调用：promptTokens=未命中部分（供应商口径），cacheTokens=缓存命中部分（可选） */
export function recordUsage(providerId: string, modelId: string, promptTokens: number, completionTokens: number, cacheTokens = 0): void {
  if (!promptTokens && !completionTokens && !cacheTokens) return
  const price = modelPrice(providerId, modelId)
  const cost = (promptTokens * price.input + completionTokens * price.output) / 1_000_000
  records.push({ ts: Date.now(), provider: providerId, model: modelId, promptTokens, completionTokens, cacheTokens, cost })
  persist()
}

export type BillingPeriod = 'day' | 'week' | 'month' | 'all'

function periodStart(period: BillingPeriod): number {
  const now = new Date()
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  if (period === 'day') return start.getTime()
  if (period === 'week') return start.getTime() - 6 * 24 * 3600 * 1000
  if (period === 'month') return new Date(now.getFullYear(), now.getMonth(), 1).getTime()
  return 0
}

export function stats(period: BillingPeriod = 'day') {
  const since = periodStart(period)
  const list = records.filter(r => r.ts >= since)
  const byModel = new Map<string, { name: string; provider: string; calls: number; tokens: number; cost: number; prompt_tokens: number; completion_tokens: number }>()
  let totalCost = 0
  let totalCalls = 0
  let promptTokens = 0
  let completionTokens = 0
  let cacheTokens = 0
  for (const r of list) {
    totalCost += r.cost
    totalCalls += 1
    promptTokens += r.promptTokens
    completionTokens += r.completionTokens
    cacheTokens += (r as any).cacheTokens || 0
    const key = `${r.provider}:${r.model}`
    const e = byModel.get(key) || { name: r.model, provider: r.provider, calls: 0, tokens: 0, cost: 0, prompt_tokens: 0, completion_tokens: 0 }
    e.calls += 1
    e.tokens += r.promptTokens + r.completionTokens
    e.cost += r.cost
    e.prompt_tokens += r.promptTokens
    e.completion_tokens += r.completionTokens
    byModel.set(key, e)
  }
  return {
    period,
    total_cost: Math.round(totalCost * 10000) / 10000,
    total_calls: totalCalls,
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    cache_tokens: cacheTokens,
    total_tokens: promptTokens + completionTokens,
    by_model: Array.from(byModel.values()),
  }
}

export function resetStats(): void {
  records.length = 0
  persist()
}
