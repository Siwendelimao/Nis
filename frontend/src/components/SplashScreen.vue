<script setup lang="ts">
/* NIS 开屏动画（0919·第六版：**一根进度条**）
 *
 * 0919 反馈：「开屏进度条有两个，第一个满了会闪一下，然后再出现一个」。
 * 真因三处（都在这次一并修掉）：
 *   ① **空窗** —— 导航把 boot 页连同 logo/进度条一起销毁，而本页 #app 要等 bundle 加载 +
 *      Vue 挂载才有内容 → 中间只剩底色，这就是"闪一下"。⇒ 由 index.html 的「接续帧」顶上
 *      （`#nis-boot-frame`，与 boot.html 逐值同款、条宽立即 = URL 的 p）。
 *   ② **第二根条** —— 本组件以前自己画进度条与 logo，且进度显示值初值 0（从 0 涨）、
 *      还带入场淡入/位移动画 → 读起来就是"又出现一根条"。⇒ 现在 **不再渲染** logo/进度条，
 *      只驱动接续帧上的那一份；显示值从 `splash.progress`（boot 带进来的值）起步。
 *   ③ 入场动画全去（logo 淡入 + 上移 12px、条延迟 0.35s 淡入）—— 交接帧必须静止。
 *
 * 于是全程只有一条进度条：boot 页走到 ~88% → 接续帧无缝接住 → 本组件继续推 → 读满 100%
 * → 紧接着 logo 蓄力跳起、拽幕布拉开界面（playJellyOutro，与引导页收尾同一套）。
 *
 * ⚠️ 四处元素必须与另两处保持一致（改一处要同步另外两处）：
 *    frontend/public/boot.html · frontend/index.html(#nis-boot-frame) · 本组件 .splash-glow
 *    ① logo 74px ② 进度条 190×3 @ calc(50% + 104px) ③ 辉光 380px ④ 粒子球（orbital-boot.js，同一份渲染器）
 *
 * 仅冷启动由 App.vue 挂载；收尾序列时长固定，与加载耗时无关。 */
import { ref, onMounted, onBeforeUnmount, watch } from 'vue'
import gsap from 'gsap'
import {
  splash,
  splashFinished,
  bootFrame,
  bootFrameLogo,
  bootFrameBar,
  bootFrameBarFill,
  bootFrameHandoff,
  bootFrameOrb
} from '../utils/splash'
import { playJellyOutro } from '../utils/bootOutro'

/* 启动主题：浅色 → 亮底粒子球；深色 → 黑底粒子球。
   ⚠️ 应用启动期主题类可能有一次"迟到的覆盖"（App onMounted 的 syncFromBackend 触发 applyTheme，
   实测可晚至 ~1s）——组件创建瞬间读到旧值就会用错主题。故用 ref + onMounted 后定时校正。 */
const bootDark = ref(document.documentElement.classList.contains('dark'))
function syncBootTheme(): void {
  const dark = document.documentElement.classList.contains('dark')
  if (dark !== bootDark.value) bootDark.value = dark
}

const rootEl = ref<HTMLElement | null>(null)
const bgEl = ref<HTMLElement | null>(null)
const glowEl = ref<HTMLElement | null>(null)

/* ── 0919：logo 与进度条都在 index.html 的「接续帧」上 ──
 * 本组件只**驱动**它们（改宽度 / 播呼吸 / 交给收尾动画），不再渲染自己的一份。
 * setup 顶层就能取到：模块脚本在 DOM 解析后执行，接续帧早已在文档里。
 * 收尾结束时 logo 由 playJellyOutro 自行 remove()，接续帧整体由 splashClearBootBg() 移除。 */
let frameLogo: HTMLImageElement | null = null
let frameBar: HTMLElement | null = null
let frameBarFill: HTMLElement | null = null
function pickFrameEls(): void {
  if (!frameLogo) frameLogo = bootFrameLogo()
  if (!frameBar) frameBar = bootFrameBar()
  if (!frameBarFill) frameBarFill = bootFrameBarFill()
}
pickFrameEls()

/* 进度条显示值（直接写 DOM，避免 60fps 触发 Vue 重渲染）。
   ★ 初值 = splash.progress（boot 阶段走过的进度），**不是 0** —— 这是"第二根条"的直接来源。 */
const progressDisplay = ref(splash.progress)
let progRaf = 0
function applyProgress(): void {
  if (!frameBarFill) frameBarFill = bootFrameBarFill()
  if (frameBarFill) frameBarFill.style.width = progressDisplay.value.toFixed(2) + '%'
}
function startProgressTicker(): void {
  let lastTick = performance.now()
  const tick = (now: number): void => {
    const dt = Math.max(0, now - lastTick) / 1000
    lastTick = now
    const target = splash.progress
    const cur = progressDisplay.value
    const diff = target - cur
    if (diff > 0.01) {
      /* 指数逼近目标值（帧率无关，tau≈0.28s）：低帧率设备上进度条也不会拖沓 */
      const k = 1 - Math.exp(-dt / 0.28)
      progressDisplay.value = Math.min(cur + Math.max(0.05, diff * k), target)
      applyProgress()
    }
    progRaf = requestAnimationFrame(tick)
  }
  progRaf = requestAnimationFrame(tick)
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/* ── 资源清理 ── */
let breathTween: gsap.core.Tween | null = null
let outroStarted = false

/* ── 收尾序列（与引导页收尾同源，见 utils/bootOutro）──
 * 进度条读满 → 收起 → logo 果冻弹跳（蓄力→跳顶）→ 下坠拽幕布 → 界面从幕布里长出。
 * ★ 进度条与 logo 都取自接续帧，所以这里**没有**任何"第二根条/第二次入场"的痕迹。 */
async function runOutro(): Promise<void> {
  if (outroStarted) return
  outroStarted = true
  syncBootTheme() /* 收尾前再校正一次主题（防启动期迟到覆盖） */
  pickFrameEls()

  /* 1. 进度条快速补满（260ms）→ **停 0.5s**（既定的节拍：满了之后要有一记"落槌"再走下一步） */
  await new Promise<void>((resolve) => {
    gsap.to(progressDisplay, { value: 100, duration: 0.26, ease: 'power1.out', onUpdate: applyProgress, onComplete: resolve })
  })
  await sleep(500)

  /* 2. 条与 logo **一起渐隐**（画面先收干净），随后 **logo 单独渐显** —— 需求的"渐隐 → 渐显"节拍。
     ⚠️ logo 不能"一直可见就直接进入渐显"：它从 boot 阶段起就在屏幕上，必须先隐才能显，
        否则读起来是"啪一下出现"，又变成他说的"像又出现一次"。 */
  breathTween?.kill()
  const fadeOut = [frameBar, frameLogo].filter((el): el is HTMLElement => !!el)
  if (fadeOut.length) {
    await new Promise<void>((resolve) => {
      gsap.to(fadeOut, { opacity: 0, duration: 0.26, ease: 'power1.out', onComplete: () => resolve() })
    })
  }
  await sleep(120)
  if (frameLogo) {
    await new Promise<void>((resolve) => {
      gsap.to(frameLogo, { opacity: 1, duration: 0.34, ease: 'power2.out', onComplete: () => resolve() })
    })
  }

  /* 3. 果冻弹跳 + 入水 + 涟漪幕布 + 界面长出 */
  const fadeList: HTMLElement[] = []
  /* 粒子球（0919 起由 index.html 的接续帧承担，见 bootFrameOrb）：起跳时和辉光一起淡出 */
  const orbEl = bootFrameOrb()
  if (orbEl) fadeList.push(orbEl)
  if (glowEl.value) {
    glowEl.value.style.animation = 'none' /* 先停 CSS 呼吸，否则它会盖掉 gsap 的 opacity 补间 */
    fadeList.push(glowEl.value)
  }
  const appEl = document.getElementById('app')
  await playJellyOutro({
    logo: frameLogo as HTMLElement,
    dark: bootDark.value,
    reveal: appEl,
    fadeBefore: fadeList,
    /* 幕布铺满后：开屏层与接续帧一起隐身（都被幕布盖着，看不见），避免露出时闪一下。
       ⚠️ 此刻 logo 已被 playJellyOutro 摘到 body 上单独一层，不受这里影响。 */
    onCovered: () => {
      if (rootEl.value) gsap.set(rootEl.value, { autoAlpha: 0 })
      const f = bootFrame()
      if (f) gsap.set(f, { autoAlpha: 0 })
    },
    onDone: () => splashFinished(),
  })
}

/* ── 挂载：呼吸 + 主题校正 + 监听加载完成信号 ── */
onMounted(() => {
  /* 开屏期间关闭 GSAP lagSmoothing：低帧率设备上宁可跳帧，也保证收尾流程按固定时长走完
     （默认策略是掉帧超 500ms 就慢放动画，开屏拖沓不可接受）；卸载时恢复全局默认 */
  gsap.ticker.lagSmoothing(0)
  pickFrameEls()
  /* 辉光交回本组件那份（.splash-glow）—— 接续帧的辉光隐掉，避免两层叠着更紫 */
  bootFrameHandoff()
  startProgressTicker()
  /* 主题校正：挂载后 1.6s 内每 200ms 校正一次（覆盖启动期 applyTheme 的迟到写入窗口） */
  let syncN = 0
  const syncTimer = window.setInterval(() => {
    syncBootTheme()
    if (++syncN >= 8) window.clearInterval(syncTimer)
  }, 200)
  /* ★ 这里**没有** logo / 进度条的入场动画：它们从 boot 阶段起就一直在屏幕上，
     任何淡入或位移都会被读成"又出现一次"。只让 logo 开始呼吸。 */
  if (frameLogo) {
    breathTween = gsap.to(frameLogo, { scale: 1.035, duration: 1.4, yoyo: true, repeat: -1, ease: 'sine.inOut' })
  }
  if (splash.ready) void runOutro()
})

/* ready 信号晚于挂载到达时由 watch 触发；先于挂载的极端情况由上面兜底 */
watch(
  () => splash.ready,
  (v) => {
    if (v) void runOutro()
  }
)

onBeforeUnmount(() => {
  gsap.ticker.lagSmoothing(500, 33) // 恢复 GSAP 默认（挂载期曾设 0 保证收尾不变速）
  cancelAnimationFrame(progRaf)
  breathTween?.kill()
  gsap.killTweensOf([frameLogo, bgEl.value, frameBar])
})
</script>

<template>
  <!-- 0919：只留背景与辉光两层。
       logo / 进度条 / **粒子球**都不在这里 —— 前两者由 index.html 的「接续帧」提供，
       球同样归接续帧（`#nis-boot-frame .nbf-orb`）：因为 boot 页那颗球必须与它**同一份实现**
       （同一个 three.js 渲染器产物 orbital-boot.js），否则从 boot 页跳过来会"换一颗球"。
       本组件只负责推进度、并在收尾时把球与辉光一起淡出。 -->
  <div ref="rootEl" class="splash-root" aria-label="NIS 正在启动">
    <div ref="bgEl" class="splash-bg" :style="{ background: bootDark ? '#000' : '#ffffff' }"></div>
    <div ref="glowEl" class="splash-glow"></div>
  </div>
</template>

<style scoped>
.splash-root {
  position: fixed;
  inset: 0;
  /* 必须低于接续帧（2147483000）—— 那层的 logo/进度条要浮在粒子球之上 */
  z-index: 2147482900;
  overflow: hidden;
  /* 黑底/白底由 .splash-bg 单独承担；root 自身保持透明 */
}
.splash-bg {
  position: absolute;
  inset: 0;
  background: #000;
}
/* 辉光：与 boot.html 的 .glow、index.html 的 .nbf-glow 数值一致 */
.splash-glow {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 380px;
  height: 380px;
  margin-left: -190px;
  margin-top: -190px;
  border-radius: 50%;
  background: radial-gradient(circle, rgba(124, 58, 237, 0.4) 0%, rgba(99, 102, 241, 0.16) 45%, transparent 70%);
  animation: splashGlow 2.6s ease-in-out infinite;
  pointer-events: none;
}
@keyframes splashGlow {
  0%,
  100% {
    opacity: 0.55;
  }
  50% {
    opacity: 0.95;
  }
}
</style>
