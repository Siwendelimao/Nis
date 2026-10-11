<script setup lang="ts">
/**
 * ExternalStream —— 外部会话 part 流原生渲染（P0 契约 1010）。
 * 输入：PartEvent[]（live 帧与回放 extTranscript 同一形状、同一渲染路径——刷新回放=重放 parts，天然不乱序）。
 * 三类块复用现有零件（契约硬要求，不得另造）：
 *   正文块 = markdown 渲染，照抄 PiChatView 正文口径：定稿 MarkdownText / 过程态 StreamingTail；
 *   思考块 = ReasoningBlock（可折叠；run 首尾 part.t 推出耗时，刷新回放也带计时）；
 *   工具块 = ToolPartBlock（tool-start/tool-end 按 id 对号，成对合一行）。
 * usage/turn-end 轻量：收轮时一行用量（契约明示不强求圆环）。
 */
import { computed } from 'vue'
import type { PartEvent } from '@/stores/externalChat'
import MarkdownText from './blocks/MarkdownText.vue'
import StreamingTail from './blocks/StreamingTail.vue'
import ReasoningBlock from './blocks/ReasoningBlock.vue'
import ToolPartBlock from './blocks/ToolPartBlock.vue'

const props = defineProps<{ parts: PartEvent[] }>()

interface UsageRow { inputTokens: number; cachedReadTokens: number; completionTokens: number; thoughtTokens?: number }
type Row =
  | { kind: 'text'; key: string; text: string; open: boolean }
  | { kind: 'thought'; key: string; text: string; open: boolean; t0: number; elapsedMs: number }
  | { kind: 'tool'; key: string; id: string; name: string; summary: string; detail: string; isError: boolean; ended: boolean }
  | { kind: 'info'; key: string; text: string }
  | { kind: 'turn'; key: string; stopReason: string; ok: boolean; reason: string; usage: UsageRow | null }

/* PartEvent[] → 渲染行：连续 text/thought delta 合并成一个 run；tool-start/end 按 id 合一行；
   usage 记到随后的 turn-end 行（收轮一行用量）。纯函数式（live 与回放同一渲染函数）。 */
const rows = computed<Row[]>(() => {
  const out: Row[] = []
  const toolIdx = new Map<string, number>()
  let pendingUsage: UsageRow | null = null
  let run: { kind: 'text' | 'thought'; text: string; t0: number; t1: number; seq0: number } | null = null
  const closeRun = () => {
    if (!run) return
    out.push(run.kind === 'text'
      ? { kind: 'text', key: 'text:' + run.seq0, text: run.text, open: false }
      : { kind: 'thought', key: 'thought:' + run.seq0, text: run.text, open: false, t0: run.t0, elapsedMs: Math.max(0, run.t1 - run.t0) })
    run = null
  }
  for (const p of props.parts || []) {
    if (p.kind === 'text' || p.kind === 'thought') {
      if (run && run.kind === p.kind) { run.text += p.delta; run.t1 = p.t }
      else {
        closeRun()
        run = { kind: p.kind, text: p.delta || '', t0: p.t, t1: p.t, seq0: p.seq }
      }
      continue
    }
    closeRun()
    if (p.kind === 'tool-start') {
      toolIdx.set(p.id, out.length)
      out.push({ kind: 'tool', key: 'tool:' + (p.id || p.seq), id: p.id, name: p.name, summary: p.summary, detail: '', isError: false, ended: false })
    } else if (p.kind === 'tool-end') {
      const i = toolIdx.get(p.id)
      const row = i != null ? out[i] : undefined
      if (row && row.kind === 'tool') {
        row.detail = p.detail || ''
        row.isError = !!p.isError
        row.ended = true
      } else {
        // tool-end 先于 tool-start 到（断序补渲已按到序，理论不出现）：自成一行，不丢结果
        out.push({ kind: 'tool', key: 'tool:' + (p.id || p.seq), id: p.id, name: '', summary: '', detail: p.detail || '', isError: !!p.isError, ended: true })
      }
    } else if (p.kind === 'usage') {
      pendingUsage = { inputTokens: p.inputTokens, cachedReadTokens: p.cachedReadTokens, completionTokens: p.completionTokens, thoughtTokens: p.thoughtTokens }
    } else if (p.kind === 'info') {
      out.push({ kind: 'info', key: 'info:' + p.seq, text: p.text })
    } else if (p.kind === 'turn-end') {
      out.push({ kind: 'turn', key: 'turn:' + p.seq, stopReason: p.stopReason, ok: p.ok, reason: p.reason || '', usage: pendingUsage })
      pendingUsage = null
    }
  }
  closeRun()
  // 过程态标记：最后一个 run 尚未被收轮/其它块收口 = 正在流式（live 与回放同路径，回放到进行中轮同样显示过程态）
  for (let i = 0; i < out.length; i++) {
    const r = out[i]
    if (r.kind === 'text' || r.kind === 'thought') r.open = i === out.length - 1
  }
  return out
})

/* 工具块入参：显式函数出参（不用模板内联对象字面量——那是「字段静默丢失」重灾区，1010 已实锤过一次） */
function toolPartOf(r: Extract<Row, { kind: 'tool' }>): Record<string, any> {
  return {
    tool: r.name,
    input: {},
    status: r.ended ? (r.isError ? 'error' : 'completed') : 'running',
    output: r.detail,
    error: r.isError ? r.detail : '',
    call_id: r.id,
    persona: r.summary || r.name,
    memberNames: undefined,
    shell: undefined,
    diffStat: undefined,
    fileSize: undefined,
  }
}
</script>

<template>
  <div class="ext-stream space-y-2">
    <template v-for="r in rows" :key="r.key">
      <!-- 正文块：markdown（同 PiChatView 正文口径） -->
      <div v-if="r.kind === 'text'" class="text-[14px] leading-normal">
        <StreamingTail v-if="r.open" :text="r.text.replace(/\s+$/, '')" />
        <MarkdownText v-else :text="r.text" />
      </div>
      <!-- 思考块：复用 ReasoningBlock（可折叠；start-time/elapsed-ms 由 run 首尾 part.t 推出） -->
      <ReasoningBlock
        v-else-if="r.kind === 'thought'"
        :content="r.text"
        :streaming="r.open"
        :start-time="r.t0"
        :elapsed-ms="r.open ? 0 : r.elapsedMs"
      />
      <!-- 工具块：复用 ToolPartBlock（tool-start/tool-end 按 id 对号） -->
      <ToolPartBlock v-else-if="r.kind === 'tool'" :part="toolPartOf(r)" :desc="r.summary || r.name" />
      <!-- info：元数据/警告轻量行（契约：Warning:/Error: 类正文块归 info，不进正文） -->
      <div v-else-if="r.kind === 'info'" class="ext-info">{{ r.text }}</div>
      <!-- 收轮：一行轻量用量（契约明示不强求圆环） -->
      <div v-else class="ext-turn">
        <span :class="r.ok ? 'ext-turn-ok' : 'ext-turn-bad'">{{ r.ok ? '✓' : '⚠' }}</span>
        <span class="ext-turn-reason">{{ r.stopReason }}</span>
        <span v-if="r.reason"> · {{ r.reason }}</span>
        <template v-if="r.usage">
          <span class="ext-usage">
            · 输入 {{ r.usage.inputTokens.toLocaleString() }}（缓存 {{ r.usage.cachedReadTokens.toLocaleString() }}）
            · 输出 {{ r.usage.completionTokens.toLocaleString() }}<template v-if="r.usage.thoughtTokens"> · 思考 {{ r.usage.thoughtTokens.toLocaleString() }}</template>
          </span>
        </template>
      </div>
    </template>
  </div>
</template>

<style scoped>
.ext-stream { min-width: 0; }
.ext-info {
  font-size: 12px;
  line-height: 1.6;
  color: var(--dsw-alias-label-tertiary, #9ca3af);
}
.ext-turn {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px;
  font-size: 11.5px;
  color: var(--dsw-alias-label-tertiary, #9ca3af);
}
.ext-turn-ok { color: #16a34a; }
.ext-turn-bad { color: #dc2626; }
.ext-turn-reason { font-weight: 530; }
.ext-usage { font-variant-numeric: tabular-nums; }
</style>
