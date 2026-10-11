<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue'
import { Folder, ChevronRight, MoreHorizontal, Pin, Plus, Loader2, ShieldQuestion, HelpCircle } from 'lucide-vue-next'
import { t } from '@/utils/i18n'

const props = withDefaults(defineProps<{
  type: 'conv' | 'project'
  id: string
  title: string
  selected?: boolean
  pinned?: boolean
  /** 行内重命名编辑态（标题换成输入框） */
  editing?: boolean
  /** 全局下拉菜单是否正挂在本项上（菜单按钮保持可见） */
  menuOpen?: boolean
  /** 仅项目节点：展开箭头旋转 */
  projectExpanded?: boolean
  /** 紧凑行（项目子树内的对话） */
  dense?: boolean
  /** 行尾追加 + 按钮（项目节点的新建对话快捷入口） */
  showPlus?: boolean
  /** 会话最后一条消息预览（列表副标题） */
  subtitle?: string
  /** AI 回复中（右侧旋转点） */
  replying?: boolean
  /** 未读消息数（>0 显示红点/数字） */
  unread?: number
  /** 等待用户交互：permission=等待审批 / ask=等待回答问题 */
  pending?: 'permission' | 'ask' | null
  /** 0912 接入批：会话来源通道（'wechat'|'qq'|...）—— 标题后显示平台图标 */
  origin?: string
  /** 0912 十九批：定时任务支线（显示 ⏰ 闹钟标记） */
  task?: boolean
  /** 0918：特殊预设会话的标识小标（如「导入助手」会话显示「导入」） */
  presetTag?: string
}>(), {
  selected: false,
  pinned: false,
  editing: false,
  menuOpen: false,
  projectExpanded: false,
  dense: false,
  showPlus: false,
  subtitle: '',
  replying: false,
  unread: 0,
  pending: null,
  origin: '',
  task: false,
  presetTag: '',
})

const emit = defineEmits<{
  (e: 'select', el: HTMLElement): void
  (e: 'menu', info: { source: 'button' | 'contextmenu'; row: HTMLElement; x: number; y: number }): void
  (e: 'plus'): void
  (e: 'rename-confirm', title: string): void
  (e: 'rename-cancel'): void
}>()

const editValue = ref('')
const editRef = ref<HTMLInputElement | null>(null)

/** 0912 接入批：通道来源图标/颜色/名称（标题后小标）。用 FontAwesome brands（项目已从 CDN 加载） */
const ORIGIN_META: Record<string, { icon: string; color: string; label: string }> = {
  wechat: { icon: 'fab fa-weixin', color: '#07c160', label: '微信' },
  qq: { icon: 'fab fa-qq', color: '#12b7f5', label: 'QQ' },
  remote: { icon: 'fas fa-qrcode', color: '#6366f1', label: '远程访问' },
}
const originIcon = computed(() => ORIGIN_META[props.origin || '']?.icon || '')
const originColor = computed(() => ORIGIN_META[props.origin || '']?.color || '#9ca3af')
const originLabel = computed(() => ORIGIN_META[props.origin || '']?.label || '')

watch(
  () => props.editing,
  (v) => {
    if (v) {
      editValue.value = props.title
      nextTick(() => editRef.value?.focus())
    }
  },
)

/** 会话项 悬停/选中：纯 CSS（不再用 gsap 改内联 transform，避免快速切换时动画残留"卡住悬停"） */

/**
 * 0911 深夜：右键改走系统菜单。
 * 屏蔽浏览器原生右键菜单，改为在指针位置弹出本项目的行菜单
 * （取消置顶 / 重命名 / 提炼本窗口记忆 / 删除），与左键菜单按钮共用同一套 menuItems。
 * 重命名编辑态让出原生右键（保证输入框内复制/粘贴可用）。
 */
function onContextMenu(e: MouseEvent) {
  if (props.editing) return
  e.preventDefault()
  e.stopPropagation()
  const row = e.currentTarget as HTMLElement
  emit('menu', { source: 'contextmenu', row, x: e.clientX, y: e.clientY })
}

/** 菜单按钮（点击）→ 以整行矩形上报父组件定位下拉 */
function openMenu(e: MouseEvent) {
  const row = (e.currentTarget as HTMLElement).closest('.nis-sidebar-item') as HTMLElement
  emit('menu', { source: 'button', row, x: 0, y: 0 })
}

function confirmRename() {
  emit('rename-confirm', editValue.value)
}
function cancelRename() {
  emit('rename-cancel')
}
</script>

<template>
  <div
    class="nis-sidebar-item group relative flex items-center rounded-lg cursor-pointer mb-0.5 transition-all duration-150"
    :class="[
      dense ? 'gap-2 px-2.5 py-1' : 'gap-2.5 px-2.5 py-1.5',
      type === 'project' ? 'text-gray-700 hover:bg-gray-100' : '',
      type === 'conv' ? (selected ? 'conv-item conv-item-selected' : 'conv-item conv-item-idle') : '',
    ]"
    @click="emit('select', $event.currentTarget)"
    @contextmenu="onContextMenu"
  >
    <!-- 项目节点：展开箭头 + 文件夹 -->
    <template v-if="type === 'project'">
      <ChevronRight
        :size="14"
        stroke-width="2"
        class="flex-shrink-0 conv-icon transition-transform duration-200"
        :class="{ 'rotate-90': projectExpanded }"
        style="color:#6b7280;"
      />
      <Folder :size="15" stroke-width="1.75" class="flex-shrink-0 conv-icon" style="color:#6b7280;" />
    </template>
    <!-- 会话：状态图标（回复中/未读/审批/提问），默认状态不显示图标 -->
    <template v-else>
      <span v-if="pending" class="flex-shrink-0 flex items-center justify-center w-[15px]" :title="pending === 'permission' ? t('sbl.waitingApproval') : t('sbl.waitingAnswer')">
        <ShieldQuestion
          v-if="pending === 'permission'"
          :size="dense ? 14 : 15"
          stroke-width="2"
          class="conv-pending-icon conv-icon-perm"
          :style="{ color: selected ? '#ffffff' : '#f59e0b' }"
        />
        <HelpCircle
          v-else
          :size="dense ? 14 : 15"
          stroke-width="2"
          class="conv-pending-icon conv-icon-ask"
          :style="{ color: selected ? '#ffffff' : '#6366f1' }"
        />
      </span>
      <span v-else-if="replying" class="flex-shrink-0 flex items-center justify-center w-[15px]" :title="t('sbl.replying')">
        <Loader2 :size="dense ? 13 : 15" stroke-width="2.5" class="animate-spin conv-reply-icon" :style="{ color: selected ? '#ffffff' : '#6366f1' }" />
      </span>
      <span v-else-if="unread > 0" class="flex-shrink-0 flex items-center justify-center w-[15px]" :title="t('sbl.unreadN', { n: unread })">
        <span class="w-2 h-2 rounded-full conv-unread-dot" :style="{ backgroundColor: selected ? '#ffffff' : '#ef4444' }"></span>
      </span>
      <span v-else class="w-[15px] flex-shrink-0"></span>
    </template>

    <!-- 重命名态：行内输入框 -->
    <input
      v-if="editing"
      ref="editRef"
      v-model="editValue"
      type="text"
      class="flex-1 min-w-0 px-1.5 py-0.5 rounded-md border border-gray-300 text-[12px] outline-none focus:border-blue-500"
      @click.stop
      @keydown.enter="confirmRename"
      @keydown.esc="cancelRename"
      @blur="confirmRename"
    />
    <!-- 常态：标题（置顶带图标）+ 悬停菜单按钮 -->
    <template v-else>
      <span class="flex items-center gap-1 min-w-0 flex-1">
        <Pin v-if="pinned" :size="12" stroke-width="2" class="flex-shrink-0 conv-pin" :style="{ color: selected ? '#ffffff' : '#9ca3af' }" />
        <span class="flex flex-col min-w-0 leading-tight">
          <span class="flex items-center gap-1 min-w-0">
            <span class="truncate conv-text" :class="[dense ? 'text-[12px]' : 'text-[12px]', unread > 0 && !selected ? 'font-[640]' : '']">{{ title }}</span>
            <!-- 0912 接入批：通道来源图标（微信/QQ），加在标题后面 -->
            <i
              v-if="originIcon"
              :class="[originIcon, 'text-[10px] flex-shrink-0 conv-origin']"
              :style="{ color: selected ? 'rgba(255,255,255,0.75)' : originColor }"
              :title="originLabel"
            ></i>
            <!-- 0918：特殊预设会话标识（如「导入助手」→「导入」小标） -->
            <span
              v-if="presetTag"
              class="preset-tag flex-shrink-0 text-[9px] leading-[14px] px-1 rounded"
              :style="selected
                ? { background: 'rgba(255,255,255,0.22)', color: '#ffffff' }
                : { background: 'rgba(99,102,241,0.12)', color: '#6366f1' }"
            >{{ presetTag }}</span>
            <!-- 0912 十九批：定时任务支线 → 闹钟标记（这条对话属于某个定时任务） -->
            <i
              v-if="task"
              class="fas fa-clock text-[10px] flex-shrink-0 conv-task"
              :style="{ color: selected ? 'rgba(255,255,255,0.75)' : '#d97706' }"
              :title="t('ctx.taskSession')"
            ></i>
          </span>
          <span
            v-if="subtitle"
            class="truncate conv-subtitle"
            :class="dense ? 'text-[10px]' : 'text-[11px]'"
          >{{ subtitle }}</span>
        </span>
      </span>
      <button
        v-if="showPlus"
        class="plus-btn flex-shrink-0 w-6 h-6 flex items-center justify-center rounded-md transition-opacity hover:bg-gray-200"
        :class="menuOpen ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'"
        :title="t('conversation.newChat')"
        @click.stop="emit('plus')"
      >
        <Plus :size="14" stroke-width="2" style="color:#6b7280;" />
      </button>
      <button
        class="menu-btn flex-shrink-0 w-6 h-6 flex items-center justify-center rounded-md transition-opacity hover:bg-gray-200"
        :class="menuOpen ? 'opacity-100 bg-gray-100' : 'opacity-0 group-hover:opacity-100'"
        :title="t('sbl.moreActions')"
        @click.stop="openMenu"
      >
        <MoreHorizontal :size="14" stroke-width="2" style="color:#6b7280;" />
      </button>
    </template>
  </div>
</template>

<style scoped>
.conv-item {
  position: relative;
  color: #374151;
  background: transparent;
  transform: translateZ(0);
}
.conv-icon {
  color: #6b7280;
  transition: color 0.15s ease, transform 0.15s ease;
}
.conv-text {
  transition: color 0.15s ease;
}
.conv-subtitle {
  color: #9ca3af;
  transition: color 0.15s ease;
}
.conv-item-selected .conv-subtitle {
  color: rgba(255, 255, 255, 0.65);
}
.conv-item-idle {
  background: transparent;
}
/* 悬停浮起效果：纯 CSS（transition 自回退，无动画残留）+ icon/标题联动 */
.conv-item-idle:hover {
  background: #f9fafb;
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
}
.conv-item-idle:hover .conv-icon {
  color: #111827;
  transform: scale(1.12);
}
.conv-item-idle:hover .conv-text {
  color: #111827;
}
.conv-item-selected {
  background: #111827;
  box-shadow: 0 2px 8px rgba(0,0,0,0.25);
  color: #ffffff;
  font-weight: 500;
}
.conv-item-selected .conv-icon {
  color: #ffffff;
}
.conv-item-selected .conv-text {
  color: #ffffff;
}

/* ═══ 1010 深色对比度修复（只锁 html.dark，亮色模式零改动）═══
 * 背景：深色下全局反白层（style.css _darkgen）把选中行刷成浅底 #e9e9ef，
 * 但本组件行内 :style 写死的白色状态图标/胶囊（转圈/置顶/未读点/来源/预设标/闹钟）不会跟着翻转
 * → 白底白字、对比度崩；且深色面板上 #6366f1 细转圈偏暗、几乎看不见。
 * 规则（三层一眼分辨）：①选中=浅药丸+全行深色元素；②悬停=半透明白（全局层已给）；
 * ③运行中=亮靛蓝转圈（选中行上用深靛蓝），与底色层级无关。 */
/* ① 选中行（浅底 #e9e9ef）：全部转深 —— 兜底主/副标题（即使全局 :is() 规则失效也保证可读） */
html.dark .conv-item-selected .conv-text { color: #0a0a0a !important; }
html.dark .conv-item-selected .conv-subtitle { color: rgba(10, 10, 10, 0.62) !important; }
html.dark .conv-item-selected .conv-pin { color: rgba(10, 10, 10, 0.55) !important; }
html.dark .conv-item-selected .conv-reply-icon { color: #4f46e5 !important; }
html.dark .conv-item-selected .conv-icon-ask { color: #4f46e5 !important; }
html.dark .conv-item-selected .conv-icon-perm { color: #b45309 !important; }
html.dark .conv-item-selected .conv-unread-dot { background-color: #dc2626 !important; }
html.dark .conv-item-selected .conv-origin,
html.dark .conv-item-selected .conv-task { color: rgba(10, 10, 10, 0.72) !important; }
html.dark .conv-item-selected .preset-tag { background: rgba(10, 10, 10, 0.08) !important; color: #0a0a0a !important; }
/* ② 非选中（深底 #111）：运行中转圈/提问图标亮化（#818cf8 ≈ 6.3:1），预设标同步亮靛蓝 */
html.dark .conv-item-idle .conv-reply-icon,
html.dark .conv-item-idle .conv-icon-ask { color: #818cf8 !important; }
html.dark .conv-item-idle .preset-tag { color: #818cf8 !important; }
/* ③ 预览文字（副标题）深色提亮一档（#9ca3af → #a9a9b4 ≈ 8:1）；只动非选中行，选中行走上面的深色规则 */
html.dark .conv-item-idle .conv-subtitle { color: #a9a9b4 !important; }
/* ④ 项目节点图标（行内 #6b7280 在近黑面板上偏暗）→ 深色提亮 */
html.dark .conv-icon { color: #c9c9d1 !important; }
</style>
