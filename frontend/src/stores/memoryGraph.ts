import { defineStore } from 'pinia'
import { ref } from 'vue'
import { useChatStore } from './chat'
import { localStore } from '@/utils/localStore'

/**
 * 记忆网图 store —— 与后端 core/memory/memory_graph.py 对齐。
 * 已接通后端（memory_system.db 真实记忆）：
 *   Server → Client: MEMORY_GRAPH { nodes[], edges[] } / MEMORY_NODE_SYNCED / MEMORY_EDGE_SYNCED
 *   Client → Server: MEMORY_GRAPH_REQUEST / MEMORY_NODE_ADD / MEMORY_NODE_UPDATE / MEMORY_NODE_DELETE
 *                    MEMORY_EDGE_ADD / MEMORY_EDGE_DELETE
 * 不再使用 localStorage 演示数据；打开面板时 refresh() 拉取后端真实记忆。
 */
interface MemoryNode {
  id: string
  title: string
  content: string
  summary: string
  /** preference / decision / pitfall / pattern / fact */
  node_type: string
  scope: string
  project_id: string
  tags: string[]
  enabled: boolean
  created_at: number
  updated_at: number
}

interface MemoryEdge {
  id: string
  source_node: string
  target_node: string
  /** uses / has_pitfall / validated_by / related */
  relation: string
  created_at: number
}

/** 后端时间戳是秒级 float，统一转成前端毫秒 */
function toMs(v: number | undefined): number {
  if (v == null) return Date.now()
  return v < 1e12 ? Math.round(v * 1000) : Math.round(v)
}

export const useMemoryGraphStore = defineStore('memoryGraph', () => {
  const nodes = ref<MemoryNode[]>([])
  const edges = ref<MemoryEdge[]>([])
  const loaded = ref(false)

  function getNode(id: string): MemoryNode | undefined {
    return nodes.value.find(n => n.id === id)
  }

  /** 拉取后端真实记忆网图 */
  async function refresh(scope = 'all', projectId?: string) {
    try {
      const chatStore = useChatStore()
      const result = await chatStore.bridgeRpc('memory.graph', { scope, project_id: projectId || '' })
      applySnapshot(result)
    } catch (e) {
      console.error('[MemoryGraph] refresh failed:', e)
    }
  }

  /** 应用后端网图快照 */
  function applySnapshot(payload: { nodes?: MemoryNode[]; edges?: MemoryEdge[] }) {
    nodes.value = (payload.nodes || []).map(n => ({
      ...n,
      created_at: toMs(n.created_at),
      updated_at: toMs(n.updated_at),
    }))
    edges.value = (payload.edges || []).map(e => ({ ...e, created_at: toMs(e.created_at) }))
    loaded.value = true
  }

  // 清理旧 localStorage 演示数据（一次性）；改用 bridge RPC（打开面板时 refresh 拉真实数据）
  try {
    localStore.removeItem('nis-memory-graph')
  } catch { /* ignore */ }

  function addNode(data: Partial<MemoryNode>): MemoryNode {
    const now = Date.now()
    const node: MemoryNode = {
      id: '',
      title: (data.title || '').trim() || '未命名记忆',
      content: data.content || '',
      summary: data.summary || (data.content || '').slice(0, 60),
      node_type: data.node_type || 'fact',
      scope: data.scope || 'global',
      project_id: data.project_id || '',
      tags: Array.isArray(data.tags) ? data.tags : [],
      enabled: data.enabled !== false,
      created_at: now,
      updated_at: now,
    }
    // 乐观插入，RPC 成功后用后端 id 回填
    const chatStore = useChatStore()
    chatStore.bridgeRpc('memory.node.add', {
      title: node.title, content: node.content, summary: node.summary,
      node_type: node.node_type, scope: node.scope, project_id: node.project_id, tags: node.tags,
    }).then((result) => {
      if (result?.node?.id) {
        node.id = result.node.id
        const i = nodes.value.findIndex(n => n.id === node.id)
        if (i >= 0) nodes.value[i] = { ...node, ...result.node, created_at: toMs(result.node.created_at), updated_at: toMs(result.node.updated_at) }
      }
    }).catch(e => console.error('[MemoryGraph] addNode failed:', e))
    nodes.value.unshift(node)
    return node
  }

  function updateNode(id: string, changes: Partial<MemoryNode>) {
    const n = getNode(id)
    if (!n) return
    Object.assign(n, changes)
    n.updated_at = Date.now()
    const payload: Record<string, any> = { id }
    for (const k of ['title', 'content', 'summary', 'tags'] as const) {
      if (changes[k] !== undefined) payload[k] = changes[k]
    }
    useChatStore().bridgeRpc('memory.node.update', payload).catch(e => console.error('[MemoryGraph] updateNode failed:', e))
  }

  function deleteNode(id: string) {
    nodes.value = nodes.value.filter(n => n.id !== id)
    edges.value = edges.value.filter(e => e.source_node !== id && e.target_node !== id)
    // mem_ 前缀 = 长期记忆（memories 表），用 memory.delete 软删；mnode_ 前缀 = 网图节点，用 memory.node.delete
    if (id.startsWith('mem_')) {
      useChatStore().bridgeRpc('memory.delete', { id, hard: false }).catch(e => console.error('[MemoryGraph] deleteMemory failed:', e))
    } else {
      useChatStore().bridgeRpc('memory.node.delete', { id }).catch(e => console.error('[MemoryGraph] deleteNode failed:', e))
    }
  }

  /** 该节点直接相连的边 */
  function edgesForNode(id: string): MemoryEdge[] {
    return edges.value.filter(e => e.source_node === id || e.target_node === id)
  }

  /** 是否待确认（自动提炼进审核区，等用户采纳/丢弃） */
  function isPending(node: MemoryNode | undefined): boolean {
    return !!node && (node.tags || []).includes('pending_review')
  }

  /** 审核待确认记忆：approve=采纳转正（清 pending_review 标签）/ reject=丢弃（直接删节点，不留残留） */
  function reviewMemory(id: string, action: 'approve' | 'reject') {
    if (!id) return
    if (action === 'reject') {
      deleteNode(id)
      return
    }
    useChatStore().bridgeRpc('memory.node.update', { id, tags: [] }).then(() => {
      const n = getNode(id)
      if (n) n.tags = []
    }).catch(e => console.error('[MemoryGraph] review approve failed:', e))
  }

  /** 批量审核待确认记忆 */
  function batchReviewMemory(ids: string[], action: 'approve' | 'reject') {
    if (!ids.length) return
    for (const id of ids) reviewMemory(id, action)
  }

  function addEdge(source: string, target: string, relation = 'related') {
    if (!source || !target || source === target) return
    if (edges.value.some(e => (e.source_node === source && e.target_node === target) || (e.source_node === target && e.target_node === source))) return
    useChatStore().bridgeRpc('memory.edge.add', { source_node: source, target_node: target, relation }).catch(e => console.error('[MemoryGraph] addEdge failed:', e))
  }

  function deleteEdge(id: string) {
    edges.value = edges.value.filter(e => e.id !== id)
    useChatStore().bridgeRpc('memory.edge.delete', { id }).catch(e => console.error('[MemoryGraph] deleteEdge failed:', e))
  }

  return { nodes, edges, loaded, refresh, getNode, addNode, updateNode, deleteNode, edgesForNode, isPending, reviewMemory, batchReviewMemory, addEdge, deleteEdge }
})
