<script setup lang="ts">
/**
 * 预览 tab 内容区：渲染当前激活的预览 tab
 *  - browser: iframe 加载 URL
 *  - image/file/html: open-file-viewer core createViewer（PDF/Office/图片/文本/音视频）
 *  - released: 显示占位，点击重新加载（内存释放第二步）
 */
import { computed, ref, onMounted, onUnmounted, watch, nextTick } from 'vue'
import {
  createViewer,
  imagePlugin,
  videoPlugin,
  audioPlugin,
  textPlugin,
  pdfPlugin,
  officePlugin,
  archivePlugin,
  fallbackPlugin,
} from '@open-file-viewer/core'
import type { FileViewer } from '@open-file-viewer/core'
import '@open-file-viewer/core/style.css'
import pdfWorkerSrc from 'pdfjs-dist/build/pdf.worker.mjs?url'
import { usePreviewTabsStore } from '@/stores/previewTabs'
import { useConversationsStore } from '@/stores/conversations'
import { useChatStore } from '@/stores/chat'
import { useNotificationsStore } from '@/stores/notifications'
import { t } from '@/utils/i18n'
import { Wrench, Crosshair, MousePointer2 } from 'lucide-vue-next'
import { useFloatPos } from '@/composables/useFloatPos'
import { getPickToolOf, setPickToolOf } from '@/composables/usePickToolState'
import { shortSelectorLabel } from '@/utils/elementTag'

const previewTabs = usePreviewTabsStore()
const conversationsStore = useConversationsStore()
const chatStore = useChatStore()
const notificationsStore = useNotificationsStore()

const convId = computed(() => String(conversationsStore.activeConversationId ?? ''))
const activeTab = computed(() => {
  const id = previewTabs.activeTabId(convId.value)
  if (!id) return null
  return previewTabs.tabsFor(convId.value).find(t => t.id === id) || null
})

function revive() {
  if (activeTab.value) previewTabs.revive(convId.value, activeTab.value.id)
}

/* ── 实测容器高度：createViewer 需要具体像素高度，否则白屏 ── */
const viewerWrapRef = ref<HTMLElement | null>(null)
const viewerHeight = ref(400)
let resizeObserver: ResizeObserver | null = null

function measureHeight() {
  if (viewerWrapRef.value) {
    const h = viewerWrapRef.value.clientHeight
    if (h > 0) viewerHeight.value = h
  }
}

onMounted(() => {
  measureHeight()
  resizeObserver = new ResizeObserver(measureHeight)
  if (viewerWrapRef.value) resizeObserver.observe(viewerWrapRef.value)
})
onUnmounted(() => {
  resizeObserver?.disconnect()
  resizeObserver = null
  destroyViewer()
})

/* open-file-viewer 插件列表（按需加载，未用格式不占体积） */
const plugins = [
  imagePlugin(),
  videoPlugin(),
  audioPlugin(),
  textPlugin(),
  pdfPlugin({ workerSrc: pdfWorkerSrc }),
  officePlugin(),
  archivePlugin(),
  fallbackPlugin(),
]

/** 构建 file 源：File/Blob 优先，其次 dataURL/内容转 Blob */
function viewerSource(): File | Blob | string | undefined {
  const tab = activeTab.value
  if (!tab) return undefined
  if (tab.file) return tab.file
  if (tab.kind === 'image' && tab.dataUrl) return tab.dataUrl
  if (tab.content) {
    return new Blob([tab.content], { type: tab.mimeType || 'text/html' })
  }
  return undefined
}

/** 文件名（按扩展名识别格式） */
function viewerFileName(): string {
  const tab = activeTab.value
  if (!tab) return ''
  if (!/\.[a-z0-9]+$/i.test(tab.title)) {
    switch (tab.kind) {
      case 'image': return tab.title + '.png'
      case 'html': return tab.title + '.html'
      case 'file': return tab.title + '.txt'
    }
  }
  return tab.title
}

/** HTML 前端页面：支持「页面/代码」切换 */
const isHtmlTab = computed(() => activeTab.value?.kind === 'html' && !!activeTab.value?.content)
const viewMode = computed<'page' | 'code'>(() => activeTab.value?.viewMode || 'page')

/** HTML 页面模式走工作区静态代理（iframe src）：相对 css/js/图片按真实路径加载——
 *  srcdoc 里 <link href="css/x.css"> 无法解析，页面裸奔无样式（0901 反馈 #6 根因）。
 *  只有 tab.srcPath 显式声明的「工作区文件」才走代理（工作区面板/产物卡发起）；
 *  拖入文件（0914 起）先经 fs.importExternalFile 入库到工作区「外部文件/」，srcPath 指向真实副本 → 走代理；
 *  入库失败或消息内预览没有工作区路径时回退 srcdoc——按 key 猜路径会把代理指向不存在的文件报 ENOENT（0901 反馈 #3 根因）。
 *
 *  0914（元素拾取修复）：改用**同源相对路径** `/api/workspace-file?...`（vite dev 已配 /api → 8766 代理）。
 *  此前用后端绝对地址（127.0.0.1:8766）→ iframe 与父页跨源 → contentDocument 不可访问，
 *  「选择元素」拾取直接失败（用户实测：工作区 HTML 预览无法使用元素工具）。
 *  相对路径在 dev 走 vite 代理、打包后走同源后端，两个环境均为同源。 */
const htmlProxySrc = computed(() => {
  const tab = activeTab.value
  if (!tab) return ''
  const relPath = String((tab as any).srcPath || '')
  if (!relPath) return ''
  return `/api/workspace-file?sessionId=${encodeURIComponent(convId.value)}&path=${encodeURIComponent(relPath)}`
})

function setViewMode(mode: 'page' | 'code') {
  if (activeTab.value) activeTab.value.viewMode = mode
}

/* ── createViewer 生命周期 ── */
let viewer: FileViewer | null = null
const viewerError = ref('')

function destroyViewer() {
  try {
    viewer?.destroy()
  } catch (e) {
    console.warn('[PreviewTabContent] destroy error:', e)
  }
  viewer = null
}

/** Office 文档（docx/xlsx/pptx）用 fit:width 适配容器宽度，避免窄排/竖排 */
function isOfficeDoc(name: string): boolean {
  return /\.(docx?|xlsx?|pptx?|odt|ods|odp)$/i.test(name)
}

async function mountViewer() {
  await nextTick()
  destroyViewer()
  viewerError.value = ''
  const wrap = viewerWrapRef.value
  if (!wrap) return
  const source = viewerSource()
  if (!source) return
  try {
    viewer = createViewer({
      container: wrap,
      file: source,
      fileName: viewerFileName(),
      width: '100%',
      height: viewerHeight.value,
      fit: isOfficeDoc(viewerFileName()) ? 'width' : 'contain',
      plugins,
      toolbar: true,
      theme: 'light',
      fallback: 'inline',
    })
    viewer.resize()
  } catch (e) {
    viewerError.value = e instanceof Error ? e.message : String(e)
    console.error('[PreviewTabContent] createViewer error:', e)
  }
}

// 切换 tab / 源 / 高度变化时重建 viewer
watch(
  () => [activeTab.value?.id, activeTab.value?.released, viewerHeight.value],
  async () => {
    await nextTick()
    if (activeTab.value && !activeTab.value.released) mountViewer()
    else destroyViewer()
  },
  { immediate: true },
)

/* ── 0914：预览工具栏（选择元素 / 指针）──
 * 「工具栏」按钮（右下角）→ 向上弹胶囊：选择元素 / 指针。
 * 选择元素：像 F12 一样在同源预览 iframe 内悬停高亮 → 点击选中 → 「置入 / 取消」；
 * 置入 = 元素信息（tag + 精确选择器 + 文件内坐标 + 来源文件）作为「元素标签」进输入框
 * （chatStore.requestInsertTag → ChatInput 消费为 .tag-inline 胶囊；发送时由 getPlainText 翻译成结构化文本）。 */
const htmlFrameRef = ref<HTMLIFrameElement | null>(null)
const toolbarOpen = ref(false)
type PickTool = 'pointer' | 'select'
// 0914：工具档位按会话隔离（各自对话管各自的；切换界面/重挂载不丢、不串台）
const pickTool = ref<PickTool>(getPickToolOf(convId.value))

interface PickedElInfo {
  tagName: string
  selector: string
  /** 文件内坐标（文档坐标系：视口坐标 + iframe 滚动） */
  rect: { x: number; y: number; w: number; h: number }
  /** 父页视口坐标（「置入/取消」按钮定位用） */
  view: { left: number; top: number; w: number; h: number }
}
const pickedEl = ref<PickedElInfo | null>(null)
const pickSupported = computed(() => isHtmlTab.value && viewMode.value === 'page')

let pickDoc: Document | null = null
let pickOverlay: HTMLElement | null = null
let pickTip: HTMLElement | null = null

function clearPickArtifacts() {
  try { pickOverlay?.remove(); pickTip?.remove() } catch { /* ignore */ }
  pickOverlay = null
  pickTip = null
  if (pickDoc) {
    try {
      pickDoc.removeEventListener('mousemove', onPickMove, true)
      pickDoc.removeEventListener('click', onPickClick, true)
      pickDoc.documentElement.style.cursor = ''
    } catch { /* ignore */ }
  }
  pickDoc = null
}

function frameDocument(): Document | null {
  try {
    const d = htmlFrameRef.value?.contentDocument || null
    if (d && d.body) return d
  } catch { /* 跨源 → null */ }
  return null
}

/** 生成精确选择器（优先 id；逐级 tag + class + nth-of-type，最多 5 级） */
function cssPath(el: Element): string {
  if ((el as HTMLElement).id) return '#' + (el as HTMLElement).id
  const parts: string[] = []
  let node: Element | null = el
  while (node && node.nodeType === 1 && parts.length < 5) {
    let sel = node.tagName.toLowerCase()
    const cls = Array.from(node.classList || []).filter(c => c.length <= 24).slice(0, 2)
    if (cls.length) sel += '.' + cls.join('.')
    const parent = node.parentElement
    if (parent) {
      const same = Array.from(parent.children).filter(c => c.tagName === node!.tagName)
      if (same.length > 1) sel += `:nth-of-type(${same.indexOf(node) + 1})`
    }
    parts.unshift(sel)
    node = parent
  }
  return parts.join(' > ')
}

function onPickMove(e: MouseEvent) {
  if (!pickOverlay || !pickTip) return
  const tgt = e.target as HTMLElement | null
  if (!tgt || tgt.nodeType !== 1 || (tgt.hasAttribute && tgt.hasAttribute('data-nis-pick'))) return
  const r = tgt.getBoundingClientRect()
  pickOverlay.style.transform = `translate(${r.left}px, ${r.top}px)`
  pickOverlay.style.width = r.width + 'px'
  pickOverlay.style.height = r.height + 'px'
  pickTip.textContent = `${tgt.tagName.toLowerCase()} · ${Math.round(r.width)}×${Math.round(r.height)}`
  pickTip.style.transform = `translate(${Math.max(0, r.left)}px, ${Math.max(0, r.top - 24)}px)`
}

function onPickClick(e: MouseEvent) {
  e.preventDefault()
  e.stopPropagation()
  const frame = htmlFrameRef.value
  const tgt = e.target as HTMLElement | null
  if (!frame || !tgt || tgt.nodeType !== 1) return
  const win = pickDoc?.defaultView
  const r = tgt.getBoundingClientRect()
  const frameRect = frame.getBoundingClientRect()
  pickedEl.value = {
    tagName: tgt.tagName.toLowerCase(),
    selector: cssPath(tgt),
    rect: {
      x: Math.round(r.left + (win?.scrollX || 0)),
      y: Math.round(r.top + (win?.scrollY || 0)),
      w: Math.round(r.width),
      h: Math.round(r.height),
    },
    view: { left: frameRect.left + r.left, top: frameRect.top + r.top, w: r.width, h: r.height },
  }
}

function setPick(tool: PickTool) {
  pickTool.value = tool
  setPickToolOf(convId.value, tool)
}

/** 附着 overlay + 监听（纯附着，状态由调用方管）。返回是否成功（跨源/未就绪 → false） */
function attachPickOverlay(): boolean {
  clearPickArtifacts()
  const doc = frameDocument()
  if (!doc) return false
  const overlay = doc.createElement('div')
  overlay.setAttribute('data-nis-pick', '1')
  overlay.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;pointer-events:none;z-index:2147483646;border:2px solid #3b82f6;background:rgba(59,130,246,0.10);border-radius:3px;'
  const tip = doc.createElement('div')
  tip.setAttribute('data-nis-pick', '1')
  tip.style.cssText = 'position:fixed;left:0;top:0;pointer-events:none;z-index:2147483647;background:#111827;color:#fff;font:11px/1.5 ui-monospace,Consolas,monospace;padding:1px 6px;border-radius:4px;white-space:nowrap;'
  doc.body.appendChild(overlay)
  doc.body.appendChild(tip)
  pickOverlay = overlay
  pickTip = tip
  pickDoc = doc
  doc.addEventListener('mousemove', onPickMove, true)
  doc.addEventListener('click', onPickClick, true)
  doc.documentElement.style.cursor = 'crosshair'
  return true
}

function enterSelectMode() {
  if (!pickSupported.value) {
    notificationsStore.push({ level: 'warning', content: t('ptab.pickUnsupported'), type: 'system' })
    return
  }
  setPick('select')
  pickedEl.value = null
  if (!attachPickOverlay()) {
    notificationsStore.push({ level: 'warning', content: t('ptab.pickCrossOrigin'), type: 'system' })
    setPick('pointer')
  }
}

function exitSelectMode() {
  clearPickArtifacts()
  setPick('pointer')
  pickedEl.value = null
}

/** 把「选择元素」状态同步到当前 tab/文档：能挂就挂；iframe 未就绪则等 load 补挂。
 *  用于：切 tab / 切会话 / 重挂载恢复（0914：状态跨视图保留、各自对话管各自的）。 */
function syncPickToTab() {
  pickedEl.value = null
  clearPickArtifacts()
  if (pickTool.value !== 'select' || !pickSupported.value) return
  if (!attachPickOverlay()) {
    nextTick(() => {
      const f = htmlFrameRef.value
      if (f && !(f as any)._nisPickLoadBound) {
        (f as any)._nisPickLoadBound = true
        f.addEventListener('load', () => {
          if (pickTool.value === 'select' && pickSupported.value && !pickDoc) attachPickOverlay()
        })
      }
    })
  }
}

/** 置入：元素信息以「标签」形式加进输入框（requestInsertTag → ChatInput 消费为胶囊）。
 *  0914：① 画面显示短标签（~20 字符），完整信息走 metadata → 发送时转结构化 token（指哪打哪）；
 *  ② 置入后保持「选择元素」模式（非一次性）——置入条收起、overlay 继续，直接可拾下一个。 */
function pickInsert() {
  const p = pickedEl.value
  if (!p) return
  const tabRef: any = activeTab.value
  chatStore.requestInsertTag(shortSelectorLabel(p.selector || p.tagName, p.tagName), {
    tagType: 'element',
    tagName: p.tagName,
    selector: p.selector,
    rect: p.rect,
    fileName: tabRef?.title || '',
    // 工作区文件预览时带相对路径（「指哪打哪」：AI 可据路径直接去改对应文件）
    filePath: String(tabRef?.srcPath || ''),
  })
  pickedEl.value = null
  notificationsStore.push({ level: 'success', content: t('ptab.pickInserted'), type: 'system' })
}

/** 取消：只收起「置入/取消」条，保持选择模式（继续可拾取） */
function pickCancel() {
  pickedEl.value = null
}

// 切 tab / 切「页面·代码」/ 切会话：把「选择元素」状态同步到新文档（保持模式重新附着；
// iframe 未就绪由 load 补挂）。0914：不再退出——状态按会话保留、跨视图不丢、不串台。
watch(
  () => [activeTab.value?.id, viewMode.value] as const,
  async () => {
    await nextTick()
    syncPickToTab()
  },
)
watch(convId, async () => {
  pickTool.value = getPickToolOf(convId.value)
  await nextTick()
  syncPickToTab()
})
// 重挂载恢复（跨视图切换：浏览器/办公室回来）；卸载只清 overlay，不清状态
onMounted(() => {
  if (pickTool.value === 'select') nextTick(() => syncPickToTab())
  startProxyMeta()
})
onUnmounted(() => clearPickArtifacts())
onUnmounted(() => stopProxyMeta())

/* ── 0914 精准打击②：「AI/外部改文件 → 预览自动刷新」（代理 html 标签） ──
 *  背景：wb_preview_file 的既定口径是「写完文件不主动开预览」，代理模式 iframe 也不会因文件变化自动重载
 *  → 用户盯着预览时看不到 AI 的修改。这里对【激活中的代理 html 标签】做 mtime 轮询：
 *  文件变了 → 拉新内容进 tab（代码视图同步；content 变化触发的 watch 重载页面）→ 都拿不到才直接刷页面。
 *  仅页面可见时轮询（隐藏时跳过、回可见自愈）；旧后端（无 fs.statFile）自动放弃不报错。 */
let proxyMetaTimer: number | null = null
let proxyMetaMtime = 0
let proxyMetaGen = 0
function stopProxyMeta() {
  proxyMetaGen++
  if (proxyMetaTimer != null) { clearInterval(proxyMetaTimer); proxyMetaTimer = null }
  proxyMetaMtime = 0
}
function startProxyMeta() {
  stopProxyMeta()
  const tab = activeTab.value
  if (!tab || tab.kind !== 'html' || !tab.srcPath || !htmlProxySrc.value) return
  const gen = proxyMetaGen
  void (async () => {
    try {
      const r = await chatStore.bridgeRpc('fs.statFile', { sessionId: convId.value, path: tab.srcPath })
      if (typeof r?.mtimeMs !== 'number') return          // 旧后端/不可用 → 不轮询
      if (gen !== proxyMetaGen) return                    // 等待期间 stop/restart/卸载 → 放弃
      proxyMetaMtime = r.mtimeMs
      if (proxyMetaTimer == null) proxyMetaTimer = window.setInterval(() => { void checkProxyMeta() }, 2000)
    } catch { /* 忽略 */ }
  })()
}
async function checkProxyMeta() {
  const tab = activeTab.value
  if (!tab || tab.kind !== 'html' || !tab.srcPath || !htmlProxySrc.value) { stopProxyMeta(); return }
  if (document.visibilityState !== 'visible') return
  const gen = proxyMetaGen
  try {
    const r = await chatStore.bridgeRpc('fs.statFile', { sessionId: convId.value, path: tab.srcPath })
    if (gen !== proxyMetaGen) return                      // 期间切了 tab / 卸载 → 本拍作废
    const m = Number(r?.mtimeMs || 0)
    if (!m || m <= proxyMetaMtime) return
    proxyMetaMtime = m
    // 拉新内容进 tab（代码视图同步）；拿不到/被截断 → 落回直接刷页面
    try {
      const rd = await chatStore.bridgeRpc('fs.readFile', { sessionId: convId.value, path: tab.srcPath, maxChars: 6000000 })
      if (gen !== proxyMetaGen) return
      if (rd && typeof rd.content === 'string' && !rd.truncated) { tab.content = rd.content; return }
    } catch { /* 继续兜底 */ }
    reloadProxyFrame(tab.id)
  } catch { /* 网络/后端异常忽略，下一拍重试 */ }
}
/** 代理 iframe 就地重载（同源）。reload 会清掉 iframe 内 overlay → 选择模式开着时 load 后补挂。 */
function reloadProxyFrame(expectedTabId?: string) {
  if (expectedTabId && activeTab.value?.id !== expectedTabId) return
  if (!htmlProxySrc.value || viewMode.value !== 'page') return
  const f = htmlFrameRef.value
  if (!f) return
  try { f.contentWindow?.location?.reload() } catch { return }
  if (pickTool.value === 'select') {
    const onLoad = () => {
      f.removeEventListener('load', onLoad)
      if (pickTool.value === 'select' && pickSupported.value) attachPickOverlay()
    }
    f.addEventListener('load', onLoad)
  }
}
// 同一 tab 的 content 更新（AI 重开预览 / mtime 轮询写入）→ 重载代理 iframe；切 tab 交由 iframe 自身换源
let prevMetaTabId = ''
let prevMetaContent: string | undefined
watch(
  () => [activeTab.value?.id, activeTab.value?.content] as const,
  ([id, c]) => {
    const sameTab = !!id && id === prevMetaTabId
    const changed = c !== prevMetaContent
    prevMetaTabId = id || ''
    prevMetaContent = c
    if (sameTab && changed && c != null) reloadProxyFrame()
  },
  { immediate: true }, // 先记基线（首帧不触发重载）；否则「挂载后第一次内容更新」会被误判为切 tab 而漏刷
)
// 激活 tab 切换（含新开/关 tab）→ 重启轮询；内容变化不重启（保留已记录的 mtime）
watch(() => [activeTab.value?.id, activeTab.value?.srcPath] as const, () => startProxyMeta())

/* ── 0914：工具箱自由定位（拖动 + 视口夹取 + 持久化 + 双击复位；与聊天球各拖各的） ── */
const float = useFloatPos({
  storageKey: 'nis.ui.previewTools.pos',
  size: { w: 48, h: 48 },
  // 默认位：贴右下、聊天球正上方同列（right:20 / bottom:84 —— 留出身位，别和聊天球贴脸）
  defaultPos: (vw, vh) => ({ x: vw - 20 - 48, y: vh - 84 - 48 }),
  /* ★1011c：与聊天球互相避让（历史保存位置可能让两球叠一起） */
  avoidKey: 'nis.ui.chatBall.pos',
})
/** 贴顶判定：上方放不下展开胶囊（约 104px）→ 翻转为从下方展开（fab 锚点不动） */
const flipStack = computed(() => float.pos.value.y < 112)
const dockStyle = computed(() => {
  const vhCss = float.viewport.value.h / float.zoom.value
  if (flipStack.value) return { left: float.pos.value.x + 'px', top: float.pos.value.y + 'px' }
  return { left: float.pos.value.x + 'px', bottom: (vhCss - float.pos.value.y - 48) + 'px' }
})
function onFabClick() {
  if (float.consumeDragClick()) return
  toolbarOpen.value = !toolbarOpen.value
}
</script>

<template>
  <div v-if="activeTab" class="preview-content">
    <!-- 已释放占位：点击重新加载 -->
    <div v-if="activeTab.released" class="preview-released" @click="revive">
      <i class="fas fa-power-off"></i>
      <p>{{ t('ptab.released') }}</p>
      <span>{{ t('ptab.reloadClick') }}</span>
    </div>

    <!-- HTML 前端页面：页面/代码切换 -->
    <div v-else-if="isHtmlTab" class="preview-html">
      <div class="preview-html-toggle">
        <button
          type="button"
          :class="['preview-html-btn', { 'preview-html-btn-active': viewMode === 'page' }]"
          @click="setViewMode('page')"
        >{{ t('ptab.page') }}</button>
        <button
          type="button"
          :class="['preview-html-btn', { 'preview-html-btn-active': viewMode === 'code' }]"
          @click="setViewMode('code')"
        >{{ t('ptab.code') }}</button>
      </div>
      <iframe
        v-if="viewMode === 'page'"
        ref="htmlFrameRef"
        :src="htmlProxySrc || undefined"
        :srcdoc="htmlProxySrc ? undefined : activeTab.content"
        class="preview-frame"
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
      ></iframe>
      <pre v-else class="preview-code">{{ activeTab.content }}</pre>
    </div>

    <!-- 网页预览：仍用 iframe -->
    <iframe
      v-else-if="activeTab.kind === 'browser'"
      :src="activeTab.src"
      class="preview-frame"
      sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
    ></iframe>

    <!-- 其他格式：createViewer 挂载点 -->
    <div v-else-if="viewerSource()" ref="viewerWrapRef" class="preview-viewer"></div>

    <!-- 无可预览内容 -->
    <div v-else class="preview-empty">
      <i class="fas fa-file-circle-exclamation"></i>
      <p>{{ t('ptab.noPreview') }}</p>
    </div>

    <!-- 0914：预览工具栏（与聊天悬浮球同级的 fixed 悬浮组；展开=与工具箱一体的常驻胶囊，仅图标） -->
    <div class="preview-toolbar-dock" :style="dockStyle">
      <div class="ptool-stack" :class="{ 'is-open': toolbarOpen, 'is-flip': flipStack }">
        <div class="ptool-tools">
          <button
            type="button"
            class="ptool-tool"
            :class="{ 'is-active': pickTool === 'select' }"
            :title="t('ptab.toolSelect')"
            @click="pickTool === 'select' ? exitSelectMode() : enterSelectMode()"
          >
            <Crosshair :size="18" :stroke-width="1.75" />
          </button>
          <button
            type="button"
            class="ptool-tool"
            :class="{ 'is-active': pickTool === 'pointer' }"
            :title="t('ptab.toolPointer')"
            @click="exitSelectMode()"
          >
            <MousePointer2 :size="18" :stroke-width="1.75" />
          </button>
        </div>
        <button
          type="button"
          class="ptool-fab"
          :class="{ 'is-on': pickTool === 'select' }"
          :title="t('ptab.toolbar')"
          @click="onFabClick"
          @dblclick="float.reset()"
          @pointerdown="float.startDrag"
        >
          <Wrench :size="20" :stroke-width="1.75" />
        </button>
      </div>
    </div>

    <!-- 选中元素后的「置入 / 取消」（贴在被选元素下方；fixed 视口坐标） -->
    <div
      v-if="pickedEl"
      class="pick-confirm"
      :style="{ left: pickedEl.view.left + 'px', top: (pickedEl.view.top + pickedEl.view.h + 8) + 'px' }"
    >
      <span class="pick-confirm-label">{{ pickedEl.tagName }}{{ pickedEl.selector ? ' · ' + pickedEl.selector : '' }}</span>
      <button type="button" class="pick-btn is-primary" @click="pickInsert">{{ t('ptab.pickInsert') }}</button>
      <button type="button" class="pick-btn" @click="pickCancel">{{ t('ptab.pickCancel') }}</button>
    </div>
  </div>
</template>

<style scoped>
.preview-content {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: #ffffff;
  position: relative; /* 0914：工具栏 dock 的绝对定位锚点 */
}

/* HTML 页面/代码切换 */
.preview-html {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  position: relative;
}
.preview-html-toggle {
  position: absolute;
  top: 8px;
  right: 8px;
  z-index: 10;
  display: flex;
  gap: 2px;
  background: rgba(255, 255, 255, 0.9);
  border: 1px solid rgba(0, 0, 0, 0.08);
  border-radius: 9999px;
  padding: 2px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
}
.preview-html-btn {
  padding: 3px 12px;
  font-size: 11px;
  color: #6b7280;
  border: none;
  border-radius: 9999px;
  background: transparent;
  cursor: pointer;
  transition: all 0.15s ease;
}
.preview-html-btn:hover {
  color: #111827;
}
.preview-html-btn-active {
  background: #111827;
  color: #ffffff;
}
.preview-html-btn-active:hover {
  color: #ffffff;
}
.preview-code {
  flex: 1;
  min-height: 0;
  margin: 0;
  padding: 12px 16px;
  overflow: auto;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  line-height: 1.6;
  color: #1f2937;
  background: #f9fafb;
  white-space: pre-wrap;
  word-break: break-all;
}

.preview-frame {
  flex: 1;
  width: 100%;
  border: none;
  background: #ffffff;
}

.preview-viewer {
  flex: 1;
  min-height: 0;
  width: 100%;
  overflow: hidden;
  position: relative;
}

.preview-released {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: #9ca3af;
  cursor: pointer;
  background: #f9fafb;
}
.preview-released i {
  font-size: 24px;
  color: #d1d5db;
}
.preview-released p {
  font-size: 13px;
  color: #6b7280;
  margin: 0;
}
.preview-released span {
  font-size: 11px;
  color: #9ca3af;
  text-decoration: underline;
}

.preview-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: #9ca3af;
  background: #f9fafb;
}
.preview-empty i {
  font-size: 28px;
  color: #d1d5db;
}
.preview-empty p {
  font-size: 13px;
  color: #6b7280;
  margin: 0;
}

/* ── 0914：预览工具栏（与聊天悬浮球同级的 fixed 悬浮组；展开=常驻一体胶囊、仅图标）── */
.preview-toolbar-dock {
  position: fixed;
  /* 0914：位置由 dockStyle 动态给（left+top 或 left+bottom；拖动时夹取视口内、默认位=聊天球正上方） */
  z-index: 59;
  display: flex;
  flex-direction: column;
  align-items: center;
}
/* 0914：贴顶翻转——上方放不下胶囊时从下方展开（fab 锚点不动） */
.ptool-stack.is-flip {
  flex-direction: column-reverse;
}
.ptool-stack {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  /* 折叠态：padding 0 + 透明边框——保证工具球右缘与聊天球精确同线（偏移仅 1px 边框） */
  padding: 0;
  border-radius: 9999px;
  background: transparent;
  border: 1px solid transparent;
  transition: background 0.18s ease, border-color 0.18s ease, box-shadow 0.18s ease, padding 0.18s ease;
}
.ptool-stack.is-open {
  background: #ffffff;
  border-color: rgba(0, 0, 0, 0.08);
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.16);
  padding: 6px;
}
.ptool-tools {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 0;
  opacity: 0;
  overflow: hidden;
  transition: max-height 0.22s ease, opacity 0.16s ease;
}
.ptool-stack.is-open .ptool-tools {
  max-height: 96px;
  opacity: 1;
}
.ptool-tool {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  color: #374151;
  border: none;
  cursor: pointer;
  transition: background 0.12s ease, color 0.12s ease;
}
.ptool-tool:hover { background: #f3f4f6; }
.ptool-tool.is-active { background: #111827; color: #ffffff; }
.ptool-tool.is-active:hover { background: #1f2937; }
.ptool-fab {
  width: 48px;
  height: 48px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #111827;
  color: #fff;
  border: none;
  cursor: pointer;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.25);
  transition: transform 0.15s ease, background 0.15s ease;
}
.ptool-fab:hover { transform: translateY(-1px); background: #1f2937; }
.ptool-fab.is-on { background: #2563eb; }

/* 选中元素确认条（fixed 视口坐标） */
.pick-confirm {
  position: fixed;
  z-index: 2147483000;
  display: flex;
  align-items: center;
  gap: 6px;
  background: #111827;
  color: #fff;
  border-radius: 10px;
  padding: 5px 6px 5px 10px;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.3);
}
.pick-confirm-label {
  font-size: 11px;
  font-family: ui-monospace, Consolas, monospace;
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: rgba(255, 255, 255, 0.85);
}
.pick-btn {
  padding: 4px 12px;
  border: none;
  border-radius: 7px;
  font-size: 12px;
  cursor: pointer;
  background: rgba(255, 255, 255, 0.16);
  color: #fff;
  transition: background 0.12s ease;
}
.pick-btn:hover { background: rgba(255, 255, 255, 0.26); }
.pick-btn.is-primary { background: #ffffff; color: #111827; font-weight: 530; }
.pick-btn.is-primary:hover { background: #f1f5ff; }
</style>
