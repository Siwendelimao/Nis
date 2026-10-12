/* ==========================================================================
   NIS 官网脚本（零依赖，原生 JS）
   1) 截图按主题换版 + 占位自动替换    2) 深色 / 浅色主题切换
   3) 滚动入场（错峰）                 4) 鼠标辉光 + 卡片跟随柔光
   5) 导航状态 + 首屏视差 + 背景视差    6) 复制按钮（群号 / 命令行）
   全部动效尊重 prefers-reduced-motion
   ========================================================================== */
(function () {
  'use strict'

  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  var isDesktop = window.matchMedia('(min-width: 761px)').matches
  var root = document.documentElement

  function currentTheme() {
    return root.getAttribute('data-theme') === 'light' ? 'light' : 'dark'
  }

  /* —— 1. 截图：按主题取对应版本，图不在就保留占位框 —— */
  function shotSrc(el) {
    return el.getAttribute('data-shot-' + currentTheme()) ||
           el.getAttribute('data-shot') || ''
  }
  function loadShot(el) {
    var host = el.querySelector('.shot__body') || el
    var old = host.querySelector('img')
    if (old) old.remove()
    el.classList.remove('is-ready')
    var src = shotSrc(el)
    if (!src) return
    var img = new Image()
    img.src = src
    img.alt = el.getAttribute('data-alt') || ''
    img.onload = function () {
      host.insertBefore(img, host.firstChild)
      el.classList.add('is-ready')
      /* 二维码：顺手挂一个"悬停放大"气泡（群二维码在卡片里只有 168px，手机扫不一定够，放大看着也舒服） */
      if (el.classList.contains('qr')) attachZoom(el, src, img.alt)
    }
    /* 图不存在 → 静默保留占位框，控制台也不报错 */
  }

  /* —— 1b. 悬停放大气泡（目前只给群二维码用） ——
     做法：气泡挂在 body 上（position:fixed），不用 absolute —— 因为下载卡 .join 有 overflow:hidden，
     absolute 的浮层会被裁掉。位置在鼠标进入时按"右侧→上方→下方"的优先级就近放，并夹在视口内。
     触屏（≤760px）不显示：没有 hover 语义，放大反而碍事。 */
  function attachZoom(el, src, alt) {
    var z = el.__qrZoom
    if (!z) {
      var bubble = document.createElement('div')
      bubble.className = 'qr-zoom'
      var bimg = document.createElement('img')
      bimg.src = src
      bimg.alt = alt || ''
      bubble.appendChild(bimg)
      document.body.appendChild(bubble)
      z = { bubble: bubble, img: bimg, on: false }
      el.__qrZoom = z
      var place = function () {
        var r = el.getBoundingClientRect()
        var bw = bubble.offsetWidth || 260
        var bh = bubble.offsetHeight || 300
        var gap = 14
        var left
        var top
        if (r.right + gap + bw <= window.innerWidth - 8) {
          left = r.right + gap
          top = r.top + r.height / 2 - bh / 2
        } else if (r.top - gap - bh >= 8) {
          left = r.left + r.width / 2 - bw / 2
          top = r.top - gap - bh
        } else {
          left = r.left + r.width / 2 - bw / 2
          top = r.bottom + gap
        }
        bubble.style.left = Math.max(8, Math.min(left, window.innerWidth - bw - 8)) + 'px'
        bubble.style.top = Math.max(8, Math.min(top, window.innerHeight - bh - 8)) + 'px'
      }
      z.place = place
      el.addEventListener('mouseenter', function () { place(); bubble.classList.add('is-on'); z.on = true })
      el.addEventListener('mouseleave', function () { bubble.classList.remove('is-on'); z.on = false })
      window.addEventListener('scroll', function () { if (z.on) place() }, { passive: true })
      window.addEventListener('resize', function () { if (z.on) place() }, { passive: true })
    } else {
      z.img.src = src
    }
  }
  function reloadShots() {
    document.querySelectorAll('[data-shot]').forEach(loadShot)
  }
  reloadShots()

  /* —— 2. 主题切换（深色 / 浅色）—— 默认深色，用户手动切过才按他选的记 */
  var themeBtn = document.getElementById('themeToggle')

  function applyTheme(theme, persist) {
    root.setAttribute('data-theme', theme)
    var meta = document.querySelector('meta[name="theme-color"]')
    if (meta) meta.setAttribute('content', theme === 'light' ? '#fafafa' : '#0a0a0b')
    if (persist) {
      try { localStorage.setItem('nis-theme', theme) } catch (e) { /* 存不了就只生效这一次 */ }
    }
    reloadShots()   /* 截图跟着换一版 */
  }

  if (themeBtn) {
    themeBtn.addEventListener('click', function () {
      applyTheme(currentTheme() === 'light' ? 'dark' : 'light', true)
    })
  }

  /* ★1012（老大要求）：**默认深色** —— 不再跟随系统偏好。
     手动点过切换按钮就按他选的记住（localStorage），没点过一律深色。 */

  /* —— 3. 滚动入场 —— */
  var reveals = document.querySelectorAll('[data-reveal]')

  document.querySelectorAll('[data-stagger]').forEach(function (group) {
    Array.prototype.forEach.call(group.children, function (el, i) {
      el.style.setProperty('--d', (i * 70) + 'ms')
    })
  })

  if ('IntersectionObserver' in window && reveals.length && !reduce) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (!e.isIntersecting) return
        var el = e.target
        el.classList.add('is-in')
        io.unobserve(el)
      })
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 })

    reveals.forEach(function (el) {
      /* 动画播完把控制权交回 CSS，避免 forwards 卡住 hover 的 transform */
      el.addEventListener('animationend', function (ev) {
        if (ev.animationName === 'riseIn') el.classList.add('is-done')
      })
      io.observe(el)
    })
  } else {
    reveals.forEach(function (el) { el.classList.add('is-done') })
  }

  /* —— 4. 鼠标辉光 + 卡片跟随柔光 —— */
  var glow = document.getElementById('glow')
  if (glow && isDesktop) {
    var gx = 0, gy = 0, gqueued = false
    var paintGlow = function () {
      gqueued = false
      glow.style.transform = 'translate3d(' + gx + 'px,' + gy + 'px,0)'
    }
    window.addEventListener('mousemove', function (e) {
      gx = e.clientX
      gy = e.clientY
      glow.classList.add('is-on')
      if (!gqueued) { gqueued = true; requestAnimationFrame(paintGlow) }
    }, { passive: true })
    document.addEventListener('mouseleave', function () { glow.classList.remove('is-on') })
  }

  if (isDesktop && !reduce) {
    document.querySelectorAll('.card, .join').forEach(function (el) {
      el.addEventListener('pointermove', function (e) {
        if (e.pointerType === 'touch') return
        var r = el.getBoundingClientRect()
        el.style.setProperty('--mx', (e.clientX - r.left) + 'px')
        el.style.setProperty('--my', (e.clientY - r.top) + 'px')
      }, { passive: true })
    })
  }

  /* —— 5. 导航状态 + 首屏视差 + 背景视差 —— */
  var nav = document.getElementById('nav')
  var heroWrap = document.querySelector('.hero .wrap')

  /* 背景各层系数：越大跑得越快。用独立 translate 属性，与 CSS 动画的 transform 自动叠加 */
  var bgLayers = []
  ;[
    ['.bg__pool', 0.06],
    ['.bg__blob--1', 0.17],
    ['.bg__blob--2', 0.25],
    ['.bg__blob--3', 0.13],
    ['.bg__ring', 0.10]
  ].forEach(function (item) {
    var el = document.querySelector(item[0])
    if (el) bgLayers.push({ el: el, k: item[1] })
  })

  var scrolling = false
  function onFrame() {
    scrolling = false
    var y = window.scrollY || window.pageYOffset

    if (nav) nav.classList.toggle('is-scrolled', y > 8)

    if (!reduce) {
      for (var i = 0; i < bgLayers.length; i++) {
        var L = bgLayers[i]
        L.el.style.translate = '0 ' + (-(y * L.k)).toFixed(1) + 'px'
      }
    }

    if (heroWrap && isDesktop && !reduce && y < window.innerHeight) {
      heroWrap.style.transform = 'translate3d(0,' + (y * 0.18).toFixed(1) + 'px,0)'
      heroWrap.style.opacity = Math.max(0, 1 - y / (window.innerHeight * 1.15)).toFixed(3)
    }
  }

  window.addEventListener('scroll', function () {
    if (scrolling) return
    scrolling = true
    requestAnimationFrame(onFrame)
  }, { passive: true })
  window.addEventListener('resize', onFrame, { passive: true })
  onFrame()

  /* —— 6. 复制按钮（群号 + 命令行代码块） —— */
  function bindCopy(btn, getText) {
    btn.addEventListener('click', function () {
      var text = getText()
      if (!text) return
      var original = btn.textContent
      var done = function () {
        btn.textContent = '已复制'
        btn.classList.add('is-done')
        setTimeout(function () {
          btn.textContent = original
          btn.classList.remove('is-done')
        }, 1800)
      }
      function fallback() {
        /* http / file:// 下剪贴板 API 不可用时的退路 */
        var ta = document.createElement('textarea')
        ta.value = text
        ta.setAttribute('readonly', '')
        ta.style.cssText = 'position:fixed;top:-1000px;opacity:0'
        document.body.appendChild(ta)
        ta.select()
        try { document.execCommand('copy'); done() } catch (err) {
          btn.textContent = '请手动复制'
        }
        document.body.removeChild(ta)
      }
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text).then(done, fallback)
      } else {
        fallback()
      }
    })
  }

  var copyBtn = document.getElementById('copyBtn')
  var groupNum = document.getElementById('groupNum')
  if (copyBtn && groupNum) {
    bindCopy(copyBtn, function () { return groupNum.textContent.trim() })
  }

  document.querySelectorAll('[data-copy]').forEach(function (b) {
    bindCopy(b, function () {
      var src = document.getElementById(b.getAttribute('data-copy'))
      return src ? src.textContent.trim() : ''
    })
  })

  /* —— 7. 版本更新日志（单一数据源：同目录 changelog.json） ——
     为什么数据放 json 而不是直接写死在 HTML：以后每次发版只改这一个小文件（不用动十几 KB 的页面），
     也方便发版流程顺带追加（release-upload.cjs 已有“发布说明文件”参数）。
     兜底策略：没有 JS → 页面里的 <noscript> 显示最新一版；拉不到文件（file:// 直开 / 离线）→ 下面给一句实话 + Releases 链接。 */
  var clBox = document.getElementById('changelogList')
  if (clBox) {
    var clEsc = function (s) {
      return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
      })
    }
    var clRender = function (list) {
      clBox.innerHTML = list.map(function (it, i) {
        var items = (it.items || []).map(function (x) {
          return '<li>' + clEsc(x) + '</li>'
        }).join('')
        var head = '<span class="cl__ver">v' + clEsc(it.version) + '</span>' +
          (i === 0 ? '<span class="cl__badge">最新</span>' : '') +
          (it.tag ? '<span class="cl__tag">' + clEsc(it.tag) + '</span>' : '') +
          (it.date ? '<span class="cl__date">' + clEsc(it.date) + '</span>' : '')
        /* 最新一版：完整展开（它是用户唯一关心的那版）。
           更早的版本：折叠成一行标题，点开才展开 —— 否则日志越积越长，页面会被一路撑高。 */
        if (i === 0) {
          return '<article class="cl__item cl__item--top">' +
            '<div class="cl__head">' + head + '</div>' +
            '<ul class="cl__list">' + items + '</ul>' +
          '</article>'
        }
        return '<details class="cl__item cl__past">' +
          '<summary class="cl__head">' + head + '</summary>' +
          '<ul class="cl__list">' + items + '</ul>' +
        '</details>'
      }).join('')
    }
    /* 数据来自 changelog.js（用 <script src> 加载 —— 直接双击 index.html、file:// 下也能读，
       老大 1012 实测：用 fetch 读 json 在 file:// 会被浏览器拦掉，只剩"加载不出来"的兜底）。
       万一 changelog.js 没被部署，再退回 fetch 同目录的 changelog.json（http 部署下可用）。 */
    var clData = window.__NIS_CHANGELOG
    if (clData && clData.length) {
      clRender(clData)
    } else {
      fetch('changelog.json', { cache: 'no-cache' })
        .then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status)
          return r.json()
        })
        .then(function (list) {
          if (list && list.length) clRender(list)
        })
        .catch(function () {
          clBox.innerHTML = '<p class="cl__more">更新日志暂时加载不出来。' +
            '<a href="https://github.com/Siwendelimao/Nis/releases" target="_blank" rel="noopener">在 GitHub 查看全部版本</a></p>'
        })
    }
  }
})()
