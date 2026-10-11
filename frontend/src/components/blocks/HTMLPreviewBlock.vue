<script setup lang="ts">
import FilePreviewBlock from './FilePreviewBlock.vue'
import { t } from '@/utils/i18n'

/** HTML 预览卡（索引化 v2）：样式与 FilePreviewBlock 一致，内容不内嵌；
 * 有 relPath（后端补全的源文件索引）→ 点击在预览处显示 / 浏览器打开；
 * 无路径的临时围栏 → 回退内存内容预览。 */
const props = defineProps<{ content: string; fileName?: string; relPath?: string }>()

const emit = defineEmits<{
  preview: [payload: { name: string; content?: string; source?: string }]
  'open-location': [fileName: string]
}>()

function handlePreview(payload: { name: string; content?: string; source?: string }) {
  emit('preview', payload)
}
</script>

<template>
  <FilePreviewBlock
    :content="props.content"
    :file-name="props.fileName || (props.relPath ? undefined : t('htmlpv.title'))"
    :rel-path="props.relPath"
    file-type="html"
    @preview="handlePreview"
    @open-location="(n: string) => emit('open-location', n)"
  />
</template>
