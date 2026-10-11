<script setup lang="ts">
defineProps<{ content: string }>()
</script>
<template>
  <div class="my-2 rounded-lg border-l-4 border-blue-400 bg-blue-50 px-4 py-3 text-sm text-gray-700 italic">
    {{ content }}
  </div>
</template>
