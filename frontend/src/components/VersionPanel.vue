<script setup lang="ts">
/**
 * VersionPanel —— 标签栏「版本」按钮对应的右侧面板：当前仓库 + 提交时间线。
 *
 * 三个口径（别在别处再猜）：
 *  ① git 是**目录级**的：判"是不是同一个项目"只认 `git rev-parse --show-toplevel` 的路径 ⇒ 顶部亮路径，不静默；
 *     会话目录不在仓库里时明确警告（那正是"改了却没提交进项目"的坑）。
 *  ② 两个 tab：「本会话」= 本会话工作区；「关联」= 把面板指向**另一个目录**的仓库
 *     （在 A 工作区看 B 的提交）。关联目标**按会话记住**（localStore），且以后提交/回退也作用于这个目标。
 *  ③ 「初始化仓库」= 只跑 `git init`（新增 .git），不 add / 不 commit / 不动任何既有文件 —— 只在点按钮时执行，绝不自动。
 */
import { ref, computed, watch, onMounted } from 'vue'
import { useChatStore } from '@/stores/chat'
import { useConversationsStore } from '@/stores/conversations'
import { useProjectsStore } from '@/stores/projects'
import { localStore } from '@/utils/localStore'
import { t } from '@/utils/i18n'

const chatStore = useChatStore()
const conversationsStore = useConversationsStore()
const projectsStore = useProjectsStore()
const convId = computed(() => String(conversationsStore.activeConversationId ?? ''))
const projects = computed(() => projectsStore.projects || [])

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ (e: 'close'): void }>()

interface CommitView {
  hash: string
  short: string
  at: number
  author: string
  subject: string
  sessionId?: string
  sessionTitle?: string
  source?: 'ai' | 'user'
  files: number
  added: number
  removed: number
}
interface TimelineView {
  isRepo: boolean
  repoRoot?: string
  workDir?: string
  branch?: string
  dirty?: number
  commits: CommitView[]
  error?: string
}

/** 目标模式：本会话（默认）/ 关联（看别的仓库）。
 *  按**上次用的**恢复（全局记住）—— 收起再展开不该跳回「本会话」，否则每次都得重新点一遍。 */
const MODE_KEY = 'nis.version.mode'
const mode = ref<'self' | 'linked'>('self')
/** 关联目录（按会话记住；空 = 还没关联） */
const linkedDir = ref('')
/** 关联输入框草稿（手填路径） */
const draftDir = ref('')
/** 跟本对话有关的仓库（自动识别：只认会话里出现过的路径证据） */
const related = ref<Array<{ repoRoot: string; hits: number }>>([])
/** 最近看过（全局共享，最近在前，最多 6 条）—— 点一下直接切过去 */
const RECENT_KEY = 'nis.version.recentRepos'
const recent = ref<string[]>([])
const lsKey = computed(() => `nis.version.repoDir.${convId.value || 'none'}`)

const data = ref<TimelineView | null>(null)
const loading = ref(false)
const initBusy = ref(false)
/** 初始化结果提示（成功/失败都显示，不静默） */
const initMsg = ref<{ ok: boolean; text: string } | null>(null)

/** 提交表单（手动提交：写说明 → 提交全部未提交改动） */
const commitOpen = ref(false)
const commitMsg = ref('')
const commitBusy = ref(false)
/** 写操作的结果提示（提交/撤销都走这里，失败红字） */
const opMsg = ref<{ ok: boolean; text: string } | null>(null)
/** 「其他存档点」是否展开：**默认折叠**（安全网都留着，但别吵到列表；想看/操作时点标题展开） */
const detachedOpen = ref(false)

/** 二次确认统一走**居中弹窗**（行内确认太挤、也容易误点） */
const confirmDialog = ref<{ title: string; body: string; okText: string; run: () => void } | null>(null)

/** 传给后端的显式目标目录（空 = 后端用会话工作区） */
const targetDir = computed(() => (mode.value === 'linked' ? linkedDir.value.trim() : ''))

async function load() {
  if (!convId.value) { data.value = null; return }
  loading.value = true
  initMsg.value = null
  try {
    const r = await chatStore.bridgeRpc('git.timeline', {
      sessionId: convId.value,
      limit: 30,
      ...(targetDir.value ? { repoDir: targetDir.value } : {}),
    })
    // 后端没这方法（多半没重启）⇒ 明确说出来，别让它伪装成"这个目录不是 git 仓库"
    data.value = isUnhandled(r)
      ? { isRepo: false, commits: [], error: t('git.needRestart') }
      : r
  } catch (e: any) {
    data.value = { isRepo: false, commits: [], error: String(e?.message || e) }
  } finally {
    loading.value = false
  }
}

function loadLinked() {
  linkedDir.value = String(localStore.getItem(lsKey.value) || '')
  // 恢复上次用的 tab（收起/展开、切会话都保持）
  const savedMode = String(localStore.getItem(MODE_KEY) || '')
  if (savedMode === 'linked' || savedMode === 'self') mode.value = savedMode
  try {
    const arr = JSON.parse(String(localStore.getItem(RECENT_KEY) || '[]'))
    recent.value = Array.isArray(arr) ? arr.filter((x: any) => typeof x === 'string' && x.trim()).slice(0, 6) : []
  } catch { recent.value = [] }
}
/** 记住"看过这个仓库"（去重、最近在前、最多 6 条） */
function rememberRepo(dir: string) {
  const d = String(dir || '').trim()
  if (!d) return
  const key = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  recent.value = [d, ...recent.value.filter(x => key(x) !== key(d))].slice(0, 6)
  localStore.setItem(RECENT_KEY, JSON.stringify(recent.value))
}
/** 选定关联目标（列表点一下 / 输入框回车都走这里） */
function pickDir(dir: string) {
  const p = String(dir || '').trim()
  if (!p) return
  linkedDir.value = p
  draftDir.value = ''
  localStore.setItem(lsKey.value, p)
  rememberRepo(p)
  initMsg.value = null
  void load()
}
/** 拉一次"跟本对话有关的仓库"（失败就空列表，不吵人） */
async function loadRelated() {
  if (!convId.value) { related.value = []; return }
  try {
    const r = await chatStore.bridgeRpc('git.related', { sessionId: convId.value })
    related.value = Array.isArray(r?.repos) ? r.repos : []
  } catch { related.value = [] }
}
function switchMode(m: 'self' | 'linked') {
  if (mode.value === m) return
  mode.value = m
  localStore.setItem(MODE_KEY, m)
  initMsg.value = null
  if (m === 'linked') void loadRelated()
  void load()
}
/** 取消关联（回到选择态） */
function clearLink() {
  linkedDir.value = ''
  draftDir.value = ''
  localStore.removeItem(lsKey.value)
  initMsg.value = null
}
/** 短名：取路径最后一段（D:\nis0924 → 0924） */
function shortName(p: string): string {
  const parts = String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || String(p || '')
}

/** 提交前预检：数一下到底有多少文件会被提交。
 *  ⚠️ 必须展开未跟踪目录 —— 默认的 `git status` 会把整个未跟踪目录折叠成一行，
 *  于是"未提交 20"背后可能藏着四万个文件（实测踩过）。 */
/** 后端对不认识的方法会回 `{ok:true,_unhandled:'xxx'}` —— 不检查就会**假成功**
 *  （实测踩过：没重启后端时点「提交改动」显示成功，但仓库里什么都没发生）。 */
const isUnhandled = (r: any) => !!(r && typeof r === 'object' && r._unhandled)

const preview = ref(0)
const previewBytes = ref(0)
const previewSampled = ref(false)
const previewBusy = ref(false)
const needConfirm = ref(false)
async function previewCommit() {
  previewBusy.value = true
  preview.value = 0
  previewBytes.value = 0
  previewSampled.value = false
  needConfirm.value = false
  try {
    const r = await chatStore.bridgeRpc('git.preview', {
      sessionId: convId.value,
      ...(targetDir.value ? { repoDir: targetDir.value } : {}),
    })
    if (isUnhandled(r)) { opMsg.value = { ok: false, text: t('git.needRestart') }; return }
    preview.value = Number(r?.files) || 0
    previewBytes.value = Number(r?.bytes) || 0
    previewSampled.value = !!r?.sampled
    // 文件多 → 要求再点一次确认（不静默把上万个文件塞进版本库）
    needConfirm.value = preview.value > 300
  } finally {
    previewBusy.value = false
  }
}
/** 体积的人话表达 */
const humanSize = computed(() => {
  const b = previewBytes.value
  if (!b) return '0 MB'
  if (b >= 1073741824) return (b / 1073741824).toFixed(2) + ' GB'
  if (b >= 1048576) return (b / 1048576).toFixed(1) + ' MB'
  return Math.max(1, Math.round(b / 1024)) + ' KB'
})
const previewText = computed(() => {
  if (previewBusy.value) return t('git.previewBusy')
  if (!preview.value) return t('git.commitHint')
  const size = humanSize.value + (previewSampled.value ? '+' : '')
  return needConfirm.value
    ? t('git.previewBig').replace('{n}', String(preview.value)).replace('{s}', size)
    : t('git.previewOk').replace('{n}', String(preview.value)).replace('{s}', size)
})
/** 展开/收起提交表单（展开时先预检） */
async function toggleCommit() {
  commitOpen.value = !commitOpen.value
  if (commitOpen.value) await previewCommit()
}

/** 手动提交：把当前所有未提交改动提交进仓库（来源记 Nis-Source: user） */
async function doCommit() {
  const msg = commitMsg.value.trim()
  if (!msg) return
  commitBusy.value = true
  opMsg.value = null
  try {
    /* ★1011：显式给 5 分钟 —— bridgeRpc 默认只等 30s，而"提交几千个文件的首次大提交"
       实测能跑过 30s ⇒ 前端先报「后端响应超时（git.commit，30s 无响应）」，
       可**后端其实还在跑、而且最后提交成功了**（老大实测：报超时，但 HEAD 已更新、工作区已干净）。 */
    const r = await chatStore.bridgeRpc('git.commit', {
      sessionId: convId.value,
      message: msg,
      ...(targetDir.value ? { repoDir: targetDir.value } : {}),
    }, 300000)
    if (isUnhandled(r)) {
      // 后端没这个方法（多半没重启）—— 明确报出来，绝不显示"已提交"
      opMsg.value = { ok: false, text: t('git.needRestart') }
    } else if (r?.ok) {
      opMsg.value = {
        ok: true,
        text: `${t('git.commitOk')} ${r.short || ''}${r.files ? ` · ${r.files} ${t('git.filesUnit')}` : ''}${r.authorFallback ? ` ${t('git.commitFallback')}` : ''}`,
      }
      commitMsg.value = ''
      commitOpen.value = false
      await load()
    } else {
      opMsg.value = { ok: false, text: String(r?.error || t('git.commitFail')) }
    }
  } catch (e: any) {
    const raw = String(e?.message || e)
    /* ★1011：超时 ≠ 失败。超时只是"前端不等了"，git 那边往往还在跑甚至已经跑完
       （实测那次的 HEAD 确实更新了）。所以这里补一句怎么判断，并顺手刷新一次状态。 */
    const isTimeout = /超时|timeout|无响应|timed out/i.test(raw)
    opMsg.value = { ok: false, text: isTimeout ? raw + '\n' + t('git.commitTimeoutHint') : raw }
    if (isTimeout) {
      try { await load() } catch { /* 刷新失败不影响提示 */ }
    }
  } finally {
    commitBusy.value = false
  }
}

/** 点「撤销」→ 弹窗确认（写清后果） */
function askRevert(c: { hash: string; short: string; subject: string }) {
  confirmDialog.value = {
    title: t('git.revertAsk'),
    body: `${c.short}  ${c.subject}\n\n${t('git.revertAskBody')}`,
    okText: t('git.revertYes'),
    run: () => { confirmDialog.value = null; void doRevert(c) },
  }
}

/** 点「回到这里」→ 弹窗确认（写清会移出几条、丢几个未提交改动） */
function askReset(c: { hash: string; short: string }) {
  const idx = (data.value?.commits || []).findIndex(x => x.hash === c.hash)
  const after = idx >= 0 ? idx : 0
  confirmDialog.value = {
    title: t('git.resetAsk').replace('{s}', c.short),
    body: t('git.resetAskBody').replace('{n}', String(after)).replace('{d}', String(data.value?.dirty || 0))
      /* ★1012：判据放开后，"HEAD 正好是目标 + 工作区脏"（after=0）也会走丢改动的危险路径 ⇒
         这种场合同样要把"会先备份"的定心丸显示出来，别只在真有提交要移出时才提示。 */
      + ((after > 0 || (data.value?.dirty || 0) > 0) ? `\n\n${t('git.resetAskNote')}` : ''),
    okText: t('git.resetYes'),
    run: () => { confirmDialog.value = null; void doReset(c) },
  }
}

/** 点「清除」→ 弹窗确认（只删备份标签，不动提交与工作区） */
function askDrop(tag?: string) {
  confirmDialog.value = {
    title: tag ? t('git.dropAsk').replace('{s}', tag) : t('git.dropAllAsk'),
    body: t('git.dropAskBody'),
    okText: t('git.dropYes'),
    run: () => { confirmDialog.value = null; void doDrop(tag) },
  }
}
async function doDrop(tag?: string) {
  opMsg.value = null
  try {
    const r = await chatStore.bridgeRpc('git.drop', {
      sessionId: convId.value,
      ...(tag ? { tag } : {}),
      ...(targetDir.value ? { repoDir: targetDir.value } : {}),
    })
    if (isUnhandled(r)) {
      opMsg.value = { ok: false, text: t('git.needRestart') }
    } else if (r?.ok) {
      opMsg.value = { ok: true, text: t('git.dropOk').replace('{n}', String(r.dropped ?? 0)) }
    } else {
      opMsg.value = { ok: false, text: String(r?.error || t('git.dropFail')) }
    }
  } catch (e: any) {
    opMsg.value = { ok: false, text: String(e?.message || e) }
  } finally {
    await load()
  }
}

/** 撤销某次提交（git revert：生成反向提交，历史保留、可再撤销） */
async function doRevert(c: { hash: string }) {
  opMsg.value = null
  try {
    const r = await chatStore.bridgeRpc('git.revert', {
      sessionId: convId.value,
      hash: c.hash,
      ...(targetDir.value ? { repoDir: targetDir.value } : {}),
    })
    if (isUnhandled(r)) {
      opMsg.value = { ok: false, text: t('git.needRestart') }
    } else if (r?.ok) {
      opMsg.value = { ok: true, text: `${t('git.revertOk')} ${r.short || ''}` }
    } else {
      opMsg.value = {
        ok: false,
        text: r?.conflict ? t('git.revertConflict') : String(r?.error || t('git.revertFail')),
      }
    }
  } catch (e: any) {
    opMsg.value = { ok: false, text: String(e?.message || e) }
  } finally {
    await load()
  }
}

/** 「回到这个存档点」：把工作区与历史一起移回去（后端会**先自动打备份标签**，打不上就中止） */
async function doReset(c: { hash: string }) {
  opMsg.value = null
  try {
    const r = await chatStore.bridgeRpc('git.reset', {
      sessionId: convId.value,
      hash: c.hash,
      ...(targetDir.value ? { repoDir: targetDir.value } : {}),
    })
    if (isUnhandled(r)) {
      opMsg.value = { ok: false, text: t('git.needRestart') }
    } else if (r?.ok) {
      const parts = [t('git.resetOk').replace('{tag}', String(r.backup || '')).replace('{n}', String(r.moved ?? 0))]
      if (r.discarded) parts.push(t('git.resetDiscarded').replace('{n}', String(r.discarded)))
      /* ★1012：未跟踪新文件 `reset --hard` **不会删** —— 单独如实报，别混进"丢弃"里（原先会虚报） */
      if (r.untrackedKept) parts.push(t('git.resetUntrackedKept').replace('{n}', String(r.untrackedKept)))
      opMsg.value = { ok: true, text: parts.join(' · ') }
    } else {
      opMsg.value = { ok: false, text: String(r?.error || t('git.resetFail')) }
    }
  } catch (e: any) {
    opMsg.value = { ok: false, text: String(e?.message || e) }
  } finally {
    await load()
  }
}

/** 初始化仓库：目标 = 当前看的那个目录（只加 .git，不动文件） */
async function doInit() {
  const dir = (targetDir.value || data.value?.workDir || '').trim()
  if (!dir) { initMsg.value = { ok: false, text: t('git.needDir') }; return }
  initBusy.value = true
  initMsg.value = null
  try {
    const r = await chatStore.bridgeRpc('git.init', { sessionId: convId.value, repoDir: dir })
    if (isUnhandled(r)) {
      initMsg.value = { ok: false, text: t('git.needRestart') }
    } else if (r?.ok) {
      initMsg.value = { ok: true, text: r.already ? t('git.initAlready') : t('git.initOk') }
      await load()
    } else {
      initMsg.value = { ok: false, text: String(r?.error || t('git.initFail')) }
    }
  } catch (e: any) {
    initMsg.value = { ok: false, text: String(e?.message || e) }
  } finally {
    initBusy.value = false
  }
}

const norm = (p?: string) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
/** 会话目录不在仓库里 —— 提示"改动可能提交不到这个仓库" */
const outsideRepo = computed(() => {
  const d = data.value
  if (!d?.isRepo || !d.repoRoot || !d.workDir) return false
  const wd = norm(d.workDir), root = norm(d.repoRoot)
  return wd !== root && !wd.startsWith(root + '/')
})

/** 时间：今年 MM-DD HH:MM / 往年 YYYY-MM-DD */
function fmtAt(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  const hm = p(d.getHours()) + ':' + p(d.getMinutes())
  if (d.getFullYear() === new Date().getFullYear()) return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${hm}`
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

onMounted(() => {
  loadLinked()
  if (props.open) { if (mode.value === 'linked') void loadRelated(); void load() }
})
watch(() => props.open, v => { if (v) { loadLinked(); if (mode.value === 'linked') void loadRelated(); void load() } })
watch(convId, () => { loadLinked(); if (props.open) void load() })
</script>

<template>
  <div class="w-[300px] min-w-0 h-full bg-white border-l border-gray-200 flex flex-col overflow-hidden">
    <!-- 标题行：标题 + 两个 tab（本会话 / 关联）+ 刷新 / 关闭 -->
    <div class="px-3 pt-3 pb-2 border-b border-gray-100">
      <div class="flex items-center gap-1.5">
        <h3 class="text-[14px] font-[640] text-gray-800 flex items-center gap-1.5 shrink-0">
          <i class="fas fa-code-branch text-[11px] text-gray-400"></i>{{ t('git.title') }}
        </h3>
        <div class="flex items-center gap-0.5 p-0.5 rounded-lg bg-gray-100 shrink-0">
          <button
            class="px-1.5 py-0.5 rounded-md text-[10px] transition-colors"
            :class="mode === 'self' ? 'bg-white text-gray-800 shadow-sm' : 'text-gray-500 hover:text-gray-700'"
            @click="switchMode('self')"
          >{{ t('git.tabSelf') }}</button>
          <button
            class="px-1.5 py-0.5 rounded-md text-[10px] transition-colors"
            :class="mode === 'linked' ? 'bg-white text-gray-800 shadow-sm' : 'text-gray-500 hover:text-gray-700'"
            @click="switchMode('linked')"
          >{{ t('git.tabLinked') }}</button>
        </div>
        <div class="flex-1"></div>
        <button class="w-6 h-6 shrink-0 rounded-[9999px] flex items-center justify-center text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors" :title="t('filetree.refresh')" @click="load">
          <i class="fas fa-rotate text-[12px]" :class="{ 'fa-spin': loading }"></i>
        </button>
        <button class="w-6 h-6 shrink-0 rounded-[9999px] flex items-center justify-center text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors" :title="t('workspace.close')" @click="emit('close')">
          <i class="fas fa-xmark text-[14px]"></i>
        </button>
      </div>

      <!-- 目标行：仓库根路径 + 分支 + 未提交数（不静默 —— 这是"哪个仓库"的唯一答案） -->
      <template v-if="mode === 'self' && data?.isRepo">
        <div class="mt-1 text-[10px] text-gray-400 break-all leading-4" :title="data.repoRoot">{{ data.repoRoot }}</div>
        <div class="flex items-center gap-1.5 mt-1">
          <span class="px-1.5 py-[1px] rounded bg-gray-100 text-[10px] text-gray-600 font-mono">{{ data.branch || t('git.noBranch') }}</span>
          <span v-if="data.dirty" class="text-[10px] text-amber-600">{{ t('git.dirtyPrefix') }}{{ data.dirty }}</span>
          <span v-else class="text-[10px] text-emerald-600">{{ t('git.clean') }}</span>
        </div>
        <div v-if="outsideRepo" class="mt-1 flex items-start gap-1 text-[10px] text-amber-600 leading-4">
          <i class="fas fa-triangle-exclamation text-[9px] mt-[3px]"></i>
          <span>{{ t('git.outsideRepo') }}</span>
        </div>
      </template>
      <!-- 关联模式：亮出关联的目标 + 更换/取消 -->
      <template v-else-if="mode === 'linked' && linkedDir">
        <div class="mt-1 flex items-start gap-1">
          <span class="vp-hint text-[10px] shrink-0">{{ t('git.tabLinked') }}</span>
          <span class="vp-text text-[10px] break-all leading-4 flex-1" :title="linkedDir">{{ linkedDir }}</span>
        </div>
        <div class="flex items-center gap-1.5 mt-1">
          <button class="vp-link text-[10px]" @click="clearLink">{{ t('git.linkChange') }}</button>
          <span class="vp-sep">|</span>
          <button class="vp-link text-[10px]" @click="clearLink">{{ t('git.linkClear') }}</button>
        </div>
      </template>
    </div>

    <!-- 关联选择区（关联 tab 且还没设目标）：手填 + 有关的（自动识别）+ 最近看过 + 项目，点一下直达 -->
    <div v-if="mode === 'linked' && !linkedDir" class="flex-1 px-3 py-3 overflow-y-auto custom-scroll">
      <p class="text-[10px] text-gray-400 leading-4">{{ t('git.linkHint') }}</p>
      <div class="flex items-center gap-1.5 mt-2">
        <input
          v-model="draftDir"
          class="vp-input flex-1 min-w-0 text-[11px] px-2 py-1.5 rounded-lg outline-none transition-colors"
          :placeholder="t('git.linkPlaceholder')"
          @keydown.enter="pickDir(draftDir)"
        />
        <button
          class="vp-primary shrink-0 w-8 h-8 rounded-lg flex items-center justify-center disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          :disabled="!draftDir.trim()"
          :title="t('git.linkUse')"
          @click="pickDir(draftDir)"
        >
          <i class="fas fa-arrow-right text-[11px]"></i>
        </button>
      </div>

      <!-- 跟本对话有关（自动识别：会话里出现过的路径 → 所属仓库；没有证据就不显示） -->
      <template v-if="related.length">
        <div class="vp-hint mt-3 text-[10px]">{{ t('git.relatedTitle') }}</div>
        <button
          v-for="r in related"
          :key="r.repoRoot"
          class="vp-row w-full flex items-center gap-1.5 px-2 py-1.5 mt-0.5 rounded-lg text-left transition-colors"
          :title="r.repoRoot"
          @click="pickDir(r.repoRoot)"
        >
          <i class="fas fa-code-branch vp-hint text-[10px] shrink-0"></i>
          <span class="vp-text text-[11px] shrink-0">{{ shortName(r.repoRoot) }}</span>
          <span class="vp-hint text-[10px] truncate">{{ r.repoRoot }}</span>
        </button>
      </template>

      <!-- 最近看过（全局共享） -->
      <template v-if="recent.length">
        <div class="vp-hint mt-3 text-[10px]">{{ t('git.recentTitle') }}</div>
        <button
          v-for="r in recent"
          :key="r"
          class="vp-row w-full flex items-center gap-1.5 px-2 py-1.5 mt-0.5 rounded-lg text-left transition-colors"
          :title="r"
          @click="pickDir(r)"
        >
          <i class="fas fa-clock-rotate-left vp-hint text-[10px] shrink-0"></i>
          <span class="vp-text text-[11px] shrink-0">{{ shortName(r) }}</span>
          <span class="vp-hint text-[10px] truncate">{{ r }}</span>
        </button>
      </template>

      <!-- 我的项目 -->
      <template v-if="projects.length">
        <div class="vp-hint mt-3 text-[10px]">{{ t('git.projectsTitle') }}</div>
        <button
          v-for="p in projects"
          :key="p.id"
          class="vp-row w-full flex items-center gap-1.5 px-2 py-1.5 mt-0.5 rounded-lg text-left transition-colors"
          :title="p.root_path"
          @click="pickDir(p.root_path)"
        >
          <i class="fas fa-folder vp-hint text-[10px] shrink-0"></i>
          <span class="vp-text text-[11px] shrink-0">{{ p.name }}</span>
          <span class="vp-hint text-[10px] truncate">{{ p.root_path }}</span>
        </button>
      </template>
    </div>

    <template v-else>
      <!-- 非仓库：如实说原因（不吞错），并给「初始化仓库」 -->
      <div v-if="!data" class="flex-1 flex items-center justify-center text-[12px] text-gray-400">{{ t('git.loading') }}</div>
      <div v-else-if="!data.isRepo" class="flex-1 px-4 py-5 text-[12px] leading-5 overflow-y-auto custom-scroll">
        <div class="vp-text flex items-center gap-1.5">
          <i class="fas fa-folder-open text-[12px]"></i>{{ t('git.noRepo') }}
        </div>
        <div v-if="data.workDir" class="vp-hint mt-2 text-[10px] break-all">{{ data.workDir }}</div>
        <div v-if="data.error" class="vp-hint mt-2 px-2 py-1.5 rounded vp-input text-[10px] break-all">{{ data.error }}</div>
        <button
          class="vp-primary mt-3 w-full py-2 rounded-lg text-[12px] disabled:opacity-40 transition-colors"
          :disabled="initBusy"
          @click="doInit"
        >
          <i class="fas fa-code-branch text-[10px] mr-1" :class="{ 'fa-spin': initBusy }"></i>{{ initBusy ? t('git.initBusy') : t('git.init') }}
        </button>
        <p class="vp-hint mt-2 text-[10px] leading-4">{{ t('git.initHint') }}</p>
        <p v-if="initMsg" class="mt-2 text-[10px] leading-4" :class="initMsg.ok ? 'vp-ok' : 'vp-err'">{{ initMsg.text }}</p>
      </div>

      <!-- 仓库态：上方固定「提交」区，下方时间线 -->
      <template v-else>
      <div class="px-3 py-2 border-b border-gray-100 shrink-0">
        <div class="flex items-center gap-2">
          <span class="text-[10px]" :class="data.dirty ? 'text-amber-600' : 'text-emerald-600'">
            {{ data.dirty ? t('git.dirtyPrefix') + data.dirty : t('git.clean') }}
          </span>
          <div class="flex-1"></div>
          <button
            class="vp-primary text-[11px] px-2.5 py-1 rounded-lg disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            :disabled="!data.dirty || commitBusy"
            @click="toggleCommit"
          >{{ t('git.commitBtn') }}</button>
        </div>
        <!-- 提交表单：先预检"要提交多少文件" → 写说明 → 提交（来源记本对话） -->
        <div v-if="commitOpen" class="mt-2">
          <input
            v-model="commitMsg"
            class="vp-input w-full text-[12px] px-2.5 py-1.5 rounded-lg outline-none transition-colors"
            :placeholder="t('git.commitPlaceholder')"
            @keydown.enter="doCommit"
          />
          <div class="flex items-center gap-1.5 mt-2">
            <button
              class="vp-primary flex-1 py-1.5 rounded-lg text-[11px] disabled:opacity-40 transition-colors"
              :disabled="commitBusy || !commitMsg.trim()"
              @click="doCommit"
            >{{ commitBusy ? t('git.commitBusy') : (needConfirm ? t('git.commitConfirmAgain') : t('git.commitConfirm')) }}</button>
            <button class="vp-ghost px-3 py-1.5 rounded-lg text-[11px] transition-colors" @click="commitOpen = false">{{ t('git.cancel') }}</button>
          </div>
          <p class="mt-1.5 text-[10px] leading-4" :class="needConfirm ? 'text-amber-600' : 'vp-hint'">{{ previewText }}</p>
        </div>
        <p v-if="opMsg" class="mt-1.5 text-[10px] leading-4 break-all" :class="opMsg.ok ? 'text-emerald-600' : 'text-rose-500'">{{ opMsg.text }}</p>
      </div>

      <div class="flex-1 min-h-0 overflow-y-auto custom-scroll">
        <div v-if="initMsg" class="px-4 py-2 border-b border-gray-50 text-[10px] leading-4" :class="initMsg.ok ? 'text-emerald-600' : 'text-rose-500'">{{ initMsg.text }}</div>
        <div v-if="!data.commits.length" class="py-10 px-4 text-center text-[12px] text-gray-400">
          {{ t('git.noCommits') }}
          <p class="mt-2 text-[10px] text-gray-300 leading-4">{{ t('git.emptyRepoHint') }}</p>
        </div>
        <!-- 其他存档点：被「回溯／跳回」移出当前历史的那些线（置灰）—— 放最上面；可点回，也可清除 -->
        <template v-if="data.detached && data.detached.length">
          <!-- 默认折叠：点标题行展开/收起（「清除全部」点它不会触发折叠） -->
          <div
            class="flex items-center gap-1.5 px-4 py-2 border-b border-gray-100 cursor-pointer select-none"
            @click="detachedOpen = !detachedOpen"
          >
            <i class="fas vp-hint text-[9px]" :class="detachedOpen ? 'fa-chevron-down' : 'fa-chevron-right'"></i>
            <span class="vp-hint text-[10px] flex-1">{{ t('git.detachedTitle') }} · {{ t('git.detachedCount').replace('{n}', String(data.detached.length)) }}</span>
            <button
              class="vp-ghost text-[10px] px-1.5 py-0.5 rounded-md transition-colors"
              :title="t('git.dropAllHint')"
              @click.stop="askDrop()"
            >{{ t('git.dropAll') }}</button>
          </div>
          <div
            v-show="detachedOpen"
            v-for="c in data.detached"
            :key="c.hash"
            class="group px-4 py-2 border-b border-gray-50 opacity-55 hover:opacity-100 transition-opacity"
          >
            <div class="flex items-center gap-1.5 text-[10px]">
              <span class="vp-hint shrink-0">{{ fmtAt(c.at) }}</span>
              <span class="vp-hint font-mono shrink-0">{{ c.short }}</span>
              <span class="vp-chip px-1.5 py-[1px] rounded text-[9px] shrink-0">{{ t('git.detachedBadge') }}</span>
              <div class="flex-1 min-w-0"></div>
              <div class="flex items-center gap-1 shrink-0 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                <button class="vp-ghost text-[10px] px-1.5 py-0.5 rounded-md transition-colors" :title="t('git.resetHint')" @click="askReset(c)">{{ t('git.reset') }}</button>
                <button class="vp-ghost text-[10px] px-1.5 py-0.5 rounded-md transition-colors" :title="t('git.dropHint')" @click="askDrop(c.tagName)">{{ t('git.drop') }}</button>
              </div>
            </div>
            <div class="vp-text mt-1 text-[12px] leading-4 break-words">{{ c.subject }}</div>
            <div v-if="c.sessionTitle" class="vp-hint mt-0.5 text-[10px] truncate" :title="c.sessionTitle">← {{ c.sessionTitle }}</div>
          </div>
        </template>

        <div
          v-for="c in data.commits"
          :key="c.hash"
          class="group px-4 py-2.5 border-b border-gray-50 hover:bg-gray-50 transition-colors"
        >
          <div class="flex items-center gap-1.5 text-[10px] text-gray-400">
            <span class="shrink-0">{{ fmtAt(c.at) }}</span>
            <span class="font-mono text-gray-300 shrink-0">{{ c.short }}</span>
            <span
              v-if="c.source"
              class="vp-chip px-1.5 py-[1px] rounded text-[9px] shrink-0"
            >{{ c.source === 'ai' ? t('git.originAi') : t('git.originUser') }}</span>
            <div class="flex-1 min-w-0"></div>
            <!-- 写操作：悬停该条才显示；放**时间行右侧**（放最下面那行会把「来源对话」挤断，反馈过） -->
            <div class="flex items-center gap-1 shrink-0 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
              <button class="vp-ghost text-[10px] px-1.5 py-0.5 rounded-md transition-colors" :title="t('git.revertHint')" @click="askRevert(c)">{{ t('git.revert') }}</button>
              <button class="vp-ghost text-[10px] px-1.5 py-0.5 rounded-md transition-colors" :title="t('git.resetHint')" @click="askReset(c)">{{ t('git.reset') }}</button>
            </div>
          </div>
          <div class="mt-1 text-[12px] text-gray-800 leading-4 break-words">{{ c.subject }}</div>
          <div class="mt-1 flex items-center gap-2 text-[10px]">
            <span class="text-gray-400 shrink-0">{{ c.files }} {{ t('git.filesUnit') }}</span>
            <span class="text-emerald-600 shrink-0">+{{ c.added }}</span>
            <span class="text-rose-500 shrink-0">-{{ c.removed }}</span>
            <!-- 来源对话：哪个窗口提交的（这行有整行空间，不再被按钮挤断） -->
            <span v-if="c.sessionTitle" class="vp-hint truncate" :title="c.sessionTitle">← {{ c.sessionTitle }}</span>
          </div>
        </div>

        <!-- 其他存档点：被「回到这里」移出当前历史的那些提交（置灰显示，点一下就能跳回去） -->
      </div>
      </template>
    </template>

    <!-- 二次确认弹窗（居中显示；Teleport 到 body，免得被右栏的 300px 挤扁） -->
    <Teleport to="body">
      <div v-if="confirmDialog" class="vp-mask" @click.self="confirmDialog = null">
        <div class="vp-dialog">
          <div class="vp-dialog-title">{{ confirmDialog.title }}</div>
          <div class="vp-dialog-body">{{ confirmDialog.body }}</div>
          <div class="vp-dialog-actions">
            <button class="vp-dialog-cancel" @click="confirmDialog = null">{{ t('git.cancel') }}</button>
            <button class="vp-dialog-ok" @click="confirmDialog.run()">{{ confirmDialog.okText }}</button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
/* ── 配色：中性灰阶（不用彩色高亮，避免"花哨"），并为深色模式给覆盖 ──
   项目深色模式用 `html.dark` 选择器（与 BgTaskModal 等一致），不用 Tailwind 的 dark: 前缀。 */
.vp-primary {
  background: #3f3f46;
  color: #ffffff;
  border: 1px solid #3f3f46;
}
.vp-primary:hover:not(:disabled) { background: #52525b; border-color: #52525b; }
.vp-ghost {
  background: transparent;
  color: #71717a;
  border: 1px solid #e4e4e7;
}
.vp-ghost:hover { background: #f4f4f5; color: #3f3f46; }
.vp-input {
  background: #fafafa;
  border: 1px solid #e4e4e7;
  color: #3f3f46;
}
.vp-input:focus { border-color: #a1a1aa; background: #ffffff; }
.vp-hint { color: #a1a1aa; }
.vp-text { color: #52525b; }
.vp-link { color: #71717a; }
.vp-link:hover { color: #18181b; }
.vp-row:hover { background: #f4f4f5; }
.vp-chip { background: #f4f4f5; color: #71717a; }
.vp-sep { color: #d4d4d8; }
.vp-ok { color: #059669; }
.vp-err { color: #e11d48; }

html.dark .vp-primary { background: #e4e4e7; color: #18181b; border-color: #e4e4e7; }
html.dark .vp-primary:hover:not(:disabled) { background: #d4d4d8; border-color: #d4d4d8; }
html.dark .vp-ghost { color: #a1a1aa; border-color: #3f3f46; }
html.dark .vp-ghost:hover { background: #27272a; color: #e4e4e7; }
html.dark .vp-input { background: #18181b; border-color: #3f3f46; color: #e4e4e7; }
html.dark .vp-input:focus { border-color: #52525b; background: #202024; }
html.dark .vp-hint { color: #71717a; }
html.dark .vp-text { color: #d4d4d8; }
html.dark .vp-link { color: #a1a1aa; }
html.dark .vp-link:hover { color: #fafafa; }
html.dark .vp-row:hover { background: #27272a; }
html.dark .vp-chip { background: #27272a; color: #a1a1aa; }
html.dark .vp-sep { color: #3f3f46; }
html.dark .vp-ok { color: #34d399; }
html.dark .vp-err { color: #fb7185; }
</style>

<style>
/* 二次确认弹窗：Teleport 到 body ⇒ scoped 选择器对它不生效，这里用全局类名（vp- 前缀防撞车） */
.vp-mask {
  position: fixed;
  inset: 0;
  z-index: 9998;
  background: rgba(0, 0, 0, 0.35);
  display: flex;
  align-items: center;
  justify-content: center;
}
.vp-dialog {
  width: 360px;
  max-width: calc(100vw - 40px);
  background: #ffffff;
  border-radius: 14px;
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.22);
  padding: 18px 18px 14px;
}
.vp-dialog-title { font-size: 14px; font-weight: 640; color: #18181b; }
.vp-dialog-body { margin-top: 10px; font-size: 12px; line-height: 1.65; color: #52525b; white-space: pre-line; }
.vp-dialog-actions { margin-top: 18px; display: flex; justify-content: flex-end; gap: 8px; }
.vp-dialog-cancel {
  padding: 6px 14px;
  border-radius: 10px;
  font-size: 12px;
  color: #71717a;
  border: 1px solid #e4e4e7;
  background: transparent;
}
.vp-dialog-cancel:hover { background: #f4f4f5; color: #3f3f46; }
.vp-dialog-ok { padding: 6px 16px; border-radius: 10px; font-size: 12px; color: #ffffff; background: #e11d48; }
.vp-dialog-ok:hover { background: #be123c; }
html.dark .vp-dialog { background: #1c1c24; }
html.dark .vp-dialog-title { color: #ececf1; }
html.dark .vp-dialog-body { color: #b4b4bd; }
html.dark .vp-dialog-cancel { color: #a1a1aa; border-color: #3f3f46; }
html.dark .vp-dialog-cancel:hover { background: #27272a; color: #e4e4e7; }
</style>
