<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'

const props = defineProps<{
  modelValue: string
  options: { id: string; label: string }[]
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()

const isOpen = ref(false)
const menuRef = ref<HTMLElement | null>(null)

/* 0915 修复：触发按钮文案必须是响应式派生——旧版挂载时 syncLabel() 取快照一次，
   切换声音后按钮仍显示旧名（「切换后下拉内容还是之前的」的根因）。 */
const currentLabel = computed(() => props.options.find(o => o.id === props.modelValue)?.label || '')

function toggle() {
  isOpen.value = !isOpen.value
}

function select(id: string) {
  emit('update:modelValue', id)
  isOpen.value = false
}

function close() {
  isOpen.value = false
}

function handleClickOutside(e: MouseEvent) {
  if (menuRef.value && !menuRef.value.contains(e.target as Node)) {
    close()
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
  <div ref="menuRef" class="relative">
    <button
      @click="toggle"
      class="flex items-center gap-2 pl-3 pr-2 h-8 rounded-lg border border-gray-200 bg-white text-xs text-gray-700 hover:bg-gray-50 transition-colors"
    >
      <span class="max-w-[80px] truncate">{{ currentLabel }}</span>
      <i class="fas fa-chevron-down text-[9px] text-gray-400 transition-transform duration-200" :class="isOpen ? 'rotate-180' : ''"></i>
    </button>

    <Transition name="sound-select">
      <div
        v-if="isOpen"
        class="absolute bottom-full mb-1.5 right-0 w-44 bg-white rounded-xl shadow-xl border border-gray-200 py-2 z-50 overflow-hidden"
      >
        <div class="flex flex-col gap-0.5 px-2">
          <button
            v-for="opt in options"
            :key="opt.id"
            @click="select(opt.id)"
            class="sound-item flex items-center gap-2.5 px-2.5 py-2 text-xs rounded-lg transition-all duration-200 ease-out"
            :class="opt.id === modelValue ? 'bg-gray-900 text-white' : 'text-gray-900 hover:bg-gray-900 hover:text-white'"
          >
            <i class="fas fa-music text-[11px] w-4" :class="opt.id === modelValue ? 'text-white' : 'text-gray-400'"></i>
            <span class="flex-1 truncate text-left">{{ opt.label }}</span>
            <i v-if="opt.id === modelValue" class="fas fa-check text-[10px] text-white"></i>
          </button>
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.sound-select-enter-active {
  transition: opacity 0.2s ease-out, transform 0.2s cubic-bezier(0.34, 1.56, 0.64, 1);
}
.sound-select-leave-active {
  transition: opacity 0.15s ease-in, transform 0.15s ease-in;
}
.sound-select-enter-from,
.sound-select-leave-to {
  opacity: 0;
  transform: translateY(-8px) scale(0.95);
}

.sound-select-enter-active .sound-item {
  animation: soundItemIn 0.3s cubic-bezier(0.2, 0.8, 0.2, 1) both;
}

@keyframes soundItemIn {
  from {
    opacity: 0;
    transform: translateY(-10px) scale(0.9);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}
</style>
