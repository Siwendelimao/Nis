<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue'
import { t } from '@/utils/i18n'
import { useChatStore } from '@/stores/chat'
import { useModalLayer } from '@/utils/modalStack'

/**
 * DirPickerModal —— 目录选择弹窗（0914）
 * 背景：此前「环境安装目录」在浏览器下用 window.prompt 手输路径（没法浏览、原生弹窗风格不符）。
 * 本组件走后端 fs.listDir RPC：盘符 + 常用位置快捷入口 + 目录列表浏览 + 手动粘贴路径兜底。
 * Teleport 到 body，层级高于设置弹窗（z-[88]）。
 */
const props = defineProps<{
  open: boolean
  initial?: string
  /** 层级：默认 88（高于设置弹窗）；引导页里传更大值，否则会被引导层盖住 */
  z?: number
  /** 0917b：'dir'（默认，选目录）| 'file'（选文件——用于导入数据包） */
  mode?: 'dir' | 'file'
  /** file 模式下的扩展名白名单（不带点，如 ['gz','tgz']）；不传 = 不过滤 */
  fileExtensions?: string[]
}>()
const emit = defineEmits<{
  (e: 'update:open', v: boolean): void
  (e: 'select', path: string): void
}>()

const isFileMode = computed(() => props.mode === 'file')
/** file 模式下已选中的文件（点击文件行选中；底部按钮确认） */
const pickedFile = ref('')

function extOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i >= 0 ? name.slice(i + 1).toLowerCase() : ''
}
/** 当前目录里符合扩展名白名单的文件 */
const visibleFiles = computed(() => {
  const list = files.value
  const allow = props.fileExtensions
  if (!allow || !allow.length) return list
  const set = new Set(allow.map((x) => String(x).toLowerCase()))
  return list.filter((f) => set.has(extOf(f.name)))
})

function fmtSize(n: number): string {
  if (!n) return ''
  if (n < 1024) return n + ' B'
  if (n < 1048576) return Math.round(n / 1024) + ' KB'
  if (n < 1073741824) return (Math.round(n / 1048576 * 10) / 10) + ' MB'
  return (Math.round(n / 1073741824 * 10) / 10) + ' GB'
}

function pickFile(p: string): void {
  pickedFile.value = p
}

const chatStore = useChatStore()
const curPath = ref('')
const parent = ref<string | null>(null)
const dirs = ref<Array<{ name: string; path: string }>>([])
const files = ref<Array<{ name: string; path: string; size: number }>>([])
const drives = ref<string[]>([])
const quick = ref<Array<{ key: string; path: string }>>([])
const loading = ref(false)
const errMsg = ref('')
const manual = ref('')

// 新建文件夹（0917）：内联输入 → 后端 fs.mkdir → 建好后直接进入该目录
const creating = ref(false)
const newName = ref('')
const nameEl = ref<HTMLInputElement | null>(null)

function startNewFolder() {
  if (!curPath.value) return
  errMsg.value = ''
  creating.value = true
  newName.value = ''
  void nextTick(() => nameEl.value?.focus())
}

function cancelNewFolder() {
  creating.value = false
  newName.value = ''
  errMsg.value = ''
}

async function confirmNewFolder() {
  const name = newName.value.trim()
  if (!name || !curPath.value) return
  errMsg.value = ''
  try {
    const r: any = await chatStore.bridgeRpc('fs.mkdir', { path: curPath.value, name })
    if (r?.ok === false) { errMsg.value = String(r?.error || '') || t('dirPicker.unreadable'); return }
    creating.value = false
    newName.value = ''
    await navigate(String(r?.path || curPath.value))
  } catch (e: any) {
    errMsg.value = String(e?.message || e).slice(0, 160)
  }
}

async function navigate(p: string) {
  loading.value = true
  errMsg.value = ''
  pickedFile.value = ''
  try {
    const r: any = await chatStore.bridgeRpc('fs.listDir', { path: p || '', withFiles: isFileMode.value })
    curPath.value = String(r?.path || '')
    parent.value = r?.parent ?? null
    dirs.value = Array.isArray(r?.dirs) ? r.dirs : []
    files.value = Array.isArray(r?.files) ? r.files : []
    drives.value = Array.isArray(r?.drives) ? r.drives : []
    quick.value = Array.isArray(r?.quick) ? r.quick : []
    if (r?.ok === false) errMsg.value = String(r?.error || '') || t('dirPicker.unreadable')
  } catch (e: any) {
    errMsg.value = String(e?.message || e).slice(0, 160)
  } finally {
    loading.value = false
  }
}

function close() { emit('update:open', false) }

/* Esc：本弹窗作为独立一层参与全局层级（它是"三级弹窗"的常客 ——
   设置 → 导出数据 → 选目录）。按 Esc 只关自己，不会把底下的设置/导出一起带走。 */
useModalLayer(() => props.open, () => close())

function confirmPick() {
  if (isFileMode.value) {
    if (!pickedFile.value) return
    emit('select', pickedFile.value)
    close()
    return
  }
  if (!curPath.value) return
  emit('select', curPath.value)
  close()
}

function onManualGo() {
  const v = manual.value.trim()
  if (v) void navigate(v)
}

watch(() => props.open, (v) => {
  if (v) {
    manual.value = ''
    errMsg.value = ''
    creating.value = false
    newName.value = ''
    pickedFile.value = ''
    files.value = []
    void navigate(props.initial || '')
  }
})
</script>

<template>
  <Teleport to="body">
    <Transition name="dp">
    <div v-if="open" class="fixed inset-0 flex items-center justify-center bg-black/30" :style="{ zIndex: props.z ?? 88 }" @click.self="close">
      <div class="dp-card bg-white dark:bg-gray-900 rounded-[16px] border border-gray-200 dark:border-gray-700 shadow-[0_24px_70px_-20px_rgba(0,0,0,0.4)] w-[560px] max-w-[92vw] flex flex-col overflow-hidden">
        <!-- 头 -->
        <div class="px-5 pt-4 pb-3 border-b border-gray-100 dark:border-gray-800">
          <h3 class="text-sm font-[640] text-gray-900 dark:text-gray-100">{{ isFileMode ? t('dirPicker.titleFile') : t('dirPicker.title') }}</h3>
          <p class="text-[11px] text-gray-400 dark:text-gray-500 mt-0.5">{{ isFileMode ? t('dirPicker.subtitleFile') : t('dirPicker.subtitle') }}</p>
        </div>

        <!-- 快捷入口：盘符 + 常用位置 -->
        <div class="px-4 py-2 flex items-center gap-1.5 flex-wrap border-b border-gray-100 dark:border-gray-800">
          <button
            v-for="d in drives" :key="d"
            class="px-2.5 py-1 rounded-lg border text-[11px] transition-colors"
            :class="curPath.toUpperCase().startsWith(d) ? 'border-gray-400 bg-gray-100 text-gray-800 font-[530] dark:bg-gray-800 dark:text-gray-100' : 'border-gray-200 text-gray-500 hover:border-gray-400 dark:border-gray-700 dark:text-gray-400'"
            @click="navigate(d)"
          >{{ d.slice(0, 2) }}</button>
          <span v-if="drives.length && quick.length" class="w-px h-4 bg-gray-200 dark:bg-gray-700 mx-0.5"></span>
          <button
            v-for="q in quick" :key="q.key"
            class="px-2.5 py-1 rounded-lg border text-[11px] transition-colors"
            :class="curPath && q.path === curPath ? 'border-gray-400 bg-gray-100 text-gray-800 font-[530] dark:bg-gray-800 dark:text-gray-100' : 'border-gray-200 text-gray-500 hover:border-gray-400 dark:border-gray-700 dark:text-gray-400'"
            @click="navigate(q.path)"
          >{{ t('dirPicker.q.' + q.key) }}</button>
        </div>

        <!-- 当前路径 + 上级 -->
        <div class="px-4 py-2.5 flex items-center gap-2 border-b border-gray-100 dark:border-gray-800">
          <button
            class="w-7 h-7 shrink-0 flex items-center justify-center rounded-lg border border-gray-200 text-gray-500 transition-colors hover:border-gray-400 hover:text-gray-800 disabled:opacity-40 disabled:cursor-not-allowed dark:border-gray-700 dark:text-gray-400 dark:hover:text-gray-100"
            :disabled="!parent"
            :title="t('dirPicker.up')"
            @click="parent && navigate(parent)"
          ><i class="fas fa-arrow-up text-[11px]"></i></button>
          <div class="flex-1 min-w-0 px-3 py-1.5 rounded-lg bg-gray-50 dark:bg-gray-800 text-[11.5px] text-gray-600 dark:text-gray-300 truncate" style="font-family: var(--mono, monospace)">
            {{ curPath || t('dirPicker.drives') }}
          </div>
          <i v-if="loading" class="fas fa-spinner fa-spin text-[11px] text-gray-400 shrink-0"></i>
          <button
            class="h-7 shrink-0 flex items-center gap-1 px-2.5 rounded-lg border border-gray-200 text-gray-500 text-[11px] transition-colors hover:border-gray-400 hover:text-gray-800 disabled:opacity-40 disabled:cursor-not-allowed dark:border-gray-700 dark:text-gray-400 dark:hover:text-gray-100"
            :disabled="!curPath"
            :title="t('dirPicker.newFolder')"
            @click="startNewFolder"
          ><i class="fas fa-folder-plus text-[11px]"></i><span>{{ t('dirPicker.newFolder') }}</span></button>
        </div>

        <!-- 新建文件夹内联条 -->
        <div v-if="creating" class="px-4 py-2 border-b border-gray-100 dark:border-gray-800 bg-gray-50/70 dark:bg-gray-800/40">
          <div class="flex items-center gap-2">
            <i class="fas fa-folder-plus text-[12px] text-amber-400 shrink-0"></i>
            <input
              ref="nameEl"
              v-model="newName"
              data-nis-esc-local
              :placeholder="t('dirPicker.newFolderPlaceholder')"
              class="flex-1 min-w-0 bg-white border border-gray-200 dark:bg-gray-900 dark:border-gray-700 rounded-lg px-2.5 py-1.5 text-[11.5px] text-gray-800 dark:text-gray-100 outline-none focus:border-gray-400"
              @keydown.enter="confirmNewFolder"
              @keydown.esc="cancelNewFolder"
            />
            <button class="btn btn-sm bg-black hover:bg-black/80 text-white shrink-0" @click="confirmNewFolder">{{ t('dirPicker.create') }}</button>
            <button class="btn btn-secondary btn-sm shrink-0" @click="cancelNewFolder">{{ t('settings.cancel') }}</button>
          </div>
          <p v-if="errMsg" class="mt-1.5 text-[11px] text-red-500 truncate">{{ errMsg }}</p>
        </div>

        <!-- 目录列表 -->
        <div class="overflow-y-auto custom-scroll px-2 py-1.5" style="height: 300px">
          <div v-if="!dirs.length && !visibleFiles.length && !loading" class="h-full flex flex-col items-center justify-center text-[11.5px] text-gray-400 gap-1">
            <i class="fas fa-folder-open text-gray-300 text-base"></i>
            <span>{{ errMsg || t('dirPicker.empty') }}</span>
          </div>
          <button
            v-for="d in dirs" :key="d.path"
            class="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-left hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
            @click="navigate(d.path)"
          >
            <i class="fas fa-folder text-[12px] text-amber-400 shrink-0"></i>
            <span class="text-xs text-gray-700 dark:text-gray-200 truncate">{{ d.name }}</span>
          </button>
          <!-- 0917b 文件模式：只列出来的才是可选项（点击选中，底部按钮确认） -->
          <button
            v-for="f in visibleFiles" :key="f.path"
            class="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-left transition-colors"
            :class="pickedFile === f.path ? 'bg-gray-100 dark:bg-gray-800' : 'hover:bg-gray-100 dark:hover:bg-gray-800'"
            @click="pickFile(f.path)"
            @dblclick="pickFile(f.path), emit('select', f.path), close()"
          >
            <i class="fas fa-file-zipper text-[12px] shrink-0" :class="pickedFile === f.path ? 'text-violet-500' : 'text-gray-400'"></i>
            <span class="flex-1 min-w-0 text-xs truncate" :class="pickedFile === f.path ? 'text-gray-900 dark:text-gray-100 font-[530]' : 'text-gray-700 dark:text-gray-200'">{{ f.name }}</span>
            <span class="text-[10px] text-gray-400 shrink-0">{{ fmtSize(f.size) }}</span>
          </button>
        </div>

        <!-- 底部：手动路径 + 操作 -->
        <div class="px-5 py-3 border-t border-gray-100 dark:border-gray-800">
          <div v-if="isFileMode" class="mb-2 text-[10.5px] text-gray-500 dark:text-gray-400 truncate" style="font-family: var(--mono, monospace)">
            {{ pickedFile || t('dirPicker.pickFileHint') }}
          </div>
          <div class="flex items-center gap-2">
            <input
              v-model="manual"
              :placeholder="t('dirPicker.manualPlaceholder')"
              class="flex-1 min-w-0 bg-gray-50 border border-gray-200 dark:bg-gray-800 dark:border-gray-700 rounded-lg px-3 py-1.5 text-[11.5px] text-gray-800 dark:text-gray-100 outline-none focus:border-gray-400"
              @keydown.enter="onManualGo"
            />
            <button class="btn btn-secondary btn-sm shrink-0" @click="close">{{ t('settings.cancel') }}</button>
            <button
              class="btn btn-sm bg-black hover:bg-black/80 text-white shrink-0 disabled:opacity-40"
              :disabled="isFileMode ? !pickedFile : !curPath"
              @click="confirmPick"
            >{{ isFileMode ? t('dirPicker.pickFile') : t('dirPicker.pick') }}</button>
          </div>
        </div>
      </div>
    </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
/* 0919：补进出场（此前是硬切，和其他弹窗不是一套语感）。
   ⚠️ 只动 opacity/transform，别用 backdrop-filter + 全屏 Transition。 */
.dp-enter-active, .dp-leave-active { transition: opacity 0.2s ease; }
.dp-enter-from, .dp-leave-to { opacity: 0; }
.dp-enter-active .dp-card { animation: dpIn 0.22s cubic-bezier(0.16, 1, 0.3, 1); }
.dp-leave-active .dp-card { transition: transform 0.16s cubic-bezier(0.4, 0, 1, 1), opacity 0.16s ease; }
.dp-leave-to .dp-card { transform: translateY(6px) scale(0.985); opacity: 0; }
@keyframes dpIn { from { opacity: 0; transform: translateY(10px) scale(0.98); } to { opacity: 1; transform: none; } }
</style>
