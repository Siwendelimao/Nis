<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{ content: string }>()

interface TreeNode {
  name: string
  indent: number
  isFolder: boolean
}

const nodes = computed<TreeNode[]>(() => {
  return props.content.trim().split('\n').filter(l => l.trim()).map(line => {
    const indent = line.search(/\S/)
    const name = line.trim()
    return { name, indent, isFolder: name.endsWith('/') }
  })
})
</script>
<template>
  <div class="my-2 rounded-lg border border-gray-200 bg-gray-50 p-3 font-mono text-sm">
    <div v-for="(node, i) in nodes" :key="i" class="flex items-center gap-1.5 hover:bg-gray-100 rounded px-1 py-0.5" :style="{ paddingLeft: (node.indent * 8 + 4) + 'px' }">
      <i :class="[node.isFolder ? 'fas fa-folder text-yellow-500' : 'fas fa-file-code text-blue-400', 'w-4']"></i>
      <span :class="node.isFolder ? 'font-medium text-gray-800' : 'text-gray-600'">{{ node.name }}</span>
    </div>
  </div>
</template>
