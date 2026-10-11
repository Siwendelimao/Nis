<script setup lang="ts">
import { computed } from 'vue'
import { t } from '@/utils/i18n'
import { BRIDGE_URL } from '../../utils/bridgeUrl'

/**
 * 文件预览卡（索引化 v2）：样式不变，内部不内嵌文件内容。
 * 点击卡片 → 在右侧预览处显示（本地预览服务加载磁盘最新内容）；
 * 「在浏览器打开」→ 8766 服务 URL（相对资源可用）或 Blob 回退；
 * 「打开文件位置」→ OPEN_FILE_LOCATION。
 */
const props = defineProps<{
  content: string
  fileName?: string
  fileType?: string
  /** 相对项目根的路径（后端 rich_message 组装时补全）→ 精确预览/浏览器打开 */
  relPath?: string
}>()

const emit = defineEmits<{
  preview: [payload: { name: string; content?: string; source?: string; path?: string }]
  'open-location': [fileName: string]
}>()

/** 预览服务基址 = 后端地址（动态端口，见 utils/bridgeUrl） */
const PREVIEW_BASE = BRIDGE_URL

const type = computed(() => props.fileType || 'html')

const iconMap: Record<string, { icon: string; color: string; ext: string }> = {
  html: { icon: 'fab fa-html5', color: 'text-orange-500', ext: '.html' },
  css: { icon: 'fab fa-css3-alt', color: 'text-blue-500', ext: '.css' },
  javascript: { icon: 'fab fa-js', color: 'text-yellow-500', ext: '.js' },
  typescript: { icon: 'fas fa-code', color: 'text-blue-600', ext: '.ts' },
  json: { icon: 'fas fa-code', color: 'text-green-500', ext: '.json' },
  markdown: { icon: 'fab fa-markdown', color: 'text-gray-600', ext: '.md' },
  python: { icon: 'fab fa-python', color: 'text-blue-400', ext: '.py' },
  java: { icon: 'fab fa-java', color: 'text-red-500', ext: '.java' },
  vue: { icon: 'fab fa-vuejs', color: 'text-green-500', ext: '.vue' },
  react: { icon: 'fab fa-react', color: 'text-cyan-500', ext: '.jsx' },
  sql: { icon: 'fas fa-database', color: 'text-blue-400', ext: '.sql' },
  yaml: { icon: 'fas fa-code', color: 'text-pink-500', ext: '.yml' },
  xml: { icon: 'fas fa-code', color: 'text-orange-400', ext: '.xml' },
  image: { icon: 'far fa-image', color: 'text-green-500', ext: '.png' },
  pdf: { icon: 'far fa-file-pdf', color: 'text-red-500', ext: '.pdf' },
  video: { icon: 'far fa-file-video', color: 'text-purple-500', ext: '.mp4' },
  audio: { icon: 'far fa-file-audio', color: 'text-pink-500', ext: '.mp3' },
  document: { icon: 'far fa-file-word', color: 'text-blue-600', ext: '.docx' },
  spreadsheet: { icon: 'far fa-file-excel', color: 'text-green-600', ext: '.xlsx' },
  presentation: { icon: 'far fa-file-powerpoint', color: 'text-orange-600', ext: '.pptx' },
  archive: { icon: 'far fa-file-archive', color: 'text-yellow-600', ext: '.zip' },
  code: { icon: 'far fa-file-code', color: 'text-gray-500', ext: '.txt' }
}

const fileInfo = computed(() => iconMap[type.value] || iconMap.code)

const displayName = computed(() => props.fileName || ('preview' + fileInfo.value.ext))

/** 是否有真实文件路径（索引卡 → 8766 服务读取磁盘最新内容） */
const hasRealPath = computed(() => !!props.relPath)

function previewUrl(): string | null {
  if (!props.relPath) return null
  return `${PREVIEW_BASE}/project/${encodeURIComponent(props.relPath)}`
}

function openInBrowser() {
  const url = previewUrl()
  if (url) {
    window.open(url, '_blank')
    return
  }
  // 无真实路径回退：内存内容 Blob（临时预览围栏）
  const blob = new Blob([props.content], { type: 'text/html' })
  const u = URL.createObjectURL(blob)
  window.open(u, '_blank')
}

function openFileLocation() {
  emit('open-location', displayName.value)
}

/** 点击卡片 → 右侧预览处显示（带路径则精确导航，RightPanel 升级为 workspace 源） */
function handlePreview() {
  emit('preview', {
    name: props.relPath || displayName.value,
    content: props.relPath ? undefined : props.content,
    source: props.relPath ? 'workspace' : undefined,
  })
}
</script>

<template>
  <div class="my-2 inline-flex flex-col items-start gap-2">
    <button @click="handlePreview" class="group flex items-center gap-3 px-4 py-3 bg-white border border-gray-200 rounded-xl hover:border-gray-300 hover:shadow-sm transition-all text-left min-w-[260px]" :title="hasRealPath ? t('fp.previewTipDisk') : t('fp.previewTip')">
      <div class="w-10 h-10 rounded-lg bg-gray-50 flex items-center justify-center flex-shrink-0">
        <i :class="[fileInfo.icon, fileInfo.color, 'text-xl']"></i>
      </div>
      <div class="flex-1 min-w-0">
        <div class="text-sm font-medium text-gray-700 truncate group-hover:text-gray-900 transition-colors">{{ displayName }}</div>
        <div class="text-xs text-gray-400 mt-0.5 flex items-center gap-1">
          {{ fileInfo.ext }}
          <i v-if="hasRealPath" class="fas fa-file-invoice text-[8px] text-gray-300" :title="t('fp.indexedTip')"></i>
        </div>
      </div>
      <i class="fas fa-chevron-right text-gray-300 text-xs group-hover:text-gray-500 transition-colors"></i>
    </button>
    <div class="flex items-center justify-between pl-1 pr-1 w-full min-w-[260px]">
      <button @click="openInBrowser" class="text-xs text-gray-500 hover:text-gray-900 px-3 py-1.5 rounded-lg hover:bg-gray-100 transition-colors flex items-center gap-1.5">
        <i class="far fa-eye text-[10px]"></i>
        {{ t('fp.openBrowser') }}
      </button>
      <button @click="openFileLocation" class="text-xs text-gray-500 hover:text-gray-900 px-3 py-1.5 rounded-lg hover:bg-gray-100 transition-colors flex items-center gap-1.5">
        <i class="far fa-folder-open text-[10px]"></i>
        {{ t('fp.openLocation') }}
      </button>
    </div>
  </div>
</template>
