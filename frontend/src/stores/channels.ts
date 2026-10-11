import { defineStore } from 'pinia'
import { ref } from 'vue'
import { useChatStore } from './chat'

/**
 * 通道（接入）状态 —— 微信 / QQ / 远程访问
 *
 * 设计要点（见 docs/通道接入设计-前端与上下文-0912.md）：
 *   通道会话 = 普通会话（后端打 origin 标记）→ 这里的「独享对话列表」只是过滤视图，
 *   点开可跳回主界面继续聊（跨端接续），不做第二套聊天 UI。
 *
 * 配置（provider/model）落在后端 data/channels.json，前端只做镜像与编辑。
 */

export type ChannelId = 'wechat' | 'qq' | 'remote'

/** 通道下的机器人账号（QQ 支持多机器人） */
export interface ChannelBot {
  id: string
  accountId: string
  nickname: string
  enabled: boolean
  createdAt: number
  /** 是否已设置密钥（后端不下发明文，只给这个标记） */
  hasSecret: boolean
  /** 人格总开关：global=跟随系统设置 / custom=用下面的自定义项（缺省视为 global） */
  personaMode?: 'global' | 'custom'
  /** AI 自己的名字（覆盖「设置→人格」；空=跟随） */
  personaName?: string
  /** 对用户的称呼（覆盖「设置→通用」；空=跟随） */
  addressName?: string
  /** 说话风格提示词（覆盖「设置→人格」；空=跟随） */
  personaPrompt?: string
}

export interface ChannelConfig {
  enabled: boolean
  providerId: string
  modelId: string
  effort: string
  /** 该通道新建会话使用的 Agent 预设 id（空=跟随全局默认） */
  presetId: string
  /**
   * 权限模式。⚠️ 通道场景建议 `self_audit`（放行但留痕）——
   * `confirm` 会在 PC 弹审批卡，用户在 IM 里看不到 → agent 干等到超时（表现为"卡住不回"）
   */
  permissionMode: 'self_audit' | 'full_access' | 'confirm'
  accountId: string
  nickname: string
  bots: ChannelBot[]
  updatedAt: number
}

export interface ChannelSession {
  id: string
  title: string
  updatedAt: number
  createdAt: number
  status: string
  originPeer: string
  /** 来源机器人 id（QQ 多机器人时用于区分） */
  originBot: string
  /** 对端类型：'c2c' 私聊 / 'group' 群聊 / 'channel' 频道（列表里区分显示） */
  originKind?: string
  /** 对端显示名（群A / 群B / 私聊 …，可改名）—— 多群场景下列表靠它区分（0912 十七批） */
  peerLabel?: string
  model: string
  lastMessage: string
}

interface ChannelCommandSpec {
  name: string
  params: string
  desc: string
  aliases: string[]
}

/** 通道展示元数据（图标 / 色彩 / 说明 / 是否已实现） */
interface ChannelMeta {
  id: ChannelId
  labelKey: string
  icon: string
  /** 品牌色（用于状态点/强调） */
  color: string
  descKey: string
  /** 是否已具备连接实现（未实现的 tab 显示「待接入」而非假开关） */
  implemented: boolean
}

export const CHANNEL_META: ChannelMeta[] = [
  { id: 'wechat', labelKey: 'channel.wechat', icon: 'fab fa-weixin', color: '#07c160', descKey: 'channel.wechatDesc', implemented: false },
  { id: 'qq', labelKey: 'channel.qq', icon: 'fab fa-qq', color: '#12b7f5', descKey: 'channel.qqDesc', implemented: false },
  { id: 'remote', labelKey: 'channel.remote', icon: 'fas fa-qrcode', color: '#6366f1', descKey: 'channel.remoteDesc', implemented: false },
]

function emptyConfig(): ChannelConfig {
  return {
    enabled: false, providerId: '', modelId: '', effort: '', presetId: '',
    permissionMode: 'self_audit',
    accountId: '', nickname: '', bots: [], updatedAt: 0,
  }
}

export const useChannelsStore = defineStore('channels', () => {
  const chatStore = useChatStore()

  const configs = ref<Record<string, ChannelConfig>>({
    wechat: emptyConfig(), qq: emptyConfig(), remote: emptyConfig(),
  })
  /** 会话缓存：键为 `${channel}:${botId}`（QQ 多机器人时按机器人分桶） */
  const sessionsFor = ref<Record<string, ChannelSession[]>>({})
  /**
   * 「当前会话」缓存：键同上 → 会话 id 列表。
   * 后端后续收到的 IM 消息会落到这些会话（0912 三批：PC 端可见/可切换/可新建）。
   */
  const activeFor = ref<Record<string, string[]>>({})
  const commands = ref<ChannelCommandSpec[]>([])
  const loading = ref(false)
  /** 最近一次错误（弹窗内提示用） */
  const lastError = ref('')

  function cfg(id: ChannelId): ChannelConfig {
    return configs.value[id] || emptyConfig()
  }

  /** 拉取所有通道配置 */
  async function loadConfigs(): Promise<void> {
    if (!chatStore.wsConnected) return
    try {
      const r = await chatStore.bridgeRpc('channel.list', {})
      if (r?.channels) configs.value = { ...configs.value, ...r.channels }
      lastError.value = ''
    } catch (e: any) {
      lastError.value = String(e?.message || e).slice(0, 200)
    }
  }

  /** 更新单通道配置（局部字段） */
  async function updateConfig(id: ChannelId, patch: Partial<ChannelConfig>): Promise<boolean> {
    if (!chatStore.wsConnected) return false
    try {
      /* ★1011r：顺手把"当前界面的端口"报给后端 —— dev 模式下手机经 dev server 进来，
         防火墙要放行的是这个端口（不是后端端口）；打包版无端口则传 0。 */
      const uiPort = Number(window.location.port) || 0
      const r = await chatStore.bridgeRpc('channel.config.set', { channel: id, uiPort, ...patch })
      if (r?.channel) {
        configs.value = { ...configs.value, [id]: r.channel }
        lastError.value = ''
        return true
      }
      return false
    } catch (e: any) {
      lastError.value = String(e?.message || e).slice(0, 200)
      return false
    }
  }

  /**
   * 拉某通道的独享对话列表。
   *
   * 0912 二批：支持 `botId` —— QQ 多机器人时**每个机器人的对话互相独立**
   * （用户明确要求）。存储按 `${channel}:${botId}` 分桶，互不覆盖。
   * @param botId 空=该通道全部机器人
   */
  async function loadSessions(id: ChannelId, botId = ''): Promise<void> {
    if (!chatStore.wsConnected) return
    const key = `${id}:${botId}`
    try {
      const r = await chatStore.bridgeRpc('channel.sessions', { channel: id, botId })
      sessionsFor.value = { ...sessionsFor.value, [key]: Array.isArray(r?.sessions) ? r.sessions : [] }
      activeFor.value = { ...activeFor.value, [key]: Array.isArray(r?.activeIds) ? r.activeIds : [] }
      lastError.value = ''
    } catch (e: any) {
      lastError.value = String(e?.message || e).slice(0, 200)
    }
  }

  /** 读某通道（某机器人）的会话列表（响应式） */
  function sessionsOf(id: ChannelId, botId = ''): ChannelSession[] {
    return sessionsFor.value[`${id}:${botId}`] || []
  }

  /** 读某通道（某机器人）的「当前会话」id 列表（响应式） */
  function activeIdsOf(id: ChannelId, botId = ''): string[] {
    return activeFor.value[`${id}:${botId}`] || []
  }

  /**
   * 把某个会话设为「当前会话」—— 等价于手机发 `/switch N`。
   * 改的是后端同一份映射，所以 PC 上切完，手机下一条消息立刻落到该会话。
   */
  async function setActiveSession(sessionId: string, id: ChannelId, botId = ''): Promise<boolean> {
    if (!chatStore.wsConnected || !sessionId) return false
    try {
      const r = await chatStore.bridgeRpc('channel.setActiveSession', { sessionId, channel: id, botId })
      if (r?.ok) {
        await loadSessions(id, botId)
        lastError.value = ''
        return true
      }
      return false
    } catch (e: any) {
      lastError.value = String(e?.message || e).slice(0, 200)
      return false
    }
  }

  /**
   * 新建一个通道会话并设为当前 —— 等价于手机发 `/new`。
   * @returns 新会话 id；失败返回空串
   */
  async function newSession(id: ChannelId, botId = '', title = ''): Promise<string> {
    if (!chatStore.wsConnected) return ''
    try {
      const r = await chatStore.bridgeRpc('channel.newSession', { channel: id, botId, title })
      if (r?.ok) {
        await loadSessions(id, botId)
        lastError.value = ''
        return String(r?.session?.id || '')
      }
      return ''
    } catch (e: any) {
      lastError.value = String(e?.message || e).slice(0, 200)
      return ''
    }
  }

  /** 拉命令表（前端帮助展示，避免前端重复维护一份） */
  async function loadCommands(): Promise<void> {
    if (!chatStore.wsConnected || commands.value.length) return
    try {
      const r = await chatStore.bridgeRpc('channel.commands', {})
      if (Array.isArray(r?.commands)) commands.value = r.commands
    } catch { /* 命令表拉取失败不阻塞 */ }
  }

  /**
   * 执行一条命令（弹窗内联调用，无需真实通道即可验证命令层）。
   * @returns { handled, reply, action }
   */
  async function runCommand(
    id: ChannelId,
    text: string,
    sessionId?: string,
  ): Promise<{ handled: boolean; reply: string; action?: { kind: string; sessionId?: string } }> {
    if (!chatStore.wsConnected) return { handled: false, reply: '后端未连接' }
    try {
      const r = await chatStore.bridgeRpc('channel.command', { channel: id, text, sessionId: sessionId || '' })
      return { handled: !!r?.handled, reply: String(r?.reply || ''), action: r?.action }
    } catch (e: any) {
      return { handled: false, reply: String(e?.message || e).slice(0, 200) }
    }
  }

  /** 供联调：给会话打来源标记（真实场景由通道创建会话时带 origin） */
  async function setSessionOrigin(sessionId: string, origin: string, originPeer = ''): Promise<boolean> {
    if (!chatStore.wsConnected) return false
    try {
      await chatStore.bridgeRpc('session.setOrigin', { sessionId, origin, originPeer })
      return true
    } catch {
      return false
    }
  }

  /**
   * 会话在「普通聊天列表」与「通道独享列表」之间迁移（双向）。
   * 通道会话本就是普通会话，所以迁移只改一个 origin 字段 —— 无损、可逆、不搬消息。
   * @param target 目标通道；空串 = 移回普通聊天列表
   * @param peer   二十一批：二级菜单选定「哪个机器人的哪个对端」——
   *               QQ 多机器人 + 多群场景下，只给通道名不知道该落到哪条对话（用户要求可选）。
   */
  async function moveSession(
    sessionId: string,
    target: ChannelId | '',
    peer?: { botId?: string; peerId?: string; kind?: string },
  ): Promise<boolean> {
    if (!chatStore.wsConnected) return false
    try {
      await chatStore.bridgeRpc('channel.moveSession', {
        sessionId, target,
        ...(peer?.botId ? { botId: peer.botId } : {}),
        ...(peer?.peerId ? { peerId: peer.peerId } : {}),
        ...(peer?.kind ? { kind: peer.kind } : {}),
      })
      lastError.value = ''
      return true
    } catch (e: any) {
      lastError.value = String(e?.message || e).slice(0, 200)
      return false
    }
  }

  /** 已知通道对端（二十一批）：转为通道对话的二级菜单数据源（与通知位置同源） */
  async function loadPeers(): Promise<Array<{
    channel: ChannelId; botId: string; peerId: string; kind?: string
    botName?: string; peerLabel?: string; groupKey?: string; groupLabel?: string; label?: string; lastAt?: number
  }>> {
    if (!chatStore.wsConnected) return []
    try {
      const r = await chatStore.bridgeRpc('channel.peers', {})
      return Array.isArray(r?.peers) ? r.peers : []
    } catch { return [] }
  }

  /* ── 机器人（账号）管理：QQ 多机器人 / 微信多账号 ── */

  async function addBot(id: ChannelId, bot: { accountId: string; secret?: string; nickname?: string }): Promise<boolean> {
    if (!chatStore.wsConnected) return false
    try {
      const r = await chatStore.bridgeRpc('channel.bot.add', { channel: id, ...bot })
      if (r?.channel) { configs.value = { ...configs.value, [id]: r.channel }; lastError.value = ''; return true }
      return false
    } catch (e: any) {
      lastError.value = String(e?.message || e).slice(0, 200)
      return false
    }
  }

  /**
   * 更新单个机器人的配置。
   * ⚠️ 这里的类型是**编译期声明，运行时是 spread 透传**（`{ channel, key, ...patch }`）——
   * 早期只声明了人格相关字段，于是「模型 / 强度 / 预设 / 插嘴」这些明明能存进去的字段
   * 在类型上"不存在"，后来加字段时容易误判成"要改 store 才能生效"。0913 补齐，
   * 与后端 `channel.bot.update` 的接收白名单对齐（漏字段会静默丢弃，见后端同名 case）。
   */
  async function updateBot(id: ChannelId, key: string, patch: {
    secret?: string; nickname?: string; enabled?: boolean
    personaMode?: 'global' | 'custom'
    personaName?: string; addressName?: string; personaPrompt?: string
    // 该机器人的独立运行配置（空串 = 清除 → 继承通道级）
    providerId?: string; modelId?: string; effort?: string; presetId?: string
    permissionMode?: 'self_audit' | 'full_access' | 'confirm'
    // 群聊插嘴
    interject?: boolean
    interjectScope?: 'question' | 'any' | 'keyword'
    interjectPerHour?: number
    interjectKeywords?: string[]
    interjectCooldownSec?: number
  }): Promise<boolean> {
    if (!chatStore.wsConnected) return false
    try {
      const r = await chatStore.bridgeRpc('channel.bot.update', { channel: id, key, ...patch })
      if (r?.channel) { configs.value = { ...configs.value, [id]: r.channel }; lastError.value = ''; return true }
      return false
    } catch (e: any) {
      lastError.value = String(e?.message || e).slice(0, 200)
      return false
    }
  }

  async function removeBot(id: ChannelId, key: string): Promise<boolean> {
    if (!chatStore.wsConnected) return false
    try {
      const r = await chatStore.bridgeRpc('channel.bot.remove', { channel: id, key })
      if (r?.channel) { configs.value = { ...configs.value, [id]: r.channel }; lastError.value = ''; return true }
      return false
    } catch (e: any) {
      lastError.value = String(e?.message || e).slice(0, 200)
      return false
    }
  }

  /* ── 微信扫码登录（移植官方 openclaw-weixin）── */

  /** 发起扫码：返回二维码图片（dataURL，官方给的是落地页 URL，后端已转成图） */
  async function wechatQrStart(): Promise<{ ok: boolean; sessionKey: string; qrImage?: string; message: string }> {
    if (!chatStore.wsConnected) return { ok: false, sessionKey: '', message: '后端未连接' }
    try {
      const r = await chatStore.bridgeRpc('channel.wechat.qrStart', {})
      return { ok: !!r?.ok, sessionKey: String(r?.sessionKey || ''), qrImage: r?.qrImage || r?.qrcodeUrl, message: String(r?.message || '') }
    } catch (e: any) {
      return { ok: false, sessionKey: '', message: String(e?.message || e).slice(0, 200) }
    }
  }

  /** 轮询扫码结果（内部 35s 长轮询，前端循环调用即可） */
  async function wechatQrWait(sessionKey: string, verifyCode?: string): Promise<{
    ok: boolean; status: string; connected: boolean; alreadyConnected?: boolean
    needVerifyCode?: boolean; qrImage?: string; message: string
  }> {
    if (!chatStore.wsConnected) return { ok: false, status: 'expired', connected: false, message: '后端未连接' }
    try {
      const r = await chatStore.bridgeRpc('channel.wechat.qrWait', { sessionKey, verifyCode })
      // 连接成功 → 刷新配置（拿到刚写入的账号）
      if (r?.connected) void loadConfigs()
      return {
        ok: !!r?.ok, status: String(r?.status || ''), connected: !!r?.connected,
        alreadyConnected: !!r?.alreadyConnected, needVerifyCode: !!r?.needVerifyCode,
        qrImage: r?.qrImage || r?.qrcodeUrl, message: String(r?.message || ''),
      }
    } catch (e: any) {
      return { ok: false, status: 'expired', connected: false, message: String(e?.message || e).slice(0, 200) }
    }
  }

  async function wechatQrCancel(sessionKey: string): Promise<void> {
    if (!chatStore.wsConnected || !sessionKey) return
    try { await chatStore.bridgeRpc('channel.wechat.qrCancel', { sessionKey }) } catch { /* ignore */ }
  }

  /** 通道连接状态（QQ 机器人在线 / 微信连接） */
  async function loadStatus(): Promise<{ qq: Record<string, any>; wechat: Record<string, any> }> {
    if (!chatStore.wsConnected) return { qq: {}, wechat: {} }
    try {
      const r = await chatStore.bridgeRpc('channel.status', {})
      return { qq: r?.qq || {}, wechat: r?.wechat || {} }
    } catch { return { qq: {}, wechat: {} } }
  }

  /**
   * 给某个「对端」改名（0912 十七批）：群A → 「工作群」。
   * 改名后：独享对话列表、定时任务的通知目标都用这个名字显示。
   */
  async function setPeerLabel(channel: ChannelId, botId: string, peerId: string, label: string, kind?: string): Promise<boolean> {
    if (!chatStore.wsConnected || !peerId || !label.trim()) return false
    try {
      await chatStore.bridgeRpc('channel.setPeerLabel', { channel, botId, peerId, label: label.trim(), kind: kind || '' })
      await loadSessions(channel, botId)
      return true
    } catch (e: any) {
      lastError.value = String(e?.message || e).slice(0, 200)
      return false
    }
  }

  return {
    configs, sessionsFor, activeFor, commands, loading, lastError,
    cfg, loadConfigs, updateConfig, loadSessions, sessionsOf, activeIdsOf, loadCommands,
    runCommand, setSessionOrigin, moveSession, loadPeers, setActiveSession, newSession, setPeerLabel,
    addBot, updateBot, removeBot,
    wechatQrStart, wechatQrWait, wechatQrCancel, loadStatus,
  }
})
