<script setup lang="ts">
/**
 * WorkspacePanel —— 标签栏「工作区」按钮对应的右侧面板：本会话工作区文件树。
 * 以工作区文件夹为根实时投射实际文件情况；文件夹展开/折叠；
 * 右键菜单：预览 / 浏览器打开 / 打开所在位置 / 删除 / 复制路径。
 *
 * 文件变更区（0902-3 反馈 #1/#2 修订）：
 *  - 层级只有两级：轮次（组头=消息摘要+N文件+展开/折叠+本轮撤销/定位） → 被改动的文件
 *  - 文件三态：active 正常（悬停可撤销）/ undone 黄字"已撤销"（悬停可恢复）/
 *    superseded 被后续轮次覆盖（灰字、撤销/恢复禁用，+N-M/审查照常；组头本轮撤销同步禁用）
 *  - 生效判定以 afterHash 是否等于文件当前内容为主判据 + 撤销留痕(undoOf)区分"已撤销/被覆盖"
 *  - 组头"本轮撤销/定位"纯 icon 按钮：fs.history.restoreTurn 一次撤掉该轮全部更改
 *  - 实时刷新：监听 mux 的 workspace-changed 投影帧 + 打开时轻轮询兜底（自动同步，无需手动）
 */
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue'
import { useChatStore } from '@/stores/chat'
import { useConversationsStore } from '@/stores/conversations'
import { usePreviewTabsStore } from '@/stores/previewTabs'
import { useGlobalContextMenu } from '@/composables/useGlobalContextMenu'
import { usePiChatStore } from '@/stores/piChat'
import type { ContextMenuItem } from './ContextMenu.vue'
import WorkspaceNode from './WorkspaceNode.vue'
import { t } from '@/utils/i18n'
import { cleanTurnLabel } from '@/utils/modeHint'
import { localStore } from '@/utils/localStore'
import { swallowed } from '@/utils/swallowed'

const chatStore = useChatStore()
const conversationsStore = useConversationsStore()
const previewTabs = usePreviewTabsStore()
const convId = computed(() => String(conversationsStore.activeConversationId ?? ''))
const piChat = usePiChatStore()

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ (e: 'close'): void }>()

interface TreeNode { name: string; type: 'file' | 'folder'; children?: TreeNode[] }
const tree = ref<TreeNode[]>([])
const expanded = ref<Record<string, boolean>>({})
const loading = ref(false)
const rootPath = ref('')
/** 工作区根节点名（以文件夹为根展示：根 ▾ → 子文件） */
const rootName = computed(() => {
  if (!rootPath.value) return t('workspace.title')
  const parts = rootPath.value.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || t('workspace.title')
})
watch(() => rootPath.value, () => { expanded.value[rootName.value] = true })

function fmtTime(t: number): string {
  const d = new Date(t)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/* ── 文件变更记录（AI 写入历史；审查/恢复数据源 docs/research-0902.md §1.5） ── */
interface HistoryChangeView {
  id: string
  t: number
  tool: string
  actor: string
  kind: 'file' | 'tree'
  relPath?: string
  beforeHash?: string
  afterHash?: string
  existedBefore?: boolean
  voided?: boolean
  turnId?: string
  turnIndex?: number
  undoOf?: string
  /** 写入时回填的差异量（markAfterContent）——直接显示用，不再懒算（★1004o） */
  diffAdded?: number
  diffRemoved?: number
}
const fileChanges = ref<HistoryChangeView[]>([])

/** 文件条目视图（0902-3 两级结构：轮次 → 文件；同轮同文件多改取最新一条为代表） */
/** 三态（后端 changeStatus 判定）：active=生效可撤销 / undone=已撤销可恢复 / superseded=被后续改动覆盖 */
type EntryState = 'active' | 'undone' | 'superseded'
interface FileEntryView {
  relPath: string
  op: 'add' | 'modify' | 'delete'
  t: number
  changeId: string
  state?: EntryState
  stateKnown?: boolean
  diff?: { added: number; removed: number }
  turnKey: string
  turnIndex: number | null
  turnLabel: string
}
const fileEntries = ref<FileEntryView[]>([])
const diffLoaded = ref<Set<string>>(new Set())
const activeLoading = ref<Set<string>>(new Set())
const loadingChanges = ref(false)
/** 轮次汇总（后端 fs.history.turnSummary 一次批量算）：turnIndex → 该轮 是否被撤销/是否整轮被覆盖/文件数 */
interface TurnSummary { undone: boolean; supersededAll: boolean; fileCount: number }
const turnSummary = ref<Record<number, TurnSummary>>({})
/** 本轮撤销真实可用的轮次（后端干跑探测：快照失效/无动作/已全部撤销 → 不在表内 → 按钮禁用） */
const undoableTurns = ref<Set<number>>(new Set())
/** 首轮 turnSummary 到达前不禁用（避免加载瞬间按钮闪现灰态） */
const turnSummaryLoaded = ref(false)

async function loadFileChanges() {
  if (!convId.value) { fileChanges.value = []; fileEntries.value = []; turnSummary.value = {}; undoableTurns.value = new Set(); turnSummaryLoaded.value = false; return }
  loadingChanges.value = true
  try {
    const v = await chatStore.bridgeRpc('fs.history.list', { sessionId: convId.value })
    fileChanges.value = Array.isArray(v?.changes) ? v.changes : []
    rebuildEntries()
  } catch { fileChanges.value = []; fileEntries.value = [] }
  finally { loadingChanges.value = false }
  // 轮次汇总不阻塞列表渲染；失败保持旧值
  try {
    const s = await chatStore.bridgeRpc('fs.history.turnSummary', { sessionId: convId.value })
    if (s && typeof s === 'object') {
      if (s.turns) turnSummary.value = s.turns as Record<number, TurnSummary>
      if (Array.isArray(s.undoable)) undoableTurns.value = new Set(s.undoable.map(Number))
      turnSummaryLoaded.value = true
    }
  } catch (e) { swallowed('撤销轮次摘要加载失败（撤销列表可能不全）', e) }
}

/** 由原始 change 列表折叠出轮次→文件两级数据（撤销留痕 actor=用户撤销* 不作条目展示） */
function rebuildEntries() {
  const byTurnPath = new Map<string, { turnKey: string; turnIndex: number | null; turnLabel: string; change: HistoryChangeView }>()
  for (const c of [...fileChanges.value].sort((a, b) => b.t - a.t)) {
    if (c.actor === '用户撤销' || c.actor === '用户撤销(整轮)') continue
    if (!c.relPath || c.kind !== 'file') continue
    const ti = typeof c.turnIndex === 'number' && c.turnIndex > 0 ? c.turnIndex : null
    /* ★1004k：分组键=轮号+标签 —— 历史数据里死轮（压缩后无从对齐）/新旧口径撞号时，
     * 不同轮的标签不同 → 绝不混行；同轮同标签正常归并 */
    const turnLabel = cleanTurnLabel(c.turnId || '')
    const turnKey = `${ti != null ? `t${ti}` : 'tx'}|${turnLabel}`
    // 已按 t 倒序：同轮同路径第一条即最新（代表条目）
    const k = `${turnKey}|${c.relPath}`
    if (!byTurnPath.has(k)) byTurnPath.set(k, { turnKey, turnIndex: ti, turnLabel, change: c })
  }
  const prevStates = new Map(fileEntries.value.map(f => [f.changeId, f]))
  fileEntries.value = Array.from(byTurnPath.values()).map(({ turnKey, turnIndex, turnLabel, change }) => ({
    relPath: change.relPath!,
    // op 推导：beforeHash 有=modify（fs_delete 的 beforeHash 是删除前内容、afterHash 恒空）；两者皆空=新建
    op: (change.beforeHash ? (change.afterHash ? 'modify' : 'delete') : 'add') as 'add' | 'modify' | 'delete',
    t: change.t,
    changeId: change.id,
    // ★1004o：差异量直接吃记录字段（写入时回填）——原来靠懒加载 RPC 且"0 值不显示/新建短路置 0"，时有时无
    diff: typeof change.diffAdded === 'number' ? { added: change.diffAdded, removed: change.diffRemoved || 0 } : undefined,
    // ★1004n：重载保留旧状态（原来清空→异步判定回来，行会"亮→灰"闪一下）
    state: prevStates.get(change.id)?.state,
    stateKnown: prevStates.get(change.id)?.stateKnown ?? false,
    turnKey,
    turnIndex,
    turnLabel,
  }))
  diffLoaded.value = new Set()
  // 生效判定懒拉：一次批量补（不阻塞列表渲染）
  for (const f of fileEntries.value) void refreshActive(f)
}

/** 单条生效判定（后端权威三态：active/undone/superseded） */
async function refreshActive(f: FileEntryView) {
  if (activeLoading.value.has(f.changeId)) return
  activeLoading.value.add(f.changeId)
  try {
    const v = await chatStore.bridgeRpc('fs.history.status', { sessionId: convId.value, changeId: f.changeId })
    f.state = (v?.state === 'undone' || v?.state === 'superseded') ? v.state : (v?.active ? 'active' : 'superseded')
    f.stateKnown = true
  } catch { /* 快照失效保持未知态（按生效展示） */ }
  finally { activeLoading.value.delete(f.changeId) }
}

/** +N-M 差异量：★1004o 直接吃记录回填字段（rebuildEntries 已填），本函数只兜**旧记录**缺字段的；
 *  0 值也显示（原来"0 不显示 + 新建短路置 0"⇒ 数字时有时无）。删除类的差异量记录里没有，靠这里懒算。 */
async function ensureDiff(f: FileEntryView) {
  if (f.diff || diffLoaded.value.has(f.changeId)) return
  diffLoaded.value.add(f.changeId)
  try {
    const v = await chatStore.bridgeRpc('fs.history.diffStat', { sessionId: convId.value, changeId: f.changeId })
    if (v && typeof v.diffAdded === 'number') f.diff = { added: v.diffAdded, removed: v.diffRemoved || 0 }
  } catch { /* 快照失效时静默（不显示差异量） */ }
}

/** 按轮次过滤文件条目（turnGroups 已按出现序排列，这里保持同一顺序） */
function filesOfTurn(tg: { key: string }): FileEntryView[] {
  const arr = fileEntries.value.filter(f => f.turnKey === tg.key)
  for (const f of arr) void ensureDiff(f)
  return arr
}

/** 实时刷新：mux 投影帧（workspace-changed）触发重拉；面板关闭时忽略 */
function onWsChangedFrame(frame: any) {
  if (!props.open) return
  const p = frame?.payload
  if (p?.type !== 'session/projection' || p.key !== 'workspace-changed') return
  if (p.sessionId && p.sessionId !== convId.value) return
  void loadTree()
  void loadFileChanges()
}
onMounted(() => chatStore.onMessage(onWsChangedFrame))
onUnmounted(() => chatStore.offMessage(onWsChangedFrame))
// 轻轮询兜底（面板打开时 5s 一次）：投影帧丢失（断线重连等）时变更区仍能补上
let pollTimer: ReturnType<typeof setInterval> | null = null
function startPolling() {
  // 组件经 v-if 挂载时 open 已是 true，watch(props.open) 不会触发——挂载也要起表
  if (!pollTimer) pollTimer = setInterval(() => { if (props.open) void loadFileChanges() }, 5000)
}
function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
}
watch(() => props.open, (v) => { v ? startPolling() : stopPolling() })
onMounted(() => { if (props.open) startPolling() })
onUnmounted(stopPolling)

/** 轮次组（0902-3 两级结构的第 1 级）：每条用户消息开一轮（turnIndex），组头=轮次摘要 */
interface TurnGroup { key: string; turnIndex: number | null; label: string; fileCount: number }
const turnGroups = computed<TurnGroup[]>(() => {
  const byTurn = new Map<string, TurnGroup>()
  const out: TurnGroup[] = []
  for (const f of fileEntries.value) {
    // fileEntries 已按 t 倒序、且撤销留痕条目已剔除
    let g = byTurn.get(f.turnKey)
    if (!g) {
      g = {
        key: f.turnKey, turnIndex: f.turnIndex,
        label: f.turnLabel || (f.turnIndex != null ? t('workspace.turnN', { n: f.turnIndex }) : t('workspace.unlabeledTurn')),
        fileCount: 0,
      }
      byTurn.set(f.turnKey, g)
      out.push(g)
    }
    g.fileCount++
  }
  return out
})

/** 轮次整体状态：后端 turnSummary 权威（涵盖该轮全部 AI 更改，不受条目折叠影响）；
 *  未拉到汇总时按"生效"展示（组头撤销按钮不禁用，撤销后状态即时重算） */
function turnState(tg: TurnGroup): 'active' | 'undone' | 'superseded' {
  if (tg.turnIndex == null) return 'active'
  const s = turnSummary.value[tg.turnIndex]
  if (!s) return 'active'
  if (s.undone) return 'undone'
  if (s.supersededAll) return 'superseded'
  return 'active'
}
/** 本轮撤销按钮可用态：以后端干跑探测的 undoable 为准——已被后续轮次覆盖 / 已整轮撤销 /
 *  快照失效无可执行动作的轮次都不在表内 → 禁用。汇总未到达前不禁用（避免加载瞬间闪现灰态）。 */
function turnUndoDisabled(tg: TurnGroup): boolean {
  if (tg.turnIndex == null || !turnSummaryLoaded.value) return false
  return !undoableTurns.value.has(tg.turnIndex)
}
function turnUndoTitle(tg: TurnGroup): string {
  if (undoTurnBusy.value) return t('workspace.undoTurnBusy')
  return t('workspace.undoTurnTip')
}
/** 本轮撤销按钮是否隐藏（0903 反馈：不可撤销直接隐藏，不再显示可点/置灰）：
 *  无轮次标注 / 后端干跑不可撤销（已整轮撤销、被后续覆盖、快照失效）/ 该轮全部为首次产出
 *  （新建类，整轮撤销=删掉整批文件，语义不合理）→ 一律不显示 */
function turnUndoHidden(tg: TurnGroup): boolean {
  if (tg.turnIndex == null || turnUndoDisabled(tg)) return true
  const fs = fileEntries.value.filter(f => f.turnKey === tg.key)
  return fs.length > 0 && fs.every(f => f.op === 'add')
}
/** 轮次组展开/折叠（0903 反馈：默认折叠、点组头任意处切换；展开态仅内存）。
 *  反转语义=登记"已展开"的 key，未登记一律折叠——新到达的轮次自动默认折叠 */
const expandedTurns = ref<Set<string>>(new Set())
function turnCollapsed(key: string): boolean {
  return !expandedTurns.value.has(key)
}
function toggleTurnCollapsed(key: string) {
  const s = new Set(expandedTurns.value)
  if (s.has(key)) s.delete(key); else s.add(key)
  expandedTurns.value = s
}

/** 定位到对话：change 轮次 → 聊天窗口滚动到该轮用户消息（无轮次标注的记录禁用） */
function locateTurn(turnIndex: number | null) {
  if (turnIndex == null) return
  window.dispatchEvent(new CustomEvent('nis-locate-turn', { detail: { turnIndex } }))
}

/** 文件 ↔ 对话双向临时高亮（0904 定稿；本轮反馈①升级）：点击文件条目 → 该文件在**所有轮次**
 *  的变更记录一起点亮（含被折叠轮次，自动展开），同时聊天里同文件相关位置点亮。
 *  单目标 10s 自动消失，再次点击换目标重新计时。 */
const highlightRelPath = ref<string | null>(null)
let highlightTimer: ReturnType<typeof setTimeout> | null = null
/** ★ 0921：高亮存活时长 = 扫光动画总时长（0.75s delay + 1.4s×2 ≈ 3.6s），留 4s 余量。
 *  原来 10s —— 挂太久时切屏回来会重播动画（见 setLocalHighlight 注释）。 */
const HIGHLIGHT_MS = 4000
/** 展开所有含该文件的折叠轮次组（保证历史记录可见） */
function expandGroupsFor(relPath: string) {
  const s = new Set(expandedTurns.value)
  let changed = false
  for (const f of fileEntries.value) {
    if (f.relPath === relPath && !s.has(f.turnKey)) { s.add(f.turnKey); changed = true }
  }
  if (changed) expandedTurns.value = s
}
function setLocalHighlight(relPath: string | null) {
  highlightRelPath.value = relPath
  if (relPath) expandGroupsFor(relPath)
  if (highlightTimer) clearTimeout(highlightTimer)
  /* ★ 0921：10s → 动画总时长。class 挂太久时，切走再切回来（元素 display:none → 可见）
     会让 CSS 动画**重播** = 反馈的"切屏回来又亮一次"。 */
  if (relPath) highlightTimer = setTimeout(() => { highlightRelPath.value = null }, HIGHLIGHT_MS)
}
/** ★ 0921：页面重新可见时清掉残留高亮（与 PiChatView 同一口径） */
function onDocVisibleClearPanelHighlight(): void {
  if (document.visibilityState !== 'visible') return
  highlightRelPath.value = null
  if (highlightTimer) { clearTimeout(highlightTimer); highlightTimer = null }
}
function onFileHighlight(e: Event) {
  const d = (e as CustomEvent).detail || {}
  if (String(d.convId || '') !== convId.value) return
  // 聊天侧点来的按 relPath 反查（产物卡/工具行只有路径没有 changeId）
  if (!d.relPath) return
  if (!fileEntries.value.some(f => f.relPath === String(d.relPath))) return
  setLocalHighlight(String(d.relPath))
}
onMounted(() => {
  window.addEventListener('nis-file-highlight', onFileHighlight)
  document.addEventListener('visibilitychange', onDocVisibleClearPanelHighlight)
})
onUnmounted(() => {
  window.removeEventListener('nis-file-highlight', onFileHighlight)
  document.removeEventListener('visibilitychange', onDocVisibleClearPanelHighlight)
  if (highlightTimer) clearTimeout(highlightTimer)
})
/** 面板文件条目点击：本面板点亮该文件全部记录 + 通知聊天侧高亮同文件（单目标、10s） */
function highlightFileEverywhere(f: FileEntryView, turnIndex: number | null) {
  setLocalHighlight(f.relPath)
  window.dispatchEvent(new CustomEvent('nis-file-highlight', {
    detail: { convId: convId.value, relPath: f.relPath, turnIndex, changeId: f.changeId },
  }))
}

/** 审查：小窗 diff 对比快照版本 vs 当前版本（内容直读；f 需带 beforeHash 时走 change 反查） */
const reviewing = ref<{ path: string; beforeContent: string; currentContent: string; changeId: string } | null>(null)
async function reviewFile(f: { relPath: string; changeId: string }) {
  try {
    const ch = fileChanges.value.find(c => c.id === f.changeId)
    let beforeContent = ''
    if (ch?.beforeHash) {
      const r = await chatStore.bridgeRpc('fs.history.readObject', { sessionId: convId.value, hash: ch.beforeHash })
      beforeContent = String(r?.content || '')
    }
    const cur = await chatStore.bridgeRpc('fs.readFile', { sessionId: convId.value, path: f.relPath, maxChars: 200000 }).catch(() => null)
    const currentContent = String(cur?.content || '')
    reviewing.value = { path: f.relPath, beforeContent, currentContent, changeId: f.changeId }
  } catch (e: any) { console.error('[WorkspacePanel] review failed:', e) }
}

/** 0902-3 新交互：撤销/恢复直接执行（不再弹确认）；仅当后端报冲突（快照后又被手改过）
 *  时才弹确认，给"仍然恢复/另存副本"分支——常规路径零打断，文件被手改的内容不静默丢失 */
const restoreConfirm = ref<{ path: string; changeId: string; conflict: boolean; mode: 'undo' | 'redo' } | null>(null)
async function quickUndo(f: FileEntryView) { await doChange(f, 'undo') }
async function quickRedo(f: FileEntryView) { await doChange(f, 'redo') }
async function doChange(f: FileEntryView, mode: 'undo' | 'redo', force = false) {
  try {
    // 恢复（redo）的对象是"撤销留痕"记录（restoreChange 写留痕的 beforeHash=原条目 afterHash，
    // 恢复它=写回 AI 修改后状态）；撤销（undo）直接对原条目（写回 beforeHash=修改前状态）
    let targetId = f.changeId
    if (mode === 'redo') {
      const traces = fileChanges.value.filter(c => c.undoOf === f.changeId)
      const trace = traces[traces.length - 1]
      if (!trace) { console.error('[WorkspacePanel] redo: undo trace not found'); return }
      targetId = trace.id
    }
    let conflict = false
    if (!force) {
      const v = await chatStore.bridgeRpc('fs.history.checkConflict', { sessionId: convId.value, changeId: targetId })
      conflict = !!v?.conflict
    }
    if (conflict && !force) {
      restoreConfirm.value = { path: f.relPath, changeId: f.changeId, conflict: true, mode }
      return
    }
    const r = await chatStore.bridgeRpc('fs.history.restore', { sessionId: convId.value, changeId: targetId, force })
    if (r?.ok) {
      // 立即重判原条目三态（不等下一次轮询：撤销/恢复按钮即时切换，文件同步回原状态）
      const v = await chatStore.bridgeRpc('fs.history.status', { sessionId: convId.value, changeId: f.changeId }).catch(() => null)
      f.state = (v?.state === 'undone' || v?.state === 'superseded') ? v.state : (v?.active ? 'active' : 'superseded')
      f.stateKnown = true
      await Promise.all([loadTree(), loadFileChanges()])
    } else {
      console.error('[WorkspacePanel] restore failed:', r?.error)
    }
  } catch (e: any) { console.error('[WorkspacePanel] restore failed:', e) }
}
async function doRestore() {
  const rc = restoreConfirm.value
  if (!rc) return
  restoreConfirm.value = null
  const entry = fileEntries.value.find(x => x.changeId === rc.changeId)
  if (entry) await doChange(entry, rc.mode, true)
}
/** 点击黄字条目本体 = 恢复这条修改（仅"已撤销"态可点；被覆盖态灰字不可点） */
function toggleFileActive(f: FileEntryView) {
  if (f.stateKnown && f.state === 'undone') void quickRedo(f)
}
/** 0910 三批④：本轮撤销弹窗——可选「连同本轮改动一起恢复」（文件还原+产物删除+上下文清除）
 *  或「只清除上下文」（文件保持现状）。底层历史已按对话隔离（只动本对话的改动）。 */
const undoTurnBusy = ref<string | null>(null)
const undoDialog = ref<{ turnIndex: number; turnKey: string; withFiles: boolean; busy: boolean; conflicts: string[] | null; err: string } | null>(null)
function undoWholeTurn(tg: TurnGroup) {
  if (tg.turnIndex == null || undoTurnBusy.value) return
  undoDialog.value = { turnIndex: tg.turnIndex, turnKey: tg.key, withFiles: true, busy: false, conflicts: null, err: '' }
}
/** 删轮次后按后端权威重放时间线（与 PiChatView 的删除轮次同款） */
async function reloadTimeline() {
  const result = await chatStore.bridgeRpc('session.history', { sessionId: convId.value })
  if (result?.messages) {
    piChat.loadHistory(convId.value, result.messages, Array.isArray(result.compactions) ? result.compactions : undefined,
      Array.isArray(result.runningTools) ? result.runningTools : undefined)
    // ★ 0922z：全量重放 → 分页游标复位（DOM 里已是全部历史，防上滑重复前插）
  }
}
async function runUndo() {
  const d = undoDialog.value
  if (!d || d.busy) return
  d.busy = true
  d.err = ''
  try {
    if (d.withFiles) {
      const r = await chatStore.bridgeRpc('fs.history.restoreTurn', {
        sessionId: convId.value, turnIndex: d.turnIndex,
        ...(d.conflicts ? { confirmConflicts: true } : {}),
      })
      if (r?.needConfirm) { d.conflicts = Array.isArray(r.conflicts) ? r.conflicts : []; d.busy = false; return }
      if (r?.ok === false) throw new Error(String(r?.error || '撤销失败'))
      await Promise.all([loadTree(), loadFileChanges()])
    }
    // 清上下文（两种模式都清；文件是否还原由 withFiles 决定）
    const dr = await chatStore.bridgeRpc('session.deleteTurn', { sessionId: convId.value, turnIndex: d.turnIndex })
    if (dr?.ok === false) throw new Error(String(dr.error || '清除上下文失败'))
    await reloadTimeline()
    undoDialog.value = null
  } catch (e: any) {
    if (undoDialog.value) undoDialog.value.err = String(e?.message || e || '撤销失败')
  } finally {
    if (undoDialog.value) undoDialog.value.busy = false
  }
}
async function saveRestoredCopy() {
  const rc = restoreConfirm.value
  if (!rc) return
  const ch = fileChanges.value.find(c => c.id === rc.changeId)
  try {
    const r = await chatStore.bridgeRpc('fs.history.saveRestoredCopy', { sessionId: convId.value, hash: ch?.beforeHash || '', relPath: rc.path })
    if (r?.ok) { restoreConfirm.value = null; await loadTree() }
  } catch (e: any) { console.error('[WorkspacePanel] saveRestoredCopy failed:', e) }
}

/* ★ 0925n（需求的）：工作区文件搜索 —— 按名称过滤树（不区分大小写）；
   文件夹在"自身或任一后代命中"时保留（带出路径上下文），无命中子树的枝干不保留。 */
const searchQuery = ref('')
function filterTree(nodes: TreeNode[], q: string): TreeNode[] {
  const out: TreeNode[] = []
  for (const n of nodes || []) {
    const kids = Array.isArray(n.children) ? filterTree(n.children, q) : undefined
    const selfHit = String(n.name || '').toLowerCase().includes(q)
    if (selfHit || (kids && kids.length)) out.push(kids ? { ...n, children: kids } : n)
  }
  return out
}
const filteredTree = computed(() => {
  const q = searchQuery.value.trim().toLowerCase()
  if (!q) return tree.value
  return filterTree(tree.value, q)
})

async function loadTree() {
  if (!convId.value) { tree.value = []; return }
  loading.value = true
  try {
    const v = await chatStore.bridgeRpc('workspace.tree', { sessionId: convId.value })
    tree.value = Array.isArray(v?.tree) ? v.tree : []
    rootPath.value = String(v?.root || '')
  } catch { tree.value = [] }
  finally { loading.value = false }
}

watch(() => convId.value, () => { tree.value = []; expanded.value = {}; fileEntries.value = []; loadTree(); loadFileChanges() })
watch(() => props.open, (v) => { if (v) { loadTree(); loadFileChanges(); nextTick(initHeights) } })
onMounted(() => { if (props.open) { loadTree(); loadFileChanges(); nextTick(initHeights) } })

function toggle(node: TreeNode, base: string) {
  const k = base ? `${base}/${node.name}` : node.name
  expanded.value[k] = !expanded.value[k]
}

const MIME: Record<string, string> = {
  '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.pdf': 'application/pdf', '.md': 'text/plain',
}
function extOf(p: string): string {
  const n = p.split('/').pop() || p
  const i = n.lastIndexOf('.')
  return i === -1 ? '' : n.slice(i).toLowerCase()
}
const imageExts = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico', '.bmp'])
const htmlExts = new Set(['.html', '.htm'])

/* ── 右键菜单 ── */
const ctxGlobal = useGlobalContextMenu()
const busy = ref('')
/** 根节点展开/折叠（默认展开） */
const rootExpanded = ref(true)

/** 根目录右键：只有刷新/复制路径（根目录名不可重命名/删除） */
function rootMenu(e: MouseEvent) {
  ctxGlobal.open([
    { label: t('filetree.refresh'), icon: 'fas fa-sync-alt', action: () => loadTree() },
    { label: t('filetree.copyPath'), icon: 'fas fa-copy', action: () => navigator.clipboard?.writeText(rootPath.value || '') },
  ], e.clientX, e.clientY)
}

/** 文件重命名（仅文件；根目录与文件夹不提供）：内联输入 + fs.rename RPC */
const renameTarget = ref<string | null>(null)
const renameValue = ref('')
const renameBusy = ref(false)
function startRename(p: string) {
  const name = p.split('/').pop() || p
  renameTarget.value = p
  renameValue.value = name
}
async function confirmRename() {
  const p = renameTarget.value
  const newName = renameValue.value.trim()
  renameTarget.value = null
  if (!p || !newName || newName === (p.split('/').pop() || '')) return
  if (/[\\/]/.test(newName)) { console.error('[WorkspacePanel] rename: 名称不能包含路径分隔符'); return }
  renameBusy.value = true
  try {
    const dir = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : ''
    const newPath = dir ? `${dir}/${newName}` : newName
    await chatStore.bridgeRpc('fs.rename', { sessionId: convId.value, path: p, newName })
    await loadTree()
  } catch (e: any) { console.error('[WorkspacePanel] rename failed:', e) }
  finally { renameBusy.value = false }
}

/** ★1004p：文件变更行右键 —— 打开所在目录/复制路径（与文件树节点菜单同款动作；relPath 跨盘符时是绝对路径，直接可用） */
function fileRowMenu(e: MouseEvent, f: FileEntryView) {
  if (!f.relPath) return
  e.preventDefault()
  e.stopPropagation()
  const p = f.relPath
  ctxGlobal.open([
    { label: t('workspace.reveal'), icon: 'fas fa-folder-open', action: () => reveal(p) },
    { label: t('filetree.copyPath'), icon: 'fas fa-copy', action: () => navigator.clipboard?.writeText(p) },
  ], e.clientX, e.clientY)
}

function nodeMenu(node: TreeNode, base: string, e: MouseEvent) {
  if (e.button !== 2) return
  e.preventDefault()
  const p = base ? `${base}/${node.name}` : node.name
  // 复制到剪贴板用绝对路径（旧版 p 是工作区相对名，根目录下文件会只复制成"index.html"）
  const abs = rootPath.value ? `${rootPath.value.replace(/[\\/]+$/, '')}/${p}` : p
  if (node.type === 'folder') {
    ctxGlobal.open([
      { label: t('filetree.refresh'), icon: 'fas fa-sync-alt', action: () => loadTree() },
      { label: t('filetree.copyPath'), icon: 'fas fa-copy', action: () => navigator.clipboard?.writeText(abs) },
    ], e.clientX, e.clientY)
    return
  }
  const items: ContextMenuItem[] = [
    { label: t('workspace.preview'), icon: 'fas fa-eye', action: () => openPreview(p) },
    { label: t('workspace.addToInput'), icon: 'fas fa-at', action: () => window.dispatchEvent(new CustomEvent('nis-add-file-ref', { detail: { relPath: p, name: node.name } })) },
  ]
  if (htmlExts.has(extOf(p))) items.push({ label: t('workspace.openInBrowser'), icon: 'fas fa-globe', action: () => openInBrowser(p) })
  items.push(
    { label: t('chat.rename'), icon: 'fas fa-pen', action: () => startRename(p) },
    { label: t('workspace.reveal'), icon: 'fas fa-folder-open', action: () => reveal(p) },
    { label: t('filetree.copyPath'), icon: 'fas fa-copy', action: () => navigator.clipboard?.writeText(abs) },
    { divider: true },
    { label: t('chat.delete'), icon: 'fas fa-trash-can', danger: true, action: () => { deleteTarget.value = p } },
  )
  ctxGlobal.open(items, e.clientX, e.clientY)
}

async function openPreview(p: string) {
  const ext = extOf(p)
  try {
    if (htmlExts.has(ext)) {
      const r = await chatStore.bridgeRpc('fs.readFile', { sessionId: convId.value, path: p, maxChars: 200000 })
      previewTabs.openTab(convId.value, { key: 'file:' + p, kind: 'html', title: p.split('/').pop() || p, content: r?.content || '', srcPath: p, viewMode: 'page' })
    } else if (imageExts.has(ext)) {
      const r = await chatStore.bridgeRpc('fs.readFile', { sessionId: convId.value, path: p, encoding: 'base64' })
      previewTabs.openTab(convId.value, { key: 'file:' + p, kind: 'image', title: p.split('/').pop() || p, dataUrl: 'data:' + (MIME[ext] || 'image/png') + ';base64,' + (r?.data || '') })
    } else {
      const r = await chatStore.bridgeRpc('fs.readFile', { sessionId: convId.value, path: p, encoding: 'base64' })
      const bin = atob(r?.data || '')
      const bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      previewTabs.openTab(convId.value, {
        key: 'file:' + p, kind: 'file', title: p.split('/').pop() || p,
        file: new Blob([bytes], { type: MIME[ext] || 'application/octet-stream' }),
        mimeType: MIME[ext] || undefined,
      })
    }
  } catch (e: any) { console.error('[WorkspacePanel] preview failed:', e) }
}

async function openInBrowser(p: string) {
  if (busy.value) return
  busy.value = p
  try { await chatStore.bridgeRpc('fs.openInBrowser', { sessionId: convId.value, path: p }) } catch (e: any) { console.error(e) }
  finally { busy.value = '' }
}

async function reveal(p: string) {
  if (busy.value) return
  busy.value = p
  try { await chatStore.bridgeRpc('fs.reveal', { sessionId: convId.value, path: p }) } catch (e: any) { console.error(e) }
  finally { busy.value = '' }
}

/** 打开工作区根目录（系统文件管理器）：'.' 解析为工作区本身 */
async function openRoot() {
  try { await chatStore.bridgeRpc('fs.reveal', { sessionId: convId.value, path: '.' }) } catch (e: any) { console.error(e) }
}

/* ── 两区限高 + 可拖拽分隔（0902 反馈 #5；0904 反馈③重构；0930 删「最近打开」降两区）：
 *    文件树 / 文件变更，面板总高度不变（外层不滚动），各区内部独立滚动。
 *    ★ 持久化的是**比例**不是像素（ResizeObserver 按当前比例重折像素，容器高度变化不崩）。── */
const SEC_KEY = computed(() => `nis-ws-sec-h-${convId.value || 'default'}`)
/** 两区高度（px，由比例×容器高折算）。初始 1:1 */
const secHeights = ref<{ tree: number; changes: number }>({ tree: 300, changes: 300 })
const bodyRef = ref<HTMLElement | null>(null)

function initHeights() {
  const total = bodyRef.value?.clientHeight || 600
  try {
    const raw = localStore.getItem(SEC_KEY.value)
    if (raw) {
      const p = JSON.parse(raw)
      if (typeof p.tree === 'number' && typeof p.changes === 'number' && p.tree + p.changes > 0) {
        // 存值当比例用（旧版像素值的比例关系依然成立；旧三区存值按 tree/changes 两段折算）
        applyRatio(total, p.tree, p.changes)
        return
      }
    }
  } catch { /* ignore */ }
  applyRatio(total, 1, 1)
}
/** 按容器高度与比例折算两区 px 高度（MIN 兜底保证各区最低可用，总高恒 ≤ 容器高） */
function applyRatio(total: number, a: number, b: number) {
  const usable = Math.max(120, total - 24)
  if (a + b <= 0) { a = 1; b = 1 }
  secHeights.value = {
    tree: Math.round(usable * a / (a + b)),
    changes: Math.round(usable * b / (a + b)),
  }
}
/** 容器尺寸联动（0904 反馈③）：窗口变高/变矮 → 按当前比例重折两区像素 */
let bodyRO: ResizeObserver | null = null
function attachBodyRO() {
  if (typeof ResizeObserver === 'undefined' || !bodyRef.value) return
  bodyRO?.disconnect()
  bodyRO = new ResizeObserver((entries) => {
    const h = Math.ceil(entries[0]?.contentRect.height || 0)
    if (h <= 0) return
    const cur = secHeights.value
    applyRatio(h, cur.tree, cur.changes)
  })
  bodyRO.observe(bodyRef.value)
}
watch(bodyRef, (el) => { if (el) attachBodyRO() })
onUnmounted(() => { bodyRO?.disconnect(); bodyRO = null })
function persistHeights() {
  try { localStore.setItem(SEC_KEY.value, JSON.stringify(secHeights.value)) } catch { /* ignore */ }
}

/** 拖拽状态：拖 tree/changes 之间那根分隔条 */
const dragBar = ref<'top' | null>(null)
const MIN_SEC = 56
function startDrag(e: MouseEvent) {
  dragBar.value = 'top'
  e.preventDefault()
  const startY = e.clientY
  const start = { ...secHeights.value }
  const onMove = (ev: MouseEvent) => {
    const dy = ev.clientY - startY
    // tree 与 changes 互换高度（总高不变）
    const t = Math.min(Math.max(MIN_SEC, start.tree + dy), start.tree + start.changes - MIN_SEC)
    secHeights.value = { tree: t, changes: start.tree + start.changes - t }
  }
  const onUp = () => {
    dragBar.value = null
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onUp)
    persistHeights()
  }
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
}

/** 删除：内联二次确认（用户主动操作，走 fs.delete RPC 不走 AI 审批门禁） */
const deleteTarget = ref<string | null>(null)
async function confirmDelete() {
  const p = deleteTarget.value
  deleteTarget.value = null
  if (!p) return
  try {
    await chatStore.bridgeRpc('fs.delete', { sessionId: convId.value, path: p })
    await loadTree()
  } catch (e: any) { console.error('[WorkspacePanel] delete failed:', e) }
}
</script>

<template>
  <div class="w-[300px] min-w-0 h-full bg-white border-l border-gray-200 flex flex-col overflow-hidden">
    <div class="px-4 pt-3.5 pb-3 border-b border-gray-100">
      <div class="flex items-center justify-between">
        <h3 class="text-[14px] font-[640] text-gray-800 flex items-center gap-2">
          <i class="fas fa-folder-tree text-[12px] text-gray-400"></i>{{ t('workspace.title') }}
        </h3>
        <div class="flex items-center gap-1">
          <button class="w-6 h-6 shrink-0 rounded-[9999px] flex items-center justify-center text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors" :title="t('filetree.refresh')" @click="loadTree">
            <i class="fas fa-rotate text-[12px]"></i>
          </button>
          <button class="w-6 h-6 shrink-0 rounded-[9999px] flex items-center justify-center text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors" :title="t('workspace.close')" @click="emit('close')">
            <i class="fas fa-xmark text-[14px]"></i>
          </button>
        </div>
      </div>
      <!-- 工作区根目录行：路径 + 打开目录按钮（系统文件管理器） -->
      <div class="flex items-center gap-1.5 mt-1">
        <span class="text-[10px] text-gray-300 truncate flex-1" :title="rootPath">{{ rootPath || t('workspace.noWorkspace') }}</span>
        <button
          v-if="rootPath"
          class="shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors"
          :title="t('workspace.openRoot')"
          @click="openRoot"
        >
          <i class="fas fa-arrow-up-right-from-square text-[10px]"></i>
        </button>
      </div>
      <!-- ★ 0925n（需求的）：文件搜索 —— 按名称过滤文件树（不区分大小写，保留命中路径上下文） -->
      <div class="flex items-center gap-1.5 mt-1.5">
        <div class="flex items-center gap-1.5 flex-1 px-2 py-1 rounded-lg bg-gray-50 border border-gray-100 focus-within:border-indigo-200 transition-colors">
          <i class="fas fa-magnifying-glass text-[10px] text-gray-400"></i>
          <input
            v-model="searchQuery"
            class="flex-1 min-w-0 bg-transparent text-[11px] text-gray-600 outline-none"
            :placeholder="t('workspace.searchPlaceholder')"
            @keydown.esc="searchQuery = ''"
          />
          <button v-if="searchQuery" class="text-gray-400 hover:text-gray-600 transition-colors" :title="t('workspace.searchClear')" @click="searchQuery = ''">
            <i class="fas fa-times text-[10px]"></i>
          </button>
        </div>
      </div>
    </div>

    <!-- 两区限高（0902 反馈 #5）：外层不滚动，文件树/文件变更各自内部滚动；拖拽条调整占比（总高不变） -->
    <div ref="bodyRef" class="flex-1 min-h-0 flex flex-col overflow-hidden px-2 py-2 text-sm">
      <div v-if="loading && !tree.length" class="py-10 text-center text-[12px] text-gray-400 flex-1">{{ t('workspace.loading') }}</div>
      <template v-else>
        <!-- 区1：文件树 -->
        <div class="flex flex-col overflow-hidden shrink-0" :style="{ height: secHeights.tree + 'px' }">
          <div class="flex-1 min-h-0 overflow-y-auto custom-scroll">
            <div
              class="flex items-center gap-1.5 px-1.5 py-1 rounded-md bg-gray-50/80 hover:bg-gray-100 cursor-pointer select-none transition-colors"
              :title="t('workspace.clickToggle')"
              @click="rootExpanded = !rootExpanded"
              @contextmenu.prevent="rootMenu($event)"
            >
              <i :class="['fas text-[9px] text-gray-300 w-3 transition-transform duration-150', rootExpanded ? 'fa-chevron-down' : 'fa-chevron-right']"></i>
              <i class="fas fa-folder text-[12px] text-amber-400"></i>
              <span class="text-[12px] font-[530] text-gray-700 truncate">{{ rootName }}</span>
            </div>
            <div v-if="rootExpanded" class="border-l border-dashed border-gray-100 ml-[13px] pl-1">
              <div v-if="!tree.length" class="py-2 px-2 text-[12px] text-gray-300">{{ t('workspace.emptyDir') }}</div>
              <div v-else-if="searchQuery && !filteredTree.length" class="py-2 px-2 text-[12px] text-gray-400">{{ t('workspace.searchEmpty') }}</div>
              <div v-for="node in filteredTree" :key="node.name">
                <WorkspaceNode
                  :node="node" :base="''" :depth="0"
                  :expanded="expanded"
                  @toggle="(n: any, b: string) => toggle(n, b)"
                  @menu="(n: any, b: string, e: MouseEvent) => nodeMenu(n, b, e)"
                  @open-file="(p: string) => openPreview(p)"
                />
              </div>
            </div>
          </div>
        </div>

        <!-- 拖拽条 1（树/变更之间）：0904 反馈改细线——视觉 1px 横线，外层 8px 高透明热区保留拖拽手感 -->
        <div
          class="group/drag shrink-0 h-2 flex items-center cursor-row-resize"
          :title="t('workspace.dragResize')"
          @mousedown="startDrag($event)"
        >
          <div class="h-px w-full transition-colors" :class="dragBar === 'top' ? 'bg-indigo-400' : 'bg-gray-200 group-hover/drag:bg-gray-400'"></div>
        </div>

        <!-- 区2：文件变更记录（0902-3 两级结构：轮次 → 被改动的文件）。
             组头=展开/折叠 + 消息摘要 + N文件 + 本轮撤销/定位（整轮被覆盖时本轮撤销禁用）；
             条目三态：active 悬停可撤销 / undone 黄字"已撤销"+悬停可恢复 / superseded 灰字+撤销禁用；
             生效判定=afterHash 是否等于当前文件内容 + undoOf 留痕区分已撤销/被覆盖；撤销/恢复直接执行，仅冲突时弹确认） -->
        <div v-if="turnGroups.length" class="flex flex-col overflow-hidden shrink-0" :style="{ height: secHeights.changes + 'px' }">
          <div class="flex-1 min-h-0 overflow-y-auto custom-scroll">
          <div class="px-2 pt-2 pb-2 flex items-center justify-between sticky top-0 bg-white z-10 border-b border-gray-100">
            <span class="text-[12px] font-[640] text-gray-800 tracking-wide">{{ t('workspace.fileChanges') }}</span>
            <i v-if="loadingChanges" class="fas fa-circle-notch fa-spin text-[9px] text-gray-400"></i>
          </div>
          <div v-for="tg in turnGroups" :key="tg.key" class="mb-1">
            <!-- 轮次组头（0902-3 反馈 #1）：展开/折叠 + 用户消息摘要（截断） + 本轮文件数；
                 0903 反馈：整行（到 N文件 为止）可点切换折叠、默认折叠；
                 本轮撤销不可撤销（已撤销/被覆盖/快照失效/整轮全是首次产出）直接隐藏不显示 -->
            <div
              class="flex items-center gap-1.5 px-1.5 py-1.5 rounded-md bg-gray-50/70 cursor-pointer hover:bg-gray-100/80 transition-colors select-none"
              :title="turnCollapsed(tg.key) ? t('workspace.expandTurn') : t('workspace.collapseTurn')"
              @click="toggleTurnCollapsed(tg.key)"
            >
              <i :class="['fas text-[8px] text-gray-400 w-3.5 shrink-0 text-center transition-transform duration-200', turnCollapsed(tg.key) ? 'fa-chevron-right' : 'fa-chevron-down']"></i>
              <i class="fas fa-comment-dots text-[9px] text-gray-400 w-3 shrink-0"></i>
              <span class="text-[11px] font-medium text-gray-600 truncate flex-1 min-w-0" :title="tg.label">{{ tg.label }}</span>
              <span v-if="tg.turnIndex != null && turnSummary[tg.turnIndex]" class="text-[9px] text-gray-400 shrink-0">{{ t('workspace.fileCount', { n: turnSummary[tg.turnIndex].fileCount }) }}</span>
              <span v-else class="text-[9px] text-gray-400 shrink-0">{{ t('workspace.fileCount', { n: tg.fileCount }) }}</span>
              <span v-if="turnState(tg) === 'undone'" class="text-[9px] text-gray-400 shrink-0">{{ t('workspace.undone') }}</span>
              <button
                v-if="!turnUndoHidden(tg)"
                class="shrink-0 text-[10px] text-gray-300 hover:text-amber-500 px-1 transition-colors"
                :class="{ 'opacity-40': undoTurnBusy !== null }"
                :title="turnUndoTitle(tg)"
                @click.stop="undoWholeTurn(tg)"
              ><i :class="['fas', undoTurnBusy === tg.key ? 'fa-circle-notch fa-spin' : 'fa-rotate-left']"></i></button>
              <button
                v-if="tg.turnIndex != null"
                class="shrink-0 text-[10px] text-gray-300 hover:text-indigo-500 px-1 transition-colors"
                :title="t('workspace.locateTurn')"
                @click.stop="locateTurn(tg.turnIndex)"
              ><i class="fas fa-crosshairs"></i></button>
            </div>
            <!-- 轮内文件条目（折叠时隐藏）。三态（0902-3 反馈 #2）：
                 active=正常（悬停可撤销）；undone=黄字"已撤销"+悬停可恢复；
                 superseded=被后续轮次改动覆盖 → 整行灰、撤销/恢复禁用，+N-M/审查照常 -->
            <template v-if="!turnCollapsed(tg.key)">
            <div
              v-for="f in filesOfTurn(tg)"
              :key="f.changeId"
              class="flex items-center gap-1.5 px-2 py-1.5 rounded-lg ml-2 group hover:bg-gray-100/70 transition-colors"
              :class="[
                f.stateKnown && f.state === 'superseded' ? 'opacity-60' : '',
                highlightRelPath === f.relPath ? 'file-highlight-flash' : '',
              ]"
              @click="highlightFileEverywhere(f, tg.turnIndex)"
              @contextmenu.prevent.stop="fileRowMenu($event, f)"
            >
              <!-- 左侧操作色标（新增绿/删除红/修改蓝）：让"这一行是什么类型的变更"一眼可辨 -->
              <span class="shrink-0 w-[3px] h-[13px] rounded-full" :class="f.stateKnown && f.state === 'superseded' ? 'bg-gray-200' : f.op === 'add' ? 'bg-emerald-400' : f.op === 'delete' ? 'bg-red-400' : 'bg-sky-400'"></span>
              <i :class="['fas text-[9px] w-3 shrink-0 text-center', f.op === 'add' ? 'fa-plus' : f.op === 'delete' ? 'fa-minus' : 'fa-pen', f.stateKnown && f.state === 'superseded' ? 'text-gray-300' : f.op === 'add' ? 'text-emerald-400' : f.op === 'delete' ? 'text-red-400' : 'text-sky-400']"></i>
              <span
                class="text-[12px] truncate flex-1 ws-file-name"
                :class="f.stateKnown && f.state === 'undone' ? 'text-amber-600 cursor-pointer' : f.stateKnown && f.state === 'superseded' ? 'text-gray-400' : 'text-gray-700'"
                :title="f.stateKnown && f.state === 'undone' ? t('workspace.undoneEntry', { path: f.relPath }) : f.stateKnown && f.state === 'superseded' ? t('workspace.supersededEntry', { path: f.relPath }) : f.relPath"
                @click="toggleFileActive(f)"
              >{{ f.relPath }}</span>
              <!-- +N-M 差异量（懒算：条目渲染后补） -->
              <span v-if="f.diff" class="text-[12px] shrink-0 font-mono font-[640]">
                <span v-if="f.diff.added" class="text-emerald-500">+{{ f.diff.added }}</span><span v-if="f.diff.removed" class="text-red-400">-{{ f.diff.removed }}</span>
              </span>
              <span v-if="f.stateKnown && f.state === 'undone'" class="text-[9px] text-amber-500 shrink-0">{{ t('workspace.undone') }}</span>
              <span class="text-[9px] text-gray-400 shrink-0 group-hover:hidden">{{ fmtTime(f.t) }}</span>
              <!-- 悬停 icon 按钮组（默认隐藏占位，防止行高跳动） -->
              <span class="hidden group-hover:flex items-center shrink-0">
                <button
                  class="text-[10px] text-gray-400 hover:text-indigo-500 px-1 transition-colors"
                  :title="t('workspace.reviewBtn')"
                  @click.stop="reviewFile(f)"
                ><i class="fas fa-code-compare"></i></button>
                <!-- superseded：撤销禁用（版本已被后续改动推进，不能跨版本回退）；
                     undone：恢复（回到 AI 修改后状态）；
                     add（首次产出）/其它不可撤销：直接隐藏撤销按钮（0903 反馈：不显示置灰态）；
                     其余 active/未知：撤销（回到修改前） -->
                <button
                  v-if="f.stateKnown && f.state === 'superseded'"
                  class="text-[10px] text-gray-300 px-1 cursor-not-allowed"
                  :title="t('workspace.undoDisabled')"
                  disabled
                ><i class="fas fa-rotate-left"></i></button>
                <button
                  v-else-if="f.stateKnown && f.state === 'undone'"
                  class="text-[10px] text-gray-400 hover:text-amber-600 px-1 transition-colors"
                  :title="t('workspace.redoBtn')"
                  @click.stop="quickRedo(f)"
                ><i class="fas fa-rotate-right"></i></button>
                <button
                  v-else-if="f.op !== 'add'"
                  class="text-[10px] text-gray-400 hover:text-amber-600 px-1 transition-colors"
                  :title="t('workspace.undoBtn')"
                  @click.stop="quickUndo(f)"
                ><i class="fas fa-rotate-left"></i></button>
              </span>
            </div>
            </template>
          </div>
          </div>
        </div>

      </template>
    </div>

    <!-- 删除二次确认 -->
    <Teleport to="body">
      <div v-if="deleteTarget" class="fixed inset-0 z-[10010] flex items-center justify-center bg-black/40" @click.self="deleteTarget = null">
        <div class="w-[340px] bg-white rounded-2xl shadow-2xl p-6">
          <h3 class="text-[15px] font-[640] text-gray-800 mb-2">{{ t('workspace.deleteFileTitle') }}</h3>
          <p class="text-[13px] text-gray-500 leading-relaxed mb-5 break-all">{{ t('chat.deleteConfirmPrefix') }}{{ deleteTarget }}{{ t('workspace.deleteConfirmSuffix') }}</p>
          <div class="flex justify-end gap-2">
            <button class="px-4 py-2 rounded-lg text-[13px] text-gray-600 hover:bg-gray-50" @click="deleteTarget = null">{{ t('panel.cancel') }}</button>
            <button class="px-4 py-2 rounded-lg text-[13px] text-white bg-red-600 hover:bg-red-500" @click="confirmDelete">{{ t('chat.delete') }}</button>
          </div>
        </div>
      </div>
      <!-- 重命名弹窗（仅文件） -->
      <div v-if="renameTarget" class="fixed inset-0 z-[10010] flex items-center justify-center bg-black/40" @click.self="renameTarget = null">
        <div class="w-[340px] bg-white rounded-2xl shadow-2xl p-6">
          <h3 class="text-[15px] font-[640] text-gray-800 mb-2">{{ t('workspace.renameFileTitle') }}</h3>
          <input
            v-model="renameValue"
            type="text"
            class="w-full border border-gray-200 rounded-lg px-3 py-2 text-[13px] text-gray-800 outline-none focus:border-gray-400 mb-1"
            autofocus
            @keyup.enter="confirmRename"
          />
          <p class="text-[12px] text-gray-400 mb-4 break-all">{{ t('workspace.origPath') }}{{ renameTarget }}</p>
          <div class="flex justify-end gap-2">
            <button class="px-4 py-2 rounded-lg text-[13px] text-gray-600 hover:bg-gray-50" @click="renameTarget = null">{{ t('panel.cancel') }}</button>
            <button class="px-4 py-2 rounded-lg text-[13px] text-white bg-gray-900 hover:bg-gray-700" :disabled="renameBusy" @click="confirmRename">{{ t('chat.rename') }}</button>
          </div>
        </div>
      </div>
      <!-- 审查对比小窗：快照版本 vs 当前版本 -->
      <div v-if="reviewing" class="fixed inset-0 z-[10020] flex items-center justify-center bg-black/50" @click.self="reviewing = null">
        <div class="w-[860px] max-w-[92vw] h-[80vh] bg-white rounded-2xl shadow-2xl flex flex-col overflow-hidden">
          <div class="flex items-center justify-between px-5 py-3 border-b border-gray-100">
            <div class="flex items-center gap-2 min-w-0">
              <i class="fas fa-code-compare text-gray-500 text-sm"></i>
              <h3 class="text-[14px] font-[640] text-gray-800 truncate">{{ t('workspace.review') }}{{ reviewing.path }}</h3>
            </div>
            <button class="w-7 h-7 rounded-full hover:bg-gray-100 text-gray-400 hover:text-gray-600" @click="reviewing = null">
              <i class="fas fa-xmark text-sm"></i>
            </button>
          </div>
          <div class="flex-1 min-h-0 grid grid-cols-2 gap-px bg-gray-100 overflow-hidden">
            <div class="bg-white flex flex-col min-h-0">
              <div class="px-3 py-1.5 text-[12px] font-[530] text-red-500 bg-red-50/60 border-b border-gray-100">{{ t('workspace.beforeSnapshot') }}</div>
              <pre class="flex-1 overflow-auto text-[12px] leading-relaxed p-3 text-gray-700 whitespace-pre-wrap break-all">{{ reviewing.beforeContent || t('workspace.fileAbsentBefore') }}</pre>
            </div>
            <div class="bg-white flex flex-col min-h-0">
              <div class="px-3 py-1.5 text-[12px] font-[530] text-emerald-600 bg-emerald-50/60 border-b border-gray-100">{{ t('workspace.currentVersion') }}</div>
              <pre class="flex-1 overflow-auto text-[12px] leading-relaxed p-3 text-gray-700 whitespace-pre-wrap break-all">{{ reviewing.currentContent || t('workspace.fileAbsentNow') }}</pre>
            </div>
          </div>
          <div class="flex items-center justify-end gap-2 px-4 py-2.5 border-t border-gray-100">
            <button class="px-3.5 py-1.5 rounded-lg text-[12px] text-gray-600 hover:bg-gray-50" @click="reviewing = null">{{ t('workspace.close') }}</button>
          </div>
        </div>
      </div>
      <!-- 撤销/恢复确认弹窗（冲突时给"另存副本"分支） -->
      <div v-if="restoreConfirm" class="fixed inset-0 z-[10030] flex items-center justify-center bg-black/40" @click.self="restoreConfirm = null">
        <div class="w-[400px] bg-white rounded-2xl shadow-2xl p-6">
          <h3 class="text-[15px] font-[640] text-gray-800 mb-2">{{ restoreConfirm.conflict ? t('workspace.fileModified') : (restoreConfirm.mode === 'undo' ? t('workspace.undoChange') : t('workspace.redoChange')) }}</h3>
          <p class="text-[13px] text-gray-500 leading-relaxed mb-4 break-all">
            <template v-if="restoreConfirm.conflict">{{ t('workspace.conflictHint', { path: restoreConfirm.path }) }}</template>
            <template v-else-if="restoreConfirm.mode === 'undo'">{{ t('workspace.undoConfirm', { path: restoreConfirm.path }) }}</template>
            <template v-else>{{ t('workspace.redoConfirm', { path: restoreConfirm.path }) }}</template>
          </p>
          <div class="flex justify-end gap-2 flex-wrap">
            <button class="px-4 py-2 rounded-lg text-[13px] text-gray-600 hover:bg-gray-50" @click="restoreConfirm = null">{{ t('panel.cancel') }}</button>
            <template v-if="restoreConfirm.conflict">
              <button class="px-4 py-2 rounded-lg text-[13px] text-gray-800 border border-gray-200 hover:bg-gray-50" @click="saveRestoredCopy">{{ t('workspace.saveCopy') }}</button>
              <button class="px-4 py-2 rounded-lg text-[13px] text-white bg-red-600 hover:bg-red-500" @click="doRestore">{{ t('workspace.forceRestore') }}</button>
            </template>
            <template v-else>
              <button class="px-4 py-2 rounded-lg text-[13px] text-white bg-gray-900 hover:bg-gray-700" @click="doRestore">{{ t('settings.confirm') }}</button>
            </template>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- 0910 三批④：本轮撤销弹窗——「连同本轮改动一起恢复」或「只清除上下文」 -->
    <Teleport to="body">
      <div v-if="undoDialog" class="fixed inset-0 z-[10020] flex items-center justify-center bg-black/40" @click.self="undoDialog = null">
        <div class="w-[440px] bg-white rounded-2xl shadow-2xl p-5">
          <div class="text-[14px] font-[640] text-gray-900 mb-1">{{ t('workspace.undoTurnTitle', { n: undoDialog.turnIndex }) }}</div>
          <p class="text-[12px] text-gray-500 mb-3 leading-relaxed">{{ t('workspace.undoTurnScope') }}</p>
          <label class="flex items-start gap-2 mb-3 cursor-pointer select-none">
            <input v-model="undoDialog.withFiles" type="checkbox" class="mt-0.5" />
            <span class="text-[12px] text-gray-700 leading-snug">
              <span class="font-[530]">{{ t('workspace.undoWithFiles') }}</span>
              <span class="block text-[11px] text-gray-400 mt-0.5">{{ t('workspace.undoWithFilesDesc') }}</span>
            </span>
          </label>
          <div v-if="undoDialog.conflicts?.length" class="mb-3 px-3 py-2 rounded-lg bg-amber-50 border border-amber-200">
            <div class="text-[11px] text-amber-700 font-[530] mb-1">{{ t('workspace.undoConflictWarn') }}</div>
            <div v-for="p in undoDialog.conflicts" :key="p" class="text-[11px] text-amber-600 font-mono truncate">{{ p }}</div>
          </div>
          <div v-if="undoDialog.err" class="mb-3 text-[11px] text-red-500">{{ undoDialog.err }}</div>
          <div class="flex justify-end gap-2">
            <button class="btn btn-secondary btn-sm" @click="undoDialog = null">{{ t('common.cancel') }}</button>
            <button class="btn btn-danger btn-sm" :disabled="undoDialog.busy" @click="runUndo">
              {{ undoDialog.busy ? t('workspace.undoBusy') : (undoDialog.conflicts?.length ? t('workspace.undoForce') : t('workspace.undoTurnConfirm')) }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>
