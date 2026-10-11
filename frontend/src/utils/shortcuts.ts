

/** 由 KeyboardEvent 生成快捷键描述（如 Enter / Shift+Enter / Ctrl+, / Esc） */
export function shortcutFromEvent(e: KeyboardEvent): string {
  const parts: string[] = []
  if (e.ctrlKey) parts.push('Ctrl')
  if (e.shiftKey) parts.push('Shift')
  if (e.altKey) parts.push('Alt')
  if (e.metaKey) parts.push('Meta')
  const k = e.key
  const isModifier = ['Control', 'Shift', 'Alt', 'Meta'].includes(k)
  if (!isModifier) {
    parts.push(k.length === 1 ? k.toUpperCase() : k)
  }
  return parts.join('+') || (isModifier ? '' : k)
}

/** 判断当前事件是否匹配某个快捷键配置（如 'Shift+Enter'） */
export function matchesShortcut(e: KeyboardEvent, cfg: string): boolean {
  const parts = cfg.split('+').map(p => p.trim()).filter(Boolean)
  const hasCtrl = parts.includes('Ctrl')
  const hasShift = parts.includes('Shift')
  const hasAlt = parts.includes('Alt')
  const hasMeta = parts.includes('Meta')
  if (e.ctrlKey !== hasCtrl || e.shiftKey !== hasShift || e.altKey !== hasAlt || e.metaKey !== hasMeta) {
    return false
  }
  const key = parts.find(p => !['Ctrl', 'Shift', 'Alt', 'Meta'].includes(p))
  if (!key) return false
  return e.key === key || e.key.toUpperCase() === key
}


