import { reactive } from 'vue'
import type { ContextMenuItem } from '@/components/ContextMenu.vue'
import { t } from '@/utils/i18n'

type CtxKey = string
type CtxBuilder = (el: HTMLElement, e: MouseEvent) => void

const state = reactive<{
  visible: boolean
  x: number
  y: number
  items: ContextMenuItem[]
}>({
  visible: false,
  x: 0,
  y: 0,
  items: [],
})

const registry = new Map<CtxKey, CtxBuilder>()

let installed = false

/** 在光标处插入文本并派发 input 事件（让 Vue v-model 感知） */
function insertAtCursor(el: Element, text: string) {
  const inputEl = el as HTMLInputElement & HTMLTextAreaElement
  inputEl.focus()
  if (typeof inputEl.setRangeText === 'function') {
    const start = inputEl.selectionStart ?? inputEl.value.length
    const end = inputEl.selectionEnd ?? inputEl.value.length
    inputEl.setRangeText(text, start, end, 'end')
    inputEl.dispatchEvent(new Event('input', { bubbles: true }))
    return
  }
  const sel = window.getSelection()
  if (sel && sel.rangeCount) {
    const range = sel.getRangeAt(0)
    range.deleteContents()
    const node = document.createTextNode(text)
    range.insertNode(node)
    range.setStartAfter(node)
    range.collapse(true)
    sel.removeAllRanges()
    sel.addRange(range)
  } else {
    el.textContent = (el.textContent || '') + text
  }
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

/** 输入/可编辑区右键菜单：复制/粘贴/剪切/全选 */
async function execEditableCmd(cmd: 'copy' | 'cut' | 'paste' | 'selectAll', el: Element) {
  const inputEl = el as HTMLInputElement & HTMLTextAreaElement
  inputEl.focus()
  if (cmd === 'selectAll') {
    if (typeof inputEl.select === 'function') {
      inputEl.select()
    } else {
      const range = document.createRange()
      range.selectNodeContents(inputEl)
      const sel = window.getSelection()
      if (sel) {
        sel.removeAllRanges()
        sel.addRange(range)
      }
    }
    return
  }
  if (cmd === 'paste') {
    /* ★1012 修（实测反馈：右键「粘贴」粘不上图片，Ctrl+V 却可以）：
       原实现只调 readText() —— **只有文本**，图片天然拿不到。
       现在先用 read() 读**全部类型**（文本/图片），把内容塞进一个合成的 paste 事件派发给输入框，
       ⇒ 复用各输入框自己的粘贴逻辑（ChatInput 的图片/标签/纯文本分支都在那儿），行为与 Ctrl+V 一致。
       权限被拒或剪贴板里没有可读项时，退回原来的文本路径。 */
    try {
      const items = await navigator.clipboard.read()
      const dt = new DataTransfer()
      let n = 0
      for (const it of items) {
        for (const type of it.types) {
          if (!(type.startsWith('image/') || type === 'text/plain' || type === 'text/html')) continue
          const blob = await it.getType(type)
          const ext = (type.split('/')[1] || 'png').split('+')[0]
          dt.items.add(new File([blob], 'clipboard.' + ext, { type }))
          n++
        }
      }
      if (n) {
        const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })
        const notHandled = el.dispatchEvent(ev)   // false = 有处理器调了 preventDefault（已处理）
        if (!notHandled) return
      }
    } catch {
      /* 权限被拒 / 浏览器不支持 → 落到下面的文本路径 */
    }
    // execCommand('paste') 在现代浏览器被禁用，退回 Clipboard API 的纯文本路径
    try {
      const text = await navigator.clipboard.readText()
      if (text) insertAtCursor(el, text)
      return
    } catch {
      try {
        document.execCommand('paste')
      } catch {
        /* 静默失败 */
      }
      return
    }
  }
  try {
    document.execCommand(cmd)
  } catch {
    /* 部分浏览器禁用 execCommand 时静默失败 */
  }
}

function editableMenuItems(el: Element): ContextMenuItem[] {
  return [
    { label: t('ctxMenu.copy'), icon: 'fas fa-copy', action: () => execEditableCmd('copy', el) },
    { label: t('ctxMenu.cut'), icon: 'fas fa-cut', action: () => execEditableCmd('cut', el) },
    { label: t('ctxMenu.paste'), icon: 'fas fa-paste', action: () => execEditableCmd('paste', el) },
    { divider: true },
    { label: t('ctxMenu.selectAll'), icon: 'fas fa-expand', action: () => execEditableCmd('selectAll', el) },
  ]
}

/** 复制纯文本（失败静默） */
function copyPlainText(text: string) {
  try {
    void navigator.clipboard?.writeText(text)
  } catch {
    /* ignore */
  }
}

/**
 * 选中文本右键菜单（0914）：复制 / 搜索选中内容。
 * 「搜索」派发全局事件 nis-open-search → Sidebar 打开搜索弹窗并预填关键词。
 */
function selectionMenuItems(text: string): ContextMenuItem[] {
  return [
    { label: t('ctxMenu.copy'), icon: 'fas fa-copy', action: () => copyPlainText(text) },
    {
      label: t('ctxMenu.searchSelected'),
      icon: 'fas fa-magnifying-glass',
      action: () => {
        try {
          window.dispatchEvent(new CustomEvent('nis-open-search', { detail: { query: text.slice(0, 120) } }))
        } catch {
          /* ignore */
        }
      },
    },
  ]
}

/**
 * 全局右键菜单：document 捕获阶段统一拦截右键（trusted 事件在捕获阶段必然可收，
 * 绕开元素级 Vue 监听对 trusted 右键不响应的问题），再用 `[data-ctx]` 委托到各组件注册的构建器。
 *
 * 未命中 data-ctx 时的兜底（0914 补齐）：
 *   - 输入/可编辑区 → 「复制 / 剪切 / 粘贴 / 全选」；
 *   - 有选中文本（非输入区）→ 「复制 / 搜索」小菜单；
 *   - 其余位置 → 仅屏蔽原生菜单。
 *   ⚠️ install() 已由 useGlobalContextMenu() 自动确保（幂等，0914 防呆）——此前只靠 App.vue
 *   onMounted 调用，HMR 热更后 onMounted 不重跑 = 拦截「假死」（右键变回原生菜单）的根因。
 */
export function useGlobalContextMenu() {
  // 防呆（0914）：任何一次调用都确保全局拦截已安装（幂等）。此前仅 App.vue onMounted 调用
  // install——HMR 热更后 onMounted 不会重跑 = 拦截「假死」（右键变回浏览器原生菜单）。
  install()
  function register(key: CtxKey, builder: CtxBuilder) {
    registry.set(key, builder)
  }

  function unregister(key: CtxKey) {
    registry.delete(key)
  }

  function open(items: ContextMenuItem[], x: number, y: number) {
    state.items = items
    state.x = x
    state.y = y
    state.visible = true
  }

  function close() {
    state.visible = false
  }

  function handleTrigger(e: MouseEvent) {
    if (e.type === 'mousedown' && e.button !== 2) return
    const target = e.target as Element | null
    const el =
      target && target.closest
        ? (target.closest('[data-ctx]') as HTMLElement | null)
        : null

    // 1) 命中 data-ctx：屏蔽原生菜单 + 打开/更新自定义菜单
    if (el) {
      const key = el.dataset.ctx
      if (key === '__noop') {
        // 菜单自身等标记区：屏蔽原生但不触发
        e.preventDefault()
        return
      }
      e.preventDefault()
      const builder = registry.get(key)
      if (builder) builder(el, e)
      else close()
      return
    }

    // 2) 未命中 data-ctx：contextmenu 一律屏蔽系统菜单。
    //    输入类元素 → 编辑菜单；有选中文本 → 复制/搜索；其余仅屏蔽。
    if (e.type === 'contextmenu') {
      e.preventDefault()
      if (state.visible) close()
      const editable =
        target && target.closest
          ? target.closest('input, textarea, [contenteditable="true"]')
          : null
      if (editable) {
        open(editableMenuItems(editable), e.clientX, e.clientY)
        return
      }
      const selText = (window.getSelection()?.toString() || '').trim()
      if (selText) {
        open(selectionMenuItems(selText), e.clientX, e.clientY)
      }
    }
  }

  function install() {
    if (installed) return () => {}
    installed = true
    ;(window as any).__nisCtxInstalled = true
    document.addEventListener('mousedown', handleTrigger, true)
    document.addEventListener('contextmenu', handleTrigger, true)
    return () => {
      installed = false
      ;(window as any).__nisCtxInstalled = false
      document.removeEventListener('mousedown', handleTrigger, true)
      document.removeEventListener('contextmenu', handleTrigger, true)
    }
  }

  return { state, register, unregister, open, close, install }
}
