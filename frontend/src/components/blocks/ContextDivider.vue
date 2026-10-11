<script setup lang="ts">
/**
 * ContextDivider —— 上下文压缩的内联分隔线（黑/灰/白，克制低调）。
 *  compacting：小转圈 +「正在整理较早的对话…」（压缩是请求前的一次额外 LLM 调用，给点即时反馈）
 *  compacted ：—— 上下文已压缩 —— 分隔线（本轮内保留，刷新后消失；不影响历史消息本身）
 *  info      ：系统/注入类提示。
 *   ★ 0923（实测反馈）：后台任务通知、自动续跑、回访这类「给模型看的长指令」原来把**全文**
 *     摊在分隔线上（用户原话：『太完整了，长篇大论』）⇒ 现在超过 60 字默认**只留一行摘要**，
 *     点一下才展开全文。短提示（轮次上限之类）保持原来的分隔线样子，不变。
 */
import { ref, computed } from 'vue'
import type { PiNode } from '@/stores/piChat'
import { t } from '@/utils/i18n'
const props = defineProps<{ node: PiNode }>()

/** 折叠状态（默认收起；组件是每个 notice 一个实例，滚动复用不会串） */
const open = ref(false)
/** 全文：noticeText 优先（注入类原文存这儿），兜底 text */
const full = computed(() => String(props.node.noticeText || props.node.text || '').trim())
/** 超过这个长度算「长篇」→ 收成一行（短提示完全不动，保持原样式） */
const FOLD_AT = 60
const isLong = computed(() => props.node.noticePhase === 'info' && full.value.length > FOLD_AT)

/** 一行摘要：优先取「【标记】」，再补最有用的那点信息（第 N/M 次 / 任务结果开头） */
const summary = computed(() => {
  const s = full.value.replace(/\s+/g, ' ').trim()
  const m = s.match(/^【([^】]{1,24})】/)
  if (!m) return s.slice(0, 40) + (s.length > 40 ? '…' : '')
  let out = '【' + m[1].replace(/\s*·\s*/g, '·').replace(/^自动续跑·/, '') .replace(/^收尾$/, '后台任务收尾') + '】'
  const nth = s.match(/第\s*\d+\s*\/\s*\d+\s*次/)
  const rest = s.slice(m[0].length).trim()
  if (nth) {
    /* ★0930（反馈"折叠行只剩标记+次数看不出哪个任务"→"太长了"）：折叠行=「任务名+摘要+次数」，
       状态压进标记不重复：行首「后台任务」剥掉；状态词与标记一致时也剥（标记里已有），
       不一致（失败/已取消）才保留——别把失败显示成完成。套话（这一轮由…）按空行截掉不带。 */
    const seg = /结果如下：\s*([\s\S]*?)(?:\n\s*\n|$)/.exec(full.value)
    let line = seg ? seg[1].replace(/\s+/g, ' ').trim().replace(/^后台任务/, '') : ''
    if (/^完成[：:]/.test(line) && m[1].includes('完成')) line = line.replace(/^完成[：:]\s*/, '')
    if (line) out += ' ' + line.slice(0, 28) + (line.length > 28 ? '…' : '')
    out += ' · ' + nth[0]
  }
  // 后台任务通知/回访：后面跟的是「任务名 + 结果」摘要，带出来更有用
  // 自动续跑：后面全是给模型的指令（继续做下一步…），对用户没信息量，不带
  else if (rest && !m[1].includes('自动续跑')) out += ' ' + rest.slice(0, 36) + (rest.length > 36 ? '…' : '')
  return out
})
</script>

<template>
  <div class="ctx-divider" :class="{ 'is-folded': isLong }">
    <template v-if="node.noticePhase === 'compacting'">
      <span class="cd-spin" aria-hidden></span>
      <span class="cd-text">{{ t('divider.compacting') }}</span>
    </template>
    <!-- 0908七：系统/注入提示。★ 0923：长文收成一行（点开看全文） -->
    <template v-else-if="node.noticePhase === 'info'">
      <button v-if="isLong" class="cd-fold" :class="{ 'is-open': open }" :title="open ? t('divider.foldHide') : t('divider.foldShow')" @click="open = !open">
        <span class="cd-line"></span>
        <span class="cd-fold-text">{{ summary }}</span>
        <span class="cd-line"></span>
      </button>
      <template v-else>
        <span class="cd-line"></span>
        <span class="cd-text">{{ full }}</span>
        <span class="cd-line"></span>
      </template>
    </template>
    <!-- 0909⑨：插话已注入=胶囊提示（重试过程块同款样式），标记上方被截断的轮已引导至新对话 -->
    <template v-else-if="node.noticePhase === 'steer'">
      <span class="cd-pill">
        <svg viewBox="0 0 20 20" width="13" height="13" aria-hidden>
          <path d="M4 10h11M11 6l4 4-4 4" fill="none" stroke="#6b7280" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        {{ t('divider.steered') }}
      </span>
    </template>
    <template v-else>
      <span class="cd-line"></span>
      <span class="cd-text">{{ t('divider.compacted') }}</span>
      <span class="cd-line"></span>
    </template>
    <!-- ★ 0923：展开后的全文（占满一行，小字灰底，限高可滚） -->
    <div v-if="isLong && open" class="cd-full">{{ full }}</div>
  </div>
</template>

<style scoped>
.ctx-divider {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  margin: 8px 0;
  user-select: none;
  color: #9ca3af;
  font-size: 11px;
  animation: cd-in 0.25s ease-out;
}
/* ★ 0923：折叠态要允许换行（摘要一行 + 展开的全文另起一行占满宽） */
.ctx-divider.is-folded { flex-wrap: wrap; }
/* 0909⑨：插话胶囊——RetryNotice 同款形态（圆角胶囊/13px/300/浅灰底），标记上方轮次被插话引导 */
.cd-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 11px;
  border-radius: 9999px;
  font-size: 13px;
  font-weight: 300;
  background: rgba(0, 0, 0, 0.035);
  border: 1px solid rgba(0, 0, 0, 0.06);
  color: #6b7280;
}
html.dark .cd-pill {
  background: rgba(255, 255, 255, 0.05);
  border-color: rgba(255, 255, 255, 0.09);
  color: #9ca3af;
}
.cd-pill svg { flex-shrink: 0; }
html.dark .cd-pill svg path { stroke: #9ca3af; }
@keyframes cd-in { from { opacity: 0; } to { opacity: 1; } }
.cd-line {
  height: 1px;
  width: 42px;
  background: linear-gradient(90deg, transparent, #d1d5db, transparent);
  flex-shrink: 0;
}
.cd-text { color: #9ca3af; letter-spacing: 0.02em; text-align: center; }

/* ★ 0923：一行摘要（可点）——尽量不抢眼，与既有分隔线同一套灰 */
.cd-fold {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  padding: 2px 4px;
  border: 0;
  background: transparent;
  border-radius: 6px;
  cursor: pointer;
  color: #9ca3af;
  font-size: 11px;
  font-family: inherit;
  transition: color 0.15s ease, background 0.15s ease;
}
.cd-fold:hover { color: #6b7280; background: rgba(0, 0, 0, 0.03); }
html.dark .cd-fold:hover { color: #d1d5db; background: rgba(255, 255, 255, 0.05); }
.cd-fold-text {
  max-width: 62vw;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  letter-spacing: 0.02em;
}
/* 展开的全文：小字灰底块，左对齐，限高可滚（别让长指令把时间线撑爆） */
.cd-full {
  flex-basis: 100%;
  width: 100%;
  margin-top: 2px;
  padding: 8px 10px;
  border-radius: 10px;
  background: rgba(0, 0, 0, 0.025);
  color: #6b7280;
  font-size: 11px;
  line-height: 1.6;
  text-align: left;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 168px;
  overflow-y: auto;
  user-select: text;
}
html.dark .cd-full { background: rgba(255, 255, 255, 0.05); color: #9ca3af; }
.cd-spin {
  width: 11px;
  height: 11px;
  border-radius: 50%;
  border: 1.5px solid #d1d5db;
  border-top-color: #4b5563;
  animation: cd-rot 0.8s linear infinite;
}
@keyframes cd-rot { to { transform: rotate(360deg); } }
</style>
