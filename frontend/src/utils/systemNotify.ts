import { useSettingsStore } from '@/stores/settings'
import { playNotifySound } from './notifySound'

export type NotifyCategory = 'agent' | 'permission' | 'error' | 'memory' | 'channel'

interface SystemNotifyOptions {
  title: string
  message?: string
  category: NotifyCategory
  /** true = 只播提示音、不弹系统通知（如 agent 完成，回复已在窗口内可见） */
  soundOnly?: boolean
  /** 0914c：关联会话 id——点击系统通知可直达对应对话窗口；通道（QQ/微信）通知不传=不跳转 */
  sessionId?: string
}

async function ensurePermission(): Promise<boolean> {
  if (typeof Notification === 'undefined') return false
  if (Notification.permission === 'granted') return true
  // 0914b：后台事件（AI 回复完成等）里**不再**主动 requestPermission——
  // Chromium 在非手势上下文里的授权请求会被静默拒绝，反而污染用户观感；
  // 授权改在用户手势里做：发送消息时 primeNotificationPermission() + 设置页「发送测试通知」按钮。
  return false
}

/** 仅在「用户手势」回调里调用：把通知权限从 default 拉起（浏览器只弹一次授权框）。 */
export function primeNotificationPermission(): void {
  try {
    if ((window as any).__TAURI_INTERNALS__) return
    if (typeof Notification === 'undefined') return
    if (Notification.permission === 'default') void Notification.requestPermission()
  } catch { /* ignore */ }
}

/** 0914c：点击系统通知 → 聚焦窗口 + 打开对应对话（会话不在列表里时只聚焦，静默不报错）
 *  ★0927：打开后**强制补账一次**（实测"点通知回来还是旧内容、刷新才有"）。
 *  原来的 `openConversation` 对"已有本地节点"的会话是早退的；而通知点击恰好是最容易
 *  落在"旧快照"上的路径（人在别的窗口、消息是后台到的）。这里显式触发一次对齐。 */
function jumpToConversation(sessionId: string): void {
  try { window.focus() } catch { /* ignore */ }
  void import('@/stores/conversations')
    .then((m) => {
      const store = m.useConversationsStore()
      if (!store.getById(sessionId)) return
      /* ★0927：点通知回来 = 明确意图 ⇒ **无条件按服务端重建**这一条（不靠"缺整轮"的时间戳判定，
         那条判定有漏判风险；实测"点通知回来还是旧内容、刷新才好"连抓两次）。
         正在流式时重建函数自己会跳过（保实时流）。 */
      void store.openConversation(sessionId).then(() => store.rebuildConversationFromServer(sessionId))
    })
    .catch(() => { /* ignore */ })
}

/**
 * Windows 系统通知统一入口（设置→提示 的开关只控制这里）。
 *
 * 优先级：
 *  1. Tauri 桌面端 → tauri-plugin-notification 原生 toast（Rust 工具链修复后生效）
 *  2. 浏览器 → Web Notification API（localhost/Edge 直接可弹）
 *
 * 受设置「系统提示」对应类别开关门控；未授权/失败时静默返回 false。
 * 静默记录（软件内通知中心）由调用方另走 pushSystem，不受此门控。
 */
export async function notifySystem(opts: SystemNotifyOptions): Promise<boolean> {
  const settings = useSettingsStore()
  const gates: Record<NotifyCategory, boolean> = {
    agent: settings.notify.agent,
    permission: settings.notify.permission,
    error: settings.notify.error,
    memory: settings.notify.memory,
    // 0914 下午：QQ/微信机器人回复消息（后端 host/channel-reply 帧触发）
    channel: settings.notify.channel,
  }
  if (!gates[opts.category]) return false

  // 播放该类别配置的提示音（同样受开关门控；被浏览器拦截时静默）
  playNotifySound(opts.category)

  // 只播声音不弹通知
  if (opts.soundOnly) return true

  // Tauri 桌面端 → 原生通知插件
  if ((window as any).__TAURI_INTERNALS__) {
    try {
      const { isPermissionGranted, requestPermission, sendNotification } = await import('@tauri-apps/plugin-notification')
      let granted = await isPermissionGranted()
      if (!granted) granted = (await requestPermission()) === 'granted'
      if (granted) {
        sendNotification({ title: opts.title, body: opts.message || '' })
        return true
      }
      return false
    } catch {
      // 插件未接线 → 回落浏览器 API
    }
  }

  // 浏览器 → Web Notification API
  if (!(await ensurePermission())) return false
  try {
    const n = new Notification(opts.title, { body: opts.message || '', icon: '/nis-logo2.png' })
    // 0914c：点击通知 → 聚焦窗口；带 sessionId 的（agent/审批/记忆）再直达对应对话窗口
    //（QQ/微信通道通知不带 sessionId，只聚焦不跳转——用户拍板「不需要」）
    n.onclick = () => {
      try { n.close() } catch { /* ignore */ }
      if (opts.sessionId) jumpToConversation(opts.sessionId)
      else { try { window.focus() } catch { /* ignore */ } }
    }
    setTimeout(() => n.close?.(), 8000)
    return true
  } catch {
    return false
  }
}
