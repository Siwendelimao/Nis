/**
 * ★1003 安全批 4.65/4.66：NIS_TOKEN 远程访问凭据 —— 页面地址 `?token=xxx` 进来，后续请求带上。
 * 头优先（x-nis-token），查询参数兜底（EventSource/图片这类带不了头的场景用 withToken）。
 * 本地访问（127.0.0.1）后端永远放行，这里 token 为空时就是无操作，零影响。
 */
let _tok = ''
try { _tok = new URLSearchParams(window.location.search).get('token') || '' } catch { /* 非浏览器环境 */ }

export function nisToken(): string { return _tok }

/** fetch 请求头（token 存在才带；本地开发为空对象=零变化） */
export function authHeaders(): Record<string, string> {
  return _tok ? { 'x-nis-token': _tok } : {}
}

/** URL 带上 ?token=（带不了请求头的场景：EventSource/图片/iframe/下载链接） */
export function withToken(url: string): string {
  if (!_tok || !url) return url
  return url + (url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(_tok)
}
