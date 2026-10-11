<script setup lang="ts">
defineProps<{
  modelValue: string
  options: string[]
  /** 可选显示文案（与 options 对齐）：store 存中文值但界面需翻译时用（0906 多语言） */
  labels?: string[]
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()
</script>

<template>
  <div class="inline-flex items-center bg-gray-100 rounded-lg p-0.5">
    <button
      v-for="(opt, oi) in options"
      :key="opt"
      type="button"
      @click="emit('update:modelValue', opt)"
      :class="[
        'px-3 py-1 rounded-md text-[11px] font-medium transition-colors duration-150 whitespace-nowrap cursor-pointer',
        modelValue === opt
          ? 'bg-black text-white shadow-sm'
          : 'text-gray-500 hover:text-gray-800',
      ]"
    >{{ labels?.[oi] ?? opt }}</button>
  </div>
</template>
