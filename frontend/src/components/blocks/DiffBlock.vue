<script setup lang="ts">
import { ref, computed } from 'vue'
import { t } from '@/utils/i18n'

const props = defineProps<{ content: string; title?: string }>()

const expanded = ref(false)

const stats = computed(() => {
  const lines = props.content.trim().split('\n')
  let additions = 0
  let deletions = 0
  lines.forEach(line => {
    if (line.startsWith('+') && !line.startsWith('+++')) additions++
    if (line.startsWith('-') && !line.startsWith('---')) deletions++
  })
  return { additions, deletions }
})
</script>
<template>
  <div class="my-2 rounded-lg border border-gray-200 overflow-hidden">
    <button @click="expanded = !expanded" class="w-full flex items-center gap-2 px-4 py-2.5 bg-gray-50 hover:bg-gray-100 transition-colors text-left">
      <i :class="['fas fa-chevron-right text-xs text-gray-400 transition-transform', expanded ? 'rotate-90' : '']"></i>
      <i class="fas fa-exchange-alt text-blue-500 text-sm"></i>
      <span class="text-sm text-gray-700 font-medium">{{ title || t('diff.title') }}</span>
      <span class="text-xs text-green-600 bg-green-50 px-1.5 py-0.5 rounded font-mono">+{{ stats.additions }}</span>
      <span class="text-xs text-red-600 bg-red-50 px-1.5 py-0.5 rounded font-mono">-{{ stats.deletions }}</span>
      <span class="text-xs text-gray-400 ml-auto">{{ t('diff.clickExpand') }}</span>
    </button>
    <Transition name="diff-expand">
      <div v-if="expanded" class="font-mono text-xs overflow-x-auto">
        <div v-for="(line, i) in content.trim().split('\n')" :key="i"
          :class="[
            'px-4 py-0.5 border-l-2',
            line.startsWith('+') && !line.startsWith('+++') ? 'bg-green-50 text-green-700 border-green-400' :
            line.startsWith('-') && !line.startsWith('---') ? 'bg-red-50 text-red-700 border-red-400' :
            line.startsWith('@@') ? 'bg-blue-50 text-blue-600 border-blue-300 font-medium py-1' :
            (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('+++') || line.startsWith('---')) ? 'bg-gray-100 text-gray-500 border-transparent font-medium py-1' :
            'text-gray-600 border-transparent'
          ]"
        >
          <span v-if="line.startsWith('+') && !line.startsWith('+++')" class="text-green-500 mr-2">+</span>
          <span v-else-if="line.startsWith('-') && !line.startsWith('---')" class="text-red-500 mr-2">-</span>
          <span v-html="line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')"></span>
        </div>
      </div>
    </Transition>
  </div>
</template>
<style scoped>
.diff-expand-enter-active, .diff-expand-leave-active { transition: all 0.25s ease-out; overflow: hidden; }
.diff-expand-enter-from, .diff-expand-leave-to { opacity: 0; max-height: 0; }
.diff-expand-enter-to, .diff-expand-leave-from { max-height: 500px; }
</style>
