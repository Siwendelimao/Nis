/**
 * 0909⑤ 出站消息消毒（b.ai 400 防御层）：
 * b.ai 网关实锤（直连探针）：OpenAI chat/completions 端点只认 text/image_url 两类内容块——
 *  - {type:'file'} 块 → 400「messages[0].content[0].file必须传入file_id、file_url、file_data至少之一」
 *  - image_url 空 base64 → 400「url cannot be empty」
 *  - 非图片 mime（svg/bmp/pdf/octet-stream 伪装的 data:）→ 400「图片输入格式/解析错误」
 * 真实截图 PNG/JPEG（含 234KB/698×332 尺寸）均 200。
 * NIS 现行代码不产生 file 块，但 transcript 可从旧数据/外部注入回填 _state.messages，
 * 一旦带病入库，每轮请求都 400 且重试循环全灭（0909 03:51 实锤：6 连败直到轮末）。
 * 故发送前统一消毒：user/toolResult 消息的内容块只保留合法 text/image，
 * 其余替换为文本占位（模型可读、网关可收），并返回被剥离清单供日志定位来源。
 */
interface SanitizeReport { stripped: string[] }

const IMAGE_MIME_RE = /^image\/(png|jpe?g|webp|gif)$/i

export function sanitizeRequestMessages(messages: any[]): { messages: any[]; report: SanitizeReport } {
  const stripped: string[] = []
  const out = messages.map((m: any) => {
    if (!m || (m.role !== 'user' && m.role !== 'toolResult') || !Array.isArray(m.content)) return m
    let touched = false
    const content = m.content.flatMap((c: any) => {
      if (!c || typeof c !== 'object') { stripped.push('non-object'); touched = true; return [{ type: 'text', text: '[已移除无法识别的附件]' }] }
      if (c.type === 'text') return [c]
      if (c.type === 'image') {
        const okMime = IMAGE_MIME_RE.test(String(c.mimeType || ''))
        const okData = typeof c.data === 'string' && c.data.length > 0
        if (okMime && okData) return [c]
        stripped.push(`image:${c.mimeType || '无mime'}${okData ? '' : ':空数据'}`)
        touched = true
        return [{ type: 'text', text: `[已移除不支持的图片附件（${c.mimeType || '未知格式'}），仅支持 PNG/JPEG/WEBP/GIF]` }]
      }
      stripped.push(String(c.type || 'unknown') + (c.filename ? `(${c.filename})` : ''))
      touched = true
      const hint = c.filename ? `「${c.filename}」` : ''
      return [{ type: 'text', text: `[已移除不支持的附件块${hint}：类型 ${c.type || '未知'}。如需读取文件内容，请用 fs_read 按路径读取]` }]
    })
    return touched ? { ...m, content } : m
  })
  return { messages: out, report: { stripped } }
}

/* ── ★ 0923：tool 消息配对修复（防「Messages with role 'tool' must be a response to a preceding
 *  message with 'tool_calls'」400）──
 * 实录（安装版会话 9e6e0614 案发现场）：用户中途插话打断正在执行的工具调用时，
 * 插话的 user 消息先落盘、被中断的 toolResult 后落盘 —— 序列变成：
 *   assistant(2×toolCall) → user(插话) → toolResult → toolResult
 * OpenAI 兼容网关要求 tool 结果必须【紧随】assistant 的 tool_calls（中间不能夹 user）→ 每轮 400。
 * 修法（发送前兜底，无条件可跑）：
 *   ① 错位：toolResult 上移到其配对 assistant 之后（紧随，保持多个结果的相对顺序）；
 *   ② 孤儿：找不到配对 toolCallId 的 toolResult → **直接丢弃**（★ 0924 用户定案 B 方案）。
 *      原来为了"保留信息"转成 user 文本，但被中断的结果是**永久孤儿**（源数据不会变）⇒ 每轮都转一遍，
 *      会话里越堆越多的「[历史工具结果（已转文本保留）：…]」噪音（实测同一批 7 条反复出现十几次）。
 *      改丢弃后**只剔出站副本**，transcript / 持久化原文不动，回看与排查照旧；
 *   ③ 缺号：assistant 声明了 N 个 toolCall 但只有 M<N 个结果（部分中断没落盘）→ 补占位 result。 */
export function repairToolPairing(messages: any[]): { messages: any[]; moved: number; orphaned: number; filled: number } {
  const idOf = (c: any): string => String(c?.id || c?.toolCallId || c?.tool_use_id || '')
  const ridOf = (m: any): string => String(m?.toolCallId || m?.tool_call_id || m?.tool_use_id || '')
  const callIdsOf = (m: any): string[] => (m?.role === 'assistant' && Array.isArray(m.content) ? m.content.filter((c: any) => c?.type === 'toolCall' || c?.type === 'tool_use').map(idOf) : [])
  // owner: toolCallId → assistant 下标
  const owner = new Map<string, number>()
  messages.forEach((m, i) => { for (const id of callIdsOf(m)) if (id) owner.set(id, i) })
  const follow = new Map<number, any[]>()   // assistant 下标 → 需上移的 toolResult
  const removed = new Set<number>()
  const orphans: any[] = []
  messages.forEach((m, i) => {
    if (m?.role !== 'toolResult' && m?.role !== 'tool') return
    const oi = owner.get(ridOf(m))
    if (oi === undefined) { orphans.push(m); removed.add(i); return }
    let prev = i - 1
    while (prev >= 0 && (messages[prev]?.role === 'toolResult' || messages[prev]?.role === 'tool')) prev--
    if (prev === oi) return   // 位置正确（紧随 owner 及其同伴结果）
    if (!follow.has(oi)) follow.set(oi, [])
    follow.get(oi)!.push(m)
    removed.add(i)
  })
  const out: any[] = []
  const placed = new Set<string>()   // 已在输出里的结果 id
  /* 0927 netfix idx-guard-0927：记下每条消息的**原数组下标** —— follow 以原下标为 key，
     而下面补占位的循环遍历的是 out（剔除/上移后下标已变），拿 out 下标去查 follow 必错位。 */
  const origIdx = new Map<any, number>()
  messages.forEach((m, i) => {
    if (removed.has(i)) return
    out.push(m)
    origIdx.set(m, i)
    if (m?.role === 'assistant') {
      const extra = follow.get(i)
      if (extra) for (const r of extra) { out.push(r); placed.add(ridOf(r)) }
    }
    if (m?.role === 'toolResult' || m?.role === 'tool') placed.add(ridOf(m))
  })
  // ③ 缺号补齐：assistant 有 toolCall 但输出里没有任何对应结果 → 补占位（防 "must be followed by" 400）
  let filled = 0
  for (let i = 0; i < out.length; i++) {
    const m = out[i]
    const ids = callIdsOf(m)
    if (ids.length === 0) continue
    const missing = ids.filter(id => id && !placed.has(id))
    if (missing.length === 0) continue
    const ph = missing.map(id => ({ role: 'toolResult', toolCallId: id, toolName: 'unknown', content: [{ type: 'text', text: '[该工具调用未完成（中断/会话异常），无结果]' }], isError: true, timestamp: Date.now() }))
    out.splice(i + 1 + (follow.get(origIdx.get(m))?.length || 0), 0, ...ph)
    for (const id of missing) placed.add(id)
    filled += missing.length
  }
  /* ② 孤儿 → **直接丢弃**（★★ 0924 用户定案 B 方案）
     原实现是"转成 user 文本保留"（怕丢信息），但实测代价太大：
       · 被中断的工具结果**永久**配不上对（源数据不会变）⇒ 每轮请求都会被转出一条文本注入，
         会话里越堆越多，表现就是"每次发消息都跟着一串 [历史工具结果（已转文本保留）：…]"的噪音
         （实测：同一批 7 条反复出现了十几次）；
       · 这些噪音还会被模型当成真实上下文读 —— 白占 token，还干扰判断。
     现在直接丢弃。注意**只丢出站副本**（out）：transcript / 持久化原文一个字节都不动，
     回看会话与事后排查照样看得到；既治 400，又不再产生噪音。
     （设计口径：认了"某些场景会少一点线索"这个代价。） */
  const orphaned = orphans.length
  return { messages: out, moved: removed.size - orphans.length, orphaned, filled }
}
