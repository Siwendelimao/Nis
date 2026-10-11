<script setup lang="ts">
import { ref, watch } from 'vue'
import { t } from '@/utils/i18n'
import { aiExtract } from '@/utils/aiExtract'
import type { AIExtractFields } from '@/utils/aiExtract'
import { useKnowledgeStore } from '@/stores/knowledge'
import { useNotificationsStore } from '@/stores/notifications'
import { useUiStore } from '@/stores/ui'
import { useModalLayer } from '@/utils/modalStack'

/**
 * AI 提炼弹窗：输入一段文字或 URL → 后端 LLM 结构化抽取 → 用户确认。
 * 结果字段贴知识库固定格式（title/summary/content/entry_type/tags/source_label）。
 * directSave=true（气泡「存入知识库」）：确认后直接入库，不经过知识库表单。
 */
const props = defineProps<{
  open: boolean
  /** 预填的提炼内容（气泡「存入知识库」传入） */
  prefill?: string
  /** 直接保存模式：确认后调 addEntry 入库并关闭（不 emit apply） */
  directSave?: boolean
}>()

const emit = defineEmits<{
  close: []
  apply: [fields: AIExtractFields]
}>()

const isAnimating = ref(false)
const isClosing = ref(false)
const showModal = ref(false)

watch(() => props.open, (val) => {
  if (val) {
    isClosing.value = false
    showModal.value = true
    isAnimating.value = true
    setTimeout(() => { isAnimating.value = false }, 350)
    reset()
    if (props.prefill) sourceText.value = props.prefill
  }
})

function close() {
  isClosing.value = true
  isAnimating.value = true
  setTimeout(() => {
    if (props.open && !isClosing.value) return  /*0927 netfix close-reopen-guard v3：正常关闭放行（isClosing 仍 true）；中途被重开（open watch 复位）则旧定时器作废 */
    showModal.value = false
    isAnimating.value = false
    isClosing.value = false
    emit('close')
  }, 250)
}

/* Esc：登记成独立一层 —— 它经常盖在知识库之上，按 Esc 只关自己。 */
useModalLayer(() => props.open, () => {
  close()
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
})

// ── 状态 ──
type Phase = 'input' | 'loading' | 'result' | 'error'
const phase = ref<Phase>('input')
const sourceText = ref('')
const errorMsg = ref('')
/** 2026-09-12：错误原因是「没有可用的后台模型」→ 错误区给「去选择模型」一键跳转 */
const needModel = ref(false)
const llmUsed = ref(false)
const result = ref<AIExtractFields>({ title: '', summary: '', content: '', entry_type: 'doc', tags: [], source_label: '' })

function reset() {
  sourceText.value = ''
  errorMsg.value = ''
  needModel.value = false
  phase.value = 'input'
  llmUsed.value = false
}

async function runExtract() {
  const text = sourceText.value.trim()
  if (!text) return
  phase.value = 'loading'
  const isUrl = /^https?:\/\//i.test(text)
  const res = await aiExtract(isUrl ? 'url' : 'text', text)
  if (!res) {
    phase.value = 'error'
    errorMsg.value = t('aiExtract.needBackend')
    return
  }
  if (res.ok && res.fields) {
    result.value = res.fields
    llmUsed.value = !!res.llm_used
    phase.value = 'result'
  } else {
    phase.value = 'error'
    needModel.value = !!res.needModel
    errorMsg.value = res.msg || t('aiExtract.failed')
    /* ★1012t（已定案："提炼的时候触发了，全局模型要是没费用了或者报错，要发一条系统通知"）：
       提炼失败除了弹窗里那行错误，**再落一条系统通知**（侧边栏铃铛面板）——
       弹窗一关错误就没了，通知中心能留住现场（含错误原文），事后可查。 */
    useNotificationsStore().pushSystem({
      title: t('aiExtract.failNotifyTitle'),
      message: errorMsg.value,
      level: 'error',
      category: 'error',
    })
  }
}

/** 索引跳转：去「设置 → 人格 → 后台模型」选择（先关本弹窗，避免盖住设置页） */
function goPickModel() {
  useUiStore().openSettings('persona')
  close()
}

function apply() {
  if (props.directSave) {
    const store = useKnowledgeStore()
    store.addEntry({
      title: result.value.title,
      summary: result.value.summary,
      content: result.value.content,
      entry_type: result.value.entry_type,
      tags: result.value.tags,
      source_label: result.value.source_label,
      parent_id: '',
      project_id: '',
    })
    useNotificationsStore().push({
      id: `ai-saved-${Date.now()}`,
      level: 'success',
      title: t('aiExtract.savedTitle'),
      message: t('aiExtract.savedMsg'),
      actions: [],
      time: '',
      duration: 4000,
    })
    close()
    return
  }
  emit('apply', { ...result.value })
  close()
}

const TYPE_OPTIONS = [
  { value: 'doc', labelKey: 'knowledge.type.doc' },
  { value: 'manual', labelKey: 'knowledge.type.manual' },
  { value: 'note', labelKey: 'knowledge.type.note' },
  { value: 'reference', labelKey: 'knowledge.type.reference' },
]

</script>

<template>
  <Teleport to="body">
    <div
      v-if="showModal"
      class="fixed inset-0 z-[70] bg-black/40 flex items-center justify-center"
      @click.self="close"
    >
      <div
        :class="['bg-white rounded-[20px] shadow-[0_24px_70px_-20px_rgba(0,0,0,0.4)] border-[1.5px] border-gray-200 w-[478px] max-h-[82vh] flex flex-col overflow-hidden', isAnimating && !isClosing ? 'mini-in' : '', isClosing ? 'mini-out' : '']"
      >
        <!-- 头部 -->
        <div class="px-5 pt-4 pb-3 border-b-[1.5px] border-gray-100 flex items-center justify-between shrink-0">
          <h2 class="text-sm font-bold text-gray-900 flex items-center gap-2">
            <i class="fas fa-wand-magic-sparkles text-gray-700 text-sm"></i>{{ t('aiExtract.title') }}
          </h2>
          <button @click="close" class="w-7 h-7 flex items-center justify-center rounded-full bg-gray-100 text-gray-400 hover:text-gray-600 hover:bg-gray-200 transition-colors">
            <i class="fas fa-times text-xs"></i>
          </button>
        </div>

        <!-- 输入阶段 -->
        <div v-if="phase === 'input'" class="p-5 flex flex-col gap-3">
          <p class="text-[11px] text-gray-400 leading-relaxed">{{ t('aiExtract.hint') }}</p>
          <textarea
            v-model="sourceText"
            rows="8"
            class="w-full bg-gray-50 border border-gray-200 rounded-xl px-3.5 py-3 text-xs text-gray-800 outline-none focus:border-gray-400 resize-none leading-relaxed"
            :placeholder="t('aiExtract.placeholder')"
          ></textarea>
          <div class="flex gap-2">
            <button
              @click="runExtract"
              :disabled="!sourceText.trim()"
              class="flex-1 btn btn-primary btn-sm"
            >
              <i class="fas fa-wand-magic-sparkles text-[10px]"></i>{{ t('aiExtract.run') }}
            </button>
          </div>
        </div>

        <!-- 加载中 -->
        <div v-else-if="phase === 'loading'" class="p-10 flex flex-col items-center gap-4">
          <div class="w-12 h-12 rounded-full border-2 border-gray-200 border-t-gray-800 animate-spin"></div>
          <p class="text-xs text-gray-500">{{ t('aiExtract.loading') }}</p>
        </div>

        <!-- 出错 -->
        <div v-else-if="phase === 'error'" class="p-8 flex flex-col items-center gap-3">
          <div class="w-12 h-12 rounded-full bg-red-50 text-red-400 flex items-center justify-center">
            <i class="fas fa-circle-exclamation text-lg"></i>
          </div>
          <p class="text-xs text-gray-600 text-center">{{ errorMsg }}</p>
          <div class="flex gap-2 mt-1">
            <button v-if="needModel" @click="goPickModel" class="btn btn-primary btn-sm">{{ t('extract.goPickModel') }}</button>
            <button @click="phase = 'input'" class="btn btn-secondary btn-sm">{{ t('aiExtract.back') }}</button>
          </div>
        </div>

        <!-- 结果确认 -->
        <div v-else class="flex-1 min-h-0 flex flex-col">
          <div class="flex-1 overflow-y-auto custom-scroll p-5 space-y-3">
            <div class="flex items-center justify-between">
              <span class="text-[10px] px-2 py-0.5 rounded-full font-[640] bg-gray-100 text-gray-600 border border-gray-200">
                {{ llmUsed ? t('aiExtract.byLlm') : t('aiExtract.fallback') }}
              </span>
            </div>
            <div>
              <label class="block text-[11px] font-[640] text-gray-500 mb-1">{{ t('aiExtract.f.title') }}</label>
              <input v-model="result.title" class="w-full bg-white border border-gray-200 rounded-lg px-3 py-2 text-xs text-gray-800 outline-none focus:border-gray-400" />
            </div>
            <div>
              <label class="block text-[11px] font-[640] text-gray-500 mb-1">{{ t('aiExtract.f.type') }}</label>
              <div class="flex flex-wrap gap-1.5">
                <button
                  v-for="opt in TYPE_OPTIONS" :key="opt.value"
                  @click="result.entry_type = opt.value"
                  :class="[
                    'text-[11px] px-3 py-1.5 rounded-full border transition-colors',
                    result.entry_type === opt.value
                      ? 'bg-black text-white border-black'
                      : 'bg-white text-gray-500 border-gray-200 hover:border-gray-300',
                  ]"
                >{{ t(opt.labelKey) }}</button>
              </div>
            </div>
            <div>
              <label class="block text-[11px] font-[640] text-gray-500 mb-1">{{ t('aiExtract.f.summary') }}</label>
              <input v-model="result.summary" class="w-full bg-white border border-gray-200 rounded-lg px-3 py-2 text-xs text-gray-800 outline-none focus:border-gray-400" />
            </div>
            <div>
              <label class="block text-[11px] font-[640] text-gray-500 mb-1">{{ t('aiExtract.f.content') }}</label>
              <textarea v-model="result.content" rows="5" class="w-full bg-white border border-gray-200 rounded-lg px-3 py-2 text-xs text-gray-800 outline-none focus:border-gray-400 resize-none leading-relaxed"></textarea>
            </div>
            <div>
              <label class="block text-[11px] font-[640] text-gray-500 mb-1">{{ t('aiExtract.f.tags') }}</label>
              <input
                :value="result.tags.join(', ')"
                @input="result.tags = ($event.target as HTMLInputElement).value.split(/[,，]/).map(s => s.trim()).filter(Boolean).slice(0, 6)"
                class="w-full bg-white border border-gray-200 rounded-lg px-3 py-2 text-xs text-gray-800 outline-none focus:border-gray-400"
                :placeholder="t('aiExtract.f.tagsPlaceholder')"
              />
            </div>
            <div>
              <label class="block text-[11px] font-[640] text-gray-500 mb-1">{{ t('aiExtract.f.source') }}</label>
              <input v-model="result.source_label" class="w-full bg-white border border-gray-200 rounded-lg px-3 py-2 text-xs text-gray-800 outline-none focus:border-gray-400" />
            </div>
          </div>
          <div class="px-5 py-4 border-t-[1.5px] border-gray-100 flex gap-2 shrink-0">
            <button @click="phase = 'input'" class="btn btn-secondary btn-sm">{{ t('aiExtract.back') }}</button>
            <button @click="apply" class="flex-1 btn btn-primary btn-sm">
              <i class="fas fa-check text-[10px] mr-1"></i>{{ t('aiExtract.apply') }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.mini-in { animation: miniIn 0.3s cubic-bezier(0.34, 1.6, 0.64, 1) forwards; }
.mini-out { animation: miniOut 0.22s cubic-bezier(0.4, 0, 0.2, 1) forwards; }
@keyframes miniIn {
  0% { opacity: 0; transform: scale(0.9) translateY(12px); }
  100% { opacity: 1; transform: scale(1) translateY(0); }
}
@keyframes miniOut {
  0% { opacity: 1; transform: scale(1); }
  100% { opacity: 0; transform: scale(0.92) translateY(10px); }
}
</style>
