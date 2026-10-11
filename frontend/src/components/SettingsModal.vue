<script setup lang="ts">
import { BUBBLE_COLORS, FONT_PRESETS } from '@/stores/settings'
import { ref, reactive, computed, watch, onMounted, onUnmounted } from 'vue'
import BwSwitch from './BwSwitch.vue'
import BwSeg from './BwSeg.vue'
import SegTabs from './blocks/SegTabs.vue'
import HintTip from './blocks/HintTip.vue'
import SoundSelect from './SoundSelect.vue'
import LogAvatar from './LogAvatar.vue'
import PendingBadge from './PendingBadge.vue'
import VendorLogo from './VendorLogo.vue'
import { useUiStore } from '@/stores/ui'
import { openOnboarding } from '@/utils/onboarding'
import { APP_VERSION } from '@/utils/appInfo'
import { t, setLang, useI18n } from '@/utils/i18n'
import { useSettingsStore, DEFAULT_GENERAL, DEFAULT_NIS_AVATAR } from '@/stores/settings'
import { useProjectsStore } from '@/stores/projects'
import { useConversationsStore } from '@/stores/conversations'
/* ★1013：ExtractModelSelector（「新会话默认模型」）已从设置里移除 —— 全局模型改为"跟着对话里选的模型走"。
   组件文件保留（未引用），要彻底清理可连带删除 blocks/ExtractModelSelector.vue。 */
import BackgroundModelSelector from './blocks/BackgroundModelSelector.vue'
import ReleaseBackupSection from './blocks/ReleaseBackupSection.vue'
import VoiceSettingsSection from './blocks/VoiceSettingsSection.vue'
import MiniSelect from './blocks/MiniSelect.vue'
import NumChip from './blocks/NumChip.vue'
import DirPickerModal from './blocks/DirPickerModal.vue'
import DataBackupDialog from './blocks/DataBackupDialog.vue'
import { matchesShortcut, shortcutFromEvent } from '@/utils/shortcuts'
import { useModalLayer } from '@/utils/modalStack'
import { LoaderCircle, PenLine, Plug, X } from 'lucide-vue-next'
import { BUILTIN_SOUNDS, CUSTOM_SOUND_ID, previewSound } from '@/utils/notifySound'
import { testModelConnection } from '@/utils/testConnection'
import { buildAgentImportPrompt, AGENT_IMPORT_SUGGESTIONS } from '@/utils/agentImport'
import type { NotifyCategory } from '@/utils/systemNotify'

const props = defineProps<{
  open: boolean
}>()

const emit = defineEmits<{
  close: []
}>()

// ── 弹窗开关动画（与其它弹窗一致） ──
const isAnimating = ref(false)
const isClosing = ref(false)
const showModal = ref(false)

watch(() => props.open, (val) => {
  if (val) {
    isClosing.value = false
    showModal.value = true
    isAnimating.value = true
    setTimeout(() => { isAnimating.value = false }, 450)
    // 打开时重新从 store 拉最新值（AI 改名工具/其他端修改后界面同步）
    Object.assign(generalDraft, settingsStore.general)
    Object.assign(personaDraft, {
      nisName: settingsStore.persona.nisName,
      prompt: settingsStore.persona.prompt,
    })
    avatarPreview.value = settingsStore.persona.avatar
    // 0907 补：外观草稿同样重拉（动效档位等被后端同步更新后，重开设置不再显示旧值）
    Object.assign(appearanceDraft, settingsStore.appearance)
  } else if (showModal.value) {
    // 0907 图三修复：外部（手机端底部导航"对话"/顶栏齿轮）直接置 settingsOpen=false 时
    // 原逻辑只处理"开"分支，showModal 恒 true=弹窗关不掉。补"关"分支走同款退场动画
    close()
  }
})

/** 关设置 = 回到干净状态（0920）。
 *  ★ 必须把**所有二级/三级浮层的状态一起复位** —— 否则父弹窗关了、子弹窗自己的
 *    v-model 布尔量还留在 true，下次打开设置会"连上次那个二级弹窗一起冒出来"
 *    （反馈的原话：「再次打开甚至还会显示之前打开的 2+ 级弹窗」）。 */
function resetChildLayers(): void {
  dataDlgOpen.value = false
  exportDirPicker.value = false
  importFilePicker.value = false
  envDirPicker.value = false
  storageDirPicker.value = false
  importDoneDialog.value = null
  agentImportOpen.value = false
  fetchDialogOpen.value = false
  fetchProviderId.value = ''
  /* ★1010：这两个以前没复位 ⇒ 实测"关掉设置（含 Esc）后再打开，二级/三级弹窗还挂在屏幕上"：
     供应商详情（provExpandedId）与编辑模型弹窗（editingModelId）必须一起清。 */
  provExpandedId.value = null
  editingModelId.value = null
  trashConfirm.value = null
  provRemoveConfirm.value = null
  ctxResetConfirm.value = false
  engineDropdownOpen.value = false
  addProviderOpen.value = false
  addModelOpen.value = false
  capDialogVisible.value = false
  showApiKey.value = false
  storageDeleteArmed.value = false
  editingShortcut.value = null
}

function close() {
  isClosing.value = true
  isAnimating.value = true
  resetChildLayers()
  setTimeout(() => {
    if (props.open && !isClosing.value) return  /*0927 netfix close-reopen-guard v3：正常关闭放行（isClosing 仍 true）；中途被重开（open watch 复位）则旧定时器作废 */
    showModal.value = false
    isAnimating.value = false
    isClosing.value = false
    emit('close')
  }, 300)
}

/** 本弹窗在 Esc 层级栈里的位置（详见 utils/modalStack.ts）。
 *  Esc 由全局唯一处理器分发给**最上层**那一层，所以这里只需给出"关我"的语义。 */
const layer = useModalLayer(() => props.open, onEsc)

/** 按 Esc：先逐层收敛盖在设置之上的那些确认层，都没有才关设置本身。 */
function onEsc(): void {
  /* ★1010（实测："按 Esc 会把二/三级弹窗连设置一起关掉，重开时它们还开着"）：
     **逐层收敛** —— 从最上面的子弹窗开始，关一个就 return，一次只关一层；全都没有才关设置本身。
     层级：三级（编辑模型 / 获取模型 / 各类确认）→ 二级（供应商详情卡片）→ 一级（设置）。 */
  if (importDoneDialog.value) { importDoneDialog.value = null; return }
  if (agentImportOpen.value) { agentImportOpen.value = false; return }
  // 三级：编辑模型弹窗 / 获取模型弹窗
  if (editingModelId.value) { editingModelId.value = null; return }
  if (fetchDialogOpen.value) { fetchDialogOpen.value = false; fetchProviderId.value = ''; return }
  // 三级：确认类弹窗
  if (trashConfirm.value) { trashConfirm.value = null; return }
  if (provRemoveConfirm.value) { provRemoveConfirm.value = null; return }
  if (ctxResetConfirm.value) { ctxResetConfirm.value = false; return }
  if (capDialogVisible.value) { capDialogVisible.value = false; return }
  // 二级：供应商详情（卡片就地展开那一层）
  if (addModelOpen.value) { addModelOpen.value = false; return }
  if (provExpandedId.value) { provExpandedId.value = null; return }
  close()
}

function handleKeydown(e: KeyboardEvent) {
  /* ★ 只在**最上层**才响应自己的关闭快捷键 —— 否则设置里开着「导出数据」时，
     按一下 Ctrl+W（用户可能把它设成关闭快捷键）会把设置连二级弹窗一起带走。 */
  if (!layer.isTop()) return
  if (matchesShortcut(e, settingsStore.shortcuts.close) && props.open) {
    close()
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
  }
}

onMounted(() => document.addEventListener('keydown', handleKeydown))
onUnmounted(() => document.removeEventListener('keydown', handleKeydown))

// ── 左侧导航 ──
interface SettingsTab {
  id: string
  label: string
  icon: string
}

const tabs: SettingsTab[] = [
  { id: 'general', label: '通用', icon: 'fas fa-gear' },
  { id: 'providers', label: '供应商', icon: 'fas fa-server' },
  { id: 'persona', label: '人格', icon: 'fas fa-user' },
  { id: 'appearance', label: '外观', icon: 'fas fa-sun' },
  { id: 'voice', label: '语音', icon: 'fas fa-microphone-lines' },
  { id: 'notifications', label: '提示', icon: 'fas fa-bell' },
  { id: 'pet', label: '桌宠', icon: 'fas fa-paw' },
  { id: 'trash', label: '滞留处', icon: 'fas fa-recycle' },
  { id: 'about', label: '关于', icon: 'fas fa-circle-info' },
  { id: 'browser', label: '浏览器', icon: 'fas fa-globe' },
  { id: 'backup', label: '版本保底', icon: 'fas fa-clock-rotate-left' },
]

const activeTab = ref('general')

// 支持从其它组件（如输入框「未设置常用模型」）直接跳到指定 tab
const uiStore = useUiStore()

/** 0914c：重新查看新手引导（设置→关于）——先收起设置，再弹引导层 */
function reopenOnboarding() {
  uiStore.closeSettings()
  openOnboarding()
}

/** 0915：重启 NIS——开发/浏览器态=重新加载；打包版将接进程级 relaunch（tauri-plugin-process） */
function restartApp() {
  window.location.reload()
}
watch(() => uiStore.settingsTab, (tab) => {
  if (tab) activeTab.value = tab
})

// ── 通用 ──
// 用户名字 / 自动修复 / 日志级别 / 会话标题 → settingsStore.general 持久化
// 语言 / 存储目录 / 快捷键 保持原实现
const s = reactive({
  language: useI18n().lang.value === 'en' ? 'English' : '中文',
})

// ── 通用：存储目录 / 快捷键（持久化 store）+ 界面语言切换 ──
const settingsStore = useSettingsStore()
const projectsStore = useProjectsStore()
const conversationsStore = useConversationsStore()

// ── 滞留处：保留天数（7/15/30）＋ 滞留项目列表操作 ──
const trashRetentionOptions = [
  { value: 7, label: '7' },
  { value: 15, label: '15' },
  { value: 30, label: '30' },
]
// 滞留处二次确认（彻底删除/恢复）：type='purge-conv'|'purge-proj'|'restore-conv'|'restore-proj'
/** ★ 0921z-3（需求）：滞留处 tab —— 'project'=滞留项目 / 'conv'=滞留对话（数量写在标签括号里） */
const trashTab = ref('project')
const trashConfirm = ref<{ type: 'purge-conv' | 'purge-proj' | 'restore-conv' | 'restore-proj'; id: string; title: string } | null>(null)
function requestTrashAction(type: 'purge-conv' | 'purge-proj' | 'restore-conv' | 'restore-proj', id: string, title: string) {
  trashConfirm.value = { type, id, title }
}
function confirmTrashAction() {
  const c = trashConfirm.value
  if (!c) return
  if (c.type === 'purge-conv') conversationsStore.purgeConversation(c.id)
  else if (c.type === 'purge-proj') projectsStore.purgeProject(c.id)
  else if (c.type === 'restore-conv') conversationsStore.restoreConversation(c.id)
  else if (c.type === 'restore-proj') projectsStore.restoreProject(c.id)
  trashConfirm.value = null
}
function trashLeftLabel(trashed: { deleted_at: number; keep_days: number }): string {
  const end = trashed.deleted_at + trashed.keep_days * 24 * 60 * 60 * 1000
  const days = Math.max(0, Math.ceil((end - Date.now()) / (24 * 60 * 60 * 1000)))
  return `${days} ${days <= 1 ? t('settings.trash.day') : t('settings.trash.days')}`
}

// 通用设置读写 settingsStore.general（v-model 兼容）
const generalDraft = reactive({ ...settingsStore.general })
// 0911 修复：旧实现只手动同步 7 个字段——滑杆/下拉类数值设置（压缩阈值/留存比/文件历史配额/
// 续跑护栏/成员单次运行上限）改了不生效：draft 变更从不写回 store，既不落 localStorage 也不推后端。
// 改为全字段差异同步（只写回不相等键），新增设置项无需再手动登记。
watch(generalDraft, () => {
  const cur = settingsStore.general as unknown as Record<string, unknown>
  for (const k of Object.keys(generalDraft) as Array<keyof typeof generalDraft>) {
    const nv = generalDraft[k]
    if (typeof nv !== 'string' && typeof nv !== 'boolean' && typeof nv !== 'number') continue
    if (cur[k as string] === nv) continue
    settingsStore.setGeneral(k as Parameters<typeof settingsStore.setGeneral>[0], nv)
  }
}, { deep: true })

// ── 0911 反馈：上下文管理「恢复默认」（二次确认；仅重置本 section 的键，其他通用设置不受影响） ──
const ctxResetConfirm = ref(false)
const ctxResetDone = ref(false)
const CTX_RESET_KEYS = [
  'contextCompaction', 'contextCompactThresholdPct', 'contextKeepPct',
  'historyMaxPerSession', 'historyAutoCleanEnabled', 'historyAutoCleanThresholdMb', 'historyAutoCleanPct',
  'autoContinueRounds', 'turnTokenBudget', 'memberRunLimitMinutes', 'memberInspector', 'archiveTranscriptMd',
  /* ★ 0921z：技能开关（disabledSkills / skillAutoSelect）**已从这里移出** —— 它们不再属于「上下文管理」分区，
     而是技能仓库的开关。留在这里的副作用是：用户点「上下文管理→恢复默认」会把自己关掉的技能悄悄全开回来。 */
] as const
function resetContextDefaults() {
  const def = DEFAULT_GENERAL as unknown as Record<string, unknown>
  const draft = generalDraft as unknown as Record<string, unknown>
  for (const k of CTX_RESET_KEYS) draft[k] = def[k]
  ctxResetConfirm.value = false
  ctxResetDone.value = true
  setTimeout(() => { ctxResetDone.value = false }, 3000)
}

// ── 0911 反馈：文件历史占用与清理（设置页展示 + 立即清理；自动清理三字段走 generalDraft 全字段同步） ──
const historyStatsText = ref('—')
const historyStatsLoading = ref(false)
const historyCleaning = ref(false)
const cleanResult = ref('')
async function refreshHistoryStats() {
  historyStatsLoading.value = true
  try {
    const r = await chatStore.bridgeRpc('fs.history.stats')
    const mb = Number(r?.totalBytes || 0) / 1048576
    const sizeText = mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`
    const ws = Array.isArray(r?.workspaces) ? r.workspaces.length : 0
    const cnt = Number(r?.totalChanges || 0)
    historyStatsText.value = `${sizeText} · ${ws} 个工作区 · ${cnt} 条记录`
  } catch {
    historyStatsText.value = '—'
  } finally {
    historyStatsLoading.value = false
  }
}
async function manualCleanHistory() {
  if (historyCleaning.value) return
  historyCleaning.value = true
  cleanResult.value = ''
  try {
    const r = await chatStore.bridgeRpc('fs.history.autoClean', { force: true })
    const freed = Number(r?.freedBytes || 0) / 1048576
    const removed = Number(r?.removedChanges || 0)
    const freedText = freed >= 1024 ? `${(freed / 1024).toFixed(1)} GB` : `${freed.toFixed(1)} MB`
    cleanResult.value = `已清理最旧 ${removed} 条记录，释放 ${freedText}`
    await refreshHistoryStats()
    setTimeout(() => { cleanResult.value = '' }, 6000)
  } catch (e: any) {
    cleanResult.value = '清理失败：' + (e?.message || e)
  } finally {
    historyCleaning.value = false
  }
}
// 打开设置弹窗时刷新占用统计（后端为权威；清理完成后再刷一次）
watch(() => props.open, (v) => { if (v) void refreshHistoryStats() })

// 界面语言切换 → 全局 i18n（当前只有 中文/English 有完整字典，其余语言暂回落中文）
watch(() => s.language, (langText) => {
  if (langText === 'English') setLang('en')
  else setLang('zh')
})

// ── 存储目录 ──
/**
 * 更换存储目录（0917 修）——**统一走应用内置目录选择器**。
 * 历史坑（都已在本次修掉）：
 *  · 早期取消后会 fallback 到 window.prompt → 那是个带 origin 标题（"127.0.0.1:xxxx 显示"）的
 *    原生弹窗，用户报的「浏览器弹窗问确定什么路径」就是它；
 *  · 后来虽去掉了 prompt，却改用 Tauri 系统目录对话框 → 弹系统窗口、与同屏的「环境安装目录」
 *    选择器行为不一致（一个弹系统窗、一个弹内置窗）。
 * 现在两个目录选择器共用 blocks/DirPickerModal.vue，取消即无副作用。 */
const storageDirPicker = ref(false)
function changeStorageDir() {
  storageDirPicker.value = true
}
async function onStoragePicked(dir: string) {
  storageDirPicker.value = false
  const p = String(dir || '').trim()
  if (p) await beginStorageChange(p)
}

// ── 0913：存储目录切换 —— 原目录有内容时弹三选项（原位置保留 / 跟随移动 / 删除原位置） ──
const storageMigrate = ref<{ from: string; to: string; entries: number; bytes: number } | null>(null)
const storageMigrateBusy = ref(false)
const storageMigrateMsg = ref('')
const storageDeleteArmed = ref(false)

/** 迁移耗时（秒）。storage.migrate 是一次后端调用、没有分片进度回调，
 *  但「等了多久」能拿到 —— 配上不确定态进度条，比之前只有一行灰字明确得多（0915 用户反馈）。 */
const storageMigrateElapsed = ref(0)
let migrateTick: ReturnType<typeof setInterval> | undefined
watch(storageMigrateBusy, (v) => {
  if (v) {
    storageMigrateElapsed.value = 0
    migrateTick = setInterval(() => { storageMigrateElapsed.value += 1 }, 1000)
  } else if (migrateTick) {
    clearInterval(migrateTick)
    migrateTick = undefined
  }
})
onUnmounted(() => { if (migrateTick) clearInterval(migrateTick) })

function fmtBytesShort(n: number): string {
  if (!n) return '0 B'
  if (n < 1024) return n + ' B'
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB'
  if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB'
  return (n / 1073741824).toFixed(2) + ' GB'
}

async function beginStorageChange(next: string) {
  const from = String(settingsStore.storagePath || '').trim()
  const to = String(next || '').trim()
  if (!to || to === from) return
  let info: any = null
  try {
    const { useChatStore } = await import('@/stores/chat')
    info = await useChatStore().bridgeRpc('storage.inspect', { path: from })
  } catch (e) { swallowed('存储目录探测失败（按"空目录"处理并直接切换——目标里可能其实有数据）', e) }
  if (!info?.exists || !Number(info.entries)) {
    settingsStore.setStoragePath(to)
    s.storagePath = to
    return
  }
  storageMigrateMsg.value = ''
  storageDeleteArmed.value = false
  storageMigrate.value = { from, to, entries: Number(info.entries || 0), bytes: Number(info.bytes || 0) }
}

async function confirmStorageMigrate(mode: 'keep' | 'move' | 'delete') {
  const ctx = storageMigrate.value
  if (!ctx || storageMigrateBusy.value) return
  if (mode === 'delete' && !storageDeleteArmed.value) { storageDeleteArmed.value = true; return }
  storageMigrateBusy.value = true
  storageMigrateMsg.value = ''
  try {
    const { useChatStore } = await import('@/stores/chat')
    const r: any = await useChatStore().bridgeRpc('storage.migrate', { from: ctx.from, to: ctx.to, mode }, 300000 /* ★0927 慢 RPC 大超时：数据搬移 */)
    if (r && r.ok !== false) {
      settingsStore.setStoragePath(ctx.to)
      s.storagePath = ctx.to
      notificationsStore.push({ level: 'success', content: t('settings.storage.moved', { n: Number(r?.moved || 0) }) })
      storageMigrate.value = null
      storageDeleteArmed.value = false
    } else {
      storageMigrateMsg.value = String(r?.error || r?.log || '').slice(0, 220) || t('settings.storage.failed')
    }
  } catch (e: any) {
    storageMigrateMsg.value = String(e?.message || e).slice(0, 220)
  } finally {
    storageMigrateBusy.value = false
  }
}
/** 在系统资源管理器里打开一个文件夹。
 *  桌面端走 Tauri 的 `open_path`（Rust 侧 frontend/src-tauri/src/lib.rs 里注册）；浏览器下或调用失败
 *  返回 false，由调用方回退到 window.open。
 *  ★ 1003：这里原来是 `import('@/utils/dataTransfer').openFolder`，该文件在 1002 的"精简"里被整体删掉了
 *    —— 它另外 8 个导出（downloadJson / readJsonFile / pickFile / export·importMemory /
 *    export·importKnowledge）走的还是老的 WS 协议（`chatStore.sendResponse('MEMORY_EXPORT')`），
 *    早就被现在的 RPC `data.exportAll` 那套取代，删得对；**只有 openFolder 还活着，属于删漏了**。
 *    全项目就这一处用到它 ⇒ 不新建 utils 文件，就近内联回来（与下面 `openStorageFolder` 紧挨着）。 */
async function openFolder(path: string): Promise<boolean> {
  if ((window as any).__TAURI_INTERNALS__) {
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('open_path', { path })
      return true
    } catch {
      return false
    }
  }
  return false
}

async function openStorageFolder() {
  // 0915：桌面端优先用 Tauri open_path（资源管理器打开）；浏览器/失败时退回 window.open
  if (await openFolder(settingsStore.storagePath)) return
  const opened = window.open(settingsStore.storagePath)
  if (!opened) notificationsStore.push({ level: 'error', title: t('settings.notif.openFolderFailTitle'), content: t('settings.notif.openFolderFailBody'), type: 'system' })
}

/* ── 0915 / 0917b：数据备份 —— 整包导出 / 导入（换机、搬进安装版） ──
 *  0917b 修三处：
 *   ① 网页端没有路径弹窗 —— 原来只有桌面端（__TAURI_INTERNALS__）才调系统对话框，
 *      浏览器下直接跳过去用后端默认目录。现在网页端走应用内选择器（DirPickerModal）。
 *   ② 点「导入」显示导出的文案 —— 原来两者共用一份 dataBackupBusy/dataBackupMsg，状态串台。
 *      现在导出/导入各自独立的状态与文案。
 *   ③ 导出/导入没有进度 —— 现在按后端 data/progress 帧显示真实百分比 + 阶段文本。 */
const dataExportBusy = ref(false)
const dataExportMsg = ref('')
const dataImportBusy = ref(false)
const dataImportMsg = ref('')
/** 0918（需求）：导入完成后的**强提示弹窗** —— 以前只在卡片下留一行小字
 *  "已导入到… 重启应用后生效"，实际很容易被忽略，导致用户以为导入没生效。
 *  现在改成必须点掉的弹窗，并直接提供「立即重启」。 */
const importDoneDialog = ref<{ dir: string; note?: string } | null>(null)
const importRestarting = ref(false)
const dataProgress = reactive({
  export: { percent: -1, phase: '' },
  import: { percent: -1, phase: '' },
})
/** 导出目录选择器（应用内；桌面端优先用系统对话框） */
const exportDirPicker = ref(false)
/** 导入数据包选择器（应用内；桌面端优先用系统对话框） */
const importFilePicker = ref(false)

function onDataProgressFrame(frame: any) {
  const pl = frame?.payload
  if (!pl || pl.type !== 'data/progress') return
  const slot = pl.task === 'import' ? dataProgress.import : dataProgress.export
  slot.percent = Number(pl.percent)
  slot.phase = String(pl.phase || '')
}
onMounted(() => { useChatStore().onMessage(onDataProgressFrame) })
onUnmounted(() => { useChatStore().offMessage(onDataProgressFrame) })

/* ── 数据备份弹窗（0919 改造）────────────────────────────────────────
 * 导出/导入都先弹**勾选窗**：导出选"要打进包里的部分"，导入读包后选"要解出的部分"。
 * 备份页那两个按钮退化成薄壳：只负责把弹窗打开（★1010j：原来在「通用」页，已搬到「备份」tab）。 */
const dataDlgOpen = ref(false)
const dataDlgMode = ref<'export' | 'import'>('export')
/** 导入用的数据包路径：**先选包、后开勾选窗**，弹窗只管读清单 */
const dataDlgFile = ref('')
function openDataDialog(mode: 'export' | 'import'): void {
  dataDlgMode.value = mode
  if (mode === 'export') {
    dataDlgOpen.value = true
    return
  }
  dataDlgFile.value = ''
  void pickDataPackage()
}
/** 选数据包：桌面端用系统对话框，网页端回落应用内的 DirPickerModal（顺序都是"先选文件"） */
async function pickDataPackage(): Promise<void> {
  if ((window as any).__TAURI_INTERNALS__) {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const p = await open({ multiple: false, filters: [{ name: 'NIS Data', extensions: ['gz', 'tgz'] }] })
      if (!p) return
      onImportFilePicked(String(p))
      return
    } catch { /* 对话框不可用 → 回落内置选择器 */ }
  }
  importFilePicker.value = true
}
/** 内置选择器选好包 → 才打开勾选弹窗 */
function onImportFilePicked(p: string): void {
  if (!p) return
  dataDlgFile.value = p
  dataDlgMode.value = 'import'
  dataDlgOpen.value = true
}
function onDataDialogDone(r: { mode: 'export' | 'import'; path?: string; parts?: any[] }): void {
  if (r.mode === 'export') {
    if (r.path) dataExportMsg.value = t('settings.general.dataExportDone', { path: r.path })
    return
  }
  // 导入：解出的部分名列表交给"必须重启"弹窗，明确告诉用户导了什么
  const names = (r.parts || []).filter((x: any) => x?.ok).map((x: any) => x.label).join('、')
  /* ★ 0920：把"设置"那部分的**后端备注**带出来 —— 尤其"这个包不含供应商密钥"这句，
     否则用户会对着一个没有激活供应商的列表反复怀疑自己点错了（用户 0919 实测）。 */
  const note = String((r.parts || []).find((x: any) => x?.id === 'settings')?.note || '')
  importDoneDialog.value = {
    dir: names || t('settings.general.dataImportDoneShort'),
    note: /不含供应商密钥|no provider keys/i.test(note) ? note : '',
  }
  /* ★ 0920：后端已经在导入后**把 providers.json / settings.json 重读进内存**了，
     这里把前端两份快照也拉一遍 —— 用户点「稍后重启」也能立刻看到导入进来的供应商与密钥。 */
  if ((r.parts || []).some((x: any) => x?.ok && x?.id === 'settings')) {
    void (async () => {
      try {
        const { useProvidersStore } = await import('@/stores/providers')
        await useProvidersStore().syncFromBackend()
      } catch (e) {
        console.warn('[import] 供应商表刷新失败：', e)
      }
    })()
  }
}

/** 真正执行导出（dir 为空 = 用后端默认导出目录） */
async function runExport(dir: string) {
  if (dataExportBusy.value) return
  dataExportBusy.value = true
  dataExportMsg.value = ''
  dataProgress.export = { percent: 0, phase: t('settings.general.dataExporting') }
  try {
    const { useChatStore } = await import('@/stores/chat')
    const r: any = await useChatStore().bridgeRpc('data.exportAll', dir ? { dir } : {})
    dataProgress.export = { percent: 100, phase: t('settings.general.dataExportDoneShort') }
    dataExportMsg.value = t('settings.general.dataExportDone', { path: String(r?.path || '') })
  } catch (e: any) {
    dataProgress.export = { percent: -1, phase: '' }
    dataExportMsg.value = String(e?.message || e).slice(0, 300)
  } finally {
    dataExportBusy.value = false
  }
}

/** 是否桌面版（重启/托盘这类能力只在 Tauri 里存在） */
const isDesktopApp = typeof window !== 'undefined' && !!(window as any).__TAURI_INTERNALS__

/** 立即重启（仅供导入完成弹窗用）。Rust 侧先退旧进程再隔 2 秒拉起同一个 exe，
 *  这样端口能原样复用（否则 origin 变化会让 localStorage 全废）。 */
async function restartNow(): Promise<void> {
  if (importRestarting.value) return
  importRestarting.value = true
  try {
    const core = await import('@tauri-apps/api/core')
    await core.invoke('restart_app')
  } catch (e) {
    console.warn('[import] restart_app failed:', e)
    importRestarting.value = false
    importDoneDialog.value = null
  }
}

/* ── 0918：导入其他 agent 数据 —— 关设置 → 开「导入助手」对话 → 输入框预置引导词 ──
 *  设计：这里不直接去翻别人的数据目录，而是把"侦察 + 整理清单 + 等确认 + 迁移"交给
 *  agent 在对话里做（它能用文件工具自适应各种软件的数据布局）。
 *  前端只负责开对模式、把引导词放进输入框（不自动发送，用户先填软件名）。
 *  0920 修正两处：① 原来开的是「改造模式」(cordis)，导入这摊事另有专属预设「导入助手」(agent-import)；
 *                ② 原来直接改 store.contentItems，而输入框是真 contenteditable、ChatInput 从不回读
 *                   → 文案永远不显示。现改走 chatStore.requestPrefill()，由 ChatInterface 在
 *                   会话切好、ChatInput 挂载后调 insertText() 落进编辑器。 */
/* 引导词真身在 `@/utils/agentImport`（聊天页「导入助手」会话的快捷输入按钮也用同一份） */

/* 0919（需求）：点「开始导入」**先弹窗问软件名**，再用「已经带好软件名」的引导词开一个
   「导入助手」会话 —— 用户不用再去提示词里找那个「？」改它。
   以前是直接建会话 + 预填通用引导词（留个「？」让人自己改），再靠聊天页输入框下方那个快捷按钮兜底；
   现在一步到位，那个 chip 已删掉（见 ChatInterface）。 */
const agentImportOpen = ref(false)
const agentImportName = ref('')
const agentImportErr = ref(false)
const agentImportRef = ref<HTMLInputElement | null>(null)

function openAgentImportDialog(): void {
  agentImportName.value = ''
  agentImportErr.value = false
  agentImportOpen.value = true
  nextTick(() => agentImportRef.value?.focus())
}

/** 确定（或点了常见候选）→ 建会话 + 预填带名字的引导词 */
function confirmAgentImport(nameArg?: string): void {
  const name = String(nameArg ?? agentImportName.value).trim()
  if (!name) {
    agentImportErr.value = true
    agentImportRef.value?.focus()
    return
  }
  agentImportOpen.value = false
  uiStore.closeSettings()
  void conversationsStore.createConversation(null, 'agent-import').then(async (conv) => {
    if (!conv) return
    /* 顺序要紧：**先挂文案（带目标会话 id）、再切会话**。
       prefill 只在"会话切换那一刻"被消费；反过来的话这次没人取走它，
       它会一直挂着、直到用户下次切会话时被塞进**那条**会话（实测过"引导词跑到别的对话"）。 */
    chatStore.requestPrefill(buildAgentImportPrompt(name), conv.id)
    await conversationsStore.openConversation(conv.id)
    // 给这类会话一个有意义的标题（列表里还会带「导入」小标）
    if ((conv.title || '') === '新对话') void conversationsStore.renameConversation(conv.id, '导入其他 Agent 数据')
  })
}

// 快捷键编辑（仅真实生效的：发送 / 换行 / 关闭弹窗）
// 0913：只保留真实生效的「发送」；「换行 / 关闭」无消费点已删除（ChatInput 注释明确"换行键不拦截"）
const shortcutItems = computed(() => [
  { key: 'send' as const, label: t('settings.general.sendMessage') },
])
const editingShortcut = ref<keyof typeof settingsStore.shortcuts | null>(null)

function startEditShortcut(name: keyof typeof settingsStore.shortcuts) {
  editingShortcut.value = name
}
function stopEditShortcut() {
  editingShortcut.value = null
}
function onShortcutKeydown(e: KeyboardEvent) {
  if (!editingShortcut.value) return
  e.preventDefault()
  e.stopPropagation()
  if (e.key === 'Escape') {
    stopEditShortcut()
    return
  }
  const desc = shortcutFromEvent(e)
  if (desc) {
    settingsStore.setShortcut(editingShortcut.value, desc)
    stopEditShortcut()
  }
}
/* ★ 0921z：技能开关的读取/写入函数**已随分区一起搬到 SkillsModal.vue**。
   本文件不再需要 skillList / loadSkillList / isSkillOn / toggleSkill；
   设置键 `skillAutoSelect` / `disabledSkills` 仍保留在 CTX_RESET_KEYS（「恢复默认」要重置它们）。 */
onMounted(() => {
  document.addEventListener('keydown', onShortcutKeydown)
  // 0914：打开设置时刷新一次「运行环境」真实状态（后端探测）
  void refreshEnvStatus()
})
onUnmounted(() => document.removeEventListener('keydown', onShortcutKeydown))

// ── 软件环境（0914 实装：后端探测真实安装状态 + 真实安装（winget / playwright））──
/** 后端 env.status 的完整元数据（mustC / 大小估算 / 版本）——与引导页同一份口径。
 *  0917：此前设置页只有 4 项、且不显示大小与「是否必须 C 盘」，与引导页不一致（用户报「没同步成 5 条」）。 */
const envMetaMap = ref<Record<string, { installed?: boolean; version?: string; mustC?: boolean; sizeBytes?: number; bundled?: boolean; note?: string; source?: 'bundled' | 'nis' | 'system'; removable?: boolean; location?: string }>>({})
function fmtEnvSize(n: number): string {
  if (!n) return ''
  if (n < 1048576) return Math.round(n / 1024) + ' KB'
  if (n < 1073741824) return Math.round(n / 1048576) + ' MB'
  return (n / 1073741824).toFixed(2) + ' GB'
}
/** 安装任务的实时进度（后端 env.job 回传 percent/stage/phase/speedBps/etaSec/bytes） */
const envJobInfo = reactive<Record<string, { percent: number; stage: string; phase: string; speedBps: number; etaSec: number; bytes: number; totalBytes: number }>>({})
/* 0918（#6 真进度条）：阶段文案由后端归一化信号给出（prep/download/install/done），
 * 不再一律显示"安装中" —— 下载阶段显示「下载中」，安装阶段显示「安装中」。 */
function fmtStage(stage: string): string {
  if (stage === 'download') return t('settings.env.stageDownload')
  if (stage === 'install') return t('settings.env.stageInstall')
  if (stage === 'done') return t('settings.env.stageDone')
  return t('settings.env.stagePrep')
}
/** 「已下载 12 MB / 27 MB」（总量拿不到时只显示已下载） */
function fmtBytesPair(bytes: number, total: number): string {
  if (!bytes || bytes <= 0) return ''
  const a = fmtBytes(bytes)
  return total && total > 0 ? `${a} / ${fmtBytes(total)}` : a
}
function fmtSpeed(bps: number): string {
  if (!bps || bps <= 0) return ''
  if (bps < 1024) return Math.round(bps) + ' B/s'
  if (bps < 1048576) return (bps / 1024).toFixed(0) + ' KB/s'
  return (bps / 1048576).toFixed(1) + ' MB/s'
}
function fmtEta(sec: number): string {
  if (!sec || sec <= 0) return ''
  if (sec < 60) return sec + 's'
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return m + 'm' + (s ? s + 's' : '')
}
const envItems = computed(() => [
  { id: 'node', icon: 'fab fa-node-js', name: t('settings.general.envNode'), desc: t('settings.general.envNodeDesc') },
  { id: 'python', icon: 'fab fa-python', name: t('settings.general.envPython'), desc: t('settings.general.envPythonDesc') },
  { id: 'npm', icon: 'fas fa-cube', name: t('settings.general.envNpm'), desc: t('settings.general.envNpmDesc') },
  // 0917 新增（#11）：语义检索运行环境 —— 引导页与设置页同源，两边都显示
  { id: 'embed', icon: 'fas fa-brain', name: t('settings.general.envEmbed'), desc: t('settings.general.envEmbedDesc') },
  { id: 'git', icon: 'fab fa-git-alt', name: t('settings.general.envGit'), desc: t('settings.general.envGitDesc') },
  // ★1010-D：Git Bash（MinGit 精简包，供「命令终端」的 Git Bash 选项用；未装时终端下拉置灰）
  { id: 'gitbash', icon: 'fas fa-terminal', name: t('settings.general.envGitbash'), desc: t('settings.general.envGitbashDesc') },
  { id: 'chromium', icon: 'fas fa-globe', name: t('settings.general.envChromium'), desc: t('settings.general.envChromiumDesc') },
  { id: 'pwsh', icon: 'fas fa-terminal', name: t('settings.general.envPwsh'), desc: t('settings.general.envPwshDesc') },
])
/** 未安装且不在安装中的项数（「一键安装缺失项」按钮文案用）。
 *  0917：应用自带的（node）不计入 —— 它不需要用户装。 */
const envMissingCount = computed(() => envItems.value.filter((e) => {
  if (envMetaMap.value[e.id]?.bundled) return false
  const st = settingsStore.envStates[e.id]
  return st !== 'installed' && st !== 'installing'
}).length)
const envDirText = computed(() => settingsStore.general.envDir || t('settings.general.envDirHint'))

/** 环境安装目录：统一走应用内置目录选择器。
 *  0917：去掉「桌面端先用 Tauri 系统对话框」的分支 —— 用户反馈弹系统窗口体验割裂，
 *  且与「存储目录」选择器行为不一致（同一屏两个按钮，一个弹系统窗一个弹内置窗）。 */
const envDirPicker = ref(false)
function chooseEnvDir() {
  envDirPicker.value = true
}
function applyEnvDir(path: string) {
  if (path && path.trim()) settingsStore.setEnvDir(path.trim())
}

/** 刷新各环境的真实安装状态（后端 env.status 探测） */
async function refreshEnvStatus() {
  envScanning.value = true
  try {
    const r: any = await chatStore.bridgeRpc('env.status', {})
    if (r && typeof r === 'object') {
      envMetaMap.value = r
      // 逐个显式写（含 not-installed）——不写的话旧值会被"保持现值"掩盖成误报
      for (const item of envItems.value) {
        settingsStore.setEnvState(item.id, r[item.id]?.installed ? 'installed' : 'not-installed')
      }
    }
  } catch { /* 后端未就绪：保持现值 */ } finally {
    envScanning.value = false
  }
}
const envScanning = ref(false)

/** 一键安装全部缺失项。
 *  0925：后端支持安装排队（进行中再点 = 排队，完成一个自动装下一个）后，
 *  这里不再串行 await（那会等第一个装完才发第二个）——一次性全部发起，
 *  后端队列自动消化；防重靠 installEnv 里的 envStates==='installing' 同步闸门。 */
const envInstallAllBusy = ref(false)
async function installAllEnv() {
  if (envInstallAllBusy.value) return
  envInstallAllBusy.value = true
  try {
    for (const item of envItems.value) {
      const st = settingsStore.envStates[item.id]
      if (st === 'installed' || st === 'installing') continue
      void installEnv(item.id)   // 不 await：各自轮询，后端排队
    }
  } finally {
    //  setEnvState('installing') 在 RPC 前同步生效 → 防重已由它兜底，这里可以立即解锁
    envInstallAllBusy.value = false
  }
}

async function installEnv(id: string) {
  if (settingsStore.envStates[id] === 'installing') return
  settingsStore.setEnvState(id, 'installing')
  envJobInfo[id] = { percent: -1, stage: 'prep', phase: '', speedBps: 0, etaSec: 0, bytes: 0, totalBytes: 0 }
  try {
    const r: any = await chatStore.bridgeRpc('env.install', { id })
    if (!r?.ok || !r.jobId) throw new Error(String(r?.error || '无法启动安装任务'))
    const t0 = Date.now()
    // 0917：与后端流式进度对齐（后端 execStream 边跑边解析 percent/字节/网速）
    while (Date.now() - t0 < 46 * 60 * 1000) {
      await new Promise((res) => setTimeout(res, 1000))
      const j: any = await chatStore.bridgeRpc('env.job', { jobId: r.jobId })
      const job = j?.job
      if (job) {
        envJobInfo[id] = {
          percent: typeof job.percent === 'number' ? job.percent : -1,
          stage: String(job.stage || 'prep'),
          phase: String(job.phase || ''),
          speedBps: Number(job.speedBps || 0),
          etaSec: Number(job.etaSec || 0),
          bytes: Number(job.bytes || 0),
          totalBytes: Number(job.totalBytes || 0),
        }
        // 阶段文案也进日志提示（放按钮 title 上，鼠标一悬停就知道卡在哪一步）
      }
      const st = job?.status
      if (st === 'done') {
        settingsStore.setEnvState(id, 'installed')
        notificationsStore.push({ level: 'success', content: t('settings.envInstalledOk', { name: envItems.value.find((e) => e.id === id)?.name || id }) })
        void refreshEnvStatus()
        return
      }
      if (st === 'error') {
        // 把后端日志尾部带出来（含 winget 的退出码/报错行），否则用户只看到"安装命令未成功"无从下手
        const tail = (job?.log || []).filter((l: string) => l && !l.startsWith('$ ')).slice(-2).join(' · ')
        throw new Error(String(job?.error || '安装失败') + (tail ? `：${tail}` : ''))
      }
    }
    throw new Error('安装超时（45 分钟）')
  } catch (e: any) {
    settingsStore.setEnvState(id, 'not-installed')
    notificationsStore.push({ level: 'error', content: t('settings.envInstallFailed', { msg: String(e?.message || e).slice(0, 120) }), type: 'system' })
  } finally {
    delete envJobInfo[id]
  }
}

// ── 0914：环境卸载（先点一次进入确认态、再点执行；复用 env.job 轮询）──
const envUninstallArmed = ref('')
let envUninstallTimer: ReturnType<typeof setTimeout> | null = null
function armUninstall(id: string) {
  if (envUninstallArmed.value === id) { void uninstallEnv(id); return }
  if (envUninstallTimer) clearTimeout(envUninstallTimer)
  envUninstallArmed.value = id
  envUninstallTimer = setTimeout(() => { if (envUninstallArmed.value === id) envUninstallArmed.value = '' }, 4000)
}
async function uninstallEnv(id: string) {
  envUninstallArmed.value = ''
  if (envUninstallTimer) { clearTimeout(envUninstallTimer); envUninstallTimer = null }
  if (settingsStore.envStates[id] === 'uninstalling') return
  settingsStore.setEnvState(id, 'uninstalling')
  try {
    const r: any = await chatStore.bridgeRpc('env.uninstall', { id })
    if (!r?.ok || !r.jobId) throw new Error(String(r?.error || '无法启动卸载任务'))
    const t0 = Date.now()
    while (Date.now() - t0 < 10 * 60 * 1000) {
      await new Promise((res) => setTimeout(res, 2000))
      const j: any = await chatStore.bridgeRpc('env.job', { jobId: r.jobId })
      const st = j?.job?.status
      if (st === 'done') {
        settingsStore.setEnvState(id, 'not-installed')
        notificationsStore.push({ level: 'success', content: t('settings.envUninstalledOk', { name: envItems.value.find((e) => e.id === id)?.name || id }) })
        return
      }
      if (st === 'error') throw new Error(String(j?.job?.error || '卸载失败'))
    }
    throw new Error('卸载超时（10 分钟）')
  } catch (e: any) {
    settingsStore.setEnvState(id, 'installed')
    notificationsStore.push({ level: 'error', content: t('settings.envUninstallFailed', { msg: String(e?.message || e).slice(0, 120) }), type: 'system' })
  }
}

/** 0914：命令终端选择（设置→通用）——AI 命令工具使用的 Shell，选了哪个就只用哪个（MiniSelect 选项）
 *  0918：新增「自动选择」——由 AI/后端按每条命令的语法特征挑 Shell（PowerShell 语法走 PowerShell，
 *        批处理/cmd 语法走 cmd，纯 exe 调用默认 cmd）。 */
const cmdShellOptions = computed(() => [
  { value: 'auto', label: t('settings.general.shellAuto') },
  { value: 'cmd', label: t('settings.general.shellCmd') },
  { value: 'powershell', label: t('settings.general.shellPowershell') },
  { value: 'pwsh', label: t('settings.general.shellPwsh') },
  /* 1010：新增 Git Bash（PowerShell 引号语义反引号转义，实测 PS5 与 pwsh7 同病；bash 单引号内纯文本、无需转义）
   * ★1010-D（用户定：仿 pwsh「装了才能用」）：未安装 → 置灰 + 引导去「运行环境」装 Git Bash（MinGit）。 */
  {
    value: 'bash',
    label: bashReady.value ? t('settings.general.shellBash') : t('settings.general.shellBashMissing'),
    desc: bashReady.value ? undefined : t('settings.general.shellBashMissingDesc'),
    disabled: !bashReady.value,
  },
])
/** Git Bash 是否就绪（NIS 自装 MinGit 或系统 Git）——env.status 探测，打开设置时已刷 */
const bashReady = computed(() => !!envMetaMap.value.gitbash?.installed)

/** 0914：测试系统通知（点击=用户手势 → 可正常弹出授权框并实发一条） */
async function sendTestNotification() {
  try {
    if ((window as any).__TAURI_INTERNALS__) {
      const { isPermissionGranted, requestPermission, sendNotification } = await import('@tauri-apps/plugin-notification')
      let granted = await isPermissionGranted()
      if (!granted) granted = (await requestPermission()) === 'granted'
      if (granted) {
        sendNotification({ title: t('sysNotify.agentTitle'), body: t('settings.notifications.testSent') })
        notificationsStore.push({ level: 'success', content: t('settings.notifications.testSent') })
      } else {
        notificationsStore.push({ level: 'warning', content: t('settings.notifications.testDenied'), type: 'system' })
      }
      return
    }
    if (typeof Notification === 'undefined') {
      notificationsStore.push({ level: 'warning', content: t('settings.notifications.testDenied'), type: 'system' })
      return
    }
    let perm = Notification.permission
    if (perm === 'default') perm = await Notification.requestPermission()
    if (perm !== 'granted') {
      notificationsStore.push({ level: 'warning', content: t('settings.notifications.testDenied'), type: 'system' })
      return
    }
    new Notification(t('sysNotify.agentTitle'), { body: t('settings.notifications.testSent'), icon: '/nis-logo2.png' })
    notificationsStore.push({ level: 'success', content: t('settings.notifications.testSent') })
  } catch (e: any) {
    notificationsStore.push({ level: 'error', content: String(e?.message || e).slice(0, 120), type: 'system' })
  }
}

// ── 供应商 ──（共享 store：设置页与伙伴编辑页共用，含 localStorage 持久化）
import { storeToRefs } from 'pinia'
import { useProvidersStore, isBuiltinProvider } from '@/stores/providers'

import { useChatStore } from '@/stores/chat'
import { useNotificationsStore } from '@/stores/notifications'

const providersStore = useProvidersStore()

const chatStore = useChatStore()
const notificationsStore = useNotificationsStore()
// storeToRefs 保持 ref（直接解构会把 computed ref 拆成原始值快照，v-model 失效）
const { providerActive, modelDropdownOpen, activeProvider } = storeToRefs(providersStore)

/* ★1010 删除：本地包装 `selectProvider(id)`（原来供"点开卡片/新增供应商"顺手切全局用）——
   设计口径"新窗口模型默认=上次在对话里选的模型，前端不做设置按钮"，所以设置页不该再有任何
   "顺手改全局"的入口（这类入口正是串台与误切换的来源）。要切全局，去对话里的模型选择器选。 */
function toggleProviderEnabled(id: string) {
  const ok = providersStore.toggleProviderEnabled(id)
  if (!ok) {
    capDialogVisible.value = true
  }
}
function toggleModelEnabled(providerId: string, modelId: string) {
  providersStore.toggleModelEnabled(providerId, modelId)
}
// Base URL 可编辑。输入期间原样返回（不自动补协议，否则删除时字符会"冒出来"且光标跳到末尾）；
// 只在失焦时归一化（无协议补 https://、去末尾斜杠）。
// 0917：activeProvider 可能为 undefined（不再兜底）→ getter 可选链、setter 先判空
/* ★1010：设置页「展开的卡片」id —— **声明上移**到 editingProvider 之前，因为弹窗内所有
   字段的作用域根就是它（下方原声明处只留注释，勿重复声明）。 */
const provExpandedId = ref<string | null>(null)

/* ★1010 修「串台」：设置弹窗里的读写目标必须是**当前展开的那一家**（provExpandedId），
   而不是全局激活供应商 activeProvider —— 后者会被 stores 的 syncFromBackend（WS 连上后
   300ms、每 20s、窗口重新聚焦/切回前台）用后端持久化值改写，10s 保护窗一过就"跳"回旧家：
   表现就是"展开 AMD 卡片，正文却显示/写入了 commandcode.ai"（模型、Key、Base 一起串）。
   editingProvider 与弹窗头部用的 p 同一个来源，旧代码那句"展开的卡片恒等于 providerActive"
   的前提（每次同步都会改 providerActive）本身不成立。 */
const editingProvider = computed(() => providersStore.providers.find(p => p.id === provExpandedId.value) || activeProvider.value)
/* ★1010：弹窗内的 API Key 同样以"展开的那家"为准 —— 旧写法直接绑 store.apiKey（= 全局激活
   供应商的 key），于是你在 AMD 卡片里填的 Key 会写进 commandcode.ai 那家（覆盖别人的钥匙）。 */
const editingApiKey = computed<string>({
  get: () => { const id = editingProvider.value?.id; return id ? (providersStore.apiKeys[id] || '') : '' },
  set: (v: string) => { const id = editingProvider.value?.id; if (id) providersStore.setApiKeyFor(id, v) },
})

const providerBaseInput = computed<string>({
  get: () => editingProvider.value?.base || '',
  set: (v: string) => { const id = editingProvider.value?.id; if (id) providersStore.setProviderBase(id, v) },
})

function normalizeProviderBase() {
  const id = editingProvider.value?.id
  if (!id) return
  let b = (editingProvider.value?.base || '').trim().replace(/\/+$/, '')
  if (b && !b.includes('://')) b = `https://${b}`
  providersStore.setProviderBase(id, b)
  // 0910：失焦落后端 providers.setBase——后端 providers.json 是调用权威，
  // 只改前端镜像=测试/发消息仍打旧地址（商汤"手填不通"根因之一）
  providersStore.saveProviderBase(id)
}

// D2 供应商级代理：输入期更新本地，失焦落后端（留空=直连）
const providerProxyInput = computed<string>({
  get: () => editingProvider.value?.proxyUrl || '',
  set: (v: string) => { const id = editingProvider.value?.id; if (id) providersStore.setProviderProxyLocal(id, v) },
})
function saveProviderProxy() {
  const id = editingProvider.value?.id
  if (!id) return
  providersStore.saveProviderProxy(id, editingProvider.value?.proxyUrl || '')
}

const CAP_LABEL: Record<string, string> = {
  text: '文本',
  image: '图像',
  reasoning: '推理',
  'web-search': '联网',
}
function capLabel(c: string): string {
  return CAP_LABEL[c] || c
}
function fmtContext(n: number): string {
  if (!n) return '—'
  return n >= 1000 ? `${Math.round(n / 1000)}K` : String(n)
}

// ── 供应商页交互（添加/删除/测试连接/保存反馈） ──
const addProviderOpen = ref(false)
const newProvider = reactive({ id: '', name: '', base: '' })
const addModelOpen = ref(false)
/* 0925：三个数值字段初值改空串（原来是 0）—— 反馈"预填 0 卡住了选项框的名字"：
   预填 0 时输入框有值就不显示 placeholder（"上下文 / 输入价格 / 输出价格"），用户看不出框是干嘛的。
   提交处 submitAddModel 已有 Number(x) || 0 兜底，空值=0 语义不变。 */
const newModel = reactive({ id: '', name: '', inputPrice: '', outputPrice: '', maxContext: '', modelKind: 'text' as 'text' | 'image' | 'video' | 'multimodal' })
/* 0910：删除供应商二次确认改弹窗（旧版按钮内联"确认删除？"2.5s 超时，用户反馈看不清/易误点）。
   存被删供应商 id+名，弹窗确认才落 providers.remove（前后端同步删）。 */
const provRemoveConfirm = ref<{ id: string; name: string } | null>(null)
function askRemoveProvider(p: { id: string; name: string }) {
  provRemoveConfirm.value = { id: p.id, name: p.name }
}
/** API Key 明文/密文切换 */
const showApiKey = ref(false)

function submitAddProvider() {
  const newProvId = newProvider.id.trim()
  providersStore.addProvider({ id: newProvider.id, name: newProvider.name, base: newProvider.base })
  if (newProvId) {
    /* ★1010（需求）：点「添加」就**自动抓一次头像**（原来得悬停头像再点按钮）。
       延迟 500ms：「添加即落后端」是异步的，太早发抓取请求会撞上"后端还没有这家"。
       静默模式（quiet）：失败不弹通知（保持首字母兜底），成功也不弹（头像直接换上去）。 */
    setTimeout(() => {
      const added = providersStore.providers.find((x) => x.id === newProvId)
      if (added) void fetchProviderLogo(added, { quiet: true })
    }, 500)
    // ★1010：新增后**只展开它**（纯 UI），不再顺手把它设成"上次选的那家"——
    // 新会话默认模型只由"对话里选模型"改写（设计口径）。
    provExpandedId.value = newProvider.id.trim()
    newProvider.id = ''
    newProvider.name = ''
    newProvider.base = ''
    addProviderOpen.value = false
  }
}

function submitAddModel() {
  if (!newModel.id.trim()) return
  // 模型类型 → capabilities：text=['text']，multimodal=['text','image']，image=['image']，video=['video']
  const kindCaps: Record<string, string[]> = { text: ['text'], multimodal: ['text', 'image'], image: ['image'], video: ['video'] }
  const pid = editingProvider.value?.id
  if (!pid) return
  providersStore.addModel(pid, {
    id: newModel.id.trim(),
    name: newModel.name.trim() || newModel.id.trim(),
    inputPrice: Number(newModel.inputPrice) || 0,
    outputPrice: Number(newModel.outputPrice) || 0,
    maxContext: Number(newModel.maxContext) || 0,
    capabilities: kindCaps[newModel.modelKind] || ['text'],
    enabled: true,
  })
  newModel.id = ''
  newModel.name = ''
  newModel.inputPrice = ''
  newModel.outputPrice = ''
  newModel.maxContext = ''
  newModel.modelKind = 'text'
  addModelOpen.value = false
}

/* ── 0910 已入库模型行内编辑（模态 + 上下文裸 token 数 + 思考挡位）。
   旧版只能删了重加；上下文不再按 K 计量（用户拍板），预设 chip 一键填 + 输入框可自填任意数。
   0910：新增思考挡位勾选——勾了推理能力才显示四挡胶囊；勾选集合=权威声明（写 ProviderModel.efforts），
   滑块/后端钳位都读它（providersStore.modelEfforts / 后端 resolveModelEfforts 同一语义）。 ── */
/* ★ 0923（反馈）：设置→通用页这几个下拉原本都是**原生 <select>** —— 一展开就是系统蓝底列表，很出戏。
   统一换成项目自绘的 MiniSelect（白底圆角弹层 + hover 反白 + Teleport 免裁切），与「命令终端选择」同一套观感。
   注意 MiniSelect 的 modelValue 是 string，所以这里统一用字符串档位，回写时 Number() 转回去。 */
const genRoundOptions = computed(() => [
  { value: '30', label: t('settings.general.roundsN', { n: 30 }) },
  { value: '60', label: t('settings.general.roundsN', { n: 60 }) },
  { value: '90', label: t('settings.general.roundsN', { n: 90 }) },
  { value: '120', label: t('settings.general.roundsN', { n: 120 }) },
  { value: '150', label: t('settings.general.roundsN', { n: 150 }) },
  { value: '0', label: t('settings.general.unlimited'), desc: t('settings.general.roundsUnlimitedHint') },
])
const genBudgetOptions = computed(() => [
  { value: '500000', label: t('settings.general.budgetW50') },
  { value: '1000000', label: t('settings.general.budgetW100') },
  { value: '2000000', label: t('settings.general.budgetW200d') },
  { value: '5000000', label: t('settings.general.budgetW500') },
  { value: '10000000', label: t('settings.general.budgetW1000') },
  { value: '0', label: t('settings.general.unlimited'), desc: t('settings.general.budgetUnlimitedHint') },
])
const genMemberLimitOptions = computed(() => [
  { value: '30', label: t('settings.general.memberLimit30d') },
  { value: '60', label: t('settings.general.memberLimit1h') },
  { value: '120', label: t('settings.general.memberLimit2h') },
  { value: '240', label: t('settings.general.memberLimit4h') },
  { value: '0', label: t('settings.general.unlimited'), desc: t('settings.general.memberLimitUnlimitedHint') },
])
const genFsReadOptions = computed(() => [
  { value: '0', label: t('settings.general.fsReadAuto') },
  { value: '8000', label: '8000' },
  { value: '16000', label: '16000' },
  { value: '32000', label: '32000' },
  { value: '48000', label: '48000' },
])
const genBgResumeMaxOptions = computed(() => [
  { value: '1', label: '1' }, { value: '2', label: '2' }, { value: '3', label: '3' },
  { value: '4', label: '4' }, { value: '5', label: '5' }, { value: '6', label: '6' },
  { value: '8', label: '8' }, { value: '10', label: '10' },
])
/* ★ 0923（用户定）：询问卡超时时长 —— 超时后挂通知 + 自动关卡片；0 = 不超时 */
const genQuestionTimeoutOptions = computed(() => [
  { value: '60', label: t('settings.general.questionTimeoutM', { n: 1 }) },
  { value: '120', label: t('settings.general.questionTimeoutM', { n: 2 }) },
  { value: '180', label: t('settings.general.questionTimeoutM', { n: 3 }) },
  { value: '300', label: t('settings.general.questionTimeoutM', { n: 5 }) },
  { value: '600', label: t('settings.general.questionTimeoutM', { n: 10 }) },
  { value: '0', label: t('settings.general.questionTimeoutNever') },
])

const CTX_PRESETS: Array<{ label: string; v: number }> = [
  { label: '16K', v: 16000 }, { label: '32K', v: 32000 }, { label: '128K', v: 128000 },
  { label: '256K', v: 256000 }, { label: '512K', v: 512000 }, { label: '1M', v: 1000000 },
]
/* 0921：输入/输出上限的预设档（用户定：两个框都露给用户、可自填任意值 + 一键预设）。
   输出档按"常见 max_tokens"给；输入档按"常见窗口量级"给。留空 = 不设限，走 models.dev。 */
const OUT_PRESETS: Array<{ label: string; v: number }> = [
  { label: '4K', v: 4096 }, { label: '8K', v: 8192 }, { label: '16K', v: 16384 },
  { label: '32K', v: 32768 }, { label: '64K', v: 65536 }, { label: '128K', v: 128000 },
]
const IN_PRESETS: Array<{ label: string; v: number }> = [
  { label: '64K', v: 64000 }, { label: '128K', v: 128000 }, { label: '256K', v: 256000 },
  { label: '512K', v: 512000 }, { label: '1M', v: 1000000 }, { label: '2M', v: 2000000 },
]
const EFFORT_ALL = ['fast', 'deep', 'heavy', 'burning']
const EFFORT_SHORT: Record<string, string> = { fast: 'Low', deep: 'Mid', heavy: 'High', burning: 'Max' }
const editingModelId = ref<string | null>(null)
/** 0923：模型编辑改为居中弹窗（原来行内展开的"抽屉"不好用）——被编辑的模型对象 */
const editingModel = computed(() => {
  const pid = editingProvider.value?.id
  if (!pid || !editingModelId.value) return null
  return (providersStore.models[pid] || []).find(m => m.id === editingModelId.value) || null
})
/** 弹窗保存入口（模板里不用写非空断言） */
function saveEditingModel() {
  const pid = editingProvider.value?.id
  if (!pid || !editingModelId.value) return
  saveEditModel(pid, editingModelId.value)
}
const editDraft = reactive({ maxContext: 0, maxInput: 0, maxOutput: 0, vision: false, reasoning: false, genImage: false, efforts: { fast: true, deep: true, heavy: true, burning: true } as Record<string, boolean> })
// 0913：模型行「测试连通性」按钮（位于开关与编辑之间）——复用 providers.test 链路（后端代理 + 超时自动重试）
const testingModel = reactive<Record<string, boolean>>({})
async function testModelRow(providerId: string, modelId: string) {
  if (testingModel[modelId]) return
  testingModel[modelId] = true
  try {
    const r = await testModelConnection(providerId, modelId)
    notificationsStore.push({ level: r.ok ? 'success' : 'error', content: `${r.ok ? '✓' : '✗'} ${modelId} · ${r.msg}` })
  } finally {
    testingModel[modelId] = false
  }
}

function startEditModel(mm: { id: string; maxContext?: number; maxInput?: number; maxOutput?: number; capabilities?: string[]; supports?: { vision?: boolean; reasoning?: boolean }; inputModalities?: string[]; outputModalities?: string[]; efforts?: string[] }) {
  editingModelId.value = editingModelId.value === mm.id ? null : mm.id
  if (editingModelId.value) {
    editDraft.maxContext = mm.maxContext || 0
    // 0921：输入/输出上限（0 = 留空 = 不设限，后端按 models.dev / 窗口动态算）
    editDraft.maxInput = mm.maxInput || 0
    editDraft.maxOutput = mm.maxOutput || 0
    editDraft.vision = mm.inputModalities ? mm.inputModalities.includes('image') : (mm.supports?.vision ?? (mm.capabilities || []).includes('image'))
    editDraft.reasoning = mm.supports?.reasoning ?? (mm.capabilities || []).includes('reasoning')
    editDraft.genImage = !!mm.outputModalities?.includes('image')
    const eff = mm.efforts?.length ? mm.efforts : providersStore.modelEfforts(editingProvider.value?.id || '', mm.id)
    for (const e of EFFORT_ALL) editDraft.efforts[e] = eff.includes(e)
  }
}
function saveEditModel(pid: string, modelId: string) {
  const caps = ['text', ...(editDraft.vision ? ['image'] : []), ...(editDraft.reasoning ? ['reasoning'] : [])]
  const efforts = editDraft.reasoning ? EFFORT_ALL.filter(e => editDraft.efforts[e]) : []
  providersStore.updateModel(pid, modelId, {
    maxContext: Number(editDraft.maxContext) || 0,
    // 0921：0 = 留空 = 不设限（后端走 models.dev / 窗口动态算）；填了 = 权威
    maxInput: Number(editDraft.maxInput) || 0,
    maxOutput: Number(editDraft.maxOutput) || 0,
    capabilities: caps,
    inputModalities: ['text', ...(editDraft.vision ? ['image'] : [])],
    outputModalities: ['text', ...(editDraft.genImage ? ['image'] : [])],
    supports: { vision: editDraft.vision, reasoning: editDraft.reasoning },
    // 0910：推理模型=显式声明可用挡（全勾也写=权威，防 zai 兜底误伤）；非推理=清空声明
    efforts: editDraft.reasoning ? efforts : undefined,
  })
  editingModelId.value = null
}

/* 0917：供应商级「测试连接」按钮已删除（连通性由每个模型行的「测试链接」承担）——
   原来的 doTestConnection / testState / testMsg 一并移除，避免留死代码。 */

/* ── 0917 供应商头像：悬停头像 → 从站点抓 logo ──
 * 自建供应商默认是首字母方块，这里允许一键从他的 Base URL 抓 favicon/og:image 当头像
 * （后端负责多级回退 + 魔数校验 + 体积上限，这里只管交互与提示）。
 * 0917c：**内置供应商不提供抓取** —— 出厂就带官方图标，抓来的 favicon 反而更糊，
 * 还会以 base64 内联把 providers.json 撑大。
 * 0918 修正：内置判定改用 isBuiltinProvider(id)，不再看 logo 前缀 ——
 * 自定义供应商曾被赋 /providers-logo/<id>.svg（文件不存在），导致按钮永远不出现。 */
const logoHoverId = ref('')
const logoFetchingId = ref('')
function hasBundledLogo(p: { id?: string; logo?: string }): boolean {
  return isBuiltinProvider(String(p?.id || ''))
}
/* ★ 0925e（需求）：内置锁定供应商 —— Key/URL 不可写、不可查看（OpenCode Zen 公共档，
 * 用字面量 'public' 认证 + 后端自动探活同步 free 模型，用户零配置直接用）。 */
const LOCKED_PROVIDER_IDS = new Set(['opencode-zen'])
function isLockedProvider(id?: string): boolean {
  return LOCKED_PROVIDER_IDS.has(String(id || ''))
}
async function fetchProviderLogo(p: { id: string; name: string; logo?: string }, opts?: { quiet?: boolean }) {
  /* ★1010（需求）：加 quiet 模式 —— 供"添加供应商时自动抓"用：不弹任何通知
     （自动触发的东西不该打扰用户；失败就保持首字母兜底，只留 console 证据）。 */
  if (logoFetchingId.value) return
  if (hasBundledLogo(p)) {
    if (!opts?.quiet) notificationsStore.push({ level: 'info', content: t('settings.providers.logoBundled') })
    return
  }
  logoFetchingId.value = p.id
  try {
    const { useChatStore } = await import('@/stores/chat')
    const r: any = await useChatStore().bridgeRpc('providers.fetchLogo', { providerId: p.id })
    if (r?.ok && r.logo) {
      providersStore.setProviderLogo(p.id, r.logo)
      if (!opts?.quiet) notificationsStore.push({ level: 'success', content: t('settings.providers.logoFrom', { host: r.host || '' }) })
    } else if (!opts?.quiet) {
      notificationsStore.push({ level: 'error', content: r?.error || t('settings.providers.fetchLogoFail') })
    }
  } catch (e: any) {
    if (!opts?.quiet) notificationsStore.push({ level: 'error', content: t('settings.providers.fetchLogoFail') + ' ' + String(e?.message || e).slice(0, 100) })
    else console.warn('[providers] 自动抓 logo 失败（保持首字母兜底）:', p.id, e?.message || e)
  } finally {
    logoFetchingId.value = ''
    logoHoverId.value = ''
  }
}

function confirmRemoveProvider() {
  if (!provRemoveConfirm.value) return
  const id = provRemoveConfirm.value.id
  provRemoveConfirm.value = null
  if (provExpandedId.value === id) provExpandedId.value = null
  providersStore.removeProvider(id)
}

const syncPriceMsg = ref('')

// ── 获取模型弹窗：拉取列表 → 勾选/全选 → 保存合并进模型表 ──
const fetchDialogOpen = ref(false)
const fetchingModels = ref(false)
const fetchedModels = ref<string[]>([])
const selectedFetchedModels = ref<string[]>([])
const fetchError = ref('')
/** 0910 反馈12：获取到模型后的来源说明（官方接口 N 个 + 本地补充 K 个） */
const fetchNotice = ref('')
/** 当前供应商是否已接入 API（有 key）——无 key 不显示模型预设列表 */
const hasApiKey = computed(() => !!editingApiKey.value)
const enabledModelCount = computed(() => {
  const pid = editingProvider.value?.id
  return pid ? (providersStore.models[pid] || []).filter(m => m.enabled).length : 0
})

// 切换供应商：清空测试连通状态，避免上一个供应商的结果串台
watch(providerActive, () => {
  // ★ 0921c 修：testState / testMsg 在 0917 重构里已删除（见下方 0917 注释），这里漏删 ——
  //   每次切换供应商都会抛 ReferenceError: testState is not defined（控制台刷屏），
  //   且异常发生在 addModelOpen 复位之前 ⇒ 复位永远执行不到。删掉这两行即可。
  addModelOpen.value = false
})

/* ★1010：获取模型弹窗**锁定**的目标供应商 —— 打开弹窗时记下（fetchProviderId），保存时沿用它；
   不再读"保存那一刻"的 activeProvider（弹窗开着时后台同步可能已把它改走 ⇒ 模型写进别人家）。 */
const fetchProviderId = ref('')
const fetchProvider = computed(() => providersStore.providers.find(p => p.id === fetchProviderId.value) || editingProvider.value)

async function openFetchDialog() {
  fetchDialogOpen.value = true
  fetchingModels.value = true
  fetchedModels.value = []
  selectedFetchedModels.value = []
  fetchedPicks.value = {}
  fetchedSug.value = {}
  fetchError.value = ''
  fetchNotice.value = ''
  fetchQuery.value = ''   // ★1010：每次打开重置搜索（免得上次的关键字把这次的列表先筛没了）
  try {
    const pid = editingProvider.value?.id
    if (!pid) { fetchError.value = '未选中供应商'; return }
    fetchProviderId.value = pid
    // 只探测不合并：列表展示候选模型，勾选后保存才真正加入模型列表
    const r = await providersStore.probeModelIds(pid)
    if (r.ok && r.ids.length) {
      fetchedModels.value = r.ids
      fetchedSug.value = r.sugMap || {}
      // 0910 反馈12：条数来源提示（官方接口 N 个 + 本地补充 K 个 / 或"未取到官方列表"）
      fetchNotice.value = r.msg || ''
      // 0908 排序：已入库 → models.dev 官方确认 → 其余（推断），组内按名称字典序——列表不再乱
      {
        const ex = new Set((providersStore.models[pid] || []).map(m => m.id))
        const rank = (id: string) => ex.has(id) || r.sugMap?.[id]?.source === 'manual' ? 0 : r.sugMap?.[id]?.source === 'dev' ? 1 : 2
        r.ids.sort((a: string, b: string) => rank(a) - rank(b) || a.localeCompare(b))
      }
      // 0907 供应商C段：每模型能力默认勾选 = 后端建议（manual/dev/inferred 三档来源），可手动改
      // 0909③：上下文列改裸 token 数（用户拍板"别按K计量，直接填数"），预填=已存值优先，其次 models.dev 官方 context
      const picks: Record<string, FetchedPick> = {}
      const existMap = new Map((providersStore.models[pid] || []).map(m => [m.id, m]))
      for (const id of r.ids) {
        const s = r.sugMap?.[id]
        const saved = existMap.get(id) as any
        const ctx = Math.round(saved?.maxContext || s?.context || 0)
        // 0923：输入/输出上限也预填——已存值优先，其次后端带回的建议值（都没有就留空 = 走自动）
        const out = Math.round(saved?.maxOutput || (s as any)?.maxOutput || 0)
        const inp = Math.round(saved?.maxInput || (s as any)?.maxInput || 0)
        picks[id] = {
          vision: s?.vision ?? false, reasoning: s?.reasoning ?? false, genImage: s?.genImage ?? false,
          contextTokens: ctx > 0 ? ctx : undefined,
          maxOutput: out > 0 ? out : undefined,
          maxInput: inp > 0 ? inp : undefined,
        }
      }
      fetchedPicks.value = picks
      // 已存在的模型默认勾上（用户可取消），新模型默认不勾
      const existing = new Set((providersStore.models[pid] || []).map(m => m.id))
      selectedFetchedModels.value = r.ids.filter(id => existing.has(id))
    } else {
      fetchError.value = r.msg || '获取失败'
    }
  } catch (e: any) {
    fetchError.value = `获取失败：${e?.message || e}`
  } finally {
    fetchingModels.value = false
  }
}
// 0907 供应商C段：弹窗每模型的能力勾选 + 建议来源（保存时写进 capabilities+三轴=权威）
/** 0923：获取弹窗每模型的勾选草稿（能力三轴 + 上下文 / 输入上限 / 输出上限 三个数值列） */
type FetchedPick = { vision: boolean; reasoning: boolean; genImage: boolean; contextTokens?: number; maxInput?: number; maxOutput?: number }
const fetchedPicks = ref<Record<string, FetchedPick>>({})
const fetchedSug = ref<Record<string, { source: 'manual' | 'dev' | 'inferred' }>>({})
/** ★1010（需求）：获取模型弹窗的搜索筛选 —— 中转站动辄上百个模型，逐个找太费劲。
    匹配规则：大小写不敏感的**子串**；空格分隔多关键词 = 全部命中（AND）；匹配模型 id（展示名与 id 同值）。
    「全选 / 取消全选」只作用于**当前筛选结果**（先搜 qwen 再点全选 = 只选中所有 qwen）。 */
const fetchQuery = ref('')
const filteredFetchedModels = computed(() => {
  const q = fetchQuery.value.trim().toLowerCase()
  if (!q) return fetchedModels.value
  const parts = q.split(/\s+/).filter(Boolean)
  return fetchedModels.value.filter((id) => {
    const hay = String(id).toLowerCase()
    return parts.every((p) => hay.includes(p))
  })
})
/** 0923：NumChip 回写某一列数值（空值 = 清掉，落回"自动"） */
function setFetchedNum(id: string, key: 'contextTokens' | 'maxInput' | 'maxOutput', v: number | undefined) {
  const cur = fetchedPicks.value[id]
  if (!cur) return
  fetchedPicks.value = { ...fetchedPicks.value, [id]: { ...cur, [key]: v } }
}
function toggleModelCap(id: string, key: 'vision' | 'reasoning' | 'genImage') {
  const p = fetchedPicks.value[id]
  if (!p) return
  fetchedPicks.value = { ...fetchedPicks.value, [id]: { ...p, [key]: !p[key] } }
}
function toggleFetchedModel(id: string) {
  selectedFetchedModels.value = selectedFetchedModels.value.includes(id)
    ? selectedFetchedModels.value.filter(x => x !== id)
    : [...selectedFetchedModels.value, id]
}
function selectAllFetched() {
  // ★1010：只选中**当前筛选结果**（没搜索时 = 全部，行为与旧版一致）
  selectedFetchedModels.value = [...new Set([...selectedFetchedModels.value, ...filteredFetchedModels.value])]
}
function deselectAllFetched() {
  // ★1010：只取消当前筛选结果里的勾选（没搜索时 = 全部取消）
  const drop = new Set(filteredFetchedModels.value)
  selectedFetchedModels.value = selectedFetchedModels.value.filter((x) => !drop.has(x))
}
function saveFetchedModels() {
  if (!selectedFetchedModels.value.length) return
  // ★1010：目标 = **打开弹窗时锁定的那家**（fetchProviderId，见其上方注释），
  // 不再读"保存这一刻的全局激活供应商"——弹窗开着时后台同步可能已把它改走。
  const pid = fetchProviderId.value || editingProvider.value?.id
  if (!pid) return
  // 只把用户勾选的合并进模型列表；能力勾选一并带上（picks 权威写回 capabilities+inputModalities）
  const picksPicked: Record<string, FetchedPick> = {}
  for (const id of selectedFetchedModels.value) { if (fetchedPicks.value[id]) picksPicked[id] = fetchedPicks.value[id] }
  providersStore.mergeFetchedModels(pid, selectedFetchedModels.value, picksPicked)
  fetchDialogOpen.value = false
  fetchProviderId.value = ''
  syncPriceMsg.value = `已添加 ${selectedFetchedModels.value.length} 个模型`
  setTimeout(() => (syncPriceMsg.value = ''), 3000)
}

// 已启用供应商计数 + 超限弹窗（最多同时启用 12 个）
const enabledProviders = computed(() =>
  providersStore.providers.filter(p => p.enabled),
)
const capDialogVisible = ref(false)

// ── 人格：名字 / 头像 / 性格提示词（一段话 = AI 的性格）──
const personaDraft = reactive({
  nisName: settingsStore.persona.nisName,
  prompt: settingsStore.persona.prompt,
})
watch(() => personaDraft.nisName, (v) => {
  settingsStore.setPersona('nisName', v)
})
watch(() => personaDraft.prompt, (v) => {
  settingsStore.setPersona('prompt', v)
})
// AI 改设置（settings_update 工具）→ 后端广播 → store 更新 → 打开中的界面实时同步
watch(() => settingsStore.persona.nisName, (v) => {
  if (v !== personaDraft.nisName) personaDraft.nisName = v
})
watch(() => settingsStore.persona.prompt, (v) => {
  if (v !== personaDraft.prompt) personaDraft.prompt = v
})
watch(() => settingsStore.general.userName, (v) => {
  if (v !== generalDraft.userName) generalDraft.userName = v
})
// 头像：上传（压缩 dataURL）/ 重置
const avatarFileRef = ref<HTMLInputElement | null>(null)
const avatarPreview = ref(settingsStore.persona.avatar)
function onAvatarFileChange(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (!file) return
  const reader = new FileReader()
  reader.onload = () => {
    const dataUrl = String(reader.result || '')
    avatarPreview.value = dataUrl
    settingsStore.setPersona('avatar', dataUrl)
  }
  reader.readAsDataURL(file)
  ;(e.target as HTMLInputElement).value = ''
}
function resetAvatar() {
  avatarPreview.value = ''
  settingsStore.setPersona('avatar', '')
}

// 主动记忆：与 settingsStore.autoMem 双向同步（自动提炼开关）
const activeMem = ref(settingsStore.autoMem)
watch(activeMem, (v) => { settingsStore.setAutoMem(v) })

// ── 外观 ──
// 字体大小 / 气泡头像 / 气泡圆角 → settingsStore.appearance 持久化
// 主题仅保留浅色（深色待开发），不做切换
/* 手机二批（用户定稿）：设置=列表页→子页模式。PC 不读此状态（显示切换全在 ≤767 CSS） */
const smEntered = ref(false)
/* 0910 供应商页改版：左右双栏 → 单列卡片流（点谁展开谁，就地配 Key/URL/模型），
   手机端不再需要列表/详情两段切换（provListMode 退役）。
   ★1010：provExpandedId 的声明已上移到上方「供应商页交互」段（editingProvider 之前）——
   原注释那句"展开的卡片恒等于 providerActive"的前提不成立（syncFromBackend 会改写 providerActive）。 */
/* 0925d：「高级」折叠已退役——网络代理改为常驻显示（需求），provAdvancedOpen 不再使用 */
/* ★1010（用户重新定稿，覆盖 0910 的「启停不跳位」）：列表改成**启用优先**排序 ——
   启用的靠前、停用的在后；组内保持**原始顺序**（内置按出厂顺序、外接按录入顺序）。
   但**不当场重排**：打开设置时取一次顺序快照，期间你随便拨启停都原地不动，
   关闭设置再打开才按新状态排（用户原话："先不掉到下面，关闭设置再打开的时候它再到下面去"）。
   排序规则直接复用 store 的 `sortedProviders`（已启用在前 + 组内保序），不另写一套。 */
const providerOrder = ref<string[]>([])
watch(() => props.open, (v) => {
  if (v) providerOrder.value = providersStore.sortedProviders.map((p) => p.id)
}, { immediate: true })
const providerList = computed(() => {
  const rank = providerOrder.value
  // 快照里没有的（设置开着时新加的供应商）落到末尾，彼此按"启用优先"（sort 稳定 ⇒ 组内保序）
  return providersStore.providers.slice().sort((a, b) => {
    const ia = rank.indexOf(a.id), ib = rank.indexOf(b.id)
    if (ia >= 0 && ib >= 0) return ia - ib
    if (ia >= 0) return -1
    if (ib >= 0) return 1
    return Number(b.enabled) - Number(a.enabled)
  })
})
/** ★1010（用户："加上也行"）：供应商列表搜索（现在 20+ 家，翻起来费劲）。
    大小写不敏感子串；空格分隔多关键词 = 全部命中 AND。
    ★防御：**当前展开的那家永远保留** —— 它的详情弹窗（Teleport，v-if 在 v-for 内）是挂在这个
    列表项上的，被筛掉会导致弹窗诡异"自己关掉"（正常路径下遮罩挡住了搜索框，但键盘 Tab
    能绕过去，属低频但真实的路径）。 */
const providerQuery = ref('')
const filteredProviderList = computed(() => {
  const q = providerQuery.value.trim().toLowerCase()
  if (!q) return providerList.value
  const parts = q.split(/\s+/).filter(Boolean)
  return providerList.value.filter((p) => {
    if (p.id === provExpandedId.value) return true
    /* ★1010（需求）：**只按供应商名字搜** —— 原来把 ID / Base URL 也一起搜，噪音太大
       （搜 "ai" 会命中一堆地址里带 ai 的）。展示名或 id 都算"名字"：优先展示名，没有才用 id。 */
    const hay = String(p.name || p.id || '').toLowerCase()
    return parts.every((x) => hay.includes(x))
  })
})
function expandProvider(id: string) {
  if (provExpandedId.value === id) {
    /* ★1010：收起详情（二级）时把盖在它上面的三级状态一起复位 —— 否则"关掉这家详情、再打开另一家"
       会把上一家的获取模型/编辑模型弹窗带过来（实测的同源现象）。 */
    provExpandedId.value = null
    addModelOpen.value = false
    editingModelId.value = null
    fetchDialogOpen.value = false
    fetchProviderId.value = ''
    return
  }
  provExpandedId.value = id
  /* ★1010（设计口径："新窗口模型默认=上次选择的模型，前端不做设置按钮"）：
     这里原来还有一句 `selectProvider(id)` —— 它把"我正在看哪家"写进了"上次选的那家"
     （同一个 providerActive 字段被当两个意思用）⇒"点开看一眼"就改了新会话默认来源，
     还会被 20s 同步拉回（串台的根源之一）。展开 = 纯浏览/编辑，**不碰全局**。 */
  showApiKey.value = false
  addModelOpen.value = false
  editingModelId.value = null
}
/* ★1010：换一家展开时复位子表单（原先挂在 watch(providerActive) 上——那个 watch 退役后
   仍保留作双保险）。 */
watch(provExpandedId, () => {
  addModelOpen.value = false
  editingModelId.value = null
})
/** URL 实时校验：非空但没写协议 → 红边+人话提示（失焦 normalizeProviderBase 自动补 https://） */
const urlInvalid = computed(() => {
  // 0917：activeProvider 已改为「精确匹配 providerActive，不做兜底」→ 可能为 undefined
  const b = (editingProvider.value?.base || '').trim()
  return !!b && !/^https?:\/\//i.test(b)
})
watch(() => props.open, (v) => { if (v) smEntered.value = false })
/** ★1010（需求）：过程折叠**三档**（完全展示 / 折叠工具 / 全部折叠）。
    权威字段 = appearance.processFoldMode；旧字段 foldProcessOnDone **双写**（'full'→false，其余→true），
    这样任何只认布尔的地方（手机端代码、后端投影）行为也正确。 */
const procFoldMode = computed<'full' | 'tools' | 'all'>({
  get: () => {
    const a: any = settingsStore.appearance || {}
    const m = a.processFoldMode
    if (m === 'full' || m === 'tools' || m === 'all') return m
    return a.foldProcessOnDone === false ? 'full' : 'tools'
  },
  set: (v) => {
    settingsStore.setAppearance('processFoldMode', v as any)
    settingsStore.setAppearance('foldProcessOnDone', v !== 'full')
  },
})
/** ★1010：界面字体候选 —— 用 document.fonts.check 只列本机装了的（check 为空 = 始终显示）。
 *  保护：若探测没结果（API 不可靠/非浏览器环境），退回列全部，别把列表变空。 */
const _fontDetected = FONT_PRESETS.filter(f => !f.check || document.fonts?.check?.(`12px "${f.check}"`))
const fontOptions = _fontDetected.length > 3 ? _fontDetected : FONT_PRESETS
/** ★1010：当前气泡色是"预设之外"的自选色（决定色盘按钮是否高亮） */
const isCustomColor = computed(() =>
  !!appearanceDraft.bubbleColor && !BUBBLE_COLORS.some(c => c.color === appearanceDraft.bubbleColor),
)
function onPickBubbleColor(e: Event) {
  appearanceDraft.bubbleColor = (e.target as HTMLInputElement).value
}

const appearanceDraft = reactive({
  ...settingsStore.appearance,
  // 0917 主题「按时间」：老数据没有这两个字段，给上默认值（07:00-19:00 浅色）
  // ★1010 外观新增：气泡配色 / 界面字体（老数据没有 → 给默认，避免控件不高亮）
  bubbleColor: settingsStore.appearance?.bubbleColor || '',
  fontFamily: settingsStore.appearance?.fontFamily || '',
  themeLightStart: settingsStore.appearance?.themeLightStart || '07:00',
  themeLightEnd: settingsStore.appearance?.themeLightEnd || '19:00',
})

/** 0917 主题时段预设：一键套用常见作息 */
const THEME_TIME_PRESETS: Array<{ key: string; labelKey: string; start: string; end: string }> = [
  { key: 'standard', labelKey: 'settings.theme.preset.standard', start: '07:00', end: '19:00' },
  { key: 'office', labelKey: 'settings.theme.preset.office', start: '08:00', end: '18:00' },
  { key: 'longday', labelKey: 'settings.theme.preset.longday', start: '07:00', end: '21:00' },
  { key: 'nightowl', labelKey: 'settings.theme.preset.nightowl', start: '10:00', end: '02:00' },
]
function applyThemePreset(ps: { start: string; end: string }): void {
  appearanceDraft.themeLightStart = ps.start
  appearanceDraft.themeLightEnd = ps.end
}
const bgName = ref('')
const bgError = ref('')
async function pickBgImage(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (!file) return
  bgError.value = ''
  if (!file.type.startsWith('image/')) { bgError.value = t('settings.appearance.bgNotImage'); return }
  if (file.size > 2 * 1024 * 1024) { bgError.value = t('settings.appearance.bgTooLarge'); return }
  try {
    const dataUrl = await new Promise((resolve, reject) => {
      const rd = new FileReader()
      rd.onload = () => resolve(String(rd.result))
      rd.onerror = () => reject(rd.error)
      rd.readAsDataURL(file)
    })
    appearanceDraft.bgImage = dataUrl
    bgName.value = file.name
  } catch { bgError.value = t('settings.appearance.bgReadFail') }
  ;(e.target as HTMLInputElement).value = ''
}
function clearBgImage() { appearanceDraft.bgImage = ''; bgName.value = ''; bgError.value = '' }
watch(appearanceDraft, () => {
  settingsStore.setAppearance('themeMode', appearanceDraft.themeMode)
  settingsStore.setAppearance('themeLightStart', appearanceDraft.themeLightStart)
  settingsStore.setAppearance('themeLightEnd', appearanceDraft.themeLightEnd)
  settingsStore.setAppearance('fontSize', appearanceDraft.fontSize)
  settingsStore.setAppearance('bubbleAvatar', appearanceDraft.bubbleAvatar)
  settingsStore.setAppearance('bubbleRadius', appearanceDraft.bubbleRadius)
  settingsStore.setAppearance('bubbleColor', appearanceDraft.bubbleColor)
  settingsStore.setAppearance('fontFamily', appearanceDraft.fontFamily)
  settingsStore.setAppearance('bgImage', appearanceDraft.bgImage)
  settingsStore.setAppearance('bgOpacity', appearanceDraft.bgOpacity)
  settingsStore.setAppearance('fxLevel', appearanceDraft.fxLevel || 'full')
}, { deep: true })

/** ★1012ac：主题模式**即时生效**（实测：「设置里选了浅色，界面还是深色」）。
 *  根因：该字段绑的是 `appearanceDraft`（草稿对象），只有点「保存设置」才写回 store ⇒
 *  `main.ts` 里的 `watch(themeMode, applyTheme)` 不触发 ⇒ 看着像"选了没反应"。
 *  主题属于"即时预览型"设置（用户期望点完立刻变），所以选完立即写回并应用；
 *  「按时间」的起止时刻也一并即时生效。注：即时生效后「取消」不回滚主题。 */
function applyThemeNow(v: unknown) {
  settingsStore.setAppearance('themeMode', v as never)
  settingsStore.setAppearance('themeLightStart', appearanceDraft.themeLightStart)
  settingsStore.setAppearance('themeLightEnd', appearanceDraft.themeLightEnd)
}

// ── 提示 ──
// 系统通知偏好已持久化到 settings store（settings.notify），这里直接读写 store

// 提示音：内置声音下拉 + 试听 + 上传自定义（dataURL 持久化到 settings.notify.customSounds）
const soundCategories: { key: NotifyCategory; labelKey: string; hintKey: string }[] = [
  { key: 'agent', labelKey: 'settings.notifications.agent', hintKey: 'settings.notifications.agentSoundHint' },
  { key: 'permission', labelKey: 'settings.notifications.permission', hintKey: 'settings.notifications.permissionSoundHint' },
  { key: 'error', labelKey: 'settings.notifications.error', hintKey: 'settings.notifications.errorSoundHint' },
  { key: 'memory', labelKey: 'settings.notifications.memory', hintKey: 'settings.notifications.memorySoundHint' },
  { key: 'channel', labelKey: 'settings.notifications.channel', hintKey: 'settings.notifications.channelSoundHint' },
]

/** 每类别的分组标题（与 notifySound.ts 里的 group 对应） */
const SOUND_GROUP_LABEL: Record<NotifyCategory, string> = {
  agent: 'AI 回复',
  permission: '权限请求',
  error: '错误',
  memory: '自动记忆',
  channel: '机器人回复',
}

function soundOptions(category: NotifyCategory) {
  // ★1010 只列「本类别 + 无分组的旧项」：注册表现在带 group 标注，
  // 不筛的话每个下拉都会出现全部 22 项，跨场景串味。
  // 无 group 的条目（〔旧〕system/demo）任何类别都能选，保持原行为。
  const opts = BUILTIN_SOUNDS.filter(s => !s.group || s.group === SOUND_GROUP_LABEL[category])
  const hasCustom = !!settingsStore.notify.customSounds?.[category]
  if (hasCustom) {
    opts.push({ id: CUSTOM_SOUND_ID, label: t('settings.notifications.custom'), file: '' })
  }
  return opts
}

function currentSoundValue(category: NotifyCategory): string {
  const v = settingsStore.notify[`${category}Sound`]
  return v || BUILTIN_SOUNDS[0].id
}

function onSoundChange(category: NotifyCategory, id: string) {
  settingsStore.setNotify(`${category}Sound`, id)
}

function onPreviewSound(category: NotifyCategory) {
  previewSound(currentSoundValue(category))
}

const soundFileInputs: Record<string, HTMLInputElement | null> = {}

function triggerSoundUpload(category: NotifyCategory) {
  soundFileInputs[category]?.click()
}

function onSoundFile(category: NotifyCategory, e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  if (!/audio\/(wav|mpeg|mp3|ogg|webm|m4a)|\.(wav|mp3|ogg|m4a|webm)$/i.test(file.type + file.name)) {
    notificationsStore.push({ level: 'error', title: t('settings.notifications.title'), content: t('settings.notifications.uploadType'), type: 'system' })
    input.value = ''
    return
  }
  if (file.size > 2 * 1024 * 1024) {
    notificationsStore.push({ level: 'error', title: t('settings.notifications.title'), content: t('settings.notifications.uploadSize'), type: 'system' })
    input.value = ''
    return
  }
  const reader = new FileReader()
  reader.onload = () => {
    const dataUrl = typeof reader.result === 'string' ? reader.result : ''
    if (dataUrl) {
      settingsStore.setCustomSound(category, dataUrl)
      previewSound(CUSTOM_SOUND_ID)
    }
  }
  reader.readAsDataURL(file)
  input.value = ''
}

function clearCustomSound(category: NotifyCategory) {
  settingsStore.clearCustomSound(category)
}

// ── 浏览器（内置浏览器管理：启动模式 / 引擎 / 启停 / cookies，读写 browser store）──
import { useBrowserStore, normalizeHomeUrl, normalizeProxyUrl } from '@/stores/browser'
import { swallowed } from '@/utils/swallowed'

const browserStore = useBrowserStore()

const browserEngine = ref(browserStore.engine)
watch(browserEngine, (v) => {
  browserStore.setEngine(v)
})

const browserDefaultUrl = ref(browserStore.defaultUrl)
watch(browserDefaultUrl, (v) => {
  browserStore.setDefaultUrl(v)
})

/* ★1011k：代理地址（用户定：填了走代理，留空=直连）。
   值权威存后端 browser-settings.json（与"反爬 / GPU"同一套读写），这里只做编辑态 + 失焦保存。
   代理是 Chromium 的**启动参数** ⇒ 改完需重启浏览器实例；点「启动浏览器」时后端检测到变化会自动重启，所以那条路不用手动关。 */
const browserProxy = ref(browserStore.settings.proxy || '')
watch(() => browserStore.settings.proxy, (v) => { browserProxy.value = v || '' })
function saveBrowserProxy() {
  const v = normalizeProxyUrl(browserProxy.value)
  browserProxy.value = v
  if (v !== (browserStore.settings.proxy || '')) bSet({ proxy: v })
}

const engineDropdownOpen = ref(false)

/* ── 浏览器 直播流畅度 / 反爬 / 渲染 设置（后端 browser-settings.json 权威） ── */
const bs = computed(() => browserStore.settings)
function bRpc(m: string, p: Record<string, any> = {}) { return chatStore.bridgeRpc(m, p) }
function bSet(patch: Record<string, any>) { browserStore.saveSettings(bRpc, patch) }
/** 流畅度分档：按当前 castFps/quality 推断档位 */
const smoothPreset = computed(() => bs.value.castFps >= 18 ? 'smooth' : bs.value.castFps <= 7 ? 'eco' : 'balanced')
function bApplySmooth(k: 'eco' | 'balanced' | 'smooth') {
  if (k === 'eco') bSet({ castFps: 6, castQuality: 45, castScale: 2, castEveryNth: 2 })
  else if (k === 'balanced') bSet({ castFps: 11, castQuality: 60, castScale: 2, castEveryNth: 1 })
  else bSet({ castFps: 20, castQuality: 75, castScale: 1.5, castEveryNth: 1 })
}
// 打开"浏览器"设置页时从后端拉权威参数（cookie 自动拉取在同组函数声明之后，见下方 watch——
// immediate 回调引用后声明的 const ref 会踩 TDZ 崩树，0905 十二批同款坑，勿上移）

/* ★0930：settings 浏览器卡管理的是 default 实例（启动/关闭都不带 sessionId），连接态必须看它的桶——
   旧值 browserStore.connected 是兼容垫片恒 false ⇒ 启动成功后状态徽标永远"未连接"、关闭按钮永远灰。 */
const browserConnected = computed(() => browserStore.bucket('default').connected)
const browserCookies = ref<{ name: string; domain: string; value: string }[]>([])
const browserCookiesLoaded = ref(false)

async function browserStart() {
  if (!chatStore.wsConnected) {
    notificationsStore.pushSystem({ title: t('settings.browser.start'), message: t('settings.browser.notConnected'), level: 'warning', category: 'error' })
    return
  }
  /* ★0930 修（实测"点启动启动不了，AI 调用却正常"）——旧代码两处必炸 + 一处观感错：
     ① onStatusFrame 少传 convId（store 签名是 (convId, p)）→ p=undefined 当场 TypeError 进 catch；
     ② browserStore.setConnected 根本不存在（store 只有空垫片 setStatus/reset）→ 又一个 TypeError；
        后端其实已经把浏览器拉起来了，前端却永远走 catch 显示"启动失败"，状态还是空操作=看起来毫无反应；
     ③ mode 写死 headless：就算成功也无窗口无反馈——现在按「启动模式」设置走（选有头就真弹窗，一眼看到启动了）。 */
  const mode = browserStore.config.mode === 'headed' ? 'headed' : 'headless'
  const b = browserStore.bucket('default')
  b.status = '浏览器启动中…'
  try {
    /* ★0930b：home=设置的默认首页（谷歌等）——后端 start 收到显式 home 会把首页开出来并置激活（此前不传=首页永远不落地） */
    const v = await chatStore.bridgeRpc('browser.start', { mode, home: browserStore.homeUrl || '' }, 90000 /* ★0927 慢 RPC 大超时；0930 放宽 90s：冷启动恢复多标签可超 30s（按钮超时=又一个"点了没反应"） */)
    browserStore.onStatusFrame('default', v || { connected: true })
    b.status = mode === 'headed' ? '已启动（有头窗口）' : '已启动'
  } catch (e: any) {
    b.status = '启动失败：' + String(e?.message || e)
    notificationsStore.pushSystem({ title: t('settings.browser.start'), message: t('settings.notif.browserStartFail'), level: 'warning', category: 'error' })
  }
}

async function browserClose() {
  if (!chatStore.wsConnected) return
  try { await chatStore.bridgeRpc('browser.close') }
  catch (e) { swallowed('内置浏览器关闭失败（界面已清空，但后端浏览器可能仍在运行）', e) }
  browserStore.resetConv('default') /* ★0930：reset() 是空垫片（状态不复位）；close 后要把 default 桶清掉 */
  browserCookies.value = []
  browserCookiesLoaded.value = false
}

async function browserLoadCookies() {
  if (!chatStore.wsConnected) return
  try { const v = await chatStore.bridgeRpc('browser.cookiesList'); browserCookies.value = Array.isArray(v?.cookies) ? v.cookies : []; browserCookiesLoaded.value = true } catch { /* ignore */ }
}

async function browserClearCookies() {
  if (!chatStore.wsConnected) return
  try { await chatStore.bridgeRpc('browser.cookiesClear') }
  catch (e) { swallowed('内置浏览器清 Cookie 失败（列表已清空，后端可能仍留着）', e) }
  browserCookies.value = []
}

// 打开"浏览器"设置页拉权威参数 + 自动拉 cookie（0908③：此前 cookie 要点一次"刷新"才显示，
// 且后端旧实现不带 sessionId 只查未启动的 default 实例=恒 0；后端现已聚合所有会话实例）
watch(activeTab, (v) => { if (v === 'browser') { void browserStore.loadSettings(bRpc); void browserLoadCookies() } }, { immediate: true })

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
          class="relative settings-dock w-[850px] max-w-[95vw] h-[78vh] bg-white rounded-[20px] shadow-[0_24px_70px_-20px_rgba(0,0,0,0.25)] border-[1.5px] border-gray-200 overflow-hidden flex flex-col dark:bg-gray-900 dark:border-gray-800"
        >
          <!-- 头部（0904 定稿：标题无线；分隔线由下方 tab 区底部承担——设置页 tab 在左栏，线落在左栏右缘） -->
          <div class="px-6 pt-6 pb-5 shrink-0">
            <h2 class="text-base font-bold text-gray-900 tracking-tight dark:text-gray-100">{{ t('settings.title') }}</h2>
          </div>

          <!-- 主体：左侧导航 + 右侧内容 -->
          <div class="flex flex-1 min-h-0 border-t-[1.5px] border-gray-100 dark:border-gray-800">
            <!-- 左侧导航：垂直分段切换（plain=无轨道灰底，黑胶囊滑块直接贴白底；px-3 保证胶囊左右留白对称） -->
            <div class="settings-nav w-[172px] shrink-0 border-r border-gray-100 py-3 px-3 overflow-y-auto custom-scroll dark:border-gray-800" :class="{ 'sm-hide': smEntered }">
              <SegTabs
                vertical
                plain
                size="md"
                :model-value="activeTab"
                @update:model-value="activeTab = $event; smEntered = true"
                :options="tabs.map(tb => ({ id: tb.id, label: t('settings.tabs.' + tb.id), icon: tb.icon }))"
              />
            </div>

            <!-- 右侧内容 -->
            <div class="flex-1 min-w-0 overflow-y-auto custom-scroll p-6" :class="{ 'sm-sub': !smEntered }">
              <button class="sm-back" @click="smEntered = false"><i class="fas fa-arrow-left"></i><span>{{ t('settings.back') }}</span></button>
              <!-- ============ 通用 ============ -->
              <div v-if="activeTab === 'general'">
                <div class="mb-6">
                  <h3 class="text-sm font-[640] text-gray-900 mb-3 dark:text-gray-100 flex items-center gap-1.5">{{ t('settings.general.userInfo') }}<HintTip :text="t('settings.general.userInfoHint')" /></h3>
                  <div class="flex items-center gap-2">
                    <span class="text-xs text-gray-500">{{ t('settings.general.name') }}</span>
                    <input v-model="generalDraft.userName" class="bg-gray-50 border border-gray-200 rounded-lg px-3 py-1.5 text-xs text-gray-800 dark:bg-gray-700 dark:border-gray-600 dark:text-gray-100 outline-none focus:border-gray-400 w-32" :placeholder="t('settings.general.name')" />
                  </div>
                </div>

                <div class="mb-6">
                  <h3 class="text-sm font-[640] text-gray-900 mb-3 dark:text-gray-100 flex items-center gap-1.5">{{ t('settings.general.storage') }}<HintTip :text="t('settings.general.storageHint')" /></h3>
                  <div class="flex items-center gap-2 px-3.5 py-2.5 rounded-xl bg-gray-50 dark:bg-gray-800 mb-2">
                    <i class="fas fa-folder text-gray-400 text-xs"></i>
                    <span class="text-[13px] text-gray-700 dark:text-gray-200 flex-1 break-all">{{ settingsStore.storagePath }}</span>
                  </div>
                  <div class="flex gap-2">
                    <button @click="changeStorageDir" class="btn btn-secondary btn-sm">{{ t('settings.general.changeDir') }}</button>
                    <button @click="openStorageFolder" class="btn btn-secondary btn-sm">{{ t('settings.general.openFolder') }}</button>
                  </div>
                </div>

                <!-- 0913：删除两个无实际功能的设置项（会话标题生成 / 自动修复——前后端零消费） -->

                <!-- ★ 0921z：技能开关**已搬到「技能仓库」**（SkillsModal）——需求要求开关跟着技能走。
                     这里不再渲染技能分区；设置键（skillAutoSelect / disabledSkills）仍在上面的 CTX_RESET_KEYS 里
                     参与「恢复默认」，后端白名单同样是这两个字段。 -->
                <div class="mb-6">
                  <h3 class="text-sm font-[640] text-gray-900 mb-3 dark:text-gray-100">{{ t('settings.general.contextMgmt') }}</h3>
                  <div class="flex items-center justify-between gap-3 px-3.5 py-2.5 rounded-xl bg-gray-50 dark:bg-gray-800 mb-2">
                    <div class="flex-1 min-w-0">
                      <span class="text-[13px] text-gray-700 dark:text-gray-200">{{ t('settings.general.autoCompact') }}</span>
                      <HintTip :text="t('settings.general.autoCompactHint')" />
                    </div>
                    <BwSwitch :model-value="generalDraft.contextCompaction" @update:model-value="(v: boolean) => (generalDraft.contextCompaction = v)" />
                  </div>
                  <!-- 0910 压缩百分比：仅在压缩开启时显示。触发=估算占用达窗口该比例才折旧轮；留存=压缩后保留最近该比例的整轮 -->
                  <template v-if="generalDraft.contextCompaction">
                    <div class="flex items-center justify-between gap-3 px-3.5 py-2.5 rounded-xl bg-gray-50 dark:bg-gray-800 mb-2">
                      <div class="flex-1 min-w-0">
                        <span class="text-[13px] text-gray-700 dark:text-gray-200">{{ t('settings.general.compactTrigger') }}</span>
                        <HintTip :text="t('settings.general.compactTriggerHint')" />
                      </div>
                      <div class="flex items-center gap-2 shrink-0">
                        <input type="range" min="30" max="80" step="5" v-model.number="generalDraft.contextCompactThresholdPct" class="nis-range w-28" />
                        <span class="text-[12px] text-gray-600 dark:text-gray-300 tabular-nums w-9 text-right">{{ generalDraft.contextCompactThresholdPct }}%</span>
                      </div>
                    </div>
                  </template>
                  <!-- 0911：以下条目与"是否开启压缩"无关，移出压缩 v-if——压缩关掉时护栏仍要可调 -->
                  <!-- 0910 三批⑤：文件变更历史配额（按对话计，互不挤占） -->
                  <div class="flex items-center justify-between gap-3 px-3.5 py-2.5 rounded-xl bg-gray-50 dark:bg-gray-800 mb-2">
                    <div class="flex-1 min-w-0">
                      <span class="text-[13px] text-gray-700 dark:text-gray-200">{{ t('settings.general.histMaxTitle') }}</span>
                      <HintTip :text="t('settings.general.histMaxHint')" />
                    </div>
                    <div class="flex items-center gap-2 shrink-0">
                      <input type="range" min="50" max="1000" step="50" v-model.number="generalDraft.historyMaxPerSession" class="nis-range w-28" />
                      <span class="text-[12px] text-gray-600 dark:text-gray-300 tabular-nums w-12 text-right">{{ generalDraft.historyMaxPerSession }}</span>
                    </div>
                  </div>
                  <!-- 0911 反馈：历史占用与自动清理（记录各自存于各工作区；超阈值按最旧优先裁剪） -->
                  <div class="px-3.5 py-2.5 rounded-xl bg-gray-50 dark:bg-gray-800 mb-2">
                    <div class="flex items-center justify-between gap-3">
                      <div class="flex-1 min-w-0">
                        <span class="text-[13px] text-gray-700 dark:text-gray-200">{{ t('settings.general.histCleanTitle') }}</span>
                        <HintTip :text="t('settings.general.histCleanHint')" />
                        <span class="text-[11px] text-gray-400 block mt-0.5">{{ t('settings.general.histUsageLabel') }}<span class="text-gray-600 dark:text-gray-300 font-medium tabular-nums">{{ historyStatsLoading ? '统计中…' : historyStatsText }}</span><span v-if="cleanResult" class="ml-1.5" :class="cleanResult.startsWith('已清理') ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500'">{{ cleanResult }}</span></span>
                      </div>
                      <BwSwitch :model-value="generalDraft.historyAutoCleanEnabled" @update:model-value="(v: boolean) => (generalDraft.historyAutoCleanEnabled = v)" />
                    </div>
                    <div v-if="generalDraft.historyAutoCleanEnabled" class="mt-2 pt-2 border-t border-gray-200/70 dark:border-gray-700">
                      <div class="flex items-center justify-between gap-3 mb-2">
                        <span class="text-[12px] text-gray-600 dark:text-gray-300 shrink-0">{{ t('settings.general.histThreshold') }}</span>
                        <div class="flex items-center gap-2 shrink-0">
                          <input type="range" min="100" max="10000" step="100" v-model.number="generalDraft.historyAutoCleanThresholdMb" class="nis-range w-28" />
                          <span class="text-[12px] text-gray-600 dark:text-gray-300 tabular-nums w-16 text-right">{{ generalDraft.historyAutoCleanThresholdMb }} MB</span>
                        </div>
                      </div>
                      <div class="flex items-center justify-between gap-3 mb-2">
                        <span class="text-[12px] text-gray-600 dark:text-gray-300 shrink-0">{{ t('settings.general.histPct') }}</span>
                        <div class="flex items-center gap-2 shrink-0">
                          <input type="range" min="5" max="90" step="5" v-model.number="generalDraft.historyAutoCleanPct" class="nis-range w-28" />
                          <span class="text-[12px] text-gray-600 dark:text-gray-300 tabular-nums w-16 text-right">{{ generalDraft.historyAutoCleanPct }}%</span>
                        </div>
                      </div>
                      <div class="flex items-center justify-between gap-3">
                        <span class="text-[11px] text-gray-400">{{ t('settings.general.histCleanNowHint') }}</span>
                        <button @click="manualCleanHistory" :disabled="historyCleaning" class="btn btn-secondary btn-xs shrink-0 disabled:opacity-50">
                          {{ historyCleaning ? t('settings.general.histCleaning') : t('settings.general.histCleanNow') }}
                        </button>
                      </div>
                    </div>
                  </div>
                  <!-- 0911：护栏组（主 agent 级：续跑步数/预算；成员级：单次运行上限）——选「不设限」时给出轻提示 -->
                  <div class="flex items-center justify-between gap-3 px-3.5 py-2.5 rounded-xl bg-gray-50 dark:bg-gray-800 mb-2">
                    <div class="flex-1 min-w-0">
                      <span class="text-[13px] text-gray-700 dark:text-gray-200">{{ t('settings.general.roundsTitle') }}</span>
                      <HintTip :text="generalDraft.autoContinueRounds === 0 ? t('settings.general.roundsUnlimitedHint') : t('settings.general.roundsHint')" />
                    </div>
                    <MiniSelect
                      :model-value="String(generalDraft.autoContinueRounds ?? 0)"
                      :options="genRoundOptions"
                      width="w-[132px]"
                      @update:model-value="(v: string) => (generalDraft.autoContinueRounds = Number(v))"
                    />
                  </div>
                  <div class="flex items-center justify-between gap-3 px-3.5 py-2.5 rounded-xl bg-gray-50 dark:bg-gray-800 mb-2">
                    <div class="flex-1 min-w-0">
                      <span class="text-[13px] text-gray-700 dark:text-gray-200">{{ t('settings.general.budgetTitle') }}</span>
                      <HintTip :text="generalDraft.turnTokenBudget === 0 ? t('settings.general.budgetUnlimitedHint') : t('settings.general.budgetHint')" />
                    </div>
                    <MiniSelect
                      :model-value="String(generalDraft.turnTokenBudget ?? 0)"
                      :options="genBudgetOptions"
                      width="w-[150px]"
                      @update:model-value="(v: string) => (generalDraft.turnTokenBudget = Number(v))"
                    />
                  </div>
                  <div class="flex items-center justify-between gap-3 px-3.5 py-2.5 rounded-xl bg-gray-50 dark:bg-gray-800 mb-2">
                    <div class="flex-1 min-w-0">
                      <span class="text-[13px] text-gray-700 dark:text-gray-200">{{ t('settings.general.memberLimitTitle') }}</span>
                      <HintTip :text="generalDraft.memberRunLimitMinutes === 0 ? t('settings.general.memberLimitUnlimitedHint') : t('settings.general.memberLimitHint')" />
                    </div>
                    <MiniSelect
                      :model-value="String(generalDraft.memberRunLimitMinutes ?? 0)"
                      :options="genMemberLimitOptions"
                      width="w-[132px]"
                      @update:model-value="(v: string) => (generalDraft.memberRunLimitMinutes = Number(v))"
                    />
                  </div>
                  <!-- 0911 三批：成员巡检官（方向检测）——与看门狗（死活）配套；默认开，规则预筛零成本 -->
                  <div class="flex items-center justify-between gap-3 px-3.5 py-2.5 rounded-xl bg-gray-50 dark:bg-gray-800 mb-2">
                    <div class="flex-1 min-w-0">
                      <span class="text-[13px] text-gray-700 dark:text-gray-200">{{ t('settings.general.inspectorTitle') }}</span>
                      <HintTip :text="t('settings.general.inspectorHint')" />
                    </div>
                    <BwSwitch :model-value="generalDraft.memberInspector" @update:model-value="(v: boolean) => (generalDraft.memberInspector = v)" />
                  </div>
                  <div class="flex items-center justify-between gap-3 px-3.5 py-2.5 rounded-xl bg-gray-50 dark:bg-gray-800">
                    <div class="flex-1 min-w-0">
                      <span class="text-[13px] text-gray-700 dark:text-gray-200">{{ t('settings.general.exportArchive') }}</span>
                      <HintTip :text="t('settings.general.exportArchiveHint')" />
                    </div>
                    <BwSwitch :model-value="generalDraft.archiveTranscriptMd" @update:model-value="(v: boolean) => (generalDraft.archiveTranscriptMd = v)" />
                  </div>
                  <!-- 0911 反馈：上下文管理「恢复默认」（二次确认，仅重置本区块，不碰其他通用设置） -->
                  <div class="flex items-center justify-between gap-3 px-3.5 py-2.5 rounded-xl bg-gray-50 dark:bg-gray-800 mt-2">
                    <div class="flex-1 min-w-0">
                      <span class="text-[13px] text-gray-700 dark:text-gray-200">{{ t('settings.general.resetContextDefaults') }}</span>
                      <HintTip :text="t('settings.general.resetContextDefaultsHint')" />
                      <span v-if="ctxResetDone" class="ml-1.5 text-[11px] text-emerald-600 dark:text-emerald-400">{{ t('settings.general.resetContextDone') }}</span>
                    </div>
                    <button class="btn btn-secondary btn-sm shrink-0" @click="ctxResetConfirm = true">{{ t('settings.general.resetContextDefaults') }}</button>
                  </div>
                </div>

                <!-- ★ 0923（用户定案）：文件读取 —— AI 读文件的默认上限（0=自动，不锁死） -->
                <div class="mb-6">
                  <h3 class="text-sm font-[640] text-gray-900 mb-3 dark:text-gray-100 flex items-center gap-1.5">{{ t('settings.general.fsReadSection') }}<HintTip :text="t('settings.general.fsReadMaxCharsHint')" /></h3>
                  <div class="flex items-center justify-between gap-3 px-3.5 py-2.5 rounded-xl bg-gray-50 dark:bg-gray-800">
                    <div class="flex-1 min-w-0">
                      <span class="text-[13px] text-gray-700 dark:text-gray-200">{{ t('settings.general.fsReadMaxChars') }}</span>
                    </div>
                    <MiniSelect
                      :model-value="String(settingsStore.general.fsReadMaxChars || 0)"
                      :options="genFsReadOptions"
                      width="w-[132px]"
                      @update:model-value="(v: string) => settingsStore.setGeneral('fsReadMaxChars', Number(v))"
                    />
                  </div>
                </div>

                <!-- ★ 0923（用户定案）：后台任务 —— 任务跑完自动接着干（事件驱动续跑）+ 回访到点是否自动唤醒 -->
                <div class="mb-6">
                  <h3 class="text-sm font-[640] text-gray-900 mb-3 dark:text-gray-100 flex items-center gap-1.5">{{ t('settings.general.bgSection') }}<HintTip :text="t('settings.general.bgSectionHint')" /></h3>
                  <div class="flex items-center justify-between gap-3 px-3.5 py-2.5 rounded-xl bg-gray-50 dark:bg-gray-800 mb-2">
                    <div class="flex-1 min-w-0">
                      <span class="text-[13px] text-gray-700 dark:text-gray-200">{{ t('settings.general.bgAutoResume') }}</span>
                      <HintTip :text="t('settings.general.bgAutoResumeHint')" />
                    </div>
                    <BwSwitch :model-value="settingsStore.general.bgAutoResume !== false" @update:model-value="(v: boolean) => settingsStore.setGeneral('bgAutoResume', v)" />
                  </div>
                  <div class="flex items-center justify-between gap-3 px-3.5 py-2.5 rounded-xl bg-gray-50 dark:bg-gray-800 mb-2">
                    <div class="flex-1 min-w-0">
                      <span class="text-[13px] text-gray-700 dark:text-gray-200">{{ t('settings.general.bgAutoResumeMax') }}</span>
                      <HintTip :text="t('settings.general.bgAutoResumeMaxHint')" />
                    </div>
                    <MiniSelect
                      :model-value="String(settingsStore.general.bgAutoResumeMax || 3)"
                      :options="genBgResumeMaxOptions"
                      width="w-[110px]"
                      @update:model-value="(v: string) => settingsStore.setGeneral('bgAutoResumeMax', Number(v))"
                    />
                  </div>
                  <div class="flex items-center justify-between gap-3 px-3.5 py-2.5 rounded-xl bg-gray-50 dark:bg-gray-800">
                    <div class="flex-1 min-w-0">
                      <span class="text-[13px] text-gray-700 dark:text-gray-200">{{ t('settings.general.bgWatchAutoWake') }}</span>
                      <HintTip :text="t('settings.general.bgWatchAutoWakeHint')" />
                    </div>
                    <BwSwitch :model-value="settingsStore.general.bgWatchAutoWake !== false" @update:model-value="(v: boolean) => settingsStore.setGeneral('bgWatchAutoWake', v)" />
                  </div>

                <!-- ★1010h（已定案）：外部预设（codex/ACP）随消息附带 NIS 记忆/知识库召回背景段 -->
                <div class="flex items-center justify-between gap-3 px-3.5 py-2.5 rounded-xl bg-gray-50 dark:bg-gray-800">
                  <div class="flex-1 min-w-0">
                    <span class="text-[13px] text-gray-700 dark:text-gray-200">{{ t('settings.general.extPresetContext') }}</span>
                    <HintTip :text="t('settings.general.extPresetContextHint')" />
                  </div>
                  <BwSwitch :model-value="settingsStore.general.extPresetContext !== false" @update:model-value="(v: boolean) => settingsStore.setGeneral('extPresetContext', v)" />
                </div>
                </div>

                <!-- ★ 0923（用户定）：询问卡（AI 提问/等你选择的那张卡）超时行为 -->
                <div class="mb-6">
                  <h3 class="text-sm font-[640] text-gray-900 mb-3 dark:text-gray-100 flex items-center gap-1.5">{{ t('settings.general.hitlSection') }}<HintTip :text="t('settings.general.hitlSectionHint')" /></h3>
                  <div class="flex items-center justify-between gap-3 px-3.5 py-2.5 rounded-xl bg-gray-50 dark:bg-gray-800">
                    <div class="flex-1 min-w-0">
                      <span class="text-[13px] text-gray-700 dark:text-gray-200">{{ t('settings.general.questionTimeout') }}</span>
                      <HintTip :text="t('settings.general.questionTimeoutHint')" />
                    </div>
                    <MiniSelect
                      :model-value="String(settingsStore.general.questionTimeoutSec ?? 180)"
                      :options="genQuestionTimeoutOptions"
                      width="w-[132px]"
                      @update:model-value="(v: string) => settingsStore.setGeneral('questionTimeoutSec', Number(v))"
                    />
                  </div>
                </div>

                <div class="mb-6">
                  <h3 class="text-sm font-[640] text-gray-900 mb-3 dark:text-gray-100 flex items-center gap-1.5">{{ t('settings.general.busySend') }}<HintTip :text="t('settings.general.busySendHint')" /></h3>
                  <div class="flex items-center justify-between gap-3 px-3.5 py-2.5 rounded-xl bg-gray-50 dark:bg-gray-800">
                    <div class="flex-1 min-w-0">
                      <span class="text-[13px] text-gray-700 dark:text-gray-200">{{ t('settings.general.busySendDefault') }}</span>
                      <HintTip :text="t('settings.general.busySendKeys')" />
                    </div>
                    <BwSeg :model-value="generalDraft.busySendMode" :options="['steer', 'queue']" :labels="[t('settings.general.busySendSteer'), t('settings.general.busySendQueue')]" @update:model-value="(v: string) => (generalDraft.busySendMode = v === 'steer' ? 'steer' : 'queue')" />
                  </div>
                  <!-- ★0927 N1：按「停止」时，队里排着的消息怎么办（默认 continue=继续按顺序发；pause=一起按住，界面给「继续发送」）。
                       丙（队里只有 1 条 → 退回输入框）是行业主流（pi 官方 TUI / Claude Code），无条件生效，不用设置。 -->
                  <div class="flex items-center justify-between gap-3 px-3.5 py-2.5 rounded-xl bg-gray-50 dark:bg-gray-800 mt-2">
                    <div class="flex-1 min-w-0">
                      <span class="text-[13px] text-gray-700 dark:text-gray-200">{{ t('settings.general.cancelQueue') }}</span>
                      <HintTip :text="t('settings.general.cancelQueueHint')" />
                    </div>
                    <BwSeg
                      :model-value="String(settingsStore.general.cancelQueueMode ?? 'continue')"
                      :options="['continue', 'pause']"
                      :labels="[t('settings.general.cancelQueueContinue'), t('settings.general.cancelQueuePause')]"
                      @update:model-value="(v: string) => settingsStore.setGeneral('cancelQueueMode', v === 'pause' ? 'pause' : 'continue')"
                    />
                  </div>
                </div>

                <!-- 0913：删除「日志级别」（前后端零消费，选哪档都不影响） -->

                <div class="mb-6">
                  <h3 class="text-sm font-[640] text-gray-900 mb-3 dark:text-gray-100 flex items-center gap-1.5">{{ t('settings.general.shortcuts') }}<HintTip :text="t('settings.general.shortcutHint')" /></h3>
                  <div
                    v-for="sc in shortcutItems"
                    :key="sc.key"
                    class="flex items-center justify-between gap-3 px-3.5 py-2.5 rounded-xl bg-gray-50 dark:bg-gray-800 mb-2"
                  >
                    <span class="text-[13px] text-gray-700 dark:text-gray-200">{{ sc.label }}</span>
                    <button
                      @click="startEditShortcut(sc.key)"
                      :class="['px-3 py-1 rounded-lg border text-xs transition-colors min-w-[90px] text-center', editingShortcut === sc.key ? 'border-blue-400 bg-blue-50 text-blue-600' : 'border-gray-300 text-gray-600 hover:bg-gray-50']"
                    >
                      {{ editingShortcut === sc.key ? t('settings.general.pressKeys') : settingsStore.shortcuts[sc.key] }}
                    </button>
                  </div>
                </div>

                <!-- 命令终端（0914）：AI 命令工具使用哪个 Shell -->
                <div class="flex items-center justify-between gap-3 px-3.5 py-2.5 rounded-xl bg-gray-50 dark:bg-gray-800 mb-3">
                  <div class="flex-1 min-w-0">
                    <span class="text-[13px] text-gray-700 dark:text-gray-200">{{ t('settings.general.cmdShell') }}</span>
                    <p class="text-[10px] text-gray-400 dark:text-gray-500 mt-0.5">{{ t('settings.general.cmdShellHint') }}</p>
                  </div>
                  <MiniSelect
                    :model-value="settingsStore.general.cmdShell"
                    @update:model-value="settingsStore.setCmdShell($event)"
                    :options="cmdShellOptions"
                    class="shrink-0"
                    width="w-[180px]"
                  />
                </div>

                <!-- 软件环境 -->
                <div class="mb-2 mt-6">
                  <h3 class="text-sm font-[640] text-gray-900 mb-3 dark:text-gray-100 flex items-center gap-1.5">{{ t('settings.general.env') }}<HintTip :text="t('settings.general.envHint')" /></h3>

                  <!-- 安装目录 -->
                  <div class="flex items-center justify-between gap-3 px-3.5 py-2.5 rounded-xl bg-gray-50 dark:bg-gray-800 mb-3">
                    <div class="flex-1 min-w-0">
                      <span class="text-[13px] text-gray-700 dark:text-gray-200">{{ t('settings.general.envDir') }}</span>
                      <p class="text-[10px] text-gray-400 dark:text-gray-500 mt-0.5 truncate">{{ envDirText }}</p>
                    </div>
                    <button @click="chooseEnvDir" class="btn btn-secondary btn-sm shrink-0">{{ t('settings.general.envChooseDir') }}</button>
                  </div>

                  <!-- 0917：重扫 + 一键安装缺失项（与引导页「环境检测」同一份口径/文案） -->
                  <div class="flex items-center gap-2 mb-3">
                    <button @click="refreshEnvStatus" :disabled="envScanning" class="btn btn-secondary btn-sm shrink-0">
                      {{ envScanning ? t('onboarding.envcheck.scanning') : t('onboarding.envcheck.rescan') }}
                    </button>
                    <button
                      v-if="envMissingCount > 0"
                      @click="installAllEnv"
                      :disabled="envInstallAllBusy"
                      class="btn btn-primary btn-sm shrink-0"
                    >{{ t('onboarding.envcheck.installAll', { n: envMissingCount }) }}</button>
                    <span v-else class="text-[11px] text-green-600">{{ t('onboarding.envcheck.allReady') }}</span>
                  </div>

                  <!-- 环境列表 -->
                  <div v-for="env in envItems" :key="env.id" class="px-3.5 py-2.5 rounded-xl bg-gray-50 dark:bg-gray-800 mb-2">
                    <div class="flex items-center justify-between gap-3">
                      <div class="flex items-center gap-3 min-w-0">
                        <div class="w-8 h-8 rounded-lg bg-gray-50 flex items-center justify-center shrink-0">
                          <i :class="[env.icon, 'text-[13px] text-gray-500']"></i>
                        </div>
                        <div class="min-w-0">
                          <div class="flex items-center gap-1.5 flex-wrap">
                            <span class="text-[13px] text-gray-700 dark:text-gray-200">{{ env.name }}</span>
                            <span v-if="envMetaMap[env.id]?.version" class="text-[10px] text-gray-400 tabular-nums">{{ envMetaMap[env.id]?.version }}</span>
                            <span v-if="envMetaMap[env.id]?.sizeBytes" class="text-[10px] text-gray-400">{{ t('onboarding.envcheck.sizeApprox', { size: fmtEnvSize(envMetaMap[env.id]?.sizeBytes || 0) }) }}</span>
                            <!-- 0917：应用自带的运行时（node）单独标「自带」，不提示用户去装 -->
                            <!-- 1010 UI②：来源/去向徽章统一弱化成同一形状的中性小徽章（env-src-chip）——
                                 色彩层级收敛为「状态/操作=主色，来源徽章=中性」，别再一绿一蓝一紫 -->
                            <span
                              v-if="envMetaMap[env.id]?.bundled"
                              class="env-src-chip"
                            >{{ t('settings.env.bundled') }}</span>
                            <!-- 0921d：来源标识 —— 扫到「机器上本来就有」的项，明确标出来（且不给卸载） -->
                            <span
                              v-else-if="settingsStore.envStates[env.id] === 'installed' && envMetaMap[env.id]?.source === 'system'"
                              class="env-src-chip"
                              :title="t('settings.env.srcSystemTip')"
                            >{{ t('settings.env.srcSystem') }}</span>
                            <!-- ★1010-D②（用户本轮）：NIS 安装项的「NIS 安装（可卸载）」徽章整个去掉（左簇不标来源，状态/卸载看右侧）。
                                 该分支删掉后，去向徽章（仅 C 盘/存储目录）必须显式限定「未安装才显示」，免得已装项掉进去向分支 -->
                            <span
                              v-else-if="settingsStore.envStates[env.id] !== 'installed'"
                              class="env-src-chip"
                              :class="envMetaMap[env.id]?.mustC ? 'is-warn' : ''"
                            >{{ envMetaMap[env.id]?.mustC ? t('onboarding.envcheck.onlyC') : t('onboarding.envcheck.toStorage') }}</span>
                          </div>
                          <p class="text-[10px] text-gray-400 dark:text-gray-500 mt-0.5 truncate" :title="envMetaMap[env.id]?.note || env.desc">{{ envMetaMap[env.id]?.note || env.desc }}</p>
                        </div>
                      </div>
                      <!-- 右侧动作组（已安装项带「卸载」——先点一次进入确认态，再点执行） -->
                      <!-- 1010 UI②：右侧统一为「状态胶囊（主色）+ 操作按钮（.btn 体系）」，env-act-slot 统一高度/基线 -->
                      <div class="flex items-center gap-2 shrink-0">
                        <button
                          v-if="settingsStore.envStates[env.id] === 'installing'"
                          class="env-act-slot env-act-quiet cursor-default"
                          :title="envJobInfo[env.id]?.phase || ''"
                        >{{ fmtStage(envJobInfo[env.id]?.stage || 'prep') }}<span v-if="(envJobInfo[env.id]?.percent ?? -1) >= 0"> · {{ envJobInfo[env.id].percent }}%</span></button>
                        <button
                          v-else-if="settingsStore.envStates[env.id] === 'uninstalling'"
                          class="env-act-slot env-act-quiet cursor-default"
                        >{{ t('settings.general.envUninstalling') }}</button>
                        <template v-else-if="settingsStore.envStates[env.id] === 'installed'">
                          <span v-if="envMetaMap[env.id]?.bundled" class="env-act-slot env-status-pill cursor-default">{{ t('settings.env.bundled') }}</span>
                          <!-- 1010-D②③（用户本轮）：非 NIS 安装（系统已装）→「系统已装」徽章放大到与「已安装」按钮完全同尺寸（env-act-slot）充当状态位；
                               「已安装」状态按钮去掉，右侧只留该徽章（这类本来就没有卸载按钮） -->
                          <span
                            v-else-if="envMetaMap[env.id]?.source === 'system'"
                            class="env-act-slot env-src-badge cursor-default"
                            :title="t('settings.env.srcSystemTip')"
                          >{{ t('settings.env.srcSystem') }}</span>
                          <template v-else>
                            <span class="env-act-slot env-status-pill cursor-default">{{ t('settings.general.envReinstall') }}</span>
                            <!-- 0921d：只有「NIS 装的」才给卸载入口；系统已有/应用自带的 → 直接不显示（不可用就别摆着） -->
                            <button
                              v-if="envMetaMap[env.id]?.removable"
                              class="btn btn-sm transition-colors"
                              :class="envUninstallArmed === env.id ? 'btn-danger' : 'btn-secondary'"
                              @click="armUninstall(env.id)"
                            >{{ envUninstallArmed === env.id ? t('settings.general.envUninstallConfirm') : t('settings.general.envUninstall') }}</button>
                          </template>
                        </template>
                        <button
                          v-else
                          @click="installEnv(env.id)"
                          class="btn btn-primary btn-sm shrink-0"
                        >{{ t('settings.general.envInstall') }}</button>
                      </div>
                    </div>
                    <!-- 0918 安装进度（#6 真进度条）：阶段（下载中/安装中）+ 进度条 + 百分比 + 已下载量 + 网速 + 剩余时间 -->
                    <div v-if="settingsStore.envStates[env.id] === 'installing'" class="mt-2">
                      <div class="flex items-center gap-2 text-[10px] text-gray-400 mb-1">
                        <span class="shrink-0 font-[560] text-gray-500">{{ fmtStage(envJobInfo[env.id]?.stage || 'prep') }}</span>
                        <span class="truncate flex-1">{{ envJobInfo[env.id]?.phase || t('settings.env.installingPhase') }}</span>
                        <span v-if="fmtBytesPair(envJobInfo[env.id]?.bytes || 0, envJobInfo[env.id]?.totalBytes || 0)" class="tabular-nums shrink-0">{{ fmtBytesPair(envJobInfo[env.id]?.bytes || 0, envJobInfo[env.id]?.totalBytes || 0) }}</span>
                        <span v-if="(envJobInfo[env.id]?.percent ?? -1) >= 0" class="tabular-nums shrink-0">{{ envJobInfo[env.id].percent }}%</span>
                        <span v-if="fmtSpeed(envJobInfo[env.id]?.speedBps || 0)" class="tabular-nums shrink-0">{{ fmtSpeed(envJobInfo[env.id]?.speedBps || 0) }}</span>
                        <span v-if="fmtEta(envJobInfo[env.id]?.etaSec || 0)" class="tabular-nums shrink-0">{{ t('settings.env.etaLeft', { t: fmtEta(envJobInfo[env.id]?.etaSec || 0) }) }}</span>
                      </div>
                      <div class="env-progress" :class="{ 'is-indeterminate': (envJobInfo[env.id]?.percent ?? -1) < 0 }">
                        <div class="env-progress-fill" :style="{ width: ((envJobInfo[env.id]?.percent ?? -1) >= 0 ? envJobInfo[env.id].percent : 35) + '%' }"></div>
                      </div>
                    </div>
                  </div>
                </div>


                <!-- ★1013（已定案）：① 去掉「新会话默认模型」这一行 —— 全局模型现在**跟着用户在对话里选的模型走**；
                     ② 「后台模型」挪回「人格」页（用户："后台模型的位置拿回到人格里面吧"），这里不再重复渲染。 -->
              </div>

              <!-- ============ 供应商 ============ -->
              <div v-else-if="activeTab === 'providers'" class="h-full settings-body-providers">
                <div class="h-full overflow-y-auto custom-scroll px-6 py-5">
                  <!-- 页头：标题 + 已启用计数 -->
                  <div class="flex items-center justify-between mb-3">
                    <div>
                      <h3 class="text-sm font-[640] text-gray-900 dark:text-gray-100">{{ t('settings.providers.title') }}</h3>
                      <p class="text-xs text-gray-400 mt-0.5">{{ t('settings.providers.pageHint') }}</p>
                    </div>
                    <span class="text-[10px] text-gray-400 shrink-0">{{ t('settings.providers.enabledCount') }} {{ enabledProviders.length }}/{{ providersStore.ENABLED_MAX }}</span>
                  </div>

                  <!-- 0910 单列卡片流：点卡片就地展开配置（Key→URL+测试→高级(代理)→模型） -->
                  <!-- ★1010（用户："加上也行"）：供应商列表搜索 —— 20+ 家时按 名称 / ID / 地址 找；
                       少于 4 家不显示（省地方）。匹配规则同获取模型弹窗：大小写不敏感子串、空格=多词 AND。 -->
                  <div v-if="providerList.length > 3" class="relative mb-3">
                    <i class="fas fa-magnifying-glass absolute left-2.5 top-[9px] text-[11px] text-gray-400 pointer-events-none"></i>
                    <input
                      v-model="providerQuery"
                      type="text"
                      :placeholder="t('settings.providers.searchPlaceholder')"
                      class="w-full pl-7 pr-7 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700 text-[12px] text-gray-800 dark:text-gray-100 outline-none focus:border-gray-400"
                    />
                    <button
                      v-if="providerQuery"
                      type="button"
                      @click="providerQuery = ''"
                      :title="t('settings.providers.searchClear')"
                      class="absolute right-1.5 top-[5px] w-6 h-6 flex items-center justify-center rounded-md text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"
                    >✕</button>
                  </div>
                  <!-- ★1010：搜索无结果时明说（而不是让列表空着让人以为供应商丢了） -->
                  <div v-if="providerList.length && !filteredProviderList.length" class="pb-6 pt-2 text-center text-xs text-gray-400">{{ t('settings.providers.searchNoMatch', { q: providerQuery.trim() }) }}</div>

                  <div class="space-y-2">
                    <div
                      v-for="p in filteredProviderList"
                      :key="p.id"
                      :class="['rounded-2xl border transition-colors', provExpandedId === p.id ? 'border-gray-300 bg-white' : 'border-gray-200 bg-white hover:border-gray-300']"
                    >
                      <!-- 卡头（点击展开/收起） -->
                      <div class="flex items-center gap-3 px-4 py-3 cursor-pointer select-none" @click="expandProvider(p.id)">
                        <span :class="['w-2 h-2 rounded-full shrink-0', p.enabled ? 'bg-green-500' : 'bg-gray-300']"></span>
                        <!-- 0917：悬停头像出现「获取 logo」——从供应商地址抓站点图标换成头像。
                             0917c：内置供应商（自带 /providers-logo 官方图标）不给这个入口。 -->
                        <div
                          class="relative shrink-0"
                          @click.stop
                          @mouseenter="hasBundledLogo(p) || (logoHoverId = p.id)"
                          @mouseleave="logoFetchingId !== p.id && (logoHoverId = '')"
                        >
                          <VendorLogo :name="p.name" :src="p.logo" :size="32" />
                          <!-- 0925：获取中（logoFetchingId）时保持蒙层显示 —— 鼠标移走也不消失，直到成功/失败通知 -->
                          <button
                            v-show="(logoHoverId === p.id || logoFetchingId === p.id) && !hasBundledLogo(p)"
                            type="button"
                            class="absolute inset-0 flex items-center justify-center rounded-lg bg-black/55 text-white"
                            :title="t('settings.providers.fetchLogoTip')"
                            :disabled="logoFetchingId === p.id"
                            @click.stop="fetchProviderLogo(p)"
                          >
                            <!-- 0925：过程动画换成小放大镜循环扫视（替掉 fa-spinner 点点旋转，用户不喜欢） -->
                            <span v-if="logoFetchingId === p.id" class="logo-fetch-scan" aria-hidden="true"><i class="fas fa-search"></i></span>
                            <i v-else class="fas fa-image text-[11px]"></i>
                          </button>
                        </div>
                        <div class="flex-1 min-w-0">
                          <div class="flex items-center gap-2">
                            <span class="text-[13px] font-[530] text-gray-800 truncate">{{ p.name }}</span>
                            <span v-if="!p.enabled" class="text-[9px] px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-400 shrink-0">{{ t('settings.providers.disabled') }}</span>
                          </div>
                          <div class="text-[10px] text-gray-400 truncate mt-0.5">{{ p.base || t('settings.providers.noBase') }}</div>
                        </div>
                        <span class="text-[10px] text-gray-400 shrink-0 tabular-nums">{{ providersStore.modelIds(p.id).length }} {{ t('settings.providers.modelsUnit') }}</span>
                        <!-- 0917：启停开关上提到卡头 —— 折叠态就能直接开关，不用展开卡片 -->
                        <BwSwitch
                          class="shrink-0"
                          :model-value="p.enabled"
                          :title="t('settings.providers.enableSwitch')"
                          @click.stop
                          @update:model-value="toggleProviderEnabled(p.id)"
                        />
                        <button
                          type="button"
                          class="w-7 h-7 flex items-center justify-center rounded-lg text-gray-300 hover:text-gray-600 hover:bg-gray-100 transition-colors shrink-0"
                          :title="provExpandedId === p.id ? t('common.collapse') : t('common.expand')"
                          @click.stop="expandProvider(p.id)"
                        ><i class="fas fa-chevron-down text-[10px] transition-transform" :class="{ 'rotate-180': provExpandedId === p.id }"></i></button>
                      </div>

                      <!-- 0925：展开体改弹窗（需求要求："这些展开的内容也做成弹窗的样式"）——
                           点卡头打开模态配置弹窗，不再在卡片里内联长展开（模型多时把列表撑爆）。
                           内容整体搬进 Teleport，逻辑（provExpandedId/activeProvider 绑定）原样不动。 -->
                      <Teleport to="body">
                        <div
                          v-if="provExpandedId === p.id"
                          class="fixed inset-0 z-[9998] flex items-center justify-center py-6 px-4"
                          style="background: rgba(2,6,23,0.38)"
                          @click.self="expandProvider(p.id)"
                        >
                          <!-- ★ 0925c（反馈）：位置居中下移（原 pt-[7vh] 太靠上）+ **固定高度**
                               （正好显示全部信息 + 约 3 个模型），模型区单独内滚；
                               子弹窗（获取模型/编辑模型/删除确认）Teleport 到 body 后 z=10000 高于本弹窗。 -->
                          <div class="bg-white rounded-2xl shadow-2xl w-[640px] max-w-[94vw] h-[600px] max-h-[86vh] flex flex-col overflow-hidden">
                            <!-- 弹窗头：供应商图标 + 名称 + Base URL + 关闭 -->
                            <div class="px-5 pt-4 pb-3 flex items-start justify-between border-b border-gray-100 shrink-0">
                              <div class="flex items-center gap-2.5 min-w-0">
                                <VendorLogo :name="p.name" :src="p.logo" :size="28" />
                                <div class="min-w-0">
                                  <div class="text-[14px] font-[640] text-gray-900 truncate">{{ p.name }}</div>
                                  <div class="text-[10px] text-gray-400 truncate">{{ p.base || t('settings.providers.noBase') }}</div>
                                </div>
                              </div>
                              <button @click="expandProvider(p.id)" class="w-8 h-8 -mt-1 flex items-center justify-center rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors shrink-0">✕</button>
                            </div>
                            <div class="px-5 py-4 space-y-2 flex-1 overflow-y-auto custom-scroll">
                        <!-- ① API Key -->
                        <div class="flex items-center justify-between gap-3 px-3.5 py-2.5 rounded-xl bg-gray-50">
                          <div class="flex-1 min-w-0">
                            <span class="text-[13px] text-gray-700">API Key</span>
                            <HintTip :text="t('settings.providers.apiKeyHint')" />
                          </div>
                          <div class="flex items-center gap-1">
                            <!-- ★ 0925e（需求）：内置锁定供应商（OpenCode Zen 公共档）——
                                 Key/URL 不可写、不可查看（掩码+禁用），用户零配置直接用 -->
                            <input v-if="isLockedProvider(editingProvider?.id)" type="password" value="" placeholder="••••••••••" disabled class="bg-gray-100 rounded-lg px-3 py-1.5 text-xs text-gray-400 outline-none w-48 cursor-not-allowed" />
                            <template v-else>
                              <input v-model="editingApiKey" :type="showApiKey ? 'text' : 'password'" placeholder="sk-..." class="bg-white rounded-lg px-3 py-1.5 text-xs text-gray-800 outline-none focus:border-gray-400 w-48" />
                              <button
                                type="button"
                                @click="showApiKey = !showApiKey"
                                class="px-2 py-1.5 rounded-md text-[10px] text-gray-500 hover:bg-gray-200 transition-colors shrink-0"
                                :title="showApiKey ? t('settings.providers.hideKey') : t('settings.providers.showKey')"
                              >{{ showApiKey ? t('settings.providers.hideKey') : t('settings.providers.showKey') }}</button>
                            </template>
                          </div>
                        </div>
                        <!-- ② Base URL：格式示例+实时校验+测试连接同行（0910：测试从底部挪来，填完当场点） -->
                        <div class="px-3.5 py-2.5 rounded-xl bg-gray-50">
                          <div class="flex items-center justify-between gap-3">
                            <div class="flex-1 min-w-0">
                              <span class="text-[13px] text-gray-700">Base URL</span>
                              <HintTip :text="t('settings.providers.baseUrlHint')" />
                            </div>
                            <div class="flex items-center gap-1.5">
                              <!-- ★ 0925e：锁定供应商的 Base URL 同样不可写、不可查看 -->
                              <input
                                v-if="isLockedProvider(editingProvider?.id)"
                                type="password" value="" placeholder="••••••••••" disabled
                                class="bg-gray-100 rounded-lg px-3 py-1.5 text-xs text-gray-400 outline-none w-56 text-right cursor-not-allowed"
                              />
                              <input
                                v-else
                                v-model="providerBaseInput"
                                placeholder="https://api.example.com/v1"
                                @blur="normalizeProviderBase"
                                :class="['bg-white rounded-lg px-3 py-1.5 text-xs text-gray-800 outline-none focus:border-gray-400 w-56 text-right', urlInvalid ? 'border border-red-300' : '']"
                              />
                              <!-- 0917：删除「测试连接」按钮 —— 连通性改由每个模型行的「测试链接」承担，
                                   这一行的按钮语义重复且会误以为只测了地址。 -->
                            </div>
                          </div>
                          <div class="flex items-center justify-between gap-2 mt-1.5">
                            <span class="text-[10px] text-gray-300 font-mono truncate">{{ t('settings.providers.urlFormatHint') }}</span>
                            <span v-if="urlInvalid" class="text-[10px] text-red-500">{{ t('settings.providers.urlNoScheme') }}</span>
                          </div>
                        </div>
                        <!-- ②b 协议选择（0910）：决定请求走哪套适配器。openai 兼容（默认）/ Anthropic 原生 / Gemini 原生 -->
                        <div class="flex items-center justify-between gap-3 px-3.5 py-2.5 rounded-xl bg-gray-50">
                          <div class="flex-1 min-w-0">
                            <span class="text-[13px] text-gray-700">{{ t('settings.providers.protocol') }}</span>
                            <HintTip :text="t('settings.providers.protocolHint')" />
                          </div>
                          <SegTabs
                            :model-value="editingProvider?.protocol || 'openai-completions'"
                            :options="[
                              { id: 'openai-completions', label: t('settings.providers.protoOpenai') },
                              { id: 'anthropic-messages', label: t('settings.providers.protoAnthropic') },
                              { id: 'google-generative-ai', label: t('settings.providers.protoGoogle') },
                            ]"
                            size="xs"
                            @update:model-value="(v: string) => providersStore.setProviderProtocol(editingProvider?.id, v as any)"
                          />
                        </div>
                        <!-- ③ 网络代理（0925d 需求要求：原来折叠在「高级」里，改成常驻直接显示） -->
                        <div class="flex items-center justify-between gap-3 px-3.5 py-2.5 rounded-xl bg-gray-50">
                          <div class="flex-1 min-w-0">
                            <span class="text-[13px] text-gray-700">{{ t('settings.providers.proxy') }}</span>
                            <HintTip :text="t('settings.providers.proxyHint')" />
                          </div>
                          <input v-model="providerProxyInput" :placeholder="t('settings.providers.proxyPh')" @blur="saveProviderProxy" class="bg-white rounded-lg px-3 py-1.5 text-xs text-gray-800 outline-none focus:border-gray-400 w-56 text-right" />
                        </div>
                        <div class="flex gap-2 pt-1">
                          <button
                            v-if="!addModelOpen"
                            @click="addModelOpen = true"
                            class="flex-1 btn btn-secondary btn-sm"
                          >{{ t('settings.providers.addCustomModel') }}</button>
                          <button
                            @click="openFetchDialog"
                            class="flex-1 btn btn-secondary btn-sm"
                          >{{ t('settings.providers.fetchModels') }}</button>
                        </div>
                        <!-- 模型列表：无 API Key 时不显示预设列表（避免误导） -->
                        <div v-if="hasApiKey" class="pt-1">
                          <div class="flex items-center justify-between mb-2">
                            <h4 class="text-[12px] font-[640] text-gray-700">{{ t('settings.providers.models') }} <span class="font-[400] text-gray-400">· {{ enabledModelCount }}</span></h4>
                          </div>
                          <div class="space-y-1 max-h-[220px] overflow-y-auto custom-scroll pr-1">
                            <!-- 0909③：行+编辑面板成对（v-for 提到 template 层，面板才能引用 mm） -->
                            <template v-for="mm in (providersStore.models[editingProvider?.id] || [])" :key="mm.id">
                            <div
                              :class="['flex items-center gap-3 px-3.5 py-2 rounded-xl transition-colors', mm.enabled ? 'bg-white hover:bg-gray-50' : 'bg-gray-50 opacity-70']"
                            >
                              <VendorLogo :name="editingProvider?.name || ''" :src="editingProvider?.logo" :size="28" />
                              <div class="flex-1 min-w-0">
                                <div class="flex items-center gap-2">
                                  <span class="text-[13px] font-[530] text-gray-800 truncate" :title="mm.name">{{ mm.name }}</span>
                                  <span class="text-[10px] text-gray-400 truncate" :title="mm.id">{{ mm.id }}</span>
                                </div>
                                <div class="flex items-center gap-1.5 mt-0.5 flex-wrap">
                                  <span v-for="cap in mm.capabilities" :key="cap" class="text-[9px] px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-500">{{ capLabel(cap) }}</span>
                                  <!-- 0907 供应商C段：用户在获取弹窗勾过生图 → 紫 chip（capabilities 的 image 语义是输入，不混用） -->
                                  <span v-if="mm.outputModalities?.includes('image')" class="text-[9px] px-1.5 py-0.5 rounded-full bg-purple-50 text-purple-600">{{ t('settings.cap.gen') }}</span>
                                  <span class="text-[9px] text-gray-400">{{ fmtContext(mm.maxContext) }}</span>
                                  <!-- 0910：思考挡位徽标（非全四挡时显式标出可用清单，如 zai 系 Low/High/Max） -->
                                  <span v-if="providersStore.modelEfforts(editingProvider?.id, mm.id).length && providersStore.modelEfforts(editingProvider?.id, mm.id).length < 4" class="text-[9px] px-1.5 py-0.5 rounded-full bg-blue-50 text-blue-500">{{ t('settings.cap.efforts') }}: {{ providersStore.modelEfforts(editingProvider?.id, mm.id).map(e => EFFORT_SHORT[e]).join('/') }}</span>
                                </div>
                              </div>
                              <BwSwitch :model-value="mm.enabled" @update:model-value="toggleModelEnabled(editingProvider?.id, mm.id)" />
                              <!-- 0913：测试连通性（开关与编辑之间）。0913b：换线性图标 + 中性 hover（原来实心图标+绿底观感差） -->
                              <button
                                @click="testModelRow(editingProvider?.id, mm.id)"
                                :disabled="!!testingModel[mm.id]"
                                class="w-6 h-6 flex items-center justify-center rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 dark:hover:text-gray-200 dark:hover:bg-gray-700 transition-colors shrink-0 disabled:opacity-60"
                                :title="t('settings.providers.testModel')"
                              >
                                <LoaderCircle v-if="testingModel[mm.id]" :size="13" :stroke-width="1.75" class="animate-spin" />
                                <Plug v-else :size="13" :stroke-width="1.75" />
                              </button>
                              <!-- 0909③：行内编辑入口（模态+上下文+挡位）。0910：✎/✕ 文本换统一 icon 方钮（与工具页同款圆形 hover） -->
                              <button
                                @click="startEditModel(mm)"
                                class="w-6 h-6 flex items-center justify-center rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 dark:hover:text-gray-200 dark:hover:bg-gray-700 transition-colors shrink-0"
                                :title="t('settings.providers.editModel')"
                              ><PenLine :size="13" :stroke-width="1.75" /></button>
                              <button
                                @click="providersStore.removeModel(editingProvider?.id, mm.id)"
                                class="w-6 h-6 flex items-center justify-center rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/25 transition-colors shrink-0"
                                :title="t('settings.providers.removeModel')"
                              ><X :size="13" :stroke-width="1.75" /></button>
                            </div>
                            <!-- 0909③：编辑面板（上下文裸 token 数 + 预设 chip + 模态勾选 + 0910 思考挡位），保存走 updateModel 同步后端 -->
                            </template>
                          </div>
                          <!-- 操作反馈：获取模型结果（测试连接反馈已挪到 URL 行内） -->
                          <div class="mt-1.5 text-[10px] min-h-[16px] text-gray-400">{{ syncPriceMsg }}</div>
                          <div v-if="addModelOpen" class="mt-3 p-3 bg-gray-50 rounded-xl space-y-2">
                            <div class="text-xs font-[640] text-gray-700">{{ t('settings.providers.addCustomModelTitle') }}</div>
                            <div class="grid grid-cols-2 gap-2">
                              <input v-model="newModel.id" :placeholder="t('settings.providers.modelIdPlaceholder')" class="col-span-2 bg-white rounded-lg px-3 py-1.5 text-xs outline-none focus:border-gray-400" />
                              <input v-model="newModel.name" :placeholder="t('settings.providers.displayName')" class="bg-white rounded-lg px-3 py-1.5 text-xs outline-none focus:border-gray-400" />
                              <input v-model.number="newModel.maxContext" :placeholder="t('settings.providers.contextPlaceholder')" class="bg-white rounded-lg px-3 py-1.5 text-xs outline-none focus:border-gray-400" />
                              <input v-model.number="newModel.inputPrice" type="number" step="0.01" :placeholder="t('settings.providers.inputPricePlaceholder')" class="bg-white rounded-lg px-3 py-1.5 text-xs outline-none focus:border-gray-400" />
                              <input v-model.number="newModel.outputPrice" type="number" step="0.01" :placeholder="t('settings.providers.outputPricePlaceholder')" class="bg-white rounded-lg px-3 py-1.5 text-xs outline-none focus:border-gray-400" />
                            </div>
                            <!-- 模型类型：文本/多模态/生图/视频（分段切换：黑胶囊滑块） -->
                            <SegTabs
                              v-model="newModel.modelKind"
                              :options="[{ id: 'text', label: t('settings.cap.text') }, { id: 'multimodal', label: t('settings.cap.multimodal') }, { id: 'image', label: t('settings.cap.image') }, { id: 'video', label: t('settings.cap.video') }]"
                            />
                            <div class="flex gap-2">
                              <button @click="submitAddModel" class="flex-1 btn btn-primary btn-sm">{{ t('settings.providers.add') }}</button>
                              <button @click="addModelOpen = false" class="flex-1 btn btn-secondary btn-sm">{{ t('settings.cancel') }}</button>
                            </div>
                          </div>
                        </div>
                        <!-- 未接入 API：提示先填 Key 或用「获取模型」拉取 -->
                        <div v-else class="rounded-xl bg-gray-50 py-8 text-center">
                          <p class="text-sm text-gray-400">{{ t('settings.providers.fillKeyFirst') }}</p>
                          <p class="text-[10px] text-gray-300 mt-1">{{ t('settings.providers.orFetchHint') }}</p>
                        </div>

                        <div class="flex items-center justify-between pt-1">
                          <!-- 0917：启停开关已上提到卡头；此处只留状态提示 -->
                          <span :class="['text-[11px] tabular-nums', p.enabled ? 'text-green-600' : 'text-gray-400']">
                            {{ p.enabled ? t('settings.providers.enabled') : t('settings.providers.disabled') }}
                          </span>
                          <button
                            @click="askRemoveProvider(p)"
                            class="btn btn-xs bg-red-50 text-red-600 hover:bg-red-100 transition-colors"
                          >{{ t('settings.providers.deleteProvider') }}</button>
                        </div>
                            </div>
                          </div>
                        </div>
                      </Teleport>
                    </div>
                  </div>

                  <!-- 添加自定义供应商（列表末尾虚线卡） -->
                  <button
                    v-if="!addProviderOpen"
                    @click="addProviderOpen = true"
                    class="w-full mt-3 px-2.5 py-2 rounded-xl border border-dashed border-gray-300 text-xs text-gray-500 hover:bg-gray-50 hover:text-gray-700 transition-colors"
                  >{{ t('settings.providers.addCustom') }}</button>
                  <div v-else class="mt-3 p-3 bg-gray-50 rounded-xl space-y-1.5">
                    <input v-model="newProvider.id" :placeholder="t('settings.providers.providerIdPlaceholder')" class="w-full bg-white rounded-lg px-2.5 py-1.5 text-xs outline-none focus:border-gray-400" />
                    <input v-model="newProvider.name" :placeholder="t('settings.providers.displayName')" class="w-full bg-white rounded-lg px-2.5 py-1.5 text-xs outline-none focus:border-gray-400" />
                    <input v-model="newProvider.base" :placeholder="t('settings.providers.baseUrlPlaceholder')" class="w-full bg-white rounded-lg px-2.5 py-1.5 text-xs outline-none focus:border-gray-400" />
                    <div class="flex gap-1.5">
                      <button @click="submitAddProvider" class="flex-1 btn btn-primary btn-xs">{{ t('settings.providers.add') }}</button>
                      <button @click="addProviderOpen = false" class="flex-1 btn btn-secondary btn-xs">{{ t('settings.cancel') }}</button>
                    </div>
                  </div>
                </div>

                <!-- 获取模型弹窗：拉取列表 → 勾选/全选 → 保存合并进模型表
                     ★ 0925c（截图实锤"被供应商详情页遮挡"）：Teleport 到 body + z=10000 ——
                     它从供应商详情弹窗（z=9998，body 级）里点开，原来留在 SettingsModal DOM 树里，
                     会被供应商弹窗的层叠上下文压住（z-[9999] 也救不了）。 -->
                <Teleport to="body">
                <Transition name="fade">
                  <div v-if="fetchDialogOpen" class="fixed inset-0 z-[10000] flex items-center justify-center bg-black/20" @click.self="fetchDialogOpen = false">
                    <div class="bg-white rounded-2xl shadow-2xl w-[700px] max-w-[94vw] max-h-[78vh] flex flex-col overflow-hidden">
                      <div class="px-6 pt-5 pb-3 flex items-start justify-between">
                        <div class="min-w-0">
                          <div class="text-[15px] font-[640] text-gray-900 truncate">{{ t('settings.providers.fetchModels') }} · {{ fetchProvider?.name || '—' }}</div>
                          <div class="text-[11px] text-gray-400 mt-1 truncate">{{ fetchNotice || t('settings.providers.fetchingModels') + '...' }}</div>
                        </div>
                        <button @click="fetchDialogOpen = false" class="w-8 h-8 -mt-1 flex items-center justify-center rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors shrink-0">✕</button>
                      </div>
                      <div class="flex-1 overflow-y-auto px-5 pb-3 min-h-[220px] custom-scroll">
                        <div v-if="fetchingModels" class="py-10 text-center text-xs text-gray-400">{{ t('settings.providers.fetchingModels') }}...</div>
                        <div v-else-if="fetchError" class="mx-1 my-3 px-4 py-3 rounded-xl bg-red-50 text-[11px] leading-relaxed text-red-600 whitespace-pre-line">
                          <i class="fas fa-triangle-exclamation mr-1"></i>{{ fetchError }}
                        </div>
                        <template v-else>
                          <div v-if="fetchedModels.length" class="sticky top-0 z-10 bg-white pt-1 pb-2">
                            <!-- ★1010（需求）：搜索筛选 —— 中转站上百个模型时按名字/ID 找 -->
                            <div class="relative pb-2">
                              <i class="fas fa-magnifying-glass absolute left-2.5 top-[9px] text-[11px] text-gray-400 pointer-events-none"></i>
                              <input
                                v-model="fetchQuery"
                                type="text"
                                :placeholder="t('settings.providers.fetchSearchPlaceholder')"
                                class="w-full pl-7 pr-7 py-1.5 rounded-lg border border-gray-200 text-[12px] text-gray-800 outline-none focus:border-gray-400"
                              />
                              <button
                                v-if="fetchQuery"
                                type="button"
                                @click="fetchQuery = ''"
                                :title="t('settings.providers.fetchSearchClear')"
                                class="absolute right-1.5 top-[5px] w-6 h-6 flex items-center justify-center rounded-md text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"
                              >✕</button>
                            </div>
                            <div class="flex items-center justify-between pb-2">
                              <span class="text-[11px] text-gray-400">
                                <template v-if="fetchQuery.trim()">{{ t('settings.providers.fetchFilteredCount', { n: filteredFetchedModels.length, t: fetchedModels.length }) }}</template>
                                <template v-else>{{ fetchedModels.length }} 个候选模型</template>
                              </span>
                              <span class="flex gap-3 text-[11px] text-gray-500">
                                <button @click="selectAllFetched" :title="fetchQuery.trim() ? t('settings.providers.fetchSelectScopeHint') : undefined" class="hover:text-gray-800 transition-colors">{{ t('common.selectAll') }}</button>
                                <button @click="deselectAllFetched" :title="fetchQuery.trim() ? t('settings.providers.fetchSelectScopeHint') : undefined" class="hover:text-gray-800 transition-colors">{{ t('common.deselectAll') }}</button>
                              </span>
                            </div>
                            <!-- 0923 表头：模型名称 / 输入 / 输出 / 上下文 / 视觉 / 推理 / 生图 / 来源（列宽与数据行严格一致） -->
                            <div class="grid grid-cols-[18px_minmax(0,1fr)_64px_64px_64px_34px_34px_34px_46px] items-center gap-x-2 px-2 pb-1.5 text-[10px] font-[640] text-gray-400">
                              <span></span>
                              <span>模型名称</span>
                              <span class="text-center">输入</span>
                              <span class="text-center">输出</span>
                              <span class="text-center">上下文</span>
                              <span class="text-center">视觉</span>
                              <span class="text-center">推理</span>
                              <span class="text-center">生图</span>
                              <span class="text-center">来源</span>
                            </div>
                          </div>
                          <div v-for="mid in filteredFetchedModels" :key="mid" class="grid grid-cols-[18px_minmax(0,1fr)_64px_64px_64px_34px_34px_34px_46px] items-center gap-x-2 px-2 py-2 rounded-xl hover:bg-gray-50 transition-colors">
                            <input type="checkbox" :checked="selectedFetchedModels.includes(mid)" @change="toggleFetchedModel(mid)" class="rounded border-gray-300 w-3.5 h-3.5" />
                            <span class="text-[12.5px] text-gray-700 truncate" :title="mid">{{ mid }}</span>
                            <!-- 0923：三列数值 chip（128K/1M 显示；点击下拉预设 + 自定义输入）。use-portal：下拉 Teleport 到 body，免被滚动容器裁掉 -->
                            <NumChip use-portal :model-value="fetchedPicks[mid]?.maxInput" :presets="IN_PRESETS" :disabled="!selectedFetchedModels.includes(mid)" :title="t('settings.providers.maxInputLabel')" @update:model-value="(v) => setFetchedNum(mid, 'maxInput', v)" />
                            <NumChip use-portal :model-value="fetchedPicks[mid]?.maxOutput" :presets="OUT_PRESETS" :disabled="!selectedFetchedModels.includes(mid)" :title="t('settings.providers.maxOutputLabel')" @update:model-value="(v) => setFetchedNum(mid, 'maxOutput', v)" />
                            <NumChip use-portal :model-value="fetchedPicks[mid]?.contextTokens" :presets="CTX_PRESETS" :disabled="!selectedFetchedModels.includes(mid)" :title="t('settings.cap.ctxHint')" @update:model-value="(v) => setFetchedNum(mid, 'contextTokens', v)" />
                            <!-- 模态列：只留复选框（含义见表头），顺序 视觉 / 推理 / 生图 -->
                            <label class="flex items-center justify-center cursor-pointer select-none" :class="{ 'opacity-40 pointer-events-none': !selectedFetchedModels.includes(mid) }" :title="t('settings.cap.readHint')">
                              <input type="checkbox" :checked="!!fetchedPicks[mid]?.vision" @change="toggleModelCap(mid, 'vision')" class="rounded border-gray-300 w-3.5 h-3.5" />
                            </label>
                            <label class="flex items-center justify-center cursor-pointer select-none" :class="{ 'opacity-40 pointer-events-none': !selectedFetchedModels.includes(mid) }" :title="t('settings.cap.think')">
                              <input type="checkbox" :checked="!!fetchedPicks[mid]?.reasoning" @change="toggleModelCap(mid, 'reasoning')" class="rounded border-gray-300 w-3.5 h-3.5" />
                            </label>
                            <label class="flex items-center justify-center cursor-pointer select-none" :class="{ 'opacity-40 pointer-events-none': !selectedFetchedModels.includes(mid) }" :title="t('settings.cap.gen')">
                              <input type="checkbox" :checked="!!fetchedPicks[mid]?.genImage" @change="toggleModelCap(mid, 'genImage')" class="rounded border-gray-300 w-3.5 h-3.5" />
                            </label>
                            <!-- 建议来源标签：dev=models.dev 官方 / manual=你已存手写 / inferred=名字推断 -->
                            <span
                              v-if="fetchedSug[mid]"
                              class="text-[9px] px-1 py-0.5 rounded-full shrink-0 text-center truncate"
                              :class="fetchedSug[mid].source === 'dev' ? 'bg-blue-50 text-blue-600' : fetchedSug[mid].source === 'manual' ? 'bg-emerald-50 text-emerald-600' : 'border border-dashed border-gray-300 text-gray-400'"
                            >{{ fetchedSug[mid].source === 'dev' ? t('settings.cap.srcDev') : fetchedSug[mid].source === 'manual' ? t('settings.cap.srcManual') : t('settings.cap.srcInferred') }}</span>
                          </div>
                          <!-- ★1010：搜索无结果时给明确反馈（而不是让列表空着让人以为没拉到模型） -->
                          <div v-if="fetchedModels.length && !filteredFetchedModels.length" class="py-8 text-center text-xs text-gray-400">{{ t('settings.providers.fetchNoMatch', { q: fetchQuery.trim() }) }}</div>
                          <div v-if="!fetchedModels.length" class="py-8 text-center text-xs text-gray-400">{{ t('settings.providers.noneFetched') }}</div>
                        </template>
                      </div>
                      <div class="px-6 py-4 flex items-center justify-between border-t border-gray-100">
                        <span class="text-[11px] text-gray-400">已选 {{ selectedFetchedModels.length }} 个</span>
                        <div class="flex gap-2">
                          <button @click="fetchDialogOpen = false" class="btn btn-secondary btn-sm">{{ t('settings.cancel') }}</button>
                          <button @click="saveFetchedModels" :disabled="!selectedFetchedModels.length" class="btn btn-primary btn-sm">{{ t('common.save') }}</button>
                        </div>
                      </div>
                    </div>
                  </div>
                </Transition>
                </Teleport>

                <!-- 0923：模型编辑弹窗（取代原行内展开的"抽屉"）——三个数值统一用 NumChip，留白更大、字更大
                     ★ 0925c：同样 Teleport 到 body + z=10000（同获取模型弹窗，防被供应商详情弹窗遮挡） -->
                <Teleport to="body">
                <Transition name="fade">
                  <div v-if="editingModelId && editingModel" class="fixed inset-0 z-[10000] flex items-center justify-center bg-black/20" @click.self="editingModelId = null">
                    <div class="bg-white rounded-2xl shadow-2xl w-[620px] max-w-[94vw] max-h-[86vh] flex flex-col overflow-hidden">
                      <div class="px-6 pt-5 pb-4 flex items-start justify-between">
                        <div class="min-w-0">
                          <div class="text-[15px] font-[640] text-gray-900 truncate" :title="editingModel.name || editingModel.id">{{ editingModel.name || editingModel.id }}</div>
                          <div class="text-[11px] text-gray-400 mt-1 truncate font-mono" :title="editingModel.id">{{ editingModel.id }} · {{ editingProvider?.name || '—' }}</div>
                        </div>
                        <button @click="editingModelId = null" class="w-8 h-8 -mt-1 flex items-center justify-center rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors shrink-0">✕</button>
                      </div>

                      <div class="flex-1 overflow-y-auto px-6 pb-5 space-y-4 custom-scroll">
                        <!-- 三个数值：上下文 / 输出上限 / 输入上限（点格子 = 下拉预设 + 自定义） -->
                        <div class="space-y-3">
                          <div class="flex items-center gap-3">
                            <div class="w-[92px] shrink-0 text-[13px] text-gray-700 flex items-center gap-1">{{ t('settings.providers.contextLabel') }}<HintTip :text="t('settings.cap.ctxHint')" /></div>
                            <div class="w-[104px]"><NumChip v-model="editDraft.maxContext" :presets="CTX_PRESETS" /></div>
                          </div>
                          <div class="flex items-center gap-3">
                            <div class="w-[92px] shrink-0 text-[13px] text-gray-700 flex items-center gap-1">{{ t('settings.providers.maxOutputLabel') }}<HintTip :text="t('settings.providers.maxOutputHint')" /></div>
                            <div class="w-[104px]"><NumChip v-model="editDraft.maxOutput" :presets="OUT_PRESETS" /></div>
                            <span class="text-[11px] text-gray-400">{{ t('settings.providers.maxOutputHint') }}</span>
                          </div>
                          <div class="flex items-center gap-3">
                            <div class="w-[92px] shrink-0 text-[13px] text-gray-700 flex items-center gap-1">{{ t('settings.providers.maxInputLabel') }}<HintTip :text="t('settings.providers.maxInputHint')" /></div>
                            <div class="w-[104px]"><NumChip v-model="editDraft.maxInput" :presets="IN_PRESETS" /></div>
                            <span class="text-[11px] text-gray-400">{{ t('settings.providers.maxInputHint') }}</span>
                          </div>
                        </div>

                        <!-- 模态：读图（视觉）/ 推理 / 生图 -->
                        <div class="pt-1">
                          <div class="text-[11px] font-[640] text-gray-400 mb-2.5">模态</div>
                          <div class="flex items-center gap-6">
                            <label class="flex items-center gap-2 text-[13px] text-gray-700 cursor-pointer select-none">
                              <input type="checkbox" v-model="editDraft.vision" class="rounded border-gray-300 w-4 h-4" />{{ t('settings.cap.read') }}
                            </label>
                            <label class="flex items-center gap-2 text-[13px] text-gray-700 cursor-pointer select-none">
                              <input type="checkbox" v-model="editDraft.reasoning" class="rounded border-gray-300 w-4 h-4" />{{ t('settings.cap.think') }}
                            </label>
                            <label class="flex items-center gap-2 text-[13px] text-gray-700 cursor-pointer select-none">
                              <input type="checkbox" v-model="editDraft.genImage" class="rounded border-gray-300 w-4 h-4" />{{ t('settings.cap.gen') }}
                            </label>
                          </div>
                        </div>

                        <!-- 思考挡位：勾了推理能力才显示 -->
                        <div v-if="editDraft.reasoning">
                          <div class="text-[11px] font-[640] text-gray-400 mb-2.5 flex items-center gap-1.5">{{ t('settings.cap.efforts') }}<HintTip :text="t('settings.cap.effortsHint')" /></div>
                          <div class="flex items-center gap-2">
                            <button
                              v-for="e in EFFORT_ALL" :key="e"
                              class="text-[12px] px-3 py-1 rounded-full border transition-colors"
                              :class="editDraft.efforts[e] ? 'bg-gray-900 text-white border-gray-900' : 'bg-white text-gray-500 border-gray-200 hover:border-gray-400'"
                              @click="editDraft.efforts[e] = !editDraft.efforts[e]"
                            >{{ EFFORT_SHORT[e] }}</button>
                          </div>
                        </div>
                      </div>

                      <div class="px-6 py-4 flex items-center justify-end gap-2 border-t border-gray-100">
                        <button class="btn btn-secondary btn-sm" @click="editingModelId = null">{{ t('settings.cancel') }}</button>
                        <button class="btn btn-primary btn-sm" @click="saveEditingModel">{{ t('common.save') }}</button>
                      </div>
                    </div>
                  </div>
                </Transition>
                </Teleport>

              </div>

              <!-- ============ 人格 ============ -->
              <div v-else-if="activeTab === 'persona'">
                <!-- 基础设定：名字 / 头像 / 性格 / 说话风格 -->
                <div class="mb-6">
                  <h3 class="text-sm font-[640] text-gray-900 mb-3 dark:text-gray-100 flex items-center gap-1.5">{{ t('settings.persona.title') }}<HintTip :text="t('settings.persona.titleHint')" /></h3>

                  <div class="flex items-center justify-between gap-3 px-3.5 py-2.5 rounded-xl bg-gray-50 dark:bg-gray-800 mb-3">
                    <div class="flex-1 min-w-0">
                      <span class="text-[13px] text-gray-700 dark:text-gray-200">{{ t('settings.persona.nisName') }}</span>
                      <HintTip :text="t('settings.persona.nisNameHint')" />
                    </div>
                    <input v-model="personaDraft.nisName" :placeholder="t('settings.persona.nisNamePlaceholder')" class="bg-gray-50 border border-gray-200 rounded-lg px-3 py-1.5 text-xs text-gray-800 dark:bg-gray-700 dark:border-gray-600 dark:text-gray-100 outline-none focus:border-gray-400 w-36" />
                  </div>

                  <div class="flex items-center gap-4 px-3.5 py-3 rounded-xl bg-gray-50 dark:bg-gray-800 mb-3">
                    <div class="w-14 h-14 rounded-full bg-gray-100 border border-gray-200 flex items-center justify-center overflow-hidden flex-shrink-0">
                      <!-- 0920：头像默认用 NIS logo（所以不再需要"没设就显示 🐱 占位"的 v-else） -->
                      <LogAvatar :name="personaDraft.nisName || 'N'" :image="avatarPreview || DEFAULT_NIS_AVATAR" :size="56" />
                    </div>
                    <div class="flex-1 min-w-0">
                      <div class="text-[10px] text-gray-400 dark:text-gray-500">{{ t('settings.persona.avatar') }}<span class="ml-1 text-gray-300 dark:text-gray-600">· {{ t('settings.persona.avatarDefaultHint') }}</span></div>
                      <div class="text-base text-gray-900 font-[640] mt-0.5">{{ personaDraft.nisName || 'Nis' }}</div>
                    </div>
                    <div class="ml-auto flex gap-2">
                      <button @click="avatarFileRef?.click()" class="btn btn-secondary btn-sm">{{ t('settings.persona.uploadAvatar') }}</button>
                      <button v-if="avatarPreview" @click="resetAvatar" class="btn btn-secondary btn-sm">{{ t('settings.persona.removeAvatar') }}</button>
                    </div>
                    <input ref="avatarFileRef" type="file" accept="image/*" hidden @change="onAvatarFileChange" />
                  </div>

                  <div class="mb-3">
                    <label class="block text-xs font-[640] text-gray-700 mb-2">{{ t('settings.persona.prompt') }}</label>
                    <textarea
                      v-model="personaDraft.prompt"
                      rows="4"
                      :placeholder="t('settings.persona.promptPlaceholder')"
                      class="w-full px-3 py-2 rounded-xl border border-gray-200 bg-white text-[13px] text-gray-800 outline-none focus:border-gray-400 resize-none dark:bg-gray-800 dark:border-gray-700 dark:text-gray-100"
                    ></textarea>
                    <p class="text-[10px] text-gray-400 mt-1">{{ t('settings.persona.promptHint') }}</p>
                  </div>

                  <!-- ★1012m：工作纪律（判断与纠错）—— 该段**优先于上面的性格设定**（性格只管语气/风格）；
                       关掉则完全不注入（接本地小模型、角色扮演/恋爱文字游戏时建议关）。
                       文案走 i18n：frontend/src/utils/i18n.ts 的 settings.persona.criticDiscipline* -->
                  <div class="flex items-center justify-between gap-3 px-3.5 py-2.5 rounded-xl bg-gray-50 dark:bg-gray-800 mt-3">
                    <div class="flex-1 min-w-0">
                      <span class="text-[13px] text-gray-700 dark:text-gray-200">{{ t('settings.persona.criticDiscipline') }}</span>
                      <HintTip :text="t('settings.persona.criticDisciplineHint')" />
                    </div>
                    <BwSwitch :model-value="generalDraft.criticDiscipline !== false" @update:model-value="(v: boolean) => (generalDraft.criticDiscipline = v)" />
                  </div>

                </div>

                <!-- 主动记忆 -->
                <div class="mb-6">
                  <h3 class="text-sm font-[640] text-gray-900 mb-3 dark:text-gray-100">{{ t('settings.persona.activeMemSection') }}</h3>
                  <div class="flex items-center justify-between gap-3 px-3.5 py-2.5 rounded-xl bg-gray-50 dark:bg-gray-800">
                    <div class="flex-1 min-w-0">
                      <span class="text-[13px] text-gray-700 dark:text-gray-200">{{ t('settings.persona.activeMem') }}</span>
                      <HintTip :text="t('settings.persona.activeMemHint')" />
                    </div>
                    <BwSwitch :model-value="activeMem" @update:model-value="(v: boolean) => (activeMem = v)" />
                  </div>
                </div>

                <!-- ★1013（已定案："后台模型的位置拿回到人格里面吧"）：从「通用」搬回「人格」。
                     注意「全局模型（聊天默认）」那一行**已彻底去掉** —— 全局模型现在跟着用户在对话里选的模型走，
                     设置里只留这个「后台模型」（对话之外的活 + 渠道未单独配模型时用它）。 -->
                <div class="mb-6">
                  <h3 class="text-sm font-[640] text-gray-900 mb-3 dark:text-gray-100 flex items-center gap-1.5">{{ t('settings.general.models') }}<HintTip :text="t('settings.general.modelsHint')" /></h3>
                  <div class="flex items-center justify-between gap-3 px-3.5 py-2.5 rounded-xl bg-gray-50 dark:bg-gray-800">
                    <div class="flex-1 min-w-0">
                      <span class="text-[13px] text-gray-700 dark:text-gray-200">{{ t('settings.persona.backgroundModel') }}</span>
                      <HintTip :text="t('settings.persona.backgroundModelHint')" />
                    </div>
                    <BackgroundModelSelector />
                  </div>
                </div>

              </div>

              <!-- ============ 外观 ============ -->
              <div v-else-if="activeTab === 'appearance'">
                <!-- ★ 0924（需求）：原在页首的"回复完成折叠过程态"开关已挪进下方「动效」分组——
                     它本质是"回复过程怎么呈现"，与动效档位同族，放一起才对 -->
                <!-- 界面语言（0907 从通用页迁入：与主题/字号同属界面表现层） -->
                <div class="mb-6">
                  <h3 class="text-sm font-[640] text-gray-900 mb-3">{{ t('settings.general.language') }}</h3>
                  <BwSeg v-model="s.language" :options="['中文', 'English']" />
                </div>
                <div class="mb-6">
                  <h3 class="text-sm font-[640] text-gray-900 mb-3 flex items-center gap-1.5">{{ t('settings.appearance.theme') }}<HintTip :text="t('settings.appearance.themeHint')" /></h3>
                  <BwSeg v-model="appearanceDraft.themeMode" :options="['浅色', '深色', '跟随系统', '按时间']" :labels="[t('settings.theme.light'), t('settings.theme.dark'), t('settings.theme.system'), t('settings.theme.schedule')]" @update:model-value="applyThemeNow" />
                  <!-- 0917 「按时间」：自定义浅色时段 + 常见作息预设 -->
                  <div v-if="appearanceDraft.themeMode === '按时间'" class="mt-3 px-3.5 py-3 rounded-xl bg-gray-50">
                    <div class="flex items-center gap-2 flex-wrap">
                      <span class="text-[13px] text-gray-700">{{ t('settings.theme.lightWindow') }}</span>
                      <input type="time" v-model="appearanceDraft.themeLightStart" class="theme-time-input" />
                      <span class="text-gray-400 text-[13px]">→</span>
                      <input type="time" v-model="appearanceDraft.themeLightEnd" class="theme-time-input" />
                      <span class="text-[12px] text-gray-400 ml-1">{{ t('settings.theme.outsideDark') }}</span>
                    </div>
                    <div class="mt-2.5 flex items-center gap-1.5 flex-wrap">
                      <span class="text-[12px] text-gray-400">{{ t('settings.theme.presets') }}</span>
                      <button
                        v-for="ps in THEME_TIME_PRESETS"
                        :key="ps.key"
                        type="button"
                        class="px-2.5 py-1 rounded-full text-[12px] border border-gray-200 hover:bg-gray-100 transition-colors"
                        :title="ps.start + ' - ' + ps.end"
                        @click="applyThemePreset(ps)"
                      >{{ t(ps.labelKey) }}</button>
                    </div>
                  </div>
                </div>
                <div class="mb-6">
                  <h3 class="text-sm font-[640] text-gray-900 mb-3">{{ t('settings.appearance.fontSize') }}</h3>
                  <BwSeg v-model="appearanceDraft.fontSize" :options="['小', '标准', '大']" :labels="[t('settings.font.small'), t('settings.font.standard'), t('settings.font.large')]" />
                </div>
                <!-- ★1010 界面字体（只列本机装了的；按钮用该字体自渲染，所见即所得） -->
                <div class="mb-6">
                  <h3 class="text-sm font-[640] text-gray-900 mb-3 flex items-center gap-1.5">
                    {{ t('settings.appearance.fontFamily') }}<HintTip :text="t('settings.appearance.fontFamilyHint')" />
                  </h3>
                  <div class="grid grid-cols-3 gap-2">
                    <button
                      v-for="f in fontOptions"
                      :key="f.id"
                      class="px-3 py-2 rounded-xl border text-[13px] truncate transition-colors"
                      :class="appearanceDraft.fontFamily === f.value
                        ? 'border-gray-400 bg-gray-50 text-gray-900 font-[640]'
                        : 'border-gray-100 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:border-gray-300'"
                      :style="f.value ? { fontFamily: f.value } : {}"
                      @click="appearanceDraft.fontFamily = f.value"
                    >{{ t('settings.fontPreset.' + f.id) }}</button>
                  </div>
                </div>
                <!-- ★1010 我的气泡颜色：预设色 + 原生色盘自选（文字色自动切黑/白） -->
                <div class="mb-6">
                  <h3 class="text-sm font-[640] text-gray-900 mb-3 flex items-center gap-1.5">
                    {{ t('settings.appearance.bubbleColor') }}<HintTip :text="t('settings.appearance.bubbleColorHint')" />
                  </h3>
                  <div class="flex flex-wrap items-center gap-2.5 px-3.5 py-3 rounded-xl bg-gray-50 dark:bg-gray-800">
                    <button
                      class="w-8 h-8 rounded-full border-2 transition-transform hover:scale-105 shrink-0"
                      :class="!appearanceDraft.bubbleColor ? 'border-gray-900 dark:border-gray-100' : 'border-transparent'"
                      style="background: linear-gradient(135deg, #2563eb 0%, #4f46e5 100%)"
                      :title="t('settings.appearance.bubbleColorDefault')"
                      @click="appearanceDraft.bubbleColor = ''"
                    ></button>
                    <button
                      v-for="c in BUBBLE_COLORS"
                      :key="c.id"
                      class="w-8 h-8 rounded-full border-2 transition-transform hover:scale-105 shrink-0"
                      :class="appearanceDraft.bubbleColor === c.color ? 'border-gray-900 dark:border-gray-100' : 'border-transparent'"
                      :style="{ background: c.color }"
                      :title="t('settings.bubbleColor.' + c.id)"
                      @click="appearanceDraft.bubbleColor = c.color"
                    ></button>
                    <label
                      class="w-8 h-8 rounded-full border-2 border-dashed border-gray-300 dark:border-gray-600 flex items-center justify-center cursor-pointer hover:border-gray-400 shrink-0 relative overflow-hidden"
                      :class="isCustomColor ? 'border-solid border-gray-900 dark:border-gray-100' : ''"
                      :style="isCustomColor ? { background: appearanceDraft.bubbleColor } : {}"
                      :title="t('settings.appearance.bubbleColorPick')"
                    >
                      <input type="color" class="absolute inset-0 opacity-0 cursor-pointer" :value="appearanceDraft.bubbleColor || '#2563eb'" @input="onPickBubbleColor" />
                      <i v-if="!isCustomColor" class="fas fa-palette text-[12px] text-gray-400"></i>
                    </label>
                  </div>
                </div>
                <div class="mb-2">
                  <h3 class="text-sm font-[640] text-gray-900 mb-3">{{ t('settings.appearance.bubble') }}</h3>
                  <div class="flex items-center justify-between gap-3 px-3.5 py-2.5 rounded-xl bg-gray-50 mb-2">
                    <span class="text-[13px] text-gray-700">{{ t('settings.appearance.bubbleAvatar') }}</span>
                    <BwSwitch :model-value="appearanceDraft.bubbleAvatar" @update:model-value="(v: boolean) => (appearanceDraft.bubbleAvatar = v)" />
                  </div>
                  <div class="flex items-center justify-between gap-3 px-3.5 py-2.5 rounded-xl bg-gray-50">
                    <span class="text-[13px] text-gray-700">{{ t('settings.appearance.bubbleRadius') }}</span>
                    <BwSeg v-model="appearanceDraft.bubbleRadius" :options="['小', '中', '大']" :labels="[t('settings.radius.small'), t('settings.radius.medium'), t('settings.radius.large')]" />
                  </div>
                </div>
                <!-- 背景图（0906）：主区底图（面板元素保持实底可读），浓度滑杆控制透出强度；说明收进标题 ?（0907） -->
                <div class="mb-2">
                  <h3 class="text-sm font-[640] text-gray-900 mb-3 flex items-center gap-1.5">{{ t('settings.appearance.bgImage') }}<HintTip :text="t('settings.appearance.bgHint')" /></h3>
                  <div class="px-3.5 py-2.5 rounded-xl bg-gray-50 space-y-3">
                    <div class="flex items-center gap-3">
                      <label class="btn btn-secondary btn-sm cursor-pointer">
                        <input type="file" accept="image/*" class="hidden" @change="pickBgImage" />
                        {{ t('settings.appearance.bgChoose') }}
                      </label>
                      <template v-if="appearanceDraft.bgImage">
                        <img :src="appearanceDraft.bgImage" class="w-9 h-9 rounded-md object-cover border border-gray-200 shrink-0" alt="" />
                        <span class="text-[11px] text-gray-400 truncate flex-1 min-w-0">{{ bgName }}</span>
                        <button class="btn btn-xs btn-secondary shrink-0" @click="clearBgImage">{{ t('settings.appearance.bgClear') }}</button>
                      </template>
                      <span v-else class="text-[11px] text-gray-400">{{ t('settings.appearance.bgEmpty') }}</span>
                    </div>
                    <div v-if="appearanceDraft.bgImage" class="flex items-center gap-3">
                      <span class="text-[11px] text-gray-400 w-12 shrink-0">{{ t('settings.appearance.bgOpacity') }}</span>
                      <input type="range" min="5" max="100" :value="Math.round(appearanceDraft.bgOpacity * 100)" class="flex-1" @input="appearanceDraft.bgOpacity = Number(($event.target as HTMLInputElement).value) / 100" />
                      <span class="text-[11px] text-gray-500 w-9 text-right tabular-nums">{{ Math.round(appearanceDraft.bgOpacity * 100) }}%</span>
                    </div>
                    <p v-if="bgError" class="text-[10px] text-red-500">{{ bgError }}</p>
                  </div>
                </div>
                <!-- ★1010（需求）：本组标题「动效」→「界面」；性能档（全效/均衡/节能）由"整行胶囊"
                     改成与下面各行同款的行式布局：左小标题「性能」+ 右胶囊。
                     档位含义（0907）：full 全效 / balanced 关常驻循环动画 / eco 节能（磨砂+动画全关）；
                     由 style.css 全局降级（main.ts applyFx）实现。 -->
                <div class="mb-2 mt-6">
                  <h3 class="text-sm font-[640] text-gray-900 dark:text-gray-100 mb-3 flex items-center gap-1.5">{{ t('settings.appearance.fx') }}</h3>
                  <div class="flex items-center justify-between gap-3 px-3.5 py-2.5 rounded-xl bg-gray-50 dark:bg-gray-800 mb-2">
                    <div class="flex-1 min-w-0">
                      <span class="text-[13px] text-gray-700 dark:text-gray-200">{{ t('settings.appearance.performance') }}</span>
                      <HintTip :text="t('settings.fx.hint')" />
                    </div>
                    <BwSeg v-model="appearanceDraft.fxLevel" :options="['full', 'balanced', 'eco']" :labels="[t('settings.fx.full'), t('settings.fx.balanced'), t('settings.fx.eco')]" />
                  </div>
                  <!-- ★ 0924（需求）：回复完成后折叠工具过程（只折工具，思考不参与）——从页首挪进「界面」分组 -->
                  <!-- ★1010（需求）：从"开关"升级为**三档** —— 完全展示 / 折叠工具 / 全部折叠。
                       三档都只是"默认折叠状态"：折叠行任何时候都能点开查看，回复过程中照常展开看进度。 -->
                  <div class="flex items-center justify-between gap-3 px-3.5 py-2.5 rounded-xl bg-gray-50 dark:bg-gray-800">
                    <div class="flex-1 min-w-0">
                      <span class="text-[13px] text-gray-700 dark:text-gray-200">{{ t('settings.appearance.foldProcess') }}</span>
                      <HintTip :text="t('settings.appearance.foldProcessHint')" />
                    </div>
                    <BwSeg
                      v-model="procFoldMode"
                      :options="['full', 'tools', 'all']"
                      :labels="[t('settings.appearance.foldModeFull'), t('settings.appearance.foldModeTools'), t('settings.appearance.foldModeAll')]"
                    />
                  </div>
                </div>
              </div>

              <!-- ============ 提示 ============ -->
              <div v-else-if="activeTab === 'notifications'">
                <div class="mb-6">
                  <h3 class="text-sm font-[640] text-gray-900 mb-3 dark:text-gray-100">{{ t('settings.notifications.system') }}<HintTip :text="t('settings.notifications.systemWinHint')" /></h3>
                  <!-- 0914：测试通知按钮（点击=用户手势 → 可正常申请授权并实发一条） -->
                  <div class="flex items-center gap-2 mb-2">
                    <button @click="sendTestNotification" class="btn btn-secondary btn-sm">{{ t('settings.notifications.testSend') }}</button>
                  </div>
                  <div v-for="item in [
                    { key: 'agent', label: t('settings.notifications.agent'), hint: t('settings.notifications.agentHint') },
                    { key: 'permission', label: t('settings.notifications.permission'), hint: t('settings.notifications.permissionHint') },
                    { key: 'error', label: t('settings.notifications.error'), hint: t('settings.notifications.errorHint') },
                    { key: 'memory', label: t('settings.notifications.memory'), hint: t('settings.notifications.memoryHint') },
                    { key: 'channel', label: t('settings.notifications.channel'), hint: t('settings.notifications.channelHint') },
                  ]" :key="item.key" class="flex items-center justify-between gap-3 px-3.5 py-2.5 rounded-xl bg-gray-50 dark:bg-gray-800 mb-2">
                    <div class="flex-1 min-w-0">
                      <span class="text-[13px] text-gray-700 dark:text-gray-200">{{ item.label }}</span>
                      <p class="text-[10px] text-gray-400 dark:text-gray-500 mt-0.5">{{ item.hint }}</p>
                    </div>
                    <BwSwitch :model-value="(settingsStore.notify as any)[item.key]" @update:model-value="(v: boolean) => settingsStore.setNotify(item.key as any, v)" />
                  </div>
                </div>
                <div class="mb-2">
                  <h3 class="text-sm font-[640] text-gray-900 mb-3 dark:text-gray-100">{{ t('settings.notifications.sound') }}<HintTip :text="t('settings.notifications.soundHint')" /></h3>
                  <!-- 0914c：提示音统一音量（试听与实播同口径；滑杆即时生效） -->
                  <div class="flex items-center justify-between gap-3 px-3.5 py-2.5 rounded-xl bg-gray-50 dark:bg-gray-800 mb-2">
                    <div class="flex-1 min-w-0">
                      <span class="text-[13px] text-gray-700 dark:text-gray-200">{{ t('settings.notifications.volume') }}</span>
                      <p class="text-[10px] text-gray-400 dark:text-gray-500 mt-0.5">{{ t('settings.notifications.volumeHint') }}</p>
                    </div>
                    <div class="flex items-center gap-2 w-[180px] shrink-0">
                      <input
                        type="range" min="0" max="100" step="1"
                        :value="Math.round((settingsStore.notify.volume ?? 0.8) * 100)"
                        class="flex-1"
                        @input="settingsStore.setNotify('volume', Number(($event.target as HTMLInputElement).value) / 100)"
                      />
                      <span class="text-[11px] text-gray-500 dark:text-gray-400 w-9 text-right tabular-nums">{{ Math.round((settingsStore.notify.volume ?? 0.8) * 100) }}%</span>
                    </div>
                  </div>
                  <div v-for="item in soundCategories" :key="item.key" class="flex items-center justify-between gap-3 px-3.5 py-2.5 rounded-xl bg-gray-50 dark:bg-gray-800 mb-2">
                    <div class="flex-1 min-w-0">
                      <span class="text-[13px] text-gray-700 dark:text-gray-200">{{ t(item.labelKey) }}</span>
                      <p class="text-[10px] text-gray-400 dark:text-gray-500 mt-0.5">{{ t(item.hintKey) }}</p>
                    </div>
                    <div class="flex items-center gap-2">
                      <SoundSelect
                        :model-value="currentSoundValue(item.key)"
                        :options="soundOptions(item.key).map(o => ({ id: o.id, label: o.label }))"
                        @update:model-value="(v: string) => onSoundChange(item.key, v)"
                      />
                      <button
                        @click="onPreviewSound(item.key)"
                        class="w-7 h-7 flex items-center justify-center rounded-lg bg-gray-100 text-gray-500 hover:bg-gray-200 hover:text-gray-700 transition-colors"
                        :title="t('settings.notifications.preview')"
                      ><i class="fas fa-play text-[10px]"></i></button>
                      <button
                        @click="triggerSoundUpload(item.key)"
                        class="w-7 h-7 flex items-center justify-center rounded-lg bg-gray-100 text-gray-500 hover:bg-gray-200 hover:text-gray-700 transition-colors"
                        :title="t('settings.notifications.upload')"
                      ><i class="fas fa-upload text-[10px]"></i></button>
                      <input
                        :ref="(el) => (soundFileInputs[item.key] = el)"
                        type="file"
                        accept="audio/wav,audio/mpeg,audio/ogg,audio/webp,audio/x-m4a,.wav,.mp3,.ogg,.m4a,.webm"
                        class="hidden"
                        @change="(e) => onSoundFile(item.key, e)"
                      />
                      <button
                        v-if="settingsStore.notify.customSounds?.[item.key]"
                        @click="clearCustomSound(item.key)"
                        class="w-7 h-7 flex items-center justify-center rounded-lg bg-gray-100 text-gray-400 hover:bg-red-50 hover:text-red-600 transition-colors"
                        :title="t('settings.notifications.resetSound')"
                      ><i class="fas fa-rotate-left text-[10px]"></i></button>
                    </div>
                  </div>
                </div>
              </div>
              <!-- ============ 版本保底（0913） ============ -->
              <div v-else-if="activeTab === 'backup'" class="flex flex-col gap-4 pb-1">
                <!-- 代码还原点（版本保底引擎）★1010k：不再强制撑满面板 —— 现在下面多了"数据备份"，
                     两块一屏放不下，改走**整页滚动**（面板内容区本来就有 overflow-y-auto） -->
                <ReleaseBackupSection />
                <!-- ★1010j：数据备份从「通用」页搬来（导出/导入整包数据；与上面的"代码还原点"是两件事） -->
                <div class="pt-4 border-t border-gray-100 dark:border-gray-800">
                  <!-- 数据备份（0915 / 0917b）：整包导出 / 导入（换机、搬进安装版）+ 导入其他 agent 数据 -->
                  <div class="mb-0 mt-0">
                    <h3 class="text-sm font-[640] text-gray-900 mb-3 dark:text-gray-100 flex items-center gap-1.5">{{ t('settings.general.dataBackup') }}<HintTip :text="t('settings.general.dataBackupHint')" /></h3>
  
                    <!-- 导出全部数据 -->
                    <div class="px-3.5 py-2.5 rounded-xl bg-gray-50 dark:bg-gray-800 mb-2">
                      <div class="flex items-center justify-between gap-3">
                        <div class="flex-1 min-w-0">
                          <span class="text-[13px] text-gray-700 dark:text-gray-200">{{ t('settings.general.dataExport') }}</span>
                          <p class="text-[10px] text-gray-400 dark:text-gray-500 mt-0.5">{{ t('settings.general.dataExportSub') }}</p>
                        </div>
                        <button class="btn btn-secondary btn-sm shrink-0" :disabled="dataExportBusy" @click="openDataDialog('export')">{{ dataExportBusy ? t('settings.general.dataBusy') : t('settings.general.dataExportBtn') }}</button>
                      </div>
                      <div v-if="dataExportBusy" class="mt-2">
                        <div class="flex items-center justify-between text-[10px] text-gray-500 dark:text-gray-400 mb-1">
                          <span class="truncate">{{ dataProgress.export.phase || t('settings.general.dataExporting') }}</span>
                          <span class="shrink-0 ml-2 tabular-nums">{{ dataProgress.export.percent >= 0 ? dataProgress.export.percent + '%' : '' }}</span>
                        </div>
                        <div class="env-progress" :class="{ 'is-indeterminate': dataProgress.export.percent < 0 }">
                          <div class="env-progress-fill" :style="{ width: (dataProgress.export.percent >= 0 ? dataProgress.export.percent : 35) + '%' }"></div>
                        </div>
                      </div>
                      <p v-if="dataExportMsg" class="text-[10px] text-gray-400 dark:text-gray-500 mt-1.5 leading-relaxed break-all">{{ dataExportMsg }}</p>
                    </div>
  
                    <!-- 导入数据 -->
                    <div class="px-3.5 py-2.5 rounded-xl bg-gray-50 dark:bg-gray-800 mb-2">
                      <div class="flex items-center justify-between gap-3">
                        <div class="flex-1 min-w-0">
                          <span class="text-[13px] text-gray-700 dark:text-gray-200">{{ t('settings.general.dataImport') }}</span>
                          <p class="text-[10px] text-gray-400 dark:text-gray-500 mt-0.5">{{ t('settings.general.dataImportSub') }}</p>
                        </div>
                        <button class="btn btn-secondary btn-sm shrink-0" :disabled="dataImportBusy" @click="openDataDialog('import')">{{ dataImportBusy ? t('settings.general.dataBusy') : t('settings.general.dataImportBtn') }}</button>
                      </div>
                      <div v-if="dataImportBusy" class="mt-2">
                        <div class="flex items-center justify-between text-[10px] text-gray-500 dark:text-gray-400 mb-1">
                          <span class="truncate">{{ dataProgress.import.phase || t('settings.general.dataImporting') }}</span>
                          <span class="shrink-0 ml-2 tabular-nums">{{ dataProgress.import.percent >= 0 ? dataProgress.import.percent + '%' : '' }}</span>
                        </div>
                        <div class="env-progress" :class="{ 'is-indeterminate': dataProgress.import.percent < 0 }">
                          <div class="env-progress-fill" :style="{ width: (dataProgress.import.percent >= 0 ? dataProgress.import.percent : 35) + '%' }"></div>
                        </div>
                      </div>
                      <p v-if="dataImportMsg" class="text-[10px] text-gray-400 dark:text-gray-500 mt-1.5 leading-relaxed break-all">{{ dataImportMsg }}</p>
                    </div>
  
                    <!-- 0918（需求）：导入完成 → 必须点掉的弹窗，明确「重启后才生效」+ 一键立即重启。
                         以前只在这张卡片下面留一行灰字，用户点完导入看不到变化（因为要重启才切数据），
                         会以为导入失败。 -->
                    <Teleport to="body">
                      <Transition name="nis-pop">
                      <div v-if="importDoneDialog" class="import-done-mask" @click.self="importDoneDialog = null">
                        <div class="nis-pop-card import-done-card">
                          <div class="import-done-icon"><i class="fas fa-circle-check"></i></div>
                          <h3 class="import-done-title">{{ t('settings.general.importDoneTitle') }}</h3>
                          <p class="import-done-body">{{ t('settings.general.importDoneBody', { dir: importDoneDialog.dir || '—' }) }}</p>
                          <div class="import-done-warn">
                            <i class="fas fa-circle-info"></i>
                            <span>{{ t('settings.general.importDoneNeedRestart') }}</span>
                          </div>
                          <!-- 0920：后端给的备注（例如"这个包不含供应商密钥"）——有才显示 -->
                          <div v-if="importDoneDialog.note" class="import-done-warn import-done-note">
                            <i class="fas fa-triangle-exclamation"></i>
                            <span>{{ importDoneDialog.note }}</span>
                          </div>
                          <div class="import-done-actions">
                            <button class="btn btn-secondary btn-sm" @click="importDoneDialog = null">{{ t('settings.general.importDoneLater') }}</button>
                            <button v-if="isDesktopApp" class="btn btn-primary btn-sm" :disabled="importRestarting" @click="restartNow">
                              <i class="fas fa-rotate-right mr-1"></i>{{ importRestarting ? t('settings.general.importRestarting') : t('settings.general.importDoneRestart') }}
                            </button>
                          </div>
                        </div>
                      </div>
                      </Transition>
                    </Teleport>
  
                    <!-- 0919（需求）：点「开始导入」先问软件名 —— 生成的引导词里
                         `要导入的 Agent：<名字>` 已经填好，用户不用再去改提示词里的「？」。
                         文案复用 chat.importName*（与聊天页那套共用一套 i18n key）。 -->
                    <Teleport to="body">
                      <Transition name="nis-pop">
                      <div
                        v-if="agentImportOpen"
                        class="fixed inset-0 z-[10100] flex items-center justify-center bg-black/40"
                        @click.self="agentImportOpen = false"
                      >
                        <div class="nis-pop-card w-[380px] bg-white rounded-2xl shadow-2xl p-5">
                          <h3 class="text-[15px] font-[640] text-gray-800 mb-1.5">{{ t('chat.importNameTitle') }}</h3>
                          <p class="text-[12px] text-gray-500 leading-relaxed mb-3">{{ t('chat.importNameHint') }}</p>
                          <input
                            ref="agentImportRef"
                            v-model="agentImportName"
                            type="text"
                            class="w-full px-3 py-2 rounded-xl border text-[13px] text-gray-800 outline-none transition-colors"
                            :class="agentImportErr ? 'border-red-400' : 'border-gray-200 focus:border-gray-400'"
                            :placeholder="t('chat.importNamePlaceholder')"
                            @keydown.enter.prevent="confirmAgentImport()"
                            @input="agentImportErr = false"
                          />
                          <p v-if="agentImportErr" class="text-[11px] text-red-500 mt-1.5">{{ t('chat.importNameRequired') }}</p>
                          <div class="mt-3 flex items-center flex-wrap gap-1.5">
                            <span class="text-[11px] text-gray-400">{{ t('chat.importNameCommon') }}</span>
                            <button
                              v-for="s in AGENT_IMPORT_SUGGESTIONS"
                              :key="s"
                              type="button"
                              class="px-2 py-1 rounded-full border border-gray-200 text-[11px] text-gray-600 hover:text-gray-900 hover:border-gray-400 transition-colors"
                              @click="confirmAgentImport(s)"
                            >
                              {{ s }}
                            </button>
                          </div>
                          <div class="mt-5 flex items-center justify-end gap-2">
                            <button
                              type="button"
                              class="px-3.5 py-1.5 rounded-xl border border-gray-200 text-[12px] text-gray-600 hover:bg-gray-50 transition-colors"
                              @click="agentImportOpen = false"
                            >
                              {{ t('chat.cancel') }}
                            </button>
                            <button
                              type="button"
                              class="px-3.5 py-1.5 rounded-xl bg-gray-900 text-white text-[12px] hover:bg-black transition-colors"
                              @click="confirmAgentImport()"
                            >
                              {{ t('chat.confirm') }}
                            </button>
                          </div>
                        </div>
                      </div>
                      </Transition>
                    </Teleport>
  
                    <!-- 导入其他 agent 数据（0918）：一键开「导入助手」对话，由 agent 引导迁移 -->
                    <div class="flex items-center justify-between gap-3 px-3.5 py-2.5 rounded-xl bg-gray-50 dark:bg-gray-800">
                      <div class="flex-1 min-w-0">
                        <span class="text-[13px] text-gray-700 dark:text-gray-200">{{ t('settings.general.agentImport') }}</span>
                        <p class="text-[10px] text-gray-400 dark:text-gray-500 mt-0.5">{{ t('settings.general.agentImportSub') }}</p>
                      </div>
                      <button class="btn btn-secondary btn-sm shrink-0" @click="openAgentImportDialog">{{ t('settings.general.agentImportBtn') }}</button>
                    </div>
                  </div>
                </div>
              </div>

              <!-- ============ 语音（0920：语音输入 + 朗读） ============ -->
              <div v-else-if="activeTab === 'voice'">
                <VoiceSettingsSection />
              </div>

              <!-- ============ 桌宠（未开发） ============ -->
              <div v-else-if="activeTab === 'pet'">
                <div class="flex flex-col items-center justify-center py-16">
                  <div class="w-16 h-16 rounded-2xl bg-gray-50 flex items-center justify-center mb-4">
                    <i class="fas fa-paw text-gray-300 text-2xl"></i>
                  </div>
                  <h3 class="text-sm font-[640] text-gray-900 mb-1">{{ t('settings.pet.title') }}<PendingBadge /></h3>
                  <p class="text-xs text-gray-400">{{ t('settings.pet.notDeveloped') }}</p>
                  <p class="text-xs text-gray-300 mt-1">{{ t('settings.pet.notDevelopedHint') }}</p>
                </div>
              </div>

              <!-- ============ 滞留处 ============ -->
              <div v-else-if="activeTab === 'trash'">
                <div class="mb-5">
                  <div class="text-[13px] font-[530] text-gray-900 mb-2">{{ t('settings.trash.retention') }}</div>
                  <div class="flex items-center gap-2">
                    <button
                      v-for="opt in trashRetentionOptions"
                      :key="opt.value"
                      class="px-4 py-2 rounded-lg border text-[13px] font-[530] transition-all"
                      :class="projectsStore.trashRetentionDays === opt.value
                        ? 'bg-gray-900 text-white border-gray-900'
                        : 'bg-white text-gray-600 border-gray-200 hover:border-gray-400'"
                      @click="projectsStore.setRetentionDays(opt.value)"
                    >
                      {{ opt.label }}{{ t('settings.trash.daysUnit') }}
                    </button>
                  </div>
                  <p class="text-[10px] text-gray-400 mt-1.5">{{ t('settings.trash.retentionHint') }}</p>
                </div>

                <!-- ★ 0921z-3（需求）：滞留项目 / 滞留对话 改成 tab 切换，数量写在标签括号里 -->
                <SegTabs
                  v-model="trashTab"
                  size="md"
                  :options="[
                    { id: 'project', label: t('settings.trash.tabProjects', { n: projectsStore.trashedProjects.length }) },
                    { id: 'conv', label: t('settings.trash.tabConvs', { n: conversationsStore.trashedConversations.length }) },
                  ]"
                />

                <!-- 滞留项目 -->
                <template v-if="trashTab === 'project'">
                  <div v-if="projectsStore.trashedProjects.length === 0" class="py-10 text-center">
                    <div class="w-14 h-14 rounded-2xl bg-gray-50 flex items-center justify-center mx-auto mb-3">
                      <i class="fas fa-recycle text-gray-300 text-xl"></i>
                    </div>
                    <p class="text-[13px] text-gray-400">{{ t('settings.trash.empty') }}</p>
                  </div>
                  <div v-else class="space-y-2 mt-4">
                    <div
                      v-for="tp in projectsStore.trashedProjects"
                      :key="tp.project.id"
                      class="flex items-center gap-3 px-3 py-2.5 rounded-xl bg-gray-50 dark:bg-gray-800"
                    >
                      <div class="w-9 h-9 rounded-lg bg-gray-50 flex items-center justify-center shrink-0">
                        <i class="fas fa-folder text-[14px] text-gray-400"></i>
                      </div>
                      <div class="flex-1 min-w-0">
                        <div class="text-[13px] font-[530] text-gray-800 truncate">{{ tp.project.name }}</div>
                        <div class="text-[10px] text-gray-400 truncate">{{ tp.project.root_path || t('settings.trash.noPath') }}</div>
                        <div class="text-[10px] text-amber-500 mt-0.5">{{ t('settings.trash.left') }}：{{ trashLeftLabel(tp) }}</div>
                      </div>
                      <div class="flex items-center gap-1.5 shrink-0">
                        <button
                          class="btn btn-secondary btn-sm"
                          @click="requestTrashAction('restore-proj', tp.project.id, tp.project.name)"
                        >
                          {{ t('settings.trash.restore') }}
                        </button>
                        <button
                          class="btn btn-danger btn-sm"
                          @click="requestTrashAction('purge-proj', tp.project.id, tp.project.name)"
                        >
                          {{ t('settings.trash.purge') }}
                        </button>
                      </div>
                    </div>
                  </div>
                </template>

                <!-- 滞留对话 -->
                <template v-else>
                  <div v-if="conversationsStore.trashedConversations.length === 0" class="py-6 text-center">
                    <p class="text-[12px] text-gray-400">{{ t('settings.trash.convEmpty') }}</p>
                  </div>
                  <div v-else class="space-y-2 mt-4">
                    <div
                      v-for="tc in conversationsStore.trashedConversations"
                      :key="tc.conversation.id"
                      class="flex items-center gap-3 px-3 py-2.5 rounded-xl bg-gray-50 dark:bg-gray-800"
                    >
                      <div class="w-9 h-9 rounded-lg bg-gray-50 flex items-center justify-center shrink-0">
                        <i class="fas fa-comment-dots text-[14px] text-gray-400"></i>
                      </div>
                      <div class="flex-1 min-w-0">
                        <div class="text-[13px] font-[530] text-gray-800 truncate">{{ tc.conversation.title }}</div>
                        <div class="text-[10px] text-amber-500 mt-0.5">{{ t('settings.trash.left') }}：{{ trashLeftLabel(tc) }}</div>
                      </div>
                      <div class="flex items-center gap-1.5 shrink-0">
                        <button
                          class="btn btn-secondary btn-sm"
                          @click="requestTrashAction('restore-conv', tc.conversation.id, tc.conversation.title)"
                        >
                          {{ t('settings.trash.restore') }}
                        </button>
                        <button
                          class="btn btn-danger btn-sm"
                          @click="requestTrashAction('purge-conv', tc.conversation.id, tc.conversation.title)"
                        >
                          {{ t('settings.trash.purge') }}
                        </button>
                      </div>
                    </div>
                  </div>
                </template>
                <!-- 滞留处二次确认弹窗（彻底删除/恢复） -->
                <Teleport to="body">
                  <div v-if="trashConfirm" class="fixed inset-0 z-[999] flex items-center justify-center bg-black/40" @click.self="trashConfirm = null">
                    <div class="bg-white dark:bg-gray-800 rounded-2xl shadow-2xl w-[320px] p-5">
                      <div class="text-[14px] font-[640] text-gray-900 dark:text-gray-100 mb-2">
                        {{ trashConfirm.type.startsWith('purge') ? t('settings.trash.purge') : t('settings.trash.restore') }}「{{ trashConfirm.title }}」？
                      </div>
                      <div class="text-[12px] text-gray-500 mb-4">
                        <template v-if="trashConfirm.type === 'purge-conv'">{{ t('settings.trash.purgeConv') }}</template>
                        <template v-else-if="trashConfirm.type === 'purge-proj'">{{ t('settings.trash.purgeProj') }}</template>
                        <template v-else-if="trashConfirm.type === 'restore-conv'">{{ t('settings.trash.restoreConv') }}</template>
                        <template v-else>{{ t('settings.trash.restoreProj') }}</template>
                      </div>
                      <div class="flex justify-end gap-2">
                        <button
                          class="btn btn-secondary btn-sm"
                          @click="trashConfirm = null"
                        >{{ t('settings.cancel') }}</button>
                        <button
                          class="btn btn-sm transition-colors"
                          :class="trashConfirm.type.startsWith('purge') ? 'bg-red-600 hover:bg-red-700 text-white' : 'bg-black hover:bg-black/80 text-white'"
                          @click="confirmTrashAction"
                        >{{ trashConfirm.type.startsWith('purge') ? t('settings.trash.purge') : t('settings.trash.restore') }}</button>
                      </div>
                    </div>
                  </div>
                </Teleport>
              </div>

              <!-- ============ 关于 ============ -->
              <div v-else-if="activeTab === 'about'">
                <div class="mb-6 text-center py-4">
                  <img src="/nis-logo2.png" alt="NIS" class="w-16 h-16 object-contain mx-auto" />
                  <div class="text-2xl font-bold text-gray-900 mt-3">NIS</div>
                  <div class="text-[13px] text-gray-400 mt-1">v{{ APP_VERSION }} · {{ t('settings.about.tagline') }}</div>
                </div>
                <!-- 0914c：重新查看首次启动引导 -->
                <div class="mb-6 text-center">
                  <button class="btn btn-secondary btn-sm" @click="reopenOnboarding">{{ t('settings.about.reopenOnboarding') }}</button>
                </div>
                <!-- 0915：按实际情况修正（去模板残留 HanaAgent/外链/假平台支持） -->
                <div class="mb-6">
                  <div v-for="item in [
                    { label: t('settings.about.version'), val: 'v' + APP_VERSION },
                    { label: t('settings.about.techStack'), val: 'Vue 3 + Vite + Tauri 2' },
                    { label: t('settings.about.backend'), val: t('settings.about.backendVal') },
                  ]" :key="item.label" class="flex items-center justify-between gap-3 px-3.5 py-2.5 rounded-xl bg-gray-50 dark:bg-gray-800 mb-2">
                    <span class="text-[13px] text-gray-700 dark:text-gray-200 shrink-0">{{ item.label }}</span>
                    <span class="text-xs text-gray-500 truncate">{{ item.val }}</span>
                  </div>
                </div>
                <!-- 0915：开源致谢（用户拍板补上实际用到的项目） -->
                <div class="mb-6">
                  <h3 class="text-sm font-[640] text-gray-900 mb-3 dark:text-gray-100">{{ t('settings.about.credits') }}</h3>
                  <div v-for="c in [
                    { name: 'ThreeUI', desc: 'Meng To · MIT' },
                    { name: 'three.js', desc: 'MIT' },
                    { name: 'pi-ai', desc: '@earendil-works · MIT' },
                  ]" :key="c.name" class="flex items-center justify-between gap-3 px-3.5 py-2.5 rounded-xl bg-gray-50 dark:bg-gray-800 mb-2">
                    <span class="text-[13px] text-gray-700 dark:text-gray-200">{{ c.name }}</span>
                    <span class="text-[11px] text-gray-500">{{ c.desc }}</span>
                  </div>
                  <p class="text-[11px] text-gray-400 leading-relaxed">{{ t('settings.about.creditsMore') }}</p>
                </div>
                <!-- 0915：开发者（用户拍板：开发者模式开关 + 重启） -->
                <div class="mb-6">
                  <h3 class="text-sm font-[640] text-gray-900 mb-3 dark:text-gray-100">{{ t('settings.about.dev') }}</h3>
                  <div class="flex items-center justify-between gap-3 px-3.5 py-2.5 rounded-xl bg-gray-50 dark:bg-gray-800 mb-2">
                    <div class="flex-1 min-w-0">
                      <span class="text-[13px] text-gray-700 dark:text-gray-200">{{ t('settings.about.devMode') }}</span>
                      <p class="text-[10px] text-gray-400 dark:text-gray-500 mt-0.5">{{ t('settings.about.devModeHint') }}</p>
                    </div>
                    <BwSwitch
                      :model-value="settingsStore.general.devMode"
                      @update:model-value="(v: boolean) => settingsStore.setGeneral('devMode', v)"
                    />
                  </div>
                  <div class="flex items-center justify-between gap-3 px-3.5 py-2.5 rounded-xl bg-gray-50 dark:bg-gray-800 mb-2">
                    <div class="flex-1 min-w-0">
                      <span class="text-[13px] text-gray-700 dark:text-gray-200">{{ t('settings.about.restart') }}</span>
                      <p class="text-[10px] text-gray-400 dark:text-gray-500 mt-0.5">{{ t('settings.about.restartHint') }}</p>
                    </div>
                    <button class="btn btn-secondary btn-sm shrink-0" @click="restartApp">{{ t('settings.about.restartBtn') }}</button>
                  </div>
                </div>
                <div class="mb-6">
                  <h3 class="text-sm font-[640] text-gray-900 mb-3 dark:text-gray-100">{{ t('settings.about.features') }}</h3>
                  <div class="grid grid-cols-2 gap-2">
                    <div v-for="f in [
                      { icon: 'fas fa-brain', title: t('settings.about.featMemory'), desc: t('settings.about.featMemoryDesc') },
                      { icon: 'fas fa-users', title: t('settings.about.featMultiAgent'), desc: t('settings.about.featMultiAgentDesc') },
                      { icon: 'fas fa-shield-halved', title: t('settings.about.featSandbox'), desc: t('settings.about.featSandboxDesc') },
                      { icon: 'fas fa-mobile-screen', title: t('settings.about.featPlatform'), desc: t('settings.about.featPlatformDesc') },
                    ]" :key="f.title" class="px-3 py-3 bg-gray-50 rounded-xl">
                      <div class="text-xs font-[640] text-gray-700 mb-0.5"><i :class="[f.icon, 'text-gray-400 mr-1.5']"></i>{{ f.title }}</div>
                      <div class="text-[10px] text-gray-400 dark:text-gray-500">{{ f.desc }}</div>
                    </div>
                  </div>
                </div>
              </div>

              <!-- ============ 浏览器 ============ -->
              <div v-else-if="activeTab === 'browser'">
                <div class="mb-6">
                  <h3 class="text-sm font-[640] text-gray-900 mb-3 dark:text-gray-100">{{ t('settings.browser.status') }}<HintTip :text="t('settings.browser.statusHint')" /></h3>
                  <div class="flex items-center justify-between gap-3 px-3.5 py-2.5 rounded-xl bg-gray-50 dark:bg-gray-800 mb-2">
                    <div class="flex-1 min-w-0">
                      <span class="text-[13px] text-gray-700 dark:text-gray-200">{{ t('settings.browser.connection') }}</span>
                      <HintTip :text="t('settings.browser.connectionHint')" />
                    </div>
                    <span :class="['text-[10px] px-2 py-0.5 rounded-full font-[530]', browserConnected ? 'bg-green-50 text-green-600' : 'bg-gray-100 text-gray-400']">{{ browserConnected ? t('settings.browser.running') : t('settings.browser.stopped') }}</span>
                  </div>
                  <div class="flex gap-2">
                    <button
                      class="flex-1 btn btn-secondary btn-sm disabled:opacity-40"
                      :disabled="browserConnected"
                      @click="browserStart"
                    >{{ t('settings.browser.start') }}</button>
                    <button
                      class="flex-1 btn btn-danger btn-sm"
                      :disabled="!browserConnected"
                      @click="browserClose"
                    >{{ t('settings.browser.close') }}</button>
                  </div>
                </div>

                <div class="mb-6">
                  <h3 class="text-sm font-[640] text-gray-900 mb-3 dark:text-gray-100">{{ t('settings.browser.launch') }}</h3>
                  <div class="flex items-center justify-between gap-3 px-3.5 py-2.5 rounded-xl bg-gray-50 dark:bg-gray-800 mb-2">
                    <div class="flex-1 min-w-0">
                      <span class="text-[13px] text-gray-700 dark:text-gray-200">{{ t('settings.browser.engineType') }}</span>
                      <HintTip :text="t('settings.browser.engineTypeHint')" />
                    </div>
                    <div class="relative">
                      <button @click="engineDropdownOpen = !engineDropdownOpen" class="flex items-center gap-2 btn btn-secondary btn-sm">
                        <span>{{ browserEngine }}</span>
                        <i class="fas fa-chevron-down text-[9px] text-gray-400"></i>
                      </button>
                      <div v-if="engineDropdownOpen" class="absolute right-0 top-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg py-1 z-20 min-w-[150px]">
                        <div v-for="e in ['Chromium']" :key="e" @click="browserEngine = e; engineDropdownOpen = false" :class="['flex items-center gap-2 px-3 py-2 text-[13px] cursor-pointer hover:bg-gray-50', browserEngine === e ? 'text-gray-900 font-[530]' : 'text-gray-600']">
                          {{ e }}
                        </div>
                      </div>
                    </div>
                  </div>
                  <div class="flex items-center justify-between gap-3 px-3.5 py-2.5 rounded-xl bg-gray-50 dark:bg-gray-800">
                    <div class="flex-1 min-w-0">
                      <span class="text-[13px] text-gray-700 dark:text-gray-200">{{ t('settings.browser.defaultUrl') }}</span>
                      <HintTip :text="t('settings.browser.defaultUrlHint')" />
                    </div>
                    <input v-model="browserDefaultUrl" placeholder="https://" class="bg-gray-50 border border-gray-200 rounded-lg px-3 py-1.5 text-xs text-gray-800 dark:bg-gray-700 dark:border-gray-600 dark:text-gray-100 outline-none focus:border-gray-400 w-44" @blur="browserDefaultUrl = normalizeHomeUrl(browserDefaultUrl)" />
                  </div>
                  <!-- ★1011k：代理（需求的：填了就走代理，留空=直连） -->
                  <div class="flex items-center justify-between gap-3 px-3.5 py-2.5 rounded-xl bg-gray-50 dark:bg-gray-800 mt-2">
                    <div class="flex-1 min-w-0">
                      <span class="text-[13px] text-gray-700 dark:text-gray-200">{{ t('settings.browser.proxy') }}</span>
                      <HintTip :text="t('settings.browser.proxyHint')" />
                    </div>
                    <input v-model="browserProxy" placeholder="http://127.0.0.1:7890" class="bg-gray-50 border border-gray-200 rounded-lg px-3 py-1.5 text-xs text-gray-800 dark:bg-gray-700 dark:border-gray-600 dark:text-gray-100 outline-none focus:border-gray-400 w-44" @blur="saveBrowserProxy" />
                  </div>
                </div>

                <!-- 直播流畅度 / 反爬 / 渲染（0905：设置里选择性开启，实时写回后端并生效） -->
                <div class="mb-6">
                  <h3 class="text-sm font-[640] text-gray-900 mb-3 dark:text-gray-100">{{ t('settings.browser.streamAnti') }}</h3>

                  <div class="flex items-center justify-between gap-3 px-3.5 py-2.5 rounded-xl bg-gray-50 dark:bg-gray-800 mb-2">
                    <div class="flex-1 min-w-0">
                      <span class="text-[13px] text-gray-700 dark:text-gray-200">{{ t('settings.browser.fluency') }}</span>
                      <HintTip :text="t('settings.browser.fluencyHint')" />
                    </div>
                    <div class="flex items-center bg-white dark:bg-gray-700 rounded-lg p-0.5 border border-gray-200 dark:border-gray-600 shrink-0">
                      <button v-for="o in ([{k:'eco',l:t('settings.browser.fEco')},{k:'balanced',l:t('settings.browser.fStandard')},{k:'smooth',l:t('settings.browser.fSmooth')}] as const)" :key="o.k"
                        @click="bApplySmooth(o.k)"
                        :class="['px-2.5 py-1 rounded-md text-[11px] font-[530] transition-all', smoothPreset===o.k ? 'bg-gray-900 text-white' : 'text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-600']">{{ o.l }}</button>
                    </div>
                  </div>

                  <div class="flex items-center justify-between gap-3 px-3.5 py-2.5 rounded-xl bg-gray-50 dark:bg-gray-800 mb-2">
                    <div class="flex-1 min-w-0">
                      <span class="text-[13px] text-gray-700 dark:text-gray-200">{{ t('settings.browser.stealth') }}</span>
                      <HintTip :text="t('settings.browser.stealthHint')" />
                    </div>
                    <BwSwitch :model-value="bs.stealth" @update:model-value="(v: boolean) => bSet({ stealth: v })" />
                  </div>

                  <div class="flex items-center justify-between gap-3 px-3.5 py-2.5 rounded-xl bg-gray-50 dark:bg-gray-800 mb-2">
                    <div class="flex-1 min-w-0">
                      <span class="text-[13px] text-gray-700 dark:text-gray-200">{{ t('settings.browser.blockMedia') }}</span>
                      <HintTip :text="t('settings.browser.blockMediaHint')" />
                    </div>
                    <BwSwitch :model-value="bs.blockMedia" @update:model-value="(v: boolean) => bSet({ blockMedia: v })" />
                  </div>

                  <div class="flex items-center justify-between gap-3 px-3.5 py-2.5 rounded-xl bg-gray-50 dark:bg-gray-800">
                    <div class="flex-1 min-w-0">
                      <span class="text-[13px] text-gray-700 dark:text-gray-200">{{ t('settings.browser.gpu') }}</span>
                      <HintTip :text="t('settings.browser.gpuHint')" />
                    </div>
                    <BwSwitch :model-value="bs.gpu" @update:model-value="(v: boolean) => bSet({ gpu: v })" />
                  </div>
                  <p class="text-[10px] text-gray-400 dark:text-gray-500 mt-2">{{ t('settings.browser.castFooter', { fps: bs.castFps, quality: bs.castQuality, scale: bs.castScale }) }}</p>
                </div>

                <div class="mb-2">
                  <h3 class="text-sm font-[640] text-gray-900 mb-3 dark:text-gray-100">{{ t('settings.browser.cookies') }}<HintTip :text="t('settings.browser.cookiesHint')" /></h3>
                  <div class="flex items-center justify-between gap-3 px-3.5 py-2.5 rounded-xl bg-gray-50 dark:bg-gray-800 mb-2">
                    <div class="flex-1 min-w-0">
                      <span class="text-[13px] text-gray-700 dark:text-gray-200">{{ t('settings.browser.cookiePersist') }}</span>
                      <HintTip :text="t('settings.browser.cookiePersistHint')" />
                    </div>
                    <span class="text-[10px] px-2 py-0.5 rounded-full bg-green-50 text-green-600 font-[530]">{{ t('settings.browser.enabled') }}</span>
                  </div>
                  <div class="px-3.5 py-2.5 rounded-xl bg-gray-50 mb-2">
                    <div class="flex items-center justify-between mb-2">
                      <span class="text-[10px] text-gray-500">{{ t('settings.browser.cookieCount').replace('{n}', String(browserCookies.length)) }}</span>
                      <button class="text-[10px] text-indigo-600 hover:text-indigo-700" @click="browserLoadCookies">{{ t('settings.browser.cookieRefresh') }}</button>
                    </div>
                    <div v-if="browserCookies.length" class="max-h-28 overflow-y-auto space-y-1 custom-scroll">
                      <div v-for="(c, i) in browserCookies" :key="i" class="flex items-center justify-between gap-2 text-[10px]">
                        <span class="text-gray-600 truncate max-w-[140px]">{{ c.name }}</span>
                        <span class="text-gray-400 truncate max-w-[120px]">{{ c.domain }}</span>
                      </div>
                    </div>
                    <p v-else class="text-[10px] text-gray-400">{{ t('settings.browser.cookieEmpty') }}</p>
                  </div>
                  <button
                    class="w-full btn btn-danger btn-sm"
                    :disabled="!browserConnected"
                    @click="browserClearCookies"
                  >{{ t('settings.browser.clearCookies') }}</button>
                </div>
              </div>

            </div>
          </div>

          <!-- 底部 -->
          <div class="px-6 py-3.5 border-t-[1.5px] border-gray-100 flex items-center gap-2 justify-end shrink-0">
            <button @click="close" class="btn btn-secondary btn-md">{{ t('settings.cancel') }}</button>
            <button @click="close" class="btn btn-primary btn-md">{{ t('settings.save') }}</button>
          </div>
        </div>

        <button
          @click="close"
          :class="['close-btn', isAnimating && !isClosing ? 'close-in' : '', isClosing ? 'close-out' : '']"
          class="w-9 h-9 flex items-center justify-center bg-white border border-gray-200 text-gray-400 hover:text-gray-600 hover:shadow-md rounded-full shadow-sm mt-6"
        >
          <i class="fas fa-times text-sm"></i>
        </button>
      </div>
    </div>

    <!-- 供应商启用上限提示弹窗 -->
    <div
      v-if="capDialogVisible"
      class="fixed inset-0 z-[60] flex items-center justify-center"
    >
      <div class="absolute inset-0 bg-black/30" @click="capDialogVisible = false"></div>
      <div class="relative w-[360px] bg-white rounded-2xl shadow-2xl border border-gray-100 p-6 text-center">
        <div class="w-12 h-12 mx-auto rounded-full bg-amber-50 border border-amber-200 flex items-center justify-center mb-3">
          <i class="fas fa-triangle-exclamation text-amber-500 text-lg"></i>
        </div>
        <h3 class="text-[15px] font-[640] text-gray-900 mb-2">{{ t('settings.providers.capTitle') }}</h3>
        <p class="text-xs text-gray-500 mb-5 leading-relaxed">{{ t('settings.providers.capMsg').replace('{max}', String(providersStore.ENABLED_MAX)) }}</p>
        <button
          @click="capDialogVisible = false"
          class="w-full btn btn-primary btn-md"
        >{{ t('settings.providers.capOk') }}</button>
      </div>
    </div>

    <!-- 0910：删除供应商二次确认弹窗（同款 trashConfirm 样式，z 高于设置弹窗本体） -->
    <Teleport to="body">
      <div v-if="provRemoveConfirm" class="fixed inset-0 z-[10000] flex items-center justify-center bg-black/40" @click.self="provRemoveConfirm = null">
        <div class="bg-white dark:bg-gray-800 rounded-2xl shadow-2xl w-[340px] p-5">
          <div class="text-[14px] font-[640] text-gray-900 dark:text-gray-100 mb-2">{{ t('settings.providers.removeConfirmTitle') }}</div>
          <div class="text-[12px] text-gray-500 mb-4 leading-relaxed">
            {{ t('settings.providers.removeConfirmBody') }}
            <span class="text-gray-800 dark:text-gray-200 font-[530]">「{{ provRemoveConfirm.name }}」</span>
            {{ t('settings.providers.removeConfirmSuffix') }}
          </div>
          <div class="flex justify-end gap-2">
            <button class="btn btn-secondary btn-sm" @click="provRemoveConfirm = null">{{ t('settings.cancel') }}</button>
            <button class="btn btn-sm bg-red-600 hover:bg-red-700 text-white" @click="confirmRemoveProvider">{{ t('settings.providers.deleteProvider') }}</button>
          </div>
        </div>
      </div>
    </Teleport>
    <!-- 0911 反馈：上下文管理「恢复默认」二次确认弹窗 -->
    <Teleport to="body">
      <div v-if="ctxResetConfirm" class="fixed inset-0 z-[999] flex items-center justify-center bg-black/40" @click.self="ctxResetConfirm = false">
        <div class="bg-white dark:bg-gray-800 rounded-2xl shadow-2xl w-[340px] p-5">
          <div class="text-[14px] font-[640] text-gray-900 dark:text-gray-100 mb-2">{{ t('settings.general.resetContextConfirmTitle') }}</div>
          <div class="text-[12px] text-gray-500 mb-4 leading-relaxed">{{ t('settings.general.resetContextConfirmBody') }}</div>
          <div class="flex justify-end gap-2">
            <button class="btn btn-secondary btn-sm" @click="ctxResetConfirm = false">{{ t('settings.cancel') }}</button>
            <button class="btn btn-sm bg-black hover:bg-black/80 text-white" @click="resetContextDefaults">{{ t('settings.general.resetContextDefaults') }}</button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- 0913：存储目录切换三选项（原位置保留 / 跟随移动 / 删除原位置） -->
    <Teleport to="body">
      <div v-if="storageMigrate" class="fixed inset-0 z-[85] flex items-center justify-center bg-black/30">
        <div class="bg-white dark:bg-gray-900 rounded-[16px] border border-gray-200 dark:border-gray-700 shadow-[0_24px_70px_-20px_rgba(0,0,0,0.4)] w-[460px] max-w-[92vw] p-5">
          <h3 class="text-sm font-[640] text-gray-900 dark:text-gray-100 mb-2">{{ t('settings.storage.title') }}</h3>
          <p class="text-[12.5px] text-gray-500 dark:text-gray-400 leading-relaxed mb-3">
            {{ t('settings.storage.body', { n: storageMigrate.entries, bytes: fmtBytesShort(storageMigrate.bytes) }) }}
          </p>
          <div class="px-3 py-2 rounded-lg bg-gray-50 dark:bg-gray-800 text-[11.5px] text-gray-500 dark:text-gray-400 break-all mb-3" style="font-family: var(--mono, monospace)">
            {{ storageMigrate.from }}
          </div>

          <button
            :disabled="storageMigrateBusy"
            @click="confirmStorageMigrate('move')"
            class="w-full text-left rounded-xl border border-gray-200 dark:border-gray-700 hover:border-gray-400 px-3.5 py-2.5 mb-2 transition-colors disabled:opacity-50"
          >
            <div class="text-[13px] font-[640] text-gray-800 dark:text-gray-100">{{ t('settings.storage.optMove') }}</div>
            <div class="text-[11px] text-gray-400 mt-0.5">{{ t('settings.storage.optMoveHint') }}</div>
          </button>
          <button
            :disabled="storageMigrateBusy"
            @click="confirmStorageMigrate('keep')"
            class="w-full text-left rounded-xl border border-gray-200 dark:border-gray-700 hover:border-gray-400 px-3.5 py-2.5 mb-2 transition-colors disabled:opacity-50"
          >
            <div class="text-[13px] font-[640] text-gray-800 dark:text-gray-100">{{ t('settings.storage.optKeep') }}</div>
            <div class="text-[11px] text-gray-400 mt-0.5">{{ t('settings.storage.optKeepHint') }}</div>
          </button>
          <button
            :disabled="storageMigrateBusy"
            @click="confirmStorageMigrate('delete')"
            class="w-full text-left rounded-xl border px-3.5 py-2.5 transition-colors disabled:opacity-50"
            :class="storageDeleteArmed ? 'border-red-300 bg-red-50' : 'border-gray-200 dark:border-gray-700 hover:border-red-300'"
          >
            <div class="text-[13px] font-[640]" :class="storageDeleteArmed ? 'text-red-600' : 'text-gray-800 dark:text-gray-100'">
              {{ storageDeleteArmed ? t('settings.storage.deleteConfirm') : t('settings.storage.optDelete') }}
            </div>
            <div class="text-[11px] text-gray-400 mt-0.5">{{ t('settings.storage.optDeleteHint') }}</div>
          </button>

          <p v-if="storageMigrateMsg" class="mt-3 text-[11.5px] text-red-500 break-all leading-relaxed">{{ storageMigrateMsg }}</p>
          <div class="mt-4 flex items-center justify-between gap-3">
            <div class="flex-1 min-w-0">
              <div v-if="storageMigrateBusy" class="space-y-1.5">
                <div class="flex items-center justify-between text-[11px] text-gray-400">
                  <span>{{ t('settings.storage.moving') }}</span>
                  <span class="tabular-nums">{{ storageMigrateElapsed }}s</span>
                </div>
                <!-- 不确定态进度条：单次后端调用拿不到分片进度，用滑动条表示"在动" -->
                <div class="h-1.5 rounded-full bg-gray-100 dark:bg-gray-800 overflow-hidden">
                  <div class="storage-migrate-bar h-full w-1/3 rounded-full bg-gray-900 dark:bg-gray-200"></div>
                </div>
              </div>
            </div>
            <button class="btn btn-secondary btn-sm" :disabled="storageMigrateBusy" @click="storageMigrate = null; storageDeleteArmed = false">{{ t('settings.storage.cancel') }}</button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- 0914：环境安装目录选择器（自绘，替代 window.prompt） -->
    <DirPickerModal v-model:open="envDirPicker" :initial="settingsStore.general.envDir" @select="applyEnvDir" />
    <!-- 0917：存储目录改用同一套内置选择器（与「环境安装目录」交互一致，不再弹系统窗口） -->
    <DirPickerModal v-model:open="storageDirPicker" :initial="settingsStore.storagePath" :z="2147482600" @select="onStoragePicked" />
    <!-- 0917b：数据备份的路径选择在网页端也走内置选择器（此前只有桌面端有对话框） -->
    <DirPickerModal v-model:open="exportDirPicker" :initial="settingsStore.storagePath" :z="2147482600" @select="runExport" />
    <DirPickerModal v-model:open="importFilePicker" mode="file" :file-extensions="['gz', 'tgz', 'tar']" :z="2147482600" @select="onImportFilePicked" />
    <!-- 0919：数据备份的勾选弹窗（导出选要打包的部分 / 导入选要解出的部分） -->
    <DataBackupDialog v-model:open="dataDlgOpen" :mode="dataDlgMode" :file-path="dataDlgFile" @done="onDataDialogDone" />
  </Teleport>
</template>

 <style scoped>
.fade-enter-active { transition: opacity 0.15s ease-out; }
.fade-leave-active { transition: opacity 0.1s ease-in; }
.fade-enter-from, .fade-leave-to { opacity: 0; }

.backdrop-fade-in { animation: backdropFadeIn 0.3s ease forwards; }
.backdrop-fade-out { animation: backdropFadeOut 0.3s ease forwards; }
@keyframes backdropFadeIn { from { opacity: 0; } to { opacity: 1; } }
@keyframes backdropFadeOut { from { opacity: 1; } to { opacity: 0; } }

.dock-in { animation: dockExpand 0.45s cubic-bezier(0.34, 1.6, 0.64, 1) forwards; }
.dock-out { animation: dockCollapse 0.3s cubic-bezier(0.4, 0, 0.2, 1) forwards; }
@keyframes dockExpand {
  0% { opacity: 0; transform: scale(0.05) rotateX(-8deg) translateY(20px); transform-origin: bottom left; filter: blur(4px); }
  50% { opacity: 1; filter: blur(0); }
  70% { transform: scale(1.02) rotateX(1deg) translateY(0); }
  100% { opacity: 1; transform: scale(1) rotateX(0) translateY(0); filter: blur(0); }
}
@keyframes dockCollapse {
  0% { opacity: 1; transform: scale(1) rotateX(0) translateY(0); filter: blur(0); }
  100% { opacity: 0; transform: scale(0.05) rotateX(-8deg) translateY(20px); transform-origin: bottom left; filter: blur(4px); }
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
/* 0915：存储迁移的不确定态进度条（单次后端调用拿不到分片进度，用滑动表示"在动"） */
.storage-migrate-bar { animation: storageSlide 1.15s cubic-bezier(0.45, 0, 0.55, 1) infinite; }
@keyframes storageSlide {
  0% { transform: translateX(-110%); }
  100% { transform: translateX(330%); }
}
/* 0917：主题「按时间」的时间选择器 */
.theme-time-input {
  padding: 2px 6px;
  border-radius: 8px;
  border: 1px solid #e5e7eb;
  background: #fff;
  color: #374151;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
html.dark .theme-time-input {
  border-color: #3f3f46;
  background: #27272a;
  color: #e4e4e7;
}
/* ── 1010 UI② 软件环境卡片：统一色彩体系（状态=主色，来源徽章=中性小徽章）──
 * 为什么不用 tailwind 的 dark: 变体：本项目 dark: 变体是 `&:where(.dark, .dark *)`（特异性 0,1,0），
 * 会被 style.css 的 html.dark 类级映射层（如 `html.dark .bg-gray-50`，特异性 0,2,1）压住，
 * 与映射层同名灰类叠 dark: 是"死类"；故徽章/胶囊的深浅两态在本段用 html.dark 显式写（与 .theme-time-input 同款手法）。
 * 按钮仍走全局 .btn 体系（style.css 已带 html.dark 反色映射），组件内不再手写 bg-xxx hover 组合。 */
.env-src-chip {
  font-size: 9px;
  line-height: 1.5;
  padding: 2px 8px;
  border-radius: 9999px;
  flex-shrink: 0;
  border: 1px solid #e5e7eb;
  background: #ffffff;
  color: #4b5563;
}
html.dark .env-src-chip {
  border-color: #2e2e2e;
  background: #161616;
  color: #b9b9c2;
}
/* 仅「仅 C 盘」这类安装去向警示保留一个琥珀色文字（形状/底色不变，仍属中性徽章族） */
.env-src-chip.is-warn { color: #d97706; }
html.dark .env-src-chip.is-warn { color: #fbbf24; }

/* 右侧动作簇统一高度/内边距（与全局 .btn-sm = padding 7px 16px / 12px 同基准）→ 同一行同一基线 */
.env-act-slot {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 7px 16px;
  font-size: 12px;
  line-height: 1.2;
  border-radius: 9999px;
  white-space: nowrap;
  /* 占位态用在 <button> 上：显式清掉 UA 默认底/框（不依赖 preflight） */
  background: transparent;
  border: none;
  font-family: inherit;
}
/* 状态胶囊（已安装/自带）= 主色，与「安装」主按钮同层级（无 hover：它不是操作） */
.env-status-pill {
  background: #000000;
  color: #ffffff;
}
html.dark .env-status-pill {
  background: #e9e9ef;
  color: #0a0a0a;
}
/* 安装中/卸载中占位文案：弱化灰字，不抢状态胶囊的视觉重点 */
.env-act-quiet {
  color: #9ca3af;
}
html.dark .env-act-quiet {
  color: #83838d;
}
/* 1010-D②：非 NIS 安装的「系统已装」徽章放大到与「已安装」状态按钮完全同尺寸（直接复用 .env-act-slot 的
 * padding 7px 16px / font-size 12px / line-height 1.2 / 全圆角），充当状态位。
 * 为保证「高度完全一致」不加描边（描边会 +2px 高），用中性底色保留来源徽章族的身份（不是操作、无 hover）。
 * 深浅两态仍用 html.dark 显式写（理由同上）。 */
.env-src-badge {
  background: #e9ebee;
  color: #4b5563;
}
html.dark .env-src-badge {
  background: #2b2b2f;
  color: #c2c2cc;
}

/* 0917：软件环境安装进度条（确定态→按百分比填充；不确定态→流光） */
.env-progress {
  position: relative;
  height: 4px;
  border-radius: 99px;
  background: rgba(0, 0, 0, 0.07);
  overflow: hidden;
}
html.dark .env-progress { background: rgba(255, 255, 255, 0.12); }
.env-progress-fill {
  height: 100%;
  border-radius: 99px;
  background: linear-gradient(90deg, #7c3aed, #a78bfa);
  transition: width 0.25s ease-out;
}
.env-progress.is-indeterminate .env-progress-fill {
  width: 35% !important;
  animation: envSlide 1.15s cubic-bezier(0.45, 0, 0.55, 1) infinite;
}
@keyframes envSlide {
  0% { transform: translateX(-110%); }
  100% { transform: translateX(330%); }
}

/* ── 0918 导入完成弹窗（需求要求：把"重启后生效"从一行小字改成必须点掉的弹窗）── */
.import-done-mask {
  position: fixed; inset: 0; z-index: 10090;
  display: flex; align-items: center; justify-content: center;
  background: rgba(0, 0, 0, 0.45);
}
.import-done-card {
  width: 400px; max-width: calc(100vw - 32px);
  background: #fff; border: 1px solid #ececf1; border-radius: 18px;
  padding: 22px; box-shadow: 0 24px 64px -16px rgba(0, 0, 0, 0.5);
  text-align: center;
}
.import-done-icon {
  width: 44px; height: 44px; margin: 0 auto 10px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  background: rgba(16, 185, 129, 0.12); color: #10b981; font-size: 18px;
}
.import-done-title { font-size: 15px; font-weight: 640; color: #111827; margin-bottom: 8px; }
.import-done-body {
  font-size: 12px; line-height: 1.7; color: #6b7280;
  word-break: break-all; margin-bottom: 12px; text-align: left;
  background: #f7f7f9; border-radius: 10px; padding: 8px 11px;
}
.import-done-warn {
  display: flex; align-items: flex-start; gap: 7px; text-align: left;
  font-size: 11.5px; line-height: 1.65; color: #92400e;
  background: #fffbeb; border: 1px solid #fde68a; border-radius: 10px;
  padding: 9px 11px; margin-bottom: 16px;
}
.import-done-warn i { margin-top: 2px; color: #d97706; flex-shrink: 0; }
/* 0920：第二条备注（"这个包不含供应商密钥"）—— 与上面的"需要重启"提示同一版式，只压掉下边距 */
.import-done-warn.import-done-note { margin-top: -6px; }
.import-done-actions { display: flex; gap: 8px; justify-content: center; }
.import-done-actions .btn { min-width: 120px; }
/* 0919：本页新弹窗统一进出场（遮罩淡入淡出 + 卡片上浮/回落）—— 之前是硬切，看着很僵。
   ⚠️ 只动 opacity/transform，别引 backdrop-filter + 全屏 Transition（WebView2 下有过命中测试的坑）。 */
.nis-pop-enter-active, .nis-pop-leave-active { transition: opacity 0.2s ease; }
.nis-pop-enter-from, .nis-pop-leave-to { opacity: 0; }
.nis-pop-enter-active .nis-pop-card { animation: nisPopIn 0.22s cubic-bezier(0.16, 1, 0.3, 1); }
.nis-pop-leave-active .nis-pop-card { transition: transform 0.16s cubic-bezier(0.4, 0, 1, 1), opacity 0.16s ease; }
.nis-pop-leave-to .nis-pop-card { transform: translateY(6px) scale(0.985); opacity: 0; }
@keyframes nisPopIn { from { opacity: 0; transform: translateY(10px) scale(0.98); } to { opacity: 1; transform: none; } }
html.dark .import-done-card { background: #17171c; border-color: #2a2a33; }
html.dark .import-done-title { color: #f0f0f4; }
html.dark .import-done-body { background: #202027; color: #9a9aa6; }
html.dark .import-done-warn { background: rgba(217, 119, 6, 0.12); border-color: rgba(217, 119, 6, 0.35); color: #e5b077; }

/* ── 0925：获取 logo 过程动画 = 小放大镜循环扫视（替掉 fa-spinner 点点旋转）──
 * 与全局搜索过程态（SearchModal .search-scan）同语言；只动 transform。 */
.logo-fetch-scan {
  position: relative;
  display: inline-block;
  width: 14px;
  height: 14px;
}
.logo-fetch-scan i {
  position: absolute;
  left: 1px;
  top: 0;
  font-size: 10px;
  line-height: 14px;
  animation: logo-scan-move 1.2s cubic-bezier(0.45, 0, 0.55, 1) infinite;
}
@keyframes logo-scan-move {
  0%, 100% { transform: translateX(0) rotate(-12deg); }
  50% { transform: translateX(3px) rotate(12deg); }
}
</style>