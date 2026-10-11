/* 0914 开屏动画（Splash）状态模块：
   - 仅应用冷启动播放（用户拍板：后端重连不播）
   - App.vue 在启动流程各节点推进度；SplashScreen.vue 消费状态驱动动画
   - HMR / 同一会话 30s 内重复挂载 → 跳过，防止开发时反复弹 */
import { reactive } from 'vue'

const SS_KEY = 'nis-splash-last-at'
const SKIP_WINDOW_MS = 30_000

export const splash = reactive({
  /** 本轮是否展示开屏层（App.vue 控制 SplashScreen 的 v-if） */
  active: false,
  /** 进度条目标值 0-100（显示值由组件内缓动追赶，避免跳变） */
  progress: 0,
  /** 加载完成信号：触发「汇聚 → 飞行」收尾序列（时长固定，与加载耗时无关） */
  ready: false
})

/** 本次挂载是否需要播放开屏：冷启动=播；HMR/短间隔重挂载=跳过 */
export function shouldPlaySplash(): boolean {
  try {
    const last = Number(sessionStorage.getItem(SS_KEY) || 0)
    return !(last > 0 && Date.now() - last < SKIP_WINDOW_MS)
  } catch {
    return true
  }
}

/** 冷启动时 boot.html 已经走过的进度（由 Rust 读 document.title 后经 URL 带进来，见 tauri lib.rs）。
 *  让开屏进度条**接着 boot 的进度继续走**，而不是回到 0 —— 否则会看到"90% 突然掉回 0%"的跳变。 */
function bootStartProgress(): number {
  try {
    const v = Number((window as unknown as { __nisBootBg?: { progress?: number } }).__nisBootBg?.progress || 0)
    return Number.isFinite(v) ? Math.max(0, Math.min(96, v)) : 0
  } catch {
    return 0
  }
}

/* ── 0919：index.html 里的「接续帧」（#nis-boot-frame）──
 * 背景：boot 页被导航销毁后，到 Vue 挂载出 SplashScreen 之前，页面是**空的**（只有底色）
 * —— 这就是用户看到的"闪一下"；随后 SplashScreen 又画了第二根进度条并让它从 0 淡入爬上，
 * 于是看起来是"两根条"。
 * 现在这层静态帧（光晕 + logo + 进度条，与 boot.html 逐值同款）在 index.html 里内联，
 * 条宽立即按 URL 的 p 设好 → 导航后首帧 == boot 尾帧，空窗消失。
 * **logo 与进度条都归它**：SplashScreen 不再渲染自己的那份，只负责驱动进度、并在收尾时
 * 直接拿这层的 logo 去播果冻弹跳（playJellyOutro 会把 logo 摘到 body 上，最后自己 remove）。
 * 交接完成（或跳过开屏）后整帧移除，别一直盖着界面。 */
export function bootFrame(): HTMLElement | null {
  try { return document.getElementById('nis-boot-frame') } catch { return null }
}
export function bootFrameLogo(): HTMLImageElement | null {
  try { return document.querySelector<HTMLImageElement>('#nis-boot-frame .nbf-logo') } catch { return null }
}
export function bootFrameBar(): HTMLElement | null {
  try { return document.getElementById('nis-boot-bar') } catch { return null }
}
export function bootFrameBarFill(): HTMLElement | null {
  try { return document.getElementById('nis-boot-bar-fill') } catch { return null }
}
/** 接续帧上的**粒子球画布**（0919 起球由接续帧承担，SplashScreen 里的 <OrbitalSphere> 不再渲染）。
 *  收尾时要把它和辉光一起淡出 —— 否则 logo 跳走时球还在原地转。 */
export function bootFrameOrb(): HTMLElement | null {
  try { return document.querySelector<HTMLElement>('#nis-boot-frame .nbf-orb') } catch { return null }
}
/** SplashScreen 挂载后调用：辉光交回它自己那份，避免两层叠着（logo/条继续由本帧提供） */
export function bootFrameHandoff(): void {
  bootFrame()?.classList.add('nbf-handoff')
}

export function splashBegin(): void {
  splash.active = true
  splash.progress = bootStartProgress()
  splash.ready = false
  try {
    sessionStorage.setItem(SS_KEY, String(Date.now()))
  } catch {
    /* sessionStorage 不可用时无碍 */
  }
}

export function splashSetProgress(v: number): void {
  const n = Math.max(0, Math.min(100, Math.round(v)))
  /* 0918：改为**单调递增** —— 进度条只前进不后退。boot 阶段带进来的起点（可能已 60~88%）
     不会被后续的 30/58/74 这些节点值打回去。 */
  splash.progress = Math.max(splash.progress, n)
}

export function splashReady(): void {
  splash.ready = true
}

export function splashFinished(): void {
  splash.active = false
  splashClearBootBg()
}

/** 清掉启动期的临时底色（index.html 内联注入的 `#nis-boot-bg` + html 行内 background）
 *  与「接续帧」`#nis-boot-frame`。
 *  跳过开屏 / 收尾两条路径都要调 —— 否则浅色底会一直压在应用主题下面，
 *  而接续帧会一直盖住界面（它就是那个 z-index 最高的全屏层）。 */
export function splashClearBootBg(): void {
  try {
    document.documentElement.classList.remove('nis-boot')
    document.documentElement.style.background = ''
    document.getElementById('nis-boot-bg')?.remove()
    bootFrame()?.remove()
  } catch {
    /* ignore */
  }
}
