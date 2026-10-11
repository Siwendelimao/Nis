<script setup lang="ts">
import { ref, computed, watch, onUnmounted, getCurrentInstance } from 'vue'
import { Circle } from 'lucide-vue-next'
import { classifyTool, toolTitle, derivePersona, derivePersonaStatus, formatInputBody, formatOutput, mcpFriendlyInput, stripMechanism } from '@/utils/toolClassifier'
import { toolIconComponent as iconFor, toolRunningLoader, isInstantTool as isInstantFn } from '@/utils/toolIcons'
import { basename, isFileLike, metaOf } from '@/utils/fileMeta'
import { useConversationsStore } from '@/stores/conversations'
import DisclosureRow from './DisclosureRow.vue'

import { t } from '@/utils/i18n'
import ToolFilePopup from './ToolFilePopup.vue'

const props = defineProps<{
  part: Record<string, any>
  desc: string
  kind?: 'tool' | 'plugin' | 'skill'
  /** 0906 五批：参数流式到过的字符数（fs_write 诚实等待行显示"已生成"进度） */
  streamChars?: number
}>()

const expanded = ref(false)

const toolName = computed(() => String(props.part.tool || ''))
const variant = computed(() => classifyTool(toolName.value, input.value))
// 0908 收尾：错误详情同样剥机制指令段（errorText 常=完整 toolResult，含【循环防护】追加段）
const errorText = computed(() => stripMechanism(String(props.part.error || '')))
/** 状态（前置定义：summary/personaStatus/计时器依赖它） */
const state = computed<'ok' | 'running' | 'error' | 'pending'>(() => {
  if (props.part.stopped) return 'error'
  if (props.part.status === 'error' || errorText.value) return 'error'
  if (props.part.status === 'pending') return 'pending'
  if (props.part.status === 'running') return 'running'
  return 'ok'
})
let _runSince = 0
watch(state, (now, prev) => {
  if (now === 'running' && prev !== 'running') _runSince = Date.now()
})
const title = computed(() => {
  if (props.part.status === 'pending') return '等待审批'
  return toolTitle(toolName.value, input.value) || '正在调用工具…'
})
const input = computed(() => (props.part.input || {}) as Record<string, any>)
/**
 * 拟人化摘要：按工具调用 id 全局缓存，随机一次后永不再变。
 * 缓存键用 call_id（后端 UUID）；组件销毁重建/参数流式生成/思考重渲染都不会改变文案。
 */
const PERSONA_CACHE: Map<string, string> = ((globalThis as any).__nisPersonaCache__ ??= new Map())
/* [T6 persona] weak entries = persona derived WITHOUT input (placeholder copy); upgraded once when args arrive */
const PERSONA_WEAK: Set<string> = ((globalThis as any).__nisPersonaWeak__ ??= new Set())
/* ★ 0928 修「思考时拟人文案一直在跳」（实测）：
   根因 = 主对话流给 ToolPartBlock 的行**可能还没有 call_id**（piChat 流式早期建占位节点时
   `callId: block?.id || ''`，args 也还没到），而旧代码在"无 call_id + 无 args"时**故意不缓存**
   （`if (!v && !hasInput && !stableKey) return derivePersona(...)`）→ 每个渲染帧都重新 Math.random() 摇一句
   → 屏幕上整片工具行的文案一起跳。
   修法：缓存键在**没有 call_id 时用"本组件实例"兜底**（实例 uid 稳定；v-for 的 key 是节点 key，
   一个实例始终对应同一行）⇒ 无 call_id 也能"抽一次定终身"，同时保留"args 到了升级一次"的弱缓存机制。 */
const PERSONA_INST_KEY = `#uid:${getCurrentInstance()?.uid ?? 'na'}`
const personaCacheKey = computed(() => String(props.part.call_id || `${toolName.value}:${props.desc || ''}${PERSONA_INST_KEY}`))
const personaText = computed(() => {
  /* [T6 persona] three-layer stable chain (flicker fix):
     (1) segment-level cache seg.persona (generated once by SubAgentBlock, render only reads it);
     (2) call_id-level cache __nisPersonaCache__; with a STABLE per-call key (call_id present, incl.
         SubAgentBlock synthetic 'subseg:runId:idx') empty-input persona IS cached as WEAK -- the key is
         per-call unique so no same-name pollution (the old guard only applied to shared toolName keys);
     (3) weak entries upgrade once when args arrive, then never change again.
     Old behavior kept only for 'no call_id AND no input' (shared key => never cache). */
  const segPersona = String((props.part as any).persona || '')
  if (segPersona) return segPersona
  const k = personaCacheKey.value
  const hasInput = input.value && Object.keys(input.value).length > 0
  const v = PERSONA_CACHE.get(k)
  const weak = PERSONA_WEAK.has(k)
  if (v && !(weak && hasInput)) return v
  /* ★ 0928：这里原来是「无 call_id + 无 args → 直接 return（不缓存）」—— 就是"文案每帧跳"的元凶。
     现在缓存键已带实例兜底（见 personaCacheKey），任何情况都能缓存 ⇒ 照常走下面"生成 + 入缓存"。 */
  const nv = derivePersona(toolName.value, input.value)
  /* ★ 0928：上限 300 对超长会话（几千个工具行）不够 —— 被淘汰的行下一帧会重新摇一次文案
     （偶发"跳"的残余来源）。提到 4000：每条约几十字节，内存代价可忽略。 */
  if (PERSONA_CACHE.size > 4000) {
    const first = PERSONA_CACHE.keys().next().value
    if (first !== undefined) { PERSONA_CACHE.delete(first); PERSONA_WEAK.delete(first) }
  }
  PERSONA_CACHE.set(k, nv)
  if (hasInput) PERSONA_WEAK.delete(k); else PERSONA_WEAK.add(k)
  return nv
})
const summary = computed(() => {
  if (props.part.status === 'pending') {
    // 0906 五批：审批行同样露出文件（chip 渲染依赖文本含完整 pathText）
    const pp = String(input.value?.path || input.value?.file_path || '')
    if (pp && isFileLike(pp)) return `等你批准写入 ${pp}`
    return '等你批准，我就开始～'
  }
  // 0906 五批 fs_write 诚实等待行；0908 修：网关缓冲态 sc 常停在个位数（只收到 keepalive delta），
  // 旧逻辑 sc>0 就报"已生成 1 字符"→"1 字符 29 秒"误导。改为：累积 delta 达阈值(200)才算真实流式进度。
  // 0908 收尾（用户反馈 8）：sc 落在 1..199 时旧逻辑"既不显已生成、又不显估算"=两头空的死区
  // （观感=字符计数随机消失）。现规则：sc>=200 显"已生成"；否则一律显估算 ~N（参数已到齐时
  // content 长度=真实待写量；未到达 est=0 自然只剩"正在写入 xxx"，无假数字）。
  if (toolName.value === 'fs_write' && state.value === 'running') {
    const p = String(input.value?.path || input.value?.file_path || '')
    const sc = props.streamChars || 0
    const streamed = sc >= 200 ? `（已生成 ${sc.toLocaleString()} 字符）` : ''
    const est = !streamed ? Math.max(String(input.value?.content || '').length, 0) : 0
    const prog = streamed || (est > 0 ? `（~${est.toLocaleString()} 字符）` : '')
    if (p) return `正在写入 ${p}${prog}`
    return prog ? `正在准备写入文件${prog}` : '正在准备写入文件'
  }
  return personaText.value || props.desc || toolName.value
})
/** 拟人化状态文案：随 state 变化更新（运行/错误/停止各自文案；失败不再残留红色"正在搞"） */
const personaStateText = ref('')
watch(() => state.value, (s) => {
  if (s === 'running') personaStateText.value = toolName.value === 'fs_write' ? '' : '正在搞…'
  else if (s === 'error' || s === 'stopped') personaStateText.value = derivePersonaStatus(s)
}, { immediate: true })
/* 1010-①（反馈：精确替换运行中不显示文件名）：
   running 时折叠态渲染 personaStatus（"嗯我在处理了…"），不含路径 ⇒ 无文件 chip；
   completed 才走 personaSegments ⇒ 同一行前后文件名忽隐忽现。
   这里直接从 input.path 取（不依赖 persona 文案与其缓存），供 running 态单独渲染 chip。 */
const runningFilePath = computed(() => {
  // ★ 只在运行态用：完成后 personaSegments 自带 chip，再渲染会重复（反馈「后缀又出现文件名」）
  if (state.value !== 'running') return ''
  const p = String(props.part.input?.path || props.part.input?.file_path || '').trim()
  return isFileLike(p) ? p : ''
})
const personaStatus = computed(() => {
  if (state.value === 'ok') return ''
  if (state.value === 'pending') return '等你说"好"就开始～'
  return personaStateText.value
})

/* ── 运行计时器（过程态显示已用时长） ── */
const elapsedSec = ref(0)
let timer: ReturnType<typeof setInterval> | null = null
function startTimer() {
  stopTimer()
  elapsedSec.value = 0
  timer = setInterval(() => { elapsedSec.value += 1 }, 1000)
}
function stopTimer() {
  if (timer) { clearInterval(timer); timer = null }
}
watch(() => state.value, (s) => {
  if (s === 'running') startTimer()
  else stopTimer()
}, { immediate: true })
onUnmounted(stopTimer)
const runningDuration = computed(() => {
  if (state.value !== 'running') return ''
  const s = elapsedSec.value
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m${s % 60}s`
})
const body = computed(() => {
  const i = input.value
  if (Object.keys(i).length === 0) return null
  // 0908 三批：内置浏览器（mcp__nis-browser__*）不露原始 JSON 入参（{"raw":"{}"} 之类源码味），
  // 换成一行中文人话；无可展示参数则整个 IN 区不显示（expandable 已按 body!==null 联动）
  if (toolName.value.startsWith('mcp__nis-browser__')) {
    const friendly = mcpFriendlyInput(toolName.value, i)
    return friendly || null
  }
  if (variant.value === 'code' && i.code) return String(i.code)
  return formatInputBody(i)
})
const output = computed(() => {
  const o = props.part.output
  // 0908 收尾（用户反馈"给我们的机制盖住"）：剥除结果里追加的【循环防护】/【不要重试】/【行为指令】
  // 模型侧策略指令段——那是写给 AI 的行为约束，不该出现在用户界面。模型收到的原文不变，仅展示层过滤。
  return o ? formatOutput(stripMechanism(String(o))) : null
})

/** 按工具功能映射线性图标 + 过程态动画（单一出处 @/utils/toolIcons，与「工具」页仓库卡片同源） */
/** 过程态动画：shell 类用加载环、web 类用旋转地球（与思考飘带区分），其余保留飘带（判定与「工具」页同源） */
/** 0906 五批：fs_write 运行态=诚实等待（静止笔图标 + 计时 + 落盘目标文案，无假想动动画） */
const isWriteWait = computed(() => toolName.value === 'fs_write' && state.value === 'running')
/** ★ 0929：改动量 +N/-M（写类工具行徽章；后端 details.added/removed，老历史没有就不显示） */
const diffStat = computed(() => {
  const d = (props.part as any).diffStat as { added?: number; removed?: number } | undefined
  if (!d) return null
  const a = typeof d.added === 'number' ? d.added : 0
  const r = typeof d.removed === 'number' ? d.removed : 0
  return a || r ? { added: a, removed: r } : null
})
/* 1010-②：+n 绿 / -n 红（拆两段分别上色；无变化则不渲染） */
const hasDiffStat = computed(() => diffStat.value !== null)
const isInstantTool = computed(() => isInstantFn(toolName.value, input.value))
/** skill 工具：完成态用绿色魔法棒高亮 */
const isSkillTool = computed(() => toolName.value === 'use_skill')
/** 团队派发（P2）：子 agent 用 SubAgentBlock 独立分组渲染；展开体用任务单卡片（不露 JSON） */
const isTeamDispatch = computed(() => toolName.value === 'team_dispatch')
const dispatchTasks = computed<any[]>(() => (isTeamDispatch.value && Array.isArray(input.value?.tasks) ? input.value.tasks : []))
/** 成员名映射（PiChatView 传入）：memberId → 成员名 */
const memberNames = computed<Record<string, string>>(() => (props.part.memberNames || {}) as Record<string, string>)
/** 有过程动画的工具（非瞬时）：运行时显示状态文案 + 计时 */
const showRunningMeta = computed(() => !isInstantTool.value)
const toolIconComponent = computed(() => iconFor(toolName.value, input.value))
/** 过程态动画（与「工具」页仓库卡片同源）：shell→终端打字 / web→四色条纹；null=线性图标脉冲；fs_write=诚实等待不给动画 */
const runningLoader = computed(() => state.value === 'running' && !isInstantTool.value && !isWriteWait.value ? toolRunningLoader(toolName.value, variant.value, input.value) : null)
const isError = computed(() => state.value === 'error')
const expandable = computed(() => body.value !== null || output.value !== null)
const errorSummary = computed(() => isError.value && output.value ? output.value.split('\n')[0] : null)

/** bash 变体：解析 "stdout:\n...\nstderr:\n..." 分段 */
const cmdOutput = computed(() => {
  const out = output.value || ''
  const m = /^stdout:\n([\s\S]*?)(?:\nstderr:\n([\s\S]*))?$/.exec(out)
  if (m) return { stdout: m[1] || '', stderr: m[2] || '' }
  return { stdout: out, stderr: '' }
})
/** read/write 变体：路径摘要 */
const pathText = computed(() => String(props.part.input?.path || props.part.input?.file_path || props.part.input?.url || ''))

/* ── 0920 反馈①：命令过程行显示"本次实际用的终端" ──
   后端 run_command 把 resolveShellForCommand() 的结果塞进 details.shell（自动选择模式下
   同一条命令可能走 cmd，另一条走 PowerShell，用户想看得见）。存量历史消息没有该字段 → 不渲染。 */
const SHELL_LABELS: Record<string, string> = { cmd: 'cmd', powershell: 'PowerShell', pwsh: 'PowerShell 7', sh: 'sh', bash: 'bash' }   // ★1010x：补 bash —— 1010 加 Git Bash 时漏了这格，走 bash 的调用标签一片空白（截图）
const shellChip = computed(() => {
  if (toolName.value !== 'run_command') return ''
  const s = String((props.part as any).shell || '')
  return SHELL_LABELS[s] || ''
})

/* ── 拟人化文案里的文件 chip（0903 反馈 #2）：
   「xxx」片段 / fs 类工具主参数若是文件路径 → 渲染 icon+文件名，点击弹"打开方式"小弹窗（同产出物）。
   非文件（普通查询词、URL）保持纯文本。 */
const conversationsStore = useConversationsStore()
const popupConvId = computed(() => String(conversationsStore.activeConversationId ?? ''))
const filePopupRef = ref<InstanceType<typeof ToolFilePopup> | null>(null)
function openFilePopup(p: string) { filePopupRef.value?.open(p) }

interface PersonaSeg { type: 'text' | 'file'; value: string }
/* ★1010-②③（借鉴 zcode ToolSummaryRow / ToolLayout）：
   · ② 折叠与展开共用同一套摘要来源——zcode 的做法是「成对字段、变体可选、缺失自动回退同一个值」
     （`isExpanded && expandedX != null ? expandedX : X`），从机制上消灭「折叠一个样、展开另一个样」。
     这里展开态直接复用 personaSegments（与折叠逐字一致），拿不到才退回纯文本 summary。
   · ③ 摘要为空时整个容器不渲染——空 flex 容器会让 gap 在「类别—空容器—箭头」之间多算一次，
     视觉上撑出一块异常大空白。
   ★ 这两个 computed 必须定义在 personaSegments **之后**：computed 体内的引用只在取值时求值，
   但保持定义顺序与依赖一致可避免 TDZ 隐患（0925 教训：esbuild 会掩盖 TDZ，运行时才炸）。 */
const personaSegments = computed<PersonaSeg[]>(() => {
  const text = summary.value
  const segs: PersonaSeg[] = []
  // fs 类工具主参数（写入/读取/删除的文件路径）在纯文本段中出现 → 也渲染成 chip
  const extra = pathText.value.trim()
  const extraLike = isFileLike(extra) ? extra : ''
  const pushText = (s: string) => {
    if (!s) return
    if (!extraLike) { segs.push({ type: 'text', value: s }); return }
    let rest = s
    while (rest) {
      const idx = rest.indexOf(extraLike)
      if (idx === -1) { segs.push({ type: 'text', value: rest }); break }
      if (idx > 0) segs.push({ type: 'text', value: rest.slice(0, idx) })
      segs.push({ type: 'file', value: extraLike })
      rest = rest.slice(idx + extraLike.length)
    }
  }
  const re = /「([^」]*)」/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    pushText(text.slice(last, m.index))
    if (isFileLike(m[1])) segs.push({ type: 'file', value: m[1] })
    else segs.push({ type: 'text', value: m[0] })
    last = m.index + m[0].length
  }
  pushText(text.slice(last))
  return segs
})

/** ★1010-②：展开体路径显示粒度与折叠态一致——折叠用 basename（chip 只显文件名），
    展开也先显 basename，完整路径放进 title 悬浮提示。原来展开体直接吐 pathText 全路径，
    同一行折叠/展开两种粒度，看着像两个不同的文件。 */
const displayPath = computed(() => {
  const p = pathText.value || (typeof body.value === 'string' ? body.value : '')
  if (!p) return ''
  // 只有确实是路径才截 basename；否则（如 bash 的裸文本）原样显示
  return isFileLike(p) ? basename(p) : p
})
const hasSummaryContent = computed(() => personaSegments.value.some(
  s => s.type === 'file' ? true : String(s.value).trim() !== '',
))
/** 展开态摘要分段：与折叠同源；无可展示内容时返回 null（调用方 v-if 掉，不留空容器） */
const expandedSegments = computed<PersonaSeg[] | null>(() => {
  if (errorSummary.value) return [{ type: 'text', value: errorSummary.value }]
  if (hasSummaryContent.value) return personaSegments.value
  const t = summary.value.trim()
  return t ? [{ type: 'text', value: t }] : null
})
/** ask 变体：回答文本（去掉"用户回答："前缀，气泡即表达语义） */
const askAnswer = computed(() => {
  const o = output.value || ''
  return o.replace(/^用户回答：/, '').trim()
})
</script>

<template>
  <div class="tool-row" :data-variant="variant" :data-state="state" :data-tool-path="isFileLike(pathText) ? pathText : undefined">
    <DisclosureRow
      :title="title"
      :open="expanded"
      :state="state"
      :expandable="expandable"
      :animate="true"
      @toggle="expanded = !expanded"
    >
      <template #icon>
        <!-- pending 琥珀圆点 / running：shell 涟漪·web 球体旋转·写入笔写波浪（瞬时工具直接静态图标）/ 完成态：线性功能图标（与工具面板一致） -->
        <Circle v-if="state === 'pending'" :size="12" stroke-width="2" :style="{ color: 'var(--dsw-alias-state-warn-primary)' }" />
        <component v-else-if="runningLoader" :is="runningLoader.comp" :size="runningLoader.size" />
        <component :is="toolIconComponent" v-else-if="state === 'running' && !isInstantTool && !isWriteWait" :size="12" stroke-width="1.5" class="tool-running-pulse" :style="{ color: 'var(--dsw-alias-label-tertiary)' }" />
        <component :is="toolIconComponent" v-else :size="12" stroke-width="1.5" :style="{ color: isError ? 'var(--dsw-alias-state-error-primary)' : isSkillTool ? 'var(--dsw-static-green-500)' : 'var(--dsw-alias-label-tertiary)' }" />
      </template>
      <template #collapsed>
        <span class="tool-sep" aria-hidden></span>
        <span v-if="errorSummary" class="tool-summary error-summary">{{ errorSummary }}</span>
        <!-- 拟人化文案分段渲染：文件路径段 → icon+文件名 chip，点击弹"打开方式"小弹窗（同产出物） -->
        <!-- ★1010-②③（借鉴 zcode ToolSummaryRow 的 hasSummaryContent）：摘要为空时**整个 span 不渲染**。
             原来这里是无条件渲染 <span class="tool-summary">，personaSegments 为空时会留下一个空 flex 容器，
             gap 在「类别—空容器—箭头」之间多算一次，视觉上撑出一块异常大空白。 -->
        <span v-else-if="hasSummaryContent" class="tool-summary">
          <template v-for="(seg, si) in personaSegments" :key="si">
            <span
              v-if="seg.type === 'file'"
              class="persona-file-chip"
              :title="t('tool.openWith', { name: seg.value })"
              @click.stop="openFilePopup(seg.value)"
            ><i :class="[metaOf(seg.value).icon, metaOf(seg.value).color]"></i><span class="pfc-name">{{ basename(seg.value) }}</span></span>
            <template v-else>{{ seg.value }}</template>
          </template>
        </span>
        <!-- 0920 反馈①：命令过程行末尾的终端标识（cmd / PowerShell / PowerShell 7） -->
        <span
          v-if="shellChip"
          class="tool-shell-chip"
          :title="t('tool.shellUsed', { shell: shellChip })"
        >{{ shellChip }}</span>
        <!-- ★ 0929：改动量 +N/-M（写类工具行；details 通道，老历史没有就不显示） -->
        <span v-if="hasDiffStat" class="tool-diff-chip" title="本次改动行数 +新增/-删除">
          <span class="diff-add">+{{ diffStat!.added }}</span><span class="diff-sep">/</span><span class="diff-del">-{{ diffStat!.removed }}</span>
        </span>
        <!-- fs_write 诚实等待行：无状态文案（personaStatus=''）但计时照走（秒数是"还在干活"的诚实信号） -->
        <span v-if="showRunningMeta && (personaStatus || runningDuration)" class="tool-status-persona" :class="{ 'is-error': isError }">{{ personaStatus }}<template v-if="runningDuration"> {{ runningDuration }}</template></span>
        <!-- 1010-①：running 态补文件名 chip（不依赖 persona 文案，与完成态同源同样式） -->
        <span v-if="runningFilePath" class="persona-file-chip" :title="t('tool.openWith', { name: runningFilePath })" @click.stop="openFilePopup(runningFilePath)"><i :class="[metaOf(runningFilePath).icon, metaOf(runningFilePath).color]"></i><span class="pfc-name">{{ basename(runningFilePath) }}</span></span>
      </template>
      <!-- 展开体（按工具类型差异化，对齐 dsh 各命令专用卡） -->
      <div class="tool-body-wrap">
        <!-- ★1010-②：展开体摘要行。与折叠态同源（expandedSegments）；折叠已有摘要时不重复渲染，
             只在折叠态无内容（personaSegments 为空）时兜底补一行，避免"展开后什么都不多"的空体感。 -->
        <div v-if="expandedSegments && !hasSummaryContent" class="tool-expanded-summary">
          <template v-for="(seg, si) in expandedSegments" :key="'x' + si">
            <span
              v-if="seg.type === 'file'"
              class="persona-file-chip"
              :title="t('tool.openWith', { name: seg.value })"
              @click.stop="openFilePopup(seg.value)"
            ><i :class="[metaOf(seg.value).icon, metaOf(seg.value).color]"></i><span class="pfc-name">{{ basename(seg.value) }}</span></span>
            <template v-else>{{ seg.value }}</template>
          </template>
        </div>
        <!-- 命令变体：命令行 + stdout/stderr 分段 -->
        <div v-if="variant === 'bash' && body" class="bash-card">
          <div class="bash-cmd"><span class="bash-prompt">$</span><span class="bash-text">{{ String(input.command || body) }}</span></div>
          <pre v-if="cmdOutput.stdout" class="bash-out" :class="{ 'is-error': isError }">{{ cmdOutput.stdout }}</pre>
          <pre v-if="cmdOutput.stderr" class="bash-err">{{ cmdOutput.stderr }}</pre>
        </div>
        <!-- 读取变体：路径 + 内容预览 -->
        <div v-else-if="variant === 'read' && body !== null" class="file-card">
          <div class="file-path"><i class="fas fa-file-lines"></i><span class="truncate" :title="pathText || body">{{ displayPath }}</span></div>
          <pre v-if="output" class="file-content" :class="{ 'is-error': isError }">{{ output }}</pre>
        </div>
        <!-- 写入变体：路径 + 写入内容 -->
        <div v-else-if="variant === 'write' && body !== null" class="file-card">
          <div class="file-path"><i class="fas fa-pen"></i><span class="truncate" :title="pathText || body">{{ displayPath }}</span></div>
          <pre class="file-content" :class="{ 'is-error': isError }">{{ output || body }}</pre>
        </div>
        <!-- 精确替换变体（fs_edit，0913）：路径 + 结果（工具返回里已含「已替换 N 处（命中行：x）」与替换后上下文） -->
        <div v-else-if="variant === 'edit' && body !== null" class="file-card">
          <div class="file-path"><i class="fas fa-crosshairs"></i><span class="truncate" :title="pathText || body">{{ displayPath }}</span></div>
          <pre class="file-content" :class="{ 'is-error': isError }">{{ output || body }}</pre>
        </div>
        <!-- 代码变体 -->
        <div v-else-if="variant === 'code' && body" class="body-scroll">
          <pre class="code-body">{{ body }}</pre>
        </div>
        <!-- 提问变体：对话式问答（问题在左，回答在右） -->
        <div v-else-if="variant === 'ask'" class="ask-card">
          <template v-if="input.questions && input.questions.length">
            <div v-for="(q, qi) in input.questions" :key="qi" class="ask-row">
              <span class="ask-q"><i class="fas fa-comments ask-q-icon"></i>{{ q.question }}</span>
              <span v-if="q.options && q.options.length" class="ask-opts">{{ q.options.join(' / ') }}</span>
            </div>
          </template>
          <template v-else>
            <div class="ask-row">
              <span class="ask-q"><i class="fas fa-comments ask-q-icon"></i>{{ input.question }}</span>
              <span v-if="input.options && input.options.length" class="ask-opts">{{ input.options.join(' / ') }}</span>
            </div>
          </template>
          <div v-if="output" class="ask-row">
            <span class="ask-a">{{ askAnswer }}</span>
          </div>
        </div>
        <!-- 团队派发：任务单卡片（成员/步骤/任务/验收标准，不露原始 JSON） -->
        <div v-else-if="isTeamDispatch" class="dispatch-card">
          <div v-for="(dt, ti) in dispatchTasks" :key="ti" class="dispatch-task">
            <div class="dispatch-task-head">
              <span class="dispatch-member">{{ memberNames[dt.memberId] || dt.memberId }}</span>
              <span class="dispatch-step">{{ t('tool.dispatch.step') }} {{ dt.stepId }}</span>
            </div>
            <div class="dispatch-task-text">{{ dt.task }}</div>
            <div v-if="dt.acceptance" class="dispatch-accept"><span class="dispatch-accept-label">{{ t('tool.dispatch.acceptance') }}</span>{{ dt.acceptance }}</div>
          </div>
          <div v-if="dispatchTasks.length === 0" class="dispatch-empty">{{ t('tool.dispatch.parsing') }}</div>
          <div v-if="output" class="dispatch-result" :class="{ 'is-error': isError }">{{ output }}</div>
        </div>
        <!-- 通用 IN/OUT 卡片 -->
        <div v-else-if="body !== null || output !== null" class="io-card">
          <div v-if="body !== null" class="io-section">
            <span class="io-label">IN</span>
            <span class="io-text">{{ body }}</span>
          </div>
          <span v-if="body !== null && output !== null" class="io-divider" aria-hidden></span>
          <div v-if="output !== null" class="io-section">
            <span class="io-label">OUT</span>
            <span class="io-text" :class="{ 'is-error': isError }">{{ output }}</span>
          </div>
        </div>
        <!-- 错误详情 -->
        <div v-if="errorText" class="error-detail">{{ errorText }}</div>
      </div>
    </DisclosureRow>
    <!-- 文件 chip 的"打开方式"小弹窗（与产出物同款：预览/所在目录/浏览器打开） -->
    <ToolFilePopup ref="filePopupRef" :conv-id="popupConvId" />
  </div>
</template>

<style scoped>
.tool-row {
  display: flex;
  flex-direction: column;
  /* 13px/300：过程块家族统一细字重（0903 用户拍板试看，与思考块/标题/状态同步） */
  font-size: 13px;
  font-weight: 300;
  line-height: 22px;
  color: var(--dsw-alias-label-primary);
}
.tool-icon {
  font-size: 13px;
  color: var(--dsw-alias-label-secondary);
}
.tool-sep {
  flex: none;
  width: 2px;
  height: 2px;
  margin: 0 8px;
  border-radius: 1px;
  background: var(--dsw-alias-label-caption);
}
.tool-summary {
  min-width: 0;
  overflow: hidden;
  flex: 1 1 auto;
  color: var(--dsw-alias-label-tertiary);
  font-size: 13px;
  font-weight: 300;
  line-height: 22px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tool-summary.error-summary {
  color: var(--dsw-alias-state-error-primary);
}
/* 拟人化状态文案：与思考/摘要同 13px/300（0903 家族统一），仅靠灰/琥珀/红色区分为状态 */
.tool-status-persona {
  flex: none;
  font-size: 13px;
  font-weight: 300;
  line-height: 22px;
  color: var(--dsw-alias-label-tertiary);
  opacity: 0.9;
  white-space: nowrap;
}
.tool-status-persona.is-error {
  color: var(--dsw-alias-state-error-primary);
}
/* 0920 反馈①：命令过程行末尾的终端标识（小、灰度、不抢拟人化文案）
   ⚠️ --dsw-alias-* 那套变量只在 html.dark 里有定义（light 下取不到）→ 这里浅/深各写一份实数。 */
.tool-shell-chip {
  flex: none;
  margin-left: 6px;
  padding: 0 6px;
  border-radius: 5px;
  background: rgba(0, 0, 0, 0.045);
  border: 1px solid rgba(0, 0, 0, 0.07);
  color: inherit;
  font-size: 11px;
  font-weight: 400;
  line-height: 16px;
  letter-spacing: 0.2px;
  white-space: nowrap;
  opacity: 0.68;
  user-select: none;
}
/* ★ 0929：写类工具行的改动量徽章（+N/-M 行） */
.tool-diff-chip {
     font-size: 10px;
     color: var(--dsw-alias-label-tertiary);
     font-variant-numeric: tabular-nums;
   }
/* 1010-②：+n 绿 / -n 红（改动量语义色，扫一眼知增减）。
   ★ 必须放在 .tool-diff-chip 规则**之外**作为兄弟节点——塞进它的花括号里是非法嵌套，
     整块样式会连同后面的 font-size/color 一起失效（表现为徽章一直是灰的）。 */
.tool-diff-chip .diff-add { color: var(--dsw-static-green-500, #22c55e); }
.tool-diff-chip .diff-sep { opacity: 0.45; margin: 0 1px; }
.tool-diff-chip .diff-del { color: var(--dsw-alias-state-error-primary, #ef4444); }
html.dark .tool-shell-chip {
  background: rgba(255, 255, 255, 0.07);
  border-color: rgba(255, 255, 255, 0.1);
}
/* 默认工具运行态：静态图标轻微呼吸（思考飘带为思考块专属，工具块不复用） */
.tool-running-pulse {
  animation: toolPulse 1.4s ease-in-out infinite;
}
@keyframes toolPulse {
  0%, 100% { opacity: 0.45; }
  50% { opacity: 1; }
}
/* ── 团队派发：任务单卡片 ── */
.dispatch-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.dispatch-task {
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 10px;
  overflow: hidden;
}
.dispatch-task-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  background: var(--dsw-alias-interactive-bg-hover-solid);
}
.dispatch-member {
  flex: none;
  font-size: 12px;
  font-weight: 530;
  color: var(--dsw-alias-label-primary);
}
.dispatch-step {
  flex: none;
  font-size: 10px;
  padding: 1px 7px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--dsw-static-deepseek-500, #4f6ef7) 10%, transparent);
  color: var(--dsw-static-deepseek-500, #4f6ef7);
}
.dispatch-task-text {
  padding: 8px 10px;
  font-size: 12px;
  line-height: 19px;
  color: var(--dsw-alias-label-primary);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 150px;
  overflow-y: auto;
}
.dispatch-accept {
  display: flex;
  gap: 8px;
  align-items: baseline;
  padding: 6px 10px;
  border-top: 1px dashed var(--dsw-alias-border-l1);
  font-size: 11px;
  line-height: 17px;
  color: var(--dsw-alias-label-tertiary);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 90px;
  overflow-y: auto;
}
.dispatch-accept-label {
  flex: none;
  padding: 0 6px;
  border-radius: 5px;
  background: color-mix(in srgb, var(--dsw-static-green-500, #10b981) 12%, transparent);
  color: var(--dsw-static-green-500, #10b981);
  font-size: 10px;
}
.dispatch-empty {
  padding: 8px 10px;
  font-size: 11px;
  color: var(--dsw-alias-label-caption);
}
.dispatch-result {
  padding: 8px 10px;
  border-radius: 10px;
  background: var(--dsw-alias-interactive-bg-hover-solid);
  font-size: 11px;
  line-height: 17px;
  color: var(--dsw-alias-label-secondary);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 150px;
  overflow-y: auto;
}
.dispatch-result.is-error {
  color: var(--dsw-alias-state-error-primary);
}
/* 展开体 */
.tool-body-wrap {
  margin: 4px 0 4px 22px;
}
.body-scroll {
  max-height: 260px;
  overflow-y: auto;
}
.code-body {
  margin: 0;
  padding: 12px 16px;
  background: var(--dsw-alias-interactive-bg-hover-solid);
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 12px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-primary);
  white-space: pre-wrap;
  word-break: break-word;
}
/* 命令卡片（bash 变体） */
.bash-card {
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 10px;
  overflow: hidden;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  line-height: 18px;
}
.bash-cmd {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 8px 12px;
  background: var(--dsw-static-neutral-bluish-850);
  color: var(--dsw-static-neutral-bluish-100);
  white-space: pre-wrap;
  word-break: break-word;
}
.bash-prompt {
  color: var(--dsw-static-deepseek-200);
  font-weight: 600;
}
.bash-out {
  margin: 0;
  padding: 8px 12px;
  color: var(--dsw-static-green-500);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 220px;
  overflow-y: auto;
}
.bash-out.is-error {
  color: var(--dsw-alias-state-error-primary);
}
.bash-err {
  margin: 0;
  padding: 8px 12px;
  border-top: 1px solid var(--dsw-alias-border-l1);
  color: var(--dsw-alias-state-error-primary);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 160px;
  overflow-y: auto;
}
/* 文件卡片（read/write 变体） */
.file-card {
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 10px;
  overflow: hidden;
}
.file-path {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: var(--dsw-alias-interactive-bg-hover-solid);
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
}
.file-path i {
  color: var(--dsw-static-deepseek-500);
  font-size: 11px;
}
.file-content {
  margin: 0;
  padding: 10px 12px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-primary);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 260px;
  overflow-y: auto;
}
.file-content.is-error {
  color: var(--dsw-alias-state-error-primary);
}
/* IN/OUT 卡片 */
.io-card {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 12px;
  background: var(--dsw-alias-interactive-bg-hover-solid);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  line-height: 18px;
}
.io-section {
  display: grid;
  /* 0907 图一修复：max-content 列被长 JSON/连续中文 OUT 撑出屏幕（1fr 轨道 min:auto 也不收缩），
     改 auto + minmax(0,1fr)——PC 窄窗口同样受益，行为只收窄不放大，零视觉回归 */
  grid-template-columns: auto minmax(0, 1fr);
  column-gap: 14px;
  align-items: baseline;
  padding: 10px 14px;
  max-height: 150px;
  overflow-y: auto;
}
.io-label {
  position: sticky;
  top: 0;
  align-self: start;
  color: var(--dsw-alias-label-caption);
  font-size: 11px;
  font-weight: 530;
  font-family: system-ui, sans-serif;
}
.io-text {
  min-width: 0;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--dsw-alias-label-primary);
}
.io-text.is-error {
  color: var(--dsw-alias-state-error-primary);
}
.io-divider {
  flex: none;
  height: 1px;
  background: var(--dsw-alias-border-l2);
}
.error-detail {
  margin-top: 4px;
  padding: 8px 12px;
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent);
  border: 1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 25%, transparent);
  border-radius: 8px;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-state-error-primary);
  white-space: pre-wrap;
  word-break: break-word;
}
/* 提问卡片（ask 变体）：对话式问答 */
.ask-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 12px;
  background: var(--dsw-alias-interactive-bg-hover-solid);
}
.ask-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.ask-q {
  align-self: flex-start;
  padding: 8px 14px;
  border-radius: 14px 14px 14px 4px;
  background: var(--dsw-specific-bubble);
  color: var(--dsw-alias-label-primary);
  font-size: 12px;
  font-weight: 300;
  line-height: 20px;
  max-width: 85%;
}
.ask-q-icon {
  margin-right: 6px;
  color: var(--dsw-static-deepseek-500);
  font-size: 12px;
}
.ask-opts {
  display: inline-block;
  margin-top: 2px;
  padding: 0 14px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 18px;
}
.ask-a {
  align-self: flex-end;
  padding: 8px 14px;
  border-radius: 14px 14px 4px 14px;
  background: var(--dsw-specific-bubble);
  color: var(--dsw-alias-label-primary);
  font-size: 12px;
  font-weight: 300;
  line-height: 20px;
  max-width: 85%;
  white-space: pre-wrap;
  word-break: break-word;
}
/* 拟人化文案里的文件 chip：icon+文件名，点击弹"打开方式"小弹窗（同产出物）
   0903 反馈：去掉边框背景，只留内容本体，悬停仅文字变色提示可点 */
.persona-file-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 180px;
  margin: 0 2px;
  padding: 0 2px;
  /* 与摘要正文同为 13px（0904 反馈：chip 比正文小一号显突兀） */
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-secondary, #6b7280);
  cursor: pointer;
  vertical-align: middle;
  transition: color 0.15s ease;
}
.persona-file-chip:hover {
  color: var(--dsw-static-deepseek-500, #4f6ef7);
}
.persona-file-chip i {
  font-size: 11px;
  flex-shrink: 0;
}
.pfc-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ★1010-②③：展开体摘要行——与折叠 .tool-summary 同族，间距略大以示层级 */
.tool-expanded-summary { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; font-size: 12px; color: var(--dsw-alias-label-tertiary); padding: 0 0 6px; }
</style>