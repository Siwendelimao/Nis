<script setup lang="ts">
import { ref, watch, computed } from 'vue'
import { t } from '@/utils/i18n'
import { useKnowledgeStore } from '@/stores/knowledge'
import type { KnowledgeAttachment } from '@/stores/knowledge'
import { useProjectsStore } from '@/stores/projects'
import AtomCircleCanvas from './blocks/AtomCircleCanvas.vue'
import type { GalaxyNode, GalaxyEdge } from './blocks/GalaxyCanvas.vue'
import KnowledgeFolderTree from './KnowledgeFolderTree.vue'
import AIExtractModal from './AIExtractModal.vue'
import type { AIExtractFields } from '@/utils/aiExtract'
import { uploadAttachment, fetchAttachmentContent, isLocalAttachment, localPathOf } from '@/utils/attachmentClient'
import { useModalLayer } from '@/utils/modalStack'

const props = defineProps<{
  open: boolean
}>()

const emit = defineEmits<{
  close: []
}>()

const isAnimating = ref(false)
const isClosing = ref(false)
const showModal = ref(false)

watch(() => props.open, (val) => {
  if (val) {
    isClosing.value = false
    showModal.value = true
    isAnimating.value = true
    setTimeout(() => { isAnimating.value = false }, 450)
    // ⑤ 重开回到顶层：清掉内层浮层（AI 提取弹窗 / 删除确认），不残留"弹窗中的弹窗"
    aiExtractOpen.value = false
    deleteConfirmOpen.value = false
    store.refresh()
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

/** 按 Esc（由全局层级栈分发给"最上层那一层"）：⑤ 逐层关闭 —— 先收内层浮层，
 *  无浮层时才关整个弹窗。这样知识库上面开着「AI 提炼」时，Esc 只收提炼窗。 */
function onEsc(): void {
  if (deleteConfirmOpen.value) { deleteConfirmOpen.value = false; return }
  if (aiExtractOpen.value) { aiExtractOpen.value = false; return }
  close()
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
}

useModalLayer(() => props.open, onEsc)

const store = useKnowledgeStore()
const projectsStore = useProjectsStore()

// ── 关键词 / 类型过滤 ──
const keyword = ref('')
const typeFilter = ref('')

// ── 树形分类：选中分类（null = 全部） ──
const activeFolder = ref<string | null>(null)
/** 根级未分类条目（parent_id='' 且非 folder） */
const rootUncategorized = computed(() =>
  store.entries.filter(e => e.entry_type !== 'folder' && !e.parent_id),
)
/** 选中某分类：只看该分类（含子孙分类）下的条目 */
function selectFolder(id: string | null) {
  activeFolder.value = id
  selectedId.value = null
  editing.value = false
}
/** 树里点条目：直接选中详情，并把星系过滤切到该条目的父分类 */
function selectEntry(id: string) {
  selectedId.value = id
  editing.value = false
  const e = store.getEntry(id)
  if (e && e.parent_id) activeFolder.value = e.parent_id
}
/** 当前可视条目 = 分类过滤 + 关键词/类型过滤（分类节点不参与星系渲染） */
const filteredEntries = computed(() => {
  const kw = keyword.value.trim().toLowerCase()
  const scopeIds = activeFolder.value != null ? store.entryIdsUnder(activeFolder.value) : null
  return store.entries.filter(e => {
    if (e.entry_type === 'folder') return false
    if (scopeIds && !scopeIds.has(e.id)) return false
    if (typeFilter.value && e.entry_type !== typeFilter.value) return false
    if (!kw) return true
    return (e.title + ' ' + e.content + ' ' + e.tags.join(' ')).toLowerCase().includes(kw)
  })
})
const activeFolderName = computed(() =>
  activeFolder.value ? store.getEntry(activeFolder.value)?.title || '' : '',
)

// ── 星系数据 ──
const galaxyNodes = computed<GalaxyNode[]>(() =>
  filteredEntries.value.map(e => ({
    id: e.id,
    title: e.title,
    summary: e.content,
    colorKey: e.entry_type,
    entry_type: e.entry_type,
    tags: e.tags,
  })),
)
const galaxyEdges = computed<GalaxyEdge[]>(() => {
  /* 0919：改用**后端真实关联**（knowledge_relations，写入时自动判定：字面/标签 + 装模型后算语义）。
     以前这里是"同 tag 就连线"的演示逻辑 —— 而 AI 写入的条目都带同两个系统 tag，
     结果要么全连成一张网、要么（没 tag 时）一条线都没有，正是需求"很乱/看不出关系"。
     现在只画两端都在当前可视集合里的边，线宽/亮度按 score。 */
  const visible = new Set(filteredEntries.value.map(e => e.id))
  const out: GalaxyEdge[] = []
  const seen = new Set<string>()
  for (const r of store.relations || []) {
    if (!visible.has(r.source_id) || !visible.has(r.target_id)) continue
    const key = `${r.source_id}|${r.target_id}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      id: `rel_${out.length}`,
      source: r.source_id,
      target: r.target_id,
      relation: r.relation || 'related',
      score: r.score,
    } as GalaxyEdge)
  }
  return out
})

const selectedId = ref<string | null>(null)
const selectedEntry = computed(() => selectedId.value ? store.getEntry(selectedId.value) : undefined)
/** 浮动详情弹窗是否显示：有选中条目或正在编辑时弹出 */
const showDetail = computed(() => !!selectedEntry.value || editing.value)
function closeDetail() {
  selectedId.value = null
  editing.value = false
}

// ── 所属项目：全局 + 已创建项目 ──
const projectOptions = computed(() => {
  const opts: Array<{ value: string; label: string }> = [{ value: '', label: t('knowledge.projectGlobal') }]
  for (const p of projectsStore.projects) opts.push({ value: p.id, label: p.name })
  return opts
})
const projectName = (id: string) => {
  if (!id) return t('knowledge.projectGlobal')
  return projectsStore.getProject(id)?.name || id
}

// ── CRUD ──
const editing = ref(false)
const isNew = ref(false)
const form = ref({
  title: '', summary: '', content: '', entry_type: 'doc', tags: '',
  project_id: '', source_url: '', source_label: '', parent_id: '', created_at: '',
  attachments: [] as KnowledgeAttachment[],
})

const TYPE_OPTIONS = [
  { value: 'doc', labelKey: 'knowledge.type.doc' },
  { value: 'manual', labelKey: 'knowledge.type.manual' },
  { value: 'note', labelKey: 'knowledge.type.note' },
  { value: 'reference', labelKey: 'knowledge.type.reference' },
]

/** 时间戳 → datetime-local 输入框值（YYYY-MM-DDTHH:mm） */
function tsToInput(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}
/** datetime-local 值 → 时间戳（空值返回 null） */
function inputToTs(v: string): number | null {
  if (!v) return null
  const t = new Date(v).getTime()
  return Number.isNaN(t) ? null : t
}

/** 父分类下拉（无父 = 根级；含当前选中分类优先） */
const parentFolderOptions = computed(() => {
  const opts: Array<{ value: string; label: string }> = [{ value: '', label: t('knowledge.form.noParent') }]
  for (const f of store.folders) {
    if (f.id === selectedId.value) continue
    opts.push({ value: f.id, label: f.title })
  }
  return opts
})

function startNew(folderId?: string) {
  editing.value = true
  isNew.value = true
  selectedId.value = null
  form.value = {
    title: '', summary: '', content: '', entry_type: 'doc', tags: '', project_id: '', source_url: '', source_label: '',
    parent_id: folderId || activeFolder.value || '',
    created_at: tsToInput(Date.now()),
    attachments: [],
  }
}

function startEdit() {
  const e = selectedEntry.value
  if (!e) return
  editing.value = true
  isNew.value = false
  form.value = {
    title: e.title,
    summary: e.summary,
    content: e.content,
    entry_type: e.entry_type,
    tags: (e.tags || []).join(', '),
    project_id: e.project_id,
    source_url: e.source_url,
    source_label: e.source_label,
    parent_id: e.parent_id,
    created_at: tsToInput(e.created_at),
    attachments: Array.isArray(e.attachments) ? e.attachments.map(a => ({ ...a })) : [],
  }
}

function cancelEdit() {
  editing.value = false
  if (isNew.value) selectedId.value = null
}

// ── 附件：图片上传 / 视频/文档/链接 ──
let attSeq = 0
function nextAttId(): string {
  attSeq += 1
  return `att_${Date.now().toString(36)}_${attSeq}`
}
const linkDraft = ref({ name: '', url: '', type: 'link' })

/** 图片文件 → 压缩 dataURL（最大边长 900px，JPEG 0.8） */
function readImageAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const img = new Image()
      img.onload = () => {
        const scale = Math.min(1, 900 / Math.max(img.width, img.height))
        const canvas = document.createElement('canvas')
        canvas.width = Math.max(1, Math.round(img.width * scale))
        canvas.height = Math.max(1, Math.round(img.height * scale))
        const ctx = canvas.getContext('2d')!
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
        resolve(canvas.toDataURL('image/jpeg', 0.8))
      }
      img.onerror = reject
      img.src = String(reader.result || '')
    }
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

function onAttachFile(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  readImageAsDataUrl(file)
    .then(dataUrl => {
      form.value.attachments.push({ id: nextAttId(), type: 'image', name: file.name, url: dataUrl })
    })
    .catch(() => {})
    .finally(() => { input.value = '' })
}

function addLinkAtt() {
  const name = linkDraft.value.name.trim()
  const url = linkDraft.value.url.trim()
  if (!url) return
  // 链接/视频/文档：名称可选，留空时展示 URL 本身
  form.value.attachments.push({
    id: nextAttId(),
    type: linkDraft.value.type,
    name,
    url,
  })
  linkDraft.value = { name: '', url: '', type: 'link' }
}

function removeAtt(id: string) {
  form.value.attachments = form.value.attachments.filter(a => a.id !== id)
}

// ── 详情附件：本地路径 → 展示内容（WS 拉取缓存） ──
const resolvedAttUrls = ref<Record<string, string>>({})
async function resolveAttUrl(att: KnowledgeAttachment): Promise<string> {
  // 非本地附件直接用 url（dataURL / http）
  if (!isLocalAttachment(att.url)) return att.url
  if (resolvedAttUrls.value[att.url]) return resolvedAttUrls.value[att.url]
  const data = await fetchAttachmentContent(localPathOf(att.url))
  if (data) {
    resolvedAttUrls.value[att.url] = data
    return data
  }
  return ''
}
/** 详情模板用：同步取已解析 url（没有就空，触发 onMounted 解析） */
function resolvedUrlOf(att: KnowledgeAttachment): string {
  if (!isLocalAttachment(att.url)) return att.url
  return resolvedAttUrls.value[att.url] || ''
}
/** 选中的附件变更后预解析本地图片 */
watch(selectedId, async () => {
  resolvedAttUrls.value = {}
  const e = selectedEntry.value
  if (!e?.attachments?.length) return
  for (const a of e.attachments) {
    if (isLocalAttachment(a.url)) {
      await resolveAttUrl(a)
    }
  }
})

const ATT_TYPES = [
  { value: 'link', labelKey: 'knowledge.att.link' },
  { value: 'video', labelKey: 'knowledge.att.video' },
  { value: 'doc', labelKey: 'knowledge.att.doc' },
]

// ── AI 提炼：结果回填表单 ──
const aiExtractOpen = ref(false)
const aiExtractPrefill = ref('')
function applyAIExtract(fields: AIExtractFields) {
  // 覆盖用户已填字段，未填的用提炼结果；已有内容则追加
  form.value.title = fields.title || form.value.title
  form.value.entry_type = fields.entry_type || form.value.entry_type
  form.value.summary = fields.summary || form.value.summary
  form.value.content = fields.content
    ? (form.value.content ? form.value.content + '\n\n' + fields.content : fields.content)
    : form.value.content
  form.value.source_label = fields.source_label || form.value.source_label
  const existingTags = form.value.tags.split(/[,，]/).map(s => s.trim()).filter(Boolean)
  form.value.tags = [...new Set([...existingTags, ...fields.tags])].join(', ')
}

async function saveForm() {
  const tags = form.value.tags.split(/[,，]/).map(s => s.trim()).filter(Boolean)
  const createdTs = inputToTs(form.value.created_at)
  const isFolder = form.value.entry_type === 'folder'

  // 附件：图片 dataURL → 后端本地存储（WS 连接时），未连接保留 dataURL
  let attachments = form.value.attachments
  if (!isFolder && form.value.attachments.length) {
    const entryId = selectedId.value || `kb_pending_${Date.now().toString(36)}`
    const uploaded = []
    for (const a of form.value.attachments) {
      if (a.type === 'image' && a.url.startsWith('data:')) {
        const res = await uploadAttachment(entryId, 'image', a.name, a.url)
        uploaded.push({ ...a, url: res?.url || a.url })
      } else {
        uploaded.push(a)
      }
    }
    attachments = uploaded
  }

  const payload = {
    ...form.value,
    tags,
    attachments,
    created_at: createdTs ?? undefined,
  }
  if (isNew.value) {
    const created = store.addEntry(payload)
    selectedId.value = created.id
  } else if (selectedId.value) {
    store.updateEntry(selectedId.value, payload)
  }
  editing.value = false
}

/** 新建分类（默认挂在当前选中分类下） */
function startNewFolder() {
  editing.value = true
  isNew.value = true
  selectedId.value = null
  form.value = {
    title: '', content: '', entry_type: 'folder', tags: '', project_id: '', source_url: '',
    parent_id: activeFolder.value || '',
    created_at: tsToInput(Date.now()),
    attachments: [],
  }
}

/** 删除知识条目确认（系统内弹窗，替代浏览器 confirm） */
const deleteConfirmOpen = ref(false)
function confirmDeleteEntry() {
  deleteConfirmOpen.value = false
  deleteEntry()
}
function deleteEntry() {
  if (!selectedId.value) return
  store.deleteEntry(selectedId.value)
  selectedId.value = null
  editing.value = false
}

const typeLabel = (type: string) => {
  const o = TYPE_OPTIONS.find(x => x.value === type)
  return o ? t(o.labelKey) : type
}
const timeStr = (ts: number) => {
  const d = new Date(ts)
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
const attIcon = (type: string) => {
  if (type === 'image') return 'fas fa-image'
  if (type === 'video') return 'fas fa-video'
  if (type === 'doc') return 'fas fa-file-lines'
  return 'fas fa-link'
}

watch(selectedId, () => { editing.value = false })
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
          :class="['dock-modal', isAnimating && !isClosing ? 'dock-in' : '', isClosing ? 'dock-out' : '']"
          class="relative w-[957px] max-w-[94vw] h-[82vh] bg-white rounded-[20px] shadow-[0_24px_70px_-20px_rgba(0,0,0,0.25)] border-[1.5px] border-gray-200 overflow-hidden flex flex-col"
        >
          <!-- 头部 -->
          <div class="px-7 pt-6 pb-4 border-b-[1.5px] border-gray-100 flex items-center justify-between gap-4 shrink-0">
            <div>
              <h2 class="text-base font-bold text-gray-900 tracking-tight flex items-center gap-2">
                {{ t('knowledge.title') }}
                <span class="text-[10px] font-normal text-gray-400 bg-gray-100 rounded-full px-2 py-0.5">{{ store.entries.length }}</span>
              </h2>
              <p class="text-[11px] text-gray-400 mt-0.5">{{ t('knowledge.subtitle') }}</p>
            </div>
            <div class="flex items-center gap-2">
              <div class="relative">
                <i class="fas fa-search text-[10px] text-gray-400 absolute left-3 top-1/2 -translate-y-1/2"></i>
                <input
                  v-model="keyword"
                  class="bg-gray-50 border border-gray-200 rounded-lg pl-8 pr-3 py-1.5 text-xs text-gray-800 outline-none focus:border-gray-400 w-48"
                  :placeholder="t('knowledge.searchPlaceholder')"
                />
              </div>
              <button
                @click="startNew()"
                class="btn btn-primary btn-sm"
              >
                <i class="fas fa-plus text-[10px]"></i>{{ t('knowledge.add') }}
              </button>
              <button
                @click="startNewFolder"
                class="flex items-center gap-1.5 text-xs font-[640] text-gray-600 bg-white border border-gray-300 hover:bg-gray-50 rounded-lg px-3 py-2 transition-colors active:scale-[0.97]"
              >
                <i class="fas fa-folder-plus text-[10px]"></i>{{ t('knowledge.addFolder') }}
              </button>
            </div>
          </div>

          <!-- 主体 -->
          <div class="flex-1 min-h-0 flex">
            <!-- 左侧：树形分类 -->
            <div class="w-[200px] shrink-0 border-r border-gray-100 bg-gray-50/60 overflow-y-auto custom-scroll p-2">
              <button
                @click="selectFolder(null)"
                :class="[
                  'w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-xs transition-colors mb-1',
                  activeFolder === null ? 'bg-black text-white font-[640]' : 'text-gray-600 hover:bg-gray-100',
                ]"
              >
                <i class="fas fa-stars text-[11px]"></i>{{ t('knowledge.treeAll') }}
              </button>
              <!-- 根分类（含条目，递归树） -->
              <KnowledgeFolderTree
                v-for="folder in store.rootFolders"
                :key="folder.id"
                :folder-id="folder.id"
                :depth="0"
                :active-folder="activeFolder"
                :active-entry-id="selectedId"
                @select="selectFolder"
                @select-entry="selectEntry"
              />
              <!-- 根级未分类条目 -->
              <template v-if="rootUncategorized.length">
                <div class="flex items-center gap-1.5 px-2.5 py-1.5 text-[10px] font-[640] text-gray-400 mt-2 mb-0.5 uppercase tracking-wide">
                  <i class="fas fa-inbox text-[9px]"></i>{{ t('knowledge.treeUncategorized') }}
                </div>
                <div
                  v-for="e in rootUncategorized"
                  :key="e.id"
                  :class="[
                    'flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs cursor-pointer transition-colors',
                    selectedId === e.id ? 'bg-black/5 text-gray-900 font-[530]' : 'text-gray-500 hover:bg-gray-100 hover:text-gray-700',
                  ]"
                  @click="selectEntry(e.id)"
                >
                  <i class="fas fa-file-lines text-[9px]"></i>
                  <span class="flex-1 truncate">{{ e.title }}</span>
                </div>
              </template>
            </div>

            <!-- 中部：星系图谱 + 浮动详情弹窗 -->
            <div class="flex-1 min-w-0 relative bg-[#070a1a]">
              <AtomCircleCanvas :items="galaxyNodes" :edges="galaxyEdges" :selected-id="selectedId" @select="selectedId = $event" />
              <!-- 当前分类名 -->
              <div class="absolute left-3 top-3 z-10 flex items-center gap-2 pointer-events-none">
                <span class="text-[11px] text-white/90 bg-black/30 border border-white/10 rounded-full px-3 py-1">
                  <i class="fas fa-folder text-[9px] mr-1"></i>{{ activeFolderName || t('knowledge.treeAll') }}
                  <span class="text-white/50 ml-1">· {{ filteredEntries.length }}</span>
                </span>
              </div>
              <!-- 类型图例 -->
              <div class="absolute left-3 top-10 flex items-center gap-2 flex-wrap max-w-[320px] z-10">
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

              <!-- 浮动详情弹窗：点节点弹出，点画布空白处消失 -->
              <Transition name="pop">
                <div
                  v-if="showDetail"
                  class="absolute right-3 top-3 bottom-3 w-[360px] z-20 bg-white rounded-2xl shadow-[0_16px_48px_-12px_rgba(0,0,0,0.5)] border border-gray-200 overflow-hidden flex flex-col"
                >
                  <!-- 面板关闭 X：仅「详情查看态」显示。编辑态交给表单头部那枚 X —— 
                       此前两枚 X 同时存在且坐标重叠（1149,163 / 1156,178），还会压住「AI 提炼」按钮 -->
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
                  <div v-if="!selectedEntry && !editing" class="h-full flex flex-col items-center justify-center px-8 text-center">
                    <div class="w-16 h-16 rounded-full bg-gray-100 text-gray-400 flex items-center justify-center mb-3">
                      <i class="fas fa-star text-xl"></i>
                    </div>
                    <p class="text-sm font-[530] text-gray-600">{{ t('knowledge.emptyTitle') }}</p>
                    <p class="text-[11px] text-gray-400 mt-1 leading-relaxed">{{ t('knowledge.emptyHint') }}</p>
                  </div>

                  <!-- 编辑表单 -->
                  <div v-else-if="editing" class="p-5">
                    <div class="flex items-center justify-between mb-4">
                      <h3 class="text-sm font-bold text-gray-900">
                        {{ form.entry_type === 'folder'
                            ? t('knowledge.form.folder')
                            : (isNew ? t('knowledge.form.new') : t('knowledge.form.edit')) }}
                      </h3>
                      <div class="flex items-center gap-1.5">
                        <button
                          v-if="form.entry_type !== 'folder'"
                          @click="aiExtractOpen = true"
                          class="flex items-center gap-1 text-[11px] font-[640] text-gray-600 bg-white border border-gray-200 hover:bg-gray-100 hover:border-gray-300 rounded-lg px-2.5 py-1.5 transition-colors"
                        >
                          <i class="fas fa-wand-magic-sparkles text-[10px]"></i>{{ t('aiExtract.btn') }}
                        </button>
                        <!-- 表单关闭 X：与面板 X 同款圆形按钮（此前是无内边距的裸 <i>，8×17px 且与面板 X 重叠） -->
                        <button
                          @click="cancelEdit"
                          :title="t('knowledge.form.cancel')"
                          class="shrink-0 w-6 h-6 flex items-center justify-center rounded-full bg-gray-100 text-gray-400 hover:text-gray-600 hover:bg-gray-200 transition-colors"
                        >
                          <i class="fas fa-times text-[10px]"></i>
                        </button>
                      </div>
                    </div>
                    <div class="space-y-3">
                      <div>
                        <label class="block text-[11px] font-[640] text-gray-500 mb-1">{{ t('knowledge.form.title') }}</label>
                        <input v-model="form.title" class="w-full bg-white border border-gray-200 rounded-lg px-3 py-2 text-xs text-gray-800 outline-none focus:border-gray-400" />
                      </div>
                      <div v-if="form.entry_type !== 'folder'">
                        <label class="block text-[11px] font-[640] text-gray-500 mb-1">{{ t('knowledge.form.type') }}</label>
                        <div class="flex flex-wrap gap-1.5">
                          <button
                            v-for="opt in TYPE_OPTIONS" :key="opt.value"
                            @click="form.entry_type = opt.value"
                            :class="[
                              'text-[11px] px-3 py-1.5 rounded-full border transition-colors',
                              form.entry_type === opt.value
                                ? 'bg-black text-white border-black'
                                : 'bg-white text-gray-500 border-gray-200 hover:border-gray-300',
                            ]"
                          >{{ t(opt.labelKey) }}</button>
                        </div>
                      </div>
                      <div v-if="form.entry_type !== 'folder'">
                        <label class="block text-[11px] font-[640] text-gray-500 mb-1">{{ t('knowledge.form.summary') }}</label>
                        <input v-model="form.summary" class="w-full bg-white border border-gray-200 rounded-lg px-3 py-2 text-xs text-gray-800 outline-none focus:border-gray-400" :placeholder="t('knowledge.form.summaryPlaceholder')" />
                      </div>
                      <div v-if="form.entry_type !== 'folder'">
                        <label class="block text-[11px] font-[640] text-gray-500 mb-1">{{ t('knowledge.form.content') }}</label>
                        <textarea v-model="form.content" rows="6" class="w-full bg-white border border-gray-200 rounded-lg px-3 py-2 text-xs text-gray-800 outline-none focus:border-gray-400 resize-none leading-relaxed"></textarea>
                      </div>
                      <div v-if="form.entry_type !== 'folder'">
                        <label class="block text-[11px] font-[640] text-gray-500 mb-1">{{ t('knowledge.form.tags') }}</label>
                        <input v-model="form.tags" class="w-full bg-white border border-gray-200 rounded-lg px-3 py-2 text-xs text-gray-800 outline-none focus:border-gray-400" :placeholder="t('knowledge.form.tagsPlaceholder')" />
                      </div>
                      <div v-if="form.entry_type !== 'folder'">
                        <label class="block text-[11px] font-[640] text-gray-500 mb-1">{{ t('knowledge.form.time') }}</label>
                        <input v-model="form.created_at" type="datetime-local" class="w-full bg-white border border-gray-200 rounded-lg px-3 py-2 text-xs text-gray-800 outline-none focus:border-gray-400" />
                      </div>
                      <div v-if="form.entry_type !== 'folder'">
                        <label class="block text-[11px] font-[640] text-gray-500 mb-1">{{ t('knowledge.form.source') }}</label>
                        <input v-model="form.source_label" class="w-full bg-white border border-gray-200 rounded-lg px-3 py-2 text-xs text-gray-800 outline-none focus:border-gray-400" :placeholder="t('knowledge.form.sourcePlaceholder')" />
                      </div>
                      <div v-if="form.entry_type !== 'folder'">
                        <label class="block text-[11px] font-[640] text-gray-500 mb-1">{{ t('knowledge.form.sourceUrl') }}</label>
                        <input v-model="form.source_url" class="w-full bg-white border border-gray-200 rounded-lg px-3 py-2 text-xs text-gray-800 outline-none focus:border-gray-400" :placeholder="t('knowledge.form.sourceUrlPlaceholder')" />
                      </div>
                      <!-- 附件：图片 / 视频 / 文档 / 链接 -->
                      <div v-if="form.entry_type !== 'folder'">
                        <label class="block text-[11px] font-[640] text-gray-500 mb-1">{{ t('knowledge.att.title') }}</label>
                        <!-- 已添加附件 -->
                        <div v-if="form.attachments.length" class="space-y-1.5 mb-2">
                          <div v-for="a in form.attachments" :key="a.id" class="flex items-center gap-2 bg-white border border-gray-100 rounded-lg px-2.5 py-1.5 text-[10px]">
                            <i :class="attIcon(a.type)" class="text-[10px] text-gray-600"></i>
                            <span class="flex-1 truncate text-gray-700">{{ a.name }}</span>
                            <button @click="removeAtt(a.id)" class="text-gray-300 hover:text-red-500 transition-colors"><i class="fas fa-xmark"></i></button>
                          </div>
                        </div>
                        <!-- 上传图片 -->
                        <div class="flex gap-1.5 mb-1.5">
                          <label class="flex-1 flex items-center justify-center gap-1.5 text-[10px] font-[640] text-gray-600 bg-white border border-dashed border-gray-300 hover:border-gray-400 hover:text-gray-800 rounded-lg px-2 py-2 cursor-pointer transition-colors">
                            <i class="fas fa-image text-[10px]"></i>{{ t('knowledge.att.uploadImage') }}
                            <input type="file" accept="image/*" hidden @change="onAttachFile" />
                          </label>
                        </div>
                        <!-- 添加链接 / 视频 / 文档 -->
                        <div class="flex gap-1.5">
                          <select v-model="linkDraft.type" class="bg-white border border-gray-200 rounded-lg px-2 py-1.5 text-[10px] text-gray-700 outline-none focus:border-gray-400">
                            <option v-for="opt in ATT_TYPES" :key="opt.value" :value="opt.value">{{ t(opt.labelKey) }}</option>
                          </select>
                          <input v-model="linkDraft.name" class="flex-1 min-w-0 bg-white border border-gray-200 rounded-lg px-2 py-1.5 text-[10px] text-gray-800 outline-none focus:border-gray-400" :placeholder="t('knowledge.att.namePlaceholder')" />
                          <input v-model="linkDraft.url" class="flex-1 min-w-0 bg-white border border-gray-200 rounded-lg px-2 py-1.5 text-[10px] text-gray-800 outline-none focus:border-gray-400" :placeholder="t('knowledge.att.urlPlaceholder')" />
                          <button @click="addLinkAtt" class="btn btn-primary btn-xs">{{ t('knowledge.att.add') }}</button>
                        </div>
                      </div>
                      <div>
                        <label class="block text-[11px] font-[640] text-gray-500 mb-1">{{ t('knowledge.form.parent') }}</label>
                        <select v-model="form.parent_id" class="w-full bg-white border border-gray-200 rounded-lg px-3 py-2 text-xs text-gray-800 outline-none focus:border-gray-400">
                          <option v-for="opt in parentFolderOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
                        </select>
                      </div>
                      <div v-if="form.entry_type !== 'folder'">
                        <label class="block text-[11px] font-[640] text-gray-500 mb-1">{{ t('knowledge.form.project') }}</label>
                        <select v-model="form.project_id" class="w-full bg-white border border-gray-200 rounded-lg px-3 py-2 text-xs text-gray-800 outline-none focus:border-gray-400">
                          <option v-for="opt in projectOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
                        </select>
                      </div>
                    </div>
                    <div class="flex gap-2 mt-5">
                      <button @click="saveForm" class="flex-1 btn btn-primary btn-sm">{{ t('knowledge.form.save') }}</button>
                      <button @click="cancelEdit" class="btn btn-secondary btn-sm">{{ t('knowledge.form.cancel') }}</button>
                    </div>
                  </div>

                  <!-- 详情 -->
                  <div v-else class="p-5">
                    <div class="flex items-start justify-between gap-2 mb-1 pr-8">
                      <h3 class="text-sm font-bold text-gray-900 leading-snug">{{ selectedEntry!.title }}</h3>
                      <span class="text-[10px] shrink-0 px-2 py-0.5 rounded-full font-[640] bg-gray-100 text-gray-700 border border-gray-200">{{ typeLabel(selectedEntry!.entry_type) }}</span>
                    </div>
                    <div class="flex flex-wrap gap-1 mb-3">
                      <span v-for="tg in (selectedEntry!.tags || [])" :key="tg" class="text-[10px] px-2 py-0.5 rounded-full bg-gray-100 text-gray-500">{{ tg }}</span>
                    </div>
                    <p v-if="selectedEntry!.summary" class="text-[11px] font-[530] text-gray-700 bg-gray-50 border border-gray-100 rounded-lg px-3 py-2 mb-3">{{ selectedEntry!.summary }}</p>
                    <p class="text-xs text-gray-600 leading-relaxed whitespace-pre-wrap bg-white border border-gray-100 rounded-xl p-3.5 mb-4">{{ selectedEntry!.content || t('knowledge.emptyContent') }}</p>
                    <!-- 附件 -->
                    <div v-if="selectedEntry!.attachments?.length" class="mb-4">
                      <h4 class="text-[11px] font-bold text-gray-500 mb-2 flex items-center gap-1.5">
                        <i class="fas fa-paperclip text-[9px]"></i>{{ t('knowledge.att.title') }}
                        <span class="text-[10px] font-normal text-gray-400">{{ selectedEntry!.attachments.length }}</span>
                      </h4>
                      <div class="space-y-2">
                        <div v-for="a in selectedEntry!.attachments" :key="a.id" class="rounded-xl border border-gray-100 bg-white overflow-hidden">
                          <!-- 图片：dataURL / http 直接显示；nis:// 本地附件经 WS 拉取 -->
                          <img v-if="a.type === 'image' && resolvedUrlOf(a)" :src="resolvedUrlOf(a)" :alt="a.name" class="w-full max-h-40 object-contain bg-black/5" />
                          <!-- 视频：http 可内嵌播放；本地视频回退为链接 -->
                          <video v-else-if="a.type === 'video' && !isLocalAttachment(a.url) && /\.(mp4|webm|ogg|m3u8)(\?|$)/i.test(a.url)" :src="a.url" controls class="w-full max-h-40 bg-black" />
                          <!-- 链接 / 文档 / 本地文件 -->
                          <a
                            v-else
                            :href="isLocalAttachment(a.url) ? '' : a.url"
                            :class="['flex items-center gap-2 px-3 py-2.5 text-[11px] text-gray-700 transition-colors', isLocalAttachment(a.url) ? 'cursor-default' : 'hover:bg-gray-50 hover:text-gray-800']"
                          >
                            <i :class="attIcon(a.type)" class="text-[11px] text-gray-600"></i>
                            <span class="flex-1 truncate">{{ a.name || localPathOf(a.url) }}</span>
                            <i v-if="!isLocalAttachment(a.url)" class="fas fa-arrow-up-right-from-square text-[9px] text-gray-300"></i>
                          </a>
                        </div>
                      </div>
                    </div>
                    <div class="text-[10px] text-gray-400 space-y-1 mb-4">
                      <div class="flex items-center gap-1.5"><i class="fas fa-folder text-[9px]"></i>{{ projectName(selectedEntry!.project_id) }}</div>
                      <div class="flex items-center gap-1.5"><i class="fas fa-calendar text-[9px]"></i>{{ t('knowledge.created') }} {{ timeStr(selectedEntry!.created_at) }}</div>
                      <div v-if="selectedEntry!.source_label" class="flex items-center gap-1.5"><i class="fas fa-bookmark text-[9px]"></i>{{ selectedEntry!.source_label }}</div>
                      <div v-if="selectedEntry!.source_url" class="flex items-center gap-1.5"><i class="fas fa-link text-[9px]"></i><span class="truncate">{{ selectedEntry!.source_url }}</span></div>
                      <div class="flex items-center gap-1.5"><i class="fas fa-clock text-[9px]"></i>{{ t('knowledge.updated') }} {{ timeStr(selectedEntry!.updated_at) }} · v{{ selectedEntry!.version }}</div>
                    </div>
                    <div class="flex gap-2">
                      <button @click="startEdit" class="flex-1 btn btn-secondary btn-sm">
                        <i class="fas fa-pen text-[10px] mr-1"></i>{{ t('knowledge.edit') }}
                      </button>
                      <button @click="deleteConfirmOpen = true" class="flex-1 btn btn-danger btn-sm">
                        <i class="fas fa-trash-can text-[10px] mr-1"></i>{{ t('knowledge.delete') }}
                      </button>
                    </div>
                  </div>
                  </div>
                </div>
              </Transition>
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

    <!-- AI 提炼弹窗 -->
    <AIExtractModal :open="aiExtractOpen" :prefill="aiExtractPrefill" @close="aiExtractOpen = false" @apply="applyAIExtract" />
  </Teleport>

  <!-- 删除知识条目确认（系统内弹窗） -->
  <Teleport to="body">
    <div v-if="deleteConfirmOpen" class="fixed inset-0 z-[10010] flex items-center justify-center bg-black/40" @click.self="deleteConfirmOpen = false">
      <div class="w-[340px] bg-white rounded-2xl shadow-2xl p-6">
        <h3 class="text-[15px] font-[640] text-gray-800 mb-2">{{ t('knowledge.deleteConfirmTitle') }}</h3>
        <p class="text-[13px] text-gray-500 leading-relaxed mb-5">{{ t('knowledge.deleteConfirmMsg') }}</p>
        <div class="flex justify-end gap-2">
          <button class="btn btn-secondary btn-sm" @click="deleteConfirmOpen = false">{{ t('knowledge.form.cancel') }}</button>
          <button class="btn btn-danger btn-sm" @click="confirmDeleteEntry">{{ t('knowledge.delete') }}</button>
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
