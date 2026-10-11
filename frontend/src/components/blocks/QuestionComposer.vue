<script setup lang="ts">
/**
 * 询问卡（对齐 dsh QuestionComposer）：输入框位置接管。
 * 支持多题分页：questions 数组（>1 题）时显示 pager，每题草稿独立，
 * 中间题"下一步"推进，最后一题"提交"一次性提交全部答案（JSON）。
 * 单题模式保持原有行为（选中后提交）。
 */
import { ref, computed, watch } from 'vue'
import { t } from '@/utils/i18n'

const props = defineProps<{
  request_id: string
  question: string
  options?: string[]
  placeholder?: string
  multiple?: boolean
  answered?: boolean
  answeredValue?: string
  /** 多题模式：一次提问的所有题（{question, options, placeholder}） */
  questions?: any[]
}>()

const emit = defineEmits<{
  (e: 'submit', payload: { request_id: string; value: string }): void
  (e: 'ignore', payload: { request_id: string }): void
}>()

const isMulti = computed(() => Array.isArray(props.questions) && props.questions.length > 1)
const total = computed(() => (isMulti.value ? props.questions!.length : 1))
const index = ref(0)

/**
 * 多题来源区分：
 * - 同 request_id（一次 ask_user 的 questions 数组）→ 分页后最后一次统一提交（JSON）
 * - 不同 request_id（多次独立 ask_user 挂起）→ 每题单独提交（父组件 answerAside 后自动切下一题）
 */
const sameRequest = computed(() => {
  if (!isMulti.value) return true
  const ids = new Set(props.questions!.map(q => q.request_id || props.request_id))
  return ids.size <= 1
})

// 每题独立草稿（多题）；单题用单个。customPicked=自定义答案被显式选中（输入≠选中）
const drafts = ref<Array<{ selected: string[]; custom: string; customPicked: boolean }>>(
  isMulti.value ? props.questions!.map(() => ({ selected: [], custom: '', customPicked: false })) : [{ selected: props.answeredValue ? [props.answeredValue] : [], custom: '', customPicked: false }],
)
const done = ref(false)

const current = computed(() => {
  if (isMulti.value) return props.questions![index.value] || {}
  return { question: props.question, options: props.options, placeholder: props.placeholder, multiple: props.multiple }
})
const draft = computed(() => drafts.value[index.value] || { selected: [], custom: '', customPicked: false })
const isMultiple = computed(() => current.value.multiple && (current.value.options?.length || 0) > 1)
const hasAnswer = computed(() => draft.value.selected.length > 0 || draft.value.custom.trim() !== '')

// 输入内容清空时自动取消选中（输入≠选中：是否采用由点击指示器显式切换）
watch(() => draft.value.custom, (v) => { if (!v) draft.value.customPicked = false })

function toggleOption(opt: string) {
  if (done.value) return
  // 单选互斥：选择选项即取消自定义采用（用户输入=一个选项，二选一）
  if (!isMultiple.value) draft.value.customPicked = false
  if (isMultiple.value) {
    draft.value.selected = draft.value.selected.includes(opt)
      ? draft.value.selected.filter(x => x !== opt)
      : [...draft.value.selected, opt]
  } else {
    draft.value.selected = [opt]
  }
}
/** 采用/取消自定义答案（单选互斥：采用自定义即清空已选选项） */
function toggleCustomPicked() {
  if (done.value) return
  draft.value.customPicked = !draft.value.customPicked
  if (draft.value.customPicked && !isMultiple.value) draft.value.selected = []
}

/** 收集答案：
 *  多选：已选选项 + 被显式选中的自定义内容合并；
 *  单选：选项与自定义互斥（自定义被采用时 selected 已清空）；
 *  只输入了内容未点采用时，提交视为采用该输入（修复"提交按钮无效"） */
function collectAnswers(): string {
  if (!isMulti.value) {
    if (draft.value.customPicked && draft.value.custom.trim()) return draft.value.custom.trim()
    if (draft.value.selected.length) return draft.value.selected.join(', ')
    return draft.value.custom.trim()
  }
  const answers = props.questions!.map((q, i) => {
    const d = drafts.value[i]
    const parts = [...(d?.selected || [])]
    if (d?.customPicked && d?.custom?.trim()) parts.push(d.custom.trim())
    if (parts.length === 0 && d?.custom?.trim()) parts.push(d.custom.trim())
    return { question: q.question || '', value: parts.join(', ') || '__skip__' }
  })
  return JSON.stringify(answers)
}

function submit(value?: string) {
  if (done.value) return
  if (isMulti.value) {
    // 独立 aside：每题单独提交（父组件应答后 pendingCard 自动切到下一题）
    if (!sameRequest.value) {
      if (!hasAnswer.value) return
      done.value = true
      const parts = [...draft.value.selected]
      if (parts.length === 0 && draft.value.custom.trim()) parts.push(draft.value.custom.trim())
      emit('submit', { request_id: current.value.request_id, value: parts.join(', ') })
      return
    }
    // 同 request_id（一次多题）：中间题"下一步"，最后一题统一提交
    const v = value ?? collectAnswers()
    if (index.value < total.value - 1) {
      if (!hasAnswer.value) return
      index.value += 1
      return
    }
    done.value = true
    emit('submit', { request_id: props.request_id, value: v })
    return
  }
  const v = value ?? collectAnswers()
  if (!v && !hasAnswer.value) return
  done.value = true
  emit('submit', { request_id: props.request_id, value: v })
}

function skip() {
  if (done.value) return
  if (isMulti.value) {
    draft.value.selected = []
    draft.value.custom = ''
    if (!sameRequest.value) {
      done.value = true
      emit('ignore', { request_id: current.value.request_id })
      return
    }
    if (index.value < total.value - 1) {
      index.value += 1
      return
    }
    done.value = true
    emit('submit', { request_id: props.request_id, value: collectAnswers() })
    return
  }
  done.value = true
  emit('ignore', { request_id: props.request_id })
}

function prev() {
  if (index.value > 0) index.value -= 1
}
function next() {
  if (index.value < total.value - 1) index.value += 1
}

/** 折叠/展开询问卡（折叠只留标题行；未回答时显示「待回答」提示） */
const collapsed = ref(false)

function displayLabel(label: string): string {
  return label.replace(/\s*(?:\((?:recommended|推荐)\)|（(?:recommended|推荐)）)\s*$/i, '')
}
function isRecommended(label: string): boolean {
  return /\s*(?:\((?:recommended|推荐)\)|（(?:recommended|推荐)）)\s*$/i.test(label)
}
</script>

<template>
  <div class="qc-frame">
    <div class="qc-card" :data-done="done || undefined">
      <!-- Header -->
      <div class="qc-header">
        <div class="qc-heading">
          <div class="qc-eyebrow">{{ isMulti ? t('question.qIndex', { n: index + 1 }) : current.multiple ? t('question.multiple') : t('question.choose') }}<span v-if="collapsed && !done" class="qc-pending-dot">· {{ t('question.pending') }}</span></div>
          <h3 class="qc-title">{{ current.question }}</h3>
        </div>
        <button
          type="button"
          class="qc-collapse-btn"
          :title="collapsed ? t('question.expandCard') : t('question.collapseCard')"
          @click="collapsed = !collapsed"
        >
          <i :class="['fas fa-chevron-down text-[11px] transition-transform duration-200', collapsed ? 'rotate-180' : '']"></i>
        </button>
      </div>

      <!-- 选项列表（折叠时隐藏） -->
      <template v-if="!collapsed">
      <div v-if="current.options && current.options.length" class="qc-options">
        <button
          v-for="(opt, i) in current.options"
          :key="opt"
          type="button"
          class="qc-option"
          :class="{ 'qc-option-selected': draft.selected.includes(opt), 'qc-option-disabled': done }"
          :disabled="done"
          @click="toggleOption(opt)"
        >
          <span class="qc-indicator">
            <span v-if="isMultiple" class="qc-checkbox" :class="{ 'qc-checked': draft.selected.includes(opt) }">
              <i v-if="draft.selected.includes(opt)" class="fas fa-check text-[10px]"></i>
            </span>
            <span v-else class="qc-number">{{ i + 1 }}</span>
          </span>
          <span class="qc-option-copy">
            <span class="qc-option-label">{{ displayLabel(opt) }}</span>
            <span v-if="isRecommended(opt)" class="qc-badge">{{ t('question.recommended') }}</span>
          </span>
        </button>
      </div>

      <!-- 自定义答案行（输入≠选中：是否采用由点击左侧指示器显式切换；提交时只合并被选中的内容） -->
      <div v-if="current.options && current.options.length" class="qc-custom-row" :class="{ 'qc-active': draft.customPicked }">
        <button
          type="button"
          class="qc-indicator qc-indicator-btn"
          :title="draft.customPicked ? t('question.unpickCustom') : t('question.pickCustom')"
          :disabled="done"
          @click="toggleCustomPicked"
        >
          <span v-if="draft.customPicked" class="qc-number qc-number-picked"><i class="fas fa-check text-[9px]"></i></span>
          <span v-else class="qc-number">+</span>
        </button>
        <input
          v-model="draft.custom"
          class="qc-custom-input"
          :placeholder="current.placeholder || t('question.customPlaceholder')"
          :disabled="done"
          @keydown.enter="submit()"
        />
      </div>

      <!-- 无选项：自由文本 -->
      <textarea
        v-else
        v-model="draft.custom"
        class="qc-textarea"
        :placeholder="current.placeholder || t('question.textPlaceholder')"
        :disabled="done"
        rows="3"
      ></textarea>

      <!-- Footer：多题分页 + 跳过/提交 -->
      <div class="qc-footer">
        <div class="qc-pager" v-if="isMulti">
          <button type="button" class="qc-page-btn" :disabled="index === 0 || done" @click="prev"><i class="fas fa-chevron-left text-[10px]"></i></button>
          <span class="qc-progress">{{ index + 1 }} / {{ total }}</span>
          <button type="button" class="qc-page-btn" :disabled="index >= total - 1 || done" @click="next"><i class="fas fa-chevron-right text-[10px]"></i></button>
        </div>
        <span class="qc-feedback">{{ done ? t('question.submitted') : ' ' }}</span>
        <div class="qc-actions">
          <button type="button" class="qc-btn qc-skip" :disabled="done" @click="skip">{{ t('question.skip') }}</button>
          <button type="button" class="qc-btn qc-submit" :disabled="done || (isMulti ? false : !hasAnswer)" @click="submit()">
            {{ isMulti && index < total - 1 && sameRequest ? t('question.next') : t('ask.submit') }}
          </button>
        </div>
      </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.qc-frame {
  display: flex;
  justify-content: center;
  padding: 6px 0 10px;
  /* ★ 0923（反馈）：打开左侧栏后主区变窄，问题卡此前"不跟着输入框收缩、挤到左侧导航条上"。
     根因：flex 子项默认 min-width:auto —— 被长内容撑开后就不肯收缩。显式归零 + 限制最大宽度。 */
  min-width: 0;
  max-width: 100%;
}
.qc-card {
  display: flex;
  flex-direction: column;
  width: 100%;
  /* ★ 0923：同上 —— 卡片自身也允许收缩；长选项/长英文串换行而不是撑破容器 */
  min-width: 0;
  overflow-wrap: anywhere;
  max-height: min(60vh, 520px);
  padding: 0 0 10px;
  border: 1px solid #e5e7eb;
  border-radius: 20px;
  background: #ffffff;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.08);
  color: #111827;
  overflow: hidden;
}
.qc-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  flex-shrink: 0;
  padding: 20px 16px 0 24px;
}
.qc-collapse-btn {
  flex-shrink: 0;
  width: 26px;
  height: 26px;
  margin-top: 14px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: #9ca3af;
  cursor: pointer;
  display: grid;
  place-items: center;
  transition: background-color 120ms ease, color 120ms ease;
}
.qc-collapse-btn:hover {
  background: #f3f4f6;
  color: #374151;
}
.qc-pending-dot {
  color: #f59e0b;
  font-weight: 500;
  margin-left: 4px;
}
.qc-eyebrow {
  margin-bottom: 5px;
  color: #9ca3af;
  font-size: 11px;
  line-height: 16px;
}
.qc-title {
  margin: 0;
  font-size: 16px;
  line-height: 22px;
  font-weight: 500;
  color: #111827;
}
.qc-options {
  display: flex;
  flex-direction: column;
  gap: 1px;
  margin: 8px 0 0;
  padding: 4px 12px;
  overflow-y: auto;
  overscroll-behavior: contain;
}
.qc-option {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  width: 100%;
  min-height: 40px;
  flex-shrink: 0;
  padding: 8px 12px 8px 8px;
  border: 1px solid transparent;
  border-radius: 12px;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
  transition: background-color 120ms ease, border-color 120ms ease;
}
.qc-option:hover:not(:disabled) {
  background: #f5f7fa;
}
.qc-option-selected {
  background: #f5f7fa;
  border-color: #111827;
}
.qc-option-disabled {
  cursor: default;
}
.qc-indicator {
  display: grid;
  place-items: center;
  flex: 0 0 20px;
  width: 20px;
  height: 20px;
  margin-top: 2px;
}
.qc-number {
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  border-radius: 6px;
  background: #f3f4f6;
  color: #6b7280;
  font-size: 12px;
  font-weight: 500;
  line-height: 18px;
}
.qc-number-picked {
  background: #111827;
  color: #ffffff;
}
.qc-indicator-btn {
  border: none;
  background: transparent;
  padding: 0;
  cursor: pointer;
}
.qc-checkbox {
  display: grid;
  place-items: center;
  width: 14px;
  height: 14px;
  border: 1px solid #9ca3af;
  border-radius: 4px;
  color: #ffffff;
}
.qc-checked {
  border-color: #111827;
  background: #111827;
}
.qc-option-copy {
  min-width: 0;
  flex: 1;
}
.qc-option-label {
  font-size: 14px;
  line-height: 24px;
  font-weight: 500;
}
.qc-badge {
  display: inline-block;
  margin-left: 6px;
  padding: 0 6px;
  border-radius: 6px;
  background: var(--dsw-static-deepseek-50);
  color: var(--dsw-static-deepseek-500);
  font-size: 10px;
  line-height: 16px;
  font-weight: 500;
  vertical-align: 1px;
}
.qc-custom-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  width: 100%;
  min-height: 40px;
  flex-shrink: 0;
  padding: 8px 12px 8px 8px;
  border: 1px solid transparent;
  border-radius: 12px;
  transition: background-color 120ms ease, border-color 120ms ease;
}
.qc-custom-row:hover,
.qc-custom-row:focus-within,
.qc-active {
  background: #f3f4f6;
}
.qc-custom-row:focus-within,
.qc-active {
  border-color: #e5e7eb;
}
.qc-custom-input {
  flex: 1;
  min-width: 0;
  padding: 0;
  border: none;
  outline: none;
  background: transparent;
  color: #111827;
  font: inherit;
  font-size: 14px;
  line-height: 24px;
}
.qc-custom-input::placeholder,
.qc-textarea::placeholder {
  color: #9ca3af;
}
.qc-textarea {
  display: block;
  min-height: 64px;
  margin: 8px 12px 0;
  padding: 8px 12px;
  resize: none;
  border: 1px solid #e5e7eb;
  border-radius: 10px;
  outline: none;
  background: #fafafa;
  color: #111827;
  font: inherit;
  font-size: 14px;
  line-height: 24px;
}
.qc-textarea:focus {
  border-color: #111827;
}
.qc-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-shrink: 0;
  margin-top: 12px;
  padding: 0 10px 0 18px;
}
.qc-pager {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}
.qc-page-btn {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: none;
  border-radius: 999px;
  background: transparent;
  color: #6b7280;
  cursor: pointer;
}
.qc-page-btn:hover:not(:disabled) {
  background: #f3f4f6;
  color: #111827;
}
.qc-page-btn:disabled {
  color: #d1d5db;
  cursor: default;
}
.qc-progress {
  padding: 0 4px;
  color: #4b5563;
  font-size: 13px;
  line-height: 24px;
  font-weight: 500;
  white-space: nowrap;
}
.qc-feedback {
  flex: 1;
  min-height: 16px;
  color: #059669;
  font-size: 11px;
  line-height: 16px;
}
.qc-actions {
  display: flex;
  align-items: center;
  flex-shrink: 0;
  gap: 8px;
}
.qc-btn {
  padding: 6px 16px;
  border-radius: 999px;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s ease;
}
.qc-skip {
  border: 1px solid #d1d5db;
  background: #ffffff;
  color: #6b7280;
}
.qc-skip:hover:not(:disabled) {
  background: #f3f4f6;
}
.qc-submit {
  border: 1px solid #111827;
  background: #111827;
  color: #ffffff;
}
.qc-submit:hover:not(:disabled) {
  background: #1f2937;
}
.qc-btn:disabled {
  opacity: 0.4;
  cursor: default;
}
</style>