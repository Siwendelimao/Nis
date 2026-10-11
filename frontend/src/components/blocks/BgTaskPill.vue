<script setup lang="ts">
/**
 * 后台任务胶囊（0920）—— 会话区**左上角**，与右上角的「计划卡」成对但明显区分。
 *
 * 设计口径：
 *   · 形态跟计划卡一样（胶囊 + 折叠/展开浮层），但**位置在左上角**
 *   · **要有特殊标识跟计划卡区分开** —— 这里用「靛蓝 + 秒表图标 + 写明『后台』」
 *     （计划卡是灰黑/琥珀/青 + 清单图标）
 *   · **持续性的（长命令）要显示计时**；**下载类的要有读条**——AI 给的所有下载都进这里看进度
 *   · 进度**不用实时**，轮询粒度更新即可（后端 1s 推一次 + 这里 2s 拉一次兜底）
 *
 * 数据来源：`stores/tasks.ts`（后端 backgroundTasks.ts 的镜像）
 */
import { computed, onUnmounted, ref, watch } from 'vue'
import { useTasksStore } from '@/stores/tasks'
import type { BackgroundTask } from '@/stores/tasks'
import { localStore } from '@/utils/localStore'
import { t } from '@/utils/i18n'

const props = defineProps<{ convId: number | string | null; openTask?: (id: string) => void }>()

const tasksStore = useTasksStore()

const COLLAPSED_KEY = 'nis-bgtask-collapsed'
const collapsed = ref(true)
/** ★ 0922：失败原因展开状态（模板里 errOpen[task_id] 用到，必须声明！） */
const errOpen = ref<Record<string, boolean>>({})

function readMap(): Record<string, boolean> {
  try { return JSON.parse(localStore.getItem(COLLAPSED_KEY) || '{}') } catch { return {} }
}
function restoreState() {
  if (props.convId == null || props.convId === '') { collapsed.value = true; return }
  const v = readMap()[String(props.convId)]
  collapsed.value = v === undefined ? true : v
}
restoreState()
watch(() => props.convId, restoreState)
function setCollapsed(v: boolean) {
  collapsed.value = v
  if (props.convId == null || props.convId === '') return
  try { const m = readMap(); m[String(props.convId)] = v; localStore.setItem(COLLAPSED_KEY, JSON.stringify(m)) } catch { /* ignore */ }
}

/* ── 外点收起（与计划卡同款铁律：下拉菜单外点即收） ── */
const wrapRef = ref<HTMLElement | null>(null)
function onOutside(e: MouseEvent) {
  if (wrapRef.value && !wrapRef.value.contains(e.target as Node)) setCollapsed(true)
}
let outsideAddTimer: ReturnType<typeof setTimeout> | null = null
watch(collapsed, (c) => {
  /* 0927 netfix outside-guard-0927：定时器要可撤销 —— 快速"展开又收起"时，挂起的 add 会在
     remove 之后才执行 → 外点监听残留（泄漏 + 意外收起）。收起时清掉挂起的 add。 */
  if (outsideAddTimer) { clearTimeout(outsideAddTimer); outsideAddTimer = null }
  if (!c) outsideAddTimer = setTimeout(() => { outsideAddTimer = null; document.addEventListener('click', onOutside) }, 0)
  else document.removeEventListener('click', onOutside)
})

/* ── 数据 ── */
const mine = computed<BackgroundTask[]>(() =>
  props.convId == null ? [] : tasksStore.tasksForConversation(props.convId),
)
const running = computed(() => mine.value.filter((x) => x.status === 'background' || x.status === 'paused'))
const finished = computed(() => mine.value.filter((x) => x.status !== 'background' && x.status !== 'paused'))
/** 折叠时显示"当前在跑的第一条" */
const cur = computed<BackgroundTask | undefined>(() => running.value[0])

const anyProgress = computed(() => {
  const d = running.value.find((x) => x.kind === 'download' && (x.percent ?? -1) >= 0)
  return d ? Math.round(d.percent || 0) : null
})

/* ★ 0922c-16：列表滚动状态 —— 只有滑动时才显示滚动条（默认完全隐藏） */
const listScrolling = ref(false)
let listScrollTimer: ReturnType<typeof setTimeout> | null = null
function onListScroll(): void {
  listScrolling.value = true
  if (listScrollTimer) clearTimeout(listScrollTimer)
  listScrollTimer = setTimeout(() => { listScrolling.value = false }, 700)
}

/* ── 计时：跑着的任务显示已用时（每秒跳一次） ── */
const nowTick = ref(Date.now())
let tickTimer: ReturnType<typeof setInterval> | null = null
tickTimer = setInterval(() => { nowTick.value = Date.now() }, 1000)
onUnmounted(() => {
  if (tickTimer) clearInterval(tickTimer)
  if (listScrollTimer) clearTimeout(listScrollTimer)
  document.removeEventListener('click', onOutside)
})

/** 已用时（跑着=现在-createdAt；结束=finishedAt-createdAt） */
function elapsed(task: BackgroundTask): string {
  const end = task.status === 'background' || task.status === 'paused' ? nowTick.value : (task.finishedAt || nowTick.value)
  const sec = Math.max(0, Math.round((end - task.created_at) / 1000))
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return m > 0 ? `${m}:${String(s).padStart(2, '0')}` : `${s}s`
}

function pct(task: BackgroundTask): number {
  const p = task.percent ?? -1
  return p < 0 ? 0 : Math.min(100, p)
}

function speedOf(task: BackgroundTask): string {
  const b = task.speedBps || 0
  if (!b) return ''
  return (b >= 1048576 ? (b / 1048576).toFixed(1) + 'MB/s' : Math.round(b / 1024) + 'KB/s')
}
function etaOf(task: BackgroundTask): string {
  const s = task.etaSec || 0
  if (!s) return ''
  return s >= 60 ? `剩 ${Math.ceil(s / 60)} 分` : `剩 ${s} 秒`
}
function statusText(task: BackgroundTask): string {
  if (task.status === 'background') return task.progressNote || '运行中'
  if (task.status === 'completed') return '已完成'
  if (task.status === 'cancelled') return '已停止'
  if (task.status === 'failed') return '失败'
  return task.status
}
function isDone(task: BackgroundTask): boolean {
  return task.status !== 'background' && task.status !== 'paused'
}
/** 预览态（/bg-demo 注入的假数据）—— 明确标出来，别跟真任务混了 */
function isPreview(task: BackgroundTask): boolean {
  return task.task_id.startsWith('preview_')
}
/** ★ 0922c：状态图形化（沿用计划卡的圆点勾选语言）——完成=勾选圆点 / 失败=感叹号 / 跑着=脉动点 */
function markCls(task: BackgroundTask): Record<string, boolean> {
  return {
    'is-run': task.status === 'background',
    'is-pause': task.status === 'paused',
    'is-ok': task.status === 'completed',
    'is-err': task.status === 'failed',
    'is-off': task.status === 'cancelled',
  }
}

function openTaskView(task: BackgroundTask) {
  // 预览数据同样能进任务视图（视图只读 store 里的任务对象，不需要后端）
  props.openTask?.(task.task_id)
}
async function stopTask(task: BackgroundTask) {
  if (isPreview(task)) { tasksStore.dropPreview(task.task_id); return }
  await tasksStore.stopTask(task.task_id)
}
/** ★ 0922c2：行内「清除」（任务已结束后出现）——预览数据本地删，真任务走后端 bg.clear */
async function removeTask(task: BackgroundTask) {
  if (isPreview(task)) { tasksStore.dropPreview(task.task_id); return }
  await tasksStore.clearFinished([task.task_id])
}
/** ★ 0922c-3：下载任务的暂停/继续（预览数据不支持） */
async function pauseTask(task: BackgroundTask) {
  if (isPreview(task)) return
  await tasksStore.pauseTask(task.task_id)
}
async function resumeTask(task: BackgroundTask) {
  if (isPreview(task)) return
  await tasksStore.resumeTask(task.task_id)
}
/** ★ 0922c-7（Q2）：有百分比就画读条（下载类天然有、命令类靠 bg_note 自报） */
function hasBar(task: BackgroundTask): boolean {
  return Number(task.percent ?? -1) >= 0
}

/** ★ 0922c-14：填充色的**语义**要分开 —— 完成=翠绿（与计划卡同款）、失败=红、已停止=灰
    （原来一刀切 isDone() ⇒ 「已停止」也套上翠绿，看着像成功） */
function barFillCls(task: BackgroundTask): Record<string, boolean> {
  return {
    'bgt-bar-dl': String((task as any).kind || '') === 'download',   // ★ 0924（需求）：下载类读条=靛蓝，命令类=计划卡同款深灰黑
    'bgt-bar-done': task.status === 'completed',
    'bgt-bar-err': task.status === 'failed',
    'bgt-bar-off': task.status === 'cancelled',
  }
}

/** ★ 0922c-10：副信息形态（按数据自动选，优先级：百分比 > 预计 > 步骤 > 说明 > 无）
 *  ★ 0922c-18（用户选 A）：**只有"在跑 / 暂停"才显示进度行**。
 *  已结束的行（完成/已停止/失败）不再挂满格绿条 + 100% —— 那条进度已经没信息量了，
 *  几条排在一起就是"同一条重复 N 遍"（实测反馈：看着比预览数据闷）。要看当时的进度点进详情弹窗。
 *  失败原因那行不受影响（由 tk.error 单独渲染）。 */
function subOf(task: BackgroundTask): 'bar' | 'est' | 'steps' | 'note' | 'none' {
  if (isDone(task)) return 'none'
  if (hasBar(task)) return 'bar'
  if (estSecOf(task) > 0 && !isDone(task)) return 'est'
  if (stepsOf(task).length >= 2 && !isDone(task)) return 'steps'
  if (task.progressReported && task.progressNote && !isDone(task)) return 'note'
  return 'none'
}
/** 已用时（秒）—— 与 elapsed() 同一口径，带 nowTick 响应性 */
function usedSec(task: BackgroundTask): number {
  const end = task.status === 'background' || task.status === 'paused' ? nowTick.value : (task.finishedAt || nowTick.value)
  return Math.max(0, (end - Number(task.created_at || nowTick.value)) / 1000)
}
function estSecOf(task: BackgroundTask): number {
  return Number(task.estSec || 0)
}
function estPct(task: BackgroundTask): number {
  const est = estSecOf(task)
  if (est <= 0) return 0
  return Math.min(100, Math.max(0, Math.round((usedSec(task) / est) * 100)))
}
function fmtDur(sec: number): string {
  const s = Math.max(0, Math.round(sec))
  if (s >= 3600) return `${Math.floor(s / 3600)} 小时 ${Math.round((s % 3600) / 60)} 分`
  if (s >= 60) return `${Math.floor(s / 60)} 分${s % 60 ? ' ' + (s % 60) + ' 秒' : ''}`
  return `${s} 秒`
}
function estText(task: BackgroundTask): string {
  const left = estSecOf(task) - usedSec(task)
  return left >= 0 ? `约剩 ${fmtDur(left)}` : `超预计 ${fmtDur(-left)}`
}
function stepsOf(task: BackgroundTask): any[] {
  return Array.isArray((task as any).steps) ? (task as any).steps : []
}
function doneStepCount(task: BackgroundTask): number {
  return stepsOf(task).filter((s) => s.status === 'done').length
}
function curStep(task: BackgroundTask): string {
  const list = stepsOf(task)
  const now = list.find((s) => s.status === 'active')
  if (now) return String(now.label || '')
  const next = list.find((s) => s.status !== 'done')
  return next ? String(next.label || '') : ''
}

/** ★ 0922c-17：头部状态标注（进行中/暂停/已完成/失败/已停止）——**非零才显示**，全零显示「暂无任务」 */
const legend = computed(() => {
  const n = (st: string) => mine.value.filter((x) => x.status === st).length
  return [
    { key: 'is-run', label: '进行中', n: n('background') },
    { key: 'is-pause', label: '暂停', n: n('paused') },
    { key: 'is-ok', label: '已完成', n: n('completed') },
    { key: 'is-err', label: '失败', n: n('failed') },
    { key: 'is-off', label: '已停止', n: n('cancelled') },
  ].filter((x) => x.n > 0)
})

/** 右侧状态文案：暂停=已暂停（不显示跳秒）；结束=状态·时长；跑着=计时 */
function stateText(task: BackgroundTask): string {
  if (task.status === 'paused') return '已暂停'
  if (isDone(task)) return statusText(task) + ' · ' + elapsed(task)
  return elapsed(task)
}
async function clearFinished() {
  const ids = finished.value.filter((x) => isPreview(x)).map((x) => x.task_id)
  if (ids.length) tasksStore.dropPreview(ids)
  const realIds = finished.value.filter((x) => !isPreview(x)).map((x) => x.task_id)
  if (realIds.length) await tasksStore.clearFinished(realIds)
}

/* 展开时补拉一次（进度按轮询口径更新，不追求实时） */
let pollTimer: ReturnType<typeof setInterval> | null = null
watch([collapsed, () => props.convId], ([c, id]) => {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
  if (c || id == null) return
  void tasksStore.syncFromBackend(id)
  pollTimer = setInterval(() => { void tasksStore.syncFromBackend(props.convId ?? undefined) }, 2000)
})
onUnmounted(() => { if (pollTimer) clearInterval(pollTimer) })
</script>

<template>
  <!-- 会话区左上角（容器在 ChatInterface 里，这里只管本体）。
       ★ 与计划卡的区分：靛蓝配色 + 秒表图标 + 折起来也写着「后台」。 -->
  <div v-if="mine.length" ref="wrapRef" class="bgt-wrap relative">
    <button
      class="bgt-pill"
      :class="{ open: !collapsed, 'is-done': running.length === 0 }"
      :title="collapsed ? t('bgTask.expand') : t('bgTask.collapse')"
      @click="setCollapsed(!collapsed)"
    >
      <span class="bgt-badge">{{ t('bgTask.tag') }}</span>
      <span class="bgt-count">{{ running.length }}</span>
      <span v-if="running.length === 0" class="bgt-cur text-emerald-600">{{ t('bgTask.allDone', { n: mine.length }) }}</span>
      <span v-if="cur" class="bgt-cur min-w-0">
        <span v-if="cur.status === 'background'" class="bgt-dots" aria-hidden="true"><i></i><i></i><i></i></span>
        <i v-else class="fas fa-pause text-[9px] text-amber-500"></i>
        <span class="truncate">{{ cur.title }}</span>
        <span class="bgt-time">{{ cur.status === 'paused' ? '已暂停' : elapsed(cur) }}</span>
        <span v-if="anyProgress !== null" class="bgt-mini-bar"><i :style="{ width: anyProgress + '%' }"></i></span>
      </span>
      <i class="fas fa-chevron-down bgt-caret" :class="collapsed ? '' : 'rotate-180'"></i>
    </button>

    <Transition name="bgt-pop">
            <div v-if="!collapsed" class="bgt-pop">
        <!-- ★ 0922c-16：头部固定（不随手滑走）；★ 0922c-17：改成**状态标注**（无分隔线） -->
        <div class="bgt-pop-head">
          <span v-for="g in legend" :key="g.key" class="bgt-lg">
            <i class="bgt-lg-dot" :class="g.key"></i>{{ g.label }} <b>{{ g.n }}</b>
          </span>
          <span v-if="!legend.length" class="bgt-lg">暂无任务</span>
          <button v-if="finished.length" class="bgt-icobtn" :title="t('bgTask.clearDone')" @click="clearFinished"><i class="fas fa-broom"></i></button>
        </div>

        <TransitionGroup tag="ul" name="bgtrow" class="bgt-list" :class="{ 'is-scrolling': listScrolling }" @scroll="onListScroll">
          <li
            v-for="tk in mine"
            :key="tk.task_id"
            class="bgt-item"
            :class="{ 'is-done': isDone(tk) }"
            :title="tk.title"
            @click="openTaskView(tk)"
          >
            <div class="bgt-row">
              <span class="bgt-mark" :class="markCls(tk)">
                <i v-if="tk.status === 'completed'" class="fas fa-check"></i>
                <i v-else-if="tk.status === 'paused'" class="fas fa-pause"></i>
                <i v-else-if="tk.status === 'cancelled'" class="fas fa-stop"></i>
                <i v-else-if="tk.status === 'failed'" class="fas fa-exclamation"></i>
              </span>
              <span class="bgt-name truncate">{{ tk.title }}</span>
              <!-- ★ 0922c-19：类型标签（用户点选）—— 名称后面标"下载 / 命令"，与「预览」同尺寸同族 -->
              <span class="bgt-tag bgt-kind" :class="tk.kind">{{ tk.kind === 'download' ? t('bgTask.kindDownload') : t('bgTask.kindCommand') }}</span>
              <span v-if="isPreview(tk)" class="bgt-tag">{{ t('bgTask.preview') }}</span>
              <span class="bgt-state" :class="{ 'is-paused': tk.status === 'paused' }">{{ stateText(tk) }}</span>
              <span class="bgt-rowbtns">
                <button
                  v-if="tk.kind === 'download' && !isDone(tk)"
                  class="bgt-icobtn"
                  :title="tk.status === 'paused' ? t('bgTask.resume') : t('bgTask.pause')"
                  @click.stop="tk.status === 'paused' ? resumeTask(tk) : pauseTask(tk)"
                ><i class="fas" :class="tk.status === 'paused' ? 'fa-play' : 'fa-pause'"></i></button>
                <button
                  class="bgt-icobtn"
                  :class="{ danger: !isDone(tk) }"
                  :title="isDone(tk) ? t('bgTask.clear') : t('bgTask.stop')"
                  @click.stop="isDone(tk) ? removeTask(tk) : stopTask(tk)"
                ><i class="fas" :class="isDone(tk) ? 'fa-xmark' : 'fa-stop'"></i></button>
              </span>
            </div>

            <!-- ★ 0922c-7（Q2）：进度与类型**解耦** —— 有百分比就画读条
                 （下载类天然有；命令类靠 AI 用 bg_note 自报）；只自报了说明 → 一行灰字；
                  两者都没有 → 只显示"名称 + 计时"（挂机类，保持干净） -->
            <div v-if="subOf(tk) === 'bar'" class="bgt-sub">
              <div class="bgt-bar"><i :class="barFillCls(tk)" :style="{ width: (isDone(tk) && tk.status === 'completed' ? 100 : pct(tk)) + '%' }"><span v-if="tk.status === 'background' && pct(tk) > 0 && pct(tk) < 100" class="bgt-bar-shine"></span></i></div>
              <div class="bgt-subrow">
                <span class="tabular-nums">{{ (isDone(tk) && tk.status === 'completed' ? 100 : Math.round(pct(tk))) }}%</span>
                <span v-if="tk.progressNote && !isDone(tk)" class="truncate">{{ tk.progressNote }}</span>
                <span v-if="tk.status === 'background' && speedOf(tk)" class="ml-auto shrink-0 tabular-nums">{{ speedOf(tk) }}</span>
                <span v-if="tk.status === 'background' && etaOf(tk)" class="shrink-0 tabular-nums">{{ etaOf(tk) }}</span>
              </div>
            </div>

            <!-- ★ 0922c-10（A）：没百分比但有预计时长 → 浅色虚线「预计」条 + 约剩多久（明确不是精确进度） -->
            <div v-else-if="subOf(tk) === 'est'" class="bgt-sub">
              <div class="bgt-bar is-est"><i :style="{ width: estPct(tk) + '%' }"></i></div>
              <div class="bgt-subrow">
                <span class="bgt-est">预计</span>
                <span class="tabular-nums">{{ estText(tk) }}</span>
                <span v-if="tk.progressNote" class="truncate ml-auto">{{ tk.progressNote }}</span>
              </div>
            </div>

            <!-- ★ 0922c-10（B）：有步骤 → 步骤点 + "3/5 步" + 当前步名（比编一个百分比诚实） -->
            <div v-else-if="subOf(tk) === 'steps'" class="bgt-sub">
              <div class="bgt-subrow">
                <span class="bgt-steps"><i v-for="(st, si) in stepsOf(tk)" :key="st.id + '-' + si" :class="{ done: st.status === 'done', now: st.status === 'active' }"></i></span>
                <span class="tabular-nums">{{ doneStepCount(tk) }}/{{ stepsOf(tk).length }} 步</span>
                <span v-if="curStep(tk)" class="truncate ml-auto">{{ curStep(tk) }}</span>
              </div>
            </div>

            <!-- 只有自报说明、没有百分比：补一行灰字（挂机类不受影响） -->
            <div v-else-if="subOf(tk) === 'note'" class="bgt-sub">
              <div class="bgt-subrow"><span class="truncate">{{ tk.progressNote }}</span></div>
            </div>

            <!-- 失败原因：独占一行，点它展开（不抢整行的"查看"点击） -->
            <button
              v-if="tk.error"
              type="button"
              class="bgt-err"
              :class="{ expanded: errOpen[tk.task_id] }"
              @click.stop="errOpen[tk.task_id] = !errOpen[tk.task_id]"
            >{{ tk.error }}</button>
          </li>
        </TransitionGroup>

        <!-- ★ 0922c-16：底部文字去掉，保留底部区域（那条分隔线） -->
        <div class="bgt-foot" aria-hidden="true"></div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
/* 材质 = 计划卡同款「输入框磨砂」：backdrop-filter blur(16px) saturate(1.6) + 白渐变 + 内高光 */
.bgt-wrap { position: relative; pointer-events: auto; display: inline-flex; flex-direction: column; align-items: flex-start; }

/* ★ 0922·对齐计划卡：同款「输入框磨砂」材质（边框/背景/backdrop-filter/阴影与 .plan-pill 同值），
   与计划卡视觉同族；区分只靠靛蓝「后台」徽标 + 秒表图标（不再用偏蓝的材质去区分）。 */
.bgt-pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: 340px;
  padding: 3px 9px;
  border-radius: 9999px;
  border: 1px solid rgba(229, 231, 235, 0.9);
  background: linear-gradient(160deg, rgba(255, 255, 255, 0.72) 0%, rgba(255, 255, 255, 0.56) 100%);
  backdrop-filter: blur(16px) saturate(1.6);
  -webkit-backdrop-filter: blur(16px) saturate(1.6);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.06), inset 0 1px 0 rgba(255, 255, 255, 0.9);
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.15s ease, border-color 0.15s ease;
}
.bgt-pill:hover { background: linear-gradient(160deg, rgba(255, 255, 255, 0.84) 0%, rgba(255, 255, 255, 0.68) 100%); border-color: rgba(203, 213, 225, 0.9); }
.bgt-pill.open { background: linear-gradient(160deg, rgba(255, 255, 255, 0.86) 0%, rgba(255, 255, 255, 0.72) 100%); }
/* ★ 0922c-20：完成态边框对齐计划卡（原来用靛蓝，用户看着"发紫"）——与 .plan-pill.pill-done **完全同值** */
.bgt-pill.is-done { border-color: rgba(67, 56, 202, 0.5); }

/* ★ 特殊标识：靛蓝「后台」徽标 + 秒表图标（计划卡是灰黑/琥珀/青 + 清单图标） */
.bgt-badge {
  display: inline-flex; align-items: center; gap: 4px; flex-shrink: 0;
  font-size: 9px; line-height: 1; font-weight: 600;
  padding: 2px 6px; border-radius: 9999px;
  color: #4338ca; background: rgba(224, 231, 255, 0.95);
}
.bgt-count { font-size: 10px; font-family: ui-monospace, monospace; color: #4f46e5; font-weight: 600; }
.bgt-cur { font-size: 11px; color: #52525b; display: inline-flex; align-items: center; gap: 5px; max-width: 180px; }
.bgt-time { font-size: 10px; color: #71717a; font-variant-numeric: tabular-nums; font-weight: 500; flex-shrink: 0; }
.bgt-caret { font-size: 9px; color: #9ca3af; transition: transform 0.2s ease; }

/* 折叠态迷你进度条 */
.bgt-mini-bar { width: 34px; height: 3px; border-radius: 9999px; background: rgba(99, 102, 241, 0.18); overflow: hidden; flex-shrink: 0; }
.bgt-mini-bar i { display: block; height: 100%; background: #6366f1; transition: width 0.5s ease; }

/* 三点波浪（与计划卡同款运行指示，颜色随 currentColor） */
.bgt-dots { display: inline-flex; align-items: center; gap: 2.5px; flex-shrink: 0; }
.bgt-dots i { width: 3px; height: 3px; border-radius: 50%; background: currentColor; opacity: 0.35; animation: bgtDot 1.4s ease-in-out infinite; }
.bgt-dots i:nth-child(2) { animation-delay: 0.18s; }
.bgt-dots i:nth-child(3) { animation-delay: 0.36s; }
@keyframes bgtDot {
  0%, 100% { opacity: 0.3; transform: translateY(0); }
  40% { opacity: 0.9; transform: translateY(-2px); }
}

/* 展开浮层：从胶囊下方弹出（左上角锚点 → 左对齐） */
/* ★ 0922·对齐计划卡展开浮层（背景/边框/模糊/阴影/内边距与 .plan-pill-pop 同值） */
.bgt-pop {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  right: auto;   /* ★ 0922：显式否掉 right（计划卡在右上角用 right:0，别串到这边） */
  z-index: 90;
  width: 360px;
  max-height: 46vh;
  /* ★ 0922c-16：pop 自己**不再滚**（原来 max-height+overflow 在它身上 ⇒ 头部/底部会一起被滑走）。
     改成 flex 三段：头部固定 / 中间列表滚 / 底部固定。 */
  display: flex;
  flex-direction: column;
  overflow: hidden;
  padding: 10px 14px 12px;
  border-radius: 14px;
  background: linear-gradient(160deg, rgba(255, 255, 255, 0.8) 0%, rgba(255, 255, 255, 0.64) 100%);
  backdrop-filter: blur(16px) saturate(1.6);
  -webkit-backdrop-filter: blur(16px) saturate(1.6);
  /* ★ 0924：入场动画改由 <Transition name="bgt-pop"> 承担
     （原来直接挂在这里 → 收起时没有出场动画，与"计划卡 pill-pop"不对称） */
  border: 1px solid rgba(229, 231, 235, 0.9);
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.1), inset 0 1px 0 rgba(255, 255, 255, 0.85);
}
/* ★ 0922c-17：头部固定（不要分隔线 —— 用户说这两条线都去掉） */
.bgt-pop-head { flex: 0 0 auto; display: flex; align-items: center; flex-wrap: wrap; gap: 4px 10px; padding-bottom: 4px; }
/* ★ 0922c-17：状态标注（图例）—— 圆点与行内状态点同色，顺带把颜色语义讲明白 */
.bgt-lg { display: inline-flex; align-items: center; gap: 4px; font-size: 10px; color: #71717a; flex-shrink: 0; }
.bgt-lg b { font-weight: 600; color: #3f3f46; font-variant-numeric: tabular-nums; }
.bgt-lg-dot { flex: 0 0 6px; width: 6px; height: 6px; border-radius: 50%; background: #d4d4d8; }
.bgt-lg-dot.is-run { background: #6366f1; }
.bgt-lg-dot.is-ok { background: #4338ca; }
.bgt-lg-dot.is-pause { background: #f59e0b; }
.bgt-lg-dot.is-err { background: #ef4444; }
.bgt-lg-dot.is-off { background: #a1a1aa; }
.bgt-list {
  flex: 1 1 auto;
  min-height: 0;              /* flex 子项能真正收缩（否则滚不动） */
  overflow-y: auto;
  overflow-x: hidden;         /* ★ 0924：条目淡出时做横向位移，不加这句会冒出横向滚动条（实测反馈） */
  overscroll-behavior: contain;
  display: flex; flex-direction: column; gap: 4px;
  margin-top: 8px;
  /* ★ 0922c-16：滚动条默认**完全隐藏**，滑动时才浮现（颜色浅、3px） */
  scrollbar-width: thin;
  scrollbar-color: transparent transparent;
}
.bgt-list::-webkit-scrollbar { width: 3px; height: 3px; }
.bgt-list::-webkit-scrollbar-track { background: transparent; }
.bgt-list::-webkit-scrollbar-thumb { background: transparent; border-radius: 999px; }
.bgt-list.is-scrolling { scrollbar-color: rgba(0, 0, 0, 0.14) transparent; }
.bgt-list.is-scrolling::-webkit-scrollbar-thumb { background: rgba(0, 0, 0, 0.14); }
.bgt-item { padding: 6px 7px; border-radius: 10px; cursor: pointer; transition: background 0.15s ease; }
.bgt-row { display: flex; align-items: center; gap: 6px; min-width: 0; }
/* 状态圆点：与计划卡的勾选圆点同族（跑着=脉动 / 完成=勾选 / 失败=感叹 / 取消=灰） */
.bgt-mark { width: 14px; height: 14px; border-radius: 50%; flex-shrink: 0; display: inline-flex; align-items: center; justify-content: center; font-size: 7px; color: #fff; border: 1.5px solid #d4d4d8; transition: background 0.15s ease, border-color 0.15s ease; }
.bgt-mark.is-run { border-color: #a5b4fc; background: #6366f1; animation: bgtMarkPulse 1.6s ease-in-out infinite; }
.bgt-mark.is-ok { background: #4338ca; border-color: #4338ca; }
.bgt-mark.is-err { background: #ef4444; border-color: #ef4444; }
.bgt-mark.is-pause { background: #f59e0b; border-color: #f59e0b; }
.bgt-mark.is-off { background: #a1a1aa; border-color: #a1a1aa; }
.bgt-rowbtns { display: inline-flex; align-items: center; gap: 2px; flex-shrink: 0; }
.bgt-state.is-paused { color: #b45309; }
@keyframes bgtMarkPulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.45; } }
.bgt-name { font-size: 11.5px; color: #3f3f46; min-width: 0; }
.bgt-state { margin-left: auto; flex-shrink: 0; font-size: 10px; color: #a1a1aa; font-variant-numeric: tabular-nums; }
.bgt-sub { margin-top: 5px; padding-left: 20px; }
.bgt-subrow { display: flex; align-items: center; gap: 8px; margin-top: 4px; font-size: 9px; color: #a1a1aa; }
.bgt-item:hover { background: rgba(244, 244, 245, 0.9); }
/* ★ 0922c-4：失败原因是 <button>，而按钮**不继承字号**（浏览器 UA 默认 13.3px + 居中）
   —— 必须显式写字号/对齐/颜色，否则面板里冒出"一行莫名的大字"（实测反馈）。 */
.bgt-err {
  display: block; width: 100%; margin-top: 4px; padding: 0 0 0 20px;
  border: 0; background: transparent; font-family: inherit;
  text-align: left; font-size: 10px; line-height: 1.55; color: #b45309;
  cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.bgt-err.expanded { white-space: normal; word-break: break-word; max-height: 132px; overflow-y: auto; }
.bgt-tag { font-size: 8px; padding: 1px 4px; border-radius: 4px; background: #fde68a; color: #92400e; flex-shrink: 0; }
/* ★ 0922c-19：类型标签 —— 中性不抢戏（下载=浅靛蓝 / 命令=浅灰），形状沿用 .bgt-tag */
.bgt-kind { font-weight: 500; }
.bgt-kind.download { background: rgba(99, 102, 241, 0.12); color: #4338ca; }
.bgt-kind.command { background: rgba(0, 0, 0, 0.05); color: #71717a; }

/* ★ 0922c-13：条样式**对齐计划卡**（核对 PlanCard.vue）：h-1 圆角 + 灰黑填充（进行中，带流光扫过）
   + 完成转翠绿。原来那套靛蓝条与计划卡不是一家人。 */
.bgt-bar { position: relative; height: 4px; border-radius: 9999px; background: #f4f4f5; overflow: hidden; }
.bgt-bar i { position: relative; display: block; height: 100%; border-radius: 9999px; background: #18181b; transition: width 0.5s ease; }
.bgt-bar i.bgt-bar-done { background: #10b981; }
.bgt-bar i.bgt-bar-err { background: #ef4444; }
.bgt-bar i.bgt-bar-off { background: #a1a1aa; }
/* 进行中：流光扫过（与计划卡 .bar-shine 同款语言） */
.bgt-bar-shine { position: absolute; inset: 0; border-radius: inherit; background: linear-gradient(90deg, transparent 0%, rgba(255, 255, 255, 0.6) 50%, transparent 100%); background-size: 200% 100%; animation: bgtBarShine 1.5s linear infinite; }
@keyframes bgtBarShine { from { background-position: 200% 0; } to { background-position: -200% 0; } }

/* ★ 0922c：次级操作图标化 —— 查看=整行点击、停止=hover 浮现的图标（原两个描边按钮退休） */
.bgt-icobtn { cursor: pointer; display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; border-radius: 5px; font-size: 9px; color: #a1a1aa; opacity: 0; flex-shrink: 0; transition: opacity 0.15s ease, background 0.15s ease, color 0.15s ease; }
.bgt-item:hover .bgt-icobtn { opacity: 1; }
.bgt-icobtn:hover { background: rgba(0, 0, 0, 0.06); color: #3f3f46; }
.bgt-icobtn.danger:hover { background: rgba(239, 68, 68, 0.12); color: #dc2626; }
.bgt-pop-head .bgt-icobtn { opacity: 0.55; margin-left: auto; }
.bgt-pop-head .bgt-icobtn:hover { opacity: 1; }
/* ★ 0922c-17：底部保留区域，但**不要那条线** */
.bgt-foot { flex: 0 0 auto; margin-top: 6px; }

/* 进出场（与计划卡 pill-pop 同款） */
/* 进出场（与计划卡 pillIn 同款：keyframes + animation，0.18s / 0.14s reverse） */
@keyframes bgtPopIn {
  from { opacity: 0; transform: translateY(-6px) scale(0.97); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}

/* 深色：`--dsw-alias-*` 只在 html.dark 里有定义，这里直接写实数 */
html.dark .bgt-pill { border-color: rgba(255, 255, 255, 0.1); background: linear-gradient(160deg, rgba(38, 40, 54, 0.78) 0%, rgba(28, 30, 42, 0.66) 100%); backdrop-filter: blur(16px) saturate(1.6); -webkit-backdrop-filter: blur(16px) saturate(1.6); box-shadow: 0 2px 10px rgba(0, 0, 0, 0.4), inset 0 1px 0 rgba(255, 255, 255, 0.06); }
html.dark .bgt-pill:hover { border-color: rgba(203, 213, 225, 0.9); }
html.dark .bgt-pill.is-done { border-color: rgba(67, 56, 202, 0.5); }
html.dark .bgt-badge { color: #c7d2fe; background: rgba(67, 56, 202, 0.35); }
html.dark .bgt-cur { color: #c9c9d1; }
html.dark .bgt-pop { border-color: rgba(255, 255, 255, 0.1); background: linear-gradient(160deg, rgba(32, 34, 46, 0.86) 0%, rgba(24, 26, 36, 0.78) 100%); backdrop-filter: blur(16px) saturate(1.6); -webkit-backdrop-filter: blur(16px) saturate(1.6); box-shadow: 0 12px 32px rgba(0, 0, 0, 0.6); }

html.dark .bgt-list.is-scrolling { scrollbar-color: rgba(255, 255, 255, 0.18) transparent; }
html.dark .bgt-list.is-scrolling::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, 0.18); }
html.dark .bgt-item:hover { background: rgba(255, 255, 255, 0.06); }
html.dark .bgt-name { color: #d9d9e3; } html.dark .bgt-time { color: #9a9aa4; }
html.dark .bgt-nm { color: #9a9aa4; }
html.dark .bgt-state { color: #8b8b96; }
html.dark .bgt-subrow { color: #8b8b96; }
html.dark .bgt-mark { border-color: #3f3f46; }
html.dark .bgt-mark.is-ok { background: #818cf8; border-color: #818cf8; color: #1c1c24; }
html.dark .bgt-mark.is-pause { background: #fbbf24; border-color: #fbbf24; color: #1c1c24; }
html.dark .bgt-state.is-paused { color: #fbbf24; }
html.dark .bgt-err { color: #fbbf24; }
html.dark .bgt-bar { background: rgba(255, 255, 255, 0.12); }
html.dark .bgt-bar i { background: #e4e4e7; }
html.dark .bgt-bar i.bgt-bar-done { background: #10b981; }
html.dark .bgt-bar i.bgt-bar-err { background: #f87171; }
html.dark .bgt-bar i.bgt-bar-off { background: #71717a; }
html.dark .bgt-icobtn:hover { background: rgba(255, 255, 255, 0.1); color: #ececf1; }
html.dark .bgt-icobtn.danger:hover { background: rgba(239, 68, 68, 0.18); color: #fca5a5; }
html.dark .bgt-lg { color: #9a9aa4; }
html.dark .bgt-lg b { color: #d4d4d8; }
/* ★ 0922c-13：「预计」条 = 同款条 + **半透明填充**（不用虚线边框了，用户说看着奇怪）
   —— 半透明本身就传达"这不是精确进度" */
.bgt-bar.is-est i { background: rgba(24, 24, 27, 0.32); }
.bgt-est { font-size: 9px; color: #52525b; border: 1px solid rgba(24, 24, 27, 0.16); border-radius: 4px; padding: 0 3px; flex-shrink: 0; }
.bgt-steps { display: inline-flex; align-items: center; gap: 3px; flex-shrink: 0; }
.bgt-steps i { display: block; width: 5px; height: 5px; border-radius: 50%; background: rgba(161, 161, 170, 0.45); }
.bgt-steps i.done { background: #10b981; }
.bgt-steps i.now { background: #f59e0b; box-shadow: 0 0 0 2px rgba(245, 158, 11, 0.18); }
html.dark .bgt-bar.is-est i { background: rgba(228, 228, 231, 0.4); }
html.dark .bgt-est { color: #d4d4d8; border-color: rgba(255, 255, 255, 0.18); }
html.dark .bgt-steps i { background: rgba(113, 113, 122, 0.6); }
html.dark .bgt-steps i.done { background: #34d399; }
html.dark .bgt-kind.download { background: rgba(129, 140, 248, 0.18); color: #c7d2fe; }
html.dark .bgt-kind.command { background: rgba(255, 255, 255, 0.08); color: #a1a1aa; }

/* ═══════════ ★ 0924：动效补齐（用户：胶囊 / 面板 / 清除 / 关闭都要有动画） ═══════════ */

/* 胶囊本体：hover 微升 + 按压回弹；计数一变就弹跳 */
.bgt-pill { transition: background 0.15s ease, border-color 0.15s ease, transform 0.16s cubic-bezier(0.22, 1, 0.36, 1), box-shadow 0.16s ease; }
.bgt-pill:hover { transform: translateY(-1px); box-shadow: 0 4px 14px rgba(0, 0, 0, 0.09), inset 0 1px 0 rgba(255, 255, 255, 0.9); }
.bgt-pill:active { transform: translateY(0) scale(0.985); }
.bgt-count { display: inline-block; animation: bgtCountPop 0.32s cubic-bezier(0.34, 1.56, 0.64, 1); }
@keyframes bgtCountPop { 0% { transform: scale(0.7); opacity: 0.5 } 60% { transform: scale(1.12) } 100% { transform: scale(1); opacity: 1 } }
.bgt-cur { transition: color 0.15s ease; }

/* 展开浮层：由 <Transition name="bgt-pop"> 驱动**进出场**（与计划卡 pill-pop 完全对称） */
.bgt-pop { transform-origin: top left; }
.bgt-pop-enter-active { animation: bgtPopIn 0.18s ease-out; }
.bgt-pop-leave-active { animation: bgtPopIn 0.14s ease-in reverse; }

/* ★ 列表增删动画：清除/新增任务时逐条淡出淡入、其余条目顺滑让位（原来"啪"一下就没了） */
.bgt-list { position: relative; }
.bgtrow-enter-active, .bgtrow-leave-active { transition: all 0.28s cubic-bezier(0.22, 1, 0.36, 1); }
.bgtrow-enter-from { opacity: 0; transform: translateY(-6px) scale(0.98); }
.bgtrow-leave-to { opacity: 0; transform: translateX(14px) scale(0.97); }
.bgtrow-leave-active { position: absolute; left: 0; right: 0; }
.bgtrow-move { transition: transform 0.3s cubic-bezier(0.22, 1, 0.36, 1); }

/* 行 hover 微位移（原来只有背景变色） */
.bgt-item { transition: background 0.15s ease, transform 0.18s cubic-bezier(0.22, 1, 0.36, 1); }
.bgt-item:hover { transform: translateX(1px); }

/* 图标按钮（清除 / 暂停 / 停止）：hover 放大、按下回弹；出现时淡入 */
.bgt-icobtn { transition: opacity 0.15s ease, background 0.15s ease, color 0.15s ease, transform 0.16s cubic-bezier(0.22, 1, 0.36, 1); }
.bgt-icobtn:hover { transform: scale(1.12); }
.bgt-icobtn:active { transform: scale(0.88); }
/* 扫帚（清除已完成）：hover 时转个小角度，暗示"清扫" */
.bgt-pop-head .bgt-icobtn:hover i { transform: rotate(-14deg); }
.bgt-pop-head .bgt-icobtn i { transition: transform 0.18s cubic-bezier(0.22, 1, 0.36, 1); }

/* 步骤点 / 状态点：活跃项呼吸 */
.bgt-steps i.now { animation: bgtStepPulse 1.5s ease-in-out infinite; }
@keyframes bgtStepPulse { 0%, 100% { opacity: 1 } 50% { opacity: 0.45 } }

/* ★ 0924 修正（实测反馈："白边框在浅色背景上几乎看不见，要用和计划卡相同的边框"）
   → 基础边框回到计划卡同款亮色浅灰（完成态另有绿色边框，见下） */
.bgt-pill { border-color: rgba(229, 231, 235, 0.9); }
html.dark .bgt-pill { border-color: rgba(255, 255, 255, 0.16); }
/* ★ 0924（用户定案）：完成态用**紫色**（后台任务的品类色 = 靛蓝系），
   不要计划卡的绿 —— 两个胶囊一眼就能分辨谁是谁 */
.bgt-pill.is-done { border-color: rgba(99, 102, 241, 0.5); }
html.dark .bgt-pill.is-done { border-color: rgba(129, 140, 248, 0.5); }

/* 无障碍：尊重系统"减少动态效果" */
@media (prefers-reduced-motion: reduce) {
  .bgt-pill, .bgt-item, .bgt-icobtn, .bgt-caret, .bgt-count, .bgt-steps i.now { transition: none !important; animation: none !important; }
  .bgtrow-enter-active, .bgtrow-leave-active, .bgtrow-move { transition: none !important; }
}
/* ═══════════ ★ 0924（需求）：读条按**任务类型**上色 + 完成回弹（对齐计划卡 .bar-done） ═══════════
   规则：类型色只在「进行中 / 暂停」生效（用 :not 排除终态）—— 终态色（完成=翠绿 / 失败=红 /
   取消=灰）定义在上文，优先级最高，不被类型色覆盖。 */
.bgt-bar i.bgt-bar-dl:not(.bgt-bar-done):not(.bgt-bar-err):not(.bgt-bar-off) { background: #6366f1; }
html.dark .bgt-bar i.bgt-bar-dl:not(.bgt-bar-done):not(.bgt-bar-err):not(.bgt-bar-off) { background: #818cf8; }
/* 完成收尾：回弹 + 一圈翠绿辉光（与计划卡 barDone 同款手感） */
.bgt-bar i.bgt-bar-done { animation: bgtBarDone 0.55s cubic-bezier(0.34, 1.56, 0.64, 1) both; }
@keyframes bgtBarDone {
  0% { transform: scaleY(1); box-shadow: none; }
  55% { transform: scaleY(1.5); box-shadow: 0 0 0 3px rgba(16, 185, 129, 0.22); }
  100% { transform: scaleY(1); box-shadow: 0 0 0 0 rgba(16, 185, 129, 0); }
}
@media (prefers-reduced-motion: reduce) {
  .bgt-bar i.bgt-bar-done { animation: none !important; }
}
</style>
