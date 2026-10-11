import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { t } from '@/utils/i18n'
import { localStore } from '@/utils/localStore'

type NotificationType = 'message' | 'success' | 'warning' | 'error'

export interface NotificationItem {
  id: number
  text: string
  actions: { id: string; label: string }[]
  type: NotificationType
  /** 由组件测量，用于精确叠堆 */
  measuredHeight?: number
  /** 创建序号（旧→新递增），用于冻结叠堆缩放，避免新通知到达时旧卡重排 */
  level: number
  /** 附加数据（如 task_id，供动作按钮回传） */
  meta?: Record<string, any>
}

/** 系统通知中心条目：常驻侧边栏铃铛，不随聊天窗口关闭而消失 */
interface SystemNotificationItem {
  id: number
  title: string
  message: string
  type: NotificationType
  /** 事件类别，与设置「系统提示」开关对应：agent / permission / error / memory */
  category: 'agent' | 'permission' | 'error' | 'memory'
  time: number
  read: boolean
  /** ★1013e（用户："为空的时候系统通知常驻一个不可以关的通知"）：**常驻**条目 ——
   *  面板里不显示单条清除按钮，"清空"也不清它；要它消失只能把状态修好（如配好后台模型）。 */
  sticky?: boolean
  /** ★1013e：稳定去重键（同 key 只保留一条，重复推送只刷新内容/时间，不堆叠） */
  key?: string
  /** 0920：关联会话 id —— 带它的条目在面板里显示「查看对话」按钮，一键直达（用户 0920 反馈） */
  sessionId?: string
  /** 0920：静默条目（如"AI 回复完成"这种高频常驻记录）—— 只入列表，**不自动弹开面板**、不抢焦点。
   *  没有这个字段的高优先级通知（审批/错误等）到达时仍会自动展开。 */
  silent?: boolean
}

const SYSTEM_KEY = 'nis-system-notifications'
const SYSTEM_MAX = 50

function loadSystemList(): SystemNotificationItem[] {
  try {
    const raw = localStore.getItem(SYSTEM_KEY)
    if (!raw) return []
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr)) return []
    return arr.filter((x: any) => x && typeof x.id === 'number').slice(0, SYSTEM_MAX)
  } catch {
    return []
  }
}

/**
 * 顶部通知 store —— 接收后端 SYSTEM_NOTIFICATION。
 *
 * 规则：
 *   - 通知只堆叠、不自动消失，新通知排在最前
 *   - 点动作按钮 / 关闭才消除
 *   - 演示：聊天输入框发送 `/test 顶部通知` 触发一条
 *
 * 系统通知中心（system 列表）：
 *   - 常驻侧边栏铃铛，localStorage 持久化，跨聊天窗口/刷新存活
 *   - 静默记录，不受设置「系统提示」开关门控（那组开关只控制 Windows 系统通知）
 */
export const useNotificationsStore = defineStore('notifications', () => {
  const toasts = ref<NotificationItem[]>([])
  const system = ref<SystemNotificationItem[]>(loadSystemList())
  let idCounter = 0
  let levelCounter = 0

  function mapLevel(level: string): NotificationType {
    switch (level) {
      case 'success': return 'success'
      case 'warning': return 'warning'
      case 'error':
      case 'critical': return 'error'
      default: return 'message'
    }
  }

  function buildText(title: string, message: string): string {
    const tt = title || t('notice.defaultTitle')
    if (!message) return tt
    return `${tt}：${message}`
  }

  function persistSystem() {
    try {
      localStore.setItem(SYSTEM_KEY, JSON.stringify(system.value.slice(0, SYSTEM_MAX)))
    } catch {
      /* ignore */
    }
  }

  /** 由后端 SYSTEM_NOTIFICATION 调用，或 /test 命令触发 */
  function push(msg: Record<string, any>) {
    const isRecommend = msg.project_id != null && Array.isArray(msg.partners)
    if (isRecommend) {
      // #8 推荐卡只做"同项目刷新"：重复推送同项目推荐时替换旧卡，不跨项目删（隔离由展示层按当前项目过滤）
      const sameProjectId = String(msg.project_id)
      toasts.value = toasts.value.filter(t =>
        !(t.meta?.project_id && String(t.meta.project_id) === sameProjectId))
    }
    const actions = Array.isArray(msg.actions)
      ? msg.actions.map(a => ({ id: String(a.id || ''), label: String(a.label || t('notice.actionDefault')) }))
      : []
    const meta: Record<string, any> = {}
    if (msg.task_id != null) meta.task_id = String(msg.task_id)
    if (msg.project_id != null) meta.project_id = String(msg.project_id)
    if (Array.isArray(msg.partners)) meta.partners = msg.partners
    // 新通知追加到末尾（DOM 最后 = 绘制在最前面，与源码一致）
    // 0911 修复：20 处调用点传的是 content（非 message），旧代码只读 message → 正文恒为空被吞掉。
    const lv = mapLevel(String(msg.level || 'info'))
    toasts.value.push({
      id: ++idCounter,
      text: buildText(String(msg.title || ''), String(msg.message ?? msg.content ?? '')),
      type: lv,
      actions,
      level: levelCounter++,
      meta,
    })
    // 0914（设置→提示接线）：错误类 → 系统通知（受「错误」开关门控；未授权/失败静默）
    if (lv === 'error') {
      void import('@/utils/systemNotify')
        .then((m) =>
          m.notifySystem({
            category: 'error',
            title: String(msg.title || t('notice.defaultTitle')),
            message: String(msg.message ?? msg.content ?? '').slice(0, 120),
          }),
        )
        .catch(() => { /* ignore */ })
    }
  }

  /**
   * 系统通知中心：常驻侧边栏铃铛（不随聊天窗口消失），静默记录。
   * 只做软件内记录，不受设置「系统提示」开关门控（那组开关只控制 Windows 系统通知）。
   */
  function pushSystem(msg: {
    title: string
    message?: string
    level?: string
    category?: 'agent' | 'permission' | 'error' | 'memory'
    /** 关联会话：面板里出现「查看对话」按钮（点击直达该会话） */
    sessionId?: string
    /** 静默入列：不触发面板自动展开（高频记录类用它，免得每次回复都弹面板） */
    silent?: boolean
    /** ★1013e：常驻条目（不可单条关掉、"清空"也不清） */
    sticky?: boolean
    /** ★1013e：去重键 —— 同 key 已存在时**只刷新内容**，不新增（避免每次评估都堆一条） */
    key?: string
  }) {
    const category = msg.category || 'agent'
    const lv = mapLevel(String(msg.level || 'info'))
    /* ★1013e：常驻条目按 key 去重（同一件事只留一条：刷新内容/时间，并重新标未读） */
    if (msg.key) {
      const exist = system.value.find(x => x.key === msg.key)
      if (exist) {
        exist.title = msg.title || t('notice.defaultTitle')
        exist.message = msg.message || ''
        exist.type = lv
        exist.category = category
        exist.time = Date.now()
        exist.read = false
        exist.sticky = !!msg.sticky
        persistSystem()
        return
      }
    }
    system.value.unshift({
      id: ++idCounter,
      title: msg.title || t('notice.defaultTitle'),
      message: msg.message || '',
      type: lv,
      category,
      time: Date.now(),
      read: false,
      sessionId: msg.sessionId || undefined,
      silent: !!msg.silent,
      sticky: !!msg.sticky,
      key: msg.key || undefined,
    })
    /* ★1013e：截断时**不许把常驻条目挤掉**（否则"常驻"就是句空话） */
    const capped = system.value.slice(0, SYSTEM_MAX)
    const stickyKept = system.value.filter(x => x.sticky && !capped.includes(x))
    system.value = capped.concat(stickyKept)
    persistSystem()
  }

  function markSystemRead(id: number) {
    const item = system.value.find(x => x.id === id)
    if (item) {
      item.read = true
      persistSystem()
    }
  }

  function markAllSystemRead() {
    system.value.forEach(x => { x.read = true })
    persistSystem()
  }

  function clearSystem() {
    /* ★1013e：清空**保留常驻条目**（"后台模型未配置"这类必须处理的状态不该被一键清掉） */
    system.value = system.value.filter(x => x.sticky)
    persistSystem()
  }

  /** 0920：删除单条系统通知（面板里每条右侧的清除按钮）；★1013e：**常驻条目拒绝删除** */
  function removeSystem(id: number) {
    const it = system.value.find(x => x.id === id)
    if (it?.sticky) return
    const before = system.value.length
    system.value = system.value.filter(x => x.id !== id)
    if (system.value.length !== before) persistSystem()
  }

  /** ★1013e：按 key 移除常驻条目（状态修好后调用，如"后台模型已配好"） */
  function removeSystemByKey(key: string) {
    const before = system.value.length
    system.value = system.value.filter(x => x.key !== key)
    if (system.value.length !== before) persistSystem()
  }

  function remove(id: number) {
    toasts.value = toasts.value.filter(t => t.id !== id)
  }

  const badgeCount = computed(() => toasts.value.length)
  const unreadSystemCount = computed(() => system.value.filter(x => !x.read).length)

  return {
    toasts,
    system,
    badgeCount,
    unreadSystemCount,
    push,
    remove,
    pushSystem,
    markSystemRead,
    markAllSystemRead,
    clearSystem,
    removeSystem,
    removeSystemByKey,
  }
})
