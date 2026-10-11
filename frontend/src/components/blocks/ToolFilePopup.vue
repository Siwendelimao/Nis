<script setup lang="ts">
/**
 * ToolFilePopup —— 过程块文件 chip 的"打开方式"小弹窗 + 预览弹窗（0903 反馈 #2）
 * 与产出物（ProducedFilesRow）点击后的小弹窗同款同功能：预览 / 打开所在目录 / 浏览器打开，
 * 预览复用 open-file-viewer 同引擎（HTML srcdoc / 二进制 Blob → viewer）。
 * 自包含组件（Teleport 到 body）：usePopup().open(path) 打开。
 */
import { ref, computed, onBeforeUnmount, nextTick } from 'vue'
import { createViewer, imagePlugin, videoPlugin, audioPlugin, textPlugin, pdfPlugin, officePlugin, archivePlugin, fallbackPlugin } from '@open-file-viewer/core'
import type { FileViewer } from '@open-file-viewer/core'
import pdfWorkerSrc from 'pdfjs-dist/build/pdf.worker.mjs?url'
import { useChatStore } from '@/stores/chat'
import { usePreviewTabsStore } from '@/stores/previewTabs'
import { basename, extOf, metaOf, mimeMap } from '@/utils/fileMeta'
import { t } from '@/utils/i18n'

const props = defineProps<{ convId: string }>()

const chatStore = useChatStore()
const previewTabs = usePreviewTabsStore()

const htmlExts = new Set(['.html', '.htm'])
const imageExts = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico', '.bmp'])

/* ── open-file-viewer 插件（与 PreviewTabContent/产出物 同引擎） ── */
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

function open(p: string) {
  if (!p) return
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
  catch (e: any) { console.error('[ToolFilePopup] reveal failed:', e) }
  finally { busy.value = '' }
}

async function openInBrowser(p: string) {
  if (busy.value) return
  busy.value = 'open'
  try { await chatStore.bridgeRpc('fs.openInBrowser', { sessionId: props.convId, path: p }) }
  catch (e: any) { console.error('[ToolFilePopup] open failed:', e) }
  finally { busy.value = '' }
}

/* ── 进入对话预览 tab（与产出物 openInChatPreview 同机制） ── */
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
    console.error('[ToolFilePopup] openInChatPreview failed:', e)
  }
}

defineExpose({ open })
</script>

<template>
  <div>
    <!-- 打开方式小弹窗：预览 / 打开所在目录 / 浏览器打开（与产出物同款） -->
    <Teleport to="body">
      <div v-if="menuOpen" class="tfp-menu-overlay" @click.self="closeMenu">
        <div class="tfp-menu">
          <div class="tfp-menu-head">
            <div class="tfp-icon tfp-icon-sm">
              <i :class="[metaOf(menuPath).icon, metaOf(menuPath).color, 'text-[13px]']"></i>
            </div>
            <div class="flex-1 min-w-0">
              <div class="tfp-menu-title">{{ basename(menuPath) }}</div>
              <div class="tfp-menu-path">{{ menuPath }}</div>
            </div>
            <button type="button" class="tfp-close" @click="closeMenu">
              <i class="fas fa-times text-xs"></i>
            </button>
          </div>
          <div class="tfp-menu-list">
            <button type="button" class="tfp-menu-item" @click="choosePreview(menuPath)">
              <i class="fas fa-eye text-[13px] tfp-menu-icon"></i>
              <div class="flex-1 min-w-0 text-left">
                <div class="tfp-menu-label">{{ t('panel.viewPreview') }}</div>
                <div class="tfp-menu-desc">{{ t('produced.previewDesc') }}</div>
              </div>
            </button>
            <button type="button" class="tfp-menu-item" :disabled="!!busy" @click="chooseReveal(menuPath)">
              <i class="fas fa-folder-open text-[13px] tfp-menu-icon"></i>
              <div class="flex-1 min-w-0 text-left">
                <div class="tfp-menu-label">{{ t('produced.reveal') }}</div>
                <div class="tfp-menu-desc">{{ t('produced.revealDesc') }}</div>
              </div>
            </button>
            <button type="button" class="tfp-menu-item" :disabled="!!busy" @click="chooseBrowser(menuPath)">
              <i class="fas fa-globe text-[13px] tfp-menu-icon"></i>
              <div class="flex-1 min-w-0 text-left">
                <div class="tfp-menu-label">{{ t('produced.browser') }}</div>
                <div class="tfp-menu-desc">{{ t('produced.browserDesc') }}</div>
              </div>
            </button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- 预览弹窗（open-file-viewer 全格式） -->
    <Teleport to="body">
      <div v-if="previewOpen" class="tfp-overlay" @click.self="closePreview">
        <div class="tfp-modal">
          <div class="tfp-modal-head">
            <div class="tfp-icon tfp-icon-sm">
              <i :class="[previewMeta.icon, previewMeta.color, 'text-[13px]']"></i>
            </div>
            <div class="flex-1 min-w-0">
              <div class="tfp-modal-title">{{ previewName }}</div>
              <div class="tfp-modal-path">{{ previewPath }}</div>
            </div>
            <button type="button" class="tfp-btn" @click="openInChatPreview(previewPath)">
              <i class="fas fa-expand text-[10px]"></i>{{ t('produced.enterPreview') }}
            </button>
            <button type="button" class="tfp-close" @click="closePreview">
              <i class="fas fa-times text-xs"></i>
            </button>
          </div>
          <div class="tfp-modal-body">
            <div v-if="previewState === 'loading'" class="tfp-empty">
              <i class="fas fa-spinner fa-spin"></i> {{ t('produced.loading') }}
            </div>
            <div v-else-if="previewState === 'error'" class="tfp-empty tfp-error">
              <i class="fas fa-triangle-exclamation mr-2"></i>{{ previewError }}
            </div>
            <iframe sandbox="allow-scripts allow-popups allow-forms" v-else-if="previewIsHtml" :srcdoc="previewHtml" class="tfp-frame"></iframe>
            <div v-else ref="viewerWrapRef" class="tfp-viewer"></div>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
/* ── 打开方式小弹窗（与产出物 dsh-produced-menu 同款样式） ── */
.tfp-menu-overlay {
  position: fixed;
  inset: 0;
  z-index: 9999;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(21, 21, 23, 0.35);
}
.tfp-menu {
  position: relative;
  z-index: 1;
  width: 320px;
  max-width: 90vw;
  border-radius: 14px;
  background: var(--dsw-static-neutral-bluish-00);
  box-shadow: 0 12px 48px rgba(15, 17, 21, 0.28);
  overflow: hidden;
  animation: tfp-menu-pop 0.18s cubic-bezier(0.34, 1.56, 0.64, 1) both;
}
@keyframes tfp-menu-pop {
  from { opacity: 0; transform: translateY(8px) scale(0.96); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}
.tfp-menu-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
}
.tfp-menu-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tfp-menu-path {
  font-size: 11px;
  color: var(--dsw-alias-label-caption);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-top: 1px;
}
.tfp-menu-list {
  padding: 6px;
}
.tfp-menu-item {
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
.tfp-menu-item:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}
.tfp-menu-item:disabled {
  opacity: 0.45;
  cursor: default;
}
.tfp-menu-icon {
  color: var(--dsw-static-deepseek-500);
}
.tfp-menu-label {
  font-size: 13px;
  font-weight: 500;
}
.tfp-menu-desc {
  font-size: 11px;
  color: var(--dsw-alias-label-caption);
  margin-top: 1px;
}

.tfp-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: 7px;
  background: var(--dsw-static-neutral-bluish-60);
  flex-shrink: 0;
}

.tfp-btn {
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
.tfp-btn:hover {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}

.tfp-close {
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
.tfp-close:hover {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}

/* ── 预览弹窗 ── */
.tfp-overlay {
  position: fixed;
  inset: 0;
  z-index: 9999;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(21, 21, 23, 0.45);
}
.tfp-modal {
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
.tfp-modal-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  flex-shrink: 0;
}
.tfp-modal-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tfp-modal-path {
  font-size: 11px;
  color: var(--dsw-alias-label-caption);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-top: 1px;
}
.tfp-modal-body {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  background: var(--dsw-static-neutral-bluish-60);
}
.tfp-frame {
  width: 100%;
  height: 100%;
  border: none;
  background: white;
}
.tfp-viewer {
  width: 100%;
  height: 100%;
  background: white;
}
.tfp-empty {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  font-size: 13px;
  color: var(--dsw-alias-label-tertiary);
}
.tfp-error {
  color: var(--dsw-alias-state-error-primary);
}
</style>
