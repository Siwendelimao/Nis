<script setup lang="ts">
import { ref, computed, reactive, watch, onMounted, onUnmounted } from 'vue'
import { ChevronDown, Check, Plug, X } from 'lucide-vue-next'
import { t } from '@/utils/i18n'
import { useChatStore } from '@/stores/chat'
import { useAgentPresetsStore } from '@/stores/agentPresets'
import { toolIconComponent, toolRunningLoader, hasRunningAnim } from '@/utils/toolIcons'
import SegTabs from './blocks/SegTabs.vue'

const agentPresetsStore = useAgentPresetsStore()

const props = defineProps<{
  open: boolean
}>()

const emit = defineEmits<{
  close: []
}>()

const chatStore = useChatStore()

const isAnimating = ref(false)
const isClosing = ref(false)
const showModal = ref(false)

watch(() => props.open, (val) => {
  if (val) {
    isClosing.value = false
    showModal.value = true
    isAnimating.value = true
    setTimeout(() => { isAnimating.value = false }, 450)
    // 重新打开=干净一级视图：清掉所有上级/内层浮层（⑤"弹窗中的弹窗"不残留）
    hoveredTool.value = null
    mcpRemoveTarget.value = null
    wsModalOpen.value = false; wsKeyInputFor.value = null; wsNotice.value = null
    mcpToolsModal.value = null
    customEditor.value = null
    loadWebSearchConfig()
    loadMcpRecords()
    loadCustomTools()
    void agentPresetsStore.loadToolCatalog()  // registry 实时（含 MCP 最新连接态）
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

function handleKeydown(e: KeyboardEvent) {
  if (e.key !== 'Escape' || !props.open) return
  // 逐层关闭：先收最内层浮层，无浮层时才关整个弹窗（⑤：ESC 关顶层，重开恢复上一级）
  if (mcpRemoveTarget.value) { mcpRemoveTarget.value = null; return }
  if (wsModalOpen.value) { closeWsModal(); return }
  if (mcpToolsModal.value) { mcpToolsModal.value = null; return }
  if (customEditor.value) { customEditor.value = null; return }
  close()
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
}

onMounted(() => {
  document.addEventListener('keydown', handleKeydown)
})

onUnmounted(() => {
  document.removeEventListener('keydown', handleKeydown)
})

/** 当前 tab：system（系统工具）/ special（特殊工具）/ plugin（工具=插件） */
const activeTab = ref<'system' | 'special' | 'plugin'>('system')

/** 系统/特殊工具 tab = 工具唯一源投影（0904 捋顺）：数据来自后端 agentPreset.tools registry
 * （含 MCP/自定义动态合并，此处只渲染内置项；MCP 在「MCP 工具」tab 按 server 管理）。
 * 卡片图标与过程块同源：有"过程态+完成态"的工具（非瞬时）直接播放过程动画，其余显示完成态线性图标。 */
const toolGroups = computed(() => {
  const rows: Array<{ name: string; tab: 'system' | 'special'; tools: any[] }> = []
  const byKey = new Map<string, { name: string; tab: 'system' | 'special'; tools: any[] }>()
  for (const tool of agentPresetsStore.toolCatalog as any[]) {
    if (tool.source === 'mcp') continue
    const tab: 'system' | 'special' = tool.tab === 'special' ? 'special' : 'system'
    const gk = tab + '|' + (tool.group || t('plugins.groupOther'))
    if (!byKey.has(gk)) { const g = { name: tool.group || t('plugins.groupOther'), tab, tools: [] as any[] }; byKey.set(gk, g); rows.push(g) }
    byKey.get(gk)!.tools.push({
      name: tool.name,
      label: tool.label || tool.name,
      desc: tool.description || '',
      variant: tool.variant || 'others',
      risky: !!tool.risky,
      gating: tool.gating || '',
      selectable: tool.name === 'web_search',
    })
  }
  return rows
})

// ── 联网搜索引擎选择（web_search 工具卡点击展开；单选即生效） ──
interface SearchEngineOption {
  id: string
  name: string
  desc: string
}
/** 引擎选项（name 为品牌名；desc 存 i18n key，渲染处 t() 解析） */
const SEARCH_ENGINES: SearchEngineOption[] = [
  { id: 'bing', name: 'Bing', desc: 'plugins.wsBingDesc' },   // ★1010v：免 Key + 国内直连（DDG 已被反爬拦，实测解析 0 条）
  { id: 'duckduckgo', name: 'DuckDuckGo', desc: 'plugins.wsDdgDesc' },
  { id: 'tavily', name: 'Tavily', desc: 'plugins.wsTavilyDesc' },
  { id: 'brave', name: 'Brave Search', desc: 'plugins.wsBraveDesc' },
  { id: 'serper', name: 'Serper', desc: 'plugins.wsSerperDesc' },
]
const wsEngine = ref('duckduckgo')
const wsKeys = ref<Record<string, string>>({})
// 0908五：网络出口可切换（direct=本机IP直连 / proxy=走代理）+ 已存 key 重填入口
const wsNetworkMode = ref<'direct' | 'proxy'>('direct')
const wsProxyUrl = ref('')
const wsModalOpen = ref(false)
const wsKeyInputFor = ref<string | null>(null)
const wsKeyDraft = ref('')
const wsSwitching = ref(false)
const wsNotice = ref<{ ok: boolean; msg: string } | null>(null)

async function loadWebSearchConfig() {
  try {
    const cfg = await chatStore.bridgeRpc('websearch.getConfig')
    if (cfg) {
      wsEngine.value = cfg.provider || 'duckduckgo'
      wsKeys.value = { ...(cfg.apiKeys || {}) }
      wsNetworkMode.value = cfg.networkMode === 'proxy' ? 'proxy' : 'direct'
      wsProxyUrl.value = cfg.proxyUrl || ''
    }
  } catch (e) {
    console.error('[Plugins] websearch config load failed:', e)
  }
}

/** 卡片悬停显过程态（②）：有"过程态≠完成态"两种图标的工具，默认显示完成态线性图标，悬停播放过程态动画 */
const hoveredTool = ref<string | null>(null)
function cardVisual(tool: { name: string; variant: string }) {
  const loader = toolRunningLoader(tool.name, tool.variant)
  if (loader && hasRunningAnim(tool.name, tool.variant) && hoveredTool.value === tool.name) {
    return { kind: 'loader' as const, comp: loader.comp, size: loader.size }
  }
  return { kind: 'icon' as const, comp: toolIconComponent(tool.name), size: 15 }
}

/** 点击 web_search 卡：打开引擎选择弹窗 */
function toggleWsExpand() {
  wsModalOpen.value = true
  wsNotice.value = null
  wsKeyInputFor.value = null
}
function closeWsModal() { wsModalOpen.value = false; wsKeyInputFor.value = null; wsNotice.value = null }

/** 引擎项点击：免 Key 直接切换；需 Key 未配置则展开输入行 */
async function handleEngineSelect(e: SearchEngineOption) {
  wsNotice.value = null
  // ★1010v：bing 也是免 Key 的（与 duckduckgo 同档）—— 别弹 Key 输入框
  if (!['bing', 'duckduckgo'].includes(e.id) && !wsKeys.value[e.id]) {
    wsKeyInputFor.value = e.id
    wsKeyDraft.value = ''
    return
  }
  await switchEngine(e.id, {})
}

async function confirmKeyInput() {
  const id = wsKeyInputFor.value
  if (!id || !wsKeyDraft.value.trim()) return
  await switchEngine(id, { [id]: wsKeyDraft.value.trim() })
}

function cancelKeyInput() {
  wsKeyInputFor.value = null
  wsKeyDraft.value = ''
}

async function switchEngine(id: string, newKeys: Record<string, string>) {
  wsSwitching.value = true
  try {
    // 0908五：一并带上当前网络出口（后端 setWebSearchConfig 第三参 network）
    const res = await chatStore.bridgeRpc('websearch.setConfig', { provider: id, apiKeys: newKeys, network: { mode: wsNetworkMode.value, proxyUrl: wsProxyUrl.value } }, 60000 /* ★0927 慢 RPC 大超时：带连通性测试 */)
    if (res?.ok === false || res?.error) {
      wsNotice.value = { ok: false, msg: String(res?.error || t('plugins.wsSwitchFail')) }
      return
    }
    wsEngine.value = id
    Object.assign(wsKeys.value, newKeys)
    wsKeyInputFor.value = null
    wsKeyDraft.value = ''
    const name = SEARCH_ENGINES.find(x => x.id === id)?.name || id
    wsNotice.value = { ok: true, msg: t('plugins.wsSwitched', { name }) }
  } catch (e: any) {
    wsNotice.value = { ok: false, msg: String(e?.message || e) }
  } finally {
    wsSwitching.value = false
  }
}

/** 0908五：保存网络出口（直连/代理）。代理模式必须填地址，否则后端拒绝并回退直连。 */
async function saveWsNetwork() {
  wsSwitching.value = true
  try {
    const res = await chatStore.bridgeRpc('websearch.setConfig', {
      provider: wsEngine.value,
      apiKeys: {},
      network: { mode: wsNetworkMode.value, proxyUrl: wsProxyUrl.value },
    })
    if (res?.ok === false || res?.error) {
      wsNotice.value = { ok: false, msg: String(res?.error || t('plugins.wsSwitchFail')) }
      await loadWebSearchConfig()   // 后端可能已回退 direct，重拉权威值
      return
    }
    if (res?.networkMode) wsNetworkMode.value = res.networkMode === 'proxy' ? 'proxy' : 'direct'
    if (typeof res?.proxyUrl === 'string') wsProxyUrl.value = res.proxyUrl
    wsNotice.value = { ok: true, msg: t('plugins.wsNetworkSaved') }
  } catch (e: any) {
    wsNotice.value = { ok: false, msg: String(e?.message || e) }
    await loadWebSearchConfig()
  } finally {
    wsSwitching.value = false
  }
}
/** 0908五：重填/覆盖已存 key（旧 UI 只在缺 key 时展开输入行，填错后无从更正）。
 *  0909⑦：预填当前已存 Key（后端 websearch.getConfig 本就回传明文，与供应商"显示/隐藏真实 Key"同拍板），
 *  默认打码、点眼睛可看；保存走 switchEngine 带新 key 覆盖。 */
const wsKeyReveal = ref(false)
function editEngineKey(id: string) {
  wsNotice.value = null
  wsKeyInputFor.value = id
  wsKeyDraft.value = wsKeys.value[id] || ''
  wsKeyReveal.value = false
}

// ── 自定义工具：完全编辑自己的工具（高风险；CRUD 走 customTool.* RPC） ──
interface CustomToolDef { name: string; description: string; parameters: any; code: string; createdAt?: number }
const customTools = ref<CustomToolDef[]>([])
const customEditor = ref<{ mode: 'create' | 'edit'; originName: string } | null>(null)
const customDraft = reactive({ name: '', description: '', parameters: '{\n  "type": "object",\n  "properties": {},\n  "required": []\n}', code: '' })
const customError = ref('')

async function loadCustomTools() {
  try {
    const v = await chatStore.bridgeRpc('customTool.list')
    customTools.value = v?.tools || []
  } catch { customTools.value = [] }
}
function openCustomToolEditor(tool?: CustomToolDef) {
  if (tool) {
    customEditor.value = { mode: 'edit', originName: tool.name }
    customDraft.name = tool.name
    customDraft.description = tool.description
    customDraft.parameters = JSON.stringify(tool.parameters || { type: 'object', properties: {} }, null, 2)
    customDraft.code = tool.code
  } else {
    customEditor.value = { mode: 'create', originName: '' }
    customDraft.name = ''
    customDraft.description = ''
    customDraft.parameters = '{\n  "type": "object",\n  "properties": {},\n  "required": []\n}'
    customDraft.code = t('plugins.customCodeTemplate')
  }
  customError.value = ''
}
async function saveCustomToolDraft() {
  try {
    await chatStore.bridgeRpc('customTool.save', { tool: { ...customDraft } })
    customEditor.value = null
    await loadCustomTools()
  } catch (e: any) {
    customError.value = e?.message || t('plugins.saveFail')
  }
}
async function removeCustomTool(name: string) {
  try {
    await chatStore.bridgeRpc('customTool.delete', { name })
    await loadCustomTools()
  } catch (e: any) { console.error('[PluginsModal] custom tool delete failed:', e) }
}

// ── MCP 服务（运行时已接入）：连接状态 + 工具清单 + 管理 ──
interface McpServerState {
  name: string
  status: string
  error?: string
  tools: Array<{ name: string; description: string }>
  connectedAt?: number
  enabled?: boolean
  virtual?: boolean
  config?: Record<string, any>
}
const mcpServers = ref<McpServerState[]>([])
/** ④a：MCP 工具清单从"卡片内联展开"改为"点击卡片工具→弹窗列表"（内容多带滚动条） */
const mcpToolsModal = ref<McpServerState | null>(null)
async function loadMcpRecords() {
  try {
    const v = await chatStore.bridgeRpc('mcp.list')
    mcpServers.value = v?.servers || []
  } catch { mcpServers.value = [] }
}
async function mcpReconnect(s: McpServerState) {
  try {
    await chatStore.bridgeRpc('mcp.connect', { name: s.name, config: s.config || {} })
    await loadMcpRecords()
  } catch (e: any) { console.error('[PluginsModal] mcp reconnect failed:', e); await loadMcpRecords() }
}
/** 开关B：单条 MCP server 启用/停用（后端 mcp.setEnabled：停用=断连不注入；配置保留） */
async function mcpToggleEnabled(s: McpServerState) {
  try {
    await chatStore.bridgeRpc('mcp.setEnabled', { name: s.name, enabled: s.enabled === false })
    await loadMcpRecords()
    void agentPresetsStore.loadToolCatalog()
  } catch (e: any) { console.error('[PluginsModal] mcp toggle failed:', e) }
}
// ② MCP 移除二级确认：移除=卸载（后端删配置目录，不可恢复），必须确认
const mcpRemoveTarget = ref<McpServerState | null>(null)
async function mcpRemove(s: McpServerState) {
  mcpRemoveTarget.value = s
}
async function confirmMcpRemove() {
  const s = mcpRemoveTarget.value
  if (!s) return
  mcpRemoveTarget.value = null
  try {
    await chatStore.bridgeRpc('mcp.disconnect', { name: s.name })
    await loadMcpRecords()
    void agentPresetsStore.loadToolCatalog()
  } catch (e: any) { console.error('[PluginsModal] mcp remove failed:', e) }
}

</script>

<template>
  <Teleport to="body">
    <!-- Backdrop -->
    <div
      v-if="showModal"
      :class="['fixed inset-0 z-40 bg-black/30', isClosing ? 'backdrop-fade-out' : 'backdrop-fade-in']"
    ></div>

    <!-- Modal -->
    <div v-if="showModal" class="fixed inset-0 z-50 flex items-start justify-center pt-[8vh]">
      <div class="relative flex flex-col items-center">
        <div
          :class="['dock-modal', isAnimating && !isClosing ? 'dock-in' : '', isClosing ? 'dock-out' : '']"
          class="relative w-[957px] max-w-[94vw] h-[82vh] bg-white rounded-[20px] shadow-[0_24px_70px_-20px_rgba(0,0,0,0.25)] border-[1.5px] border-gray-200 overflow-hidden flex flex-col"
        >
          <!-- Header（0904 定稿统一：标题无线，tab 与内容之间一条线） -->
          <div class="px-7 pt-6 pb-4">
            <h2 class="text-base font-bold text-gray-900 tracking-tight">{{ t('plugins.tools') }}</h2>
          </div>

          <!-- Tab：系统工具 / 特殊工具 / 工具（统一分段切换：黑胶囊弹性滑块） -->
          <div class="px-7 pb-4 border-b-[1.5px] border-gray-100">
            <SegTabs
              v-model="activeTab"
              size="sm"
              :options="[{ id: 'system', label: t('plugins.tabSystem') }, { id: 'special', label: t('plugins.tabSpecial') }, { id: 'plugin', label: t('plugins.tabMcp') }]"
            />
          </div>

          <!-- Content -->
          <div class="flex-1 min-h-0 px-7 py-6 overflow-y-auto custom-scroll">

            <!-- 系统工具 tab：按功能分组的工具库（icon + 名称 + 功能；启用/停用在 agent 预设中配置） -->
            <template v-if="activeTab === 'system' || activeTab === 'special'">
              <div v-for="group in toolGroups.filter(g => g.tab === activeTab)" :key="group.name" class="mb-5 last:mb-0">
                <div class="flex items-center gap-2 mb-2.5">
                  <span class="text-[12px] font-[640] text-gray-600">{{ group.name }}</span>
                  <span class="text-[10px] text-gray-400 bg-white border border-gray-200 px-1.5 py-0.5 rounded-[5px]">{{ group.tools.length }}</span>
                  <div class="flex-1"></div>
                </div>
                <div class="grid grid-cols-3 gap-2">
                  <div
                    v-for="tool in group.tools"
                    :key="tool.name"
                    :class="['bg-white rounded-xl px-3 py-2.5 border transition-all', (tool as any).selectable ? 'cursor-pointer hover:border-gray-200 hover:shadow-sm' : 'border-gray-100 hover:border-gray-200 hover:shadow-sm']"
                    @click="(tool as any).selectable ? toggleWsExpand() : undefined"
                    @mouseenter="hoveredTool = tool.name"
                    @mouseleave="hoveredTool = null"
                  >
                    <div class="flex items-start gap-2.5">
                      <!-- 图标与过程块同源（②）：默认显示完成态线性图标；有过程态动画的工具悬停时切换为动画（终端打字/风车/条纹） -->
                      <div class="w-7 h-7 rounded-lg bg-gray-100 text-gray-600 flex items-center justify-center shrink-0">
                        <component :is="cardVisual(tool).comp" :size="cardVisual(tool).size" :stroke-width="cardVisual(tool).kind === 'icon' ? 1.6 : undefined" />
                      </div>
                      <div class="flex-1 min-w-0">
                        <div class="text-[12px] font-[530] text-gray-800 truncate flex items-center gap-1" :title="tool.label">
                          {{ tool.label }}
                          <span v-if="tool.risky" class="text-[8px] px-1 py-px rounded-full bg-red-50 text-red-500 border border-red-100 shrink-0">{{ t('plugins.badgeApproval') }}</span>
                          <span v-if="hasRunningAnim(tool.name, tool.variant)" class="text-[8px] px-1 py-px rounded-full bg-indigo-50 text-indigo-500 border border-indigo-100 shrink-0" :title="t('plugins.dynamicTip')">{{ t('plugins.badgeDynamic') }}</span>
                          <span v-if="tool.gating" class="text-[8px] px-1 py-px rounded-full bg-gray-100 text-gray-400 border border-gray-200 shrink-0" :title="tool.gating">{{ t('plugins.badgeLimited') }}</span>
                          <ChevronDown
                            v-if="(tool as any).selectable"
                            :size="11" stroke-width="2" class="shrink-0 text-gray-300"
                          />
                        </div>
                        <div class="text-[10px] text-gray-400 leading-tight mt-0.5 line-clamp-2">{{ tool.desc }}</div>
                        <div class="text-[9px] text-gray-300 font-mono mt-0.5 truncate" :title="tool.name">{{ tool.name }}</div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
                          <div v-if="activeTab === 'special'">
<!-- 自定义工具：完全编辑自己的工具（高风险；创建走创造模式或此弹窗） -->
            <div class="mb-5">
              <div class="flex items-center gap-2 mb-2.5">
                <span class="text-[12px] font-[640] text-gray-600">{{ t('plugins.customTools') }}</span>
                <span class="text-[10px] text-gray-400 bg-white border border-gray-200 px-1.5 py-0.5 rounded-[5px]">{{ customTools.length }}</span>
                <span class="text-[10px] text-red-400">{{ t('plugins.customToolsRiskHint') }}</span>
                <div class="flex-1"></div>
                <button
                  class="btn btn-primary btn-xs"
                  @click="openCustomToolEditor()"
                >{{ t('plugins.newTool') }}</button>
              </div>
              <div v-if="customTools.length === 0" class="py-4 text-center rounded-xl border border-dashed border-gray-200">
                <p class="text-[11px] text-gray-400">{{ t('plugins.customToolsEmpty') }}</p>
              </div>
              <div v-else class="space-y-1.5">
                <div v-for="ct in customTools" :key="ct.name" class="bg-white rounded-xl px-3 py-2 border border-gray-100 flex items-center gap-2.5">
                  <div class="w-7 h-7 rounded-lg bg-red-50 text-red-500 flex items-center justify-center shrink-0">
                    <i class="fas fa-user-pen text-[11px]"></i>
                  </div>
                  <div class="flex-1 min-w-0">
                    <div class="text-[12px] font-[530] text-gray-800 truncate" :title="'custom_' + ct.name">custom_{{ ct.name }}</div>
                    <div class="text-[10px] text-gray-400 truncate" :title="ct.description">{{ ct.description }}</div>
                  </div>
                  <button class="shrink-0 btn btn-secondary btn-xs" @click="openCustomToolEditor(ct)">{{ t('plugins.edit') }}</button>
                  <button class="shrink-0 btn btn-danger btn-xs" @click="removeCustomTool(ct.name)">{{ t('plugins.delete') }}</button>
                </div>
              </div>
            </div>

                          </div>
</template>

            <!-- 工具 tab：插件（MCP）列表 -->
            <template v-else>
            <div class="flex items-center gap-2 mb-3">
              <span class="text-[11px] font-[640] text-gray-500 tracking-wide">{{ t('plugins.mcpServices') }}</span>
              <span class="text-[10px] text-gray-400 bg-white border border-gray-200 px-1.5 py-0.5 rounded-[5px]">{{ mcpServers.length }}</span>
              <div class="flex-1"></div>
            </div>
            <div class="grid grid-cols-2 gap-3">
                <!-- 插件 = MCP 服务（真实数据）：每服务一张卡，纵向布局保证信息完整 -->
                <div v-if="mcpServers.length" class="col-span-2">
                  <div class="grid grid-cols-1 gap-2">
                    <div
                      v-for="s in mcpServers"
                      :key="s.name"
                      class="bg-white rounded-[20px] pt-[18px] px-[18px] pb-[18px] shadow-sm hover:shadow-[0_12px_32px_-12px_rgba(0,0,0,0.2)] transition-all duration-200"
                    >
                      <div class="flex items-start gap-3">
                        <!-- 停用置灰只作用于内容区（图标+名称+说明），操作按钮保持不灰（③） -->
                        <div :class="['flex items-start gap-3 flex-1 min-w-0', s.enabled === false ? 'opacity-55' : '']">
                          <div class="w-10 h-10 rounded-full bg-gray-100 text-gray-600 flex items-center justify-center shrink-0">
                            <Plug :size="18" stroke-width="1.5" />
                          </div>
                          <div class="flex-1 min-w-0">
                            <div class="flex items-center gap-2 flex-wrap">
                              <span class="text-sm font-[640] text-gray-900">{{ s.name }}</span>
                              <span
                                :class="[
                                  'text-[10px] px-2 py-0.5 rounded-full font-[640] border',
                                  s.enabled === false ? 'bg-gray-50 text-gray-400 border-gray-200' : s.status === 'connected' ? 'bg-green-50 text-green-600 border-green-200' : s.status === 'error' ? 'bg-red-50 text-red-500 border-red-200' : 'bg-gray-50 text-gray-500 border-gray-200'
                                ]"
                              >{{ s.enabled === false ? t('plugins.statusDisabled') : s.status === 'connected' ? t('plugins.statusConnected') : s.status === 'error' ? t('plugins.statusError') : s.status === 'connecting' ? t('plugins.statusConnecting') : t('plugins.statusDisconnected') }}</span>
                              <span class="text-[10px] px-2 py-0.5 rounded-full font-[640] bg-white text-gray-400 border border-gray-200">{{ s.virtual ? t('plugins.badgeBuiltin') : 'MCP' }}</span>
                            </div>
                            <div class="text-xs text-gray-500 truncate mt-1" :title="s.error || t('plugins.mcpToolsAvailable', { n: s.tools.length, name: s.name })">{{ s.error || t('plugins.mcpToolsAvailable', { n: s.tools.length, name: s.name }) }}</div>
                          </div>
                        </div>
                        <div class="flex items-center gap-1 shrink-0">
                          <button class="btn btn-secondary btn-xs" @click="mcpToggleEnabled(s)">{{ s.enabled === false ? t('plugins.enable') : t('plugins.stop') }}</button>
                          <button v-if="s.tools.length" class="btn btn-secondary btn-xs" @click="mcpToolsModal = s">{{ t('plugins.toolsCount', { n: s.tools.length }) }}</button>
                          <button v-if="!s.virtual && s.status !== 'connected'" class="btn btn-secondary btn-xs" :title="t('plugins.reconnect')" @click="mcpReconnect(s)">{{ t('plugins.reconnect') }}</button>
                          <button v-if="!s.virtual" class="btn btn-danger btn-xs" :title="t('plugins.remove')" @click="mcpRemove(s)">{{ t('plugins.remove') }}</button>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
                <div v-else class="py-10 text-center rounded-xl border border-dashed border-gray-200 mb-5">
                  <i class="fas fa-plug text-2xl text-gray-200 mb-2"></i>
                  <p class="text-[12px] text-gray-400">{{ t('plugins.mcpEmpty') }}</p>
                </div>
            </div>
            </template>
            </div>

          <!-- Footer -->
          <div class="px-6 py-3.5 flex items-center justify-between">
            <div class="flex items-center gap-2"></div>
            <span class="text-[10px] text-gray-400">{{ t('plugins.globalHint') }}</span>
          </div>
        </div>

        <!-- 自定义工具编辑弹窗（完全编辑自己的工具；高风险） -->
        <Teleport to="body">
          <div v-if="customEditor" class="fixed inset-0 z-[10010] flex items-center justify-center bg-black/40" @click.self="customEditor = null">
            <div class="w-[680px] max-h-[85vh] flex flex-col bg-white rounded-2xl shadow-2xl p-5">
              <div class="flex items-center justify-between mb-1">
                <h3 class="text-[14px] font-[640] text-gray-800">{{ customEditor.mode === 'edit' ? t('plugins.editTool') : t('plugins.newToolTitle') }}</h3>
                <span class="text-[10px] px-1.5 py-0.5 rounded-full bg-red-50 text-red-500 border border-red-100">{{ t('plugins.highRiskBadge') }}</span>
              </div>
              <p class="text-[11px] text-gray-400 mb-3">{{ t('plugins.customToolHint', { name: customDraft.name || t('plugins.nameFallback') }) }}</p>
              <div class="flex-1 min-h-0 overflow-y-auto custom-scroll space-y-3 pr-1">
                <div class="flex gap-3">
                  <label class="block flex-1">
                    <span class="block text-[11px] text-gray-500 mb-1">{{ t('plugins.toolNameLabel') }}</span>
                    <input v-model="customDraft.name" type="text" spellcheck="false" :disabled="customEditor.mode === 'edit'" class="w-full px-3 py-2 rounded-lg border border-gray-200 text-[12px] font-mono outline-none focus:border-blue-400 disabled:bg-gray-50" placeholder="my_tool" />
                  </label>
                </div>
                <label class="block">
                  <span class="block text-[11px] text-gray-500 mb-1">{{ t('plugins.toolDescLabel') }}</span>
                  <input v-model="customDraft.description" type="text" class="w-full px-3 py-2 rounded-lg border border-gray-200 text-[12px] outline-none focus:border-blue-400" :placeholder="t('plugins.toolDescPlaceholder')" />
                </label>
                <label class="block">
                  <span class="block text-[11px] text-gray-500 mb-1">{{ t('plugins.toolParamsLabel') }}</span>
                  <textarea v-model="customDraft.parameters" rows="6" spellcheck="false" class="w-full px-3 py-2 rounded-lg border border-gray-200 text-[11px] font-mono outline-none focus:border-blue-400 resize-y font-mono"></textarea>
                </label>
                <label class="block">
                  <span class="block text-[11px] text-gray-500 mb-1">{{ t('plugins.toolCodeLabel') }}</span>
                  <textarea v-model="customDraft.code" rows="10" spellcheck="false" class="w-full px-3 py-2 rounded-lg border border-gray-200 text-[11px] font-mono outline-none focus:border-blue-400 resize-y font-mono"></textarea>
                </label>
                <p v-if="customError" class="text-[11px] text-red-500">{{ customError }}</p>
              </div>
              <div class="flex justify-end gap-2 mt-4 pt-3 border-t border-gray-100">
                <button class="btn btn-secondary btn-sm" @click="customEditor = null">{{ t('plugins.cancel') }}</button>
                <button class="btn btn-primary btn-sm" @click="saveCustomToolDraft">{{ t('plugins.save') }}</button>
              </div>
            </div>
          </div>
        </Teleport>

        <!-- Close button -->
        <button
          @click="close"
          :class="['close-btn', isAnimating && !isClosing ? 'close-in' : '', isClosing ? 'close-out' : '']"
          class="w-9 h-9 flex items-center justify-center bg-white border border-gray-200 text-gray-400 hover:text-gray-600 hover:shadow-md rounded-full shadow-sm mt-4"
        >
          <i class="fas fa-times text-sm"></i>
        </button>
      </div>
    </div>



  </Teleport>


  <!-- ④a 网页搜索引擎选择弹窗（内容多带滚动条） -->
  <Teleport to="body">
    <div v-if="wsModalOpen" class="fixed inset-0 z-[10012] flex items-center justify-center bg-black/40" @click.self="closeWsModal">
      <div class="w-[440px] max-w-[92vw] flex flex-col bg-white rounded-[20px] shadow-2xl overflow-hidden">
        <div class="flex items-center justify-between px-5 pt-4 pb-3 shrink-0">
          <h3 class="text-[15px] font-[640] text-gray-900">{{ t('plugins.wsTitle') }}</h3>
          <button class="w-7 h-7 flex items-center justify-center rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100" @click="closeWsModal"><X :size="15" stroke-width="2" /></button>
        </div>
        <div class="px-5 pb-5 max-h-[60vh] overflow-y-auto custom-scroll space-y-0.5">
          <!-- ★1010w：引擎列表**单独限高**（用户："给这个部分做一下限高"）——
               原来整块一起滚，列表一长就把下面的「网络出口」顶出视野，用户以为没这项设置 -->
          <div class="max-h-[248px] overflow-y-auto custom-scroll pr-0.5 space-y-0.5">
          <button
            v-for="e in SEARCH_ENGINES"
            :key="e.id"
            class="ws-engine-row w-full flex items-center gap-2 px-2 py-2 rounded-lg text-left"
            :class="{ selected: wsEngine === e.id }"
            @click="handleEngineSelect(e)"
          >
            <Check v-if="wsEngine === e.id" :size="14" stroke-width="2.5" class="shrink-0 ws-engine-check" />
            <span v-else class="w-[14px] h-[14px] rounded-full border border-gray-300 shrink-0"></span>
            <span class="min-w-0 flex-1">
              <span class="block text-[13px]" :class="wsEngine === e.id ? 'text-gray-900 font-[530]' : 'text-gray-700'">{{ e.name }}</span>
              <span class="block text-[11px] text-gray-400 truncate" :title="t(e.desc)">{{ t(e.desc) }}</span>
            </span>
            <!-- ★1010v：bing 与 duckduckgo 同为免 Key ⇒ 既不挂「需 Key」也不给「修改 Key」 -->
            <span v-if="!['bing', 'duckduckgo'].includes(e.id) && !wsKeys[e.id]" class="text-[9px] text-gray-400 border border-gray-200 bg-gray-50 px-1.5 py-0.5 rounded-full shrink-0">{{ t('plugins.wsNeedKey') }}</span>
            <!-- 0908五：已存 key 的引擎给"修改"入口（旧 UI 填错后无从更正）。
                 ⚠ 用 span 不用 button：外层引擎行本身是 <button>，button 套 button 是非法 HTML -->
            <span
              v-else-if="!['bing', 'duckduckgo'].includes(e.id)"
              role="button"
              class="text-[10px] text-gray-400 hover:text-gray-700 border border-transparent hover:border-gray-200 px-1.5 py-0.5 rounded-full shrink-0 transition-colors cursor-pointer"
              @click.stop="editEngineKey(e.id)"
            >{{ t('plugins.wsEditKey') }}</span>
          </button>
          </div>

          <!-- 首次启用需 Key 的引擎 / 0909②：已存 key 点「修改 Key」也走这里。
               ⚠ 必须排在引擎列表正下方（旧版排在网络出口之后：弹窗内容滚动时用户点了「修改 Key」
               输入行出现在视野外=以为"没法改"） -->
          <div v-if="wsKeyInputFor" class="pt-3 mt-2 border-t border-gray-100 space-y-1.5">
            <div class="text-[11px] text-gray-500">{{ SEARCH_ENGINES.find(x => x.id === wsKeyInputFor)?.name }} API Key<span class="text-gray-400">（{{ wsKeys[wsKeyInputFor] ? t('settings.browser.keyPrefillHint') : t('settings.browser.keyFillHint') }}）</span></div>
            <div class="relative">
              <input
                v-model="wsKeyDraft"
                :type="wsKeyReveal ? 'text' : 'password'"
                :placeholder="t('plugins.wsKeyPlaceholder')"
                class="w-full bg-gray-50 border border-gray-200 rounded-lg pl-2.5 pr-8 py-2 text-[12px] outline-none focus:border-gray-400 focus:bg-white font-mono"
                @keydown.enter="confirmKeyInput"
              />
              <button
                type="button"
                class="absolute right-1.5 top-1/2 -translate-y-1/2 w-5 h-5 flex items-center justify-center rounded text-gray-400 hover:text-gray-700"
                :title="wsKeyReveal ? t('common.hide') : t('common.show')"
                @click="wsKeyReveal = !wsKeyReveal"
              ><i :class="['fas text-[10px]', wsKeyReveal ? 'fa-eye-slash' : 'fa-eye']"></i></button>
            </div>
            <div class="flex justify-end gap-1.5">
              <button class="btn btn-secondary btn-xs" @click="cancelKeyInput">{{ t('plugins.cancel') }}</button>
              <button class="btn btn-primary btn-xs" :disabled="wsSwitching || !wsKeyDraft.trim()" @click="confirmKeyInput">{{ wsSwitching ? t('plugins.wsSaving') : t('plugins.wsSaveUse') }}</button>
            </div>
          </div>

          <!-- 0908五：网络出口（直连/代理可切换）——搜索/网页抓取请求走本机 IP 还是走代理 -->
          <div class="pt-3 mt-2 border-t border-gray-100 space-y-1.5">
            <div class="text-[11px] text-gray-500">{{ t('plugins.wsNetworkTitle') }}</div>
            <div class="flex gap-1.5">
              <button
                class="flex-1 px-2 py-1.5 rounded-lg text-[11px] border transition-colors"
                :class="wsNetworkMode === 'direct' ? 'bg-gray-900 text-white border-gray-900' : 'bg-white text-gray-600 border-gray-200 hover:border-gray-400'"
                @click="wsNetworkMode = 'direct'"
              >{{ t('plugins.wsNetworkDirect') }}</button>
              <button
                class="flex-1 px-2 py-1.5 rounded-lg text-[11px] border transition-colors"
                :class="wsNetworkMode === 'proxy' ? 'bg-gray-900 text-white border-gray-900' : 'bg-white text-gray-600 border-gray-200 hover:border-gray-400'"
                @click="wsNetworkMode = 'proxy'"
              >{{ t('plugins.wsNetworkProxy') }}</button>
            </div>
            <input
              v-if="wsNetworkMode === 'proxy'"
              v-model="wsProxyUrl"
              type="text"
              :placeholder="t('plugins.wsProxyPlaceholder')"
              class="w-full bg-gray-50 border border-gray-200 rounded-lg px-2.5 py-2 text-[12px] outline-none focus:border-gray-400 focus:bg-white font-mono"
            />
            <div class="flex justify-end">
              <button class="btn btn-primary btn-xs" :disabled="wsSwitching" @click="saveWsNetwork">{{ t('plugins.wsNetworkSave') }}</button>
            </div>
          </div>

          <p v-if="wsNotice && !wsKeyInputFor" :class="['text-[11px] pt-2', wsNotice.ok ? 'text-green-600' : 'text-red-500']">
            {{ wsNotice.msg }}
          </p>
        </div>
      </div>
    </div>

    <!-- ④a MCP 工具清单弹窗（内容多带滚动条） -->
    <div v-if="mcpToolsModal" class="fixed inset-0 z-[10012] flex items-center justify-center bg-black/40" @click.self="mcpToolsModal = null">
      <div class="w-[520px] max-w-[92vw] flex flex-col bg-white rounded-[20px] shadow-2xl overflow-hidden">
        <div class="flex items-center justify-between px-5 pt-4 pb-3 shrink-0">
          <h3 class="text-[15px] font-[640] text-gray-900">{{ t('plugins.mcpToolsTitle', { name: mcpToolsModal.name }) }}<span class="ml-2 text-[12px] font-[400] text-gray-400">{{ t('plugins.countSuffix', { count: mcpToolsModal.tools.length }) }}</span></h3>
          <button class="w-7 h-7 flex items-center justify-center rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100" @click="mcpToolsModal = null"><X :size="15" stroke-width="2" /></button>
        </div>
        <div class="px-5 pb-5 max-h-[64vh] overflow-y-auto custom-scroll grid grid-cols-1 gap-1">
          <div v-for="tool in mcpToolsModal.tools" :key="tool.name" class="px-2.5 py-2 rounded-lg hover:bg-gray-50">
            <div class="text-[12px] font-mono text-gray-700 truncate" :title="'mcp__' + mcpToolsModal.name + '__' + tool.name">mcp__{{ mcpToolsModal.name }}__{{ tool.name }}</div>
            <div class="text-[11px] text-gray-400 line-clamp-2 mt-0.5" :title="tool.description">{{ tool.description }}</div>
          </div>
        </div>
      </div>
    </div>

    <!-- ② MCP 移除二级确认（移除=卸载，删配置目录，不可恢复） -->
    <div v-if="mcpRemoveTarget" class="fixed inset-0 z-[10013] flex items-center justify-center bg-black/40" @click.self="mcpRemoveTarget = null">
      <div class="w-[360px] bg-white rounded-2xl shadow-2xl p-6">
        <h3 class="text-[15px] font-[640] text-gray-800 mb-2">{{ t('plugins.mcpRemoveTitle') }}</h3>
        <p class="text-[13px] text-gray-500 leading-relaxed mb-5">{{ t('plugins.mcpRemovePrefix') }}「{{ mcpRemoveTarget.name }}」{{ t('plugins.mcpRemoveSuffix', { n: mcpRemoveTarget.tools.length }) }}</p>
        <div class="flex justify-end gap-2">
          <button class="btn btn-secondary btn-sm" @click="mcpRemoveTarget = null">{{ t('plugins.cancel') }}</button>
          <button class="btn btn-danger btn-sm" @click="confirmMcpRemove">{{ t('plugins.mcpRemoveConfirm') }}</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
/* 0909②：引擎行悬停两态自管（不再吃全局 hover:bg-gray-50 映射——深色下浅底压浅字看不见）。
   浅色=浅灰底深字；深色=半透明白底浅字。scoped 下 html.dark 前缀合法（data-v 属性挂在末选择器）。 */
.ws-engine-row { transition: background 0.15s ease, color 0.15s ease; }
.ws-engine-row:hover { background: #f3f4f6; }
html.dark .ws-engine-row:hover { background: rgba(255, 255, 255, 0.09); }
/* 0909⑦：选中态加底色描边（旧版只有勾+加粗，深色下勾色 #111827 不可见=用户所见"选中看不清"）；
   勾色改 class 控制：浅色近黑、深色近白（inline style 优先级压过 html.dark 映射层，必须去掉） */
.ws-engine-row.selected { background: rgba(0, 0, 0, 0.045); }
html.dark .ws-engine-row.selected { background: rgba(255, 255, 255, 0.1); }
.ws-engine-check { color: #111827; }
html.dark .ws-engine-check { color: #e9e9ef; }

/* Backdrop fade */
.backdrop-fade-in {
  animation: backdropFadeIn 0.3s ease forwards;
}
.backdrop-fade-out {
  animation: backdropFadeOut 0.3s ease forwards;
}

@keyframes backdropFadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}
@keyframes backdropFadeOut {
  from { opacity: 1; }
  to { opacity: 0; }
}

/* Dock expand animation */
.dock-in {
  animation: dockExpand 0.45s cubic-bezier(0.34, 1.6, 0.64, 1) forwards;
}
.dock-out {
  animation: dockCollapse 0.3s cubic-bezier(0.4, 0, 0.2, 1) forwards;
}

@keyframes dockExpand {
  0% {
    opacity: 0;
    transform: scale(0.05) rotateX(8deg) translateY(-20px);
    transform-origin: top left;
    filter: blur(4px);
  }
  50% {
    opacity: 1;
    filter: blur(0);
  }
  70% {
    transform: scale(1.02) rotateX(-1deg) translateY(0);
  }
  100% {
    opacity: 1;
    transform: scale(1) rotateX(0) translateY(0);
    filter: blur(0);
  }
}
@keyframes dockCollapse {
  0% {
    opacity: 1;
    transform: scale(1) rotateX(0) translateY(0);
    filter: blur(0);
  }
  100% {
    opacity: 0;
    transform: scale(0.05) rotateX(8deg) translateY(-20px);
    transform-origin: top left;
    filter: blur(4px);
  }
}

/* Close button animation */
.close-in {
  animation: closeBtnIn 0.5s cubic-bezier(0.34, 1.6, 0.64, 1) 0.3s both;
}
.close-out {
  animation: closeBtnOut 0.2s cubic-bezier(0.4, 0, 1, 1) both;
}

@keyframes closeBtnIn {
  0% {
    opacity: 0;
    transform: translateY(40px);
  }
  60% {
    opacity: 1;
    transform: translateY(-6px);
  }
  100% {
    transform: translateY(0);
  }
}
@keyframes closeBtnOut {
  0% {
    opacity: 1;
    transform: translateY(0);
  }
  100% {
    opacity: 0;
    transform: translateY(40px);
  }
}
</style>
