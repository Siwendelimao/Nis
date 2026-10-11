<script setup lang="ts">
/* Orbital Sphere 背景（ThreeUI 移植，React 壳 OrbitalSphereBackground 的 Vue 改写）：
   canvas + rAF 渲染循环 + ResizeObserver + IntersectionObserver（不可见时停帧）+ dispose。
   用法：放进任意定位容器（组件自身 absolute inset-0 充满父级）；选项对齐原版 props。
   注：props 用内联类型 + 字面量默认值（与 orbitalSphereRenderer 的 ORBITAL_SPHERE_DEFAULTS 保持一致）。 */
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { createOrbitalSphereRenderer } from './orbitalSphereRenderer'

const props = withDefaults(
  defineProps<{
    speed?: number
    particleSize?: number
    particleOpacity?: number
    orbitOpacity?: number
    scale?: number
    haloOpacity?: number
    hue?: number
  }>(),
  {
    /* = ORBITAL_SPHERE_DEFAULTS（编译期需字面量，改动时两边同步） */
    speed: 1,
    particleSize: 0.015,
    particleOpacity: 0.8,
    orbitOpacity: 0.25,
    scale: 1,
    haloOpacity: 0.2,
    hue: 0
  }
)

const hostEl = ref<HTMLDivElement | null>(null)
const canvasEl = ref<HTMLCanvasElement | null>(null)
const hueDeg = computed(() => props.hue ?? 0)

let renderer: ReturnType<typeof createOrbitalSphereRenderer> | null = null
let frame = 0
let visible = true
let ro: ResizeObserver | null = null
let io: IntersectionObserver | null = null

onMounted(() => {
  const host = hostEl.value
  const canvas = canvasEl.value
  if (!host || !canvas) return
  const opts = { ...props }
  renderer = createOrbitalSphereRenderer(canvas, () => opts)

  const resize = () => {
    const bounds = host.getBoundingClientRect()
    renderer?.resize(bounds.width, bounds.height)
    renderer?.render()
  }
  const tick = () => {
    renderer?.render()
    frame = visible && !document.hidden ? requestAnimationFrame(tick) : 0
  }
  ro = new ResizeObserver(resize)
  io = new IntersectionObserver(([entry]) => {
    visible = entry?.isIntersecting ?? true
    if (visible && !frame) frame = requestAnimationFrame(tick)
    if (!visible && frame) {
      cancelAnimationFrame(frame)
      frame = 0
    }
  })
  ro.observe(host)
  io.observe(host)
  resize()
  frame = requestAnimationFrame(tick)
})

onBeforeUnmount(() => {
  if (frame) cancelAnimationFrame(frame)
  ro?.disconnect()
  io?.disconnect()
  renderer?.dispose()
  renderer = null
})
</script>

<template>
  <div ref="hostEl" class="orbital-sphere-host">
    <canvas ref="canvasEl" :style="{ filter: `hue-rotate(${hueDeg}deg)` }"></canvas>
  </div>
</template>

<style scoped>
.orbital-sphere-host {
  position: absolute;
  inset: 0;
  overflow: hidden;
}
.orbital-sphere-host canvas {
  display: block;
  width: 100%;
  height: 100%;
}
</style>
