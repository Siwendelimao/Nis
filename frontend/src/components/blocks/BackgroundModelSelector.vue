<script setup lang="ts">
import { computed } from 'vue'
import { useProvidersStore } from '@/stores/providers'
import MiniSelect, { type MiniOption } from './MiniSelect.vue'
import EffortPicker from './EffortPicker.vue'
import { t } from '@/utils/i18n'

/**
 * 「**后台模型**」选择器 —— 「设置 → 通用 → 模型 → 后台模型」。
 *
 * 为什么单独一个（用户原话）："这个全局模型我本想的就是作为一个**对话之外的工作模型**，
 * 能不能把他们分开"。之前的病根是"全局模型会跟着对话切换模型而改变"。
 *
 * 用途：知识库/记忆库**自动提炼**、QQ/微信渠道（**未单独配模型**时）等"对话之外"的活。
 * 对话场景一律不看它（对话 = 会话级模型 → 全局聊天模型）。
 *
 * ★1013（已定案，两条）：
 *  ① **留空不再回落聊天模型** —— "想用免费模型做后台任务，自动回落却回到贵的模型上，等于偷用户的钱"。
 *     留空时这里显示醒目提醒，后台任务会**明确失败 + 发系统通知**，把用户请回来选一个。
 *  ② 右侧增加**推理强度**选择器（参考图）：后台模型有自己一套强度，与聊天强度解耦。
 */
const providersStore = useProvidersStore()

/** 选项：只列**启用**供应商下的**文本型**模型；按供应商名分组（与全局模型选择器同一套规则） */
const options = computed<MiniOption[]>(() => {
  const out: MiniOption[] = []
  for (const p of providersStore.providers) {
    if (!p.enabled) continue
    const models = (providersStore.models[p.id] || []).filter(
      m => m.enabled && providersStore.modelType(p.id, m.id) === 'text',
    )
    for (const m of models) {
      out.push({
        value: `${p.id}::${m.id}`,
        label: m.name || m.id,
        desc: m.id,
        group: p.name || p.id,
      })
    }
  }
  return out
})

/** 当前值（provider::model）；未设置 → 空串 */
const value = computed(() => {
  const pid = providersStore.backgroundProviderId
  const mid = providersStore.backgroundModelId
  return pid && mid ? `${pid}::${mid}` : ''
})

/** 选中即写后端（后端会广播给所有窗口）；不提供"清除"按钮，改选即可覆盖 */
function onSelect(v: string) {
  const [pid, ...rest] = String(v || '').split('::')
  const mid = rest.join('::')
  if (!pid || !mid) return
  void providersStore.setBackgroundModel(pid, mid)
}

/** ★1013：后台模型自己的推理强度（'' = 不指定，按模型默认挡） */
const effort = computed<string | null>(() => providersStore.backgroundEffort || null)
/** 该模型有可选挡位才显示强度行（与 EffortPicker 自身判据一致） */
const effortVisible = computed(() =>
  providersStore.modelEfforts(providersStore.backgroundProviderId, providersStore.backgroundModelId).length > 1,
)
function onEffort(v: string | null) {
  void providersStore.setBackgroundModel(
    providersStore.backgroundProviderId,
    providersStore.backgroundModelId,
    v,
  )
}

const emptyHint = computed(() =>
  options.value.length ? '' : t('settings.persona.extractModelEmpty'),
)
/** ★1013：未配置的醒目提醒 —— 后台任务会失败（不再悄悄用聊天模型顶上） */
const missing = computed(() => !providersStore.backgroundProviderId || !providersStore.backgroundModelId)
</script>

<template>
  <div class="flex flex-col gap-1.5 shrink-0">
    <div class="flex items-stretch gap-2">
      <div class="w-[190px] shrink-0">
        <MiniSelect
          :model-value="value"
          :options="options"
          :placeholder="t('settings.persona.backgroundModelPick')"
          width="w-full"
          @update:model-value="onSelect"
        />
      </div>
      <!-- ★1013：后台模型的推理强度（模型不支持思考时不渲染） -->
      <div v-if="effortVisible" class="shrink-0 flex">
        <EffortPicker
          :model-value="effort"
          :provider-id="providersStore.backgroundProviderId"
          :model-id="providersStore.backgroundModelId"
          @update:model-value="onEffort"
        />
      </div>
    </div>
    <p v-if="missing" class="text-[10px] text-rose-500 leading-tight">{{ t('settings.persona.backgroundModelMissing') }}</p>
    <p v-else-if="emptyHint" class="text-[10px] text-amber-500 leading-tight">{{ emptyHint }}</p>
  </div>
</template>
