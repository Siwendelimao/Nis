<script setup lang="ts">
/**
 * ImageViewer —— 全屏图片查看器
 * - 点击图片标签打开，全屏黑色遮罩
 * - 滚轮/按钮缩放，拖动抓手平移，点击空白/✕/Esc 关闭
 */
import { ref, watch, onMounted, onBeforeUnmount } from 'vue'
import { t } from '@/utils/i18n'

const props = defineProps<{ src: string | null }>()
const emit = defineEmits<{ close: [] }>()

/* ★1011b：右键复制（图片天生是"要发给别人/贴到别处"的东西，右键即取） */
const menu = ref<{ x: number; y: number } | null>(null)
const toast = ref('')

const scale = ref(1)
const tx = ref(0)
const ty = ref(0)
const dragging = ref(false)
const startX = ref(0)
const startY = ref(0)
const startTx = ref(0)
const startTy = ref(0)

watch(() => props.src, (v) => {
  scale.value = 1
  tx.value = 0
  ty.value = 0
  if (v) document.body.style.overflow = 'hidden'
})

function zoomBy(d: number) {
  scale.value = Math.min(4, Math.max(0.5, Math.round((scale.value + d) * 10) / 10))
}
function onWheel(e: WheelEvent) {
  if (e.deltaY < 0) zoomBy(0.1)
  else zoomBy(-0.1)
}
function onMouseDown(e: MouseEvent) {
  dragging.value = true
  startX.value = e.clientX
  startY.value = e.clientY
  startTx.value = tx.value
  startTy.value = ty.value
  e.preventDefault()
}
function onMouseMove(e: MouseEvent) {
  if (!dragging.value) return
  tx.value = startTx.value + (e.clientX - startX.value)
  ty.value = startTy.value + (e.clientY - startY.value)
}
function stopDrag() {
  dragging.value = false
}
function close() {
  document.body.style.overflow = ''
  emit('close')
}
function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') close()
}

/** 右键菜单：位置夹在视口内，别让菜单跑出屏幕 */
function openMenu(e: MouseEvent) {
  if (!props.src) return
  menu.value = {
    x: Math.min(e.clientX, window.innerWidth - 150),
    y: Math.min(e.clientY, window.innerHeight - 56),
  }
}

/** 复制当前图片到剪贴板。剪贴板只吃 image/png：非 PNG 先过 canvas 转一道。
 *  ⚠️ 直接给 ClipboardItem 塞 Promise（而不是先 await fetch 再 write）—— write 要求
 *  "用户手势"仍在生效，中间多一次 await 就可能被浏览器判成非手势而拒绝。 */
async function copyImage() {
  const src = props.src
  menu.value = null
  if (!src) return
  try {
    const pngBlob = async (): Promise<Blob> => {
      const blob = await (await fetch(src)).blob()
      if (blob.type === 'image/png') return blob
      const url = URL.createObjectURL(blob)
      try {
        return await new Promise<Blob>((resolve, reject) => {
          const img = new Image()
          img.onload = () => {
            const cv = document.createElement('canvas')
            cv.width = img.width
            cv.height = img.height
            cv.getContext('2d')?.drawImage(img, 0, 0)
            cv.toBlob(b => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png')
          }
          img.onerror = () => reject(new Error('decode failed'))
          img.src = url
        })
      } finally { URL.revokeObjectURL(url) }
    }
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob() })])
    toast.value = t('viewer.copied')
  } catch {
    toast.value = t('viewer.copyFailed')
  }
  setTimeout(() => { toast.value = '' }, 1800)
}

onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  document.body.style.overflow = ''
})
</script>

<template>
  <Teleport to="body">
    <div
      v-if="src"
      class="fixed inset-0 z-[9999] bg-black/85 select-none"
      @click.self="close"
      @wheel.prevent="onWheel"
      @mousedown="onMouseDown"
      @mousemove="onMouseMove"
      @mouseup="stopDrag"
      @mouseleave="stopDrag"
      @contextmenu.prevent="openMenu"
    >
      <div class="absolute top-4 right-4 flex items-center gap-1.5 z-10">
        <button class="w-9 h-9 rounded-lg bg-white/10 hover:bg-white/25 text-white text-lg font-medium" @click.stop="zoomBy(0.1)">+</button>
        <span class="text-white/80 text-xs w-12 text-center tabular-nums">{{ Math.round(scale * 100) }}%</span>
        <button class="w-9 h-9 rounded-lg bg-white/10 hover:bg-white/25 text-white text-lg font-medium" @click.stop="zoomBy(-0.1)">−</button>
        <button class="w-9 h-9 rounded-lg bg-white/10 hover:bg-white/25 text-white ml-2" @click.stop="close">✕</button>
      </div>
      <div class="w-full h-full flex items-center justify-center overflow-hidden">
        <img
          :src="src"
          class="max-w-[92vw] max-h-[92vh] object-contain select-none"
          :class="dragging ? 'cursor-grabbing' : 'cursor-grab'"
          :style="{ transform: `translate(${tx}px, ${ty}px) scale(${scale})` }"
          draggable="false"
          @dragstart.prevent
        />
      </div>
    </div>
    <!-- ★1011b：右键菜单（复制图片）。先铺一层透明遮罩：点别处/在别处右键即关 -->
    <div v-if="menu" class="fixed inset-0 z-[10000]" @click="menu = null" @contextmenu.prevent="menu = null"></div>
    <div
      v-if="menu"
      class="fixed z-[10001] min-w-[132px] rounded-lg border border-gray-200 bg-white py-1 shadow-xl"
      :style="{ left: menu.x + 'px', top: menu.y + 'px' }"
    >
      <button class="flex w-full items-center gap-2 px-3 py-1.5 text-[12px] text-gray-700 hover:bg-gray-100" @click="copyImage">
        <i class="fas fa-copy text-[11px]"></i>{{ t('viewer.copyImage') }}
      </button>
    </div>
    <div v-if="toast" class="fixed bottom-10 left-1/2 z-[10001] -translate-x-1/2 rounded-lg bg-black/75 px-3 py-1.5 text-[12px] text-white">
      {{ toast }}
    </div>
  </Teleport>
</template>
