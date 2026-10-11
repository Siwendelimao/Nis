<script setup lang="ts">
/**
 * 后台任务详情弹窗（0922 D 批次）
 *
 * 设计口径：「查看就做个弹窗得了，里面带个详细信息记录；cmd 那种直接显示 cmd 的内容，
 *            下载的就进度条+历史」—— 不再切全屏"任务视图"（那套是复用聊天气泡的对话式记录，多余）。
 *
 * 结构：
 *   · 头部：状态点 + 标题 + 状态徽标 + 计时 + 关闭
 *   · 命令类：命令行（可复制）+ 输出正文（等宽 · 自动滚底 · 可刷新/复制）
 *   · 下载类：大进度条 + 已下载/总量 + 速度 + 剩余 + 保存路径
 *   · 事件记录：可折叠时间线（默认收起；用 steps + 结果/错误拼装，不再是聊天气泡）
 *
 * 数据：stores/tasks.ts（列表明细）+ RPC `bg.read`（输出正文，lines 可调）
 * ⚠️ i18n：能复用的复用（bgTask.stop / bgTask.open / bgTask.title / bgTask.running…），
 *    新增文案暂用中文（TODO：补 i18n key 后替换）。
 */
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useTasksStore } from '@/stores/tasks'
import { useChatStore } from '@/stores/chat'
import { t } from '@/utils/i18n'
import { swallowed } from '@/utils/swallowed'

const props = defineProps<{ taskId: string; convId?: number | string | null }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const tasksStore = useTasksStore()
const chatStore = useChatStore()

const task = computed<any>(() => tasksStore.tasks.find((x: any) => x.task_id === props.taskId) || null)
const isDownload = computed(() => String(task.value?.kind || '') === 'download')
/** ★ 0922c-7（Q2）：命令类也能有读条 —— percent ≥ 0 视为已知进度 */
const pctKnown = computed(() => Number(task.value?.percent ?? -1) >= 0)
const running = computed(() => ['background', 'paused'].includes(String(task.value?.status || '')))
const failed = computed(() => String(task.value?.status || '') === 'failed')
const paused = computed(() => String(task.value?.status || '') === 'paused')
/** ★ 0922c-3：下载任务的暂停/继续 */
async function pauseDownload() { try { await tasksStore.pauseTask(props.taskId) } catch (e) { swallowed('暂停下载失败（点了没反应）', e, 1) } }
async function resumeDownload() { try { await tasksStore.resumeTask(props.taskId) } catch (e) { swallowed('继续下载失败（点了没反应）', e, 1) } }
const statusText = computed(() => {
  const s = String(task.value?.status || '')
  if (s === 'background') return task.value?.progressNote || t('bgTask.running')
  if (s === 'paused') return '已暂停'
  if (s === 'completed') return '已完成'
  if (s === 'cancelled') return '已取消'
  if (s === 'failed') return '失败'
  return s || '—'
})
const dotClass = computed(() => {
  const s = String(task.value?.status || '')
  return s === 'background' ? 'is-run' : s === 'completed' ? 'is-ok' : s === 'paused' ? 'is-warn' : s === 'cancelled' ? 'is-off' : 'is-err'
})

/* 计时（每秒跳） */
const nowTick = ref(Date.now())
let tick: any = null
const elapsed = computed(() => {
  const tk = task.value
  if (!tk) return ''
  const end = running.value ? nowTick.value : (tk.finishedAt || nowTick.value)
  const sec = Math.max(0, Math.round((end - (tk.created_at || end)) / 1000))
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return m > 0 ? `${m}:${String(s).padStart(2, '0')}` : `${s}s`
})

/* 下载数值 */
const pct = computed(() => {
  const p = Number(task.value?.percent ?? -1)
  return p < 0 ? 0 : Math.min(100, p)
})
const fmtBytes = (n?: number) => {
  if (!n) return ''
  return n >= 1073741824 ? (n / 1073741824).toFixed(2) + ' GB' : n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.round(n / 1024) + ' KB'
}
const speed = computed(() => {
  const b = Number(task.value?.speedBps || 0)
  if (!b) return ''
  return b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB/s' : Math.round(b / 1024) + ' KB/s'
})
const eta = computed(() => {
  const s = Number(task.value?.etaSec || 0)
  if (!s) return ''
  return s >= 60 ? `剩 ${Math.ceil(s / 60)} 分` : `剩 ${s} 秒`
})

/* 输出：打开时拉一次，运行中每 2s 刷新 */
const output = ref('')
const outLines = ref(200)
const pulling = ref(false)
const outBox = ref<HTMLElement | null>(null)
const copied = ref(false)
async function pullOutput(scroll = true) {
  pulling.value = true
  try {
    const r: any = await chatStore.bridgeRpc('bg.read', { taskId: props.taskId, lines: outLines.value })
    output.value = String(r?.text ?? r?.output ?? r?.content ?? '')
  } catch { /* ignore */ } finally { pulling.value = false }
  if (scroll) { await nextTick(); if (outBox.value) outBox.value.scrollTop = outBox.value.scrollHeight }
}
function copyOutput() {
  try { void navigator.clipboard?.writeText(output.value); copied.value = true; setTimeout(() => { copied.value = false }, 1200) } catch { /* ignore */ }
}
let poll: any = null
function schedulePoll() {
  if (poll) { clearInterval(poll); poll = null }
  if (running.value) poll = setInterval(() => { if (running.value) void pullOutput() }, 2000)
}
onMounted(async () => { await pullOutput(); schedulePoll() })
onUnmounted(() => { if (poll) clearInterval(poll); if (tick) clearInterval(tick) })
watch(() => props.taskId, async () => { await pullOutput(); schedulePoll() })
watch(running, schedulePoll)

/* 事件记录（可折叠）：steps + 结果/错误，拼成简洁时间线，不再是气泡 */
const recOpen = ref(false)
const events = computed<Array<{ at: string; kind: string; text: string }>>(() => {
  const tk = task.value
  if (!tk) return []
  const list: Array<{ at: string; kind: string; text: string }> = []
  const fmt = (ts?: number) => (ts ? new Date(ts).toLocaleTimeString('zh-CN', { hour12: false }) : '')
  if (tk.created_at) list.push({ at: fmt(tk.created_at), kind: '开始', text: tk.title || '' })
  /* ★ 0922c-10（B）：步骤**不再塞进时间线** —— 原来每条都拿 finishedAt 当时间（全同一个时间戳，纯误导），
     改由下方独立的「步骤」块渲染（带状态点、按顺序）。 */
  if (tk.result) list.push({ at: fmt(tk.finishedAt), kind: '结果', text: String(tk.result) })
  if (tk.error) list.push({ at: fmt(tk.finishedAt), kind: '错误', text: String(tk.error) })
  return list
})

/* ★ 0922c-10：步骤 / 预计（弹窗侧） */
const stepsList = computed<any[]>(() => (Array.isArray((task.value as any)?.steps) ? (task.value as any).steps : []))
const doneSteps = computed(() => stepsList.value.filter((s: any) => s.status === 'done').length)
const estSec = computed(() => Number((task.value as any)?.estSec || 0))
const estLeft = computed<number | null>(() => {
  if (estSec.value <= 0) return null
  const used = (Date.now() - Number((task.value as any)?.created_at || Date.now())) / 1000
  return Math.round(estSec.value - used)
})
function fmtEst(sec: number): string {
  const s = Math.max(0, Math.round(sec))
  if (s >= 3600) return `${Math.floor(s / 3600)} 小时 ${Math.round((s % 3600) / 60)} 分`
  if (s >= 60) return `${Math.floor(s / 60)} 分${s % 60 ? ' ' + (s % 60) + ' 秒' : ''}`
  return `${s} 秒`
}

/* 操作 */
async function stopTask() { try { await tasksStore.stopTask(props.taskId) } catch { /* ignore */ } }
/** ★ 0924：关闭动画（先播 180ms 出场，再真正卸载）—— 原来点关闭"啪"一下就没了 */
const closing = ref(false)
function close() {
  if (closing.value) return
  closing.value = true
  window.setTimeout(() => emit('close'), 180)
}
function onEsc(e: KeyboardEvent) { if (e.key === 'Escape') close() }
onMounted(() => document.addEventListener('keydown', onEsc))
onUnmounted(() => document.removeEventListener('keydown', onEsc))
</script>

<template>
  <div class="bgtm-mask" :class="{ 'is-closing': closing }" @click.self="close">
    <div class="bgtm-panel" role="dialog" aria-modal="true">
      <!-- 头部 -->
      <div class="bgtm-head">
        <span class="bgtm-dot" :class="dotClass"></span>
        <span class="bgtm-title" :title="task?.title || ''">{{ task?.title || t('bgTask.title') }}</span>
        <span class="bgtm-badge" :class="dotClass">{{ statusText }}</span>
        <span class="bgtm-elapsed">{{ elapsed }}</span>
        <button class="bgtm-x" :title="'关闭'" @click="close"><i class="fas fa-xmark"></i></button>
      </div>

      <!-- ★ 0924：中间内容包进可滚动区（原来面板 overflow:hidden + max-height 直接把尾部裁掉，
           导致「事件记录」和底部按钮看不到内容 —— 实测反馈） -->
      <div class="bgtm-body">
      <!-- 元信息 -->
      <div class="bgtm-meta" :title="taskId">
        <span>{{ isDownload ? '下载任务' : '命令任务' }}</span>
        <span v-if="task?.preview" class="bgtm-tag">预览</span>
      </div>

      <!-- ★ 0922c-7（Q2）：命令类任务的自报进度（bg_note）—— 有百分比画读条，只有说明就一行 -->
       <div v-if="!isDownload && (pctKnown || task?.progressReported || estSec > 0)" class="bgtm-dl">
         <div v-if="pctKnown" class="bgtm-dlbar"><i :style="{ width: (task?.status === 'completed' ? 100 : pct) + '%' }" :class="{ done: task?.status === 'completed', err: failed, off: task?.status === 'cancelled' }"></i></div>
         <div class="bgtm-dlnums">
           <span v-if="pctKnown" class="bgtm-pct">{{ task?.status === 'completed' ? 100 : Math.round(pct) }}%</span>
           <span v-else class="bgtm-mono">AI 自报</span>
         </div>
         <div v-if="task?.progressNote" class="bgtm-note">{{ task.progressNote }}</div>
         <div v-if="estSec > 0" class="bgtm-estline">
           <span class="bgtm-est">预计</span><span class="bgtm-mono">{{ fmtEst(estSec) }}</span>
           <span v-if="estLeft !== null" class="bgtm-mono">· {{ estLeft >= 0 ? '约剩' : '超预计' }} {{ fmtEst(Math.abs(estLeft)) }}</span>
         </div>
       </div>

       <!-- ★ 0922c-13：步骤（div 行重写，不再用 ul/li —— 会被全局列表样式带歪） -->
       <div v-if="stepsList.length >= 2" class="bgtm-steps">
         <div class="bgtm-stephead">步骤 <span class="bgtm-stepnum">{{ doneSteps }}/{{ stepsList.length }}</span></div>
         <div class="bgtm-steprow" v-for="(st, si) in stepsList" :key="st.id + '-' + si" :class="st.status">
           <span class="bgtm-stepdot"></span>
           <span class="bgtm-steplabel">{{ st.label }}</span>
         </div>
       </div>

       <!-- 下载类：进度 + 数值 + 路径 -->
      <div v-if="isDownload" class="bgtm-dl">
        <div class="bgtm-dlbar"><i :style="{ width: (task?.status === 'completed' ? 100 : pct) + '%' }" :class="{ done: task?.status === 'completed', err: failed, off: task?.status === 'cancelled' }"></i></div>
        <div class="bgtm-dlnums">
          <span class="bgtm-pct">{{ task?.status === 'completed' ? 100 : Math.round(pct) }}%</span>
          <span v-if="fmtBytes(task?.progress?.bytes)" class="bgtm-mono">{{ fmtBytes(task?.progress?.bytes) }}<template v-if="fmtBytes(task?.progress?.totalBytes)"> / {{ fmtBytes(task?.progress?.totalBytes) }}</template></span>
          <span v-if="running && speed" class="bgtm-mono">{{ speed }}</span>
          <span v-if="running && eta" class="bgtm-mono">{{ eta }}</span>
        </div>
        <div v-if="task?.dest" class="bgtm-path" :title="task.dest">
          <i class="fas fa-folder-open"></i><span class="bgtm-mono">{{ task.dest }}</span>
        </div>
        <div v-if="task?.progressNote" class="bgtm-note">{{ task.progressNote }}</div>
      </div>

      <!-- 命令类：命令行 + 输出 -->
      <template v-else>
        <div v-if="(task as any)?.command" class="bgtm-cmd">
          <div class="bgtm-cmdlabel">命令</div>
          <div class="bgtm-cmdtext bgtm-mono">{{ (task as any).command }}</div>
        </div>
        <div class="bgtm-outhead">
          <span class="bgtm-outlabel">输出</span>
          <span class="bgtm-spacer"></span>
          <button class="bgtm-icobtn" title="刷新" @click="pullOutput()"><i class="fas fa-rotate-right" :class="{ 'fa-spin': pulling }"></i></button>
          <button class="bgtm-icobtn" :title="copied ? '已复制' : '复制'" @click="copyOutput"><i class="fas" :class="copied ? 'fa-check' : 'fa-copy'"></i></button>
        </div>
        <pre ref="outBox" class="bgtm-out bgtm-mono">{{ output || '（暂无输出）' }}</pre>
      </template>

      <!-- 失败原因 -->
      <div v-if="failed && task?.error" class="bgtm-err">
        <div class="bgtm-errlabel"><i class="fas fa-triangle-exclamation"></i>失败原因</div>
        <div class="bgtm-mono bgtm-errtext">{{ task.error }}</div>
      </div>

      <!-- 事件记录（折叠） -->
      <button class="bgtm-recbtn" @click="recOpen = !recOpen">
        <i class="fas" :class="recOpen ? 'fa-caret-down' : 'fa-caret-right'"></i>
        事件记录（{{ events.length }}）
      </button>
      <div v-if="recOpen" class="bgtm-rec">
        <div v-if="!events.length" class="bgtm-empty">（暂无记录）</div>
        <div v-for="(ev, i) in events" :key="i" class="bgtm-recrow">
          <span class="bgtm-mono bgtm-recAt">{{ ev.at }}</span>
          <span class="bgtm-recKind">{{ ev.kind }}</span>
          <span class="bgtm-recText" :title="ev.text">{{ ev.text }}</span>
        </div>
      </div>
      </div>
      <!-- /bgtm-body -->

      <!-- 底部 -->
      <div class="bgtm-foot">
        <button v-if="isDownload && running" class="bgtm-btn" @click="pauseDownload">{{ t('bgTask.pause') }}</button>
        <button v-else-if="isDownload && paused" class="bgtm-btn" @click="resumeDownload">{{ t('bgTask.resume') }}</button>
        <button v-if="running || paused" class="bgtm-btn danger" @click="stopTask">{{ t('bgTask.stop') }}</button>
        <span class="bgtm-spacer"></span>
        <button class="bgtm-btn plain" @click="close">关闭</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 弹窗：实色白卡（与后台任务胶囊/面板同族），遮罩轻黑 */
.bgtm-mask {
  position: fixed;
  inset: 0;
  z-index: 200;
  background: rgba(15, 23, 42, 0.28);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  /* ★ 0922：弹窗挂在 pointer-events-none 的容器里 ⇒ 必须显式恢复可交互，否则整块点不动 */
  pointer-events: auto;
}
.bgtm-panel {
  width: 100%;
  max-width: 720px;
  max-height: min(80vh, 720px);
  display: flex;
  flex-direction: column;
  border-radius: 16px;
  background: #fff;
  border: 1px solid rgba(226, 232, 240, 0.95);
  box-shadow: 0 20px 60px rgba(15, 23, 42, 0.22), 0 4px 12px rgba(15, 23, 42, 0.08);
  overflow: hidden;
  animation: bgtmIn 0.18s ease-out;
}
@keyframes bgtmIn {
  from { opacity: 0; transform: translateY(8px) scale(0.985); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}
.bgtm-head { display: flex; align-items: center; gap: 8px; padding: 12px 16px 8px; }
.bgtm-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.bgtm-dot.is-run { background: #6366f1; animation: bgtmPulse 1.6s ease-in-out infinite; }
.bgtm-dot.is-ok { background: #10b981; }
.bgtm-dot.is-warn { background: #f59e0b; }
.bgtm-dot.is-off { background: #9ca3af; }
.bgtm-dot.is-err { background: #ef4444; }
@keyframes bgtmPulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
.bgtm-title { font-size: 14px; font-weight: 600; color: #18181b; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* ★ 0922c：状态徽标去描边（原"描边胶囊"与计划卡不是一个语言）——颜色由左侧状态点承担，文字只留中性灰 */
.bgtm-badge { font-size: 11px; color: #a1a1aa; flex-shrink: 0; }
.bgtm-elapsed { font-size: 11px; color: #a1a1aa; font-variant-numeric: tabular-nums; margin-left: auto; }
/* ★ 0924（用户：关闭按钮统一到项目主流规格）—— 与进程监控弹窗 .prm-x 同规格（28px / radius 8 / gray-400） */
.bgtm-x { cursor: pointer; width: 28px; height: 28px; border-radius: 8px; color: #9ca3af; font-size: 13px; display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; transition: background 0.15s ease, color 0.15s ease, transform 0.16s cubic-bezier(0.22, 1, 0.36, 1); }
.bgtm-x:hover { background: #f3f4f6; color: #4b5563; }
/* ★ 0922c：次级操作一律图标按钮（与消息操作行同款语言：hover 灰底 + title 提示），不再一排描边小按钮 */
.bgtm-icobtn { cursor: pointer; width: 24px; height: 24px; border-radius: 7px; display: inline-flex; align-items: center; justify-content: center; color: #9ca3af; font-size: 11px; flex-shrink: 0; transition: background 0.15s ease, color 0.15s ease; }
.bgtm-icobtn:hover { background: #f4f4f5; color: #3f3f46; }
.bgtm-btn.plain { border-color: transparent; background: transparent; color: #71717a; }
.bgtm-btn.plain:hover { background: #f4f4f5; border-color: transparent; color: #3f3f46; }
.bgtm-meta { display: flex; align-items: center; gap: 6px; padding: 0 16px 10px; font-size: 11px; color: #a1a1aa; }
.bgtm-sep { color: #e4e4e7; }
.bgtm-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.bgtm-tag { font-size: 9px; padding: 1px 5px; border-radius: 4px; background: #fde68a; color: #92400e; }

.bgtm-dl { padding: 4px 16px 10px; }
/* ★ 0922c-13：与计划卡同款（h-1 圆角 / 灰黑填充 / 完成翠绿 / 失败红） */
.bgtm-dlbar { position: relative; height: 6px; border-radius: 9999px; background: #f4f4f5; overflow: hidden; }
.bgtm-dlbar i { position: relative; display: block; height: 100%; border-radius: 9999px; background: #18181b; transition: width 0.4s ease; }
.bgtm-dlbar i.done { background: #10b981; }
.bgtm-dlbar i.err { background: #ef4444; }
.bgtm-dlbar i.off { background: #a1a1aa; }
.bgtm-dlnums { display: flex; align-items: center; gap: 10px; margin-top: 7px; font-size: 11px; color: #71717a; }
.bgtm-pct { font-weight: 600; color: #18181b; font-variant-numeric: tabular-nums; }
.bgtm-path { display: flex; align-items: center; gap: 6px; margin-top: 7px; font-size: 11px; color: #52525b; word-break: break-all; }
.bgtm-note { margin-top: 6px; font-size: 11px; color: #a1a1aa; }

.bgtm-cmd { padding: 4px 16px 6px; }
.bgtm-cmdlabel { font-size: 10px; color: #a1a1aa; margin-bottom: 4px; }
.bgtm-cmdtext { font-size: 11px; color: #3f3f46; background: #f8fafc; border: 1px solid rgba(226, 232, 240, 0.9); border-radius: 8px; padding: 7px 9px; word-break: break-all; max-height: 76px; overflow-y: auto; }
.bgtm-outhead { display: flex; align-items: center; gap: 6px; padding: 6px 16px 6px; }
.bgtm-outlabel { font-size: 11px; font-weight: 500; color: #52525b; }
.bgtm-spacer { flex: 1; }
.bgtm-out {
  margin: 0 16px 10px;
  padding: 10px 12px;
  border-radius: 10px;
  background: #0f172a;
  color: #cbd5e1;
  font-size: 11px;
  line-height: 1.6;
  max-height: 320px;
  min-height: 120px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-all;
}
.bgtm-err { margin: 0 16px 10px; padding: 9px 11px; border-radius: 10px; background: #fef2f2; border: 1px solid #fecaca; }
.bgtm-errlabel { font-size: 11px; font-weight: 600; color: #dc2626; margin-bottom: 4px; display: flex; align-items: center; gap: 5px; }
.bgtm-errtext { font-size: 11px; color: #b91c1c; line-height: 1.6; max-height: 120px; overflow-y: auto; word-break: break-all; }
.bgtm-recbtn { cursor: pointer; display: flex; align-items: center; gap: 6px; margin: 2px 16px 0; padding: 6px 0; font-size: 11px; color: #71717a; text-align: left; }
.bgtm-recbtn:hover { color: #3f3f46; }
.bgtm-rec { margin: 0 16px 8px; max-height: 180px; overflow-y: auto; overflow-x: hidden; border-top: 1px solid rgba(226, 232, 240, 0.9); }
/* ★ 0922c：事件记录去"日志感"——去掉虚线分隔与靛蓝 kind，改成计划卡条目那种 hover 落点 */
.bgtm-recrow { display: flex; align-items: baseline; gap: 8px; padding: 5px 6px; margin: 0 -6px; border-radius: 8px; font-size: 11px; transition: background 0.15s ease; }
.bgtm-recrow:hover { background: rgba(244, 244, 245, 0.9); }
.bgtm-recAt { color: #c4c4cc; flex-shrink: 0; }
.bgtm-recKind { color: #71717a; flex-shrink: 0; }
.bgtm-recText { color: #52525b; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bgtm-empty { padding: 10px 0; font-size: 11px; color: #a1a1aa; }
.bgtm-foot { display: flex; align-items: center; gap: 8px; padding: 10px 16px 14px; border-top: 1px solid rgba(241, 245, 249, 0.9); }

.bgtm-btn { cursor: pointer; font-size: 12px; padding: 5px 12px; border-radius: 8px; border: 1px solid rgba(203, 213, 225, 0.9); background: #fff; color: #3f3f46; transition: border-color 0.15s ease, color 0.15s ease, background 0.15s ease, transform 0.06s ease; white-space: nowrap; }
.bgtm-btn:hover { background: #eef2ff; border-color: #6366f1; color: #4338ca; }
.bgtm-btn:active { transform: scale(0.97); }
.bgtm-btn.sm { font-size: 11px; padding: 3px 9px; border-radius: 7px; }
.bgtm-btn.danger:hover { border-color: #ef4444; color: #dc2626; background: #fef2f2; }

/* 深色 */
html.dark .bgtm-panel { background: #1c1c24; border-color: rgba(255, 255, 255, 0.09); }
html.dark .bgtm-title { color: #ececf1; }
html.dark .bgtm-cmdtext { background: #16161d; border-color: rgba(255, 255, 255, 0.08); color: #d4d4d8; }
html.dark .bgtm-out { background: #0b0f19; }
html.dark .bgtm-recbtn { color: #9a9aa4; }
html.dark .bgtm-rec { border-top-color: rgba(255, 255, 255, 0.08); }
html.dark .bgtm-recrow { border-bottom-color: rgba(255, 255, 255, 0.06); }
html.dark .bgtm-recText { color: #b4b4bd; }
html.dark .bgtm-btn { background: #26262e; border-color: #34343f; color: #d4d4d8; }
html.dark .bgtm-foot { border-top-color: rgba(255, 255, 255, 0.07); }
html.dark .bgtm-err { background: rgba(127, 29, 29, 0.25); border-color: rgba(248, 113, 113, 0.35); }
html.dark .bgtm-x:hover { background: rgba(255, 255, 255, 0.07); color: #e4e4e7; }
html.dark .bgtm-icobtn:hover { background: rgba(255, 255, 255, 0.08); color: #e4e4e7; }
html.dark .bgtm-btn.plain { background: transparent; color: #9a9aa4; }
html.dark .bgtm-btn.plain:hover { background: rgba(255, 255, 255, 0.08); color: #e4e4e7; }
html.dark .bgtm-recrow:hover { background: rgba(255, 255, 255, 0.06); }
html.dark .bgtm-badge { color: #8b8b96; }
/* ★ 0922c-13：预计行 + 步骤列表
   ⚠️ 步骤**不用 <ul>/<li>** —— 上一版被全局列表样式（padding/margin/list-style）带歪，布局乱套（实测反馈）。
      现在用 div 行 + 明确 flex/行高/缩进，任何全局样式都带不歪。 */
.bgtm-estline { display: flex; align-items: center; gap: 6px; margin-top: 6px; font-size: 11px; color: #71717a; }
.bgtm-est { font-size: 10px; color: #52525b; border: 1px solid rgba(24, 24, 27, 0.16); border-radius: 4px; padding: 0 4px; }
.bgtm-steps { margin: 12px 16px 0; padding: 10px 0 0; border-top: 1px solid rgba(0, 0, 0, 0.06); }
.bgtm-stephead { display: flex; align-items: center; gap: 6px; font-size: 11px; color: #71717a; margin-bottom: 8px; }
.bgtm-stepnum { color: #3f3f46; font-variant-numeric: tabular-nums; }
.bgtm-steprow { display: flex; align-items: center; gap: 8px; min-height: 18px; font-size: 11.5px; line-height: 18px; color: #a1a1aa; }
.bgtm-steprow + .bgtm-steprow { margin-top: 2px; }
.bgtm-stepdot { flex: 0 0 6px; width: 6px; height: 6px; border-radius: 50%; background: rgba(161, 161, 170, 0.45); }
.bgtm-steplabel { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bgtm-steprow.done { color: #52525b; }
.bgtm-steprow.done .bgtm-stepdot { background: #10b981; }
.bgtm-steprow.active { color: #18181b; font-weight: 530; }
.bgtm-steprow.active .bgtm-stepdot { background: #f59e0b; box-shadow: 0 0 0 2px rgba(245, 158, 11, 0.18); }
html.dark .bgtm-dlbar { background: rgba(255, 255, 255, 0.12); }
html.dark .bgtm-dlbar i { background: #e4e4e7; }
html.dark .bgtm-dlbar i.done { background: #10b981; }
html.dark .bgtm-dlbar i.off { background: #71717a; }
html.dark .bgtm-pct { color: #f4f4f5; }
html.dark .bgtm-steps { border-top-color: rgba(255, 255, 255, 0.08); }
html.dark .bgtm-stepnum { color: #d4d4d8; }
html.dark .bgtm-steprow { color: #71717a; }
html.dark .bgtm-steprow.done { color: #d4d4d8; }
html.dark .bgtm-steprow.done .bgtm-stepdot { background: #34d399; }
html.dark .bgtm-steprow.active { color: #f4f4f5; }
html.dark .bgtm-est { color: #d4d4d8; border-color: rgba(255, 255, 255, 0.18); }
/* ═══════════ ★ 0924：去"实色白卡"→ 同族「伪磨砂」质感（不依赖 backdrop-filter，本环境安全）
   + 关闭动画 + 触感补齐 ═══════════ */

.bgtm-mask {
  background: rgba(2, 6, 23, 0.38);
  animation: bgtmMaskIn 0.2s ease-out;
}
@keyframes bgtmMaskIn { from { opacity: 0 } to { opacity: 1 } }
.bgtm-mask.is-closing { animation: bgtmMaskOut 0.18s ease-in forwards; }
@keyframes bgtmMaskOut { from { opacity: 1 } to { opacity: 0 } }

/* 面板：伪磨砂（与 .plan-shell / 进程监控弹窗同语言：冷调白渐变 + 内高光 + 多层阴影）
   ★ 不用 backdrop-filter —— 项目铁律：本环境采样不可用，否则打包版只剩半透明会发灰 */
.bgtm-panel {
  background: linear-gradient(160deg, rgba(255, 255, 255, 0.985) 0%, rgba(248, 250, 252, 0.965) 55%, rgba(241, 245, 249, 0.95) 100%);
  border: 1px solid rgba(255, 255, 255, 0.7);
  box-shadow:
    0 24px 64px rgba(2, 6, 23, 0.24),
    0 4px 14px rgba(2, 6, 23, 0.08),
    inset 0 1px 0 rgba(255, 255, 255, 0.95);
}
.bgtm-mask.is-closing .bgtm-panel { animation: bgtmOut 0.18s ease-in forwards; }
@keyframes bgtmOut { from { opacity: 1; transform: none } to { opacity: 0; transform: translateY(6px) scale(0.98) } }

/* ★ 0924：中间内容滚动区（头 / 底固定，超长内容不再被 overflow:hidden 裁掉
   —— 实测反馈"事件记录看不到内容"就是这个原因） */
.bgtm-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; overflow-x: hidden; overscroll-behavior: contain; }

/* 运行中状态点：原脉冲 + 扩散光环（静止的感觉变"活"） */
.bgtm-dot.is-run { animation: bgtmPulse 1.6s ease-in-out infinite, bgtmRing 2.2s ease-out infinite; }
@keyframes bgtmRing { 0% { box-shadow: 0 0 0 0 rgba(99, 102, 241, 0.4) } 100% { box-shadow: 0 0 0 7px rgba(99, 102, 241, 0) } }

/* 关闭 / 图标 / 底部按钮：hover 放大、按下回弹 */
.bgtm-x { transition: background 0.16s ease, color 0.16s ease, transform 0.16s cubic-bezier(0.22, 1, 0.36, 1); }
.bgtm-x:hover { transform: scale(1.06); }
.bgtm-x:active { transform: scale(0.92); }
.bgtm-icobtn { transition: background 0.16s ease, color 0.16s ease, transform 0.16s cubic-bezier(0.22, 1, 0.36, 1); }
.bgtm-icobtn:hover { transform: scale(1.1); }
.bgtm-icobtn:active { transform: scale(0.9); }
.bgtm-btn { transition: background 0.16s ease, color 0.16s ease, border-color 0.16s ease, transform 0.14s ease; }
.bgtm-btn:active { transform: scale(0.96); }

/* 步骤行 / 事件记录行：hover 微位移（原来生硬） */
.bgtm-steprow, .bgtm-recrow { transition: background 0.16s ease, transform 0.16s ease; }
.bgtm-steprow:hover { transform: translateX(2px); }

/* 深色：同样磨砂 */
html.dark .bgtm-panel {
  background: linear-gradient(160deg, rgba(40, 40, 47, 0.99) 0%, rgba(28, 28, 33, 0.985) 60%, rgba(22, 22, 26, 0.98) 100%);
  border-color: rgba(255, 255, 255, 0.1);
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.5), 0 4px 14px rgba(0, 0, 0, 0.3), inset 0 1px 0 rgba(255, 255, 255, 0.06);
}

/* 无障碍：尊重系统"减少动态效果" */
@media (prefers-reduced-motion: reduce) {
  .bgtm-mask, .bgtm-panel, .bgtm-dot.is-run { animation: none !important; }
  .bgtm-x, .bgtm-icobtn, .bgtm-btn, .bgtm-steprow, .bgtm-recrow { transition: none !important; }
}
</style>
