<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{ content: string }>()

const rows = computed(() => {
  const lines = props.content.trim().split('\n').filter(l => l.trim())
  if (lines.length < 2) return []
  const headerLine = lines[0]
  const dataLines = lines.slice(2)
  const headers = headerLine.split('|').map(h => h.trim()).filter(h => h)
  const rows = dataLines.map(line => line.split('|').map(c => c.trim()).filter(c => c))
  return { headers, rows }
})
</script>
<template>
  <div v-if="rows.headers" class="my-2 overflow-x-auto">
    <table class="min-w-full text-sm border border-gray-200 rounded-lg overflow-hidden">
      <thead class="bg-gray-50">
        <tr>
          <th v-for="h in rows.headers" :key="h" class="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider border-b border-gray-200">{{ h }}</th>
        </tr>
      </thead>
      <tbody class="bg-white divide-y divide-gray-100">
        <tr v-for="(row, i) in rows.rows" :key="i" :class="i % 2 === 0 ? 'bg-white' : 'bg-gray-50/50'">
          <td v-for="(cell, ci) in row" :key="ci" class="px-4 py-2 text-sm text-gray-700 border-b border-gray-100">{{ cell }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
