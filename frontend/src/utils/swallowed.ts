/**
 * swallowed —— 「降级必须留痕」的统一出口（★1005 清兜底批次）。
 *
 * ## 为什么有它
 * 项目里大量 `catch { /* ignore *​/ }` 把失败**连日志一起吞掉**：出问题时前端一声不响，
 * 只能靠肉眼发现（1005 体检：产品代码里 catch-ignore 类共 398 处）。
 * 用户的口径是「不希望有兜底」—— 兜底不是保护，是把病藏起来。
 *
 * ## 口径（写在这里，供后来人照做）
 * 1. **真·无害的清理/尽力而为**（关流 `reader.cancel`、杀已退出的子进程、删临时文件、纯本地赋值）
 *    → 允许静默，但**必须**写 `catch {}` 并注明"为什么不影响用户"。
 * 2. **任何"用户可见的结果可能因此不对"的失败** → 必须走本函数留痕。
 *    例：补历史/对账失败（界面停在旧内容）、会话列表拉不到（该出现的会话不出现）。
 * 3. **状态本地已改、后端未生效**（desync）→ 必须走本函数，并在 scene 里写清
 *    "本地已改、后端未生效"，方便日后一键检索这类隐患。
 * 4. **协议字段缺失/类型不符** → 不许默认成"成功"，要显式报错（本函数不适用于这种，请直接抛/明确失败）。
 *
 * ## 输出契约
 * 统一前缀 `[nis:swallowed]`（便于检索与回顾）。
 * 报数规则：**第 1 次必报**；之后**每当计数是 every 的整数倍**再报一次（默认 every=20 ⇒ 1/20/40/…）。
 * `every=1` = 每次都报。重复报时前缀带「第 N 次」，便于判断是偶发还是高频。
 */
const seen = new Map<string, number>()

/**
 * 记录一次"被降级/被吞掉"的失败。
 * @param scene 人话描述**发生了什么 + 后果**（例：'会话补账失败（界面可能停在旧内容）'）
 * @param e     原始异常
 * @param every 同一 scene 每 N 次再报一次（默认 20；1 = 每次都报）
 */
export function swallowed(scene: string, e: unknown, every = 20): void {
  const n = (seen.get(scene) || 0) + 1
  seen.set(scene, n)
  if (n !== 1 && n % Math.max(1, every) !== 0) return
  const msg = e instanceof Error ? (e.message || String(e)) : String(e)
  console.warn(`[nis:swallowed] ${scene}${n > 1 ? `（第 ${n} 次）` : ''}：${msg}`, e)
}

/** 只计数不打印（给"已知且无害、但想知道频率"的场景用） */
export function swallowedCount(): ReadonlyArray<{ scene: string; count: number }> {
  return [...seen.entries()].map(([scene, count]) => ({ scene, count }))
}
