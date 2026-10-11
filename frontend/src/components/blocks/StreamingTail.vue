<script setup lang="ts">
import { ref, computed, watch } from 'vue'

/**
 * 真流式渲染：整段已收文本立即显示（AI 吐多少渲染多少），
 * 仅对"新到达的尾部"做彩色 word-reveal（每词/字循环取色 + 扫描 + 模糊聚焦），
 * 不是固定速度重放——颜色只落在正在增长的新文字上，随后自然恢复正文色。
 */
const props = defineProps<{ text: string }>()

const prevLen = ref(props.text?.length || 0)
const tail = ref('')
const tailKey = ref(0)

watch(
  () => props.text,
  (val) => {
    const full = val || ''
    if (full.length >= prevLen.value) {
      tail.value = full.slice(prevLen.value)
    } else {
      tail.value = full
    }
    prevLen.value = full.length
    tailKey.value += 1
  },
  { immediate: true },
)

// 把尾部新到文本拆成 token（中文逐字 / 英文逐词 / 空白单独成 token），逐个上色
const tailTokens = computed<string[]>(() => {
  const t = tail.value
  const out: string[] = []
  let buf = ''
  for (const ch of t) {
    if (/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch)) {
      if (buf) { out.push(buf); buf = '' }
      out.push(ch)
    } else if (/\s/.test(ch)) {
      if (buf) { out.push(buf); buf = '' }
      out.push(ch)
    } else {
      buf += ch
    }
  }
  if (buf) out.push(buf)
  return out
})

const palettes = [
  'linear-gradient(90deg, transparent 0%, #6366f1 30%, #6366f1 70%, transparent 100%)',
  'linear-gradient(90deg, transparent 0%, #ec4899 30%, #ec4899 70%, transparent 100%)',
  'linear-gradient(90deg, transparent 0%, #06b6d4 30%, #06b6d4 70%, transparent 100%)',
  'linear-gradient(90deg, transparent 0%, #f59e0b 30%, #f59e0b 70%, transparent 100%)',
  'linear-gradient(90deg, transparent 0%, #10b981 30%, #10b981 70%, transparent 100%)',
  'linear-gradient(90deg, transparent 0%, #8b5cf6 30%, #8b5cf6 70%, transparent 100%)',
]

function wordStyle(index: number): Record<string, string> {
  const gradient = palettes[index % palettes.length]
  return {
    backgroundImage: gradient,
    backgroundSize: '300% 100%',
    backgroundPosition: '150% 0',
    WebkitBackgroundClip: 'text',
    backgroundClip: 'text',
    color: 'transparent',
    animation: `tailSweep 0.55s cubic-bezier(0.2, 0.8, 0.2, 1) ${index * 0.03}s both, tailBlur 0.4s cubic-bezier(0.2, 0.8, 0.2, 1) ${index * 0.03}s both`,
  }
}
</script>

<template>
  <span class="inline-block whitespace-pre-wrap break-words">
    <span>{{ (text || '').slice(0, prevLen - tail.length) }}</span>
    <span v-if="tail" :key="tailKey" class="inline">
      <span v-for="(tok, i) in tailTokens" :key="i" :style="/\S/.test(tok) ? wordStyle(i) : {}">{{ tok }}</span>
    </span>
  </span>
</template>

<style scoped>
@keyframes tailSweep {
  0% {
    background-position: 150% 0;
    color: transparent;
  }
  100% {
    background-position: -50% 0;
    color: currentColor;
    -webkit-text-fill-color: currentColor;
  }
}

@keyframes tailBlur {
  from {
    filter: blur(2px);
  }
  to {
    filter: blur(0);
  }
}
</style>
