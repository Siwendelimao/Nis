<script setup lang="ts">
/**
 * 进程监控弹窗（0922e）
 *
 * 设计口径：铃铛**左侧**的按钮点开它；**只显示正在运行的**进程（哪怕只活 1 秒也显示）、
 *   **结束就消失**；每行要有时长 + 来源（项目 → 会话）；悬停出「停止」。
 * 范围（P0）：由 NIS 拉起的进程 —— `run_command` / `project_run_command` / `bg_start`。
 *
 * 数据：stores/procs.ts（拉 `proc.list` + 推 `proc/updated` / `proc/removed`）
 * 为什么不做"结束历史"：设计口径就是"结束就消失"，列表只回答"此刻还有谁在跑"。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useProcsStore, type TrackedProc } from '@/stores/procs'
import { useConversationsStore } from '@/stores/conversations'
import { useProjectsStore } from '@/stores/projects'
import { t } from '@/utils/i18n'

const emit = defineEmits<{ (e: 'close'): void }>()

const procsStore = useProcsStore()
const convStore = useConversationsStore()
const projStore = useProjectsStore()

/* 秒级滴答：时长实时走 */
const now = ref(Date.now())
let tick: any = null
onMounted(() => {
  tick = setInterval(() => { now.value = Date.now() }, 1000)
  void procsStore.sync()
  document.addEventListener('keydown', onEsc)   // ★ 0924：补 ESC 关闭（之前只有任务详情弹窗有）
})
onUnmounted(() => {
  if (tick) clearInterval(tick)
  document.removeEventListener('keydown', onEsc)
})
/** ★ 0924：ESC 关闭（走 requestClose 保留出场动画） */
function onEsc(e: KeyboardEvent): void {
  if (e.key === 'Escape') requestClose()
}

const err = ref('')
const stoppingId = ref('')

/** ★ 0924（用户：关闭要有动画）：先播 180ms 出场动画，再真正卸载 —— 原来点关闭是"啪"一下就没了 */
const closing = ref(false)
function requestClose(): void {
  if (closing.value) return
  closing.value = true
  window.setTimeout(() => emit('close'), 180)
}

function fmtDur(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000))
  const m = Math.floor(sec / 60)
  const s = sec % 60
  if (m >= 60) {
    const h = Math.floor(m / 60)
    return `${h}:${String(m % 60).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  }
  return m > 0 ? `${m}:${String(s).padStart(2, '0')}` : `${s}s`
}

/** 来源：项目 → 会话（尽量给全；查不到就退化成会话 id 或"未标注"） */
function whereOf(p: TrackedProc): string {
  const conv: any = (convStore.conversations as any[]).find((c) => String(c?.id) === String(p.origin.conversationId || ''))
  const projId = conv?.projectId ?? conv?.project_id ?? p.origin.projectId
  const proj: any = projId != null ? (projStore.projects as any[]).find((x) => String(x?.id) === String(projId)) : null
  const convTitle = conv?.title ? String(conv.title) : ''
  if (proj?.name && convTitle) return `${proj.name} → ${convTitle}`
  if (convTitle) return convTitle
  if (p.origin.conversationId) return String(p.origin.conversationId).slice(0, 8)
  return t('proc.noSource')
}

function toolLabel(tool: string): string {
  if (tool === 'bg_start') return t('proc.toolBg')
  if (tool === 'run_command' || tool === 'project_run_command') return t('proc.toolCmd')
  return tool || t('proc.toolOther')
}

const rows = computed(() =>
  procsStore.procs.map((p) => ({ ...p, elapsed: fmtDur(now.value - p.startedAt), where: whereOf(p) })),
)

async function stop(p: TrackedProc): Promise<void> {
  err.value = ''
  stoppingId.value = p.id
  const r = await procsStore.kill(p.id)
  stoppingId.value = ''
  if (!r.ok) err.value = t('proc.stopErr') + (r.error || '')
}
</script>

<template>
  <div class="prm-mask" :class="{ 'is-closing': closing }" @click.self="requestClose">
    <div class="prm-card">
      <div class="prm-head">
        <span class="prm-title">{{ t('proc.title') }}</span>
        <span class="prm-count" :key="rows.length">{{ rows.length }}</span>
        <span class="prm-spacer"></span>
        <button class="prm-x" :title="t('proc.close')" @click="requestClose"><i class="fas fa-xmark"></i></button>
      </div>

      <div class="prm-body">
        <div v-if="!rows.length" class="prm-empty">
          <i class="fas fa-microchip"></i>
          <p>{{ t('proc.empty') }}</p>
        </div>
        <TransitionGroup name="prmrow" tag="div" class="prm-rows">
          <div v-for="p in rows" :key="p.id" class="prm-row">
            <span class="prm-dot"></span>
            <div class="prm-main">
              <div class="prm-line1">
                <span class="prm-name">{{ p.name }}</span>
                <span class="prm-tag" :class="p.origin.tool === 'bg_start' ? 'bg' : 'cmd'">{{ toolLabel(String(p.origin.tool || '')) }}</span>
                <span class="prm-pid">#{{ p.pid }}</span>
                <span class="prm-time">{{ p.elapsed }}</span>
              </div>
              <div class="prm-cmd" :title="p.cmdline">{{ p.cmdline || '—' }}</div>
              <div class="prm-where" :title="p.where"><i class="fas fa-diagram-project"></i><span class="truncate">{{ p.where }}</span></div>
            </div>
            <button
              class="prm-stop"
              :disabled="stoppingId === p.id"
              :title="t('proc.stop')"
              @click="stop(p)"
            ><i class="fas" :class="stoppingId === p.id ? 'fa-spinner fa-spin' : 'fa-stop'"></i></button>
          </div>
        </TransitionGroup>
      </div>

      <div v-if="err" class="prm-err"><i class="fas fa-triangle-exclamation"></i>{{ err }}</div>

      <div class="prm-foot">
        <span class="prm-hint">{{ t('proc.hint') }}</span>
        <span class="prm-spacer"></span>
        <button class="prm-btn plain" @click="requestClose">{{ t('proc.close') }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 遮罩与白卡：与「后台任务详情弹窗」同族（实色白卡 + 轻黑遮罩） */
.prm-mask {
  position: fixed;
  inset: 0;
  z-index: 200;
  background: rgba(15, 23, 42, 0.28);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}
.prm-card {
  width: min(580px, 100%);
  max-height: min(72vh, 660px);
  background: #fff;
  border: 1px solid rgba(0, 0, 0, 0.04);
  border-radius: 18px;
  box-shadow: 0 18px 50px rgba(15, 23, 42, 0.18);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* 头部（固定） */
.prm-head {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 14px 16px 10px;
}
/* ★ 0924：原 .prm-headicon 样式已随"去掉头部图标"移除（此处原来的 font-size/color 定义一并清掉） */
.prm-title { font-size: 13.5px; font-weight: 600; color: #18181b; }
.prm-count {
  font-size: 10px;
  font-weight: 600;
  color: #3f3f46;
  background: rgba(0, 0, 0, 0.05);
  border-radius: 6px;
  padding: 1px 6px;
  font-variant-numeric: tabular-nums;
}
.prm-spacer { flex: 1 1 auto; }
/* ★ 0924（用户：关闭按钮要和左侧栏弹窗统一）→ 对齐项目主流规格
   （AgentModal / AvatarCardEditor / LinkBlock 的 × 按钮：w-7~w-8 + rounded-lg + gray-400 + hover gray-100/gray-600） */
.prm-x {
  width: 28px;
  height: 28px;
  border-radius: 8px;
  color: #9ca3af;
  font-size: 13px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: background 0.15s ease, color 0.15s ease, transform 0.16s cubic-bezier(0.22, 1, 0.36, 1);
}
.prm-x:hover { background: #f3f4f6; color: #4b5563; }

/* 列表（唯一滚动区） */
.prm-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; overflow-x: hidden; padding: 2px 8px 8px; }
.prm-empty { padding: 42px 16px; text-align: center; color: #a1a1aa; }
.prm-empty i { font-size: 22px; color: #e4e4e7; }
.prm-empty p { margin-top: 8px; font-size: 12px; }

.prm-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 9px 8px;
  border-radius: 12px;
  transition: background 0.15s;
}
.prm-row:hover { background: rgba(0, 0, 0, 0.03); }
.prm-dot {
  flex: 0 0 6px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #6366f1;
  margin-top: 6px;
}
.prm-main { flex: 1 1 auto; min-width: 0; }
.prm-line1 { display: flex; align-items: center; gap: 6px; min-width: 0; }
.prm-name { font-size: 12.5px; color: #18181b; font-weight: 500; white-space: nowrap; }
.prm-tag {
  flex: 0 0 auto;
  font-size: 8px;
  padding: 1px 4px;
  border-radius: 4px;
  font-weight: 500;
}
.prm-tag.cmd { background: rgba(0, 0, 0, 0.05); color: #71717a; }
.prm-tag.bg { background: rgba(99, 102, 241, 0.12); color: #4338ca; }
.prm-pid { font-size: 10px; color: #a1a1aa; font-variant-numeric: tabular-nums; }
.prm-time {
  margin-left: auto;
  flex: 0 0 auto;
  font-size: 10.5px;
  color: #71717a;
  font-variant-numeric: tabular-nums;
}
.prm-cmd {
  margin-top: 2px;
  font-size: 10.5px;
  color: #52525b;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.prm-where {
  margin-top: 3px;
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 10px;
  color: #a1a1aa;
  min-width: 0;
}
.prm-where .truncate { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.prm-stop {
  flex: 0 0 auto;
  width: 26px;
  height: 26px;
  border-radius: 8px;
  color: #a1a1aa;
  opacity: 0;
  transition: opacity 0.15s, background 0.15s, color 0.15s;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.prm-row:hover .prm-stop { opacity: 1; }
.prm-stop:hover { background: rgba(239, 68, 68, 0.1); color: #ef4444; }
.prm-stop:disabled { opacity: 1; color: #a1a1aa; }

.prm-err {
  flex: 0 0 auto;
  margin: 0 16px 6px;
  padding: 6px 8px;
  border-radius: 8px;
  background: rgba(239, 68, 68, 0.08);
  color: #b91c1c;
  font-size: 11px;
  display: flex;
  align-items: center;
  gap: 6px;
}

/* 底部（固定） */
.prm-foot {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 16px 13px;
}
.prm-hint { font-size: 10px; color: #a1a1aa; }
.prm-btn {
  font-size: 12px;
  padding: 5px 12px;
  border-radius: 10px;
  transition: background 0.15s, color 0.15s;
}
.prm-btn.plain { color: #52525b; }
.prm-btn.plain:hover { background: rgba(0, 0, 0, 0.05); color: #18181b; }

/* 深色 */
html.dark .prm-card { background: #1c1c1f; border-color: rgba(255, 255, 255, 0.08); }
html.dark .prm-title { color: #e4e4e7; }
html.dark .prm-count { background: rgba(255, 255, 255, 0.08); color: #d4d4d8; }
html.dark .prm-row:hover { background: rgba(255, 255, 255, 0.05); }
html.dark .prm-name { color: #e4e4e7; }
html.dark .prm-tag.cmd { background: rgba(255, 255, 255, 0.08); color: #a1a1aa; }
html.dark .prm-tag.bg { background: rgba(129, 140, 248, 0.18); color: #c7d2fe; }
html.dark .prm-cmd { color: #a1a1aa; }
html.dark .prm-empty i { color: #3f3f46; }
html.dark .prm-x:hover, html.dark .prm-btn.plain:hover { background: rgba(255, 255, 255, 0.08); color: #e4e4e7; }
html.dark .prm-err { background: rgba(239, 68, 68, 0.16); color: #fca5a5; }

/* ═══════════ ★ 0924 视觉升级：去"塑料白卡"→ 同族「伪磨砂」质感（冷调白渐变 + 内高光 + 多层阴影；
   不依赖 backdrop-filter —— 本环境采样不可用）+ 全套动效 ═══════════ */

/* 遮罩：加深一档让面板"浮"得更明显
   ★ 不用 backdrop-filter —— 项目铁律：本环境采样不可用 + WebView2 全屏命中测试坑 */
.prm-mask {
  background: rgba(2, 6, 23, 0.38);
  animation: prmMaskIn 0.2s ease-out;
}
@keyframes prmMaskIn { from { opacity: 0 } to { opacity: 1 } }
.prm-mask.is-closing { animation: prmMaskOut 0.18s ease-in forwards; }
@keyframes prmMaskOut { from { opacity: 1 } to { opacity: 0 } }

/* 卡片：纯白（用户 0924 定案"改回白色"）+ 主题规格（与 .bgtm-panel / .plan-shell 同族白卡语言）
   ★ 不用 backdrop-filter —— 本环境采样不可用 */
.prm-card {
  background: #fff;
  border: 1px solid rgba(226, 232, 240, 0.95);
  box-shadow: 0 20px 60px rgba(15, 23, 42, 0.18), 0 4px 12px rgba(15, 23, 42, 0.06);
  animation: prmCardIn 0.22s cubic-bezier(0.22, 1, 0.36, 1);
}
@keyframes prmCardIn { from { opacity: 0; transform: translateY(10px) scale(0.97) } to { opacity: 1; transform: none } }
.prm-mask.is-closing .prm-card { animation: prmCardOut 0.18s ease-in forwards; }
@keyframes prmCardOut { from { opacity: 1; transform: none } to { opacity: 0; transform: translateY(6px) scale(0.98) } }

/* ★ 0924（用户：左上角的 icon 去掉）—— 元素已删，原 .prm-headicon 胶状底样式一并清理（避免死 CSS） */
.prm-x { transition: background 0.16s ease, color 0.16s ease, transform 0.16s cubic-bezier(0.22, 1, 0.36, 1); }
.prm-x:hover { transform: scale(1.06); }
.prm-x:active { transform: scale(0.92); }

/* 计数徽章：数字一变就弹一下（:key 变化 → 重新挂载 → 播动画） */
.prm-count { animation: prmCountPop 0.32s cubic-bezier(0.34, 1.56, 0.64, 1); }
@keyframes prmCountPop { 0% { transform: scale(0.72); opacity: 0.4 } 60% { transform: scale(1.1) } 100% { transform: scale(1); opacity: 1 } }

/* 运行中的状态点：呼吸 + 扩散光晕（原来是个死死钉着的紫点） */
.prm-dot { animation: prmBreathe 1.9s ease-in-out infinite; }
@keyframes prmBreathe {
  0%, 100% { opacity: 1; transform: scale(1); box-shadow: 0 0 0 0 rgba(99, 102, 241, 0.45); }
  50% { opacity: 0.62; transform: scale(0.94); box-shadow: 0 0 0 5px rgba(99, 102, 241, 0); }
}

/* 列表行：hover 微位移 + 浮起阴影；增删走 TransitionGroup */
.prm-rows { position: relative; display: flex; flex-direction: column; }
.prm-row { transition: background 0.18s ease, transform 0.18s cubic-bezier(0.22, 1, 0.36, 1), box-shadow 0.18s ease; }
.prm-row:hover { transform: translateX(2px); box-shadow: 0 2px 10px rgba(2, 6, 23, 0.06); }
.prmrow-enter-active, .prmrow-leave-active { transition: all 0.26s cubic-bezier(0.22, 1, 0.36, 1); }
.prmrow-enter-from { opacity: 0; transform: translateY(-6px) scale(0.98); }
.prmrow-leave-to { opacity: 0; transform: translateX(12px) scale(0.97); }
.prmrow-leave-active { position: absolute; left: 0; right: 0; }
.prmrow-move { transition: transform 0.28s cubic-bezier(0.22, 1, 0.36, 1); }

/* 停止按钮：hover 放大 / 按下回弹（"清除关闭"类操作的触感） */
.prm-stop { transition: opacity 0.18s ease, background 0.16s ease, color 0.16s ease, transform 0.16s cubic-bezier(0.22, 1, 0.36, 1); }
.prm-stop:hover:not(:disabled) { transform: scale(1.12); }
.prm-stop:active:not(:disabled) { transform: scale(0.92); }

/* 底部按钮：按下去有回弹 */
.prm-btn { transition: background 0.16s ease, color 0.16s ease, transform 0.14s ease; }
.prm-btn:active { transform: scale(0.96); }

/* 空态：图标轻轻浮动（"活的"，不是死图标） */
.prm-empty i { animation: prmFloat 3.2s ease-in-out infinite; }
@keyframes prmFloat { 0%, 100% { transform: translateY(0); opacity: 0.9 } 50% { transform: translateY(-4px); opacity: 1 } }

/* 深色模式：同样磨砂（原来实色 #1c1c1f，跟全家材质不搭） */
html.dark .prm-card {
  background: #1c1c1f;
  border-color: rgba(255, 255, 255, 0.1);
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.55), 0 4px 12px rgba(0, 0, 0, 0.35);
}
/* ★ 0924：原 html.dark .prm-headicon 深色样式已随"去掉头部图标"一并移除 */
html.dark .prm-row:hover { box-shadow: 0 2px 10px rgba(0, 0, 0, 0.3); }

/* 无障碍：尊重系统"减少动态效果" */
@media (prefers-reduced-motion: reduce) {
  .prm-mask, .prm-card, .prm-count, .prm-dot, .prm-empty i { animation: none !important; }
  .prmrow-enter-active, .prmrow-leave-active, .prmrow-move, .prm-row, .prm-stop, .prm-btn, .prm-x { transition: none !important; }
}
/* ═══════════ ★ 0924：布局按项目主题重排（规格对齐 .bgtm-head / .bgtm-foot / 计划卡条目） ═══════════ */
.prm-head { padding: 12px 16px 8px; gap: 8px; }
.prm-title { font-size: 13px; font-weight: 600; }
.prm-count { font-size: 10px; padding: 1px 6px; }
.prm-body { padding: 2px 10px 10px; }
.prm-row { padding: 8px 10px; border-radius: 10px; gap: 8px; }
.prm-row:hover { background: rgba(244, 244, 245, 0.9); box-shadow: none; }
.prm-name { font-size: 12px; font-weight: 500; }
.prm-line1 { gap: 6px; }
.prm-time { margin-left: auto; }          /* 时长右对齐 → 整列表更整齐 */
.prm-tag { font-size: 9px; padding: 1px 5px; border-radius: 4px; }
.prm-pid { font-size: 9px; }
.prm-cmd { font-size: 11px; margin-top: 2px; }
.prm-where { font-size: 10px; margin-top: 2px; }
.prm-foot { padding: 10px 16px 12px; }
.prm-hint { font-size: 10px; }
.prm-btn { font-size: 12px; padding: 6px 12px; border-radius: 8px; }
.prm-empty { padding: 36px 16px; }
html.dark .prm-row:hover { background: rgba(255, 255, 255, 0.06); box-shadow: none; }
</style>
