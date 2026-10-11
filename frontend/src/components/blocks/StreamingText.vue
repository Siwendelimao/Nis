<script setup lang="ts">
import { ref, computed, onUnmounted, watch } from 'vue'

const props = defineProps<{
  text: string | string[]
  fixedWidth?: boolean
  repeat?: boolean
  repeatDelay?: number
  active?: boolean
}>()

const textArray = computed(() => Array.isArray(props.text) ? props.text : [props.text])
const currentIndex = ref(0)
const displayTokens = ref<string[]>([])
const currentTokenIndex = ref(0)
const timer = ref<ReturnType<typeof setTimeout> | null>(null)

const currentFullText = computed(() => textArray.value[currentIndex.value] || '')
// 中文按字、英文按词、空白单独成 token → 流式逐个出现
const tokens = computed<string[]>(() => {
  const text = currentFullText.value
  const out: string[] = []
  let buf = ''
  for (const ch of text) {
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

const maxWidth = computed(() => {
  if (!props.fixedWidth) return 'auto'
  const longest = textArray.value.reduce((a, b) => a.length >= b.length ? a : b, '')
  return `${longest.length * 0.6}em`
})

const colorPalettes = [
  'linear-gradient(90deg, transparent 0%, #6366f1 30%, #6366f1 70%, transparent 100%)',
  'linear-gradient(90deg, transparent 0%, #ec4899 30%, #ec4899 70%, transparent 100%)',
  'linear-gradient(90deg, transparent 0%, #06b6d4 30%, #06b6d4 70%, transparent 100%)',
  'linear-gradient(90deg, transparent 0%, #f59e0b 30%, #f59e0b 70%, transparent 100%)',
  'linear-gradient(90deg, transparent 0%, #10b981 30%, #10b981 70%, transparent 100%)',
  'linear-gradient(90deg, transparent 0%, #8b5cf6 30%, #8b5cf6 70%, transparent 100%)',
]

function getWordColorStyle(index: number): Record<string, string> {
  const gradient = colorPalettes[index % colorPalettes.length]
  return {
    backgroundImage: gradient,
    backgroundSize: '300% 100%',
    backgroundPosition: '150% 0',
    WebkitBackgroundClip: 'text',
    backgroundClip: 'text',
    color: 'transparent',
    animation: `colorSweep 0.6s cubic-bezier(0.2, 0.8, 0.2, 1) ${index * 0.05}s both, wordBlur 0.4s cubic-bezier(0.2, 0.8, 0.2, 1) ${index * 0.05}s both`
  }
}

function revealNext() {
  if (currentTokenIndex.value < tokens.value.length) {
    displayTokens.value.push(tokens.value[currentTokenIndex.value])
    currentTokenIndex.value++
    timer.value = setTimeout(revealNext, 55)
  } else if (props.repeat) {
    timer.value = setTimeout(nextCycle, (props.repeatDelay || 0.5) * 1000)
  }
}

function nextCycle() {
  currentIndex.value = (currentIndex.value + 1) % textArray.value.length
  displayTokens.value = []
  currentTokenIndex.value = 0
  timer.value = setTimeout(revealNext, 100)
}

watch(() => props.active, (val) => {
  if (val) {
    displayTokens.value = []
    currentTokenIndex.value = 0
    currentIndex.value = 0
    if (timer.value) clearTimeout(timer.value)
    timer.value = setTimeout(revealNext, 100)
  }
}, { immediate: true })

onUnmounted(() => {
  if (timer.value) clearTimeout(timer.value)
})
</script>

<template>
  <span class="inline-block" :style="{ minWidth: fixedWidth ? maxWidth : 'auto' }">
    <span
      v-for="(token, i) in displayTokens"
      :key="`${currentIndex}-${i}`"
      :class="/\S/.test(token) && i >= displayTokens.length - 3 ? 'word-reveal' : ''"
      :style="/\S/.test(token) && i >= displayTokens.length - 3 ? getWordColorStyle(displayTokens.length - 1 - i) : {}"
    >{{ token }}</span>
    <span
      v-if="displayTokens.length < tokens.length || (repeat && displayTokens.length === tokens.length)"
      class="word-cursor"
    />
  </span>
</template>

<style scoped>
@keyframes colorSweep {
  0% {
    background-position: 150% 0;
    color: transparent;
  }
  40% {
    background-position: 50% 0;
    color: transparent;
  }
  100% {
    background-position: -50% 0;
    color: currentColor;
    -webkit-text-fill-color: currentColor;
  }
}

@keyframes wordBlur {
  from {
    filter: blur(3px);
  }
  to {
    filter: blur(0);
  }
}

.word-cursor {
  display: inline-block;
  width: 2px;
  height: 1em;
  background: currentColor;
  margin-left: 1px;
  animation: blink 0.8s infinite;
  vertical-align: text-bottom;
}

@keyframes blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0; }
}
</style>
