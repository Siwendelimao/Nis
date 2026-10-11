<script setup lang="ts">
const props = defineProps<{
  modelValue: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
}>()

function onClick() {
  emit('update:modelValue', !props.modelValue)
}
</script>

<template>
  <button
    type="button"
    role="switch"
    :aria-checked="modelValue"
    @click="onClick"
    :class="[
      'relative w-9 h-[18px] rounded-full transition-colors duration-200 flex-shrink-0 cursor-pointer',
      modelValue ? 'bg-black' : 'bg-gray-300',
    ]"
  >
    <span
      :class="[
        'absolute top-[2px] w-[14px] h-[14px] rounded-full bg-white shadow transition-all duration-200',
        modelValue ? 'left-[20px]' : 'left-[2px]',
      ]"
    ></span>
  </button>
</template>
