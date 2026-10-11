<script setup lang="ts">
/**
 * KnowledgeScopePicker —— ★0930 知识库项目绑定（客服铺垫）
 * 勾选「组（分类文件夹）/ 单条条目」= 该项目可读的知识范围（归属制：打 project_id，过滤由内核做）。
 * v-model = { cats, entryIds }；**空 = 不限（全库可见）**。
 * 天花板（ponytail）：归属单归属——同一条知识同一时间只属于一个项目；共享需升级为 scope 关系表。
 */
import { computed, onMounted } from 'vue'
import { useKnowledgeStore, type KnowledgeScopeSel } from '@/stores/knowledge'
import { t } from '@/utils/i18n'

const props = defineProps<{ modelValue: KnowledgeScopeSel }>()
const emit = defineEmits<{ (e: 'update:modelValue', v: KnowledgeScopeSel): void }>()
const store = useKnowledgeStore()
onMounted(() => { if (!store.loaded) void store.refresh() })

const groups = computed(() => store.entries.filter(e => e.entry_type === 'folder'))
const childrenOf = (fid: string) => store.entries.filter(e => e.parent_id === fid && e.entry_type !== 'folder')
const loose = computed(() => store.entries.filter(e => e.entry_type !== 'folder' && !e.parent_id))

function has(list: 'cats' | 'entryIds', id: string): boolean {
  return (props.modelValue && props.modelValue[list] || []).includes(id)
}
function toggle(list: 'cats' | 'entryIds', id: string) {
  const cur = (props.modelValue && props.modelValue[list]) || []
  const next = cur.includes(id) ? cur.filter(x => x !== id) : [...cur, id]
  emit('update:modelValue', { ...(props.modelValue || { cats: [], entryIds: [] }), [list]: next })
}
</script>

<template>
  <div>
    <label class="block text-[12px] text-gray-500 mb-1">{{ t('sidebar.knowledgeScope') }}</label>
    <div class="max-h-40 overflow-y-auto custom-scroll rounded-lg border border-gray-200 px-2 py-1.5 space-y-0.5">
      <div v-if="!store.entries.length" class="text-[11px] text-gray-400 py-1">{{ t('sidebar.knowledgeScopeEmpty') }}</div>
      <template v-for="g in groups" :key="g.id">
        <label class="flex items-center gap-1.5 px-1 py-0.5 rounded hover:bg-gray-50 cursor-pointer text-[12px]">
          <input type="checkbox" :checked="has('cats', g.id)" @change="toggle('cats', g.id)" />
          <i class="fas fa-folder text-[10px] text-amber-400"></i>
          <span class="truncate">{{ g.title }}</span>
        </label>
        <label v-for="c in childrenOf(g.id)" :key="c.id" class="flex items-center gap-1.5 pl-6 pr-1 py-0.5 rounded hover:bg-gray-50 cursor-pointer text-[12px]">
          <input type="checkbox" :checked="has('entryIds', c.id)" @change="toggle('entryIds', c.id)" />
          <span class="truncate text-gray-600">{{ c.title }}</span>
        </label>
      </template>
      <label v-for="e in loose" :key="e.id" class="flex items-center gap-1.5 px-1 py-0.5 rounded hover:bg-gray-50 cursor-pointer text-[12px]">
        <input type="checkbox" :checked="has('entryIds', e.id)" @change="toggle('entryIds', e.id)" />
        <i class="fas fa-file-lines text-[10px] text-gray-300"></i>
        <span class="truncate text-gray-600">{{ e.title }}</span>
      </label>
    </div>
    <p class="text-[10px] text-gray-400 mt-1">{{ t('sidebar.knowledgeScopeHint') }}</p>
  </div>
</template>
