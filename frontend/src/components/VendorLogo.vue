<script setup lang="ts">
import { ref, computed, watch } from 'vue'

const props = defineProps<{
  name: string
  src: string
  size?: number
}>()

const failed = ref(false)

// src 变化时重置失败态：选中新供应商后头像应立即恢复（此前 failed 一旦置 true 永不复位）
watch(() => props.src, () => {
  failed.value = false
})

const initial = computed(() => {
  const s = (props.name || '').trim()
  if (!s) return '?'
  return s[0].toUpperCase()
})

/**
 * ★ 0920（0.0.11）深色模式「默认白底」：`/providers-logo/*.svg` 全是**透明底 + 纯黑图形**
 *  （fill="#000000"），而 `html.dark .bg-white` 会被深色映射层改成 `--nis-bg-panel`(#111)
 *  ⇒ 黑 logo 落在 #111 上直接隐形（截图：DeepSeek / Anthropic / 通义 / 月之暗面 全看不清）。
 *  所以白托必须**内联**（inline style 优先级最高，映射层刷不掉它），且只在图片正常时加；
 *  首字母兜底那套自带 HSL 浅底深字，不需要额外白底。
 */
const trayStyle = computed(() => (failed.value ? undefined : '#ffffff'))

// 首字母兜底：按名字 hash 出稳定底色（灰底 → 彩色）
const fallbackStyle = computed(() => {
  const s = (props.name || '').trim()
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  const hues = [210, 265, 25, 160, 330, 200, 45, 285]
  const hue = hues[h % hues.length]
  return { backgroundColor: `hsl(${hue}, 70%, 92%)`, color: `hsl(${hue}, 55%, 38%)` }
})

function onError() {
  failed.value = true
}
</script>

<template>
  <span
    class="flex items-center justify-center rounded-full overflow-hidden shrink-0"
    :style="{ width: size + 'px', height: size + 'px', fontSize: Math.max(10, size * 0.45) + 'px', backgroundColor: trayStyle }"
    :class="failed ? 'font-semibold' : 'border border-gray-100'"
  >
    <img v-if="!failed" :src="src" :alt="name" class="object-contain" :style="{ width: size * 0.8 + 'px', height: size * 0.8 + 'px' }" @error="onError" />
    <span v-else class="w-full h-full flex items-center justify-center" :style="fallbackStyle">{{ initial }}</span>
  </span>
</template>
