/**
 * 0920：工作模式指令的剥离。
 *
 * 背景：会话「工作模式」（计划 / 构建）在后端的实现方式是**往用户消息最前面拼一行指令**
 * （跟技能标记 `[技能:x]` 完全同一机制，见 `backend/server.ts` 的 `buildModeHint`）——
 * 刻意不进 systemPrompt，免得动 agent 缓存指纹。
 *
 * 后果：后端 transcript 里存的是「`[模式:计划] 本轮只做规划…` + 换行 + 用户正文」，
 * 而界面上必须显示**干净的用户文本**（气泡、回填输入框、steer 去重比较都算）。
 * 所以凡是要"还原用户原话"的地方，都先过这里。
 *
 * ⚠️ 只剥**行首那一行**：`[模式:xxx]` 开头的整行 + 其后的换行。正文里若出现同样的字面量不受影响。
 */
export function stripModeHint(text: string): string {
  if (!text) return text
  let t = String(text)
  // ★0930：[记忆召回]（后端自动召回注记）与 [模式:] 同款"行首一行"剥离；两者顺序无关（循环剥到不动为止）
  // ★1012c：[项目档案卡] 同款（后端 runPromptCore 拼的档案卡行，含体量/行范围/最近进度，界面不该显示）；
  // ★1012l：[上下文] 同款（后端给的"当前占用 X%（压缩过 N 次）"行 —— 给模型看准确数字用，界面不该显示）；
  //         注入行现有 5 种 ⇒ 循环上限 5（与后端 stripInjectedLines 同步，改一处记得改另一处）
  for (let i = 0; i < 5; i++) {
    const n = t.replace(/^\[模式:[^\]]+\][^\n]*\n?/, '').replace(/^\[记忆召回\][^\n]*\n?/, '').replace(/^\[技能指令\][^\n]*\n?/, '').replace(/^\[项目档案卡\][^\n]*\n?/, '').replace(/^\[上下文\][^\n]*\n?/, '')
    if (n === t) break
    t = n
  }
  return t
}

/* ★1004d：轮次标签专用清洗（与后端 server.ts cleanTurnLabel 同口径，改一处记得同步另一处）。
 * 标签=turnId 之类的"摘要标题"：剥注入行之外再剥 [[图片:N]] 位置标记、压缩空白。
 * 只用于标签展示，不动消息原文。存量脏标签/旧后端过渡期由它兜住显示面（根治在后端生成端）。 */
export function cleanTurnLabel(text: string): string {
  return stripModeHint(text).replace(/\[\[图片:\d+\]\]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80)
}
