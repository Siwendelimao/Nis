<script setup lang="ts">
import { computed } from 'vue'
import { t } from '@/utils/i18n'

const props = defineProps<{ content: string }>()

const nodes = computed(() => props.content.trim().split('\n').filter(l => l.trim()))
</script>
<template>
  <div class="my-2 rounded-lg border border-gray-200 bg-gray-50 p-4">
    <div class="flex items-center gap-2 mb-3">
      <i class="fas fa-project-diagram text-indigo-500"></i>
      <span class="text-xs font-medium text-gray-500">{{ t('dag.title') }}</span>
    </div>
    <div class="flex items-center gap-2 flex-wrap">
      <template v-for="(node, i) in nodes" :key="i">
        <div class="flex items-center gap-2">
          <div class="px-3 py-1.5 bg-indigo-100 text-indigo-700 rounded-lg text-xs font-medium border border-indigo-200">{{ node.trim() }}</div>
          <i v-if="i < nodes.length - 1" class="fas fa-arrow-right text-gray-300 text-xs"></i>
        </div>
      </template>
    </div>
  </div>
</template>
