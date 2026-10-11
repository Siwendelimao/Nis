<script setup lang="ts">
/**
 * ProducedFilesRow —— turn 尾部产出物卡片行（dsh TurnTail 语义）
 * 每产物一个卡片：文件类型图标 + 文件名 + 三按钮（预览 / 打开所在目录 / 浏览器打开）
 * 预览弹窗：复用 open-file-viewer createViewer（与对话 tab 预览同引擎，全格式）
 * 「进入预览」→ 打开对话的预览 tab（PreviewTabBar/PreviewTabContent）
 */
import { ref, computed, onBeforeUnmount, nextTick } from 'vue'
import { createViewer, imagePlugin, videoPlugin, audioPlugin, textPlugin, pdfPlugin, officePlugin, archivePlugin, fallbackPlugin } from '@open-file-viewer/core'
import type { FileViewer } from '@open-file-viewer/core'
import pdfWorkerSrc from 'pdfjs-dist/build/pdf.worker.mjs?url'
import { useChatStore } from '@/stores/chat'
import { usePreviewTabsStore } from '@/stores/previewTabs'
import { t } from '@/utils/i18n'

const props = defineProps<{ convId: string; files: Array<{ path: string; size?: number }> }>()

const chatStore = useChatStore()
const previewTabs = usePreviewTabsStore()

/* ── 折叠（0920 需求要求）：产物超过 3 个先收起来，可展开、可再折回去 ──
   一轮里刷出十几张卡片时，整条回复被压得很长，滚动成本高。
   ★ 展开时**只给新露出来的那几张**加入场动画（justExpanded 短暂置位），
     不是每张卡都animate —— 否则历史会话一次挂载几十张卡会一起闪。 */
const COLLAPSE_LIMIT = 3
const expanded = ref(false)
const justExpanded = ref(false)
let expandTimer: number | null = null

const visibleFiles = computed(() =>
  props.files.length > COLLAPSE_LIMIT && !expanded.value
    ? props.files.slice(0, COLLAPSE_LIMIT)
    : props.files,
)

function toggleExpand(): void {
  expanded.value = !expanded.value
  if (expandTimer !== null) { window.clearTimeout(expandTimer); expandTimer = null }
  if (expanded.value) {
    justExpanded.value = true
    expandTimer = window.setTimeout(() => { justExpanded.value = false; expandTimer = null }, 400)
  } else {
    justExpanded.value = false
  }
}

onBeforeUnmount(() => { if (expandTimer !== null) window.clearTimeout(expandTimer) })

/* ★0930 反馈"产出物悬停就变黄，很奇怪"：悬停触发的双向高亮整个摘除——
 * 高亮只保留「点击右侧栏文件变更条目」这一个入口（WorkspacePanel.highlightFileEverywhere）。
 * （原 0904 双向高亮的悬停半边 + 0920 合成 hover 防抖机器随之退役。） */

function basename(p: string): string {  const at = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return at === -1 ? p : p.slice(at + 1)
}

function extOf(p: string): string {
  const name = basename(p)
  const dot = name.lastIndexOf('.')
  return dot === -1 ? '' : name.slice(dot).toLowerCase()
}

/** 字节数 → 可读大小（B/KB/MB） */
function formatSize(bytes?: number): string {
  if (bytes == null) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/* ── 文件类型图标（扩展名 → 图标 + 主题色） ── */
const fileIconMap: Array<{ exts: string[]; icon: string; color: string }> = [
  { exts: ['.html', '.htm'], icon: 'fab fa-html5', color: 'text-orange-500' },
  { exts: ['.css'], icon: 'fab fa-css3-alt', color: 'text-blue-500' },
  { exts: ['.js', '.mjs', '.cjs'], icon: 'fab fa-js', color: 'text-yellow-500' },
  { exts: ['.jsx', '.tsx'], icon: 'fab fa-react', color: 'text-cyan-500' },
  { exts: ['.ts'], icon: 'fas fa-code', color: 'text-blue-600' },
  { exts: ['.json'], icon: 'fas fa-code', color: 'text-green-500' },
  { exts: ['.md', '.markdown'], icon: 'fab fa-markdown', color: 'text-gray-600' },
  { exts: ['.py'], icon: 'fab fa-python', color: 'text-blue-400' },
  { exts: ['.java'], icon: 'fab fa-java', color: 'text-red-500' },
  { exts: ['.vue'], icon: 'fab fa-vuejs', color: 'text-green-500' },
  { exts: ['.sql'], icon: 'fas fa-database', color: 'text-blue-400' },
  { exts: ['.yml', '.yaml'], icon: 'fas fa-code', color: 'text-pink-500' },
  { exts: ['.xml'], icon: 'fas fa-code', color: 'text-orange-400' },
  { exts: ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico', '.bmp'], icon: 'far fa-image', color: 'text-green-500' },
  { exts: ['.pdf'], icon: 'far fa-file-pdf', color: 'text-red-500' },
  { exts: ['.mp4', '.avi', '.mov', '.mkv', '.webm'], icon: 'far fa-file-video', color: 'text-purple-500' },
  { exts: ['.mp3', '.wav', '.flac', '.ogg', '.m4a'], icon: 'far fa-file-audio', color: 'text-pink-500' },
  { exts: ['.doc', '.docx'], icon: 'far fa-file-word', color: 'text-blue-600' },
  { exts: ['.xls', '.xlsx', '.csv'], icon: 'far fa-file-excel', color: 'text-green-600' },
  { exts: ['.ppt', '.pptx'], icon: 'far fa-file-powerpoint', color: 'text-orange-600' },
  { exts: ['.zip', '.rar', '.7z', '.tar', '.gz'], icon: 'far fa-file-archive', color: 'text-yellow-600' },
]

function metaOf(p: string) {
  return fileIconMap.find(m => m.exts.includes(extOf(p))) || { icon: 'far fa-file-code', color: 'text-gray-500' }
}

/* ── MIME（按扩展名推断，喂 open-file-viewer） ── */
const mimeMap: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.webp': 'image/webp', '.ico': 'image/x-icon', '.bmp': 'image/bmp',
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.flac': 'audio/flac', '.m4a': 'audio/mp4',
  '.zip': 'application/zip', '.rar': 'application/vnd.rar', '.7z': 'application/x-7z-compressed',
  '.tar': 'application/x-tar', '.gz': 'application/gzip',
}

const htmlExts = new Set(['.html', '.htm'])
const imageExts = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico', '.bmp'])

/* ── open-file-viewer 插件（与 PreviewTabContent 同引擎） ── */
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

const busy = ref('')

/* ── 打开方式小弹窗 ── */
const menuOpen = ref(false)
const menuPath = ref('')

function openMenu(p: string) {
  menuPath.value = p
  menuOpen.value = true
}
function closeMenu() {
  menuOpen.value = false
}
function choosePreview(p: string) {
  closeMenu()
  openPreview(p)
}
function chooseReveal(p: string) {
  closeMenu()
  reveal(p)
}
function chooseBrowser(p: string) {
  closeMenu()
  openInBrowser(p)
}

/* ── 预览弹窗 ── */
const previewOpen = ref(false)
const previewPath = ref('')
const previewMeta = computed(() => metaOf(previewPath.value))
const previewName = computed(() => basename(previewPath.value))
const previewIsHtml = computed(() => htmlExts.has(extOf(previewPath.value)))
const previewHtml = ref('')
const previewError = ref('')
const previewState = ref<'loading' | 'ready' | 'error'>('loading')

const viewerWrapRef = ref<HTMLElement | null>(null)
let viewer: FileViewer | null = null

async function openPreview(p: string) {
  if (busy.value) return
  busy.value = 'preview'
  previewPath.value = p
  previewState.value = 'loading'
  previewError.value = ''
  previewHtml.value = ''
  previewOpen.value = true
  try {
    if (htmlExts.has(extOf(p))) {
      // HTML：文本读取 → srcdoc 渲染（相对资源受限，与 tab 预览 page 模式一致）
      const r = await chatStore.bridgeRpc('fs.readFile', { sessionId: props.convId, path: p, maxChars: 200000 })
      previewHtml.value = r?.content || ''
      previewState.value = 'ready'
    } else {
      // 文本 + 二进制（图片/PDF/Office/音视频/归档）：base64 → Blob → viewer（与 tab 预览同引擎）
      const r = await chatStore.bridgeRpc('fs.readFile', { sessionId: props.convId, path: p, encoding: 'base64' })
      const binary = atob(r?.data || '')
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
      const mime = mimeMap[extOf(p)] || 'application/octet-stream'
      previewState.value = 'ready'
      await nextTick()
      mountViewer(new Blob([bytes], { type: mime }), p)
    }
  } catch (e: any) {
    previewError.value = e?.message || String(e)
    previewState.value = 'error'
  } finally {
    busy.value = ''
  }
}

function mountViewer(blob: Blob, p: string) {
  const wrap = viewerWrapRef.value
  if (!wrap) return
  try {
    viewer?.destroy()
    viewer = null
    viewer = createViewer({
      container: wrap,
      file: blob,
      fileName: basename(p),
      width: '100%',
      height: wrap.clientHeight || 400,
      fit: /\.(docx?|xlsx?|pptx?|odt|ods|odp)$/i.test(p) ? 'width' : 'contain',
      plugins,
      toolbar: true,
      theme: 'light',
      fallback: 'inline',
    })
    viewer.resize()
  } catch (e) {
    previewError.value = e instanceof Error ? e.message : String(e)
    previewState.value = 'error'
  }
}

function closePreview() {
  previewOpen.value = false
  try { viewer?.destroy() } catch { /* ignore */ }
  viewer = null
}

onBeforeUnmount(() => {
  try { viewer?.destroy() } catch { /* ignore */ }
  viewer = null
})

/* ── 打开所在目录 / 浏览器打开 ── */
async function reveal(p: string) {
  if (busy.value) return
  busy.value = 'reveal'
  try { await chatStore.bridgeRpc('fs.reveal', { sessionId: props.convId, path: p }) }
  catch (e: any) { console.error('[ProducedFilesRow] reveal failed:', e) }
  finally { busy.value = '' }
}

async function openInBrowser(p: string) {
  if (busy.value) return
  busy.value = 'open'
  try { await chatStore.bridgeRpc('fs.openInBrowser', { sessionId: props.convId, path: p }) }
  catch (e: any) { console.error('[ProducedFilesRow] open failed:', e) }
  finally { busy.value = '' }
}

/* ── 进入对话预览 tab（与 ChatInterface handleFilePreview 同机制） ── */
async function openInChatPreview(p: string) {
  try {
    const name = basename(p)
    const ext = extOf(p)
    if (htmlExts.has(ext)) {
      const r = await chatStore.bridgeRpc('fs.readFile', { sessionId: props.convId, path: p, maxChars: 200000 })
      previewTabs.openTab(props.convId, {
        key: 'file:' + p,
        kind: 'html',
        title: name,
        content: r?.content || '',
        srcPath: p,
        viewMode: 'page',
      })
    } else if (imageExts.has(ext)) {
      const r = await chatStore.bridgeRpc('fs.readFile', { sessionId: props.convId, path: p, encoding: 'base64' })
      previewTabs.openTab(props.convId, {
        key: 'file:' + p,
        kind: 'image',
        title: name,
        dataUrl: 'data:' + (mimeMap[ext] || 'image/png') + ';base64,' + (r?.data || ''),
      })
    } else {
      const r = await chatStore.bridgeRpc('fs.readFile', { sessionId: props.convId, path: p, encoding: 'base64' })
      const binary = atob(r?.data || '')
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
      previewTabs.openTab(props.convId, {
        key: 'file:' + p,
        kind: 'file',
        title: name,
        file: new Blob([bytes], { type: mimeMap[ext] || 'application/octet-stream' }),
        mimeType: mimeMap[ext] || undefined,
      })
    }
    closePreview()
  } catch (e: any) {
    console.error('[ProducedFilesRow] openInChatPreview failed:', e)
  }
}
</script>

<template>
  <div class="dsh-produced" data-produced-row>
    <div class="flex flex-wrap gap-2.5">
      <div
        v-for="(f, i) in visibleFiles"
        :key="f.path"
        class="dsh-produced-card"
        :class="{ 'is-new': justExpanded && i >= COLLAPSE_LIMIT }"
        :title="f.path"
        :data-produced-path="f.path"
        @click="openMenu(f.path)"
       
      >
        <div class="flex items-center gap-3">
          <div class="dsh-produced-icon">
            <i :class="[metaOf(f.path).icon, metaOf(f.path).color, 'text-[15px]']"></i>
          </div>
          <div class="flex-1 min-w-0">
            <div class="dsh-produced-name">{{ basename(f.path) }}</div>
            <div class="dsh-produced-ext">{{ (extOf(f.path) || 'file').toUpperCase() }}<span v-if="f.size != null" class="dsh-produced-size"> · {{ formatSize(f.size) }}</span></div>
          </div>
        </div>
      </div>
    </div>

    <!-- 折叠开关：只在超过 3 个时出现（可展开 / 可再折回） -->
    <button
      v-if="files.length > COLLAPSE_LIMIT"
      type="button"
      class="dsh-produced-toggle"
      :aria-expanded="expanded"
      @click="toggleExpand"
    >
      <i :class="['fas', 'text-[9px]', expanded ? 'fa-chevron-up' : 'fa-chevron-down']"></i>
      <span>{{ expanded ? t('produced.collapse') : t('produced.expandMore', { n: files.length - COLLAPSE_LIMIT }) }}</span>
    </button>

    <!-- 打开方式小弹窗：预览 / 打开所在目录 / 浏览器打开 -->
    <Teleport to="body">
      <div v-if="menuOpen" class="dsh-produced-menu-overlay" @click.self="closeMenu">
        <div class="dsh-produced-menu">
          <div class="dsh-produced-menu-head">
            <div class="dsh-produced-icon dsh-produced-icon-sm">
              <i :class="[metaOf(menuPath).icon, metaOf(menuPath).color, 'text-[13px]']"></i>
            </div>
            <div class="flex-1 min-w-0">
              <div class="dsh-produced-menu-title">{{ basename(menuPath) }}</div>
              <div class="dsh-produced-menu-path">{{ menuPath }}</div>
            </div>
            <button type="button" class="dsh-produced-close" @click="closeMenu">
              <i class="fas fa-times text-xs"></i>
            </button>
          </div>
          <div class="dsh-produced-menu-list">
            <button type="button" class="dsh-produced-menu-item" @click="choosePreview(menuPath)">
              <i class="fas fa-eye text-[13px] dsh-produced-menu-icon"></i>
              <div class="flex-1 min-w-0 text-left">
                <div class="dsh-produced-menu-label">{{ t('panel.viewPreview') }}</div>
                <div class="dsh-produced-menu-desc">{{ t('produced.previewDesc') }}</div>
              </div>
            </button>
            <button type="button" class="dsh-produced-menu-item" :disabled="!!busy" @click="chooseReveal(menuPath)">
              <i class="fas fa-folder-open text-[13px] dsh-produced-menu-icon"></i>
              <div class="flex-1 min-w-0 text-left">
                <div class="dsh-produced-menu-label">{{ t('produced.reveal') }}</div>
                <div class="dsh-produced-menu-desc">{{ t('produced.revealDesc') }}</div>
              </div>
            </button>
            <button type="button" class="dsh-produced-menu-item" :disabled="!!busy" @click="chooseBrowser(menuPath)">
              <i class="fas fa-globe text-[13px] dsh-produced-menu-icon"></i>
              <div class="flex-1 min-w-0 text-left">
                <div class="dsh-produced-menu-label">{{ t('produced.browser') }}</div>
                <div class="dsh-produced-menu-desc">{{ t('produced.browserDesc') }}</div>
              </div>
            </button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- 预览弹窗（open-file-viewer 全格式） -->
    <Teleport to="body">
      <div v-if="previewOpen" class="dsh-produced-overlay" @click.self="closePreview">
        <div class="dsh-produced-modal">
          <div class="dsh-produced-modal-head">
            <div class="dsh-produced-icon" :class="{ 'dsh-produced-icon-sm': true }">
              <i :class="[previewMeta.icon, previewMeta.color, 'text-[13px]']"></i>
            </div>
            <div class="flex-1 min-w-0">
              <div class="dsh-produced-modal-title">{{ previewName }}</div>
              <div class="dsh-produced-modal-path">{{ previewPath }}</div>
            </div>
            <button type="button" class="dsh-produced-btn" @click="openInChatPreview(previewPath)">
              <i class="fas fa-expand text-[10px]"></i>{{ t('produced.enterPreview') }}
            </button>
            <button type="button" class="dsh-produced-close" @click="closePreview">
              <i class="fas fa-times text-xs"></i>
            </button>
          </div>
          <div class="dsh-produced-modal-body">
            <div v-if="previewState === 'loading'" class="dsh-produced-empty">
              <i class="fas fa-spinner fa-spin"></i> {{ t('produced.loading') }}
            </div>
            <div v-else-if="previewState === 'error'" class="dsh-produced-empty dsh-produced-error">
              <i class="fas fa-triangle-exclamation mr-2"></i>{{ previewError }}
            </div>
            <iframe sandbox="allow-scripts allow-popups allow-forms" v-else-if="previewIsHtml" :srcdoc="previewHtml" class="dsh-produced-frame"></iframe>
            <div v-else ref="viewerWrapRef" class="dsh-produced-viewer"></div>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.dsh-produced {
  margin-top: 8px;
}

.dsh-produced-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: 190px;
  padding: 12px 14px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 12px;
  background: var(--dsw-static-neutral-bluish-00);
  cursor: pointer;
  transition: border-color 0.15s, box-shadow 0.15s;
}
.dsh-produced-card:hover {
  border-color: var(--dsw-static-deepseek-200);
  box-shadow: 0 1px 8px rgba(65, 118, 230, 0.12);
}

.dsh-produced-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: 9px;
  background: var(--dsw-static-neutral-bluish-60);
  flex-shrink: 0;
}
.dsh-produced-icon-sm {
  width: 30px;
  height: 30px;
  border-radius: 7px;
}

.dsh-produced-name {
  font-size: 13px;
  font-weight: 530;
  color: var(--dsw-alias-label-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dsh-produced-ext {
  font-size: 11px;
  color: var(--dsw-alias-label-caption);
  margin-top: 2px;
}
.dsh-produced-size {
  color: var(--dsw-alias-label-tertiary);
}

/* ── 折叠开关（>3 个才出现） ── */
.dsh-produced-toggle {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin-top: 8px;
  padding: 5px 11px;
  border: 1px dashed var(--dsw-alias-border-l2, #e2e2e8);
  border-radius: 999px;
  background: transparent;
  color: var(--dsw-alias-label-secondary, #6b7280);
  font-size: 11.5px;
  line-height: 1.2;
  cursor: pointer;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
}
.dsh-produced-toggle:hover {
  background: var(--dsw-alias-interactive-bg-hover, #f3f4f6);
  color: var(--dsw-alias-label-primary, #111827);
  border-color: var(--dsw-static-deepseek-200, #a8c1f2);
}
/* 展开时**只给新露出来的那几张**加入场；只动 opacity/transform */
@keyframes dshProducedCardIn {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: none; }
}
.dsh-produced-card.is-new { animation: dshProducedCardIn 0.18s ease both; }

/* ── 打开方式小弹窗 ── */
.dsh-produced-menu-overlay {
  position: fixed;
  inset: 0;
  z-index: 9999;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(21, 21, 23, 0.35);
}
.dsh-produced-menu {
  position: relative;
  z-index: 1;
  width: 320px;
  max-width: 90vw;
  border-radius: 14px;
  background: var(--dsw-static-neutral-bluish-00);
  box-shadow: 0 12px 48px rgba(15, 17, 21, 0.28);
  overflow: hidden;
  animation: dsh-menu-pop 0.18s cubic-bezier(0.34, 1.56, 0.64, 1) both;
}
@keyframes dsh-menu-pop {
  from { opacity: 0; transform: translateY(8px) scale(0.96); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}
.dsh-produced-menu-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
}
.dsh-produced-menu-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dsh-produced-menu-path {
  font-size: 11px;
  color: var(--dsw-alias-label-caption);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-top: 1px;
}
.dsh-produced-menu-list {
  padding: 6px;
}
.dsh-produced-menu-item {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 10px 10px;
  border: none;
  border-radius: 10px;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  cursor: pointer;
  transition: background 0.12s;
}
.dsh-produced-menu-item:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}
.dsh-produced-menu-item:disabled {
  opacity: 0.45;
  cursor: default;
}
.dsh-produced-menu-icon {
  color: var(--dsw-static-deepseek-500);
}
.dsh-produced-menu-label {
  font-size: 13px;
  font-weight: 530;
}
.dsh-produced-menu-desc {
  font-size: 11px;
  color: var(--dsw-alias-label-caption);
  margin-top: 1px;
}

.dsh-produced-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11.5px;
  padding: 4px 8px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
  transition: background 0.12s, color 0.12s;
  white-space: nowrap;
  flex-shrink: 0;
}
.dsh-produced-btn:hover {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}

/* ── 弹窗 ── */
.dsh-produced-overlay {
  position: fixed;
  inset: 0;
  z-index: 9999;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(21, 21, 23, 0.45);
}

.dsh-produced-modal {
  position: relative;
  z-index: 1;
  display: flex;
  flex-direction: column;
  width: 760px;
  max-width: 92vw;
  height: 72vh;
  max-height: 80vh;
  border-radius: 14px;
  background: var(--dsw-static-neutral-bluish-00);
  box-shadow: 0 12px 48px rgba(15, 17, 21, 0.28);
  overflow: hidden;
}

.dsh-produced-modal-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  flex-shrink: 0;
}
.dsh-produced-modal-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dsh-produced-modal-path {
  font-size: 11px;
  color: var(--dsw-alias-label-caption);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-top: 1px;
}

.dsh-produced-close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  cursor: pointer;
  transition: background 0.12s, color 0.12s;
  flex-shrink: 0;
}
.dsh-produced-close:hover {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}

.dsh-produced-modal-body {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  background: var(--dsw-static-neutral-bluish-60);
}
.dsh-produced-frame {
  width: 100%;
  height: 100%;
  border: none;
  background: white;
}
.dsh-produced-text {
  height: 100%;
  overflow: auto;
  padding: 14px 16px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--dsw-alias-label-primary);
  white-space: pre-wrap;
  word-break: break-word;
  background: white;
}
.dsh-produced-viewer {
  width: 100%;
  height: 100%;
  background: white;
}
.dsh-produced-empty {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  font-size: 13px;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-produced-error {
  color: var(--dsw-alias-state-error-primary);
}
/* ★1012 手机端（需求）：产出物从"换行竖排"改成"一排 + 横向拖动查看"。
   只影响窄屏；桌面端仍然是原来的 flex-wrap 换行布局。 */
@media (max-width: 767px) {
  .dsh-produced > .flex.flex-wrap {
    flex-wrap: nowrap;
    overflow-x: auto;
    overflow-y: hidden;
    -webkit-overflow-scrolling: touch;
    scrollbar-width: none;          /* 隐藏滚动条，靠滑动 */
    padding-bottom: 2px;
    scroll-snap-type: x proximity;
  }
  .dsh-produced > .flex.flex-wrap::-webkit-scrollbar { display: none; }
  .dsh-produced-card {
    flex: 0 0 auto;                 /* 不被压缩：保持原宽，滑出去看 */
    min-width: 156px;
    scroll-snap-align: start;
  }
}
</style>
