<script setup lang="ts">
/**
 * PiChatView —— piChat store 节点列表的渲染层（dsh 风格）
 * turn 分组：一次用户消息 → 一组 AI 回复（头像/名字只出现一次，组内可有多段思考/工具/文本）
 * 事件消费在 ChatInterface（全局订阅），本组件只渲染 + 自动滚动。
 */
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue'
import { Copy, Check, Trash2, Pencil, CornerUpLeft, Volume2, Square, Wrench } from 'lucide-vue-next'
import { usePiChatStore, saveThinkMs } from '@/stores/piChat'
import { t } from '@/utils/i18n'
import { shortenElementTokens } from '@/utils/elementTag'
import { useChatStore } from '@/stores/chat'
import ReasoningBlock from './blocks/ReasoningBlock.vue'
import DisclosureRow from './blocks/DisclosureRow.vue'
import ToolPartBlock from './blocks/ToolPartBlock.vue'
import SubAgentBlock from './blocks/SubAgentBlock.vue'
import StreamingTail from './blocks/StreamingTail.vue'
import MarkdownText from './blocks/MarkdownText.vue'
import ProducedFilesRow from './blocks/ProducedFilesRow.vue'
import RetryNotice from './blocks/RetryNotice.vue'
import ContextDivider from './blocks/ContextDivider.vue'
import ImageViewer from './blocks/ImageViewer.vue'
import { useSettingsStore } from '@/stores/settings'
import { useProvidersStore } from '@/stores/providers'
import { useTeamsStore } from '@/stores/teams'
import { useConversationsStore } from '@/stores/conversations'
import { stripModeHint } from '@/utils/modeHint'
import { useVoiceStore } from '@/stores/voice'
import { useAgentPresetsStore } from '@/stores/agentPresets'
import { useExternalChatStore, splitTurns, type PartEvent } from '@/stores/externalChat'
import ExternalStream from './ExternalStream.vue'
import { swallowed } from '@/utils/swallowed'

const settings = useSettingsStore()
const providersStore = useProvidersStore()
const teamsStore = useTeamsStore()
const conversationsStore = useConversationsStore()
const agentPresetsStore = useAgentPresetsStore()

const emit = defineEmits<{
  'scroll-state': [distanceFromBottom: number]
  /** 0914：用户消息「编辑后重发」——删除原轮 + 以编辑后内容重新发送（ChatInterface 处理） */
  'edit-send': [payload: { turnIndex: number; text: string; node: any; images?: string[] }]
  /** 0914：用户消息「返回输入框」——文字+图片等全部信息回填底部编辑器（ChatInterface 处理） */
  'return-input': [node: any]
  /** ★ 0925f：插话乐观气泡「撤回重排」——还没插进去的插话从对话流移除、退回归队条（ChatInterface 处理） */
  'steer-recycle': [node: any]
}>()

const props = defineProps<{ convId: string; selectedModel?: string; bottomInset?: number; emptyTitle?: string; emptySub?: string }>()
const piChat = usePiChatStore()
const chatStore = useChatStore()
/* ★1010 外部流（P0 契约 1010）：会话存在 external parts（extTranscript 回放 / ext-stream 实时帧）
   ⇒ 渲染 ExternalStream 分支，不进 piChat 节点路径（两路并存、互不干扰）。 */
const externalChat = useExternalChatStore()
const extActive = computed(() => externalChat.isExternal(props.convId))
const extParts = computed(() => externalChat.partsFor(props.convId))

/* ★1005：外部流的「按轮切片」—— AI 组按顺序对应第 k 个 ext 轮（turn-end 收段，与 externalChat.splitTurns 同口径）。
 *  为什么要它：原来外部会话是**整窗替换**（顶层 v-if 只画 part 流），于是 pi 侧的**用户气泡**和
 *  **本组工具条**（复制 / 朗读 / 删除这一轮）全被丢掉 —— 实测反馈"用户消息会被吞、并且没有复制之类的功能按钮"。
 *  改成"在 AI 组内部渲染 part 流"后，用户气泡与工具条由既有模板原样保留（复用零件，不另造）。
 *  ⚠️ 轮数对不上时**绝不丢内容**：ext 轮比 AI 组多 → 多出来的全部并进最后一组；比 AI 组少 → 那些组照旧走 pi 节点
 *  （外部轮同时会把正文镜像进 pi transcript，所以那种情况下显示的是同一份正文）。 */
const extTurns = computed<PartEvent[][]>(() => splitTurns(extParts.value))
/* ★1010o（临时诊断，定位后移除）：外部流三个候选变量一次看清，避免继续盲改 */
const extDiag = computed(() => {
  if (!extActive.value) return ''
  const parts = extParts.value.length
  const turns = extTurns.value.length
  const gs = viewGroups.value as any[]
  const ai = gs.filter((g: any) => g.type === 'ai' && !g.syntheticHost).length
  const host = gs.some((g: any) => g.syntheticHost) ? 1 : 0
  return `外部流诊断 parts=${parts} turns=${turns} ai=${ai} host=${host}`
})

/* ★1010p（真根因，带实拍证据）：AI 组数 ≠ ext 轮数（失败轮/镜像消息/占位都会多造组）——
 *  原来"按序号 1:1 映射"在这种错位下必然把内容挂错组、最后两组拿到空数组（=空泡）。
 *  改为按**时间归属**：某组首节点的时间落在哪一轮的 [首 part.t, 末 part.t] 区间 → 该组渲染那一轮；
 *  没有任何组认领的轮，交给末尾合成宿主组渲染（每轮恰好渲染一次，与序号无关）。 */
const extTurnAssign = computed(() => {
  const gs = groups.value as any[]   // 原始组（不含合成宿主，避免与 viewGroups 循环依赖）
  const turns = extTurns.value
  const assign = new Map<number, number>()       // turnIdx → 认领组
  const inRange = new Map<number, number[]>()    // turnIdx → 落在该轮时间区间内的组（DOM 序）
  gs.forEach((g, gi) => {
    if (g.type !== 'ai') return
    const t = Number(g.items?.[0]?.time || g.node?.time || 0)
    if (!t) return
    let hit = -1
    for (let i = 0; i < turns.length; i++) {
      const seg = turns[i]
      const t0 = Number((seg[0] as any)?.t || 0)
      const t1 = Number((seg[seg.length - 1] as any)?.t || t0)
      if (t >= t0 && t <= t1) { hit = i; break }
    }
    if (hit < 0) for (let i = 0; i < turns.length; i++) if (Number((turns[i][0] as any)?.t || 0) <= t) hit = i
    if (hit < 0) return
    if (!inRange.has(hit)) inRange.set(hit, [])
    inRange.get(hit)!.push(gi)
  })
  for (const [ti, gis] of inRange) assign.set(ti, gis[0])   // 每轮取 DOM 序第一个落在区间的组为认领组
  /* ★1010r：同一轮里"非认领组"隐藏（典型：空占位 + 镜像组各一组 → 两个 AI 泡）。
     仅当该轮确实有内容（有认领组）时隐藏；未认领的轮不隐藏（失败提示/无内容轮照旧显示 pi 节点）。 */
  const suppressed = new Set<number>()
  for (const [ti, gis] of inRange) if (turns[ti]?.length) for (const gi of gis.slice(1)) suppressed.add(gi)
  return { assign, suppressed, unmatched: turns.map((_, i) => i).filter((i) => !assign.has(i)) }
})
function extTurnParts(gi: number): PartEvent[] {
  const turns = extTurns.value
  const { assign, unmatched } = extTurnAssign.value
  const g = viewGroups.value[gi] as any
  if (g && g.syntheticHost) return g.hostTurn != null && turns[g.hostTurn] ? turns[g.hostTurn] : unmatched.flatMap((i) => turns[i])   // ★1010q：按位置插的宿主只渲染自己那一轮
  for (const [ti, gIdx] of assign) if (gIdx === gi) return turns[ti]
  return []
}

const copiedId = ref<string | null>(null)
const copyTimer = ref<ReturnType<typeof setTimeout> | null>(null)
/** 用户气泡图片标签悬停：气泡预览（记录数据 + 鼠标位置）；点击：全屏查看 */
const hoverImg = ref<string | null>(null)
const hoverPos = ref<{ x: number; y: number } | null>(null)
const fullImg = ref<string | null>(null)
function onImgHover(e: MouseEvent, src: string) {
  hoverImg.value = src
  hoverPos.value = { x: e.clientX, y: e.clientY }
}

/* ── 0920：朗读这条 AI 回复 ──
 * 只在「设置 → 语音 → 朗读」开着且模型装好时出现（voice.ttsReady）；同一 key 再点一次 = 停止。
 * 后端是离线整段合成，store 里把它按句切开逐句合成逐句播（见 stores/voice.ts）。 */
const voiceStore = useVoiceStore()
function speakKey(gi: number): string {
  return `${props.convId || ''}:${gi}`
}
function toggleSpeak(g: { items: any[] }, gi: number) {
  const text = groupText(g)
  if (!text) return
  void voiceStore.speakText(speakKey(gi), text)
}
onMounted(() => { void voiceStore.ensureLoaded() })

/** 复制一段文本（按钮显示 check 1s） */
async function copyText(text: string, key: string) {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    ta.remove()
  }
  copiedId.value = key
  if (copyTimer.value) clearTimeout(copyTimer.value)
  copyTimer.value = setTimeout(() => { copiedId.value = null }, 1000)
}

/* ── 0914：用户消息「编辑 / 返回输入框」──
 * 编辑=就地改文本（图片保持原样随发）→ 父组件删原轮后重发，AI 重新回复；
 * 返回输入框=文字+图片+技能标签全部回填底部编辑器（原消息不动，用户自行决定）。
 * 回复中禁用（后端 deleteTurn 也会拦；前端提前挡，避免误操作丢内容）。 */
const editingKey = ref<string | null>(null)
const editDraft = ref('')
/** ★ 0924：编辑态的图片**可编辑副本**（支持粘贴新增 / 删除后再发）—— 原来直接读 node.images，只读改不了 */
const editImgs = ref<string[]>([])
/** ★ 0924（用户选 B）：编辑态**富文本区** —— 文本里可内联图片胶囊（与底部输入框同观感） */
const editBoxRef = ref<HTMLElement | null>(null)

/** ★ 0924：消息流容器（配合"屏幕外免渲染"的开关用） */
const streamRef = ref<HTMLElement | null>(null)
/** ★ 0924（填坑）：临时关闭"屏幕外免渲染"，拿到**真实布局**再干活。
 *  —— `content-visibility: auto` 的代价是：视口外元素的高度只是 `contain-intrinsic-size` 的估值，
 *  任何"依赖屏幕外真实尺寸"的逻辑（整页测量、长图/PDF 导出、精确滚动定位）都必须包在这里面：
 *  加 class → 等一帧（布局生效）→ 执行 → 摘 class。副作用窗口只有这一次 await 的时长。
 *  用法：`await withFullRender(() => { ...测量或导出... })`
 *  （也给 window 挂一份，方便别的组件/调试时直接用：`window.__nisWithFullRender`） */
async function withFullRender<T>(fn: () => T | Promise<T>): Promise<T> {
  const el = streamRef.value
  if (!el) return fn()
  el.classList.add('force-render')
  try {
    await nextTick()
    await new Promise<void>(r => requestAnimationFrame(() => r()))
    return await fn()
  } finally {
    el.classList.remove('force-render')
  }
}
onMounted(() => {
  try { (window as any).__nisWithFullRender = withFullRender } catch { /* ignore */ }
})
onUnmounted(() => {
  try { delete (window as any).__nisWithFullRender } catch { /* ignore */ }
})
/** 原始消息文本（含 `[[图片:N]]` 位置标记）—— 用它构建编辑区 DOM，**保留图片在原文的位置** */
const editSourceText = ref('')
function canManageUserMsg(node?: any): boolean {
  /* ★ 0925f（需求）：插话乐观气泡（steerOptimistic/steerPending = 还没被回显回收、
     没真正进对话流）在 AI 回复中也允许管理 —— 它本质是"还没发出去的消息"（可退回队列/输入框）。
     已进历史的消息仍守 replying 门禁（防改进行中的历史，这是原本就有的合理限制）。 */
  if (node?.steerOptimistic || node?.steerPending) return true
  const c = conversationsStore.getById(String(props.convId)) as any
  return !c?.replying
}
/** ★ 0924（用户选 B：编辑框升级富文本）：造一个"图片胶囊"节点（与底部输入框同观感）
 *  —— contenteditable=false 让它成为**原子节点**：光标跨不过去、只能整体删/挪。 */
function makeEditImgTag(idx: number): HTMLElement | null {
  const src = editImgs.value[idx]
  if (!src) return null
  const span = document.createElement('span')
  span.className = 'edit-img-cap'
  span.contentEditable = 'false'
  span.setAttribute('data-img-idx', String(idx))
  const img = document.createElement('img')
  img.src = src
  img.alt = ''
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'edit-img-x'
  btn.title = t('chat.editRemoveImg')
  btn.innerHTML = '<i class="fas fa-xmark"></i>'
  btn.addEventListener('mousedown', (ev) => ev.preventDefault())      // 别把光标从编辑区抢走
  btn.addEventListener('click', (ev) => { ev.preventDefault(); span.remove() })
  span.appendChild(img)
  span.appendChild(btn)
  return span
}
/** 用原始消息构建编辑区 DOM：文本 + 图片胶囊按 `[[图片:N]]` 的**原位置**穿插 */
function buildEditDom() {
  const el = editBoxRef.value
  if (!el) return
  el.innerHTML = ''
  const raw = parseUserText(String(editSourceText.value || '')).text
  const re = /\[\[图片:(\d+)\]\]/g
  const used = new Set<number>()
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(raw)) !== null) {
    if (m.index > last) el.appendChild(document.createTextNode(raw.slice(last, m.index)))
    const i = resolveImgIdx(raw, Number(m[1]), editImgs.value.length)   // T3-0928: old 1-based markers auto-corrected
    const tag = makeEditImgTag(i)
    if (tag) { el.appendChild(tag); used.add(i) }
    last = m.index + m[0].length
  }
  if (last < raw.length) el.appendChild(document.createTextNode(raw.slice(last)))
  /* 兜底：原消息带了图、但正文里没有位置标记 → 追加到末尾，保证不丢图 */
  editImgs.value.forEach((_, i) => {
    if (used.has(i)) return
    const tag = makeEditImgTag(i)
    if (tag) el.appendChild(tag)
  })
  /* ★ 0924（实测"点编辑后内容直接没了"）：万一上面没生成任何节点（解析异常/标记丢失），
     把原文本**原样**塞回去 —— 宁可显示带 `[[图片:N]]` 的原文，也绝不出现空编辑框。 */
  if (!el.childNodes.length && String(editSourceText.value || '').trim()) {
    el.textContent = String(editSourceText.value)
  }
  onEditInput()
}
/* ★ 0924（实测"点编辑后内容直接没了 / 占位符不消失 / 粘贴没标签"）：
   —— 这三个是**同一个根因**：编辑区 DOM 没被构建（于是空框 + 占位符常显 + 粘贴插入点也没有）。
   原因：编辑区是 `v-if` 内的元素，`nextTick` / 单次 `watch(ref)` 都可能落在 ref 赋值之前（父级 groups 重算会再推一拍）。
   这里改成**多重保险的 ensureEditDom()**：找不到 el 就逐帧重试，构建成功即止（幂等，不会打断用户输入）。 */
/** 编辑区 DOM 是否已构建 —— **用显式状态判断，绝不看 DOM 内容**：
    contenteditable 空节点会被浏览器自动补一个 `<br>`，用 `childNodes.length` 判断会误判成"已构建"而跳过，
    这正是"点了编辑却一片空白"的隐藏原因。 */
let editDomBuilt = false
function ensureEditDom(times = 0) {
  if (editDomBuilt) return
  const el = editBoxRef.value
  if (!el) {
    if (times < 8) requestAnimationFrame(() => ensureEditDom(times + 1))
    return
  }
  editDomBuilt = true
  try {
    buildEditDom()
  } catch (e) {
    console.error('[edit] buildEditDom failed', e)
    el.textContent = String(editSourceText.value || '')   // 兜底：宁可显示原文
  }
  onEditInput()
}
/* ★ 0924（真凶）：编辑区在 `v-for` 的消息组里 —— **v-for 内的静态 ref 会被 Vue 收集成数组**，
   后续 `el.innerHTML = ''` / `appendChild` 全写在数组上，**静默失败、不抛错**，
   表现就是"点编辑一片空白、控制台也没报错"。改用**函数 ref**：元素挂载即回调，赋值 + 立即构建。 */
function setEditBoxEl(el: any) {
  if (!el) return                       // 卸载时传 null：忽略（保留最后实例）
  editBoxRef.value = el as HTMLElement
  ensureEditDom()
}
watch(editBoxRef, (el) => { if (el) ensureEditDom() })
/** 遍历编辑区 → 文本（图片按**在文本中出现的顺序**重新编号）+ 图片数组（顺序与之一致） */
function collectEditContent(): { text: string; images: string[] } {
  const el = editBoxRef.value
  if (!el) return { text: editDraft.value.trim(), images: editImgs.value.slice() }
  const images: string[] = []
  let out = ''
  const walk = (n: Node) => {
    if (n.nodeType === 3) { out += n.textContent || ''; return }
    if (n.nodeType !== 1) return
    const e = n as HTMLElement
    const di = e.getAttribute?.('data-img-idx')
    if (di !== null && di !== undefined) {
      const diN = Number(di)   // T3-0928: data-img-idx is editImgs index; fallback covers legacy 1-based
      const src = editImgs.value[diN] || editImgs.value[diN - 1] || ''
      if (src) { out += `[[图片:${images.length}]]`; images.push(src) }
      return
    }
    if (e.tagName === 'BR') { out += '\n'; return }
    if (e.tagName === 'DIV' || e.tagName === 'P') { if (out && !out.endsWith('\n')) out += '\n' }
    e.childNodes.forEach(walk)
  }
  el.childNodes.forEach(walk)
  return { text: out.replace(/\n{3,}/g, '\n\n').trim(), images }
}
/** 在光标处插入图片胶囊（粘贴用；没有有效选区就追加末尾） */
function insertEditImgAtCursor(src: string) {
  const el = editBoxRef.value
  if (!el) return
  editImgs.value = [...editImgs.value, src]
  const tag = makeEditImgTag(editImgs.value.length - 1)
  if (!tag) return
  const sel = window.getSelection()
  if (sel && sel.rangeCount && el.contains(sel.anchorNode)) {
    const r = sel.getRangeAt(0)
    r.deleteContents()
    r.insertNode(tag)
    r.setStartAfter(tag)
    r.collapse(true)
    sel.removeAllRanges()
    sel.addRange(r)
  } else {
    el.appendChild(tag)
  }
}
function startEditUser(node: any) {
  if (!canManageUserMsg(node)) return
  editingKey.value = String(node?.key || '')
  /* ★ 0924（用户选 B）：文本**保留** `[[图片:N]]` 标记（不再剥掉），据此把图片胶囊放回原位 */
  editSourceText.value = String(node?.text || '')
  editDraft.value = parseUserText(String(node?.text || '')).text
    .replace(/\[\[图片:\d+\]\]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  editImgs.value = (Array.isArray(node?.images) ? node.images : []).filter(Boolean)
  editDomBuilt = false          // ★ 每次进入编辑都重新允许构建
  nextTick(() => {
    /* ★ 0924：DOM 构建走 ensureEditDom（多帧重试，见其注释）；
       这里再额外补两拍（nextTick / 80ms）—— 编辑区挂载时机受父级重算影响，单拍不可靠。 */
    ensureEditDom()
    setTimeout(() => ensureEditDom(), 80)
    editBoxRef.value?.focus()
    // 光标落到末尾，接着改最顺手
    try {
      const sel = window.getSelection()
      const r = document.createRange()
      r.selectNodeContents(editBoxRef.value as HTMLElement)
      r.collapse(false)
      sel?.removeAllRanges()
      sel?.addRange(r)
    } catch { /* ignore */ }
  })
}
function cancelEditUser() {
  editingKey.value = null
  editDraft.value = ''
  editImgs.value = []
  editSourceText.value = ''
  editDomBuilt = false
}
/** ★ 0924：编辑区里 Ctrl+V —— 图片**插到光标处**（与底部输入框同口径）；纯文本也手动插，避免带进富文本样式 */
function onEditPaste(e: ClipboardEvent) {
  const files = Array.from(e.clipboardData?.files || []).filter(f => String(f.type || '').startsWith('image/'))
  if (files.length) {
    e.preventDefault()
    for (const f of files) {
      const rd = new FileReader()
      rd.onload = () => { const d = String(rd.result || ''); if (d) insertEditImgAtCursor(d) }
      rd.readAsDataURL(f)
    }
    return
  }
  const txt = e.clipboardData?.getData('text/plain')
  if (txt) {
    e.preventDefault()
    document.execCommand('insertText', false, txt)
  }
}
function onEditInput() {
  const el = editBoxRef.value
  if (!el) return
  el.setAttribute('data-empty', (el.textContent || '').trim() ? 'false' : 'true')
}
function confirmEditUser(node: any, turnIndex: number) {
  const { text, images } = collectEditContent()
  if (!text && !images.length) return
  editingKey.value = null
  editDraft.value = ''
  editImgs.value = []
  editSourceText.value = ''
  editDomBuilt = false
  emit('edit-send', { turnIndex, text, node, images })
}
function returnUserMsgToInput(node: any) {
  if (!canManageUserMsg(node)) return
  emit('return-input', node)
}

/** 0910 删除轮次：点 AI 组操作行垃圾桶 → 弹确认卡（默认连提问一起删；可切换"只删回复"）。
 *  删除后刷新会话历史（session.history → loadHistory 重放），时间线与后端三处（实时 transcript/
 *  持久化/DSH）同步。运行中的轮次禁止删除（后端也会拦）。 */
const delTurnTarget = ref<{ turnIndex: number; gi: number } | null>(null)
const delTurnIncludeUser = ref(true)
const delTurnBusy = ref(false)
const delTurnErr = ref('')
function openDeleteTurn(turnIndex: number, gi: number) {
  if (turnIndex < 1) return
  delTurnErr.value = ''
  delTurnIncludeUser.value = true
  delTurnTarget.value = { turnIndex, gi }
}
async function confirmDeleteTurn() {
  const target = delTurnTarget.value
  if (!target || delTurnBusy.value) return
  delTurnBusy.value = true
  delTurnErr.value = ''
  /* ★0929 多窗口/切换会话竞态：本组件切会话时实例复用（模板无 :key），await 期间
     用户切走后 props.convId 已指向新会话 —— 收尾继续用 props 会把 A 会话的回包
     写进 B 的节点列表（串会话污染）。全程锁定发起时的会话 id。 */
  const cid = String(props.convId || '')
  try {
    const r = await chatStore.bridgeRpc('session.deleteTurn', {
      sessionId: cid,
      turnIndex: target.turnIndex,
      includeUser: delTurnIncludeUser.value,
    })
    if (r?.ok === false) throw new Error(String(r.error || '删除失败'))
    delTurnTarget.value = null
    // 用后端为权威重放时间线（删除范围含工具结果/压缩卡等本地推不出来的形态）
    const result = await chatStore.bridgeRpc('session.history', { sessionId: cid })
    if (result?.messages) {
      piChat.loadHistory(cid, result.messages, Array.isArray(result.compactions) ? result.compactions : undefined,
        Array.isArray(result.runningTools) ? result.runningTools : undefined)
      if (String(props.convId || '') === cid) nextTick(() => scrollToBottom(false))
    }
  } catch (e: any) {
    delTurnErr.value = String(e?.message || e || '删除失败')
    if (delTurnErr.value.includes('正在回复')) setTimeout(() => { delTurnTarget.value = null }, 2200)
  } finally {
    delTurnBusy.value = false
  }
}

const nodes = computed(() => piChat.getNodes(props.convId))
const isEmpty = computed(() => nodes.value.length === 0)
// 空 assistant 节点过滤 + 隐藏 ask_user 工具行（工具行由询问卡替代，不留重复的正方体图标）
const visibleNodes = computed(() => nodes.value.filter(n => {
  void n.images  // 响应式依赖：图片 dataUrl 变化时触发重算（气泡缩略图）
  if (n.kind === 'tool' && n.toolName === 'ask_user') return false
  if (n.subAgent) return true
  if (n.kind === 'assistant' && !n.text && !n.reasoning && !(n.asides && n.asides.length > 0) && n.status !== 'streaming') return false
  return true
}))

/** ★ 0922z（用户指派）：长对话分批加载 —— 已加载片段的**轮次基址**。
 *  已加载首轮在完整会话里的轮号 - 1；groups / navTurns 的 turnIndex 都从它起算，
 *  保证界面上的轮号永远是**全局轮次**（与后端 session.deleteTurn 同口径）。
 *  ⚠️ 别退化成"数 DOM 里第几个用户消息"：分批后序号会与全局轮次错位（删错轮/跳错轮）。 */
const turnBase = computed(() => 0) // ★0930 拆分批加载：恒全量——全局轮次=本地轮次，基址恒 0
/* ★ 0928 拆除（设计口径）：上滑补更早（loadEarlierIfNeeded）已删 ——
   首屏恒全量，不再有"滚到顶自动抓下一批 20 轮"的路。入口、状态、调用点一并拆。 */

/** ★ 0922z2d（用户否掉迷你地图 v2，要"还原旧样式 + 固定 20 格 + 左侧细滑动条"）：
 *  ① 格数固定 ≤20：取"当前视口所在轮"为中心的一个 20 格窗口 → 长会话也不会把导轨撑爆；
 *     往上滑看更早的轮次时，窗口跟着往上移（老样式、老交互不变）。
 *  ② 左侧一条超浅细滑动条：**只在上下滚动时显形**（鼠标扫过不触发），纯指示、不拦鼠标。 */
const RAIL_MAX = 20
const railTurns = computed(() => {
  const list = navTurns.value
  if (list.length <= RAIL_MAX) return list
  const at = list.findIndex((n) => n.turnIndex === activeTurn.value)
  const idx = at < 0 ? list.length - 1 : at
  const start = Math.max(0, Math.min(list.length - RAIL_MAX, idx - Math.floor(RAIL_MAX / 2)))
  return list.slice(start, start + RAIL_MAX)
})
/** ★ 0922z2d3（设计口径）：不要滑动条，改成"外面还有多少条"——
 *  第一个刻度**上方**显示前面还剩多少轮，最后一个刻度**下方**显示后面还剩多少轮（0 不显示）。
 *  "整段对话总轮数"用后端 totalTurns（旧后端回 0 时退回已加载轮数），这样未加载的轮也算得准。 */
const railTotalAll = computed(() => {
  return navTurns.value.length // ★0930 拆分批加载：恒全量，已加载=整段
})
const railBefore = computed(() => {
  const first = railTurns.value[0]?.turnIndex || 1
  return Math.max(0, first - 1)
})
const railAfter = computed(() => {
  const last = railTurns.value[railTurns.value.length - 1]?.turnIndex || 0
  return Math.max(0, railTotalAll.value - last)
})

/** turn 分组：user 自成一组；subAgent 节点自成一组（独立头像+气泡）；其余 assistant/tool 连续归入同一 AI 组。
 *  0910：顺带给每组标 turnIndex（该组所回答的用户轮次序号，1 基；跳过单聊 dm 气泡——它不在主
 *  transcript 里，与后端 session.deleteTurn 的 turnIndex 口径完全一致）。 */
const groups = computed(() => {
  const result: Array<{ type: 'user'; node: any; turnIndex: number } | { type: 'subagent'; node: any; turnIndex: number } | { type: 'ai'; items: any[]; turnIndex: number }> = []
  let current: { type: 'ai'; items: any[]; turnIndex: number } | null = null
  // ★ 0922z：从已加载首轮偏移起算（分批加载后仍是全局轮号）
  let turn = turnBase.value
  for (const n of visibleNodes.value) {
    if (n.kind === 'user') {
      current = null
      /* ★★ 0924 修复（实测反馈"编辑重发后旧消息和旧回复都还在"）——
         必须与后端 session.deleteTurn 同口径：「自动续跑」注入的 user 消息（后端 AUTO_CONTINUE_PREFIX
         = '【自动续跑'）**不算一个真实轮次**。后端数轮次时明确 continue 跳过它，前端原来只跳 dm
         ⇒ 每次自动续跑都会让前端 turnIndex 比后端多 1，编辑重发/删除轮次时后端就删到别的轮上，
         表现正是"我编辑的那条还在"。
         （0923 的后台事件自动续跑链是默认开启的，挂过后台任务就会产生这种消息。） */
      const autoContinue = String(n.text || '').startsWith('【自动续跑')
      if (!n.dm && !autoContinue) turn++
      result.push({ type: 'user', node: n, turnIndex: turn })
    } else if (n.subAgent) {
      current = null
      result.push({ type: 'subagent', node: n, turnIndex: turn })
    } else {
      if (!current) {
        current = { type: 'ai', items: [], turnIndex: turn }
        result.push(current)
      }
      current.items.push(n)
    }
  }
  return result
})

/* ★1010 外部流「收轮内容消失」修复：合成宿主组（渲染层兜底）——
 *  收轮时 finalizeStreaming 把外部会话的空占位 assistant 清掉 ⇒ AI 组消失 ⇒ part 流失宿主整段不渲染，
 *  整窗分支又因用户气泡组还在进不去 ⇒「收轮即整段消失，过会儿对账 loadHistory 重建才复活」。
 *  修法：extActive 且 groups 里没有 AI 组时，末尾补一个**合成宿主组**（空 ai 组）接住 part 流；
 *  有真实 AI 组时原样返回（不双份）。 */
const viewGroups = computed(() => {
  const gs = groups.value as any[]
  if (!extActive.value) return gs
  const { assign, suppressed, unmatched } = extTurnAssign.value
  const turns = extTurns.value
  void unmatched
  /* ★1010s（真根因·排布）：实时里镜像/占位节点被**追加到列表末尾**，按节点物理顺序排就会变成
     「用户·用户·AI·AI」（切回重载按 transcript 重建才对）——所以必须**在视图层按轮重排**。
     规则：第 k 条用户气泡 → 紧跟第 k 轮的认领组；没有认领组但该轮有内容 → 插宿主组接住；
     其余组（失败泡/无内容轮/未认领）按原序补在后面（内容一律不丢）。 */
  const out: any[] = []
  const used = new Set<number>()
  const userIdx: number[] = []
  gs.forEach((g, i) => { if (g.type === 'user') userIdx.push(i) })
  /* ★1010u：轮 ↔ 用户气泡按**时间**归属（第 k 轮归给"它起始时间之前最后一条用户气泡"）。
     按序号硬配在有失败轮（有用户消息但没有内容的轮）时会整体错位，导致最后几条回复完全不渲染。 */
  const ownerOf = new Map<number, number[]>()   // userPos → 轮序号[]
  const utime = (k: number) => Number((gs[userIdx[k]] as any)?.node?.time || (gs[userIdx[k]] as any)?.items?.[0]?.time || 0)
  turns.forEach((seg, ti) => {
    const t0 = Number((seg[0] as any)?.t || 0)
    let up = -1
    for (let k = 0; k < userIdx.length; k++) { const gt = utime(k); if (gt && gt <= t0) up = k }
    if (up >= 0) { if (!ownerOf.has(up)) ownerOf.set(up, []); ownerOf.get(up)!.push(ti) }
  })
  for (let k = 0; k < userIdx.length; k++) {
    out.push(gs[userIdx[k]]); used.add(userIdx[k])
    for (const ti of (ownerOf.get(k) || [])) {
      const gi = assign.get(ti)
      if (gi != null && !suppressed.has(gi) && !used.has(gi)) { out.push(gs[gi]); used.add(gi) }
      else if (turns[ti]?.length) out.push({ type: 'ai', items: [], turnIndex: 1, syntheticHost: true, hostTurn: ti })
    }
  }
  /* 没有归属到任何用户气泡的轮（罕见：会话首条之前）→ 插在最前，内容不丢 */
  {
    const claimed = new Set<number>()
    for (const arr of ownerOf.values()) for (const ti of arr) claimed.add(ti)
    turns.forEach((seg, ti) => {
      if (claimed.has(ti)) return
      out.unshift({ type: 'ai', items: [], turnIndex: 1, syntheticHost: true, hostTurn: ti })
    })
  }
  gs.forEach((g, i) => {
    if (used.has(i) || suppressed.has(i)) return
    const t = Number((g as any).items?.[0]?.time || (g as any).node?.time || 0)
    let pos = out.length
    if (t) {
      pos = 0
      for (let j = 0; j < out.length; j++) {
        const og = out[j] as any
        if (og.type !== 'user') continue
        const gt = Number(og.node?.time || og.items?.[0]?.time || 0)
        if (gt && gt <= t) pos = j + 1
      }
    }
    out.splice(pos, 0, g)
  })
  return out
})
/** ★ 0922z3：消息组的**稳定键**（模板里原来用索引 `:key="gi"`）。
 *  索引键的代价：① 前插/智能卸载后 DOM 元素留在原位、props 换成别的节点，而子组件（ToolPartBlock 等）的
 *  展开态是**组件本地 ref** ⇒ 展开态会"跟着位置走"（你展开的那行不一定是最终展开的那行）；
 *  ② 前插时整段列表都要重 patch（与"前插只插新元素、要便宜"的初衷相反）。
 *  user / subagent 组 = 该节点 key；ai 组 = 组内第一条节点的 key（组只往尾部追加，首条稳定）。 */
function groupKey(g: { type: string; node?: any; items?: any[]; turnIndex: number }): string {
  const k = g.type === 'ai' ? g.items?.[0]?.key : g.node?.key
  return String(k || `g-${g.turnIndex}-${g.type}`)
}

/* ★1003 修复 4.46：非真实轮（dm 单聊气泡 / 【自动续跑】注入）不写 data-turn-user 锚点 ——
 * groups 对它们 push 的 turnIndex 与上一真实轮同号，会造出重复锚点值，
 * querySelector('[data-turn-user="N"]') 会命中同号的另一条消息（定位/高亮错轮）。 */
function isRealUserTurn(g: { type: string; node?: any }): boolean {
  if (g.type !== 'user') return false
  const n = g.node
  /* ★1004：注入类文本判定单源化（原只判【自动续跑，分身回归/后台任务通知会误当真实轮） */
  return !!n && !n.dm && !piChat.isInjectedUserText(String(n.text || ''))
}

/* ★1010 清理：`ProcPart` 类型与 `procSummary()` 是 0923 重做后遗留的**死代码**（全项目零引用）——删除。
   过程折叠的权威口径见下面 procFoldMode。 */

/** ★1010（需求）：过程折叠**三档**（权威字段 appearance.processFoldMode）：
 *   'full'  = 完全展示（不折；等价旧 foldProcessOnDone:false）
 *   'tools' = 折叠工具（默认；连续工具调用折成一行，思考不参与；等价旧 true）
 *   'all'   = 全部折叠（除正文外，把 Think 也折进那一行）
 *  兼容：processFoldMode 未设 → 由旧布尔推导（老数据/老客户端无缝）。 */
const procFoldMode = computed<'full' | 'tools' | 'all'>(() => {
  const a: any = settings.appearance || {}
  const m = a.processFoldMode
  if (m === 'full' || m === 'tools' || m === 'all') return m
  return a.foldProcessOnDone === false ? 'full' : 'tools'
})
/** 兼容读法已删：折叠口径统一走 procFoldMode（模板里全部改用它，无需布尔别名）。 */

onMounted(async () => {
  // 历史已由 openConversation 加载（piChat store）；仅当节点为空时才兜底加载，
  // 避免发消息后覆盖正在流式的内容
  /* ★0929 多窗口/切换会话竞态修复：本组件切会话时**实例复用**（模板无 :key），
     await 期间用户切走后 props.convId 已指向新会话 —— 继续用 props 收尾会把
     A 会话的回包写进 B 的节点列表（串会话污染＝多窗口"奇形怪状 bug"高发源）。
     全程用发起时捕获的 cid 归属数据；只有仍停留在原会话才做 UI 收尾。 */
  const cid = String(props.convId || '')
  if (piChat.getNodes(cid).length > 0) return
  try {
    const result = await chatStore.bridgeRpc('session.history', { sessionId: cid })
    if (result?.messages?.length) {
      piChat.loadHistory(cid, result.messages, Array.isArray(result.compactions) ? result.compactions : undefined,
        Array.isArray(result.runningTools) ? result.runningTools : undefined)
      if (String(props.convId || '') === cid) nextTick(() => scrollToBottom(false))
    }
    // 0908：回合进行中刷新死区（transcript 未落盘）→ replying 时补 streaming 占位（兜底路径与 openConversation 同逻辑；去重复用 beginAssistant）
    try {
      const { useConversationsStore } = await import('@/stores/conversations')
      if (useConversationsStore().getById(cid)?.replying) piChat.resumeStreamingPlaceholder(cid)
    } catch (e) { swallowed('刷新后补流式占位失败（回复进行中刷新会看不到"正在回复"）', e) }
    // 成员单聊气泡恢复（0904，兜底路径；团队会话才查）
    try {
      const { useConversationsStore } = await import('@/stores/conversations')
      if (useConversationsStore().getById(cid)?.teamId) {
        const mc = await chatStore.bridgeRpc('session.memberChats', { sessionId: cid })
        if (mc?.chats && Object.keys(mc.chats).length > 0) piChat.restoreMemberChats(cid, mc.chats)
        // 0910 反馈6：派发成员气泡兜底（黑板 runs）；按 runId 去重，已恢复的不重复补
        try {
          const bbv = await chatStore.bridgeRpc('blackboard.read', { sessionId: cid })
          const runs = bbv?.blackboard?.runs
          if (Array.isArray(runs) && runs.length > 0) piChat.restoreBlackboardRuns(cid, runs)
          // 0911 反馈5：恢复完成后重排同成员多实例编号（#N）
          piChat.renumberMemberInstances(cid)
        } catch (e) { swallowed('成员多实例编号重排失败（成员气泡编号可能重复）', e) }
      }
    } catch (e) { swallowed('刷新恢复成员单聊气泡失败（成员气泡可能缺失）', e) }
    // 恢复挂起的审批卡（同 openConversation，0908三①）
    if (Array.isArray(result?.pendingApprovals) && result.pendingApprovals.length > 0) {
      for (const a of result.pendingApprovals) {
        piChat.attachAside(cid, {
          type: 'permission_prompt',
          request_id: a.requestId,
          question: a.question,
          tool: a.tool,
          risk: a.risk || 'medium',
          options: Array.isArray(a.options) ? a.options : ['允许一次', '当前会话允许', '拒绝'],
        })
      }
    }
    // 恢复挂起的询问卡（同 openConversation）
    if (Array.isArray(result?.pendingQuestions) && result.pendingQuestions.length > 0) {
      for (const q of result.pendingQuestions) {
        piChat.attachAside(cid, {
          type: 'ask_user',
          request_id: q.requestId,
          question: q.question,
          questions: Array.isArray(q.questions) && q.questions.length > 0 ? q.questions : undefined,
          options: q.options,
          placeholder: q.placeholder,
        })
      }
    }
  } catch (e) {
    console.error('[PiChatView] load history failed:', e)
  }
})

const scrollRef = ref<HTMLDivElement | null>(null)
// 用户是否贴底（24px 阈值内视为贴底；贴底时才自动跟随滚动）
const atBottom = ref(true)
/** ★0929b（回归修复"回复不跟随最新内容"）：上一次滚动/跟随时的 scrollHeight。
 *  followIfPinned 用它剥离"内容生长量"——生长后再测 dist 必然 >24（一波涨几百 px），
 *  旧判据会把贴底跟随整个判死；正确口径是回推**生长前**的距底（=用户上个检查点的真实位置），
 *  期间用户手动上滚的像素会自然落在 dist 里（scrollTop 是现测的），不会被拽回。 */
let lastScrollHeight = 0

/* ★0930（治"上翻迟钝"）：滚动事件每秒几十个，活动轮重算合并到每帧一次即可
   （活动轮只是导航条高亮，不需要 60fps 跟手；判定结果与逐事件算完全一致）。 */
let activeTurnRaf = 0
function scheduleActiveTurn() {
  if (activeTurnRaf) return
  activeTurnRaf = requestAnimationFrame(() => { activeTurnRaf = 0; updateActiveTurn() })
}

function onScroll() {
  const el = scrollRef.value
  if (!el) return
  atBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight <= 24
  emit('scroll-state', el.scrollHeight - el.scrollTop - el.clientHeight)
  lastScrollHeight = el.scrollHeight   // ★0929b：检查点前进（下次生长量从这里起算）
  scheduleActiveTurn()
  // ★ 0922z2d3：滑动条已按设计口径去掉（改成导轨上下的"还有多少条"数字），这里无需再更新几何
  // ★ 0928 拆除（设计口径）：智能卸载（贴底 30s 卸旧轮）与上滑补更早（scrollTop<=120）两条路已拆 ——
  //   长会话全量留在 DOM 里，宁可卡一点，也不许滚动时内容消失或跳到别处。
}

function scrollToBottom(smooth = true) {
  const el = scrollRef.value
  if (el) el.scrollTop = el.scrollHeight
}

/** ★0929：贴底跟随统一入口 —— **实测距底**再决定（不信 atBottom 缓存：滚动事件异步，
 *  用户刚滚上去、事件未到时缓存仍 true，会把他拽回底部）；跟随/判定后主动报一次距底，
 *  让"回到最新"按钮的显隐始终跟真相走（内容生长而无滚动事件时旧状态会冻结）。 */
function followIfPinned() {
  const el = scrollRef.value
  if (!el) return
  const dist = el.scrollHeight - el.scrollTop - el.clientHeight
  /* ★0929b 回归修复：判定要看**生长前**的距底。旧实现 `dist <= 24` 在内容生长后测——
     流式一波涨几百 px 必然超阈 → 贴底跟随整个失效（实测"回复不跟随最新内容"）。
     growth=本检查点以来的生长量；preDist=生长前距底。若期间用户手动上滚，scrollTop 是现测的，
     preDist 已含他的滚动 → 不会把他拽回（保留 0929 修复的初衷）。 */
  const growth = el.scrollHeight - lastScrollHeight
  const preDist = dist - growth
  if (preDist <= 24 && !bottomPinBlocked()) scrollToBottom(false)
  onScroll()
}

/** 定位到第 N 个用户消息轮（turnIndex 从 1 计）：按 [data-turn-user] 找第 N 个，滚到该处并短暂高亮。
 *  block：center（WorkspacePanel「定位」用，居中留上下文）/ start（导航条点击用，目标贴顶→活动判定精准）。 */
function scrollToTurn(turnIndex: number, flashClass = 'turn-locate-flash', block: ScrollLogicalPosition = 'center'): boolean {
  /* ★ 0922z：分批加载下目标轮可能还没加载 —— 先按**轮号属性**找；找不到就往上补齐再找。
     （旧实现"数第 N 个 [data-turn-user]"，分批后序号≠全局轮号，会跳到相邻的错轮上。） */
  const findTarget = () => scrollRef.value?.querySelector<HTMLElement>(`[data-turn-user="${turnIndex}"]`) || null
  /* ★ 0922z2c：smooth 可关。**远跳必须瞬时** —— 需要补齐历史时前插内容会触发浏览器 scroll anchoring
     同步改 scrollTop，进行中的平滑滚动会被打断，表现就是"历史补齐了、视口却没动"（真机 35 轮实测）。 */
  const flash = (g: HTMLElement, smooth = true, blk: ScrollLogicalPosition = block) => {
    /* ★ 0922z3b（真机时间线实测的根因）：显式跳轮时**先**把 atBottom 落为 false。
       为什么：逐批补齐期间浏览器的 scroll anchoring 会把视口一直钉在底部 ⇒ atBottom 恒为 true，
       补完 flash 到目标那一刻，内容 ResizeObserver 会立刻 `scrollTop = scrollHeight` 把视口拽回底部
       （表现就是"历史补齐了、却像没跳"）；那跟锁多久无关，锁只是掩盖。
       self-correct：跳到最后一轮时，接下来的 scroll 事件会重算 atBottom 回 true。 */
    atBottom.value = false
    g.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: blk })
    g.classList.add(flashClass)
    setTimeout(() => g.classList.remove(flashClass), 1600)
  }
  /* ★ 0922z3：锁跟着流程走 —— 补齐/定位真正落定才解锁
     （原来是固定 2600ms；补齐是逐批网络往返，超过 2.6s 锁就提前松开 → 同一个 bug 原样复现）。 */
  const jumpToken = beginTurnJump()
  const hit0 = findTarget()
  if (!hit0) {
    void (async () => {
      /* ★0929：循环里多次 await，锁发起会话 —— 中途切走就停手，别给别的会话补历史/闪定位 */
      const cid = String(props.convId || '')
      try {
        /* ★0930 拆分批加载：恒全量——目标轮一定在 DOM 里，再找一次（挂载时序抖动兜底）即可 */
        await nextTick()
        const hit = findTarget()
        if (hit) { flash(hit, false, 'start'); return }
        /* ★ 0922z2c 兜底：历史已经到头、或该轮确实不在数据里 → 跳到当前最靠前的一轮（别静默不动） */
        const near = scrollRef.value?.querySelector<HTMLElement>('[data-turn-user]')
        if (near) flash(near, false, 'start')
      } finally {
        endTurnJump(jumpToken)   // 成功/到头/异常都在这儿解锁
      }
    })()
    return false
  }
  flash(hit0)   // ★ 0922z2：找到就直接定位+高亮（上面那段是补不齐时的异步分支）
  // 平滑滚动约 0.4~0.7s：落定后解锁（期间保持"点击的那个刻度"高亮，别被中途重算覆盖）
  setTimeout(() => endTurnJump(jumpToken), 700)
  return true
}

defineExpose({ scrollToBottom, scrollToTurn, highlightFile })

/* ── 文件 ↔ 变更面板双向临时高亮（0904 定稿）：单目标、10s 自动消失 ──
   highlightFile(relPath, turnIndex?)：滚动到目标轮（若有），给该文件相关的
   产物卡/工具行加 10s 高亮 class；再次调用换目标（旧的立即熄灭）重新计时。 */
const fileHighlightPath = ref<string | null>(null)
let fileHighlightTimer: ReturnType<typeof setTimeout> | null = null
/* ★ 0921 修「切屏再切回来会又高亮一次」：
   高亮 = `classList.add('file-highlight-flash')` + CSS 动画，原来 class 要挂 **10 秒**才摘。
   这期间只要切走页面/窗口（元素变 display:none）再切回来，元素恢复可见时 **CSS 动画会重播**
   —— 看起来就是"每次切屏回来又亮一遍"。
   ⇒ ① 存活时间收到动画总时长（0.75s delay + 1.4s×2 ≈ 3.6s，留 4s）；
      ② 页面重新可见时兜底清一次残留 class。 */
const HIGHLIGHT_MS = 4000
function clearFileHighlights(): void {
  const root: ParentNode = scrollRef.value || document
  root.querySelectorAll<HTMLElement>('.file-highlight-flash').forEach((el) => el.classList.remove('file-highlight-flash'))
}
function onDocVisibleClearHighlight(): void {
  if (document.visibilityState === 'visible') clearFileHighlights()
}
onMounted(() => document.addEventListener('visibilitychange', onDocVisibleClearHighlight))
onUnmounted(() => document.removeEventListener('visibilitychange', onDocVisibleClearHighlight))
function highlightFile(relPath: string, turnIndex?: number | null) {
  if (!relPath) return
  fileHighlightPath.value = relPath
  if (fileHighlightTimer) clearTimeout(fileHighlightTimer)
  fileHighlightTimer = setTimeout(() => { fileHighlightPath.value = null }, HIGHLIGHT_MS)
  if (turnIndex != null) scrollToTurn(turnIndex, 'turn-locate-flash', 'center')
  // 等滚动落位后再闪一次目标元素（产物卡/工具行由 data-produced-path / data-tool-path 锚定）
  setTimeout(() => {
    const root = scrollRef.value
    if (!root) return
    /* ★ 0920 修「高亮选不中」：事件里传的往往是**相对名/文件名**（变更面板的 relPath、
       产物卡派发的 basename），而 DOM 上 `data-produced-path` / `data-tool-path` 存的是**全路径**
       ⇒ 精确属性选择器根本匹配不上，只有两边字符串恰好相同时才会亮（所以以前"有时亮有时不亮"）。
       现在改成：按**文件名（basename）**兜底匹配，两边路径形态不同也能对上。 */
    const base = String(relPath).split(/[\\/]/).pop() || String(relPath)
    const all = root.querySelectorAll<HTMLElement>('[data-produced-path], [data-tool-path]')
    all.forEach(el => {
      const v = el.getAttribute('data-produced-path') || el.getAttribute('data-tool-path') || ''
      if (!v) return
      const vb = v.split(/[\\/]/).pop() || v
      if (v === relPath || vb === base) {
        el.classList.add('file-highlight-flash')
        setTimeout(() => el.classList.remove('file-highlight-flash'), HIGHLIGHT_MS)
      }
    })
  }, 350)
}

/* ── 左侧会话导航条（黑灰白）：每轮一个刻度，悬停浮出该轮缩略，点击定位并高亮 ── */
function firstLine(s?: string): string {
  return (s || '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 64)
}
const navTurns = computed(() => {
  const out: Array<{ turnIndex: number; user: string; ai: string; files: number; time?: number }> = []
  // ★ 0922z：全局轮号（导航条显示/跳转都用它）
  let ti = turnBase.value
  let pending: { turnIndex: number; user: string; ai: string; files: number; time?: number } | null = null
  for (const n of nodes.value) {
    /* ★ 0922z3：轮号口径 = **真实用户轮** —— dm（成员单聊气泡）不是用户轮。
       groups 里是 `if (!n.dm) turn++`、后端 totalTurns 也跳过注入消息；这里原来不判 dm
       ⇒ 团队会话一旦有成员单聊气泡，导轨轮号就比 DOM 锚点 data-turn-user 大（悬停卡错轮号、
       点刻度找不到目标 → 先连拉最多 10 批历史、再跳到最靠前一条）。三处口径必须一致。
       ★1003 修复 4.46：还得跳过「【自动续跑」注入消息 —— groups 对它同样不递增（0924 修），
       这里原来照常 ti++，会话里一出现自动续跑消息（后台事件链默认开启，必然出现），
       导轨刻度就比 data-turn-user 锚点/后端 deleteTurn 轮号偏大：点刻度找不到锚点、高亮错位。 */
    const _autoContinue = String(n.text || '').startsWith('【自动续跑')
    if (n.kind === 'user' && !(n as any).dm && !_autoContinue) {
      ti++
      pending = { turnIndex: ti, user: firstLine(n.text) || '（图片/附件）', ai: '', files: 0, time: n.time }
      out.push(pending)
    } else if (pending && !n.subAgent && n.kind === 'assistant' && !pending.ai) {
      const t = firstLine(n.text) || firstLine(n.reasoning)
      if (t) pending.ai = t
    } else if (pending && n.kind === 'tool' && n.toolName === 'fs_write' && n.toolStatus !== 'running' && !n.toolError) {
      pending.files++
    }
  }
  return out
})
const activeTurn = ref(1)
const navHover = ref<number | null>(null)
const showNav = computed(() => navTurns.value.length >= 2)

/** 依各 [data-turn-user] 锚点相对滚动容器顶部的距离，判定"当前顶部所在轮"。
 *  阈值含 24px 内边距容差；贴底（≤24px）直接归到最后一轮（保证新消息高亮最新条）。 */
function updateActiveTurn() {
  const el = scrollRef.value
  if (!el || !showNav.value) return
  const anchors = el.querySelectorAll<HTMLElement>('[data-turn-user]')
  if (!anchors.length) return
  // 正在显式跳轮（含补齐历史）：信任点击目标，别被滚动动画中途重算覆盖（0922z3：改由跳转流程管锁）
  if (bottomPinBlocked()) return
  const elTop = el.getBoundingClientRect().top
  const line = 48 // 顶部判定线（覆盖 p-6 内边距 + 容差）
  let act = Number(anchors[0].dataset.turnUser) || 1   // ★ 0922z：读属性值（全局轮号）
  /* ★0930（治"上翻迟钝"）：原来是 forEach 全量 getBoundingClientRect —— 长会话 N 个锚点
     每个滚动事件 N 次布局读。锚点按文档序天然有序 ⇒ 二分找"最后一个顶边越线的"，logN 次读，
     结果与原 forEach 完全一致（act 取最后一个 aTop<=line 的锚点）。 */
  let lo = 0, hi = anchors.length - 1, found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (anchors[mid].getBoundingClientRect().top - elTop <= line) { found = mid; lo = mid + 1 } else { hi = mid - 1 }
  }
  if (found >= 0) act = Number(anchors[found].dataset.turnUser) || act
  if (el.scrollHeight - el.scrollTop - el.clientHeight <= 24) act = Number(anchors[anchors.length - 1].dataset.turnUser) || act // 贴底=最新轮
  if (act !== activeTurn.value) activeTurn.value = act
}
/* ★ 0922z2c：显式「跳到第 N 轮」期间暂停"贴底跟随"（同时冻结活动轮重算）。
   真机实测病根：在底部点导航条上未加载的轮 → 补齐历史（前插 15 轮）→ 内容 ResizeObserver 见 atBottom 仍为 true，
   立刻 `scrollTop = scrollHeight` 把视口拽回底部 → 表现是"历史补齐了、却像没跳"。
   ★ 0922z3：原来用固定 2600ms 兜底 —— 补齐是**逐批网络往返**，超过 2.6s 锁就提前松开，同一个 bug 原样复现。
   现在锁**跟着跳转流程走**：beginTurnJump() → 补齐 + 定位全部落定 → endTurnJump()；
   另留 20s 硬上限 + 切会话/卸载时清理，异常路径也不会把贴底跟随永久锁死。 */
let navJumping = false
let navJumpGuardUntil = 0
let navJumpToken = 0
function beginTurnJump(): number {
  navJumping = true
  navJumpGuardUntil = Date.now() + 20000   // 异常路径兜底：到点自动失效
  return ++navJumpToken
}
function endTurnJump(token: number) {
  if (token !== navJumpToken) return        // 已被更新的跳转接管 → 别提前解锁
  navJumping = false
  navJumpGuardUntil = 0
  nextTick(updateActiveTurn)                // 解锁后用真实位置校正一次活动轮
}
function resetTurnJump() { navJumpToken++; navJumping = false; navJumpGuardUntil = 0 }
function bottomPinBlocked() { return navJumping && Date.now() < navJumpGuardUntil }

/** ★ 0922z2d2（设计口径）：悬停卡片要"停 0.25s 再出"——顺着导轨扫过去不该一路闪卡片；离开立即收。
 *  导轨"扫过"的动画由相邻刻度的 cn-near1/2 样式 + .cn-line 自带 transition 给（涟漪感）。 */
const NAV_HOVER_DELAY = 250
let navHoverTimer: ReturnType<typeof setTimeout> | null = null
function onRailEnter(turn: number) {
  if (navHoverTimer) clearTimeout(navHoverTimer)
  navHoverTimer = setTimeout(() => { navHover.value = turn }, NAV_HOVER_DELAY)
}
function onRailLeave(turn: number) {
  if (navHoverTimer) { clearTimeout(navHoverTimer); navHoverTimer = null }
  if (navHover.value === turn) navHover.value = null
}

/* ★ 0928 拆除（设计口径）：智能卸载（unloadEarlier）整块已删 ——
   贴底静置不再把"最近 20 轮之前"从 DOM 抽走；因此也不再需要 cancelUnload/scheduleUnload 计时器。
   ★0930 已彻底删除：conversations.unloadEarlier/loadEarlier + piChat.dropEarliest/prependHistory 全拆。 */
/* [已删] 原 UNLOAD_IDLE_MS / UNLOAD_KEEP_TURNS / unloadTimer / cancelUnload / scheduleUnload */

/* ★ 0922z2d6（设计口径 a）：打开会话的"整段一次性淡入"——
   打开期间挂 fresh-open：列表整体淡入一次，且历史过程块不播入场动画
   （那 500+ 个块一起播动画正是"点开卡一会儿"的一部分）；
   一旦有新节点/新轮次 → 自动关闭，实时新块照常播动画。真机已验证：打开瞬间 disclosure 动画数 517 → 0。 */
const freshOpen = ref(true)
/* ★1012bb：**"整段渐显"看不到的真根因** —— 原来只在 `armFreshOpen()` 后跳一个 `nextTick` 来忽略节点增长，
   而消息实际是在 `session.history` 回来的 `await` **之后**（比 nextTick 晚）才填入 `nodes`
   ⇒ 那次"0 → N"的增长**没被跳过** ⇒ `freshOpen` 立刻被置 false ⇒ `.fresh-open` 类在**内容出现的那一帧
   就被摘掉**，淡入动画根本没机会播（或只播 1 帧）⇒ 观感就是"唰一下闪出来"，调时长/加位移都没用。
   改用**时间窗**（时间戳比较，**不依赖 setTimeout** —— 本项目真机上出现过"定时器不触发"的坑）：
   窗口内的节点增长一律视为"加载历史"，不关渐显；窗口过后才恢复"新节点 → 关"的语义。 */
const FRESH_OPEN_MS = 900        // 大于动画时长（420ms），留足余量
let freshOpenUntil = Date.now() + FRESH_OPEN_MS   // 首屏/刷新后自动打开会话也覆盖到
function armFreshOpen() {
  freshOpen.value = true
  freshOpenUntil = Date.now() + FRESH_OPEN_MS
}
/* ★ 0928（归因用诊断开关）：`content-visibility: auto`（屏幕外免渲染）在 WebView2 上有
   "滚回来内容空白"的嫌疑 → 留一个**不用改代码就能验证**的开关：
   控制台执行 localStorage.setItem('nis-force-render','1') 再刷新 = 全量渲染（关掉免渲染）；
   删掉这个键（localStorage.removeItem('nis-force-render')）再刷新即恢复。
   归因结束（确认是不是它的锅）后这 4 行可以直接删。 */
const forceRender = ref(false)
try { forceRender.value = localStorage.getItem('nis-force-render') === '1' } catch { /* ignore */ }
/* 会话切换 → 重新开启 fresh-open（此时 DOM 里的都是历史块）。
   ★ 0922z3：切会话那一拍会带来一次"节点数变化"（切到**已缓存**的会话时尤其明显），那不是"实时新块"
   —— 跳过一次判定。否则刚 arm 就被关掉，淡入/抑制入场动画在新会话里静默失效；
   （0922z3 把消息组改成稳定键后，切会话会真正重建这些行、入场动画会一起播 —— 必须保持抑制。） */
watch(() => props.convId, () => {
  armFreshOpen()   // ★1012bb：时间窗在 arm 内部设置，覆盖"整段加载 + 淡入动画"
})
/* 新节点出现（= 实时回复/新一轮开始）→ 立刻关闭 fresh-open，让新块照常播入场动画。
   ★ 这里刻意**不用定时器**：真机实测 400ms 定时器在部分实例里不触发（同"智能卸载"那次的坑），
   用"有没有新节点"这个确定性事件替代，逻辑上还更准。 */
watch(() => nodes.value.length, (n, prev) => {
  // ★1012bb：**加载窗口内**的增长（含"历史一次性填入"那一拍）不算"实时新块" ⇒ 不关渐显。
  // 原来靠 `freshOpenSkipGrowth` 只跳一次 nextTick，而历史是在 await 之后才填入的，跳不到 ⇒ 动画被摘掉。
  if (Date.now() < freshOpenUntil) return
  if (prev != null && n > prev) freshOpen.value = false
})

function navGoto(turnIndex: number) {
  activeTurn.value = turnIndex
  // 加锁/解锁由 scrollToTurn 内部按"补齐 + 定位"流程管（0922z3）
  scrollToTurn(turnIndex, 'nav-locate-flash', 'start')
}
// 内容/轮次变化后重算当前活动轮（锚点位置随流式增长而变）
watch(() => [nodes.value.length, navTurns.value.length], () => nextTick(updateActiveTurn))

// 内容高度变化兜底跟随：watch 节点字段覆盖不到的场景（markdown 图片异步加载、统计条、文件行增高等）
// 会让 scrollHeight 突增而未滚动 → 最新内容被输入框遮挡；ResizeObserver 监听内容根尺寸补上
let contentRO: ResizeObserver | null = null
// 容器自身高度变化（计划卡展开/收起、审批卡出现推挤布局）→ 贴底时保持钉在最新消息
let containerRO: ResizeObserver | null = null
onMounted(() => {
  const el = scrollRef.value
  const content = el?.firstElementChild
  if (content && typeof ResizeObserver !== 'undefined') {
    contentRO = new ResizeObserver(() => nextTick(() => followIfPinned()))
    contentRO.observe(content)
  }
  if (el && typeof ResizeObserver !== 'undefined') {
    containerRO = new ResizeObserver(() => nextTick(() => followIfPinned()))
    containerRO.observe(el)
  }
})
onUnmounted(() => { resetTurnJump(); contentRO?.disconnect(); contentRO = null; containerRO?.disconnect(); containerRO = null })

// 节点内容变化（流式 text/reasoning/tool 更新）自动跟随滚动到底部——仅当用户贴底时
watch(
  () => piChat.getNodes(props.convId).map(n => `${n.status}:${n.text.length}:${n.reasoning.length}:${n.toolResult?.length || 0}:${(n.asides || []).length}`),
  () => {
    nextTick(() => {
      /* ★0929（实测"长任务流式时回到最新按钮经常消失/被拽底"）：跟随改 followIfPinned
         —— 实测距底不信缓存（滚动事件异步竞态会拽底），且变化后主动报距底（按钮显隐
         原来只在滚动事件里更新，内容生长而用户没滚轮时状态冻结在旧值）。 */
      followIfPinned()
    })
  },
  { deep: true },
)

// 发送新消息（出现新 user 节点）→ 强制回到底部：用户即使往上翻看过往，发消息后也要跟下去
// 发送新消息（**尾部追加**了新 user 节点）→ 强制回到底部：用户即使往上翻看过往，发消息后也要跟下去
// ★ 0922z：分批加载的"上滑取更早"是**首部前插**一堆 user 节点 —— 那不是新消息。
//   旧写法（user 节点数变多就贴底）会在补齐时把视口拽到最底部 ⇒ "跳回未加载的轮"落空（真机实测）。
//   判据改成"最后一个节点的 id 变了且它是 user"：前插不动尾部，追加才动尾部。
// ★1004（实测反馈"分身回归把分身卡片顶出视野"）：**强制贴底只属于真人发消息** ——
//   注入类 user 文本（自动续跑/后台任务通知/分身回归…）到达只走 followIfPinned
//   （用户贴底才跟、上滑回看不打扰）。
watch(
  () => {
    const ns = piChat.getNodes(props.convId)
    const last = ns[ns.length - 1]
    return last && last.kind === 'user' && !piChat.isInjectedUserText(String(last.text || '')) ? String(last.id || '') : ''
  },
  (id, prev) => {
    if (prev == null) return
    if (id && id !== prev) {
      atBottom.value = true
      nextTick(() => scrollToBottom())
    }
  },
)

// 切换会话 → 强制贴底：上一个会话的滚动状态（atBottom）不能带过来，
// 否则切回带计划卡的会话时最新回复停在半空、被磨砂浮层遮挡。
// 历史节点是异步恢复的，连钉三帧确保内容到位后仍贴底。
watch(() => props.convId, () => {
  resetTurnJump()   // ★ 0922z3：切会话 → 丢掉未完成的跳转锁（否则新会话里贴底跟随被上一次跳转锁住）
  atBottom.value = true
  nextTick(() => scrollToBottom(false))
  setTimeout(() => scrollToBottom(false), 60)
  setTimeout(() => scrollToBottom(false), 180)
})

// 底部浮层（输入框/审批卡/询问卡）高度变化时预留空间，贴底状态下把最新消息顶到浮层上方
watch(() => props.bottomInset, (val, prev) => {
  if (val != null && val !== prev) nextTick(() => followIfPinned())   // ★0929：实测距底判定（同上）
})

function formatTime(ts?: number): string {
  if (!ts) return ''
  return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

/** Nis 头像：用户设过就用自己的，没设过用**默认 logo**（0920 需求要求，见 settings.nisAvatar） */
const nisAvatar = computed(() => {
  const name = settings.persona.nisName || 'Nis'
  const avatar = settings.nisAvatar
  return { avatar, name, initial: name.slice(0, 1).toUpperCase() }
})

function parseArgs(args: any): Record<string, any> {
  if (args == null) return {}
  if (typeof args === 'object') return args
  try { return JSON.parse(String(args)) } catch { return { raw: String(args) } }
}

/** ★ 1001（需求要求：报错要显眼）：AI 正文里的**错误消息**渲染成红卡片 + 重试按钮。
 *
 * ⚠⚠ 1001 翻车实录（**两次**，务必留着这条注释，别再动这段判断）：
 *  第一版按"文本特征"兜底识别历史错误（正文含「这一步没跑起来 / 原始错误：/ 重试无用」就算错）。
 *  结果**用户正在读的正常汇报**被包进了「请求失败」卡片 —— 原因极其朴素：
 *  **我在汇报里引用了「这一步没跑起来」这几个字**，正则把"**讨论**报错"当成了"**报错本身**"。
 *  改成"只看开头 120 字"仍翻车（实测特征句落在第 45 字）；再收紧到"开头 12 字 + 只认一种特征"才不误判 ——
 *  但**残余风险非零**：我哪天第一句正好写「这一步没跑起来是因为…」，照样把正文变成报错卡片。
 *  ⇒ **最终决定（已定案 A）：只认 `[NIS-ERR]` 标记，零文本兜底。**
 *    代价：标记之前的历史报错**不显示卡片**（等于回到旧样子，不算退化）；
 *    换来的是**误判概率恒为 0** —— 误判正文的代价远大于漏判历史错误。 */
const ERR_MARK_RE = /^\s*\[NIS-ERR\]/
function isErrText(s: any): boolean {
  return ERR_MARK_RE.test(String(s || ''))
}
/** 渲染时把机器标记摘掉（别让用户看见这串内部符号） */
function errBody(s: any): string {
  return String(s || '').replace(ERR_MARK_RE, '').replace(/^\[NIS-ERR\]\s*/, '')
}
/** 重试：把本轮的用户消息放回输入框（复用气泡旁红叹号那套，用户可改后重发） */
function retryTurn(g: any): void {
  const u = (g?.items || []).find((x: any) => x.kind === 'user')
  if (u && typeof returnUserMsgToInput === 'function') returnUserMsgToInput(u)
}

/** AI 组头部模型名：节点透传的 model 优先，缺失时回退当前选中模型 */
function modelLabel(items: any[]): string {
  const n = items.find(x => x.kind === 'assistant' && x.model)
  if (n?.model) return n.model
  if (props.selectedModel) {
    const pid = providersStore.providerActive
    return providersStore.modelName(pid, props.selectedModel) || props.selectedModel
  }
  return ''
}

/** 悬停统计：8月16日 18:27 · 用时 6分10秒 · 首 token 1.5秒 · 52 tok/s */
function formatFullTime(ts?: number): string {
  if (!ts) return ''
  const d = new Date(ts)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hh}:${mm}`
}
function formatDuration(ms?: number): string {
  if (ms == null) return ''
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}秒`
  return `${Math.floor(s / 60)}分${s % 60}秒`
}
function formatSec(ms?: number): string {
  if (ms == null) return ''
  return `${(ms / 1000).toFixed(1)}秒`
}
function tokPerSec(meta: any): number | null {
  if (!meta?.timing?.llmMs || !meta?.usage?.completionTokens) return null
  const sec = meta.timing.llmMs / 1000
  if (sec <= 0) return null
  return Math.round(meta.usage.completionTokens / sec)
}
/** AI 组统计（悬停显示：日期时间 · 用时 · 首 token · tok/s · 本轮缓存命中率；timing 挂在组内最后一条 assistant 节点上——
 *  工具轮会产生多条 assistant 节点，读第一条会拿不到统计（团队模式每轮带工具曾复现）。
 *  刷新后 timing 无法恢复（后端不持久化）→ 兜底显示日期 + 输出 token（turnUsage 从持久化 usage 恢复） */
function aiGroupStats(g: any): string {
  const items: any[] = g.items || []
  const asst = [...items].reverse().find(n => n.kind === 'assistant' && (n.turnTiming || n.turnUsage || n.text))
  const meta = { timing: asst?.turnTiming, usage: asst?.turnUsage }
  const parts: string[] = []
  const ft = formatFullTime(asst?.time)
  if (ft) parts.push(ft)
  const dur = formatDuration(meta?.timing?.llmMs)
  if (dur) parts.push(`用时 ${dur}`)
  const ttft = formatSec(meta?.timing?.ttftMs)
  if (ttft) parts.push(`首 token ${ttft}`)
  const tps = tokPerSec(meta)
  if (tps != null) parts.push(`${tps} tok/s`)
  // 0910：本轮缓存命中率（口径同 StatsLine：promptTokens 已是未命中部分，分母=完整输入）
  const u = meta?.usage
  if (u) {
    const billed = (u.promptTokens || 0) + (u.cacheReadTokens || 0) + (u.cacheWriteTokens || 0)
    if (billed > 0 && ((u.cacheReadTokens || 0) > 0 || (u.cacheWriteTokens || 0) > 0)) {
      parts.push(`缓存 ${Math.round((u.cacheReadTokens || 0) / billed * 100)}%`)
    }
  }
  if (!meta?.timing?.llmMs && meta?.usage?.completionTokens) parts.push(`输出 ${meta.usage.completionTokens} tok`)
  return parts.join(' · ')
}

/** AI 组全文（复制用）：正文段落拼接 */
function groupText(g: { items: any[] }): string {
  return g.items.filter(n => n.kind === 'assistant' && n.text).map(n => n.text).join('\n\n')
}

/** 成员 run segments 里 fs_write 成功节点 → 产物路径（args 由后端 buildRunSegments 持久化） */
function producedFromSegments(segs: any[] | undefined): Array<{ path: string; size?: number }> {
  const out: Array<{ path: string; size?: number }> = []
  for (const s of segs || []) {
    if (s?.type !== 'tool' || s?.name !== 'fs_write' || s?.status !== 'done') continue
    const args = s.args
    const p = typeof args?.path === 'string' ? args.path.trim() : ''
    if (!p) continue
    if (out.some(f => f.path === p)) continue
    const m = /已写入\s*(\d+)\s*字节/.exec(String(s.result || ''))
    out.push({ path: p, size: m ? Number(m[1]) : undefined })
  }
  return out
}

/** 本轮交付物：当前 ai 组之前连续的 subagent 组产物聚合（成员执行、主 agent 交付——卡片挂主回复尾部） */
function turnSubProduced(gi: number): Array<{ path: string; size?: number }> {
  const out: Array<{ path: string; size?: number }> = []
  for (let i = gi - 1; i >= 0; i--) {
    const g = groups.value[i]
    if (!g || g.type !== 'subagent') break
    for (const f of producedFromSegments(g.node?.subAgent?.segments)) {
      if (!out.some(x => x.path === f.path)) out.push(f)
    }
  }
  return out
}

/** 组内 fs_write 成功工具节点 → 产出物（持久：节点在历史里，刷新/跨轮不丢） */
function groupProduced(g: { items: any[] }): Array<{ path: string; size?: number }> {
  const out: Array<{ path: string; size?: number }> = []
  for (const n of g.items) {
    if (n.kind !== 'tool' || n.toolName !== 'fs_write') continue
    if (n.toolStatus !== 'done' || n.toolError) continue
    const args = parseArgs(n.toolArgs)
    const p = typeof args?.path === 'string' ? args.path.trim() : ''
    if (!p) continue
    if (!out.some(f => f.path === p)) out.push({ path: p, size: n.fileSize })
  }
  return out
}

/** 用户消息：解析 [技能:xxx] 前缀 → 返回 { skills, text }（气泡内渲染为标签而非文字） */
function parseUserText(text: string): { skills: string[]; text: string } {
  if (!text) return { skills: [], text: '' }
  const skills: string[] = []
  // 0920：后端还会把「工作模式」指令拼在最前面（一行 [模式:计划] …），先剥掉再找技能标签
  let rest = stripModeHint(text)
  const reSkill = /\[技能:([^\]]+)\]\s*/g
  let m: RegExpExecArray | null
  while ((m = reSkill.exec(rest)) !== null) {
    skills.push(m[1].trim())
    rest = rest.slice(m.index + m[0].length)
  }
  return { skills, text: rest }
}

/* === T3-0928 存量消息图片兼容 ====================================================
 * [[图片:N]] 标记本轮从 1-based 改成了 0-based（ChatInput/collectEditContent 现从 0 连续编号），
 * 但存量老消息存的是 1-based：直接 imgs[idx] 会错位、丢末张（老消息 N 张图标记 1..N，imgs[N] 取不到）。
 * 口径：按文本自动识别旧/新 —— 出现 [[图片:0]] 即 0-based（新口径序列化必带 0 号标记）；
 * 否则视为旧 1-based。取图再加双向回退（idx-base / idx / idx-1），保证旧消息图片不丢不串位。 */
function imgMarkerBase(text: string, imgCount: number): number {
  if (!text || !imgCount) return 0
  const re = /\[\[\u56fe\u7247:(\d+)\]\]/g
  let max = -1
  let hasZero = false
  let m: RegExpExecArray | null
  while ((m = re.exec(String(text))) !== null) {
    const n = Number(m[1])
    if (n === 0) hasZero = true
    if (n > max) max = n
  }
  if (hasZero || max < 0) return 0
  return 1   // 无 [[图片:0]]：新口径必带 0 号标记 -> 旧 1-based
}
/** 标记号 -> 图片下标（双向兼容；越界按 idx / idx-1 回退，绝不串到远下标） */
function resolveImgIdx(text: string, idx: number, imgCount: number): number {
  const base = imgMarkerBase(text, imgCount)
  const cands = [idx - base, idx, idx - 1]
  for (const c of cands) if (c >= 0 && c < imgCount) return c
  return -1
}
/** 渲染取图（老 1-based 标记自动回退到 imgs[idx-1]） */
function imgAt(images: any, idx: number, text: string): string {
  const arr = Array.isArray(images) ? images : []
  if (!arr.length) return ''
  const i = resolveImgIdx(text, idx, arr.length)
  return String(i >= 0 ? (arr[i] || '') : '')
}
/** 气泡角标序号（1 起显示；旧口径同步纠偏，不串号） */
function imgLabel(idx: number, text: string, imgCount: number): number {
  return idx - imgMarkerBase(text, imgCount) + 1
}
/* === T3-0928 图片兼容块结束 ====================================================== */

function userSegments(text: string): Array<{ type: 'text'; text: string } | { type: 'img'; idx: number } | { type: 'file'; name: string }> {
  /* ★1011s：除「图片位置标记 [[图片:N]]」外，再拆「文件标记 [[文件:名字]]」——
     非图片附件原来是**在选中那一刻就被丢掉**的（气泡里什么都没有），现在按同一种标记机制
     随正文带到气泡里，渲染成一个附件 chip（图标 + 文件名）。
     ⚠️ 正则带**两个捕获组** ⇒ split 结果每 3 项为一组：(text, imgIdx, fileName)。 */
  const parts = String(text || '').split(/\[\[图片:(\d+)\]\]|\[\[文件:([^\]]+)\]\]/)
  const segs: Array<{ type: 'text'; text: string } | { type: 'img'; idx: number } | { type: 'file'; name: string }> = []
  for (let i = 0; i < parts.length; i += 3) {
    if (parts[i]) segs.push({ type: 'text', text: parts[i] })
    if (parts[i + 1] !== undefined && parts[i + 1] !== '') segs.push({ type: 'img', idx: Number(parts[i + 1]) })
    else if (parts[i + 2] !== undefined && parts[i + 2] !== '') segs.push({ type: 'file', name: parts[i + 2] })
  }
  return segs
}

/** ★1011t：`[[文件:uploads/xxx.exe]]` 里存的是**工作区相对路径**（消息轻、AI 能照着读）——
 *  但气泡里只该显示文件名，所以这里取最后一段；完整路径留在 title 里可悬停查看。 */
function baseName(p: string): string {
  const s = String(p || '')
  return s.includes('/') ? s.slice(s.lastIndexOf('/') + 1) : s
}

/** 当前会话团队的 memberId → 成员名映射（派发任务卡显示用；非团队会话返回空） */
function teamMemberNames(): Record<string, string> {
  const conv = conversationsStore.getById(String(props.convId)) as any
  const team = conv?.teamId ? teamsStore.teams.find(t => t.id === conv.teamId) : null
  const map: Record<string, string> = {}
  if (team) {
    for (const m of team.members) {
      map[m.id] = agentPresetsStore.presets.find(p => p.id === m.preset)?.name || m.preset
    }
  }
  return map
}
/* ══ ★ 0923（用户定·重做）：**只折叠工具过程，不折叠思考** ══════════════════════
 *  口径：把 AI 组里**连续的工具节点**（只含 tool）折成一行，位置留在原地（内联，不搬家）；
 *        Think 行 / 正文 / 内联通知 / 图片 / 问询卡 / **重试提示**一律不参与（明确需求）。
 *  折叠行直接用 DisclosureRow —— 与 Think 完全同款：行首图标、悬停时图标淡出箭头淡入、
 *  箭头旋转 + 展开高度动画，全部继承，不再自绘（自绘那版箭头位置与动画都对不齐）。 */
function isToolNode(n: any): boolean {
  /* ★ 0923（反馈"报错了都看不到"）：**retry 不再算工具段** ——
     原来把 `kind === 'retry'` 也算进来，重试提示一落进工具段就被折叠行吞掉
     （折叠行接管该段时那行 RetryNotice 根本不渲染）→ 模型报错重试用户完全看不见。
     口径回归"只折工具"。 */
  return !!n && n.kind === 'tool'
}
/** Think 节点？判定与 ReasoningBlock 的 v-if **逐字对齐**（assistant 且有 reasoning，或 streaming 且尚无实际正文
 *  的占位 Think）。两者不一致会出现"该显示的没了 / 该折的没折"。 */
function isThinkNode(n: any): boolean {
  if (!n || n.kind !== 'assistant') return false
  if (n.reasoning) return true
  return n.status === 'streaming' && !String(n.text || '').trim()
}
/** ★1010：**过程节点**（进折叠段的节点）—— 'tools' 档只认工具；'all' 档把 Think 也算进来（"除正文外全折"）。 */
function isProcNode(n: any): boolean {
  if (isToolNode(n)) return true
  if (procFoldMode.value !== 'all') return false
  return isThinkNode(n)
}
/** 组内第 ni 个节点是否为"过程段起点"（在它前面插折叠行） */
function isProcRunStart(g: any, ni: number): boolean {
  const items = g?.items || []
  if (!isProcNode(items[ni])) return false
  return ni === 0 || !isProcNode(items[ni - 1])
}
/** 该节点属于过程段（本体交给折叠行渲染，这里跳过） */
function inProcRun(g: any, ni: number): boolean {
  return isProcNode((g?.items || [])[ni])
}
/** 从 ni 起连续的过程节点 */
function procRunAt(g: any, ni: number): any[] {
  const items = g?.items || []
  const out: any[] = []
  for (let i = ni; i < items.length && isProcNode(items[i]); i++) out.push(items[i])
  return out
}
function toolRunKey(g: any, ni: number): string {
  return 'toolrun-' + String((g?.items || [])[ni]?.key || ni)
}
/** **该工具段自身**是否已跑完（段内没有仍在流式的节点）。
 *  ★ 0923 修正：原来判断"整组是否定稿"，太保守 —— 工具早就跑完了，只要正文还在写就一直展开，
 *  看起来就像"没折叠"。改成只看这一段：段内有工具在跑 → 展开看进度；段内全完 → 折叠。 */
function toolRunSettled(g: any, ni: number): boolean {
  return procRunAt(g, ni).every((n: any) => n.status !== 'streaming')
}
const toolRunUserState = ref<Record<string, boolean>>({})
/** 用户没手动点过时：过程中展开（能看进度）、完成后折叠（回看干净）；
 *  ★ 'full' 档（完全展示）→ **永不自动折叠**，每条过程行照常平铺（该档下折叠行本就不渲染，这里是双保险）。 */
function toolRunOpen(g: any, key: string, ni: number): boolean {
  const explicit = toolRunUserState.value[key]
  if (explicit !== undefined) return explicit
  if (procFoldMode.value === 'full') return true
  return !toolRunSettled(g, ni)
}
function toggleToolRun(key: string, g: any, ni: number): void {
  const cur = toolRunUserState.value[key]
  const now = cur !== undefined ? cur : !toolRunSettled(g, ni)
  toolRunUserState.value = { ...toolRunUserState.value, [key]: !now }
}
function toolRunSummary(nodes: any[]): string {
  const tools = nodes.filter((n: any) => n.kind === 'tool')
  const last = [...tools].reverse().find((n: any) => n.toolName)?.toolName || ''
  const base = t('chat.procSummary', { n: nodes.length, tools: tools.length || nodes.length })
  return last ? base + ' · ' + t('chat.procLast', { x: last }) : base
}
/** ★ 0923（需求）：折叠行必须体现**调用异常** —— 统计段内工具的成功/失败数。
 *  失败判定：`toolStatus === 'error'` 或 `toolError`（实时链路与历史恢复链路都写这两个字段）。
 *  渲染策略：**只在有失败时**显示 `（X 成功 Y 失败）`，失败数红字；全成功时保持原来的简洁摘要。 */
function toolRunStats(nodes: any[]): { ok: number; fail: number } {
  const tools = nodes.filter((n: any) => n.kind === 'tool')
  let fail = 0
  for (const x of tools) if (x.toolStatus === 'error' || x.toolError) fail += 1
  return { ok: tools.length - fail, fail }
}
/** 段内最后一个有名字的工具（标题末尾的"最后：xxx"） */
function toolRunLast(nodes: any[]): string {
  return [...nodes].reverse().find((n: any) => n.kind === 'tool' && n.toolName)?.toolName || ''
}
</script>

<template>
  <div class="relative h-full overflow-hidden flex flex-col">
  <!-- 左侧会话导航条：≥2 轮才出现，每轮一刻度，悬停浮出缩略，点击定位。黑/灰/白配色 -->
  <nav v-if="showNav" class="chat-nav" :aria-label="t('chat.navAria')">
    <!-- ★ 0922z2d3：上方还有多少轮（未显示在导轨里的）——0 则不渲染 -->
    <span v-if="railBefore > 0" class="cn-more cn-more-top">{{ railBefore }}</span>
    <button
      v-for="nv in railTurns"
      :key="nv.turnIndex"
      class="cn-slot"
      :class="{
        'cn-slot-active': activeTurn === nv.turnIndex,
        'cn-near1': navHover != null && Math.abs(navHover - nv.turnIndex) === 1,
        'cn-near2': navHover != null && Math.abs(navHover - nv.turnIndex) === 2,
      }"
      @mouseenter="onRailEnter(nv.turnIndex)"
      @mouseleave="onRailLeave(nv.turnIndex)"
      @click="navGoto(nv.turnIndex)"
    >
      <span class="cn-tick">
        <span class="cn-line"></span>
      </span>
      <!-- ★ 0922z2d2：卡片用 Transition 包住 —— 入场/离场都有动画（原来只有入场动画，离场瞬隐） -->
      <Transition name="cn-pop">
        <span v-show="navHover === nv.turnIndex" class="cn-card">
          <span class="cn-card-role cn-card-user">{{ nv.user }}</span>
          <span v-if="nv.ai" class="cn-card-role cn-card-ai">{{ nv.ai }}</span>
          <span class="cn-card-meta">
            {{ t('chat.turnOrdinal', { n: nv.turnIndex }) }}<span v-if="nv.files"> · {{ t('chat.filesCount', { n: nv.files }) }}</span><span v-if="nv.time"> · {{ formatTime(nv.time) }}</span>
          </span>
        </span>
      </Transition>
    </button>
    <!-- ★ 0922z2d3：下方还有多少轮 -->
    <span v-if="railAfter > 0" class="cn-more cn-more-bottom">{{ railAfter }}</span>
  </nav>
  <div ref="scrollRef" class="relative flex-1 overflow-y-auto overflow-x-hidden custom-scroll p-6" :style="{ paddingBottom: (props.bottomInset || 200) + 'px' }" @scroll="onScroll">
    <!-- ★ 0928 拆除：分批加载「载入更早」入口已删（首屏恒全量） -->
    <!-- ★ 0924（反馈"只加载 20 轮还是有卡顿感"）：给消息流加 **屏幕外免渲染** ——
         长会话里每一轮可能几十个节点（工具块 / 思考块 / Markdown 解析），此前**视口外的也在参与布局与绘制**，
         这正是"只加载 20 轮还卡"的主因。`content-visibility: auto` 让视口外的组直接跳过渲染与布局；
         `contain-intrinsic-size` 用 `auto` 关键字让浏览器**记住实测高度** → 滚动条不跳、回滚不闪。 -->
    <div v-if="extActive || !isEmpty" ref="streamRef" class="chat-stream max-w-3xl mx-auto space-y-6" :class="{ 'fresh-open': freshOpen && !isEmpty, 'force-render': forceRender }">
      <div v-if="extDiag" class="text-[10px] text-amber-500/80 px-1 pb-1 font-mono">{{ extDiag }}</div>
      <!-- ★1010 外部流（P0 契约）：live 帧与回放 extTranscript 走同一渲染路径。
           ★1005 改（实测反馈"用户消息会被吞、并且没有复制之类的功能按钮"）：外部会话**不再整窗替换** ——
           改为在 AI 组内部渲染 part 流（见下方 ai-group-row），pi 侧的用户气泡与本组工具条因此原样保留。
           下面这条只用于**没有 pi 节点时**的整窗渲染（纯外部会话、镜像正文尚未落盘的窗口期）。 -->
      <!-- ★1010 收轮消失修复：整窗分支停用（防与合成宿主组双份）——无 AI 组时由 viewGroups 的合成组接管渲染 -->
      <template v-if="!extActive || viewGroups.length">
      <template v-for="(g, gi) in viewGroups" :key="groupKey(g)">
        <!-- 用户气泡（右对齐）：data-turn-user 供"定位到对话"反查滚动；非真实轮（dm/自动续跑）不写锚点（★1003 4.46 防重复轮号） -->
        <div v-if="g.type === 'user'" class="flex justify-end group/bubble" :data-turn-user="isRealUserTurn(g) ? g.turnIndex : undefined">
          <!-- ★ 0921 修「编辑气泡变形、很挤」：外层只有 `max-w-[82%]`（上限，不是实际宽度），
               而编辑态里是 textarea（width:100% 撑不起内容宽度）⇒ 实际宽度退化到 `min-width:260px`，
               长文本被挤成窄条。编辑态**撑满 82%**。 -->
          <div class="max-w-[82%] dsh-user-col" :class="{ 'w-full': editingKey === g.node.key }">
            <!-- 0914：编辑态（就地改文本；图片保持原样随发；发送=删原轮重发→AI 重新回复） -->
            <div v-if="editingKey === g.node.key" class="dsh-user-bubble user-edit-box">
              <!-- ★ 0924（用户选 B：升级富文本）：图片胶囊**内联在文本里**（与底部输入框同观感）、
                   按原消息位置穿插；Ctrl+V 贴图插到**光标处**，胶囊悬停点 × 删除，位置随文字自由调。
                   胶囊是 contenteditable=false 的原子节点 —— 光标跨不过去、不会把标签拆坏。 -->
              <!-- ★ 0924（关键修复）：ref 必须用**函数形式** —— 编辑区在 v-for 的消息组里，
                   静态 `ref="editBoxRef"` 会被 Vue 收集成**数组**，于是 `el.innerHTML = ''` 写在数组上
                   **静默失败（不报错！）** → 编辑框永远空白。函数 ref 在元素挂载时立刻回调，
                   直接赋值 + 立即构建，一举解决"时机"和"v-for 数组"两个坑。 -->
              <div
                :ref="setEditBoxEl"
                class="user-edit-rich"
                contenteditable="true"
                spellcheck="false"
                data-empty="true"
                :data-placeholder="t('chat.editPlaceholder')"
                @focus="ensureEditDom()"
                @click="ensureEditDom()"
                @input="onEditInput"
                @keyup="onEditInput"
                @paste="onEditPaste"
                @keydown.esc.stop="cancelEditUser"
              ></div>
              <div class="user-edit-actions">
                <button class="user-edit-btn" @click="cancelEditUser">{{ t('chat.editCancel') }}</button>
                <button class="user-edit-btn is-primary" @click="confirmEditUser(g.node, g.turnIndex)">{{ t('chat.editSend') }}</button>
              </div>
            </div>
            <div v-else class="flex justify-end items-start gap-1">
              <!-- 0927 netfix badge-outside-0927: 发送失败红叹号放气泡外（左侧），不再嵌在蓝色 pill 里 -->
              <span
                v-if="g.node.status === 'error'"
                class="inline-flex items-center justify-center w-4 h-4 mt-2 rounded-full bg-red-500 text-white text-[11px] font-bold cursor-pointer flex-shrink-0"
                :title="t('chat.resendHint')"
                @click.stop="returnUserMsgToInput(g.node)"
              >!</span>
            <div class="dsh-user-bubble" :class="{ 'steer-glow': g.node.steerPending, 'send-failed': g.node.status === 'error' }">
              <template v-for="(sk, ski) in (g.node.skills || parseUserText(g.node.text).skills)" :key="'s' + ski">
                <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-[530] bg-indigo-600 text-white align-middle mr-1"><i class="fas fa-wand-magic-sparkles text-[7px]"></i>{{ sk }}</span>
              </template>
              <template v-for="(seg, si) in userSegments(shortenElementTokens(parseUserText(g.node.text).text))" :key="si">
                <template v-if="seg.type === 'text'">{{ seg.text }}</template>
                <!-- ★1011s：非图片附件（exe/pdf/zip…）在气泡里显示成附件 chip（图标 + 文件名） -->
                <span
                  v-else-if="seg.type === 'file'"
                  class="inline-flex items-center align-middle gap-1 px-1.5 py-0.5 mx-0.5 rounded-md bg-black/25 text-white text-[10px] select-none max-w-[200px]"
                  :title="seg.name"
                >
                  <i class="fas fa-paperclip text-[9px] flex-shrink-0"></i>
                  <span class="truncate">{{ baseName(seg.name) }}</span>
                </span>
                <span
                  v-else
                  class="inline-flex items-center align-middle gap-1 px-1.5 py-0.5 mx-0.5 rounded-md bg-black/25 text-white text-[10px] select-none relative cursor-pointer"
                  @mouseenter="onImgHover($event, imgAt(g.node.images, seg.idx, g.node.text) || '')"
                  @mouseleave="hoverImg = null; hoverPos = null"
                  @click.prevent="fullImg = imgAt(g.node.images, seg.idx, g.node.text) || ''"
                >
                  <img :src="imgAt(g.node.images, seg.idx, g.node.text)" class="w-4 h-4 rounded object-cover flex-shrink-0" alt="" />
                  <span>{{ t('chat.imageIdx', { n: imgLabel(seg.idx, g.node.text, (g.node.images || []).length) }) }}</span>
                </span>
              </template>
            </div>
            </div>
            <div class="flex items-center justify-end gap-2 mt-1.5 text-gray-400" data-time-hover-root>
              <span class="text-xs msg-time">{{ formatTime(g.node.time) }}</span>
              <!-- 0914：编辑（删原轮重发） / 返回输入框（文字+图片全部回填编辑器） -->
              <!-- ★ 0925f：插话乐观气泡（未注入）的"编辑"按钮 = 撤回重排（退回归队条），不是气泡内富文本编辑 -->
              <button v-if="!g.node.dm" class="msg-action" :title="(g.node.steerOptimistic || g.node.steerPending) ? t('queue.steerRecycleTip') : t('chat.editMsg')" @click="(g.node.steerOptimistic || g.node.steerPending) ? emit('steer-recycle', g.node) : startEditUser(g.node)">
                <Pencil :size="14" />
              </button>
              <button v-if="!g.node.dm" class="msg-action" :title="t('chat.returnToInput')" @click="returnUserMsgToInput(g.node)">
                <CornerUpLeft :size="14" />
              </button>
              <!-- ★1004：复制与显示同口径——parseUserText 剥行首注入行/技能标签（原走裸 node.text，
                   回显新建/历史回放的气泡会把 [记忆召回] 等注入文本复制进剪贴板）；[[图片:N]] 位置标记一并去掉 -->
              <button class="msg-action" :title="copiedId === 'u' + gi ? t('chat.copied') : t('chat.copy')" @click="copyText(parseUserText(g.node.text).text.replace(/\[\[图片:\d+\]\]/g, '').replace(/\[\[文件:[^\]]+\]\]/g, '').trim(), 'u' + gi)">
                <Copy v-if="copiedId !== 'u' + gi" :size="14" />
                <Check v-else :size="14" class="text-green-500" />
              </button>
            </div>
          </div>
        </div>

        <!-- 子 agent 消息组：独立头像+名字+模型+气泡（默认折叠 3 行预览） -->
        <div v-else-if="g.type === 'subagent'" class="flex items-start gap-3">
          <div class="flex-1 min-w-0">
            <SubAgentBlock :node="g.node" />
          </div>
        </div>

        <!-- AI 回复组：头像/名字一次，组内顺序渲染思考/工具/文本。
             data-time-hover-root 挂在整组上 → 悬停回复区任意位置都显示当条底部统计 -->
        <div v-else class="ai-group-row flex items-start gap-3 group/bubble" data-time-hover-root>
          <div v-if="settings.appearance?.bubbleAvatar !== false" class="relative flex-shrink-0">
            <img
              v-if="nisAvatar.avatar"
              :src="nisAvatar.avatar"
              class="w-8 h-8 rounded-full object-cover shadow-sm border border-black/15"
              alt=""
            />
            <div v-else class="w-8 h-8 rounded-full bg-gradient-to-br from-purple-400 to-indigo-500 flex items-center justify-center text-white font-bold text-sm shadow-sm border border-black/15">{{ nisAvatar.initial }}</div>
          </div>
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2 mb-2">
              <span class="font-[530] text-gray-700 text-sm">{{ nisAvatar.name }}</span>
              <span class="model-tag text-[11px] text-gray-400">{{ modelLabel(g.items) }}</span>
            </div>
            <div class="mb-3 space-y-3 dsh-ai-body">
              <!-- ★1005：外部预设会话 —— 本组内容改由 part 流渲染（用户气泡与本组工具条在容器外，原样保留） -->
              <ExternalStream v-if="extActive && (g.syntheticHost || extTurnParts(gi).length)" :parts="extTurnParts(gi)" />
              <div v-else class="space-y-2">
                <template v-for="(n, ni) in g.items" :key="n.key">
                  <!-- ★ 0923（重做）：过程段折叠行 —— 用 DisclosureRow，交互与 Think 完全一致：
                       行首扳手图标，悬停时图标淡出/箭头淡入，展开有高度动画，箭头带旋转动画。
                       ★ 0925（需求）：设置里「回复完成折叠过程态」关掉时（foldProcessOnDone=false），
                       **「我忙活了 N 步」这一行整行不出现** —— 过程行直接平铺（内容与折叠态 slot 一致）。
                       ★1010（需求）：升级为三档 —— 'tools' 只折工具（Think 不参与）、
                       'all' 连 Think 一起折（除正文外全折）、'full' 完全展示（走下面的平铺分支）。 -->
                  <template v-if="isProcRunStart(g, ni) && procFoldMode !== 'full'">
                  <DisclosureRow
                    :title="toolRunSummary(procRunAt(g, ni))"
                    :open="toolRunOpen(g, toolRunKey(g, ni), ni)"
                    :animate="true"
                    @toggle="toggleToolRun(toolRunKey(g, ni), g, ni)"
                  >
                    <!-- ★ 0923（用户定稿）：括号里直接给成败统计（**失败红字**），位置就原来"（N 次工具）"那儿；
                         全成功时退回原来的"（N 次工具）"文案，末尾保留"最后：xxx"。 -->
                    <template #title>
                      <template v-for="st in [toolRunStats(procRunAt(g, ni))]" :key="'st'">
                        {{ t('chat.procSteps', { n: procRunAt(g, ni).length }) }}<template v-if="st.fail > 0">{{ t('chat.procStatsOk', { ok: st.ok }) }}<b class="proc-fail-note">{{ t('chat.procStatsFail', { fail: st.fail }) }}</b></template><template v-else-if="st.ok > 0">{{ t('chat.procTools', { tools: st.ok }) }}</template><template v-if="toolRunLast(procRunAt(g, ni))"> · {{ t('chat.procLast', { x: toolRunLast(procRunAt(g, ni)) }) }}</template>
                      </template>
                    </template>
                    <template #icon>
                      <Wrench :size="14" stroke-width="1.5" :style="{ color: 'var(--dsw-alias-label-tertiary)' }" />
                    </template>
                    <div class="space-y-2">
                      <template v-for="n2 in procRunAt(g, ni)" :key="n2.key">
                        <RetryNotice v-if="n2.kind === 'retry'" :node="n2" />
                        <ToolPartBlock
                          v-else-if="n2.kind === 'tool'"
                          :stream-chars="n2.toolStreamChars || 0"
                          :part="{
                            tool: n2.toolName,
                            input: parseArgs(n2.toolArgs),
                            status: n2.awaitingApproval ? 'pending' : n2.toolStatus === 'running' ? 'running' : n2.toolError ? 'error' : 'completed',
                            output: n2.toolResult,
                            error: n2.toolError ? n2.toolResult : '',
                            call_id: n2.callId,
                            memberNames: teamMemberNames(),
                            shell: n2.toolShell,
                            diffStat: n2.diffStat,
                            fileSize: n2.fileSize,
                          }"
                          :desc="n2.toolName || ''"
                        />
                        <!-- ★1010（'all' 档）：Think 也在这个过程段里 —— 展开折叠行时按原样式显示 Think 行
                             （'full'/'tools' 档下段内不会出现 assistant 节点，此分支不会命中，作兜底） -->
                        <ReasoningBlock
                          v-else-if="n2.kind === 'assistant'"
                          :content="n2.reasoning"
                          :streaming="n2.status === 'streaming' && !n2.reasoningDone"
                          :idle-until="piChat.thinkIdleUntil"
                          :start-time="n2.time"
                          :elapsed-ms="n2.reasoningMs || 0"
                          @elapsed="(ms: number) => { n2.reasoningMs = ms; saveThinkMs(String(props.convId || ''), n2.time, ms) }"
                        />
                      </template>
                    </div>
                  </DisclosureRow>
                  </template>
                  <!-- ★ 0925：完全展示档（'full'）→ 过程行平铺（无「我忙活了 N 步」标题行）；
                       ★1010 补：'all' 档下该分支同样能承接 Think 节点（段内一起平铺，防御性保留）。 -->
                  <div v-else-if="isProcRunStart(g, ni)" class="space-y-2">
                    <template v-for="n2 in procRunAt(g, ni)" :key="n2.key">
                      <RetryNotice v-if="n2.kind === 'retry'" :node="n2" />
                      <ToolPartBlock
                        v-else-if="n2.kind === 'tool'"
                        :stream-chars="n2.toolStreamChars || 0"
                        :part="{
                          tool: n2.toolName,
                          input: parseArgs(n2.toolArgs),
                          status: n2.awaitingApproval ? 'pending' : n2.toolStatus === 'running' ? 'running' : n2.toolError ? 'error' : 'completed',
                          output: n2.toolResult,
                          error: n2.toolError ? n2.toolResult : '',
                          call_id: n2.callId,
                          memberNames: teamMemberNames(),
                          shell: n2.toolShell,
                          diffStat: n2.diffStat,
                          fileSize: n2.fileSize,
                        }"
                        :desc="n2.toolName || ''"
                      />
                      <!-- ★1010：'all' 档 Think 也属于过程段（同上，防御性分支） -->
                      <ReasoningBlock
                        v-else-if="n2.kind === 'assistant'"
                        :content="n2.reasoning"
                        :streaming="n2.status === 'streaming' && !n2.reasoningDone"
                        :idle-until="piChat.thinkIdleUntil"
                        :start-time="n2.time"
                        :elapsed-ms="n2.reasoningMs || 0"
                        @elapsed="(ms: number) => { n2.reasoningMs = ms; saveThinkMs(String(props.convId || ''), n2.time, ms) }"
                      />
                    </template>
                  </div>
                  <!-- ★ 0923（需求）：事件类通知挪到"回复气泡之外" ——
                       压缩分隔线 / 重试提示都包进 msg-outer-row（负 margin 抵消头像列，
                       横跨整组宽度、不再挂在回复正文里）；重试还保底"绝不参与工具段折叠"
                       （见 isToolNode 注释），否则报错被折叠行吞掉、用户根本看不见。 -->
                  <div v-if="n.kind === 'notice'" class="msg-outer-row" :class="{ 'msg-outer-row--avatar': settings.appearance?.bubbleAvatar !== false }">
                    <ContextDivider :node="n" />
                  </div>
                  <!-- LLM 重试过程块（过程态动画 / 完成态 icon）——★ 0923：不再进工具段折叠，独立成行 -->
                  <div v-if="n.kind === 'retry' && !inProcRun(g, ni)" class="msg-outer-row" :class="{ 'msg-outer-row--avatar': settings.appearance?.bubbleAvatar !== false }">
                    <RetryNotice :node="n" />
                  </div>
                  <!-- 思考块（与工具行对齐；streaming 占位时也显示 Think + 点动动画）。
                       占位条件用"无实际正文"（trim 判空）而非 !n.text：provider 死区常先吐纯空白
                       text_delta，若按 !n.text 判，Think 点动动画会被一段空白提前顶掉（"动画消失"根因）。 -->
                  <ReasoningBlock
                    v-if="n.kind === 'assistant' && !inProcRun(g, ni) && (n.reasoning || (n.status === 'streaming' && !(n.text || '').trim()))"
                    :content="n.reasoning"
                    :streaming="n.status === 'streaming' && !n.reasoningDone"
                    :idle-until="piChat.thinkIdleUntil"
                    :start-time="n.time"
                    :elapsed-ms="n.reasoningMs || 0"
                    @elapsed="(ms: number) => { n.reasoningMs = ms; saveThinkMs(String(props.convId || ''), n.time, ms) }"
                  />
                  <!-- 正文：必须有"非空白实际内容"才渲染气泡。
                       provider 流式期常先吐纯空白 text_delta（空格/换行）再吐正文，
                       若只判 n.text 非空 → 空白气泡占 42px（"中间态大间距"根因），
                       定稿后被真实文本覆盖又消失（"完成后恢复"根因）。
                       流式渲染入参裁尾随空白（\n 在 pre-wrap 下各撑一行=图一"工具行上方空行"；
                       只裁渲染层不裁存储，段落间 \n\n 语义不受影响；done 态 MarkdownText 本就折叠空白）。 -->
                  <div v-if="n.kind === 'assistant' && isErrText(n.text)" class="ai-err-card">
                    <div class="ai-err-head">
                      <i class="fas fa-triangle-exclamation"></i>
                      <span>请求失败</span>
                      <button class="ai-err-retry" title="把这条消息放回输入框，改完直接重发" @click.stop="retryTurn(g)">
                        <i class="fas fa-rotate-right"></i><span>重试</span>
                      </button>
                    </div>
                    <div class="ai-err-body">
                      <MarkdownText :text="errBody(n.text)" />
                    </div>
                  </div>
                  <div
                    v-else-if="n.kind === 'assistant' && (n.text || '').trim()"
                    class="msg-body text-[14px] leading-normal"
                  >
                    <MarkdownText v-if="n.status === 'done'" :text="n.text" />
                    <StreamingTail v-else :text="n.text.replace(/\s+$/, '')" />
                  </div>
                  <!-- 工具行（fs_write 运行态=诚实等待行：静止图标+计时+生成进度，无假想动动画；见 ToolPartBlock）
                       —— ★ 0923：已由上面的过程段折叠行接管（!inProcRun 时才直接渲染；'all' 档连 Think 一起接管） -->
                  <ToolPartBlock
                    v-if="n.kind === 'tool' && !inProcRun(g, ni)"
                    :stream-chars="n.toolStreamChars || 0"
                    :part="{
                      tool: n.toolName,
                      input: parseArgs(n.toolArgs),
                      status: n.awaitingApproval ? 'pending' : n.toolStatus === 'running' ? 'running' : n.toolError ? 'error' : 'completed',
                      output: n.toolResult,
                      error: n.toolError ? n.toolResult : '',
                      call_id: n.callId,
                      memberNames: teamMemberNames(),
                      shell: n.toolShell,
                      diffStat: n.diffStat,
                      fileSize: n.fileSize,
                    }"
                    :desc="n.toolName || ''"
                  />
                  <!-- 0908 对话流内嵌图：工具"发图给用户"（details.dataUrl）→ 缩略图卡，点击进内置 ImageViewer
                       （全屏缩放/拖拽/还原/Esc，与用户气泡发图同一查看器同一通道）；不再弹浏览器新标签 -->
                  <div
                    v-if="n.kind === 'image' && n.images && n.images.length"
                    class="chat-image-card"
                    role="button"
                    :title="t('image.clickToZoom')"
                    @click="fullImg = n.images[0]"
                  ><img :src="n.images[0]" alt="" /></div>
                  <!-- 子 agent 既有独立分组渲染（SubAgentBlock），这里不再透传 subRuns -->
                  <!-- 权限/问询卡：轻量状态标记（真实交互卡由输入区接管，一次只显示一个） -->
                  <div
                    v-for="(a, ai) in (n.asides || [])"
                    :key="ai"
                    class="my-1.5 flex items-center gap-2 text-[13px] text-gray-400"
                  >
                    <i :class="['fas', a.type === 'permission_prompt' ? 'fa-shield-halved text-amber-400' : 'fa-circle-question text-indigo-400']"></i>
                    <span class="truncate">{{ a.question }}</span>
                    <span class="ml-auto shrink-0 text-[11px] font-[530]" :style="{ color: a.answered ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-tertiary)' }">{{ a.answered ? (a.answeredValue || t('block.answered')) : t('block.awaiting') }}</span>
                  </div>
                </template>
              </div>
            </div>
            <!-- AI 消息操作行（复制 + 统计：日期时间 · 用时 · 首 token · tok/s，整组悬停显示） -->
            <div class="flex items-center gap-2 text-gray-400 mb-1">
              <button class="msg-action" :title="copiedId === 'a' + gi ? t('chat.copied') : t('chat.copy')" @click="copyText(groupText(g), 'a' + gi)">
                <Copy v-if="copiedId !== 'a' + gi" :size="14" />
                <Check v-else :size="14" class="text-green-500" />
              </button>
              <!-- 0920：朗读（复制钮右侧；开关联动——关掉朗读它就消失，正在读时变停止） -->
              <button
                v-if="voiceStore.ttsReady"
                class="msg-action"
                :class="{ 'is-speaking': voiceStore.speakingKey === speakKey(gi) }"
                :title="voiceStore.speakingKey === speakKey(gi) ? t('chat.readAloudStop') : t('chat.readAloud')"
                @click="toggleSpeak(g, gi)"
              >
                <Square v-if="voiceStore.speakingKey === speakKey(gi)" :size="13" class="text-indigo-500" />
                <Volume2 v-else :size="14" />
              </button>
              <!-- 0910：删除这一轮（垃圾桶，紧邻复制钮；弹卡确认，可只删回复或连提问一起删） -->
              <button
                v-if="g.turnIndex >= 1"
                class="msg-action"
                :title="t('chat.deleteTurn')"
                @click="openDeleteTurn(g.turnIndex, gi)"
              >
                <Trash2 :size="14" />
              </button>
              <span
                v-if="aiGroupStats(g)"
                class="msg-stats text-[11px] text-gray-400 cursor-default"
              >{{ aiGroupStats(g) }}</span>
            </div>
            <!-- 组内产出物 + 本轮成员交付物（fs_write 成功节点推导：持久，刷新/跨轮不丢） -->
            <ProducedFilesRow
              v-if="groupProduced(g).length > 0 || turnSubProduced(gi).length > 0"
              :conv-id="props.convId"
              :files="[...groupProduced(g), ...turnSubProduced(gi).filter(f => !groupProduced(g).some(x => x.path === f.path))]"
            />
          </div>
        </div>
      </template>
      </template>
    </div>
    <!-- 空态 -->
    <div v-else class="flex flex-col items-center justify-center h-full gap-3">
      <div class="w-16 h-16 rounded-full bg-gradient-to-br from-purple-400 to-indigo-500 flex items-center justify-center text-white text-2xl shadow-lg">
        <img v-if="nisAvatar.avatar" :src="nisAvatar.avatar" class="w-full h-full rounded-full object-cover" alt="" />
        <span v-else>{{ nisAvatar.initial }}</span>
      </div>
      <div class="text-gray-500 text-sm">{{ props.emptyTitle || t('chat.emptyTitle', { name: nisAvatar.name }) }}</div>
      <div class="text-gray-400 text-xs">{{ props.emptySub || t('chat.emptySub') }}</div>
    </div>
    <!-- 回到最新消息按钮已迁移到 ChatInterface 输入框浮层上方（居中） -->
  </div>
  <!-- 图片悬停气泡预览：从鼠标位置弹出，不用黑屏遮罩 -->
  <Transition name="img-pop">
    <div
      v-if="hoverImg"
      class="fixed z-[9999] pointer-events-none"
      :style="{ left: (hoverPos?.x || 0) + 14 + 'px', top: (hoverPos?.y || 0) + 14 + 'px' }"
    >
      <img :src="hoverImg" class="max-w-[280px] max-h-[280px] rounded-lg shadow-xl border border-black/10 bg-white object-contain" :alt="t('chat.imageAlt')" />
    </div>
  </Transition>
  <!-- 点击图片标签：全屏查看（缩放/拖动） -->
  <ImageViewer :src="fullImg" @close="fullImg = null" />
  <!-- 0910：删除轮次确认卡（同 trashConfirm 语言：居中弹窗 + 单选 + 取消/删除） -->
  <Teleport to="body">
    <div v-if="delTurnTarget" class="fixed inset-0 z-[999] flex items-center justify-center bg-black/40" @click.self="!delTurnBusy && (delTurnTarget = null)">
      <div class="bg-white dark:bg-gray-800 rounded-2xl shadow-2xl w-[360px] p-5">
        <div class="text-[14px] font-[640] text-gray-900 dark:text-gray-100 mb-1">{{ t('chat.deleteTurnTitle') }}</div>
        <p class="text-[12px] text-gray-500 dark:text-gray-400 mb-3 leading-relaxed">{{ t('chat.deleteTurnBody') }}</p>
        <label class="flex items-start gap-2 mb-2 cursor-pointer select-none">
          <input type="radio" :checked="delTurnIncludeUser" class="mt-0.5" @change="delTurnIncludeUser = true" />
          <span class="text-[12px] text-gray-700 dark:text-gray-200 leading-snug">{{ t('chat.deleteTurnWithUser') }}</span>
        </label>
        <label class="flex items-start gap-2 mb-1 cursor-pointer select-none">
          <input type="radio" :checked="!delTurnIncludeUser" class="mt-0.5" @change="delTurnIncludeUser = false" />
          <span class="text-[12px] text-gray-700 dark:text-gray-200 leading-snug">{{ t('chat.deleteTurnReplyOnly') }}</span>
        </label>
        <p class="text-[11px] text-gray-400 dark:text-gray-500 mb-4 leading-relaxed">{{ t('chat.deleteTurnHint') }}</p>
        <p v-if="delTurnErr" class="text-[11px] text-red-500 mb-3">{{ delTurnErr }}</p>
        <div class="flex justify-end gap-2">
          <button class="btn btn-secondary btn-sm" :disabled="delTurnBusy" @click="delTurnTarget = null">{{ t('settings.cancel') }}</button>
          <button class="btn btn-sm bg-red-600 hover:bg-red-700 text-white" :disabled="delTurnBusy" @click="confirmDeleteTurn">
            {{ delTurnBusy ? t('chat.deleteTurnBusy') : t('chat.deleteTurnConfirm') }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
  </div>
</template>

<style scoped>
/* ★ 1001：AI 正文里的**错误卡片** —— 红底 + 警示图标 + 标题栏 + 重试按钮。
   目标：报错一眼可见，绝不再混在正常回复里看不出来（用户 1001 实报）。 */
.ai-err-card { margin: 4px 0 2px; border: 1px solid #fecaca; border-left: 3px solid #ef4444;
  border-radius: 10px; background: #fef2f2; overflow: hidden; }
.ai-err-head { display: flex; align-items: center; gap: 7px; padding: 8px 12px;
  background: #fee2e2; color: #991b1b; font-size: 12.5px; font-weight: 620; }
.ai-err-head i { font-size: 12px; }
.ai-err-retry { margin-left: auto; display: inline-flex; align-items: center; gap: 5px;
  padding: 3px 10px; border-radius: 7px; border: 1px solid #fca5a5; background: #fff;
  color: #b91c1c; font-size: 11.5px; font-weight: 560; cursor: pointer; transition: background 0.15s ease; }
.ai-err-retry:hover { background: #fff7ed; border-color: #fb923c; color: #c2410c; }
.ai-err-body { padding: 10px 12px 11px; font-size: 13px; line-height: 1.72; color: #7f1d1d; }
.ai-err-body :deep(p) { margin: 0 0 6px; }
.ai-err-body :deep(p:last-child) { margin-bottom: 0; }
.ai-err-body :deep(code) { background: rgba(153, 27, 27, 0.08); color: #7f1d1d; }
html.dark .ai-err-card { border-color: #4c1d1d; border-left-color: #ef4444; background: #2a1414; }
html.dark .ai-err-head { background: #3b1a1a; color: #fca5a5; }
html.dark .ai-err-retry { background: transparent; border-color: #7f1d1d; color: #fca5a5; }
html.dark .ai-err-retry:hover { background: #451a1a; border-color: #ef4444; color: #fecaca; }
html.dark .ai-err-body { color: #fecaca; }

/* 正文（assistant 回复）：黑色 + 字重 400=Inter regular（与 MarkdownText 同步；350 是系统字体时代的圆整近似）。
   MarkdownText 会自设颜色，需在其自身样式里同步（见该组件）；此处覆盖纯文本/流式路径。 */
.msg-body {
  color: #15151a;
  font-weight: 400;
}
/* 定位到对话：短暂高亮被定位的用户气泡（WorkspacePanel 定位按钮触发） */
.turn-locate-flash {
  animation: turn-flash 1.6s ease-out;
}
@keyframes turn-flash {
  0%, 55% { filter: drop-shadow(0 0 10px rgba(99, 102, 241, 0.55)); }
  100% { filter: none; }
}
/* 导航条点击定位：黑灰高亮（区别于 WorkspacePanel 定位的靛蓝） */
.nav-locate-flash {
  animation: nav-flash 1.6s ease-out;
}
@keyframes nav-flash {
  0%, 55% { filter: drop-shadow(0 0 10px rgba(17, 24, 39, 0.4)); }
  100% { filter: none; }
}

/* 文件 ↔ 变更面板双向高亮 —— 样式**搬去全局**了（见本文件末尾的 <style> 非 scoped 块）。
   原因：这个 class 是 JS 用 classList 加上去的，而 `[data-produced-path]` 落在 ProducedFilesRow 的
   内部元素上，拿不到 PiChatView 的 scope id ⇒ scoped 规则对它根本不生效（产物卡其实一直没被点亮过）。 */

/* 模型名标签：小号灰色，位于 AI 名右侧 */
.model-tag {
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.02em;
}

/* 0908 对话流内嵌图（wb_send_screenshot）：正文图片卡，最大宽随栏、圆角描边，点击进内置查看器 */
.chat-image-card {
  display: block;
  max-width: 480px;
  border-radius: 10px;
  overflow: hidden;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-interactive-bg-hover-solid);
  line-height: 0;
  cursor: zoom-in;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}
.chat-image-card:hover {
  border-color: var(--dsw-alias-border-l3, var(--dsw-alias-border-l2));
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.08);
}
.chat-image-card img {
  display: block;
  width: 100%;
  height: auto;
}

/* 用户气泡（蓝色渐变 + 白字，替代白色干巴卡片） */
.dsh-user-col {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
}
.dsh-user-bubble {
  /* ★1010：配色走全局变量（设置→外观→我的气泡颜色；未设置回落原蓝紫渐变） */
  background: var(--dsh-user-bubble, linear-gradient(135deg, #2563eb 0%, #4f46e5 100%));
  /* 0913：主圆角走全局变量（设置→外观→气泡圆角 小/中/大 → 10/16/24px；右下角保留小尖角） */
  border-radius: var(--dsh-bubble-radius, 16px) var(--dsh-bubble-radius, 16px) 4px var(--dsh-bubble-radius, 16px);
  padding: 10px 14px;
  font-size: 14px;
  line-height: 1.6;
  /* 440=ZCode 用户消息半档字重（比正文 400 略实，可变 Inter 才渲染得出） */
  font-weight: 440;
  color: var(--dsh-user-bubble-fg, #ffffff);
  box-shadow: 0 2px 8px var(--dsh-user-bubble-shadow, rgba(37, 99, 235, 0.28));
  white-space: pre-wrap;
  word-break: break-word;
}
/* 0909⑦改：插话待注入=用户气泡呼吸发光描边（替代旧"插话待注入…"琥珀小标），注入回显即熄灭 */
.dsh-user-bubble.steer-glow {
  animation: steerGlow 1.5s ease-in-out infinite;
}
/* ★ 0925aa（需求的"发送失败红叹号"）：失败气泡红边框提示（叹号在气泡左侧，点击重发） */
.dsh-user-bubble.send-failed {
  box-shadow: 0 0 0 1.5px rgba(239, 68, 68, 0.65);
}
/* ── 0914：用户消息编辑态（沿用气泡蓝底；textarea 透明取白字）── */
.user-edit-box {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 260px;
  /* ★ 0921：编辑态**撑满外层**（外层在编辑时加了 w-full = 82% 宽），长文本不再被挤成窄条 */
  width: 100%;
  box-sizing: border-box;
}
.user-edit-ta {
  width: 100%;
  background: transparent;
  border: none;
  outline: none;
  /* ★ 0921：去掉 `resize: vertical` —— 浏览器会在右下角画那个上下箭头手柄（反馈的"下拉条"），
     既不好看也跟气泡风格不搭。高度改成自适应 + 上限滚动。 */
  resize: none;
  color: #ffffff;
  font: inherit;
  font-weight: 440;
  line-height: 1.6;
  min-height: 48px;
  max-height: 40vh;
  overflow-y: auto;
  padding: 0;
  /* ★ 0924（反馈"编辑框那个滚动条很丑"）：
     ① 平时靠 fitEditTa() 自增高、**根本不出现滚动条**（到 40vh 上限才开始滚）；
     ② 万一要滚，也用细窄半透明的样式，别再露出系统默认那条灰白粗条。 */
  scrollbar-width: thin;
  scrollbar-color: rgba(255, 255, 255, 0.28) transparent;
}
.user-edit-ta::-webkit-scrollbar { width: 6px; }
.user-edit-ta::-webkit-scrollbar-track { background: transparent; }
.user-edit-ta::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.28);
  border-radius: 3px;
}
.user-edit-ta::-webkit-scrollbar-thumb:hover { background: rgba(255, 255, 255, 0.42); }
.user-edit-ta::placeholder { color: rgba(255, 255, 255, 0.55); }
/* ★ 0924（用户选 B）：编辑态**富文本区** —— 文本与图片胶囊混排（与底部输入框同观感） */
.user-edit-rich {
  width: 100%;
  min-height: 48px;
  max-height: 40vh;
  overflow-y: auto;
  color: #ffffff;
  font: inherit;
  font-weight: 440;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
  outline: none;
  /* 内容自然增高，平时不该出现滚动条；真要滚也是细窄半透明 */
  scrollbar-width: thin;
  scrollbar-color: rgba(255, 255, 255, 0.28) transparent;
}
.user-edit-rich::-webkit-scrollbar { width: 6px; }
.user-edit-rich::-webkit-scrollbar-track { background: transparent; }
.user-edit-rich::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, 0.28); border-radius: 3px; }
/* 空态占位（contenteditable 没有 placeholder，用 ::before 假装一个） */
.user-edit-rich[data-empty='true']::before {
  content: attr(data-placeholder);
  color: rgba(255, 255, 255, 0.55);
  pointer-events: none;
}
/* 内联图片胶囊（contenteditable=false 的原子节点）
   ★ 0924 修复：这些元素是 **JS 动态创建**的（document.createElement）——
   scoped 样式靠编译期给模板元素加的 `data-v-*` 属性匹配，动态元素**没有该属性** ⇒ 样式全部失效
   （现象：图片不显示成胶囊，而是两个"大白块"）。所以这里必须用 `:global()` 让它脱离 scoped 作用域。 */
:global(.edit-img-cap) {
  display: inline-flex;
  align-items: center;
  vertical-align: middle;
  margin: 0 2px;
  padding: 2px;
  border-radius: 9999px;
  background: rgba(0, 0, 0, 0.28);
  user-select: none;
}
:global(.edit-img-cap img) {
  width: 22px;
  height: 22px;
  object-fit: cover;
  border-radius: 9999px;
  border: 1px solid rgba(255, 255, 255, 0.35);
  display: block;
}
:global(.edit-img-x) {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  margin-left: 2px;
  border-radius: 9999px;
  color: rgba(255, 255, 255, 0.9);
  background: rgba(0, 0, 0, 0.35);
  opacity: 0;
  transition: opacity 0.15s;
  font-size: 8px;
  line-height: 1;
}
:global(.edit-img-cap:hover .edit-img-x) { opacity: 1; }
:global(.edit-img-x:hover) { background: rgba(0, 0, 0, 0.55); }
.user-edit-imgs {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  /* ★ 0924：附件区在文字上方 → 与正文之间留点间距 */
  margin-bottom: 6px;
}
/* ★ 0924：图片上的删除按钮（hover 才显，静态看着不乱） */
.user-edit-img-x {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  margin-left: 2px;
  border-radius: 9999px;
  color: rgba(255, 255, 255, 0.9);
  background: rgba(0, 0, 0, 0.35);
  opacity: 0;
  transition: opacity 0.15s;
  font-size: 8px;
  line-height: 1;
}
.user-edit-img-tag:hover .user-edit-img-x { opacity: 1; }
.user-edit-img-x:hover { background: rgba(0, 0, 0, 0.55); }
/* ★ 0921：编辑态图片 = 与正文一致的**标签胶囊**（小圆缩略图 + 深色底），
   不再是裸的 44px 方图（反馈"图片标签的样式也没了"）。 */
.user-edit-img-tag {
  display: inline-flex;
  align-items: center;
  padding: 2px;
  border-radius: 9999px;
  background: rgba(0, 0, 0, 0.28);
}
.user-edit-img-tag img {
  width: 22px;
  height: 22px;
  object-fit: cover;
  border-radius: 9999px;
  border: 1px solid rgba(255, 255, 255, 0.35);
  display: block;
}
.user-edit-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.user-edit-btn {
  font-size: 12px;
  padding: 3px 12px;
  border-radius: 8px;
  color: rgba(255, 255, 255, 0.9);
  background: rgba(255, 255, 255, 0.16);
  transition: background 0.15s ease;
}
.user-edit-btn:hover { background: rgba(255, 255, 255, 0.26); }
.user-edit-btn.is-primary {
  background: #ffffff;
  color: #1d4ed8;
  font-weight: 530;
}
.user-edit-btn.is-primary:hover { background: #f1f5ff; }
/* 0909⑦改：插话待注入=用户气泡呼吸发光描边（替代旧"插话待注入…"琥珀小标），注入回显即熄灭。
 * ★ 0925（反馈"两侧像被切断、边缘不柔和"）：外扩 box-shadow（0 0 22px 6px）会被消息流
 * 容器的 overflow-x:hidden（防横向滚动条的既有约束）横向裁掉 → 光晕出硬边。
 * 改为 **inset 内发光**（内描边 + 内晕都在元素内部绘制，永不依赖外部空间、不会被裁），
 * 呼吸语义不变；外投影只留原本那层 0 2px 8px。 */
@keyframes steerGlow {
  0%, 100% { box-shadow: 0 2px 8px rgba(37, 99, 235, 0.28), inset 0 0 0 1.5px rgba(96, 165, 250, 0.7), inset 0 0 10px 2px rgba(59, 130, 246, 0.35); }
  50% { box-shadow: 0 2px 8px rgba(37, 99, 235, 0.28), inset 0 0 0 2px rgba(147, 197, 253, 0.95), inset 0 0 22px 6px rgba(59, 130, 246, 0.55); }
}

/* 消息操作行：按钮 28px 圆形常显；统计/时间 hover 淡入（dsh MessageIconActions 语义） */
.msg-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 5px;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}
.msg-action:hover {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-secondary);
}
/* 0920：正在朗读这条回复 —— 图标呼吸（表达"还在念"） */
.msg-action.is-speaking {
  color: #6366f1;
  animation: msgSpeakPulse 1.4s ease-in-out infinite;
}
.msg-action.is-speaking:hover { background: var(--dsw-alias-interactive-bg-hover); }
@keyframes msgSpeakPulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}
@media (hover: hover) {
  [data-time-hover-root] .msg-time,
  [data-time-hover-root] .msg-stats {
    opacity: 0;
    transition: opacity 80ms ease;
  }
  [data-time-hover-root]:hover .msg-time,
  [data-time-hover-root]:focus-within .msg-time,
  [data-time-hover-root]:hover .msg-stats,
  [data-time-hover-root]:focus-within .msg-stats {
    opacity: 1;
  }
}

/* 图片悬停气泡 */
.img-pop-enter-active {
  transition: opacity 0.15s ease, transform 0.15s cubic-bezier(0.34, 1.56, 0.64, 1);
}
.img-pop-leave-active {
  transition: opacity 0.1s ease, transform 0.1s ease;
}
.img-pop-enter-from,
.img-pop-leave-to {
  opacity: 0;
  transform: translateY(6px) scale(0.92);
}

/* ── 左侧会话导航条（旧样式：一轮一格细线；0922z2d 还原 + 格数固定 ≤20 + 细滑动条）── */
.chat-nav {
  position: absolute;
  left: 8px;
  /* ★1010（老大截图反馈"位置有点靠下，能不能上移一点"）：原为 top: 50% 纯居中，
     视觉中心被下方输入框区拉低 ⇒ 整体上移 44px（改成 calc 便于后续微调）。 */
  top: calc(50% - 44px);
  transform: translateY(-50%);
  z-index: 20;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 3px;
  max-height: min(72vh, 560px);
  padding: 6px 2px;
  animation: chat-nav-in 0.3s ease-out;
}
@keyframes chat-nav-in {
  from { opacity: 0; transform: translateY(-50%) translateX(-6px); }
  to { opacity: 1; transform: translateY(-50%) translateX(0); }
}
.cn-slot {
  position: relative;
  display: flex;
  align-items: center;
  height: 12px;
  min-height: 6px;
  flex: 0 1 auto;
  padding: 0 2px;
  border: none;
  background: transparent;
  cursor: pointer;
}
.cn-tick { display: flex; align-items: center; }
.cn-line {
  display: block;
  height: 2px;
  width: 10px;
  border-radius: 9999px;
  background: #d1d5db;
  transition: width 0.18s cubic-bezier(0.2, 0.8, 0.2, 1), background 0.18s ease;
}
.cn-slot:hover .cn-line { width: 16px; background: #6b7280; }
.cn-slot:active .cn-line { width: 20px; background: #111827; }
.cn-slot-active .cn-line { width: 20px; background: #111827; }
.cn-slot-active:hover .cn-line { background: #111827; }
/* ★ 0922z2d3：导轨上下两端的"外面还有多少条"（超浅小字，跟刻度同一套语言） */
.cn-more {
  padding: 0 2px 0 3px;
  font-size: 10px;
  line-height: 12px;
  color: #b6bcc4;
  font-variant-numeric: tabular-nums;
  transition: color 0.18s ease;
}
.cn-more-top { margin-bottom: 2px; }
.cn-more-bottom { margin-top: 2px; }
.chat-nav:hover .cn-more { color: #8d94a0; }
html.dark .cn-more { color: #5b6472; }
/* ★ 0922z2d6（设计口径 a/b）：打开会话 = 整段一次性淡入（180ms）；
   期间历史过程块不各自播入场动画（500+ 块同时播正是"点开卡一下"的一部分） */
/* ★1012ba：反馈"一次性闪出来、没有渐显感" —— 原 `0.18s + 仅 opacity` 太快、缺过渡。
   改成 **0.42s + 轻微整体上浮**（整段一起动，不是逐条）⇒ 观感是从下方浮现。
   注：transform 只作用在容器上且动画结束后回到 none，不影响内部固定定位元素。 */
.fresh-open { animation: fresh-open-in 0.42s cubic-bezier(0.22, 1, 0.36, 1); }
.fresh-open :deep(.disclosure-animate) { animation: none !important; }
@keyframes fresh-open-in {
  from { opacity: 0; transform: translateY(10px); }
  to { opacity: 1; transform: none; }
}
/* ★1012az：需求要求"加载完对话时不要每条都动一下，改成渐显最新一屏全部内容"。
   上面那条 180ms 整段淡入就是"渐显"，但它此前**只抑制了 `.disclosure-animate`（过程块）**，
   消息行/工具块/思考块等其余逐条动画仍在各播一次 ⇒ 视觉上"每一条都动了一下"。
   这里把 fresh-open 期间**所有后代**的动画时长/延迟清零（用 duration:0s 而非 animation:none，
   避免影响依赖 animation 名的状态；fresh-open 只持续到"出现新节点/新一轮"为止，见 freshOpen 的 watch，
   不会干扰实时消息本该有的入场动画）。 */
.fresh-open :deep(*) { animation-duration: 0s !important; animation-delay: 0s !important; }
html.dark .chat-nav:hover .cn-more { color: #9ca3af; }
/* ★ 0922z2d2：鼠标沿导轨扫过时的"涟漪"—— 相邻刻度顺势变长变深（.cn-line 自带 0.18s transition） */
.cn-near1 .cn-line { width: 14px; background: #9aa1ab; }
.cn-near2 .cn-line { width: 12px; background: #c3c7cd; }
html.dark .cn-near1 .cn-line { background: #8b93a1; }
html.dark .cn-near2 .cn-line { background: #5b6472; }
/* ★ 0922z2d2：悬停卡片出入场动画（入场微右移淡入 / 离场快速淡出） */
.cn-pop-enter-active { transition: opacity 0.16s ease, transform 0.16s cubic-bezier(0.2, 0.8, 0.2, 1); }
.cn-pop-leave-active { transition: opacity 0.12s ease, transform 0.12s ease; }
.cn-pop-enter-from, .cn-pop-leave-to { opacity: 0; transform: translateX(-6px) translateY(-50%) scale(0.98); }html.dark .cn-line { background: #4b5563; }
html.dark .cn-slot:hover .cn-line { background: #9ca3af; }
html.dark .cn-slot-active .cn-line { background: #e5e7eb; }
/* 悬停缩略卡：v-show 控制显隐；向右浮出；无阴影，仅描边（原 bug 是 chat-nav overflow 裁掉了它）；
   入场动画随 display 切换重触发（淡入 + 右移 6px 归位，0903 交互打磨） */
.cn-card {
  position: absolute;
  left: 30px; /* ★ 0922z2c：原来 calc(100% + 10px) 依赖容器宽度，容器塌陷后卡片压住导轨 */
  top: 50%;
  /* ★ 0922z2d2：显式函数列表（配合出入场动画插值，避免 translate/translateY 混用跳位） */
  transform: translateX(0) translateY(-50%) scale(1);
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 240px;
  max-width: 40vw;
  padding: 9px 11px;
  background: #ffffff;
  border: 1px solid rgba(0, 0, 0, 0.12);
  border-radius: 12px;
  box-shadow: 0 10px 26px rgba(17, 24, 39, 0.13);
  pointer-events: none;
  text-align: left;
  z-index: 30;
}
@keyframes cn-card-in {
  from { opacity: 0; transform: translateY(-50%) translateX(-6px); }
  to { opacity: 1; transform: translateY(-50%) translateX(0); }
}
.cn-card-role {
  display: block;
  font-size: 12px;
  line-height: 1.35;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cn-card-user { color: #111827; font-weight: 530; }
.cn-card-ai { color: #6b7280; }
.cn-card-meta {
  margin-top: 2px;
  font-size: 10px;
  color: #9ca3af;
  font-variant-numeric: tabular-nums;
}

/* 窄屏（无足够左槽）时隐藏导航条，避免压住正文 */
@media (max-width: 1100px) {
  .chat-nav { display: none; }
}
</style><style scoped>
/* ★ 0922z2c：滚动区右下那个「回到最新消息」悬浮钮已删（设计口径：留输入框正上方那一个，避免两个入口做同一件事）。 */
.fade-enter-active, .fade-leave-active { transition: opacity 0.18s ease; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
</style>

<!--
  ★ 0920：文件 ↔ 变更面板双向高亮（**全局，故意不加 scoped**）

  这个 class 由 JS `classList.add('file-highlight-flash')` 打在两类元素上：
    · `[data-tool-path]`  → ToolPartBlock 的根 `.tool-row`（能拿到 PiChatView 的 scope id）
    · `[data-produced-path]` → ProducedFilesRow **内部的** `.dsh-produced-card`（拿不到）
  scoped 规则只对前者生效 ⇒ 产物卡的高亮其实一直是坏的。搬到这里两边一起管。

  效果分三段（设计口径）：① 文字加粗 → ② 文字转琥珀 → ③ 一道扫光划过。
  为什么不做"整块刷琥珀底"：一是跟"运行中/错误"的底色语义打架，
  二是块状高亮看不出到底在指哪个文件 —— 文字级更"指向"。
  10 秒后由 JS 摘 class（与原来一致），所以这里不必写淡出。
-->
<style>
.file-highlight-flash {
  position: relative;
  border-radius: 8px;
  /* 深浅两套色，keyframes 里用变量取值（keyframes 里没法写主题分支） */
  --fh-text: #b45309;
  --fh-sweep: rgba(251, 191, 36, 0.55);
}
html.dark .file-highlight-flash {
  --fh-text: #fcd34d;
  --fh-sweep: rgba(253, 224, 71, 0.34);
}

/* ① 加粗 → ② 变色 → ③ **光只从文字字形上走**（0921 二次修正）
   ★ 上一版把 `::after` 从行根元素挪到文字元素上，但 `.ws-file-name` 这类带 `flex-1`（占满整行宽），
     光带照样铺满一行 ⇒ 看起来仍是"块扫光"（实测："比上次强了，但还不符合"）。
   ⇒ 改抄 Think / 过程块那套（`DisclosureRow` 的 running 扫光）：`background-clip: text` 把渐变
     **裁到字形像素上**，文字以外全透明，于是光只从字上掠过。
   ★ 0921 再次修正（实测）：**只点"文件名"**，不要点拟人化文案 ——
     `.tool-summary`（"写入文件: …"）和 `.tool-status-persona`（"嗯，我在处理了.."）是口语化过程文案，
     给它们打高亮会让人以为"这行东西被改了"，所以从选择器里拿掉。
   ⚠️ `.persona-file-chip` 是**带底色的容器**——对它做 background-clip:text 会吃掉 chip 底色，
      所以只对它内部的文字 `.pfc-name` 做。 */
.file-highlight-flash :is(.pfc-name, .dsh-produced-name, .dsh-produced-ext, .ws-file-name) {
  background-image: linear-gradient(
    100deg,
    var(--fh-text) 0%,
    var(--fh-text) 35%,
    #fff 50%,
    var(--fh-text) 65%,
    var(--fh-text) 100%
  );
  background-size: 250% 100%;
  background-position: 150% 0;
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
  color: var(--fh-text); /* 兜底：万一不支持 background-clip:text 也能看到变色 */
  animation: file-hl-text 0.9s ease-out forwards,
    file-hl-sweep 1.4s cubic-bezier(0.4, 0, 0.2, 1) 0.75s 2 both;
}
@keyframes file-hl-text {
  25% { font-weight: 650; }
  60%, 100% { font-weight: 650; }
}
/* 光带滑过字形（与 Think 的 dsh-disclosure-text-sweep 同参数：150% → -60%） */
@keyframes file-hl-sweep {
  0% { background-position: 150% 0; }
  100% { background-position: -60% 0; }
}
/* ★ 0924（长会话滚动性能关键）：消息流"屏幕外免渲染"——
   `<template v-for>` 不产生 DOM ⇒ 每一组的根元素都是 `.chat-stream` 的直接子元素，
   所以一条规则就能覆盖 user / assistant / subagent / notice / 工具段 全部分支。
   效果：视口外的组跳过 style/layout/paint，只保留占位高度；浏览器随后记住实测高度不再跳动。
   ⚠️ 若将来有"依赖屏幕外元素真实尺寸"的定位逻辑（scrollTo 之外的自定义测量），需在此豁免。 */
.chat-stream > * {
  content-visibility: auto;
  contain-intrinsic-size: auto 320px;
}
/* ★ 0924（配套"填坑"）：临时**全量渲染**开关 —— 任何依赖"屏幕外元素真实尺寸"的操作
   （整页测量、长图/PDF 导出、需要精确高度的定位）都该包在 `withFullRender()` 里跑：
   它给 .chat-stream 加上 .force-render → 所有组立刻恢复真实渲染 → 操作完自动摘掉。
   也用于打印：下面 @media print 里直接强制可见，避免"没滚过的部分打印成空白"。 */
.chat-stream.force-render > * {
  content-visibility: visible !important;
  contain-intrinsic-size: auto;
}
@media print {
  .chat-stream > * { content-visibility: visible !important; }
}
/* ★ 0923（需求）：事件类通知（上下文压缩分隔线 / 重试提示）挪到"回复气泡之外" ——
   负 margin 抵消左侧头像列（32px 头像 + 12px gap = 44px = 2.75rem），
   让这一行横跨整组宽度，视觉上不再属于回复正文；重试提示因此不会被折叠行吞掉、一眼可见。 */
.msg-outer-row {
  position: relative;
  /* ★ 0923（需求）：异常/事件类提示**居中**显示 —— 原来只做了"横跨整组宽度"，
     但内容仍贴左，看着还是像挂在回复上；居中后才真正像"对话之外的状态条"。 */
  display: flex;
  justify-content: center;
}
.msg-outer-row--avatar {
  margin-left: -2.75rem;
  width: calc(100% + 2.75rem);
}
/* ★ 0923（需求）：折叠行标题里的"失败"统计 —— 红字 + 加粗，异常在折叠状态就能一眼看到 */
.proc-fail-note {
  color: var(--dsw-alias-state-error-primary, #ef4444);
}
.proc-fail-note b {
  font-weight: 650;
}

@media (prefers-reduced-motion: reduce) {
  .file-highlight-flash :is(.tool-summary, .tool-status-persona, .pfc-name, .dsh-produced-name, .dsh-produced-ext, .ws-file-name) {
    animation: none;
    background-position: 50% 0;
  }
}
</style>
