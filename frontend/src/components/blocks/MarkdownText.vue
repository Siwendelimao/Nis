<script setup lang="ts">
/**
 * MarkdownText —— dsh ui-primitives/markdown/MarkdownText 的 Vue 移植
 * 流式：增量解析（IncrementalMarkdownParser），只有尾部块重渲染
 * 定稿：全量解析 + math（KaTeX 后续可加）
 */
import { computed } from 'vue'
import { IncrementalMarkdownParser } from '@/utils/markdown/incremental'
import { parseGfm, parseGfmWithMath } from '@/utils/markdown/parse'
import { MdNode } from './MdNode'

const props = defineProps<{ text: string; streaming?: boolean }>()

let parser: IncrementalMarkdownParser | null = null

const blocks = computed(() => {
  const text = props.text || ''
  if (!props.streaming) {
    const root = parseGfmWithMath(text)
    return root.children.map((node, i) => ({ key: i, node }))
  }
  if (!parser) parser = new IncrementalMarkdownParser(parseGfm)
  const { frozen, tail } = parser.update(text)
  return [...frozen, ...tail].map(b => ({ key: b.key, node: b.node }))
})
</script>

<template>
  <div class="dsh-markdown">
    <MdNode v-for="b in blocks" :key="b.key" :node="b.node" :streaming="!!streaming" />
  </div>
</template>

<style scoped>
.dsh-markdown {
  font-size: 14px;
  line-height: 1.7;
  color: #15151a;
  /* 400 对齐 ZCode 正文 regular（350 是系统字体时代向 400 圆整的近似值，Inter 可变字体会真实渲染 350 显得过细） */
  font-weight: 400;
  word-break: break-word;
}
.dsh-markdown :deep(.dsh-md-p) { margin: 0.4em 0; }
.dsh-markdown :deep(.dsh-md-h) { font-weight: 700; margin: 1em 0 0.5em; line-height: 1.4; }
.dsh-markdown :deep(.dsh-md-h1) { font-size: 1.4em; }
.dsh-markdown :deep(.dsh-md-h2) { font-size: 1.25em; }
.dsh-markdown :deep(.dsh-md-h3) { font-size: 1.1em; }
.dsh-markdown :deep(.dsh-md-h4) { font-size: 1em; }
.dsh-markdown :deep(.dsh-md-h5),
.dsh-markdown :deep(.dsh-md-h6) { font-size: 0.95em; }
.dsh-markdown :deep(.dsh-md-bq) {
  margin: 0.6em 0;
  padding: 0.3em 0.9em;
  border-left: 3px solid var(--dsw-static-deepseek-200);
  color: var(--dsw-alias-label-secondary);
  background: var(--dsw-static-deepseek-50);
  border-radius: 0 8px 8px 0;
}
.dsh-markdown :deep(.dsh-md-hr) { border: none; border-top: 1px solid var(--dsw-alias-border-l2); margin: 1em 0; }
.dsh-markdown :deep(.dsh-md-mark) {
  background: linear-gradient(transparent 55%, var(--dsw-static-amber-500) 55%);
  border-radius: 2px;
  padding: 0 1px;
}
.dsh-markdown :deep(.dsh-md-sub),
.dsh-markdown :deep(.dsh-md-sup) {
  font-size: 0.75em;
  line-height: 0;
}
.dsh-markdown :deep(.dsh-md-sub) { vertical-align: sub; }
.dsh-markdown :deep(.dsh-md-sup) { vertical-align: super; }
.dsh-markdown :deep(.dsh-md-code) {
  padding: 0.15em 0.4em;
  border-radius: 4px;
  background: var(--dsw-static-neutral-bluish-75);
  font-family: ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  font-size: 0.88em;
  color: var(--dsw-static-deepseek-500);
}
.dsh-markdown :deep(.dsh-md-fence) {
  margin: 0.7em 0;
  border-radius: 10px;
  overflow: hidden;
  border: 1px solid var(--dsw-alias-border-l2);
}
.dsh-markdown :deep(.dsh-md-fence-head) {
  display: flex;
  align-items: center;
  padding: 4px 12px;
  background: var(--dsw-static-neutral-bluish-850);
}
.dsh-markdown :deep(.dsh-md-fence-lang) {
  font-size: 11px;
  color: var(--dsw-static-neutral-bluish-300);
  font-family: ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
}
.dsh-markdown :deep(.dsh-md-pre) {
  margin: 0;
  padding: 12px 14px;
  background: var(--dsw-static-neutral-bluish-900);
  color: var(--dsw-static-neutral-bluish-100);
  font-size: 13px;
  line-height: 1.6;
  overflow-x: auto;
  font-family: ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
}
.dsh-markdown :deep(.dsh-md-list) { margin: 0.5em 0; padding-left: 1.6em; }
.dsh-markdown :deep(.dsh-md-li) { margin: 0.25em 0; }
.dsh-markdown :deep(.dsh-md-task) {
  list-style: none;
  margin-left: -1.4em;
  display: flex;
  align-items: flex-start;
  gap: 8px;
}
.dsh-markdown :deep(.dsh-md-checkbox) {
  appearance: none;
  -webkit-appearance: none;
  width: 15px;
  height: 15px;
  flex-shrink: 0;
  margin-top: 3px;
  border: 1.5px solid var(--dsw-static-neutral-bluish-400);
  border-radius: 4px;
  cursor: default;
  position: relative;
  transition: background 0.15s, border-color 0.15s;
}
.dsh-markdown :deep(.dsh-md-checkbox:checked) {
  background: var(--dsw-static-deepseek-500);
  border-color: var(--dsw-static-deepseek-500);
}
.dsh-markdown :deep(.dsh-md-checkbox:checked::after) {
  content: '';
  position: absolute;
  left: 4px;
  top: 1px;
  width: 4px;
  height: 8px;
  border: solid #fff;
  border-width: 0 2px 2px 0;
  transform: rotate(45deg);
}
.dsh-markdown :deep(.dsh-md-table-wrap) {
  margin: 0.7em 0;
  overflow-x: auto;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  scrollbar-width: none; /* 0904 反馈①：宽表格滚动条冲出子 agent 气泡，隐藏滚动条（仍可拖拽） */
}
.dsh-markdown :deep(.dsh-md-table-wrap)::-webkit-scrollbar { display: none; }
.dsh-markdown :deep(.dsh-md-table) { border-collapse: collapse; width: 100%; font-size: 13.5px; }
.dsh-markdown :deep(.dsh-md-table th),
.dsh-markdown :deep(.dsh-md-table td) {
  border: 1px solid var(--dsw-alias-border-l1);
  padding: 6px 10px;
  text-align: left;
}
.dsh-markdown :deep(.dsh-md-table th) {
  background: var(--dsw-static-neutral-bluish-60);
  font-weight: 600;
}
.dsh-markdown :deep(.dsh-md-link) {
  color: var(--dsw-static-deepseek-500);
  text-decoration: underline;
  text-underline-offset: 3px;
}
.dsh-markdown :deep(.dsh-md-img) { max-width: 100%; border-radius: 8px; margin: 0.5em 0; }
.dsh-markdown :deep(.dsh-md-imgalt) { color: var(--dsw-alias-label-tertiary); font-style: italic; }
.dsh-markdown :deep(.dsh-md-math) {
  margin: 0.7em 0;
  padding: 12px 14px;
  background: var(--dsw-static-neutral-bluish-60);
  border-radius: 8px;
  font-family: ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  font-size: 13px;
  overflow-x: auto;
  white-space: pre-wrap;
}
.dsh-markdown :deep(.dsh-md-footnote-ref) { color: var(--dsw-static-deepseek-500); font-size: 0.8em; }
</style>