/**
 * 浮层可用边界（0920）
 *
 * 背景：右侧有一列"停靠栏"（`.right-docks`：工作区 / 运行日志）。它是左列的**兄弟节点**，
 * 而且内部一路 `overflow: hidden`。左列里那些 `position: absolute` 的弹层如果只按
 * `window.innerWidth` 判"有没有溢出"，就会掉进这个坑：
 *   **看着还在视口里 → 实际伸进了右栏的地盘 → 被右栏盖住 / 被祖先裁掉**。
 * （实例：模型选择器里的「推理强度」卡片向右弹出时被工作区面板压掉。）
 *
 * 所以弹层判溢出要用「右栏左边缘」当右边界；右栏没开时才退回视口宽度。
 */

/** 浮层可用的右边界（px）；右栏开着时 = 右栏左边缘 - gap，否则 = 视口宽 - gap */
export function safeRightEdge(gap = 8): number {
  if (typeof document === 'undefined') return 0
  const docks = document.querySelector('.right-docks') as HTMLElement | null
  if (docks) {
    const r = docks.getBoundingClientRect()
    if (r.width > 1) return r.left - gap
  }
  return window.innerWidth - gap
}
