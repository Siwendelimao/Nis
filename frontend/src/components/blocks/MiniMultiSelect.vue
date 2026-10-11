<script setup lang="ts">
import { ref, computed, nextTick, onMounted, onUnmounted } from 'vue'
import { t } from '@/utils/i18n'

/**
 * MiniMultiSelect —— MiniSelect 的多选版（0910 二批②：成员面板"技能"由内联复选列表改下拉）。
 * 触发器显示已选摘要；弹层行点击=勾选/取消（弹层不关）；定位/智能方向/动态限高与 MiniSelect 同款。
 * 弹层带 .mini-panel class——成员面板的外点关闭白名单依赖它（选技能不会把面板关掉）。
 */
export interface MiniOption {
  value: string
  label: string
  desc?: string
  group?: string
}

const props = withDefaults(defineProps<{
  modelValue: string[]
  options: MiniOption[]
  placeholder?: string
  disabled?: boolean
  width?: string
}>(), { placeholder: '', disabled: false, width: 'w-full' })

const emit = defineEmits<{ (e: 'update:modelValue', v: string[]): void }>()

const open = ref(false)
const rootRef = ref<HTMLElement | null>(null)
const panelRef = ref<HTMLElement | null>(null)
/** fixed 定位（px）：展开时按触发器实测计算（maxH=按可用空间动态限高） */
const pos = ref<{ left: number; top?: number; bottom?: number; width: number; maxH: number } | null>(null)

const selected = computed(() => new Set(props.modelValue))
const summary = computed(() => {
  const labels = props.options.filter(o => selected.value.has(o.value)).map(o => o.label)
  if (!labels.length) return ''
  return labels.length <= 2 ? labels.join('、') : `${labels[0]}、${labels[1]} 等 ${labels.length} 项`
})
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
  let left = rect.left
  if (left + w > window.innerWidth - margin) left = rect.right - w
  if (left < margin) left = margin
  // 垂直：优先下方；只有下方放不下（<160px）且上方空间更大时才上弹；高度按可用空间动态限高
  const spaceDown = window.innerHeight - rect.bottom - margin
  const spaceUp = rect.top - margin
  const goUp = spaceDown < 160 && spaceUp > spaceDown
  const maxH = Math.max(120, Math.min(320, goUp ? spaceUp : spaceDown))
  pos.value = goUp
    ? { left, bottom: window.innerHeight - rect.top + 6, width: w, maxH }
    : { left, top: rect.bottom + 6, width: w, maxH }
}

function toggleValue(v: string) {
  emit('update:modelValue', selected.value.has(v) ? props.modelValue.filter(x => x !== v) : [...props.modelValue, v])
}
function toggle() {
  if (props.disabled) return
  const next = !open.value
  open.value = next
  if (next) nextTick(measure)
}
function onDocClick(e: MouseEvent) {
  if (!open.value) return
  const target = e.target as Node
  if (rootRef.value?.contains(target) || panelRef.value?.contains(target)) return
  open.value = false
}
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
      <span class="truncate text-[12px]" :class="summary ? 'text-gray-800' : 'text-gray-400'">{{ summary || placeholder || t('mini.placeholder') }}</span>
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
              class="cmd-item w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-gray-900 hover:text-white transition-colors group"
              @click="toggleValue(o.value)"
            >
              <span class="w-4 h-4 rounded border flex items-center justify-center shrink-0" :class="selected.has(o.value) ? 'bg-indigo-500 border-indigo-500' : 'border-gray-300 bg-white group-hover:border-gray-400'">
                <i v-if="selected.has(o.value)" class="fas fa-check text-[9px] text-white"></i>
              </span>
              <div class="flex-1 min-w-0">
                <div class="text-xs font-medium">{{ o.label }}</div>
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
/* 选中即关不适用（多选弹层常开）；离场无动画与 MiniSelect 同口径 */
.mini-pop-leave-active { animation: none; }
@keyframes miniPop {
  from { opacity: 0; transform: translateY(-4px) scale(0.98); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}
</style>
