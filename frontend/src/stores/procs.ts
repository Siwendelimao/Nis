/**
 * 进程监控 store（0922e）—— backend/processRegistry.ts 的镜像。
 *
 * 设计口径（0922e 定）：**只显示正在运行的**进程（哪怕只活 1 秒也显示），**结束就消失**
 *   ⇒ 这里不做历史、不落盘，只维护"此刻还有谁在跑"。
 * 数据来源：
 *   · 拉：`proc.list` RPC（打开面板时同步一次）
 *   · 推：host 帧 `proc/updated`（新增/更新）与 `proc/removed`（结束移除）
 *   · 停：`proc.kill`（后端会先做 pid 身份校验，防误杀）
 */
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { useChatStore } from './chat'

export interface TrackedProc {
  id: string
  pid: number
  name: string
  cmdline: string
  cwd?: string
  startedAt: number
  origin: { tool?: string; conversationId?: string; projectId?: string; label?: string }
}

export const useProcsStore = defineStore('procs', () => {
  const procs = ref<TrackedProc[]>([])
  const chatStore = useChatStore()

  const runningCount = computed(() => procs.value.length)

  function mapProc(p: any): TrackedProc {
    return {
      id: String(p?.id || `pid-${p?.pid}`),
      pid: Number(p?.pid) || 0,
      name: String(p?.name || 'process'),
      cmdline: String(p?.cmdline || ''),
      cwd: p?.cwd ? String(p.cwd) : undefined,
      startedAt: Number(p?.startedAt) || Date.now(),
      origin: {
        tool: p?.origin?.tool ? String(p.origin.tool) : '',
        conversationId: p?.origin?.conversationId ? String(p.origin.conversationId) : undefined,
        projectId: p?.origin?.projectId ? String(p.origin.projectId) : undefined,
        label: p?.origin?.label ? String(p.origin.label) : undefined,
      },
    }
  }

  /** 单条推送：有就**原位**更新（不挪动位置，避免行乱窜），没有就补进来 */
  function applyProc(p: any): void {
    if (!p || !p.id) return
    const m = mapProc(p)
    const i = procs.value.findIndex((x) => x.id === m.id)
    if (i >= 0) procs.value.splice(i, 1, m)
    else procs.value.push(m)
    procs.value.sort((a, b) => (a.startedAt - b.startedAt) || a.pid - b.pid)
  }

  function removeProc(id: string): void {
    const key = String(id)
    const i = procs.value.findIndex((x) => x.id === key)
    if (i >= 0) procs.value.splice(i, 1)
  }

  /** 拉一次全量（打开面板时） */
  async function sync(): Promise<void> {
    try {
      const r: any = await chatStore.bridgeRpc('proc.list', {})
      const list = Array.isArray(r?.procs) ? r.procs : []
      procs.value = list.map(mapProc).sort((a: TrackedProc, b: TrackedProc) => a.startedAt - b.startedAt)
    } catch (e) {
      console.warn('[procs] 同步失败:', e)
    }
  }

  /** 停掉一个进程（后端会做身份校验） */
  async function kill(id: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const r: any = await chatStore.bridgeRpc('proc.kill', { id })
      if (r && r.ok) removeProc(id)
      return r || { ok: false, error: 'no response' }
    } catch (e: any) {
      return { ok: false, error: String(e?.message || e) }
    }
  }

  return { procs, runningCount, applyProc, removeProc, sync, kill }
})
