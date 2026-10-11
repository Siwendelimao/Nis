/**
 * 通道配置存储（0912 接入批）
 *
 * 通道 = NIS 对外的消息入口（微信 / QQ / 远程访问）。本模块只管**配置**，
 * 不管连接实现（连接在各自通道模块里，见 docs/通道接入设计-前端与上下文-0912.md）。
 *
 * 落盘：backend/data/channels.json（原子写；通道数量固定为 3，单文件足够）
 * 结构：{ version: 1, channels: { wechat: ChannelConfig, qq: ..., remote: ... } }
 *
 * 为什么每个通道要独立的 provider/model：
 *   通道场景与桌面场景的诉求不同 —— 微信/QQ 常是「快问快答」，用便宜快模型；
 *   桌面复杂任务用强模型。且通道会创建会话，创建时按此配置定型（写进 session.model）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { DATA_ROOT } from './paths.ts'
import { loadJsonOrBackup, writeJsonAtomic } from './jsonStore.ts'

const CHANNELS_FILE = path.join(DATA_ROOT, 'channels.json')

export type ChannelId = 'wechat' | 'qq' | 'remote'

/** 通道下的一个机器人账号（QQ 支持多机器人；微信多账号也可复用） */
export interface ChannelBot {
  /** 内部 id（增删改的稳定标识） */
  id: string
  /** 平台侧账号标识：QQ=AppID / 微信=ilink_bot_id */
  accountId: string
  /** 凭据（QQ=AppSecret / 微信=bot_token）。敏感，前端回传时脱敏显示 */
  secret: string
  /** 昵称（展示用） */
  nickname: string
  /** 是否启用（可临时停用某个机器人，不影响其他） */
  enabled: boolean
  createdAt: number

  /* ── 人格与称呼覆盖（0912 七批）──
   * 每个机器人（微信只有一台 = 该通道一份）可独立设置。
   * `personaMode` 是总开关：'global'（默认）= 全部跟随「设置」；'custom' = 启用下面的三项覆盖。
   * 生效方式：buildDynamicSystem 注入系统提示词时按 会话的 origin + originBot 查这里覆盖。
   */
  /** 总开关：global=跟随系统设置 / custom=使用下面的自定义项 */
  personaMode?: 'global' | 'custom'
  /** AI 自己的名字（覆盖「设置→人格」的 nisName） */
  personaName?: string
  /** 对用户的称呼（覆盖「设置→通用」的 userName） */
  addressName?: string
  /** 说话风格提示词（覆盖「设置→人格」的 prompt） */
  personaPrompt?: string

  /* ── 该机器人的独立运行配置（0912 十批）──
   * 留空 = 继承通道级配置（通道级再留空 = 跟随全局）。
   * 为什么下沉到机器人级：QQ 支持多机器人，用户希望每台能用自己的模型/预设/权限
   * （例：一台用"牢大"预设+完全访问，另一台用默认预设+自审计）。
   */
  providerId?: string
  modelId?: string
  effort?: string
  presetId?: string
  permissionMode?: 'self_audit' | 'full_access' | 'confirm'

  /* ── 群聊「插嘴」开关（0912 二十四批；0912 晚反馈批扩展）──
   * 背景：开了「获取群内全部消息」后，群里的闲聊机器人全都看得到。
   * 以前一律只记流水；用户觉得偶尔搭一句挺好玩的，要一个开关。
   *
   * 默认 **关**（安静，符合原本预期）。开启后**全部条件满足**才插嘴
   * （见 server 的 maybeInterjectInGroup）：
   *   ① 这条消息 @ 了机器人 → 不算插嘴，走正常回复（本来就会回）；
   *   ② 内容门槛：`interjectScope='question'` 时消息得**像提问**；
   *      `'keyword'`（0914 新增）时**只有**命中 `interjectKeywords` 才接，平时一律不出声；
   *      ⚠️ 任何 scope 下命中 `interjectKeywords` 任一词 → **直接越过这条门槛**（用户点名要它出来说话）；
   *   ③ 冷却：距上次机器人发言 ≥ `interjectCooldownSec` 秒（默认 480 = 8 分钟，0 = 不设冷却）；
   *   ④ 额度：该群滑动 1 小时内插嘴次数 < `interjectPerHour`（默认 3，0 = 不限次）。
   *
   * 【0912 修正】此前注释里写的 `interjectIdleMs` / `interjectCooldownMs` / `interjectMaxPerHour`
   * 三个字段**从来不存在**（实现是硬编码 8 分钟 + interjectPerHour），注释与实现不符，一并纠正。
   */
  /** 群聊插嘴：是否开启（默认 false） */
  interject?: boolean
  /** 插嘴内容门槛：'question'（只接提问，默认）/ 'any'（任何消息都可能接）/ 'keyword'（0914：仅插嘴词触发，没喊词绝不出声） */
  interjectScope?: 'question' | 'any' | 'keyword'
  /**
   * 插嘴额度（每小时最多几次，默认 3；0 = 不限制但仍有冷却期）。
   * 用户可在通道设置里调。
   */
  interjectPerHour?: number
  /**
   * 插嘴词（0912 反馈）：命中这些词的群消息**跳过「只接提问」门槛**直接过闸 ——
   * 群里有人喊「牢大」「还活着吗」这类词时，即使不算提问也会接一句。
   * 最多 20 个，每个 ≤ 20 字（写入时夹取）。
   */
  interjectKeywords?: string[]
  /**
   * 两条插嘴之间的最短间隔（秒，默认 480 = 8 分钟）。
   * 0 = 不设冷却（只受 interjectPerHour 约束）——给「想让它活跃点」的场景用。
   */
  interjectCooldownSec?: number
}

export interface ChannelConfig {
  /** 是否启用（是否允许该通道创建会话） */
  enabled: boolean
  /** 该通道新建会话使用的供应商 id（空=跟随全局） */
  providerId: string
  /** 该通道新建会话使用的模型 id（空=跟随全局） */
  modelId: string
  /** 思考强度（空=跟随全局） */
  effort: string
  /** 该通道新建会话使用的 Agent 预设 id（空=跟随全局默认） */
  presetId: string
  /**
   * 该通道新建会话的权限模式（0912 二批修复）。
   *
   * ⚠️ 这是通道场景的关键设置：默认 `self_audit`（放行但留痕）而不是 `confirm`。
   * 原因：`confirm` 会在 PC 端弹审批卡等用户点，但用户在 IM 里**看不到这张卡** →
   * agent 一直等（3 分钟超时才失败）→ 表现为「卡在权限卡、回复永远不来」
   * （用户实测踩到：QQ 里发消息 → 乱调工具 → 弹权限卡 → 卡死）。
   *
   * 通道场景的可选值：
   *   self_audit  放行但留痕（默认，推荐 —— 通道本来就是用户对自己电脑下指令）
   *   full_access 完全放行
   *   confirm     弹审批卡（⚠️ 需配合 IM 审批回推才有意义，见 server.ts 的审批桥）
   */
  permissionMode: 'self_audit' | 'full_access' | 'confirm'
  /** 通道账号标识（微信=ilink_bot_id / QQ=AppID） */
  accountId: string
  /** 账号昵称（展示用） */
  nickname: string
  /** 机器人列表（QQ 多机器人；微信也可多账号） */
  bots: ChannelBot[]
  /**
   * ★1014b：QQ 私聊「正文流式」（官方 stream_messages）开关。
   * **默认关**（undefined/false = 关）—— 新增通路先关着，真机实测通过再常开。
   * 只对单聊（c2c）生效：群聊/频道官方既无流式、也无消息编辑能力。
   * 开法：设置→通道 或 RPC `channel.config.set {channel:'qq', stream:true}`（改完即生效，无需重启）。
   */
  stream?: boolean
  /**
   * ★1014e：QQ 回复用 **Markdown**（`msg_type:2`）开关。
   * 默认**开**（只有显式 `false` 才关）—— 官方 2026-04-23 起对全部机器人开放单聊/群聊自定义
   * markdown；发送失败会自动回纯文本重发（见 server.ts deliverToChannel），所以默认开更划算。
   * 关掉它 = 回到纯文本（模型写的 `**加粗**`、`# 标题` 会原样显示）。
   */
  markdown?: boolean
  /* ★1011：远程访问的**访问令牌**（仅 remote 通道使用）。
     背景：原来只有环境变量 NIS_TOKEN 一条路，默认空 ⇒ 校验退化成"同源放行"，
     同网段任何人打开 http://<局域网IP>:8766 就能完整操作 NIS（读写文件、跑命令）。
     现在：开关打开时后端自动生成并持久化到这里，链接与二维码自动带上 ?token=。
     ⚠️ 敏感字段：绝不能出现在任何回给前端的 RPC 结果里（listChannels/getChannelRedacted 已脱敏）。 */
  remoteToken?: string
  updatedAt: number
}

interface StoreShape { version: number; channels: Record<string, ChannelConfig> }

const CHANNEL_IDS: ChannelId[] = ['wechat', 'qq', 'remote']

/** 默认配置：未配置过的通道一律「未启用 + 跟随全局模型 + 自审计权限」 */
function defaultConfig(): ChannelConfig {
  return {
    enabled: false, providerId: '', modelId: '', effort: '', presetId: '',
    permissionMode: 'self_audit',
    accountId: '', nickname: '', bots: [], updatedAt: 0,
  }
}

function emptyStore(): StoreShape {
  const channels: Record<string, ChannelConfig> = {}
  for (const id of CHANNEL_IDS) channels[id] = defaultConfig()
  return { version: 1, channels }
}

let cache: StoreShape | null = null
/* ★ 0927 第 0 批：channels.json 损坏降级标志。
   注意：fallback 是**有内容的默认配置**（全通道 enabled:false）——degraded 期间任何写回都会把
   用户的通道配置（bots/密钥）覆盖成默认值，因此选择**一律拒绝写盘**（暴露问题 > 静默丢数据）。 */
let channelsDegraded = false

function load(): StoreShape {
  if (cache) return cache
  /* ★ 0927 第 0 批：共享 jsonStore —— ENOENT 才回落默认配置；内容损坏先备份 .corrupt-* 再回落并标记
     degraded。（旧逻辑：任何失败 console.warn 后回退默认 → 下一次 updateChannel 就把默认值
     rename 覆盖磁盘 → 用户通道配置被默认值替换。体检 P1，家族①病根。） */
  const r = loadJsonOrBackup<any>(CHANNELS_FILE, () => null)
  const raw = r.data
  if (r.degraded) channelsDegraded = true
  if (raw && typeof raw === 'object' && raw.channels && typeof raw.channels === 'object') {
    const base = emptyStore()
    // 逐字段合并：新增通道/新增字段时旧文件不炸（向后兼容）
    for (const id of CHANNEL_IDS) {
      const saved = raw.channels[id]
      if (saved && typeof saved === 'object') {
        base.channels[id] = { ...base.channels[id], ...saved }
      }
    }
    cache = base
    return cache
  }
  /* schema 级损坏（JSON 合法但结构不对）同样按降级处理 */
  if (raw != null) {
    channelsDegraded = true
    console.error('[channelsStore] 文件结构异常（channels 不是对象），按降级处理：', CHANNELS_FILE)
  }
  cache = emptyStore()
  return cache
}

function persist(): void {
  const data = load()
  /* ★ 0927 第 0 批：原子写（tmp 带 pid+随机防并发互截）+ degraded 一律拒绝回写。 */
  if (channelsDegraded) {
    console.error('[channelsStore] 拒绝写盘：channels.json 已损坏降级——写回会用默认配置覆盖' +
      '用户通道数据。请从盘上 .corrupt-* 备份恢复，或人工核对后删除坏档重启。')
    return
  }
  writeJsonAtomic(CHANNELS_FILE, data)
}

/** ★1011：**丢掉内存 cache，下次读取重新从磁盘加载**。
 *  为什么需要：导入数据包时 channels.json 是被**整份替换**的，而本模块用内存 cache
 *  —— 不丢 cache 就会出现与 settings 分片同款的老坑（16292 那条注释）：
 *  「显示已导入、通道配置却一个都没变」，用户以为导入没生效。
 *  ⚠️ 生效即换配置：远程访问令牌会变成包里那把 ⇒ 正在用手机/其它设备连的，要用新令牌重连。
 *  ⚠️ 复位 degraded：坏档标记是针对"上次读到的那份文件"的，换了文件必须重新判定，
 *     否则新导入的合法配置会被"拒绝写盘"一直卡着。 */
export function invalidateChannelsCache(): void {
  cache = null
  channelsDegraded = false
}

/** 全部通道配置（返回副本；bots 的 secret、remote 的访问令牌一律脱敏，防前端拿到明文） */
export function listChannels(): Record<string, any> {
  const data = load()
  const out: Record<string, any> = {}
  for (const id of CHANNEL_IDS) {
    const c = data.channels[id]
    const { remoteToken, ...rest } = c as any   // ★1011：访问令牌绝不外发
    out[id] = { ...rest, bots: redactBots(c.bots) }
  }
  return out
}

/** 单个通道配置（bots 的 secret 脱敏） */
export function getChannel(id: string): ChannelConfig | null {
  const data = load()
  return data.channels[id] ? { ...data.channels[id] } : null
}

/** 单个通道配置的脱敏视图（供 RPC 返回前端）；remote 的访问令牌同样不外发 */
export function getChannelRedacted(id: string): any | null {
  const c = getChannel(id)
  if (!c) return null
  const { remoteToken, ...rest } = c as any   // ★1011：访问令牌绝不外发
  return { ...rest, bots: redactBots(c.bots) }
}

/** 更新通道配置（局部字段；只接受白名单键，防脏字段写盘） */
export function updateChannel(id: string, patch: Partial<ChannelConfig>): ChannelConfig | null {
  const data = load()
  if (!data.channels[id]) return null
  const cur = data.channels[id]
  const next: ChannelConfig = { ...cur }
  if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled
  // ★1014b：QQ 私聊流式开关（默认关；见 ChannelConfig.stream 注释）
  if (typeof patch.stream === 'boolean') next.stream = patch.stream
  // ★1014e：QQ Markdown 回复开关（未设=开，只有显式 false 才关；见 ChannelConfig.markdown 注释）
  if (typeof patch.markdown === 'boolean') next.markdown = patch.markdown
  // 权限模式白名单校验（防脏值写盘）
  if (typeof patch.permissionMode === 'string'
      && ['self_audit', 'full_access', 'confirm'].includes(patch.permissionMode)) {
    next.permissionMode = patch.permissionMode as ChannelConfig['permissionMode']
  }
  for (const k of ['providerId', 'modelId', 'effort', 'presetId', 'accountId', 'nickname'] as const) {
    if (typeof patch[k] === 'string') next[k] = (patch[k] as string).trim()
  }
  next.updatedAt = Date.now()
  data.channels[id] = next
  persist()
  return { ...next }
}

/** ★1011：写入远程访问令牌（系统生成，不走 updateChannel 白名单 —— 令牌不是"用户可改配置"，
 *  前端任何 RPC 都不该能设置它，只能是我们生成/清空）。传空串 = 清除（回到环境变量或未启用）。 */
export function setRemoteToken(token: string): ChannelConfig | null {
  const data = load()
  const cfg = data.channels.remote
  if (!cfg) return null
  const t = String(token || '').trim()
  cfg.remoteToken = t || undefined
  cfg.updatedAt = Date.now()
  persist()
  return { ...cfg }
}

/* ── 机器人（账号）增删改 —— QQ 多机器人 / 微信多账号 ────────────── */

/** 新增机器人；accountId 在同一通道内去重（重复则更新昵称/密钥） */
export function addBot(id: string, bot: { accountId: string; secret?: string; nickname?: string }): ChannelConfig | null {
  const data = load()
  const cfg = data.channels[id]
  if (!cfg) return null
  const accountId = String(bot.accountId || '').trim()
  if (!accountId) return null
  const exist = cfg.bots.find(b => b.accountId === accountId)
  if (exist) {
    if (bot.secret !== undefined) exist.secret = String(bot.secret || '').trim()
    if (bot.nickname !== undefined) exist.nickname = String(bot.nickname || '').trim()
  } else {
    cfg.bots.push({
      id: `bot_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      accountId,
      secret: String(bot.secret || '').trim(),
      nickname: String(bot.nickname || '').trim(),
      enabled: true,
      createdAt: Date.now(),
    })
  }
  cfg.updatedAt = Date.now()
  persist()
  return { ...cfg }
}

/** 更新机器人（按内部 id 或 accountId 定位） */
export function updateBot(id: string, key: string, patch: Partial<ChannelBot>): ChannelConfig | null {
  const data = load()
  const cfg = data.channels[id]
  if (!cfg) return null
  const bot = cfg.bots.find(b => b.id === key || b.accountId === key)
  if (!bot) return null
  if (typeof patch.secret === 'string') bot.secret = patch.secret.trim()
  if (typeof patch.nickname === 'string') bot.nickname = patch.nickname.trim()
  if (typeof patch.enabled === 'boolean') bot.enabled = patch.enabled
  // 人格与称呼覆盖：空串 = 清除该自定义项
  if (typeof patch.personaName === 'string') bot.personaName = patch.personaName.trim() || undefined
  if (typeof patch.addressName === 'string') bot.addressName = patch.addressName.trim() || undefined
  if (typeof patch.personaPrompt === 'string') bot.personaPrompt = patch.personaPrompt.trim() || undefined
  // 总开关（白名单校验，防脏值写盘）
  if (typeof patch.personaMode === 'string' && ['global', 'custom'].includes(patch.personaMode)) {
    bot.personaMode = patch.personaMode as 'global' | 'custom'
  }
  // 该机器人的独立运行配置（空串 = 清除、回到继承通道级）
  for (const k of ['providerId', 'modelId', 'effort', 'presetId'] as const) {
    if (typeof patch[k] === 'string') bot[k] = (patch[k] as string).trim() || undefined
  }
  if (typeof patch.permissionMode === 'string' && ['self_audit', 'full_access', 'confirm'].includes(patch.permissionMode)) {
    bot.permissionMode = patch.permissionMode as ChannelBot['permissionMode']
  }
  // 群聊插嘴（0912 二十四批）：布尔开关 + 门槛白名单 + 数值夹取
  if (typeof patch.interject === 'boolean') bot.interject = patch.interject
  if (typeof patch.interjectScope === 'string' && ['question', 'any', 'keyword'].includes(patch.interjectScope)) {
    bot.interjectScope = patch.interjectScope as 'question' | 'any'
  }
  if (typeof patch.interjectPerHour === 'number' && Number.isFinite(patch.interjectPerHour)) {
    bot.interjectPerHour = Math.max(0, Math.min(20, Math.floor(patch.interjectPerHour)))
  }
  /* 0912 反馈：插嘴词（数组，去空去重 + 夹取）与冷却时间（秒） */
  if (Array.isArray(patch.interjectKeywords)) {
    const seen = new Set<string>()
    const words: string[] = []
    for (const raw of patch.interjectKeywords) {
      if (typeof raw !== 'string') continue
      const w = raw.trim().slice(0, 20)
      if (!w || seen.has(w)) continue
      seen.add(w)
      words.push(w)
      if (words.length >= 20) break
    }
    bot.interjectKeywords = words
  }
  if (typeof patch.interjectCooldownSec === 'number' && Number.isFinite(patch.interjectCooldownSec)) {
    bot.interjectCooldownSec = Math.max(0, Math.min(86400, Math.floor(patch.interjectCooldownSec)))
  }
  cfg.updatedAt = Date.now()
  persist()
  return { ...cfg }
}

/** 删除机器人 */
export function removeBot(id: string, key: string): ChannelConfig | null {
  const data = load()
  const cfg = data.channels[id]
  if (!cfg) return null
  const before = cfg.bots.length
  cfg.bots = cfg.bots.filter(b => b.id !== key && b.accountId !== key)
  if (cfg.bots.length === before) return null
  cfg.updatedAt = Date.now()
  persist()
  return { ...cfg }
}

/** 该通道新建会话应使用的模型/预设/权限配置（供通道实现调用；空值=跟随全局） */
/**
 * 解析某通道（某机器人）实际生效的运行配置。
 *
 * 优先级：**机器人级 > 通道级**（各字段独立判断，机器人级留空即继承通道级）。
 * 不传 botId 时只读通道级（兼容旧调用）。
 */
export function modelForChannel(id: string, botId?: string): {
  providerId: string; modelId: string; effort: string; presetId: string
  permissionMode: ChannelConfig['permissionMode']
} {
  const c = getChannel(id)
  const bot = botId ? (c?.bots || []).find(b => b.id === botId || b.accountId === botId) : undefined
  // 0914 修订（用户反馈"选跟随全局仍显示型号"）：**选中机器人时只认机器人级值**——
  // 空 = 跟随全局（不回落到通道级）；通道级仅作"该通道没有机器人"时的兜底默认。
  const pick = (botVal?: string, chVal?: string): string => {
    if (bot) return String(botVal || '').trim()
    return String(chVal || '').trim()
  }
  const botPerm = String(bot?.permissionMode || '').trim()
  const perm = (['self_audit', 'full_access', 'confirm'].includes(botPerm)
    ? botPerm
    : (c?.permissionMode || 'self_audit')) as ChannelConfig['permissionMode']
  const providerId = pick(bot?.providerId, c?.providerId)
  const modelId = pick(bot?.modelId, c?.modelId)
  return {
    providerId,
    modelId,
    // 跟随全局（无模型）时强度一并交给全局 —— 不采用机器人/通道的残留值
    effort: modelId ? pick(bot?.effort, c?.effort) : '',
    presetId: pick(bot?.presetId, c?.presetId),
    permissionMode: perm,
  }
}

/** 对外输出时脱敏：把 secret 替换为「已设置」标记，避免前端拿到明文（前端只需知道「有没有」） */
function redactBots(bots: ChannelBot[]): Array<Omit<ChannelBot, 'secret'> & { hasSecret: boolean }> {
  return (bots || []).map(b => {
    const { secret, ...rest } = b
    return { ...rest, hasSecret: !!secret }
  })
}
