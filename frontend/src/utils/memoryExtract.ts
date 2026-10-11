import { useChatStore } from '@/stores/chat'
import { useProvidersStore } from '@/stores/providers'
import { t } from '@/utils/i18n'

/**
 * 记忆提炼客户端 —— 后端 memory.extract / memory.extractCommit / memory.conflictResolve。
 * 把一段对话提炼成分类记忆（preference/decision/pitfall/pattern/progress），
 * 后端负责查重判定（created / already_exists / conflict）与落盘（记忆网图节点），前端只发内容 + 展示结果。
 *
 * 0911 接通：原走 WS MEMORY_EXTRACT / MEMORY_EXTRACT_RESULT 等死通道（转 15s/60s 后失败），
 * 现改为 bridgeRpc 实链路。提炼模型取「设置 → 人格 → 全局模型」（优先级：手选的提炼模型 > 当前全局模型；
 * 两者都没有时**直接报错**并引导去选择，不再静默兜底 —— 2026-09-12 用户拍板）。
 * 后端未连接时返回 null。
 */

export type MemoryOutcome = 'created' | 'already_exists' | 'merged' | 'conflict'

export interface MemoryExtractItem {
  node_type: string
  title: string
  content: string
  outcome?: MemoryOutcome
  hit_id?: string
  old_content?: string
  reason?: string
}

interface MemoryExtractResult {
  ok: boolean
  saved: number
  items: MemoryExtractItem[]
  counts?: { created?: number; merged?: number; already_exists?: number; conflict?: number }
  llm_used?: boolean
  msg?: string
  /** 没有可用的全局模型（未选/不可用）→ UI 应引导去「设置 → 人格 → 全局模型」选择 */
  needModel?: boolean
}

function normalizeResult(r: any): MemoryExtractResult {
  return {
    ok: !!r?.ok,
    saved: Number(r?.saved || 0),
    items: Array.isArray(r?.items) ? r.items : [],
    counts: r?.counts || {},
    llm_used: !!r?.llm_used,
    msg: r?.msg,
  }
}

/**
 * 提炼对话 → 分类记忆（dryRun 时仅预览 + 查重判定；否则后端直接落盘）。
 * @returns MemoryExtractResult；后端未连接返回 null
 */
export async function memoryExtract(
  content: string,
  projectRoot?: string,
  opts?: { dryRun?: boolean; auto?: boolean },
): Promise<MemoryExtractResult | null> {
  const chatStore = useChatStore()
  if (!chatStore.wsConnected) return null
  const model = useProvidersStore().extractModel()
  /** 2026-09-12 用户拍板：全局模型未选/不可用时**不再静默兜底**——直接报错，UI 引导去「设置 → 人格」选择。 */
  if (!model) return { ok: false, saved: 0, items: [], needModel: true, msg: t('extract.noGlobalModel') }

  try {
    const r = await chatStore.bridgeRpc('memory.extract', {
      content,
      projectRoot: projectRoot || '',
      dryRun: !!opts?.dryRun,
      auto: !!opts?.auto,
      model,
    })
    return normalizeResult(r)
  } catch (e: any) {
    return { ok: false, saved: 0, items: [], msg: String(e?.message || e).slice(0, 200) }
  }
}

/**
 * 提交用户勾选的记忆条目落盘。
 * @returns 每条最终 outcome + counts；后端未连接返回 null
 */
export async function memoryExtractCommit(
  items: MemoryExtractItem[],
  projectRoot?: string,
): Promise<MemoryExtractResult | null> {
  const chatStore = useChatStore()
  if (!chatStore.wsConnected) return null

  try {
    const r = await chatStore.bridgeRpc('memory.extractCommit', { items, projectRoot: projectRoot || '' })
    return normalizeResult(r)
  } catch (e: any) {
    return { ok: false, saved: 0, items: [], msg: String(e?.message || e).slice(0, 200) }
  }
}

/**
 * 冲突顶替：用户确认后用新内容强制覆盖旧记忆。
 * @returns 结果（outcome = merged 表示顶替成功）；后端未连接返回 null
 */
export async function resolveMemoryConflict(
  payload: {
    memory_id?: string
    title: string
    content: string
    node_type: string
    scope: string
    project_id?: string
  },
): Promise<{ outcome: string; reason?: string; memory_id?: string } | null> {
  const chatStore = useChatStore()
  if (!chatStore.wsConnected) return Promise.resolve(null)

  try {
    const r = await chatStore.bridgeRpc('memory.conflictResolve', { ...payload })
    return {
      outcome: String(r?.outcome || 'merged'),
      reason: r?.reason,
      memory_id: r?.memory_id,
    }
  } catch (e: any) {
    return { outcome: 'already_exists', reason: String(e?.message || e).slice(0, 120) }
  }
}
