/**
 * 后端地址解析（动态端口 · 0915）
 *
 * 背景：打包版曾把后端端口写死 8766，与开发后端抢端口 —— sidecar 抢不到就静默退出，
 * 窗口探到「8766 通」便跳转，结果连到开发后端（无 NIS_DIST_DIR）→ 页面只剩 {"error":"not found"}。
 * 现在端口由 Tauri 侧动态分配（选空闲端口 → NIS_PORT），窗口导航到该端口。
 *
 * 因此前端不能再写死端口：
 * - dev（vite 5174）：仍是 8766（vite 已配 /api → 8766 代理）；且同源相对路径优先。
 * - 打包版：页面由后端自身 serve（serve-from-backend），直接用 location.origin —— 天然同源。
 */
function resolveBridgeUrl(): string {
  // dev：vite 开发服务器固定代理到 8766
  if (import.meta.env.DEV) {
    /* ★1011z【关键】dev 下原来一律返回 'http://127.0.0.1:8766' —— 本机用没问题，但
       **手机/另一台电脑**用 http://192.168.1.18:5174 打开时，127.0.0.1 指的是**那台设备自己**
       ⇒ 所有 API 全部 ERR_CONNECTION_REFUSED ⇒ **卡在开屏页进不去**（实测，控制台刷满连接被拒）。
       现在：页面在 localhost / 127.0.0.1 打开才直连 8766（保持零开销）；
       从**局域网地址**打开则用**同源** —— 请求打到 dev server 自己的 /api，由 vite 的 proxy
       转发到后端（vite.config.ts 里已配 `'/api' → 127.0.0.1:8766`）。SSE 同理走同源。
       ⚠️ 依赖：vite config 的 changeOrigin 目前为 true（会把 Host 改写成 127.0.0.1），
       所以后端仍把这些请求当"本机"放行；若将来改成 false，这里的请求就必须带令牌
       —— 前端 utils/nisToken.ts 已把 ?token= / x-nis-token 铺到全部 fetch 与 SSE，届时逐个核对即可。 */
    try {
      const host = window.location.hostname
      if (host && host !== 'localhost' && host !== '127.0.0.1' && host !== '[::1]') {
        return window.location.origin
      }
    } catch { /* 非浏览器环境 → 走下面的默认 */ }
    return 'http://127.0.0.1:8766'
  }
  // 打包/预演：页面来自后端自身 → 同源即正确（端口无论多少都对）
  try {
    const origin = window.location.origin
    if (origin && /^https?:\/\//i.test(origin)) return origin
  } catch {
    /* 非浏览器环境兜底 */
  }
  return 'http://127.0.0.1:8766'
}

export const BRIDGE_URL: string = resolveBridgeUrl()
