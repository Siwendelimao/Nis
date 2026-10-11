<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted, nextTick, computed } from 'vue'
import { t } from '@/utils/i18n'
import {
  useNotebookStore, NOTEBOOK_STATUSES, NOTEBOOK_STATUS_STYLE, notebookImageUrl,
  type NotebookStatus, type NotebookItem, type NotebookImage,
} from '@/stores/notebook'
import { useChatStore } from '@/stores/chat'
import ImageViewer from './blocks/ImageViewer.vue'

/**
 * 便签（0920，原名"用户记事本"）
 *
 * 交互口径（既定的）：
 *   · 打开就是**列表**，点某条才展开**详情**（标题 + 详情）
 *   · 状态用下拉切换：待办 / 搁置 / 已完成 / 取消
 *   · 已完成、取消的条目：标题划掉 + 打标记（✓ / ✕）
 *   · 每条可删除（二次确认）
 *   · 这本便签 AI 也能读写（AI 写的条目带「AI」来源标记）
 *
 * 0920 动画：面板弹出、条目错峰入场、展开详情、改状态闪一下、删除淡出再落数据。
 * 铁律仍是只动 opacity/transform（WebView2 下 layout 动画容易掉帧）。
 */
const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: [] }>()

const store = useNotebookStore()
const chatStore = useChatStore()

/** ★ 0923：把这条便签以**标签形式置入当前对话输入框**（便签面板随即关闭）。
 *  走的是既有的 pendingInsert 通道（RightPanel 置入元素/文件用的同一条路）——
 *  ChatInput 里 watch 到就 insertTagAtCursor，光标处落一个 chip，发送时按便签文本带出。 */
function injectToChat(item: NotebookItem) {
  chatStore.requestInsertTag(item.title, {
    tagType: 'note',
    noteId: item.id,
    noteTitle: item.title,
    noteDetail: item.detail,
    noteStatus: item.status,
  })
  close()
}

const show = ref(false)
/** 展开了详情的条目 id（同一时刻只展开一条） */
const expandedId = ref('')
/** 打开了状态下拉菜单的条目 id */
const statusMenuId = ref('')
/** 正在编辑的条目 id */
const editingId = ref('')
/** 等待删除确认的条目 id */
const confirmId = ref('')
/** 正在播删除动画的条目 id */
const removingId = ref('')
/** 刚改过状态的条目（闪一下，让"改成功了"看得见） */
const justChangedId = ref('')
const editForm = ref({ title: '', detail: '', images: [] as NotebookImage[] })
/** 新增表单 */
const composerOpen = ref(false)
const composer = ref({ title: '', detail: '', status: 'todo' as NotebookStatus })
/** ★ 1011：详情贴图 —— 编辑态待提交的图片（保存时才随条目落库） */
const imgInputRef = ref<HTMLInputElement | null>(null)
const imgBusy = ref(false)
const imgErr = ref('')
/** 正在全屏查看的图片地址（null = 关着） */
const viewingImg = ref<string | null>(null)
const busy = ref(false)

let flashTimer: ReturnType<typeof setTimeout> | undefined

watch(() => props.open, (v) => {
  if (v) {
    show.value = true
    expandedId.value = ''
    editingId.value = ''
    confirmId.value = ''
    statusMenuId.value = ''
    removingId.value = '' as unknown as string
    composerOpen.value = false
    composer.value = { title: '', detail: '', status: 'todo' }
    void store.load()
  } else {
    show.value = false
    hideImgHover()   // ★1011c：面板关掉，悬停预览必须一起收（否则会留在屏幕上）
  }
})

const STAGGER_MS = 26
/** 条目错峰入场（只给前 10 条加延迟，后面的一起进，别让长列表慢吞吞） */
function rowDelay(i: number): string {
  return Math.min(i, 10) * STAGGER_MS + 'ms'
}

function close() {
  show.value = false
  emit('close')
}

function statusLabel(s: NotebookStatus): string {
  return t('notebook.status.' + s)
}

function fmtTime(ts: number): string {
  if (!ts) return ''
  const d = new Date(ts)
  const now = new Date()
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  if (d.toDateString() === now.toDateString()) return hm
  const sameYear = d.getFullYear() === now.getFullYear()
  const md = `${d.getMonth() + 1}/${d.getDate()}`
  return sameYear ? `${md} ${hm}` : `${d.getFullYear()}/${md}`
}

function toggleRow(id: string) {
  expandedId.value = expandedId.value === id ? '' : id
  if (editingId.value && editingId.value !== id) editingId.value = ''
  confirmId.value = ''
}

function openStatusMenu(id: string) {
  statusMenuId.value = statusMenuId.value === id ? '' : id
}

async function setStatus(item: NotebookItem, s: NotebookStatus) {
  statusMenuId.value = ''
  if (item.status === s) return
  busy.value = true
  try {
    await store.update(item.id, { status: s })
    // 改完闪一下：状态是可视线索（划掉/打勾），但光标可能不在那儿，给个即时反馈
    justChangedId.value = item.id
    if (flashTimer) clearTimeout(flashTimer)
    flashTimer = setTimeout(() => { justChangedId.value = '' }, 520)
  } finally { busy.value = false }
}

function startEdit(item: NotebookItem) {
  editingId.value = item.id
  editForm.value = { title: item.title, detail: item.detail, images: [...(item.images || [])] }
  imgErr.value = ''
  nextTick(() => {
    const el = document.getElementById('nb-edit-title') as HTMLInputElement | null
    el?.focus()
    el?.select()
  })
}

async function saveEdit(item: NotebookItem) {
  const title = editForm.value.title.trim()
  if (!title) return
  busy.value = true
  try {
    /* ★ 1011：图片随条目一起提交（整体替换） */
    await store.update(item.id, {
      title,
      detail: editForm.value.detail,
      images: editForm.value.images,
    })
    editingId.value = ''
  } finally { busy.value = false }
}

/* ── ★ 1011：详情贴图（标签形式，同输入框）────────────────────────────────
   交互：在详情里 粘贴（Ctrl+V）/ 拖入 / 点「图片」选文件 → 先落盘拿回 ref（同一张图后端去重），
   存进 editForm.images；点「保存」才随条目提交 —— 取消编辑 = 条目不变（盘上那份图成未引用文件，不显示）。
   大小：超过 ~1.2MB 的先压一道（长边 1600 / JPEG 0.85），后端再兜一道 3MB 硬闸。 */
const MAX_IMAGES = 8
function pickImages() { imgInputRef.value?.click() }

async function fileToDataUrlForNote(f: File): Promise<string> {
  const raw = await new Promise<string>((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result || ''))
    r.onerror = () => reject(new Error('read failed'))
    r.readAsDataURL(f)
  })
  if (raw.length < 1_200_000) return raw   // 已经不大：原样（保留 PNG 无损 / 透明）
  return await new Promise<string>((resolve) => {
    const img = new Image()
    img.onload = () => {
      try {
        const scale = Math.min(1, 1600 / Math.max(img.width, img.height))
        const cv = document.createElement('canvas')
        cv.width = Math.max(1, Math.round(img.width * scale))
        cv.height = Math.max(1, Math.round(img.height * scale))
        const ctx = cv.getContext('2d')
        if (!ctx) return resolve(raw)
        ctx.drawImage(img, 0, 0, cv.width, cv.height)
        resolve(cv.toDataURL('image/jpeg', 0.85))
      } catch { resolve(raw) }
    }
    img.onerror = () => resolve(raw)
    img.src = raw
  })
}

async function attachEditImages(files: File[]) {
  const imgs = files.filter(f => f.type.startsWith('image/'))
  if (!imgs.length) return
  imgErr.value = ''
  imgBusy.value = true
  try {
    for (const f of imgs) {
      if (editForm.value.images.length >= MAX_IMAGES) { imgErr.value = t('notebook.imageLimit'); break }
      try {
        const dataUrl = await fileToDataUrlForNote(f)
        const meta = await store.addImage(dataUrl, f.name || 'image')
        if (meta) editForm.value.images.push(meta)
        else imgErr.value = t('notebook.imageFailed')
      } catch (e: any) {
        imgErr.value = String(e?.message || e).slice(0, 140)
      }
    }
  } finally { imgBusy.value = false }
}

function onPickImages(e: Event) {
  const input = e.target as HTMLInputElement
  void attachEditImages(Array.from(input.files || []))
  input.value = ''
}

/** 纯文字粘贴放行走默认行为；带图才接管（图片走标签通道，不塞进文本）。
 *  ⚠️ 剪贴板里"文字 + 图"同时存在时（网页/QQ 复制），接管后浏览器默认粘贴就不执行了 ——
 *  所以文字要**手动插到光标处**，否则用户会遇到"图进来了、字没了"（ChatInput 踩过的同款坑）。 */
function onEditPaste(e: ClipboardEvent) {
  const files: File[] = []
  for (const it of Array.from(e.clipboardData?.items || [])) {
    if (it.kind === 'file' && it.type.startsWith('image/')) {
      const f = it.getAsFile()
      if (f) files.push(f)
    }
  }
  if (!files.length) return
  e.preventDefault()
  const text = String(e.clipboardData?.getData('text/plain') || '')
  if (text) {
    const el = e.currentTarget as HTMLTextAreaElement | null
    if (el) {
      const start = el.selectionStart ?? el.value.length
      const end = el.selectionEnd ?? start
      const next = el.value.slice(0, start) + text + el.value.slice(end)
      el.value = next
      el.selectionStart = el.selectionEnd = start + text.length
      editForm.value.detail = next
    }
  }
  void attachEditImages(files)
}

function onEditDrop(e: DragEvent) {
  const files = Array.from(e.dataTransfer?.files || []).filter(f => f.type.startsWith('image/'))
  if (!files.length) return
  e.preventDefault()
  void attachEditImages(files)
}

function removeEditImage(ref: string) {
  /* ★1011c：元素一被移除，浏览器就不再派发 mouseleave —— 不先收掉预览，
     悬停的大图会一直卡在屏幕上（实测：点 × 删图后预览不消失）。 */
  hideImgHover()
  editForm.value.images = editForm.value.images.filter(x => x.ref !== ref)
}

/* ── ★1011b：悬停预览 ────────────────────────────────────────────────────
   浮层用 fixed + Teleport 到 body：便签面板的 `.nb-body` 是滚动容器（overflow-y:auto），
   绝对定位的浮层会被它裁掉一半；图片本身就是同一个 URL，浏览器走缓存，零额外请求。 */
const hoverImg = ref<{ src: string; x: number; y: number } | null>(null)
let hoverTimer: ReturnType<typeof setTimeout> | undefined
function showImgHover(ref: string, e: MouseEvent) {
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
  const box = { src: notebookImageUrl(ref), x: r.left + r.width / 2, y: r.top }
  clearTimeout(hoverTimer)
  hoverTimer = setTimeout(() => { hoverImg.value = box }, 180)   // 180ms 防"划过就闪"
}
function hideImgHover() {
  clearTimeout(hoverTimer)
  hoverTimer = undefined
  hoverImg.value = null
}
/* ★1011c 兜底：元素被移除/替换（删图、编辑↔查看态切换、列表重排、拖拽）时浏览器
   **不会**派发 mouseleave，预览就卡在屏幕上。所以不只靠 mouseleave —— 鼠标一动就核对
   "光标还在不在图片标签上"，不在就收掉。capture 阶段监听，免得被面板里别的
   stopPropagation 吞掉；hoverImg/hoverTimer 都为空时直接返回，零开销。 */
function onDocPointerMove(e: PointerEvent) {
  if (!hoverTimer && !hoverImg.value) return
  const el = e.target as HTMLElement | null
  if (!el || typeof el.closest !== 'function' || !el.closest('.nb-img-chip')) hideImgHover()
}
/** ★1011c：点开全屏大图时先收掉悬停预览（否则预览浮层会压在查看器上面） */
function openViewer(ref: string) {
  hideImgHover()
  viewingImg.value = notebookImageUrl(ref)
}

/** 删除：先播 180ms 淡出/右移，再动数据（否则列表会啪地跳一下） */
const ROW_LEAVE_MS = 180
function removeItem(item: NotebookItem) {
  if (removingId.value === item.id) return
  confirmId.value = ''
  removingId.value = item.id
  setTimeout(() => {
    void store.remove(item.id)
    if (expandedId.value === item.id) expandedId.value = ''
    removingId.value = '' as unknown as string
  }, ROW_LEAVE_MS)
}

async function submitComposer() {
  const title = composer.value.title.trim()
  if (!title || busy.value) return
  busy.value = true
  try {
    const it = await store.add({ title, detail: composer.value.detail, status: composer.value.status })
    composer.value = { title: '', detail: '', status: 'todo' }
    composerOpen.value = false
    if (it?.id) expandedId.value = it.id
  } finally { busy.value = false }
}

/** 点空白处：关状态下拉（编辑/删除确认保留，误触可惜） */
function onDocClick(e: MouseEvent) {
  const el = e.target as HTMLElement | null
  if (el?.closest?.('.nb-status-wrap')) return
  statusMenuId.value = ''
}

function onKeydown(e: KeyboardEvent) {
  if (e.key !== 'Escape' || !props.open) return
  if (composerOpen.value) { composerOpen.value = false; return }
  if (editingId.value) { editingId.value = ''; return }
  if (confirmId.value) { confirmId.value = ''; return }
  close()
}

onMounted(() => {
  document.addEventListener('click', onDocClick)
  document.addEventListener('keydown', onKeydown)
  /* ★1011c：悬停预览的兜底清理 —— 见 onDocPointerMove（元素消失时 mouseleave 不会来） */
  document.addEventListener('pointermove', onDocPointerMove, true)
})
onUnmounted(() => {
  document.removeEventListener('click', onDocClick)
  document.removeEventListener('keydown', onKeydown)
  document.removeEventListener('pointermove', onDocPointerMove, true)
  if (flashTimer) clearTimeout(flashTimer)
})

const totalCount = computed(() => store.items.length)
</script>

<template>
  <Teleport to="body">
    <Transition name="nb-fade">
      <div v-if="show" class="fixed inset-0 z-[100] bg-black/35" @click.self="close"></div>
    </Transition>
    <Transition name="nb-pop">
      <div v-if="show" class="fixed inset-0 z-[101] flex items-start justify-center pt-[7vh] px-4 pointer-events-none">
        <div class="nb-panel pointer-events-auto">
          <!-- 头部 -->
          <div class="nb-head">
            <div class="flex items-center gap-2 min-w-0">
              <span class="nb-head-icon"><i class="fas fa-note-sticky text-[12.5px]"></i></span>
              <h2 class="text-[15px] font-bold text-gray-900 truncate">{{ t('notebook.title') }}</h2>
              <span v-if="totalCount" class="text-[11px] text-gray-400 shrink-0">
                {{ t('notebook.entryCount', { n: totalCount }) }}
              </span>
            </div>
            <div class="flex items-center gap-1.5 shrink-0">
              <button class="btn btn-primary btn-sm gap-1" @click="composerOpen = !composerOpen">
                <i :class="['text-[9px]', composerOpen ? 'fas fa-minus' : 'fas fa-plus']"></i>
                {{ t('notebook.new') }}
              </button>
              <button class="nb-close" @click="close"><i class="fas fa-times text-xs"></i></button>
            </div>
          </div>

          <!-- 筛选 + 搜索 -->
          <div class="nb-toolbar">
            <div class="nb-chips">
              <button
                class="nb-chip"
                :class="{ 'is-on': store.filter === 'all' }"
                @click="store.filter = 'all'"
              >{{ t('notebook.filter.all') }} <span class="nb-chip-n">{{ totalCount }}</span></button>
              <button
                v-for="s in NOTEBOOK_STATUSES"
                :key="s"
                class="nb-chip"
                :class="[NOTEBOOK_STATUS_STYLE[s].cls, { 'is-on': store.filter === s }]"
                @click="store.filter = s"
              >
                <i :class="['text-[9px] mr-1', NOTEBOOK_STATUS_STYLE[s].icon]"></i>
                {{ statusLabel(s) }} <span class="nb-chip-n">{{ store.counts[s] }}</span>
              </button>
            </div>
            <div class="nb-search">
              <i class="fas fa-magnifying-glass text-[10px] text-gray-400"></i>
              <input v-model="store.keyword" class="nb-search-input" :placeholder="t('notebook.searchPh')" />
              <button v-if="store.keyword" class="nb-search-clear" @click="store.keyword = ''">
                <i class="fas fa-times text-[9px]"></i>
              </button>
            </div>
          </div>

          <p class="nb-hint">{{ t('notebook.hint') }}</p>
          <p v-if="store.error" class="nb-error">{{ t('notebook.loadFailed') }}：{{ store.error }}</p>

          <div class="nb-body custom-scroll">
            <!-- 新增表单：滑下来 -->
            <Transition name="nb-slide">
              <div v-if="composerOpen" class="nb-composer">
                <input v-model="composer.title" class="nb-input" :placeholder="t('notebook.titlePh')" @keydown.enter="submitComposer" />
                <textarea v-model="composer.detail" class="nb-input nb-textarea" rows="2" :placeholder="t('notebook.detailPh')"></textarea>
                <div class="nb-quick-status">
                  <button
                    v-for="s in NOTEBOOK_STATUSES"
                    :key="s"
                    class="nb-mini-status"
                    :class="[NOTEBOOK_STATUS_STYLE[s].cls, { 'is-on': composer.status === s }]"
                    @click="composer.status = s"
                  >{{ statusLabel(s) }}</button>
                </div>
                <div class="flex items-center gap-2">
                  <span class="flex-1"></span>
                  <button class="btn btn-secondary btn-sm" @click="composerOpen = false">{{ t('notebook.cancel') }}</button>
                  <button class="btn btn-primary btn-sm" :disabled="!composer.title.trim() || busy" @click="submitComposer">
                    {{ t('notebook.save') }}
                  </button>
                </div>
              </div>
            </Transition>

            <!-- 空状态 -->
            <Transition name="nb-fade">
              <div v-if="!store.visible.length" class="nb-empty">
                <i class="far fa-note-sticky text-[26px] text-gray-300"></i>
                <p class="text-sm text-gray-500 mt-3">{{ t('notebook.empty') }}</p>
                <p class="text-xs text-gray-400 mt-1.5 text-center leading-relaxed px-8">{{ t('notebook.emptyHint') }}</p>
              </div>
            </Transition>

            <!-- 列表：条目错峰入场 -->
            <div v-if="store.visible.length" class="nb-list">
              <div
                v-for="(item, i) in store.visible"
                :key="item.id"
                class="nb-row"
                :class="{
                  'is-open': expandedId === item.id,
                  'is-closed': item.status === 'done' || item.status === 'cancelled',
                  'is-removing': removingId === item.id,
                  'is-changed': justChangedId === item.id,
                  'is-menu-open': statusMenuId === item.id,
                }"
                :style="{ animationDelay: rowDelay(i) }"
              >
                <div class="flex items-start gap-2.5">
                  <!-- 状态：点开下拉改状态 -->
                  <div class="nb-status-wrap relative shrink-0">
                    <button
                      class="nb-status-btn"
                      :class="NOTEBOOK_STATUS_STYLE[item.status].cls"
                      :title="t('notebook.statusMenu')"
                      @click.stop="openStatusMenu(item.id)"
                    >
                      <i :class="['text-[10px]', NOTEBOOK_STATUS_STYLE[item.status].icon]"></i>
                    </button>
                    <Transition name="nb-drop">
                      <div v-if="statusMenuId === item.id" class="nb-status-menu" @click.stop>
                        <button
                          v-for="s in NOTEBOOK_STATUSES"
                          :key="s"
                          class="nb-status-item"
                          :class="[NOTEBOOK_STATUS_STYLE[s].cls, { 'is-on': item.status === s }]"
                          @click="setStatus(item, s)"
                        >
                          <i :class="['text-[10px] mr-2', NOTEBOOK_STATUS_STYLE[s].icon]"></i>{{ statusLabel(s) }}
                          <i v-if="item.status === s" class="fas fa-check text-[9px] ml-auto"></i>
                        </button>
                      </div>
                    </Transition>
                  </div>

                  <!-- 标题 + 摘要：点这里展开详情 -->
                  <div class="flex-1 min-w-0 cursor-pointer" @click="toggleRow(item.id)">
                    <div class="flex items-center gap-1.5 min-w-0">
                      <Transition name="nb-check">
                        <i
                          v-if="item.status === 'done'"
                          class="fas fa-check text-[10px] text-emerald-600 shrink-0"
                        ></i>
                      </Transition>
                      <span class="nb-title" :class="{ 'is-struck': item.status === 'done' || item.status === 'cancelled' }">
                        {{ item.title }}
                      </span>
                      <span v-if="item.source === 'ai'" class="nb-src is-ai">{{ t('notebook.srcAi') }}</span>
                      <span v-else class="nb-src">{{ t('notebook.srcUser') }}</span>
                    </div>
                    <div
                      v-if="expandedId !== item.id && item.detail"
                      class="text-[11px] text-gray-400 mt-1 truncate"
                    >{{ item.detail }}</div>
                  </div>

                  <span class="text-[10px] text-gray-400 shrink-0 mt-0.5">{{ fmtTime(item.updatedAt) }}</span>
                  <button class="nb-icon-btn is-danger shrink-0" :title="t('notebook.delete')" @click.stop="confirmId = item.id">
                    <i class="fas fa-trash text-[10px]"></i>
                  </button>
                </div>

                <!-- 展开：详情（渐显 + 轻微下滑） -->
                <Transition name="nb-detail">
                  <div v-if="expandedId === item.id" class="nb-detail">
                    <template v-if="editingId === item.id">
                      <input id="nb-edit-title" v-model="editForm.title" class="nb-input" :placeholder="t('notebook.titlePh')" />
                      <textarea
                        v-model="editForm.detail"
                        class="nb-input nb-textarea"
                        rows="3"
                        :placeholder="t('notebook.detailPh')"
                        @paste="onEditPaste"
                        @drop.prevent="onEditDrop"
                        @dragover.prevent
                      ></textarea>
                      <!-- ★ 1011：图片标签行（形态同输入框：圆形缩略图 + 名称 + 删） -->
                      <div class="nb-imgs" @drop.prevent="onEditDrop" @dragover.prevent>
                        <span
                          v-for="im in editForm.images"
                          :key="im.ref"
                          class="nb-img-chip is-edit"
                          :title="t('notebook.viewImage')"
                          @mouseenter="showImgHover(im.ref, $event)"
                          @mouseleave="hideImgHover"
                          @click.stop="openViewer(im.ref)"
                        >
                          <img class="nb-img-thumb" :src="notebookImageUrl(im.ref)" :alt="im.name" />
                          <span class="nb-img-name">{{ im.name }}</span>
                          <button class="nb-img-del" :title="t('notebook.removeImage')" @click.stop="removeEditImage(im.ref)">
                            <i class="fas fa-times text-[6px]"></i>
                          </button>
                        </span>
                        <button
                          class="nb-img-add"
                          :disabled="imgBusy || editForm.images.length >= MAX_IMAGES"
                          :title="t('notebook.addImageHint')"
                          @click.stop="pickImages"
                        >
                          <i :class="['text-[9px]', imgBusy ? 'fas fa-spinner fa-spin' : 'fas fa-image']"></i>{{ t('notebook.addImage') }}
                        </button>
                      </div>
                      <p v-if="imgErr" class="nb-img-err">{{ imgErr }}</p>
                      <input ref="imgInputRef" type="file" accept="image/*" multiple class="hidden" @change="onPickImages" />
                      <div class="flex items-center gap-2 justify-end">
                        <button class="btn btn-secondary btn-sm" @click="editingId = ''">{{ t('notebook.cancel') }}</button>
                        <button class="btn btn-primary btn-sm" :disabled="!editForm.title.trim() || busy" @click="saveEdit(item)">{{ t('notebook.save') }}</button>
                      </div>
                    </template>
                    <template v-else>
                      <div class="nb-detail-label">{{ t('notebook.detail') }}</div>
                      <div v-if="item.detail" class="nb-detail-text">{{ item.detail }}</div>
                      <div v-else class="nb-detail-text is-empty">{{ t('notebook.noDetail') }}</div>
                      <!-- ★ 1011：图片标签行（悬停预览 + 点开大图） -->
                      <div v-if="(item.images || []).length" class="nb-imgs">
                        <button
                          v-for="im in item.images"
                          :key="im.ref"
                          class="nb-img-chip"
                          :title="t('notebook.viewImage')"
                          @mouseenter="showImgHover(im.ref, $event)"
                          @mouseleave="hideImgHover"
                          @click.stop="openViewer(im.ref)"
                        >
                          <img class="nb-img-thumb" :src="notebookImageUrl(im.ref)" :alt="im.name" />
                          <span class="nb-img-name">{{ im.name }}</span>
                        </button>
                      </div>
                      <div class="nb-detail-foot">
                        <span class="text-[10px] text-gray-400">
                          {{ t('notebook.updatedAt', { t: fmtTime(item.updatedAt) }) }}
                        </span>
                        <span class="flex-1"></span>
                        <button class="btn btn-secondary btn-sm" @click="injectToChat(item)" :title="t('notebook.injectHint')">
                          <i class="fas fa-share text-[9px] mr-1"></i>{{ t('notebook.inject') }}
                        </button>
                        <button class="btn btn-secondary btn-sm" @click="startEdit(item)">
                          <i class="fas fa-pen text-[9px] mr-1"></i>{{ t('notebook.edit') }}
                        </button>
                      </div>
                    </template>
                  </div>
                </Transition>

                <!-- 删除确认：贴在行内，不弹二级弹窗 -->
                <Transition name="nb-slide">
                  <div v-if="confirmId === item.id" class="nb-confirm">
                    <i class="fas fa-triangle-exclamation text-[10px] text-red-500"></i>
                    <span class="text-[11px] text-gray-600 flex-1">{{ t('notebook.deleteConfirm') }}</span>
                    <button class="btn btn-danger btn-sm" :disabled="busy" @click.stop="removeItem(item)">{{ t('notebook.deleteYes') }}</button>
                    <button class="btn btn-secondary btn-sm" @click.stop="confirmId = ''">{{ t('notebook.cancel') }}</button>
                  </div>
                </Transition>
              </div>
            </div>
          </div>
        </div>
      </div>
    </Transition>
    <!-- ★ 1011：便签图片全屏查看（同一套 ImageViewer） -->
    <ImageViewer :src="viewingImg" @close="viewingImg = null" />
    <!-- ★1011b：图片悬停预览。fixed + Teleport 到 body —— 面板的 .nb-body 是滚动容器，
         绝对定位的浮层会被裁掉；图片同一个 URL，走浏览器缓存，零额外请求。 -->
    <Teleport to="body">
      <div
        v-if="hoverImg"
        class="pointer-events-none fixed z-[9998] overflow-hidden rounded-xl bg-white shadow-2xl"
        :style="{ left: hoverImg.x + 'px', top: hoverImg.y + 'px', transform: 'translate(-50%, calc(-100% - 10px))' }"
      >
        <img :src="hoverImg.src" alt="" class="block max-h-[320px] max-w-[320px]" />
      </div>
    </Teleport>
  </Teleport>
</template>

<style scoped>
/* 进出场（铁律：新弹窗必须带进出场；只动 opacity/transform） */
.nb-fade-enter-active { transition: opacity 0.2s ease; }
.nb-fade-leave-active { transition: opacity 0.16s ease; }
.nb-fade-enter-from, .nb-fade-leave-to { opacity: 0; }
/* 面板：带一点回弹（0.34,1.35,…）——"弹出来"的手感 */
.nb-pop-enter-active { transition: opacity 0.22s ease, transform 0.3s cubic-bezier(0.34, 1.35, 0.64, 1); }
.nb-pop-leave-active { transition: opacity 0.16s ease, transform 0.16s ease; }
.nb-pop-enter-from, .nb-pop-leave-to { opacity: 0; transform: translateY(14px) scale(0.96); }
.nb-drop-enter-active { transition: opacity 0.14s ease, transform 0.14s ease; }
.nb-drop-leave-active { transition: opacity 0.1s ease; }
.nb-drop-enter-from, .nb-drop-leave-to { opacity: 0; transform: translateY(-4px); }
/* 详情 / 新增表单：下滑进入 */
.nb-detail-enter-active, .nb-slide-enter-active { transition: opacity 0.2s ease, transform 0.24s cubic-bezier(0.16, 1, 0.3, 1); }
.nb-detail-leave-active, .nb-slide-leave-active { transition: opacity 0.12s ease, transform 0.12s ease; }
.nb-detail-enter-from, .nb-detail-leave-to { opacity: 0; transform: translateY(-6px); }
.nb-slide-enter-from, .nb-slide-leave-to { opacity: 0; transform: translateY(-8px); }
/* 打勾标识出现时弹一下 */
.nb-check-enter-active { transition: opacity 0.18s ease, transform 0.24s cubic-bezier(0.34, 1.6, 0.64, 1); }
.nb-check-enter-from { opacity: 0; transform: scale(0.4); }

/* 条目错峰入场 */
@keyframes nbRowIn {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}
.nb-row { animation: nbRowIn 0.28s cubic-bezier(0.16, 1, 0.3, 1) both; }
/* 删除：淡出 + 右移，再落数据 */
.nb-row.is-removing {
  animation: none;
  opacity: 0 !important;
  transform: translateX(18px) scale(0.98);
  transition: opacity 0.18s ease, transform 0.18s ease;
  pointer-events: none;
}
/* 改状态：底色闪一下（"改成功了"看得见） */
@keyframes nbChanged {
  0% { background: rgba(99, 102, 241, 0.14); transform: scale(1.008); }
  100% { background: transparent; transform: scale(1); }
}
.nb-row.is-changed { animation: nbChanged 0.5s ease both; }

.nb-panel {
  width: 620px; max-width: 94vw; height: 78vh; max-height: 78vh;
  display: flex; flex-direction: column;
  background: #fff; border: 1.5px solid #e7e7ea; border-radius: 20px;
  box-shadow: 0 26px 70px -22px rgba(0, 0, 0, 0.34);
  overflow: hidden;
}
.nb-head {
  display: flex; align-items: center; justify-content: space-between; gap: 10px;
  padding: 14px 18px 12px; border-bottom: 1px solid #f1f1f4; flex: none;
}
.nb-head-icon {
  width: 26px; height: 26px; border-radius: 8px; flex: none;
  display: inline-flex; align-items: center; justify-content: center;
  background: #fff7ed; color: #f59e0b;
}
.nb-close {
  width: 26px; height: 26px; border-radius: 50%; border: none; cursor: pointer;
  background: #f3f4f6; color: #9ca3af;
  display: inline-flex; align-items: center; justify-content: center;
}
.nb-close:hover { background: #e5e7eb; color: #4b5563; }

.nb-toolbar {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  padding: 10px 18px 0; flex: none;
}
.nb-chips { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; }
.nb-chip {
  display: inline-flex; align-items: center;
  font-size: 11px; padding: 4px 9px; border-radius: 999px;
  border: 1px solid #e5e7eb; background: #fff; color: #6b7280; cursor: pointer;
  transition: background 0.14s ease, color 0.14s ease, border-color 0.14s ease, transform 0.14s ease;
}
.nb-chip:hover { border-color: #d1d5db; color: #111827; }
.nb-chip:active { transform: scale(0.96); }
.nb-chip.is-on { background: #111827; border-color: #111827; color: #fff; font-weight: 640; }
.nb-chip.is-on .nb-chip-n { color: rgba(255, 255, 255, 0.7); }
.nb-chip-n { margin-left: 4px; font-size: 10px; color: #9ca3af; }
.nb-search {
  display: flex; align-items: center; gap: 6px; margin-left: auto;
  border: 1px solid #e5e7eb; border-radius: 999px; padding: 4px 10px; min-width: 168px;
  background: #fff;
}
.nb-search:focus-within { border-color: #9ca3af; }
.nb-search-input { flex: 1; min-width: 0; border: none; outline: none; font-size: 11px; background: transparent; color: #111827; }
.nb-search-clear { border: none; background: transparent; color: #9ca3af; cursor: pointer; padding: 0; }
.nb-hint { padding: 8px 18px 0; font-size: 10px; color: #9ca3af; line-height: 1.6; flex: none; }
.nb-error { margin: 8px 18px 0; font-size: 11px; color: #dc2626; background: #fef2f2; border: 1px solid #fecaca; border-radius: 9px; padding: 7px 10px; flex: none; }

.nb-body { flex: 1; min-height: 0; overflow-y: auto; padding: 10px 18px 16px; }
.nb-list { display: flex; flex-direction: column; gap: 7px; }

.nb-row {
  border: 1px solid #ececef; border-radius: 13px; padding: 9px 11px;
  background: #fff; transition: border-color 0.15s ease, box-shadow 0.15s ease;
}
.nb-row:hover { border-color: #dcdce1; }
.nb-row.is-open { border-color: #c7c9d1; box-shadow: 0 8px 22px -14px rgba(0, 0, 0, 0.24); }
.nb-row.is-closed { background: #fbfbfc; }
/* ★ 0921：正在显示状态下拉的那一行**整体提层** —— 下拉自己的 z-index 只在行内有效，
   不把整行提上来就会被后面那些行（入场动画的 transform 各自造了层叠上下文）盖住。 */
.nb-row.is-menu-open { position: relative; z-index: 30; }

.nb-title { flex: 1 1 auto; font-size: 12.5px; font-weight: 550; color: #111827; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nb-title.is-struck { text-decoration: line-through; color: #9ca3af; }
.nb-src {
  flex: none; font-size: 9px; padding: 1px 5px; border-radius: 999px;
  background: #f3f4f6; border: 1px solid #e5e7eb; color: #9ca3af;
}
.nb-src.is-ai { background: #eef2ff; border-color: #dbe1ff; color: #4f46e5; }

.nb-status-wrap { display: inline-flex; }
.nb-status-btn {
  display: inline-flex; align-items: center; justify-content: center;
  min-width: 24px; height: 24px; padding: 0 5px; border-radius: 8px;
  border: 1px solid #e5e7eb; background: #fff; color: #9ca3af; cursor: pointer;
  transition: all 0.14s ease;
}
.nb-status-btn:hover { border-color: #d1d5db; }
.nb-status-btn:active { transform: scale(0.9); }
.nb-status-btn.is-todo { color: #6b7280; }
.nb-status-btn.is-hold { color: #d97706; border-color: #fde68a; background: #fffbeb; }
/* ★ 0923：待拍板（靛蓝）/ 待测（天蓝） */
.nb-status-btn.is-pending { color: #4f46e5; border-color: #c7d2fe; background: #eef2ff; }
.nb-status-btn.is-testing { color: #0284c7; border-color: #bae6fd; background: #f0f9ff; }
.nb-status-btn.is-done { color: #059669; border-color: #a7f3d0; background: #ecfdf5; }
.nb-status-btn.is-cancelled { color: #9ca3af; border-color: #e5e7eb; background: #f9fafb; }

.nb-status-menu {
  position: absolute; left: 0; top: calc(100% + 5px); z-index: 20;
  width: 132px; padding: 4px;
  background: #fff; border: 1px solid #e5e7eb; border-radius: 11px;
  box-shadow: 0 16px 40px -16px rgba(0, 0, 0, 0.3);
  display: flex; flex-direction: column; gap: 1px;
}
.nb-status-item {
  display: flex; align-items: center; gap: 0;
  width: 100%; padding: 6px 8px; border: none; border-radius: 8px;
  background: transparent; color: #4b5563; font-size: 11.5px; cursor: pointer; text-align: left;
  transition: background 0.12s ease;
}
.nb-status-item:hover { background: #f5f6f8; }
.nb-status-item.is-on { background: #f2f2f6; font-weight: 640; }
.nb-status-item:active { transform: scale(0.98); }
.nb-status-item.is-hold i { color: #d97706; }
.nb-status-item.is-pending i { color: #4f46e5; }
.nb-status-item.is-testing i { color: #0284c7; }
.nb-status-item.is-done i { color: #059669; }
.nb-status-item.is-cancelled i { color: #9ca3af; }

.nb-detail {
  margin-top: 9px; padding-top: 9px; border-top: 1px dashed #ececef;
  display: flex; flex-direction: column; gap: 7px;
}
.nb-detail-label { font-size: 10px; color: #9ca3af; }
.nb-detail-text {
  font-size: 12px; color: #374151; line-height: 1.65;
  white-space: pre-wrap; word-break: break-word;
  max-height: 210px; overflow-y: auto;
}
.nb-detail-text.is-empty { color: #c4c7ce; }
.nb-detail-foot { display: flex; align-items: center; gap: 6px; }

/* ★ 1011：详情里的图片标签（形态同输入框图片标签：圆角胶囊 + 圆形缩略图 + 名字） */
.nb-imgs { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; }
.nb-img-chip {
  display: inline-flex; align-items: center; gap: 4px; max-width: 190px;
  padding: 1px 8px 1px 2px; border-radius: 999px; cursor: pointer;
  border: 1px solid #e5e7eb; background: #fff; color: #374151; font-size: 11px;
  transition: border-color 0.14s ease, background 0.14s ease, transform 0.14s ease;
}
.nb-img-chip:hover { border-color: #d1d5db; background: #fafafa; }
.nb-img-chip:active { transform: scale(0.97); }
.nb-img-thumb { width: 16px; height: 16px; border-radius: 50%; object-fit: cover; flex: none; background: #f3f4f6; }
.nb-img-name { max-width: 118px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nb-img-del {
  width: 14px; height: 14px; margin-left: 1px; flex: none; border: none; border-radius: 50%; cursor: pointer;
  display: inline-flex; align-items: center; justify-content: center;
  background: #f3f4f6; color: #9ca3af;
}
.nb-img-del:hover { background: #fee2e2; color: #dc2626; }
.nb-img-add {
  display: inline-flex; align-items: center; gap: 3px; font-size: 11px; cursor: pointer;
  padding: 2px 9px; border-radius: 999px; border: 1px dashed #d1d5db; background: transparent; color: #6b7280;
  transition: border-color 0.14s ease, color 0.14s ease;
}
.nb-img-add:hover:not(:disabled) { border-color: #9ca3af; color: #111827; }
.nb-img-add:disabled { opacity: 0.5; cursor: default; }
.nb-img-err { font-size: 10px; color: #dc2626; }

.nb-quick-status { display: flex; gap: 5px; flex-wrap: wrap; }
.nb-mini-status {
  font-size: 10px; padding: 3px 8px; border-radius: 999px; cursor: pointer;
  border: 1px solid #e5e7eb; background: #fff; color: #6b7280;
  transition: all 0.14s ease;
}
.nb-mini-status:hover { border-color: #d1d5db; }
.nb-mini-status:active { transform: scale(0.94); }
.nb-mini-status.is-on { background: #111827; border-color: #111827; color: #fff; font-weight: 640; }

.nb-composer {
  display: flex; flex-direction: column; gap: 8px;
  border: 1px solid #dcdce1; border-radius: 13px; padding: 11px;
  background: #fafafa; margin-bottom: 9px;
}
.nb-confirm {
  display: flex; align-items: center; gap: 7px; margin-top: 9px;
  padding: 7px 9px; border-radius: 10px;
  background: #fef2f2; border: 1px solid #fecaca;
}

.nb-input {
  width: 100%; font-size: 12px; color: #111827;
  background: #fff; border: 1px solid #e5e7eb; border-radius: 9px;
  padding: 7px 10px; outline: none; transition: border-color 0.14s ease;
}
.nb-input:focus { border-color: #9ca3af; }
.nb-textarea { resize: vertical; min-height: 52px; font-family: inherit; line-height: 1.55; }

.nb-icon-btn {
  width: 24px; height: 24px; border-radius: 7px; cursor: pointer;
  display: inline-flex; align-items: center; justify-content: center;
  border: 1px solid #e5e7eb; background: #fff; color: #9ca3af;
  transition: all 0.14s ease;
}
.nb-icon-btn.is-danger:hover { background: #fef2f2; color: #dc2626; border-color: #fecaca; }
.nb-icon-btn:active { transform: scale(0.9); }

/* ★1011c：原来这里自造了 nb-btn-primary / nb-btn-plain / nb-btn-danger 三套按钮
   （药丸 + 9px 方圆混搭、字重 640），跟全局 .btn 体系（style.css 151 起：药丸 + btn-sm
   + btn-primary/secondary/danger，含 html.dark 覆盖）两套并存 —— 用户看图指出
   「取消/保存风格不一、便签里的按钮也不统一」。现在便签按钮一律复用全局类，本地不再维护。 */

.nb-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 54px 0; }

/* 深色模式 */
html.dark .nb-panel { background: #1b1b1f; border-color: #2e2e36; }
html.dark .nb-head { border-bottom-color: #2b2b33; }
html.dark .nb-head h2 { color: #e9e9ef; }
html.dark .nb-head-icon { background: #2b2314; color: #fbbf24; }
html.dark .nb-close { background: #26262d; color: #8c8c96; }
html.dark .nb-close:hover { background: #2e2e36; color: #e9e9ef; }
html.dark .nb-chip { background: #202027; border-color: #34343e; color: #9a9aa4; }
html.dark .nb-chip:hover { border-color: #4a4a56; color: #e9e9ef; }
html.dark .nb-chip.is-on { background: #f2f2f6; border-color: #f2f2f6; color: #1b1b1f; }
html.dark .nb-search { background: #202027; border-color: #34343e; }
html.dark .nb-search-input { color: #e9e9ef; }
html.dark .nb-hint { color: #7c7c86; }
html.dark .nb-row { background: #202027; border-color: #2b2b33; }
html.dark .nb-row:hover { border-color: #383842; }
html.dark .nb-row.is-open { border-color: #4a4a56; }
html.dark .nb-row.is-closed { background: #1c1c21; }
html.dark .nb-title { color: #e9e9ef; }
html.dark .nb-title.is-struck { color: #7c7c86; }
html.dark .nb-src { background: #26262d; border-color: #34343e; color: #8c8c96; }
html.dark .nb-src.is-ai { background: #2a2a3d; border-color: #3f3f5a; color: #a5b4fc; }
html.dark .nb-status-btn { background: #202027; border-color: #34343e; }
html.dark .nb-status-btn.is-hold { background: #2b2314; border-color: #5a4520; color: #fcd34d; }
html.dark .nb-status-btn.is-done { background: #16302a; border-color: #1f4d3f; color: #34d399; }
html.dark .nb-status-btn.is-cancelled { background: #232329; border-color: #34343e; color: #8c8c96; }
html.dark .nb-status-menu { background: #202027; border-color: #34343e; box-shadow: 0 16px 40px -16px rgba(0, 0, 0, 0.6); }
html.dark .nb-status-item { color: #c9c9d3; }
html.dark .nb-status-item:hover { background: #26262d; }
html.dark .nb-status-item.is-on { background: #2e2e36; }
html.dark .nb-detail { border-top-color: #2e2e36; }
html.dark .nb-detail-text { color: #c9c9d3; }
html.dark .nb-detail-text.is-empty { color: #6b6b76; }
/* ★ 1011：深色下的图片标签 */
html.dark .nb-img-chip { background: #202027; border-color: #34343e; color: #c9c9d3; }
html.dark .nb-img-chip:hover { background: #26262d; border-color: #4a4a56; }
html.dark .nb-img-thumb { background: #2e2e36; }
html.dark .nb-img-del { background: #2e2e36; color: #8c8c96; }
html.dark .nb-img-del:hover { background: #4a2626; color: #f87171; }
html.dark .nb-img-add { border-color: #3c3c46; color: #9a9aa4; }
html.dark .nb-img-add:hover:not(:disabled) { border-color: #5a5a66; color: #e9e9ef; }
html.dark .nb-img-err { color: #f87171; }
html.dark .nb-composer { background: #1c1c21; border-color: #34343e; }
html.dark .nb-input { background: #202027; border-color: #34343e; color: #e9e9ef; }
html.dark .nb-mini-status { background: #202027; border-color: #34343e; color: #9a9aa4; }
html.dark .nb-mini-status.is-on { background: #f2f2f6; border-color: #f2f2f6; color: #1b1b1f; }
html.dark .nb-icon-btn { background: #202027; border-color: #34343e; color: #8c8c96; }
/* ★1011c：便签按钮改走全局 .btn 后，深色主题由 style.css 的 html.dark .btn-* 统一接管 */
html.dark .nb-confirm { background: #2b1a1a; border-color: #5a2a2a; }
html.dark .nb-confirm .text-gray-600 { color: #e0c4c4; }
html.dark .nb-row.is-changed { animation-name: nbChangedDark; }
@keyframes nbChangedDark {
  0% { background: rgba(129, 140, 248, 0.18); transform: scale(1.008); }
  100% { background: #202027; transform: scale(1); }
}
</style>
