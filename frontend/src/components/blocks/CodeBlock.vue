<script setup lang="ts">
/**
 * CodeBlock —— 0923：接 Prism 语法高亮（此前纯文本零高亮，而 prism 语言包早随
 * @open-file-viewer 打进产物，聊天管线没用上）。
 * 策略：懒加载 prism 核心 + 按需懒加载语言包（显式映射，禁动态变量路径防 Vite 构建炸）；
 * 别名归一；超长代码（>2 万字符）/ 未装语言 / 渲染失败 = 无高亮纯文本兜底，绝不报错。
 */
import { ref, onMounted, watch } from 'vue'
import { t } from '@/utils/i18n'

const props = defineProps<{ content: string; language?: string }>()

const copied = ref(false)
const html = ref('')

function copy() {
  navigator.clipboard.writeText(props.content)
  copied.value = true
  setTimeout(() => { copied.value = false }, 2000)
}

/** AI 常用叫法 → prism 语言键 */
const ALIAS: Record<string, string> = {
  js: 'javascript', jsx: 'jsx', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript', tsx: 'tsx', mts: 'typescript',
  sh: 'bash', zsh: 'bash', shell: 'bash', console: 'bash',
  yml: 'yaml', md: 'markdown', markdown: 'markdown',
 htm: 'markup', html: 'markup', xml: 'markup', vue: 'markup', svelte: 'markup',
  py: 'python', rb: 'ruby', golang: 'go', 'c++': 'cpp', 'c#': 'csharp', cs: 'csharp',
  dockerfile: 'docker', plaintext: 'text', txt: 'text', text: 'text',
}

/** 按需懒加载的语言包（显式映射；不在表内的语言走"无高亮"兜底） */
const LANG_LOADERS: Record<string, () => Promise<unknown>> = {
  javascript: () => import('prismjs/components/prism-javascript'),
  typescript: () => import('prismjs/components/prism-typescript'),
  jsx: () => import('prismjs/components/prism-jsx'),
  tsx: () => import('prismjs/components/prism-tsx'),
  python: () => import('prismjs/components/prism-python'),
  json: () => import('prismjs/components/prism-json'),
  bash: () => import('prismjs/components/prism-bash'),
  sql: () => import('prismjs/components/prism-sql'),
  go: () => import('prismjs/components/prism-go'),
  rust: () => import('prismjs/components/prism-rust'),
  java: () => import('prismjs/components/prism-java'),
  yaml: () => import('prismjs/components/prism-yaml'),
  toml: () => import('prismjs/components/prism-toml'),
  css: () => import('prismjs/components/prism-css'),
  scss: () => import('prismjs/components/prism-scss'),
  less: () => import('prismjs/components/prism-less'),
  markup: () => import('prismjs/components/prism-markup'),
  markdown: () => import('prismjs/components/prism-markdown'),
  docker: () => import('prismjs/components/prism-docker'),
  diff: () => import('prismjs/components/prism-diff'),
  powershell: () => import('prismjs/components/prism-powershell'),
  ini: () => import('prismjs/components/prism-ini'),
  makefile: () => import('prismjs/components/prism-makefile'),
  graphql: () => import('prismjs/components/prism-graphql'),
  http: () => import('prismjs/components/prism-http'),
  lua: () => import('prismjs/components/prism-lua'),
  ruby: () => import('prismjs/components/prism-ruby'),
  php: () => import('prismjs/components/prism-php'),
  c: () => import('prismjs/components/prism-c'),
  cpp: () => import('prismjs/components/prism-cpp'),
  csharp: () => import('prismjs/components/prism-csharp'),
  kotlin: () => import('prismjs/components/prism-kotlin'),
  swift: () => import('prismjs/components/prism-swift'),
}

const MAX_CHARS = 20_000
let themeLoaded = false

async function highlight() {
  html.value = ''
  const raw = String(props.language || '').toLowerCase().trim()
  if (!raw || raw === 'code' || raw === 'mermaid' || raw === 'diff') return
  if (props.content.length > MAX_CHARS) return
  const key = ALIAS[raw] || raw
  try {
    const Prism = (await import('prismjs')).default
    const loader = LANG_LOADERS[key]
    if (loader) await loader()
    const grammar = (Prism.languages as Record<string, unknown>)[key]
    if (!grammar) return
    if (!themeLoaded) {
      themeLoaded = true
      await import('prismjs/themes/prism-tomorrow.css')
    }
    html.value = Prism.highlight(props.content, grammar as any, key)
  } catch (e) {
    console.warn('[prism] highlight failed:', e)
    html.value = ''
  }
}

onMounted(highlight)
watch(() => [props.content, props.language], highlight)
</script>

<template>
  <div class="my-2 rounded-lg overflow-hidden border border-gray-200">
    <div class="flex items-center justify-between px-4 py-2 bg-gray-800 text-gray-300 text-xs">
      <span class="font-mono">{{ language || 'code' }}</span>
      <button @click="copy" class="hover:text-white transition-colors flex items-center gap-1">
        <i :class="copied ? 'fas fa-check text-green-400' : 'far fa-copy'"></i>
        {{ copied ? t('code.copied') : t('chat.copy') }}
      </button>
    </div>
    <pre class="p-4 bg-gray-900 text-gray-100 text-sm font-mono overflow-x-auto leading-relaxed"><code v-if="html" v-html="html"></code><code v-else>{{ content }}</code></pre>
  </div>
</template>
