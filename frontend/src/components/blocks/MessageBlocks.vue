<script setup lang="ts">
import PlainTextBlock from './PlainTextBlock.vue'
import MarkdownBlock from './MarkdownBlock.vue'
import CodeBlock from './CodeBlock.vue'
import TableBlock from './TableBlock.vue'
import FileTreeBlock from './FileTreeBlock.vue'
import DiffBlock from './DiffBlock.vue'
import ImageBlock from './ImageBlock.vue'
import ImagePlaceholderBlock from './ImagePlaceholderBlock.vue'
import { t } from '@/utils/i18n'
import HTMLPreviewBlock from './HTMLPreviewBlock.vue'
import FilePreviewBlock from './FilePreviewBlock.vue'
import DAGBlock from './DAGBlock.vue'
import CardBlock from './CardBlock.vue'
import QuoteBlock from './QuoteBlock.vue'
import TaskListBlock from './TaskListBlock.vue'
import MathBlock from './MathBlock.vue'
import LinkBlock from './LinkBlock.vue'
import PartnerRecommendBlock from './PartnerRecommendBlock.vue'
import ReasoningBlock from './ReasoningBlock.vue'
import StreamingTail from './StreamingTail.vue'
import ToolPartBlock from './ToolPartBlock.vue'
import { useChatStore } from '@/stores/chat'
import { useConversationsStore } from '@/stores/conversations'

const chatStore = useChatStore()
const conversationsStore = useConversationsStore()

/** 文件预览「打开文件位置」→ 后端在会话工作区查找并在资源管理器中选中（0911：原 sendResponse 死通道已接真 RPC） */
function handleOpenLocation(fileName: string) {
  const convId = String(conversationsStore.activeConversationId ?? '')
  if (!convId || !fileName) return
  chatStore.bridgeRpc('fs.reveal', { sessionId: convId, path: fileName }).catch(() => { /* 静默 */ })
}

/** 文件预览卡片点击 → 右侧栏预览（事件广播，RightPanel 监听） */
function handlePreview(payload: { name: string; content?: string; source?: string }) {
  window.dispatchEvent(new CustomEvent('nis-file-preview', { detail: payload }))
}

const emit = defineEmits<{
  (e: 'hitl-response', payload: { request_id: string; choice: string }): void
  (e: 'question-submit', payload: { request_id: string; value: string }): void
  (e: 'question-ignore', payload: { request_id: string }): void
  (e: 'recommend-confirm', payload: { project_id: string; partners: Array<{ id: string; reason: string }> }): void
  (e: 'recommend-ignore', payload: { project_id: string }): void
  (e: 'image-stop'): void
  (e: 'open-location', fileName: string): void
}>()

defineProps<{ block: { type: string; content: string; [key: string]: any }; streaming?: boolean }>()
</script>

<template>
  <!-- 流式阶段：表格/代码/卡片等类型先以原始内容流式显示（实时增长 + 彩色尾部动画），完成后渲染真实组件。
       #1/#3 交互卡（权限/询问/伙伴推荐）必须立即渲染成可点击组件，不能进 raw 流式分支（否则卡不显示）。
       #5 文件预览/HTML 预览/文件树也不进 raw 流式分支：长文件内容不重复"过一遍"，直接渲染卡片（点击再开预览）。 -->
  <div
    v-if="streaming && block.type !== 'plaintext' && block.type !== 'markdown'
      && block.type !== 'reasoning' && block.type !== 'permission_prompt' && block.type !== 'ask_user' && block.type !== 'partner_recommend'
      && block.type !== 'filepreview' && block.type !== 'htmlpreview' && block.type !== 'filetree'"
    class="whitespace-pre-wrap break-words text-[15px] leading-normal text-[#15151a] font-[350]"
  >
    <StreamingTail :text="(block.content || '').replace(/\s+$/, '')" />
  </div>
  <PlainTextBlock v-else-if="block.type === 'plaintext'" :content="block.content" :streaming="streaming" />
  <ReasoningBlock v-else-if="block.type === 'reasoning'" :content="block.content" :streaming="streaming" />
  <MarkdownBlock v-else-if="block.type === 'markdown'" :content="block.content" :streaming="streaming" />
  <CodeBlock v-else-if="block.type === 'code'" :content="block.content" :language="block.language" />
  <TableBlock v-else-if="block.type === 'table'" :content="block.content" />
  <FileTreeBlock v-else-if="block.type === 'filetree'" :content="block.content" />
  <DiffBlock v-else-if="block.type === 'diff'" :content="block.content" :title="block.title" />
  <ImageBlock v-else-if="block.type === 'image'" :content="block.content" :src="block.src" :alt="block.alt" />
  <ImagePlaceholderBlock
    v-else-if="block.type === 'image_placeholder'"
    :content="block.content"
    :alt="block.alt"
    :label="block.label"
    :duration="block.duration"
    :seq="block.seq"
    @stop="emit('image-stop')"
  />
  <HTMLPreviewBlock v-else-if="block.type === 'htmlpreview'" :content="block.content" :file-name="block.fileName" :rel-path="block.relPath" @preview="handlePreview" @open-location="handleOpenLocation" />
  <FilePreviewBlock v-else-if="block.type === 'filepreview'" :content="block.content" :file-name="block.fileName" :file-type="block.fileType" :rel-path="block.relPath" @preview="handlePreview" @open-location="handleOpenLocation" />
  <DAGBlock v-else-if="block.type === 'dag'" :content="block.content" />
  <CardBlock v-else-if="block.type === 'card'" :content="block.content" :title="block.title" />
  <QuoteBlock v-else-if="block.type === 'quote'" :content="block.content" />
  <TaskListBlock v-else-if="block.type === 'tasklist'" :content="block.content" />
  <MathBlock v-else-if="block.type === 'math'" :content="block.content" />
  <LinkBlock v-else-if="block.type === 'link'" :content="block.content" />
  <PartnerRecommendBlock
    v-else-if="block.type === 'partner_recommend'"
    :project_id="block.project_id"
    :partners="block.partners"
    @confirm="emit('recommend-confirm', $event)"
    @ignore="emit('recommend-ignore', $event)"
  />
  <ToolPartBlock v-else-if="block.type === 'tool'" :part="block" :desc="block.desc || ''" :kind="block.kind || 'tool'" />
  <!-- 权限/询问卡不在气泡内渲染（输入框位置由 ApprovalPanel/QuestionComposer 接管），
       这里只显示轻量状态占位，便于消息流溯源 -->
  <div
    v-else-if="block.type === 'permission_prompt' || block.type === 'ask_user'"
    class="my-1.5 flex items-center gap-2 text-[13px] text-gray-400"
  >
    <i :class="['fas', block.type === 'permission_prompt' ? 'fa-shield-halved text-amber-400' : 'fa-circle-question text-indigo-400']"></i>
    <span class="truncate">{{ block.question }}</span>
    <span class="ml-auto shrink-0 text-[11px]">{{ block.answered ? t('block.answered') : t('block.awaiting') }}</span>
  </div>
</template>
