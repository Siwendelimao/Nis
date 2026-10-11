<script setup lang="ts">
import { ref, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { useChatStore } from '@/stores/chat'
import { useSettingsStore } from '@/stores/settings'
import { matchesShortcut } from '@/utils/shortcuts'
import { formatElementTagToken } from '@/utils/elementTag'
import ImageViewer from './blocks/ImageViewer.vue'
import { t } from '@/utils/i18n'
import { localStore, onHydrated } from '@/utils/localStore'   // T3-0928: draft persistence
import { swallowed } from '@/utils/swallowed'

const chatStore = useChatStore()
const settingsStore = useSettingsStore()

const emit = defineEmits<{
  tagClick: [metadata: any]
  /** 发送。channel='ctrl'=Ctrl+Enter（0909⑦ 反向通道：默认插话时=排队，反之=插话） */
  send: [channel?: 'ctrl']
  attach: [files: File[]]
  /** 0909⑦改：草稿有无（忙时发送钮态：有草稿=发送(排队/插话)，无草稿=停止） */
  draft: [has: boolean]
}>()

const props = withDefaults(defineProps<{
  disabled?: boolean
  /** ★1004r：草稿归属会话（与所在窗口/面板的会话同源；空=新对话草稿）。
   *  原来读全局 activeConversationId —— 全局单值与实际显示会话可不同源（ModelSelector 同款坑），
   *  草稿会存错桶（刷新后"消失"、却从新对话里冒出来）。 */
  convId?: string
}>(), {
  disabled: false,
  convId: '',
})

const editorRef = ref<HTMLDivElement | null>(null)
const pendingBackspaceTag = ref<string | null>(null)
let savedRange: Range | null = null

/* ── 光标位置追踪 ── */
function saveCursorPosition() {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0 || !editorRef.value) return
  const range = sel.getRangeAt(0)
  if (editorRef.value.contains(range.commonAncestorContainer)) {
    savedRange = range.cloneRange()
  }
}

/* ── 标签插入（光标位置） ── */
watch(() => chatStore.pendingInsert, () => {
  // 0914：原子消费（先取走再插）——主输入框与悬浮聊天窗两个实例并存时不双插
  const p = chatStore.consumeInsert()
  if (p) insertTagAtCursor(p.metadata, p.content)
})

/* ★ 0921s（反馈："输入框 Ctrl+Z 撤回没了"）：
   输入框是**受控的自定义编辑区** —— 输入会重写内部 DOM、插入/删除标签也用程序化 DOM 操作，
   浏览器原生撤销栈因此被打断（按 Ctrl+Z 没反应）。这里自建一份轻量撤销栈：
   · 用户输入节流 350ms 存一份 innerHTML 快照；插入标签也立即存一份；
   · Ctrl+Z 弹回上一份快照，然后重新绑定标签事件、同步 store 顺序、把光标放回末尾；
   · 上限 100 步，只在内存里（不进持久化）。
   注：快照只存 DOM 的 HTML；标签的元数据在 chatStore 里（随 syncStoreOrder 对齐）。 */
let undoStack: string[] = []
let undoTimer: ReturnType<typeof setTimeout> | null = null
function snapshotNow() {
  const el = editorRef.value
  if (!el) return
  const html = el.innerHTML
  if (undoStack[undoStack.length - 1] === html) return
  undoStack.push(html)
  if (undoStack.length > 100) undoStack.shift()
}
function onEditorInput() {
  if (undoTimer) clearTimeout(undoTimer)
  undoTimer = setTimeout(() => { snapshotNow(); undoTimer = null }, 350)
}
function undoOnce(): boolean {
  const el = editorRef.value
  if (!el || undoStack.length === 0) return false
  const html = undoStack.pop() as string
  if (html === el.innerHTML) return undoOnce()
  el.innerHTML = html
  attachTagEvents()
  syncStoreOrder()
  try {
    const r = document.createRange()
    r.selectNodeContents(el)
    r.collapse(false)
    const sel = window.getSelection()
    if (sel) { sel.removeAllRanges(); sel.addRange(r) }
    savedRange = r.cloneRange()
  } catch { /* ignore */ }
  return true
}

function insertTagAtCursor(metadata: any, content: string) {
  if (!editorRef.value) return
  const isFile = metadata?.tagType === 'file'
  /* ★ 0923：便签标签（便签面板「置入对话」用）——琥珀色，一眼区别于文件/图片/元素 */
  const isNote = metadata?.tagType === 'note'
  let inner: string
  if (isFile) {
    // 文件标签：图标占位与图片缩略图同为 16px 圆形（胶囊内圆头更整）；配色 teal 与图片区分
    inner = `<span class="w-3.5 h-3.5 flex items-center justify-center flex-shrink-0 rounded-full bg-white/25"><i class="fas fa-file-lines text-[7px] text-white/85"></i></span><span class="max-w-[80px] truncate">${content}</span>`
  } else if (metadata?.tagType === 'image') {
    const thumb = metadata.dataUrl
      ? `<img src="${metadata.dataUrl}" style="width:14px;height:14px;border-radius:50%;object-fit:cover;flex-shrink:0;" />`
      : `<span class="w-3.5 h-3.5 flex items-center justify-center flex-shrink-0 rounded-full bg-white/10"><i class="fas fa-image text-[7px] text-gray-300"></i></span>`
    inner = `${thumb}<span class="max-w-[80px] truncate">${content}</span>`
  } else {
    const icon = metadata?.tagType === 'element' ? 'fa-mouse-pointer' : metadata?.tagType === 'box' ? 'far fa-square' : metadata?.tagType === 'note' ? 'fa-note-sticky' : 'fa-pen'
    // 0914：元素标签显示「短标签」（置入时 content 已是 ~20 字符）；truncate 兜底防极端超长
    inner = `<i class="fas ${icon} text-[8px] text-gray-300"></i><span class="max-w-[140px] truncate">${content}</span>`
  }
  const tagId = 'tag-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6)
  const previewAttr = metadata?.tagType === 'image' && metadata.dataUrl
    ? ` data-preview="${metadata.dataUrl}"`
    : ''
  // 文件标签额外携带 data-file-ref（发送时转 [引用文件：路径]），配色 teal 与图片区分
  const fileAttr = isFile ? ` data-file-ref="${(metadata.relPath || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}"` : ''
  const shell = isFile
    ? 'bg-teal-700 text-white hover:bg-teal-600'
    : isNote
      ? 'bg-amber-500 text-white hover:bg-amber-400'
      : 'bg-gray-800 text-white hover:bg-gray-700'
  const delHover = isFile ? 'hover:bg-teal-500' : isNote ? 'hover:bg-amber-400' : 'hover:bg-gray-600'
  // 对齐修正：scoped .tag-inline 命中不了 insertHtmlAtCursor 注入的裸 DOM（无 data-v 属性），
  // 所以把垂直对齐写成 tailwind 工具类：self-center 治 flex 行拉伸，align-middle 治 inline 流基线错位
  const tagHtml = `<span class="inline-flex items-center gap-0.5 pl-1 pr-0.5 py-px rounded-full text-[11px] font-[530] self-center align-middle ${shell} cursor-pointer select-none tag-inline" data-tag-id="${tagId}" contenteditable="false" draggable="false"${previewAttr}${fileAttr}>${inner}<button class="ml-0.5 w-3.5 h-3.5 flex items-center justify-center rounded-full ${delHover} tag-delete-btn" data-tag-id="${tagId}"><i class="fas fa-times text-[6px]"></i></button></span> `
  /* ★ 0921r（反馈）：标签两侧各塞一个**零宽空格**（U+200B）——
     否则标签排在行首时，浏览器找不到可放置光标的文本位置（点它左边、按左方向键都落不到位）。
     零宽字符不可见、可放光标；发送取文本和复制载荷里都会 strip 掉（见下）。 */
  const ZW = '\u200B'
  insertHtmlAtCursor(ZW + tagHtml + ZW)
  chatStore.addTag({ content, metadata }, tagId)
  setTimeout(() => snapshotNow(), 0)   // ★ 0921s：插入标签也进撤销栈
}

/** ★ 0921r：删除标签时顺手清掉它两侧的零宽锚点（只清"纯零宽"的文本节点，不碰正常文字） */
function removeTagWithAnchors(el: HTMLElement) {
  const isPureZW = (n: Node | null) => !!n && n.nodeType === Node.TEXT_NODE && String(n.textContent || '').includes('\u200B') && !String(n.textContent || '').replace(/\u200B/g, '')
  const prev = el.previousSibling
  const next = el.nextSibling
  el.remove()
  if (isPureZW(prev)) (prev as ChildNode).remove()
  if (isPureZW(next)) (next as ChildNode).remove()
}

/* ── 文件拖入（★1011v：热区从"编辑器那一小块"放大到**整个输入区**，见模板里挂在容器上的事件） ── */
const fileDragOver = ref(false)
let _dragDepth = 0

function _hasFiles(e: DragEvent): boolean {
  const types = e.dataTransfer?.types
  return !!types && Array.from(types).includes('Files')
}

function handleFileDragOver(e: DragEvent) {
  if (_hasFiles(e)) {
    e.preventDefault()
    e.stopPropagation()
    fileDragOver.value = true
  }
}

/** ★1011v：dragenter/dragleave 用**深度计数** —— 事件挂到整个输入区后，鼠标划过内部子元素
 *  （工具栏按钮、附件条）会连续触发 leave/enter，直接置 false 会让高亮边框疯狂闪烁。 */
function handleFileDragEnter(e: DragEvent) {
  if (!_hasFiles(e)) return
  e.preventDefault()
  _dragDepth += 1
  fileDragOver.value = true
}

function handleFileDragLeave() {
  _dragDepth = Math.max(0, _dragDepth - 1)
  if (_dragDepth === 0) fileDragOver.value = false
}

function handleFileDrop(e: DragEvent) {
  e.preventDefault()
  e.stopPropagation()
  fileDragOver.value = false
  _dragDepth = 0
  const files = e.dataTransfer?.files
  if (!files || files.length === 0) return
  const nonImages: File[] = []
  for (const file of Array.from(files)) {
    if (file.type.startsWith('image/')) {
      readImageFile(file)
    } else {
      nonImages.push(file)
    }
  }
  // #2 非图片文件拖入 → 作为附件交给父组件（★1011v 起父组件**真的接住了**这个 emit：见 onAttachFiles）
  if (nonImages.length) emit('attach', nonImages)
}

/* ── 粘贴 ── */
/** ★ 0921：把"从本编辑器复制出去的 HTML"按**标签结构**还原回来。
 *  背景：编辑器状态是「HTML + contentItems 登记表」两部分（见 getEditorState/setEditorState），
 *  所以粘贴不能只塞 innerHTML —— 标签必须走各自的 insert* 函数重建，**登记表才会同步**
 *  （否则标签"看着在"，但点 × 删不掉、发送时的 token 转换也失效）。
 *  返回 true = 已按结构化路径处理；false = 调用方退回纯文本。 */
function pasteStructuredHtml(html: string): boolean {
  /* ★ 0921e：把「含外部 data: 图片」的 HTML 也纳入结构化路径 —— 以前只认自家标记，
     于是从网页/文档复制"文本+图片"时那个 <img> 被整段忽略 ⇒ 粘进来只剩文字。 */
  /* ★ 0921l：入口守卫再放开一道 —— 含**外部图片**（http(s) / file:// / 盘符）的 HTML 也要走结构化路径，
     否则 QQ 这种 `<img src="file:///...">` 会在门口被挡回去 ⇒ 走纯文本路径 ⇒ 图被异步追加到末尾（实测）。 */
  const hasOurMark = /data-skill-tag|data-file-ref|data-preview/.test(html)
  const hasExternalImg = /<img[^>]+src=["'](https?:|file:|[a-zA-Z]:)/i.test(html)
  if (!html || (!hasOurMark && !hasExternalImg)) return false
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html')
    const root = doc.body
    if (!root) return false
    if (!root.querySelector('[data-skill-tag],[data-file-ref],[data-preview],img[src^="data:image/"],img[src^="http"],img[src^="file:"]')) return false
    let buf = ''
    const flush = () => { if (buf) { insertText(buf); buf = '' } }
    const isBlock = (t: string) => /^(DIV|P|LI|TR|H[1-6]|BLOCKQUOTE|PRE|OL|UL)$/.test(t)
    const walk = (node: Node): void => {
      if (node.nodeType === Node.TEXT_NODE) { buf += node.textContent || ''; return }
      if (node.nodeType !== Node.ELEMENT_NODE) return
      const el = node as HTMLElement
      const skill = el.getAttribute('data-skill-tag')
      if (skill) { flush(); insertSkillTag(skill); return }
      const fref = el.getAttribute('data-file-ref')
      if (fref) { flush(); insertFileRef(fref, (el.textContent || '').trim() || undefined); return }
      /* ★ 0921e：外部 HTML 里内嵌的 data: 图片（从网页/文档复制"文本+图片"）——
         以前这种 <img> 被直接忽略 ⇒ 只剩文字。现在把 data: URL 的图接成图片标签。 */
      if (el.tagName === 'IMG') {
        const srcAttr = el.getAttribute('src') || ''
        if (/^data:image\//.test(srcAttr)) {
          flush()
          const mime = (srcAttr.slice(5, srcAttr.indexOf(';')) || 'image/png')
          insertImageTag((el.getAttribute('alt') || 'image').trim() || 'image', 0, srcAttr, mime)
          return
        }
        /* ★ 0921k：外链图片（QQ/网页那种）—— 先插一个**占位符**，等后端把图下载完
           再在原位替换成图片标签；否则异步插入会让图片全跑到文本末尾（实测）。 */
        if (/^(https?:\/\/|file:\/\/)/i.test(srcAttr) || /^[a-zA-Z]:[\\/]/.test(srcAttr)) {
          flush()
          insertHtmlAtCursor(`<span data-nis-imgslot="${encodeURIComponent(srcAttr)}"></span>`)
          return
        }
      }
      const img = el.getAttribute('data-preview')
      if (img) {
        flush()
        /* ★ 0921：图片标签里的 `data-preview` 是完整 base64，**经剪贴板转一手可能被截断** ——
           截断的 dataUrl 插进去就是一张坏图（实测："粘回来图片标签会丢"）。
           这里做基本完整性校验：合格的照原样插；不合格的**仍然插标签**（只是不带缩略图），
           保证"标签结构不丢"，用户至少还能看到它在那儿、能删能发。 */
        const ok = img.startsWith('data:image/') && img.length > 64
        insertImageTag((el.textContent || 'image').trim(), 0, ok ? img : '', 'image/png')
        return
      }
      // 块级元素之间补换行，避免多段文字黏成一行（"序号自动换行"那类观感问题）
      const blk = isBlock(el.tagName)
      if (blk && buf && !buf.endsWith('\n')) buf += '\n'
      for (const c of Array.from(el.childNodes)) walk(c)
      if (blk && buf && !buf.endsWith('\n')) buf += '\n'
    }
    for (const c of Array.from(root.childNodes)) walk(c)
    flush()
    return true
  } catch {
    return false
  }
}

/* ★ 0921d 剪贴板（设计口径：标签**只在 NIS 内**能复制粘贴；复制到外部应用时标签位置为空）────────
 * 背景：编辑器状态是「HTML + chatStore.contentItems 登记表」两部分，而标签 span 里内嵌的是整段
 *  base64 缩略图（可能几百 KB）。复制走浏览器默认序列化时，这份 HTML 会被截断/丢弃 ⇒ 粘回来只剩
 *  纯文本 = 丢标签（实测两种情形：① 输入框内"标签+文本"复制回来；② 从别处"图片+文本"粘进来）。
 * 做法：copy 时自己往剪贴板写三份：
 *   · application/x-nis-clip —— 结构化 JSON 载荷（NIS 自己粘贴时**精确重建**顺序与标签）
 *   · text/html —— 结构化正文 + 隐藏的载荷（base64），正文里**不含**任何 base64 缩略图
 *   · text/plain —— 纯文本，**标签位置为空**（外部应用粘到的就是它）
 * 粘贴时：优先吃载荷（x-nis-clip → text/html 里的隐藏块）→ 没有才回退现有 HTML/纯文本路径。
 * 选区里没有标签时**完全不干预**（交回浏览器默认，普通复制粘贴体验不变）。
 * 说明：只接管 copy，不接管 cut（剪切=复制+删除，交回浏览器默认，避免破坏既有行为）。
 * ─────────────────────────────────────────────────────────────── */
type ClipNode =
  | { t: 'text'; s: string }
  | { t: 'br' }
  | { t: 'tag'; kind: 'skill'; name: string }
  | { t: 'tag'; kind: 'file'; relPath: string; label?: string }
  | { t: 'tag'; kind: 'image'; name: string; dataUrl: string; size?: number; mime?: string }

function encodeClip(json: string): string {
  try { return btoa(unescape(encodeURIComponent(json))) } catch { return '' }
}
function decodeClip(b64: string): string {
  try { return decodeURIComponent(escape(atob(b64))) } catch { return '' }
}

/** 选区 → 结构化节点表 + 纯文本（标签位置留空；块级边界补换行） */
function serializeClip(root: HTMLElement): { nodes: ClipNode[]; plain: string } {
  const nodes: ClipNode[] = []
  let plain = ''
  const pushText = (s: string) => { if (!s) return; nodes.push({ t: 'text', s }); plain += s.replace(/\n/g, ' ') }
  const pushBr = () => { nodes.push({ t: 'br' }); if (!plain.endsWith('\n')) plain += '\n' }
  const isBlock = (tag: string) => /^(DIV|P|LI|TR|H[1-6]|BLOCKQUOTE|PRE)$/.test(tag)
  const items = new Map(chatStore.contentItems.filter(i => i.type === 'tag').map(i => [i.id, i as any]))
  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) { pushText(node.textContent || ''); return }
    if (node.nodeType !== Node.ELEMENT_NODE) return
    const el = node as HTMLElement
    if (el.tagName === 'BR') { pushBr(); return }
    const skill = el.getAttribute('data-skill-tag')
    const fref = el.getAttribute('data-file-ref')
    const prev = el.getAttribute('data-preview')
    if (skill) { nodes.push({ t: 'tag', kind: 'skill', name: skill }); return }
    if (fref) { nodes.push({ t: 'tag', kind: 'file', relPath: fref, label: (el.textContent || '').trim() }); return }
    if (prev) {
      const tid = el.getAttribute('data-tag-id') || ''
      const item = tid ? items.get(tid) : null
      nodes.push({
        t: 'tag', kind: 'image', name: (el.textContent || 'image').trim(), dataUrl: prev,
        size: Number(item?.metadata?.fileSize || 0), mime: String(item?.metadata?.mimeType || 'image/png'),
      })
      return
    }
    const blk = isBlock(el.tagName)
    if (blk && plain && !plain.endsWith('\n')) pushBr()
    for (const c of Array.from(el.childNodes)) walk(c)
    if (blk && plain && !plain.endsWith('\n')) pushBr()
  }
  for (const c of Array.from(root.childNodes)) walk(c)
  return { nodes, plain: plain.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/\n+$/, '') }
}

/** 对外的 HTML：标签换成空占位（**绝不把 base64 缩略图塞进剪贴板**），并附隐藏载荷 */
function buildClipHtml(holder: HTMLElement, payloadB64: string): string {
  const clone = holder.cloneNode(true) as HTMLElement
  clone.querySelectorAll('.tag-inline[data-tag-id],[data-skill-tag],[data-file-ref],[data-preview]').forEach((el) => {
    const span = document.createElement('span')
    span.setAttribute('data-nis-tag', '1')
    el.replaceWith(span)
  })
  return `<div data-nis-clip="${payloadB64}" hidden></div>` + clone.innerHTML
}

function onCopy(e: ClipboardEvent) {
  const el = editorRef.value
  const dt = e.clipboardData
  if (!el || !dt) return
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return
  const range = sel.getRangeAt(0)
  if (!el.contains(range.commonAncestorContainer)) return
  let holder: HTMLElement
  try {
    holder = document.createElement('div')
    holder.appendChild(range.cloneContents())
  } catch { return }
  // 选区里没有标签 → 不干预（交回浏览器默认）
  if (!holder.querySelector('.tag-inline[data-tag-id],[data-skill-tag],[data-file-ref],[data-preview]')) return
  const { nodes, plain } = serializeClip(holder)
  if (!nodes.length) return
  const payload = JSON.stringify({ v: 1, nodes })
  e.preventDefault()
  e.stopPropagation()
  dt.setData('text/plain', plain)
  dt.setData('text/html', buildClipHtml(holder, encodeClip(payload)))
  try { dt.setData('application/x-nis-clip', payload) } catch { /* 个别环境不支持自定义 MIME，忽略 */ }
  rememberClip(payload, plain)   // ★ 0921e：留一份最近载荷（系统剪贴板被清洗时兜底）
  /* ★1004p（实测反馈"标签复制粘贴后丢失"根因）：cut 同走本处理器 —— 旧 onCut 单独一份且
     **故意不 preventDefault** ⇒ 按规范浏览器默认动作会用选区序列化**覆盖**剪贴板，载荷全被洗掉
     （479 行"裸 base64 兜底"就是它漏的证据）。现在自己删选区（undo 快照先行），语义不变。 */
  if (e.type === 'cut') {
    snapshotNow()
    sel.deleteFromDocument()
    reportDraft()
  }
}

/* ★ 0921e：系统剪贴板兜底 ——
 *  实测（用户 0921）：有些环境（安全软件 / 浏览器策略）会把我们用 setData 写进剪贴板的
 *  `text/html` 清洗掉（自定义 MIME 更是直接丢），于是"NIS 内复制→粘贴"也只剩纯文本 = 丢标签。
 *  对策：复制时同时在 localStorage 留一份最近的载荷 + 它的纯文本；
 *        粘贴时若**剪贴板里没有我们的载荷**、但纯文本与那份记录**完全一致** ⇒ 用记录里的载荷精确还原。
 *        纯文本不一致 ⇒ 用户是从别处复制的内容 ⇒ 绝不套用记录（避免"贴出上一次的东西"）。 */
const NIS_CLIP_KEY = 'nis-clip-last'
const NIS_CLIP_TTL_MS = 10 * 60 * 1000
function rememberClip(payload: string, plain: string): void {
  try { localStorage.setItem(NIS_CLIP_KEY, JSON.stringify({ at: Date.now(), plain, payload })) } catch { /* 配额/隐私模式：忽略 */ }
}
function readLocalClipFallback(plainFromClipboard: string): { v: number; nodes: ClipNode[] } | null {
  if (!plainFromClipboard) return null
  try {
    const raw = localStorage.getItem(NIS_CLIP_KEY)
    if (!raw) return null
    const rec = JSON.parse(raw) as { at?: number; plain?: string; payload?: string }
    if (!rec?.payload) return null
    if (Date.now() - Number(rec.at || 0) > NIS_CLIP_TTL_MS) return null
    if (String(rec.plain || '').trim() !== String(plainFromClipboard).trim()) return null
    const j = JSON.parse(rec.payload)
    return (j && j.v === 1 && Array.isArray(j.nodes)) ? j as { v: number; nodes: ClipNode[] } : null
  } catch { return null }
}

/** 从剪贴板取 NIS 结构化载荷（自定义 MIME 优先，其次 HTML 里的隐藏块） */
function readClipPayload(dt: DataTransfer): { v: number; nodes: ClipNode[] } | null {
  const parse = (s: string) => {
    try {
      const j = JSON.parse(s)
      return (j && j.v === 1 && Array.isArray(j.nodes)) ? j as { v: number; nodes: ClipNode[] } : null
    } catch { return null }
  }
  const direct = dt.getData('application/x-nis-clip')
  if (direct) { const p = parse(direct); if (p) return p }
  const html = dt.getData('text/html') || ''
  const m = /data-nis-clip="([^"]+)"/.exec(html)
  if (m && m[1]) { const p = parse(decodeClip(m[1])); if (p) return p }
  return null
}

/** 按载荷**逐节点重建**（顺序与标签结构原样还原） */
function pasteStructuredPayload(p: { nodes: ClipNode[] }): boolean {
  if (!p?.nodes?.length) return false
  try {
    for (const n of p.nodes) {
      if (n.t === 'text') insertTextKeepBreaks(n.s)
      else if (n.t === 'br') insertHtmlAtCursor('<br>')
      else if (n.t === 'tag') {
        if (n.kind === 'skill') insertSkillTag(n.name)
        else if (n.kind === 'file') insertFileRef(n.relPath, n.label)
        else if (n.kind === 'image') insertImageTag(n.name, Number(n.size || 0), String(n.dataUrl || ''), String(n.mime || 'image/png'))
      }
    }
    return true
  } catch { return false }
}

/** 插入纯文本并**保留换行**（粘贴多行内容时用；insertText 不处理 \n，会把多行挤成一行） */
function insertTextKeepBreaks(text: string) {
  if (!text) return
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  insertHtmlAtCursor(escaped.replace(/\r\n?|\n/g, '<br>'))
  chatStore.addText(text)
}

function handlePaste(e: ClipboardEvent) {
  /* ★ 0921w（实测）：**粘贴前先存一份快照** ——
     之前只在"用户输入(input)"和"插入标签"时存快照，粘贴大段内容后按 Ctrl+Z 撤不回去。
     这里先存「粘贴前」的 DOM；粘贴完成后 input 事件还会再存一份「粘贴后」，
     而 undoOnce 遇到与当前完全相同的快照会自动跳过 → Ctrl+Z 直接回到粘贴前。 */
  snapshotNow()

  const cd = e.clipboardData
  if (!cd) return
  /* ★ 0921（实测两件事，都在这一个函数里）：
     ① "带标签的内容复制后粘回来，标签会消失、序号还会换行" —— 原来**只读 text/plain**，
        标签 chip 的 HTML 结构整个丢掉；
     ② "从别处复制文本 + 图片，粘不进来" —— 原来 `items` 循环**遇到第一个图片就 return**，
        混合内容里的另一半（以及后面的图片）直接被吞。
     新逻辑：先把剪贴板能给的都收下（HTML / 纯文本 / **全部**图片），
       · 文本优先走 `pasteStructuredHtml`（自家标签按结构重建），否则退纯文本；
       · 图片**全部**按序插入，不再"见一张就返回"。 */
  const html = cd.getData('text/html') || ''
  const plain = cd.getData('text/plain') || ''
  const images: File[] = []
  if (cd.items) {
    for (const it of Array.from(cd.items)) {
      if (it.kind === 'file' && it.type.startsWith('image/')) {
        const f = it.getAsFile()
        if (f) images.push(f)
      }
    }
  }
  if (!html && !plain && !images.length) return
  /* ★ 0921d：NIS 内部载荷优先 —— 复制时自己写的那一份，能精确还原顺序 + 标签结构（含图片标签 / 文件引用）
     ★ 0921e：剪贴板里没有载荷时，再看"最近载荷"兜底（剪贴板被清洗的情况，见 readLocalClipFallback） */
  const clip = readClipPayload(cd) || readLocalClipFallback(plain)
  if (clip) {
    e.preventDefault()
    e.stopPropagation()
    pasteStructuredPayload(clip)
    return
  }
  /* ★ 0921f-2：剪贴板里只剩一大段"裸 base64"（剪切 / 外部复制把结构化信息洗掉了）——
     直接把它还原成图片标签，别当成文字塞进输入框。 */
  const bare = String(plain || '').trim()
  if (bare && /^data:image\/[a-z+.-]+;base64,[A-Za-z0-9+/=\r\n]{64,}$/i.test(bare)) {
    e.preventDefault()
    e.stopPropagation()
    const mime = bare.slice(5, bare.indexOf(';'))
    insertImageTag('image', 0, bare, mime)
    return
  }
  e.preventDefault()
  e.stopPropagation()
  /* ★ 0921：图片标签内部**嵌着一个真实的 `<img src="data:...">`**（见 insertTagAtCursor），
     复制它时浏览器会把这张图**另外塞进剪贴板的 items** ——
     于是"结构化路径插了标签" + "items 里再插一次" = **同一张图重复两遍**。
     判据：剪贴板 HTML 里已经带自家 `data-preview` ⇒ 图片已走结构化路径，不要再单独插。 */
  /* ★ 0921g：外部 HTML 里的**外链图片**（从网页/文档复制"图片+文本"）——
     浏览器直接取图多半被 CORS 拦，改走本机后端代理（clip.fetchImage）下载成 data URL，
     再变成图片标签。实测背景：这类粘贴以前只剩文字（反馈）。 */
  const extImgs = (() => {
    try {
      return Array.from(new DOMParser().parseFromString(html, 'text/html').querySelectorAll('img'))
        .map((el) => String(el.getAttribute('src') || '').trim())
        .filter((src) => /^(https?:\/\/|file:\/\/)/i.test(src) || /^[a-zA-Z]:[\\/]/.test(src))   // ★ 0921j：http(s) 之外还要收 file:// 与盘符路径（QQ/微信剪贴板常用）
    } catch { return [] as string[] }
  })()
  /* ★ 0923 修（实测：粘贴"图片+文本"后，所有图片标签都跑到文本末尾）：
     根因 —— 从网页/Word/QQ 复制时剪贴板**往往同时**带 HTML（外链 img）**和**图片文件（images），
     旧条件 `extImgs.length && !images.length` 会整段跳过"槽位插入"路径，改由下面的
     `readImageFile(f)` 把图片追加到**当前光标（即文本末尾）**，于是图片全堆到最后。
     现在：只要 HTML 里有外链图片就走槽位路径（图片回到各自原位置）；
     外链下载失败时，用剪贴板里的图片文件按顺序**兜底补进同一个槽位**（不丢图、也不堆末尾）。 */
  let extFileIdx = 0
  if (extImgs.length) {
    e.preventDefault()
    e.stopPropagation()
    if (!html || !pasteStructuredHtml(html)) { if (plain) insertTextKeepBreaks(plain) }
    void (async () => {
      for (const u of extImgs.slice(0, 8)) {
        let placed = false
        try {
          const r: any = await chatStore.bridgeRpc('clip.fetchImage', { url: u })
          if (r?.ok && r.dataUrl) {
            const nm = (u.split('?')[0].split(/[\\/]/).pop() || 'image').slice(0, 40)
            insertImageTagAtSlot(u, nm, Number(r.bytes || 0), String(r.dataUrl), String(r.mime || 'image/png'))
            placed = true
          }
        } catch { /* 下载失败 → 走下面的文件兜底 */ }
        if (!placed) {
          const f = images[extFileIdx]
          if (f) { extFileIdx++; await insertImageFileAtSlot(u, f) }
        }
      }
    })()
    return
  }
  const handledByHtml = /data-preview=/.test(html)
  if (!pasteStructuredHtml(html) && plain) insertText(plain)
  if (!handledByHtml) for (const f of images) readImageFile(f)
}

function readImageFile(file: File) {
  pendingImageReads.value++
  const reader = new FileReader()
  reader.onload = () => {
    insertImageTag(file.name, file.size, reader.result as string, file.type)
    pendingImageReads.value--
    if (pendingImageReads.value <= 0 && pendingImageResolve) {
      pendingImageResolve()
      pendingImageResolve = null
    }
  }
  /* 0927 netfix: add onerror -- on read failure the counter never dropped to zero and
     getImageAttachments() awaited forever => the whole send flow hung. */
  reader.onerror = () => {
    pendingImageReads.value--
    if (pendingImageReads.value <= 0 && pendingImageResolve) {
      pendingImageResolve()
      pendingImageResolve = null
    }
  }
  reader.readAsDataURL(file)
}

/** ★ 0921k：把图片标签插到"占位符"的原位置 ——
 *  外链图片要等后端下载，属于异步；直接 append 会让图片全部落到文本末尾（实测），
 *  所以在文本按顺序插入时先留占位，下载完成后回到占位处替换。找不到占位就退化成追加。 */
/** ★ 0923：把剪贴板里的图片文件读成 dataUrl，再插到**原槽位**（外链图片下载失败时的兜底）。
 *  与 insertImageTagAtSlot 同一套落位逻辑，只是数据来源从"后端代理下载"换成"剪贴板文件"。 */
async function insertImageFileAtSlot(srcUrl: string, file: File): Promise<void> {
  const dataUrl = await new Promise<string>((resolve) => {
    const rd = new FileReader()
    rd.onload = () => resolve(String(rd.result || ''))
    rd.onerror = () => resolve('')
    rd.readAsDataURL(file)
  })
  if (!dataUrl) return
  insertImageTagAtSlot(srcUrl, (file.name || 'image').slice(0, 40), file.size, dataUrl, file.type || 'image/png')
}

function insertImageTagAtSlot(srcUrl: string, name: string, size: number, dataUrl: string, mime: string) {
  const ed = editorRef.value
  const slot = ed ? (ed.querySelector('[data-nis-imgslot="' + encodeURIComponent(srcUrl) + '"]') as HTMLElement | null) : null
  if (!slot) { insertImageTag(name, size, dataUrl, mime); return }
  const r = document.createRange()
  r.setStartBefore(slot)
  r.collapse(true)
  const sel = window.getSelection()
  if (sel) { sel.removeAllRanges(); sel.addRange(r) }
  savedRange = r.cloneRange()
  insertImageTag(name, size, dataUrl, mime)
  slot.remove()
}

function insertImageTag(name: string, size: number, dataUrl: string, mimeType: string) {
  insertTagAtCursor(
    { tagType: 'image', fileName: name, fileSize: size, dataUrl, mimeType },
    name
  )
}

/* ── 图片标签悬停预览大图 ── */
const imagePreview = ref<{ x: number; y: number; src: string; w: number; h: number } | null>(null)
/** ★ 0923：当前正在预览的那个图片标签元素 —— 用于"标签一旦离开 DOM 就自动收回预览"。
 *  实测复现：悬停图片标签看大图 → 直接点发送（标签被 clearEditor 移出 DOM）
 *  → 浏览器**不会补发 mouseleave**（元素已不在 DOM 里）⇒ 预览浮层卡在屏幕上不消失。 */
let previewTagEl: HTMLElement | null = null
/** 点击图片标签 → 全屏查看 */
const fullImgSrc = ref<string | null>(null)

function showImagePreview(e: Event, src: string) {
  const el = e.currentTarget as HTMLElement
  previewTagEl = el
  const rect = el.getBoundingClientRect()
  // 读取原图尺寸，按 80% 显示
  const img = new Image()
  img.onload = () => {
    if (imagePreview.value?.src === src) {
      imagePreview.value.w = Math.round(img.naturalWidth * 0.8)
      imagePreview.value.h = Math.round(img.naturalHeight * 0.8)
    }
  }
  img.src = src
  // 在标签上方显示
  imagePreview.value = { x: rect.left, y: rect.top, src, w: 0, h: 0 }
}

function hideImagePreview() {
  imagePreview.value = null
  previewTagEl = null
}

function previewStyle() {
  if (!imagePreview.value) return {}
  const p = imagePreview.value
  const style: Record<string, string> = {
    left: p.x + 'px',
    top: (p.y - 10) + 'px',
    transform: 'translateY(-100%)',
  }
  if (p.w > 0 && p.h > 0) {
    style.width = p.w + 'px'
    style.height = p.h + 'px'
  }
  return style
}

function insertHtmlAtCursor(html: string) {
  const el = editorRef.value
  if (!el) return
  const sel = window.getSelection()
  let range: Range | null = null
  if (savedRange && el.contains(savedRange.commonAncestorContainer)) {
    range = savedRange
  } else if (sel && sel.rangeCount > 0) {
    const cur = sel.getRangeAt(0)
    if (el.contains(cur.commonAncestorContainer)) range = cur
  }

  if (range) {
    range.deleteContents()
    const temp = document.createElement('div')
    temp.innerHTML = html
    const frag = document.createDocumentFragment()
    let node
    while (node = temp.firstChild) frag.appendChild(node)
    range.insertNode(frag)
    range.collapse(false)
    savedRange = range.cloneRange()
  } else {
    el.insertAdjacentHTML('beforeend', html)
    // 0914：兜底路径也把光标落到末尾，置入后可直接续写
    const endRange = document.createRange()
    endRange.selectNodeContents(el)
    endRange.collapse(false)
    savedRange = endRange.cloneRange()
  }
  // 0914：聚焦编辑器 + 光标落位——置入即能用键盘继续输入。
  // 根因：置入时焦点还在预览页/按钮上，键盘事件发给 <body>，表现为「置入后无法再输入」（用户实测 bug）。
  try { el.focus({ preventScroll: true }) } catch { /* ignore */ }
  if (savedRange && el.contains(savedRange.commonAncestorContainer)) {
    const sel2 = window.getSelection()
    if (sel2) { sel2.removeAllRanges(); sel2.addRange(savedRange) }
  }
  syncStoreOrder()
  attachTagEvents()
}

/* ── 退格删除（黄框确认两次） ── */
let highlightTimer: ReturnType<typeof setTimeout> | null = null

/** ★ 0921p（反馈）：光标在「行首标签」**前面**时，也把这个标签当作"上一个可删单元"。
 *  背景：原两段式退格只认"光标在标签后面"（findPrevTag）；标签换行到新行行首后，光标在它前面，
 *  判定不到 → 走浏览器默认 → Chrome 在块级 contenteditable 里会**跨行删掉上一行最后一个字**（实测 UX bug）。
 *  判定条件（保守，避免误伤正常退格）：
 *   ① 光标是折叠态（没选中内容）；
 *   ② 光标往后的第一个非空节点是带 data-tag-id 的标签；
 *   ③ 光标**在本容器内**前面没有实质文本（即处于行首）——有字就是普通退格，不干预。
 *  命中后返回该标签，交给两段式逻辑：第一次高亮、第二次删除，全程不动上一行文字。 */
/** ★ 0924（实测反馈"退格退不掉 / 说不上来的奇怪"）：把光标跨过紧邻的**纯零宽锚点**（不删它）。
 *  背景：标签两侧各有一个 U+200B（留给光标落位用，见 insertTag / removeTagWithAnchors），它不可见 ——
 *  光标停在锚点后面时按退格，浏览器删掉的是这个看不见的字符，屏幕毫无变化，
 *  用户以为"退格失灵"（往往得连按两下才动）。
 *  做法：把折叠光标前移到锚点之前，再由下面的判定 / 浏览器默认行为去删"真正的内容" ——
 *  这样任何一次退格都有可见反馈，同时锚点仍留在原位（不破坏光标落位机制）。 */
function hopOverZwAnchor(): void {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return
  const r = sel.getRangeAt(0)
  if (!r.collapsed) return
  const isPureZw = (n: Node | null): boolean =>
    !!n && n.nodeType === Node.TEXT_NODE
    && String(n.textContent || '').includes('\u200B')
    && !String(n.textContent || '').replace(/\u200B/g, '')
  const moveBefore = (n: Node, off: number) => {
    const nr = document.createRange()
    nr.setStart(n, off)
    nr.collapse(true)
    sel.removeAllRanges()
    sel.addRange(nr)
  }
  const node = r.startContainer
  if (node.nodeType !== Node.TEXT_NODE) return
  const t = node as Text
  if (r.startOffset === 0) {
    // 光标在文本开头：紧邻的**前一个兄弟**是纯零宽锚点 → 跨过去
    if (isPureZw(t.previousSibling)) moveBefore(t.previousSibling as Node, String((t.previousSibling as Node).textContent || '').length)
    return
  }
  if (/^[\u200B]+$/.test(String(t.textContent || ''))) {
    // 光标就停在一个"纯零宽"文本节点里 → 前移一格（跨过它）
    moveBefore(t, Math.max(0, r.startOffset - 1))
  }
}

function findNextTagAtLineStart(): HTMLElement | null {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return null
  const r = sel.getRangeAt(0)
  if (!r.collapsed) return null
  // ① 光标后的第一个非空节点
  let next: Node | null = null
  if (r.startContainer.nodeType === Node.TEXT_NODE) {
    const t = r.startContainer as Text
    if (r.startOffset < (t.textContent || '').length) return null
    next = t.nextSibling
  } else {
    next = (r.startContainer as Element).childNodes[r.startOffset] || null
  }
  while (next && next.nodeType === Node.TEXT_NODE && !String(next.textContent || '').trim()) next = next.nextSibling
  if (!next || next.nodeType !== 1) return null
  if (!(next as Element).matches && !(next as Element).matches('[data-tag-id]')) return null
  if (!(next as Element).matches('[data-tag-id]')) return null
  // ② ★ 0924 修正（实测反馈"胶囊下面几行按退格退不掉、标签还闪一下"）：
  //    必须做**跨节点**的同行判定 —— 原实现当 startContainer 是文本节点时只看它自己内部，
  //    于是"光标在胶囊下方隔了几行的空文本节点里"也被判成"紧贴标签的行首" → 误触发两段式退格
  //    （退格被 preventDefault 吃掉 = 用户感觉"退不掉"；高亮 800ms = 用户看到"闪一下"）。
  //    新规则：从光标一路往前遍历（自身 → 兄弟 → 祖先兄弟…直到容器起点）：
  //      · 遇到 <br>  → 这是真行首，继续判定（保留 0921p 的原始场景）
  //      · 遇到实质内容（文字 / 标签）→ 同行前面有东西，光标不在"紧贴标签的行首" → 不干预
  let sawContent = false
  let sawBr = false
  {
    const node = r.startContainer
    if (node.nodeType === Node.TEXT_NODE) {
      if (String(node.textContent || '').slice(0, r.startOffset).replace(/[\s\u200b]/g, '')) sawContent = true
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const kids = (node as Element).childNodes
      for (let k = 0; k < r.startOffset; k++) {
        const kn = kids[k]
        if (!kn) continue
        if (kn.nodeName === 'BR') { sawBr = true; break }
        if (kn.nodeType === Node.ELEMENT_NODE && (kn as Element).matches('[data-tag-id]')) { sawContent = true; break }
        if (String(kn.textContent || '').replace(/[\s\u200b]/g, '')) { sawContent = true; break }
      }
    }
    let cur: Node | null = r.startContainer
    while (!sawContent && !sawBr && cur && cur !== editorRef.value) {
      let sib: Node | null = cur.previousSibling
      while (sib) {
        if (sib.nodeName === 'BR') { sawBr = true; break }
        if (sib.nodeType === Node.ELEMENT_NODE && (sib as Element).matches('[data-tag-id]')) { sawContent = true; break }
        if (String(sib.textContent || '').replace(/[\s\u200b]/g, '')) { sawContent = true; break }
        sib = sib.previousSibling
      }
      cur = cur.parentNode
    }
  }
  if (sawContent) return null
  return next as HTMLElement
}

/** 当前块是否"真空行"：无可见文本、无图片/标签等实质内容 */
function isBlankBlock(el: Node | null): boolean {
  if (!el || el.nodeType !== 1) return false
  const e = el as Element
  if (String(e.textContent || '').replace(/[\s\u200b]/g, '')) return false
  return !e.querySelector('img,[data-nis-imgslot],[data-preview],[data-tag-id],[data-skill-tag],[data-file-ref]')
}

/** 紧邻的上一个**元素块**（不跳过空块 —— 让连按退格逐级删空行；只跳过文本/BR 节点） */
function prevSiblingBlock(block: Node): Node | null {
  let prev = block.previousSibling
  while (prev && prev.nodeType !== 1) prev = prev.previousSibling
  return prev
}

/* ★ 0925（反馈"有图片标签的情况下删除空换行会直接把图片标签删掉"）：
 * contenteditable 的块级空行行首退格会走"合并块"原生逻辑，把上一行行尾的**图片 span**
 * （data-nis-imgslot / data-preview）一起吞掉。这里拦截：光标在**块级空行**的行首时，
 * 手动执行"删空行"——移除当前空行块、光标落到**紧邻上一个块**的行首。
 * ★ 0925b（用户续馈"隔 2 行连按删除图片还是被删"）：两个关键点——
 *   ① 光标必须落**行首**而不是行尾：落行尾的话连按第二下时光标已"紧贴"行尾图片，原生删除直接吞标签；
 *   ② 落点必须是**紧邻上一块**（不跳过空块）：否则连按时光标飞过空行直接落到图片行首，
 *      下一次退格（块首）仍会删掉行首图片。逐级上行后：
 *      · 上一块是空行 → 继续走本拦截，一级级删空行；
 *      · 上一块行内有文字 → 原生退格删文字（正常行为，不碰标签）；
 *      · 上一块行首即标签（纯图片行）→ 交给 findNextTagAtLineStart 两段式（第一下高亮、第二下才删）。
 *   即"光标不紧贴的内容一律删不到"，与设计口径一致；对所有 [data-tag-id] 标签一视同仁。 */
/* ★ 0925p（实测"删换行却高亮/删掉了上一行行尾的发黄标签"）：块首退格=**只删块边界**
 * （把本块并入上一块，光标落上一块尾=设计口径"回到 3. 后面"），**绝不碰标签** ——
 * 旧逻辑块首没有合并分支：要么被 0925d 的 no-op 拦住（退格像失灵），要么落到 findPrevTag
 * 两段式**跨块**找到上一块行尾的标签当"紧邻可删内容"（发黄高亮→再按就删）。标签删除只走
 * 紧贴两段式或 × 按钮；块边界退格的语义就是删换行。 */
function backspaceMergeAtBlockStart(): boolean {
  const ed = editorRef.value
  if (!ed) return false
  const sel = window.getSelection()
  if (!sel || !sel.isCollapsed || sel.rangeCount === 0) return false
  const r = sel.getRangeAt(0)
  if (r.startOffset !== 0) return false
  let block: Node | null = r.startContainer
  if (block.nodeType === Node.TEXT_NODE) block = block.parentNode
  while (block && block !== ed && !/^(DIV|P|LI)$/.test(block.nodeName)) block = block.parentNode
  if (!block || block === ed) return false
  // 光标须在"块内第一个实质内容之前"（前面只有空白/零宽/BR）——句中零偏移不算块首
  const kids = (block as Element).childNodes
  let idx = -1
  /* ★ 0925q 补漏：光标在块**自身**（如空行 <div><br></div> 的 div 上 offset=0）——
     旧判定只在 childNodes 里找 startContainer，这种形态找不到 → idx=-1 漏掉（合并失灵）。 */
  if (r.startContainer === block) idx = r.startOffset
  for (let i = 0; i < kids.length && idx < 0; i++) { if (kids[i] === r.startContainer || kids[i].contains?.(r.startContainer)) { idx = i; break } }
  if (idx < 0) return false
  for (let i = 0; i < idx; i++) {
    const k = kids[i]
    const blank = (k.nodeType === 3 && !String(k.textContent || '').replace(/[\u200b\s]/g, '')) || k.nodeName === 'BR'
    if (!blank) return false // 前面有实质内容 → 不是块首
  }
  const prev = prevSiblingBlock(block)
  if (!prev) return false // 已是第一个块 → 放行原生
  /* 合并：本块子节点整体接到上一块尾，光标落在接缝（=上一块尾）
   * ★ 0925t：本块是**空行**（只有 BR/空白）时把 BR 丢掉再并 —— 否则残留 BR 等于空行还在
   * （实测"删换行删不掉"的尾巴：块边界删了但 BR 还占一行）。 */
  const hasReal = Array.from(block.childNodes).some(k =>
    !(k.nodeName === 'BR' || (k.nodeType === 3 && !String(k.textContent || '').replace(/[\u200b\s]/g, ''))))
  const marker = document.createTextNode('')
  prev.appendChild(marker)
  while (block.firstChild) {
    const k = block.firstChild
    if (!hasReal && k.nodeName === 'BR') { k.remove(); continue }
    prev.appendChild(k)
  }
  block.parentNode?.removeChild(block)
  const range = document.createRange()
  range.setStartAfter(marker)
  range.collapse(true)
  sel.removeAllRanges()
  sel.addRange(range)
  return true
}

function backspaceEmptyLineAtStart(): boolean {
  const ed = editorRef.value
  if (!ed) return false
  const sel = window.getSelection()
  if (!sel || !sel.isCollapsed || sel.rangeCount === 0) return false
  const r = sel.getRangeAt(0)
  if (r.startOffset !== 0) return false
  let block: Node | null = r.startContainer
  if (block.nodeType === Node.TEXT_NODE) block = block.parentNode
  while (block && block !== ed && !/^(DIV|P|LI)$/.test(block.nodeName)) block = block.parentNode
  if (!block || block === ed) return false
  if (!isBlankBlock(block)) return false
  const prev = prevSiblingBlock(block)
  if (!prev) return false // 已是第一个块 → 不干预（放行原生，空编辑器按退格本就无内容可删）
  block.parentNode?.removeChild(block)
  const range = document.createRange()
  range.setStart(prev, 0)   // ★ 0925b：落紧邻上一块**行首**（不落行尾、不跳空块）
  range.collapse(true)
  sel.removeAllRanges()
  sel.addRange(range)
  return true
}

/* ★ 0925d（实测："不管标签在哪，只要删换行，最近的标签就进待删除状态，再退格就被删"）：
 * 光标在**块首**、块内第一个实质元素就是标签 → 退格 no-op。
 * 语义=用户的"只删光标紧贴的内容"：此时光标前方只有块边界（没有紧贴的可删内容），
 * 原生行为却会删/高亮行内首个标签 —— 删换行连按时光标被带到纯图片行行首，正是这个坑。
 * 主动删标签：把光标移到标签**后方**（紧贴）走两段式，或点标签上的 ×。 */
function backspaceAtBlockStartBeforeTag(): boolean {
  const ed = editorRef.value
  if (!ed) return false
  const sel = window.getSelection()
  if (!sel || !sel.isCollapsed || sel.rangeCount === 0) return false
  const r = sel.getRangeAt(0)
  if (r.startOffset !== 0) return false
  const node = r.startContainer
  if (node.nodeType !== 1) return false
  // 第一个"实质"子节点：跳过纯零宽锚点文本与 BR
  const kids = (node as Element).childNodes
  let first: Node | null = kids[0] || null
  while (first && ((first.nodeType === 3 && !String(first.textContent || '').replace(/[\u200b\s]/g, '')) || first.nodeName === 'BR')) {
    first = first.nextSibling
  }
  return !!(first && first.nodeType === 1 && (first as Element).matches('[data-tag-id]'))
}

function handleKeydown(e: KeyboardEvent) {
  if (props.disabled) return
  /* ★ 0921s：Ctrl+Z 走自建撤销栈（原生在自定义编辑区里失效）；Ctrl+Shift+Z 不做重做（保持简单） */
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === 'z' || e.key === 'Z')) {
    if (undoOnce()) { e.preventDefault(); return }
  }
  if (e.key === 'Backspace') {
    /* ★ 0925p（设计口径）：块首退格=删块边界合并到上一块尾（光标落上一块尾），绝不碰标签 —— 放最前 */
    if (backspaceMergeAtBlockStart()) { e.preventDefault(); return }
    /* ★ 0925d：块首第一个元素是标签 → 退格 no-op（删换行连按时保护行首标签，见函数注释） */
    if (backspaceAtBlockStartBeforeTag()) { e.preventDefault(); return }
    /* ★ 0924：先把光标跨过紧邻的纯零宽锚点（不可见字符，删它＝屏幕毫无变化，用户以为"退格失灵"）——
       跨过之后，本次退格删的才是"看得见的内容"，每次按都有反馈 */
    hopOverZwAnchor()
    /* ★ 0925t（用户最终口径：**标签像文字一样可以退格删除**，拖动/×按钮照旧）：
       紧贴标签的退格=**直接删标签**（单段式，一次删除，不高亮不确认）——像删一个字符。
       块首/换行处退格=删换行合并（backspaceMergeAtBlockStart，不碰标签）。 */
    const tag = findPrevTag()
    if (tag) {
      const tagId = tag.getAttribute('data-tag-id')
      const skillName = tag.getAttribute('data-skill-tag')
      removeTagWithAnchors(tag)   // 连零宽锚点一起清
      if (tagId) chatStore.removeItem(tagId)
      if (skillName) window.dispatchEvent(new CustomEvent('nis-skill-tag-removed', { detail: { name: skillName } }))
      e.preventDefault()
      return
    }
    pendingBackspaceTag.value = null
    /* ★ 0925：块级空行行首退格 → 手动删空行（防原生合并吞掉上一行行尾的图片标签） */
    if (backspaceEmptyLineAtStart()) { e.preventDefault(); return }
  } else if (e.key !== 'Shift') {
    pendingBackspaceTag.value = null
  }
  /* ★0930 修（同一条消息被重复投递/重复引导两次）：**输入法组合期的 Enter 不算发送** ——
     中文输入法确认候选词会触发一次 keydown(Enter)（isComposing / keyCode 229），没有这道闸时
     "确认上屏"被当成"发送"发出去，用户随后再按 Enter 真发送 → 同一内容走两次发送链路
     （实测 session.steer 840ms 内注入两条）。组合期一律放行给输入法，不拦截不发送。 */
  if (e.isComposing || e.keyCode === 229) return
  // 发送快捷键可自定义（设置 → 通用 → 快捷键）；换行键不拦截，走 contenteditable 默认行为
  // 0909⑦：Ctrl+Enter=反向通道（默认插话时=排队，默认排队时=插话），固定绑定不进快捷键设置。
  // ⚠ 若用户把"发送"快捷键自定义成了 Ctrl+Enter，反向通道让位（不劫持正常发送）。
  const sendIsCtrlEnter = matchesShortcut(e, 'Ctrl+Enter') && matchesShortcut(e, settingsStore.shortcuts.send)
  if (!sendIsCtrlEnter && e.key === 'Enter' && e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
    e.preventDefault()
    emit('send', 'ctrl')
    return
  }
  if (matchesShortcut(e, settingsStore.shortcuts.send)) {
    e.preventDefault()
    emit('send')
  }
}

function findPrevTag(): HTMLElement | null {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0 || !editorRef.value) return null
  const range = sel.getRangeAt(0)
  if (!range.collapsed) return null
  const node = range.startContainer
  /* ★ 0925c（实测："光标在第二行，第一行图片却进待删除状态/直接被删"）：
   * 原逻辑只认 startOffset===0（行首）—— 但光标停在**块内非行首**（BR 前、块尾、
   * 标签后的零宽锚点里）时全部落空 → 原生退格直接吞标签。这里补"紧贴"判定：
   * 光标正前方的节点是标签（直接紧贴）或其后的纯零宽锚点（光标实际贴在标签尾）→ 认领，
   * 交给两段式（第一下高亮、第二下才删）。BR/文字前方不认（那些情况原生退格本就安全）。 */
  if (node.nodeType === 1 && range.startOffset > 0) {
    const kids = (node as Element).childNodes
    const before = kids[range.startOffset - 1]
    if (before && before.nodeType === 1 && (before as Element).matches('[data-tag-id]')) {
      return before as HTMLElement
    }
    const isZwAnchor = before && before.nodeType === 3 && String(before.textContent || '').includes('\u200B')
    if (isZwAnchor) {
      const b2 = kids[range.startOffset - 2]
      if (b2 && b2.nodeType === 1 && (b2 as Element).matches('[data-tag-id]')) return b2 as HTMLElement
    }
    return null
  }
  /* ★ 0925t（用户最终口径：退格=删换行/删紧贴的标签，像文字）：原来 startOffset===0 时
     **跨块**往前找元素（parentElement.previousElementSibling）——"贴图→换行→退格"亮上一行
     标签就是它。块首退格的语义是**删换行合并**（backspaceMergeAtBlockStart 接管），不认领标签。 */
  return null
}

/* ── 标签点击 / 删除 ── */
function handleTagClick(metadata: any) {
  emit('tagClick', metadata)
}

function handleEditorClick(e: MouseEvent) {
  const target = e.target as HTMLElement
  if (target.classList.contains('tag-delete-btn') || target.closest('.tag-delete-btn')) {
    const tagId = target.closest('[data-tag-id]')?.getAttribute('data-tag-id')
    if (tagId) removeItem(tagId)
    e.preventDefault(); e.stopPropagation()
    return
  }
  if (target.closest('[data-tag-id]')) {
    const tagId = target.closest('[data-tag-id]')?.getAttribute('data-tag-id')
    const item = chatStore.contentItems.find(i => i.id === tagId)
    if (item) handleTagClick(item.metadata)
    e.preventDefault(); e.stopPropagation()
  }
  saveCursorPosition()
}

function removeItem(id: string) {
  // 标签被移除时可能不会触发 mouseleave（元素已脱离 DOM），需手动清预览
  hideImagePreview()
  if (editorRef.value) {
    const tag = editorRef.value.querySelector(`[data-tag-id="${id}"]`)
    if (tag) {
      // skill 标签被删 → 通知 SkillPicker 同步取消选中
      const skillName = tag.getAttribute('data-skill-tag')
      if (skillName) window.dispatchEvent(new CustomEvent('nis-skill-tag-removed', { detail: { name: skillName } }))
      tag.remove()
    }
  }
  chatStore.removeItem(id)
}

/* ── 自定义指针拖拽（避免原生 DnD 换行问题） ── */
const dragState = {
  tagId: null as string | null,
  tagEl: null as HTMLElement | null,
  startX: 0,
  startY: 0,
  dragging: false,
  ghost: null as HTMLElement | null,
  indicator: null as HTMLElement | null,
}

function onTagMouseDown(e: MouseEvent, id: string) {
  if (e.button !== 0) return
  if ((e.target as HTMLElement).closest('.tag-delete-btn')) return
  dragState.tagId = id
  dragState.tagEl = e.currentTarget as HTMLElement
  dragState.startX = e.clientX
  dragState.startY = e.clientY
  dragState.dragging = false
  // 记录当前光标位置，供 drop 用
  saveCursorPosition()
}

function onDocumentMouseMove(e: MouseEvent) {
  if (!dragState.tagId) return
  const dx = e.clientX - dragState.startX
  const dy = e.clientY - dragState.startY
  if (!dragState.dragging) {
    if (Math.hypot(dx, dy) > 5) {
      dragState.dragging = true
      createGhost()
    } else {
      return
    }
  }
  if (dragState.dragging) {
    if (dragState.ghost) {
      dragState.ghost.style.left = (e.clientX - 10) + 'px'
      dragState.ghost.style.top = (e.clientY - 10) + 'px'
    }
    updateDropIndicator(e)
  }
}

function onDocumentMouseUp(e: MouseEvent) {
  if (dragState.dragging) {
    performDrop(e)
  }
  cleanupDrag()
}

function createGhost() {
  if (!dragState.tagEl) return
  const ghost = dragState.tagEl.cloneNode(true) as HTMLElement
  ghost.style.position = 'fixed'
  ghost.style.pointerEvents = 'none'
  ghost.style.opacity = '0.5'
  ghost.style.zIndex = '9999'
  ghost.style.left = '0'
  ghost.style.top = '0'
  ghost.removeAttribute('data-draggable')
  document.body.appendChild(ghost)
  dragState.ghost = ghost

  const ind = document.createElement('div')
  ind.style.cssText = 'position:fixed;width:2px;background:#6366f1;z-index:9998;pointer-events:none;display:none;height:24px;'
  document.body.appendChild(ind)
  dragState.indicator = ind
  document.body.style.userSelect = 'none'
}

function updateDropIndicator(e: MouseEvent) {
  const el = editorRef.value
  if (!el || !dragState.indicator) return
  const range = caretFromPoint(e.clientX, e.clientY)
  if (!range) { dragState.indicator.style.display = 'none'; return }
  const rect = range.getClientRects()[0] || (range.getBoundingClientRect && range.getBoundingClientRect())
  if (!rect) { dragState.indicator.style.display = 'none'; return }
  dragState.indicator.style.display = 'block'
  dragState.indicator.style.left = (rect.left + (rect.width > 1 ? rect.width : 0)) + 'px'
  dragState.indicator.style.top = (rect.top - 2) + 'px'
  dragState.indicator.style.height = (rect.height + 4) + 'px'
}

function caretFromPoint(x: number, y: number): Range | null {
  const doc = document as any
  if (doc.caretRangeFromPoint) return doc.caretRangeFromPoint(x, y)
  if (doc.caretPositionFromPoint) {
    const pos = doc.caretPositionFromPoint(x, y)
    if (pos) {
      const r = document.createRange()
      r.setStart(pos.offsetNode, pos.offset)
      r.collapse(true)
      return r
    }
  }
  return null
}

function performDrop(e: MouseEvent) {
  const el = editorRef.value
  if (!el || dragState.tagId === null || !dragState.tagEl) return

  // 从 DOM 移除原标签（保持引用）
  const moved = dragState.tagEl

  const range = caretFromPoint(e.clientX, e.clientY)
  if (range && el.contains(range.commonAncestorContainer)) {
    range.deleteContents()
    range.insertNode(moved)
    const space = document.createTextNode(' ')
    range.setStartAfter(moved)
    range.insertNode(space)
    range.setStartAfter(space)
    range.collapse(true)
  } else {
    el.appendChild(moved)
    const space = document.createTextNode(' ')
    el.appendChild(space)
  }

  // 同步 store 标签顺序
  syncStoreOrder()
  saveCursorPosition()
  attachTagEvents()
}

function syncStoreOrder() {
  const el = editorRef.value
  if (!el) return
  const domIds = Array.from(el.querySelectorAll('[data-tag-id]')).map(t => t.getAttribute('data-tag-id'))
  const tags = chatStore.contentItems.filter(i => i.type === 'tag')
  tags.sort((a, b) => domIds.indexOf(a.id) - domIds.indexOf(b.id))
  const nonTags = chatStore.contentItems.filter(i => i.type !== 'tag')
  chatStore.setContentItems([...nonTags, ...tags])
}

function cleanupDrag() {
  if (dragState.ghost) dragState.ghost.remove()
  if (dragState.indicator) dragState.indicator.remove()
  dragState.ghost = null
  dragState.indicator = null
  dragState.tagId = null
  dragState.tagEl = null
  dragState.dragging = false
  document.body.style.userSelect = ''
}

/* ── 绑定标签事件 ── */
function attachTagEvents() {
  if (!editorRef.value) return
  const tags = editorRef.value.querySelectorAll('[data-tag-id]')
  tags.forEach(tag => {
    if (tag.getAttribute('data-drag-bound')) return
    tag.setAttribute('data-drag-bound', 'true')
    const id = tag.getAttribute('data-tag-id')!
    tag.addEventListener('mousedown', (e: Event) => {
      onTagMouseDown(e as MouseEvent, id)
    })
    // 直接从 DOM 读取预览图片地址（不依赖 store，避免时序问题）
    const preview = tag.getAttribute('data-preview')
    if (preview) {
      tag.addEventListener('mouseenter', (e: Event) => showImagePreview(e, preview))
      tag.addEventListener('mouseleave', () => hideImagePreview())
      // 点击图片标签 → 全屏查看（缩放/拖动）
      tag.addEventListener('click', (e: Event) => {
        const t = e.target as HTMLElement
        if (t.closest('.tag-delete-btn')) return
        e.preventDefault()
        e.stopPropagation()
        fullImgSrc.value = preview
      })
    }
  })
}

/* ── 草稿有无上报（0909⑦改）──
 * 忙时发送钮态需要实时知道输入框是否有内容：有内容=发送(排队/插话)，空=停止。
 * 打字/粘贴/拖图/插删标签/外部 clearEditor/insertText 全部经 DOM 变更，用 MutationObserver 一网打尽，
 * 比逐个函数补 emit 更可靠（此前 wasInterrupted 只跟 chatStore.contentItems=只含标签，漏普通文字=按钮不翻转根因）。 */
let editorObserver: MutationObserver | null = null
function editorHasContent(): boolean {
  const el = editorRef.value
  if (!el) return false
  if (el.querySelector('.tag-inline[data-tag-id]')) return true
  // contenteditable 里的空格常被浏览器存成 \u00a0（nbsp），归一后再判空
  return (el.textContent || '').replace(/\u00a0/g, ' ').trim().length > 0
}
/* === T3-0928 草稿持久化（修「输入框粘贴的截图/草稿一刷新就全没」）====================
 * 文字 + 粘贴图片（data-preview=dataURL 就在 innerHTML 里）随 localStore 落盘 —— localStore 走后端
 * ui-state.json，没有 sessionStorage 的配额问题（截图 dataURL 动辄数 MB，正是 sessionStorage 存不下
 * → setItem 抛异常被静默吞掉 → 刷新全没的根因）。
 * 口径：debounce 300ms 落盘；pagehide/beforeunload 强制 flush（saveDraftNow + localStore.flushNow）；
 * 启动恢复（等 localStore 水合后兜底重试）；按会话分 key，绝不串会话恢复。 */
const DRAFT_KEY_PREFIX = 'nis.chatInput.draft.v1:'
let draftSaveTimer: ReturnType<typeof setTimeout> | null = null
let lastSavedDraftHtml = ''
let lastSavedDraftKey = ''
let draftDirtyEver = false
let onHydratedRestoreOff: (() => void) | null = null

function draftKeyFor(convId: string): string {
  return DRAFT_KEY_PREFIX + (convId || '')
}
/** ★1004r：读回某会话已持久化的草稿（切会话"无条件换内容"时的兜底源——
 *  内存 stash 只活在页面生命周期内，刷新后只剩 localStore 这一份；不写任何状态、只读）。
 *  ★1005 修复（实测反馈"a 的输入框内容串到 b"）：**必须能指定会话**。调用方 ChatInterface 的 watch
 *  是 pre-flush（子组件 prop 尚未更新），此刻 `draftConvId()` 还指着**上一个会话** ⇒ 不传 convId
 *  就会把旧会话的草稿读回来塞进新会话（兜底链的典型危害：静默给错数据、且没有任何报错）。 */
function getSavedDraft(convId?: string): { html: string; items: any[] } | null {
  try {
    const raw = localStore.getItem(draftKeyFor(convId !== undefined ? String(convId) : draftConvId()))
    if (!raw) return null
    const v = JSON.parse(raw)
    return v && typeof v.html === 'string' && v.html ? { html: v.html, items: Array.isArray(v.items) ? v.items : [] } : null
  } catch { return null }
}
/** 草稿归属会话：★1004r 与 props.convId 单源（所在窗口/面板的真实会话）；空=新对话草稿，与 ChatInterface key='' 口径一致 */
function draftConvId(): string {
  return String(props.convId ?? '')
}
function saveDraftNow() {
  const el = editorRef.value
  if (!el) return
  const html = el.innerHTML
  const has = editorHasContent()
  if (!has && !draftDirtyEver) return   // 空且本实例没存过：不动 key（多实例并存防误清别人的草稿）
  if (html === lastSavedDraftHtml) return   // 没变化不重写（也防恢复回环）
  lastSavedDraftHtml = html
  const key = draftKeyFor(draftConvId())
  lastSavedDraftKey = key
  if (!has) {
    draftDirtyEver = false
    try { localStore.removeItem(key) } catch { /* ignore */ }
    return
  }
  draftDirtyEver = true
  try {
    const st = getEditorState()
    localStore.setItem(key, JSON.stringify({ html: st.html, items: st.items, at: Date.now() }))
  } catch (e) { swallowed('草稿没能存住（刷新后这段草稿会丢）—— 不影响当前输入', e) }
}
function scheduleDraftSave() {
  if (draftSaveTimer) clearTimeout(draftSaveTimer)
  draftSaveTimer = setTimeout(() => { draftSaveTimer = null; saveDraftNow() }, 300)   // debounce 300ms
}
/** 卸载/关窗强制 flush：立即落盘 + 写透后端（localStore 侧 unloading 下带 keepalive） */
function onUnloadFlushDraft() {
  if (draftSaveTimer) { clearTimeout(draftSaveTimer); draftSaveTimer = null }
  saveDraftNow()
  try { void localStore.flushNow() } catch { /* ignore */ }
}
function clearDraftPersist(beforeHtml = '') {
  if (draftSaveTimer) { clearTimeout(draftSaveTimer); draftSaveTimer = null }
  lastSavedDraftHtml = ''
  draftDirtyEver = false
  const keys = new Set<string>([draftKeyFor(draftConvId())])
  if (lastSavedDraftKey) keys.add(lastSavedDraftKey)
  lastSavedDraftKey = ''
  /* 草稿首发建会话：发送时 convId 已变，空会话桶（''）可能还留着刚发出去的这份内容 -> 按内容匹配一并清 */
  try {
    const k0 = draftKeyFor('')
    const raw = beforeHtml ? localStore.getItem(k0) : null
    if (raw && beforeHtml && String((JSON.parse(raw) || {}).html || '') === beforeHtml) keys.add(k0)
  } catch { /* ignore */ }
  for (const k of keys) { try { localStore.removeItem(k) } catch { /* ignore */ } }
}
/** 启动恢复：等 localStore 水合（后端 ui-state）后把草稿灌回编辑器（已有内容绝不覆盖、每 key 只恢复一次） */
function restoreDraft() {
  const el = editorRef.value
  if (!el) return
  if ((el.textContent || '').replace(/\u00a0/g, ' ').trim() || el.querySelector('.tag-inline[data-tag-id]')) return
  const key = draftKeyFor(draftConvId())
  const gg = (globalThis as any).__nisDraftRestored || ((globalThis as any).__nisDraftRestored = {})
  if (gg[key]) return
  let raw: string | null = null
  try { raw = localStore.getItem(key) } catch { /* ignore */ }
  if (!raw) return
  try {
    const st = JSON.parse(raw)
    if (!st || typeof st.html !== 'string' || !st.html) return
    el.innerHTML = st.html
    chatStore.setContentItems(Array.isArray(st.items) ? st.items : [])
    lastSavedDraftHtml = el.innerHTML
    lastSavedDraftKey = key
    draftDirtyEver = true
    gg[key] = true
    attachTagEvents()
    reportDraft()
  } catch (e) { swallowed('草稿数据坏了、已忽略（这份草稿等于丢了）—— 不影响当前输入', e) }
}
/* === T3-0928 草稿持久化块结束 ==================================================== */

function reportDraft() {
  emit('draft', editorHasContent())
  scheduleDraftSave()   // T3-0928: any editor DOM change -> debounced draft persist
}

onMounted(() => {
  attachTagEvents()
  // 0914：挂载时补消费——置入发生时编辑器未挂载的场景（预览视图里选元素→置入；主对话输入框彼时被
  // 预览替代），pendingInsert 会挂着等：展开右下角聊天悬浮窗 / 切回对话视图时，本组件重挂即补插标签
  nextTick(() => {
    const p = chatStore.consumeInsert()
    if (p) insertTagAtCursor(p.metadata, p.content)
  })
  document.addEventListener('mousemove', onDocumentMouseMove)
  document.addEventListener('mouseup', onDocumentMouseUp)
  if (editorRef.value) {
    editorObserver = new MutationObserver(() => {
      reportDraft()
      // ★ 0923：任何路径把"正在预览的标签"移出 DOM（发送清空 / 粘贴替换 / 删标签 / 组件换实例）→ 立刻收回
      if (previewTagEl && !previewTagEl.isConnected) hideImagePreview()
    })
    editorObserver.observe(editorRef.value, { childList: true, subtree: true, characterData: true })
  }
  reportDraft()
  // T3-0928: restore persisted draft on startup (retry after localStore hydration)
  restoreDraft()
  onHydratedRestoreOff = onHydrated(() => restoreDraft())
  window.addEventListener('beforeunload', onUnloadFlushDraft)   // T3-0928: force flush
  window.addEventListener('pagehide', onUnloadFlushDraft)
})

onBeforeUnmount(() => {
  document.removeEventListener('mousemove', onDocumentMouseMove)
  document.removeEventListener('mouseup', onDocumentMouseUp)
  editorObserver?.disconnect()
  editorObserver = null
  cleanupDrag()
  onUnloadFlushDraft()   // T3-0928: unmount also force-flushes draft
  onHydratedRestoreOff?.()
  window.removeEventListener('beforeunload', onUnloadFlushDraft)
  window.removeEventListener('pagehide', onUnloadFlushDraft)
})

/* ── 发送 ── */
function getPlainText(): string {
  if (!editorRef.value) return ''
  return (editorRef.value.innerText || '').replace(/\u200B/g, '')   // ★ 0921r：去掉零宽锚点
}

// 从 DOM 提取标签顺序，确保与视觉/输入顺序完全一致
// #8 只选标签 span 本身（.tag-inline）：删除按钮也带 data-tag-id，querySelectorAll 会把一个标签数成两个
function getStructuredContent() {
  if (!editorRef.value) return []
  const domIds = Array.from(editorRef.value.querySelectorAll('.tag-inline[data-tag-id]')).map(t => t.getAttribute('data-tag-id'))
  const tagMap = new Map(
    chatStore.contentItems.filter(i => i.type === 'tag').map(item => [item.id, item])
  )
  return domIds
    .map(id => tagMap.get(id))
    .filter(Boolean)
    .map(item => ({
      type: 'tag',
      content: (item as any).content,
      metadata: (item as any).metadata
    }))
}

function clearEditor() {
  // ★ 0923：清空编辑器 = 图片标签被移出 DOM，浏览器不会补发 mouseleave ⇒ 必须手动收回预览浮层
  //（实测：悬停图片标签看大图时直接点发送，预览图会卡在屏幕上）
  hideImagePreview()
  clearDraftPersist(editorRef.value?.innerHTML || '')   // T3-0928: sent/cleared -> drop persisted draft
  if (editorRef.value) editorRef.value.innerHTML = ''
  chatStore.clearInput()
}

/** 外部置入文本（技能快捷置入等）：光标处插入，并同步 store 文本项 */
function insertText(text: string) {
  if (!text) return
  const escaped = text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  insertHtmlAtCursor(escaped)
  chatStore.addText(text)
}

/* ★ 0925：聚焦编辑器 + 光标落末尾（排队/插话消息"撤回编辑"用 —— 回灌完直接进入可编辑状态）。
 * 单纯 focus 不设光标时，部分浏览器（WebView2）里光标停在组件内默认位置，观感像"没聚焦"。 */
function focusEditor() {
  const ed = editorRef.value
  if (!ed) return
  ed.focus()
  const sel = window.getSelection()
  if (!sel) return
  const r = document.createRange()
  r.selectNodeContents(ed)
  r.collapse(false)
  sel.removeAllRanges()
  sel.addRange(r)
}

/* ── Skill 标签：置入 / 提取 / 从纯文本剔除 ── */
const tagSeq = () => 'skilltag-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6)

/** 外部置入 skill 标签：光标处插入带 data-skill-tag 的标签 span，可点 × 删除 */
function insertSkillTag(skillName: string) {
  if (!editorRef.value || !skillName) return
  const id = tagSeq()
  /* ★1004q（设计口径"改成和图片一样的胶囊形状"）：与 insertTagAtCursor 的 tagHtml 同款胶囊
     （rounded-full/同内边距/同对齐）；行为完全不变（data-skill-tag 语义照旧）。 */
  const html = `<span class="inline-flex items-center gap-0.5 pl-1 pr-0.5 py-px rounded-full text-[11px] font-[530] self-center align-middle bg-indigo-600 text-white hover:bg-indigo-500 cursor-pointer select-none tag-inline"
   data-skill-tag="${skillName}" data-tag-id="${id}" contenteditable="false" draggable="false"><i class="fas fa-wand-magic-sparkles text-[8px] text-gray-300"></i><span class="max-w-[140px] truncate">${skillName}</span>
   <button class="ml-0.5 w-3.5 h-3.5 flex items-center justify-center rounded-full hover:bg-indigo-400 tag-delete-btn" data-tag-id="${id}">
     <i class="fas fa-times text-[6px]"></i></button></span> `
  insertHtmlAtCursor(html)
  attachTagEvents()
}

/** 当前编辑器里的全部 skill 标签名 */
function getSkillTags(): string[] {
  if (!editorRef.value) return []
  return Array.from(editorRef.value.querySelectorAll('[data-skill-tag]')).map(el => el.getAttribute('data-skill-tag') || '').filter(Boolean)
}

/** 置入"文件引用"标签（工作区文件右键"添加到输入框"用）：只带路径、不读内容；
 *  发送时 getPlainTextExcludingSkills 会把标签转成正文里的 `[引用文件：<相对路径>]`，AI 用 fs_read 直接读。
 *  关键：复用图片标签的 insertTagAtCursor 代码路径（同 insertHtmlAtCursor + chatStore.addTag 登记），
 *  保证与图片标签同在一行、同高对齐；仅 tagType/配色不同。 */
function insertFileRef(relPath: string, displayName?: string) {
  if (!editorRef.value || !relPath) return
  const label = displayName || relPath.split('/').pop() || relPath
  insertTagAtCursor({ tagType: 'file', relPath }, label)
}

/** 移除编辑器中指定名称的所有 skill 标签 */
function removeSkillTags(name: string) {
  if (!editorRef.value) return
  const els = editorRef.value.querySelectorAll(`[data-skill-tag="${CSS.escape(name)}"]`)
  for (const el of els) {
    const id = el.getAttribute('data-tag-id')
    if (id) chatStore.removeItem(id)
    el.remove()
  }
}

/**
 * 取纯文本（供发送）：skill 标签剔除；图片标签替换为位置标记 [[图片:N]]（N 为图片在附件中的序号），
 * 这样图片能内联在文字对应位置渲染（如「看看这张图片[[图片:0]]这里有什么？」）。
 * 图片 dataUrl 通过 getImageAttachments() 单独随消息发送；发送到后端前会剔除标记。
 */
function getPlainTextExcludingSkills(): string {
  if (!editorRef.value) return ''
  const clone = editorRef.value.cloneNode(true) as HTMLElement
  clone.querySelectorAll('[data-skill-tag]').forEach(el => el.remove())
  // 文件引用标签 → 正文 token（AI 据此 fs_read；工作区相对路径）
  clone.querySelectorAll('[data-file-ref]').forEach(el => {
    const p = el.getAttribute('data-file-ref') || ''
    el.replaceWith(document.createTextNode(`[引用文件：${p}]`))
  })
  // 0914：元素标签 → 完整结构化 token（画面里是短标签，发给 AI 的必须是完整信息——选择器+坐标+文件，指哪打哪）
  clone.querySelectorAll('.tag-inline[data-tag-id]').forEach(el => {
    const id = el.getAttribute('data-tag-id') || ''
    const item = chatStore.contentItems.find(i => i.id === id)
    if (item?.metadata?.tagType === 'element') {
      el.replaceWith(document.createTextNode(formatElementTagToken(item.metadata)))
    } else if (item?.metadata?.tagType === 'note') {
      /* ★ 0923：便签标签 → 正文 token（标题 + 详情一起带给 AI —— 便签本就是"用户与 AI 共用的待办本"，
         只给标题 AI 看不见上下文；详情可能很长，这里全量带上，由 AI 自己取舍） */
      const title = String(item.metadata.noteTitle || '').trim()
      const detail = String(item.metadata.noteDetail || '').trim()
      el.replaceWith(document.createTextNode(`[便签：${title}${detail ? '｜' + detail : ''}]`))
    }
  })
  let idx = 0
  clone.querySelectorAll('[data-preview]').forEach(el => {
    el.replaceWith(document.createTextNode(`[[图片:${idx}]]`))
    idx++
  })
  // 折叠多余空行
  return (clone.innerText || '').replace(/\u200B/g, '').replace(/\n{3,}/g, '\n\n').trim()   // ★ 0921r：去掉零宽锚点
}

/** #1 按窗口隔离输入：导出编辑器完整状态（HTML + store 标签项） */
function getEditorState() {
  return {
    html: editorRef.value?.innerHTML || '',
    items: JSON.parse(JSON.stringify(chatStore.contentItems)),
  }
}

/** #1 按窗口隔离输入：恢复编辑器状态 */
function setEditorState(state: { html: string; items: any[] } | null | undefined) {
  if (editorRef.value) editorRef.value.innerHTML = (state && state.html) || ''
  chatStore.setContentItems(state && Array.isArray(state.items) ? state.items : [])
  chatStore.setPendingText('')
  nextTick(attachTagEvents)
  lastSavedDraftHtml = (state && state.html) || ''   // T3-0928: window swap resyncs draft baseline
  draftDirtyEver = !!(state && state.html)
  if (draftDirtyEver) scheduleDraftSave()
}

/** 从编辑器提取嵌入的图片标签（拖拽/粘贴图片走的 `insertImageTag` → data-preview 属性）。
 *  先等待未完成的 FileReader（拖图后立刻发送时标签还没插入），再提取，避免图片偶发丢失 */
const pendingImageReads = ref(0)
let pendingImageResolve: (() => void) | null = null
async function getImageAttachments(): Promise<Array<{ name: string; dataUrl: string }>> {
  if (pendingImageReads.value > 0) {
    await new Promise<void>(resolve => { pendingImageResolve = resolve })
  }
  if (!editorRef.value) return []
  const tags = editorRef.value.querySelectorAll('[data-preview]')
  return Array.from(tags).map(el => {
    const name = (el.querySelector('span')?.textContent || 'image').trim()
    const dataUrl = el.getAttribute('data-preview') || ''
    return { name, dataUrl }
  }).filter(a => a.dataUrl)
}

defineExpose({ getPlainText, getStructuredContent, clearEditor, insertText, focusEditor, insertImageTag, insertSkillTag, insertFileRef, getSkillTags, removeSkillTags, getPlainTextExcludingSkills, getSavedDraft, getEditorState, setEditorState, getImageAttachments })
</script>

<template>
  <!-- ★1011v：拖放事件挂在**整个输入区容器**上（原来只挂在下面那个编辑器 div 上 ⇒ 输入框空着时
       只有很矮一条能接住文件，实测反馈"拖入文件到输入框的范围太小"）。事件从子元素冒泡上来，
       所以编辑器里不再重复绑一份。 -->
  <div
    class="px-4 py-3 cursor-text relative transition-all"
    :class="{ 'opacity-50 pointer-events-none': disabled }"
    @click="handleContainerClick"
    @dragenter="handleFileDragEnter"
    @dragover.prevent="handleFileDragOver"
    @dragleave="handleFileDragLeave"
    @drop.prevent="handleFileDrop"
  >
    <!-- ★1011w：拖入提示已上移到"输入区外壳"（见 ChatInterface 的 .input-shell）——
         原来这一层只覆盖编辑器那一小块，看着像"拖入热区很小"，其实整片都能接住文件。 -->
    <div
      ref="editorRef"
      :contenteditable="!disabled"
      :data-placeholder="disabled ? t('chat.pendingInteract') : t('chat.inputPlaceholder')"
      class="chat-editor outline-none text-[14px] min-h-[40px] max-h-[200px] overflow-y-auto leading-6 break-words empty:before:content-[attr(data-placeholder)] empty:before:text-gray-400"
      @keydown="handleKeydown"
      @input="onEditorInput"
      @keyup="saveCursorPosition"
      @mouseup="saveCursorPosition"
      @click="handleEditorClick"
      @paste="handlePaste"
      @copy="onCopy"
      @cut="onCopy"
    ></div>

    <!-- 图片标签悬停预览大图 -->
    <div
      v-if="imagePreview"
      class="fixed z-[9999] pointer-events-none"
      :style="previewStyle()"
    >
      <img
        :src="imagePreview.src"
        class="border-4 border-white rounded-lg shadow-2xl bg-white"
        style="width: 100%; height: 100%; object-fit: contain;"
      />
    </div>

    <!-- 点击图片标签 → 全屏查看（缩放/拖动） -->
    <ImageViewer :src="fullImgSrc" @close="fullImgSrc = null" />
  </div>
</template>

<style scoped>
[contenteditable] {
  user-select: text;
  -webkit-user-select: text;
  overflow-wrap: break-word;
  white-space: pre-wrap;
}
.tag-inline {
  margin: 0 1px;
  /* 防御：编辑器行若是 flex 块（Chrome 自动样式，align-items:stretch），
     标签作为 flex item 默认被拉满行高 → 与同行内容错位。居中且不收缩、不放大。 */
  align-self: center;
  flex-shrink: 0;
  vertical-align: middle;
}
</style>
