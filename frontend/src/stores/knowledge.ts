import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { useChatStore } from './chat'
import { localStore } from '@/utils/localStore'

/**
 * 知识库条目 —— 与后端 core/knowledge/models.py 的 KnowledgeEntry 对齐。
 * 已接通后端（knowledge.db 真实知识库）：
 *   Server → Client: KNOWLEDGE_LIST { entries[] } / KNOWLEDGE_SYNCED { entry, deleted }
 *   Client → Server: KNOWLEDGE_LIST / KNOWLEDGE_ADD / KNOWLEDGE_UPDATE / KNOWLEDGE_DELETE
 * 不再使用 localStorage 演示数据；打开面板时 refresh() 拉取后端真实条目。
 *
 * 树结构：分类节点用 entry_type='folder'（无内容），条目通过 parent_id 挂到分类下；
 * parent_id='' 表示根级（未分类）。
 *
 * summary / source_label 已持久化到后端（knowledge.db）；后端旧数据缺省时从 content 截取摘要。
 */
export interface KnowledgeAttachment {
  id: string
  /** image / video / doc / link */
  type: string
  name: string
  /** dataURL（image）或 http 链接（video/doc/link） */
  url: string
}

export interface KnowledgeEntry {
  id: string
  title: string
  /** 摘要：一句话概括（星系详情/检索用） */
  summary: string
  content: string
  /** doc / manual / note / reference / folder（分类节点） */
  entry_type: string
  tags: string[]
  project_id: string
  source_url: string
  /** 来源出处（可读名，如「某博主」「某网站」） */
  source_label: string
  /** 父分类 id（'' = 根级未分类）；entry_type='folder' 时表示父分类 */
  parent_id: string
  /** 附件：图片/视频/文档/链接 */
  attachments: KnowledgeAttachment[]
  version: number
  created_at: number
  updated_at: number
}

/** 后端时间戳是秒级 float，统一转成前端毫秒 */
function toMs(v: number | undefined): number {
  if (v == null) return Date.now()
  return v < 1e12 ? Math.round(v * 1000) : Math.round(v)
}

/** 后端条目 dict → 前端 entry（补 summary/source_label 缺省，时间秒→毫秒） */
function fromBackend(raw: any): KnowledgeEntry {
  const content = String(raw.content || '')
  return {
    id: String(raw.id || ''),
    title: String(raw.title || ''),
    summary: String(raw.summary || '').trim() || content.slice(0, 60),
    content,
    entry_type: String(raw.entry_type || 'doc'),
    tags: Array.isArray(raw.tags) ? raw.tags : [],
    project_id: String(raw.project_id || ''),
    source_url: String(raw.source_url || ''),
    source_label: String(raw.source_label || ''),
    parent_id: String(raw.parent_id || ''),
    attachments: Array.isArray(raw.attachments) ? raw.attachments : [],
    version: Number(raw.version || 1),
    created_at: toMs(raw.created_at),
    updated_at: toMs(raw.updated_at),
  }
}

/* ── ★0930 知识库项目绑定（客服铺垫）──────────────────────────────
 * 语义：选中的「组（分类）/条目」打上 project_id=该项目 ⇒ 该项目的会话（查询/召回/新写）
 * 只见/只落这个范围；范围外=不存在。内核 knowledge_query 已有 project_id 过滤，零新过滤代码。
 * 天花板（ponytail）：归属是**单归属**——一条知识同一时间只属于一个项目；要多项目共享同组
 * 时升级为 scope 关系表。 */
export type KnowledgeScopeSel = { cats: string[]; entryIds: string[] }

/** 生成归属变更清单（纯函数，可测）：组勾选=分类文件夹与其全部子孙同进同出；条目勾选=单条 */
function scopeUpdates(
  entries: Array<{ id: string; parent_id: string; entry_type: string; project_id: string }>,
  projectId: string,
  sel: KnowledgeScopeSel,
): Array<{ id: string; project_id: string }> {
  const byId = new Map(entries.map(e => [e.id, e]))
  const ancestorSelected = (e: { id: string; parent_id: string }): boolean => {
    let cur: { id: string; parent_id: string } | undefined = e
    while (cur && cur.parent_id) {
      if (sel.cats.includes(cur.parent_id)) return true
      cur = byId.get(cur.parent_id)
    }
    return false
  }
  const out: Array<{ id: string; project_id: string }> = []
  for (const e of entries) {
    const inSel = sel.entryIds.includes(e.id)
      || (e.entry_type === 'folder' && sel.cats.includes(e.id))
      || ancestorSelected(e)
    // 不选中时只清「本来就是本项目的」——别的项目的归属是别人的选择器的事，不动（单归属抢占仅发生在勾选时）
    const curOwner = e.project_id || ''
    const want = inSel ? projectId : (curOwner === projectId ? '' : curOwner)
    if ((e.project_id || '') !== want) out.push({ id: e.id, project_id: want })
  }
  return out
}

/** 落地归属变更（逐条 knowledge.update；量级小（≤500）不需要批量接口） */
export async function bindKnowledgeScope(projectId: string, sel: KnowledgeScopeSel): Promise<number> {
  const st = useKnowledgeStore()
  if (!st.loaded) await st.refresh()
  const ups = scopeUpdates(st.entries as any[], projectId, sel)
  const { useChatStore } = await import('./chat')
  const chat = useChatStore()
  for (const u of ups) {
    try { await chat.bridgeRpc('knowledge.update', { id: u.id, project_id: u.project_id }) } catch { /* 单条失败不阻塞 */ }
  }
  await st.refresh()
  return ups.length
}

let kbSeq = 0
function nextId(): string {
  kbSeq += 1
  return `kb_${Date.now().toString(36)}_${kbSeq}`
}

export const useKnowledgeStore = defineStore('knowledge', () => {
  const entries = ref<KnowledgeEntry[]>([])
  /** 条目之间的关联（0919）：后端写入时自动判定（字面/标签 + 装模型后算语义），
   *  星系里的星桥直接用它画 —— 以前前端是"同 tag 就连线"的演示逻辑，AI 写入的条目
   *  都带同两个系统 tag ⇒ 全连成一张网。 */
  const relations = ref<Array<{ source_id: string; target_id: string; relation: string; score: number; origin?: string }>>([])
  const loaded = ref(false)

  function getEntry(id: string): KnowledgeEntry | undefined {
    return entries.value.find(e => e.id === id)
  }

  /** 拉取后端真实知识库条目 */
  async function refresh(projectId = '') {
    try {
      const chatStore = useChatStore()
      const result = await chatStore.bridgeRpc('knowledge.list', { project_id: projectId })
      applySnapshot({ entries: result.entries, relations: result.relations })
    } catch (e) {
      console.error('[Knowledge] refresh failed:', e)
    }
  }

  /** 应用后端全量快照 */
  function applySnapshot(payload: { entries?: KnowledgeEntry[]; relations?: any[] }) {
    entries.value = (payload.entries || []).map(fromBackend)
    relations.value = Array.isArray(payload.relations)
      ? payload.relations.map((r: any) => ({
          source_id: String(r?.source_id || ''),
          target_id: String(r?.target_id || ''),
          relation: String(r?.relation || 'related'),
          score: Number(r?.score || 0),
          origin: String(r?.origin || 'auto'),
        })).filter(r => r.source_id && r.target_id)
      : []
    loaded.value = true
  }

  // 清理旧 localStorage 演示数据（一次性）；改用 bridge RPC（connect 后调用 refresh 拉真实数据）
  try {
    localStore.removeItem('nis-knowledge')
  } catch { /* ignore */ }

  // ── 树结构 ──
  /** 分类节点（entry_type === 'folder'） */
  const folders = computed(() => entries.value.filter(e => e.entry_type === 'folder'))
  /** 根分类（parent_id === ''） */
  const rootFolders = computed(() => folders.value.filter(f => !f.parent_id))
  /** 直接子节点 */
  function childrenOf(id: string): KnowledgeEntry[] {
    return entries.value.filter(e => e.parent_id === id)
  }
  /** 某节点下所有条目 id（含递归子分类下的条目，不含 folder 自身） */
  function entryIdsUnder(id: string | null): Set<string> {
    const out = new Set<string>()
    const walk = (pid: string | null) => {
      for (const e of entries.value) {
        if (e.parent_id === pid) {
          if (e.entry_type === 'folder') walk(e.id)
          else out.add(e.id)
        }
      }
    }
    walk(id)
    return out
  }
  /** 该节点下直接子分类 */
  function subFolders(id: string): KnowledgeEntry[] {
    return folders.value.filter(f => f.parent_id === id)
  }
  /** 可选的父分类（folder 集合，排除自身） */
  function folderOptions(excludeId?: string): KnowledgeEntry[] {
    return folders.value.filter(f => f.id !== excludeId)
  }

  /** 前端 entry → 后端可见字段（summary/source_label 现已持久化到后端） */
  function toPayload(e: KnowledgeEntry): Record<string, any> {
    return {
      id: e.id,
      title: e.title,
      content: e.content,
      summary: e.summary,
      entry_type: e.entry_type,
      tags: e.tags,
      project_id: e.project_id,
      source_url: e.source_url,
      source_label: e.source_label,
      parent_id: e.parent_id,
      attachments: e.attachments,
    }
  }

  /** 新增知识条目：乐观插入 + RPC 创建 */
  async function addEntry(data: Partial<KnowledgeEntry>): Promise<KnowledgeEntry | undefined> {
    const now = Date.now()
    const entry: KnowledgeEntry = {
      id: nextId(),
      title: (data.title || '').trim() || '未命名条目',
      summary: data.summary || '',
      content: data.content || '',
      entry_type: data.entry_type || 'doc',
      tags: Array.isArray(data.tags) ? data.tags : [],
      project_id: data.project_id || '',
      source_url: data.source_url || '',
      source_label: data.source_label || '',
      parent_id: data.parent_id || '',
      attachments: Array.isArray(data.attachments) ? data.attachments : [],
      version: 1,
      created_at: data.created_at || now,
      updated_at: now,
    }
    entries.value.unshift(entry)
    try {
      const chatStore = useChatStore()
      const result = await chatStore.bridgeRpc('knowledge.add', toPayload(entry))
      if (result?.entry) {
        const saved = result.entry
        entry.id = saved.id
        entry.version = saved.version || 1
      }
    } catch (e) {
      console.error('[Knowledge] addEntry failed:', e)
    }
    return entry
  }

  /** 新增分类节点（folder） */
  function addFolder(title: string, parentId = ''): KnowledgeEntry {
    return addEntry({ title, entry_type: 'folder', parent_id: parentId })
  }

  async function updateEntry(id: string, changes: Partial<KnowledgeEntry>) {
    const e = getEntry(id)
    if (!e) return
    if (changes.title !== undefined) e.title = (changes.title || '').trim() || e.title
    if (changes.summary !== undefined) e.summary = changes.summary
    if (changes.content !== undefined) e.content = changes.content
    if (changes.entry_type !== undefined) e.entry_type = changes.entry_type
    if (changes.tags !== undefined) e.tags = Array.isArray(changes.tags) ? changes.tags : []
    if (changes.project_id !== undefined) e.project_id = changes.project_id
    if (changes.source_url !== undefined) e.source_url = changes.source_url
    if (changes.source_label !== undefined) e.source_label = changes.source_label
    if (changes.parent_id !== undefined) e.parent_id = changes.parent_id
    if (changes.attachments !== undefined) e.attachments = Array.isArray(changes.attachments) ? changes.attachments : []
    if (changes.created_at !== undefined) e.created_at = changes.created_at
    e.version += 1
    e.updated_at = Date.now()

    const payload: Record<string, any> = { id }
    for (const k of ['title', 'content', 'summary', 'entry_type', 'tags', 'project_id', 'source_url', 'source_label', 'parent_id', 'attachments'] as const) {
      if (changes[k] !== undefined) payload[k] = changes[k]
    }
    try {
      const chatStore = useChatStore()
      await chatStore.bridgeRpc('knowledge.update', payload)
    } catch (err) {
      console.error('[Knowledge] updateEntry failed:', err)
    }
  }

  /** 删除节点；若是分类则连同其下所有子孙条目一起删（后端也会级联） */
  async function deleteEntry(id: string) {
    const target = getEntry(id)
    if (!target) return
    const removeIds = new Set<string>([id])
    if (target.entry_type === 'folder') {
      for (const eid of entryIdsUnder(id)) removeIds.add(eid)
    }
    entries.value = entries.value.filter(e => !removeIds.has(e.id))
    try {
      const chatStore = useChatStore()
      await chatStore.bridgeRpc('knowledge.delete', { id })
    } catch (e) {
      console.error('[Knowledge] deleteEntry failed:', e)
    }
  }

  return { entries, relations, loaded, folders, rootFolders, childrenOf, entryIdsUnder, subFolders, folderOptions, getEntry, addEntry, addFolder, updateEntry, deleteEntry, refresh }
})
