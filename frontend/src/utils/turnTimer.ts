/* ★1004m-2 本轮计时（模块级单例）—— 实测反馈"计时胶囊不显示/切窗口归零"后的重构：
 *  · 为什么模块级：原来状态在 ChatInterface 组件实例里，切窗口/组件重挂载即丢（归零）；
 *    模块级单例后：切会话、切窗口、多窗口并存都共享同一份计数 —— 不归零、不串台（per-conv 键控）。
 *  · 显示口径：本轮开始（发消息/状态帧起表）即从 0 显示，无 10s 阈值（已定案）。
 *  · 清理口径：只在会话真实终态（agentEnd/aborted/stopped，与 finalizeStreaming 同判据）清表；
 *    全部计数清空后停 tick 定时器（零开销）。
 *  ⚠️ 只按秒级 tick 累计，**不用墙钟差**——本机时钟为加速/模拟时钟（曾致"15 秒的活显示 3 分"）。 */
import { ref } from 'vue'

const seconds = ref<Record<string, number>>({})
const tick = ref(0)
let timer: ReturnType<typeof setInterval> | null = null

function ensureTimer() {
  if (timer) return
  timer = setInterval(() => {
    const cur = seconds.value
    for (const k of Object.keys(cur)) cur[k]++
    tick.value++
  }, 1000)
}

/** 起表（幂等：已在计时的会话不归零） */
export function startTurnTimer(convKey: string): void {
  if (!convKey) return
  if (seconds.value[convKey] == null) seconds.value[convKey] = 0
  ensureTimer()
}

/** 清表（会话真实终态时调用；全部清空后停定时器） */
export function stopTurnTimer(convKey: string): void {
  if (convKey) delete seconds.value[convKey]
  if (Object.keys(seconds.value).length === 0 && timer) {
    clearInterval(timer)
    timer = null
  }
}

/** 当前计秒（未起表=null） */
export function turnSecondsOf(convKey: string): number | null {
  const v = seconds.value[convKey]
  return v == null ? null : v
}

export function syncTurnTimer(convKey: string, sec: number | null | undefined): void {
  if (!convKey || sec == null) return
  seconds.value[convKey] = Math.max(0, Math.floor(Number(sec) || 0))
  tick.value++
  ensureTimer()
}

/** 响应式 tick（computed 里 void 一下即可随秒刷新） */
export const turnTimerTick = tick
