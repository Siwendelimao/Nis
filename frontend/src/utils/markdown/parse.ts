/**
 * 两个 mdast 语法：流式臂用纯 GFM（不解析 TeX，避免流式中公式闪烁报错），
 * 定稿臂加 math 扩展（$$ 块级 / $ 行内）。与 dsh ui-primitives/markdown/parse.ts 对齐。
 */
import type { Root } from 'mdast'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { mathFromMarkdown } from 'mdast-util-math'
import { gfm } from 'micromark-extension-gfm'
import { math } from 'micromark-extension-math'

/** 流式臂：GFM（无 math） */
export function parseGfm(text: string): Root {
  return fromMarkdown(text, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  })
}

/** 定稿臂：GFM + TeX math */
export function parseGfmWithMath(text: string): Root {
  return fromMarkdown(text, {
    extensions: [gfm(), math()],
    mdastExtensions: [gfmFromMarkdown(), mathFromMarkdown()],
  })
}
