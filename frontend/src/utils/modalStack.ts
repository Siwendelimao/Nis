/**
 * 弹窗层级栈（0920）—— 让 Esc 只关「最上面那一层」
 *
 * 背景（反馈）：设置里点开「导出数据」（二级），再点「选择目录」（三级）；
 * 按 Esc 一级（设置）关了，二/三级还杵在那儿；再打开设置，连上次那个二级弹窗都还在。
 *
 * 根因两条：
 *   ① 每个弹窗各自 `document.addEventListener('keydown')` 拦 Esc —— **同一个节点上的多个监听器
 *      谁也拦不住谁**（stopPropagation 只切"向下传播"，不影响同节点其它监听器），
 *      最终谁先注册谁先跑，跟"谁在最上层"毫无关系；
 *   ② 父弹窗关闭时只关了自己，子弹窗的 v-model 布尔量还留在 true → 下次打开原样复现。
 *
 * 这里解决 ①：**全局只留一个 Esc 处理器**，它只调用栈顶那一层的 `onEsc`。
 *   ② 归各弹窗自己管（关的时候把子层状态一起复位，见 `useModalLayer` 的用法注释）。
 *
 * 关键取舍：
 *   · 监听挂在 `window` 的 **capture** 阶段 —— 早于任何弹窗自己的 document 监听；
 *     命中后 `stopPropagation()`，事件不再往下走 ⇒ 那些旧监听器自然收不到，无需逐个删除。
 *   · **栈空时完全不干预** —— Esc 该干嘛干嘛（取消重命名、关图片查看器、转发给内嵌浏览器…）。
 *   · `onEsc` 由弹窗自己给，所以弹窗内部的"逐层收敛"（便签：先关下拉→再关编辑→最后关弹窗）
 *     原样保留：把原来的 Esc 逻辑整体搬进来即可。
 *   · `data-nis-esc-local`：行内编辑框（例如"新建文件夹"重命名输入框）标上它，
 *     Esc 归它先处理，不会被"关掉整个弹窗"抢走。
 */
import { watch, onUnmounted } from 'vue'

interface Layer {
  id: number
  onEsc: () => void
  /** 上一次响应 Esc 的时刻 —— 关窗动画期间防止连击把同一层关两遍 */
  lastAt: number
}

/** 栈底在前、栈顶在最后 —— 索引越大 = 越靠上 = 越晚打开 */
const stack: Layer[] = []
let seq = 0

/** 压入一层，返回注销函数 */
function pushLayer(onEsc: () => void): { id: number; off: () => void } {
  const id = ++seq
  stack.push({ id, onEsc, lastAt: 0 })
  let done = false
  return {
    id,
    off: () => {
      if (done) return
      done = true
      const i = stack.findIndex((x) => x.id === id)
      if (i >= 0) stack.splice(i, 1)
    },
  }
}



interface ModalLayer {
  /** 我是不是最上层 —— 只有最上层才该响应"自己那套关闭快捷键" */
  isTop: () => boolean
}

/**
 * 把一个弹窗登记成"一层"。
 *
 * @param open  `() => boolean`，弹窗当前是否打开（给响应式 getter，例如 `() => props.open`）
 * @param onEsc 这一层的 Esc 语义。**把该弹窗原来的 Esc 处理整体搬进来**（含内部的逐层收敛）。
 *
 * 用法（挂在 setup 顶层）：
 * ```ts
 * const layer = useModalLayer(() => props.open, () => close())
 * // 若该弹窗还有"可配置的关闭快捷键"，在它自己的 keydown 里加一道：
 * //   if (!layer.isTop()) return
 * ```
 */
export function useModalLayer(open: () => boolean, onEsc: () => void): ModalLayer {
  let off: (() => void) | null = null
  let id = 0

  const sync = (v: boolean): void => {
    if (v) {
      if (!off) {
        const r = pushLayer(onEsc)
        id = r.id
        off = r.off
      }
    } else if (off) {
      off()
      off = null
      id = 0
    }
  }

  watch(open, sync, { immediate: true })
  onUnmounted(() => { off?.(); off = null; id = 0 })

  return {
    isTop: () => id !== 0 && stack.length > 0 && stack[stack.length - 1].id === id,
  }
}

let installed = false

/** 装全局 Esc 守卫（幂等；main.ts 启动时调一次）。 */
export function installModalEsc(): void {
  if (installed || typeof window === 'undefined') return
  installed = true

  window.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Escape') return
      if (!stack.length) return // 没有弹窗 → 不干预
      /* 行内编辑优先：输入框自己带 `@keydown.esc` 的（新建文件夹改名之类）标了 data-nis-esc-local，
         这时"关掉整个弹窗"要让位。 */
      const t = e.target as HTMLElement | null
      if (t && typeof t.closest === 'function' && t.closest('[data-nis-esc-local]')) return
      const top = stack[stack.length - 1]
      /* ⚠️ 这里**不出栈**：某一层按 Esc 未必就关自己（便签是"先收下拉 → 再收编辑 → 最后才关弹窗"）。
         层什么时候出栈，由它自己的 `open` 变 false 决定（useModalLayer 的 watch）。
         代价是关窗动画那几百毫秒里层还在 → 用 350ms 静默期防连击。 */
      const now = Date.now()
      if (now - top.lastAt < 350) return
      top.lastAt = now
      e.preventDefault()
      e.stopPropagation()
      try {
        top.onEsc()
      } catch {
        /* 某一层的 Esc 逻辑自己出错，不该连累别处 */
      }
    },
    { capture: true },
  )
}
