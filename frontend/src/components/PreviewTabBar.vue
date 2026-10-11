<script setup lang="ts">
/**
 * 对话窗口标签栏（DSH 风格 tab bar）
 *  - 第一个 tab 固定为「对话」（不可关闭）
 *  - 后续为预览 tab（网页/图片/文件，可关闭，带 ×）
 *  - 右侧固定「浏览器」「办公室」视图 tab（60s 未使用自动释放占用，见 stores/previewTabs.ts）
 *  - tab 状态按窗口隔离（见 stores/previewTabs.ts）
 */
import { computed, ref, onUnmounted } from 'vue'
import { usePreviewTabsStore } from '@/stores/previewTabs'
import { useConversationsStore } from '@/stores/conversations'
import { useBrowserStore } from '@/stores/browser'
import { useSettingsStore } from '@/stores/settings'
import { gsap } from 'gsap'
import TeamMemberPanel from './TeamMemberPanel.vue'
import { t } from '@/utils/i18n'

const previewTabs = usePreviewTabsStore()
const conversationsStore = useConversationsStore()
const browserStore = useBrowserStore()
const settingsStore = useSettingsStore()
const props = defineProps<{ runLogOpen?: boolean; workspaceOpen?: boolean; versionOpen?: boolean }>()
const emit = defineEmits<{ (e: 'toggle-run-log'): void; (e: 'toggle-workspace'): void; (e: 'toggle-version'): void }>()

const convId = computed(() => String(conversationsStore.activeConversationId ?? ''))
/** 草稿态（还没开始对话的新窗口）：办公室/浏览器/画布不可点（0905 问题7） */
const draftMode = computed(() => !conversationsStore.activeConversationId)

/** AI 操作浏览器标识（0905 问题6 滑动窗口）：工具间隙 control 帧闪 '' 不熄灭，最近 8s 内有 AI 动作就常亮 */
const tick = ref(0)
let tickTimer: ReturnType<typeof setInterval> | null = null
tickTimer = setInterval(() => { tick.value++ }, 1000)
onUnmounted(() => { if (tickTimer) { clearInterval(tickTimer); tickTimer = null } })
const aiBrowserActive = computed(() => {
  void tick.value
  const s = browserStore.bucket(convId.value)
  return s.controlledBy === 'ai' || (s.aiLastActiveAt > 0 && Date.now() - s.aiLastActiveAt < 8000)
})

const tabs = computed(() => previewTabs.tabsFor(convId.value))
const activeTabId = computed(() => previewTabs.activeTabId(convId.value))
const currentFixedView = computed(() => previewTabs.fixedView(convId.value))

function selectTab(id: string | null) {
  previewTabs.setActive(convId.value, id)
}

function selectFixedView(view: 'chat' | 'browser' | 'office') {
  previewTabs.setFixedView(convId.value, view)
}

function closeTab(e: MouseEvent, id: string) {
  e.stopPropagation()
  previewTabs.closeTab(convId.value, id)
}

/* ── ★1012 手机端：预览/工作区文件 tab 收成「当前 + 下拉」──
   反馈：手机上「工作区打开文件的 tab 直接没了」（1011 把整条 zone 隐藏了），
   要求 ① 打开的文件 tab 显示在「对话」和右侧三个固定 tab 之间；
        ② 多个 tab 用下拉互相切换。
   判据用 matchMedia（与 App.vue 的媒体查询同口径）；桌面端这些节点 display:none，不渲染布局。 */
const mqMobileTabs = window.matchMedia('(max-width: 767px)')
const isMobileTabs = ref(mqMobileTabs.matches)
const mobileTabMenuOpen = ref(false)
const onMqMobileTabs = (e: MediaQueryListEvent) => {
  isMobileTabs.value = e.matches
  if (!e.matches) mobileTabMenuOpen.value = false
}
mqMobileTabs.addEventListener('change', onMqMobileTabs)
onUnmounted(() => mqMobileTabs.removeEventListener('change', onMqMobileTabs))

/** 当前激活的预览 tab（下拉里高亮 / 收起态显示它） */
const activePreviewTab = computed(() => tabs.value.find(x => x.id === activeTabId.value) || null)
function selectMobileTab(id: string) {
  previewTabs.setActive(convId.value, id)
  mobileTabMenuOpen.value = false
}

/** tab 图标（按类型） */
function tabIcon(kind: string): string {
  switch (kind) {
    case 'browser': return 'fa-globe'
    case 'image': return 'fa-image'
    case 'file': return 'fa-file-code'
    default: return 'fa-eye'
  }
}

/* GSAP：tab 激活动画 */
function onTabEnter(el: HTMLElement) {
  gsap.to(el, { y: -1, duration: 0.15, ease: 'power2.out' })
}
function onTabLeave(el: HTMLElement) {
  gsap.to(el, { y: 0, duration: 0.15, ease: 'power2.out' })
}
</script>

<template>
  <div class="preview-tabbar relative">
    <!-- 对话 tab（固定，不可关闭） -->
    <div
      class="preview-tab preview-tab-conv"
      :class="{ 'preview-tab-active': activeTabId === null && currentFixedView === 'chat' }"
      @mouseenter="onTabEnter($event.currentTarget)"
      @mouseleave="onTabLeave($event.currentTarget)"
      @click="selectFixedView('chat'); selectTab(null)"
    >
      <i class="fas fa-comment-dots"></i>
      <span>{{ t('tabs.chat') }}</span>
    </div>

    <!-- 预览 tabs（可关闭；0906 七批）：独立 zone 容器夹在「对话」与固定组之间——
         固定按钮（办公室/浏览器/日志/工作区）shrink-0 永不被挤出屏幕；
         数量 >3 自动紧凑（padding 收窄+标题压到 46px），悬停 tooltip 已展示全名 -->
    <div class="preview-tabs-zone" :class="{ 'is-compact': tabs.length > 3 }">
      <div
        v-for="tab in tabs"
        :key="tab.id"
        class="preview-tab"
        :class="{ 'preview-tab-active': activeTabId === tab.id }"
        @mouseenter="onTabEnter($event.currentTarget)"
        @mouseleave="onTabLeave($event.currentTarget)"
        @click="selectTab(tab.id)"
      >
        <i :class="['fas', tabIcon(tab.kind)]"></i>
        <span class="preview-tab-title">{{ tab.title }}</span>
        <span v-if="tab.aiNotice" class="tab-ai-badge" :title="t('tabs.aiOpenedHint') || 'AI 打开了新内容，点击查看'"></span>
        <span class="preview-tab-close" @click="closeTab($event, tab.id)">
          <i class="fas fa-times"></i>
        </span>
      </div>
    </div>


    <!-- ★1012 手机端：预览/工作区文件 tab 收成「当前 + 下拉」——位置正在「对话」与右侧固定组之间
         （桌面端 display:none，不参与布局） -->
    <div v-if="isMobileTabs" class="ptb-mb">
      <div
        class="preview-tab ptb-mb-cur"
        :class="{ 'preview-tab-active': !!activePreviewTab }"
        @click="tabs.length && (mobileTabMenuOpen = !mobileTabMenuOpen)"
      >
        <i :class="['fas', activePreviewTab ? tabIcon(activePreviewTab.kind) : 'fa-eye']"></i>
        <span class="preview-tab-title">{{ activePreviewTab ? activePreviewTab.title : t('tabs.preview') }}</span>
        <span v-if="tabs.length > 1" class="ptb-mb-count">{{ tabs.length }}</span>
        <i v-if="tabs.length" class="fas fa-caret-down ptb-mb-caret" :class="{ 'ptb-mb-caret-open': mobileTabMenuOpen }"></i>
      </div>
      <div v-if="mobileTabMenuOpen && tabs.length" class="ptb-mb-menu">
        <div
          v-for="tab in tabs"
          :key="tab.id"
          class="ptb-mb-item"
          :class="{ 'ptb-mb-item-active': tab.id === activeTabId }"
          @click="selectMobileTab(tab.id)"
        >
          <i :class="['fas', tabIcon(tab.kind)]"></i>
          <span class="ptb-mb-item-title">{{ tab.title }}</span>
          <span class="preview-tab-close" @click="closeTab($event, tab.id)"><i class="fas fa-times"></i></span>
        </div>
      </div>
    </div>

    <!-- 团队模式：成员按钮（小弹窗：成员列表 + 黑板进度） -->
    <TeamMemberPanel />

    <div
      class="preview-tab tab-browser"
      :class="{ 'preview-tab-active': currentFixedView === 'browser', 'preview-tab-disabled': draftMode }"
      @mouseenter="onTabEnter($event.currentTarget)"
      @mouseleave="onTabLeave($event.currentTarget)"
      @click="!draftMode && selectFixedView('browser')"
    >
      <span>{{ t('panel.viewBrowser') }}</span>
      <span v-if="aiBrowserActive" class="ai-live-dot" :title="t('tabs.aiOperating')"></span>
    </div>
    <!-- 运行日志：右侧面板开关 -->
    <div
      class="preview-tab tab-log"
      :class="{ 'preview-tab-active': props.runLogOpen }"
      @click="emit('toggle-run-log')"
    >
      <span>{{ t('tabs.log') }}</span>
    </div>
    <!-- 工作区：本会话工作区文件树（右键预览/浏览器打开/删除/所在位置） -->
    <div
      class="preview-tab tab-ws"
      :class="{ 'preview-tab-active': props.workspaceOpen }"
      @click="emit('toggle-workspace')"
    >
      <span>{{ t('workspace.title') }}</span>
    </div>
    <!-- 版本：本会话工作区的 git 提交时间线（只读；顶部亮出仓库路径，判定"是哪个仓库"） -->
    <div
      class="preview-tab tab-ver"
      :class="{ 'preview-tab-active': props.versionOpen }"
      @click="emit('toggle-version')"
    >
      <span>{{ t('git.title') }}</span>
    </div>
  </div>
</template>

<style scoped>
.preview-tabbar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  border-bottom: 1px solid rgba(0, 0, 0, 0.08);
  overflow-x: auto;
  overflow-y: hidden;
  flex: none;
  background: transparent;
}
.preview-tabbar::-webkit-scrollbar {
  display: none;
}

/* 胶囊状标签 */
.preview-tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 12px;
  font-size: 12px;
  color: #6b7280;
  border-radius: 9999px;
  border: 1px solid transparent;
  cursor: pointer;
  white-space: nowrap;
  user-select: none;
  transform: translateZ(0);
  will-change: transform;
  transition: all 0.15s ease;
}
/* 悬停：更明显的反馈 */
.preview-tab:hover {
  color: #111827;
  background: #eef0f2;
  border-color: #e5e7eb;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.06);
}
.preview-tab:hover .preview-tab-close {
  opacity: 1;
}
.preview-tab-active {
  color: #ffffff;
  font-weight: 500;
  background: #111827;
  border-color: #111827;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);
}
.preview-tab-active:hover {
  color: #ffffff;
  background: #1f2937;
  border-color: #1f2937;
}


/* 0906 七批：预览 tabs zone——独占弹性中段，溢出区内横滑；两侧固定元素 shrink-0 不被挤出 */
.preview-tabs-zone {
  display: flex; align-items: center; gap: 6px;
  flex: 1 1 0; min-width: 0;
  overflow: hidden; /* 0906 七批续2：不横滑——所有 tab 均分压缩全部可见（用户要求） */
}
.preview-tabs-zone .preview-tab { flex: 0 1 auto; min-width: 0; }
.preview-tabs-zone .preview-tab-title { flex: 0 1 auto; min-width: 0; }
.preview-tabs-zone::-webkit-scrollbar { display: none; }
.preview-tabbar > :not(.preview-tabs-zone) { flex-shrink: 0; }

/* ── ★1012 手机端「当前 tab + 下拉」── */
.ptb-mb { display: none; position: relative; min-width: 0; }
.ptb-mb-count {
  min-width: 14px; height: 14px; padding: 0 4px; border-radius: 999px;
  background: rgba(0, 0, 0, 0.08); color: #4b5563;
  font-size: 9px; font-weight: 600;
  display: inline-flex; align-items: center; justify-content: center;
}
.ptb-mb-caret { font-size: 9px; color: #9ca3af; transition: transform 0.15s ease; }
.ptb-mb-caret-open { transform: rotate(180deg); }
.ptb-mb-menu {
  position: absolute; left: 0; top: calc(100% + 6px); z-index: 80;
  min-width: 190px; max-width: 78vw;
  padding: 4px; max-height: 52vh; overflow-y: auto;
  background: #ffffff; border: 1px solid rgba(0, 0, 0, 0.08); border-radius: 12px;
  box-shadow: 0 12px 30px -10px rgba(0, 0, 0, 0.28);
}
html.dark .ptb-mb-menu { background: #141418; border-color: #2a2a30; }
.ptb-mb-item {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 10px; border-radius: 8px;
  font-size: 12px; color: #374151; cursor: pointer;
}
.ptb-mb-item:hover { background: rgba(0, 0, 0, 0.05); }
.ptb-mb-item-active { background: rgba(0, 0, 0, 0.07); font-weight: 600; }
html.dark .ptb-mb-item { color: #d8d8de; }
html.dark .ptb-mb-item:hover { background: rgba(255, 255, 255, 0.07); }
.ptb-mb-item-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

@media (max-width: 767px) {
  /* 桌面那排预览 tab 在手机端收进下拉（原 App.vue 的 :is-mobile 规则也在此收口，避免两处耦合） */
  .preview-tabs-zone { display: none !important; }
  .ptb-mb { display: flex; align-items: center; min-width: 0; max-width: 52vw; }
  .ptb-mb-cur { max-width: 100%; gap: 5px; padding: 5px 9px; }
  .ptb-mb-cur .preview-tab-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  /* 下拉要能溢出 tabbar（.preview-tabbar 桌面是 overflow-x:auto，会把它裁掉） */
  .preview-tabbar { overflow: visible; }
  /* 右侧固定组（日志 / 工作区 / 时光机）靠右：需求要求「这三个 tab 靠右」 */
  .tab-log { margin-left: auto; }
}
/* 紧凑模式（>3 个预览 tab）：收窄 padding 与标题宽度，容纳更多 */
.preview-tabs-zone.is-compact .preview-tab { padding: 5px 8px; gap: 4px; }
.preview-tabs-zone.is-compact .preview-tab-title { max-width: 46px; }
.preview-tab-title {
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.preview-tab-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  font-size: 9px;
  color: #9ca3af;
  opacity: 0.5;
  transition: all 0.15s ease;
}
.preview-tab-close:hover {
  opacity: 1;
  background: rgba(0, 0, 0, 0.12);
  color: #111827;
}
.preview-tab-active .preview-tab-close {
  color: rgba(255, 255, 255, 0.6);
  opacity: 0.7;
}
.preview-tab-active .preview-tab-close:hover {
  opacity: 1;
  color: #ffffff;
  background: rgba(255, 255, 255, 0.2);
}

.preview-tabbar-spacer {
  flex: 1;
  min-width: 8px;
}

/* 草稿态禁用（0905 问题7）：置灰+不可点 */
.preview-tab-disabled {
  opacity: 0.4;
  pointer-events: none;
}

/* AI 正在操作浏览器的脉冲标识（0905）：绿点呼吸，active 底色下换白点 */
.ai-live-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #22c55e;
  animation: aiLivePulse 1.2s ease-in-out infinite;
}
.preview-tab-active .ai-live-dot {
  background: #4ade80;
}
@keyframes aiLivePulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.35; transform: scale(0.75); }
}
/* AI 后台打开的 tab 提示（0908 反打扰）：琥珀呼吸小点，用户点击该 tab（setActive）即清除；
   用户主动发起的预览永不出此点 */
.tab-ai-badge {
  flex: none;
  width: 7px;
  height: 7px;
  margin-left: -2px;
  border-radius: 50%;
  background: #f59e0b;
  box-shadow: 0 0 0 2px rgba(245, 158, 11, 0.22);
  animation: aiLivePulse 1.4s ease-in-out infinite;
}
.preview-tab-active .tab-ai-badge {
  background: #fbbf24;
}
</style>
