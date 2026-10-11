<script setup lang="ts">
/**
 * TeamMemberPanel —— 标签栏「成员」按钮弹出的面板（团队模式会话可见）。
 * 放大版：成员列表（点成员进入编辑：职责/模型/技能多选）+ 黑板进度（"谁正在做"高亮）。
 * 编辑保存走 teams.save（后端 team.json 落盘，团队编辑热更新随 ④ 遗留项处理）。
 */
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { useTeamsStore, type TeamMember } from '@/stores/teams'
import { useConversationsStore } from '@/stores/conversations'
import { useAgentPresetsStore } from '@/stores/agentPresets'
import { useChatStore } from '@/stores/chat'
import { useProvidersStore } from '@/stores/providers'
import { useSettingsStore } from '@/stores/settings'
import { Users, X, Check, Pencil } from 'lucide-vue-next'
import MiniSelect from './blocks/MiniSelect.vue'
import MiniMultiSelect from './blocks/MiniMultiSelect.vue'
import { t } from '@/utils/i18n'
import { localStore } from '@/utils/localStore'

const teamsStore = useTeamsStore()
const conversationsStore = useConversationsStore()
const agentPresetsStore = useAgentPresetsStore()
const chatStore = useChatStore()
const providersStore = useProvidersStore()
const settingsStore = useSettingsStore()

const open = ref(false)
const rootRef = ref<HTMLElement | null>(null)
const blackboard = ref<any>(null)
/** 编辑中的成员 id（null=列表态） */
const editingId = ref<string | null>(null)
const editDraft = ref<{ role: string; modelMode: 'shared' | 'independent'; modelId: string; effort: string; capability: string; maxInstances: number; skills: string[] } | null>(null)
/** 0910 三批②/③：模型档位 + 同时派出上限（与 Agent 弹窗团队模式同源，两处改任一处都同步到 team.json） */
const capabilityOptions = computed(() => [
  { value: 'standard', label: t('agent.capability.standard'), desc: t('agent.capability.standardDesc') },
  { value: 'fast', label: t('agent.capability.fast'), desc: t('agent.capability.fastDesc') },
  { value: 'strong', label: t('agent.capability.strong'), desc: t('agent.capability.strongDesc') },
  { value: 'auto', label: t('agent.capability.auto'), desc: t('agent.capability.autoDesc') },
])
const instanceOptions = computed(() => [
  { value: '1', label: t('agent.instances.n1'), desc: t('agent.instances.n1Desc') },
  { value: '2', label: t('agent.instances.n2'), desc: t('agent.instances.n2Desc') },
  { value: '3', label: t('agent.instances.n3'), desc: t('agent.instances.n3Desc') },
])
const saving = ref(false)
const saveTip = ref('')
const saveTipError = ref(false)
/** 0910 反馈3：保存后立即回列表，用列表顶部的一条轻提示确认（比"按钮闪一下"明确） */
const savedTip = ref('')
let savedTipTimer: ReturnType<typeof setTimeout> | null = null
function flashSaved() {
  savedTip.value = t('team.saved')
  if (savedTipTimer) clearTimeout(savedTipTimer)
  savedTipTimer = setTimeout(() => { savedTip.value = '' }, 2000)
}
onUnmounted(() => { if (savedTipTimer) clearTimeout(savedTipTimer) })

/* ── 模型/推理强度选项（与 Agent 弹窗团队模式同款下拉：MiniSelect，读共享 providers store） ── */
const memberModelOptions = computed(() => {
  const out: Array<{ value: string; label: string; desc?: string; group?: string }> = []
  for (const p of providersStore.enabledProviders) {
    for (const mo of (providersStore.models[p.id] || []).filter(x => x.enabled)) {
      out.push({ value: mo.id, label: mo.name || mo.id, desc: mo.id, group: p.name })
    }
  }
  return out
})
/** 该模型 id 是否能在"已启用且有 key"的供应商里解析到（不可用 → 实际会回退会话模型，编辑区给红字提示）。
 *  与后端 resolveTeamMemberModel 同一判据（供应商 enabled + 有 key/base），避免"面板显示可用、实际回退"的错位。 */
function modelUsable(id: string): boolean {
  const mid = String(id || '').trim()
  if (!mid) return false
  return providersStore.enabledProviders.some(p => providersStore.isProviderReady(p.id) && (providersStore.models[p.id] || []).some(m => m.id === mid))
}
const editModelUnusable = computed(() => {
  const d = editDraft.value
  return !!d && d.modelMode === 'independent' && !!d.modelId.trim() && !modelUsable(d.modelId.trim())
})
/** 当前选中模型的可用思考挡位（与后端 resolveModelEfforts 同语义；空=非推理模型不显示强度） */
const editEffortLevels = computed<string[]>(() => {
  const d = editDraft.value
  if (!d || d.modelMode !== 'independent' || !d.modelId) return []
  const vendor = providersStore.enabledProviders.find(p => (providersStore.models[p.id] || []).some(m => m.id === d.modelId))
  if (!vendor) return []
  return providersStore.modelEfforts(vendor.id, d.modelId)
})
const EFFORT_LABELS: Record<string, string> = { fast: 'Low', deep: 'Mid', heavy: 'High', burning: 'Max' }
const editEffortOptions = computed(() => editEffortLevels.value.map(v => ({ value: v, label: EFFORT_LABELS[v] || v, desc: v })))
/** 列表态：成员模型的不可用标记（独立模型名不在任何已启用供应商里） */
function memberModelBad(m: any): boolean {
  return m.modelMode === 'independent' && !!String(m.modelId || '').trim() && !modelUsable(m.modelId)
}
/** 技能仓库（skill.list） */
const allSkills = ref<Array<{ name: string; description: string }>>([])
/** ★ 0921z：「未启用的技能不可选」——技能仓库里停用的技能不进成员配置候选
 *  （停了就是 AI 调不到，让成员挂上去只会以为配好了却不生效）。
 *  读 settingsStore，仓库里拨开关后这里即时跟着变。 */
const enabledSkills = computed(() => allSkills.value.filter(sk => settingsStore.isSkillEnabled(sk.name)))
/** 技能备注（与 SkillsModal/SkillPicker 同源：localStorage nis-skill-notes，备注优先于描述显示） */
const skillNotes = ref<Record<string, string>>({})
function loadNotes() {
  try {
    const raw = JSON.parse(localStore.getItem('nis-skill-notes') || '{}')
    skillNotes.value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  } catch { skillNotes.value = {} }
}
/** 列表展示文案：备注优先于描述（两列宽度有限，取首行截断） */
function skillDesc(s: { name: string; description: string }): string {
  const note = skillNotes.value[s.name]
  const text = (note || s.description || '').split('\n')[0]
  return text || t('team.noDesc')
}
/** 弹窗 fixed 定位（Teleport 到 body，脱离标签栏 overflow 裁切）：展开时按触发器实测 */
const panelPos = ref<{ left: number; top: number } | null>(null)

const PANEL_W = 520

function measurePanel() {
  const el = rootRef.value
  if (!el) return
  const rect = el.getBoundingClientRect()
  const margin = 8
  let left = rect.right - PANEL_W
  if (left < margin) left = margin
  if (left + PANEL_W > window.innerWidth - margin) left = window.innerWidth - margin - PANEL_W
  // 视口 clamp：面板估算高 ~620px，按钮在屏幕底部（标签栏）时下方放不下 → 弹到按钮上方，
  // 否则面板整个落在屏幕外（"点击无效没弹窗"的根因）
  const estH = 620
  let top = rect.bottom + 8
  if (top + estH > window.innerHeight - margin) {
    const above = rect.top - estH - 8
    top = above > margin ? above : Math.max(margin, window.innerHeight - estH - margin)
  }
  panelPos.value = { left, top }
}

function togglePanel() {
  open.value = !open.value
  if (open.value) {
    measurePanel()
    // 保险：store 为空（预载失败/被清）时拉一次团队清单
    if (teamsStore.teams.length === 0) void teamsStore.load()
    loadBlackboard()
    loadSkills()
  }
}

async function loadSkills() {
  if (allSkills.value.length) return
  try {
    const v = await chatStore.bridgeRpc('skill.list', {})
    allSkills.value = v?.skills || []
  } catch { allSkills.value = [] }
  loadNotes()
}

const conv = computed(() => conversationsStore.getById(String(conversationsStore.activeConversationId ?? '')) as any)
const team = computed(() => (conv.value?.teamId ? teamsStore.teams.find(t => t.id === conv.value.teamId) : null))

const members = computed(() =>
  (team.value?.members || []).map(m => ({
    ...m,
    name: agentPresetsStore.presets.find(p => p.id === m.preset)?.name || m.preset,
    desc: m.role || agentPresetsStore.presets.find(p => p.id === m.preset)?.description || '',
    // 0913 头像批：成员预设头像（未设置 → 空串，列表回退「渐变+首字」默认头像）
    avatar: agentPresetsStore.avatarOf(m.preset) || '',
  })),
)

/** 预设技能展示已随"技能会话级化"删除（presetSkills）——技能不再来自预设/团队配置 */

/** 黑板步骤状态（session/blackboard 帧 + 打开时拉一次会话） */
const stepStats = computed(() => {
  const bb = blackboard.value
  if (!bb?.steps?.length) return null
  const total = bb.steps.length
  const done = bb.steps.filter((s: any) => s.status === 'done').length
  const running = bb.steps.filter((s: any) => s.status === 'running')
  return {
    total, done, running,
    goal: bb.goal || '',
    lines: bb.steps.map((s: any) => ({ id: s.id, status: s.status, text: s.text, owner: s.owner })),
  }
})

/** 正在执行该成员步骤的成员 id 集合（"谁正在做"高亮） */
const runningOwners = computed(() => {
  const bb = blackboard.value
  if (!bb?.steps) return new Set<string>()
  return new Set(bb.steps.filter((s: any) => s.status === 'running').map((s: any) => String(s.owner)))
})

/** 成员技能数（会话级覆盖，新对话默认 0——技能不再来自团队配置/预设） */
function skillCount(m: any): number {
  const arr = convSkills.value[m.id]
  return Array.isArray(arr) ? arr.length : 0
}

async function loadBlackboard() {
  if (!conv.value?.id) { blackboard.value = null; return }
  try {
    const v = await chatStore.bridgeRpc('blackboard.read', { sessionId: String(conv.value.id) })
    blackboard.value = v?.blackboard || null
  } catch { blackboard.value = null }
}
// 实时黑板帧
function onFrame(frame: any) {
  const p = frame?.payload
  if (p?.type === 'session/blackboard' && p.sessionId === String(conversationsStore.activeConversationId ?? '')) {
    blackboard.value = p.blackboard
  }
}
// 切会话必须清黑板残留 + 重拉（否则新会话显示上一个团队的任务进度徽章 5/5，点开才消失）
watch(() => conversationsStore.activeConversationId, () => {
  blackboard.value = null
  loadBlackboard()
  loadConvSkills()
})
onMounted(() => {
  chatStore.onMessage(onFrame)
  loadBlackboard()
  loadConvSkills()
  // 团队清单为空时拉取（否则 team=null → 按钮根本不渲染——刷新后无其他入口触发 load）
  if (teamsStore.teams.length === 0) void teamsStore.load()
})
onUnmounted(() => chatStore.offMessage(onFrame))

function onDocClick(e: MouseEvent) {
  // 用事件路径快照判断（不能用 e.target + closest：点成员行后 Vue 同步重渲染会替换 DOM，
  // target 脱离文档树导致 closest 断链 → 误判"点在外面"关闭面板）
  const path = ((e as any).composedPath?.() || []) as Node[]
  if (path.some(n => n === rootRef.value)) return
  if (open.value && path.some(n => (n as HTMLElement)?.classList?.contains?.('team-panel-popover'))) return
  // 0910：面板内的下拉（MiniSelect 弹层 Teleport 到 body，不在 rootRef 里）也不能算"点在外面"——
  // 否则选模型/挡位时整块成员面板会被一起关掉
  if (open.value && path.some(n => (n as HTMLElement)?.classList?.contains?.('mini-panel'))) return
  open.value = false
  editingId.value = null
}
onMounted(() => document.addEventListener('click', onDocClick))
onUnmounted(() => document.removeEventListener('click', onDocClick))

/* ── 成员编辑（模型/推理强度用 MiniSelect：与 Agent 弹窗团队模式同款下拉，读共享 providers store） ── */

/** 会话级成员技能（memberId → 技能名）：新对话默认空，勾选保存只影响本会话 */
const convSkills = ref<Record<string, string[]>>({})
async function loadConvSkills() {
  if (!conv.value?.id) { convSkills.value = {}; return }
  try {
    const v = await chatStore.bridgeRpc('session.memberSkills', { sessionId: String(conv.value.id) })
    convSkills.value = v?.memberSkills && typeof v.memberSkills === 'object' ? v.memberSkills : {}
  } catch { convSkills.value = {} }
}

function openEdit(m: any) {
  editingId.value = m.id
  editDraft.value = {
    role: String(m.role || ''),
    modelMode: m.modelMode === 'independent' ? 'independent' : 'shared',
    modelId: String(m.modelId || ''),
    effort: String(m.effort || ''),
    capability: String(m.capability || 'standard'),
    maxInstances: Number(m.maxInstances) || 1,
    skills: [...(convSkills.value[m.id] || [])],
  }
  saveTip.value = ''
  loadNotes()
}

async function saveEdit() {
  const t = team.value
  const d = editDraft.value
  if (!t || !d || !editingId.value) return
  saving.value = true
  saveTip.value = ''
  try {
    // 技能是会话级覆盖（新对话默认空）：保存走 session.memberSkills RPC，不进团队配置——
    // 团队是全局共享的，写 team.json 会跨项目/会话继承技能（0901 反馈 #6 根因）
    const members = t.members.map(m => {
      if (m.id !== editingId.value) return m
      const patch: Partial<TeamMember> = {
        role: d.role.trim() || undefined,
        modelMode: d.modelMode,
        modelId: d.modelMode === 'independent' ? (d.modelId.trim() || undefined) : undefined,
        // 0910 反馈3：独立模型的推理强度随成员落盘（后端 createStreamFn 按模型能力钳位）
        effort: d.modelMode === 'independent' ? (d.effort || undefined) : undefined,
        // 0910 三批②/③：模型档位 + 成员同时派出上限（落 team.json，与 Agent 弹窗团队模式全局同步）
        capability: d.capability || 'standard',
        maxInstances: Math.max(1, Math.min(3, Number(d.maxInstances) || 1)),
      }
      return { ...m, ...patch }
    })
    await teamsStore.saveTeam({ ...t, members })
    await chatStore.bridgeRpc('session.memberSkills', {
      sessionId: String(conv.value.id),
      memberId: editingId.value,
      skills: [...d.skills],
    })
    // 立即刷新会话级技能缓存（否则列表"1 技能"徽章要等刷新页面才出现）
    await loadConvSkills()
    // 0910 反馈3：保存即回列表 + 顶部轻提示（旧版停在编辑页 700ms 才退，用户只看到按钮闪一下）
    saveTip.value = ''
    saveTipError.value = false
    editingId.value = null
    editDraft.value = null
    flashSaved()
  } catch (e: any) {
    saveTip.value = t('team.saveFail', { msg: String(e?.message || e) })
    saveTipError.value = true
  } finally {
    saving.value = false
  }
}

function cancelEdit() {
  editingId.value = null
  editDraft.value = null
  saveTip.value = ''
}

/** 成员头像渐变（与 SubAgentBlock 同算法，观感一致） */
function avatarGradient(id: string): string {
  const palettes = [
    'linear-gradient(135deg, #0ea5e9 0%, #6366f1 100%)',
    'linear-gradient(135deg, #f59e0b 0%, #ef4444 100%)',
    'linear-gradient(135deg, #10b981 0%, #14b8a6 100%)',
    'linear-gradient(135deg, #ec4899 0%, #8b5cf6 100%)',
  ]
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return palettes[h % palettes.length]
}

const STATUS_TEXT: Record<string, string> = {
  pending: 'team.statusPending', running: 'chat.inProgress', review: 'team.statusReview', done: 'chat.completed', rejected: 'team.statusRejected', failed: 'chat.failed',
}
</script>

<template>
  <div v-if="team" ref="rootRef" class="relative flex items-center">
    <button
      type="button"
      class="member-tab-btn"
      :class="{ 'member-tab-active': open }"
      :title="t('team.membersOf', { name: team.name })"
      @click.stop="togglePanel"
    >
      <Users :size="12" stroke-width="1.8" />
      <span>{{ t('chat.member') }}</span>
      <span class="member-progress-badge" :title="t('team.membersOf', { name: team.name })">{{ members.length }}</span>
    </button>

    <Teleport to="body">
      <Transition name="member-panel-pop">
        <div
          v-if="open && panelPos"
          class="team-panel-popover fixed bg-white rounded-xl shadow-xl border border-gray-200 z-[10030] overflow-hidden"
          :style="{ left: panelPos.left + 'px', top: panelPos.top + 'px', width: PANEL_W + 'px', maxHeight: 'calc(100vh - 16px)', overflowY: 'auto' }"
        >
          <!-- 头部 -->
          <div class="px-4 py-2.5 border-b border-gray-100 bg-gray-50">
            <div class="flex items-center justify-between">
              <span class="text-[12px] font-[640] text-gray-800">{{ team.name }}</span>
              <span class="text-[10px] text-gray-400">{{ team.mode === 'auto' ? t('team.auto') : team.mode === 'serial' ? t('team.serial') : t('team.parallel') }} · {{ t('team.parallelN', { n: team.maxParallel }) }}</span>
            </div>
            <div v-if="stepStats?.goal" class="text-[10px] text-gray-400 mt-1 truncate">{{ t('team.goalLabel') }}{{ stepStats.goal }}</div>
          </div>

          <!-- 成员列表 / 编辑区：编辑态独立容器（不滚动，表单+固定按钮一屏呈现；
               列表态才用限高滚动）——编辑态困在滚动容器里按钮仍需下滑的根因修复 -->
          <div v-if="editingId && editDraft" class="px-2 py-2">
            <div v-for="m in members.filter(x => x.id === editingId)" :key="m.id" class="flex flex-col">
              <div class="flex items-center gap-2.5 mb-2.5 shrink-0">
                <div class="w-8 h-8 rounded-full flex items-center justify-center text-white text-[12px] font-bold shrink-0" :style="{ background: avatarGradient(m.id) }">{{ (m.name || t('team.initial')).slice(0, 1) }}</div>
                <div class="text-[13px] font-[640] text-gray-800">{{ m.name }}</div>
                <button type="button" class="ml-auto w-6 h-6 rounded-md hover:bg-gray-100 flex items-center justify-center text-gray-400" @click="cancelEdit"><X :size="14" /></button>
              </div>
              <div class="space-y-2.5">
                <div>
                  <div class="text-[11px] font-[530] text-gray-500 mb-1">{{ t('team.roleLabel') }}</div>
                  <textarea
                    v-model="editDraft.role"
                    rows="2"
                    :placeholder="t('team.rolePlaceholder')"
                    class="w-full text-[12px] border border-gray-200 rounded-lg px-2.5 py-1.5 outline-none focus:border-indigo-300 resize-none"
                  ></textarea>
                </div>
                <div>
                  <div class="text-[11px] font-[530] text-gray-500 mb-1">{{ t('conversation.model') }}</div>
                  <div class="flex items-center gap-1.5 mb-1.5">
                    <button
                      type="button"
                      class="px-2.5 py-1 rounded-md text-[11px] border transition-colors"
                      :class="editDraft.modelMode === 'shared' ? 'bg-gray-900 text-white border-gray-900' : 'bg-white text-gray-600 border-gray-200 hover:border-gray-400'"
                      @click="editDraft.modelMode = 'shared'"
                    >{{ t('team.followSession') }}</button>
                    <button
                      type="button"
                      class="px-2.5 py-1 rounded-md text-[11px] border transition-colors"
                      :class="editDraft.modelMode === 'independent' ? 'bg-gray-900 text-white border-gray-900' : 'bg-white text-gray-600 border-gray-200 hover:border-gray-400'"
                      @click="editDraft.modelMode = 'independent'"
                    >{{ t('team.independentModel') }}</button>
                  </div>
                  <!-- 0910 反馈3：与 Agent 弹窗团队模式同款的下拉模型选择（替代原厂商坞选择器） -->
                  <template v-if="editDraft.modelMode === 'independent'">
                    <MiniSelect
                      v-model="editDraft.modelId"
                      :options="memberModelOptions"
                      :placeholder="t('team.followSessionEmpty')"
                    />
                    <div v-if="editModelUnusable" class="text-[10px] text-red-500 mt-1 leading-snug">{{ t('team.modelUnavailable') }}</div>
                    <!-- 推理强度：仅推理模型显示（挡位清单来自 providers store，与后端 resolveModelEfforts 同源） -->
                    <div v-if="editEffortLevels.length" class="mt-1.5">
                      <div class="text-[10px] text-gray-400 mb-1">{{ t('team.effortLabel') }}</div>
                      <MiniSelect
                        v-model="editDraft.effort"
                        :options="[{ value: '', label: t('team.effortDefault'), desc: 'deep' }, ...editEffortOptions]"
                      />
                    </div>
                  </template>
                </div>
                <!-- 0910 三批②/③：模型档位 + 同时派出上限（与 Agent 弹窗团队模式同源，改动全局同步） -->
                <div>
                  <div class="flex items-center gap-2">
                    <MiniSelect v-model="editDraft.capability" :options="capabilityOptions" class="flex-1 min-w-0" />
                    <MiniSelect
                      :model-value="String(editDraft.maxInstances || 1)"
                      :options="instanceOptions"
                      class="flex-1 min-w-0"
                      @update:model-value="(v) => (editDraft.maxInstances = Number(v) || 1)"
                    />
                  </div>
                </div>
                <div>
                  <!-- ★ 0921z：候选只含"已启用"技能（停用的在技能仓库里开回来才会出现）；
                       有被停用的就在标题后跟一句计数，免得用户以为技能"丢了" -->
                  <div class="text-[11px] font-[530] text-gray-500 mb-1">
                    {{ t('team.skillsLabel') }}
                    <span v-if="allSkills.length > enabledSkills.length" class="text-gray-300 font-normal">{{ t('skills.hiddenCount', { n: allSkills.length - enabledSkills.length }) }}</span>
                  </div>
                  <!-- 0910 二批②：技能由内联复选列表改为下拉多选（与模型/强度下拉同风格） -->
                  <MiniMultiSelect
                    v-model="editDraft.skills"
                    :options="enabledSkills.map(sk => ({ value: sk.name, label: sk.name, desc: skillDesc(sk) }))"
                    :placeholder="t('team.skillsEmpty')"
                  />
                </div>
              </div>
              <div class="flex items-center gap-2 pt-2 shrink-0 edit-form-footer">
                <button
                  type="button"
                  class="px-3 py-1.5 rounded-lg text-[12px] font-[530] text-white bg-gray-900 hover:bg-black disabled:opacity-50 transition-colors"
                  :disabled="saving"
                  @click="saveEdit"
                >{{ saving ? t('team.saving') : t('plugins.save') }}</button>
                <button type="button" class="btn btn-secondary btn-sm" @click="cancelEdit">{{ t('chat.cancel') }}</button>
                <span v-if="saveTip" class="text-[11px]" :class="saveTipError ? 'text-red-500' : 'text-green-600'">{{ saveTip }}</span>
              </div>
            </div>
          </div>
          <!-- 列表态 -->
          <div v-else class="max-h-[340px] overflow-y-auto custom-scroll p-2">
            <!-- 0910 反馈3：保存成功的轻提示（保存即回列表，原按钮闪一下没有明确反馈） -->
            <div v-if="savedTip" class="mx-1 mb-1.5 px-2.5 py-1 rounded-lg bg-green-50 text-green-600 text-[11px] flex items-center gap-1.5">
              <Check :size="12" stroke-width="3" />{{ savedTip }}
            </div>
            <div
              v-for="m in members"
              :key="m.id"
              class="flex items-start gap-2.5 px-2 py-2 rounded-lg hover:bg-gray-50 cursor-pointer group"
              :class="{ 'is-working': runningOwners.has(m.id) }"
              :title="t('team.clickEdit', { name: m.name })"
              @click="openEdit(m)"
            >
              <!-- 0913 头像批：预设头像优先；未设置回退「渐变+首字」默认头像 -->
              <img v-if="m.avatar" :src="m.avatar" alt="" class="w-7 h-7 rounded-full object-cover shrink-0" />
              <div v-else class="w-7 h-7 rounded-full flex items-center justify-center text-white text-[11px] font-bold shrink-0" :style="{ background: avatarGradient(m.id) }">{{ (m.name || t('team.initial')).slice(0, 1) }}</div>
              <div class="flex-1 min-w-0">
                <div class="text-[12px] text-gray-800 font-[530] truncate flex items-center gap-1.5">
                  {{ m.name }}
                  <span v-if="runningOwners.has(m.id)" class="working-badge">{{ t('team.working') }}</span>
                  <Pencil v-else :size="10" class="text-gray-200 group-hover:text-gray-400 transition-colors" />
                </div>
                <div class="text-[10px] text-gray-400 truncate">{{ m.desc }}</div>
              </div>
              <div class="flex flex-col items-end gap-0.5 shrink-0">
                <span class="text-[9px] px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-500">{{ m.modelMode === 'independent' ? t('team.independentModel') : t('team.followSession') }}</span>
                <!-- 0910 反馈5：配置的独立模型已不可用 → 明确警示（实际会跑会话模型） -->
                <span v-if="memberModelBad(m)" class="text-[9px] px-1.5 py-0.5 rounded-full bg-red-50 text-red-500" :title="t('team.modelUnavailable')">{{ t('team.modelUnavailableBadge') }}</span>
                <span v-if="skillCount(m)" class="text-[9px] px-1.5 py-0.5 rounded-full bg-indigo-50 text-indigo-500">{{ t('team.skillCount', { n: skillCount(m) }) }}</span>
              </div>
            </div>
          </div>

          <!-- 黑板进度（0911 反馈8：编辑成员设置时不显示，编辑态整屏留给表单） -->
          <div v-if="stepStats && !editingId" class="border-t border-gray-100 px-4 py-2.5 bg-gray-50/60">
            <div class="text-[10px] font-[640] text-gray-500 mb-1.5">{{ t('team.blackboard') }} {{ stepStats.done }}/{{ stepStats.total }}</div>
            <div class="space-y-1 max-h-[150px] overflow-y-auto custom-scroll">
              <div
                v-for="s in stepStats.lines"
                :key="s.id"
                class="flex items-center gap-1.5 text-[10px] px-1.5 py-0.5 rounded-md"
                :class="{ 'bg-blue-50': s.status === 'running' }"
              >
                <span class="status-dot" :data-status="s.status"></span>
                <span class="truncate flex-1 text-gray-600">{{ s.text }}</span>
                <span class="shrink-0" :class="s.status === 'running' ? 'text-blue-500 font-[530]' : 'text-gray-400'">
                  {{ s.status === 'running' ? t('team.ownerWorking', { name: members.find(m => m.id === s.owner)?.name || s.owner }) : t(STATUS_TEXT[s.status] || s.status) }}
                </span>
              </div>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
/* 成员按钮：对齐 PreviewTabBar 的胶囊 tab 观感（自包含样式——父组件 scoped 样式不作用于子组件） */
.member-tab-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 12px;
  font-size: 12px;
  color: #6b7280;
  border-radius: 9999px;
  border: 1px solid transparent;
  cursor: pointer;
  white-space: nowrap;
  user-select: none;
  background: transparent;
  transition: all 0.15s ease;
}
.member-tab-btn:hover {
  color: #111827;
  background: #eef0f2;
  border-color: #e5e7eb;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.06);
}
.member-tab-active {
  color: #ffffff;
  font-weight: 500;
  background: #111827;
  border-color: #111827;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);
}
.member-progress-badge {
  font-size: 9px;
  padding: 0 6px;
  border-radius: 999px;
  background: rgba(16, 185, 129, 0.12);
  color: #10b981;
  font-weight: 500;
}
.member-tab-active .member-progress-badge {
  background: rgba(255, 255, 255, 0.18);
  color: #ffffff;
}
/* "正在做"高亮 */
.member-row-working,
:deep(.is-working) {
  background: rgba(79, 110, 247, 0.06);
}
.is-working {
  background: rgba(79, 110, 247, 0.06);
}
.working-badge {
  font-size: 9px;
  padding: 0 5px;
  border-radius: 999px;
  background: rgba(79, 110, 247, 0.12);
  color: #4f6ef7;
  font-weight: 500;
  animation: workingPulse 1.4s ease-in-out infinite;
}
@keyframes workingPulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.55; }
}
.status-dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #b8bcc4;
}
.status-dot[data-status='running'] {
  background: #4f6ef7;
  animation: pulse 1.4s ease-in-out infinite;
}
.status-dot[data-status='review'] {
  background: #f59e0b;
}
.status-dot[data-status='done'] {
  background: #10b981;
}
.status-dot[data-status='rejected'],
.status-dot[data-status='failed'] {
  background: #ef4444;
}
/* 编辑区：不滚动容器 + 技能列表限高内滚（唯一滚动条）+ 底部按钮常驻 */
.skill-scroll {
  max-height: 150px;
}
.edit-form-footer {
  border-top: 1px solid #f3f4f6;
  margin-top: 8px;
  background: #ffffff;
}
@keyframes pulse {
  0%, 100% { opacity: 0.45; }
  50% { opacity: 1; }
}
.member-panel-pop-enter-active { transition: opacity 0.15s ease, transform 0.15s ease; }
.member-panel-pop-leave-active { transition: opacity 0.1s ease; }
.member-panel-pop-enter-from,
.member-panel-pop-leave-to { opacity: 0; transform: translateY(-4px); }
</style>
