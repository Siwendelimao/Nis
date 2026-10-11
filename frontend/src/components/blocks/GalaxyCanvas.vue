<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from 'vue'

export interface GalaxyNode {
  id: string
  title: string
  summary?: string
  /** 后端 node_type / entry_type 等 → 决定星色 */
  colorKey?: string
  /** 展示用色（可选，优先于 colorKey） */
  color?: string
  [key: string]: any
}

export interface GalaxyEdge {
  id: string
  source: string
  target: string
  relation?: string
  /** 相关度 0~1（0919：后端 knowledge_relations.score）→ 线宽/亮度 */
  score?: number
}

const props = defineProps<{
  items: GalaxyNode[]
  edges?: GalaxyEdge[]
  selectedId?: string | null
  /** 名称显示开关：true=按缩放逐级显示；false=仅选中/悬停显示 */
  showLabels?: boolean
}>()

const emit = defineEmits<{
  select: [id: string | null]
}>()

/**
 * 银河（Milky Way）—— 单一大星系视图。
 *  · 一条银河：核心核球 + 双旋臂尘埃带 + 星云霭 + 远景星空（一次性绘制为纹理，逐帧做仿射变换）；
 *  · 每个记忆/知识条目 = 银河中的一颗星：度数高的挨近核心，孤星散在外晕，同类型沿臂成带；
 *  · 相机模型（0914c 修订）：**盘面自旋（spin）+ 俯仰限位（tilt）** ——
 *      水平拖拽 = 星系自转（星盘始终完整，不再"转成一条线"）；
 *      竖直拖拽 = 调整俯仰 0.16~1.18rad（从近正面到近侧视，永不塌成细线）；
 *      松手后缓慢自动自旋。滚轮缩放 / 悬停高亮 / 点击选中不变。
 */

const canvasRef = ref<HTMLCanvasElement | null>(null)

// ── 确定性随机（同一 id 每次形态一致）──
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
  preference: '#7dd3fc',
  decision: '#c4b5fd',
  pitfall: '#fda4af',
  pattern: '#86efac',
  fact: '#fcd34d',
  pending: '#fb923c',
  doc: '#93c5fd',
  manual: '#a5f3fc',
  note: '#bef264',
  reference: '#f9a8d4',
  memory: '#a78bfa',
  knowledge: '#5eead4',
  default: '#94a3b8',
}

// ── 银河几何常量（世界坐标）──
const GALAXY_R = 560                    // 星系半径
const ARM_COUNT = 2                     // 主旋臂数
const ARM_SPINS = 1.72                  // 每条臂的圈数（0914c：2.05→1.72，少一圈更开阔、弱化"圈圈"感）
const ARM_START = [0.65, 0.65 + Math.PI] // 臂起始角（两条对称）
const CORE_R = GALAXY_R * 0.2           // 核球半径

const TEX = 1536                        // 银河纹理边长（px）
const TEX_K = TEX / (2 * GALAXY_R * 1.45) // 世界 → 纹理 px 缩放（0914c：留白加大，防纹理方形边界露出）

interface Star3D {
  node: GalaxyNode
  x: number; y: number; z: number
  size: number
  color: string
  sprite: HTMLCanvasElement
  phase: number
  pending: boolean
  deg: number
}

let stars: Star3D[] = []
let edgePairs: Array<{ a: string; b: string }> = []
let adj = new Map<string, Set<string>>()
let bgStars: Array<{ x: number; y: number; z: number; tw: number; sz: number }> = []
let discTex: HTMLCanvasElement | null = null
/** 相机：spin=盘面自旋角；tilt=俯仰（限位 0.16~1.18，永不塌成侧视细线） */
let cam = { spin: 0.8, tilt: 0.72, zoom: 0.55 }
let userZoom = false

// ── 光点贴图（白核 + 彩色光晕；强化本色，让类型颜色一眼可辨）──
function hexA(hex: string, a: number): string {
  const h = hex.replace('#', '')
  const r = parseInt(h.slice(0, 2), 16)
  const g2 = parseInt(h.slice(2, 4), 16)
  const b = parseInt(h.slice(4, 6), 16)
  return `rgba(${r},${g2},${b},${a})`
}
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
  g.addColorStop(0.18, hexA(color, 0.95))
  g.addColorStop(0.52, hexA(color, 0.24))
  g.addColorStop(1, hexA(color, 0))
  ctx.fillStyle = g
  ctx.fillRect(0, 0, s, s)
  spriteCache.set(color, c)
  return c
}

// ── 银河纹理：一次绘制，逐帧仿射（核心 + 旋臂尘埃 + 星云 + 亮星）──
function buildDiscTexture(): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = c.height = TEX
  const g = c.getContext('2d')!
  const cx = TEX / 2
  const k = TEX_K
  const rand = mulberry32(998244353)

  // 全盘淡雾（银盘基底）
  const base = g.createRadialGradient(cx, cx, 0, cx, cx, GALAXY_R * k * 1.05)
  base.addColorStop(0, 'rgba(255,244,214,0.22)')
  base.addColorStop(0.18, 'rgba(226,232,240,0.11)')
  base.addColorStop(0.5, 'rgba(148,163,184,0.055)')
  base.addColorStop(1, 'rgba(0,0,0,0)')
  g.fillStyle = base
  g.fillRect(0, 0, TEX, TEX)

  // 外侧银晕（大范围极淡光雾 → 盘面更"饱满"；0914c：收在 1.3R 内，防触到纹理边界）
  const outer = g.createRadialGradient(cx, cx, GALAXY_R * k * 0.5, cx, cx, GALAXY_R * k * 1.3)
  outer.addColorStop(0, 'rgba(180,196,235,0.045)')
  outer.addColorStop(0.5, 'rgba(168,186,228,0.02)')
  outer.addColorStop(1, 'rgba(160,180,220,0)')
  g.fillStyle = outer
  g.fillRect(0, 0, TEX, TEX)

  g.globalCompositeOperation = 'lighter'

  // 旋臂尘埃带：沿对数螺旋撒点，越靠外越散（0914c 加密，盘面更饱满）
  const DUST = 12000
  for (let i = 0; i < DUST; i++) {
    const arm = i % ARM_COUNT
    const t = Math.pow(rand(), 0.72)
    const r = (0.10 + 0.9 * t) * GALAXY_R
    const ang = ARM_START[arm] + t * ARM_SPINS * Math.PI * 2
    const spreadPx = (0.04 + 0.14 * t) * GALAXY_R * k
    const x = cx + Math.cos(ang) * r * k + (rand() + rand() + rand() - 1.5) * spreadPx
    const y = cx + Math.sin(ang) * r * k + (rand() + rand() + rand() - 1.5) * spreadPx
    if (x < 0 || y < 0 || x >= TEX || y >= TEX) continue
    const warm = r < GALAXY_R * 0.38 && rand() < 0.42
    const col = warm ? '255,224,178' : (rand() < 0.5 ? '203,213,235' : '187,205,255')
    const a = (0.032 + rand() * 0.11 + (1 - t) * 0.05) * (1 - 0.7 * Math.max(0, (t - 0.76) / 0.24))
    const sz = 0.7 + rand() * 1.7
    g.fillStyle = `rgba(${col},${a})`
    g.fillRect(x, y, sz, sz)
  }

  // 臂心微光：沿螺旋中线的细碎亮点（弱化版：只做"臂芯"点缀，不形成明显亮线）
  for (let i = 0; i < 900; i++) {
    const arm = i % ARM_COUNT
    const t = Math.pow(rand(), 0.8)
    const r = (0.12 + 0.88 * t) * GALAXY_R
    const ang = ARM_START[arm] + t * ARM_SPINS * Math.PI * 2
    const spreadPx = (0.018 + 0.07 * t) * GALAXY_R * k
    const x = cx + Math.cos(ang) * r * k + (rand() + rand() - 1) * spreadPx
    const y = cx + Math.sin(ang) * r * k + (rand() + rand() - 1) * spreadPx
    if (x < 0 || y < 0 || x >= TEX || y >= TEX) continue
    const a = 0.03 + rand() * 0.06
    const sz = 0.7 + rand() * 1.5
    g.fillStyle = `rgba(226,236,255,${a})`
    g.fillRect(x, y, sz, sz)
  }

  // 旋臂柔云（0914c 修订②）：更柔更净——提高团数、降低单团透明度、去掉高频噪声（"脏"感来源）
  for (let armIdx = 0; armIdx < ARM_COUNT; armIdx++) {
    const PUFFS = 210
    for (let i = 0; i < PUFFS; i++) {
      const t = Math.pow(rand(), 0.85)
      const r = (0.11 + 0.88 * t) * GALAXY_R
      const ang = ARM_START[armIdx] + t * ARM_SPINS * Math.PI * 2
      // 低频明暗起伏（只留大尺度云带变化，不做碎斑）
      const ripple =
        0.72 + 0.16 * Math.sin(t * 6.4 + armIdx * 2.3) + 0.08 * Math.sin(t * 13 + armIdx * 4.7)
      const jitter = (rand() + rand() + rand() - 1.5) * (0.02 + 0.09 * t) * GALAXY_R * k
      const px = cx + Math.cos(ang) * r * k + jitter
      const py = cx + Math.sin(ang) * r * k + jitter
      const rad = (0.06 + 0.11 * t) * GALAXY_R * k * (0.7 + rand() * 0.7)
      const warm = r < GALAXY_R * 0.4 && rand() < 0.6
      const col = warm ? '255,228,190' : '186,205,245'
      const a = (0.02 + 0.038 * (1 - t * 0.5)) * ripple * (0.75 + rand() * 0.5)
      const pg = g.createRadialGradient(px, py, 0, px, py, rad)
      pg.addColorStop(0, `rgba(${col},${a})`)
      pg.addColorStop(0.55, `rgba(${col},${a * 0.4})`)
      pg.addColorStop(1, 'rgba(0,0,0,0)')
      g.fillStyle = pg
      g.fillRect(px - rad, py - rad, rad * 2, rad * 2)
    }
  }

  // 少量亮星点（散布臂上）
  for (let i = 0; i < 170; i++) {
    const arm = i % ARM_COUNT
    const t = Math.pow(rand(), 0.8)
    const r = (0.14 + 0.76 * t) * GALAXY_R
    const ang = ARM_START[arm] + t * ARM_SPINS * Math.PI * 2 + (rand() - 0.5) * 0.5
    const spreadPx = (0.04 + 0.12 * t) * GALAXY_R * k
    const x = cx + Math.cos(ang) * r * k + (rand() + rand() - 1) * spreadPx
    const y = cx + Math.sin(ang) * r * k + (rand() + rand() - 1) * spreadPx
    const sz = 0.9 + rand() * 1.8
    g.fillStyle = `rgba(226,236,255,${0.16 + rand() * 0.3})`
    g.fillRect(x, y, sz, sz)
  }

  // 核球（大范围暖晕 + 亮核）
  const halo = g.createRadialGradient(cx, cx, 0, cx, cx, CORE_R * k * 3.1)
  halo.addColorStop(0, 'rgba(255,235,200,0.22)')
  halo.addColorStop(0.45, 'rgba(255,210,150,0.07)')
  halo.addColorStop(1, 'rgba(255,200,140,0)')
  g.fillStyle = halo
  g.fillRect(0, 0, TEX, TEX)
  const core = g.createRadialGradient(cx, cx, 0, cx, cx, CORE_R * k * 1.9)
  core.addColorStop(0, 'rgba(255,252,242,1)')
  core.addColorStop(0.16, 'rgba(255,232,182,0.78)')
  core.addColorStop(0.5, 'rgba(255,204,138,0.3)')
  core.addColorStop(1, 'rgba(255,190,120,0)')
  g.fillStyle = core
  g.fillRect(0, 0, TEX, TEX)

  // 星云霭（紫/蓝/粉的极淡色块）
  const NEB: Array<[string, number, number, number]> = [
    ['124,58,237', 0.085, 1.35, 0.34],
    ['14,165,233', 0.075, 2.9, 0.30],
    ['244,114,182', 0.062, 4.4, 0.26],
    ['56,189,248', 0.06, 5.6, 0.28],
  ]
  for (let i = 0; i < NEB.length; i++) {
    const [col, al, ang, rrF] = NEB[i]
    const rr = GALAXY_R * rrF
    const px = cx + Math.cos(ang) * rr * k
    const py = cx + Math.sin(ang) * rr * k
    const rad = GALAXY_R * k * (0.3 + 0.08 * i)
    const ng = g.createRadialGradient(px, py, 0, px, py, rad)
    ng.addColorStop(0, `rgba(${col},${al})`)
    ng.addColorStop(1, `rgba(${col},0)`)
    g.fillStyle = ng
    g.fillRect(0, 0, TEX, TEX)
  }

  // 边缘柔化遮罩（0914c 修订②）：径向 destination-in —— 内容自 1.0R 至 1.4R 渐隐、四角强制透明，
  // 纹理方形边界在任何旋转/缩放下都不会露出（根治"四边被裁切"的观感）
  const mask = g.createRadialGradient(cx, cx, GALAXY_R * k * 0.93, cx, cx, GALAXY_R * k * 1.16)
  mask.addColorStop(0, 'rgba(0,0,0,1)')
  mask.addColorStop(1, 'rgba(0,0,0,0)')
  g.globalCompositeOperation = 'destination-in'
  g.fillStyle = mask
  g.fillRect(0, 0, TEX, TEX)

  g.globalCompositeOperation = 'source-over'
  return c
}

// ── 布局：把节点铺进银河（核球 / 旋臂 / 外晕）──
function build() {
  const items = props.items || []

  // 度数（连接数）
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
  edgePairs = (props.edges || [])
    .filter((e) => adj.has(e.source) && adj.has(e.target))
    .map((e) => ({ a: e.source, b: e.target, score: Number(e.score || 0) }))

  // 排序：同类型相邻 → 沿臂成"色带"，观感更整齐
  const sorted = items.slice().sort((a, b) => {
    const ka = String(a.colorKey || '')
    const kb = String(b.colorKey || '')
    if (ka !== kb) return ka < kb ? -1 : 1
    return hashStr(a.id) < hashStr(b.id) ? -1 : 1
  })

  const armCounts = new Array(ARM_COUNT).fill(0)
  for (let i = 0; i < sorted.length; i++) armCounts[i % ARM_COUNT]++
  const armSeen = new Array(ARM_COUNT).fill(0)

  /* ★1010m（实测反馈"所有记忆紧凑在一起"）：原判据 d>=4 就算核球——而记忆库平均度≈11（1228/111 点）
     ⇒ 几乎全部节点都被判为"枢纽"塞进小核球，中心糊成一坨。改为：阈值随平均度自适应（≥6 且 ≥1.8×平均度）、
     核球最多 8 个（真·枢纽），并用 sqrt 均匀铺开（原 pow(rand,1.6) 偏向圆心）。 */
  const _avgDeg = sorted.length ? (Array.from(deg.values()).reduce((a, b) => a + b, 0) / sorted.length) : 0
  const _coreThresh = Math.max(6, Math.ceil(_avgDeg * 1.8))
  let _coreCount = 0
  stars = sorted.map((node, i) => {
    const rand = mulberry32(hashStr(node.id))
    const d = deg.get(node.id) || 0
    const color = node.color || TYPE_COLORS[node.colorKey || ''] || TYPE_COLORS.default
    let x = 0
    let y = 0
    let z = 0

    if (d >= _coreThresh && sorted.length > 10 && _coreCount < 8) {
      // 高连接节点 → 核球（星系中心）
      _coreCount++
      const rr = Math.sqrt(rand()) * CORE_R * 2.4 + GALAXY_R * 0.02
      const a = rand() * Math.PI * 2
      x = Math.cos(a) * rr
      y = Math.sin(a) * rr
      z = (rand() - 0.5) * GALAXY_R * 0.04
    } else if (d === 0) {
      // 孤星 → 外晕（银晕散星）
      const rr = GALAXY_R * (0.72 + rand() * 0.36)
      const a = rand() * Math.PI * 2
      x = Math.cos(a) * rr
      y = Math.sin(a) * rr
      z = (rand() - 0.5) * GALAXY_R * 0.05
    } else {
      // 其余 → 沿旋臂（与纹理尘埃同一条螺旋线）
      const arm = i % ARM_COUNT
      const t = (armSeen[arm] + 0.5) / armCounts[arm]
      armSeen[arm]++
      const tt = Math.pow(t, 0.92)
      const r = (0.14 + 0.8 * tt) * GALAXY_R * (0.94 + rand() * 0.12)
      const ang = ARM_START[arm] + tt * ARM_SPINS * Math.PI * 2 + (rand() - 0.5) * 0.35
      const j = (0.03 + 0.1 * tt) * GALAXY_R
      x = Math.cos(ang) * r + (rand() - 0.5) * j
      y = Math.sin(ang) * r + (rand() - 0.5) * j
      z = (rand() - 0.5) * GALAXY_R * 0.03
    }

    const size = 3.2 + Math.min(8.5, d * 0.95)
    return {
      node, x, y, z, size, color,
      sprite: spriteFor(color),
      phase: rand() * Math.PI * 2,
      pending: node.colorKey === 'pending' || node.pending === true,
      deg: d,
    }
  })

  if (!userZoom) fitZoom()
}

function fitZoom() {
  const el = canvasRef.value?.parentElement
  if (!el) return
  const m = Math.min(el.clientWidth || 800, el.clientHeight || 600)
  cam.zoom = Math.max(0.18, Math.min(1.1, (m * 0.42) / GALAXY_R))
}

function buildBgStars() {
  bgStars = []
  const rand = mulberry32(7777)
  for (let i = 0; i < 460; i++) {
    const a = rand() * Math.PI * 2
    const rr = 900 + Math.pow(rand(), 0.7) * 2600
    bgStars.push({
      x: Math.cos(a) * rr,
      y: (rand() - 0.5) * 2400,
      z: Math.sin(a) * rr,
      tw: rand() * Math.PI * 2,
      sz: 0.7 + rand() * 1.3,
    })
  }
}

// ── 画布 / 相机 ──
let raf = 0
let ctx: CanvasRenderingContext2D | null = null
let width = 0
let height = 0
let dpr = 1
let interacting = false
let hoveredId: string | null = null

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

/** 3D → 屏幕（正交投影）：先盘面自旋（spin），再俯仰压缩（tilt）；深度只用于远近排序 */
function project(p: { x: number; y: number; z: number }) {
  const cs = Math.cos(cam.spin)
  const ss = Math.sin(cam.spin)
  const ct = Math.cos(cam.tilt)
  const st = Math.sin(cam.tilt)
  const X = p.x * cs - p.y * ss
  const Y = p.x * ss + p.y * cs
  const y2 = Y * ct - p.z * st
  const z2 = Y * st + p.z * ct
  return {
    x: width / 2 + X * cam.zoom,
    y: height / 2 + y2 * cam.zoom,
    z: z2,
  }
}

function draw() {
  if (!ctx) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.globalCompositeOperation = 'source-over'

  // 深空背景
  const bg = ctx.createRadialGradient(width / 2, height / 2, 0, width / 2, height / 2, Math.max(width, height) * 0.78)
  bg.addColorStop(0, '#0b1026')
  bg.addColorStop(0.55, '#070a1a')
  bg.addColorStop(1, '#030408')
  ctx.fillStyle = bg
  ctx.fillRect(0, 0, width, height)

  const now = performance.now()

  // 远景星空（跟随弱化：自旋×0.25 + 穹顶压扁）
  {
    const cs = Math.cos(cam.spin * 0.25)
    const ss = Math.sin(cam.spin * 0.25)
    const squash = 0.45 + 0.35 * Math.cos(cam.tilt)
    for (const s of bgStars) {
      const bx = s.x * cs - s.y * ss
      const by = (s.x * ss + s.y * cs) * squash
      const px = width / 2 + bx * cam.zoom * 0.42
      const py = height / 2 + by * cam.zoom * 0.42
      if (px < -20 || px > width + 20 || py < -20 || py > height + 20) continue
      const tw = 0.5 + 0.5 * Math.sin(now / 900 + s.tw)
      ctx.globalAlpha = 0.2 + 0.38 * tw
      ctx.fillStyle = '#cbd5e1'
      ctx.fillRect(px, py, s.sz, s.sz)
    }
  }
  ctx.globalAlpha = 1

  if (!discTex) {
    discTex = buildDiscTexture()
  }

  // 银河本体：纹理按相机做仿射变换（与星体投影严格同源：
  //   screenX = K·(cosθ·tx − sinθ·ty)；screenY = K·cos(tilt)·(sinθ·tx + cosθ·ty)，K = zoom/TEX_K）
  {
    const cs = Math.cos(cam.spin)
    const ss = Math.sin(cam.spin)
    const ct = Math.cos(cam.tilt)
    const K = cam.zoom / TEX_K
    ctx.save()
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.translate(width / 2, height / 2)
    ctx.transform(K * cs, K * ct * ss, -K * ss, K * ct * cs, 0, 0)
    ctx.globalCompositeOperation = 'lighter'
    ctx.globalAlpha = 0.96
    ctx.drawImage(discTex, -TEX / 2, -TEX / 2)
    ctx.restore()
    ctx.globalAlpha = 1
  }

  if (!stars.length) return

  // 投影全部星体（远 → 近排序，近者后画）
  const proj = stars.map((s) => ({ s, p: project(s) }))
  proj.sort((m, n) => m.p.z - n.p.z)
  const byId = new Map(proj.map((x) => [x.s.node.id, x]))

  // 关联集合（悬停/选中的相邻星与边会点亮）
  const focusId = hoveredId || props.selectedId || null
  const related = new Set<string>()
  if (focusId) {
    related.add(focusId)
    const nb = adj.get(focusId)
    if (nb) for (const id of nb) related.add(id)
  }

  // ── 边（星桥）──
  if (edgePairs.length) {
    ctx.lineCap = 'round'
    for (const e of edgePairs) {
      const A = byId.get(e.a)
      const B = byId.get(e.b)
      if (!A || !B) continue
      const involved = focusId ? (related.has(e.a) && related.has(e.b)) : false
      const mx = (A.p.x + B.p.x) / 2 + (B.p.y - A.p.y) * 0.12
      const my = (A.p.y + B.p.y) / 2 - (B.p.x - A.p.x) * 0.12
      /* 线宽/亮度带一点 score（相关度）：相关度高的星桥更粗更亮，一眼看出"哪几颗是一伙的"。
         score 缺省 0 → 退回原来的固定粗细（老数据/手动边也画得出）。 */
      const s = Math.max(0, Math.min(1, e.score || 0))
      ctx.beginPath()
      ctx.moveTo(A.p.x, A.p.y)
      ctx.quadraticCurveTo(mx, my, B.p.x, B.p.y)
      ctx.strokeStyle = involved
        ? `rgba(186,205,255,${(0.42 + 0.3 * s).toFixed(3)})`
        : `rgba(148,163,184,${(0.1 + 0.12 * s).toFixed(3)})`
      ctx.lineWidth = involved ? 1.4 + 0.9 * s : 0.7 + 0.6 * s
      ctx.stroke()
    }
  }

  // ── 星体 ──
  const tSec = now / 1000
  for (const { s, p } of proj) {
    if (p.x < -80 || p.x > width + 80 || p.y < -80 || p.y > height + 80) continue
    const isSel = props.selectedId === s.node.id
    const isHover = hoveredId === s.node.id
    const isRel = related.has(s.node.id)
    const twinkle = 0.82 + 0.18 * Math.sin(tSec * 1.6 + s.phase)
    const glow = Math.min(96, Math.max(3.2, s.size * cam.zoom * (isSel ? 2.4 : isHover ? 2.0 : isRel ? 1.7 : 1.35) * twinkle))

    ctx.globalCompositeOperation = 'lighter'
    ctx.globalAlpha = (isSel || isHover ? 1 : isRel ? 0.95 : 0.82) * twinkle
    ctx.drawImage(s.sprite, p.x - glow, p.y - glow, glow * 2, glow * 2)
    ctx.globalCompositeOperation = 'source-over'
    ctx.globalAlpha = 1

    // 星核（小而亮）
    if (s.size * cam.zoom > 1.2) {
      ctx.beginPath()
      ctx.arc(p.x, p.y, Math.max(0.9, Math.min(2.6, s.size * cam.zoom * 0.3)), 0, Math.PI * 2)
      ctx.fillStyle = 'rgba(255,255,255,0.95)'
      ctx.fill()
    }

    // 待确认星：琥珀色脉冲环
    if (s.pending) {
      const pulse = 0.5 + 0.5 * Math.sin(tSec * 2.2 + s.phase)
      ctx.beginPath()
      ctx.arc(p.x, p.y, Math.max(6, glow * 0.85 + 3 + pulse * 2.5), 0, Math.PI * 2)
      ctx.strokeStyle = `rgba(251,146,60,${0.12 + 0.18 * pulse})`
      ctx.lineWidth = 1
      ctx.stroke()
    }

    // 选中 / 悬停 光环
    if (isSel || isHover) {
      ctx.beginPath()
      ctx.arc(p.x, p.y, Math.max(11, glow * 0.8 + 5), 0, Math.PI * 2)
      ctx.strokeStyle = isSel ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.4)'
      ctx.lineWidth = isSel ? 1.6 : 1
      ctx.stroke()
    }

    // 标签（渐进式）：选中/悬停始终显示；「名称」开启时随缩放逐级出现
    const labelOn = props.showLabels === true && cam.zoom >= 0.9 && s.size * cam.zoom >= 5.2
    if (isSel || isHover || labelOn) {
      const raw = s.node.title || s.node.id
      const label = raw.length > 12 ? raw.slice(0, 12) + '…' : raw
      ctx.font = `${isSel ? '600 12px' : '10.5px'} -apple-system, "Segoe UI", sans-serif`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'top'
      const tw = ctx.measureText(label).width
      const lx = p.x
      const ly = p.y + Math.max(12, glow * 0.7 + 8)
      ctx.globalAlpha = isSel ? 1 : 0.78
      ctx.fillStyle = 'rgba(2,6,23,0.62)'
      ctx.fillRect(lx - tw / 2 - 6, ly - 2, tw + 12, 17)
      ctx.fillStyle = '#e2e8f0'
      ctx.fillText(label, lx, ly)
      ctx.globalAlpha = 1
    }
  }
}

let dragging = false
let moved = false
let lastX = 0
let lastY = 0

function tick() {
  if (!interacting && !dragging) cam.spin += 0.0005
  draw()
  raf = requestAnimationFrame(tick)
}

// ── 交互 ──
function hitTest(mx: number, my: number): string | null {
  let best: string | null = null
  let bestDist = Infinity
  for (const s of stars) {
    const p = project(s)
    const d = Math.hypot(p.x - mx, p.y - my)
    const r = Math.max(10, s.size * cam.zoom * 1.5 + 4)
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
  const hit = hitTest(x, y)
  if (hit) emit('select', hit)
  else emit('select', null)
  dragging = true
  moved = false
  lastX = x
  lastY = y
  interacting = true
  canvasRef.value!.setPointerCapture(e.pointerId)
}

function onPointerMove(e: PointerEvent) {
  const { x, y } = localPos(e)
  if (dragging) {
    const dx = x - lastX
    const dy = y - lastY
    if (Math.abs(dx) + Math.abs(dy) > 3) moved = true
    if (moved) {
      // 水平 = 星系自转；竖直 = 俯仰（限位内，永不出现侧视细线）
      cam.spin -= dx * 0.0034
      cam.tilt = Math.max(0.34, Math.min(1.06, cam.tilt + dy * 0.0026))
    }
    lastX = x
    lastY = y
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
  cam.zoom = Math.max(0.08, Math.min(6.5, cam.zoom * (e.deltaY > 0 ? 1.11 : 0.9)))
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
  <canvas ref="canvasRef" class="galaxy-canvas"></canvas>
</template>

<style scoped>
.galaxy-canvas {
  display: block;
  cursor: grab;
  touch-action: none;
}
</style>
