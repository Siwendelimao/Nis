<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, type Component } from 'vue'
import gsap from 'gsap'
import { Search, Puzzle, Clock, Bot, GraduationCap, BookOpen, Brain, Settings, NotebookPen, MessageSquarePlus, Pin, PinOff, Pencil, Trash2, ArrowRightLeft, LoaderCircle } from 'lucide-vue-next'
import { useChatStore } from '@/stores/chat'
import { useUiStore } from '@/stores/ui'
import { useConversationsStore } from '@/stores/conversations'
import { useProjectsStore } from '@/stores/projects'
import { useChannelsStore } from '@/stores/channels'
import { t } from '@/utils/i18n'
import { isAbsolutePath } from '@/utils/fsPath'
import { APP_NAME, APP_VERSION } from '@/utils/appInfo'
import { SIDEBAR_COLLAPSED, SIDEBAR_DEFAULT, SIDEBAR_SNAP, clampWidth } from '@/columns'
import SearchModal from './SearchModal.vue'
import PluginsModal from './PluginsModal.vue'
import SegTabs from './blocks/SegTabs.vue'
import AgentModal from './AgentModal.vue'
import TasksModal from './TasksModal.vue'
import NotebookModal from './NotebookModal.vue'
import SkillsModal from './SkillsModal.vue'
import SettingsModal from './SettingsModal.vue'
import KnowledgeModal from './KnowledgeModal.vue'
import MemoryGraphModal from './MemoryGraphModal.vue'
import MemoryExtractModal from './MemoryExtractModal.vue'
import KnowledgeExtractModal from './KnowledgeExtractModal.vue'
import ChannelHubButton from './blocks/ChannelHubButton.vue'
import SidebarListItem from './SidebarListItem.vue'
import KnowledgeScopePicker from './blocks/KnowledgeScopePicker.vue'
import { bindKnowledgeScope, type KnowledgeScopeSel } from '@/stores/knowledge'
import { useNotificationsStore } from '@/stores/notifications'
import { usePiChatStore } from '@/stores/piChat'

const chatStore = useChatStore()
const uiStore = useUiStore()
const conversationsStore = useConversationsStore()
const projectsStore = useProjectsStore()
const notificationsStore = useNotificationsStore()
const piChatStore = usePiChatStore()
const channelsStore = useChannelsStore()

const activeTab = ref('chat')
const dragging = ref(false)

// 宽度单一来源：App.vue 持有 sidebarWidth 驱动 grid 轨道，此处经 props 接收、拖拽经 emit 回写
const props = withDefaults(defineProps<{ width?: number }>(), { width: SIDEBAR_DEFAULT })
/* ★1012：新增 requestCloseDrawer —— 手机端抽屉由 App.vue 管，侧栏里点「新建对话」要请它收起，
   否则用户看不到"新开对话 + 空态"的反馈，像点了没反应（桌面端无抽屉，App 侧忽略即可）。 */
const emit = defineEmits<{ (e: 'update:width', width: number): void; (e: 'requestCloseDrawer'): void }>()
const expanded = computed(() => props.width > SIDEBAR_SNAP)

interface NavItem {
  icon: Component
  label: string
  action?: string
}

const navItems = ref<NavItem[]>([
  { icon: Search, label: 'sidebar.search', action: 'search' },
  { icon: Puzzle, label: 'sidebar.tools', action: 'plugins' },
  { icon: Clock, label: 'sidebar.tasks', action: 'tasks' },
  { icon: Bot, label: 'sidebar.agent', action: 'agent' },
  { icon: GraduationCap, label: 'sidebar.skills', action: 'skills' },
  { icon: BookOpen, label: 'sidebar.knowledge', action: 'knowledge' },
  { icon: Brain, label: 'sidebar.memory', action: 'memory' }
])

const activeIndex = ref(-1)

// Resize（宽度单一来源：props.width，拖拽实时 emit 回 App.vue 驱动 grid 轨道）
let startX = 0
let startWidth = 0

function startResize(e: MouseEvent) {
  e.preventDefault()
  startX = e.clientX
  startWidth = props.width
  dragging.value = true
  document.addEventListener('mousemove', onResize)
  document.addEventListener('mouseup', stopResize)
}

function onResize(e: MouseEvent) {
  const diff = e.clientX - startX
  let next = clampWidth(startWidth + diff)
  if (next <= SIDEBAR_SNAP) next = SIDEBAR_COLLAPSED // 拖到阈值内 → 吸附折叠态
  emit('update:width', next)
}

function stopResize() {
  document.removeEventListener('mousemove', onResize)
  document.removeEventListener('mouseup', stopResize)
  dragging.value = false
}

/** Logo 点击：展开/折叠切换（折叠 68px / 展开 300px），与宽度状态同步 */
function toggleSidebar() {
  emit('update:width', expanded.value ? SIDEBAR_COLLAPSED : SIDEBAR_DEFAULT)
}

/** ★1012 手机端：点 logo 折叠在手机上没意义（折叠态是 68px 窄条图标栏，手机端用的是抽屉宽度），
 *  误触一下抽屉就变窄条，用户会以为坏了 ⇒ 手机上禁用折叠，只保留双击开发者工具。
 *  （用户真机反馈：「手机端左侧栏点击 logo 折叠的功能不启用」） */
const mqMobileSb = window.matchMedia('(max-width: 767px)')
const isMobileSidebar = ref(mqMobileSb.matches)
const onMqMobileSb = (e: MediaQueryListEvent) => { isMobileSidebar.value = e.matches }
mqMobileSb.addEventListener('change', onMqMobileSb)
onUnmounted(() => mqMobileSb.removeEventListener('change', onMqMobileSb))
function onLogoClick() {
  if (isMobileSidebar.value) return
  toggleSidebar()
}

// Conversation list
const conversations = computed(() => conversationsStore.conversations || [])

/**
 * 最近对话排最上（updatedAt 倒序——刚聊过的沉到顶），置顶会话优先。
 *
 * 0912 二批：**通道会话（origin 非空）不进主列表** —— 它们只在各自的
 * 「QQ/微信 独享对话」里显示（用户明确要求）。要让某个通道会话出现在这里，
 * 用右键菜单「移出通道列表」或通道弹窗的「移到聊天列表」（=清掉 origin 字段）。
 *
 * 0912 十九批：**定时任务支线例外** —— `taskInList=true` 的支线要显示在主列表里（带 ⏰），
 * 这样任务的通知/上下文能在对话列表里被找到、被打开、被右键「放回定时任务」。
 */
/** ★ 0922z2b（需求）：列表排序时间 = **max(最后活跃, 迁入主列表时间)**。
 *  背景：从「QQ/微信 独享会话」用「移到聊天列表」挪进来的会话，updatedAt 是几天前的真实聊天时间，
 *  按老口径会沉到列表最底下、得翻着找。挪进来时后端打一个 movedInAt → 它立刻排最前；
 *  在里面聊过之后 updatedAt 超过它，自然回落（**不改真实聊天时间**，列表上显示的时间仍是真时间）。 */
function convSortTime(c: any): number {
  return Math.max(Number(c?.updatedAt || c?.createdAt || 0) || 0, Number(c?.movedInAt || 0) || 0)
}

const filteredConversations = computed(() => {
  // 0913 修复：任务支线此前从 `!c.origin` 的缺口漏进主列表（origin 为空即通过），
  // 且「放回定时任务」置 inMainList=false 后行仍显示（用户报「放不回去」）。
  // 统一口径：通道会话与任务支线都必须显式 inMainList=true 才进主列表。
  const mine = conversations.value.filter((c: any) => {
    if (c.origin || c.taskId) return c.inMainList === true
    /* ★ 0921i（设计口径）：**没有任何消息的空对话不进主列表** ——
       导入产生的空壳、误建的空会话不再在列表里碍眼（置顶过的除外）。
       发消息后会自动出现，与主流产品的"新对话"行为一致。 */
    /* ★ 0922b：口径是「有消息就进列表」，但 msgCount 只数**已落盘**的 transcript ——
       回合进行中（AI 还没结束、后端尚未落盘）时重拉会给回 0，会话就从列表里消失了。
       所以再认一个**权威事实**：本地 piChat 里已经有用户消息（用户确实发过言）。 */
    /* ★0926 链路修复②（补漏，E2E 实测发现）：**"在等你应答 / 正在回复"的会话必须进列表** ——
       上面两条只看"落盘消息 + 本地节点"，而 transcript 要等 agent_end 才落盘
       ⇒ **新会话的第一轮**里，在**别的窗口**眼里它就是个"空对话" → 不渲染行 →
       连"等待你"标记都没地方挂。用户看到的正是"它在转圈跑、其实在等我点卡"，
       而 10 分钟超时后模型还会重试同一操作（已单独加了防死循环）。
       口径：空对话仍不进列表（避免导入空壳/误建碍眼），但在等你应答/正在回复的例外保留。 */
    if ((Number(c.msgCount) || 0) === 0 && !c.pinned && !c.replying && !c.pendingInteraction
      && !piChatStore.getNodes(String(c.id)).some((n: any) => n.kind === 'user')) return false
    return true
  })
  const list = activeTab.value === 'chat'
    ? mine.filter((c: any) => !c.project_id)
    : mine.filter((c: any) => c.project_id)
  return [...list].sort((a: any, b: any) =>
    (Number(b.pinned || 0) - Number(a.pinned || 0)) || (convSortTime(b) - convSortTime(a)))
})

/** 项目最新排最上，置顶项目优先 */
const sortedProjects = computed(() =>
  [...projectsStore.projects].sort((a, b) =>
    (Number(b.pinned || 0) - Number(a.pinned || 0)) || ((b.updatedAt || b.created_at || 0) - (a.updatedAt || a.created_at || 0))),
)

function sortedProjectConversations(projectId: string) {
  return [...conversationsStore.conversationsForProject(projectId)].sort((a: any, b: any) =>
    (Number(b.pinned || 0) - Number(a.pinned || 0)) || (convSortTime(b) - convSortTime(a)))
}

/** 0917：项目下对话折叠 —— 每个项目默认只列最近 5 条，超出的折叠，可展开/收起 */
const PROJECT_CONV_LIMIT = 5
const projectConvsExpanded = ref<Record<string, boolean>>({})
function visibleProjectConversations(projectId: string) {
  const all = sortedProjectConversations(projectId)
  return projectConvsExpanded.value[projectId] ? all : all.slice(0, PROJECT_CONV_LIMIT)
}
/** 被折叠掉的条数（0 = 无需显示展开按钮） */
function projectConvHidden(projectId: string) {
  return Math.max(0, sortedProjectConversations(projectId).length - PROJECT_CONV_LIMIT)
}
function toggleProjectConvs(projectId: string) {
  projectConvsExpanded.value = { ...projectConvsExpanded.value, [projectId]: !projectConvsExpanded.value[projectId] }
}
const currentConversationId = computed(() => conversationsStore.activeConversationId)

/** 选中会话若被折叠在 5 条之外 → 自动展开（否则点通知/搜索结果会"打开一个看不见的会话"） */
watch(currentConversationId, (id) => {
  if (!id) return
  const conv: any = conversationsStore.getById(id)
  const pid = conv?.project_id
  if (!pid) return
  const list = sortedProjectConversations(pid)
  const idx = list.findIndex((c: any) => c.id === id)
  if (idx >= PROJECT_CONV_LIMIT && !projectConvsExpanded.value[pid]) {
    projectConvsExpanded.value = { ...projectConvsExpanded.value, [pid]: true }
  }
})

/** 折叠态会话 icon 列表（全部对话按最近排顶；状态样式：回复中/未读/询问·审核） */
const collapsedConversations = computed(() => filteredConversations.value.slice(0, 30))
function convGradient(id: string): string {
  const palettes = [
    'linear-gradient(135deg, #0ea5e9 0%, #6366f1 100%)',
    'linear-gradient(135deg, #f59e0b 0%, #ef4444 100%)',
    'linear-gradient(135deg, #10b981 0%, #14b8a6 100%)',
    'linear-gradient(135deg, #ec4899 0%, #8b5cf6 100%)',
  ]
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return palettes[h % palettes.length]
}

/** 0918：特殊预设会话的列表标识（目前只有「导入助手」——设置→通用→导入其他 agent 数据 开的那类） */
function presetTagOf(conv: any): string {
  return conv?.presetId === 'agent-import' ? '导入' : ''
}

async function selectConversation(conv: any) {
  await conversationsStore.openConversation(conv.id)
}

function onConvClick(conv: any, el: HTMLElement) {
  selectConversation(conv)
  gsap.fromTo(el, { scale: 0.97 }, { scale: 1, duration: 0.3, ease: 'back.out(1.7)' })
}

/* 新建对话 / 新建项目 操作行悬停（与对话项一致的悬浮风格） */

/** 新建会话功能按钮（Logo 与 Tabs 之间）：⑥ 进草稿态，不立即建会话/工作区 */
function createNewSession() {
  conversationsStore.startDraft(null)
  /* ★1012：手机端把抽屉收起来 —— 这样立刻看到空态界面（桌面端没抽屉，App 侧会忽略） */
  emit('requestCloseDrawer')
}

/* ── 新建项目：选择工作区目录 → 创建项目 → 项目树下自动建第一条对话 ── */
const newProjectOpen = ref(false)
const projectName = ref('')
const projectPath = ref('')
/* ★ 0921z：原 dirInputRef（webkitdirectory 隐藏 input）已删除 —— 浏览器只给相对路径，正是 root_path 被存成目录名的根因 */
const projectPathError = ref('')
/** 项目树展开状态：projId → boolean */
const expandedProjects = ref<Record<string, boolean>>({})

/** ★ 0921y 目录选择（治本）：三件事一起解决 ——
 *  ① 优先 **Tauri 原生目录对话框**：返回**绝对路径**（不再被存成相对路径），
 *     且它是系统对话框 —— **没有浏览器文件系统权限弹窗、也不会露出 127.0.0.1:端口**；
 *  ② 非 Tauri（dev 浏览器）环境下：浏览器 API（showDirectoryPicker / webkitdirectory）
 *     **拿不到绝对路径**（安全沙箱只给目录名）—— 这正是之前项目 root_path 被存成
 *     `chat_20260921_141903`、工作区跑到"后端进程 cwd"下的根因；
 *     所以这里不再拿它当路径来源，改为提示手输完整路径；
 *  ③ 顺手：名字空着就用目录名兜底（少一步输入）。 */
async function pickFolder() {
  // ① Tauri 原生对话框（安装版）
  try {
    const { open } = await import('@tauri-apps/plugin-dialog')
    const picked: any = await open({ directory: true, multiple: false, title: '选择工作区目录' })
    if (typeof picked === 'string' && picked.trim()) {
      projectPath.value = picked.trim()
      projectPathError.value = ''   // ★ 0921z：原生对话框给的一定是绝对路径
      if (!projectName.value.trim()) {
        const seg = picked.trim().replace(/[\\/]+$/, '').split(/[\\/]/).pop() || ''
        if (seg) projectName.value = seg
      }
      return
    }
    if (picked === null) return   // 用户取消：静默
  } catch { /* 非 Tauri 环境（dev 浏览器）→ 往下走 */ }
  // ② dev/浏览器：浏览器给不了绝对路径 → 提示手输，别再用"目录名"糊弄成路径
  alert('当前是浏览器环境，出于安全限制拿不到完整路径。\n请手动输入完整目录路径，例如：\nD:\\work\\myproject')
}
/** ★ 0921z：手输路径实时校验（非绝对路径立刻提示，不用等点创建） */
function onPathInput(e: Event) {
  // ⚠ 必须从 event.target 取值：模板 @input 的处理顺序**早于** v-model 的赋值，
  //   读 projectPath.value 会拿到上一个值（实时校验时好时坏的真因，0921z 实测出来的）
  const p = String((e.target as HTMLInputElement).value || '').trim()
  // 非绝对路径立刻提示（不挡输入，只提示；创建时再硬校验一次）
  projectPathError.value = (!p || isAbsolutePath(p)) ? '' : t('sidebar.dirPathInvalid')
}

/** ★0930 知识库范围（新建项目时选组/条目；空=不限） */
const newProjectScope = ref<KnowledgeScopeSel>({ cats: [], entryIds: [] })

/** 打开新建项目弹窗 */
function openNewProject() {
  projectName.value = ''
  projectPath.value = ''
  newProjectScope.value = { cats: [], entryIds: [] }
  newProjectOpen.value = true
}

/** 创建项目：校验目录 → 创建 → 项目树下自动建第一条对话 → 留在项目 tab
 *  （注：这是"创建项目"而非"新对话按钮"，需立即建首条窗口以触发伙伴推荐，不走草稿态） */
async function confirmCreateProject() {
  const name = projectName.value.trim()
  const path = projectPath.value.trim()
  if (!name || !path) return
  /* ★ 0921z：**硬校验绝对路径**。相对路径（如 `chat_20260921_141903`）会被后端按进程 cwd 解析，
   *  落成 `backend/<名字>` 工作区 —— 同名工作区两份、项目档案与产出分裂的根因。这里直接挡住。 */
  if (!isAbsolutePath(path)) {
    projectPathError.value = t('sidebar.dirPathInvalid')
    return
  }
  projectPathError.value = ''
  const project = projectsStore.createProject({ name, root_path: path })
  // ★0930 知识库范围：把选中的组/条目归属到本项目（此后该项目会话的 knowledge_query/召回只见这个范围）
  if (newProjectScope.value.cats.length || newProjectScope.value.entryIds.length) void bindKnowledgeScope(project.id, newProjectScope.value)
  // 自动创建该项目下第一条对话（挂在项目下，不进入聊天 tab）
  await conversationsStore.createConversation(project.id)
  // 展开该项目
  expandedProjects.value[project.id] = true
  newProjectOpen.value = false
}

/** 在某项目下新建一条对话：⑥ 进草稿态（记 projectId），发消息才落地 */
function createProjectConversation(projectId: string) {
  conversationsStore.startDraft(projectId)
  /* ★1012：与 createNewSession 同理 —— 手机端点项目行右侧的「+」后要把抽屉收起，
     否则看不到"新开对话 + 空态"的反馈（用户实报"点了没反应"）。桌面端无抽屉，App 侧忽略。 */
  emit('requestCloseDrawer')
}

/** 展开/收起项目节点 */
function toggleProjectExpand(projectId: string) {
  expandedProjects.value[projectId] = !expandedProjects.value[projectId]
}

/** 点击项目下对话 */
async function onProjectConvClick(conv: any, el: HTMLElement) {
  await conversationsStore.openConversation(conv.id)
  gsap.fromTo(el, { scale: 0.97 }, { scale: 1, duration: 0.3, ease: 'back.out(1.7)' })
}

/* ── 列表项下拉菜单（悬停显示，其他状态隐藏）── */
type SidebarMenuItem =
  | { divider: true }
  | { labelKey: string; icon: Component; danger?: boolean; disabled?: boolean; action: () => void }

const MENU_WIDTH = 156
const menuFor = ref<{ type: 'conv' | 'project'; id: string } | null>(null)
const menuPos = ref({ left: 0, top: 0 })
const menuElRef = ref<HTMLElement | null>(null)
/** 记忆提炼：右键会话 → 拉该会话 transcript → 弹 MemoryExtractModal（不依赖聊天窗口是否打开） */
const memoryOpen = ref(false)
const memoryContent = ref('')
const memoryProjectRoot = ref('')
const memoryLoading = ref(false)
const knowledgeOpen = ref(false)
const knowledgeContent = ref('')
const knowledgeProjectRoot = ref('')
const knowledgeLoading = ref(false)
const editingConvId = ref<string | null>(null)
const editingProjectId = ref<string | null>(null)
const confirmDel = ref<{ type: 'conv' | 'project'; id: string; title: string } | null>(null)
/** 项目删除二级确认：输入项目名一致才可删除 */
const deleteTyping = ref('')
/** ★ 0921z-2：删除项目时是否连工作区文件夹一起删（默认勾选；取消 = 只删记录、文件夹原样保留） */
const deleteWorkspaceToo = ref(true)

/**
 * 0912 接入批：「转为通道对话」弹窗（双向互换）。
 * 流程：右键会话 → 转为 QQ/微信对话 → 弹窗选目标 → 二次确认 → 迁移。
 *
 * 0912 二十一批（用户要求）：
 *   ① 去掉「普通聊天列表」选项 —— 弹窗本身就是从普通列表右键出来的，再选它没有意义；
 *   ② QQ 走**二级菜单**：选机器人 → 私聊/群聊 → （群聊再）选哪个群；
 *   ③ 微信只列对端（没有群聊）。
 * key = 会话 id；channel = 选中的目标（'wechat'|'qq'）；needConfirm = 二次确认态。
 */
const convertDialog = ref<{ id: string; title: string; from: string } | null>(null)
const convertChannel = ref<'wechat' | 'qq' | ''>('')
const convertBusy = ref(false)
/** 已知通道对端（二级菜单数据源；与任务通知位置同源 channel.peers） */
interface ConvertPeer {
  channel: string; botId: string; peerId: string; kind?: string
  botName?: string; peerLabel?: string; label?: string; lastAt?: number
}
const convertPeers = ref<ConvertPeer[]>([])
const convertBotId = ref('')
const convertKind = ref<'dm' | 'group'>('dm')
const convertPeerId = ref('')

/** QQ 机器人清单（从已知对端里归纳，带对端数量） */
const convertQqBots = computed(() => {
  const map = new Map<string, { botId: string; botName: string; count: number }>()
  for (const p of convertPeers.value) {
    if (p.channel !== 'qq') continue
    const hit = map.get(p.botId)
    if (hit) hit.count += 1
    else map.set(p.botId, { botId: p.botId, botName: p.botName || 'QQ', count: 1 })
  }
  return [...map.values()]
})
function peersOf(channel: string, botId: string, kind: 'dm' | 'group'): ConvertPeer[] {
  return convertPeers.value.filter(p => p.channel === channel && p.botId === botId
    && (kind === 'group' ? (p.kind === 'group' || p.kind === 'channel') : !(p.kind === 'group' || p.kind === 'channel')))
}
const convertDmPeers = computed(() => (convertChannel.value === 'qq' ? peersOf('qq', convertBotId.value, 'dm') : []))
const convertGroupPeers = computed(() => (convertChannel.value === 'qq' ? peersOf('qq', convertBotId.value, 'group') : []))
const convertWechatPeers = computed(() => convertPeers.value.filter(p => p.channel === 'wechat'))
/** 当前场景下可确认的对端（群聊必须显式选；私聊只有一个时自动选中） */
const convertPickedPeer = computed<ConvertPeer | null>(() => {
  const pool = convertChannel.value === 'qq'
    ? (convertKind.value === 'group' ? convertGroupPeers.value : convertDmPeers.value)
    : convertWechatPeers.value
  return pool.find(p => p.peerId === convertPeerId.value && (convertChannel.value !== 'qq' || p.botId === convertBotId.value)) || null
})
const convertCanConfirm = computed(() => !!convertPickedPeer.value)

function pickConvertChannel(v: 'wechat' | 'qq') {
  convertChannel.value = v
  convertPeerId.value = ''
  convertBotId.value = ''
  convertKind.value = 'dm'
  if (v === 'qq') {
    const first = convertQqBots.value[0]
    if (first) pickConvertBot(first.botId)
  } else {
    const first = convertWechatPeers.value[0]
    if (first) convertPeerId.value = first.peerId
  }
}
function pickConvertBot(botId: string) {
  convertBotId.value = botId
  convertKind.value = peersOf('qq', botId, 'dm').length ? 'dm' : 'group'
  const pool = peersOf('qq', botId, convertKind.value)
  // 该场景只有一个对端 → 直接选中（少点一次）
  convertPeerId.value = pool.length === 1 ? pool[0].peerId : ''
}
function pickConvertKind(kind: 'dm' | 'group') {
  convertKind.value = kind
  const pool = peersOf('qq', convertBotId.value, kind)
  convertPeerId.value = pool.length === 1 ? pool[0].peerId : ''
}

async function openConvertDialog(id: string, title: string, from: string) {
  convertDialog.value = { id, title, from }
  convertChannel.value = ''
  convertBotId.value = ''
  convertKind.value = 'dm'
  convertPeerId.value = ''
  closeMenu()
  // 拉已知对端（二级菜单的数据源）；拿到后默认落到 QQ（多机器人场景最常用）
  convertPeers.value = await channelsStore.loadPeers()
  if (convertPeers.value.some(p => p.channel === 'qq')) pickConvertChannel('qq')
  else if (convertWechatPeers.value.length) pickConvertChannel('wechat')
}

async function confirmConvert() {
  const d = convertDialog.value
  if (!d || convertBusy.value) return
  if (!convertCanConfirm.value) {
    notificationsStore.push({ level: 'error', content: t('channel.convertPickTarget') })
    return
  }
  convertBusy.value = true
  try {
    const peer = convertPickedPeer.value!
    const ok = await channelsStore.moveSession(d.id, convertChannel.value, {
      botId: peer.botId, peerId: peer.peerId, kind: peer.kind || (convertKind.value === 'group' ? 'group' : 'c2c'),
    })
    if (ok) {
      await conversationsStore.loadConversations()
      notificationsStore.push({
        level: 'success',
        content: t('channel.movedToNamed', {
          name: `${convertChannel.value === 'qq' ? 'QQ' : '微信'} · ${peer.botName || ''} · ${peer.peerLabel || peer.peerId.slice(0, 6)}`.replace(/\s·\s·/, ' · '),
        }),
      })
      convertDialog.value = null
    } else {
      notificationsStore.push({ level: 'error', content: channelsStore.lastError || t('channel.moveFailed') })
    }
  } finally {
    convertBusy.value = false
  }
}

function getMenuTarget(): any {
  if (!menuFor.value) return null
  return menuFor.value.type === 'conv'
    ? conversationsStore.conversations.find((c: any) => c.id === menuFor.value!.id)
    : projectsStore.getProject(menuFor.value!.id)
}

const menuItems = computed<SidebarMenuItem[]>(() => {
  const m = menuFor.value
  const target = getMenuTarget()
  if (!m || !target) return []
  const pinned = !!target.pinned
  const itemTitle = (m.type === 'conv' ? target.title : target.name) || t('sidebar.untitled')
  // 会话专属：AI 提炼记忆（右键会话 → 提炼该会话 transcript 里的偏好/决策/教训等）
  const extractItem: SidebarMenuItem[] = m.type === 'conv'
    ? [{
        labelKey: 'ctx.extractWindowMemory',
        icon: Brain,
        action: () => {
          const cid = m.id
          closeMenu()
          openMemoryExtract(cid)
        },
      }, {
        labelKey: 'ctx.extractKnowledge',
        icon: BookOpen,
        action: () => {
          const cid = m.id
          closeMenu()
          openKnowledgeExtract(cid)
        },
      }]
    : []
  // 0912 接入批：会话专属 —— 转为通道对话（双向互换）
  // 0912 十九批：三种情形分流 —— 任务支线「放回定时任务」；已在主列表的通道会话「移回通道列表」；其余「转为通道对话」
  const convertItem: SidebarMenuItem[] = m.type === 'conv'
    ? [{
        labelKey: (target as any).taskId
          ? 'ctx.parkTaskSession'
          : ((target as any).origin ? 'ctx.moveBackChannel' : 'ctx.convertToChannel'),
        icon: ArrowRightLeft,
        action: () => {
          const cid = m.id
          closeMenu()
          if ((target as any).taskId) {
            void conversationsStore.setTaskSessionInList(cid, false)
            return
          }
          if ((target as any).origin) {
            void conversationsStore.moveBackToChannel(cid, String((target as any).origin))
            return
          }
          const ctitle = (target as any).title || t('sidebar.untitled')
          openConvertDialog(cid, ctitle, '')
        },
      }]
    : []
  return [
    {
      labelKey: pinned ? 'ctx.unpin' : 'ctx.pin',
      icon: pinned ? PinOff : Pin,
      action: () => {
        if (m.type === 'conv') conversationsStore.togglePin(m.id)
        else projectsStore.togglePinProject(m.id)
        closeMenu()
      },
    },
    {
      labelKey: 'ctx.rename',
      icon: Pencil,
      action: () => {
        if (m.type === 'conv') editingConvId.value = m.id
        else editingProjectId.value = m.id
        closeMenu()
      },
    },
    ...extractItem,
    ...convertItem,
    { divider: true },
    /**
     * 0912 十九批：定时任务支线**不给删除入口** —— 它的生命周期跟着任务走（删任务才删它），
     * 直接删会让任务卡片指向一条不存在的对话（后端也拦了，这里是前端不给人点）。
     */
    ...((m.type === 'conv' && (target as any).taskId)
      ? [{
          labelKey: 'ctx.parkTaskSessionHint',
          icon: Trash2,
          disabled: true,
          danger: true,
          action: () => { closeMenu() },
        }]
      : [{
          labelKey: m.type === 'conv' ? 'ctx.delete' : 'ctx.deleteProject',
          icon: Trash2,
          danger: true,
          action: () => {
            // 会话删除免确认（用户拍板：只进滞留处可恢复）；项目删除仍走输入名称二次确认
            if (m.type === 'conv') {
              conversationsStore.moveConversationToTrash(m.id)
            } else {
              confirmDel.value = { type: m.type, id: m.id, title: itemTitle }
              deleteTyping.value = ''
              deleteWorkspaceToo.value = true   // ★ 0921z-2：每次打开都回到默认勾选
            }
            closeMenu()
          },
        }]),
  ]
})

/** 弹出下拉菜单。
 *  两种触发源（SidebarListItem 通过 @menu 上报 info）：
 *   - source='button'（左键菜单按钮）：以整行矩形右对齐、行下方弹出（沿用旧行为）。
 *   - source='contextmenu'（右键行）：以指针为左上锚点，并做视口边界收敛（贴右/贴底时向内收）。
 *  0911 深夜：新增右键触发分支，菜单本体（menuItems/浮层）与左键完全同源同貌。 */
function openMenu(type: 'conv' | 'project', id: string, info: { source: 'button' | 'contextmenu'; row: HTMLElement; x: number; y: number }) {
  // 记下锚点，渲染后再按真实尺寸决定落点（见 placeMenu）
  if (info.source === 'contextmenu') {
    menuAnchor = { kind: 'pointer', x: info.x, y: info.y }
    menuPos.value = { left: Math.max(8, info.x), top: Math.max(8, info.y) }
  } else {
    const rect = info.row.getBoundingClientRect()
    menuAnchor = { kind: 'button', rowTop: rect.top, rowBottom: rect.bottom, right: rect.right }
    menuPos.value = { left: Math.max(8, rect.right - MENU_WIDTH), top: rect.bottom + 6 }
  }
  // 先清空再赋值：同一行重复右键时引用变化，保证 gsap 入场动画重播
  menuFor.value = null
  menuFor.value = { type, id }
  requestAnimationFrame(() => {
    // ★ 先按真实尺寸定好落点，再播动画（量的顺序反了会受 scale 影响）
    placeMenu()
    const el = menuElRef.value
    if (el) gsap.fromTo(el, { opacity: 0, y: -4, scale: 0.97 }, { opacity: 1, y: 0, scale: 1, duration: 0.16, ease: 'power2.out' })
  })
}

/** 当前菜单的锚点：由 openMenu 写入，placeMenu 消费（不需要响应式） */
let menuAnchor: { kind: 'button'; rowTop: number; rowBottom: number; right: number } | { kind: 'pointer'; x: number; y: number } | null = null

/* ★ 0919 修（用户两条反馈合一）：
   ① 以前"⋯ 按钮"这条分支**完全没有边界处理**（`top = 行底 + 6` 直接怼），菜单会盖到窗口外；
      而右键分支用的是写死的 `MENU_HEIGHT_EST=172`（会话菜单实测 199px，估算早过时）。
   ② 明确需求：**下方放不下就整块向上弹**，而不是"往下塞然后被夹上来"——
      夹上来会让菜单离那一行很远，点起来不顺手。
   所以落点顺序 = 优先放下方 → 放不下翻到上方 → 上下都放不下（超矮窗口）才夹进视口。
   尺寸用 offsetWidth/offsetHeight：入场 gsap 有 scale(0.97)，getBoundingClientRect 会量小。 */
function placeMenu() {
  const el = menuElRef.value
  const a = menuAnchor
  if (!el || !a) return
  const pad = 8
  const w = el.offsetWidth || MENU_WIDTH
  const h = el.offsetHeight || 200
  const vw = window.innerWidth
  const vh = window.innerHeight
  let left: number
  let top: number
  if (a.kind === 'button') {
    left = Math.max(pad, Math.min(a.right - MENU_WIDTH, vw - w - pad))
    const below = a.rowBottom + 6
    const above = a.rowTop - h - 6
    top = below + h <= vh - pad ? below : (above >= pad ? above : Math.max(pad, vh - h - pad))
  } else {
    left = Math.max(pad, Math.min(a.x, vw - w - pad))
    const above = a.y - h
    top = a.y + h <= vh - pad ? a.y : (above >= pad ? above : Math.max(pad, vh - h - pad))
  }
  if (left !== menuPos.value.left || top !== menuPos.value.top) menuPos.value = { left, top }
}

function closeMenu() {
  menuFor.value = null
  menuAnchor = null
}

/** pi transcript（session.history.messages）→ 纯文本：只取 user/assistant 的 text 块，跳过工具/图片块 */
function transcriptText(messages: any[]): string {
  const lines: string[] = []
  for (const m of messages) {
    const role = m?.role
    if (role !== 'user' && role !== 'assistant') continue
    const c = m?.content
    let text = ''
    if (typeof c === 'string') text = c
    else if (Array.isArray(c)) {
      text = c.filter((b: any) => b?.type === 'text' && b.text).map((b: any) => b.text).join('\n')
    }
    text = String(text || '').trim()
    if (!text) continue
    lines.push(`${role === 'user' ? '用户' : '助手'}：${text}`)
  }
  return lines.join('\n\n')
}

/** 右键会话「AI 提炼记忆」：拉该会话 transcript → 弹 MemoryExtractModal（不依赖聊天窗口是否打开） */
async function openMemoryExtract(convId: string) {
  if (memoryLoading.value) return
  memoryLoading.value = true
  const conv = conversationsStore.conversations.find((c: any) => c.id === convId) as any
  const proj = conv?.project_id ? projectsStore.getProject(conv.project_id) : null
  memoryProjectRoot.value = (proj?.root_path || conv?.workDir || '') as string
  notificationsStore.push({ level: 'info', content: t('memoryExtract.reading') })
  try {
    const res = await chatStore.bridgeRpc('session.history', { sessionId: convId })
    const text = transcriptText(Array.isArray(res?.messages) ? res.messages : [])
    if (!text) {
      notificationsStore.push({ level: 'warning', content: t('memoryExtract.emptyConv') })
      return
    }
    memoryContent.value = text
    memoryOpen.value = true
  } catch {
    notificationsStore.push({ level: 'error', content: t('memoryExtract.readFailed') })
  } finally {
    memoryLoading.value = false
  }
}

/** 右键会话「提炼知识」：拉该会话 transcript → 弹 KnowledgeExtractModal（提炼结果勾选后写入知识库） */
async function openKnowledgeExtract(convId: string) {
  if (knowledgeLoading.value) return
  knowledgeLoading.value = true
  const conv = conversationsStore.conversations.find((c: any) => c.id === convId) as any
  const proj = conv?.project_id ? projectsStore.getProject(conv.project_id) : null
  knowledgeProjectRoot.value = (proj?.root_path || conv?.workDir || '') as string
  notificationsStore.push({ level: 'info', content: t('knowledgeExtract.reading') })
  try {
    const res = await chatStore.bridgeRpc('session.history', { sessionId: convId })
    const text = transcriptText(Array.isArray(res?.messages) ? res.messages : [])
    if (!text) {
      notificationsStore.push({ level: 'warning', content: t('knowledgeExtract.emptyConv') })
      return
    }
    knowledgeContent.value = text
    knowledgeOpen.value = true
  } catch {
    notificationsStore.push({ level: 'error', content: t('knowledgeExtract.readFailed') })
  } finally {
    knowledgeLoading.value = false
  }
}

/** 点击菜单外任意处收起。
 *  0911 深夜：忽略右键（button===2）—— 右键本身要弹菜单，若在此先关再开会让菜单闪烁；
 *  右键切换目标行的处理交给 contextmenu 分支（openMenu 覆盖 menuFor 并重播动画）。 */
function onDocDown(e: MouseEvent) {
  if (e.button === 2) return
  const target = e.target as HTMLElement | null
  if (!target) return
  if (menuElRef.value?.contains(target)) return
  if (target.closest('.menu-btn')) return
  closeMenu()
}

watch(menuFor, (v) => {
  if (v) document.addEventListener('mousedown', onDocDown, true)
  else document.removeEventListener('mousedown', onDocDown, true)
})

/** 切换 tab 时收起菜单 */
watch(activeTab, () => closeMenu())

/* ── 行内重命名 ── */
function confirmRename(type: 'conv' | 'project', id: string, rawTitle: string) {
  const title = rawTitle.trim()
  if (type === 'conv') {
    if (editingConvId.value !== id) return
    editingConvId.value = null
    if (title) conversationsStore.renameConversation(id, title)
  } else {
    if (editingProjectId.value !== id) return
    editingProjectId.value = null
    if (title) projectsStore.renameProject(id, title)
  }
}

function cancelRename(type: 'conv' | 'project') {
  if (type === 'conv') editingConvId.value = null
  else editingProjectId.value = null
}

/* ── 删除确认（对话/项目均进滞留处，保留期内可恢复；项目需输入名称二级确认）── */
async function confirmDelete() {
  const d = confirmDel.value
  if (!d) return
  // 项目二级确认：输入的项目名必须与名称完全一致
  if (d.type === 'project' && deleteTyping.value.trim() !== d.title) return
  confirmDel.value = null
  deleteTyping.value = ''
  const withFiles = deleteWorkspaceToo.value
  const projPath = d.type === 'project' ? (projectsStore.getProject(d.id)?.root_path || '') : ''
  if (d.type === 'conv') { conversationsStore.moveConversationToTrash(d.id); return }
  /* ★ 0921z-2（需求）：勾选=把工作区文件夹移入**系统回收站**（可还原）；取消=只删记录、文件夹原样保留。
     结果必须回执 —— 用户得知道文件夹到底动没动。 */
  const r = await projectsStore.moveProjectToTrash(d.id, { deleteFiles: withFiles })
  if (!withFiles) {
    notificationsStore.push({ level: 'info', content: t('sidebar.workspaceKept', { path: projPath }), type: 'system' })
  } else if (r.filesDeleted) {
    notificationsStore.push({ level: 'success', content: t('sidebar.workspaceDeleted', { path: projPath }), type: 'system' })
  } else if (r.error) {
    notificationsStore.push({ level: 'warning', content: t('sidebar.workspaceDeleteFail', { err: r.error }), type: 'system' })
  }
}

const searchModalOpen = ref(false)
/** 0914：全局「选中文字 → 右键搜索」带进来的关键词（普通打开时清空） */
const searchSeed = ref('')
function onGlobalSearchRequest(e: Event) {
  const q = String((e as CustomEvent)?.detail?.query || '').trim()
  if (!q) return
  searchSeed.value = q
  searchModalOpen.value = true
}
const pluginsModalOpen = ref(false)
const agentModalOpen = ref(false)
const tasksModalOpen = ref(false)
const skillsModalOpen = ref(false)
const knowledgeModalOpen = ref(false)
const memoryModalOpen = ref(false)
/** 0920：用户记事本（用户与 AI 共用的一本） */
const notebookModalOpen = ref(false)
const searchBtnRef = ref<HTMLElement | null>(null)

function setActive(index: number) {
  activeIndex.value = index
}

function handleNavClick(item: NavItem, index: number) {
  // Toggle off if clicking same button
  if (activeIndex.value === index) {
    handleModalClose()
    return
  }
  // 规则：已有弹窗打开时不切换——必须先关闭当前弹窗才能开新的（避免堆叠）
  const anyOpen = searchModalOpen.value || pluginsModalOpen.value || agentModalOpen.value
    || tasksModalOpen.value || skillsModalOpen.value || knowledgeModalOpen.value || memoryModalOpen.value
    || notebookModalOpen.value
  if (anyOpen) return
  setActive(index)
  // 0903：触发按钮主动失焦——否则 ESC（键盘事件）关弹窗后该按钮进入 :focus-visible 态留一圈黑框
  if (typeof document !== 'undefined' && document.activeElement instanceof HTMLElement) {
    document.activeElement.blur()
  }
  if (item.action === 'search') {
    searchSeed.value = ''
    searchModalOpen.value = true
  }
  if (item.action === 'plugins') {
    pluginsModalOpen.value = true
  }
  if (item.action === 'agent') {
    agentModalOpen.value = true
  }
  if (item.action === 'tasks') {
    tasksModalOpen.value = true
  }
  if (item.action === 'skills') {
    skillsModalOpen.value = true
  }
  if (item.action === 'knowledge') {
    knowledgeModalOpen.value = true
  }
  if (item.action === 'memory') {
    memoryModalOpen.value = true
  }
}

function handleModalClose() {
  searchModalOpen.value = false
  pluginsModalOpen.value = false
  agentModalOpen.value = false
  tasksModalOpen.value = false
  skillsModalOpen.value = false
  knowledgeModalOpen.value = false
  memoryModalOpen.value = false
  notebookModalOpen.value = false
  activeIndex.value = -1
}

/** 0920：打开用户记事本（先关掉其他弹窗，避免堆叠） */
function openNotebook() {
  handleModalClose()
  notebookModalOpen.value = true
}

/** 0914 下午：搜索弹窗「打开结果」——对话直接打开；记忆/知识切对应弹窗 */
function onSearchOpenResult(item: { type: string; id: string }) {
  handleModalClose()
  if (item.type === 'conversation' && item.id) {
    void conversationsStore.openConversation(item.id)
  } else if (item.type === 'memory') {
    memoryModalOpen.value = true
  } else if (item.type === 'knowledge') {
    knowledgeModalOpen.value = true
  }
}

/** 打开设置弹窗：先关掉其他弹窗，避免堆叠 */
function openSettings() {
  handleModalClose()
  uiStore.openSettings('general')
}

/** 0920：接入按钮挪到侧边栏底部后，通道弹窗里点「打开会话」走这条。
 *  通道会话就是普通会话（后端带 origin 标记），与点会话列表完全同一条路径。 */
async function openSessionFromChannel(sessionId: string) {
  if (!sessionId) return
  await conversationsStore.openConversation(sessionId)
}

function getSearchBtnRect() {
  return searchBtnRef.value?.getBoundingClientRect() ?? null
}

/** 双击 Logo → 打开开发者工具（Tauri 下走 IPC，Rust 端 open_devtools；浏览器下提示） */
function openDevtools() {
  if ((window as any).__TAURI_INTERNALS__) {
    import('@tauri-apps/api/core').then(({ invoke }) => {
      invoke('open_devtools').catch(() => {})
    }).catch(() => {})
  } else {
    console.log('[Devtools] 双击 Logo 触发 — 请在 Tauri 桌面端打开开发者工具')
  }
}

onMounted(() => {
  window.addEventListener('nis-open-search', onGlobalSearchRequest)
/* 0927 netfix: 具名监听 + onUnmounted 移除（原匿名监听每代实例在 window 上泄漏一个） */
const onNisOpenPanel = (e: Event) => {
  const panel = (e as CustomEvent).detail
  if (panel === 'skills') {
    skillsModalOpen.value = true
  } else if (panel === 'plugins') {
    pluginsModalOpen.value = true
  }
}
  window.addEventListener('nis-open-panel', onNisOpenPanel)
})

onUnmounted(() => {
  window.removeEventListener('nis-open-search', onGlobalSearchRequest)
  window.removeEventListener('nis-open-panel', onNisOpenPanel)
  document.removeEventListener('mousemove', onResize)
  document.removeEventListener('mouseup', stopResize)
  document.removeEventListener('mousedown', onDocDown, true)
})
</script>

<template>
  <aside
    class="app-sidebar"
    :class="[
      'flex flex-col overflow-hidden',
      'bg-white rounded-3xl border border-gray-200',
      expanded ? 'p-3' : 'py-3'
    ]"
    :style="{
      width: expanded ? props.width + 'px' : SIDEBAR_COLLAPSED + 'px',
      boxShadow: '0 1px 3px rgba(0,0,0,0.08), 0 1px 2px rgba(0,0,0,0.04)'
    }"
    :data-dragging="dragging || undefined"
  >
    <!-- Logo (click to toggle；★1012 手机端禁用折叠，见 onLogoClick) -->
    <div
      class="sidebar-logo-row flex items-center gap-3 mb-3 select-none"
      :class="[expanded ? '' : 'justify-center', isMobileSidebar ? '' : 'cursor-pointer']"
      @click="onLogoClick"
      @dblclick.stop="openDevtools"
    >
      <!-- 0915 修：ml-2.5 只在展开态给（折叠态容器是 justify-center，再叠 10px 左边距会把 logo 顶歪） -->
      <img src="/nis-logo2.png" alt="NIS" class="w-7 h-7 object-contain flex-shrink-0" :class="expanded ? 'ml-2.5' : ''" />
      <!-- 0915：品牌字改手写体 + 版本号（用户拍板；版本取 appInfo 单一口径） -->
      <span v-if="expanded" class="flex items-baseline gap-1.5 min-w-0 whitespace-nowrap">
        <span class="sidebar-brand">{{ APP_NAME }}</span>
        <span class="text-[10px] font-[530] text-gray-400 dark:text-gray-500">v{{ APP_VERSION }}</span>
      </span>
    </div>

    <!-- 新建对话 / 新建项目（Logo 下方、搜索上方；与 nav 按钮同款样式） -->
    <div
      v-if="expanded"
      class="action-row flex items-center gap-2.5 w-full h-8 px-2.5 rounded-lg cursor-pointer mb-1.5 transition-colors"
      @click="activeTab === 'chat' ? createNewSession() : openNewProject()"
    >
      <MessageSquarePlus :size="15" stroke-width="1.75" class="flex-shrink-0" />
      <span class="text-[12px] font-[530] truncate flex-1">{{ activeTab === 'chat' ? t('conversation.newChat') : t('conversation.newProject') }}</span>
    </div>

    <!-- Nav actions（展开竖向带名称 / 折叠竖向纯图标） -->
    <nav v-if="expanded" class="flex flex-col mb-2 space-y-0.5">
      <button
        v-for="(item, index) in navItems"
        :key="index"
        class="flex items-center gap-2.5 w-full h-8 px-2.5 rounded-lg hover:bg-gray-100 transition-colors"
        :class="{ 'bg-gray-100': activeIndex === index }"
        @click="handleNavClick(item, index)"
      >
        <component :is="item.icon" :size="16" stroke-width="1.75" class="shrink-0" />
        <span class="text-[12px] text-gray-700 truncate">{{ t(item.label) }}</span>
      </button>
    </nav>
    <nav v-else class="flex flex-col items-center gap-1">
      <button
        v-for="(item, index) in navItems"
        :key="index"
        class="w-9 h-9 flex items-center justify-center rounded-lg hover:bg-gray-100 transition-colors"
        :class="{ 'bg-gray-100': activeIndex === index }"
        :title="t(item.label)"
        @click="handleNavClick(item, index)"
      >
        <component :is="item.icon" :size="18" stroke-width="1.75" />
      </button>
      <!-- 新建对话（折叠态：与展开态"新建对话"行等价的图标按钮） -->
      <button
        class="w-9 h-9 flex items-center justify-center rounded-lg hover:bg-gray-100 transition-colors"
        :title="t('conversation.newChat')"
        @click="createNewSession"
      >
        <MessageSquarePlus :size="18" stroke-width="1.75" />
      </button>
    </nav>

    <!-- 折叠态会话列表：每条对话一个状态 icon（回复中=脉冲蓝点/未读=数字/询问·审核=琥珀点/无新消息=常规点） -->
    <div v-if="!expanded" class="flex-1 min-h-0 overflow-y-auto overflow-x-hidden no-scrollbar flex flex-col items-center gap-1 mt-1">
      <button
        v-for="conv in collapsedConversations"
        :key="conv.id"
        class="collapsed-conv-icon relative w-9 h-9 flex items-center justify-center rounded-lg transition-colors"
        :class="{ 'bg-gray-100': currentConversationId === conv.id }"
        :title="(conv.title || t('sidebar.untitled')) + ' · ' + String(conv.id || '').slice(0, 8)"
        @click="onConvClick(conv, $event.currentTarget as HTMLElement)"
      >
        <span class="w-6 h-6 rounded-full flex items-center justify-center text-[9px] font-bold text-white" :style="{ background: convGradient(conv.id) }">{{ (conv.title || t('sidebar.convInitial')).slice(0, 1) }}</span>
        <!-- 回复中：外圈脉冲 -->
        <span v-if="conv.replying" class="collapsed-ring is-replying"></span>
        <!-- 未读：数字角标 -->
        <span v-else-if="conv.unread" class="collapsed-badge">{{ conv.unread > 9 ? '9+' : conv.unread }}</span>
        <!-- 询问/审核挂起：琥珀点 -->
        <span v-else-if="conv.pendingInteraction" class="collapsed-dot is-pending"></span>
      </button>
    </div>

    <!-- Tabs (展开时显示)：统一分段切换（黑胶囊弹性滑块） -->
    <div v-if="expanded" class="mb-2.5">
      <SegTabs v-model="activeTab" size="xs2" :options="[{ id: 'chat', label: t('conversation.tabChat') }, { id: 'project', label: t('conversation.tabProjects') }]" />
    </div>

    <!-- Conversation List (仅展开时显示) -->
    <div v-if="expanded" class="relative flex-1 overflow-y-auto overflow-x-hidden no-scrollbar -mx-2 px-2">
      <!-- 项目树（项目 tab） -->
      <template v-if="activeTab === 'project'">
        <div v-for="proj in sortedProjects" :key="proj.id" class="mb-0.5">
          <!-- 项目节点 -->
          <SidebarListItem
            type="project"
            :id="proj.id"
            :title="proj.name"
            :pinned="!!proj.pinned"
            :editing="editingProjectId === proj.id"
            :project-expanded="expandedProjects[proj.id]"
            :menu-open="!!menuFor && menuFor.type === 'project' && menuFor.id === proj.id"
            show-plus
            @select="toggleProjectExpand(proj.id)"
            @menu="openMenu('project', proj.id, $event)"
            @plus="createProjectConversation(proj.id)"
            @rename-confirm="confirmRename('project', proj.id, $event)"
            @rename-cancel="cancelRename('project')"
                      />
          <!-- 展开的项目子树 -->
          <div v-if="expandedProjects[proj.id]" class="ml-4 pl-1 border-l border-gray-100">
            <!-- 项目下对话 -->
            <SidebarListItem
              v-for="conv in visibleProjectConversations(proj.id)"
              :key="conv.id"
              type="conv"
              dense
              :id="conv.id"
              :title="(conv.title || t('sidebar.untitled')) + ' · ' + String(conv.id || '').slice(0, 8)"
              :subtitle="conv.lastMessage"
              :replying="!!conv.replying"
              :unread="conv.unread || 0"
              :pending="conv.pendingInteraction || null"
              :selected="currentConversationId === conv.id"
              :pinned="!!conv.pinned"
              :editing="editingConvId === conv.id"
              :menu-open="!!menuFor && menuFor.type === 'conv' && menuFor.id === conv.id"
              :origin="conv.origin || ''"
              :preset-tag="presetTagOf(conv)"
              @select="onProjectConvClick(conv, $event)"
              @menu="openMenu('conv', conv.id, $event)"
              @rename-confirm="confirmRename('conv', conv.id, $event)"
              @rename-cancel="cancelRename('conv')"
                          />
            <!-- 0917：超过 5 条折叠；点此展开/收起 -->
            <button
              v-if="projectConvHidden(proj.id) > 0"
              class="w-full mt-0.5 mb-0.5 px-2 py-1 rounded-lg text-left text-[11px] text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors"
              @click="toggleProjectConvs(proj.id)"
            >
              <i class="fas fa-chevron-down text-[8px] mr-1 transition-transform" :class="{ 'rotate-180': projectConvsExpanded[proj.id] }"></i>
              {{ projectConvsExpanded[proj.id]
                ? t('sidebar.collapseConvs')
                : t('sidebar.expandMoreConvs', { n: projectConvHidden(proj.id) }) }}
            </button>
            <div v-if="sortedProjectConversations(proj.id).length === 0" class="text-center text-gray-400 text-[12px] py-2">
              {{ t('sidebar.noConversations') }}
            </div>
          </div>
        </div>
        <div v-if="projectsStore.projects.length === 0" class="text-center text-gray-400 text-[12px] py-6">
          {{ t('sidebar.noProjects') }}
        </div>
      </template>
      <template v-else>
        <!-- 0914c：列表数据未就绪 → 骨架占位（扫光条；absolute 铺满整块、超出裁切，不撑出滚动）
             快速刷新/跳过开屏时不再出现空态闪烁 -->
        <div v-if="!conversationsStore.listLoaded" class="absolute inset-0 px-3 pt-1 overflow-hidden pointer-events-none" aria-hidden="true">
          <div
            v-for="n in 24"
            :key="n"
            class="skel-bar h-[30px] rounded-lg mb-1.5"
            :style="{ '--skel-delay': ((n - 1) * 0.06) + 's' }"
          ></div>
        </div>
        <SidebarListItem
          v-for="conv in filteredConversations"
          :key="conv.id"
          type="conv"
          :id="conv.id"
          :title="(conv.title || t('sidebar.untitled')) + ' · ' + String(conv.id || '').slice(0, 8)"
          :subtitle="conv.lastMessage"
          :replying="!!conv.replying"
          :unread="conv.unread || 0"
          :pending="conv.pendingInteraction || null"
          :selected="currentConversationId === conv.id"
          :pinned="!!conv.pinned"
          :editing="editingConvId === conv.id"
          :menu-open="!!menuFor && menuFor.type === 'conv' && menuFor.id === conv.id"
          :origin="conv.origin || ''"
          :task="!!conv.taskId"
          :preset-tag="presetTagOf(conv)"
          @select="onConvClick(conv, $event)"
          @menu="openMenu('conv', conv.id, $event)"
          @rename-confirm="confirmRename('conv', conv.id, $event)"
          @rename-cancel="cancelRename('conv')"
                  />
        <div v-if="filteredConversations.length === 0 && conversationsStore.listLoaded" class="text-center text-gray-400 text-[12px] py-6">
          {{ t('sidebar.noConversations') }}
        </div>
      </template>
    </div>

    <!-- Bottom -->
    <div class="mt-auto">
      <!-- ★0930（实测"折叠后下方三个按钮摆放位置有问题"）：折叠态 68px 栏塞不下三个 36px 横排（116px）会溢出挤歪 → 折叠态竖排 -->
      <div class="flex items-center justify-center gap-1" :class="expanded ? '' : 'flex-col'">
        <!-- 0920：与「通知中心」互换位置 —— 通知挪去标题栏右上角，**接入**（QQ/微信/远程）挪到底部与设置同列。
             接入是全局能力、低频配置，跟设置放一起更整齐。 -->
        <ChannelHubButton @open-session="openSessionFromChannel" />
        <button
          class="w-9 h-9 sidebar-gear relative flex items-center justify-center rounded-xl hover:bg-gray-100 transition-colors"
          :title="t('sidebar.settings') + (chatStore.wsConnected ? '' : '（后端连接异常）')"
          @click="openSettings"
        >
          <Settings :size="18" stroke-width="1.75" />
          <!-- ★0926（需求）：齿轮圆心=后端连接指示灯——绿=连接正常，红=连接异常（闪） -->
          <span class="gear-status-dot" :class="chatStore.wsConnected ? 'is-ok' : 'is-bad'" aria-hidden />
        </button>
        <!-- 0920：用户记事本入口（用户与 AI 共用的一本待办/便签）。
             放在设置右侧：都是"我自己常用、低频配置类"的入口，同一列更整齐。 -->
        <button
          class="w-9 h-9 sidebar-gear flex items-center justify-center rounded-xl hover:bg-gray-100 transition-colors"
          :title="t('notebook.title')"
          @click="openNotebook"
        >
          <NotebookPen :size="18" stroke-width="1.75" />
        </button>
      </div>
    </div>

    <!-- Resize Handle -->
    <div
      class="absolute top-0 right-0 w-2 -mr-1 h-full cursor-ew-resize hover:bg-blue-400 transition-colors"
      @mousedown="startResize"
    ></div>
  </aside>
  <SearchModal :open="searchModalOpen" :seed="searchSeed" :button-rect="getSearchBtnRect()" @close="handleModalClose" @open-result="onSearchOpenResult" />
  <PluginsModal :open="pluginsModalOpen" @close="handleModalClose" />
  <AgentModal :open="agentModalOpen" @close="handleModalClose" />
  <TasksModal :open="tasksModalOpen" @close="handleModalClose" />
  <NotebookModal :open="notebookModalOpen" @close="handleModalClose" />
  <SkillsModal :open="skillsModalOpen" @close="handleModalClose" />
  <KnowledgeModal :open="knowledgeModalOpen" @close="handleModalClose" />
  <MemoryGraphModal :open="memoryModalOpen" @close="handleModalClose" />
  <SettingsModal :open="uiStore.settingsOpen" @close="uiStore.closeSettings()" />

  <!-- 新建项目弹窗：名称 + 选择工作区目录 -->
  <div v-if="newProjectOpen" class="fixed inset-0 z-[100] flex items-center justify-center bg-black/40" @click.self="newProjectOpen = false">
    <div class="w-[360px] bg-white rounded-2xl shadow-2xl p-6">
      <h3 class="text-[15px] font-[640] text-gray-800 mb-4">{{ t('conversation.newProjectTitle') }}</h3>
      <div class="space-y-3">
        <div>
          <label class="block text-[12px] text-gray-500 mb-1">{{ t('conversation.projectName') }}</label>
          <input
            v-model="projectName"
            type="text"
            :placeholder="t('sidebar.projectNamePlaceholder')"
            class="w-full px-3 py-2 rounded-lg border border-gray-200 text-[12px] outline-none focus:border-blue-500"
          />
        </div>
        <div>
          <label class="block text-[12px] text-gray-500 mb-1">{{ t('sidebar.workspaceDir') }}</label>
          <div class="flex gap-2">
            <input
              v-model="projectPath"
              type="text"
              :placeholder="t('sidebar.dirPathPlaceholder')"
              @input="onPathInput"
              class="flex-1 px-3 py-2 rounded-lg border border-gray-200 text-[12px] outline-none focus:border-blue-500"
            />
            <button
              type="button"
              class="px-3 py-2 rounded-lg border border-gray-200 text-[12px] text-gray-600 hover:bg-gray-50 shrink-0"
              @click="pickFolder"
            >{{ t('search.select') }}</button>
          </div>
          <!-- ★ 0921z：绝对路径校验提示（红字；`onPathInput` 实时更新、创建时硬校验） -->
          <div v-if="projectPathError" class="text-[11px] text-red-500 mt-1">{{ projectPathError }}</div>
        </div>
        <!-- ★0930 知识库范围（可选）：勾选的组/条目=本项目可读知识 -->
        <KnowledgeScopePicker v-model="newProjectScope" />
      </div>
      <div class="flex justify-end gap-2 mt-5">
        <button
          type="button"
          class="btn btn-secondary btn-sm"
          @click="newProjectOpen = false"
        >{{ t('conversation.cancel') }}</button>
        <button
          type="button"
          class="btn btn-primary btn-sm"
          :disabled="!projectName.trim() || !projectPath.trim()"
          @click="confirmCreateProject"
        >{{ t('sidebar.create') }}</button>
      </div>
    </div>
  </div>

  <!-- 列表项下拉菜单（点击 ⋯ 弹出） -->
  <div
    v-if="menuFor"
    ref="menuElRef"
    class="fixed z-[60] min-w-[150px] max-h-[calc(100vh-16px)] overflow-y-auto bg-white rounded-xl border border-gray-200 shadow-lg py-1"
    :style="{ left: menuPos.left + 'px', top: menuPos.top + 'px' }"
    @mousedown.stop
  >
    <template v-for="(item, idx) in menuItems" :key="idx">
      <div v-if="'divider' in item" class="my-1 border-t border-gray-100"></div>
      <button
        v-else
        class="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-left"
        :class="[
          item.danger ? 'text-red-600' : 'text-gray-700',
          item.disabled ? 'opacity-40 cursor-not-allowed' : 'hover:bg-gray-50',
        ]"
        :disabled="!!item.disabled"
        @click="item.action"
      >
        <component :is="item.icon" :size="14" stroke-width="2" class="flex-shrink-0" />
        <span class="truncate">{{ t(item.labelKey) }}</span>
      </button>
    </template>
  </div>

  <!-- 0912 接入批：「转为通道对话」弹窗（双向互换）—— 选目标 → 二次确认 → 迁移
       二十一批：去掉「普通聊天列表」；QQ 走二级菜单（机器人 → 私聊/群聊 → 群） -->
  <Teleport to="body">
    <div v-if="convertDialog" class="fixed inset-0 z-[100] flex items-center justify-center bg-black/40" @click.self="convertDialog = null">
      <div class="w-[400px] bg-white rounded-2xl shadow-2xl p-6 max-h-[86vh] overflow-y-auto">
        <h3 class="text-[15px] font-[640] text-gray-800 mb-1.5">{{ t('channel.convertTitle') }}</h3>
        <p class="text-[12px] text-gray-500 leading-relaxed mb-4">
          {{ t('channel.convertHint', { name: convertDialog.title }) }}
        </p>

        <!-- ① 目标通道：微信 / QQ（本身就是从普通列表打开的，不再提供「普通聊天列表」） -->
        <div class="space-y-2 mb-4">
          <button
            v-for="opt in [
              { v: 'qq', icon: 'fab fa-qq', color: '#12b7f5', label: t('channel.qq'), sub: t('channel.convertQqSub') },
              { v: 'wechat', icon: 'fab fa-weixin', color: '#07c160', label: t('channel.wechat'), sub: t('channel.convertWxSub') },
            ]"
            :key="opt.v"
            type="button"
            class="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl border text-left transition-colors"
            :class="convertChannel === opt.v ? 'border-gray-800 bg-gray-50' : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50'"
            @click="pickConvertChannel(opt.v as any)"
          >
            <i :class="[opt.icon, 'text-[13px] shrink-0']" :style="{ color: opt.color }"></i>
            <span class="flex-1 min-w-0">
              <span class="block text-[12px] text-gray-800">{{ opt.label }}</span>
              <span class="block text-[10px] text-gray-400 truncate">{{ opt.sub }}</span>
            </span>
            <i v-if="convertChannel === opt.v" class="fas fa-check text-[11px] text-gray-800"></i>
          </button>
        </div>

        <!-- ② QQ 二级菜单：选机器人 → 私聊/群聊 → 群聊再选哪个群 -->
        <div v-if="convertChannel === 'qq'" class="mb-4 space-y-3">
          <div v-if="convertQqBots.length">
            <div class="text-[10px] font-[640] text-gray-500 mb-1.5">{{ t('channel.convertPickBot') }}</div>
            <div class="flex flex-wrap gap-1.5">
              <button
                v-for="b in convertQqBots"
                :key="b.botId"
                type="button"
                class="px-2.5 py-1.5 rounded-lg border text-[11px] transition-colors"
                :class="convertBotId === b.botId ? 'border-gray-800 bg-gray-800 text-white' : 'border-gray-200 text-gray-700 hover:border-gray-300'"
                @click="pickConvertBot(b.botId)"
              >{{ b.botName }}<span class="ml-1 opacity-60">{{ b.count }}</span></button>
            </div>
          </div>
          <div v-else class="text-[11px] text-gray-400">{{ t('channel.convertNoPeers') }}</div>

          <template v-if="convertBotId">
            <div>
              <div class="text-[10px] font-[640] text-gray-500 mb-1.5">{{ t('channel.convertPickScene') }}</div>
              <div class="flex gap-1.5">
                <button
                  type="button"
                  class="px-2.5 py-1.5 rounded-lg border text-[11px] transition-colors disabled:opacity-40"
                  :class="convertKind === 'dm' ? 'border-gray-800 bg-gray-800 text-white' : 'border-gray-200 text-gray-700 hover:border-gray-300'"
                  :disabled="!convertDmPeers.length"
                  @click="pickConvertKind('dm')"
                >{{ t('channel.tabDm') }}<span class="ml-1 opacity-60">{{ convertDmPeers.length }}</span></button>
                <button
                  type="button"
                  class="px-2.5 py-1.5 rounded-lg border text-[11px] transition-colors disabled:opacity-40"
                  :class="convertKind === 'group' ? 'border-gray-800 bg-gray-800 text-white' : 'border-gray-200 text-gray-700 hover:border-gray-300'"
                  :disabled="!convertGroupPeers.length"
                  @click="pickConvertKind('group')"
                >{{ t('channel.tabGroup') }}<span class="ml-1 opacity-60">{{ convertGroupPeers.length }}</span></button>
              </div>
            </div>
            <div v-if="convertKind === 'group' && convertGroupPeers.length">
              <div class="text-[10px] font-[640] text-gray-500 mb-1.5">{{ t('channel.convertPickGroup') }}</div>
              <div class="space-y-1">
                <button
                  v-for="p in convertGroupPeers"
                  :key="p.peerId"
                  type="button"
                  class="w-full flex items-center gap-2 px-2.5 py-2 rounded-lg border text-[11px] text-left transition-colors"
                  :class="convertPeerId === p.peerId ? 'border-gray-800 bg-gray-50' : 'border-gray-200 hover:border-gray-300'"
                  @click="convertPeerId = p.peerId"
                >
                  <i class="fas fa-users text-[10px] text-amber-600"></i>
                  <span class="flex-1 truncate text-gray-800">{{ p.peerLabel || p.peerId.slice(0, 6) }}</span>
                  <i v-if="convertPeerId === p.peerId" class="fas fa-check text-[10px] text-gray-800"></i>
                </button>
              </div>
            </div>
            <div v-else-if="convertKind === 'dm'">
              <div v-if="convertDmPeers.length > 1" class="space-y-1">
                <div class="text-[10px] font-[640] text-gray-500 mb-1.5">{{ t('channel.convertPickPeer') }}</div>
                <button
                  v-for="p in convertDmPeers"
                  :key="p.peerId"
                  type="button"
                  class="w-full flex items-center gap-2 px-2.5 py-2 rounded-lg border text-[11px] text-left transition-colors"
                  :class="convertPeerId === p.peerId ? 'border-gray-800 bg-gray-50' : 'border-gray-200 hover:border-gray-300'"
                  @click="convertPeerId = p.peerId"
                >
                  <i class="fab fa-qq text-[10px] text-sky-500"></i>
                  <span class="flex-1 truncate text-gray-800">{{ p.peerLabel || p.peerId.slice(0, 6) }}</span>
                  <i v-if="convertPeerId === p.peerId" class="fas fa-check text-[10px] text-gray-800"></i>
                </button>
              </div>
            </div>
          </template>
        </div>

        <!-- ③ 微信：只列对端（微信没有群聊） -->
        <div v-if="convertChannel === 'wechat'" class="mb-4">
          <div v-if="convertWechatPeers.length > 1">
            <div class="text-[10px] font-[640] text-gray-500 mb-1.5">{{ t('channel.convertPickPeer') }}</div>
            <div class="space-y-1">
              <button
                v-for="p in convertWechatPeers"
                :key="p.peerId"
                type="button"
                class="w-full flex items-center gap-2 px-2.5 py-2 rounded-lg border text-[11px] text-left transition-colors"
                :class="convertPeerId === p.peerId ? 'border-gray-800 bg-gray-50' : 'border-gray-200 hover:border-gray-300'"
                @click="convertPeerId = p.peerId"
              >
                <i class="fab fa-weixin text-[10px] text-emerald-600"></i>
                <span class="flex-1 truncate text-gray-800">{{ p.peerLabel || p.peerId.slice(0, 6) }}</span>
                <i v-if="convertPeerId === p.peerId" class="fas fa-check text-[10px] text-gray-800"></i>
              </button>
            </div>
          </div>
          <div v-else-if="!convertWechatPeers.length" class="text-[11px] text-gray-400">{{ t('channel.convertNoPeers') }}</div>
        </div>

        <!-- 二次确认提示 -->
        <div class="bg-amber-50 border border-amber-100 rounded-lg px-3 py-2.5 mb-4">
          <p class="text-[11px] text-amber-700 leading-relaxed">
            {{ convertCanConfirm
              ? t('channel.convertConfirmTo', { name: `${convertChannel === 'qq' ? 'QQ' : t('channel.wechat')}${convertPickedPeer ? ' · ' + (convertPickedPeer.botName || '') + ' · ' + (convertPickedPeer.peerLabel || '') : ''}` })
              : t('channel.convertPickTarget') }}
          </p>
          <p class="text-[10px] text-amber-600/80 leading-relaxed mt-1">{{ t('channel.convertNote') }}</p>
        </div>

        <div class="flex justify-end gap-2">
          <button type="button" class="btn btn-secondary btn-sm" @click="convertDialog = null">{{ t('conversation.cancel') }}</button>
          <button type="button" class="btn btn-primary btn-sm" :disabled="convertBusy || !convertCanConfirm" @click="confirmConvert">
            <LoaderCircle v-if="convertBusy" :size="11" :stroke-width="2" class="animate-spin mr-1" />
            {{ t('channel.convertConfirm') }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>

  <!-- 删除确认弹窗：对话/项目均进滞留处（保留期内可恢复）；项目需输入名称二级确认 -->
  <div v-if="confirmDel" class="fixed inset-0 z-[100] flex items-center justify-center bg-black/40" @click.self="confirmDel = null">
    <div class="w-[360px] bg-white rounded-2xl shadow-2xl p-6">
      <h3 class="text-[15px] font-[640] text-gray-800 mb-2">{{ confirmDel.type === 'conv' ? t('chat.deleteDialog') : t('conversation.deleteProjectTitle') }}</h3>
      <template v-if="confirmDel.type === 'conv'">
        <p class="text-[12px] text-gray-500 leading-relaxed mb-5">
          {{ t('chat.deleteConfirmPrefix') }}{{ confirmDel.title }}{{ t('sidebar.deleteConvSuffix') }}
        </p>
      </template>
      <template v-else>
        <p class="text-[12px] text-gray-500 leading-relaxed mb-3">
          {{ t('conversation.deleteProjectHint').replace('{name}', confirmDel.title) }}
        </p>
        <p class="text-[12px] text-gray-500 leading-relaxed mb-3">
          {{ t('sidebar.deleteProjectConvHint', { n: conversationsStore.conversationsForProject(confirmDel.id).length }) }}
        </p>
        <!-- ★ 0921z-2（需求）：工作区内容是否一并删 —— 默认勾选、可取消；勾选时把完整路径摆出来核对 -->
        <label class="flex items-start gap-2 rounded-lg border border-gray-200 px-3 py-2.5 mb-2 cursor-pointer select-none">
          <input v-model="deleteWorkspaceToo" type="checkbox" class="mt-[2px] accent-red-500" />
          <span class="flex-1 min-w-0">
            <span class="block text-[12.5px] text-gray-700">{{ t('sidebar.deleteWorkspaceLabel') }}</span>
            <span class="block text-[11px] text-gray-400 mt-0.5 leading-snug">{{ t('sidebar.deleteWorkspaceHint') }}</span>
          </span>
        </label>
        <div v-if="deleteWorkspaceToo" class="text-[11px] text-gray-400 break-all mb-3">
          {{ t('sidebar.deleteWorkspacePath', { path: projectsStore.getProject(confirmDel.id)?.root_path || t('settings.trash.noPath') }) }}
          <div class="text-red-500 mt-0.5">{{ t('sidebar.deleteWorkspaceWarn') }}</div>
        </div>
        <div class="bg-red-50 border border-red-100 rounded-lg px-3 py-2.5 mb-4">
          <div class="text-[12px] text-gray-500 mb-1.5">{{ t('conversation.deleteProjectTypeLabel') }}</div>
          <input
            v-model="deleteTyping"
            type="text"
            :placeholder="confirmDel.title"
            class="w-full bg-white border border-red-200 rounded-lg px-3 py-2 text-sm text-gray-800 outline-none focus:border-red-400 focus:ring-2 focus:ring-red-100"
          />
        </div>
      </template>
      <div class="flex justify-end gap-2">
        <button
          type="button"
          class="btn btn-secondary btn-sm"
          @click="confirmDel = null"
        >{{ t('conversation.cancel') }}</button>
        <button
          type="button"
          class="btn btn-danger btn-sm"
          :disabled="confirmDel.type === 'project' && deleteTyping.trim() !== confirmDel.title"
          @click="confirmDelete"
        >{{ confirmDel.type === 'project' && deleteWorkspaceToo ? t('sidebar.deleteProjectWithFiles') : t('chat.delete') }}</button>
      </div>
    </div>
  </div>

  <!-- AI 提炼记忆（会话右键「提炼本窗口记忆」触发）：先预览候选，勾选后落盘 -->
  <MemoryExtractModal
    :open="memoryOpen"
    :content="memoryContent"
    :project-root="memoryProjectRoot"
    @close="memoryOpen = false"
  />

  <!-- AI 提炼知识（会话右键「提炼知识」触发）：提炼结果勾选后写入知识库 -->
  <KnowledgeExtractModal
    :open="knowledgeOpen"
    :content="knowledgeContent"
    :project-root="knowledgeProjectRoot"
    @close="knowledgeOpen = false"
  />
</template>

<style scoped>
aside {
  transition: width 0.3s ease, padding 0.3s ease;
}
/* 拖拽期间关闭过渡，保证宽度随鼠标实时连续变化 */
aside[data-dragging] {
  transition: none !important;
}

/* 折叠态会话 icon：状态环/角标/状态点 */
.collapsed-conv-icon:hover {
  background: #f3f4f6;
}
.collapsed-ring {
  position: absolute;
  inset: -1px;
  border-radius: 10px;
  pointer-events: none;
}
.collapsed-ring.is-replying {
  border: 2px solid rgba(79, 110, 247, 0.65);
  animation: collapsedPulse 1.4s ease-in-out infinite;
}
.collapsed-badge {
  position: absolute;
  top: -2px;
  right: -2px;
  min-width: 14px;
  height: 14px;
  padding: 0 3px;
  border-radius: 999px;
  background: #ef4444;
  color: #fff;
  font-size: 9px;
  font-weight: 600;
  line-height: 14px;
  text-align: center;
}
.collapsed-dot {
  position: absolute;
  bottom: 0;
  right: 0;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  border: 1.5px solid #fff;
}
.collapsed-dot.is-pending {
  background: #f59e0b;
  animation: collapsedPulse 1.4s ease-in-out infinite;
}
@keyframes collapsedPulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.45; }
}

/* 操作行（新建对话/新建项目）：与 nav 按钮同款（透明 + hover 浅灰） */
.action-row {
  color: #374151;
  transform: translateZ(0);
}
.action-row:hover {
  background: #f3f4f6;
}
.action-row:active {
  background: #e5e7eb;
}

/* 隐藏滚动条但保留滚动 */
.no-scrollbar::-webkit-scrollbar {
  display: none;
}
.no-scrollbar {
  -ms-overflow-style: none;
  scrollbar-width: none;
}

/* 0914c：列表未就绪骨架条——扫光（高光从左到右掠过；非呼吸），逐条微错峰成波 */
.skel-bar {
  position: relative;
  overflow: hidden;
  background: #eef0f2;
}
.skel-bar::after {
  content: '';
  position: absolute;
  inset: 0;
  transform: translateX(-100%);
  background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.9), transparent);
  animation: skelSweep 1.5s ease-in-out infinite;
  animation-delay: var(--skel-delay, 0s);
}
html.dark .skel-bar {
  background: rgba(255, 255, 255, 0.055);
}
html.dark .skel-bar::after {
  background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.085), transparent);
}
@keyframes skelSweep {
  to { transform: translateX(100%); }
}

/* 0915：品牌字——手写体（系统自带西文手写字体栈，零资源；深浅两套色） */
.sidebar-brand {
  font-family: 'Segoe Script', 'Ink Free', 'Bradley Hand', 'Comic Sans MS', cursive;
  font-size: 17px;
  font-weight: 600;
  letter-spacing: 0.03em;
  line-height: 1;
  color: #1f2937;
}
html.dark .sidebar-brand {
  color: #e9e9ef;
}
/* ★0926（需求）：设置齿轮圆心=后端连接指示灯（绿=连接正常 / 红=连接异常）。
   动画只动 opacity（WebView2 约束）；reduced-motion 降级为常亮。 */
.gear-status-dot {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  width: 7px;
  height: 7px;
  border-radius: 50%;
  border: 1.5px solid #fff;
  box-shadow: 0 0 0 0.5px rgba(0, 0, 0, 0.08);
  pointer-events: none;
  transition: background-color 0.25s ease;
}
.gear-status-dot.is-ok { background: #10b981; }
.gear-status-dot.is-bad {
  background: #ef4444;
  animation: gear-dot-blink 1s ease-in-out infinite;
}
@keyframes gear-dot-blink {
  50% { opacity: 0.3; }
}
html.dark .gear-status-dot { border-color: #161616; box-shadow: 0 0 0 0.5px rgba(255, 255, 255, 0.12); }
/* 1010 深色对比度：折叠态「回复中」脉冲环 rgba(79,110,247,.65) 在近黑面板上偏暗 → 亮化 */
html.dark .collapsed-ring.is-replying { border-color: rgba(129, 140, 248, 0.9); }
@media (prefers-reduced-motion: reduce) {
  .gear-status-dot.is-bad { animation: none; }
}
</style>
