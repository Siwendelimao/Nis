/* lazyTools.ts —— 刀②：低频能力包「工具照常挂载、说明书按需发」（0929）
 * 思路（能力零损失版懒加载）：
 *   · 工具**始终挂在 agent 上**（模型随时调得到=能力不减）；
 *   · 但发给模型的「工具表」里，低频包只保留一行目录（系统提示里告知），
 *     真实说明书在 load_tools('包名') 之后才进请求 —— 这一步由 createStreamFn
 *     在【每次请求组装工具表时】过滤（工具循环每跳都过这里 ⇒ 当轮加载当轮生效）。
 *   · 缓存友好：低频包工具在工具表末尾（MCP 本就排尾），隐藏=截尾巴、加载=尾巴回来，
 *     前缀逐字节稳定，只在"加载那一跳"付一次缓存未命中。
 * 0928 真机验证过的取舍：pi-ai 原生 defer_loading 只有 Anthropic 系支持工具引用，
 * 主力模型（mimo/deepseek/agnes）走 openai-completions 协议 —— 故自实现这层通用机制。
 */

/** 低频能力包定义：包名 → 归属判定 + 一句话索引（系统提示/目录用） */
export const LAZY_FAMILIES: Record<string, { label: string; match: (name: string) => boolean; hint: string }> = {
  browser: {
    label: '浏览器能力包',
    match: (n) => /^mcp__nis-browser__wb_/.test(n),
    hint: '打开网页/点击/填表单/截图/读页面 等 20 件浏览器操作（真实浏览器，用户可见）',
  },
}

/** 工具名属于哪个懒加载包（不属于=常驻工具，null） */
function lazyFamilyOf(name: string): string | null {
  for (const [fam, def] of Object.entries(LAZY_FAMILIES)) if (def.match(name)) return fam
  return null
}

/** 请求级工具表过滤：常驻全发；懒包只有「已加载」才发（loaded 为空=只发常驻）。
 *  ★ 底线保险：工具表里**没有 load_tools**（加载器）时一律不藏 —— 藏了又没处喊 = 能力损失，绝不允许。 */
export function splitToolsForRequest(tools: any[], loaded: Set<string> | undefined | null): any[] {
  const hasLoader = tools.some(t => String(t?.name || '') === 'load_tools')
  if (!hasLoader) return tools
  if (!loaded || loaded.size === 0) return tools.filter(t => !lazyFamilyOf(String(t?.name || '')))
  return tools.filter(t => { const f = lazyFamilyOf(String(t?.name || '')); return !f || loaded.has(f) })
}

/** 该包还没加载时，模型只该看到的「目录行」（系统提示/工具表注记用） */
export function familyIndexLine(family: string): string {
  const def = LAZY_FAMILIES[family]
  return def ? `${def.label}（${def.hint}）—— 用 load_tools('${family}') 展开说明书后使用` : ''
}

/** 把一个包的真实说明书拼成文本（load_tools 的返回体：模型当轮即可照着调用） */
export function familyToolDocs(family: string, tools: any[]): string {
  const def = LAZY_FAMILIES[family]
  const mine = tools.filter(t => def?.match(String(t?.name || '')))
  if (!mine.length) return `【${family}】没有找到该能力包的工具（可能未挂载：检查预设的工具勾选）`
  const lines = mine.map((t: any) => {
    const props = t?.parameters?.properties || {}
    const params = Object.entries(props).map(([k, v]: any) => `${k}${v?.type ? `:${v.type}` : ''}`).join(', ')
    return `· ${t.name}（${t.label || ''}）：${String(t.description || '').slice(0, 160)}${params ? `｜参数：${params}` : ''}`
  })
  return `已加载【${def.label}】${mine.length} 件，本轮及后续都可直接调用（说明书如下，参数细节以工具 schema 为准）：\n${lines.join('\n')}`
}
