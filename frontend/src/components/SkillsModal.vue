<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { t } from '@/utils/i18n'
import { useSkillsStore } from '@/stores/skills'
import { parseSkillZip, parseDroppedSkill, extractInputText } from '@/utils/skillImport'
import { useNotificationsStore } from '@/stores/notifications'
import { useChatStore } from '@/stores/chat'
import { useProvidersStore } from '@/stores/providers'

import { useSettingsStore } from '@/stores/settings'
import BwSwitch from './BwSwitch.vue'
import HintTip from './blocks/HintTip.vue'

import { localStore } from '@/utils/localStore'

const props = defineProps<{
  open: boolean
}>()

const emit = defineEmits<{
  close: []
}>()

const skillsStore = useSkillsStore()
const notificationsStore = useNotificationsStore()
const chatStore = useChatStore()
const providersStore = useProvidersStore()

const settingsStore = useSettingsStore()

/* ── ★ 0921z：技能开关（需求要求：从设置页**搬到技能仓库**）──
 * 这里就是技能仓库存放"技能池"开关的地方：
 *   · 主开关 skillAutoSelect：关掉 → AI 不主动挑技能（技能清单不注入），手动 [skill:名称] 也拒绝；
 *   · 每个技能一个开关：停用后不进 AI 的可用清单。
 * 读写都走 settingsStore（localStorage + 后端 settings.update 同一路径，两端判定一致）；
 * 后端是权威，改完会广播 host/settings-updated 回来。
 * ⚠ 只有**后端技能**（id 前缀 sk_，即 backend/skills/ 里的真技能）才给开关 —— 本地仓库条目
 *   （skillsStore 的 zip/手工导入）不在 AI 技能池里，给开关是骗人的。 */
const skillAutoOn = computed(() => settingsStore.general.skillAutoSelect !== false)
function onToggleAutoSelect(v: boolean) {
  settingsStore.setSkillAutoSelect(v)
}
function isBackendSkill(id: string): boolean {
  return String(id || '').startsWith('sk_')
}
function skillOn(name: string): boolean {
  return settingsStore.isSkillEnabled(name)
}
function onToggleSkill(name: string, v: boolean) {
  settingsStore.setSkillEnabled(name, v)
}

const isAnimating = ref(false)
const isClosing = ref(false)
const showModal = ref(false)

watch(() => props.open, (val) => {
  if (val) {
    isClosing.value = false
    showModal.value = true
    isAnimating.value = true
    setTimeout(() => { isAnimating.value = false }, 450)
    // ⑤ 重开回到顶层：清掉内层浮层（"弹窗中的弹窗"不残留）
    noteEditOpen.value = false
    importOpen.value = false
    aiImportOpen.value = false
    deleteTarget.value = null
    loadBackendSkills()
  }
})

function close() {
  isClosing.value = true
  isAnimating.value = true
  setTimeout(() => {
    if (props.open && !isClosing.value) return  /*0927 netfix close-reopen-guard v3：正常关闭放行（isClosing 仍 true）；中途被重开（open watch 复位）则旧定时器作废 */
    showModal.value = false
    isAnimating.value = false
    isClosing.value = false
    emit('close')
  }, 300)
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key !== 'Escape' || !props.open) return
  // ⑤ 逐层关闭：先收内层浮层，无浮层时才关整个弹窗
  if (arOpen.value) { arOpen.value = false; return }   // ★1010g：Agent Reach 渠道弹窗
  if (deleteTarget.value) { deleteTarget.value = null; return }
  if (noteEditOpen.value) { noteEditOpen.value = false; return }
  if (importOpen.value) { importOpen.value = false; return }
  if (aiImportOpen.value) { aiImportOpen.value = false; return }
  close()
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
}

onMounted(() => {
  document.addEventListener('keydown', handleKeydown)
})

onUnmounted(() => {
  document.removeEventListener('keydown', handleKeydown)
})

const skills = computed(() => skillsStore.skills)
const activeFilter = ref('')

// ── 后端技能（skills/ 目录，bridge RPC skill.list 拉取）──
interface BackendSkill { name: string; description: string; builtin?: boolean }
const backendSkills = ref<BackendSkill[]>([])

// ── 技能备注（localStorage 持久化，name → 备注；显示时优先于描述）──
// 注意：ref(...) 的参数是"初始值"不是惰性工厂——传函数会让 .value 变成函数本身
// （此前 skillNotes.value 恒为函数 → noteOf() 恒空、saveNote 把 "undefined" 字符串
// 写进 localStorage 清空全部备注，SkillPicker/成员面板三处备注全灭的根因）
const skillNotes = ref<Record<string, string>>(loadNotesSafe())
function loadNotesSafe(): Record<string, string> {
  try {
    const raw = JSON.parse(localStore.getItem('nis-skill-notes') || '{}')
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  } catch { return {} }
}
const noteEditName = ref('')
const noteEditText = ref('')
const noteEditOpen = ref(false)

function openNoteEdit(name: string, current: string) {
  noteEditName.value = name
  noteEditText.value = current || ''
  noteEditOpen.value = true
}

function saveNote() {
  const n = noteEditText.value.trim()
  // 重新读盘合并：skillNotes 可能被其他入口（成员面板等）更新过，避免整写覆盖
  let merged: Record<string, string> = {}
  try {
    const raw = JSON.parse(localStore.getItem('nis-skill-notes') || '{}')
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) merged = raw
  } catch { /* 坏数据重置 */ }
  if (n) merged[noteEditName.value] = n
  else delete merged[noteEditName.value]
  skillNotes.value = merged
  localStore.setItem('nis-skill-notes', JSON.stringify(merged))
  noteEditOpen.value = false
}

function noteOf(name: string): string {
  return skillNotes.value[name] || ''
}

async function loadBackendSkills() {
  // 真实链路：bridge RPC skill.list → backend/skills/ 目录 SKILL.md
  try {
    const res = await chatStore.bridgeRpc('skill.list')
    if (Array.isArray(res?.skills)) backendSkills.value = res.skills
  } catch (e) {
    console.error('[Skills] load failed:', e)
  }
}

// 展示列表：后端技能（builtin=内置，imported=导入）+ 本地仓库技能（内置不可删）。
// description 保持技能自身描述，不再被备注覆盖（0904 反馈①：卡片要名称+备注+描述三者并存，此前备注挤掉描述只剩一个）。
const displaySkills = computed(() => {
  const backend = backendSkills.value.map(s => ({
    id: `sk_${s.name}`,
    name: s.name,
    description: s.description || '',
    builtin: !!s.builtin,
    source: (s.builtin ? 'builtin' : 'imported') as string,
    createdAt: 0,
  }))
  return [...backend, ...skills.value]
})

const filteredSkills = computed(() =>
  activeFilter.value ? displaySkills.value.filter(s => s.source === activeFilter.value) : displaySkills.value,
)

function sourceLabel(s: { source: string }): string {
  if (s.source === 'builtin') return t('skills.sourceManual')
  if (s.source === 'imported') return t('skills.importedLabel')
  return s.source === 'zip' ? t('skills.sourceZip') : t('skills.sourceManual')
}

function deleteSkill(id: string) {
  const s = displaySkills.value.find(x => x.id === id)
  if (!s || s.builtin) return
  deleteTarget.value = { id, name: s.name || id }
}

/* ── ★1010f：Agent Reach 渠道配置（点卡片或「编辑」打开）────────────────────
 * 清单直接渲染后端透传的 doctor --json；装/取 Cookie 走后端 RPC（server.ts 的 agentReach.*）。
 * 代理直发 settings.update（走设置白名单），不经 store 那套 patch 白名单。 */
const arOpen = ref(false)
const arChannels = ref<Record<string, any>>({})
const arLoading = ref(false)
const arBusy = ref<Record<string, boolean>>({})
const arMsg = ref('')
const arProxy = ref('')
const arSaving = ref(false)
/** 哪些渠道支持"从内置浏览器取 Cookie"（与后端 AR_PLATFORM 对齐） */
const arCookieable = ref<Record<string, boolean>>({ xiaohongshu: true, twitter: true, youtube: true })
/* ★1010j：OpenCLI 是 Reddit / Facebook / Instagram / 小红书 / Boss 的**共同后端**，
 * doctor 不把它单列成一个渠道（它只出现在这些渠道的 message 里）⇒ 这里汇总成一条提示。
 * 判据：message 里出现 Chrome 商店链接 = 扩展没装（比匹配中英文文案稳）。 */
const arOpenCli = computed(() => {
  const list = Object.values(arChannels.value) as any[]
  // ① message 里带商店链接 = 扩展没装
  for (const c of list) {
    const url = (/(https:\/\/chromewebstore\.google\.com\/\S+)/.exec(String(c?.message || '')) || [])[1]
    if (url) return { state: 'missing', missing: true, url }
  }
  // ② 有渠道说"桥接已连接" = OpenCLI 这条路通了。⚠ 此时**不需要**导 cookie：
  //    agent-reach 的文案会让人去用 Cookie-Editor，其实在**你自己的浏览器**里登录站点就够了。
  const ready = list.some(c => /桥接已连接|bridge.*connect/i.test(String(c?.message || '')))
  return { state: ready ? 'ready' : 'none', missing: false, url: '' }
})
function openArUrl(url: string) { if (url) window.open(url, '_blank') }
/* ★1010r：判据反过来 —— **只有它明确说"未安装"才给「安装」**，其余一律算已就绪。
   原判据只认"已安装"三个字，而实际文案五花八门：Exa 写"已写入 mcporter 配置"、
   Reddit 写"桥接已连接"、twitter 写"已安装但没有完整凭据" ⇒ 全被误判成没装
   （实测：点安装还真跑一遍，装完又显示"安装"）。 */
const arNeedsInstall = (c: any): boolean =>
  /未安装|not installed|未找到|not found|no such|missing/i.test(String(c?.message || ''))
/* ★1010p：浏览器切换 —— OpenCLI 的 Browser Bridge 能同时连多个浏览器
   （NIS 内置浏览器、外部 Edge 各算一条 profile），这里给个下拉直接切。 */
const arProfiles = ref<any[]>([])
const arProfileId = ref('')
/* ★1010t：真状态探测 —— doctor 给的是**快照**（它自己写着"不做实时验证 / 不能仅凭配置宣称可用"），
   点「测一下」真跑一条平台只读命令（opencli <site> whoami）：成功=真能用，失败=真不能用（带人话原因）。 */
const arProbe = ref<Record<string, any>>({})
const arCanProbe = (c: any): boolean => /opencli/i.test((c?.backends || []).join(' '))
async function probeAr(key: string) {
  arProbe.value = { ...arProbe.value, [key]: { loading: true } }
  try {
    const r: any = await chatStore.bridgeRpc('agentReach.probe', { channel: key })
    arProbe.value = { ...arProbe.value, [key]: r || { ok: false, hint: '无返回' } }
  } catch (e: any) {
    arProbe.value = { ...arProbe.value, [key]: { ok: false, hint: String(e?.message || e) } }
  }
}
const arProbeOf = (key: string): any => arProbe.value[key] || null
/* ★1010s：面板降噪（用户："显示的太乱、跟实际不符、会误导用户"）——
 * doctor 的 message 是写给工程师的（常带命令行教程、半截话），16 条全铺出来用户看不懂。
 * 分组只认**真正的缺件信号**（未安装 / 未找到 / 未发现 / 不可达 / 失败 / 缺少 / 需要 <英文工具名>）；
 * ⚠ 刻意**不把"登录/凭据/未验证"当缺件** —— 那是所有 OpenCLI 渠道的共性，由顶部绿条统一说明
 * （否则 reddit 与 facebook 文案几乎一样却被分到两个组，正是"跟实际不符"）。
 * message 只显示**第一句**（结论句），原文留给 hover。 */
const arActionable = (c: any): boolean =>
  arNeedsInstall(c) || /未找到|未发现|不可达|失败|缺少|missing|unavailable|需要\s*[A-Za-z0-9_.\-]/.test(String(c?.message || ''))
const arShowOk = ref(false)
const arFirstLine = (c: any): string => String(c?.message || '').split('\n')[0].trim()
const arList = computed(() => {
  const todo: any[] = [], ready: any[] = []
  for (const [key, c] of Object.entries(arChannels.value) as [string, any][]) {
    (arActionable(c) ? todo : ready).push({ key, c, ready: false })
  }
  return { all: [...todo, ...ready.map(it => ({ ...it, ready: true }))], todoCount: todo.length, readyCount: ready.length }
})
async function loadArProfiles(verbose = false) {
  try {
    const r: any = await chatStore.bridgeRpc('agentReach.profiles', {})
    if (r?.ok) {
      arProfiles.value = r.profiles || []
      if (!arProfileId.value && arProfiles.value.length) arProfileId.value = arProfiles.value[0].id
    } else if (verbose) arMsg.value = String(r?.error || '读不到浏览器列表')
  } catch (e: any) { if (verbose) arMsg.value = String(e?.message || e) }
}
async function useArProfile(id: string) {
  if (!id) return
  try {
    const r: any = await chatStore.bridgeRpc('agentReach.useProfile', { id })
    arMsg.value = r?.ok ? `已切到 ${id}` : String(r?.out || '切换失败')
  } catch (e: any) { arMsg.value = String(e?.message || e) }
  void loadAr()
}
const isAr = (skill: any) => String(skill?.name || '') === 'agent-reach'
function onCardClick(skill: any) { if (isAr(skill)) void openAr() }
async function openAr() {
  arOpen.value = true
  arMsg.value = ''
  try {
    const r: any = await chatStore.bridgeRpc('settings.get', {})
    arProxy.value = String(r?.settings?.agentReachProxy || '')
  } catch { /* 设置读不到就让用户自己填 */ }
  void loadAr()
  void pollArJobs()   // ★1010h：打开时先看有没有在后端跑着的安装任务（关过弹窗也不丢）
  void loadArProfiles()   // ★1010p：顺便读一次"现在连了哪些浏览器"
}
/** 带超时的 RPC —— doctor 首次要 20~60 秒；万一 RPC 永不返回，也要把"读取中"收掉 */
function withTimeout<T>(p: Promise<T>, ms: number, tag: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(tag)), ms))])
}
async function loadAr(fresh = false) {
  arLoading.value = true
  arMsg.value = fresh ? '正在重扫（约 20~60 秒）…' : '读取中…'
  try {
    const r: any = await withTimeout(chatStore.bridgeRpc('agentReach.channels', { fresh }), 90000, '读取超时——渠道探测太慢，稍后再试或点「重扫」')
    if (r?.ok) {
      arChannels.value = r.channels || {}
      arMsg.value = `共 ${Object.keys(r.channels || {}).length} 个渠道${r.cached ? `（缓存 ${r.ageSec} 秒前）` : ''}`
    } else arMsg.value = String(r?.error || '读取失败')
  } catch (e: any) { arMsg.value = String(e?.message || e) } finally { arLoading.value = false }
}
/* ★1010h：安装改成后端任务 + 轮询 —— 关弹窗/关面板都不丢状态，且能看到输出尾部 */
const arJobs = ref<Record<string, any>>({})
let arPollTimer: any = null
const arJobOf = (key: string): any => Object.values(arJobs.value).find((j: any) => j.channel === key && j.running)
/* ★1010i：进度显示用的小格式化（字节 / 阶段文案） */
function fmtBytes(n: number): string {
  if (!n) return ''
  const u = ['B', 'KB', 'MB', 'GB']
  let i = 0, v = n
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++ }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)}${u[i]}`
}
const arStageLabel = (s: string) =>
  s === 'download' ? t('skills.arStageDownload') : s === 'install' ? t('skills.arStageInstall') : s === 'done' ? t('skills.arStageDone') : t('skills.arStagePrep')
function stopArPolling() { if (arPollTimer) { clearInterval(arPollTimer); arPollTimer = null } }
function ensureArPolling() { if (!arPollTimer) arPollTimer = setInterval(() => { void pollArJobs() }, 2000) }
async function pollArJobs() {
  if (!arOpen.value) { stopArPolling(); return }   // ★1010h：弹窗关了就别轮询（后端任务照跑）
  try {
    const r: any = await chatStore.bridgeRpc('agentReach.jobs', {})
    const list: any[] = r?.jobs || []
    const map: Record<string, any> = {}
    for (const j of list) map[j.jobId] = j
    arJobs.value = map
    if (list.some(j => j.running)) ensureArPolling()
    else { stopArPolling(); void loadAr(true) }   // 刚跑完 ⇒ 刷新渠道状态
  } catch { /* 轮询失败忽略，下轮再来 */ }
}
async function arInstall(key: string) {
  arMsg.value = `正在安装 ${key}…（进度在后端，关掉弹窗也不会丢）`
  try {
    const r: any = await chatStore.bridgeRpc('agentReach.install', { channel: key })
    if (r?.ok === false) { arMsg.value = String(r?.error || '启动安装失败'); return }
    await pollArJobs()
    ensureArPolling()
  } catch (e: any) { arMsg.value = String(e?.message || e) }
}
async function arCookie(key: string) {
  arBusy.value = { ...arBusy.value, [key]: true }
  try {
    const r: any = await chatStore.bridgeRpc('agentReach.cookies', { platform: key })
    arMsg.value = r?.ok ? `已写入 ${r.cookies} 条 Cookie` : String(r?.error || '取 Cookie 失败')
  } catch (e: any) { arMsg.value = String(e?.message || e) }
  finally { arBusy.value = { ...arBusy.value, [key]: false }; void loadAr() }
}
async function saveArProxy() {
  arSaving.value = true
  try {
    await chatStore.bridgeRpc('settings.update', { settings: { agentReachProxy: arProxy.value.trim() } })
    arMsg.value = '代理已保存'
  } catch (e: any) { arMsg.value = String(e?.message || e) } finally { arSaving.value = false }
}

async function confirmDeleteSkill() {
  const target = deleteTarget.value
  if (!target) return
  deleteTarget.value = null
  if (target.id.startsWith('sk_')) {
    // 后端导入技能 → 真实删除文件（install.uninstall RPC）
    try {
      await chatStore.bridgeRpc('install.uninstall', { name: target.name, type: 'skill' })
      backendSkills.value = backendSkills.value.filter(b => b.name !== target.name)
      await loadBackendSkills()
    } catch (e: any) {
      // ★0929：失败不再静默——旧实现只 console.error，用户点删除列表又回来却毫无提示
      console.error('[SkillsModal] uninstall failed:', e)
      notificationsStore.pushSystem({
        title: t('skills.deleteFailed') || '技能删除失败',
        message: String(e?.message || e || ''),
        category: 'agent',
      })
      await loadBackendSkills()
    }
    return
  }
  skillsStore.removeSkill(target.id)
}

// ── 导入（zip / 文件夹拖拽，自动识别解析）──
const importOpen = ref(false)
const importMsg = ref('')
/** 删除技能确认（系统内弹窗，替代浏览器 confirm） */
const deleteTarget = ref<{ id: string; name: string } | null>(null)
const fileInputRef = ref<HTMLInputElement | null>(null)
const dropActive = ref(false)

function triggerFile() {
  fileInputRef.value?.click()
}

function onFileSelected(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  if (file.name.toLowerCase().endsWith('.zip')) {
    file.arrayBuffer().then(buf => {
      const p = parseSkillZip(buf, file.name)
      if (!p) return finishImportError()
      finishImport(p, 'zip')
    })
  } else {
    // 用户可能选了 SKILL.md 或 md 文件
    const reader = new FileReader()
    reader.onload = () => {
      const text = String(reader.result || '')
      const fm = text.match(/^---\s*\n([\s\S]*?)\n---/)
      const name = fm && fm[1].match(/^\s*name\s*:\s*(.+)$/m)?.[1].trim().replace(/^["']|["']$/g, '')
      if (!name) return finishImportError()
      finishImport({ name, description: fm![1].match(/^\s*description\s*:\s*(.+)$/m)?.[1].trim().replace(/^["']|["']$/g, '') || '' }, 'zip')
    }
    reader.readAsText(file)
  }
}

function finishImport(parsed: { name: string; description: string }, source: 'zip') {
  const skill = skillsStore.addSkill({
    name: parsed.name,
    description: parsed.description,
    source,
  })
  importMsg.value = ''
  importOpen.value = false
  notificationsStore.pushSystem({
    title: t('skills.importOk'),
    message: parsed.name,
    category: 'agent',
  })
  void skill
}

function finishImportError() {
  importMsg.value = t('skills.importParseError')
}

// 拖拽导入：文件夹 / zip 均可，webkitGetAsEntry 自动识别目录
function onDrop(e: DragEvent) {
  dropActive.value = false
  const dt = e.dataTransfer
  if (!dt || !dt.items) return
  const item = dt.items[0]
  const entry = (item as any).webkitGetAsEntry?.() || null
  if (entry) {
    const fallback = entry.name || '未命名技能'
    parseDroppedSkill(entry, fallback).then(parsed => {
      if (!parsed) return finishImportError()
      finishImport(parsed, 'zip')
    })
  } else if (dt.files?.length) {
    const f = dt.files[0]
    if (/\.zip$/i.test(f.name)) {
      f.arrayBuffer().then(buf => {
        const p = parseSkillZip(buf, f.name)
        if (!p) return finishImportError()
        finishImport(p, 'zip')
      })
    }
  }
}

// ── AI 导入：上传/拖入文件 或 命令行 → 后端 LLM 分析 → 生成技能入库 ──
const aiImportOpen = ref(false)
const aiImportMsg = ref('')
const aiBusy = ref(false)
const aiDropActive = ref(false)
const aiFileInputRef = ref<HTMLInputElement | null>(null)

const aiCommand = ref('')
const addingSkill = ref(false)
/** 本次 AI 导入成功的技能名（列表显示红点，8s 后消失） */
const newSkillName = ref('')

function closeAiImport() {
  aiImportOpen.value = false
}

// Tauri 环境：虚线框点击 → 系统原生选择器（文件/文件夹/zip 均可，多选）
const isTauri = !!(window as any).__TAURI_INTERNALS__

async function triggerAiFile() {
  if (isTauri) {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const sel = await open({ multiple: true, directory: true })
      if (!sel) return
      const paths = Array.isArray(sel) ? sel : [sel]
      if (paths.length) sendAiPaths(paths)
      return
    } catch {
      /* fallthrough: 浏览器回退 input */
    }
  }
  aiFileInputRef.value?.click()
}

function sendAiPaths(paths: string[]) {
  if (!chatStore.wsConnected) {
    aiImportMsg.value = t('skills.aiNoBackend')
    return
  }
  // 后台执行：立即关弹窗，列表显示占位卡
  aiImportOpen.value = false
  aiBusy.value = true
  aiImportMsg.value = ''
  addingSkill.value = true
  const handler = (msg: any) => {
    if (msg.type !== 'SKILL_AI_IMPORT_RESULT') return
    chatStore.offMessage(handler)
    aiBusy.value = false
    addingSkill.value = false
    finishAiImport(msg)
  }
  chatStore.onMessage(handler)
  // 2026-09-12：AI 导入统一走「后台模型」（后端解析）。未配后台模型 → 直接报错，不再静默缺省。
  if (!providersStore.extractModel()) {
    chatStore.offMessage(handler)
    aiBusy.value = false
    addingSkill.value = false
    aiImportMsg.value = t('extract.noGlobalModel')
    return
  }
}

/** AI 导入结果统一处理：成功 → 通知 + 红点 + 刷新；失败 → 通知错误 + 弹窗内提示 */
function finishAiImport(msg: any) {
  if (msg.ok) {
    newSkillName.value = msg.name || ''
    setTimeout(() => { if (newSkillName.value === (msg.name || '')) newSkillName.value = '' }, 8000)
    notificationsStore.pushSystem({
      title: t('skills.aiImportOkTitle'),
      message: t('skills.aiImportOkMsg', { name: msg.name || '' }),
      type: 'success',
      category: 'agent',
      actions: [{ id: 'view', label: t('skills.view') }],
      meta: { panel: 'skills' },
    })
    loadBackendSkills()
  } else {
    notificationsStore.pushSystem({
      title: t('skills.aiImportFailTitle'),
      message: msg.msg || t('skills.importFail'),
      type: 'error',
      category: 'error',
    })
    aiImportMsg.value = msg.msg || t('skills.importFail')
  }
}

function startAiCommandImport() {
  const cmd = aiCommand.value.trim()
  if (!cmd) {
    aiImportMsg.value = t('skills.aiNeedCommand')
    return
  }
  sendAiImport(cmd, 'command')
}

function sendAiImport(content: string, mode = 'text') {
  if (!chatStore.wsConnected) {
    aiImportMsg.value = t('skills.aiNoBackend')
    return
  }
  if (!content.trim()) {
    aiImportMsg.value = t('skills.aiEmptyContent')
    return
  }
  // 后台执行：立即关弹窗，列表显示占位卡
  aiImportOpen.value = false
  aiBusy.value = true
  aiImportMsg.value = ''
  addingSkill.value = true
  const handler = (msg: any) => {
    if (msg.type !== 'SKILL_AI_IMPORT_RESULT') return
    chatStore.offMessage(handler)
    aiBusy.value = false
    addingSkill.value = false
    finishAiImport(msg)
  }
  chatStore.onMessage(handler)
  // 2026-09-12：AI 分析统一走「后台模型」（后端解析）。未配后台模型 → 直接报错，不再静默缺省。
  if (!providersStore.extractModel()) {
    chatStore.offMessage(handler)
    aiBusy.value = false
    addingSkill.value = false
    aiImportMsg.value = t('extract.noGlobalModel')
    return
  }
}

function onAiFileSelected(e: Event) {
  const input = e.target as HTMLInputElement
  const files = input.files
  input.value = ''
  if (!files || !files.length) return
  // 文件夹（webkitdirectory 多文件）→ 拼接文本；单文件 → 直接提取（含 zip）
  if (files.length > 1 || (files[0] as any).webkitRelativePath) {
    collectDirFiles(files).then(text => {
      if (text) sendAiImport(text)
      else aiImportMsg.value = t('skills.aiNoTextFile')
    })
    return
  }
  extractInputText(files[0]).then(text => sendAiImport(text))
}

async function collectDirFiles(files: FileList): Promise<string> {
  const parts: string[] = []
  let total = 0
  for (const f of Array.from(files)) {
    if (total >= 8000) break
    if (f.size > 200_000) continue
    try {
      const text = await new Promise<string>((res) => {
        const r = new FileReader()
        r.onload = () => res(String(r.result || ''))
        r.onerror = () => res('')
        r.readAsText(f)
      })
      if (text) {
        parts.push(`=== ${(f as any).webkitRelativePath || f.name} ===\n${text}`)
        total += text.length
      }
    } catch {
      /* skip */
    }
  }
  return parts.join('\n\n').slice(0, 8000)
}

function onAiDrop(e: DragEvent) {
  aiDropActive.value = false
  const dt = e.dataTransfer
  if (!dt) return
  const item = dt.items?.[0]
  if (item && (item as any).webkitGetAsEntry) {
    const entry = (item as any).webkitGetAsEntry()
    if (entry) {
      extractInputText(entry).then(text => sendAiImport(text))
      return
    }
  }
  const f = dt.files?.[0]
  if (f) extractInputText(f).then(text => sendAiImport(text))
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="showModal"
      :class="['fixed inset-0 z-40 bg-black/30', isClosing ? 'backdrop-fade-out' : 'backdrop-fade-in']"
    ></div>

    <div v-if="showModal" class="fixed inset-0 z-50 flex items-start justify-center pt-[8vh]">
      <div class="relative flex flex-col items-center">
        <div
          :class="['dock-modal', isAnimating && !isClosing ? 'dock-in' : '', isClosing ? 'dock-out' : '']"
          class="relative w-[957px] max-w-[94vw] h-[82vh] bg-white rounded-[20px] shadow-[0_24px_70px_-20px_rgba(0,0,0,0.25)] border-[1.5px] border-gray-200 overflow-hidden flex flex-col"
        >
          <div class="px-7 pt-6 pb-4 flex items-start justify-between gap-4">
            <div class="min-w-0">
              <h2 class="text-base font-bold text-gray-900 tracking-tight">{{ t('skills.warehouse') }}</h2>
              <!-- ★ 0921z：技能池开关已从「设置 → 通用」搬到这里（需求要求：开关跟着技能走） -->
              <p class="text-[11px] text-gray-400 mt-1">{{ t('skills.poolHint') }}</p>
            </div>
            <div class="flex items-center gap-2 shrink-0 pt-0.5">
              <span class="text-[12px] text-gray-700">{{ t('settings.general.skillAuto') }}</span>
              <HintTip :text="t('settings.general.skillAutoHint')" />
              <BwSwitch :model-value="skillAutoOn" @update:model-value="onToggleAutoSelect" />
            </div>
          </div>

          <!-- 主开关关闭：明确告知"下面的逐项开关此刻不生效"，避免用户以为是坏的 -->
          <div v-if="!skillAutoOn" class="mx-7 mb-3 px-3.5 py-2 rounded-xl bg-amber-50 border border-amber-200 text-[11.5px] text-amber-700 flex items-start gap-2">
            <i class="fas fa-triangle-exclamation mt-[2px]"></i>
            <span>{{ t('skills.autoSelectOffTip') }}</span>
          </div>

          <!-- 0915：去掉来源筛选 tab（用户要求）。此前四个 tab 里有两个都写成「内置」（文案 bug），
               而且仓库本来就该是一个列表，没有分组筛选的必要。 -->
          <div class="border-b-[1.5px] border-gray-100"></div>

          <div class="flex-1 min-h-0 px-7 py-6 overflow-y-auto custom-scroll">
            <div class="grid grid-cols-2 gap-3 items-start">
            <!-- AI 导入中：占位卡排在最前（#7 分析阶段立即可见） -->
            <div v-if="addingSkill" class="bg-white rounded-[20px] pt-[18px] px-[18px] pb-[16px] shadow-sm border border-gray-100 flex flex-col">
              <div class="flex items-start gap-3">
                <div class="w-10 h-10 rounded-full bg-gray-100 text-gray-600 flex items-center justify-center shrink-0">
                  <i class="fas fa-cube text-lg"></i>
                </div>
                <div class="flex-1 min-w-0">
                  <div class="flex items-center gap-1.5 flex-wrap">
                    <span class="text-sm font-[640] text-gray-500">{{ t('skills.aiAnalyzing') }}</span>
                    <span class="text-[10px] px-2 py-0.5 rounded-full font-[640] bg-amber-50 text-amber-600 border border-amber-200">{{ t('skills.importedLabel') }}</span>
                  </div>
                  <div class="text-xs text-gray-400 mt-1">{{ t('skills.aiAnalyzingDesc') }}</div>
                </div>
              </div>
              <div class="mt-3 flex items-center justify-between">
                <span class="text-xs text-gray-400"><i class="fas fa-circle-notch fa-spin mr-1 text-gray-500"></i>{{ t('skills.analyzing') }}</span>
                <span class="text-xs text-gray-400"><i class="fas fa-wand-magic-sparkles mr-1 text-gray-300"></i>{{ t('skills.aiGenerated') }}</span>
              </div>
            </div>
            <div v-for="skill in filteredSkills" :key="skill.id" @click="onCardClick(skill)" :class="['bg-white rounded-[20px] pt-[18px] px-[18px] pb-[16px] shadow-sm hover:shadow-[0_12px_32px_-12px_rgba(0,0,0,0.2)] hover:-translate-y-0.5 transition-all duration-200 border border-gray-100 flex flex-col h-[172px]', isAr(skill) ? 'cursor-pointer' : '']">
              <div class="flex items-start gap-3">
                <div class="w-10 h-10 rounded-full bg-gray-100 text-gray-600 flex items-center justify-center shrink-0">
                  <i class="fas fa-cube text-lg"></i>
                </div>
                <div class="flex-1 min-w-0 min-h-0 flex flex-col">
                  <div class="flex items-center gap-1.5 flex-wrap">
                    <span class="text-sm font-[640] text-gray-900">{{ skill.name }}</span>
                    <span v-if="skill.name === newSkillName" class="w-2 h-2 rounded-full bg-red-500" :title="t('skills.newImport')"></span>
                    <span :class="['text-[10px] px-2 py-0.5 rounded-full font-[640]', skill.source === 'zip' ? 'bg-green-50 text-green-600 border border-green-200' : skill.source === 'builtin' ? 'bg-purple-50 text-purple-600 border border-purple-200' : skill.source === 'imported' ? 'bg-amber-50 text-amber-600 border border-amber-200' : 'bg-blue-50 text-blue-600 border border-blue-200']">
                      {{ sourceLabel(skill) }}
                    </span>
                  </div>
                  <!-- 备注：与简介并存独立一行（0904 反馈①）；两行截断，悬停 title 看完整 -->
                  <div v-if="noteOf(skill.name)" class="text-xs text-gray-600 mt-1 line-clamp-2" :title="noteOf(skill.name)">{{ noteOf(skill.name) }}</div>
                  <!-- 简介：固定卡高下 flex-1 占满剩余 + line-clamp 兜底截断（0904 反馈：卡片等高、超长缩略悬停看全）；悬停 title 看完整 -->
                  <div class="text-xs text-gray-500 mt-1 flex-1 min-h-0 line-clamp-3" :title="skill.description || t('skills.noDesc')">{{ skill.description || t('skills.noDesc') }}</div>
                </div>
              </div>
              <div class="flex items-center gap-2 mt-auto pt-3">
                <!-- ★ 0921z：单技能启停（只给后端技能；本地仓库条目不在 AI 技能池里） -->
                <template v-if="isBackendSkill(skill.id)">
                  <BwSwitch
                    :model-value="skillOn(skill.name)"
                    @update:model-value="(v: boolean) => onToggleSkill(skill.name, v)"
                  />
                  <span class="text-[11px]" :class="skillOn(skill.name) ? 'text-gray-500' : 'text-gray-400'">
                    {{ skillOn(skill.name) ? t('skills.stateOn') : t('skills.stateOff') }}
                  </span>
                </template>
                <div class="flex-1"></div>
                <button @click.stop="openNoteEdit(skill.name, noteOf(skill.name))" class="btn btn-secondary btn-xs">{{ noteOf(skill.name) ? t('skills.editNote') : t('skills.addNote') }}</button>
                <!-- ★1010f：agent-reach 是可配置技能 —— 不给「删除」（删了整包就没了），改给「编辑」打开渠道配置弹窗 -->
                <button v-if="isAr(skill)" @click.stop="openAr()" class="btn btn-secondary btn-xs">{{ t('skills.edit') }}</button>
                <button v-else-if="!skill.builtin" @click.stop="deleteSkill(skill.id)" class="btn btn-danger btn-xs">{{ t('skills.delete') }}</button>
              </div>
            </div>
            <div v-if="!filteredSkills.length && !addingSkill" class="py-10 text-center text-xs text-gray-400 col-span-2">{{ t('skills.empty') }}</div>
            </div>
          </div>
        </div>

        <button
          @click="close"
          :class="['close-btn', isAnimating && !isClosing ? 'close-in' : '', isClosing ? 'close-out' : '']"
          class="w-9 h-9 flex items-center justify-center bg-white border border-gray-200 text-gray-400 hover:text-gray-600 hover:shadow-md rounded-full shadow-sm mt-4"
        >
          <i class="fas fa-times text-sm"></i>
        </button>
      </div>
    </div>

    <!-- 导入 skill 弹窗（zip / 文件夹拖拽） -->
    <div v-if="importOpen" class="fixed inset-0 z-[9999] bg-black/30 flex items-center justify-center" @click.self="importOpen = false">
      <div class="w-[460px] bg-white rounded-2xl shadow-2xl p-6">
        <div class="text-[15px] font-[640] text-gray-900 mb-1">{{ t('skills.importTitle') }}</div>
        <p class="text-xs text-gray-400 mb-4">{{ t('skills.importHint') }}</p>
        <div
          class="rounded-xl border-2 border-dashed p-6 text-center cursor-pointer transition-colors"
          :class="dropActive ? 'border-indigo-400 bg-indigo-50/60' : 'border-gray-200 hover:border-indigo-400 hover:bg-indigo-50/40'"
          @click="triggerFile"
          @dragover.prevent="dropActive = true"
          @dragleave="dropActive = false"
          @drop.prevent="onDrop"
        >
          <i class="fas fa-file-arrow-up text-2xl text-gray-300 mb-2 block"></i>
          <span class="text-xs text-gray-500">{{ dropActive ? t('skills.dropHere') : t('skills.importClick') }}</span>
        </div>
        <div class="mt-3 flex items-center justify-center gap-4">
          <span class="text-[11px] text-gray-400"><i class="fas fa-folder text-gray-300 mr-1"></i>{{ t('skills.dropFolder') }}</span>
          <span class="text-[11px] text-gray-400"><i class="fas fa-file-archive text-gray-300 mr-1"></i>{{ t('skills.dropZip') }}</span>
        </div>
        <p v-if="importMsg" class="text-xs text-red-500 mt-3">{{ importMsg }}</p>
        <input ref="fileInputRef" type="file" accept=".zip,.md" class="hidden" @change="onFileSelected" />
      </div>
    </div>

    <!-- AI 导入弹窗：点击/拖入 或 命令行 → AI 分析生成技能 -->
    <div v-if="aiImportOpen" class="fixed inset-0 z-[9999] bg-black/30 flex items-center justify-center" @click.self="closeAiImport">
      <div class="w-[460px] bg-white rounded-2xl shadow-2xl p-6">
        <div class="text-[15px] font-[640] text-gray-900 mb-1">{{ t('skills.aiImportTitle') }}</div>
        <p class="text-xs text-gray-400 mb-4">{{ t('skills.aiImportHint') }}</p>
        <div
          class="rounded-xl border-2 border-dashed p-6 text-center cursor-pointer transition-colors"
          :class="aiDropActive ? 'border-gray-400 bg-gray-50' : 'border-gray-200 hover:border-gray-400 hover:bg-gray-50'"
          @click="triggerAiFile"
          @dblclick.prevent="triggerAiFile"
          @dragover.prevent="aiDropActive = true"
          @dragleave="aiDropActive = false"
          @drop.prevent="onAiDrop"
        >
          <template v-if="aiBusy">
            <div class="flex items-center justify-center gap-2">
              <i class="fas fa-circle-notch fa-spin text-lg text-gray-900"></i>
              <span class="text-xs text-gray-700">{{ t('skills.aiBusyHint') }}</span>
            </div>
          </template>
          <template v-else>
            <i class="fas fa-wand-magic-sparkles text-2xl text-gray-300 mb-2 block"></i>
            <span class="text-xs text-gray-500">{{ aiDropActive ? t('skills.dropToImport') : t('skills.clickToSelect') }}</span>
          </template>
        </div>
        <div class="mt-3 border-t border-gray-100 pt-3">
          <input
            v-model="aiCommand"
            type="text"
            :placeholder="t('skills.aiCmdPlaceholder')"
            class="w-full bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 text-xs text-gray-800 outline-none focus:border-gray-400 focus:ring-2 focus:ring-gray-100"
            @keyup.enter="startAiCommandImport"
          />
          <button
            :disabled="aiBusy"
            class="mt-2 w-full text-xs py-2 rounded-lg bg-gray-900 text-white font-[530] hover:bg-black disabled:opacity-40 transition-colors"
            @click="startAiCommandImport"
          ><i class="fas fa-terminal mr-1 text-[11px]"></i>{{ t('skills.cmdImport') }}</button>
        </div>
        <p v-if="!aiBusy && aiImportMsg" class="text-xs mt-3" :class="aiImportMsg.includes('已导入') ? 'text-green-600' : 'text-red-500'">{{ aiImportMsg }}</p>
        <input ref="aiFileInputRef" type="file" class="hidden" @change="onAiFileSelected" />
      </div>
    </div>

    <!-- 技能备注编辑弹窗 -->
    <div v-if="noteEditOpen" class="fixed inset-0 z-[9999] bg-black/30 flex items-center justify-center" @click.self="noteEditOpen = false">
      <div class="w-[400px] bg-white rounded-2xl shadow-2xl p-6">
        <div class="text-[15px] font-[640] text-gray-900 mb-1">{{ t('skills.noteTitle') }} · {{ noteEditName }}</div>
        <p class="text-xs text-gray-400 mb-4">{{ t('skills.noteHint') }}</p>
        <textarea
          v-model="noteEditText"
          rows="3"
          class="w-full bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 text-xs text-gray-800 outline-none focus:border-gray-400 resize-none"
          :placeholder="t('skills.notePlaceholder')"
        ></textarea>
        <div class="mt-4 flex items-center justify-end gap-2">
          <button class="btn btn-secondary btn-md" @click="noteEditOpen = false">{{ t('skills.cancel') }}</button>
          <button class="btn btn-primary btn-md" @click="saveNote">{{ t('skills.save') }}</button>
        </div>
      </div>
    </div>
  </Teleport>

  <!-- 删除技能确认（系统内弹窗） -->
  <Teleport to="body">
    <div v-if="deleteTarget" class="fixed inset-0 z-[10010] flex items-center justify-center bg-black/40" @click.self="deleteTarget = null">
      <div class="w-[340px] bg-white rounded-2xl shadow-2xl p-6">
        <h3 class="text-[15px] font-[640] text-gray-800 mb-2">{{ t('skills.deleteSkillTitle') }}</h3>
        <p class="text-[13px] text-gray-500 leading-relaxed mb-5">{{ t('skills.deleteSkillConfirm', { name: deleteTarget.name }) }}</p>
        <div class="flex justify-end gap-2">
          <button class="btn btn-secondary btn-sm" @click="deleteTarget = null">{{ t('skills.cancel') }}</button>
          <button class="btn btn-danger btn-sm" @click="confirmDeleteSkill">{{ t('skills.delete') }}</button>
        </div>
      </div>
    </div>
    <!-- ★1010f：Agent Reach 渠道配置（点技能卡片或「编辑」打开）——
         渠道清单直接渲染它自己的 doctor --json（status/name/message/backends），不另写映射层 -->
    <div v-if="arOpen" class="fixed inset-0 z-[10010] flex items-center justify-center bg-black/40" @click.self="arOpen = false">
      <div class="w-[600px] max-h-[80vh] overflow-y-auto custom-scroll bg-white dark:bg-gray-800 rounded-2xl shadow-2xl p-6">
        <h3 class="text-[15px] font-[640] text-gray-800 dark:text-gray-100 mb-1">Agent Reach · {{ t('skills.arTitle') }}</h3>
        <p class="text-[12px] text-gray-500 dark:text-gray-400 mb-4">{{ t('skills.arHint') }}</p>

        <div class="flex items-center gap-2 mb-3">
          <span class="text-[12px] text-gray-600 dark:text-gray-300 shrink-0">{{ t('skills.arProxy') }}</span>
          <input v-model="arProxy" class="flex-1 px-2.5 py-1.5 text-[12px] border border-gray-200 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 rounded-lg" placeholder="http://127.0.0.1:7897" />
          <button class="btn btn-secondary btn-xs shrink-0" :disabled="arSaving" @click="saveArProxy">{{ t('skills.arSave') }}</button>
        </div>

        <div class="flex items-center gap-2 mb-2">
          <button class="btn btn-secondary btn-xs shrink-0" :disabled="arLoading" @click="loadAr(true)">{{ arLoading ? t('skills.arLoading') : t('skills.arRescan') }}</button>
          <span v-if="arMsg" class="text-[11px] text-gray-500 dark:text-gray-400 flex-1 truncate" :title="arMsg">{{ arMsg }}</span>
        </div>

        <!-- ★1010j：OpenCLI 是 Reddit/FB/IG/小红书/Boss 的共同后端（doctor 不单列它）⇒ 这里汇总一条 -->
        <div v-if="arOpenCli.state === 'missing'" class="flex items-center gap-2 px-3 py-2 mb-2 rounded-xl bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800">
          <i class="fas fa-puzzle-piece text-amber-500 text-[12px]"></i>
          <span class="text-[11px] text-amber-700 dark:text-amber-300 flex-1">{{ t('skills.arOpenCliTip') }}</span>
          <button class="btn btn-secondary btn-xs shrink-0" @click="openArUrl(arOpenCli.url)">{{ t('skills.arOpenCliGet') }}</button>
        </div>
        <!-- ★1010k：桥接已连上时说明"怎么才算能用"（agent-reach 自己的文案会误导人去导 cookie） -->
        <div v-else-if="arOpenCli.state === 'ready'" class="flex items-center gap-2 px-3 py-2 mb-2 rounded-xl bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800">
          <i class="fas fa-plug text-emerald-500 text-[12px]"></i>
          <span class="text-[11px] text-emerald-700 dark:text-emerald-300 flex-1">{{ t('skills.arOpenCliReady') }}</span>
          <!-- ★1010p：走哪个浏览器切换（NIS 内置浏览器 / 外部 Edge 各是一条 profile） -->
          <select v-if="arProfiles.length" v-model="arProfileId" @change="useArProfile(arProfileId)"
                  :title="t('skills.arProfileTip')"
                  class="text-[10px] px-1.5 py-1 rounded border border-emerald-200 dark:border-emerald-700 bg-white dark:bg-gray-700 dark:text-gray-100 shrink-0 max-w-[140px]">
            <option v-for="p in arProfiles" :key="p.id" :value="p.id">{{ p.id }}</option>
          </select>
        </div>

        <!-- ★1010s：两组 —— 「需要你处理」排前面，「已就绪」默认折叠（原来 16 条全铺，用户看着乱） -->
        <div class="flex items-center gap-2 mb-1.5">
          <span class="text-[11px] font-[560] text-gray-600 dark:text-gray-300">{{ t('skills.arTodoGroup', { n: arList.todoCount }) }}</span>
          <div class="flex-1"></div>
          <button class="text-[11px] text-gray-500 dark:text-gray-400 hover:text-gray-700" @click="arShowOk = !arShowOk">
            {{ arShowOk ? '▾' : '▸' }} {{ t('skills.arReadyGroup', { n: arList.readyCount }) }}
          </button>
        </div>
        <div v-for="it in arList.all" :key="it.key" v-show="!it.ready || arShowOk" class="px-3 py-2 rounded-xl bg-gray-50 dark:bg-gray-700/40 mb-1.5">
          <div class="flex items-center gap-2">
            <span :class="['w-2 h-2 rounded-full shrink-0', it.c.status === 'ok' ? 'bg-green-500' : it.c.status === 'warn' ? 'bg-amber-400' : 'bg-gray-300']"></span>
            <span class="text-[12px] font-[560] text-gray-800 dark:text-gray-100 truncate">{{ it.c.name }}</span>
            <span class="text-[10px] text-gray-400 truncate flex-1">{{ (it.c.backends || []).join(' / ') }}</span>
            <!-- ★1010r：只有它明确说"未安装"才给「安装」按钮，否则显示「已就绪」 -->
            <button v-if="arNeedsInstall(it.c)" class="btn btn-secondary btn-xs shrink-0" :disabled="!!arJobOf(it.key)" @click="arInstall(it.key)">{{ arJobOf(it.key) ? t('skills.arWorking') : t('skills.arInstall') }}</button>
            <span v-else class="text-[10px] text-gray-400 shrink-0 px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-700">{{ t('skills.arInstalled') }}</span>
            <button v-if="arCookieable[it.key]" class="btn btn-secondary btn-xs shrink-0" :disabled="!!arBusy[it.key] || !!arJobOf(it.key)" @click="arCookie(it.key)">{{ t('skills.arCookie') }}</button>
            <!-- ★1010t：真状态探测（doctor 只是快照，它自己写着"不做实时验证"） -->
            <button v-if="arCanProbe(it.c)" class="btn btn-secondary btn-xs shrink-0" :disabled="!!arProbeOf(it.key)?.loading" @click="probeAr(it.key)">{{ arProbeOf(it.key)?.loading ? t('skills.arProbing') : t('skills.arProbe') }}</button>
          </div>
          <!-- ★1010h/i：任务跑在后端 —— 阶段 + 进度条 + 字节/网速（悬停看输出尾部），关掉弹窗再回来也还在 -->
          <div v-if="arJobOf(it.key)" class="mt-1.5" :title="String(arJobOf(it.key).tail || '').trim().split('\n').slice(-3).join('\n')">
            <div class="h-1.5 rounded-full bg-gray-200 dark:bg-gray-600 overflow-hidden">
              <div class="h-full bg-amber-400 transition-all duration-500"
                   :class="arJobOf(it.key).percent < 0 ? 'animate-pulse' : ''"
                   :style="{ width: (arJobOf(it.key).percent >= 0 ? arJobOf(it.key).percent : 25) + '%' }"></div>
            </div>
            <div class="text-[10px] text-gray-500 dark:text-gray-400 mt-0.5 truncate">
              {{ arStageLabel(arJobOf(it.key).stage) }}
              <span v-if="arJobOf(it.key).percent >= 0"> {{ Math.round(arJobOf(it.key).percent) }}%</span>
              <span v-if="arJobOf(it.key).totalBytes"> · {{ fmtBytes(arJobOf(it.key).bytes) }}/{{ fmtBytes(arJobOf(it.key).totalBytes) }}</span>
              <span v-if="arJobOf(it.key).speedBps"> · {{ fmtBytes(arJobOf(it.key).speedBps) }}/s</span>
              <span v-if="arJobOf(it.key).etaSec > 0"> · 剩 {{ arJobOf(it.key).etaSec }}s</span>
              <span class="text-gray-400"> · {{ arJobOf(it.key).secs }}s</span>
            </div>
          </div>
          <!-- ★1010t：探测结果（点了「测一下」才有；真跑过才显示，不猜） -->
          <div v-if="arProbeOf(it.key) && !arProbeOf(it.key).loading" class="text-[10px] mt-1 truncate"
               :class="arProbeOf(it.key).ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-500'"
               :title="String(arProbeOf(it.key).out || arProbeOf(it.key).err || '')">
            {{ arProbeOf(it.key).ok ? t('skills.arProbeOk') : t('skills.arProbeFail') }}
            <span v-if="arProbeOf(it.key).hint"> · {{ arProbeOf(it.key).hint }}</span>
            <span v-else-if="arProbeOf(it.key).ms"> · {{ arProbeOf(it.key).ms }}ms</span>
          </div>
          <!-- ★1010s：只显示结论句（第一句），全文 hover 看 —— 它的原文常带命令行教程，铺出来是噪音 -->
          <div class="text-[10px] text-gray-500 dark:text-gray-400 mt-1 truncate" :title="it.c.message">{{ arFirstLine(it.c) }}</div>
        </div>

        <div class="flex justify-end mt-4">
          <button class="btn btn-secondary btn-sm" @click="arOpen = false">{{ t('skills.arClose') }}</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.backdrop-fade-in { animation: backdropFadeIn 0.3s ease forwards; }
.backdrop-fade-out { animation: backdropFadeOut 0.3s ease forwards; }
@keyframes backdropFadeIn { from { opacity: 0; } to { opacity: 1; } }
@keyframes backdropFadeOut { from { opacity: 1; } to { opacity: 0; } }

.dock-in { animation: dockExpand 0.45s cubic-bezier(0.34, 1.6, 0.64, 1) forwards; }
.dock-out { animation: dockCollapse 0.3s cubic-bezier(0.4, 0, 0.2, 1) forwards; }
@keyframes dockExpand {
  0% { opacity: 0; transform: scale(0.05) rotateX(8deg) translateY(-20px); transform-origin: top left; filter: blur(4px); }
  50% { opacity: 1; filter: blur(0); }
  70% { transform: scale(1.02) rotateX(-1deg) translateY(0); }
  100% { opacity: 1; transform: scale(1) rotateX(0) translateY(0); filter: blur(0); }
}
@keyframes dockCollapse {
  0% { opacity: 1; transform: scale(1) rotateX(0) translateY(0); filter: blur(0); }
  100% { opacity: 0; transform: scale(0.05) rotateX(8deg) translateY(-20px); transform-origin: top left; filter: blur(4px); }
}

.close-in { animation: closeBtnIn 0.5s cubic-bezier(0.34, 1.6, 0.64, 1) 0.3s both; }
.close-out { animation: closeBtnOut 0.2s cubic-bezier(0.4, 0, 1, 1) both; }
@keyframes closeBtnIn {
  0% { opacity: 0; transform: translateY(40px); }
  60% { opacity: 1; transform: translateY(-6px); }
  100% { transform: translateY(0); }
}
@keyframes closeBtnOut {
  0% { opacity: 1; transform: translateY(0); }
  100% { opacity: 0; transform: translateY(40px); }
}
</style>
