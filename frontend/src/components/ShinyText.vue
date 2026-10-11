<script setup lang="ts">
const props = defineProps<{
  text: string;
  disabled?: boolean;
  speed?: number;
  className?: string;
  color?: string;
}>()
</script>

<template>
  <span :class="className">{{ props.text }}</span>
</template>
