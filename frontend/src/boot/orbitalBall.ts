/* ── 开屏链路的「粒子球」独立产物 ────────────────────────────────────
 * 0919 需求要求：**读条界面（boot 页）也要有那颗「在转的大球」**。
 *
 * 为什么不能直接 import：boot.html 与 index.html 的「接续帧」都是**裸 HTML**
 * （前者由 Tauri 内嵌、后者是 vite 的 html 入口但那段是内联的），拿不到 `import`；
 * 而球本身是 three.js 实现（components/orbital/orbitalSphereRenderer，15000 点粒子云 + 6 环）。
 * ⇒ 这里当作**独立入口**打成 `orbital-boot.js`（IIFE、挂 window），两处裸 HTML 用
 *   `<script src="/orbital-boot.js">` 调**同一份渲染器** —— 于是三处（boot / 接续帧 / Vue）
 *   看到的球长得一模一样，换页不会"换一颗球"。
 *
 * 打包：backend/_bundle_boot_orb.mjs（已接进 backend/_build_web_only.mjs 的构建流程）。
 * 产物位置：frontend/public/orbital-boot.js（public 会被 vite 原样拷进 dist 根）。
 * ⚠️ 产物是**生成物**，别手改；改球的样子请改 orbitalSphereRenderer.ts 后重新构建。 */
import { createOrbitalSphereRenderer } from '../components/orbital/orbitalSphereRenderer'

/** 与 SplashScreen 里 <OrbitalSphere :speed="1" :scale="1" /> 完全同参（默认值） */
const OPTS = {
  speed: 1,
  particleSize: 0.015,
  particleOpacity: 0.8,
  orbitOpacity: 0.25,
  scale: 1,
  haloOpacity: 0.2,
  hue: 0
}

type OrbitalBallHandle = {
  /** 尺寸变了手动调（父容器尺寸变化时） */
  resize: () => void
  /** 停帧 + 释放 WebGL（接续帧整体被移除时不需要调，页面销毁自动回收） */
  dispose: () => void
}

/** 在 `canvas` 上挂一颗球；canvas 建议 CSS 铺满父容器（width/height:100%）。 */
function mountOrbitalBall(canvas: HTMLCanvasElement): OrbitalBallHandle {
  const host = (canvas.parentElement as HTMLElement | null) || canvas
  const renderer = createOrbitalSphereRenderer(canvas, () => OPTS)

  const resize = (): void => {
    const b = host.getBoundingClientRect()
    renderer.resize(b.width || window.innerWidth, b.height || window.innerHeight)
    renderer.render()
  }

  let raf = 0
  let visible = true
  const tick = (): void => {
    renderer.render()
    raf = visible && !document.hidden ? requestAnimationFrame(tick) : 0
  }
  const onVis = (): void => {
    if (!document.hidden && !raf) raf = requestAnimationFrame(tick)
  }

  window.addEventListener('resize', resize)
  document.addEventListener('visibilitychange', onVis)
  resize()
  raf = requestAnimationFrame(tick)

  return {
    resize,
    dispose(): void {
      visible = false
      if (raf) cancelAnimationFrame(raf)
      raf = 0
      window.removeEventListener('resize', resize)
      document.removeEventListener('visibilitychange', onVis)
      try {
        renderer.dispose()
      } catch {
        /* 释放失败无碍（页面即将销毁） */
      }
    }
  }
}

/* 供裸 HTML 调用：`window.__nisMountOrbitalBall(canvas)` */
declare global {
  interface Window {
    __nisMountOrbitalBall?: (canvas: HTMLCanvasElement) => OrbitalBallHandle
  }
}
window.__nisMountOrbitalBall = mountOrbitalBall
