/**
 * pi 兼容层（★1011 pi 0.84.2 → 1.1.0）
 *
 * 上游这次的两个破坏性改动集中收口在这里，业务代码只改"调用写法"、**不改判据逻辑**：
 *
 *  ① 收工钩子改名 + 返回语义反转（0.87 删 `shouldStopAfterTurn`，新增 `finishTurn`）
 *     旧：`(ctx) => boolean`，true = 停
 *     新：`(ctx) => { action: 'end' } | { action: 'continue' } | undefined`，end = 停
 *     ⇒ 用 toFinishTurn() 把"旧式 boolean 判据"包成新钩子（判据代码一行不动）。
 *     注意：上游 d.ts 注释写明 "Error and aborted responses remain hard exits"（出错/中断仍是硬退出），
 *     与部分二手资料的"新钩子对 error/aborted 也会调用"说法相反 —— 这里先不加守卫（保持行为等价），
 *     改完实测若发现出错轮被判错再补。
 *
 *  ② 流函数入参从 `Context` 收紧为 `TranscriptContext`（0.86 起）
 *     官方原文："Only `normalizeContext()` produces this type, so a raw `Context` cannot reach
 *     provider code" ⇒ 直传 `{ systemPrompt, messages, tools }` 字面量会被类型系统拒绝（实测 14 条 TS2345）。
 *     ⇒ 统一用 toTranscriptCtx()。
 *     ⚠️ 语义影响：normalizeContext 会把 systemPrompt / tools **折进首条 system 消息**，
 *        请求字节前缀可能变化 ⇒ 改完必须实测 prompt 缓存命中率（token 面板）。
 */
import { normalizeContext } from '@earendil-works/pi-ai'

/** ★1011：旧式"返回 true 就停"的判据 → 新钩子 finishTurn 要的 TurnDecision */
export function toFinishTurn(legacy: (ctx: any) => boolean) {
  return (ctx: any) => (legacy(ctx) ? { action: 'end' as const } : undefined)
}

/** ★1011：直调适配器时的请求上下文（官方要求 normalizeContext() 产出的 TranscriptContext） */
export function toTranscriptCtx(systemPrompt: string, messages: any, tools: any[] = []) {
  return normalizeContext({ systemPrompt, messages, tools } as any)
}
