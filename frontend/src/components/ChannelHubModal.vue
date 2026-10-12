<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { t } from '@/utils/i18n'
import { useChannelsStore, CHANNEL_META, type ChannelId, type ChannelSession } from '@/stores/channels'
import { useProvidersStore } from '@/stores/providers'
import { useAgentPresetsStore } from '@/stores/agentPresets'
import { useConversationsStore } from '@/stores/conversations'
import { useChatStore } from '@/stores/chat'
import MiniSelect from './blocks/MiniSelect.vue'
import EffortPicker from './blocks/EffortPicker.vue'
import { LoaderCircle, CircleCheck, CircleX, ChevronLeft, MessageSquare, Send, HelpCircle, ExternalLink, Power, Plus, Trash2, ArrowRightLeft, QrCode, Check, X, UserCog, Pencil } from 'lucide-vue-next'
import { swallowed } from '@/utils/swallowed'

/**
 * 接入弹窗（微信 / QQ / 远程访问）—— 0912 接入批
 *
 * 定位：**全局入口**（标题栏右上角 icon 唤起），不挂在会话上。
 * 每个 tab = 「通道状态 + 模型配置 + 独享对话列表 + 命令入口」。
 *
 * 关键设计（见 docs/通道接入设计-前端与上下文-0912.md）：
 *   通道会话就是普通会话（后端打 origin 标记）→ 这里的列表只是**过滤视图**，
 *   点开可跳回主界面继续聊（跨端接续），**不做第二套聊天 UI**。
 */
const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: []; openSession: [sessionId: string] }>()

const store = useChannelsStore()
const chatStore = useChatStore()
const providersStore = useProvidersStore()
const presetsStore = useAgentPresetsStore()
const conversationsStore = useConversationsStore()

/**
 * 模型下拉选项：把所有「已启用供应商的已启用模型」按供应商分组铺平。
 * value 编码为 `vendorId::modelId`（modelId 可能在不同供应商重复，必须带归属）；
 * 空串 = **跟随后台模型**（放在最前，方便切回；★1013（已定案）起不再叫"跟随全局"——
 * "全局模型"这个 UI 已经拿掉，通道未单独配模型时走的就是「后台模型」）。
 */
const modelOptions = computed(() => {
  const opts: Array<{ value: string; label: string; desc?: string; group?: string }> = [
    { value: '', label: followGlobalLabel.value, desc: t('channel.followBgDesc'), group: t('channel.modelGroupSpecial') },
  ]
  for (const p of providersStore.providers) {
    if (!p.enabled) continue
    const models = (providersStore.models[p.id] || []).filter(m => m.enabled)
    for (const m of models) {
      opts.push({ value: `${p.id}::${m.id}`, label: m.name || m.id, desc: m.id, group: p.name || p.id })
    }
  }
  return opts
})

/**
 * 0912 十批：配置卡改为**绑定当前选中的机器人**（QQ）/ 唯一账号（微信）。
 *
 * 数据模型：机器人级留空 → 继承通道级 → 再留空 → 跟随全局。
 * 所以这里显示的是「实际生效值」（`eff` 系列），保存时写入机器人级。
 */
const activeBot = computed(() => curCfg.value.bots.find(b => b.id === activeBotId.value) || null)

/** ★1015c：各机器人的 PC 接管配对码（PC 端显示；码只在 PC 端可见，绝不回给 IM） */
const pcCodes = ref<Record<string, string>>({})
const pcRotating = ref(false)
/** 取码失败的原因（**不静默**：界面上直接显示，否则"看不到码"没法查） */
const pcCodesErr = ref('')
/** 拉一次全部机器人的码（切换机器人不用重拉；换码后更新那一台） */
async function loadPcCodes() {
  pcCodesErr.value = ''
  try {
    const { useChatStore } = await import('@/stores/chat')
    // 不传 channel：后端把各通道机器人的码一次给全，界面按 botId 取自己那份（切 tab 不用重拉）
    const r: any = await useChatStore().bridgeRpc('pc.codes', {})
    // 兼容两种解包：桥接层可能已解到业务层，也可能还带着一层 value
    const codes = r?.codes || r?.value?.codes || null
    if (codes) pcCodes.value = codes
    else pcCodesErr.value = '接口没返回 codes：' + JSON.stringify(r).slice(0, 120)
  } catch (e: any) {
    pcCodesErr.value = String(e?.message || e).slice(0, 160)
    console.warn('[pcCodes] 取 PC 接管码失败', e)
  }
}
onMounted(loadPcCodes)
/** 换这台机器人的码：会撤销它名下已配对设备，所以先问一句 */
async function rotatePcCode() {
  const b = activeBot.value
  if (!b || pcRotating.value) return
  if (!window.confirm(t('channel.pcCodeRotateAsk'))) return
  pcRotating.value = true
  try {
    const { useChatStore } = await import('@/stores/chat')
    const r: any = await useChatStore().bridgeRpc('pc.rotateCode', { botId: b.id })
    if (r?.ok && r.code) pcCodes.value = { ...pcCodes.value, [b.id]: r.code }
  } catch (e) { swallowed('换 PC 接管码失败', e, 1) } finally { pcRotating.value = false }
}
/* ★1012（修白屏隐患 —— 本机实测复现，尚未在老大那里触发）：
   原先这里是 `watch(() => activeTab.value, loadPcCodes, { immediate: true })` ——
   而 `activeTab` 要到本文件下方（`const activeTab = ref<ChannelId>('wechat')`，约 583 行）才创建。
   `immediate: true` 会让回调在 **setup 阶段同步立刻求值 getter**，读到还没初始化的变量 ⇒
   `ReferenceError: Cannot access 'activeTab' before initialization` ⇒ 组件 setup 抛错 ⇒ 挂载链断、全页白屏。
   （复现方式：`watch(() => activeTab.value, fn, { immediate: true })` 写在 `const activeTab = ...` 之前，
     Vue 会报 "Unhandled error during execution of watcher getter"。）
   删掉 immediate 即可：首次加载由上方 `onMounted(loadPcCodes)` 负责，这里只管「切通道时重拉一次」；
   顺带少一次重复请求（改之前 onMounted + immediate 会各拉一次）。 */
watch(() => activeTab.value, loadPcCodes)

/** 配置卡的作用对象：QQ=选中机器人；微信=唯一账号（没有则留空走通道级） */
const cfgTarget = computed(() => {
  if (activeTab.value === 'wechat') return curCfg.value.bots[0] || null
  return activeBot.value
})

/** 实际生效的配置（机器人级 || 通道级）—— 只读展示 */
const effCfg = computed(() => {
  const b: any = cfgTarget.value
  const c = curCfg.value
  // 0914 修订（用户反馈"选跟随全局仍显示型号、强度还可切换"）：**选中机器人时只认机器人级值**——
  // 空 = 跟随全局（显示「跟随全局：X」+ 强度只读投影）；通道级仅作无机器人时的兜底默认。
  const pick = (bv: any, cv: any): string => (b ? String(bv || '') : String(cv || ''))
  return {
    providerId: pick(b?.providerId, c.providerId),
    modelId: pick(b?.modelId, c.modelId),
    effort: pick(b?.effort, c.effort),
    presetId: pick(b?.presetId, c.presetId),
    permissionMode: pick(b?.permissionMode, c.permissionMode) || 'self_audit',
  }
})

/** 保存到机器人级（无机器人时兜底写通道级） */
async function saveCfgTarget(patch: Record<string, any>) {
  const b = cfgTarget.value
  if (!b) return void store.updateConfig(activeTab.value, patch)
  await store.updateBot(activeTab.value, b.id, patch)
}

/** 配置里的 providerId/modelId → MiniSelect 的 value（空模型=跟随全局） */
const modelSelectValue = computed(() => {
  const c = effCfg.value
  return c.modelId ? `${c.providerId}::${c.modelId}` : ''
})

/** MiniSelect 选择 → 拆出 vendorId / modelId 落盘 */
async function onModelSelect(v: string) {
  // 切回「跟随全局」→ 顺手清掉通道自己的强度（否则旧值留着，与「全跟全局」的语义打架）0913 反馈
  if (!v) return void saveCfgTarget({ providerId: '', modelId: '', effort: '' })
  const [vendorId, modelId] = v.split('::')
  await saveCfgTarget({ providerId: vendorId || '', modelId: modelId || '' })
}

/**
 * 推理强度（0912 反馈）—— 与模型选择器并排。
 *
 * 0913 反馈修正：**模型选「跟随全局」时，强度是「只读投影」**——
 * 显示「设置 → 人格 → 全局模型」那行实际设的挡位，且**不许在这里改**
 * （全局强度只有一个可调入口，就是设置页；这里改会造成"两处都能改、到底听谁的"）。
 * 指定了具体模型时，才是通道自己的强度、可编辑。
 */
/* ★1013（已定案）：通道未单独配模型时，实际走的是**后台模型**（"全局模型"这个 UI 已拿掉）——
   下面这几个"生效值"计算的兜底来源必须跟着换，否则界面显示与强度投影会指向一个已不存在的概念。 */
const effModelFollowsGlobal = computed(() => !effCfg.value.modelId)   // 语义=跟随后台模型（变量名沿用，少改调用点）
const effModelProviderId = computed(() => effCfg.value.providerId || providersStore.backgroundProviderId || '')
const effModelId = computed(() => effCfg.value.modelId || providersStore.backgroundModelId || '')
const effEffort = computed(() =>
  effModelFollowsGlobal.value ? (providersStore.backgroundEffort || '') : (effCfg.value.effort || ''),
)
/** 模型下拉的 placeholder：跟随（=**跟随后台模型**）时带出后台模型名（「跟随后台模型：Agnes 2.5 Flash」），
 *  否则用户看不出"跟随"到底跟到了哪个模型。
 *  ★1013（已定案）：通道未单独配模型时走的是**后台模型**；"全局模型"概念已从 UI 拿掉，
 *  这里再显示"跟随全局"会把用户带偏（旧文案 key `channel.followGlobal*` 仅保留兼容旧引用）。 */
const followGlobalLabel = computed(() => {
  const pid = providersStore.backgroundProviderId
  const mid = providersStore.backgroundModelId
  if (!pid || !mid) return t('channel.followBgUnset')
  const name = providersStore.modelName(pid, mid) || mid
  return `${t('channel.followBg')}：${name}`
})
async function onEffortSelect(v: string | null) {
  if (effModelFollowsGlobal.value) return
  await saveCfgTarget({ effort: v || '' })
}

/**
 * 预设选项 —— 只列 Agent 预设，**不含团队**（用户明确要求：通道只能选预设）。
 * 团队需要成员编排等复杂配置，不适合在 IM 场景里临时选。
 */
const presetOptions = computed(() => {
  const opts: Array<{ value: string; label: string; desc?: string; group?: string }> = [
    { value: '', label: t('channel.followGlobalPreset'), desc: t('channel.followGlobalPresetDesc'), group: t('channel.modelGroupSpecial') },
  ]
  const builtin = presetsStore.presets.filter(p => p.builtin)
  const custom = presetsStore.presets.filter(p => !p.builtin)
  for (const p of builtin) opts.push({ value: p.id, label: p.name || p.id, desc: p.description, group: t('channel.presetBuiltin') })
  for (const p of custom) opts.push({ value: p.id, label: p.name || p.id, desc: p.description, group: t('channel.presetCustom') })
  return opts
})

async function onPresetSelect(v: string) {
  await saveCfgTarget({ presetId: v })
}

/**
 * ★1013g（已定案）：**通道级权限档已删**，这里不再有下拉。
 * 原因：它和"对话自己的权限"（PC 端输入框上方那个三档切换）看着像两道一模一样的闸，容易误解；
 * 当初设它的唯一理由是"confirm 的卡只在 PC 弹 → IM 看不到 → 干等超时"，而 IM 审批桥 + 按钮已经解决。
 * 现在：通道会话的权限**跟随对话自己**（新建对话 = 默认 confirm）；IM 里用 `/perm` 改当前对话。
 * ⇒ 旧数据里的 permissionMode 字段保留但不再读（不动用户数据）。
 */

/* ── 群聊插嘴（0912 二十四批）──
 * 开关 + 内容门槛 + 每小时上限。只有 QQ 群聊场景有意义。
 * 生效链路：机器人的 interject 字段 → 后端 maybeInterjectInGroup 三道闸。
 */
const effInterject = computed(() => {
  const b: any = cfgTarget.value
  return {
    on: !!b?.interject,
    scope: b?.interjectScope === 'any' ? 'any' : b?.interjectScope === 'keyword' ? 'keyword' : 'question',
    perHour: typeof b?.interjectPerHour === 'number' ? b.interjectPerHour : 3,
    // 0912 反馈：冷却时间（秒，默认 480 = 原硬编码的 8 分钟）与自定义插嘴词
    cooldownSec: typeof b?.interjectCooldownSec === 'number' ? b.interjectCooldownSec : 480,
    keywords: Array.isArray(b?.interjectKeywords) ? b.interjectKeywords.join('，') : '',
  }
})

const interjectScopeOptions = computed(() => [
  { value: 'question', label: t('channel.interjectScopeQuestion'), desc: t('channel.interjectScopeQuestionDesc') },
  { value: 'any', label: t('channel.interjectScopeAny'), desc: t('channel.interjectScopeAnyDesc') },
  { value: 'keyword', label: t('channel.interjectScopeKeyword'), desc: t('channel.interjectScopeKeywordDesc') },
])

async function toggleInterject() {
  await saveCfgTarget({ interject: !effInterject.value.on })
}

async function onInterjectScope(v: string) {
  await saveCfgTarget({ interjectScope: v })
}

async function onInterjectPerHour(v: number) {
  await saveCfgTarget({ interjectPerHour: Math.max(0, Math.min(20, Number(v) || 0)) })
}

/** 冷却时间（秒）：0 = 不设冷却（仍受每小时上限约束）；上限 24h */
async function onInterjectCooldown(v: number) {
  await saveCfgTarget({ interjectCooldownSec: Math.max(0, Math.min(86400, Math.floor(Number(v) || 0))) })
}

/**
 * 插嘴词：**标签化编辑**（0913 反馈第二轮 —— 上一版「输入即保存」反而踩了新坑）。
 *
 * 为什么不能直接用输入框编辑：值是单向 `:value` + 异步回写。改成 @input 防抖保存后，
 * 用户打完「牢大,」停 0.5s → 保存 → 服务端把逗号解析掉 → 回写 `牢大` →
 * **正好盖掉正在编辑的文本**（用户报「输入逗号就被清除」）。根因是"边打字边回写"这个结构本身。
 * 现在：**点击 → 弹小窗输入 → 确定 → 变成标签**；标签带 ✕ 可删；放不下显示 `+n`，悬停看全部。
 */
const kwModalOpen = ref(false)
const kwDraft = ref('')
/** 一行最多显示几个标签（超出收进 +n） */
const KW_VISIBLE_MAX = 3
const kwList = computed<string[]>(() => {
  const v: any = cfgTarget.value?.interjectKeywords
  return Array.isArray(v) ? v : []
})
const kwVisible = computed(() => kwList.value.slice(0, KW_VISIBLE_MAX))
const kwHidden = computed(() => kwList.value.slice(KW_VISIBLE_MAX))
const kwHiddenText = computed(() => kwHidden.value.join('、'))

function openKwModal() {
  kwDraft.value = ''
  kwModalOpen.value = true
}
/** 解析用户输入（逗号/顿号/空格分隔；去空、截断、最多 20 个） */
function parseKwInput(v: string): string[] {
  return String(v || '')
    .split(/[,，、\s]+/)
    .map(s => s.trim())
    .filter(Boolean)
    .slice(0, 20)
    .map(s => s.slice(0, 20))
}
/** 确定：与已有词合并去重（上限 20）后落盘 */
async function confirmKw() {
  const add = parseKwInput(kwDraft.value)
  kwModalOpen.value = false
  if (!add.length) return
  const merged = Array.from(new Set([...kwList.value, ...add])).slice(0, 20)
  await saveCfgTarget({ interjectKeywords: merged })
}
async function removeKw(w: string) {
  await saveCfgTarget({ interjectKeywords: kwList.value.filter(x => x !== w) })
}

/**
 * 输入类字段的"输入即保存"（0913 修复，重要）。
 *
 * 背景（实测）：这些输入原来只在 `@change` 上保存，而 change 只在**正常失焦**时触发 ——
 * 用户**输入完直接关弹窗 / 点遮罩**时元素被移除，change 根本不触发（探针实测：关弹窗方式 0 个 RPC；
 * ESC / 切 tab / 点弹窗内别处才触发）→ 内容静默丢失，重开弹窗看到空白，用户报「输入后自动清除」。
 *
 * 现在：`@input` 触发 + 500ms 防抖（输入停下来才发一次 RPC，不按键就发）。
 * ⚠️ 定时器**不在组件卸载时清理** —— 这样"输完立刻关弹窗"也仍会落一次保存。
 * `@change` 保留作兜底（正常失焦时立即保存，双保险、幂等无害）。
 */
const inputSaveTimers: Record<string, ReturnType<typeof setTimeout>> = {}
function debouncedInputSave(slot: string, fn: () => void, delay = 500) {
  if (inputSaveTimers[slot]) clearTimeout(inputSaveTimers[slot])
  inputSaveTimers[slot] = setTimeout(() => { delete inputSaveTimers[slot]; fn() }, delay)
}
/** 两个数字输入框的 `@input` 包装（从事件取值后交给防抖保存；值先取出来，避免异步里摸 $event） */
function onPerHourInput(e: Event) {
  const v = Number((e.target as HTMLInputElement).value)
  debouncedInputSave('perHour', () => { void onInterjectPerHour(v) })
}
function onCooldownInput(e: Event) {
  const v = Number((e.target as HTMLInputElement).value)
  debouncedInputSave('cooldown', () => { void onInterjectCooldown(v) })
}

/* ── 机器人管理（QQ 多机器人：tab 切换 + 弹窗新建）── */
const botDraft = ref({ accountId: '', secret: '', nickname: '' })
const botBusy = ref(false)
/** 新建机器人弹窗（0912 十批：从「下方展开表单」改成弹窗） */
const botModalOpen = ref(false)

function resetBotDraft() {
  botDraft.value = { accountId: '', secret: '', nickname: '' }
}

function openBotModal() {
  resetBotDraft()
  botModalOpen.value = true
}

function closeBotModal() {
  botModalOpen.value = false
  resetBotDraft()
}

async function submitBot() {
  if (!botDraft.value.accountId.trim() || botBusy.value) return
  botBusy.value = true
  try {
    const ok = await store.addBot(activeTab.value, {
      accountId: botDraft.value.accountId.trim(),
      secret: botDraft.value.secret.trim(),
      nickname: botDraft.value.nickname.trim(),
    })
    if (ok) {
      closeBotModal()
      // 新建后自动切到这台（用户马上要配它的模型/预设/人格）
      const fresh = curCfg.value.bots[curCfg.value.bots.length - 1]
      if (fresh) await selectBot(fresh.id)
    }
  } finally {
    botBusy.value = false
  }
}

async function toggleBot(botId: string, enabled: boolean) {
  await store.updateBot(activeTab.value, botId, { enabled })
}

async function removeBot(botId: string) {
  await store.removeBot(activeTab.value, botId)
}

/* ── 0912 二批：独享对话改为「弹窗 + 多选」，底部两个按钮 ── */
const sessionPickerOpen = ref(false)
const pickedSessions = ref<Set<string>>(new Set())
const pickerBusy = ref(false)

function openSessionPicker() {
  pickedSessions.value = new Set()
  cancelRenamePeer()
  sessionPickerOpen.value = true
  initPickerKind()
  void loadCurSessions()
}

function togglePick(id: string) {
  const s = new Set(pickedSessions.value)
  if (s.has(id)) s.delete(id); else s.add(id)
  pickedSessions.value = s
}

function togglePickAll() {
  // 只作用于**当前 tab 可见**的会话（0912 十七批：私聊/群聊分 tab 后，全选不该跨 tab 生效）
  const all = pickerList.value.map(s => s.id)
  const pickedAll = all.length > 0 && all.every(id => pickedSessions.value.has(id))
  pickedSessions.value = pickedAll ? new Set() : new Set(all)
}

/** 把选中的会话移出通道（回到普通聊天列表） */
async function movePickedToMain() {
  const ids = Array.from(pickedSessions.value)
  if (!ids.length || pickerBusy.value) return
  pickerBusy.value = true
  try {
    for (const id of ids) await store.moveSession(id, '')
    pickedSessions.value = new Set()
    await loadCurSessions()
    await conversationsStore.loadConversations()
    if (!curSessions.value.length) sessionPickerOpen.value = false
  } finally {
    pickerBusy.value = false
  }
}

/* ── 0912 十一批：独享对话支持「删除」（取消按钮改为删除）──
   行为对齐侧栏删除：**移入「滞留处」（可恢复）**而不是永久销毁，避免误删丢数据。
   通道会话还要先把 origin 清掉（否则它仍会出现在独享列表里）。 */
const deleteConfirmOpen = ref(false)
const deleteBusy = ref(false)

/** 点「删除」→ 先弹二次确认（危险操作不当场执行） */
function askDeletePicked() {
  if (!pickedSessions.value.size || pickerBusy.value || deleteBusy.value) return
  deleteConfirmOpen.value = true
}

/** 确认删除 */
async function doDeletePicked() {
  const ids = Array.from(pickedSessions.value)
  if (!ids.length || deleteBusy.value) return
  deleteBusy.value = true
  try {
    for (const id of ids) {
      try {
        // ① 摘掉通道归属（后端 origin 清空 → 不再出现在独享列表）
        await store.moveSession(id, '')
        // ② 移入滞留处（前端列表消失，可在设置里恢复）
        conversationsStore.moveConversationToTrash(id)
      } catch { /* 单个失败不阻塞其余 */ }
    }
    pickedSessions.value = new Set()
    deleteConfirmOpen.value = false
    await loadCurSessions()
    if (!curSessions.value.length) sessionPickerOpen.value = false
  } finally {
    deleteBusy.value = false
  }
}

/* ── 0912 三批：PC 端也能「切换当前对话 / 新建对话」──
   等价于手机 IM 里的 `/switch N` 和 `/new`（同一份后端映射，两边天然同步）。
   「当前对话」= 该机器人后续收到的消息落点，列表里用绿色徽标标出。 */

/** 该机器人当前的「当前会话」id 列表 */
const curActiveIds = computed(() => store.activeIdsOf(activeTab.value, activeBotId.value))

/** 某会话是否「当前会话」 */
function isActiveSession(id: string): boolean {
  return curActiveIds.value.includes(id)
}

/**
 * 对端类型徽标文案（0912 三批）：同一机器人可能既被私聊又被拉进群，
 * 列表里必须能区分 —— 否则用户看到多行「当前」会一头雾水。
 */
function kindText(k?: string): string {
  if (k === 'c2c') return t('channel.kindDm')
  if (k === 'group') return t('channel.kindGroup')
  if (k === 'channel') return t('channel.kindChannel')
  return ''
}

/** 行内「设为当前」进行中的会话 id（单行忙碌，避免连点） */
const activeBusy = ref('')
/** 顶部「新建对话」进行中 */
const newBusy = ref(false)

/**
 * 点行 = 设为当前会话（等价手机 `/switch N`）。
 * 已是当前则空操作 —— 避免无意义的后端往返。
 */
async function activateSession(s: ChannelSession) {
  if (activeBusy.value || isActiveSession(s.id)) return
  activeBusy.value = s.id
  try {
    await store.setActiveSession(s.id, activeTab.value, activeBotId.value)
  } finally {
    activeBusy.value = ''
  }
}

/** 新建对话并设为当前（等价手机 `/new`）。 */
async function createChannelSession() {
  if (newBusy.value) return
  newBusy.value = true
  try {
    const id = await store.newSession(activeTab.value, activeBotId.value)
    if (id) {
      pickedSessions.value = new Set()
      await loadCurSessions()
      await conversationsStore.loadConversations()
    }
  } finally {
    newBusy.value = false
  }
}

/* ── 0912 二批：微信扫码（悬停出二维码）── */
const qrOpen = ref(false)
const qrImage = ref('')
const qrSessionKey = ref('')
const qrMsg = ref('')
const qrBusy = ref(false)
const qrDone = ref(false)
const qrVerifyOpen = ref(false)
const qrVerifyCode = ref('')
let qrLoop = 0

async function startWechatQr() {
  if (qrBusy.value) return
  qrBusy.value = true
  qrDone.value = false
  qrMsg.value = ''
  qrVerifyOpen.value = false
  qrVerifyCode.value = ''
  try {
    const r = await store.wechatQrStart()
    if (!r.ok || !r.qrImage) {
      qrMsg.value = r.message || '获取二维码失败'
      return
    }
    qrImage.value = r.qrImage
    qrSessionKey.value = r.sessionKey
    qrOpen.value = true
    qrMsg.value = r.message
    void pollQr()
  } finally {
    qrBusy.value = false
  }
}

/** 轮询扫码状态（后端是 35s 长轮询，这里循环调用；成功/失败即停） */
async function pollQr() {
  const myLoop = ++qrLoop
  while (qrLoop === myLoop && qrSessionKey.value && !qrDone.value) {
    const r = await store.wechatQrWait(qrSessionKey.value, qrVerifyCode.value || undefined)
    if (qrLoop !== myLoop) return
    qrMsg.value = r.message
    if (r.qrImage && r.qrImage !== qrImage.value) qrImage.value = r.qrImage
    if (r.needVerifyCode) {
      qrVerifyOpen.value = true
      // 已输入过但被拒 → 清空让用户重输
      if (r.message.includes('不匹配')) qrVerifyCode.value = ''
      continue
    }
    if (r.connected) {
      qrDone.value = true
      qrVerifyOpen.value = false
      await store.loadConfigs()
      break
    }
    if (r.alreadyConnected) {
      qrDone.value = true
      qrVerifyOpen.value = false
      await store.loadConfigs()
      break
    }
    if (!r.ok) break
  }
}

function closeQr() {
  qrLoop += 1          // 停掉轮询
  qrOpen.value = false
  qrVerifyOpen.value = false
  void store.wechatQrCancel(qrSessionKey.value)
  qrSessionKey.value = ''
}

function submitVerifyCode() {
  // 下一轮轮询会把 qrVerifyCode 带上
  qrVerifyOpen.value = false
  if (!qrSessionKey.value) return
  void pollQr()
}

/** 把会话移出通道，回到普通聊天列表 */
async function moveToMain(s: ChannelSession) {
  const ok = await store.moveSession(s.id, '')
  if (ok) {
    detail.value = null
    await loadCurSessions()
  }
}

const isAnimating = ref(false)
const isClosing = ref(false)
const showModal = ref(false)
const activeTab = ref<ChannelId>('wechat')

/** 详情视图：null=列表视图；非空=查看该会话内容 */
const detail = ref<ChannelSession | null>(null)

/** 0912：QQ 机器人在线状态（后端 WS 连接状态），按 botId 索引 */
const botOnline = ref<Record<string, boolean>>({})
/** 微信连接状态（getUpdates 长轮询是否活着 —— 真在线，不是"有 token"） */
const wxOnline = ref(false)
let statusTimer: ReturnType<typeof setInterval> | undefined

async function refreshStatus() {
  const st = await store.loadStatus()
  const out: Record<string, boolean> = {}
  for (const [id, v] of Object.entries(st.qq || {})) out[id] = !!(v as any).connected
  botOnline.value = out
  const wxIds = Object.keys(st.wechat || {})
  wxOnline.value = wxIds.length > 0 && wxIds.every(id => !!(st.wechat as any)[id]?.connected)
}

/* ── 0912 七批：每个机器人的人格与称呼覆盖（下拉总开关 + 弹窗编辑）──
   QQ 每台机器人各一份；微信只有一台机器人 → 等效于「该通道一份」。
   交互：下拉选「跟随系统设置 / 自定义」；选自定义后右侧编辑按钮才可点，点击弹出编辑弹窗。 */
const personaModalBotId = ref('')
const personaBusy = ref(false)
const personaDraft = ref({ personaName: '', addressName: '', personaPrompt: '' })

/** 下拉选项（对齐「独享对话」的双按钮风格） */
const personaModeOptions = computed(() => [
  { value: 'global', label: t('channel.personaFollow'), desc: t('channel.personaFollowDesc') },
  { value: 'custom', label: t('channel.personaCustomOpt'), desc: t('channel.personaCustomOptDesc') },
])

/**
 * 该机器人的总开关现值。
 * 兼容旧数据（0912 七批早期没有 mode 开关，"填了即生效"）：填过内容但没存过 mode → 显示为「自定义」，
 * 与后端判定保持一致，避免"看到的是跟随、实际却在生效"的错位。
 */
function personaModeOf(b?: { personaMode?: string; personaName?: string; addressName?: string; personaPrompt?: string } | null): string {
  if (!b) return 'global'
  if (b.personaMode === 'custom') return 'custom'
  if (b.personaMode === 'global') return 'global'
  return (b.personaName || b.addressName || b.personaPrompt) ? 'custom' : 'global'
}

/** 是否填过任意自定义项（按钮上显示小圆点提示） */
function hasPersona(b?: { personaName?: string; addressName?: string; personaPrompt?: string } | null): boolean {
  return !!b && !!(b.personaName || b.addressName || b.personaPrompt)
}

/** 切换总开关（立刻落盘；只影响是否应用覆盖，不丢已填内容） */
async function setPersonaMode(botId: string, v: string) {
  await store.updateBot(activeTab.value, botId, { personaMode: v === 'custom' ? 'custom' : 'global' })
}

/** 打开编辑弹窗（把该机器人现有值带进来） */
function openPersonaModal(b: { id: string; personaName?: string; addressName?: string; personaPrompt?: string }) {
  personaModalBotId.value = b.id
  personaDraft.value = {
    personaName: b.personaName || '',
    addressName: b.addressName || '',
    personaPrompt: b.personaPrompt || '',
  }
}

function closePersonaModal() { personaModalBotId.value = '' }

/** 正在编辑的机器人（弹窗标题用；响应式，保存后即时更新） */
const personaModalBot = computed(() => curCfg.value.bots.find(b => b.id === personaModalBotId.value) || null)

/** 保存自定义三项（留空的项自动回退系统设置） */
async function savePersona() {
  const bot = personaModalBot.value
  if (!bot || personaBusy.value) return
  personaBusy.value = true
  try {
    const ok = await store.updateBot(activeTab.value, bot.id, {
      personaName: personaDraft.value.personaName.trim(),
      addressName: personaDraft.value.addressName.trim(),
      personaPrompt: personaDraft.value.personaPrompt.trim(),
    })
    if (ok) closePersonaModal()
  } finally {
    personaBusy.value = false
  }
}
/** 命令输入与回显 */
const cmdInput = ref('')
const cmdReply = ref('')
const cmdBusy = ref(false)
const showHelp = ref(false)

const meta = computed(() => CHANNEL_META.find(m => m.id === activeTab.value) || CHANNEL_META[0])
const curCfg = computed(() => store.cfg(activeTab.value))

/**
 * 0912 二批：当前查看的机器人（QQ 多机器人时每个机器人的对话互相独立）。
 * 空串 = 该通道全部（微信只有一台，恒为空）。
 * 默认取第一个机器人 —— 打开就落到具体某台，避免"混在一起"的观感。
 */
const activeBotId = ref('')

/** 该通道当前的机器人列表（用于选择器） */
const curBots = computed(() => curCfg.value.bots || [])

/** 当前会话列表（按 `通道:机器人` 分桶读取） */
const curSessions = computed(() => store.sessionsOf(activeTab.value, activeBotId.value))

/* ── 0912 十七批：独享对话弹窗 —— 私聊/群聊分 tab + 序号 + 对端名（群A/群B）── */

/** 当前子 tab：'dm' 私聊 / 'group' 群聊（互不混看，避免多个群混在一张表里分不清） */
const pickerKind = ref<'dm' | 'group'>('dm')

/** 二十一批：微信没有群聊（用户明确：「微信是不能用群聊的」）→ 不显示群聊 tab */
const isWechatTab = computed(() => activeTab.value === 'wechat')
const showGroupTab = computed(() => !isWechatTab.value)

/** 某会话属于哪个子 tab（非群聊一律归私聊；频道也归群聊侧） */
function kindBucket(k?: string): 'dm' | 'group' {
  return k === 'group' || k === 'channel' ? 'group' : 'dm'
}

/** 分组后的列表（弹窗里真正渲染的）；微信恒为私聊桶 */
const pickerList = computed(() => curSessions.value.filter(
  s => kindBucket(s.originKind) === (isWechatTab.value ? 'dm' : pickerKind.value),
))

const dmCount = computed(() => curSessions.value.filter(s => kindBucket(s.originKind) === 'dm').length)
const groupCount = computed(() => curSessions.value.filter(s => kindBucket(s.originKind) === 'group').length)

/**
 * 打开弹窗时的默认 tab：跟着「当前会话」走（它在哪个桶就开哪个桶），
 * 都没有则优先群聊（多群场景更常见）。
 */
function initPickerKind() {
  if (isWechatTab.value) { pickerKind.value = 'dm'; return }   // 微信没有群聊，恒私聊
  const active = curSessions.value.find(s => isActiveSession(s.id))
  if (active) { pickerKind.value = kindBucket(active.originKind); return }
  pickerKind.value = groupCount.value > 0 ? 'group' : 'dm'
}

/** 对端改名（群A → 「工作群」）：影响所有属于该对端的会话行 */
const renamePeerTarget = ref<ChannelSession | null>(null)
const peerDraft = ref('')
const peerBusy = ref(false)
function openRenamePeer(s: ChannelSession) {
  if (!s.originPeer) return
  renamePeerTarget.value = s
  peerDraft.value = s.peerLabel || ''
}
function cancelRenamePeer() { renamePeerTarget.value = null; peerDraft.value = '' }
async function saveRenamePeer() {
  const s = renamePeerTarget.value
  if (!s || peerBusy.value) return
  const name = peerDraft.value.trim()
  if (!name || name === (s.peerLabel || '')) { cancelRenamePeer(); return }
  peerBusy.value = true
  try {
    await store.setPeerLabel(activeTab.value, s.originBot || activeBotId.value, s.originPeer, name, s.originKind)
    cancelRenamePeer()
  } finally { peerBusy.value = false }
}

/** 统一的会话加载入口（带 botId） */
async function loadCurSessions() {
  await store.loadSessions(activeTab.value, activeBotId.value)
}

/** 切机器人 → 重载它的会话 + 清空勾选 */
async function selectBot(id: string) {
  if (activeBotId.value === id) return
  activeBotId.value = id
  pickedSessions.value = new Set()
  detail.value = null
  await loadCurSessions()
}

watch(() => props.open, async (val) => {
  if (val) {
    isClosing.value = false
    showModal.value = true
    isAnimating.value = true
    setTimeout(() => { isAnimating.value = false }, 350)
    detail.value = null
    cmdReply.value = ''
    cmdInput.value = ''
    showHelp.value = false
    await Promise.all([store.loadConfigs(), store.loadCommands()])
    // 默认落到第一个机器人（QQ 多机器人时避免"全部混着看"）
    activeBotId.value = (store.cfg(activeTab.value).bots || [])[0]?.id || ''
    await loadCurSessions()
  }
})

watch(activeTab, async (id) => {
  detail.value = null
  cmdReply.value = ''
  activeBotId.value = (store.cfg(id).bots || [])[0]?.id || ''
  if (id === 'remote') { void loadRemoteInfo(); void loadTunnelInfo() }
  await loadCurSessions()
})

function close() {
  /**
   * 二十一批：关主弹窗时**连带清掉所有二级弹窗状态**。
   * 用户实测 bug：二级弹窗开着时按 ESC，主弹窗关了、二级弹窗还挂在屏幕上
   * （它们 Teleport 到 body，不受主弹窗 v-if 影响）。
   */
  resetSubModals()
  isClosing.value = true
  isAnimating.value = true
  setTimeout(() => {
    if (props.open && !isClosing.value) return  /*0927 netfix close-reopen-guard v3：正常关闭放行（isClosing 仍 true）；中途被重开（open watch 复位）则旧定时器作废 */
    showModal.value = false
    isAnimating.value = false
    isClosing.value = false
    emit('close')
  }, 250)
}

/** 清掉全部二级弹窗（ESC 逐层关闭 / 主弹窗关闭时都走它） */
function resetSubModals() {
  sessionPickerOpen.value = false
  renamePeerTarget.value = null
  peerDraft.value = ''
  deleteConfirmOpen.value = false
  botModalOpen.value = false
  personaModalBotId.value = ''
  qrVerifyOpen.value = false
  qrOpen.value = false
  showHelp.value = false
  detail.value = null
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key !== 'Escape' || !props.open) return
  /**
   * 逐层关闭（二十一批补全二级弹窗）：
   * 二级弹窗（改名 → 删除确认 → 新建机器人 → 人设 → 扫码）→ 帮助 → 详情 → 整个弹窗。
   * 早期只处理了 帮助/详情，二级弹窗会被"跳过"——主弹窗一关它留在屏上（用户实测 bug）。
   */
  if (renamePeerTarget.value) { cancelRenamePeer(); return }
  if (deleteConfirmOpen.value) { deleteConfirmOpen.value = false; return }
  if (botModalOpen.value) { closeBotModal(); return }
  if (personaModalBotId.value) { closePersonaModal(); return }
  if (qrVerifyOpen.value) { qrVerifyOpen.value = false; return }
  if (qrOpen.value) { closeQr(); return }
  if (sessionPickerOpen.value) { sessionPickerOpen.value = false; return }
  if (showHelp.value) { showHelp.value = false; return }
  if (detail.value) { detail.value = null; return }
  close()
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
}
onMounted(() => document.addEventListener('keydown', handleKeydown))
onUnmounted(() => {
  document.removeEventListener('keydown', handleKeydown)
  if (statusTimer) clearInterval(statusTimer)
  qrLoop += 1   // 停扫码轮询
})

// 弹窗打开时轮询 QQ 在线状态（5s），关闭即停
watch(showModal, (v) => {
  if (statusTimer) { clearInterval(statusTimer); statusTimer = undefined }
  if (v) {
    void refreshStatus()
    statusTimer = setInterval(() => { void refreshStatus() }, 5000)
  }
})

async function toggleEnabled() {
  await store.updateConfig(activeTab.value, { enabled: !curCfg.value.enabled })
  // 0920：远程访问开关直接决定后端放不放行局域网请求 ⇒ 改完立刻刷新连接信息（地址/二维码）
  if (activeTab.value === 'remote') void loadRemoteInfo()
}

/* ── 0920：远程访问连接信息（局域网地址 + 手机扫码二维码）──
 * 地址与二维码都由后端 `remote.info` 现算：本机网卡 IPv4 + 真实监听端口，二维码用 qrcode 生成 dataURL。
 * 开关没打开时后端会拒掉局域网请求，所以这里也要提示"先开开关"。 */
/* ★1012【云服务器中转】面板状态与动作（配置存后端 data/tunnel.json，隧道进程由后端维持）。
   公钥与引导命令都由后端现算 —— 密钥在后端首次访问时自动生成，用户什么都不用准备。
   ⚠️ 这里用 ref 包对象而不是 reactive：本文件没 import reactive，且模板里 ref 会自动解包
   （脚本内访问要写 .value，模板里不用）。 */
const tunnel = ref<{
  running: boolean
  cfg: { host: string; sshPort: number; user: string; publicPort: number }
  pubKey: string
  keyErr: string
  setupCommand: string
  publicUrl: string
  lastErr: string
  uptimeSec: number
}>({
  running: false,
  cfg: { host: '', sshPort: 22, user: 'ubuntu', publicPort: 80 },
  pubKey: '', keyErr: '', setupCommand: '', publicUrl: '', lastErr: '', uptimeSec: 0,
})
/* ★1012c（用户："这几个框默认都应该是空的"）—— 初值全留空，提示交给 placeholder。
   后端仍保留 TUNNEL_DEFAULT（ubuntu/22/80）作为**实际启动时的兜底**，
   但面板不该把兜底值当"用户已填"显示出来 —— 那既让人以为是自己配的，也会掩盖漏填。 */
const tunnelForm = ref({ host: '', user: '', sshPort: '', publicPort: '' })
const tunnelBusy = ref(false)
const tunnelMsg = ref('')
const tunnelCmdCopied = ref(false)
const tunnelUrlCopied = ref(false)

async function loadTunnelInfo() {
  try {
    const r: any = await chatStore.bridgeRpc('remote.tunnel.info', {})
    if (!r) return
    tunnel.value = r
    /* ★1012c：**只回填 host**（那是用户真填过的地址，回显有用）；user / sshPort / publicPort
       **不回填** —— 后端这三个有兜底默认值（ubuntu/22/80），回填出来会让人误以为"是自己配的"。
       功能不受影响：启动时后端用自己存的值（留空则取兜底），不依赖这几个框当前显示什么。 */
    if (!tunnelForm.value.host && r.cfg?.host) tunnelForm.value.host = r.cfg.host
  } catch (e: any) {
    console.warn('[tunnel] info 失败：', e?.message || e)
  }
}
function tunnelPayload() {
  /* ★1012c【重要】留空的字段**不发**（后端见 undefined 就保留原值）。
     老写法 `Number('') || 80` 会把空输入顶成 80 ⇒ 用户"对外端口留空"时会把他之前配好的
     8080 悄悄改回 80，隧道从此绑错端口、外网怎么都打不开，还极难查。 */
  const out: Record<string, unknown> = { uiPort: Number(window.location.port) || 0 }
  if (tunnelForm.value.host.trim()) out.host = tunnelForm.value.host.trim()
  if (tunnelForm.value.user.trim()) out.user = tunnelForm.value.user.trim()
  if (Number(tunnelForm.value.sshPort) > 0) out.sshPort = Number(tunnelForm.value.sshPort)
  if (Number(tunnelForm.value.publicPort) > 0) out.publicPort = Number(tunnelForm.value.publicPort)
  return out
}
/* ★1012f：解析服务器返回的配置码 → 自动填好四项并直接连上（用户提的好主意：
   服务器自己知道公网 IP 和登录用户，让知情的一方报答案，用户就不用去查、不用手填 4 个框）。 */
const tunnelCode = ref('')
const tunnelCodeMsg = ref('')

async function applyTunnelCode() {
  const raw = tunnelCode.value.trim()
  if (!raw) return
  /* 容错解析：允许整段粘贴（服务器输出里可能混着 sudo 提示等），只找标记那一行 */
  const m = raw.match(/NIS-TUNNEL-CONFIG\s*\|\s*([^|\s]+)\s*\|\s*([^|\s]+)\s*\|\s*(\d+)\s*\|\s*(\d+)/i)
  if (!m) {
    tunnelCodeMsg.value = t('channel.tunnelCodeBad')
    return
  }
  const [, host, user, sshPort, publicPort] = m
  tunnelForm.value.host = host
  tunnelForm.value.user = user
  tunnelForm.value.sshPort = String(Number(sshPort) || 22)
  tunnelForm.value.publicPort = String(Number(publicPort) || 8080)
  tunnelCodeMsg.value = t('channel.tunnelCodeOk')
  /* ★1012h：**不清空**粘贴框 —— 反馈"填好了却显示空的"。其实那是 placeholder 灰字示例；
     保留真值后，用户能核对解析结果、也更安心。配置码里只有 IP/用户名/端口，不含任何密钥，
     留在界面上是安全的。 */
  /* 解析出来就直接连 —— 用户粘一次就该能用，不该再让他点第二次按钮 */
  if (tunnel.value.running) await saveTunnelCfg()
  else await toggleTunnel()
  /* ★1012g：连完必须**把结果写回这行提示** —— 否则它会永远停在"正在连接…"，
     用户以为卡住了（实际隧道早起来了、面板状态都变了）。实测踩到过。 */
  tunnelCodeMsg.value = tunnel.value.running
    ? t('channel.tunnelCodeLinked', { url: tunnel.value.publicUrl || '' })
    : t('channel.tunnelCodeFailed')
}

async function saveTunnelCfg() {
  tunnelBusy.value = true; tunnelMsg.value = ''
  try {
    const r: any = await chatStore.bridgeRpc('remote.tunnel.set', tunnelPayload())
    if (r) tunnel.value = r
    tunnelMsg.value = t('channel.tunnelSaved')
  } catch (e: any) {
    tunnelMsg.value = e?.message || String(e)
  } finally { tunnelBusy.value = false }
}
async function toggleTunnel() {
  tunnelBusy.value = true; tunnelMsg.value = ''
  try {
    if (tunnel.value.running) {
      const r: any = await chatStore.bridgeRpc('remote.tunnel.stop', {})
      if (r) tunnel.value = r
      tunnelMsg.value = t('channel.tunnelStopped')
    } else {
      /* 先静默存一次配置，再启动 —— 用户往往是"改完直接点开始"，省一次手动保存 */
      try { await chatStore.bridgeRpc('remote.tunnel.set', tunnelPayload()) } catch { /* 后端启动时也会读最新配置 */ }
      const r: any = await chatStore.bridgeRpc('remote.tunnel.start', tunnelPayload())
      if (r) tunnel.value = r
      tunnelMsg.value = r?.running ? t('channel.tunnelStarted') : t('channel.tunnelStartFailed')
      if (r && !r.running && r.lastErr) tunnelMsg.value = r.lastErr
    }
  } catch (e: any) {
    tunnelMsg.value = e?.message || String(e)
  } finally { tunnelBusy.value = false }
}
async function copyTunnelCmd() {
  if (!tunnel.value.setupCommand) return
  try {
    await navigator.clipboard.writeText(tunnel.value.setupCommand)
    tunnelCmdCopied.value = true
    setTimeout(() => { tunnelCmdCopied.value = false }, 1600)
  } catch (e: any) { tunnelMsg.value = e?.message || String(e) }
}
async function copyTunnelUrl() {
  if (!tunnel.value.publicUrl) return
  try {
    await navigator.clipboard.writeText(tunnel.value.publicUrl)
    tunnelUrlCopied.value = true
    setTimeout(() => { tunnelUrlCopied.value = false }, 1600)
  } catch (e: any) { tunnelMsg.value = e?.message || String(e) }
}

const remoteInfo = ref<{ enabled: boolean; port: number; urls: string[]; url: string; qr: string; tokenRequired: boolean }>({
  enabled: false, port: 0, urls: [], url: '', qr: '', tokenRequired: false,
})
const remoteCopied = ref(false)
let remoteCopyTimer: ReturnType<typeof setTimeout> | undefined

async function loadRemoteInfo() {
  try {
    /* ★1011r：报上当前界面端口 —— 手机该访问的是这个端口（dev 时前后端是两个端口，后端 8766 只有 API） */
    const uiPort = Number(window.location.port) || 0
    const r: any = await chatStore.bridgeRpc('remote.info', { uiPort })
    if (r) {
      remoteInfo.value = {
        enabled: !!r.enabled,
        port: Number(r.port) || 0,
        urls: Array.isArray(r.urls) ? r.urls : [],
        url: String(r.url || ''),
        qr: String(r.qr || ''),
        tokenRequired: !!r.tokenRequired,
      }
    }
  } catch { /* 后端未就绪：保持空态，UI 给提示 */ }
}

async function copyRemoteUrl() {
  if (!remoteInfo.value.url) return
  try {
    await navigator.clipboard.writeText(remoteInfo.value.url)
    remoteCopied.value = true
    if (remoteCopyTimer) clearTimeout(remoteCopyTimer)
    remoteCopyTimer = setTimeout(() => { remoteCopied.value = false }, 1600)
  } catch { /* 剪贴板不可用（非安全上下文）：忽略，可手动选中复制 */ }
}

/* ★1011：重新生成访问令牌（一键换锁）。
   令牌在开关打开时由后端自动生成并落盘，链接/二维码自带它；怀疑泄露时点这里换一把，
   旧链接与旧二维码立即失效（已连着的页面下一跳请求就会被拒）。 */
const remoteRegenBusy = ref(false)
const remoteRegenMsg = ref('')
let remoteRegenTimer: ReturnType<typeof setTimeout> | undefined
async function regenRemoteToken() {
  if (remoteRegenBusy.value) return
  remoteRegenBusy.value = true
  remoteRegenMsg.value = ''
  try {
    const r: any = await chatStore.bridgeRpc('remote.regenToken', {})
    if (r?.envControlled) {
      remoteRegenMsg.value = t('channel.remoteRegenEnv')
    } else {
      remoteRegenMsg.value = t('channel.remoteRegenDone')
      await loadRemoteInfo()
    }
  } catch (e: any) {
    remoteRegenMsg.value = String(e?.message || e)
  } finally {
    remoteRegenBusy.value = false
    if (remoteRegenTimer) clearTimeout(remoteRegenTimer)
    remoteRegenTimer = setTimeout(() => { remoteRegenMsg.value = '' }, 5000)
  }
}

/** 执行命令（弹窗内联，无需真实通道即可验证命令层） */
async function runCmd() {
  const text = cmdInput.value.trim()
  if (!text || cmdBusy.value) return
  cmdBusy.value = true
  try {
    // 详情视图里执行命令时带上当前会话，让 /status /stop 有明确目标
    const res = await store.runCommand(activeTab.value, text, detail.value?.id)
    cmdReply.value = res.reply || (res.handled ? '（无输出）' : '这不是命令，会作为普通消息发给 AI')
    if (res.action) await afterAction(res.action)
    if (res.action?.kind === 'new' || res.action?.kind === 'switch') cmdInput.value = ''
  } finally {
    cmdBusy.value = false
  }
}

/** 命令的副作用（后端只返回 action 描述符，由前端走既有 RPC/跳转执行） */
async function afterAction(action: { kind: string; sessionId?: string }) {
  if (!action.sessionId) return
  if (action.kind === 'switch' || action.kind === 'new') {
    await loadCurSessions()
    // 切到详情视图，让用户立刻看到目标会话
    const s = store.sessionsFor[activeTab.value]?.find(x => x.id === action.sessionId)
    if (s) detail.value = s
  }
  if (action.kind === 'stop') {
    // 复用既有 RPC（后端 channel.command 不直接执行 stop，避免复制 session.cancel 逻辑）
    try {
      const { useChatStore } = await import('@/stores/chat')
      await useChatStore().bridgeRpc('session.cancel', { sessionId: action.sessionId })
    } catch (e) { swallowed('通道会话「停止」没送到后端（界面会刷新成空闲，但会话可能仍在跑）', e, 1) }
    await loadCurSessions()
  }
}

/** 跳回主界面打开该会话（跨端接续：通道会话就是普通会话） */
function openInMain() {
  if (!detail.value) return
  emit('openSession', detail.value.id)
  close()
}

/** 时间戳 → 相对时间（列表用） */
function relTime(ts: number): string {
  if (!ts) return ''
  const d = Date.now() - ts
  if (d < 60_000) return t('channel.justNow')
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}${t('channel.minutesAgo')}`
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}${t('channel.hoursAgo')}`
  return `${Math.floor(d / 86_400_000)}${t('channel.daysAgo')}`
}

const helpText = computed(() => store.commands.map(c => ({
  usage: `/${c.name}${c.params ? ' ' + c.params : ''}`,
  desc: c.desc,
})))
</script>

<template>
  <Teleport to="body">
    <div
      v-if="showModal"
      class="fixed inset-0 z-[70] bg-black/30 flex items-center justify-center"
      @click.self="close"
    >
      <div
        :class="['ch-modal', isAnimating && !isClosing ? 'mini-in' : '', isClosing ? 'mini-out' : '']"
      >
        <!-- 头部 -->
        <div class="flex items-center justify-between px-5 pt-4 pb-2 shrink-0">
          <h2 class="text-sm font-bold text-gray-900 flex items-center gap-2">
            <i class="fas fa-plug text-gray-700 text-[13px]"></i>{{ t('channel.title') }}
          </h2>
          <button
            class="w-7 h-7 flex items-center justify-center rounded-full bg-gray-100 text-gray-400 hover:text-gray-600 hover:bg-gray-200 transition-colors"
            @click="close"
          >
            <i class="fas fa-times text-xs"></i>
          </button>
        </div>

        <!-- Tab 切换（带品牌图标） -->
        <div class="px-5 pb-3 shrink-0">
          <div class="ch-tabs">
            <button
              v-for="m in CHANNEL_META"
              :key="m.id"
              :class="['ch-tab', activeTab === m.id ? 'is-active' : '']"
              @click="activeTab = m.id"
            >
              <i :class="m.icon" class="text-[11px]"></i>
              <span>{{ t(m.labelKey) }}</span>
            </button>
          </div>
        </div>

        <!-- 状态条 -->
        <div class="px-5 pb-3 shrink-0">
          <div class="ch-status">
            <span class="ch-dot" :style="{ background: curCfg.enabled ? meta.color : '#d1d5db' }"></span>
            <span class="text-[11px] text-gray-600">
              {{ curCfg.enabled ? t('channel.enabled') : t('channel.disabled') }}
              <template v-if="curCfg.nickname"> · {{ curCfg.nickname }}</template>
            </span>
            <div class="flex-1"></div>
            <button
              class="ch-power"
              :class="{ 'is-on': curCfg.enabled }"
              :title="curCfg.enabled ? t('channel.disable') : t('channel.enable')"
              @click="toggleEnabled"
            >
              <Power :size="12" :stroke-width="2" />
            </button>
          </div>
        </div>

        <!-- 主体（可滚动） -->
        <div class="flex-1 min-h-0 overflow-y-auto overflow-x-hidden custom-scroll px-5">
          <!-- 0920：远程访问 —— 连接信息（局域网地址 + 手机扫码）。
               地址与二维码由后端 `remote.info` 现算（本机网卡 IPv4 + 真实端口 + qrcode）；
               开关没打开时后端会拒掉局域网请求，所以这里也要求先开开关。 -->
          <div v-if="activeTab === 'remote'" class="mb-4">
            <div class="ch-section-title mb-2">{{ t('channel.remoteConnect') }}</div>
            <div class="ch-wx-card">
              <p v-if="!curCfg.enabled" class="text-[11px] text-gray-500 leading-relaxed">
                {{ t('channel.remoteDisabledHint') }}
              </p>
              <div v-else-if="!remoteInfo.url" class="flex items-center gap-2">
                <LoaderCircle :size="13" :stroke-width="2" class="animate-spin text-gray-400" />
                <p class="text-[11px] text-gray-500">{{ t('channel.remoteNoLan') }}</p>
              </div>
              <template v-else>
                <div class="flex items-start gap-3">
                  <img
                    v-if="remoteInfo.qr"
                    :src="remoteInfo.qr"
                    alt="remote qr"
                    class="w-[112px] h-[112px] rounded-lg bg-white p-1 flex-none"
                  />
                  <div class="flex-1 min-w-0">
                    <div class="text-[10px] text-gray-400 mb-1.5">{{ t('channel.remoteScanHint') }}</div>
                    <div class="flex items-center gap-1.5">
                      <code class="text-[11px] text-gray-800 break-all flex-1 min-w-0">{{ remoteInfo.url }}</code>
                      <button class="ch-btn-plain flex-none" @click="copyRemoteUrl">
                        <Check v-if="remoteCopied" :size="11" :stroke-width="2.5" />
                        <ExternalLink v-else :size="11" :stroke-width="2" />
                        <span>{{ remoteCopied ? t('channel.copied') : t('channel.copy') }}</span>
                      </button>
                    </div>
                    <div v-if="remoteInfo.urls.length > 1" class="text-[10px] text-gray-400 mt-1.5 break-all">
                      {{ t('channel.remoteOtherAddrs') }}：{{ remoteInfo.urls.slice(1).join('  ') }}
                    </div>
                    <div v-if="remoteInfo.tokenRequired" class="text-[10px] text-emerald-600 mt-1.5">
                      {{ t('channel.remoteTokenHint') }}
                    </div>
                    <div v-else class="text-[10px] text-amber-600 mt-1.5 leading-relaxed">
                      {{ t('channel.remoteNoToken') }}
                    </div>
                    <div class="flex items-center gap-2 mt-2">
                      <button class="ch-btn-plain" :disabled="remoteRegenBusy" @click="regenRemoteToken">
                        <LoaderCircle v-if="remoteRegenBusy" :size="11" :stroke-width="2" class="animate-spin" />
                        <span>{{ t('channel.remoteRegen') }}</span>
                      </button>
                      <span v-if="remoteRegenMsg" class="text-[10px] text-gray-500">{{ remoteRegenMsg }}</span>
                    </div>
                  </div>
                </div>
              </template>
            </div>
          </div>

          <!-- ★1012【云服务器中转】SSH 反向隧道：把界面端口暴露到**用户自带的公网服务器**，
               于是在外面用手机也能连回家 —— 不受家里路由器怎么接、有没有公网 IP 的限制。
               四步：复制公钥命令 → 贴到服务器执行 → 填 4 个框 → 打开开关。
               与上面的"局域网地址"并存，两个入口不冲突（在家走局域网、在外走公网）。 -->
          <div v-if="activeTab === 'remote'" class="mb-4">
            <div class="ch-section-title mb-2 flex items-center gap-2">
              <span>{{ t('channel.tunnelTitle') }}</span>
              <span
                class="px-1.5 py-0.5 rounded text-[10px] font-medium"
                :class="tunnel.running ? 'bg-emerald-50 text-emerald-600' : 'bg-gray-100 text-gray-500'"
              >{{ tunnel.running ? t('channel.tunnelOn') : t('channel.tunnelOff') }}</span>
              <LoaderCircle v-if="tunnelBusy" :size="11" :stroke-width="2" class="animate-spin text-gray-400" />
            </div>
            <div class="ch-wx-card space-y-2.5">
              <div class="text-[11px] text-gray-600 leading-relaxed">{{ t('channel.tunnelIntro') }}</div>

              <!-- 第 1 步：把公钥装到服务器（面板直接给一行命令） -->
              <div>
                <div class="text-[11px] text-gray-700 mb-1">{{ t('channel.tunnelStep1') }}</div>
                <code class="block text-[10px] leading-relaxed text-gray-700 break-all bg-gray-50 rounded p-2 max-h-[72px] overflow-y-auto custom-scroll">
                  {{ tunnel.setupCommand || t('channel.tunnelKeyLoading') }}
                </code>
                <div class="flex items-center gap-2 mt-1.5">
                  <button class="ch-btn-plain" :disabled="!tunnel.setupCommand" @click="copyTunnelCmd">
                    <Check v-if="tunnelCmdCopied" :size="11" :stroke-width="2.5" />
                    <ExternalLink v-else :size="11" :stroke-width="2" />
                    <span>{{ tunnelCmdCopied ? t('channel.copied') : t('channel.tunnelCopyCmd') }}</span>
                  </button>
                  <span v-if="tunnel.keyErr" class="text-[10px] text-rose-500 break-all">{{ tunnel.keyErr }}</span>
                </div>
              </div>

              <!-- ★1012f：粘贴服务器返回的配置码 —— 一个框搞定，不用手填下面四项 -->
              <div>
                <div class="text-[11px] text-gray-700 mb-1">{{ t('channel.tunnelStepCode') }}</div>
                <div class="flex items-center gap-1.5">
                  <input
                    v-model="tunnelCode"
                    class="flex-1 min-w-0 text-[11px] px-2 py-1 rounded border border-gray-200 focus:border-indigo-300 outline-none font-mono"
                    :placeholder="t('channel.tunnelCodePlaceholder')"
                    @keyup.enter="applyTunnelCode"
                  />
                  <button class="ch-btn-plain flex-none" :disabled="tunnelBusy || !tunnelCode.trim()" @click="applyTunnelCode">
                    <LoaderCircle v-if="tunnelBusy" :size="11" :stroke-width="2" class="animate-spin" />
                    <span>{{ t('channel.tunnelCodeApply') }}</span>
                  </button>
                </div>
                <div v-if="tunnelCodeMsg" class="text-[10px] text-gray-500 mt-1 break-all">{{ tunnelCodeMsg }}</div>
              </div>

              <!-- ★1012j（已定案）：原来这里还有"手动填写服务器信息"的 4 个输入框，现已删除 ——
                   粘贴配置码会把 host / user / SSH端口 / 对外端口 全都带过来，手填纯属冗余，
                   而且容易改乱（如把端口改成没放行的）导致连不上。排错时若确需手填，
                   直接改后端 data/tunnel.json 再重启即可。 -->

              <!-- 开关 + 结果 -->
              <div class="flex items-center gap-2 pt-0.5">
                <button class="ch-btn-plain" :disabled="tunnelBusy" @click="toggleTunnel">
                  <LoaderCircle v-if="tunnelBusy" :size="11" :stroke-width="2" class="animate-spin" />
                  <span>{{ tunnel.running ? t('channel.tunnelStop') : t('channel.tunnelStart') }}</span>
                </button>
                <span v-if="tunnelMsg" class="text-[10px] text-gray-500 break-all">{{ tunnelMsg }}</span>
              </div>

              <div v-if="tunnel.publicUrl" class="pt-0.5">
                <div class="text-[10px] text-gray-400 mb-1">{{ t('channel.tunnelPublicUrl') }}</div>
                <div class="flex items-center gap-1.5">
                  <code class="text-[11px] text-gray-800 break-all flex-1 min-w-0">{{ tunnel.publicUrl }}</code>
                  <button class="ch-btn-plain flex-none" @click="copyTunnelUrl">
                    <Check v-if="tunnelUrlCopied" :size="11" :stroke-width="2.5" />
                    <ExternalLink v-else :size="11" :stroke-width="2" />
                    <span>{{ tunnelUrlCopied ? t('channel.copied') : t('channel.copy') }}</span>
                  </button>
                </div>
              </div>
              <div v-if="tunnel.lastErr && !tunnel.running" class="text-[10px] text-rose-500 break-all leading-relaxed">
                {{ tunnel.lastErr }}
              </div>
            </div>
          </div>

          <!-- ── 机器人（0912 十批：tab 切换 + 弹窗新建）──
               微信：单账号走扫码；QQ：多机器人，每个 tab = 一台，
               模型/预设/权限/人格都跟着选中的 tab 走。
               ⚠️ 0920 修：这段注释原先多写了一行（"QQ：支持多机器人（官方 Bot API 就是多 app 并存）" + 注释结束标记），
               而上一行的注释结束标记**已经闭合过** ⇒ 那行成了裸文本、被渲染到界面上
               （三个 tab 都能看到，连远程访问里也显示 QQ 文案）。
               写法提醒：多行注释只留一个结尾标记；也**别在注释正文里写字面的结束标记**，同样会提前闭合。 -->
          <!-- 机器人列表与新建入口只属于微信/QQ；远程访问没有"机器人"概念（0920 起加 v-if 排除） -->
          <div v-if="activeTab !== 'remote'" class="mb-4">
            <div class="flex items-center justify-between mb-2">
              <div class="ch-section-title mb-0">
                {{ t('channel.bots') }}
                <span v-if="curCfg.bots.length" class="text-gray-400 font-normal ml-1">{{ curCfg.bots.length }}</span>
              </div>
              <!-- QQ 才显示「添加」（微信走扫码，不手动加）—— 0912 十批：改成弹窗 -->
              <button v-if="activeTab === 'qq'" class="ch-help-btn" @click="openBotModal">
                <Plus :size="11" :stroke-width="2" />
                <span>{{ t('channel.botAdd') }}</span>
              </button>
            </div>

            <!-- ── 微信：点按钮出二维码（大图弹窗；不再用悬停浮层）── -->
            <template v-if="activeTab === 'wechat'">
              <div class="ch-wx-card">
                <div class="flex items-center gap-2.5">
                  <i class="fab fa-weixin text-[16px]" style="color:#07c160"></i>
                  <div class="flex-1 min-w-0">
                    <div class="text-[11px] text-gray-800">
                      {{ curCfg.bots.length ? (curCfg.bots[0].nickname || curCfg.bots[0].accountId) : t('channel.wechatNotBound') }}
                    </div>
                    <div class="text-[10px] text-gray-400">
                      <template v-if="!curCfg.bots.length">{{ t('channel.wechatClickHint') }}</template>
                      <template v-else-if="wxOnline">{{ t('channel.wechatConnected') }}</template>
                      <template v-else><span style="color:#f59e0b">{{ t('channel.wechatDisconnected') }}</span></template>
                    </div>
                  </div>
                  <button class="ch-btn-plain" :disabled="qrBusy" @click.stop="startWechatQr">
                    <QrCode :size="11" :stroke-width="2" />
                    <span>{{ curCfg.bots.length ? t('channel.wechatRebind') : t('channel.wechatBind') }}</span>
                  </button>
                </div>
              </div>
            </template>

            <!-- ── 机器人 tab（QQ 多机器人：每个 tab = 一台，选中即"当前配置对象"）── -->
            <template v-if="activeTab === 'qq'">
              <div v-if="!curCfg.bots.length" class="ch-empty-sm">
                <p class="text-[10px] text-gray-400 text-center">{{ t('channel.noBots') }}</p>
              </div>
              <template v-else>
                <div class="ch-bot-tabs mb-2">
                  <button
                    v-for="b in curBots"
                    :key="b.id"
                    class="ch-bot-tab"
                    :class="{ 'is-active': activeBotId === b.id }"
                    @click="selectBot(b.id)"
                  >
                    <span class="ch-tab-dot" :class="{ 'is-on': !!botOnline[b.id] }"></span>
                    <span class="truncate">{{ b.nickname || b.accountId }}</span>
                  </button>
                </div>

                <!-- 选中机器人的信息 + 操作（模型/预设/权限/人格都作用于这台） -->
                <div v-if="activeBot" class="ch-bot-detail" :class="{ 'is-off': !activeBot.enabled }">
                  <div class="flex items-center gap-2">
                    <span class="flex-1 min-w-0 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-gray-400">
                      <span class="truncate">
                        {{ activeBot.accountId }}<template v-if="activeBot.hasSecret"> · {{ t('channel.secretSet') }}</template>
                        <template v-if="botOnline[activeBot.id]"> · <span style="color:#22c55e">{{ t('channel.online') }}</span></template>
                        <template v-else-if="activeBot.enabled"> · <span style="color:#f59e0b">{{ t('channel.offline') }}</span></template>
                      </span>
                      <!-- ★1015d：PC 接管码并进这一排（需求）。按钮用普通小按钮 —— 别用方形图标按钮的类，
                           否则文字会被挤成竖排（"换一个"竖成三行）。 -->
                      <span v-if="pcCodes[activeBot.id]" class="flex items-center gap-1 shrink-0 whitespace-nowrap">
                        {{ t('channel.pcCode') }}
                        <span class="font-mono text-gray-600 select-all">{{ pcCodes[activeBot.id] }}</span>
                        <button
                          class="px-1.5 py-[1px] rounded border border-gray-200 text-[10px] text-gray-500 hover:bg-gray-50 whitespace-nowrap transition-colors"
                          :title="t('channel.pcCodeHint')"
                          :disabled="pcRotating"
                          @click="rotatePcCode"
                        >{{ t('channel.pcCodeRotate') }}</button>
                      </span>
                    </span>
                    <button class="ch-mini-btn" :title="activeBot.enabled ? t('channel.disable') : t('channel.enable')" @click="toggleBot(activeBot.id, !activeBot.enabled)">
                      <Power :size="11" :stroke-width="2" />
                    </button>
                    <button class="ch-mini-btn is-danger" :title="t('channel.delete')" @click="removeBot(activeBot.id)">
                      <Trash2 :size="11" :stroke-width="2" />
                    </button>
                  </div>
                  <!-- ★1015c：取码失败**直接显示原因**（不静默，否则"看不到码"没法查） -->
                  <div v-if="pcCodesErr" class="mt-1 text-[10px] break-all" style="color:#ef4444">
                    取 PC 接管码失败：{{ pcCodesErr }}
                  </div>
                  <!-- 人格与称呼：下拉总开关 + 编辑按钮（选「自定义」后才可点） -->
                  <div class="ch-persona-row">
                    <div class="ch-persona-select">
                      <MiniSelect
                        :model-value="personaModeOf(activeBot)"
                        :options="personaModeOptions"
                        width="w-full"
                        @update:model-value="(v: string) => setPersonaMode(activeBotId, v)"
                      />
                    </div>
                    <button
                      class="ch-list-toggle ch-persona-open"
                      :class="{ 'is-locked': personaModeOf(activeBot) !== 'custom' }"
                      :disabled="personaModeOf(activeBot) !== 'custom'"
                      :title="personaModeOf(activeBot) !== 'custom' ? t('channel.personaLockedHint') : ''"
                      @click="openPersonaModal(activeBot)"
                    >
                      <UserCog :size="12" :stroke-width="1.9" class="shrink-0" />
                      <span class="flex-1 text-left">{{ t('channel.personaEdit') }}</span>
                      <span v-if="hasPersona(activeBot)" class="ch-persona-dot" :title="t('channel.personaCustom')"></span>
                    </button>
                  </div>
                </div>
              </template>
            </template>

            <!-- 微信：单账号，人格开关同样放在卡片下方 -->
            <div v-if="activeTab === 'wechat' && curCfg.bots.length" class="ch-persona-row mt-2">
              <div class="ch-persona-select">
                <MiniSelect
                  :model-value="personaModeOf(curCfg.bots[0])"
                  :options="personaModeOptions"
                  width="w-full"
                  @update:model-value="(v: string) => setPersonaMode(curCfg.bots[0].id, v)"
                />
              </div>
              <button
                class="ch-list-toggle ch-persona-open"
                :class="{ 'is-locked': personaModeOf(curCfg.bots[0]) !== 'custom' }"
                :disabled="personaModeOf(curCfg.bots[0]) !== 'custom'"
                :title="personaModeOf(curCfg.bots[0]) !== 'custom' ? t('channel.personaLockedHint') : ''"
                @click="openPersonaModal(curCfg.bots[0])"
              >
                <UserCog :size="12" :stroke-width="1.9" class="shrink-0" />
                <span class="flex-1 text-left">{{ t('channel.personaEdit') }}</span>
                <span v-if="hasPersona(curCfg.bots[0])" class="ch-persona-dot" :title="t('channel.personaCustom')"></span>
              </button>
            </div>
          </div>

          <!-- ── 模型 / 预设 / 权限（0912 十批：绑定当前选中的机器人）── -->
          <div v-if="cfgTarget || activeTab === 'wechat'" class="mb-4">
            <div class="flex items-center justify-between mb-2">
              <div class="ch-section-title mb-0">{{ t('channel.modelConfig') }}</div>
              <span v-if="cfgTarget" class="text-[10px] text-gray-400 truncate ml-2">
                {{ t('channel.cfgForBot') }}{{ cfgTarget.nickname || cfgTarget.accountId }}
              </span>
            </div>
            <div class="ch-card space-y-2.5">
              <div>
                <div class="text-[10px] text-gray-400 mb-1.5">{{ t('channel.modelHint') }}</div>
                <!-- 用 MiniSelect 而非 ModelSelector：MiniSelect 的弹层 Teleport 到 body + fixed 定位，
                     彻底脱离本弹窗滚动容器的 overflow 裁切（ModelSelector 的下拉是相对按钮的 absolute，
                     实测会被裁掉看不见）。分组=供应商名，选项=模型名。 -->
                <!-- 0912 反馈：模型 + 推理强度横排；模型选「跟随（后台模型）」时强度行照常显示
                     （挡位按**后台模型**算 —— 见 effModelProviderId / effModelId / effEffort，★1013）。 -->
                <div class="ch-model-row">
                  <div class="flex-1 min-w-0">
                    <MiniSelect
                      :model-value="modelSelectValue"
                      :options="modelOptions"
                      :placeholder="followGlobalLabel"
                      width="w-full"
                      @update:model-value="onModelSelect"
                    />
                  </div>
                  <!-- 跟随全局 → 只读投影（显示全局强度、按不动）；指定了模型 → 可编辑（0913 反馈） -->
                  <EffortPicker
                    :model-value="effEffort"
                    :provider-id="effModelProviderId"
                    :model-id="effModelId"
                    :readonly="effModelFollowsGlobal"
                    @update:model-value="onEffortSelect"
                  />
                </div>
              </div>
              <div>
                <div class="text-[10px] text-gray-400 mb-1.5">{{ t('channel.presetHint') }}</div>
                <!-- 预设：只列 Agent 预设（不含团队）—— 团队需成员编排，不适合 IM 场景临时选 -->
                <MiniSelect
                  :model-value="effCfg.presetId"
                  :options="presetOptions"
                  :placeholder="t('channel.followGlobalPreset')"
                  width="w-full"
                  @update:model-value="onPresetSelect"
                />
              </div>
              <!-- ★1013g（已定案）：通道级权限档已删 —— 权限统一归"对话自己"（PC 端输入框上方 / IM 里 /perm） -->
              <div class="text-[10px] text-gray-400 leading-4">{{ t('channel.permHint') }}</div>

              <!-- 群聊插嘴（0912 二十四批）：QQ 群专用；开关关着时下面两项置灰 -->
              <div v-if="activeTab === 'qq'">
                <div class="ch-interject-head">
                  <span class="text-[10px] text-gray-400">{{ t('channel.interject') }}</span>
                  <button
                    class="ch-switch"
                    :class="{ 'is-on': effInterject.on }"
                    :title="effInterject.on ? t('channel.interjectOff') : t('channel.interjectOn')"
                    @click="toggleInterject"
                  >
                    <span class="ch-switch-knob"></span>
                  </button>
                </div>
                <p class="text-[10px] text-gray-400 mt-1 leading-relaxed">{{ t('channel.interjectHint') }}</p>
                <div v-if="effInterject.on" class="mt-2 space-y-2">
                  <MiniSelect
                    :model-value="effInterject.scope"
                    :options="interjectScopeOptions"
                    width="w-full"
                    @update:model-value="onInterjectScope"
                  />
                  <!-- 插嘴词（0913 二版：标签化）—— 点击弹小窗输入 → 确定变标签；一行放不下显示 +n（悬停看全部） -->
                  <div>
                    <div class="flex items-center justify-between mb-1">
                      <span class="text-[10px] text-gray-400">{{ t('channel.interjectKeywords') }}</span>
                      <button class="ch-kw-add" type="button" @click="openKwModal">
                        <i class="fas fa-plus text-[9px]"></i>
                        <span>{{ t('channel.interjectKwAdd') }}</span>
                      </button>
                    </div>
                    <div class="ch-kw-box" :class="{ 'is-empty': !kwList.length }" @click="openKwModal">
                      <template v-if="kwList.length">
                        <span v-for="w in kwVisible" :key="w" class="ch-kw-chip">
                          <span class="truncate">{{ w }}</span>
                          <i class="fas fa-xmark ch-kw-del" :title="t('channel.interjectKwRemove')" @click.stop="removeKw(w)"></i>
                        </span>
                        <span v-if="kwHidden.length" class="ch-kw-chip is-more" :title="kwHiddenText">+{{ kwHidden.length }}</span>
                      </template>
                      <span v-else class="text-[11px] text-gray-400">{{ t('channel.interjectKwEmpty') }}</span>
                    </div>

                    <!-- 加词小窗：Teleport 到 body（弹窗滚动容器会裁掉内部浮层） -->
                    <Teleport to="body">
                      <div v-if="kwModalOpen" class="fixed inset-0 z-[10060] flex items-center justify-center bg-black/40" @click.self="kwModalOpen = false">
                        <div class="ch-kw-modal">
                          <h4 class="ch-kw-modal-title">{{ t('channel.interjectKwModalTitle') }}</h4>
                          <input
                            v-model="kwDraft"
                            class="ch-field"
                            :placeholder="t('channel.interjectKeywordsPh')"
                            @keydown.enter.prevent="confirmKw"
                          />
                          <p class="ch-kw-modal-hint">{{ t('channel.interjectKwModalHint') }}</p>
                          <div class="flex justify-end gap-2 mt-3">
                            <button class="btn btn-secondary btn-sm" type="button" @click="kwModalOpen = false">{{ t('agent.cancel') }}</button>
                            <button class="btn btn-primary btn-sm" type="button" @click="confirmKw">{{ t('agent.save') }}</button>
                          </div>
                        </div>
                      </div>
                    </Teleport>
                  </div>
                  <!-- 额度 + 冷却（0912 反馈2：「同一行显示」）—— 两项各占一半宽、并排；
                       「0 的含义」合并成下面一行小字，不再各自拖一条长尾巴把行撑爆。 -->
                  <div class="flex items-center gap-3">
                    <div class="flex items-center gap-1.5 flex-1 min-w-0">
                      <span class="text-[10px] text-gray-400 shrink-0">{{ t('channel.interjectPerHour') }}</span>
                      <input
                        :value="effInterject.perHour"
                        type="number"
                        min="0"
                        max="20"
                        class="ch-num-input"
                        @input="onPerHourInput"
                        @change="onInterjectPerHour(Number(($event.target as HTMLInputElement).value))"
                      />
                      <span class="text-[10px] text-gray-400 shrink-0">{{ t('channel.interjectPerHourUnit') }}</span>
                    </div>
                    <div class="flex items-center gap-1.5 flex-1 min-w-0">
                      <span class="text-[10px] text-gray-400 shrink-0">{{ t('channel.interjectCooldown') }}</span>
                      <input
                        :value="effInterject.cooldownSec"
                        type="number"
                        min="0"
                        max="86400"
                        class="ch-num-input"
                        @input="onCooldownInput"
                        @change="onInterjectCooldown(Number(($event.target as HTMLInputElement).value))"
                      />
                      <span class="text-[10px] text-gray-400 shrink-0">{{ t('channel.interjectCooldownUnit') }}</span>
                    </div>
                  </div>
                  <p class="text-[10px] text-gray-400 leading-snug">{{ t('channel.interjectZeroHint') }}</p>
                </div>
              </div>
            </div>
          </div>

          <!-- ── 会话详情 ── -->
          <!-- ★1011p：远程访问 tab 里没有「通道会话 / 独享对话」这个概念
               （远程链接 = 本机这套界面本身，不存在"通道专属对话列表"），
               所以整个区块（详情 + 独享对话按钮）在 remote tab 下不渲染。 -->
          <template v-if="detail && activeTab !== 'remote'">
            <div class="flex items-center gap-2 mb-3">
              <button class="ch-back" @click="detail = null">
                <ChevronLeft :size="13" :stroke-width="2" />
              </button>
              <span class="text-xs font-[640] text-gray-800 truncate flex-1">{{ detail.title }}</span>
              <button class="ch-open-main" @click="openInMain">
                <ExternalLink :size="11" :stroke-width="2" />
                <span>{{ t('channel.openInMain') }}</span>
              </button>
            </div>
            <div class="ch-card">
              <div class="ch-msg-row">
                <span class="ch-msg-badge">{{ t('channel.lastMessage') }}</span>
                <p class="text-[11px] text-gray-600 leading-relaxed whitespace-pre-wrap break-words">{{ detail.lastMessage || t('channel.emptyContent') }}</p>
              </div>
              <div class="ch-meta-line">
                <span>{{ t('channel.modelLabel') }}{{ detail.model || (providersStore.backgroundModelId ? t('channel.followBg') : t('channel.followBgUnset')) }}</span>
                <span>·</span>
                <span>{{ detail.status === 'running' ? t('channel.running') : t('channel.idle') }}</span>
                <span>·</span>
                <span>{{ relTime(detail.updatedAt) }}</span>
              </div>
              <div class="flex items-center gap-2 mt-3">
                <button class="ch-btn-plain flex-1" @click="moveToMain(detail)">
                  <ArrowRightLeft :size="11" :stroke-width="2" />
                  <span>{{ t('channel.moveToMain') }}</span>
                </button>
              </div>
              <p class="text-[10px] text-gray-400 mt-2.5 leading-relaxed">{{ t('channel.detailHint') }}</p>
            </div>
          </template>

          <!-- ── 独享对话：按钮 → 点击打开「多选弹窗」
               ★1011q：必须是 v-else-if（带 remote 排除）—— 只给上面的 v-if 加条件是错的：
               v-if 为 false 时 v-else **照样渲染**，于是远程 tab 里详情不显示、独享对话按钮仍在。 -->
          <template v-else-if="activeTab !== 'remote'">
            <button class="ch-list-toggle" @click="openSessionPicker">
              <MessageSquare :size="12" :stroke-width="1.9" class="shrink-0" />
              <span class="flex-1 text-left">{{ t('channel.sessions') }}</span>
              <span v-if="curSessions.length" class="ch-count">{{ curSessions.length }}</span>
            </button>
          </template>

          <!-- ── 命令区 ── -->
          <div class="mb-1 mt-4">
            <div class="flex items-center justify-between mb-2">
              <div class="ch-section-title mb-0">{{ t('channel.command') }}</div>
              <button class="ch-help-btn" @click="showHelp = !showHelp">
                <HelpCircle :size="11" :stroke-width="2" />
                <span>{{ t('channel.help') }}</span>
              </button>
            </div>

            <!-- 命令帮助 -->
            <div v-if="showHelp" class="ch-card mb-2">
              <div v-for="h in helpText" :key="h.usage" class="ch-help-row">
                <code class="ch-help-cmd">{{ h.usage }}</code>
                <span class="text-[10px] text-gray-500">{{ h.desc }}</span>
              </div>
            </div>

            <div class="flex items-center gap-1.5">
              <input
                v-model="cmdInput"
                class="ch-cmd-input"
                :placeholder="t('channel.commandPlaceholder')"
                @keydown.enter="runCmd"
              />
              <button class="ch-send" :disabled="!cmdInput.trim() || cmdBusy" @click="runCmd">
                <LoaderCircle v-if="cmdBusy" :size="12" :stroke-width="2" class="mem-spin" />
                <Send v-else :size="12" :stroke-width="2" />
              </button>
            </div>

            <div v-if="cmdReply" class="ch-reply">
              <component :is="cmdReply.startsWith('未知') || cmdReply.includes('失败') ? CircleX : CircleCheck" :size="11" :stroke-width="2" class="shrink-0 mt-0.5" />
              <pre class="flex-1 whitespace-pre-wrap break-words font-sans">{{ cmdReply }}</pre>
            </div>
            <p v-if="store.lastError" class="text-[10px] text-red-500 mt-2">{{ store.lastError }}</p>
          </div>
        </div>

        <!-- 底部说明 -->
        <div class="px-5 py-3 shrink-0">
          <p class="text-[10px] text-gray-400 leading-relaxed">{{ t(meta.descKey) }}</p>
        </div>
      </div>
    </div>
  </Teleport>

  <!-- ══ 独享对话「多选」弹窗：底部两按钮（转入聊天列表 / 关闭）══ -->
  <Teleport to="body">
    <div v-if="sessionPickerOpen" class="fixed inset-0 z-[80] bg-black/35 flex items-center justify-center" @click.self="sessionPickerOpen = false">
      <div class="ch-picker">
        <div class="flex items-center justify-between px-4 pt-3.5 pb-2 shrink-0">
          <h3 class="text-[13px] font-[640] text-gray-900">{{ t('channel.sessions') }}<span v-if="curSessions.length" class="text-gray-400 font-normal ml-1.5">{{ curSessions.length }}</span></h3>
          <div class="flex items-center gap-1.5">
            <!-- 新建对话（等价手机 /new）：建完自动设为当前，手机下一条消息进它 -->
            <button class="ch-new-btn" :disabled="newBusy" @click="createChannelSession">
              <LoaderCircle v-if="newBusy" :size="11" :stroke-width="2" class="mem-spin" />
              <Plus v-else :size="11" :stroke-width="2" />
              <span>{{ t('channel.newSession') }}</span>
            </button>
            <button class="ch-back" @click="sessionPickerOpen = false"><X :size="12" :stroke-width="2" /></button>
          </div>
        </div>

        <!-- 机器人切换已上移到主面板的 tab（0912 十批）——这里沿用主面板选中的机器人，不再重复一层 tab -->

        <!-- 私聊 / 群聊 两个 tab（0912 十七批；二十一批：微信没有群聊 → 只留私聊） -->
        <div class="px-4 pb-2 shrink-0">
          <div class="ch-pick-tabs">
            <button
              class="ch-pick-tab"
              :class="{ 'is-on': pickerKind === 'dm' }"
              @click="pickerKind = 'dm'"
            >{{ t('channel.tabDm') }}<span v-if="dmCount" class="ch-pick-tab-n">{{ dmCount }}</span></button>
            <button
              v-if="showGroupTab"
              class="ch-pick-tab"
              :class="{ 'is-on': pickerKind === 'group' }"
              @click="pickerKind = 'group'"
            >{{ t('channel.tabGroup') }}<span v-if="groupCount" class="ch-pick-tab-n">{{ groupCount }}</span></button>
          </div>
        </div>

        <!-- 全选条 -->
        <div v-if="pickerList.length" class="px-4 pb-2 shrink-0">
          <button class="ch-pick-all" @click="togglePickAll">
            <span class="ch-check" :class="{ 'is-on': pickedSessions.size > 0 && pickerList.every(s => pickedSessions.has(s.id)) }">
              <Check v-if="pickedSessions.size > 0 && pickerList.every(s => pickedSessions.has(s.id))" :size="10" :stroke-width="3" />
            </span>
            <span>{{ t('channel.selectAll') }}</span>
            <span class="flex-1"></span>
            <span class="text-[10px] text-gray-400">{{ t('channel.picked', { n: pickedSessions.size }) }}</span>
          </button>
        </div>

        <div class="flex-1 min-h-0 overflow-y-auto overflow-x-hidden custom-scroll px-4 pb-2">
          <div v-if="!pickerList.length" class="ch-empty">
            <MessageSquare :size="26" :stroke-width="1.4" class="text-gray-300" />
            <p class="text-[11px] text-gray-500 mt-2">{{ pickerKind === 'group' ? t('channel.noSessionsGroup') : t('channel.noSessions') }}</p>
            <p class="text-[10px] text-gray-400 mt-1 leading-relaxed text-center px-6">{{ t('channel.noSessionsHint') }}</p>
          </div>
          <div v-else class="space-y-1.5">
            <button
              v-for="(s, i) in pickerList"
              :key="s.id"
              class="ch-pick-row"
              :class="{ 'is-picked': pickedSessions.has(s.id), 'is-active': isActiveSession(s.id) }"
              @click="activateSession(s)"
            >
              <!-- 勾选框独立：「移到聊天列表」的多选器具（点它不触发「设为当前」） -->
              <span class="ch-check" :class="{ 'is-on': pickedSessions.has(s.id) }" @click.stop="togglePick(s.id)">
                <Check v-if="pickedSessions.has(s.id)" :size="10" :stroke-width="3" />
              </span>
              <!-- 序号（0912 十七批）：与手机 /list 的序号对齐，便于口头指认 -->
              <span class="ch-pick-idx">{{ i + 1 }}</span>
              <span class="flex-1 min-w-0 text-left">
                <span class="flex items-center gap-1.5 min-w-0">
                  <span class="text-[11px] font-[530] text-gray-800 truncate">{{ s.title }}</span>
                  <!-- 对端类型：私聊 / 群聊 / 频道（同机器人多会话时区分） -->
                  <span v-if="kindText(s.originKind)" class="ch-kind" :class="'is-' + s.originKind">{{ kindText(s.originKind) }}</span>
                  <!-- 对端名（群A/群B…）：点它可改名；多个群聊就靠这里区分 -->
                  <span
                    v-if="s.peerLabel"
                    class="ch-peer-badge"
                    :title="t('channel.renamePeerHint')"
                    @click.stop="openRenamePeer(s)"
                  >
                    <Pencil :size="9" :stroke-width="2" />
                    {{ s.peerLabel }}
                  </span>
                </span>
                <span class="block text-[10px] text-gray-400 truncate">{{ s.lastMessage || t('channel.emptyContent') }}</span>
              </span>
              <!-- 当前会话：绿色徽标；否则 hover 提示「设为当前」 -->
              <span v-if="isActiveSession(s.id)" class="ch-cur-badge">
                <span class="ch-cur-dot"></span>
                {{ t('channel.currentSession') }}
              </span>
              <span v-else class="ch-set-active">
                {{ activeBusy === s.id ? t('channel.switching') : t('channel.setActive') }}
              </span>
              <span class="text-[10px] text-gray-400 shrink-0">{{ relTime(s.updatedAt) }}</span>
            </button>
          </div>
        </div>

        <!-- 底部两按钮（0912 十一批：等长；「取消」→「删除」） -->
        <div class="px-4 py-3 flex gap-2 shrink-0">
          <button
            class="ch-btn-primary flex-1"
            :disabled="!pickedSessions.size || pickerBusy || deleteBusy"
            @click="movePickedToMain"
          >
            <LoaderCircle v-if="pickerBusy" :size="11" :stroke-width="2" class="mem-spin" />
            <ArrowRightLeft v-else :size="11" :stroke-width="2" />
            <span>{{ t('channel.moveToMain') }}<template v-if="pickedSessions.size">（{{ pickedSessions.size }}）</template></span>
          </button>
          <button
            class="ch-btn-danger flex-1"
            :disabled="!pickedSessions.size || deleteBusy || pickerBusy"
            @click="askDeletePicked"
          >
            <LoaderCircle v-if="deleteBusy" :size="11" :stroke-width="2" class="mem-spin" />
            <Trash2 v-else :size="11" :stroke-width="2" />
            <span>{{ t('channel.delete') }}<template v-if="pickedSessions.size">（{{ pickedSessions.size }}）</template></span>
          </button>
        </div>
      </div>
    </div>
  </Teleport>

  <!-- ══ 对端改名（0912 十七批）：群A → 「工作群」，列表与通知目标都跟着变 ══ -->
  <Teleport to="body">
    <div v-if="renamePeerTarget" class="fixed inset-0 z-[95] bg-black/40 flex items-center justify-center" @click.self="cancelRenamePeer">
      <div class="ch-confirm">
        <div class="flex items-center gap-2.5 mb-2">
          <span class="ch-confirm-icon is-info"><Pencil :size="13" :stroke-width="2.2" /></span>
          <h3 class="text-[13px] font-[640] text-gray-900 flex-1">{{ t('channel.renamePeerTitle') }}</h3>
        </div>
        <p class="text-[11px] text-gray-600 leading-relaxed mb-2">{{ t('channel.renamePeerBody') }}</p>
        <input
          v-model="peerDraft"
          class="ch-peer-input mb-3"
          :placeholder="t('channel.renamePeerPh')"
          maxlength="20"
          @keydown.enter.prevent="saveRenamePeer"
        />
        <div class="flex gap-2">
          <button class="ch-btn-primary flex-1" :disabled="peerBusy || !peerDraft.trim()" @click="saveRenamePeer">
            <LoaderCircle v-if="peerBusy" :size="11" :stroke-width="2" class="mem-spin" />
            <span>{{ t('channel.save') }}</span>
          </button>
          <button class="ch-btn-plain flex-1" @click="cancelRenamePeer">{{ t('tasks.cancel') }}</button>
        </div>
      </div>
    </div>
  </Teleport>

  <!-- ══ 删除对话确认（危险操作二次确认；行为=移入滞留处可恢复）══ -->
  <Teleport to="body">
    <div v-if="deleteConfirmOpen" class="fixed inset-0 z-[90] bg-black/40 flex items-center justify-center" @click.self="deleteConfirmOpen = false">
      <div class="ch-confirm">
        <div class="flex items-center gap-2.5 mb-2">
          <span class="ch-confirm-icon"><Trash2 :size="14" :stroke-width="2.2" /></span>
          <h3 class="text-[13px] font-[640] text-gray-900 flex-1">{{ t('channel.deleteConfirmTitle') }}</h3>
        </div>
        <p class="text-[11px] text-gray-600 leading-relaxed mb-1">
          {{ t('channel.deleteConfirmBody', { n: pickedSessions.size }) }}
        </p>
        <p class="text-[10px] text-gray-400 leading-relaxed mb-3">{{ t('channel.deleteConfirmNote') }}</p>
        <div class="flex gap-2">
          <button class="ch-btn-danger flex-1" :disabled="deleteBusy" @click="doDeletePicked">
            <LoaderCircle v-if="deleteBusy" :size="11" :stroke-width="2" class="mem-spin" />
            <span>{{ t('channel.deleteConfirmOk') }}</span>
          </button>
          <button class="ch-btn-plain flex-1" :disabled="deleteBusy" @click="deleteConfirmOpen = false">{{ t('channel.cancel') }}</button>
        </div>
      </div>
    </div>
  </Teleport>

  <!-- ══ 新建机器人弹窗（0912 十批：从下方展开表单改成弹窗）══ -->
  <Teleport to="body">
    <div v-if="botModalOpen" class="fixed inset-0 z-[80] bg-black/35 flex items-center justify-center" @click.self="closeBotModal">
      <div class="ch-persona-modal">
        <div class="flex items-center justify-between px-4 pt-3.5 pb-2 shrink-0">
          <h3 class="text-[13px] font-[640] text-gray-900">{{ t('channel.botAdd') }}</h3>
          <button class="ch-back" @click="closeBotModal"><X :size="12" :stroke-width="2" /></button>
        </div>

        <div class="px-4 pb-1 flex-1 min-h-0 overflow-y-auto overflow-x-hidden custom-scroll space-y-2.5">
          <div>
            <div class="ch-field-label">{{ t('channel.qqAppId') }}</div>
            <input v-model="botDraft.accountId" class="ch-field" :placeholder="t('channel.qqAppId')" />
          </div>
          <div>
            <div class="ch-field-label">{{ t('channel.qqAppSecret') }}</div>
            <input v-model="botDraft.secret" type="password" class="ch-field" :placeholder="t('channel.qqAppSecret')" />
          </div>
          <div>
            <div class="ch-field-label">{{ t('channel.botNickname') }}</div>
            <input v-model="botDraft.nickname" class="ch-field" :placeholder="t('channel.botNickname')" />
          </div>
          <p class="text-[9px] text-gray-400 leading-relaxed pb-1">{{ t('channel.botModalHint') }}</p>
        </div>

        <div class="px-4 py-3 flex gap-2 shrink-0">
          <button class="ch-btn-primary flex-1" :disabled="!botDraft.accountId.trim() || botBusy" @click="submitBot">
            <LoaderCircle v-if="botBusy" :size="11" :stroke-width="2" class="mem-spin" />
            <span>{{ t('channel.save') }}</span>
          </button>
          <button class="ch-btn-plain flex-1" @click="closeBotModal">{{ t('channel.cancel') }}</button>
        </div>
      </div>
    </div>
  </Teleport>

  <!-- ══ 人格与称呼编辑弹窗（每个机器人一份；风格对齐独享对话弹窗）══ -->
  <Teleport to="body">
    <div v-if="personaModalBotId" class="fixed inset-0 z-[80] bg-black/35 flex items-center justify-center" @click.self="closePersonaModal">
      <div class="ch-persona-modal">
        <div class="flex items-center justify-between px-4 pt-3.5 pb-2 shrink-0">
          <h3 class="text-[13px] font-[640] text-gray-900">
            {{ t('channel.personaTitle') }}
            <span class="text-gray-400 font-normal ml-1.5">{{ personaModalBot?.nickname || personaModalBot?.accountId }}</span>
          </h3>
          <button class="ch-back" @click="closePersonaModal"><X :size="12" :stroke-width="2" /></button>
        </div>

        <div class="px-4 pb-1 flex-1 min-h-0 overflow-y-auto overflow-x-hidden custom-scroll space-y-2.5">
          <div>
            <div class="ch-field-label">{{ t('channel.personaNameLabel') }}</div>
            <input v-model="personaDraft.personaName" class="ch-field" :placeholder="t('channel.personaNamePh')" />
          </div>
          <div>
            <div class="ch-field-label">{{ t('channel.addressNameLabel') }}</div>
            <input v-model="personaDraft.addressName" class="ch-field" :placeholder="t('channel.addressNamePh')" />
          </div>
          <div>
            <div class="ch-field-label">{{ t('channel.personaPromptLabel') }}</div>
            <textarea v-model="personaDraft.personaPrompt" class="ch-field ch-textarea" rows="4" :placeholder="t('channel.personaPromptPh')"></textarea>
          </div>
          <p class="text-[9px] text-gray-400 leading-relaxed pb-1">{{ t('channel.personaHint') }}</p>
        </div>

        <!-- 底部两按钮等长（对齐独享对话弹窗） -->
        <div class="px-4 py-3 flex gap-2 shrink-0">
          <button class="ch-btn-primary flex-1" :disabled="personaBusy" @click="savePersona">
            <LoaderCircle v-if="personaBusy" :size="11" :stroke-width="2" class="mem-spin" />
            <span>{{ t('channel.save') }}</span>
          </button>
          <button class="ch-btn-plain flex-1" @click="closePersonaModal">{{ t('channel.cancel') }}</button>
        </div>
      </div>
    </div>
  </Teleport>

  <!-- ══ 微信扫码「大图」弹窗（点击按钮时打开）══ -->
  <Teleport to="body">
    <div v-if="qrOpen" class="fixed inset-0 z-[85] bg-black/40 flex items-center justify-center" @click.self="closeQr">
      <div class="ch-qr-modal">
        <div class="flex items-center justify-between px-4 pt-3.5 pb-2">
          <h3 class="text-[13px] font-[640] text-gray-900 flex items-center gap-1.5">
            <i class="fab fa-weixin text-[13px]" style="color:#07c160"></i>{{ t('channel.wechatBind') }}
          </h3>
          <button class="ch-back" @click="closeQr"><X :size="12" :stroke-width="2" /></button>
        </div>

        <div class="px-5 pb-4 flex flex-col items-center">
          <!-- 二维码 -->
          <div class="ch-qr-box">
            <img v-if="qrImage" :src="qrImage" alt="微信二维码" class="w-full h-full object-contain" />
            <div v-else class="w-full h-full flex flex-col items-center justify-center gap-2">
              <LoaderCircle v-if="qrBusy" :size="24" :stroke-width="1.6" class="mem-spin text-gray-400" />
              <QrCode v-else :size="28" :stroke-width="1.4" class="text-gray-300" />
              <span class="text-[10px] text-gray-400">{{ qrBusy ? '正在获取二维码…' : (qrMsg || '点击下方按钮获取二维码') }}</span>
            </div>
          </div>

          <!-- 状态 -->
          <div class="flex items-center gap-1.5 mt-3">
            <LoaderCircle v-if="!qrDone && qrImage" :size="11" :stroke-width="2" class="mem-spin text-gray-400" />
            <CircleCheck v-else-if="qrDone" :size="12" :stroke-width="2" style="color:#22c55e" />
            <span class="text-[11px]" :class="qrDone ? 'text-green-600' : 'text-gray-600'">{{ qrMsg || t('channel.wechatScanTip') }}</span>
          </div>
          <p v-if="!qrDone" class="text-[10px] text-gray-400 mt-1.5 text-center leading-relaxed">{{ t('channel.wechatScanDetail') }}</p>

          <!-- 验证码输入（need_verifycode 时出现） -->
          <div v-if="qrVerifyOpen" class="w-full mt-3 ch-card">
            <p class="text-[10px] text-amber-700 mb-1.5">{{ t('channel.wechatVerifyHint') }}</p>
            <div class="flex gap-1.5">
              <input v-model="qrVerifyCode" class="ch-field flex-1" placeholder="123456" @keydown.enter="submitVerifyCode" />
              <button class="ch-btn-primary" @click="submitVerifyCode">{{ t('channel.save') }}</button>
            </div>
          </div>

          <button class="ch-btn-plain w-full mt-3" @click="startWechatQr">
            <i class="fas fa-rotate text-[10px]"></i>
            <span>{{ qrImage ? t('channel.wechatRefreshQr') : t('channel.wechatGetQr') }}</span>
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.ch-modal {
  width: 560px;
  max-width: 94vw;
  max-height: 82vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: #fff;
  border: 1.5px solid #e5e7eb;
  border-radius: 20px;
  box-shadow: 0 24px 70px -20px rgba(0, 0, 0, 0.4);
}

/* ── Tabs ── */
.ch-tabs {
  display: flex;
  gap: 2px;
  padding: 3px;
  background: #f3f4f6;
  border-radius: 10px;
}
.ch-tab {
  flex: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 6px 8px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: #6b7280;
  font-size: 12px;
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
}
.ch-tab:hover { color: #111827; }
.ch-tab.is-active {
  background: #fff;
  color: #111827;
  font-weight: 640;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
}

/* ── 状态条 ── */
.ch-status {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 8px 11px;
  background: #f9fafb;
  border: 1px solid #f3f4f6;
  border-radius: 10px;
}
.ch-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex: none;
}
.ch-badge-pending {
  font-size: 10px;
  color: #b45309;
  background: #fef3c7;
  border: 1px solid #fde68a;
  border-radius: 999px;
  padding: 1px 7px;
}
.ch-power {
  width: 24px;
  height: 24px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid #e5e7eb;
  border-radius: 50%;
  background: #fff;
  color: #9ca3af;
  cursor: pointer;
  transition: all 0.15s ease;
}
.ch-power:hover { border-color: #d1d5db; color: #374151; }
.ch-power.is-on { background: #111827; border-color: #111827; color: #fff; }

/* ── 区块 ── */
.ch-section-title {
  font-size: 10px;
  font-weight: 640;
  color: #9ca3af;
  letter-spacing: 0.03em;
  margin-bottom: 6px;
  text-transform: uppercase;
}
.ch-card {
  background: #fff;
  border: 1px solid #f3f4f6;
  border-radius: 12px;
  padding: 10px 11px;
}

/* ── 群聊插嘴开关（0912 二十四批）── */
.ch-interject-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.ch-switch {
  position: relative;
  width: 34px;
  height: 18px;
  border-radius: 999px;
  border: 1px solid #d1d5db;
  background: #e5e7eb;
  cursor: pointer;
  padding: 0;
  transition: background 0.18s ease, border-color 0.18s ease;
  flex-shrink: 0;
}
.ch-switch.is-on { background: #111827; border-color: #111827; }
.ch-switch-knob {
  position: absolute;
  top: 1px;
  left: 1px;
  width: 14px;
  height: 14px;
  border-radius: 999px;
  background: #fff;
  transition: transform 0.18s cubic-bezier(0.34, 1.4, 0.64, 1);
}
.ch-switch.is-on .ch-switch-knob { transform: translateX(16px); }
.ch-num-input {
  width: 52px;
  padding: 4px 6px;
  border: 1px solid #e5e7eb;
  border-radius: 7px;
  font-size: 11px;
  color: #374151;
  background: #fff;
  outline: none;
}
.ch-num-input:focus { border-color: #9ca3af; }

/* ── 插嘴词标签区（0913 二版）── */
.ch-kw-box {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 5px;
  min-height: 34px;
  padding: 5px 8px;
  background: #f9fafb;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  cursor: pointer;
  transition: border-color 0.15s ease;
}
.ch-kw-box:hover { border-color: #9ca3af; }
.ch-kw-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 120px;
  padding: 2px 6px 2px 8px;
  font-size: 11px;
  color: #374151;
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 999px;
}
.ch-kw-chip.is-more { padding: 2px 8px; cursor: help; color: #6b7280; }
.ch-kw-del { font-size: 9px; color: #9ca3af; cursor: pointer; }
.ch-kw-del:hover { color: #dc2626; }
.ch-kw-add {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 4px;
  font-size: 10px;
  color: #6b7280;
  background: transparent;
  border: none;
  border-radius: 5px;
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
}
.ch-kw-add:hover { background: #f3f4f6; color: #111827; }
/* 加词小窗（Teleport 到 body） */
.ch-kw-modal {
  width: 360px;
  padding: 18px;
  background: #fff;
  border-radius: 16px;
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.3);
}
.ch-kw-modal-title { font-size: 14px; font-weight: 640; color: #1f2937; margin-bottom: 10px; }
.ch-kw-modal-hint { font-size: 10px; color: #9ca3af; margin-top: 6px; }
html.dark .ch-switch { background: #34343e; border-color: #45454f; }
html.dark .ch-switch.is-on { background: #f2f2f6; border-color: #f2f2f6; }
html.dark .ch-switch.is-on .ch-switch-knob { background: #1b1b1f; }
html.dark .ch-num-input { background: #202027; border-color: #34343e; color: #e9e9ef; }
/* 0913 反馈：插嘴词等 `.ch-field` 输入框在深色下仍是浅底白框（漏了适配）→ 补齐；
   placeholder 单独调暗，否则浅灰字压在深底上几乎看不见。 */
html.dark .ch-field { background: #202027; border-color: #34343e; color: #e9e9ef; }
html.dark .ch-field:focus { border-color: #55555f; }
html.dark .ch-field::placeholder { color: #55555f; }
/* 插嘴词标签区 + 加词小窗（深色） */
html.dark .ch-kw-box { background: #202027; border-color: #34343e; }
html.dark .ch-kw-box:hover { border-color: #55555f; }
html.dark .ch-kw-chip { background: #2b2b33; border-color: #34343e; color: #e9e9ef; }
html.dark .ch-kw-chip.is-more { color: #9a9aa4; }
html.dark .ch-kw-del { color: #6f6f78; }
html.dark .ch-kw-del:hover { color: #f87171; }
html.dark .ch-kw-add { color: #9a9aa4; }
html.dark .ch-kw-add:hover { background: #2b2b33; color: #f2f2f6; }
html.dark .ch-kw-modal { background: #1b1b1f; border: 1px solid #2e2e36; }
html.dark .ch-kw-modal-title { color: #f2f2f6; }
html.dark .ch-kw-modal-hint { color: #6f6f78; }

/* ── 会话列表 ── */
.ch-list-toggle {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 9px 11px;
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 10px;
  color: #374151;
  font-size: 11px;
  font-weight: 530;
  cursor: pointer;
  transition: border-color 0.15s ease, background 0.15s ease;
}
.ch-list-toggle:hover { background: #fafafa; border-color: #d1d5db; }
.ch-list-toggle.is-open { border-color: #9ca3af; }
.ch-count {
  font-size: 10px;
  font-weight: 400;
  color: #6b7280;
  background: #f3f4f6;
  border-radius: 999px;
  padding: 1px 7px;
}
.ch-chev { color: #9ca3af; transition: transform 0.2s ease; }
.ch-list-toggle.is-open .ch-chev { transform: rotate(180deg); }

/* ── 机器人行 ── */
.ch-bot-row {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 7px 10px;
  background: #fff;
  border: 1px solid #f3f4f6;
  border-radius: 10px;
}
.ch-bot-row.is-off { opacity: 0.55; }

/* ── 危险操作确认弹窗（0112 十一批：删除对话）── */
.ch-confirm {
  width: 340px;
  max-width: 90vw;
  padding: 16px 18px;
  background: #fff;
  border: 1.5px solid #e5e7eb;
  border-radius: 16px;
  box-shadow: 0 24px 70px -20px rgba(0, 0, 0, 0.45);
}
.ch-confirm-icon {
  width: 26px;
  height: 26px;
  border-radius: 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: #fee2e2;
  color: #dc2626;
  flex: none;
}

/* ── 机器人（0912 十批：tab 切换 + 详情卡）── */
/* tab 上的在线圆点 */
.ch-tab-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #d1d5db;
  flex: none;
  display: inline-block;
  margin-right: 5px;
  vertical-align: middle;
}
.ch-tab-dot.is-on { background: #22c55e; }
/* 选中机器人的详情卡（信息 + 操作 + 人格开关） */
.ch-bot-detail {
  padding: 9px 11px;
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 10px;
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.ch-bot-detail.is-off { opacity: 0.6; }
/* 模型 + 推理强度横排（0912 反馈）：模型吃剩余宽度，强度胶囊固定不换行；
   stretch 让强度胶囊与模型下拉**等高**（模型不支持思考时 EffortPicker 不渲染，行高由下拉决定） */
.ch-model-row {
  display: flex;
  align-items: stretch;
  gap: 8px;
}
/* 双按钮行：前=下拉总开关（固定宽），后=编辑按钮（占满剩余） */
.ch-persona-row {
  display: flex;
  align-items: center;
  gap: 7px;
}
.ch-persona-select {
  width: 132px;
  flex: none;
}
/* 复用「独享对话」按钮的观感，但去掉整宽、作为第二个按钮 */
.ch-persona-open {
  flex: 1;
  min-width: 0;
}
.ch-persona-open.is-locked {
  opacity: 0.5;
  cursor: not-allowed;
}
.ch-persona-open.is-locked:hover { background: #fff; border-color: #e5e7eb; }
/* 已填过自定义内容的小圆点提示 */
.ch-persona-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #8b5cf6;
  flex: none;
}
/* 编辑弹窗（对齐 .ch-picker 观感） */
.ch-persona-modal {
  width: 420px;
  max-width: 92vw;
  max-height: 78vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: #fff;
  border: 1.5px solid #e5e7eb;
  border-radius: 18px;
  box-shadow: 0 24px 70px -20px rgba(0, 0, 0, 0.4);
}
.ch-field-label {
  font-size: 10px;
  color: #6b7280;
  margin-bottom: 4px;
}
.ch-textarea {
  resize: vertical;
  min-height: 54px;
  font-family: inherit;
  line-height: 1.5;
}
.ch-mini-btn {
  width: 22px;
  height: 22px;
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid #e5e7eb;
  border-radius: 50%;
  background: #fff;
  color: #9ca3af;
  cursor: pointer;
  transition: all 0.15s ease;
}
.ch-mini-btn:hover { border-color: #d1d5db; color: #374151; background: #f9fafb; }
.ch-mini-btn.is-danger:hover { border-color: #fca5a5; color: #dc2626; background: #fef2f2; }

/* ── 表单元素 ── */
.ch-field {
  width: 100%;
  font-size: 11px;
  color: #111827;
  background: #f9fafb;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  padding: 6px 9px;
  outline: none;
  transition: border-color 0.15s ease;
}
.ch-field:focus { border-color: #9ca3af; background: #fff; }
.ch-btn-primary {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  font-size: 11px;
  font-weight: 640;
  color: #fff;
  background: #111827;
  border: none;
  border-radius: 8px;
  padding: 7px 10px;
  cursor: pointer;
  transition: background 0.15s ease, opacity 0.15s ease;
}
.ch-btn-primary:hover:not(:disabled) { background: #374151; }
.ch-btn-primary:disabled { opacity: 0.4; cursor: not-allowed; }
/* 危险操作按钮（删除）：沿用它但配红色底，避免和主按钮混淆 */
.ch-btn-danger {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  font-size: 11px;
  font-weight: 640;
  color: #fff;
  background: #ef4444;
  border: none;
  border-radius: 8px;
  padding: 7px 12px;
  cursor: pointer;
  transition: background 0.14s ease;
}
.ch-btn-danger:hover:not(:disabled) { background: #dc2626; }
.ch-btn-danger:disabled { opacity: 0.4; cursor: not-allowed; }
.ch-btn-plain {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  font-size: 11px;
  color: #374151;
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  padding: 7px 10px;
  cursor: pointer;
  transition: all 0.15s ease;
}
.ch-btn-plain:hover { background: #f9fafb; border-color: #d1d5db; }
.ch-empty-sm {
  padding: 12px 0;
  border: 1px dashed #e5e7eb;
  border-radius: 10px;
}

/* ── 微信卡片（二维码走点击弹出的大图弹窗，不再用悬停浮层）── */
.ch-wx-card {
  position: relative;
  padding: 10px 11px;
  background: #fff;
  border: 1px solid #f3f4f6;
  border-radius: 12px;
}
.ch-qr-img { width: 140px; height: 140px; object-fit: contain; display: block; border-radius: 6px; }
.ch-qr-placeholder {
  width: 140px; height: 140px;
  display: flex; align-items: center; justify-content: center;
  background: #f9fafb; border-radius: 6px;
}
.ch-qr-msg { font-size: 10px; color: #374151; text-align: center; line-height: 1.5; }
.ch-qr-tip { font-size: 9px; color: #9ca3af; text-align: center; line-height: 1.45; }
.ch-fade-enter-active { transition: opacity 0.14s ease, transform 0.14s ease; }
.ch-fade-leave-active { transition: opacity 0.1s ease; }
.ch-fade-enter-from { opacity: 0; transform: translateX(-50%) translateY(4px); }

/* ── 独享对话「多选」弹窗 ── */
.ch-picker {
  width: 480px;
  max-width: 94vw;
  max-height: 74vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: #fff;
  border: 1.5px solid #e5e7eb;
  border-radius: 18px;
  box-shadow: 0 24px 70px -20px rgba(0, 0, 0, 0.4);
}
.ch-pick-all {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 6px 8px;
  font-size: 11px;
  color: #6b7280;
  background: #f9fafb;
  border: 1px solid #f3f4f6;
  border-radius: 9px;
  cursor: pointer;
}
.ch-pick-all:hover { background: #f3f4f6; }

/* 机器人切换（QQ 多机器人：各机器人的对话互相独立） */
.ch-bot-tabs {
  display: flex;
  gap: 4px;
  padding: 3px;
  background: #f3f4f6;
  border-radius: 9px;
  overflow-x: auto;
  scrollbar-width: none;
}
.ch-bot-tabs::-webkit-scrollbar { display: none; }
.ch-bot-tab {
  flex: 1;
  min-width: 0;
  padding: 5px 10px;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: #6b7280;
  font-size: 11px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: background 0.14s ease, color 0.14s ease;
}
.ch-bot-tab:hover { color: #111827; }
.ch-bot-tab.is-active {
  background: #fff;
  color: #111827;
  font-weight: 640;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
}
.ch-pick-row {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  background: #fff;
  border: 1px solid #f3f4f6;
  border-radius: 10px;
  cursor: pointer;
  transition: border-color 0.14s ease, background 0.14s ease;
}
.ch-pick-row:hover { border-color: #e5e7eb; background: #fafafa; }
.ch-pick-row.is-picked { border-color: #111827; background: #f9fafb; }

/* ── 0912 十七批：私聊/群聊 tab + 序号 + 对端名 ── */
.ch-pick-tabs {
  display: flex; gap: 3px; padding: 3px;
  background: #f3f4f6; border-radius: 9px;
}
.ch-pick-tab {
  flex: 1; display: inline-flex; align-items: center; justify-content: center; gap: 4px;
  padding: 5px 6px; border: none; border-radius: 7px;
  background: transparent; color: #6b7280;
  font-size: 11px; cursor: pointer;
  transition: background 0.14s ease, color 0.14s ease;
}
.ch-pick-tab:hover { color: #111827; }
.ch-pick-tab.is-on { background: #fff; color: #111827; font-weight: 640; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08); }
.ch-pick-tab-n {
  font-size: 9px; padding: 0 4px; border-radius: 999px;
  background: #e5e7eb; color: #6b7280;
}
.ch-pick-tab.is-on .ch-pick-tab-n { background: #111827; color: #fff; }
/* 序号：与手机 /list 的序号对齐，方便口头指认「第 2 个」 */
.ch-pick-idx {
  width: 16px; flex: none; text-align: center;
  font-size: 10px; color: #9ca3af;
  font-variant-numeric: tabular-nums;
}
/* 对端名徽标（群A/群B…）：可点击改名 */
.ch-peer-badge {
  display: inline-flex; align-items: center; gap: 3px;
  font-size: 9px; padding: 1px 5px; border-radius: 999px;
  background: #eef2ff; color: #4f46e5; border: 1px solid #c7d2fe;
  cursor: pointer; flex: none;
}
.ch-peer-badge:hover { background: #e0e7ff; border-color: #a5b4fc; }
.ch-peer-input {
  width: 100%;
  font-size: 12px; color: #111827;
  background: #fff; border: 1px solid #e5e7eb; border-radius: 9px;
  padding: 7px 10px; outline: none;
}
.ch-peer-input:focus { border-color: #9ca3af; }
.ch-confirm-icon.is-info { background: #eef2ff; color: #4f46e5; }
.ch-check {
  width: 15px; height: 15px;
  flex: none;
  display: inline-flex; align-items: center; justify-content: center;
  border: 1.5px solid #d1d5db;
  border-radius: 4px;
  color: #fff;
  transition: all 0.14s ease;
}
.ch-check.is-on { background: #111827; border-color: #111827; }

/* ── 0912 三批：当前对话标记 / 新建对话 / 设为当前 ── */
.ch-new-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 9px;
  font-size: 11px;
  color: #111827;
  background: #f3f4f6;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  cursor: pointer;
  transition: background 0.14s ease, border-color 0.14s ease;
}
.ch-new-btn:hover:not(:disabled) { background: #e5e7eb; }
.ch-new-btn:disabled { opacity: 0.6; cursor: default; }

/* 行内「设为当前」提示：常态极浅，hover 行时加深（不抢标题注意力） */
.ch-set-active {
  flex: none;
  font-size: 10px;
  color: #c9cdd4;
  transition: color 0.14s ease;
}
.ch-pick-row:hover .ch-set-active { color: #6b7280; }

/* 当前会话：绿色徽标（= 手机消息落点）+ 行描边 */
.ch-pick-row.is-active { border-color: #a7e8c8; background: #f6fdf9; }
.ch-pick-row.is-active:hover { border-color: #10b981; background: #f0fbf6; }
.ch-cur-badge {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 7px;
  font-size: 10px;
  font-weight: 560;
  color: #0f9d6b;
  background: #e8f9f0;
  border-radius: 999px;
}
.ch-cur-dot {
  width: 5px; height: 5px;
  border-radius: 50%;
  background: #10b981;
  flex: none;
}

/* 对端类型徽标（私聊 / 群聊 / 频道）—— 区分同一机器人下的不同聊天场景 */
.ch-kind {
  flex: none;
  padding: 1px 5px;
  font-size: 9px;
  line-height: 1.5;
  font-weight: 560;
  border-radius: 4px;
  white-space: nowrap;
}
.ch-kind.is-c2c { color: #6b7280; background: #f3f4f6; }
.ch-kind.is-group { color: #b45309; background: #fef3c7; }
.ch-kind.is-channel { color: #4338ca; background: #e0e7ff; }

/* ── 微信扫码大图弹窗 ── */
.ch-qr-modal {
  width: 360px;
  max-width: 92vw;
  background: #fff;
  border: 1.5px solid #e5e7eb;
  border-radius: 18px;
  box-shadow: 0 24px 70px -20px rgba(0, 0, 0, 0.4);
}
.ch-qr-box {
  width: 200px; height: 200px;
  border: 1px solid #f3f4f6;
  border-radius: 12px;
  background: #fff;
  overflow: hidden;
  display: flex; align-items: center; justify-content: center;
}

.ch-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 26px 0;
  border: 1px dashed #e5e7eb;
  border-radius: 12px;
}
.ch-session {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  text-align: left;
  background: #fff;
  border: 1px solid #f3f4f6;
  border-radius: 10px;
  transition: border-color 0.15s ease, background 0.15s ease;
}
.ch-session:hover { border-color: #e5e7eb; background: #fafafa; }
.ch-session-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #d1d5db;
  flex: none;
}
.ch-session-dot.is-running { background: #6366f1; }
.ch-refresh {
  width: 22px;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: #9ca3af;
  border-radius: 6px;
  cursor: pointer;
}
.ch-refresh:hover { background: #f3f4f6; color: #374151; }

/* ── 详情 ── */
.ch-back {
  width: 22px;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid #e5e7eb;
  border-radius: 50%;
  background: #fff;
  color: #6b7280;
  cursor: pointer;
  flex: none;
}
.ch-back:hover { background: #f9fafb; color: #111827; }
.ch-open-main {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 10px;
  color: #fff;
  background: #111827;
  border: none;
  border-radius: 999px;
  padding: 4px 10px;
  cursor: pointer;
  flex: none;
  transition: background 0.15s ease;
}
.ch-open-main:hover { background: #374151; }
.ch-msg-row { display: flex; gap: 7px; align-items: flex-start; }
.ch-msg-badge {
  font-size: 9px;
  color: #6b7280;
  background: #f3f4f6;
  border-radius: 999px;
  padding: 1px 6px;
  flex: none;
  margin-top: 1px;
}
.ch-meta-line {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 10px;
  color: #9ca3af;
  margin-top: 8px;
}

/* ── 命令区 ── */
.ch-help-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 10px;
  color: #6b7280;
  background: transparent;
  border: none;
  cursor: pointer;
  padding: 2px 4px;
  border-radius: 6px;
}
.ch-help-btn:hover { color: #111827; background: #f3f4f6; }
.ch-help-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 3px 0;
}
.ch-help-cmd {
  font-size: 10px;
  color: #111827;
  background: #f3f4f6;
  border-radius: 5px;
  padding: 1px 6px;
  white-space: nowrap;
  flex: none;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.ch-cmd-input {
  flex: 1;
  min-width: 0;
  font-size: 11px;
  color: #111827;
  background: #f9fafb;
  border: 1px solid #e5e7eb;
  border-radius: 9px;
  padding: 7px 10px;
  outline: none;
  transition: border-color 0.15s ease;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.ch-cmd-input:focus { border-color: #9ca3af; background: #fff; }
.ch-send {
  width: 30px;
  height: 30px;
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: #111827;
  color: #fff;
  border: none;
  border-radius: 9px;
  cursor: pointer;
  transition: background 0.15s ease, opacity 0.15s ease;
}
.ch-send:hover:not(:disabled) { background: #374151; }
.ch-send:disabled { opacity: 0.35; cursor: not-allowed; }
.ch-reply {
  display: flex;
  gap: 6px;
  margin-top: 8px;
  padding: 8px 10px;
  background: #f9fafb;
  border: 1px solid #f3f4f6;
  border-radius: 9px;
  font-size: 11px;
  color: #374151;
  line-height: 1.55;
}

/* ── 动画 ── */
.mini-in { animation: miniIn 0.3s cubic-bezier(0.34, 1.6, 0.64, 1) forwards; }
.mini-out { animation: miniOut 0.22s cubic-bezier(0.4, 0, 0.2, 1) forwards; }
@keyframes miniIn {
  0% { opacity: 0; transform: scale(0.9) translateY(12px); }
  100% { opacity: 1; transform: scale(1) translateY(0); }
}
@keyframes miniOut {
  0% { opacity: 1; transform: scale(1); }
  100% { opacity: 0; transform: scale(0.92) translateY(10px); }
}
.mem-spin { animation: memSpin 0.9s linear infinite; }
@keyframes memSpin { to { transform: rotate(360deg); } }
</style>

<style>
/* 深色适配（全局块，同项目惯例） */
html.dark .ch-modal { background: #1b1b1f; border-color: #2e2e36; }
html.dark .ch-tabs { background: #26262d; }
html.dark .ch-tab { color: #8c8c96; }
html.dark .ch-tab:hover { color: #e9e9ef; }
html.dark .ch-tab.is-active { background: #3a3a44; color: #f2f2f6; }
html.dark .ch-status { background: #202027; border-color: #2b2b33; }
html.dark .ch-card,
html.dark .ch-session,
html.dark .ch-reply,
html.dark .ch-bot-detail { background: #202027; border-color: #2b2b33; }
html.dark .ch-session:hover { background: #26262d; border-color: #34343e; }
html.dark .ch-empty { border-color: #34343e; }
html.dark .ch-section-title { color: #6f6f78; }
html.dark .ch-power { background: #26262d; border-color: #34343e; color: #8c8c96; }
html.dark .ch-power.is-on { background: #f2f2f6; border-color: #f2f2f6; color: #1b1b1f; }
html.dark .ch-cmd-input { background: #202027; border-color: #34343e; color: #e9e9ef; }
html.dark .ch-cmd-input:focus { border-color: #55555f; }
html.dark .ch-help-cmd { background: #2b2b33; color: #e9e9ef; }
html.dark .ch-back { background: #26262d; border-color: #34343e; color: #8c8c96; }
html.dark .ch-send { background: #f2f2f6; color: #1b1b1f; }
html.dark .ch-send:hover:not(:disabled) { background: #d8d8de; }
html.dark .ch-list-toggle { background: #202027; border-color: #34343e; color: #e9e9ef; }
html.dark .ch-list-toggle:hover { background: #26262d; border-color: #44444f; }
html.dark .ch-list-toggle.is-open { border-color: #55555f; }
html.dark .ch-count { background: #2b2b33; color: #8c8c96; }
html.dark .ch-bot-row { background: #202027; border-color: #2b2b33; }
html.dark .ch-persona-modal { background: #1b1b1f; border-color: #2e2e36; }
html.dark .ch-field-label { color: #8c8c96; }
html.dark .ch-persona-open.is-locked:hover { background: #202027; border-color: #34343e; }
html.dark .ch-mini-btn { background: #26262d; border-color: #34343e; color: #8c8c96; }
html.dark .ch-mini-btn:hover { background: #2e2e36; border-color: #44444f; color: #e9e9ef; }
html.dark .ch-mini-btn.is-danger:hover { background: #3a2226; border-color: #7f1d1d; color: #f87171; }
html.dark .ch-field { background: #202027; border-color: #34343e; color: #e9e9ef; }
html.dark .ch-field:focus { border-color: #55555f; }
html.dark .ch-btn-primary { background: #f2f2f6; color: #1b1b1f; }
html.dark .ch-btn-primary:hover:not(:disabled) { background: #d8d8de; }
html.dark .ch-btn-plain { background: #202027; border-color: #34343e; color: #e9e9ef; }
html.dark .ch-btn-plain:hover { background: #26262d; border-color: #44444f; }
html.dark .ch-empty-sm { border-color: #34343e; }
html.dark .ch-wx-card { background: #202027; border-color: #2b2b33; }
html.dark .ch-qr-placeholder { background: #202027; }
html.dark .ch-qr-msg { color: #d8d8de; }
html.dark .ch-picker,
html.dark .ch-qr-modal { background: #1b1b1f; border-color: #2e2e36; }
html.dark .ch-pick-all { background: #202027; border-color: #2b2b33; color: #8c8c96; }
html.dark .ch-pick-all:hover { background: #26262d; }
html.dark .ch-bot-tabs { background: #26262d; }
html.dark .ch-bot-tab { color: #8c8c96; }
html.dark .ch-bot-tab:hover { color: #e9e9ef; }
html.dark .ch-bot-tab.is-active { background: #3a3a44; color: #f2f2f6; }
html.dark .ch-pick-row { background: #202027; border-color: #2b2b33; }
html.dark .ch-pick-row:hover { background: #26262d; border-color: #34343e; }
html.dark .ch-pick-row.is-picked { border-color: #f2f2f6; background: #26262d; }
html.dark .ch-pick-tabs { background: #26262d; }
html.dark .ch-pick-tab { color: #8c8c96; }
html.dark .ch-pick-tab.is-on { background: #3a3a44; color: #f2f2f6; box-shadow: none; }
html.dark .ch-pick-tab-n { background: #3a3a44; color: #b4b2a9; }
html.dark .ch-pick-tab.is-on .ch-pick-tab-n { background: #f2f2f6; color: #1b1b1f; }
html.dark .ch-pick-idx { color: #6b6b75; }
html.dark .ch-peer-badge { background: #2a2a3d; color: #a5b4fc; border-color: #3f3f5a; }
html.dark .ch-peer-badge:hover { background: #33334a; }
html.dark .ch-peer-input { background: #202027; border-color: #34343e; color: #e9e9ef; }
html.dark .ch-confirm-icon.is-info { background: #2a2a3d; color: #a5b4fc; }
html.dark .ch-check { border-color: #44444f; }
html.dark .ch-check.is-on { background: #f2f2f6; border-color: #f2f2f6; color: #1b1b1f; }
html.dark .ch-new-btn { background: #26262d; border-color: #34343e; color: #e9e9ef; }
html.dark .ch-new-btn:hover:not(:disabled) { background: #2e2e36; }
html.dark .ch-set-active { color: #4a4a55; }
html.dark .ch-pick-row:hover .ch-set-active { color: #8c8c96; }
html.dark .ch-pick-row.is-active { border-color: #1f6f4f; background: #16241e; }
html.dark .ch-pick-row.is-active:hover { border-color: #10b981; background: #182a22; }
html.dark .ch-cur-badge { background: #1c2f28; color: #34d399; }
html.dark .ch-kind.is-c2c { color: #9a9aa4; background: #2b2b33; }
html.dark .ch-kind.is-group { color: #fbbf24; background: #3a2f16; }
html.dark .ch-kind.is-channel { color: #a5b4fc; background: #26264a; }
html.dark .ch-qr-box { background: #202027; border-color: #2b2b33; }
</style>
