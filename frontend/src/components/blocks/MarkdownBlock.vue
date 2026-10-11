<script setup lang="ts">
import { computed, ref, watch, nextTick } from 'vue'
import StreamingTail from './StreamingTail.vue'
import { useChatStore } from '@/stores/chat'
import { useConversationsStore } from '@/stores/conversations'
import { t } from '@/utils/i18n'
import { renderMermaidSlots } from '@/utils/mermaidRender'

const props = defineProps<{ content: string; streaming?: boolean }>()

const chatStore = useChatStore()
const conversationsStore = useConversationsStore()

// #4 图片查看器（点击图片放大查看，右侧栏预览只通过显式按钮触发）
const viewerVisible = ref(false)
const viewerUrl = ref('')

function openViewer(url: string) {
  viewerUrl.value = url
  viewerVisible.value = true
}
function closeViewer() {
  viewerVisible.value = false
  viewerUrl.value = ''
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** 0923：mermaid 源码槽位索引（renderFence 收集 → html 后处理按索引取，避开属性转义坑） */
const mermaidSources: string[] = []

/** 代码围栏 → HTML 代码块（mermaid 输出占位槽，html 落地后异步渲染成图） */
function renderFence(m: string): string {
  const match = m.match(/```([\w+-]*)\s*\n([\s\S]*?)```/)
  if (!match) return escapeHtml(m)
  const lang = match[1] || 'code'
  const code = match[2]
  if (lang === 'mermaid') {
    const idx = mermaidSources.push(code) - 1
    return `<div class="nis-mmd-slot my-2" data-mmd-idx="${idx}"></div>`
  }
  return `<div class="my-2 rounded-lg overflow-hidden border border-gray-200"><div class="flex items-center justify-between px-4 py-2 bg-gray-800 text-gray-300 text-xs"><span class="font-mono">${lang}</span></div><pre class="p-4 bg-gray-900 text-gray-100 text-sm font-mono overflow-x-auto leading-relaxed"><code>${escapeHtml(code)}</code></pre></div>`
}

/** #3 路径链接化：盘符绝对 / 斜杠 / ./ ../ 相对路径 / 含斜杠的相对路径 / 常见扩展名的裸文件名 */
const PATH_RE = /(?:[A-Za-z]:[\\\/]|[\\\/]|\.{1,2}[\\\/])[^\s<>"'，。；:：|`]+\.[a-zA-Z0-9]{1,6}|[\w\u4e00-\u9fff\-\.]+[\\\/][^\s<>"'，。；:：|`]*\.\w{1,6}|\b[\w\u4e00-\u9fff\-]+\.(?:html|htm|css|js|jsx|ts|tsx|vue|json|md|py|java|c|cpp|h|sql|yml|yaml|xml|txt|svg|png|jpg|jpeg|gif|webp|ico|pdf|zip|sh|bat|ini|toml|env)\b/gi

/** 点击路径链接 → 后端在项目里找文件并在资源管理器中选中 */
function onPathClick(e: MouseEvent) {
  const t = e.target as HTMLElement
  const a = t.closest('a[data-path]') as HTMLElement | null
  if (a) {
    e.preventDefault()
    const p = a.getAttribute('data-path') || ''
    // 0911：原走 sendResponse('OPEN_FILE_LOCATION') 死通道（点了没反应）→ 改接真实 fs.reveal RPC
    if (p) {
      const convId = String(conversationsStore.activeConversationId ?? '')
      if (convId) {
        chatStore.bridgeRpc('fs.reveal', { sessionId: convId, path: p }).catch(() => { /* 后端未连接/路径不存在：静默 */ })
      }
    }
    return
  }
  // #4 点击图片 → 打开图片查看器（默认查看器；右侧栏预览由显式按钮触发，不自动跳转）
  const img = t.closest('img[data-nis-image]') as HTMLElement | null
  if (img) {
    const url = decodeURIComponent(img.getAttribute('data-nis-image') || '')
    if (url) {
      e.preventDefault()
      openViewer(url)
    }
  }
}

const html = computed(() => {
  let h = props.content
  // 先抽出代码围栏（避免把代码里的路径链接化），最后再还原
  const fences: string[] = []
  h = h.replace(/```([\w+-]*)\s*\n([\s\S]*?)```/g, (m) => {
    fences.push(m)
    return `@@NIS_FENCE_${fences.length - 1}@@`
  })
  // 表格：| 表头 | 表头 | + 分隔行 + 数据行 → <table>
  h = h.replace(
    /^\|(.+)\|[\r\n]+\|[\s\-:|]+\|[\r\n]+((?:^\|.+\|[\r\n]*)+)/gm,
    (_, header, rows) => {
      const heads = String(header).split('|').map(x => x.trim()).filter(Boolean)
      const trs = String(rows).trim().split(/\r?\n/).map(line =>
        '<tr>' + String(line).split('|').map(x => x.trim()).filter(Boolean).map(c => `<td class="px-3 py-1.5">${c}</td>`).join('') + '</tr>'
      ).join('')
      return `<div class="my-2 overflow-x-auto"><table class="min-w-full text-sm border border-gray-200 rounded-lg overflow-hidden"><thead class="bg-gray-50"><tr>${heads.map(x => `<th class="px-3 py-1.5 text-left text-xs font-medium text-gray-500 uppercase tracking-wide border-b border-gray-200">${x}</th>`).join('')}</tr></thead><tbody class="bg-white divide-y divide-gray-100">${trs}</tbody></table></div>`
    }
  )
  h = h.replace(/^(###)\s+(.+)$/gm, '<h3 class="text-base font-semibold text-gray-800 mt-3 mb-1">$2</h3>')
  h = h.replace(/^(##)\s+(.+)$/gm, '<h2 class="text-lg font-semibold text-gray-800 mt-4 mb-1">$2</h2>')
  h = h.replace(/^(#)\s+(.+)$/gm, '<h1 class="text-xl font-bold text-gray-900 mt-4 mb-2">$2</h1>')
  h = h.replace(/\*\*(.+?)\*\*/g, '<strong class="font-semibold text-gray-900">$1</strong>')
  h = h.replace(/\*(.+?)\*/g, '<em class="italic text-gray-600">$1</em>')
  h = h.replace(/`(.+?)`/g, '<code class="bg-gray-100 text-pink-600 px-1.5 py-0.5 rounded text-sm font-mono">$1</code>')
  h = h.replace(/^(\d+)\.\s+(.+)$/gm, '<li class="ml-4 list-decimal text-gray-700">$2</li>')
  h = h.replace(/^-\s+(.+)$/gm, '<li class="ml-4 list-disc text-gray-700">$1</li>')
  // #4 图片语法 ![alt](url) → 可点击放大/右侧栏预览（AI 输出的图片，无论独立行还是行内都渲染）
  h = h.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, url) => {
    const src = String(url).replace(/"/g, '&quot;')
    return `<img src="${src}" alt="${String(alt)}" data-nis-image="${encodeURIComponent(String(url))}" class="my-2 max-w-full rounded-lg border border-gray-200 cursor-zoom-in hover:opacity-90 transition-opacity" style="max-height:320px" />`
  })
  // #3 路径 → 可点击链接（代码围栏已抽出，不误伤代码内容）
  h = h.replace(PATH_RE, (p) => `<a href="#" data-path="${p.replace(/"/g, '&quot;')}" class="text-blue-600 underline decoration-blue-300 underline-offset-2 hover:text-blue-800 cursor-pointer font-mono text-[13px]" title="${t('md.pathTip')}">${escapeHtml(p)}</a>`)
  // 还原代码围栏
  h = h.replace(/@@NIS_FENCE_(\d+)@@/g, (_, i) => renderFence(fences[Number(i)]))
  // 空行（段落）→ 单个 <br> 作段落分隔，避免 <br><br> 造成过大行距
  h = h.replace(/\n\s*\n/g, '<br>')
  // 段内单换行 → 软换行：同一段落自然折行，不强制断行
  h = h.replace(/\n/g, ' ')
  return h
})

/* ★ 0923：html 落地后把 mermaid 占位槽异步渲染成图（失败自动回退源码） */
const mdBody = ref<HTMLElement | null>(null)
watch(html, async () => {
  await nextTick()
  await renderMermaidSlots(mdBody.value, mermaidSources)
})
</script>
<template>
  <div class="text-[15px] leading-normal text-[#15151a] font-[350] prose prose-sm max-w-none" @click="onPathClick">
    <!-- 流式期间：StreamingTail 实时显示已收文本 + 彩色尾部动画（不渲染成代码块，结束才 blocks 化） -->
    <StreamingTail v-if="streaming" :text="content" />
    <div v-else ref="mdBody" v-html="html"></div>
  </div>

  <Teleport to="body">
    <div v-if="viewerVisible" class="fixed inset-0 z-[9999] flex items-center justify-center" @click.self="closeViewer">
      <div class="absolute inset-0 bg-black/80"></div>
      <div class="relative z-10 max-w-[88vw] max-h-[85vh]">
        <img :src="viewerUrl" class="max-w-[88vw] max-h-[85vh] object-contain rounded-lg shadow-2xl" draggable="false" />
        <button @click="closeViewer" class="absolute top-3 right-3 w-9 h-9 bg-white rounded-full shadow-lg flex items-center justify-center text-gray-500 hover:text-gray-700 hover:shadow-xl transition-all">
          <i class="fas fa-times"></i>
        </button>
      </div>
    </div>
  </Teleport>
</template>
