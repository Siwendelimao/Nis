<script setup lang="ts">
/**
 * 画布视图（固定 tab，仿 open-pencil 的自研 v0 起点）。
 *  - 当前实现：自由手绘 + 便签文本 + 橡皮 + 清空 + 导出 PNG（本地，无后端）。
 *  - 定位：这是"可测试的画布地基"，明天若走"集成 @open-pencil/vue SDK / cli"，在此容器内替换为真实编辑器即可，
 *    工具栏/视图挂载/固定 tab 机制保持不变。
 */
import { ref, onMounted, onUnmounted } from 'vue'
import { t } from '@/utils/i18n'

const canvasRef = ref<HTMLCanvasElement | null>(null)
const wrapRef = ref<HTMLElement | null>(null)
const tool = ref<'pen' | 'eraser'>('pen')
const color = ref('#111827')
const size = ref(4)
const drawing = ref(false)
const notes = ref<{ id: number; x: number; y: number; text: string }[]>([])
let noteSeq = 1

function resize() {
  const cv = canvasRef.value, wrap = wrapRef.value
  if (!cv || !wrap) return
  const dpr = window.devicePixelRatio || 1
  const snap = cv.toDataURL()  // 保留已有笔迹
  cv.width = Math.max(1, wrap.clientWidth * dpr)
  cv.height = Math.max(1, wrap.clientHeight * dpr)
  cv.style.width = wrap.clientWidth + 'px'
  cv.style.height = wrap.clientHeight + 'px'
  const ctx = cv.getContext('2d')
  if (ctx) { ctx.scale(dpr, dpr); if (snap && snap !== 'data:,') { const img = new Image(); img.onload = () => ctx.drawImage(img, 0, 0, cv.width, cv.height); img.src = snap } }
}
onMounted(() => { resize(); window.addEventListener('resize', resize) })
onUnmounted(() => { window.removeEventListener('resize', resize) })

function pos(e: PointerEvent): { x: number; y: number } | null {
  const cv = canvasRef.value; if (!cv) return null
  const r = cv.getBoundingClientRect()
  return { x: e.clientX - r.left, y: e.clientY - r.top }
}
function start(e: PointerEvent) {
  const p = pos(e); if (!p) return
  drawing.value = true
  const ctx = canvasRef.value?.getContext('2d'); if (!ctx) return
  (e.target as HTMLElement).setPointerCapture?.(e.pointerId)
  ctx.beginPath(); ctx.moveTo(p.x, p.y)
}
function move(e: PointerEvent) {
  if (!drawing.value) return
  const p = pos(e); if (!p) return
  const ctx = canvasRef.value?.getContext('2d'); if (!ctx) return
  ctx.lineCap = 'round'; ctx.lineJoin = 'round'
  ctx.strokeStyle = tool.value === 'eraser' ? '#ffffff' : color.value
  ctx.lineWidth = tool.value === 'eraser' ? size.value * 4 : size.value
  ctx.lineTo(p.x, p.y); ctx.stroke()
}
function end() { drawing.value = false }

function addNote(e: PointerEvent) {
  const p = pos(e); if (!p) return
  notes.value.push({ id: noteSeq++, x: p.x, y: p.y, text: '' })
}
function clear() {
  const cv = canvasRef.value; const ctx = cv?.getContext('2d')
  if (cv && ctx) ctx.clearRect(0, 0, cv.width, cv.height)
  notes.value = []
}
function exportPng() {
  const cv = canvasRef.value; if (!cv) return
  const a = document.createElement('a'); a.href = cv.toDataURL('image/png'); a.download = 'canvas.png'; a.click()
}
</script>

<template>
  <div class="absolute inset-0 flex flex-col bg-white overflow-hidden">
    <!-- 工具栏 -->
    <div class="relative z-20 flex items-center gap-1.5 px-3 py-1.5 border-b border-gray-100 shrink-0">
      <div class="flex items-center bg-gray-100 rounded-lg p-0.5 shrink-0">
        <button @click="tool='pen'" :class="['px-2.5 py-1 rounded-md text-[11px] font-[530] transition-all', tool==='pen'?'bg-gray-900 text-white':'text-gray-600 hover:bg-gray-200']"><i class="fas fa-pen text-[10px] mr-1"></i>{{ t('canvas.pen') }}</button>
        <button @click="tool='eraser'" :class="['px-2.5 py-1 rounded-md text-[11px] font-[530] transition-all', tool==='eraser'?'bg-gray-900 text-white':'text-gray-600 hover:bg-gray-200']"><i class="fas fa-eraser text-[10px] mr-1"></i>{{ t('canvas.eraser') }}</button>
      </div>
      <input type="color" v-model="color" class="w-7 h-7 rounded-md border border-gray-200 bg-white cursor-pointer p-0.5" :title="t('canvas.color')" />
      <input type="range" v-model.number="size" min="1" max="20" class="w-24 accent-gray-900" :title="t('canvas.size')" />
      <span class="text-[11px] text-gray-400 w-6">{{ size }}</span>
      <button @click="addNote" class="btn btn-secondary btn-xs" :title="t('canvas.addNoteTip')"><i class="fas fa-note-sticky mr-1"></i>{{ t('canvas.note') }}</button>
      <div class="flex-1"></div>
      <button @click="exportPng" class="btn btn-secondary btn-xs" :title="t('canvas.exportTip')"><i class="fas fa-download mr-1"></i>{{ t('chat.export') }}</button>
      <button @click="clear" class="btn btn-danger btn-xs" :title="t('canvas.clearTip')"><i class="fas fa-trash mr-1"></i>{{ t('panel.clear') }}</button>
    </div>
    <!-- 画布区 -->
    <div ref="wrapRef" class="flex-1 relative bg-[#fafafa] overflow-hidden" :style="{ cursor: tool==='eraser'?'cell':'crosshair' }">
      <canvas
        ref="canvasRef"
        class="absolute inset-0 touch-none"
        @pointerdown="start" @pointermove="move" @pointerup="end" @pointerleave="end"
      />
      <div
        v-for="n in notes" :key="n.id"
        class="absolute bg-yellow-100 border border-yellow-300 rounded-lg shadow-sm p-1.5"
        :style="{ left: n.x + 'px', top: n.y + 'px', width: '160px' }"
      >
        <textarea
          v-model="n.text" rows="3" :placeholder="t('canvas.notePlaceholder')"
          class="w-full bg-transparent text-[12px] text-gray-700 outline-none resize-none"
        />
        <button class="absolute -top-2 -right-2 w-4 h-4 rounded-full bg-gray-500 text-white text-[9px] flex items-center justify-center" @click="notes = notes.filter(x=>x.id!==n.id)">×</button>
      </div>
      <div v-if="!notes.length" class="absolute bottom-3 left-1/2 -translate-x-1/2 text-[11px] text-gray-400 pointer-events-none">{{ t('canvas.hint') }}</div>
    </div>
  </div>
</template>
