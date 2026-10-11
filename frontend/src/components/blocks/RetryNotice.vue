<script setup lang="ts">
/**
 * RetryNotice —— LLM 调用重试过程块（黑/灰/白配色，与对话过程块风格一致）。
 * 两态设计（分析结论：需要过程态 + 完成态）：
 *  - 过程态 phase=retry：折线流动 spinner（复用计时同款动画）+「模型响应异常，正在重试 n/m」+原因，
 *    持续可见，直到本轮成功恢复或彻底失败——否则用户无法区分"慢"与"卡死"。
 *  - 完成态 recovered：深色对勾「连接已恢复」，store 在 ~2.4s 后自动移除（短暂反馈，不残留）。
 *  - 完成态 failed：琥珀告警「多次重试仍失败」，保留到本轮结束（错误需被看见）。
 */
import { computed, onUnmounted, ref, watch } from 'vue'
import type { PiNode } from '@/stores/piChat'
import { t } from '@/utils/i18n'

const props = defineProps<{ node: PiNode }>()

const phase = computed(() => props.node.retryPhase || 'retry')
const attempt = computed(() => props.node.retryAttempt || 1)
const max = computed(() => props.node.retryMax || 2)
const reason = computed(() => (props.node.retryReason || '').trim())
/** 本次退避等待秒数（后端 delayMs → 秒；缺失=0 不显示） */
const waitSec = computed(() => Math.round(Number((props.node as any).retryDelayMs || 0) / 1000))

/* 0909⑥：重试计时——阶梯退避最长 120s，用户盯着"正在重试"不知道还要等多久。
   本组件挂载=过程块出现=重试开始，本地秒 tick 计数（不用 Date.now 墙钟差：本机时钟加速坑，
   与 ChatInterface 本轮计时同款）。退避等待与请求尝试都算在内，恢复/失败即冻结末值。 */
const secs = ref(0)
/** 0911 反馈：本档单独计时——每次重试轮次（attempt）变化即重置；总时长 secs 照旧累计 */
const attemptSecs = ref(0)
let tickTimer: ReturnType<typeof setInterval> | null = null
function startTick() {
  if (tickTimer) return
  tickTimer = setInterval(() => { secs.value++; attemptSecs.value++ }, 1000)
}
function stopTick() {
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null }
}
if (phase.value === 'retry') startTick()
watch(phase, (p) => { if (p === 'retry') startTick(); else stopTick() }, { immediate: true })
watch(attempt, () => { attemptSecs.value = 0 })
onUnmounted(stopTick)
const elapsed = computed(() => {
  const s = secs.value
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
})
/** 本档进度：退避等待期 = 已等/本档秒数（如 3/5s）；
 *  0911 反馈1：等待结束进入请求执行期 = 「请求中 n s」——原先只显示裸秒数（14s），
 *  用户会误读成"第 1 轮没结束/没叠轮"。轮次只在"本次请求也失败后"才叠（后端逐次递增下发）。 */
const attemptProgress = computed(() => {
  if (!waitSec.value) return `${attemptSecs.value}s`
  return attemptSecs.value <= waitSec.value ? `${attemptSecs.value}/${waitSec.value}s` : `请求中 ${attemptSecs.value}s`
})
</script>

<template>
  <div class="retry-notice" :class="'rn-' + phase">
    <!-- 过程态：折线流动动画（黑灰） -->
    <span v-if="phase === 'retry'" class="rn-wave" aria-hidden>
      <svg viewBox="0 0 64 48" width="22" height="14">
        <polyline class="rw-back" points="0.157 23.954, 14 23.954, 21.843 48, 43 0, 50 24, 64 24" />
        <polyline class="rw-front" points="0.157 23.954, 14 23.954, 21.843 48, 43 0, 50 24, 64 24" />
      </svg>
    </span>
    <!-- 完成态-恢复：对勾 -->
    <svg v-else-if="phase === 'recovered'" class="rn-ico" viewBox="0 0 20 20" width="16" height="16" aria-hidden>
      <circle cx="10" cy="10" r="9" fill="none" stroke="#9ca3af" stroke-width="1.5" />
      <path d="M6 10.5l2.5 2.5L14 7.5" fill="none" stroke="#111827" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
    <!-- 完成态-失败：告警 -->
    <svg v-else class="rn-ico" viewBox="0 0 20 20" width="16" height="16" aria-hidden>
      <path d="M10 2.5l8 14.5H2z" fill="none" stroke="#b45309" stroke-width="1.5" stroke-linejoin="round" />
      <path d="M10 8v4" stroke="#b45309" stroke-width="1.6" stroke-linecap="round" />
      <circle cx="10" cy="14.4" r="0.9" fill="#b45309" />
    </svg>

    <span class="rn-text">
      <template v-if="phase === 'retry'">{{ t('retry.retry', { attempt, max }) }}</template>
      <template v-else-if="phase === 'recovered'">{{ t('retry.recovered') }}</template>
      <template v-else>{{ t('retry.failed') }}</template>
    </span>
    <span v-if="phase === 'retry' && reason" class="rn-reason">{{ reason }}</span>
    <!-- 0911 反馈：双时间 = 本档进度（N/5s，attempt 变化即重置）+ 总时长，同一等宽组 -->
    <span v-if="phase === 'retry'" class="rn-meta">{{ attemptProgress }} · {{ t('retry.totalPrefix', { d: elapsed }) }}</span>
  </div>
</template>

<style scoped>
.retry-notice {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 4px 11px;
  border-radius: 9999px;
  /* 13px/300：随过程块家族统一（0903） */
  font-size: 13px;
  font-weight: 300;
  background: rgba(0, 0, 0, 0.035);
  border: 1px solid rgba(0, 0, 0, 0.06);
  color: #6b7280;
  user-select: none;
  animation: rn-in 0.25s ease-out;
}
@keyframes rn-in {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: translateY(0); }
}
.rn-text { font-weight: 300; }
.rn-reason {
  font-size: 13px;
  color: #9ca3af;
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 0911 反馈：等待时长 + 计时合并为一组（等宽 tabular-nums，同基线右对齐） */
.rn-meta {
  font-size: 12px;
  font-family: ui-monospace, 'SF Mono', Consolas, monospace;
  color: #9ca3af;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  margin-left: auto;
  padding-left: 8px;
}
.rn-recovered { color: #374151; }
.rn-failed { color: #b45309; background: rgba(180, 83, 9, 0.06); border-color: rgba(180, 83, 9, 0.18); }

.rn-wave { display: inline-flex; align-items: center; line-height: 0; }
.rn-wave polyline { fill: none; stroke-width: 5; stroke-linecap: round; stroke-linejoin: round; }
.rn-wave .rw-back { stroke: #d1d5db; }
.rn-wave .rw-front {
  stroke: #1f2937;
  stroke-dasharray: 48, 144;
  stroke-dashoffset: 192;
  animation: rn-dash 1.4s linear infinite;
}
@keyframes rn-dash {
  72.5% { opacity: 0; }
  to { stroke-dashoffset: 0; }
}
.rn-ico { flex-shrink: 0; }
</style>
