<template>
  <div class="card-shadow" :style="{ width: width + 'px' }">
    <div class="card">
      <div class="scale-labels">
        <span>Low</span>
        <span>Max</span>
      </div>

      <div class="track-wrapper"
           :class="{ active: isActive, full: isFull, 'burning-mode': visualLevel === 'burning' }">

        <div class="track-fill" :style="trackFillStyle"></div>
        <div class="dots-layer">
          <span class="dot" v-for="i in 2" :key="i"></span>
        </div>
        <canvas ref="canvasRef" :style="canvasMask"></canvas>
        <input
          type="range" min="0" max="100" step="1"
          :value="sliderValue"
          :style="{ '--thumb-color': activeColor }"
          @input="onInput"
          @change="onRelease"
          @mousedown="triggerPulse"
          :class="{ 'thumb-pulse': pulsing }"
        />
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch } from 'vue'
import { useWebglFire } from '@/composables/useWebglFire'

const props = defineProps({
  modelValue: { type: String, default: 'deep' },
  width: { type: Number, default: 280 },
  /** 0910：该模型可用的思考挡位（有序子集，如 zai 系去 deep）。缺省=全四挡。
   *  滑块吸附点按传入挡数均分，不可用挡位不落在轨道上=天然"隐藏"。 */
  levels: { type: Array, default: () => ['fast', 'deep', 'heavy', 'burning'] },
})

const emit = defineEmits(['update:modelValue'])

const width = computed(() => props.width || 280)

/* 当前模式（模板直接引用 props.modelValue 的名字） */
const mode = computed(() => props.modelValue || 'deep')

/* ── 动态挡位（0910：按模型声明的可用子集渲染，吸附点均分）── */
const levels = computed(() => {
  const arr = Array.isArray(props.levels) && props.levels.length ? props.levels : ['fast', 'deep', 'heavy', 'burning']
  return arr
})
const snapPoints = computed(() => {
  const n = levels.value.length
  if (n <= 1) return [0]
  return Array.from({ length: n }, (_, i) => Math.round((i / (n - 1)) * 100))
})
const levelToIndex = computed(() => {
  const m = {}
  levels.value.forEach((l, i) => { m[l] = i })
  return m
})

const sliderValue = ref(snapPoints.value[levelToIndex.value[props.modelValue || 'deep'] ?? 1] ?? 50)
const pulsing = ref(false)
let pulseTimer = null

function triggerPulse() {
  pulsing.value = false
  requestAnimationFrame(() => {
    pulsing.value = true
    clearTimeout(pulseTimer)
    pulseTimer = setTimeout(() => { pulsing.value = false }, 450)
  })
}

function nearestLevel(val) {
  const pts = snapPoints.value
  let nearest = 0
  let minDist = Math.abs(val - pts[0])
  for (let i = 1; i < pts.length; i++) {
    const d = Math.abs(val - pts[i])
    if (d < minDist) { minDist = d; nearest = i }
  }
  return nearest
}

let dragging = false

function onInput(e) {
  dragging = true
  const val = parseInt(e.target.value, 10)
  sliderValue.value = val
  const idx = nearestLevel(val)
  emit('update:modelValue', levels.value[idx])
}

function onRelease() {
  dragging = false
  const idx = nearestLevel(sliderValue.value)
  sliderValue.value = snapPoints.value[idx]
  // 松手吸附后补发一次（拖动中 emit 已持续，此处兜底确保最终档位生效）
  emit('update:modelValue', levels.value[idx])
  triggerPulse()
}

// 外部（父组件）改模式时才同步滑块位置；拖动中不吸附（避免"从 max 推不下来/轨道形态不跟随"）
watch(() => props.modelValue, (v) => {
  if (dragging) return
  const idx = levelToIndex.value[v || 'deep']
  sliderValue.value = snapPoints.value[idx] ?? 50
}, { immediate: true })
// 0910：换模型致可用挡位变化（如 zai 系无 deep）→ 重吸附到当前挡（父组件负责钳值）
watch(snapPoints, () => {
  if (dragging) return
  const idx = levelToIndex.value[props.modelValue || 'deep']
  sliderValue.value = snapPoints.value[idx] ?? sliderValue.value
})

/* 视觉形态直接跟随滑块位置（拖动即刻生效，不等父组件回传——轨道动效实时变） */
const visualLevel = computed(() => levels.value[nearestLevel(sliderValue.value)])

const isActive = computed(() => sliderValue.value >= 50)
const isFull = computed(() => sliderValue.value === 100)

const canvasMask = computed(() => {
  return {
    opacity: visualLevel.value === 'burning' ? 0.7 : 0,
    filter: canvasFilter.value,
  }
})

const canvasFilter = computed(() => {
  const filters = {
    deep: 'hue-rotate(0deg) saturate(1.2)',
    heavy: 'hue-rotate(0deg) saturate(1.5) brightness(1.1)',
    burning: '',
  }
  return filters[visualLevel.value || 'deep'] || ''
})

const activeColor = computed(() => {
  const colors = {
    fast: '#10B981',
    deep: '#3B82F6',
    heavy: '#EF4444',
    burning: '#8B5CF6',
  }
  return colors[visualLevel.value || 'deep']
})

const trackFillStyle = computed(() => {
  if (visualLevel.value === 'burning') return { opacity: 0 }
  const p = sliderValue.value
  const extra = visualLevel.value === 'deep' ? 10 : 0
  return {
    width: `calc(${p}% + ${extra}px)`,
    background: `linear-gradient(90deg, ${activeColor.value}40, ${activeColor.value}80)`,
    boxShadow: `0 0 8px ${activeColor.value}30`,
  }
})

const canvasRef = ref(null)
useWebglFire(canvasRef, sliderValue, isActive)
</script>

<style scoped>
.card-shadow {
  filter: drop-shadow(0 4px 12px rgba(0, 0, 0, 0.08));
}

.card {
  background: transparent;
  border: none;
  border-radius: 12px;
  padding: 10px 14px 8px;
  user-select: none;
}

.scale-labels {
  display: flex;
  justify-content: space-between;
  font-size: 10px;
  font-weight: 600;
  color: #9CA3AF;
  margin-bottom: 6px;
}

/* track */
.track-wrapper {
  position: relative;
  height: 26px;
  border-radius: 13px;
  border: 1px solid rgba(139, 92, 246, 0.12);
  background: rgba(139, 92, 246, 0.05);
  isolation: isolate;
}

.track-wrapper.burning-mode {
  background: transparent;
}

.track-fill {
  position: absolute;
  top: 0;
  left: 0;
  height: 100%;
  border-radius: 13px;
  z-index: 1;
  transition: width 0.15s ease, background 0.3s ease;
  pointer-events: none;
}

.burning-mode .track-bg {
  background: transparent;
}

.track-fill {
  position: absolute;
  top: 0;
  left: 0;
  height: 100%;
  border-radius: 13px;
  z-index: 1;
  transition: width 0.1s ease, background 0.3s ease;
  opacity: 0.35;
  overflow: hidden;
}

.track-fill::after {
  content: '';
  position: absolute;
  top: 50%;
  right: 0;
  width: 40%;
  height: 200%;
  transform: translateY(-50%);
  background: radial-gradient(ellipse at right center, rgba(255,255,255,0.5), transparent 70%);
  animation: haloLeft ease-in-out infinite;
  animation-duration: var(--fill-speed, 3s);
  filter: blur(2px);
}

@keyframes haloLeft {
  0% { right: 0%; opacity: 0; transform: translateY(-50%) scale(0.5); }
  30% { opacity: 1; transform: translateY(-50%) scale(1); }
  70% { opacity: 1; }
  100% { right: 80%; opacity: 0; transform: translateY(-50%) scale(0.8); }
}

canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  opacity: 0;
  mix-blend-mode: screen;
  z-index: 2;
  transition: opacity 0.3s;
  border-radius: 13px;
}

.track-wrapper.burning-mode canvas {
  opacity: 1;
  z-index: 4;
}

.dots-layer {
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 1;
}

.dot {
  position: absolute;
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: #6B7280;
  top: 50%;
  transform: translateY(-50%);
  transition: opacity 0.6s;
}

.track-wrapper.active .dot { opacity: 0.2; }
.track-wrapper.full .dot { opacity: 0; }

.dot:nth-child(1) { left: 33%; }
.dot:nth-child(2) { left: 66%; }

/* range input */
input[type='range'] {
  position: absolute;
  top: 0;
  left: -2px;
  width: calc(100% + 5px);
  height: 100%;
  background: transparent;
  -webkit-appearance: none;
  appearance: none;
  cursor: pointer;
  z-index: 5;
  outline: none;
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

input[type='range']::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 26px;
  height: 26px;
  border-radius: 50%;
  background: linear-gradient(170deg, #ffffff 0%, #f0f0f2 40%, #e4e4e6 100%);
  border: 2px solid var(--thumb-color, #6366F1);
  box-shadow: 0 0 6px var(--thumb-color, rgba(99, 102, 241, 0.5)),
    inset 0 0.5px 0 rgba(255, 255, 255, 0.85),
    inset 0 -0.5px 0 rgba(0, 0, 0, 0.06);
  cursor: grab;
  transition: border-color 0.3s ease, box-shadow 0.3s ease, transform 0.15s ease;
}

input[type='range']::-webkit-slider-thumb:active {
  cursor: grabbing;
  transform: scale(0.92);
}

input[type='range'].thumb-pulse::-webkit-slider-thumb {
  animation: thumb-pulse 0.4s ease-out;
}

@keyframes thumb-pulse {
  0%   { transform: scale(1); }
  30%  { transform: scale(1.15); }
  60%  { transform: scale(0.95); }
  100% { transform: scale(1); }
}

input[type='range']::-moz-range-thumb {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background: linear-gradient(170deg, #ffffff 0%, #f0f0f2 40%, #e4e4e6 100%);
  border: 2px solid var(--thumb-color, #6366F1);
  box-shadow: 0 0 6px var(--thumb-color, rgba(99, 102, 241, 0.5));
  cursor: grab;
  transition: border-color 0.3s ease, box-shadow 0.3s ease, transform 0.15s ease;
}

input[type='range']::-moz-range-thumb:active {
  cursor: grabbing;
  transform: scale(0.92);
}

input[type='range']::-moz-range-track {
  background: transparent;
  border: none;
  height: 26px;
}
</style>
