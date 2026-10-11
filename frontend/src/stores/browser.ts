import { defineStore } from 'pinia'
import { ref, reactive, computed } from 'vue'
import { localStore } from '@/utils/localStore'

import { swallowed } from '@/utils/swallowed'
interface BrowserPage {
  id: string
  title: string
  url: string
  active: boolean
}

/** 浏览器渲染/直播/反爬参数（权威存后端 browser-settings.json；前端读/写走 browser.getSettings/setSettings） */
export interface BrowserSettings {
  castFps: number
  castQuality: number
  castScale: number
  castEveryNth: number
  stealth: boolean
  blockMedia: boolean
  gpu: boolean
  /** ★1011k：代理地址（如 http://127.0.0.1:7890）；空=直连。权威存后端 browser-settings.json */
  proxy: string
}

const BROWSER_CFG_KEY = 'nis-browser-config'

/** ★1011j：默认首页归一化 —— 只写域名的（用户填的 `www.google.com`）补成完整 URL。
 *  背景（实测）：设置里填了默认首页，进浏览器却停在 about:blank，看着像"设置没生效"。
 *  实测两件事：① Playwright 对无协议地址容错不稳（`127.0.0.1:8766` 能补 http，域名常失败）；
 *  ② 后端 goto 失败被 catch 静默吞掉、界面零提示 ⇒ 用户无从判断。
 *  这里统一补全（本地回环走 http，其余走 https），异常提示也就能报出完整地址。 */
export function normalizeHomeUrl(raw: string): string {
  const s = String(raw || '').trim()
  if (!s) return ''
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return s   // 带 // 的完整 URL（http(s)://、file://）
  if (/^(about|data|blob|chrome|edge):/i.test(s)) return s   // 浏览器内置页（about:blank 等）
  if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?(\/|$)/i.test(s)) return 'http://' + s
  return 'https://' + s
}

/** ★1011k：代理地址归一化 —— 只写 `127.0.0.1:7890` 的补 http://。
 *  与后端 parseProxyUrl 同口径（前端归一化只为让用户看到完整地址；后端仍会自己解析一遍，两边互不依赖）。 */
export function normalizeProxyUrl(raw: string): string {
  const s = String(raw || '').trim()
  if (!s) return ''
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : 'http://' + s
}

interface BrowserConfig {
  mode: 'headed' | 'headless'
  engine: string
  defaultUrl: string
  viewport: string
}

function loadConfig(): BrowserConfig {
  try {
    const raw = localStore.getItem(BROWSER_CFG_KEY)
    if (raw) {
      const d = JSON.parse(raw)
      return {
        mode: d.mode === 'headed' ? 'headed' : 'headless',
        engine: typeof d.engine === 'string' ? d.engine : 'Chromium',
        defaultUrl: typeof d.defaultUrl === 'string' ? d.defaultUrl : '',
        viewport: typeof d.viewport === 'string' ? d.viewport : 'auto',
      }
    }
  } catch {
    /* ignore */
  }
  return { mode: 'headless', engine: 'Chromium', defaultUrl: '', viewport: 'auto' }
}

/** 单个对话窗口的浏览器运行态（0905 七批：浏览器按会话隔离，后端每会话独立实例） */
interface BrowserConvState {
  connected: boolean
  status: string
  loading: boolean
  screenshot: string
  screenshotMime: string
  pages: BrowserPage[]
  scroll: { y: number; h: number; vh: number }
  /** 占用权：'ai'=AI 操作中 / 'user'=人接管中 / ''=空闲 */
  controlledBy: 'user' | 'ai' | ''
  /** 接管开关（与 controlledBy==='user' 同步） */
  takeover: boolean
  viewport: string
  /** 最后访问的 http(s) 页（重连恢复提示用；不再作为启动首页——首页恒用设置默认页） */
  lastUrl: string
  lastUsedAt: number
  /** AI 最近一次操作时间（按钮标识滑动窗口用，工具间隙不闪灭） */
  aiLastActiveAt: number
  /** 有头/无头（browser/status 帧同步——含有头窗口被点 × 后自动回无头的后端广播） */
  mode: 'headed' | 'headless'
}

function newConvState(viewport: string): BrowserConvState {
  return {
    connected: false, status: '', loading: false, screenshot: '', screenshotMime: 'image/jpeg',
    pages: [], scroll: { y: 0, h: 0, vh: 0 }, controlledBy: '', takeover: false,
    viewport, lastUrl: '', lastUsedAt: 0, aiLastActiveAt: 0, mode: 'headless',
  }
}

/**
 * 内置浏览器 store（0905 七批：按对话窗口隔离）
 *  - 全局部分：config（localStorage 持久）+ settings（后端权威）
 *  - 会话部分：bucket(convId) 返回该窗口独立的运行态（画面/标签/接管/滚动…）
 *  - 后端每会话独立 Chromium 实例；mux 帧 browser/* 带 sessionId，由 ChatInterface 路由进对应桶
 */
export const useBrowserStore = defineStore('browser', () => {
  const config = ref<BrowserConfig>(loadConfig())
  const settings = reactive<BrowserSettings>({ castFps: 11, castQuality: 60, castScale: 2, castEveryNth: 1, stealth: true, blockMedia: false, gpu: false, proxy: '' })

  /** 各会话运行态桶 */
  const convs = reactive<Record<string, BrowserConvState>>({})
  function bucket(convId: string | null | undefined): BrowserConvState {
    const key = String(convId || 'default')
    if (!convs[key]) convs[key] = newConvState(config.value.viewport)
    return convs[key]
  }

  function setViewportGlobal(val: string) {
    config.value.viewport = val
    persist()
  }

  function persist() {
    try {
      localStore.setItem(BROWSER_CFG_KEY, JSON.stringify(config.value))
    } catch {
      /* ignore */
    }
  }

  async function loadSettings(rpc: (m: string, p?: Record<string, any>) => Promise<any>) {
    try { const v = await rpc('browser.getSettings'); if (v) Object.assign(settings, v) }
    catch (e) { swallowed('内置浏览器设置读取失败（界面按默认值显示，会看着像"设置被重置"）', e) }
  }
  async function saveSettings(rpc: (m: string, p?: Record<string, any>) => Promise<any>, patch: Partial<BrowserSettings>) {
    try { const v = await rpc('browser.setSettings', patch); if (v?.settings) Object.assign(settings, v.settings) }
    catch (e) { swallowed('浏览器设置未同步到后端（本地已改、后端未生效）', e) }
  }

  function setDefaultUrl(val: string) { config.value.defaultUrl = val; persist() }
  /** ★1011j：默认首页（已归一化）—— 启动浏览器/设置页启动按钮统一读这个，别各自裸读 config.defaultUrl */
  const homeUrl = computed(() => normalizeHomeUrl(config.value.defaultUrl))
  function setMode(val: 'headed' | 'headless') { config.value.mode = val; persist() }
  function setEngine(val: string) { config.value.engine = val; persist() }

  /* ── mux 帧入口（ChatInterface 按 sessionId 路由进对应桶） ── */
  function onFrame(convId: string, p: { tabId: string; data: string; mime: string; width: number; height: number }) {
    const s = bucket(convId)
    s.connected = true
    s.screenshotMime = p.mime || 'image/jpeg'
    s.screenshot = p.data || ''
    s.loading = false
    s.lastUsedAt = Date.now()
  }
  function onStatusFrame(convId: string, p: { connected: boolean; mode?: string; viewport?: string }) {
    const s = bucket(convId)
    s.connected = !!p.connected
    if (!p.connected) { s.screenshot = ''; s.pages = [] }
    if (p.viewport) s.viewport = p.viewport
    // 有头/无头同步（0905 十五批：含有头窗口被点 × 后端自动回无头的广播）
    if (p.mode === 'headed' || p.mode === 'headless') s.mode = p.mode
  }
  function onTabsFrame(convId: string, p: { tabs: BrowserPage[] }) {
    if (Array.isArray(p.tabs)) setPages(convId, p.tabs)
  }
  function onControlFrame(convId: string, p: { by: 'user' | 'ai' | '' }) {
    const s = bucket(convId)
    s.controlledBy = p.by || ''
    s.takeover = p.by === 'user'
    if (p.by === 'ai') s.aiLastActiveAt = Date.now()
  }
  function onScrollFrame(convId: string, p: { y: number; h: number; vh: number }) {
    bucket(convId).scroll = { y: p.y || 0, h: p.h || 0, vh: p.vh || 0 }
  }

  function setPages(convId: string, list: BrowserPage[]) {
    const s = bucket(convId)
    s.pages = list
    const active = list.find(p => p.active)
    if (!active) s.screenshot = ''
  }

  function resetConv(convId: string) {
    const viewport = bucket(convId).viewport
    convs[String(convId)] = newConvState(viewport)
  }

  /* ── 兼容垫片（0905 七批分桶后仍被 RightPanel/SettingsModal 引用的旧全局 API） ──
   *  RightPanel 的 mini 浏览器是 0905 分桶前的旧全局通道遗留：connected 恒 false
   *  让其"浏览器"选项不再出现（死代码休眠）；mode/engine/defaultUrl 转发 config。 */
  const connectedCompat = ref(false)
  const mode = computed({
    get: () => config.value.mode,
    set: (v: 'headed' | 'headless') => { config.value.mode = v; persist() },
  })
  const engine = computed({
    get: () => config.value.engine,
    set: (v: string) => { config.value.engine = v; persist() },
  })
  const defaultUrl = computed({
    get: () => config.value.defaultUrl,
    set: (v: string) => { config.value.defaultUrl = v; persist() },
  })

  /** 悬浮窗打开请求（0905 十一批）：ChatInterface 置 true，ViewChatDock watch（immediate）消费——
   *  替代 window 事件（事件在 dock 尚未挂载时派发会丢，造成"弹窗延迟"） */
  const dockOpenRequested = ref(false)

  return {
    config,
    settings,
    convs,
    bucket,
    dockOpenRequested,
    setViewportGlobal,
    persist,
    loadSettings,
    saveSettings,
    setDefaultUrl,
    homeUrl,
    setMode,
    setEngine,
    onFrame,
    onStatusFrame,
    onTabsFrame,
    onControlFrame,
    onScrollFrame,
    setPages,
    resetConv,
    // 兼容垫片
    connected: connectedCompat,
    mode,
    engine,
    defaultUrl,
    markUsed: () => {},
    setLoading: () => {},
    setStatus: () => {},
    reset: () => {},
  }
})
