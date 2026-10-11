/**
 * 0917c 收尾动画（用户第三次定稿）：**蓄力 → 跳到最上面 → 拽着绳子把幕布往下拉**
 *
 * 镜头序列：
 *   ① 蓄力  —— logo 原地压扁下蹲（scaleY 0.66 / scaleX 1.22，锚点在脚底）
 *   ② 跳顶  —— 拉伸起跳，一路弹到屏幕最上方（带过冲后落定）
 *   ③ 开拉  —— 落定瞬间铺上**与背景同色**的幕布，上沿（=分割线）就在 logo 上方一小截，
 *              两者之间连着"一小截绳子"；同一帧把开屏/引导层藏掉（画面看不出切换）。
 *   ④ 下坠  —— logo 从顶部一路坠到屏幕底部外侧（离开画面）。**logo 与绳子都在分割线下面**：
 *              logo 吊在上沿下方，靠绳子连到上沿；它往下掉就把上沿一起拽下来
 *              （绳长中段被拉长 → 上沿明显滞后于 logo），界面于是从顶部开始被一层层揭出来。
 *   ⑤ 渐显  —— 界面（#app）随下坠进度从 0.985 放大 + 淡入，即"跟着他拽的渐隐渐显"。
 *
 * 关键设计（都为"不穿帮"服务）：
 *   · logo 先抽到独立固定层（z 最高），所以藏开屏层不会把它一起藏掉；
 *   · 分割线（幕布上沿）严格 = logo 顶 - 绳长 → 绳子永远把 logo 和上沿连在一起，不会"脱手/分层"；
 *   · 幕布与 html/body 同色（收尾期间临时给 body 上底色），所以上沿之上的区域永远看不出接缝。
 *
 * 开屏（SplashScreen）与引导收尾（OnboardingWizard「一切就绪」页）共用这一套。
 */
import gsap from 'gsap'

interface JellyOutroOptions {
  /** 执行弹跳的 logo 元素（需要真实布局盒） */
  logo: HTMLElement
  /** 深色主题 → 幕布纯黑；浅色 → 纯白 */
  dark: boolean
  /** 幕布拉开后「长出来」的界面根节点（一般是 #app） */
  reveal?: HTMLElement | null
  /** 背景光效（辉光/粒子球等）：起跳时一起淡出，不硬切 */
  fadeBefore?: HTMLElement[] | null
  /** 幕布铺满、可以安全藏掉开屏/引导层时回调（logo 已抽到独立层，不受影响） */
  onCovered?: () => void
  /** 全部结束（logo 已离开画面）时回调：清类名、卸载开屏层 */
  onDone?: () => void
}

/** 绳长：松紧区间（px）。下坠中段被拉长到 BASE+STRETCH —— 分割线（幕布上沿）因此明显滞后于
 *  logo，看着就是"logo 先掉下去、把幕布上沿拽着往下拉"，而不是两者贴在一起平移。 */
const ROPE_BASE = 30
const ROPE_STRETCH = 120
/** 前 7% 下坠：绳子从松到绷紧，幕布滞后起步 */
const PULL_DELAY = 0.07
/** 分割线上方柔化带的高度（纱 + 卷边反光都在这段里） */
const EDGE_H = 52
/** 0918（用户二次调形）：分割线「被拽凹」的最大下沉量（px）。
 *  第一版 18px 反馈"弧可以再大一点" → 提到 26px，并把着力点两侧的过渡放宽
 *  （pow 1.6→1.5 + 影响半径 0.66→0.72），读作一个更饱满的弧，而不是一条浅坑。
 *  之前它是一条贯穿屏幕的直线 + 一抹上下均匀的反光 —— 更早那次反馈是"有点僵硬"（像尺子）。
 *  现在的做法：中间（绳子着力点）随拉力下沉、两端始终贴平；反光改成一条 1.4px 细线 + 横向渐变，
 *  只在着力点最强、两端淡出；再叠不到 1px 的自然起伏。下沉量与绳长同步（sin 曲线），
 *  读作"绳拉得越紧、布被拽得越凹"，而不是一条永远笔直的分界。 */
const EDGE_SAG_MAX = 26
/** 分割线细线的线宽 */
const EDGE_LINE_W = 1.4
/** 上沿折线采样点数（每帧重画也不贵） */
const EDGE_PTS = 72
/** 0920（用户提议）：绳子挂到 **logo 图上那个青色圆点** 上，logo 也绕这个点晃。
 *  这样"向左倾"是**吊着**产生的自然姿态（吊点偏右上 → 物体自然向左偏），而不是硬转出来的。
 *  数值由 `backend/_logodot.mjs` 从 `public/nis-logo2.png` 精确量得：
 *    点中心 = (745.5, 160.9) / 853×853  → 87.39% / 18.86%（直径 ≈ 12.7% 宽）
 *  ⚠️ 换 logo 图必须重跑那个脚本重新量，否则绳子会挂偏。 */
const ANCHOR_X_PCT = 0.8739
const ANCHOR_Y_PCT = 0.1886

interface CurtainStage {
  wrap: HTMLElement
  /** 幕布本体（不透明、与背景同色）；上沿 top = 被拉下来的进度 */
  curtain: HTMLElement
  /** 绳子（幕布子元素：从分割线往下伸到 logo 的那个圆点上） */
  rope: HTMLElement
  /** 每帧重画上沿：sag = 当前下沉量（0..EDGE_SAG_MAX），ropeLenNow = 当前绳长（下坠中段被拉长）。
   *  ⚠️ 0920 修 bug：以前这里只用闭包里的初始绳长（ROPE_BASE=30），而幕布 top 是按**拉伸后**的绳长算的
   *     → 下坠中段绳子只有 4px 一小截、而 logo 与幕布之间是 ~150px 的空隙，绳子看起来"脱手"了。
   *     现在把当前绳长一起传进来，绳底端严格落在**圆点**上（与设计约定一致）。 */
  drawEdge: (sag: number, ropeLenNow?: number) => void
}

/**
 * 建幕布 + 绳子。**几何约定**：
 *   logo 与绳子都在「分割线」（幕布上沿）**下面** —— logo 吊在上沿下方，
 *   靠绳子连上去；它往下掉，就把上沿一起拽下来（这才是"拉"）。
 *   绳子是幕布的子元素 → 两者永远同一帧、同一元素树，不可能分层。
 *   `anchorX` = **logo 上那个圆点的绝对 x**（0920 起绳子挂它，不再挂 logo 中心：
 *   绳头必须落在点上，否则两者会错开）。
 *   绳子**不再自带"握把"圆点** —— logo 上那个青色圆点本身就是握把。
 */
function createCurtainStage(anchorX: number, dark: boolean, topPx: number, ropeLen: number): CurtainStage {
  const NS = 'http://www.w3.org/2000/svg'
  const solid = dark ? '#000000' : '#ffffff'
  const ropeColor = dark ? 'rgba(255,255,255,0.58)' : 'rgba(0,0,0,0.26)'
  const ink = dark ? '255,255,255' : '0,0,0'
  /* 纱的三档透明度 + 细线峰值：深色底要更亮一点才看得出来 */
  const a1 = dark ? 0.05 : 0.03
  const a2 = dark ? 0.125 : 0.075
  const a3 = dark ? 0.165 : 0.10
  const lineA = dark ? 0.34 : 0.20
  const W = Math.max(320, window.innerWidth)
  const H = EDGE_H + EDGE_SAG_MAX
  const stop = (o: number, a: number): string =>
    '<stop offset="' + o + '" stop-color="rgb(' + ink + ')" stop-opacity="' + a + '"/>'

  const wrap = document.createElement('div')
  wrap.setAttribute('data-nis-curtain', '1')
  wrap.style.cssText = 'position:fixed;inset:0;z-index:2147483000;pointer-events:none;overflow:hidden'

  const curtain = document.createElement('div')
  curtain.style.cssText = 'position:absolute;left:0;right:0;bottom:0;top:' + topPx + 'px;background:' + solid

  /* ── 上沿（分割线）：不用一条直边，改成 SVG 三段 ──
   *   ① cap  分割线**下方**用幕布同色补上 —— 中间被拽凹的那块仍然是布，不会露出界面；
   *   ② band 分割线**上方**的柔纱（越往上越透明），两端横向淡出，不再撞到屏幕边；
   *   ③ line 一条 1.4px 细线，横向渐变：两端透明、着力点最强 —— "卷边反光"只在这一处。
   * 下沉量由 drawEdge() 每帧重画，与绳长同步。 */
  const svg = document.createElementNS(NS, 'svg')
  svg.setAttribute('width', String(W))
  svg.setAttribute('height', String(H))
  svg.style.cssText = 'position:absolute;left:0;top:-' + EDGE_H + 'px;display:block;overflow:visible'

  const defs = document.createElementNS(NS, 'defs')
  defs.innerHTML =
    '<linearGradient id="nisEdgeV" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="' + EDGE_H + '">'
    + stop(0, 0) + stop(0.52, a1) + stop(0.9, a2) + stop(1, a3)
    + '</linearGradient>'
    + '<linearGradient id="nisEdgeMaskG" x1="0" y1="0" x2="1" y2="0">'
    + '<stop offset="0" stop-color="#000"/><stop offset="0.13" stop-color="#fff"/>'
    + '<stop offset="0.87" stop-color="#fff"/><stop offset="1" stop-color="#000"/>'
    + '</linearGradient>'
    + '<mask id="nisEdgeMask"><rect x="0" y="0" width="' + W + '" height="' + H + '" fill="url(#nisEdgeMaskG)"/></mask>'
    + '<linearGradient id="nisEdgeLine" x1="0" y1="0" x2="1" y2="0">'
    + stop(0, 0) + stop(0.2, lineA * 0.5) + stop(0.5, lineA) + stop(0.8, lineA * 0.5) + stop(1, 0)
    + '</linearGradient>'

  const cap = document.createElementNS(NS, 'path')
  cap.setAttribute('fill', solid)
  const masked = document.createElementNS(NS, 'g')
  masked.setAttribute('mask', 'url(#nisEdgeMask)')
  const band = document.createElementNS(NS, 'path')
  band.setAttribute('fill', 'url(#nisEdgeV)')
  const lineEl = document.createElementNS(NS, 'path')
  lineEl.setAttribute('fill', 'none')
  lineEl.setAttribute('stroke', 'url(#nisEdgeLine)')
  lineEl.setAttribute('stroke-width', String(EDGE_LINE_W))
  lineEl.setAttribute('stroke-linecap', 'round')
  masked.appendChild(band)
  masked.appendChild(lineEl)
  svg.appendChild(defs)
  svg.appendChild(cap)
  svg.appendChild(masked)
  curtain.appendChild(svg)

  // 绳子：从分割线（凹下去的那一点）往下伸到 logo 那个圆点上。top/height 由 drawEdge 每帧给。
  // 不再自己画"握把"小圆点 —— logo 上的青色圆点就是握把，绳子末端直接落到它身上。
  const rope = document.createElement('div')
  rope.style.cssText =
    'position:absolute;left:' + Math.round(anchorX) + 'px;top:0;width:2px;height:' + ropeLen + 'px;' +
    'margin-left:-1px;border-radius:99px;background:linear-gradient(to bottom, ' + ropeColor + ' 0%, ' + ropeColor + ' 88%, rgba(0,0,0,0) 100%)'
  curtain.appendChild(rope)

  const step = W / (EDGE_PTS - 1)
  const drawEdge = (sag: number, ropeLenNow: number = ropeLen): void => {
    const amp = Math.max(0, Math.min(1, sag / EDGE_SAG_MAX))
    const ys: number[] = []
    let dLine = ''
    let dCap = ''
    for (let i = 0; i < EDGE_PTS; i++) {
      const x = i * step
      const t = Math.min(1, Math.abs(x - anchorX) / (W * 0.72))
      const bump = Math.pow(Math.max(0, 1 - t * t), 1.5)
      /* 不到 1px 的自然起伏：让上沿不像尺子；拉力越小起伏越含蓄 */
      const wob = (0.3 + 0.7 * amp) * 0.9 * Math.sin(x / 123 + 1.2)
      const y = EDGE_H + sag * bump + wob
      ys.push(y)
      const seg = (i === 0 ? 'M' : 'L') + x.toFixed(1) + ',' + y.toFixed(2)
      dLine += seg
      dCap += seg
    }
    dCap += 'L' + W + ',' + H + 'L0,' + H + 'Z'
    let dBand = 'M0,0L' + W + ',0L' + W + ',' + ys[EDGE_PTS - 1].toFixed(2)
    for (let i = EDGE_PTS - 2; i >= 0; i--) dBand += 'L' + (i * step).toFixed(1) + ',' + ys[i].toFixed(2)
    dBand += 'Z'
    cap.setAttribute('d', dCap)
    band.setAttribute('d', dBand)
    lineEl.setAttribute('d', dLine)
    // 绳子挂在凹下去的那一点上，底端仍落在 logo 顶（长度补偿 sag；绳长用当前拉伸值）
    rope.style.top = sag.toFixed(2) + 'px'
    rope.style.height = Math.max(0, ropeLenNow - sag).toFixed(2) + 'px'
  }
  drawEdge(0)

  wrap.appendChild(curtain)
  document.body.appendChild(wrap)
  return { wrap, curtain, rope, drawEdge }
}

export async function playJellyOutro(opts: JellyOutroOptions): Promise<void> {
  const { logo, dark, reveal = null, fadeBefore = null, onCovered, onDone } = opts
  if (!logo) { onCovered?.(); onDone?.(); return }
  gsap.ticker.lagSmoothing(0)
  gsap.killTweensOf(logo)

  const solid = dark ? '#000000' : '#ffffff'

  const r = logo.getBoundingClientRect()
  /* 0920：挂点 = **logo 上那个青色圆点**（不是 logo 中心）。绳子落在它上面、logo 也绕它晃。 */
  const anchorLocalX = r.width * ANCHOR_X_PCT
  const anchorLocalY = r.height * ANCHOR_Y_PCT
  const anchorX = r.left + anchorLocalX
  const anchorOrigin = (ANCHOR_X_PCT * 100).toFixed(2) + '% ' + (ANCHOR_Y_PCT * 100).toFixed(2) + '%'
  const vh = window.innerHeight
  const htmlEl = document.documentElement
  const prevHtmlBg = htmlEl.style.background
  const prevBodyBg = document.body.style.background

  let stage: CurtainStage | null = null
  try {
    /* 收尾期间给 html/body 上幕布底色：幕布上沿之上的区域也是这个色，
       于是"幕布铺上/被拉走"的过程里永远不会露出浏览器默认白底（深色主题下尤其致命）。 */
    htmlEl.style.background = solid
    document.body.style.background = solid

    /* logo 抽到独立固定层：必须盖在幕布之上，且不能跟着开屏层的隐藏一起消失。
       就地固定在它当前的视觉位置，之后只用 gsap 做位移。 */
    logo.style.position = 'fixed'
    logo.style.left = r.left + 'px'
    logo.style.top = r.top + 'px'
    logo.style.width = r.width + 'px'
    logo.style.height = r.height + 'px'
    logo.style.margin = '0'
    logo.style.zIndex = '2147483002'
    logo.style.willChange = 'transform'
    document.body.appendChild(logo)
    gsap.set(logo, { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, opacity: 1, transformOrigin: '50% 100%', filter: 'none' })

    /* ── ① 蓄力：原地压扁下蹲 ── */
    await new Promise<void>((resolve) => {
      gsap.to(logo, { y: 8, scaleY: 0.66, scaleX: 1.22, duration: 0.3, ease: 'power2.in', onComplete: () => resolve() })
    })

    /* ── ② 跳到最上面（带过冲）──
     *  落点要留出"分割线"的位置：幕布上沿会在 logo 上方 ROPE_BASE 处，所以落点不能贴到 y=0。 */
    const jumpTop = Math.max(ROPE_BASE + 8, Math.round(vh * 0.05))
    const yTop = jumpTop - r.top
    const fadeP = fadeBefore && fadeBefore.length
      ? gsap.to(fadeBefore, { opacity: 0, duration: 0.5, ease: 'power1.inOut' })
      : null
    await new Promise<void>((resolve) => {
      gsap.timeline({ onComplete: () => resolve() })
        .to(logo, { y: yTop - 14, scaleY: 1.26, scaleX: 0.84, duration: 0.32, ease: 'power2.out' })
        .to(logo, { y: yTop, scaleY: 1, scaleX: 1, duration: 0.22, ease: 'back.out(2.4)' })
    })
    if (fadeP) await Promise.resolve(fadeP)

    /* ── ③ 开拉：分割线落在**圆点**上方 ROPE_BASE 处（绳子末端正好压在圆点上）→ 藏开屏层 → 界面预备渐显 ── */
    const anchorY0 = r.top + yTop + anchorLocalY
    stage = createCurtainStage(anchorX, dark, Math.round(anchorY0 - ROPE_BASE), ROPE_BASE)
    const { curtain, drawEdge } = stage
    if (reveal) gsap.set(reveal, { opacity: 0, scale: 0.985, transformOrigin: '50% 0%' })
    onCovered?.()

    /* ── ④ 下坠 + 拽幕布 ──
     *  分割线（幕布上沿）= **圆点 y** - 绳长；绳长在下坠中段被拉长到 150px 左右 →
     *  分割线明显滞后于 logo，视觉上就是"logo 先掉下去，把幕布上沿拖着一起下来"。
     *  上沿只增不减（logo 越掉越快，滞后量变化远小于位移），杜绝回弹穿帮。 */
    const yEnd = vh + r.height + 60 - r.top
    const curtainMax = vh + 40
    let curtainTop = Math.round(anchorY0 - ROPE_BASE)
    const applyFrame = (y: number): void => {
      const anchorY = r.top + anchorLocalY + y
      const p = Math.max(0, Math.min(1, (y - yTop) / (yEnd - yTop)))
      const pEff = Math.max(0, Math.min(1, (p - PULL_DELAY) / (1 - PULL_DELAY)))
      const ropeLen = ROPE_BASE + ROPE_STRETCH * Math.sin(Math.PI * pEff)
      curtainTop = Math.min(curtainMax, Math.max(0, anchorY - ropeLen))
      curtain.style.top = curtainTop + 'px'
      /* 上沿跟着拉力下沉（与绳长同一条 sin 曲线）：绳最紧时中间凹得最深 —— 读作"布被拽着"。
         下沉量**与当前绳长一起**传给绳子，于是绳头永远挂在凹下去的那一点上、绳尾永远落在圆点上。 */
      drawEdge(EDGE_SAG_MAX * Math.sin(Math.PI * pEff), ropeLen)
      if (reveal) {
        const k = Math.min(1, p * 1.7)
        gsap.set(reveal, { opacity: k, scale: 0.985 + 0.015 * k })
      }
    }
    await new Promise<void>((resolve) => {
      gsap.to(logo, {
        y: yEnd,
        duration: 0.95,
        ease: 'power1.in',
        onUpdate: () => applyFrame(gsap.getProperty(logo, 'y') as number),
        onComplete: () => { applyFrame(yEnd); resolve() },
      })
      /* 0920 既定的做法：绳子挂到 logo 上那个**青色圆点**上，logo 也绕这个点晃。
       *  · 吊点在右上方、重心偏左下 → **向左倾是"吊着"自然产生的姿态**，不是硬转出来的；
       *  · 用户验收口径（第二次）："差不多站直"不行 —— 要向左转到**那个圆点成为 logo 的最高点**
       *    （点落在 logo 正上方），才算"倾斜着被拽下来"。
       *  · 几何阈值：圆点在盒内 (87.4%, 18.9%)，拱顶相对吊点是 (-58.1, -7.1)px →
       *    `58.1·sinθ > 7.1·cosθ` ⇒ **θ ≳ 7° 时圆点才成为最高点**。峰值取 **-14°**（明确过阈值），
       *    摆动区间 -5°..-14° 保持弹簧感（Q弹），不做"转到一半再回正"。
       *  · 物理完全平衡角是 ~52°（`_logodot.mjs`），太大不能用 —— 14° 是"像吊着"又不翻倒的甜点。
       *  · 切换支点的这一刻 rotation=0、scale=1 → 不会有任何视觉跳变。 */
      gsap.set(logo, { transformOrigin: anchorOrigin })
      gsap.to(logo, {
        keyframes: [
          { rotation: -4.0, duration: 0.15, ease: 'sine.out' },
          { rotation: -14.0, duration: 0.19, ease: 'sine.inOut' },
          { rotation: -5.0, duration: 0.27, ease: 'sine.inOut' },
          { rotation: -12.5, duration: 0.20, ease: 'sine.inOut' },
          { rotation: -13.5, duration: 0.14, ease: 'sine.out' },
        ],
      })
    })

    /* 幕布已拉走、界面已完整：清掉内联样式，交还给应用自己 */
    if (reveal) gsap.set(reveal, { clearProps: 'opacity,transform' })
    gsap.set(logo, { opacity: 0 })
  } finally {
    if (stage) stage.wrap.remove()
    logo.style.webkitMaskImage = ''
    logo.style.maskImage = ''
    logo.style.filter = ''
    logo.remove()
    htmlEl.style.background = prevHtmlBg
    document.body.style.background = prevBodyBg
    gsap.ticker.lagSmoothing(500, 33)
    onDone?.()
  }
}
