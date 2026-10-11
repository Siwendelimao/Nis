/**
 * 应用内快捷键屏蔽（0920）
 *
 * 背景：反馈「按 F5 能把页面刷掉」。查下来整个前端**只有** CloseConfirmDialog 拦了 Escape，
 * 别的浏览器语义快捷键一个都没管 —— F5 / Ctrl+R 会把整个 SPA 重新加载（丢掉正在流的回复、
 * 丢输入框草稿、还会重走一遍开屏），F12 / Ctrl+Shift+I 能开开发者工具，Ctrl+P 弹打印预览…
 *
 * 口径（重要）：
 *   **只吃"浏览器/宿主语义"的键，绝不碰"编辑器语义"的键**。
 *   复制/粘贴/剪切/撤销/重做/全选、Ctrl+Enter 发送、Esc 关浮层、方向键、Tab、输入法组合键
 *   —— 一个都不拦（拦了会直接影响用起来的手感，属于"修 bug 修出新 bug"）。
 *
 * 装法：capture 阶段挂 keydown，保证比业务里的快捷键更早看到事件。
 */

/**
 * 要屏蔽的键。返回 true = 吃掉（preventDefault + stopPropagation）。
 * key 用 e.key（大小写敏感，字母键统一按小写比）。
 *
 * ⚠️ 刻意**不**屏蔽 Backspace / Escape / Tab：它们有真实业务用途
 * （ChatInput 用 Backspace 删技能标签、BrowserPanel 把按键转发给内嵌浏览器、Esc 关浮层），
 * 吃了会连累正常操作。现代 Chromium 也不会用 Backspace 后退了。
 */
function shouldBlock(e: KeyboardEvent): boolean {
  const k = e.key
  const lower = k.length === 1 ? k.toLowerCase() : k
  const ctrl = e.ctrlKey
   // 顺手把 macOS 的 Cmd 也覆盖了

  /* ── 刷新 / 重新加载：整个 SPA 会重来，必须吃 ── */
  if (k === 'F5') return true
  if (ctrl && lower === 'r') return true

  /* ── 开发者工具：F12 / Ctrl+Shift+I(J,C,M) ── */
  if (k === 'F12') return true
  if (ctrl && e.shiftKey && ['i', 'j', 'c', 'm', 'k'].includes(lower)) return true

  /* ── 打印 ── */
  if (ctrl && lower === 'p') return true

  /* ── 关窗 / 新开（桌面应用里没有"标签页"这个概念） ── */
  if (ctrl && !e.shiftKey && lower === 'w') return true
  if (ctrl && e.shiftKey && lower === 'w') return true
  if (k === 'F4' && ctrl) return true
  if (ctrl && ['t', 'n'].includes(lower)) return true

  /* ── 全屏 / 光标浏览（桌面窗口有自己的控制） ── */
  if (k === 'F11') return true
  if (k === 'F7') return true

  /* ── 后退 / 前进（SPA 里等于"莫名跳到别的地方"） ── */
  if (e.altKey && (k === 'ArrowLeft' || k === 'ArrowRight' || k === 'Home')) return true

  /* ── 打开 / 保存 / 查看源码：浏览器语义，应用里都有正规入口 ── */
  if (ctrl && ['o', 's', 'u', 'd', 'h', 'j'].includes(lower)) return true

  /* ── 页面缩放：应用有自己的「外观 → 字号」，浏览器缩放会整体错位 ── */
  if (ctrl && (k === '=' || k === '+' || k === '-' || k === '_' || k === '0')) return true

  return false
}

let installed = false

/** 装全局守卫（幂等；main.ts 启动时调一次） */
export function installAppShortcuts(): void {
  if (installed || typeof window === 'undefined') return
  installed = true

  window.addEventListener(
    'keydown',
    (e) => {
      if (!shouldBlock(e)) return
      e.preventDefault()
      e.stopPropagation()
    },
    { capture: true },
  )

  /* Ctrl + 滚轮 = 浏览器缩放，同样会整体错位 → 吃掉 */
  window.addEventListener(
    'wheel',
    (e) => {
      if (e.ctrlKey) e.preventDefault()
    },
    { passive: false, capture: true },
  )

  /* 把文件拖到窗口"空白处"时浏览器会直接导航到该文件（整个应用被顶掉）。
     应用内的拖放区（输入框 / 工作区）自己会 preventDefault → 那时 defaultPrevented 已是 true，
     所以这里只在**没人处理**的情况下兜底。 */
  window.addEventListener(
    'dragover',
    (e) => { if (!e.defaultPrevented) e.preventDefault() },
    { capture: false },
  )
  window.addEventListener(
    'drop',
    (e) => {
      if (e.defaultPrevented) return
      e.preventDefault()
    },
    { capture: false },
  )
}
