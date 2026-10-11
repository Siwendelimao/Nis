<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, defineAsyncComponent } from 'vue'
import Sidebar from './components/Sidebar.vue'
import ChatInterface from './components/ChatInterface.vue'
import ToastStack from './components/blocks/ToastStack.vue'
import WinResizeZones from './components/WinResizeZones.vue'
import { useConversationsStore } from './stores/conversations'
import { useChatStore } from './stores/chat'
import { useUiStore } from './stores/ui'
import { useSettingsStore } from './stores/settings'
import { usePreviewTabsStore } from './stores/previewTabs'
import { useProjectsStore } from './stores/projects'
import { useProcsStore } from './stores/procs'
import { useAgentPresetsStore, presetDisplayName } from './stores/agentPresets'
import { useTeamsStore } from './stores/teams'
import { setupAutoMemory } from './utils/autoMemory'
import { t, reloadLang } from './utils/i18n'
import { useGlobalContextMenu } from './composables/useGlobalContextMenu'
import { installGlobalTooltip } from './utils/globalTooltip'
/* ★1012 修正：SplashScreen **必须静态引入** —— 它一懒加载，开屏层要等 chunk 才渲染，
   那 1 秒多的空窗期里主界面（含空态）已经可见 ⇒ 视觉上"闪一下空态再读条"。
   （实测：懒加载时主界面 +972ms 可见、开屏层 +2232ms 才渲染。） */
import SplashScreen from './components/SplashScreen.vue'
/* ★1012 手机端瘦身：只在 v-if 成立时才渲染的组件 ⇒ 改成用到才下载（不成立就不下载它的 chunk） */
const OnboardingWizard = defineAsyncComponent(() => import('./components/OnboardingWizard.vue'))
import CloseConfirmDialog from './components/CloseConfirmDialog.vue'
import SystemNotificationCenter from './components/SystemNotificationCenter.vue'
/* ★1012 手机端瘦身：只在 v-if 成立时才渲染的组件 ⇒ 改成用到才下载（不成立就不下载它的 chunk） */
const ProcMonitorModal = defineAsyncComponent(() => import('./components/blocks/ProcMonitorModal.vue'))
import { Cpu } from 'lucide-vue-next'
import { splash, shouldPlaySplash, splashBegin, splashSetProgress, splashReady, splashClearBootBg } from './utils/splash'
import { onboarding, isOnboarded, openOnboarding } from './utils/onboarding'
import { hydrate, isHydrated, onHydrated } from './utils/localStore'

const conversationsStore = useConversationsStore()
const chatStore = useChatStore()
const uiStore = useUiStore()
const settingsStore = useSettingsStore()
const previewTabsStore = usePreviewTabsStore()
const projectsStore = useProjectsStore()
const procsStore = useProcsStore()
const agentPresetsStore = useAgentPresetsStore()
const teamsStore = useTeamsStore()
const mobileProcsOpen = ref(false)

// 0906 背景图（设置→外观）：computed 读 store（语言/主题/图片变化即时重渲染）
const bgImage = computed(() => settingsStore.appearance?.bgImage || '')
const bgOpacity = computed(() => {
  const v = settingsStore.appearance?.bgOpacity
  return typeof v === 'number' && isFinite(v) ? Math.min(1, Math.max(0.05, v)) : 0.5
})

const sidebarWidth = ref(225)

/* ── 0906 手机端适配（≤767px 单栏化，重做第一批）：
 * 侧栏变抽屉（遮罩+滑入，选完会话自动收起）；底部导航四键（对话/浏览器/菜单/设置）
 * 与桌面 fixedView 共用同一状态；main 全幅并避让底部导航；弹窗全屏化在 style.css。 */
const mqMobile = window.matchMedia('(max-width: 767px)')
const mqCoarse = window.matchMedia('(pointer: coarse)')
/* ★1011 手机端极简版：先定义"谁是手机"。
   原来只看宽度（≤767px）—— 一台电脑把窗口拖窄，整个界面就变手机版（反过来宽屏平板被当桌面）。
   现在要求「窄 **且** 触屏/移动端 UA」：真手机进极简版，电脑窄窗口仍是桌面版。
   调试可强制覆盖：地址后加 `?mobile=1` / `?mobile=0`。 */
function forceMobileFromUrl(): boolean | null {
  try {
    const v = new URLSearchParams(window.location.search).get('mobile')
    if (v === '1' || v === 'true') return true
    if (v === '0' || v === 'false') return false
  } catch { /* 非浏览器环境 */ }
  return null
}
const FORCE_MOBILE = forceMobileFromUrl()
function detectMobile(): boolean {
  if (FORCE_MOBILE !== null) return FORCE_MOBILE
  const touch = mqCoarse.matches || /Android|iPhone|iPod|iPad|Windows Phone|Mobile/i.test(navigator.userAgent || '')
  return mqMobile.matches && touch
}
const isMobile = ref(detectMobile())
const mobileDrawer = ref(false)
function onMqChange() {
  isMobile.value = detectMobile()
  if (!isMobile.value) mobileDrawer.value = false
}

/** 0914c：首次启动引导——splash 结束（或跳过开屏）后、尚未引导过时弹出。
 *  0917c 修（用户实报「重启后端后网页版又进引导页」）：
 *    持久化状态（localStore → 后端 data/ui-state.json）是异步水合的，后端重启期间
 *    `uiState.load` 会超时 → 内存镜像是空的 → 「引导已完成」被误读成「没引导过」。
 *    所以判定前必须先确认水合成功（isHydrated），没就绪就先不下结论、等重试。 */
let splashDone = false
function maybeOpenOnboarding() {
  if (!splashDone) return
  if (!isHydrated()) return
  if (!isOnboarded() && !onboarding.visible) openOnboarding()
}
// splash 收尾（active true→false）触发；跳过开屏场景在 onMounted 里定时兜底
watch(() => splash.active, (v) => { if (!v) { splashDone = true; maybeOpenOnboarding() } })

onMounted(async () => {
  setupAutoMemory()
  // 0917b：SSE 断线重连后向服务端补账（防"卡在回复中、刷新才恢复"，见 conversations.resyncAfterReconnect）
  chatStore.onResync(() => { void conversationsStore.resyncAfterReconnect() })
  // 0914：全局右键拦截（屏蔽原生菜单；输入框/选中文本/各面板 data-ctx 走自定义菜单）
  useGlobalContextMenu().install()
  // 0918：全局 tooltip 接管 —— 把全站 189 处原生 title 换回我们自己的深色气泡
  installGlobalTooltip()
  mqMobile.addEventListener('change', onMqChange)
  // 0914 开屏动画：仅冷启动播放（HMR / 30s 内重复挂载跳过，见 utils/splash.ts）
  // 0915 用户口径修正：**首启也播开屏**（只要去掉「logo 飞向左上角」那段，见 SplashScreen.runOutro），
  // 播完渐隐 → 引导页自己渐显（watcher 在 splash.active 变 false 时触发）。
  if (shouldPlaySplash()) splashBegin()
  else {
    splashClearBootBg()
    // 0914c：跳过开屏场景（HMR/30s 内重复挂载）——稍等界面稳定后同样走首次引导检查
    window.setTimeout(() => { splashDone = true; maybeOpenOnboarding() }, 900)
  }
  /* 0917c：水合就绪后再判定一次引导页；若启动时没水合成功（后端还在重启），
     按 1.2s 间隔重试（最多 ~24s）——避免"后端没起来 → 状态为空 → 引导页误弹"。 */
  onHydrated(() => { reloadLang(); maybeOpenOnboarding() })
  let hydrateRetries = 0
  const hydrateTimer = window.setInterval(() => {
    if (isHydrated()) { window.clearInterval(hydrateTimer); return }
    void hydrate().then((ok) => {
      if (ok) { window.clearInterval(hydrateTimer); maybeOpenOnboarding() }
      else if (++hydrateRetries > 20) window.clearInterval(hydrateTimer)
    })
  }, 1200)
  // Connect to bridge service and load conversations
  chatStore.connect()
  splashSetProgress(30)
  // 开屏进度：连接建立节点（全局 SSE 连上后端时触发 nis-ws-connected）
  const bootConnected = new Promise<void>((resolve) => {
    if (chatStore.wsConnected) return resolve()
    const h = () => { window.removeEventListener('nis-ws-connected', h); resolve() }
    window.addEventListener('nis-ws-connected', h)
  })
  void bootConnected.then(() => splashSetProgress(Math.max(splash.progress, 58)))
  // 从后端拉取设置（AI 改名工具/其他端修改后同步；后端权威），先于会话创建保证 system prompt 用最新值
  const bootSettings = settingsStore.syncFromBackend()
  /* ★1012y：**settings 的跨端同步**（实测：PC 没开「回复完成折叠过程态」，手机刷新后自己开了）。
     根因与 providers 完全同类 —— settings **只在启动时** syncFromBackend 一次（就是上面这行），
     另一台设备的变更它收不到，于是本地按默认值渲染，看着像"自己开了"。
     处置：**定期 + 回前台**采纳后端权威值（间隔取 60s，比 providers 的 20s 保守，
     避免打扰正在本机编辑设置的用户）；window focus / visibilitychange 时立即同步。 */
  let settingsSyncTimer: ReturnType<typeof setInterval> | undefined
  const syncSettingsFromBackend = () => {
    /* ★1012ae 守卫②：**设置面板打开时不同步** —— 用户正在编辑（含「通用」页那些需点保存的字段），
       这时拿后端值覆盖本地＝把人家刚改的改回去（实测的现象）。关掉面板后自然恢复同步。 */
    if (document.querySelector('.settings-dock')) return
    void settingsStore.syncFromBackend()
  }
  const onSettingsVisible = () => {
    if (document.visibilityState === 'visible') syncSettingsFromBackend()
  }
  settingsSyncTimer = setInterval(syncSettingsFromBackend, 60000)
  try {
    window.addEventListener('focus', syncSettingsFromBackend)
    document.addEventListener('visibilitychange', onSettingsVisible)
  } catch { /* 非浏览器环境 */ }
  /* 不注册 onUnmounted：这段在启动流程内部（非 setup 顶层），生命周期钩子在函数里注册是无效的；
     定时器会随页面卸载自动销毁，无需显式清理。 */
  // 0914c：会话列表与设置 **并行** 拉取（原先串在设置同步之后 → 快速刷新（跳过开屏）时"界面已出、列表迟到"）。
  // 列表加载只读后端 session.list，不依赖设置结果；并行后两路各耗各的时间。
  const bootConversations = conversationsStore.loadConversations()
  // 开屏收尾信号：「连接 + 设置 + 会话」全部就绪 → 触发收尾序列（时长固定，与加载耗时无关）
  void (async () => {
    try { await bootConnected } catch { /* SSE 自动重连兜底 */ }
    try { await bootSettings } catch { /* 设置拉取失败不拦收尾 */ }
    try { await bootConversations } catch { /* 数据拉取失败不拦收尾（主链错误照常上抛） */ }
    splashSetProgress(97)
    if (splash.active) {
      await new Promise((r) => setTimeout(r, 140))
      splashReady()
    }
  })()
  /* ★1012ak：**不再用设置拉取阻塞开屏** —— 反馈"每次打开都要在开屏动画加载条等好久"。
     实测 `settings.get` 要 4.7~6.4s（返回体里还裹着 base64 头像等大字段），而开屏进度恰好卡在
     58%→74% 这一段（`await bootSettings`）。设置晚到不影响开屏可用性：真正用到它（组 system prompt）
     是在用户发第一条消息时，那时早已回来。故改为**后台等待**，进度直接往下走。 */
  void bootSettings.catch(() => { /* 设置拉取失败不拦开屏 */ })
  splashSetProgress(74)
  await bootConversations
  splashSetProgress(88)
  // 0911 反馈：项目列表从后端同步（PROJECT_CREATE 后端落地后，项目不再只存 localStorage；
  // 本地独有条目反向补推，旧数据首迁移零丢失）
  void projectsStore.pullProjectsFromBackend()
  // 进入对话界面（0911 反馈12）：刷新 / 重新打开软件，默认都落到「新建对话」界面（草稿态——
  // 不建会话/工作区，发消息才落地）；历史会话从左侧列表点开。
  // （上一轮「记住上次打开的窗口」方案按用户拍板撤掉。）
  conversationsStore.startDraft(null)
})
onUnmounted(() => { mqMobile.removeEventListener('change', onMqChange) })

const currentConversation = computed(() => conversationsStore.getActive())

// 手机端：抽屉里选中会话/新建 后自动收起（Sidebar 内部直连 store，这里 watch 活跃会话变化兜底）
// 0911 帧按会话订阅：活跃会话变化时重订「会话级」SSE 流（全局流保持不动）
watch(() => currentConversation.value?.id, (id) => {
  mobileDrawer.value = false
  chatStore.subscribeSession(String(id || ''))
}, { immediate: true })
/** ★1011 手机端「新对话」：原来只能靠侧栏行内 hover 出来的 + 按钮（手机上没有 hover，点不到），
 *  现在顶栏常驻一颗。走草稿态（不建会话/工作区，发消息才落地），与桌面「新建对话」一致。 */
function mobileNewChat() {
  if (uiStore.settingsOpen) uiStore.closeSettings()
  mobileDrawer.value = false
  conversationsStore.startDraft(null)
}
/** ★1012 手机端顶栏的「模式名」：会话头整行在手机端已隐藏，模式名跟着标题挪到顶栏。
 *  口径照 ChatInterface.currentPresetName：团队会话显团队名；否则按**会话自己的 presetId** 映射预设名
 *  （空态/无 presetId 不显示，禁止拿全局临时值凑——那正是串台根源）。 */
const mobileModeName = computed(() => {
  const c = currentConversation.value as any
  if (!c) return ''
  if (c.teamId) return teamsStore.teams.find((t: any) => t.id === c.teamId)?.name || ''
  if (!c.presetId) return ''
  return presetDisplayName(agentPresetsStore.presets.find((p: any) => p.id === c.presetId)) || ''
})
</script>

<template>
  <div class="app-container" :class="{ 'has-bg': !!bgImage, 'is-mobile': isMobile }">
    <!-- dsh 设计令牌（气泡/文字色板，对齐 design-platform.css 亮色主题） -->
    <div style="display: none" aria-hidden="true" class="dsh-tokens-host"></div>
    <!-- 0906 背景图层：z-0 垫底，has-bg 时主区容器底透明透出此层；
         各面板元素（气泡/输入框/卡片）自带实底不受影响。opacity=浓度滑杆 -->
    <div
      v-if="bgImage"
      class="app-bg-layer"
      :style="{ backgroundImage: `url(${bgImage})`, opacity: bgOpacity }"
      aria-hidden="true"
    ></div>

    <!-- 手机端顶栏（fixed 高 44px）：抽屉 + 标题（可横滚）+ 新对话 + 进程监控 + 通知
         ★1012 按反馈重排：① 标题只留这一处（会话头整行在手机端 CSS 隐藏），模式名跟随标题；
         ② 「进程监控 / 系统通知」从会话头挪到顶栏，与「新对话」同排；
         ③ 设置按钮撤掉（抽屉侧栏底部已有设置入口，见 Sidebar）。 -->
    <div v-if="isMobile" class="mobile-topbar">
      <button class="mobile-icon-btn" :aria-label="t('mobile.menu')" @click="mobileDrawer = !mobileDrawer">
        <i class="fas fa-bars"></i>
      </button>
      <div class="mobile-title-wrap">
        <span class="mobile-title">{{ currentConversation?.title || t('sidebar.newChat') }}</span>
        <span v-if="mobileModeName" class="mobile-mode">{{ mobileModeName }}</span>
      </div>
      <button class="mobile-icon-btn" :aria-label="t('conversation.newChat')" @click="mobileNewChat()">
        <i class="fas fa-plus"></i>
      </button>
      <button class="mobile-icon-btn relative" :aria-label="t('proc.title')" :title="t('proc.title')" @click="mobileProcsOpen = true">
        <Cpu :size="16" :stroke-width="1.9" />
        <span v-if="procsStore.runningCount" class="mobile-badge">{{ procsStore.runningCount }}</span>
      </button>
      <SystemNotificationCenter />
    </div>
    <ProcMonitorModal v-if="isMobile && mobileProcsOpen" @close="mobileProcsOpen = false" />
    <!-- 手机端抽屉遮罩 -->
    <div v-if="isMobile && mobileDrawer" class="mobile-scrim" @click="mobileDrawer = false"></div>

    <!-- Sidebar（桌面悬浮；手机端=抽屉，App 包装不侵入组件） -->
    <Sidebar
      :width="sidebarWidth"
      @update:width="sidebarWidth = $event"
      @request-close-drawer="mobileDrawer = false"
      class="app-sidebar"
      :class="{ 'mobile-drawer-open': isMobile && mobileDrawer }"
    />

    <!-- Main Content（响应式：左随侧栏宽度；背景走 .app-main 类（浅色白/深色映射层，0906 深色批：
         原 inline #ffffff 优先级压过 html.dark 类映射=主区不变黑的根因，彻底 class 化） -->
    <main
      class="app-main"
      :style="{
        left: (sidebarWidth + 24) + 'px',
        right: '12px'
      }"
    >
      <!-- Chat Area -->
      <div class="flex-1 overflow-hidden">
        <ChatInterface :conversation="currentConversation" />
      </div>
    </main>

    <!-- ★1011 手机端极简版：原来的底部导航（对话 / 统计胶囊 / 浏览器）整体撤掉 ——
         手机端只留「顶栏 + 对话流 + 输入框」，画面最干净。「浏览器」键本来也点不动
         （内置浏览器只绑了 mouse 事件，触屏滚不了），会话列表仍在顶栏汉堡抽屉里。
         统计胶囊槽保留但隐藏：ChatInterface 会 Teleport 到 #mobile-tabbar-stats，
         直接删节点会让它失去挂载目标（所以只隐藏，不删容器）。 -->
    <div v-if="isMobile" id="mobile-tabbar-stats" class="mobile-stats-sink" aria-hidden="true"></div>

    <!-- 顶部通知条（toasts）：0911 接通——此前 toasts 有数据但无渲染组件，失败提示全被吞 -->
    <ToastStack />

    <!-- 0914 开屏动画层：仅冷启动展示；splash.active 由 utils/splash 控制 -->
    <SplashScreen v-if="splash.active" />
    <!-- 0914c 首次启动引导层（首启自动弹；设置→关于 可重看） -->
    <OnboardingWizard v-if="onboarding.visible" />
    <!-- 0915 无边框窗口的边角缩放热区（仅 Tauri 桌面环境激活） -->
    <WinResizeZones />
    <!-- 0918 关闭询问弹窗（拦截窗口 ✕ → 取消 / 隐藏到托盘 / 退出 NIS） -->
    <CloseConfirmDialog />
  </div>
</template>

<style>
/* dsh 设计令牌（亮色主题，对齐 dsh design-platform.css）：
   气泡/文字/边框色板，组件里以 var(--dsw-*) 引用 */
:root {
  --dsw-static-deepseek-50: rgb(237, 243, 254);
  --dsw-static-deepseek-100: rgb(228, 237, 253);
  --dsw-static-deepseek-200: rgb(211, 226, 255);
  --dsw-static-deepseek-450: rgb(86, 134, 254);
  --dsw-static-deepseek-500: rgb(65, 118, 230);
  --dsw-static-green-500: rgb(34, 197, 94);
  --dsw-static-amber-500: rgb(245, 158, 11);
  --dsw-static-red-600: rgb(236, 19, 19);
  --dsw-static-neutral-bluish-00: rgb(255, 255, 255);
  --dsw-static-neutral-bluish-50: rgb(249, 250, 251);
  --dsw-static-neutral-bluish-60: rgb(245, 246, 247);
  --dsw-static-neutral-bluish-75: rgb(241, 243, 245);
  --dsw-static-neutral-bluish-100: rgb(235, 238, 242);
  --dsw-static-neutral-bluish-150: rgb(233, 236, 242);
  --dsw-static-neutral-bluish-200: rgb(225, 229, 238);
  --dsw-static-neutral-bluish-300: rgb(207, 211, 214);
  --dsw-static-neutral-bluish-400: rgb(173, 178, 184);
  --dsw-static-neutral-bluish-500: rgb(151, 157, 166);
  --dsw-static-neutral-bluish-600: rgb(129, 133, 140);
  --dsw-static-neutral-bluish-700: rgb(97, 102, 107);
  --dsw-static-neutral-bluish-750: rgb(67, 69, 74);
  --dsw-static-neutral-bluish-800: rgb(53, 54, 56);
  --dsw-static-neutral-bluish-850: rgb(44, 44, 46);
  --dsw-static-neutral-bluish-900: rgb(27, 27, 28);
  --dsw-static-neutral-bluish-950: rgb(21, 21, 23);
  --dsw-static-neutral-bluish-1000: rgb(15, 17, 21);
  --dsw-specific-bubble: var(--dsw-static-deepseek-50);
  --dsw-alias-label-primary: var(--dsw-static-neutral-bluish-1000);
  --dsw-alias-label-secondary: var(--dsw-static-neutral-bluish-700);
  --dsw-alias-label-tertiary: var(--dsw-static-neutral-bluish-600);
  --dsw-alias-label-caption: var(--dsw-static-neutral-bluish-400);
  --dsw-alias-label-primary-dimmed: var(--dsw-static-neutral-bluish-900);
  --dsw-alias-interactive-bg-hover: rgba(38, 49, 72, 0.06);
  --dsw-alias-interactive-bg-hover-solid: var(--dsw-static-neutral-bluish-75);
  --dsw-alias-state-success-primary: var(--dsw-static-green-500);
  --dsw-alias-state-warn-primary: var(--dsw-static-amber-500);
  --dsw-alias-state-error-primary: var(--dsw-static-red-600);
  --dsw-alias-border-l1: rgba(0, 0, 0, 0.04);
  --dsw-alias-border-l2: rgba(0, 0, 0, 0.1);
  --dsw-alias-bg-base: var(--dsw-static-neutral-bluish-00);
}

/* 0906 背景图：底图两层（图+浓度），has-bg 时主区容器底透明透出（面板元素自带有底不受影响） */
.app-bg-layer {
  position: absolute;
  inset: 0;
  z-index: 0;
  background-size: cover;
  background-position: center;
  pointer-events: none;
}
.app-container.has-bg .app-main { background: transparent; }

/* ── 0906 手机端（≤767px）：App 侧布局件（弹窗全屏化/dock 避让在 style.css）── */
.mobile-topbar {
  display: none;
}
.mobile-scrim {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  z-index: 59;
}
.mobile-tabbar {
  display: none;
}
@media (max-width: 767px) {
  /* ★1012 修复（用户手机端反馈「很多东西像被裁断」）：
     ① 旧底部导航 1011 已撤，底部 52px 预留是残留 ⇒ 抽屉底部缺口、最后一条会话被裁；
     ② z-index 60 > 顶栏 50 ⇒ 抽屉打开时汉堡被压住、点不到（只能点右侧遮罩）；
     ③ top:0 ⇒ 抽屉顶部内容顶到屏幕最上沿（真机状态栏/刘海会盖）。
     现：z 降到 45（顶栏 50 在其上，随时能点汉堡收起），top 让到顶栏下方，bottom 归 0。 */
  .app-container.is-mobile .app-sidebar {
    transform: translateX(calc(-100% - 24px));
    transition: transform 0.26s cubic-bezier(0.32, 0.72, 0, 1);
    z-index: 45;
    top: calc(44px + env(safe-area-inset-top, 0px));
    bottom: 0;
    left: 0;
    width: min(78vw, 320px) !important;
    border-radius: 0 18px 18px 0;
  }
  /* 遮罩同样要低于顶栏（59 > 50 会把顶栏整条盖死 → 抽屉开着时顶栏全废） */
  .mobile-scrim { z-index: 44; }
  /* ★1012 手机端侧栏：功能项（新建项目 → 记忆库）改**双列**，给会话列表腾出高度
     （需求要求「把新建项目到记忆库这一排的功能做成双排，给对话列表多一些位置」）。
     桌面端不受影响（规则挂在 .app-container.is-mobile 且在本媒体查询内）。
     「新建项目」那行是独立节点（.action-row），保持整行不动 —— 它是主操作，放半格反而空一格。 */
  .app-container.is-mobile .app-sidebar nav.flex.flex-col {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 4px;
  }
  .app-container.is-mobile .app-sidebar nav.flex.flex-col > button { width: 100%; }
  /* space-y-0.5 的兄弟 margin 与 grid gap 叠一起高度不均 ⇒ 手机端只留 gap */
  .app-container.is-mobile .app-sidebar nav.flex.flex-col > * + * { margin-top: 0; }
  .app-container.is-mobile .app-sidebar.mobile-drawer-open {
    transform: translateX(0);
  }
  /* ★1012 修复：ChatInterface 根节点是 absolute inset-0 —— 绝对定位子元素以 app-main 的
     padding box 为包含块，**padding-top 对它完全无效**，内容整体顶到 y=0 被 44px 顶栏盖住
     （会话标题 + 两颗齿轮按钮全被压掉）。改成真正的 top/bottom 让路。 */
  .app-container.is-mobile .app-main {
    left: 0 !important;
    right: 0 !important;
    top: calc(44px + env(safe-area-inset-top, 0px)) !important;
    bottom: 0 !important;
    padding-top: 0;
    padding-bottom: 0;
    border-radius: 0 !important;
  }
  .mobile-topbar {
    display: flex;
    align-items: center;
    gap: 6px;
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    height: calc(44px + env(safe-area-inset-top, 0px));
    padding: env(safe-area-inset-top, 0px) 10px 0;
    background: var(--nis-bg-panel, #ffffff);
    border-bottom: 1px solid var(--nis-border, rgba(0, 0, 0, 0.06));
    z-index: 50;
  }
  html.dark .mobile-topbar { background: #111111; border-bottom-color: #262626; }
  /* 标题 + 模式名：★1012 需求要求「标题可横向滚动完整展示」——去掉 truncate，改横滚容器 */
  .mobile-title-wrap {
    flex: 1; min-width: 0;
    display: flex; align-items: baseline; gap: 6px;
    overflow-x: auto; overflow-y: hidden;
    scrollbar-width: none;
    -webkit-overflow-scrolling: touch;
  }
  .mobile-title-wrap::-webkit-scrollbar { display: none; }
  .mobile-title { font-size: 14px; font-weight: 640; color: var(--nis-text-1, #15151a); white-space: nowrap; }
  html.dark .mobile-title { color: #e9e9ef; }
  .mobile-mode { flex: none; font-size: 11px; font-weight: 400; color: #9ca3af; white-space: nowrap; }
  html.dark .mobile-mode { color: #7b7b85; }
  /* 进程监控角标（与桌面会话头那颗同口径：正在运行的进程数） */
  .mobile-badge {
    position: absolute; top: 0; right: 0;
    min-width: 15px; height: 15px; padding: 0 4px;
    border-radius: 999px; background: #6366f1; color: #fff;
    font-size: 9px; font-weight: 500;
    display: flex; align-items: center; justify-content: center;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.12);
  }
  .mobile-icon-btn {
    width: 34px; height: 34px; border-radius: 50%;
    display: inline-flex; align-items: center; justify-content: center;
    font-size: 16px; color: #444; background: transparent; border: none; cursor: pointer;
  }
  html.dark .mobile-icon-btn { color: #c9c9d1; }
  .mobile-icon-btn:hover { background: rgba(0, 0, 0, 0.05); }
  html.dark .mobile-icon-btn:hover { background: rgba(255, 255, 255, 0.07); }
  .mobile-tabbar {
    display: flex;
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    height: calc(52px + env(safe-area-inset-bottom, 0px));
    padding-bottom: env(safe-area-inset-bottom, 0px);
    background: var(--nis-bg-panel, #ffffff);
    border-top: 1px solid var(--nis-border, rgba(0, 0, 0, 0.06));
    z-index: 55;
  }
  html.dark .mobile-tabbar { background: #111111; border-top-color: #262626; }
  .mobile-tabbar button {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 2px;
    border: none;
    background: none;
    cursor: pointer;
    color: #9ca3af;
    font-size: 10px;
  }
  html.dark .mobile-tabbar button { color: #6f6f78; }
  .mobile-tabbar button i { font-size: 17px; }
  /* ── ★1011 手机端极简版（is-mobile 由 script 的 detectMobile 判定：窄 + 触屏）──
     目标：手机上只留「顶栏 + 对话流 + 输入框」，去掉桌面向的重入口。 */
  .mobile-stats-sink { display: none; }  /* ★1012：统计胶囊已改回**原位渲染**（ChatInterface 的 Teleport 改 disabled），
                                            此槽位空置不再使用 —— 只留节点，避免旧代码找不到目标报错 */
  /* ★1012：预览 tab 栏不再整条隐藏 —— 打开的工作区文件 tab 由 PreviewTabBar 内部
     的「当前 + 下拉」承担（显示在「对话」与右侧三个固定 tab 之间，多个可下拉切换），
     隐藏桌面那排 zone 的规则也一并收口在 PreviewTabBar 的 scoped 样式里。 */
  /* 会话行内的「新建 / 更多」在桌面是 hover 才显形 —— 手机没有 hover，永远看不见也点不到
     （等于手机上没法新建/重命名/删除会话）。极简版把这两颗命门按钮强制常显。 */
  .app-container.is-mobile .plus-btn,
  .app-container.is-mobile .menu-btn { opacity: 1 !important; }
  .mobile-tabbar button.active { color: #111827; }
  html.dark .mobile-tabbar button.active { color: #e9e9ef; }
  .mobile-tabbar button.disabled { opacity: 0.4; pointer-events: none; }
  /* 0907 图二：导航=对话/浏览器两键 + 中心统计胶囊槽（StatsLine compact Teleport 挂载点） */
  .mobile-tabbar button.tab-key { flex: 0 0 74px; }
  .tabbar-stats {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0 4px;
  }
  .tabbar-stats .stats-line { padding: 0; }
  .tabbar-stats .stats-pill { background: rgba(0, 0, 0, 0.05); border-color: transparent; }
  html.dark .tabbar-stats .stats-pill { background: rgba(255, 255, 255, 0.08); }
}
</style>
