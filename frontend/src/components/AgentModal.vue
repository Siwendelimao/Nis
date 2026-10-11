<script setup lang="ts">
import { ref, computed, reactive, watch, onMounted, onUnmounted, markRaw } from 'vue'
import { useAgentPresetsStore, presetDisplayName, presetDisplayDesc } from '@/stores/agentPresets'
import { useTeamsStore, type Team } from '@/stores/teams'
import { useProvidersStore } from '@/stores/providers'
import { useConversationsStore } from '@/stores/conversations'
import { useChatStore } from '@/stores/chat'   // ★1001 外部 agent 安装 RPC（bridgeRpc）
import MiniSelect from './blocks/MiniSelect.vue'
import SegTabs from './blocks/SegTabs.vue'
import BwSwitch from './BwSwitch.vue'
import { t } from '@/utils/i18n'

/**
 * Agent 弹窗（左侧栏入口）：两个 tab
 *   - 预设：单 agent 预设管理（卡片选择=设为新会话默认；内置只读可复制；自定义可编辑可删）
 *   - 团队：多 agent 协作编排（开发中）
 * 预设落盘：backend/data/agent-presets/<id>/preset.json（每预设一个文件夹，可拆装）
 */
const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const agentPresetsStore = useAgentPresetsStore()
const teamsStore = useTeamsStore()
const providersStore = useProvidersStore()

const activeTab = ref<'presets' | 'teams' | 'external'>('presets')

// ── 预设：卡片选择=设为新会话默认；内置只读可复制；自定义可编辑可删 ──
const presetViewId = ref<string | null>(null)      // 只读查看（内置）
const presetEditId = ref<string | null>(null)      // 编辑（自定义）
const presetEditDraft = reactive({ name: '', description: '', role: '' })
const presetCopyFrom = ref<string | null>(null)    // 复制来源（'__new__'=新建）
const presetCopyDraft = reactive({ id: '', name: '' })
const presetCopyError = ref('')
const presetDeleteId = ref<string | null>(null)
/** 默认头像（未设置时）：按预设 id 哈希取渐变色 + 名称首字 */
const AVATAR_PALETTES = [
  'linear-gradient(135deg, #0ea5e9 0%, #6366f1 100%)',
  'linear-gradient(135deg, #f59e0b 0%, #ef4444 100%)',
  'linear-gradient(135deg, #10b981 0%, #14b8a6 100%)',
  'linear-gradient(135deg, #ec4899 0%, #8b5cf6 100%)',
  'linear-gradient(135deg, #8b5cf6 0%, #6366f1 100%)',
  'linear-gradient(135deg, #06b6d4 0%, #3b82f6 100%)',
]
function avatarFallbackStyle(p: { id?: string } | null | undefined): Record<string, string> {
  const id = String(p?.id || '')
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return { background: AVATAR_PALETTES[h % AVATAR_PALETTES.length] }
}
function avatarInitialOf(p: { id?: string; name?: string } | null | undefined): string {
  const name = presetDisplayName(p) || String((p as any)?.name || '')
  return Array.from(name)[0] || '?'
}
// ── 工具编辑：查看预设的工具清单，可增删（内置只读） ──
const presetToolId = ref<string | null>(null)
const toolDraft = ref<Set<string>>(new Set())
const toolSaved = ref(false)
const toolError = ref('')
/** toolsets → 专属工具映射（声明即启用，不可取消） */
const TOOLSET_TOOLS: Record<string, string[]> = {
  install: ['install_skill', 'uninstall_skill', 'scan_skill', 'list_installed', 'install_mcp', 'uninstall_mcp'],
  'preset-admin': ['list_tools', 'read_preset', 'save_preset', 'delete_preset'],
  'custom-tools': ['list_custom_tools', 'save_custom_tool', 'delete_custom_tool'],
  'self-modify': ['project_fs_read', 'project_fs_grep', 'project_fs_write', 'project_fs_edit', 'project_fs_delete', 'project_run_command'],
  'ask-user': ['ask_user'],
}
/** toolset 展示名（存 i18n key，渲染处 t() 解析，切语言即时生效） */
const TOOLSET_LABELS: Record<string, string> = markRaw({
  install: 'agent.toolsetInstall',
  'preset-admin': 'agent.toolsetPresetAdmin',
  'custom-tools': 'agent.toolsetCustomTools',
  'self-modify': 'agent.toolsetSelfModify',
  'ask-user': 'agent.toolsetAskUser',
})
/** 工具 → 所属 toolset（归属徽标展示用） */
function toolsetOf(name: string): string | null {
  for (const [ts, tools] of Object.entries(TOOLSET_TOOLS)) {
    if (tools.includes(name)) return ts
  }
  return null
}
const presetToolEditing = computed(() => agentPresetsStore.presets.find(p => p.id === presetToolId.value) || null)
/** 当前预设的专属工具（toolsets 生成） */
const exclusiveTools = computed<string[]>(() =>
  (presetToolEditing.value?.toolsets || []).flatMap(t => TOOLSET_TOOLS[t] || []),
)
/** 按后端目录分组（保留声明顺序），只有目录里的工具才可勾选；目录滞后时补「专属工具」组 */
const toolGroups = computed(() => {
  const groups: Array<{ name: string; tools: Array<{ name: string; description: string; checked: boolean; locked: boolean; exclusiveLabel?: string }> }> = []
  const ex = new Set(exclusiveTools.value)
  for (const tool of agentPresetsStore.toolCatalog) {
    // 唯一源投影（0904 / 0913 修）：MCP 条目不进勾选清单（用下方 server 级总开关控制）；
    // **自定义工具要能勾选** —— 自定义预设正是靠勾选决定"这个 agent 能用哪些工具"（用户 0913 反馈）。
    // 后端配套：自定义工具也随预设 tools 白名单过滤（勾选才挂载）。
    if ((tool as any).source === 'mcp') continue
    let g = groups.find(x => x.name === tool.group)
    if (!g) { g = { name: tool.group, tools: [] }; groups.push(g) }
    const isEx = ex.has(tool.name)
    g.tools.push({ name: tool.name, description: tool.description, checked: toolDraft.value.has(tool.name) || isEx, locked: isEx, exclusiveLabel: isEx ? (TOOLSET_LABELS[toolsetOf(tool.name) || ''] || 'agent.exclusiveDefault') : undefined })
  }
  // 目录里还没有的专属工具（数据滞后）→ 补一组兜底显示
  const missing = exclusiveTools.value.filter(n => !agentPresetsStore.toolCatalog.some(ct => ct.name === n))
  if (missing.length) {
    groups.push({ name: 'agent.exclusiveGroup', tools: missing.map(n => ({ name: n, description: '', checked: true, locked: true, exclusiveLabel: TOOLSET_LABELS[toolsetOf(n) || ''] || 'agent.exclusiveDefault' })) })
  }
  return groups
})

/* ── 工具行悬停气泡（0912 反馈；0920 复测"卡顿不跟手"后重做定位）──────────
 * 原生 title 不受控、出得慢，跟项目里其他提示的气泡语言不一致 →
 * 自绘深色气泡，样式对齐设置页 HintTip / 队列卡 .qb-tip（bg-gray-900 + 白字圆角）。
 * 交互（用户拍板）：**悬停 0.75s 才弹出** —— 鼠标横扫整列工具时不会一路乱闪；
 * 移出 100ms 关（留一点余量，从行移到气泡上不闪）。
 * Teleport 到 body + fixed —— 弹窗根是 overflow-hidden，行内 absolute 浮层一出去就被裁。
 *
 * ★ 0920 修「卡顿不跟手」（反馈，参照输入框下方那套）：
 *   ① 旧实现"已在显示 → 只换文字、**不动位置**"（当时想的是"横向移动立刻跟着换"，
 *      但位置没跟着换 → 气泡钉在上一行的位置、内容却变了，看着就是"不跟手"）。
 *      现在：**换目标一定重新定位**（位置是即时生效的，没有过渡动画，换过去就是新的位置）。
 *   ② 列表是 `overflow-y-auto`，**在列表里滚动**时气泡原来完全不动 → 现在监听 scroll(capture)
 *      + resize，跟着当前行重新定位。
 *   ③ 顺带把"当前行元素"记下来（toolTipEl），重定位/收起都以它为准。 */
const TOOL_TIP_DELAY_MS = 750
const toolTipText = ref('')
const toolTipShow = ref(false)
const toolTipPos = ref<{ left: number; bottom: number }>({ left: 0, bottom: 0 })
let toolTipOpenTimer: ReturnType<typeof setTimeout> | undefined
let toolTipCloseTimer: ReturnType<typeof setTimeout> | undefined
/** 当前气泡挂在哪一行（重定位/滚动跟随用） */
let toolTipEl: HTMLElement | null = null

function toolTipLabel(name: string, desc: string) {
  return desc ? `${name} — ${desc}` : name
}

/** 把气泡贴到某一行的上方（即时生效，不做动画） */
function placeToolTip(el: HTMLElement): void {
  const r = el.getBoundingClientRect()
  const maxW = Math.min(420, window.innerWidth - 16)
  // 左对齐行首；右侧越界则贴右（按最大宽度预留，无需二次测量修正）
  const left = Math.max(8, Math.min(r.left + 8, window.innerWidth - maxW - 8))
  toolTipPos.value = { left, bottom: window.innerHeight - r.top + 6 }
}

function openToolTip(el: HTMLElement, name: string, desc: string) {
  if (toolTipCloseTimer) { clearTimeout(toolTipCloseTimer); toolTipCloseTimer = undefined }
  // 已在显示中：换内容**并且换位置**（不重走 750ms 延迟）
  if (toolTipShow.value) {
    toolTipEl = el
    toolTipText.value = toolTipLabel(name, desc)
    placeToolTip(el)
    return
  }
  if (toolTipOpenTimer) clearTimeout(toolTipOpenTimer)
  toolTipOpenTimer = setTimeout(() => {
    toolTipOpenTimer = undefined
    // 延迟期间元素可能已被卸载（滚动/切页）→ 不再弹
    if (!el || !el.isConnected) return
    toolTipEl = el
    toolTipText.value = toolTipLabel(name, desc)
    placeToolTip(el)
    toolTipShow.value = true
  }, TOOL_TIP_DELAY_MS)
}
function scheduleToolTipClose() {
  // 还没到 750ms 就移开 → 直接取消，气泡根本不出现
  if (toolTipOpenTimer) { clearTimeout(toolTipOpenTimer); toolTipOpenTimer = undefined }
  if (toolTipCloseTimer) clearTimeout(toolTipCloseTimer)
  toolTipCloseTimer = setTimeout(() => {
    toolTipShow.value = false
    toolTipEl = null
    toolTipCloseTimer = undefined
  }, 100)
}
/** 列表内部滚动 / 窗口尺寸变化 → 气泡跟着当前行（反馈的"滚动时不跟手"） */
function followToolTip(): void {
  if (!toolTipShow.value || !toolTipEl || !toolTipEl.isConnected) return
  placeToolTip(toolTipEl)
}
onMounted(() => {
  window.addEventListener('scroll', followToolTip, true)
  window.addEventListener('resize', followToolTip)
})
onUnmounted(() => {
  if (toolTipOpenTimer) clearTimeout(toolTipOpenTimer)
  if (toolTipCloseTimer) clearTimeout(toolTipCloseTimer)
  window.removeEventListener('scroll', followToolTip, true)
  window.removeEventListener('resize', followToolTip)
})

/** MCP 总开关（④c）：true=启用（可调用所有「已启用」的 server 工具，启停在「工具」页管理）；false=该预设不注入任何 MCP。缺省 true。 */
const mcpOn = ref(true)
/** 当前实际可注入的 server 数（=启用中的），开关文案用 */
const mcpAvailableCount = computed(() => (agentPresetsStore.mcpServersView || []).filter((s: any) => s.enabled !== false).length)
/**
 * 该预设的 MCP 开关是否锁定不可改。
 * 0913 修正：原来锁的是「内置预设」（`builtin`）—— 但 UI 文案写的是「默认预设锁定」，
 * 逻辑与文案不符：**所有内置预设**（含「对话模式」这种零工具预设）都被锁成"必须有 MCP"，
 * 于是「对话模式」明明声明了 mcp:false 却关不掉。现在只锁「默认预设」，且**显式声明 mcp:false 的优先**。
 */
const mcpLocked = computed(() => {
  const p = presetToolEditing.value
  if (!p) return false
  if (p.mcp === false) return false // 显式声明关闭（对话模式）不被锁定
  return p.id === agentPresetsStore.defaultPresetId
})
function initMcpDraft(p: any) {
  // 显式声明关闭 MCP 的预设优先（否则「零工具纯对话」和「默认预设必有 MCP」互相打架）
  if (p?.mcp === false) { mcpOn.value = false; return }
  // 默认预设强制可用 MCP（开关锁定为开，不给关）
  if (p && p.id === agentPresetsStore.defaultPresetId) { mcpOn.value = true; return }
  mcpOn.value = p?.mcp !== false
}
function openPresetTools(id: string) {
  const p = agentPresetsStore.presets.find(x => x.id === id)
  if (!p) return
  initMcpDraft(p)
  toolDraft.value = new Set(p.tools || [])
  toolSaved.value = false
  toolError.value = ''
  presetToolId.value = id
}
/** 团队编排工具：普通预设勾选不生效（仅团队会话的 team-lead 挂载）——UI 黄条提示 */
const TEAM_ONLY_TOOLS = ['team_dispatch', 'bb_goal', 'bb_write', 'bb_read', 'team_info']
const teamToolsSelected = computed(() => TEAM_ONLY_TOOLS.filter(n => toolDraft.value.has(n)))
function toggleTool(name: string) {
  if (presetToolEditing.value?.builtin) return
  if (exclusiveTools.value.includes(name)) return
  if (toolDraft.value.has(name)) toolDraft.value.delete(name)
  else toolDraft.value.add(name)
  toolSaved.value = false
}
async function confirmPresetTools() {
  const p = presetToolEditing.value
  if (!p || p.builtin) return
  try {
    await agentPresetsStore.updateCustom(p.id, {
      tools: [...toolDraft.value],
      // ④c MCP 总开关：直接落 mcp 布尔（后端 writeAgentPreset 白名单已含 mcp）
      mcp: mcpOn.value,
    })
    toolSaved.value = true
    setTimeout(() => { presetToolId.value = null }, 700)
  } catch (e: any) {
    toolError.value = e?.message || t('agent.saveFail')
  }
}
function closePresetTools() {
  presetToolId.value = null
}

const presetViewed = computed(() => agentPresetsStore.presets.find(p => p.id === presetViewId.value) || null)
const presetEditing = computed(() => agentPresetsStore.presets.find(p => p.id === presetEditId.value) || null)
const builtinPresets = computed(() => agentPresetsStore.presets.filter(p => p.builtin))
/* ★1001 外部预设：自定义组排除外部（外部有自己的卡片区）；外部=带 engine 的 */
const customPresets = computed(() => agentPresetsStore.presets.filter(p => !p.builtin && !(p.engine && p.engine !== 'native')))

// ★1001 外部 agent：固定卡片（codex/zcode/dsh/opencode/hermes）+ 可拆装安装器 + 模型来源编辑
/* ★1001 四批：模型清单=先「获取」才显示（不摆假清单）——key 档走 /v1/models 真接口，
   login 档走它登录态的订阅 catalog（尽力）；取不到就手填。 */
const extDraft = reactive({ id: '', name: '', modelSource: 'own' as 'nis' | 'own', externalModel: '', error: '', apiKey: '', hasKey: false, keyNote: '', credMode: 'login' as 'login' | 'key', modelOptions: [] as string[], fetching: false, modelError: '' })
const extEditId = ref<string | null>(null)   // 编辑哪个外部预设（模型来源切换 + 凭据 + 它家模型）
function switchCredMode(mode: 'login' | 'key') {
  extDraft.credMode = mode
  extDraft.modelOptions = []      // 换凭据档=清单作废重取（两档货架不同）
  extDraft.modelError = ''
}
async function fetchExtModels() {
  extDraft.fetching = true
  extDraft.modelError = ''
  try {
    const r = await useChatStore().bridgeRpc('externalAgents.listModels', { id: extDraft.id, mode: extDraft.credMode })
    if (r?.ok && Array.isArray(r.models) && r.models.length) {
      extDraft.modelOptions = r.models
      if (!r.models.includes(extDraft.externalModel)) extDraft.externalModel = r.models[0]
    } else {
      extDraft.modelOptions = []
      extDraft.modelError = r?.error || '模型清单获取失败——请手填模型名'
    }
  } catch (e: any) {
    extDraft.modelOptions = []
    extDraft.modelError = e?.message || String(e)
  }
  extDraft.fetching = false
}
function openExternalEdit(p: { id: string; name: string; modelSource?: string; externalModel?: string }, hasKey?: boolean) {
  extDraft.error = ''
  extDraft.keyNote = ''
  extDraft.apiKey = ''
  extDraft.modelOptions = []
  extDraft.modelError = ''
  extDraft.fetching = false
  extDraft.id = p.id
  extDraft.name = p.name
  extDraft.modelSource = p.modelSource === 'nis' ? 'nis' : 'own'
  extDraft.credMode = hasKey ? 'key' : 'login'
  extDraft.externalModel = p.externalModel || ''
  extDraft.hasKey = !!hasKey
  extEditId.value = p.id
}
const extAgents = ref<any[]>([])
/* ★1001 六批：额度面板=实时拉官方套餐额度（已定案：不本地记账） */
const quotaFor = ref<any | null>(null)
const quotaRows = ref<Array<{ label: string; value: string }>>([])
const quotaLoading = ref(false)
const quotaError = ref('')
function openConsole(url?: string) { if (url) window.open(url, '_blank') }
async function loadQuota(a: any) {
  quotaLoading.value = true
  quotaError.value = ''
  quotaRows.value = []
  try {
    const r = await useChatStore().bridgeRpc('externalAgents.quota', { id: a.id })
    if (r?.ok && Array.isArray(r.rows) && r.rows.length) quotaRows.value = r.rows
    else quotaError.value = r?.error || ''
  } catch (e: any) { quotaError.value = e?.message || String(e) }
  quotaLoading.value = false
}
function openQuota(a: any) { quotaFor.value = a; void loadQuota(a) }
let extPollTimer: any = null
let extWasBusy = false
async function loadExtAgents() {
  try {
    const v = await useChatStore().bridgeRpc('externalAgents.list')
    extAgents.value = Array.isArray(v?.agents) ? v.agents : []
    const busy = extAgents.value.some(a => a.live)
    if (extWasBusy && !busy) agentPresetsStore.load()   // ★装完这一刻刷新预设列表（空态选择器立刻能选到）
    extWasBusy = busy
    if (busy && !extPollTimer) extPollTimer = setInterval(loadExtAgents, 2000)   // 安装中轮询进度
    if (!busy && extPollTimer) { clearInterval(extPollTimer); extPollTimer = null }
  } catch { /* ignore */ }
}
async function installExt(id: string) {
  try {
    const r = await useChatStore().bridgeRpc('externalAgents.install', { id })
    if (r?.error) console.warn('[externalAgents] install:', r.error)
  } catch (e) { console.warn('[externalAgents] install fail:', e) }
  await loadExtAgents()
}
async function uninstallExt(id: string) {
  try {
    const r = await useChatStore().bridgeRpc('externalAgents.uninstall', { id })
    if (r?.error) console.warn('[externalAgents] uninstall:', r.error)
    await agentPresetsStore.load()
  } catch (e) { console.warn('[externalAgents] uninstall fail:', e) }
  await loadExtAgents()
}
/* ★1001二批："用它的 API"档凭据 —— 登录（它自己的 OAuth，浏览器弹出）/ 直填 API Key（只存本地） */
async function loginExt(id: string) {
  try {
    const r = await useChatStore().bridgeRpc('externalAgents.login', { id })
    extDraft.keyNote = r?.ok ? '已启动登录：浏览器应已弹出，完成后回来即可' : (r?.error || '登录启动失败')
    if (!r?.ok) extDraft.error = r?.error || ''
  } catch (e: any) {
    extDraft.error = e?.message || String(e)
  }
}
async function saveExtKey(id: string, key: string) {
  try {
    const r = await useChatStore().bridgeRpc('externalAgents.setKey', { id, key })
    if (r?.ok) {
      extDraft.hasKey = !!key.trim()
      extDraft.apiKey = ''
      extDraft.keyNote = key.trim() ? 'API Key 已保存' : 'API Key 已清除（走登录态）'
      await loadExtAgents()
    } else {
      extDraft.error = r?.error || '保存失败'
    }
  } catch (e: any) {
    extDraft.error = e?.message || String(e)
  }
}
async function confirmExternalSave() {
  try {
    if (!extEditId.value) return
    await agentPresetsStore.updateCustom(extEditId.value, {
      name: extDraft.name, modelSource: extDraft.modelSource, externalModel: extDraft.externalModel,
    })
    extEditId.value = null
  } catch (e: any) {
    extDraft.error = e?.message || t('agent.saveFail')
  }
}
// 进「外部」tab 就拉一次安装清单（安装中自动轮询进度）
watch(activeTab, (v) => { if (v === 'external') loadExtAgents() })

// ── 团队编辑器（P1 配置层） ──
const teamEditor = ref(false)
const teamDeleteId = ref<string | null>(null)
const teamError = ref('')
/** 绑定该团队的会话数（删除提示用；conversations 持久化里有 teamId 的都算） */
function boundConvCount(teamId: string): number {
  const store = useConversationsStore()
  return store.conversations.filter((c: any) => c.teamId === teamId).length
}
const teamDraft = reactive({
  id: '',
  name: '',
  description: '',
  mainPreset: 'team-lead',
  mode: 'auto' as 'auto' | 'serial' | 'parallel',
  blackboard: true,
  maxParallel: 3,
  members: [] as Array<{ preset: string; role: string; modelMode: 'shared' | 'independent'; modelId: string; effort?: string; capability?: string; maxInstances?: number }>,
})

function presetNameOf(id: string): string {
  return agentPresetsStore.presets.find(p => p.id === id)?.name || id || t('agent.unknownName')
}
function presetDescriptionOf(id: string): string {
  return agentPresetsStore.presets.find(p => p.id === id)?.description || ''
}
/** 独立模型可选项：启用供应商下的启用文本模型（按供应商分组） */
const memberModelOptions = computed(() => {
  const out: Array<{ value: string; label: string; desc?: string; group?: string }> = []
  for (const p of providersStore.enabledProviders) {
    for (const mo of (providersStore.models[p.id] || []).filter(x => x.enabled)) {
      out.push({ value: mo.id, label: mo.name || mo.id, desc: mo.id, group: p.name })
    }
  }
  return out
})

watch(() => props.open, (v) => {
  if (v) teamsStore.load()
})

function openTeamEditor(t?: Team) {
  teamError.value = ''
  if (t) {
    teamDraft.id = t.id
    teamDraft.name = t.name
    teamDraft.description = t.description || ''
    teamDraft.mode = t.mode || 'auto'
    teamDraft.blackboard = t.blackboard !== false
    teamDraft.maxParallel = t.maxParallel || 3
    teamDraft.members = (t.members || []).map(m => ({
      preset: m.preset, role: m.role || '',
      modelMode: m.modelMode === 'independent' ? 'independent' : 'shared',
      modelId: m.modelId || '',
      /* ★0927 netfix：这三个字段原来没映 → 一进编辑器就丢、保存即清空 */
      capability: (m as any).capability || 'standard',
      maxInstances: (m as any).maxInstances || 1,
      effort: (m as any).effort || '',
    }))
  } else {
    teamDraft.id = ''
    teamDraft.name = ''
    teamDraft.description = ''
    teamDraft.mode = 'auto'
    teamDraft.blackboard = true
    teamDraft.maxParallel = 3
    teamDraft.members = []
  }
  teamEditor.value = true
}
function addTeamMember() {
  if (teamDraft.members.length >= 8) return
  const first = customPresets.value[0]
  if (!first) return
  teamDraft.members.push({ preset: first.id, role: '', modelMode: 'shared', modelId: '', capability: 'standard', maxInstances: 1 })
}
async function confirmTeamSave() {
  teamError.value = ''
  if (!teamDraft.name.trim()) { teamError.value = t('agent.teamNameRequired'); return }
  if (teamDraft.members.length === 0) { teamError.value = t('agent.teamMinMembers'); return }
  try {
    await teamsStore.saveTeam({ ...teamDraft, members: teamDraft.members.map(m => ({ ...m })) })
    teamEditor.value = null
  } catch (e: any) {
    teamError.value = e?.message || t('agent.saveFail')
  }
}
async function confirmTeamDelete() {
  if (!teamDeleteId.value) return
  try { await teamsStore.removeTeam(teamDeleteId.value) } catch (e: any) { console.error('[teams] delete failed:', e) }
  teamDeleteId.value = null
}

function openPresetView(id: string) {
  presetViewId.value = id
}
function closePresetView() {
  presetViewId.value = null
}
function beginPresetCopy(fromId: string) {
  const src = agentPresetsStore.presets.find(p => p.id === fromId)
  if (!src) return
  presetCopyFrom.value = fromId
  presetCopyError.value = ''
  // 自动建议唯一 id
  let n = 1
  let suggested = `${fromId}-copy`
  while (agentPresetsStore.presets.some(p => p.id === suggested)) {
    suggested = `${fromId}-copy-${++n}`
  }
  presetCopyDraft.id = suggested
  presetCopyDraft.name = t('agent.copyNameSuffix', { name: src.name })
}
function cancelPresetCopy() {
  presetCopyFrom.value = null
}
async function confirmPresetCopy() {
  if (!presetCopyFrom.value) return
  try {
    const created = await agentPresetsStore.duplicate(presetCopyFrom.value, presetCopyDraft.id, presetCopyDraft.name)
    if (!created) {
      presetCopyError.value = t('agent.duplicateFail')
      return
    }
    presetCopyFrom.value = null
  } catch (e: any) {
    presetCopyError.value = e?.message || t('agent.saveFail')
  }
}
function beginPresetCreate() {
  presetCopyFrom.value = '__new__'
  presetCopyError.value = ''
  let n = 1
  let suggested = `my-agent`
  while (agentPresetsStore.presets.some(p => p.id === suggested)) {
    suggested = `my-agent-${++n}`
  }
  presetCopyDraft.id = suggested
  presetCopyDraft.name = t('agent.myPresetDefault')
}
async function confirmPresetCreate() {
  try {
    const created = await agentPresetsStore.create(presetCopyDraft.id, presetCopyDraft.name)
    if (!created) {
      presetCopyError.value = t('agent.duplicateFail')
      return
    }
    presetCopyFrom.value = null
    // 0912：创建后直接打开编辑弹窗 —— 新建时只填了 id/名称，role 是默认模板，
    // 紧接着让用户改人设（否则要自己再去列表里找一次，多一步）
    openPresetEdit(created.id)
  } catch (e: any) {
    presetCopyError.value = e?.message || t('agent.saveFail')
  }
}
/* ══ ★1010（实测"自定义预设的头像不能换了"）════════════════════════════
   0927 拆除-B 把 PresetAvatarModal 连同头像编辑入口一起拆了 ⇒ 之后头像只能看不能改。
   这里补回**最小实现**（不再引入独立弹窗）：点卡片头像、或编辑弹窗里的「更换头像」→ 选图 →
   canvas 压到最大边 128px 的 JPEG（口径同 KnowledgeModal / NotebookModal 的既有实现）→
   updateCustom({ avatar }) 立即落库（store 的 updateCustom 白名单里本来就有 avatar，后端也存）。
   「恢复默认」写空串：avatarOf() 返回空 → 各处回退到首字母兜底头像。 */
const presetAvatarInput = ref<HTMLInputElement | null>(null)
const presetAvatarTarget = ref('')
const presetAvatarErr = ref('')

function pickPresetAvatar(id: string): void {
  presetAvatarErr.value = ''
  presetAvatarTarget.value = id
  presetAvatarInput.value?.click()
}

/** 图片文件 → 压缩 dataURL（最大边长 128px、JPEG 0.85；头像够用，也不会把 preset.json 撑大） */
function readAvatarAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const img = new Image()
      img.onload = () => {
        try {
          const scale = Math.min(1, 128 / Math.max(img.width, img.height))
          const cv = document.createElement('canvas')
          cv.width = Math.max(1, Math.round(img.width * scale))
          cv.height = Math.max(1, Math.round(img.height * scale))
          const ctx = cv.getContext('2d')
          if (!ctx) return resolve(String(reader.result || ''))
          ctx.drawImage(img, 0, 0, cv.width, cv.height)
          resolve(cv.toDataURL('image/jpeg', 0.85))
        } catch { resolve(String(reader.result || '')) }
      }
      img.onerror = () => reject(new Error('图片解码失败'))
      img.src = String(reader.result || '')
    }
    reader.onerror = () => reject(new Error('文件读取失败'))
    reader.readAsDataURL(file)
  })
}

async function onPresetAvatarPicked(e: Event): Promise<void> {
  const el = e.target as HTMLInputElement
  const file = el.files?.[0]
  el.value = ''                      // 清空 value，允许同一张图再选一次
  const id = presetAvatarTarget.value
  presetAvatarTarget.value = ''
  if (!file || !id) return
  try {
    await agentPresetsStore.updateCustom(id, { avatar: await readAvatarAsDataUrl(file) })
  } catch (err: any) {
    presetAvatarErr.value = String(err?.message || err || '头像保存失败')
    console.warn('[agent] 预设头像保存失败:', id, err?.message || err)
  }
}

/** 恢复默认头像（写空串 = 回退首字母兜底） */
async function clearPresetAvatar(id: string): Promise<void> {
  try { await agentPresetsStore.updateCustom(id, { avatar: '' }) }
  catch (err: any) { console.warn('[agent] 清除预设头像失败:', id, err?.message || err) }
}

function openPresetEdit(id: string) {
  const p = agentPresetsStore.presets.find(x => x.id === id)
  if (!p) return
  presetEditDraft.name = p.name
  presetEditDraft.description = p.description
  presetEditDraft.role = p.role
  presetEditId.value = id
}
function confirmPresetEdit() {
  if (!presetEditId.value) return
  const id = presetEditId.value
  agentPresetsStore.updateCustom(id, {
    name: presetEditDraft.name,
    description: presetEditDraft.description,
    role: presetEditDraft.role,
  }).catch((e: any) => console.error('[agentPresets] update failed:', e))
  presetEditId.value = null
}
function cancelPresetEdit() {
  presetEditId.value = null
}
function confirmPresetDelete() {
  if (!presetDeleteId.value) return
  agentPresetsStore.removeCustom(presetDeleteId.value).catch((e: any) => console.error('[agentPresets] remove failed:', e))
  presetDeleteId.value = null
}

// 弹窗开关动画（对齐 SkillsModal：dock 弹入/收起 + 底部圆形关闭钮）
const isAnimating = ref(false)
const isClosing = ref(false)
const showModal = ref(false)

watch(() => props.open, (v) => {
  if (v) {
    isClosing.value = false
    showModal.value = true
    isAnimating.value = true
    setTimeout(() => { isAnimating.value = false }, 450)
    // ⑤ 重新打开=回到顶层：清掉所有内层浮层（"弹窗中的弹窗"不残留）
    teamDeleteId.value = null
    presetDeleteId.value = null
    presetToolId.value = null
    presetViewId.value = null
    presetEditId.value = null
    presetCopyFrom.value = null
    teamEditor.value = false
    // 弹窗打开时刷新列表（后端文件可能被外部改动/拆装）
    agentPresetsStore.reload()
    void agentPresetsStore.loadToolCatalog() // MCP 总开关文案：可用服务数实时
  }
})

function close() {
  isClosing.value = true
  isAnimating.value = true
  setTimeout(() => {
    if (props.open && !isClosing.value) return  /*0927 netfix close-reopen-guard v3：正常关闭放行（isClosing 仍 true）；中途被重开（open watch 复位）则旧定时器作废 */
    showModal.value = false
    isAnimating.value = false
    isClosing.value = false
    emit('close')
  }, 300)
}

// Esc 关闭（document 级监听，与其他弹窗统一；仅弹窗打开时生效）
function onKeydown(e: KeyboardEvent) {
  if (e.key !== 'Escape' || !props.open) return
  // ⑤ 逐层关闭：先收内层浮层，无浮层时才关整个弹窗（重开回到顶层，不残留"弹窗中的弹窗"）
  if (teamDeleteId.value) { teamDeleteId.value = null; return }
  if (presetDeleteId.value) { presetDeleteId.value = null; return }
  if (teamEditor.value) { teamEditor.value = false; return }
  if (presetToolId.value) { closePresetTools(); return }
  if (presetViewId.value) { presetViewId.value = null; return }
  if (presetEditId.value) { presetEditId.value = null; return }
  if (presetCopyFrom.value) { presetCopyFrom.value = null; return }
  close()
}
onMounted(() => document.addEventListener('keydown', onKeydown))
onUnmounted(() => document.removeEventListener('keydown', onKeydown))
</script>

<template>
  <!-- ★1010：预设头像的隐藏文件框 —— 放这里（不依赖任何 v-if），卡片头像与编辑弹窗两处入口共用 -->
  <input ref="presetAvatarInput" type="file" accept="image/*" class="hidden" @change="onPresetAvatarPicked" />
  <!-- 遮罩（淡入淡出与其他弹窗统一） -->
  <Teleport to="body">
    <div
      v-if="showModal"
      :class="['fixed inset-0 z-40 bg-black/30', isClosing ? 'agent-backdrop-out' : 'agent-backdrop-in']"
    ></div>

    <!-- 点空白不关闭（与其他弹窗统一）：关闭走 Esc 或底部圆形 X -->
    <div v-if="showModal" class="fixed inset-0 z-50 flex items-start justify-center pt-[8vh]">
      <div class="relative flex flex-col items-center">
        <div
          :class="['agent-dock', isAnimating && !isClosing ? 'agent-dock-in' : '', isClosing ? 'agent-dock-out' : '']"
          class="w-[957px] max-w-[94vw] h-[82vh] flex flex-col bg-white rounded-[20px] shadow-[0_24px_70px_-20px_rgba(0,0,0,0.25)] border-[1.5px] border-gray-200 overflow-hidden"
        >
      <!-- 头部：标题行 + tab 行（0904 定稿统一：标题无分隔线，tab 与内容之间一条线） -->
      <div class="shrink-0">
        <div class="px-7 pt-6 pb-4">
          <h2 class="text-base font-bold text-gray-900 tracking-tight">{{ activeTab === 'presets' ? t('agent.titlePresets') : t('agent.titleTeams') }}</h2>
        </div>
        <div class="px-7 pb-4 border-b-[1.5px] border-gray-100">
          <SegTabs
            :model-value="activeTab"
            size="xs2"
            :options="[{ id: 'presets', label: t('agent.tabPresets') }, { id: 'teams', label: t('agent.tabTeams') }, { id: 'external', label: t('agent.tabExternal') }]"
            @update:model-value="activeTab = $event as 'presets' | 'teams' | 'external'"
          />
        </div>
      </div>

      <!-- ── Tab 1：预设 ── -->
      <div v-if="activeTab === 'presets'" class="flex-1 min-h-0 overflow-y-auto px-7 py-5">
        <p class="text-[12px] text-gray-400 mb-4">{{ t('agent.presetsHint') }}</p>

        <!-- 内置预设 -->
        <div class="flex items-center justify-between mb-2">
          <div class="text-[13px] font-[530] text-gray-900">{{ t('agent.builtinPresets') }}</div>
        </div>
        <ul class="grid grid-cols-2 gap-3 mb-6">
          <li v-for="p in builtinPresets" :key="p.id" class="rounded-xl border bg-white" :class="agentPresetsStore.isDefault(p.id) ? 'border-gray-900 shadow-sm' : 'border-gray-100'">
            <div class="flex items-start gap-2.5 px-3 pt-2.5">
              <!-- 0913 头像批：内置预设只读；显示已存头像或默认头像（不可编辑） -->
              <div class="flex-shrink-0 mt-0.5">
                <img v-if="p.avatar" :src="p.avatar" alt="" class="w-9 h-9 rounded-lg object-cover border border-gray-100" />
                <div v-else class="w-9 h-9 rounded-lg flex items-center justify-center text-white text-[14px] font-[640] border border-black/5" :style="avatarFallbackStyle(p)">{{ avatarInitialOf(p) }}</div>
              </div>
              <button type="button" class="flex-1 min-w-0 text-left pb-0.5 disabled:cursor-default" :disabled="agentPresetsStore.isDefault(p.id)" @click="agentPresetsStore.makeDefault(p.id)">
                <div class="flex items-center gap-2">
                  <span class="text-[13px] font-[530] text-gray-800">{{ presetDisplayName(p) }}</span>
                  <span class="text-[10px] px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-500">{{ t('agent.builtin') }}</span>
                  <span v-if="agentPresetsStore.isDefault(p.id)" class="text-[10px] px-1.5 py-0.5 rounded-full bg-gray-900 text-white">{{ t('agent.newSessionDefault') }}</span>
                </div>
                <p class="text-[11px] text-gray-500 mt-0.5 line-clamp-2">{{ presetDisplayDesc(p) }}</p>
                <code class="text-[10px] text-gray-300">{{ p.id }}</code>
              </button>
            </div>
            <div class="flex items-center gap-1 px-2 pb-2">
              <button class="btn btn-secondary btn-xs" :title="t('agent.viewContentTitle')" @click="openPresetView(p.id)">{{ t('agent.view') }}</button>
              <button class="btn btn-secondary btn-xs" :title="t('agent.viewToolsTitle')" @click="openPresetTools(p.id)">{{ t('agent.tools') }}</button>
              <button class="btn btn-secondary btn-xs" :title="t('agent.copyCreateTitle')" @click="beginPresetCopy(p.id)">{{ t('agent.copy') }}</button>
            </div>
          </li>
        </ul>

        <!-- 自定义预设 -->
        <div class="flex items-center justify-between mb-2">
          <div class="text-[13px] font-[530] text-gray-900">{{ t('agent.customPresetsCount', { n: customPresets.length }) }}</div>
          <button class="btn btn-primary btn-sm" @click="beginPresetCreate">{{ t('agent.createPreset') }}</button>
        </div>
        <div v-if="customPresets.length === 0" class="py-8 text-center rounded-xl border border-dashed border-gray-200">
          <p class="text-[12px] text-gray-400">{{ t('agent.customEmptyHint') }}</p>
        </div>
        <ul v-else class="grid grid-cols-2 gap-2.5">
          <li v-for="p in customPresets" :key="p.id" class="rounded-xl border bg-white" :class="agentPresetsStore.isDefault(p.id) ? 'border-gray-900 shadow-sm' : 'border-gray-100'">
            <div class="flex items-start gap-2.5 px-3 pt-2.5">
              <!-- 头像展示 + 更换（★1010：点击即换 —— 0927 拆除-B 拆掉的入口在这里补回最小实现） -->
              <div class="flex-shrink-0 mt-0.5 cursor-pointer" :title="t('agent.changeAvatar')" @click.stop="pickPresetAvatar(p.id)">
                <img v-if="p.avatar" :src="p.avatar" alt="" class="w-9 h-9 rounded-lg object-cover border border-gray-100 hover:border-gray-300 transition-colors" />
                <div v-else class="w-9 h-9 rounded-lg flex items-center justify-center text-white text-[14px] font-[640] border border-black/5 hover:opacity-90 transition-opacity" :style="avatarFallbackStyle(p)">{{ avatarInitialOf(p) }}</div>
              </div>
              <button type="button" class="flex-1 min-w-0 text-left pb-0.5 disabled:cursor-default" :disabled="agentPresetsStore.isDefault(p.id)" @click="agentPresetsStore.makeDefault(p.id)">
                <div class="flex items-center gap-2">
                  <span class="text-[13px] font-[530] text-gray-800">{{ presetDisplayName(p) }}</span>
                  <span class="text-[10px] px-1.5 py-0.5 rounded-full bg-indigo-50 text-indigo-500">{{ t('agent.custom') }}</span>
                  <span v-if="agentPresetsStore.isDefault(p.id)" class="text-[10px] px-1.5 py-0.5 rounded-full bg-gray-900 text-white">{{ t('agent.newSessionDefault') }}</span>
                </div>
                <p class="text-[11px] text-gray-500 mt-0.5 line-clamp-2">{{ presetDisplayDesc(p) }}</p>
                <code class="text-[10px] text-gray-300">{{ p.id }}</code>
              </button>
            </div>
            <div class="flex items-center gap-1 px-2 pb-2">
              <button class="btn btn-secondary btn-xs" :title="t('agent.edit')" @click="openPresetEdit(p.id)">{{ t('agent.edit') }}</button>
              <button class="btn btn-secondary btn-xs" :title="t('agent.viewToolsTitle')" @click="openPresetTools(p.id)">{{ t('agent.tools') }}</button>
              <button class="btn btn-secondary btn-xs" :title="t('agent.copyCreateTitle')" @click="beginPresetCopy(p.id)">{{ t('agent.copy') }}</button>
              <button class="ml-auto btn btn-danger btn-xs" :title="t('agent.delete')" @click="presetDeleteId = p.id">{{ t('agent.delete') }}</button>
            </div>
          </li>
        </ul>
      </div>

      <!-- ── Tab 2：团队（P1 配置层：CRUD + 编排设置；运行时 P2） ── -->
      <div v-else-if="activeTab === 'teams'" class="flex-1 min-h-0 overflow-y-auto px-7 py-5">
        <div class="flex items-center justify-between mb-3">
          <div class="flex items-center gap-2">
            <span class="text-[12px] font-[640] text-gray-600">{{ t('agent.myTeams') }}</span>
            <span class="text-[10px] text-gray-400 bg-white border border-gray-200 px-1.5 py-0.5 rounded-[5px]">{{ teamsStore.teams.length }}</span>
          </div>
          <button
            class="btn btn-primary btn-sm"
            :disabled="customPresets.length === 0"
            @click="openTeamEditor()"
          >{{ t('agent.newTeam') }}</button>
        </div>
        <div v-if="customPresets.length === 0" class="mb-3 px-3 py-2 rounded-lg bg-amber-50 border border-amber-100 text-[11px] text-amber-600">
          {{ t('agent.teamNeedCustomPrefix') }}<b>{{ t('agent.customPresets') }}</b>{{ t('agent.teamNeedCustomSuffix') }}
        </div>

        <!-- 团队卡片列表 -->
        <div v-if="teamsStore.teams.length === 0" class="py-10 text-center rounded-xl border border-dashed border-gray-200">
          <i class="fas fa-users text-2xl text-gray-200 mb-2"></i>
          <p class="text-[12px] text-gray-400">{{ t('agent.teamsEmpty') }}</p>
        </div>
        <ul v-else class="grid grid-cols-2 gap-2.5">
          <li v-for="tm in teamsStore.teams" :key="tm.id" class="rounded-xl border bg-white" :class="teamDraft.id === tm.id && teamEditor ? 'border-gray-900 shadow-sm' : 'border-gray-100'">
            <button type="button" class="w-full text-left px-3 py-2.5" @click="openTeamEditor(tm)">
              <div class="flex items-center gap-2 flex-wrap">
                <span class="text-[13px] font-[530] text-gray-800">{{ tm.name }}</span>
                <span class="text-[10px] px-1.5 py-0.5 rounded-full bg-indigo-50 text-indigo-500">{{ t('agent.commander') }}</span>
                <span class="text-[10px] px-1.5 py-0.5 rounded-full bg-gray-50 text-gray-500 border border-gray-200">{{ t('agent.memberCount', { n: tm.members.length }) }}</span>
                <span class="text-[10px] px-1.5 py-0.5 rounded-full bg-gray-50 text-gray-500 border border-gray-200">{{ tm.mode === 'auto' ? t('agent.modeAuto') : tm.mode === 'parallel' ? t('agent.modeParallel') : t('agent.modeSerial') }}</span>
                <span v-if="tm.blackboard" class="text-[10px] px-1.5 py-0.5 rounded-full bg-teal-50 text-teal-600 border border-teal-100">{{ t('agent.blackboardBadge') }}</span>
              </div>
              <p class="text-[11px] text-gray-500 mt-0.5 line-clamp-1">{{ tm.description }}</p>
              <div class="text-[10px] text-gray-300 mt-0.5 truncate">{{ t('agent.membersLine') }}{{ tm.members.map(m => presetNameOf(m.preset)).join(t('agent.listSep')) }}</div>
            </button>
            <div class="flex items-center gap-1 px-2 pb-2">
              <button class="btn btn-secondary btn-xs" @click="openTeamEditor(tm)">{{ t('agent.edit') }}</button>
              <button class="ml-auto btn btn-danger btn-xs" @click="teamDeleteId = tm.id">{{ t('agent.delete') }}</button>
            </div>
          </li>
        </ul>
      </div>

      <!-- 团队编辑器弹窗 -->
      <Teleport to="body">
        <div v-if="teamEditor" class="fixed inset-0 z-[10010] flex items-center justify-center bg-black/40" @click.self="teamEditor = null">
          <div class="w-[640px] max-h-[85vh] flex flex-col bg-white rounded-2xl shadow-2xl p-5">
            <div class="flex items-center justify-between mb-1">
              <h3 class="text-[14px] font-[640] text-gray-800">{{ teamDraft.id ? t('agent.editTeam') : t('agent.createTeam') }}</h3>
              <button class="p-1.5 rounded-lg text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors" @click="teamEditor = null"><i class="fas fa-xmark text-[14px]"></i></button>
            </div>
            <p class="text-[11px] text-gray-400 mb-3">{{ t('agent.teamEditorHint') }}</p>
            <div class="flex-1 min-h-0 overflow-y-auto custom-scroll space-y-3.5 pr-1">
              <!-- 基本信息 -->
              <div class="flex gap-3">
                <label class="block flex-1">
                  <span class="block text-[11px] text-gray-500 mb-1">{{ t('agent.teamName') }}</span>
                  <input v-model="teamDraft.name" type="text" class="w-full px-3 py-2 rounded-lg border border-gray-200 text-[12px] outline-none focus:border-blue-400" :placeholder="t('agent.teamNamePlaceholder')" />
                </label>
              </div>
              <label class="block">
                <span class="block text-[11px] text-gray-500 mb-1">{{ t('agent.teamDescLabel') }}</span>
                <input v-model="teamDraft.description" type="text" class="w-full px-3 py-2 rounded-lg border border-gray-200 text-[12px] outline-none focus:border-blue-400" :placeholder="t('agent.teamDescPlaceholder')" />
              </label>
              <!-- 编排设置 -->
              <div>
                <span class="block text-[11px] text-gray-500 mb-1.5">{{ t('agent.execModeLabel') }}</span>
                <div class="flex items-center gap-1.5">
                  <button
                    v-for="m in [{ id: 'auto', label: t('agent.modeAutoRecommended') }, { id: 'serial', label: t('agent.modeSerial') }, { id: 'parallel', label: t('agent.modeParallel') }]"
                    :key="m.id"
                    class="px-3 py-1.5 rounded-lg text-[11px] font-[530] border transition-colors"
                    :class="teamDraft.mode === m.id ? 'bg-gray-900 text-white border-gray-900' : 'bg-white text-gray-600 border-gray-200 hover:border-gray-400'"
                    @click="teamDraft.mode = m.id as any"
                  >{{ m.label }}</button>
                  <span class="text-[10px] text-gray-300 ml-1">{{ t('agent.execModeAutoHint') }}</span>
                </div>
              </div>
              <div class="flex items-center gap-4">
                <label class="flex items-center gap-2 text-[12px] text-gray-700 cursor-pointer select-none">
                  <input v-model="teamDraft.blackboard" type="checkbox" class="w-3.5 h-3.5 accent-gray-900" />
                  {{ t('agent.blackboardOption') }}
                </label>
                <label class="flex items-center gap-1.5 text-[12px] text-gray-700">
                  {{ t('agent.parallelBudget') }}
                  <select v-model.number="teamDraft.maxParallel" class="text-[12px] border border-gray-200 rounded-md px-1.5 py-1 bg-white outline-none focus:border-blue-400">
                    <option v-for="n in [1, 2, 3, 4, 5, 6]" :key="n" :value="n">{{ n }}</option>
                  </select>
                  <span class="text-[10px] text-gray-300">{{ t('agent.parallelBudgetHint') }}</span>
                </label>
              </div>
              <!-- 主指挥官（锁定展示） -->
              <div class="rounded-xl border border-gray-100 bg-gray-50 px-3 py-2.5">
                <div class="flex items-center gap-2">
                  <span class="text-[12px] font-[530] text-gray-800">{{ t('agent.mainCommander') }}</span>
                  <span class="text-[9px] px-1.5 py-px rounded-full bg-gray-200 text-gray-500">{{ t('agent.locked') }}</span>
                </div>
                <div class="text-[10px] text-gray-400 mt-0.5">{{ t('agent.commanderDuties') }}</div>
              </div>
              <!-- 成员列表 -->
              <div>
                <div class="flex items-center justify-between mb-1.5">
                  <span class="block text-[11px] text-gray-500">{{ t('agent.membersHeader') }}</span>
                  <button
                    class="btn btn-secondary btn-xs disabled:opacity-40"
                    :disabled="teamDraft.members.length >= 8 || customPresets.length === 0"
                    @click="addTeamMember"
                  >{{ t('agent.addMember') }}</button>
                </div>
                <div v-if="teamDraft.members.length === 0" class="py-4 text-center rounded-lg border border-dashed border-gray-200 text-[11px] text-gray-400">
                  {{ t('agent.membersEmpty') }}
                </div>
                <div v-for="(m, mi) in teamDraft.members" :key="mi" class="rounded-xl border border-gray-100 bg-white px-3 py-2.5 mb-2">
                  <div class="flex items-center gap-2 flex-wrap">
                    <!-- 0913 头像批：成员头像跟随其预设头像；未设置回退默认头像 -->
                    <span class="flex-shrink-0 inline-flex">
                      <img v-if="agentPresetsStore.avatarOf(m.preset)" :src="agentPresetsStore.avatarOf(m.preset)" alt="" class="w-6 h-6 rounded-md object-cover border border-gray-100" />
                      <span v-else class="w-6 h-6 rounded-md inline-flex items-center justify-center text-white text-[10px] font-[640]" :style="avatarFallbackStyle({ id: m.preset })">{{ (presetNameOf(m.preset) || '?').slice(0, 1) }}</span>
                    </span>
                    <MiniSelect
                      v-model="m.preset"
                      :options="customPresets.map(p => ({ value: p.id, label: p.name, desc: p.description, group: t('agent.customPresets') }))"
                      :placeholder="t('agent.selectPreset')"
                      width="w-[220px]"
                      drop-up
                    />
                    <span class="text-[10px] text-gray-300 font-mono">{{ m.preset }}</span>
                    <button class="ml-auto btn btn-danger btn-xs" @click="teamDraft.members.splice(mi, 1)">{{ t('agent.remove') }}</button>
                  </div>
                  <input
                    v-model="m.role"
                    type="text"
                    class="w-full mt-2 px-2.5 py-1.5 rounded-lg border border-gray-200 text-[12px] outline-none focus:border-blue-400"
                    :placeholder="t('agent.roleOverridePlaceholder', { desc: presetNameOf(m.preset) ? presetDescriptionOf(m.preset) : '' })"
                  />
                  <div class="flex items-center gap-2 mt-2">
                    <MiniSelect
                      v-model="m.modelMode"
                      :options="[{ value: 'shared', label: t('agent.modelShared'), desc: t('agent.modelSharedDesc') }, { value: 'independent', label: t('agent.modelIndependent'), desc: t('agent.modelIndependentDesc') }]"
                      width="w-[180px]"
                      drop-up
                    />
                    <MiniSelect
                      v-if="m.modelMode === 'independent'"
                      v-model="m.modelId"
                      class="flex-1 min-w-0"
                      :options="memberModelOptions"
                      :placeholder="t('agent.selectModel')"
                      drop-up
                    />
                  </div>
                  <!-- 0910 三批②/③：模型档位（主 agent 据此匹配任务难度）+ 该成员同时可派出的实例数上限 -->
                  <div class="flex items-center gap-2 mt-2">
                    <MiniSelect
                      v-model="m.capability"
                      :options="[
                        { value: 'fast', label: t('agent.capability.fast'), desc: t('agent.capability.fastDesc') },
                        { value: 'standard', label: t('agent.capability.standard'), desc: t('agent.capability.standardDesc') },
                        { value: 'strong', label: t('agent.capability.strong'), desc: t('agent.capability.strongDesc') },
                        { value: 'auto', label: t('agent.capability.auto'), desc: t('agent.capability.autoDesc') },
                      ]"
                      width="w-[150px]"
                    />
                    <MiniSelect
                      :model-value="String(m.maxInstances || 1)"
                      :options="[
                        { value: '1', label: t('agent.instances.n1'), desc: t('agent.instances.n1Desc') },
                        { value: '2', label: t('agent.instances.n2'), desc: t('agent.instances.n2Desc') },
                        { value: '3', label: t('agent.instances.n3'), desc: t('agent.instances.n3Desc') },
                      ]"
                      width="w-[150px]"
                      @update:model-value="(v) => (m.maxInstances = Number(v) || 1)"
                    />
                  </div>
                </div>
              </div>
              <p v-if="teamError" class="text-[11px] text-red-500">{{ teamError }}</p>
            </div>
            <div class="flex justify-end gap-2 mt-4 pt-3 border-t border-gray-100">
              <button class="btn btn-secondary btn-sm" @click="teamEditor = null">{{ t('agent.cancel') }}</button>
              <button class="btn btn-primary btn-sm" @click="confirmTeamSave">{{ t('agent.save') }}</button>
            </div>
          </div>
        </div>
      </Teleport>

      <!-- 删除团队确认弹窗（有活跃绑定会话时提示退化影响） -->
      <Teleport to="body">
        <div v-if="teamDeleteId" class="fixed inset-0 z-[10010] flex items-center justify-center bg-black/40" @click.self="teamDeleteId = null">
          <div class="w-[340px] bg-white rounded-2xl shadow-2xl p-6">
            <h3 class="text-[15px] font-[640] text-gray-800 mb-2">{{ t('agent.deleteTeamTitle') }}</h3>
            <p class="text-[13px] text-gray-500 leading-relaxed mb-2">{{ t('agent.deleteTeamConfirm', { name: teamsStore.teams.find(x => x.id === teamDeleteId)?.name || '' }) }}</p>
            <p v-if="boundConvCount(teamDeleteId) > 0" class="text-[12px] text-amber-600 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2 leading-relaxed mb-3">
              {{ t('agent.deleteTeamBound', { n: boundConvCount(teamDeleteId) }) }}
            </p>
            <div class="flex justify-end gap-2">
              <button class="btn btn-secondary btn-sm" @click="teamDeleteId = null">{{ t('agent.cancel') }}</button>
              <button class="btn btn-danger btn-sm" @click="confirmTeamDelete">{{ t('agent.delete') }}</button>
            </div>
          </div>
        </div>
      </Teleport>

      <!-- ── Tab 3：外部 agent（固定卡片 + 可拆装安装，★1001） ── -->
      <div v-if="activeTab === 'external'" class="flex-1 min-h-0 overflow-y-auto px-7 py-5">
        <p class="text-[12px] text-gray-400 mb-4">{{ t('agent.extInstallHint') }}</p>
        <ul class="grid grid-cols-2 gap-3">
          <li v-for="a in extAgents" :key="a.id" class="rounded-xl border bg-white flex flex-col" :class="a.installed ? 'border-emerald-200' : 'border-gray-200'">
            <div class="flex items-start gap-2.5 px-3 pt-2.5">
              <div class="flex-shrink-0 mt-0.5 w-9 h-9 rounded-lg overflow-hidden flex items-center justify-center bg-gray-900 text-white">
                <!-- ★1001：头像=它应用的 logo（与注册的预设头像同一数据源） -->
                <img v-if="a.logo" :src="a.logo" class="w-full h-full object-cover" alt="" />
                <i v-else class="fas fa-robot text-[13px]"></i>
              </div>
              <div class="flex-1 min-w-0">
                <div class="flex items-center gap-2">
                  <span class="text-[13px] font-[530] text-gray-800">{{ a.name }}</span>
                  <span class="text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-50 text-emerald-600">{{ a.engine }}</span>
                  <!-- ★1001二批：安装中=真进度条（百分比来自下载字节；无总量走动效条），phase 放 tooltip -->
                  <span v-if="a.live" class="inline-flex items-center gap-1.5" :title="a.live.phase">
                    <span class="w-20 h-1.5 rounded-full bg-gray-200 overflow-hidden">
                      <span class="block h-full rounded-full bg-indigo-500 transition-all duration-300"
                        :class="a.live.percent == null ? 'animate-pulse w-2/3' : ''"
                        :style="a.live.percent != null ? { width: a.live.percent + '%' } : {}"></span>
                    </span>
                    <span class="text-[10px] text-gray-500 tabular-nums">{{ a.live.percent != null ? a.live.percent + '%' : '' }}</span>
                  </span>
                  <span v-else-if="a.installed" class="text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-50 text-emerald-600">{{ t('agent.extInstalled') }} {{ a.version }}</span>
                  <span v-else-if="a.pendingSource" class="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-50 text-amber-600">{{ t('agent.extChannelPending') }}</span>
                  <span v-else class="text-[10px] px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-500">{{ t('agent.extNotInstalled') }}</span>
                </div>
                <p class="text-[11px] text-gray-500 mt-0.5 line-clamp-2">{{ a.desc }}</p>
                <p v-if="a.live?.error" class="text-[10px] text-red-500 mt-0.5 line-clamp-2">{{ t('agent.extInstallFailed') }}：{{ a.live.error }}</p>
                <code class="text-[10px] text-gray-300">{{ a.repo }}</code>
              </div>
            </div>
            <div class="flex items-center gap-1 px-2 pb-2 mt-auto">
              <button class="btn btn-xs" :class="a.pendingSource ? 'btn-secondary opacity-50' : 'btn-primary'"
                :disabled="!!a.pendingSource || !!a.live || a.installed" :title="a.pendingSource || ''"
                @click="installExt(a.id)">{{ t('agent.extInstall') }}</button>
              <template v-if="a.installed">
                <button class="btn btn-secondary btn-xs" :title="t('agent.extQuota')" @click="openQuota(a)">{{ t('agent.extQuota') }}</button>
                <button class="btn btn-secondary btn-xs" @click="openExternalEdit(agentPresetsStore.presets.find(p => p.id === a.id) || a, a.hasKey)">{{ t('agent.edit') }}</button>
                <button class="ml-auto btn btn-danger btn-xs" :disabled="!!a.live" @click="uninstallExt(a.id)">{{ t('agent.extUninstall') }}</button>
              </template>
            </div>
          </li>
        </ul>
      </div>

      <!-- 只读查看弹窗（内置） -->
      <Teleport to="body">
        <div v-if="presetViewed" class="fixed inset-0 z-[10010] flex items-center justify-center bg-black/40" @click.self="closePresetView">
          <div class="w-[520px] max-h-[70vh] flex flex-col bg-white rounded-2xl shadow-2xl p-5">
            <h3 class="text-[14px] font-[640] text-gray-800 mb-1">{{ t('agent.viewPrefix') }} · {{ presetDisplayName(presetViewed) }}</h3>
            <p class="text-[11px] text-gray-400 mb-3">{{ t('agent.roleIncrement') }}</p>
            <pre class="flex-1 overflow-auto whitespace-pre-wrap break-words text-[12px] text-gray-600 bg-gray-50 rounded-lg p-3 border border-gray-100">{{ presetViewed.role || t('agent.noRole') }}</pre>
            <div class="flex justify-end mt-4">
              <button class="btn btn-secondary btn-sm" @click="closePresetView">{{ t('agent.close') }}</button>
            </div>
          </div>
        </div>
      </Teleport>

      <!-- 复制/新建弹窗 -->
      <Teleport to="body">
        <div v-if="presetCopyFrom" class="fixed inset-0 z-[10010] flex items-center justify-center bg-black/40" @click.self="cancelPresetCopy">
          <div class="w-[420px] bg-white rounded-2xl shadow-2xl p-5">
            <h3 class="text-[14px] font-[640] text-gray-800 mb-1">{{ presetCopyFrom === '__new__' ? t('agent.createPresetTitle') : t('agent.copyPresetTitle') }}</h3>
            <p class="text-[11px] text-gray-400 mb-4">{{ presetCopyFrom === '__new__' ? t('agent.createPresetHint') : t('agent.copyPresetHint') }}</p>
            <label class="block mb-3">
              <span class="block text-[11px] text-gray-500 mb-1">{{ t('agent.presetIdLabel') }}</span>
              <input v-model="presetCopyDraft.id" type="text" spellcheck="false" class="w-full px-3 py-2 rounded-lg border border-gray-200 text-[13px] outline-none focus:border-blue-400" :placeholder="t('agent.presetIdPlaceholder')" />
            </label>
            <label class="block mb-4">
              <span class="block text-[11px] text-gray-500 mb-1">{{ t('agent.displayName') }}</span>
              <input v-model="presetCopyDraft.name" type="text" class="w-full px-3 py-2 rounded-lg border border-gray-200 text-[13px] outline-none focus:border-blue-400" :placeholder="t('agent.namePlaceholder')" />
            </label>
            <p v-if="presetCopyError" class="text-[11px] text-red-500 mb-3">{{ presetCopyError }}</p>
            <div class="flex justify-end gap-2">
              <button class="btn btn-secondary btn-sm" @click="cancelPresetCopy">{{ t('agent.cancel') }}</button>
              <button
                class="btn btn-primary btn-sm"
                :disabled="!presetCopyDraft.id.trim()"
                @click="presetCopyFrom === '__new__' ? confirmPresetCreate() : confirmPresetCopy()"
              >{{ t('agent.create') }}</button>
            </div>
          </div>
        </div>
      </Teleport>

      <!-- 编辑弹窗（自定义） -->
      <Teleport to="body">
        <div v-if="presetEditing" class="fixed inset-0 z-[10010] flex items-center justify-center bg-black/40" @click.self="cancelPresetEdit">
          <div class="w-[560px] max-h-[75vh] flex flex-col bg-white rounded-2xl shadow-2xl p-5">
            <h3 class="text-[14px] font-[640] text-gray-800 mb-4">{{ t('agent.editPrefix') }} · {{ presetDisplayName(presetEditing) }}</h3>
            <!-- ★1010：头像编辑（0927 拆掉后补回）——更换 / 恢复默认；选完**即时落库**，不必等下面「保存」 -->
            <div class="flex items-center gap-3 mb-3">
              <img v-if="presetEditing.avatar" :src="presetEditing.avatar" alt="" class="w-11 h-11 rounded-lg object-cover border border-gray-100" />
              <div v-else class="w-11 h-11 rounded-lg flex items-center justify-center text-white text-[16px] font-[640] border border-black/5" :style="avatarFallbackStyle(presetEditing)">{{ avatarInitialOf(presetEditing) }}</div>
              <div class="flex items-center gap-2">
                <button type="button" class="btn btn-secondary btn-xs" @click="pickPresetAvatar(presetEditing.id)">{{ t('agent.changeAvatar') }}</button>
                <button v-if="presetEditing.avatar" type="button" class="btn btn-secondary btn-xs" @click="clearPresetAvatar(presetEditing.id)">{{ t('agent.resetAvatar') }}</button>
              </div>
              <span class="text-[10px] text-gray-400">{{ t('agent.avatarHint') }}</span>
            </div>
            <p v-if="presetAvatarErr" class="text-[11px] text-red-500 mb-2">{{ presetAvatarErr }}</p>
            <label class="block mb-3">
              <span class="block text-[11px] text-gray-500 mb-1">{{ t('agent.displayName') }}</span>
              <input v-model="presetEditDraft.name" type="text" class="w-full px-3 py-2 rounded-lg border border-gray-200 text-[13px] outline-none focus:border-blue-400" />
            </label>
            <label class="block mb-3">
              <span class="block text-[11px] text-gray-500 mb-1">{{ t('agent.description') }}</span>
              <input v-model="presetEditDraft.description" type="text" class="w-full px-3 py-2 rounded-lg border border-gray-200 text-[13px] outline-none focus:border-blue-400" />
            </label>
            <label class="block mb-4 flex-1 min-h-0 flex flex-col">
              <span class="block text-[11px] text-gray-500 mb-1">{{ t('agent.roleIncrement') }}</span>
              <textarea v-model="presetEditDraft.role" rows="10" class="flex-1 w-full px-3 py-2 rounded-lg border border-gray-200 text-[13px] font-mono outline-none focus:border-blue-400 resize-none"></textarea>
            </label>
            <div class="flex justify-end gap-2">
              <button class="btn btn-secondary btn-sm" @click="cancelPresetEdit">{{ t('agent.cancel') }}</button>
              <button class="btn btn-primary btn-sm" @click="confirmPresetEdit">{{ t('agent.save') }}</button>
            </div>
          </div>
        </div>
      </Teleport>

      <!-- ★1001 六批：额度面板=实时拉官方套餐额度（不本地记账）+ 官方用量页直达 -->
      <Teleport to="body">
        <div v-if="quotaFor" class="fixed inset-0 z-[10010] flex items-center justify-center bg-black/40" @click.self="quotaFor = null">
          <div class="w-[380px] bg-white rounded-2xl shadow-2xl p-5">
            <h3 class="text-[14px] font-[640] text-gray-800 mb-1">{{ t('agent.extQuotaTitle') }} · {{ quotaFor.name }}</h3>
            <p class="text-[11px] text-gray-400 mb-3">{{ t('agent.extQuotaLive') }}</p>
            <div v-if="quotaLoading" class="flex items-center gap-2 text-[11px] text-gray-400 mb-3">
              <i class="fas fa-spinner fa-spin"></i>{{ t('agent.extQuotaFetching') }}
            </div>
            <template v-else-if="quotaRows.length">
              <div class="rounded-lg border border-gray-100 divide-y divide-gray-500/10 mb-3 max-h-48 overflow-y-auto">
                <div v-for="row in quotaRows" :key="row.label" class="flex items-center justify-between px-3 py-1.5">
                  <span class="text-[10px] text-gray-500 truncate mr-3">{{ row.label }}</span>
                  <span class="text-[12px] font-[560] text-gray-800 tabular-nums">{{ row.value }}</span>
                </div>
              </div>
            </template>
            <p v-else class="text-[11px] text-amber-600 mb-3">{{ quotaError || t('agent.extQuotaNoApi') }}</p>
            <div class="flex justify-end gap-2">
              <button class="btn btn-secondary btn-sm" :disabled="quotaLoading" @click="loadQuota(quotaFor)">{{ t('agent.extQuotaRefresh') }}</button>
              <button class="btn btn-secondary btn-sm" @click="quotaFor = null">{{ t('agent.cancel') }}</button>
              <button class="btn btn-primary btn-sm" @click="openConsole(quotaFor.consoleUrl)">{{ t('agent.extQuotaOfficial') }}</button>
            </div>
          </div>
        </div>
      </Teleport>

      <!-- ★1001 外部预设：新建/编辑弹窗 -->
      <Teleport to="body">
        <div v-if="extEditId" class="fixed inset-0 z-[10010] flex items-center justify-center bg-black/40" @click.self="extEditId = null">
          <div class="w-[420px] bg-white rounded-2xl shadow-2xl p-5">
            <h3 class="text-[14px] font-[640] text-gray-800 mb-1">{{ t('agent.edit') }}</h3>
            <p class="text-[11px] text-gray-400 mb-4">{{ t('agent.externalHint') }}</p>
            <!-- ★1001二批：显示名称去掉（固定卡片名即产品名，不给改） -->
            <div class="mb-3">
              <span class="block text-[11px] text-gray-500 mb-1">{{ t('agent.engineLabel') }}</span>
              <div class="flex items-center gap-2">
                <span class="text-[12px] px-2 py-1 rounded-lg bg-gray-900 text-white">Codex</span>
                <span class="text-[10px] text-gray-400">{{ t('agent.externalBadge') }}</span>
              </div>
            </div>
            <!-- ★1001 核心开关：模型来源（跟随NIS/用自己的API）——对话窗口的模型下拉跟着它变 -->
            <div class="mb-3">
              <span class="block text-[11px] text-gray-500 mb-1">{{ t('agent.modelSourceLabel') }}</span>
              <div class="flex items-center gap-2">
                <button type="button" class="px-3 py-1.5 rounded-lg text-[12px] border transition-colors"
                  :class="extDraft.modelSource === 'nis' ? 'bg-gray-900 text-white border-gray-900' : 'bg-white text-gray-600 border-gray-200'"
                  @click="extDraft.modelSource = 'nis'">{{ t('agent.sourceNis') }}</button>
                <button type="button" class="px-3 py-1.5 rounded-lg text-[12px] border transition-colors"
                  :class="extDraft.modelSource === 'own' ? 'bg-gray-900 text-white border-gray-900' : 'bg-white text-gray-600 border-gray-200'"
                  @click="extDraft.modelSource = 'own'">{{ t('agent.sourceOwn') }}</button>
              </div>
              <p class="text-[10px] text-gray-400 mt-1">{{ extDraft.modelSource === 'nis' ? '模型与 key 用 NIS 的（对话窗口选模型）' : '用它自己的配置/订阅（~/.codex）' }}</p>
            </div>
            <!-- ★1001 三批：凭据在前（先登录/填 Key 才能用对应模型），登录⇄Key 是切换的两档 -->
            <div v-if="extDraft.modelSource === 'own'" class="mb-3">
              <span class="block text-[11px] text-gray-500 mb-1">{{ t('agent.extCredentials') }}</span>
              <div class="flex items-center gap-2 mb-2">
                <button type="button" class="px-3 py-1.5 rounded-lg text-[12px] border transition-colors"
                  :class="extDraft.credMode === 'login' ? 'bg-gray-900 text-white border-gray-900' : 'bg-white text-gray-600 border-gray-200'"
                  @click="switchCredMode('login')">{{ t('agent.extCredLogin') }}</button>
                <button type="button" class="px-3 py-1.5 rounded-lg text-[12px] border transition-colors"
                  :class="extDraft.credMode === 'key' ? 'bg-gray-900 text-white border-gray-900' : 'bg-white text-gray-600 border-gray-200'"
                  @click="switchCredMode('key')">{{ t('agent.extCredKey') }}</button>
              </div>
              <!-- 档一：订阅登录（它自己的 OAuth） -->
              <template v-if="extDraft.credMode === 'login'">
                <div class="flex items-center gap-2">
                  <button type="button" class="btn btn-secondary btn-sm" @click="loginExt(extDraft.id)">{{ t('agent.extLogin') }}</button>
                  <span class="text-[10px] text-gray-400">{{ t('agent.extLoginHint') }}</span>
                </div>
              </template>
              <!-- 档二：直填 API Key -->
              <template v-else>
                <div class="flex items-center gap-2">
                  <input v-model="extDraft.apiKey" type="password" autocomplete="off"
                    :placeholder="extDraft.hasKey ? t('agent.extKeySet') : t('agent.extKeyPlaceholder')"
                    class="flex-1 px-3 py-2 rounded-lg border border-gray-200 text-[13px] outline-none focus:border-gray-400" />
                  <button type="button" class="btn btn-secondary btn-sm" @click="saveExtKey(extDraft.id, extDraft.apiKey)">{{ t('agent.extSaveKey') }}</button>
                </div>
              </template>
              <p v-if="extDraft.keyNote" class="text-[10px] text-emerald-600 mt-1">{{ extDraft.keyNote }}</p>
            </div>
            <!-- ★1001 四批：模型=先「获取」才显示清单（拿不到=手填，不摆假清单）；下拉用自家 MiniSelect（深色适配） -->
            <label v-if="extDraft.modelSource === 'own'" class="block mb-3">
              <span class="block text-[11px] text-gray-500 mb-1">{{ t('agent.externalModelLabel') }}</span>
              <div class="flex items-center gap-2 mb-2">
                <button type="button" class="btn btn-secondary btn-sm" :disabled="extDraft.fetching" @click="fetchExtModels">
                  {{ extDraft.fetching ? t('agent.extFetching') : t('agent.extFetchModels') }}
                </button>
                <span class="text-[10px] text-gray-400">{{ extDraft.credMode === 'login' ? t('agent.extFetchLoginHint') : t('agent.extFetchKeyHint') }}</span>
              </div>
              <MiniSelect v-if="extDraft.modelOptions.length"
                :model-value="extDraft.externalModel"
                :options="extDraft.modelOptions.map(m => ({ value: m, label: m }))"
                :disabled="extDraft.credMode === 'key' && !extDraft.hasKey"
                @update:model-value="extDraft.externalModel = $event" />
              <input v-else v-model="extDraft.externalModel" type="text"
                :placeholder="t('agent.extModelManual')"
                :disabled="extDraft.credMode === 'key' && !extDraft.hasKey"
                class="w-full px-3 py-2 rounded-lg border border-gray-200 text-[13px] outline-none focus:border-gray-400 disabled:opacity-50" />
              <p v-if="extDraft.modelError" class="text-[10px] text-amber-600 mt-1">{{ extDraft.modelError }}</p>
              <p v-if="extDraft.credMode === 'key' && !extDraft.hasKey" class="text-[10px] text-amber-600 mt-1">{{ t('agent.extKeyFirst') }}</p>
            </label>
            <p v-if="extDraft.error" class="text-[11px] text-red-500 mb-2">{{ extDraft.error }}</p>
            <div class="flex justify-end gap-2">
              <button class="btn btn-secondary btn-sm" @click="extEditId = null">{{ t('agent.cancel') }}</button>
              <button class="btn btn-primary btn-sm" @click="confirmExternalSave">{{ t('agent.save') }}</button>
            </div>
          </div>
        </div>
      </Teleport>

      <!-- 删除确认弹窗 -->
      <Teleport to="body">
        <div v-if="presetDeleteId" class="fixed inset-0 z-[10010] flex items-center justify-center bg-black/40" @click.self="presetDeleteId = null">
          <div class="w-[340px] bg-white rounded-2xl shadow-2xl p-6">
            <h3 class="text-[15px] font-[640] text-gray-800 mb-2">{{ t('agent.deletePresetTitle') }}</h3>
            <p class="text-[13px] text-gray-500 leading-relaxed mb-5">{{ t('agent.deletePresetConfirm', { name: agentPresetsStore.presets.find(x => x.id === presetDeleteId)?.name || '' }) }}</p>
            <div class="flex justify-end gap-2">
              <button class="btn btn-secondary btn-sm" @click="presetDeleteId = null">{{ t('agent.cancel') }}</button>
              <button class="btn btn-danger btn-sm" @click="confirmPresetDelete">{{ t('agent.delete') }}</button>
            </div>
          </div>
        </div>
      </Teleport>

      <!-- 工具清单/配置弹窗 -->
      <Teleport to="body">
        <div v-if="presetToolEditing" class="fixed inset-0 z-[10010] flex items-center justify-center bg-black/40" @click.self="closePresetTools">
          <div class="w-[560px] max-h-[75vh] flex flex-col bg-white rounded-2xl shadow-2xl p-5">
            <div class="flex items-center justify-between mb-1">
              <h3 class="text-[14px] font-[640] text-gray-800">{{ t('agent.toolsPrefix') }} · {{ presetDisplayName(presetToolEditing) }}</h3>
              <div class="flex items-center gap-2">
                <span class="text-[11px] text-gray-400">{{ t('agent.enabledCount', { n: toolDraft.size + exclusiveTools.filter(n => !toolDraft.has(n)).length }) }}</span>
                <button class="p-1.5 rounded-lg text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors" :title="t('agent.close')" @click="closePresetTools"><i class="fas fa-xmark text-[13px]"></i></button>
              </div>
            </div>
            <p class="text-[11px] text-gray-400 mb-3">
              {{ presetToolEditing.builtin ? t('agent.toolsBuiltinHint') : t('agent.toolsCustomHint') }}
            </p>
            <!-- 团队工具勾选提示：普通预设勾选团队指挥官工具不生效（团队工具仅团队会话挂载） -->
            <div v-if="teamToolsSelected" class="mb-2 px-3 py-1.5 rounded-lg bg-amber-50 border border-amber-100 text-amber-600 text-[11px] leading-relaxed">
              {{ t('agent.teamToolsWarning', { tools: teamToolsSelected.join('、') }) }}
            </div>
            <div v-if="toolSaved" class="mb-2 px-3 py-1.5 rounded-lg bg-green-50 text-green-600 text-[12px]">{{ t('agent.saved') }}</div>
            <p v-if="toolError" class="mb-2 px-3 py-1.5 rounded-lg bg-red-50 text-red-500 text-[12px]">{{ toolError }}</p>
            <div class="flex-1 min-h-0 overflow-y-auto overflow-x-hidden custom-scroll">
              <div v-for="g in toolGroups" :key="g.name" class="mb-3">
                <div class="text-[11px] font-[530] text-gray-500 mb-1.5 px-1">{{ t(g.name) }}</div>
                <div class="space-y-0.5">
                  <label
                    v-for="tool in g.tools"
                    :key="tool.name"
                    class="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-gray-50 cursor-pointer transition-colors"
                    :class="presetToolEditing.builtin ? 'cursor-default hover:bg-transparent' : ''"
                    @mouseenter="openToolTip($event.currentTarget as HTMLElement, tool.name, tool.description)"
                    @mouseleave="scheduleToolTipClose"
                  >
                    <input
                      type="checkbox"
                      class="w-3.5 h-3.5 accent-gray-900 disabled:accent-gray-300 shrink-0"
                      :checked="tool.checked"
                      :disabled="presetToolEditing.builtin || tool.locked"
                      @change="toggleTool(tool.name)"
                    />
                    <!-- 0912 反馈：名称/介绍过长必须截断（原来 inline span 吃不到 truncate，
                         长工具名会把容器撑出横向滚动条）。名称占位封顶 45%，介绍吃剩余并省略；
                         完整信息走整行 title 悬停查看。 -->
                    <div class="flex-1 min-w-0 flex items-center gap-1.5">
                      <span class="text-[12px] font-[530] text-gray-700 truncate max-w-[45%] shrink-0">{{ tool.name }}</span>
                      <span v-if="tool.locked" class="text-[9px] px-1.5 py-px rounded-full bg-indigo-50 text-indigo-500 shrink-0">{{ t(tool.exclusiveLabel || 'agent.exclusiveDefault') }}</span>
                      <span class="text-[10px] text-gray-400 truncate min-w-0 flex-1">{{ tool.description }}</span>
                    </div>
                  </label>
                </div>
              </div>

              <!-- MCP 总开关（④c 简化）：开启=可调用所有"已启用∧已选择"的 MCP；关闭=本预设不注入任何 MCP。
                   具体选用哪些 server 在「工具」页服务复选里管理，这里不再逐一勾选。 -->
              <div class="mt-1 pt-3 border-t border-gray-100">
                <div class="flex items-center gap-3 px-1 py-1.5">
                  <div class="flex-1 min-w-0">
                    <div class="flex items-center gap-2">
                      <span class="text-[12px] font-[530] text-gray-700">{{ t('agent.mcpEnableLabel') }}</span>
                      <span v-if="mcpOn" class="text-[10px] px-1.5 py-px rounded-full bg-gray-100 text-gray-500">{{ t('agent.mcpAvailable', { n: mcpAvailableCount }) }}</span>
                      <span v-if="mcpLocked" class="text-[9px] px-1.5 py-px rounded-full bg-amber-50 text-amber-600 border border-amber-100">{{ t('agent.mcpLockedBadge') }}</span>
                    </div>
                    <p class="text-[10px] text-gray-400 mt-0.5 leading-snug">
                      {{ mcpLocked ? t('agent.mcpHintLocked') : t('agent.mcpHintOnOff') }}
                    </p>
                  </div>
                  <BwSwitch :model-value="mcpOn" :disabled="mcpLocked" @update:model-value="(v: boolean) => { if (!mcpLocked) { mcpOn = v; toolSaved = false } }" />
                </div>
              </div>
            </div>
            <div class="flex justify-end gap-2 mt-4">
              <button class="btn btn-secondary btn-sm" @click="closePresetTools">{{ t('agent.close') }}</button>
              <button
                v-if="!presetToolEditing.builtin"
                class="btn btn-primary btn-sm"
                @click="confirmPresetTools"
              >{{ t('agent.save') }}</button>
            </div>
          </div>
        </div>
      </Teleport>

      <!-- 工具行悬停气泡：Teleport 到 body（跳出行内 overflow 裁切），深色气泡与 HintTip 同款语言 -->
      <Teleport to="body">
        <Transition name="tool-tip">
          <div
            v-if="toolTipShow"
            class="fixed z-[10050] bg-gray-900 text-white text-[11px] leading-relaxed rounded-xl shadow-2xl px-3.5 py-2.5 pointer-events-none"
            :style="{ left: toolTipPos.left + 'px', bottom: toolTipPos.bottom + 'px', maxWidth: 'min(420px, calc(100vw - 16px))' }"
          >{{ toolTipText }}</div>
        </Transition>
      </Teleport>
      </div>

      <!-- 底部圆形关闭钮（与 SkillsModal/SettingsModal 同款：浮起弹出 + 收起动画） -->
      <button
        @click="close"
        :class="['agent-close-btn', isAnimating && !isClosing ? 'agent-close-in' : '', isClosing ? 'agent-close-out' : '']"
        class="w-9 h-9 flex items-center justify-center bg-white border border-gray-200 text-gray-400 hover:text-gray-600 hover:shadow-md rounded-full shadow-sm mt-4"
      >
        <i class="fas fa-times text-sm"></i>
      </button>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
/* 关闭动画（对齐 SkillsModal/SettingsModal：dock 弹入收起 + 底部圆钮浮起） */
.agent-backdrop-in { animation: agentBackdropIn 0.3s ease forwards; }
.agent-backdrop-out { animation: agentBackdropOut 0.3s ease forwards; }
@keyframes agentBackdropIn { from { opacity: 0; } to { opacity: 1; } }
@keyframes agentBackdropOut { from { opacity: 1; } to { opacity: 0; } }

.agent-dock-in { animation: agentDockIn 0.45s cubic-bezier(0.34, 1.6, 0.64, 1) forwards; }
.agent-dock-out { animation: agentDockOut 0.3s cubic-bezier(0.4, 0, 0.2, 1) forwards; }
@keyframes agentDockIn {
  0% { opacity: 0; transform: scale(0.05) rotateX(8deg) translateY(-20px); transform-origin: top left; filter: blur(4px); }
  50% { opacity: 1; filter: blur(0); }
  70% { transform: scale(1.02) rotateX(-1deg) translateY(0); }
  100% { opacity: 1; transform: scale(1) rotateX(0) translateY(0); filter: blur(0); }
}
@keyframes agentDockOut {
  0% { opacity: 1; transform: scale(1) rotateX(0) translateY(0); filter: blur(0); }
  100% { opacity: 0; transform: scale(0.05) rotateX(8deg) translateY(-20px); transform-origin: top left; filter: blur(4px); }
}

.agent-close-in { animation: agentCloseIn 0.5s cubic-bezier(0.34, 1.6, 0.64, 1) 0.3s both; }
.agent-close-out { animation: agentCloseOut 0.2s cubic-bezier(0.4, 0, 1, 1) both; }
@keyframes agentCloseIn {
  0% { opacity: 0; transform: translateY(40px); }
  60% { opacity: 1; transform: translateY(-6px); }
  100% { transform: translateY(0); }
}
@keyframes agentCloseOut {
  0% { opacity: 1; transform: translateY(0); }
  100% { opacity: 0; transform: translateY(40px); }
}

/* 工具行悬停气泡（深色，与 HintTip / .qb-tip 同语言）：120ms 内快速淡入 */
.tool-tip-enter-active { transition: opacity 0.14s ease, transform 0.14s ease; }
.tool-tip-leave-active { transition: opacity 0.1s ease; }
.tool-tip-enter-from { opacity: 0; transform: translateY(3px); }
.tool-tip-leave-to { opacity: 0; }

</style>
