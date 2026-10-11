/**
 * ctxEstimate：上下文估算「纯计算」共享模块（★0926 会话工位 2a-A，自 server.ts 原样抽出）
 *
 * 为什么要抽：会话工人（子进程）要与主进程用**同一份**估算口径（消息/工具估算、分桶、六栏+逐工具+MCP 明细），
 * 这里只放纯计算——不碰 sessions / 日志 / 持久化（严禁兜底：出错直接抛，由调用方决定怎么处理）。
 * 会话相关薄包装留在 server.ts：computeContextBreakdown = 取 lastUsage 当锚点 + 写回 s.contextBreakdown。
 * ★ 数值口径与抽出前一字不变（对拍：会话工作区 _verify_ctxext_0926.cjs）。
 */
import { TOOL_CATALOG } from './toolCatalog.ts'

/** 上下文分段占用结果（与 server.ts session.contextBreakdown 同构；mcpDetail/toolDetail 纯计算必产） */
interface CtxBreakdown {
  base: number; sysTools: number; specialTools: number; mcpTools: number; skill: number; messages: number
  mcpDetail: Array<{ name: string; tokens: number }>
  toolDetail: Array<{ name: string; bucket: 'mcp' | 'skill' | 'sys' | 'special'; tokens: number }>
}

/** ── 上下文计量体系（0911 反馈：从"写死名单"升级为一套可扩展体系）──
 *  ① 分类唯一源 = toolCatalog 的 tab（system=系统工具 / special=特殊工具）——新增内置工具自动归类，不再手改名单；
 *  ② MCP 工具按 mcp__<server>__ 前缀归"mcp"栏，并按 server 分别计量（mcpDetail 分服务明细——未来接入任意数量 MCP 自动生效）；
 *  ③ use_skill 归"技能清单预留"；未登记名字（自定义工具等）兜底 special。
 *  精度：中文≈0.65 token/字、其余≈0.28 token/字符（现代分词器经验值），比统一 ÷2.2 更贴合各栏真实占比；
 *  最终仍以模型回报的真实 input token（prompt+cacheRead+cacheWrite）整体缩放——六栏之和≈圆环真值。 */
const CTX_TOOL_TABS: Map<string, string> = new Map(TOOL_CATALOG.map(t => [t.name, t.tab]))
interface CtxCount { c: number; k: number } // c=总字符数；k=中日韩/全角字符数（两类分开计权）
const ctxZero = (): CtxCount => ({ c: 0, k: 0 })
function ctxAdd(a: CtxCount, b: CtxCount): void { a.c += b.c; a.k += b.k }
/** 文本 → 字符计数（k 统计 CJK 表意/假名/全角标点；charCodeAt 逐字扫，KB 级开销可忽略） */
function ctxCount(text: string): CtxCount {
  const s = String(text || '')
  let k = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if ((c >= 0x2e80 && c <= 0x9fff) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xff00 && c <= 0xffef)) k++
  }
  return { c: s.length, k }
}
/** 字符计数 → 估算 token（缩放前的相对值；真实数值由 computeContextBreakdown 用 usage 锚定） */
function ctxTokens(n: CtxCount): number { return n.k * 0.65 + Math.max(0, n.c - n.k) * 0.28 }
/** `mcp__<server>__<tool>` → server 名（与注入命名同源；异常形态退回原名） */
function ctxMcpServer(name: string): string {
  const parts = String(name || '').split('__')
  return parts.length >= 3 ? parts[1] : String(name || '')
}
/** 工具相关文本（定义 / 调用入参 / 工具结果 共用）→ 所属栏 + 逐工具明细 + MCP 分服务明细 */
function ctxAddToolText(
  name: string, text: string,
  acc: { sys: CtxCount; special: CtxCount; mcp: CtxCount; skill: CtxCount },
  byTool: Map<string, CtxCount>, mcpByServer: Map<string, CtxCount>,
): void {
  const cnt = ctxCount(text)
  const b = ctxToolBucket(name)
  if (b === 'mcp') ctxAdd(acc.mcp, cnt)
  else if (b === 'sys') ctxAdd(acc.sys, cnt)
  else if (b === 'skill') ctxAdd(acc.skill, cnt)
  else ctxAdd(acc.special, cnt)
  const nm = String(name || '')
  if (nm) { let cur = byTool.get(nm); if (!cur) { cur = ctxZero(); byTool.set(nm, cur) } ctxAdd(cur, cnt) }
  if (b === 'mcp') { const srv = ctxMcpServer(nm); let sc = mcpByServer.get(srv); if (!sc) { sc = ctxZero(); mcpByServer.set(srv, sc) } ctxAdd(sc, cnt) }
}
/** 图片块的字符当量（≈900 token）：base64 长度 ≠ token 数，按固定当量粗算，总比算 0 强 */
const CTX_IMAGE_CHAR_EQUIV = 2000
/** 单条消息总字符（供压缩阈值估算 estimateMsgTokens 用；分布明细另用 ctxMsgBuckets 分栏）
 *  ★ 0921 修（实测）：原来只认 NIS 自己产的块名 text/thinking/toolCall/toolResult，
 *  而**从别的 Agent 导入的会话**块名是 anthropic 风格 reasoning/tool_use/tool_result（+image）
 *  → 203 个 tool_use + 169 个 reasoning + 203 个 tool_result 全被算成 0：
 *  同一会话估算 22,777 token / 供应商实收 655,955 token，**少算 28.8 倍**。
 *  后果：① 圆环显示 10% 让人误以为安全；② 压缩判断只看到 2% 永远不触发 → 直接撞 400。
 *  这里补齐两套命名（NIS 原生 + anthropic），image 按固定当量计。 */
/* ★0926 降负提速「少算」（B1/B2）：估算结果缓存 —— 治"每请求全量重扫 4~5 遍"（DSH tokenMeter 增量 fold 同款思路）。
 *  ① 消息级：key=content **数组引用**（整体替换=WeakMap 自动失效）；value 带「数组长度+块类型串」双校验
 *     （push/splice 原地改 → 校验不符 → 重算；块文本原地改且长度不变的极端情况残留极小误差，会被 usage 锚点拉回）。
 *  ② 工具定义级：key=工具对象引用（装配后跨请求稳定），value=描述+参数的 stringify 串（**只序列化一次**，
 *     estimateRequestTokens 与 computeContextBreakdown 两处共用；此前每个工具每请求 stringify 两遍）。
 *  调用方约定（ZCode borrow 同款）：缓存返回值**只读**，禁止修改。 */
interface CtxMsgCacheEntry { len: number; types: string; chars?: number; buckets?: ReturnType<typeof ctxMsgBuckets> }
const ctxMsgCache = new WeakMap<object, CtxMsgCacheEntry>()
const ctxToolDefCache = new WeakMap<object, string>()
function ctxMsgCacheKey(m: any): { key: object | null; len: number; types: string } {
  const c = m?.content
  if (Array.isArray(c)) return { key: c as object, len: c.length, types: c.map((b: any) => String(b?.type || '')).join(',') }
  return { key: (m && typeof m === 'object') ? m : null, len: -1, types: '' }
}
function ctxToolDefText(t: any): string {
  const hit = ctxToolDefCache.get(t)
  if (hit !== undefined) return hit
  let s = ''
  try { s = String(t?.name || '') + JSON.stringify(t?.description || '') + JSON.stringify(t?.parameters || {}) } catch { s = String(t?.name || '') }
  try { ctxToolDefCache.set(t, s) } catch { /* 非对象 key 免缓存 */ }
  return s
}
export function ctxMsgChars(m: any): number {
  if (!m) return 0
  if (typeof m.content === 'string') return m.content.length
  if (Array.isArray(m.content)) {
    const k = ctxMsgCacheKey(m)
    const hit = k.key ? ctxMsgCache.get(k.key) : undefined
    if (hit && hit.len === k.len && hit.types === k.types && hit.chars !== undefined) return hit.chars
    let n = 0
    for (const c of m.content) {
      if (!c) continue
      if (c.type === 'text') n += (c.text || '').length
      else if (c.type === 'thinking' || c.type === 'reasoning') n += (c.thinking || c.reasoning || c.text || '').length
      else if (c.type === 'toolCall' || c.type === 'tool_use') n += (c.name || '').length + JSON.stringify(c.arguments ?? c.args ?? c.input ?? {}).length
      else if (c.type === 'toolResult' || c.type === 'tool_result') n += typeof c.content === 'string' ? c.content.length : JSON.stringify(c.content || '').length
      else if (c.type === 'image') n += CTX_IMAGE_CHAR_EQUIV
    }
    if (k.key) {
      const prev = ctxMsgCache.get(k.key)
      ctxMsgCache.set(k.key, { len: k.len, types: k.types, chars: n, buckets: prev?.buckets })
    }
    return n
  }
  return 0
}
/** 工具名 → 归入哪一栏（mcp / skill / sys / special）。definitions 与 该工具的调用入参+结果 都进同一栏，
 *  修"用了 MCP 结果却算进对话、MCP 栏恒 0"的错配。 */
function ctxToolBucket(name: string): 'mcp' | 'skill' | 'sys' | 'special' {
  const nm = String(name || '')
  if (nm.startsWith('mcp__')) return 'mcp'
  if (nm === 'use_skill') return 'skill'
  // 分类唯一源 = toolCatalog 的 tab：system=系统工具 / special=特殊工具（新增内置工具自动归类，不再手写名单）
  return CTX_TOOL_TABS.get(nm) === 'system' ? 'sys' : 'special'
}
/** 单条消息 → 各栏字符增量（对话文本进 messages；toolCall 参数/工具结果按工具家族归类，
 *  同时累计逐工具 / MCP 分服务明细，供圆环悬停明细下钻） */
function ctxMsgBuckets(m: any): {
  messages: CtxCount; sys: CtxCount; special: CtxCount; mcp: CtxCount; skill: CtxCount
  byTool: Map<string, CtxCount>; mcpByServer: Map<string, CtxCount>
} {
  const messages = ctxZero(), sys = ctxZero(), special = ctxZero(), mcp = ctxZero(), skill = ctxZero()
  const byTool = new Map<string, CtxCount>(), mcpByServer = new Map<string, CtxCount>()
  const out = { messages, sys, special, mcp, skill, byTool, mcpByServer }
  if (!m) return out
  const acc = { sys, special, mcp, skill }
  const role = String(m.role || '')
  // toolResult 独立消息：整条按 toolName 归栏
  if (role === 'tool' || role === 'toolResult') {
    const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '')
    ctxAddToolText(m.toolName || m.name || '', text, acc, byTool, mcpByServer)
    return out
  }
  if (typeof m.content === 'string') { ctxAdd(messages, ctxCount(m.content)); return out }
  if (!Array.isArray(m.content)) return out
  for (const c of m.content) {
    if (!c) continue
    if (c.type === 'text') ctxAdd(messages, ctxCount(c.text || ''))
    // ★ 0921 修：补认 anthropic 风格块名（导入会话全是这套）——否则圆环明细只统计 text，
    //   真实 65 万 token 显示成 2 万，用户看到的"10%"是假安全。
    else if (c.type === 'thinking' || c.type === 'reasoning') ctxAdd(messages, ctxCount(c.thinking || c.reasoning || c.text || ''))
    else if (c.type === 'toolCall' || c.type === 'tool_use') ctxAddToolText(c.name || '', (c.name || '') + JSON.stringify(c.arguments ?? c.args ?? c.input ?? {}), acc, byTool, mcpByServer)
    else if (c.type === 'toolResult' || c.type === 'tool_result') ctxAddToolText(c.toolName || c.name || '', typeof c.content === 'string' ? c.content : JSON.stringify(c.content || ''), acc, byTool, mcpByServer)
    else if (c.type === 'image') ctxAdd(messages, ctxCount('x'.repeat(CTX_IMAGE_CHAR_EQUIV)))
  }
  return out
}
/** ctxMsgBuckets 的缓存包装（0926 B1）：返回值**只读**（borrow 约定，见缓存基建注释）。
 *  仅 Array content 消息缓存（string content 是 O(1) 无需缓存）。
 *  ★1003 批次4 4.6 双修：① 校验键加**廉价指纹**（文本总长）——原来只看 引用/长度/块型串，
 *  就地改文本（长度不变）会静默发还旧 chars/旧分栏（估算被带偏，且 usage 锚点救不了
 *  estimateMsgTokens/estimateRequestTokens 这两条无锚点路径）；② 返回值改**每调用拷贝 + 冻结**——
 *  原来发还活引用（含 Map），调用方一 mutate 就毒化共享缓存，殃及后续所有调用。 */
function ctxMsgBucketsCached(m: any): ReturnType<typeof ctxMsgBuckets> {
  const k = ctxMsgCacheKey(m)
  const fp = cheapTextFingerprint(m)
  const hit = k.key ? ctxMsgCache.get(k.key) : undefined
  if (hit && hit.len === k.len && hit.types === k.types && hit.chars === fp && hit.buckets) return frozenBuckets(hit.buckets)
  const b = ctxMsgBuckets(m)
  if (k.key && Array.isArray(m?.content)) {
    ctxMsgCache.set(k.key, { len: k.len, types: k.types, chars: fp, buckets: b })
  }
  return frozenBuckets(b)
}

/** ★1003 4.6：廉价指纹 —— 逐块文本长度之和（O(块数)，能抓出"同长不同文"的就地改写） */
function cheapTextFingerprint(m: any): number {
  const c = m?.content
  if (!Array.isArray(c)) return 0
  let n = 0
  for (const b of c) {
    if (!b) continue
    if (typeof b.text === 'string') n += b.text.length
    if (typeof b.thinking === 'string') n += b.thinking.length
    if (typeof b.reasoning === 'string') n += b.reasoning.length
  }
  return n
}

/** ★1003 4.6：发还**冻结副本**（Map 每调用拷贝）——缓存原件永不外露，调用方 mutate 只伤自己 */
function frozenBuckets(b: ReturnType<typeof ctxMsgBuckets>): ReturnType<typeof ctxMsgBuckets> {
  return Object.freeze({ ...b, byTool: new Map(b.byTool), mcpByServer: new Map(b.mcpByServer) }) as any
}

/** 上下文分段占用（0908 三批重构，参考 ZCode estimateSessionContextBreakdown）：
 *  ① 系统提示词/skill 块按字符定位；② 工具【定义】+【调用入参/结果】按家族归栏（不再把工具结果混进"对话"）；
 *  ③ 各栏字符÷2.2 得估算 token，再用【模型回报的真实 input token】做锚点整体缩放——使六栏之和≈圆环真值，
 *  彻底消除"分布加总≠圆环、MCP 时对时错"。无 usage（首轮）时显示估算值（前端已带 ~ 号）。 */
export function computeBreakdownPure(sysText: string, tools: any[], messages: any[], realTokens: number): CtxBreakdown {
  const skillMarker = '## 可用技能'
  const si = sysText.indexOf(skillMarker)
  const base = ctxCount(si >= 0 ? sysText.slice(0, si) : sysText)
  const skill = si >= 0 ? ctxCount(sysText.slice(si)) : ctxZero()
  const sysTools = ctxZero(), specialTools = ctxZero(), mcpTools = ctxZero()
  const byTool = new Map<string, CtxCount>(), mcpByServer = new Map<string, CtxCount>()
  const acc = { sys: sysTools, special: specialTools, mcp: mcpTools, skill }
  for (const t of tools || []) {
    ctxAddToolText(String(t?.name || ''), ctxToolDefText(t), acc, byTool, mcpByServer)
  }
  const msgCount = ctxZero()
  for (const m of messages || []) {
    const b = ctxMsgBucketsCached(m)
    ctxAdd(msgCount, b.messages)
    ctxAdd(sysTools, b.sys); ctxAdd(specialTools, b.special); ctxAdd(mcpTools, b.mcp); ctxAdd(skill, b.skill)
    for (const [k, v] of b.byTool) { let cur = byTool.get(k); if (!cur) { cur = ctxZero(); byTool.set(k, cur) } ctxAdd(cur, v) }
    for (const [k, v] of b.mcpByServer) { let cur = mcpByServer.get(k); if (!cur) { cur = ctxZero(); mcpByServer.set(k, cur) } ctxAdd(cur, v) }
  }
  const est = {
    base: ctxTokens(base), sysTools: ctxTokens(sysTools), specialTools: ctxTokens(specialTools),
    mcpTools: ctxTokens(mcpTools), skill: ctxTokens(skill), messages: ctxTokens(msgCount),
  }
  const estimated = est.base + est.sysTools + est.specialTools + est.mcpTools + est.skill + est.messages
  // 真实 input token 锚点（上一轮模型上报的完整上下文；本轮请求与之几乎相同）——缩放使加总=真值
  const real = realTokens // 会话侧=上一轮真实 usage（prompt+cacheRead+cacheWrite）；工人侧由调用方传入
  const scale = real > 0 && estimated > 0 ? real / estimated : 1
  /* ★0926 B3：0924 的"上下文分桶调试"日志已删（当时自标"核实清楚后可删"；0926 核实无误后删，
     省掉每请求一次的全量统计+字符串拼接+日志广播）。要再排查可从 git/备份回捞。 */
  return {
    base: Math.round(est.base * scale), sysTools: Math.round(est.sysTools * scale), specialTools: Math.round(est.specialTools * scale),
    mcpTools: Math.round(est.mcpTools * scale), skill: Math.round(est.skill * scale), messages: Math.round(est.messages * scale),
    // 体系化明细：MCP 逐 server（任意数量自动列出）+ 逐工具（按 token 降序，前端按 bucket 挂到对应行下）
    mcpDetail: [...mcpByServer.entries()].map(([name, c]) => ({ name, tokens: Math.round(ctxTokens(c) * scale) })).sort((a, b) => b.tokens - a.tokens),
    toolDetail: [...byTool.entries()].map(([name, c]) => ({ name, bucket: ctxToolBucket(name), tokens: Math.round(ctxTokens(c) * scale) })).sort((a, b) => b.tokens - a.tokens),
  }
}

/** ★1003 批次4 4.7：消息的分语言字符统计（估算统一走 ctxTokens 口径用） */
function ctxMsgCountOf(m: any): CtxCount {
  const b = ctxMsgBuckets(m)
  const out = ctxZero()
  ctxAdd(out, b.messages); ctxAdd(out, b.sys); ctxAdd(out, b.special); ctxAdd(out, b.mcp); ctxAdd(out, b.skill)
  for (const [, v] of b.byTool) ctxAdd(out, v)
  for (const [, v] of b.mcpByServer) ctxAdd(out, v)
  return out
}

/** 单条消息估算 token（压缩留存分段用）。
 *  ★1003 批次4 4.7：统一估算口径 —— 原来 ÷2.2（≈0.455 tok/char）与 ctxTokens 的分语言权重
 *  （CJK 0.65 / 非 CJK 0.28）**两套并存**，同一内容最大差 2.3 倍 ⇒ 压缩触发/发送预算（本路径）
 *  与圆环分布（computeBreakdownPure 路径）互相矛盾：圆环显示有余量、预算已越线，反之亦然。
 *  全部路由 ctxTokens，与圆环同一口径（模块 doc 的"同一口径"这才名副其实）。 */
export function estimateMsgTokens(m: any): number { return Math.round(ctxTokens(ctxMsgCountOf(m))) }
/** 输入估算（系统提示词 + 工具定义 + 消息）。压缩触发 / 发送预算 / 圆环 fallback 共用同一口径。
 *  工具定义不可忽略：本机实测工具 schema 就占约 7 万 token。 */
export function estimateRequestTokens(sysText: string, tools: any[], messages: any[]): number {
  let n = ctxTokens(ctxCount(String(sysText || '')))
  for (const t of tools || []) {
    try { n += ctxTokens(ctxCount(ctxToolDefText(t))) } catch { /* ignore */ }
  }
  for (const m of messages || []) n += estimateMsgTokens(m)
  return Math.round(n)
}
