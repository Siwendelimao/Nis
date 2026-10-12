<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, onUpdated, nextTick } from 'vue'
import { useProvidersStore } from '@/stores/providers'
import { useUiStore } from '@/stores/ui'
import type { ProviderItem } from '@/stores/providers'
import VendorLogo from '../VendorLogo.vue'
import EffortSlider from './EffortSlider.vue'
import { safeRightEdge } from '@/utils/layoutEdge'
import { t } from '@/utils/i18n'

const props = withDefaults(defineProps<{
  modelValue?: string
  /** v-model:effort 绑定（Vue 3 参数化 v-model：prop 名就是 effort） */
  effort?: string
  /** 允许空值（成员独立模型等场景：空=跟随会话，不自动切到第一个模型） */
  allowEmpty?: boolean
  /** 空值时的占位文案（allowEmpty 时生效） */
  emptyLabel?: string
  /** 是否显示/联动推理强度卡（默认 true；成员模型无强度概念传 false） */
  showEffort?: boolean
  /** 选中模型时是否同步全局当前供应商（默认 true；成员选择器不应改全局状态传 false） */
  syncGlobal?: boolean
  /** ★1012u：当前模型的**权威归属供应商** id（会话级覆盖的 provider，或后端 providerActive）。
   *  为什么要它：多个供应商可能有同名模型（实测：商汤 与 tokenrhythm 都有 deepseek-flash），
   *  只按模型 id 在启用供应商里"谁先有就用谁"，会把图标/名称显示成另一家（显示与实际调用不一致）。
   *  传了它就按它解析；没传（老调用方/成员选择器等）保持原来的扫描行为。 */
  vendorId?: string
}>(), {
  // Boolean prop 缺席时 Vue 会解析为 false（不是 undefined），必须显式给默认 true，
  // 否则主界面（不传这两个 prop）会误判为"成员模式"：强度角标不渲染、选模型不同步供应商
  showEffort: true,
  syncGlobal: true,
})

const emit = defineEmits<{
  'update:modelValue': [value: string]
  /** 0908 二批条1：用户点选模型的确切信号（含归属供应商 id）。
   *  v-model 会被 currentModelId getter 兜底/供应商切换重算"冒充用户选择"回传——
   *  父组件写会话模型必须听这个事件，不能听 v-model（显示与实际发送脱节的根因） */
  'change': [value: string, vendorId: string | null]
  'update:effort': [value: string]
}>()

// 与设置页供应商板块联动：读共享 store，模型=启用模型
const providersStore = useProvidersStore()
const uiStore = useUiStore()

// Dock 显示已启用且「可用」（有 key / 本地）的供应商（无 key 供应商的模型选了也发不出去，不显示）
const enabledVendors = computed<ProviderItem[]>(() =>
  providersStore.providers.filter(p => p.enabled && providersStore.isProviderReady(p.id)),
)

function modelsOf(providerId: string) {
  // 显示该供应商所有启用模型（含图片/视频，用于 /imagine 生成；聊天模型由后端按 text 能力拦截）
  return (providersStore.models[providerId] || []).filter(m => m.enabled)
}

/** ★1012u：**权威归属供应商** —— props.vendorId（会话覆盖的 provider / 后端 providerActive）指到谁就是谁。
 *  注意这里刻意**不要求"该供应商在启用清单里"**：会话可能停在某个刚被停用的供应商上，
 *  此时仍要如实显示那家的图标（显示口径 = 实际归属），而不是转手拿别家的。
 *  ⚠️ 位置有讲究：必须声明在**所有用它的人之前**（currentEffortLevels 等）。
 *  第一次是放在它们后面，setup 阶段就被求值 ⇒ `ReferenceError: Cannot access 'on' before initialization`
 *  （TDZ），整块模型选择器渲染不出来（老大实测：选择器直接消失）。 */
const authoritativeVendor = computed<ProviderItem | null>(() => {
  const vid = String(props.vendorId || '').trim()
  if (!vid) return null
  return providersStore.providers.find(p => p.id === vid) || null
})

const currentModel = computed({
  get: () => props.modelValue || '',
  set: (val) => emit('update:modelValue', val),
})

/* 推理强度（与模型选择同一弹窗：右侧面板，关闭弹窗即确认） */
const currentEffort = computed({
  get: () => {
    /* ★0926：回归 props.effort 单一通道。0925ac 的"直读 conversationsStore(activeConversationId)"
       是绕道补丁——activeConversationId 是全局单值，与父组件 props.conversation?.id 可不同源
       （多窗口/空态草稿）→ 读到别的会话的强度、写却写不进那个会话 =「拨了纹丝不动」的帮凶。
       当年"props 链不刷新"的真身是 ChatInterface 空态分支只写 localStore（非响应式 Map），
       已在 ChatInterface 侧用 draftEffort（响应式草稿）根治——props 链本就是响应式单一真相。 */
    return props.effort || 'deep'
  },
  set: (val) => emit('update:effort', val),
})
const EFFORT_META: Record<string, { label: string; color: string }> = {
  fast: { label: 'Low', color: '#10B981' },
  deep: { label: 'Mid', color: '#3B82F6' },
  heavy: { label: 'High', color: '#EF4444' },
  burning: { label: 'Max', color: '#8B5CF6' },
}
const effortMeta = computed(() => EFFORT_META[currentEffort.value] || EFFORT_META.deep)
/* 光环双色渐变 + 转速（强度越高转越快、颜色越"热"），风格对齐 uiverse spinner：
   旋转渐变盘 + blur 光晕 + 双向 box-shadow 辉光，mask 挖空中心贴紧头像边缘 */
const EFFORT_RING: Record<string, { c1: string; c2: string; cFade: string; dur: string }> = {
  fast: { c1: '#34D399', c2: '#0D9488', cFade: 'rgba(52,211,153,0.35)', dur: '3.2s' },
  deep: { c1: '#60A5FA', c2: '#2563EB', cFade: 'rgba(96,165,250,0.35)', dur: '2.4s' },
  heavy: { c1: '#F87171', c2: '#F97316', cFade: 'rgba(248,113,113,0.35)', dur: '1.5s' },
  burning: { c1: '#BA68FF', c2: '#00E1FF', cFade: 'rgba(186,104,255,0.35)', dur: '0.9s' },
}
const effortRingStyle = computed(() => {
  const r = EFFORT_RING[currentEffort.value] || EFFORT_RING.deep
  return { '--ring-a': r.c1, '--ring-b': r.c2, '--ring-fade': r.cFade, '--ring-dur': r.dur } as Record<string, string>
})

/** 当前选定模型是否支持推理强度（0902-2：后端 capabilities 为权威，正则只兜"模型不在任何
 *  已启用供应商模型表"的边缘态——不再依赖本地模型表造能力） */
/* 0910：当前模型的可用思考挡位（providersStore.modelEfforts=与后端 resolveModelEfforts 同一份语义，
 * 单一真相源：isReasoningModel 直接由它派生，不再双轨判 capabilities）。
 * 不可用挡位不进滑块吸附点=天然隐藏；非推理模型=[] → 强度入口整个隐藏（光环/选完模型弹卡都查它）。
 * 当前挡位不在清单内（如切到 zai 系模型时还挂着 deep）→ watch 钳到最近可用挡并回传。 */
const currentEffortLevels = computed<string[]>(() => {
  const id = currentModel.value || ''
  if (!id) return ['fast', 'deep', 'heavy'] // 未选模型：编辑态用标准三挡（选完模型即重钳）
  /* ★1012u：先认权威归属供应商（同名模型撞车时，挡位清单也得按**实际那家**算 —— 不同网关档位不同） */
  const av = authoritativeVendor.value
  if (av) {
    const lv = providersStore.modelEfforts(av.id, id)
    if (lv && lv.length) return lv
  }
  const vendor = enabledVendors.value.find(v => modelsOf(v.id).some(m => m.id === id))
  if (vendor) return providersStore.modelEfforts(vendor.id, id)
  // 模型不在任何启用供应商表里（旧数据/手输 id）：正则兜底判推理，命中=标准三挡
  // （0920：不再默认给 burning —— 除 zai 系外的网关都只认 low/medium/high）
  return /o[1-9]|o3|o4|r1|reasoner|k2|think|thinking|z1|glm-z1|deepseek-reasoner|glm-5|glm-4\.7|glm-4-plus|step-2|kimi-k|qwq|moonshot-reasoner|claude-sonnet-4|claude-opus-4/i.test(id)
    ? ['fast', 'deep', 'heavy']
    : []
})
const isReasoningModel = computed(() => currentEffortLevels.value.length > 0)
const hasEffort = computed(() => props.showEffort !== false && isReasoningModel.value)
watch(currentEffortLevels, (lv) => {
  if (!lv.length) return
  if (!lv.includes(currentEffort.value)) {
    const vid = authoritativeVendor.value?.id
      || enabledVendors.value.find(v => modelsOf(v.id).some(m => m.id === currentModel.value))?.id
      || providersStore.providerActive
    const clamped = providersStore.clampEffortFor(vid, currentModel.value, currentEffort.value)
    if (clamped) currentEffort.value = clamped
  }
})

// 当前显示：优先当前选中的模型；若它不在启用供应商里（被停用/清空），回退到第一个启用供应商的模型。
// allowEmpty 模式（成员独立模型等）：空值显示占位文案，不自动回退
const current = computed(() => {
  if (props.allowEmpty && !currentModel.value) {
    return { name: props.emptyLabel || t('model.followSession'), logo: '/nis-logo2.png' }
  }
  /* ★1012u（老大实测："选的是 tokenrhythm 的 deepseek-flash，图标显示的却是商汤"）：
     下面那圈"遍历启用供应商、谁先有同名模型就用谁"是**按 id 猜归属** —— 多家有同名模型时必然撞车。
     既然父组件把权威 vendorId 传进来了，就先按它解析（名字取该家的模型名，图标取该家 logo）。 */
  const av = authoritativeVendor.value
  if (av) {
    const mm = (providersStore.models[av.id] || []).find(m => m.id === currentModel.value)
    if (mm) return { name: mm.name, logo: av.logo }
    if (currentModel.value) return { name: currentModel.value, logo: av.logo }
  }
  for (const p of enabledVendors.value) {
    const mm = (providersStore.models[p.id] || []).find(m => m.id === currentModel.value)
    if (mm) return { name: mm.name, logo: p.logo }
  }
  /* ★ 0921c 修（反馈"选完没变 / 还显示着别的厂商的模型"的机器就在这里）：
     以前"找不到就显示第一个启用厂商的第一个模型" —— 会把 A 厂商的模型**冒充**成用户的选择，
     看着像"选了没用"。现在：已选但查不到 → 老实显示已选的 id，绝不跨厂商冒充；
     仅当**真的没选**（空值）时才回退第一个启用厂商做默认展示。 */
  if (currentModel.value) return { name: currentModel.value, logo: "/nis-logo2.png" }
  const first = enabledVendors.value[0]
  if (first) {
    const mm = modelsOf(first.id)[0]
    if (mm) return { name: mm.name, logo: first.logo }
  }
  return { name: t('model.selectModel'), logo: '/nis-logo2.png' }
})

// 未启用任何供应商（模型选择器为空）
const noEnabled = computed(() => enabledVendors.value.length === 0)

// 启用供应商变化时：若当前选中的模型已不在其中（被停用/清空），自动切到第一个启用供应商的模型。
// allowEmpty 模式不强切（空值合法；成员模型停用由后端回退共享模型兜底）
watch(enabledVendors, (vendors) => {
  if (props.allowEmpty) return
  if (!vendors.length) return
  /* ★ 0921c 修：原来只在 enabledVendors 里找 —— 供应商"暂时没就绪 / 刚启用还没进表"时，
     会把用户**刚点选的模型判为无效，然后强行回写成第一个厂商的模型**（界面表现＝"选完没变"）。
     改成在整个模型表里找：只要该模型在某处仍存在且启用，就不要动用户的选择。 */
  const valid = Object.values(providersStore.models).some((list: any) =>
    (list || []).some((m: any) => m.id === currentModel.value && m.enabled))
  if (!valid) {
    const first = vendors[0]
    const firstModel = modelsOf(first.id)[0]
    if (firstModel) currentModel.value = firstModel.id
  }
})

const isOpen = ref(false)
/** 选中模型后从所选厂商按钮右侧弹出的推理强度卡片 */
const effortOpen = ref(false)
/** 推理强度卡片所属的厂商 id（选中模型时记录） */
const effortVendor = ref<string | null>(null)
/** 是否刚通过选模型触发强度卡（完成时全关）；未选模型直接调强度 → 完成仅关强度卡 */
const effortFromModelSelect = ref(false)
const selectedVendor = ref<string | null>(null)

/* ── ★1012k：手机端「居中 sheet」（用户需求）──
   ① 供应商头像列表**居中**（原来 Dock 靠按钮定位，窄屏会出屏）；
   ② 点供应商 → 模型列表**居中**，并带**左上返回按钮**；③ 模型 ↔ 推理强度用**顶部切换**（与 PC 的
   互斥切换口径一致），点模型后自动切到「推理强度」；④ 支持**点空白关闭** + 右上 × 关闭按钮。 */
const isMobileUi = ref(typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches)
const mqMobileMs = window.matchMedia('(max-width: 767px)')
const onMqMobileMs = (e: MediaQueryListEvent) => { isMobileUi.value = e.matches }
mqMobileMs.addEventListener('change', onMqMobileMs)
onUnmounted(() => mqMobileMs.removeEventListener('change', onMqMobileMs))
const mobilePane = ref<'vendors' | 'models' | 'effort'>('vendors')
const activeVendorName = computed(() => enabledVendors.value.find(v => v.id === selectedVendor.value)?.name || '')
const activeVendorLogo = computed(() => enabledVendors.value.find(v => v.id === selectedVendor.value)?.logo || '')
/** 手机 sheet 统一关闭（与桌面那套状态一起清干净，避免回到桌面时残留） */
function mobileClose() {
  isOpen.value = false
  effortOpen.value = false
  effortVendor.value = null
  effortFromModelSelect.value = false
  selectedVendor.value = null
  mobilePane.value = 'vendors'
}
/** 逐级返回：推理强度 → 模型 → 供应商（需求的左上角返回） */
function mobileBack() {
  if (mobilePane.value === 'effort') mobilePane.value = 'models'
  else if (mobilePane.value === 'models') mobilePane.value = 'vendors'
}
function mobilePickVendor(id: string) {
  selectedVendor.value = id
  mobilePane.value = 'models'
}
/** 选模型：复用 selectModel（含供应商同步/强度联动），随后**整页切换**到推理强度（用户流程第③步） */
function mobilePickModel(id: string) {
  selectModel(id)
  mobilePane.value = 'effort'
}
/** 手机 sheet 根元素（用于 click-outside 判定：它 Teleport 到 body，不在 menuRef 内） */
const sheetRef = ref<HTMLElement | null>(null)
/* ★1012n（实测两个 bug）：
   ① 「点供应商 → 界面直接没了」= sheet 被 click-outside 误关：sheet 是 Teleport 到 body 的，
      不在 menuRef 里 ⇒ 点它内部任何位置都被判成"点了外部"。修：sheet 也算"内部"。
   ② 「正常来说点选择器应直接出现模型列表」= 打开时应**默认进模型页**（当前供应商的模型），
      供应商列表退为二级（模型页 Header 右上「切换供应商」进入）。 */
watch(isOpen, (v) => {
  if (!v || !isMobileUi.value) return
  if (!selectedVendor.value) {
    const vid = enabledVendors.value.find(vd => modelsOf(vd.id).some(m => m.id === currentModel.value))?.id
      || enabledVendors.value[0]?.id
      || null
    selectedVendor.value = vid
  }
  mobilePane.value = 'models'
})
const menuRef = ref<HTMLElement | null>(null)
/* ★ 0921（实测："推理强度卡片仍然会被右侧栏遮挡"）：
   模型弹窗本身**没有任何防溢出逻辑** —— 之前只有"选中模型后从厂商按钮右侧弹出的强度卡"
   有 `effortOnLeft`，而真正被遮的往往是**这个主弹窗**（`absolute bottom-full right-0`，
   右边缘对齐触发按钮；按钮离右栏近、或弹窗比预期宽时，右侧就伸进右栏被盖掉）。
   这里补一条通用保护：量弹窗真实右边缘 vs 可用右边界（safeRightEdge），超了就整体左移。 */
/* ★ 0921 撤销：上一版按"右栏开着就把**主弹窗**向左展开"改过一次 —— 那是**改错了对象**。
   设计口径原话："我没让模型选择器弹出的位置变动到左上，我的意思是识别到（右）侧栏时，
   选择完模型弹出的**思考强度选择器**从左侧弹出，当前是右侧。"
   ⇒ 主弹窗恢复原样（`absolute bottom-full right-0`，右边缘对齐按钮）；
      "强度卡翻左"由上面的 `effortOnLeft` 那套负责（它会跟 `.right-docks` 尺寸实时重算）。 */
const dockRef = ref<HTMLElement | null>(null)
const itemRefs = ref<HTMLElement[]>([])
const tooltipIndex = ref(-1)
// 推理强度卡片：右侧溢出时自动切换到左侧
const effortCardRef = ref<HTMLElement | null>(null)
const effortOnLeft = ref(false)
/** 取卡片真实元素（ref 写在厂商 v-for 内部 → Vue3 收集为数组，取第一个才是元素） */
function effortCardEl(): HTMLElement | null {
  const raw = effortCardRef.value as any
  /* ★ 0921c 真因：ref 写在 v-for 里会收集成**稀疏数组**（只有渲染了卡片那个下标有值），
     取 raw[0] 在第 2 个及以后的厂商下拿到的是 undefined ⇒ recalcEffortSide 直接 return，
     effortOnLeft 永远停在默认 false = 卡片永远从右边弹（用户两次反馈的真身）。
     改成「取第一个非空元素」，再退一步直接查 DOM。 */
  const fromRef = Array.isArray(raw) ? (raw.find((x: any) => x) ?? null) : raw
  return fromRef || (document.querySelector('.effort-card') as HTMLElement | null)
}
/** 按「卡片真实右边缘 vs 当前可用右边界」决定翻不翻左。
 *  ★ 0920：原本只比 `window.innerWidth`，右栏（工作区/日志）占着视口右侧那一条，
 *  卡片"没溢出视口"却伸进了右栏地盘 → 被祖先的 overflow:hidden 裁掉。
 *  ★ 0921 用户第二次澄清后加固：「**识别到（右）侧栏时**，思考强度选择器从左侧弹出」——
 *  原来纯靠"量右边缘有没有越过安全边界"，而卡片刚渲染/尺寸未稳时这个判断容易落空（实测仍从右弹）。
 *  改成**两道判据，任一成立就翻左**：① 右栏开着（`.right-docks` 有实际宽度）→ 直接翻左；
 *  ② 否则再看是否越过安全边界（兜住"右栏没开但窗口很窄"的情况）。 */
function recalcEffortSide(): void {
  /* ★ 0921c（设计口径原话：「日志、工作区这俩只要有一个激活的，推理强度就从左边出现」）：
     判据顺序改成 ① 两个 tab 的**显式激活态** → ② 右栏容器宽度 → ③ 卡片几何越界。
     原来只有「量 .right-docks 宽度」一条：卡片渲染时机/布局分支一变就判空 → 卡片照旧右弹（用户两次反馈）。
     同时**去掉「if (!el) return」这个提前返回**：量不到卡片时也必须有结论，
     否则 effortOnLeft 会一直停在旧值（默认 false）＝ 卡片从右边弹。
     排查用：控制台看 window.__nisEffortSide（含三个判据的取值）。 */
  const dockActive = [...document.querySelectorAll('.preview-tab.tab-log, .preview-tab.tab-ws')]
    .some((t) => t.classList.contains('preview-tab-active'))
    || [...document.querySelectorAll('.right-docks')].some((d) => d.getBoundingClientRect().width > 1)
  const el = effortCardEl()
  const cardOverflow = el ? el.getBoundingClientRect().right > safeRightEdge() : false
  effortOnLeft.value = dockActive || cardOverflow
  try {
    ;(window as any).__nisEffortSide = {
      onLeft: effortOnLeft.value, dockActive, cardOverflow,
      safeEdge: safeRightEdge(), cardRight: el ? Math.round(el.getBoundingClientRect().right) : null,
    }
  } catch { /* ignore */ }
}
watch([effortOpen, effortVendor], () => {
  if (effortOpen.value && effortVendor.value) nextTick(() => recalcEffortSide())
})
/* ★ 0921 修「推理强度卡仍会被右侧栏遮挡」：
   上面那处只在"卡片刚打开"时算一次，而右栏开合是 **300ms 宽度过渡**
   （`.right-docks` 挂 `transition-[width]`）⇒ 右栏随后打开/变宽时卡片不重算，
   于是又伸进它的地盘被盖住。改法：卡片开着的期间用 ResizeObserver 跟住右栏尺寸，
   再叠 window resize / scroll 兜底；卡片关掉时全部解绑（不留监听器）。 */
let effortDockRO: ResizeObserver | null = null
function bindEffortSideWatchers(): void {
  const docks = document.querySelector('.right-docks') as HTMLElement | null
  if (docks && typeof ResizeObserver !== 'undefined' && !effortDockRO) {
    effortDockRO = new ResizeObserver(() => recalcEffortSide())
    effortDockRO.observe(docks)
  }
  window.addEventListener('resize', recalcEffortSide)
  window.addEventListener('scroll', recalcEffortSide, true)
}
function unbindEffortSideWatchers(): void {
  effortDockRO?.disconnect()
  effortDockRO = null
  window.removeEventListener('resize', recalcEffortSide)
  window.removeEventListener('scroll', recalcEffortSide, true)
}
watch(effortOpen, (open) => {
  if (open) nextTick(() => { bindEffortSideWatchers(); recalcEffortSide() })
  else unbindEffortSideWatchers()
})
onUnmounted(() => unbindEffortSideWatchers())
/* ★ 0921c：再补一道「组件更新后重算」——watcher 的 nextTick 只是"某个时机"，
   卡片首帧可能更晚（实测出现过 recalc 一次都没跑、卡片停在默认右弹）。 */
onUpdated(() => { if (effortOpen.value) recalcEffortSide() })

// Spring physics (2D: 离鼠标最近的 logo 放大)
const mouseX = ref(Infinity)
const mouseY = ref(Infinity)
const itemScales = ref<number[]>([])
const itemOffsets = ref<number[]>([])
const scaleVelocities = ref<number[]>([])
const offsetVelocities = ref<number[]>([])
let animationId: number | null = null

function ensurePhysics(len: number) {
  while (itemScales.value.length < len) {
    itemScales.value.push(1)
    itemOffsets.value.push(0)
    scaleVelocities.value.push(0)
    offsetVelocities.value.push(0)
  }
}

const SPRING_STIFFNESS = 0.06
const SPRING_DAMPING = 0.82
const MAX_SCALE = 1.4
const INFLUENCE_RADIUS = 80

function getTargetScale(index: number): number {
  if (mouseX.value === Infinity || mouseY.value === Infinity) {
    return selectedVendor.value === enabledVendors.value[index]?.id ? 1.15 : 1
  }
  const el = itemRefs.value[index]
  if (!el) return 1
  const rect = el.getBoundingClientRect()
  const cx = rect.left + rect.width / 2
  const cy = rect.top + rect.height / 2
  const dx = mouseX.value - cx
  const dy = mouseY.value - cy
  const distance = Math.sqrt(dx * dx + dy * dy)
  if (distance >= INFLUENCE_RADIUS) return 1
  const ratio = 1 - distance / INFLUENCE_RADIUS
  return 1 + (MAX_SCALE - 1) * Math.pow(ratio, 0.85)
}

function getTargetOffset(index: number): number {
  if (mouseX.value === Infinity) return 0
  const el = itemRefs.value[index]
  if (!el) return 0
  const rect = el.getBoundingClientRect()
  const center = rect.left + rect.width / 2
  const diff = center - mouseX.value
  const pushFactor = 0.2
  return diff * pushFactor
}

function animate() {
  ensurePhysics(itemRefs.value.length)
  let needsUpdate = false
  for (let i = 0; i < itemRefs.value.length; i++) {
    const scaleTarget = getTargetScale(i)
    const scaleCurrent = itemScales.value[i]
    const scaleVel = scaleVelocities.value[i]
    const scaleForce = (scaleTarget - scaleCurrent) * SPRING_STIFFNESS
    scaleVelocities.value[i] = scaleVel * SPRING_DAMPING + scaleForce
    itemScales.value[i] = scaleCurrent + scaleVelocities.value[i]

    const offsetTarget = getTargetOffset(i)
    const offsetCurrent = itemOffsets.value[i]
    const offsetVel = offsetVelocities.value[i]
    const offsetForce = (offsetTarget - offsetCurrent) * SPRING_STIFFNESS
    offsetVelocities.value[i] = offsetVel * SPRING_DAMPING + offsetForce
    itemOffsets.value[i] = offsetCurrent + offsetVelocities.value[i]

    const el = itemRefs.value[i]
    if (el) {
      el.style.transform = `scale(${itemScales.value[i]}) translateX(${itemOffsets.value[i]}px)`
    }
    if (Math.abs(scaleVelocities.value[i]) > 0.0005 || Math.abs(scaleTarget - scaleCurrent) > 0.0005) {
      needsUpdate = true
    }
    if (Math.abs(offsetVelocities.value[i]) > 0.01 || Math.abs(offsetTarget - offsetCurrent) > 0.01) {
      needsUpdate = true
    }
  }
  if (needsUpdate) {
    animationId = requestAnimationFrame(animate)
  } else {
    animationId = null
  }
  if (mouseX.value !== Infinity && mouseY.value !== Infinity && dockRef.value) {
    let closest = 0
    let closestDist = Infinity
    for (let i = 0; i < itemRefs.value.length; i++) {
      const el = itemRefs.value[i]
      if (!el) continue
      const rect = el.getBoundingClientRect()
      const cx = rect.left + rect.width / 2
      const cy = rect.top + rect.height / 2
      const dx = mouseX.value - cx
      const dy = mouseY.value - cy
      const dist = Math.sqrt(dx * dx + dy * dy)
      if (dist < closestDist) {
        closestDist = dist
        closest = i
      }
    }
    tooltipIndex.value = closestDist < 36 ? closest : -1
  } else {
    tooltipIndex.value = -1
  }
}

function startAnimation() {
  if (!animationId) {
    animationId = requestAnimationFrame(animate)
  }
}

function handleMouseMove(e: MouseEvent) {
  mouseX.value = e.clientX
  mouseY.value = e.clientY
  startAnimation()
}

function handleMouseLeave() {
  mouseX.value = Infinity
  mouseY.value = Infinity
  startAnimation()
}

function setItemRef(el: any, index: number) {
  // 允许 el 为 null（卸载时清空），避免残留已脱离 DOM 的旧元素引用
  itemRefs.value[index] = el
}

function selectModel(id: string) {
  // 同步当前供应商（模型归属的厂商）；syncGlobal=false（成员选择器）不改全局供应商状态
  let vendorId = selectedVendor.value
  /* ★1012u：selectedVendor 为空时，若选的正是**当前模型**（多半是刷新显示/程序化同步，不是在某个厂商列表里点的），
     先认权威归属 —— 否则下面那圈扫描在同名模型上会猜到别家，而这个 vendorId 会被父组件写进会话（= 真调到别家）。 */
  if (!vendorId && id && id === currentModel.value) vendorId = authoritativeVendor.value?.id || ''
  if (!vendorId) {
    const vendor = enabledVendors.value.find(v => modelsOf(v.id).some(m => m.id === id))
    if (vendor) vendorId = vendor.id
  }
  if (vendorId && props.syncGlobal !== false) providersStore.selectProvider(vendorId)
  currentModel.value = id
  // 用户点选的确切信号：id + 归属供应商（父组件据此写会话级模型覆盖，显示与发送同源）
  emit('change', id, vendorId || null)
  // 选完模型：模型列表保持打开，推理强度卡片从模型列表右侧弹出；点「完成」一起消失
  // 0910：非推理模型（可用挡位=[]）/无强度场景不弹强度卡，选完即收
  if (!hasEffort.value || !isReasoningModel.value) {
    isOpen.value = false
    selectedVendor.value = null
    return
  }
  lastPickAt = Date.now()   // ★ 见 handleClickOutside 的守卫说明
  effortVendor.value = vendorId || null
  effortFromModelSelect.value = true
  effortOpen.value = true
  // 兜底：微延迟再 assert 一次（防被瞬时误判/时序抖动关掉；用户点返回或完成时不复活）
  const seq = ++effortAssertSeq
  setTimeout(() => {
    if (seq === effortAssertSeq && effortFromModelSelect.value && !effortOpen.value) effortOpen.value = true
  }, 180)
}

function toggle() {
  isOpen.value = !isOpen.value
  effortOpen.value = false
  effortVendor.value = null
  effortFromModelSelect.value = false
  if (isOpen.value) {
    // 打开时重置弹簧状态，避免上次鼠标位置残留把圆偏移
    mouseX.value = Infinity
    mouseY.value = Infinity
    itemScales.value = enabledVendors.value.map(() => 1)
    itemOffsets.value = enabledVendors.value.map(() => 0)
    scaleVelocities.value = enabledVendors.value.map(() => 0)
    offsetVelocities.value = enabledVendors.value.map(() => 0)
    selectedVendor.value = null
  } else {
    selectedVendor.value = null
  }
}

function handleVendorClick(id: string) {
  selectedVendor.value = selectedVendor.value === id ? null : id
}

/* ★ 0921c（实测："选完模型，推理强度卡片闪出的一瞬就消失了"）：
   真实鼠标点在模型按钮上时，这一次 click 会继续冒泡到 document —— 而按模型后列表内层盒子
   会被移除（换面板），如果这一刻 DOM 已经刷新，e.target 就是**已脱离文档的节点**，
   contains() 必然 false ⇒ 被误判成"点击了外部" ⇒ 刚弹出的强度卡被立刻关掉（闪一下就没了）。
   守卫：刚选完模型后的短窗口内，click-outside 一律不处理。 */
let lastPickAt = 0
let effortAssertSeq = 0
function handleClickOutside(e: MouseEvent) {
  if (Date.now() - lastPickAt < 450) return
  const target = e.target as Node
  /* ★1012n：手机 sheet 是 Teleport 到 body 的，不在 menuRef 内 ⇒ 原来点它内部任何位置都会被
     判成"点了外部"、弹窗立刻消失（实测：「点供应商 → 界面直接没了」）。sheet 也算"内部"。 */
  if (sheetRef.value && sheetRef.value.contains(target)) return
  if (menuRef.value && !menuRef.value.contains(target)) {
    isOpen.value = false
    effortOpen.value = false
    effortVendor.value = null
    effortFromModelSelect.value = false
    selectedVendor.value = null
  }
}

onMounted(() => {
  document.addEventListener('click', handleClickOutside)
})

onUnmounted(() => {
  document.removeEventListener('click', handleClickOutside)
  if (animationId) cancelAnimationFrame(animationId)
})
</script>

<template>
  <div ref="menuRef" class="relative flex items-center">
    <!-- 触发按钮：模型名 + 头像推理强度光环（2px 彩色环 + 流光绕行，按强度取色；不占额外宽度） -->
    <button
      @click="toggle"
      class="flex items-center gap-1.5 px-2 py-1 rounded-lg hover:bg-gray-100 transition-colors"
      :title="isReasoningModel ? t('model.titleWithEffort', { label: effortMeta.label }) : t('model.title')"
    >
      <span class="relative inline-flex w-5 h-5 items-center justify-center shrink-0">
        <VendorLogo :name="noEnabled ? t('model.noProviders') : current.name" :src="noEnabled ? '/nis-logo2.png' : current.logo" :size="20" />
        <!-- uiverse 风旋转光环：双色渐变盘绕圈 + 辉光，mask 只留 2px 外圈贴紧头像边缘 -->
        <span
          v-if="isReasoningModel && !noEnabled && showEffort !== false"
          class="effort-ring"
          :style="effortRingStyle"
          aria-hidden
        ></span>
      </span>
      <span class="ms-trigger-name text-xs font-[530] text-gray-700 max-w-[140px] truncate">{{ noEnabled ? t('model.noProviders') : current.name }}</span>
    </button>

    <!-- 弹出选择器（原样式：厂商 Dock + 模型列表浮层）+ 右侧推理强度 -->
    <Transition name="dock-pop">
      <div
        v-if="isOpen"
        class="ms-pop absolute bottom-full right-0 mb-3 z-[9999]"
      >
        <div class="relative">
          <!-- 厂商 Dock（已启用供应商，两排最多 12 个） -->
          <div
            v-if="enabledVendors.length"
            ref="dockRef"
            class="flex flex-wrap items-center justify-center gap-x-1 gap-y-3 relative w-[264px]"
            @mousemove="handleMouseMove"
            @mouseleave="handleMouseLeave"
          >
          <div
            v-for="(vendor, index) in enabledVendors"
            :key="vendor.id"
            class="relative flex items-center"
          >
            <!-- Tooltip（0910 反馈1：厂商坞两排时，下排的名字气泡会撞上排头像——上排按钮 z-10
                 把无 z-index 的气泡盖住。给气泡更高层级 + 实底，保证任何一排的名字都看得清） -->
            <Transition name="tooltip">
              <div
                v-if="tooltipIndex === index"
                class="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 z-30 px-2 py-0.5 bg-gray-800 text-white text-[10px] rounded-md whitespace-nowrap shadow-lg pointer-events-none"
              >
                {{ vendor.name }}
                <div class="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-gray-800"></div>
              </div>
            </Transition>
            <!-- 厂商 logo 按钮 + 模型列表 + 推理强度卡片（从所选厂商正右侧弹出） -->
            <div class="relative">
              <button
                :ref="(el) => setItemRef(el, index)"
                @click="handleVendorClick(vendor.id)"
                :class="[
                  'w-10 h-10 flex items-center justify-center rounded-full transition-colors duration-200 relative z-10',
                  selectedVendor === vendor.id
                    ? 'bg-white shadow-md'
                    : 'bg-white/70 hover:bg-white hover:shadow-md'
                ]"
                :style="{ transform: `scale(${itemScales[index]}) translateX(${itemOffsets[index]}px)` }"
              >
                <VendorLogo :name="vendor.name" :src="vendor.logo" :size="28" />
              </button>

              <!-- 模型列表（浮层挂在厂商按钮上） -->
              <Transition name="model-pop">
                <div
                  v-if="selectedVendor === vendor.id"
                  class="ms-model-list absolute bottom-full mb-2 left-1/2 -translate-x-1/2 z-[9999]"
                >
                  <div
                    :class="['bg-white rounded-xl shadow-2xl border border-gray-200 w-[240px] overflow-hidden relative transition-opacity duration-150', { 'opacity-0 pointer-events-none': effortOpen && effortVendor === vendor.id }]"
                  >
                    <!-- Header -->
                    <div class="px-3 py-2 border-b border-gray-100 flex items-center gap-2">
                      <VendorLogo :name="vendor.name" :src="vendor.logo" :size="20" />
                      <span class="text-xs font-[530] text-gray-700">{{ vendor.name }}</span>
                    </div>
                    <!-- 模型列表 -->
                    <div class="p-1.5 max-h-[200px] overflow-y-auto">
                      <button
                        v-for="model in modelsOf(vendor.id)"
                        :key="model.id"
                        @click="selectModel(model.id)"
                        :class="[
                          'w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left transition-colors',
                          currentModel === model.id ? 'bg-blue-50' : 'hover:bg-gray-50'
                        ]"
                      >
                        <VendorLogo :name="vendor.name" :src="vendor.logo" :size="16" />
                        <div class="flex-1 min-w-0">
                          <!-- 0911 反馈3：名称截断必须落在独立文本盒——裸文本在 flex 里不吃 text-overflow，
                               长名会把右侧「多模态」徽标挤出容器右缘裁掉；徽标 shrink-0 保证完整可见 -->
                          <div class="text-[11px] font-[530] text-gray-800 flex items-center gap-1 min-w-0">
                            <span class="truncate min-w-0">{{ model.name }}</span>
                            <span
                              v-if="providersStore.isMultimodal(vendor.id, model.id)"
                              class="text-[9px] px-1 py-px rounded bg-emerald-50 text-emerald-600 border border-emerald-100 shrink-0"
                            >{{ t('model.multimodal') }}</span>
                            <span
                              v-if="providersStore.modelType(vendor.id, model.id) === 'image'"
                              class="text-[9px] px-1 py-px rounded bg-purple-50 text-purple-500 border border-purple-100 shrink-0"
                            >{{ t('model.image') }}</span>
                            <span
                              v-else-if="providersStore.modelType(vendor.id, model.id) === 'video'"
                              class="text-[9px] px-1 py-px rounded bg-cyan-50 text-cyan-500 border border-cyan-100 shrink-0"
                            >{{ t('model.video') }}</span>
                          </div>
                          <!-- 0911 反馈3：副标题去重——与主标题相同（多数供应商 name=id）时不再重复打印一行 -->
                          <div v-if="model.id !== model.name" class="text-[10px] text-gray-400 truncate">{{ model.id }}</div>
                        </div>
                        <i v-if="currentModel === model.id" class="fas fa-check text-[9px] text-blue-500"></i>
                      </button>
                    </div>
                    <!-- 箭头 -->
                    <div class="absolute bottom-0 left-1/2 -translate-x-1/2 translate-y-[5px]">
                      <div class="w-2.5 h-2.5 bg-white border-r border-b border-gray-200 transform rotate-45"></div>
                    </div>
                  </div>

                  <!-- 0921c（既定方案）：推理强度卡片改为「原地换面板」——与模型列表同一锚点，不再左右并排，彻底摆脱窗口几何依赖 -->
                  <Transition name="fade-swap">
                    <div
                      v-if="effortOpen && effortVendor === vendor.id"
                      ref="effortCardRef"
                      class="effort-card"
                      :class="'absolute bottom-0 left-1/2 -translate-x-1/2 z-[10000]'"
                    >
                      <div class="bg-white rounded-xl shadow-2xl border border-gray-200 p-3 w-[240px]">
                        <div class="flex items-center justify-between mb-2">
                          <button
                            type="button"
                            class="text-[11px] text-gray-500 hover:text-gray-900 shrink-0 px-0.5 leading-none"
                            title="返回"
                            @click="effortOpen = false; effortVendor = null; effortFromModelSelect = false"
                          ><i class="fas fa-arrow-left text-[11px]"></i></button>
                          <span class="text-[11px] font-[530] text-gray-500">{{ t('model.effort') }}</span>
                          <span class="text-[11px] font-[640]" :style="{ color: effortMeta.color }">{{ effortMeta.label }}</span>
                        </div>
                        <div :class="{ 'opacity-40 pointer-events-none': !isReasoningModel }">
                          <EffortSlider v-model="currentEffort" :width="210" :levels="currentEffortLevels" />
                        </div>
                        <p v-if="!isReasoningModel" class="text-[10px] text-gray-400 mt-2 leading-snug">{{ t('model.effortUnsupported') }}</p>
                        <button
                          class="mt-3 w-full"
                          type="button"
                          @click="
                            if (effortFromModelSelect) {
                              isOpen = false; effortOpen = false; effortVendor = null; selectedVendor = null; effortFromModelSelect = false
                            } else {
                              effortOpen = false; effortVendor = null
                            }
                          "
                        >
                          <span class="block w-full py-1.5 rounded-lg bg-gray-900 text-white text-[11px] font-[530] hover:bg-gray-700 transition-colors">{{ t('chat.completed') }}</span>
                        </button>
                      </div>
                    </div>
                  </Transition>
                </div>
              </Transition>
            </div>
          </div>
        </div>
        <div v-else class="bg-white rounded-xl shadow-2xl border border-gray-200 px-4 py-3 text-xs text-gray-400 whitespace-nowrap">
          {{ t('model.noProviders') }}
          <button
            class="ml-1.5 text-gray-700 underline underline-offset-2 hover:text-gray-900"
            @click="uiStore.openSettings('providers')"
          >{{ t('model.goSettings') }}</button>
        </div>
      </div>
      </div>
    </Transition>
  </div>

  <!-- ★1012k：手机端「居中 sheet」——用户需求四条全在这里：
       ① 供应商头像列表居中；② 点供应商 → 模型列表居中 + 左上返回；
       ③ 模型 ↔ 推理强度顶部切换（与 PC 互斥切换同口径），点模型后自动切到推理强度；
       ④ 点空白关闭（点遮罩）+ 右上 × 关闭。桌面端 v-if 恒 false，PC 零影响。 -->
  <Teleport to="body">
    <div v-if="isMobileUi && isOpen" class="ms-sheet-mask" @click.self="mobileClose()">
      <div ref="sheetRef" class="ms-sheet" @click.stop>
        <div class="ms-sheet-head">
          <button
            v-if="mobilePane !== 'vendors'"
            type="button"
            class="ms-sheet-ico"
            aria-label="返回"
            @click="mobileBack()"
          ><i class="fas fa-arrow-left"></i></button>
          <span v-else class="ms-sheet-ico ms-sheet-ico-ph"></span>
          <span class="ms-sheet-title">{{ mobilePane === 'vendors' ? '选择供应商' : mobilePane === 'effort' ? '推理强度' : (activeVendorName || '选择模型') }}</span>
          <button type="button" class="ms-sheet-ico" aria-label="关闭" @click="mobileClose()"><i class="fas fa-times"></i></button>
        </div>

        <!-- ① 供应商页：与 PC 厂商 Dock **同一套标记**（圆头像 40px + VendorLogo 28） -->
        <div v-if="mobilePane === 'vendors'" class="ms-sheet-pane">
          <div v-if="enabledVendors.length" class="flex flex-wrap items-center justify-center gap-x-2 gap-y-3 py-1">
            <button
              v-for="vendor in enabledVendors"
              :key="vendor.id"
              type="button"
              @click="mobilePickVendor(vendor.id)"
              :class="[
                'w-10 h-10 flex items-center justify-center rounded-full transition-colors duration-200',
                selectedVendor === vendor.id ? 'bg-white shadow-md' : 'bg-white/70 hover:bg-white hover:shadow-md'
              ]"
            >
              <VendorLogo :name="vendor.name" :src="vendor.logo" :size="28" />
            </button>
          </div>
          <div v-else class="ms-sheet-empty">
            {{ t('model.noProviders') }}
            <button type="button" class="ms-sheet-link" @click="mobileClose(); uiStore.openSettings('providers')">{{ t('model.goSettings') }}</button>
          </div>
        </div>

        <!-- ② 模型页：与 PC 模型列表卡片 **同一套标记**（Header + 多模态/图片/视频徽标 + id 副标题 + 勾） -->
        <div v-else-if="mobilePane === 'models'" class="ms-sheet-pane">
          <!-- ★1012o：去掉内层卡片的 border/shadow —— 原来「外层 sheet 卡片 + 内层白卡」两层边框看着脏 -->
          <div class="w-full overflow-hidden">
            <div class="px-3 py-2 border-b border-gray-100 flex items-center gap-2">
              <VendorLogo :name="activeVendorName" :src="activeVendorLogo" :size="20" />
              <span class="text-xs font-[530] text-gray-700">{{ activeVendorName || '选择供应商' }}</span>
              <!-- ★1012n：供应商列表退为二级 —— 从模型页这里进去换供应商 -->
              <button
                type="button"
                class="ml-auto shrink-0 text-[11px] text-gray-500 px-2 py-0.5 rounded-md border border-gray-200 hover:bg-gray-50"
                @click="mobilePane = 'vendors'"
              >切换供应商</button>
            </div>
            <div class="p-1.5 max-h-[46vh] overflow-y-auto">
              <button
                v-for="model in modelsOf(selectedVendor || '')"
                :key="model.id"
                type="button"
                @click="mobilePickModel(model.id)"
                :class="[
                  'w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left transition-colors',
                  currentModel === model.id ? 'bg-blue-50' : 'hover:bg-gray-50'
                ]"
              >
                <VendorLogo :name="activeVendorName" :src="activeVendorLogo" :size="16" />
                <div class="flex-1 min-w-0">
                  <div class="text-[11px] font-[530] text-gray-800 flex items-center gap-1 min-w-0">
                    <span class="truncate min-w-0">{{ model.name || model.id }}</span>
                    <span v-if="providersStore.isMultimodal(selectedVendor || '', model.id)" class="text-[9px] px-1 py-px rounded bg-emerald-50 text-emerald-600 border border-emerald-100 shrink-0">{{ t('model.multimodal') }}</span>
                    <span v-if="providersStore.modelType(selectedVendor || '', model.id) === 'image'" class="text-[9px] px-1 py-px rounded bg-purple-50 text-purple-500 border border-purple-100 shrink-0">{{ t('model.image') }}</span>
                    <span v-else-if="providersStore.modelType(selectedVendor || '', model.id) === 'video'" class="text-[9px] px-1 py-px rounded bg-cyan-50 text-cyan-500 border border-cyan-100 shrink-0">{{ t('model.video') }}</span>
                  </div>
                  <div v-if="model.id !== model.name" class="text-[10px] text-gray-400 truncate">{{ model.id }}</div>
                </div>
                <i v-if="currentModel === model.id" class="fas fa-check text-[9px] text-blue-500"></i>
              </button>
            </div>
          </div>
        </div>

        <!-- ③ 推理强度页：与 PC 强度卡 **同一套标记** + 完成按钮（参考图） -->
        <div v-else class="ms-sheet-pane">
          <!-- ★1012o：同上，去掉内层卡片 border/shadow，只留一层 -->
          <div class="w-full px-1">
            <div class="flex items-center justify-between mb-2">
              <span class="text-[11px] font-[530] text-gray-500">{{ t('model.effort') }}</span>
              <span class="text-[11px] font-[640]" :style="{ color: effortMeta.color }">{{ effortMeta.label }}</span>
            </div>
            <div :class="{ 'opacity-40 pointer-events-none': !isReasoningModel }">
              <EffortSlider v-model="currentEffort" :width="300" :levels="currentEffortLevels" />
            </div>
            <p v-if="!isReasoningModel" class="text-[10px] text-gray-400 mt-2 leading-snug">{{ t('model.effortUnsupported') }}</p>
            <button type="button" class="ms-sheet-done" @click="mobileClose()">完成</button>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
/* ★1012k：手机端居中 sheet（供应商 → 模型/推理强度切换） */
.ms-sheet-mask {
  position: fixed;
  inset: 0;
  z-index: 10020;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  padding-bottom: calc(16px + env(safe-area-inset-bottom, 0px));
  background: rgba(0, 0, 0, 0.35);
}
.ms-sheet {
  width: min(94vw, 420px);
  max-height: 76vh;
  display: flex;
  flex-direction: column;
  background: #ffffff;
  border-radius: 16px;
  overflow: hidden;
  box-shadow: 0 24px 60px -20px rgba(0, 0, 0, 0.35);
}
.ms-sheet-head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid rgba(0, 0, 0, 0.06);
}
.ms-sheet-ico {
  flex: none;
  width: 30px; height: 30px;
  border: none; border-radius: 9999px;
  background: rgba(0, 0, 0, 0.05);
  color: #374151;
  display: inline-flex; align-items: center; justify-content: center;
  cursor: pointer;
}
.ms-sheet-ico-ph { background: transparent; pointer-events: none; }
.ms-sheet-title {
  flex: 1; min-width: 0;
  font-size: 13px; font-weight: 600; color: #18181b;
  text-align: center;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.ms-sheet-pane { overflow-y: auto; padding: 12px; }
.ms-sheet-vendors {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(86px, 1fr));
  gap: 10px;
}
.ms-sheet-vendor {
  display: flex; flex-direction: column; align-items: center; gap: 6px;
  padding: 10px 6px;
  border: 1px solid rgba(0, 0, 0, 0.06);
  border-radius: 12px;
  background: #ffffff;
  cursor: pointer;
}
.ms-sheet-vendor:active { background: rgba(0, 0, 0, 0.04); }
.ms-sheet-vname {
  font-size: 11px; color: #52525b; max-width: 100%;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.ms-sheet-empty { font-size: 12px; color: #71717a; padding: 8px 4px; }
.ms-sheet-link {
  margin-left: 6px; border: none; background: none; cursor: pointer;
  color: #18181b; text-decoration: underline;
}
.ms-sheet-tabs { display: flex; gap: 6px; margin-bottom: 10px; }
.ms-sheet-tabs button {
  flex: 1; padding: 7px 0;
  border: 1px solid rgba(0, 0, 0, 0.08);
  border-radius: 10px;
  background: #ffffff;
  font-size: 12px; color: #52525b;
  cursor: pointer;
}
.ms-sheet-tabs button.on { background: #18181b; border-color: #18181b; color: #ffffff; }
.ms-sheet-model {
  width: 100%;
  display: flex; align-items: center; gap: 8px;
  padding: 9px 10px;
  border: none; border-radius: 10px;
  background: transparent;
  font-size: 12px; color: #27272a; text-align: left;
  cursor: pointer;
}
.ms-sheet-model.on { background: rgba(99, 102, 241, 0.08); }
.ms-sheet-mname { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ms-sheet-check { color: #4f46e5; font-size: 11px; }
.ms-sheet-effort { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 4px 2px 8px; }
.ms-sheet-effort-meta { display: flex; align-items: center; gap: 8px; font-size: 12px; color: #52525b; }
.ms-sheet-hint { font-size: 11px; color: #a1a1aa; text-align: center; }
/* ★1012o：sheet 现在是白底一层 —— 厂商圆头像（PC 用半透明白底）给一道细边，避免"白上白"看不清 */
.ms-sheet .ms-sheet-pane button.rounded-full { border: 1px solid rgba(0, 0, 0, 0.07); }
html.dark .ms-sheet .ms-sheet-pane button.rounded-full { border-color: rgba(255, 255, 255, 0.12); }
/* 推理强度页「完成」（用户参考图的底部按钮） */
.ms-sheet-done {
  margin-top: 12px;
  width: 100%;
  padding: 11px 0;
  border: none;
  border-radius: 12px;
  background: #18181b;
  color: #ffffff;
  font-size: 13px;
  font-weight: 540;
  cursor: pointer;
}
.ms-sheet-done:active { opacity: 0.88; }
html.dark .ms-sheet-done { background: #e9e9ef; color: #101014; }
html.dark .ms-sheet { background: #141418; }
html.dark .ms-sheet-head { border-bottom-color: #2a2a30; }
html.dark .ms-sheet-title { color: #e9e9ef; }
html.dark .ms-sheet-ico { background: rgba(255, 255, 255, 0.08); color: #c9c9d1; }
html.dark .ms-sheet-vendor { background: #1b1b20; border-color: #2a2a30; }
html.dark .ms-sheet-vname { color: #a1a1aa; }
html.dark .ms-sheet-tabs button { background: #1b1b20; border-color: #2a2a30; color: #c9c9d1; }
html.dark .ms-sheet-tabs button.on { background: #e9e9ef; border-color: #e9e9ef; color: #101014; }
html.dark .ms-sheet-model { color: #d8d8de; }
html.dark .ms-sheet-model.on { background: rgba(129, 140, 248, 0.14); }

/* 0921c（需求）：返回/选完都做渐隐渐显 —— 纯 opacity 过渡，不带任何位移，避免"向上闪" */
.fade-swap-enter-active,
.fade-swap-leave-active {
  transition: opacity 0.16s ease;
}
.fade-swap-enter-from,
.fade-swap-leave-to {
  opacity: 0;
}

.dock-pop-enter-active {
  animation: dockPopIn 0.25s cubic-bezier(0.34, 1.56, 0.64, 1) both;
}
.dock-pop-leave-active {
  animation: dockPopOut 0.12s ease-in both;
}

@keyframes dockPopIn {
  from {
    opacity: 0;
    transform: translateY(10px) scale(0.92);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

@keyframes dockPopOut {
  from {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
  to {
    /* 0921c：原先退场带位移（translateY(10px) scale(0.92)）——换面板时视觉上会"跳一下"；改成纯淡出 */
    opacity: 0;
    transform: translateY(0) scale(0.97);
  }
}
/* 0921c：孤儿 keyframe 块已清除（上一步块提取只截到 from 段） */

.tooltip-enter-active {
  transition: opacity 0.15s ease;
}
.tooltip-leave-active {
  transition: opacity 0.1s ease;
}
.tooltip-enter-from,
.tooltip-leave-to {
  opacity: 0;
}

.model-pop-enter-active {
  animation: modelPopIn 0.2s cubic-bezier(0.34, 1.56, 0.64, 1) both;
  transform-origin: bottom center;
}
.model-pop-leave-active {
  animation: modelPopOut 0.15s ease-in both;
  transform-origin: bottom center;
}

@keyframes modelPopIn {
  from {
    opacity: 0;
    transform: translateY(8px) scale(0.95);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

@keyframes modelPopOut {
  from {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
  to {
    opacity: 0;
    transform: translateY(8px) scale(0.95);
  }
}

/* 头像推理强度光环：1px 细描边线（旋转 conic 渐变头亮尾暗）贴紧 20px 头像外缘，
   后方一圈低透明轻模糊辉光做扩散。mask 用绝对半径（相对盒），环带压在 logo 圆边缘 10→11px。
   父元素不 mask（各伪元素自带），盒 32px 容纳辉光不裁平。绝对定位不增占位。 */
.effort-ring {
  position: absolute;
  inset: -6px;
  border-radius: 50%;
  pointer-events: none;
}
.effort-ring::before {
  /* 扩散层（静止垫底）：贴近边缘的一圈柔和辉光，低透明不外溢 */
  content: "";
  position: absolute;
  inset: 0;
  border-radius: 50%;
  background: conic-gradient(from 0deg, var(--ring-b), var(--ring-a));
  filter: blur(2.5px);
  opacity: 0.5;
  -webkit-mask: radial-gradient(circle, transparent 10px, #000 11.5px 12.5px, transparent 14.5px);
  mask: radial-gradient(circle, transparent 10px, #000 11.5px 12.5px, transparent 14.5px);
}
.effort-ring::after {
  /* 描边层（旋转）：1px 细环，双色 conic 明暗绕行 */
  content: "";
  position: absolute;
  inset: 0;
  border-radius: 50%;
  background: conic-gradient(from 0deg, var(--ring-b), var(--ring-a) 45%, var(--ring-fade) 75%, var(--ring-b));
  filter: blur(0.6px);
  animation: effort-orbit var(--ring-dur, 2.4s) linear infinite;
  -webkit-mask: radial-gradient(circle, transparent 10px, #000 10.3px 11.3px, transparent 11.6px);
  mask: radial-gradient(circle, transparent 10px, #000 10.3px 11.3px, transparent 11.6px);
}
@keyframes effort-orbit {
  to { transform: rotate(360deg); }
}
</style>
