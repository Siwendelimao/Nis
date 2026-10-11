import { createApp, watch } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import { useSettingsStore } from './stores/settings'
import { useGlobalContextMenu } from './composables/useGlobalContextMenu'
import { hydrate, localStore } from './utils/localStore'
import { installAppShortcuts } from './utils/appShortcuts'
import { installModalEsc } from './utils/modalStack'
import { reloadLang } from './utils/i18n'
import './style.css'

/* 0920：浏览器语义快捷键先装上（F5/Ctrl+R 刷新、F12 开发者工具、Ctrl+P 打印…）。
   放在最外层而不是 bootstrap 里 —— 它不依赖任何 store，越早装上越好。 */
installAppShortcuts()

/* 0920：Esc 的**唯一**权威 —— 只关最上层那个弹窗（详见 utils/modalStack.ts 的注释）。
   顺序放在 appShortcuts 之后：appShortcuts 不碰 Escape，两者互不干扰。 */
installModalEsc()

/* 0915：启动顺序改成「先水合持久化状态，再挂载」。
   原因：所有 UI 持久化（语言/主题/项目/伙伴/引导标记…）已从 localStorage 搬到后端
   （localStore → data/ui-state.json），而它是异步拉的；某些模块（i18n）在 import 期就读一次，
   所以必须等水合完成再建应用，否则会用默认值渲染。 */
async function bootstrap() {
  /* ★0927（实测"重启后端后设置被重置回默认"）：hydrate 失败时**重试几次再挂载**。
     后端刚重启/首启竞态下 uiState.load 会超时（3s）→ 旧代码无条件继续挂载，
     localStore 镜像是空的 ⇒ 各 store 的 load() 全读默认值（ foldProcessOnDone 之类的外观
     设置首屏就是错的，要等 settings.ts 的 onHydrated 重载才纠正 —— 重试能把这段空白压到最小）。 */
  for (let _try = 0; _try < 8; _try++) {
    if (await hydrate()) break
    await new Promise((r) => setTimeout(r, 400))
  }
  reloadLang() // 语言是 import 期读的，水合后纠正一次

  const app = createApp(App)
  const pinia = createPinia()
  app.use(pinia)
  app.mount('#app')
  ;(window as any).__pinia = pinia // 调试基建：playwright 实测读 store（0906 回滚后重加）

  // 0914：全局右键拦截（选中文本→复制/搜索、输入框→编辑菜单；原生菜单一律屏蔽）。
  // 放在应用入口：改此文件会触发 Vite 整页刷新 → 已开的旧页面也一定能装上（此前 HMR 下 onMounted 不重跑=拦截假死）。
  useGlobalContextMenu().install()

  /* ── 0906 深色主题应用器：浅色 / 深色 / 跟随系统 / 按时间（0917 新增）──
   * style.css 的 html.dark 类级映射层 + tailwind @custom-variant dark 全部挂 .dark 类，
   * 这里只负责按 settings.appearance.themeMode 增删 html.dark。 */
  const settingsStore = useSettingsStore(pinia)
  const mq = window.matchMedia('(prefers-color-scheme: dark)')

  /** 0917「按时间」模式：判断当前时刻是否落在「浅色时段」内。
   *  区间外=深色；start > end 视为跨零点（如 20:00 至 07:00 浅色）。
   *  支持 'HH:mm'，也兼容 'H:mm' / 空值（空值退回默认 07:00-19:00）。 */
  function inLightWindow(): boolean {
    const norm = (s: unknown, fb: string): number => {
      const m = /^(\d{1,2}):(\d{2})$/.exec(String(s ?? '').trim())
      if (!m) return parseInt(fb.split(':')[0], 10) * 60 + parseInt(fb.split(':')[1], 10)
      return Math.min(23, parseInt(m[1], 10)) * 60 + Math.min(59, parseInt(m[2], 10))
    }
    const a = settingsStore.appearance || {}
    const start = norm(a.themeLightStart, '07:00')
    const end = norm(a.themeLightEnd, '19:00')
    const now = new Date()
    const t = now.getHours() * 60 + now.getMinutes()
    return start <= end ? (t >= start && t < end) : (t >= start || t < end)
  }

  function applyTheme() {
    const mode = settingsStore.appearance?.themeMode || '浅色'
    const dark = mode === '深色'
      || (mode === '跟随系统' && mq.matches)
      || (mode === '按时间' && !inLightWindow())
    document.documentElement.classList.toggle('dark', dark)
    // 0915：把「当前实际是深还是浅」记下来 —— 下次启动的开屏页（boot.html）据此渲染，
    // 不再永远是一块黑屏（Rust 侧 read_ui_theme() 读的就是这个键）
    try { localStore.setItem('nis.ui.theme', dark ? 'dark' : 'light') } catch { /* ignore */ }
  }
  mq.addEventListener('change', () => { if ((settingsStore.appearance?.themeMode || '浅色') === '跟随系统') applyTheme() })
  watch(() => settingsStore.appearance?.themeMode, applyTheme, { immediate: true })
  // 「按时间」：起止时间改了要立刻生效；再挂一个每分钟的心跳，跨过交界点时自动切换
  watch(
    () => [settingsStore.appearance?.themeLightStart, settingsStore.appearance?.themeLightEnd],
    () => { if ((settingsStore.appearance?.themeMode || '浅色') === '按时间') applyTheme() },
  )
  window.setInterval(() => {
    if ((settingsStore.appearance?.themeMode || '浅色') === '按时间') applyTheme()
  }, 60 * 1000)

  /* ── 0907 动效档位应用器：balanced/eco 给 html 挂降级类，style.css 全局规则随之激活；
   *  full（默认/存量数据缺省）不加任何类——一行降级 CSS 都不生效，零开销。 ── */
  function applyFx() {
    const fx = settingsStore.appearance?.fxLevel || 'full'
    const el = document.documentElement.classList
    el.toggle('fx-balanced', fx === 'balanced')
    el.toggle('fx-eco', fx === 'eco')
  }
  watch(() => settingsStore.appearance?.fxLevel, applyFx, { immediate: true })

  /* ── 0913 字体大小应用器：html.ui-font-sm/lg 用 zoom 整体缩放。
   *   app 内文字多为 px 定值，改根字号无效 → 只能整体 zoom（Chromium / WebView2 均支持）。 ── */
  function applyFontSize() {
    const v = settingsStore.appearance?.fontSize || '标准'
    const el = document.documentElement.classList
    el.toggle('ui-font-sm', v === '小')
    el.toggle('ui-font-lg', v === '大')
  }
  watch(() => settingsStore.appearance?.fontSize, applyFontSize, { immediate: true })

  /* ── 0913 气泡圆角应用器：写 CSS 变量 --dsh-bubble-radius（气泡样式里用 var() 取值） ── */
  function applyBubbleRadius() {
    const v = settingsStore.appearance?.bubbleRadius || '中'
    const px = v === '小' ? '10px' : v === '大' ? '24px' : '16px'
    document.documentElement.style.setProperty('--dsh-bubble-radius', px)
  }
  watch(() => settingsStore.appearance?.bubbleRadius, applyBubbleRadius, { immediate: true })

  /* ── ★1010 用户气泡配色应用器：写 --dsh-user-bubble（渐变）/ -fg（文字色）/ -shadow。
   *  自选色时：① 同色系渐变（第二色 = 亮度 -14%）；② 按 WCAG 相对亮度自动切黑/白字（浅底给深字）。
   *  未设置 → 删除内联变量，回落 CSS 里的原蓝紫渐变。 ── */
  function hexRgb(h: string) {
    let s = String(h || '').replace('#', '')
    if (s.length === 3) s = s.split('').map(c => c + c).join('')
    const n = parseInt(s || '2563eb', 16)
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
  }
  const toHex = (o: { r: number; g: number; b: number }) =>
    '#' + [o.r, o.g, o.b].map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')
  /** 调亮/调暗：pct<0 = 变暗（用于生成渐变第二色） */
  function shade(h: string, pct: number) {
    const { r, g, b } = hexRgb(h)
    const f = (v: number) => (pct < 0 ? v * (1 + pct / 100) : v + (255 - v) * (pct / 100))
    return toHex({ r: f(r), g: f(g), b: f(b) })
  }
  /** 文字色：比较"白字/深字"的实际对比度，取更高的那个（比单纯亮度阈值更稳） */
  function fgFor(h: string) {
    const lum = (c: string) => {
      const { r, g, b } = hexRgb(c)
      const lin = (v: number) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4) }
      return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
    }
    const CR = (a: string, b: string) => { const L1 = lum(a), L2 = lum(b); return (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05) }
    return CR(h, '#ffffff') >= CR(h, '#1f2937') ? '#ffffff' : '#1f2937'
  }
  function applyBubbleColor() {
    const v = String(settingsStore.appearance?.bubbleColor || '')
    const root = document.documentElement.style
    if (!/^#[0-9a-f]{3,8}$/i.test(v)) {
      root.removeProperty('--dsh-user-bubble')
      root.removeProperty('--dsh-user-bubble-fg')
      root.removeProperty('--dsh-user-bubble-shadow')
      return
    }
    root.setProperty('--dsh-user-bubble', `linear-gradient(135deg, ${v} 0%, ${shade(v, -14)} 100%)`)
    root.setProperty('--dsh-user-bubble-fg', fgFor(v))
    const { r, g, b } = hexRgb(v)
    root.setProperty('--dsh-user-bubble-shadow', `rgba(${r}, ${g}, ${b}, 0.28)`)
  }
  watch(() => settingsStore.appearance?.bubbleColor, applyBubbleColor, { immediate: true })

  /* ── ★1010 界面字体应用器：覆盖 Tailwind 的 --font-sans（style.css 里 body 用它 → 全局生效）。
   *  只动界面字体，代码块等用 monospace 的地方不受影响。 ── */
  function applyFontFamily() {
    const v = String(settingsStore.appearance?.fontFamily || '').trim()
    const root = document.documentElement.style
    if (v) root.setProperty('--font-sans', v)
    else root.removeProperty('--font-sans')
  }
  watch(() => settingsStore.appearance?.fontFamily, applyFontFamily, { immediate: true })
}

void bootstrap()
