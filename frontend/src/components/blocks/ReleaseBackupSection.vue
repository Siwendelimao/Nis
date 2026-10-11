<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { t } from '@/utils/i18n'
import { useChatStore } from '@/stores/chat'

/**
 * 设置页「版本保底」（0913）—— 与根目录「一键回滚.exe」同一份引擎（_release.mjs）。
 * 内容对齐急救面板：状态四卡（实例根/基线/自改清单/磁盘）+ 快照列表（新→旧，最新标）+
 * 拍快照 + 操作记录 + 逐行回滚（二次确认）。主要用途：可视化确认"当前版本已备份"。
 *
 * 数据通道：后端 release.state / release.snapshot / release.rollback（server.ts 桥接引擎子进程）。
 */
interface ReleaseSnapshot {
  name: string
  createdAt: number
  fileCount: number
  bytes: number
  label?: string
}
interface ReleaseState {
  root: string
  relDir: string
  baseline: { version: string; updatedAt: number } | null
  snapshots: ReleaseSnapshot[]
  diff: { modified: number; added: number; deleted: number } | null
  diskBytes: number
  /** 1010：无清单的残留（引擎不认、回滚不了，只能删） */
  broken?: { name: string }[]
  unknownSizeCount?: number
  /** 1010：后端登记的"进行中操作"（拍快照/回滚/删除）—— 切 tab 回来也能接上 */
  op?: { kind: 'snapshot' | 'rollback' | 'delete'; name: string; startedAt: number } | null
}

const chatStore = useChatStore()
const state = ref<ReleaseState | null>(null)
const loading = ref(true)
const busy = ref(false)
const errMsg = ref('')
const logText = ref('')
const snapLabel = ref('')
/** 非空 = 弹回滚确认框 */
const confirmName = ref('')
/** 非空 = 弹删除确认框（二级确认） */
const confirmDel = ref('')
const logEl = ref<HTMLElement | null>(null)

function fmtBytes(n?: number | null): string {
  if (n === undefined || n === null) return '—'
  if (n < 1024) return n + ' B'
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB'
  return (n / 1048576).toFixed(1) + ' MB'
}
function p2(x: number) { return (x < 10 ? '0' : '') + x }
function fmtTime(ts?: number): string {
  if (!ts) return '—'
  const d = new Date(ts)
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`
}
function opLabel(op: { kind: string; name: string }): string {
  if (op.kind === 'snapshot') return t('settings.backup.opSnapshot', { name: op.name })
  if (op.kind === 'rollback') return t('settings.backup.opRollback', { name: op.name })
  return t('settings.backup.opDelete', { name: op.name })
}
function isDeleting(name: string): boolean {
  const op = state.value?.op
  return !!op && op.kind === 'delete' && op.name === name
}
function logOp(text: string) {
  const head = '[' + new Date().toLocaleTimeString() + '] '
  logText.value += (logText.value ? '\n\n' : '') + head + text
  requestAnimationFrame(() => { if (logEl.value) logEl.value.scrollTop = logEl.value.scrollHeight })
}

async function refresh() {
  loading.value = true
  errMsg.value = ''
  try {
    const r: any = await chatStore.bridgeRpc('release.state', {}, 60000)
    state.value = r as ReleaseState
  } catch (e: any) {
    errMsg.value = t('settings.backup.loadFailed', { msg: String(e?.message || e).slice(0, 160) })
  } finally {
    loading.value = false
    syncPoll()
  }
}

/* 1010：后端有"进行中操作"时自动轮询 —— 切 tab 回来会立刻显示进度，操作完成后自动消失 */
let pollTimer: any = null
function syncPoll() {
  const running = !!state.value?.op
  if (running && !pollTimer) pollTimer = setInterval(() => { void refresh() }, 2500)
  if (!running && pollTimer) { clearInterval(pollTimer); pollTimer = null }
}
onUnmounted(() => { if (pollTimer) { clearInterval(pollTimer); pollTimer = null } })

async function doSnapshot() {
  if (busy.value) return
  busy.value = true
  const label = snapLabel.value.trim() || '手动快照'
  logOp(t('settings.backup.snapping', { label }))
  try {
    const r: any = await chatStore.bridgeRpc('release.snapshot', { label }, 900000)
    logOp((r?.ok ? t('settings.backup.snapDone') : t('settings.backup.snapFail')) + '\n' + String(r?.log || ''))
    snapLabel.value = ''
    await refresh()
  } catch (e: any) {
    logOp(t('settings.backup.snapFail') + '\n' + String(e?.message || e))
  } finally {
    busy.value = false
  }
}

function askDelete(name: string) {
  if (busy.value) return
  confirmDel.value = name
}

async function doDelete() {
  const name = confirmDel.value
  if (!name || busy.value) return
  confirmDel.value = ''
  busy.value = true
  logOp(t('settings.backup.deleting', { name }))
  try {
    const r: any = await chatStore.bridgeRpc('release.delete', { name }, 300000)
    logOp((r?.ok ? t('settings.backup.delDone') : t('settings.backup.delFail')) + '\n' + String(r?.log || ''))
    await refresh()
  } catch (e: any) {
    logOp(t('settings.backup.delFail') + '\n' + String(e?.message || e))
  } finally {
    busy.value = false
  }
}

function askRollback(name: string) {
  if (busy.value) return
  confirmName.value = name
}

async function doRollback() {
  const name = confirmName.value
  if (!name || busy.value) return
  confirmName.value = ''
  busy.value = true
  logOp(t('settings.backup.rolling', { name }))
  try {
    const r: any = await chatStore.bridgeRpc('release.rollback', { name }, 1800000)
    logOp((r?.ok ? t('settings.backup.rollDone') : t('settings.backup.rollFail')) + '\n' + String(r?.log || ''))
    await refresh()
  } catch (e: any) {
    logOp(t('settings.backup.rollFail') + '\n' + String(e?.message || e))
  } finally {
    busy.value = false
  }
}

onMounted(() => { void refresh() })
</script>

<template>
  <div class="relbk flex flex-col">
    <!-- 顶部说明 + 刷新 -->
    <div class="flex items-center justify-between gap-3 mb-3 shrink-0">
      <p class="text-[11px] text-gray-400 dark:text-gray-500 min-w-0">{{ t('settings.backup.subtitle') }}</p>
      <button class="btn btn-secondary btn-sm shrink-0" :disabled="loading || busy" @click="refresh">
        <i class="fas fa-rotate text-[10px] mr-1"></i>{{ t('settings.backup.refresh') }}
      </button>
    </div>
    <p v-if="errMsg" class="mb-3 text-[11.5px] text-red-500 leading-relaxed">{{ errMsg }}</p>

    <!-- 状态条（1010：替代原四卡——实例根/基线/自改清单属"官方发行升级"场景，普通用户看了只剩"—"；能力仍在，走 exe 面板或 CLI）-->
    <div class="flex flex-wrap items-center gap-x-2.5 gap-y-1 mb-3 px-3 py-2 rounded-xl bg-gray-50 dark:bg-gray-800 text-[11.5px] text-gray-500 dark:text-gray-400 shrink-0">
      <i class="fas fa-clock-rotate-left text-[11px]"></i>
      <span v-if="state?.snapshots?.length">{{ t('settings.backup.summaryFmt', { n: state.snapshots.length, size: fmtBytes(state.diskBytes), time: fmtTime(state.snapshots[0]?.createdAt) }) }}</span>
      <span v-else>{{ t('settings.backup.summaryEmpty') }}</span>
      <span v-if="state?.unknownSizeCount" class="text-amber-600 dark:text-amber-500">{{ t('settings.backup.brokenFmt', { n: state.unknownSizeCount }) }}</span>
      <span v-if="state?.op" class="flex items-center gap-1.5 text-blue-600 dark:text-blue-400">
        <i class="fas fa-spinner fa-spin text-[11px]"></i>{{ opLabel(state.op) }}
      </span>
    </div>

    <div class="grid grid-cols-1 xl:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)] gap-3 items-start">
      <!-- 左：快照列表 -->
      <div class="rounded-xl border border-gray-100 dark:border-gray-800 flex flex-col min-h-0">
        <div class="flex items-center justify-between px-4 pt-3.5 pb-2 shrink-0">
          <span class="text-[13px] font-[640] text-gray-900 dark:text-gray-100">{{ t('settings.backup.snapshotTitle') }}</span>
          <span class="text-[11px] text-gray-400">{{ state?.snapshots?.length ? t('settings.backup.snapshotCount', { n: state.snapshots.length }) : '' }}</span>
        </div>
        <div class="px-3 pb-3 space-y-2 flex-1 min-h-0 overflow-y-auto custom-scroll">
          <div v-if="loading" class="py-10 text-center text-[12px] text-gray-400">{{ t('settings.backup.loading') }}</div>
          <div v-else-if="!state?.snapshots?.length" class="py-10 text-center text-[12px] text-gray-400">{{ t('settings.backup.noSnapshots') }}</div>
          <div
            v-for="(s, i) in (state?.snapshots || [])"
            :key="s.name"
            class="flex items-center gap-2.5 rounded-xl border border-gray-100 dark:border-gray-700 px-3 py-2.5 hover:border-gray-300 dark:hover:border-gray-600 transition-colors"
            :class="isDeleting(s.name) ? 'opacity-45' : ''"
          >
            <div class="flex-1 min-w-0">
              <div class="text-[12.5px] font-[640] truncate text-gray-800 dark:text-gray-100" :title="s.name">
                {{ s.label || fmtTime(s.createdAt) }}
                <span v-if="i === 0" class="ml-1.5 px-1.5 py-px rounded-full bg-gray-100 dark:bg-gray-700 text-gray-500 text-[10px] align-[1px] font-sans">{{ t('settings.backup.latest') }}</span>
              </div>
              <div class="text-[11px] text-gray-400 mt-0.5 truncate">{{ fmtTime(s.createdAt) }} · {{ t('settings.backup.filesFmt', { n: s.fileCount }) }} · {{ fmtBytes(s.bytes) }}<span v-if="isDeleting(s.name)" class="text-red-500/80"> · {{ t('settings.backup.itemDeleting') }}</span></div>
            </div>
            <button class="btn btn-secondary btn-sm shrink-0" :disabled="busy" @click="askRollback(s.name)">{{ t('settings.backup.rollbackBtn') }}</button>
            <button
              class="btn btn-secondary btn-sm shrink-0 px-2 text-gray-400 hover:text-red-500"
              :disabled="busy"
              :title="t('settings.backup.deleteBtn')"
              @click="askDelete(s.name)"
            ><i class="fas fa-trash-can text-[11px]"></i></button>
          </div>
        </div>
      </div>

      <!-- 右：拍快照 + 操作记录 -->
      <div class="flex flex-col gap-3 min-h-0">
        <div class="rounded-xl border border-gray-100 dark:border-gray-800 shrink-0">
          <div class="flex items-center gap-1.5 px-3.5 pt-3 pb-1.5 shrink-0">
            <span class="text-[13px] font-[640] text-gray-900 dark:text-gray-100">{{ t('settings.backup.snapCardTitle') }}</span>
            <i
              class="fas fa-circle-info text-[11.5px] text-gray-300 dark:text-gray-600 hover:text-gray-500 cursor-help transition-colors"
              :title="t('settings.backup.snapHint')"
            ></i>
          </div>
          <div class="px-3.5 pb-3">
            <input
              v-model="snapLabel"
              :placeholder="t('settings.backup.snapLabelPlaceholder')"
              maxlength="40"
              class="w-full h-8 px-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-[12.5px] text-gray-800 dark:text-gray-100 outline-none focus:border-gray-400"
            />
            <div class="flex items-center mt-2">
              <button class="ml-auto btn btn-primary btn-sm shrink-0" :disabled="busy || loading" @click="doSnapshot">
                <i class="fas fa-camera text-[10px] mr-1"></i>{{ t('settings.backup.snapBtn') }}
              </button>
            </div>
          </div>
        </div>

        <div class="rounded-xl border border-gray-100 dark:border-gray-800 flex-1 min-h-0 flex flex-col">
          <div class="px-3.5 pt-3 pb-1.5 shrink-0 text-[13px] font-[640] text-gray-900 dark:text-gray-100">{{ t('settings.backup.logTitle') }}</div>
          <div
            ref="logEl"
            class="mx-3 mb-3 px-3 py-2 rounded-lg bg-gray-50 dark:bg-gray-800 text-[11px] leading-relaxed text-gray-600 dark:text-gray-300 whitespace-pre-wrap break-all flex-1 min-h-[110px] overflow-y-auto custom-scroll"
            style="font-family: var(--mono, ui-monospace, monospace)"
          >{{ logText || t('settings.backup.logEmpty') }}</div>
        </div>
      </div>
    </div>

    <!-- 底部提示 -->
    <!-- 1010：无清单的残留（引擎不认、回滚不了）—— 列出来让用户能清理 -->
    <div v-if="state?.broken?.length" class="mt-3 rounded-xl border border-amber-200 dark:border-amber-900/50 bg-amber-50/60 dark:bg-amber-950/20 px-4 py-3">
      <div class="text-[12px] font-[640] text-amber-800 dark:text-amber-400 mb-1.5">
        <i class="fas fa-triangle-exclamation text-[11px] mr-1"></i>{{ t('settings.backup.brokenTitle') }}（{{ state.broken.length }}）
      </div>
      <div v-for="b in state.broken" :key="b.name" class="flex items-center gap-3 py-1">
        <span class="flex-1 min-w-0 text-[11.5px] text-amber-800/90 dark:text-amber-500/90 truncate" :title="b.name">{{ b.name }}</span>
        <button class="btn btn-secondary btn-sm shrink-0 px-2 text-gray-400 hover:text-red-500" :disabled="busy" @click="askDelete(b.name)">
          <i class="fas fa-trash-can text-[11px]"></i>
        </button>
      </div>
      <p class="text-[11px] text-amber-700/80 dark:text-amber-500/70 mt-1">{{ t('settings.backup.brokenHint') }}</p>
    </div>

    <p class="mt-3 shrink-0 text-[11px] text-gray-400 dark:text-gray-500 leading-relaxed">
      {{ t('settings.backup.offlineHint') }}<br />{{ t('settings.backup.restartHint') }}
    </p>

    <!-- 回滚二次确认 -->
    <Teleport to="body">
      <div v-if="confirmName" class="fixed inset-0 z-[80] bg-black/25 flex items-center justify-center">
        <div class="bg-white rounded-[16px] shadow-[0_24px_70px_-20px_rgba(0,0,0,0.4)] border border-gray-200 w-[440px] max-w-[92vw] p-5">
          <h3 class="text-sm font-[640] text-gray-900 mb-2">{{ t('settings.backup.rollConfirmTitle') }}</h3>
          <p class="text-[12.5px] text-gray-500 leading-relaxed">{{ t('settings.backup.rollConfirmBody') }}</p>
          <div class="mt-2 px-3 py-2 rounded-lg bg-gray-50 border border-gray-100 text-[12px] break-all text-gray-700" style="font-family: var(--mono, ui-monospace, monospace)">{{ confirmName }}</div>
          <div class="mt-3 flex gap-2 items-start rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-[11.5px] text-amber-800">
            <i class="fas fa-triangle-exclamation mt-0.5"></i>
            <span>{{ t('settings.backup.rollWarn') }}</span>
          </div>
          <div class="mt-4 flex justify-end gap-2">
            <button class="btn btn-secondary btn-sm" @click="confirmName = ''">{{ t('settings.backup.cancel') }}</button>
            <button class="btn btn-primary btn-sm" @click="doRollback">{{ t('settings.backup.confirmRoll') }}</button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- 删除还原点：二级确认（1010） -->
    <Teleport to="body">
      <div v-if="confirmDel" class="fixed inset-0 z-[80] bg-black/25 flex items-center justify-center">
        <div class="bg-white rounded-[16px] shadow-[0_24px_70px_-20px_rgba(0,0,0,0.4)] border border-gray-200 w-[440px] max-w-[92vw] p-5">
          <h3 class="text-sm font-[640] text-gray-900 mb-2">{{ t('settings.backup.delConfirmTitle') }}</h3>
          <p class="text-[12.5px] text-gray-500 leading-relaxed">{{ t('settings.backup.delConfirmBody') }}</p>
          <div class="mt-2 px-3 py-2 rounded-lg bg-gray-50 border border-gray-100 text-[12px] break-all text-gray-700" style="font-family: var(--mono, ui-monospace, monospace)">{{ confirmDel }}</div>
          <div class="mt-3 flex gap-2 items-start rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-[11.5px] text-amber-800">
            <i class="fas fa-triangle-exclamation mt-0.5"></i>
            <span>{{ t('settings.backup.delWarn') }}</span>
          </div>
          <div class="mt-4 flex justify-end gap-2">
            <button class="btn btn-secondary btn-sm" @click="confirmDel = ''">{{ t('settings.backup.cancel') }}</button>
            <button class="btn btn-primary btn-sm" @click="doDelete">{{ t('settings.backup.confirmDel') }}</button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
/* ★1010f：横向滚动条的根因是 flex/grid 子项默认 min-width:auto —— 内容（长快照名/输入框）
   会把列撑得比容器宽。这里统一放开收缩权限，配 truncate 即可。 */
.relbk :where(.flex, .grid) > * { min-width: 0; }
</style>
