<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted, computed } from 'vue'
import { t } from '@/utils/i18n'
import { useChatStore } from '@/stores/chat'
import { useConversationsStore } from '@/stores/conversations'
import { useProvidersStore } from '@/stores/providers'
import VendorLogo from './VendorLogo.vue'
import EffortPicker from './blocks/EffortPicker.vue'

/**
 * 定时任务（0912 十二批：从演示数据改为真实功能）
 *
 * 语义：任务 = 名称 + 一段 prompt + 周期 + 目标会话。
 * 到点由后端调度器调 `runPromptCore` 执行 —— 与手打消息同一条路径，
 * 结果落在会话里（打开对话即可看到）。
 */
const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: [] }>()

const chatStore = useChatStore()
const conversationsStore = useConversationsStore()
const providersStore = useProvidersStore()

const isAnimating = ref(false)
const isClosing = ref(false)
const showModal = ref(false)

interface TaskSchedule {
  kind: 'once' | 'hourly' | 'daily' | 'weekly' | 'monthly'
  at?: string
  interval?: number
  time?: string
  weekdays?: number[]
  dayOfMonth?: number
}
interface TaskNotifyTarget {
  channel: 'qq' | 'wechat'
  botId: string
  peerId: string
  kind?: string
  label?: string
  /** 二十一批：展示/分组用（botName/peerLabel/groupKey/groupLabel 由后端下发） */
  botName?: string
  peerLabel?: string
  groupKey?: string
  groupLabel?: string
}
interface TaskBranch {
  sessionId: string
  key: string
  label: string
  title: string
  lastMessage: string
  updatedAt: number
  inList: boolean
  isExec: boolean
  exists: boolean
  running: boolean
}
interface Task {
  id: string
  name: string
  prompt: string
  targetSessionId: string
  /** 任务专属对话 id（targetSessionId='own' 时由后端创建后写回） */
  ownSessionId?: string
  /** 执行会话（首个通知位置的支线） */
  execSessionId?: string
  /** 支线清单（每个通知位置一条，0912 十九批） */
  branches?: TaskBranch[]
  /** 完成后通知的通道目标（13 批） */
  notifyTargets?: TaskNotifyTarget[]
  /** 任务模型（0912）：'global' 跟随全局模型 / 'custom' 自选；未设按 global */
  modelMode?: 'global' | 'custom'
  modelId?: string
  modelProviderId?: string
  /** F轮：自选模型的推理强度（fast/deep/heavy/burning）；空=跟随模型默认 */
  modelEffort?: string
  schedule: TaskSchedule
  enabled: boolean
  nextRunAt: number
  lastRunAt?: number
  lastStatus?: 'ok' | 'error' | 'running'
  lastError?: string
  lastSessionId?: string
  runCount: number
}

const tasks = ref<Task[]>([])
const loading = ref(false)
const busyId = ref('')
const lastError = ref('')

async function rpc(method: string, payload: Record<string, any> = {}): Promise<any> {
  return await chatStore.bridgeRpc(method, payload)
}

async function loadTasks() {
  if (!chatStore.wsConnected) return
  loading.value = true
  try {
    const r = await rpc('task.list', {})
    tasks.value = Array.isArray(r?.tasks) ? r.tasks : []
    lastError.value = ''
  } catch (e: any) {
    lastError.value = String(e?.message || e).slice(0, 200)
  } finally {
    loading.value = false
  }
}

/* ── 周期描述（与后端 describeSchedule 对齐，纯展示）── */
const WD = () => [t('tasks.wd0'), t('tasks.wd1'), t('tasks.wd2'), t('tasks.wd3'), t('tasks.wd4'), t('tasks.wd5'), t('tasks.wd6')]
function describe(s: TaskSchedule): string {
  const iv = Math.max(1, Math.floor(s?.interval || 1))
  const time = s?.time || '09:00'
  switch (s?.kind) {
    case 'once': {
      const d = s.at ? new Date(s.at) : null
      if (!d || Number.isNaN(d.getTime())) return t('tasks.kOnce')
      return `${t('tasks.kOnce')} · ${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    }
    case 'hourly': return iv === 1 ? t('tasks.kHourly') : t('tasks.everyNHour', { n: iv })
    case 'daily': return iv === 1 ? `${t('tasks.kDaily')} ${time}` : `${t('tasks.everyNDay', { n: iv })} ${time}`
    case 'weekly': {
      const days = (s.weekdays?.length ? [...s.weekdays].sort((a, b) => a - b) : [1]).map(i => WD()[i]).join('、')
      return `${t('tasks.kWeekly')} ${days} ${time}`
    }
    case 'monthly': return `${t('tasks.kMonthly')} ${s.dayOfMonth || 1} ${t('tasks.dayUnit')} ${time}`
  }
  return ''
}

function fmtTime(ts?: number): string {
  if (!ts) return '—'
  const d = new Date(ts)
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  if (sameDay) return `${t('tasks.today')} ${hm}`
  return `${d.getMonth() + 1}/${d.getDate()} ${hm}`
}

/** 列表卡片上「通知」chip 的 tooltip（用保存时的 label 回显；老数据兜底用 id） */
function notifyLabel(task: Task): string {
  return (task.notifyTargets || [])
    .map(x => x.label || `${x.channel === 'wechat' ? '微信' : 'QQ'} · ${x.botId}`)
    .join(' / ')
}

/* ── 任务模型（0912）：全局模型 or 自选 ── */

/** 「后台模型」当前值（用于任务模型档的展示文案）
 *  ★1013（已定案："以前可以选用全局模型的，都要换成后台模型"）：定时任务的「全局」档改读后台模型，
 *  这里展示的也必须是后台模型 —— 取值跟 providersStore.backgroundModel* 走（后端 providers.json 是权威）。 */
const globalModelLabel = computed(() => {
  const pid = providersStore.backgroundProviderId
  const mid = providersStore.backgroundModelId
  if (!pid || !mid) return t('tasks.fModelGlobalNone')
  return providersStore.modelName(pid, mid) || mid
})

/** 自选时可选的厂商（只列启用的） */
const modelVendors = computed(() => providersStore.providers.filter(p => p.enabled))
const pickedVendor = ref<string | null>(null)
const modelPickerOpen = ref(false)

function textModelsOf(providerId: string) {
  return (providersStore.models[providerId] || []).filter(
    m => m.enabled && providersStore.modelType(providerId, m.id) === 'text',
  )
}

/** 自选模型的展示名 */
const customModelLabel = computed(() => {
  const pid = form.value.modelProviderId
  const mid = form.value.modelId
  if (!pid || !mid) return t('tasks.fModelPick')
  return providersStore.modelName(pid, mid) || mid
})

function pickCustomModel(modelId: string, providerId: string) {
  form.value.modelId = modelId
  form.value.modelProviderId = providerId
  // 换模型 → 强度可能不再适用（新模型挡位集不同）→ 清空，跟随该模型默认
  form.value.modelEffort = ''
  modelPickerOpen.value = false
  pickedVendor.value = null
}

function openModelPicker() {
  modelPickerOpen.value = !modelPickerOpen.value
  pickedVendor.value = null
}

/** F轮：有可选挡位才显示强度选择器（否则该模型不支持思考，不摆空架子）。
 *  ★1013（已定案："以前可以选用全局模型的，都要换成后台模型"）：这一档现在对应**后台模型**，
 *  挡位与取值都看后台模型（原来读全局模型 —— 那概念已经从 UI 拿掉了）。 */
const globalEffortVisible = computed(() =>
  providersStore.modelEfforts(providersStore.backgroundProviderId, providersStore.backgroundModelId).length > 1,
)

/* ── 操作 ── */
async function toggleTask(task: Task) {
  busyId.value = task.id
  try {
    await rpc('task.update', { id: task.id, enabled: !task.enabled })
    await loadTasks()
  } finally { busyId.value = '' }
}

async function runNow(task: Task) {
  busyId.value = task.id
  try {
    const r = await rpc('task.runNow', { id: task.id })
    if (r && r.ok === false) lastError.value = String(r.error || '执行失败')
    await loadTasks()
  } catch (e: any) {
    lastError.value = String(e?.message || e).slice(0, 200)
  } finally { busyId.value = '' }
}

const removeTarget = ref<Task | null>(null)
async function doRemove() {
  const task = removeTarget.value
  if (!task) return
  busyId.value = task.id
  try {
    await rpc('task.remove', { id: task.id })
    removeTarget.value = null
    await loadTasks()
  } finally { busyId.value = '' }
}

/* ── 新建 / 编辑弹窗 ── */
const editorOpen = ref(false)
const editingId = ref('')
const saving = ref(false)
const form = ref({
  name: '',
  prompt: '',
  targetSessionId: 'own',
  notifyKeys: [] as string[],
  /** 任务模型（0912）：'global' 跟随全局模型 / 'custom' 自选 */
  modelMode: 'global' as 'global' | 'custom',
  modelId: '',
  modelProviderId: '',
  /** F轮：自选模型推理强度（空=跟随模型默认） */
  modelEffort: '',
  kind: 'daily' as TaskSchedule['kind'],
  at: '',
  interval: 1,
  time: '09:00',
  weekdays: [1] as number[],
  dayOfMonth: 1,
})

/** 可选的会话（最近 30 个，供"固定某个对话"用） */
const sessionOptions = computed(() =>
  (conversationsStore.conversations || []).slice(0, 30).map((c: any) => ({ id: c.id, title: c.title || c.id.slice(0, 8) }))
)

/**
 * 「完成后通知」的候选目标（0912 十三批）。
 * 口径由后端定：只有**聊过**的通道对端才拿得到推送 id（QQ=openid / 微信=user_id）。
 * key = channel:botId:peerId，提交时按 key 反查回完整目标。
 */
interface NotifyOption extends TaskNotifyTarget { key: string; lastAt: number; passiveWindow?: boolean }
const notifyOptions = ref<NotifyOption[]>([])

async function loadNotifyTargets() {
  if (!chatStore.wsConnected) return
  try {
    const r = await rpc('task.notifyTargets', {})
    notifyOptions.value = (Array.isArray(r?.targets) ? r.targets : []).map((x: any) => ({
      key: `${x.channel}:${x.botId}:${x.peerId}`,
      channel: x.channel, botId: x.botId, peerId: x.peerId,
      kind: x.kind || '', label: x.label || '',
      // 二十一批：分组与短名（分节标题 = groupLabel；chip 文本 = peerLabel）
      botName: x.botName || '', peerLabel: x.peerLabel || '',
      groupKey: x.groupKey || '', groupLabel: x.groupLabel || '',
      lastAt: x.lastAt || 0, passiveWindow: !!x.passiveWindow,
    }))
  } catch { notifyOptions.value = [] }
}

function toggleNotify(key: string) {
  const arr = form.value.notifyKeys
  const i = arr.indexOf(key)
  if (i >= 0) arr.splice(i, 1)
  else arr.push(key)
}
const allNotifyOn = computed(() =>
  notifyOptions.value.length > 0 && form.value.notifyKeys.length === notifyOptions.value.length
)
function toggleAllNotify() {
  form.value.notifyKeys = allNotifyOn.value ? [] : notifyOptions.value.map(o => o.key)
}

/** 只选私聊（最常用诉求：「只发给我自己」）—— 群聊目标群里所有人都能看到，容易误选 */
const privateOnly = computed(() => notifyOptions.value.filter(o => o.kind !== 'group'))
function selectPrivateOnly() {
  form.value.notifyKeys = privateOnly.value.map(o => o.key)
}
/** 已选中的目标里是否含群聊（含则给一条醒目提示） */
const hasGroupSelected = computed(() =>
  form.value.notifyKeys.some(k => notifyOptions.value.find(o => o.key === k)?.kind === 'group')
)
/** chip 图标：微信 / QQ私聊 / QQ群聊 / 列表通知 —— 群聊与列表必须一眼能认出来 */
function chipIcon(o: NotifyOption): string {
  if (o.channel === 'list') return 'fas fa-list'
  if (o.channel === 'wechat') return 'fab fa-weixin'
  return o.kind === 'group' ? 'fas fa-users' : 'fab fa-qq'
}
function chipTitle(o: NotifyOption): string {
  if (o.channel === 'list') return t('tasks.tipList')
  const parts = [o.kind === 'group' ? t('tasks.tipGroup') : t('tasks.tipPrivate')]
  if (o.passiveWindow) parts.push(t('tasks.fNotifyWindow'))
  return parts.join('\n')
}
/** 位置显示名：优先 peerLabel（群名/私聊编号），兼容老数据用整段 label */
function chipText(o: NotifyOption): string {
  return o.peerLabel || o.label || o.peerId
}

/**
 * 二十一批：通知位置**分类显示**（用户要求）——
 * 列表一类、微信一类、QQ机器人1一类、QQ机器人2一类…每个机器人下面才是
 * 「私聊 / 群聊名」。顺序：列表 → 微信 → 各 QQ 机器人（按最近活跃）。
 */
const notifyGroups = computed(() => {
  const map = new Map<string, { key: string; label: string; items: NotifyOption[] }>()
  for (const o of notifyOptions.value) {
    const anyO = o as any
    const gk = anyO.groupKey || (o.channel === 'wechat' ? 'wechat' : o.channel === 'list' ? 'list' : `qq:${o.botId}`)
    const gl = anyO.groupLabel || (o.channel === 'wechat' ? '微信' : o.channel === 'list' ? t('tasks.fNotifySectionList') : `QQ · ${o.botName || o.botId}`)
    if (!map.has(gk)) map.set(gk, { key: gk, label: gl, items: [] })
    map.get(gk)!.items.push(o)
  }
  const rank = (k: string) => (k === 'list' ? 0 : k === 'wechat' ? 1 : 2)
  return [...map.values()].sort((a, b) => {
    const r = rank(a.key) - rank(b.key)
    if (r) return r
    const la = Math.max(...a.items.map(i => i.lastAt || 0), 0)
    const lb = Math.max(...b.items.map(i => i.lastAt || 0), 0)
    return lb - la
  })
})

function openEditor(task?: Task) {
  void loadNotifyTargets()
  if (task) {
    editingId.value = task.id
    form.value = {
      name: task.name,
      prompt: task.prompt,
      targetSessionId: task.targetSessionId || 'own',
      notifyKeys: (task.notifyTargets || []).map(x => `${x.channel}:${x.botId}:${x.peerId}`),
      modelMode: task.modelMode === 'custom' ? 'custom' : 'global',
      modelId: task.modelId || '',
      modelProviderId: task.modelProviderId || '',
      modelEffort: task.modelEffort || '',
      kind: task.schedule.kind,
      at: task.schedule.at || '',
      interval: task.schedule.interval || 1,
      time: task.schedule.time || '09:00',
      weekdays: task.schedule.weekdays?.length ? [...task.schedule.weekdays] : [1],
      dayOfMonth: task.schedule.dayOfMonth || 1,
    }
  } else {
    editingId.value = ''
    form.value = {
      name: '', prompt: '', targetSessionId: 'own', notifyKeys: [],
      modelMode: 'global', modelId: '', modelProviderId: '', modelEffort: '',
      kind: 'daily', at: '', interval: 1, time: '09:00', weekdays: [1], dayOfMonth: 1,
    }
  }
  editorOpen.value = true
}

function closeEditor() { editorOpen.value = false }

function toggleWeekday(d: number) {
  const arr = form.value.weekdays
  const i = arr.indexOf(d)
  if (i >= 0) { if (arr.length > 1) arr.splice(i, 1) } else arr.push(d)
}

const canSave = computed(() => {
  if (!form.value.name.trim() || !form.value.prompt.trim()) return false
  // 自选模型必须真的选了一个（否则执行时必然报错，不如保存前拦住）
  if (form.value.modelMode === 'custom' && (!form.value.modelId || !form.value.modelProviderId)) return false
  return true
})

/* ★0927 netfix：候选未加载/键不匹配时按 key（channel:botId:peerId…）解析，绝不静默丢通知目标
   （原 filter(Boolean) 把解析不到的直接丢掉 → 编辑保存后通知目标被清空） */
function parseNotifyKeyFallback(k: string) {
  const [channel = '', botId = '', ...rest] = String(k || '').split(':')
  return { key: String(k || ''), channel, botId, peerId: rest.join(':'), kind: '', label: '' }
}

async function saveTask() {
  if (!canSave.value || saving.value) return
  saving.value = true
  try {
    const schedule: TaskSchedule = { kind: form.value.kind }
    if (form.value.kind === 'once') schedule.at = form.value.at || ''
    if (form.value.kind !== 'once') schedule.interval = Math.max(1, Number(form.value.interval) || 1)
    if (['daily', 'weekly', 'monthly'].includes(form.value.kind)) schedule.time = form.value.time || '09:00'
    if (form.value.kind === 'weekly') schedule.weekdays = [...form.value.weekdays]
    if (form.value.kind === 'monthly') schedule.dayOfMonth = Math.max(1, Math.min(28, Number(form.value.dayOfMonth) || 1))

    const payload = {
      name: form.value.name.trim(),
      prompt: form.value.prompt.trim(),
      targetSessionId: form.value.targetSessionId || 'own',
      modelMode: form.value.modelMode,
      modelId: form.value.modelMode === 'custom' ? form.value.modelId : undefined,
      modelProviderId: form.value.modelMode === 'custom' ? form.value.modelProviderId : undefined,
      modelEffort: form.value.modelMode === 'custom' ? (form.value.modelEffort || undefined) : undefined,
      schedule,
      notifyTargets: form.value.notifyKeys
        .map(k => notifyOptions.value.find(o => o.key === k) || parseNotifyKeyFallback(k))
        .filter(Boolean)
        .map(o => ({ channel: o!.channel, botId: o!.botId, peerId: o!.peerId, kind: o!.kind || '', label: o!.label || '' })),
    }
    if (editingId.value) await rpc('task.update', { id: editingId.value, ...payload })
    else await rpc('task.create', payload)
    editorOpen.value = false
    await loadTasks()
  } catch (e: any) {
    lastError.value = String(e?.message || e).slice(0, 200)
  } finally { saving.value = false }
}

/* ── 0912 十九批：支线清单（每个通知位置一条独立上下文）── */

/** 展开了「查看列表」的任务 id */
const openBranches = ref('')
function toggleBranches(task: Task) {
  openBranches.value = openBranches.value === task.id ? '' : task.id
}

/**
 * 「在对话中查看」：把该支线放进主对话列表并打开它。
 * 等价于 qq/微信弹窗里的「移到聊天列表」，只是这条支线同时保留 ⏰ 与任务归属。
 */
async function viewBranchInChat(task: Task, sid: string) {
  if (!sid) return
  busyId.value = task.id
  try {
    await conversationsStore.setTaskSessionInList(sid, true)
    await conversationsStore.openConversation(sid)
    close()
  } catch (e: any) {
    lastError.value = String(e?.message || e).slice(0, 200)
  } finally { busyId.value = '' }
}

/** 「放回定时任务」：移出主列表（会话保留，任务卡片里仍能打开） */
async function parkBranch(task: Task, b: TaskBranch) {
  busyId.value = task.id
  try {
    await conversationsStore.setTaskSessionInList(b.sessionId, false)
    await loadTasks()
  } catch (e: any) {
    lastError.value = String(e?.message || e).slice(0, 200)
  } finally { busyId.value = '' }
}

function branchTime(ts: number): string {
  if (!ts) return '—'
  return fmtTime(ts)
}

/* ── 弹窗开关（沿用原动画）── */
watch(() => props.open, (val) => {
  if (val) {
    isClosing.value = false
    showModal.value = true
    isAnimating.value = true
    setTimeout(() => { isAnimating.value = false }, 450)
    void loadTasks()
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
  if (editorOpen.value) { editorOpen.value = false; return }
  if (removeTarget.value) { removeTarget.value = null; return }
  close()
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
}

onMounted(() => document.addEventListener('keydown', handleKeydown))
onUnmounted(() => document.removeEventListener('keydown', handleKeydown))

/** 打开时拉一次会话列表（选目标会话用） */
watch(() => props.open, (v) => { if (v) void conversationsStore.loadConversations() })
</script>

<template>
  <Teleport to="body">
    <div
      v-if="showModal"
      :class="['fixed inset-0 z-40 bg-black/30', isClosing ? 'backdrop-fade-out' : 'backdrop-fade-in']"
    ></div>

    <div v-if="showModal" class="fixed inset-0 z-50 flex items-start justify-center pt-[8vh]">
      <div class="relative flex flex-col items-center">
        <div
          :class="['dock-modal', isAnimating && !isClosing ? 'dock-in' : '', isClosing ? 'dock-out' : '']"
          class="relative w-[957px] max-w-[94vw] h-[82vh] bg-white rounded-[20px] shadow-[0_24px_70px_-20px_rgba(0,0,0,0.25)] border-[1.5px] border-gray-200 overflow-hidden flex flex-col"
        >
          <div class="px-7 pt-6 pb-4 border-b-[1.5px] border-gray-100 flex items-center justify-between shrink-0">
            <h2 class="text-base font-bold text-gray-900 tracking-tight">
              {{ t('tasks.title') }}
              <span v-if="tasks.length" class="text-gray-400 font-normal text-sm ml-1.5">{{ tasks.length }}</span>
            </h2>
            <button class="tk-btn-primary" @click="openEditor()">
              <i class="fas fa-plus text-[9px]"></i> {{ t('tasks.create') }}
            </button>
          </div>

          <div class="flex-1 min-h-0 px-7 py-6 overflow-y-auto custom-scroll">
            <p v-if="lastError" class="tk-error mb-3">{{ lastError }}</p>

            <!-- 空状态 -->
            <div v-if="!tasks.length && !loading" class="tk-empty">
              <i class="fas fa-clock text-[30px] text-gray-300"></i>
              <p class="text-sm text-gray-500 mt-3">{{ t('tasks.empty') }}</p>
              <p class="text-xs text-gray-400 mt-1.5 text-center leading-relaxed px-8">{{ t('tasks.emptyHint') }}</p>
              <button class="tk-btn-primary mt-4" @click="openEditor()">
                <i class="fas fa-plus text-[9px]"></i> {{ t('tasks.create') }}
              </button>
            </div>

            <!-- 任务列表 -->
            <div v-else class="grid grid-cols-2 gap-3">
              <div
                v-for="task in tasks"
                :key="task.id"
                class="tk-card"
                :class="{ 'is-off': !task.enabled }"
              >
                <div class="flex items-start gap-3">
                  <div class="tk-icon" :class="{ 'is-on': task.enabled }">
                    <i class="fas fa-clock text-[16px]"></i>
                  </div>
                  <div class="flex-1 min-w-0">
                    <div class="text-sm font-[640] text-gray-900 truncate" :title="task.name">{{ task.name }}</div>
                    <div class="text-xs text-gray-500 mt-1 line-clamp-2" :title="task.prompt">{{ task.prompt }}</div>
                  </div>
                </div>

                <div class="tk-meta">
                  <span class="tk-chip"><i class="fas fa-repeat text-[9px] mr-1"></i>{{ describe(task.schedule) }}</span>
                  <span v-if="task.enabled" class="tk-chip is-next">{{ t('tasks.nextRun') }}{{ fmtTime(task.nextRunAt) }}</span>
                  <span
                    v-if="task.notifyTargets?.length"
                    class="tk-chip is-notify"
                    :title="notifyLabel(task)"
                  >
                    <i class="fas fa-paper-plane text-[9px] mr-1"></i>{{ t('tasks.cardNotify') }} {{ task.notifyTargets.length }}
                  </span>
                </div>

                <div v-if="task.lastError" class="tk-last-error" :title="task.lastError">
                  <i class="fas fa-triangle-exclamation text-[9px] mr-1"></i>{{ task.lastError }}
                </div>
                <div v-else-if="task.lastRunAt" class="tk-last">
                  {{ t('tasks.lastRun') }}{{ fmtTime(task.lastRunAt) }}
                </div>

                <!-- 0912 十九批：任务的动作区（在对话中查看 / 查看列表） -->
                <div class="tk-actions">
                  <button
                    v-if="task.lastSessionId || task.branches?.length"
                    class="tk-link-btn"
                    :disabled="busyId === task.id"
                    @click="viewBranchInChat(task, task.execSessionId || task.branches?.[0]?.sessionId || task.lastSessionId || '')"
                  >
                    <i class="fas fa-comment-dots text-[9px] mr-1"></i>{{ t('tasks.openInChat') }}
                  </button>
                  <button
                    v-if="task.branches?.length"
                    class="tk-link-btn"
                    @click="toggleBranches(task)"
                  >
                    <i :class="['text-[9px] mr-1', openBranches === task.id ? 'fas fa-chevron-up' : 'fas fa-list']"></i>
                    {{ t('tasks.branchList', { n: task.branches.length }) }}
                  </button>
                </div>

                <!-- 支线清单：每个通知位置一条，各自独立上下文 -->
                <div v-if="openBranches === task.id && task.branches?.length" class="tk-branches">
                  <div v-for="b in task.branches" :key="b.sessionId" class="tk-branch">
                    <div class="flex items-center gap-1.5 min-w-0">
                      <i class="fas fa-clock text-[9px] text-amber-600 shrink-0"></i>
                      <span class="text-[11px] font-[530] text-gray-800 truncate">{{ b.label }}</span>
                      <span v-if="b.isExec" class="tk-chip-mini">{{ t('tasks.branchExec') }}</span>
                      <span v-if="b.inList" class="tk-chip-mini is-on">{{ t('tasks.branchInList') }}</span>
                    </div>
                    <div class="text-[10px] text-gray-400 truncate mt-0.5">{{ b.lastMessage || t('channel.emptyContent') }}</div>
                    <div class="flex items-center gap-2 mt-1.5">
                      <button class="tk-link-btn" :disabled="busyId === task.id || !b.exists" @click="viewBranchInChat(task, b.sessionId)">
                        {{ t('tasks.openInChat') }}
                      </button>
                      <button v-if="b.inList" class="tk-link-btn" :disabled="busyId === task.id" @click="parkBranch(task, b)">
                        {{ t('ctx.parkTaskSession') }}
                      </button>
                      <span class="flex-1"></span>
                      <span class="text-[10px] text-gray-400">{{ branchTime(b.updatedAt) }}</span>
                    </div>
                  </div>
                </div>

                <div class="flex items-center justify-between gap-2 mt-3">
                  <span :class="['tk-status', task.enabled ? 'is-on' : '']">
                    {{ task.enabled ? t('tasks.running') : t('tasks.paused') }}
                  </span>
                  <div class="flex items-center gap-1.5">
                    <!-- 图标必须一眼可辨（0912 十七批）：早期「立即执行」和「恢复」都是 ▶，暂停态下两颗按钮长得一样 -->
                    <button class="tk-btn-mini is-run" :disabled="busyId === task.id" @click="runNow(task)" :title="t('tasks.runNow')">
                      <i class="fas fa-bolt text-[9px]"></i>
                    </button>
                    <button class="tk-btn-mini" :disabled="busyId === task.id" @click="toggleTask(task)" :title="task.enabled ? t('tasks.pause') : t('tasks.resume')">
                      <i :class="['text-[9px]', task.enabled ? 'fas fa-pause' : 'fas fa-circle-play']"></i>
                    </button>
                    <button class="tk-btn-mini" @click="openEditor(task)" :title="t('tasks.edit')">
                      <i class="fas fa-pen text-[9px]"></i>
                    </button>
                    <button class="tk-btn-mini is-danger" @click="removeTarget = task" :title="t('tasks.delete')">
                      <i class="fas fa-trash text-[9px]"></i>
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <button
          @click="close"
          :class="['close-btn', isAnimating && !isClosing ? 'close-in' : '', isClosing ? 'close-out' : '']"
          class="w-9 h-9 flex items-center justify-center bg-white border border-gray-200 text-gray-400 hover:text-gray-600 hover:shadow-md rounded-full shadow-sm mt-4"
        >
          <i class="fas fa-times text-sm"></i>
        </button>
      </div>
    </div>

    <!-- ══ 新建 / 编辑任务 ══ -->
    <div v-if="editorOpen" class="fixed inset-0 z-[60] bg-black/35 flex items-center justify-center" @click.self="closeEditor">
      <div class="tk-editor">
        <div class="flex items-center justify-between px-5 pt-4 pb-2 shrink-0">
          <h3 class="text-sm font-bold text-gray-900">{{ editingId ? t('tasks.editTitle') : t('tasks.create') }}</h3>
          <button class="tk-close" @click="closeEditor"><i class="fas fa-times text-xs"></i></button>
        </div>

        <div class="tk-editor-body">
          <div>
            <div class="tk-label">{{ t('tasks.fName') }}</div>
            <input v-model="form.name" class="tk-input" :placeholder="t('tasks.fNamePh')" />
          </div>
          <div>
            <div class="tk-label">{{ t('tasks.fPrompt') }}</div>
            <textarea v-model="form.prompt" class="tk-input tk-textarea" rows="3" :placeholder="t('tasks.fPromptPh')"></textarea>
          </div>

          <div>
            <div class="tk-label">{{ t('tasks.fSchedule') }}</div>
            <div class="tk-seg">
              <button
                v-for="k in (['once', 'hourly', 'daily', 'weekly', 'monthly'] as const)"
                :key="k"
                class="tk-seg-btn"
                :class="{ 'is-on': form.kind === k }"
                @click="form.kind = k"
              >{{ t('tasks.k' + k.charAt(0).toUpperCase() + k.slice(1)) }}</button>
            </div>
          </div>

          <!-- 单次：datetime -->
          <div v-if="form.kind === 'once'">
            <div class="tk-label">{{ t('tasks.fAt') }}</div>
            <input v-model="form.at" type="datetime-local" class="tk-input" />
          </div>

          <!-- 间隔（非单次） -->
          <div v-if="form.kind !== 'once'" class="flex items-center gap-2">
            <span class="tk-label mb-0">{{ t('tasks.fEvery') }}</span>
            <input v-model.number="form.interval" type="number" min="1" max="365" class="tk-input tk-num" />
            <span class="text-xs text-gray-500">
              {{ form.kind === 'hourly' ? t('tasks.unitHour') : form.kind === 'daily' ? t('tasks.unitDay') : form.kind === 'weekly' ? t('tasks.unitWeek') : t('tasks.unitMonth') }}
            </span>
          </div>

          <!-- 周几 -->
          <div v-if="form.kind === 'weekly'">
            <div class="tk-label">{{ t('tasks.fWeekdays') }}</div>
            <div class="flex gap-1.5">
              <button
                v-for="(n, i) in WD()"
                :key="i"
                class="tk-wd"
                :class="{ 'is-on': form.weekdays.includes(i) }"
                @click="toggleWeekday(i)"
              >{{ n.replace('周', '') }}</button>
            </div>
          </div>

          <!-- 几号 -->
          <div v-if="form.kind === 'monthly'" class="flex items-center gap-2">
            <span class="tk-label mb-0">{{ t('tasks.fDayOfMonth') }}</span>
            <input v-model.number="form.dayOfMonth" type="number" min="1" max="28" class="tk-input tk-num" />
            <span class="text-xs text-gray-500">{{ t('tasks.dayUnit') }}</span>
          </div>

          <!-- 时刻 -->
          <div v-if="['daily', 'weekly', 'monthly'].includes(form.kind)" class="flex items-center gap-2">
            <span class="tk-label mb-0">{{ t('tasks.fTime') }}</span>
            <input v-model="form.time" type="time" class="tk-input tk-time" />
          </div>

          <div>
            <div class="tk-label">{{ t('tasks.fTarget') }}</div>
            <select v-model="form.targetSessionId" class="tk-input tk-select">
              <option value="own">{{ t('tasks.fTargetOwn') }}</option>
              <option value="new">{{ t('tasks.fTargetNew') }}</option>
              <option v-for="s in sessionOptions" :key="s.id" :value="s.id">{{ s.title }}</option>
            </select>
            <p class="tk-hint">{{ t('tasks.fTargetHint') }}</p>
          </div>

          <!-- 任务模型（0912）：全局模型 or 自选 -->
          <div>
            <div class="tk-label">{{ t('tasks.fModel') }}</div>
            <div class="tk-model-row">
              <button
                class="tk-model-mode"
                :class="{ 'is-on': form.modelMode === 'global' }"
                @click="form.modelMode = 'global'"
              >{{ t('tasks.fModelGlobal') }}</button>
              <button
                class="tk-model-mode"
                :class="{ 'is-on': form.modelMode === 'custom' }"
                @click="form.modelMode = 'custom'"
              >{{ t('tasks.fModelCustom') }}</button>
            </div>
            <!-- 全局模型：只读展示当前值；未选 → 明确提示（执行时会报错） -->
            <div v-if="form.modelMode === 'global'" class="tk-model-cur">
              <i class="fas fa-globe text-[10px] mr-1 text-gray-400"></i>{{ globalModelLabel }}
              <span v-if="!providersStore.backgroundModelId" class="tk-model-warn">{{ t('tasks.fModelGlobalWarn') }}</span>
            </div>
            <!-- 自选：厂商 dock + 模型列表 -->
            <div v-else class="relative">
              <button class="tk-model-pick" @click="openModelPicker">
                <span class="truncate">{{ customModelLabel }}</span>
                <i class="fas fa-chevron-down text-[9px] text-gray-400 shrink-0"></i>
              </button>
              <div v-if="modelPickerOpen" class="tk-model-pop">
                <div v-if="modelVendors.length" class="flex flex-wrap items-center gap-1.5 p-2">
                  <button
                    v-for="v in modelVendors"
                    :key="v.id"
                    class="tk-vendor"
                    :class="{ 'is-on': pickedVendor === v.id }"
                    :title="v.name"
                    @click="pickedVendor = pickedVendor === v.id ? null : v.id"
                  >
                    <VendorLogo :name="v.name" :src="v.logo" :size="22" />
                  </button>
                </div>
                <div v-if="pickedVendor" class="max-h-[180px] overflow-y-auto p-1.5">
                  <button
                    v-for="m in textModelsOf(pickedVendor)"
                    :key="m.id"
                    class="tk-model-item"
                    :class="{ 'is-on': form.modelId === m.id }"
                    @click="pickCustomModel(m.id, pickedVendor!)"
                  >
                    <div class="flex-1 min-w-0 text-left">
                      <div class="text-[11px] font-medium truncate">{{ m.name || m.id }}</div>
                      <div class="text-[10px] text-gray-400 truncate">{{ m.id }}</div>
                    </div>
                    <i v-if="form.modelId === m.id" class="fas fa-check text-[9px] text-blue-500"></i>
                  </button>
                </div>
                <div v-else-if="modelVendors.length" class="px-3 py-2 text-[11px] text-gray-400 text-center">
                  {{ t('tasks.fModelPickVendor') }}
                </div>
                <div v-else class="px-4 py-3 text-xs text-gray-400 text-center">{{ t('tasks.fModelEmpty') }}</div>
              </div>
            </div>
            <!-- F轮：推理强度。全局模式只看不选（用全局强度）；自选模式可单独指定 -->
            <div class="tk-eff-row">
              <span class="tk-eff-label">{{ t('effort.label') }}</span>
              <EffortPicker
                v-if="form.modelMode === 'custom' && form.modelId"
                :model-value="form.modelEffort || null"
                :provider-id="form.modelProviderId"
                :model-id="form.modelId"
                @update:model-value="(v: string | null) => (form.modelEffort = v || '')"
              />
              <template v-else>
                <!-- ★1013（已定案）：这一档的强度取的也是「后台模型」的强度 ——
                     与 设置 → 人格 → 后台模型 右侧那颗强度胶囊是同一个值（单一真相）。 -->
                <EffortPicker
                  v-if="globalEffortVisible"
                  :model-value="providersStore.backgroundEffort || null"
                  :provider-id="providersStore.backgroundProviderId"
                  :model-id="providersStore.backgroundModelId"
                  @update:model-value="(v: string | null) => providersStore.setBackgroundModel(providersStore.backgroundProviderId, providersStore.backgroundModelId, v)"
                />
                <span v-else class="tk-eff-na">—</span>
              </template>
            </div>
            <p class="tk-hint">{{ t('tasks.fModelHint') }}</p>
          </div>

          <!-- 完成后通知（0912 十三批）：结果推到微信 / QQ 机器人；群聊目标一眼可辨（十四批） -->
          <div>
            <div class="tk-label flex items-center justify-between">
              <span>{{ t('tasks.fNotify') }}</span>
              <span class="flex items-center gap-2">
                <button
                  v-if="privateOnly.length && privateOnly.length < notifyOptions.length"
                  class="tk-link"
                  @click="selectPrivateOnly"
                >{{ t('tasks.fNotifyPrivateOnly') }}</button>
                <button v-if="notifyOptions.length > 1" class="tk-link" @click="toggleAllNotify">
                  {{ allNotifyOn ? t('tasks.fNotifyNone') : t('tasks.fNotifyAll') }}
                </button>
              </span>
            </div>
            <div v-if="notifyOptions.length" class="tk-notify-groups">
              <!-- 二十一批：按「列表 / 微信 / QQ机器人N」分节，节内才是 私聊/群聊名 -->
              <div v-for="g in notifyGroups" :key="g.key" class="tk-notify-group">
                <div class="tk-notify-group-title">{{ g.label }}</div>
                <div class="tk-chips">
                  <button
                    v-for="o in g.items"
                    :key="o.key"
                    class="tk-chip-btn"
                    :class="{ 'is-on': form.notifyKeys.includes(o.key), 'is-group': o.kind === 'group' }"
                    :title="chipTitle(o)"
                    @click="toggleNotify(o.key)"
                  >
                    <i :class="['text-[9px] mr-1', chipIcon(o)]"></i>{{ chipText(o) }}
                  </button>
                </div>
              </div>
            </div>
            <p v-else class="tk-hint">{{ t('tasks.fNotifyEmpty') }}</p>
            <p v-if="hasGroupSelected" class="tk-warn">{{ t('tasks.fNotifyGroupWarn') }}</p>
            <p v-if="notifyOptions.length" class="tk-hint">{{ t('tasks.fNotifyHint') }}</p>
          </div>
        </div>

        <div class="px-5 py-3.5 flex gap-2 shrink-0 border-t border-gray-100">
          <button class="tk-btn-primary flex-1" :disabled="!canSave || saving" @click="saveTask">
            <i v-if="saving" class="fas fa-spinner fa-spin text-[10px]"></i>
            <span>{{ t('tasks.save') }}</span>
          </button>
          <button class="tk-btn-plain flex-1" @click="closeEditor">{{ t('tasks.cancel') }}</button>
        </div>
      </div>
    </div>

    <!-- ══ 删除确认 ══ -->
    <div v-if="removeTarget" class="fixed inset-0 z-[65] bg-black/40 flex items-center justify-center" @click.self="removeTarget = null">
      <div class="tk-confirm">
        <div class="flex items-center gap-2.5 mb-2">
          <span class="tk-confirm-icon"><i class="fas fa-trash text-[12px]"></i></span>
          <h3 class="text-sm font-[640] text-gray-900 flex-1">{{ t('tasks.deleteTitle') }}</h3>
        </div>
        <p class="text-xs text-gray-600 leading-relaxed mb-3">{{ t('tasks.deleteBody', { name: removeTarget.name }) }}</p>
        <div class="flex gap-2">
          <button class="tk-btn-danger flex-1" :disabled="busyId === removeTarget.id" @click="doRemove">{{ t('tasks.delete') }}</button>
          <button class="tk-btn-plain flex-1" @click="removeTarget = null">{{ t('tasks.cancel') }}</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.backdrop-fade-in { animation: backdropFadeIn 0.3s ease forwards; }
.backdrop-fade-out { animation: backdropFadeOut 0.3s ease forwards; }
@keyframes backdropFadeIn { from { opacity: 0; } to { opacity: 1; } }
@keyframes backdropFadeOut { from { opacity: 1; } to { opacity: 0; } }

.dock-in { animation: dockExpand 0.45s cubic-bezier(0.34, 1.6, 0.64, 1) forwards; }
.dock-out { animation: dockCollapse 0.3s cubic-bezier(0.4, 0, 0.2, 1) forwards; }
@keyframes dockExpand {
  0% { opacity: 0; transform: scale(0.05) rotateX(8deg) translateY(-20px); transform-origin: top left; filter: blur(4px); }
  50% { opacity: 1; filter: blur(0); }
  70% { transform: scale(1.02) rotateX(-1deg) translateY(0); }
  100% { opacity: 1; transform: scale(1) rotateX(0) translateY(0); filter: blur(0); }
}
@keyframes dockCollapse {
  0% { opacity: 1; transform: scale(1) rotateX(0) translateY(0); filter: blur(0); }
  100% { opacity: 0; transform: scale(0.05) rotateX(8deg) translateY(-20px); transform-origin: top left; filter: blur(4px); }
}

.close-in { animation: closeBtnIn 0.5s cubic-bezier(0.34, 1.6, 0.64, 1) 0.3s both; }
.close-out { animation: closeBtnOut 0.2s cubic-bezier(0.4, 0, 1, 1) both; }
@keyframes closeBtnIn {
  0% { opacity: 0; transform: translateY(40px); }
  60% { opacity: 1; transform: translateY(-6px); }
  100% { transform: translateY(0); }
}
@keyframes closeBtnOut {
  0% { opacity: 1; transform: translateY(0); }
  100% { opacity: 0; transform: translateY(40px); }
}

/* ── 卡片 ── */
.tk-card {
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 16px;
  padding: 14px 15px 12px;
  transition: box-shadow 0.2s ease, transform 0.2s ease, border-color 0.2s ease;
}
.tk-card:hover { box-shadow: 0 12px 32px -14px rgba(0, 0, 0, 0.2); transform: translateY(-1px); border-color: #d1d5db; }
.tk-card.is-off { opacity: 0.62; }
.tk-icon {
  width: 38px; height: 38px;
  border-radius: 50%;
  background: #f3f4f6;
  color: #9ca3af;
  display: flex; align-items: center; justify-content: center;
  flex: none;
}
.tk-icon.is-on { background: #ecfdf5; color: #10b981; }

.tk-meta { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
.tk-chip {
  font-size: 10px;
  padding: 2px 7px;
  border-radius: 999px;
  background: #f3f4f6;
  color: #6b7280;
  border: 1px solid #e5e7eb;
}
.tk-chip.is-next { background: #eff6ff; color: #2563eb; border-color: #bfdbfe; }
.tk-chip.is-notify { background: #f5f3ff; color: #7c3aed; border-color: #ddd6fe; }

/* 通知目标多选（编辑弹窗） */
.tk-hint { font-size: 10px; color: #9ca3af; margin-top: 5px; line-height: 1.6; }

/* ── 任务模型选择（0912）── */
.tk-model-row { display: flex; gap: 6px; margin-top: 6px; }
.tk-model-mode {
  flex: 1; padding: 6px 10px; border-radius: 8px; font-size: 12px;
  border: 1px solid #e5e7eb; background: #fff; color: #6b7280; cursor: pointer;
  transition: all .15s;
}
.tk-model-mode:hover { border-color: #c9cbd1; }
.tk-model-mode.is-on { background: #f2f2f6; border-color: #f2f2f6; color: #1b1b1f; font-weight: 600; }
.tk-model-cur {
  display: flex; align-items: center; margin-top: 8px; padding: 7px 10px;
  border-radius: 8px; background: #f6f6f8; font-size: 12px; color: #4b5563;
}
.tk-model-warn { margin-left: 8px; color: #d97706; font-size: 11px; }
.tk-model-pick {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  width: 100%; margin-top: 8px; padding: 7px 10px; border-radius: 8px;
  border: 1px solid #e5e7eb; background: #fff; font-size: 12px; color: #374151;
  cursor: pointer; text-align: left;
}
.tk-model-pick:hover { border-color: #9ca3af; }
.tk-model-pop {
  position: absolute; left: 0; right: 0; top: 100%; margin-top: 6px; z-index: 60;
  background: #fff; border: 1px solid #e5e7eb; border-radius: 10px;
  box-shadow: 0 12px 32px rgba(0,0,0,.14); overflow: hidden;
}
.tk-vendor {
  width: 34px; height: 34px; display: flex; align-items: center; justify-content: center;
  border-radius: 999px; border: none; background: transparent; cursor: pointer; transition: all .15s;
}
.tk-vendor:hover { background: #f3f4f6; transform: scale(1.08); }
.tk-vendor.is-on { background: #eceef2; box-shadow: inset 0 0 0 1px #d6d9df; }
.tk-model-item {
  display: flex; align-items: center; gap: 8px; width: 100%;
  padding: 6px 8px; border-radius: 8px; border: none; background: transparent; cursor: pointer;
}
.tk-model-item:hover { background: #f5f6f8; }
.tk-model-item.is-on { background: #eef4ff; }
/* F轮：推理强度行 */
.tk-eff-row { display: flex; align-items: center; gap: 8px; margin-top: 6px; min-height: 22px; }
.tk-eff-label { font-size: 11px; color: #9ca3af; flex: none; }
.tk-eff-na { font-size: 11px; color: #c4c7ce; }
.tk-chips { display: flex; flex-wrap: wrap; gap: 6px; }
/* 二十一批：通知位置分组（列表 / 微信 / QQ机器人1 / QQ机器人2 …） */
.tk-notify-groups { display: flex; flex-direction: column; gap: 9px; }
.tk-notify-group { display: flex; flex-direction: column; gap: 5px; }
.tk-notify-group-title {
  font-size: 10px; font-weight: 640; color: #6b7280;
  display: flex; align-items: center; gap: 6px;
}
.tk-notify-group-title::after {
  content: ''; flex: 1; height: 1px; background: #f1f5f9;
}
.tk-chip-btn {
  display: inline-flex; align-items: center;
  font-size: 11px; padding: 5px 10px;
  border-radius: 999px;
  border: 1px solid #e5e7eb; background: #fff; color: #6b7280;
  cursor: pointer;
  transition: background 0.14s ease, color 0.14s ease, border-color 0.14s ease;
}
.tk-chip-btn:hover { border-color: #d1d5db; color: #111827; }
.tk-chip-btn.is-on { background: #111827; border-color: #111827; color: #fff; font-weight: 640; }
/* 群聊目标：淡琥珀底 + 未选中也能一眼认出（避免误把任务结果推到群里） */
.tk-chip-btn.is-group { background: #fffbeb; border-color: #fde68a; color: #92400e; }
.tk-chip-btn.is-group:hover { border-color: #fcd34d; color: #78350f; }
.tk-chip-btn.is-group.is-on { background: #b45309; border-color: #b45309; color: #fff; }
.tk-warn {
  font-size: 10px; line-height: 1.6; margin-top: 5px;
  color: #b45309; background: #fffbeb;
  border: 1px solid #fde68a; border-radius: 7px; padding: 5px 8px;
}

.tk-last { font-size: 10px; color: #9ca3af; margin-top: 7px; }
.tk-last-error {
  font-size: 10px;
  color: #dc2626;
  margin-top: 7px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tk-link {
  margin-left: 6px;
  color: #6366f1;
  background: none;
  border: none;
  cursor: pointer;
  font-size: 10px;
  text-decoration: underline;
  padding: 0;
}

/* ── 0912 十九批：任务动作区 + 支线清单（每个通知位置一条独立上下文）── */
.tk-actions { display: flex; align-items: center; gap: 6px; margin-top: 7px; }
.tk-link-btn {
  display: inline-flex; align-items: center;
  font-size: 10px; padding: 3px 8px; border-radius: 7px;
  color: #4f46e5; background: #eef2ff; border: 1px solid #c7d2fe;
  cursor: pointer;
  transition: background 0.14s ease;
}
.tk-link-btn:hover:not(:disabled) { background: #e0e7ff; }
.tk-link-btn:disabled { opacity: 0.45; cursor: default; }
.tk-branches {
  margin-top: 7px; padding: 7px 8px;
  background: #fafafa; border: 1px solid #f3f4f6; border-radius: 10px;
  display: flex; flex-direction: column; gap: 7px;
}
.tk-branch + .tk-branch { border-top: 1px dashed #eceef1; padding-top: 7px; }
.tk-chip-mini {
  font-size: 9px; padding: 0 5px; border-radius: 999px;
  background: #fff; border: 1px solid #e5e7eb; color: #6b7280; flex: none;
}
.tk-chip-mini.is-on { background: #ecfdf5; border-color: #a7f3d0; color: #059669; }

.tk-status {
  font-size: 10px;
  padding: 2px 8px;
  border-radius: 999px;
  font-weight: 640;
  background: #f9fafb;
  color: #6b7280;
  border: 1px solid #e5e7eb;
}
.tk-status.is-on { background: #ecfdf5; color: #059669; border-color: #a7f3d0; }

.tk-btn-mini {
  width: 24px; height: 24px;
  display: inline-flex; align-items: center; justify-content: center;
  border-radius: 7px;
  border: 1px solid #e5e7eb;
  background: #fff;
  color: #6b7280;
  cursor: pointer;
  transition: all 0.14s ease;
}
.tk-btn-mini:hover:not(:disabled) { background: #f9fafb; color: #111827; border-color: #d1d5db; }
.tk-btn-mini:disabled { opacity: 0.45; cursor: default; }
.tk-btn-mini.is-danger:hover:not(:disabled) { background: #fef2f2; color: #dc2626; border-color: #fecaca; }
/* 立即执行：闪电 + 琥珀色，与「暂停/恢复」区分开 */
.tk-btn-mini.is-run { color: #d97706; border-color: #fde68a; background: #fffbeb; }
.tk-btn-mini.is-run:hover:not(:disabled) { background: #fef3c7; color: #b45309; border-color: #fcd34d; }

.tk-btn-primary {
  display: inline-flex; align-items: center; justify-content: center; gap: 5px;
  font-size: 12px; font-weight: 640;
  color: #fff; background: #111827;
  border: none; border-radius: 9px;
  padding: 8px 14px; cursor: pointer;
  transition: background 0.14s ease;
}
.tk-btn-primary:hover:not(:disabled) { background: #374151; }
.tk-btn-primary:disabled { opacity: 0.4; cursor: not-allowed; }
.tk-btn-plain {
  display: inline-flex; align-items: center; justify-content: center; gap: 5px;
  font-size: 12px; font-weight: 530;
  color: #374151; background: #fff;
  border: 1px solid #e5e7eb; border-radius: 9px;
  padding: 8px 14px; cursor: pointer;
}
.tk-btn-plain:hover { background: #f9fafb; }
.tk-btn-danger {
  display: inline-flex; align-items: center; justify-content: center; gap: 5px;
  font-size: 12px; font-weight: 640;
  color: #fff; background: #ef4444;
  border: none; border-radius: 9px;
  padding: 8px 14px; cursor: pointer;
}
.tk-btn-danger:hover:not(:disabled) { background: #dc2626; }
.tk-btn-danger:disabled { opacity: 0.5; cursor: default; }

.tk-empty {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  padding: 70px 0;
}
.tk-error {
  font-size: 11px; color: #dc2626;
  background: #fef2f2; border: 1px solid #fecaca;
  border-radius: 9px; padding: 8px 11px;
}

/* ── 编辑弹窗 ── */
.tk-editor {
  width: 460px; max-width: 93vw; max-height: 84vh;
  display: flex; flex-direction: column;
  background: #fff; border: 1.5px solid #e5e7eb; border-radius: 18px;
  box-shadow: 0 24px 70px -20px rgba(0, 0, 0, 0.4);
  overflow: hidden;
}
.tk-editor-body {
  flex: 1; min-height: 0;
  overflow-y: auto; overflow-x: hidden;
  padding: 4px 20px 4px;
  display: flex; flex-direction: column; gap: 12px;
}
.tk-label { font-size: 11px; color: #6b7280; margin-bottom: 5px; }
.tk-input {
  width: 100%;
  font-size: 12px; color: #111827;
  background: #fff; border: 1px solid #e5e7eb; border-radius: 9px;
  padding: 8px 10px; outline: none;
  transition: border-color 0.14s ease;
}
.tk-input:focus { border-color: #9ca3af; }
.tk-textarea { resize: vertical; min-height: 62px; font-family: inherit; line-height: 1.5; }
.tk-num { width: 72px; }
.tk-time { width: 132px; }
.tk-select { cursor: pointer; }

.tk-seg {
  display: flex; gap: 3px; padding: 3px;
  background: #f3f4f6; border-radius: 9px;
}
.tk-seg-btn {
  flex: 1; min-width: 0;
  padding: 6px 4px; border: none; border-radius: 7px;
  background: transparent; color: #6b7280;
  font-size: 11px; cursor: pointer;
  transition: background 0.14s ease, color 0.14s ease;
}
.tk-seg-btn:hover { color: #111827; }
.tk-seg-btn.is-on { background: #fff; color: #111827; font-weight: 640; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08); }

.tk-wd {
  width: 30px; height: 28px;
  border-radius: 8px; border: 1px solid #e5e7eb;
  background: #fff; color: #6b7280;
  font-size: 11px; cursor: pointer;
  transition: all 0.14s ease;
}
.tk-wd:hover { border-color: #d1d5db; color: #111827; }
.tk-wd.is-on { background: #111827; border-color: #111827; color: #fff; font-weight: 640; }

.tk-close {
  width: 26px; height: 26px;
  display: inline-flex; align-items: center; justify-content: center;
  border-radius: 50%; border: none; background: #f3f4f6; color: #9ca3af;
  cursor: pointer;
}
.tk-close:hover { background: #e5e7eb; color: #4b5563; }

/* 删除确认 */
.tk-confirm {
  width: 340px; max-width: 90vw;
  padding: 16px 18px;
  background: #fff; border: 1.5px solid #e5e7eb; border-radius: 16px;
  box-shadow: 0 24px 70px -20px rgba(0, 0, 0, 0.45);
}
.tk-confirm-icon {
  width: 26px; height: 26px; border-radius: 8px;
  display: inline-flex; align-items: center; justify-content: center;
  background: #fee2e2; color: #dc2626; flex: none;
}

/* 深色模式 */
html.dark .tk-card { background: #202027; border-color: #2b2b33; }
html.dark .tk-card:hover { border-color: #34343e; }
html.dark .tk-chip { background: #26262d; border-color: #34343e; color: #9a9aa4; }
html.dark .tk-chip.is-next { background: #1b2a45; border-color: #2b4570; color: #93c5fd; }
html.dark .tk-chip.is-notify { background: #2a2340; border-color: #4c3f78; color: #c4b5fd; }
html.dark .tk-hint { color: #7c7c86; }
html.dark .tk-chip-btn { background: #202027; border-color: #34343e; color: #9a9aa4; }
html.dark .tk-chip-btn:hover { border-color: #4a4a56; color: #e9e9ef; }
html.dark .tk-chip-btn.is-on { background: #f2f2f6; border-color: #f2f2f6; color: #1b1b1f; }
html.dark .tk-chip-btn.is-group { background: #2b2314; border-color: #5a4520; color: #fcd34d; }
html.dark .tk-chip-btn.is-group.is-on { background: #b45309; border-color: #b45309; color: #fff; }
html.dark .tk-warn { background: #2b2314; border-color: #5a4520; color: #fcd34d; }
html.dark .tk-status { background: #202027; border-color: #34343e; color: #9a9aa4; }
html.dark .tk-btn-mini { background: #202027; border-color: #34343e; color: #9a9aa4; }
html.dark .tk-btn-mini:hover:not(:disabled) { background: #26262d; color: #e9e9ef; }
html.dark .tk-btn-mini.is-run { background: #2b2314; border-color: #5a4520; color: #fcd34d; }
html.dark .tk-btn-mini.is-run:hover:not(:disabled) { background: #3a2f1a; color: #fde68a; }
html.dark .tk-link-btn { background: #2a2a3d; border-color: #3f3f5a; color: #a5b4fc; }
html.dark .tk-link-btn:hover:not(:disabled) { background: #33334a; }
html.dark .tk-branches { background: #202027; border-color: #2b2b33; }
html.dark .tk-branch + .tk-branch { border-top-color: #2e2e36; }
html.dark .tk-chip-mini { background: #26262d; border-color: #34343e; color: #9a9aa4; }
html.dark .tk-chip-mini.is-on { background: #16302a; border-color: #1f4d3f; color: #34d399; }
html.dark .tk-icon { background: #26262d; color: #6b7280; }
html.dark .tk-icon.is-on { background: #16302a; color: #34d399; }
html.dark .tk-editor,
html.dark .tk-confirm { background: #1b1b1f; border-color: #2e2e36; }
html.dark .tk-input { background: #202027; border-color: #34343e; color: #e9e9ef; }
html.dark .tk-seg { background: #26262d; }
html.dark .tk-seg-btn { color: #8c8c96; }
html.dark .tk-seg-btn.is-on { background: #3a3a44; color: #f2f2f6; }
html.dark .tk-wd { background: #202027; border-color: #34343e; color: #9a9aa4; }
html.dark .tk-wd.is-on { background: #f2f2f6; border-color: #f2f2f6; color: #1b1b1f; }
html.dark .tk-btn-plain { background: #202027; border-color: #34343e; color: #e9e9ef; }
html.dark .tk-close { background: #26262d; color: #8c8c96; }

/* ── 任务模型选择（0912）深色 ── */
html.dark .tk-model-mode { background: #202027; border-color: #34343e; color: #9a9aa4; }
html.dark .tk-model-mode:hover { border-color: #4a4a56; }
html.dark .tk-model-mode.is-on { background: #f2f2f6; border-color: #f2f2f6; color: #1b1b1f; }
html.dark .tk-model-cur { background: #26262d; color: #c9c9d3; }
html.dark .tk-model-warn { color: #fbbf24; }
html.dark .tk-model-pick { background: #202027; border-color: #34343e; color: #e9e9ef; }
html.dark .tk-model-pick:hover { border-color: #4a4a56; }
html.dark .tk-model-pop { background: #202027; border-color: #34343e; box-shadow: 0 12px 32px rgba(0,0,0,.5); }
html.dark .tk-vendor:hover { background: #26262d; }
html.dark .tk-vendor.is-on { background: #2e2e36; box-shadow: inset 0 0 0 1px #3f3f4a; }
html.dark .tk-model-item:hover { background: #26262d; }
html.dark .tk-model-item.is-on { background: #1b2a45; }
html.dark .tk-eff-label { color: #7a7a86; }
html.dark .tk-eff-na { color: #55555f; }
</style>
