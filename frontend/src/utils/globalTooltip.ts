/* 全局 tooltip 接管器（0918 反馈：「小按钮悬停显示的气泡变成系统级的了，很丑」）
 *
 * 背景：全站有 189 处用原生 `title=` 做提示。Windows 的原生气泡有两个硬伤 ——
 *   ① 慢：要悬停约 1 秒才出；② 丑：系统灰底方角小字，和应用里所有自绘气泡（深色圆角、
 *   见 QueueBar `.qb-tip` / WindowControls `.win-tip` / 设置页 HintTip）不是一套语言。
 *   用户之前见过"我们自己的样式"，后来那些自绘气泡只在个别组件里留了下来。
 *
 * 做法：**事件委托 + 借走 title**，一处不改就接管全部 ——
 *   pointerover 命中带 `[title]` 的元素 → 把 title 文本抄进 `data-nis-tip` 并**移除 title 属性**
 *   （原生气泡只看 title 属性，移除后它永远不会出现）→ 用 body 上的自绘气泡显示；
 *   移开时把 title 原样还回去（Vue 的动态绑定在下一次 patch 时也会自己写回，互不冲突）。
 *
 * 想跳过的元素：加 `data-no-tip`（例：自己已经画了气泡的按钮）。
 */

/* 悬停多久出气泡（用户四轮定稿）：
 * 原生 ~1000ms 太慢（而且丑）；130 → 250 → 350 都嫌快 → **最终 700ms**。
 * ⚠️ 另外两条同样重要（都在本轮修掉）：
 *   ① **离开/换目标立刻收回**（之前 pointerout 还留了 30ms 尾巴）；
 *   ② **不要阴影、不要竖直位移动画**，且**定位只做一次（做完再淡入）** ——
 *      以前是"先 place 一次就把 opacity 变 1、rAF 里再 place 一次"，于是能看到气泡先出现在
 *      旧位置、再往上浮一下（用户明确点出）。 */
const SHOW_DELAY = 700
const GAP = 8
const MAX_W = 300
const Z = 10070

let host: HTMLDivElement | null = null
let tipEl: HTMLDivElement | null = null
let curEl: HTMLElement | null = null

let showTimer = 0
let hideTimer = 0
let installed = false
/* ★ 0919 修：必须记住"title 是从哪个元素借走的"，并在**所有**退出路径归还。
   旧实现只在"气泡真的显示过"（curEl 有值）时才在 hide() 里还 title —— 于是
   **指针停留不足 130ms 就划走**（或 show 被 `:hover` 检查拦下）时，title 被摘掉且永不归还，
   那个按钮从此再也不会弹气泡（复制按钮的 title 是动态绑定，Vue 不会重写，症状永久）。
   现在：借之前先还上一个；移开/隐藏/取消一律归还。 */
let borrowedEl: HTMLElement | null = null
let borrowedText = ''

/** 把借来的 title 还回去（指针还停在该元素上时先不还 —— 还了原生气泡又会冒出来） */
function restoreBorrowed(force = false): void {
  const el = borrowedEl
  const txt = borrowedText
  if (!el || !txt) return
  if (!force && el.matches(':hover')) return
  borrowedEl = null
  borrowedText = ''
  if (!el.hasAttribute('title')) {
    try { el.setAttribute('title', txt) } catch { /* ignore */ }
  }
}

/** 元素的提示文本：title 被借走后落在 data-nis-tip，两边都认（否则重新划入时读不到） */
function textOf(el: HTMLElement): string {
  return (el.getAttribute('title') || el.getAttribute('data-nis-tip') || '').trim()
}

function ensureDom(): void {
  if (host) return
  host = document.createElement('div')
  host.setAttribute('data-nis-tooltip-host', '')
  host.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:' + Z + ';pointer-events:none'
  tipEl = document.createElement('div')
  tipEl.className = 'nis-tip'
  tipEl.style.cssText =
    'position:fixed;opacity:0;' +
    'background:#111827;color:#fff;font-size:11px;line-height:1.55;' +
    'border-radius:10px;padding:6px 11px;' +
    'max-width:' + MAX_W + 'px;width:max-content;white-space:pre-line;word-break:break-word;' +
    // 只有透明度淡入：**不留阴影、不做位移动画**（用户：有阴影 + 上浮一下很怪）
    'transition:opacity 0.12s ease;pointer-events:none'
  host.appendChild(tipEl)
  document.body.appendChild(host)
}

function place(el: HTMLElement): void {
  if (!tipEl) return
  const r = el.getBoundingClientRect()
  const tw = tipEl.offsetWidth
  const th = tipEl.offsetHeight
  const vw = window.innerWidth
  const vh = window.innerHeight
  // 默认放上方居中；上方不够就放到下方；都会被视口夹住（含 8px 边距）
  let top = r.top - th - GAP
  if (top < 8) top = Math.min(r.bottom + GAP, vh - th - 8)
  let left = r.left + r.width / 2 - tw / 2
  left = Math.max(8, Math.min(left, vw - tw - 8))
  tipEl.style.left = Math.round(left) + 'px'
  tipEl.style.top = Math.round(top) + 'px'
}

function show(el: HTMLElement, text: string): void {
  ensureDom()
  curEl = el
  if (!tipEl) return
  tipEl.textContent = text
  // 先量一次尺寸（此时 opacity 还是 0，量尺不影响观感）
  tipEl.style.opacity = '0'
  place(el)
  /* 换行后高度可能和预估不同 → 再校一次位置；**校完才淡入**。
     以前是"place 一次就把 opacity 设 1、rAF 里再 place 一次"，于是能看见气泡先出现在旧位置、
     再跳/浮到新位置（实测）。现在分两个 rAF：定位 → 定位 → 才显示，全程不可见。 */
  requestAnimationFrame(() => {
    if (curEl !== el) return
    place(el)
    requestAnimationFrame(() => {
      if (curEl !== el) return
      tipEl!.style.opacity = '1'
      const _r0 = el.getBoundingClientRect()
      lastRect = { top: _r0.top, left: _r0.left }
      startGuard()   // ★ 0923：只在气泡可见期间守着（宿主被移出 DOM 就立刻收回）
    })
  })
}

/** 立刻收掉气泡本体（**不动 title 的借还**，借还由 restoreBorrowed 单独负责） */
/* ★ 0923（实测「悬停提示卡在界面上不消失」的全局同类问题）：
   消息重渲染 / 列表筛选 / 切会话会把按钮整个移出 DOM，浏览器**不补发 pointerout**
   ⇒ 气泡挂屏不散（与 ChatInput 图片标签预览同一个病根）。
   做法：只在气泡**可见期间**挂 400ms 低频守卫 —— 宿主失联（或被 hidden / 被移走）立即收回；
   位置变了则跟随（避免气泡停在旧坐标）。气泡一收守卫即停，零常驻成本。 */
let guardTimer = 0
let lastRect = { top: 0, left: 0 }
function stopGuard(): void {
  if (guardTimer) { clearInterval(guardTimer); guardTimer = 0 }
}
function startGuard(): void {
  stopGuard()
  guardTimer = window.setInterval(() => {
    const el = curEl
    if (!el) { stopGuard(); return }
    if (!el.isConnected) { hide(); return }
    const r = el.getBoundingClientRect()
    if (r.width === 0 && r.height === 0) { hide(); return }
    if (r.top !== lastRect.top || r.left !== lastRect.left) {
      lastRect = { top: r.top, left: r.left }
      place(el)
    }
  }, 400)
}

function hideTip(): void {
  curEl = null
  if (tipEl) tipEl.style.opacity = '0'
  stopGuard()   // ★ 0923：气泡收了就别再检查（零常驻成本）
}

function hide(): void {
  if (showTimer) { clearTimeout(showTimer); showTimer = 0 }
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = 0 }
  hideTip()
  restoreBorrowed() // ★ 无条件归还（不管气泡有没有真的显示过）
}

function findTipTarget(node: EventTarget | null): HTMLElement | null {
  let el = node as HTMLElement | null
  while (el && el !== document.body) {
    if (el.nodeType === 1) {
      if (el.hasAttribute('data-no-tip')) return null
      if (textOf(el)) return el
    }
    el = el.parentElement
  }
  return null
}

function onPointerOver(e: PointerEvent): void {
  const el = findTipTarget(e.target)
  if (!el) return
  if (el === curEl) return // 已经在显示它（含在同一元素内部移动）
  /* ★ 换目标：先把上一个借的 title 还回去，并**立刻收掉旧气泡**。
     旧实现只清了 hideTimer（不 hide），于是上一个气泡会一直挂在屏幕上 ——
     看起来就是"移到新按钮气泡秒出"（其实是旧的没走），反馈的"不跟手"就是这个。 */
  if (borrowedEl && borrowedEl !== el) restoreBorrowed()
  if (curEl) hideTip()
  const text = textOf(el)
  if (!text) return
  // 借走 title：原生气泡只认这个属性，摘掉它就绝不会出现（文本留存在 data-nis-tip）
  if (el.hasAttribute('title')) {
    el.setAttribute('data-nis-tip', text)
    el.removeAttribute('title')
  }
  borrowedEl = el
  borrowedText = text
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = 0 }
  if (showTimer) clearTimeout(showTimer)
  showTimer = window.setTimeout(() => {
    showTimer = 0
    // 指针可能已经移开
    if (!el.matches(':hover')) { hide(); return }
    show(el, text)
  }, SHOW_DELAY)
}

function onPointerOut(e: PointerEvent): void {
  const rel = e.relatedTarget as Node | null
  if (curEl && rel && curEl.contains(rel)) return // 还在同一个元素内移动，不收
  if (borrowedEl && rel && borrowedEl.contains(rel)) return // 还在"借了 title"的元素内
  if (showTimer) { clearTimeout(showTimer); showTimer = 0 }
  // ★ 立刻收回（以前留 30ms 尾巴，需求要求"指针一移走就收"）
  hide()
}

function onScrollOrResize(): void {
  if (curEl) place(curEl)
}

/** 安装（App 挂载时调一次；重复调用无副作用） */
export function installGlobalTooltip(): void {
  if (installed || typeof document === 'undefined') return
  installed = true
  document.addEventListener('pointerover', onPointerOver, true)
  document.addEventListener('pointerout', onPointerOut, true)
  document.addEventListener('pointercancel', hide, true)
  window.addEventListener('blur', hide, true)
  window.addEventListener('scroll', onScrollOrResize, true)
  window.addEventListener('resize', onScrollOrResize, true)
}
