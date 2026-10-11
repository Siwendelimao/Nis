<script setup lang="ts">
/**
 * 语音设置（0920）—— 设置 → 语音
 *
 * 既定的结构：
 *  · **语音输入**：一个开关（关掉后端立刻释放引擎） + 选模型（增量包，点了才下）
 *  · **朗读**：一个开关（开 → AI 回复下方出现朗读按钮） + **当前模型单选** +
 *    该模型自己的配置（音色 / 语速 / 试听）——切模型各自记住，互不牵扯
 *
 * 模型不进安装包：装到后端 `<envDir>/voice/models`，所以每个模型都要「安装」按钮。
 */
import { computed, onMounted, ref, watch } from 'vue'
import BwSwitch from '../BwSwitch.vue'
import { useVoiceStore } from '@/stores/voice'
import type { VoiceModelState } from '@/stores/voice'
import { t } from '@/utils/i18n'

const voice = useVoiceStore()

const asrModels = computed(() => (voice.state?.models || []).filter((m) => m.kind === 'asr'))
const ttsModels = computed(() => (voice.state?.models || []).filter((m) => m.kind === 'tts'))
const curTts = computed<VoiceModelState | undefined>(() => ttsModels.value.find((m) => m.id === voice.state?.ttsModel))

/** 正在安装的模型 id（进度条显示用） */
const installing = computed(() => (voice.job && voice.job.status === 'running' ? voice.job.targetId : ''))
function jobOf(id: string) {
  return installing.value === id ? voice.job : null
}

function fmtMB(n: number): string {
  if (!n) return '—'
  return n >= 1048576 ? (n / 1048576).toFixed(1) + 'MB' : Math.max(1, Math.round(n / 1024)) + 'KB'
}
/** 清单里的 approxMB 本身就是 MB，别再除以 1024（之前口径混了，显示成 1KB） */
function approxLabel(mb: number): string {
  return mb >= 1024 ? (mb / 1024).toFixed(1) + 'GB' : Math.round(mb) + 'MB'
}
function fmtSpeed(bps: number): string {
  if (!bps) return ''
  return bps >= 1048576 ? (bps / 1048576).toFixed(1) + 'MB/s' : Math.round(bps / 1024) + 'KB/s'
}
function eta(sec: number): string {
  if (!sec) return ''
  return sec >= 60 ? `剩 ${Math.ceil(sec / 60)} 分钟` : `剩 ${sec} 秒`
}

/** 试听中 */
const previewing = computed(() => voice.previewingId === curTts.value?.id)

/** 音色下拉：187 项太多，用原生 select（自带滚动定位）+ 序号标签 */
const voiceOptions = computed(() => curTts.value?.voices || [])

/** 语速（本模型自己的值） */
const speed = computed(() => curTts.value?.speed ?? 1)

async function setAsrEnabled(v: boolean) { await voice.set({ asrEnabled: v }) }
async function setTtsEnabled(v: boolean) { await voice.set({ ttsEnabled: v }) }
async function pickTts(id: string) { await voice.set({ ttsModel: id }) }
async function pickAsr(id: string) { await voice.set({ asrModel: id }) }
async function pickVoice(id: number) { await voice.set({ modelId: curTts.value?.id, sid: id }) }
async function setSpeed(v: number) { await voice.set({ modelId: curTts.value?.id, speed: v }) }

/* 语速滑条：拖动时只在本地反馈，松手才落库（不然每帧一次 RPC） */
const speedDraft = ref(1)
watch(speed, (v) => { speedDraft.value = v }, { immediate: true })
async function commitSpeed() {
  if (Math.abs(speedDraft.value - speed.value) < 0.01) return
  await setSpeed(speedDraft.value)
}

const confirmRemove = ref('')
async function doRemove(id: string) {
  if (confirmRemove.value !== id) { confirmRemove.value = id; return }
  confirmRemove.value = ''
  await voice.remove(id)
}

onMounted(() => { void voice.refresh() })
</script>

<template>
  <div>
    <!-- 顶部：运行时状态（模型都装在这套运行时上） -->
    <div class="flex items-center gap-2 mb-5 px-3 py-2 rounded-lg bg-gray-50">
      <i class="fas fa-microchip text-[11px] text-gray-400"></i>
      <span class="text-[11px] text-gray-500">
        {{ voice.state?.runtimeInstalled ? t('settings.voice.runtimeOk', { v: voice.state?.runtimeVersion || '' }) : t('settings.voice.runtimePending') }}
      </span>
      <span class="ml-auto text-[11px] text-gray-400 truncate" :title="voice.state?.root">{{ voice.state?.root }}</span>
    </div>

    <!-- 错误条 -->
    <div v-if="voice.lastError" class="mb-4 px-3 py-2 rounded-lg text-[12px]" style="background: rgba(239,68,68,.08); color: #dc2626">
      <i class="fas fa-circle-exclamation mr-1.5"></i>{{ voice.lastError }}
    </div>

    <!-- ══════════ 语音输入 ══════════ -->
    <div class="mb-7">
      <div class="flex items-center justify-between mb-2">
        <div>
          <div class="text-[13px] font-[530] text-gray-900">{{ t('settings.voice.asrTitle') }}</div>
          <div class="text-[11px] text-gray-400 mt-0.5">{{ t('settings.voice.asrHint') }}</div>
        </div>
        <BwSwitch :model-value="!!voice.state?.asrEnabled" @update:model-value="setAsrEnabled" />
      </div>

      <div v-if="!voice.state?.asrEnabled" class="text-[11px] text-gray-300 px-3 py-2">{{ t('settings.voice.offHint') }}</div>
      <template v-else>
        <div
          v-for="m in asrModels"
          :key="m.id"
          class="rounded-xl border p-3 mb-2 transition-all cursor-pointer"
          :class="voice.state?.asrModel === m.id ? 'border-gray-900 bg-white' : 'border-gray-200 bg-white hover:border-gray-400'"
          @click="pickAsr(m.id)"
        >
          <div class="flex items-center gap-2">
            <span class="w-3.5 h-3.5 rounded-full border flex items-center justify-center shrink-0" :class="voice.state?.asrModel === m.id ? 'border-gray-900' : 'border-gray-300'">
              <span v-if="voice.state?.asrModel === m.id" class="w-1.5 h-1.5 rounded-full bg-gray-900"></span>
            </span>
            <span class="text-[13px] font-[530] text-gray-900">{{ m.name }}</span>
            <span class="text-[10px] px-1.5 py-[1px] rounded bg-gray-100 text-gray-500">{{ approxLabel(m.approxMB) }}</span>
            <span v-if="m.installed" class="text-[10px] px-1.5 py-[1px] rounded" style="background: rgba(16,185,129,.1); color: #059669">{{ t('settings.voice.installed') }}</span>
            <div class="ml-auto flex items-center gap-2">
              <button
                v-if="!m.installed && !jobOf(m.id)"
                class="px-3 py-1 rounded-lg bg-gray-900 text-white text-[11px] font-[530] hover:opacity-80"
                @click.stop="voice.install(m.id)"
              >{{ t('settings.voice.install') }}</button>
              <span v-else-if="jobOf(m.id)" class="text-[11px] text-gray-400">{{ Math.max(0, Math.round(jobOf(m.id)!.percent)) }}%</span>
              <button
                v-else
                class="px-2 py-1 rounded-lg text-[11px]"
                :class="confirmRemove === m.id ? 'bg-red-500 text-white' : 'text-gray-400 hover:text-red-500'"
                @click.stop="doRemove(m.id)"
              >{{ confirmRemove === m.id ? t('settings.voice.confirmDel') : t('settings.voice.del') }}</button>
            </div>
          </div>
          <div class="text-[11px] text-gray-400 mt-1 ml-[22px]">{{ m.desc }}</div>
          <div v-if="m.installed && m.sizeBytes" class="text-[10px] text-gray-300 mt-0.5 ml-[22px]">{{ t('settings.voice.onDisk') }} {{ fmtMB(m.sizeBytes) }} · {{ m.note }}</div>
          <div v-if="jobOf(m.id)" class="mt-2 ml-[22px]">
            <div class="h-[3px] rounded-full bg-gray-100 overflow-hidden">
              <div class="h-full bg-gray-900 transition-all" :style="{ width: Math.max(0, jobOf(m.id)!.percent) + '%' }"></div>
            </div>
            <div class="flex items-center gap-2 mt-1 text-[10px] text-gray-400">
              <span class="truncate">{{ jobOf(m.id)!.phase }}</span>
              <span v-if="jobOf(m.id)!.speedBps" class="ml-auto shrink-0">{{ fmtSpeed(jobOf(m.id)!.speedBps) }} · {{ eta(jobOf(m.id)!.etaSec) }}</span>
            </div>
          </div>
        </div>
      </template>
    </div>

    <!-- ══════════ 朗读 ══════════ -->
    <div>
      <div class="flex items-center justify-between mb-2">
        <div>
          <div class="text-[13px] font-[530] text-gray-900">{{ t('settings.voice.ttsTitle') }}</div>
          <div class="text-[11px] text-gray-400 mt-0.5">{{ t('settings.voice.ttsHint') }}</div>
        </div>
        <BwSwitch :model-value="!!voice.state?.ttsEnabled" @update:model-value="setTtsEnabled" />
      </div>

      <div v-if="!voice.state?.ttsEnabled" class="text-[11px] text-gray-300 px-3 py-2">{{ t('settings.voice.offHint') }}</div>
      <template v-else>
        <div class="text-[11px] text-gray-400 mb-1.5">{{ t('settings.voice.pickModel') }}</div>
        <div
          v-for="m in ttsModels"
          :key="m.id"
          class="rounded-xl border p-3 mb-2 transition-all"
          :class="voice.state?.ttsModel === m.id ? 'border-gray-900 bg-white' : 'border-gray-200 bg-white'"
        >
          <div class="flex items-center gap-2">
            <button class="w-3.5 h-3.5 rounded-full border flex items-center justify-center shrink-0" :class="voice.state?.ttsModel === m.id ? 'border-gray-900' : 'border-gray-300'" @click="pickTts(m.id)">
              <span v-if="voice.state?.ttsModel === m.id" class="w-1.5 h-1.5 rounded-full bg-gray-900"></span>
            </button>
            <span class="text-[13px] font-[530] text-gray-900">{{ m.name }}</span>
            <span class="text-[10px] px-1.5 py-[1px] rounded bg-gray-100 text-gray-500">{{ approxLabel(m.approxMB) }}</span>
            <span v-for="tag in m.tags" :key="tag" class="text-[10px] px-1.5 py-[1px] rounded" style="background: rgba(99,102,241,.09); color: #4f46e5">{{ tag }}</span>
            <div class="ml-auto flex items-center gap-2">
              <button
                v-if="!m.installed && !jobOf(m.id)"
                class="px-3 py-1 rounded-lg bg-gray-900 text-white text-[11px] font-[530] hover:opacity-80"
                @click="voice.install(m.id)"
              >{{ t('settings.voice.install') }}</button>
              <span v-else-if="jobOf(m.id)" class="text-[11px] text-gray-400">{{ Math.max(0, Math.round(jobOf(m.id)!.percent)) }}%</span>
              <template v-else>
                <span class="text-[10px] px-1.5 py-[1px] rounded" style="background: rgba(16,185,129,.1); color: #059669">{{ t('settings.voice.installed') }}</span>
                <button
                  class="px-2 py-1 rounded-lg text-[11px]"
                  :class="confirmRemove === m.id ? 'bg-red-500 text-white' : 'text-gray-400 hover:text-red-500'"
                  @click="doRemove(m.id)"
                >{{ confirmRemove === m.id ? t('settings.voice.confirmDel') : t('settings.voice.del') }}</button>
              </template>
            </div>
          </div>
          <div class="text-[11px] text-gray-400 mt-1 ml-[22px]">{{ m.desc }}</div>
          <div v-if="m.installed && m.sizeBytes" class="text-[10px] text-gray-300 mt-0.5 ml-[22px]">{{ t('settings.voice.onDisk') }} {{ fmtMB(m.sizeBytes) }} · {{ m.note }}</div>
          <div v-if="jobOf(m.id)" class="mt-2 ml-[22px]">
            <div class="h-[3px] rounded-full bg-gray-100 overflow-hidden">
              <div class="h-full bg-gray-900 transition-all" :style="{ width: Math.max(0, jobOf(m.id)!.percent) + '%' }"></div>
            </div>
            <div class="flex items-center gap-2 mt-1 text-[10px] text-gray-400">
              <span class="truncate">{{ jobOf(m.id)!.phase }}</span>
              <span v-if="jobOf(m.id)!.speedBps" class="ml-auto shrink-0">{{ fmtSpeed(jobOf(m.id)!.speedBps) }} · {{ eta(jobOf(m.id)!.etaSec) }}</span>
            </div>
          </div>

          <!-- 当前模型的子配置：切模型各自恢复（互不牵扯） -->
          <div v-if="voice.state?.ttsModel === m.id && m.installed" class="mt-3 pt-3 border-t border-gray-100">
            <div class="flex items-center gap-3 mb-3">
              <span class="text-[12px] text-gray-500 w-10 shrink-0">{{ t('settings.voice.voiceLabel') }}</span>
              <select
                class="flex-1 h-8 px-2 rounded-lg border border-gray-200 bg-white text-[12px] text-gray-900 outline-none focus:border-gray-900"
                :value="m.sid"
                @change="pickVoice(Number(($event.target as HTMLSelectElement).value))"
              >
                <option v-for="v in voiceOptions" :key="v.id" :value="v.id">{{ v.label }}</option>
              </select>
              <button
                class="px-3 h-8 rounded-lg border border-gray-200 text-[12px] text-gray-600 hover:border-gray-900 hover:text-gray-900 shrink-0 flex items-center gap-1.5"
                :disabled="previewing"
                @click="voice.preview(m.id, m.sid ?? 0, speedDraft)"
              >
                <i class="fas" :class="previewing ? 'fa-spinner fa-spin' : 'fa-play'"></i>
                {{ previewing ? t('settings.voice.previewing') : t('settings.voice.preview') }}
              </button>
            </div>
            <div class="flex items-center gap-3">
              <span class="text-[12px] text-gray-500 w-10 shrink-0">{{ t('settings.voice.speed') }}</span>
              <input
                v-model.number="speedDraft"
                type="range" min="0.5" max="2" step="0.05"
                class="nis-range flex-1"
                @change="commitSpeed"
              />
              <span class="text-[12px] text-gray-400 w-10 text-right shrink-0">{{ speedDraft.toFixed(2) }}x</span>
            </div>
            <div class="text-[10px] text-gray-300 mt-2">{{ t('settings.voice.perModelHint') }}</div>
          </div>
        </div>
      </template>

      <div class="mt-3 text-[10px] text-gray-300 leading-relaxed">
        {{ t('settings.voice.footnote') }}
      </div>
    </div>
  </div>
</template>
