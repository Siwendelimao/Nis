<script setup lang="ts">
import { ref, watch, computed, onMounted, onUnmounted } from 'vue'
import { t } from '@/utils/i18n'
import { useMemoryGraphStore } from '@/stores/memoryGraph'

import { useChatStore } from '@/stores/chat'
import { useProjectsStore } from '@/stores/projects'
import GalaxyCanvas from './blocks/GalaxyCanvas.vue'
import type { GalaxyNode, GalaxyEdge } from './blocks/GalaxyCanvas.vue'

const props = defineProps<{
  open: boolean
}>()

const emit = defineEmits<{
  close: []
}>()

const isAnimating = ref(false)
const isClosing = ref(false)
const showModal = ref(false)
/** 全屏模式：星系画布铺满屏幕 */
const isFullscreen = ref(false)
/** 名称显示开关：开启=拉近显示名称；关闭=仅选中/悬停显示 */
const showLabels = ref(true)

watch(() => props.open, (val) => {
  if (val) {
    isClosing.value = false
    showModal.value = true
    isAnimating.value = true
    setTimeout(() => { isAnimating.value = false }, 450)
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
  if (e.key === 'Escape' && props.open) {
    /* 0927 netfix：有未保存的表单编辑态时，Esc 先退出编辑（不直接关弹窗丢内容） */
    if (editing.value) { editing.value = false; return }
    close()
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
  }
}

onMounted(() => document.addEventListener('keydown', handleKeydown))
onUnmounted(() => document.removeEventListener('keydown', handleKeydown))

const store = useMemoryGraphStore()
const chatStore = useChatStore()

// ── 过滤 ──
const keyword = ref('')
const typeFilter = ref('')
/** 只看待确认（自动提炼进审核区，pending_review 标记）。
 *  0914 去重：唯一入口 = 顶部分区「待确认」（列表筛选行/galaxy 角不再重复放 chip） */
const pendingFilter = ref(false)
/** 视图：galaxy（星系图谱）| list（列表） */
const viewMode = ref<'galaxy' | 'list'>('list')  // 0924：默认「记忆」列表（新写的最上面一眼看到）
/** 0914：三区分段（用户拍板：记忆 / 图谱 / 待确认）——图谱=星系视图；待确认=列表中筛 pending */
const ZONES = [
  { value: 'memory', labelKey: 'memory.zoneMemory', icon: 'fas fa-brain' },
  { value: 'graph', labelKey: 'memory.zoneGraph', icon: 'fas fa-star' },
  { value: 'pending', labelKey: 'memory.zonePending', icon: 'fas fa-hourglass-half' },
] as const
const zone = computed<'memory' | 'graph' | 'pending'>({
  get: () => (viewMode.value === 'galaxy' ? 'graph' : pendingFilter.value ? 'pending' : 'memory'),
  set: (z) => {
    if (z === 'graph') { viewMode.value = 'galaxy'; pendingFilter.value = false }
    else if (z === 'memory') { viewMode.value = 'list'; pendingFilter.value = false }
    else { viewMode.value = 'list'; pendingFilter.value = true }
  },
})

/** 记忆检索命中（memories 表，AI memory_search 同源）：搜索词时调 RPC 显示，解决"网图搜不到 AI 能查到的记忆" */
const memoryHits = ref<Array<{ id: string; content: string; memory_type: string; score?: number }>>([])
const memoryHitLoading = ref(false)

function searchMemories(q: string) {
  memoryHits.value = []
  const query = q.trim()
  if (!query) return
  memoryHitLoading.value = true
  chatStore.bridgeRpc('memory.search', { query, top_k: 8 }).then((r) => {
    memoryHits.value = (r?.memories || []).map((m: any) => ({
      id: m.id,
      content: m.content || '',
      memory_type: m.memory_type || '',
      score: m.score,
    }))
  }).catch(() => { /* ignore */ }).finally(() => { memoryHitLoading.value = false })
}

// 搜索词防抖 300ms：同步搜 memories 表（AI 检索同源）
let searchTimer: ReturnType<typeof setTimeout> | null = null
watch(keyword, (q) => {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => searchMemories(q), 300)
})
onUnmounted(() => {
  if (searchTimer) clearTimeout(searchTimer)
})
/* ★1010l：手动整理 —— 调后端 memory.distill（同主题散碎记忆合并成主题草案，进「待确认」）。
   产物只进待确认、不动已确认记忆；失败如实显示原因（不兜底假成功）。 */
const distilling = ref(false)
const distillMsg = ref('')
async function runDistill() {
  if (distilling.value) return
  distilling.value = true
  distillMsg.value = ''
  try {
    const r: any = await chatStore.bridgeRpc('memory.distill', {})
    if (r?.ok === false) distillMsg.value = String(r?.msg || '整理失败')
    else if (Number(r?.saved) > 0) {
      distillMsg.value = `已生成 ${r.saved} 条主题记忆草案 → 见「待确认」，等你把关`
      await store.refresh('all')
    } else distillMsg.value = String(r?.msg || '没有需要合并的同主题记忆')
  } catch (e: any) {
    distillMsg.value = '整理失败：' + String(e?.message || e).slice(0, 80)
  } finally { distilling.value = false }
}

const filteredNodes = computed(() => {
  const kw = keyword.value.trim().toLowerCase()
  return store.nodes.filter(n => {
    if (!n.enabled) return false
    if (pendingFilter.value && !store.isPending(n)) return false
    if (typeFilter.value && n.node_type !== typeFilter.value) return false
    if (!kw) return true
    return (n.title + ' ' + n.summary + ' ' + n.content + ' ' + n.tags.join(' ')).toLowerCase().includes(kw)
    // 0924：按时间倒序兜底 —— 后端 SQL 加了 ORDER BY created_at DESC，但前端若不排，
    // 图谱节点（mnode_）排在记忆节点后面、用户第一眼看到的仍是老数据；兜底排序让
    // "刚写的在最上面"在任何后端版本下都成立（后端未重启时也生效）。
  }).sort((a, b) => (b.created_at || 0) - (a.created_at || 0))
})

/** 0924 二期批6a：冷冻记忆（90 天没被检索用过、且不是新建的）——默认折叠，别让老记忆霸屏 */
const FROZEN_MS = 90 * 86400
const showFrozen = ref(false)
const isFrozen = (n: { created_at?: number; last_hit_at?: number }) =>
  !!n.last_hit_at && n.last_hit_at < Date.now() / 1000 - FROZEN_MS && (n.created_at || 0) < Date.now() / 1000 - FROZEN_MS
const liveNodes = computed(() => filteredNodes.value.filter((n) => !isFrozen(n)))
const frozenNodes = computed(() => filteredNodes.value.filter((n) => isFrozen(n)))

const galaxyNodes = computed<GalaxyNode[]>(() =>
  filteredNodes.value.map(n => ({
    id: n.id,
    title: n.title,
    summary: n.summary,
    colorKey: store.isPending(n) ? 'pending' : n.node_type,
    node_type: n.node_type,
    scope: n.scope,
    tags: n.tags,
  })),
)
const galaxyEdges = computed<GalaxyEdge[]>(() =>
  store.edges
    .filter(e => filteredNodes.value.some(n => n.id === e.source_node) && filteredNodes.value.some(n => n.id === e.target_node))
    .map(e => ({ id: e.id, source: e.source_node, target: e.target_node, relation: e.relation })),
)

const selectedId = ref<string | null>(null)
const selectedNode = computed(() => selectedId.value ? store.getNode(selectedId.value) : undefined)
const selectedEdges = computed(() => selectedId.value ? store.edgesForNode(selectedId.value) : [])
/** 浮动详情弹窗是否显示：有选中节点或正在编辑时弹出 */
const showDetail = computed(() => !!selectedNode.value || editing.value)
function closeDetail() {
  selectedId.value = null
  editing.value = false
}
const neighborIds = computed(() => {
  const out = new Set<string>()
  for (const e of selectedEdges.value) {
    if (e.source_node === selectedId.value) out.add(e.target_node)
    if (e.target_node === selectedId.value) out.add(e.source_node)
  }
  return out
})

// ── CRUD ──
const editing = ref(false)
const isNew = ref(false)
const form = ref({ title: '', summary: '', content: '', node_type: 'fact', project_id: '', tags: '' })
const linkTarget = ref('')
const linkRelation = ref('related')

// ── 所属项目：全局 + 已创建项目（选中项目 → scope=project；全局 → scope=global）──
const projectsStore = useProjectsStore()
const projectOptions = computed(() => {
  const opts: Array<{ value: string; label: string }> = [{ value: '', label: t('memory.projectGlobal') }]
  for (const p of projectsStore.projects) opts.push({ value: p.id, label: p.name })
  return opts
})
const projectName = (id: string) => {
  if (!id) return t('memory.projectGlobal')
  return projectsStore.getProject(id)?.name || id
}

// 打开面板 → 从后端拉取真实记忆网图（不再用 localStorage 演示数据）
watch(() => props.open, (val) => {
  if (val) store.refresh('all')
})

const TYPE_OPTIONS = [
  { value: 'preference', labelKey: 'memory.type.preference' },
  { value: 'decision', labelKey: 'memory.type.decision' },
  { value: 'pitfall', labelKey: 'memory.type.pitfall' },
  { value: 'pattern', labelKey: 'memory.type.pattern' },
  { value: 'fact', labelKey: 'memory.type.fact' },
  { value: 'profile', labelKey: 'memory.type.profile' },  // 0924 分类定版：废「长期记忆」桶，第 6 类=画像
]

const RELATION_OPTIONS = [
  { value: 'related', labelKey: 'memory.rel.related' },
  { value: 'uses', labelKey: 'memory.rel.uses' },
  { value: 'has_pitfall', labelKey: 'memory.rel.hasPitfall' },
  { value: 'validated_by', labelKey: 'memory.rel.validatedBy' },
]

const linkableNodes = computed(() =>
  store.nodes.filter(n => n.id !== selectedId.value && n.enabled && !neighborIds.value.has(n.id)),
)

function startNew() {
  editing.value = true
  isNew.value = true
  selectedId.value = null
  form.value = { title: '', summary: '', content: '', node_type: 'fact', project_id: '', tags: '' }
}

function startEdit() {
  const n = selectedNode.value
  if (!n) return
  editing.value = true
  isNew.value = false
  form.value = {
    title: n.title,
    summary: n.summary,
    content: n.content,
    node_type: n.node_type,
    project_id: n.project_id,
    tags: (n.tags || []).join(', '),
  }
}

function cancelEdit() {
  editing.value = false
  if (isNew.value) selectedId.value = null
}

function editFromList(id: string) {
  const n = store.getNode(id)
  if (!n) return
  viewMode.value = 'galaxy'
  selectedId.value = id
  editing.value = true
  isNew.value = false
  form.value = {
    title: n.title,
    summary: n.summary,
    content: n.content,
    node_type: n.node_type,
    project_id: n.project_id,
    tags: (n.tags || []).join(', '),
  }
}

/** 列表点击：**留在列表**，就地弹出与星系视图同一份详情浮层（0918 #3） */
function openFromList(id: string) {
  selectedId.value = id
  editing.value = false
}

/** 列表视图：删除某条记忆（二次确认 → 系统内弹窗） */
function deleteFromList(id: string) {
  deleteConfirmTarget.value = id
}

function saveForm() {
  const tags = form.value.tags.split(/[,，]/).map(s => s.trim()).filter(Boolean)
  // 选了项目 → scope=project；全局 → scope=global
  const payload = {
    ...form.value,
    tags,
    scope: form.value.project_id ? 'project' : 'global',
  }
  if (isNew.value) {
    const created = store.addNode(payload)
    selectedId.value = created.id
  } else if (selectedId.value) {
    store.updateNode(selectedId.value, payload)
  }
  editing.value = false
}

function deleteNode() {
  if (!selectedId.value) return
  store.deleteNode(selectedId.value)
  selectedId.value = null
  editing.value = false
}
/** 删除记忆确认目标（系统内弹窗） */
const deleteConfirmTarget = ref<string | null>(null)
function confirmDeleteMemory() {
  const id = deleteConfirmTarget.value
  if (id) {
    store.deleteNode(id)
    if (selectedId.value === id) selectedId.value = null
  }
  deleteConfirmTarget.value = null
}

/** 审核待确认记忆：采纳（转正 user_explicit）/ 丢弃（软删） */
function review(action: 'approve' | 'reject') {
  const n = selectedNode.value
  if (!n) return
  store.reviewMemory(n.id, action)
}

// ── 批量审核（列表模式多选待确认记忆） ──
const pendingSelected = ref<Set<string>>(new Set())
const pendingNodes = computed(() => store.nodes.filter(n => n.enabled && store.isPending(n)))
const allPendingSelected = computed(
  () => pendingNodes.value.length > 0 && pendingNodes.value.every(n => pendingSelected.value.has(n.id)),
)
function togglePendingSelect(id: string) {
  const s = new Set(pendingSelected.value)
  if (s.has(id)) s.delete(id)
  else s.add(id)
  pendingSelected.value = s
}
function toggleAllPending() {
  if (allPendingSelected.value) pendingSelected.value = new Set()
  else pendingSelected.value = new Set(pendingNodes.value.map(n => n.id))
}
function batchReview(action: 'approve' | 'reject') {
  const ids = [...pendingSelected.value]
  if (!ids.length) return
  store.batchReviewMemory(ids, action)
  pendingSelected.value = new Set()
}

function addLink() {
  if (!selectedId.value || !linkTarget.value) return
  store.addEdge(selectedId.value, linkTarget.value, linkRelation.value)
  linkTarget.value = ''
}

/** 0924 二期批1：来源徽章数据（tags 里 src:ai/extract/user）与「近 7 天」判定（created_at 为秒） */
const srcOf = (n: { tags?: string[] }) => {
  const tag = (n.tags || []).find((x: string) => String(x).startsWith('src:'))
  const v = tag ? String(tag).slice(4) : ''
  return ['ai', 'extract', 'user'].includes(v) ? v : ''
}
/* ★ 0924 修复：这个名字原本也叫 isNew —— 但本文件 162 行已经有一个 `const isNew = ref(false)`
   （表单「新建/编辑」模式），重名会让 vite 的 vue 编译器直接抛
   `Identifier 'isNew' has already been declared`，整个页面被错误遮罩占满。
   这里语义是「这条记忆是不是近 7 天的新条目」→ 改名 isFresh（只动本行 + 模板 733 行）。 */
const isFresh = (n: { created_at?: number }) => (n.created_at || 0) > Date.now() / 1000 - 7 * 86400

const typeLabel = (type: string) => {
  const o = TYPE_OPTIONS.find(x => x.value === type)
  return o ? t(o.labelKey) : type
}
/** 列表视图类型徽标颜色 */
const typeCls = (type: string) => {
  const map: Record<string, string> = {
    preference: 'bg-pink-50 text-pink-600 border-pink-100',
    decision: 'bg-indigo-50 text-indigo-600 border-indigo-100',
    pitfall: 'bg-amber-50 text-amber-600 border-amber-100',
    pattern: 'bg-emerald-50 text-emerald-600 border-emerald-100',
    fact: 'bg-gray-50 text-gray-600 border-gray-200',
  }
  return map[type] || map.fact
}
const relLabel = (rel: string) => {
  const o = RELATION_OPTIONS.find(x => x.value === rel)
  return o ? t(o.labelKey) : rel
}
const timeStr = (ts: number) => {
  const d = new Date(ts)
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

// P1-3 来源徽标：user_explicit=高可信(绿) / user_implicit=中(蓝) / system_infer=AI推断(黄) / 其余=灰
const sourceMeta = (st?: string | null) => {
  const map: Record<string, { icon: string; labelKey: string; cls: string }> = {
    user_explicit: { icon: 'fas fa-circle-check', labelKey: 'memory.source.userExplicit', cls: 'bg-green-50 text-green-600 border-green-200' },
    user_implicit: { icon: 'fas fa-user', labelKey: 'memory.source.userImplicit', cls: 'bg-blue-50 text-blue-600 border-blue-200' },
    system_infer: { icon: 'fas fa-robot', labelKey: 'memory.source.systemInfer', cls: 'bg-amber-50 text-amber-600 border-amber-200' },
    system_observed: { icon: 'fas fa-eye', labelKey: 'memory.source.systemObserved', cls: 'bg-gray-100 text-gray-600 border-gray-200' },
    imported: { icon: 'fas fa-download', labelKey: 'memory.source.imported', cls: 'bg-gray-100 text-gray-600 border-gray-200' },
  }
  return map[st || ''] || null
}

watch(selectedId, (v) => { if (v == null) { editing.value = false; linkTarget.value = '' } })
</script>

<template>
  <Teleport to="body">
    <div
      v-if="showModal"
      :class="['fixed inset-0 z-40 bg-black/40', isClosing ? 'backdrop-fade-out' : 'backdrop-fade-in']"
    ></div>

    <div v-if="showModal" class="fixed inset-0 z-50 flex items-center justify-center">
      <div class="relative flex flex-col items-center">
        <div
          :class="['dock-modal', isAnimating && !isClosing ? 'dock-in' : '', isClosing ? 'dock-out' : '', isFullscreen ? 'fixed inset-2 z-[60] w-auto h-auto' : 'relative w-[min(957px,94vw)] h-[82vh]']"
          class="bg-white rounded-[20px] shadow-[0_24px_70px_-20px_rgba(0,0,0,0.25)] border-[1.5px] border-gray-200 overflow-hidden flex flex-col"
        >
          <!-- 头部 -->
          <div class="px-7 pt-6 pb-4 border-b-[1.5px] border-gray-100 flex items-center justify-between gap-4 shrink-0">
            <div>
              <h2 class="text-base font-bold text-gray-900 tracking-tight flex items-center gap-2">
                {{ t('memory.title') }}
                <span class="text-[10px] font-normal text-gray-400 bg-gray-100 rounded-full px-2 py-0.5">{{ store.nodes.length }} · {{ store.edges.length }}</span>
              </h2>
              <p class="text-[11px] text-gray-400 mt-0.5">{{ t('memory.subtitle') }}</p>
              <p v-if="distillMsg" class="text-[11px] text-amber-600 mt-0.5">{{ distillMsg }}</p>
            </div>
            <div class="flex items-center gap-2">
              <!-- ★1010l：手动整理（同主题散碎记忆 → 主题草案，进「待确认」等你把关） -->
              <button
                class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-gray-200 bg-white hover:bg-gray-50 text-xs text-gray-700 disabled:opacity-50 transition-colors"
                :disabled="distilling"
                :title="t('memory.distillHint')"
                @click="runDistill"
              >
                <span>{{ distilling ? t('memory.distilling') : t('memory.distill') }}</span>
              </button>
              <div class="relative">
                <i class="fas fa-search text-[10px] text-gray-400 absolute left-3 top-1/2 -translate-y-1/2"></i>
                <input
                  v-model="keyword"
                  class="bg-gray-50 border border-gray-200 rounded-lg pl-8 pr-3 py-1.5 text-xs text-gray-800 outline-none focus:border-gray-400 w-48"
                  :placeholder="t('memory.searchPlaceholder')"
                />
              </div>
              <!-- 0914：三区（记忆 / 图谱 / 待确认） -->
              <div class="flex items-center bg-gray-100 rounded-lg p-0.5">
                <button
                  v-for="z in ZONES"
                  :key="z.value"
                  @click="zone = z.value"
                  :class="['px-2.5 py-1.5 rounded-md text-[11px] transition-colors flex items-center', zone === z.value ? 'bg-white shadow-sm text-gray-900 font-[530]' : 'text-gray-500 hover:text-gray-700']"
                >
                  <i :class="[z.icon, 'text-[10px] mr-1']"></i>{{ t(z.labelKey) }}
                </button>
              </div>
              <button
                @click="showLabels = !showLabels"
                :title="t('memory.showLabels')"
                :class="['flex items-center gap-1 h-7 px-2 rounded-lg text-[11px] transition-colors', showLabels ? 'text-gray-700 bg-gray-100 font-[530]' : 'text-gray-400 hover:text-gray-600 hover:bg-gray-100']"
              >
                <i class="fas fa-tag text-[10px]"></i>{{ t('memory.showLabels') }}
              </button>
              <!-- ★1010n：全屏按钮已按需求要求移除 -->
              <button
                @click="startNew"
                class="btn btn-primary btn-sm"
              >
                <i class="fas fa-plus text-[10px]"></i>{{ t('memory.add') }}
              </button>
            </div>
          </div>

          <!-- 主体 -->
          <div class="flex-1 min-h-0 flex relative">
            <!-- 星系图谱 + 浮动详情弹窗 -->
            <!-- 浮动详情弹窗：点节点弹出，点画布空白处消失 -->
            <Transition name="pop">
              <div
                v-if="showDetail"
                :class="[
                  'z-30 bg-white rounded-2xl shadow-[0_16px_48px_-12px_rgba(0,0,0,0.5)] border border-gray-200 overflow-hidden flex flex-col',
                  viewMode === 'galaxy' ? 'absolute right-3 top-3 bottom-3 w-[360px]' : 'mem-detail-dialog',
                ]"
              >
                <!-- 面板关闭 X：仅「详情查看态」显示。编辑态交给表单头部那枚 X ——
                     此前两枚 X 同时存在且坐标重叠（与知识库同一模板复制而来），编辑时视觉上"俩 X" -->
                <button
                  v-if="!editing"
                  @click="closeDetail"
                  class="absolute right-3 top-3 z-10 w-6 h-6 flex items-center justify-center rounded-full bg-gray-100 text-gray-400 hover:text-gray-600 hover:bg-gray-200 transition-colors"
                >
                  <i class="fas fa-times text-[10px]"></i>
                </button>
                <!-- 滚动容器与外层圆角框分离：外层 overflow-hidden 把滚动条裁进圆角内，
                     修复「右侧滚动条跑到框架外」（此前 overflow-y-auto 与 rounded-2xl 同层） -->
                <div class="flex-1 min-h-0 overflow-y-auto overflow-x-hidden custom-scroll">
                <!-- 空态 -->
                <div v-if="!selectedNode && !editing" class="h-full flex flex-col items-center justify-center px-8 text-center">
                  <div class="w-16 h-16 rounded-full bg-gray-100 text-gray-400 flex items-center justify-center mb-3">
                    <i class="fas fa-satellite-dish text-xl"></i>
                  </div>
                  <p class="text-sm font-[530] text-gray-600">{{ t('memory.emptyTitle') }}</p>
                  <p class="text-[11px] text-gray-400 mt-1 leading-relaxed">{{ t('memory.emptyHint') }}</p>
                </div>

                <!-- 编辑表单 -->
                <div v-else-if="editing" class="p-5">
                  <div class="flex items-center justify-between gap-2 mb-4">
                    <h3 class="text-sm font-bold text-gray-900">{{ isNew ? t('memory.form.new') : t('memory.form.edit') }}</h3>
                    <!-- 表单关闭 X：与面板 X 同款圆形按钮（此前是无内边距的裸 <i>，与面板 X 重叠成"俩 X"） -->
                    <button
                      @click="cancelEdit"
                      :title="t('memory.form.cancel')"
                      class="shrink-0 w-6 h-6 flex items-center justify-center rounded-full bg-gray-100 text-gray-400 hover:text-gray-600 hover:bg-gray-200 transition-colors"
                    >
                      <i class="fas fa-times text-[10px]"></i>
                    </button>
                  </div>
                  <div class="space-y-3">
                    <div>
                      <label class="block text-[11px] font-[640] text-gray-500 mb-1">{{ t('memory.form.title') }}</label>
                      <input v-model="form.title" class="w-full bg-white border border-gray-200 rounded-lg px-3 py-2 text-xs text-gray-800 outline-none focus:border-gray-400" />
                    </div>
                    <div>
                      <label class="block text-[11px] font-[640] text-gray-500 mb-1">{{ t('memory.form.summary') }}</label>
                      <input v-model="form.summary" class="w-full bg-white border border-gray-200 rounded-lg px-3 py-2 text-xs text-gray-800 outline-none focus:border-gray-400" />
                    </div>
                    <div>
                      <label class="block text-[11px] font-[640] text-gray-500 mb-1">{{ t('memory.form.type') }}</label>
                      <div class="flex flex-wrap gap-1.5">
                        <button
                          v-for="opt in TYPE_OPTIONS" :key="opt.value"
                          @click="form.node_type = opt.value"
                          :class="[
                            'text-[11px] px-3 py-1.5 rounded-full border transition-colors',
                            form.node_type === opt.value
                              ? 'bg-black text-white border-black'
                              : 'bg-white text-gray-500 border-gray-200 hover:border-gray-300',
                          ]"
                        >{{ t(opt.labelKey) }}</button>
                      </div>
                    </div>
                    <div>
                      <label class="block text-[11px] font-[640] text-gray-500 mb-1">{{ t('memory.form.project') }}</label>
                      <select v-model="form.project_id" class="w-full bg-white border border-gray-200 rounded-lg px-3 py-2 text-xs text-gray-800 outline-none focus:border-gray-400">
                        <option v-for="opt in projectOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
                      </select>
                    </div>
                    <div>
                      <label class="block text-[11px] font-[640] text-gray-500 mb-1">{{ t('memory.form.content') }}</label>
                      <textarea v-model="form.content" rows="5" class="w-full bg-white border border-gray-200 rounded-lg px-3 py-2 text-xs text-gray-800 outline-none focus:border-gray-400 resize-none leading-relaxed"></textarea>
                    </div>
                    <div>
                      <label class="block text-[11px] font-[640] text-gray-500 mb-1">{{ t('memory.form.tags') }}</label>
                      <input v-model="form.tags" class="w-full bg-white border border-gray-200 rounded-lg px-3 py-2 text-xs text-gray-800 outline-none focus:border-gray-400" :placeholder="t('memory.form.tagsPlaceholder')" />
                    </div>
                  </div>
                  <div class="flex gap-2 mt-5">
                    <button @click="saveForm" class="flex-1 btn btn-primary btn-sm">{{ t('memory.form.save') }}</button>
                    <button @click="cancelEdit" class="btn btn-secondary btn-sm">{{ t('memory.form.cancel') }}</button>
                  </div>
                </div>

                <!-- 详情 -->
                <div v-else class="p-5">
                  <div class="flex items-start justify-between gap-2 mb-1 pr-8">
                    <h3 class="text-sm font-bold text-gray-900 leading-snug">{{ selectedNode!.title }}</h3>
                    <span class="text-[10px] shrink-0 px-2 py-0.5 rounded-full font-[640] bg-gray-100 text-gray-700 border border-gray-200">{{ typeLabel(selectedNode!.node_type) }}</span>
                  </div>
                  <!-- P1-3 来源徽标：用户明确说=高可信绿 / AI推断=黄 / 工具观察/导入=灰 -->
                  <div class="flex items-center gap-1.5 mb-2">
                    <span
                      v-if="sourceMeta(selectedNode!.source_type)"
                      :class="['text-[10px] px-2 py-0.5 rounded-full font-[640] border', sourceMeta(selectedNode!.source_type)!.cls]"
                    >
                      <i :class="[sourceMeta(selectedNode!.source_type)!.icon, 'text-[9px] mr-1']"></i>{{ t(sourceMeta(selectedNode!.source_type)!.labelKey) }}
                    </span>
                    <span v-else class="text-[10px] px-2 py-0.5 rounded-full font-[640] bg-gray-100 text-gray-400 border border-gray-200">{{ t('memory.source.unknown') }}</span>
                    <span v-if="store.isPending(selectedNode)" class="text-[10px] px-2 py-0.5 rounded-full font-[640] bg-amber-50 text-amber-600 border border-amber-200">
                      <i class="fas fa-hourglass-half text-[9px] mr-1"></i>{{ t('memory.pending') }}
                    </span>
                  </div>
                  <div class="flex flex-wrap gap-1 mb-3">
                    <span v-for="tg in (selectedNode!.tags || [])" :key="tg" class="text-[10px] px-2 py-0.5 rounded-full bg-gray-100 text-gray-500">{{ tg }}</span>
                  </div>
                  <p v-if="selectedNode!.summary" class="text-[11px] font-[530] text-gray-700 bg-gray-50 border border-gray-100 rounded-lg px-3 py-2 mb-3">{{ selectedNode!.summary }}</p>
                  <p class="text-xs text-gray-600 leading-relaxed whitespace-pre-wrap bg-white border border-gray-100 rounded-xl p-3.5 mb-4">{{ selectedNode!.content || t('memory.emptyContent') }}</p>
                  <div class="text-[10px] text-gray-400 space-y-1 mb-4">
                    <div class="flex items-center gap-1.5"><i class="fas fa-globe text-[9px]"></i>{{ projectName(selectedNode!.project_id) }}</div>
                    <div class="flex items-center gap-1.5"><i class="fas fa-clock text-[9px]"></i>{{ t('memory.updated') }} {{ timeStr(selectedNode!.updated_at) }}</div>
                    <div v-if="selectedNode!.created_at" class="flex items-center gap-1.5"><i class="fas fa-calendar-plus text-[9px]"></i>{{ t('memory.created') }} {{ timeStr(selectedNode!.created_at) }}</div>
                  </div>

                  <!-- 关联 -->
                  <div class="mb-4">
                    <h4 class="text-[11px] font-bold text-gray-500 mb-2 flex items-center justify-between">
                      <span><i class="fas fa-share-nodes text-[9px] mr-1"></i>{{ t('memory.relations') }}</span>
                      <span class="text-[10px] font-normal text-gray-400">{{ selectedEdges.length }}</span>
                    </h4>
                    <div v-if="selectedEdges.length" class="space-y-1.5 mb-3">
                      <div
                        v-for="e in selectedEdges" :key="e.id"
                        class="flex items-center gap-2 bg-white border border-gray-100 rounded-lg px-2.5 py-1.5 text-[10px]"
                      >
                        <span class="text-gray-500">{{ relLabel(e.relation) }}</span>
                        <i class="fas fa-arrow-right text-[9px] text-gray-300"></i>
                        <span class="flex-1 truncate text-gray-700">{{ store.getNode(e.source_node === selectedId ? e.target_node : e.source_node)?.title }}</span>
                        <button @click="store.deleteEdge(e.id)" class="text-gray-300 hover:text-red-500 transition-colors"><i class="fas fa-xmark"></i></button>
                      </div>
                    </div>
                    <div v-else class="text-[10px] text-gray-400 mb-3 bg-white border border-dashed border-gray-200 rounded-lg px-2.5 py-2 text-center">{{ t('memory.noRelation') }}</div>
                    <!-- 新增关联 -->
                    <div class="flex flex-col gap-1.5">
                      <div class="flex gap-1.5">
                        <select v-model="linkRelation" class="flex-1 min-w-0 bg-white border border-gray-200 rounded-lg px-2 py-1.5 text-[10px] text-gray-700 outline-none focus:border-gray-400">
                          <option v-for="opt in RELATION_OPTIONS" :key="opt.value" :value="opt.value">{{ t(opt.labelKey) }}</option>
                        </select>
                      </div>
                      <div class="flex gap-1.5">
                        <select v-model="linkTarget" class="flex-1 min-w-0 bg-white border border-gray-200 rounded-lg px-2 py-1.5 text-[10px] text-gray-700 outline-none focus:border-gray-400">
                          <option value="">{{ t('memory.linkPlaceholder') }}</option>
                          <option v-for="n in linkableNodes" :key="n.id" :value="n.id" class="truncate">{{ n.title }}</option>
                        </select>
                        <button
                          @click="addLink"
                          :disabled="!linkTarget"
                          class="shrink-0 whitespace-nowrap px-3 py-1.5 rounded-lg text-[10px] font-[640] text-white bg-black hover:bg-gray-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                        >{{ t('memory.linkAdd') }}</button>
                      </div>
                    </div>
                  </div>

                  <div class="flex gap-2">
                    <template v-if="store.isPending(selectedNode)">
                      <button @click="review('approve')" class="flex-1 btn btn-primary btn-sm">
                        <i class="fas fa-circle-check text-[10px] mr-1"></i>{{ t('memory.approve') }}
                      </button>
                      <button @click="review('reject')" class="flex-1 btn btn-danger btn-sm">
                        <i class="fas fa-trash-can text-[10px] mr-1"></i>{{ t('memory.reject') }}
                      </button>
                    </template>
                    <template v-else>
                      <button @click="startEdit" class="flex-1 btn btn-secondary btn-sm">
                        <i class="fas fa-pen text-[10px] mr-1"></i>{{ t('memory.edit') }}
                      </button>
                      <button @click="deleteConfirmTarget = selectedId" class="flex-1 btn btn-danger btn-sm">
                        <i class="fas fa-trash-can text-[10px] mr-1"></i>{{ t('memory.delete') }}
                      </button>
                    </template>
                  </div>
                </div>
                </div>
              </div>
            </Transition>
            <div v-if="viewMode === 'galaxy'" class="flex-1 min-w-0 relative bg-[#070a1a]">
              <GalaxyCanvas :items="galaxyNodes" :edges="galaxyEdges" :selected-id="selectedId" :show-labels="showLabels" @select="selectedId = $event" />
              <div class="absolute left-3 top-3 flex items-center gap-2 flex-wrap max-w-[380px] z-10">
                <button
                  v-for="opt in TYPE_OPTIONS" :key="opt.value"
                  @click="typeFilter = typeFilter === opt.value ? '' : opt.value"
                  :class="[
                    'text-[10px] px-2.5 py-1 rounded-full border transition-colors',
                    typeFilter === opt.value
                      ? 'bg-white/15 text-white border-white/40'
                      : 'bg-black/30 text-gray-400 border-white/10 hover:text-white hover:border-white/30',
                  ]"
                >{{ t(opt.labelKey) }}</button>
              </div>
              <div class="absolute bottom-3 left-3 z-10 text-[10px] text-gray-500 flex items-center gap-3 pointer-events-none">
                <span class="flex items-center gap-1"><i class="fas fa-mouse-pointer"></i>{{ t('knowledge.hintDrag') }}</span>
                <span class="flex items-center gap-1"><i class="fas fa-magnifying-glass-plus"></i>{{ t('knowledge.hintZoom') }}</span>
                <span class="flex items-center gap-1"><i class="fas fa-hand-pointer"></i>{{ t('knowledge.hintClick') }}</span>
              </div>

            </div>

            <!-- 列表视图 -->
            <div v-else class="flex-1 min-w-0 overflow-y-auto custom-scroll bg-gray-50/60 p-5">
              <!-- 类型筛选 -->
              <div class="flex items-center gap-2 flex-wrap mb-4">
                <button
                  @click="typeFilter = ''"
                  :class="['text-[11px] px-3 py-1.5 rounded-full border transition-colors font-[530]', typeFilter === '' ? 'bg-black text-white border-black' : 'bg-white text-gray-500 border-gray-200 hover:border-gray-300']"
                >{{ t('memory.filterAll') }}</button>
                <button
                  v-for="opt in TYPE_OPTIONS" :key="opt.value"
                  @click="typeFilter = typeFilter === opt.value ? '' : opt.value"
                  :class="['text-[11px] px-3 py-1.5 rounded-full border transition-colors font-[530]', typeFilter === opt.value ? 'bg-black text-white border-black' : 'bg-white text-gray-500 border-gray-200 hover:border-gray-300']"
                >{{ t(opt.labelKey) }}</button>
              </div>
              <!-- 批量审核栏：有待确认记忆时显示 -->
              <div v-if="zone === 'pending' && pendingNodes.length" class="flex items-center gap-2 flex-wrap mb-3 bg-amber-50/70 border border-amber-200 rounded-xl px-3 py-2">
                <button
                  @click="toggleAllPending"
                  class="flex items-center gap-1.5 text-[11px] font-[530] text-gray-600 hover:text-gray-900 transition-colors"
                >
                  <i :class="allPendingSelected ? 'fas fa-square-check text-amber-500' : 'far fa-square text-gray-400'" class="text-xs"></i>
                  {{ t('memory.batchSelectAll') }}
                </button>
                <span class="text-[11px] text-amber-600 font-[530]">{{ t('memory.batchSelected', { n: pendingSelected.size }) }}</span>
                <div class="flex-1"></div>
                <button
                  @click="batchReview('approve')"
                  :disabled="!pendingSelected.size"
                  class="flex items-center gap-1 text-[11px] font-[640] text-white bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg px-3 py-1.5 transition-colors"
                >
                  {{ t('memory.batchApprove') }}
                </button>
                <button
                  @click="batchReview('reject')"
                  :disabled="!pendingSelected.size"
                  class="flex items-center gap-1 text-[11px] font-[640] text-red-600 bg-red-50 border border-red-200 hover:bg-red-100 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg px-3 py-1.5 transition-colors"
                >
                  {{ t('memory.batchReject') }}
                </button>
              </div>
              <div class="flex items-center justify-between mb-3">
                <span class="text-[11px] text-gray-500">{{ t('memory.listCount') }} {{ filteredNodes.length }}</span>
              </div>
              <!-- 记忆检索命中（memories 表，与 AI memory_search 同源） -->
              <div v-if="memoryHits.length" class="mb-4">
                <div class="flex items-center gap-1.5 mb-2">
                  <i class="fas fa-database text-[10px] text-indigo-400"></i>
                  <span class="text-[11px] font-[640] text-gray-600">{{ t('memory.searchHits') }} {{ memoryHits.length }}</span>
                </div>
                <div
                  v-for="h in memoryHits"
                  :key="h.id"
                  class="bg-indigo-50/50 border border-indigo-100 rounded-xl px-4 py-3 mb-2"
                >
                  <div class="flex items-center gap-2 mb-1">
                    <span class="text-[10px] px-2 py-0.5 rounded-full font-[640] bg-indigo-100 text-indigo-600">{{ h.memory_type }}</span>
                    <span class="text-[10px] text-gray-400 ml-auto shrink-0">{{ h.score != null ? t('memory.relevance', { score: h.score.toFixed(2) }) : '' }}</span>
                  </div>
                  <p class="text-xs text-gray-700 leading-relaxed whitespace-pre-wrap">{{ h.content }}</p>
                </div>
              </div>
              <div v-if="memoryHitLoading" class="text-center text-xs text-gray-400 py-4"><i class="fas fa-spinner fa-spin mr-1.5"></i>{{ t('memory.searching') }}</div>
              <div v-if="!liveNodes.length && !frozenNodes.length && !memoryHits.length && !memoryHitLoading" class="text-center text-xs text-gray-400 py-10">{{ t('memory.emptyContent') }}</div>
              <!-- 0924 二期批6a：冷冻记忆折叠区（90 天没用过的，默认收起） -->
              <div v-if="frozenNodes.length" class="mb-2">
                <button class="w-full text-[11px] text-gray-400 hover:text-gray-600 border border-dashed border-gray-200 rounded-lg py-2 transition-colors" @click="showFrozen = !showFrozen">
                  <i class="fas fa-snowflake mr-1"></i>{{ t('memory.frozenTitle') }} {{ frozenNodes.length }} · {{ showFrozen ? t('memory.frozenClose') : t('memory.frozenOpen') }}
                </button>
              </div>
              <template v-if="showFrozen">
                <div v-for="n in frozenNodes" :key="'fz-' + n.id" :class="['bg-gray-50/60 border border-gray-100 rounded-xl px-4 py-3 mb-2 cursor-pointer transition-colors', selectedId === n.id ? 'border-gray-400' : 'hover:border-gray-300']" @click="openFromList(n.id)">
                  <div class="flex items-center gap-2 mb-1">
                    <span :class="['text-[10px] px-2 py-0.5 rounded-full font-[640] border', typeCls(n.node_type)]">{{ t(typeLabel(n.node_type)) }}</span>
                    <span class="text-xs font-[640] text-gray-600 flex-1 truncate">{{ n.title }}</span>
                    <span class="text-[10px] text-gray-300 shrink-0"><i class="fas fa-snowflake"></i></span>
                  </div>
                  <p class="text-[11px] text-gray-400 leading-relaxed">{{ String(n.summary || n.content || '').slice(0, 80) }}</p>
                </div>
              </template>
              <div
                v-for="n in liveNodes"
                :key="n.id"
                :class="[
                  'bg-white border border-gray-100 rounded-xl px-4 py-3 mb-2 cursor-pointer transition-colors group',
                  selectedId === n.id ? 'border-gray-400 shadow-sm' : 'hover:border-gray-300',
                ]"
                @click="openFromList(n.id)"
              >
                <div class="flex items-center gap-2 mb-1">
                  <button
                    v-if="store.isPending(n)"
                    @click.stop="togglePendingSelect(n.id)"
                    class="text-gray-300 hover:text-amber-500 transition-colors shrink-0"
                    :title="t('memory.pending')"
                  >
                    <i :class="pendingSelected.has(n.id) ? 'fas fa-square-check text-amber-500' : 'far fa-square'" class="text-xs"></i>
                  </button>
                  <span :class="['text-[10px] px-2 py-0.5 rounded-full font-[640] border', typeCls(n.node_type)]">
                    {{ t(typeLabel(n.node_type)) }}
                  </span>
                  <!-- 0924 二期批1：来源徽章（tags 里 src:ai/extract/user）+ 近 7 天 NEW -->
                  <span v-if="srcOf(n)" class="text-[10px] px-2 py-0.5 rounded-full font-[640] bg-gray-50 text-gray-500 border border-gray-200">
                    {{ t('memory.src.' + srcOf(n)) }}
                  </span>
                  <span v-if="isFresh(n)" class="text-[9px] px-1.5 py-0.5 rounded-full font-[700] bg-emerald-50 text-emerald-600 border border-emerald-200">NEW</span>
                  <span v-if="store.isPending(n)" class="text-[10px] px-2 py-0.5 rounded-full font-[640] bg-amber-50 text-amber-600 border border-amber-200">
                    <i class="fas fa-hourglass-half text-[9px] mr-0.5"></i>{{ t('memory.pending') }}
                  </span>
                  <span class="text-xs font-[640] text-gray-800 flex-1 truncate">{{ n.title }}</span>
                  <!-- 编辑 / 删除 -->
                  <button
                    class="text-gray-300 hover:text-gray-600 transition-colors opacity-0 group-hover:opacity-100"
                    :title="t('memory.edit')"
                    @click.stop="editFromList(n.id)"
                  >
                    <i class="fas fa-pen text-[10px]"></i>
                  </button>
                  <button
                    class="text-gray-300 hover:text-red-500 transition-colors opacity-0 group-hover:opacity-100"
                    :title="t('memory.delete')"
                    @click.stop="deleteFromList(n.id)"
                  >
                    <i class="fas fa-trash-can text-[10px]"></i>
                  </button>
                </div>
                <p class="text-[11px] text-gray-500 leading-relaxed line-clamp-2">{{ n.summary || n.content }}</p>
                <div class="flex items-center gap-1.5 mt-2">
                  <span class="text-[10px] text-gray-400"><i class="fas fa-clock text-[9px] mr-0.5"></i>{{ timeStr(n.updated_at) }}</span>
                  <span v-if="n.tags?.length" class="flex items-center gap-1 flex-wrap">
                    <span v-for="tg in n.tags" :key="tg" class="text-[10px] px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-500">{{ tg }}</span>
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>

        <button
          @click="close"
          :class="['close-btn', isAnimating && !isClosing ? 'close-in' : '', isClosing ? 'close-out' : '']"
          class="w-9 h-9 flex items-center justify-center bg-white border border-gray-200 text-gray-400 hover:text-gray-600 hover:shadow-md rounded-full shadow-sm mt-5"
        >
          <i class="fas fa-times text-sm"></i>
        </button>
      </div>
    </div>
  </Teleport>

  <!-- 删除记忆确认（系统内弹窗） -->
  <Teleport to="body">
    <div v-if="deleteConfirmTarget" class="fixed inset-0 z-[10010] flex items-center justify-center bg-black/40" @click.self="deleteConfirmTarget = null">
      <div class="w-[340px] bg-white rounded-2xl shadow-2xl p-6">
        <h3 class="text-[15px] font-[640] text-gray-800 mb-2">{{ t('memory.deleteConfirmTitle') }}</h3>
        <p class="text-[13px] text-gray-500 leading-relaxed mb-5">{{ t('memory.deleteConfirmMsg') }}</p>
        <div class="flex justify-end gap-2">
          <button class="btn btn-secondary btn-sm" @click="deleteConfirmTarget = null">{{ t('memory.form.cancel') }}</button>
          <button class="btn btn-danger btn-sm" @click="confirmDeleteMemory">{{ t('memory.delete') }}</button>
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

/* 浮动详情弹窗：从右侧滑入 + 淡入 */
.pop-enter-active { transition: opacity 0.22s ease, transform 0.22s cubic-bezier(0.16, 1, 0.3, 1); }
.pop-leave-active { transition: opacity 0.16s ease, transform 0.16s ease; }
.pop-enter-from, .pop-leave-to { opacity: 0; transform: translateX(24px); }

/* 列表视图下的详情：居中弹窗（不是从右侧滑入的面板）；inset+margin:auto 居中，
   不用 transform 以免和 .pop 的滑入动画抢同一个属性 */
.mem-detail-dialog {
  position: absolute;
  inset: 0;
  margin: auto;
  width: 440px;
  height: min(560px, calc(100% - 32px));
}

.dock-in { animation: dockExpand 0.45s cubic-bezier(0.34, 1.6, 0.64, 1) forwards; }
.dock-out { animation: dockCollapse 0.3s cubic-bezier(0.4, 0, 0.2, 1) forwards; }
@keyframes dockExpand {
  0% { opacity: 0; transform: scale(0.05) translateY(20px); filter: blur(4px); }
  50% { opacity: 1; filter: blur(0); }
  70% { transform: scale(1.02) translateY(-2px); }
  100% { opacity: 1; transform: scale(1) translateY(0); filter: blur(0); }
}
@keyframes dockCollapse {
  0% { opacity: 1; transform: scale(1) translateY(0); filter: blur(0); }
  100% { opacity: 0; transform: scale(0.05) translateY(20px); filter: blur(4px); }
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
</style>
