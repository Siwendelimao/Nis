/**
 * 内置浏览器引擎（0905 七批起按会话隔离）——每个对话窗口一个独立实例（独立 Chromium profile/标签页/登录态）。
 *
 * 设计对齐 docs/handover/HANDOVER-20260905-浏览器.md：
 *  - launchPersistentContext → data/browser-profile/<sessionKey>（会话隔离的持久登录态）；
 *  - 多标签（Page），activeTabId 跟随；导航/前进后退/刷新/停止/截图/cookies；
 *  - PC/移动/自适应视口走 CDP Emulation（热切换）；'auto' 跟随面板尺寸；
 *  - input() 为人接管反传原语（click/key/insertText/hover/wheel/down/up…）；
 *  - onFrame 钩子按实例挂 CDP screencast（server 按 sessionId 广播给对应前端桶）；
 *  - idle 计时：有观看者挂起，离开视图起算 90s 自动 close 释放 Chromium。
 * 渲染/反爬/直播参数（render/cast）是全局共享（设置页改一次全体生效）。
 */
import path from 'node:path'
import fs from 'node:fs'
import { chromium, type BrowserContext, type Page } from 'playwright-core'
import { DATA_ROOT, SKILLS_ROOT } from './paths.ts'

const PROFILE_BASE = path.join(DATA_ROOT, 'browser-profile')
const IDLE_MS = 90_000

/* ★ 0921b 修「浏览器点启动**还是**失败」（用户 0.0.18 复测）—— 真因是**赋值时机**，不是路径没设：
   server.ts 里 `process.env.PLAYWRIGHT_BROWSERS_PATH = envDir` 那行**确实执行了**
   （证据：后端子进程能继承到该变量），但 **playwright-core 在模块加载那一刻就把 registry
   缓存目录算好并缓存了** —— ESM 静态 `import` 全部提升到文件顶部，那行赋值永远晚于 import
   ⇒ 启动仍去 `%LOCALAPPDATA%\ms-playwright` 找，报
   `Executable doesn't exist at C:\...\ms-playwright\chromium_headless_shell-1234\...`。
   实测坐实（`backend/_probe_pw_envorder.mjs`，先清掉继承来的变量）：
     先 import 再设 env  → chromium.executablePath() = C:\Users\...\AppData\Local\ms-playwright\...  ✗
     先设 env 再 import  → chromium.executablePath() = D:\niscs\env\chromium-1234\chrome-win64\...    ✓
   ⇒ 修法：**别让 playwright 自己找内核**。启动时按 envDir 显式解析 `executablePath`
   （安装 / 探测 / 启动三方同源），既不依赖 env 生效时机，也不依赖 playwright 版本。
   server 那行 env 赋值**继续保留** —— 装内核的 playwright CLI 是**子进程**，它靠这个变量定位。 */
let browserEnvDir = ''
/** server 启动 / 设置变更时同步进来（= 设置里的「环境安装目录」envDir） */
export function setBrowserEnvDir(dir: string): void { browserEnvDir = String(dir || '').trim() }

/** 在 envDir 里扫出 Chromium 可执行文件；找不到返回 ''（调用方不传 executablePath，退回 playwright 默认解析） */
function resolveChromiumExe(headless: boolean): string {
  const dir = (browserEnvDir || String(process.env.PLAYWRIGHT_BROWSERS_PATH || '').trim())
  if (!dir) return ''
  try {
    if (!fs.existsSync(dir)) return ''
    const isShell = (n: string) => n.startsWith('chromium_headless_shell') || n.startsWith('chromium-headless-shell')
    // 无头优先 headless-shell（官方为无头裁剪，启动更快）；找不到再退完整版 chrome.exe（也支持 headless）
    const exeNames = headless ? ['chrome-headless-shell.exe', 'chrome.exe'] : ['chrome.exe']
    const cands = fs.readdirSync(dir)
      .filter((n) => n.startsWith('chromium'))
      .filter((n) => (headless ? true : !isShell(n)))   // 有头模式绝不用 headless-shell
      .sort((a, b) => Number(isShell(b) === headless) - Number(isShell(a) === headless))
    for (const d of cands) {
      const base = path.join(dir, d)
      for (const sub of fs.readdirSync(base)) {
        const p = path.join(base, sub)
        try { if (!fs.statSync(p).isDirectory()) continue } catch { continue }
        for (const exe of exeNames) {
          const f = path.join(p, exe)
          if (fs.existsSync(f)) { console.log('[browser] chromium exe → ' + f); return f }
        }
      }
    }
  } catch { /* 目录读不动 = 当作没装，交给 playwright 默认解析兜底 */ }
  return ''
}

interface BrowserTabInfo { id: string; title: string; url: string; active: boolean; isHome?: boolean }
interface ViewportPreset { key: string; label: string; width: number; height: number; dpr: number; mobile: boolean; touch: boolean; userAgent: string }

/** 设备下拉预设（前端只发 key；'auto'=跟随面板尺寸） */
export const VIEWPORTS: Record<string, ViewportPreset> = {
  auto: { key: 'auto', label: '自适应', width: 1280, height: 800, dpr: 1, mobile: false, touch: false, userAgent: '' },
  pc: { key: 'pc', label: 'PC', width: 1280, height: 800, dpr: 1, mobile: false, touch: false, userAgent: '' },
  iphone15: { key: 'iphone15', label: 'iPhone 15', width: 393, height: 852, dpr: 3, mobile: true, touch: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' },
  ipad: { key: 'ipad', label: 'iPad', width: 820, height: 1180, dpr: 2, mobile: true, touch: true, userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile/15E148 Safari/604.1' },
  pixel7: { key: 'pixel7', label: 'Pixel 7', width: 412, height: 915, dpr: 2.6, mobile: true, touch: true, userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36' },
}

/** CDP 直播帧回调（server 注入，帧经 broadcastMux 带 sessionId 推给对应前端桶） */
type FrameCb = (tabId: string, jpegBase64: string, meta: { width: number; height: number }) => void

/** 渲染/直播可调项（全局共享，0905 设置页注入） */
interface BrowserRenderOpts { stealth: boolean; blockMedia: boolean; gpu: boolean; proxy: string }
interface BrowserCastOpts { fps: number; quality: number; scale: number; everyNthFrame: number }
let render: BrowserRenderOpts = { stealth: true, blockMedia: false, gpu: false, proxy: '' }
let cast: BrowserCastOpts = { fps: 11, quality: 60, scale: 2, everyNthFrame: 1 }
export function setRenderOpts(o: Partial<BrowserRenderOpts>) { render = { ...render, ...o } }

/** ★1011k：代理地址解析（既定的口径：设置页填了就走代理，不填=直连）。
 *  接受 `127.0.0.1:7890` 与 `http://user:pass@host:port` 两种写法：
 *   · 没写协议 → 补 http://（本机代理多是 http）
 *   · 带凭据 → 必须拆成 server/username/password（Playwright 不认 server 里的 user:pass，会整条连不上）
 *  解析不出来就返回 undefined（当直连）——宁可直连，也不要因为一个手滑的地址把浏览器启动整个搞崩。 */
export function parseProxyUrl(raw: string): { server: string; username?: string; password?: string } | undefined {
  const s = String(raw || '').trim()
  if (!s) return undefined
  /* ★1011j2：想**彻底绕过系统代理**时填 `direct`（Chromium 认 direct://）——
     Chromium 默认跟随 Windows 系统代理，所以"不填"=跟随系统代理，不等于"直连"。 */
  if (/^direct:?\/?\/?$/i.test(s)) return { server: 'direct://' }
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `http://${s}`
  try {
    const u = new URL(withScheme)
    if (!u.hostname) return undefined
    /* ★1011k：主机名体检 —— `!!!` 这类乱填在 WHATWG URL 里**不会抛异常**（会变成 "http://!!!/"），
       原样交给 Chromium 会启动失败（实测踩过）。只放行常规域名/IPv4/IPv6 字面量。 */
    if (!/^([a-z0-9]([a-z0-9.-]*[a-z0-9])?|\[[0-9a-f:.]+\])$/i.test(u.hostname)) return undefined
    const server = `${u.protocol}//${u.host}`
    const username = u.username ? decodeURIComponent(u.username) : ''
    if (!username) return { server }
    return { server, username, password: decodeURIComponent(u.password || '') }
  } catch { return undefined }
}

export function setCastOpts(o: Partial<BrowserCastOpts>) {
  cast = { ...cast, ...o }
  // 直播参数变了：所有正在看的实例重开 screencast 生效
  for (const inst of instances.values()) { if (inst.onFrame) void inst.restartScreencast() }
}
export function getCastMinIntervalMs(): number { return Math.max(16, Math.round(1000 / Math.max(1, cast.fps))) }

/** 反自动化检测注入（stealth 开关控制） */
const STEALTH_INIT_SRC = `
try {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN','zh','en-US','en'] });
  Object.defineProperty(navigator, 'plugins', { get: () => [1,2,3,4,5] });
  Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
  window.chrome = window.chrome || { runtime: {}, loadTimes: function(){}, csi: function(){} };
  var __qp = navigator.permissions && navigator.permissions.query && navigator.permissions.query.bind(navigator.permissions);
  if (__qp) { navigator.permissions.query = function(par){ return (par && par.name === 'notifications') ? Promise.resolve({ state: (self.Notification && Notification.permission) || 'default' }) : __qp(par); }; }
} catch (e) {}
`

/** 实例注册表：sessionKey → 实例（前端对话窗口与 AI 各按 sessionId 取自己的） */
const instances = new Map<string, BrowserInstance>()
const viewportSessions = new WeakMap<object, any>()   // page → CDP 会话（按 page 复用）★0927 netfix：WeakMap
  // —— 页面关闭后随 Page 对象自动回收；原 Map 强引用会把已关闭页面和 CDP 会话永久攥住（泄漏）

const normUrl = (x: string): string => String(x || '').replace(/\/+$/, '')

/** 实例创建钩子（0905 十五批）：server 注册，给每个新实例挂 onAutoModeChange 广播 */
let instanceHook: ((inst: BrowserInstance) => void) | null = null
export function setInstanceHook(cb: ((inst: BrowserInstance) => void) | null): void { instanceHook = cb }

export function getBrowserInstance(sessionId?: string): BrowserInstance {
  const key = String(sessionId || 'default')
  let inst = instances.get(key)
  if (!inst) {
    inst = new BrowserInstance(key)
    instances.set(key, inst)
    try { instanceHook?.(inst) } catch { /* ignore */ }
  }
  return inst
}

/** 0908③：已创建的实例列表（设置页聚合全部会话的 cookie 用——浏览器按会话隔离后，
 *  不带 sessionId 的 cookiesList 只查 'default' 实例恒空=用户看到"Cookie 0"的根因） */
export function allInstances(): BrowserInstance[] {
  return Array.from(instances.values())
}

export class BrowserInstance {
  readonly key: string
  private context: BrowserContext | null = null
  private tabs: { id: string; page: Page }[] = []
  private activeTabId = ''
  private homeUrl = ''   // 默认首页（start 时由前端传设置默认页；关到最后一个 tab 自动回此页）
  /** ★1011k：实际生效的代理（launch 参数）。变化时必须重启实例才生效，start 里据此判断 */
  private appliedProxy = ''
  private starting: Promise<void> | null = null
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  /* ★0927 R15：观看挂起的**硬上限** —— pauseIdle 后若观众异常断开（前端崩了/直接关窗，
     没调 resumeIdle/unwatch），watching 会卡死 ⇒ Chromium 实例永久占用。
     挂起最长 2 小时，到点恢复 idle（不硬杀；真有人连续看 2 小时以上的场景近乎不存在，
     而重新打开面板会再 pauseIdle 重置本计时）。前端重开面板 watch 会重置计时 ⇒ 不影响正常使用。 */
  private watchCapTimer: ReturnType<typeof setTimeout> | null = null
  private watching = false   // 有观看者期间挂起 idle（0905 五批）
  controlledBy: 'user' | 'ai' | '' = ''   // 占用权（0905 四批）
  private viewportKey = 'pc'
  private customViewport: { width: number; height: number } | null = null
  /** 关闭前记录的标签 URL（0905 八批"释放而非关闭"：idle/刷新后重开时恢复之前的页面） */
  private restoreUrls: string[] = []
  onFrame: FrameCb | null = null
  private screencastSession: { cdp: any; tabId: string } | null = null
  /** 页面 console/pageerror 环形缓冲（wb_console） */
  consoleBuf: string[] = []
  /** 有头/无头（per-instance：0905 十一批，会话 A 切有头过验证不影响会话 B） */
  mode: 'headed' | 'headless' = 'headless'
  /** 主动关闭标志（0905 十四批：区分用户点有头窗口 × 的意外关闭） */
  private closingIntentionally = false
  /** 0908②修复回归：context 正在死亡（窗口被点×/close()）——期间 page close 不再 ensureHome/落快照，
   *  否则关最后一个 tab 会当场复活首页（有头窗弹回来）+ 用只剩首页的快照覆盖好数据（tab 全丢） */
  private contextDying = false
  /** 自动切回无头时通知（0905 十五批：server 注册，广播 status 帧让前端图标同步） */
  onAutoModeChange: ((mode: 'headed' | 'headless') => void) | null = null
  /** 标签增删/激活变化通知（0908②：server 注册，广播 browser/tabs 帧——有头手动开的页也能即时进面板） */
  onTabsChange: (() => void) | null = null

  /** 标签快照落盘（0905 十四批：进程重启/应用重开后打开旧对话仍能恢复之前的标签） */
  private get snapshotPath(): string { return path.join(this.profileDir, 'tabs.json') }
  private persistTabsSnapshot(): void {
    try {
      const tabs = this.listTabs().filter(t => t.url && t.url !== 'about:blank')
      if (!tabs.length) return
      fs.writeFileSync(this.snapshotPath, JSON.stringify({ urls: tabs.map(t => t.url), active: (tabs.find(t => t.active) || tabs[0]).url, savedAt: Date.now() }), 'utf-8')
    } catch { /* ignore */ }
  }
  private readTabsSnapshot(): { urls: string[]; active?: string } | null {
    try {
      const d = JSON.parse(fs.readFileSync(this.snapshotPath, 'utf-8'))
      if (Array.isArray(d?.urls) && d.urls.length) return d
    } catch { /* ignore */ }
    return null
  }

  constructor(key: string) { this.key = key }

  private get profileDir(): string {
    // default 实例沿用历史目录（保留既有登录态），其余按会话隔离
    return this.key === 'default' ? PROFILE_BASE : path.join(PROFILE_BASE, this.key.replace(/[^\w-]/g, '_'))
  }

  private touchIdle() {
    if (this.watching) return
    if (this.idleTimer) clearTimeout(this.idleTimer)
    if (this.context) this.idleTimer = setTimeout(() => { void this.close().catch(() => {}) }, IDLE_MS)
  }

  /** 观看者在场：挂起 idle（有人看着就不自动关） */
  pauseIdle(): void {
    this.watching = true
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null }
    /* ★0927 R15：硬上限 2 小时——观众异常断开没解挂起时兜底释放（防 Chromium 永久占用）；
       到点仅恢复 idle（90s 后才关），前端重开面板会重置本计时，不影响正常长时间观看 */
    if (this.watchCapTimer) clearTimeout(this.watchCapTimer)
    this.watchCapTimer = setTimeout(() => {
      console.warn(`[browser] 观看挂起已达 2 小时硬上限，恢复 idle（实例 ${this.key}）`)
      this.watching = false
      this.touchIdle()
    }, 2 * 60 * 60 * 1000)
  }
  /** 离开视图：恢复 idle，从现在起算 90s */
  resumeIdle(): void {
    this.watching = false
    if (this.watchCapTimer) { clearTimeout(this.watchCapTimer); this.watchCapTimer = null }
    this.touchIdle()
  }
  private tabId(page: Page): string {
    const existing = this.tabs.find(t => t.page === page)
    if (existing) return existing.id
    const id = 'tab-' + Math.random().toString(36).slice(2, 9)
    this.tabs.push({ id, page })
    // console 消息环形缓冲（wb_console 工具读，AI 调试 SPA 报错用）
    if (!(page as any).__nisConsoleHooked) {
      ;(page as any).__nisConsoleHooked = true
      try {
        page.on('console', (msg: any) => {
          try {
            const line = `[${msg.type()}] ${String(msg.text()).slice(0, 300)}`
            this.consoleBuf.push(line)
            if (this.consoleBuf.length > 200) this.consoleBuf.splice(0, this.consoleBuf.length - 200)
          } catch { /* ignore */ }
        })
        page.on('pageerror', (err: Error) => {
          try {
            this.consoleBuf.push(`[pageerror] ${String(err?.message || err).slice(0, 300)}`)
            if (this.consoleBuf.length > 200) this.consoleBuf.splice(0, this.consoleBuf.length - 200)
          } catch { /* ignore */ }
        })
      } catch { /* ignore */ }
    }
    return id
  }

  private syncActive(page: Page) {
    const id = this.tabId(page)
    if (id !== this.activeTabId) { this.activeTabId = id; if (this.onFrame) void this.restartScreencast() }
  }

  /** 统一标签收养（0908②）：context 里出现的任何页面——引擎 newPage、有头窗口用户手动 Ctrl+T、
   *  点击 _blank 链接（含 window.open）——都经此进入账本。此前只靠 newTab/restore 三处手动注册，
   *  手动 tab 不进 tabs → listTabs/restoreUrls/tabs.json 全不含它 = "手动开的不进列表、切走再切回就没了"。
   *  幂等：newPage 的 await 与 context 'page' 事件先后不定，同一 page 二次进入直接返回既有 id。 */
  private adoptPage(pg: Page): string {
    const existing = this.tabs.find(t => t.page === pg)
    if (existing) return existing.id
    const id = this.tabId(pg)
    pg.on('close', () => {
      this.tabs = this.tabs.filter(t => t.page !== pg)
      if (!this.tabs.some(t => t.id === this.activeTabId)) {
        this.activeTabId = this.tabs[0]?.id || ''
        if (this.onFrame) void this.restartScreencast()
      }
      if (this.contextDying) return   // 整窗关闭中：不广播不补首页（见 contextDying 注释）
      try { this.onTabsChange?.() } catch { /* ignore */ }
      // ⚠ 这里绝不 persistTabsSnapshot：点 × 关窗时 Chromium 逐页发 close，若每次落盘
      // 会把快照逐步覆盖成"只剩最后一个/零个 tab"（0908②回归实锤：无头恢复后 tab 全丢）。
      // 快照的写入点=navigate/newTab/closeTab/switchTab（用户关掉的旧 tab 若残留在快照里，
      // 下次恢复会复活它——既有语义，自愈于下次导航）。
      // 用户手动关掉最后一个标签也要自动回首页（此前只有程序性 closeTab 会兜）。
      // 0908②回归修复：有头窗口点 × 时页面 close 先于 context close 触发，立即 ensureHome
      // 会在垂死 context 上抢开新窗（=用户看到的"关掉又弹出默认页有头窗"）。延迟 1.2s 复查：
      // context 还活着才补首页。
      if (!this.tabs.length && this.context) {
        setTimeout(() => {
          if (this.context && this.isRunning() && !this.tabs.length) void this.ensureHome()
        }, 1200)
      }
    })
    // 手动新开的页也要吃到当前视口预设（否则 _blank 弹窗保持原生尺寸，auto 档下与面板画面不一致）
    void this.applyViewport(this.viewportKey, pg).catch(() => {})
    // 0908②补：adopt 瞬间手动页常还是 about:blank（被 persist 过滤），真实 URL 要等加载——
    // 主框架导航事件里节流落快照，否则有头点 × 后 tabs.json 缺手动页最终 URL=恢复丢失。
    let navPersistTimer: ReturnType<typeof setTimeout> | null = null
    pg.on('framenavigated', (frame: any) => {
      if (frame !== pg.mainFrame()) return
      if (navPersistTimer) return
      navPersistTimer = setTimeout(() => {
        navPersistTimer = null
        try { this.persistTabsSnapshot() } catch { /* ignore */ }
      }, 600)
    })
    this.persistTabsSnapshot()
    try { this.onTabsChange?.() } catch { /* ignore */ }
    return id
  }

  /** 若已无标签页（关到最后一个），自动开一个默认首页 tab */
  private async ensureHome(): Promise<void> {
    if (!this.context || this.tabs.length) return
    try {
      const page = await this.context.newPage()
      const id = this.adoptPage(page)
      this.activeTabId = id
      if (this.homeUrl && this.homeUrl !== 'about:blank') await page.goto(this.homeUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {})
    } catch { /* ignore */ }
  }

  private getTab(tabIdArg?: string): Page {
    if (!this.context) throw new Error('浏览器未就绪（可能正在切换有头/无头模式）。最多再试一次；若仍失败，请放弃浏览器操作，直接告知用户"浏览器暂不可用"，不要反复重试')
    if (tabIdArg) { const t = this.tabs.find(x => x.id === tabIdArg); if (t) return t.page }
    const a = this.tabs.find(x => x.id === this.activeTabId)
    if (a) return a.page
    if (this.tabs.length) { this.activeTabId = this.tabs[0].id; return this.tabs[0].page }
    throw new Error('没有可用的标签页')
  }

  /** 供 server：激活页或抛错（人机反传/AI 工具共用） */
  requirePage(): Page { return this.getTab() }
  tryGetTab(): Page | null { try { return this.getTab() } catch { return null } }

  isRunning(): boolean { return this.context !== null }
  currentStatus() {
    return { connected: !!this.context, mode: this.mode, viewport: this.viewportKey, tabs: this.listTabs(), activeTabId: this.activeTabId }
  }

  listTabs(): BrowserTabInfo[] {
    return this.tabs.map(t => {
      let url = '', title = ''
      try { url = t.page.url() } catch { /* page closed */ }
      // isHome：默认首页标签（AI 口径里"打开的第 N 个网站"不该把它数进去）；去尾斜杠归一化比较
      const norm = (x: string) => x.replace(/\/+$/, '')
      return { id: t.id, url, title, active: t.id === this.activeTabId, isHome: !!this.homeUrl && norm(url) === norm(this.homeUrl) }
    })
  }

  getHomeUrl(): string { return this.homeUrl }

  /** 启动（幂等）；mode 变化需重启才生效 */
  async start(opts?: { mode?: 'headed' | 'headless'; home?: string }): Promise<void> {
    /* ★0930：显式带 home 的启动=用户点启动，首页必须真落地（见下方恢复分支） */
    const homeGiven = typeof opts?.home === 'string' && !!String(opts.home).trim()
    if (homeGiven) this.homeUrl = String(opts.home).trim()
    this.closingIntentionally = false
    this.contextDying = false
    /* ★1011k：代理变了同样要重启实例（代理是 launch 参数，不重启就不生效）——
       否则用户改完设置再点"启动"，走的还是老路由，又是一次"设置了没用"。 */
    const proxyChanged = !!this.context && this.appliedProxy !== String(render.proxy || '').trim()
    if (this.context) { if ((opts?.mode && opts.mode !== this.mode) || proxyChanged) { await this.close(); } else { this.touchIdle(); return } }
    if (this.starting) { await this.starting; return }
    this.mode = opts?.mode ?? this.mode
    this.starting = (async () => {
      try { fs.mkdirSync(this.profileDir, { recursive: true }) } catch { /* ignore */ }
      const args = ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled', '--disable-infobars']
      args.push(render.gpu ? '--enable-gpu' : '--disable-gpu')
      if (render.blockMedia) args.push('--autoplay-policy=user-gesture-required')
      /* ★1010l：OpenCLI 的 Browser Bridge 扩展（Reddit / Facebook / Instagram / 小红书 / Boss 都靠它）。
         内置浏览器是 Playwright Chromium —— **没有 Chrome 商店集成**（在里面点"添加至 Chrome"必然失败），
         只能从磁盘加载**已解包**的扩展目录。目录由人放好（从 Edge 的 Extensions/ 拷出），
         以 manifest.json 存在为判据 ⇒ 没放目录时行为与从前完全一致。 */
      try {
        /* 优先「技能目录」（扩展随 agent-reach 技能走 ⇒ 打包版里也自带，用户零手动）；
           退回 data 目录（手工放置）。两者都以 manifest.json 存在为判据。 */
        const extDir = [
          path.join(SKILLS_ROOT, 'agent-reach', 'opencli-extension'),
          path.join(DATA_ROOT, 'opencli-extension'),
        ].find(d => fs.existsSync(path.join(d, 'manifest.json')))
        if (extDir) args.push(`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`)
      } catch { /* ignore */ }
      const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36'
      this.context = await chromium.launchPersistentContext(this.profileDir, {
        // 0921b：显式指定内核（envDir 里那套），不再依赖 playwright 的缓存目录推断
        executablePath: resolveChromiumExe(this.mode === 'headless') || undefined,
        headless: this.mode === 'headless',
        viewport: null,
        userAgent: render.stealth ? ua : undefined,
        locale: 'zh-CN',
        /* ★1011k：代理（设置页可填，空=直连）。只在 launch 时生效 ⇒ start 里检测到变化会重启实例 */
        proxy: parseProxyUrl(render.proxy),
        args,
      })
      this.appliedProxy = String(render.proxy || '').trim()
      if (render.stealth) { try { await this.context.addInitScript({ content: STEALTH_INIT_SRC }) } catch { /* ignore */ } }
      if (render.blockMedia) {
        try { await this.context.route('**/*', (route: any) => { const t = route.request().resourceType(); return t === 'media' ? route.abort() : route.continue() }) } catch { /* ignore */ }
      }
      this.context.on('close', () => {
        this.contextDying = true
        this.context = null; this.tabs = []; this.activeTabId = ''
        // 0905 十四批：有头窗口被用户直接点 × 关掉（非程序性关闭）→ 自动切回无头并恢复标签
        if (!this.closingIntentionally && this.mode === 'headed') {
          this.mode = 'headless'
          void this.start({ mode: 'headless' })
            .then(() => { try { this.onAutoModeChange?.('headless') } catch { /* ignore */ } })
            .catch(() => {})
        }
      })
      // 0908②(a/b)：收养 context 里出现的一切页面——有头窗口用户手动 Ctrl+T / 页面 window.open
      // 产生的新窗口都走这里进账本（此前无人监听 → 手动 tab 不进 tabs 列表，面板不显示、
      // close 时 restoreUrls 也不含它 = "手动开的不进列表、切走再回来没了"）。幂等，不抢激活。
      this.context.on('page', (pg: Page) => { try { this.adoptPage(pg) } catch { /* ignore */ } })
      // 0905 八批"释放而非关闭"：内存快照 → 磁盘快照 → 默认首页，三级恢复
      const memRestore = this.restoreUrls.splice(0)
      const snap = this.readTabsSnapshot()
      const restore = memRestore.length ? memRestore : (snap?.urls || [])
      if (restore.length) {
        // 激活页：内存快照=第一个；磁盘快照=按 active url 匹配（匹配不到则第一个兜底）
        const activeTarget = memRestore.length ? null : (snap?.active || null)
        let firstDone = false
        for (const u of restore) {
          try {
            const pg = firstDone ? await this.context.newPage() : (this.context.pages()[0] || await this.context.newPage())
            const id = this.adoptPage(pg)
            const isActive = !firstDone && (!activeTarget || normUrl(u) === normUrl(activeTarget))
            if (isActive) { this.activeTabId = id; firstDone = true }
            // 0905 十六批：tab 先立出来、页面后台加载——激活页只等 commit（导航开始、URL 确定，通常<1s），
            // 其余页完全后台恢复；tab 胶囊随 start 返回立即出现，内容由 2s 轮询陆续补全
            if (isActive) {
              await pg.goto(u, { waitUntil: 'commit', timeout: 8000 }).catch(() => {})
            } else {
              void pg.goto(u, { waitUntil: 'commit', timeout: 8000 }).catch(() => {})
            }
          } catch { /* ignore */ }
        }
        // activeTarget 没匹配到任何页（激活页已关）→ 第一个标签兜底为激活页
        if (!this.activeTabId && this.tabs.length) this.activeTabId = this.tabs[0].id
        /* ★0930 修（实测"设置里首页设了谷歌，打开浏览器却没落在首页"）：
           旧实现只有「无恢复标签」那条 else 分支才 goto 首页——用过一次后几乎总有恢复标签
           ⇒ 配置的首页永远不出现。现在：显式带 home 的启动把首页落地为【激活页】，
           已恢复的页保留（后台加载不丢工作现场）；若恢复列表里已有首页就直接激活它不重复开。 */
        if (homeGiven && this.homeUrl && this.homeUrl !== 'about:blank') {
          const homeNorm = normUrl(this.homeUrl)
          const homeTab = this.tabs.find((t) => { try { return normUrl(t.page.url()) === homeNorm } catch { return false } })
          if (homeTab) {
            this.activeTabId = homeTab.id
          } else {
            try {
              const pg = await this.context.newPage()
              const id = this.adoptPage(pg)
              this.activeTabId = id
              await pg.goto(this.homeUrl, { waitUntil: 'commit', timeout: 30000 }).catch(() => {})
            } catch { /* ignore */ }
          }
        }
      } else {
        const first = this.context.pages()[0] || await this.context.newPage()
        this.activeTabId = this.adoptPage(first)
        /* ★1011j2：首页导航改用 commit（导航一提交即算成功）+ 30s——
           原来 domcontentloaded + 15s 在冷启动/走代理时偶发超时，表现就是"设了首页却停在 about:blank"
           （实测；失败被 catch 吞掉所以看着像设置没生效）。恢复标签那条路一直用 commit，这里与它对齐。 */
        if (this.homeUrl && this.homeUrl !== 'about:blank') { try { await first.goto(this.homeUrl, { waitUntil: 'commit', timeout: 30000 }).catch(() => {}) } catch { /* ignore */ } }
      }
      await this.applyViewport(this.viewportKey)
      this.touchIdle()
      // 冷启动/恢复完成后若已有人观看，立即挂直播（否则帧流要到下一次交互才出现）
      if (this.onFrame) void this.restartScreencast()
    })()
    try { await this.starting } finally { this.starting = null }
  }

  async close(): Promise<void> {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null }
    if (this.watchCapTimer) { clearTimeout(this.watchCapTimer); this.watchCapTimer = null }   // ★0927 R15
    this.watching = false   // ★0927 R15：关了就不算挂起了（下次 start 重新计）
    // 记录标签快照供下次 start 恢复（内存 + 落盘；释放缓存而非丢状态）
    try {
      this.restoreUrls = this.listTabs().map(t => t.url).filter(u => u && u !== 'about:blank')
      this.persistTabsSnapshot()
    } catch { this.restoreUrls = [] }
    const s = this.screencastSession
    this.screencastSession = null
    if (s) { try { await s.cdp.send('Page.stopScreencast') } catch { /* ignore */ } try { await s.cdp.detach() } catch { /* ignore */ } }
    const c = this.context
    this.context = null; this.tabs = []; this.activeTabId = ''
    if (c) { try { await c.close() } catch { /* ignore */ } }
  }

  /** 导航；url 缺协议自动补 https */
  async navigate(url: string, tabIdArg?: string): Promise<{ url: string }> {
    await this.start()
    const page = this.getTab(tabIdArg)
    let u = (url || '').trim()
    if (u && !/^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(u)) u = (/^[\w-]+(\.[\w-]+)+/.test(u) || u.startsWith('localhost')) ? 'https://' + u : u
    const resp = await page.goto(u || 'about:blank', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(e => { throw new Error('导航失败：' + String(e?.message || e)) })
    // 0905 六批：指定其它 tab 导航时不要把用户正在看的画面切走
    if (!tabIdArg || tabIdArg === this.activeTabId) this.syncActive(page)
    this.touchIdle()
    this.persistTabsSnapshot()
    return { url: resp?.url() || u }
  }

  async newTab(url?: string): Promise<{ id: string }> {
    await this.start()
    const page = await this.context!.newPage()
    const id = this.adoptPage(page)
    this.activeTabId = id
    // 0905：新标签一律跟随默认首页，不再留 about:blank（url 参数优先）
    const target = (url || '').trim() || (this.homeUrl && this.homeUrl !== 'about:blank' ? this.homeUrl : '')
    if (target) { try { await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 20000 }) } catch { /* ignore */ } }
    await this.applyViewport(this.viewportKey, page)
    if (this.onFrame) void this.restartScreencast()
    this.touchIdle()
    this.persistTabsSnapshot()
    return { id }
  }

  async closeTab(tabIdArg: string): Promise<{ tabs: BrowserTabInfo[] }> {
    const t = this.tabs.find(x => x.id === tabIdArg)
    if (t) { try { await t.page.close() } catch { /* ignore */ } this.tabs = this.tabs.filter(x => x !== t) }
    if (this.activeTabId === tabIdArg) this.activeTabId = this.tabs[0]?.id || ''
    await this.ensureHome()
    if (this.onFrame) void this.restartScreencast()
    this.touchIdle()
    this.persistTabsSnapshot()
    return { tabs: this.listTabs() }
  }

  async switchTab(tabIdArg: string): Promise<void> {
    const t = this.tabs.find(x => x.id === tabIdArg)
    if (!t) throw new Error('标签页不存在')
    this.activeTabId = tabIdArg
    try { await t.page.bringToFront() } catch { /* ignore */ }
    if (this.onFrame) void this.restartScreencast()
    this.touchIdle()
    this.persistTabsSnapshot()
  }

  async goBack(tabIdArg?: string) { const p = this.getTab(tabIdArg); await p.goBack().catch(() => {}); if (!tabIdArg || tabIdArg === this.activeTabId) this.syncActive(p); this.touchIdle() }
  async goForward(tabIdArg?: string) { const p = this.getTab(tabIdArg); await p.goForward().catch(() => {}); if (!tabIdArg || tabIdArg === this.activeTabId) this.syncActive(p); this.touchIdle() }
  async reload(tabIdArg?: string, hard = false) { const p = this.getTab(tabIdArg); await p.reload({ waitUntil: hard ? 'load' : 'domcontentloaded' }).catch(() => {}); this.touchIdle() }
  async stop(tabIdArg?: string) { try { const p = this.getTab(tabIdArg); await p.evaluate('window.stop&&window.stop()').catch(() => {}) } catch { /* ignore */ } }

  async screenshot(tabIdArg?: string, type: 'png' | 'jpeg' = 'jpeg', quality = 60): Promise<{ data: string; mime: string; width: number; height: number }> {
    const p = this.getTab(tabIdArg)
    const buf = await p.screenshot({ type, quality: type === 'jpeg' ? quality : undefined, fullPage: false })
    this.touchIdle()
    const vp = p.viewportSize() || { width: 1280, height: 800 }
    return { data: buf.toString('base64'), mime: `image/${type}`, width: vp.width, height: vp.height }
  }

  /** 当前生效预设：auto=面板自适应尺寸，其余查表 */
  private effectivePreset(): ViewportPreset {
    if (this.viewportKey === 'auto' && this.customViewport && this.customViewport.width >= 200 && this.customViewport.height >= 200) {
      return { ...VIEWPORTS.pc, width: Math.round(this.customViewport.width), height: Math.round(this.customViewport.height) }
    }
    return VIEWPORTS[this.viewportKey] || VIEWPORTS.pc
  }

  /** 应用视口预设（CDP 覆盖，热切换 UA/触摸/尺寸/mobile）；page 缺省=active */
  async applyViewport(key: string, pageArg?: Page): Promise<void> {
    this.viewportKey = key
    const preset = this.effectivePreset()
    const page = pageArg || this.tryGetTab()
    if (!page || !this.context) return
    try {
      // 0906 体检 P2#17：CDP 会话按 page 复用（每次新建从不 detach → 句柄累积泄漏）
      let cdp = viewportSessions.get(page)
      if (!cdp) {
        cdp = await this.context.newCDPSession(page)
        viewportSessions.set(page, cdp)
      }
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: preset.width, height: preset.height, deviceScaleFactor: preset.dpr, mobile: preset.mobile,
      })
      if (preset.userAgent) await cdp.send('Emulation.setUserAgentOverride', { userAgent: preset.userAgent })
      else await cdp.send('Emulation.setUserAgentOverride', { userAgent: '' }).catch(() => {})
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: preset.touch, maxTouchPoints: preset.touch ? 5 : 0 }).catch(() => {})
      await page.setViewportSize({ width: preset.width, height: preset.height }).catch(() => {})
    } catch {
      await page.setViewportSize({ width: preset.width, height: preset.height }).catch(() => {})
    }
  }

  async setViewport(key: string, custom?: { width: number; height: number }): Promise<{ viewport: string }> {
    if (key === 'auto') {
      const w = Math.min(4000, Math.max(200, Math.round(custom?.width || this.customViewport?.width || VIEWPORTS.pc.width)))
      const h = Math.min(4000, Math.max(200, Math.round(custom?.height || this.customViewport?.height || VIEWPORTS.pc.height)))
      this.customViewport = { width: w, height: h }
    }
    await this.applyViewport(key)
    if (this.onFrame) void this.restartScreencast()
    this.touchIdle()
    return { viewport: this.viewportKey }
  }

  /** 切换有头/无头（需重启 context；标签页经 restoreUrls 恢复——页面/登录态延续，正好用于"人工过验证"） */
  async setMode(mode: 'headed' | 'headless'): Promise<void> {
    if (mode === this.mode && this.context) return
    await this.close()
    await this.start({ mode })
  }

  async cookiesList(): Promise<any[]> { if (!this.context) return []; return this.context.cookies() }
  async cookiesClear(): Promise<void> { if (this.context) await this.context.clearCookies() }

  /** 人接管反传原语：action ∈ click/dblclick/rightclick/move/hover/wheel/key/text/insertText/down/up/touch */
  async input(action: string, args: Record<string, any>, tabIdArg?: string): Promise<{ cursor?: string } | void> {
    const p = this.getTab(tabIdArg)
    if (!tabIdArg || tabIdArg === this.activeTabId) this.syncActive(p)
    const x = Number(args.x || 0), y = Number(args.y || 0)
    const mobile = (VIEWPORTS[this.viewportKey] || VIEWPORTS.pc).touch
    switch (action) {
      case 'click': await p.mouse.click(x, y); break
      case 'dblclick': await p.mouse.dblclick(x, y); break
      case 'rightclick': await p.mouse.click(x, y, { button: 'right' }); break
      case 'move': await p.mouse.move(x, y); break
      // 0908②(c)：down 必须先移动到位再按下。此前 down 不带 move，按下位置=最后一次
      // hover 探测（100ms 节流）的旧坐标——快速点击时两位置差出几像素/差一个元素=点击偶发无效。
      // up 不带坐标=在当前位置松手（拖拽途中 move 已持续更新位置，语义正确）。
      case 'down': await p.mouse.move(x, y); await p.mouse.down(); break
      case 'up': await p.mouse.up(); break
      case 'wheel': await p.mouse.wheel(Number(args.dx || 0), Number(args.dy || 0)); break
      case 'key': await p.keyboard.press(String(args.key || 'Enter')); break
      case 'text': await p.keyboard.type(String(args.text || '')); break
      case 'insertText': await p.keyboard.insertText(String(args.text || '')); break
      case 'hover': {
        await p.mouse.move(x, y)
        const cursor = await p.evaluate(`(() => { const el = document.elementFromPoint(${x}, ${y}); if (!el) return 'default'; const c = getComputedStyle(el).cursor; if (c && c !== 'auto') return c; const t = el.closest('a,button,[role=button],select,label,[onclick],summary'); if (t) return 'pointer'; const inp = el.closest('input,textarea,[contenteditable],[contenteditable] *'); return inp ? 'text' : 'default' })()`).catch(() => 'default')
        return { cursor: typeof cursor === 'string' ? cursor : 'default' }
      }
      case 'touch': if (mobile) { await p.touchscreen.tap(x, y) } else { await p.mouse.click(x, y) } break
      default: throw new Error('未知输入动作：' + action)
    }
    this.touchIdle()
  }

  /** 注册帧回调并对 active 页开 CDP screencast */
  setFrameCallback(cb: FrameCb | null): void {
    this.onFrame = cb
    if (cb) void this.restartScreencast()
    else void this.stopScreencast()
  }

  private async stopScreencast(): Promise<void> {
    const s = this.screencastSession
    this.screencastSession = null
    if (s) { try { await s.cdp.send('Page.stopScreencast') } catch { /* ignore */ } try { await s.cdp.detach() } catch { /* ignore */ } }
  }

  /** 重启直播：切标签/切视口/开合 watch 时重新挂一个（且仅一个）CDP screencast 会话到当前激活页 */
  async restartScreencast(): Promise<void> {
    await this.stopScreencast()
    if (!this.onFrame || !this.context) return
    const tab = this.tabs.find(t => t.id === this.activeTabId)
    if (!tab) return
    try {
      const cdp = await this.context.newCDPSession(tab.page)
      this.screencastSession = { cdp, tabId: tab.id }
      cdp.on('Page.screencastFrame', (ev: any) => {
        if (!this.screencastSession || this.screencastSession.tabId !== tab.id) { cdp.send('Page.screencastFrameAck', { sessionId: ev.sessionId }).catch(() => {}); return }
        try { this.onFrame && this.onFrame(tab.id, ev.data, { width: ev.metadata?.deviceWidth || 0, height: ev.metadata?.deviceHeight || 0 }) } catch { /* ignore */ }
        cdp.send('Page.screencastFrameAck', { sessionId: ev.sessionId }).catch(() => {})
      })
      const preset = this.effectivePreset()
      await cdp.send('Page.startScreencast', { format: 'jpeg', quality: cast.quality, maxWidth: preset.width * cast.scale, maxHeight: preset.height * cast.scale, everyNthFrame: cast.everyNthFrame })
    } catch { this.screencastSession = null }
  }

  /** 页面可读快照（AI wb_snapshot 用；8k 截断——0905 实测 20k/次把上下文吃到 454k tokens，LLM 越跑越慢） */
  async snapshot(tabIdArg?: string): Promise<{ title: string; url: string; text: string }> {
    const p = this.getTab(tabIdArg)
    const title = await p.title().catch(() => '')
    const url = p.url()
    const text = await p.evaluate('document.body ? document.body.innerText.slice(0, 8000) : ""').catch(() => '')
    return { title, url, text }
  }
}
