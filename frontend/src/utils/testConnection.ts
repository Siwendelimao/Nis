import { useChatStore } from '@/stores/chat'
import { useProvidersStore } from '@/stores/providers'

interface TestResult {
  ok: boolean
  msg: string
}

/** 后端已连接：走 bridge 代理测试（providers.test，后端发请求绕 CORS） */
async function testViaBackend(provider: string, modelId: string): Promise<TestResult> {
  const chatStore = useChatStore()
  const providersStore = useProvidersStore()
  const key = providersStore.apiKeys[provider]
  try {
    if (key) {
      await chatStore.bridgeRpc('providers.setKey', { providerId: provider, apiKey: key })
    }
    const result = await chatStore.bridgeRpc('providers.test', { providerId: provider, modelId })
    return { ok: !!result.ok, msg: String(result.msg || '') }
  } catch (e: any) {
    return { ok: false, msg: `后端代理失败：${e?.message || e}` }
  }
}

/** 后端未连接：前端直连 OpenAI 兼容 /v1/chat/completions（发 1-token 最小请求验证） */
async function testViaDirect(provider: string, modelId: string): Promise<TestResult> {
  const providersStore = useProvidersStore()
  const p = providersStore.providers.find(x => x.id === provider)
  const key = providersStore.apiKeys[provider]
  if (!p) return { ok: false, msg: '供应商不存在' }
  if (!key) return { ok: false, msg: '该供应商未填写 API Key' }
  const base = p.base.includes('://') ? p.base : `https://${p.base}`
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 8000)
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
      }),
      signal: ctrl.signal,
    })
    clearTimeout(t)
    if (res.ok) return { ok: true, msg: '连通' }
    if (res.status === 401 || res.status === 403) {
      /* ★ 0925e：透传服务端真实原因（FreeTierError"仅限客户端内"/RegionError"地区不可用"等，
         原来一刀切报"认证失败（检查 API Key）"误导排查方向） */
      let detail = ''
      try {
        const j = await res.json()
        detail = String(j?.error?.message || j?.message || '')
      } catch { /* ignore */ }
      return { ok: false, msg: detail ? `${res.status}：${detail.slice(0, 100)}` : '认证失败（检查 API Key）' }
    }
    return { ok: false, msg: `返回 ${res.status}` }
  } catch {
    return { ok: false, msg: '跨域被拒（CORS）或无法连接，需后端代理' }
  }
}

/** 测试指定模型连通性：**一律走后端**代理测试（后端才能吃供应商 proxyUrl）。
 *  ★ 0925f：原来后端未连时"前端直连"——浏览器 fetch 走不了供应商代理（http 代理对页面不可见），
 *  用户明明给供应商配了 VPN 代理端口，测试却按本地出口判定（实测：日本代理已配好，
 *  前端直连路径仍报"地区不可用"误报）。现在：配了代理就必须经后端测，未连后端明确提示。 */
export async function testModelConnection(provider: string, modelId: string, _base?: string): Promise<TestResult> {
  const chatStore = useChatStore()
  const providersStore = useProvidersStore()
  const p = providersStore.providers.find(x => x.id === provider)
  if (!chatStore.wsConnected) {
    if (p?.proxyUrl) return { ok: false, msg: '该供应商配置了网络代理，需连接后端才能经代理测试（当前后端未连接）' }
    return testViaDirect(provider, modelId)
  }
  return testViaBackend(provider, modelId)
}
