import { useChatStore } from '@/stores/chat'
import { useProvidersStore } from '@/stores/providers'
import { t } from '@/utils/i18n'

/**
 * 知识提炼客户端（0913）—— 后端 knowledge.extract / knowledge.extractCommit。
 * 把一段对话提炼成知识库条目（doc/manual/note/reference），后端负责查重判定（created / already_exists）
 * 与写入（knowledge.db，经 memoryBridge）。与 memoryExtract 同构：先生成候选（dryRun），用户勾选后提交。
 * 提炼模型取「设置 → 人格 → 全局模型」（手选的提炼模型 > 聊天全局；都没有时直接报错并引导去选择）。
 * 后端未连接时返回 null。
 */

export type KnowledgeOutcome = 'created' | 'already_exists'

export interface KnowledgeExtractItem {
  entry_type: string
  title: string
  content: string
  tags?: string[]
  outcome?: KnowledgeOutcome
  hit_id?: string
  reason?: string
}

interface KnowledgeExtractResult {
  ok: boolean
  saved: number
  items: KnowledgeExtractItem[]
  counts?: { created?: number; already_exists?: number }
  llm_used?: boolean
  msg?: string
  /** 没有可用的全局模型（未选/不可用）→ UI 应引导去「设置 → 人格 → 全局模型」选择 */
  needModel?: boolean
}

function normalizeResult(r: any): KnowledgeExtractResult {
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
 * 提炼对话 → 候选知识条目（dryRun 时仅预览 + 查重判定；否则后端直接写入知识库）。
 * @returns KnowledgeExtractResult；后端未连接返回 null
 */
export async function knowledgeExtract(
  content: string,
  projectRoot?: string,
  opts?: { dryRun?: boolean },
): Promise<KnowledgeExtractResult | null> {
  const chatStore = useChatStore()
  if (!chatStore.wsConnected) return null
  const model = useProvidersStore().extractModel()
  /** 与记忆提炼同一口径：全局模型未选/不可用时不再静默兜底——直接报错，UI 引导去「设置 → 人格」选择。 */
  if (!model) return { ok: false, saved: 0, items: [], needModel: true, msg: t('extract.noGlobalModel') }

  try {
    const r = await chatStore.bridgeRpc('knowledge.extract', {
      content,
      projectRoot: projectRoot || '',
      dryRun: !!opts?.dryRun,
      model,
    })
    return normalizeResult(r)
  } catch (e: any) {
    return { ok: false, saved: 0, items: [], msg: String(e?.message || e).slice(0, 200) }
  }
}

/**
 * 提交用户勾选的知识条目写入知识库。
 * @returns 每条最终 outcome + counts；后端未连接返回 null
 */
export async function knowledgeExtractCommit(items: KnowledgeExtractItem[]): Promise<KnowledgeExtractResult | null> {
  const chatStore = useChatStore()
  if (!chatStore.wsConnected) return null

  try {
    const r = await chatStore.bridgeRpc('knowledge.extractCommit', { items })
    return normalizeResult(r)
  } catch (e: any) {
    return { ok: false, saved: 0, items: [], msg: String(e?.message || e).slice(0, 200) }
  }
}
