<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{ content: string }>()

interface TaskItem { checked: boolean; text: string }

const items = computed<TaskItem[]>(() => {
  return props.content.trim().split('\n').filter(l => l.trim()).map(line => {
    const match = line.match(/^\s*-\s+\[([ x])\]\s+(.+)/)
    if (match) return { checked: match[1] === 'x', text: match[2] }
    return { checked: false, text: line.trim() }
  })
})
</script>
<template>
  <div class="my-2 space-y-1.5">
    <div v-for="(item, i) in items" :key="i" class="flex items-center gap-2 text-sm">
      <i :class="['fas', item.checked ? 'fa-check-square text-green-500' : 'fa-square text-gray-300']"></i>
      <span :class="item.checked ? 'line-through text-gray-400' : 'text-gray-700'">{{ item.text }}</span>
    </div>
  </div>
</template>
