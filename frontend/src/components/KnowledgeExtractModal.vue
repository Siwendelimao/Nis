<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { CircleCheck, CircleX, LoaderCircle } from 'lucide-vue-next'
import { t } from '@/utils/i18n'
import { useUiStore } from '@/stores/ui'
import { knowledgeExtract, knowledgeExtractCommit } from '@/utils/knowledgeExtract'
import type { KnowledgeExtractItem, KnowledgeOutcome } from '@/utils/knowledgeExtract'

/**
 * 知识提炼结果弹窗（0913）：先预览候选（不落盘），用户可勾选哪些入库（全选/全不选），
 * 点「保存所选」后写入知识库（knowledge.db）。
 * 与 MemoryExtractModal 同构；差异：条目类型 doc/manual/note/reference，状态只有 新增 / 已存在。
 */
const props = defineProps<{
  open: boolean
  content?: string
  projectRoot?: string
}>()

const emit = defineEmits<{
  close: []
  done: [saved: number]
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
    run()
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

function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && props.open) {
    close()
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
  }
}

onMounted(() => document.addEventListener('keydown', handleKeydown))
onUnmounted(() => document.removeEventListener('keydown', handleKeydown))

type Phase = 'loading' | 'result' | 'committing' | 'done' | 'error'
const phase = ref<Phase>('loading')
const items = ref<KnowledgeExtractItem[]>([])
const savedCount = ref(0)
const errorMsg = ref('')
/** 错误原因是「没有可用的后台模型」→ 错误区给「去选择模型」一键跳转 */
const needModel = ref(false)
const llmUsed = ref(false)
const counts = ref<{ created?: number; already_exists?: number }>({})

/** 三态状态动画 key：每次进终态自增，强制重建 DOM 让 CSS 动画从头播一次 */
const stateAnimKey = ref(0)

// 勾选状态（默认全选）
const selected = ref<Record<number, boolean>>({})
const allSelected = computed(() => {
  const n = items.value.length
  return n > 0 && items.value.every((_, i) => selected.value[i] !== false)
})
const selectedCount = computed(() => items.value.filter((_, i) => selected.value[i] !== false).length)

function toggleAllNone() {
  const all = allSelected.value
  selected.value = {}
  items.value.forEach((_, i) => { selected.value[i] = !all })
}

async function run() {
  phase.value = 'loading'
  needModel.value = false
  items.value = []
  savedCount.value = 0
  counts.value = {}
  selected.value = {}
  const res = await knowledgeExtract(props.content || '', props.projectRoot, { dryRun: true })
  if (!res) {
    phase.value = 'error'
    stateAnimKey.value++
    errorMsg.value = t('knowledgeExtract.needBackend')
    return
  }
  if (res.ok) {
    items.value = res.items
    llmUsed.value = !!res.llm_used
    selected.value = {}
    res.items.forEach((_, i) => { selected.value[i] = true })
    if (!items.value.length) {
      phase.value = 'error'
      stateAnimKey.value++
      errorMsg.value = t('knowledgeExtract.noItem')
      return
    }
    phase.value = 'result'
  } else {
    phase.value = 'error'
    stateAnimKey.value++
    needModel.value = !!res.needModel
    errorMsg.value = res.msg || t('knowledgeExtract.failed')
  }
}

/** 索引跳转：去「设置 → 人格 → 后台模型」选择（先关本弹窗，避免盖住设置页） */
function goPickModel() {
  useUiStore().openSettings('persona')
  close()
}

/** 提交勾选的条目写入知识库 */
async function commit() {
  const chosen = items.value.filter((_, i) => selected.value[i] !== false)
  if (!chosen.length) {
    close()
    return
  }
  phase.value = 'committing'
  const res = await knowledgeExtractCommit(chosen)
  if (!res) {
    phase.value = 'error'
    stateAnimKey.value++
    errorMsg.value = t('knowledgeExtract.needBackend')
    return
  }
  savedCount.value = res.saved
  counts.value = res.counts || {}
  items.value = res.items
  phase.value = 'done'
  stateAnimKey.value++
  emit('done', res.saved)
}

const TYPE_META: Record<string, { icon: string; labelKey: string; cls: string }> = {
  doc: { icon: 'fas fa-file-lines', labelKey: 'knowledgeExtract.type.doc', cls: 'bg-sky-50 text-sky-600 border-sky-100' },
  manual: { icon: 'fas fa-list-check', labelKey: 'knowledgeExtract.type.manual', cls: 'bg-emerald-50 text-emerald-600 border-emerald-100' },
  note: { icon: 'fas fa-note-sticky', labelKey: 'knowledgeExtract.type.note', cls: 'bg-amber-50 text-amber-600 border-amber-100' },
  reference: { icon: 'fas fa-link', labelKey: 'knowledgeExtract.type.reference', cls: 'bg-violet-50 text-violet-600 border-violet-100' },
}

function typeMeta(et: string) {
  return TYPE_META[et] || TYPE_META.note
}

const OUTCOME_META: Record<KnowledgeOutcome, { icon: string; labelKey: string; cls: string }> = {
  created: { icon: 'fas fa-plus', labelKey: 'knowledgeExtract.outcome.created', cls: 'bg-green-50 text-green-600 border-green-200' },
  already_exists: { icon: 'fas fa-check', labelKey: 'knowledgeExtract.outcome.already_exists', cls: 'bg-gray-100 text-gray-500 border-gray-200' },
}

function outcomeMeta(o?: KnowledgeOutcome) {
  if (!o || !OUTCOME_META[o]) return null
  return OUTCOME_META[o]
}
</script>

<template>
  <Teleport to="body">
    <!-- 遮罩：不带 backdrop-blur；不响应点击关闭（提炼弹窗只能点关闭/X） -->
    <div
      v-if="showModal"
      class="fixed inset-0 z-[70] bg-black/25 flex items-center justify-center"
    >
      <div
        :class="['bg-white rounded-[20px] shadow-[0_24px_70px_-20px_rgba(0,0,0,0.4)] border-[1.5px] border-gray-200 w-[497px] max-h-[82vh] flex flex-col overflow-hidden', isAnimating && !isClosing ? 'mini-in' : '', isClosing ? 'mini-out' : '']"
      >
        <!-- 头部 -->
        <div class="px-5 pt-4 pb-2 flex items-center justify-between shrink-0">
          <h2 class="text-sm font-bold text-gray-900">
            {{ t('knowledgeExtract.title') }}
          </h2>
          <button @click="close" class="w-7 h-7 flex items-center justify-center rounded-full bg-gray-100 text-gray-400 hover:text-gray-600 hover:bg-gray-200 transition-colors">
            <i class="fas fa-times text-xs"></i>
          </button>
        </div>

        <!-- 提取中：循环状态动画 -->
        <div v-if="phase === 'loading'" class="px-10 pt-6 pb-12 flex flex-col items-center gap-4">
          <LoaderCircle :size="44" :stroke-width="1.6" class="text-gray-800 mem-spin" />
          <div class="flex flex-col items-center gap-1.5">
            <p class="text-xs text-gray-600">{{ t('knowledgeExtract.loading') }}</p>
            <p class="text-[10px] text-gray-400">{{ t('knowledgeExtract.loadingHint') }}</p>
          </div>
        </div>

        <!-- 出错：一次性失败动画 -->
        <div v-else-if="phase === 'error'" class="px-10 pt-6 pb-10 flex flex-col items-center gap-4">
          <div :key="'err-' + stateAnimKey" class="mem-pop w-14 h-14 rounded-full bg-red-50 text-red-400 flex items-center justify-center">
            <CircleX :size="30" :stroke-width="1.7" />
          </div>
          <div class="flex flex-col items-center gap-1">
            <p class="text-xs font-[640] text-gray-700">{{ t('knowledgeExtract.failTitle') }}</p>
            <p class="text-xs text-gray-500 text-center leading-relaxed">{{ errorMsg }}</p>
          </div>
          <div class="flex gap-2 mt-1">
            <button v-if="needModel" @click="goPickModel" class="btn btn-primary btn-sm">{{ t('extract.goPickModel') }}</button>
            <button @click="close" class="btn btn-secondary btn-sm">{{ t('knowledgeExtract.close') }}</button>
          </div>
        </div>

        <!-- 结果 / 提交中 / 完成 -->
        <div v-else class="flex-1 min-h-0 flex flex-col">
          <div class="px-5 pt-2 pb-1 flex items-center justify-between">
            <span class="text-[11px] text-gray-500">
              {{ llmUsed ? t('knowledgeExtract.byLlm') : t('knowledgeExtract.fallback') }}
            </span>
            <span v-if="phase === 'done'" class="text-[11px] font-[640] text-green-600 inline-flex items-center gap-1">
              <span :key="'ok-' + stateAnimKey" class="mem-pop inline-flex items-center">
                <CircleCheck :size="12" :stroke-width="2.2" />
              </span>
              {{ t('knowledgeExtract.savedPrefix') }} {{ savedCount }} {{ t('knowledgeExtract.savedSuffix') }}
              <template v-if="counts.created != null || counts.already_exists != null">
                <span class="text-gray-400 font-normal ml-1">
                  · {{ t('knowledgeExtract.counts', {
                    c: counts.created ?? 0,
                    k: counts.already_exists ?? 0,
                  }) }}
                </span>
              </template>
            </span>
          </div>

          <!-- 勾选工具条 -->
          <div v-if="phase === 'result'" class="px-5 pt-2 flex items-center justify-between">
            <label class="flex items-center gap-1.5 cursor-pointer select-none text-[11px] text-gray-600">
              <input
                type="checkbox"
                :checked="allSelected"
                @change="toggleAllNone"
                class="accent-black w-3.5 h-3.5"
              />
              {{ t('knowledgeExtract.selectAll') }}
            </label>
            <span class="text-[11px] text-gray-400">{{ t('knowledgeExtract.selected', { n: selectedCount, total: items.length }) }}</span>
          </div>

          <div class="flex-1 overflow-y-auto custom-scroll p-5 pt-2 space-y-2.5">
            <div v-if="!items.length" class="text-center text-xs text-gray-400 py-8">{{ t('knowledgeExtract.noItem') }}</div>
            <div
              v-for="(it, idx) in items"
              :key="idx"
              class="rounded-xl border border-gray-100 bg-white p-3"
              :class="{ 'opacity-50': phase === 'result' && selected[idx] === false }"
            >
              <div class="flex items-start gap-2">
                <input
                  v-if="phase === 'result'"
                  type="checkbox"
                  v-model="selected[idx]"
                  class="accent-black w-3.5 h-3.5 mt-0.5 shrink-0"
                />
                <div class="flex-1 min-w-0">
                  <div class="flex items-center gap-2 mb-1.5">
                    <span :class="['text-[10px] px-2 py-0.5 rounded-full font-[640] border', typeMeta(it.entry_type).cls]">
                      <i :class="[typeMeta(it.entry_type).icon, 'text-[9px] mr-1']"></i>{{ t(typeMeta(it.entry_type).labelKey) }}
                    </span>
                    <span v-if="outcomeMeta(it.outcome)" :class="['text-[10px] px-2 py-0.5 rounded-full font-[640] border', outcomeMeta(it.outcome)!.cls]">
                      <i :class="[outcomeMeta(it.outcome)!.icon, 'text-[9px] mr-1']"></i>{{ t(outcomeMeta(it.outcome)!.labelKey) }}
                    </span>
                  </div>
                  <div class="text-xs font-[640] text-gray-800 mb-1">{{ it.title }}</div>
                  <div class="text-[11px] text-gray-500 leading-relaxed">{{ it.content }}</div>
                  <div v-if="it.tags && it.tags.length" class="mt-1.5 flex flex-wrap gap-1">
                    <span v-for="tg in it.tags" :key="tg" class="text-[10px] px-1.5 py-px rounded-full bg-gray-100 text-gray-500">#{{ tg }}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- 底部：提交所选 -->
          <div class="px-5 pt-3 pb-4 flex gap-2 shrink-0">
            <template v-if="phase === 'result'">
              <button @click="close" class="flex-1 btn btn-secondary btn-sm">{{ t('knowledgeExtract.close') }}</button>
              <button
                @click="commit"
                class="flex-1 btn btn-primary btn-sm"
              >
                <i class="fas fa-check text-[10px] mr-1"></i>{{ t('knowledgeExtract.commit', { n: selectedCount }) }}
              </button>
            </template>
            <template v-else-if="phase === 'committing'">
              <div class="flex-1 text-center text-xs text-gray-500 py-2">
                <i class="fas fa-spinner fa-spin mr-1"></i>{{ t('knowledgeExtract.saving') }}
              </div>
            </template>
            <template v-else-if="phase === 'done'">
              <button @click="close" class="flex-1 btn btn-secondary btn-sm">{{ t('knowledgeExtract.close') }}</button>
              <button @click="close" class="flex-1 btn btn-primary btn-sm">{{ t('knowledgeExtract.finish') }}</button>
            </template>
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

.mem-spin {
  animation: memSpin 0.9s linear infinite;
}
@keyframes memSpin {
  to { transform: rotate(360deg); }
}

.mem-pop {
  animation: memPop 0.5s cubic-bezier(0.34, 1.56, 0.64, 1) both;
}
@keyframes memPop {
  0% { opacity: 0; transform: scale(0.5); }
  55% { opacity: 1; transform: scale(1.12); }
  100% { opacity: 1; transform: scale(1); }
}
</style>
