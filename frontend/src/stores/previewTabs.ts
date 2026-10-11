import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { useConversationsStore } from './conversations'

type PreviewTabKind = 'browser' | 'image' | 'file' | 'html'

interface PreviewTab {
  id: string
  /** 去重键：file:<path> / url:<href> / data:<uuid>，同键聚焦已有 tab */
  key: string
  kind: PreviewTabKind
  title: string
  /** 网页 URL（kind=browser） */
  src?: string
  /** 文件/HTML 内容（kind=file/html） */
  content?: string
  /** 图片 dataURL（kind=image） */
  dataUrl?: string
  /** 原生 File/Blob 对象（交给 open-file-viewer 预览 PDF/Office/音视频等） */
  file?: File | Blob
  /** 文件 MIME 类型 */
  mimeType?: string
  /** 所属项目 id：项目窗口共享文件内容（第二步内存释放时保留项目共享） */
  projectId?: string
  /** 工作区文件真实相对路径（工作区面板/产物卡发起的 tab 才有）——
   *  HTML 页面模式据此走 /api/workspace-file 代理加载相对 css/js；
   *  拖入/消息内预览无工作区路径，必须缺省回退 srcdoc（否则代理 stat 失败报 ENOENT） */
  srcPath?: string
  /** 前端页面预览模式：page=渲染页面 / code=查看源码（HTML 文件可用） */
  viewMode?: 'page' | 'code'
  /** 后台占用已释放标记（第二步：非当前窗口 60s 自动释放） */
  released: boolean
  /** 最后激活时间戳 */
  lastActiveAt: number
  /** 0908：AI 通道（preview/open）后台打开/更新的标记——不抢用户视图，tab 上亮琥珀点，
   *  用户点击（setActive/activate=true 复用）即清除。用户主动发起的 openTab 永远不带此标记 */
  aiNotice?: boolean
}

/**
 * 预览标签页 store —— 严格按对话窗口隔离（防串台铁律）
 *
 * 隔离规则：
 *   - tabsByConv / activeTabByConv 均按 convId 键控，窗口之间互不可见
 *   - 项目下子窗口的「文件内容」共享走 workspace store 的 filesByProject
 *     （此处只存 tab 视图状态，不存文件内容）
 *   - 消息归属一律先经 msgConvId() 取 convId，再访问本 store
 *
 * 内存释放（预留，第二步实现）：
 *   - released 字段 + lastActiveAt 已备好；非当前窗口超 60s 的 tab
 *     置 released=true，iframe src 置空回收资源，点击后重新加载
 */
/** 后台释放扫描间隔（第二步内存释放） */
const SWEEP_INTERVAL_MS = 60_000
/** 模块级防重：HMR 重载模块时不重复启动定时器 */
const SWEEP_TIMER_KEY = '__nisPreviewTabsSweepTimer__'

/** 固定视图（非预览 tab 的内容区模式）：chat=对话 / browser=浏览器 / office=办公室 / canvas=画布 */
type FixedView = 'chat' | 'browser' | 'office' | 'canvas'

export const usePreviewTabsStore = defineStore('previewTabs', () => {
  /** 每个对话窗口的 tab 列表（严格隔离） */
  const tabsByConv = ref<Record<string, PreviewTab[]>>({})
  /** 每个对话窗口当前激活的 tab id */
  const activeTabByConv = ref<Record<string, string>>({})
  /** 每个对话窗口的固定视图（chat/browser/office），与预览 tab 互斥 */
  const fixedViewByConv = ref<Record<string, FixedView>>({})

  function ensure(convId: string): PreviewTab[] {
    if (!tabsByConv.value[convId]) tabsByConv.value[convId] = []
    return tabsByConv.value[convId]
  }

  /** 某窗口的 tab 列表 */
  function tabsFor(convId: string): PreviewTab[] {
    return tabsByConv.value[convId] || []
  }

  /** 某窗口当前激活 tab id（null = 显示对话） */
  function activeTabId(convId: string): string | null {
    return activeTabByConv.value[convId] ?? null
  }

  /** 某窗口当前固定视图 */
  function fixedView(convId: string): FixedView {
    return fixedViewByConv.value[convId] || 'chat'
  }

  /**
   * 切换固定视图（浏览器/办公室/对话）。
   * 进入 browser/office 时取消预览 tab 激活（内容区互斥）；回 chat 保留原 tab 选择。
   */
  function setFixedView(convId: string, view: FixedView) {
    fixedViewByConv.value[convId] = view
    if (view !== 'chat') {
      activeTabByConv.value[convId] = null
    }
  }

  /** 0914c：设置→显示办公室=关时调用——所有会话的办公室视图回退到对话（防"关闭后仍停在办公室"） */
  function clearOfficeViews() {
    for (const [id, v] of Object.entries(fixedViewByConv.value)) {
      if (v === 'office') fixedViewByConv.value[id] = 'chat'
    }
  }

  /** 打开（或聚焦已有）tab；同 key 复用，返回 tab id。
   *  opts.activate=false（AI 通道）：不抢用户视图——只登记/更新 tab 并亮 aiNotice 琥珀点；
   *  默认（用户主动）：切过去看（原行为）。
   *  0908：同 key 复用时同步更新 content/dataUrl/src——AI 改文件后再预览不再开重复 tab、也不再显示旧内容 */
  function openTab(convId: string, tab: Omit<PreviewTab, 'id' | 'released' | 'lastActiveAt'>, opts?: { activate?: boolean }): string {
    const list = ensure(convId)
    const activate = opts?.activate !== false
    const existing = list.find(t => t.key === tab.key)
    if (existing) {
      existing.released = false
      existing.content = tab.content ?? existing.content
      existing.dataUrl = tab.dataUrl ?? existing.dataUrl
      existing.src = tab.src ?? existing.src
      existing.title = tab.title || existing.title
      if (activate) {
        existing.lastActiveAt = Date.now()
        existing.aiNotice = false
        activeTabByConv.value[convId] = existing.id
        // 打开预览 tab 即退出固定视图（回到 chat 模式，内容区显示预览）
        fixedViewByConv.value[convId] = 'chat'
      } else {
        // AI 后台刷新：用户正开着该 tab → 内容更新即时可见，不打点；没开着 → 琥珀点提示
        existing.aiNotice = activeTabByConv.value[convId] !== existing.id
      }
      return existing.id
    }
    const id = 'tab-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6)
    list.push({
      ...tab,
      id,
      released: false,
      lastActiveAt: Date.now(),
      aiNotice: !activate,
    })
    if (activate) {
      activeTabByConv.value[convId] = id
      fixedViewByConv.value[convId] = 'chat'
    }
    return id
  }

  /** 关闭窗口内某 tab（对话 tab 由外部保证不在此列表） */
  function closeTab(convId: string, tabId: string) {
    const list = tabsByConv.value[convId]
    if (!list) return
    const idx = list.findIndex(t => t.id === tabId)
    if (idx === -1) return
    list.splice(idx, 1)
    if (activeTabByConv.value[convId] === tabId) {
      // 激活项被关：回退到对话（null）
      activeTabByConv.value[convId] = null
    }
  }

  /** 切换某窗口的激活 tab（null = 显示对话） */
  function setActive(convId: string, tabId: string | null) {
    if (tabId) {
      const tab = tabsFor(convId).find(t => t.id === tabId)
      if (tab) {
        // 已释放的后台 tab：点击即复活（重新加载内容）
        tab.released = false
        tab.lastActiveAt = Date.now()
        tab.aiNotice = false   // 用户点到了=AI 提示已读
      }
    }
    activeTabByConv.value[convId] = tabId
    if (tabId) fixedViewByConv.value[convId] = 'chat'
  }

  /** 关闭某窗口全部预览 tab（删除对话时调用，防止泄漏） */
  function closeAll(convId: string) {
    delete tabsByConv.value[convId]
    delete activeTabByConv.value[convId]
    delete fixedViewByConv.value[convId]
  }

  /** 释放过期后台 tab（未激活超过 60s → released=true，内容区展示占位、点击复活） */
  function sweepInactive(releaseAfterMs = 60_000) {
    const convs = useConversationsStore()
    const activeConvId = convs.activeConversationId
    const now = Date.now()
    for (const [convId, list] of Object.entries(tabsByConv.value)) {
      const isCurrentWindow = convId === activeConvId
      for (const tab of list) {
        const isActiveTab = isCurrentWindow && activeTabByConv.value[convId] === tab.id
        if (!isActiveTab && !tab.released && now - tab.lastActiveAt > releaseAfterMs) {
          tab.released = true
        }
      }
    }
  }

  /** 定时扫描（60s 未使用释放；HMR 防重） */
  function startSweep() {
    const g = globalThis as any
    if (g[SWEEP_TIMER_KEY]) return
    g[SWEEP_TIMER_KEY] = setInterval(() => { sweepInactive() }, SWEEP_INTERVAL_MS)
  }

  /** 重新加载已释放的 tab */
  function revive(convId: string, tabId: string) {
    const tab = tabsFor(convId).find(t => t.id === tabId)
    if (!tab) return
    tab.released = false
    tab.lastActiveAt = Date.now()
  }

  /** 当前窗口的 tab 列表（模板便捷入口，含窗口隔离） */
  const currentTabs = computed(() => {
    const convs = useConversationsStore()
    const id = convs.activeConversationId
    return id != null ? tabsFor(String(id)) : []
  })

  startSweep()

  return {
    tabsByConv,
    activeTabByConv,
    fixedViewByConv,
    tabsFor,
    activeTabId,
    fixedView,
    setFixedView,
    clearOfficeViews,
    openTab,
    closeTab,
    setActive,
    closeAll,
    sweepInactive,
    revive,
    currentTabs,
  }
})
