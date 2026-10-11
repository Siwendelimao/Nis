<script setup lang="ts">
/**
 * MathBlock —— 0923：KaTeX 公式渲染（MdNode 此前注释"后续可加"、一直显示源码）。
 * 块级/行内二合一；throwOnError:false + strict:false —— 局部语法问题不炸整条消息；
 * 整体失败回退源码文本。math 节点只在定稿解析（parseGfmWithMath）出现，流式天然不触发。
 */
import { ref, onMounted, watch } from 'vue'

const props = defineProps<{ tex: string; display?: boolean }>()

const html = ref('')

async function render() {
  const tex = String(props.tex || '')
  if (!tex.trim()) {
    html.value = ''
    return
  }
  try {
    const katex = (await import('katex')).default
    await import('katex/dist/katex.min.css')
    html.value = katex.renderToString(tex, {
      throwOnError: false,
      displayMode: !!props.display,
      output: 'html',
      strict: false,
      trust: false,
    })
  } catch (e) {
    console.warn('[katex] render failed:', e)
    html.value = ''
  }
}

onMounted(render)
watch(() => props.tex, render)
</script>

<template>
  <span v-if="html" :class="display ? 'block my-2 overflow-x-auto' : 'inline'" v-html="html"></span>
  <code v-else class="dsh-md-code">{{ display ? '$$' + tex + '$$' : '$' + tex + '$' }}</code>
</template>
