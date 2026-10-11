<script setup lang="ts">
/**
 * MermaidBlock —— 0923：聊天消息的 mermaid 图表渲染。
 * 背景：mermaid 渲染能力此前只有文件预览库（@open-file-viewer）接了，聊天管线
 * （MarkdownText/MdNode 自研）里 ```mermaid 代码块只能显示源码。
 * 保护（与 OFV 同口径）：懒加载 / securityLevel strict / 5 万字符闸门 /
 * 渲染失败回退源码显示，绝不白屏。流式期间 lang 被强制 undefined，天然不走本组件。
 */
import { ref, onMounted, watch } from 'vue'
import CodeBlock from './CodeBlock.vue'

const props = defineProps<{ code: string }>()

const svgHtml = ref('')
const state = ref<'loading' | 'done' | 'fallback'>('loading')
const MAX_CHARS = 50_000

async function render() {
  const code = String(props.code || '').trim()
  if (!code || code.length > MAX_CHARS) {
    state.value = 'fallback'
    return
  }
  try {
    const mermaid = (await import('mermaid')).default
    /* ★0930 修（深色模式图里部分文字看不清）：theme 必须跟随 app 主题 —— default 主题是黑字，
       容器 bg-white 又被 style.css 的深色映射染成近黑底 ⇒ 黑字配黑底看不清；
       部分继承 currentColor 的文字被全局文字色染白、部分显式黑字不变 ⇒"部分文字"对比度不足。
       与 mermaidRender.ts（v-html 路径）同口径。 */
    const isDark = typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: isDark ? 'dark' : 'default',
      htmlLabels: false,
      flowchart: { htmlLabels: false },
    })
    const id = 'nis-mermaid-' + Math.random().toString(36).slice(2, 10)
    const { svg } = await mermaid.render(id, code)
    svgHtml.value = svg
    state.value = 'done'
  } catch (e) {
    console.warn('[mermaid] render failed:', e)
    svgHtml.value = ''
    state.value = 'fallback'
  }
}

onMounted(render)
watch(() => props.code, render)
</script>

<template>
  <div v-if="state === 'done'" class="my-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-4 overflow-x-auto" v-html="svgHtml"></div>
  <div v-else-if="state === 'fallback'">
    <div class="my-1.5 text-xs text-amber-600">⚠ 图表语法无法渲染，已回退显示源码</div>
    <CodeBlock :content="code" language="mermaid" />
  </div>
  <div v-else class="my-2 text-sm text-gray-400">图表渲染中…</div>
</template>
