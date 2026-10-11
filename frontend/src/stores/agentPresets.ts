import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { useSettingsStore } from './settings'
import { useChatStore } from './chat'
import { t } from '@/utils/i18n'
import { localStore } from '@/utils/localStore'
import { swallowed } from '@/utils/swallowed'

/** 工具目录条目（来自后端 TOOL_CATALOG） */
export interface ToolCatalogEntry {
  name: string
  description: string
  group: string
}

/**
 * Agent 预设：新会话的「角色增量」（语义对齐 dsh AgentPreset 的组装清单轻量版）。
 * 注意：预设不携带人格——全局人设（settings.persona）永远叠加在最外层；
 * role 只描述这个预设的专业方向与行为纪律。
 *
 * 落盘：后端文件化存储 backend/data/agent-presets/<id>/preset.json（可拆装、每预设一个文件夹隔离）。
 * 本 store 通过 agentPreset.* RPC 读写；localStorage 只存「新会话默认预设」偏好。
 * 内置预设：后端启动 seed，只读 + 可复制。
 */
interface AgentPreset {
  id: string
  name: string
  description: string
  /** 角色增量：这个预设的专业方向与行为纪律（叠加在全局人格之上） */
  role: string
  /** 原装工具名清单（不映射，保持各 agent 原始名称；渲染端按类别解码） */
  tools?: string[]
  /** MCP 总开关（④c 简化版，缺省 true）：false=该预设 agent 不注入任何 MCP；true=可用所有"启用∧已选择"的 server */
  mcp?: boolean
  /** @deprecated per-server 白名单已废弃，改用 mcp 总开关 + 工具页服务复选；仅兼容读取 */
  mcpServers?: string[]
  /** 命名工具集：会话级构建的工具包（install=安装助手；preset-admin=预设管理） */
  toolsets?: string[]
  /** 可用技能引用清单（空=全部技能可用） */
  skills?: string[]
  /** 头像（0913）：256×256 JPEG 的 dataURL（前端 canvas 裁剪压缩后上传）；未设置 = 默认头像 */
  avatar?: string
  /** ★1001 外部预设：引擎（native/缺省=内置 pi agent；codex=外部 CLI agent 子进程跑） */
  engine?: 'native' | 'codex' | 'opencode' | 'dsh' | 'hermes' | 'zcode' | 'gemini' | 'pi'
  /** 模型来源：nis=用 NIS 的模型与 key；own=用它自己的配置/订阅 */
  modelSource?: 'nis' | 'own'
  /** 外部引擎的模型名（modelSource=own 时用） */
  externalModel?: string
  /** 内置预设不可删不可编辑，可复制；自定义可编辑可删 */
  builtin: boolean
  createdAt: number
}

const DEFAULT_KEY = 'nis-agent-preset-default'

/** RPC 失败时的本地兜底（正常情况列表以后端文件为准） */
const FALLBACK_PRESETS: AgentPreset[] = [
  {
    id: 'minimal', name: '对话模式',
    description: '纯对话：不挂载任何工具、不启用 MCP，只做聊天与问答。',
    role: '你只做对话：不调用任何工具，也不要假装能读写文件、联网或执行命令。',
    tools: [],
    mcp: false,
    builtin: true, createdAt: 0,
  },
  {
    id: 'standard', name: '标准模式',
    description: '功能完整的编码 Agent：文件编辑、命令执行、检索、计划、子代理。',
    role: '你是资深全栈工程师。先探索再修改：动手前先用读取和搜索确认现状；遵循项目现有风格与依赖；改动前说明影响面；完成后给出验证方式。',
    tools: ['run_command', 'fs_read', 'fs_write', 'fs_search', 'web_search', 'todo', 'ask_user', 'subagent'],
    builtin: true, createdAt: 0,
  },
  {
    // 0918：显示名「升级模式」→「改造模式」（id 不变，后端 agentPresetsStore.ts 同步改名 + bump version）
    id: 'cordis', name: '改造模式',
    description: '用于创建和改进自定义 Agent 预设：标准能力 + 运行时检查 + 创作指导。',
    role: '你负责创建和改进 Agent 预设。动手前先复述用户想要的 Agent 行为边界；产出预设时说明角色定位、适用场景与工具取舍的理由；主动指出预设之间的重叠与更优组合。',
    tools: ['run_command', 'fs_read', 'fs_write', 'fs_search', 'web_search', 'todo', 'ask_user', 'subagent'],
    builtin: true, createdAt: 0,
  },
  {
    // 0918 新增：导入其他 agent 数据专用（设置→通用→「导入其他 agent 数据」开的就是它）
    id: 'agent-import', name: '导入助手',
    description: '把其他 AI Agent 在本机的对话、记忆、项目档案安全迁进 NIS。',
    role: '',
    builtin: true, createdAt: 0,
  },
  {
    id: 'install-assistant', name: '安装助手',
    description: 'AI 导入安装：把技能包（SKILL.md）与 MCP 插件安全安装到 NIS。',
    role: '',
    builtin: true, createdAt: 0,
  },
]

function toPreset(raw: any): AgentPreset {
  return {
    id: String(raw.id || ''),
    name: String(raw.name || raw.id || ''),
    description: String(raw.description || ''),
    role: String(raw.role || ''),
    tools: Array.isArray(raw.tools) ? raw.tools : undefined,
    toolsets: Array.isArray(raw.toolsets) ? raw.toolsets : undefined,
    skills: Array.isArray(raw.skills) ? raw.skills : undefined,
    // 0913 修复：此前 mcp 没映射 → 上一批「对话模式 MCP 关闭」在刷新后失效（锁定判断拿不到 mcp===false）；
    // 本轮补映射，并把 avatar 一并带上（后端已存，前端不映射等于白存）
    mcp: typeof raw.mcp === 'boolean' ? raw.mcp : undefined,
    mcpServers: Array.isArray(raw.mcpServers) ? raw.mcpServers : undefined,
    avatar: typeof raw.avatar === 'string' && raw.avatar ? raw.avatar : undefined,
    engine: ['codex', 'opencode', 'dsh', 'hermes', 'zcode', 'gemini', 'pi'].includes(String(raw.engine)) ? raw.engine : undefined,   // ★1001 外部预设（全部引擎都要保留，别只认 codex）
    modelSource: raw.modelSource === 'own' ? 'own' : (raw.engine && raw.engine !== 'native' ? 'nis' : undefined),
    externalModel: typeof raw.externalModel === 'string' && raw.externalModel ? raw.externalModel : undefined,
    builtin: !!raw.builtin,
    createdAt: Number(raw.createdAt || 0),
  }
}

async function presetRpc<T = any>(method: string, payload: Record<string, any> = {}): Promise<T> {
  return useChatStore().bridgeRpc(`agentPreset.${method}`, payload)
}

export const useAgentPresetsStore = defineStore('agentPresets', () => {
  const presets = ref<AgentPreset[]>([...FALLBACK_PRESETS])
  const defaultPresetId = ref<string>('standard')
  const ready = ref(false)
  /** 全量工具目录（预设工具编辑弹窗用） */
  const toolCatalog = ref<ToolCatalogEntry[]>([])
  /** MCP server 实时视图（registry RPC 附带：服务复选/停用/总开关展示共用） */
  const mcpServersView = ref<Array<{ name: string; enabled: boolean; selected: boolean; connected: boolean; status: string; toolCount: number; description: string }>>([])

  async function loadToolCatalog() {
    try {
      const v = await presetRpc<{ tools: ToolCatalogEntry[] }>('tools')
      if (Array.isArray(v?.tools)) toolCatalog.value = v.tools
      if (Array.isArray(v?.mcpServers)) mcpServersView.value = v.mcpServers
    } catch (e) { swallowed('预设工具目录/MCP 视图加载失败（预设弹窗里工具可能缺失或显示不全）', e) }
  }
  loadToolCatalog()

  async function persistDefault() {
    try { localStore.setItem(DEFAULT_KEY, defaultPresetId.value) }
    catch (e) { swallowed('默认预设没存住（下次启动会回到旧默认）', e) }
  }

  /** 从后端拉取预设列表（文件化存储为权威） */
  async function load() {
    try {
      const v = await presetRpc<{ presets: any[] }>('list')
      if (Array.isArray(v?.presets) && v.presets.length) {
        presets.value = v.presets.map(toPreset).filter(p => p.id)
      }
    } catch (e) {
      console.warn('[agentPresets] RPC list failed, fallback to builtin:', e)
    } finally {
      ready.value = true
    }
    const savedDefault = localStore.getItem(DEFAULT_KEY)
    if (savedDefault && presets.value.some(p => p.id === savedDefault)) {
      defaultPresetId.value = savedDefault
    } else if (!presets.value.some(p => p.id === defaultPresetId.value)) {
      defaultPresetId.value = presets.value.find(p => p.id === 'standard')?.id || presets.value[0]?.id || 'standard'
      persistDefault()
    }
  }

  load()

  /** 新会话使用的默认预设 */
  const activePreset = computed(() =>
    presets.value.find(p => p.id === defaultPresetId.value) || presets.value.find(p => p.id === 'standard') || presets.value[0],
  )

  function isDefault(id: string): boolean {
    return defaultPresetId.value === id
  }

  /** 设为新会话默认 */
  function makeDefault(id: string) {
    if (!presets.value.some(p => p.id === id)) return
    defaultPresetId.value = id
    persistDefault()
  }

  /** 复制创建（从内置或自定义复制出一份自定义） */
  async function duplicate(fromId: string, newId: string, newName: string): Promise<AgentPreset | null> {
    const src = presets.value.find(p => p.id === fromId)
    if (!src) return null
    const id = newId.trim()
    if (!id || presets.value.some(p => p.id === id)) return null
    const copy: AgentPreset = {
      id,
      name: newName.trim() || `${src.name} 副本`,
      description: `复制自「${src.name}」`,
      role: src.role,
      tools: src.tools ? [...src.tools] : undefined,
      toolsets: src.toolsets ? [...src.toolsets] : undefined,
      skills: src.skills ? [...src.skills] : undefined,
      builtin: false,
      createdAt: Date.now(),
    }
    const r = await presetRpc<{ ok: boolean; preset: any }>('write', { preset: copy })
    const saved = toPreset(r?.preset || copy)
    presets.value.push(saved)
    return saved
  }

  /** 新建空白自定义预设 */
  /**
   * 新建自定义预设。
   *
   * 0912 修复：此前 role 传空串 → 后端 `validateAgentPreset` 拒绝（"role 不能为空"），
   * 新建必然失败。role 是 Agent 的人设/系统提示词，不能为空 —— 这里给一个**可用的起始模板**，
   * 用户创建后可直接在编辑弹窗里改写（调用方 confirmPresetCreate 会接着打开编辑）。
   */
  const DEFAULT_NEW_ROLE = [
    '你是 NIS 的助手。',
    '',
    '工作方式：先探索再动手 —— 动手前先用读取和搜索确认现状；',
    '遵循项目现有风格与依赖；改动前说明影响面；完成后给出验证方式。',
  ].join('\n')

  async function create(id: string, name: string, role?: string): Promise<AgentPreset | null> {
    const key = id.trim()
    if (!key || presets.value.some(p => p.id === key)) return null
    const preset: AgentPreset = {
      id: key,
      name: name.trim() || '未命名预设',
      description: '自定义预设',
      role: (role || '').trim() || DEFAULT_NEW_ROLE,
      builtin: false,
      createdAt: Date.now(),
    }
    const r = await presetRpc<{ ok: boolean; preset: any }>('write', { preset })
    const saved = toPreset(r?.preset || preset)
    presets.value.push(saved)
    return saved
  }

  /** 更新自定义预设（内置只读，后端同样拒绝覆盖 builtin） */
  async function updateCustom(id: string, patch: Partial<Pick<AgentPreset, 'name' | 'description' | 'role' | 'tools' | 'toolsets' | 'skills' | 'mcp' | 'mcpServers' | 'avatar' | 'engine' | 'modelSource' | 'externalModel'>>) {
    const p = presets.value.find(x => x.id === id)
    if (!p || p.builtin) return
    const merged = { ...p, ...patch }
    await presetRpc('write', { preset: merged })
    Object.assign(p, merged)
  }

  /**
   * 三层系统提示词组装（会话创建时定型，随 session.create 发给桥接）：
   *   ① 人格层：全局人设系统（nisName + 性格提示词）——所有预设必叠
   *   ② 预设角色层：agent 预设的 role 增量
   *   ③ 运行时层：会话工作区
   */
  function composeSystem(presetId: string, workDir?: string): string {
    const settings = useSettingsStore()
    const preset = presets.value.find(p => p.id === presetId)
    const lines: string[] = []
    lines.push(`你是 ${settings.persona.nisName}。`)
    // 用户名字（设置权威）：AI 必须记住，聊天中的临时称呼不得覆盖设置
    if (settings.general.userName.trim() && settings.general.userName.trim() !== '用户') {
      lines.push(`用户的名字是「${settings.general.userName.trim()}」（来自设置，权威不可覆盖）。除非用户明确要求修改设置，否则一直这样称呼用户；用户说"叫我X"时先口头答应，并询问是否要更新设置里的名字。`)
    }
    if (settings.persona.prompt.trim()) {
      lines.push(`你的性格与说话方式：${settings.persona.prompt.trim()}`)
    }
    if (preset?.role?.trim()) {
      lines.push(`你的角色与专长：${preset.role.trim()}`)
    }
    if (workDir?.trim()) {
      lines.push(`当前工作目录：${workDir.trim()}。产出与下载默认放在这个目录里。`)
    }
    return lines.join('\n')
  }

  /** 删除自定义预设（后端删文件夹；内置被后端拒绝）；若它正被设为默认则回退到第一个内置 */
  async function removeCustom(id: string) {
    const p = presets.value.find(x => x.id === id)
    if (!p || p.builtin) return
    await presetRpc('delete', { id })
    presets.value = presets.value.filter(x => x.id !== id)
    if (defaultPresetId.value === id) {
      defaultPresetId.value = presets.value.find(x => x.builtin)?.id || 'standard'
      persistDefault()
    }
  }

  /** 0913 头像批：按预设 id 取头像 dataURL（未设置/未命中 → 空串，调用方回退默认头像） */
  function avatarOf(id: string | undefined | null): string {
    const pid = String(id || '')
    if (!pid) return ''
    return presets.value.find(p => p.id === pid)?.avatar || ''
  }

  return {
    presets,
    defaultPresetId,
    ready,
    toolCatalog,
    mcpServersView,
    loadToolCatalog,
    activePreset,
    isDefault,
    makeDefault,
    duplicate,
    create,
    updateCustom,
    removeCustom,
    avatarOf,
    composeSystem,
    reload: load,
  }
})

/** 内置预设的显示名走字典（内置只读；字典无此 id 则回退原值，自定义预设天然不命中） */
export function presetDisplayName(p: { id?: string; name?: string } | null | undefined): string {
  if (!p) return ''
  const k = `preset.${p.id}.name`
  const v = t(k)
  return v === k ? (p.name || '') : v
}

/** 内置预设的描述走字典；回退规则同 presetDisplayName */
export function presetDisplayDesc(p: { id?: string; description?: string } | null | undefined): string {
  if (!p) return ''
  const k = `preset.${p.id}.desc`
  const v = t(k)
  return v === k ? (p.description || '') : v
}
