import { useConversationsStore } from '@/stores/conversations'
import { useSettingsStore } from '@/stores/settings'
import { useProjectsStore } from '@/stores/projects'
import { useNotificationsStore } from '@/stores/notifications'
import { useChatStore } from '@/stores/chat'
import { memoryExtract } from '@/utils/memoryExtract'
import { t } from '@/utils/i18n'
import { localStore } from '@/utils/localStore'

/**
 * 主动记忆执行器（0913 做真，对应设置 → 人格 → 主动记忆开关）。
 *
 * 开启后，两个时机自动把**当前会话的新增内容**提炼进长期记忆（直接落盘，非预览）：
 *   ① 空闲：连续 5 分钟无鼠标/键盘/滚轮活动（每分钟巡检一次）；
 *   ② 页面隐藏（切走 / 关窗）：visibilitychange→hidden 与 pagehide，尽力而为发一次。
 *
 * 防重复：按会话记「已提炼到的文本长度水位」（localStorage 持久化），只提炼水位之后的新增；
 * 新增不足 200 字不触发（省 token）。关闭开关后整个执行器空转（零开销）。
 */

const IDLE_MS = 5 * 60 * 1000
const MIN_CHARS = 200
const BULK_CHARS = 600
const WATERMARK_KEY = 'nis-autoMem-watermarks'
/** 0924 二期批5「有事才抽」：对话里冒出这些词 = 有值得记的事，不等空闲立刻抽（LLM 提炼自会甄别值不值） */
const SIGNAL_WORDS = ['记住', '记下', '记一下', '以后', '别再', '不要', '定死', '规矩', '拍板', '定下来', '喜欢', '不喜欢', '偏好', '习惯', '下次', '教训', '定版', '铁律']

let lastActivity = Date.now()
let running = false

function loadMarks(): Record<string, number> {
  try { return JSON.parse(localStore.getItem(WATERMARK_KEY) || '{}') } catch { return {} }
}
function saveMark(id: string, at: number) {
  try {
    const m = loadMarks()
    m[id] = at
    localStore.setItem(WATERMARK_KEY, JSON.stringify(m))
  } catch { /* ignore */ }
}

/** 会话历史 → 纯文本（与侧栏「提炼窗口记忆」同口径：只取 text 块） */
function transcriptText(msgs: any[]): string {
  const lines: string[] = []
  for (const m of msgs) {
    const c = m?.content
    let text = ''
    if (typeof c === 'string') text = c
    else if (Array.isArray(c)) text = c.filter((b: any) => b?.type === 'text' && b.text).map((b: any) => b.text).join('\n')
    text = String(text || '').trim()
    if (!text) continue
    lines.push(`${m.role === 'user' ? '用户' : '助手'}：${text}`)
  }
  return lines.join('\n\n')
}

async function runOnce(reason: 'idle' | 'hide' | 'signal' | 'bulk', minChars = MIN_CHARS) {
  if (running) return
  const settings = useSettingsStore()
  if (!settings.autoMem) return
  const convs = useConversationsStore()
  const id = String(convs.activeConversationId || '')
  if (!id) return
  const chat = useChatStore()
  if (!chat.wsConnected) return
  running = true
  try {
    const res: any = await chat.bridgeRpc('session.history', { sessionId: id })
    const text = transcriptText(Array.isArray(res?.messages) ? res.messages : [])
    if (!text) return
    const mark = loadMarks()[id] || 0
    if (text.length - mark < minChars) return
    const conv: any = convs.conversations.find((c: any) => c.id === id)
    const proj = conv?.project_id ? useProjectsStore().getProject(conv.project_id) : null
    const root = String(proj?.root_path || conv?.workDir || '')
    const r = await memoryExtract(text, root, { dryRun: false, auto: true })
    if (r?.needModel) return // 未配模型：静默跳过（手动提炼时才有明确引导）
    if (r?.ok) {
      saveMark(id, text.length)
      if (Number(r.saved) > 0) {
        useNotificationsStore().push({ level: 'success', content: t('autoMem.saved', { n: r.saved }) })
        // 0914（设置→提示接线）：自动记忆完成 → 系统通知（窗口可见时只播提示音；受「自动记忆」开关门控）
        void import('@/utils/systemNotify')
          .then((m) =>
            m.notifySystem({
              category: 'memory',
              title: t('sysNotify.memoryTitle'),
              message: t('autoMem.saved', { n: r.saved }),
              // 0914c：点击系统通知 → 直达对应对话窗口
              sessionId: id,
              soundOnly: !document.hidden,
            }),
          )
          .catch(() => { /* ignore */ })
      }
      console.log(`[autoMem] ${reason} 提炼完成 saved=${r.saved}`)
    }
  } catch (e: any) {
    console.warn('[autoMem] 提炼失败:', String(e?.message || e).slice(0, 160))
  } finally {
    running = false
  }
}

/** 挂载执行器（App.vue onMounted 调一次） */
export function setupAutoMemory() {
  const onAct = () => { lastActivity = Date.now() }
  for (const ev of ['mousemove', 'keydown', 'pointerdown', 'wheel']) {
    window.addEventListener(ev, onAct, { passive: true })
  }
  // 巡检（每分钟看一眼；未开启时直接返回，零成本）。
  // 0924 二期批5「有事才抽」三通道（已定案：不做"每轮抽"，token 烧不起）：
  //   ① 信号词：新增里出现「记住/以后/别再…」→ 立刻抽（门槛 20 字）
  //   ② 兜底：新增 ≥600 字不管有没有信号都抽一次（≈每 10 轮对话语义）
  //   ③ 空闲：5 分钟没动静照旧抽（原行为保留）
  window.setInterval(() => {
    if (!useSettingsStore().autoMem) return
    if (running) return
    try {
      const convs = useConversationsStore()
      const id = String(convs.activeConversationId || '')
      if (!id) return
      const chat = useChatStore()
      if (!chat.wsConnected) return
      void chat.bridgeRpc('session.history', { sessionId: id }).then((res: any) => {
        const text = transcriptText(Array.isArray(res?.messages) ? res.messages : [])
        const mark = loadMarks()[id] || 0
        const fresh = text.slice(mark)
        if (SIGNAL_WORDS.some((w) => fresh.includes(w)) && fresh.length >= 20) { void runOnce('signal', 20); return }
        if (fresh.length >= BULK_CHARS) { void runOnce('bulk'); return }
        if (Date.now() - lastActivity >= IDLE_MS) void runOnce('idle')
      }).catch(() => { /* ignore */ })
    } catch { /* ignore */ }
  }, 60 * 1000)
  // 页面隐藏 / 关窗：尽力而为（RPC 可能来不及完成，仅作兜底）
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && useSettingsStore().autoMem) void runOnce('hide')
  })
  window.addEventListener('pagehide', () => {
    if (useSettingsStore().autoMem) void runOnce('hide')
  })
}
