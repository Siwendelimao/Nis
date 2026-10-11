<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  /** 发送者名称，无图片时取首字符显示 */
  name: string
  /** 头像图片路径（有则显示图片，无则圆形首字符占位） */
  image?: string
  size?: number
}>()

const initial = computed(() => {
  const n = (props.name || '?').trim()
  return n ? n.charAt(0).toUpperCase() : '?'
})
</script>

<template>
  <div
    class="rounded-full flex items-center justify-center shrink-0 overflow-hidden bg-gray-100 text-gray-700 font-medium border border-gray-200 select-none"
    :style="{
      width: (size || 28) + 'px',
      height: (size || 28) + 'px',
      fontSize: Math.round((size || 28) * 0.45) + 'px',
    }"
  >
    <img v-if="image" :src="image" :alt="name" class="w-full h-full object-cover" />
    <template v-else>{{ initial }}</template>
  </div>
</template>
