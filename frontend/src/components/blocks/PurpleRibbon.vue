<script setup lang="ts">
/**
 * PurpleRibbon —— 紫色飘带动画（思考/工具运行中）
 * canvas 绘制多条流动的紫色丝带（正弦贝塞尔带 + 渐隐），替代"球状"的 ThinkingOrb ribbon
 */
import { ref, onMounted, onUnmounted } from 'vue'

const props = withDefaults(defineProps<{
  size?: number
}>(), { size: 20 })

const canvasRef = ref<HTMLCanvasElement | null>(null)
let raf = 0
let t = 0

const BANDS = [
  { color: '#7c3aed', phase: 0, speed: 1.4, amp: 0.16, alpha: 0.9 },
  { color: '#8b5cf6', phase: 2.1, speed: 1.9, amp: 0.12, alpha: 0.75 },
  { color: '#a78bfa', phase: 4.2, speed: 1.1, amp: 0.2, alpha: 0.6 },
]

function frame() {
  const canvas = canvasRef.value
  if (!canvas) return
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const S = props.size
  const dpr = window.devicePixelRatio || 1
  if (canvas.width !== S * dpr) {
    canvas.width = S * dpr
    canvas.height = S * dpr
    canvas.style.width = S + 'px'
    canvas.style.height = S + 'px'
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, S, S)
  t += 0.05

  const mid = S / 2
  for (const band of BANDS) {
    const amp = S * band.amp
    ctx.beginPath()
    for (let x = 0; x <= S; x += 1.5) {
      const u = x / S
      // 飘带：主波 + 次波叠加，随时间流动
      const wave =
        Math.sin(u * Math.PI * 2 * 1.6 + t * band.speed + band.phase) * amp
        + Math.sin(u * Math.PI * 2 * 0.8 + t * band.speed * 0.6 + band.phase * 2) * amp * 0.45
      const y = mid + wave
      if (x === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    // 渐变透明度：两端淡、中间亮（丝带感）
    const grad = ctx.createLinearGradient(0, 0, S, 0)
    grad.addColorStop(0, band.color + '00')
    grad.addColorStop(0.25, band.color + '66')
    grad.addColorStop(0.5, band.color + 'cc')
    grad.addColorStop(0.75, band.color + '66')
    grad.addColorStop(1, band.color + '00')
    ctx.strokeStyle = grad
    ctx.globalAlpha = band.alpha
    ctx.lineCap = 'round'
    ctx.lineWidth = 1.4
    ctx.stroke()
  }
  ctx.globalAlpha = 1
  raf = requestAnimationFrame(frame)
}

onMounted(() => { raf = requestAnimationFrame(frame) })
onUnmounted(() => cancelAnimationFrame(raf))
</script>

<template>
  <canvas ref="canvasRef" aria-hidden="true" style="display:block;" />
</template>
