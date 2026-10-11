import { defineStore } from 'pinia'
import { ref } from 'vue'
import { PARTNER_PROFILES } from '@/utils/partners'
import { localStore } from '@/utils/localStore'

const STORAGE_KEY = 'nis-partner-overrides'
const CONFIG_KEY = 'nis-partner-configs'
const AVATAR_KEY = 'nis-partner-avatars'

type ProviderMode = 'follow' | 'independent'

interface PartnerConfig {
  /** 是否可用：停用后 NIS 选代理时忽略，进入伙伴仓库 */
  enabled: boolean
  /** 模型接入：follow=跟随 NIS 默认，independent=独立接入自选供应商+模型 */
  providerMode: ProviderMode
  /** 独立接入时的供应商 id */
  providerId: string
  /** 独立接入时的模型 id */
  modelId: string
}

const DEFAULT_CONFIG: PartnerConfig = {
  enabled: true,
  providerMode: 'follow',
  providerId: '',
  modelId: '',
}

/**
 * 预留后端同步消息（后端接入后用）：
 *   Client → Server: { "type": "PARTNER_CONFIG_UPDATE", "partners": [
 *     { "id": "Luna", "enabled": true, "provider": "deepseek", "model": "deepseek-chat" }
 *   ] }
 *   Server 在项目选择代理时跳过 enabled=false 的伙伴；
 *   provider/model 为空表示跟随 NIS 默认，否则该伙伴独立使用指定供应商模型。
 */

/**
 * 伙伴显示名 store —— 为「子代理改名」功能提前布局。
 *
 * 原则：后端英文规范名（Luna / WebSurfer / MCP Expert ...）是永不编辑的 ID，
 * 前端显示名是可覆写的字段。所有展示点（子代理弹窗 / 内联通知 / 伙伴气泡 /
 * 日志时间线 / 头像）统一走 displayName()，改一处全局生效。
 *
 * 自定义显示名存 localStorage（`nis-partner-overrides`），刷新不丢；
 * 后续子代理改名 UI 只需调用 renamePartner(id, name)。
 */
export const usePartnersStore = defineStore('partners', () => {
  /** 用户自定义显示名：key = 后端英文 ID，value = 用户改的名字 */
  const customNames = ref<Record<string, string>>({})

  function load() {
    try {
      const raw = localStore.getItem(STORAGE_KEY)
      if (raw) customNames.value = { ...JSON.parse(raw) }
    } catch (e) {
      /* localStorage 不可用时忽略 */
    }
  }

  function persist() {
    try {
      localStore.setItem(STORAGE_KEY, JSON.stringify(customNames.value))
    } catch (e) {
      /* ignore */
    }
  }

  load()

  /** 取显示名：用户自定义 > 默认中文名 > 原样英文名 */
  function displayName(id: string): string {
    const custom = customNames.value[id]?.trim()
    if (custom) return custom
    return PARTNER_PROFILES[id]?.name || id
  }

  function role(id: string): string {
    return PARTNER_PROFILES[id]?.role || ''
  }

  function image(id: string): string {
    return PARTNER_PROFILES[id]?.image || ''
  }

  // ── 伙伴头像：自定义上传 / 系统生成（dataUrl），未设置 → 首字占位 ──
  const avatars = ref<Record<string, string>>({})

  function loadAvatars() {
    try {
      const raw = localStore.getItem(AVATAR_KEY)
      if (raw) avatars.value = { ...JSON.parse(raw) }
    } catch (e) {
      /* ignore */
    }
  }

  function persistAvatars() {
    try {
      localStore.setItem(AVATAR_KEY, JSON.stringify(avatars.value))
    } catch (e) {
      /* ignore */
    }
  }

  loadAvatars()

  /** 取头像 dataUrl（无则空字符串 → 显示点回退首字占位） */
  function avatar(id: string): string {
    return avatars.value[id] || ''
  }

  function setAvatar(id: string, dataUrl: string) {
    if (dataUrl) avatars.value[id] = dataUrl
    else delete avatars.value[id]
    persistAvatars()
  }

  function clearAvatar(id: string) {
    delete avatars.value[id]
    persistAvatars()
  }

  /** 修改某伙伴显示名（空字符串 = 恢复默认） */
  function renamePartner(id: string, name: string) {
    const trimmed = (name || '').trim()
    if (trimmed) customNames.value[id] = trimmed
    else delete customNames.value[id]
    persist()
  }

  /** 恢复某伙伴默认显示名 */
  function resetPartner(id: string) {
    delete customNames.value[id]
    persist()
  }

  // ── 伙伴配置（启用/停用 + 独立供应商/模型） ──
  const configs = ref<Record<string, PartnerConfig>>({})

  function loadConfigs() {
    try {
      const raw = localStore.getItem(CONFIG_KEY)
      if (raw) configs.value = { ...JSON.parse(raw) }
    } catch (e) {
      /* ignore */
    }
  }

  function persistConfigs() {
    try {
      localStore.setItem(CONFIG_KEY, JSON.stringify(configs.value))
    } catch (e) {
      /* ignore */
    }
  }

  loadConfigs()

  /** 取伙伴配置（缺省合并默认值，不落库） */
  function getConfig(id: string): PartnerConfig {
    const c = configs.value[id]
    if (!c) return { ...DEFAULT_CONFIG }
    return { ...DEFAULT_CONFIG, ...c }
  }

  function isEnabled(id: string): boolean {
    return getConfig(id).enabled
  }

  function setEnabled(id: string, enabled: boolean) {
    const c = configs.value[id]
    configs.value[id] = { ...(c || DEFAULT_CONFIG), enabled }
    persistConfigs()
  }

  function setProviderMode(id: string, mode: ProviderMode) {
    const c = configs.value[id]
    configs.value[id] = { ...(c || DEFAULT_CONFIG), providerMode: mode }
    persistConfigs()
  }

  function setProvider(id: string, providerId: string) {
    const c = configs.value[id]
    configs.value[id] = { ...(c || DEFAULT_CONFIG), providerId, modelId: '' }
    persistConfigs()
  }

  function setModel(id: string, modelId: string) {
    const c = configs.value[id]
    configs.value[id] = { ...(c || DEFAULT_CONFIG), modelId }
    persistConfigs()
  }

  return {
    customNames,
    displayName,
    role,
    image,
    avatar,
    setAvatar,
    clearAvatar,
    renamePartner,
    resetPartner,
    configs,
    getConfig,
    isEnabled,
    setEnabled,
    setProviderMode,
    setProvider,
    setModel,
  }
})
