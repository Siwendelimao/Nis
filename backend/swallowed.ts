/**
 * swallowed —— 「降级必须留痕」的统一出口（后端版，★1005 清兜底批次）。
 *
 * 与前端 `frontend/src/utils/swallowed.ts` 同一套口径（见那里的完整说明），只是跑在 Node 上。
 *
 * ## 口径（三分类）
 * 1. **真·无害的尽力而为** → 允许静默（关流、杀已退出进程、删临时文件、纯内存赋值），但要注明原因。
 *    ⚠️ 后端有两类**已确认**属于此类，不要给它们加日志（会刷屏、且掩盖不了任何事）：
 *      · `broadcastMux/writeMuxTo` 周围的 catch —— 该函数内部已有 per-client try + 背压守卫；
 *      · `schedulePersist()` 周围的 catch —— 它只是防抖（不可能抛），而真正的落盘失败
 *        由 `persistSessions` 自己的 `console.error('[persist] sessions failed:')` 负责。
 * 2. **用户可见结果可能因此不对** → 必须走本函数（例：直接写 settings/ui-state 失败、
 *    回填 agent 上下文失败、IM 回执没发出去）。
 * 3. **协议字段缺失/类型不符** → 不许默认成"成功"，要显式报错（不要用本函数掩盖）。
 *
 * ## 输出契约
 * 统一前缀 `[nis:swallowed]`；**第 1 次必报**，之后每当计数是 `every` 的整数倍再报（默认 20）。
 * 重复报时带「第 N 次」，便于判断偶发还是高频。
 */
const seen = new Map<string, number>()

export function swallowed(scene: string, e: unknown, every = 20): void {
  const n = (seen.get(scene) || 0) + 1
  seen.set(scene, n)
  if (n !== 1 && n % Math.max(1, every) !== 0) return
  const msg = e instanceof Error ? (e.message || String(e)) : String(e)
  // 用 warn（不是 error）：这些是"降级但已留痕"，不是崩溃
  console.warn(`[nis:swallowed] ${scene}${n > 1 ? `（第 ${n} 次）` : ''}：${msg}`, e)
}

/** 只读快照（给"想知道频率"或调试用） */
export function swallowedCount(): ReadonlyArray<{ scene: string; count: number }> {
  return [...seen.entries()].map(([scene, count]) => ({ scene, count }))
}
