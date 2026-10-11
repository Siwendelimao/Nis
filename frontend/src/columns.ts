/**
 * 侧栏布局常量与计算函数
 * 对齐 dsh-ui AppFrame/columns.ts 的 grid 列轨道思路，适配 NIS 两栏布局：
 *   - 折叠态 56px（rail）
 *   - 展开默认 225px，拖拽范围 56~375px（原500的3/4）
 *   - 拖拽低于 SIDEBAR_SNAP(80) 自动吸附为折叠态
 */
const SIDEBAR_MIN = 56
const SIDEBAR_MAX = 225
export const SIDEBAR_COLLAPSED = 56
export const SIDEBAR_DEFAULT = 225
export const SIDEBAR_SNAP = 80


export function clampWidth(
  px: number,
  min: number = SIDEBAR_MIN,
  max: number = SIDEBAR_MAX,
): number {
  return Math.max(min, Math.min(max, px))
}



