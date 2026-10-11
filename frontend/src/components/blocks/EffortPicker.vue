<script setup lang="ts">
import { computed } from 'vue'
import { useProvidersStore } from '@/stores/providers'
import { t } from '@/utils/i18n'

/**
 * 推理强度选择器（紧凑分段式）—— 供「全局模型」与非对话场景（提炼/知识库/记忆/定时任务）使用。
 *
 * 2026-09-12 用户拍板：凡是**非对话**场合选模型的，都要能选推理强度。
 *  - 对话窗口本来就跟着 ModelSelector 一起选（那是另一套 UI），这里不重复。
 *  - 与对话窗口同一套语义：可用挡位来自 providersStore.modelEfforts（与后端 resolveModelEfforts 一致）。
 *
 * 三种状态：
 *   · 模型不支持思考（可用挡位为空）→ **整个控件不渲染**（没有"强度"可选，不摆空架子）；
 *   · 档位只有一个 → 也不渲染（没有可选空间）；
 *   · 正常 → 渲染 N 段（fast/deep/heavy/burning 的子集）。
 *
 * 0913 新增 `readonly`：**只读投影** —— 显示值但不响应点击。
 * 用于「跟随（后台模型）」的场景：强度由「设置 → 人格 → 后台模型」决定，这里只如实投射，不许就地改。
 * （★1013b 口径更新：以前写的是"跟随全局模型"—— 全局模型已从 UI 拿掉，渠道/定时任务现在跟的都是后台模型。）
 */
const props = withDefaults(defineProps<{
  modelValue?: string | null
  providerId?: string
  modelId?: string
  /** 紧凑模式（设置行内用） */
  compact?: boolean
  /** 只读投影：只显示、不可点（跟随全局时用） */
  readonly?: boolean
}>(), { modelValue: null, providerId: '', modelId: '', compact: true, readonly: false })

const emit = defineEmits<{ (e: 'update:modelValue', v: string | null): void }>()

const providersStore = useProvidersStore()

/** 该模型可用的挡位（空 = 不支持思考 → 不渲染控件） */
const levels = computed<string[]>(() => {
  if (!props.providerId || !props.modelId) return []
  try { return providersStore.modelEfforts(props.providerId, props.modelId) || [] } catch { return [] }
})

/** 展示用元信息：短名 + 颜色（与 ModelSelector 同一套语义，取中文短名更适合设置行） */
const META: Record<string, { short: string; color: string; title: string }> = {
  fast: { short: '快', color: '#10B981', title: '低强度：最快，适合简单问答' },
  deep: { short: '中', color: '#3B82F6', title: '中强度：默认，速度与质量平衡' },
  heavy: { short: '高', color: '#EF4444', title: '高强度：更慢但更细致，适合复杂推理' },
  burning: { short: '极', color: '#8B5CF6', title: '极高：最慢最强，适合难题深挖' },
}

/** 当前值（0914 用户定稿）：**默认「中」、不可取消**。
 *  - 未指定（空值/不在可用集）→ 高亮「中」（与后端 rawEffort 兜底 'deep' 一致）；
 *    该模型没有「中」挡（少见）时回落第一个可用挡。
 *  - 不再支持"再点取消"——点已选挡 = 保持选中，视图上不会出现无选中态。 */
const DEFAULT_LEVEL = 'deep'
const current = computed<string>(() => {
  const v = String(props.modelValue || '')
  if (levels.value.includes(v)) return v
  if (levels.value.includes(DEFAULT_LEVEL)) return DEFAULT_LEVEL
  return levels.value[0] || ''
})

function pick(v: string) {
  if (props.readonly) return
  // 0914：不可取消——点当前挡也是"保持当前挡"。
  emit('update:modelValue', v)
}

const visible = computed(() => levels.value.length > 1)
</script>

<template>
  <div v-if="visible" class="eff-seg" :class="{ 'is-compact': compact, 'is-readonly': readonly }">
    <button
      v-for="lv in levels"
      :key="lv"
      type="button"
      class="eff-seg-btn"
      :class="{ 'is-on': current === lv }"
      :style="current === lv ? { background: META[lv]?.color, borderColor: META[lv]?.color } : {}"
      :title="readonly ? t('effort.followGlobalHint') : t('effort.pickHint') + (META[lv]?.title || lv)"
      @click="pick(lv)"
    >{{ META[lv]?.short || lv }}</button>
  </div>
</template>

<style scoped>
.eff-seg {
  display: inline-flex;
  /* 0912 反馈：要和并排的模型选择器**等高** —— 外层用 items-stretch 拉伸，
     内部按钮跟着撑满（原来 align-items:center 时胶囊只有 24px，比下拉矮一截）。 */
  align-items: stretch;
  gap: 3px;
  padding: 2px;
  border-radius: 8px;
  background: #f3f4f6;
}
.eff-seg-btn {
  min-width: 26px;
  padding: 3px 7px;
  border-radius: 6px;
  border: 1px solid transparent;
  background: transparent;
  color: #6b7280;
  font-size: 11px;
  font-weight: 600;
  line-height: 1.3;
  cursor: pointer;
  transition: all 0.15s ease;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.eff-seg-btn:hover { background: #e5e7eb; color: #111827; }
.eff-seg-btn.is-on { color: #fff; }
.eff-seg-btn.is-on:hover { filter: brightness(1.06); }

/* 只读投影（跟随全局）：能看清当前挡，但按不动、也没有 hover 反馈 */
.eff-seg.is-readonly,
.eff-seg.is-readonly .eff-seg-btn { cursor: default; }
.eff-seg.is-readonly .eff-seg-btn:hover { background: transparent; color: #6b7280; }
.eff-seg.is-readonly .eff-seg-btn.is-on:hover { background: #fff; filter: none; }
.eff-seg.is-readonly .eff-seg-btn.is-on { color: #fff; }

/* 深色（0912 反馈「深色背景适配优化」）：底色对齐 MiniSelect 触发器的 #202027，
   用 inset 阴影补一圈描边（不占位、不与模型选择器错位），未选文字提亮一档保证对比度。
   ⚠️ 选择器写法必须是 `html.dark .x`（不能用 `:global(html.dark) .x` —— 本项目的
   scoped 编译下后者不生效，实测胶囊一直是浅色底）。 */
html.dark .eff-seg {
  background: #202027;
  box-shadow: inset 0 0 0 1px #2e2e36;
}
html.dark .eff-seg-btn { color: #a6a6b0; }
html.dark .eff-seg-btn:hover { background: #2e2e36; color: #f2f2f6; }
html.dark .eff-seg-btn.is-on { color: #fff; }
html.dark .eff-seg.is-readonly .eff-seg-btn:hover { background: transparent; color: #a6a6b0; }
</style>
