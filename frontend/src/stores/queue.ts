import { defineStore } from 'pinia'
import { ref } from 'vue'

/**
 * 0909⑦ 排队消息 store —— 后端 session.queuedMessages 账本的**前端镜像**。
 * 权威源在后端（用户铁律：禁 localStorage 兜底；重启不丢、多窗口经 projection(key=queue) 帧同步同一份），
 * 这里只按 convId 存一份展示用快照 + 乐观 pending 标记（发出后到 message_start 回显前的"插话中/发送中"占位）。
 */
export interface QueueItem {
  id: string
  text: string
  attachments?: Array<{ name: string; dataUrl: string }>
  skills?: string[]
  model?: { provider: string; model_id: string; base?: string }
  effort?: string
  createdAt: number
  /** 0925：带 [[图片:N]] 位置标记的原文（**仅前端**用：排队项"撤回编辑"时照标记把图片标签插回原位）。
   *  后端 queue 账本只存干净 text（无标记），此字段经 projection/刷新会丢 → 丢失时退回"文字+附件" Plain 回灌。 */
  markerText?: string
}

export const useQueueStore = defineStore('queue', () => {
  /** convId → 排队消息数组（后端权威快照） */
  const byConv = ref<Record<string, QueueItem[]>>({})
  /** ★0927 N1：convId → 队列是否"暂停"（乙档：停止时按住了队列）。
   *  权威源同样在后端，随 `session/projection(key=queue)` 帧下发；**不持久化**（重启即恢复 continue，
   *  避免"重启后永远不发"的静默陷阱）——所以这里也只是内存镜像。 */
  const pausedByConv = ref<Record<string, boolean>>({})

  function get(convId: string | number | null | undefined): QueueItem[] {
    if (convId == null) return []
    return byConv.value[String(convId)] || []
  }
  function set(convId: string | number, list: QueueItem[]) {
    byConv.value[String(convId)] = list || []
  }
  function setPaused(convId: string | number, paused: boolean) {
    const k = String(convId)
    if (paused) pausedByConv.value[k] = true
    else if (pausedByConv.value[k]) delete pausedByConv.value[k]
  }
  function isPaused(convId: string | number | null | undefined): boolean {
    if (convId == null) return false
    return !!pausedByConv.value[String(convId)]
  }
  function clear(convId: string | number) {
    delete byConv.value[String(convId)]
    delete pausedByConv.value[String(convId)]
  }
  /** 乐观移除（点删除/编辑/拖序时先本地改，RPC 回来以后端快照为准覆盖） */
  function optimisticRemove(convId: string | number, id: string) {
    const key = String(convId)
    if (byConv.value[key]) byConv.value[key] = byConv.value[key].filter(q => q.id !== id)
  }

  return { byConv, pausedByConv, get, set, setPaused, isPaused, clear, optimisticRemove }
})
