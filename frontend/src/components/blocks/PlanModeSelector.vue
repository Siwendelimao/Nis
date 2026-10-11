<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { ClipboardList, Hammer, Target, Zap } from 'lucide-vue-next'
import { t } from '@/utils/i18n'

const props = defineProps<{
  modelValue?: string
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()

const isOpen = ref(false)

const modes = [
  { value: 'plan', icon: ClipboardList, label: 'plan.modePlan', desc: 'plan.modePlanDesc' },
  { value: 'build', icon: Hammer, label: 'plan.modeBuild', desc: 'plan.modeBuildDesc' },
  // 0920：goal 尚未实装（后端 buildModeHint 对它不注入任何指令 = 等同默认模式），
  // 界面据实标注"规划中"，不让人以为选了有用。
  { value: 'goal', icon: Target, label: 'plan.modeGoal', desc: 'plan.modeGoalDesc', planned: true },
  { value: 'default', icon: Zap, label: 'plan.modeDefault', desc: 'plan.modeDefaultDesc' },
]

const currentMode = computed({
  get: () => props.modelValue || 'default',
  set: (val) => {
    emit('update:modelValue', val)
  }
})

function selectMode(val: string) {
  currentMode.value = val
}

const currentLabel = computed(() => t(modes.find(m => m.value === currentMode.value)?.label || ''))
const currentIcon = computed(() => modes.find(m => m.value === currentMode.value)?.icon || '')
const currentDesc = computed(() => t(modes.find(m => m.value === currentMode.value)?.desc || ''))

const menuRef = ref<HTMLElement | null>(null)

function toggle() {
  isOpen.value = !isOpen.value
}

function handleClickOutside(e: MouseEvent) {
  if (menuRef.value && !menuRef.value.contains(e.target as Node)) {
    isOpen.value = false
  }
}

onMounted(() => {
  document.addEventListener('click', handleClickOutside)
})

onUnmounted(() => {
  document.removeEventListener('click', handleClickOutside)
})
</script>

<template>
  <div ref="menuRef" class="relative flex items-center">
    <button
      @click="toggle"
      class="w-8 h-8 flex items-center justify-center text-gray-600 hover:bg-gray-100 rounded-full transition-colors"
      :title="currentLabel + ' — ' + currentDesc"
    >
      <component :is="currentIcon" :size="16" stroke-width="1.75" />
    </button>

    <!-- 弹出选择器 -->
    <Transition name="plan-pop">
      <div
        v-if="isOpen"
        class="mode-popover absolute bottom-full left-0 mb-2 bg-white rounded-full flex items-center p-1.5 shadow-xl border border-gray-200 z-[9999] whitespace-nowrap"
      >
        <button
          v-for="(mode, idx) in modes"
          :key="mode.value"
          @click="selectMode(mode.value)"
          :class="[
            'flex items-center rounded-full h-8 transition-all relative',
            currentMode === mode.value
              ? 'bg-gray-100 px-3 gap-2'
              : 'px-2.5 text-gray-400 hover:text-gray-600',
            mode.planned && currentMode !== mode.value ? 'opacity-45' : ''
          ]"
          :title="t(mode.desc)"
          :style="{ animationDelay: isOpen ? idx * 60 + 'ms' : '0ms' }"
        >
          <component :is="mode.icon" :size="16" stroke-width="1.75" class="transition-transform duration-200" :class="currentMode === mode.value ? 'scale-110' : ''" />
          <span
            v-if="currentMode === mode.value"
            class="text-xs font-[530] text-gray-700 whitespace-nowrap overflow-hidden label-text"
          >{{ t(mode.label) }}</span>
          <!-- 规划中：未选中只在右上角点一个小圆点（不撑宽下拉），选中时把「规划中」写在标签后面 -->
          <span v-if="mode.planned && currentMode === mode.value" class="plan-soon-text">{{ t('plan.modeSoon') }}</span>
          <span v-else-if="mode.planned" class="plan-soon-dot"></span>
        </button>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.plan-pop-enter-active {
  animation: popIn 0.3s cubic-bezier(0.34, 1.56, 0.64, 1) both;
}
.plan-pop-leave-active {
  animation: popOut 0.2s ease-in both;
}

@keyframes popIn {
  from { opacity: 0; transform: translateY(10px) scale(0.85); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}

@keyframes popOut {
  from { opacity: 1; transform: translateY(0) scale(1); }
  to { opacity: 0; transform: translateY(10px) scale(0.85); }
}

.plan-pop-enter-active button {
  animation: itemBounce 0.35s cubic-bezier(0.34, 1.56, 0.64, 1) both;
}

@keyframes itemBounce {
  from { opacity: 0; transform: translateY(-8px) scale(0.8); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}

.label-text {
  animation: labelExpand 0.25s cubic-bezier(0.2, 0.8, 0.2, 1) both;
}

/* 0920：目标模式的「规划中」标记——未实装就据实标出来，别让人以为选了有用。
   未选中=右上一个小圆点（不加宽）；选中=标签后一枚胶囊文字。 */
.plan-soon-dot {
  position: absolute;
  top: 3px;
  right: 3px;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: #eab308;
}
.plan-soon-text {
  flex: none;
  padding: 1px 5px;
  border-radius: 999px;
  background: rgba(234, 179, 8, 0.16);
  color: #a16207;
  font-size: 10px;
  font-weight: 500;
  line-height: 14px;
  white-space: nowrap;
}
html.dark .plan-soon-text {
  background: rgba(234, 179, 8, 0.18);
  color: #fbbf24;
}

@keyframes labelExpand {
  from { opacity: 0; max-width: 0; transform: translateX(-4px); }
  to { opacity: 1; max-width: 80px; transform: translateX(0); }
}
</style>
