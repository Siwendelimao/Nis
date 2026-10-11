<script setup lang="ts">
/**
 * WorkspaceNode —— 工作区文件树递归节点。
 * 独立 SFC（编译型模板）：曾尝试同文件内运行时 template 字符串，
 * runtime-only Vue 不支持编译导致整棵组件树渲染崩溃。
 */
import { computed, getCurrentInstance } from 'vue'

interface WTreeNode { name: string; type: 'file' | 'folder'; children?: WTreeNode[] }

const props = defineProps<{
  node: WTreeNode
  base: string
  depth: number
  expanded: Record<string, boolean>
}>()

const emit = defineEmits<{
  (e: 'toggle', node: WTreeNode, base: string): void
  (e: 'menu', node: WTreeNode, base: string, e: MouseEvent): void
  (e: 'open-file', path: string): void
}>()

const path = computed(() => (props.base ? `${props.base}/${props.node.name}` : props.node.name))
const isFolder = computed(() => props.node.type === 'folder' || !!props.node.children?.length)
const isOpen = computed(() => props.expanded[path.value] === true)

function onMenu(e: MouseEvent) {
  emit('menu', props.node, props.base, e)
}
// 自引用递归：setup 内通过 instance 引用自身组件
const self = getCurrentInstance()
const SelfRef = computed(() => self ? (self.type as any) : undefined)
</script>

<template>
  <div>
    <div
      class="flex items-center gap-1.5 px-1.5 py-1 rounded-md hover:bg-gray-50 cursor-pointer select-none transition-colors"
      :style="{ paddingLeft: (6 + depth * 14) + 'px' }"
      @click="isFolder ? emit('toggle', node, base) : undefined"
      @dblclick="isFolder ? undefined : emit('open-file', path)"
      @contextmenu.prevent="onMenu"
    >
      <i v-if="isFolder" :class="['fas text-[9px] text-gray-300 w-3 transition-transform duration-150', isOpen ? 'fa-chevron-down' : 'fa-chevron-right']"></i>
      <i v-else class="w-3"></i>
      <i :class="['fas text-[11px]', isFolder ? 'fa-folder text-amber-400' : 'fa-file-lines text-gray-300']"></i>
      <span class="text-[12px] text-gray-700 truncate">{{ node.name }}</span>
    </div>
    <Transition name="ws-collapse">
      <div v-if="isFolder && isOpen" class="ws-collapse-inner">
        <component
          :is="SelfRef"
          v-for="c in node.children || []"
          :key="c.name"
          :node="c" :base="path" :depth="depth + 1" :expanded="expanded"
          @toggle="(n: any, b: string) => emit('toggle', n, b)"
          @menu="(n: any, b: string, e: MouseEvent) => emit('menu', n, b, e)"
          @open-file="(p: string) => emit('open-file', p)"
        />
      </div>
    </Transition>
  </div>
</template>

<style scoped>
/* 展开/折叠动画：grid-rows 0fr→1fr（高度自适应，max-height 方案内容超高会被裁） */
.ws-collapse-enter-active,
.ws-collapse-leave-active {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows 0.18s ease, opacity 0.15s ease;
}
.ws-collapse-enter-to,
.ws-collapse-leave-from {
  grid-template-rows: 1fr;
}
.ws-collapse-enter-from,
.ws-collapse-leave-to {
  grid-template-rows: 0fr;
  opacity: 0;
}
.ws-collapse-enter-active,
.ws-collapse-leave-active {
  opacity: 1;
}
.ws-collapse-inner {
  overflow: hidden;
  min-height: 0;
  border-left: 1px dashed rgb(243 244 246);
  margin-left: 12px;
}
</style>
