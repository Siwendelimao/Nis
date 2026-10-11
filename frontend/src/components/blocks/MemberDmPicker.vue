<script setup lang="ts">
/**
 * MemberDmPicker —— 输入框工具栏的 @成员单聊入口（0904 用户验收：从 ChatInterface 内联抽出）。
 * 交互规范与快捷命令（QuickCommands）完全对齐：
 * - 按钮为横向胶囊（非正圆），选中态紫底
 * - 面板 rounded-xl shadow-xl / 条目黑底 hover / 分组标题 10px uppercase / 逐条延迟入场
 * - 点面板与按钮以外的空白处自动关闭（document click + menuRef 判定）
 */
import { ref, onMounted, onUnmounted } from 'vue'
import { t } from '@/utils/i18n'

const props = defineProps<{
  members: Array<{ id: string; name: string; role: string; avatar?: string }>
  target: { id: string; name: string } | null
}>()
const emit = defineEmits<{ (e: 'pick', m: { id: string; name: string }): void; (e: 'clear'): void }>()

const isOpen = ref(false)
const menuRef = ref<HTMLElement | null>(null)

function toggle() { isOpen.value = !isOpen.value }
function pick(m: { id: string; name: string }) {
  emit('pick', { id: m.id, name: m.name })
  isOpen.value = false
}
function clear() {
  emit('clear')
  isOpen.value = false
}
function handleClickOutside(e: MouseEvent) {
  if (menuRef.value && !menuRef.value.contains(e.target as Node)) isOpen.value = false
}
onMounted(() => { document.addEventListener('click', handleClickOutside) })
onUnmounted(() => { document.removeEventListener('click', handleClickOutside) })
</script>

<template>
  <div ref="menuRef" class="relative flex-shrink-0 flex items-center" style="height: 32px;">
    <!-- 胶囊按钮（0904 反馈：@ 是模式切换按钮用胶囊区别于普通圆形工具按钮） -->
    <button
      @click="toggle"
      class="px-2.5 py-1.5 flex items-center justify-center rounded-full hover:bg-gray-100 transition-colors"
      :class="{ 'bg-violet-100 hover:bg-violet-100': target }"
      :title="t('dm.title')"
    >
      <i class="fas fa-at text-[15px]" :class="target ? 'text-violet-600' : 'text-gray-600'"></i>
    </button>

    <Transition name="cmd-pop">
      <div
        v-if="isOpen"
        class="absolute bottom-full left-0 mb-2 w-60 bg-white rounded-xl shadow-xl border border-gray-200 py-2 z-[9999] max-h-[360px] overflow-y-auto custom-scroll"
      >
        <div class="px-3 py-1.5">
          <span class="text-[10px] font-[530] text-gray-400 uppercase tracking-wider">{{ t('dm.pickMember') }}</span>
        </div>
        <button
          v-for="(m, i) in members"
          :key="m.id"
          @click="pick(m)"
          class="cmd-item w-full flex items-start gap-2 px-3 py-2 text-left hover:bg-gray-900 hover:text-white transition-colors group"
          :style="{ animationDelay: (i * 40) + 'ms' }"
        >
          <!-- 0913 头像批：成员预设头像（未设置 → 首字占位） -->
          <span class="flex-shrink-0 inline-flex mt-0.5">
            <img v-if="m.avatar" :src="m.avatar" alt="" class="w-6 h-6 rounded-full object-cover" />
            <span v-else class="w-6 h-6 rounded-full bg-gray-200 group-hover:bg-gray-700 inline-flex items-center justify-center text-[10px] font-[640] text-gray-500 group-hover:text-white">{{ (m.name || '?').slice(0, 1) }}</span>
          </span>
          <div class="flex-1 min-w-0">
            <div class="text-xs font-[530] truncate">@{{ m.name }}</div>
            <div class="text-[10px] text-gray-400 group-hover:text-gray-300 truncate mt-0.5">{{ m.role || m.id }}</div>
          </div>
        </button>
        <div v-if="target" class="my-1 mx-3 border-t border-gray-100"></div>
        <button v-if="target" @click="clear" class="w-full text-left px-3 py-1.5 text-[11px] text-gray-500 hover:bg-gray-50 transition-colors">{{ t('dm.exitDm') }}</button>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
/* 与 QuickCommands 同款弹出/收合动画（逐条滑入） */
.cmd-pop-enter-active {
  animation: popIn 0.25s cubic-bezier(0.34, 1.56, 0.64, 1) both;
}
.cmd-pop-leave-active {
  animation: popOut 0.15s ease-in both;
}
@keyframes popIn {
  from { opacity: 0; transform: translateY(8px) scale(0.92); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}
@keyframes popOut {
  from { opacity: 1; transform: translateY(0) scale(1); }
  to { opacity: 0; transform: translateY(8px) scale(0.92); }
}
.cmd-pop-enter-active .cmd-item {
  animation: itemSlide 0.3s cubic-bezier(0.34, 1.56, 0.64, 1) both;
}
@keyframes itemSlide {
  from { opacity: 0; transform: translateX(-6px); }
  to { opacity: 1; transform: translateX(0); }
}
</style>
