/**
 * models.dev 集成（0907 供应商 C 方案）——社区模型能力"答案卷"，opencode/Hermes/ZCode 同源。
 *
 * - 每次"获取模型"实时拉 https://models.dev/api.json（用户拍板：实时优先，非缓存）
 * - 按 modelId 查 { input[], output[], context }；provider 内命中优先（id 精确），再全局兜底
 * - 网络失败/超时 → 返回 null，调用方降级到名字推断（绝不阻塞、不抛错）
 * - 仅作"建议能力 + 列表默认勾选"来源，resolveModelCaps 里排在"显式 capabilities"之后
 *   （手写 > dev > 名字，LongCat 等手写声明不被覆盖）
 */
import fs from 'node:fs'
import path from 'node:path'
import { loadJsonOrBackup, writeJsonAtomic } from './jsonStore.ts'
import { DATA_ROOT } from './paths.ts'

const MODELS_DEV_URL = 'https://models.dev/api.json'
const TIMEOUT_MS = 8000
const CACHE_FILE = path.join(DATA_ROOT, 'models_dev_cache.json')

interface DevModelCaps {
  input: string[]
  output: string[]
  context?: number
  /** 0917：models.dev limit.output —— 单次输出上限的真实值（发送侧 resolveMaxOutput 的中档来源） */
  maxOutput?: number
  /** models.dev 官方 reasoning 标记（聚合=任一 provider 为真） */
  reasoning?: boolean
  /** 命中来源：provider=在指定供应商内精确命中，global=跨供应商按模型名兜底命中 */
  where: 'provider' | 'global'
}

interface RawModel {
  modalities?: { input?: string[]; output?: string[] }
  limit?: { context?: number; output?: number }
  reasoning?: boolean
}
interface RawRegistry { [providerId: string]: { models?: Record<string, RawModel> } }

/* ── 热路径纪律（学 Hermes）：resolveModelCaps 在请求组装同步路径上，绝不在那里拉网络。
 *  网络只发生在 fetchModels（用户主动操作）→ 成功后更新下面两份内存态 + 落盘；
 *  启动时读盘预热；查不到=无 dev 建议，降级名字推断。 ── */
let curRegistry: RawRegistry | null = null
/** 归一化聚合索引：normId → 并集 caps（refresh 时一次性重建，查询 O(1)） */
let aggIndex: Map<string, DevModelCaps> | null = null
let lastFetchAt = 0
let inflight: Promise<boolean> | null = null
// 用户拍板"实时拉"：仅 60s 内的连续查询共享同一次拉取（一次 fetchModels 多模型不重复下载）
const MEM_TTL = 60_000
const norm = (s: string) => s.toLowerCase().replace(/[_\s]+/g, '-')

function buildIndex(reg: RawRegistry) {
  const m = new Map<string, { input: Set<string>; output: Set<string>; ctxVals: number[]; outVals: number[]; reasoning?: boolean }>()
  for (const pid of Object.keys(reg)) {
    const models = reg[pid]?.models || {}
    for (const mid of Object.keys(models)) {
      const hit = models[mid]
      const k = norm(mid)
      let a = m.get(k)
      if (!a) { a = { input: new Set(), output: new Set(), ctxVals: [], outVals: [] }; m.set(k, a) }
      ;(hit.modalities?.input || []).forEach(i => a!.input.add(i))
      ;(hit.modalities?.output || []).forEach(o => a!.output.add(o))
      if (hit.limit?.context && hit.limit.context > 0) a.ctxVals.push(hit.limit.context)
      if (hit.limit?.output && hit.limit.output > 0) a.outVals.push(hit.limit.output)
      if (hit.reasoning === true) a.reasoning = true
    }
  }
  // 窗口保持 max（显式 maxContext 优先，聚合值只作兜底，大一点无害有 room 钳位保护）；
  // ★ 0923：maxOutput 改【中位数】—— 原"取最大值"被聚合路由商坑实锤：
  //   opencommand 未收录 → 全局兜底聚合 9 家，kilo/openrouter 把 deepseek-v4.1-flash 的
  //   output 标成 943718（路由级上限，非模型真实值），max 聚合后 943718 胜出，
  //   发给上限 393216 的网关直接 400「Invalid max_tokens value」。
  //   中位数（本例 9 家排序第 5 = 384000）才能代表"多数供应商认同的真实值"。
  const median = (xs: number[]): number | undefined => {
    const s = [...xs].sort((a, b) => a - b)
    const n = s.length
    if (n === 0) return undefined
    return n % 2 ? s[(n - 1) / 2] : s[n / 2 - 1]  /*0927 netfix median-floor-0927：偶数取下中位数（原两中值取均值仍可能超真实上限 → 400 Invalid max_tokens）*/
  }
  aggIndex = new Map([...m].map(([k, a]) => [k, {
    input: [...a.input], output: [...a.output],
    context: a.ctxVals.length ? Math.max(...a.ctxVals) : undefined,
    maxOutput: median(a.outVals),
    reasoning: a.reasoning,
    where: 'global' as const,
  }]))
}

/* ★1003 并发批 4.21/4.23：registry 形状校验 —— 网络 JSON 与盘缓存都**不可信**：
 * modalities.input/output 非数组 → buildIndex 的 forEach 直接 TypeError（启动炸/半应用）；
 * limit.context/output 非数字（如字符串 "200000"）→ 过了 `> 0` 判定混进 median/Math.max，
 * 中位数可能返回字符串，污染 resolveMaxOutput 下游。入口统一过滤/纠正，坏条目丢弃。 */
function sanitizeRegistry(raw: any): RawRegistry | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const out: any = {}
  for (const [prov, entry] of Object.entries<any>(raw)) {
    if (!entry || typeof entry !== 'object' || !entry.models || typeof entry.models !== 'object') continue
    const models: any = {}
    for (const [mid, m] of Object.entries<any>(entry.models)) {
      if (!m || typeof m !== 'object') continue
      const inp = Array.isArray(m.modalities?.input) ? m.modalities.input.filter((x: any) => typeof x === 'string') : []
      const outp = Array.isArray(m.modalities?.output) ? m.modalities.output.filter((x: any) => typeof x === 'string') : []
      const ctx = Number(m.limit?.context)
      const maxOut = Number(m.limit?.output)
      models[mid] = {
        ...m,
        modalities: { ...(m.modalities || {}), input: inp, output: outp },
        limit: {
          ...(m.limit || {}),
          ...(Number.isFinite(ctx) && ctx > 0 ? { context: ctx } : {}),
          ...(Number.isFinite(maxOut) && maxOut > 0 ? { output: maxOut } : {}),
        },
      }
    }
    out[prov] = { ...entry, models }
  }
  return Object.keys(out).length ? out : null
}

function adopt(reg: RawRegistry) {
  /* ★4.23：**先建索引、后发布** —— 原来先 curRegistry=reg 再 buildIndex，buildIndex 一抛错，
   * 调用方已拿到"成功"而 aggIndex 还是旧的 ⇒ 查供应商读新数据、全局兜底读旧数据的分裂态。 */
  buildIndex(reg)
  curRegistry = reg
  lastFetchAt = Date.now()
  /* ★ 0927 第 0 批：原子写（tmp 带 pid+随机）替换裸 writeFileSync */
  writeJsonAtomic(CACHE_FILE, reg)
}

/** 启动预热：读上次成功拉取的盘缓存（无 TTL 要求，作为网络失败时的兜底快照） */
function warmDevFromDisk(): void {
  /* ★ 0927 第 0 批：共享 jsonStore —— 坏盘缓存先备份再忽略（旧逻辑静默 catch，
     缓存损坏时无从判断是"没缓存"还是"缓存坏了"）。 */
  const r = loadJsonOrBackup<any>(CACHE_FILE, () => null)
  const j = r.data
  /* ★1003 并发批 4.21：本函数在 **import 时**执行 —— 形状坏的盘缓存（modalities.input 非数组等）
   * 原来裸 buildIndex(j) 直接 TypeError，**整个应用启动炸掉**（注释说"坏档先备份再忽略"，
   * 但 jsonStore 只防 JSON 语法损坏，防不了"语法对形状坏"）。校验 + try/catch，坏档=当没缓存。 */
  if (!curRegistry && j && typeof j === 'object') {
    try {
      const clean = sanitizeRegistry(j)
      if (clean) { buildIndex(clean); curRegistry = clean }
    } catch (e) {
      console.warn('[modelsDev] 盘缓存形状异常，已忽略（按无缓存处理）:', String((e as any)?.message || e).slice(0, 120))
    }
  }
}
warmDevFromDisk()
/* 0917b：启动后台预热（fire-and-forget，绝不阻塞启动）——
 *  盘缓存缺失/过期时主动拉一次 models.dev，让单次输出上限（max_tokens）无需等用户
 *  点开"获取模型"就能按模型真实值动态取；失败静默，旧快照/名字推断继续兜底。 */
const CACHE_FRESH_MS = 6 * 60 * 60 * 1000
if (!curRegistry || Date.now() - lastFetchAt > CACHE_FRESH_MS) {
  void refreshDevRegistry(true).catch(() => { /* 离线/超时忽略 */ })
}

/** 实时拉（用户主动"获取模型"时调）；失败返回 false，旧快照继续可用 */
async function refreshDevRegistry(force = false): Promise<boolean> {
  if (!force && curRegistry && Date.now() - lastFetchAt < MEM_TTL) return true
  /* ★1003 并发批 4.22：返回值契约统一 —— 原来 joiner 路径按"距上次 adopt < TTL+60s"**猜**成败、
   * 直连路径拿 `!!curRegistry`（陈旧快照也算成功），都与文档契约"失败返回 false、调用方降级"相悖，
   * 调用方无法据此决定要不要退回名字推断。现在共享 Promise **携带本次拉取的真实成败**，两条路径同口径。 */
  if (inflight) return inflight
  inflight = (async () => {
    try {
      const ctrl = new AbortController()
      const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
      try {
        const res = await fetch(MODELS_DEV_URL, { signal: ctrl.signal })
        if (!res.ok) return false
        const j = sanitizeRegistry(await res.json())
        if (j && Object.keys(j).length) { adopt(j); return true }
        return false
      } finally { clearTimeout(t) }
    } catch { return false }
    finally { inflight = null }
  })()
  return inflight
}

function capsFromRegistry(mid: string, preferProviderId?: string): DevModelCaps | null {
  const reg = curRegistry
  if (!reg) return null
  if (preferProviderId) {
    const models = reg[preferProviderId]?.models
    if (models) {
      const direct = models[mid] || (() => { const k = Object.keys(models).find(x => norm(x) === norm(mid)); return k ? models[k] : undefined })()
      if (direct && (direct.modalities?.input?.length || direct.modalities?.output?.length)) {
        return { input: direct.modalities.input ?? [], output: direct.modalities.output ?? [], context: direct.limit?.context, maxOutput: direct.limit?.output, reasoning: direct.reasoning, where: 'provider' }
      }
    }
  }
  const a = aggIndex?.get(norm(mid))
  return a ? { ...a } : null
}

/** 同步查询（resolveModelCaps / 展示层用）：只读内存快照，绝不做网络 I/O */
export function lookupDevCapsSync(modelId: string, preferProviderId?: string): DevModelCaps | null {
  return capsFromRegistry(modelId, preferProviderId)
}



/** 批量（获取模型弹窗）：一次刷新 + 逐个查 */
export async function lookupDevCapsBatch(modelIds: string[], providerId?: string): Promise<Record<string, DevModelCaps>> {
  await refreshDevRegistry(true)
  const out: Record<string, DevModelCaps> = {}
  for (const id of modelIds) { const c = capsFromRegistry(id, providerId); if (c) out[id] = c }
  return out
}
