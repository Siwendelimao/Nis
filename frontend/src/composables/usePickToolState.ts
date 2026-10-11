/**
 * usePickToolState —— 「选择元素 / 指针」工具状态（0914 拾取批）。
 *
 * 按会话隔离：各自对话管各自的工具档位——切换界面/切会话/组件重挂载都不丢、不串台。
 * 模块级 Map：SPA 内常驻，不随组件卸载销毁。
 */
type PickTool = 'pointer' | 'select'

const state = new Map<string, PickTool>()

export function getPickToolOf(convId: string): PickTool {
  return state.get(convId) || 'pointer'
}

export function setPickToolOf(convId: string, tool: PickTool) {
  if (!convId) return
  state.set(convId, tool)
}
