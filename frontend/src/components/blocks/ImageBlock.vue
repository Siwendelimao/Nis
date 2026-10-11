<script setup lang="ts">
import { ref } from 'vue'
import { usePreviewTabsStore } from '@/stores/previewTabs'
import { useConversationsStore } from '@/stores/conversations'
import { t } from '@/utils/i18n'

const props = defineProps<{ content: string; src?: string; alt?: string }>()

const showModal = ref(false)
const scale = ref(1)
const offsetX = ref(0)
const offsetY = ref(0)
const isDragging = ref(false)
const startX = ref(0)
const startY = ref(0)

function zoomIn() {
  scale.value = Math.min(scale.value + 0.25, 3)
}

function zoomOut() {
  scale.value = Math.max(scale.value - 0.25, 0.25)
  if (scale.value <= 1) {
    offsetX.value = 0
    offsetY.value = 0
  }
}

function resetZoom() {
  scale.value = 1
  offsetX.value = 0
  offsetY.value = 0
}

function onWheel(e: WheelEvent) {
  e.preventDefault()
  if (e.deltaY < 0) {
    scale.value = Math.min(scale.value + 0.1, 3)
  } else {
    scale.value = Math.max(scale.value - 0.1, 0.25)
    if (scale.value <= 1) {
      offsetX.value = 0
      offsetY.value = 0
    }
  }
}

function onMouseDown(e: MouseEvent) {
  if (scale.value <= 1) return
  isDragging.value = true
  startX.value = e.clientX - offsetX.value
  startY.value = e.clientY - offsetY.value
  e.preventDefault()
}

function onMouseMove(e: MouseEvent) {
  if (!isDragging.value) return
  offsetX.value = e.clientX - startX.value
  offsetY.value = e.clientY - startY.value
}

function onMouseUp() {
  isDragging.value = false
}

function closeModal() {
  showModal.value = false
  scale.value = 1
  offsetX.value = 0
  offsetY.value = 0
}

/** 预览打开：远程图片走 browser tab（iframe），本地 dataURL 走 image tab */
function openInPreviewTab() {
  const src = props.src || props.content
  if (!src) return
  const conversations = useConversationsStore()
  const convId = String(conversations.activeConversationId ?? '')
  if (!convId) return
  const previewTabs = usePreviewTabsStore()
  if (src.startsWith('data:')) {
    previewTabs.openTab(convId, {
      key: 'img:' + (props.alt || src.slice(0, 40)),
      kind: 'image',
      title: props.alt || t('image.previewTitle'),
      dataUrl: src,
    })
  } else {
    previewTabs.openTab(convId, {
      key: 'url:' + src,
      kind: 'browser',
      title: props.alt || t('image.previewTitle'),
      src,
    })
  }
}
</script>
<template>
  <div class="my-2 rounded-lg overflow-hidden border border-gray-200 inline-block max-w-[360px] relative group/img">
    <img :src="src || props.content" :alt="alt || 'image'" class="max-w-full h-auto block cursor-pointer hover:opacity-90 transition-opacity" @click="showModal = true" />
    <button
      @click="openInPreviewTab"
      class="absolute top-2 right-2 px-2 py-1 rounded-lg bg-black/60 text-white text-[10px] font-medium opacity-0 group-hover/img:opacity-100 transition-opacity hover:bg-black/80"
      :title="t('image.openInTab')"
    ><i class="fas fa-expand mr-1"></i>{{ t('image.openBtn') }}</button>
    <div v-if="alt" class="px-3 py-1.5 bg-gray-50 text-xs text-gray-500 border-t border-gray-100">{{ alt }}</div>
  </div>

  <Teleport to="body">
    <div v-if="showModal" class="fixed inset-0 z-[9999] flex items-center justify-center" @click.self="closeModal" @mouseup="onMouseUp" @mouseleave="onMouseUp" @wheel="onWheel">
      <div class="absolute inset-0 bg-black/70"></div>
      <div class="relative z-10 flex flex-col items-center gap-4">
        <!-- 工具栏 -->
        <div class="flex items-center gap-2 bg-white rounded-xl shadow-lg px-3 py-2">
          <button @click="zoomIn" class="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-gray-100 text-gray-600" :title="t('panel.zoomIn')"><i class="fas fa-search-plus text-sm"></i></button>
          <button @click="zoomOut" class="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-gray-100 text-gray-600" :title="t('panel.zoomOut')"><i class="fas fa-search-minus text-sm"></i></button>
          <button @click="resetZoom" class="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-gray-100 text-gray-600" :title="t('image.resetZoom')"><i class="fas fa-compress-arrows-alt text-sm"></i></button>
          <span class="text-xs text-gray-400 ml-2 font-mono w-10 text-center">{{ Math.round(scale * 100) }}%</span>
        </div>
        <!-- 图片容器 -->
        <div
          class="overflow-hidden rounded-lg flex items-center justify-center"
          :style="{ width: '80vw', height: '75vh' }"
          @mousedown="onMouseDown"
          @mousemove="onMouseMove"
        >
          <img
            :src="src || props.content"
            :alt="alt || 'image'"
            class="max-w-full max-h-full object-contain transition-transform duration-200"
            :class="scale > 1 ? (isDragging ? 'cursor-grabbing' : 'cursor-grab') : 'cursor-default'"
            :style="{
              transform: `translate(${offsetX}px, ${offsetY}px) scale(${scale})`,
              transformOrigin: 'center center'
            }"
            draggable="false"
          />
        </div>
        <!-- 关闭 -->
        <button @click="closeModal" class="absolute top-4 right-4 w-9 h-9 bg-white rounded-full shadow-lg flex items-center justify-center text-gray-500 hover:text-gray-700 hover:shadow-xl transition-all">
          <i class="fas fa-times"></i>
        </button>
      </div>
    </div>
  </Teleport>
</template>
