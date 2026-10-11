import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { BRIDGE_URL } from '../utils/bridgeUrl'
import { authHeaders } from '@/utils/nisToken'

/**
 * 用户记事本（0920）—— 用户与 AI **共用**的一本待办/便签。
 *
 * 数据在后端 `<数据根>/notebook.json`（backend/notebookStore.ts），
 * AI 侧走 notebook_list / notebook_add / notebook_update / notebook_delete 四个工具，
 * 与本 store 共用同一份文件 —— 所以两边天然同步。
 *
 * 刷新时机：打开弹窗时拉全量（条目量级是几十条，本地过滤比每次切筛选都打一次后端更跟手）。
 */
/* ★ 0923：新增两态 —— pending 待拍板（等用户决策）/ testing 待测（等验证） */
export type NotebookStatus = 'todo' | 'hold' | 'pending' | 'testing' | 'done' | 'cancelled'

export interface NotebookItem {
  id: string
  title: string
  detail: string
  status: NotebookStatus
  source: 'user' | 'ai'
  tags: string[]
  /** ★ 1011：详情里贴的图片（ref → /api/notebook-asset/<ref>） */
  images?: NotebookImage[]
  createdAt: number
  updatedAt: number
}

/** ★ 1011：便签图片（只带引用与元数据，本体在后端 notebook-assets/ 目录） */
export interface NotebookImage {
  /** 内容寻址引用：<sha256>.<ext> */
  ref: string
  name: string
  mime: string
  bytes: number
}

/** 图片直出地址：dev 走 vite 的 /api 代理、打包版同源 —— 所以相对路径即可 */
export function notebookImageUrl(ref: string): string {
  return `/api/notebook-asset/${encodeURIComponent(String(ref || ''))}`
}

export const NOTEBOOK_STATUSES: NotebookStatus[] = ['todo', 'hold', 'pending', 'testing', 'done', 'cancelled']

/** 状态配色（前端唯一口径：chip / 菜单 / 图标都从这里取） */
export const NOTEBOOK_STATUS_STYLE: Record<NotebookStatus, { icon: string; cls: string }> = {
  todo: { icon: 'far fa-circle', cls: 'is-todo' },
  hold: { icon: 'far fa-circle-pause', cls: 'is-hold' },
  pending: { icon: 'far fa-circle-question', cls: 'is-pending' },
  testing: { icon: 'fas fa-flask', cls: 'is-testing' },
  done: { icon: 'fas fa-circle-check', cls: 'is-done' },
  cancelled: { icon: 'fas fa-circle-xmark', cls: 'is-cancelled' },
}

async function bridgeRpc(method: string, payload: any = {}, timeoutMs = 30000): Promise<any> {
  const rpcId = crypto.randomUUID()
  let res: Response
  try {
    res = await fetch(`${BRIDGE_URL}/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders() },
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
    })
  } catch (e: any) {
    if (e?.name === 'TimeoutError') throw new Error(`后端响应超时（${method}，${Math.round(timeoutMs / 1000)}s 无响应——后端可能正忙，可重试）`)
    throw e
  }
  if (!res.ok) throw new Error(`Bridge API ${method} failed: ${res.status}`)
  const data = await res.json()
  if (data.result?.ok === false) throw new Error(data.result.error)
  return data.result?.value
}

export const useNotebookStore = defineStore('notebook', () => {
  const items = ref<NotebookItem[]>([])
  const loading = ref(false)
  const error = ref('')
  /** 面板里的筛选（本地过滤，不打后端） */
  const filter = ref<'all' | NotebookStatus>('all')
  const keyword = ref('')

  const counts = computed(() => {
    const c = { todo: 0, hold: 0, pending: 0, testing: 0, done: 0, cancelled: 0 } as Record<NotebookStatus, number>
    for (const it of items.value) c[it.status]++
    return c
  })

  const visible = computed(() => {
    const kw = keyword.value.trim().toLowerCase()
    return items.value.filter(it => {
      if (filter.value !== 'all' && it.status !== filter.value) return false
      if (!kw) return true
      return it.title.toLowerCase().includes(kw)
        || it.detail.toLowerCase().includes(kw)
        || it.tags.some(t => t.toLowerCase().includes(kw))
    })
  })

  async function load() {
    loading.value = true
    try {
      const r = await bridgeRpc('notebook.list', {})
      items.value = Array.isArray(r?.items) ? r.items : []
      error.value = ''
    } catch (e: any) {
      error.value = String(e?.message || e).slice(0, 200)
    } finally {
      loading.value = false
    }
  }

  async function add(payload: { title: string; detail?: string; status?: NotebookStatus }) {
    const r = await bridgeRpc('notebook.add', payload)
    await load()
    return r?.item as NotebookItem | undefined
  }

  async function update(id: string, patch: Partial<Pick<NotebookItem, 'title' | 'detail' | 'status' | 'tags' | 'images'>>) {
    const r = await bridgeRpc('notebook.update', { id, ...patch })
    // 局部更新即可（避免整表重排导致刚点的条目跳位）
    const i = items.value.findIndex(x => x.id === id)
    if (i >= 0 && r?.item) items.value[i] = r.item
    else await load()
    return r?.item as NotebookItem | undefined
  }

  async function remove(id: string) {
    await bridgeRpc('notebook.remove', { id })
    items.value = items.value.filter(x => x.id !== id)
  }

  /** ★ 1011：贴图 —— dataURL 交后端落盘，拿回引用（同一张图后端自动去重）。
   *  走的是"先落盘、保存条目时再提交 images"的两步：所以贴完不保存也不脏数据（只是盘上多份图）。 */
  async function addImage(dataUrl: string, name: string) {
    const r = await bridgeRpc('notebook.imageAdd', { dataUrl, name }, 60000)
    return r?.image as NotebookImage | undefined
  }

  return { items, loading, error, filter, keyword, counts, visible, load, add, update, remove, addImage }
})
