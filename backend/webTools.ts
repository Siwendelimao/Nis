/**
 * 联网工具集：web_search（可插拔引擎）/ web_fetch / github_search
 *
 * 搜索引擎策略：
 *  - duckduckgo：免 key 默认（HTML 解析，无需注册）
 *  - tavily / brave：配置了 apiKey 则自动可用（前端设置里选）
 *  - 配置持久化在 backend/data/websearch.json，前端设置面板可视化选择
 */
import { Type } from 'typebox'
import fs from 'node:fs'
import path from 'node:path'
import type { AgentTool } from '@earendil-works/pi-agent-core'
// 0908五：网络出口可切换——proxy 档用 undici ProxyAgent（与 providers.ts 同款，Node global fetch 不吃代理）
import { fetch as undiciFetch, ProxyAgent } from 'undici'

/* 0927 netfix data-root-0927：落盘必须走 paths.ts 的 DATA_ROOT（原 import.meta.dirname/data
   在安装版指向程序目录，设置会随更新/重装丢失，也违反"数据根统一"口径） */
import { DATA_ROOT } from './paths.ts'
/* ★ 1001：搜索 key 也纳入密钥保险箱 —— 此前 tavily/brave/serper 的 key 是**明文**落盘
   （供应商那把加密了，这几个"旁边的 key"漏了；加密盖不全 = 安全感与理解成本两头都亏）。
   口径与 providers.ts 完全一致：**内存/落盘一律存密文，只在发请求那一刻取明文**。*/
import { encryptDpapi, decryptKey, isEncrypted, encryptWithPassphrase, decryptWithPassphrase } from './secretbox.ts'
const DATA_DIR = DATA_ROOT
const CONFIG_FILE = path.join(DATA_DIR, 'websearch.json')

export type SearchProviderId = 'bing' | 'duckduckgo' | 'tavily' | 'brave' | 'serper'

interface WebSearchConfig {
  /** 当前使用的搜索引擎 id */
  provider: SearchProviderId
  /** 各引擎的 API key（按需填；duckduckgo 不需要） */
  apiKeys: Partial<Record<SearchProviderId, string>>
  /** 0908五：网络出口（用户拍板可切换）——'direct'=本机 IP 直连（默认，旧行为）；
   *  'proxy'=走下方 proxyUrl（HTTP 代理，如 Clash 的 127.0.0.1:7897）。
   *  此前 web_search/web_fetch 恒 global fetch 直连，完全不吃供应商代理=墙内必挂"fetch failed" */
  networkMode?: 'direct' | 'proxy'
  proxyUrl?: string
}

/* ★1010v：默认引擎改 Bing —— DuckDuckGo 已被反爬拦（实测：直连 fetch failed、走代理 202 但挑战页 + 解析 0 条），
   而 cn.bing.com **免 Key + 国内直连 + 结构稳定**。老用户已存配置的 provider 不动（尊重设置，面板里点一下即切）。 */
const DEFAULT_CONFIG: WebSearchConfig = { provider: 'bing', apiKeys: {}, networkMode: 'direct' }

let config: WebSearchConfig = load()

/* ★ 1001 内存明文缓存（与 providers.ts 的 plainKeyCache 同款）：
   解密要 spawn 一次 PowerShell（实测 0.3~0.5s），而一轮对话可能连搜好几次 —— 不缓存就白等。
   落盘永远只有密文，明文只在进程内存里活到退出。 */
const searchKeyCache = new Map<SearchProviderId, string>()

/** ★ 1001：load 只读不写 —— apiKeys 读到什么就是什么（**密文原样**）。
 *  为什么不在这里就地解密或加密：① 解不开时若把内存置空，随后任何 persist 都会把空写回盘 =
 *  永久丢 key；② 迁移要备份、要记账、失败要能回退，那属于启动流程，见 migratePlainSearchKeys()。*/
function load(): WebSearchConfig {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
      if (raw && raw.provider) return { provider: raw.provider, apiKeys: raw.apiKeys || {}, networkMode: raw.networkMode === 'proxy' ? 'proxy' : 'direct', proxyUrl: typeof raw.proxyUrl === 'string' ? raw.proxyUrl : '' }
    }
  } catch (e) {
    console.error('[webTools] config load failed:', e)
  }
  return { ...DEFAULT_CONFIG }
}

/** ★ 1001：取**能发出去的**搜索 key（明文）。解不开**抛明确错** ——
 *  绝不返回空串或密文（空串会让"key 没配好"变成莫名 401/403，密文发出去必挂）。
 *  这是本模块唯一的"落盘值 → 可发出明文"出口，凡要发请求的地方都走它。*/
function plainSearchKey(id: SearchProviderId): string {
  const stored = String(config.apiKeys?.[id] || '')
  if (!stored) return ''
  const hit = searchKeyCache.get(id)
  if (hit !== undefined) return hit
  const r = decryptKey(stored)
  if (!r.ok) throw new Error(`搜索引擎「${id}」的 API Key 解不开：${r.reason}`)
  searchKeyCache.set(id, r.key)
  return r.key
}

/** 写入用：明文 → DPAPI 密文；已是密文则原样透传（前端回传自己那份时不重复加密）。 */
function sealSearchKey(plain: string): string {
  const s = String(plain || '')
  return isEncrypted(s) ? s : (s ? encryptDpapi(s) : '')
}

function persist(): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    /* ★ 1001 落盘防线：写出前再确认一次"没有明文"。今后若哪条路径把明文塞进 config.apiKeys，
       也不能让它落盘（那正是这套加密要消灭的东西）——落盘前补加密，并更新内存为密文。*/
    const out: Record<string, string> = {}
    for (const k of Object.keys(config.apiKeys || {})) {
      const v = String((config.apiKeys as any)[k] || '')
      if (v && !isEncrypted(v)) {
        console.warn(`[webTools] 检测到「${k}」的 key 未加密，落盘前补加密`)
        out[k] = encryptDpapi(v)
      } else {
        out[k] = v
      }
    }
    config.apiKeys = out as WebSearchConfig['apiKeys']
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8')
  } catch (e) {
    console.error('[webTools] config persist failed:', e)
  }
}

/** ★ 1001：老数据迁移 —— websearch.json 里的**明文 key** 就地加密成 DPAPI 密文。
 *  铁律与 providers 的迁移一致：① 先备份；② 先全部加密成功再动文件（宁可全明文，不留半mix态）；
 *  ③ 走原子写。返回记账供启动日志用。*/
function migratePlainSearchKeys(): { migrated: number; backup: string | null; skipped: boolean; reason?: string } {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return { migrated: 0, backup: null, skipped: true, reason: 'websearch.json 不存在' }
    const json = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
    const keys = (json && typeof json.apiKeys === 'object' && json.apiKeys) || {}
    const plains = Object.keys(keys).filter(k => keys[k] && !isEncrypted(keys[k]))
    if (!plains.length) return { migrated: 0, backup: null, skipped: true, reason: '没有明文 key（已是密文或本来就没配）' }
    const sealed: Record<string, string> = {}
    for (const k of plains) sealed[k] = encryptDpapi(String(keys[k]))       // ← 抛错 = 整体放弃，不写盘
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
    const backup = `${CONFIG_FILE}.bak-密钥加密-${stamp}`
    fs.copyFileSync(CONFIG_FILE, backup)
    for (const k of plains) keys[k] = sealed[k]
    json.apiKeys = keys
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(json, null, 2), 'utf8')
    config = load()                                                          // 重新读一遍（内存里换成密文）
    searchKeyCache.clear()
    console.warn(`[webTools] 搜索 key 加密迁移完成：${plains.length} 个（${plains.join(', ')}），备份 ${path.basename(backup)}`)
    return { migrated: plains.length, backup, skipped: false }
  } catch (e: any) {
    console.error('[webTools] 搜索 key 加密迁移失败（websearch.json 保持原样）：', e)
    return { migrated: 0, backup: null, skipped: true, reason: String(e?.message || e) }
  }
}

/** ★ 1001：导入兑现/外部改盘后重载内存配置（把刚落盘的密文读回内存 + 清掉明文缓存）。*/
export function reloadWebSearchConfig(): void {
  config = load()
  searchKeyCache.clear()
}

/* ── 配置读写（server.ts RPC 暴露给前端） ── */

export function getWebSearchConfig(): WebSearchConfig & { available: SearchProviderId[]; lockedKeys?: Record<string, string> } {
  const available: SearchProviderId[] = ['bing', 'duckduckgo']   // ★1010v：Bing 免 Key 且国内直连 ⇒ 排第一（DDG 已被反爬拦）
  for (const p of ['tavily', 'brave', 'serper'] as SearchProviderId[]) {
    available.push(p) // 都列出，前端标「需 Key」
  }
  /* ★ 1001：回给前端的是**明文**（设置面板要展示/编辑，交互口径不变）。
     解不开的（典型：导入自另一台机器）给空串，但记进 lockedKeys 说明原因 ——
     绝不让它看起来像"从没配过"，那会把真问题变成谜案。*/
  const apiKeys: WebSearchConfig['apiKeys'] = {}
  const lockedKeys: Record<string, string> = {}
  for (const p of ['tavily', 'brave', 'serper'] as SearchProviderId[]) {
    const stored = String(config.apiKeys?.[p] || '')
    if (!stored) { apiKeys[p] = ''; continue }
    const r = decryptKey(stored)
    if (r.ok) apiKeys[p] = r.key
    else {
      apiKeys[p] = ''
      lockedKeys[p] = r.reason
      console.warn(`[webTools] 「${p}」的 API Key 在本机解不开：${r.reason}`)
    }
  }
  return { ...config, apiKeys, available, ...(Object.keys(lockedKeys).length ? { lockedKeys } : {}) }
}

/** 返回错误信息或 null（成功） */
export function setWebSearchConfig(provider: SearchProviderId, apiKeys?: Partial<Record<SearchProviderId, string>>, network?: { mode?: 'direct' | 'proxy'; proxyUrl?: string }): string | null {
  if (!['bing', 'duckduckgo', 'tavily', 'brave', 'serper'].includes(provider)) {
    return `未知搜索服务：${provider}`
  }
  if (!['bing', 'duckduckgo'].includes(provider) && !(apiKeys?.[provider] || config.apiKeys[provider])) {
    return `${provider} 需要配置 API Key`
  }
  config.provider = provider
  if (apiKeys) {
    /* ★ 1001：前端传进来的是明文 → 落内存前先加密（内存只存密文，与 providers 同口径）；
       并清掉对应的明文缓存，保证下次取到的是刚保存的这把。*/
    const next = { ...config.apiKeys }
    for (const [k, v] of Object.entries(apiKeys)) {
      if (v === undefined) continue
      next[k as SearchProviderId] = sealSearchKey(String(v))
      searchKeyCache.delete(k as SearchProviderId)
    }
    config.apiKeys = next
  }
  // 0908五：网络出口（直连/代理可切换）；proxyUrl 自动补 http:// 前缀（供应商代理"不填 scheme 静默失效"的坑不重蹈）
  if (network && (network.mode === 'direct' || network.mode === 'proxy')) {
    config.networkMode = network.mode
    if (typeof network.proxyUrl === 'string') {
      let u = network.proxyUrl.trim()
      if (u && !/^[a-zA-Z][\w+.-]*:\/\//.test(u)) u = 'http://' + u
      config.proxyUrl = u
    }
    if (config.networkMode === 'proxy' && !config.proxyUrl) {
      config.networkMode = 'direct'
      return '已切回直连：代理模式需要先填写代理地址（如 127.0.0.1:7897）'
    }
  }
  persist()
  return null
}

/** 0908五：按当前网络出口配置发请求——direct=global fetch（旧行为）；proxy=undici ProxyAgent。
 *  代理配置了但地址非法时回退直连并在错误里说明（不静默）。 */
const proxyAgents = new Map<string, ProxyAgent>()
/* 0927 netfix ssrf-guard-0927：私网/环回/链路本地/云元数据/数字型主机一律拒 —— 且**每跳重定向都要过检**
 （原实现只在入口做字面主机校验，fetch 自动跟随跳转即可弹到 169.254.169.254 读云元数据）。 */
function isBlockedHost(u: string): boolean {
  let host = ''
  try { host = new URL(u).hostname.toLowerCase() } catch { return true }
  if (!host) return true
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return true
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (m) {
    const a = Number(m[1]), b = Number(m[2])
    if (a === 127 || a === 10 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224) return true
    return false
  }
  if (host.includes(':')) return true        // IPv6（::1/fe80/fc00 与公网 v6 一并保守拒；搜索/读页用不到）
  if (/^0x[0-9a-f]+$/i.test(host) || /^\d+$/.test(host)) return true  // 十进制/十六进制 IP 变体
  return false
}

async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = 15000): Promise<Response> {
  if (isBlockedHost(url)) throw new Error('目标地址被安全策略拒绝（私网/环回/元数据地址）')
  let next = url
  for (let hop = 0; hop <= 5; hop++) {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      const opts: any = { ...init, redirect: 'manual', signal: ctrl.signal }
      let res: Response
      if (config.networkMode === 'proxy' && config.proxyUrl) {
        let a = proxyAgents.get(config.proxyUrl)
        if (!a) { a = new ProxyAgent(config.proxyUrl); proxyAgents.set(config.proxyUrl, a) }
        res = await undiciFetch(next, { ...opts, dispatcher: a } as any) as unknown as Response
      } else {
        res = await fetch(next, opts)
      }
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const loc = res.headers.get('location') || ''
        if (!loc) return res
        const abs = new URL(loc, next).toString()
        if (isBlockedHost(abs)) throw new Error('重定向目标被安全策略拒绝（私网/环回/元数据地址）')
        next = abs
        continue
      }
      return res
    } finally {
      clearTimeout(t)
    }
  }
  throw new Error('重定向次数过多（>5）')
}

/* ── HTML → 纯文本（轻量剥标签，无依赖） ── */

function htmlToText(html: string): string {
  return html
    // 去掉脚本/样式/注释
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    // 块级元素换行
    .replace(/<\/(p|div|li|tr|h[1-6]|br)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    // 剩余标签全部剥掉
    .replace(/<[^>]+>/g, '')
    // 实体
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    // 压缩空白
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+/g, ' ')
    .trim()
}

/* ── DuckDuckGo 免 key 搜索（HTML 解析） ── */

interface SearchResult {
  title: string
  url: string
  snippet: string
}

async function searchDuckDuckGo(query: string, limit: number): Promise<SearchResult[]> {
  // DDG lite 版结构简单稳定：<a class="result-link"> + <td class="result-snippet">
  const res = await fetchWithTimeout('https://html.duckduckgo.com/html/', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    },
    body: new URLSearchParams({ q: query }).toString(),
  })
  if (!res.ok) throw new Error(`DuckDuckGo 响应 ${res.status}`)
  const html = await res.text()

  const results: SearchResult[] = []
  // 结果链接模式：href="//duckduckgo.com/l/?uddg=<urlencoded>&rut=..."
  const linkRe = /<a[^>]+class="[^"]*result-link[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g
  const snippetRe = /class="[^"]*result-snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g
  const snippets: string[] = []
  let sm: RegExpExecArray | null
  while ((sm = snippetRe.exec(html)) !== null) snippets.push(sm[1])

  let lm: RegExpExecArray | null
  let i = 0
  while ((lm = linkRe.exec(html)) !== null && results.length < limit) {
    let href = lm[1]
    const title = htmlToText(lm[2])
    // uddg 参数才是真实 URL
    const m = /[?&]uddg=([^&]+)/.exec(href)
    if (m) href = decodeURIComponent(m[1])
    if (!/^https?:\/\//i.test(href)) continue
    results.push({ title, url: href, snippet: htmlToText(snippets[i] || '') })
    i++
  }
  // 兜底：正则没匹配到（DDG 改版）时给出明确提示而不是空结果
  if (results.length === 0) {
    throw new Error('DuckDuckGo 返回了解析失败的内容（可能被限流或改版），建议切换 Tavily/Brave')
  }
  return results
}

/* ── Bing 免 key 搜索（HTML 解析）── ★1010v
 * 为什么加：DuckDuckGo 现在对非浏览器流量发**反爬挑战页**（实测走代理 202 + `result-link` 0 条，
 * 直连 fetch failed），墙内用户等于没有免 Key 搜索可用。
 * cn.bing.com 实测：**国内直连 200、无验证页、`b_algo` 结构稳定（9/10 条可解析）** ⇒ 作免 Key 默认。 */
async function searchBing(query: string, limit: number): Promise<SearchResult[]> {
  const url = `https://cn.bing.com/search?q=${encodeURIComponent(query)}&setlang=zh-CN&ensearch=0`
  const res = await fetchWithTimeout(url, {
    headers: {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
      'accept-language': 'zh-CN,zh;q=0.9',
    },
  })
  if (!res.ok) throw new Error(`Bing 响应 ${res.status}`)
  const html = await res.text()
  const results: SearchResult[] = []
  // 结果项：<li class="b_algo"> … <h2><a href="…">标题</a> … <p>摘要</p>
  const re = /<li class="b_algo"[\s\S]{0,2500}?<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>([\s\S]{0,1200}?)(?:<p[^>]*>([\s\S]*?)<\/p>)?/g
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null && results.length < limit) {
    const href = m[1]
    if (!/^https?:\/\//i.test(href)) continue
    results.push({ title: htmlToText(m[2]), url: href, snippet: htmlToText(m[4] || '') })
  }
  if (results.length === 0) throw new Error('Bing 返回了解析失败的内容（可能改版），建议切换 Brave / Tavily')
  return results
}

/* ── Tavily（为 LLM 设计，免费 1000 次/月） ── */

async function searchTavily(query: string, limit: number, apiKey: string): Promise<SearchResult[]> {
  const res = await fetchWithTimeout('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ api_key: apiKey, query, max_results: limit }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Tavily 响应 ${res.status}: ${text.slice(0, 200)}`)
  }
  const data = await res.json() as any
  return (data.results || []).map((r: any) => ({
    title: String(r.title || ''),
    url: String(r.url || ''),
    snippet: String(r.content || '').slice(0, 300),
  }))
}

/* ── Brave Search（免费 2000 次/月） ── */

async function searchBrave(query: string, limit: number, apiKey: string): Promise<SearchResult[]> {
  const res = await fetchWithTimeout(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${limit}`, {
    headers: {
      'X-Subscription-Token': apiKey,
      Accept: 'application/json',
    },
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Brave 响应 ${res.status}: ${text.slice(0, 200)}`)
  }
  const data = await res.json() as any
  const items = data?.web?.results || []
  return items.map((r: any) => ({
    title: String(r.title || ''),
    url: String(r.url || ''),
    snippet: String(r.description || '').slice(0, 300),
  }))
}

/* ── Serper（Google SERP API，免费 2500 次） ── */

async function searchSerper(query: string, limit: number, apiKey: string): Promise<SearchResult[]> {
  const res = await fetchWithTimeout('https://google.serper.dev/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-API-KEY': apiKey },
    body: JSON.stringify({ q: query, num: limit }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Serper 响应 ${res.status}: ${text.slice(0, 200)}`)
  }
  const data = await res.json() as any
  return (data.organic || []).map((r: any) => ({
    title: String(r.title || ''),
    url: String(r.link || ''),
    snippet: String(r.snippet || '').slice(0, 300),
  }))
}

/** 统一入口：按当前配置路由到具体引擎 */
async function runSearch(query: string, limit: number): Promise<{ engine: string; results: SearchResult[] }> {
  const provider = config.provider
  if (provider === 'bing') {                 // ★1010v：免 Key 默认（国内直连，实测 200 + 结构稳定）
    return { engine: 'bing', results: await searchBing(query, limit) }
  }
  if (provider === 'duckduckgo') {
    return { engine: 'duckduckgo', results: await searchDuckDuckGo(query, limit) }
  }
  const apiKey = plainSearchKey(provider)     // ★ 1001：取明文（落盘与内存里存的都是 DPAPI 密文）
  if (!apiKey) throw new Error(`搜索引擎 ${provider} 未配置 API Key`)
  switch (provider) {
    case 'tavily': return { engine: 'tavily', results: await searchTavily(query, limit, apiKey) }
    case 'brave': return { engine: 'brave', results: await searchBrave(query, limit, apiKey) }
    case 'serper': return { engine: 'serper', results: await searchSerper(query, limit, apiKey) }
    default: throw new Error(`未知搜索引擎：${provider}`)
  }
}

/* ═══ 工具定义 ═══ */

/* ── web_search：联网搜索 ── */
const searchParams = Type.Object({
  query: Type.String({ description: '搜索关键词' }),
  limit: Type.Optional(Type.Number({ description: '返回结果数上限（默认 6，最大 10）' })),
})

function buildWebSearchTool(): AgentTool<typeof searchParams, any> {
  return {
    name: 'web_search',
    label: '联网搜索',
    description: '联网搜索最新信息。适合：实时资讯、新技术方案、文档查找、价格对比等需要外部信息的场景。返回标题/链接/摘要列表。',
    parameters: searchParams,
    async execute(_callId, params, _signal, onUpdate) {
      const limit = Math.min(Math.max(params.limit || 6, 1), 10)
      const { engine, results } = await runSearch(params.query, limit)
      onUpdate?.({ content: [], details: { engine, count: results.length } })
      const lines = results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
      return {
        content: [{ type: 'text', text: `[搜索引擎: ${engine}] 共 ${results.length} 条\n\n${lines.join('\n\n')}` }],
        details: { engine, count: results.length, query: params.query },
      }
    },
  }
}

/* ── web_fetch：抓取网页正文 ── */
/** B3 最小 SSRF：命中云厂商元数据端点或链路本地 169.254/16 即拦（不解析 DNS，只判字面主机/IP，零误伤本地服务） */
function isBlockedSsrfHost(host: string): boolean {
  const h = (host || '').toLowerCase().replace(/^\[|\]$/g, '')
  if (!h) return false
  if (/^(metadata|metadata\.google\.internal|instance-metadata)$/.test(h)) return true
  if (h === '169.254.169.254' || h === '100.100.100.200' || h === 'fd00:ec2::254') return true
  // 链路本地 IPv4：169.254.0.0/16
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (m && +m[1] === 169 && +m[2] === 254) return true
  return false
}
const fetchParams = Type.Object({
  url: Type.String({ description: '要抓取的网页 URL（http/https）' }),
  maxChars: Type.Optional(Type.Number({ description: '最多返回字符数（默认 8000）' })),
})

function buildWebFetchTool(): AgentTool<typeof fetchParams, any> {
  return {
    name: 'web_fetch',
    label: '读取网页',
    description: '抓取指定 URL 的网页内容并转为纯文本。配合 web_search 使用（先搜后读），也可直接读取用户给出的链接。',
    parameters: fetchParams,
    async execute(_callId, params, _signal, onUpdate) {
      let target = params.url.trim()
      if (!/^https?:\/\//i.test(target)) target = 'https://' + target
      // 只允许 http/https（禁 file:/ftp: 等）
      let parsed: URL
      try { parsed = new URL(target) } catch { throw new Error(`无效 URL：${params.url}`) }
      if (!/^https?:$/.test(parsed.protocol)) throw new Error(`仅支持 http/https：${parsed.protocol}`)
      // B3 最小 SSRF：拦云厂商元数据端点 + 链路本地段（169.254/16，含 169.254.169.254）。
      // 有意放行 127.0.0.1/192.168/10.x 等私网：本机产品常有"读本地 dev server/自托管模型"的正常用法，全量拦会误伤
      if (isBlockedSsrfHost(parsed.hostname)) throw new Error(`出于安全拒绝抓取该地址：${parsed.hostname}`)

      const res = await fetchWithTimeout(target, {
        headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 NIS-Agent', accept: 'text/html,application/xhtml+xml,*/*' },
        redirect: 'follow',
      })
      if (!res.ok) throw new Error(`网页响应 ${res.status} ${res.statusText}：${target}`)

      const contentType = res.headers.get('content-type') || ''
      const maxChars = Math.min(Math.max(params.maxChars || 8000, 500), 30000)

      let text: string
      if (/json/i.test(contentType)) {
        text = JSON.stringify(await res.json(), null, 2)
      } else if (/html|xml|plain|markdown/i.test(contentType) || !contentType) {
        text = htmlToText(await res.text())
      } else {
        text = `(二进制内容，类型 ${contentType}，大小 ${res.headers.get('content-length') || '?'} 字节)`
      }
      text = text.slice(0, maxChars)

      onUpdate?.({ content: [], details: { url: target, chars: text.length } })
      return {
        content: [{ type: 'text', text: `[页面] ${target}\n${text}${text.length >= maxChars ? '\n…(截断)' : ''}` }],
        details: { url: target, chars: text.length, contentType },
      }
    },
  }
}

/* ── github_search：GitHub 仓库搜索 ── */
const ghParams = Type.Object({
  query: Type.String({ description: '搜索关键词（支持 GitHub 限定符，如 "vue language:typescript stars:>1000"）' }),
  sort: Type.Optional(Type.Union([Type.Literal('stars'), Type.Literal('forks'), Type.Literal('updated'), Type.Literal('best-match')])),
  limit: Type.Optional(Type.Number({ description: '返回数量（默认 5，最大 20）' })),
  apiKey: Type.Optional(Type.String({ description: '可选 GitHub token（提高限额；留空用匿名 60次/小时）' })),
})

function buildGithubSearchTool(): AgentTool<typeof ghParams, any> {
  return {
    name: 'github_search',
    label: 'GitHub 搜索',
    description: '搜索 GitHub 开源仓库。支持限定符语法：language:xxx stars:>N topic:xxx in:name/readme。适合找开源实现参考、库选型对比。',
    parameters: ghParams,
    async execute(_callId, params, _signal, onUpdate) {
      const limit = Math.min(Math.max(params.limit || 5, 1), 20)
      const q = new URLSearchParams({
        q: params.query,
        per_page: String(limit),
        order: 'desc',
        ...(params.sort && params.sort !== 'best-match' ? { sort: params.sort } : {}),
      }).toString()
      const headers: Record<string, string> = { accept: 'application/vnd.github+json', 'user-agent': 'NIS-Agent' }
      const token = params.apiKey || process.env.GITHUB_TOKEN
      if (token) headers.authorization = `Bearer ${token}`
      const res = await fetchWithTimeout(`https://api.github.com/search/repositories?${q}`, { headers })
      if (!res.ok) {
        const remaining = res.headers.get('x-ratelimit-remaining')
        if (res.status === 403 && remaining === '0') throw new Error('GitHub 匿名限额已用完（60次/小时），请稍后再试或配置 GITHUB_TOKEN')
        throw new Error(`GitHub 响应 ${res.status}`)
      }
      const data = await res.json() as any
      const repos = (data.items || []).map((r: any) => ({
        full_name: r.full_name,
        url: r.html_url,
        desc: r.description || '',
        stars: r.stargazers_count,
        lang: r.language || '',
        updated: (r.updated_at || '').slice(0, 10),
      }))
      onUpdate?.({ content: [], details: { count: repos.length } })
      const lines = repos.map((r: any, i: number) =>
        `${i + 1}. ⭐${r.stars} [${r.lang || '—'}] ${r.full_name}\n   ${r.url}\n   ${r.desc}${r.updated ? `\n   更新: ${r.updated}` : ''}`)
      return {
        content: [{ type: 'text', text: lines.join('\n\n') || '(无匹配仓库)' }],
        details: { count: repos.length, total: data.total_count, query: params.query },
      }
    },
  }
}

/** 联网工具集（追加进 agent initialState.tools） */
export function buildWebTools(): AgentTool<any>[] {
  return [buildWebSearchTool(), buildWebFetchTool(), buildGithubSearchTool()]
}

/** 连通性探针（前端「测试连接」按钮）：用当前配置真实搜索一次 */
export async function runSearchProbe(query: string, limit: number): Promise<{ engine: string; results: SearchResult[] }> {
  return runSearch(query, limit)
}

/* ★ 1001 搜索 key 加密：进程启动时自动把 websearch.json 里的**明文 key** 加密（幂等）。
   放在模块末尾 = server.ts 一 import 就跑 —— 与 providers.ts 完全同一个套路：
   不需要在启动流程里插桩，也就不会出现"忘了调"导致明文一直躺在盘上的漏。
   已全是密文时直接返回，不产生 IO / 子进程；失败只保持原样，绝不阻断启动。*/
try {
  migratePlainSearchKeys()
} catch (e: any) {
  console.error('[webTools] 启动时搜索 key 迁移异常（已忽略，websearch.json 未改动）：', e)
}

/* ═══════════════ 导出跨机器：口令副本（换电脑也能用） ═══════════════ */

/** ★ 1001：给**要打进包的** websearch.json 加一份口令副本（与 providers 的 sealPortableKeys 同款口径）。
 *  本机那份是 DPAPI 密文，出了这台机器解不开 —— 但换机后搜索 key 全废也不合理（搜索是常用功能），
 *  所以导出时同样用口令包一份：换电脑输同一句口令即可恢复。*/
export function sealPortableSearchKeys(json: any, passphrase: string): { sealed: number; failed: string[] } {
  /* ★1011（老大要求）：弱口令不再拦截，同 providers.sealPortableKeys。 */
  const failed: string[] = []
  let sealed = 0
  const keys = (json && typeof json.apiKeys === 'object' && json.apiKeys) || {}
  for (const k of Object.keys(keys)) {
    if (!keys[k]) continue
    try {
      const r = decryptKey(String(keys[k]))
      if (!r.ok) { failed.push(k); continue }
      json.apiKeysPortable = json.apiKeysPortable || {}
      json.apiKeysPortable[k] = encryptWithPassphrase(r.key, passphrase)
      sealed++
    } catch (e: any) {
      failed.push(k)
      console.warn(`[webTools] 搜索 key「${k}」的口令副本生成失败：${e?.message || e}`)
    }
  }
  return { sealed, failed }
}

/** ★ 1001：导入侧 —— 用口令把包里的 apiKeysPortable 兑现成**本机能用**的 DPAPI 密文。
 *  口令错就一家都不改（绝不半改）。返回记账供导入报告用。*/
export function unsealPortableSearchKeys(json: any, passphrase: string): { recovered: number; wrongPass: boolean; none: boolean } {
  const port = (json && typeof json.apiKeysPortable === 'object' && json.apiKeysPortable) || {}
  const list = Object.keys(port).filter(k => port[k])
  if (!list.length) return { recovered: 0, wrongPass: false, none: true }
  const plain: Record<string, string> = {}
  for (const k of list) {
    try { plain[k] = decryptWithPassphrase(String(port[k]), passphrase) }
    catch { return { recovered: 0, wrongPass: true, none: false } }
  }
  /* 全部解成功才落地；key 是"本机 DPAPI 密文"（与 providers 兑现口径一致），不含明文。*/
  json.apiKeys = json.apiKeys || {}
  let recovered = 0
  for (const k of list) {
    try { json.apiKeys[k] = encryptDpapi(plain[k]); recovered++ }
    catch (e: any) { console.warn(`[webTools] 搜索 key「${k}」兑现失败：${e?.message || e}`) }
  }
  json.apiKeysPortable = undefined
  delete json.apiKeysPortable
  return { recovered, wrongPass: false, none: false }
}

/** 口令强度本地判断（不引 secretbox 的 passphraseWeak 以便本文件自洽；口径与之一致） */
function passphraseWeakLocal(pw: string): boolean {
  const s = String(pw || '')
  if (s.length < 8) return true
  if (/^(.)\1+$/.test(s)) return true
  if (/^\d+$/.test(s)) return true
  return false
}
