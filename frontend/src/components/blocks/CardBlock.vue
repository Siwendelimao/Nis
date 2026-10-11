<script setup lang="ts">
defineProps<{ content: string; title?: string }>()
</script>
<template>
  <div class="my-2 rounded-lg border border-indigo-200 bg-indigo-50/50 p-4">
    <div v-if="title" class="text-sm font-medium text-indigo-700 mb-1">{{ title }}</div>
    <div class="text-sm text-gray-700">{{ content }}</div>
  </div>
</template>
