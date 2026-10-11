<script setup lang="ts">
import { ref, computed, nextTick, onMounted, onUnmounted } from 'vue'
import { t } from '@/utils/i18n'

/**
 * MiniSelect —— 输入框快捷命令同风格的下拉选择器。
 * 白底圆角弹层 + cmd-item 项（hover 反白）+ 双行文本（label+desc）+ 分组。
 * 弹层 Teleport 到 body + fixed 定位：彻底脱离弹窗/卡片 overflow 裁切；
 * 展开时按触发器实测定位（水平优先左对齐、防溢出翻转；垂直空间不足自动上弹）。
 */
export interface MiniOption {
  value: string
  label: string
  desc?: string
  group?: string
  /** ★1010-D：单项禁用（如「Git Bash 未安装」——灰着能看见、点了不生效） */
  disabled?: boolean
}

const props = withDefaults(defineProps<{
  modelValue: string
  options: MiniOption[]
  placeholder?: string
  disabled?: boolean
  width?: string
  dropUp?: boolean
}>(), { placeholder: '', disabled: false, width: 'w-full', dropUp: false })

const emit = defineEmits<{ (e: 'update:modelValue', v: string): void }>()

const open = ref(false)
const rootRef = ref<HTMLElement | null>(null)
const panelRef = ref<HTMLElement | null>(null)
/** fixed 定位（px）：展开时按触发器实测计算（maxH=按可用空间动态限高） */
const pos = ref<{ left: number; top?: number; bottom?: number; width: number; maxH: number } | null>(null)

const current = computed(() => props.options.find(o => o.value === props.modelValue))
const groups = computed(() => {
  const g: Array<{ name: string; items: MiniOption[] }> = []
  for (const o of props.options) {
    const key = o.group || ''
    let grp = g.find(x => x.name === key)
    if (!grp) { grp = { name: key, items: [] }; g.push(grp) }
    grp.items.push(o)
  }
  return g
})

function panelWidth(rect: DOMRect): number {
  return props.width === 'w-full' ? rect.width : 280
}

function measure() {
  const el = rootRef.value
  if (!el) return
  const rect = el.getBoundingClientRect()
  const w = panelWidth(rect)
  const margin = 8
  // 水平：优先左对齐触发器；右侧放不下 → 右对齐；都不够 → 贴边
  let left = rect.left
  if (left + w > window.innerWidth - margin) left = rect.right - w
  if (left < margin) left = margin
  // 垂直：优先下方弹出（0910 二批①：旧逻辑"下方空间<320 就上弹"造成大面积遮挡）；
  // 只有下方放不下（<160px）且上方空间更大时才上弹；高度按可用空间动态限高（上限 320）
  const spaceDown = window.innerHeight - rect.bottom - margin
  const spaceUp = rect.top - margin
  const goUp = props.dropUp || (spaceDown < 160 && spaceUp > spaceDown)
  const maxH = Math.max(120, Math.min(320, goUp ? spaceUp : spaceDown))
  pos.value = goUp
    ? { left, bottom: window.innerHeight - rect.top + 6, width: w, maxH }
    : { left, top: rect.bottom + 6, width: w, maxH }
}

function pick(v: string) {
  if (props.options.find((x) => x.value === v)?.disabled) return   // ★1010-D：禁用项点了不生效
  emit('update:modelValue', v)
  open.value = false
}
function toggle() {
  if (props.disabled) return
  const next = !open.value
  open.value = next
  if (next) nextTick(measure)
}
function onDocClick(e: MouseEvent) {
  if (!open.value) return
  const t = e.target as Node
  if (rootRef.value?.contains(t) || panelRef.value?.contains(t)) return
  open.value = false
}
/** 弹窗内滚动/窗口尺寸变化时重定位（面板 fixed，不跟随文档流） */
function onReposition() {
  if (open.value) measure()
}
onMounted(() => {
  document.addEventListener('click', onDocClick)
  window.addEventListener('scroll', onReposition, true)
  window.addEventListener('resize', onReposition)
})
onUnmounted(() => {
  document.removeEventListener('click', onDocClick)
  window.removeEventListener('scroll', onReposition, true)
  window.removeEventListener('resize', onReposition)
})
</script>

<template>
  <div ref="rootRef" class="relative" :class="width">
    <button
      type="button"
      :disabled="disabled"
      class="w-full flex items-center justify-between gap-2 px-3 py-2 rounded-lg border border-gray-200 bg-white text-left transition-colors hover:border-gray-400 disabled:opacity-50 disabled:cursor-not-allowed"
      @click="toggle"
    >
      <span class="truncate text-[12px]" :class="current ? 'text-gray-800' : 'text-gray-400'">{{ current?.label || placeholder || t('mini.placeholder') }}</span>
      <i :class="['fas fa-chevron-down text-[9px] text-gray-400 transition-transform duration-200 shrink-0', open ? 'rotate-180' : '']"></i>
    </button>

    <Teleport to="body">
      <Transition name="mini-pop">
        <div
          v-if="open && pos"
          ref="panelRef"
          class="fixed z-[10040] bg-white rounded-xl shadow-xl border border-gray-200 py-1.5 overflow-y-auto custom-scroll mini-panel"
          :style="{ left: pos.left + 'px', top: pos.top != null ? pos.top + 'px' : 'auto', bottom: pos.bottom != null ? pos.bottom + 'px' : 'auto', width: pos.width + 'px', maxHeight: (pos.maxH || 320) + 'px' }"
        >
          <template v-for="(g, gi) in groups" :key="gi">
            <div v-if="g.name" class="px-3 py-1.5">
              <span class="text-[10px] font-medium text-gray-400 uppercase tracking-wider">{{ g.name }}</span>
            </div>
            <button
              v-for="o in g.items"
              :key="o.value"
              type="button"
              class="cmd-item w-full flex items-center gap-2.5 px-3 py-2 text-left transition-colors group"
              :class="o.disabled ? 'opacity-40 cursor-not-allowed' : 'hover:bg-gray-900 hover:text-white'"
              @click="pick(o.value)"
            >
              <div class="flex-1 min-w-0">
                <div class="text-xs font-medium flex items-center gap-1.5">
                  {{ o.label }}
                  <i v-if="o.value === modelValue" class="fas fa-check text-[9px] text-blue-500 group-hover:text-white"></i>
                </div>
                <div v-if="o.desc" class="text-[10px] text-gray-400 group-hover:text-gray-300 truncate">{{ o.desc }}</div>
              </div>
            </button>
          </template>
          <div v-if="options.length === 0" class="px-3 py-4 text-center text-[11px] text-gray-400">{{ placeholder || t('mini.placeholder') }}</div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
.mini-pop-enter-active { animation: miniPop 0.18s cubic-bezier(0.34, 1.4, 0.64, 1) both; }
/* 选中即关（0910 二批①）：去掉离场动画——关弹层还播 0.12s 渐隐、叠加面板布局跳动=体感"闪出闪消失几下" */
.mini-pop-leave-active { animation: none; }
@keyframes miniPop {
  from { opacity: 0; transform: translateY(-4px) scale(0.98); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}
</style>
