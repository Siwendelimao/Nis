/**
 * mermaidRender —— 0923：给 v-html 字符串渲染路径（MarkdownBlock 旧 blocks 数据）用的
 * mermaid 后处理工具。组件路径（MdNode/MarkdownText）走 MermaidBlock.vue，不走这里。
 * 口径与 MermaidBlock.vue 一致：懒加载 / strict / 5 万字符闸门 / 失败回退源码。
 * 槽位用 data-mmd-idx 索引 + 外部 sources 数组取源码（避免属性值引号转义坑）。
 */
import { renderFenceFallback } from './markdownFence'

let mermaidPromise: Promise<typeof import('mermaid').default> | null = null

function loadMermaid() {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then((m) => {
      /* ★0929 深色模式修复：theme 跟随 app 主题——default 主题黑字在深色模式被全局
         文字色染白 → 白底白字看不清。容器底色见 renderMermaidSlots 的 class。 */
      const isDark = typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
      m.default.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: isDark ? 'dark' : 'default',
        htmlLabels: false,
        flowchart: { htmlLabels: false },
      })
      return m.default
    })
  }
  return mermaidPromise
}

const MAX_CHARS = 50_000

/** 把 root 下所有 .nis-mmd-slot 槽位渲染成 SVG；失败/超长回退源码代码块 */
export async function renderMermaidSlots(root: HTMLElement | null | undefined, sources: string[]): Promise<void> {
  if (!root) return
  const slots = Array.from(root.querySelectorAll<HTMLElement>('.nis-mmd-slot'))
  if (slots.length === 0) return
  const mermaid = await loadMermaid().catch((e) => {
    console.warn('[mermaid] load failed:', e)
    return null
  })
  for (const slot of slots) {
    const idx = Number(slot.getAttribute('data-mmd-idx') || '-1')
    const code = sources[idx] ?? ''
    if (!mermaid || !code.trim() || code.length > MAX_CHARS) {
      slot.outerHTML = renderFenceFallback(code, 'mermaid')
      continue
    }
    try {
      const id = 'nis-mermaid-' + Math.random().toString(36).slice(2, 10)
      const { svg } = await mermaid.render(id, code)
      const wrap = document.createElement('div')
      wrap.className = 'my-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-4 overflow-x-auto'
      wrap.innerHTML = svg
      slot.replaceWith(wrap)
    } catch (e) {
      console.warn('[mermaid] render failed:', e)
      slot.outerHTML = renderFenceFallback(code, 'mermaid')
    }
  }
}
