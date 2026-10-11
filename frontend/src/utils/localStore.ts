/**
 * 0915：前端持久化统一入口 —— **替代 localStorage**。
 *
 * 为什么必须搬走后端：
 *   打包版后端端口是动态的（要避开开发后端占用的 8766），窗口 origin 因此每次启动都可能变；
 *   而 localStorage 按 origin 隔离 → 语言 / 主题 / 项目列表 / 伙伴别名 / 引导完成标记等
 *   **每次启动全部丢失**（实测症状：引导页每次都弹、设置被重置）。
 *   落到后端 `data/ui-state.json` 后随数据目录一起备份/迁移，且与端口无关。
 *
 * 形态：同步内存镜像 + 写透后端（防抖合并），保持与 localStorage 完全相同的调用手感，
 * 所有调用点只需把 `localStorage` 换成 `localStore`。
 *
 * 唯一保留的 localStorage 访问：首次 hydrate 时的**一次性迁移读取**（把旧数据搬进来），此后只读不再写。
 */
import { BRIDGE_URL } from './bridgeUrl'
import { authHeaders } from './nisToken'

const MAP = new Map<string, string>()
/** T3-0928: unloading 期间的写透带 keepalive，避免关窗/刷新时请求被浏览器取消 */
let unloading = false
/** 已完成一次**成功**水合（失败不置位 → 允许稍后重试；见 hydrate 注释） */
let hydrated = false
/** 水合成功后的回调（App 用它重新判定「是否该弹引导页」） */
const hydrateListeners: Array<() => void> = []

/** 是否已经拿到后端持久化状态（false = 内存镜像是空的，**不能**据此判断"用户没做过引导"） */
export function isHydrated(): boolean {
  return hydrated
}

/** 注册水合成功回调；返回取消函数 */
export function onHydrated(fn: () => void): () => void {
  hydrateListeners.push(fn)
  if (hydrated) { try { fn() } catch { /* ignore */ } }
  return () => {
    const i = hydrateListeners.indexOf(fn)
    if (i >= 0) hydrateListeners.splice(i, 1)
  }
}

/** 待写透到后端的变更：值为 null 表示删除 */
let pendingPatch: Record<string, string | null> = {}
let flushTimer: ReturnType<typeof setTimeout> | null = null
const FLUSH_DELAY = 250

async function rpc(method: string, payload: any = {}): Promise<any> {
  const rpcId = crypto.randomUUID()
  const res = await fetch(`${BRIDGE_URL}/api/${method}`, {
    method: 'POST',
    /* ★1012 修：这里原先**没带访问令牌** ⇒ 远程访问（非 loopback）时后端回 403
       ⇒ hydrate 读不到设置 ⇒ 全部回退默认值（症状：本机改了设置，手机上不生效）。
       与 chat/conversations/notebook 三处保持同一口径（x-nis-token 头优先）。 */
    headers: { 'content-type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
    keepalive: unloading,
  })
  if (!res.ok) throw new Error(`Bridge API ${method} failed: ${res.status}`)
  const data = await res.json()
  if (data?.result?.ok === false) throw new Error(String(data.result.error))
  return data?.result?.value
}

/** 带超时的 rpc：**水合绝不能把界面卡住** —— 后端异常时宁可先用空状态渲染 */
async function rpcWithTimeout(method: string, payload: any = {}, ms = 3000): Promise<any> {
  return await Promise.race([
    rpc(method, payload),
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms)),
  ])
}

/** 把待写变更推给后端（失败则回滚进 pending 等下次） */
async function flush(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  const patch = pendingPatch
  if (!Object.keys(patch).length) return
  pendingPatch = {}
  try {
    /* ★1012：同上，远端写回也放宽（写的是增量 patch，通常很小，但链路慢时 4s 也会失败） */
    await rpcWithTimeout('uiState.merge', { patch }, 15000)
  } catch {
    // 后端不可用：并回 pending，下次再试（内存镜像仍然正确，界面不受影响）
    pendingPatch = { ...patch, ...pendingPatch }
  }
}

function scheduleFlush(): void {
  if (flushTimer) return
  flushTimer = setTimeout(() => { void flush() }, FLUSH_DELAY)
}

/**
 * 启动时调用一次（在 app.mount 之前），把后端状态灌进内存镜像。
 * 若后端为空且浏览器里还有旧 localStorage 数据，做一次性迁移。
 *
 * ⚠️ 0917c：**只有成功才置 hydrated**。此前无论成败都置位 → 后端重启/首启竞态下
 *   `uiState.load` 超时（3s）时内存镜像是空的，而读侧无从区分"没存过"与"没读到"，
 *   于是「引导已完成」被误判成「没引导过」→ 引导页又弹一次（用户实报）。
 *   现在失败保持未水合，调用方可重试，且读侧可用 isHydrated() 先确认状态可信。
 */
export async function hydrate(): Promise<boolean> {
  if (hydrated) return true
  try {
    /* ★1012 修：远端经隧道拉 uiState.load 要 30s 附近（nis-settings 里含约 1.7MB 背景图 base64），
       原来只有 3s ⇒ 远程必然超时 ⇒ 设置全部回退默认值（症状：本机改设置、手机不生效）。
       先放大到 25s 兜住；治本方案是让背景图别塞在设置里（另行处理）。 */
    const v = await rpcWithTimeout('uiState.load', {}, 60000)
    const state = (v?.state || {}) as Record<string, unknown>
    for (const [k, val] of Object.entries(state)) {
      if (typeof val === 'string') MAP.set(k, val)
    }
    // ── 一次性迁移：后端还是空的，但当前 origin 的 localStorage 里有旧数据 ──
    if (!MAP.size) {
      try {
        const migrated: Record<string, string> = {}
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i)
          if (!k) continue
          const val = localStorage.getItem(k)
          if (val == null) continue
          MAP.set(k, val)
          migrated[k] = val
        }
        if (Object.keys(migrated).length) {
          pendingPatch = { ...pendingPatch, ...migrated }
          await flush()
        }
      } catch { /* localStorage 不可用：忽略 */ }
    }
    hydrated = true
    for (const fn of hydrateListeners) { try { fn() } catch { /* 单个回调出错不影响其他 */ } }
    return true
  } catch {
    // 后端未就绪：**不置 hydrated**，保持空镜像继续渲染（界面照常可用），等调用方重试
    return false
  }
}

export const localStore = {
  get length(): number {
    return MAP.size
  },
  key(i: number): string | null {
    return Array.from(MAP.keys())[i] ?? null
  },
  getItem(k: string): string | null {
    return MAP.has(k) ? (MAP.get(k) as string) : null
  },
  setItem(k: string, v: unknown): void {
    const s = String(v)
    MAP.set(k, s)
    pendingPatch[k] = s
    scheduleFlush()
  },
  removeItem(k: string): void {
    if (!MAP.has(k)) return
    MAP.delete(k)
    pendingPatch[k] = null
    scheduleFlush()
  },
  clear(): void {
    for (const k of MAP.keys()) pendingPatch[k] = null
    MAP.clear()
    scheduleFlush()
  },
  /** 立即写透（关键状态用它，例如「引导已完成」——不能让防抖窗口吃掉） */
  flushNow(): Promise<void> {
    return flush()
  },
}

// 关窗/切后台时尽量把尾巴写出去（keepalive 让请求在卸载后仍能完成）
if (typeof window !== 'undefined') {
  const onUnload = () => { unloading = true; void flush() }
  window.addEventListener('pagehide', onUnload)
  window.addEventListener('beforeunload', onUnload)
}
