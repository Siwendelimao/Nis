<script setup lang="ts">
import StreamingTail from './StreamingTail.vue'

defineProps<{ content: string; streaming?: boolean }>()
</script>
<template>
  <p class="msg-body text-[14px] leading-normal whitespace-pre-wrap">
    <StreamingTail v-if="streaming" :text="content" />
    <template v-else>{{ content }}</template>
  </p>
</template>
<style scoped>
/* 正文黑色 + 字重 400（与 MarkdownText/PiChatView 一致；Inter 可变字体下 350 会真实渲染过细） */
.msg-body {
  color: #15151a;
  font-weight: 400;
}
</style>
