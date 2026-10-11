import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { useConversationsStore } from './conversations'
import { localStore } from '@/utils/localStore'

interface MemberSkill {
  /** 技能仓库里的 skill id（stores/skills.ts） */
  skill_id: string
  /** 开关：开=项目派活给该成员时使用；关=不使用 */
  enabled: boolean
}

interface ProjectMember {
  /** 伙伴英文 id（Luna / WebSurfer / Auditor ... 与后端 partner_registry 对齐） */
  partner_id: string
  /** 是否启用：停用的不进入任务流程（NIS 需要时按权限模式询问/自动启用） */
  enabled: boolean
  /** NIS 推荐理由（创建项目时 NIS 推荐的人选带理由） */
  reason?: string
  /** 加入方式：nis=推荐 / user=手动添加 / auto=流程中自动启用 */
  added_by?: 'nis' | 'user' | 'auto'
  /** 该成员配置的技能（项目级：skill_id + 开关） */
  skills?: MemberSkill[]
}

export interface Project {
  id: string
  name: string
  /** 项目根目录位置（用户选的文件夹路径） */
  root_path: string
  /** 用户填写的项目描述（创建项目必填；推荐伙伴与 README 背景的依据） */
  description?: string
  status: 'active' | 'archived'
  created_at: number
  /** 项目成员名单（聊天界面上方成员栏的数据源） */
  members: ProjectMember[]
  /** 置顶：侧栏项目树优先排序 */
  pinned?: boolean
}

/** 滞留处项目：删除后暂存，到期彻底清除 */
interface TrashedProject {
  project: Project
  /** 移入滞留处的时间戳 */
  deleted_at: number
  /** 保留天数（到期自动清除） */
  keep_days: number
}

interface PartnerPick {
  id: string
  reason: string
}



const STORAGE_KEY = 'nis-projects'
const TRASH_KEY = 'nis-trash'
const RETENTION_KEY = 'nis-trash-retention'

let projectSeq = 0
function nextProjectId(): string {
  projectSeq += 1
  return `proj_${Date.now().toString(36)}_${projectSeq}`
}

/**
 * ★ 0921z-2：删除**工作区文件夹**（项目 root_path）—— 前端统一入口。
 *
 * 走**后端 RPC**（`project.deleteFiles`）：后端用 Shell 把目录移入**系统回收站**（可还原），
 * 并做硬护栏（盘符根/系统目录/数据根/存储根/源码根… 一律拒绝）。
 * 为什么不在这里直接删：浏览器给不了文件系统权限；Tauri 侧也不该由 UI 线程跑重活。
 *
 * 注：此前这里挂的是 `setProjectFileDeleter`，但**全项目没有任何地方调用它** ——
 * 等于"删项目时连工作区"这条线是断的（文件夹从来不会被删）。0921z-2 换成真链路。
 */
async function deleteWorkspaceFolder(rootPath: string): Promise<{ ok: boolean; error?: string }> {
  const p = String(rootPath || '').trim()
  if (!p) return { ok: true }
  try {
    // 动态 import（与文件内其他后端调用一致：避免 stores/projects ↔ stores/chat 循环依赖）
    const { useChatStore } = await import('./chat')
    const r: any = await useChatStore().bridgeRpc('project.deleteFiles', { path: p })
    /* ★ 只有后端明确回了 `method:'recycle'` 才算成功。
       ⚠ 别只看 `ok`：后端对**未知方法**会回 `{ok:true,_unhandled:'…'}`（实测），
       若按 ok 判断，旧后端下会谎报"已移入回收站"而文件其实还在。 */
    if (r?.ok === true && r?.method === 'recycle') return { ok: true }
    return { ok: false, error: r?.error || '后端没有响应工作区删除（后端可能是改动前的版本，需重启）' }
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) }
  }
}

/**
 * 分身项目 store —— 与后端 Project 实体对齐（root_path / project_partners）。
 *
 * 后端消息（预留，接线后用）：
 *   Server → Client: PROJECT_LIST { projects[] } / PROJECT_MEMBERS_UPDATE { project_id, members[] }
 *                     PARTNER_RECOMMEND { project_id, partners[{ id, reason }] }
 *                     PARTNER_DYNAMIC_JOIN { window_id, partner_name, reason }
 *   Client → Server: PROJECT_CREATE { name, root_path } / PROJECT_MEMBERS_UPDATE { project_id, members[] }
 *
 * 后端未接时前端本地持久化（localStorage）演示全链路。
 *
 * ── 接线检查单（后端未做，接入后逐条核对）──
 * 1. PROJECT_CREATE：前端发送 { name, root_path, description }，后端接收 description
 *    → create_project(goal=description)（README 背景随之填充）
 * 2. PROJECT_CREATED 回包带 description（前端 syncFromBackend 可存储）
 * 3. 后端创建项目后按描述分析 → 广播 PARTNER_RECOMMEND { project_id, partners[{id, reason}] }
 *    → 前端 applyRecommendation 自动接管（无需再写）；推荐来源从 recommendPartnersMock 切到真实消息
 * 4. _create_plan（nis_brain.py）改为按需求判断是否编码才加 Luna
 *    （当前硬编码 Luna 必选，与前端「非必选」不一致，必须配套改）
 * 5. 前端未命中任何推荐时，后端同样返回空推荐 → 推荐卡显示「暂无匹配，可手动添加」
 */
export const useProjectsStore = defineStore('projects', () => {
  const projects = ref<Project[]>([])
  const activeProjectId = ref<string | null>(null)
  // 被用户「忽略」的推荐（兜底提问时重新拿出来用）
  const pendingRecommendations = ref<Record<string, PartnerPick[]>>({})
  // 该项目是否已展示过推荐卡（防切窗/重挂重复弹出）
  const recommendationShown = ref<Record<string, boolean>>({})
  // 该项目是否已收到后端 PARTNER_RECOMMEND（收到后本地 mock 推荐不再弹）
  const backendRecommendReceived = ref<Record<string, boolean>>({})
  // 滞留处：删除的项目暂存于此，到期彻底清除
  const trashedProjects = ref<TrashedProject[]>([])
  // 滞留处保留天数（7/15/30，localStorage 持久化）
  const trashRetentionDays = ref(7)

  const activeProject = computed(
    () => projects.value.find(p => p.id === activeProjectId.value) || null,
  )

  function load() {
    try {
      const raw = localStore.getItem(STORAGE_KEY)
      if (raw) {
        const parsed = JSON.parse(raw)
        projects.value = parsed.projects || []
        pendingRecommendations.value = parsed.pendingRecommendations || {}
        recommendationShown.value = parsed.recommendationShown || {}
      }
    } catch (e) {
      /* ignore */
    }
    try {
      const trashRaw = localStore.getItem(TRASH_KEY)
      if (trashRaw) {
        const parsed = JSON.parse(trashRaw)
        trashedProjects.value = parsed.trash || []
      }
    } catch (e) {
      /* ignore */
    }
    try {
      const retention = parseInt(localStore.getItem(RETENTION_KEY) || '', 10)
      if ([7, 15, 30].includes(retention)) trashRetentionDays.value = retention
    } catch (e) {
      /* ignore */
    }
    // 载入时清理已到期滞留项目（彻底删除）
    purgeExpired()
  }

  function persist() {
    try {
      localStore.setItem(STORAGE_KEY, JSON.stringify({
        projects: projects.value,
        pendingRecommendations: pendingRecommendations.value,
        recommendationShown: recommendationShown.value,
      }))
      localStore.setItem(TRASH_KEY, JSON.stringify({ trash: trashedProjects.value }))
    } catch (e) {
      /* ignore */
    }
  }

  function persistRetention(days: number) {
    try {
      localStore.setItem(RETENTION_KEY, String(days))
    } catch (e) {
      /* ignore */
    }
  }

  function getProject(id: string): Project | undefined {
    return projects.value.find(p => p.id === id)
  }

  /** #13 按 root_path 找项目（后端确认回包时把前端本地条目重映射为后端条目用） */
  function findByRootPath(rootPath: string): Project | undefined {
    if (!rootPath) return undefined
    return projects.value.find(p => p.root_path && p.root_path.replace(/[\\/]+$/, '') === rootPath.replace(/[\\/]+$/, ''))
  }

  /** #13 用后端条目替换本地同 root_path 条目（本地 id → 后端 id，成员/根路径以后端为准） */
  function replaceWithBackend(localId: string, backend: { id: string; name: string; root_path: string; status: string; description?: string; members?: ProjectMember[] }) {
    const localIdx = projects.value.findIndex(p => p.id === localId)
    if (localIdx === -1) return
    const local = projects.value[localIdx]
    const merged: Project = {
      ...local,
      id: backend.id,
      name: backend.name || local.name,
      root_path: backend.root_path || local.root_path,
      description: backend.description ?? local.description,
      status: backend.status || local.status,
      members: backend.members || local.members || [],
    }
    projects.value.splice(localIdx, 1, merged)
    // 推荐状态键随 id 迁移
    if (pendingRecommendations.value[localId] != null) {
      pendingRecommendations.value[backend.id] = pendingRecommendations.value[localId]
      delete pendingRecommendations.value[localId]
    }
    if (recommendationShown.value[localId] != null) {
      recommendationShown.value[backend.id] = recommendationShown.value[localId]
      delete recommendationShown.value[localId]
    }
    if (backendRecommendReceived.value[localId] != null) {
      backendRecommendReceived.value[backend.id] = backendRecommendReceived.value[localId]
      delete backendRecommendReceived.value[localId]
    }
    if (activeProjectId.value === localId) activeProjectId.value = backend.id
    persist()
  }

  /** 新建项目：选定的文件夹就是项目根 root_path；带初始成员名单 */
  function createProject(opts: { name: string; root_path: string; description?: string; members?: ProjectMember[] }): Project {
    const project: Project = {
      id: nextProjectId(),
      name: opts.name.trim() || '未命名项目',
      root_path: opts.root_path,
      description: opts.description?.trim(),
      status: 'active',
      created_at: Date.now(),
      members: opts.members || [],
      pinned: false,
    }
    projects.value.push(project)
    persist()
    // 0911 反馈：PROJECT_CREATE 后端落地——本地乐观创建后异步推后端（携带本地 id，保证 id 一致，
    // 后端同 root_path 去重不会产生双份）。失败静默（本地副本仍在，下次启动 project.list 会再合并）。
    void pushProjectToBackend(project)
    return project
  }

  /** 异步推后端（bridgeRpc 懒加载，避免 store 初始化循环依赖；失败只 console.warn 不打断 UI） */
  async function pushProjectToBackend(project: Project) {
    try {
      const { useChatStore } = await import('./chat')
      const chatStore = useChatStore()
      await chatStore.bridgeRpc('project.create', {
        id: project.id,
        name: project.name,
        root_path: project.root_path,
        description: project.description,
        members: project.members,
      })
    } catch (e) {
      console.warn('[projects] 后端同步失败（本地副本仍有效）:', e)
    }
  }
  /** patch 类同步（改名/置顶/归档/成员变更） */
  async function pushProjectPatchToBackend(id: string, patch: Record<string, any>) {
    try {
      const { useChatStore } = await import('./chat')
      const chatStore = useChatStore()
      await chatStore.bridgeRpc('project.update', { id, patch })
    } catch (e) {
      console.warn('[projects] 后端同步失败（本地副本仍有效）:', e)
    }
  }
  async function deleteProjectOnBackend(id: string) {
    try {
      const { useChatStore } = await import('./chat')
      const chatStore = useChatStore()
      await chatStore.bridgeRpc('project.delete', { id })
    } catch (e) {
      console.warn('[projects] 后端删除同步失败（本地已删）:', e)
    }
  }

  /** 启动/重连时从后端拉全量项目列表合并（后端为主：同 id 覆盖；本地独有保留并推后端）
   *  返回是否发生了变化（供调用方决定是否重渲染）。
   *  注：bridgeRpc 是纯 HTTP，不依赖 SSE 连接状态——启动早期直接调即可（失败静默走 catch）。 */
  async function pullProjectsFromBackend(): Promise<boolean> {
    try {
      const { useChatStore } = await import('./chat')
      const chatStore = useChatStore()
      const r = await chatStore.bridgeRpc('project.list', {})
      const remote = Array.isArray(r?.projects) ? r.projects : []
      let changed = false
      for (const rp of remote) {
        /* ★ 0923 修（实测：删掉的项目，重启后端+刷新前端后又出现）——
           根因：`moveProjectToTrash`（删除项目真正走的路径）对后端只做**软删除**
           （`pushProjectPatchToBackend(id, { status: 'archived' })`，记录永久保留、滞留期内可恢复），
           而这里原先**无条件**把后端项目 push 回列表 → 已"删除"的项目被重新捞回来。
           修复：① 本地滞留处里的（用户已删，等恢复或到期）不拉回；② 后端标记 archived 的不拉回。
           恢复路径不受影响：`restoreProject` 会把后端改回 `active`，那时自然能被拉回来。 */
        if (rp.status === 'archived') continue
        if (trashedProjects.value.some(t => t.project.id === rp.id)) continue
        const local = projects.value.find(p => p.id === rp.id)
        if (local) {
          // 后端为准（字段覆盖；本地独有的展示态如 pinned 保留本地）
          local.name = rp.name || local.name
          local.root_path = rp.root_path || local.root_path
          local.description = rp.description ?? local.description
          local.status = rp.status || local.status
          local.members = Array.isArray(rp.members) ? rp.members : local.members
          changed = true
        } else {
          projects.value.push({
            id: rp.id,
            name: rp.name || '未命名项目',
            root_path: rp.root_path || '',
            description: rp.description,
            status: rp.status === 'archived' ? 'archived' : 'active',
            created_at: rp.created_at || Date.now(),
            members: Array.isArray(rp.members) ? rp.members : [],
            pinned: !!rp.pinned,
          })
          changed = true
        }
      }
      /* ★ 0923：本地列表里若残留"后端已软删（archived）"或"已在本地滞留处"的项目 → 一并剔除。
         为什么需要：旧版本会把这些项目拉回并 persist 进 localStorage，脏数据不会自己消失 ——
         而拉取本身只做"增/改"、不回删，所以这里补一次对账清理（治已脏的本机状态）。 */
      {
        const archivedIds = new Set(remote.filter((rp: any) => rp.status === 'archived').map((rp: any) => rp.id))
        const trashIds = new Set(trashedProjects.value.map(t => t.project.id))
        const before = projects.value.length
        projects.value = projects.value.filter(p => !archivedIds.has(p.id) && !trashIds.has(p.id))
        if (projects.value.length !== before) changed = true
      }
      // 本地有、后端无（旧数据首迁移）：逐条补推后端
      for (const lp of projects.value) {
        if (!remote.some((rp: any) => rp.id === lp.id)) void pushProjectToBackend(lp)
      }
      if (changed) persist()
      return changed
    } catch (e) {
      console.warn('[projects] 拉取后端列表失败（沿用本地）:', e)
      return false
    }
  }

  // ── 推荐状态（演示：创建项目后 NIS 分析描述 → 推荐卡；被忽略则留存待兜底）──
  function setRecommendationShown(projectId: string) {
    recommendationShown.value[projectId] = true
    persist()
  }

  function isRecommendationShown(projectId: string): boolean {
    return !!recommendationShown.value[projectId]
  }

  function setPendingRecommendation(projectId: string, partners: PartnerPick[]) {
    pendingRecommendations.value[projectId] = partners
    persist()
  }

  function getPendingRecommendation(projectId: string): PartnerPick[] | undefined {
    return pendingRecommendations.value[projectId]
  }

  function clearPendingRecommendation(projectId: string) {
    delete pendingRecommendations.value[projectId]
    persist()
  }

  // ── 后端 PARTNER_RECOMMEND 到达标记（会话级，不持久化）──
  function markBackendRecommendReceived(projectId: string) {
    backendRecommendReceived.value[projectId] = true
  }

  function isBackendRecommendReceived(projectId: string): boolean {
    return !!backendRecommendReceived.value[projectId]
  }

  /** 删除项目（同时移除其下所有聊天窗口）。0911：同步删后端记录（只删记录，不动用户文件夹） */
  function deleteProject(id: string) {
    const conversationsStore = useConversationsStore()
    conversationsStore.deleteConversationsByProject(id)
    projects.value = projects.value.filter(p => p.id !== id)
    if (activeProjectId.value === id) activeProjectId.value = null
    delete pendingRecommendations.value[id]
    delete recommendationShown.value[id]
    delete backendRecommendReceived.value[id]
    persist()
    void deleteProjectOnBackend(id)
  }

  // ── 滞留处：删除进滞留处 → 到期彻底清除 / 手动恢复或彻底删除 ──
  function setRetentionDays(days: number) {
    if (![7, 15, 30].includes(days)) return
    trashRetentionDays.value = days
    persistRetention(days)
  }

  /** 项目移入滞留处（二级确认后调用）：从项目列表移除，暂存于滞留处，到期清除。
   *  ★ 0921z-2（需求）：`opts.deleteFiles` = 是否**连工作区文件夹一起删**（删除框里的复选框，默认勾选）。
   *    · true → 把 root_path 移入**系统回收站**（可还原）；失败则返回 error，由 UI 提示，不静默
   *    · 不传/false → 只删记录，文件夹**原地保留**（连到期彻底清除也不会动它） */
  async function moveProjectToTrash(id: string, opts?: { deleteFiles?: boolean }): Promise<{ recordTrashed: boolean; filesDeleted: boolean; error?: string }> {
    const project = getProject(id)
    if (!project) return { recordTrashed: false, filesDeleted: false, error: '项目不存在' }
    /* ★1003 批次4 4.53：**文件删除先走、结果分字段回传** —— 原来先把记录/对话全移进滞留处、
     * 后端归档，最后才删工作区：删除失败时项目早已被处理完，且 `{filesDeleted:false,error}`
     * 把"记录移入成功"与"文件删除失败"混为一谈（用户以为走了"只删记录"路径）。
     * 现在 UI 可据 recordTrashed/filesDeleted 明确提示："记录已移入滞留处，但工作区删除失败，
     * 可稍后重试"。记录照常入滞留处（可恢复是设计语义），只是不再冒充文件也删好了。 */
    let filesDeleted = true
    let fileErr: string | undefined
    if (opts?.deleteFiles) {
      const r = await deleteWorkspaceFolder(project.root_path)
      filesDeleted = r.ok
      fileErr = r.error
    }
    const conversationsStore = useConversationsStore()
    // 项目下全部对话一并移入滞留处（可随项目恢复）
    conversationsStore.moveConversationsByProjectToTrash(id)
    projects.value = projects.value.filter(p => p.id !== id)
    if (activeProjectId.value === id) activeProjectId.value = null
    delete pendingRecommendations.value[id]
    delete recommendationShown.value[id]
    delete backendRecommendReceived.value[id]
    // 从滞留处去重后加入
    trashedProjects.value = trashedProjects.value.filter(t => t.project.id !== id)
    trashedProjects.value.push({
      project: { ...project, status: 'archived' },
      deleted_at: Date.now(),
      keep_days: trashRetentionDays.value,
    })
    persist()
    void pushProjectPatchToBackend(id, { status: 'archived' }) // 0911：后端标归档（记录仍在，恢复可用）
    return { recordTrashed: true, filesDeleted, error: fileErr }
  }

  /** 从滞留处恢复项目 */
  function restoreProject(id: string) {
    const idx = trashedProjects.value.findIndex(t => t.project.id === id)
    if (idx === -1) return
    const trashed = trashedProjects.value[idx]
    trashedProjects.value.splice(idx, 1)
    const restored: Project = { ...trashed.project, status: 'active' }
    projects.value.push(restored)
    persist()
    void pushProjectPatchToBackend(id, { status: 'active' }) // 0911：后端恢复
    return restored
  }

  /** 彻底删除滞留项目（**只清记录/对话** —— 工作区文件夹在"删除项目"那一步就按复选框处理过了，
   *  ★ 0921z-2：这里不再碰文件夹，否则"取消勾选保留工作区"的承诺会被到期/彻底删除反悔掉） */
  function purgeProject(id: string) {
    const idx = trashedProjects.value.findIndex(t => t.project.id === id)
    if (idx === -1) return
    trashedProjects.value.splice(idx, 1)
    // 一并彻底清除该项目下的滞留对话（含桥接会话）
    const conversationsStore = useConversationsStore()
    conversationsStore.purgeConversationsByProject(id)
    persist()
    void deleteProjectOnBackend(id) // 0911：后端记录一并删除（只删记录，绝不动用户文件夹）
  }

  /** 清理已到期滞留项目（同样：只清记录，不碰工作区文件夹 —— 见 purgeProject 注释） */
  function purgeExpired() {
    const DAY_MS = 86_400_000
    const now = Date.now()
    const before = trashedProjects.value.length
    trashedProjects.value = trashedProjects.value.filter(t => {
      /* ★1003 批次4 4.54：坏数据防**秒清** —— keep_days/deleted_at 缺失或非法（旧数据升级/损坏）
       * 时 expiredAt=NaN，`now < NaN` 恒 false ⇒ 一进 purge 就立即清空回收站（滞留/恢复保证
       * 作废 = 静默丢数据）。非法 keep_days 用当前保留期；非法 deleted_at 用"现在"当起点（给满期）。 */
      const keepDays = Number.isFinite(t.keep_days) && Number(t.keep_days) > 0
        ? Number(t.keep_days)
        : (Number(trashRetentionDays.value) || 30)
      const deletedAt = Number.isFinite(t.deleted_at) && Number(t.deleted_at) > 0 ? Number(t.deleted_at) : now
      return now < deletedAt + keepDays * DAY_MS
    })
    if (trashedProjects.value.length !== before) persist()
  }

  /** 重命名项目 */
  function renameProject(id: string, name: string) {
    const p = getProject(id)
    if (p) {
      p.name = name.trim() || p.name
      persist()
      void pushProjectPatchToBackend(id, { name: p.name }) // 0911：同步后端
    }
  }

  /** 置顶 / 取消置顶 */
  function togglePinProject(id: string) {
    const p = getProject(id)
    if (p) {
      p.pinned = !p.pinned
      persist()
      void pushProjectPatchToBackend(id, { pinned: !!p.pinned }) // 0911：同步后端
    }
  }

  function setActiveProject(id: string | null) {
    activeProjectId.value = id
  }

  // ── 成员名单操作 ──
  function memberEnabled(projectId: string, partnerId: string): boolean {
    return getProject(projectId)?.members.find(m => m.partner_id === partnerId)?.enabled ?? false
  }

  function setMemberEnabled(projectId: string, partnerId: string, enabled: boolean) {
    const p = getProject(projectId)
    const m = p?.members.find(x => x.partner_id === partnerId)
    if (m) {
      m.enabled = enabled
      persist()
      void pushProjectPatchToBackend(projectId, { members: p!.members }) // 0911：同步后端
    }
  }

  function addMember(projectId: string, partnerId: string, opts: { reason?: string; added_by?: ProjectMember['added_by']; enabled?: boolean } = {}) {
    const p = getProject(projectId)
    if (!p) return
    if (p.members.some(x => x.partner_id === partnerId)) return
    p.members.push({
      partner_id: partnerId,
      enabled: opts.enabled ?? true,
      reason: opts.reason,
      added_by: opts.added_by || 'user',
    })
    persist()
    void pushProjectPatchToBackend(projectId, { members: p.members }) // 0911：同步后端
  }

  function removeMember(projectId: string, partnerId: string) {
    const p = getProject(projectId)
    if (p) {
      p.members = p.members.filter(x => x.partner_id !== partnerId)
      persist()
      void pushProjectPatchToBackend(projectId, { members: p.members }) // 0911：同步后端
    }
  }

  // ── 成员技能配置（项目级）──
  /** 给某成员配置一个技能：enabled=true 添加/启用，false 移除 */
  function setMemberSkill(projectId: string, partnerId: string, skillId: string, enabled: boolean) {
    const p = getProject(projectId)
    const m = p?.members.find(x => x.partner_id === partnerId)
    if (!m) return
    if (!m.skills) m.skills = []
    const existing = m.skills.find(s => s.skill_id === skillId)
    if (enabled) {
      if (existing) existing.enabled = true
      else m.skills.push({ skill_id: skillId, enabled: true })
    } else {
      if (existing) existing.enabled = false
      else m.skills.push({ skill_id: skillId, enabled: false })
    }
    persist()
    void pushProjectPatchToBackend(projectId, { members: p!.members }) // 0911：同步后端
  }

  /** 开关切换：true=使用该技能，false=不使用 */
  function toggleMemberSkill(projectId: string, partnerId: string, skillId: string, enabled: boolean) {
    setMemberSkill(projectId, partnerId, skillId, enabled)
  }

  /** 该成员启用的技能 id 列表 */
  function memberEnabledSkills(projectId: string, partnerId: string): string[] {
    const m = getProject(projectId)?.members.find(x => x.partner_id === partnerId)
    return (m?.skills || []).filter(s => s.enabled).map(s => s.skill_id)
  }

  /** NIS 推荐一批伙伴进成员名单（后端 PARTNER_RECOMMEND 消息的落地口） */
  function applyRecommendation(projectId: string, partners: Array<{ id: string; reason?: string }>) {
    for (const r of partners) {
      addMember(projectId, r.id, { reason: r.reason, added_by: 'nis' })
    }
  }

  /** 后端 PROJECT_CREATED 回包 → 落地项目（后端 id 优先，本地不重复建） */
  function syncFromBackend(p: { id: string; name: string; root_path: string; status: string; description?: string; members: ProjectMember[] }) {
    if (getProject(p.id)) return
    const project: Project = {
      id: p.id,
      name: p.name || '未命名项目',
      root_path: p.root_path || '',
      description: p.description,
      status: p.status === 'archived' ? 'archived' : 'active',
      created_at: Date.now(),
      members: Array.isArray(p.members) ? p.members : [],
    }
    projects.value.push(project)
    persist()
  }

  /** 后端 PROJECT_MEMBERS_SYNCED 回包 → 覆盖本地成员名单 */
  function syncMembers(projectId: string, members: ProjectMember[]) {
    const p = getProject(projectId)
    if (!p) return
    p.members = Array.isArray(members)
      ? members.map(m => ({ ...m, enabled: !!m.enabled }))
      : []
    persist()
  }

  /** 窗口 id → 所属项目（PARTNER_DYNAMIC_JOIN 里 window_id 反查项目） */
  function projectIdForWindow(windowId: string): string | null {
    // 前端 window = conversation，window_id 可能是 conversation.id 数字字符串
    const conversationsStore = useConversationsStore()
    const conv = conversationsStore.conversations.find(c => String(c.id) === String(windowId))
    return conv?.project_id || null
  }

  load()

  return {
    projects,
    activeProjectId,
    activeProject,
    getProject,
    findByRootPath,
    replaceWithBackend,
    createProject,
    deleteProject,
    renameProject,
    togglePinProject,
    setActiveProject,
    memberEnabled,
    setMemberEnabled,
    addMember,
    removeMember,
    setMemberSkill,
    toggleMemberSkill,
    memberEnabledSkills,
    applyRecommendation,
    setRecommendationShown,
    isRecommendationShown,
    setPendingRecommendation,
    getPendingRecommendation,
    clearPendingRecommendation,
    markBackendRecommendReceived,
    isBackendRecommendReceived,
    syncFromBackend,
    syncMembers,
    pullProjectsFromBackend,
    projectIdForWindow,
    trashedProjects,
    trashRetentionDays,
    setRetentionDays,
    moveProjectToTrash,
    restoreProject,
    purgeProject,
    purgeExpired,
  }
})
