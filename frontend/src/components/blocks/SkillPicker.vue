<script setup lang="ts">
/**
 * SkillPicker —— 输入框工具栏的技能选择入口
 * 支持多选：选中项黑色背景、取消同步移除输入框标签、输入框删除标签同步取消选中。
 * 0904 反馈②：行内只显示名称+备注；悬停在面板右侧弹气泡看 名称+备注+完整描述。
 */
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { WandSparkles } from 'lucide-vue-next'
import { useChatStore } from '@/stores/chat'
import { useSettingsStore } from '@/stores/settings'
import { t } from '@/utils/i18n'
import { localStore } from '@/utils/localStore'

const chatStore = useChatStore()
const settingsStore = useSettingsStore()

interface SkillItem {
  name: string
  description: string
}

const open = ref(false)
const skills = ref<SkillItem[]>([])
const appliedSkills = ref<string[]>([])
const panelRef = ref<HTMLElement | null>(null)
const loading = ref(false)
/** 悬停行 → 右侧详情气泡内容（null=不显示） */
const hoverSkill = ref<SkillItem | null>(null)

/* ★ 0921z：「未启用的技能不可选」——
 *  · 停用的技能（技能仓库里关掉的那些）不进候选：AI 那边根本调不到，列出来只会让人白点；
 *  · 主开关（允许 AI 自主选用技能）关掉时，这个入口整体失效（后端 use_skill 会拒绝），
 *    列表换成一行解释——比"能点但点了没用"诚实。
 *  状态读 settingsStore（和后端判定同一份数据），在仓库里拨完开关，这里即时跟着变。 */
const autoSelectOn = computed(() => settingsStore.general.skillAutoSelect !== false)
const visibleSkills = computed(() => skills.value.filter(s => settingsStore.isSkillEnabled(s.name)))
const hiddenCount = computed(() => skills.value.length - visibleSkills.value.length)

/* 技能备注（与 SkillsModal 同源：localStorage nis-skill-notes；行内与气泡里备注、描述各显示各的，0904 反馈②） */
const skillNotes = ref<Record<string, string>>({})
function loadNotes() {
  // 对象校验：历史版本曾把 "undefined" 字符串写进该 key（SkillsModal ref(fn) bug），解析失败/非对象一律置空
  try {
    const raw = JSON.parse(localStore.getItem('nis-skill-notes') || '{}')
    skillNotes.value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  } catch { skillNotes.value = {} }
}

async function load() {
  if (skills.value.length > 0) return
  loading.value = true
  try {
    const res = await chatStore.bridgeRpc('skill.list')
    if (Array.isArray(res?.skills)) skills.value = res.skills
  } catch (e) {
    console.error('[SkillPicker] load failed:', e)
  } finally {
    loading.value = false
  }
}

function toggle() {
  open.value = !open.value
  if (open.value) {
    loadNotes()
    void load()
  }
}

function toggleSkill(s: SkillItem) {
  const idx = appliedSkills.value.indexOf(s.name)
  if (idx >= 0) {
    appliedSkills.value.splice(idx, 1)
    window.dispatchEvent(new CustomEvent('nis-skill-remove', { detail: { name: s.name } }))
  } else {
    appliedSkills.value.push(s.name)
    window.dispatchEvent(new CustomEvent('nis-skill-select', { detail: { name: s.name } }))
  }
}

/* 输入框里删除了 skill 标签 → 同步取消选中 */
function onSkillTagRemoved(e: Event) {
  const name = (e as CustomEvent).detail?.name as string
  if (!name) return
  const idx = appliedSkills.value.indexOf(name)
  if (idx >= 0) appliedSkills.value.splice(idx, 1)
}

function onDocDown(e: MouseEvent) {
  const target = e.target as HTMLElement | null
  if (!target) return
  if (panelRef.value?.contains(target)) return
  open.value = false
}

onMounted(() => {
  document.addEventListener('mousedown', onDocDown, true)
  window.addEventListener('nis-skill-tag-removed', onSkillTagRemoved)
})
onUnmounted(() => {
  document.removeEventListener('mousedown', onDocDown, true)
  window.removeEventListener('nis-skill-tag-removed', onSkillTagRemoved)
})
</script>

<template>
  <div ref="panelRef" class="relative">
    <button
      @click="toggle"
      class="p-2 hover:bg-gray-100 rounded-full transition-colors relative"
      :title="appliedSkills.length ? t('skill.skillsList', { names: appliedSkills.join(', ') }) : t('settings.tabs.skills')"
    >
      <WandSparkles :size="16" stroke-width="1.75" :class="appliedSkills.length ? 'text-green-600' : 'text-gray-600'" />
    </button>

    <Transition name="cmd-pop">
      <div v-if="open" class="tool-popover absolute bottom-full left-0 mb-2 w-60 bg-white rounded-xl shadow-xl border border-gray-200 py-2 z-[9999] max-h-[360px] overflow-y-auto custom-scroll">
        <div class="px-3 py-1.5">
          <span class="text-[10px] font-[530] text-gray-400 uppercase tracking-wider">{{ t('skill.repo') }}</span>
        </div>
        <div v-if="loading && !skills.length" class="px-3 py-4 text-center text-xs text-gray-400">{{ t('skill.loading') }}</div>
        <!-- ★ 0921z-2（用户修正）：主开关关掉 ≠ 不能用 —— 那是"AI 不会主动挑"，
             用户在这里手选的技能照样生效（手动 = 用户意志）。所以列表照常渲染。 -->
        <div v-else-if="!visibleSkills.length" class="px-3 py-4 text-center text-xs text-gray-400">{{ skills.length ? t('skills.pickerAllOff') : t('skill.empty') }}</div>
        <template v-else>
          <button
            v-for="(s, i) in visibleSkills"
            :key="s.name"
            class="cmd-item w-full flex items-start gap-3 px-3 py-2 text-left transition-colors group"
            :class="appliedSkills.includes(s.name) ? 'bg-gray-900 text-white' : 'hover:bg-gray-900 hover:text-white text-gray-900'"
            :style="{ animationDelay: open ? (i * 40) + 'ms' : '0ms' }"
            @click="toggleSkill(s)"
            @mouseenter="hoverSkill = s"
            @mouseleave="hoverSkill = null"
          >
            <span class="min-w-0 flex-1">
              <span class="block text-xs font-[530] truncate">{{ s.name }}</span>
              <!-- 行内只显示备注（0904 反馈②）；无备注只留名称行，描述收进悬停气泡 -->
              <span v-if="skillNotes[s.name]" class="block text-[10px] leading-tight mt-0.5 line-clamp-2 group-hover:text-gray-300" :class="appliedSkills.includes(s.name) ? 'text-gray-300' : 'text-gray-400'">{{ skillNotes[s.name] }}</span>
            </span>
          </button>
          <!-- 有技能被停用时说明一句，免得用户以为技能"丢了" -->
          <div v-if="hiddenCount" class="px-3 pt-1.5 mt-1 border-t border-gray-100 text-[10px] text-gray-400 leading-snug">
            {{ t('skills.pickerHidden', { n: hiddenCount }) }}
          </div>
          <!-- ★ 0921z-2：主开关关掉时提示"AI 不会主动挑，但手动勾选算数" -->
          <div v-if="!autoSelectOn" class="px-3 pt-1.5 mt-1 border-t border-gray-100 text-[10px] text-amber-600 leading-snug">
            {{ t('skills.pickerAutoOff') }}
          </div>
        </template>
      </div>
    </Transition>

    <!-- 悬停详情气泡（面板右侧，深色卡片）：名称+备注+完整描述（0904 反馈②） -->
    <Transition name="skill-tip">
      <div
        v-if="open && hoverSkill"
        class="absolute left-[248px] bottom-0 w-72 max-h-[360px] overflow-y-auto custom-scroll bg-gray-900 text-white rounded-xl shadow-2xl px-4 py-3 z-[9998] pointer-events-none"
      >
        <div class="text-[12px] font-[640]">{{ hoverSkill.name }}</div>
        <div v-if="skillNotes[hoverSkill.name]" class="text-[11px] text-gray-300 mt-1 leading-snug">{{ skillNotes[hoverSkill.name] }}</div>
        <div class="text-[11px] text-gray-400 mt-1.5 leading-relaxed whitespace-pre-wrap">{{ hoverSkill.description || t('skill.noDesc') }}</div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
/* 弹出/收合/条目滑入与 QuickCommands 完全同款（0904 反馈：两个下拉风格对齐快捷命令） */
.cmd-pop-enter-active {
  animation: popIn 0.25s cubic-bezier(0.34, 1.56, 0.64, 1) both;
}
.cmd-pop-leave-active {
  animation: popOut 0.15s ease-in both;
}
@keyframes popIn {
  from { opacity: 0; transform: translateY(8px) scale(0.92); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}
@keyframes popOut {
  from { opacity: 1; transform: translateY(0) scale(1); }
  to { opacity: 0; transform: translateY(8px) scale(0.92); }
}
.cmd-pop-enter-active .cmd-item {
  animation: itemSlide 0.3s cubic-bezier(0.34, 1.56, 0.64, 1) both;
}
@keyframes itemSlide {
  from { opacity: 0; transform: translateX(-6px); }
  to { opacity: 1; transform: translateX(0); }
}
/* 悬停详情气泡：淡入淡出 + 右侧轻移 */
.skill-tip-enter-active { transition: opacity 0.16s ease, transform 0.16s ease; }
.skill-tip-leave-active { transition: opacity 0.12s ease; }
.skill-tip-enter-from { opacity: 0; transform: translateX(-4px); }
.skill-tip-leave-to { opacity: 0; }
</style>