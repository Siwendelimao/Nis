/**
 * 供应商/模型状态管理（pi-bridge 侧）
 *
 * - providers.json 持久化：供应商列表 + API Key + 启用状态 + 模型表 + 当前选中
 * - createStreamFn 每次调用现读全局配置（openai-completions 兼容格式）
 * - 代理能力：fetchModels（后端拉模型列表，绕浏览器 CORS）、testConnection（测连接）
 *
 * ★ 0930 密钥加密（B 方案：只加密后端存储，前端交互不变）：
 *   落盘的 apiKey 一律是 `enc:v1:dpapi:…` 密文（Windows DPAPI，绑本机账户）；
 *   对外/对内**一律经 plainKey() 取明文**，任何地方都不得直接读 p.apiKey 发出请求。
 *   明文只在内存活到请求发出为止，不写日志、不进备份正文。
 */
import fs from 'node:fs'
import path from 'node:path'
import { loadJsonOrBackup, writeJsonAtomic } from './jsonStore.ts'
import { DPAPI_PREFIX, decryptDpapiBatch, decryptKey, decryptWithPassphrase, encryptDpapi, encryptWithPassphrase, isEncrypted, keyHint, passphraseWeak } from './secretbox.ts'

/** ★ 0930 内存解密缓存 —— **这不是可选优化，是必须**：
 *  解密要 spawn 一次 PowerShell（实测 0.3~0.5s），而 currentLlmConfig 是**每次 LLM 调用都走**的热路径。
 *  不缓存 = 每一轮对话先白等半秒才能发出第一个字。
 *  落盘永远只有密文；明文只在进程内存里活到进程退出（重启后按需重新解密一次）。*/
const plainKeyCache = new Map<string, string>()

/** ★1003 批次4 4.32：缓存失效 —— 凡是会让「磁盘密文」与「缓存明文」脱钩的写入口（导入覆盖/
 * 删商 / 同 id 重建 / 自动建商改模型）都必须清缓存，否则热路径继续发旧明文（静默错 key/401）。
 * setProviderKey / migratePlainKeysToEncrypted 已有失效，这里补齐其余入口。 */
function invalidatePlainKeyCache(): void { plainKeyCache.clear() }

/** ★ 0930：把落盘值（可能是密文、可能是迁移前的明文）转成**能发出去的明文 key**。
 *  解不开**抛明确错**，绝不返回空串 —— 静默空 key 会把「密钥解不开」变成 401 谜案（0925 教训）。
 *  ★ 1001：改为 **export** —— 全后端只认这一个"落盘值 → 可发出明文"的出口。*/
export function plainKey(p: ProviderConfig): string {
  if (!p.apiKey) return ''                                                   // 没配 key 是正常状态（多处靠这个判"未填"），不是错误
  const hit = plainKeyCache.get(p.id)
  if (hit !== undefined) return hit
  const r = decryptKey(p.apiKey)
  if (!r.ok) throw new Error(`供应商「${p.name || p.id}」的 API Key 解不开：${r.reason}`)
  plainKeyCache.set(p.id, r.key)
  return r.key
}

/** ★ 1001：按 providerId 取明文 —— server.ts 各发送点（会话模型解析 / 团队成员独立模型 /
 *  定时任务 / 通道同步 / 外部引擎）统一走它。
 *  为什么必须要有这个口：这些点原先直接读 `p.apiKey`（= 落盘的 DPAPI 密文）去发请求，
 *  于是上游收到一串 `enc:v1:dpapi:…` 直接回 401（1001 实测：设置里"测试连接"能通、
 *  一发消息就 401 —— 因为测试走 plainKey、发送链路没走）。**别再直接读 p.apiKey 发请求。**
 *  找不到供应商时抛明确错，绝不返回空串（空 key 同样是 401 谜案）。*/
export function plainKeyById(providerId: string): string {
  const p = getState().providers.find(x => x.id === providerId)
  if (!p) throw new Error(`供应商「${providerId}」不存在，无法取密钥`)
  return plainKey(p)
}

/** 写入用：明文 → DPAPI 密文；已是密文则原样透传（前端回传自己那份密文时不重复加密）。 */
function sealedKey(plain: string): string {
  const s = String(plain || '')
  return isEncrypted(s) ? s : (s ? encryptDpapi(s) : '')
}

export interface ProviderModel {
  id: string
  name: string
  inputPrice?: number
  outputPrice?: number
  maxContext?: number
  /** ── 0917：单次输出上限（max_tokens / maxOutputTokens）。发送侧三元解析（server.ts resolveMaxOutput）：
   *  本字段（用户显式填 / 获取模型时按 models.dev limit.output 真实值带入）> models.dev limit.output > 兜底 16384；
   *  最后还钳到上下文窗口（防 dev 数据异常给出大于窗口的输出值）。留空/0 = 未声明，走中档来源。── */
  maxOutput?: number
  /** ── 0921：单次输入上限（发给模型的 messages + tools 的 token 上限）。
   *  语义与 maxOutput 对称：用户显式填 = 权威；留空/0 = 未声明（不设限，发送侧按"窗口 − 输出预留"动态算）。
   *  用途：① 让用户主动卡住"输入不许再大"（更早压缩，别等撞窗口）；② 未来更大窗口的模型
   *  （2M/10M 级）也能靠这一对字段描述清楚，不用改代码。解析口见 resolveMaxInput。 ── */
  maxInput?: number
  capabilities?: string[]
  enabled?: boolean
  completionParam?: string
  /** ── 0907 供应商 A+B 改造：三轴能力字段（全部可选，缺省走 capabilities→模型名推导；
   *  存量 providers.json/前端 capabilities 链路零改动，UI 接入后可显式精确编辑）──
   *  输入模态（模型能"读"什么）：text/image/audio/video */
  inputModalities?: string[]
  /** 输出模态（模型能"生"什么）：text/image/audio/video；不含 text = 不可作聊天模型 */
  outputModalities?: string[]
  /** 特性开关（与模态正交：reasoning=支持思考强度参数，不与 capabilities 的 'reasoning' 字符串混用优先级） */
  supports?: { reasoning?: boolean; vision?: boolean }
  /** ── 0910 推理挡位按模型声明：该模型接受的思考强度挡位（NIS 内部 id：fast/deep/heavy/burning）。
   *  缺省（undefined）= 未声明，走 resolveModelEfforts 的兜底推导；[]= 明确"不支持思考"。
   *  用户在 ✎ 编辑面板勾选落库=权威，发送时按此钳位（越界取最近可用挡），前端下拉只列这些挡。 ── */
  efforts?: string[]
}

interface ProviderConfig {
  id: string
  name: string
  base: string
  enabled: boolean
  apiKey?: string
  /** ★ 0930：key 的可识别片段（sk-***7h）。apiKey 已是密文，界面靠它告诉用户"这家配过哪把 key"。 */
  keyHint?: string
  models: ProviderModel[]
  logo?: string
  /** D2 供应商级网络代理（http/https，如 http://127.0.0.1:7890）；空=直连。仅影响该供应商的 LLM 请求 */
  proxyUrl?: string
  /** 0910 协议扩展：请求走哪套适配器。缺省 openai-completions（全站旧行为零变化）。
   *  anthropic-messages / google-generative-ai 用 pi-ai 自带适配器直连官方原生协议。 */
  protocol?: 'openai-completions' | 'anthropic-messages' | 'google-generative-ai'
}

interface ProviderState {
  providers: ProviderConfig[]
  providerActive: string
  activeModelId: string
  /* ★1012t（已定案："全局模型我本想的是作为一个对话之外的工作模型，能不能把他们分开"，
     命名定为「**后台模型**」，用途：知识库/记忆库自动提炼 + QQ/微信渠道未单独配模型时）：
     **只给"对话之外"的场景用**；对话场景一律不读它（对话 = 会话模型 → 全局聊天模型）。
     ★1013（已定案）：**空值不再回落全局聊天模型** —— "想用免费模型跑后台活的人，
     自动回落会悄悄跑到贵的模型上，等于偷用户的钱"。未配置 = 调用方**明确失败 + 提醒用户去选**。 */
  backgroundProviderId?: string
  backgroundModelId?: string
  /** ★1013：后台模型的**推理强度**（空 = 不指定，按模型默认挡；需求要求"后台模型也能自由选强度"） */
  backgroundEffort?: string
  /**
   * 全局推理强度（2026-09-12）。对话窗口是各会话各自选（session.effort），
   * 这里是**非对话场景**（提炼 / 知识库 / 记忆提炼 / 定时任务默认）的统一强度。
   * 空 = 未指定（由 resolveModelEfforts/clampEffort 走模型默认挡）。
   */
  activeEffort?: string
}

import { DATA_ROOT } from './paths.ts'
import { lookupDevCapsSync, lookupDevCapsBatch } from './modelsDev.ts'
import { fetch as undiciFetch, ProxyAgent } from 'undici'

/* ── 0906 体检 P2#11 修复：供应商配了 proxyUrl 时，拉模型列表/测试连接也走代理
 *  （此前只影响 LLM 主调用，代理供应商拉模型/测连接直连必失败） ── */
const proxyAgents = new Map<string, ProxyAgent>()
function proxiedFetch(proxyUrl: string | undefined, url: string, init: any = {}) {
  if (!proxyUrl) return fetch(url, init)
  let a = proxyAgents.get(proxyUrl)
  if (!a) { a = new ProxyAgent(proxyUrl); proxyAgents.set(proxyUrl, a) }
  return undiciFetch(url, { ...init, dispatcher: a })
}

const STATE_FILE = path.join(DATA_ROOT, 'providers.json')

/** 默认供应商表（OpenAI 兼容 base；**全部默认关闭、默认没有模型**）
 *  0917 用户拍板：出厂一律 enabled:false —— 此前 LongCat/DeepSeek/OpenAI/智谱 默认开启，
 *  新装用户根本没配 Key 却看到「已启用」，一发消息就报「供应商「LongCat」未填写 API Key」
 *  （被误判成「两个后端串台/我没开过 LongCat」）。要用的自己开。
 *  0911 安全修（D1）：LongCat 的出厂默认 Key 不再硬编码——改读环境变量 NIS_LONGCAT_API_KEY。
 *  运行时优先级：用户 providers.json 里保存的 Key（设置页填写）> 环境变量 > 空（不可用）。
 *  ★ 0920 用户拍板（第二条）：**出厂也一律不带预置模型** —— 见下方每个 `models: []` 的注释。
 */
const DEFAULT_PROVIDERS: ProviderConfig[] = [
  /* ★ 0920：出厂模型表全部清空（原来 Agnes 预置 3 个、LongCat 1 个、DeepSeek/OpenAI/智谱/Anthropic 各 2 个）。
   * 为什么清：全新装好的 NIS 在设置里显示「3 个模型 / 1 个模型」，但那**一个模型都没获取过**，
   * 用户会以为"我什么都没配，怎么就 3 个模型了"（用户 0919 实测反馈）。
   * 现在的口径：列表里的「N 个模型」只反映**用户自己拉取/添加**的模型 ——
   * 全新安装一律 0；填好 Key 点「获取模型」（或「添加自定义模型」）才开始有。
   * 老用户不受影响：providers.json 里存过 models 的，仍以存档为准（见 mergeDefaults）。 */
  {
    id: 'longcat', name: 'LongCat', base: 'https://api.longcat.chat/openai/v1', enabled: false,
    apiKey: process.env.NIS_LONGCAT_API_KEY || '',
    models: [],
    logo: '/providers-logo/longcat.svg',
  },
  /* 0925：OpenCode Zen 网关（opencode.ai/zen/v1，OpenAI 兼容 /chat/completions）——
   * 精选模型网关（DeepSeek/MiniMax/GLM/Qwen/Gemini/Claude/GPT…），新用户有免费试用额度、
   * 免费模型（-free 后缀）按周轮换（每日 20万~100万 token）。Key 从 opencode.ai 账号拿。
   * ★ 0925b（要求"像 opencode 一样不填 key 就能用"）：apiKey 默认 **字面量 'public'** =
   * 官方公共免费档（实测 Bearer public + space-bunny-free 直接 200，无需注册）。
   * 公共档可用范围=网关按模型放行（部分 -free 模型直接通；热门 -free（mimo/deepseek/nemotron 等）
   * 挂"仅限 OpenCode 客户端内"闸，需自填 opencode.ai 账号 key 解锁）。 */
  {
    id: 'opencode-zen', name: 'OpenCode Zen', base: 'https://opencode.ai/zen/v1', enabled: false,
    apiKey: process.env.NIS_OPENCODE_ZEN_API_KEY || 'public',
    models: [],
    logo: '/providers-logo/opencode-zen.svg',
  },
  {
    id: 'deepseek', name: 'DeepSeek', base: 'https://api.deepseek.com/v1', enabled: false,
    models: [],
    logo: '/providers-logo/deepseek.svg',
  },
  {
    id: 'openai', name: 'OpenAI', base: 'https://api.openai.com/v1', enabled: false,
    models: [],
    logo: '/providers-logo/openai.svg',
  },
  {
    id: 'anthropic', name: 'Anthropic', base: 'https://api.anthropic.com', enabled: false,
    // 0910 协议扩展：官方原生 Messages API（此前走 openai 兼容格式填官方 base 必挂）
    protocol: 'anthropic-messages',
    models: [],
    logo: '/providers-logo/anthropic.svg',
  },
  {
    id: 'google', name: 'Google (Gemini)', base: 'https://generativelanguage.googleapis.com/v1beta', enabled: false,
    // 0910 协议扩展：Gemini 原生 generateContent（base 含版本段，与 pi-ai 适配器约定一致）
    protocol: 'google-generative-ai',
    models: [],
    logo: '/providers-logo/google.svg',
  },
  {
    id: 'zhipu', name: '智谱 (GLM)', base: 'https://open.bigmodel.cn/api/paas/v4', enabled: false,
    models: [],
    logo: '/providers-logo/zhipu.png',
  },
  /* ── 0917：Agnes 拆成国际版 / 国内版两条（用户要求「默认一个国际版一个国内版」）。
   *  国际版沿用 id 'agnes'（老用户已配的 Key 平滑继承），国内版新 id 'agnes-cn'。
   *  两版模型表相同——同一个网关的不同入口，模型名一致。── */
  {
    id: 'agnes', name: 'Agnes AI (国际版)', base: 'https://apihub.agnes-ai.com/v1', enabled: false,
    models: [],
    logo: '/providers-logo/agnes.png',
  },
  {
    id: 'agnes-cn', name: 'Agnes AI (国内版)', base: 'https://api.agnes-ai.cn/v1', enabled: false,
    models: [],
    logo: '/providers-logo/agnes.png',
  },
  {
    id: 'ollama', name: 'Ollama (本地)', base: 'http://127.0.0.1:11434/v1', enabled: false,
    models: [],
    logo: '/providers-logo/ollama.svg',
  },
  {
    id: 'openrouter', name: 'OpenRouter', base: 'https://openrouter.ai/api/v1', enabled: false,
    models: [],
    logo: '/providers-logo/openrouter.svg',
  },
  /* ★1010（需求）：用户自配的 5 家收录为**出厂默认**（商汤 / commandcode.ai / 阶跃星辰plan / xiaomi / AMD）。
     老配置不受影响：providers.json 里已有同名 id 时以存档为准（见 mergeDefaults）；这 5 家出厂 enabled:false。
     id 沿用用户现有写法（'阶跃星辰plan' / 'AMD' 保持原样），logo 文件用 ASCII 名。 */
  {
    id: 'sensenova', name: '商汤日日新', base: 'https://token.sensenova.cn/v1', enabled: false,
    models: [],
    logo: '/providers-logo/sensenova.png',
  },
  {
    id: 'commandcode.ai', name: 'commandcode.ai', base: 'https://api.commandcode.ai/provider/v1', enabled: false,
    models: [],
    logo: '/providers-logo/commandcode-ai.png',
  },
  {
    id: '阶跃星辰plan', name: '阶跃星辰plan', base: 'https://api.stepfun.com/step_plan/v1', enabled: false,
    models: [],
    logo: '/providers-logo/stepfun-plan.svg',
  },
  {
    id: 'xiaomi', name: 'xiaomi', base: 'https://api.xiaomimimo.com/v1', enabled: false,
    models: [],
    logo: '/providers-logo/xiaomi.png',
  },
  {
    id: 'AMD', name: 'AMD', base: 'https://developer.amd.com.cn/radeon/api/v1', enabled: false,
    models: [],
    logo: '/providers-logo/amd.png',
  },
]

/** 0918：是不是「内置供应商」（出厂自带 /providers-logo/<id>.* 图标）。
 *  抓官网 logo 的守卫要用它，而不是「logo 是否以 /providers-logo/ 开头」——
 *  自定义供应商也曾被赋同前缀（文件并不存在），导致内置判定错误、抓取被拒。 */
export function isBuiltinProvider(id: string): boolean {  const want = String(id || '')
  return DEFAULT_PROVIDERS.some(p => p.id === want)
}

let providersDegraded = false

let state: ProviderState = load()

/** ★ 0920：**历史遗留的"出厂预置"模型清单**。
 *  早期版本的出厂表里预置了模型（Agnes 3 / LongCat 1 / DeepSeek·OpenAI·Anthropic·智谱 各 2），
 *  而当时的应用会把这些默认值**写进 providers.json** —— 于是哪怕现在出厂表已经清空
 *  （设计口径：全新安装一律 0 个模型），老用户的存档里还留着这一份，界面继续显示"3 个模型"。
 *  规则：某个内置供应商的模型 id 集合**恰好等于**当年的出厂预置集合 → 判定为遗留，清空。
 *  ⚠️ 只认"完全相等"：用户真去拉了模型，集合几乎总会不同（真实接口动辄几十个）；
 *     自定义供应商（opencommand 等）不在表内，一律不动。
 *  ⚠️ 只跑**一次**（providers.json 里记 `legacyModelsCleaned`）—— 万一以后用户真拉到的模型
 *     恰好等于这个集合，也不会被反复清掉。 */
const LEGACY_FACTORY_MODELS: Record<string, string[]> = {
  longcat: ['LongCat-2.0'],
  deepseek: ['deepseek-chat', 'deepseek-reasoner'],
  openai: ['gpt-4o-mini', 'gpt-4o'],
  anthropic: ['claude-3-5-sonnet-20241022', 'claude-3-5-haiku-20241022'],
  zhipu: ['glm-4-flash', 'glm-4-plus'],
  agnes: ['agnes-3.0-flash', 'agnes-2.5-flash', 'agnes-2.0-flash'],
  'agnes-cn': ['agnes-3.0-flash', 'agnes-2.5-flash', 'agnes-2.0-flash'],
}

/** 清掉存档里遗留的出厂预置模型（一次性）。返回被清空的供应商名，供日志用。 */
export function dropLegacyFactoryModels(): string[] {
  const cleaned: string[] = []
  try {
    if (!fs.existsSync(STATE_FILE)) return cleaned
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
    if (!raw || !Array.isArray(raw.providers) || raw.legacyModelsCleaned) return cleaned
    const sameSet = (a: string[], b: string[]) =>
      a.length === b.length && a.slice().sort().join('|') === b.slice().sort().join('|')
    for (const p of raw.providers as ProviderConfig[]) {
      const legacy = LEGACY_FACTORY_MODELS[p.id]
      if (!legacy) continue
      const ids = (p.models || []).map(m => m.id)
      if (ids.length && sameSet(ids, legacy)) {
        p.models = []
        cleaned.push(String(p.name || p.id))
        /* 连带处理"当前激活模型"：它指向刚被清掉的预置模型就没意义了 ——
           留着会让模型选择器显示一个其实不存在的模型，一发消息就报 API 错。 */
        if (raw.providerActive === p.id && raw.activeModelId && legacy.includes(String(raw.activeModelId))) {
          raw.activeModelId = ''
        }
      }
    }
    raw.legacyModelsCleaned = true
    /* ★ 0927 第 0 批：原子写（tmp 带 pid+随机）替换裸 writeFileSync */
    writeJsonAtomic(STATE_FILE, raw)
  } catch (e) {
    console.error('[providers] dropLegacyFactoryModels failed:', e)
  }
  if (cleaned.length) state = load()
  return cleaned
}

/* 启动时也跑一次（幂等 + 靠标记只跑一次）—— 让「装完新版就直接看到 0 个模型」，
   不用非得重新导入一遍。⚠️ 必须写在这里：上面 LEGACY_FACTORY_MODELS 是 `const`，
   放在它之前调用会踩 TDZ（今天刚修过同款）。 */
try { dropLegacyFactoryModels() } catch (e) { /* ★ 0927 第 0 批：TDZ 保护保留（不能崩启动），但失败必须可见 */
  console.error('[providers] dropLegacyFactoryModels failed:', e) }

/** ★ 0920（设计口径，第三批）：**导入数据包之后**调用 —— 包里的 providers.json 是"用户自己的老环境"，
 *  里面的模型表**原样保留**（"老数据里有模型就不需要归 0"），同时补上 `legacyModelsCleaned` 标记，
 *  免得下次启动又被 `dropLegacyFactoryModels()` 当成"出厂遗留"清掉。
 *
 *  三条对照口径：
 *   · 导入的老数据里**有**模型 → 保留（本函数）；
 *   · 老数据里**没有**的 → 0（整份 providers.json 被替换，天然如此）；
 *   · **没导入**老数据（全新装）→ 全 0（出厂表已清空）；本机存档里的历史遗留仍由启动时的
 *     `dropLegacyFactoryModels()` 负责清掉——那条不能删，否则升级上来的老用户又看到"凭空 3 个模型"。
 *
 *  ⚠️ 上一版（0.0.10）在两条导入分支里都调了 `dropLegacyFactoryModels()` → 老包里那批模型被清空，
 *  实测反馈"导入后模型全归 0"（见 0.0.11 修复单第 5 条）。 */
export function keepImportedProviderModels(): number {
  try {
    if (!fs.existsSync(STATE_FILE)) return 0
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
    if (!raw || !Array.isArray(raw.providers)) return 0
    if (raw.legacyModelsCleaned) { state = load(); return 0 }
    raw.legacyModelsCleaned = true
    // 原子写（与 persist 一致）：providers.json 损坏 = 用户全部 Key 静默丢失
    /* ★ 0927 第 0 批：writeJsonAtomic（tmp 带 pid+随机，多进程并发不互截） */
    writeJsonAtomic(STATE_FILE, raw)
    state = load()
    return (raw.providers as ProviderConfig[]).reduce((n, p) => n + (p.models || []).length, 0)
  } catch (e) {
    console.error('[providers] keepImportedProviderModels failed:', e)
    return 0
  }
}

/* ★ 0927 第 0 批：providers.json 损坏降级标志。
   注意：本文件的 fallback 是**有内容的默认表**（不是空表）——degraded 期间任何写回都会把
   用户的 Key/模型表覆盖成默认值，因此这里的选择是**一律拒绝写盘**（暴露问题 > 静默丢数据）。 */

function load(): ProviderState {
  /* ★ 0927 第 0 批：共享 jsonStore —— ENOENT 才回落默认表；内容损坏先备份 .corrupt-* 再回落并标记
     degraded。（旧逻辑：损坏也静默 return 默认表 → 随后任何 persist 就把默认表（空 Key）写成
     权威 → 用户全部 API Key 静默丢失。体检 P0，家族①病根。） */
  const r = loadJsonOrBackup<any>(STATE_FILE, () => null)
  const raw = r.data
  if (r.degraded) providersDegraded = true
  if (raw && Array.isArray(raw.providers)) {
    // 默认表与存储合并：存储的字段覆盖默认；默认表新增的供应商补进
    const merged: ProviderConfig[] = DEFAULT_PROVIDERS.map(def => {
      const saved = (raw.providers as ProviderConfig[]).find((p: ProviderConfig) => p.id === def.id)
      if (!saved) return def
      // 模型表：saved 覆盖 def，但用默认表补齐 capabilities（旧数据缺失 → isReasoningModel 判断失效）
      const savedModels = (saved.models || []).map(m => {
        const dm = def.models.find(d => d.id === m.id)
        if (dm && !m.capabilities) return { ...m, capabilities: dm.capabilities }
        return m
      })
      return { ...def, ...saved, models: savedModels.length > 0 ? savedModels : def.models,
        /* ★1003 批次4 4.33：''（用户**主动清空**）≠ 字段缺失（旧数据升级）—— 原 `saved.apiKey || def.apiKey`
         * 把用户清掉的 key 复活（0925b"空串回落"好意办坏事：请求带着用户以为已删除的 key 出门）。
         * 现在：属性存在就以用户值为准（含空串）；缺失才回落默认表。 */
        apiKey: ('apiKey' in saved && saved.apiKey !== undefined) ? saved.apiKey : (def.apiKey || '') }
    })
    for (const p of raw.providers as ProviderConfig[]) {
      if (!DEFAULT_PROVIDERS.some(d => d.id === p.id)) merged.push(p)
    }
    return {
      providers: merged,
      // 0917：不再把 'longcat' 当缺省激活项（用户没开 LongCat 却被它接管请求）
      providerActive: raw.providerActive || '',
      activeModelId: raw.activeModelId || '',
      /* ★1012t：后台模型（非对话场景专用）—— 老数据缺这两个键 = 空串 = 回落全局聊天模型 */
      backgroundProviderId: String((raw as any).backgroundProviderId || ''),
      backgroundModelId: String((raw as any).backgroundModelId || ''),
      backgroundEffort: String((raw as any).backgroundEffort || ''),
    }
  }
  /* schema 级损坏（JSON 合法但 providers 不是数组）同样按降级处理 */
  if (raw != null) {
    providersDegraded = true
    console.error('[providers] 文件结构异常（providers 不是数组），按降级处理：', STATE_FILE)
  }
  return {
    providers: JSON.parse(JSON.stringify(DEFAULT_PROVIDERS)),
    providerActive: '',
    activeModelId: '',
    backgroundProviderId: '',
    backgroundModelId: '',
    backgroundEffort: '',
  }
}

function persist(): void {
  /* ★ 0927 第 0 批：原子写（tmp 带 pid+随机防并发互截）+ degraded 一律拒绝回写。
     旧逻辑：固定 tmp 名 + 损坏降级时会把默认表（空 Key）rename 覆盖磁盘。 */
  if (providersDegraded) {
    console.error('[providers] 拒绝写盘：providers.json 已损坏降级，当前状态不完整——' +
      '写回会用默认表覆盖用户数据。请从盘上 .corrupt-* 备份恢复，或人工核对后删除坏档重启。')
    return
  }
  writeJsonAtomic(STATE_FILE, state)
}

/** 供应商是否「可用」：已启用，且有 Key，或本地服务（ollama 等） */
function providerReady(p: ProviderConfig): boolean {
  if (!p?.enabled) return false
  if (p.apiKey) return true
  return /^https?:\/\/(127\.0\.0\.1|localhost)/.test(p.base || '')
}

/** ★ 0920：把 providers.json 重新读进内存。
 *  为什么需要：导入数据（`data.importApply`）会**直接覆盖磁盘上的** `providers.json`，
 *  但内存里的 `state` 是启动时 `load()` 的一次性快照 —— 不重读的话，
 *  「刚导入了设置（含密钥），供应商列表却一个都没生效」，
 *  而且此后所有请求还继续用旧 Key（用户 0919 实测就是这个现象）。
 *  导入侧调用它即可，不用重启。 */
export function reloadProviders(): void {
  invalidatePlainKeyCache()   // ★1003 4.32：导入覆盖 providers.json 后旧明文必须作废
  try {
    state = load()
    console.log('[providers] reloaded from disk（数据导入后重载）')
  } catch (e) {
    console.error('[providers] reload failed:', e)
  }
}

/** 当前激活供应商。
 *  0917 修：providerActive 为空 / 指向未启用的供应商时，回落到**第一个已启用且可用的**
 *  —— 此前无条件回落 providers[0]（LongCat），造成「UI 显示 A、实际发 LongCat」的错位报错。 */
export function activeProvider(): ProviderConfig {
  const byId = state.providers.find(p => p.id === state.providerActive)
  if (byId && byId.enabled) return byId
  const ready = state.providers.find(providerReady)
  if (ready) return ready
  const anyEnabled = state.providers.find(p => p.enabled)
  if (anyEnabled) return anyEnabled
  return byId || state.providers[0]
}

/** 当前激活模型 id（会话未指定时用全局） */
export function activeModelId(): string {
  // 用户显式选择（setActiveModel 已持久化）优先原样返回——即使模型不在本地表
  // （LongCat 等聚合 API 按模型名路由），不再校验回退导致"选了 kimi 却回 longcat"
  if (state.activeModelId) return state.activeModelId
  const p = activeProvider()
  return p.models.find(x => x.enabled !== false)?.id || ''
}

/** 当前 LLM 调用配置（provider/base/apiKey/model/proxy/protocol/effort） */
export function currentLlmConfig(): { providerId: string; providerName: string; base: string; apiKey: string; model: string; proxyUrl: string; protocol: 'openai-completions' | 'anthropic-messages' | 'google-generative-ai'; effort?: string | null } {
  const p = activeProvider()
  const model = activeModelId()
  return {
    providerId: p.id,
    providerName: p.name,
    base: (p.base || '').replace(/\/+$/, ''),
    apiKey: plainKey(p),
    model,
    proxyUrl: (p as any).proxyUrl || '',
    protocol: p.protocol || 'openai-completions',
    // 全局推理强度：钳到该模型可用挡（非推理模型 → null，调用侧据此不发 reasoning_effort）
    effort: clampEffort(p.id, model, state.activeEffort),
  }
}

/** ★1012t：**后台模型**（非对话场景专用）—— 知识库/记忆库自动提炼、QQ/微信渠道（未单独配模型时）、定时任务等。
    为什么要单独一个（用户原话）："这个全局模型我本想的就是作为一个**对话之外**的工作模型，能不能把他们分开"；
    而实测病根是"全局模型会跟着对话切换模型而改变"（0912 那次把"提炼模型"并进了全局聊天模型，现在拆回来）。
    `backgroundModelId` 为空 = 回落全局聊天模型（老数据无缝、行为不变）。 */
export function setBackgroundModel(providerId: string, modelId: string, effort?: string | null): void {
  state.backgroundProviderId = String(providerId || '')
  state.backgroundModelId = String(modelId || '')
  // effort：undefined = 不改；null/'' = 清空（按模型默认挡）
  if (effort !== undefined) state.backgroundEffort = effort === null ? '' : String(effort || '')
  persist()
}

/** ★1013：后台模型的调用配置。**未配置就是未配置** —— 不再悄悄回落聊天模型
    （用户："想用免费模型做后台任务，自动回落却回到贵的模型上，等于在偷用户的钱"）。
    调用方看 `configured`：false ⇒ 别调 LLM，直接把 `reason` 报给用户 + 提醒去设置里选。 */
type BackgroundLlmConfig = {
  providerId: string; providerName: string; base: string; apiKey: string; model: string
  proxyUrl: string; protocol: 'openai-completions' | 'anthropic-messages' | 'google-generative-ai'
  effort?: string | null
  /** true = 配好了、可用；false = 未配置 / 所指供应商不存在·被停用·缺 Key（此时各字段为空串） */
  configured: boolean
  /** configured=false 时给用户看的中文原因（直接可用于通知/错误消息） */
  reason: string
}

export function backgroundLlmConfig(): BackgroundLlmConfig {
  const empty = (reason: string): BackgroundLlmConfig => ({
    providerId: '', providerName: '', base: '', apiKey: '', model: '',
    proxyUrl: '', protocol: 'openai-completions', effort: null, configured: false, reason,
  })
  const bgPid = String(state.backgroundProviderId || '')
  const bgMid = String(state.backgroundModelId || '')
  if (!bgPid || !bgMid) return empty('未配置「后台模型」：请到 设置 → 通用 → 模型 → 后台模型 选一个')
  const p = state.providers.find(x => x.id === bgPid)
  if (!p) return empty(`「后台模型」的供应商「${bgPid}」已不存在，请重新选一个`)
  if (!p.enabled || !providerReady(p)) return empty(`「后台模型」的供应商「${p.name || p.id}」未启用或缺 API Key，请检查`)
  return {
    providerId: p.id,
    providerName: p.name,
    base: (p.base || '').replace(/\/+$/, ''),
    apiKey: plainKey(p),
    model: bgMid,
    proxyUrl: (p as any).proxyUrl || '',
    protocol: p.protocol || 'openai-completions',
    // ★1013：强度用**后台模型自己的**设置（原来借用全局聊天强度 —— 后台/对话强度被绑在一起）
    effort: clampEffort(p.id, bgMid, state.backgroundEffort),
    configured: true,
    reason: '',
  }
}

/** 0910：设/清供应商协议（缺省 openai-completions；anthropic-messages/google-generative-ai 走原生适配器） */
export function setProviderProtocol(providerId: string, protocol: ProviderConfig['protocol']): void {
  const p = state.providers.find(x => x.id === providerId)
  if (!p) return
  if (protocol && protocol !== 'openai-completions') p.protocol = protocol
  else delete p.protocol
  persist()
}

export function getState(): ProviderState {
  return state
}

/* ── 0907 供应商 A+B：模型能力单一真相源（server 请求组装、prompt 图闸门、list RPC 都从这里取；
 *    前端 bootstrap 用 autoDetectCaps 写 capabilities，此函数消费之——口径与前端 ModelSelector
 *   「capabilities 为权威、正则只兜模型不在表」完全一致）── */
interface ModelCaps {
  /** 发给 pi 内核的输入模态（决定网关 payload 是否可携带 image） */
  input: ('text' | 'image')[]
  /** 是否支持 reasoning_effort 参数（true 才附加，避免普通模型未知参数报错） */
  reasoning: boolean
  /** 可读图（发图闸门依据） */
  vision: boolean
  /** 输出模态；不含 'text' 的（纯生图/视频）不可作聊天模型——本轮仅产出，UI 接入后消费 */
  output: string[]
}

/** 推理模型名兜底表（原 server.ts isReasoningModel 并入此处，全站唯一一份） */
const REASONING_NAME_RE = /o[1-9]|o3|o4|r1|reasoner|k2|think|thinking|z1|glm-z1|deepseek-reasoner|glm-5|glm-4\.7|glm-4-plus|step-2|kimi-k|qwq|moonshot-reasoner|claude-sonnet-4|claude-opus-4/i
/** 视觉模型名兜底表（与前端 stores/providers.autoDetectCaps 的 image 推断同源；无 capabilities 的新模型才会走到） */
const VISION_NAME_RE = /(mimo|vl|vision|omni|multimodal|gpt-4o|gpt-4\.1|gpt-5|grok|gemini|claude-3|claude-sonnet|claude-opus|glm-4v|glm-4\.\d+v|glm-5v|qwen-vl|qwen2?-vl|hunyuan-vision|ernie-4|step-1v|step-2v|kimi-vl|deepseek-vl|mini-cpm-v|llava|yi-vl|internvl|phi-4-multimodal|paligemma|seed-vl)/i
/** 纯生图/视频/语音（输出模态推断）：命中则 chatEligible=false */
const GEN_IMAGE_RE = /^(gpt-image|dall-e|dall3|flux|stable-diffusion|sdxl|midjourney|agnes-image|imagen|nano-banana)/i
const GEN_VIDEO_RE = /(kling|runway|sora|veo-|pika|luma|hailuo|seedance|wan-|vidu|gen-3|ray2)/i
const GEN_AUDIO_RE = /(tts|whisper|cosyvoice|suno|elevenlabs|paraformer|speech-|fish-speech)/i

/** 解析某模型有效能力：显式三轴 > providers.json 已存 capabilities（手写=最高，含 LongCat）
 *  > models.dev 快照（0907：只填"从没设过能力"的模型）> 模型名正则兜底。
 *  dev 查询走同步内存快照（lookupDevCapsSync，请求热路径零网络 I/O；快照在"获取模型"时刷新）。 */
export function resolveModelCaps(providerId: string, modelId: string): ModelCaps {
  const m = state.providers.find(x => x.id === providerId)?.models?.find(x => x.id === modelId)
  const arr = m?.capabilities
  const hasExplicit = !!(m && (m.inputModalities || (m.supports && (typeof m.supports.vision === 'boolean' || typeof m.supports.reasoning === 'boolean'))))
  const hasCapArr = !!(arr && arr.length)
  // models.dev 快照（仅在无显式三轴且无 capabilities 时启用）
  const dev = (hasExplicit || hasCapArr) ? null : lookupDevCapsSync(modelId, providerId)
  let vision: boolean
  let reasoning: boolean
  if (m?.inputModalities) vision = m.inputModalities.includes('image')
  else if (m?.supports && typeof m.supports.vision === 'boolean') vision = m.supports.vision
  else if (hasCapArr) vision = arr!.includes('image')
  else if (dev) vision = dev.input.includes('image')
  else vision = VISION_NAME_RE.test(modelId || '')
  if (m?.supports && typeof m.supports.reasoning === 'boolean') reasoning = m.supports.reasoning
  else if (hasCapArr) reasoning = arr!.includes('reasoning') || (!!m && REASONING_NAME_RE.test(modelId)) // 表内模型以 capabilities 为权威，不再正则翻案（对齐前端 0902-2 铁律）
  else if (dev && typeof dev.reasoning === 'boolean') reasoning = dev.reasoning
  else reasoning = REASONING_NAME_RE.test(modelId || '')
  let output: string[]
  if (m?.outputModalities?.length) output = m.outputModalities
  else if (dev && dev.output.length) output = dev.output
  else if (GEN_IMAGE_RE.test(modelId || '')) output = ['image']
  else if (GEN_VIDEO_RE.test(modelId || '')) output = ['video']
  else if (GEN_AUDIO_RE.test(modelId || '')) output = ['audio']
  else if (hasCapArr) output = arr!.includes('text') ? ['text'] : arr!.includes('image') ? ['image'] : ['text']
  else output = ['text']
  return { input: vision ? ['text', 'image'] : ['text'], reasoning, vision, output }
}


/* ── 0910 推理挡位按模型声明：全站唯一解析口（前端展示/后端发送共用同一语义）──
 * NIS 内部挡位 id 固定四挡序：fast(Low)<deep(Mid)<heavy(High)<burning(Max)。
 * 优先级：providers.json 显式 efforts（用户在 ✎ 面板勾过=权威）> 网关族兜底推导：
 *  - 非推理模型 → []（无思考概念，前端整个强度入口隐藏，后端不发 reasoning_effort）
 *  - zai 系（bigmodel.cn/api.z.ai）推理模型 → 去 deep（探针实锤 medium 400「始终思考，
 *    请使用 low、high 或 max」）
 *  - 其余 → 全四挡。个别网关怪癖（如 minimax-m3 拒 medium）用显式声明覆盖。 */
const EFFORT_LEVELS = ['fast', 'deep', 'heavy', 'burning'] as const
export function resolveModelEfforts(providerId: string, modelId: string): string[] {
  const p = state.providers.find(x => x.id === providerId)
  const m = p?.models?.find(x => x.id === modelId)
  if (m?.efforts) return EFFORT_LEVELS.filter(e => m.efforts!.includes(e))
  if (!resolveModelCaps(providerId, modelId).reasoning) return []
  if (/bigmodel\.cn|api\.z\.ai/i.test(p?.base || '')) return ['fast', 'heavy', 'burning']
  /* 0920 修正（反馈"思考强度不精准"）：**默认只给三挡**。
   *  OpenAI 兼容协议只有 low/medium/high 三个值，原先这里返回四挡 → `burning` 与 `heavy`
   *  在发送侧被映射成同一个 `high`，**UI 上能选、实际没有任何区别**。
   *  真能表达第四挡（`max`）的目前只有智谱 z.ai / bigmodel —— 它自己的报错文案就写着
   *  "请使用 low、high 或 max"，所以那一族在上面单独返回。 */
  return ['fast', 'deep', 'heavy']
}
/** 把请求挡钳到该模型可用挡：不在表内→按索引距离取最近（平距取更重挡，贴合"多思考"意图）；
 *  无可用挡（非推理模型）→ null（发送侧据此不发 reasoning_effort）。 */
export function clampEffort(providerId: string, modelId: string, effort: string | null | undefined): string | null {
  const allowed = resolveModelEfforts(providerId, modelId)
  if (!allowed.length) return null
  const want = (EFFORT_LEVELS as readonly string[]).includes(effort || '') ? (effort as string) : 'deep'
  if (allowed.includes(want)) return want
  const wi = EFFORT_LEVELS.indexOf(want as typeof EFFORT_LEVELS[number])
  let best = allowed[0], bestD = 99
  for (const a of allowed) {
    const d = Math.abs(EFFORT_LEVELS.indexOf(a as typeof EFFORT_LEVELS[number]) - wi)
    if (d < bestD || (d === bestD && EFFORT_LEVELS.indexOf(a as typeof EFFORT_LEVELS[number]) > EFFORT_LEVELS.indexOf(best as typeof EFFORT_LEVELS[number]))) { best = a; bestD = d }
  }
  return best
}

/** 0923：从供应商 /models 响应里"白捡"上限真值——各家字段名不一，有就接（网关亲口说的 > 第三方目录）。
 *  实测 opencommand：`{ context_length: 1000000 }`（80/80 条都有，而我们此前只读了 id，全扔了）；
 *  其余常见形态：OpenRouter 的 `top_provider.max_completion_tokens`、vLLM 的 `max_model_len`、
 *  部分网关的 `max_output_tokens` / `max_completion_tokens` / `context_window`。
 *  没给也不强求：输出上限还有"400 自愈 + 保险丝"两条后路。 */
function readGatewayLimits(raw: any[]): Record<string, { context?: number; maxOutput?: number }> {
  const out: Record<string, { context?: number; maxOutput?: number }> = {}
  const num = (...vals: any[]): number => {
    for (const v of vals) { const n = Number(v) || 0; if (n > 0) return Math.round(n) }
    return 0
  }
  for (const m of raw || []) {
    const id = String(m?.id || m?.name || '').replace(/^models\//, '')
    if (!id) continue
    const ctx = num(m?.context_length, m?.context_window, m?.max_context, m?.maxContext, m?.max_model_len, m?.limit?.context, m?.input_token_limit, m?.top_provider?.context_length)
    const cap = num(m?.max_output_tokens, m?.maxOutput, m?.max_completion_tokens, m?.max_tokens, m?.limit?.output, m?.output_token_limit, m?.top_provider?.max_completion_tokens)
    if (ctx || cap) out[id] = { ...(ctx ? { context: ctx } : {}), ...(cap ? { maxOutput: cap } : {}) }
  }
  return out
}
/* ── 0907 获取模型弹窗：每个候选模型的"建议能力 + 来源"（默认勾选值 + 三处标签）──
 * 来源优先级与 resolveModelCaps 一致：providers.json 已存手写 > models.dev > 名字推断。
 * 0923：网关接口带回的上限值（gw）优先于 models.dev——它是**你实际这条链路**的口径，
 *   而 models.dev 是跨供应商聚合（曾被路由商标的 943718 带偏，直接 400）。
 * 纯建议，最终以后端 resolveModelCaps 落库结果为准（用户可在弹窗改，改后写回 capabilities）。 */
interface SuggestedCaps {
  id: string
  vision: boolean
  reasoning: boolean
  input: string[]
  output: string[]
  context?: number
  /** 0917：models.dev 的真实输出上限（弹窗保存时带入 ProviderModel.maxOutput，空=未查到） */
  maxOutput?: number
  /** 来源标签：manual=你已存的手写能力 / dev=models.dev / inferred=名字推断 */
  source: 'manual' | 'dev' | 'inferred'
}
function suggestCapsForIds(providerId: string, ids: string[], gw?: Record<string, { context?: number; maxOutput?: number }>): SuggestedCaps[] {
  const p = state.providers.find(x => x.id === providerId)
  return ids.map(id => {
    const existing = p?.models?.find(x => x.id === id)
    const arr = existing?.capabilities
    const gwCtx = Number(gw?.[id]?.context) || 0
    const gwOut = Number(gw?.[id]?.maxOutput) || 0
    if (existing && ((existing.inputModalities) || (existing.supports) || (arr && arr.length))) {
      const c = resolveModelCaps(providerId, id) // manual：直接取权威解析
      return {
        id, vision: c.vision, reasoning: c.reasoning, input: c.input, output: c.output,
        // 已存手写最高；没存到就用网关真值补上
        context: existing.maxContext || gwCtx || undefined,
        maxOutput: existing.maxOutput || gwOut || undefined,
        source: 'manual' as const,
      }
    }
    const dev = lookupDevCapsSync(id, providerId)
    if (dev && (dev.input.length || dev.output.length)) {
      return {
        id,
        vision: dev.input.includes('image'),
        reasoning: !!dev.reasoning,
        input: dev.input.length ? dev.input : ['text'],
        output: dev.output.length ? dev.output : ['text'],
        // 网关值优先（实测更准）
        context: gwCtx || dev.context,
        maxOutput: gwOut || dev.maxOutput,
        source: 'dev' as const,
      }
    }
    return {
      id,
      vision: VISION_NAME_RE.test(id),
      reasoning: REASONING_NAME_RE.test(id),
      input: VISION_NAME_RE.test(id) ? ['text', 'image'] : ['text'],
      output: GEN_IMAGE_RE.test(id) ? ['image'] : ['text'],
      context: gwCtx || undefined,
      maxOutput: gwOut || undefined,
      source: 'inferred' as const,
    }
  })
}

/* ── 0917 单次输出上限（max_tokens / maxOutputTokens）三元解析：全站唯一解析口 ──
 * 优先级：providerModel.maxOutput（用户手填 / 获取模型时按 models.dev 真实值带入）
 *        > models.dev limit.output（官方"实际数值"，provider 精确命中 > 跨供应商聚合）
 *        > DEFAULT_MAX_OUTPUT（16384，与改造前行为一致 = 兜底零回归）。
 * 兜底档还会钳到上下文窗口（聚合数据可能给出大于窗口的输出上限 → 部分网关直接 400）；
 * 显式手填值不钳（用户权威，可能知道自家网关的特殊口径）。
 * 与 resolveModelCaps / resolveModelEfforts 同款语义：展示侧与发送侧共用一份口径。 */
const DEFAULT_MAX_OUTPUT = 16384
export function resolveMaxOutput(providerId: string, modelId: string): number {
  const p = state.providers.find(x => x.id === providerId)
  const m = p?.models?.find(x => x.id === modelId)
  const explicit = Number(m?.maxOutput) || 0
  if (explicit > 0) return explicit
  const dev = Number(lookupDevCapsSync(modelId, providerId)?.maxOutput) || 0
  const base = dev > 0 ? dev : DEFAULT_MAX_OUTPUT
  const win = Number(m?.maxContext) || 0
  return win > 0 ? Math.max(256, Math.min(base, win)) : base
}

/* ── 0921 上下文窗口 / 单次输入上限：与 resolveMaxOutput 同款「全站唯一解析口」──
 * 背景（实测 400，安装版日志实锤）：网关是按 **"输入 + 输出预留 ≤ 窗口"** 判的，
 *   所以窗口 / 输入上限 / 输出上限这三个数必须共用一套口径，不能各算各的。
 * 窗口解析：用户显式 maxContext（权威）> models.dev limit.context > 兜底 128000；
 *   两边都有时**取小的** —— dev 那份是供应商声明的口径，用户填更大只会把自己送进 400
 *   （dev 值 < 4096 视为脏数据忽略，别让一条坏数据把窗口掐死）。
 * 发送预算（能要多少输出）见 server.ts computeSendBudget。 */
const DEFAULT_CONTEXT_WINDOW = 128000
export function resolveContextWindow(providerId: string, modelId: string): number {
  const p = state.providers.find(x => x.id === providerId)
  const m = p?.models?.find(x => x.id === modelId)
  const explicit = Number(m?.maxContext) || 0
  const devRaw = Number(lookupDevCapsSync(modelId, providerId)?.context) || 0
  const dev = devRaw >= 4096 ? devRaw : 0
  if (explicit > 0 && dev > 0) return Math.min(explicit, dev)
  if (explicit > 0) return explicit
  if (dev > 0) return dev
  return DEFAULT_CONTEXT_WINDOW
}
/** 单次输入上限解析：用户显式填 = 权威；返回 0 = 未声明（不设限，发送侧按"窗口 − 输出预留"动态算）。
 *  注意"不填 ≠ 不设限就别管"——发送预算仍然会算，只是上限来自窗口而非这个字段。 */
export function resolveMaxInput(providerId: string, modelId: string): number {
  const p = state.providers.find(x => x.id === providerId)
  const m = p?.models?.find(x => x.id === modelId)
  const explicit = Number(m?.maxInput) || 0
  return explicit > 0 ? explicit : 0
}

/** ★ 0930 密钥加密：老数据迁移 —— providers.json 里的**明文 key** 就地加密成 DPAPI 密文。
 *  铁律（改动前请先读）：
 *  ① 动之前先备份（providers.json.bak-密钥加密-<时间戳>），出问题一键回退；
 *  ② 不做裸 writeFileSync，走 writeJsonAtomic（0927 起的老规矩）；
 *  ③ **先全部在内存里加密成功再动文件** —— 任一家失败就不写盘。宁可保持"全明文"，
 *     也绝不留下"一半明文一半密文"的混合态：那种状态最难排查（有的能解有的不能，行为还不一致）。*/
function migratePlainKeysToEncrypted(): { migrated: number; backup: string | null; skipped: boolean; reason?: string } {
  try {
    if (!fs.existsSync(STATE_FILE)) return { migrated: 0, backup: null, skipped: true, reason: 'providers.json 不存在' }
    const json = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
    if (!json || !Array.isArray(json.providers)) return { migrated: 0, backup: null, skipped: true, reason: 'providers.json 结构不符' }
    const plains = (json.providers as any[]).filter(p => p?.apiKey && !isEncrypted(p.apiKey))
    if (!plains.length) return { migrated: 0, backup: null, skipped: true, reason: '没有明文 key（已是密文或本来就没配）' }

    const sealed = plains.map(p => ({ id: p.id, apiKey: encryptDpapi(p.apiKey), keyHint: keyHint(p.apiKey) }))  // ← 这里抛错 = 整体放弃

    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
    const backup = `${STATE_FILE}.bak-密钥加密-${stamp}`
    fs.copyFileSync(STATE_FILE, backup)                                                                                    // 先备份
    for (const s of sealed) {
      const p = (json.providers as any[]).find(x => x.id === s.id)
      if (p) { p.apiKey = s.apiKey; p.keyHint = s.keyHint }
    }
    writeJsonAtomic(STATE_FILE, json)
    plainKeyCache.clear()                                                                                                 // 清内存明文缓存，按密文重解
    try { state = load() } catch { /* 内存态保持旧值，下次启动自愈 */ }
    console.warn(`[providers] 密钥加密迁移完成：${sealed.length} 家已改为 DPAPI 密文（备份 ${path.basename(backup)}）`)
    return { migrated: sealed.length, backup, skipped: false }
  } catch (e: any) {
    console.error('[providers] 密钥加密迁移失败（providers.json 保持原样、未改动）：', e)
    return { migrated: 0, backup: null, skipped: true, reason: String(e?.message || e) }
  }
}

/** ★ 0930 导出跨机器（B 方案）：给**要打进包的** providers.json 加一份口令副本。
 *  为什么需要：本机那把是 DPAPI 密文，出了这台机器就解不开（预期行为）。
 *  导出一个包 = 把它变成"只有填了口令的包才带得走钥匙"，换电脑输同一句即可恢复。
 *  ⚠ 只处理 providers.json：**前端那份key 从不落盘**（providers store 的 persist() 已是 no-op，
 *    "后端为唯一事实源"），故 ui-state.json / settings.json 里都没有明文密钥。
 *    （store 顶部那句"持久化到 localStorage（含 API Key）"是过时旧注释，与实现相反，别被它误导。）*/
export function sealPortableKeys(json: any, passphrase: string): { sealed: number; failed: string[] } {
  /* ★ 0930 自测抓到：口令太弱时 encryptWithPassphrase 会抛错，而下面那个 catch 会把它**静默吞掉**
     （只 failed.push）—— 结果包照样导出成功、密钥却没带上，用户还以为带上了。
     所以弱口令必须在**入口**就硬拒，让用户当场知道，而不是等包做完才发现。*/
  /* ★1011（老大要求）：弱口令不再拦截 —— 照常加密进包，风险由前端强度条明确提示。
     （旧行为：弱口令直接 throw ⇒ 这两份密钥整个不进包 ⇒ 用户填了口令却没带密钥，还没提示。） */
  const failed: string[] = []
  let sealed = 0
  for (const p of (json?.providers || [])) {
    if (!p?.apiKey) continue
    try {
      const r = decryptKey(p.apiKey)
      if (!r.ok) { failed.push(p.id); continue }                 // 本机就解不开 → 更没法做口令副本，如实跳过并记账
      p.apiKeyPortable = encryptWithPassphrase(r.key, passphrase)
      p.keyHint = p.keyHint || keyHint(r.key)
      sealed++
    } catch (e: any) {
      failed.push(p.id)
      console.warn(`[providers] 供应商「${p.id}」的口令副本生成失败：${e?.message || e}`)   // 不静默：记账 + 留日志
    }
  }
  return { sealed, failed }
}

/** 导入侧：用口令把包里的 apiKeyPortable 兑现成**本机能用的** key。
 *  兑现方式 = 走 setProviderKey（会自动转成 DPAPI 密文），不在本机留口令副本。*/
export function unsealPortableKeys(json: any, passphrase: string): { recovered: number; wrongPass: boolean; none: boolean } {
  const list = (json?.providers || []).filter((p: any) => p?.apiKeyPortable)
  if (!list.length) return { recovered: 0, wrongPass: false, none: true }
  /* ★1003 批次4 4.34：**先全量解密、再统一应用** —— 原循环每解出一家就 setProviderKey()
   * （内部 mutate+persist 落盘），第 N 家失败时前 N-1 家已改盘 = 半应用状态（注释称
   * 「绝不半改」与实现相悖）。对齐 migratePlainKeysToEncrypted 的全有或全无铁律。 */
  const plains: Array<{ id: string; plain: string }> = []
  for (const p of list) {
    try {
      plains.push({ id: String(p.id), plain: decryptWithPassphrase(p.apiKeyPortable, passphrase) })
    } catch { /* 坏条目/口令错：先记账，本轮一家都不落地 */ }
  }
  if (plains.length < list.length) {
    // 全军覆没=口令不对；部分失败=坏条目 —— 都如实返回且**零应用**（绝不半改）
    return { recovered: 0, wrongPass: plains.length === 0, none: false }
  }
  for (const { id, plain } of plains) {
    setProviderKey(id, plain)
    const p = list.find((x: any) => String(x.id) === id)
    if (p) p.apiKeyPortable = ''   // 兑现完即清：口令副本不留在本机文件里
  }
  return { recovered: plains.length, wrongPass: false, none: false }
}

/* ★1004 显示层解密缓存 —— 键是**落盘密文本身**，不是 provider id。
 *  为什么按密文键：换 key 必然产生新密文 ⇒ 天然 cache miss，不需要像 plainKeyCache（按 id 键）
 *  那样靠 4.32 逐个写入口补失效 —— 从根上免掉"漏补一处就发旧 key"这类坑。 */
const revealedCache = new Map<string, { apiKey: string; locked: boolean }>()

/** ★1004：把当前所有供应商的 dpapi 密文**一次 PowerShell** 全解出来填缓存。
 *  病根见 secretbox.decryptDpapiBatch 头注：逐把解 = 每把一次 powershell.exe（本机实测 ~565ms），
 *  16 把 ≈ **9 秒**，且 execFileSync 同步阻塞事件循环 ⇒ 前端 3s ping 超时 ⇒ 界面按"未连接"渲染
 *  （用户 1004 实报"一打开 CPU 就 100%，供应商信息也没了"）。批量后 16 把 = 1 次 spawn ≈ 0.6s。 */
function warmRevealedCache(): void {
  const need: Array<{ sealed: string; name: string }> = []
  for (const p of state.providers) {
    const s = p.apiKey
    if (!s || revealedCache.has(s)) continue
    if (!s.startsWith(DPAPI_PREFIX)) continue      // 明文老数据 / pwd 口令副本走各自的单条路径
    need.push({ sealed: s, name: p.name || p.id })
  }
  if (!need.length) return
  const res = decryptDpapiBatch(need.map(n => n.sealed))
  need.forEach((n, i) => {
    const r = res[i]
    if (r && r.ok) {
      revealedCache.set(n.sealed, { apiKey: r.value || '', locked: false })
      const owner = state.providers.find(x => x.apiKey === n.sealed)
      if (owner) plainKeyCache.set(owner.id, r.value || '')   // 顺手喂热路径缓存，别让发送链路再解一次
    } else if (r?.transient) {
      /* ★1005 诚实性修复：**瞬时故障不许进永久缓存** ——
         原来无论什么原因失败都写 `{locked:true}` 且**没有任何失效路径** ⇒ 一次 PowerShell 抖动就
         让**全进程所有 key 显示"解不开"**（看起来跟"密钥全丢"一模一样），只有重启后端才能恢复。
         现在：只记日志、不缓存 ⇒ 下次 providers.list 自动重试。
         （真解不开的 key 会由 decryptDpapiBatch 以 transient:false 报回，只有那条才配得上"永久解不开"语义。） */
      console.warn(`[providers] 「${n.name}」的 API Key 本次批量解密失败（瞬时故障，未缓存，下次会重试）：${r.reason || '未知'}`)
    } else {
      revealedCache.set(n.sealed, { apiKey: '', locked: true })
      console.warn(`[providers] 「${n.name}」的 API Key 在本机解不开：${r?.reason || '未知'}（换机导入属预期）`)
    }
  })
}

/** ★ 0930（B 方案）：providers.list 回填前端时用 —— 返回**明文**，前端交互一点不变。
 *  locked=true 表示"落盘有密文但这台机器解不开"（典型：导入自另一台机器的包），
 *  此时 apiKey 给空但 hasKey 仍为 true（= 用户确实配过），并打日志说明原因——
 *  **绝不让它看起来像"从没配过 key"**（那会把真问题变成 401 谜案）。
 *  ★1004：走 warmRevealedCache 批量解 + 缓存 —— 原来这里逐把直接 decryptKey，
 *  每次 providers.list 都要起 16 个 powershell.exe（9 秒同步冻死后端）。 */
export function revealKey(providerId: string): { apiKey: string; locked: boolean } {
  const p = state.providers.find(x => x.id === providerId)
  if (!p || !p.apiKey) return { apiKey: '', locked: false }
  const hit = revealedCache.get(p.apiKey)
  if (hit) return hit
  if (String(p.apiKey).startsWith(DPAPI_PREFIX)) warmRevealedCache()
  const after = revealedCache.get(p.apiKey)
  if (after) return after
  const r = decryptKey(p.apiKey)
  if (!r.ok) {
    console.warn(`[providers] 「${p.name || p.id}」的 API Key 在本机解不开：${r.reason}`)
    return { apiKey: '', locked: true }
  }
  return { apiKey: r.key, locked: false }
}

export function setProviderKey(providerId: string, apiKey: string): void {
  const p = state.providers.find(x => x.id === providerId)
  if (p) {
    /* ★ 0930：落盘一律加密（DPAPI），前端交互不变——它照样能拿到明文去显示/直连，
       只是这块磁盘上不再有明文。keyHint 只留尾巴，界面上认是哪把 key 用。*/
    p.apiKey = sealedKey(apiKey)
    const r = decryptKey(apiKey)
    p.keyHint = r.ok ? keyHint(r.key) : ''
    /* ★ 0930 自测抓到的一个真 bug：这里若无条件写缓存，且 r.ok 为 false 时写入空串，
       热路径 plainKey() 就会命中空串缓存、**绕过解密、绕过那条明确报错** ——
       变成静默空 key 401 谜案（正是本模块立志要消灭的东西）。
       故：只有真解出明文才进缓存；解不开就**把缓存删掉**，逼下次走解密路径拿到真因。*/
    if (r.ok) plainKeyCache.set(providerId, r.key)
    else plainKeyCache.delete(providerId)
    persist()
  }
}

/** 0917：写入供应商头像（data URL 或静态路径）。传空串 = 恢复默认自带图标 */
export function setProviderLogo(providerId: string, logo: string): void {
  const p = state.providers.find(x => x.id === providerId)
  if (p) {
    p.logo = String(logo || '')
    persist()
  }
}

/** 设置当前激活供应商 + 模型（会话无关的全局设置） */
export function setActiveModel(providerId: string, modelId: string, effort?: string | null): void {
  const p = state.providers.find(x => x.id === providerId)
  if (!p) return
  state.providerActive = providerId
  if (modelId && p.models.some(x => x.id === modelId)) {
    state.activeModelId = modelId
  } else if (modelId) {
    // 模型不在表里（自定义/未拉取）：也接受，调用时原样传
    state.activeModelId = modelId
  }
  // 推理强度（undefined = 不改；null/'' = 清除）
  if (effort !== undefined) {
    state.activeEffort = effort ? String(effort).trim() || undefined : undefined
  }
  persist()
}

/** 全局推理强度（非对话场景统一用；空 = 未指定） */
export function activeEffort(): string | undefined {
  return state.activeEffort
}

/** 单独设置全局推理强度（null 清除） */
export function setActiveEffort(effort: string | null): void {
  state.activeEffort = effort ? String(effort).trim() || undefined : undefined
  persist()
}

export function setProviderBase(providerId: string, base: string): void {
  const p = state.providers.find(x => x.id === providerId)
  if (p) {
    p.base = base.trim().replace(/\/+$/, '')
    persist()
  }
}

/** D2 供应商级代理：设/清该供应商的 proxyUrl（空=直连） */
export function setProviderProxy(providerId: string, proxyUrl: string): void {
  const p = state.providers.find(x => x.id === providerId)
  if (p) {
    let v = (proxyUrl || '').trim()
    // 0908四：自动补 http:// 前缀——消费侧闸门 /^https?:\/\// 不吃裸 127.0.0.1:7897，
    // 旧行为=用户填了代理但被静默忽略（"代理没用"的根因之一）
    if (v && !/^[a-zA-Z][\w+.-]*:\/\//.test(v)) v = 'http://' + v
    if (v) p.proxyUrl = v
    else delete (p as any).proxyUrl
    persist()
  }
}

export function toggleProviderEnabled(providerId: string, enabled: boolean): void {
  const p = state.providers.find(x => x.id === providerId)
  if (p) {
    p.enabled = enabled
    // 0906 体检修复：禁用当前激活供应商后 activeModel 悬挂（照旧调用必失败）→ 自愈切到可用供应商
    if (providerId === state.providerActive && enabled === false) {
      const first = state.providers.find(x => x.enabled && x.id !== providerId)
      if (first) {
        state.providerActive = first.id
        state.activeModelId = first.models.find(x => x.enabled !== false)?.id || first.models[0]?.id || ''
        // 0913：自愈切换必须留痕（此前完全静默 —— 用户报「我切了 agnes 怎么又回到 longcat」的排查盲点）
        console.warn(`[providers] 禁用激活供应商 ${providerId} → 自愈切换全局模型到 ${first.id} / ${state.activeModelId}`)
      }
    }
    persist()
  }
}

/* ★ 0930：enabled 可选 —— 调用方显式给就照办（前端"确保后端有这家"时会带原状态，
   避免把还没填模型的供应商自动启用、被自愈逻辑选中后调用必失败）；不给才沿用旧默认。*/
export function addProvider(provider: { id: string; name: string; base: string; protocol?: ProviderConfig['protocol']; enabled?: boolean }): void {
  invalidatePlainKeyCache()   // ★1003 4.32：同 id 重建/自动建商，防旧缓存顶新 key
  const id = provider.id.trim()
  if (!id || state.providers.some(p => p.id === id)) return
  state.providers.push({
    id,
    name: provider.name.trim() || id,
    base: provider.base.trim().replace(/\/+$/, ''),
    enabled: typeof provider.enabled === 'boolean' ? provider.enabled : state.providers.filter(p => p.enabled).length < 12,
    models: [],
    ...(provider.protocol ? { protocol: provider.protocol } : {}),
  })
  persist()
}

export function removeProvider(providerId: string): void {
  invalidatePlainKeyCache()   // ★1003 4.32：删除后同 id 重建会命中旧缓存，整表作废
  state.providers = state.providers.filter(p => p.id !== providerId)
  if (state.providerActive === providerId) {
    state.providerActive = state.providers[0]?.id || ''
  }
  // 0906 体检修复：删除供应商后 activeModelId 仍指向旧供应商的模型 → 后续调用 model 错误
  const ap = state.providers.find(x => x.id === state.providerActive)
  if (ap && !ap.models.some(x => x.id === state.activeModelId)) {
    state.activeModelId = ap.models.find(x => x.enabled !== false)?.id || ap.models[0]?.id || ''
  }
  persist()
}

export function setModels(providerId: string, models: ProviderModel[]): void {
  invalidatePlainKeyCache()   // ★1003 4.32：自动建商路径可携带 key 变更，作废防脱钩
  let p = state.providers.find(x => x.id === providerId)
  // 供应商不在本地表（如前端选中的 moonshot/kimi）时自动创建，否则后续 setActiveModel 找不到供应商而静默失败
  if (!p) {
    p = { id: providerId, name: providerId, base: '', enabled: true, models: [], logo: '' }
    state.providers.push(p)
  }
  if (models.length > 0) {
    // 保留已有模型的 enabled 状态
    p.models = models.map(m => {
      const old = p!.models.find(x => x.id === m.id)
      return { ...m, enabled: old?.enabled ?? m.enabled ?? true }
    })
  }
  persist()
}

/** ★ 0930（实测反馈「报错别只给人话、把 40 几带出来」）：HTTP 状态码 → 人话。
 *  只覆盖实测真会遇到的常见码；未知码原样带数字，不编。 */
function httpStatusHint(status: number): string {
  const s = Number(status) || 0
  switch (s) {
    case 400: return '400 · 请求被拒（参数非法 / 额度不足 / 套餐不含该模型）'
    case 401: return '401 · 鉴权失败（API Key 无效、已过期，或没登录）'
    case 402: return '402 · 额度/余额不足（该充值或换 key 了）'
    case 403: return '403 · 无权限（套餐不含该模型，或 key 没这个模型的权限）'
    case 404: return '404 · 地址或模型名不对（Base URL 拼错，或该模型已下架）'
    case 408: return '408 · 请求超时（供应商侧等太久）'
    case 413: return '413 · 内容太大（输入超过模型上限）'
    case 422: return '422 · 参数格式不对（接口口径不匹配）'
    case 429: return '429 · 限流（请求太密，等一会儿或降并发）'
    case 500: return '500 · 供应商内部故障'
    case 502: return '502 · 网关错误（供应商上游挂了）'
    case 503: return '503 · 服务不可用（供应商维护中）'
    case 504: return '504 · 网关超时（供应商上游没及时回）'
    default: return s > 0 ? `${s} · 供应商拒绝（暂无对应解释）` : '供应商拒绝（未带状态码）'
  }
}

/** ★ 0930：失败时把**供应商自己说的原因**捞出来透传 —— 它比 NIS 的任何猜测都准。
 *  实测（tokenrhythm.studio，key 失效时）：`{"code":"UNAUTHORIZED","message":"未认证或登录已过期"}`
 *  「未认证或登录已过期」这句原话，正是当时 NIS 报 CORS、把人带偏的真正原因。 */
async function readErrSnippet(res: any): Promise<string> {
  try {
    const raw = await res.text()
    if (!raw) return ''
    let msg = ''
    try {
      const j = JSON.parse(raw)
      msg = String(j?.error?.message || j?.message || j?.error || j?.msg || '')
    } catch { msg = raw }
    msg = msg.replace(/\s+/g, ' ').trim()
    return msg ? `｜供应商原话：${msg.slice(0, 200)}` : ''
  } catch { return '' }
}

/** 代理拉取供应商模型列表（GET /v1/models）；返回 models(id 数组，兼容旧调用方) + caps(建议能力/来源) */
export async function fetchModelsRemote(providerId: string): Promise<{ ok: boolean; models: string[]; caps: SuggestedCaps[]; msg: string }> {
  const p = state.providers.find(x => x.id === providerId)
  if (!p) return { ok: false, models: [], caps: [], msg: '供应商不存在' }
  if (!p.apiKey) return { ok: false, models: [], caps: [], msg: '未填 API Key' }
  const key = plainKey(p)                                                    // ★ 0930 加密后取明文（解不开会抛明确错，不会静默发空 key）
  const base = (p.base || '').replace(/\/+$/, '')
  const proto = p.protocol || 'openai-completions'
  try {
    let ids: string[] = []
    /** 0923：网关亲口给的上限（context_length / max_completion_tokens 等），有就优先用 */
    let gw: Record<string, { context?: number; maxOutput?: number }> = {}
    if (proto === 'anthropic-messages') {
      // Anthropic 原生 /v1/models：x-api-key + anthropic-version；返回 {data:[{id,display_name}]}
      // 0910 反馈12：base 已带版本段（https://api.anthropic.com/v1，用户照官方文档填的常见形态）时
      // 不能再拼 /v1（旧实现拼出 /v1/v1/models 必 404 → 前端静默降级成"本地表 + OpenRouter"列表，
      // 用户看到"anthropic 协议也能取到模型"的假象）。与 testConnection 同一守卫。
      const root = /\/v\d/.test(base) ? base : `${base}/v1`
      const res = await proxiedFetch(p.proxyUrl, `${root}/models?limit=100`, {
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      })
      if (!res.ok) return { ok: false, models: [], caps: [], msg: `${httpStatusHint(res.status)}（获取模型端点：${root}/models）${await readErrSnippet(res)}` }
      const j = await res.json()
      ids = (j.data || []).map((m: any) => String(m.id || '')).filter(Boolean)
      gw = readGatewayLimits(j.data || [])
    } else if (proto === 'google-generative-ai') {
      // Gemini 原生 list models：x-goog-api-key；返回 {models:[{name:'models/xxx'}]}
      // base 约定含版本段（如 https://generativelanguage.googleapis.com/v1beta），与 pi-ai 适配器一致
      const root = /\/v\d/.test(base) ? base : `${base}/v1beta`
      const res = await proxiedFetch(p.proxyUrl, `${root}/models?pageSize=200`, { headers: { 'x-goog-api-key': key } })
      if (!res.ok) return { ok: false, models: [], caps: [], msg: `${httpStatusHint(res.status)}（获取模型端点：${root}/models）${await readErrSnippet(res)}` }
      const j = await res.json()
      ids = (j.models || []).map((m: any) => String(m.name || '').replace(/^models\//, '')).filter(Boolean)
      gw = readGatewayLimits(j.models || [])
    } else {
      // base 已是「含版本前缀」的 API 根（如 /v1、/v4），直接拼 /models（不再二次拼 /v1）
      const modelsUrl = `${base}/models`
      const res = await proxiedFetch(p.proxyUrl, modelsUrl, { headers: { Authorization: `Bearer ${key}` } })
      if (!res.ok) return { ok: false, models: [], caps: [], msg: `${httpStatusHint(res.status)}（获取模型端点：${modelsUrl}）${await readErrSnippet(res)}` }
      const j = await res.json()
      ids = (j.data || []).map((m: any) => String(m.id || '')).filter(Boolean)
      gw = readGatewayLimits(j.data || [])
    }
    // 0910 反馈12：后端也按归一化键去重（供应商接口偶发同 id 混大小写/重复条目），
    // 并给出诚实的条数说明（openai 分支无分页参数=只拿第一页；anthropic 带 ?limit=100）
    const uniq: string[] = []
    const seenIds = new Set<string>()
    for (const id of ids) {
      const k = id.toLowerCase().replace(/[^a-z0-9]/g, '')
      if (!k || seenIds.has(k)) continue
      seenIds.add(k)
      uniq.push(id)
    }
    ids = uniq
    // 0907：实时拉 models.dev 快照（失败静默降级到名字推断），再按来源优先级给每个候选模型出建议能力
    try { await lookupDevCapsBatch(ids, providerId) } catch { /* 无网络/超时→下面 suggestCaps 自动走 inferred */ }
    const caps = suggestCapsForIds(providerId, ids, gw)
    return { ok: true, models: ids, caps, msg: `拉取到 ${ids.length} 个模型` }
  } catch (e: any) {
    return { ok: false, models: [], caps: [], msg: `无法连接：${e?.message || e}` }
  }
}

/** 代理测试连接（发 1-token 最小请求，按协议选端点） */
export async function testConnectionRemote(providerId: string, modelId?: string): Promise<{ ok: boolean; msg: string }> {
  const p = state.providers.find(x => x.id === providerId)
  if (!p) return { ok: false, msg: '供应商不存在' }
  if (!p.apiKey) return { ok: false, msg: '该供应商未填写 API Key' }
  const key = plainKey(p)                                                    // ★ 0930 同 fetchModelsRemote：解不开就抛明确错
  const model = modelId || activeModelId()
  const base = (p.base || '').replace(/\/+$/, '')
  const proto = p.protocol || 'openai-completions'

  const build = (): { url: string; headers: Record<string, string>; body: string } => {
    if (proto === 'anthropic-messages') {
      // Anthropic 原生：/v1/messages + x-api-key + anthropic-version
      return {
        url: /\/v\d/.test(base) ? `${base}/messages` : `${base}/v1/messages`,
        headers: { 'content-type': 'application/json', 'x-api-key': key!, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }),
      }
    }
    if (proto === 'google-generative-ai') {
      // Gemini 原生：{base}/models/{model}:generateContent + x-goog-api-key
      const root = /\/v\d/.test(base) ? base : `${base}/v1beta`
      return {
        url: `${root}/models/${encodeURIComponent(model)}:generateContent`,
        headers: { 'content-type': 'application/json', 'x-goog-api-key': key! },
        body: JSON.stringify({ contents: [{ parts: [{ text: 'ping' }] }] }),
      }
    }
    // base 已是「含版本前缀」的 API 根（如 /v1、/v4），直接拼 /chat/completions（不再二次拼 /v1）
    return {
      url: `${base}/chat/completions`,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }),
    }
  }

  const attempt = async (): Promise<{ ok: boolean; msg: string; aborted?: boolean }> => {
    const { url, headers, body } = build()
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 10000)
    try {
      const t0 = Date.now()
      const res = await proxiedFetch(p.proxyUrl, url, { method: 'POST', headers, body, signal: ctrl.signal })
      clearTimeout(t)
      const ms = Date.now() - t0
      if (res.ok) return { ok: true, msg: `连通（${model} · ${ms}ms）` }
      if (res.status === 401 || res.status === 403) {
        /* ★ 0925e：透传服务端真实原因 —— FreeTierError"仅限 OpenCode 客户端内"/
         * RegionError"地区不可用"/key 无效是三种完全不同的病，原来一刀切报
         * "认证失败（检查 API Key）"把用户带偏（实测踩坑）。 */
        const txt = await res.text().catch(() => '')
        let detail = ''
        try { detail = String(JSON.parse(txt)?.error?.message || JSON.parse(txt)?.message || '') } catch { detail = txt.slice(0, 120) }
        return { ok: false, msg: detail ? `${res.status}：${detail.replace(/\s+/g, ' ').slice(0, 100)}` : '认证失败（检查 API Key）' }
      }
      // 顺手带一眼错误体前 120 字（400 时多半是 model 名/协议不匹配，能直接看出）
      if (res.status === 400 || res.status === 404) {
        const txt = await res.text().catch(() => '')
        const brief = txt.replace(/\s+/g, ' ').slice(0, 120)
        /* ★0927 N3：**模型名错要一眼看出来**（设计口径：用户会点⚡测试连通性，就在这儿报模型名错）。
           识别"模型不存在/不支持/未授权访问该模型"一类服务端文案 → 中文点名 + 给下一步动作；
           其它 400（协议不匹配 / 参数非法）保留原文摘要（不吞错、不编造）。 */
        const modelIssue = /model[^.]{0,40}(not found|not exist|does not exist|unsupported|invalid|unknown|no such)|\bmodel_not_found\b|不存在的模型|模型不存在|未找到模型|invalid model|model is required|not allowed to access model/i.test(txt)
          || (res.status === 404 && /model/i.test(txt + url))
        if (modelIssue) {
          return { ok: false, msg: `模型名不被接受「${model}」：${brief.slice(0, 80)} —— 点「获取模型」看该供应商的可用清单，或改正名字后再测` }
        }
        return { ok: false, msg: `返回 ${res.status}：${brief}` }
      }
      return { ok: false, msg: `返回 ${res.status}` }
    } catch (e: any) {
      clearTimeout(t)
      const am = String(e?.message || e)
      return { ok: false, msg: `无法连接：${am}`, aborted: /aborted|timeout/i.test(am) }
    }
  }

  const r1 = await attempt()
  // 0913：瞬时 abort/超时自动重试一次——网关抽风常见（曾出现"聊天正常但测试超时"，重试可救回）
  if (!r1.ok && r1.aborted) {
    const r2 = await attempt()
    if (r2.ok) return { ok: true, msg: `${r2.msg} · 重试成功` }
    return r2
  }
  return r1
}

/* ── ★ 0925e（需求要求"打开 NIS 自动获取 zen 的 free 模型"）────────────────────────
 * 启动后自动同步 OpenCode Zen 公共档的免费模型：
 *   /models 筛 -free 后缀 → 逐个 1-token 探活 → **只把活着的**合入模型表（enabled）。
 * 已入库但探活挂的置 enabled:false —— 免费档按周轮换、热门款挂"仅限 OpenCode 客户端"闸，
 * 死的留着只会让用户"测一个挂一个"（实测踩坑）。
 * 结果 6h 冷却缓存（.zen-free-sync.json），不反复打（免费额度按次计）。全程静默失败不挡启动。 */
const ZEN_FREE_PROVIDER_ID = 'opencode-zen'
function zenFreeSyncFile(): string { return path.join(DATA_ROOT, '.zen-free-sync.json') }

export async function autoSyncZenFreeModels(): Promise<void> {
  try {
    const p = state.providers.find(x => x.id === ZEN_FREE_PROVIDER_ID)
    if (!p || !p.apiKey) return
    try {
      const c = JSON.parse(fs.readFileSync(zenFreeSyncFile(), 'utf8'))
      if (Date.now() - (c.at || 0) < 6 * 3600 * 1000) return
    } catch { /* 无缓存=首次 */ }
    const r = await fetchModelsRemote(ZEN_FREE_PROVIDER_ID)
    if (!r.ok) { console.log('[providers] zen-free 同步：拉取失败 ' + r.msg); return }
    const freeIds = r.models.filter(id => /-free$/i.test(id))
    if (!freeIds.length) return
    const capsMap = new Map<string, SuggestedCaps>(r.caps.map(c => [c.id, c]))
    const alive: string[] = []
    for (const id of freeIds) {
      const t = await testConnectionRemote(ZEN_FREE_PROVIDER_ID, id)
      if (t.ok) alive.push(id)
      else console.log(`[providers] zen-free 探活未通过 ${id}：${t.msg}`)
    }
    const aliveSet = new Set(alive)
    const freeSet = new Set(freeIds)
    for (const m of p.models) {
      if (freeSet.has(m.id)) m.enabled = aliveSet.has(m.id)
    }
    for (const id of alive) {
      if (p.models.some(m => m.id === id)) continue
      const c = capsMap.get(id)
      p.models.push({
        id, name: id, enabled: true,
        inputPrice: 0, outputPrice: 0,
        maxContext: c?.context || 0,
        capabilities: ['text', ...(c?.reasoning ? ['reasoning'] : []), ...(c?.vision ? ['image'] : [])],
        inputModalities: c?.input?.length ? c.input : ['text'],
        outputModalities: c?.output?.length ? c.output : ['text'],
      })
    }
    if (alive.length) persist()
    try { fs.writeFileSync(zenFreeSyncFile(), JSON.stringify({ at: Date.now(), alive }, null, 2)) } catch { /* ignore */ }
    console.log(`[providers] zen-free 自动同步完成：可用 ${alive.length}/${freeIds.length}${alive.length ? '（' + alive.join(', ') + '）' : ''}`)
  } catch (e: any) {
    console.warn('[providers] zen-free 自动同步失败：', String(e?.message || e).slice(0, 200))
  }
}

/* ★ 0930 密钥加密：进程启动时自动把老数据里的**明文 key** 加密（幂等）。
 *  放在模块末尾 = server.ts 一 import 就跑 —— 好处是**不需要在启动流程里插桩**，
 *  也就不会出现"忘了调"导致明文一直躺在盘上的漏（这类漏最难发现）。
 *  已全是密文时函数直接返回，不产生任何 IO / 子进程；失败也只是保持原样，绝不阻断启动。*/
try {
  migratePlainKeysToEncrypted()
} catch (e: any) {
  console.error('[providers] 启动时密钥迁移异常（已忽略，providers.json 未改动）：', e)
}
