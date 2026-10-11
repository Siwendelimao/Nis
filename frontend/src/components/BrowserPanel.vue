<script setup lang="ts">
/**
 * 内置浏览器视图（对话窗口固定 tab）——0905 七批按会话隔离版。
 *  - 每个对话窗口自己的后端实例（sessionId=会话 id）：画面/标签/登录态/接管互不串。
 *  - 始终 headless：CDP screencast 帧进本面板；打开即 start + watch（RPC 全带 sessionId）。
 *  - 设备视口下拉（auto=自适应面板无留白）；标签胶囊对齐 PreviewTabBar。
 *  - 人接管：点击/滚轮/拖拽/键盘（含中文 IME）/悬停指针形态 反传；接管开关控制。
 *  - 启动首页恒用设置默认页（defaultUrl），不再拿 lastUrl 当首页（0905 问题8）。
 */
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue'
import { useBrowserStore } from '@/stores/browser'
import { useChatStore } from '@/stores/chat'
import { t } from '@/utils/i18n'
import MiniSelect, { type MiniOption } from './blocks/MiniSelect.vue'

const props = defineProps<{ conversationId?: string }>()
const browserStore = useBrowserStore()
const chatStore = useChatStore()

const CONV = computed(() => String(props.conversationId || 'default'))
const S = computed(() => browserStore.bucket(CONV.value))
function rpc(method: string, payload: Record<string, any> = {}, timeoutMs = 30000) {
  return chatStore.bridgeRpc(method, { ...payload, sessionId: CONV.value }, timeoutMs)
}

const browserUrl = ref('')
const urlFocused = ref(false)
let tabsTimer: ReturnType<typeof setInterval> | null = null

const browserConnected = computed(() => S.value.connected)
const browserLoading = computed(() => S.value.loading)
const browserStatus = computed(() => S.value.status)
const screenshot = computed(() => S.value.screenshot)
const screenshotMime = computed(() => S.value.screenshotMime || 'image/jpeg')
const browserPages = computed(() => S.value.pages)
const controlledBy = computed(() => S.value.controlledBy)
const takeover = computed(() => S.value.takeover)
const aiBusy = computed(() => S.value.controlledBy === 'ai')

const VIEWPORT_META = [
  { value: 'auto', labelKey: 'browser.vpAuto', descKey: 'browser.vpAutoDesc' },
  { value: 'pc', labelKey: 'browser.vpPc', descKey: 'browser.vpPcDesc' },
  { value: 'iphone15', labelKey: 'browser.vpIphone15', descKey: 'browser.vpTouchDesc', size: '393 × 852' },
  { value: 'ipad', labelKey: 'browser.vpIpad', descKey: 'browser.vpTouchDesc', size: '820 × 1180' },
  { value: 'pixel7', labelKey: 'browser.vpPixel7', descKey: 'browser.vpTouchDesc', size: '412 × 915' },
]
const VIEWPORT_OPTIONS = computed<MiniOption[]>(() => VIEWPORT_META.map(m => ({
  value: m.value,
  label: t(m.labelKey),
  desc: m.size ? t(m.descKey, { size: m.size }) : t(m.descKey),
})))
const viewportModel = computed({
  get: () => S.value.viewport,
  set: (v: string) => { browserSetViewport(v) },
})

/** 地址栏显示当前激活页 URL（用户未聚焦时跟随同步） */
const displayUrl = computed(() => {
  if (urlFocused.value) return browserUrl.value
  return (S.value.pages.find(p => p.active)?.url) || browserUrl.value || ''
})

function markUsed() { S.value.lastUsedAt = Date.now() }

/** ★1011j：首页落地体检 —— 设了默认首页，但打开后激活页仍是空白（about:blank / 没标签）
 *  ⇒ 首页没加载成功（地址不可达、超时，或地址写错）。以前这条失败被后端 catch 静默吞掉，
 *  表现就是实测的"设置里填了首页，进浏览器还是 about:blank"——看着像设置没生效。
 *  把证据摆到状态行上（带完整地址），用户一眼分清是网络问题还是地址问题。 */
function checkHomeLanded() {
  const home = browserStore.homeUrl
  if (!home || home === 'about:blank') return
  const list = browserPages.value || []
  const active = list.find(x => x.active)
  const blank = !list.length || !active || !active.url || active.url === 'about:blank'
  if (blank) S.value.status = t('browser.homeUnreachable', { url: home })
}

async function refreshTabs() {
  try {
    const v = await rpc('browser.tabs')
    if (v?.tabs) { browserStore.setPages(CONV.value, v.tabs); const a = (v.tabs as any[]).find(x => x.active); if (a?.url && /^https?:/i.test(a.url)) S.value.lastUrl = a.url }
    // 有头/无头图标 2s 自愈（0905 十五批：兜住点 × 自动回无头的事件丢失）
    if (v?.mode === 'headed' || v?.mode === 'headless') S.value.mode = v.mode
  } catch { /* ignore */ }
}

async function browserStart() {
  markUsed()
  // 已连接（临时切走再回来）：先跟后端核实实例是否还在（切走期间可能被 idle 关掉）
  if (browserConnected.value) {
    const st = await rpc('browser.status').catch(() => null)
    if (st?.connected) {
      S.value.status = ''
      if (st.mode === 'headed' || st.mode === 'headless') S.value.mode = st.mode
      const w = await rpc('browser.watch', {}).catch(() => null)
      if (w && typeof w.controlledBy === 'string') { S.value.controlledBy = w.controlledBy; S.value.takeover = w.controlledBy === 'user' }
      await refreshTabs()
      checkHomeLanded()          // ★1011j：已连接也要体检（切走再回来时可能正停在空白页上）
      return
    }
    browserStore.resetConv(CONV.value) // 实例已被回收，走下面的冷启动
  }
  S.value.loading = true; S.value.status = t('browser.starting')
  try {
    // 首页恒用设置默认页（0905 问题8：不再拿 lastUrl 当首页）
    /* ★0930：启动给 90s 大超时——冷启动要恢复多标签（每页 goto 最多 15s），30s 默认超时会把
       "慢启动"误判成失败（AI 工具没超时所以照常能用=用户看到的"按钮不行 AI 行"）。 */
    await rpc('browser.start', { mode: 'headless', home: browserStore.homeUrl || '' }, 90000)
    const w = await rpc('browser.watch', {})
    const stw = await rpc('browser.status', {}).catch(() => null)
    if (stw?.mode === 'headed' || stw?.mode === 'headless') S.value.mode = stw.mode
    if (w && typeof w.controlledBy === 'string') { S.value.controlledBy = w.controlledBy; S.value.takeover = w.controlledBy === 'user' }
    await browserSetViewport(S.value.viewport || 'auto')
    await refreshTabs()
    checkHomeLanded()          // ★1011j：首页没落地就说清楚（别让用户以为是"设置没生效"）
    S.value.connected = true
    S.value.loading = false   // 兜底清进度条（帧流若晚到也不再卡"正在打开"）
  } catch (e: any) {
    S.value.status = `${t('browser.launchFailed')}: ${String(e?.message || e)}`; S.value.loading = false
  }
}

async function browserNavigate() {
  const url = browserUrl.value.trim() || (displayUrl.value || '').trim()
  if (!url) return
  markUsed(); S.value.loading = true; S.value.status = t('browser.opening', { url })
  try { await rpc('browser.navigate', { url }); await refreshTabs() } catch (e: any) { S.value.status = `${t('browser.openFailed')}: ${String(e?.message || e)}` }
}

async function browserGoBack() { markUsed(); S.value.loading = true; await rpc('browser.goBack').catch(() => {}); await refreshTabs() }
async function browserGoForward() { markUsed(); S.value.loading = true; await rpc('browser.goForward').catch(() => {}); await refreshTabs() }
async function browserRefresh() { markUsed(); S.value.loading = true; await rpc('browser.refresh').catch(() => {}); await refreshTabs() }
async function browserStop() { markUsed(); await rpc('browser.stop').catch(() => {}); S.value.loading = false }

async function browserNewTab() { markUsed(); const url = browserUrl.value.trim(); browserUrl.value = ''; await rpc('browser.newTab', url ? { url } : {}).catch(() => {}); await refreshTabs() }
async function browserCloseTab(tabId: string) { markUsed(); const v = await rpc('browser.closeTab', { tabId }).catch(() => null); if (v?.tabs) browserStore.setPages(CONV.value, v.tabs) }
async function browserSwitchTab(tabId: string) { markUsed(); await rpc('browser.switchTab', { tabId }).catch(() => {}); await refreshTabs() }
async function browserSetViewport(key: string) {
  markUsed(); S.value.viewport = key; browserStore.setViewportGlobal(key)
  // auto=视口跟随面板实际尺寸（消灭两侧留白）；其余预设按表值
  const payload = key === 'auto'
    ? { viewport: key, custom: { width: frameWrapRef.value?.clientWidth || 1280, height: frameWrapRef.value?.clientHeight || 800 } }
    : { viewport: key }
  await rpc('browser.setViewport', payload).catch(() => {})
}

/* ── 0905 T4：人接管开关（关=只看不反传；开=点击/滚轮/拖拽/键盘反传；AI 操作期间锁定） ── */
async function toggleTakeover() {
  if (aiBusy.value) return
  markUsed()
  const next = !S.value.takeover
  S.value.controlledBy = next ? 'user' : ''; S.value.takeover = next   // 乐观置位
  if (next) nextTick(() => hiddenInputRef.value?.focus())
  const v = await rpc('browser.takeover', { on: next }).catch(() => null)
  if (v && typeof v.controlledBy === 'string') { S.value.controlledBy = v.controlledBy; S.value.takeover = v.controlledBy === 'user' }
}

/* ── 0905 十一批：有头/无头切换（人工过验证通道）——切换=重启实例+恢复标签页，
    有头时弹出真实 Chrome 窗口，人工完成验证/拖拽后切回无头，AI 继续。
    状态存桶（browser/status 帧同步，含有头窗口被点 × 后端自动回无头的广播）。 ── */
const browserMode = computed({
  get: () => S.value.mode || 'headless',
  set: (v: 'headed' | 'headless') => { S.value.mode = v },
})
async function toggleMode() {
  markUsed()
  const target = browserMode.value === 'headless' ? 'headed' : 'headless'
  S.value.loading = true; S.value.status = target === 'headed' ? t('browser.launchingHeaded') : t('browser.switchingHeadless')
  try {
    await rpc('browser.setMode', { mode: target })
    browserMode.value = target
    browserStore.setMode(target)
    await refreshTabs()
    S.value.loading = false; S.value.status = ''
  } catch (e: any) {
    S.value.loading = false; S.value.status = `${t('browser.switchFailed')}: ${String(e?.message || e)}`
  }
}

/* ── 人接管交互层：坐标换算 + 串行队列 + 拖拽手势 + 键盘（IME 友好） + 悬停指针 ── */
const frameRef = ref<HTMLImageElement | null>(null)
function toViewport(e: MouseEvent | WheelEvent): { x: number; y: number } | null {
  const img = frameRef.value; if (!img) return null
  const natW = img.naturalWidth || 1280, natH = img.naturalHeight || 800
  const r = img.getBoundingClientRect()
  const scale = Math.min(r.width / natW, r.height / natH)   // object-contain 实际缩放
  if (!scale) return null
  const dispW = natW * scale, dispH = natH * scale
  const offX = r.left + (r.width - dispW) / 2, offY = r.top + (r.height - dispH) / 2
  const x = (e.clientX - offX) / scale, y = (e.clientY - offY) / scale
  if (x < 0 || y < 0 || x > natW || y > natH) return null
  return { x: Math.round(x), y: Math.round(y) }
}

let inputChain: Promise<void> = Promise.resolve()
function enqueueInput(payload: Record<string, any>) {
  inputChain = inputChain.then(() => rpc('browser.input', payload)).then((v: any) => {
    if (v && typeof v.cursor === 'string') frameCursor.value = v.cursor
  }).catch(() => {})
}

function canInteract() { return S.value.takeover && S.value.controlledBy !== 'ai' }

async function interact(payload: Record<string, any>) {
  if (!canInteract()) return
  markUsed()
  enqueueInput(payload)
  await refreshTabs()
}

/* 拖拽手势（0905：滑块/拖拽验证）：按下→移动→抬起 完整反传 */
const dragging = ref(false)
function onFrameMouseDown(e: MouseEvent) {
  if (!canInteract()) return
  const p = toViewport(e); if (!p) return
  // 0905 十五批：阻止浏览器默认的焦点转移（否则键盘捕获框刚聚焦就被抢走，打字全丢）
  e.preventDefault()
  dragging.value = true
  focusCapture()
  enqueueInput({ action: 'down', args: p })
}
function onWindowMouseUp() {
  if (!dragging.value) return
  dragging.value = false
  enqueueInput({ action: 'up', args: {} })
  focusCapture()   // 抬起后确保键盘捕获框仍持焦点
  refreshTabs()
}
function onFrameDragMove(e: MouseEvent) {
  if (!dragging.value) { onFrameMouseMove(e); return }
  const p = toViewport(e); if (!p) return
  markUsed()
  enqueueInput({ action: 'move', args: p })
}

/* 键盘捕获：控制键/组合键逐键反传；普通字符与中文 IME 走 insertText（composition 守卫防重复） */
const PRESSED_KEYS = new Set(['Enter', 'Backspace', 'Delete', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Insert'])
const hiddenInputRef = ref<HTMLTextAreaElement | null>(null)
let composing = false   // IME 组合期间不发送不清空（0905 问题3：输一遍进多遍的根因）
function onCompositionStart() { composing = true }
function onCompositionEnd() {
  composing = false
  flushHiddenValue()
}
function flushHiddenValue() {
  const el = hiddenInputRef.value
  if (!el || !el.value || composing) return
  const text = el.value
  el.value = ''
  enqueueInput({ action: 'insertText', args: { text } })
}
function onCaptureKeydown(e: KeyboardEvent) {
  if (!canInteract()) return
  const k = e.key
  if (k === 'Process' || e.isComposing || composing) return   // IME 中间态放行
  const mods: string[] = []
  if (e.ctrlKey) mods.push('Control')
  if (e.metaKey) mods.push('Meta')
  if (e.altKey) mods.push('Alt')
  const hasMod = mods.length > 0
  const isControlKey = PRESSED_KEYS.has(k) || k === ' '
  if (!isControlKey && !hasMod) return   // 普通字符交给 @input 走 insertText
  e.preventDefault()
  enqueueInput({ action: 'key', args: { key: [...mods, k === ' ' ? 'Space' : k].join('+') } })
}
function onCaptureInput() { flushHiddenValue() }
function focusCapture() { if (S.value.takeover) hiddenInputRef.value?.focus() }

/* 悬停指针形态（真实浏览器手感）：mousemove 100ms 节流探测该点 cursor 语义 */
const frameCursor = ref<'default' | 'pointer' | 'text'>('default')
let lastProbeAt = 0
function onFrameMouseMove(e: MouseEvent) {
  if (!canInteract()) return
  const now = Date.now()
  if (now - lastProbeAt < 100) return
  lastProbeAt = now
  const p = toViewport(e)
  if (!p) return
  markUsed()
  rpc('browser.input', { action: 'hover', args: p }).then((v: any) => {
    if (v && typeof v.cursor === 'string') frameCursor.value = v.cursor
  }).catch(() => {})
}
function onFrameMouseLeave() { frameCursor.value = 'default' }

function onFrameCtx(e: MouseEvent) { e.preventDefault(); const p = toViewport(e); if (p) interact({ action: 'rightclick', args: p }) }
function onFrameWheel(e: WheelEvent) { e.preventDefault(); interact({ action: 'wheel', args: { dx: Math.round(e.deltaX), dy: Math.round(e.deltaY) } }) }
// 注：左键点击=mousedown(down)+mouseup(up) 完整语义，不另发 click（避免页面收到双击）

/* ── T3：视口自适应面板（auto 预设）——面板尺寸变化后 debounce 同步引擎视口 ── */
const frameWrapRef = ref<HTMLElement | null>(null)
let resizeTimer: ReturnType<typeof setTimeout> | null = null
let resizeObserver: ResizeObserver | null = null
function syncAutoViewport() {
  const el = frameWrapRef.value
  if (!el || !browserConnected.value || S.value.viewport !== 'auto') return
  const w = el.clientWidth, h = el.clientHeight
  if (w < 200 || h < 200) return
  rpc('browser.setViewport', { viewport: 'auto', custom: { width: Math.round(w), height: Math.round(h) } }).catch(() => {})
}

/* ── T3：悬浮滚动进度条（滚动时/悬停右侧出现，2.5s 无事件淡出） ── */
const scrollHover = ref(false)
const scrollFlash = ref(false)
let scrollFlashTimer: ReturnType<typeof setTimeout> | null = null
const scrollInfo = computed(() => S.value.scroll)
const scrollable = computed(() => scrollInfo.value.h > scrollInfo.value.vh + 4)
const showScrollbar = computed(() => scrollable.value && (scrollHover.value || scrollFlash.value))
watch(scrollInfo, () => {
  if (!scrollable.value) return
  scrollFlash.value = true
  if (scrollFlashTimer) clearTimeout(scrollFlashTimer)
  scrollFlashTimer = setTimeout(() => { scrollFlash.value = false }, 2500)
})

onMounted(async () => {
  markUsed()
  await browserStart()
  // 旧默认 pc(1280×800) 一次性升级为自适应视口（消灭两侧留白；下拉里仍可选手动尺寸）
  if (S.value.viewport === 'pc') await browserSetViewport('auto')
  if (frameWrapRef.value && typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(() => {
      if (resizeTimer) clearTimeout(resizeTimer)
      resizeTimer = setTimeout(syncAutoViewport, 400)
    })
    resizeObserver.observe(frameWrapRef.value)
  }
  window.addEventListener('mouseup', onWindowMouseUp)
  tabsTimer = setInterval(() => { if (browserConnected.value) refreshTabs() }, 2000)
})
onUnmounted(() => {
  if (tabsTimer) { clearInterval(tabsTimer); tabsTimer = null }
  if (resizeTimer) { clearTimeout(resizeTimer); resizeTimer = null }
  if (scrollFlashTimer) { clearTimeout(scrollFlashTimer); scrollFlashTimer = null }
  resizeObserver?.disconnect(); resizeObserver = null
  window.removeEventListener('mouseup', onWindowMouseUp)
  rpc('browser.unwatch').catch(() => {})
})
</script>

<template>
  <div class="flex-1 flex flex-col overflow-hidden bg-white">
    <!-- 标签页行（胶囊风格，对齐 PreviewTabBar） -->
    <div v-if="browserConnected && browserPages.length" class="flex items-center gap-1.5 px-3 py-1.5 bg-gray-50 border-b border-gray-200 shrink-0">
      <div
        v-for="page in browserPages"
        :key="page.id"
        :class="[
          'group flex items-center gap-1.5 text-[12px] px-3 py-1 rounded-full cursor-pointer max-w-[180px] shrink-0 transition-colors',
          page.active ? 'bg-gray-900 text-white browser-tab-active' : 'text-gray-500 hover:bg-gray-200 hover:text-gray-800',
        ]"
        @click="browserSwitchTab(page.id)"
      >
        <i v-if="page.active && browserLoading" class="fas fa-circle-notch fa-spin text-[9px] shrink-0" :class="page.active ? 'text-white/80' : 'text-gray-400'"></i>
        <i v-else class="fas fa-globe text-[9px] shrink-0" :class="page.active ? 'text-white/70' : 'text-gray-400'"></i>
        <span class="truncate">{{ page.title || page.url || t('panel.newTab') }}</span>
        <i class="fas fa-times text-[9px] shrink-0" :class="page.active ? 'text-white/60 hover:text-white' : 'text-gray-400 hover:text-red-500'" @click.stop="browserCloseTab(page.id)"></i>
      </div>
      <button @click="browserNewTab" class="w-6 h-6 flex items-center justify-center rounded-full text-gray-500 hover:bg-gray-200 shrink-0 transition-colors" :title="t('panel.newTabBtn')">
        <i class="fas fa-plus text-[10px]"></i>
      </button>
    </div>

    <!-- 工具栏：设备视口 + 后退/前进 + (刷新⇄停止) + 地址栏 + 前往 + 接管 -->
    <div class="relative z-20 flex items-center gap-1.5 px-2 py-1.5 border-b border-gray-100 shrink-0">
      <div class="w-[128px] shrink-0">
        <MiniSelect v-model="viewportModel" :options="VIEWPORT_OPTIONS" width="w-[128px]" />
      </div>
      <button @click.stop="browserGoBack" class="w-7 h-7 flex items-center justify-center rounded-md text-gray-500 hover:bg-gray-200 hover:text-gray-700 transition-colors cursor-pointer" :title="t('panel.back')"><i class="fas fa-arrow-left text-xs"></i></button>
      <button @click.stop="browserGoForward" class="w-7 h-7 flex items-center justify-center rounded-md text-gray-500 hover:bg-gray-200 hover:text-gray-700 transition-colors cursor-pointer" :title="t('panel.forward')"><i class="fas fa-arrow-right text-xs"></i></button>
      <!-- 加载中转「停止」，空闲转「刷新」（与真实浏览器一致） -->
      <button v-if="browserLoading" @click.stop="browserStop" class="w-7 h-7 flex items-center justify-center rounded-md text-gray-600 hover:bg-gray-200 transition-colors cursor-pointer" :title="t('panel.stop')"><i class="fas fa-xmark text-xs"></i></button>
      <button v-else @click.stop="browserRefresh" class="w-7 h-7 flex items-center justify-center rounded-md text-gray-500 hover:bg-gray-200 hover:text-gray-700 transition-colors cursor-pointer" :title="t('panel.refresh')"><i class="fas fa-rotate-right text-xs"></i></button>
      <div class="flex-1 min-w-0 flex items-center bg-gray-100 rounded-lg px-2.5 py-1.5 border border-transparent focus-within:border-gray-400 focus-within:bg-white transition-colors">
        <i class="fas fa-lock text-[9px] text-gray-400 mr-1.5 shrink-0"></i>
        <input
          v-model="browserUrl"
          @focus="urlFocused = true"
          @blur="urlFocused = false"
          @keydown.enter="browserNavigate"
          class="flex-1 min-w-0 bg-transparent outline-none text-xs text-gray-700 placeholder-gray-400 cursor-text"
          :placeholder="t('panel.urlPlaceholder')"
          :value="displayUrl"
        />
      </div>
      <button @click.stop="browserNavigate" class="shrink-0 btn btn-primary btn-xs" :title="t('browser.go')">{{ t('browser.go') }}</button>
      <!-- 接管开关（0905 T4）：关=只看不发点击；开=点击/滚轮/拖拽/键盘反传；AI 操作中锁定 -->
      <button
        @click.stop="toggleTakeover"
        :disabled="aiBusy"
        :class="[
          'shrink-0 btn btn-xs transition-colors',
          aiBusy ? 'bg-gray-100 text-gray-300 cursor-not-allowed' : takeover ? 'bg-gray-900 text-white hover:bg-black' : 'bg-gray-100 text-gray-500 hover:bg-gray-200 hover:text-gray-700',
        ]"
        :title="aiBusy ? t('browser.aiBusyTip') : takeover ? t('browser.takeoverTip') : t('browser.takeoverOffTip')"
      >{{ aiBusy ? t('browser.aiBusyShort') : takeover ? t('browser.takeoverOn') : t('browser.takeover') }}</button>
      <!-- 有头/无头切换（0905 十一批）：人工过验证通道；切换=重启+恢复标签 -->
      <button
        @click.stop="toggleMode"
        :class="[
          'shrink-0 w-7 h-7 flex items-center justify-center rounded-md transition-colors cursor-pointer',
          browserMode === 'headed' ? 'bg-amber-100 text-amber-600 hover:bg-amber-200' : 'text-gray-500 hover:bg-gray-200 hover:text-gray-700',
        ]"
        :title="browserMode === 'headed' ? t('browser.headedTip') : t('browser.headlessTip')"
      ><i :class="browserMode === 'headed' ? 'fas fa-desktop text-xs' : 'fas fa-window-restore text-xs'"></i></button>
    </div>

    <!-- 画面区（直播帧 + 人接管交互层 + 悬浮滚动条） -->
    <div
      ref="frameWrapRef"
      class="flex-1 relative bg-gray-50 overflow-hidden flex items-center justify-center"
      @mouseenter="scrollHover = true"
      @mouseleave="scrollHover = false"
    >
      <!-- 顶部细进度条（加载态） -->
      <div v-if="browserLoading" class="absolute top-0 left-0 right-0 h-0.5 bg-gray-200 overflow-hidden z-20"><div class="h-full w-1/3 bg-gray-900 animate-[browserBar_1.1s_ease-in-out_infinite]"></div></div>
      <div v-if="controlledBy === 'ai'" class="absolute top-2 left-1/2 -translate-x-1/2 z-10 px-2.5 py-1 rounded-full bg-gray-900/80 text-white text-[10px] font-[530]">{{ t('browser.aiOperating') }}</div>
      <img
        ref="frameRef"
        v-if="browserConnected && screenshot"
        :src="'data:' + screenshotMime + ';base64,' + screenshot"
        class="max-w-full max-h-full object-contain select-none"
        :class="takeover && controlledBy !== 'ai' ? (frameCursor === 'pointer' ? 'cursor-pointer' : frameCursor === 'text' ? 'cursor-text' : dragging ? 'cursor-grabbing' : 'cursor-default') : 'cursor-default'"
        draggable="false"
        @mousedown="onFrameMouseDown"
        @mousemove="onFrameDragMove"
        @mouseleave="onFrameMouseLeave"
        @contextmenu="onFrameCtx"
        @wheel="onFrameWheel"
      />
      <!-- 键盘捕获（不可见）：点击画面后聚焦，keydown/IME 输入经 browser.input 反传给页面 -->
      <textarea
        ref="hiddenInputRef"
        class="absolute w-px h-px opacity-0 left-0 bottom-0 resize-none outline-none border-0 p-0"
        :tabindex="-1"
        aria-hidden="true"
        @keydown="onCaptureKeydown"
        @input="onCaptureInput"
        @compositionstart="onCompositionStart"
        @compositionend="onCompositionEnd"
      ></textarea>
      <!-- 悬浮滚动进度条：滚动时或悬停右侧出现，2.5s 后淡出 -->
      <div v-if="showScrollbar" class="absolute right-1 top-2 bottom-2 w-1.5 z-10 pointer-events-none flex items-start">
        <div
          class="w-full rounded-full transition-opacity duration-300"
          :style="{
            height: Math.max(12, (scrollInfo.vh / scrollInfo.h) * 100) + '%',
            marginTop: (scrollInfo.y / scrollInfo.h) * 100 + '%',
            background: 'rgba(23,23,28,0.28)',
          }"
        ></div>
      </div>
      <div v-if="!(browserConnected && screenshot)" class="flex flex-col items-center justify-center text-gray-400 px-6">
        <i class="fas fa-globe text-4xl mb-3 text-gray-300"></i>
        <p class="text-sm">{{ browserConnected ? browserStatus || t('panel.browserWaiting') : (browserStatus ? t('browser.launchFailed') : t('panel.builtinBrowser')) }}</p>
        <p v-if="!browserConnected" class="text-xs mt-1 text-gray-400">{{ t('panel.browserHint') }}</p>
        <p v-if="browserStatus" class="text-xs mt-1" :class="browserConnected ? 'text-blue-500' : 'text-red-500'">{{ browserStatus }}</p>
        <button v-if="!browserConnected" class="mt-4 px-4 py-1.5 rounded-lg bg-gray-900 text-white text-xs font-[530] hover:bg-gray-700 transition-colors" @click="browserStart">{{ t('panel.startBrowser') }}</button>
      </div>
      <div v-if="browserLoading && !screenshot" class="absolute inset-0 flex items-center justify-center bg-white/60">
        <i class="fas fa-spinner fa-spin text-xl text-gray-400"></i>
      </div>
    </div>
  </div>
</template>

<style scoped>
@keyframes browserBar {
  0% { transform: translateX(-100%); }
  100% { transform: translateX(300%); }
}
</style>
