<script setup lang="ts">
/* ── 0923：紧凑数值 chip（上下文 / 输出上限 / 输入上限 三列共用）──
 *  设计（用户定案）：
 *   · 显示成 128K / 1M 这种（省横向空间），底层存的仍是裸 token 数
 *   · 点击直接展开下拉：预设快捷项 + 自定义输入框（带 ✓ 确认按钮），不再用 number input 的上下档
 *   · 输入框支持 "128k" / "1m" / "128000" 三种写法
 *   · 空值 = 留空（走自动），下拉里有「清空」
 *   · usePortal：弹窗/滚动容器里用（Teleport 到 body + fixed 定位），避免被 overflow 裁掉 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { Check } from 'lucide-vue-next'

const props = withDefaults(defineProps<{
  modelValue: number | undefined | null
  presets: Array<{ label: string; v: number }>
  placeholder?: string
  disabled?: boolean
  title?: string
  /** 下拉浮层用 Teleport 到 body（父级有 overflow 裁剪时用） */
  usePortal?: boolean
}>(), { usePortal: false })
const emit = defineEmits<{ (e: 'update:modelValue', v: number | undefined): void }>()

const DROP_W = 172
const DROP_H = 128

const open = ref(false)
const custom = ref('')
const root = ref<HTMLElement | null>(null)
const btn = ref<HTMLElement | null>(null)
const pos = ref<{ left: number; top: number }>({ left: 0, top: 0 })

/** 裸 token → 128K / 1M 精简显示 */
function fmtNum(v: number | undefined | null): string {
  const n = Number(v) || 0
  if (n <= 0) return ''
  if (n >= 1000000) {
    const m = n / 1000000
    return (Number.isInteger(m) ? m : Math.round(m * 10) / 10) + 'M'
  }
  if (n >= 1000) return Math.round(n / 1000) + 'K'
  return String(n)
}
const shown = computed(() => fmtNum(props.modelValue))

/** 接受 "128k" / "1m" / "128000" 三种写法 */
function parseInput(s: string): number | undefined {
  const t = String(s || '').trim().toLowerCase().replace(/[,\s]/g, '')
  if (!t) return undefined
  const m = t.match(/^(\d+(?:\.\d+)?)([km])?$/)
  if (!m) return undefined
  const base = Number(m[1])
  if (!Number.isFinite(base)) return undefined
  const mul = m[2] === 'k' ? 1000 : m[2] === 'm' ? 1000000 : 1
  const v = Math.round(base * mul)
  return v > 0 ? v : undefined
}
function pick(v: number | undefined) {
  emit('update:modelValue', v)
  open.value = false
  custom.value = ''
}
function computePos() {
  const el = btn.value
  if (!el) return
  const r = el.getBoundingClientRect()
  const up = r.bottom + DROP_H + 10 > window.innerHeight
  pos.value = {
    left: Math.max(8, Math.min(r.left, window.innerWidth - DROP_W - 8)),
    top: up ? Math.max(8, r.top - DROP_H - 6) : r.bottom + 6,
  }
}
function toggle() {
  if (props.disabled) return
  open.value = !open.value
  if (open.value) {
    custom.value = shown.value
    computePos()
  }
}
/** 确认按钮：解析自定义输入，非法则忽略（保持原值） */
function confirmCustom() {
  const v = parseInput(custom.value)
  if (v === undefined && custom.value.trim() !== '') return
  pick(v)
}
function onDoc(e: MouseEvent) {
  if (!open.value) return
  const t = e.target as Node
  if (root.value?.contains(t)) return
  if ((t as HTMLElement)?.closest?.('[data-numchip-drop]')) return
  open.value = false
}
/** 滚动/缩放时关掉浮层（坐标会失准，简单可靠） */
function onScroll() { if (open.value) open.value = false }
onMounted(() => {
  document.addEventListener('mousedown', onDoc)
  window.addEventListener('scroll', onScroll, true)
  window.addEventListener('resize', onScroll)
})
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDoc)
  window.removeEventListener('scroll', onScroll, true)
  window.removeEventListener('resize', onScroll)
})
</script>

<template>
  <div ref="root" class="relative" :class="disabled ? 'opacity-40 pointer-events-none' : ''">
    <button
      ref="btn"
      type="button"
      :title="title"
      @click="toggle"
      class="w-full h-[26px] px-1.5 rounded-lg text-[11px] font-mono tabular-nums bg-white border text-center truncate transition-colors"
      :class="[
        shown ? 'text-gray-700' : 'text-gray-300',
        open ? 'border-gray-400 ring-1 ring-gray-200' : 'border-gray-200 hover:border-gray-400',
      ]"
    >{{ shown || placeholder || '—' }}</button>

    <!-- Portal 模式（弹窗内） -->
    <Teleport v-if="usePortal" to="body">
      <Transition name="fade">
        <div
          v-if="open"
          data-numchip-drop
          class="fixed z-[10050] p-2 rounded-xl bg-white shadow-2xl border border-gray-100"
          :style="{ left: pos.left + 'px', top: pos.top + 'px', width: DROP_W + 'px' }"
        >
          <div class="grid grid-cols-3 gap-1">
            <button
              v-for="p in presets" :key="p.label" type="button"
              class="px-1 py-1 rounded-lg text-[10px] transition-colors truncate"
              :class="Number(modelValue) === p.v ? 'bg-gray-900 text-white' : 'bg-gray-50 text-gray-600 hover:bg-gray-100'"
              @click="pick(p.v)"
            >{{ p.label }}</button>
          </div>
          <div class="flex items-center gap-1 mt-2">
            <input
              v-model="custom" type="text" inputmode="numeric" :placeholder="placeholder || '自定义'"
              class="flex-1 min-w-0 h-[26px] px-2 rounded-lg border border-gray-200 text-[11px] font-mono outline-none focus:border-gray-400"
              @keydown.enter.prevent="confirmCustom"
            />
            <button type="button" title="确认" class="w-[26px] h-[26px] shrink-0 flex items-center justify-center rounded-lg bg-gray-900 text-white hover:bg-gray-700 transition-colors" @click="confirmCustom">
              <Check :size="12" :stroke-width="2.5" />
            </button>
          </div>
          <button type="button" class="w-full mt-1.5 py-1 rounded-lg text-[10px] text-gray-400 hover:bg-gray-50 transition-colors" @click="pick(undefined)">清空</button>
        </div>
      </Transition>
    </Teleport>

    <!-- 普通模式（表格内联） -->
    <Transition v-else name="fade">
      <div
        v-if="open"
        data-numchip-drop
        class="absolute z-[60] left-0 mt-1 p-2 rounded-xl bg-white shadow-xl border border-gray-100"
        :style="{ width: DROP_W + 'px' }"
      >
        <div class="grid grid-cols-3 gap-1">
          <button
            v-for="p in presets" :key="p.label" type="button"
            class="px-1 py-1 rounded-lg text-[10px] transition-colors truncate"
            :class="Number(modelValue) === p.v ? 'bg-gray-900 text-white' : 'bg-gray-50 text-gray-600 hover:bg-gray-100'"
            @click="pick(p.v)"
          >{{ p.label }}</button>
        </div>
        <div class="flex items-center gap-1 mt-2">
          <input
            v-model="custom" type="text" inputmode="numeric" :placeholder="placeholder || '自定义'"
            class="flex-1 min-w-0 h-[26px] px-2 rounded-lg border border-gray-200 text-[11px] font-mono outline-none focus:border-gray-400"
            @keydown.enter.prevent="confirmCustom"
          />
          <button type="button" title="确认" class="w-[26px] h-[26px] shrink-0 flex items-center justify-center rounded-lg bg-gray-900 text-white hover:bg-gray-700 transition-colors" @click="confirmCustom">
            <Check :size="12" :stroke-width="2.5" />
          </button>
        </div>
        <button type="button" class="w-full mt-1.5 py-1 rounded-lg text-[10px] text-gray-400 hover:bg-gray-50 transition-colors" @click="pick(undefined)">清空</button>
      </div>
    </Transition>
  </div>
</template>
