<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from 'vue'

export interface GalaxyNode {
  id: string
  title: string
  summary?: string
  colorKey?: string
  color?: string
  [key: string]: any
}

export interface GalaxyEdge {
  id: string
  source: string
  target: string
  relation?: string
}

const props = defineProps<{
  items: GalaxyNode[]
  edges?: GalaxyEdge[]
  selectedId?: string | null
  showLabels?: boolean
}>()

const emit = defineEmits<{
  select: [id: string | null]
}>()

/**
 * 知识星云（Knowledge Nebula）—— 知识库专用视觉（0914c 第 5 版 · 参照用户参考图）。
 *  · 形态：一团"由小原子点织成的光网云"——每条知识 = 一颗彩色主原子，
 *    周围环绕 15~25 颗同色小微原子并以细线织成小网（每个类型 = 一簇颜色）；
 *  · 整团外围 + 内部散布数百颗白粒子（星尘雾），背景暖黑；
 *  · 关联线（真实数据）：平时以低亮细线呈现；**悬停/选中某颗知识 → 它的整簇微网点亮，
 *    到各关联知识的弧线高举并跑流光**；
 *  · 交互：拖拽 = 旋转云团，滚轮 = 缩放，点选 = 右侧详情；整体缓慢自转。
 *  · 纯平面（无透视），点/线/粒皆按极坐标旋转，无任何"斜线/裁切"隐患。
 */

const canvasRef = ref<HTMLCanvasElement | null>(null)

function hashStr(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}
function mulberry32(seed: number) {
  return function () {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const TYPE_COLORS: Record<string, string> = {
  doc: '#9ec9ff',
  manual: '#9fe8e6',
  note: '#c4ef7e',
  reference: '#f9b3d6',
  knowledge: '#7fe8d4',
  category: '#f7d774',
  pending: '#ffb066',
  default: '#a9b8d8',
}

// ── 世界坐标 ──
const R = 300

interface Cluster { key: string; color: string; cx: number; cy: number }
interface KNode {
  node: GalaxyNode
  x: number; y: number
  size: number
  color: string
  sprite: HTMLCanvasElement
  phase: number
  pending: boolean
  deg: number
}
interface Sat { x: number; y: number; r: number; color: string; ph: number; owner: string }
interface DecoLine { x1: number; y1: number; x2: number; y2: number; color: string; a: number; owner: string }
interface Particle { x: number; y: number; r: number; ph: number; a: number; sp: number }

let clusters: Cluster[] = []
let kn: KNode[] = []
let sats: Sat[] = []
let deco: DecoLine[] = []
let particles: Particle[] = []
let bgStars: Array<{ x: number; y: number; tw: number; sz: number }> = []

let realEdges: Array<{ a: string; b: string }> = []
let adj = new Map<string, Set<string>>()

const spriteCache = new Map<string, HTMLCanvasElement>()
function spriteFor(color: string): HTMLCanvasElement {
  const hit = spriteCache.get(color)
  if (hit) return hit
  const s = 96
  const c = document.createElement('canvas')
  c.width = c.height = s
  const ctx = c.getContext('2d')!
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2)
  g.addColorStop(0, 'rgba(255,255,255,1)')
  g.addColorStop(0.2, color)
  g.addColorStop(0.55, 'rgba(150,165,205,0.18)')
  g.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, s, s)
  spriteCache.set(color, c)
  return c
}

function build() {
  const items = props.items || []
  adj = new Map()
  const deg = new Map<string, number>()
  for (const n of items) { adj.set(n.id, new Set()); deg.set(n.id, 0) }
  for (const e of (props.edges || [])) {
    if (!adj.has(e.source) || !adj.has(e.target)) continue
    adj.get(e.source)!.add(e.target)
    adj.get(e.target)!.add(e.source)
    deg.set(e.source, (deg.get(e.source) || 0) + 1)
    deg.set(e.target, (deg.get(e.target) || 0) + 1)
  }
  realEdges = (props.edges || [])
    .filter((e) => adj.has(e.source) && adj.has(e.target))
    .map((e) => ({ a: e.source, b: e.target }))

  // 按类型分簇（每簇一种颜色）
  const groups = new Map<string, GalaxyNode[]>()
  for (const n of items) {
    const k = String(n.colorKey || 'default')
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k)!.push(n)
  }
  const keys = Array.from(groups.keys()).sort()
  const K = Math.max(1, keys.length)
  clusters = keys.map((k, i) => {
    const ang = (i / K) * Math.PI * 2 + 0.65
    const cr = R * (0.38 + (i % 2) * 0.14)
    return { key: k, color: TYPE_COLORS[k] || TYPE_COLORS.default, cx: Math.cos(ang) * cr, cy: Math.sin(ang) * cr }
  })

  // 知识原子（真实条目）
  kn = []
  for (let ci = 0; ci < clusters.length; ci++) {
    const cl = clusters[ci]
    const list = groups.get(cl.key)!
    for (const node of list) {
      const rand = mulberry32(hashStr(node.id))
      const d = deg.get(node.id) || 0
      kn.push({
        node,
        x: cl.cx + (rand() - 0.5) * R * 0.3,
        y: cl.cy + (rand() - 0.5) * R * 0.3,
        size: 11 + Math.min(12, d * 2.8),
        color: cl.color,
        sprite: spriteFor(cl.color),
        phase: rand() * Math.PI * 2,
        pending: node.colorKey === 'pending' || node.pending === true,
        deg: d,
      })
    }
  }

  // 0914c 修订（用户："一个知识是一个节点不是一簇"）：不再生成装饰性卫星星簇与织网线，
  // 只保留真实条目节点 + 真实关联线（平时极淡、悬停点亮）。
  sats = []
  deco = []

  // 粒子雾（外围星尘 + 内部浮尘）
  particles = []
  const pr = mulberry32(31337)
  for (let i = 0; i < 210; i++) {
    const ang = pr() * Math.PI * 2
    const rr = R * (0.5 + Math.pow(pr(), 0.7) * 0.82)
    particles.push({ x: Math.cos(ang) * rr, y: Math.sin(ang) * rr, r: 0.6 + pr() * 1.2, ph: pr() * Math.PI * 2, a: 0.15 + pr() * 0.38, sp: 0.3 + pr() * 0.8 })
  }
  for (let i = 0; i < 65; i++) {
    const ang = pr() * Math.PI * 2
    const rr = R * (0.1 + Math.pow(pr(), 0.8) * 0.45)
    particles.push({ x: Math.cos(ang) * rr, y: Math.sin(ang) * rr, r: 0.6 + pr() * 1.1, ph: pr() * Math.PI * 2, a: 0.1 + pr() * 0.26, sp: 0.3 + pr() * 0.8 })
  }
  if (!userZoom) fitZoom()
}

// ── 画布 / 相机 ──
let raf = 0
let ctx: CanvasRenderingContext2D | null = null
let width = 0
let height = 0
let dpr = 1
let interacting = false
let hoveredId: string | null = null

let cam = { zoom: 0.5 }
let userZoom = false
let rot = 0
let screenCache = new Map<string, { x: number; y: number }>()

function toScreen(x: number, y: number) {
  const cs = Math.cos(rot)
  const sn = Math.sin(rot)
  const rx = x * cs - y * sn
  const ry = x * sn + y * cs
  return { x: width / 2 + rx * cam.zoom, y: height / 2 + ry * cam.zoom }
}

function fitZoom() {
  const el = canvasRef.value?.parentElement
  if (!el) return
  const w = el.clientWidth || 800
  const h = el.clientHeight || 600
  cam.zoom = Math.max(0.18, Math.min(1.5, Math.min((h * 0.9) / (2 * R * 1.3), (w * 0.95) / (2 * R * 1.3))))
}

function buildBgStars() {
  bgStars = []
  const rand = mulberry32(9090)
  for (let i = 0; i < 70; i++) {
    bgStars.push({ x: rand(), y: rand(), tw: rand() * Math.PI * 2, sz: 0.5 + rand() * 0.8 })
  }
}

function resize() {
  const canvas = canvasRef.value
  if (!canvas || !canvas.parentElement) return
  dpr = window.devicePixelRatio || 1
  const w = canvas.parentElement.clientWidth
  const h = canvas.parentElement.clientHeight
  width = w
  height = h
  canvas.width = w * dpr
  canvas.height = h * dpr
  canvas.style.width = `${w}px`
  canvas.style.height = `${h}px`
  ctx = canvas.getContext('2d')!
  if (!userZoom) fitZoom()
}

// ── 绘制 ──
function draw() {
  if (!ctx) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.globalCompositeOperation = 'source-over'

  // 暖黑夜幕（参照图的底色）
  const bg = ctx.createRadialGradient(width / 2, height / 2, 0, width / 2, height / 2, Math.max(width, height) * 0.8)
  bg.addColorStop(0, '#0a0c13')
  bg.addColorStop(0.55, '#05070c')
  bg.addColorStop(1, '#020305')
  ctx.fillStyle = bg
  ctx.fillRect(0, 0, width, height)

  const now = performance.now()
  const tSec = now / 1000

  for (const s of bgStars) {
    const px = s.x * width
    const py = s.y * height * 0.9
    const tw = 0.5 + 0.5 * Math.sin(now / 1100 + s.tw)
    ctx.globalAlpha = 0.05 + 0.14 * tw
    ctx.fillStyle = '#bcd0e8'
    ctx.fillRect(px, py, s.sz, s.sz)
  }
  ctx.globalAlpha = 1

  const focusId = hoveredId || props.selectedId || null
  const related = new Set<string>()
  if (focusId) {
    related.add(focusId)
    const nb = adj.get(focusId)
    if (nb) for (const id of nb) related.add(id)
  }

  // 簇心柔光（彩色霭）
  ctx.globalCompositeOperation = 'lighter'
  for (const cl of clusters) {
    const p = toScreen(cl.cx, cl.cy)
    const rad = R * 0.5 * cam.zoom
    const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, rad)
    g.addColorStop(0, hexA(cl.color, 0.07))
    g.addColorStop(0.6, hexA(cl.color, 0.028))
    g.addColorStop(1, hexA(cl.color, 0))
    ctx.fillStyle = g
    ctx.beginPath()
    ctx.arc(p.x, p.y, rad, 0, Math.PI * 2)
    ctx.fill()
  }

  // 关联细线（平时极淡的"网感"；悬停/选中时由下方弧线段大幅点亮）
  ctx.lineWidth = 0.7
  for (const e of realEdges) {
    const A = screenCache.get(e.a)
    const B = screenCache.get(e.b)
    if (!A || !B) continue
    ctx.beginPath()
    ctx.moveTo(A.x, A.y)
    ctx.lineTo(B.x, B.y)
    ctx.strokeStyle = 'rgba(168,192,238,0.14)'
    ctx.stroke()
  }

  // 粒子雾
  for (const s of particles) {
    const p = toScreen(s.x + Math.sin(tSec * s.sp + s.ph) * 4, s.y + Math.cos(tSec * s.sp * 0.7 + s.ph) * 4)
    if (p.x < -10 || p.x > width + 10 || p.y < -10 || p.y > height + 10) continue
    const tw = 0.55 + 0.45 * Math.sin(tSec * 1.2 + s.ph)
    ctx.globalAlpha = s.a * tw
    ctx.fillStyle = '#f4f6ff'
    ctx.beginPath()
    ctx.arc(p.x, p.y, s.r * cam.zoom * 1.6, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.globalAlpha = 1

  // 关联弧线（真实数据；聚焦时高举 + 流光）
  if (focusId) {
    const FA = screenCache.get(focusId)
    if (FA) {
      for (const e of realEdges) {
        const other = e.a === focusId ? e.b : e.b === focusId ? e.a : null
        if (!other) continue
        const OB = screenCache.get(other)
        if (!OB) continue
        const mx = (FA.x + OB.x) / 2
        const my = (FA.y + OB.y) / 2
        const dx = mx - width / 2
        const dy = my - height / 2
        const qx = width / 2 + dx * 1.16
        const qy = height / 2 + dy * 1.16
        ctx.beginPath()
        ctx.moveTo(FA.x, FA.y)
        ctx.quadraticCurveTo(qx, qy, OB.x, OB.y)
        ctx.strokeStyle = 'rgba(190,220,255,0.16)'
        ctx.lineWidth = 4
        ctx.stroke()
        ctx.strokeStyle = 'rgba(214,235,255,0.8)'
        ctx.lineWidth = 1.2
        ctx.stroke()
        const ft = (tSec * 0.5) % 1
        const bx = (1 - ft) * (1 - ft) * FA.x + 2 * (1 - ft) * ft * qx + ft * ft * OB.x
        const by = (1 - ft) * (1 - ft) * FA.y + 2 * (1 - ft) * ft * qy + ft * ft * OB.y
        ctx.fillStyle = 'rgba(240,248,255,0.9)'
        ctx.beginPath()
        ctx.arc(bx, by, 1.7, 0, Math.PI * 2)
        ctx.fill()
      }
    }
  }

  // 知识原子
  const proj = kn.map((s) => {
    const p = toScreen(s.x, s.y)
    screenCache.set(s.node.id, p)
    return { s, p }
  })
  proj.sort((m, n) => m.p.y - n.p.y)
  for (const { s, p } of proj) {
    const isFocus = focusId === s.node.id
    const isRel = related.has(s.node.id) && !isFocus
    const twinkle = 0.84 + 0.16 * Math.sin(tSec * 1.6 + s.phase)
    const glow = Math.min(40, Math.max(4, s.size * cam.zoom * (isFocus ? 1.8 : isRel ? 1.35 : 1.0) * twinkle))

    ctx.globalCompositeOperation = 'lighter'
    ctx.globalAlpha = (isFocus ? 1 : isRel ? 0.98 : 0.9) * twinkle
    ctx.drawImage(s.sprite, p.x - glow, p.y - glow, glow * 2, glow * 2)
    ctx.globalAlpha = 1

    ctx.beginPath()
    ctx.arc(p.x, p.y, Math.max(1, Math.min(2.6, s.size * cam.zoom * 0.2)), 0, Math.PI * 2)
    ctx.fillStyle = 'rgba(255,255,255,0.95)'
    ctx.fill()

    if (s.pending) {
      const pulse = 0.5 + 0.5 * Math.sin(tSec * 2.2 + s.phase)
      ctx.beginPath()
      ctx.arc(p.x, p.y, Math.max(6, glow * 0.8 + 3 + pulse * 2.5), 0, Math.PI * 2)
      ctx.strokeStyle = 'rgba(251,146,60,' + (0.12 + 0.18 * pulse) + ')'
      ctx.lineWidth = 1
      ctx.stroke()
    }

    if (isFocus) {
      ctx.beginPath()
      ctx.arc(p.x, p.y, Math.max(11, glow * 0.72 + 6), 0, Math.PI * 2)
      ctx.strokeStyle = 'rgba(255,255,255,0.85)'
      ctx.lineWidth = 1.5
      ctx.stroke()
    }

    if (isFocus || (isRel && focusId && cam.zoom >= 0.55)) {
      const raw = s.node.title || s.node.id
      const label = raw.length > 12 ? raw.slice(0, 12) + '…' : raw
      ctx.font = (isFocus ? '600 12px' : '10px') + ' -apple-system, "Segoe UI", sans-serif'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'top'
      const tw2 = ctx.measureText(label).width
      const lx = p.x
      const ly = p.y + Math.max(11, glow * 0.7 + 7)
      ctx.globalAlpha = isFocus ? 1 : 0.82
      ctx.fillStyle = 'rgba(6,8,14,0.7)'
      ctx.fillRect(lx - tw2 / 2 - 6, ly - 2, tw2 + 12, isFocus ? 17 : 15)
      ctx.fillStyle = isFocus ? '#eef4ff' : '#cfdcf5'
      ctx.fillText(label, lx, ly)
      ctx.globalAlpha = 1
    }
  }
}

function hexA(hex: string, a: number): string {
  const h = hex.replace('#', '')
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const b = parseInt(h.slice(4, 6), 16)
  return `rgba(${r},${g},${b},${a})`
}

// ── 交互 ──
let dragging = false
let moved = false
let lastX = 0

function tick() {
  if (!interacting && !dragging) rot += 0.00022
  draw()
  raf = requestAnimationFrame(tick)
}

function hitTest(mx: number, my: number): string | null {
  let best: string | null = null
  let bestDist = Infinity
  for (const s of kn) {
    const p = screenCache.get(s.node.id)
    if (!p) continue
    const d = Math.hypot(p.x - mx, p.y - my)
    const r = Math.max(13, s.size * cam.zoom * 1.5 + 6)
    if (d < r && d < bestDist) {
      bestDist = d
      best = s.node.id
    }
  }
  return best
}

function localPos(e: PointerEvent) {
  const rect = canvasRef.value!.getBoundingClientRect()
  return { x: e.clientX - rect.left, y: e.clientY - rect.top }
}

function onPointerDown(e: PointerEvent) {
  const { x, y } = localPos(e)
  emit('select', hitTest(x, y))
  dragging = true
  moved = false
  lastX = x
  interacting = true
  canvasRef.value!.setPointerCapture(e.pointerId)
}

function onPointerMove(e: PointerEvent) {
  const { x, y } = localPos(e)
  if (dragging) {
    const dx = x - lastX
    if (Math.abs(dx) > 2) moved = true
    if (moved) rot -= dx * 0.0034
    lastX = x
  } else {
    hoveredId = hitTest(x, y)
    canvasRef.value!.style.cursor = hoveredId ? 'pointer' : 'grab'
  }
}

function onPointerUp() {
  dragging = false
  interacting = false
  canvasRef.value!.style.cursor = hoveredId ? 'pointer' : 'grab'
}

function onWheel(e: WheelEvent) {
  e.preventDefault()
  userZoom = true
  cam.zoom = Math.max(0.14, Math.min(3.6, cam.zoom * (e.deltaY > 0 ? 1.11 : 0.9)))
}

function onPointerLeave() {
  hoveredId = null
}

watch(() => [props.items, props.edges], build, { deep: false })

onMounted(() => {
  const canvas = canvasRef.value
  if (!canvas) return
  resize()
  build()
  buildBgStars()
  window.addEventListener('resize', resize)
  canvas.addEventListener('pointerdown', onPointerDown)
  canvas.addEventListener('pointermove', onPointerMove)
  canvas.addEventListener('pointerup', onPointerUp)
  canvas.addEventListener('pointerleave', onPointerLeave)
  canvas.addEventListener('wheel', onWheel, { passive: false })
  raf = requestAnimationFrame(tick)
})

onUnmounted(() => {
  cancelAnimationFrame(raf)
  window.removeEventListener('resize', resize)
  const canvas = canvasRef.value
  if (canvas) {
    canvas.removeEventListener('pointerdown', onPointerDown)
    canvas.removeEventListener('pointermove', onPointerMove)
    canvas.removeEventListener('pointerup', onPointerUp)
    canvas.removeEventListener('pointerleave', onPointerLeave)
    canvas.removeEventListener('wheel', onWheel)
  }
})
</script>

<template>
  <canvas ref="canvasRef" class="atom-canvas"></canvas>
</template>

<style scoped>
.atom-canvas {
  display: block;
  cursor: grab;
  touch-action: none;
}
</style>
