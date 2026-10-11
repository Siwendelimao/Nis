/**
 * elementTag —— 元素标签的两个形态（0914 拾取批）。
 *
 *  • AI 侧（发送/存储）：完整结构化 token —— 标签名 + 完整选择器 + 文件内精确坐标 + 来源文件/路径，
 *    保证「指哪打哪」；与 chat.ts getPlainText 同源格式。
 *  • 人类侧（输入框胶囊 / 消息气泡）：短标签 —— 取选择器末段、去掉 nth-of-type 噪声、约 20 字符封顶。
 */

/** 完整 token：[页面元素:h2|#probe-title|坐标x,y,w,h|文件:名(路径)] */
export function formatElementTagToken(m: any): string {
  const r = m?.rect
  const coords = r ? `x${r.x},y${r.y},w${r.w},h${r.h}` : ''
  const fileLabel = m?.filePath && m?.fileName && m.fileName !== m.filePath
    ? `${m.fileName}(${m.filePath})`
    : (m?.fileName || m?.filePath || '')
  return `[页面元素:${m?.tagName || ''}${m?.selector ? '|' + m.selector : ''}${coords ? '|坐标' + coords : ''}${fileLabel ? '|文件:' + fileLabel : ''}]`
}

/** 短标签：优先选择器最末段（最具辨识度），去掉 :nth-of-type(N)，约 20 字符封顶 */
export function shortSelectorLabel(selector: string, tagName = '', max = 20): string {
  let s = String(selector || '').trim() || String(tagName || '').trim()
  const segs = s.split('>').map(x => x.trim()).filter(Boolean)
  if (segs.length > 1) s = segs[segs.length - 1]
  s = s.replace(/:nth-of-type\(\d+\)/g, '')
  if (!s) s = String(tagName || '').trim() || '元素'
  if (s.length > max) s = s.slice(0, max - 1) + '…'
  return s
}

/** 展示用：把消息文本里的 [页面元素:...] token 压缩成短标签（只动展示文本，发给 AI 的原文不变） */
export function shortenElementTokens(text: string): string {
  if (!text || text.indexOf('[页面元素:') === -1) return text
  return text.replace(/\[页面元素:([^\]]*)\]/g, (_m: string, inner: string) => {
    const parts = String(inner).split('|')
    const tagName = parts[0] || ''
    const maybeSel = parts[1] || ''
    const selector = (maybeSel && !maybeSel.startsWith('坐标') && !maybeSel.startsWith('文件:')) ? maybeSel : ''
    return `[元素:${shortSelectorLabel(selector, tagName)}]`
  })
}
