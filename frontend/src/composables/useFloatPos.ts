/**
 * useFloatPos —— 悬浮按钮「自由定位」通用逻辑（0914 拖动批）。
 *
 * 能力：拖动（指针事件；4px 阈值区分「点击」与「拖动」）、位置持久化（localStorage）、
 * 视口内夹取（含安全边距；窗口 resize 重夹取）、双击复位（清存储回默认位）。
 *
 * 坐标体系：CSS px。⚠️ 外观字体缩放会给 #app 挂 zoom（.92/.1.08），fixed 子元素的
 * left/top 处在 zoom 空间——统一按 物理px / zoom 折算，样式与存储都用 CSS 空间值。
 */
import { ref, onMounted, onBeforeUnmount, type Ref } from 'vue'
import { localStore } from '@/utils/localStore'

interface FloatPosOptions {
  /** localStorage 键（唯一，例如 nis.ui.chatBall.pos） */
  storageKey: string
  /** 按钮 CSS 尺寸 */
  size: { w: number; h: number }
  /** 默认位置（CSS 坐标；入参为视口 CSS 尺寸） */
  defaultPos: (vw: number, vh: number) => { x: number; y: number }
  /** 安全边距（CSS px） */
  margin?: number
  /**
   * ★1011c：与"另一个悬浮球"避让 —— 挂载时若自己的**持久化位置**与对方重叠，就回退默认位。
   *  为什么需要：位置是持久化的，而早期两个球的默认位是右下同一格，
   *  localStorage 里的旧位置会把"错开的默认"顶掉（实测反馈：右下角两个球叠在一起）。
   */
  avoidKey?: string
}

interface FloatPosApi {
  pos: Ref<{ x: number; y: number }>
  /** 视口尺寸（物理 px；resize 更新；弹窗避让计算用） */
  viewport: Ref<{ w: number; h: number }>
  /** #app 的 CSS zoom（默认 1） */
  zoom: Ref<number>
  startDrag: (e: PointerEvent) => void
  reset: () => void
  /** 拖动刚结束时消费一次（调用方用它抑制误触发的 click） */
  consumeDragClick: () => boolean
}

/**
 * ★1011c：两个悬浮球是否"叠在同一个格子里"（各自 x/y 都差不到一个球身）。
 * 抽成纯函数是为了能被真跑验证（见会话工作区 _verify_1011c.cjs）。
 */
function isOverlapping(a: { x: number; y: number }, b: { x: number; y: number }, size: { w: number; h: number }): boolean {
  return Math.abs(a.x - b.x) < size.w && Math.abs(a.y - b.y) < size.h
}

export function useFloatPos(opts: FloatPosOptions): FloatPosApi {
  const M = opts.margin ?? 8
  const pos = ref({ x: 0, y: 0 })
  const viewport = ref({ w: window.innerWidth, h: window.innerHeight })
  const zoom = ref(1)
  let dragSuppress = false
  let suppressTimer: ReturnType<typeof setTimeout> | null = null

  function readZoom() {
    try {
      const app = document.getElementById('app')
      const z = app ? parseFloat(String((app as any).style.zoom || getComputedStyle(app).zoom || '1')) : 1
      zoom.value = Number.isFinite(z) && z > 0 ? z : 1
    } catch { zoom.value = 1 }
  }
  function vpCss() {
    return { vw: viewport.value.w / zoom.value, vh: viewport.value.h / zoom.value }
  }
  function clampXY(x: number, y: number) {
    const { vw, vh } = vpCss()
    const m = M / zoom.value
    const maxX = Math.max(m, vw - opts.size.w - m)
    const maxY = Math.max(m, vh - opts.size.h - m)
    return { x: Math.min(Math.max(m, x), maxX), y: Math.min(Math.max(m, y), maxY) }
  }
  function persist() {
    try { localStore.setItem(opts.storageKey, JSON.stringify(pos.value)) } catch { /* ignore */ }
  }
  function reset() {
    const { vw, vh } = vpCss()
    const d = opts.defaultPos(vw, vh)
    pos.value = clampXY(d.x, d.y)
    try { localStore.removeItem(opts.storageKey) } catch { /* ignore */ }
  }

  function startDrag(e: PointerEvent) {
    if (e.button !== 0) return
    const el = e.currentTarget as HTMLElement | null
    if (!el) return
    readZoom()
    const start = { sx: e.clientX, sy: e.clientY, ox: pos.value.x, oy: pos.value.y }
    let moved = false
    let active = true
    const onMove = (ev: PointerEvent) => {
      if (!active) return
      const dxP = ev.clientX - start.sx
      const dyP = ev.clientY - start.sy
      if (!moved) {
        if (Math.hypot(dxP, dyP) < 4) return
        moved = true
      }
      pos.value = clampXY(start.ox + dxP / zoom.value, start.oy + dyP / zoom.value)
    }
    const onUp = (ev: PointerEvent) => {
      active = false
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerup', onUp)
      el.removeEventListener('pointercancel', onUp)
      try { el.releasePointerCapture(ev.pointerId) } catch { /* ignore */ }
      if (moved) {
        persist()
        dragSuppress = true
        if (suppressTimer) clearTimeout(suppressTimer)
        suppressTimer = setTimeout(() => { dragSuppress = false }, 350)
      }
    }
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', onUp)
    el.addEventListener('pointercancel', onUp)
    try { el.setPointerCapture(e.pointerId) } catch { /* ignore */ }
  }

  function consumeDragClick(): boolean {
    if (dragSuppress) { dragSuppress = false; return true }
    return false
  }

  function onResize() {
    viewport.value = { w: window.innerWidth, h: window.innerHeight }
    readZoom()
    pos.value = clampXY(pos.value.x, pos.value.y)
  }

  onMounted(() => {
    readZoom()
    viewport.value = { w: window.innerWidth, h: window.innerHeight }
    const saved = readSavedPos(opts.storageKey)
    if (saved) pos.value = clampXY(saved.x, saved.y)
    else reset()
    /* ★1011c：与"另一个球"**重叠**才回退默认位（默认位本来就是两球错开的）——
       只治"叠在一起"，不动用户自己拖开的位置。 */
    const other = opts.avoidKey ? readSavedPos(opts.avoidKey) : null
    if (other && isOverlapping(other, pos.value, opts.size)) reset()
    window.addEventListener('resize', onResize)
  })

  /** 读某个键里存的位置（容错：脏数据当没存） */
  function readSavedPos(key: string): { x: number; y: number } | null {
    try {
      const raw = localStore.getItem(key)
      if (!raw) return null
      const v = JSON.parse(raw)
      return (typeof v?.x === 'number' && typeof v?.y === 'number') ? { x: v.x, y: v.y } : null
    } catch { return null }
  }

  onBeforeUnmount(() => {
    window.removeEventListener('resize', onResize)
    if (suppressTimer) clearTimeout(suppressTimer)
  })

  return { pos, viewport, zoom, startDrag, reset, consumeDragClick }
}
