<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import * as d3 from 'd3'

/**
 * 灰色线框旋转地球（d3 geoOrthographic）。
 * 纯展示：自动旋转，不可拖拽/缩放，不可选中文本。
 * 大陆数据已下载到本地 public/earth-land.json（离线可用，打包保留）。
 * 配色：灰线 + 透明背景（作为聊天空态背景）。
 * 性能：无点阵，仅三条 stroke 路径（边缘圆/经纬网/大陆轮廓），开销极低。
 */
const props = defineProps<{
  /** 地球渲染尺寸（px），默认 560；传大值原生高清渲染，缩放不糊 */
  size?: number
  /** ★1011（老大反馈"窗口缩小后地球被遮挡"）：fit=true 时 size 退化为**上限**，实际尺寸跟随容器（取容器较小边 ×0.92，下限 280）。旧行为尺寸写死 900，容器一小画布就溢出被窗口裁掉。默认 false ⇒ 其它调用点行为不变。 */
  fit?: boolean
}>()

let SIZE = props.size || 560   // ★1011：fit 模式会在 onMounted 里按容器重算

const canvasRef = ref<HTMLCanvasElement | null>(null)

let cleanupFns: Array<() => void> = []

const LAND_URL = '/earth-land.json'

// 模块级缓存：大陆数据只 fetch 一次，后续打开聊天窗口立即复用，无延迟
let cachedLand: any = null
let loadPromise: Promise<void> | null = null

async function loadLandData(): Promise<void> {
  if (cachedLand) return
  if (loadPromise) return loadPromise
  loadPromise = (async () => {
    try {
      const res = await fetch(LAND_URL)
      if (!res.ok) throw new Error('failed to load land data')
      cachedLand = await res.json()
    } catch {
      cachedLand = null
    }
  })()
  return loadPromise
}

// 配色：浅灰线（透明背景，无黑色球体、无点阵）
// 灰度经过实测调优：太浅（#efefef）透过输入框玻璃几乎不可见，取中灰保证轮廓清晰
const COLOR_GRATICULE = '#dddddd'
const COLOR_LAND = '#bbbbbb'
const COLOR_RIM = '#c9c9c9' // 球体边缘圆

onMounted(async () => {
  const canvas = canvasRef.value
  if (!canvas) return
  const context = canvas.getContext('2d')
  if (!context) return

  /* ★1011：fit 模式按容器定尺寸 —— 取容器较小边 ×0.92（球外圈留余量，不被裁），
     并以 props.size 为上限（移动端仍受 420 限制，保住"手机端别开 900×900 每帧重绘"的降采样）。 */
  if (props.fit) {
    const host = canvas.parentElement
    const cw = host?.clientWidth || window.innerWidth || 900
    const ch = host?.clientHeight || window.innerHeight || 900
    SIZE = Math.max(280, Math.min(props.size || 900, Math.round(Math.min(cw, ch) * 0.92)))
  }

  let landFeatures: any = null
  let projection: any = null
  let path: any = null
  let timer: { stop: () => void } | null = null

  // 数据未就绪前保持隐藏：避免先看到裸圆环再看到地球
  canvas.style.opacity = '0'

  const containerWidth = SIZE
  const containerHeight = SIZE
  const radius = containerHeight / 2.6
  const dpr = window.devicePixelRatio || 1
  canvas.width = containerWidth * dpr
  canvas.height = containerHeight * dpr
  canvas.style.width = `${containerWidth}px`
  canvas.style.height = `${containerHeight}px`
  context.scale(dpr, dpr)

  projection = d3
    .geoOrthographic()
    .scale(radius)
    .translate([containerWidth / 2, containerHeight / 2])
    .clipAngle(90)

  path = d3.geoPath().projection(projection).context(context)

  const render = () => {
    context.clearRect(0, 0, containerWidth, containerHeight)

    const currentScale = projection.scale()
    const scaleFactor = currentScale / radius

    // 透明背景 + 灰色球体边缘圆（无黑色球体填充）
    context.beginPath()
    context.arc(containerWidth / 2, containerHeight / 2, currentScale, 0, 2 * Math.PI)
    context.strokeStyle = COLOR_RIM
    context.lineWidth = 1.5 * scaleFactor
    context.stroke()

    if (landFeatures) {
      // 经纬网（灰色细线）
      const graticule = d3.geoGraticule()
      context.beginPath()
      path(graticule())
      context.strokeStyle = COLOR_GRATICULE
      context.lineWidth = 1 * scaleFactor
      context.globalAlpha = 0.65
      context.stroke()
      context.globalAlpha = 1

      // 大陆轮廓（灰色）
      context.beginPath()
      landFeatures.features.forEach((feature: any) => path(feature))
      context.strokeStyle = COLOR_LAND
      context.lineWidth = 1.2 * scaleFactor
      context.stroke()
    }
  }

  // 自动旋转：降频渲染（约 20fps，足够肉眼平滑），大幅降低主线程占用
  const rotation = [0, 0]
  const FRAME_MS = 50
  let lastFrame = 0
  timer = d3.timer((elapsed) => {
    if (elapsed - lastFrame < FRAME_MS) return
    lastFrame = elapsed
    rotation[0] += 0.5
    projection.rotate(rotation)
    render()
  })

  cleanupFns.push(() => timer?.stop())

  // 加载大陆数据（模块级缓存：首次 fetch，后续复用）
  await loadLandData()
  landFeatures = cachedLand

  // 数据就绪后一次性显示完整地球（淡入 + 放大动画）
  render()
  canvas.classList.add('globe-visible')
})

onUnmounted(() => {
  cleanupFns.forEach(fn => fn())
  cleanupFns = []
})
</script>

<template>
  <div class="pointer-events-none select-none absolute inset-0 flex items-center justify-center overflow-hidden">
    <canvas ref="canvasRef" class="globe-in"></canvas>
  </div>
</template>

<style scoped>
/* 地球出现：淡入 + 轻微放大 */
/* ★1011：兜底 —— 容器比画布还小时，画布等比缩进容器（inline width/height 会被 max-* 限制），
   这样窗口随便拖都不会出现"球缺一块"。 */
.globe-in {
  max-width: 100%;
  max-height: 100%;
  opacity: 0;
}
.globe-in.globe-visible {
  opacity: 1;
  animation: globeEntrance 0.9s cubic-bezier(0.16, 1, 0.3, 1) both;
}
@keyframes globeEntrance {
  from {
    opacity: 0;
    transform: scale(0.92);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}
</style>
