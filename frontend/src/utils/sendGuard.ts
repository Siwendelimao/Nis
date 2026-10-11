/* ★1004 发送防重·单源（实测反馈"同一条消息 18ms 内建出两个会话"）：
 * 旧实现在 ChatInterface 组件里（状态随实例、且判重在 `await getImageAttachments()` **之后**）——
 * 双触发（IME 确认 Enter/双击/事件重复派发）两条调用会并发穿过 await，图片提取竞态还可能算出
 * 不同指纹 ⇒ 两条都放行 ⇒ 两次 session.create ⇒ 会话列表多出一条重复会话。
 * 口径：**同文本 2 秒内的重复触发直接丢弃**，判重必须在任何 await **之前**（同步段拦死并发窗口）。
 * ⚠️ 本模块是 JS 框内单源（同窗口多组件共享）；跨窗口（Tauri 多 webview）不共享——那要靠后端幂等。 */
let lastFp = ''
let lastAt = 0

/** 同指纹（=同文本）2 秒内二次触发 → true=丢弃。发 A→发 B→再发 A 不拦（只记上一次）。 */
export function isDuplicateSend(text: string): boolean {
  const fp = String(text || '').replace(/\s+/g, ' ').trim()
  const now = Date.now()
  if (fp && fp === lastFp && now - lastAt < 2000) return true
  lastFp = fp
  lastAt = now
  return false
}
