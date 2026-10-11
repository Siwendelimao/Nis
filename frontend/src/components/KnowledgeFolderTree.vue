<script setup lang="ts">
import { ref, computed } from 'vue'
import { useKnowledgeStore } from '@/stores/knowledge'

/**
 * 知识库分类树（递归渲染，`<script setup>` 组件可用文件名自引用）。
 * 每个分类节点下显示子分类 + 条目（叶子）：
 *   - 分类：点击过滤星系（emit select），箭头展开/收起
 *   - 条目：点击选中详情（emit selectEntry）
 * 展开状态由组件内部维护；根分类默认展开。
 */
const props = defineProps<{
  folderId: string
  depth: number
  activeFolder: string | null
  activeEntryId: string | null
}>()

const emit = defineEmits<{
  select: [id: string]
  selectEntry: [id: string]
}>()

const store = useKnowledgeStore()

const expanded = ref(true)

const children = computed(() =>
  store.childrenOf(props.folderId).filter(c => c.entry_type === 'folder'),
)
const entries = computed(() =>
  store.childrenOf(props.folderId).filter(c => c.entry_type !== 'folder'),
)
const hasChildren = computed(() => children.value.length > 0)
const entryCount = computed(() => {
  let count = entries.value.length
  for (const f of children.value) count += store.entryIdsUnder(f.id).size
  return count
})

function toggle() {
  expanded.value = !expanded.value
}
</script>

<template>
  <div class="mb-0.5">
    <div
      :class="[
        'flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs cursor-pointer transition-colors',
        activeFolder === folderId ? 'bg-black text-white font-semibold' : 'text-gray-600 hover:bg-gray-100',
      ]"
      @click="emit('select', folderId)"
    >
      <button
        @click.stop="toggle"
        class="w-3 h-3 flex items-center justify-center text-[8px] opacity-70 hover:opacity-100"
      >
        <i :class="expanded && hasChildren ? 'fas fa-chevron-down' : 'fas fa-chevron-right'"></i>
      </button>
      <i class="fas fa-folder text-[10px]"></i>
      <span class="flex-1 truncate">{{ store.getEntry(folderId)?.title }}</span>
      <span class="text-[9px] opacity-60">{{ entryCount }}</span>
    </div>

    <div v-if="expanded" class="ml-3 pl-1.5 border-l border-gray-200">
      <!-- 子分类（递归） -->
      <KnowledgeFolderTree
        v-for="sub in children"
        :key="sub.id"
        :folder-id="sub.id"
        :depth="depth + 1"
        :active-folder="activeFolder"
        :active-entry-id="activeEntryId"
        @select="emit('select', $event)"
        @select-entry="emit('selectEntry', $event)"
      />
      <!-- 条目（叶子） -->
      <div
        v-for="e in entries"
        :key="e.id"
        :class="[
          'flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs cursor-pointer transition-colors',
          activeEntryId === e.id ? 'bg-black/5 text-gray-900 font-medium' : 'text-gray-500 hover:bg-gray-100 hover:text-gray-700',
        ]"
        @click="emit('selectEntry', e.id)"
      >
        <i class="fas fa-file-lines text-[9px]"></i>
        <span class="flex-1 truncate">{{ e.title }}</span>
      </div>
    </div>
  </div>
</template>
