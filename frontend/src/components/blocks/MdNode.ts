/**
 * MdNode —— 递归渲染 mdast 节点 → Vue 元素（dsh render.tsx 的 Vue 等价）
 * 组件内通过闭包自引用实现递归（模块加载完成后 const 已初始化，setup 运行时安全）
 */
import { defineComponent, h } from 'vue'
import type { RootContent } from 'mdast'
import CodeBlock from './CodeBlock.vue'
import DiffBlock from './DiffBlock.vue'
import ImageBlock from './ImageBlock.vue'
import MermaidBlock from './MermaidBlock.vue'
import MathBlock from './MathBlock.vue'
import { useChatStore } from '@/stores/chat'
import { useConversationsStore } from '@/stores/conversations'
import { metaOf } from '@/utils/fileMeta'

/** ★1012：判定「本地绝对文件路径」（正文里的文件 chip 用）。
 *  刻意保守：只认盘符（`D:\`）或 UNC（`\\server\share`）开头、且以「文件名.扩展名」结尾的整串。
 *  这样 `package.json` / `index.html` / `npm run dev` 这类相对名或命令不会被误判成可点路径；
 *  流式渲染时半截路径（扩展名还没写完）也不会命中。 */
function isLocalFilePath(v: string): boolean {
  const s = v.trim()
  if (s.length < 6 || s.length > 260) return false
  if (/[\n\r\t]/.test(s)) return false
  const abs = /^[a-zA-Z]:[\\/]/.test(s) || /^\\\\[^\\/]+[\\/]/.test(s)
  if (!abs) return false
  return /[\\/][^\\/]+\.[A-Za-z0-9]{1,8}$/.test(s)
}

export const MdNode = defineComponent({
  name: 'MdNode',
  props: {
    node: { type: Object as () => RootContent, required: true },
    streaming: { type: Boolean, default: false },
  },
  setup(props) {
    const chat = useChatStore()
    const conversationsStore = useConversationsStore()
    const children = (nodes: readonly RootContent[] | undefined) =>
      (nodes || []).map((n, i) => h(MdNode, { key: i, node: n, streaming: props.streaming }))

    /** ★1012：点正文里的文件 chip → 在系统资源管理器中打开所在目录并选中该文件。
     *  复用后端 fs.reveal（与工具块 chip / 产出物同一条链路）。
     *  ⚠️ 会话 id 必须取**当前活跃会话**（口径同 ToolPartBlock 的 popupConvId = conversationsStore.activeConversationId）。
     *     别用 window.__nisActiveSessionId —— 那个全局变量全项目只有"读"没有"写"，永远是空的，
     *     后端 fs.reveal 第一行就会抛 'sessionId required'（1012 实测踩过这个坑）。 */
    async function revealFile(p: string) {
      const sid = String(conversationsStore.activeConversationId ?? '')
      if (!sid) {
        console.warn('[MdNode] 当前没有活跃会话，无法定位文件：', p)
        return
      }
      try {
        await chat.bridgeRpc('fs.reveal', { sessionId: sid, path: p })
      } catch (e) {
        console.error('[MdNode] 打开文件所在目录失败:', e)
      }
    }

    /** ★1012：渲染「可点文件 chip」——行内代码与"单行围栏代码块"共用同一份结构/行为。 */
    function renderFileChip(p: string, extraClass = '') {
      const meta = metaOf(p)
      return h('code', {
        class: ['dsh-md-code', 'dsh-md-code--file', extraClass],
        title: '点击打开所在目录：' + p,
        onClick: (e: MouseEvent) => { e.stopPropagation(); void revealFile(p) },
      }, [
        h('i', { class: [meta.icon, meta.color], 'aria-hidden': 'true' }),
        /* ★1012：显示**完整路径**（不是只显示文件名）——路径本来就是用户要复制/核对的东西，
           换成 basename 会让人没法复制；这里只做"加图标 + 可点"，不缩减内容。 */
        h('span', { class: 'pfc-name' }, p),
      ])
    }

    return () => {
      const n = props.node as any
      if (!n) return null
      switch (n.type) {
        case 'text':
          // 文本叶子节点（段落/列表/表格的正文都在这）；
          // 兼容 AI 常用非标准语法：==高亮== / ~下标~ / ^上标^
          return renderInlineText(n.value)
        case 'paragraph':
          return h('p', { class: 'dsh-md-p' }, children(n.children))
        case 'heading':
          return h(`h${n.depth}`, { class: `dsh-md-h dsh-md-h${n.depth}` }, children(n.children))
        case 'blockquote':
          return h('blockquote', { class: 'dsh-md-bq' }, children(n.children))
        case 'thematicBreak':
          return h('hr', { class: 'dsh-md-hr' })
        case 'break':
          return h('br')
        case 'strong':
          return h('strong', { class: 'dsh-md-strong' }, children(n.children))
        case 'emphasis':
          return h('em', { class: 'dsh-md-em' }, children(n.children))
        case 'delete':
          return h('del', { class: 'dsh-md-del' }, children(n.children))
        case 'inlineCode': {
          const value = n.value.replace(/\r?\n|\r/g, ' ')
          /* ★1012（老大需求）：正文里的本地文件路径 → 可点击 chip，
             点击直接在资源管理器打开所在目录并选中该文件。只认绝对路径，不误伤普通行内代码。 */
          if (isLocalFilePath(value)) return renderFileChip(value)
          return h('code', { class: 'dsh-md-code' }, value)
        }
        case 'html':
          // raw HTML 一律字面文本（安全）
          return n.value
        case 'code': {
          /* ★1012（老大实测反馈·上一版的漏网情况）：AI 常把"单个文件路径"放进**围栏代码块**（方便复制），
             用户看到的就是一个带 code 标签的块 —— 这种「整块内容恰好是一条本地绝对路径」也渲染成可点 chip。
             三道约束，宁可不转也别误伤：① 仅定稿后（非流式，避免半截内容反复变身）
             ② 无语言标注（```powershell 之类是命令，别动）③ 整体就是一个路径（多行/含其它内容一律不动）。 */
          const codeRaw = String(n.value ?? '').trim()
          /* 语言判定放宽一点：无标注，或标注只是 code / text / txt（有些客户端习惯这么写）都算"纯路径块"；
             ```powershell / ```bash 这类明确的命令块一律不动。 */
          const rawLang = String(n.lang ?? '').trim().toLowerCase()
          const langIsPlain = !rawLang || rawLang === 'code' || rawLang === 'text' || rawLang === 'txt'
          if (!props.streaming && langIsPlain && isLocalFilePath(codeRaw)) {
            return renderFileChip(codeRaw, 'dsh-md-code--file-block')
          }
          const lang = props.streaming ? undefined : (n.lang ?? undefined)
          // ★ 0923：mermaid 图表渲染（此前只有文件预览库接了 mermaid，聊天里只显示源码）
          if (lang === 'mermaid') {
            return h(MermaidBlock, { code: n.value })
          }
          if (looksLikeDiff(n.value, lang)) {
            return h(DiffBlock, { content: n.value, title: diffTitle(lang) })
          }
          return h(CodeBlock, { content: n.value, language: lang })
        }
        case 'list':
          return h(
            n.ordered ? 'ol' : 'ul',
            { class: 'dsh-md-list', start: typeof n.start === 'number' && n.start !== 1 ? n.start : undefined },
            (n.children || []).map((item: any, _i: number) => {
              const entries = (item.children || []).map((c: any, j: number) => h(MdNode, { key: j, node: c, streaming: props.streaming }))
              if (typeof item.checked === 'boolean') {
                return h('li', { class: 'dsh-md-li dsh-md-task' }, [
                  h('input', { type: 'checkbox', checked: item.checked, disabled: true, class: 'dsh-md-checkbox' }),
                  ...entries,
                ])
              }
              return h('li', { class: 'dsh-md-li' }, entries)
            }),
          )
        case 'table': {
          const align = n.align ?? null
          const [headRow, ...bodyRows] = n.children || []
          return h('div', { class: 'dsh-md-table-wrap' }, [
            h('table', { class: 'dsh-md-table' }, [
              headRow ? h('thead', {}, [renderRow(headRow, 'th', align, props.streaming)]) : null,
              bodyRows.length > 0 ? h('tbody', {}, bodyRows.map((r: any, i: number) => renderRow(r, 'td', align, props.streaming, i))) : null,
            ]),
          ])
        }
        case 'link': {
          const safe = sanitizeUrl(n.url)
          if (!safe) return children(n.children)
          const external = /^https?:/i.test(safe)
          return h('a', { href: safe, class: 'dsh-md-link', ...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {}) }, children(n.children))
        }
        case 'image': {
          const src = remoteImageUrl(n.url)
          if (!src) return h('span', { class: 'dsh-md-imgalt' }, n.alt ?? '')
          // ImageBlock：点击放大查看器（抓手拖动/缩放/还原/右侧预览 tab），与旧版一致
          return h(ImageBlock, { src, alt: n.alt ?? '', content: '' })
        }
        case 'math':
          // ★ 0923：KaTeX 渲染（此前显示源码）
          return h(MathBlock, { tex: n.value, display: true })
        case 'inlineMath':
          // ★ 0923：KaTeX 行内渲染（此前显示源码）
          return h(MathBlock, { tex: n.value, display: false })
        case 'footnoteReference':
          return h('sup', { class: 'dsh-md-footnote-ref' }, String((n.identifier || '').length))
        default:
          return null
      }
    }
  },
})

/**
 * diff 块识别：标注语言为 diff/patch，或内容具备 unified diff 特征
 * （流式阶段语言未知，靠内容特征识别；定稿后优先按语言）
 */
function looksLikeDiff(value: string, lang?: string): boolean {
  if (!value) return false
  if (lang && /^(diff|patch)$/i.test(lang)) return true
  const lines = value.trimEnd().split('\n')
  let markers = 0
  for (const line of lines.slice(0, 12)) {
    if (/^(---|\+\+\+|@@ -|diff --git)/.test(line)) markers++
  }
  return markers >= 2 || /^\*\*\* Begin Patch/.test(lines[0] || '')
}

/** 从 diff 内容推断标题（文件名），无则用默认 */
function diffTitle(lang?: string): string | undefined {
  return lang && !/^(diff|patch)$/i.test(lang) ? undefined : '代码变更'
}

/**
 * 行内文本渲染：兼容 AI 常用非标准语法
 *  ==高亮== → <mark>   ~下标~ → <sub>   ^上标^ → <sup>
 * 无这些语法时返回纯字符串（轻量，避免无谓的 span 包裹）
 */
function renderInlineText(value: string) {
  const parts: Array<{ tag: string; text: string } | string> = []
  const re = /(==[^=\n]+==|~[^~\n]+~|\^[^^\n]+\^)/g
  let last = 0
  let m: RegExpExecArray | null
  let hasSpecial = false
  while ((m = re.exec(value)) !== null) {
    hasSpecial = true
    if (m.index > last) parts.push(value.slice(last, m.index))
    const tok = m[0]
    if (tok.startsWith('==')) parts.push({ tag: 'mark', text: tok.slice(2, -2) })
    else if (tok.startsWith('~')) parts.push({ tag: 'sub', text: tok.slice(1, -1) })
    else parts.push({ tag: 'sup', text: tok.slice(1, -1) })
    last = m.index + tok.length
  }
  if (!hasSpecial) return value
  if (last < value.length) parts.push(value.slice(last))
  return h('span', {}, parts.map((p, i) =>
    typeof p === 'string' ? p : h(p.tag, { key: i, class: `dsh-md-${p.tag}` }, p.text),
  ))
}

function renderRow(row: any, tag: 'th' | 'td', align: readonly (string | null)[] | null, streaming: boolean, key = 0) {  const length = align === null ? row.children.length : align.length
  const cells = []
  for (let i = 0; i < length; i++) {
    const cell = row.children[i]
    const alignValue = align?.[i]
    cells.push(h(tag, { key: i, style: alignValue == null ? undefined : { textAlign: alignValue } }, cell ? cell.children.map((c: any, j: number) => h(MdNode, { key: j, node: c, streaming })) : []))
  }
  return h('tr', { key }, cells)
}

function sanitizeUrl(url: string): string {
  try {
    switch (new URL(url).protocol) {
      case 'http:':
      case 'https:':
      case 'mailto:':
        return url
      default:
        return ''
    }
  } catch {
    return ''
  }
}

function remoteImageUrl(url: string): string | undefined {
  try {
    const protocol = new URL(url).protocol
    return protocol === 'http:' || protocol === 'https:' ? url : undefined
  } catch {
    return undefined
  }
}
