<script setup lang="ts">
/** 附件条（★1011 从 ChatInterface 内联模板抽成组件）
 *  ── 为什么抽出来 ──
 *  原来这段只在「会话页输入框」（ChatInterface 模板 v-else 分支）里内联渲染，
 *  「欢迎页 / 空态输入框」（.empty-input 里那个 input-shell）**没有这段 DOM**。
 *  后果（1011 实测：8766 空态页拖入文件 —— dragover 高亮正常、drop 也接住了、attachments 里确实多了一项，
 *  但界面上一个字符都不变）⇒ 用户感知就是"文件拖不进去"。
 *  抽成组件后会话页与欢迎页共用同一份渲染，避免两边再次分叉。
 *
 *  样式、结构与会话页原实现逐行一致（tailwind 类，无 scoped 依赖）。 */
defineProps<{
  files: Array<{ name: string; size: number; type: string; preview?: string }>
  /** ★1011（拖拽增强）：被拒原因提示（文件夹被忽略 / 超限未添加）—— 由 ChatInterface 传入，几秒后自动清空 */
  hint?: string
}>()
const emit = defineEmits<{ (e: 'remove', index: number): void }>()

function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / 1048576).toFixed(1) + ' MB'
}

function getFileType(ext: string): { icon: string; color: string; bg: string } {
  const map: Record<string, { icon: string; color: string; bg: string }> = {
    jpg: { icon: 'far fa-image', color: 'text-green-600', bg: 'bg-green-50' },
    jpeg: { icon: 'far fa-image', color: 'text-green-600', bg: 'bg-green-50' },
    png: { icon: 'far fa-image', color: 'text-green-600', bg: 'bg-green-50' },
    gif: { icon: 'far fa-image', color: 'text-green-600', bg: 'bg-green-50' },
    svg: { icon: 'far fa-image', color: 'text-green-600', bg: 'bg-green-50' },
    mp4: { icon: 'far fa-file-video', color: 'text-purple-600', bg: 'bg-purple-50' },
    mp3: { icon: 'far fa-file-audio', color: 'text-pink-600', bg: 'bg-pink-50' },
    pdf: { icon: 'far fa-file-pdf', color: 'text-red-600', bg: 'bg-red-50' },
    doc: { icon: 'far fa-file-word', color: 'text-blue-600', bg: 'bg-blue-50' },
    docx: { icon: 'far fa-file-word', color: 'text-blue-600', bg: 'bg-blue-50' },
    xls: { icon: 'far fa-file-excel', color: 'text-green-600', bg: 'bg-green-50' },
    xlsx: { icon: 'far fa-file-excel', color: 'text-green-600', bg: 'bg-green-50' },
    ppt: { icon: 'far fa-file-powerpoint', color: 'text-orange-600', bg: 'bg-orange-50' },
    pptx: { icon: 'far fa-file-powerpoint', color: 'text-orange-600', bg: 'bg-orange-50' },
    js: { icon: 'fab fa-js', color: 'text-yellow-600', bg: 'bg-yellow-50' },
    ts: { icon: 'fas fa-code', color: 'text-blue-600', bg: 'bg-blue-50' },
    py: { icon: 'fab fa-python', color: 'text-blue-500', bg: 'bg-blue-50' },
    vue: { icon: 'fab fa-vuejs', color: 'text-green-600', bg: 'bg-green-50' },
    html: { icon: 'fab fa-html5', color: 'text-orange-600', bg: 'bg-orange-50' },
    css: { icon: 'fab fa-css3-alt', color: 'text-blue-500', bg: 'bg-blue-50' },
    json: { icon: 'fas fa-code', color: 'text-green-500', bg: 'bg-green-50' },
    zip: { icon: 'far fa-file-archive', color: 'text-yellow-600', bg: 'bg-yellow-50' },
    txt: { icon: 'far fa-file-alt', color: 'text-gray-600', bg: 'bg-gray-50' },
    md: { icon: 'fab fa-markdown', color: 'text-gray-600', bg: 'bg-gray-50' }
  }
  return map[ext] || { icon: 'far fa-file', color: 'text-gray-500', bg: 'bg-gray-50' }
}
</script>

<template>
  <!-- ★1011：被拒提示（拖入文件夹 / 单文件超 8MB / 总量超 20MB）—— 拖入那一刻就反馈，不再"发送时才在 console 悄悄丢" -->
  <div v-if="hint" class="px-4 pt-3 pb-1 flex items-center gap-1.5 text-[11px] font-[530] text-red-500">
    <i class="fas fa-circle-exclamation text-[10px]"></i><span>{{ hint }}</span>
  </div>
  <div v-if="files.length" class="flex flex-wrap gap-2 px-4 pt-3 pb-2 border-b border-gray-100">
    <div
      v-for="(file, i) in files"
      :key="i"
      class="group relative flex items-center gap-2 h-9 pl-1 pr-1 rounded-full border border-gray-200 bg-white hover:shadow-sm transition-all"
    >
      <div v-if="file.preview" class="w-7 h-7 rounded-full overflow-hidden bg-gray-100 flex-shrink-0">
        <img :src="file.preview" class="w-full h-full object-cover" />
      </div>
      <div v-else class="w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0" :class="getFileType(file.type).bg">
        <i :class="[getFileType(file.type).icon, getFileType(file.type).color, 'text-sm']"></i>
      </div>
      <span class="flex items-center min-w-0 gap-1">
        <span class="text-xs font-[530] text-gray-700 truncate max-w-[120px]">{{ file.name }}</span>
        <span class="text-[10px] text-gray-400 flex-shrink-0">{{ formatSize(file.size) }}</span>
      </span>
      <button @click="emit('remove', i)" class="w-5 h-5 flex items-center justify-center rounded-full text-gray-400 hover:text-red-500 hover:bg-red-50 transition-colors opacity-0 group-hover:opacity-100">
        <i class="fas fa-times text-[10px]"></i>
      </button>
    </div>
  </div>
</template>
