<script setup lang="ts">
/* 0915 重写：首次启动引导（8 页 · 沉浸版）——
   ① 欢迎（含主题）② 我是 Nis，你想叫我什么~ ③ 你想让我怎么称呼你~ ④ 你想让我怎么和你沟通（三个预设按钮）
   ⑤ 你想让我把东西放在哪？（存储目录）⑥ 检查运行环境（扫描依赖 + 一键安装）
   ⑦ 连接模型供应商 ⑧ 一切就绪（点「开始使用」→ logo 飞向左上角 → 衔接进主界面）。
   背景 = 开屏同款紫色粒子球（OrbitalSphere）；仅逐页「跳过」（不设一键全跳过）；
   第 2 页起有「上一步」；数据各归各 store；完成/走完 → closeOnboarding() 落标记。
   0917：新增 ⑤⑥ 两页（插在供应商页之前）。 */
import { ref, computed, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { storeToRefs } from 'pinia'
import gsap from 'gsap'
import { useSettingsStore } from '@/stores/settings'
import { useProvidersStore, DEFAULT_PROVIDERS } from '@/stores/providers'
import { useChatStore } from '@/stores/chat'
import { closeOnboarding } from '@/utils/onboarding'
import { localStore } from '@/utils/localStore'
import WindowControls from './blocks/WindowControls.vue'
import DataBackupDialog from './blocks/DataBackupDialog.vue'
import { playJellyOutro } from '@/utils/bootOutro'
import { t } from '@/utils/i18n'
import OrbitalSphere from './orbital/OrbitalSphere.vue'
import BwSeg from './BwSeg.vue'
import MiniSelect from './blocks/MiniSelect.vue'
import DirPickerModal from './blocks/DirPickerModal.vue'

const settingsStore = useSettingsStore()
const providersStore = useProvidersStore()
const chatStore = useChatStore()
/* apiKey 是按「当前激活供应商」存取的 computed —— 必须经 storeToRefs 写回 */
const { apiKey: activeApiKey } = storeToRefs(providersStore)

/* ── 主题（跟随应用；欢迎页切换时实时联动） ── */
const isDark = ref(document.documentElement.classList.contains('dark'))
let themeMo: MutationObserver | null = null

/* ── 根/特效元素 ── */
const rootEl = ref<HTMLElement | null>(null)
const doneLogoEl = ref<HTMLImageElement | null>(null)
const flying = ref(false)

/* ── 0917 收尾交接：果冻弹跳 → 沉没 → 涟漪幕布 → 界面长出（与开屏同源） ── */
const bgGone = ref(false)
const wait = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms))

/* ── 步骤编排（8 页；0917 在供应商前插入 storage / envcheck 两页） ── */
const STEPS = ['welcome', 'nisName', 'userName', 'persona', 'storage', 'envcheck', 'provider', 'done'] as const

/* ★1010（老大）：第一页「我们认识吗」—— 之前用过 NIS 的人可以直接导入数据包，
   导入成功即结束引导（跳过后面的名字/人设/存储/环境/供应商）；没历史数据就走原引导。 */
const needRestart = ref(false)      // 导入完成 → 提示需要重启
const importNote = ref('')          // 后端带回的备注（例如"这个包不含供应商密钥"）
const restartBusy = ref(false)
const importOpen = ref(false)
const importFile = ref('')
const importBusy = ref(false)
const importPicker = ref(false)

/** 选数据包：桌面端用系统对话框，网页端回落应用内的 DirPickerModal（与设置页同款顺序：先选包） */
async function pickImportFile(): Promise<void> {
  importBusy.value = true
  try {
    if ((window as any).__TAURI_INTERNALS__) {
      try {
        const { open } = await import('@tauri-apps/plugin-dialog')
        const picked = await open({ multiple: false, filters: [{ name: 'NIS Data', extensions: ['gz', 'tgz'] }] })
        if (picked) {
          importFile.value = String(picked)
          importOpen.value = true
        }
        return
      } catch { /* 对话框不可用 → 回落内置选择器 */ }
    }
    importPicker.value = true
  } finally {
    importBusy.value = false
  }
}
function onImportFilePicked(picked: string): void {
  if (!picked) return
  importFile.value = picked
  importOpen.value = true
}
/** 导入走完 → **直接结束引导进主界面**（老大 1010 实测："导入完了，还是在这个界面"——
   期望是"导完就能用"，所以不再要求多点一次按钮）。中间那些设置项（名字/人设/存储/环境/供应商）
   一并跳过：数据都从包里回来了，这几步没有意义。
   另留一条可事后核查的记录（写进 data/ui-state.json，排查"导入到底成没成功"用）。 */
function onImportDone(r: { mode: 'export' | 'import'; parts?: any[] }): void {
  if (r.mode !== 'import') return
  const okParts = (r.parts || []).filter((x: any) => x?.ok).map((x: any) => x?.label).filter(Boolean)
  try {
    localStore.setItem('nis-onboard-import-at', String(Date.now()))
    localStore.setItem('nis-onboard-import-parts', okParts.join('|') || '(none)')
    void localStore.flushNow()
  } catch { /* 记录失败不影响主流程 */ }
  /* 后端在 parts[].note 里带了关键备注 —— 尤其"这个包不含供应商密钥"这句：
     用户勾了「设置」却没填导出口令时包里不会带密钥，不说明他会反复怀疑自己点错了。 */
  const rawNote = String((r.parts || []).find((x: any) => x?.id === 'settings')?.note || '')
  importNote.value = /不含供应商密钥|no provider keys/i.test(rawNote) ? rawNote : ''
  console.log('[onboarding] 导入完成；已解出部分:', okParts.join('、') || '(无)', '| note:', importNote.value || '(无)')
  /* ★1010（老大实测："导入后直接进去了，但是是空的，我重启 NIS 才出现内容"）：
     导入的数据要**重启应用**才会被后端重新加载（这会切到新数据目录/新内核）——
     所以这里弹一个明确的「需要重启」提示，用户点「立即重启」就把应用重启掉，
     点「稍后」则先进主界面（下次自己在设置里导也能看到同样的提示）。
     复用 0918 就定好的 restart_app 命令（先退旧进程、2 秒后由 cmd 拉起，端口原样复用）。 */
  needRestart.value = true
}

/** 「立即重启」：调 Tauri 的 restart_app（真重启整个应用） */
async function doRestart(): Promise<void> {
  restartBusy.value = true
  try {
    if ((window as any).__TAURI_INTERNALS__) {
      const core = await import('@tauri-apps/api/core')
      await core.invoke('restart_app')
    } else {
      window.location.reload()
    }
  } catch (e) {
    console.warn('[onboarding] restart_app failed:', e)
    restartBusy.value = false
  }
}
/** 「稍后」：进主界面，不再打扰 */
function laterRestart(): void {
  void closeOnboarding()
}
type Step = (typeof STEPS)[number]
const stepIdx = ref(0)
const step = computed<Step>(() => STEPS[stepIdx.value])
/* 逐页跳过：nisName ~ provider 可跳（首尾两页不显示） */
const showSkip = computed(() => stepIdx.value >= 1 && stepIdx.value <= STEPS.length - 2)
const showPrev = computed(() => stepIdx.value >= 1 && step.value !== 'done')

/* ── ① 欢迎：界面主题（即时生效） ── */
const themeDraft = ref<string>(settingsStore.appearance.themeMode || '浅色')
function onThemePick(v: string) {
  themeDraft.value = v
  settingsStore.setAppearance('themeMode', v as never)
}

/* ── ② 我的名字（默认 Nis） ── */
const nisNameDraft = ref(settingsStore.persona.nisName === 'Nis' ? '' : settingsStore.persona.nisName)
const nisNameEl = ref<HTMLInputElement | null>(null)
function commitNisName() {
  settingsStore.setPersona('nisName', nisNameDraft.value.trim() || 'Nis')
}

/* ── ③ 怎么称呼你（默认 老板） ── */
const userNameDraft = ref(
  settingsStore.general.userName === '用户' || settingsStore.general.userName === '老板' ? '' : settingsStore.general.userName,
)
const userNameEl = ref<HTMLInputElement | null>(null)
function commitUserName() {
  settingsStore.setGeneral('userName', userNameDraft.value.trim() || '老板')
}

/* ── ④ 沟通方式（三个预设按钮，选择后下一步写入） ── */
const personaPresets = computed(() => [
  {
    id: 'warm',
    title: t('onboarding.persona.warm'),
    prompt: '简洁、直接，先给结论再给细节；做事主动、有主见，但不替用户拍板；语气自然亲切，不说客套话。',
  },
  {
    id: 'pro',
    title: t('onboarding.persona.pro'),
    prompt: '严谨、精确，注重细节与流程；执行前先确认关键信息，输出结构化、可复核；语气克制专业。',
  },
  {
    id: 'fun',
    title: t('onboarding.persona.fun'),
    prompt: '语气轻松幽默，偶尔开点小玩笑；但正事上清醒靠谱，该严谨时绝不含糊。',
  },
])
const personaPick = ref<string>(() => {
  const cur = settingsStore.persona.prompt
  if (!cur) return 'warm'
  const hit = personaPresets.value.find(p => p.prompt === cur)
  return hit?.id || ''
})
function commitPersona() {
  const p = personaPresets.value.find(x => x.id === personaPick.value)
  if (p) settingsStore.setPersona('prompt', p.prompt)
}

/* ── ⑤ 供应商 ── */
const providerList = DEFAULT_PROVIDERS
const pidSel = ref('')
const keyDraft = ref('')
const showKey = ref(false)
type ConnState = 'idle' | 'connecting' | 'ok' | 'fail'
const connState = ref<ConnState>('idle')
const connMsg = ref('')
const modelId = ref('')

const selProvider = computed(() => providerList.find(p => p.id === pidSel.value) || null)
const modelOptions = computed(() => {
  if (!pidSel.value) return []
  return (providersStore.models[pidSel.value] || [])
    .filter(m => providersStore.modelType(pidSel.value, m.id) === 'text')
    .map(m => ({ value: m.id, label: providersStore.modelName(pidSel.value, m.id) || m.id }))
})

function pickProvider(id: string) {
  if (pidSel.value === id) return
  pidSel.value = id
  connState.value = 'idle'
  connMsg.value = ''
  keyDraft.value = ''
  modelId.value = ''
}
function hideLogo(e: Event) {
  const el = e.target as HTMLImageElement
  el.style.display = 'none'
}

async function connect() {
  if (!pidSel.value || !keyDraft.value.trim() || connState.value === 'connecting') return
  const pid = pidSel.value
  connState.value = 'connecting'
  connMsg.value = ''
  try {
    providersStore.selectProvider(pid)
    activeApiKey.value = keyDraft.value.trim()
    const p = providersStore.providers.find(x => x.id === pid)
    if (p && !p.enabled) {
      const okEn = providersStore.toggleProviderEnabled(pid)
      if (!okEn) {
        connState.value = 'fail'
        connMsg.value = t('onboarding.provider.limit')
        return
      }
    }
    const r = await providersStore.fetchModels(pid)
    if (!r.ok) {
      connState.value = 'fail'
      connMsg.value = r.msg || t('onboarding.provider.fetchFail')
      return
    }
    const list = (providersStore.models[pid] || []).filter(m => providersStore.modelType(pid, m.id) === 'text')
    if (!list.length) {
      connState.value = 'fail'
      connMsg.value = t('onboarding.provider.noModel')
      return
    }
    modelId.value = list[0].id
    if (!list[0].enabled) providersStore.toggleModelEnabled(pid, modelId.value)
    providersStore.setExtractModel(modelId.value, pid)
    connState.value = 'ok'
    connMsg.value = t('onboarding.provider.ok')
  } catch (e: any) {
    connState.value = 'fail'
    connMsg.value = String(e?.message || e).slice(0, 120)
  }
}
function onModelPick(v: string) {
  if (!pidSel.value) return
  modelId.value = v
  const mm = (providersStore.models[pidSel.value] || []).find(m => m.id === v)
  if (mm && !mm.enabled) providersStore.toggleModelEnabled(pidSel.value, v)
  providersStore.setExtractModel(v, pidSel.value)
}

/* ── ⑤（0917）存储目录 —— 对应「设置 → 通用 → 存储目录」 ── */
const storagePicker = ref(false)
const storagePathDraft = ref(String(settingsStore.storagePath || ''))

/** 规范化：转正斜杠、去尾部分隔符（与设置页记录的风格一致） */
function normDir(p: string) {
  return String(p || '').trim().replace(/\\/g, '/').replace(/\/+$/, '')
}
/** 提交存储目录：**只改存储目录本身**。
 *  ★ 0921d：不再自动把「环境安装目录」指向它下面的 env 子目录 ——
 *  实测事故（用户 0921）：storagePath=`…\Documents\NisData` 会把 envDir 写成 `…\Documents\NisData\env`（空目录），
 *  而 Chromium 内核 / 记忆 venv 实际在 `<数据根>/env` ⇒ 软件环境页显示"未安装"、点启动必失败。
 *  现在环境目录**留空 = 后端默认 `<数据根>/env`**（数据在哪，环境就在哪），与存储目录彻底解耦。 */
function commitStorage() {
  const p = normDir(storagePathDraft.value)
  if (!p) return
  storagePathDraft.value = p
  if (p !== normDir(settingsStore.storagePath)) settingsStore.setStoragePath(p)
}
function onStoragePicked(path: string) {
  storagePathDraft.value = normDir(path)
}
/** 环境目录预览：`留空` = 由后端按 `<数据根>/env` 决定（与存储目录解耦，见 commitStorage 注释） */
const envDirPreview = computed(() => settingsStore.general.envDir || t('settings.general.envDirHint'))

/* ── ⑥（0917）运行环境检测：扫依赖 + 按 mustC 规则安装 ── */
interface EnvRow {
  id: string
  name: string
  desc: string
  icon: string
  installed: boolean
  version: string
  /** true = 该安装器不支持自定义位置（已在后端按 winget manifest 判定），只能装 C 盘 */
  mustC: boolean
  sizeBytes: number
  /** 0917：应用自带（如 node.exe）——不需要用户装，UI 标「自带」而不是「安装」 */
  bundled?: boolean
  state: 'idle' | 'installing' | 'done' | 'error'
}
/* 展示顺序：常用运行时在前，只能装 C 盘的随后 */
const ENV_DEFS: Array<{ id: string; icon: string; key: string; desc: string }> = [
  { id: 'node', icon: 'fab fa-node-js', key: 'envNode', desc: 'envNodeDesc' },
  { id: 'python', icon: 'fab fa-python', key: 'envPython', desc: 'envPythonDesc' },
  { id: 'npm', icon: 'fas fa-cube', key: 'envNpm', desc: 'envNpmDesc' },
  // 0917 新增：记忆检索模型（语义检索）——与设置页同一项
  { id: 'embed', icon: 'fas fa-brain', key: 'envEmbed', desc: 'envEmbedDesc' },
  { id: 'git', icon: 'fab fa-git-alt', key: 'envGit', desc: 'envGitDesc' },
  // ★1010-D：Git Bash —— 与设置页同一项（0917「两处清单不同步」教训：加项必须两处一起）
  { id: 'gitbash', icon: 'fas fa-terminal', key: 'envGitbash', desc: 'envGitbashDesc' },
  { id: 'chromium', icon: 'fas fa-globe', key: 'envChromium', desc: 'envChromiumDesc' },
  { id: 'pwsh', icon: 'fas fa-terminal', key: 'envPwsh', desc: 'envPwshDesc' },
]
const envRows = ref<EnvRow[]>([])
const envScanned = ref(false)
const envScanning = ref(false)
const envAllRunning = ref(false)
const envBusyLabel = ref('')
const envErr = ref('')

// 0917：应用自带的（node）不算「缺失」——它不需要用户装
const missingCount = computed(() => envRows.value.filter(r => !r.installed && !r.bundled).length)
const allReady = computed(() => envScanned.value && missingCount.value === 0)

function fmtSize(n: number): string {
  if (!n) return '—'
  if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB'
  if (n < 1024 * 1024 * 1024) return Math.round(n / 1024 / 1024) + ' MB'
  return (n / 1024 / 1024 / 1024).toFixed(1) + ' GB'
}

/** 一键扫描：拉后端 env.status（真实探测 pwsh / node / git / python / chromium） */
async function scanEnv() {
  if (envScanning.value || envAllRunning.value) return
  envScanning.value = true
  envErr.value = ''
  try {
    const r: any = await chatStore.bridgeRpc('env.status', {})
    envRows.value = ENV_DEFS.map((d): EnvRow => {
      const s = (r && r[d.id]) || {}
      return {
        id: d.id,
        name: t('settings.general.' + d.key),
        desc: t('settings.general.' + d.desc),
        icon: d.icon,
        installed: !!s.installed,
        version: String(s.version || ''),
        mustC: !!s.mustC,
        sizeBytes: Number(s.sizeBytes || 0),
        bundled: !!s.bundled,
        source: (s.source as 'bundled' | 'nis' | 'system') || undefined,   // ★ 0921d：来源标识
        state: 'idle',
      }
    })
    envScanned.value = true
  } catch (e: any) {
    envErr.value = String(e?.message || e).slice(0, 140)
  } finally {
    envScanning.value = false
  }
}

/** 安装单项：起后端任务 + 轮询 env.job（后端同一时刻只允许一个任务 → 调用方须串行） */
async function installEnvItem(id: string): Promise<void> {
  const row = envRows.value.find(r => r.id === id)
  if (!row || row.state === 'installing') return
  row.state = 'installing'
  envErr.value = ''
  try {
    const r: any = await chatStore.bridgeRpc('env.install', { id })
    if (!r?.ok || !r.jobId) throw new Error(String(r?.error || '无法启动安装任务'))
    const t0 = Date.now()
    // 0917：与后端上限对齐（语义检索模型要装依赖 + 下模型，10 分钟不够 → 45 分钟）
    while (Date.now() - t0 < 45 * 60 * 1000) {
      await new Promise((res) => window.setTimeout(res, 2000))
      const j: any = await chatStore.bridgeRpc('env.job', { jobId: r.jobId })
      const st = j?.job?.status
      if (st === 'done') {
        row.state = 'done'
        row.installed = true
        return
      }
      if (st === 'error') throw new Error(String(j?.job?.error || '安装失败'))
    }
    throw new Error('安装超时（45 分钟）')
  } catch (e: any) {
    row.state = 'error'
    envErr.value = t('onboarding.envcheck.failedOne', { name: row.name })
  }
}

/** 一键安装缺失项：串行（后端环境任务互斥），带进度文案 */
async function installAllMissing() {
  if (envAllRunning.value) return
  const list = envRows.value.filter(r => !r.installed && !r.bundled)
  if (!list.length) return
  envAllRunning.value = true
  envErr.value = ''
  try {
    for (let i = 0; i < list.length; i++) {
      envBusyLabel.value = t('onboarding.envcheck.installingN', { name: list[i].name, n: i + 1, total: list.length })
      await installEnvItem(list[i].id)
    }
  } finally {
    envBusyLabel.value = ''
    envAllRunning.value = false
  }
}

/* ── 导航（逐页跳过 = 不写入当前页，直接下一页） ── */
function goIdx(i: number) {
  stepIdx.value = Math.min(Math.max(i, 0), STEPS.length - 1)
  void nextTick(() => {
    if (step.value === 'nisName') nisNameEl.value?.focus()
    if (step.value === 'userName') userNameEl.value?.focus()
  })
}
function next() {
  const cur = step.value
  if (cur === 'nisName') commitNisName()
  else if (cur === 'userName') commitUserName()
  else if (cur === 'persona') commitPersona()
  else if (cur === 'storage') commitStorage()
  goIdx(stepIdx.value + 1)
}
function skipPage() {
  if (step.value === 'provider' && connState.value === 'connecting') return
  goIdx(stepIdx.value + 1)
}
function prev() {
  goIdx(stepIdx.value - 1)
}

/* ── ⑥ 收尾（0917 重做，用户定稿）：果冻弹跳 → 钻进水里沉没 → 涟漪扩散成白/黑幕布 → 界面长出。
   与开屏收尾共用 utils/bootOutro.playJellyOutro，两处观感一致。
   原来的「骨架层 + logo 飞向左上角 + 组件上弹」整套删掉 —— 侧栏 logo 的归位由「界面长出」自然带出。 ── */
async function startUse() {
  if (flying.value) return
  flying.value = true
  // 幕布颜色跟随当前实际主题
  isDark.value = document.documentElement.classList.contains('dark')
  gsap.ticker.lagSmoothing(0)
  try {
    /* 1) 先把除 logo 外的文字内容淡掉（弹跳阶段画面要干净）；
       粒子球/暗角**不在这里淡**——交给收尾动画一起淡出，硬切会很突兀 */
    document.documentElement.classList.add('nis-onb-handoff')
    await nextTick()
    const fades = rootEl.value ? rootEl.value.querySelectorAll('.onb-fade') : []
    gsap.to(fades, { opacity: 0, duration: 0.22, ease: 'power1.out' })
    await wait(240)

    /* 2) 果冻弹跳 + 入水 + 涟漪幕布 + 界面长出 */
    const appEl = document.getElementById('app')
    const fadeList = rootEl.value
      ? (Array.from(rootEl.value.querySelectorAll('.onb-burst, .onb-vignette')) as HTMLElement[])
      : []
    await playJellyOutro({
      logo: doneLogoEl.value as HTMLElement,
      dark: isDark.value,
      reveal: appEl,
      fadeBefore: fadeList,
      /* 幕布铺满时：引导层隐身（被盖住看不见），主界面此刻才真正交接上来 */
      onCovered: () => {
        bgGone.value = true
        if (rootEl.value) gsap.set(rootEl.value, { autoAlpha: 0 })
      },
    })
  } finally {
    /* 异常兜底：绝不把主界面留在隐藏态；交接类一并清掉 */
    document.documentElement.classList.remove('nis-boot-frame')
    document.documentElement.classList.remove('nis-onb-handoff')
    gsap.ticker.lagSmoothing(500, 33)
    closeOnboarding()
  }
}

/* ── 完成页摘要 ── */
const summary = computed(() => {
  let pname = t('onboarding.done.providerNone')
  if (pidSel.value && connState.value === 'ok') {
    const m = modelId.value ? (providersStore.modelName(pidSel.value, modelId.value) || modelId.value) : ''
    pname = [selProvider.value?.name || pidSel.value, m].filter(Boolean).join(' · ')
  } else {
    const act = providersStore.providers.find(p => p.id === providersStore.providerActive)
    if (act && providersStore.isProviderReady(act.id)) {
      const mid = providersStore.currentModelId
      pname = act.name + (mid ? ' · ' + (providersStore.modelName(act.id, mid) || mid) : '')
    }
  }
  return {
    user: settingsStore.general.userName,
    nis: settingsStore.persona.nisName,
    persona: settingsStore.persona.prompt
      ? settingsStore.persona.prompt.slice(0, 42) + (settingsStore.persona.prompt.length > 42 ? '…' : '')
      : '—',
    provider: pname,
    storage: settingsStore.storagePath || '—',
  }
})

/* 主按钮状态（供应商页单独处理） */
const mainLabel = computed(() => {
  if (step.value === 'done') return t('onboarding.finish')
  if (step.value === 'provider') {
    if (connState.value === 'ok') return t('onboarding.next')
    if (connState.value === 'connecting') return t('onboarding.provider.testing')
    if (connState.value === 'fail') return t('onboarding.provider.retry')
    return t('onboarding.provider.test')
  }
  return t('onboarding.next')
})
/* 环境检测页正在装东西时锁住主按钮——避免用户以为已装完就往下走（安装本身在后台继续） */
const mainDisabled = computed(
  () =>
    flying.value ||
    (step.value === 'provider' && connState.value === 'connecting') ||
    (step.value === 'envcheck' && envAllRunning.value),
)
function onMain() {
  if (step.value === 'done') return void startUse()
  if (step.value === 'provider') {
    if (connState.value === 'ok') return void next()
    return void connect()
  }
  void next()
}

onMounted(() => {
  themeMo = new MutationObserver(() => {
    isDark.value = document.documentElement.classList.contains('dark')
  })
  themeMo.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
  /* 0917：存储目录默认值里写死了 Administrator，换账号会指到不存在的路径 →
     用后端探到的真实用户主目录重算一次（仅当仍是默认值、用户未改动时） */
  if (/Administrator/i.test(storagePathDraft.value)) {
    void (async () => {
      try {
        const r: any = await chatStore.bridgeRpc('fs.listDir', { path: '' })
        const home = (r?.quick || []).find((q: any) => q.key === 'home')?.path
        if (home && /Administrator/i.test(storagePathDraft.value)) {
          storagePathDraft.value = normDir(String(home)) + '/Documents/NisData'
        }
      } catch { /* 后端未就绪：保留默认值 */ }
    })()
  }
})
onBeforeUnmount(() => {
  themeMo?.disconnect()
  themeMo = null
})
</script>

<template>
  <Teleport to="body">
    <div
      ref="rootEl"
      class="onb-root"
      :class="{ 'is-flying': flying }"
      :style="{ background: bgGone ? 'transparent' : (isDark ? '#0a0a0a' : '#ffffff') }"
    >
      <!-- 背景：开屏同款紫色粒子球 -->
      <div class="onb-burst" :style="{ opacity: isDark ? 0.95 : 0.55 }">
        <OrbitalSphere :speed="1" :scale="1" />
      </div>
      <div class="onb-vignette"></div>

      <div class="onb-inner">
        <!-- 顶栏：进度点 + 逐页跳过 -->
        <!-- ★1010：整条顶栏作为窗口拖拽区（无边框窗口靠它拖动）；右上角放窗口控制按钮 -->
        <div class="onb-top" :class="{ 'onb-fade': flying }" data-tauri-drag-region>
          <span
            v-for="(s, i) in STEPS"
            :key="s"
            data-tauri-drag-region
            class="h-1.5 rounded-full transition-all duration-300"
            :class="i === stepIdx ? 'w-5 bg-gray-900 dark:bg-white' : (i < stepIdx ? 'w-1.5 bg-gray-400 dark:bg-gray-500' : 'w-1.5 bg-gray-300/70 dark:bg-gray-700')"
          ></span>
          <span class="ml-2 text-[11px] text-gray-400 tabular-nums" data-tauri-drag-region>{{ t('onboarding.step', { n: stepIdx + 1, total: STEPS.length }) }}</span>
          <button
            v-if="showSkip"
            class="ml-auto text-[12px] text-gray-400 hover:text-gray-700 dark:hover:text-gray-100 transition-colors"
            @click="skipPage"
          >{{ t('onboarding.skip') }}</button>
          <!-- 占位：无论「跳过」是否显示，右侧分组都靠右 -->
          <span class="ml-auto" v-if="!showSkip"></span>
          <!-- ★1010：顶栏透明热区（铺满整条，专门用来拖窗口；不挡上面的进度点/按钮） -->
          <div class="onb-top-drag" data-tauri-drag-region></div>
        </div>

        <!-- 内容舞台（★1010：整块也作为窗口拖拽区 —— 顶栏只占一条，其余空白原来拖不动） -->
        <div class="onb-stage" data-tauri-drag-region>
          <!-- ① 欢迎 -->
          <div v-if="step === 'welcome'" :key="step" class="onb-step">
            <div class="onb-logo-float">
              <img src="/nis-logo2.png" alt="" class="w-20 h-20 object-contain" draggable="false" />
            </div>
            <h1 class="onb-title">{{ t('onboarding.welcome.title') }}</h1>
            <p class="onb-sub">{{ t('onboarding.welcome.sub') }}</p>
            <!-- ★1010（老大）：原「界面主题」换成「我们认识吗」—— 有历史数据的直接导入并跳过后续引导 -->
            <div class="onb-choose-row">
              <button class="onb-choice" :disabled="importBusy" @click="pickImportFile">
                <span class="onb-choice-t">{{ t('onboarding.welcome.importTitle') }}</span>
                <span class="onb-choice-d">{{ t('onboarding.welcome.importDesc') }}</span>
              </button>
              <button class="onb-choice" @click="onMain">
                <span class="onb-choice-t">{{ t('onboarding.welcome.freshTitle') }}</span>
                <span class="onb-choice-d">{{ t('onboarding.welcome.freshDesc') }}</span>
              </button>
            </div>
          </div>

          <!-- ② 我的名字 -->
          <div v-else-if="step === 'nisName'" :key="step" class="onb-step">
            <h2 class="onb-title">{{ t('onboarding.nisName.title') }}</h2>
            <input
              ref="nisNameEl"
              v-model="nisNameDraft"
              :placeholder="t('onboarding.nisName.ph')"
              maxlength="20"
              class="onb-input"
              @keydown.enter="next()"
            />
            <p class="onb-sub">{{ t('onboarding.nisName.hint') }}</p>
          </div>

          <!-- ③ 怎么称呼你 -->
          <div v-else-if="step === 'userName'" :key="step" class="onb-step">
            <h2 class="onb-title">{{ t('onboarding.userName.title') }}</h2>
            <input
              ref="userNameEl"
              v-model="userNameDraft"
              :placeholder="t('onboarding.userName.ph')"
              maxlength="20"
              class="onb-input"
              @keydown.enter="next()"
            />
            <p class="onb-sub">{{ t('onboarding.userName.hint') }}</p>
          </div>

          <!-- ④ 沟通方式 -->
          <div v-else-if="step === 'persona'" :key="step" class="onb-step">
            <h2 class="onb-title">{{ t('onboarding.persona.title') }}</h2>
            <p class="onb-sub">{{ t('onboarding.persona.sub') }}</p>
            <div class="flex items-center justify-center gap-3 flex-wrap">
              <button
                v-for="p in personaPresets"
                :key="p.id"
                class="onb-pill"
                :class="personaPick === p.id ? 'onb-pill-active' : ''"
                @click="personaPick = p.id"
              >{{ p.title }}</button>
            </div>
          </div>

          <!-- ⑤ 存储目录（0917） -->
          <div v-else-if="step === 'storage'" :key="step" class="onb-step">
            <h2 class="onb-title">{{ t('onboarding.storage.title') }}</h2>
            <p class="onb-sub">{{ t('onboarding.storage.sub') }}</p>
            <div class="onb-dir-box">
              <div class="flex-1 min-w-0 text-left">
                <span class="text-[11px] text-gray-400">{{ t('onboarding.storage.current') }}</span>
                <p class="onb-dir-path" :title="storagePathDraft">{{ storagePathDraft || '—' }}</p>
                <p class="onb-dir-env">{{ t('settings.general.envDir') }}：{{ envDirPreview }}</p>
              </div>
              <button class="onb-pill onb-pill-sm" @click="storagePicker = true">{{ t('onboarding.storage.choose') }}</button>
            </div>
            <p class="onb-sub onb-sub-sm">{{ t('onboarding.storage.envNote') }}</p>
          </div>

          <!-- ⑥ 运行环境检测（0917） -->
          <div v-else-if="step === 'envcheck'" :key="step" class="onb-step onb-step-wide">
            <h2 class="onb-title">{{ t('onboarding.envcheck.title') }}</h2>
            <p class="onb-sub">{{ t('onboarding.envcheck.sub') }}</p>

            <!-- 未扫描：一个大按钮（扫描是用户主动触发的） -->
            <button v-if="!envScanned" class="onb-primary-btn" :disabled="envScanning" @click="scanEnv">
              <i v-if="envScanning" class="fas fa-spinner fa-spin mr-1.5 text-[11px]"></i>
              {{ envScanning ? t('onboarding.envcheck.scanning') : t('onboarding.envcheck.scan') }}
            </button>

            <template v-else>
              <div class="onb-env-list">
                <div v-for="row in envRows" :key="row.id" class="onb-env-row">
                  <i :class="[row.icon, 'onb-env-ico']"></i>
                  <div class="onb-env-main">
                    <span class="onb-env-name">{{ row.name }}</span>
                    <span class="onb-env-desc">{{ row.desc }}</span>
                  </div>
                  <span class="onb-env-size">{{ row.sizeBytes ? t('onboarding.envcheck.sizeApprox', { size: fmtSize(row.sizeBytes) }) : '' }}</span>
                  <!-- 0917：应用自带的运行时标「自带」，不显示位置/安装 -->
                  <span v-if="row.bundled" class="onb-env-loc">{{ t('settings.env.bundled') }}</span>
                  <!-- 0921d：机器上本来就有 → 标明来源（只使用、不卸载） -->
                  <span
                    v-else-if="row.installed && row.source === 'system'"
                    class="onb-env-loc"
                    :title="t('settings.env.srcSystemTip')"
                  >{{ t('settings.env.srcSystem') }}</span>
                  <span v-else class="onb-env-loc" :class="row.mustC ? 'is-mustc' : ''">{{ row.mustC ? t('onboarding.envcheck.onlyC') : t('onboarding.envcheck.toStorage') }}</span>
                  <span class="onb-env-st" :class="row.installed ? 'is-ok' : 'is-miss'">
                    <i :class="row.installed ? 'fas fa-circle-check' : 'far fa-circle'"></i>
                    {{ row.installed ? t('onboarding.envcheck.ready') : t('onboarding.envcheck.missing') }}
                  </span>
                  <button
                    v-if="!row.installed && !row.bundled"
                    class="onb-env-btn"
                    :disabled="row.state === 'installing' || envAllRunning"
                    @click="installEnvItem(row.id)"
                  ><i v-if="row.state === 'installing'" class="fas fa-spinner fa-spin mr-1 text-[10px]"></i>{{ row.state === 'installing' ? t('onboarding.envcheck.installing') : t('onboarding.envcheck.install') }}</button>
                  <span v-else class="onb-env-btn-ph"></span>
                </div>
              </div>

              <div class="flex items-center justify-center gap-3 flex-wrap">
                <button class="onb-ghost-btn" :disabled="envScanning || envAllRunning" @click="scanEnv">
                  <i v-if="envScanning" class="fas fa-spinner fa-spin mr-1 text-[11px]"></i>{{ envScanning ? t('onboarding.envcheck.scanning') : t('onboarding.envcheck.rescan') }}
                </button>
                <button v-if="missingCount > 0" class="onb-primary-btn onb-btn-sm" :disabled="envAllRunning" @click="installAllMissing">
                  <i v-if="envAllRunning" class="fas fa-spinner fa-spin mr-1.5 text-[11px]"></i>
                  {{ t('onboarding.envcheck.installAll', { n: missingCount }) }}
                </button>
              </div>

              <p v-if="envBusyLabel" class="onb-env-msg">{{ envBusyLabel }}</p>
              <p v-else-if="envErr" class="onb-env-msg is-err">{{ envErr }}</p>
              <p v-else-if="allReady" class="onb-env-msg is-ok"><i class="fas fa-circle-check mr-1"></i>{{ t('onboarding.envcheck.allReady') }}</p>
              <p v-else class="onb-env-msg">{{ t('onboarding.envcheck.skipHint') }}</p>
            </template>
          </div>

          <!-- ⑦ 供应商 -->
          <div v-else-if="step === 'provider'" :key="step" class="onb-step onb-step-wide">
            <h2 class="onb-title">{{ t('onboarding.provider.title') }}</h2>
            <p class="onb-sub">{{ t('onboarding.provider.sub') }}</p>
            <div class="onb-provider-grid">
              <button
                v-for="p in providerList"
                :key="p.id"
                class="onb-chip"
                :class="pidSel === p.id ? 'onb-chip-active' : ''"
                @click="pickProvider(p.id)"
              >
                <img :src="p.logo" class="w-4 h-4 object-contain shrink-0" alt="" @error="hideLogo" />
                <span class="text-[11px] truncate">{{ p.name }}</span>
              </button>
            </div>
            <template v-if="pidSel">
              <div class="w-full max-w-[460px] mt-1 text-left">
                <div class="flex items-center justify-between">
                  <label class="text-[13px] font-[530] text-gray-700 dark:text-gray-200">{{ t('onboarding.provider.keyLabel') }}</label>
                  <span class="text-[10px] text-gray-400 truncate max-w-[240px]">{{ selProvider?.base }}</span>
                </div>
                <div class="mt-1.5 flex items-center gap-2">
                  <input
                    v-model="keyDraft"
                    :type="showKey ? 'text' : 'password'"
                    :placeholder="t('onboarding.provider.keyPh')"
                    class="onb-boxed-input"
                    @keydown.enter="connect()"
                  />
                  <button class="onb-icon-btn" @click="showKey = !showKey">
                    <i :class="showKey ? 'fas fa-eye-slash' : 'fas fa-eye'" class="text-[12px]"></i>
                  </button>
                </div>
              </div>
              <div v-if="connState === 'ok'" class="onb-ok-box">
                <div class="flex items-center gap-2 text-[13px] text-emerald-700 dark:text-emerald-300">
                  <i class="fas fa-circle-check"></i><span>{{ connMsg }}</span>
                </div>
                <div v-if="modelOptions.length" class="mt-2.5 flex items-center justify-between gap-3">
                  <span class="text-[12px] text-emerald-700/80 dark:text-emerald-300/80">{{ t('onboarding.provider.modelLabel') }}</span>
                  <MiniSelect :model-value="modelId" :options="modelOptions" width="w-[240px]" @update:model-value="onModelPick" />
                </div>
              </div>
              <div v-else-if="connState === 'fail'" class="onb-fail-box">
                <i class="fas fa-triangle-exclamation mr-1.5"></i>{{ connMsg }}
              </div>
            </template>
          </div>

          <!-- ⑧ 一切就绪 -->
          <div v-else :key="step" class="onb-step">
            <div class="onb-logo-float">
              <img ref="doneLogoEl" src="/nis-logo2.png" alt="" class="w-16 h-16 object-contain" draggable="false" />
            </div>
            <h2 class="onb-title onb-fade">{{ t('onboarding.done.title') }}</h2>
            <div class="onb-summary onb-fade">
              <div class="onb-summary-row"><span class="onb-summary-label">{{ t('onboarding.done.summaryUser') }}</span><span class="onb-summary-val">{{ summary.user }}</span></div>
              <div class="onb-summary-row"><span class="onb-summary-label">{{ t('onboarding.done.summaryNis') }}</span><span class="onb-summary-val">{{ summary.nis }}</span></div>
              <div class="onb-summary-row"><span class="onb-summary-label">{{ t('onboarding.done.summaryPersona') }}</span><span class="onb-summary-val">{{ summary.persona }}</span></div>
              <div class="onb-summary-row"><span class="onb-summary-label">{{ t('onboarding.done.summaryStorage') }}</span><span class="onb-summary-val onb-summary-path" :title="summary.storage">{{ summary.storage }}</span></div>
              <div class="onb-summary-row"><span class="onb-summary-label">{{ t('onboarding.done.summaryProvider') }}</span><span class="onb-summary-val">{{ summary.provider }}</span></div>
            </div>
            <p class="onb-sub onb-fade">{{ t('onboarding.done.footnote') }}</p>
          </div>
        </div>

        <!-- 底栏：上一步 / 主按钮 -->
        <div class="onb-foot" :class="{ 'onb-fade': flying }">
          <button v-if="showPrev" class="onb-ghost-btn" @click="prev">{{ t('onboarding.prev') }}</button>
          <span v-else></span>
          <button class="onb-primary-btn" :disabled="mainDisabled" @click="onMain">
            <i v-if="step === 'provider' && connState === 'connecting'" class="fas fa-spinner fa-spin mr-1.5 text-[11px]"></i>{{ mainLabel }}
          </button>
        </div>
      </div>

      <!-- ⑤ 存储目录选择器（0917）：引导层 z-index 极高，需把选择器提到它之上 -->
      <DirPickerModal v-model:open="storagePicker" :initial="storagePathDraft" :z="10130" @select="onStoragePicked" />
    </div>
  </Teleport>
    <!-- ★1010：第一页「导入数据」用的两个弹窗（与设置页同款） -->
    <!-- ★1010：导入完成后的「需要重启」提示（导入的数据要重启应用才生效） -->
    <Teleport to="body">
      <div v-if="needRestart" class="onb-restart-mask">
        <div class="onb-restart-card" role="dialog" aria-modal="true">
          <div class="onb-restart-icon"><i class="fas fa-rotate-right"></i></div>
          <h3 class="onb-restart-title">{{ t('onboarding.restart.title') }}</h3>
          <p class="onb-restart-body">{{ t('onboarding.restart.body') }}</p>
          <p v-if="importNote" class="onb-restart-note">{{ importNote }}</p>
          <div class="onb-restart-actions">
            <button class="onb-ghost-btn" :disabled="restartBusy" @click="laterRestart">{{ t('onboarding.restart.later') }}</button>
            <button class="onb-primary-btn" :disabled="restartBusy" @click="doRestart">
              <i v-if="restartBusy" class="fas fa-spinner fa-spin mr-1.5 text-[11px]"></i>{{ t('onboarding.restart.now') }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>
    <!-- ★1010：窗口按钮独立成层（fixed + 最高 z-index + 可点），不再受背景层/遮罩层影响 -->
    <div class="onb-win-ctrl">
      <WindowControls />
    </div>
    <DataBackupDialog v-model:open="importOpen" :mode="'import'" :file-path="importFile" :z="10140" @done="onImportDone" />
    <DirPickerModal v-model:open="importPicker" initial="" :z="10130" @select="onImportFilePicked" />
</template>

<style scoped>
.onb-root {
  position: fixed;
  inset: 0;
  /* ★1010 根治（老大实测"关闭按钮点了没反应"）：
     原值 2147482500（21.4 亿）把**所有常规弹窗**都盖住了 —— 点窗口 ✕ 时 Rust 会拦下关闭
     并让前端弹「取消 / 隐藏到托盘 / 退出 NIS」询问框（.cls-mask z-index 10080），
     结果询问框弹了却被引导页盖住 ⇒ 看着像"点了没反应"。
     降到 9000：既盖得住主界面（常规 UI z 都在千级以内），又让 10060~10140 那些弹窗正常浮上来。 */
  z-index: 9000;
  overflow: hidden;
  animation: onbRootIn 0.45s cubic-bezier(0.22, 1, 0.36, 1) both;
  /* 0915 收尾：背景可过渡（交接时转透明，露出主界面） */
  transition: background-color 0.45s ease;
}
.onb-root.is-flying {
  pointer-events: none;
}
.onb-burst {
  position: absolute;
  inset: 0;
  transition: opacity 0.4s ease;
  /* ★1010：纯装饰层，绝不拦鼠标（否则窗口拖拽/按钮点击会被它吃掉） */
  pointer-events: none;
  /* 原版构图偏右（hero 排版）——引导页把球拉回中间并略放大，画面更平衡 */
  transform: translateX(-7%) scale(1.12);
}
/* ★1010（老大反馈"浅色模式下背景的球看不清"）：浅色时把球压暗加饱和，
   白底上才看得见（深色模式保持原样）。 */
html:not(.dark) .onb-burst {
  filter: saturate(1.45) contrast(1.12) brightness(0.82);
}
.onb-vignette {
  position: absolute;
  inset: 0;
  pointer-events: none;
  background: radial-gradient(ellipse at 50% 42%, transparent 0%, rgba(255, 255, 255, 0.55) 100%);
}
html.dark .onb-vignette {
  background: radial-gradient(ellipse at 50% 42%, transparent 0%, rgba(0, 0, 0, 0.55) 100%);
}
.onb-inner {
  position: relative;
  height: 100%;
  display: flex;
  flex-direction: column;
  padding: 26px 44px 30px;
}
.onb-top {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 34px;
  padding: 4px 0;
  /* ★1010：顶栏要在球/遮罩之上，拖拽与"跳过"才吃得到鼠标 */
  position: relative;
  z-index: 40;
}
/* ★1010：导入完成后的重启提示（z-index 高于引导页 9000，低于窗口按钮层） */
.onb-restart-mask {
  position: fixed;
  inset: 0;
  z-index: 10090;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(17, 17, 27, 0.42);
}
.onb-restart-card {
  width: 420px;
  max-width: calc(100vw - 48px);
  padding: 22px 24px 18px;
  border-radius: 16px;
  background: #fff;
  box-shadow: 0 24px 60px -20px rgba(0, 0, 0, 0.45);
  text-align: center;
}
html.dark .onb-restart-card { background: #1b1c22; }
.onb-restart-icon {
  width: 44px;
  height: 44px;
  margin: 0 auto 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: rgba(124, 58, 237, 0.12);
  color: #7c3aed;
  font-size: 18px;
}
.onb-restart-title { font-size: 16px; font-weight: 600; color: #111827; margin-bottom: 6px; }
html.dark .onb-restart-title { color: #f3f4f6; }
.onb-restart-body { font-size: 12.5px; line-height: 1.7; color: #6b7280; margin-bottom: 16px; }
html.dark .onb-restart-body { color: #9ca3af; }
.onb-restart-note {
  margin: -6px 0 14px;
  padding: 8px 10px;
  border-radius: 8px;
  background: rgba(245, 158, 11, 0.1);
  color: #b45309;
  font-size: 12px;
  line-height: 1.6;
  text-align: left;
}
html.dark .onb-restart-note { background: rgba(251, 191, 36, 0.12); color: #fbbf24; }
.onb-restart-actions { display: flex; gap: 10px; justify-content: center; }

/* ★1010：顶栏拖拽热区 —— 铺满整条顶栏的**空白区域**（z-index 低于进度点/按钮，不抢它们的点击） */
.onb-top-drag {
  position: absolute;
  left: 0;
  right: 0;
  top: -6px;
  bottom: -6px;
  z-index: -1;
}
/* ★1010：窗口按钮独立层（右上角最上层） */
.onb-win-ctrl {
  position: fixed;
  top: 4px;
  right: 6px;
  z-index: 2147483646;
  pointer-events: auto;
}
.onb-stage { position: relative; z-index: 10; }
.onb-stage {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow-y: auto;
  padding: 18px 0;
}
.onb-step {
  width: 100%;
  max-width: 620px;
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: 14px;
}
.onb-step-wide {
  max-width: 680px;
}
/* 逐元素上浮入场（大留白 + 轻动画） */
.onb-step > * {
  animation: onbUp 0.55s cubic-bezier(0.22, 1, 0.36, 1) both;
}
.onb-step > *:nth-child(1) { animation-delay: 0.02s; }
.onb-step > *:nth-child(2) { animation-delay: 0.09s; }
.onb-step > *:nth-child(3) { animation-delay: 0.16s; }
.onb-step > *:nth-child(4) { animation-delay: 0.23s; }
.onb-step > *:nth-child(5) { animation-delay: 0.3s; }
.onb-logo-float {
  animation: onbFloat 4.2s ease-in-out infinite;
}
.onb-title {
  font-size: 22px;
  font-weight: 700;
  letter-spacing: 0.01em;
  color: #111827;
}
html.dark .onb-title {
  color: #ffffff;
}
.onb-sub {
  font-size: 13px;
  color: #6b7280;
  max-width: 420px;
}
html.dark .onb-sub {
  color: rgba(255, 255, 255, 0.55);
}
/* 极简居中输入（大留白） */
.onb-input {
  width: min(360px, 78vw);
  background: transparent;
  border: none;
  border-bottom: 2px solid rgba(0, 0, 0, 0.14);
  text-align: center;
  font-size: 20px;
  padding: 10px 6px 12px;
  outline: none;
  color: #111827;
  transition: border-color 0.25s ease;
}
.onb-input::placeholder {
  color: rgba(0, 0, 0, 0.24);
  font-size: 17px;
}
.onb-input:focus {
  border-color: #a78bfa;
}
html.dark .onb-input {
  border-bottom-color: rgba(255, 255, 255, 0.22);
  color: #ffffff;
}
html.dark .onb-input::placeholder {
  color: rgba(255, 255, 255, 0.3);
}
html.dark .onb-input:focus {
  border-color: #a78bfa;
}
/* ★1010：第一页的两个选择卡（导入历史数据 / 从头开始） */
.onb-choose-row {
  display: flex;
  gap: 10px;
  margin-top: 6px;
  flex-wrap: wrap;
  justify-content: center;
}
.onb-choice {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 208px;
  max-width: 260px;
  padding: 11px 14px;
  border-radius: 12px;
  border: 1px solid rgba(0, 0, 0, 0.09);
  background: rgba(255, 255, 255, 0.72);
  text-align: left;
  cursor: pointer;
  transition: transform 0.16s ease, box-shadow 0.16s ease, border-color 0.16s ease;
}
.onb-choice:hover { transform: translateY(-1px); box-shadow: 0 8px 20px -12px rgba(0, 0, 0, 0.35); border-color: rgba(124, 58, 237, 0.35); }
.onb-choice:disabled { opacity: 0.6; cursor: default; }
.onb-choice-primary { border-color: rgba(124, 58, 237, 0.45); background: rgba(124, 58, 237, 0.06); }
.onb-choice-t { font-size: 13px; font-weight: 600; color: #111827; }
.onb-choice-d { font-size: 11.5px; color: #6b7280; line-height: 1.5; }
html.dark .onb-choice { background: rgba(255, 255, 255, 0.05); border-color: rgba(255, 255, 255, 0.12); }
html.dark .onb-choice:hover { border-color: rgba(167, 139, 250, 0.5); }
html.dark .onb-choice-primary { background: rgba(124, 58, 237, 0.16); border-color: rgba(167, 139, 250, 0.5); }
html.dark .onb-choice-t { color: #f3f4f6; }
html.dark .onb-choice-d { color: #9ca3af; }

/* 主题行（★1010：第一页不再用，保留样式以防回退） */
.onb-theme-row {
  margin-top: 6px;
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 10px 16px;
  border-radius: 16px;
  border: 1px solid rgba(0, 0, 0, 0.08);
  background: rgba(255, 255, 255, 0.55);
  backdrop-filter: blur(8px);
}
html.dark .onb-theme-row {
  border-color: rgba(255, 255, 255, 0.12);
  background: rgba(255, 255, 255, 0.06);
}
/* 预设按钮（只留按钮） */
.onb-pill {
  padding: 10px 26px;
  border-radius: 999px;
  font-size: 14px;
  color: #374151;
  border: 1px solid rgba(0, 0, 0, 0.14);
  background: rgba(255, 255, 255, 0.55);
  backdrop-filter: blur(6px);
  transition: all 0.2s ease;
}
.onb-pill:hover {
  border-color: rgba(0, 0, 0, 0.35);
}
.onb-pill-active {
  background: #111827 !important;
  border-color: #111827 !important;
  color: #fff !important;
  box-shadow: 0 8px 22px -10px rgba(17, 24, 39, 0.6);
}
html.dark .onb-pill {
  color: rgba(255, 255, 255, 0.82);
  border-color: rgba(255, 255, 255, 0.18);
  background: rgba(255, 255, 255, 0.06);
}
html.dark .onb-pill:hover {
  border-color: rgba(255, 255, 255, 0.4);
}
html.dark .onb-pill-active {
  background: #fff !important;
  border-color: #fff !important;
  color: #111827 !important;
  box-shadow: 0 10px 26px -12px rgba(255, 255, 255, 0.5);
}
/* 供应商网格/芯片 */
.onb-provider-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
  width: 100%;
}
.onb-chip {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-radius: 12px;
  border: 1px solid rgba(0, 0, 0, 0.1);
  background: rgba(255, 255, 255, 0.6);
  color: #374151;
  min-width: 0;
  transition: all 0.18s ease;
}
.onb-chip:hover {
  background: #ffffff;
}
.onb-chip-active {
  background: #111827 !important;
  border-color: #111827 !important;
  color: #fff !important;
}
html.dark .onb-chip {
  border-color: rgba(255, 255, 255, 0.14);
  background: rgba(255, 255, 255, 0.06);
  color: rgba(255, 255, 255, 0.82);
}
html.dark .onb-chip:hover {
  background: rgba(255, 255, 255, 0.12);
}
html.dark .onb-chip-active {
  background: #fff !important;
  border-color: #fff !important;
  color: #111827 !important;
}
.onb-boxed-input {
  flex: 1;
  background: rgba(255, 255, 255, 0.6);
  border: 1px solid rgba(0, 0, 0, 0.12);
  border-radius: 12px;
  padding: 10px 14px;
  font-size: 13px;
  color: #111827;
  outline: none;
  transition: border-color 0.2s ease;
}
.onb-boxed-input:focus {
  border-color: #a78bfa;
}
html.dark .onb-boxed-input {
  background: rgba(255, 255, 255, 0.06);
  border-color: rgba(255, 255, 255, 0.14);
  color: #fff;
}
.onb-icon-btn {
  width: 38px;
  height: 38px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 12px;
  color: #6b7280;
  background: rgba(0, 0, 0, 0.05);
  transition: all 0.18s ease;
}
.onb-icon-btn:hover {
  color: #111827;
}
html.dark .onb-icon-btn {
  color: rgba(255, 255, 255, 0.6);
  background: rgba(255, 255, 255, 0.08);
}
html.dark .onb-icon-btn:hover {
  color: #fff;
}
.onb-ok-box {
  width: 100%;
  max-width: 460px;
  padding: 12px 14px;
  border-radius: 14px;
  border: 1px solid rgba(16, 185, 129, 0.35);
  background: rgba(16, 185, 129, 0.08);
  text-align: left;
}
.onb-fail-box {
  width: 100%;
  max-width: 460px;
  padding: 12px 14px;
  border-radius: 14px;
  border: 1px solid rgba(245, 158, 11, 0.35);
  background: rgba(245, 158, 11, 0.08);
  font-size: 12px;
  color: #b45309;
  text-align: left;
  word-break: break-all;
}
html.dark .onb-fail-box {
  color: #fbbf24;
}
/* 完成页摘要（无框、大留白） */
.onb-summary {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 4px;
}
.onb-summary-row {
  display: flex;
  align-items: baseline;
  justify-content: center;
  gap: 14px;
}
.onb-summary-label {
  font-size: 12px;
  color: #9ca3af;
  min-width: 64px;
  text-align: right;
}
.onb-summary-val {
  font-size: 13px;
  color: #374151;
  max-width: 380px;
  text-align: left;
}
html.dark .onb-summary-val {
  color: rgba(255, 255, 255, 0.88);
}
/* 底栏按钮 */
.onb-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 56px;
}
.onb-primary-btn {
  padding: 11px 30px;
  border-radius: 999px;
  font-size: 14px;
  font-weight: 530;
  background: #111827;
  color: #fff;
  box-shadow: 0 14px 30px -14px rgba(17, 24, 39, 0.65);
  transition: all 0.2s ease;
}
.onb-primary-btn:hover {
  background: #1f2937;
}
.onb-primary-btn:disabled {
  opacity: 0.5;
}
html.dark .onb-primary-btn {
  background: #ffffff;
  color: #111827;
  box-shadow: 0 14px 34px -16px rgba(255, 255, 255, 0.55);
}
html.dark .onb-primary-btn:hover {
  background: #f3f4f6;
}
.onb-ghost-btn {
  padding: 8px 14px;
  border-radius: 10px;
  font-size: 13px;
  color: #9ca3af;
  transition: color 0.2s ease;
}
.onb-ghost-btn:hover {
  color: #374151;
}
html.dark .onb-ghost-btn:hover {
  color: #fff;
}
@keyframes onbRootIn {
  from { opacity: 0; }
  to { opacity: 1; }
}
@keyframes onbUp {
  from { opacity: 0; transform: translateY(16px); }
  to { opacity: 1; transform: none; }
}
@keyframes onbFloat {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-8px); }
}
/* ── 0917 交接：解除“填满模式”的入场动画（CSS 动画优先级高于内联样式，不解除则 gsap 淡出无效）；
   类挂在 <html>（组件根类名会被 Vue 补丁覆盖）；漂浮动画只暂停（保留当前偏移，不跳变） ── */
html.nis-onb-handoff .onb-root,
html.nis-onb-handoff .onb-root .onb-step > *:not(.onb-logo-float) {
  animation: none !important;
}
html.nis-onb-handoff .onb-root .onb-logo-float {
  animation-play-state: paused !important;
}
/* ── 0917：⑤ 存储目录 ── */
.onb-dir-box {
  width: 100%;
  max-width: 520px;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  border-radius: 14px;
  border: 1px solid rgba(0, 0, 0, 0.1);
  background: rgba(255, 255, 255, 0.6);
  backdrop-filter: blur(8px);
}
html.dark .onb-dir-box {
  border-color: rgba(255, 255, 255, 0.14);
  background: rgba(255, 255, 255, 0.06);
}
.onb-dir-path {
  margin-top: 2px;
  font-size: 12.5px;
  color: #111827;
  font-family: var(--mono, monospace);
  word-break: break-all;
  line-height: 1.45;
}
html.dark .onb-dir-path {
  color: #fff;
}
.onb-dir-env {
  margin-top: 3px;
  font-size: 10.5px;
  color: #9ca3af;
  font-family: var(--mono, monospace);
  word-break: break-all;
}
.onb-pill-sm {
  padding: 7px 16px;
  font-size: 12.5px;
}
.onb-sub-sm {
  font-size: 11.5px;
  max-width: 520px;
  line-height: 1.6;
}
.onb-btn-sm {
  padding: 8px 20px;
  font-size: 13px;
}
/* ── 0917：⑥ 环境检测 ── */
.onb-env-list {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.onb-env-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 12px;
  border-radius: 12px;
  border: 1px solid rgba(0, 0, 0, 0.08);
  background: rgba(255, 255, 255, 0.6);
  backdrop-filter: blur(8px);
  text-align: left;
}
html.dark .onb-env-row {
  border-color: rgba(255, 255, 255, 0.12);
  background: rgba(255, 255, 255, 0.055);
}
.onb-env-ico {
  font-size: 14px;
  color: #6b7280;
  width: 18px;
  text-align: center;
  flex-shrink: 0;
}
html.dark .onb-env-ico {
  color: rgba(255, 255, 255, 0.6);
}
.onb-env-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.onb-env-name {
  font-size: 12.5px;
  color: #111827;
}
html.dark .onb-env-name {
  color: #fff;
}
.onb-env-desc {
  font-size: 10px;
  color: #9ca3af;
  margin-top: 1px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.onb-env-size {
  font-size: 11px;
  color: #9ca3af;
  width: 62px;
  text-align: right;
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
}
.onb-env-loc {
  font-size: 10px;
  padding: 2px 7px;
  border-radius: 6px;
  flex-shrink: 0;
  white-space: nowrap;
  color: #6b7280;
  border: 1px solid rgba(0, 0, 0, 0.1);
}
.onb-env-loc.is-mustc {
  color: #b45309;
  border-color: rgba(245, 158, 11, 0.4);
  background: rgba(245, 158, 11, 0.08);
}
html.dark .onb-env-loc {
  color: rgba(255, 255, 255, 0.62);
  border-color: rgba(255, 255, 255, 0.16);
}
html.dark .onb-env-loc.is-mustc {
  color: #fbbf24;
  border-color: rgba(245, 158, 11, 0.4);
  background: rgba(245, 158, 11, 0.1);
}
.onb-env-st {
  font-size: 11px;
  width: 68px;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  white-space: nowrap;
}
.onb-env-st.is-ok {
  color: #10b981;
}
.onb-env-st.is-miss {
  color: #9ca3af;
}
.onb-env-btn {
  font-size: 11.5px;
  padding: 4px 12px;
  border-radius: 8px;
  flex-shrink: 0;
  color: #374151;
  border: 1px solid rgba(0, 0, 0, 0.15);
  background: rgba(255, 255, 255, 0.7);
  transition: all 0.18s ease;
}
.onb-env-btn:hover:not(:disabled) {
  border-color: #111827;
  color: #111827;
}
.onb-env-btn:disabled {
  opacity: 0.45;
}
html.dark .onb-env-btn {
  color: rgba(255, 255, 255, 0.82);
  border-color: rgba(255, 255, 255, 0.2);
  background: rgba(255, 255, 255, 0.08);
}
html.dark .onb-env-btn:hover:not(:disabled) {
  border-color: #fff;
  color: #fff;
}
.onb-env-btn-ph {
  width: 58px;
  flex-shrink: 0;
}
.onb-env-msg {
  font-size: 11.5px;
  color: #9ca3af;
}
.onb-env-msg.is-ok {
  color: #10b981;
}
.onb-env-msg.is-err {
  color: #b45309;
}
html.dark .onb-env-msg.is-err {
  color: #fbbf24;
}
.onb-summary-path {
  word-break: break-all;
  font-family: var(--mono, monospace);
  font-size: 12px;
}
</style>
