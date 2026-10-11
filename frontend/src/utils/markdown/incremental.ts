/**
 * 增量块级 markdown 解析（dsh ui-primitives/markdown/incremental.ts 移植）
 *
 * CommonMark 块级解析是行级的，追加文本只会重塑"解析前沿"（最后一个顶层块：
 * 段落变 setext 标题/表格、列表延续、未闭合围栏吞行），之前的块都是最终态。
 * 因此冻结除最后 UNSTABLE_TAIL_BLOCKS 个块外的所有块，每 chunk 只重解析尾部，
 * 避免全量重解析的 O(n²)。
 */
import type { Root, RootContent } from 'mdast'

const UNSTABLE_TAIL_BLOCKS = 2

interface PositionedBlock {
  /** 解析出的块；positions 相对其解析片段 */
  readonly node: RootContent
  /** 块在完整源码中的起始偏移（流式稳定 key：跨冻结边界 React/Vue 复用而非重挂载） */
  readonly key: number
}

interface IncrementalBlocks {
  /** 不能再变的块（随 generation 单调增长） */
  readonly frozen: readonly PositionedBlock[]
  /** 重新解析的不稳定尾部（最多 UNSTABLE_TAIL_BLOCKS 块 + 增长） */
  readonly tail: readonly PositionedBlock[]
  /** 非追加输入丢弃冻结前缀时递增；调用方据此丢缓存 */
  readonly generation: number
}

function blockKey(node: RootContent, base: number, index: number): number {
  const offset = node.position?.start.offset
  return offset === undefined ? -(index + 1) : base + offset
}

/**
 * 追加式增量解析器：一个实例累积一份流式文档；非追加输入重置它。
 * @param parse - 与渲染层共享的语法（保证边界一致）
 */
export class IncrementalMarkdownParser {
  private prevText = ''
  private tailStart = 0
  private frozen: PositionedBlock[] = []
  private generation = 0
  private cached: IncrementalBlocks | null = null

  constructor(private readonly parse: (text: string) => Root) {}

  update(text: string): IncrementalBlocks {
    if (this.cached !== null && text === this.prevText) return this.cached
    if (!text.startsWith(this.prevText)) {
      this.prevText = ''
      this.tailStart = 0
      this.frozen = []
      this.generation += 1
    }
    this.prevText = text
    const base = this.tailStart
    const blocks = this.parse(text.slice(base)).children
    let firstUnstable = Math.max(0, blocks.length - UNSTABLE_TAIL_BLOCKS)
    if (firstUnstable > 0) {
      const cutEnd = blocks[firstUnstable - 1]?.position?.end.offset
      if (cutEnd === undefined) {
        firstUnstable = 0
      } else {
        for (const node of blocks.slice(0, firstUnstable)) {
          this.frozen.push({ node, key: blockKey(node, base, this.frozen.length) })
        }
        this.tailStart = base + cutEnd
      }
    }
    const tail = blocks.slice(firstUnstable).map((node, index) => ({
      node,
      key: blockKey(node, base, index),
    }))
    this.cached = { frozen: [...this.frozen], tail, generation: this.generation }
    return this.cached
  }
}
