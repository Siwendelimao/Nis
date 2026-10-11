<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { Unlock, ShieldCheck, Shield } from 'lucide-vue-next'
import { t } from '@/utils/i18n'

const props = defineProps<{
  modelValue?: string
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()

const isOpen = ref(false)
const menuRef = ref<HTMLElement | null>(null)

const modes = [
  { value: 'full_access', icon: Unlock, label: 'perm.modeFull', desc: 'perm.modeFullDesc' },
  { value: 'self_audit', icon: ShieldCheck, label: 'perm.modeAudit', desc: 'perm.modeAuditDesc' },
  { value: 'confirm', icon: Shield, label: 'perm.modeConfirm', desc: 'perm.modeConfirmDesc' },
]

const currentMode = computed({
  get: () => props.modelValue || 'confirm',
  set: (val) => {
    emit('update:modelValue', val)
  }
})

const currentLabel = computed(() => t(modes.find(m => m.value === currentMode.value)?.label || ''))
const currentIcon = computed(() => modes.find(m => m.value === currentMode.value)?.icon || '')
const currentDesc = computed(() => t(modes.find(m => m.value === currentMode.value)?.desc || ''))

function selectMode(val: string) {
  currentMode.value = val
  // v-model 双向绑定 → ChatInterface watch(permissionMode) → sendPermissionMode RPC 同步后端
  // 注意：不关闭下拉 —— 选项高亮即时移动（跟手），点空白才收起（原始手感）
}

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
    <Transition name="permission-pop">
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
              : 'px-2.5 text-gray-400 hover:text-gray-600'
          ]"
          :title="t(mode.desc)"
          :style="{ animationDelay: isOpen ? idx * 60 + 'ms' : '0ms' }"
        >
          <component :is="mode.icon" :size="16" stroke-width="1.75" class="transition-transform duration-200" :class="currentMode === mode.value ? 'scale-110' : ''" />
          <span
            v-if="currentMode === mode.value"
            class="text-xs font-[530] text-gray-700 whitespace-nowrap overflow-hidden label-text"
          >{{ t(mode.label) }}</span>
        </button>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.permission-pop-enter-active {
  animation: popIn 0.3s cubic-bezier(0.34, 1.56, 0.64, 1) both;
}
.permission-pop-leave-active {
  animation: popOut 0.2s ease-in both;
}

@keyframes popIn {
  from {
    opacity: 0;
    transform: translateY(10px) scale(0.85);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

@keyframes popOut {
  from {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
  to {
    opacity: 0;
    transform: translateY(10px) scale(0.85);
  }
}

.permission-pop-enter-active button {
  animation: itemBounce 0.35s cubic-bezier(0.34, 1.56, 0.64, 1) both;
}

@keyframes itemBounce {
  from {
    opacity: 0;
    transform: translateY(-8px) scale(0.8);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

.label-text {
  animation: labelExpand 0.25s cubic-bezier(0.2, 0.8, 0.2, 1) both;
}

@keyframes labelExpand {
  from {
    opacity: 0;
    max-width: 0;
    transform: translateX(-4px);
  }
  to {
    opacity: 1;
    max-width: 80px;
    transform: translateX(0);
  }
}
</style>
