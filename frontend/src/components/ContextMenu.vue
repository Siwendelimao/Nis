<script setup lang="ts">
import { ref, computed, nextTick, onMounted, onUnmounted, watch } from 'vue'

export interface ContextMenuItem {
  label: string
  icon?: string
  /** 危险操作（删除等）：悬停红色 */
  danger?: boolean
  /** 分隔线：在菜单项前插入 */
  divider?: boolean
  /** 禁用 */
  disabled?: boolean
  /** 显示勾选态 */
  checked?: boolean
  action: () => void
}

const props = defineProps<{
  visible: boolean
  x: number
  y: number
  items: ContextMenuItem[]
}>()

const emit = defineEmits<{
  close: []
}>()

const menuRef = ref<HTMLElement | null>(null)
/* ★ 0919 修：位置改成**响应式状态**（原来直接写 el.style.left/top —— 组件一旦重渲染，
   Vue 的 :style 绑定就把它覆盖回鼠标坐标，收敛白做）。
   尺寸用 offsetWidth/offsetHeight：入场动画带 scale(0.97)，getBoundingClientRect 会偏小。 */
const pos = ref({ left: props.x, top: props.y })
const style = computed(() => ({
  left: pos.value.left + 'px',
  top: pos.value.top + 'px',
}))

function handleClick(e: MouseEvent) {
  if (menuRef.value && !menuRef.value.contains(e.target as Node)) {
    emit('close')
  }
}

// 外点关闭统一交给全局捕获（右键新开/关闭由 useGlobalContextMenu 处理），
// 这里只处理左键外点关闭，避免与全局打开菜单的捕获逻辑竞态。
function run(item: ContextMenuItem) {
  if (item.disabled) return
  emit('close')
  item.action()
}

// 菜单贴近视口边缘时向内收敛，避免溢出屏幕
watch(
  () => props.visible,
  (v) => {
    if (!v) return
    pos.value = { left: props.x, top: props.y }
    nextTick(() => {
      const el = menuRef.value
      if (!el) return
      const w = el.offsetWidth
      const h = el.offsetHeight
      const pad = 8
      let left = props.x
      let top = props.y
      if (left + w > window.innerWidth - pad) {
        left = Math.max(pad, window.innerWidth - w - pad)
      }
      if (top + h > window.innerHeight - pad) {
        top = Math.max(pad, window.innerHeight - h - pad)
      }
      if (left !== pos.value.left || top !== pos.value.top) pos.value = { left, top }
    })
  },
)

onMounted(() => {
  document.addEventListener('click', handleClick)
})

onUnmounted(() => {
  document.removeEventListener('click', handleClick)
})
</script>

<template>
  <Teleport to="body">
    <Transition name="ctx-menu">
      <div
        v-if="visible"
        ref="menuRef"
        data-ctx="__noop"
        class="fixed z-[9999] min-w-[180px] max-h-[calc(100vh-16px)] bg-white rounded-xl shadow-2xl border border-gray-200 py-1.5 overflow-y-auto"
        :style="style"
      >
        <div class="flex flex-col gap-0.5 px-1.5">
          <template v-for="(item, i) in items" :key="i">
            <div v-if="item.divider" class="my-0.5 border-t border-gray-100"></div>
            <button
              v-else
              :disabled="item.disabled"
              class="menu-item flex items-center gap-2.5 px-2.5 py-2 text-xs rounded-lg transition-all duration-200 ease-out active:scale-[0.98]"
              :class="[
                item.disabled
                  ? 'text-gray-300 cursor-not-allowed'
                  : item.danger
                    ? 'text-gray-900 hover:bg-red-600 hover:text-white'
                    : 'text-gray-900 hover:bg-gray-900 hover:text-white',
              ]"
              :style="{ animationDelay: (i * 30) + 'ms' }"
              @click="run(item)"
            >
              <span class="w-4 flex items-center justify-center">
                <i :class="[item.icon || '', 'text-[11px]']"></i>
                <i v-if="item.checked" class="fas fa-check text-[10px]"></i>
              </span>
              <span class="flex-1 text-left">{{ item.label }}</span>
            </button>
          </template>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.ctx-menu-enter-active {
  transition: opacity 0.15s ease-out, transform 0.12s cubic-bezier(0.16, 1, 0.3, 1);
}
.ctx-menu-leave-active {
  transition: opacity 0.1s ease-in;
}
.ctx-menu-enter-from,
.ctx-menu-leave-to {
  opacity: 0;
  transform: translateY(-4px) scale(0.97);
}

/* 菜单项逐条弹出 */
.ctx-menu-enter-active .menu-item {
  animation: ctxMenuItemIn 0.22s cubic-bezier(0.2, 0.8, 0.2, 1) both;
}

@keyframes ctxMenuItemIn {
  from {
    opacity: 0;
    transform: translateY(-8px) scale(0.92);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}
</style>
