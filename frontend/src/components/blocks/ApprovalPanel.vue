<script setup lang="ts">
/**
 * 门禁卡（对齐 dsh ApprovalPanel 样式）：输入框位置接管。
 * 琥珀横条 + 圆点 + 模型理由 headline + 命令等宽灰字 + 右侧「拒绝/允许」胶囊按钮。
 */
import { ref } from 'vue'
import { t } from '@/utils/i18n'

const props = defineProps<{
  request_id: string
  question: string
  options?: string[]
  tool?: string
  risk?: 'low' | 'medium' | 'high'
  answered?: boolean
  answeredValue?: string
}>()

const emit = defineEmits<{
  (e: 'respond', payload: { request_id: string; choice: string }): void
}>()

const responded = ref(!!props.answered)
const selected = ref(props.answeredValue || '')

const riskText = { low: 'perm.riskLow', medium: 'perm.riskMedium', high: 'perm.riskHigh' } as const

function handle(choice: string) {
  if (responded.value) return
  responded.value = true
  selected.value = choice
  emit('respond', { request_id: props.request_id, choice })
}
</script>

<template>
  <div class="approval-frame">
    <div class="approval-card" :data-answered="answered || responded || undefined">
      <!-- 琥珀横条 -->
      <div class="approval-strip">
        <span class="approval-dot"></span>
        <span class="approval-strip-text">{{ answered || responded ? t('approval.handled') : t('approval.waiting') }}</span>
        <span v-if="risk" class="approval-risk" :class="`risk-${risk}`">{{ t(riskText[risk]) }}</span>
      </div>

      <!-- 滚动区：理由 + 命令 -->
      <div class="approval-body">
        <div class="approval-headline">{{ question }}</div>
        <div v-if="tool" class="approval-command"><i class="fas fa-terminal"></i>{{ tool }}</div>
      </div>

      <!-- 动作：拒绝 / 允许 -->
      <div class="approval-actions">
        <template v-if="!answered && !responded">
          <button
            v-for="opt in (options && options.length ? options : [t('approval.deny'), t('approval.allowOnce')])"
            :key="opt"
            type="button"
            class="approval-btn"
            :class="opt.includes(t('approval.deny')) || opt === t('approval.deny') ? 'btn-reject' : 'btn-allow'"
            @click="handle(opt)"
          >{{ opt }}</button>
        </template>
        <span v-else class="approval-done"><i class="fas fa-check"></i> {{ selected || answeredValue || t('approval.handled') }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 输入框接管：与 ChatInput 卡同宽同位置，内容交换不跳布局 */
.approval-frame {
  display: flex;
  justify-content: center;
  padding: 8px 0 12px;
}
.approval-card {
  overflow: hidden;
  width: 100%;
  border: 1px solid #f59e0b;
  border-radius: 20px;
  background: #ffffff;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.08);
}
.approval-strip {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 16px;
  background: #fef3c7;
  color: #b45309;
  font-size: 13px;
  line-height: 18px;
}
.approval-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #f59e0b;
}
.approval-risk {
  margin-left: auto;
  font-size: 11px;
  padding: 1px 8px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.7);
}
.risk-low { color: #059669; }
.risk-medium { color: #b45309; }
.risk-high { color: #dc2626; }
.approval-body {
  max-height: 180px;
  overflow-y: auto;
  padding: 12px 16px 6px;
}
.approval-headline {
  color: #111827;
  font-size: 15px;
  font-weight: 500;
  line-height: 24px;
}
.approval-command {
  margin-top: 6px;
  color: #6b7280;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 13px;
  line-height: 20px;
  word-break: break-all;
}
.approval-command i {
  margin-right: 8px;
  font-size: 11px;
  color: #9ca3af;
}
.approval-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 14px 16px;
}
.approval-btn {
  padding: 6px 16px;
  border-radius: 999px;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s ease;
}
.btn-reject {
  border: 1px solid #d1d5db;
  background: #ffffff;
  color: #374151;
}
.btn-reject:hover:not(:disabled) {
  background: #fef2f2;
  color: #dc2626;
  border-color: transparent;
}
.btn-allow {
  border: 1px solid #111827;
  background: #111827;
  color: #ffffff;
}
.btn-allow:hover:not(:disabled) {
  background: #1f2937;
}
.approval-done {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: #059669;
  font-size: 13px;
}
</style>
