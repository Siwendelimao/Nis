/** markdownFence —— 0923：代码围栏 HTML 兜底渲染（v-html 路径与组件兜底共用，避免两处漂移） */

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** 源码兜底代码块（mermaid 渲染失败/超长时用） */
export function renderFenceFallback(code: string, lang: string): string {
  return `<div class="my-1.5 text-xs text-amber-600">⚠ 图表语法无法渲染，已回退显示源码</div>` +
    `<div class="my-2 rounded-lg overflow-hidden border border-gray-200"><div class="flex items-center justify-between px-4 py-2 bg-gray-800 text-gray-300 text-xs"><span class="font-mono">${escapeHtml(lang)}</span></div><pre class="p-4 bg-gray-900 text-gray-100 text-sm font-mono overflow-x-auto leading-relaxed"><code>${escapeHtml(code)}</code></pre></div>`
}
